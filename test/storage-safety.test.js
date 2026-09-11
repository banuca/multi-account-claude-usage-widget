// Unit checks for the three modules that decide what happens to the user's
// data when something is wrong: the configuration file, the credential store
// and the read-error classification.
//
// These are UNIT FAKES. They prove the decision logic, on any platform, with
// no Electron and no real keychain. The corresponding real-runtime evidence is
// in test/electron-failure-paths-smoke.js (main process, real safeStorage,
// real config file) and test/electron-provider-reader-smoke.js (real reader).
// Neither substitutes for the other, and the Linux basic_text case can only be
// covered here on a Windows host - that is called out where it happens.
const assert = require('assert');

const {
  CONFIG_HEALTH,
  RECOVERY_ACTIONS,
  classifyConfigContent,
  planConfigRecovery,
  recoveryFileName,
  createMemoryStore,
  createResilientStore,
  durableFacetOf
} = require('../src/config-recovery');

const {
  CREDENTIAL_MODES,
  encryptedKeyFor,
  plaintextKeyFor,
  createCredentialStore
} = require('../src/credential-store');

const { isTransientReadError, isConfirmedAuthRejection, errorCode } = require('../src/read-errors');
const { validateManualEntry, describeManualErrors, parseField } = require('../src/manual-entry');
const { legacyConfigPath, linuxAutostartDir, linuxDesktopDirs, checkIsolation } = require('../src/platform-paths');

const NUL = String.fromCharCode(0);

// ── Configuration classification ──────────────────────────────────────────
function testConfigClassification() {
  assert.strictEqual(classifyConfigContent('{"accounts":[]}').kind, 'json-object');
  assert.strictEqual(classifyConfigContent('{}').kind, 'json-object');
  assert.strictEqual(classifyConfigContent('').kind, 'empty');
  // A truncated write: valid-looking start, unparseable.
  assert.strictEqual(classifyConfigContent('{"accounts":[{"id":"1"').kind, 'unusable');
  assert.strictEqual(classifyConfigContent('{"accounts":[{"id":"1"').reason, 'invalid-json');
  // The v1.7.0 encrypted file: binary with NUL bytes.
  assert.strictEqual(classifyConfigContent(`enc${NUL}rypted`).reason, 'binary-or-encrypted');
  // Parses, but is not a config object - still unusable, still preserved.
  assert.strictEqual(classifyConfigContent('[1,2,3]').reason, 'not-a-json-object');
  assert.strictEqual(classifyConfigContent('42').reason, 'not-a-json-object');
  assert.strictEqual(classifyConfigContent('null').reason, 'not-a-json-object');
  assert.strictEqual(classifyConfigContent(undefined).reason, 'not-text');
}

function testRecoveryPlan() {
  // No file: nothing to do.
  assert.deepStrictEqual(planConfigRecovery({ exists: false }),
    { action: RECOVERY_ACTIONS.NONE, health: CONFIG_HEALTH.OK, reason: 'no-config-file' });

  // Good file: nothing to do.
  assert.strictEqual(planConfigRecovery({ exists: true, raw: '{"a":1}' }).action, RECOVERY_ACTIONS.NONE);

  // THE REGRESSION: a file that cannot be read must never be touched. The old
  // code deleted it - both when it looked odd and when reading it threw.
  const unreadable = planConfigRecovery({ exists: true, readError: { code: 'EACCES' } });
  assert.strictEqual(unreadable.action, RECOVERY_ACTIONS.LEAVE_IN_PLACE);
  assert.strictEqual(unreadable.health, CONFIG_HEALTH.READ_ONLY);
  assert.match(unreadable.reason, /EACCES/);

  const busy = planConfigRecovery({ exists: true, readError: { code: 'EBUSY' } });
  assert.strictEqual(busy.action, RECOVERY_ACTIONS.LEAVE_IN_PLACE);

  const isDir = planConfigRecovery({ exists: true, readError: { code: 'EISDIR' } });
  assert.strictEqual(isDir.action, RECOVERY_ACTIONS.LEAVE_IN_PLACE);

  // Unusable content: preserved, and flagged so the user is told.
  const corrupt = planConfigRecovery({ exists: true, raw: `enc${NUL}rypted` });
  assert.strictEqual(corrupt.action, RECOVERY_ACTIONS.PRESERVE_AND_RESET);
  assert.strictEqual(corrupt.health, CONFIG_HEALTH.PRESERVED);

  const truncated = planConfigRecovery({ exists: true, raw: '{"accounts":' });
  assert.strictEqual(truncated.action, RECOVERY_ACTIONS.PRESERVE_AND_RESET);
  assert.strictEqual(truncated.health, CONFIG_HEALTH.PRESERVED);

  // A zero-byte file has nothing in it to preserve, so replacing it is not a
  // loss and does not warrant a warning.
  const empty = planConfigRecovery({ exists: true, raw: '' });
  assert.strictEqual(empty.action, RECOVERY_ACTIONS.PRESERVE_AND_RESET);
  assert.strictEqual(empty.health, CONFIG_HEALTH.OK);

  // The preserved name is sortable, unique-ish and obviously not a config.
  const name = recoveryFileName(new Date('2026-09-10T18:04:05.678Z'));
  assert.strictEqual(name, 'config.unreadable-2026-09-10T18-04-05-678Z.json');
  assert.ok(!name.endsWith('config.json'));
}

