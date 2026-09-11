'use strict';

// Behavioural regression tests for the add-account / reconnect cancellation
// flow. These load the REAL renderer flow code (src/renderer/app.js) into a
// minimal DOM shim and drive it through its actual event listeners against a
// fake window.electronAPI, so the tests exercise the real flow logic and its
// IPC effects:
//
//   1. Cancelling a reconnect must never delete the saved account, its
//      credential backup, manual settings or history (the original defect:
//      cancelAddAccount called removeAccount on the reconnect draft's id).
//   2. Cancelling a brand-new account must discard only that draft — its
//      partition and pending login window — and nothing else.
//   3. Late login-capture, validation and organisation-selection results
//      from a cancelled/superseded flow must never save into or alter a
//      newer flow (the original defect: handlers read the mutable
//      draftAccount after awaiting, so draft A's credential could be
//      validated/saved into draft B).
//   4. Cancellation must not race an already-dispatched save.
//   5. Successful add/reconnect must save the intended account exactly once,
//      including Claude organisation selection.

const assert = require('assert');

// ── Minimal DOM shim ─────────────────────────────────────────────────────────

class FakeClassList {
  constructor() { this._set = new Set(); }
  add(...names) { names.forEach((n) => this._set.add(n)); }
  remove(...names) { names.forEach((n) => this._set.delete(n)); }
  toggle(name, force) {
    if (force === undefined) force = !this._set.has(name);
    if (force) this._set.add(name); else this._set.delete(name);
    return force;
  }
  contains(name) { return this._set.has(name); }
}

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.style = {};
    this.dataset = {};
    this.classList = new FakeClassList();
    this._children = [];
    this._listeners = {};
    this._qsCache = {};
    this._content = null;
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.textContent = '';
    this.title = '';
    this.spellcheck = false;
    this.offsetHeight = 0;
    this.scrollHeight = 0;
    this._innerHTML = '';
  }
  get children() { return this._children; }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(v) { this._innerHTML = String(v); this._children = []; }
  get content() {
    if (!this._content) this._content = new FakeElement('template');
    return this._content;
  }
  addEventListener(type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  }
  appendChild(child) { this._children.push(child); return child; }
  querySelector(sel) {
    if (!this._qsCache[sel]) this._qsCache[sel] = new FakeElement('div');
    return this._qsCache[sel];
  }
  querySelectorAll() { return []; }
  cloneNode() { return new FakeElement(this.tagName); }
  focus() {}
  setAttribute(name, value) { this[name] = value; }
  getAttribute(name) { return this[name]; }
  remove() {}
}

let elById = new Map();
function el(id) {
  if (!elById.has(id)) elById.set(id, new FakeElement('div'));
  return elById.get(id);
}

let timerLog = [];
let clearLog = [];
const realSetInterval = global.setInterval;
const realClearInterval = global.clearInterval;
global.setInterval = (fn, ms) => {
  const handle = realSetInterval(fn, ms);
  timerLog.push({ kind: 'set', ms, at: Date.now() });
  return handle;
};
global.clearInterval = (id) => {
  clearLog.push(id);
  realClearInterval(id);
};

function resetDom() {
  elById = new Map();
  timerLog = [];
  clearLog = [];
}

