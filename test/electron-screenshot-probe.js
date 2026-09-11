// Responsive design captures of the REAL widget, on a synthetic profile.
//
// Run with: npm run test:electron:screens -- <outputDir>
//           (or: electron test/electron-screenshot-probe.js <outputDir>)
//
// This is not a pass/fail suite. It boots the real main.js and the real
// renderer against a seeded synthetic profile with mocked provider reads, then
// captures every state the design has to hold up in: the widget at 480/640/800
// widths, a short window, the settings overlay, onboarding (including the
// manual-only route), the reconnect/unavailable card states, the graph, the
// update banner, the configuration banner and keyboard focus.
//
// It writes a manifest next to the PNGs recording the exact window geometry and
// device scale factor for each capture, so a screenshot can never be presented
// as a size it was not taken at.
//
// It also records a MEASURED design audit, because an image is not evidence
// about type or spacing - two different fonts can look similar at 11px in a
// PNG, and "compact" is not something an eye can check against a number. The
// audit reports:
//
//   * the actual PLATFORM fonts Chromium resolved for each kind of text, read
//     through the DevTools protocol (CSS.getPlatformFontsForNode). A computed
//     `font-family` only says what was asked for; this says which face was
//     used and for how many glyphs, which is the only way to tell that the
//     account metadata is rendering in the same face as everything around it.
//   * font sizes, weights and row geometry for the compact-layout rules.
//   * the keyboard focus ring, taken from a control that really has focus.
//   * whether the footer and the graph are visible and inside the viewport at
//     the sizes where they have to be.
//
// Every state is captured in both themes.
//
// No real profile, no network, no credential is ever printed.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT_DIR = process.argv[2] || path.join(os.tmpdir(), `usage-screens-${process.pid}`);
fs.mkdirSync(OUT_DIR, { recursive: true });

// ── Isolate every path before Electron or main.js can touch one ───────────
const isolatedRoot = path.join(os.tmpdir(), `usage-screens-profile-${process.pid}`);
fs.mkdirSync(isolatedRoot, { recursive: true });
process.env.APPDATA = isolatedRoot;
process.env.XDG_CONFIG_HOME = path.join(isolatedRoot, 'xdg-config');
process.env.XDG_DATA_HOME = path.join(isolatedRoot, 'xdg-data');

const configDir = path.join(isolatedRoot, 'claude-usage-widget');
fs.mkdirSync(configDir, { recursive: true });

const now = Date.now();
const history = (base) => Array.from({ length: 24 }, (_, i) => ({
  timestamp: now - (23 - i) * 3600 * 1000,
  session: i === 9 ? null : Math.max(0, Math.min(100, base + Math.round(18 * Math.sin(i / 2.4)))),
  weekly: Math.max(0, Math.min(100, Math.round(base * 0.8) + i))
}));

fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
  accounts: [
    { id: '1', label: 'Personal', provider: 'claude', orgId: 'org-personal', organizations: [], manual: null },
    { id: '2', label: 'Work', provider: 'chatgpt', organizations: [], manual: { enabled: false, used: 40, limit: 200 } },
    { id: '3', label: 'A deliberately long account name for layout', provider: 'claude', orgId: 'org-long', organizations: [], manual: { enabled: true, used: 128, limit: 300 } }
  ],
  accountSeq: 3,
  // Synthetic credentials, written in the legacy plaintext location on
  // purpose: the credential store migrates them into encrypted storage on the
  // first read, so the healthy captures below show a genuinely connected
  // account rather than a hand-forced UI state. Account 3 has none - it is
  // manual-only.
  account_1_sessionKey: 'synthetic-claude-key-for-screenshots',
  account_2_sessionKey: 'synthetic-chatgpt-key-for-screenshots',
  usageHistory_acct_1: history(46),
  usageHistory_acct_2: history(72),
  usageHistory_acct_3: history(30),
  settings: {
    alwaysOnTop: true, minimizeToTray: false, showTrayStats: false,
    usageAlerts: false, timeFormat: '24h', weeklyDateFormat: 'date',
    refreshInterval: 300, graphVisible: false
  },
  windowBounds: { x: 80, y: 80, width: 640, height: 520 }
}, null, 2));

const { app: electronApp } = require('electron');
electronApp.setPath('userData', configDir);
electronApp.setPath('appData', isolatedRoot);
electronApp.setPath('home', isolatedRoot);

