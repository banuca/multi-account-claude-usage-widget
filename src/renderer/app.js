// Application state
let updateInterval = null;
let countdownInterval = null;
let isExpanded = false;
let usageChart = null;
let graphVisible = false;      // the user's saved preference — the only one persisted
let graphSuppressed = false;   // derived from the window size, never saved
let appInitializing = true;  // suppresses _saveViewState during startup restore

// Fixed usage status bands — not configurable (v3.0 minimalist design).
// Each row is colored by its own %: green < 80, orange 80–95, red ≥ 95.
const WARN_THRESHOLD = 80;
const DANGER_THRESHOLD = 95;

// Shared usage-reading semantics (src/usage-status.js). In the app it arrives
// as window.UsageStatus from the <script> tag in index.html; under Node (the
// behavioural tests) it is required directly, so both see one definition.
const UsageStatus = (typeof window !== 'undefined' && window.UsageStatus)
    ? window.UsageStatus
    : require('../usage-status');
const { READ_STATUS, ROW_SLOTS, readPercent, isRowAvailable, availableRows, maxAvailableUtilization, hasAnyReading, selectRow } = UsageStatus;

// Manual numbers are validated with exactly the same rules main.js uses, so
// the editor's message and the store's answer can never disagree.
const ManualEntry = (typeof window !== 'undefined' && window.ManualEntry)
    ? window.ManualEntry
    : require('../manual-entry');
const { validateManualEntry, describeManualErrors } = ManualEntry;

// Status band for a reading. null/undefined is NOT a reading and must never
// fall through to green — callers get 'unknown' and render a dash.
function statusClassFor(pct) {
    if (pct === null || pct === undefined || !Number.isFinite(pct)) return 'unknown';
    return statusForPercent(pct);
}

function statusForPercent(pct) {
    if (pct >= DANGER_THRESHOLD) return 'red';
    if (pct >= WARN_THRESHOLD) return 'orange';
    return 'green';
}

// v2.0 free-resize model: the user owns the window size. These are the only
// two fixed sizes left — the design default for a true first run, and the
// minimum height the settings panel temporarily grows to if the window is
// shorter than that when it's opened (restored on close).
const DEFAULT_WINDOW_WIDTH = 640;
const SETTINGS_MIN_HEIGHT = 540;

// ── Multi-account state ──────────────────────────────────────────────────────
let accounts = [];                    // [{ id, label, provider, orgId, organizations, manual, hasSession }]
const cardsById = new Map();          // accountId -> { card, els } scoped card elements
const usageByAccount = {};            // accountId -> latest usage data (renderer copy)
const fetchingAccounts = new Set();   // per-account in-flight guard
const expiredAccounts = new Set();    // accountIds whose session has expired (need reconnect)
let draftAccount = null;              // { id, partition, label } while adding an account
let draftProvider = 'claude';         // provider chosen in the add-account flow
let addingFromSettings = false;       // true when the add-flow was launched with accounts present
let pendingValidation = null;         // { sessionKey, organizations, draft, seq } awaiting an org pick

// Cancellation-safety state for the add/reconnect flow.
// addFlowSeq increments whenever a flow starts or is cancelled. Every async
// login/validation continuation captures the seq + draft it started with and
// drops its result when either no longer matches — a late result from a
// cancelled flow can never save into (or alter) a newer one.
// draftFlowKind: 'add' = brand-new draft whose partition may be discarded on
// cancel; 'reconnect' = a saved account — cancel must never delete it or wipe
// its partition.
// draftSaveDispatched: true only while a save-account IPC is awaiting. Once a
// save is dispatched it has committed, so Cancel bails instead of racing it.
let draftFlowKind = 'add';
let addFlowSeq = 0;
let draftSaveDispatched = false;

function isCurrentFlow(seq, draft) {
    return seq === addFlowSeq && draftAccount === draft;
}

// Fork release page (in-app update check + banner link)
// Fallback only. The live value comes from the main process, derived from the
// same owner/repo constants the update check uses, so the link the user
// follows cannot point at a different project than the one checked.
let RELEASES_URL = 'https://github.com/banuca/ai-usage-monitor/releases/latest';

// Debug logging — only shows in DevTools (development mode).
const DEBUG = (new URLSearchParams(window.location.search)).has('debug');
function debugLog(...args) {
  if (DEBUG) console.log('[Debug]', ...args);
}

// DOM elements
const elements = {
    loadingContainer: document.getElementById('loadingContainer'),
    loginContainer: document.getElementById('loginContainer'),
    noUsageContainer: document.getElementById('noUsageContainer'),
    mainContent: document.getElementById('mainContent'),

    loginStep0: document.getElementById('loginStep0'),
    providerClaudeBtn: document.getElementById('providerClaudeBtn'),
    providerChatGPTBtn: document.getElementById('providerChatGPTBtn'),
    providerManualBtn: document.getElementById('providerManualBtn'),

    loginManualStep: document.getElementById('loginManualStep'),
    manualAccountName: document.getElementById('manualAccountName'),
    manualAccountProvider: document.getElementById('manualAccountProvider'),
    manualAccountUsed: document.getElementById('manualAccountUsed'),
    manualAccountLimit: document.getElementById('manualAccountLimit'),
    manualAccountError: document.getElementById('manualAccountError'),
    manualAccountSaveBtn: document.getElementById('manualAccountSaveBtn'),
    manualAccountBackBtn: document.getElementById('manualAccountBackBtn'),

    loginStep1: document.getElementById('loginStep1'),
    loginStep2: document.getElementById('loginStep2'),
    loginStep3: document.getElementById('loginStep3'),
    loginChatGPTStep: document.getElementById('loginChatGPTStep'),
    autoDetectBtn: document.getElementById('autoDetectBtn'),
    autoDetectError: document.getElementById('autoDetectError'),
    openBrowserLink: document.getElementById('openBrowserLink'),
    nextStepBtn: document.getElementById('nextStepBtn'),
    backStepBtn: document.getElementById('backStepBtn'),
    claudeBackBtn: document.getElementById('claudeBackBtn'),
    sessionKeyInput: document.getElementById('sessionKeyInput'),
    connectBtn: document.getElementById('connectBtn'),
    sessionKeyError: document.getElementById('sessionKeyError'),
    chatGPTLoginBtn: document.getElementById('chatGPTLoginBtn'),
    chatGPTBackBtn: document.getElementById('chatGPTBackBtn'),
    chatGPTError: document.getElementById('chatGPTError'),
    orgPickerSelect: document.getElementById('orgPickerSelect'),
    orgPickerConfirmBtn: document.getElementById('orgPickerConfirmBtn'),
    orgPickerError: document.getElementById('orgPickerError'),
    loginTitle: document.getElementById('loginTitle'),
    loginCancelBtn: document.getElementById('loginCancelBtn'),

    refreshBtn: document.getElementById('refreshBtn'),
    graphBtn: document.getElementById('graphBtn'),
    minimizeBtn: document.getElementById('minimizeBtn'),
    closeBtn: document.getElementById('closeBtn'),

    expandToggle: document.getElementById('expandToggle'),
    expandArrow: document.getElementById('expandArrow'),
    expandSection: document.getElementById('expandSection'),
    extraRows: document.getElementById('extraRows'),
    graphSection: document.getElementById('graphSection'),
    widgetFooter: document.getElementById('widgetFooter'),
    usageChart: document.getElementById('usageChart'),

    settingsBtn: document.getElementById('settingsBtn'),
    settingsOverlay: document.getElementById('settingsOverlay'),
    closeSettingsBtn: document.getElementById('closeSettingsBtn'),
    logoutBtn: document.getElementById('logoutBtn'),
    coffeeBtn: document.getElementById('coffeeBtn'),
    autoStartCol: document.getElementById('autoStartCol'),
    autoStartToggle: document.getElementById('autoStartToggle'),
    autoStartHint: document.getElementById('autoStartHint'),
    minimizeToTrayToggle: document.getElementById('minimizeToTrayToggle'),
    alwaysOnTopToggle: document.getElementById('alwaysOnTopToggle'),
    showTrayStatsToggle: document.getElementById('showTrayStatsToggle'),
    timeFormat: document.getElementById('timeFormat'),
    weeklyDateFormat: document.getElementById('weeklyDateFormat'),
    refreshInterval: document.getElementById('refreshInterval'),
    usageAlertsToggle: document.getElementById('usageAlertsToggle'),

    configBanner: document.getElementById('configBanner'),
    configBannerText: document.getElementById('configBannerText'),
    configBannerDismiss: document.getElementById('configBannerDismiss'),

    updateBanner: document.getElementById('updateBanner'),
    updateBannerText: document.getElementById('updateBannerText'),
    updateBannerDismiss: document.getElementById('updateBannerDismiss'),
    settingsVersionLabel: document.getElementById('settingsVersionLabel'),
    settingsUpdateLink: document.getElementById('settingsUpdateLink'),

    accountsContainer: document.getElementById('accountsContainer'),
    accountCardTemplate: document.getElementById('accountCardTemplate'),
    addAccountBtn: document.getElementById('addAccountBtn'),
    accountsList: document.getElementById('accountsList'),

    themeToggleBtn: document.getElementById('themeToggleBtn')
};

