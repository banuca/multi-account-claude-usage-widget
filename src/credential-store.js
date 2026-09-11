/**
 * credential-store.js
 *
 * Where an account's provider credential lives, and what the app is allowed to
 * do when the OS cannot protect it.
 *
 * The previous rules had three sharp edges:
 *
 *   1. When encryption was unavailable the credential was written to
 *      config.json in the clear, with nothing telling the user.
 *   2. The lookup location was chosen by *current* availability, so a key
 *      written in the clear became invisible the moment encryption started
 *      working, and an encrypted key became invisible during a temporary
 *      keychain loss — in both cases the app reported "not connected" for a
 *      credential that was sitting right there.
 *   3. Linux's `basic_text` backend counts as "available" to
 *      safeStorage.isEncryptionAvailable(), but it is obfuscation with a
 *      hard-coded key, not protection. Electron says so explicitly:
 *      https://www.electronjs.org/docs/latest/api/safe-storage
 *
 * The rules now:
 *
 *   - Reading always looks in every location, newest first, and NEVER deletes
 *     anything it failed to read. A locked or missing keychain is reported as
 *     locked; the ciphertext stays exactly where it is.
 *   - Writing happens only when the OS offers real protection. Encrypt, read
 *     it back, and only then remove a superseded plaintext copy — the only
 *     copy is never destroyed before its verified replacement exists.
 *   - Without real protection nothing changes at all. The save is refused,
 *     the previously committed credential stays exactly as it was, and the
 *     caller offers manual tracking instead. There is deliberately no
 *     in-memory "temporary login": a refused reconnect that parked the new key
 *     in memory made `load()` prefer the rejected key over the committed one,
 *     so a refusal silently replaced the active credential and the account
 *     cookie was then written from it. A refusal is now a clean rollback.
 *
 *   - Every credential read and write goes through the store's DURABLE facet
 *     (see the durable-store contract in src/config-recovery.js), never
 *     through the resilient wrapper's memory overlay. The overlay exists so
 *     ordinary settings survive a read-only config file; it must never be able
 *     to satisfy a credential write's read-back verification, because the
 *     secret would then be reported as saved while nothing reached the disk -
 *     and the superseded plaintext copy would be deleted on the strength of
 *     it. A config store with no durable facet (the in-memory stand-in used
 *     when the file cannot be opened) refuses credential persistence outright.
 *
 * Nothing here logs, returns or stringifies a credential value: callers get
 * the key or a state, and the diagnostics carry states and error messages
 * only.
 */
'use strict';

const CREDENTIAL_MODES = {
  ENCRYPTED: 'encrypted',              // read back from OS-protected storage
  MIGRATED: 'migrated',                // was plaintext, now encrypted and verified
  LEGACY_PLAINTEXT: 'legacy-plaintext',// pre-existing clear copy, kept and usable
  LOCKED: 'locked',                    // ciphertext exists, keychain unavailable
  UNDECRYPTABLE: 'undecryptable',      // ciphertext exists, decrypt refused it
  UNREADABLE: 'unreadable',            // the config file itself could not be read
  ABSENT: 'absent',
  // Outcomes of a refused save. None of them changes stored state.
  REFUSED: 'refused',                  // the OS will not protect a secret here
  WRITE_FAILED: 'write-failed',        // durable write or its verification failed
  NO_DURABLE_STORE: 'no-durable-store' // config is in-memory only this session
};

// Linux backends that provide no meaningful protection. `basic_text` is
// Chromium's hard-coded-key fallback; `unknown` means Electron could not tell,
// which is not a basis for writing a secret to disk.
const INSECURE_LINUX_BACKENDS = new Set(['basic_text', 'unknown']);

const encryptedKeyFor = (id) => `account_${id}_sessionKey_encrypted`;
const plaintextKeyFor = (id) => `account_${id}_sessionKey`;

// The store's durable facet, or null when it has none. Kept local so this
// module has no dependencies; the contract itself is documented in
// src/config-recovery.js, which is where the facets are built.
//
//   - a store that declares `durable` means it exactly (null = nothing durable)
//   - a store that declares `persistent === false` has no durable storage
//   - anything else is a real electron-store: its own writes throw on failure,
//     so it satisfies the contract as-is.
function resolveDurable(store) {
  if (!store) return null;
  if (Object.prototype.hasOwnProperty.call(store, 'durable')) return store.durable || null;
  if (store.persistent === false) return null;
  return store;
}

/**
 * @param {Object} deps
 * @param {Object} deps.store        electron-store-like { get, set, delete, has }
 * @param {Object} deps.safeStorage  Electron safeStorage (or a test double)
 * @param {string} deps.platform     process.platform
 * @param {Function} [deps.log]      (message) => void, never given a secret
 */
