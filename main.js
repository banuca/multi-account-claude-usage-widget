const { app, BrowserWindow, ipcMain, Tray, Menu, session, shell, Notification, safeStorage, nativeImage, nativeTheme } = require('electron');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');
const Store = require('electron-store');
const { fetchViaWindow, fetchMultipleViaWindow } = require('./src/fetch-via-window');
const { computeWorstAccount, createLegacyAccountMigration } = require('./src/account-logic');

const GITHUB_OWNER = 'banuca';
const GITHUB_REPO = 'multi-account-claude-usage-widget';

// Migration: Handle old encrypted config files from v1.7.0 and earlier
// Must happen BEFORE creating Store instance to prevent parse errors
const fs = require('fs');
const os = require('os');

// electron-store uses different paths per platform
let configPath;
if (process.platform === 'darwin') {
  configPath = path.join(os.homedir(), 'Library', 'Application Support', 'claude-usage-widget', 'config.json');
} else if (process.platform === 'win32') {
  configPath = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'claude-usage-widget', 'config.json');
} else {
  // Linux
  configPath = path.join(os.homedir(), '.config', 'claude-usage-widget', 'config.json');
}

try {
  if (fs.existsSync(configPath)) {
    const rawData = fs.readFileSync(configPath, 'utf-8');
    // Check if file looks encrypted (contains non-JSON garbage or doesn't start with {)
    if (rawData.includes('\u0000') || !rawData.trim().startsWith('{')) {
      console.log('[Migration] Detected old encrypted config from v1.7.0, deleting for fresh start');
      fs.unlinkSync(configPath);
    }
  }
} catch (err) {
  console.error('[Migration] Error checking config file:', err.message);
  // If we can't read it, try to delete it
  try {
    if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
  } catch {}
}

// Non-sensitive settings storage (no encryption needed)
const store = new Store();

// Debug mode: set DEBUG_LOG=1 env var or pass --debug flag to see verbose logs.
// Regular users will only see critical errors in the console.
const DEBUG = process.env.DEBUG_LOG === '1' || process.argv.includes('--debug');
function debugLog(...args) {
  if (DEBUG) console.log('[Debug]', ...args);
}

const CHROME_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let mainWindow = null;
let sessionTray = null;  // Tray icon for Session usage
let weeklyTray = null;   // Tray icon for Weekly usage

// Prevent portable/startup/manual launches from creating competing app instances.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

// Latest usage payload per account id, keyed by account id. Drives the tray
// rollup (worst account) and the per-account tooltip/menu. In-memory only —
// rebuilt as each account is polled.
const latestUsageByAccount = {};

// v2.0 free-resize model: the user owns the window size (see createMainWindow).
// 640 is the design default width used only for the very first run.
const DEFAULT_WINDOW_WIDTH = 640;
const DEFAULT_WINDOW_HEIGHT = 480;
const MIN_WINDOW_WIDTH = 480;
const MIN_WINDOW_HEIGHT = 150;
let firstRunAutoSize = false; // true only until the renderer's one-time first-paint auto-size call lands
const HISTORY_RETENTION_DAYS = 8;
const CHART_DAYS = 7;
const MAX_HISTORY_SAMPLES = 10000; // Cap total samples to prevent unbounded growth

function storeUsageHistory(accountId, data) {
  // Skip write if the session is invalid — a live session always has resets_at timestamps.
  // Absent timestamps mean the API returned empty/zeroed data (dead session, removed device, etc.)
  if (!data.five_hour?.resets_at && !data.seven_day?.resets_at) {
    debugLog('[History] Skipping write — no reset timestamps, likely invalid session data');
    return;
  }

  const historyKey = `usageHistory_acct_${accountId}`;

  const timestamp = Date.now();
  let history = store.get(historyKey, []);

  history.push({
    timestamp,
    session: data.five_hour?.utilization || 0,
    weekly: data.seven_day?.utilization || 0
  });

  // Rotation: apply both time-based and count-based limits
  const cutoff = timestamp - (HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  history = history.filter((entry) => entry.timestamp > cutoff);

  if (history.length > MAX_HISTORY_SAMPLES) {
    history = history.slice(history.length - MAX_HISTORY_SAMPLES);
  }

  store.set(historyKey, history);
}

// Migrate legacy single-key history to the per-org namespaced key at startup,
// so get-usage-history reads from the right place before any fetch has run.
function migrateUsageHistoryKey() {
  const organizationId = store.get('organizationId');
  if (!organizationId) return;
  const historyKey = `usageHistory_${organizationId}`;
  if (store.has(historyKey)) return;
  const legacy = store.get('usageHistory', []);
  if (legacy.length > 0) {
    store.set(historyKey, legacy);
    store.delete('usageHistory');
    debugLog('[History] Migrated legacy usageHistory →', historyKey);
  }
}

// One-time migration: rename any pre-multi-account `usageHistory_<orgId>` key to the
// namespaced `usageHistory_acct_<accountId>` key, for whichever account now owns that
// orgId. Keys with no matching account (orphaned orgs) are left for pruneStaleHistoryKeys
// to age out. Must run after migrateLegacyAccount() so accounts[] is populated.
function migrateUsageHistoryKeysToAccounts() {
  const accounts = getAccounts();
  const allKeys = Object.keys(store.store);
  for (const key of allKeys) {
    if (!key.startsWith('usageHistory_') || key.startsWith('usageHistory_acct_')) continue;
    const orgId = key.slice('usageHistory_'.length);
    const account = accounts.find((a) => a.orgId === orgId);
    if (!account) continue; // no matching account — leave for pruneStaleHistoryKeys

    const newKey = `usageHistory_acct_${account.id}`;
    if (!store.has(newKey)) {
      store.set(newKey, store.get(key));
    }
    store.delete(key);
    debugLog('[History] Migrated', key, '→', newKey);
  }
}

// Prune all history keys (old `usageHistory_<orgId>` and new `usageHistory_acct_<id>`
// forms) at startup. Trims entries older than the retention window and deletes the key
// entirely if nothing remains — cleans up abandoned accounts and orphaned orgs.
function pruneStaleHistoryKeys() {
  const cutoff = Date.now() - (HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const allKeys = Object.keys(store.store);
  for (const key of allKeys) {
    if (!key.startsWith('usageHistory_') && key !== 'usageHistory') continue;
    const history = store.get(key, []);
    const fresh = history.filter((entry) => entry.timestamp > cutoff);
    if (fresh.length === 0) {
      store.delete(key);
      debugLog('[History] Deleted stale key:', key);
    } else if (fresh.length < history.length) {
      store.set(key, fresh);
      debugLog('[History] Pruned', history.length - fresh.length, 'old entries from', key);
    }
  }
}

// Set session-level User-Agent to avoid Electron detection
app.on('ready', () => {
  session.defaultSession.setUserAgent(CHROME_USER_AGENT);
});

// ---------------------------------------------------------------------------
// Multi-account model
//
// Each account owns an isolated Electron session partition
// (`persist:acct-<id>`), so its sessionKey cookie lives in its own jar and
// multiple logins coexist. The store holds a list of accounts; the sessionKey
// itself lives in the partition's cookie jar plus an encrypted safeStorage
// backup keyed by account id (re-applied to the partition on startup).
// ---------------------------------------------------------------------------

function partitionFor(id) {
  return `persist:acct-${id}`;
}

// Resolve an account's partition session and ensure it carries the spoofed
// Chrome UA (Claude/Cloudflare blocks Electron's default UA).
function getAccountSession(id) {
  const s = session.fromPartition(partitionFor(id));
  s.setUserAgent(CHROME_USER_AGENT);
  return s;
}

function getAccounts() {
  return store.get('accounts', []);
}

function setAccounts(accounts) {
  store.set('accounts', accounts);
}

function getAccount(id) {
  return getAccounts().find((a) => a.id === id);
}

// Monotonic account id so partitions stay stable and readable (acct-1, acct-2…).
function nextAccountId() {
  const n = store.get('accountSeq', 0) + 1;
  store.set('accountSeq', n);
  return String(n);
}

// Default labels: first account "Personal", second "Work", then "Account N".
function defaultLabel(index) {
  if (index === 0) return 'Personal';
  if (index === 1) return 'Work';
  return `Account ${index + 1}`;
}

// Per-account sessionKey backup — encrypted via OS keychain when available,
// mirroring the original single-account storage.
function saveAccountKey(id, sessionKey) {
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(sessionKey);
    store.set(`account_${id}_sessionKey_encrypted`, encrypted.toString('base64'));
    store.delete(`account_${id}_sessionKey`);
  } else {
    store.set(`account_${id}_sessionKey`, sessionKey);
  }
}

function loadAccountKey(id) {
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = store.get(`account_${id}_sessionKey_encrypted`);
    if (encrypted) {
      try {
        return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
      } catch (err) {
        console.error(`[Keychain] Failed to decrypt session key for account ${id}:`, err.message);
      }
    }
    return null;
  }
  return store.get(`account_${id}_sessionKey`, null);
}

