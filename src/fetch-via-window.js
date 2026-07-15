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

function safeClose(win) {
  if (win && !win.isDestroyed()) {
    win.close();
  }
}

function validateApiNavigation(targetUrl, expectedUrl) {
  try {
    const parsed = new URL(targetUrl);
    const expected = new URL(expectedUrl);
    return parsed.origin === expected.origin && parsed.pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

function createFetchWindow(partition) {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
      ...(partition ? { partition } : {})
    }
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  return win;
}

/**
 * Parse and validate response body text
 * @param {string} bodyText - Raw body text from the page
 * @returns {Object} Parsed JSON data
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
 *   When set, the window uses that account's isolated cookie jar so each account's
 *   sessionKey stays separate. Omit to use the default session.
 * @returns {Promise<Object>} Parsed JSON response
 */
function fetchViaWindow(url, { timeoutMs = 30000, partition } = {}) {
  return new Promise((resolve, reject) => {
    const win = createFetchWindow(partition);
    let settled = false;

    function fail(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      safeClose(win);
      reject(error);
    }

    function succeed(data) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      safeClose(win);
      resolve(data);
    }

    const timeout = setTimeout(() => {
      fail(new Error('RequestTimeout'));
    }, timeoutMs);

    win.webContents.on('will-navigate', (event, targetUrl) => {
      if (!validateApiNavigation(targetUrl, url)) {
        event.preventDefault();
        fail(new Error(`UnexpectedNavigation: ${targetUrl}`));
      }
    });

    win.webContents.on('did-finish-load', async () => {
      try {
        const bodyText = await win.webContents.executeJavaScript(
          'document.body.innerText || document.body.textContent'
        );
        succeed(parseResponseBody(bodyText));
      } catch (err) {
        fail(err);
      }
    });

    win.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
      fail(new Error(`LoadFailed: ${errorCode} ${errorDescription}`));
    });

    win.loadURL(url).catch(fail);
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
    const win = createFetchWindow(partition);
    const results = [];
    let currentIndex = 0;
    let currentTimeout = null;
    let settled = false;

    function clearCurrentTimeout() {
      if (currentTimeout) {
        clearTimeout(currentTimeout);
        currentTimeout = null;
      }
    }

    function fail(error) {
      if (settled) return;
      settled = true;
      clearCurrentTimeout();
      safeClose(win);
      reject(error);
    }

    function finish() {
      if (settled) return;
      settled = true;
      clearCurrentTimeout();
      safeClose(win);
      resolve(results);
    }

    /**
     * Load the next URL in the sequence
     */
    function loadNext() {
      if (currentIndex >= urls.length) {
        finish();
        return;
      }

      const url = urls[currentIndex];

      currentTimeout = setTimeout(() => {
        fail(new Error(`RequestTimeout at URL ${currentIndex}: ${url}`));
      }, timeoutMs);

      win.loadURL(url).catch(fail);
    }

    win.webContents.on('will-navigate', (event, targetUrl) => {
      const expectedUrl = urls[currentIndex];
      if (expectedUrl && !validateApiNavigation(targetUrl, expectedUrl)) {
        event.preventDefault();
        fail(new Error(`UnexpectedNavigation at URL ${currentIndex}: ${targetUrl}`));
      }
    });

    win.webContents.on('did-finish-load', async () => {
      try {
        const bodyText = await win.webContents.executeJavaScript(
          'document.body.innerText || document.body.textContent'
        );

        clearCurrentTimeout();
        results.push(parseResponseBody(bodyText));
        currentIndex++;
        loadNext();
      } catch (err) {
        fail(err);
      }
    });

    win.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
      fail(new Error(`LoadFailed at URL ${currentIndex}: ${errorCode} ${errorDescription}`));
    });

    // Start loading the first URL
    loadNext();
  });
}

module.exports = { fetchViaWindow, fetchMultipleViaWindow };
