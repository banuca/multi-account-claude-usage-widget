/**
 * config-recovery.js
 *
 * Deciding what to do with a configuration file that cannot be used, and a
 * usable stand-in store when it cannot be used at all.
 *
 * The rule this module exists to enforce: **the app never deletes the user's
 * configuration because it could not read it.** Before this, main.js treated
 * any file that did not start with `{` (or any read error at all) as a v1.7.0
 * encrypted leftover and unlinked it. A half-written file, a file locked by a
 * backup agent, a permissions problem or an unfamiliar-but-valid format all
 * took the same path, and the user's accounts, history and settings were gone
 * with no copy left anywhere.
 *
 * The replacement:
 *   - unusable content  → copy the exact original bytes aside, VERIFY the copy,
 *                         and only then write a fresh empty config so the app
 *                         can boot. The original is still on disk under a
 *                         `config.unreadable-<timestamp>.json` name.
 *   - unreadable file   → touch nothing. The app boots on a memory store and
 *                         says so; nothing is written over the file.
 *   - copy failed       → touch nothing. Same degraded, honest boot.
 *
 * No fs and no electron in here on purpose: every decision is a pure function
 * of what the caller observed, so the whole matrix is unit-testable and the
 * caller owns the (few) real file operations.
 */
'use strict';

// Health states, in increasing severity. The renderer shows a banner for
// anything other than `ok`, and says which one it is — a preserved config and
// a read-only session are very different problems for the user.
const CONFIG_HEALTH = {
  OK: 'ok',
  PRESERVED: 'preserved',       // old file kept aside, running on a fresh config
  READ_ONLY: 'read-only',       // config could not be read/opened; nothing written
  // Read fine, unusable, a VERIFIED copy was taken, and the replacement write
  // then failed. Distinct from READ_ONLY because the user has a recoverable
  // copy and a path to point at, and distinct from WRITE_FAILED because the
  // app never got as far as a usable config file at all.
  RESET_FAILED: 'reset-failed',
  WRITE_FAILED: 'write-failed'  // reads fine, but a write was rejected
};

const RECOVERY_ACTIONS = {
  NONE: 'none',
  PRESERVE_AND_RESET: 'preserve-and-reset',
  LEAVE_IN_PLACE: 'leave-in-place'
};

/**
 * What kind of content is this?
 *
 * `json-object` is the only shape electron-store can use. A JSON array or a
 * bare scalar parses but is not a config object, so it is classified as
 * unusable — and therefore preserved, not deleted.
 */
function classifyConfigContent(raw) {
  if (typeof raw !== 'string') return { kind: 'unusable', reason: 'not-text' };
  if (raw.length === 0) return { kind: 'empty', reason: 'empty-file' };
  // NUL bytes never appear in JSON text; they are the signature of the v1.7.0
  // encrypted file and of binary rubbish generally. Checked by code point so
  // this source file holds no control characters of its own.
  if (raw.indexOf('\u0000') !== -1) return { kind: 'unusable', reason: 'binary-or-encrypted' };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { kind: 'unusable', reason: 'invalid-json' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'unusable', reason: 'not-a-json-object' };
  }
  return { kind: 'json-object', reason: 'valid' };
}

/**
 * Decide what the caller should do on disk.
 *
 * @param {Object} observation
 * @param {boolean} observation.exists   does the config file exist
 * @param {string}  [observation.raw]    its contents, when they could be read
 * @param {Object}  [observation.readError] the error, when they could not
 * @returns {{action: string, health: string, reason: string}}
 */
function planConfigRecovery({ exists, raw, readError } = {}) {
  if (!exists) {
    return { action: RECOVERY_ACTIONS.NONE, health: CONFIG_HEALTH.OK, reason: 'no-config-file' };
  }
  if (readError) {
    // Cannot read it ⇒ cannot know what it holds ⇒ must not touch it. An
    // empty config would be written straight over a file that may hold every
    // account the user has.
    return {
      action: RECOVERY_ACTIONS.LEAVE_IN_PLACE,
      health: CONFIG_HEALTH.READ_ONLY,
      reason: `read-failed:${readError.code || readError.message || 'unknown'}`
    };
  }
  const content = classifyConfigContent(raw);
  if (content.kind === 'json-object') {
    return { action: RECOVERY_ACTIONS.NONE, health: CONFIG_HEALTH.OK, reason: 'valid-json' };
  }
  if (content.kind === 'empty') {
    // A zero-byte file is what an interrupted write leaves behind. There is
    // nothing in it to preserve, and electron-store cannot parse it, so it is
    // safe to replace — this is the one case where no copy is needed.
    return { action: RECOVERY_ACTIONS.PRESERVE_AND_RESET, health: CONFIG_HEALTH.OK, reason: 'empty-file' };
  }
  return {
    action: RECOVERY_ACTIONS.PRESERVE_AND_RESET,
    health: CONFIG_HEALTH.PRESERVED,
    reason: content.reason
  };
}