function deleteAccountKey(id) {
  store.delete(`account_${id}_sessionKey_encrypted`);
  store.delete(`account_${id}_sessionKey`);
}

// Set the sessionKey cookie on an account's partition session.
async function setSessionCookie(sessionKey, id) {
  const sess = getAccountSession(id);
  await sess.cookies.set({
    url: 'https://claude.ai',
    name: 'sessionKey',
    value: sessionKey,
    domain: '.claude.ai',
    path: '/',
    secure: true,
    httpOnly: true
  });
  debugLog(`sessionKey cookie set on partition for account ${id}`);
}

// One-time migration: fold a pre-existing single-account config into accounts[0].
// Runs before the first render so the widget shows the account straight away.
function migrateLegacyAccount() {
  if (store.get('accounts') !== undefined) return; // already on the multi-account model

  let legacyKey = null;
  if (safeStorage.isEncryptionAvailable()) {
    const enc = store.get('sessionKey_encrypted');
    if (enc) {
      try {
        legacyKey = safeStorage.decryptString(Buffer.from(enc, 'base64'));
      } catch (err) {
        console.error('[Migration] Failed to decrypt legacy session key:', err.message);
      }
    }
  }
  if (!legacyKey) legacyKey = store.get('sessionKey', null);
  const legacyOrg = store.get('organizationId', null);

  const migration = createLegacyAccountMigration({
    legacyKey,
    legacyOrg,
    id: legacyKey && legacyOrg ? nextAccountId() : null
  });

  if (migration.sessionKeyByAccount) {
    saveAccountKey(migration.sessionKeyByAccount.id, migration.sessionKeyByAccount.sessionKey);
    debugLog('[Migration] Migrated legacy single account into accounts[0], id', migration.sessionKeyByAccount.id);
  } else {
    // Nothing to migrate — initialise an empty list so this never runs again.
  }
  setAccounts(migration.accounts);

  // Clear legacy single-account keys regardless (their data now lives per-account).
  if (migration.clearLegacyKeys) {
    store.delete('sessionKey');
    store.delete('sessionKey_encrypted');
    store.delete('organizationId');
  }
}

// Load persisted window bounds, migrating the old position-only `windowPosition`
// key (pre-2.0, before the window was freely resizable) into the new
// {x,y,width,height} shape. Returns null on a true first run — the caller then
// auto-sizes to content on first paint (see set-window-bounds's firstRunAutoSize
// handling below).
function loadWindowBounds() {
  const bounds = store.get('windowBounds');
  if (bounds) return bounds;

  const legacyPosition = store.get('windowPosition');
  if (legacyPosition) {
    const migrated = { x: legacyPosition.x, y: legacyPosition.y, width: DEFAULT_WINDOW_WIDTH, height: DEFAULT_WINDOW_HEIGHT };
    store.set('windowBounds', migrated);
    store.delete('windowPosition');
    return migrated;
  }

  return null;
}

