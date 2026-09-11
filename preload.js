const { contextBridge, ipcRenderer } = require('electron');

// Allowed domains for openExternal — prevents renderer from opening arbitrary URLs
const ALLOWED_EXTERNAL_DOMAINS = [
  'claude.ai',
  'chatgpt.com',
  'openai.com',
  'github.com',
  'buymeacoffee.com'
];

function isAllowedExternalUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    return ALLOWED_EXTERNAL_DOMAINS.some(domain =>
      parsed.hostname === domain || parsed.hostname.endsWith('.' + domain)
    );
  } catch {
    return false;
  }
}

// The theme to paint with, resolved SYNCHRONOUSLY so src/renderer/theme-boot.js
// can apply it before the stylesheet paints. An await here would be a visible
// flash of the other palette on a small always-on-top window.
//
// sendSync is the right tool for exactly this and nothing else: it is one
// blocking hop, once per document load, for a value the first paint depends on.
// This file is re-evaluated on every navigation, so a reload picks up a theme
// that changed since the window was created - which the window's own command
// line, fixed when the window was made, cannot do. That argument is kept as the
// fallback for when the handler is not there to answer (a test harness that
// loads a page with this preload but not main.js, say).
function initialTheme() {
  try {
    const current = ipcRenderer.sendSync('get-theme-sync');
    if (current === 'light' || current === 'dark') return current;
  } catch (error) {
    // Fall through to the command line.
  }
  const arg = process.argv.find((a) => a.startsWith('--widget-theme='));
  return arg && arg.slice('--widget-theme='.length) === 'light' ? 'light' : 'dark';
}

contextBridge.exposeInMainWorld('electronAPI', {
  // Appearance
  initialTheme: initialTheme(),
  setTheme: (theme) => ipcRenderer.invoke('set-theme', theme),
  // Account management (multi-account, multi-provider)
  getAccounts: () => ipcRenderer.invoke('get-accounts'),
  createDraftAccount: () => ipcRenderer.invoke('create-draft-account'),
  saveAccount: (account) => ipcRenderer.invoke('save-account', account),
  removeAccount: (id) => ipcRenderer.invoke('remove-account', id),
  // Add/reconnect cancellation support: discard a never-saved draft partition,
  // and close any pending login-capture window bound to a partition.
  discardDraftAccount: (id) => ipcRenderer.invoke('discard-draft-account', id),
  cancelLoginCapture: (partition, flowId) => ipcRenderer.invoke('cancel-login-capture', partition, flowId),
  renameAccount: (id, label) => ipcRenderer.invoke('rename-account', { id, label }),
  // partition binds the capture/validation to a specific account's cookie jar
  validateSessionKey: (sessionKey, partition, flowId) => ipcRenderer.invoke('validate-session-key', sessionKey, partition, flowId),
  detectSessionKey: (partition, flowId) => ipcRenderer.invoke('detect-session-key', partition, flowId),
  validateChatGPTToken: (token, partition, flowId) => ipcRenderer.invoke('validate-chatgpt-token', token, partition, flowId),
  detectChatGPTToken: (partition, flowId) => ipcRenderer.invoke('detect-chatgpt-token', partition, flowId),
  // Per-account manual usage entry (fallback when auto-reading fails/is off)
  saveAccountManual: (id, manual) => ipcRenderer.invoke('save-account-manual', { id, manual }),
  // A manual-only account: no provider login, no credential. Used by the
  // first-run "Enter usage manually" route.
  createManualAccount: (payload) => ipcRenderer.invoke('create-manual-account', payload),

  // What the OS offers for credential protection, so a refused sign-in can be
  // explained instead of failing silently.
  getSecureStorage: () => ipcRenderer.invoke('get-secure-storage'),

  // Configuration health: whether the saved configuration was usable, and
  // whether this session can save at all.
  getConfigHealth: () => ipcRenderer.invoke('get-config-health'),
  onConfigHealth: (callback) => {
    ipcRenderer.on('config-health', (event, health) => callback(health));
  },

  // Window controls
  minimizeWindow: () => ipcRenderer.send('minimize-window'),
  closeWindow: () => ipcRenderer.send('close-window'),

  // Window bounds — the user owns the window size (v2.0 free-resize model).
  // Resize grips + first-run auto-size + the settings temporary-grow all drive
  // through setWindowBounds; getWindowInitInfo tells the renderer whether this
  // is a true first run so it knows whether to auto-size to content once.
  getWindowBounds: () => ipcRenderer.invoke('get-window-bounds'),
  setWindowBounds: (bounds) => ipcRenderer.invoke('set-window-bounds', bounds),
  getWindowInitInfo: () => ipcRenderer.invoke('get-window-init-info'),

  // Event listeners
  onRefreshUsage: (callback) => {
    ipcRenderer.on('refresh-usage', () => callback());
  },
  // Fired when a single account's session is blocked/expired — carries the id
  // so only that card flips to the reconnect state.
  onAccountSessionExpired: (callback) => {
    ipcRenderer.on('account-session-expired', (event, accountId) => callback(accountId));
  },

  // API
  fetchUsageData: (accountId) => ipcRenderer.invoke('fetch-usage-data', accountId),
  getUsageHistory: (accountId) => ipcRenderer.invoke('get-usage-history', accountId),
  openExternal: (url) => {
    if (isAllowedExternalUrl(url)) {
      ipcRenderer.send('open-external', url);
    } else {
      console.warn('openExternal blocked — URL not in allowlist:', url);
    }
  },

  // Platform
  platform: process.platform,
  isPortable: process.platform === 'win32' && !!process.env.PORTABLE_EXECUTABLE_FILE,

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  // Updates
  checkForUpdate: () => ipcRenderer.invoke('check-for-update'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getReleasesUrl: () => ipcRenderer.invoke('get-releases-url'),

  // Notifications
  showNotification: (title, body) => ipcRenderer.send('show-notification', { title, body })
});
