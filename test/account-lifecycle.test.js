// Deterministic regressions for account save / removal / cancellation while
// asynchronous work is in flight.
//
// WHAT THIS IS. The production function bodies are lifted out of main.js and
// evaluated with dependencies this test controls, so the cookie write can be
// held open at an exact point and a competing operation released into that
// window. It is the same technique the architect's review probe used, extended
// to cover the success paths and the two orderings the probe did not reach.
//
// WHAT IT IS NOT. It is not an Electron test: there is no real session, no
// real cookie jar and no real IPC. The native counterparts live in
// test/electron-failure-paths-smoke.js (real main process, real safeStorage,
// real config file, real partitions). Neither substitutes for the other -
// a race cannot be scheduled deterministically in the native harness, and the
// native harness is the only thing that proves the wiring is real.
//
// The credential path here is NOT faked: the real credential store sits on the
// real resilient wrapper over a controllable durable store, because half of
// what went wrong lived in that composition.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const {
  createResilientStore,
  createMemoryStore
} = require('../src/config-recovery');
const {
  CREDENTIAL_MODES,
  createCredentialStore,
  encryptedKeyFor
} = require('../src/credential-store');
const readErrors = require('../src/read-errors');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

// ── Lifting the production code out of main.js ────────────────────────────
// The production code runs in its own VM realm, so the objects it returns do
// not share this realm's Object.prototype - deepStrictEqual compares
// prototypes and would reject them. Compare the fields that matter.
function assertRefusal(result, reason, message) {
  assert.ok(result && typeof result === 'object', `${message}: expected a refusal object`);
  assert.strictEqual(result.ok, false, message);
  assert.strictEqual(result.reason, reason, message);
}

function slice(startText, endText, label) {
  const start = source.indexOf(startText);
  assert.ok(start >= 0, `cannot find the start of ${label} in main.js`);
  const end = source.indexOf(endText, start);
  assert.ok(end > start, `cannot find the end of ${label} in main.js`);
  return source.slice(start, end);
}

const PRODUCTION = [
  // Generation bookkeeping and the ownership rules, verbatim.
  slice('const accountGenerations = new Map();', '// Resolve an account', 'generations'),
  // The account list, including the durable-write reporting and the claim sweep.
  slice('function getAccounts() {', 'function getAccount(id) {', 'accounts'),
  slice('function getAccount(id) {', '// Authentication work is scoped', 'getAccount'),
  // The save handler and the rollback helper it owns. The slice starts at the
  // helper because the two are one unit: a save that cannot finish is defined
  // by what it puts back.
  slice('function captureCommittedCredential(', '// Per-account manual usage entry:', 'save-account'),
  slice('function accountLeftovers(', '// Discard a never-saved draft account:', 'remove-account'),
  slice("ipcMain.handle('discard-draft-account',", "ipcMain.handle('rename-account',", 'discard-draft'),
  slice('async function handleProviderError(', '// Claude usage fetch:', 'handleProviderError')
].join('\n');

// A durable store whose writes and deletes can be made to fail on demand -
// the same helper shape as test/storage-safety.test.js.
function durableStore(initial = {}) {
  const disk = new Map(Object.entries(initial));
  const control = { denySet: false, denyDelete: false };
  const api = {
    get: (key, fallback) => (disk.has(key) ? disk.get(key) : fallback),
    has: (key) => disk.has(key),
    set: (key, value) => {
      if (control.denySet) throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' });
      disk.set(key, value);
    },
    delete: (key) => {
      if (control.denyDelete) throw Object.assign(new Error('EPERM: delete refused'), { code: 'EPERM' });
      disk.delete(key);
    },
    get store() { return Object.fromEntries(disk); }
  };
  return { disk, api, control };
}

function fakeSafeStorage({ available = true } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => {
      if (!available) throw new Error('encryption unavailable');
      return Buffer.from(`ENC:${value}`, 'utf8');
    },
    decryptString: (buffer) => {
      const text = buffer.toString('utf8');
      if (!text.startsWith('ENC:')) throw new Error('not our ciphertext');
      return text.slice(4);
    }
  };
}

/**
 * Build a world: real storage composition, real production handlers, and a
 * cookie write that is held open until the test releases it.
 */
