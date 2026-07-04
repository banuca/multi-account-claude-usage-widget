// Application state
let updateInterval = null;
let countdownInterval = null;
let isExpanded = false;
let usageChart = null;
let graphVisible = false;
let appInitializing = true;  // suppresses _saveViewState during startup restore

// v2.0 free-resize model: the user owns the window size. These are the only
// two fixed sizes left — the design default for a true first run, and the
// minimum height the settings panel temporarily grows to if the window is
// shorter than that when it's opened (restored on close).
const DEFAULT_WINDOW_WIDTH = 640;
const SETTINGS_MIN_HEIGHT = 540;

// ── Multi-account state ──────────────────────────────────────────────────────
let accounts = [];                    // [{ id, label, orgId, organizations, hasSession }]
const cardsById = new Map();          // accountId -> { card, els } scoped card elements
const usageByAccount = {};            // accountId -> latest usage data (renderer copy)
const fetchingAccounts = new Set();   // per-account in-flight guard
const expiredAccounts = new Set();    // accountIds whose session has expired (need reconnect)
let draftAccount = null;              // { id, partition, label } while adding an account
let addingFromSettings = false;       // true when the add-flow was launched with accounts present
let pendingValidation = null;         // { sessionKey, organizations } awaiting an org pick

// Fork release page (in-app update check + banner link)
const RELEASES_URL = 'https://github.com/banuca/multi-account-claude-usage-widget/releases/latest';

// ── Theme system ─────────────────────────────────────────────────────────────
// Dark + Light, values copied verbatim from the "Slate" mockup's design token
// table — the mockup is the source of truth for every value here. Accent,
// warn/danger, session/weekly bar colors and the app logo gradient are
// identical across both themes (only the neutrals invert), matching the old
// system's rule that limit-signal colors read the same in every theme.
const ACCENT_SOLID = '#8b7cf6';
const ACCENT_SOFT = '#8b7cf626';
const ACCENT_BORDER = '#8b7cf65c';
const ACCENT_GLOW = '#8b7cf659';
const WARN = '#e8a33d';
const DANGER = '#e5484d';
const DANGER_SOFT_BG = 'rgba(229,72,77,.12)';
const DANGER_BORDER = 'rgba(229,72,77,.38)';
const DANGER_TEXT = '#f2848b';
const SESSION_GRAD = 'linear-gradient(90deg,#f2b25c,#e08a2e)';
const SESSION_GLOW = '0 0 10px rgba(232,150,60,.35)';
const WEEKLY_GRAD = 'linear-gradient(90deg,#5b8def,#3e6fd9)';
const WEEKLY_GLOW = '0 0 10px rgba(80,130,230,.3)';
const LOGO_GRAD = 'linear-gradient(140deg,#F09A52,#D96A3B)';
const LOGO_SHADOW = '0 2px 8px rgba(217,106,59,.35)';
const COFFEE_SOFT_BG = 'rgba(232,163,61,.08)';
const COFFEE_BORDER = 'rgba(232,163,61,.4)';
const COFFEE_TEXT = '#e8b04e';

const THEMES = {
    dark: {
        bg: '#232129', bg2: '#1c1b22',
        border: 'rgba(255,255,255,.08)', line: 'rgba(255,255,255,.06)',
        text: '#f2f0f5', muted: '#8d899b', faint: '#57536a',
        surface: '#17161d', surfaceBorder: 'rgba(255,255,255,.08)',
        chip: 'rgba(255,255,255,.06)', chipHover: 'rgba(255,255,255,.12)',
        ringTrack: 'rgba(255,255,255,.09)', track: 'rgba(255,255,255,.09)', toggleOff: 'rgba(255,255,255,.12)',
        titlebarBg: 'rgba(0,0,0,.14)', titlebarBorder: 'rgba(255,255,255,.055)',
        shadow: '0 32px 70px -18px rgba(0,0,0,.7), 0 2px 8px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.05)',
        accentInk: '#fff'
    },
    light: {
        bg: '#fbf7f1', bg2: '#f1e9de',
        border: '#efe4d6', line: '#efe5d7',
        text: '#2b2622', muted: '#7c7062', faint: '#a89a8a',
        surface: '#ffffff', surfaceBorder: '#efe4d6',
        chip: '#f2ebe1', chipHover: '#e8ddd0',
        ringTrack: '#efe6da', track: '#efe6da', toggleOff: '#e0d3c2',
        titlebarBg: 'rgba(0,0,0,.04)', titlebarBorder: 'rgba(0,0,0,.06)',
        shadow: '0 24px 50px -18px rgba(80,50,30,.28)',
        accentInk: '#fff'
    }
};

// settings.theme is 'dark' | 'light' | 'system'. Legacy installs stored one of
// the five old named themes — fold those into the closest new value.
function normalizeThemeSetting(theme) {
    if (theme === 'dark' || theme === 'light' || theme === 'system') return theme;
    if (theme === 'daylight') return 'light';
    return 'dark'; // aurora / midnight / nebula / terminal / undefined
}

// Whether the OS is currently in dark mode — only consulted when the setting
// is 'system'. Populated at init and kept live via onSystemThemeUpdated.
let systemPrefersDark = true;
function resolveThemeKey(themeSetting) {
    return themeSetting === 'system' ? (systemPrefersDark ? 'dark' : 'light') : themeSetting;
}

