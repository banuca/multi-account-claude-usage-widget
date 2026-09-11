'use strict';

// Behavioural regressions for how the renderer PRESENTS a usage reading
// (Phase 2). These load the real renderer code (src/renderer/app.js) into a
// minimal DOM shim and drive it through its actual event listeners and IPC
// surface, against a controlled clock.
//
// The defects being locked out:
//   1. A missing / null / malformed percentage rendered as a green 0%.
//   2. A failed refresh left the previous values looking current, with no
//      stale marking and no last-success time.
//   3. The footer "Updated" clock was taken at RENDER time, so a redraw or a
//      settings change advanced it and a failed refresh looked fresh.
//   4. With several accounts the footer implied they had all refreshed.
//   5. A stale or unavailable reading reset the alert flags (null read as
//      "below 80%") and re-fired alerts on recovery.
//   6. Rendering mutated the stored provider payload (normalizeRows returned
//      data.rows itself and updateAccountCard pushed a placeholder into it).
//
// No provider URL is contacted: window.electronAPI is a fake and every payload
// is built in-process.

const assert = require('assert');
const { READ_STATUS } = require('../src/usage-status');

// ── Controlled clock ─────────────────────────────────────────────────────────
// Installed as global.Date so every `new Date()` / Date.now() inside the
// renderer sees the test's time. Nothing in the renderer may use it to stamp
// "last updated".

const RealDate = Date;
let fakeNow = RealDate.parse('2026-09-09T12:00:00Z');

class FakeDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(fakeNow);
    else super(...args);
  }
  static now() { return fakeNow; }
  static parse(...args) { return RealDate.parse(...args); }
  static UTC(...args) { return RealDate.UTC(...args); }
}

function setClock(iso) { fakeNow = RealDate.parse(iso); }
function advanceClock(ms) { fakeNow += ms; }

global.Date = FakeDate;

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
    this.className = '';
    this.spellcheck = false;
    this.offsetHeight = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
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

// The renderer starts polling/countdown intervals. unref them so the test
// process can exit once the scenarios are done.
// The renderer measures its own layout to decide whether the usage graph
// fits (applyGraphLayout). These shims answer those measurements with zeroes,
// which is the honest answer for a DOM that has no geometry: the graph reads
// as "no room", which is not what these scenarios are about. Real layout
// behaviour is covered against the actual renderer in
// test/electron-usage-status-smoke.js.
global.getComputedStyle = () => ({
  paddingTop: '0px', paddingBottom: '0px',
  marginTop: '0px', marginBottom: '0px',
  getPropertyValue: () => ''
});
global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
global.cancelAnimationFrame = (handle) => clearTimeout(handle);

const realSetInterval = global.setInterval;
global.setInterval = (fn, ms) => {
  const handle = realSetInterval(fn, ms);
  if (handle && typeof handle.unref === 'function') handle.unref();
  return handle;
};
const realSetTimeout = global.setTimeout;
global.setTimeout = (fn, ms) => {
  const handle = realSetTimeout(fn, ms);
  if (handle && typeof handle.unref === 'function') handle.unref();
  return handle;
};

// ── Fake electronAPI ─────────────────────────────────────────────────────────

