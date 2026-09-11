/**
 * providers.js
 *
 * Provider-specific usage logic, shared by main.js.
 *
 * Claude usage comes from the official /api/organizations/{org}/usage endpoint
 * (sessionKey-cookie authenticated). ChatGPT usage comes from chatgpt.com's
 * internal `backend-api/wham/usage` endpoint, which authenticates with a
 * Bearer access token — NOT the login cookie. The token is minted by the
 * logged-in web app itself, so we load chatgpt.com in a hidden BrowserWindow
 * on the account's own partition and capture the live token from the page's
 * own backend-api requests (webRequest interception), falling back to the
 * legacy /api/auth/session exchange, then call wham/usage from inside the
 * page so all Cloudflare/session cookies ride along.
 *
 * The wham/usage endpoint is reverse-engineered and undocumented — it may
 * change without notice. Parsing is deliberately defensive: every section
 * except `plan_type` is optional. See:
 *   https://github.com/openai/codex (codex-rs backend client + OpenAPI models)
 *   https://github.com/vbgate/opencode-mystatus
 *   https://github.com/PowerUserZ/OpenTokenUsage
 *   https://linux.do/t/topic/2137136
 *
 * Both providers normalize into the shared rows shape used by the renderer,
 * tray, history and alerts:
 *
 *   {
 *     provider: 'claude' | 'chatgpt',
 *     source:   'auto' | 'manual',
 *     tier?:    string,            // ChatGPT plan_type when known
 *     rows: [{
 *       key: 'session' | 'weekly' | 'manual',
 *       label: '...',              // human label on the card
 *       shortLabel: '...',         // tray / tooltip label
 *       windowMs: number|null,     // reset-window duration for the elapsed ring
 *       utilization: number,       // 0-100
 *       resets_at: ISO|null,
 *       used?: number, limit?: number  // manual entries only
 *     }],
 *     raw: {...}                   // provider payload (Claude extra rows etc.)
 *   }
 */
const { BrowserWindow } = require('electron');
const { readPercent, readNumber, usageRow, availableRows } = require('./usage-status');

const CHATGPT_HOME = 'https://chatgpt.com/';
const CHATGPT_USAGE_PATH = '/backend-api/wham/usage';
const SESSION_WINDOW_MS = 5 * 60 * 60 * 1000;
const WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// Clamp an already-known-good number into 0-100. NOT a parser: use
// readPercent() from usage-status.js to decide whether a provider value is a
// reading at all — clampPct turns a missing value into a fake 0%.
function clampPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(Math.round(n), 0), 100);
}

