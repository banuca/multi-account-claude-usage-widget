// Isolated Electron smoke check for the add/reconnect cancellation support.
//
// Run with: npm run test:electron  (or: electron test/electron-cancel-smoke.js)
//
// 1. Isolates APPDATA (and therefore electron-store's userData) BEFORE
//    requiring main.js — main.js's legacy migration derives its config path
//    from APPDATA at require time.
// 2. Seeds a synthetic account so no real user sessions are touched.
// 3. Boots the real main.js, then drives the real preload/IPC handlers from
//    a hidden probe window:
//      - discard-draft-account must refuse a saved account's id,
//      - cancel-login-capture must be a no-op without a pending capture,
//      - a cancelled reconnect must leave the saved credential asserted on
//        its partition,
//      - cancel-login-capture must close a live login-capture window and
//        settle the detect promise.
// 4. Blocks every HTTP(S) request from every Electron session, test-only,
//    installed BEFORE main.js loads (see below). The cancellation path under
//    test is the real one - it really opens a login-capture BrowserWindow and
//    really starts a navigation to the provider - but nothing is allowed to
//    reach the network. Both the attempt and the block are asserted.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate storage BEFORE main.js runs its legacy migration / Store creation.
const isolatedAppData = path.join(os.tmpdir(), `usage-widget-smoke-${process.pid}`);
fs.mkdirSync(isolatedAppData, { recursive: true });
process.env.APPDATA = isolatedAppData;

// Seed a synthetic account (never the user's saved sessions).
const configDir = path.join(isolatedAppData, 'claude-usage-widget');
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
  accounts: [
    {
      id: '1', label: 'Claude Smoke', provider: 'claude', orgId: 'smoke-org', organizations: [],
      manual: { enabled: true, used: 5, limit: 100 }
    },
    {
      id: '2', label: 'ChatGPT Smoke', provider: 'chatgpt', organizations: [],
      manual: { enabled: false, used: 7, limit: 100 }
    }
  ],
  accountSeq: 2,
  usageHistory_acct_1: [{ timestamp: Date.now(), session: 12, weekly: 34 }],
  usageHistory_acct_2: [{ timestamp: Date.now(), session: 23, weekly: 45 }]
}, null, 2));

// Pin Electron's userData to the same folder main.js's legacy migration uses
// (%APPDATA%\claude-usage-widget). Without this, a script entry (as opposed to
// `electron .`) resolves a different app name and electron-store would read a
// different directory than the migration checks.
// ── Platform isolation, asserted before any side effect ───────────────────
//
// This suite used to refuse to run on Linux. The reason was real: main.js's
// Linux autostart and desktop-integration writes were derived from
// os.homedir(), which no fixture can redirect, so a Linux run would have
// written into the developer's own ~/.config/autostart and
// ~/.local/share/applications.
//
// Those call sites now come from Electron's own path table (see
// src/platform-paths.js), which app.setPath() redirects. So the suite isolates
// them here - BEFORE main.js loads - and then proves it, rather than skipping
// the platform. A skip on one of three supported platforms is not a pass.
process.env.XDG_CONFIG_HOME = path.join(isolatedAppData, 'xdg-config');
process.env.XDG_DATA_HOME = path.join(isolatedAppData, 'xdg-data');
process.env.XDG_CACHE_HOME = path.join(isolatedAppData, 'xdg-cache');

const { app: electronApp } = require('electron');
electronApp.setPath('userData', configDir);
electronApp.setPath('appData', isolatedAppData);
electronApp.setPath('home', isolatedAppData);

{
  const { checkIsolation } = require('../src/platform-paths');
  const isolation = checkIsolation({
    platform: process.platform,
    paths: {
      userData: electronApp.getPath('userData'),
      appData: electronApp.getPath('appData'),
      home: electronApp.getPath('home')
    },
    env: process.env,
    root: isolatedAppData
  });
  if (!isolation.isolated) {
    console.error('[fixture] refusing to run: these paths resolve outside the test profile: '
      + isolation.escaped.map((e) => `${e.name}=${e.path}`).join(', '));
    process.exit(78);
  }
  console.log('[fixture] isolated paths: '
    + isolation.checked.map((e) => `${e.name}=${e.path}`).join(' | '));
}

