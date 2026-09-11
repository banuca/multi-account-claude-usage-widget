/**
 * manual-entry.js
 *
 * Validating a manual usage entry, and saying why it is wrong.
 *
 * The editor used to run `parseFloat(input.value) || 0` on both fields, which
 * quietly turned "abc", "-5" and an empty box into 0 and saved them. A limit
 * of 0 then made the reading unavailable with no explanation, and a negative
 * "used" was accepted and rendered. This module refuses invalid input and
 * hands back a sentence the editor can show, instead of coercing it.
 *
 * Deliberately unchanged: usage above the limit is allowed. Over-limit
 * tracking is a supported state (the row goes red at 100%), not an error.
 *
 * Loaded two ways, like usage-status.js:
 *   - main / tests: require('./manual-entry')
 *   - renderer:     <script src="../manual-entry.js"> → window.ManualEntry
 */
(function () {
  // `Number(' ')` is 0 and `Number('')` is 0, so the text is checked before
  // the number: a blank or non-numeric box is a missing value, not a zero.
  function parseField(raw) {
    if (raw === null || raw === undefined) return { ok: false, reason: 'missing' };
    const text = String(raw).trim();
    if (text === '') return { ok: false, reason: 'missing' };
    const value = Number(text);
    if (!Number.isFinite(value)) return { ok: false, reason: 'not-a-number' };
    return { ok: true, value };
  }

  /**
   * @param {Object} input  { used, limit, enabled } as typed (strings are fine)
   * @returns {{valid: boolean, manual?: Object, errors: Array<{field, code, message}>}}
   */
  function validateManualEntry({ used, limit, enabled } = {}) {
    const errors = [];

    const usedField = parseField(used);
    if (!usedField.ok) {
      errors.push({
        field: 'used',
        code: usedField.reason,
        message: usedField.reason === 'missing'
          ? 'Enter how much you have used (0 is fine).'
          : 'Used must be a number.'
      });
    } else if (usedField.value < 0) {
      errors.push({ field: 'used', code: 'negative', message: 'Used cannot be negative.' });
    }

    const limitField = parseField(limit);
    if (!limitField.ok) {
      errors.push({
        field: 'limit',
        code: limitField.reason,
        message: limitField.reason === 'missing'
          ? 'Enter the limit this usage counts against.'
          : 'Limit must be a number.'
      });
    } else if (limitField.value <= 0) {
      errors.push({ field: 'limit', code: 'not-positive', message: 'Limit must be greater than 0.' });
    }

    if (errors.length) return { valid: false, errors };

    return {
      valid: true,
      errors: [],
      manual: {
        enabled: !!enabled,
        used: usedField.value,
        limit: limitField.value
      }
    };
  }

  // One line for the editor: the first problem, or every problem joined.
  function describeManualErrors(errors) {
    if (!errors || !errors.length) return '';
    return errors.map((e) => e.message).join(' ');
  }

  const api = { parseField, validateManualEntry, describeManualErrors };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else if (typeof window !== 'undefined') {
    window.ManualEntry = api;
  }
}());