// ── Appearance ───────────────────────────────────────────────────────────────
//
// The theme is already applied to <html> before the first paint (the inline
// bootstrap in index.html reads it from preload, so there is no flash and no
// IPC round trip). Everything here is about CHANGING it.
//
// The button's own icon and label are driven by CSS from the same attribute,
// so this only has to move the attribute, persist the choice, and redraw the
// one thing that cannot inherit CSS: the graph canvas.
function currentTheme() {
    return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function applyTheme(theme) {
    const resolved = theme === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = resolved;
    if (elements.themeToggleBtn) {
        elements.themeToggleBtn.setAttribute('aria-pressed', String(resolved === 'light'));
    }
    // Chart.js paints into a canvas from the token values read at draw time,
    // so an existing chart keeps the old palette until it is rebuilt.
    if (usageChart) loadChart().catch((error) => debugLog('chart redraw after theme change', error));
    return resolved;
}

async function toggleTheme() {
    const next = currentTheme() === 'light' ? 'dark' : 'light';
    // Applied first: the switch must feel immediate even if the write is slow,
    // and a failed write costs the user nothing this session.
    applyTheme(next);
    try {
        const result = await window.electronAPI.setTheme(next);
        if (result && result.theme && result.theme !== next) applyTheme(result.theme);
        if (result && result.persisted === false) {
            debugLog('theme applied for this session only: settings are not being saved');
        }
    } catch (error) {
        debugLog('theme could not be saved', error);
    }
}

// The saved configuration could not be used. Two very different situations,
// so they are worded differently: "your file is preserved and we started
// fresh" is recoverable by hand, while "nothing can be saved this session" is
// not, and the user needs to know before they spend time on settings.
const CONFIG_BANNER_TEXT = {
    preserved: (health) => `Your saved settings could not be read, so the widget started fresh. `
        + `The original file was kept at ${health.preservedPath || 'the configuration folder'} — nothing was deleted.`,
    'read-only': () => 'Your settings file could not be opened, so it has been left untouched. '
        + 'The widget works normally but will not save changes this session.',
    'write-failed': () => 'Changes cannot be written to your settings file, so they are being kept for this session only.',
    // Read fine, unusable, copied aside successfully - and the replacement
    // could not be written. Both files are intact, which is the one thing the
    // user needs to hear, and nothing will be saved this session.
    'reset-failed': (health) => `Your saved settings could not be used and could not be replaced, `
        + `so nothing has been changed. Your original file is still there${health.preservedPath
            ? ` and a copy was kept at ${health.preservedPath}` : ''}. `
        + 'The widget works normally but will not save changes this session.'
};

function applyConfigHealth(health) {
    if (!health || !elements.configBanner) return;
    const describe = CONFIG_BANNER_TEXT[health.state];
    if (!describe) {
        elements.configBanner.style.display = 'none';
        return;
    }
    elements.configBannerText.textContent = describe(health);
    elements.configBanner.title = health.reason ? `Reason: ${health.reason}` : '';
    elements.configBanner.style.display = 'flex';
    scheduleGraphLayout();
}

// Initialize
async function init() {
    setupEventListeners();

    // Ask before anything else that depends on stored state, so a degraded
    // boot is visible from the first paint rather than after the first failed
    // save.
    try {
        applyConfigHealth(await window.electronAPI.getConfigHealth());
    } catch (error) {
        debugLog('config health unavailable', error);
    }
    try {
        window._secureStorage = await window.electronAPI.getSecureStorage();
    } catch (error) {
        debugLog('secure storage state unavailable', error);
    }
    try {
        const url = await window.electronAPI.getReleasesUrl();
        if (typeof url === 'string' && url.startsWith('https://github.com/')) RELEASES_URL = url;
    } catch (error) {
        debugLog('releases url unavailable, using the built-in default', error);
    }
    window.electronAPI.onConfigHealth((health) => applyConfigHealth(health));

    const settings = await window.electronAPI.getSettings();
    window._cachedSettings = settings;
    if (window.electronAPI.platform === 'darwin') {
        document.getElementById('trayLabel').textContent = 'Hide from Dock';
    }

    accounts = await window.electronAPI.getAccounts();

    if (accounts.length > 0) {
        renderAccounts();
        showMainContent();
        await pollAllAccounts();
        startAutoUpdate();

        // Restore the graph panel's visibility from the last session. In a
        // window too short for it the panel stays suppressed and the saved
        // preference is left exactly as it is.
        if (settings.graphVisible) {
            graphVisible = true;
            applyGraphLayout();
            if (!graphSuppressed) await loadChart();
        }
    } else {
        // First run — no accounts yet. Open the add-account flow.
        startAddAccount({ fromSettings: false });
    }

    // One-time content-height auto-size — a no-op after the first run ever
    // stores windowBounds (the user owns the size from then on).
    await applyFirstRunAutoSize();

    // Populate version label then check for updates after a short delay
    const version = await window.electronAPI.getAppVersion();
    if (elements.settingsVersionLabel) {
        elements.settingsVersionLabel.textContent = `Application Version: v${version}`;
    }
    setTimeout(checkForUpdate, 2000);
    // Also check once every 24 hours for users who never close the app
    setInterval(checkForUpdate, 24 * 60 * 60 * 1000);

    // Startup restore complete — allow _saveViewState to persist changes
    appInitializing = false;

    // An explicit, observable "startup finished" signal. Everything above has
    // run: the cards are rendered, every account has been polled once, the
    // saved graph preference has been applied and the window has been sized.
    // Tests wait for THIS rather than for a private variable or a fixed sleep,
    // so a slow boot is a timeout with a diagnostic, never a skipped check.
    document.documentElement.dataset.startupComplete = 'true';
}

// Event Listeners
function setupEventListeners() {
    // Step 0: provider picker
    elements.providerManualBtn.addEventListener('click', () => showManualAccountStep());
    elements.manualAccountBackBtn.addEventListener('click', () => showStep0());
    elements.manualAccountSaveBtn.addEventListener('click', () => handleManualAccountCreate());
    elements.manualAccountUsed.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleManualAccountCreate(); });
    elements.manualAccountLimit.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleManualAccountCreate(); });
    elements.configBannerDismiss.addEventListener('click', () => {
        elements.configBanner.style.display = 'none';
        scheduleGraphLayout();
    });

    elements.providerClaudeBtn.addEventListener('click', () => {
        draftProvider = 'claude';
        showClaudeStep1();
    });
    elements.providerChatGPTBtn.addEventListener('click', () => {
        draftProvider = 'chatgpt';
        showChatGPTStep();
    });

    // Claude flow — step 1: embedded login capture (also handles SSO)
    elements.autoDetectBtn.addEventListener('click', handleAutoDetect);

    // Step navigation (Log in ↔ Manual paste)
    elements.nextStepBtn.addEventListener('click', () => {
        elements.loginStep1.style.display = 'none';
        elements.loginStep2.style.display = 'block';
        elements.sessionKeyInput.focus();
    });
    elements.backStepBtn.addEventListener('click', () => {
        elements.loginStep2.style.display = 'none';
        elements.loginStep1.style.display = 'flex';
        elements.sessionKeyError.textContent = '';
    });
    elements.claudeBackBtn.addEventListener('click', () => {
        draftProvider = 'claude';
        showStep0();
    });

    // ChatGPT flow — login capture
    elements.chatGPTLoginBtn.addEventListener('click', handleChatGPTLogin);
    elements.chatGPTBackBtn.addEventListener('click', () => showStep0());

    // Open claude.ai in the real browser (to copy the sessionKey for manual entry)
    elements.openBrowserLink.addEventListener('click', (e) => {
        e.preventDefault();
        window.electronAPI.openExternal('https://claude.ai');
    });

    // Step 2: manual sessionKey connect
    elements.connectBtn.addEventListener('click', handleConnect);
    elements.sessionKeyInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleConnect();
        elements.sessionKeyError.textContent = '';
    });

    // Step 3: pick an organisation (Team accounts with more than one org)
    elements.orgPickerConfirmBtn.addEventListener('click', handleOrgPick);

    // Cancel the add-account flow (only offered when accounts already exist)
    elements.loginCancelBtn.addEventListener('click', cancelAddAccount);

    // "Add account" from the settings panel
    elements.addAccountBtn.addEventListener('click', () => {
        elements.settingsOverlay.style.display = 'none';
        startAddAccount({ fromSettings: true });
    });

    // Refresh — re-poll every account
    elements.refreshBtn.addEventListener('click', async () => {
        debugLog('Refresh button clicked');
        elements.refreshBtn.classList.add('spinning');
        await pollAllAccounts();
        elements.refreshBtn.classList.remove('spinning');
    });

    elements.graphBtn.addEventListener('click', async () => {
        graphVisible = !graphVisible;
        applyGraphLayout();
        if (graphVisible && !graphSuppressed) await loadChart();
        _saveViewState();
    });

    // The window is resized by the OS and by the widget's own grips; either way
    // the graph re-decides whether it fits.
    window.addEventListener('resize', scheduleGraphLayout);
    observeContentHeight();

    elements.minimizeBtn.addEventListener('click', () => {
        window.electronAPI.minimizeWindow();
    });

    elements.closeBtn.addEventListener('click', () => {
        window.electronAPI.closeWindow();
    });

    // Settings — Done
    elements.closeSettingsBtn.addEventListener('click', async () => {
        await saveSettings();
        elements.settingsOverlay.style.display = 'none';
        await restoreBoundsAfterSettingsGrow();
        startAutoUpdate();
    });

    elements.coffeeBtn.addEventListener('click', () => {
        window.electronAPI.openExternal('https://buymeacoffee.com/banuca');
    });

    // Prevent accidental app hiding: couple Hide-from-Taskbar and Show-Tray-Stats
    elements.minimizeToTrayToggle.addEventListener('change', () => {
        if (elements.minimizeToTrayToggle.checked && !elements.showTrayStatsToggle.checked) {
            elements.showTrayStatsToggle.checked = true;
        }
    });
    elements.showTrayStatsToggle.addEventListener('change', () => {
        if (!elements.showTrayStatsToggle.checked && elements.minimizeToTrayToggle.checked) {
            elements.minimizeToTrayToggle.checked = false;
        }
    });

    // Tray "Refresh" → re-poll every account
    window.electronAPI.onRefreshUsage(async () => {
        if (elements.refreshBtn) elements.refreshBtn.classList.add('spinning');
        await pollAllAccounts();
        if (elements.refreshBtn) elements.refreshBtn.classList.remove('spinning');
    });

    // A single account's session expired — flag just that card for reconnect
    window.electronAPI.onAccountSessionExpired((accountId) => {
        debugLog('Account session expired:', accountId);
        markAccountExpired(accountId);
    });

    // Update banner (points at this fork's releases)
    elements.updateBannerDismiss.addEventListener('click', () => {
        elements.updateBanner.style.display = 'none';
        // Dismissing gives the column its height back — the graph can grow
        // again, or return from suppression, without the user resizing. Done
        // synchronously so no frame is painted with the old layout.
        relayoutGraphNow();
    });
    elements.updateBannerText.addEventListener('click', () => {
        window.electronAPI.openExternal(RELEASES_URL);
    });
    elements.settingsUpdateLink.addEventListener('click', () => {
        window.electronAPI.openExternal(RELEASES_URL);
    });

    // Settings button
    elements.settingsBtn.addEventListener('click', async () => {
        stopAutoUpdate();
        await loadSettings();
        elements.settingsOverlay.style.display = 'flex';
        await growBoundsForSettingsIfNeeded();
    });

    // Appearance toggle, at the bottom of the settings panel.
    if (elements.themeToggleBtn) {
        elements.themeToggleBtn.setAttribute('aria-pressed', String(currentTheme() === 'light'));
        elements.themeToggleBtn.addEventListener('click', toggleTheme);
    }

    setupResizeGrips();
}

// If the window is shorter than the settings panel needs, temporarily grow it
// (keeping x/y and width) so the panel isn't cramped; restored on Done.
let _boundsBeforeSettingsGrow = null;
async function growBoundsForSettingsIfNeeded() {
    const bounds = await window.electronAPI.getWindowBounds();
    if (!bounds || bounds.height >= SETTINGS_MIN_HEIGHT) return;
    _boundsBeforeSettingsGrow = bounds;
    await window.electronAPI.setWindowBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: SETTINGS_MIN_HEIGHT });
}

async function restoreBoundsAfterSettingsGrow() {
    if (!_boundsBeforeSettingsGrow) return;
    await window.electronAPI.setWindowBounds(_boundsBeforeSettingsGrow);
    _boundsBeforeSettingsGrow = null;
}

// One-time content-height auto-size for a true first run (no windowBounds
// stored yet). No-op on every subsequent call — the main process consumes the
// firstRunAutoSize flag on the first set-window-bounds call it sees.
async function applyFirstRunAutoSize() {
    const info = await window.electronAPI.getWindowInitInfo();
    if (!info || !info.isFirstRun) return;

    const titleBar = document.getElementById('titleBar');
    let height = titleBar ? titleBar.offsetHeight : 36;
    if (elements.updateBanner && elements.updateBanner.style.display !== 'none') {
        height += elements.updateBanner.offsetHeight;
    }
    if (elements.mainContent.style.display !== 'none') {
        height += elements.mainContent.scrollHeight;
    } else if (elements.loginContainer.style.display !== 'none') {
        height += elements.loginContainer.scrollHeight;
    }

    await window.electronAPI.setWindowBounds({ width: DEFAULT_WINDOW_WIDTH, height: Math.ceil(height) + 4 });
}

// Pointer-driven resize grips — transparent windows don't support native OS
// edge-resize, so 8 invisible grip zones (4 edges + 4 corners) drive
// setBounds() over IPC directly, throttled to one call per animation frame.
function setupResizeGrips() {
    const grips = document.querySelectorAll('.resize-grip');
    let active = null; // { edge, startBounds, startScreenX, startScreenY }
    let pendingBounds = null;
    let rafScheduled = false;

    const flushPendingBounds = () => {
        rafScheduled = false;
        if (pendingBounds) window.electronAPI.setWindowBounds(pendingBounds);
    };

    grips.forEach((grip) => {
        grip.addEventListener('pointerdown', async (e) => {
            const edge = grip.dataset.edge;
            const startBounds = await window.electronAPI.getWindowBounds();
            if (!startBounds) return;
            active = { edge, startBounds, startScreenX: e.screenX, startScreenY: e.screenY };
            grip.setPointerCapture(e.pointerId);
            e.preventDefault();
        });

        grip.addEventListener('pointermove', (e) => {
            if (!active) return;
            const dx = e.screenX - active.startScreenX;
            const dy = e.screenY - active.startScreenY;
            const { edge, startBounds } = active;
            let { x, y, width, height } = startBounds;

            if (edge.includes('e')) width = startBounds.width + dx;
            if (edge.includes('s')) height = startBounds.height + dy;
            if (edge.includes('w')) { width = startBounds.width - dx; x = startBounds.x + dx; }
            if (edge.includes('n')) { height = startBounds.height - dy; y = startBounds.y + dy; }

            pendingBounds = { x, y, width, height };
            if (!rafScheduled) {
                rafScheduled = true;
                requestAnimationFrame(flushPendingBounds);
            }
        });

        const endDrag = (e) => {
            if (active) {
                try { grip.releasePointerCapture(e.pointerId); } catch (_) {}
            }
            active = null;
            pendingBounds = null;
        };
        grip.addEventListener('pointerup', endDrag);
        grip.addEventListener('pointercancel', endDrag);
    });
}

// ── Add-account flow ─────────────────────────────────────────────────────────
// Step 0 = provider picker (Claude / ChatGPT). Claude then follows the classic
// embedded-login / manual-key / org-picker steps; ChatGPT only has the login
// capture step (its usage is read automatically; manual entry lives in Settings).

async function startAddAccount({ fromSettings }) {
    const seq = ++addFlowSeq;
    draftSaveDispatched = false;
    addingFromSettings = fromSettings;
    draftFlowKind = 'add';
    const draft = await window.electronAPI.createDraftAccount();
    if (seq !== addFlowSeq) {
        // The allocation resolved after this flow was cancelled/superseded.
        // It was never exposed to another flow, so only its own partition may
        // be discarded.
        try { await window.electronAPI.discardDraftAccount(draft.id); } catch (_) {}
        return;
    }
    draftAccount = draft;
    draftProvider = 'claude';
    pendingValidation = null;
    stopAutoUpdate();
    showAddAccountUI();
}

function showAddAccountUI() {
    elements.loadingContainer.style.display = 'none';
    elements.noUsageContainer.style.display = 'none';
    elements.mainContent.style.display = 'none';
    elements.settingsOverlay.style.display = 'none';
    elements.loginContainer.style.display = 'flex';

    // Hide header controls during the flow
    elements.settingsBtn.style.display = 'none';
    elements.refreshBtn.style.display = 'none';
    elements.graphBtn.style.display = 'none';

    // Cancel is only offered when there are existing accounts to return to
    elements.loginTitle.textContent = draftAccount ? `Add account — ${draftAccount.label}` : 'Add account';
    elements.loginCancelBtn.style.display = accounts.length > 0 ? 'inline-flex' : 'none';
    elements.loginCancelBtn.disabled = false;

    showStep0();
}

function showStep0() {
    elements.loginStep0.style.display = 'flex';
    elements.loginManualStep.style.display = 'none';
    elements.loginStep1.style.display = 'none';
    elements.loginStep2.style.display = 'none';
    elements.loginStep3.style.display = 'none';
    elements.loginChatGPTStep.style.display = 'none';
    elements.autoDetectError.textContent = '';
    elements.sessionKeyError.textContent = '';
    elements.chatGPTError.textContent = '';
    elements.orgPickerError.textContent = '';
    elements.manualAccountError.textContent = '';
    elements.sessionKeyInput.value = '';
    elements.autoDetectBtn.disabled = false;
    elements.autoDetectBtn.textContent = 'Log in';
    elements.connectBtn.disabled = false;
    elements.connectBtn.textContent = 'Connect';
    elements.chatGPTLoginBtn.disabled = false;
    elements.chatGPTLoginBtn.textContent = 'Log in';
}

