const assert = require('assert');
const {
  THRESHOLDS,
  statusForPercent,
  computeWorstAccount,
  createLegacyAccountMigration
} = require('../src/account-logic');

function testStatusBands() {
  // Fixed bands: green < 80, orange 80–95, red >= 95
  assert.strictEqual(THRESHOLDS.WARN, 80);
  assert.strictEqual(THRESHOLDS.DANGER, 95);
  assert.strictEqual(statusForPercent(0), 'green');
  assert.strictEqual(statusForPercent(42), 'green');
  assert.strictEqual(statusForPercent(79.9), 'green');
  assert.strictEqual(statusForPercent(80), 'orange');
  assert.strictEqual(statusForPercent(90), 'orange');
  assert.strictEqual(statusForPercent(94.9), 'orange');
  assert.strictEqual(statusForPercent(95), 'red');
  assert.strictEqual(statusForPercent(100), 'red');
  assert.strictEqual(statusForPercent(140), 'red'); // over-limit clamps to red
}

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

function testComputeWorstAccountWithRows() {
  // Normalized (rows) payloads: worst account is the one with the highest
  // utilization across any row.
  const accounts = [{ id: '1' }, { id: '2' }];
  const usageByAccount = {
    1: { rows: [{ key: 'session', utilization: 30 }, { key: 'weekly', utilization: 55 }] },
    2: { rows: [{ key: 'session', utilization: 84 }, { key: 'weekly', utilization: 10 }] }
  };

  const worst = computeWorstAccount(accounts, usageByAccount);

  assert.strictEqual(worst.account.id, '2');
  assert.strictEqual(worst.sessionPct, 84);
  assert.strictEqual(worst.weeklyPct, 10);
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
    { id: '1', label: 'Personal', provider: 'claude', orgId: 'org-1', organizations: [] }
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

testStatusBands();
testComputeWorstAccount();
testComputeWorstAccountWithRows();
testComputeWorstAccountWithoutUsage();
testLegacyMigrationCreatesFirstAccount();
testLegacyMigrationClearsWithoutAccount();

console.log('account-logic tests passed');
