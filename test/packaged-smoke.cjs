// Launches the BUILT application twice against a synthetic profile.
//
//   node test/packaged-smoke.cjs --exe <path-to-built-executable> [--out <dir>]
//
// A successful build proves a package can be produced; it proves nothing about
// whether the packaged app starts, finds its own assets, wires up the preload,
// renders accounts or keeps data across a restart. This does that, on the real
// artifact, in two separate OS processes.
//
// It never touches an installed copy or a real profile. Two things matter here
// and one of them is easy to get wrong:
//
//   * On Windows, %APPDATA% does NOT redirect a packaged Electron app.
//     Electron resolves appData from the Windows known-folder API, so a launch
//     that only sets the environment variable reads the real user's profile.
//     Measured: a run with APPDATA pointed at a temporary directory still
//     reported configPath under C:\Users\<user>\AppData\Roaming. The
//     supported switch is --user-data-dir, which is what is used below, and
//     main.js derives its pre-store config path from app.getPath('userData'),
//     so that switch covers the legacy check too.
//   * On macOS and Linux, HOME and the XDG variables ARE honoured, and they
//     are set as well so the desktop/autostart integration stays isolated.
//
// The app's own opt-in SMOKE_SCREENSHOT hook makes it capture its renderer and
// exit on its own rather than needing a window to be driven; it writes to a
// log file because a packaged Windows binary has no console.
//
// Networking is CONTAINED, not merely unlikely. The app's smoke hook installs
// a request blocker on every Chromium session before the app is ready and
// replaces the update check - a plain Node https.request to api.github.com,
// which no session filter can see - with a local answer. Both are asserted
// below from what the hook reports, because "the account is manual-only so no
// read is attempted" said nothing about the update check the renderer fires
// two seconds after it loads.
//
// The launch also exercises the real IPC seam inside the package
// (SMOKE_LIFECYCLE=1): account creation, manual validation, a manual read and
// removal, all through the shipped preload in the shipped renderer. A DOM
// screenshot shows the window painted; it says nothing about whether the
// account handlers work inside an asar.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const optionOf = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};

// Resolved against the working directory: spawnSync on Windows rejects a
// relative program path with ENOENT, which is how a CI invocation that
// passed `dist/win-unpacked/...exe` produced 27 failures and an empty
// process rather than a launch.
const exeArg = optionOf('--exe');
const exe = exeArg ? path.resolve(exeArg) : exeArg;
// Resolved for the same reason --exe is. Every path handed to the packaged
// app is derived from this one, and the app runs with its own cwd - so a
// relative --out made SMOKE_LOG resolve against the CHILD's directory, the
// app wrote its report somewhere nobody read, and every check that needed
// that report failed against a process that had actually started fine.
const outDir = path.resolve(optionOf('--out') || path.join(os.tmpdir(), `usage-packaged-smoke-${process.pid}`));
if (!exe) {
  console.error('usage: node test/packaged-smoke.cjs --exe <path> [--out <dir>]');
  process.exit(64);
}
if (!fs.existsSync(exe)) {
  console.error(`[packaged] the built executable does not exist: ${exe}`);
  process.exit(66);
}
fs.mkdirSync(outDir, { recursive: true });

const pkg = require('../package.json');
const profileRoot = path.join(outDir, 'profile');
const configDir = path.join(profileRoot, 'claude-usage-widget');
const macConfigDir = path.join(profileRoot, 'Library', 'Application Support', 'claude-usage-widget');
const linuxConfigDir = path.join(profileRoot, '.config', 'claude-usage-widget');
for (const dir of [configDir, macConfigDir, linuxConfigDir]) fs.mkdirSync(dir, { recursive: true });