// "5h" / "3h" / "7d" — short label for a window length in seconds.
function windowShortLabel(seconds) {
  const s = Number(seconds);
  if (!s || s <= 0) return null;
  if (s % 86400 === 0) return `${s / 86400}d`;
  if (s % 3600 === 0) return `${s / 3600}h`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

// ── Claude ─────────────────────────────────────────────────────────────────

function normalizeClaudeUsage(raw) {
  const payload = raw && typeof raw === 'object' ? raw : {};
  const rows = [];
  const five = payload.five_hour;
  const seven = payload.seven_day;

  // A section that is present but carries no readable utilization stays as an
  // unavailable row: the card then says which reading is missing instead of
  // showing a green 0% or silently dropping the row.
  if (five && typeof five === 'object') {
    rows.push(usageRow({
      key: 'session',
      label: 'Current session',
      shortLabel: '5h',
      windowMs: SESSION_WINDOW_MS,
      resets_at: five.resets_at || null
    }, five.utilization));
  }
  if (seven && typeof seven === 'object') {
    rows.push(usageRow({
      key: 'weekly',
      label: 'Weekly limit',
      shortLabel: '7d',
      windowMs: WEEKLY_WINDOW_MS,
      resets_at: seven.resets_at || null
    }, seven.utilization));
  }

  return { provider: 'claude', source: 'auto', rows, raw: payload };
}

// ── ChatGPT ────────────────────────────────────────────────────────────────

// Map the wham/usage payload onto the shared rows shape. Defensive: every
// section except plan_type is optional and additive across server versions.
function normalizeChatGPTUsage(raw) {
  const payload = raw && typeof raw === 'object' ? raw : {};
  const rateLimit = payload.rate_limit || {};
  const primary = rateLimit.primary_window;
  const secondary = rateLimit.secondary_window;
  const rows = [];

  // A window that is present but carries no readable used_percent stays as an
  // unavailable row (see normalizeClaudeUsage).
  const pushWindow = (key, win, fallbackLabel) => {
    if (!win || typeof win !== 'object') return;
    const seconds = Number(win.limit_window_seconds);
    const shortLabel = windowShortLabel(seconds);
    rows.push(usageRow({
      key,
      label: shortLabel
        ? (key === 'session' ? `${shortLabel} limit` : 'Weekly limit')
        : fallbackLabel,
      shortLabel: shortLabel || key,
      windowMs: seconds > 0 ? seconds * 1000 : (key === 'session' ? SESSION_WINDOW_MS : WEEKLY_WINDOW_MS),
      resets_at: win.reset_at ? new Date(win.reset_at * 1000).toISOString() : null
    }, win.used_percent));
  };

  pushWindow('session', primary, 'Short window');
  pushWindow('weekly', secondary, 'Weekly limit');

  // Business/usage-based plans expose a spend-control bucket instead of the
  // standard windows — surface it as a fallback row when the standard windows
  // produced no reading at all (absent, or present but unreadable).
  const spend = payload.spend_control?.individual_limit;
  if (!availableRows(rows).length && spend && typeof spend === 'object'
      && readPercent(spend.used_percent) !== null) {
    rows.length = 0;
    rows.push(usageRow({
      key: 'session',
      label: 'Spend control',
      shortLabel: 'Spend',
      windowMs: null,
      resets_at: spend.reset_at ? new Date(spend.reset_at * 1000).toISOString() : null
    }, spend.used_percent));
  }

  return {
    provider: 'chatgpt',
    source: 'auto',
    tier: payload.plan_type || null,
    credits: payload.credits || null,
    rows,
    raw: payload
  };
}

/**
 * Read ChatGPT usage via a hidden BrowserWindow bound to the account's
 * partition:
 *   1. Load chatgpt.com (the SPA fires backend-api requests immediately —
 *      their Authorization header is captured by webRequest).
 *   2. Mint a token via the legacy /api/auth/session exchange if nothing was
 *      captured.
 *   3. Call wham/usage from inside the page (same-origin, all session and
 *      Cloudflare cookies included).
 *   4. On 401, drop the captured token and reload once before giving up.
 *
 * @param {Object} options
 * @param {string} [options.partition] - Account partition (persist:acct-N).
 * @param {number} [options.timeoutMs] - Total budget, default 25000.
 * @param {AbortSignal} [options.signal] - Closes the hidden window when cancelled.
 * @returns {Promise<Object>} Normalized usage data.
 */
function fetchChatGPTUsageData({ partition, timeoutMs = 25000, signal }) {
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
    const ses = win.webContents.session;
    const MAX_ATTEMPTS = 2;

    let capturedToken = null;
    let settled = false;
    let attempt = 0;

    const cleanup = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
      try {
        ses.webRequest.onBeforeSendHeaders(null);
      } catch (_) {}
    };

    const finish = (err, data) => {
      if (settled) return;
      settled = true;
      cleanup();
      clearTimeout(timeout);
      if (!win.isDestroyed()) win.close();
      if (err) reject(err);
      else resolve(data);
    };

    const onAbort = () => finish(new Error('AuthFlowCancelled'), null);
    const timeout = setTimeout(() => finish(new Error('Request timeout')), timeoutMs);
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    // Capture the bearer token the SPA attaches to its own backend-api calls.
    const onHeaders = (details, callback) => {
      if (!settled && details.url && details.url.includes('/backend-api/')) {
        const headers = details.requestHeaders || {};
        const auth = headers['Authorization'] || headers['authorization'];
        if (auth && auth.startsWith('Bearer ')) {
          capturedToken = auth.slice(7);
        }
      }
      callback({ requestHeaders: details.requestHeaders });
    };
    ses.webRequest.onBeforeSendHeaders(
      { urls: ['*://chatgpt.com/*', '*://*.chatgpt.com/*'] },
      onHeaders
    );

    const runInPage = async () => {
      attempt += 1;
      const token = capturedToken;

      const script = `(async () => {
        const bodyText = (document.body && (document.body.innerText || document.body.textContent)) || '';
        if (bodyText.includes('Just a moment') || bodyText.includes('Enable JavaScript and cookies')) {
          return { error: 'CloudflareBlocked' };
        }
        let token = ${JSON.stringify(token || null)};
        // Why every branch here is distinct: failing to OBTAIN a token is not
        // the same claim as "this account is not signed in", and only the
        // second one may cost the user their saved credential. A thrown
        // request, a 5xx, an HTML error page or unparseable JSON says the
        // exchange endpoint was unusable. A valid reply carrying no token, or
        // an outright 401/403, is the endpoint stating nobody is signed in.
        let exchange = null;
        if (!token) {
          try {
            const res = await fetch('/api/auth/session', { credentials: 'include', headers: { accept: 'application/json' } });
            if (res.status === 401 || res.status === 403) {
              exchange = 'Rejected';
            } else if (res.status === 429) {
              exchange = 'RateLimited';
            } else if (!res.ok) {
              exchange = 'ServiceError' + res.status;
            } else {
              const text = await res.text();
              let parsed = null;
              try { parsed = JSON.parse(text); }
              catch (e) { exchange = 'Unparseable'; }
              if (parsed) {
                token = (parsed && (parsed.accessToken || parsed.access_token)) || null;
                if (!token) exchange = 'NoTokenInResponse';
              }
            }
          } catch (e) {
            exchange = 'Unreachable';
          }
        }
        if (!token) {
          const proven = exchange === 'Rejected' || exchange === 'NoTokenInResponse';
          return { error: proven ? 'NoAccessToken' : 'SessionExchangeFailed', exchange: exchange || 'NoCapturedToken' };
        }
        const res = await fetch('${CHATGPT_USAGE_PATH}', {
          credentials: 'include',
          headers: { accept: 'application/json', authorization: 'Bearer ' + token }
        });
        if (!res.ok) return { error: 'HTTP' + res.status };
        const text = await res.text();
        try { return { data: JSON.parse(text) }; }
        catch (e) { return { error: 'InvalidJSON', text: text.slice(0, 120) }; }
      })()`;

      let result;
      try {
        result = await win.webContents.executeJavaScript(script, true);
      } catch (err) {
        if (settled) return;
        if (attempt < MAX_ATTEMPTS) {
          await reloadHome();
          return;
        }
        finish(new Error('PageError: ' + err.message), null);
        return;
      }
      if (settled) return;

      if (result && result.data) {
        finish(null, normalizeChatGPTUsage(result.data));
        return;
      }

      const error = result && result.error ? result.error : 'EmptyResponse';

      // The token exchange was unusable. This is a READ failure: the saved
      // credential is untouched and the next attempt can succeed on its own.
      // Rate limiting is called out separately so a backoff is not mistaken
      // for an outage.
      if (error === 'SessionExchangeFailed') {
        const detail = (result && result.exchange) || 'unknown';
        const code = detail === 'RateLimited' ? 'SessionExchangeRateLimited' : 'SessionExchangeUnavailable';
        finish(new Error(`${code}: ${detail}`), null);
        return;
      }

      // 401 = the captured token went stale — retry once with a fresh one.
      if (error === 'HTTP401' && attempt < MAX_ATTEMPTS) {
        capturedToken = null;
        await reloadHome();
        return;
      }

      // NoAccessToken / HTTP401 = the account is not (or no longer) logged in
      // on this partition — the caller treats this as "session expired".
      if (error === 'NoAccessToken' || error === 'HTTP401') {
        finish(new Error('AuthRequired'), null);
        return;
      }

      finish(new Error(error), null);
    };

    // loadURL rejects when cancellation destroys the window mid-navigation.
    // Keep that rejection owned by this operation and never retry a settled
    // request or touch a destroyed BrowserWindow.
    const reloadHome = async () => {
      if (settled || win.isDestroyed()) return false;
      try {
        await win.loadURL(CHATGPT_HOME);
        return true;
      } catch (error) {
        if (!settled) finish(new Error('LoadFailed: ' + error.message), null);
        return false;
      }
    };

    win.webContents.on('did-fail-load', (event, code, desc, url, isMainFrame) => {
      if (!isMainFrame) return; // ignore sub-frame failures (trackers etc.)
      finish(new Error(`LoadFailed: ${code} ${desc}`), null);
    });

    win.webContents.on('did-finish-load', async () => {
      if (settled) return;
      // Give the SPA a moment to fire its backend-api requests (token capture).
      await new Promise((r) => setTimeout(r, 1500));
      if (settled) return;
      runInPage().catch((error) => {
        if (!settled) finish(new Error('PageError: ' + error.message), null);
      });
    });

    void reloadHome();
  });
}

