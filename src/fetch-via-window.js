/**
 * fetch-via-window.js
 *
 * Fetches JSON from a URL using a hidden BrowserWindow.
 *
 * Why this exists:
 * Claude.ai uses Cloudflare protection and detects Electron's default
 * request headers, blocking standard Node.js fetch/http requests.
 * By loading the URL in a hidden BrowserWindow with a spoofed Chrome
 * User-Agent, we ride on the browser session cookies and bypass
 * Cloudflare's bot detection. This is the simplest reliable approach
 * after the previous cookie-database-reading strategy proved too
 * fragile and OS-specific.
 */
const { BrowserWindow } = require('electron');

/**
 * Known error signatures returned when Claude.ai blocks or changes behaviour.
 * If the extracted body matches one of these patterns we throw a specific error
 * so callers can react (e.g. prompt re-login).
 */
const BLOCKED_SIGNATURES = [
  { pattern: 'Just a moment', error: 'CloudflareBlocked' },
  { pattern: 'Enable JavaScript and cookies to continue', error: 'CloudflareChallenge' },
  { pattern: '<html', error: 'UnexpectedHTML' },
];

/**
 * Parse and validate response body text
 * @param {string} bodyText - Raw body text from the page * @returns {Object} Parsed JSON data
 * @throws {Error} If blocked signatures detected or JSON parsing fails
 */
function parseResponseBody(bodyText) {
  // Detect known block/failure signatures before attempting JSON parse.
  // This provides explicit errors when Claude.ai modifies their API or CSP.
  for (const sig of BLOCKED_SIGNATURES) {
    if (bodyText.includes(sig.pattern)) {
      throw new Error(`${sig.error}: ${bodyText.substring(0, 200)}`);
    }
  }

  try {
    return JSON.parse(bodyText);
  } catch (parseErr) {
    throw new Error('InvalidJSON: ' + bodyText.substring(0, 200));
  }
}

/**
 * Fetch a single URL using a dedicated BrowserWindow (legacy single-call approach)
 * @param {string} url - URL to fetch
 * @param {Object} options - Options object
 * @param {number} options.timeoutMs - Request timeout in milliseconds (default: 30000)
 * @param {string} [options.partition] - Session partition to ride (e.g. 'persist:acct-1').
 * @param {AbortSignal} [options.signal] - Closes the hidden window when cancelled.
 *   When set, the window uses that account's isolated cookie jar so each account's
 *   sessionKey stays separate. Omit to use the default session.
 * @returns {Promise<Object>} Parsed JSON response
 */
function fetchViaWindow(url, { timeoutMs = 30000, partition, signal } = {}) {
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      width: 800,
      height: 600,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        ...(partition ? { partition } : {})
      }
    });

    let settled = false;

    const finish = (error, data) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (!win.isDestroyed()) win.close();
      if (error) reject(error);
      else resolve(data);
    };

    const onAbort = () => finish(new Error('AuthFlowCancelled'));
    const timeout = setTimeout(() => finish(new Error('Request timeout')), timeoutMs);
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    win.webContents.on('did-finish-load', async () => {
      try {
        const bodyText = await win.webContents.executeJavaScript(
          'document.body.innerText || document.body.textContent'
        );
        if (settled) return;
        const data = parseResponseBody(bodyText);
        finish(null, data);
      } catch (err) {
        finish(err);
      }
    });

    win.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
      finish(new Error(`LoadFailed: ${errorCode} ${errorDescription}`));
    });

    // loadURL rejects when cancellation destroys the window mid-navigation.
    // Keep that rejection owned by this operation: never touch a destroyed
    // window, and never surface it once the request has already settled.
    const load = async () => {
      if (settled || win.isDestroyed()) return;
      try {
        await win.loadURL(url);
      } catch (error) {
        if (!settled) finish(new Error('LoadFailed: ' + error.message));
      }
    };

    void load();
  });
}

/**
 * Fetch multiple URLs sequentially using a single reused BrowserWindow
 * This reduces memory overhead by avoiding repeated window creation/destruction
 * 
 * @param {string[]} urls - Array of URLs to fetch
 * @param {Object} options - Options object
 * @param {number} options.timeoutMs - Per-request timeout in milliseconds (default: 10000)
 * @param {string} [options.partition] - Session partition to ride (e.g. 'persist:acct-1').
 *   Routes every request in the batch through that account's isolated cookie jar.
 * @returns {Promise<Object[]>} Array of parsed JSON responses (or errors)
 */
function fetchMultipleViaWindow(urls, { timeoutMs = 10000, partition } = {}) {
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      width: 800,
      height: 600,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        ...(partition ? { partition } : {})
      }
    });

    const results = [];
    let currentIndex = 0;
    let currentTimeout = null;

    /**
     * Load the next URL in the sequence
     */
    function loadNext() {
      if (currentIndex >= urls.length) {
        // All URLs fetched successfully
        win.close();
        resolve(results);
        return;
      }

      const url = urls[currentIndex];
      
      currentTimeout = setTimeout(() => {
        win.close();
        reject(new Error(`Request timeout for URL ${currentIndex}: ${url}`));
      }, timeoutMs);

      win.loadURL(url);
    }

    win.webContents.on('did-finish-load', async () => {
      try {
        const bodyText = await win.webContents.executeJavaScript(
          'document.body.innerText || document.body.textContent'
        );
        if (currentTimeout) {
          clearTimeout(currentTimeout);
          currentTimeout = null;
        }

        const data = parseResponseBody(bodyText);
        results.push(data);
        currentIndex++;
        loadNext();
      } catch (err) {
        if (currentTimeout) {
          clearTimeout(currentTimeout);
          currentTimeout = null;
        }
        win.close();
        reject(err);
      }
    });

    win.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
      if (currentTimeout) {
        clearTimeout(currentTimeout);
        currentTimeout = null;
      }
      win.close();
      reject(new Error(`LoadFailed at URL ${currentIndex}: ${errorCode} ${errorDescription}`));
    });

    // Start loading the first URL
    loadNext();
  });
}

module.exports = { fetchViaWindow, fetchMultipleViaWindow };