function createCredentialStore({ store, safeStorage, platform, log = () => {} }) {
  const durable = resolveDurable(store);
  let warnedInsecure = false;

  function backendName() {
    if (platform !== 'linux') return null;
    try {
      return typeof safeStorage.getSelectedStorageBackend === 'function'
        ? safeStorage.getSelectedStorageBackend()
        : 'unknown';
    } catch (err) {
      return 'unknown';
    }
  }

  function security() {
    let available = false;
    try {
      available = !!safeStorage.isEncryptionAvailable();
    } catch (err) {
      return { available: false, backend: null, secure: false, reason: `probe-failed:${err.message}` };
    }
    if (!available) {
      return { available: false, backend: backendName(), secure: false, reason: 'keychain-unavailable' };
    }
    const backend = backendName();
    if (backend && INSECURE_LINUX_BACKENDS.has(backend)) {
      return { available: true, backend, secure: false, reason: `insecure-backend:${backend}` };
    }
    return { available: true, backend, secure: true, reason: 'ok' };
  }

  // Encrypt, write DURABLY, and read straight back out of the durable store.
  // The read-back is the point: it proves the value survived both the cipher
  // and the file before anything else is removed. Both operations bypass the
  // resilient wrapper's overlay, so a rejected write throws here instead of
  // being answered by memory.
  //
  // If the write lands but its verification does not, the new ciphertext is
  // rolled back to whatever was there before: leaving an unverifiable
  // ciphertext in place would shadow a perfectly good legacy plaintext copy,
  // since reads prefer ciphertext.
  function writeVerifiedEncrypted(id, sessionKey) {
    const key = encryptedKeyFor(id);
    const encrypted = safeStorage.encryptString(sessionKey);
    const base64 = encrypted.toString('base64');
    const previous = durable.has(key) ? durable.get(key) : undefined;
    let wrote = false;
    try {
      durable.set(key, base64);
      wrote = true;
      const readBack = durable.get(key);
      if (readBack !== base64) throw new Error('stored-ciphertext-mismatch');
      if (safeStorage.decryptString(Buffer.from(readBack, 'base64')) !== sessionKey) {
        throw new Error('verify-decrypt-mismatch');
      }
    } catch (err) {
      if (wrote) {
        try {
          if (previous === undefined) durable.delete(key);
          else durable.set(key, previous);
        } catch (rollbackError) {
          // Say so rather than let a half-written ciphertext look intentional.
          throw new Error(`${err.message}; rollback-failed:${rollbackError.message}`);
        }
      }
      throw err;
    }
  }

  /**
   * Persist a credential if — and only if — it can be durably protected.
   *
   * `saved: true` means, with no qualification: the ciphertext is in the
   * config file, it was read back out of the file, and it decrypted to the
   * value passed in. Anything else is `saved: false`, and in every such case
   * the previously committed credential is left exactly as it was and nothing
   * is cached in memory.
   *
   * @returns {{saved: boolean, mode: string, reason: string, retainedLegacyPlaintext?: boolean}}
   */
  function save(id, sessionKey) {
    if (!durable) {
      // The config file could not be opened, so this session is running on an
      // in-memory stand-in. Storing a credential there would be reported as a
      // save and would vanish at exit.
      log(`[Credentials] Refusing to save a credential for account ${id}: this session has no durable configuration file`);
      return { saved: false, mode: CREDENTIAL_MODES.NO_DURABLE_STORE, reason: 'config-not-durable' };
    }
    const state = security();
    if (!state.secure) {
      if (!warnedInsecure) {
        warnedInsecure = true;
        log(`[Credentials] Secure storage unavailable (${state.reason}) — sign-in is refused and nothing is written; manual tracking is the supported route`);
      }
      return { saved: false, mode: CREDENTIAL_MODES.REFUSED, reason: state.reason };
    }
    try {
      writeVerifiedEncrypted(id, sessionKey);
    } catch (err) {
      // The existing stored value is left untouched: a failed write must not
      // cost the user the credential they already had, and must not be
      // reported as a connection either.
      log(`[Credentials] Could not store credential for account ${id} durably: ${err.message} — nothing was changed`);
      return { saved: false, mode: CREDENTIAL_MODES.WRITE_FAILED, reason: `encrypt-failed:${err.message}` };
    }
    // A verified replacement exists, so a superseded plaintext copy can go.
    // If that removal itself fails the credential is still saved, but the
    // clear copy is still there and the caller is told so.
    let retainedLegacyPlaintext = false;
    try {
      if (durable.has(plaintextKeyFor(id))) {
        durable.delete(plaintextKeyFor(id));
        log(`[Credentials] Account ${id}: replaced a plaintext credential with a verified encrypted one`);
      }
    } catch (err) {
      retainedLegacyPlaintext = true;
      log(`[Credentials] Account ${id}: the encrypted credential is stored, but the old plaintext copy could not be removed (${err.message})`);
    }
    return {
      saved: true,
      mode: CREDENTIAL_MODES.ENCRYPTED,
      reason: 'ok',
      retainedLegacyPlaintext
    };
  }

  /**
   * Read a credential from wherever it actually is.
   * @returns {{key: string|null, mode: string, error?: string}}
   */
  function load(id) {
    if (!durable) return { key: null, mode: CREDENTIAL_MODES.ABSENT };

    let encrypted;
    try {
      encrypted = durable.get(encryptedKeyFor(id));
    } catch (err) {
      // The config file cannot be read right now. That is not "no credential":
      // reporting absent would offer a reconnect that cannot help and would
      // invite a save over a file we cannot see into.
      return { key: null, mode: CREDENTIAL_MODES.UNREADABLE, error: err.message };
    }
    const state = security();

    if (encrypted) {
      if (!state.available) {
        // Ciphertext we cannot open right now. Report it as locked and leave
        // it alone — reconnecting cannot repair a locked keychain, and
        // deleting it would turn a temporary problem into a permanent one.
        return { key: null, mode: CREDENTIAL_MODES.LOCKED, error: state.reason };
      }
      try {
        const value = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
        // A verified encrypted copy supersedes a clear one. Best effort: if
        // the removal fails the credential still works, so this must not throw.
        try {
          if (durable.has(plaintextKeyFor(id))) durable.delete(plaintextKeyFor(id));
        } catch (_) {}
        return { key: value, mode: CREDENTIAL_MODES.ENCRYPTED };
      } catch (err) {
        log(`[Credentials] Account ${id}: stored credential could not be decrypted (${err.message}) — kept in place`);
        return { key: null, mode: CREDENTIAL_MODES.UNDECRYPTABLE, error: err.message };
      }
    }

    let plaintext = null;
    try {
      plaintext = durable.get(plaintextKeyFor(id), null);
    } catch (err) {
      return { key: null, mode: CREDENTIAL_MODES.UNREADABLE, error: err.message };
    }
    if (plaintext) {
      // A pre-existing clear copy from an older version or an insecure host.
      // If the OS can protect it now, upgrade it in place: encrypt, verify,
      // then drop the clear copy.
      if (state.secure) {
        try {
          writeVerifiedEncrypted(id, plaintext);
          durable.delete(plaintextKeyFor(id));
          log(`[Credentials] Account ${id}: migrated a legacy plaintext credential into encrypted storage`);
          return { key: plaintext, mode: CREDENTIAL_MODES.MIGRATED };
        } catch (err) {
          log(`[Credentials] Account ${id}: legacy plaintext credential could not be encrypted (${err.message}) — left as it was`);
        }
      }
      return { key: plaintext, mode: CREDENTIAL_MODES.LEGACY_PLAINTEXT };
    }

    return { key: null, mode: CREDENTIAL_MODES.ABSENT };
  }

  /**
   * What the UI needs to know without reading the secret: does this account
   * have a credential, and can the app use it?
   * @returns {{state: string, usable: boolean, persisted: boolean}}
   */
  function credentialState(id) {
    const result = load(id);
    return {
      state: result.mode,
      usable: !!result.key,
      // "There is a credential in a file somewhere." Only durable locations
      // count; there is no in-memory location any more.
      persisted: result.mode === CREDENTIAL_MODES.ENCRYPTED
        || result.mode === CREDENTIAL_MODES.MIGRATED
        || result.mode === CREDENTIAL_MODES.LEGACY_PLAINTEXT
        || result.mode === CREDENTIAL_MODES.LOCKED
        || result.mode === CREDENTIAL_MODES.UNDECRYPTABLE
    };
  }

  /**
   * Delete both copies. Reports what actually happened, so a caller can tell
   * the user that a removal did not reach the disk instead of implying it did.
   * @returns {{removed: boolean, failures: Array<{key: string, error: string}>}}
   */
  function remove(id) {
    const failures = [];
    if (!durable) return { removed: false, failures: [{ key: 'store', error: 'config-not-durable' }] };
    for (const key of [encryptedKeyFor(id), plaintextKeyFor(id)]) {
      try {
        durable.delete(key);
      } catch (err) {
        failures.push({ key, error: err.message });
      }
    }
    if (failures.length) {
      log(`[Credentials] Account ${id}: credential removal did not reach the configuration file`);
    }
    return { removed: failures.length === 0, failures };
  }

  return {
    security,
    save,
    load,
    credentialState,
    remove,
    // Diagnostics: is durable credential storage available at all this run?
    isDurable: () => !!durable
  };
}

module.exports = {
  CREDENTIAL_MODES,
  INSECURE_LINUX_BACKENDS,
  encryptedKeyFor,
  plaintextKeyFor,
  createCredentialStore
};