function createMainWindow() {
  const savedBounds = loadWindowBounds();
  firstRunAutoSize = !savedBounds;

  const windowOptions = {
    width: savedBounds ? savedBounds.width : DEFAULT_WINDOW_WIDTH,
    height: savedBounds ? savedBounds.height : DEFAULT_WINDOW_HEIGHT,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    // Transparent windows don't support native OS edge-resize (Electron docs), and
    // flipping `resizable: true` risks breaking transparency on some platforms —
    // so this stays false. The renderer drives resizing itself with pointer-driven
    // grips that call setBounds() over the set-window-bounds IPC handler below,
    // which works regardless of this flag.
    resizable: false,
    skipTaskbar: false,
    icon: path.join(__dirname, process.platform === 'darwin' ? 'assets/icon.icns' : process.platform === 'linux' ? 'assets/icons/512x512.png' : 'assets/icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  };

  if (savedBounds) {
    windowOptions.x = savedBounds.x;
    windowOptions.y = savedBounds.y;
  }

  mainWindow = new BrowserWindow(windowOptions);
  mainWindow.loadFile('src/renderer/index.html');

  // Belt-and-braces for X11 window managers that don't pick up the
  // BrowserWindow `icon` option reliably (see ensureLinuxDesktopIntegration).
  if (process.platform === 'linux') {
    mainWindow.setIcon(nativeImage.createFromPath(path.join(__dirname, 'assets/icons/512x512.png')));
  }

  let boundsSaveTimer = null;
  const scheduleBoundsSave = () => {
    if (boundsSaveTimer) clearTimeout(boundsSaveTimer);
    boundsSaveTimer = setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      store.set('windowBounds', mainWindow.getBounds());
    }, 300);
  };
  mainWindow.on('move', scheduleBoundsSave);
  mainWindow.on('resize', scheduleBoundsSave);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

/**
 * Determine background color based on thresholds
 */
function getBackgroundColor(percent, isSession, warnThreshold, dangerThreshold) {
  if (percent >= dangerThreshold) {
    // Red #ef4444
    return { r: 239, g: 68, b: 68 };
  } else if (percent >= warnThreshold) {
    // Amber/Orange #f59e0b
    return { r: 245, g: 158, b: 11 };
  } else {
    // Default colors
    if (isSession) {
      // Purple #8b5cf6
      return { r: 139, g: 92, b: 246 };
    } else {
      // Blue #3b82f6
      return { r: 59, g: 130, b: 246 };
    }
  }
}

/**
 * Bold 8x11 bitmap font for numbers 0-9 (2-pixel strokes for bold look)
 * Each number is represented as an array of 11 rows, each row is 8 bits
 */
const BITMAP_FONT = {
  '0': [
    0b00111100,
    0b01111110,
    0b11100111,
    0b11000011,
    0b11000011,
    0b11000011,
    0b11000011,
    0b11000011,
    0b11100111,
    0b01111110,
    0b00111100
  ],
  '1': [
    0b00011000,
    0b00111000,
    0b01111000,
    0b00011000,
    0b00011000,
    0b00011000,
    0b00011000,
    0b00011000,
    0b00011000,
    0b01111110,
    0b01111110
  ],
  '2': [
    0b00111100,
    0b01111110,
    0b11100111,
    0b00000011,
    0b00000110,
    0b00011100,
    0b00111000,
    0b01110000,
    0b11100000,
    0b11111111,
    0b11111111
  ],
  '3': [
    0b00111100,
    0b01111110,
    0b11100111,
    0b00000011,
    0b00000110,
    0b00111100,
    0b00000110,
    0b00000011,
    0b11100111,
    0b01111110,
    0b00111100
  ],
  '4': [
    0b00000110,
    0b00001110,
    0b00011110,
    0b00110110,
    0b01100110,
    0b11111111,
    0b11111111,
    0b00000110,
    0b00000110,
    0b00000110,
    0b00000110
  ],
  '5': [
    0b11111111,
    0b11111111,
    0b11000000,
    0b11000000,
    0b11111100,
    0b00000110,
    0b00000011,
    0b00000011,
    0b11100111,
    0b01111110,
    0b00111100
  ],
  '6': [
    0b00111100,
    0b01111110,
    0b11100000,
    0b11000000,
    0b11111100,
    0b11100110,
    0b11000011,
    0b11000011,
    0b11100111,
    0b01111110,
    0b00111100
  ],
  '7': [
    0b11111111,
    0b11111111,
    0b00000011,
    0b00000110,
    0b00001100,
    0b00011000,
    0b00110000,
    0b00110000,
    0b01100000,
    0b01100000,
    0b01100000
  ],
  '8': [
    0b00111100,
    0b01111110,
    0b11100111,
    0b11000011,
    0b01111110,
    0b00111100,
    0b01111110,
    0b11000011,
    0b11100111,
    0b01111110,
    0b00111100
  ],
  '9': [
    0b00111100,
    0b01111110,
    0b11100111,
    0b11000011,
    0b11000011,
    0b01111111,
    0b00111111,
    0b00000011,
    0b00000111,
    0b01111110,
    0b00111100
  ]
};

/**
 * Narrow 6x11 bitmap font for 3-digit numbers (100%)
 * Bold version to match
 */
const BITMAP_FONT_NARROW = {
  '0': [
    0b011110,
    0b111111,
    0b110011,
    0b110011,
    0b110011,
    0b110011,
    0b110011,
    0b110011,
    0b110011,
    0b111111,
    0b011110
  ],
  '1': [
    0b001100,
    0b011100,
    0b111100,
    0b001100,
    0b001100,
    0b001100,
    0b001100,
    0b001100,
    0b001100,
    0b111111,
    0b111111
  ]
};

/**
 * Draw a crisp bitmap character at position (x, y) in the buffer
 */
function drawChar(buffer, width, height, char, x, y, color, useNarrow = false) {
  const bitmap = useNarrow ? BITMAP_FONT_NARROW[char] : BITMAP_FONT[char];
  if (!bitmap) return useNarrow ? 6 : 8;
  
  const charWidth = useNarrow ? 6 : 8;
  const charHeight = 11;
  const maxCol = useNarrow ? 5 : 7;
  
  for (let row = 0; row < charHeight; row++) {
    for (let col = 0; col < charWidth; col++) {
      if (bitmap[row] & (1 << (maxCol - col))) {
        const px = x + col;
        const py = y + row;
        if (px >= 0 && px < width && py >= 0 && py < height) {
          const offset = (py * width + px) * 4;
          buffer[offset] = color.b;
          buffer[offset + 1] = color.g;
          buffer[offset + 2] = color.r;
          buffer[offset + 3] = color.a;
        }
      }
    }
  }
  return charWidth;
}

/**
 * Generate a single percentage badge icon with colored background and bitmap text
 * @param {number} percent - Usage percentage (0-100)
 * @param {object} bgColor - Background color {r, g, b}
 * @returns {NativeImage} Generated tray icon
 */
function generatePercentageIcon(percent, bgColor) {
  const width = 20;  // Back to 20x20
  const height = 20;
  const buffer = Buffer.alloc(width * height * 4);
  
  // Draw filled square background
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      buffer[offset] = bgColor.b;
      buffer[offset + 1] = bgColor.g;
      buffer[offset + 2] = bgColor.r;
      buffer[offset + 3] = 255;
    }
  }
  
  // Draw white text
  const percentText = Math.round(percent).toString();
  const textColor = { r: 255, g: 255, b: 255, a: 255 };
  
  // Use narrow font for 3-digit numbers (100%)
  const useNarrow = percentText.length >= 3;
  const charWidth = useNarrow ? 6 : 8;
  const charHeight = 11;
  const gap = percentText.length >= 3 ? 0 : 1; // 1px gap for 1-2 digits, no gap for 100
  const totalWidth = percentText.length * charWidth + (percentText.length - 1) * gap;
  let startX = Math.floor((width - totalWidth) / 2);
  const startY = Math.floor((height - charHeight) / 2);
  
  // Draw each digit
  for (let i = 0; i < percentText.length; i++) {
    drawChar(buffer, width, height, percentText[i], startX, startY, textColor, useNarrow);
    startX += charWidth + gap;
  }
  
  return nativeImage.createFromBuffer(buffer, { width, height });
}

/**
 * Generate a Red X icon for 99-100% usage (maxed out)
 * @returns {NativeImage} Generated red X tray icon
 */
