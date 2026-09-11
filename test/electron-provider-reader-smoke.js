// Reader-level classification checks for the REAL ChatGPT usage reader.
//
// Run with: npm run test:electron:reader
//           (or: electron test/electron-provider-reader-smoke.js)
//
// Why this suite exists
// ---------------------
// The ordinary suites mock `fetchChatGPTUsageData` wholesale, so they can say
// nothing about how the reader itself classifies a failure — and that
// classification decides whether the user keeps their saved login. The reader
// mints a bearer token from /api/auth/session; every failure to obtain one used
// to be reported as `NoAccessToken`, which main.js maps to AuthRequired, which
// DELETES the credential. A gateway timeout or an HTML error page from that one
// endpoint was therefore enough to log the user out.
//
// So this suite runs the real reader — real BrowserWindow, real in-page fetch,
// real error mapping — against controlled page and network responses, and
// asserts which outcomes are allowed to reach the destructive path.
//
// How the responses are controlled
// --------------------------------
// Each case gets its own partition and installs an https handler on that
// partition's session (session.protocol.handle). Nothing leaves the machine:
// chatgpt.com resolves to whatever the case says it does. A separate assertion
// proves the interception is actually in force, so a silent fall-through to the
// real network could not be mistaken for a pass.
//
// No credential, cookie or token value is ever printed.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate every storage path before Electron touches one.
const isolatedRoot = path.join(os.tmpdir(), `usage-reader-smoke-${process.pid}`);
fs.mkdirSync(isolatedRoot, { recursive: true });
process.env.APPDATA = isolatedRoot;

const { app, session } = require('electron');
const configDir = path.join(isolatedRoot, 'claude-usage-widget');
fs.mkdirSync(configDir, { recursive: true });
app.setPath('userData', configDir);
app.setPath('appData', isolatedRoot);
app.setPath('home', isolatedRoot);

