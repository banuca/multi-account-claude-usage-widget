const assert = require('assert');
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