function createFakeApi(initialAccounts) {
  const api = {
    platform: 'win32',
    isPortable: false,
    accounts: initialAccounts.map((a) => ({ ...a })),
    notifications: [],
    fetchCalls: [],
    historyByAccount: {},
    // accountId -> () => payload | Promise<payload> | throws
    responders: {},
    settings: {
      autoStart: false, minimizeToTray: false, alwaysOnTop: true,
      timeFormat: '24h', weeklyDateFormat: 'date', usageAlerts: true,
      refreshInterval: '300', graphVisible: false, expandedOpen: false,
      showTrayStats: false
    }
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
  api.removeAccount = async () => true;
  api.createDraftAccount = async () => ({ id: '99', partition: 'persist:acct-99', label: 'Account 99' });
  api.saveAccount = async () => true;
  api.discardDraftAccount = async () => true;
  api.cancelLoginCapture = async () => true;
  api.detectSessionKey = async () => ({ success: false, error: 'not used' });
  api.detectChatGPTToken = async () => ({ success: false, error: 'not used' });
  api.validateSessionKey = async () => ({ success: false, error: 'not used' });
  api.validateChatGPTToken = async () => ({ success: false, error: 'not used' });
  api.showNotification = (title, body) => api.notifications.push({ title, body });
  api.openExternal = () => {};
  api.minimizeWindow = () => {};
  api.closeWindow = () => {};
  api.onRefreshUsage = (cb) => { api._onRefreshUsage = cb; };
  api.onAccountSessionExpired = (cb) => { api._onSessionExpired = cb; };
  api.configHealth = { state: 'ok', reason: null, preservedPath: null, persistent: true };
  api.getConfigHealth = async () => ({ ...api.configHealth });
  api.onConfigHealth = (cb) => { api._onConfigHealth = cb; };
  api.getSecureStorage = async () => ({ available: true, backend: null, secure: true, reason: 'ok' });
  api.createManualAccount = async () => ({ ok: true });
  api.getUsageHistory = async (id) => api.historyByAccount[id] || [];

  api.fetchUsageData = async (accountId) => {
    api.fetchCalls.push(accountId);
    const responder = api.responders[accountId];
    if (!responder) throw new Error('no responder for ' + accountId);
    return responder(accountId);
  };

  return api;
}

// ── Payload builders (shaped exactly like main.js records them) ──────────────

function availablePayload({ session, weekly, lastSuccessAt, provider = 'claude' }) {
  const rows = [];
  if (session !== undefined) {
    rows.push({
      key: 'session', label: 'Current session', shortLabel: '5h',
      windowMs: 5 * 60 * 60 * 1000, resets_at: '2026-09-09T18:00:00Z',
      utilization: session, available: session !== null
    });
  }
  if (weekly !== undefined) {
    rows.push({
      key: 'weekly', label: 'Weekly limit', shortLabel: '7d',
      windowMs: 7 * 24 * 60 * 60 * 1000, resets_at: '2026-09-15T18:00:00Z',
      utilization: weekly, available: weekly !== null
    });
  }
  return {
    provider, source: 'auto', rows, raw: {},
    status: READ_STATUS.AVAILABLE, stale: false, error: null,
    lastSuccessAt, readAt: lastSuccessAt
  };
}

function stalePayload(previous, { error = 'Request timeout' } = {}) {
  return { ...previous, status: READ_STATUS.STALE, stale: true, error };
}

function unavailablePayload({ error = 'Request timeout', provider = 'claude' } = {}) {
  return {
    provider, source: 'auto', rows: [], raw: null,
    status: READ_STATUS.UNAVAILABLE, stale: false, error,
    lastSuccessAt: null, readAt: null
  };
}

function manualPayload({ used = 25, limit = 100, fallback = false, lastSuccessAt = null } = {}) {
  const utilization = limit > 0 ? Math.round((used / limit) * 100) : null;
  return {
    provider: 'chatgpt', source: 'manual', fallback,
    rows: [{
      key: 'manual', label: 'Manual usage', shortLabel: 'Manual',
      windowMs: null, resets_at: null, utilization, available: utilization !== null,
      used, limit
    }],
    raw: null,
    status: READ_STATUS.AVAILABLE, stale: false, error: fallback ? 'Request timeout' : null,
    lastSuccessAt, readAt: fakeNow
  };
}

// ── Harness ──────────────────────────────────────────────────────────────────

function loadApp(api) {
  elById = new Map();
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

async function settle(n = 25) {
  for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve));
}

function fire(target, type) {
  const handlers = (target._listeners && target._listeners[type]) || [];
  for (const handler of handlers) handler({});
}

function cardFor(accountId) {
  return el('accountsContainer').children.find((c) => c.dataset.accountId === accountId);
}

// Scoped card element by selector (the shim caches querySelector results).
function part(accountId, selector) {
  return cardFor(accountId).querySelector(selector);
}

function footerText() {
  return el('widgetUpdated').textContent;
}

// A refresh driven the way the app drives it: the main-process refresh event.
async function refreshAll(api) {
  await api._onRefreshUsage();
  await settle();
}