function showClaudeStep1() {
    elements.loginStep0.style.display = 'none';
    elements.loginManualStep.style.display = 'none';
    elements.loginStep1.style.display = 'flex';
    elements.loginStep2.style.display = 'none';
    elements.loginStep3.style.display = 'none';
    elements.loginChatGPTStep.style.display = 'none';
    elements.autoDetectError.textContent = '';
}

function showChatGPTStep() {
    elements.loginStep0.style.display = 'none';
    elements.loginManualStep.style.display = 'none';
    elements.loginStep1.style.display = 'none';
    elements.loginStep2.style.display = 'none';
    elements.loginStep3.style.display = 'none';
    elements.loginChatGPTStep.style.display = 'flex';
    elements.chatGPTError.textContent = '';
}

// Manual-only tracking, reachable from the first screen. This is a different
// operation from "paste your session key": no provider login happens, no
// credential is stored, and the account is driven entirely by the numbers the
// user types.
function showManualAccountStep() {
    elements.loginStep0.style.display = 'none';
    elements.loginStep1.style.display = 'none';
    elements.loginStep2.style.display = 'none';
    elements.loginStep3.style.display = 'none';
    elements.loginChatGPTStep.style.display = 'none';
    elements.loginManualStep.style.display = 'flex';
    elements.manualAccountError.textContent = '';
    elements.manualAccountSaveBtn.disabled = false;
    elements.manualAccountSaveBtn.textContent = 'Start tracking';
    if (!elements.manualAccountName.value && draftAccount) {
        elements.manualAccountName.value = draftAccount.label || '';
    }
    elements.manualAccountName.focus();
}

async function handleManualAccountCreate() {
    const draft = draftAccount;
    const seq = addFlowSeq;
    if (!draft) return;

    // Validated, not coerced: an empty or non-numeric box is explained rather
    // than saved as a zero that would then render as "unavailable" for no
    // visible reason.
    const validation = validateManualEntry({
        enabled: true,
        used: elements.manualAccountUsed.value,
        limit: elements.manualAccountLimit.value
    });
    if (!validation.valid) {
        elements.manualAccountError.textContent = describeManualErrors(validation.errors);
        return;
    }

    const label = elements.manualAccountName.value.trim() || draft.label || 'Personal';
    const provider = elements.manualAccountProvider.value === 'chatgpt' ? 'chatgpt' : 'claude';

    elements.manualAccountSaveBtn.disabled = true;
    elements.manualAccountSaveBtn.textContent = 'Saving...';
    // Commit: this owns the draft from here, exactly as a credential save does.
    draftSaveDispatched = true;
    try {
        const result = await window.electronAPI.createManualAccount({
            id: draft.id,
            label,
            provider,
            manual: validation.manual
        });
        if (!isCurrentFlow(seq, draft)) return;
        if (!result || result.ok !== true) {
            elements.manualAccountError.textContent = result && result.errors
                ? describeManualErrors(result.errors)
                : 'Could not save this account.';
            return;
        }
    } catch (error) {
        if (isCurrentFlow(seq, draft)) {
            elements.manualAccountError.textContent = error.message || 'Could not save this account.';
        }
        return;
    } finally {
        draftSaveDispatched = false;
        if (isCurrentFlow(seq, draft)) {
            elements.manualAccountSaveBtn.disabled = false;
            elements.manualAccountSaveBtn.textContent = 'Start tracking';
        }
    }

    if (!isCurrentFlow(seq, draft)) return;

    draftAccount = null;
    pendingValidation = null;
    accounts = await window.electronAPI.getAccounts();
    elements.loginContainer.style.display = 'none';
    elements.manualAccountUsed.value = '';
    elements.manualAccountLimit.value = '';
    elements.manualAccountName.value = '';
    renderAccounts();
    showMainContent();
    await pollAllAccounts();
    startAutoUpdate();
}

async function cancelAddAccount() {
    // A save that was already dispatched has committed this draft and will
    // finish the flow on its own — cancelling now could only race the save
    // and delete the account it just wrote. Bail and let it complete.
    if (draftSaveDispatched) return;

    const draft = draftAccount;
    if (!draft) return; // this flow is already cancelling or completed
    const kind = draftFlowKind;
    const seq = addFlowSeq;

    // Supersede every in-flight result for this flow before touching any
    // state: login/validation continuations compare against addFlowSeq (and
    // their captured draft) and drop late results.
    const cancellationSeq = ++addFlowSeq;
    pendingValidation = null;
    draftAccount = null;
    elements.loginCancelBtn.disabled = true;

    if (draft) {
        // Close any pending login window / cookie listeners on this partition.
        try { await window.electronAPI.cancelLoginCapture(draft.partition, seq); } catch (_) {}

        // Only a brand-new draft owns its partition — discard just that. A
        // reconnect draft IS a saved account: its record, credential backup,
        // manual settings and history must stay untouched.
        if (kind === 'add') {
            try { await window.electronAPI.discardDraftAccount(draft.id); } catch (_) {}
        }
    }

    // Cleanup can be delayed by an in-flight provider operation. If another
    // add/reconnect flow started (or was itself cancelled) while we awaited,
    // this completion no longer owns the shared UI or polling state.
    if (addFlowSeq !== cancellationSeq || draftAccount !== null) return;

    elements.loginContainer.style.display = 'none';

    if (accounts.length > 0) {
        // Re-sync with the store so a save from an earlier flow that landed
        // meanwhile still shows up, then resume normal operation.
        accounts = await window.electronAPI.getAccounts();
        renderAccounts();
        showMainContent();
        startAutoUpdate();
    } else {
        // Cancelled first-run with no accounts — reopen the flow
        startAddAccount({ fromSettings: false });
    }
}

// Claude step 2: manual sessionKey connect
async function handleConnect() {
    const draft = draftAccount;
    const seq = addFlowSeq;
    if (!draft) return;

    const sessionKey = elements.sessionKeyInput.value.trim();
    if (!sessionKey) {
        elements.sessionKeyError.textContent = 'Please paste your session key';
        return;
    }

    elements.connectBtn.disabled = true;
    elements.connectBtn.textContent = '...';
    elements.sessionKeyError.textContent = '';

    try {
        const result = await window.electronAPI.validateSessionKey(sessionKey, draft.partition, seq);
        if (!isCurrentFlow(seq, draft)) return; // cancelled/superseded while validating
        if (result.success) {
            await onValidated(sessionKey, result, draft, seq);
        } else {
            elements.sessionKeyError.textContent = result.error || 'Invalid session key';
        }
    } catch (error) {
        if (isCurrentFlow(seq, draft)) {
            elements.sessionKeyError.textContent = error.userFacing
                ? error.message
                : 'Connection failed. Check your key.';
        }
    } finally {
        if (isCurrentFlow(seq, draft)) {
            elements.connectBtn.disabled = false;
            elements.connectBtn.textContent = 'Connect';
        }
    }
}

// Claude step 1: embedded login capture (also completes SSO in-window)
async function handleAutoDetect() {
    const draft = draftAccount;
    const seq = addFlowSeq;
    if (!draft) return;
    elements.autoDetectBtn.disabled = true;
    elements.autoDetectBtn.textContent = 'Waiting...';
    elements.autoDetectError.textContent = '';

    try {
        const result = await window.electronAPI.detectSessionKey(draft.partition, seq);
        if (!isCurrentFlow(seq, draft)) return; // cancelled/superseded while the login window was open
        if (!result.success) {
            elements.autoDetectError.textContent = result.error || 'Login failed';
            return;
        }

        elements.autoDetectBtn.textContent = 'Validating...';
        const validation = await window.electronAPI.validateSessionKey(result.sessionKey, draft.partition, seq);
        if (!isCurrentFlow(seq, draft)) return;
        if (validation.success) {
            await onValidated(result.sessionKey, validation, draft, seq);
        } else {
            elements.autoDetectError.textContent = validation.error
                || 'Session invalid. Try again, or paste your session key.';
        }
    } catch (error) {
        if (isCurrentFlow(seq, draft)) {
            elements.autoDetectError.textContent = error.message || 'Login failed';
        }
        if (error.userFacing) return;
    } finally {
        if (isCurrentFlow(seq, draft)) {
            elements.autoDetectBtn.disabled = false;
            elements.autoDetectBtn.textContent = 'Log in';
        }
    }
}

// ChatGPT step: login capture → validate → save
async function handleChatGPTLogin() {
    const draft = draftAccount;
    const seq = addFlowSeq;
    if (!draft) return;
    elements.chatGPTLoginBtn.disabled = true;
    elements.chatGPTLoginBtn.textContent = 'Waiting...';
    elements.chatGPTError.textContent = '';

    try {
        const result = await window.electronAPI.detectChatGPTToken(draft.partition, seq);
        if (!isCurrentFlow(seq, draft)) return;
        if (!result.success) {
            elements.chatGPTError.textContent = result.error || 'Login failed';
            return;
        }

        elements.chatGPTLoginBtn.textContent = 'Validating...';
        const validation = await window.electronAPI.validateChatGPTToken(result.token, draft.partition, seq);
        if (!isCurrentFlow(seq, draft)) return;
        if (validation.success) {
            await completeAddAccount(result.token, null, [], 'chatgpt', draft, seq);
        } else {
            elements.chatGPTError.textContent = validation.error || 'Login not detected. Try again.';
        }
    } catch (error) {
        if (isCurrentFlow(seq, draft)) {
            elements.chatGPTError.textContent = error.message || 'Login failed';
        }
    } finally {
        if (isCurrentFlow(seq, draft)) {
            elements.chatGPTLoginBtn.disabled = false;
            elements.chatGPTLoginBtn.textContent = 'Log in';
        }
    }
}

// After a sessionKey validates: pick an org (>1) or save straight away.
async function onValidated(sessionKey, validation, draft, seq) {
    if (!isCurrentFlow(seq, draft)) return;
    const orgs = validation.organizations || [];
    if (orgs.length > 1) {
        pendingValidation = { sessionKey, organizations: orgs, draft, seq };
        showOrgPicker(orgs);
        return;
    }
    await completeAddAccount(sessionKey, validation.organizationId, orgs, 'claude', draft, seq);
}

function showOrgPicker(orgs) {
    elements.loginStep1.style.display = 'none';
    elements.loginStep2.style.display = 'none';
    elements.loginStep3.style.display = 'block';
    elements.orgPickerError.textContent = '';
    elements.orgPickerSelect.innerHTML = '';
    for (const org of orgs) {
        const option = document.createElement('option');
        option.value = org.id;
        option.textContent = `${org.name}${org.isTeam ? ' (Team)' : ' (Personal)'}`;
        elements.orgPickerSelect.appendChild(option);
    }
}

// Step 3: confirm the chosen org
async function handleOrgPick() {
    if (!pendingValidation) return;
    const orgId = elements.orgPickerSelect.value;
    const validation = pendingValidation;
    const { draft, seq } = validation;
    pendingValidation = null;
    try {
        await completeAddAccount(validation.sessionKey, orgId, validation.organizations, 'claude', draft, seq);
    } catch (error) {
        if (isCurrentFlow(seq, draft)) {
            elements.orgPickerError.textContent = error.message || 'Could not save account';
        }
    }
}

// Why a save can come back refused, in the user's terms. Each of these is a
// state main.js reports explicitly rather than a failure it guessed at.
const SAVE_REFUSALS = {
    'insecure-storage': () =>
        'This computer has no secure place to keep the login, so it was not saved. '
        + 'Use "Enter usage manually" instead, or set up a system keyring and try again.',
    // The account was removed, the add was cancelled, or a newer sign-in for
    // the same account finished first. Nothing was written, which is the point.
    superseded: () =>
        'This account changed while the sign-in was completing, so nothing was saved. '
        + 'Check the account list and try again if it is still missing.',
    // The credential is stored, but the account list itself did not reach the
    // configuration file - so it will not be there next time.
    'not-persisted': (result) =>
        'The sign-in worked but could not be written to your settings file, so it will '
        + 'not be there next time the widget starts.'
        + (result && result.detail ? ` (${result.detail})` : '')
};

async function completeAddAccount(sessionKey, organizationId, organizations, provider, draft, seq) {
    if (!isCurrentFlow(seq, draft)) return; // stale flow — never save into a different draft

    // Commit: once the save is dispatched it owns the draft. Flag it BEFORE
    // awaiting so Cancel bails out instead of deleting an account mid-save.
    draftSaveDispatched = true;
    try {
        const saved = await window.electronAPI.saveAccount({
            id: draft.id,
            label: draft.label,
            provider,
            sessionKey,
            organizationId,
            organizations,
            flowId: seq
        });
        // Three distinct answers from main: `true` (saved), `false` (this flow
        // was cancelled or superseded), or a refusal object explaining why the
        // credential was not persisted.
        if (saved && saved.ok === false) {
            const message = SAVE_REFUSALS[saved.reason]
                ? SAVE_REFUSALS[saved.reason](saved)
                : (saved.detail || 'Could not save this account.');
            throw Object.assign(new Error(message), { userFacing: true });
        }
        if (!saved) throw new Error('Account save was cancelled or superseded');
    } catch (error) {
        draftSaveDispatched = false;
        throw error;
    }
    draftSaveDispatched = false;

    // If the flow was cancelled/superseded while saving, the cancel path owns
    // the UI — do not touch a newer flow's state or draft.
    if (!isCurrentFlow(seq, draft)) return;

    draftAccount = null;
    pendingValidation = null;

    // Reload accounts from the store and show the widget
    accounts = await window.electronAPI.getAccounts();
    elements.loginContainer.style.display = 'none';
    elements.sessionKeyInput.value = '';
    renderAccounts();
    showMainContent();
    await pollAllAccounts();
    startAutoUpdate();
}

