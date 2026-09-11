'use strict';

// Behavioural regressions for what a usage reading MEANS (Phase 2).
//
// These drive the real shared helper (src/usage-status.js), the real provider
// normalizers (src/providers.js) and the real worst-account selection
// (src/account-logic.js). No BrowserWindow is constructed and no URL is
// contacted — the normalizers are pure functions over a payload.
//
// The defect being locked out: every missing, null, empty or malformed
// percentage used to be coerced to 0 (`clampPct(undefined)` → 0,
// `row.utilization || 0` → 0), so a dead session, a partial response and a
// genuine 0% were indistinguishable, all painted green.

const assert = require('assert');
const {
  READ_STATUS,
  ROW_SLOTS,
  readPercent,
  isRowAvailable,
  availableRows,
  maxAvailableUtilization,
  hasAnyReading,
  selectRow
} = require('../src/usage-status');
const {
  normalizeClaudeUsage,
  normalizeChatGPTUsage,
  manualUsageData
} = require('../src/providers');
const { computeWorstAccount, maxRowUtilization, rowReading } = require('../src/account-logic');

const failures = [];
function scenario(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`FAIL  ${name}`);
    console.log(`      ${error.message.split('\n').join('\n      ')}`);
  }
}

function rowByKey(rows, key) {
  return rows.find((row) => row.key === key);
}

// ── readPercent ──────────────────────────────────────────────────────────────

scenario('a genuine numeric zero is a reading', () => {
  assert.strictEqual(readPercent(0), 0);
  assert.strictEqual(readPercent('0'), 0);
  assert.strictEqual(readPercent(0.4), 0);
  assert.strictEqual(readPercent(-5), 0, 'negatives clamp to 0 but stay readings');
});

scenario('missing, null, empty and malformed values are not readings', () => {
  for (const value of [
    undefined, null, '', '   ', 'abc', 'NaN', '45%', NaN, Infinity, -Infinity,
    true, false, {}, [], [42], () => 42
  ]) {
    assert.strictEqual(readPercent(value), null,
      `readPercent(${JSON.stringify(value) || String(value)}) must be null, not 0`);
  }
});

scenario('real numbers round and clamp into 0-100', () => {
  assert.strictEqual(readPercent(45.4), 45);
  assert.strictEqual(readPercent(45.6), 46);
  assert.strictEqual(readPercent('88'), 88);
  assert.strictEqual(readPercent(140), 100);
});

scenario('row availability and max never invent a zero', () => {
  assert.strictEqual(isRowAvailable({ utilization: 0 }), true);
  assert.strictEqual(isRowAvailable({ utilization: null }), false);
  assert.strictEqual(isRowAvailable({ utilization: 50, available: false }), false);
  assert.strictEqual(isRowAvailable(undefined), false);
  assert.strictEqual(maxAvailableUtilization([]), null);
  assert.strictEqual(maxAvailableUtilization([{ utilization: null }]), null);
  assert.strictEqual(maxAvailableUtilization([{ utilization: 0 }]), 0);
  assert.strictEqual(maxAvailableUtilization([{ utilization: null }, { utilization: 12 }]), 12);
  assert.strictEqual(hasAnyReading([{ utilization: null }]), false);
  assert.strictEqual(availableRows([{ utilization: 3 }, { utilization: null }]).length, 1);
});

// ── Claude normalizer ────────────────────────────────────────────────────────

scenario('Claude: a true 0% is reported as an available 0', () => {
  const data = normalizeClaudeUsage({
    five_hour: { utilization: 0, resets_at: '2026-09-09T18:00:00Z' },
    seven_day: { utilization: 0, resets_at: '2026-09-15T18:00:00Z' }
  });
  const session = rowByKey(data.rows, 'session');
  assert.strictEqual(session.utilization, 0);
  assert.strictEqual(session.available, true);
  assert.strictEqual(hasAnyReading(data.rows), true);
});

scenario('Claude: null / missing / malformed utilization is unavailable, not 0%', () => {
  const cases = [
    { utilization: null },
    { utilization: undefined },
    { utilization: '' },
    { utilization: 'unknown' },
    { resets_at: '2026-09-09T18:00:00Z' } // section present, percentage absent
  ];
  for (const five of cases) {
    const data = normalizeClaudeUsage({ five_hour: five });
    const session = rowByKey(data.rows, 'session');
    assert.ok(session, 'the row is kept so the card can say it is unavailable');
    assert.strictEqual(session.utilization, null, JSON.stringify(five));
    assert.strictEqual(session.available, false, JSON.stringify(five));
    assert.strictEqual(hasAnyReading(data.rows), false);
  }
});

