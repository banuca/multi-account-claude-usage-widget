function computeWorstAccount(accounts, usageByAccount) {
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