function world({ accounts = [], secure = true, memoryOnlyConfig = false } = {}) {
  const backing = durableStore(accounts.length ? { accounts } : {});
  const store = memoryOnlyConfig
    ? createMemoryStore(accounts.length ? { accounts } : {})
    : createResilientStore(backing.api, () => {});
  const credentials = createCredentialStore({
    store,
    safeStorage: fakeSafeStorage({ available: secure }),
    platform: 'win32'
  });

  // A cookie JAR, not just a log: the rollback has to be able to remove what a
  // save put there, and the assertions have to be able to see the result.
  const jar = new Map();
  const cookies = [];
  let releaseCookie = null;
  const cookieGate = new Promise((resolve) => { releaseCookie = resolve; });
  const cleared = [];
  const handlers = new Map();
  const trayUpdates = [];

  const sandbox = {
    console,
    Buffer,
    Promise,
    Date,
    Math,
    JSON,
    Object,
    String,
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    store,
    credentials,
    CREDENTIAL_MODES,
    partitionFor: (id) => `persist:acct-${id}`,
    authFlowsByPartition: new Map(),
    finishAuthFlow: () => {},
    saveAccountKey: (id, key) => credentials.save(id, key),
    deleteAccountKey: (id) => credentials.remove(id),
    loadAccountKey: (id) => credentials.load(id).key,
    loadAccountCredential: (id) => credentials.load(id),
    // Modelled on the production writer: it refuses a sealed account and
    // registers itself so a removal's drain can wait for it. The REAL seam -
    // Chromium's cookie store, gated mid-write - is proven by the
    // `cookie-drain` phase of test/electron-failure-paths-smoke.js; this stub
    // exists so the deterministic orderings below mean something.
    setSessionCookie: async (key, id, provider) => {
      if (sandbox.isAccountSealed(id)) throw new Error('StaleRead');
      const write = (async () => {
        await cookieGate;
        cookies.push({ id, provider, key });
        jar.set(`persist:acct-${id}`, { provider, key });
      })();
      sandbox.trackAccountWrite(id, write);
      await write;
    },
    defaultLabel: (index) => (index === 0 ? 'Personal' : `Account ${index + 1}`),
    debugLog: () => {},
    durableFacetOf: require('../src/config-recovery').durableFacetOf,
    updateTrayRollup: () => { trayUpdates.push(Date.now()); },
    // Faithful to production: a deletion applies only to the credential the
    // read actually used, and it reports whether it deleted anything.
    markAccountExpired: (id, expectedKey) => {
      if (expectedKey !== undefined && credentials.load(id).key !== expectedKey) return false;
      credentials.remove(id);
      return true;
    },
    manualUsageData: () => null,
    usageStateByAccount: {},
    PROVIDER_COOKIES: {
      claude: { name: 'sessionKey', domain: '.claude.ai', url: 'https://claude.ai' },
      chatgpt: { name: '__Secure-next-auth.session-token', domain: '.chatgpt.com', url: 'https://chatgpt.com' }
    },
    getAccountSession: (id) => sandbox.session.fromPartition(`persist:acct-${id}`),
    session: {
      fromPartition: (partition) => ({
        clearStorageData: async () => { cleared.push(`${partition}:storage`); jar.delete(partition); },
        clearCache: async () => { cleared.push(`${partition}:cache`); },
        clearAuthCache: async () => { cleared.push(`${partition}:auth`); },
        cookies: {
          flushStore: async () => {},
          get: async () => (jar.has(partition) ? [{ name: 'cookie', partition }] : []),
          remove: async () => { jar.delete(partition); }
        }
      })
    },
    ...readErrors
  };
  sandbox.global = sandbox;
  vm.runInNewContext(PRODUCTION, sandbox);

  return {
    ...backing,
    store,
    credentials,
    sandbox,
    cookies,
    cleared,
    trayUpdates,
    releaseCookie,
    save: (payload) => handlers.get('save-account')(null, payload),
    remove: (id) => handlers.get('remove-account')(null, id),
    discard: (id) => handlers.get('discard-draft-account')(null, id),
    providerError: (account, error, generation) =>
      sandbox.handleProviderError(account, error, generation),
    accounts: () => sandbox.getAccounts(),
    bump: (id) => sandbox.bumpAccountGeneration(id),
    generationOf: (id) => sandbox.accountGenerationOf(id),
    pendingOperation: (id) => sandbox.hasPendingAccountOperation(id),
    sealed: (id) => sandbox.isAccountSealed(id),
    cookieWrites: () => cookies,
    // What the account's partition holds right now.
    partitionCookie: (id) => jar.get(`persist:acct-${id}`) || null
  };
}

// ── The success path, both providers ──────────────────────────────────────
async function testSaveCommitsWhenNothingRaces() {
  for (const provider of ['claude', 'chatgpt']) {
    const w = world();
    const saving = w.save({ id: '1', provider, sessionKey: `key-${provider}`, label: 'Personal' });
    w.releaseCookie();
    const result = await saving;

    assert.strictEqual(result, true, provider);
    assert.strictEqual(w.accounts().length, 1, provider);
    assert.strictEqual(w.accounts()[0].provider, provider);
    // The claim marker is a reservation, not stored state: it must be gone.
    assert.strictEqual('saveClaim' in w.accounts()[0], false, provider);
    assert.strictEqual(w.credentials.load('1').key, `key-${provider}`);
    assert.strictEqual(w.credentials.load('1').mode, CREDENTIAL_MODES.ENCRYPTED);
    assert.strictEqual(w.cookies.length, 1, provider);
    assert.strictEqual(w.cookies[0].provider, provider);
    // And it is durable: the account row reached the disk, not just the overlay.
    assert.strictEqual(w.disk.get('accounts').length, 1, provider);
  }
}