scenario('Claude: an empty or null payload yields no reading and does not throw', () => {
  for (const raw of [{}, null, undefined, 'not json', 42]) {
    const data = normalizeClaudeUsage(raw);
    assert.deepStrictEqual(data.rows, []);
    assert.strictEqual(hasAnyReading(data.rows), false);
  }
});

scenario('Claude: a partial response keeps the valid row and flags the other', () => {
  const data = normalizeClaudeUsage({
    five_hour: { utilization: 62, resets_at: '2026-09-09T18:00:00Z' },
    seven_day: { utilization: null, resets_at: '2026-09-15T18:00:00Z' }
  });
  assert.strictEqual(rowByKey(data.rows, 'session').utilization, 62);
  assert.strictEqual(rowByKey(data.rows, 'session').available, true);
  assert.strictEqual(rowByKey(data.rows, 'weekly').utilization, null);
  assert.strictEqual(rowByKey(data.rows, 'weekly').available, false);
  assert.strictEqual(maxAvailableUtilization(data.rows), 62);
});

// ── ChatGPT normalizer ───────────────────────────────────────────────────────

function chatgptPayload(primary, secondary, extra = {}) {
  return {
    plan_type: 'plus',
    rate_limit: { primary_window: primary, secondary_window: secondary },
    ...extra
  };
}

scenario('ChatGPT: a true 0% is reported as an available 0', () => {
  const data = normalizeChatGPTUsage(chatgptPayload(
    { used_percent: 0, limit_window_seconds: 18000, reset_at: 1789000000 },
    { used_percent: 0, limit_window_seconds: 604800, reset_at: 1789600000 }
  ));
  assert.strictEqual(rowByKey(data.rows, 'session').utilization, 0);
  assert.strictEqual(rowByKey(data.rows, 'session').available, true);
  assert.strictEqual(data.tier, 'plus');
});

scenario('ChatGPT: null / missing / malformed used_percent is unavailable, not 0%', () => {
  for (const primary of [
    { used_percent: null, limit_window_seconds: 18000 },
    { used_percent: '', limit_window_seconds: 18000 },
    { used_percent: 'high', limit_window_seconds: 18000 },
    { limit_window_seconds: 18000 }
  ]) {
    const data = normalizeChatGPTUsage(chatgptPayload(primary, undefined));
    const session = rowByKey(data.rows, 'session');
    assert.strictEqual(session.utilization, null, JSON.stringify(primary));
    assert.strictEqual(session.available, false, JSON.stringify(primary));
  }
});

scenario('ChatGPT: an empty response yields no reading', () => {
  for (const raw of [{}, null, { rate_limit: {} }]) {
    const data = normalizeChatGPTUsage(raw);
    assert.strictEqual(hasAnyReading(data.rows), false);
  }
});

scenario('ChatGPT: a partial response keeps the readable window', () => {
  const data = normalizeChatGPTUsage(chatgptPayload(
    { used_percent: 71, limit_window_seconds: 18000, reset_at: 1789000000 },
    { used_percent: null, limit_window_seconds: 604800 }
  ));
  assert.strictEqual(rowByKey(data.rows, 'session').utilization, 71);
  assert.strictEqual(rowByKey(data.rows, 'weekly').available, false);
  assert.strictEqual(maxAvailableUtilization(data.rows), 71);
});

scenario('ChatGPT: spend control stands in only when it is itself readable', () => {
  const withSpend = normalizeChatGPTUsage({
    plan_type: 'business',
    spend_control: { individual_limit: { used_percent: 34, reset_at: 1789000000 } }
  });
  assert.strictEqual(withSpend.rows.length, 1);
  assert.strictEqual(withSpend.rows[0].utilization, 34);

  const unreadableSpend = normalizeChatGPTUsage({
    plan_type: 'business',
    spend_control: { individual_limit: { used_percent: null } }
  });
  assert.strictEqual(hasAnyReading(unreadableSpend.rows), false,
    'an unreadable spend bucket must not become a 0% row');

  // Windows present but unreadable, spend readable → the spend reading is used.
  const rescued = normalizeChatGPTUsage(chatgptPayload(
    { used_percent: null, limit_window_seconds: 18000 },
    undefined,
    { spend_control: { individual_limit: { used_percent: 12 } } }
  ));
  assert.strictEqual(maxAvailableUtilization(rescued.rows), 12);
});

// ── Manual entry and fallback labelling ──────────────────────────────────────

scenario('a manual override is labelled manual and is not a fallback', () => {
  const data = manualUsageData({ enabled: true, used: 25, limit: 100 }, { provider: 'claude' });
  assert.strictEqual(data.source, 'manual');
  assert.strictEqual(data.fallback, false);
  assert.strictEqual(data.rows[0].utilization, 25);
  assert.strictEqual(data.rows[0].available, true);
});