// Debug logging — only shows in DevTools (development mode).
// Regular users won't see verbose logs in production.
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
    loginStep1: document.getElementById('loginStep1'),
    loginStep2: document.getElementById('loginStep2'),
    autoDetectBtn: document.getElementById('autoDetectBtn'),
    autoDetectError: document.getElementById('autoDetectError'),
    openBrowserLink: document.getElementById('openBrowserLink'),
    nextStepBtn: document.getElementById('nextStepBtn'),
    backStepBtn: document.getElementById('backStepBtn'),
    sessionKeyInput: document.getElementById('sessionKeyInput'),
    connectBtn: document.getElementById('connectBtn'),
    sessionKeyError: document.getElementById('sessionKeyError'),
    refreshBtn: document.getElementById('refreshBtn'),
    graphBtn: document.getElementById('graphBtn'),
    minimizeBtn: document.getElementById('minimizeBtn'),
    closeBtn: document.getElementById('closeBtn'),

    expandToggle: document.getElementById('expandToggle'),
    expandArrow: document.getElementById('expandArrow'),
    expandSection: document.getElementById('expandSection'),
    extraRows: document.getElementById('extraRows'),
    graphSection: document.getElementById('graphSection'),
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
    warnThreshold: document.getElementById('warnThreshold'),
    dangerThreshold: document.getElementById('dangerThreshold'),
    themeBtns: document.querySelectorAll('.theme-seg-btn'),
    timeFormat: document.getElementById('timeFormat'),
    weeklyDateFormat: document.getElementById('weeklyDateFormat'),
    refreshInterval: document.getElementById('refreshInterval'),
    orgSelector: document.getElementById('orgSelector'),
    orgSelectorCol: document.getElementById('orgSelectorCol'),

    updateBanner: document.getElementById('updateBanner'),
    updateBannerText: document.getElementById('updateBannerText'),
    updateBannerDismiss: document.getElementById('updateBannerDismiss'),
    settingsVersionLabel: document.getElementById('settingsVersionLabel'),
    settingsUpdateLink: document.getElementById('settingsUpdateLink'),
    usageAlertsToggle: document.getElementById('usageAlertsToggle')
};

// Multi-account element refs (added after the base object above)
elements.accountsContainer = document.getElementById('accountsContainer');
elements.accountCardTemplate = document.getElementById('accountCardTemplate');
elements.loginTitle = document.getElementById('loginTitle');
elements.loginCancelBtn = document.getElementById('loginCancelBtn');
elements.loginStep3 = document.getElementById('loginStep3');
elements.orgPickerSelect = document.getElementById('orgPickerSelect');
elements.orgPickerConfirmBtn = document.getElementById('orgPickerConfirmBtn');
elements.orgPickerError = document.getElementById('orgPickerError');
elements.addAccountBtn = document.getElementById('addAccountBtn');
elements.accountsList = document.getElementById('accountsList');

