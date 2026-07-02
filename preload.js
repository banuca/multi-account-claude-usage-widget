const { contextBridge, ipcRenderer } = require('electron');

// Allowed domains for openExternal — prevents renderer from opening arbitrary URLs
const ALLOWED_EXTERNAL_DOMAINS = [
  'claude.ai',
  'github.com',
  'paypal.me'
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

contextBridge.exposeInMainWorld('electronAPI', {
  // Account management (multi-account)
  getAccounts: () => ipcRenderer.invoke('get-accounts'),
  createDraftAccount: () => ipcRenderer.invoke('create-draft-account'),
  saveAccount: (account) => ipcRenderer.invoke('save-account', account),
  removeAccount: (id) => ipcRenderer.invoke('remove-account', id),
  renameAccount: (id, label) => ipcRenderer.invoke('rename-account', { id, label }),
  // partition binds the capture/validation to a specific account's cookie jar
  validateSessionKey: (sessionKey, partition) => ipcRenderer.invoke('validate-session-key', sessionKey, partition),
  detectSessionKey: (partition) => ipcRenderer.invoke('detect-session-key', partition),

  // Window controls
  minimizeWindow: () => ipcRenderer.send('minimize-window'),
  closeWindow: () => ipcRenderer.send('close-window'),
  resizeWindow: (height) => ipcRenderer.send('resize-window', height),

  // Window position
  getWindowPosition: () => ipcRenderer.invoke('get-window-position'),
  setWindowPosition: (position) => ipcRenderer.invoke('set-window-position', position),

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
  getUsageHistory: () => ipcRenderer.invoke('get-usage-history'),
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

  // Notifications
  showNotification: (title, body) => ipcRenderer.send('show-notification', { title, body }),

  // Compact mode
  setCompactMode: (compact) => ipcRenderer.send('set-compact-mode', compact)
});
