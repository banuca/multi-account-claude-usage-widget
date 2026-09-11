/**
 * usage-status.js
 *
 * One shared meaning for "what does this usage reading actually say?", used by
 * the providers, the main process (history, tray rollup, worst-account
 * selection) and the renderer (cards, footer, alerts).
 *
 * The rule that matters: a genuine 0% IS a reading, and anything that is not a
 * finite number in 0-100 is NOT a reading at all. Coercing a missing
 * percentage to 0 (`row.utilization || 0`) is what made a dead session, a
 * malformed payload and a failed refresh all look like a healthy green 0%.
 *
 * Loaded two ways on purpose, so main and renderer cannot drift apart:
 *   - main / providers / tests:  require('./usage-status')
 *   - renderer:                  <script src="../usage-status.js"> in
 *                                index.html, reachable as window.UsageStatus
 */

// Wrapped in an IIFE on purpose. In the renderer this file is a classic
// <script>, which shares one global lexical scope with app.js — top-level
// `const READ_STATUS` here would collide with app.js destructuring the same
// name and kill the whole renderer with a redeclaration SyntaxError.
(function () {

  // Read status for one account's most recent attempt.
  const READ_STATUS = Object.freeze({
    LOADING: 'loading',          // no attempt has completed yet
    AVAILABLE: 'available',      // successful read with at least one usable row
    UNAVAILABLE: 'unavailable',  // nothing usable, and no earlier reading to show
    STALE: 'stale'               // this attempt failed; the values shown are an earlier success
  });

  const PERCENT_MIN = 0;
  const PERCENT_MAX = 100;

  // The two reading slots the tray badges, the history samples and the card
  // rows are organised by. They are SLOTS, not positions: which row fills a
  // slot is decided by the row's own key.
  const ROW_SLOTS = Object.freeze({
    SESSION: 'session',
    WEEKLY: 'weekly'
  });

  /**
   * Parse a provider-supplied percentage into a reading.
   *
   * Rejects null, undefined, '', whitespace, booleans, objects/arrays, NaN,
   * ±Infinity and non-numeric strings. Accepts numbers and numeric strings,
   * rounded and clamped to 0-100 — so a true 0 survives as 0.
   *
   * @param {*} value
   * @returns {number|null} 0-100, or null when the value is not a reading.
   */
  function readPercent(value) {
    if (value === null || value === undefined) return null;
    // Number(true) === 1 and Number([]) === 0 — neither is a usage reading.
    if (typeof value === 'boolean') return null;
    if (typeof value === 'object') return null;
    if (typeof value === 'string' && value.trim() === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.min(Math.max(Math.round(n), PERCENT_MIN), PERCENT_MAX);
  }

  /**
   * Parse a plain number the same strictly as readPercent, without the 0-100
   * clamp. Used for manual `used` / `limit` entries, where null or '' means the
   * user has not entered a value — not that the value is zero.
   *
   * @returns {number|null}
   */
  function readNumber(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'boolean') return null;
    if (typeof value === 'object') return null;
    if (typeof value === 'string' && value.trim() === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Does this row carry a real reading? A row built by usageRow() states it
   * outright; a legacy row is judged by its utilization.
   */
  function isRowAvailable(row) {
    if (!row) return false;
    if (row.available === false) return false;
    return typeof row.utilization === 'number' && Number.isFinite(row.utilization);
  }

  /** Only the rows that carry a reading. */
  function availableRows(rows) {
    return (Array.isArray(rows) ? rows : []).filter(isRowAvailable);
  }

  /**
   * Highest reading across a row set.
   * @returns {number|null} null when no row carries a reading — never 0.
   */
  function maxAvailableUtilization(rows) {
    const usable = availableRows(rows);
    if (!usable.length) return null;
    return usable.reduce((max, row) => Math.max(max, row.utilization), usable[0].utilization);
  }

  /** True when at least one row carries a reading. */
  function hasAnyReading(rows) {
    return availableRows(rows).length > 0;
  }

  /**
   * Which row belongs in a reading slot ('session' or 'weekly').
   *
   * Matched on the row's own `key`, never on its position in the array. A
   * response that carries only a weekly window therefore fills the weekly
   * slot and leaves the session slot empty, in whatever order the rows arrive
   * — taking `rows[0]` reported that 73% weekly figure as a 73% session.
   *
   * Two deliberate exceptions:
   *   - a manual entry (`key: 'manual'`, whether the user's own override or a
   *     fallback for a failed read) is one reading with no window, and has
   *     always been reported in the session slot;
   *   - rows carrying no key at all (an older payload shape) keep the previous
   *     positional order, so nothing that used to resolve stops resolving.
   *
   * @param {Array} rows
   * @param {'session'|'weekly'} slot
   * @returns {Object|null} the row for that slot, or null when there is none.
   */
  function selectRow(rows, slot) {
    const list = Array.isArray(rows) ? rows : [];
    const keyed = list.filter((row) => row && typeof row.key === 'string' && row.key !== '');

    if (keyed.length) {
      const match = keyed.find((row) => row.key === slot);
      if (match) return match;
      if (slot === ROW_SLOTS.SESSION) {
        return keyed.find((row) => row.key === 'manual') || null;
      }
      return null;
    }

    return list[slot === ROW_SLOTS.SESSION ? 0 : 1] || null;
  }

  /**
   * Build a usage row, marking it unavailable when its percentage is not a
   * reading. Keeps the row (and its label / reset window) so a partial response
   * still shows which reading is missing rather than dropping it silently.
   *
   * @param {Object} base - key, label, shortLabel, windowMs, resets_at
   * @param {*} rawPercent - provider value, run through readPercent
   */
  function usageRow(base, rawPercent) {
    const utilization = readPercent(rawPercent);
    return { ...base, utilization, available: utilization !== null };
  }

  const api = {
    READ_STATUS,
    ROW_SLOTS,
    PERCENT_MIN,
    PERCENT_MAX,
    readPercent,
    readNumber,
    isRowAvailable,
    availableRows,
    maxAvailableUtilization,
    hasAnyReading,
    selectRow,
    usageRow
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else if (typeof window !== 'undefined') {
    window.UsageStatus = api;
  }
}());