// Never register the real user's machine for startup.
electronApp.setLoginItemSettings = () => {};

// ── Mocked provider reads, so nothing leaves this machine ─────────────────
const fetchViaWindowModule = require('../src/fetch-via-window');
fetchViaWindowModule.fetchMultipleViaWindow = async () => ([{
  five_hour: { utilization: 46, resets_at: new Date(now + 2 * 3600 * 1000).toISOString() },
  seven_day: { utilization: 71, resets_at: new Date(now + 3 * 86400 * 1000).toISOString() }
}]);
fetchViaWindowModule.fetchViaWindow = async () => { throw new Error('NoValidationExpected'); };

const providersModule = require('../src/providers');
providersModule.fetchChatGPTUsageData = async () => providersModule.normalizeChatGPTUsage({
  plan_type: 'plus',
  rate_limit: {
    primary_window: { used_percent: 88, limit_window_seconds: 18000, reset_at: Math.floor(now / 1000) + 5400 },
    secondary_window: { used_percent: 97, limit_window_seconds: 604800, reset_at: Math.floor(now / 1000) + 4 * 86400 }
  }
});

// -- Arming a real partial removal for the last two captures --------------
//
// The removal-failure notice has to be photographed as the app actually
// renders it, so nothing here fakes the renderer. One key's durable delete is
// refused on the real electron-store class before main.js builds one; the
// flag below is off until the capture that needs it.
let historyDeleteFails = false;
{
  const StoreClass = require('electron-store');
  const realStoreDelete = StoreClass.prototype.delete;
  StoreClass.prototype.delete = function patchedDelete(key) {
    if (historyDeleteFails && key === 'usageHistory_acct_3') {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    }
    return realStoreDelete.call(this, key);
  };
}

require('../main.js');

const { app, BrowserWindow, ipcMain } = require('electron');