// ── An old provider rejection released during the cookie write ────────────
async function testOldRejectionCannotDeleteTheNewCredential() {
  for (const provider of ['claude', 'chatgpt']) {
    const existing = { id: '1', provider, label: 'Personal', orgId: 'org-1', organizations: [] };
    const w = world({ accounts: [existing] });
    // A credential is already committed, and a read is already in flight.
    assert.strictEqual(w.credentials.save('1', 'old-key').saved, true);
    const inFlightGeneration = w.generationOf('1');

    const saving = w.save({ id: '1', provider, sessionKey: 'new-key' });

    // The read now comes back with a genuine auth rejection for the OLD key.
    let rejection = null;
    try {
      await w.providerError({ ...existing }, new Error('AuthRequired'), inFlightGeneration);
    } catch (error) {
      rejection = error.message;
    }

    w.releaseCookie();
    const result = await saving;

    // Only ChatGPT can prove a credential is dead (no token could be minted at
    // all). Claude's reader classifies body text, so it never reaches the
    // credential-deleting path - which is why the ordering below is the one
    // that matters for ChatGPT and is asserted per provider rather than shared.
    assert.strictEqual(rejection, provider === 'chatgpt' ? 'StaleRead' : null,
      `${provider}: a superseded read must abandon itself, not report expiry`);
    assert.strictEqual(result, true, `${provider}: the save really did complete`);
    assert.strictEqual(w.credentials.load('1').key, 'new-key',
      `${provider}: THE REGRESSION - the replacement credential must survive`);
    assert.strictEqual(w.disk.has(encryptedKeyFor('1')), true);
    assert.strictEqual(w.accounts().length, 1);
  }
}

// ── Removal released during the cookie write ──────────────────────────────
async function testRemovalDuringSaveDoesNotResurrectTheAccount() {
  const w = world({ accounts: [{ id: '1', provider: 'claude', label: 'Personal', organizations: [] }] });
  assert.strictEqual(w.credentials.save('1', 'old-key').saved, true);

  const saving = w.save({ id: '1', provider: 'claude', sessionKey: 'new-key' });
  // Ownership of an in-flight save is held in memory, NOT written into the
  // account list. The committed row must be untouched while the save runs:
  // writing a reservation marker into it is what let a draft cancellation
  // delete a saved account during a reconnect.
  assert.strictEqual(w.pendingOperation('1'), true,
    'the save must own the account before it awaits anything');
  assert.strictEqual('saveClaim' in w.accounts()[0], false,
    'THE REGRESSION - a committed account is never tagged as a reservation');

  const removing = w.remove('1');
  w.releaseCookie();
  const removal = await removing;
  const result = await saving;

  assert.strictEqual(removal.ok, true);
  assert.strictEqual(removal.persisted, true);
  assertRefusal(result, 'superseded',
    'THE REGRESSION - a superseded save must not report success');
  assert.strictEqual(w.accounts().length, 0, 'and must not recreate the account');
  assert.strictEqual(w.credentials.load('1').mode, CREDENTIAL_MODES.ABSENT,
    'the credential goes with it, whichever order the two finish in');
  assert.strictEqual(w.cleared.includes('persist:acct-1:storage'), true);
}

// ── A later save released during an earlier save's cookie write ───────────
async function testCompetingSaveWins() {
  const w = world();
  const first = w.save({ id: '1', provider: 'claude', sessionKey: 'first-key', label: 'First' });

  // A second save for the same account replaces the reservation. Its own
  // cookie write shares the same gate, so both are in flight together.
  const second = w.save({ id: '1', provider: 'claude', sessionKey: 'second-key', label: 'Second' });

  w.releaseCookie();
  const firstResult = await first;
  const secondResult = await second;

  assertRefusal(firstResult, 'superseded', 'the earlier save must stand down');
  assert.strictEqual(secondResult, true, 'the later save owns the account');
  assert.strictEqual(w.accounts().length, 1, 'exactly one account, not two rows for one id');
  assert.strictEqual(w.accounts()[0].label, 'Second');
  assert.strictEqual('saveClaim' in w.accounts()[0], false);
  assert.strictEqual(w.credentials.load('1').key, 'second-key');
}

// ── Draft cancellation released during the cookie write ───────────────────
async function testDraftCancellationDuringSaveCommitsNothing() {
  const w = world();
  const saving = w.save({ id: '5', provider: 'chatgpt', sessionKey: 'draft-key' });
  // A draft that has not committed has no account row at all - there is
  // nothing in the configuration file for a crash, a restart or a cancellation
  // to misread as an account.
  assert.strictEqual(w.accounts().length, 0, 'an uncommitted draft writes no row');
  assert.strictEqual(w.pendingOperation('5'), true, 'but the operation owns the id');

  // Cancelling a draft used to refuse here, because a reserved row looked like
  // a saved account - so the cancelled login was committed anyway.
  const discarding = w.discard('5');
  w.releaseCookie();
  assert.strictEqual(await discarding, true);
  const result = await saving;

  assertRefusal(result, 'superseded', 'a cancelled draft must not be committed');
  assert.strictEqual(w.accounts().length, 0);
  assert.strictEqual(w.credentials.load('5').mode, CREDENTIAL_MODES.ABSENT);
  assert.strictEqual(w.disk.has(encryptedKeyFor('5')), false);
}