const CLAUDE_ACCOUNT = {
  id: '1', label: 'Personal', provider: 'claude', orgId: 'org-1',
  organizations: [], manual: null, hasSession: true
};
const CHATGPT_ACCOUNT = {
  id: '2', label: 'Work', provider: 'chatgpt',
  organizations: [], manual: null, hasSession: true
};

// ── Scenarios ────────────────────────────────────────────────────────────────

// 1. A genuine 0% must still read as 0% and be styled as a real reading.
async function testTrueZeroRendersAsZero() {
  const api = createFakeApi([CLAUDE_ACCOUNT]);
  api.responders['1'] = () => availablePayload({ session: 0, weekly: 0, lastSuccessAt: fakeNow });
  loadApp(api);
  await settle();

  assert.strictEqual(part('1', '.session-pct').textContent, '0%');
  assert.strictEqual(part('1', '.weekly-pct').textContent, '0%');
  assert.ok(part('1', '.session-pct').className.includes('status-green'));
  assert.strictEqual(part('1', '.account-status-tag').style.display, 'none',
    'a real reading carries no status chip');
}

// 2. Missing / null percentages must show a dash, never a green 0%.
async function testMissingPercentIsNotZero() {
  const api = createFakeApi([CLAUDE_ACCOUNT]);
  api.responders['1'] = () => availablePayload({ session: null, weekly: null, lastSuccessAt: fakeNow });
  loadApp(api);
  await settle();

  assert.strictEqual(part('1', '.session-pct').textContent, '—',
    'a null reading must not render as 0%');
  assert.strictEqual(part('1', '.weekly-pct').textContent, '—');
  assert.ok(part('1', '.session-pct').className.includes('status-unknown'),
    'an unknown reading must not be styled green');
  assert.ok(!part('1', '.session-pct').className.includes('status-green'));
}

// 3. A partial response keeps its valid row and marks only the missing one.
async function testPartialResponseKeepsValidRow() {
  const api = createFakeApi([CLAUDE_ACCOUNT]);
  api.responders['1'] = () => availablePayload({ session: 62, weekly: null, lastSuccessAt: fakeNow });
  loadApp(api);
  await settle();

  assert.strictEqual(part('1', '.session-pct').textContent, '62%');
  assert.strictEqual(part('1', '.weekly-pct').textContent, '—');
  assert.ok(part('1', '.session-pct').className.includes('status-green'));
  assert.ok(part('1', '.weekly-pct').className.includes('status-unknown'));
}

// 4. First fetch fails with nothing to fall back on ⇒ unavailable, not 0%.
async function testFirstFetchFailureShowsUnavailable() {
  const api = createFakeApi([CLAUDE_ACCOUNT]);
  api.responders['1'] = () => unavailablePayload({ error: 'Request timeout' });
  loadApp(api);
  await settle();

  assert.strictEqual(part('1', '.session-pct').textContent, '—');
  const chip = part('1', '.account-status-tag');
  assert.strictEqual(chip.textContent, 'unavailable');
  assert.strictEqual(chip.style.display, 'inline-flex');
  assert.ok(/Request timeout/.test(chip.title), 'the error is surfaced on the chip');
  assert.ok(/Never updated/.test(footerText()),
    `footer must not claim a time it never had: ${footerText()}`);
}