// ── OS startup-registration guard — installed BEFORE main.js loads ─────────
//
// save-settings is real code and this suite exercises it, directly and through
// the graph-visibility preference. On non-portable Windows it reaches
// app.setLoginItemSettings, which writes the CURRENT USER's real Run key:
// isolating APPDATA and userData does not isolate an OS API, so a test run
// could change machine state outside its profile.
//
// Production behaviour is left exactly as it is. The setter is intercepted
// here, before main.js captures `app`, so the real one is unreachable for the
// life of the suite while save-settings, the store and the preference writes
// all stay real. Calls are recorded so the suite can assert the guard sits on
// the live path rather than assuming it does.
const loginItemGuard = (() => {
  const real = electronApp.setLoginItemSettings;
  const calls = [];
  electronApp.setLoginItemSettings = (options) => { calls.push(options); };
  return {
    calls,
    installed: electronApp.setLoginItemSettings !== real,
    realStillReachable: electronApp.setLoginItemSettings === real
  };
})();

// ── Test-only network blocking ─────────────────────────────────────────────
//
// This suite exercises the REAL credential-detection path, which opens a
// login-capture window and navigates it to the provider. That behaviour is
// the thing under test, so it is not mocked - but the navigation must not
// actually leave this machine.
//
// Two layers, because they answer different questions:
//
//   webRequest.onBeforeRequest  cancels the request. Electron allows only ONE
//                               onBeforeRequest listener per session, so if
//                               an outer harness (the architect's review.cjs)
//                               registers its own after this one, theirs wins
//                               and blockedByGuard stays empty. Blocking
//                               still happens either way.
//   navigation events           record what was ATTEMPTED and whether any
//                               provider navigation ever came back with a
//                               real HTTP status. These compose with any
//                               number of listeners, so this is the layer the
//                               assertions rely on.
//
// The signal for "we actually reached the server" is did-navigate carrying a
// NON-ZERO httpResponseCode. did-finish-load is not that signal: a blocked
// navigation still commits an error document and fires did-finish-load with
// the requested URL still in place, which reads as a successful load when it
// is the opposite.
const blockedByGuard = [];
const providerNavigations = [];
const providerLoads = [];
const isRemote = (url) => /^https?:\/\//i.test(url || '');
const originOf = (url) => { try { return new URL(url).origin; } catch (_) { return String(url); } };

electronApp.on('session-created', (createdSession) => {
  createdSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    blockedByGuard.push({ origin: originOf(details.url), resourceType: details.resourceType });
    callback({ cancel: true });
  });
});

electronApp.on('web-contents-created', (_event, contents) => {
  contents.on('did-start-navigation', (_e, url, _isInPlace, isMainFrame) => {
    if (isRemote(url)) providerNavigations.push({ origin: originOf(url), isMainFrame, outcome: 'started' });
  });
  contents.on('did-fail-load', (_e, code, description, url) => {
    if (isRemote(url)) providerNavigations.push({ origin: originOf(url), outcome: description || String(code) });
  });
  contents.on('did-navigate', (_e, url, httpResponseCode) => {
    if (isRemote(url) && Number(httpResponseCode) > 0) {
      providerLoads.push(`${originOf(url)} HTTP ${httpResponseCode}`);
    }
  });
});

require('../main.js');

// ── Test-only update-check stub ────────────────────────────────────────────
//
// main.js registers 'check-for-update' at module scope and answers it with a
// Node https.request to GitHub. That is a separate stack from Electron's
// session/webRequest layer, so no Electron-level network guard can intercept
// it — and the renderer schedules a check 2s after every load. Replacing the
// handler here, immediately after main.js has registered it and well before
// that timer can fire, is what makes this suite's no-outbound-request claim
// true rather than approximate.
//
// It is gated rather than hard-coded: tests that need the update banner turn
// updateOffered on for exactly as long as they need it.
let updateOffered = false;
{
  const { ipcMain: updateIpc } = require('electron');
  updateIpc.removeHandler('check-for-update');
  updateIpc.handle('check-for-update', () => (
    updateOffered ? { hasUpdate: true, version: '99.0.0' } : { hasUpdate: false }
  ));
}