// ── Polling ──────────────────────────────────────────────────────────────────
// Poll each account sequentially — one hidden fetch window at a time keeps the
// main window's z-order stable. A per-account guard prevents overlap.
async function pollAllAccounts() {
    for (const account of accounts) {
        await fetchAccount(account.id);
    }
    if (graphVisible && !graphSuppressed) await loadChart();
}

async function fetchAccount(accountId) {
    if (fetchingAccounts.has(accountId)) {
        debugLog('Fetch already in flight for', accountId);
        return;
    }
    fetchingAccounts.add(accountId);
    try {
        // Resolves for every outcome now: a failed refresh comes back as a
        // stale or unavailable payload rather than throwing, so the card can
        // show what the numbers are instead of silently keeping old ones.
        const data = await window.electronAPI.fetchUsageData(accountId);
        usageByAccount[accountId] = data;
        // A later success clears the transient error; only a dead credential
        // (SessionExpired, below) keeps the reconnect state.
        if (isTrustedReading(data)) {
            // A successful automatic reading is proof that a credential exists,
            // whoever saved it. Keeping the cached flag in step means the
            // derived connection action clears itself instead of waiting for
            // the next full accounts re-read.
            const account = accounts.find((a) => a.id === accountId);
            if (account && data && data.source !== 'manual') {
                account.hasSession = true;
                // The read decrypted this account's credential, so a cached
                // "keychain locked" state is out of date. Leaving it would keep
                // showing a problem that has just been disproved.
                if (hasKeychainProblem(account)) account.credentialState = 'encrypted';
            }
            clearAccountExpired(accountId);
        }
        updateAccountCard(accountId, data);
        const account = accounts.find((a) => a.id === accountId);
        if (account) checkUsageAlerts(account, data);
    } catch (error) {
        // StaleRead / UnknownAccount: the read discovered it no longer owns its
        // account (removed, reconnected, or switched to manual while it was in
        // flight). There is nothing to report and nothing to change — writing
        // a failure state here is exactly how a removed account used to come
        // back on the screen.
        const message = String(error.message || '');
        if (message.includes('StaleRead') || message.includes('UnknownAccount')) {
            debugLog('discarded a superseded read for', accountId, message);
            return;
        }
        console.error(`Error fetching usage for ${accountId}:`, error);
        if (message.includes('SessionExpired') || message.includes('Unauthorized')) {
            markAccountExpired(accountId);
        }
    } finally {
        fetchingAccounts.delete(accountId);
    }
}

// ── Responsive graph panel ───────────────────────────────────────────────────
//
// The account list and the footer are what the widget is FOR, so they own the
// window. The graph is a panel on top of that: it takes only the height left
// over, and when there is not enough left for both a usable account list and a
// readable chart it is temporarily suppressed.
//
// Two separate pieces of state, deliberately:
//   graphVisible    the user's preference. Persisted, and changed ONLY by the
//                   graph button.
//   graphSuppressed derived from the current window size. Never persisted, and
//                   cleared the moment the window grows again — so a short
//                   window costs the user neither their setting nor a second
//                   click to get the graph back.
//
// The numbers are the panel's own limits, not the window's: the minimum window
// size (main.js MIN_WINDOW_WIDTH / MIN_WINDOW_HEIGHT) is untouched.
const GRAPH_MAX_HEIGHT = 220;    // design height, used whenever it fits
const GRAPH_MIN_HEIGHT = 140;    // below this the chart is too thin to read
const ACCOUNTS_MIN_HEIGHT = 56;  // two compact rows stay visible and scrollable

// Height an element costs the column, including its margins.
function outerHeight(el) {
    if (!el || el.style.display === 'none' || !el.offsetHeight) return 0;
    const cs = getComputedStyle(el);
    return el.offsetHeight + parseFloat(cs.marginTop || 0) + parseFloat(cs.marginBottom || 0);
}

// The panel state last written to the DOM. applyGraphLayout() compares its
// decision against this and writes nothing when the outcome is unchanged, which
// keeps it idempotent: an invalidation that changes nothing produces no style
// mutation, so a content-size observer cannot feed itself.
let graphLayoutApplied = { display: null, height: null };

function writeGraphPanel(section, display, height) {
    if (graphLayoutApplied.display === display && graphLayoutApplied.height === height) {
        return false;
    }
    section.style.display = display;
    section.style.height = height;
    graphLayoutApplied = { display, height };
    return true;
}

// Decide the graph panel's height (or that it cannot be shown at all) and
// apply it. Safe to call as often as needed — it only reads and writes layout.
function applyGraphLayout() {
    const section = elements.graphSection;
    if (!section) return;

    if (!graphVisible) {
        graphSuppressed = false;
        writeGraphPanel(section, 'none', '');
        updateGraphButtonState();
        return;
    }

    // .content is a flex column capped by the window, so its clientHeight is
    // what the column really has — it does not grow when children overflow.
    const content = elements.mainContent;
    const cs = getComputedStyle(content);
    const inner = content.clientHeight
        - parseFloat(cs.paddingTop || 0)
        - parseFloat(cs.paddingBottom || 0);

    // What the column must keep no matter what. The panel's own margin counts
    // against it too, or the account list ends up that much short of its
    // minimum.
    const sectionStyle = getComputedStyle(section);
    const sectionMargin = parseFloat(sectionStyle.marginTop || 0)
        + parseFloat(sectionStyle.marginBottom || 0);
    const reserved = ACCOUNTS_MIN_HEIGHT
        + sectionMargin
        + outerHeight(elements.widgetFooter)
        + outerHeight(elements.expandToggle)
        + outerHeight(elements.expandSection);

    const spare = Math.floor(inner - reserved);

    if (spare < GRAPH_MIN_HEIGHT) {
        // Not enough room for a chart worth looking at. Give the height back
        // to the account list and remember this is the window's doing.
        graphSuppressed = true;
        writeGraphPanel(section, 'none', '');
        updateGraphButtonState();
        return;
    }

    graphSuppressed = false;
    const changed = writeGraphPanel(section, 'flex', `${Math.min(GRAPH_MAX_HEIGHT, spare)}px`);
    // Only re-measure the chart when the panel actually changed size.
    if (changed && usageChart) usageChart.resize();
    updateGraphButtonState();
}

// The graph button keeps showing the user's preference. When the window is too
// short it also says so, rather than looking broken or needing another click.
function updateGraphButtonState() {
    const btn = elements.graphBtn;
    if (!btn) return;
    btn.classList.toggle('active', graphVisible);
    btn.classList.toggle('suppressed', graphVisible && graphSuppressed);
    btn.title = graphVisible && graphSuppressed
        ? 'Usage graph hidden — the window is too short. Make it taller to show it again.'
        : 'Toggle Usage Graph';
    btn.setAttribute('aria-pressed', graphVisible ? 'true' : 'false');
}

// Re-decide the layout right now, and reload the chart when the panel comes
// back after being suppressed (nothing was drawn while it was hidden).
//
// Callers that already know the column changed — the update banner appearing
// or being dismissed — use this directly, so the new layout lands in the same
// task as the change. Deferring it to the next frame instead left one painted
// frame in which the banner had taken the account list's space.
function relayoutGraphNow() {
    const wasShowing = graphVisible && !graphSuppressed;
    applyGraphLayout();
    const showing = graphVisible && !graphSuppressed;
    if (showing && !wasShowing) loadChart().catch(() => {});
}

// Coalesced version, for streams of events (a drag-resize, an observer burst).
let graphLayoutFrame = null;
function scheduleGraphLayout() {
    if (graphLayoutFrame) cancelAnimationFrame(graphLayoutFrame);
    graphLayoutFrame = requestAnimationFrame(() => {
        graphLayoutFrame = null;
        relayoutGraphNow();
    });
}

// The window is not the only thing that changes how much height the account
// list and the graph have to share: the update banner and the expand panel sit
// in the same column and appear without any resize at all. Watching the
// content box catches every cause, including ones added later, instead of
// relying on each of them remembering to invalidate the layout.
//
// This cannot feed itself: #mainContent is `flex: 1; min-height: 0` inside a
// window-height column, so its own box is set by the window, never by the
// height this layout writes onto a child. applyGraphLayout() is idempotent as
// well, so a callback that changes nothing performs no mutation.
function observeContentHeight() {
    if (typeof ResizeObserver !== 'function' || !elements.mainContent) return;
    const observer = new ResizeObserver(() => scheduleGraphLayout());
    observer.observe(elements.mainContent);
}

// ── Usage rows ───────────────────────────────────────────────────────────────
// Normalized data: { provider, source, rows: [{ key, label, shortLabel,
// windowMs, utilization, resets_at }], raw }. Legacy payloads
// ({ five_hour, seven_day }) are folded into the same shape.
// Returns a COPY: the provider payload must stay immutable while it is being
// rendered (rendering used to push a placeholder row straight into data.rows).
function normalizeRows(data) {
    if (!data) return [];
    if (Array.isArray(data.rows)) return data.rows.map((row) => ({ ...row }));
    const rows = [];
    if (data.five_hour) {
        rows.push(UsageStatus.usageRow({
            key: 'session', label: 'Current session', shortLabel: '5h',
            windowMs: 5 * 60 * 60 * 1000,
            resets_at: data.five_hour.resets_at || null
        }, data.five_hour.utilization));
    }
    if (data.seven_day) {
        rows.push(UsageStatus.usageRow({
            key: 'weekly', label: 'Weekly limit', shortLabel: '7d',
            windowMs: 7 * 24 * 60 * 60 * 1000,
            resets_at: data.seven_day.resets_at || null
        }, data.seven_day.utilization));
    }
    return rows;
}

// ── Read status ──────────────────────────────────────────────────────────────
// What a card's numbers actually are. `data` is the payload from
// fetch-usage-data, which carries status / stale / fallback / lastSuccessAt.

function readStatusOf(data) {
    if (!data) return READ_STATUS.LOADING;
    if (data.status) return data.status;
    return hasAnyReading(normalizeRows(data)) ? READ_STATUS.AVAILABLE : READ_STATUS.UNAVAILABLE;
}

function isStaleReading(data) {
    return !!data && (!!data.stale || data.status === READ_STATUS.STALE);
}

// A fresh, successful reading of the provider. A stale payload is an earlier
// reading; a fallback is the user's manual entry standing in for a read that
// failed. Neither may drive alerts or count as an account that just refreshed.
function isTrustedReading(data) {
    if (readStatusOf(data) !== READ_STATUS.AVAILABLE) return false;
    if (isStaleReading(data)) return false;
    return !(data && data.fallback);
}

// The chip text/class for a card, or null when the reading is a plain success.
// Does this payload's error say the keychain is the problem?
function isKeychainError(data) {
    return !!data && typeof data.error === 'string' && data.error.startsWith('SecureStorageLocked');
}

function statusChipFor(data) {
    const status = readStatusOf(data);
    if (status === READ_STATUS.LOADING) return { text: 'loading', cls: 'status-loading' };
    // Named separately from a plain failure: "locked" tells the user the
    // credential is still there, which "unavailable" does not.
    if (isKeychainError(data)) {
        return { text: data && data.fallback ? 'manual · locked' : 'locked', cls: 'status-unavailable' };
    }
    if (status === READ_STATUS.UNAVAILABLE) return { text: 'unavailable', cls: 'status-unavailable' };
    if (isStaleReading(data)) return { text: 'stale', cls: 'status-stale' };
    if (data && data.fallback) return { text: 'fallback', cls: 'status-stale' };
    return null;
}

// ── Account cards ────────────────────────────────────────────────────────────

// Rebuild the card stack from the current accounts list.
function renderAccounts() {
    cardsById.clear();
    elements.accountsContainer.innerHTML = '';
    for (const account of accounts) {
        renderAccountCard(account);
        if (usageByAccount[account.id]) {
            updateAccountCard(account.id, usageByAccount[account.id]);
        }
        // Derived, so a reload or a restart cannot lose the way back in.
        refreshConnectionAction(account.id);
    }
}

// Clone the template for one account and cache its scoped elements.
function renderAccountCard(account) {
    const fragment = elements.accountCardTemplate.content.cloneNode(true);
    const card = fragment.querySelector('.account-block');
    card.dataset.accountId = account.id;

    const els = {
        name: card.querySelector('.account-name'),
        providerTag: card.querySelector('.account-provider-tag'),
        sourceTag: card.querySelector('.account-source-tag'),
        statusTag: card.querySelector('.account-status-tag'),
        badge: card.querySelector('.account-badge'),
        reconnectBtn: card.querySelector('.account-reconnect-btn'),
        sessionRow: card.querySelector('.session-row'),
        sessionRowLabel: card.querySelector('.session-row-label'),
        sessionFill: card.querySelector('.session-fill'),
        sessionPct: card.querySelector('.session-pct'),
        sessionResetsIn: card.querySelector('.session-resets-in'),
        weeklyRow: card.querySelector('.weekly-row'),
        weeklyRowLabel: card.querySelector('.weekly-row-label'),
        weeklyFill: card.querySelector('.weekly-fill'),
        weeklyPct: card.querySelector('.weekly-pct'),
        weeklyResetsIn: card.querySelector('.weekly-resets-in')
    };

    els.name.textContent = account.label;
    els.providerTag.textContent = account.provider === 'chatgpt' ? 'ChatGPT' : 'Claude';
    els.reconnectBtn.addEventListener('click', () => reconnectAccount(account.id));

    elements.accountsContainer.appendChild(card);
    cardsById.set(account.id, { card, els });
}