scenario('a manual entry standing in for a failed read is marked as a fallback', () => {
  const data = manualUsageData({ used: 25, limit: 100 }, { provider: 'chatgpt', degraded: true });
  assert.strictEqual(data.source, 'manual');
  assert.strictEqual(data.fallback, true,
    'degraded must be reported so a fallback cannot look like a successful auto-read');
});

scenario('a manual entry with no usable limit is unavailable, not 0%', () => {
  for (const manual of [
    { used: 5, limit: 0 },
    { used: 5, limit: null },
    { used: 5, limit: 'many' },
    { used: null, limit: 100 },
    {}
  ]) {
    const data = manualUsageData(manual, { provider: 'claude' });
    assert.strictEqual(data.rows[0].utilization, null, JSON.stringify(manual));
    assert.strictEqual(data.rows[0].available, false, JSON.stringify(manual));
  }
});

// ── Worst-account selection (tray badge + card badge) ────────────────────────

scenario('an account with no reading never wins worst-account selection', () => {
  const accounts = [{ id: '1', label: 'Unknown' }, { id: '2', label: 'Real' }];
  const usage = {
    1: { rows: [{ key: 'session', utilization: null, available: false }] },
    2: { rows: [{ key: 'session', utilization: 3, available: true }] }
  };
  const worst = computeWorstAccount(accounts, usage);
  assert.strictEqual(worst.account.id, '2',
    'a null reading must not beat a real 3% by being treated as 0');
  assert.strictEqual(worst.sessionPct, 3);
});

scenario('every account unknown means no worst account at all', () => {
  const worst = computeWorstAccount(
    [{ id: '1' }, { id: '2' }],
    {
      1: { rows: [{ key: 'session', utilization: null, available: false }] },
      2: { rows: [], status: READ_STATUS.UNAVAILABLE }
    }
  );
  assert.strictEqual(worst, null, 'nothing readable ⇒ null, so the tray shows a dash');
});

scenario('a true 0% account is a valid worst-account candidate', () => {
  const worst = computeWorstAccount(
    [{ id: '1' }],
    { 1: { rows: [{ key: 'session', utilization: 0, available: true }] } }
  );
  assert.ok(worst, 'a real 0% reading is still a reading');
  assert.strictEqual(worst.maxPct, 0);
});

scenario('a stale winner is reported as stale', () => {
  const worst = computeWorstAccount(
    [{ id: '1', label: 'Old' }],
    {
      1: {
        status: READ_STATUS.STALE,
        stale: true,
        rows: [{ key: 'session', utilization: 91, available: true }]
      }
    }
  );
  assert.strictEqual(worst.stale, true,
    'the tray header must be able to say the number is not current');
});

scenario('unreadable rows do not contribute to an account maximum', () => {
  assert.strictEqual(maxRowUtilization({ rows: [{ utilization: null }] }), null);
  assert.strictEqual(maxRowUtilization(null), null);
  assert.strictEqual(maxRowUtilization({ five_hour: { utilization: 'x' } }), null);
  assert.strictEqual(maxRowUtilization({ five_hour: { utilization: 5 } }), 5);
  assert.strictEqual(rowReading({ rows: [{ utilization: null }] }, ROW_SLOTS.SESSION, null), null);
  assert.strictEqual(rowReading({ five_hour: { utilization: 0 } }, ROW_SLOTS.SESSION, { utilization: 0 }), 0);
});

// ── Slot mapping: which row is the session and which is the weekly ──────────
//
// The defect being locked out: session/weekly were read as rows[0]/rows[1], so
// a response carrying ONLY a weekly window reported that weekly figure as a
// session reading and left weekly empty. The reading a provider sends must
// land in the slot its own key names, whatever order the rows arrive in.

scenario('a weekly-only Claude response fills the weekly slot, not the session slot', () => {
  const data = normalizeClaudeUsage({ seven_day: { utilization: 73, resets_at: '2026-09-16T18:00:00Z' } });
  assert.strictEqual(data.rows.length, 1, 'one row: the weekly window is all the provider sent');
  assert.strictEqual(data.rows[0].key, 'weekly');
  assert.strictEqual(rowReading(data, ROW_SLOTS.SESSION, null), null,
    'no session window was reported, so the session slot must stay empty');
  assert.strictEqual(rowReading(data, ROW_SLOTS.WEEKLY, null), 73);
});

scenario('a weekly-only ChatGPT response fills the weekly slot, not the session slot', () => {
  const data = normalizeChatGPTUsage({
    rate_limit: { secondary_window: { used_percent: 73, limit_window_seconds: 604800, reset_at: 1789581600 } }
  });
  assert.strictEqual(data.rows.length, 1);
  assert.strictEqual(data.rows[0].key, 'weekly');
  assert.strictEqual(rowReading(data, ROW_SLOTS.SESSION, null), null);
  assert.strictEqual(rowReading(data, ROW_SLOTS.WEEKLY, null), 73);
});