// ── Fake window / electronAPI ────────────────────────────────────────────────

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function createFakeApi(initialAccounts = []) {
  const api = {
    platform: 'win32',
    isPortable: false,
    accounts: initialAccounts.map((a) => ({ ...a })),
    draftCounter: initialAccounts.reduce((m, a) => Math.max(m, Number(a.id) || 0), 0),
    draftsCreated: [],
    savedCalls: [],
    removedIds: [],
    discardedIds: [],
    cancelLoginPartitions: [],
    validateCalls: [],
    fetchCalls: [],
    settings: {
      autoStart: false, minimizeToTray: false, alwaysOnTop: true,
      timeFormat: '12h', weeklyDateFormat: 'date', usageAlerts: true,
      refreshInterval: '300', graphVisible: false, expandedOpen: false,
      showTrayStats: false
    },
    // Overridable provider hooks (per test).
    onDetectSessionKey: null,
    onValidateSessionKey: null,
    onDetectChatGPTToken: null,
    onValidateChatGPTToken: null,
    onSaveAccount: null,
    pendingDetects: new Map(), // partition -> deferred
    autoSettleOnCancel: true   // when false, cancelLoginCapture does not resolve pending detects
  };

  api.getAccounts = async () => api.accounts.map((a) => ({ ...a }));
  api.getSettings = async () => ({ ...api.settings });
  api.saveSettings = async (s) => { Object.assign(api.settings, s); return true; };
  api.getAppVersion = async () => '3.0.0';
  api.checkForUpdate = async () => ({ hasUpdate: false });
  api.getWindowInitInfo = async () => ({ bounds: null, isFirstRun: false });
  api.getWindowBounds = async () => null;
  api.setWindowBounds = async () => true;
  api.renameAccount = async () => true;
  api.saveAccountManual = async () => true;
  api.showNotification = () => {};
  api.openExternal = () => {};
  api.minimizeWindow = () => {};
  api.closeWindow = () => {};
  api.onRefreshUsage = () => {};
  api.onAccountSessionExpired = () => {};
  // Same surface the real preload exposes, so the renderer under test is not a
  // different renderer from the shipped one.
  api.configHealth = { state: 'ok', reason: null, preservedPath: null, persistent: true };
  api.getConfigHealth = async () => ({ ...api.configHealth });
  api.onConfigHealth = (cb) => { api._onConfigHealth = cb; };
  api.getSecureStorage = async () => ({ available: true, backend: null, secure: true, reason: 'ok' });
  api.createManualAccount = async ({ id, label, provider, manual }) => {
    api.manualAccountsCreated = api.manualAccountsCreated || [];
    api.manualAccountsCreated.push({ id, label, provider, manual });
    const existing = api.accounts.find((a) => a.id === id);
    if (existing) {
      existing.label = label;
      existing.provider = provider;
      existing.manual = manual;
    } else {
      api.accounts.push({ id, label, provider, orgId: null, organizations: [], manual, hasSession: false });
    }
    return { ok: true, manual };
  };

  api.createDraftAccount = async () => {
    api.draftCounter += 1;
    const id = String(api.draftCounter);
    api.draftsCreated.push(id);
    return { id, partition: `persist:acct-${id}`, label: `Account ${api.draftCounter}` };
  };

  api.saveAccount = async (payload) => {
    api.savedCalls.push({ ...payload });
    if (api.onSaveAccount) await api.onSaveAccount(payload);
    const existing = api.accounts.find((a) => a.id === payload.id);
    if (existing) {
      existing.label = payload.label;
      existing.provider = payload.provider;
      existing.orgId = payload.organizationId;
      existing.organizations = payload.organizations || [];
    } else {
      api.accounts.push({
        id: payload.id,
        label: payload.label,
        provider: payload.provider,
        orgId: payload.organizationId,
        organizations: payload.organizations || []
      });
    }
    return true;
  };

  api.removeAccount = async (id) => {
    api.removedIds.push(id);
    api.accounts = api.accounts.filter((a) => a.id !== id);
    return true;
  };

  api.discardDraftAccount = async (id) => {
    api.discardedIds.push(id);
    return true;
  };

  api.cancelLoginCapture = async (partition, flowId) => {
    api.cancelLoginPartitions.push(partition);
    api.lastCancelledFlowId = flowId;
    if (api.autoSettleOnCancel) {
      const pending = api.pendingDetects.get(partition);
      if (pending) pending.resolve({ success: false, error: 'Login cancelled' });
    }
    return true;
  };

  api.detectSessionKey = (partition, flowId) => {
    if (api.onDetectSessionKey) return api.onDetectSessionKey(partition, flowId);
    const d = deferred();
    api.pendingDetects.set(partition, d);
    return d.promise;
  };

  api.detectChatGPTToken = (partition, flowId) => {
    if (api.onDetectChatGPTToken) return api.onDetectChatGPTToken(partition, flowId);
    const d = deferred();
    api.pendingDetects.set(partition, d);
    return d.promise;
  };

  api.validateSessionKey = (sessionKey, partition, flowId) => {
    api.validateCalls.push({ sessionKey, partition, flowId });
    if (api.onValidateSessionKey) return api.onValidateSessionKey(sessionKey, partition, flowId);
    return Promise.resolve({
      success: true,
      organizationId: 'org-1',
      organizations: [{ id: 'org-1', name: 'Personal', isTeam: false }]
    });
  };

  api.validateChatGPTToken = (token, partition, flowId) => {
    api.validateCalls.push({ sessionKey: token, partition, flowId });
    if (api.onValidateChatGPTToken) return api.onValidateChatGPTToken(token, partition, flowId);
    return Promise.resolve({ success: true });
  };

  api.fetchUsageData = async (accountId) => {
    api.fetchCalls.push(accountId);
    return {
      provider: 'claude',
      source: 'auto',
      rows: [
        { key: 'session', label: 'Session', shortLabel: '5h', utilization: 30, windowMs: null, resets_at: null },
        { key: 'weekly', label: 'Weekly', shortLabel: '7d', utilization: 10, windowMs: null, resets_at: null }
      ]
    };
  };

  api.getUsageHistory = async () => [];
  return api;
}

