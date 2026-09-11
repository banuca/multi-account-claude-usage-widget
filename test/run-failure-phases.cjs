// Runs every phase of the failure-path suite, one Electron process each.
//
// Run with: npm run test:electron:failures
//           (or: node test/run-failure-phases.cjs [phase ...] [--out <dir>])
//
// Each phase needs its own process because main.js decides what to do with the
// configuration file and the keychain once, at require time. This driver
// launches them in sequence, prints each phase's own PASS/FAIL lines as they
// arrive, and exits non-zero if any phase does — including a phase that dies
// without reporting, which is a failure rather than a skip.
//
// Nothing is retried. A phase's log is written to --out (when given) exactly as
// it happened, pass or fail.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ALL_PHASES = [
  'isolation', 'corrupt-config', 'unreadable-config', 'write-denied',
  'keychain-unavailable', 'removal-race', 'save-race', 'manual-first-run',
  // The credential lifecycle at the real IPC seam, a migration across a real
  // restart (two processes, one profile - see SHARED_PROFILE below), and the
  // rendered removal confirmation controls.
  'chatgpt-reconnect', 'legacy-locked', 'legacy-locked-restart', 'removal-confirm-ui',
  // Correction review 2026-09-11: cookie-write ordering around removal at the
  // real session/IPC seam, the polling writer that belongs to no login flow,
  // and the rendered result of a partially failed removal.
  'cookie-drain', 'poll-cookie-drain', 'removal-partial-failure'
];

// Phases that must run on ONE profile directory, in this order. A restart is
// only a restart if the first process has exited: Windows will not let a second
// Electron process open a profile whose caches the first still holds.
const SHARED_PROFILE = {
  'legacy-locked': 'legacy-migration',
  'legacy-locked-restart': 'legacy-migration'
};

const args = process.argv.slice(2);
let outDir = null;
const requested = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--out') {
    outDir = args[i + 1];
    i += 1;
  } else {
    requested.push(args[i]);
  }
}
const phases = requested.length ? requested : ALL_PHASES;
for (const phase of phases) {
  if (!ALL_PHASES.includes(phase)) {
    console.error(`[failure-paths] unknown phase "${phase}" (known: ${ALL_PHASES.join(', ')})`);
    process.exit(64);
  }
}
if (outDir) fs.mkdirSync(outDir, { recursive: true });

// require('electron') outside an Electron process resolves to the binary path.
const electronBinary = require('electron');
const suite = path.join(__dirname, 'electron-failure-paths-smoke.js');

const summary = [];
for (const phase of phases) {
  console.log(`\n=== ${phase} ===`);
  // ELECTRON_RUN_AS_NODE would start the binary as plain Node, with no app and
  // no BrowserWindow. It is set in some shells, so it is DELETED here - setting
  // the key to undefined would pass the string "undefined", which Electron
  // treats as set.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  if (SHARED_PROFILE[phase]) {
    env.FAILURE_ROOT = path.join(
      os.tmpdir(), `usage-failure-${SHARED_PROFILE[phase]}-${process.pid}`);
    fs.mkdirSync(env.FAILURE_ROOT, { recursive: true });
    console.log(`[failure-paths] ${phase} uses the shared profile ${env.FAILURE_ROOT}`);
  }

  const run = spawnSync(electronBinary, [suite, phase], {
    encoding: 'utf8',
    env,
    timeout: 180000,
    maxBuffer: 32 * 1024 * 1024
  });
  const output = `${run.stdout || ''}${run.stderr || ''}`;
  process.stdout.write(output);
  if (outDir) fs.writeFileSync(path.join(outDir, `failure-${phase}.log`), output);

  const match = /(\d+)\/(\d+) checks passed/.exec(output);
  summary.push({
    phase,
    exit: run.status,
    passed: match ? Number(match[1]) : null,
    total: match ? Number(match[2]) : null,
    reported: !!match
  });
}

console.log('\n=== failure-path summary ===');
let ok = true;
for (const row of summary) {
  const verdict = row.exit === 0 && row.reported ? 'PASS' : 'FAIL';
  if (verdict === 'FAIL') ok = false;
  console.log(`${verdict}  ${row.phase.padEnd(22)} ${row.reported ? `${row.passed}/${row.total}` : 'no checks reported'}  exit=${row.exit}`);
}
const totals = summary.reduce((acc, r) => ({
  passed: acc.passed + (r.passed || 0),
  total: acc.total + (r.total || 0)
}), { passed: 0, total: 0 });
console.log(`${totals.passed}/${totals.total} checks passed across ${summary.length} phase(s)`);
if (outDir) {
  fs.writeFileSync(path.join(outDir, 'failure-phases-summary.json'), JSON.stringify({ summary, totals }, null, 2) + '\n');
}
process.exit(ok ? 0 : 1);