function generateRedXIcon() {
  const width = 20;
  const height = 20;
  const buffer = Buffer.alloc(width * height * 4);
  
  // Red background
  const red = { r: 220, g: 53, b: 69 }; // #dc3545
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      buffer[offset] = red.b;
      buffer[offset + 1] = red.g;
      buffer[offset + 2] = red.r;
      buffer[offset + 3] = 255;
    }
  }
  
  // Draw white X (2 pixel thick lines)
  const white = { r: 255, g: 255, b: 255, a: 255 };
  
  // Diagonal line from top-left to bottom-right
  for (let i = 0; i < 11; i++) {
    const x1 = 5 + i;
    const y1 = 5 + i;
    // Draw 2x2 pixel for thickness
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const px = x1 + dx;
        const py = y1 + dy;
        if (px < width && py < height) {
          const offset = (py * width + px) * 4;
          buffer[offset] = white.b;
          buffer[offset + 1] = white.g;
          buffer[offset + 2] = white.r;
          buffer[offset + 3] = white.a;
        }
      }
    }
  }
  
  // Diagonal line from top-right to bottom-left
  for (let i = 0; i < 11; i++) {
    const x1 = 15 - i;
    const y1 = 5 + i;
    // Draw 2x2 pixel for thickness
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const px = x1 + dx;
        const py = y1 + dy;
        if (px < width && py < height) {
          const offset = (py * width + px) * 4;
          buffer[offset] = white.b;
          buffer[offset + 1] = white.g;
          buffer[offset + 2] = white.r;
          buffer[offset + 3] = white.a;
        }
      }
    }
  }
  
  return nativeImage.createFromBuffer(buffer, { width, height });
}



/**
 * Show the main window without the double-blink artifact on Windows.
 *
 * On Windows, transparent + alwaysOnTop + frameless windows re-enter the DWM
 * compositing pipeline in two steps when shown after hide(): an initial layered
 * window render (blink 1) followed by the alwaysOnTop z-order re-assertion
 * (blink 2). Setting opacity to 0 before show() masks those intermediate states;
 * the window is made opaque again after the DWM has had time to settle (~3 frames).
 * macOS and Linux do not have this issue so they just call show() directly.
 */
function showMainWindowClean() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function trayExists(tray) {
  return !!tray && !tray.isDestroyed();
}

function hasRestoreTray() {
  return trayExists(sessionTray) || trayExists(weeklyTray);
}

function wantsRestoreTray() {
  return store.get('settings.minimizeToTray', false) || store.get('settings.showTrayStats', false);
}

function trayIconPath() {
  return path.join(
    __dirname,
    process.platform === 'darwin'
      ? 'assets/tray-icon-mac.png'
      : process.platform === 'linux'
        ? 'assets/tray-icon-linux.png'
        : 'assets/tray-icon.png'
  );
}

function wireTrayClick(tray) {
  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
        mainWindow.hide();
      } else {
        showMainWindowClean();
      }
    } else {
      createMainWindow();
    }
  });
}

function destroyTray(tray) {
  if (!tray || tray.isDestroyed()) return;

  try {
    tray.removeAllListeners();
    tray.setContextMenu(null);
    tray.setToolTip('');

    // On Linux, some appindicator hosts repaint stale tray entries lazily.
    // Clearing the image before destroy gives the host an explicit update.
    if (process.platform === 'linux') {
      tray.setImage(nativeImage.createEmpty());
    }
  } catch (error) {
    console.error('Failed to clear tray icon:', error);
  }

  try {
    tray.destroy();
  } catch (error) {
    console.error('Failed to destroy tray icon:', error);
  }
}

// Build the tray context menu: one (disabled) detail line per account with its
// session/weekly numbers — the "full detail" popup — plus the shared controls.
function buildTrayMenu() {
  const template = [];
  const accounts = getAccounts();
  for (const a of accounts) {
    const d = latestUsageByAccount[a.id];
    const label = d
      ? `${a.label}:  Session ${Math.round(d.five_hour?.utilization || 0)}%  ·  Weekly ${Math.round(d.seven_day?.utilization || 0)}%`
      : `${a.label}:  —`;
    template.push({ label, enabled: false });
  }
  if (accounts.length) template.push({ type: 'separator' });

  template.push({
    label: 'Show Widget',
    click: () => {
      if (mainWindow) {
        showMainWindowClean();
      } else {
        createMainWindow();
      }
    }
  });
  template.push({
    label: 'Refresh',
    click: () => {
      if (mainWindow) {
        mainWindow.webContents.send('refresh-usage');
      }
    }
  });
  template.push({ type: 'separator' });
  template.push({ label: 'Exit', click: () => app.quit() });

  return Menu.buildFromTemplate(template);
}

function createTray() {
  const showTrayStats = store.get('settings.showTrayStats', false);
  const needsRestoreTray = wantsRestoreTray();

  if (!needsRestoreTray) {
    destroyTrayIcons();
    return;
  }

  try {
    const staticIconPath = trayIconPath();
    const contextMenu = buildTrayMenu();

    if (showTrayStats) {
      // Stats mode uses two tray badges: weekly first (left), session second (right).
      if (!trayExists(weeklyTray)) {
        weeklyTray = new Tray(staticIconPath);
        wireTrayClick(weeklyTray);
      }
      weeklyTray.setToolTip('Weekly Usage');
      weeklyTray.setContextMenu(contextMenu);
    } else {
      destroyTray(weeklyTray);
      weeklyTray = null;
    }

    if (!trayExists(sessionTray)) {
      sessionTray = new Tray(staticIconPath);
      wireTrayClick(sessionTray);
    }
    sessionTray.setToolTip(showTrayStats ? 'Session Usage' : 'Claude Usage Widget');
    sessionTray.setContextMenu(contextMenu);
  } catch (error) {
    console.error('Failed to create tray:', error);
  }
}

function destroyTrayIcons() {
  // Centralized tray cleanup keeps Linux appindicator hosts from showing stale icons.
  const trays = [sessionTray, weeklyTray];
  sessionTray = null;
  weeklyTray = null;

  for (const tray of trays) {
    destroyTray(tray);
  }
}

/**
 * Format reset time for tray tooltip
 * @param {string} resetsAt - ISO timestamp string
 * @param {string} timeFormat - '12h' or '24h'
 * @param {boolean} includeDate - Whether to include the date (for weekly resets)
 * @returns {string} Formatted time string
 */
function formatResetTime(resetsAt, timeFormat, includeDate = false) {
  if (!resetsAt) return null;
  const date = new Date(resetsAt);
  
  const formatTime = () => {
    if (timeFormat === '24h') {
      return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
    } else {
      let hours = date.getHours();
      const minutes = date.getMinutes().toString().padStart(2, '0');
      const ampm = hours >= 12 ? 'PM' : 'AM';
      hours = hours % 12 || 12;
      return `${hours}:${minutes} ${ampm}`;
    }
  };
  
  if (includeDate) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monthStr = months[date.getMonth()];
    const dayNum = date.getDate();
    return `${monthStr} ${dayNum}, ${formatTime()}`;
  } else {
    return formatTime();
  }
}

/**
 * Update tray icons with current usage data
 * @param {Object} usageData - Usage data object containing session and weekly percentages
 */
// One short tooltip line per account, e.g. "Personal: S 45% / W 60%".
function trayTooltipLines() {
  return getAccounts().map((a) => {
    const d = latestUsageByAccount[a.id];
    if (!d) return `${a.label}: —`;
    return `${a.label}: S ${Math.round(d.five_hour?.utilization || 0)}% / W ${Math.round(d.seven_day?.utilization || 0)}%`;
  });
}