// "6d 7h" / "4h 11m" / "1m" — remaining time until a reset.
function formatRemaining(resetsAt) {
    if (!resetsAt) return '—';
    const diff = new Date(resetsAt) - new Date();
    if (diff <= 0) return 'now';
    const totalMinutes = Math.floor(diff / 60000);
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

// Show the "closest to limit" badge only on the worst account (by the highest
// utilization across all its rows), and only once there are ≥2 accounts and
// that max has crossed the orange (warn) threshold.
function refreshWorstAccountBadge() {
    const worstId = computeWorstAccountId();
    for (const account of accounts) {
        const entry = cardsById.get(account.id);
        if (!entry) continue;
        const data = usageByAccount[account.id];
        // No reading ⇒ null, never 0 — an unknown account cannot win the badge.
        const maxPct = maxAvailableUtilization(normalizeRows(data));
        const showBadge = accounts.length >= 2
            && account.id === worstId
            && maxPct !== null
            && maxPct >= WARN_THRESHOLD;
        entry.els.badge.style.display = showBadge ? 'inline-flex' : 'none';
    }
}

// The two fixed card rows (slots) that data rows map onto. Which data row
// fills a slot is decided by the row's own key (selectRow), not by its
// position: a weekly-only response fills the weekly row and hides the session
// row, instead of printing the weekly figure on the session line.
function rowSlots(els) {
    return [
        { row: els.sessionRow, label: els.sessionRowLabel, fill: els.sessionFill, pct: els.sessionPct, resetsIn: els.sessionResetsIn, key: ROW_SLOTS.SESSION },
        { row: els.weeklyRow, label: els.weeklyRowLabel, fill: els.weeklyFill, pct: els.weeklyPct, resetsIn: els.weeklyResetsIn, key: ROW_SLOTS.WEEKLY }
    ];
}

// The reset information for one row, consolidated into two places: the
// countdown in the row itself, and the exact reset date/time on the row's
// tooltip (both honouring the user's time / weekly-date format settings).
// A row with no window — a manual entry, or a placeholder for a read that
// reported nothing — gets no countdown and no reset tooltip, rather than a
// dash standing in for a value that does not exist.
function applyRowReset(slot, rowData, timeFormat, weeklyDateFormat) {
    if (!rowData.windowMs || !rowData.resets_at) {
        slot.resetsIn.textContent = '';
        slot.row.title = '';
        return;
    }
    const remaining = formatRemaining(rowData.resets_at);
    const exact = formatResetsAt(rowData.resets_at, rowData.key !== ROW_SLOTS.SESSION, timeFormat, weeklyDateFormat);
    slot.resetsIn.textContent = remaining;
    slot.row.title = `${rowData.label || 'Usage'} resets ${exact} (in ${remaining})`;
}

// Update one account block. Each visible row is colored by its own %:
// green < 80, orange 80–95, red ≥ 95 (fixed thresholds).
function updateAccountCard(accountId, data) {
    const entry = cardsById.get(accountId);
    if (!entry) return;
    const { els } = entry;
    const settings = window._cachedSettings || {};
    const timeFormat = settings.timeFormat || '12h';
    const weeklyDateFormat = settings.weeklyDateFormat || 'date';

    // normalizeRows returns a copy, so this placeholder never reaches the
    // stored payload.
    const rows = normalizeRows(data);
    if (rows.length === 0) {
        // Nothing reported — one row that says so rather than a green 0%.
        rows.push({
            // Keyed to the session slot so the "nothing reported" line lands
            // on the first row rather than nowhere.
            key: ROW_SLOTS.SESSION,
            label: readStatusOf(data) === READ_STATUS.LOADING ? 'Usage' : 'Usage unavailable',
            utilization: null, available: false, windowMs: null, resets_at: null
        });
    }

    const slots = rowSlots(els);
    for (const s of slots) {
        const rowData = selectRow(rows, s.key);
        if (!rowData) {
            s.row.style.display = 'none';
            continue;
        }
        s.row.style.display = '';

        // A row without a reading shows a dash: no bar, no colour band, and
        // never 0%.
        const reading = isRowAvailable(rowData) ? readPercent(rowData.utilization) : null;
        const status = statusClassFor(reading);

        s.label.textContent = rowData.label || 'Usage';
        s.fill.style.width = reading === null ? '0%' : `${reading}%`;
        s.fill.className = `row-bar-fill ${s.key}-fill status-${status}`;
        s.pct.textContent = reading === null ? '—' : `${reading}%`;
        s.pct.className = `row-pct ${s.key}-pct status-${status}`;

        applyRowReset(s, rowData, timeFormat, weeklyDateFormat);
    }

    // A card whose rows carry no reset window at all (a manual entry, or a read
    // with nothing to report) drops the reset column outright rather than
    // leaving an empty one.
    entry.card.classList.toggle('no-resets', !rows.some((row) => row.windowMs && row.resets_at));

    entry.els.providerTag.textContent = data?.provider === 'chatgpt' ? 'ChatGPT' : 'Claude';
    // Manual values stay labelled Manual whether the user chose the override
    // or an auto-read fell back to them.
    entry.els.sourceTag.style.display = data?.source === 'manual' ? 'inline-flex' : 'none';

    // Read-status chip: stale / unavailable / fallback, hidden on a clean read.
    const chip = statusChipFor(data);
    if (chip) {
        entry.els.statusTag.textContent = chip.text;
        entry.els.statusTag.className = `account-status-tag ${chip.cls}`;
        entry.els.statusTag.title = statusChipTitle(data);
        entry.els.statusTag.style.display = 'inline-flex';
    } else {
        entry.els.statusTag.textContent = '';
        entry.els.statusTag.className = 'account-status-tag';
        entry.els.statusTag.title = '';
        entry.els.statusTag.style.display = 'none';
    }

    refreshConnectionAction(accountId);
    refreshWorstAccountBadge();
    updateWidgetFooter();
}

// Recompute the countdown (and its reset tooltip) for every card — called on an
// interval so the remaining time stays fresh between polls.
function refreshAllCardTimers() {
    const settings = window._cachedSettings || {};
    const timeFormat = settings.timeFormat || '12h';
    const weeklyDateFormat = settings.weeklyDateFormat || 'date';

    for (const account of accounts) {
        const entry = cardsById.get(account.id);
        const data = usageByAccount[account.id];
        if (!entry || !data) continue;
        const { els } = entry;
        const rows = normalizeRows(data);
        const slots = rowSlots(els);

        for (const s of slots) {
            const rowData = selectRow(rows, s.key);
            if (!rowData) continue;
            if (!rowData.windowMs || !rowData.resets_at) continue;
            if (!isRowAvailable(rowData)) continue;
            applyRowReset(s, rowData, timeFormat, weeklyDateFormat);
        }
    }
}

// Hover text for the read-status chip: why the numbers are not a fresh read,
// and when they were last read successfully.
function statusChipTitle(data) {
    const parts = [];
    const status = readStatusOf(data);
    if (isKeychainError(data)) {
        parts.push('The saved login is still stored but the system keychain will not open it, so reading is paused. Nothing has been deleted.');
    } else if (status === READ_STATUS.UNAVAILABLE) parts.push('No usable reading');
    else if (isStaleReading(data)) parts.push('Refresh failed — showing the last successful reading');
    else if (data && data.fallback) parts.push('Automatic read failed — showing your manual entry');
    if (data && data.error) parts.push(`Error: ${data.error}`);
    const at = lastSuccessLabel(data && data.lastSuccessAt);
    if (at) parts.push(`Last successful read ${at}`);
    return parts.join(' · ');
}

// Clock label for an epoch-ms last-success time, or null when there is none.
function lastSuccessLabel(lastSuccessAt) {
    if (!lastSuccessAt) return null;
    const settings = window._cachedSettings || {};
    const timeFormat = settings.timeFormat || '12h';
    return formatResetsAt(new Date(lastSuccessAt).toISOString(), false, timeFormat, 'date');
}

// Footer line: "Updated 12:07 · refresh 1m" + the "Unofficial" note.
//
// "Updated" is the newest LAST SUCCESSFUL READ reported by the main process —
// never the render clock, so a redraw, a settings change or a failed refresh
// cannot advance it. With more than one account it also says how many are not
// currently reading, so the line never implies they all refreshed.
function updateWidgetFooter() {
    const footer = document.getElementById('widgetFooter');
    const updated = document.getElementById('widgetUpdated');
    if (!footer || !updated) return;
    const settings = window._cachedSettings || {};
    const secs = parseInt(settings.refreshInterval || '300', 10);
    const refreshLabel = secs >= 60 ? `${Math.round(secs / 60)}m` : `${secs}s`;

    let newestSuccess = null;
    let notFresh = 0;
    for (const account of accounts) {
        const data = usageByAccount[account.id];
        const at = data && data.lastSuccessAt ? Number(data.lastSuccessAt) : null;
        if (at && (newestSuccess === null || at > newestSuccess)) newestSuccess = at;
        if (!isTrustedReading(data)) notFresh += 1;
    }

    const clock = lastSuccessLabel(newestSuccess);
    const head = clock ? `Updated ${clock}` : 'Never updated';
    const warn = notFresh > 0 && accounts.length > 0
        ? ` · ${notFresh}/${accounts.length} not current`
        : '';
    updated.textContent = `${head}${warn} · refresh ${refreshLabel}`;
    updated.title = notFresh > 0
        ? 'Some accounts are showing a stale or unavailable reading — see each card.'
        : '';
    footer.style.display = accounts.length > 0 ? 'flex' : 'none';
}

// Is this account driven by an automatic read? A manual override with a usable
// limit is the user's own number, needs no credential, and must never be
// nagged for a login.
function isManualOnlyAccount(account) {
    const manual = account && account.manual;
    return !!(manual && manual.enabled && manual.limit > 0);
}

// Does this account need the user to connect it?
//
// `expiredAccounts` only ever lived in this renderer's memory, so a reload or
// a restart lost it and the card offered no way back — an automatic account
// with no credential just sat there unavailable. The saved account already
// carries `hasSession`, so the answer is derivable and survives a reload.
//
// Deliberately NOT called "expired": a missing credential does not prove a
// session expired. It is proven expired only when the provider said so
// (ChatGPT's AuthRequired), which is what expiredAccounts still records.
function needsConnection(account) {
    if (!account) return false;
    if (account.hasSession) return false;
    return !isManualOnlyAccount(account);
}

// Is this account's credential present but unopenable? A locked or missing
// system keychain is not a login problem, and nothing the user does in this
// app will fix it — so the action must not invite them to try.
function hasKeychainProblem(account) {
    return !!account && (account.credentialState === 'locked' || account.credentialState === 'undecryptable');
}

// What the card's connection action should say. Three distinct states:
//   keychain locked  → a disabled explanation; reconnecting cannot repair it
//   proven expired   → "Session expired — Reconnect"
//   no credential    → "Not connected — Connect"
// A manual fallback stays visible in all of them; the action sits alongside it.
function connectionActionFor(account, provenExpired) {
    if (hasKeychainProblem(account)) {
        return {
            show: true,
            disabled: true,
            text: 'Secure storage unavailable',
            title: 'The saved login for this account is still here, but the system keychain will not open it. '
                + 'Reconnecting cannot repair a locked keychain. Nothing has been deleted, and your manual numbers are used instead if you have set them.'
        };
    }
    if (provenExpired) {
        return {
            show: true,
            disabled: false,
            text: 'Session expired — Reconnect',
            title: 'The provider rejected this login. Signing in again replaces it; history and manual settings are untouched.'
        };
    }
    if (needsConnection(account)) {
        return {
            show: true,
            disabled: false,
            text: 'Not connected — Connect',
            title: 'No login is saved for this account. Signing in adds one; history and manual settings are untouched.'
        };
    }
    return { show: false, disabled: false, text: '', title: '' };
}

function refreshConnectionAction(accountId) {
    const entry = cardsById.get(accountId);
    if (!entry) return;
    const account = accounts.find((a) => a.id === accountId);
    const provenExpired = expiredAccounts.has(accountId);
    const action = connectionActionFor(account, provenExpired);

    entry.card.classList.toggle('expired', provenExpired);
    entry.els.reconnectBtn.textContent = action.text || 'Not connected — Connect';
    entry.els.reconnectBtn.title = action.title;
    entry.els.reconnectBtn.disabled = action.disabled;
    entry.els.reconnectBtn.classList.toggle('not-actionable', action.disabled);
    entry.els.reconnectBtn.style.display = action.show ? 'inline-flex' : 'none';
}

function markAccountExpired(accountId) {
    expiredAccounts.add(accountId);
    // Main has just deleted the credential, so the cached account must agree —
    // otherwise the derived connection state would still think it has one.
    const account = accounts.find((a) => a.id === accountId);
    if (account) account.hasSession = false;
    refreshConnectionAction(accountId);
}

function clearAccountExpired(accountId) {
    expiredAccounts.delete(accountId);
    refreshConnectionAction(accountId);
}

// Re-run the login flow for an existing account, reusing its partition and
// provider. This is a RECONNECT, not a new draft: cancel must never discard
// the draft's partition or delete the account.
function reconnectAccount(accountId) {
    const account = accounts.find(a => a.id === accountId);
    if (!account) return;
    addFlowSeq++;
    draftSaveDispatched = false;
    draftFlowKind = 'reconnect';
    draftAccount = { id: account.id, partition: account.partition || `persist:acct-${account.id}`, label: account.label };
    draftProvider = account.provider || 'claude';
    addingFromSettings = false;
    pendingValidation = null;
    stopAutoUpdate();
    showAddAccountUI();
    if (draftProvider === 'chatgpt') showChatGPTStep();
    else showClaudeStep1();
}

// ── Accounts settings list ───────────────────────────────────────────────────
function renderAccountsList() {
    elements.accountsList.innerHTML = '';

    // Removals that did not fully succeed stay visible, with their own retry,
    // until they are retried successfully or dismissed.
    for (const [failedId, failure] of removalFailuresById) {
        elements.accountsList.appendChild(buildRemovalFailureNotice(failedId, failure));
    }

    // If the OS will not protect a credential, automatic sign-in is not
    // offered at all — and saying so here is the difference between a user
    // understanding the app and thinking it is broken. Manual tracking is
    // unaffected, so that is what the note points at.
    const security = window._secureStorage;
    if (security && security.secure === false) {
        const note = document.createElement('div');
        note.className = 'accounts-security-note';
        note.textContent = security.available === false
            ? 'No system keyring is available, so logins cannot be stored safely and automatic reading is unavailable. Manual entry works normally.'
            : 'This system only offers unprotected credential storage, so logins are not saved to disk and automatic reading is unavailable. Manual entry works normally.';
        note.title = `Secure storage: ${security.reason}`;
        elements.accountsList.appendChild(note);
    }

    for (const account of accounts) {
        // Row: provider tag + label input + Connect/Reconnect + Manual + Remove
        const row = document.createElement('div');
        row.className = 'account-row';
        // Addressable per account: the list interleaves rows with manual
        // editors, so a row's position is not a reliable way to find it.
        row.dataset.accountId = account.id;

        const tag = document.createElement('span');
        tag.className = 'account-provider-tag-mini';
        tag.textContent = account.provider === 'chatgpt' ? 'ChatGPT' : 'Claude';

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'account-label-input';
        input.value = account.label;
        input.spellcheck = false;
        const commit = async () => {
            const label = input.value.trim() || account.label;
            input.value = label;
            if (label !== account.label) {
                account.label = label;
                await window.electronAPI.renameAccount(account.id, label);
                const entry = cardsById.get(account.id);
                if (entry) entry.els.name.textContent = label;
            }
        };
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });

        // Quiet connection action.
        //
        // Why it exists here as well as on the card: a Cloudflare challenge or
        // an unexpected HTML body is a READ failure, not a dead login, so the
        // credential is deliberately kept (main.js isTransientReadError) and
        // the card correctly shows no action — hasSession is still true. Such
        // an account had no reachable way to re-authenticate at all; removing
        // and re-adding it was the only route, and that discards its history.
        //
        // Wording tracks what is actually held:
        //   credential held  → "Reconnect"
        //   no credential    → "Connect"
        //   manual-only      → nothing; the user's own number needs no login.
        const connectBtn = document.createElement('button');
        connectBtn.className = 'account-connect-btn';
        const syncConnectAction = () => {
            const providerName = account.provider === 'chatgpt' ? 'ChatGPT' : 'Claude';
            // A locked keychain gets the same non-actionable treatment as the
            // card: the credential is there, and signing in again cannot open
            // it, so offering "Reconnect" would be misleading.
            if (hasKeychainProblem(account)) {
                connectBtn.textContent = 'Storage locked';
                connectBtn.disabled = true;
                connectBtn.classList.add('not-actionable');
                connectBtn.title = 'The saved login is still stored but the system keychain will not open it. '
                    + 'Reconnecting cannot repair that, and nothing has been deleted.';
            } else {
                connectBtn.disabled = false;
                connectBtn.classList.remove('not-actionable');
                connectBtn.textContent = account.hasSession ? 'Reconnect' : 'Connect';
                connectBtn.title = account.hasSession
                    ? `Sign in to ${providerName} again for this account. The saved login is kept until the new one is saved; history and manual settings are untouched.`
                    : `Sign in to ${providerName} for this account. History and manual settings are untouched.`;
            }
            connectBtn.style.display = isManualOnlyAccount(account) ? 'none' : 'inline-flex';
        };
        syncConnectAction();
        connectBtn.addEventListener('click', () => {
            if (connectBtn.disabled) return;
            reconnectAccount(account.id);
        });

        const manualBtn = document.createElement('button');
        manualBtn.className = 'account-manual-btn';
        manualBtn.textContent = 'Manual';
        if (account.manual && account.manual.enabled) manualBtn.classList.add('active');
        manualBtn.addEventListener('click', () => toggleManualEditor(account, editor));

        const removeBtn = document.createElement('button');
        removeBtn.className = 'account-remove-btn';
        removeBtn.textContent = 'Remove';

        // Removal deletes the credential, the history and everything in the
        // account's partition, and none of it comes back. It used to happen on
        // the first click with no confirmation at all. The confirmation names
        // the account and says what is lost, so it cannot be mistaken for
        // cancelling an add or a reconnect.
        const confirmRow = document.createElement('div');
        confirmRow.className = 'account-remove-confirm';
        confirmRow.dataset.accountId = account.id;
        confirmRow.style.display = 'none';
        const confirmText = document.createElement('span');
        confirmText.className = 'account-remove-confirm-text';
        const confirmYes = document.createElement('button');
        confirmYes.className = 'account-remove-confirm-yes';
        confirmYes.textContent = 'Remove';
        const confirmNo = document.createElement('button');
        confirmNo.className = 'account-remove-confirm-no';
        confirmNo.textContent = 'Keep';
        confirmRow.appendChild(confirmText);
        confirmRow.appendChild(confirmYes);
        confirmRow.appendChild(confirmNo);

        const closeConfirm = () => {
            confirmRow.style.display = 'none';
            removeBtn.textContent = 'Remove';
            removeBtn.disabled = false;
        };
        confirmNo.addEventListener('click', closeConfirm);
        confirmYes.addEventListener('click', async () => {
            confirmYes.disabled = true;
            confirmNo.disabled = true;
            confirmYes.textContent = 'Removing';
            const gone = await removeAccountFromUI(account.id);
            if (!gone) {
                // Nothing was removed. Put the controls back so the question
                // can be answered again, with the failure shown above it.
                confirmYes.disabled = false;
                confirmNo.disabled = false;
                confirmYes.textContent = 'Remove';
            }
        });

        removeBtn.addEventListener('click', async () => {
            if (confirmRow.style.display !== 'none') { closeConfirm(); return; }
            let samples = null;
            try {
                const history = await window.electronAPI.getUsageHistory(account.id);
                samples = Array.isArray(history) ? history.length : null;
            } catch (error) {
                debugLog('history count unavailable for', account.id, error);
            }
            const historyPhrase = samples === null
                ? 'its usage history'
                : `${samples} recorded usage ${samples === 1 ? 'sample' : 'samples'}`;
            confirmText.textContent = `Remove “${account.label}”? Its saved login and ${historyPhrase} are deleted and cannot be recovered.`;
            confirmRow.style.display = 'flex';
            removeBtn.textContent = 'Cancel';
            confirmYes.focus();
        });

        row.appendChild(tag);
        row.appendChild(input);
        row.appendChild(connectBtn);
        row.appendChild(manualBtn);
        row.appendChild(removeBtn);
        elements.accountsList.appendChild(row);

        // Manual-entry editor, shown under the row on demand. Saving a manual
        // override changes whether a login action applies, so the row is kept
        // in step without rebuilding the list under the open editor.
        //
        // Order matters: the editor stays the row's immediate next sibling.
        // The removal confirmation goes after it, addressed by account id
        // rather than by position.
        const editor = buildManualEditor(account, syncConnectAction);
        elements.accountsList.appendChild(editor);
        elements.accountsList.appendChild(confirmRow);
    }
}