// A committed account is NOT a draft, and cancellation must not touch it.
async function testDiscardRefusesACommittedAccount() {
  const w = world({ accounts: [{ id: '2', provider: 'claude', label: 'Work', organizations: [] }] });
  assert.strictEqual(w.credentials.save('2', 'work-key').saved, true);
  assert.strictEqual(await w.discard('2'), false);
  assert.strictEqual(w.accounts().length, 1);
  assert.strictEqual(w.credentials.load('2').key, 'work-key');
}

// ── Isolation: none of this may reach another account ─────────────────────
async function testOtherAccountsAreUntouched() {
  const w = world({
    accounts: [
      { id: '1', provider: 'claude', label: 'Personal', organizations: [] },
      { id: '2', provider: 'chatgpt', label: 'Work', organizations: [] }
    ]
  });
  assert.strictEqual(w.credentials.save('1', 'one-key').saved, true);
  assert.strictEqual(w.credentials.save('2', 'two-key').saved, true);

  const saving = w.save({ id: '1', provider: 'claude', sessionKey: 'one-new' });
  const removing = w.remove('1');
  w.releaseCookie();
  await removing;
  await saving;

  assert.strictEqual(w.accounts().length, 1);
  assert.strictEqual(w.accounts()[0].id, '2');
  assert.strictEqual(w.credentials.load('2').key, 'two-key');
  assert.strictEqual(w.cleared.some((entry) => entry.startsWith('persist:acct-2')), false,
    'account 2 partition must never be cleared by account 1 work');
}

// ── Refusals never reach the partition ────────────────────────────────────
async function testInsecureStorageRefusesBeforeAnyCookieWrite() {
  const w = world({ secure: false });
  const saving = w.save({ id: '1', provider: 'claude', sessionKey: 'secret' });
  // No release needed: the refusal must happen before the cookie write is even
  // attempted. If it did not, this would hang, which the runner reports.
  const result = await saving;
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'insecure-storage');
  assert.strictEqual(w.cookies.length, 0, 'THE REGRESSION - no secret in the persistent partition');
  assert.strictEqual(w.accounts().length, 0, 'and no account row either');
  assert.strictEqual(JSON.stringify(w.store.store).includes('secret'), false);
}

async function testMemoryOnlyConfigRefusesToSave() {
  const w = world({ memoryOnlyConfig: true });
  const result = await w.save({ id: '1', provider: 'claude', sessionKey: 'secret' });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'insecure-storage');
  assert.strictEqual(result.detail, 'config-not-durable');
  assert.strictEqual(w.cookies.length, 0);
}

// ── Truthful reporting when the file rejects the write ────────────────────
async function testFailedAccountWriteIsReportedNotAssumed() {
  const w = world();
  const saving = w.save({ id: '1', provider: 'claude', sessionKey: 'key' });
  w.releaseCookie();
  assert.strictEqual(await saving, true);

  // Now the disk stops accepting writes, and the account is removed.
  w.control.denySet = true;
  w.control.denyDelete = true;
  const removal = await w.remove('1');
  assert.strictEqual(removal.ok, true);
  assert.strictEqual(removal.persisted, false,
    'a removal the file refused must not be reported as complete');
  assert.ok(removal.detail, 'and it must say why');
  // The session still behaves as the user asked...
  assert.strictEqual(w.accounts().length, 0);
  // ...but the durable truth is unchanged, which is exactly what was reported.
  assert.strictEqual(w.disk.has(encryptedKeyFor('1')), true);
  assert.strictEqual(w.disk.get('accounts').length, 1);
}

// ── An interrupted save leaves no claim behind a restart ──────────────────
// This version never writes a saveClaim. A profile written by the previous one
// can still hold one, and simply deleting the marker PROMOTED an interrupted
// reservation to a committed account. The credential decides which it was: the
// old save stored the credential before reserving the row.
function testStaleClaimWithACredentialBecomesAPlainAccount() {
  const w = world({ accounts: [{ id: '1', provider: 'claude', label: 'Personal', saveClaim: 'abandoned' }] });
  assert.strictEqual(w.credentials.save('1', 'stored-before-the-crash').saved, true);
  w.sandbox.clearStaleSaveClaims();
  assert.strictEqual(w.accounts().length, 1, 'the account had a credential, so it is real');
  assert.strictEqual('saveClaim' in w.accounts()[0], false);
  assert.strictEqual(w.disk.get('accounts')[0].saveClaim, undefined);
  assert.strictEqual(w.credentials.load('1').key, 'stored-before-the-crash');
}

function testStaleClaimWithoutACredentialIsNotPromotedToAnAccount() {
  const w = world({ accounts: [{ id: '1', provider: 'claude', label: 'Personal', saveClaim: 'abandoned' }] });
  w.sandbox.clearStaleSaveClaims();
  assert.strictEqual(w.accounts().length, 0,
    'THE REGRESSION - a reservation that never stored a credential is not an account');
  assert.strictEqual(w.disk.get('accounts').length, 0, 'and that is what reaches the disk');
}

