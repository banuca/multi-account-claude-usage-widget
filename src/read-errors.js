/**
 * read-errors.js
 *
 * One place that decides what a failed usage read actually proves.
 *
 * Only one thing may ever cost the user their saved credential: positive proof
 * from the provider that the credential itself was rejected. Everything else —
 * a Cloudflare challenge, an HTML error page, a gateway timeout, a malformed
 * response, a locked keychain — says the READ failed and nothing about the
 * credential.
 *
 * Claude has no positive signal at all: its reader classifies body text, so it
 * cannot tell "your session expired" from "Cloudflare wants a challenge
 * solved". No Claude error may reach the destructive path.
 *
 * ChatGPT does have one, but it was previously conflated. The reader mints a
 * token from /api/auth/session, and *any* failure to obtain one — the request
 * throwing, a 502, an HTML error page, unparseable JSON — used to be reported
 * as NoAccessToken and mapped to AuthRequired, which deleted the saved
 * credential. A valid JSON response that simply carries no token is different:
 * that is the endpoint saying nobody is signed in. Only that, and an outright
 * 401/403, is proof.
 */
'use strict';

// Read failures that carry no information about the credential. Matched on the
// error's leading code so the (useful) detail after the colon is free-form.
const TRANSIENT_READ_CODES = [
  'CloudflareBlocked',      // interstitial served instead of JSON
  'CloudflareChallenge',    // JS/cookie challenge page
  'UnexpectedHTML',         // any other HTML body where JSON was expected
  'InvalidJSON',            // JSON parse failure on a 200
  'SessionExchangeUnavailable', // token endpoint unreachable/erroring/unparseable
  'SessionExchangeRateLimited', // token endpoint asked us to back off
  'SecureStorageLocked',    // credential exists but the keychain will not open
  'Request timeout',
  'PageError',
  'LoadFailed',
  'EmptyResponse',
  'NoUsableReading'
];

// A 5xx from the usage endpoint is the provider failing, not the credential.
const SERVER_ERROR_PATTERN = /^HTTP5\d\d/;

function errorCode(error) {
  const message = String((error && error.message) || error || '');
  const colon = message.indexOf(':');
  return colon === -1 ? message : message.slice(0, colon);
}

function isTransientReadError(error) {
  const message = String((error && error.message) || error || '');
  if (SERVER_ERROR_PATTERN.test(message)) return true;
  const code = errorCode(error);
  return TRANSIENT_READ_CODES.includes(code);
}

/**
 * Did the provider positively reject this credential?
 *
 * @param {string} provider  'claude' | 'chatgpt'
 * @param {Error|string} error
 */
function isConfirmedAuthRejection(provider, error) {
  if (provider !== 'chatgpt') return false;
  const message = String((error && error.message) || error || '');
  return message === 'AuthRequired' || message.startsWith('AuthRequired:');
}

module.exports = {
  TRANSIENT_READ_CODES,
  errorCode,
  isTransientReadError,
  isConfirmedAuthRejection
};