function buildManualEditor(account, onManualSaved) {
    const editor = document.createElement('div');
    editor.className = 'account-manual-editor';
    editor.style.display = 'none';

    const manual = account.manual || { enabled: false, used: 0, limit: 0 };

    const enabledRow = document.createElement('label');
    enabledRow.className = 'account-manual-enabled';
    const enabledCheck = document.createElement('input');
    enabledCheck.type = 'checkbox';
    enabledCheck.checked = !!manual.enabled;
    enabledRow.appendChild(enabledCheck);
    enabledRow.appendChild(document.createTextNode(' Use manual entry (overrides auto-read)'));
    editor.appendChild(enabledRow);

    const inputsRow = document.createElement('div');
    inputsRow.className = 'account-manual-inputs';
    const usedInput = document.createElement('input');
    usedInput.type = 'number';
    usedInput.min = '0';
    usedInput.placeholder = 'Used';
    usedInput.value = manual.used != null ? manual.used : '';
    const limitInput = document.createElement('input');
    limitInput.type = 'number';
    limitInput.min = '1';
    limitInput.placeholder = 'Limit';
    limitInput.value = manual.limit != null ? manual.limit : '';
    inputsRow.appendChild(usedInput);
    inputsRow.appendChild(document.createTextNode(' / '));
    inputsRow.appendChild(limitInput);

    const saveBtn = document.createElement('button');
    saveBtn.className = 'account-manual-save';
    saveBtn.textContent = 'Save';
    const status = document.createElement('span');
    status.className = 'account-manual-status';

    const footerRow = document.createElement('div');
    footerRow.className = 'account-manual-footer';
    footerRow.appendChild(saveBtn);
    footerRow.appendChild(status);

    saveBtn.addEventListener('click', async () => {
        // `parseFloat(x) || 0` used to turn an empty box, "abc" and "-5" all
        // into 0 and save them, after which the card said "unavailable" with
        // no explanation. Invalid input is now refused with a reason.
        const validation = validateManualEntry({
            enabled: enabledCheck.checked,
            used: usedInput.value,
            limit: limitInput.value
        });
        if (!validation.valid) {
            status.textContent = describeManualErrors(validation.errors);
            status.classList.add('error');
            const firstBad = validation.errors[0].field;
            (firstBad === 'limit' ? limitInput : usedInput).focus();
            return;
        }
        status.classList.remove('error');

        const result = await window.electronAPI.saveAccountManual(account.id, validation.manual);
        if (result && result.ok === false) {
            status.textContent = result.errors ? describeManualErrors(result.errors) : 'Could not save these numbers.';
            status.classList.add('error');
            return;
        }
        const manualData = validation.manual;
        // Reflect exactly what was stored, so the boxes cannot drift from the
        // saved values.
        usedInput.value = String(manualData.used);
        limitInput.value = String(manualData.limit);
        account.manual = manualData;
        if (onManualSaved) onManualSaved();
        status.textContent = 'Saved ✓';
        setTimeout(() => { status.textContent = ''; }, 2000);
        // Refresh the card immediately with the new manual values.
        await fetchAccount(account.id);
    });

    editor.appendChild(inputsRow);
    editor.appendChild(footerRow);
    return editor;
}

function toggleManualEditor(account, editor) {
    const visible = editor.style.display !== 'none';
    editor.style.display = visible ? 'none' : 'block';
}

// -- Removal results the user can act on -------------------------------------
//
// remove-account reports exactly what it managed to delete. This used to be
// thrown away and the card removed regardless, so a removal that left the
// credential, the history or the partition behind looked identical to one that
// worked - and the account was back at the next launch with no explanation.
//
// Failures are held here (by account id) so they survive the list re-render,
// and each carries its own retry.
const removalFailuresById = new Map();

const REMOVAL_LEFTOVERS = {
    account: 'the account itself',
    credential: 'its saved login',
    history: 'its usage history',
    partition: 'its browser data',
    'partition-storage': 'its browser storage',
    'partition-cache': 'its browser cache',
    'partition-authCache': 'its cached sign-in',
    'pending-writes': 'a sign-in write that had not finished'
};

function describeRemovalLeftovers(remaining) {
    const names = [];
    for (const item of remaining || []) {
        const name = REMOVAL_LEFTOVERS[item.what] || item.what;
        if (!names.includes(name)) names.push(name);
    }
    if (!names.length) return 'some of its data';
    if (names.length === 1) return names[0];
    return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}

function buildRemovalFailureNotice(accountId, failure) {
    const notice = document.createElement('div');
    notice.className = 'account-remove-failure';
    notice.dataset.accountId = accountId;
    notice.setAttribute('role', 'alert');

    const text = document.createElement('span');
    text.className = 'account-remove-failure-text';
    text.textContent = failure.message;
    notice.appendChild(text);

    const retry = document.createElement('button');
    retry.className = 'account-remove-failure-retry';
    retry.textContent = 'Try again';
    retry.addEventListener('click', async () => {
        retry.disabled = true;
        retry.textContent = 'Retrying';
        const ok = await removeAccountFromUI(accountId, { retry: true });
        if (!ok) {
            retry.disabled = false;
            retry.textContent = 'Try again';
        }
    });
    notice.appendChild(retry);

    const dismiss = document.createElement('button');
    dismiss.className = 'account-remove-failure-dismiss';
    // Same 11px currentColor cross as the banner dismissals, so a control the
    // renderer builds is not the one place with a text glyph.
    dismiss.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
        + ' stroke-width="2.2" stroke-linecap="round" aria-hidden="true">'
        + '<line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></svg>';
    dismiss.title = 'Dismiss';
    dismiss.setAttribute('aria-label', 'Dismiss');
    dismiss.addEventListener('click', () => {
        removalFailuresById.delete(accountId);
        renderAccountsList();
    });
    notice.appendChild(dismiss);
    return notice;
}