// ── Correction review 2026-09-11 ──────────────────────────────────────────
//
// Each of these reproduces an ordering the architect's probes demonstrated
// against the previous build. They are written to FAIL on that build: the
// pre-fix behaviour is named in each assertion message.

// A reconnect is not a draft. Cancelling a draft while a reconnect is in
// flight used to delete the saved account, its credential and its history, and
// return true, because the reconnect had tagged the committed row with a
// saveClaim and the discard handler read any claim as "never saved".
async function testDiscardRefusesACommittedAccountMidReconnect() {
  for (const provider of ['claude', 'chatgpt']) {
    const w = world({ accounts: [{ id: '1', label: 'Existing', provider, organizations: [] }] });
    assert.strictEqual(w.credentials.save('1', 'synthetic-original').saved, true);

    const saving = w.save({ id: '1', provider, sessionKey: 'synthetic-replacement' });
    const discarding = w.discard('1');
    w.releaseCookie();
    const [saveResult, discardResult] = await Promise.all([saving, discarding]);

    assert.strictEqual(discardResult, false,
      `${provider}: THE REGRESSION - draft cancellation must refuse a committed account`);
    assert.strictEqual(w.accounts().length, 1, `${provider}: the account survives`);
    assert.strictEqual(w.accounts()[0].id, '1');
    assert.strictEqual(saveResult, true, `${provider}: and the reconnect it was racing still commits`);
    assert.strictEqual(w.credentials.load('1').key, 'synthetic-replacement');
    assert.strictEqual(w.disk.get('accounts').length, 1);
  }
}

// A read that STARTS during a save carries the generation the save has already
// bumped to. Matching that generation used to be enough for a genuine auth
// rejection to delete the credential the save had just written, after which
// the save still reported success. (The previously covered ordering - a read
// begun BEFORE the save - is testOldRejectionCannotDeleteTheNewCredential.)
async function testReadStartedDuringSaveCannotEraseTheReplacement() {
  const w = world({ accounts: [{ id: '1', label: 'Existing', provider: 'chatgpt', organizations: [] }] });
  assert.strictEqual(w.credentials.save('1', 'synthetic-original').saved, true);

  const saving = w.save({ id: '1', provider: 'chatgpt', sessionKey: 'synthetic-replacement' });
  // Taken here, mid-save: the value a read starting now would carry.
  const midSaveGeneration = w.generationOf('1');
  let rejection = null;
  try {
    await w.providerError({ ...w.accounts()[0] }, new Error('AuthRequired'), midSaveGeneration);
  } catch (error) {
    rejection = error.message;
  }
  w.releaseCookie();
  const saveResult = await saving;

  assert.strictEqual(rejection, 'StaleRead',
    'a read that overlaps a save must abandon itself, not report expiry');
  assert.strictEqual(saveResult, true, 'the save really did complete');
  assert.strictEqual(w.credentials.load('1').key, 'synthetic-replacement',
    'THE REGRESSION - the replacement credential must survive the overlapping read');
  assert.strictEqual(w.disk.has(encryptedKeyFor('1')), true);
}

// A failed cookie write during a reconnect used to leave the replacement
// credential in the store, the previous one gone, and a saveClaim on the row.
async function testFailedCookieWriteRestoresTheCommittedCredential() {
  for (const provider of ['claude', 'chatgpt']) {
    const w = world({ accounts: [{ id: '1', label: 'Existing', provider, orgId: 'org-1', organizations: [] }] });
    assert.strictEqual(w.credentials.save('1', 'synthetic-original').saved, true);
    w.sandbox.setSessionCookie = async () => { throw new Error('synthetic cookie write failure'); };

    let rejected = false;
    let rollback = null;
    try {
      await w.save({ id: '1', provider, sessionKey: 'synthetic-replacement', label: 'Renamed' });
    } catch (error) {
      rejected = true;
      rollback = error.rollback;
    }

    assert.strictEqual(rejected, true, `${provider}: the save must not report success`);
    assert.strictEqual(w.credentials.load('1').key, 'synthetic-original',
      `${provider}: THE REGRESSION - the previously committed credential must be restored`);
    assert.strictEqual(rollback && rollback.outcome, 'restored',
      `${provider}: and the handler must say what it put back`);
    assert.strictEqual(w.accounts().length, 1);
    assert.strictEqual('saveClaim' in w.accounts()[0], false,
      `${provider}: THE REGRESSION - no reservation marker may be left on the row`);
    assert.strictEqual(w.accounts()[0].label, 'Existing',
      `${provider}: and none of the new metadata may have been committed`);
    assert.strictEqual(w.pendingOperation('1'), false, `${provider}: the operation is over`);
  }
}