function testMemoryStore() {
  const store = createMemoryStore({ settings: { alwaysOnTop: true }, accounts: [{ id: '1' }] });
  assert.strictEqual(store.persistent, false);
  assert.strictEqual(store.get('settings.alwaysOnTop'), true);
  assert.strictEqual(store.get('settings.missing', 'fallback'), 'fallback');
  store.set('settings.refreshInterval', 60);
  assert.strictEqual(store.get('settings.refreshInterval'), 60);
  store.set('account_1_sessionKey_encrypted', 'abc');
  assert.strictEqual(store.has('account_1_sessionKey_encrypted'), true);
  store.delete('account_1_sessionKey_encrypted');
  assert.strictEqual(store.has('account_1_sessionKey_encrypted'), false);
  assert.deepStrictEqual(Object.keys(store.store).sort(), ['accounts', 'settings']);
  // A dotted set must create the intermediate object rather than throwing.
  const fresh = createMemoryStore({});
  fresh.set('settings.deep.value', 7);
  assert.strictEqual(fresh.get('settings.deep.value'), 7);
  // The initial value is copied, not aliased.
  const source = { settings: { a: 1 } };
  const copied = createMemoryStore(source);
  copied.set('settings.a', 2);
  assert.strictEqual(source.settings.a, 1);
}

function testResilientStore() {
  const written = {};
  let denyWrites = false;
  const failures = [];
  const real = {
    get: (key, fallback) => (key in written ? written[key] : fallback),
    set: (key, value) => {
      if (denyWrites) {
        const err = new Error('EPERM: operation not permitted');
        err.code = 'EPERM';
        throw err;
      }
      written[key] = value;
    },
    has: (key) => key in written,
    delete: (key) => { delete written[key]; },
    get store() { return { ...written }; }
  };
  const store = createResilientStore(real, (info) => failures.push(info));

  store.set('settings.refreshInterval', 300);
  assert.strictEqual(store.get('settings.refreshInterval'), 300);
  assert.strictEqual(failures.length, 0);
  assert.strictEqual(store.isDegraded, false);

  // A rejected write must not throw out of the handler that made it, and the
  // value must still be readable for the rest of the session.
  denyWrites = true;
  store.set('settings.refreshInterval', 60);
  assert.strictEqual(failures.length, 1);
  assert.strictEqual(failures[0].operation, 'set');
  assert.strictEqual(failures[0].error.code, 'EPERM');
  assert.strictEqual(store.isDegraded, true);
  assert.strictEqual(store.get('settings.refreshInterval'), 60, 'the session sees its own change');
  assert.strictEqual(written['settings.refreshInterval'], 300, 'the file is untouched by the failed write');
}

// ── Credential storage ────────────────────────────────────────────────────
function fakeSafeStorage({ available = true, backend = null, corrupt = false } = {}) {
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString: (value) => {
      if (!available) throw new Error('encryption unavailable');
      return Buffer.from(`ENC:${value}`, 'utf8');
    },
    decryptString: (buffer) => {
      if (corrupt) throw new Error('decryption failed');
      const text = buffer.toString('utf8');
      if (!text.startsWith('ENC:')) throw new Error('not our ciphertext');
      return text.slice(4);
    }
  };
}

// A store that satisfies the DURABLE contract, the way electron-store does:
// it is backed by a `disk` map and its writes throw when the disk refuses.
// The credential store must be given one of these (or the durable facet of a
// resilient wrapper) - a memory stand-in is not durable, and that is the
// distinction the composed-storage regressions below exist to hold.
function durableStore(initial = {}) {
  const disk = new Map(Object.entries(initial));
  const control = { denySet: false, denyDelete: false, denyGet: false, swallowSet: null };
  const api = {
    get(key, fallback) {
      if (control.denyGet) throw Object.assign(new Error('EIO: read failed'), { code: 'EIO' });
      return disk.has(key) ? disk.get(key) : fallback;
    },
    has(key) { return disk.has(key); },
    set(key, value) {
      if (control.denySet) throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' });
      // "Accepted but not kept": the shape of a store that reports success and
      // loses the value, which is what the read-back verification is for.
      if (control.swallowSet && control.swallowSet(key)) return;
      disk.set(key, value);
    },
    delete(key) {
      if (control.denyDelete) throw Object.assign(new Error('EPERM: delete refused'), { code: 'EPERM' });
      disk.delete(key);
    },
    get store() { return Object.fromEntries(disk); }
  };
  return { disk, api, control };
}