// Name for the preserved copy. Sortable, unique per second, and obviously not
// a config the app will try to load.
function recoveryFileName(now = new Date()) {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  return `config.unreadable-${stamp}.json`;
}

// ── Dot-path helpers (electron-store/conf semantics) ───────────────────────

function getPath(target, key) {
  const parts = String(key).split('.');
  let node = target;
  for (const part of parts) {
    if (node === null || typeof node !== 'object' || !(part in node)) return undefined;
    node = node[part];
  }
  return node;
}

function setPath(target, key, value) {
  const parts = String(key).split('.');
  let node = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (node[part] === null || typeof node[part] !== 'object') node[part] = {};
    node = node[part];
  }
  node[parts[parts.length - 1]] = value;
}

function deletePath(target, key) {
  const parts = String(key).split('.');
  let node = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (node[part] === null || typeof node[part] !== 'object') return;
    node = node[part];
  }
  delete node[parts[parts.length - 1]];
}

/**
 * The durable-store contract.
 *
 * Two very different guarantees run through this file, and conflating them is
 * what let a memory overlay be mistaken for a disk write:
 *
 *   - *availability*: the app should keep working when the config file cannot
 *     be written. Ordinary settings may therefore degrade into an explicitly
 *     temporary in-memory overlay.
 *   - *durability*: a credential must never be reported as saved unless it
 *     really reached the file, and a previously committed credential must
 *     never be removed before its replacement is durably verified.
 *
 * So every store exposes an optional `durable` facet: the same operations,
 * straight through to the real backing store, which THROW on failure and
 * never consult the overlay. A store with `persistent === false` (the memory
 * stand-in) has no durable facet at all - `durable` is null, and callers that
 * need durability must refuse rather than degrade.
 *
 * A bare electron-store instance satisfies the durable contract on its own:
 * its writes throw. Consumers therefore treat "no `durable` property and
 * `persistent !== false`" as "the store is itself durable".
 */

/**
 * A store that behaves like electron-store but keeps everything in memory.
 *
 * Used when the real config cannot be opened. The app stays fully usable for
 * the session — accounts already in memory keep reading, manual entry works,
 * the window works — and the renderer says plainly that nothing is being
 * saved. The alternative (crash, or loop, or "helpfully" recreate the file)
 * either blocks the user or destroys the file we are trying to protect.
 */
function createMemoryStore(initial = {}) {
  const data = JSON.parse(JSON.stringify(initial));
  return {
    persistent: false,
    // Nothing here reaches a disk, so there is no durable facet to offer.
    // Credential persistence checks this and refuses instead of pretending.
    durable: null,
    get(key, fallback) {
      const value = getPath(data, key);
      return value === undefined ? fallback : value;
    },
    set(key, value) {
      if (key !== null && typeof key === 'object') {
        for (const [k, v] of Object.entries(key)) setPath(data, k, v);
        return;
      }
      setPath(data, key, value);
    },
    has(key) {
      return getPath(data, key) !== undefined;
    },
    delete(key) {
      deletePath(data, key);
    },
    clear() {
      for (const key of Object.keys(data)) delete data[key];
    },
    get store() {
      return data;
    }
  };
}

/**
 * Wrap a real store so a rejected write degrades instead of throwing.
 *
 * A read-only config directory (roaming profile trouble, a locked file, a
 * full disk) used to surface as an unhandled exception from whichever handler
 * happened to write first. Now the value is kept in a memory overlay for the
 * session, the health state records it once, and the app carries on. Reads
 * check the overlay first so what the user just changed is what they see.
 */