// The same failure on a brand-new draft has the opposite correct answer: there
// was nothing to restore, so the credential the save wrote must be removed
// rather than left orphaned in the configuration file.
async function testFailedDraftCookieWriteLeavesNoCredentialBehind() {
  const w = world();
  w.sandbox.setSessionCookie = async () => { throw new Error('synthetic cookie write failure'); };

  let rollback = null;
  await assert.rejects(
    () => w.save({ id: '7', provider: 'claude', sessionKey: 'draft-secret' }),
    (error) => { rollback = error.rollback; return /synthetic cookie write failure/.test(error.message); }
  );

  assert.strictEqual(rollback && rollback.outcome, 'deleted');
  assert.strictEqual(w.credentials.load('7').mode, CREDENTIAL_MODES.ABSENT,
    'THE REGRESSION - a failed first save leaves no credential on disk');
  assert.strictEqual(w.disk.has(encryptedKeyFor('7')), false);
  assert.strictEqual(w.accounts().length, 0, 'and no account row');
  assert.strictEqual(JSON.stringify(w.store.store).includes('draft-secret'), false);
}

// The cookie is written, but the account list will not reach the disk. The
// account is not committed, so its credential must not be either - otherwise
// the next launch shows the old account with the new account's credential.
async function testFailedAccountWriteRollsBackTheReconnectCredential() {
  const w = world({ accounts: [{ id: '1', label: 'Existing', provider: 'claude', organizations: [] }] });
  assert.strictEqual(w.credentials.save('1', 'synthetic-original').saved, true);

  const saving = w.save({ id: '1', provider: 'claude', sessionKey: 'synthetic-replacement', label: 'Renamed' });
  // Only the account list is refused; the credential store still works, so the
  // rollback can and must complete.
  const realSet = w.api.set;
  w.api.set = (key, value) => {
    if (key === 'accounts') throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' });
    return realSet(key, value);
  };
  w.releaseCookie();
  const result = await saving;
  w.api.set = realSet;

  assertRefusal(result, 'not-persisted', 'a save the file refused must not report success');
  assert.strictEqual(result.rollback, 'restored', 'and it must say the credential went back');
  assert.strictEqual(w.disk.get('accounts')[0].label, 'Existing',
    'the durable account list is unchanged');
  assert.strictEqual(w.credentials.load('1').key, 'synthetic-original',
    'THE REGRESSION - disk must not hold the new credential for an uncommitted save');
}

// The same failure when the rollback ITSELF cannot be written. There is no
// clean answer available; what matters is that the handler says so precisely
// rather than reporting "nothing changed" over an account list and a
// credential that now disagree on disk.
async function testUnwritableRollbackIsReportedAsIncomplete() {
  const w = world({ accounts: [{ id: '1', label: 'Existing', provider: 'claude', organizations: [] }] });
  assert.strictEqual(w.credentials.save('1', 'synthetic-original').saved, true);

  const saving = w.save({ id: '1', provider: 'claude', sessionKey: 'synthetic-replacement' });
  w.control.denySet = true;
  w.releaseCookie();
  const result = await saving;
  w.control.denySet = false;

  assertRefusal(result, 'not-persisted');
  assert.strictEqual(result.rollback, 'incomplete',
    'an unwritable rollback must be reported, not glossed as success or as a clean revert');
  assert.ok(result.rollbackDetail, 'and it must say why');
  assert.strictEqual(w.disk.get('accounts')[0].label, 'Existing',
    'the account list on disk never changed');
}

// Removal deleted history through the resilient overlay and ignored the
// result, so a rejected delete reported a complete removal while the history
// stayed on disk and came back at the next launch.
async function testRemovalReportsAFailedHistoryDelete() {
  const w = world({ accounts: [{ id: '1', label: 'Existing', provider: 'claude', organizations: [] }] });
  assert.strictEqual(w.credentials.save('1', 'synthetic-original').saved, true);
  w.store.durable.set('usageHistory_acct_1', [{ session: 25, weekly: null }]);

  const realDelete = w.api.delete;
  w.api.delete = (key) => {
    if (key === 'usageHistory_acct_1') throw new Error('synthetic history delete failure');
    return realDelete(key);
  };
  const removal = await w.remove('1');

  assert.strictEqual(w.disk.has('usageHistory_acct_1'), true, 'the history really is still there');
  assert.strictEqual(removal.ok, true);
  assert.strictEqual(removal.persisted, false,
    'THE REGRESSION - a removal that left history on disk must not report success');
  assert.ok(removal.remaining.some((r) => r.what === 'history'),
    'and it must name history as what remains');
  assert.strictEqual(removal.remaining.every((r) => !/synthetic-original/.test(JSON.stringify(r))), true,
    'without putting a credential in the report');
}

// The same requirement for the credential, which can fail independently.
async function testRemovalReportsAFailedCredentialDelete() {
  const w = world({ accounts: [{ id: '1', label: 'Existing', provider: 'claude', organizations: [] }] });
  assert.strictEqual(w.credentials.save('1', 'synthetic-original').saved, true);

  const realDelete = w.api.delete;
  w.api.delete = (key) => {
    if (String(key).startsWith('account_1_sessionKey')) throw new Error('synthetic credential delete failure');
    return realDelete(key);
  };
  const removal = await w.remove('1');

  assert.strictEqual(removal.persisted, false);
  assert.ok(removal.remaining.some((r) => r.what === 'credential'),
    'the credential is named as remaining');
  assert.strictEqual(w.disk.has(encryptedKeyFor('1')), true, 'because it really is still there');
}