// The real composition from main.js: electron-store -> resilient wrapper ->
// credential store. The credential store must reach the disk through the
// wrapper's durable facet and never be satisfied by its overlay.
function composedStorage({ initial = {}, safeStorage, platform = 'win32' } = {}) {
  const backing = durableStore(initial);
  const failures = [];
  const store = createResilientStore(backing.api, (info) => failures.push(info));
  const credentials = createCredentialStore({ store, safeStorage, platform });
  return { ...backing, store, credentials, failures };
}

function testCredentialSaveRefusesInsecureStorage() {
  // No keychain at all.
  {
    const { api: store } = durableStore({});
    const creds = createCredentialStore({
      store, safeStorage: fakeSafeStorage({ available: false }), platform: 'linux'
    });
    assert.strictEqual(creds.security().secure, false);
    const result = creds.save('1', 'top-secret');
    assert.strictEqual(result.saved, false);
    assert.strictEqual(result.mode, CREDENTIAL_MODES.REFUSED);
    // THE REGRESSION: this used to write the credential to config.json in the
    // clear. Nothing may be persisted.
    assert.strictEqual(store.has(plaintextKeyFor('1')), false);
    assert.strictEqual(store.has(encryptedKeyFor('1')), false);
    assert.strictEqual(JSON.stringify(store.store).includes('top-secret'), false);
    // THE SECOND REGRESSION: a refusal used to park the key in memory, where
    // load() preferred it to the committed credential. A refusal must change
    // nothing at all - the account keeps whatever it already had (here,
    // nothing) and the renderer offers manual entry.
    assert.strictEqual(creds.load('1').key, null);
    assert.strictEqual(creds.load('1').mode, CREDENTIAL_MODES.ABSENT);
  }

  // Linux basic_text: available, but no real protection. Electron documents
  // this backend as providing none.
  //
  // UNIT FAKE, and the only place this case is covered: the host running these
  // tests is not Linux, so there is no native evidence for it.
  {
    const { api: store } = durableStore({});
    const credentials = createCredentialStore({
      store, safeStorage: fakeSafeStorage({ available: true, backend: 'basic_text' }), platform: 'linux'
    });
    const security = credentials.security();
    assert.strictEqual(security.available, true);
    assert.strictEqual(security.secure, false);
    assert.match(security.reason, /basic_text/);
    const result = credentials.save('1', 'top-secret');
    assert.strictEqual(result.saved, false);
    assert.strictEqual(result.mode, CREDENTIAL_MODES.REFUSED);
    assert.strictEqual(JSON.stringify(store.store).includes('top-secret'), false);
    assert.strictEqual(credentials.load('1').mode, CREDENTIAL_MODES.ABSENT);
  }

  // An unknown backend is not a basis for writing a secret either.
  {
    const { api: store } = durableStore({});
    const credentials = createCredentialStore({
      store, safeStorage: fakeSafeStorage({ available: true, backend: 'unknown' }), platform: 'linux'
    });
    assert.strictEqual(credentials.security().secure, false);
    assert.strictEqual(credentials.save('1', 's').saved, false);
  }

  // A real Linux keyring is fine.
  {
    const { api: store } = durableStore({});
    const credentials = createCredentialStore({
      store, safeStorage: fakeSafeStorage({ available: true, backend: 'gnome_libsecret' }), platform: 'linux'
    });
    assert.strictEqual(credentials.security().secure, true);
    assert.strictEqual(credentials.save('1', 's').saved, true);
    assert.strictEqual(store.has(encryptedKeyFor('1')), true);
  }

  // On Windows and macOS the backend probe does not apply.
  for (const platform of ['win32', 'darwin']) {
    const { api: store } = durableStore({});
    const credentials = createCredentialStore({
      store, safeStorage: fakeSafeStorage({ available: true }), platform
    });
    assert.strictEqual(credentials.security().secure, true, platform);
    assert.strictEqual(credentials.save('1', 'value').saved, true, platform);
  }
}