function createResilientStore(realStore, onWriteError) {
  // Per-key overlay. `values` holds what a failed write wanted to store;
  // `tombstones` holds keys whose failed DELETE must still look deleted for
  // the rest of the session. Both are keyed by the exact key the caller used,
  // dot-paths included.
  //
  // Why per-key and not one "degraded" flag: with a global flag, a single
  // failed write made every later read of every key prefer the overlay, so a
  // key that was written successfully afterwards kept returning the stale
  // overlay value. An entry now exists for exactly the keys whose durable
  // state is not what the caller asked for, and any later successful durable
  // operation on a key CLEARS its entry, so disk wins again the moment disk
  // is right.
  const values = createMemoryStore({});
  const tombstones = new Set();
  let degraded = false;

  const report = (operation, key, err) => {
    degraded = true;
    if (onWriteError) onWriteError({ operation, key: String(key), error: err });
  };

  // A tombstone on `settings` must also hide `settings.alwaysOnTop`.
  const tombstoned = (key) => {
    const text = String(key);
    if (tombstones.has(text)) return true;
    for (const dead of tombstones) {
      if (text.startsWith(dead + '.')) return true;
    }
    return false;
  };

  // Any durable success for `key` makes the overlay's opinion of it obsolete.
  const settle = (key) => {
    const text = String(key);
    values.delete(text);
    tombstones.delete(text);
    for (const dead of [...tombstones]) {
      if (dead.startsWith(text + '.')) tombstones.delete(dead);
    }
  };

  const settleAll = (key) => {
    if (key !== null && typeof key === 'object') {
      for (const k of Object.keys(key)) settle(k);
      return;
    }
    settle(key);
  };

  const applyToOverlay = (key, value) => {
    if (key !== null && typeof key === 'object') {
      for (const [k, v] of Object.entries(key)) {
        values.set(k, v);
        tombstones.delete(k);
      }
      return;
    }
    values.set(key, value);
    tombstones.delete(String(key));
  };

  // The durable facet: the real store, unwrapped, failures included.
  const durable = {
    get(key, fallback) {
      const value = realStore.get(key, fallback);
      return value === undefined ? fallback : value;
    },
    has(key) {
      return realStore.has(key);
    },
    set(key, value) {
      realStore.set(key, value);
      // Verifying the round trip is the caller's job (it knows what "the same
      // value" means for its data), but the overlay must stop shadowing a key
      // the disk now holds correctly.
      settleAll(key);
    },
    delete(key) {
      realStore.delete(key);
      settle(key);
    }
  };

  return {
    persistent: true,
    durable,
    get isDegraded() {
      return degraded;
    },
    get(key, fallback) {
      if (tombstoned(key)) return fallback;
      if (values.has(key)) return values.get(key, fallback);
      try {
        return realStore.get(key, fallback);
      } catch (err) {
        report('get', key, err);
        return fallback;
      }
    },
    set(key, value) {
      try {
        realStore.set(key, value);
        settleAll(key);
      } catch (err) {
        applyToOverlay(key, value);
        report('set', key, err);
      }
    },
    has(key) {
      if (tombstoned(key)) return false;
      if (values.has(key)) return true;
      try {
        return realStore.has(key);
      } catch (err) {
        report('has', key, err);
        return false;
      }
    },
    delete(key) {
      try {
        realStore.delete(key);
        settle(key);
      } catch (err) {
        // The value is still on disk and will be back next launch. Hide it for
        // this session so the app behaves as the user asked, and report the
        // failure so the caller can say the removal did not stick.
        tombstones.add(String(key));
        values.delete(String(key));
        report('delete', key, err);
      }
    },
    get store() {
      let base;
      try {
        base = realStore.store;
      } catch (err) {
        report('store', '*', err);
        base = {};
      }
      const merged = createMemoryStore(base && typeof base === 'object' ? base : {});
      for (const dead of tombstones) merged.delete(dead);
      const overlay = values.store;
      for (const key of Object.keys(overlay)) merged.set(key, overlay[key]);
      return merged.store;
    }
  };
}

/**
 * The durable facet of a store, or null when it has none.
 *
 * Exported so main.js and the tests describe durability the same way the
 * credential store does (which resolves it locally, to stay dependency-free).
 */
function durableFacetOf(store) {
  if (!store) return null;
  if (Object.prototype.hasOwnProperty.call(store, 'durable')) return store.durable || null;
  if (store.persistent === false) return null;
  return store;
}

module.exports = {
  CONFIG_HEALTH,
  RECOVERY_ACTIONS,
  classifyConfigContent,
  planConfigRecovery,
  recoveryFileName,
  createMemoryStore,
  createResilientStore,
  durableFacetOf
};