// Removal must not clear the partition while a cookie write for the same
// account is still in flight: that is how a completed removal was followed by
// the account's login cookie being written back.
async function testRemovalDrainsPendingCookieWritesBeforeClearing() {
  const w = world({ accounts: [{ id: '1', label: 'Existing', provider: 'chatgpt', organizations: [] }] });
  assert.strictEqual(w.credentials.save('1', 'synthetic-original').saved, true);

  const saving = w.save({ id: '1', provider: 'chatgpt', sessionKey: 'synthetic-replacement' });
  const removing = w.remove('1');
  // Give the removal every microtask it could want. It still cannot reach its
  // partition clear, because its drain is waiting on the held cookie write.
  for (let tick = 0; tick < 25; tick += 1) await Promise.resolve();
  assert.strictEqual(w.cleared.includes('persist:acct-1:storage'), false,
    'THE REGRESSION - the partition must not be cleared before pending writes settle');

  w.releaseCookie();
  const removal = await removing;
  const saveResult = await saving;

  // The write landed, and then the wipe happened - in that order.
  assert.strictEqual(w.cookieWrites().length, 1, 'the held write really did land');
  assert.strictEqual(w.cleared.includes('persist:acct-1:storage'), true, 'and the wipe followed it');
  assertRefusal(saveResult, 'superseded', 'the superseded save commits nothing');
  assert.strictEqual(removal.ok, true);
  assert.strictEqual(removal.drained, true, 'the removal reports that it drained');
  assert.strictEqual(removal.persisted, true);
  assert.strictEqual(w.accounts().length, 0);
  assert.strictEqual(w.credentials.load('1').mode, CREDENTIAL_MODES.ABSENT);
  assert.strictEqual(w.sealed('1'), true,
    'and the account stays sealed, so nothing later can write to its partition');
}

// A save dispatched after a removal has taken ownership is refused outright
// rather than racing it - including the cookie write, which would otherwise
// put a credential into a partition that is about to be wiped.
async function testSaveIsRefusedWhileARemovalOwnsTheAccount() {
  const w = world({ accounts: [{ id: '1', label: 'Existing', provider: 'claude', organizations: [] }] });
  assert.strictEqual(w.credentials.save('1', 'synthetic-original').saved, true);

  // Hold the removal open inside its partition clear.
  let releaseClear;
  const clearing = new Promise((resolve) => { releaseClear = resolve; });
  const realFromPartition = w.sandbox.session.fromPartition;
  w.sandbox.session.fromPartition = (partition) => {
    const real = realFromPartition(partition);
    return { ...real, clearStorageData: async () => { await clearing; return real.clearStorageData(); } };
  };

  const removing = w.remove('1');
  await Promise.resolve();
  const late = await w.save({ id: '1', provider: 'claude', sessionKey: 'late-secret' });
  assertRefusal(late, 'account-removing', 'THE REGRESSION - a save may not race a removal');
  assert.strictEqual(w.cookieWrites().length, 0, 'and nothing was written to the partition');

  releaseClear();
  const removal = await removing;
  assert.strictEqual(removal.ok, true);
  assert.strictEqual(removal.persisted, true);
  assert.strictEqual(w.credentials.load('1').mode, CREDENTIAL_MODES.ABSENT,
    'the late save left no credential behind');
  assert.strictEqual(JSON.stringify(w.store.store).includes('late-secret'), false);
  w.sandbox.session.fromPartition = realFromPartition;
}

// A removal that deleted the row and then failed on the history leaves nothing
// to look up by id. Refusing the RETRY as "unknown account" would clear the
// failure notice while the data it named was still on disk, which is the same
// false "done" the review is about - so removal is idempotent.
async function testRemovalRetryFinishesAnIncompleteCleanup() {
  const w = world({ accounts: [{ id: '1', label: 'Existing', provider: 'claude', organizations: [] }] });
  assert.strictEqual(w.credentials.save('1', 'synthetic-original').saved, true);
  w.store.durable.set('usageHistory_acct_1', [{ session: 25, weekly: null }]);

  const realDelete = w.api.delete;
  let historyDeleteFails = true;
  w.api.delete = (key) => {
    if (historyDeleteFails && key === 'usageHistory_acct_1') throw new Error('synthetic history delete failure');
    return realDelete(key);
  };

  const first = await w.remove('1');
  assert.strictEqual(first.persisted, false);
  assert.strictEqual(w.accounts().length, 0, 'the row really is gone');
  assert.strictEqual(w.disk.has('usageHistory_acct_1'), true, 'and the history really is not');

  // The retry, with the underlying failure lifted.
  historyDeleteFails = false;
  const retry = await w.remove('1');
  assert.strictEqual(retry.ok, true,
    'THE REGRESSION - a retry must not be refused as unknown while data remains');
  assert.strictEqual(retry.persisted, true, 'and it must report that the job is now done');
  assert.deepStrictEqual([...retry.remaining], []);
  assert.strictEqual(w.disk.has('usageHistory_acct_1'), false, 'because it really is done');

  // Now there is genuinely nothing left, and a further call says so.
  const third = await w.remove('1');
  assertRefusal(third, 'unknown-account', 'with nothing left, removal is a no-op again');
}