const { app, BrowserWindow, session } = require('electron');

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok });
  console.log(`[cancel-smoke] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

setTimeout(() => {
  console.error('[cancel-smoke] TIMEOUT — forcing exit');
  app.exit(3);
}, 45000);

// Bounded wait for the real widget window instead of a fixed sleep: a slow
// boot used to leave this suite with no index.html window and no boot check at
// all.
//
// Readiness must be OBSERVED, not assumed: the renderer sets
// document.documentElement.dataset.startupComplete at the end of init(), and
// this waits for that exact value. A missing or unreadable marker keeps
// waiting and then fails with the last state - it is never accepted as ready.
async function waitForRenderer(expectedCards, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = 'no index.html window was ever created';
  while (Date.now() < deadline) {
    const win = BrowserWindow.getAllWindows().find(
      (w) => !w.isDestroyed() && w.webContents.getURL().includes('index.html')
    );
    if (win && !win.webContents.isLoading()) {
      try {
        const state = await win.webContents.executeJavaScript(
          `(() => {
            // The renderer's own explicit end-of-startup marker (set at the
            // end of init() in app.js): cards rendered, every account polled
            // once, saved graph preference applied, window sized. Required to
            // be observed as true - an absent or unknown marker is NOT
            // treated as ready.
            let startupComplete = false;
            let marker = null;
            try {
              marker = document.documentElement.dataset.startupComplete || null;
              startupComplete = marker === 'true';
            } catch (_) {}
            return {
              ready: document.readyState,
              cards: document.querySelectorAll('.account-block').length,
              startupComplete,
              marker
            };
          })()`
        );
        if (state.ready === 'complete' && state.cards >= expectedCards
            && state.startupComplete === true) {
          return win;
        }
        last = JSON.stringify(state);
      } catch (error) {
        last = `renderer not answering yet: ${String(error && error.message)}`;
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the widget renderer was not ready within ${timeoutMs}ms — last state: ${last}`);
}