// Initialize
async function init() {
    setupEventListeners();

    // Apply saved theme and load thresholds immediately
    const settings = await window.electronAPI.getSettings();
    window._cachedSettings = settings;
    systemPrefersDark = await window.electronAPI.getSystemPrefersDark();
    applyTheme(settings.theme);
    if (window.electronAPI.platform === 'darwin') {
        document.getElementById('trayLabel').textContent = 'Hide from Dock';
    }
    warnThreshold = settings.warnThreshold;
    dangerThreshold = settings.dangerThreshold;

    accounts = await window.electronAPI.getAccounts();

    if (accounts.length > 0) {
        renderAccounts();
        showMainContent();
        await pollAllAccounts();
        startAutoUpdate();

        // Restore the graph panel's visibility from the last session.
        if (settings.graphVisible) {
            graphVisible = true;
            elements.graphBtn.classList.add('active');
            elements.graphSection.style.display = 'block';
            await loadChart();
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
}

// Event Listeners
function setupEventListeners() {
    // Add-account flow — step 1: embedded login capture (also handles SSO)
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
        elements.graphBtn.classList.toggle('active', graphVisible);
        elements.graphSection.style.display = graphVisible ? 'block' : 'none';
        if (graphVisible) await loadChart();
        _saveViewState();
    });

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

    // Theme segmented control (Dark/Light/System) — apply live and persist
    // immediately so the choice survives even without pressing Done.
    elements.themeBtns.forEach(btn => {
        btn.addEventListener('click', async () => {
            applyTheme(btn.dataset.theme);
            const settings = window._cachedSettings || await window.electronAPI.getSettings();
            settings.theme = currentThemeSetting;
            window._cachedSettings = settings;
            await window.electronAPI.saveSettings(settings);
        });
    });

    // 'System' follows the OS live — only matters while that's the active setting.
    window.electronAPI.onSystemThemeUpdated((prefersDark) => {
        systemPrefersDark = prefersDark;
        if (currentThemeSetting === 'system') applyTheme('system');
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
// Opens the login container bound to a fresh draft partition. Step 1 = embedded
// login (handles SSO in-window); step 2 = manual sessionKey paste (device-trust
// fallback); step 3 = org picker when the account has more than one chat org.

async function startAddAccount({ fromSettings }) {
    addingFromSettings = fromSettings;
    draftAccount = await window.electronAPI.createDraftAccount();
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

    // Reset to step 1
    elements.loginStep1.style.display = 'flex';
    elements.loginStep2.style.display = 'none';
    elements.loginStep3.style.display = 'none';
    elements.autoDetectError.textContent = '';
    elements.sessionKeyError.textContent = '';
    elements.sessionKeyInput.value = '';
    elements.autoDetectBtn.disabled = false;
    elements.autoDetectBtn.textContent = 'Log in';

    // Cancel is only offered when there are existing accounts to return to
    elements.loginTitle.textContent = draftAccount ? `Add account — ${draftAccount.label}` : 'Add account';
    elements.loginCancelBtn.style.display = accounts.length > 0 ? 'inline-flex' : 'none';

    // Hide header controls during the flow
    elements.settingsBtn.style.display = 'none';
    elements.refreshBtn.style.display = 'none';
    elements.graphBtn.style.display = 'none';
}

function cancelAddAccount() {
    // Discard the un-saved draft partition/id
    if (draftAccount) {
        window.electronAPI.removeAccount(draftAccount.id);
        draftAccount = null;
    }
    pendingValidation = null;
    elements.loginContainer.style.display = 'none';

    if (accounts.length > 0) {
        renderAccounts();
        showMainContent();
        startAutoUpdate();
    } else {
        // Cancelled first-run with no accounts — reopen the flow
        startAddAccount({ fromSettings: false });
    }
}

// Step 2: manual sessionKey connect
async function handleConnect() {
    const sessionKey = elements.sessionKeyInput.value.trim();
    if (!sessionKey) {
        elements.sessionKeyError.textContent = 'Please paste your session key';
        return;
    }
    if (!draftAccount) return;

    elements.connectBtn.disabled = true;
    elements.connectBtn.textContent = '...';
    elements.sessionKeyError.textContent = '';

    try {
        const result = await window.electronAPI.validateSessionKey(sessionKey, draftAccount.partition);
        if (result.success) {
            await onValidated(sessionKey, result);
        } else {
            elements.sessionKeyError.textContent = result.error || 'Invalid session key';
        }
    } catch (error) {
        elements.sessionKeyError.textContent = 'Connection failed. Check your key.';
    } finally {
        elements.connectBtn.disabled = false;
        elements.connectBtn.textContent = 'Connect';
    }
}

// Step 1: embedded login capture (also completes SSO in-window)
async function handleAutoDetect() {
    if (!draftAccount) return;
    elements.autoDetectBtn.disabled = true;
    elements.autoDetectBtn.textContent = 'Waiting...';
    elements.autoDetectError.textContent = '';

    try {
        const result = await window.electronAPI.detectSessionKey(draftAccount.partition);
        if (!result.success) {
            elements.autoDetectError.textContent = result.error || 'Login failed';
            return;
        }

        elements.autoDetectBtn.textContent = 'Validating...';
        const validation = await window.electronAPI.validateSessionKey(result.sessionKey, draftAccount.partition);
        if (validation.success) {
            await onValidated(result.sessionKey, validation);
        } else {
            elements.autoDetectError.textContent = 'Session invalid. Try again or use Manual →';
        }
    } catch (error) {
        elements.autoDetectError.textContent = error.message || 'Login failed';
    } finally {
        elements.autoDetectBtn.disabled = false;
        elements.autoDetectBtn.textContent = 'Log in';
    }
}

// After a sessionKey validates: pick an org (>1) or save straight away.
async function onValidated(sessionKey, validation) {
    const orgs = validation.organizations || [];
    if (orgs.length > 1) {
        pendingValidation = { sessionKey, organizations: orgs };
        showOrgPicker(orgs);
        return;
    }
    await completeAddAccount(sessionKey, validation.organizationId, orgs);
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
    pendingValidation = null;
    await completeAddAccount(validation.sessionKey, orgId, validation.organizations);
}

async function completeAddAccount(sessionKey, organizationId, organizations) {
    if (!draftAccount) return;
    await window.electronAPI.saveAccount({
        id: draftAccount.id,
        label: draftAccount.label,
        sessionKey,
        organizationId,
        organizations
    });
    draftAccount = null;

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
    if (graphVisible) await loadChart();
}

async function fetchAccount(accountId) {
    if (fetchingAccounts.has(accountId)) {
        debugLog('Fetch already in flight for', accountId);
        return;
    }
    fetchingAccounts.add(accountId);
    try {
        const data = await window.electronAPI.fetchUsageData(accountId);
        usageByAccount[accountId] = data;
        clearAccountExpired(accountId);
        updateAccountCard(accountId, data);
        const account = accounts.find((a) => a.id === accountId);
        if (account) checkUsageAlerts(account, data);
    } catch (error) {
        console.error(`Error fetching usage for ${accountId}:`, error);
        if (String(error.message).includes('SessionExpired') || String(error.message).includes('Unauthorized')) {
            markAccountExpired(accountId);
        }
    } finally {
        fetchingAccounts.delete(accountId);
    }
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
        if (expiredAccounts.has(account.id)) {
            markAccountExpired(account.id);
        }
    }
}

// Clone the template for one account and cache its scoped elements.
function renderAccountCard(account) {
    const fragment = elements.accountCardTemplate.content.cloneNode(true);
    const card = fragment.querySelector('.account-block');
    card.dataset.accountId = account.id;

    const els = {
        name: card.querySelector('.account-name'),
        badge: card.querySelector('.account-badge'),
        reconnectBtn: card.querySelector('.account-reconnect-btn'),
        sessionFill: card.querySelector('.session-fill'),
        sessionPct: card.querySelector('.session-pct'),
        sessionRing: card.querySelector('.session-ring'),
        sessionResetsIn: card.querySelector('.session-resets-in'),
        sessionResetsAt: card.querySelector('.session-resets-at'),
        weeklyFill: card.querySelector('.weekly-fill'),
        weeklyPct: card.querySelector('.weekly-pct'),
        weeklyRing: card.querySelector('.weekly-ring'),
        weeklyResetsIn: card.querySelector('.weekly-resets-in'),
        weeklyResetsAt: card.querySelector('.weekly-resets-at')
    };

    els.name.textContent = account.label;
    els.reconnectBtn.addEventListener('click', () => reconnectAccount(account.id));

    elements.accountsContainer.appendChild(card);
    cardsById.set(account.id, { card, els });
}

// Elapsed-ring geometry — r=13 ⇒ circumference 2π·13 ≈ 81.7 (matches the
// mockup's stroke-dasharray). Fill = fraction of the reset window elapsed
// (session window 5h, weekly 7d); red at ≥90% elapsed (imminent reset). No
// resets_at (session never started) ⇒ treated as 0% elapsed.
const RING_CIRCUMFERENCE = 81.7;
const SESSION_WINDOW_MS = 5 * 60 * 60 * 1000;
const WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
function elapsedFraction(resetsAt, windowMs) {
    if (!resetsAt) return 0;
    const remainingMs = new Date(resetsAt) - new Date();
    return Math.min(Math.max((windowMs - remainingMs) / windowMs, 0), 1);
}
function updateRing(ringEl, elapsed) {
    ringEl.style.strokeDashoffset = RING_CIRCUMFERENCE * (1 - elapsed);
    ringEl.classList.toggle('imminent', elapsed >= 0.9);
}

// "6d 7h" / "4h 11m" / "1m" — remaining time until a reset (mockup style).
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

// Show the "closest to limit" badge only on the worst account (by
// max(session, weekly), see computeWorstAccountId below), and only once
// there are ≥2 accounts and that max has crossed the warn threshold.
function refreshWorstAccountBadge() {
    const worstId = computeWorstAccountId();
    for (const account of accounts) {
        const entry = cardsById.get(account.id);
        if (!entry) continue;
        const data = usageByAccount[account.id];
        const maxPct = data ? Math.max(data.five_hour?.utilization || 0, data.seven_day?.utilization || 0) : 0;
        const showBadge = accounts.length >= 2 && account.id === worstId && maxPct >= warnThreshold;
        entry.els.badge.style.display = showBadge ? 'flex' : 'none';
    }
}

// Update one account block: session/weekly bars (fixed hue, swap to danger
// red past that row's own threshold), % readouts, elapsed rings, and the
// resets-in/resets-at columns.
function updateAccountCard(accountId, data) {
    const entry = cardsById.get(accountId);
    if (!entry) return;
    const { els } = entry;
    const settings = window._cachedSettings || {};
    const timeFormat = settings.timeFormat || '12h';
    const weeklyDateFormat = settings.weeklyDateFormat || 'date';

    const sessionUtil = Math.min(Math.max(data?.five_hour?.utilization || 0, 0), 100);
    const sessionResetsAt = data?.five_hour?.resets_at;
    const weeklyUtil = Math.min(Math.max(data?.seven_day?.utilization || 0, 0), 100);
    const weeklyResetsAt = data?.seven_day?.resets_at;

    els.sessionFill.style.width = `${sessionUtil}%`;
    els.sessionFill.classList.toggle('at-limit', sessionUtil >= dangerThreshold);
    els.sessionPct.textContent = `${Math.round(sessionUtil)}%`;
    updateRing(els.sessionRing, elapsedFraction(sessionResetsAt, SESSION_WINDOW_MS));
    els.sessionResetsIn.textContent = formatRemaining(sessionResetsAt);
    els.sessionResetsAt.textContent = formatResetsAt(sessionResetsAt, false, timeFormat, weeklyDateFormat);

    els.weeklyFill.style.width = `${weeklyUtil}%`;
    els.weeklyFill.classList.toggle('at-limit', weeklyUtil >= dangerThreshold);
    els.weeklyPct.textContent = `${Math.round(weeklyUtil)}%`;
    updateRing(els.weeklyRing, elapsedFraction(weeklyResetsAt, WEEKLY_WINDOW_MS));
    els.weeklyResetsIn.textContent = formatRemaining(weeklyResetsAt);
    els.weeklyResetsAt.textContent = formatResetsAt(weeklyResetsAt, true, timeFormat, weeklyDateFormat);

    refreshWorstAccountBadge();
    updateWidgetFooter();
}

// Recompute the elapsed rings + resets-in/resets-at columns for every card
// (called on an interval so countdowns and ring fills stay fresh between polls).
function refreshAllCardTimers() {
    const settings = window._cachedSettings || {};
    const timeFormat = settings.timeFormat || '12h';
    const weeklyDateFormat = settings.weeklyDateFormat || 'date';

    for (const account of accounts) {
        const entry = cardsById.get(account.id);
        const data = usageByAccount[account.id];
        if (!entry || !data) continue;
        const { els } = entry;
        const sessionResetsAt = data?.five_hour?.resets_at;
        const weeklyResetsAt = data?.seven_day?.resets_at;

        updateRing(els.sessionRing, elapsedFraction(sessionResetsAt, SESSION_WINDOW_MS));
        els.sessionResetsIn.textContent = formatRemaining(sessionResetsAt);
        els.sessionResetsAt.textContent = formatResetsAt(sessionResetsAt, false, timeFormat, weeklyDateFormat);

        updateRing(els.weeklyRing, elapsedFraction(weeklyResetsAt, WEEKLY_WINDOW_MS));
        els.weeklyResetsIn.textContent = formatRemaining(weeklyResetsAt);
        els.weeklyResetsAt.textContent = formatResetsAt(weeklyResetsAt, true, timeFormat, weeklyDateFormat);
    }
}

// Footer line: "Updated 12:07 · refresh 1m" + the "Unofficial" note.
function updateWidgetFooter() {
    const footer = document.getElementById('widgetFooter');
    const updated = document.getElementById('widgetUpdated');
    if (!footer || !updated) return;
    const settings = window._cachedSettings || {};
    const timeFormat = settings.timeFormat || '12h';
    const clock = formatResetsAt(new Date().toISOString(), false, timeFormat, 'date');
    const secs = parseInt(settings.refreshInterval || '300', 10);
    const refreshLabel = secs >= 60 ? `${Math.round(secs / 60)}m` : `${secs}s`;
    updated.textContent = `Updated ${clock} · refresh ${refreshLabel}`;
    footer.style.display = accounts.length > 0 ? 'flex' : 'none';
}

function markAccountExpired(accountId) {
    expiredAccounts.add(accountId);
    const entry = cardsById.get(accountId);
    if (entry) {
        entry.card.classList.add('expired');
        entry.els.reconnectBtn.style.display = 'inline-flex';
    }
}

function clearAccountExpired(accountId) {
    expiredAccounts.delete(accountId);
    const entry = cardsById.get(accountId);
    if (entry) {
        entry.card.classList.remove('expired');
        entry.els.reconnectBtn.style.display = 'none';
    }
}

// Re-run the login flow for an existing account, reusing its partition.
function reconnectAccount(accountId) {
    const account = accounts.find(a => a.id === accountId);
    if (!account) return;
    draftAccount = { id: account.id, partition: account.partition || `persist:acct-${account.id}`, label: account.label };
    addingFromSettings = false;
    pendingValidation = null;
    stopAutoUpdate();
    showAddAccountUI();
}

// ── Accounts settings list ───────────────────────────────────────────────────
function renderAccountsList() {
    elements.accountsList.innerHTML = '';
    for (const account of accounts) {
        const row = document.createElement('div');
        row.className = 'account-row';

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
                if (entry) entry.els.label.textContent = label;
            }
        };
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });

        const removeBtn = document.createElement('button');
        removeBtn.className = 'account-remove-btn';
        removeBtn.textContent = 'Remove';
        removeBtn.addEventListener('click', () => removeAccountFromUI(account.id));

        row.appendChild(input);
        row.appendChild(removeBtn);
        elements.accountsList.appendChild(row);
    }
}