// The renderer schedules an update check 2s after load; answer it locally.
let updateOffered = false;
ipcMain.removeHandler('check-for-update');
ipcMain.handle('check-for-update', () => (updateOffered ? { hasUpdate: true, version: '99.0.0' } : { hasUpdate: false }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const manifest = [];

async function waitForRenderer(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = 'no index.html window';
  while (Date.now() < deadline) {
    const win = BrowserWindow.getAllWindows().find(
      (w) => !w.isDestroyed() && w.webContents.getURL().includes('index.html')
    );
    if (win && !win.webContents.isLoading()) {
      try {
        const state = await win.webContents.executeJavaScript(
          "({ ready: document.readyState, cards: document.querySelectorAll('.account-block').length,"
          + " done: document.documentElement.dataset.startupComplete === 'true' })"
        );
        if (state.ready === 'complete' && state.done) return win;
        last = JSON.stringify(state);
      } catch (err) {
        last = String(err && err.message);
      }
    }
    await sleep(120);
  }
  throw new Error(`renderer not ready: ${last}`);
}

app.whenReady().then(async () => {
  let win;
  try {
    win = await waitForRenderer();
  } catch (err) {
    console.error('[screens] fatal:', err.message);
    app.exit(2);
    return;
  }
  win.webContents.setBackgroundThrottling(false);
  win.show();
  win.focus();
  win.webContents.focus();

  // Same convergence rule the smoke uses: capture only once the renderer's own
  // viewport agrees with the window, so a capture is never labelled a size it
  // was not taken at.
  const resize = async (width, height, budgetMs = 5000) => {
    const { x, y } = win.getBounds();
    win.setBounds({ x, y, width, height });
    const deadline = Date.now() + budgetMs;
    let css = null;
    while (Date.now() < deadline) {
      css = await win.webContents.executeJavaScript('({ width: innerWidth, height: innerHeight })').catch(() => null);
      if (css && css.width === width && css.height === height) break;
      await sleep(60);
    }
    await sleep(250);
    return css;
  };

  const design = [];

  const capture = async (name, note) => {
    const image = await win.webContents.capturePage();
    const file = path.join(OUT_DIR, `${name}.png`);
    fs.writeFileSync(file, image.toPNG());
    const css = await win.webContents.executeJavaScript('({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })');
    manifest.push({
      name,
      file: path.basename(file),
      note,
      requested: win.getBounds(),
      cssViewport: { width: css.width, height: css.height },
      devicePixelRatio: css.dpr,
      bytes: fs.statSync(file).size
    });
    console.log(`[screens] ${name}  ${css.width}x${css.height} @${css.dpr}x  ${fs.statSync(file).size} bytes`);
  };

  const js = (code) => win.webContents.executeJavaScript(code);

  const setTheme = async (theme) => {
    await js(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
    await sleep(250);
  };

  // ── The measured design audit ────────────────────────────────────────
  //
  // Platform fonts come from the DevTools protocol: it is the only place
  // Chromium reports which face it actually used, as opposed to which stack
  // the stylesheet asked for.
  const platformFonts = async (selectors) => {
    const out = {};
    let attached = false;
    try {
      if (!win.webContents.debugger.isAttached()) {
        win.webContents.debugger.attach('1.3');
        attached = true;
      }
      await win.webContents.debugger.sendCommand('DOM.enable');
      await win.webContents.debugger.sendCommand('CSS.enable');
      const { root } = await win.webContents.debugger.sendCommand('DOM.getDocument', { depth: -1 });
      for (const selector of selectors) {
        try {
          const { nodeId } = await win.webContents.debugger.sendCommand('DOM.querySelector', {
            nodeId: root.nodeId, selector
          });
          if (!nodeId) { out[selector] = 'no such element'; continue; }
          const fonts = await win.webContents.debugger.sendCommand('CSS.getPlatformFontsForNode', { nodeId });
          out[selector] = (fonts.fonts || []).map((f) => `${f.familyName} x${f.glyphCount}`);
        } catch (err) {
          out[selector] = `unavailable: ${err.message}`;
        }
      }
    } catch (err) {
      out.error = `debugger unavailable: ${err.message}`;
    } finally {
      if (attached) {
        try { win.webContents.debugger.detach(); } catch (_) {}
      }
    }
    return out;
  };

  const measureDesign = async (label) => {
    const metrics = await js(`(() => {
      const box = (selector) => {
        const el = document.querySelector(selector);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
          font: cs.fontFamily,
          size: cs.fontSize,
          weight: cs.fontWeight,
          lineHeight: cs.lineHeight,
          color: cs.color,
          height: Math.round(r.height * 10) / 10,
          width: Math.round(r.width * 10) / 10,
          padding: cs.padding,
          radius: cs.borderRadius,
          visible: cs.display !== 'none' && r.height > 0,
          insideViewport: r.top >= -1 && r.bottom <= innerHeight + 1
        };
      };
      const footer = document.getElementById('widgetFooter');
      const graph = document.getElementById('graphSection');
      return {
        viewport: { width: innerWidth, height: innerHeight },
        theme: document.documentElement.dataset.theme,
        body: box('body'),
        accountName: box('.account-name'),
        rowLabel: box('.row-label'),
        rowPct: box('.row-pct'),
        accountBlock: box('.account-block'),
        usageRow: box('.usage-row'),
        footer: footer ? { ...box('#widgetFooter'), text: footer.innerText.replace(/\s+/g, ' ').trim() } : null,
        graph: graph ? box('#graphSection') : null,
        documentScroll: {
          scrollHeight: document.documentElement.scrollHeight,
          clientHeight: document.documentElement.clientHeight,
          overflowing: document.documentElement.scrollHeight > document.documentElement.clientHeight + 1
        }
      };
    })()`);
    const fonts = await platformFonts([
      'body', '.account-name', '.row-pct', '.row-reset', '.widget-footer span',
      '.settings-title', '.theme-toggle-label'
    ]);
    const entry = { label, metrics, platformFonts: fonts };
    design.push(entry);
    console.log(`[screens] design audit (${label}): body=${metrics.body && metrics.body.size}`
      + ` name=${metrics.accountName && metrics.accountName.size}/${metrics.accountName && metrics.accountName.weight}`
      + ` footer=${metrics.footer && metrics.footer.height}px`
      + ` fonts=${JSON.stringify(fonts['.account-name'])}`);
    return entry;
  };

  try {
    // ── Main widget across the required widths ─────────────────────────
    for (const [w, h] of [[480, 520], [640, 520], [800, 520]]) {
      await resize(w, h);
      await capture(`widget-${w}x${h}`, 'three accounts: automatic, near-limit automatic, manual override');
    }

    // ── Short window: controls and footer must stay usable ─────────────
    await resize(640, 260);
    await capture('widget-640x260-short', 'short height — footer and rows must remain reachable');

    // ── Graph on ───────────────────────────────────────────────────────
    await resize(640, 560);
    await js("document.getElementById('graphBtn').click()");
    await sleep(900);
    await capture('widget-640x560-graph', 'usage graph with a null gap in the history');

    await js("if (graphVisible) document.getElementById('graphBtn').click()");
    await sleep(500);

    // ── Update banner ──────────────────────────────────────────────────
    updateOffered = true;
    await js('checkForUpdate()');
    await sleep(600);
    await capture('widget-640x560-update-banner', 'update banner above the account list');
    await js("document.getElementById('updateBannerDismiss').click()");
    updateOffered = false;
    await sleep(300);

    // ── Configuration banner (rendered from a real health payload) ─────
    await js(`applyConfigHealth({ state: 'preserved', reason: 'invalid-json',
              preservedPath: 'C:\\\\Users\\\\you\\\\AppData\\\\Roaming\\\\claude-usage-widget\\\\config.unreadable-2026-09-10.json' })`);
    await sleep(300);
    await capture('widget-640x560-config-banner', 'preserved-configuration notice');
    await js("document.getElementById('configBannerDismiss').click()");
    await sleep(300);

    // ── Unavailable / not-connected card states ────────────────────────
    await js(`(() => {
      updateAccountCard('1', { provider: 'claude', source: 'auto', status: 'unavailable',
        error: 'CloudflareBlocked: challenge', rows: [], lastSuccessAt: null });
      const a = accounts.find((x) => x.id === '1');
      if (a) { a.hasSession = false; a.credentialState = 'absent'; }
      refreshConnectionAction('1');
      updateAccountCard('2', { provider: 'chatgpt', source: 'manual', fallback: true, status: 'available',
        error: 'SecureStorageLocked: locked',
        rows: [{ key: 'manual', label: 'Manual usage', shortLabel: 'Manual', utilization: 20, available: true, windowMs: null, resets_at: null, used: 40, limit: 200 }] });
      const b = accounts.find((x) => x.id === '2');
      if (b) { b.credentialState = 'locked'; }
      refreshConnectionAction('2');
    })()`);
    await sleep(400);
    await capture('widget-640x560-failure-states', 'unavailable + not connected, and a locked-keychain account on its manual fallback');

    // Put the cards back to a truthful state before the remaining captures:
    // re-read the accounts from main (the forced states above were local to the
    // renderer) and poll again.
    await js('window.electronAPI.getAccounts().then((a) => { accounts = a; renderAccounts(); })');
    await sleep(400);
    await js('pollAllAccounts()');
    await sleep(1200);

    // ── Settings ───────────────────────────────────────────────────────
    await resize(640, 620);
    await js("document.getElementById('settingsBtn').click()");
    await sleep(700);
    await capture('settings-640x620', 'accounts list, usage colour legend, toggles and selects');

    await js(`(() => {
      const row = document.querySelector('.account-row[data-account-id="1"]');
      row.querySelector('.account-remove-btn').click();
    })()`);
    await sleep(500);
    await capture('settings-640x620-remove-confirm', 'account-specific removal confirmation naming the history loss');
    await js("document.querySelector('.account-remove-confirm-no').click()");
    await sleep(200);

    await js(`(() => {
      const row = document.querySelector('.account-row[data-account-id="2"]');
      row.querySelector('.account-manual-btn').click();
    })()`);
    await sleep(400);
    await js(`(() => {
      const editor = document.querySelectorAll('.account-manual-editor')[1];
      const inputs = editor.querySelectorAll('input[type=number]');
      inputs[0].value = 'abc';
      inputs[1].value = '0';
      editor.querySelector('.account-manual-save').click();
    })()`);
    await sleep(400);
    await capture('settings-640x620-manual-invalid', 'manual entry refusing invalid numbers with an explanation');

    await resize(480, 620);
    await capture('settings-480x620', 'settings at the narrowest supported width');

    await js("document.getElementById('closeSettingsBtn').click()");
    await sleep(500);

    // ── Onboarding: provider choice and the manual-only route ──────────
    await resize(640, 520);
    await js('startAddAccount({ fromSettings: true })');
    await sleep(700);
    await capture('onboarding-640x520-choice', 'first screen: two automatic providers and manual entry');

    await js("document.getElementById('providerManualBtn').click()");
    await sleep(400);
    await capture('onboarding-640x520-manual', 'manual-only account creation, reachable without any sign-in');

    await js("document.getElementById('manualAccountSaveBtn').click()");
    await sleep(400);
    await capture('onboarding-640x520-manual-invalid', 'empty manual numbers explained rather than saved as zero');

    await js("document.getElementById('manualAccountBackBtn').click()");
    await sleep(300);
    await js("document.getElementById('providerClaudeBtn').click()");
    await sleep(400);
    await capture('onboarding-640x520-claude', 'Claude sign-in step, with the session-key route named honestly');

    await js("document.getElementById('nextStepBtn').click()");
    await sleep(400);
    await capture('onboarding-640x520-session-key', 'paste-session-key step — the one place monospace is used');

    // ── Keyboard focus ─────────────────────────────────────────────────
    await js("document.getElementById('backStepBtn').click()");
    await sleep(200);
    await js("document.getElementById('claudeBackBtn') && document.getElementById('loginCancelBtn').click()");
    await sleep(700);
    await resize(640, 520);
    await js("document.getElementById('settingsBtn').click()");
    await sleep(600);
    await js("document.getElementById('closeSettingsBtn').focus()");
    await sleep(200);
    await capture('focus-640x520-settings-done', 'visible keyboard focus ring on a settings control');

    // ── High DPI ───────────────────────────────────────────────────────
    await js("document.getElementById('closeSettingsBtn').click()");
    await sleep(400);
    win.webContents.setZoomFactor(2);
    await sleep(600);
    await capture('widget-640x520-zoom2x', '2x zoom, standing in for a high-DPI display');
    win.webContents.setZoomFactor(1);
    await sleep(300);

    // ── Measured audit, dark theme ─────────────────────────────────────
    await js("document.getElementById('settingsOverlay').style.display = 'none'");
    await resize(640, 560);
    await sleep(300);
    await measureDesign('dark 640x560');

    // Footer and graph together, which is where they compete for height.
    await js("document.getElementById('graphBtn').click()");
    await sleep(900);
    await measureDesign('dark 640x560 with the graph on');
    await capture('widget-640x560-graph-and-footer', 'graph and footer visible together');

    await resize(640, 260);
    await sleep(400);
    await measureDesign('dark 640x260 short');
    await js("if (graphVisible) document.getElementById('graphBtn').click()");
    await sleep(500);

    // ── Keyboard focus, on a control that really has it ────────────────
    await resize(640, 560);
    const focusState = await js(`(async () => {
      const el = document.getElementById('refreshBtn');
      el.focus({ focusVisible: true });
      // focus() alone does not always satisfy :focus-visible; a keyboard event
      // on the way in is what a real user's Tab does.
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));
      const cs = getComputedStyle(el);
      return {
        active: document.activeElement && document.activeElement.id,
        focusVisible: el.matches(':focus-visible'),
        outlineStyle: cs.outlineStyle,
        outlineWidth: cs.outlineWidth,
        outlineColor: cs.outlineColor,
        outlineOffset: cs.outlineOffset
      };
    })()`);
    design.push({ label: 'keyboard focus (dark)', focus: focusState });
    console.log(`[screens] focus ring (dark): ${JSON.stringify(focusState)}`);
    await capture('focus-640x560-refresh-dark', 'keyboard focus ring on the refresh control');

    // ── The light theme: the same states, and its own audit ────────────
    await setTheme('light');
    await measureDesign('light 640x560');
    await capture('widget-640x560-light', 'light theme, three accounts');

    await resize(480, 520);
    await capture('widget-480x520-light', 'light theme at the narrowest supported width');
    await resize(640, 560);

    await js("document.getElementById('graphBtn').click()");
    await sleep(900);
    await capture('widget-640x560-light-graph', 'light theme with the usage graph and footer');
    await measureDesign('light 640x560 with the graph on');
    await js("if (graphVisible) document.getElementById('graphBtn').click()");
    await sleep(500);

    const lightFocus = await js(`(async () => {
      const el = document.getElementById('refreshBtn');
      el.focus({ focusVisible: true });
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));
      const cs = getComputedStyle(el);
      return {
        focusVisible: el.matches(':focus-visible'),
        outlineStyle: cs.outlineStyle,
        outlineWidth: cs.outlineWidth,
        outlineColor: cs.outlineColor
      };
    })()`);
    design.push({ label: 'keyboard focus (light)', focus: lightFocus });
    console.log(`[screens] focus ring (light): ${JSON.stringify(lightFocus)}`);
    await capture('focus-640x560-refresh-light', 'light theme keyboard focus ring');

    await js("document.getElementById('settingsBtn').click()");
    await sleep(600);
    await capture('settings-640x560-light', 'light theme settings, with the theme toggle at the bottom');
    const togglePlacement = await js(`(() => {
      const btn = document.getElementById('themeToggleBtn');
      const footer = btn && btn.closest('.settings-footer');
      const r = btn && btn.getBoundingClientRect();
      const fr = footer && footer.getBoundingClientRect();
      const cs = btn && getComputedStyle(btn);
      return {
        present: !!btn,
        inSettingsFooter: !!footer,
        visible: !!cs && cs.display !== 'none' && r.height > 0,
        insideViewport: !!r && r.top >= 0 && r.bottom <= innerHeight + 1,
        label: btn ? btn.innerText.replace(/\s+/g, ' ').trim() : null,
        pressed: btn ? btn.getAttribute('aria-pressed') : null,
        atBottomOfPanel: !!(r && fr) && Math.abs(r.top - fr.top) < fr.height,
        size: r ? { width: Math.round(r.width), height: Math.round(r.height) } : null
      };
    })()`);
    design.push({ label: 'theme toggle placement', toggle: togglePlacement });
    console.log(`[screens] theme toggle: ${JSON.stringify(togglePlacement)}`);
    await measureDesign('light settings 640x560');

    // -- A removal that could not finish, in both themes ----------------
    //
    // Last, because it really removes an account. The history delete is refused
    // for the duration, so what is captured is the app's own truthful report
    // that data remains, with its retry - not a mock-up.
    historyDeleteFails = true;
    await js(`(async () => {
      const row = document.querySelector('.account-row[data-account-id="3"]');
      row.querySelector('.account-remove-btn').click();
      await new Promise((r) => setTimeout(r, 400));
      document.querySelector('.account-remove-confirm[data-account-id="3"] .account-remove-confirm-yes').click();
      await new Promise((r) => setTimeout(r, 1500));
    })()`);
    await sleep(400);
    const removalNotice = await js(`(() => {
      const n = document.querySelector('.account-remove-failure[data-account-id="3"]');
      return n ? { shown: getComputedStyle(n).display !== 'none',
        text: n.querySelector('.account-remove-failure-text').textContent,
        retry: !!n.querySelector('.account-remove-failure-retry') } : { shown: false };
    })()`);
    design.push({ label: 'incomplete removal notice', notice: removalNotice });
    console.log(`[screens] incomplete removal notice: ${JSON.stringify(removalNotice)}`);
    await capture('settings-640x560-removal-incomplete-light',
      'light theme: a removal that could not delete the history says so, with a retry');
    await setTheme('dark');
    await sleep(300);
    await capture('settings-640x560-removal-incomplete-dark',
      'dark theme: the same incomplete-removal report');
    await resize(480, 520);
    await capture('settings-480x520-removal-incomplete-dark',
      'the same report at the narrowest supported width');
    await resize(640, 560);
    historyDeleteFails = false;

    // Leave the profile as it was found: dark, no overlay.
    await js("document.getElementById('settingsOverlay').style.display = 'none'");
    await setTheme('dark');
    await sleep(200);

    fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify({
      runtime: {
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        platform: process.platform,
        arch: process.arch
      },
      capturedAt: new Date().toISOString(),
      captures: manifest,
      design
    }, null, 2) + '\n');
    console.log(`[screens] ${manifest.length} captures written to ${OUT_DIR}`);
    app.exit(0);
  } catch (err) {
    console.error('[screens] fatal:', (err && err.stack) || err);
    try {
      fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify({ error: String(err && err.message), captures: manifest }, null, 2) + '\n');
    } catch (_) {}
    app.exit(2);
  }
});

process.on('unhandledRejection', (reason) => {
  console.error('[screens] unhandled rejection:', reason);
  app.exit(3);
});