/**
 * Turn a remove-account result into either nothing (it worked) or a message
 * that says what is still there. Never claims a clean removal it cannot prove.
 */
function classifyRemovalResult(accountId, label, result) {
    const name = label || 'This account';
    if (!result || result.ok === false) {
        const reason = result && result.reason;
        if (reason === 'unknown-account') return null; // already gone
        const detail = (result && (result.detail || result.reason)) || 'the request failed';
        return {
            removed: false,
            message: '\u201c' + name + '\u201d could not be removed (' + detail + '). Nothing was deleted.'
        };
    }
    if (result.persisted === false) {
        const why = (result.remaining && result.remaining[0] && result.remaining[0].detail)
            || result.detail || 'unknown reason';
        return {
            removed: true,
            message: '\u201c' + name + '\u201d was removed from this window, but '
                + describeRemovalLeftovers(result.remaining) + ' could not be deleted (' + why + ').'
                + ' It will be back the next time the app starts.'
        };
    }
    return null;
}

/**
 * Remove an account through the rendered controls and report the truth.
 *
 * @returns {Promise<boolean>} whether the account is gone from the list. A
 *   refused removal keeps the row so there is something to retry from.
 */
async function removeAccountFromUI(accountId, options = {}) {
    const known = accounts.find(a => a.id === accountId);
    const remembered = removalFailuresById.get(accountId);
    const label = known ? known.label : (remembered && remembered.label);

    let result;
    try {
        result = await window.electronAPI.removeAccount(accountId);
    } catch (error) {
        result = { ok: false, reason: 'ipc-failed', detail: String((error && error.message) || error) };
    }

    const failure = classifyRemovalResult(accountId, label, result);
    if (failure) {
        removalFailuresById.set(accountId, Object.assign({}, failure, { label }));
    } else {
        removalFailuresById.delete(accountId);
    }

    // A removal the main process refused changed nothing: keep the row so the
    // user has something to retry from.
    if (failure && failure.removed === false) {
        renderAccountsList();
        return false;
    }

    accounts = accounts.filter(a => a.id !== accountId);
    delete usageByAccount[accountId];
    delete alertFiredByAccount[accountId];
    expiredAccounts.delete(accountId);
    const entry = cardsById.get(accountId);
    if (entry) { entry.card.remove(); cardsById.delete(accountId); }
    renderAccountsList();
    if (accounts.length === 0) {
        // A failed removal is the one thing worth staying in Settings for: the
        // onboarding screen has nowhere to put the retry.
        if (removalFailuresById.size) {
            renderAccountsList();
            updateWidgetFooter();
            return true;
        }
        elements.settingsOverlay.style.display = 'none';
        startAddAccount({ fromSettings: false });
    } else {
        updateWidgetFooter();
        refreshWorstAccountBadge();
        if (selectedGraphAccountId === accountId) selectedGraphAccountId = null;
        // Removing an account changes the list height, so the graph re-decides.
        applyGraphLayout();
        if (graphVisible && !graphSuppressed) await loadChart();
    }
    return true;
}

// ── Legacy extra rows (Claude extended API fields, hidden expand panel) ──────
// Format a cent-based amount with the correct currency symbol.
function formatCurrency(amountCents, currencyCode) {
  const amount = (amountCents / 100).toFixed(2);
  const symbols = { USD: '$', EUR: '€', GBP: '£' };
  const sym = symbols[currencyCode];
  return sym ? `${sym}${amount}` : `${amount} ${currencyCode || 'USD'}`;
}

// Extra row label mapping for API fields. Raw provider payload lives on
// data.raw (normalized shape), so read from there.
const EXTRA_ROW_CONFIG = {
    seven_day_sonnet: { label: 'Sonnet (7d)', color: 'sonnet' },
    seven_day_opus: { label: 'Opus (7d)', color: 'opus' },
    seven_day_cowork: { label: 'Cowork (7d)', color: 'cowork' },
    seven_day_omelette: { label: 'Design (7d)', color: 'design' },
    seven_day_oauth_apps: { label: 'OAuth Apps (7d)', color: 'oauth' },
    extra_usage: { label: 'Extra Usage', color: 'extra' },
};

function buildExtraRows(data) {
    const raw = data?.raw || data;
    // Don't clear existing rows if we don't have new data to replace them with
    const hasAnyExtendedData = Object.entries(EXTRA_ROW_CONFIG).some(([key, config]) => {
        const value = raw?.[key];
        const hasUtilization = value && value.utilization !== undefined;
        const hasBalance = key === 'extra_usage' && value && value.balance_cents != null;
        return hasUtilization || hasBalance;
    });

    // Only rebuild if we have data, otherwise keep existing rows
    if (!hasAnyExtendedData && elements.extraRows.children.length > 0) {
        return; // Keep existing rows
    }

    elements.extraRows.innerHTML = '';
    let count = 0;

    for (const [key, config] of Object.entries(EXTRA_ROW_CONFIG)) {
        const value = raw?.[key];
        // extra_usage is valid with utilization OR balance_cents (prepaid only)
        const hasUtilization = value && value.utilization !== undefined;
        const hasBalance = key === 'extra_usage' && value && value.balance_cents != null;
        if (!hasUtilization && !hasBalance) continue;

        // Same rule as the main rows: a percentage that is not a reading shows a
        // dash and a neutral band, never a green 0%.
        const reading = readPercent(value.utilization);
        const utilization = reading === null ? 0 : reading;
        const readingStatus = statusClassFor(reading);
        const resetsAt = value.resets_at;
        const colorClass = config.color;

        const row = document.createElement('div');
        row.className = 'usage-section';

        // Build row using DOM methods (no innerHTML)
        const label = document.createElement('span');
        label.className = 'usage-label';

        if (key === 'extra_usage') {
            // Extra usage: ON/OFF indicator goes next to label
            if (value.is_enabled === true) {
                const statusTag = document.createElement('span');
                statusTag.className = 'extra-status on';
                statusTag.textContent = 'ON';
                label.appendChild(statusTag);
            } else if (value.is_enabled === false) {
                const statusTag = document.createElement('span');
                statusTag.className = 'extra-status off';
                statusTag.textContent = 'OFF';
                label.appendChild(statusTag);
            }
            label.appendChild(document.createTextNode(' Extra Usage'));
        } else {
            label.textContent = config.label;
        }
        row.appendChild(label);

        if (key === 'extra_usage') {
            // Extra usage: bar col shows $used/$limit, elapsed col empty, timer col shows account credits
            const barGroup = document.createElement('div');
            barGroup.className = 'usage-bar-group';
            const progressBar = document.createElement('div');
            progressBar.className = 'progress-bar';
            const progressFill = document.createElement('div');
            progressFill.className = `progress-fill ${colorClass}`;
            progressFill.style.width = reading === null ? '0%' : `${utilization}%`;

            // Fixed status bands on the extra usage bar too
            progressFill.classList.add(`status-${readingStatus}`);

            progressBar.appendChild(progressFill);
            barGroup.appendChild(progressBar);

            const percentage = document.createElement('span');
            if (value.used_cents != null && value.limit_cents != null) {
                percentage.className = 'usage-percentage extra-spending';
                percentage.textContent = `${formatCurrency(value.used_cents, value.currency)}/${formatCurrency(value.limit_cents, value.currency)}`;
            } else {
                percentage.className = `usage-percentage status-${readingStatus}`;
                percentage.textContent = reading === null ? '—' : `${reading}%`;
            }
            barGroup.appendChild(percentage);
            row.appendChild(barGroup);

            const timerText = document.createElement('span');
            timerText.className = 'timer-text extra-balance-label';
            timerText.textContent = 'Account Credits:';
            row.appendChild(timerText);

            const resetsText = document.createElement('span');
            resetsText.className = 'resets-at-text extra-balance-amount';
            if (value.balance_cents != null) {
                resetsText.textContent = formatCurrency(value.balance_cents, value.currency);
            }
            row.appendChild(resetsText);
        } else {
            const barGroup = document.createElement('div');
            barGroup.className = 'usage-bar-group';
            const progressBar = document.createElement('div');
            progressBar.className = 'progress-bar';
            const progressFill = document.createElement('div');
            progressFill.className = `progress-fill ${colorClass} status-${readingStatus}`;
            progressFill.style.width = reading === null ? '0%' : `${utilization}%`;
            progressBar.appendChild(progressFill);
            barGroup.appendChild(progressBar);

            const percentage = document.createElement('span');
            percentage.className = `usage-percentage status-${readingStatus}`;
            percentage.textContent = reading === null ? '—' : `${reading}%`;
            barGroup.appendChild(percentage);
            row.appendChild(barGroup);

            const timerText = document.createElement('div');
            timerText.className = 'timer-text';
            timerText.dataset.resets = resetsAt || '';
            timerText.textContent = '--:--';
            row.appendChild(timerText);

            const resetsText = document.createElement('span');
            resetsText.className = 'resets-at-text';
            if (resetsAt) {
                const settings = window._cachedSettings || {};
                resetsText.textContent = formatResetsAt(resetsAt, true, settings.timeFormat || '12h', settings.weeklyDateFormat || 'date');
            }
            row.appendChild(resetsText);
        }

        elements.extraRows.appendChild(row);
        count++;
    }

    // Hide toggle if no extra rows
    elements.expandToggle.style.display = count > 0 ? 'flex' : 'none';
    if (count === 0 && isExpanded) {
        isExpanded = false;
        elements.expandArrow.classList.remove('expanded');
        elements.expandSection.style.display = 'none';
    }

    return count;
}

function refreshExtraTimers() {
    elements.extraRows.querySelectorAll('.timer-text').forEach((textEl) => {
        const resetsAt = textEl.dataset.resets;
        if (resetsAt) updateTimer(textEl, resetsAt);
    });
}

// ── Usage alerts ─────────────────────────────────────────────────────────────
// Fire OS desktop notifications when a row crosses the fixed orange (80%) or
// red (95%) thresholds. Only fires once per crossing per row per account —
// flags reset when the row drops back below 80.
function checkUsageAlerts(account, data) {
    const settings = window._cachedSettings || {};
    if (!settings.usageAlerts) return;

    // Only a fresh, successful reading may fire an alert or clear a fired flag.
    // A stale, unavailable or fallback payload says nothing about current usage,
    // so treating it as "below 80" would reset the flags and re-alert later.
    if (!isTrustedReading(data)) return;

    const alertFired = getAlertFlags(account.id);
    const rows = normalizeRows(data);

    for (const row of rows) {
        // A row with no reading is skipped entirely — flags left untouched.
        if (!isRowAvailable(row)) continue;
        const pct = readPercent(row.utilization);
        if (pct === null) continue;
        const fired = alertFired[row.key] || { warn: false, danger: false };
        alertFired[row.key] = fired;

        // Reset flags when the window resets (utilization drops back low)
        if (pct < WARN_THRESHOLD) {
            fired.warn = false;
            fired.danger = false;
        }

        if (pct >= DANGER_THRESHOLD && !fired.danger) {
            fired.danger = true;
            fired.warn = true; // suppress warn if we jumped straight to danger
            window.electronAPI.showNotification(
                `${account.label} — ${row.label} at ${Math.round(pct)}%`,
                'Usage has reached the red zone'
            );
        } else if (pct >= WARN_THRESHOLD && !fired.warn) {
            fired.warn = true;
            window.electronAPI.showNotification(
                `${account.label} — ${row.label} at ${Math.round(pct)}%`,
                'Usage has reached the orange zone'
            );
        }
    }
}

// Persist graph/expanded visibility state — debounced to avoid hammering disk on rapid toggles
let _saveViewStateTimer = null;
async function _saveViewState() {
    if (appInitializing) return;
    if (_saveViewStateTimer) clearTimeout(_saveViewStateTimer);
    _saveViewStateTimer = setTimeout(async () => {
        const settings = window._cachedSettings || await window.electronAPI.getSettings();
        settings.graphVisible = graphVisible;
        settings.expandedOpen = isExpanded;
        window._cachedSettings = settings;
        await window.electronAPI.saveSettings(settings);
    }, 300);
}

// Per-account, per-row usage alert flags — which thresholds have already fired
// for that row's current window. Prevents repeat notifications on every
// refresh cycle.
const alertFiredByAccount = {}; // accountId -> { rowKey: { warn, danger } }
function getAlertFlags(accountId) {
    if (!alertFiredByAccount[accountId]) {
        alertFiredByAccount[accountId] = {};
    }
    return alertFiredByAccount[accountId];
}

function startCountdown() {
    if (countdownInterval) clearInterval(countdownInterval);
    countdownInterval = setInterval(() => {
        refreshAllCardTimers();
        refreshExtraTimers();
    }, 30000);
}