async function removeAccountFromUI(accountId) {
    await window.electronAPI.removeAccount(accountId);
    accounts = accounts.filter(a => a.id !== accountId);
    delete usageByAccount[accountId];
    delete alertFiredByAccount[accountId];
    expiredAccounts.delete(accountId);
    const entry = cardsById.get(accountId);
    if (entry) { entry.card.remove(); cardsById.delete(accountId); }
    renderAccountsList();
    if (accounts.length === 0) {
        elements.settingsOverlay.style.display = 'none';
        startAddAccount({ fromSettings: false });
    } else {
        updateWidgetFooter();
        refreshWorstAccountBadge();
        if (selectedGraphAccountId === accountId) selectedGraphAccountId = null;
        if (graphVisible) await loadChart();
    }
}


// Update UI with usage data
// Format a cent-based amount with the correct currency symbol.
// Known unambiguous symbols are used; everything else falls back to the
// ISO 4217 code as a suffix so the display is always correct.
function formatCurrency(amountCents, currencyCode) {
  const amount = (amountCents / 100).toFixed(2);
  const symbols = { USD: '$', EUR: '€', GBP: '£' };
  const sym = symbols[currencyCode];
  return sym ? `${sym}${amount}` : `${amount} ${currencyCode || 'USD'}`;
}