function testCredentialLookupFindsItWhereverItIs() {
  // THE REGRESSION, part one: a plaintext credential written on a host without
  // encryption used to become invisible the moment encryption started working,
  // because the lookup location was chosen by current availability.
  {
    const { api: store } = durableStore({ [plaintextKeyFor('1')]: 'legacy-value' });
    const credentials = createCredentialStore({
      store, safeStorage: fakeSafeStorage({ available: true }), platform: 'win32'
    });
    const loaded = credentials.load('1');
    assert.strictEqual(loaded.key, 'legacy-value');
    assert.strictEqual(loaded.mode, CREDENTIAL_MODES.MIGRATED);
    // Migrated safely: the encrypted copy exists and verifies BEFORE the
    // plaintext one is removed.
    assert.strictEqual(store.has(encryptedKeyFor('1')), true);
    assert.strictEqual(store.has(plaintextKeyFor('1')), false);
    assert.strictEqual(credentials.load('1').mode, CREDENTIAL_MODES.ENCRYPTED);
    assert.strictEqual(credentials.load('1').key, 'legacy-value');
  }

  // If the migration cannot complete, the only copy is NOT deleted.
  {
    const { api: store } = durableStore({ [plaintextKeyFor('1')]: 'legacy-value' });
    const broken = fakeSafeStorage({ available: true });
    broken.encryptString = () => { throw new Error('keyring went away mid-write'); };
    const credentials = createCredentialStore({ store, safeStorage: broken, platform: 'win32' });
    const loaded = credentials.load('1');
    assert.strictEqual(loaded.key, 'legacy-value');
    assert.strictEqual(loaded.mode, CREDENTIAL_MODES.LEGACY_PLAINTEXT);
    assert.strictEqual(store.get(plaintextKeyFor('1')), 'legacy-value', 'the only copy survives');
  }

  // Plaintext stays usable while encryption is unavailable.
  {
    const { api: store } = durableStore({ [plaintextKeyFor('1')]: 'legacy-value' });
    const credentials = createCredentialStore({
      store, safeStorage: fakeSafeStorage({ available: false }), platform: 'linux'
    });
    assert.strictEqual(credentials.load('1').mode, CREDENTIAL_MODES.LEGACY_PLAINTEXT);
    assert.strictEqual(credentials.load('1').key, 'legacy-value');
  }
}

function testCredentialLockedKeychainPreservesCiphertext() {
  // THE REGRESSION, part two: an encrypted credential used to be unreachable
  // during a temporary keychain loss, and the account simply reported "not
  // connected" - which invites a reconnect that cannot help.
  const secure = fakeSafeStorage({ available: true });
  const { api: store } = durableStore({});
  const credentials = createCredentialStore({ store, safeStorage: secure, platform: 'win32' });
  assert.strictEqual(credentials.save('1', 'the-real-key').saved, true);
  const ciphertext = store.get(encryptedKeyFor('1'));

  // Now the keychain is gone.
  const { api: lockedStore } = durableStore({ [encryptedKeyFor('1')]: ciphertext });
  const locked = createCredentialStore({
    store: lockedStore, safeStorage: fakeSafeStorage({ available: false }), platform: 'darwin'
  });
  const loaded = locked.load('1');
  assert.strictEqual(loaded.key, null);
  assert.strictEqual(loaded.mode, CREDENTIAL_MODES.LOCKED);
  assert.strictEqual(lockedStore.get(encryptedKeyFor('1')), ciphertext, 'ciphertext is left in place');

  const state = locked.credentialState('1');
  assert.strictEqual(state.state, CREDENTIAL_MODES.LOCKED);
  assert.strictEqual(state.usable, false);
  assert.strictEqual(state.persisted, true, 'the UI must say a credential exists, not that none does');

  // And when the cipher itself refuses the value, it still is not deleted.
  const { api: corruptStore } = durableStore({ [encryptedKeyFor('1')]: ciphertext });
  const corrupt = createCredentialStore({
    store: corruptStore, safeStorage: fakeSafeStorage({ available: true, corrupt: true }), platform: 'win32'
  });
  assert.strictEqual(corrupt.load('1').mode, CREDENTIAL_MODES.UNDECRYPTABLE);
  assert.strictEqual(corruptStore.get(encryptedKeyFor('1')), ciphertext);
}

function testCredentialSaveVerifiesBeforeRemovingTheOldCopy() {
  // The verified-replacement rule: the plaintext copy goes only after the
  // encrypted one has been written AND read back.
  const { api: store, control } = durableStore({ [plaintextKeyFor('7')]: 'old-plain' });
  const flaky = fakeSafeStorage({ available: true });
  // A store that accepts the write and does not keep it.
  control.swallowSet = (key) => key === encryptedKeyFor('7');
  const credentials = createCredentialStore({ store, safeStorage: flaky, platform: 'win32' });
  const result = credentials.save('7', 'new-value');
  assert.strictEqual(result.saved, false);
  assert.strictEqual(result.mode, CREDENTIAL_MODES.WRITE_FAILED);
  assert.match(result.reason, /stored-ciphertext-mismatch/);
  assert.strictEqual(store.get(plaintextKeyFor('7')), 'old-plain', 'the old copy is still there');
  // And the unverifiable ciphertext is not left behind to shadow it.
  assert.strictEqual(store.has(encryptedKeyFor('7')), false);
  assert.strictEqual(credentials.load('7').key, 'old-plain');
}