// Roll every account up into the two tray badges: the worst account drives the
// numbers, while the tooltip and context menu carry per-account detail. Replaces
// the single-account updateTrayIcon().
function updateTrayRollup() {
  const showTrayStats = store.get('settings.showTrayStats', false);

  if (!wantsRestoreTray()) {
    destroyTrayIcons();
    return;
  }

  // Keep a restore tray available when minimize-to-tray is enabled, even if
  // usage stat badges are disabled. In restore-only mode, only sessionTray is kept.
  createTray();

  if (!showTrayStats) {
    return;
  }

  if (!trayExists(sessionTray) || !trayExists(weeklyTray)) return;

  const warnThreshold = store.get('settings.warnThreshold', 75);
  const dangerThreshold = store.get('settings.dangerThreshold', 90);

  const worst = computeWorstAccount(getAccounts(), latestUsageByAccount);
  const sessionPercent = worst ? worst.sessionPct : 0;
  const weeklyPercent = worst ? worst.weeklyPct : 0;

  const header = worst ? `Closest to limit: ${worst.account.label}` : 'Claude Usage';
  const tooltip = [header, ...trayTooltipLines()].join('\n');

  try {
    // Weekly icon (blue background) — LEFT position
    let weeklyIcon;
    if (weeklyPercent >= 99) {
      weeklyIcon = generateRedXIcon();
    } else {
      const weeklyColor = getBackgroundColor(weeklyPercent, false, warnThreshold, dangerThreshold);
      weeklyIcon = generatePercentageIcon(weeklyPercent, weeklyColor);
    }
    if (weeklyTray && !weeklyTray.isDestroyed()) {
      weeklyTray.setImage(weeklyIcon);
      weeklyTray.setToolTip(tooltip);
    }

    // Session icon (purple background) — RIGHT position
    let sessionIcon;
    if (sessionPercent >= 99) {
      sessionIcon = generateRedXIcon();
    } else {
      const sessionColor = getBackgroundColor(sessionPercent, true, warnThreshold, dangerThreshold);
      sessionIcon = generatePercentageIcon(sessionPercent, sessionColor);
    }
    if (sessionTray && !sessionTray.isDestroyed()) {
      sessionTray.setImage(sessionIcon);
      sessionTray.setToolTip(tooltip);
    }

    // Refresh the context menu so its per-account detail lines stay current.
    const menu = buildTrayMenu();
    if (sessionTray && !sessionTray.isDestroyed()) sessionTray.setContextMenu(menu);
    if (weeklyTray && !weeklyTray.isDestroyed()) weeklyTray.setContextMenu(menu);
  } catch (error) {
    console.error('Failed to update tray icons:', error);
  }
}


// IPC Handlers — account management

// List accounts for the renderer (never returns the sessionKey itself).
ipcMain.handle('get-accounts', () => {
  return getAccounts().map((a) => ({
    id: a.id,
    label: a.label,
    orgId: a.orgId,
    partition: partitionFor(a.id),
    organizations: a.organizations || [],
    hasSession: !!loadAccountKey(a.id)
  }));
});

// Allocate an id + partition for a not-yet-saved account. The login/manual
// capture binds to this partition; nothing is persisted until save-account.
ipcMain.handle('create-draft-account', () => {
  const id = nextAccountId();
  return { id, partition: partitionFor(id), label: defaultLabel(getAccounts().length) };
});

// Persist (or update) an account, storing its sessionKey in the partition cookie
// jar plus an encrypted backup.
ipcMain.handle('save-account', async (event, { id, label, sessionKey, organizationId, organizations }) => {
  await setSessionCookie(sessionKey, id);
  saveAccountKey(id, sessionKey);

  const accounts = getAccounts();
  const existing = accounts.find((a) => a.id === id);
  if (existing) {
    if (label !== undefined) existing.label = label;
    if (organizationId !== undefined) existing.orgId = organizationId;
    if (organizations !== undefined) existing.organizations = organizations;
  } else {
    accounts.push({
      id,
      label: label || defaultLabel(accounts.length),
      orgId: organizationId,
      organizations: organizations || []
    });
  }
  setAccounts(accounts);
  updateTrayRollup();
  return true;
});

// Remove an account: drop its entry + key and wipe its partition so nothing
// lingers on shared machines. Other accounts are untouched.
ipcMain.handle('remove-account', async (event, id) => {
  setAccounts(getAccounts().filter((a) => a.id !== id));
  deleteAccountKey(id);
  delete latestUsageByAccount[id];
  try {
    const sess = session.fromPartition(partitionFor(id));
    const cookies = await sess.cookies.get({ url: 'https://claude.ai' });
    for (const cookie of cookies) {
      await sess.cookies.remove('https://claude.ai', cookie.name);
    }
    await sess.clearStorageData({
      storages: ['localstorage', 'sessionstorage', 'cachestorage'],
      origin: 'https://claude.ai'
    });
  } catch (err) {
    console.error(`[Account] Failed to clear partition for ${id}:`, err.message);
  }
  updateTrayRollup();
  return true;
});

ipcMain.handle('rename-account', (event, { id, label }) => {
  const accounts = getAccounts();
  const account = accounts.find((a) => a.id === id);
  if (account) {
    account.label = label;
    setAccounts(accounts);
    updateTrayRollup();
  }
  return true;
});

// Validate a sessionKey by fetching the org list via a hidden BrowserWindow bound
// to the account's partition (bypasses Cloudflare). Returns the resolvable orgs.
ipcMain.handle('validate-session-key', async (event, sessionKey, partition) => {
  debugLog('Validating session key on partition', partition);
  const sess = partition ? session.fromPartition(partition) : session.defaultSession;
  if (partition) sess.setUserAgent(CHROME_USER_AGENT);
  try {
    // Set the cookie on the account's partition first
    await sess.cookies.set({
      url: 'https://claude.ai',
      name: 'sessionKey',
      value: sessionKey,
      domain: '.claude.ai',
      path: '/',
      secure: true,
      httpOnly: true
    });

    // Fetch organizations through that partition (bypasses Cloudflare)
    const data = await fetchViaWindow('https://claude.ai/api/organizations', { partition });

    if (data && Array.isArray(data) && data.length > 0) {
      // Filter to orgs with 'chat' capability (excludes API-only orgs)
      const chatOrgs = data.filter((org) => org.capabilities && org.capabilities.includes('chat'));

      if (chatOrgs.length === 0) {
        return { success: false, error: 'No chat-enabled organizations found' };
      }

      // Prioritise a Team org if present, otherwise the first chat org
      const defaultOrg = chatOrgs.find((org) => org.raven_type === 'team') || chatOrgs[0];
      const orgId = defaultOrg.uuid || defaultOrg.id;

      debugLog(`Session key validated, found ${chatOrgs.length} chat org(s), default org ID:`, orgId);

      return {
        success: true,
        organizationId: orgId,
        organizations: chatOrgs.map((org) => ({
          id: org.uuid || org.id,
          name: org.name,
          isTeam: org.raven_type === 'team'
        }))
      };
    }

    if (data && data.error) {
      return { success: false, error: data.error.message || data.error };
    }

    return { success: false, error: 'No organization found' };
  } catch (error) {
    console.error('Session key validation failed:', error.message);
    // Clean up the invalid cookie on that partition
    try {
      await sess.cookies.remove('https://claude.ai', 'sessionKey');
    } catch (_) {}
    return { success: false, error: error.message };
  }
});