// Extra row label mapping for API fields
const EXTRA_ROW_CONFIG = {
    seven_day_sonnet: { label: 'Sonnet (7d)', color: 'sonnet' },
    seven_day_opus: { label: 'Opus (7d)', color: 'opus' },
    seven_day_cowork: { label: 'Cowork (7d)', color: 'cowork' },
    seven_day_omelette: { label: 'Design (7d)', color: 'design' },
    seven_day_oauth_apps: { label: 'OAuth Apps (7d)', color: 'oauth' },
    extra_usage: { label: 'Extra Usage', color: 'extra' },
};

function buildExtraRows(data) {
    // Don't clear existing rows if we don't have new data to replace them with
    // This preserves the last known state when expanding the panel
    const hasAnyExtendedData = Object.entries(EXTRA_ROW_CONFIG).some(([key, config]) => {
        const value = data[key];
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
        const value = data[key];
        // extra_usage is valid with utilization OR balance_cents (prepaid only)
        const hasUtilization = value && value.utilization !== undefined;
        const hasBalance = key === 'extra_usage' && value && value.balance_cents != null;
        if (!hasUtilization && !hasBalance) continue;

        const utilization = value.utilization || 0;
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
            progressFill.style.width = `${Math.min(utilization, 100)}%`;
            
            // Apply warning/danger thresholds to extra usage bar
            if (utilization >= dangerThreshold) {
                progressFill.classList.add('danger');
            } else if (utilization >= warnThreshold) {
                progressFill.classList.add('warning');
            }
            
            progressBar.appendChild(progressFill);
            barGroup.appendChild(progressBar);

            const percentage = document.createElement('span');
            if (value.used_cents != null && value.limit_cents != null) {
                percentage.className = 'usage-percentage extra-spending';
                percentage.textContent = `${formatCurrency(value.used_cents, value.currency)}/${formatCurrency(value.limit_cents, value.currency)}`;
            } else {
                percentage.className = 'usage-percentage';
                percentage.textContent = `${Math.round(utilization)}%`;
            }
            barGroup.appendChild(percentage);
            row.appendChild(barGroup);

            const elapsedGroup = document.createElement('div');
            elapsedGroup.className = 'usage-elapsed-group';
            row.appendChild(elapsedGroup);

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
            const totalMinutes = key.includes('seven_day') ? 7 * 24 * 60 : 5 * 60;

            const barGroup = document.createElement('div');
            barGroup.className = 'usage-bar-group';
            const progressBar = document.createElement('div');
            progressBar.className = 'progress-bar';
            const progressFill = document.createElement('div');
            progressFill.className = `progress-fill ${colorClass}`;
            progressFill.style.width = `${Math.min(utilization, 100)}%`;
            progressBar.appendChild(progressFill);
            barGroup.appendChild(progressBar);

            const percentage = document.createElement('span');
            percentage.className = 'usage-percentage';
            percentage.textContent = `${Math.round(utilization)}%`;
            barGroup.appendChild(percentage);
            row.appendChild(barGroup);

            const elapsedGroup = document.createElement('div');
            elapsedGroup.className = 'usage-elapsed-group';
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('class', 'mini-timer');
            svg.setAttribute('width', '24');
            svg.setAttribute('height', '24');
            svg.setAttribute('viewBox', '0 0 24 24');
            const circleBg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            circleBg.setAttribute('class', 'timer-bg');
            circleBg.setAttribute('cx', '12');
            circleBg.setAttribute('cy', '12');
            circleBg.setAttribute('r', '10');
            svg.appendChild(circleBg);
            const circleProgress = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            circleProgress.setAttribute('class', `timer-progress ${colorClass}`);
            circleProgress.setAttribute('cx', '12');
            circleProgress.setAttribute('cy', '12');
            circleProgress.setAttribute('r', '10');
            circleProgress.style.strokeDasharray = '63';
            circleProgress.style.strokeDashoffset = '63';
            svg.appendChild(circleProgress);
            elapsedGroup.appendChild(svg);
            row.appendChild(elapsedGroup);

            const timerText = document.createElement('div');
            timerText.className = 'timer-text';
            timerText.dataset.resets = resetsAt || '';
            timerText.dataset.total = totalMinutes;
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
    const timerTexts = elements.extraRows.querySelectorAll('.timer-text');
    const timerCircles = elements.extraRows.querySelectorAll('.timer-progress');

    timerTexts.forEach((textEl, i) => {
        const resetsAt = textEl.dataset.resets;
        const totalMinutes = parseInt(textEl.dataset.total);
        const circleEl = timerCircles[i];
        if (resetsAt && circleEl) {
            updateTimer(circleEl, textEl, resetsAt, totalMinutes);
        }
    });
}


// Fire OS desktop notifications when usage crosses warn/danger thresholds.
// Only fires once per threshold crossing per session window — not on every refresh.
// Flags are keyed per account id so multiple accounts don't suppress each other's alerts.
function checkUsageAlerts(account, data) {
    const settings = window._cachedSettings || {};
    if (!settings.usageAlerts) return;

    const alertFired = getAlertFlags(account.id);
    const sessionPct = data.five_hour?.utilization || 0;
    const weeklyPct = data.seven_day?.utilization || 0;

    // Reset alert flags when a session window resets (utilization drops back low)
    if (sessionPct < warnThreshold) {
        alertFired.session_warn = false;
        alertFired.session_danger = false;
    }
    if (weeklyPct < warnThreshold) {
        alertFired.weekly_warn = false;
        alertFired.weekly_danger = false;
    }

    // Current Session — danger threshold (check first, higher priority)
    if (sessionPct >= dangerThreshold && !alertFired.session_danger) {
        alertFired.session_danger = true;
        alertFired.session_warn = true; // suppress warn if we jumped straight to danger
        window.electronAPI.showNotification(
            `${account.label} — session at ${Math.round(sessionPct)}%`,
            'Current Session usage is running low'
        );
    // Current Session — warn threshold
    } else if (sessionPct >= warnThreshold && !alertFired.session_warn) {
        alertFired.session_warn = true;
        window.electronAPI.showNotification(
            `${account.label} — session at ${Math.round(sessionPct)}%`,
            'Current Session usage has reached the warning threshold'
        );
    }

    // Weekly Limit — danger threshold
    if (weeklyPct >= dangerThreshold && !alertFired.weekly_danger) {
        alertFired.weekly_danger = true;
        alertFired.weekly_warn = true;
        window.electronAPI.showNotification(
            `${account.label} — weekly at ${Math.round(weeklyPct)}%`,
            'Weekly Limit usage is running low'
        );
    // Weekly Limit — warn threshold
    } else if (weeklyPct >= warnThreshold && !alertFired.weekly_warn) {
        alertFired.weekly_warn = true;
        window.electronAPI.showNotification(
            `${account.label} — weekly at ${Math.round(weeklyPct)}%`,
            'Weekly Limit usage has reached the warning threshold'
        );
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

// Per-account usage alert flags — which thresholds have already fired for that
// account's current session/weekly window. Prevents repeat notifications on every
// refresh cycle; reset when utilization drops back below the warn threshold.
const alertFiredByAccount = {}; // accountId -> { session_warn, session_danger, weekly_warn, weekly_danger }
function getAlertFlags(accountId) {
    if (!alertFiredByAccount[accountId]) {
        alertFiredByAccount[accountId] = {
            session_warn: false,
            session_danger: false,
            weekly_warn: false,
            weekly_danger: false
        };
    }
    return alertFiredByAccount[accountId];
}

function startCountdown() {
    if (countdownInterval) clearInterval(countdownInterval);
    countdownInterval = setInterval(() => {
        refreshAllCardTimers();
    }, 30000);
}

// Update progress bar
function updateProgressBar(progressElement, percentageElement, value, isWeekly = false) {
    const percentage = Math.min(Math.max(value, 0), 100);

    progressElement.style.width = `${percentage}%`;
    percentageElement.textContent = `${Math.round(percentage)}%`;

    progressElement.classList.remove('warning', 'danger');
    if (percentage >= dangerThreshold) {
        progressElement.classList.add('danger');
    } else if (percentage >= warnThreshold) {
        progressElement.classList.add('warning');
    }
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

// Update circular timer
function updateTimer(timerElement, textElement, resetsAt, totalMinutes) {
    if (!resetsAt) {
        textElement.textContent = 'Not started';
        textElement.style.opacity = '0.4';
        textElement.style.fontSize = '10px';
        textElement.title = 'Starts when a message is sent';
        timerElement.style.strokeDashoffset = 63;
        return;
    }

    // Clear the greyed out styling when timer is active
    textElement.style.opacity = '1';
    textElement.style.fontSize = '';
    textElement.title = '';

    const resetDate = new Date(resetsAt);
    const now = new Date();
    const diff = resetDate - now;

    if (diff <= 0) {
        textElement.textContent = 'Resetting...';
        timerElement.style.strokeDashoffset = 0;
        return;
    }

    // Calculate remaining time
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    // const seconds = Math.floor((diff % (1000 * 60)) / 1000); // Optional seconds

    // Format time display
    if (hours >= 24) {
        const days = Math.floor(hours / 24);
        const remainingHours = hours % 24;
        textElement.textContent = `${days}d ${remainingHours}h`;
    } else if (hours > 0) {
        textElement.textContent = `${hours}h ${minutes}m`;
    } else {
        textElement.textContent = `${minutes}m`;
    }

    // Calculate progress (elapsed percentage)
    const totalMs = totalMinutes * 60 * 1000;
    const elapsedMs = totalMs - diff;
    const elapsedPercentage = (elapsedMs / totalMs) * 100;

    // Update circle (63 is ~2*pi*10)
    const circumference = 63;
    const offset = circumference - (elapsedPercentage / 100) * circumference;
    timerElement.style.strokeDashoffset = offset;

    // Update color based on remaining time
    timerElement.classList.remove('warning', 'danger');
    if (elapsedPercentage >= 90) {
        timerElement.classList.add('danger');
    } else if (elapsedPercentage >= 75) {
        timerElement.classList.add('warning');
    }
}

// UI State Management
function showMainContent() {
    elements.loadingContainer.style.display = 'none';
    elements.loginContainer.style.display = 'none';
    elements.noUsageContainer.style.display = 'none';
    elements.mainContent.style.display = 'block';
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
// worst account (matches the tray rollup logic in src/account-logic.js — the
// renderer can't require() that Node module directly, so this is a small
// duplicate of computeWorstAccount() scoped to just the id).
let selectedGraphAccountId = null;
function computeWorstAccountId() {
    let worstId = null;
    let worstVal = -1;
    for (const account of accounts) {
        const data = usageByAccount[account.id];
        if (!data) continue;
        const maxPct = Math.max(data.five_hour?.utilization || 0, data.seven_day?.utilization || 0);
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

function renderChart(history) {
    if (usageChart) usageChart.destroy();

    const allValues = history.flatMap((entry) => [entry.session, entry.weekly]);
    const yMax = Math.max(10, Math.ceil(Math.max(...allValues) / 10) * 10);

    const datasets = [
        {
            label: 'Session',
            data: history.map((entry) => ({ x: entry.timestamp, y: entry.session })),
            borderColor: '#e08a2e',
            backgroundColor: 'transparent',
            borderWidth: 2,
            stepped: true,
            pointRadius: 0,
            pointHoverRadius: 3,
            pointHitRadius: 10
        },
        {
            label: 'Weekly',
            data: history.map((entry) => ({ x: entry.timestamp, y: entry.weekly })),
            borderColor: '#3e6fd9',
            backgroundColor: 'transparent',
            borderWidth: 2,
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
                        font: { family: 'Geist Mono', size: 9.5 },
                        color: '#57536a',
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
                        font: { family: 'Geist Mono', size: 9.5 },
                        color: '#57536a',
                        callback: (value) => `${value}%`
                    },
                    grid: {
                        color: 'rgba(255,255,255,.06)'
                    }
                }
            },
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    backgroundColor: '#17161d',
                    titleFont: { family: 'Geist Mono' },
                    bodyFont: { family: 'Geist Mono' },
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

// Settings management
let warnThreshold = 75;
let dangerThreshold = 90;

async function loadSettings() {
    const settings = await window.electronAPI.getSettings();
    const isPortable = window.electronAPI.isPortable;
    // Autostart works on Linux too now (implemented via the XDG autostart spec
    // in main.js) — only portable Windows builds can't support it reliably,
    // since autorun via registry breaks when the exe path changes per version.
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
    elements.warnThreshold.value = settings.warnThreshold;
    elements.dangerThreshold.value = settings.dangerThreshold;
    elements.timeFormat.value = settings.timeFormat || '12h';
    elements.weeklyDateFormat.value = settings.weeklyDateFormat || 'date';
    if (elements.refreshInterval) elements.refreshInterval.value = settings.refreshInterval || '300';
    elements.usageAlertsToggle.checked = settings.usageAlerts !== false;

    // Render the accounts management list; the single-account "Log Out" is gone
    // (accounts are removed individually from the list).
    renderAccountsList();
    if (elements.logoutBtn) elements.logoutBtn.style.display = 'none';

    warnThreshold = settings.warnThreshold;
    dangerThreshold = settings.dangerThreshold;

    applyTheme(settings.theme);
    if (window.electronAPI.platform === 'darwin') {
        document.getElementById('trayLabel').textContent = 'Hide from Dock';
    }
}

async function saveSettings() {
    const warn = parseInt(elements.warnThreshold.value) || 75;
    const danger = parseInt(elements.dangerThreshold.value) || 90;

    warnThreshold = warn;
    dangerThreshold = danger;

    const settings = {
        autoStart: window.electronAPI.isPortable ? false : elements.autoStartToggle.checked,
        minimizeToTray: elements.minimizeToTrayToggle.checked,
        alwaysOnTop: elements.alwaysOnTopToggle.checked,
        showTrayStats: elements.showTrayStatsToggle.checked,
        theme: currentThemeSetting,
        warnThreshold: warn,
        dangerThreshold: danger,
        timeFormat: elements.timeFormat.value || '12h',
        weeklyDateFormat: elements.weeklyDateFormat.value || 'date',
        refreshInterval: elements.refreshInterval ? (elements.refreshInterval.value || '300') : '300',
        usageAlerts: elements.usageAlertsToggle.checked,
        graphVisible: graphVisible,
        expandedOpen: isExpanded
    };
    await window.electronAPI.saveSettings(settings);
    window._cachedSettings = settings;
    applyTheme(settings.theme);
    if (window.electronAPI.platform === 'darwin') {
        document.getElementById('trayLabel').textContent = 'Hide from Dock';
    }

    // Re-render each card so new thresholds / time formats apply immediately
    for (const account of accounts) {
        if (usageByAccount[account.id]) updateAccountCard(account.id, usageByAccount[account.id]);
    }
    // Restart auto-update with new interval if it changed
    startAutoUpdate();
}

// Apply the theme setting live: resolve 'system' to dark/light via the OS,
// write the resolved theme's neutrals onto the CSS custom properties every
// component reads, and refresh the segmented Dark/Light/System control. No
// restart needed — the browser recalculates all var() references instantly.
// Accent/warn/danger/session/weekly/logo tokens are theme-invariant — they're
// static values in styles.css, never touched here.
let currentThemeSetting = 'dark'; // the raw setting: 'dark' | 'light' | 'system'
function applyTheme(theme) {
    currentThemeSetting = normalizeThemeSetting(theme);
    const t = THEMES[resolveThemeKey(currentThemeSetting)];
    const root = document.documentElement.style;

    root.setProperty('--bg', t.bg);
    root.setProperty('--bg2', t.bg2);
    root.setProperty('--border', t.border);
    root.setProperty('--line', t.line);
    root.setProperty('--text', t.text);
    root.setProperty('--muted', t.muted);
    root.setProperty('--faint', t.faint);
    root.setProperty('--surface', t.surface);
    root.setProperty('--surface-border', t.surfaceBorder);
    root.setProperty('--chip', t.chip);
    root.setProperty('--chip-hover', t.chipHover);
    root.setProperty('--ring-track', t.ringTrack);
    root.setProperty('--track', t.track);
    root.setProperty('--toggle-off', t.toggleOff);
    root.setProperty('--titlebar-bg', t.titlebarBg);
    root.setProperty('--titlebar-border', t.titlebarBorder);
    root.setProperty('--shadow', t.shadow);
    root.setProperty('--accent-ink', t.accentInk);

    renderThemePicker();
}

// The segmented Dark/Light/System control — active option gets the accent fill.
function renderThemePicker() {
    document.querySelectorAll('#themeSelector .theme-seg-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.theme === currentThemeSetting);
    });
}

// Update check
async function checkForUpdate() {
    try {
        const result = await window.electronAPI.checkForUpdate();
        if (!result.hasUpdate) return;

        const version = result.version;

        // Show the update banner — the accounts container scrolls if it doesn't fit.
        elements.updateBannerText.textContent = `▲  Version ${version} available — click to download`;
        elements.updateBanner.style.display = 'flex';

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