// 5. success → timeout → recovery. The stale phase keeps the old values, marks
//    them, and pins the footer to the successful read; recovery clears it.
async function testSuccessTimeoutRecovery() {
  const api = createFakeApi([CLAUDE_ACCOUNT]);
  setClock('2026-09-09T12:00:00Z');
  const first = availablePayload({ session: 44, weekly: 61, lastSuccessAt: fakeNow });
  api.responders['1'] = () => first;
  loadApp(api);
  await settle();

  const afterSuccess = footerText();
  assert.strictEqual(part('1', '.session-pct').textContent, '44%');
  assert.strictEqual(part('1', '.account-status-tag').style.display, 'none');

  // Refresh fails an hour later: main hands back the previous values as stale.
  advanceClock(60 * 60 * 1000);
  api.responders['1'] = () => stalePayload(first);
  await refreshAll(api);

  assert.strictEqual(part('1', '.session-pct').textContent, '44%',
    'useful previous values are retained');
  const chip = part('1', '.account-status-tag');
  assert.strictEqual(chip.textContent, 'stale');
  assert.ok(/last successful reading/i.test(chip.title));
  assert.strictEqual(footerText(), afterSuccess.replace(' · refresh 5m', ' · 1/1 not current · refresh 5m'),
    `a failed refresh must not advance the last-success time: ${footerText()}`);

  // A later success clears the transient error and moves the time on.
  advanceClock(60 * 60 * 1000);
  api.responders['1'] = () => availablePayload({ session: 47, weekly: 62, lastSuccessAt: fakeNow });
  await refreshAll(api);

  assert.strictEqual(part('1', '.session-pct').textContent, '47%');
  assert.strictEqual(part('1', '.account-status-tag').style.display, 'none',
    'a later success clears the stale marking');
  assert.notStrictEqual(footerText(), afterSuccess, 'a real success does advance the time');
  assert.ok(!/not current/.test(footerText()));
}

// 6. Redraws and settings changes must not advance "Updated".
async function testRedrawAndSettingsDoNotAdvanceTimestamp() {
  const api = createFakeApi([CLAUDE_ACCOUNT]);
  setClock('2026-09-09T09:30:00Z');
  api.responders['1'] = () => availablePayload({ session: 20, weekly: 30, lastSuccessAt: fakeNow });
  loadApp(api);
  await settle();

  const pinned = footerText();
  assert.ok(/Updated/.test(pinned));

  // Time passes with no successful read at all.
  advanceClock(3 * 60 * 60 * 1000);

  // A settings change (Done in the settings panel) re-renders every card.
  el('timeFormat').value = '24h';
  el('weeklyDateFormat').value = 'date';
  el('refreshInterval').value = '300';
  el('usageAlertsToggle').checked = true;
  el('autoStartToggle').checked = false;
  el('minimizeToTrayToggle').checked = false;
  el('alwaysOnTopToggle').checked = true;
  el('showTrayStatsToggle').checked = false;
  fire(el('closeSettingsBtn'), 'click');
  await settle();

  assert.strictEqual(footerText(), pinned,
    `a settings change must not advance the last-success time: ${footerText()}`);

  // A plain redraw of the cards (the graph toggle re-renders chips/cards).
  advanceClock(60 * 60 * 1000);
  fire(el('graphBtn'), 'click');
  await settle();
  assert.strictEqual(footerText(), pinned,
    `a redraw must not advance the last-success time: ${footerText()}`);
}

// 7. Two accounts: independent timestamps, and the footer never implies both
//    refreshed.
async function testTimestampsIndependentAcrossAccounts() {
  const api = createFakeApi([CLAUDE_ACCOUNT, CHATGPT_ACCOUNT]);
  setClock('2026-09-09T08:00:00Z');
  const claudeFirst = availablePayload({ session: 10, weekly: 20, lastSuccessAt: fakeNow });
  const chatgptFirst = availablePayload({ session: 30, weekly: 40, lastSuccessAt: fakeNow, provider: 'chatgpt' });
  api.responders['1'] = () => claudeFirst;
  api.responders['2'] = () => chatgptFirst;
  loadApp(api);
  await settle();

  const bothFresh = footerText();
  assert.ok(!/not current/.test(bothFresh), bothFresh);

  // Only account 2 refreshes successfully; account 1 goes stale.
  advanceClock(30 * 60 * 1000);
  api.responders['1'] = () => stalePayload(claudeFirst);
  api.responders['2'] = () => availablePayload({
    session: 33, weekly: 44, lastSuccessAt: fakeNow, provider: 'chatgpt'
  });
  await refreshAll(api);

  assert.match(footerText(), /1\/2 not current/,
    `the footer must not imply every account refreshed: ${footerText()}`);
  assert.strictEqual(part('1', '.account-status-tag').textContent, 'stale');
  assert.strictEqual(part('2', '.account-status-tag').style.display, 'none');
  assert.strictEqual(part('1', '.session-pct').textContent, '10%');
  assert.strictEqual(part('2', '.session-pct').textContent, '33%');
  // The stale card still reports the time of ITS last success, not account 2's.
  assert.ok(part('1', '.account-status-tag').title.length > 0);
}