ipcMain.on('minimize-window', () => {
  if (mainWindow) {
    if (process.platform === 'darwin') {
      mainWindow.minimize();
    } else {
      const minimizeToTray = store.get('settings.minimizeToTray', false);
      if (minimizeToTray && wantsRestoreTray()) {
        createTray();
      }
      if (minimizeToTray && hasRestoreTray()) {
        mainWindow.hide();
      } else {
        mainWindow.minimize();
      }
    }
  }
});

ipcMain.on('close-window', () => {
  const showTrayStats = store.get('settings.showTrayStats', false);
  if (showTrayStats && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
  } else {
    app.quit();
  }
});

// v2.0 free-resize model: the user owns the window size. The renderer's pointer-
// driven resize grips call this on every frame while dragging; it clamps to the
// minimum size (keeping the opposite edge fixed so the window doesn't jump) and
// applies the bounds directly, regardless of the `resizable` window flag.
ipcMain.handle('set-window-bounds', (event, bounds) => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const current = mainWindow.getBounds();
  let width = Math.round(bounds.width ?? current.width);
  let height = Math.round(bounds.height ?? current.height);
  let x = Math.round(bounds.x ?? current.x);
  let y = Math.round(bounds.y ?? current.y);

  if (width < MIN_WINDOW_WIDTH) {
    if (x !== current.x) x = current.x + current.width - MIN_WINDOW_WIDTH;
    width = MIN_WINDOW_WIDTH;
  }
  if (height < MIN_WINDOW_HEIGHT) {
    if (y !== current.y) y = current.y + current.height - MIN_WINDOW_HEIGHT;
    height = MIN_WINDOW_HEIGHT;
  }

  mainWindow.setBounds({ x, y, width, height });

  // Consume the one-time first-run auto-size: the renderer measures its own
  // content height on first paint and calls this once to settle into it.
  if (firstRunAutoSize) {
    firstRunAutoSize = false;
    store.set('windowBounds', mainWindow.getBounds());
  }
  return true;
});

ipcMain.handle('get-window-bounds', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow.getBounds();
  }
  return null;
});

// Tells the renderer whether this is a true first run (no stored bounds yet),
// so it knows whether to perform the one-time content-height auto-size.
ipcMain.handle('get-window-init-info', () => {
  return {
    bounds: mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : null,
    isFirstRun: firstRunAutoSize
  };
});

ipcMain.on('open-external', (event, url) => {
  // Trust boundary enforcement: duplicate allowlist check in main process
  const allowedDomains = ['claude.ai', 'github.com', 'buymeacoffee.com'];
  try {
    const parsedUrl = new URL(url);
    const isAllowed = allowedDomains.some(domain => 
      parsedUrl.hostname === domain || parsedUrl.hostname.endsWith('.' + domain)
    );
    if (isAllowed) {
      shell.openExternal(url);
    } else {
      console.warn(`[Security] Blocked openExternal call to disallowed domain: ${parsedUrl.hostname}`);
    }
  } catch (err) {
    console.warn(`[Security] Blocked openExternal call with invalid URL: ${url}`);
  }
});

ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

ipcMain.handle('get-usage-history', (event, accountId) => {
  const historyKey = `usageHistory_acct_${accountId}`;
  const history = store.get(historyKey, []);
  const cutoff = Date.now() - (CHART_DAYS * 24 * 60 * 60 * 1000);
  return history
    .filter((entry) => entry.timestamp > cutoff)
    .sort((a, b) => a.timestamp - b.timestamp);
});

// Show a native OS desktop notification (Windows toast, macOS NC, Linux libnotify)
ipcMain.on('show-notification', (event, { title, body }) => {
  if (Notification.isSupported()) {
    const n = new Notification({ title, body, silent: false });
    n.show();
  }
});

// Theme system: settings.theme is 'dark' | 'light' | 'system'. 'system' follows
// the OS live via nativeTheme; the renderer re-applies tokens on every change.
ipcMain.handle('get-system-prefers-dark', () => nativeTheme.shouldUseDarkColors);
nativeTheme.on('updated', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('system-theme-updated', nativeTheme.shouldUseDarkColors);
  }
});

// Settings handlers
ipcMain.handle('get-settings', () => {
  return {
    autoStart: store.get('settings.autoStart', false),
    minimizeToTray: store.get('settings.minimizeToTray', false),
    alwaysOnTop: store.get('settings.alwaysOnTop', true),
    theme: store.get('settings.theme', 'dark'),
    warnThreshold: store.get('settings.warnThreshold', 75),
    dangerThreshold: store.get('settings.dangerThreshold', 90),
    timeFormat: store.get('settings.timeFormat', '12h'),
    weeklyDateFormat: store.get('settings.weeklyDateFormat', 'date'),
    usageAlerts: store.get('settings.usageAlerts', true),
    refreshInterval: store.get('settings.refreshInterval', '300'),
    graphVisible: store.get('settings.graphVisible', false),
    expandedOpen: store.get('settings.expandedOpen', false),
    showTrayStats: store.get('settings.showTrayStats', false)
  };
});

ipcMain.handle('save-settings', (event, settings) => {
  const isPortable = process.platform === 'win32' && !!process.env.PORTABLE_EXECUTABLE_FILE;
  // Portable builds skip autostart entirely — autorun via registry is unreliable
  // when the exe path changes with each version; users should use shell:startup.
  const autoStart = isPortable ? false : settings.autoStart;

  store.set('settings.autoStart', autoStart);
  store.set('settings.minimizeToTray', settings.minimizeToTray);
  store.set('settings.alwaysOnTop', settings.alwaysOnTop);
  store.set('settings.theme', settings.theme);
  store.set('settings.warnThreshold', settings.warnThreshold);
  store.set('settings.dangerThreshold', settings.dangerThreshold);
  store.set('settings.timeFormat', settings.timeFormat);
  store.set('settings.weeklyDateFormat', settings.weeklyDateFormat);
  store.set('settings.usageAlerts', settings.usageAlerts);
  store.set('settings.refreshInterval', settings.refreshInterval);
  store.set('settings.graphVisible', settings.graphVisible);
  store.set('settings.expandedOpen', settings.expandedOpen);
  store.set('settings.showTrayStats', settings.showTrayStats);

  // openAtLogin is not supported on Linux — Electron silently ignores it, so
  // autostart is implemented ourselves via the XDG autostart spec instead.
  // Portable builds skip autostart entirely (see isPortable above).
  if (process.platform === 'linux') {
    setLinuxAutostart(autoStart);
  } else if (!isPortable) {
    app.setLoginItemSettings({
      openAtLogin: autoStart,
      ...(process.platform !== 'darwin' && { path: app.getPath('exe') })
    });
  }

  if (mainWindow) {
    if (process.platform === 'darwin') {
      if (settings.minimizeToTray) { app.dock.hide(); } else { app.dock.show(); }
    } else {
      mainWindow.setSkipTaskbar(settings.minimizeToTray);
    }
    mainWindow.setAlwaysOnTop(settings.alwaysOnTop, 'floating');
  }

  if (wantsRestoreTray()) {
    // Refresh tray state immediately. This preserves a single restore tray when
    // stats are disabled but minimize-to-tray is enabled.
    updateTrayRollup();
  } else {
    destroyTrayIcons();
  }

  return true;
});