function testCredentialRemoveClearsEverySlot() {
  const { api: store, disk } = durableStore({
    [plaintextKeyFor('3')]: 'plain',
    [encryptedKeyFor('3')]: Buffer.from('ENC:x', 'utf8').toString('base64'),
    // Another account, which must be untouched by any of this.
    [encryptedKeyFor('9')]: Buffer.from('ENC:other', 'utf8').toString('base64')
  });
  const credentials = createCredentialStore({
    store, safeStorage: fakeSafeStorage({ available: true }), platform: 'win32'
  });
  const removal = credentials.remove('3');
  assert.deepStrictEqual(removal, { removed: true, failures: [] });
  assert.strictEqual(store.has(plaintextKeyFor('3')), false);
  assert.strictEqual(store.has(encryptedKeyFor('3')), false);
  assert.strictEqual(credentials.load('3').mode, CREDENTIAL_MODES.ABSENT);
  assert.strictEqual(disk.has(encryptedKeyFor('9')), true, 'other accounts are not touched');
  assert.strictEqual(credentials.load('9').key, 'other');

  // A removal the file refuses is reported as a failure, not as done.
  const refusing = durableStore({ [encryptedKeyFor('5')]: Buffer.from('ENC:y', 'utf8').toString('base64') });
  refusing.control.denyDelete = true;
  const stubborn = createCredentialStore({
    store: refusing.api, safeStorage: fakeSafeStorage({ available: true }), platform: 'win32'
  });
  const failed = stubborn.remove('5');
  assert.strictEqual(failed.removed, false);
  assert.strictEqual(failed.failures.length, 2);
  assert.match(failed.failures[0].error, /EPERM/);
  assert.strictEqual(refusing.disk.has(encryptedKeyFor('5')), true, 'still on disk, and said so');
}

// ── Composed storage: the wrapper the app actually builds ─────────────────
//
// Every check in this group is against electron-store -> resilient wrapper ->
// credential store, because the defects it covers only existed in the
// COMPOSITION: each module looked correct alone. The credential store's
// read-back verification was being answered by the wrapper's memory overlay,
// so a write that never reached the disk reported success - and then deleted
// the legacy plaintext copy it had just "superseded".
function testComposedStorageDurabilityContract() {
  // 1. A rejected durable write: not saved, nothing lost, nothing cached.
  {
    const c = composedStorage({
      initial: { [plaintextKeyFor('1')]: 'synthetic-legacy' },
      safeStorage: fakeSafeStorage({ available: true })
    });
    c.control.denySet = true;
    const result = c.credentials.save('1', 'synthetic-replacement');
    assert.strictEqual(result.saved, false);
    assert.strictEqual(result.mode, CREDENTIAL_MODES.WRITE_FAILED);
    assert.strictEqual(c.disk.has(encryptedKeyFor('1')), false, 'nothing was written');
    assert.strictEqual(c.disk.get(plaintextKeyFor('1')), 'synthetic-legacy',
      'THE REGRESSION: the only durable copy must survive a failed replacement');
    // The overlay must not be able to answer for it either.
    assert.strictEqual(c.credentials.load('1').key, 'synthetic-legacy');
    assert.strictEqual(c.credentials.load('1').mode, CREDENTIAL_MODES.LEGACY_PLAINTEXT);
    assert.strictEqual(c.credentials.credentialState('1').persisted, true);
  }

  // 2. The exact ordering from the review: a failed write followed by a
  //    SUCCESSFUL delete. This is what lost both copies.
  {
    const c = composedStorage({
      initial: { [plaintextKeyFor('1')]: 'synthetic-legacy' },
      safeStorage: fakeSafeStorage({ available: true })
    });
    c.control.denySet = true;   // writes fail, deletes still work
    const result = c.credentials.save('1', 'synthetic-replacement');
    assert.strictEqual(result.saved, false);
    assert.strictEqual(c.disk.has(plaintextKeyFor('1')), true,
      'a failed save must not reach the deletion of the previous credential');
  }

  // 3. A memory-only config (the file could not be opened at all) refuses
  //    credential persistence outright rather than reporting a save that dies
  //    with the process.
  {
    const store = createMemoryStore({});
    const credentials = createCredentialStore({
      store, safeStorage: fakeSafeStorage({ available: true }), platform: 'win32'
    });
    assert.strictEqual(durableFacetOf(store), null);
    assert.strictEqual(credentials.isDurable(), false);
    const result = credentials.save('1', 'synthetic');
    assert.strictEqual(result.saved, false);
    assert.strictEqual(result.mode, CREDENTIAL_MODES.NO_DURABLE_STORE);
    assert.strictEqual(credentials.credentialState('1').persisted, false);
    assert.strictEqual(credentials.load('1').key, null);
    assert.strictEqual(JSON.stringify(store.store).includes('synthetic'), false);
  }

  // 4. A durable save through the wrapper really does reach the disk, and
  //    survives a "restart" - a brand-new store over the same disk.
  {
    const c = composedStorage({ safeStorage: fakeSafeStorage({ available: true }) });
    assert.strictEqual(c.credentials.save('1', 'kept-value').saved, true);
    assert.strictEqual(c.disk.has(encryptedKeyFor('1')), true);

    const afterRestart = createCredentialStore({
      store: createResilientStore(durableStore(Object.fromEntries(c.disk)).api, () => {}),
      safeStorage: fakeSafeStorage({ available: true }),
      platform: 'win32'
    });
    assert.strictEqual(afterRestart.load('1').key, 'kept-value');
    assert.strictEqual(afterRestart.load('1').mode, CREDENTIAL_MODES.ENCRYPTED);
  }

  // 5. A refused save leaves nothing behind a restart either: what the user is
  //    told did not happen must also not have happened.
  {
    const c = composedStorage({ safeStorage: fakeSafeStorage({ available: false }), platform: 'linux' });
    assert.strictEqual(c.credentials.save('1', 'refused-value').saved, false);
    const afterRestart = createCredentialStore({
      store: createResilientStore(durableStore(Object.fromEntries(c.disk)).api, () => {}),
      safeStorage: fakeSafeStorage({ available: true }),
      platform: 'win32'
    });
    assert.strictEqual(afterRestart.load('1').mode, CREDENTIAL_MODES.ABSENT);
    assert.strictEqual(c.disk.size, 0);
  }

  // 6. A config file that cannot be READ is not "no credential": offering a
  //    reconnect there would invite a save over a file we cannot see into.
  {
    const c = composedStorage({
      initial: { [encryptedKeyFor('1')]: Buffer.from('ENC:x', 'utf8').toString('base64') },
      safeStorage: fakeSafeStorage({ available: true })
    });
    c.control.denyGet = true;
    const loaded = c.credentials.load('1');
    assert.strictEqual(loaded.mode, CREDENTIAL_MODES.UNREADABLE);
    assert.strictEqual(loaded.key, null);
    assert.strictEqual(c.credentials.credentialState('1').persisted, false);
    assert.strictEqual(c.disk.has(encryptedKeyFor('1')), true, 'and it is still there');
  }

  // 7. Isolation: work on one account never touches another's credential,
  //    whichever way the write goes.
  {
    const c = composedStorage({
      initial: {
        [encryptedKeyFor('2')]: Buffer.from('ENC:two', 'utf8').toString('base64'),
        [plaintextKeyFor('3')]: 'three-legacy'
      },
      safeStorage: fakeSafeStorage({ available: true })
    });
    assert.strictEqual(c.credentials.save('1', 'one').saved, true);
    c.control.denySet = true;
    assert.strictEqual(c.credentials.save('4', 'four').saved, false);
    c.control.denySet = false;
    assert.strictEqual(c.credentials.remove('1').removed, true);
    assert.strictEqual(c.credentials.load('2').key, 'two');
    assert.strictEqual(c.credentials.load('3').key, 'three-legacy');
    assert.strictEqual(c.credentials.load('4').mode, CREDENTIAL_MODES.ABSENT);
  }
}