// Format reset date for the "Resets At" column
// Session: shows time like "3:59 PM" or "15:59"
// Weekly: shows date like "Mar 13", "Fri Mar 13", or "Fri Mar 13 3:59 PM"
function formatResetsAt(resetsAt, isWeekly, timeFormat, weeklyDateFormat) {
    if (!resetsAt) return '—';
    const date = new Date(resetsAt);
    const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    const formatTime = (d) => {
        if (timeFormat === '24h') {
            return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
        } else {
            let hours = d.getHours();
            const minutes = d.getMinutes().toString().padStart(2, '0');
            const ampm = hours >= 12 ? 'PM' : 'AM';
            hours = hours % 12 || 12;
            return `${hours}:${minutes} ${ampm}`;
        }
    };

    if (isWeekly) {
        const dayStr = days[date.getDay()];
        const monthStr = months[date.getMonth()];
        const dayNum = date.getDate();
        const fmt = weeklyDateFormat || 'date';
        if (fmt === 'date-day') return `${dayStr} ${monthStr} ${dayNum}`;
        if (fmt === 'date-day-time') return `${dayStr} ${monthStr} ${dayNum} ${formatTime(date)}`;
        return `${monthStr} ${dayNum}`; // default: 'date'
    } else {
        return formatTime(date);
    }
}

// Countdown text for one expanded usage row. The elapsed circle these rows
// used to carry is gone; the remaining-time text it sat next to is unchanged.
function updateTimer(textElement, resetsAt) {
    if (!resetsAt) {
        textElement.textContent = 'Not started';
        textElement.style.opacity = '0.55';
        textElement.title = 'Starts when a message is sent';
        return;
    }

    // Clear the greyed out styling when the timer is active
    textElement.style.opacity = '1';
    textElement.title = '';

    const diff = new Date(resetsAt) - new Date();

    if (diff <= 0) {
        textElement.textContent = 'Resetting...';
        return;
    }

    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

    if (hours >= 24) {
        const days = Math.floor(hours / 24);
        textElement.textContent = `${days}d ${hours % 24}h`;
    } else if (hours > 0) {
        textElement.textContent = `${hours}h ${minutes}m`;
    } else {
        textElement.textContent = `${minutes}m`;
    }
}

// UI State Management
function showMainContent() {
    elements.loadingContainer.style.display = 'none';
    elements.loginContainer.style.display = 'none';
    elements.noUsageContainer.style.display = 'none';
    // 'flex', not 'block': .content is a flex column whose account list is the
    // only part allowed to scroll. As a block, the list grew to its content
    // height and pushed the footer below the bottom of the window.
    elements.mainContent.style.display = 'flex';
    // Restore header buttons after the add-account flow
    elements.settingsBtn.style.display = 'flex';
    elements.refreshBtn.style.display = 'flex';
    elements.graphBtn.style.display = 'flex';
    startCountdown();
}

// Auto-update management
function startAutoUpdate() {
    stopAutoUpdate();
    const settings = window._cachedSettings || {};
    const intervalSecs = parseInt(settings.refreshInterval) || 300;
    updateInterval = setInterval(async () => {
        if (elements.refreshBtn) elements.refreshBtn.classList.add('spinning');
        await pollAllAccounts();
        if (elements.refreshBtn) elements.refreshBtn.classList.remove('spinning');
    }, intervalSecs * 1000);
}

function stopAutoUpdate() {
    if (updateInterval) {
        clearInterval(updateInterval);
        updateInterval = null;
    }
}

// Which account's history the graph is currently showing. Defaults to the
// account with the highest utilization across its rows.
let selectedGraphAccountId = null;
function computeWorstAccountId() {
    let worstId = null;
    let worstVal = -1;
    for (const account of accounts) {
        const data = usageByAccount[account.id];
        if (!data) continue;
        const maxPct = maxAvailableUtilization(normalizeRows(data));
        if (maxPct === null) continue; // no reading — cannot be the worst account
        if (maxPct > worstVal) {
            worstVal = maxPct;
            worstId = account.id;
        }
    }
    return worstId;
}

// One chip per account above the chart; only shown once there's more than one
// account to choose between. Clicking a chip reloads the chart for that account.
function renderGraphChips() {
    const container = document.getElementById('graphAccountChips');
    if (!container) return;
    container.innerHTML = '';
    if (accounts.length < 2) {
        container.style.display = 'none';
        return;
    }
    container.style.display = 'flex';
    for (const account of accounts) {
        const chip = document.createElement('button');
        chip.className = 'graph-account-chip';
        chip.textContent = account.label;
        chip.classList.toggle('active', account.id === selectedGraphAccountId);
        chip.addEventListener('click', async () => {
            selectedGraphAccountId = account.id;
            await loadChart();
        });
        container.appendChild(chip);
    }
}

async function loadChart() {
    if (!accounts.length) return;
    if (!selectedGraphAccountId || !accounts.some((a) => a.id === selectedGraphAccountId)) {
        selectedGraphAccountId = computeWorstAccountId() || accounts[0].id;
    }
    renderGraphChips();

    const history = await window.electronAPI.getUsageHistory(selectedGraphAccountId);
    if (!history.length) {
        if (usageChart) { usageChart.destroy(); usageChart = null; }
        return;
    }
    renderChart(history);
}

// The chart is drawn on a canvas, so it cannot inherit CSS. Read the same
// tokens the stylesheet defines and hand them to Chart.js, so the graph's
// labels, grid and tooltip match the rest of the widget instead of drifting
// into Chart.js defaults.
function chartTheme() {
    const cs = getComputedStyle(document.documentElement);
    const token = (name, fallback) => (cs.getPropertyValue(name) || '').trim() || fallback;
    return {
        family: token('--font-ui', "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"),
        label: token('--row-reset', '#9D9D9D'),
        text: token('--text', '#CCCCCC'),
        muted: token('--muted', '#9D9D9D'),
        grid: token('--line', '#2B2B2B'),
        surface: token('--surface', '#202020'),
        border: token('--border', '#2B2B2B')
    };
}

function renderChart(history) {
    if (usageChart) usageChart.destroy();
    const theme = chartTheme();

    // History samples carry null where a reading was missing (a gap). Those
    // must not be read as 0 when sizing the axis, and stepped lines must break
    // at them rather than joining across a period with no data.
    const allValues = history
        .flatMap((entry) => [entry.session, entry.weekly])
        .filter((value) => typeof value === 'number' && Number.isFinite(value));
    const peak = allValues.length ? Math.max(...allValues) : 0;
    const yMax = Math.max(10, Math.ceil(peak / 10) * 10);

    const datasets = [
        {
            label: 'Short',
            data: history.map((entry) => ({ x: entry.timestamp, y: entry.session })),
            borderColor: theme.text,
            backgroundColor: 'transparent',
            borderWidth: 2,
            spanGaps: false,
            stepped: true,
            pointRadius: 0,
            pointHoverRadius: 3,
            pointHitRadius: 10
        },
        {
            label: 'Weekly',
            data: history.map((entry) => ({ x: entry.timestamp, y: entry.weekly })),
            borderColor: theme.muted,
            backgroundColor: 'transparent',
            borderWidth: 2,
            spanGaps: false,
            stepped: true,
            pointRadius: 0,
            pointHoverRadius: 3,
            pointHitRadius: 10
        }
    ];

    const firstDayMidnight = new Date(history[0].timestamp);
    firstDayMidnight.setHours(0, 0, 0, 0);

    usageChart = new Chart(elements.usageChart.getContext('2d'), {
        type: 'line',
        data: { datasets },
        options: {
            animation: false,
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                intersect: false,
                mode: 'nearest'
            },
            scales: {
                x: {
                    type: 'linear',
                    min: firstDayMidnight.getTime(),
                    max: history[history.length - 1].timestamp,
                    afterBuildTicks(axis) {
                        const end = history[history.length - 1].timestamp;
                        const d = new Date(firstDayMidnight.getTime());
                        const ticks = [];
                        while (d.getTime() <= end) {
                            ticks.push({ value: d.getTime() });
                            d.setDate(d.getDate() + 1);
                        }
                        axis.ticks = ticks;
                    },
                    ticks: {
                        maxRotation: 0,
                        minRotation: 0,
                        font: { family: theme.family, size: 11 },
                        color: theme.label,
                        callback(value) {
                            const tf = (window._cachedSettings || {}).timeFormat || '12h';
                            const spanMs = history.length > 1
                                ? history[history.length - 1].timestamp - history[0].timestamp
                                : 0;
                            return formatTimestampTick(value, spanMs, tf);
                        }
                    },
                    grid: {
                        display: false
                    }
                },
                y: {
                    min: 0,
                    max: yMax,
                    ticks: {
                        font: { family: theme.family, size: 11 },
                        color: theme.label,
                        callback: (value) => `${value}%`
                    },
                    grid: {
                        color: theme.grid
                    }
                }
            },
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    backgroundColor: theme.surface,
                    borderColor: theme.border,
                    borderWidth: 1,
                    titleColor: theme.text,
                    bodyColor: theme.text,
                    titleFont: { family: theme.family, size: 11 },
                    bodyFont: { family: theme.family, size: 11 },
                    callbacks: {
                        title(items) {
                            return new Date(items[0].parsed.x).toLocaleString([], {
                                month: 'short',
                                day: 'numeric',
                                hour: 'numeric',
                                minute: '2-digit'
                            });
                        },
                        label(item) {
                            return `${item.dataset.label}: ${Math.round(item.parsed.y)}%`;
                        }
                    }
                }
            }
        }
    });
}

function formatTimestampTick(timestamp, spanMs, timeFormat) {
    const date = new Date(timestamp);
    const hour12 = (timeFormat || '12h') !== '24h';

    if (spanMs < 12 * 60 * 60 * 1000) {
        return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12 });
    }
    if (spanMs < 48 * 60 * 60 * 1000) {
        return date.toLocaleString([], { weekday: 'short', hour: 'numeric', hour12 });
    }
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// Add spinning animation for refresh button
const style = document.createElement('style');
style.textContent = `
    @keyframes spin-refresh {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
    }

    .refresh-btn.spinning svg {
        animation: spin-refresh 1s linear infinite;
    }
`;
document.head.appendChild(style);

// ── Settings management ──────────────────────────────────────────────────────
async function loadSettings() {
    const settings = await window.electronAPI.getSettings();
    const isPortable = window.electronAPI.isPortable;
    // Autostart works on Linux too now (implemented via the XDG autostart spec
    // in main.js) — only portable Windows builds can't support it reliably.
    const autoStartUnsupported = isPortable;

    elements.autoStartToggle.checked = autoStartUnsupported ? false : settings.autoStart;
    elements.autoStartToggle.disabled = autoStartUnsupported;
    if (elements.autoStartCol) {
        elements.autoStartCol.classList.toggle('settings-col-disabled', autoStartUnsupported);
    }
    if (elements.autoStartHint) {
        elements.autoStartHint.style.display = autoStartUnsupported ? 'inline' : 'none';
        elements.autoStartHint.textContent = 'Not supported in portable mode!';
    }
    elements.minimizeToTrayToggle.checked = settings.minimizeToTray;
    elements.alwaysOnTopToggle.checked = settings.alwaysOnTop;
    elements.showTrayStatsToggle.checked = settings.showTrayStats || false;
    elements.timeFormat.value = settings.timeFormat || '12h';
    elements.weeklyDateFormat.value = settings.weeklyDateFormat || 'date';
    if (elements.refreshInterval) elements.refreshInterval.value = settings.refreshInterval || '300';
    elements.usageAlertsToggle.checked = settings.usageAlerts !== false;

    // Render the accounts management list; the single-account "Log Out" is gone
    // (accounts are removed individually from the list).
    renderAccountsList();
    if (elements.logoutBtn) elements.logoutBtn.style.display = 'none';

    if (window.electronAPI.platform === 'darwin') {
        document.getElementById('trayLabel').textContent = 'Hide from Dock';
    }
}

async function saveSettings() {
    const settings = {
        autoStart: window.electronAPI.isPortable ? false : elements.autoStartToggle.checked,
        minimizeToTray: elements.minimizeToTrayToggle.checked,
        alwaysOnTop: elements.alwaysOnTopToggle.checked,
        showTrayStats: elements.showTrayStatsToggle.checked,
        timeFormat: elements.timeFormat.value || '12h',
        weeklyDateFormat: elements.weeklyDateFormat.value || 'date',
        refreshInterval: elements.refreshInterval ? (elements.refreshInterval.value || '300') : '300',
        usageAlerts: elements.usageAlertsToggle.checked,
        graphVisible: graphVisible,
        expandedOpen: isExpanded
    };
    await window.electronAPI.saveSettings(settings);
    window._cachedSettings = settings;
    if (window.electronAPI.platform === 'darwin') {
        document.getElementById('trayLabel').textContent = 'Hide from Dock';
    }

    // Re-render each card so new time formats apply immediately
    for (const account of accounts) {
        if (usageByAccount[account.id]) updateAccountCard(account.id, usageByAccount[account.id]);
    }
    // Restart auto-update with new interval if it changed
    startAutoUpdate();
}

// Update check
async function checkForUpdate() {
    try {
        const result = await window.electronAPI.checkForUpdate();
        if (!result.hasUpdate) return;

        const version = result.version;

        // Show the update banner. It takes height from the same column as the
        // account list and the graph, so the graph has to re-decide what fits;
        // without this the banner ate the account list's reserved space.
        elements.updateBannerText.textContent = `▲  Version ${version} available — click to download`;
        elements.updateBanner.style.display = 'flex';
        relayoutGraphNow();

        // Populate settings panel link if already visible
        if (elements.settingsUpdateLink) {
            elements.settingsUpdateLink.textContent = `→ v${version} available`;
            elements.settingsUpdateLink.style.display = 'inline';
        }

        debugLog(`Update available: v${version}`);
    } catch (e) {
        debugLog('Update check failed silently', e);
    }
}

// Start the application
init();
window.addEventListener('beforeunload', () => {
    stopAutoUpdate();
    if (countdownInterval) clearInterval(countdownInterval);
});