// Open a visible BrowserWindow for the user to log in to Claude.ai.
//
// Why we don't embed login directly in the app:
// Claude.ai (via Cloudflare) detects and blocks Electron-embedded logins.
// Instead, we open a standalone browser window, let the user authenticate
// normally, then capture the sessionKey cookie once login completes.
// Do NOT attempt to "fix" this back to an embedded login without verifying
// that Claude.ai/Cloudflare no longer blocks it.
//
// SECURITY: Navigation is restricted to trusted domains (claude.ai and OAuth
// providers) to prevent phishing attacks. Popup windows are blocked. Current
// URL is displayed in the window title bar for transparency.
ipcMain.handle('detect-session-key', async (event, partition) => {
  const sess = partition ? session.fromPartition(partition) : session.defaultSession;
  if (partition) sess.setUserAgent(CHROME_USER_AGENT);

  // Clear any leftover sessionKey cookie on this account's partition
  try {
    await sess.cookies.remove('https://claude.ai', 'sessionKey');
  } catch (e) { /* ignore */ }

  return new Promise((resolve) => {
    const loginWin = new BrowserWindow({
      width: 1000,
      height: 700,
      title: 'Claude Login - https://claude.ai/login',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        ...(partition ? { partition } : {})
      }
    });

    let resolved = false;

    // Security: restrict navigation to trusted domains only
    const allowedLoginDomains = [
      'claude.ai',
      'accounts.google.com',
      'appleid.apple.com',
      'login.microsoftonline.com'
    ];

    loginWin.webContents.on('will-navigate', (event, url) => {
      try {
        const hostname = new URL(url).hostname;
        const isAllowed = allowedLoginDomains.some(domain =>
          hostname === domain || hostname.endsWith('.' + domain)
        );
        if (!isAllowed) {
          event.preventDefault();
          console.warn('[Security] Blocked login navigation to untrusted domain:', url);
        } else {
          // Update title bar to show current URL (read-only)
          loginWin.setTitle(`Claude Login - ${url}`);
        }
      } catch (err) {
        event.preventDefault();
        console.warn('[Security] Blocked login navigation with invalid URL:', url);
      }
    });

    // Update title on OAuth redirects and in-page navigation
    loginWin.webContents.on('did-navigate', (event, url) => {
      loginWin.setTitle(`Claude Login - ${url}`);
    });

    loginWin.webContents.on('did-navigate-in-page', (event, url) => {
      loginWin.setTitle(`Claude Login - ${url}`);
    });

    // Security: block popup windows from login page
    loginWin.webContents.setWindowOpenHandler(() => {
      console.warn('[Security] Blocked popup window attempt from login page');
      return { action: 'deny' };
    });

    // Listen for sessionKey cookie being set after login
    const onCookieChanged = (event, cookie, cause, removed) => {
      if (
        cookie.name === 'sessionKey' &&
        cookie.domain.includes('claude.ai') &&
        !removed &&
        cookie.value
      ) {
        resolved = true;
        sess.cookies.removeListener('changed', onCookieChanged);
        loginWin.close();
        resolve({ success: true, sessionKey: cookie.value });
      }
    };

    sess.cookies.on('changed', onCookieChanged);

    loginWin.on('closed', () => {
      sess.cookies.removeListener('changed', onCookieChanged);
      if (!resolved) {
        resolve({ success: false, error: 'Login window closed' });
      }
    });

    loginWin.loadURL('https://claude.ai/login');
  });
});

// Check GitHub releases for a newer version
ipcMain.handle('check-for-update', () => {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
      method: 'GET',
      headers: {
        'User-Agent': 'claude-usage-widget',
        'Accept': 'application/vnd.github+json'
      },
      timeout: 5000
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          const tag = (data.tag_name || '').replace(/^v/, '');
          const current = app.getVersion();
          if (tag && isNewerVersion(tag, current)) {
            resolve({ hasUpdate: true, version: tag });
          } else {
            resolve({ hasUpdate: false, version: null });
          }
        } catch {
          resolve({ hasUpdate: false, version: null });
        }
      });
    });

    req.on('error', () => resolve({ hasUpdate: false, version: null }));
    req.on('timeout', () => { req.destroy(); resolve({ hasUpdate: false, version: null }); });
    req.end();
  });
});

function isNewerVersion(remote, local) {
  try {
    const parseVersion = (ver) => {
      const [mainVer, preRelease] = ver.split('-');
      const parts = mainVer.split('.').map(Number);
      return {
        major: parts[0] || 0,
        minor: parts[1] || 0,
        patch: parts[2] || 0,
        preRelease: preRelease || null
      };
    };

    const r = parseVersion(remote);
    const l = parseVersion(local);

    // Never notify about pre-release versions (rc, beta, alpha, etc.)
    if (r.preRelease !== null) return false;

    // Compare major.minor.patch
    if (r.major !== l.major) return r.major > l.major;
    if (r.minor !== l.minor) return r.minor > l.minor;
    if (r.patch !== l.patch) return r.patch > l.patch;

    // Same version numbers — notify if local is a pre-release and remote is stable
    // e.g. local=1.7.5-rc.1, remote=1.7.5 → user should be told stable is out
    return l.preRelease !== null;
  } catch { return false; }
}

ipcMain.handle('fetch-usage-data', async (event, accountId) => {
  const account = getAccount(accountId);
  if (!account) throw new Error('UnknownAccount');

  const sessionKey = loadAccountKey(accountId);
  const organizationId = account.orgId;
  if (!sessionKey || !organizationId) {
    throw new Error('Missing credentials');
  }

  // Ensure the cookie is present on this account's partition
  await setSessionCookie(sessionKey, accountId);

  const partition = partitionFor(accountId);

  // v1 fetches only the usage endpoint (overage/prepaid extra-usage is out of
  // scope for multi-account). fetchMultipleViaWindow reuses one hidden window
  // bound to the account's partition.
  const usageUrl = `https://claude.ai/api/organizations/${organizationId}/usage`;

  let data;
  try {
    const results = await fetchMultipleViaWindow([usageUrl], { partition });
    data = results[0];
  } catch (error) {
    debugLog(`API request failed for account ${accountId}:`, error.message);
    const isBlocked = error.message.startsWith('CloudflareBlocked')
      || error.message.startsWith('CloudflareChallenge')
      || error.message.startsWith('UnexpectedHTML');
    if (isBlocked) {
      // This account's session is dead — drop its key and flag only this card
      // for re-login. Other accounts keep polling.
      deleteAccountKey(accountId);
      delete latestUsageByAccount[accountId];
      if (mainWindow) {
        mainWindow.webContents.send('account-session-expired', accountId);
      }
      updateTrayRollup();
      throw new Error('SessionExpired');
    }
    throw error;
  }

  latestUsageByAccount[accountId] = data;
  storeUsageHistory(accountId, data);
  updateTrayRollup();

  // Re-assert always-on-top after hidden BrowserWindows from fetchViaWindow
  // are destroyed — creating/destroying BrowserWindows can temporarily disrupt
  // the main window's z-order on some OS/window manager combinations.
  if (mainWindow && !mainWindow.isDestroyed()) {
    const alwaysOnTop = store.get('settings.alwaysOnTop', true);
    if (alwaysOnTop) {
      mainWindow.setAlwaysOnTop(true, 'floating');
    }
  }

  return data;
});