// 8. Manual values stay labelled Manual; a fallback is not passed off as a
//    successful automatic reading.
async function testManualAndFallbackLabelling() {
  const api = createFakeApi([CHATGPT_ACCOUNT]);
  api.responders['2'] = () => manualPayload({ used: 25, limit: 100, fallback: false });
  loadApp(api);
  await settle();

  assert.strictEqual(part('2', '.account-source-tag').style.display, 'inline-flex',
    'a manual reading is labelled Manual');
  assert.strictEqual(part('2', '.account-status-tag').style.display, 'none');
  assert.strictEqual(part('2', '.session-pct').textContent, '25%');

  // Now the same manual entry standing in for a failed auto-read.
  api.responders['2'] = () => manualPayload({ used: 25, limit: 100, fallback: true });
  await refreshAll(api);

  assert.strictEqual(part('2', '.account-source-tag').style.display, 'inline-flex',
    'still labelled Manual');
  const chip = part('2', '.account-status-tag');
  assert.strictEqual(chip.textContent, 'fallback',
    'a fallback must not look like a successful automatic reading');
  assert.ok(/manual entry/i.test(chip.title));
  assert.ok(/Never updated/.test(footerText()),
    'a fallback never sets an automatic last-success time');
}

// 9. Alerts: a stale or unavailable reading must not fire, and must not reset
//    the fired flags as though usage had fallen.
async function testAlertsIgnoreStaleAndUnavailable() {
  const api = createFakeApi([CLAUDE_ACCOUNT]);
  const hot = availablePayload({ session: 96, weekly: 20, lastSuccessAt: fakeNow });
  api.responders['1'] = () => hot;
  loadApp(api);
  await settle();

  assert.strictEqual(api.notifications.length, 1, 'crossing 95% alerts once');

  // Same reading again: no repeat.
  await refreshAll(api);
  assert.strictEqual(api.notifications.length, 1);

  // Refresh fails: the stale payload still says 96%, but it is not a reading
  // of current usage and must not alert again.
  api.responders['1'] = () => stalePayload(hot);
  await refreshAll(api);
  assert.strictEqual(api.notifications.length, 1, 'a stale payload must not re-alert');

  // Rows present but carrying no reading (the provider returned the sections
  // without numbers). Read as 0 this clears the fired flags, and the next real
  // reading re-alerts for a threshold that was never re-crossed.
  api.responders['1'] = () => availablePayload({ session: null, weekly: null, lastSuccessAt: fakeNow });
  await refreshAll(api);
  assert.strictEqual(api.notifications.length, 1, 'an unreadable row must not alert');

  api.responders['1'] = () => availablePayload({ session: 96, weekly: 20, lastSuccessAt: fakeNow });
  await refreshAll(api);
  assert.strictEqual(api.notifications.length, 1,
    'an unreadable reading must not reset the alert flags as though usage fell');

  // A manual fallback at a low percentage is not a reading of current usage
  // either — it must not clear the flags and let the next auto-read re-alert.
  api.responders['1'] = () => manualPayload({ used: 10, limit: 100, fallback: true });
  await refreshAll(api);
  api.responders['1'] = () => availablePayload({ session: 96, weekly: 20, lastSuccessAt: fakeNow });
  await refreshAll(api);
  assert.strictEqual(api.notifications.length, 1,
    'a fallback must not reset the alert flags as though usage fell');

  // An unavailable payload (no rows at all) likewise leaves the flags alone.
  api.responders['1'] = () => unavailablePayload();
  await refreshAll(api);
  api.responders['1'] = () => availablePayload({ session: 96, weekly: 20, lastSuccessAt: fakeNow });
  await refreshAll(api);
  assert.strictEqual(api.notifications.length, 1,
    'an unavailable reading must not reset the alert flags as though usage fell');
}