// ── Load the real renderer flow code ─────────────────────────────────────────

function loadApp(api) {
  resetDom();
  global.window = {
    location: { search: '' },
    addEventListener() {},
    electronAPI: api
  };
  global.document = {
    getElementById: el,
    createElement: (tag) => new FakeElement(tag),
    createElementNS: (ns, tag) => new FakeElement(tag),
    head: { appendChild() {} },
    // init() marks the end of startup on the root element; the smoke suites
    // wait for that marker, so the shim has to carry one.
    documentElement: new FakeElement('html'),
    querySelectorAll: () => [],
    title: ''
  };
  delete require.cache[require.resolve('../src/renderer/app.js')];
  require('../src/renderer/app.js');
}

// Drain pending microtasks/macrotasks so async flow handlers settle.
async function settle(n = 20) {
  for (let i = 0; i < n; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function fire(target, type) {
  const handlers = (target._listeners && target._listeners[type]) || [];
  for (const handler of handlers) handler({});
}

function cardFor(accountId) {
  return el('accountsContainer').children.find((c) => c.dataset.accountId === accountId);
}

const SAVED_ACCOUNT = {
  id: '1',
  label: 'Personal',
  provider: 'claude',
  orgId: 'org-1',
  organizations: [],
  manual: { enabled: true, used: 5, limit: 100 },
  hasSession: true,
  partition: 'persist:acct-1'
};

// ── Scenarios ────────────────────────────────────────────────────────────────

// Defect 1: cancelling a reconnect must preserve the saved account, its
// credential backup, manual settings and history. The original code called
// removeAccount(draftAccount.id) — deleting the account and wiping its
// partition.
async function testReconnectCancelPreservesSavedAccountClaude() {
  const api = createFakeApi([SAVED_ACCOUNT]);
  loadApp(api);
  await settle();

  const card = cardFor('1');
  assert.ok(card, 'saved account card rendered');
  fire(card.querySelector('.account-reconnect-btn'), 'click');
  await settle();
  assert.strictEqual(el('loginContainer').style.display, 'flex', 'reconnect opens the login flow');
  assert.strictEqual(el('loginStep1').style.display, 'flex', 'Claude reconnect shows step 1');

  const pollsBefore = timerLog.filter((t) => t.kind === 'set' && t.ms === 300000).length;
  fire(el('loginCancelBtn'), 'click');
  await settle();

  assert.strictEqual(api.removedIds.length, 0,
    'cancel must NOT call remove-account for a reconnect (record/key/partition deletion bug)');
  assert.strictEqual(api.discardedIds.length, 0,
    'cancel must NOT wipe a saved account partition');
  assert.ok(api.cancelLoginPartitions.includes('persist:acct-1'),
    'cancel closes any pending login capture on the saved partition');
  assert.ok(api.lastCancelledFlowId != null, 'cancel targets the reconnect flow that started it');
  assert.strictEqual(api.accounts.length, 1, 'saved account record intact');
  assert.deepStrictEqual(api.accounts[0].manual, { enabled: true, used: 5, limit: 100 },
    'manual settings intact');
  assert.strictEqual(el('mainContent').style.display, 'flex', 'returns to main content');
  assert.ok(
    timerLog.filter((t) => t.kind === 'set' && t.ms === 300000).length > pollsBefore,
    'auto-update/polling resumed'
  );
}

async function testReconnectCancelPreservesSavedAccountChatGPT() {
  const api = createFakeApi([{ ...SAVED_ACCOUNT, provider: 'chatgpt', orgId: undefined }]);
  loadApp(api);
  await settle();

  fire(cardFor('1').querySelector('.account-reconnect-btn'), 'click');
  await settle();
  assert.strictEqual(el('loginChatGPTStep').style.display, 'flex', 'ChatGPT reconnect shows its step');

  fire(el('loginCancelBtn'), 'click');
  await settle();

  assert.strictEqual(api.removedIds.length, 0, 'ChatGPT reconnect cancel must not remove the account');
  assert.strictEqual(api.discardedIds.length, 0, 'ChatGPT reconnect cancel must not wipe the partition');
  assert.ok(api.cancelLoginPartitions.includes('persist:acct-1'), 'pending login capture closed');
  assert.strictEqual(api.accounts.length, 1, 'saved ChatGPT account intact');
  assert.strictEqual(el('mainContent').style.display, 'flex');
}

// Cancelling a brand-new account must clean up only that draft (its partition
// and pending login window), leaving every saved account untouched.
async function testNewAccountCancelDiscardsOnlyItsDraft() {
  const api = createFakeApi([SAVED_ACCOUNT]);
  loadApp(api);
  await settle();

  fire(el('addAccountBtn'), 'click'); // start add flow → draft id 2
  await settle();
  assert.deepStrictEqual(api.draftsCreated, ['2'], 'new draft allocated');
  fire(el('providerClaudeBtn'), 'click');
  fire(el('autoDetectBtn'), 'click'); // login capture pending on draft partition
  await settle();

  const pollsBefore = timerLog.filter((t) => t.kind === 'set' && t.ms === 300000).length;
  fire(el('loginCancelBtn'), 'click');
  await settle();

  assert.deepStrictEqual(api.discardedIds, ['2'], 'only the draft partition is discarded');
  assert.deepStrictEqual(api.cancelLoginPartitions, ['persist:acct-2'],
    'the draft pending login window is closed');
  assert.strictEqual(api.removedIds.length, 0,
    'remove-account is never used for cancellation');
  assert.strictEqual(api.accounts.length, 1, 'other accounts intact');
  assert.strictEqual(api.accounts[0].id, '1');
  assert.strictEqual(el('mainContent').style.display, 'flex', 'returns to main content');
  assert.ok(
    timerLog.filter((t) => t.kind === 'set' && t.ms === 300000).length > pollsBefore,
    'polling resumed'
  );
}

// Defect 2 (capture): draft A's login resolves after A was cancelled and B
// started — A's credential must never be validated against or saved into B.
async function testStaleLoginResultCannotCrossDrafts() {
  const api = createFakeApi([SAVED_ACCOUNT]);
  api.autoSettleOnCancel = false; // the stale capture resolves AFTER flow B starts
  const detectByPartition = new Map();
  api.onDetectSessionKey = (partition) => {
    const d = deferred();
    detectByPartition.set(partition, d);
    return d.promise;
  };
  loadApp(api);
  await settle();

  // Flow A — draft 2, login pending on A's partition.
  fire(el('addAccountBtn'), 'click');
  await settle();
  fire(el('providerClaudeBtn'), 'click');
  fire(el('autoDetectBtn'), 'click');
  await settle();
  const detectA = detectByPartition.get('persist:acct-2');
  assert.ok(detectA, 'login A started on draft A partition');

  // Cancel A, then open flow B — draft 3.
  fire(el('loginCancelBtn'), 'click');
  await settle();
  fire(el('addAccountBtn'), 'click');
  await settle();
  fire(el('providerClaudeBtn'), 'click');
  fire(el('autoDetectBtn'), 'click');
  await settle();
  const detectB = detectByPartition.get('persist:acct-3');
  assert.ok(detectB, 'login B started on draft B partition');

  // A's stale capture resolves — it must be dropped.
  detectA.resolve({ success: true, sessionKey: 'KEY-A' });
  await settle();

  assert.ok(!api.validateCalls.some((c) => c.sessionKey === 'KEY-A'),
    'stale capture must not trigger validation in the new flow');
  assert.strictEqual(api.savedCalls.length, 0,
    'stale capture must not save anything (cross-draft credential bug)');

  // B's own capture then completes normally and saves exactly once, into B.
  detectB.resolve({ success: true, sessionKey: 'KEY-B' });
  await settle();
  assert.strictEqual(api.savedCalls.length, 1, 'flow B saves exactly once');
  assert.strictEqual(api.savedCalls[0].id, '3', 'saved into draft B, not A');
  assert.strictEqual(api.savedCalls[0].sessionKey, 'KEY-B');
  assert.ok(!api.savedCalls.some((c) => c.sessionKey === 'KEY-A'), "A's key never saved");
}

// Defect 2 (validation + org selection): a delayed validation from a cancelled
// flow must not open the org picker, park pendingValidation, or save into the
// newer flow.
async function testStaleValidationCannotAlterAnotherFlow() {
  const api = createFakeApi([SAVED_ACCOUNT]);
  const pendingValidations = [];
  api.onDetectSessionKey = (partition) =>
    Promise.resolve({ success: true, sessionKey: `KEY-${partition}` });
  api.onValidateSessionKey = (sessionKey, partition) => {
    if (partition === 'persist:acct-2') {
      const d = deferred();
      pendingValidations.push({ sessionKey, d });
      return d.promise;
    }
    return Promise.resolve({
      success: true,
      organizationId: 'org-1',
      organizations: [{ id: 'org-1', name: 'Personal', isTeam: false }]
    });
  };
  loadApp(api);
  await settle();

  // Flow A — draft 2, validation hangs.
  fire(el('addAccountBtn'), 'click');
  await settle();
  fire(el('providerClaudeBtn'), 'click');
  fire(el('autoDetectBtn'), 'click');
  await settle();
  assert.strictEqual(pendingValidations.length, 1, 'flow A validation in flight');

  // Cancel A, open flow B — draft 3 (B's login is NOT started yet).
  fire(el('loginCancelBtn'), 'click');
  await settle();
  fire(el('addAccountBtn'), 'click');
  await settle();
  fire(el('providerClaudeBtn'), 'click');

  // A's stale multi-org validation resolves — must not show the org picker
  // in flow B, must not park pendingValidation, must not save.
  pendingValidations[0].d.resolve({
    success: true,
    organizationId: 'org-1',
    organizations: [
      { id: 'org-1', name: 'Personal', isTeam: false },
      { id: 'org-2', name: 'Work', isTeam: true }
    ]
  });
  await settle();

  assert.notStrictEqual(el('loginStep3').style.display, 'block',
    'stale validation must not open the org picker in the new flow');
  assert.strictEqual(el('loginStep1').style.display, 'flex',
    'flow B UI untouched by stale result');

  // A stale org-picker confirmation must also be a no-op.
  el('orgPickerSelect').value = 'org-2';
  fire(el('orgPickerConfirmBtn'), 'click');
  await settle();
  assert.strictEqual(api.savedCalls.length, 0,
    'stale org selection must not save into another flow');

  // Flow B completes its own login and saves exactly once, into B.
  fire(el('autoDetectBtn'), 'click');
  await settle();
  assert.strictEqual(api.savedCalls.length, 1);
  assert.strictEqual(api.savedCalls[0].id, '3');
  assert.strictEqual(api.savedCalls[0].sessionKey, 'KEY-persist:acct-3');
}

// The same delayed-validation isolation applies to ChatGPT. Its captured token
// and validation result must remain bound to flow A after flow B starts.
async function testStaleChatGPTValidationCannotCrossDrafts() {
  const api = createFakeApi([SAVED_ACCOUNT]);
  const validationA = deferred();
  api.onDetectChatGPTToken = (partition) =>
    Promise.resolve({ success: true, token: `TOK-${partition}` });
  api.onValidateChatGPTToken = (token, partition) => {
    if (partition === 'persist:acct-2') return validationA.promise;
    return Promise.resolve({ success: true });
  };
  loadApp(api);
  await settle();

  fire(el('addAccountBtn'), 'click');
  await settle();
  fire(el('providerChatGPTBtn'), 'click');
  fire(el('chatGPTLoginBtn'), 'click');
  await settle();
  assert.ok(api.validateCalls.some((c) => c.partition === 'persist:acct-2'),
    'flow A ChatGPT validation is in flight');

  fire(el('loginCancelBtn'), 'click');
  await settle();
  fire(el('addAccountBtn'), 'click');
  await settle();
  fire(el('providerChatGPTBtn'), 'click');

  validationA.resolve({ success: true });
  await settle();
  assert.strictEqual(api.savedCalls.length, 0,
    'flow A ChatGPT validation cannot save after cancellation');

  fire(el('chatGPTLoginBtn'), 'click');
  await settle();
  assert.strictEqual(api.savedCalls.length, 1, 'flow B saves exactly once');
  assert.strictEqual(api.savedCalls[0].id, '3');
  assert.strictEqual(api.savedCalls[0].sessionKey, 'TOK-persist:acct-3');
}

// A cancelled manual-key validation leaves its old handler awaiting. The next
// flow must reset Connect itself; the stale handler correctly cannot mutate
// controls owned by that newer flow.
async function testManualConnectIsUsableAfterCancelledValidation() {
  const api = createFakeApi([SAVED_ACCOUNT]);
  const validation = deferred();
  api.onValidateSessionKey = () => validation.promise;
  loadApp(api);
  await settle();

  fire(el('addAccountBtn'), 'click');
  await settle();
  fire(el('providerClaudeBtn'), 'click');
  fire(el('nextStepBtn'), 'click');
  el('sessionKeyInput').value = 'SYNTHETIC-KEY-A';
  fire(el('connectBtn'), 'click');
  await settle();
  assert.strictEqual(el('connectBtn').disabled, true, 'flow A Connect is disabled while validating');

  fire(el('loginCancelBtn'), 'click');
  await settle();
  fire(el('addAccountBtn'), 'click');
  await settle();
  fire(el('providerClaudeBtn'), 'click');
  fire(el('nextStepBtn'), 'click');

  validation.resolve({ success: false, error: 'Cancelled' });
  await settle();
  assert.strictEqual(el('connectBtn').disabled, false,
    'new flow starts with an enabled Connect button');
  assert.strictEqual(el('connectBtn').textContent, 'Connect');
}

// Cancel is idempotent, and a delayed cleanup completion only owns the flow
// that initiated it. It must not hide a newer flow or restart polling behind it.
async function testDelayedRepeatedCancelCannotAlterNewFlow() {
  const api = createFakeApi([SAVED_ACCOUNT]);
  const cleanup = deferred();
  api.cancelLoginCapture = (partition, flowId) => {
    api.cancelLoginPartitions.push(partition);
    api.lastCancelledFlowId = flowId;
    return cleanup.promise;
  };
  loadApp(api);
  await settle();

  fire(el('addAccountBtn'), 'click');
  await settle();
  fire(el('loginCancelBtn'), 'click');
  fire(el('loginCancelBtn'), 'click');
  await settle();
  assert.strictEqual(api.cancelLoginPartitions.length, 1, 'repeated Cancel starts one cleanup');

  fire(el('addAccountBtn'), 'click');
  await settle();
  assert.strictEqual(el('loginContainer').style.display, 'flex', 'new flow is visible');
  const pollingStarts = timerLog.filter((t) => t.kind === 'set' && t.ms === 300000).length;

  cleanup.resolve(true);
  await settle();
  assert.strictEqual(el('loginContainer').style.display, 'flex',
    'old cancellation completion cannot hide the new flow');
  assert.strictEqual(el('mainContent').style.display, 'none',
    'old cancellation completion cannot switch back to main content');
  assert.strictEqual(
    timerLog.filter((t) => t.kind === 'set' && t.ms === 300000).length,
    pollingStarts,
    'old cancellation completion cannot restart polling during the new flow'
  );
}

// Cancellation must not race an already-dispatched save: once save-account is
// on the wire the draft is committed; cancel must neither delete it nor
// double-save it.
async function testCancelCannotRaceDispatchedSave() {
  const api = createFakeApi([SAVED_ACCOUNT]);
  const pendingSaves = [];
  api.onDetectSessionKey = () => Promise.resolve({ success: true, sessionKey: 'KEY-2' });
  api.onValidateSessionKey = () => Promise.resolve({
    success: true,
    organizationId: 'org-1',
    organizations: [{ id: 'org-1', name: 'Personal', isTeam: false }]
  });
  api.onSaveAccount = (payload) => {
    const d = deferred();
    pendingSaves.push({ payload, d });
    return d.promise;
  };
  loadApp(api);
  await settle();

  fire(el('addAccountBtn'), 'click');
  await settle();
  fire(el('providerClaudeBtn'), 'click');
  fire(el('autoDetectBtn'), 'click');
  await settle();
  assert.strictEqual(pendingSaves.length, 1, 'save-account dispatched');

  // Cancel while the save IPC is still awaiting.
  fire(el('loginCancelBtn'), 'click');
  await settle();
  assert.strictEqual(api.discardedIds.length, 0,
    'cancel must not discard a draft whose save is already dispatched');
  assert.strictEqual(api.removedIds.length, 0,
    'cancel must not delete an account mid-save');

  // The dispatched save lands: the account is committed exactly once and the
  // flow completes.
  pendingSaves[0].d.resolve(true);
  await settle();
  assert.strictEqual(api.savedCalls.length, 1, 'exactly one save');
  assert.strictEqual(api.savedCalls[0].id, '2');
  assert.strictEqual(api.accounts.filter((a) => a.id === '2').length, 1,
    'account committed to the store');
  assert.strictEqual(el('loginContainer').style.display, 'none', 'flow completed');
  assert.strictEqual(el('mainContent').style.display, 'flex');
}

// Successful Claude add with organisation selection saves the intended
// account exactly once.
async function testClaudeOrgSelectionSavesIntendedAccountOnce() {
  const api = createFakeApi([SAVED_ACCOUNT]);
  api.onDetectSessionKey = () => Promise.resolve({ success: true, sessionKey: 'KEY-2' });
  api.onValidateSessionKey = () => Promise.resolve({
    success: true,
    organizationId: 'org-team',
    organizations: [
      { id: 'org-team', name: 'Team', isTeam: true },
      { id: 'org-personal', name: 'Personal', isTeam: false }
    ]
  });
  loadApp(api);
  await settle();

  fire(el('addAccountBtn'), 'click');
  await settle();
  fire(el('providerClaudeBtn'), 'click');
  fire(el('autoDetectBtn'), 'click');
  await settle();

  assert.strictEqual(el('loginStep3').style.display, 'block', 'org picker shown');
  assert.strictEqual(el('orgPickerSelect').children.length, 2, 'both orgs listed');

  el('orgPickerSelect').value = 'org-team';
  fire(el('orgPickerConfirmBtn'), 'click');
  await settle();

  assert.strictEqual(api.savedCalls.length, 1, 'saved exactly once');
  const saved = api.savedCalls[0];
  assert.strictEqual(saved.id, '2');
  assert.strictEqual(saved.provider, 'claude');
  assert.strictEqual(saved.sessionKey, 'KEY-2');
  assert.strictEqual(saved.organizationId, 'org-team');
  assert.strictEqual(saved.organizations.length, 2);
  assert.strictEqual(el('loginContainer').style.display, 'none');
  assert.strictEqual(el('mainContent').style.display, 'flex');
}

// Successful ChatGPT add saves exactly once with the right provider.
async function testChatGPTAddSavesExactlyOnce() {
  const api = createFakeApi([SAVED_ACCOUNT]);
  api.onDetectChatGPTToken = () => Promise.resolve({ success: true, token: 'TOK-2' });
  api.onValidateChatGPTToken = () => Promise.resolve({ success: true });
  loadApp(api);
  await settle();

  fire(el('addAccountBtn'), 'click');
  await settle();
  fire(el('providerChatGPTBtn'), 'click');
  fire(el('chatGPTLoginBtn'), 'click');
  await settle();

  assert.strictEqual(api.savedCalls.length, 1);
  assert.strictEqual(api.savedCalls[0].id, '2');
  assert.strictEqual(api.savedCalls[0].provider, 'chatgpt');
  assert.strictEqual(api.savedCalls[0].sessionKey, 'TOK-2');
  assert.strictEqual(api.accounts.filter((a) => a.id === '2').length, 1);
}

// Successful Claude reconnect updates the existing account exactly once —
// no duplicate entries.
async function testClaudeReconnectSavesExistingAccountOnce() {
  const api = createFakeApi([{ ...SAVED_ACCOUNT, manual: null }]);
  api.onDetectSessionKey = () => Promise.resolve({ success: true, sessionKey: 'KEY-NEW' });
  api.onValidateSessionKey = () => Promise.resolve({
    success: true,
    organizationId: 'org-new',
    organizations: [{ id: 'org-new', name: 'Personal', isTeam: false }]
  });
  loadApp(api);
  await settle();

  fire(cardFor('1').querySelector('.account-reconnect-btn'), 'click');
  await settle();
  fire(el('autoDetectBtn'), 'click');
  await settle();

  assert.strictEqual(api.savedCalls.length, 1, 'saved exactly once');
  assert.strictEqual(api.savedCalls[0].id, '1', 'updates the existing account');
  assert.strictEqual(api.savedCalls[0].sessionKey, 'KEY-NEW');
  assert.strictEqual(api.accounts.length, 1, 'reconnect updates, never duplicates');
  assert.strictEqual(api.accounts[0].orgId, 'org-new');
}

async function testChatGPTReconnectSavesExistingAccountOnce() {
  const api = createFakeApi([{ ...SAVED_ACCOUNT, provider: 'chatgpt', orgId: undefined }]);
  api.onDetectChatGPTToken = () => Promise.resolve({ success: true, token: 'TOK-NEW' });
  api.onValidateChatGPTToken = () => Promise.resolve({ success: true });
  loadApp(api);
  await settle();

  fire(cardFor('1').querySelector('.account-reconnect-btn'), 'click');
  await settle();
  fire(el('chatGPTLoginBtn'), 'click');
  await settle();

  assert.strictEqual(api.savedCalls.length, 1, 'saved exactly once');
  assert.strictEqual(api.savedCalls[0].id, '1');
  assert.strictEqual(api.savedCalls[0].provider, 'chatgpt');
  assert.strictEqual(api.savedCalls[0].sessionKey, 'TOK-NEW');
  assert.strictEqual(api.accounts.length, 1, 'reconnect updates, never duplicates');
}

// First-run cancel (no accounts yet) discards the draft and reopens a fresh
// flow without touching anything saved.
async function testFirstRunCancelReopensFreshDraft() {
  const api = createFakeApi([]);
  loadApp(api);
  await settle();

  // init() opened the first-run flow with draft 1.
  assert.deepStrictEqual(api.draftsCreated, ['1']);
  fire(el('providerClaudeBtn'), 'click');
  fire(el('autoDetectBtn'), 'click');
  await settle();

  fire(el('loginCancelBtn'), 'click');
  await settle();

  assert.deepStrictEqual(api.discardedIds, ['1'], 'first-run draft discarded');
  assert.strictEqual(api.removedIds.length, 0, 'no saved accounts touched');
  assert.strictEqual(el('loginContainer').style.display, 'flex', 'flow reopened');
  assert.deepStrictEqual(api.draftsCreated, ['1', '2'], 'a fresh draft was allocated');
}

// ── Runner ───────────────────────────────────────────────────────────────────

const scenarios = [
  ['reconnect cancel (Claude) preserves saved account', testReconnectCancelPreservesSavedAccountClaude],
  ['reconnect cancel (ChatGPT) preserves saved account', testReconnectCancelPreservesSavedAccountChatGPT],
  ['new-account cancel discards only its own draft', testNewAccountCancelDiscardsOnlyItsDraft],
  ['stale login result cannot cross into a later draft', testStaleLoginResultCannotCrossDrafts],
  ['stale validation/org result cannot alter another flow', testStaleValidationCannotAlterAnotherFlow],
  ['stale ChatGPT validation cannot cross into a later draft', testStaleChatGPTValidationCannotCrossDrafts],
  ['manual Connect is usable after cancelled validation', testManualConnectIsUsableAfterCancelledValidation],
  ['delayed repeated Cancel cannot alter a newer flow', testDelayedRepeatedCancelCannotAlterNewFlow],
  ['cancel cannot race an already-dispatched save', testCancelCannotRaceDispatchedSave],
  ['Claude org selection saves the intended account once', testClaudeOrgSelectionSavesIntendedAccountOnce],
  ['ChatGPT add saves exactly once', testChatGPTAddSavesExactlyOnce],
  ['Claude reconnect saves the existing account once', testClaudeReconnectSavesExistingAccountOnce],
  ['ChatGPT reconnect saves the existing account once', testChatGPTReconnectSavesExistingAccountOnce],
  ['first-run cancel discards the draft and reopens the flow', testFirstRunCancelReopensFreshDraft]
];

(async () => {
  let failed = 0;
  for (const [name, fn] of scenarios) {
    try {
      await fn();
      console.log('PASS  ' + name);
    } catch (err) {
      failed += 1;
      console.log('FAIL  ' + name);
      console.log('      ' + String(err && err.message).split('\n').join('\n      '));
    }
  }
  console.log(`\n${scenarios.length - failed}/${scenarios.length} scenarios passed`);
  process.exit(failed ? 1 : 0);
})();
