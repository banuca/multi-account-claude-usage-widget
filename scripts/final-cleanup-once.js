const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const branch = 'claude/multi-account-usage-widget-yjwmeb';

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function run(command, args, options = {}) {
  console.log(`> ${command} ${args.join(' ')}`);
  execFileSync(command, args, { stdio: 'inherit', ...options });
}

function walkJs(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJs(full, out);
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

write('src/account-logic.js', `function computeWorstAccount(accounts, usageByAccount) {
  let worst = null;
  let worstVal = -1;

  for (const account of accounts) {
    const data = usageByAccount[account.id];
    if (!data) continue;

    const sessionPct = data.five_hour?.utilization || 0;
    const weeklyPct = data.seven_day?.utilization || 0;
    const maxPct = Math.max(sessionPct, weeklyPct);

    if (maxPct > worstVal) {
      worstVal = maxPct;
      worst = { account, data, sessionPct, weeklyPct };
    }
  }

  return worst;
}

function createLegacyAccountMigration({ legacyKey, legacyOrg, id, label = 'Personal' }) {
  if (!legacyKey || !legacyOrg) {
    return {
      accounts: [],
      sessionKeyByAccount: null,
      clearLegacyKeys: true
    };
  }

  return {
    accounts: [{ id, label, orgId: legacyOrg, organizations: [] }],
    sessionKeyByAccount: { id, sessionKey: legacyKey },
    clearLegacyKeys: true
  };
}

module.exports = {
  computeWorstAccount,
  createLegacyAccountMigration
};
`);

write('test/account-logic.test.js', `const assert = require('assert');
const {
  computeWorstAccount,
  createLegacyAccountMigration
} = require('../src/account-logic');

function testComputeWorstAccount() {
  const accounts = [
    { id: '1', label: 'Personal' },
    { id: '2', label: 'Work' },
    { id: '3', label: 'Side' }
  ];
  const usageByAccount = {
    1: { five_hour: { utilization: 72 }, seven_day: { utilization: 40 } },
    2: { five_hour: { utilization: 41 }, seven_day: { utilization: 88 } },
    3: { five_hour: { utilization: 65 }, seven_day: { utilization: 66 } }
  };

  const worst = computeWorstAccount(accounts, usageByAccount);

  assert.strictEqual(worst.account.id, '2');
  assert.strictEqual(worst.sessionPct, 41);
  assert.strictEqual(worst.weeklyPct, 88);
}

function testComputeWorstAccountWithoutUsage() {
  assert.strictEqual(computeWorstAccount([{ id: '1' }], {}), null);
}

function testLegacyMigrationCreatesFirstAccount() {
  const migration = createLegacyAccountMigration({
    legacyKey: 'session-key',
    legacyOrg: 'org-1',
    id: '1'
  });

  assert.deepStrictEqual(migration.accounts, [
    { id: '1', label: 'Personal', orgId: 'org-1', organizations: [] }
  ]);
  assert.deepStrictEqual(migration.sessionKeyByAccount, {
    id: '1',
    sessionKey: 'session-key'
  });
  assert.strictEqual(migration.clearLegacyKeys, true);
}

function testLegacyMigrationClearsWithoutAccount() {
  const migration = createLegacyAccountMigration({
    legacyKey: null,
    legacyOrg: 'org-1',
    id: '1'
  });

  assert.deepStrictEqual(migration.accounts, []);
  assert.strictEqual(migration.sessionKeyByAccount, null);
  assert.strictEqual(migration.clearLegacyKeys, true);
}

testComputeWorstAccount();
testComputeWorstAccountWithoutUsage();
testLegacyMigrationCreatesFirstAccount();
testLegacyMigrationClearsWithoutAccount();

console.log('account-logic tests passed');
`);

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.description = 'Desktop widget for monitoring Claude.ai usage across multiple accounts';
if (pkg.scripts) delete pkg.scripts['build:mac'];
if (pkg.devDependencies) delete pkg.devDependencies['@electron/notarize'];
if (pkg.build) {
  delete pkg.build.mac;
  delete pkg.build.dmg;
}
fs.writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`);

let main = fs.readFileSync('main.js', 'utf8');
if (!main.includes("./src/account-logic")) {
  main = main.replace(
    "const { fetchViaWindow, fetchMultipleViaWindow } = require('./src/fetch-via-window');\n",
    "const { fetchViaWindow, fetchMultipleViaWindow } = require('./src/fetch-via-window');\nconst { computeWorstAccount, createLegacyAccountMigration } = require('./src/account-logic');\n"
  );
}
main = main.replace("const GITHUB_OWNER = 'SlavomirDurej';", "const GITHUB_OWNER = 'banuca';");
main = main.replace("const GITHUB_REPO = 'claude-usage-widget';", "const GITHUB_REPO = 'multi-account-claude-usage-widget';");
main = main.replace(/  if \(legacyKey && legacyOrg\) \{[\s\S]*?  store\.delete\('organizationId'\);\n/, `  const migration = createLegacyAccountMigration({
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
`);
main = main.replace(/\n\/\/ Pick the account closest to a limit[\s\S]*?\n\}\n\n\/\/ One short tooltip line per account/, '\n// One short tooltip line per account');
main = main.replace('const worst = computeWorstAccount();', 'const worst = computeWorstAccount(getAccounts(), latestUsageByAccount);');
fs.writeFileSync('main.js', main);

let readme = fs.readFileSync('README.md', 'utf8');
readme = readme.replace('A beautiful, standalone desktop widget for **Windows, macOS, and Linux**', 'A beautiful, standalone desktop widget for **Windows and Linux**');
if (!readme.includes('Fork notice:')) {
  readme = readme.replace(
    '![Claude Usage Widget - Main](assets/screenshot-main.png)',
    '> **Fork notice:** This fork is maintained at `banuca/multi-account-claude-usage-widget` and adds multi-account monitoring for Claude personal and work accounts. The original MIT licence and copyright notice are retained.\n\n![Claude Usage Widget - Main](assets/screenshot-main.png)'
  );
}
readme = readme.replace('Auto-start with Windows or macOS login', 'Auto-start with Windows login');
readme = readme.replace(/\n\*\*macOS:\*\*[\s\S]*?> Then try launching the app again\.\n/, '\n');
readme = readme.replace('git clone https://github.com/SlavomirDurej/claude-usage-widget.git', 'git clone https://github.com/banuca/multi-account-claude-usage-widget.git');
readme = readme.replace('cd claude-usage-widget', 'cd multi-account-claude-usage-widget');
readme = readme.replace('2. Click "Login to Claude" when prompted', '2. Click "Add account" when prompted');
readme = readme.replace('Right-click the tray icon for: Show/Hide, Refresh, Re-login, Settings, Exit.', 'Right-click the tray icon for: Show/Hide, Refresh, account details, Settings, and Exit.');
readme = readme.replace('**"Login Required" keeps appearing** — Session may have expired. Click "Login to Claude" to re-authenticate.', '**"Session expired" keeps appearing** — That account session may have expired. Click "Reconnect" on the account card to re-authenticate.');
readme = readme.replace('- [x] macOS support\n', '');
fs.writeFileSync('README.md', readme);

fs.rmSync(__filename, { force: true });

for (const file of walkJs('.').sort()) {
  run('node', ['--check', file]);
}
run('node', ['test/account-logic.test.js']);

run('git', ['status', '--short']);
run('git', ['config', 'user.name', 'Codex']);
run('git', ['config', 'user.email', 'codex@users.noreply.github.com']);
run('git', ['add', 'package.json', 'main.js', 'README.md', 'src/account-logic.js', 'test/account-logic.test.js', 'scripts/final-cleanup-once.js']);
try {
  run('git', ['commit', '-m', 'Finalize fork build configuration and verification']);
} catch (error) {
  console.log('No commit was created. This usually means there were no changes left to commit.');
}
run('git', ['push', 'origin', branch]);

console.log('\nDone. Final cleanup applied, checked, committed, and pushed.');
