// Isolated Electron smoke check for Phase 2 usage read status.
//
// Run with: npm run test:electron:usage  (or: electron test/electron-usage-status-smoke.js)
//
// Exercises the REAL main-process paths — the fetch-usage-data IPC handler,
// the read-state tracking, history writing and the tray rollup — with:
//   1. APPDATA and Electron userData isolated BEFORE main.js is required, so
//      no real config, credential or history is touched.
//   2. Synthetic accounts and synthetic credentials only.
//   3. The two provider readers replaced with in-process mocks, so NO provider
//      URL is contacted. The mocks are installed on the shared module exports
//      before main.js requires them, which is why main's destructured
//      references pick them up.
//
// Everything else (normalizers, read-state recording, history rotation, tray
// rollup, IPC) is the real code.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate storage BEFORE main.js runs its legacy migration / Store creation.
const isolatedAppData = path.join(os.tmpdir(), `usage-widget-status-smoke-${process.pid}`);
fs.mkdirSync(isolatedAppData, { recursive: true });
process.env.APPDATA = isolatedAppData;

const SEEDED_HISTORY = [{ timestamp: Date.now() - 60000, session: 12, weekly: 34 }];

const configDir = path.join(isolatedAppData, 'claude-usage-widget');
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
  accounts: [
    { id: '1', label: 'Claude Smoke', provider: 'claude', orgId: 'smoke-org', organizations: [], manual: null },
    { id: '2', label: 'ChatGPT Smoke', provider: 'chatgpt', organizations: [], manual: null },
    // Manual entry present but NOT enabled, and no credential → fallback path.
    { id: '3', label: 'Fallback Smoke', provider: 'claude', orgId: 'smoke-org', organizations: [], manual: { enabled: false, used: 9, limit: 100 } },
    // Manual override enabled → auto-read skipped entirely.
    { id: '4', label: 'Manual Smoke', provider: 'claude', orgId: 'smoke-org', organizations: [], manual: { enabled: true, used: 30, limit: 100 } }
  ],
  accountSeq: 4,
  usageHistory_acct_1: SEEDED_HISTORY,
  // Tray stats on, so the real updateTrayRollup (including the neutral
  // no-reading badge) runs on every fetch in this smoke.
  settings: { showTrayStats: true, usageAlerts: false, refreshInterval: '300' }
}, null, 2));

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

// ── Provider mocks — installed before main.js requires these modules ────────
// Each responder is swapped between probe steps by the scenarios below.

// The widget's own boot poll runs before any scenario below, so the initial
// responders are a deterministic failure: that gives the real renderer a
// first-fetch-failure to paint, which the DOM assertions then check.
let claudeResponder = () => { throw new Error('BootReadFailure'); };
let chatgptResponder = () => { throw new Error('BootReadFailure'); };
const contactedUrls = [];

const fetchViaWindowModule = require('../src/fetch-via-window');
fetchViaWindowModule.fetchMultipleViaWindow = async (urls, options = {}) => {
  contactedUrls.push(...urls);
  return [await claudeResponder(urls, options)];
};

// A reconnect validates its session key through fetchViaWindow (singular) —
// a DIFFERENT export from the usage reader above, and the only other outbound
// call main.js makes. Mocked here, before main.js destructures it, so the
// whole reconnect flow can be driven end to end without contacting claude.ai.
// Recorded in its own array so the usage reader's no-contact assertion stays
// exactly as strict as it was.
const validationUrls = [];
let claudeOrgResponder = () => { throw new Error('NoValidationExpected'); };
fetchViaWindowModule.fetchViaWindow = async (url, options = {}) => {
  validationUrls.push(url);
  return claudeOrgResponder(url, options);
};

// 'reversed' hands main.js the same rows in the opposite order, which is how
// this smoke proves the consumers key off row.key rather than row position.
let chatgptRowOrder = 'normal';

const providersModule = require('../src/providers');
providersModule.fetchChatGPTUsageData = async (options = {}) => {
  const raw = await chatgptResponder(options);
  const data = providersModule.normalizeChatGPTUsage(raw);
  if (chatgptRowOrder !== 'reversed') return data;
  return { ...data, rows: [...data.rows].reverse() };
};

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

const { app, BrowserWindow, safeStorage } = require('electron');
const { selectRow, isRowAvailable, ROW_SLOTS } = require('../src/usage-status');

// ── Exact credential comparison, without ever reading a key out ────────────
//
// hasSession is a boolean: it proves a credential exists, not that it is the
// same one. These helpers decrypt through the real safeStorage and reduce the
// value to an HMAC digest, so a test can prove a credential was RETAINED
// byte-for-byte or REPLACED by a specific new value while the plaintext never
// reaches a log, a file or an assertion message.
const CREDENTIAL_DIGEST_SALT = 'usage-smoke-credential-digest-salt';
const credentialDigestOf = (value) =>
  require('crypto').createHmac('sha256', CREDENTIAL_DIGEST_SALT).update(String(value)).digest('hex');