// 10. A row with no reading must not fire an alert on its own.
async function testUnavailableRowDoesNotAlert() {
  const api = createFakeApi([CLAUDE_ACCOUNT]);
  api.responders['1'] = () => availablePayload({ session: null, weekly: null, lastSuccessAt: fakeNow });
  loadApp(api);
  await settle();
  assert.deepStrictEqual(api.notifications, []);
}

// 11. Rendering must not mutate the provider payload.
async function testRenderingDoesNotMutatePayload() {
  const api = createFakeApi([CLAUDE_ACCOUNT]);
  // An empty row set is the case that used to get a placeholder pushed into it.
  const payload = {
    provider: 'claude', source: 'auto', rows: [], raw: {},
    status: READ_STATUS.UNAVAILABLE, stale: false, error: 'EmptyResponse',
    lastSuccessAt: null, readAt: null
  };
  const before = JSON.stringify(payload);
  api.responders['1'] = () => payload;
  loadApp(api);
  await settle();

  assert.strictEqual(JSON.stringify(payload), before,
    'rendering must not push a placeholder row into the stored payload');
  assert.strictEqual(payload.rows.length, 0);

  // And a frozen payload (main.js freezes what it records) must render without
  // throwing.
  const frozen = Object.freeze({
    ...availablePayload({ session: 5, weekly: 6, lastSuccessAt: fakeNow }),
    rows: Object.freeze(availablePayload({ session: 5, weekly: 6, lastSuccessAt: fakeNow })
      .rows.map((r) => Object.freeze(r)))
  });
  api.responders['1'] = () => frozen;
  await refreshAll(api);
  assert.strictEqual(part('1', '.session-pct').textContent, '5%');
}

// 12. An account with no reading must not win the "closest to limit" badge.
async function testUnknownAccountDoesNotWinBadge() {
  const api = createFakeApi([CLAUDE_ACCOUNT, CHATGPT_ACCOUNT]);
  api.responders['1'] = () => unavailablePayload();
  api.responders['2'] = () => availablePayload({
    session: 88, weekly: 20, lastSuccessAt: fakeNow, provider: 'chatgpt'
  });
  loadApp(api);
  await settle();

  assert.strictEqual(part('1', '.account-badge').style.display, 'none',
    'an unknown account must not be flagged closest to limit');
  assert.strictEqual(part('2', '.account-badge').style.display, 'inline-flex');
}

// ── Runner ───────────────────────────────────────────────────────────────────

const scenarios = [
  ['a true 0% renders as 0%, not as unknown', testTrueZeroRendersAsZero],
  ['a missing percentage renders as — and never green 0%', testMissingPercentIsNotZero],
  ['a partial response keeps its valid row', testPartialResponseKeepsValidRow],
  ['a first-fetch failure shows unavailable, not 0%', testFirstFetchFailureShowsUnavailable],
  ['success → timeout → recovery keeps values, marks stale, then clears', testSuccessTimeoutRecovery],
  ['redraws and settings changes do not advance Updated', testRedrawAndSettingsDoNotAdvanceTimestamp],
  ['timestamps stay independent across accounts', testTimestampsIndependentAcrossAccounts],
  ['manual stays labelled Manual and a fallback is marked', testManualAndFallbackLabelling],
  ['stale/unavailable readings neither alert nor reset alert flags', testAlertsIgnoreStaleAndUnavailable],
  ['a row with no reading does not alert', testUnavailableRowDoesNotAlert],
  ['rendering does not mutate the provider payload', testRenderingDoesNotMutatePayload],
  ['an unknown account does not win the closest-to-limit badge', testUnknownAccountDoesNotWinBadge]
];

(async () => {
  let passed = 0;
  const failures = [];

  for (const [name, fn] of scenarios) {
    setClock('2026-09-09T12:00:00Z');
    try {
      await fn();
      console.log(`PASS  ${name}`);
      passed += 1;
    } catch (error) {
      failures.push({ name, error });
      console.log(`FAIL  ${name}`);
      console.log(`      ${String(error.message).split('\n').join('\n      ')}`);
    }
  }

  console.log(`\n${passed}/${scenarios.length} usage-status renderer scenarios passed`);
  if (failures.length) process.exitCode = 1;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
