/* Firebase ID token verification for the API, with no dependencies.

   The browser signs in with Google through Firebase Auth and sends the ID token
   as "Authorization: Bearer <token>". This checks the RS256 signature against
   Google's published keys plus the claims Firebase documents (iss, aud, exp,
   iat, auth_time, sub).

   The Firebase project is shared by several RAK apps, so a valid token only
   proves the caller signed in somewhere in that project. Who may use THIS app
   is decided by the Firestore rules, not by a list kept here: the server reads
   appAccess/gpr-annotator with the caller's own token. If the rules let them
   read it, they are approved (the same isAllowedUser() that guards the rest of
   the data), and if Firestore says PERMISSION_DENIED, they are not. One list,
   in firestore.rules, for every app. */

'use strict';

const crypto = require('node:crypto');

const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const CLOCK_SKEW_S = 60;
const MIN_REFETCH_MS = 60 * 1000; // an unknown kid may force a refetch, but not a flood of them

const ACCESS_DOC = 'appAccess/gpr-annotator';
// Remembered per UID so each API call doesn't cost a Firestore round trip.
// Short for "no" so a newly approved user gets in quickly.
const ALLOW_TTL_MS = 5 * 60 * 1000;
const DENY_TTL_MS = 30 * 1000;

function createKeyStore(fetchImpl = fetch) {
  let keys = new Map();
  let expires = 0;
  let fetchedAt = 0;

  async function refresh() {
    const res = await fetchImpl(JWKS_URL);
    if (!res.ok) throw new Error(`Google signing keys returned HTTP ${res.status}`);
    const body = await res.json();
    const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') || '')?.[1]) || 3600;

    keys = new Map((body.keys || []).map((jwk) => [jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' })]));
    fetchedAt = Date.now();
    expires = fetchedAt + maxAge * 1000;
  }

  return async function getKey(kid) {
    if (Date.now() >= expires) await refresh();
    // Google rotates keys; a token signed with a brand-new one needs a refetch.
    if (!keys.has(kid) && Date.now() - fetchedAt > MIN_REFETCH_MS) await refresh();
    return keys.get(kid) || null;
  };
}

class AuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.status = status;
  }
}

function decodePart(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

async function verifyIdToken(token, { projectId, getKey, now = Date.now() }) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new AuthError('Malformed sign-in token.');

  let header, claims;
  try {
    header = decodePart(parts[0]);
    claims = decodePart(parts[1]);
  } catch {
    throw new AuthError('Malformed sign-in token.');
  }

  if (header.alg !== 'RS256' || !header.kid) throw new AuthError('Unexpected sign-in token algorithm.');

  const key = await getKey(header.kid);
  if (!key) throw new AuthError('Sign-in token was signed with an unknown key.');

  const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
  if (!crypto.verify('RSA-SHA256', signed, key, Buffer.from(parts[2], 'base64url'))) {
    throw new AuthError('Sign-in token signature is invalid.');
  }

  const t = Math.floor(now / 1000);
  if (claims.aud !== projectId) throw new AuthError('Sign-in token is for a different Firebase project.');
  if (claims.iss !== `https://securetoken.google.com/${projectId}`) throw new AuthError('Sign-in token has the wrong issuer.');
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S < t) throw new AuthError('Sign-in expired. Sign in again.');
  if (typeof claims.iat !== 'number' || claims.iat - CLOCK_SKEW_S > t) throw new AuthError('Sign-in token is not valid yet.');
  if (typeof claims.auth_time === 'number' && claims.auth_time - CLOCK_SKEW_S > t) throw new AuthError('Sign-in token is not valid yet.');
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 128) throw new AuthError('Sign-in token has no user.');

  return { uid: claims.sub, email: claims.email || null, name: claims.name || null };
}

/* Asks Firestore whether the rules let this user in, by reading ACCESS_DOC as
   them. 200 (exists) or 404 (readable, not created) both mean the read was
   permitted. 403 means the rules refused it. Anything else is an outage and
   throws, so a Firestore hiccup is reported as such, never as "not approved". */
function createAccessCheck({ projectId, fetchImpl = fetch }) {
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/${ACCESS_DOC}`;
  const cache = new Map();

  return async function isAllowed(uid, idToken) {
    const hit = cache.get(uid);
    if (hit && hit.until > Date.now()) return hit.allowed;

    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${idToken}` } });
    let allowed;
    if (res.status === 200 || res.status === 404) allowed = true;
    else if (res.status === 403) allowed = false;
    else throw new Error(`Firestore access check returned HTTP ${res.status}`);

    cache.set(uid, { allowed, until: Date.now() + (allowed ? ALLOW_TTL_MS : DENY_TTL_MS) });
    return allowed;
  };
}

/* Returns authenticate(req) → { uid, email, name, allowed }. Throws AuthError
   (401) for a missing or invalid token, or a plain Error when Google can't be
   reached. The access decision is returned, not thrown, so /api/me can tell a
   signed-in user they are not approved. */
function createAuth({ projectId, fetchImpl }) {
  const getKey = createKeyStore(fetchImpl);
  const isAllowed = createAccessCheck({ projectId, fetchImpl });

  return async function authenticate(req) {
    const header = req.headers.authorization || '';
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match) throw new AuthError('Sign in with Google to use the API.');

    const user = await verifyIdToken(match[1], { projectId, getKey });
    return { ...user, allowed: await isAllowed(user.uid, match[1]) };
  };
}

module.exports = { createAuth, verifyIdToken, AuthError, JWKS_URL, ACCESS_DOC };