function storedCredential(id) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8'));
  } catch (err) {
    return { mode: 'unreadable', digest: null, error: err.message };
  }
  const encrypted = raw[`account_${id}_sessionKey_encrypted`];
  const plain = raw[`account_${id}_sessionKey`];
  if (encrypted !== undefined) {
    try {
      const value = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
      return { mode: 'encrypted', digest: credentialDigestOf(value) };
    } catch (err) {
      return { mode: 'undecryptable', digest: null, error: err.message };
    }
  }
  if (plain !== undefined) return { mode: 'plaintext', digest: credentialDigestOf(plain) };
  return { mode: 'absent', digest: null };
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok });
  console.log(`[status-smoke] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Null-safe payload view. Pre-Phase-2 code returned payloads with no status
// fields at all (and threw outright on a failed refresh), so the before/after
// comparison must be able to report every scenario rather than dying on the
// first missing field.
function view(result) {
  const data = (result && result.data) || {};
  const rows = Array.isArray(data.rows) ? data.rows : [];
  return {
    ok: !!(result && result.ok),
    message: result && result.message,
    status: data.status,
    stale: data.stale,
    error: data.error,
    source: data.source,
    fallback: data.fallback,
    lastSuccessAt: data.lastSuccessAt,
    rowCount: rows.length,
    pct: (i) => (rows[i] ? rows[i].utilization : undefined),
    avail: (i) => (rows[i] ? rows[i].available : undefined),
    // What the tray badges and the history writer see: the reading of the row
    // that fills a slot, chosen by its key rather than its position.
    slot: (name) => {
      const row = selectRow(rows, name);
      return isRowAvailable(row) ? row.utilization : null;
    },
    keys: rows.map((r) => r && r.key)
  };
}

// A bound, not a guess: every wait inside the suite is itself bounded, so this
// only fires if something is genuinely stuck. It was 60s when the suite had
// ~190 assertions; it now runs ~250, several of which wait for the window
// manager to apply a resize and for the layout to settle.
setTimeout(() => {
  console.error('[status-smoke] TIMEOUT — forcing exit');
  app.exit(3);
}, 240000);

// Bounded wait for the REAL renderer instead of a fixed sleep: a slow boot
// used to leave this suite with no index.html window at all, which silently
// skipped every renderer check below.
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
    await sleep(100);
  }
  throw new Error(`the widget renderer was not ready within ${timeoutMs}ms — last state: ${last}`);
}

app.whenReady().then(async () => {
  try {

    // ── 0. The REAL renderer window, real index.html, real styles ─────────
    // Accounts 1 and 2 have no credential yet and their provider read fails,
    // so their cards must paint the unavailable state rather than a green 0%.
    // Account 4 has a manual override. This also proves the shared
    // usage-status module actually loads in the packaged renderer — it is a
    // classic <script> there, not a require().
    let mainWin = null;
    try {
      mainWin = await waitForRenderer(4);
      record('the widget renderer becomes ready within its budget', true);
    } catch (error) {
      record('the widget renderer becomes ready within its budget', false, String(error.message));
    }

    // ── Fixture preconditions, declared once for the whole suite ──────────
    //
    // This suite drives the real renderer, so it depends on two things the OS
    // controls and the suite previously left to luck:
    //
    //   1. requestAnimationFrame must run. The graph relayout is scheduled on
    //      rAF, and Chromium throttles rAF for a hidden or occluded window. A
    //      hidden window measured 124/138 here — the architect's exact result,
    //      with the two resize/suppression assertions red. The shipped app runs
    //      visible, so disabling throttling for the test window reproduces
    //      normal conditions rather than papering over anything.
    //   2. The window must hold keyboard focus, or :focus-visible never matches
    //      and every Tab/Space assertion fails for a reason that has nothing to
    //      do with the code under test.
    //
    // Both are requested and then ASSERTED, so a machine that cannot give the
    // window focus reports that plainly instead of producing ten confusing
    // focus failures.
    //
    // setBounds is likewise only a REQUEST: the window manager may refuse,
    // clamp or defer it, and a case labelled "320" that actually measured 560
    // proves nothing. resizeChecked waits for the renderer's own innerWidth /
    // innerHeight to agree and records what it really got.
    let ensureRendererInteractive = async () => true;
    let resizeAndConfirm = async (width, height) => ({ requested: { width, height }, css: null, os: null });
    let resizeChecked = resizeAndConfirm;
    let awaitFrames = async () => true;

    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.setBackgroundThrottling(false);

      // Assignment, not a declaration: a `const` here would shadow the
      // suite-scope binding and leave every later section calling the stub.
      ensureRendererInteractive = async (why, budgetMs = 4000) => {
        if (!mainWin.isVisible()) mainWin.show();
        mainWin.focus();
        mainWin.webContents.focus();
        const deadline = Date.now() + budgetMs;
        let hasFocus = false;
        while (Date.now() < deadline) {
          hasFocus = await mainWin.webContents.executeJavaScript('document.hasFocus()');
          if (hasFocus && mainWin.isVisible()) break;
          await sleep(80);
        }
        record(
          `precondition: the widget window is visible and holds keyboard focus (${why})`,
          hasFocus === true && mainWin.isVisible() === true,
          `visible=${mainWin.isVisible()} windowFocused=${mainWin.isFocused()} documentHasFocus=${hasFocus}` +
          (hasFocus ? '' : ' — the assertions that need keyboard focus cannot be trusted on this machine')
        );
        return hasFocus === true && mainWin.isVisible() === true;
      };

      await ensureRendererInteractive('suite start');
      console.log('[fixture]', JSON.stringify({
        bounds: mainWin.getBounds(),
        visible: mainWin.isVisible(),
        focused: mainWin.isFocused(),
        backgroundThrottling: false
      }));

      // Does the renderer still paint? The graph relayout is scheduled on
      // requestAnimationFrame, which Chromium throttles for a hidden or
      // occluded window. Resolving false here means the measurements below
      // would be of a stale layout, and that has to be reported as a missing
      // precondition rather than blamed on the code under test.
      awaitFrames = (count = 2, budgetMs = 2000) => mainWin.webContents.executeJavaScript(
        `new Promise((resolve) => {
           let left = ${count};
           const timer = setTimeout(() => resolve(false), ${budgetMs});
           const step = () => {
             if (--left <= 0) { clearTimeout(timer); resolve(true); return; }
             requestAnimationFrame(step);
           };
           requestAnimationFrame(step);
         })`
      );

      // The layout is read only once it has stopped moving, so a measurement
      // can never catch an intermediate frame. Deliberately neutral: it waits
      // for stability, not for any particular answer.
      const graphLayoutFingerprint = () => mainWin.webContents.executeJavaScript(`(() => {
        const g = document.getElementById('graphSection').getBoundingClientRect();
        const a = document.getElementById('accountsContainer').getBoundingClientRect();
        return [innerWidth, innerHeight, getComputedStyle(document.getElementById('graphSection')).display,
                Math.round(g.height), Math.round(a.height)].join('|');
      })()`);

      // Wait until the document that will be measured actually exists. A
      // setBounds issued while a reload is still in flight moves the OS frame
      // but the renderer keeps reporting the previous innerWidth/innerHeight,
      // and every measurement after that is of a layout that no longer
      // matches the window. That produced a run where the OS frame was 640x320
      // and the CSS viewport still said 640x484 — the assertions were right to
      // fail, but the cause was the harness, not the product.
      const awaitDocumentReady = async (budgetMs = 5000) => {
        const deadline = Date.now() + budgetMs;
        while (Date.now() < deadline) {
          const state = await mainWin.webContents.executeJavaScript('document.readyState')
            .catch(() => null);
          if (state === 'complete') return true;
          await sleep(60);
        }
        return false;
      };

      resizeAndConfirm = async (width, height, budgetMs = 4000) => {
        // A hidden or minimised window on Windows does not propagate a resize
        // to the compositor, so make sure it is on screen before asking.
        if (!mainWin.isVisible()) mainWin.show();
        const documentReady = await awaitDocumentReady();

        const issue = () => {
          const { x, y } = mainWin.getBounds();
          mainWin.setBounds({ x, y, width, height });
        };

        // Why a tolerance: at 125% display scaling a requested 150 DIP becomes
        // 187.5 physical pixels, which rounds to 188 and comes back as 151.
        // That is the window manager being unable to represent the request,
        // not the product mis-laying-out, and it is the same on any scaled
        // display. Two pixels covers every scaling factor Windows offers;
        // anything larger is a real mismatch.
        const TOLERANCE = 2;
        const matches = (css) => !!css
          && Math.abs(css.width - width) <= TOLERANCE
          && Math.abs(css.height - height) <= TOLERANCE;

        let css = null;
        let mark = null;
        let stable = 0;
        const settle = async (ms) => {
          const deadline = Date.now() + ms;
          while (Date.now() < deadline) {
            css = await mainWin.webContents.executeJavaScript('({ width: innerWidth, height: innerHeight })')
              .catch(() => null);
            const next = await graphLayoutFingerprint().catch(() => null);
            if (matches(css)) {
              if (next === mark && ++stable >= 2) return true;
              if (next !== mark) { stable = 0; mark = next; }
            }
            await sleep(60);
          }
          return false;
        };

        issue();
        let converged = await settle(budgetMs);

        // One repeat of the SAME request, and nothing else. Re-issuing bounds
        // asks the window manager for exactly what was already asked for; it
        // changes no application state and destroys no scenario.
        //
        // What this deliberately does NOT do any more is reload the renderer.
        // An earlier version did, to recover from a measured Electron
        // behaviour on this machine: a transparent, non-resizable window whose
        // renderer has been reloaded can stop propagating a SHRINK, leaving the
        // OS frame at (say) 640x320 while innerHeight still reports 484. A
        // reload does clear that - and it also re-runs the renderer's init(),
        // which is precisely the state several of the checks below are
        // measuring. Rescuing a precondition by resetting the thing under test
        // turns a harness problem into a false pass, so non-convergence is now
        // reported as a failed precondition and the dependent measurements are
        // recorded as not measured.
        //
        // The cause itself is handled by awaitDocumentReady above: the frames
        // that were dropped were issued while a reload was still in flight.
        let reissued = false;
        if (!converged) {
          reissued = true;
          stable = 0;
          mark = null;
          issue();
          converged = await settle(1500);
        }

        return {
          requested: { width, height },
          os: mainWin.getBounds(),
          css,
          settled: mark,
          converged,
          reissued,
          documentReady,
          tolerance: TOLERANCE
        };
      };

      resizeChecked = async (width, height, why) => {
        const got = await resizeAndConfirm(width, height);
        record(
          `precondition: the window really measures ${width}x${height} (${why})`,
          got.converged === true,
          `requested ${width}x${height}, css ${got.css && got.css.width}x${got.css && got.css.height},`
          + ` os ${got.os.width}x${got.os.height}, tolerance=±${got.tolerance}px`
          + `, documentReady=${got.documentReady}${got.reissued ? ', request repeated once' : ''}`
        );
        return got;
      };

      record(
        'precondition: the renderer is painting frames (rAF is not throttled)',
        (await awaitFrames()) === true,
        'requestAnimationFrame must run for the graph relayout to be observable; a hidden or occluded window throttles it'
      );
    }

    if (!mainWin) {
      record('the widget window renders', false, 'renderer never became ready — the checks below could not run');
    } else {
      const dom = await mainWin.webContents.executeJavaScript(`(() => {
        const card = (id) => document.querySelector('.account-block[data-account-id="' + id + '"]');
        const read = (id, sel) => {
          const c = card(id);
          if (!c) return null;
          const node = c.querySelector(sel);
          return node ? { text: (node.textContent || '').trim(), cls: node.className || '', display: node.style.display } : null;
        };
        return {
          sharedModule: !!(window.UsageStatus && window.UsageStatus.readPercent(null) === null
                           && window.UsageStatus.readPercent(0) === 0),
          cards: document.querySelectorAll('.account-block').length,
          footer: (document.getElementById('widgetUpdated').textContent || '').trim(),
          a1session: read('1', '.session-pct'),
          a1status: read('1', '.account-status-tag'),
          a4session: read('4', '.session-pct'),
          a4source: read('4', '.account-source-tag')
        };
      })()`);

      // Stated as a precondition, not a footnote: if this ever fails, every
      // preference-save assertion below was writing to the real OS.
      record(
        'precondition: the OS startup-registration setter is intercepted, not the real one',
        loginItemGuard.installed === true && loginItemGuard.realStillReachable === false,
        `installed=${loginItemGuard.installed} realStillReachable=${loginItemGuard.realStillReachable}`
      );

      record(
        'the shared usage-status module loads in the real renderer',
        dom.sharedModule === true && dom.cards === 4,
        `sharedModule=${dom.sharedModule} cards=${dom.cards}`
      );
      record(
        'a failed first read paints — in the real card, not a green 0%',
        dom.a1session && dom.a1session.text === '\u2014'
          && /status-unknown/.test(dom.a1session.cls)
          && !/status-green/.test(dom.a1session.cls),
        `session=${dom.a1session && JSON.stringify(dom.a1session)}`
      );
      record(
        'the real card carries the unavailable status chip',
        dom.a1status && dom.a1status.text === 'unavailable' && dom.a1status.display === 'inline-flex',
        `chip=${dom.a1status && JSON.stringify(dom.a1status)}`
      );
      record(
        'the real footer does not claim an update that never happened',
        /Never updated/.test(dom.footer) && /3\/4 not current/.test(dom.footer),
        `footer=${JSON.stringify(dom.footer)} (2 failed reads + 1 manual fallback of 4 accounts)`
      );
      record(
        'a manual override renders its value and its Manual label',
        dom.a4session && dom.a4session.text === '30%'
          && dom.a4source && dom.a4source.display === 'inline-flex',
        `session=${dom.a4session && dom.a4session.text} manualTag=${dom.a4source && dom.a4source.display}`
      );
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

    const fetchUsage = (id) => probe.webContents.executeJavaScript(
      `window.electronAPI.fetchUsageData(${JSON.stringify(id)}).then(
         (data) => ({ ok: true, data }),
         (error) => ({ ok: false, message: String(error && error.message || error) })
       )`
    );
    const history = (id) => probe.webContents.executeJavaScript(
      `window.electronAPI.getUsageHistory(${JSON.stringify(id)})`
    );

    // Synthetic credentials for the two auto-read accounts.
    await probe.webContents.executeJavaScript(
      `window.electronAPI.saveAccount({ id: '1', label: 'Claude Smoke', provider: 'claude', sessionKey: 'synthetic-claude-key', organizationId: 'smoke-org', organizations: [] })`
    );
    await probe.webContents.executeJavaScript(
      `window.electronAPI.saveAccount({ id: '2', label: 'ChatGPT Smoke', provider: 'chatgpt', sessionKey: 'synthetic-chatgpt-token', organizations: [] })`
    );

    // ── 1. Claude success ──────────────────────────────────────────────────
    const claudePayload = {
      five_hour: { utilization: 44, resets_at: '2026-09-09T18:00:00Z' },
      seven_day: { utilization: 61, resets_at: '2026-09-15T18:00:00Z' }
    };
    claudeResponder = () => claudePayload;
    const first = view(await fetchUsage('1'));
    const firstSuccessAt = first.lastSuccessAt;
    record(
      'Claude success is available with a last-success time',
      first.ok && first.status === 'available' && first.stale === false
        && first.error === null && typeof firstSuccessAt === 'number'
        && first.pct(0) === 44 && first.avail(0) === true,
      `status=${first.status} session=${first.pct(0)} at=${firstSuccessAt}`
    );

    record(
      'main does not mutate the provider payload it was handed',
      claudePayload.status === undefined && claudePayload.rows === undefined
        && claudePayload.lastSuccessAt === undefined,
      `provider object keys: ${Object.keys(claudePayload).join(',')}`
    );

    const historyAfterFirst = await history('1');
    record(
      'a successful read appends one history sample and keeps existing history',
      historyAfterFirst.length === SEEDED_HISTORY.length + 1
        && historyAfterFirst.some((e) => e.session === 12 && e.weekly === 34)
        && historyAfterFirst[historyAfterFirst.length - 1].session === 44
        && historyAfterFirst[historyAfterFirst.length - 1].weekly === 61,
      `samples=${historyAfterFirst.length} last=${JSON.stringify(historyAfterFirst[historyAfterFirst.length - 1])}`
    );

    // ── 2. Claude refresh fails → stale, values kept, time frozen ─────────
    await sleep(30);
    claudeResponder = () => { throw new Error('Request timeout'); };
    const stale = view(await fetchUsage('1'));
    record(
      'a failed refresh keeps the previous values, marked stale',
      stale.ok && stale.status === 'stale' && stale.stale === true
        && stale.pct(0) === 44 && stale.pct(1) === 61
        && /timeout/i.test(String(stale.error)),
      stale.ok
        ? `status=${stale.status} error=${stale.error}`
        : `the handler threw instead of reporting a status: ${stale.message}`
    );
    record(
      'a failed refresh does not advance the last-success time',
      stale.ok && stale.lastSuccessAt === firstSuccessAt,
      `before=${firstSuccessAt} after=${stale.lastSuccessAt}`
    );
    const historyAfterStale = await history('1');
    record(
      'a failed refresh writes no history sample',
      historyAfterStale.length === historyAfterFirst.length,
      `samples=${historyAfterStale.length} (expected ${historyAfterFirst.length})`
    );

    // ── 3. Recovery clears the error and advances the time ────────────────
    await sleep(30);
    claudeResponder = () => ({
      five_hour: { utilization: 47, resets_at: '2026-09-09T18:00:00Z' },
      seven_day: { utilization: 62, resets_at: '2026-09-15T18:00:00Z' }
    });
    const recovered = view(await fetchUsage('1'));
    record(
      'a later success clears the transient error and advances the time',
      recovered.ok && recovered.status === 'available' && recovered.stale === false
        && recovered.error === null
        && recovered.pct(0) === 47
        && recovered.lastSuccessAt > firstSuccessAt,
      `status=${recovered.status} at=${recovered.lastSuccessAt}`
    );

    // ── 4. A response with no usable reading is not a success ─────────────
    await sleep(30);
    claudeResponder = () => ({
      five_hour: { utilization: null, resets_at: '2026-09-09T18:00:00Z' },
      seven_day: { utilization: 'unknown' }
    });
    const unreadable = view(await fetchUsage('1'));
    const historyAfterUnreadable = await history('1');
    const lastSample = historyAfterUnreadable[historyAfterUnreadable.length - 1] || {};
    record(
      'a malformed response keeps the last good values instead of showing 0%',
      unreadable.ok && unreadable.status === 'stale'
        && unreadable.pct(0) === 47
        && unreadable.lastSuccessAt === recovered.lastSuccessAt,
      `status=${unreadable.status} session=${unreadable.pct(0)}`
    );
    record(
      'a malformed response fabricates no history sample',
      lastSample.session === 47 && lastSample.weekly === 62,
      `last sample=${JSON.stringify(lastSample)}`
    );

    // ── 5. A partial response records a gap, not a zero ───────────────────
    await sleep(30);
    claudeResponder = () => ({
      five_hour: { utilization: 30, resets_at: '2026-09-09T18:00:00Z' },
      seven_day: { utilization: null, resets_at: '2026-09-15T18:00:00Z' }
    });
    const partial = view(await fetchUsage('1'));
    const historyAfterPartial = await history('1');
    const partialSample = historyAfterPartial[historyAfterPartial.length - 1] || {};
    record(
      'a partial response keeps the readable row and flags the other',
      partial.ok && partial.status === 'available'
        && partial.pct(0) === 30 && partial.avail(0) === true
        && partial.pct(1) === null && partial.avail(1) === false,
      `session=${partial.pct(0)} weekly=${partial.pct(1)}`
    );
    record(
      'a missing reading is stored as a history gap, not 0%',
      partialSample.session === 30 && partialSample.weekly === null,
      `sample=${JSON.stringify(partialSample)}`
    );

    // ── 6. ChatGPT first fetch fails with nothing to fall back on ─────────
    chatgptResponder = () => { throw new Error('Request timeout'); };
    const gptFail = view(await fetchUsage('2'));
    const gptHistory = await history('2');
    record(
      'a first-fetch failure reports unavailable, not 0%',
      gptFail.ok && gptFail.status === 'unavailable'
        && gptFail.rowCount === 0
        && gptFail.lastSuccessAt === null
        && /timeout/i.test(String(gptFail.error)),
      gptFail.ok
        ? `status=${gptFail.status} rows=${gptFail.rowCount} at=${gptFail.lastSuccessAt}`
        : `the handler threw instead of reporting a status: ${gptFail.message}`
    );
    record(
      'a first-fetch failure writes no history at all',
      gptHistory.length === 0,
      `samples=${gptHistory.length}`
    );

    // ── 7. ChatGPT success, including a true 0% ───────────────────────────
    await sleep(30);
    chatgptResponder = () => ({
      plan_type: 'plus',
      rate_limit: {
        primary_window: { used_percent: 0, limit_window_seconds: 18000, reset_at: 1789000000 },
        secondary_window: { used_percent: 55, limit_window_seconds: 604800, reset_at: 1789600000 }
      }
    });
    const gptOk = view(await fetchUsage('2'));
    record(
      'ChatGPT true 0% is an available reading, not an unknown',
      gptOk.ok && gptOk.status === 'available'
        && gptOk.pct(0) === 0 && gptOk.avail(0) === true
        && gptOk.pct(1) === 55
        && typeof gptOk.lastSuccessAt === 'number',
      `status=${gptOk.status} session=${gptOk.pct(0)} weekly=${gptOk.pct(1)}`
    );

    // ── 8. ChatGPT goes stale, then a partial recovery ────────────────────
    await sleep(30);
    chatgptResponder = () => ({ plan_type: 'plus', rate_limit: {} });
    const gptEmpty = view(await fetchUsage('2'));
    record(
      'an empty ChatGPT response keeps the previous reading as stale',
      gptEmpty.ok && gptEmpty.status === 'stale'
        && gptEmpty.pct(0) === 0
        && gptEmpty.lastSuccessAt === gptOk.lastSuccessAt,
      `status=${gptEmpty.status} session=${gptEmpty.pct(0)} at=${gptEmpty.lastSuccessAt}`
    );

    // ── 9. Manual fallback (no credential) is labelled, not a success ─────
    const fallback = view(await fetchUsage('3'));
    const fallbackHistory = await history('3');
    record(
      'a manual fallback is labelled manual + fallback and sets no success time',
      fallback.ok && fallback.source === 'manual' && fallback.fallback === true
        && fallback.pct(0) === 9
        && fallback.lastSuccessAt === null
        && /credential/i.test(String(fallback.error)),
      `source=${fallback.source} fallback=${fallback.fallback} at=${fallback.lastSuccessAt} error=${fallback.error}`
    );
    record(
      'a manual fallback writes no history sample',
      fallbackHistory.length === 0,
      `samples=${fallbackHistory.length}`
    );

    // ── 10. Manual override is a manual reading, not an automatic one ─────
    const overrideHistoryBefore = await history('4');
    const override = view(await fetchUsage('4'));
    const overrideHistory = await history('4');
    record(
      'a manual override is manual, not a fallback, and sets no automatic success time',
      override.ok && override.source === 'manual' && override.fallback === false
        && override.pct(0) === 30
        && override.lastSuccessAt === null,
      `source=${override.source} fallback=${override.fallback} at=${override.lastSuccessAt}`
    );
    const overrideSample = overrideHistory[overrideHistory.length - 1] || {};
    record(
      'a manual override does record its own history sample, with a weekly gap',
      overrideHistory.length === overrideHistoryBefore.length + 1
        && overrideSample.session === 30 && overrideSample.weekly === null,
      `samples ${overrideHistoryBefore.length}→${overrideHistory.length} last=${JSON.stringify(overrideSample)}`
    );

    // ── 11. Settings changes must not advance the last-success time ───────
    claudeResponder = () => ({
      five_hour: { utilization: 51, resets_at: '2026-09-09T18:00:00Z' },
      seven_day: { utilization: 52, resets_at: '2026-09-15T18:00:00Z' }
    });
    const beforeSettings = view(await fetchUsage('1')).lastSuccessAt;
    await sleep(30);
    await probe.webContents.executeJavaScript(
      `window.electronAPI.saveAccountManual('1', { enabled: false, used: 1, limit: 100 })`
    );
    await sleep(30);
    claudeResponder = () => { throw new Error('Request timeout'); };
    const afterSettings = view(await fetchUsage('1'));
    record(
      'a manual-settings change does not advance the last-success time',
      typeof beforeSettings === 'number' && afterSettings.lastSuccessAt === beforeSettings,
      `before=${beforeSettings} after=${afterSettings.lastSuccessAt}`
    );

    // ── 12. A reading lands in the slot its key names ────────────────────
    //
    // The defect being locked out: session and weekly were read as rows[0] and
    // rows[1], so a response carrying ONLY a weekly window reported that 73%
    // as a 73% SESSION reading — in the tray badges and in the stored history
    // — and left weekly empty. These run through the real IPC handler, the
    // real history writer and the real worst-account selection.
    const { computeWorstAccount } = require('../src/account-logic');

    for (const provider of ['claude', 'chatgpt']) {
      const id = provider === 'claude' ? '1' : '2';
      await sleep(30);
      if (provider === 'claude') {
        claudeResponder = () => ({ seven_day: { utilization: 73, resets_at: '2026-09-16T18:00:00Z' } });
      } else {
        chatgptResponder = () => ({
          rate_limit: { secondary_window: { used_percent: 73, limit_window_seconds: 604800, reset_at: 1789581600 } }
        });
      }
      const weeklyOnlyResult = await fetchUsage(id);
      const weeklyOnly = view(weeklyOnlyResult);
      // The real selection code, over the payload the real IPC handler returned.
      const worst = computeWorstAccount(
        [{ id, label: 'Weekly only' }],
        { [id]: weeklyOnlyResult.data || {} }
      );

      record(
        `${provider}: a weekly-only response is one weekly row, not a session row`,
        weeklyOnly.ok && weeklyOnly.rowCount === 1 && weeklyOnly.keys[0] === 'weekly'
          && weeklyOnly.slot(ROW_SLOTS.SESSION) === null
          && weeklyOnly.slot(ROW_SLOTS.WEEKLY) === 73,
        `keys=${JSON.stringify(weeklyOnly.keys)} session=${weeklyOnly.slot(ROW_SLOTS.SESSION)} weekly=${weeklyOnly.slot(ROW_SLOTS.WEEKLY)}`
      );
      record(
        `${provider}: a weekly-only response selects the tray badges by slot`,
        worst && worst.sessionPct === null && worst.weeklyPct === 73,
        `worst=${JSON.stringify(worst && { sessionPct: worst.sessionPct, weeklyPct: worst.weeklyPct })}`
      );

      const samples = await history(id);
      const last = samples[samples.length - 1] || {};
      record(
        `${provider}: a weekly-only response is stored as session=null, weekly=73`,
        last.session === null && last.weekly === 73,
        `sample=${JSON.stringify(last)}`
      );
    }

    // Reversed rows: the same two readings in the opposite order must not swap.
    await sleep(30);
    chatgptRowOrder = 'reversed';
    chatgptResponder = () => ({
      rate_limit: {
        primary_window: { used_percent: 21, limit_window_seconds: 18000, reset_at: 1789581600 },
        secondary_window: { used_percent: 64, limit_window_seconds: 604800, reset_at: 1789581600 }
      }
    });
    const reversed = view(await fetchUsage('2'));
    const reversedSamples = await history('2');
    const reversedSample = reversedSamples[reversedSamples.length - 1] || {};
    record(
      'reversed rows keep each reading in its own slot',
      reversed.ok && JSON.stringify(reversed.keys) === JSON.stringify(['weekly', 'session'])
        && reversed.slot(ROW_SLOTS.SESSION) === 21 && reversed.slot(ROW_SLOTS.WEEKLY) === 64,
      `keys=${JSON.stringify(reversed.keys)} session=${reversed.slot(ROW_SLOTS.SESSION)} weekly=${reversed.slot(ROW_SLOTS.WEEKLY)}`
    );
    record(
      'reversed rows are stored in their own slots, not by position',
      reversedSample.session === 21 && reversedSample.weekly === 64,
      `sample=${JSON.stringify(reversedSample)}`
    );
    chatgptRowOrder = 'normal';

    // A manual override keeps the session slot it has always used, and claims
    // no weekly reading — account 4 is manual-only.
    const manualOnly = view(await fetchUsage('4'));
    record(
      'a manual override keeps the session slot and claims no weekly reading',
      manualOnly.ok && manualOnly.keys[0] === 'manual'
        && manualOnly.slot(ROW_SLOTS.SESSION) === 30
        && manualOnly.slot(ROW_SLOTS.WEEKLY) === null,
      `keys=${JSON.stringify(manualOnly.keys)} session=${manualOnly.slot(ROW_SLOTS.SESSION)} weekly=${manualOnly.slot(ROW_SLOTS.WEEKLY)}`
    );

    // ── 13. Nothing contacted a provider URL ─────────────────────────────
    record(
      'no provider URL was contacted',
      contactedUrls.every((url) => url.startsWith('https://claude.ai/api/organizations/smoke-org')),
      `mocked reader received: ${contactedUrls.length ? [...new Set(contactedUrls)].join(', ') : 'nothing'} (never dispatched)`
    );

    // ── 14. Synthetic accounts and credentials intact ────────────────────
    const accounts = await probe.webContents.executeJavaScript(`window.electronAPI.getAccounts()`);
    const storedConfig = JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8'));
    const credentialsPresent = ['1', '2'].every((id) =>
      storedConfig[`account_${id}_sessionKey_encrypted`] || storedConfig[`account_${id}_sessionKey`]);
    record(
      'synthetic accounts, manual settings and credentials remain intact',
      Array.isArray(accounts) && accounts.length === 4 && credentialsPresent
        && accounts.some((a) => a.id === '4' && a.manual && a.manual.used === 30),
      `accounts=${accounts.length} credentials=${credentialsPresent ? 'present' : 'MISSING'}`
    );

    // ── 15. Responsive graph: the account list and footer keep priority ───
    //
    // The defect being locked out: .graph-section reserved a fixed 220px and
    // refused to shrink, so opening the graph in a short window collapsed the
    // account list to 0px and pushed the footer outside the viewport
    // entirely. These run against the REAL renderer at measured window
    // bounds, not against CSS read by eye.
    if (mainWin && !mainWin.isDestroyed()) {
      const savedBounds = mainWin.getBounds();

      // Re-measured after every resize. Reads real geometry, and proves the
      // list still scrolls by actually scrolling it and putting it back.
      const measure = () => mainWin.webContents.executeJavaScript(`(() => {
        const box = (id) => {
          const el = document.getElementById(id);
          const r = el.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, height: r.height,
                   clientHeight: el.clientHeight, scrollHeight: el.scrollHeight,
                   display: getComputedStyle(el).display };
        };
        const list = document.getElementById('accountsContainer');
        const was = list.scrollTop;
        list.scrollTop = list.scrollHeight;
        const moved = list.scrollTop;
        list.scrollTop = was;
        const firstCard = document.querySelector('.account-block');
        const graphBtn = document.getElementById('graphBtn');
        return {
          viewport: { width: innerWidth, height: innerHeight },
          footer: box('widgetFooter'),
          accounts: box('accountsContainer'),
          graph: box('graphSection'),
          canvas: box('usageChart'),
          pref: graphVisible,
          suppressed: graphSuppressed,
          btnActive: graphBtn.classList.contains('active'),
          btnSuppressed: graphBtn.classList.contains('suppressed'),
          btnTitle: graphBtn.title,
          // A list taller than its viewport must actually scroll; one that
          // fits is trivially reachable.
          scrolls: list.scrollHeight > list.clientHeight ? moved > 0 : true,
          rows: document.querySelectorAll('.account-block .usage-row').length,
          firstRowReachable: !!firstCard
            && firstCard.getBoundingClientRect().height > 0,
          horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
          controlsUsable: ['settingsBtn','refreshBtn','graphBtn','minimizeBtn','closeBtn']
            .every((id) => {
              const el = document.getElementById(id);
              if (!el) return false;
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.height > 0 && r.bottom <= innerHeight + 1;
            })
        };
      })()`);

      // Used by the graph sweep. It used to return only the OS bounds and drop
      // the confirmation, so a resize the renderer never applied passed
      // through unnoticed and poisoned every later measurement. Now a
      // non-converged resize fails here, where the cause is visible.
      // Used by the graph sweep. It used to return only the OS bounds and drop
      // the confirmation, so a resize the renderer never applied passed
      // through unnoticed and poisoned every later measurement. Now a
      // non-converged resize fails here, where the cause is visible, and says
      // that the measurements which follow it are not to be trusted.
      const resizeTo = async (width, height) => {
        const got = await resizeAndConfirm(width, height);
        if (!got.converged) {
          record(
            `precondition: the renderer applied the ${width}x${height} resize (graph sweep)`,
            false,
            `requested ${width}x${height}, css ${got.css && got.css.width}x${got.css && got.css.height},`
            + ` os ${got.os.width}x${got.os.height}, tolerance=±${got.tolerance}px`
            + `, documentReady=${got.documentReady}${got.reissued ? ', request repeated once' : ''}`
            + ' — the graph measurements below would be of a stale layout'
          );
        }
        return got.os;
      };

      const setGraphPref = async (on) => {
        const state = await mainWin.webContents.executeJavaScript('graphVisible');
        if (state !== on) {
          await mainWin.webContents.executeJavaScript("document.getElementById('graphBtn').click()");
        }
        await sleep(500);
      };

      // Graph ON for the sweep: this is the combination that used to break.
      await setGraphPref(true);

      // The sweep reads geometry after each resize, so it is only meaningful
      // while the renderer is actually painting.
      record(
        'precondition: the renderer is painting frames before the resize sweep',
        (await awaitFrames()) === true,
        'the graph relayout is rAF-scheduled; without frames the sweep would measure a stale layout'
      );

      // MIN_WINDOW_HEIGHT in main.js is 150; 240 and 300 are the two short
      // heights between it and a normal window.
      for (const width of [480, 640, 800]) {
        for (const height of [480, 300, 240, 150]) {
          const actual = await resizeTo(width, height);
          const view = await measure();
          const label = `${width}x${height} (window ${actual.width}x${actual.height}, css ${view.viewport.width}x${view.viewport.height})`;

          record(
            `graph-open ${label}: footer stays inside the viewport`,
            view.footer.top >= 0 && view.footer.bottom <= view.viewport.height + 0.5,
            `footer top=${view.footer.top} bottom=${view.footer.bottom} viewport=${view.viewport.height}`
          );
          record(
            `graph-open ${label}: the account list keeps a usable scrolling viewport`,
            view.accounts.height >= 28 && view.scrolls && view.firstRowReachable && view.rows > 0,
            `accounts height=${view.accounts.height} scrolls=${view.scrolls} rows=${view.rows}`
          );
          record(
            `graph-open ${label}: a visible chart stays inside its panel`,
            view.graph.display === 'none'
              || (view.canvas.height > 0
                  && view.canvas.bottom <= view.graph.bottom + 1
                  && view.graph.bottom <= view.viewport.height + 0.5),
            `graph display=${view.graph.display} bottom=${view.graph.bottom} canvas bottom=${view.canvas.bottom} height=${view.canvas.height}`
          );
          record(
            `graph-open ${label}: no horizontal overflow and the controls stay usable`,
            !view.horizontalOverflow && view.controlsUsable,
            `hOverflow=${view.horizontalOverflow} controls=${view.controlsUsable}`
          );
          record(
            `graph-open ${label}: the graph preference survives the resize`,
            view.pref === true && view.btnActive === true,
            `pref=${view.pref} btnActive=${view.btnActive} suppressed=${view.suppressed}`
          );
        }
      }

      // ── Shrink, then grow: suppression must undo itself ─────────────────
      await resizeTo(640, 560);
      const tall = await measure();
      record(
        'at a normal height the graph is shown, not suppressed',
        tall.graph.display !== 'none' && tall.suppressed === false && tall.canvas.height > 0,
        `graph=${tall.graph.display} suppressed=${tall.suppressed} canvas=${tall.canvas.height}`
      );

      await resizeTo(640, 240);
      const shrunk = await measure();
      record(
        'shrinking to a short window suppresses the graph and keeps the preference',
        shrunk.graph.display === 'none' && shrunk.suppressed === true
          && shrunk.pref === true && shrunk.btnSuppressed === true
          && /too short/i.test(shrunk.btnTitle),
        `graph=${shrunk.graph.display} suppressed=${shrunk.suppressed} pref=${shrunk.pref} title=${JSON.stringify(shrunk.btnTitle)}`
      );
      const shrunkSettings = await probe.webContents.executeJavaScript('window.electronAPI.getSettings()');
      record(
        'responsive suppression does not write the saved graph setting',
        shrunkSettings.graphVisible === true,
        `stored graphVisible=${shrunkSettings.graphVisible}`
      );

      await resizeTo(640, 560);
      const regrown = await measure();
      record(
        'growing the window brings the graph back with no further click',
        regrown.graph.display !== 'none' && regrown.suppressed === false
          && regrown.canvas.height > 0 && regrown.btnSuppressed === false,
        `graph=${regrown.graph.display} suppressed=${regrown.suppressed} canvas=${regrown.canvas.height}`
      );

      // ── Toggling still works, and still switches accounts ──────────────
      const chips = await mainWin.webContents.executeJavaScript(`(async () => {
        const list = [...document.querySelectorAll('.graph-account-chip')];
        const before = (list.find((c) => c.classList.contains('active')) || {}).textContent;
        const other = list.find((c) => !c.classList.contains('active'));
        if (other) { other.click(); await new Promise((r) => setTimeout(r, 700)); }
        const after = [...document.querySelectorAll('.graph-account-chip')]
          .find((c) => c.classList.contains('active'));
        const canvas = document.getElementById('usageChart').getBoundingClientRect();
        return { count: list.length, before, after: after && after.textContent,
                 canvasHeight: canvas.height, hasChart: !!usageChart };
      })()`);
      record(
        'at a normal height the graph still switches accounts and renders',
        chips.count >= 2 && chips.after !== chips.before && chips.canvasHeight > 0,
        JSON.stringify(chips)
      );

      await setGraphPref(false);
      const off = await measure();
      record(
        'switching the graph off hides it as a preference, not as suppression',
        off.graph.display === 'none' && off.pref === false
          && off.suppressed === false && off.btnActive === false,
        `graph=${off.graph.display} pref=${off.pref} suppressed=${off.suppressed}`
      );

      // ── Restart with the graph saved on, in a short window ──────────────
      // A real renderer restart: reload re-runs init(), which reads the saved
      // preference and applies the layout for the current window size.
      await probe.webContents.executeJavaScript(
        `window.electronAPI.getSettings().then((s) =>
           window.electronAPI.saveSettings(Object.assign({}, s, { graphVisible: true })))`
      );
      await resizeTo(640, 240);
      mainWin.webContents.reload();
      let restarted = null;
      try {
        await waitForRenderer(4);
        restarted = await measure();
      } catch (error) {
        record('the renderer restarts in a short window', false, String(error.message));
      }
      record(
        'reloading the renderer with the graph saved on, in a short window, suppresses it and keeps the setting',
        !!restarted && restarted.graph.display === 'none' && restarted.suppressed === true
          && restarted.pref === true && restarted.btnActive === true,
        restarted ? `graph=${restarted.graph.display} suppressed=${restarted.suppressed} pref=${restarted.pref}` : 'renderer never became ready'
      );
      await resizeTo(640, 560);
      const afterRestartGrow = await measure();
      record(
        'after that renderer reload, growing the window shows the graph without a click',
        afterRestartGrow.graph.display !== 'none' && afterRestartGrow.suppressed === false,
        `graph=${afterRestartGrow.graph.display} suppressed=${afterRestartGrow.suppressed}`
      );

      // Leave the renderer as the rest of this suite (and any outer harness)
      // expects it: graph off, saved setting off, original window bounds.
      await probe.webContents.executeJavaScript(
        `window.electronAPI.getSettings().then((s) =>
           window.electronAPI.saveSettings(Object.assign({}, s, { graphVisible: false })))`
      );
      mainWin.webContents.reload();
      try {
        await waitForRenderer(4);
      } catch (error) {
        record('the renderer is left in a usable state for the remaining checks', false, String(error.message));
      }
      mainWin.setBounds(savedBounds);
      await sleep(300);
      const restored = await measure();
      record(
        'the suite leaves the graph off and the window as it found it',
        restored.pref === false && restored.graph.display === 'none',
        `pref=${restored.pref} graph=${restored.graph.display} bounds=${JSON.stringify(mainWin.getBounds())}`
      );
    } else {
      record('responsive graph layout could be measured', false, 'no renderer window');
    }

    // ── 16. Available content height, not just window size ───────────────
    //
    // The defect being locked out: applyGraphLayout() was only invalidated on
    // window.resize, so anything else that took height from the same column
    // left the graph at its old size. The update banner does exactly that —
    // revealing it in a stationary 640x320 window collapsed the account
    // viewport from 55.4 to 13.8 CSS px, with no complete usage row left.
    //
    // Driven through the REAL renderer checkForUpdate() with a test-only
    // replacement of the check-for-update IPC handler, so no update server is
    // contacted and no production code is swapped out.
    if (mainWin && !mainWin.isDestroyed()) {
      // The suite-wide stub above answers "no update" by default, which also
      // makes the pre-banner state deterministic: init()'s own 2s check cannot
      // raise the banner behind this section's back.

      const layoutOf = () => mainWin.webContents.executeJavaScript(`(() => {
        const box = (id) => {
          const el = document.getElementById(id);
          const r = el.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, height: r.height,
                   clientHeight: el.clientHeight, scrollHeight: el.scrollHeight,
                   display: getComputedStyle(el).display };
        };
        const list = document.getElementById('accountsContainer');
        const was = list.scrollTop;
        list.scrollTop = list.scrollHeight;
        const moved = list.scrollTop;
        list.scrollTop = was;
        // The first row in DOM order can legitimately be hidden — a weekly-only
        // account hides its session row — so "reachable" is about the rows the
        // user can actually see.
        const visibleRows = [...document.querySelectorAll('.account-block .usage-row')]
          .filter((row) => getComputedStyle(row).display !== 'none');
        const firstRow = visibleRows[0];
        return {
          viewport: innerHeight,
          accounts: box('accountsContainer'),
          footer: box('widgetFooter'),
          graph: box('graphSection'),
          canvas: box('usageChart'),
          banner: box('updateBanner'),
          pref: graphVisible,
          suppressed: graphSuppressed,
          scrolls: list.scrollHeight > list.clientHeight ? moved > 0 : true,
          // A row is only reachable if a whole one fits inside the viewport.
          rowFitsViewport: !!firstRow && firstRow.getBoundingClientRect().height > 0
            && firstRow.getBoundingClientRect().height <= list.clientHeight + 0.5,
          rowDebug: firstRow
            ? { h: firstRow.getBoundingClientRect().height, cls: firstRow.className }
            : 'NO VISIBLE ROW',
          visibleRows: visibleRows.length,
          hOverflow: document.documentElement.scrollWidth > innerWidth
        };
      })()`);

      const usable = (view, expectedHeight) =>
        // The case is only meaningful at the size it claims to test.
        (expectedHeight === undefined || view.viewport === expectedHeight)
        && view.accounts.height >= 28
        && view.footer.top >= 0 && view.footer.bottom <= view.viewport + 0.5
        && view.scrolls && view.rowFitsViewport && !view.hOverflow
        && (view.graph.display === 'none'
            || (view.canvas.height > 0
                && view.canvas.bottom <= view.graph.bottom + 1
                && view.graph.bottom <= view.viewport + 0.5));

      const storedGraphPref = async () =>
        (await probe.webContents.executeJavaScript('window.electronAPI.getSettings()')).graphVisible;

      // Turning the graph on writes the preference through _saveViewState(),
      // which is debounced. The baseline for "suppression never changes the
      // stored preference" has to be taken after that write has landed, or the
      // comparison measures this test's own click instead of the behaviour
      // under test. Bounded, so a write that never lands fails rather than
      // hanging.
      const storedPrefSettled = async (expected, budgetMs = 4000) => {
        const deadline = Date.now() + budgetMs;
        let stored = await storedGraphPref();
        while (stored !== expected && Date.now() < deadline) {
          await sleep(80);
          stored = await storedGraphPref();
        }
        return stored;
      };

      // Wait until the layout STOPS MOVING, then measure. Deliberately neutral:
      // it does not wait for the assertion to pass, so a layout that settles on
      // a wrong answer still fails. A guessed sleep is what let an intermediate
      // frame be measured as if it were the final one.
      const fingerprint = (view) => [
        view.viewport, view.banner.height, view.graph.display,
        view.graph.height, view.accounts.height
      ].join('|');

      const settled = async (describe, budgetMs = 4000) => {
        const deadline = Date.now() + budgetMs;
        let view = await layoutOf();
        let mark = fingerprint(view);
        let stableFor = 0;
        while (Date.now() < deadline) {
          await sleep(60);
          const next = await layoutOf();
          const nextMark = fingerprint(next);
          view = next;
          if (nextMark === mark) {
            // Two consecutive identical frames: nothing is still animating.
            if (++stableFor >= 2) return view;
          } else {
            stableFor = 0;
            mark = nextMark;
          }
        }
        console.log(`[status-smoke] (never settled) ${describe}:`, JSON.stringify(mark));
        return view;
      };

      for (const height of [320, 340]) {
        // Graph on, banner down, window parked at this height.
        updateOffered = false;
        await resizeChecked(640, height, `banner sweep at 640x${height}`);
        await mainWin.webContents.executeJavaScript(
          "(() => { elements.updateBanner.style.display = 'none'; if (!graphVisible) elements.graphBtn.click(); })()"
        );
        const before = await settled(`pre-banner state at ${height}`);
        // Baseline taken only once the graph-on preference has been persisted.
        const prefBefore = await storedPrefSettled(true);
        record(
          `the graph preference is on and saved before the banner test at 640x${height}`,
          before.pref === true && prefBefore === true,
          `inMemory=${before.pref} stored=${prefBefore}`
        );
        console.log(`[status-smoke] (diag ${height}) before:`, JSON.stringify({
          banner: before.banner, graph: before.graph, accounts: before.accounts.height,
          pref: before.pref, suppressed: before.suppressed
        }));

        // Banner appears with NO resize and NO click.
        updateOffered = true;
        await mainWin.webContents.executeJavaScript('checkForUpdate()');
        const shown = await settled(`banner shown at ${height}`);

        record(
          `banner appearing at 640x${height} keeps the account list usable`,
          // before.banner === 0 keeps the comparison meaningful: a stray banner
          // in the "before" state would make the rest of it meaningless.
          before.banner.height === 0 && shown.banner.height > 0 && usable(shown, height),
          `viewport=${shown.viewport} (expected ${height}) banner=${shown.banner.height} accounts=${shown.accounts.height} footer=${shown.footer.bottom}/${shown.viewport} graph=${shown.graph.display} canvas=${shown.canvas.height} scrolls=${shown.scrolls} rowFits=${shown.rowFitsViewport} hOverflow=${shown.hOverflow} clientH=${shown.accounts.clientHeight} scrollH=${shown.accounts.scrollHeight} rowDebug=${JSON.stringify(shown.rowDebug)} visibleRows=${shown.visibleRows}`
        );
        record(
          `banner appearing at 640x${height} does not change the graph preference`,
          shown.pref === true && (await storedGraphPref()) === prefBefore,
          `pref=${shown.pref} suppressed=${shown.suppressed} stored=${await storedGraphPref()} (was ${prefBefore})`
        );

        // Dismissing it gives the height back, again with no resize.
        updateOffered = false;
        await mainWin.webContents.executeJavaScript(
          "document.getElementById('updateBannerDismiss').click()"
        );
        const dismissed = await settled(`banner dismissed at ${height}`);
        record(
          `banner dismissal at 640x${height} restores the layout without a resize`,
          dismissed.banner.height === 0 && usable(dismissed, height)
            && dismissed.accounts.height >= before.accounts.height - 1
            && dismissed.graph.display === before.graph.display,
          `accounts ${before.accounts.height} -> ${shown.accounts.height} -> ${dismissed.accounts.height}, graph ${before.graph.display} -> ${shown.graph.display} -> ${dismissed.graph.display}, dismissed: canvas=${dismissed.canvas.height} canvasBottom=${dismissed.canvas.bottom} graphBottom=${dismissed.graph.bottom} viewport=${dismissed.viewport} scrolls=${dismissed.scrolls} rowFits=${dismissed.rowFitsViewport}`
        );
        record(
          `banner dismissal at 640x${height} does not change the graph preference`,
          dismissed.pref === true && (await storedGraphPref()) === prefBefore,
          `pref=${dismissed.pref} stored=${await storedGraphPref()} (was ${prefBefore})`
        );
      }

      // Back to a normal window with the graph off, banner hidden. The gated
      // handler stays installed and reports no update, so the timer scheduled by
      // any later renderer load cannot resurrect the banner.
      updateOffered = false;
      await mainWin.webContents.executeJavaScript(
        "(() => { elements.updateBanner.style.display = 'none'; if (graphVisible) elements.graphBtn.click(); })()"
      );
      await resizeChecked(640, 560, 'after the banner sweep');
      await sleep(250);
    } else {
      record('the update-banner relayout could be measured', false, 'no renderer window');
    }

    // ── 17. Settings switches: visible keyboard focus and Space ──────────
    //
    // The defect being locked out: each switch's checkbox is invisible
    // (opacity 0, zero size) so the pill can be styled, and the focus ring was
    // landing on that invisible input — :focus-visible matched, but nothing on
    // screen changed. The ring has to be on the slider the user can see.
    //
    // Nothing here is allowed to persist: settings are only written by the
    // Done button, so this never clicks it, restores every switch it flips and
    // then checks the stored settings are byte-identical. No real OS startup
    // or taskbar preference is touched.
    if (mainWin && !mainWin.isDestroyed()) {
      const SWITCH_IDS = ['autoStartToggle', 'minimizeToTrayToggle', 'alwaysOnTopToggle',
                          'showTrayStatsToggle', 'usageAlertsToggle'];

      await resizeChecked(480, 700, 'settings panel');

      // Section 15 turned the graph off, and _saveViewState() is debounced, so
      // that write can still be in flight. Taking the "settings unchanged"
      // baseline before it lands makes this suite's own click look like a
      // change made by the switch checks — which is exactly what it did.
      const graphOffLanded = await (async () => {
        const deadline = Date.now() + 4000;
        let pref = null;
        while (Date.now() < deadline) {
          pref = (await probe.webContents.executeJavaScript('window.electronAPI.getSettings()')).graphVisible;
          const inMemory = await mainWin.webContents.executeJavaScript('graphVisible');
          if (pref === inMemory) return { pref, inMemory, settled: true };
          await sleep(60);
        }
        return { pref, settled: false };
      })();
      record(
        'precondition: the suite\'s own pending graph-preference write has landed',
        graphOffLanded.settled === true,
        `stored=${graphOffLanded.pref} inMemory=${graphOffLanded.inMemory} — the unchanged-settings baseline is only meaningful once these agree`
      );

      const settingsBefore = await probe.webContents.executeJavaScript('window.electronAPI.getSettings()');

      // Keyboard events need real focus; :focus-visible never matches without
      // it. Asserted, not assumed.
      await ensureRendererInteractive('Settings switch keyboard checks');
      await mainWin.webContents.executeJavaScript("document.getElementById('settingsBtn').click()");
      await sleep(450);
      await mainWin.webContents.executeJavaScript('document.fonts.ready');

      const focusState = () => mainWin.webContents.executeJavaScript(`(() => {
        const el = document.activeElement;
        if (!el) return null;
        const slider = el.nextElementSibling;
        const sliderStyle = slider ? getComputedStyle(slider) : null;
        return {
          id: el.id || null,
          type: el.type || null,
          disabled: !!el.disabled,
          checked: !!el.checked,
          focusVisible: el.matches(':focus-visible'),
          inputOpacity: getComputedStyle(el).opacity,
          inputRect: (() => { const r = el.getBoundingClientRect(); return r.width + 'x' + r.height; })(),
          sliderClass: slider ? slider.className : null,
          sliderOutline: sliderStyle ? sliderStyle.outline : null,
          sliderOutlineWidth: sliderStyle ? sliderStyle.outlineWidth : null,
          sliderOutlineStyle: sliderStyle ? sliderStyle.outlineStyle : null,
          sliderShadow: sliderStyle ? sliderStyle.boxShadow : null,
          // The ring is only useful if the thing wearing it is on screen.
          sliderRect: (() => {
            if (!slider) return null;
            const r = slider.getBoundingClientRect();
            return { w: r.width, h: r.height, onScreen: r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight + 1 };
          })()
        };
      })()`);

      // Start from a known point inside the panel, then Tab until the wanted
      // switch holds focus. Bounded, so a missing switch fails instead of
      // hanging.
      // Tab from a known anchor until the wanted switch holds focus. Each press
      // is confirmed before the next one, so a slow frame cannot make the walk
      // overshoot; the bound is generous enough that only a real failure to
      // reach the switch ends the loop.
      const tabTo = async (id) => {
        await mainWin.webContents.executeJavaScript("document.getElementById('closeSettingsBtn').focus()");
        let last = null;
        for (let i = 0; i < 90; i++) {
          const from = last && last.id;
          mainWin.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
          mainWin.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
          // Wait for focus to actually move off where it was.
          const moveDeadline = Date.now() + 700;
          do {
            await sleep(25);
            last = await focusState();
          } while (last && from && last.id === from && Date.now() < moveDeadline);
          if (last && last.id === id) return last;
        }
        return null;
      };

      // Press Space and wait for the checkbox to report the change, rather than
      // assuming a fixed delay was enough.
      const spaceAndAwaitChecked = async (id, expected, budgetMs = 1500) => {
        mainWin.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
        mainWin.webContents.sendInputEvent({ type: 'char', keyCode: ' ' });
        mainWin.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
        const deadline = Date.now() + budgetMs;
        let checked = null;
        do {
          await sleep(40);
          checked = await mainWin.webContents.executeJavaScript(
            `!!document.getElementById(${JSON.stringify(id)}).checked`
          );
        } while (checked !== expected && Date.now() < deadline);
        return checked;
      };

      // Document focus is requested and RECORDED for every keyboard group, not
      // just once for the section. :focus-visible cannot match while the window
      // has no keyboard focus, so without this a lost-focus run and a real
      // product regression look identical in the log. Each group now states
      // which of the two it was.
      const focusConditions = () => mainWin.webContents.executeJavaScript(
        '({ documentHasFocus: document.hasFocus(), active: document.activeElement && (document.activeElement.id || document.activeElement.tagName) })'
      );

      for (const id of SWITCH_IDS) {
        const preconditions = await (async () => {
          mainWin.show();
          mainWin.focus();
          mainWin.webContents.focus();
          const deadline = Date.now() + 3000;
          let state;
          do {
            await sleep(40);
            state = await focusConditions();
          } while (!state.documentHasFocus && Date.now() < deadline);
          return { windowFocused: mainWin.isFocused(), visible: mainWin.isVisible(), ...state };
        })();
        record(
          `precondition: the window holds keyboard focus for the ${id} switch group`,
          preconditions.documentHasFocus === true && preconditions.visible === true,
          `${JSON.stringify(preconditions)} — if this fails, the assertions below say nothing about the product`
        );

        const focused = await tabTo(id);
        record(
          `Tab reaches the ${id} switch`,
          !!focused && focused.type === 'checkbox' && focused.focusVisible === true,
          focused ? JSON.stringify(focused) : 'never received focus within 60 Tab presses'
        );
        if (!focused) continue;

        // The ring must be on the visible slider, not on the invisible input.
        record(
          `the ${id} switch shows its keyboard focus on the visible slider`,
          focused.sliderClass === 'toggle-slider'
            && focused.sliderOutlineStyle === 'solid'
            && parseFloat(focused.sliderOutlineWidth) > 0
            && focused.sliderRect && focused.sliderRect.onScreen === true,
          `input ${focused.inputRect} opacity=${focused.inputOpacity}; slider outline=${JSON.stringify(focused.sliderOutline)} rect=${JSON.stringify(focused.sliderRect)}`
        );

        // Space must operate it — and put it straight back.
        const wasChecked = focused.checked;
        const checkedAfterSpace = focused.disabled
          ? null
          : await spaceAndAwaitChecked(id, !wasChecked);

        if (checkedAfterSpace === null) {
          record(
            `Space on the ${id} switch changes its state`,
            false,
            'the switch is disabled in this environment, so keyboard operation could not be shown'
          );
        } else {
          record(
            `Space on the ${id} switch changes its state`,
            checkedAfterSpace !== wasChecked,
            `checked ${wasChecked} -> ${checkedAfterSpace}`
          );
          // Put it back, so nothing this test did could ever be saved.
          const restoredChecked = await spaceAndAwaitChecked(id, wasChecked);
          record(
            `the ${id} switch is left exactly as it was found`,
            restoredChecked === wasChecked,
            `checked=${restoredChecked} (was ${wasChecked})`
          );
        }
      }

      // Tabbing on must clear the ring from the switch it left.
      const movedOn = await mainWin.webContents.executeJavaScript(`(() => {
        const el = document.getElementById('usageAlertsToggle');
        const slider = el.nextElementSibling;
        return { focusVisible: el.matches(':focus-visible'),
                 outlineStyle: getComputedStyle(slider).outlineStyle };
      })()`);
      mainWin.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
      mainWin.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
      await sleep(160);
      const afterMove = await mainWin.webContents.executeJavaScript(`(() => {
        const el = document.getElementById('usageAlertsToggle');
        const slider = el.nextElementSibling;
        return { stillFocused: el.matches(':focus-visible'),
                 outlineStyle: getComputedStyle(slider).outlineStyle,
                 nowFocused: document.activeElement && (document.activeElement.id || document.activeElement.tagName) };
      })()`);
      record(
        'moving focus on clears the ring from the switch it left',
        movedOn.outlineStyle === 'solid' && afterMove.stillFocused === false
          && afterMove.outlineStyle === 'none',
        `before=${JSON.stringify(movedOn)} after=${JSON.stringify(afterMove)}`
      );

      // Close the panel WITHOUT the Done button, which is what saves settings
      // (and what would write the OS startup / taskbar preferences).
      await mainWin.webContents.executeJavaScript(
        "document.getElementById('settingsOverlay').style.display = 'none'"
      );
      await resizeChecked(640, 560, 'after the settings checks');
      await sleep(250);
      const settingsAfter = await probe.webContents.executeJavaScript('window.electronAPI.getSettings()');
      record(
        'exercising the switches saved nothing — no OS startup or taskbar preference was written',
        JSON.stringify(settingsAfter) === JSON.stringify(settingsBefore),
        `before=${JSON.stringify(settingsBefore)} after=${JSON.stringify(settingsAfter)}`
      );
    } else {
      record('the Settings switches could be exercised', false, 'no renderer window');
    }

    // ── 17b. Light / dark theme ──────────────────────────────────────────
    //
    // Added at the user's request alongside the completion corrections. Two
    // themes from Microsoft's own VS Code defaults, switched by one button at
    // the bottom of the settings panel.
    //
    // Everything here reads COMPUTED styles from the real renderer, so it
    // measures what is on screen rather than what the stylesheet says, and it
    // goes through the rendered button rather than setting the attribute.
    if (mainWin && !mainWin.isDestroyed()) {
      await resizeChecked(480, 700, 'theme toggle');
      const themeBefore = await probe.webContents.executeJavaScript('window.electronAPI.getSettings()');

      const readTheme = () => mainWin.webContents.executeJavaScript(`(() => {
        const root = document.documentElement;
        const cs = getComputedStyle(root);
        const token = (name) => cs.getPropertyValue(name).trim();
        const btn = document.getElementById('themeToggleBtn');
        const shown = (selector) => {
          const el = document.querySelector(selector);
          return !!el && getComputedStyle(el).display !== 'none';
        };
        const container = document.getElementById('widgetContainer');
        const name = document.querySelector('.account-name');
        return {
          attribute: root.dataset.theme,
          bg: token('--bg'),
          text: token('--text'),
          accent: token('--acc'),
          containerBg: getComputedStyle(container).backgroundColor,
          nameColor: name ? getComputedStyle(name).color : null,
          pressed: btn ? btn.getAttribute('aria-pressed') : null,
          offersLight: shown('.theme-toggle-to-light'),
          offersDark: shown('.theme-toggle-to-dark'),
          sun: shown('.theme-toggle-sun'),
          moon: shown('.theme-toggle-moon')
        };
      })()`);

      const dark = await readTheme();
      record(
        'the widget starts in the Dark Modern theme',
        dark.attribute === 'dark' && dark.bg === '#1F1F1F' && dark.text === '#CCCCCC'
          && dark.containerBg === 'rgb(31, 31, 31)',
        `attribute=${dark.attribute} --bg=${dark.bg} container=${dark.containerBg}`
      );
      record(
        'and the toggle offers the light theme, with the sun icon',
        dark.offersLight === true && dark.offersDark === false
          && dark.sun === true && dark.moon === false && dark.pressed === 'false',
        `offersLight=${dark.offersLight} sun=${dark.sun} pressed=${dark.pressed}`
      );

      // Through the rendered control, not by setting the attribute.
      await mainWin.webContents.executeJavaScript(`(() => {
        document.getElementById('settingsBtn').click();
        return true;
      })()`);
      await sleep(400);
      await mainWin.webContents.executeJavaScript(
        "document.getElementById('themeToggleBtn').click()"
      );
      await sleep(500);

      const light = await readTheme();
      record(
        'clicking the toggle switches the whole widget to the Light Modern theme',
        light.attribute === 'light' && light.bg === '#FFFFFF' && light.text === '#3B3B3B'
          && light.accent === '#005FB8' && light.containerBg === 'rgb(255, 255, 255)',
        `attribute=${light.attribute} --bg=${light.bg} --text=${light.text} container=${light.containerBg}`
      );
      record(
        'the button then offers the dark theme, with the moon icon',
        light.offersDark === true && light.offersLight === false
          && light.moon === true && light.sun === false && light.pressed === 'true',
        `offersDark=${light.offersDark} moon=${light.moon} pressed=${light.pressed}`
      );
      record(
        'account text is repainted for the light theme rather than left dark-on-white',
        light.nameColor === 'rgb(31, 31, 31)' && light.nameColor !== dark.nameColor,
        `dark=${dark.nameColor} light=${light.nameColor}`
      );

      const savedTheme = await probe.webContents.executeJavaScript('window.electronAPI.getSettings()');
      record(
        'the choice is saved as a setting, without saving the rest of the form',
        savedTheme.theme === 'light'
          && JSON.stringify({ ...savedTheme, theme: null }) === JSON.stringify({ ...themeBefore, theme: null }),
        `theme=${savedTheme.theme} otherSettingsUnchanged=`
          + `${JSON.stringify({ ...savedTheme, theme: null }) === JSON.stringify({ ...themeBefore, theme: null })}`
      );

      // A renderer restart: init() runs again, and the theme must already be
      // applied by the pre-paint bootstrap rather than swapped in afterwards.
      mainWin.webContents.reload();
      let afterReload = null;
      try {
        await waitForRenderer(4);
        afterReload = await readTheme();
      } catch (error) {
        record('the renderer restarts with the light theme', false, String(error.message));
      }
      record(
        'the light theme survives a renderer restart and is applied before the first paint',
        !!afterReload && afterReload.attribute === 'light' && afterReload.bg === '#FFFFFF',
        afterReload ? `attribute=${afterReload.attribute} --bg=${afterReload.bg}` : 'renderer never became ready'
      );

      // Back to dark, so every check after this one measures the theme the
      // rest of the suite was written against.
      await mainWin.webContents.executeJavaScript(`(() => {
        document.getElementById('settingsBtn').click();
        return true;
      })()`);
      await sleep(400);
      await mainWin.webContents.executeJavaScript(
        "document.getElementById('themeToggleBtn').click()"
      );
      await sleep(500);
      const backToDark = await readTheme();
      record(
        'switching back returns every token to Dark Modern',
        backToDark.attribute === 'dark' && backToDark.bg === '#1F1F1F'
          && backToDark.text === '#CCCCCC' && backToDark.accent === '#0078D4',
        `attribute=${backToDark.attribute} --bg=${backToDark.bg} --acc=${backToDark.accent}`
      );
      const restoredSettings = await probe.webContents.executeJavaScript('window.electronAPI.getSettings()');
      record(
        'and the stored setting follows it back',
        restoredSettings.theme === 'dark',
        `theme=${restoredSettings.theme}`
      );
      await mainWin.webContents.executeJavaScript(
        "document.getElementById('settingsOverlay').style.display = 'none'"
      );
      await resizeChecked(640, 560, 'after the theme checks');
    } else {
      record('the theme toggle could be exercised', false, 'no renderer window');
    }

    // ── 18. A Claude challenge is a read failure, not a dead login ───────
    //
    // The defect being locked out: CloudflareBlocked, CloudflareChallenge and
    // UnexpectedHTML are recognised from the RESPONSE BODY, and any of them
    // made handleProviderError delete the saved credential and reject with
    // SessionExpired. A Cloudflare challenge is exactly what a VALID session
    // gets when Cloudflare wants to re-verify it, so a single challenge cost
    // the user their login.
    //
    // Everything here goes through the real fetch-usage-data IPC handler, the
    // real error handler and the real account/credential store. Credential
    // retention is read back with the real getAccounts(), never from a helper.
    const TRANSIENT_CLAUDE_ERRORS = ['CloudflareBlocked', 'CloudflareChallenge', 'UnexpectedHTML'];

    const accountsNow = () => probe.webContents.executeJavaScript('window.electronAPI.getAccounts()');
    const hasSessionFor = async (id) => {
      const list = await accountsNow();
      const found = list.find((a) => a.id === id);
      return found ? found.hasSession : null;
    };
    const setManual = (id, manual) => probe.webContents.executeJavaScript(
      `window.electronAPI.saveAccountManual(${JSON.stringify(id)}, ${JSON.stringify(manual)})`
    );
    const goodClaudeReading = (session, weekly) => ({
      five_hour: { utilization: session, resets_at: '2026-09-11T18:00:00Z' },
      seven_day: { utilization: weekly, resets_at: '2026-09-17T18:00:00Z' }
    });

    // A dedicated account, created through the real IPC, so the
    // "no prior successful reading" cases start genuinely clean instead of
    // inheriting an earlier section's reading or manual entry.
    const freshId = await probe.webContents.executeJavaScript('window.electronAPI.createDraftAccount()')
      .then((draft) => (draft && (draft.id || draft)) || null);
    if (freshId) {
      await probe.webContents.executeJavaScript(
        `window.electronAPI.saveAccount(${JSON.stringify({
          id: String(freshId), label: 'Transient Claude', provider: 'claude',
          sessionKey: 'synthetic-transient-key', organizationId: 'smoke-org', organizations: []
        })})`
      );
    }
    record(
      'a clean synthetic Claude account exists for the transient-error table',
      !!freshId && (await hasSessionFor(String(freshId))) === true,
      `id=${freshId} hasSession=${freshId ? await hasSessionFor(String(freshId)) : 'n/a'}`
    );

    // ── Case A: a prior successful reading, no manual fallback ────────────
    // Expected: reading kept as stale, credential kept, lastSuccessAt frozen,
    // no history sample appended, no SessionExpired.
    await setManual('1', null);
    for (const errorCode of TRANSIENT_CLAUDE_ERRORS) {
      claudeResponder = () => goodClaudeReading(44, 61);
      const good = view(await fetchUsage('1'));
      const historyBefore = await history('1');
      const successAt = good.lastSuccessAt;

      claudeResponder = () => { throw new Error(`${errorCode}: <html>Just a moment…</html>`); };
      const failed = view(await fetchUsage('1'));
      const historyAfter = await history('1');
      const stillHasSession = await hasSessionFor('1');

      record(
        `${errorCode} with a prior reading: the credential is kept`,
        stillHasSession === true,
        `hasSession=${stillHasSession} (read back through the real getAccounts)`
      );
      record(
        `${errorCode} with a prior reading: the handler does not reject with SessionExpired`,
        failed.ok === true && !/SessionExpired/.test(String(failed.message)),
        `ok=${failed.ok} message=${failed.message}`
      );
      record(
        `${errorCode} with a prior reading: the previous values are kept and marked stale`,
        failed.status === 'stale' && failed.stale === true
          && failed.slot(ROW_SLOTS.SESSION) === 44 && failed.slot(ROW_SLOTS.WEEKLY) === 61
          && new RegExp(errorCode).test(String(failed.error)),
        `status=${failed.status} session=${failed.slot(ROW_SLOTS.SESSION)} weekly=${failed.slot(ROW_SLOTS.WEEKLY)} error=${failed.error}`
      );
      record(
        `${errorCode} with a prior reading: the last-success time does not move`,
        failed.lastSuccessAt === successAt && typeof successAt === 'number',
        `before=${successAt} after=${failed.lastSuccessAt}`
      );
      record(
        `${errorCode} with a prior reading: no history sample is fabricated`,
        historyAfter.length === historyBefore.length,
        `samples ${historyBefore.length} -> ${historyAfter.length}`
      );

      // ── Recovery on the SAME credential, with no user action ───────────
      claudeResponder = () => goodClaudeReading(47, 62);
      const recovered = view(await fetchUsage('1'));
      record(
        `${errorCode}: a later good response recovers on the existing credential`,
        recovered.ok === true && recovered.status === 'available' && recovered.stale === false
          && recovered.error === null
          && recovered.slot(ROW_SLOTS.SESSION) === 47
          && recovered.lastSuccessAt > successAt
          && (await hasSessionFor('1')) === true,
        `status=${recovered.status} session=${recovered.slot(ROW_SLOTS.SESSION)} at=${recovered.lastSuccessAt} > ${successAt}`
      );
    }

    // ── Case B: no prior successful reading, no manual fallback ───────────
    // Expected: unavailable — never an invented 0% — and the credential kept.
    if (freshId) {
      const id = String(freshId);
      for (const errorCode of TRANSIENT_CLAUDE_ERRORS) {
        claudeResponder = () => { throw new Error(`${errorCode}: <html>challenge</html>`); };
        const first = view(await fetchUsage(id));
        const samples = await history(id);
        record(
          `${errorCode} with no prior reading: unavailable, no invented zero, credential kept`,
          first.ok === true && first.status === 'unavailable'
            && first.rowCount === 0
            && first.slot(ROW_SLOTS.SESSION) === null && first.slot(ROW_SLOTS.WEEKLY) === null
            && first.lastSuccessAt === null
            && samples.length === 0
            && (await hasSessionFor(id)) === true,
          `status=${first.status} rows=${first.rowCount} at=${first.lastSuccessAt} samples=${samples.length} hasSession=${await hasSessionFor(id)}`
        );
      }
      // And it recovers with no user action.
      claudeResponder = () => goodClaudeReading(5, 6);
      const firstGood = view(await fetchUsage(id));
      record(
        'after transient failures, the fresh account reads normally on its original credential',
        firstGood.status === 'available' && firstGood.slot(ROW_SLOTS.SESSION) === 5
          && typeof firstGood.lastSuccessAt === 'number'
          && (await hasSessionFor(id)) === true,
        `status=${firstGood.status} session=${firstGood.slot(ROW_SLOTS.SESSION)}`
      );
    }

    // ── Case C: a manual fallback IS configured ──────────────────────────
    // Expected: the manual entry stands in, clearly marked, credential kept.
    await setManual('1', { enabled: false, used: 12, limit: 100 });
    for (const errorCode of TRANSIENT_CLAUDE_ERRORS) {
      claudeResponder = () => { throw new Error(`${errorCode}: <html>challenge</html>`); };
      const fellBack = view(await fetchUsage('1'));
      record(
        `${errorCode} with a manual fallback: the manual entry stands in, marked, credential kept`,
        fellBack.ok === true && fellBack.source === 'manual' && fellBack.fallback === true
          && fellBack.slot(ROW_SLOTS.SESSION) === 12
          && (await hasSessionFor('1')) === true,
        `source=${fellBack.source} fallback=${fellBack.fallback} session=${fellBack.slot(ROW_SLOTS.SESSION)} hasSession=${await hasSessionFor('1')}`
      );
    }
    await setManual('1', null);

    // ── Case D: ChatGPT AuthRequired is still proof, and still acts ──────
    chatgptResponder = () => { throw new Error('AuthRequired'); };
    const gptAuth = view(await fetchUsage('2'));
    record(
      'ChatGPT AuthRequired still invalidates the credential and rejects with SessionExpired',
      gptAuth.ok === false && /SessionExpired/.test(String(gptAuth.message))
        && (await hasSessionFor('2')) === false,
      `ok=${gptAuth.ok} message=${gptAuth.message} hasSession=${await hasSessionFor('2')}`
    );

    // ── Case E: no non-auth error may invalidate a ChatGPT credential ────
    await probe.webContents.executeJavaScript(
      `window.electronAPI.saveAccount(${JSON.stringify({
        id: '2', label: 'ChatGPT Smoke', provider: 'chatgpt',
        sessionKey: 'synthetic-chatgpt-token', organizations: []
      })})`
    );
    for (const message of ['Request timeout', 'CloudflareChallenge: <html>', 'HTTP 403']) {
      chatgptResponder = () => { throw new Error(message); };
      const soft = view(await fetchUsage('2'));
      record(
        `ChatGPT "${message}" is not treated as proven auth expiry`,
        soft.ok === true && (await hasSessionFor('2')) === true,
        `ok=${soft.ok} status=${soft.status} hasSession=${await hasSessionFor('2')} message=${soft.message}`
      );
    }

    // ── Case F: one account's failures do not touch another ──────────────
    claudeResponder = () => goodClaudeReading(31, 32);
    chatgptResponder = () => ({
      rate_limit: { primary_window: { used_percent: 8, limit_window_seconds: 18000, reset_at: 1789581600 } }
    });
    const isolatedClaude = view(await fetchUsage('1'));
    const isolatedGpt = view(await fetchUsage('2'));
    record(
      'a transient failure on one account leaves the other reading normally',
      isolatedClaude.status === 'available' && isolatedGpt.status === 'available'
        && (await hasSessionFor('1')) === true && (await hasSessionFor('2')) === true,
      `claude=${isolatedClaude.status} chatgpt=${isolatedGpt.status}`
    );

    // ── 19. A missing credential must still offer a way back in ──────────
    //
    // The defect being locked out: the reconnect action was driven by
    // `expiredAccounts`, a Set that only ever lived in the renderer's memory.
    // After a reload — or a restart — an automatic account with no credential
    // showed no way to connect it at all: hasSession stayed false and the
    // button stayed hidden. It is now derived from the saved account, so it
    // survives a reload.
    //
    // Wording is asserted too, because the two states are not the same thing:
    //   proven expired (the provider said AuthRequired) -> "Session expired"
    //   credential simply absent                        -> "Not connected"
    // A missing credential is not proof that a session expired.
    if (mainWin && !mainWin.isDestroyed()) {
      const connectionState = (id) => mainWin.webContents.executeJavaScript(`(() => {
        const card = document.querySelector('.account-block[data-account-id="' + ${JSON.stringify(id)} + '"]');
        if (!card) return { missingCard: true };
        const btn = card.querySelector('.account-reconnect-btn');
        const r = btn.getBoundingClientRect();
        const account = accounts.find((a) => a.id === ${JSON.stringify(id)});
        return {
          hasSession: account ? account.hasSession : null,
          manual: account ? account.manual : null,
          display: getComputedStyle(btn).display,
          visible: r.width > 0 && r.height > 0,
          label: (btn.textContent || '').trim(),
          cardExpiredClass: card.classList.contains('expired'),
          statusChip: (card.querySelector('.account-status-tag').textContent || '').trim(),
          sourceTag: getComputedStyle(card.querySelector('.account-source-tag')).display
        };
      })()`);

      // Account 2's credential was invalidated by the real AuthRequired path in
      // section 18 Case D and then re-saved; drive it dead again so this
      // section starts from a genuine provider-proven expiry.
      chatgptResponder = () => { throw new Error('AuthRequired'); };
      await fetchUsage('2');
      await sleep(200);
      const provenExpired = await connectionState('2');
      // The credential fact comes from the real store; the card state comes
      // from the card. Keeping them separate is the point.
      const provenExpiredCredential = await hasSessionFor('2');
      record(
        'a provider-proven expiry offers Reconnect and says the session expired',
        provenExpiredCredential === false && provenExpired.visible === true
          && /Session expired/i.test(provenExpired.label) && provenExpired.cardExpiredClass === true,
        `storedHasSession=${provenExpiredCredential} card=${JSON.stringify(provenExpired)}`
      );

      // ── The reload that used to lose the way back in ──────────────────
      mainWin.webContents.reload();
      await waitForRenderer(4);
      mainWin.webContents.setBackgroundThrottling(false);
      await ensureRendererInteractive('after the renderer reload');

      const afterReload = await connectionState('2');
      record(
        'after a renderer reload the connection action is still offered',
        afterReload.hasSession === false && afterReload.visible === true
          && afterReload.display === 'inline-flex',
        JSON.stringify(afterReload)
      );
      record(
        'after a renderer reload the wording is truthful — not connected, not "expired"',
        /Not connected/i.test(afterReload.label) && !/expired/i.test(afterReload.label)
          && afterReload.cardExpiredClass === false,
        `label=${JSON.stringify(afterReload.label)} expiredClass=${afterReload.cardExpiredClass}`
      );

      // Account 3 is automatic, has no credential, and has a manual entry that
      // is NOT enabled: it must offer a connection action, and its manual
      // fallback stays visible next to it.
      const fallbackAccount = await connectionState('3');
      record(
        'an automatic account with a manual fallback offers a connection action too',
        fallbackAccount.hasSession === false && fallbackAccount.visible === true
          && /Not connected/i.test(fallbackAccount.label),
        JSON.stringify(fallbackAccount)
      );

      // Account 4 is a manual override: no credential, and no login prompt.
      const manualOnly = await connectionState('4');
      record(
        'a manual-only account stays usable and is never asked to log in',
        manualOnly.hasSession === false && manualOnly.visible === false
          && manualOnly.display === 'none'
          && !!(manualOnly.manual && manualOnly.manual.enabled),
        JSON.stringify(manualOnly)
      );

      // ── Cancelling a reconnect changes nothing ────────────────────────
      const beforeCancel = {
        accounts: await accountsNow(),
        history: await history('1'),
        manual4: (await accountsNow()).find((a) => a.id === '4').manual,
        hasSession1: await hasSessionFor('1')
      };
      await mainWin.webContents.executeJavaScript("reconnectAccount('2')");
      await sleep(300);
      const inFlow = await mainWin.webContents.executeJavaScript(
        "({ login: document.getElementById('loginContainer').style.display, kind: draftFlowKind, draft: !!draftAccount })"
      );
      await mainWin.webContents.executeJavaScript("cancelAddAccount()");
      await sleep(500);
      const afterCancel = {
        accounts: await accountsNow(),
        history: await history('1'),
        manual4: (await accountsNow()).find((a) => a.id === '4').manual,
        hasSession1: await hasSessionFor('1')
      };
      record(
        'a reconnect flow starts for the right account without creating a draft account',
        inFlow.kind === 'reconnect' && inFlow.draft === true
          && beforeCancel.accounts.length === afterCancel.accounts.length,
        `${JSON.stringify(inFlow)} accounts ${beforeCancel.accounts.length} -> ${afterCancel.accounts.length}`
      );
      record(
        'cancelling a reconnect preserves every account, its history, manual settings and credentials',
        afterCancel.accounts.length === beforeCancel.accounts.length
          && afterCancel.history.length === beforeCancel.history.length
          && JSON.stringify(afterCancel.manual4) === JSON.stringify(beforeCancel.manual4)
          && afterCancel.hasSession1 === beforeCancel.hasSession1
          && afterCancel.hasSession1 === true,
        `accounts=${afterCancel.accounts.length} history=${afterCancel.history.length} manual4=${JSON.stringify(afterCancel.manual4)} hasSession1=${afterCancel.hasSession1}`
      );
      const stillOffered = await connectionState('2');
      record(
        'after a cancelled reconnect the account still offers its connection action',
        stillOffered.hasSession === false && stillOffered.visible === true,
        JSON.stringify(stillOffered)
      );

      // ── A successful reconnect clears the connection state ────────────
      await probe.webContents.executeJavaScript(
        `window.electronAPI.saveAccount(${JSON.stringify({
          id: '2', label: 'ChatGPT Smoke', provider: 'chatgpt',
          sessionKey: 'synthetic-chatgpt-token', organizations: []
        })})`
      );
      chatgptResponder = () => ({
        rate_limit: { primary_window: { used_percent: 17, limit_window_seconds: 18000, reset_at: 1789581600 } }
      });
      await mainWin.webContents.executeJavaScript(
        "(async () => { accounts = await window.electronAPI.getAccounts(); renderAccounts(); await fetchAccount('2'); })()"
      );
      await sleep(600);
      const reconnected = await connectionState('2');
      record(
        'a successful reconnect clears the connection action',
        reconnected.hasSession === true && reconnected.visible === false
          && reconnected.display === 'none' && reconnected.cardExpiredClass === false,
        JSON.stringify(reconnected)
      );

      // ── Other accounts kept working throughout ────────────────────────
      claudeResponder = () => goodClaudeReading(23, 24);
      const other = view(await fetchUsage('1'));
      record(
        'the other account kept reading normally through all of this',
        other.status === 'available' && other.slot(ROW_SLOTS.SESSION) === 23
          && (await hasSessionFor('1')) === true,
        `status=${other.status} session=${other.slot(ROW_SLOTS.SESSION)}`
      );
    } else {
      record('the connection-action recovery could be exercised', false, 'no renderer window');
    }

    // ── 20. A reachable way back in, from the Settings account row ───────
    //
    // The defect being locked out: keeping the credential through a Cloudflare
    // challenge (section 18) was correct, but it left the user with no way to
    // re-authenticate at all. hasSession stayed true, so the card action was
    // correctly hidden, and the Settings row offered only Manual and Remove.
    // Re-adding the account was the only route back, and that discards its
    // history. The architect's recovery probe recorded exactly that:
    // reachable=false for all three transient errors.
    //
    // Every check below goes through the RENDERED control — found in the DOM
    // and clicked or keyed — never by calling reconnectAccount().
    if (mainWin && !mainWin.isDestroyed()) {
      // Unrelated background polls would write history and readings underneath
      // the before/after comparisons, so the timer stays off for this section
      // and every step that can restart it turns it off again.
      const quiet = async () => mainWin.webContents.executeJavaScript('stopAutoUpdate()');
      await quiet();
      await ensureRendererInteractive('Settings connection-action checks');
      await resizeChecked(640, 640, 'Settings connection-action checks');

      // Opened with the real Settings button, and waited on until the real
      // loadSettings() has actually rebuilt the list.
      const openSettings = async (budgetMs = 5000) => {
        await mainWin.webContents.executeJavaScript(
          "document.getElementById('settingsBtn').click()"
        );
        const deadline = Date.now() + budgetMs;
        let state = null;
        do {
          await sleep(50);
          state = await mainWin.webContents.executeJavaScript(`(() => ({
            open: getComputedStyle(document.getElementById('settingsOverlay')).display !== 'none',
            rows: document.querySelectorAll('#accountsList .account-row').length
          }))()`);
        } while ((!state.open || state.rows === 0) && Date.now() < deadline);
        return state;
      };
      const closeSettings = () => mainWin.webContents.executeJavaScript(
        "document.getElementById('settingsOverlay').style.display = 'none'"
      );

      // What the user can actually see and press in one account's row.
      const rowState = (id) => mainWin.webContents.executeJavaScript(`(() => {
        const row = document.querySelector('#accountsList .account-row[data-account-id="' + ${JSON.stringify(id)} + '"]');
        if (!row) return { missingRow: true };
        const vis = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
        };
        const btn = row.querySelector('.account-connect-btn');
        const list = document.getElementById('accountsList');
        const name = row.querySelector('.account-label-input');
        return {
          present: !!btn,
          visible: vis(btn),
          label: btn ? (btn.textContent || '').trim() : null,
          hasTitle: !!(btn && btn.title && btn.title.length > 20),
          buttons: [...row.querySelectorAll('button')].filter(vis).map((b) => (b.textContent || '').trim()),
          rowOverflow: row.scrollWidth - row.clientWidth,
          listOverflow: list.scrollWidth - list.clientWidth,
          nameWidth: Math.round(name.getBoundingClientRect().width),
          btnRight: Math.round(btn ? btn.getBoundingClientRect().right : 0),
          rowRight: Math.round(row.getBoundingClientRect().right)
        };
      })()`);

      const cardAction = (id) => mainWin.webContents.executeJavaScript(`(() => {
        const key = ${JSON.stringify(id)};
        const card = document.querySelector('.account-block[data-account-id="' + key + '"]');
        if (!card) return { missingCard: true };
        const btn = card.querySelector('.account-reconnect-btn');
        const r = btn.getBoundingClientRect();
        return {
          status: usageByAccount[key] && usageByAccount[key].status,
          error: usageByAccount[key] && usageByAccount[key].error,
          visible: r.width > 0 && r.height > 0,
          label: (btn.textContent || '').trim()
        };
      })()`);

      // ── A healthy automatic account can still be re-authenticated ─────
      claudeResponder = () => goodClaudeReading(23, 24);
      await mainWin.webContents.executeJavaScript("fetchAccount('1')");
      await sleep(200);
      await openSettings();
      const healthy = await rowState('1');
      record(
        'a healthy automatic account offers a quiet Reconnect in its Settings row',
        healthy.visible === true && healthy.label === 'Reconnect'
          && healthy.hasTitle === true
          && healthy.buttons.join(' | ') === 'Reconnect | Manual | Remove',
        JSON.stringify(healthy)
      );
      await closeSettings();

      // ── The architect's three failing recovery checks ─────────────────
      // Same three errors, same real renderer fetch, same question: with the
      // credential deliberately RETAINED, is there a reachable control?
      for (const errorCode of TRANSIENT_CLAUDE_ERRORS) {
        claudeResponder = () => goodClaudeReading(44, 61);
        await mainWin.webContents.executeJavaScript("fetchAccount('1')");
        claudeResponder = () => { throw new Error(`${errorCode}: <html>Just a moment…</html>`); };
        await mainWin.webContents.executeJavaScript("fetchAccount('1')");
        await sleep(200);
        const card = await cardAction('1');
        await openSettings();
        const row = await rowState('1');
        const kept = await hasSessionFor('1');
        record(
          `REVIEW ${errorCode}: a retained credential has a reachable reconnect control`,
          kept === true && card.status === 'stale' && new RegExp(errorCode).test(String(card.error))
            && row.visible === true && row.label === 'Reconnect',
          `storedHasSession=${kept} card=${JSON.stringify(card)} settingsRow=${JSON.stringify(row)}`
        );
        await closeSettings();
      }

      // ── A first read that never succeeded, credential retained ────────
      // A genuinely clean account, created through the real IPC: no reading has
      // ever landed for it, so this is the unavailable case, not the stale one.
      const firstReadId = await probe.webContents
        .executeJavaScript('window.electronAPI.createDraftAccount()')
        .then((draft) => String((draft && (draft.id || draft)) || ''));
      await probe.webContents.executeJavaScript(
        `window.electronAPI.saveAccount(${JSON.stringify({
          id: firstReadId, label: 'First Read Claude', provider: 'claude',
          sessionKey: 'synthetic-first-read-key', organizationId: 'smoke-org', organizations: []
        })})`
      );
      claudeResponder = () => { throw new Error('CloudflareChallenge: <html>challenge</html>'); };
      const firstRead = view(await fetchUsage(firstReadId));
      await mainWin.webContents.executeJavaScript(
        '(async () => { accounts = await window.electronAPI.getAccounts(); renderAccounts(); })()'
      );
      await quiet();
      await openSettings();
      const firstReadRow = await rowState(firstReadId);
      record(
        'a credential whose very first read failed is unavailable, kept, and reconnectable',
        firstRead.status === 'unavailable' && firstRead.rowCount === 0
          && (await hasSessionFor(firstReadId)) === true
          && firstReadRow.visible === true && firstReadRow.label === 'Reconnect',
        `status=${firstRead.status} rows=${firstRead.rowCount} row=${JSON.stringify(firstReadRow)}`
      );
      await closeSettings();

      // ── A manual fallback standing in still offers Connect ────────────
      claudeResponder = () => { throw new Error('UnexpectedHTML: <html>x</html>'); };
      const fellBack = view(await fetchUsage('3'));
      await openSettings();
      const fallbackRow = await rowState('3');
      record(
        'an account whose manual fallback is standing in still offers a way to connect',
        fellBack.source === 'manual' && fellBack.fallback === true
          && fallbackRow.visible === true && fallbackRow.label === 'Connect',
        `source=${fellBack.source} fallback=${fellBack.fallback} row=${JSON.stringify(fallbackRow)}`
      );

      // ── A manual-only account is never asked to log in ────────────────
      const manualOnlyRow = await rowState('4');
      record(
        'a manual-only account is offered no login action in Settings',
        manualOnlyRow.present === true && manualOnlyRow.visible === false
          && manualOnlyRow.buttons.join(' | ') === 'Manual | Remove',
        JSON.stringify(manualOnlyRow)
      );
      await closeSettings();

      // ── The control survives a renderer reload ────────────────────────
      mainWin.webContents.reload();
      await waitForRenderer(4);
      mainWin.webContents.setBackgroundThrottling(false);
      await ensureRendererInteractive('after the renderer reload (Settings action)');
      await quiet();
      await openSettings();
      const afterReload = await rowState('1');
      const manualAfterReload = await rowState('4');
      record(
        'after a renderer reload the Settings connection action is still offered',
        afterReload.visible === true && afterReload.label === 'Reconnect'
          && manualAfterReload.visible === false,
        `account1=${JSON.stringify(afterReload)} manualOnly=${JSON.stringify(manualAfterReload)}`
      );

      // ── Compact widths: the control is reachable, nothing overflows ───
      for (const width of [480, 640, 800]) {
        await closeSettings();
        await resizeChecked(width, 640, `Settings connection action at ${width}px`);
        await openSettings();
        const at = await rowState('1');
        record(
          `at ${width}px the connection action is visible inside its row with no horizontal overflow`,
          at.visible === true && at.rowOverflow <= 0 && at.listOverflow <= 0
            && at.btnRight <= at.rowRight && at.nameWidth >= 80,
          JSON.stringify(at)
        );
      }
      await resizeChecked(640, 640, 'after the width sweep');
      await openSettings();

      // ── Keyboard: Tab reaches it, and Enter activates it ──────────────
      const connectFocus = () => mainWin.webContents.executeJavaScript(`(() => {
        const el = document.activeElement;
        if (!el) return { none: true };
        const row = el.closest && el.closest('.account-row');
        return {
          isConnect: el.classList.contains('account-connect-btn'),
          accountId: row ? row.dataset.accountId : null,
          text: (el.textContent || '').trim(),
          focusVisible: el.matches(':focus-visible'),
          outlineStyle: getComputedStyle(el).outlineStyle,
          outlineWidth: getComputedStyle(el).outlineWidth
        };
      })()`);
      await mainWin.webContents.executeJavaScript(
        "document.getElementById('closeSettingsBtn').focus()"
      );
      let focused = null;
      for (let i = 0; i < 90; i++) {
        mainWin.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
        mainWin.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
        await sleep(45);
        focused = await connectFocus();
        if (focused && focused.isConnect === true && focused.accountId === '1') break;
      }
      record(
        'Tab reaches the connection action and it shows a visible focus ring',
        !!focused && focused.isConnect === true && focused.accountId === '1'
          && focused.focusVisible === true && focused.outlineStyle === 'solid'
          && parseFloat(focused.outlineWidth) >= 1,
        focused ? JSON.stringify(focused) : 'never received focus within 90 Tab presses'
      );
      if (process.env.PHASE41_OUTPUT) {
        await mainWin.webContents.executeJavaScript('document.fonts.ready');
        fs.writeFileSync(
          path.join(process.env.PHASE41_OUTPUT, 'settings-connect-keyboard-focus.png'),
          (await mainWin.webContents.capturePage()).toPNG()
        );
      }

      // Enter on the focused control must start the flow, exactly like a click.
      mainWin.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
      mainWin.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
      mainWin.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
      await sleep(500);
      const viaKeyboard = await mainWin.webContents.executeJavaScript(`({
        kind: draftFlowKind,
        draftId: draftAccount && draftAccount.id,
        login: getComputedStyle(document.getElementById('loginContainer')).display,
        settingsCovering: getComputedStyle(document.getElementById('settingsOverlay')).display !== 'none'
      })`);
      record(
        'activating the connection action from the keyboard starts the reconnect flow',
        viaKeyboard.kind === 'reconnect' && viaKeyboard.draftId === '1'
          && viaKeyboard.login !== 'none' && viaKeyboard.settingsCovering === false,
        JSON.stringify(viaKeyboard)
      );
      await mainWin.webContents.executeJavaScript(
        "document.getElementById('loginCancelBtn').click()"
      );
      await sleep(700);
      await quiet();

      // ── Clicking the rendered control, and cancelling from its button ─
      //
      // Cancelling resumes normal operation, which polls every account. Those
      // polls are unrelated to what is being measured, so both readers are held
      // in a transient failure for the comparison: a failed read writes no
      // history and keeps its credential (section 18), which isolates the
      // before/after without disabling any product code.
      //
      // The comparison is the whole of both accounts: identity, partition,
      // credential presence, manual configuration and the COMPLETE history
      // array — not a length. Raw keys never leave main: getAccounts() reports
      // hasSession, never the credential itself.
      claudeResponder = () => { throw new Error('Request timeout'); };
      chatgptResponder = () => { throw new Error('Request timeout'); };

      const snapshot = async () => {
        const list = await accountsNow();
        const out = { count: list.length, ids: list.map((a) => a.id).join(',') };
        for (const id of ['1', '2']) {
          const a = list.find((x) => x.id === id) || {};
          out[id] = {
            id: a.id, label: a.label, provider: a.provider, orgId: a.orgId,
            partition: a.partition, hasSession: a.hasSession,
            manual: a.manual === undefined ? null : a.manual,
            // The exact credential, as a digest. hasSession would still be true
            // if a cancel had silently swapped the key for a different one, so
            // the byte-identical comparison below covers the VALUE, not just
            // its presence. The plaintext never appears in a message.
            credential: storedCredential(id),
            history: await history(id)
          };
        }
        return out;
      };

      await openSettings();
      const beforeCancel = await snapshot();
      await mainWin.webContents.executeJavaScript(
        "document.querySelector('#accountsList .account-row[data-account-id=\"1\"] .account-connect-btn').click()"
      );
      await sleep(400);
      const started = await mainWin.webContents.executeJavaScript(`({
        kind: draftFlowKind,
        draftId: draftAccount && draftAccount.id,
        provider: draftProvider,
        login: getComputedStyle(document.getElementById('loginContainer')).display,
        settingsCovering: getComputedStyle(document.getElementById('settingsOverlay')).display !== 'none',
        cancelVisible: getComputedStyle(document.getElementById('loginCancelBtn')).display !== 'none',
        step1: getComputedStyle(document.getElementById('loginStep1')).display !== 'none'
      })`);
      record(
        'clicking the rendered control starts a reconnect for that account, and Settings gets out of the way',
        started.kind === 'reconnect' && started.draftId === '1' && started.provider === 'claude'
          && started.login !== 'none' && started.settingsCovering === false
          && started.cancelVisible === true && started.step1 === true,
        JSON.stringify(started)
      );

      await mainWin.webContents.executeJavaScript(
        "document.getElementById('loginCancelBtn').click()"
      );
      await sleep(1200);
      await quiet();
      const afterCancel = await snapshot();
      record(
        'cancelling from the real button leaves the affected account and its neighbour byte-identical',
        JSON.stringify(afterCancel) === JSON.stringify(beforeCancel),
        `before=${JSON.stringify(beforeCancel)} after=${JSON.stringify(afterCancel)}`
      );
      record(
        'cancelling a reconnect preserves the exact credential of the target account and its neighbour',
        afterCancel['1'].credential.mode === 'encrypted'
          && afterCancel['1'].credential.digest === beforeCancel['1'].credential.digest
          && afterCancel['2'].credential.mode === 'encrypted'
          && afterCancel['2'].credential.digest === beforeCancel['2'].credential.digest,
        `acct1 ${beforeCancel['1'].credential.mode} digest unchanged=${afterCancel['1'].credential.digest === beforeCancel['1'].credential.digest};`
        + ` acct2 digest unchanged=${afterCancel['2'].credential.digest === beforeCancel['2'].credential.digest}`
        + ' (HMAC digests compared; no key is read out)'
      );
      await openSettings();
      const stillThere = await rowState('1');
      record(
        'after a cancelled reconnect the control is still there and still says Reconnect',
        stillThere.visible === true && stillThere.label === 'Reconnect'
          && (await hasSessionFor('1')) === true,
        JSON.stringify(stillThere)
      );

      // ── A successful reconnect through the real renderer save path ────
      //
      // Driven entirely through rendered controls: the Settings action, the
      // "Manual →" step, the session-key field and Connect. Only the provider
      // validation is mocked, at the same module seam the usage reader is
      // mocked at. ChatGPT stays in its transient failure so the neighbouring
      // account's history cannot move for an unrelated reason.
      const beforeSave = await snapshot();
      claudeOrgResponder = () => ([
        { uuid: 'smoke-org', name: 'Smoke Org', capabilities: ['chat'] }
      ]);
      claudeResponder = () => goodClaudeReading(19, 29);
      await mainWin.webContents.executeJavaScript(
        "document.querySelector('#accountsList .account-row[data-account-id=\"1\"] .account-connect-btn').click()"
      );
      await sleep(400);
      await mainWin.webContents.executeJavaScript("document.getElementById('nextStepBtn').click()");
      await sleep(250);
      const onKeyStep = await mainWin.webContents.executeJavaScript(`({
        step2: getComputedStyle(document.getElementById('loginStep2')).display !== 'none',
        connectEnabled: !document.getElementById('connectBtn').disabled
      })`);
      await mainWin.webContents.executeJavaScript(
        "document.getElementById('sessionKeyInput').value = 'synthetic-reconnected-key'"
      );
      await mainWin.webContents.executeJavaScript("document.getElementById('connectBtn').click()");

      // Wait for the real save path to hand the widget back AND for the poll it
      // starts to land the new reading, rather than assuming a fixed delay.
      const saveDeadline = Date.now() + 15000;
      let backToWidget = null;
      do {
        await sleep(100);
        backToWidget = await mainWin.webContents.executeJavaScript(`({
          login: getComputedStyle(document.getElementById('loginContainer')).display,
          main: getComputedStyle(document.getElementById('mainContent')).display,
          error: (document.getElementById('sessionKeyError').textContent || '').trim(),
          session: (() => {
            const u = usageByAccount['1'];
            if (!u || !Array.isArray(u.rows)) return null;
            const row = u.rows.find((r) => r && r.key === 'session');
            return row ? row.utilization : null;
          })()
        })`);
      } while (
        (backToWidget.login !== 'none' || backToWidget.session !== 19)
        && !backToWidget.error && Date.now() < saveDeadline
      );
      await quiet();
      const afterSave = await snapshot();
      const reconnectedStatus = await mainWin.webContents.executeJavaScript(
        "(usageByAccount['1'] && usageByAccount['1'].status) || null"
      );

      record(
        'the reconnect flow reaches its session-key step through rendered controls only',
        onKeyStep.step2 === true && onKeyStep.connectEnabled === true,
        JSON.stringify(onKeyStep)
      );
      record(
        'a successful reconnect saves through the real path with no duplicate account',
        backToWidget.login === 'none' && backToWidget.error === ''
          && afterSave.count === beforeSave.count && afterSave.ids === beforeSave.ids,
        `login=${backToWidget.login} error=${JSON.stringify(backToWidget.error)} ids ${beforeSave.ids} -> ${afterSave.ids}`
      );
      record(
        'the reconnected account keeps its identity, credential, manual settings and whole history',
        afterSave['1'].id === '1' && afterSave['1'].label === beforeSave['1'].label
          && afterSave['1'].provider === 'claude' && afterSave['1'].orgId === 'smoke-org'
          && afterSave['1'].partition === beforeSave['1'].partition
          && afterSave['1'].hasSession === true
          && JSON.stringify(afterSave['1'].manual) === JSON.stringify(beforeSave['1'].manual)
          && afterSave['1'].history.length >= beforeSave['1'].history.length
          && JSON.stringify(afterSave['1'].history.slice(0, beforeSave['1'].history.length))
             === JSON.stringify(beforeSave['1'].history),
        `id=${afterSave['1'].id} orgId=${afterSave['1'].orgId} partition=${afterSave['1'].partition} hasSession=${afterSave['1'].hasSession} history ${beforeSave['1'].history.length} -> ${afterSave['1'].history.length}`
      );
      record(
        'the reconnected account reads again straight away',
        reconnectedStatus === 'available' && backToWidget.session === 19,
        `status=${reconnectedStatus} session=${backToWidget.session}`
      );
      record(
        'the saved credential is exactly the key that was typed, and no longer the previous one',
        afterSave['1'].credential.mode === 'encrypted'
          && afterSave['1'].credential.digest === credentialDigestOf('synthetic-reconnected-key')
          && afterSave['1'].credential.digest !== beforeSave['1'].credential.digest,
        `matchesTypedKey=${afterSave['1'].credential.digest === credentialDigestOf('synthetic-reconnected-key')}`
        + ` changed=${afterSave['1'].credential.digest !== beforeSave['1'].credential.digest}`
        + ' (HMAC digests compared; no key is read out)'
      );
      record(
        'the neighbour’s exact credential is untouched by that save',
        afterSave['2'].credential.mode === 'encrypted'
          && afterSave['2'].credential.digest === beforeSave['2'].credential.digest,
        `acct2 digest unchanged=${afterSave['2'].credential.digest === beforeSave['2'].credential.digest}`
      );
      record(
        'the replacement credential really went through the validated flow',
        validationUrls.length > 0
          && validationUrls.every((url) => url === 'https://claude.ai/api/organizations'),
        `${validationUrls.length} validation call(s) to the mocked org endpoint; no key is ever logged, getAccounts reports hasSession only`
      );
      record(
        'the other account was untouched by the whole reconnect',
        JSON.stringify(afterSave['2']) === JSON.stringify(beforeSave['2']),
        `before=${JSON.stringify(beforeSave['2'])} after=${JSON.stringify(afterSave['2'])}`
      );

      await openSettings();
      const afterSaveRow = await rowState('1');
      record(
        'after a successful reconnect the Settings action truthfully says Reconnect',
        afterSaveRow.visible === true && afterSaveRow.label === 'Reconnect',
        JSON.stringify(afterSaveRow)
      );

      if (process.env.PHASE41_OUTPUT) {
        for (const width of [480, 640, 800]) {
          await closeSettings();
          await resizeChecked(width, 640, `capture at ${width}px`);
          await openSettings();
          fs.writeFileSync(
            path.join(process.env.PHASE41_OUTPUT, `settings-connect-${width}.png`),
            (await mainWin.webContents.capturePage()).toPNG()
          );
        }
        await resizeChecked(640, 640, 'after the captures');
      }
      await closeSettings();

      // ── Turning the manual override off asks for a login; on removes it ─
      //
      // The row is kept in step without rebuilding the list, because the list
      // is only rebuilt when Settings reopens and the manual editor is open
      // underneath the row the user just changed. Both directions are driven
      // through the real editor controls.
      const setManualOverride = async (id, enabled) => {
        await mainWin.webContents.executeJavaScript(`(() => {
          const row = document.querySelector('#accountsList .account-row[data-account-id="' + ${JSON.stringify(id)} + '"]');
          const editor = row.nextElementSibling;
          if (editor.style.display === 'none') row.querySelector('.account-manual-btn').click();
          const check = editor.querySelector('.account-manual-enabled input');
          if (check.checked !== ${enabled ? 'true' : 'false'}) check.click();
          const numbers = editor.querySelectorAll('.account-manual-inputs input');
          numbers[0].value = '30';
          numbers[1].value = '100';
          editor.querySelector('.account-manual-save').click();
        })()`);
        await sleep(700);
        await quiet();
      };

      await openSettings();
      await setManualOverride('4', false);
      const overrideOff = await rowState('4');
      await setManualOverride('4', true);
      const overrideOn = await rowState('4');
      record(
        'turning a manual override off offers a login, and turning it back on withdraws it',
        overrideOff.visible === true && overrideOff.label === 'Connect'
          && overrideOn.visible === false,
        `off=${JSON.stringify(overrideOff)} on=${JSON.stringify(overrideOn)}`
      );
      const manualIntact = (await accountsNow()).find((a) => a.id === '4');
      record(
        'the manual numbers survive both toggles',
        !!manualIntact && manualIntact.manual && manualIntact.manual.enabled === true
          && manualIntact.manual.used === 30 && manualIntact.manual.limit === 100,
        JSON.stringify(manualIntact && manualIntact.manual)
      );
      await closeSettings();

      // ── The startup-registration guard sat on the live path ──────────
      // The suite really did save preferences (directly and through the graph
      // preference), and every one of those saves went to the interception
      // rather than the user's Run key.
      if (process.platform === 'linux') {
        // Electron's setLoginItemSettings does nothing on Linux, so the app
        // writes an XDG autostart entry instead. The equivalent proof is that
        // no entry reached the real home directory: XDG_CONFIG_HOME points
        // into this suite's own profile, and the real one must be untouched.
        const realAutostart = path.join(
          process.env.REAL_HOME || os.homedir(), '.config', 'autostart');
        const strayEntries = fs.existsSync(realAutostart)
          ? fs.readdirSync(realAutostart).filter((f) => /usage|monitor|claude/i.test(f))
          : [];
        record(
          'the suite registered nothing for startup in the real home directory',
          loginItemGuard.installed === true && strayEntries.length === 0,
          `installed=${loginItemGuard.installed} strayEntries=${strayEntries.join(', ') || 'none'}`
            + ` (Linux uses XDG autostart, not setLoginItemSettings)`
        );
      } else {
        record(
          'the suite\u2019s real preference saves went to the intercepted startup setter, never the OS',
          loginItemGuard.installed === true && loginItemGuard.calls.length > 0
            && loginItemGuard.calls.every((c) => c && c.openAtLogin === false),
          `intercepted ${loginItemGuard.calls.length} call(s), all openAtLogin=false`
        );
      }
    } else {
      record('the Settings connection action could be exercised', false, 'no renderer window');
    }

    const failed = results.filter((r) => !r.ok).length;
    console.log(`[status-smoke] ${results.length - failed}/${results.length} passed`);
    app.exit(failed ? 1 : 0);
  } catch (err) {
    console.error('[status-smoke] fatal:', err);
    app.exit(2);
  }
});