const { fetchChatGPTUsageData, validateChatGPTToken } = require('../src/providers');
const { isTransientReadError, isConfirmedAuthRejection } = require('../src/read-errors');

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail: detail || null });
  console.log(`[reader] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const PAGE_HTML = '<!doctype html><title>ChatGPT</title><body><div id="root">signed in</div></body>';
const CLOUDFLARE_HTML = '<!doctype html><title>Just a moment...</title><body>Just a moment...</body>';

const USAGE_PAYLOAD = {
  plan_type: 'plus',
  rate_limit: {
    primary_window: { used_percent: 41, limit_window_seconds: 18000, reset_at: Math.floor(Date.now() / 1000) + 3600 },
    secondary_window: { used_percent: 12, limit_window_seconds: 604800, reset_at: Math.floor(Date.now() / 1000) + 86400 }
  }
};

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' }
});
const html = (body, status = 200) => new Response(body, {
  status, headers: { 'content-type': 'text/html' }
});

/**
 * Install a controlled https origin on its own partition.
 *
 * @param {string} partition
 * @param {Object} routes  { session: () => Response|throw, usage: () => Response|throw }
 * @returns {{hits: string[], ses: Object}}
 */
function installOrigin(partition, routes) {
  const ses = session.fromPartition(partition);
  const hits = [];
  ses.protocol.handle('https', (request) => {
    const url = new URL(request.url);
    hits.push(url.pathname);
    if (url.pathname === '/api/auth/session') return routes.session();
    if (url.pathname === '/backend-api/wham/usage') return routes.usage();
    if (url.pathname === '/') return routes.home ? routes.home() : html(PAGE_HTML);
    return new Response('', { status: 404 });
  });
  return { hits, ses };
}

// Run one case and report what the reader did, without letting a rejection
// escape into an unhandled promise.
async function readOnce(partition, routes) {
  const origin = installOrigin(partition, routes);
  const started = Date.now();
  try {
    const data = await fetchChatGPTUsageData({ partition, timeoutMs: 20000 });
    return { ok: true, data, hits: origin.hits, ms: Date.now() - started };
  } catch (error) {
    return { ok: false, error, message: error.message, hits: origin.hits, ms: Date.now() - started };
  }
}

app.whenReady().then(async () => {
  try {
    console.log('[reader] runtime', JSON.stringify({
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node
    }));

    // ── 0. The interception is real ──────────────────────────────────────
    {
      const probe = await readOnce('persist:reader-control', {
        session: () => json({ accessToken: 'controlled-token' }),
        usage: () => json(USAGE_PAYLOAD)
      });
      record('the controlled https origin serves the reader (no real network involved)',
        probe.ok === true && probe.hits.includes('/') && probe.hits.includes('/backend-api/wham/usage'),
        `paths=${JSON.stringify(probe.hits)} ${probe.ok ? '' : `error=${probe.message}`}`);
      record('a successful read parses both windows into the shared rows shape',
        probe.ok === true
          && probe.data.provider === 'chatgpt'
          && probe.data.tier === 'plus'
          && probe.data.rows.length === 2
          && probe.data.rows[0].utilization === 41
          && probe.data.rows[1].utilization === 12,
        probe.ok ? `rows=${JSON.stringify(probe.data.rows.map((r) => [r.key, r.utilization]))}` : probe.message);
    }

    // ── 1-4. Failures to OBTAIN a token are not proof about the credential ─
    //
    // Each of these four is a different way for the token exchange to fail
    // without saying anything at all about whether the saved login is valid.
    const transientExchangeCases = [
      {
        id: 'gateway-error',
        title: 'the token endpoint returns a 502 HTML error page',
        routes: { session: () => html('<html><body>502 Bad Gateway</body></html>', 502), usage: () => json(USAGE_PAYLOAD) }
      },
      {
        id: 'html-body',
        title: 'the token endpoint returns 200 with an HTML body',
        routes: { session: () => html('<html><body>maintenance</body></html>'), usage: () => json(USAGE_PAYLOAD) }
      },
      {
        id: 'malformed-json',
        title: 'the token endpoint returns 200 with malformed JSON',
        routes: {
          session: () => new Response('{"accessToken":', { status: 200, headers: { 'content-type': 'application/json' } }),
          usage: () => json(USAGE_PAYLOAD)
        }
      },
      {
        id: 'network-failure',
        title: 'the token request fails at the network layer',
        routes: {
          session: () => { throw new Error('simulated network failure'); },
          usage: () => json(USAGE_PAYLOAD)
        }
      },
      {
        id: 'rate-limited',
        title: 'the token endpoint rate-limits the exchange (429)',
        routes: { session: () => json({ detail: 'too many requests' }, 429), usage: () => json(USAGE_PAYLOAD) }
      }
    ];

    for (const testCase of transientExchangeCases) {
      const outcome = await readOnce(`persist:reader-${testCase.id}`, testCase.routes);
      const rejectedCredential = !outcome.ok && isConfirmedAuthRejection('chatgpt', outcome.error);
      record(`${testCase.title}: the saved credential is NOT reported as rejected`,
        outcome.ok === false && rejectedCredential === false,
        `error=${outcome.ok ? '(read unexpectedly succeeded)' : outcome.message}`);
      record(`${testCase.title}: the failure is classified as a transient read failure`,
        outcome.ok === false && isTransientReadError(outcome.error) === true,
        `error=${outcome.ok ? '(read unexpectedly succeeded)' : outcome.message}`);
    }

    // ── 5. A valid JSON reply with no token IS proof nobody is signed in ──
    {
      const outcome = await readOnce('persist:reader-empty-session', {
        session: () => json({}),
        usage: () => json(USAGE_PAYLOAD)
      });
      record('a valid, empty token response is still reported as a confirmed auth rejection',
        outcome.ok === false && isConfirmedAuthRejection('chatgpt', outcome.error) === true,
        `error=${outcome.ok ? '(read unexpectedly succeeded)' : outcome.message}`);
    }

    // ── 6. An outright 401 from the token endpoint is proof too ──────────
    {
      const outcome = await readOnce('persist:reader-401-session', {
        session: () => json({ detail: 'unauthorized' }, 401),
        usage: () => json(USAGE_PAYLOAD)
      });
      record('a 401 from the token endpoint is reported as a confirmed auth rejection',
        outcome.ok === false && isConfirmedAuthRejection('chatgpt', outcome.error) === true,
        `error=${outcome.ok ? '(read unexpectedly succeeded)' : outcome.message}`);
    }

    // ── 7. 401 from the usage endpoint: retried once, then confirmed ─────
    {
      let usageCalls = 0;
      const outcome = await readOnce('persist:reader-usage-401', {
        session: () => json({ accessToken: 'controlled-token' }),
        usage: () => { usageCalls += 1; return json({ detail: 'unauthorized' }, 401); }
      });
      record('a 401 from the usage endpoint is retried once and then reported as a confirmed rejection',
        outcome.ok === false && isConfirmedAuthRejection('chatgpt', outcome.error) === true && usageCalls === 2,
        `usageCalls=${usageCalls} error=${outcome.ok ? '(read unexpectedly succeeded)' : outcome.message}`);
    }

    // ── 8. A 5xx from the usage endpoint is the provider failing ─────────
    {
      const outcome = await readOnce('persist:reader-usage-503', {
        session: () => json({ accessToken: 'controlled-token' }),
        usage: () => json({ detail: 'unavailable' }, 503)
      });
      record('a 503 from the usage endpoint is transient and not an auth rejection',
        outcome.ok === false
          && isConfirmedAuthRejection('chatgpt', outcome.error) === false
          && isTransientReadError(outcome.error) === true,
        `error=${outcome.ok ? '(read unexpectedly succeeded)' : outcome.message}`);
    }

    // ── 9. A Cloudflare interstitial is transient ────────────────────────
    {
      const outcome = await readOnce('persist:reader-cloudflare', {
        home: () => html(CLOUDFLARE_HTML),
        session: () => json({ accessToken: 'controlled-token' }),
        usage: () => json(USAGE_PAYLOAD)
      });
      record('a Cloudflare interstitial is transient and not an auth rejection',
        outcome.ok === false
          && outcome.message.startsWith('CloudflareBlocked')
          && isConfirmedAuthRejection('chatgpt', outcome.error) === false
          && isTransientReadError(outcome.error) === true,
        `error=${outcome.ok ? '(read unexpectedly succeeded)' : outcome.message}`);
    }

    // ── 10. validateChatGPTToken keeps its distinct wording ─────────────
    //
    // Validation runs during login, where "we could not reach the token
    // endpoint" and "you are not signed in" need different advice.
    {
      const partition = 'persist:reader-validate-transient';
      installOrigin(partition, {
        session: () => html('<html><body>502</body></html>', 502),
        usage: () => json(USAGE_PAYLOAD)
      });
      const transient = await validateChatGPTToken({ partition });
      record('login validation reports a token-exchange outage as a retryable problem, not a failed login',
        transient.success === false
          && /could not|try again|temporar/i.test(String(transient.error))
          && !/not detected/i.test(String(transient.error)),
        `error=${JSON.stringify(transient.error)}`);

      const signedOutPartition = 'persist:reader-validate-signedout';
      installOrigin(signedOutPartition, {
        session: () => json({}),
        usage: () => json(USAGE_PAYLOAD)
      });
      const signedOut = await validateChatGPTToken({ partition: signedOutPartition });
      record('login validation still says "login not detected" when the token endpoint says nobody is signed in',
        signedOut.success === false && /not detected/i.test(String(signedOut.error)),
        `error=${JSON.stringify(signedOut.error)}`);
    }

    // ── 11. Cancellation still wins over a slow page ─────────────────────
    {
      const partition = 'persist:reader-cancel';
      installOrigin(partition, {
        session: () => new Promise((resolve) => setTimeout(() => resolve(json({})), 10000)),
        usage: () => json(USAGE_PAYLOAD)
      });
      const controller = new AbortController();
      const pending = fetchChatGPTUsageData({ partition, timeoutMs: 20000, signal: controller.signal })
        .then(() => ({ settled: 'resolved' }), (err) => ({ settled: 'rejected', message: err.message }));
      setTimeout(() => controller.abort(), 500);
      const outcome = await pending;
      record('an aborted read settles as AuthFlowCancelled rather than hanging or being mistaken for a rejection',
        outcome.settled === 'rejected'
          && outcome.message === 'AuthFlowCancelled'
          && isConfirmedAuthRejection('chatgpt', new Error(outcome.message)) === false,
        JSON.stringify(outcome));
    }

    const failed = results.filter((r) => !r.ok);
    console.log(`\n[reader] ${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length) {
      console.log('[reader] failing checks:');
      for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
    }
    app.exit(failed.length ? 1 : 0);
  } catch (err) {
    console.error('[reader] fatal:', (err && err.stack) || err);
    app.exit(2);
  }
});

process.on('unhandledRejection', (reason) => {
  console.error('[reader] unhandled rejection:', reason);
  app.exit(3);
});