// ── Overlay semantics for ordinary settings ───────────────────────────────
//
// Availability and durability are different promises. Settings may degrade
// into a session overlay; what the overlay must NOT do is outlive the failure
// it was created for, or hide a durable success.
function testOverlaySemantics() {
  // A later successful write supersedes a failed one. With a single "degraded"
  // flag, the overlay kept answering for every key for the rest of the session.
  {
    const backing = durableStore({});
    const failures = [];
    const store = createResilientStore(backing.api, (i) => failures.push(i));
    backing.control.denySet = true;
    store.set('setting', 'first');
    assert.strictEqual(store.get('setting'), 'first', 'the session sees its own change');
    assert.strictEqual(failures.length, 1);
    backing.control.denySet = false;
    store.set('setting', 'second');
    assert.strictEqual(store.get('setting'), 'second');
    assert.strictEqual(backing.disk.get('setting'), 'second');
    assert.strictEqual(store.store.setting, 'second');
  }

  // An unrelated key is not shadowed by another key's failure.
  {
    const backing = durableStore({ other: 'on-disk' });
    const store = createResilientStore(backing.api, () => {});
    backing.control.denySet = true;
    store.set('setting', 'overlay-only');
    assert.strictEqual(store.get('other'), 'on-disk');
    assert.strictEqual(store.get('setting'), 'overlay-only');
  }

  // A failed delete must not look like a completed one.
  {
    const backing = durableStore({ setting: 'present' });
    const failures = [];
    const store = createResilientStore(backing.api, (i) => failures.push(i));
    backing.control.denyDelete = true;
    store.delete('setting');
    assert.strictEqual(failures.length, 1, 'the failure is reported');
    assert.strictEqual(failures[0].operation, 'delete');
    assert.strictEqual(store.has('setting'), false, 'and hidden for this session');
    assert.strictEqual(store.get('setting', 'gone'), 'gone');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(store.store, 'setting'), false);
    assert.strictEqual(backing.disk.get('setting'), 'present', 'still on disk, which is why it is reported');
    // A later successful write of the same key lifts the tombstone.
    backing.control.denyDelete = false;
    store.set('setting', 'again');
    assert.strictEqual(store.get('setting'), 'again');
    assert.strictEqual(store.has('setting'), true);
  }

  // Dot paths and the object form, which is what the app actually uses.
  {
    const backing = durableStore({});
    const store = createResilientStore(backing.api, () => {});
    backing.control.denySet = true;
    store.set({ 'settings.alwaysOnTop': true, 'settings.refreshInterval': 60 });
    assert.strictEqual(store.get('settings.alwaysOnTop'), true);
    assert.strictEqual(store.get('settings.refreshInterval'), 60);
    assert.deepStrictEqual(store.store.settings, { alwaysOnTop: true, refreshInterval: 60 });
    backing.control.denySet = false;
    store.set('settings.refreshInterval', 300);
    assert.strictEqual(store.get('settings.refreshInterval'), 300);
    // A tombstone on a parent hides its children too.
    backing.control.denyDelete = true;
    store.delete('settings');
    assert.strictEqual(store.get('settings.refreshInterval', null), null);
    assert.strictEqual(store.has('settings.alwaysOnTop'), false);
  }

  // The durable facet is the wrapper's other half: it throws, and it clears
  // the overlay's opinion of a key it wrote successfully.
  {
    const backing = durableStore({});
    const store = createResilientStore(backing.api, () => {});
    const durable = durableFacetOf(store);
    backing.control.denySet = true;
    store.set('key', 'overlay');
    assert.throws(() => durable.set('key', 'durable'), /ENOSPC/);
    backing.control.denySet = false;
    durable.set('key', 'durable');
    assert.strictEqual(store.get('key'), 'durable');
    assert.strictEqual(durable.get('key'), 'durable');
  }
}