// electron-store resolves its own directory from the OS, so the profile is
// seeded in all three places and the launch reports which one it used.
const now = Date.now();
const seeded = {
  accounts: [{
    id: '1', label: 'Packaged Smoke', provider: 'claude', orgId: 'smoke-org',
    organizations: [], manual: { enabled: true, used: 45, limit: 90 }
  }],
  accountSeq: 1,
  usageHistory_acct_1: [{ timestamp: now - 3600000, session: 33, weekly: 44 }],
  settings: {
    showTrayStats: false, usageAlerts: false, alwaysOnTop: true,
    graphVisible: false, refreshInterval: 300, minimizeToTray: false
  },
  windowBounds: { x: 60, y: 60, width: 620, height: 420 }
};
const configFiles = [configDir, macConfigDir, linuxConfigDir].map((d) => path.join(d, 'config.json'));
for (const file of configFiles) fs.writeFileSync(file, JSON.stringify(seeded, null, 2));

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail: detail || null });
  console.log(`[packaged] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function launch(label) {
  const cwd = path.join(outDir, label);
  fs.mkdirSync(cwd, { recursive: true });
  const env = {
    ...process.env,
    HOME: profileRoot,
    USERPROFILE: profileRoot,
    APPDATA: profileRoot,
    LOCALAPPDATA: path.join(profileRoot, 'Local'),
    XDG_CONFIG_HOME: path.join(profileRoot, '.config'),
    XDG_DATA_HOME: path.join(profileRoot, '.local', 'share'),
    XDG_CACHE_HOME: path.join(profileRoot, '.cache'),
    // The app's own opt-in hook: capture the renderer after this many ms, log
    // a DOM summary and quit. A packaged Windows build has no console, so the
    // hook is also given a file to write to and a directory to capture into.
    // How long the app waits before capturing its renderer and quitting.
    // 12s was tight enough to flake on a loaded machine - the run finished
    // before the capture landed and reported "no screenshot written" for a
    // window that had rendered perfectly well. CI runners are slower than a
    // developer's desktop, and this still sits well inside the 90s launch
    // timeout below.
    SMOKE_SCREENSHOT: process.env.SMOKE_SCREENSHOT_MS || '20000',
    SMOKE_LOG: path.join(cwd, 'smoke.log'),
    SMOKE_OUT: cwd,
    // Drive the account/IPC lifecycle through the shipped preload as well.
    SMOKE_LIFECYCLE: '1'
  };
  delete env.ELECTRON_RUN_AS_NODE;

  // stdio is ignored on purpose. Electron's helper processes inherit the
  // parent's pipes, and at least one of them outlives the main process, so a
  // piped spawnSync waits for an EOF that never comes and reports ETIMEDOUT
  // for a run that actually succeeded. The app's own log file is the record.
  const run = spawnSync(exe, [`--user-data-dir=${configDir}`], {
    cwd,
    env,
    encoding: 'utf8',
    stdio: 'ignore',
    timeout: 90000,
    // SIGKILL, not the default SIGTERM. A windowed app can ignore SIGTERM, and
    // then spawnSync's timeout never fires and the run hangs until the CI job
    // is killed - which is exactly what both macOS jobs did. SIGKILL cannot be
    // ignored, so the timeout is real on every platform.
    killSignal: 'SIGKILL'
  });
  // The file the app wrote is the authoritative record; stdout is empty for a
  // GUI subsystem binary on Windows.
  const fileLog = fs.existsSync(path.join(cwd, 'smoke.log'))
    ? fs.readFileSync(path.join(cwd, 'smoke.log'), 'utf8')
    : '';
  const output = `${run.stdout || ''}${run.stderr || ''}${fileLog}`;
  fs.writeFileSync(path.join(outDir, `${label}.log`), output);
  return { run, output, cwd };
}

function parseIdentity(output) {
  const match = /\[Smoke\] identity: (\{.*\})/.exec(output);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch (err) {
    return null;
  }
}

// The hook logs several JSON blocks; each is pretty-printed, so the closing
// brace has to be matched rather than assumed to be on one line.
function parseBlock(output, marker) {
  const at = output.indexOf(marker);
  if (at === -1) return null;
  const rest = output.slice(at + marker.length);
  const start = rest.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < rest.length; i += 1) {
    if (rest[i] === '{') depth += 1;
    else if (rest[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(rest.slice(start, i + 1));
        } catch (err) {
          return null;
        }
      }
    }
  }
  return null;
}

function parseSummary(output) {
  const marker = '[Smoke] DOM summary:';
  const at = output.indexOf(marker);
  if (at === -1) return null;
  const rest = output.slice(at + marker.length);
  const start = rest.indexOf('{');
  if (start === -1) return null;
  // The summary is pretty-printed; find its matching closing brace.
  let depth = 0;
  for (let i = start; i < rest.length; i += 1) {
    if (rest[i] === '{') depth += 1;
    else if (rest[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(rest.slice(start, i + 1));
        } catch (err) {
          return null;
        }
      }
    }
  }
  return null;
}

function readUsedConfig(identity) {
  const file = identity && identity.configPath;
  if (!file || !fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return null;
  }
}

console.log(`[packaged] executable: ${exe}`);
console.log(`[packaged] synthetic profile: ${profileRoot}`);
console.log(`[packaged] package version: ${pkg.version}`);

// ── Launch 1 ──────────────────────────────────────────────────────────────
const first = launch('launch-1');
const identity1 = parseIdentity(first.output);
const summary1 = parseSummary(first.output);

record('the packaged application starts and exits cleanly',
  first.run.status === 0 && !first.run.error,
  `exit=${first.run.status}${first.run.signal ? ` signal=${first.run.signal}` : ''}`
    + ` ${first.run.error ? `error=${first.run.error.message}` : ''}`);

record('it reports its identity from inside the package',
  !!identity1,
  identity1 ? JSON.stringify(identity1) : `no identity line; first 400 chars: ${JSON.stringify(first.output.slice(0, 400))}`);

record('the version it reports is the APP version, not the Electron runtime',
  !!identity1 && identity1.appVersion === pkg.version && identity1.appVersion !== identity1.electron,
  identity1 ? `appVersion=${identity1.appVersion} electron=${identity1.electron} expected=${pkg.version}` : 'no identity line');

record('it used the synthetic profile it was pointed at, not a real one',
  !!identity1 && typeof identity1.configPath === 'string'
    && path.resolve(identity1.configPath).startsWith(path.resolve(profileRoot)),
  identity1 ? identity1.configPath : 'no identity line');

record('the saved configuration was usable (no recovery was needed)',
  !!identity1 && identity1.configHealth === 'ok',
  identity1 ? `configHealth=${identity1.configHealth}` : 'no identity line');

record('it is running as a packaged application',
  !!identity1 && identity1.packaged === true,
  identity1 ? `packaged=${identity1.packaged}` : 'no identity line');

record('the renderer painted the seeded account from the package\'s own assets',
  !!summary1 && summary1.accountCards === 1 && Array.isArray(summary1.pctTexts) && summary1.pctTexts.includes('50%'),
  summary1 ? JSON.stringify({ cards: summary1.accountCards, pct: summary1.pctTexts, tags: summary1.providerTags }) : 'no DOM summary');

record('the renderer stylesheet loaded (the usage bar has a real colour)',
  !!summary1 && Array.isArray(summary1.statusColors) && summary1.statusColors.length > 0
    && summary1.statusColors.every((c) => /^rgba?\(/.test(String(c))),
  summary1 ? JSON.stringify(summary1.statusColors) : 'no DOM summary');

const screenshot1 = path.join(first.cwd, 'smoke-screenshot.png');
record('it captured its own renderer, so the window really rendered',
  fs.existsSync(screenshot1) && fs.statSync(screenshot1).size > 5000,
  fs.existsSync(screenshot1) ? `${fs.statSync(screenshot1).size} bytes` : 'no screenshot written');

const afterFirst = readUsedConfig(identity1);
record('a manual reading was recorded to history during the first run',
  !!afterFirst && Array.isArray(afterFirst.usageHistory_acct_1)
    && afterFirst.usageHistory_acct_1.length > seeded.usageHistory_acct_1.length,
  afterFirst ? `history ${seeded.usageHistory_acct_1.length} -> ${(afterFirst.usageHistory_acct_1 || []).length}` : 'config unreadable');

const historyAfterFirst = (afterFirst && afterFirst.usageHistory_acct_1) || [];

// ── Launch 2: a genuinely separate OS process over the same profile ───────
const second = launch('launch-2');
const identity2 = parseIdentity(second.output);
const summary2 = parseSummary(second.output);
const afterSecond = readUsedConfig(identity2 || identity1);

record('the packaged application starts a second time on the same profile',
  second.run.status === 0 && !second.run.error,
  `exit=${second.run.status}${second.run.signal ? ` signal=${second.run.signal}` : ''}`
    + ` ${second.run.error ? `error=${second.run.error.message}` : ''}`);

record('the account survives a full process restart',
  !!summary2 && summary2.accountCards === 1 && Array.isArray(summary2.pctTexts) && summary2.pctTexts.includes('50%'),
  summary2 ? JSON.stringify({ cards: summary2.accountCards, pct: summary2.pctTexts }) : 'no DOM summary');

record('the history written by the first process is still there and was added to',
  !!afterSecond && Array.isArray(afterSecond.usageHistory_acct_1)
    && afterSecond.usageHistory_acct_1.length > historyAfterFirst.length
    && JSON.stringify(afterSecond.usageHistory_acct_1.slice(0, historyAfterFirst.length))
       === JSON.stringify(historyAfterFirst),
  afterSecond ? `history ${historyAfterFirst.length} -> ${(afterSecond.usageHistory_acct_1 || []).length}, prefix preserved` : 'config unreadable');

record('the manual settings survive the restart unchanged',
  !!afterSecond && afterSecond.accounts && afterSecond.accounts[0]
    && afterSecond.accounts[0].manual
    && afterSecond.accounts[0].manual.enabled === true
    && afterSecond.accounts[0].manual.used === 45
    && afterSecond.accounts[0].manual.limit === 90,
  afterSecond && afterSecond.accounts && afterSecond.accounts[0]
    ? JSON.stringify(afterSecond.accounts[0].manual) : 'no account');

record('no credential was created for a manual-only account',
  !!afterSecond && afterSecond.account_1_sessionKey === undefined
    && afterSecond.account_1_sessionKey_encrypted === undefined,
  afterSecond ? `keys: ${Object.keys(afterSecond).filter((k) => k.includes('sessionKey')).join(',') || 'none'}` : 'config unreadable');

// ── Networking: contained, and proven contained ───────────────────────────
const network1 = parseBlock(first.output, '[Smoke] network:');
record('the packaged run reports on its own network containment',
  !!network1,
  network1 ? JSON.stringify(network1) : 'no network report from the hook');

record('the update check was answered locally, so no Node https request left the process',
  !!network1 && network1.updateChecksAnsweredLocally >= 1,
  network1 ? `answered locally=${network1.updateChecksAnsweredLocally}` : 'no network report');

record('nothing reached a provider or GitHub through Chromium either',
  !!network1 && (network1.blockedHosts || []).every(
    (host) => !/claude\.ai|chatgpt\.com|openai\.com|github\.com/.test(host)),
  network1 ? `${network1.blockedRequests} request(s) intercepted, hosts=${(network1.blockedHosts || []).join(',') || 'none'}` : 'no network report');

// ── The real IPC seam, inside the package ─────────────────────────────────
const life = parseBlock(first.output, '[Smoke] lifecycle:');
record('the packaged app exposes its IPC surface through the shipped preload',
  !!life && Array.isArray(life.steps) && life.steps.length >= 10,
  life ? `steps=${(life.steps || []).length}` : 'no lifecycle block');

record('secure storage and configuration health are reported inside the package',
  !!life && !!life.secureStorage && typeof life.secureStorage.secure === 'boolean'
    && !!life.configHealth && life.configHealth.state === 'ok',
  life ? `secure=${life.secureStorage && life.secureStorage.secure} health=${life.configHealth && life.configHealth.state}` : 'no lifecycle block');

record('an account can be created through the packaged IPC surface',
  !!life && !!life.draft && !!life.created && life.created.ok === true
    && (life.accountsAfterCreate || []).length === 2,
  life ? `created=${JSON.stringify(life.created)} accounts=${(life.accountsAfterCreate || []).join(',')}` : 'no lifecycle block');

record('invalid manual numbers are refused with reasons, not coerced',
  !!life && life.invalidRefused && life.invalidRefused.ok === false
    && life.invalidRefused.reason === 'invalid-manual'
    && Array.isArray(life.invalidRefused.errors) && life.invalidRefused.errors.length >= 2,
  life ? JSON.stringify(life.invalidRefused) : 'no lifecycle block');

record('valid manual numbers are accepted',
  !!life && life.validAccepted && life.validAccepted.ok === true
    && life.validAccepted.manual && life.validAccepted.manual.used === 15,
  life ? JSON.stringify(life.validAccepted) : 'no lifecycle block');

record('a manual-only account reads without any provider call',
  !!life && life.manualRead && life.manualRead.status === 'available'
    && (life.manualRead.rows || []).includes(25),
  life ? JSON.stringify(life.manualRead) : 'no lifecycle block');

record('removal reports what it cleared AND that it reached the file',
  !!life && life.removal && life.removal.ok === true && life.removal.persisted === true
    && life.removal.cleared && life.removal.cleared.storage === true,
  life ? JSON.stringify(life.removal) : 'no lifecycle block');

record('the removed account is gone and the seeded one is untouched',
  !!life && (life.accountsAfterRemoval || []).length === 1
    && life.accountsAfterRemoval[0] === '1',
  life ? `accounts=${(life.accountsAfterRemoval || []).join(',')}` : 'no lifecycle block');

const rendererErrors = [first.output, second.output]
  .join('\n')
  .split('\n')
  .filter((line) => /\[Smoke\]\[renderer\]/.test(line) && /error|undefined is not|cannot read/i.test(line));
record('the packaged renderer logged no errors',
  rendererErrors.length === 0,
  rendererErrors.length ? rendererErrors.slice(0, 5).join(' | ') : 'no renderer error lines');

const manifest = {
  executable: exe,
  packageVersion: pkg.version,
  profile: profileRoot,
  launches: [
    {
      label: 'launch-1',
      exit: first.run.status,
      identity: identity1,
      summary: summary1 && { cards: summary1.accountCards, pct: summary1.pctTexts },
      network: network1,
      lifecycle: life
    },
    {
      label: 'launch-2',
      exit: second.run.status,
      identity: identity2,
      summary: summary2 && { cards: summary2.accountCards, pct: summary2.pctTexts },
      network: parseBlock(second.output, '[Smoke] network:')
    }
  ],
  results
};
fs.writeFileSync(path.join(outDir, 'packaged-smoke.json'), JSON.stringify(manifest, null, 2) + '\n');

const failed = results.filter((r) => !r.ok);
console.log(`\n[packaged] ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('[packaged] failing checks:');
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
}
process.exit(failed.length ? 1 : 0);