/**
 * Validate a freshly captured ChatGPT session: run the same hidden-window
 * read once and report whether the account is logged in.
 * @returns {Promise<{success: boolean, tier?: string, error?: string}>}
 */
async function validateChatGPTToken({ partition, signal }) {
  try {
    const data = await fetchChatGPTUsageData({ partition, signal });
    return { success: true, tier: data.tier || 'unknown' };
  } catch (error) {
    // Exact messages first, then prefixes for the codes that carry a detail
    // after a colon. "Login not detected" is reserved for the cases that
    // actually prove it: an explicit rejection, or a token endpoint that
    // answered and said nobody is signed in.
    const friendly = {
      AuthRequired: 'Login not detected — please try again',
      NoAccessToken: 'Login not detected — please try again',
      HTTP401: 'Login not detected — please try again',
      CloudflareBlocked: 'ChatGPT blocked the request — please try again',
      'Request timeout': 'ChatGPT took too long to respond — please try again'
    };
    const prefixed = [
      ['SessionExchangeRateLimited', 'ChatGPT is rate-limiting sign-in checks — please wait a moment and try again'],
      ['SessionExchangeUnavailable', 'Could not reach ChatGPT to confirm the login — please try again'],
      ['CloudflareBlocked', 'ChatGPT blocked the request — please try again'],
      ['LoadFailed', 'Could not load ChatGPT — please check your connection and try again'],
      ['PageError', 'Could not read the ChatGPT page — please try again']
    ];
    if (friendly[error.message]) return { success: false, error: friendly[error.message] };
    for (const [code, message] of prefixed) {
      if (error.message.startsWith(code)) return { success: false, error: message };
    }
    return { success: false, error: error.message };
  }
}