// ── Read-error classification ─────────────────────────────────────────────
function testReadErrorClassification() {
  // Only a genuine rejection may cost a credential.
  assert.strictEqual(isConfirmedAuthRejection('chatgpt', new Error('AuthRequired')), true);
  assert.strictEqual(isConfirmedAuthRejection('chatgpt', new Error('AuthRequired: no token')), true);

  // THE REGRESSION: a token exchange that could not be completed is not proof.
  for (const message of [
    'SessionExchangeUnavailable: ServiceError502',
    'SessionExchangeUnavailable: Unparseable',
    'SessionExchangeUnavailable: Unreachable',
    'SessionExchangeRateLimited: RateLimited'
  ]) {
    assert.strictEqual(isConfirmedAuthRejection('chatgpt', new Error(message)), false, message);
    assert.strictEqual(isTransientReadError(new Error(message)), true, message);
  }

  // Claude has no positive signal at all, so nothing from Claude qualifies.
  assert.strictEqual(isConfirmedAuthRejection('claude', new Error('AuthRequired')), false);
  assert.strictEqual(isConfirmedAuthRejection('claude', new Error('CloudflareBlocked: challenge')), false);

  // Transient read failures.
  for (const message of [
    'CloudflareBlocked: Just a moment',
    'CloudflareChallenge: Enable JavaScript',
    'UnexpectedHTML: <html>',
    'InvalidJSON: <!doctype',
    'Request timeout',
    'PageError: target closed',
    'LoadFailed: -105 NAME_NOT_RESOLVED',
    'SecureStorageLocked: locked',
    'HTTP500',
    'HTTP503: unavailable',
    'NoUsableReading'
  ]) {
    assert.strictEqual(isTransientReadError(new Error(message)), true, message);
  }

  // And things that are NOT transient.
  for (const message of ['AuthRequired', 'HTTP401', 'HTTP403', 'Missing credentials', 'UnknownAccount']) {
    assert.strictEqual(isTransientReadError(new Error(message)), false, message);
  }

  assert.strictEqual(errorCode(new Error('SessionExchangeUnavailable: detail')), 'SessionExchangeUnavailable');
  assert.strictEqual(errorCode(new Error('Request timeout')), 'Request timeout');
  assert.strictEqual(isTransientReadError(undefined), false);
}

