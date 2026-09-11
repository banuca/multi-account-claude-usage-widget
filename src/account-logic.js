const {
  readPercent,
  isRowAvailable,
  maxAvailableUtilization,
  selectRow,
  ROW_SLOTS
} = require('./usage-status');

// Fixed usage status thresholds — the green/orange/red bands are constant
// across the whole app (renderer, tray, alerts, badges):
//   green   0% – 79.9%
//   orange 80% – 94.9%  (the "next 20%")
//   red    95% – 100%   (the "last 5%")
const THRESHOLDS = Object.freeze({
  WARN: 80,   // green → orange
  DANGER: 95  // orange → red
});

// Map a utilization percentage (0-100) to its status band.
function statusForPercent(percent) {
  if (percent >= THRESHOLDS.DANGER) return 'red';
  if (percent >= THRESHOLDS.WARN) return 'orange';
  return 'green';
}

// Highest reading across an account's rows (session / weekly / manual).
// Returns null when no row carries a reading — a missing reading is NOT 0%.
function maxRowUtilization(data) {
  if (!data) return null;
  if (Array.isArray(data.rows)) return maxAvailableUtilization(data.rows);
  // Legacy payload shape: { five_hour, seven_day }
  const legacy = [
    readPercent(data.five_hour?.utilization),
    readPercent(data.seven_day?.utilization)
  ].filter((pct) => pct !== null);
  return legacy.length ? Math.max(...legacy) : null;
}

// One slot's reading, or null when no row fills that slot. The row is chosen
// by its semantic key (see selectRow) — never by position, so a response that
// carries only a weekly window reports weekly and leaves session null.
// Normalized payloads carry rows; legacy payloads carry the two fixed sections.
function rowReading(data, slot, legacySection) {
  const rows = Array.isArray(data.rows) ? data.rows : [];
  if (rows.length) {
    const row = selectRow(rows, slot);
    return isRowAvailable(row) ? row.utilization : null;
  }
  return readPercent(legacySection?.utilization);
}

// Worst = the account with the highest reading. An account with no usable
// reading is skipped entirely, so an unknown or failed account can never win
// the tray badge by looking like a healthy 0%. `stale` says whether the
// winner's numbers came from an earlier success rather than this cycle.
function computeWorstAccount(accounts, usageByAccount) {
  let worst = null;
  let worstVal = -1;

  for (const account of accounts) {
    const data = usageByAccount[account.id];
    if (!data) continue;

    const maxPct = maxRowUtilization(data);
    if (maxPct === null) continue;

    if (maxPct > worstVal) {
      worstVal = maxPct;
      worst = {
        account,
        data,
        sessionPct: rowReading(data, ROW_SLOTS.SESSION, data.five_hour),
        weeklyPct: rowReading(data, ROW_SLOTS.WEEKLY, data.seven_day),
        maxPct,
        stale: !!data.stale || data.status === 'stale'
      };
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
    accounts: [{ id, label, provider: 'claude', orgId: legacyOrg, organizations: [] }],
    sessionKeyByAccount: { id, sessionKey: legacyKey },
    clearLegacyKeys: true
  };
}

module.exports = {
  THRESHOLDS,
  statusForPercent,
  maxRowUtilization,
  rowReading,
  computeWorstAccount,
  createLegacyAccountMigration
};