// ---------------------------------------------------------------------------
// Linux desktop integration (icon, taskbar pinning, autostart)
//
// StartupWMClass must equal the real WM_CLASS the packaged app reports — this
// value is package.json's build.linux.desktop.entry.StartupWMClass guess
// (productName). VERIFY with `xprop WM_CLASS` on the built app before release
// and update both places together if it's wrong.
// ---------------------------------------------------------------------------
const LINUX_WM_CLASS = 'Claude-Usage-Widget';
const LINUX_ICON_NAME = 'claude-usage-widget';
const LINUX_DESKTOP_ENTRY_NAME = 'claude-usage-widget.desktop';

function linuxExecPath() {
  return process.env.APPIMAGE || process.execPath;
}

function buildLinuxDesktopEntry(execPath, autostart) {
  const lines = [
    '[Desktop Entry]',
    'Name=Claude Usage Widget',
    'Comment=Monitor Claude.ai usage across accounts',
    `Exec="${execPath}" %U`,
    `Icon=${LINUX_ICON_NAME}`,
    `StartupWMClass=${LINUX_WM_CLASS}`,
    'Terminal=false',
    'Type=Application',
    'Categories=Utility;'
  ];
  if (autostart) lines.push('X-GNOME-Autostart-enabled=true');
  return lines.join('\n') + '\n';
}

// AppImages aren't installed via a package manager, so no .desktop file exists
// in ~/.local/share/applications for the window manager to match the running
// window against — without one there's no correct taskbar icon and nothing to
// pin. This writes the icon + a .desktop entry once per AppImage path (skip
// silently on any error; .deb installs get this for free from electron-builder).
function ensureLinuxDesktopIntegration() {
  if (process.platform !== 'linux' || !process.env.APPIMAGE) return;

  try {
    const iconDir = path.join(os.homedir(), '.local', 'share', 'icons', 'hicolor', '512x512', 'apps');
    fs.mkdirSync(iconDir, { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'assets/icons/512x512.png'), path.join(iconDir, `${LINUX_ICON_NAME}.png`));

    const appsDir = path.join(os.homedir(), '.local', 'share', 'applications');
    const desktopPath = path.join(appsDir, LINUX_DESKTOP_ENTRY_NAME);
    const execPath = linuxExecPath();

    // Rewrite only if missing or pointing at a stale AppImage path (moved/updated).
    const upToDate = fs.existsSync(desktopPath) && fs.readFileSync(desktopPath, 'utf-8').includes(`Exec="${execPath}"`);
    if (!upToDate) {
      fs.mkdirSync(appsDir, { recursive: true });
      fs.writeFileSync(desktopPath, buildLinuxDesktopEntry(execPath, false));
      execFile('update-desktop-database', [appsDir], () => {}); // best-effort, ignore failure
    }
  } catch (err) {
    debugLog('[Linux] Desktop integration skipped:', err.message);
  }
}

// Electron's setLoginItemSettings is a no-op on Linux, so autostart is
// implemented directly via the XDG autostart spec (~/.config/autostart).
function setLinuxAutostart(enabled) {
  try {
    const autostartDir = path.join(os.homedir(), '.config', 'autostart');
    const desktopPath = path.join(autostartDir, LINUX_DESKTOP_ENTRY_NAME);
    if (enabled) {
      fs.mkdirSync(autostartDir, { recursive: true });
      fs.writeFileSync(desktopPath, buildLinuxDesktopEntry(linuxExecPath(), true));
    } else if (fs.existsSync(desktopPath)) {
      fs.unlinkSync(desktopPath);
    }
  } catch (err) {
    debugLog('[Linux] Autostart toggle failed:', err.message);
  }
}

// App lifecycle
if (gotTheLock) {
app.whenReady().then(async () => {
  // History housekeeping: fold the single-key legacy history into the per-org key
  // (still keyed off any legacy organizationId, before migrateLegacyAccount deletes it).
  migrateUsageHistoryKey();

  // Fold any legacy single-account config into accounts[0], then restore each
  // account's sessionKey cookie onto its own partition.
  migrateLegacyAccount();

  // Now that accounts[] is populated, rename any per-org history key to the
  // per-account key, then prune whatever's left (stale/orphaned or aged-out).
  migrateUsageHistoryKeysToAccounts();
  pruneStaleHistoryKeys();

  for (const account of getAccounts()) {
    const key = loadAccountKey(account.id);
    if (key) {
      await setSessionCookie(key, account.id);
    }
  }

  createMainWindow();
  ensureLinuxDesktopIntegration();
  if (process.platform === 'linux' && store.get('settings.autoStart', false)) {
    setLinuxAutostart(true);
  }
  // Create a tray at startup when either stats are shown or the tray is needed
  // as the restore path for minimize-to-tray.
  if (wantsRestoreTray()) {
    createTray();
  }

  // Apply persisted settings
  const minimizeToTray = store.get('settings.minimizeToTray', false);
  const alwaysOnTop = store.get('settings.alwaysOnTop', true);
  if (mainWindow) {
    if (process.platform === 'darwin') {
      if (minimizeToTray) app.dock.hide();
    } else {
      if (minimizeToTray) mainWindow.setSkipTaskbar(true);
    }
    mainWindow.setAlwaysOnTop(alwaysOnTop, 'floating');
  }

  // Periodic always-on-top re-assertion to recover from z-order disruptions
  // (hidden window spawns, window manager shortcuts, alt-tab, etc.)
  setInterval(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const alwaysOnTopSetting = store.get('settings.alwaysOnTop', true);
      if (alwaysOnTopSetting) {
        mainWindow.setAlwaysOnTop(true, 'floating');
      }
    }
  }, 5000);
});
}

app.on('window-all-closed', () => {
  // Keep running in tray — but only if a tray icon actually exists to restore
  // from. With showTrayStats off there is no tray, so an OS-level window close
  // (Alt+F4, WM close) would otherwise leave a headless process with no way
  // to reopen it.
  if (!hasRestoreTray()) app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) {
    createMainWindow();
  } else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    showMainWindowClean();
  } else if (gotTheLock) {
    createMainWindow();
  }
});