// ── Manual entry ───────────────────────────────────────────────────────────

/**
 * Build usage data from a per-account manual entry ({ enabled, used, limit }).
 * A single percentage row — no reset window, no timestamps.
 *
 * `degraded: true` means this is a FALLBACK: an automatic read failed (or no
 * credential exists) and the manual entry is standing in for it. It is
 * reported as `fallback: true` so nothing downstream can present it as a
 * successful automatic reading. A manual entry with no usable limit yields an
 * unavailable row rather than a fake 0%.
 *
 * @param {Object} manual - { enabled, used, limit }
 * @param {Object} [options]
 * @param {string} [options.provider]
 * @param {boolean} [options.degraded] - true when standing in for a failed auto-read
 */
function manualUsageData(manual, { provider = 'chatgpt', degraded = false } = {}) {
  // readNumber, not Number(): Number(null) is 0, which would turn "the user
  // has not entered a value" into a confident 0%.
  const limit = readNumber(manual?.limit);
  const used = readNumber(manual?.used);
  const usableLimit = limit !== null && limit > 0;
  const usableUsed = used !== null;
  const utilization = usableLimit && usableUsed
    ? readPercent((used / limit) * 100)
    : null;

  return {
    provider,
    source: 'manual',
    fallback: !!degraded,
    rows: [
      {
        key: 'manual',
        label: 'Manual usage',
        shortLabel: 'Manual',
        windowMs: null,
        utilization,
        available: utilization !== null,
        resets_at: null,
        used: usableUsed ? used : null,
        limit: usableLimit ? limit : null
      }
    ],
    raw: null
  };
}

module.exports = {
  CHATGPT_HOME,
  CHATGPT_USAGE_PATH,
  normalizeClaudeUsage,
  normalizeChatGPTUsage,
  fetchChatGPTUsageData,
  validateChatGPTToken,
  manualUsageData,
  clampPct,
  windowShortLabel
};