// A save whose account list will not reach the disk has to undo everything it
// did, not just the credential: the running app must not show a commit that did
// not happen, and the partition must not keep the replacement cookie - the same
// secret by another route.
async function testRefusedAccountWriteUndoesTheSessionViewAndThePartition() {
  const w = world({ accounts: [{ id: '1', label: 'Existing', provider: 'claude', organizations: [] }] });
  assert.strictEqual(w.credentials.save('1', 'synthetic-original').saved, true);

  const saving = w.save({ id: '1', provider: 'claude', sessionKey: 'synthetic-replacement', label: 'Renamed' });
  const realSet = w.api.set;
  w.api.set = (key, value) => {
    if (key === 'accounts') throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' });
    return realSet(key, value);
  };
  w.releaseCookie();
  const result = await saving;
  w.api.set = realSet;

  assertRefusal(result, 'not-persisted');
  assert.strictEqual(result.rollback, 'restored');
  assert.strictEqual(result.partitionRollback, 'restored',
    'THE REGRESSION - the partition must go back to the previous credential');
  assert.strictEqual(w.partitionCookie('1').key, 'synthetic-original',
    'and the replacement cookie must not still be in the partition');
  assert.strictEqual(w.accounts().length, 1);
  assert.strictEqual(w.accounts()[0].label, 'Existing',
    'THE REGRESSION - the running app must not show the uncommitted rename');
  assert.strictEqual(w.disk.get('accounts')[0].label, 'Existing');
  assert.strictEqual(w.credentials.load('1').key, 'synthetic-original');
}

// The same for a first save: there was nothing here before, so nothing may be
// left here - no row, no credential, and no cookie.
async function testRefusedFirstSaveLeavesThePartitionEmpty() {
  const w = world();
  const saving = w.save({ id: '9', provider: 'chatgpt', sessionKey: 'draft-secret' });
  const realSet = w.api.set;
  w.api.set = (key, value) => {
    if (key === 'accounts') throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' });
    return realSet(key, value);
  };
  w.releaseCookie();
  const result = await saving;
  w.api.set = realSet;

  assertRefusal(result, 'not-persisted');
  assert.strictEqual(result.rollback, 'deleted');
  assert.strictEqual(result.partitionRollback, 'cleared');
  assert.strictEqual(w.partitionCookie('9'), null,
    'THE REGRESSION - no credential may be left in the partition of an account that was never committed');
  assert.strictEqual(w.accounts().length, 0);
  assert.strictEqual(w.credentials.load('9').mode, CREDENTIAL_MODES.ABSENT);
  assert.strictEqual(JSON.stringify(w.store.store).includes('draft-secret'), false);
}

const tests = [
  testSaveCommitsWhenNothingRaces,
  testOldRejectionCannotDeleteTheNewCredential,
  testRemovalDuringSaveDoesNotResurrectTheAccount,
  testCompetingSaveWins,
  testDraftCancellationDuringSaveCommitsNothing,
  testDiscardRefusesACommittedAccount,
  testOtherAccountsAreUntouched,
  testInsecureStorageRefusesBeforeAnyCookieWrite,
  testMemoryOnlyConfigRefusesToSave,
  testFailedAccountWriteIsReportedNotAssumed,
  testStaleClaimWithACredentialBecomesAPlainAccount,
  testStaleClaimWithoutACredentialIsNotPromotedToAnAccount,
  // Correction review 2026-09-11 regressions.
  testDiscardRefusesACommittedAccountMidReconnect,
  testReadStartedDuringSaveCannotEraseTheReplacement,
  testFailedCookieWriteRestoresTheCommittedCredential,
  testFailedDraftCookieWriteLeavesNoCredentialBehind,
  testFailedAccountWriteRollsBackTheReconnectCredential,
  testUnwritableRollbackIsReportedAsIncomplete,
  testRefusedAccountWriteUndoesTheSessionViewAndThePartition,
  testRefusedFirstSaveLeavesThePartitionEmpty,
  testRemovalReportsAFailedHistoryDelete,
  testRemovalReportsAFailedCredentialDelete,
  testRemovalRetryFinishesAnIncompleteCleanup,
  testRemovalDrainsPendingCookieWritesBeforeClearing,
  testSaveIsRefusedWhileARemovalOwnsTheAccount
];

(async () => {
  let failed = 0;
  for (const test of tests) {
    try {
      await test();
      console.log(`PASS  ${test.name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL  ${test.name}\n      ${error.message}`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} account-lifecycle test groups passed`);
  if (failed) process.exit(1);
})();