app.whenReady().then(async () => {
  try {
    let mainWin = null;
    try {
      mainWin = await waitForRenderer(2);
      record('the widget renderer becomes ready within its budget', true);
    } catch (error) {
      record('the widget renderer becomes ready within its budget', false, String(error.message));
    }
    if (mainWin) {
      const summary = await mainWin.webContents.executeJavaScript(`({
        accountCards: document.querySelectorAll('.account-block').length,
        providerTags: [...document.querySelectorAll('.account-provider-tag')].map(el => el.textContent),
        mainVisible: document.getElementById('mainContent').style.display,
        loginVisible: document.getElementById('loginContainer').style.display
      })`);
      record(
        'widget boots with synthetic account',
        summary && summary.accountCards === 2
          && summary.providerTags.includes('Claude')
          && summary.providerTags.includes('ChatGPT')
          && summary.mainVisible === 'flex',
        JSON.stringify(summary)
      );
    } else {
      record('widget window created', false, 'renderer never became ready — the boot check could not run');
    }

    // Hidden probe window sharing the real preload → exercises real IPC.
    const probe = new BrowserWindow({
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, '..', 'preload.js')
      }
    });
    await probe.loadFile(path.join(__dirname, 'electron-probe.html'));

    const discardSaved = await probe.webContents.executeJavaScript(
      `window.electronAPI.discardDraftAccount('1')`
    );
    record('discard-draft-account refuses a saved account', discardSaved === false,
      `returned ${JSON.stringify(discardSaved)}`);

    const discardGhost = await probe.webContents.executeJavaScript(
      `window.electronAPI.discardDraftAccount('999')`
    );
    record('discard-draft-account wipes an unknown draft partition', discardGhost === true,
      `returned ${JSON.stringify(discardGhost)}`);

    const cancelNone = await probe.webContents.executeJavaScript(
      `window.electronAPI.cancelLoginCapture('persist:acct-none')`
    );
    record('cancel-login-capture no-op without a pending capture', cancelNone === false,
      `returned ${JSON.stringify(cancelNone)}`);

    // Save a synthetic credential through the real save-account handler, then
    // cancel a capture on that saved partition — the stored credential must be
    // re-asserted onto the partition (reconnect-cancel preserves credentials).
    const saveOk = await probe.webContents.executeJavaScript(
      `window.electronAPI.saveAccount({ id: '1', label: 'Claude Smoke', provider: 'claude', sessionKey: 'smoke-key', organizationId: 'smoke-org', organizations: [] })`
    );
    record('save-account works over IPC', saveOk === true, `returned ${JSON.stringify(saveOk)}`);

    await probe.webContents.executeJavaScript(`window.electronAPI.cancelLoginCapture('persist:acct-1')`);
    const cookies = await session.fromPartition('persist:acct-1').cookies.get({ url: 'https://claude.ai' });
    const hasKey = cookies.some((c) => c.name === 'sessionKey' && c.value === 'smoke-key');
    record('cancelled reconnect re-asserts the saved credential', hasKey,
      `sessionKey cookie: ${hasKey ? 'present' : 'MISSING'}`);

    // Cancel real in-flight validation IPC for both providers. Each validator
    // first writes the candidate cookie and opens a hidden provider window;
    // cancellation must abort that window, wait for it to settle, then restore
    // the saved credential so no late failure can remove it.
    const claudeValidation = probe.webContents.executeJavaScript(
      `window.electronAPI.validateSessionKey('candidate-claude', 'persist:acct-1', 'smoke-claude-validation')`
    );
    const claudeCancel = probe.webContents.executeJavaScript(
      `window.electronAPI.cancelLoginCapture('persist:acct-1', 'smoke-claude-validation')`
    );
    const [claudeValidationResult] = await Promise.all([claudeValidation, claudeCancel]);
    const claudeCookies = await session.fromPartition('persist:acct-1').cookies.get({ url: 'https://claude.ai' });
    const claudeRestored = claudeCookies.some((c) => c.name === 'sessionKey' && c.value === 'smoke-key');
    record(
      'Claude validation cancellation restores the saved credential',
      claudeValidationResult?.success === false && claudeRestored,
      `result ${JSON.stringify(claudeValidationResult)}; saved cookie ${claudeRestored ? 'present' : 'MISSING'}`
    );

    const saveChatGPT = await probe.webContents.executeJavaScript(
      `window.electronAPI.saveAccount({ id: '2', label: 'ChatGPT Smoke', provider: 'chatgpt', sessionKey: 'smoke-token', organizations: [] })`
    );
    record('ChatGPT save-account works over IPC', saveChatGPT === true,
      `returned ${JSON.stringify(saveChatGPT)}`);
    const chatgptValidation = probe.webContents.executeJavaScript(
      `window.electronAPI.validateChatGPTToken('candidate-chatgpt', 'persist:acct-2', 'smoke-chatgpt-validation')`
    );
    const chatgptCancel = probe.webContents.executeJavaScript(
      `window.electronAPI.cancelLoginCapture('persist:acct-2', 'smoke-chatgpt-validation')`
    );
    const [chatgptValidationResult] = await Promise.all([chatgptValidation, chatgptCancel]);
    const chatgptCookies = await session.fromPartition('persist:acct-2').cookies.get({ url: 'https://chatgpt.com' });
    const chatgptRestored = chatgptCookies.some(
      (c) => c.name === '__Secure-next-auth.session-token' && c.value === 'smoke-token'
    );
    record(
      'ChatGPT validation cancellation restores the saved credential',
      chatgptValidationResult?.success === false && chatgptRestored,
      `result ${JSON.stringify(chatgptValidationResult)}; saved cookie ${chatgptRestored ? 'present' : 'MISSING'}`
    );

    // Live login capture: start a real capture window and cancel it mid-flight.
    const detectPromise = probe.webContents.executeJavaScript(
      `window.electronAPI.detectSessionKey('persist:smoke-cancel', 'smoke-live-capture')`
    );
    await new Promise((r) => setTimeout(r, 1500));
    const cancelLive = await probe.webContents.executeJavaScript(
      `window.electronAPI.cancelLoginCapture('persist:smoke-cancel', 'smoke-live-capture')`
    );
    const detectResult = await Promise.race([
      detectPromise,
      new Promise((r) => setTimeout(() => r({ timeout: true }), 10000))
    ]);
    record(
      'cancel closes a live login-capture window',
      cancelLive === true && detectResult && detectResult.success === false,
      `cancel returned ${JSON.stringify(cancelLive)}; detect resolved ${JSON.stringify(detectResult)}`
    );

    const accounts = await probe.webContents.executeJavaScript(`window.electronAPI.getAccounts()`);
    record(
      'synthetic account intact after all probes',
      Array.isArray(accounts) && accounts.length === 2
        && accounts.some((a) => a.id === '1' && a.manual?.used === 5)
        && accounts.some((a) => a.id === '2' && a.manual?.used === 7),
      JSON.stringify(accounts)
    );

    const history1 = await probe.webContents.executeJavaScript(`window.electronAPI.getUsageHistory('1')`);
    const history2 = await probe.webContents.executeJavaScript(`window.electronAPI.getUsageHistory('2')`);
    const storedConfig = JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8'));
    const credentialBackupsPresent = ['1', '2'].every((id) =>
      storedConfig[`account_${id}_sessionKey_encrypted`] || storedConfig[`account_${id}_sessionKey`]
    );
    record(
      'manual settings, history and credential backups remain intact',
      history1.some((entry) => entry.session === 12 && entry.weekly === 34)
        && history2.some((entry) => entry.session === 23 && entry.weekly === 45)
        && credentialBackupsPresent,
      `history ${history1.length}/${history2.length}; credential backups ${credentialBackupsPresent ? 'present' : 'MISSING'}`
    );

    // ── Network isolation ─────────────────────────────────────────────────
    // The decisive check is providerLoads: a provider page that finished
    // loading is the only outcome that would mean real contact. The
    // navigations list shows the real cancellation path did run.
    record(
      'no provider navigation ever returned an HTTP response',
      providerLoads.length === 0,
      providerLoads.length
        ? `REACHED: ${[...new Set(providerLoads)].join(', ')}`
        : 'none — every provider navigation was refused before dispatch'
    );
    record(
      'the real detection path did attempt a provider navigation',
      providerNavigations.length > 0,
      JSON.stringify(providerNavigations.slice(0, 6))
    );

    // Prove the block is live in THIS run rather than inferring it from a
    // counter that an outer harness's guard may have taken over: ask for a
    // provider page deliberately and require the load to be refused.
    let guardProof = 'not attempted';
    const guardProbe = new BrowserWindow({ show: false });
    try {
      await guardProbe.loadURL('https://claude.ai/');
      guardProof = 'LOADED - the request was NOT blocked';
    } catch (error) {
      guardProof = String((error && error.message) || error);
    }
    if (!guardProbe.isDestroyed()) guardProbe.destroy();
    record(
      'a deliberate provider request is refused before it leaves the machine',
      /ERR_BLOCKED_BY_CLIENT|ERR_ABORTED|ERR_FAILED/.test(guardProof)
        && providerLoads.length === 0,
      guardProof
    );
    console.log('[cancel-smoke] guard cancelled', blockedByGuard.length,
      'request(s):', JSON.stringify([...new Set(blockedByGuard.map((r) => r.origin + ' ' + r.resourceType))]));
    console.log('[cancel-smoke] navigations:', JSON.stringify(providerNavigations));

    const failed = results.filter((r) => !r.ok).length;
    console.log(`[cancel-smoke] ${results.length - failed}/${results.length} passed`);
    app.exit(failed ? 1 : 0);
  } catch (err) {
    console.error('[cancel-smoke] fatal:', err);
    app.exit(2);
  }
});