// ── Manual entry ──────────────────────────────────────────────────────────
function testManualEntryValidation() {
  // Valid, including a genuine zero for "used".
  const ok = validateManualEntry({ enabled: true, used: '0', limit: '100' });
  assert.strictEqual(ok.valid, true);
  assert.deepStrictEqual(ok.manual, { enabled: true, used: 0, limit: 100 });

  // Numbers, not just strings.
  assert.strictEqual(validateManualEntry({ used: 12.5, limit: 40 }).valid, true);
  assert.deepStrictEqual(validateManualEntry({ used: 12.5, limit: 40 }).manual,
    { enabled: false, used: 12.5, limit: 40 });

  // Over-limit is supported, not an error.
  assert.strictEqual(validateManualEntry({ used: '150', limit: '100' }).valid, true);

  // THE REGRESSION: these all used to become 0 and be saved.
  const blank = validateManualEntry({ used: '', limit: '' });
  assert.strictEqual(blank.valid, false);
  assert.deepStrictEqual(blank.errors.map((e) => [e.field, e.code]),
    [['used', 'missing'], ['limit', 'missing']]);

  const words = validateManualEntry({ used: 'abc', limit: 'lots' });
  assert.deepStrictEqual(words.errors.map((e) => e.code), ['not-a-number', 'not-a-number']);

  const negative = validateManualEntry({ used: '-5', limit: '100' });
  assert.deepStrictEqual(negative.errors.map((e) => [e.field, e.code]), [['used', 'negative']]);

  const zeroLimit = validateManualEntry({ used: '5', limit: '0' });
  assert.deepStrictEqual(zeroLimit.errors.map((e) => [e.field, e.code]), [['limit', 'not-positive']]);

  const negativeLimit = validateManualEntry({ used: '5', limit: '-2' });
  assert.deepStrictEqual(negativeLimit.errors.map((e) => e.code), ['not-positive']);

  // Infinity and NaN are not readings.
  assert.strictEqual(validateManualEntry({ used: Infinity, limit: 10 }).valid, false);
  assert.strictEqual(validateManualEntry({ used: NaN, limit: 10 }).valid, false);
  assert.strictEqual(validateManualEntry({ used: 1, limit: Infinity }).valid, false);

  // Whitespace is not a number.
  assert.strictEqual(parseField('   ').ok, false);
  assert.strictEqual(parseField('   ').reason, 'missing');
  assert.strictEqual(parseField(null).reason, 'missing');

  // The message is a sentence the editor can show.
  assert.match(describeManualErrors(negative.errors), /cannot be negative/);
  assert.match(describeManualErrors(zeroLimit.errors), /greater than 0/);
  assert.strictEqual(describeManualErrors([]), '');
}

// ── Platform paths ────────────────────────────────────────────────────────
function testPlatformPaths() {
  const sep = require('path').sep;
  assert.strictEqual(legacyConfigPath({ userData: `${sep}profile` }), `${sep}profile${sep}config.json`);
  assert.strictEqual(linuxAutostartDir({ appData: '/home/u/.config' }).replace(/\\/g, '/'),
    '/home/u/.config/autostart');

  const dirs = linuxDesktopDirs({ env: {}, home: '/home/u' });
  assert.strictEqual(dirs.appsDir.replace(/\\/g, '/'), '/home/u/.local/share/applications');
  assert.strictEqual(dirs.iconDir.replace(/\\/g, '/'), '/home/u/.local/share/icons/hicolor/512x512/apps');

  // $XDG_DATA_HOME wins when it is set, which is how a Linux test run is
  // isolated from the developer's own desktop files.
  const xdg = linuxDesktopDirs({ env: { XDG_DATA_HOME: '/tmp/iso/data' }, home: '/home/u' });
  assert.strictEqual(xdg.appsDir.replace(/\\/g, '/'), '/tmp/iso/data/applications');

  // Isolation report: complete on Linux, and it catches an escape.
  const root = `${sep}tmp${sep}iso`;
  const isolated = checkIsolation({
    platform: 'linux',
    paths: {
      userData: `${root}${sep}claude-usage-widget`,
      appData: root,
      home: root
    },
    env: { XDG_DATA_HOME: `${root}${sep}data` },
    root
  });
  assert.strictEqual(isolated.isolated, true, JSON.stringify(isolated.escaped));
  assert.ok(isolated.checked.some((e) => e.name === 'linuxAutostart'));
  assert.ok(isolated.checked.some((e) => e.name === 'linuxApps'));
  assert.ok(isolated.checked.some((e) => e.name === 'linuxIcons'));

  const leaky = checkIsolation({
    platform: 'linux',
    paths: { userData: `${root}${sep}cfg`, appData: root, home: `${sep}home${sep}real` },
    env: {},
    root
  });
  assert.strictEqual(leaky.isolated, false);
  assert.ok(leaky.escaped.some((e) => e.name === 'home'));
  assert.ok(leaky.escaped.some((e) => e.name === 'linuxApps'));
}

const tests = [
  testConfigClassification,
  testRecoveryPlan,
  testMemoryStore,
  testResilientStore,
  testCredentialSaveRefusesInsecureStorage,
  testCredentialLookupFindsItWhereverItIs,
  testCredentialLockedKeychainPreservesCiphertext,
  testCredentialSaveVerifiesBeforeRemovingTheOldCopy,
  testCredentialRemoveClearsEverySlot,
  testComposedStorageDurabilityContract,
  testOverlaySemantics,
  testReadErrorClassification,
  testManualEntryValidation,
  testPlatformPaths
];

let failed = 0;
for (const test of tests) {
  try {
    test();
    console.log(`PASS  ${test.name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL  ${test.name}\n      ${error.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} storage-safety test groups passed`);
if (failed) process.exit(1);