scenario('a weekly-only reading drives the tray badges by slot, not by position', () => {
  const data = normalizeClaudeUsage({ seven_day: { utilization: 73, resets_at: '2026-09-16T18:00:00Z' } });
  const worst = computeWorstAccount([{ id: '1', label: 'Weekly only' }], { 1: data });
  assert.strictEqual(worst.sessionPct, null,
    'the session badge must show its neutral dash, not the weekly number');
  assert.strictEqual(worst.weeklyPct, 73);
  assert.strictEqual(worst.maxPct, 73);
});

scenario('a session-only response leaves the weekly slot empty', () => {
  const data = normalizeClaudeUsage({ five_hour: { utilization: 18, resets_at: '2026-09-09T18:00:00Z' } });
  const worst = computeWorstAccount([{ id: '1' }], { 1: data });
  assert.strictEqual(worst.sessionPct, 18);
  assert.strictEqual(worst.weeklyPct, null);
});

scenario('reversed row order does not swap the two readings', () => {
  const data = {
    rows: [
      { key: 'weekly', utilization: 73, available: true },
      { key: 'session', utilization: 12, available: true }
    ]
  };
  assert.strictEqual(rowReading(data, ROW_SLOTS.SESSION, null), 12);
  assert.strictEqual(rowReading(data, ROW_SLOTS.WEEKLY, null), 73);
  const worst = computeWorstAccount([{ id: '1' }], { 1: data });
  assert.strictEqual(worst.sessionPct, 12);
  assert.strictEqual(worst.weeklyPct, 73);
});

scenario('a manual entry keeps the session slot and claims no weekly reading', () => {
  const data = manualUsageData({ enabled: true, used: 30, limit: 100 }, { provider: 'claude' });
  assert.strictEqual(data.rows[0].key, 'manual');
  assert.strictEqual(rowReading(data, ROW_SLOTS.SESSION, null), 30,
    'a manual entry has always been reported in the session slot');
  assert.strictEqual(rowReading(data, ROW_SLOTS.WEEKLY, null), null,
    'a manual entry says nothing about a weekly window');
  const worst = computeWorstAccount([{ id: '1' }], { 1: data });
  assert.strictEqual(worst.sessionPct, 30);
  assert.strictEqual(worst.weeklyPct, null);
});

scenario('a manual fallback for a failed read keeps the session slot too', () => {
  const data = manualUsageData({ enabled: false, used: 9, limit: 100 }, { provider: 'claude', degraded: true });
  assert.strictEqual(data.fallback, true);
  assert.strictEqual(rowReading(data, ROW_SLOTS.SESSION, null), 9);
  assert.strictEqual(rowReading(data, ROW_SLOTS.WEEKLY, null), null);
});

scenario('a spend-control-only response keeps the session slot it is emitted with', () => {
  const data = normalizeChatGPTUsage({
    plan_type: 'business',
    spend_control: { individual_limit: { used_percent: 55, reset_at: 1789581600 } }
  });
  assert.strictEqual(data.rows.length, 1);
  assert.strictEqual(data.rows[0].key, 'session', 'spend control is emitted as the session row');
  assert.strictEqual(rowReading(data, ROW_SLOTS.SESSION, null), 55);
  assert.strictEqual(rowReading(data, ROW_SLOTS.WEEKLY, null), null);
});

scenario('an unreadable weekly row is a gap, not the session value moved across', () => {
  const data = normalizeClaudeUsage({
    five_hour: { utilization: 40, resets_at: '2026-09-09T18:00:00Z' },
    seven_day: { utilization: null, resets_at: '2026-09-15T18:00:00Z' }
  });
  assert.strictEqual(rowReading(data, ROW_SLOTS.SESSION, null), 40);
  assert.strictEqual(rowReading(data, ROW_SLOTS.WEEKLY, null), null);
});

scenario('rows with no key at all keep the previous positional order', () => {
  // Defensive: an older payload shape that never carried keys must still
  // resolve, or an upgrade would blank a card that used to work.
  const rows = [{ utilization: 5, available: true }, { utilization: 6, available: true }];
  assert.strictEqual(selectRow(rows, ROW_SLOTS.SESSION).utilization, 5);
  assert.strictEqual(selectRow(rows, ROW_SLOTS.WEEKLY).utilization, 6);
  assert.strictEqual(selectRow([], ROW_SLOTS.SESSION), null);
  assert.strictEqual(selectRow(null, ROW_SLOTS.WEEKLY), null);
});

// ── Result ───────────────────────────────────────────────────────────────────

if (failures.length) {
  console.log(`\n${failures.length} usage-reading scenario(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\nusage-reading tests passed');
}
