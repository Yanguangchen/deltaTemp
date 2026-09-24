/* Checks the Firebase ID token verifier in gpr-annotator/server-auth.js against
   tokens signed with a throwaway RSA key. Run: node tests/gpr-auth.cjs */

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

const { createAuth, verifyIdToken } = require(path.join(__dirname, '../gpr-annotator/server-auth.js'));

const PROJECT = 'gprportal-49b88';
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const getKey = async (kid) => (kid === 'k1' ? publicKey : null);
const now = Date.now();
const t = Math.floor(now / 1000);

function sign(claims, { kid = 'k1', alg = 'RS256', key = privateKey } = {}) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = `${enc({ alg, kid, typ: 'JWT' })}.${enc(claims)}`;
  return `${head}.${crypto.sign('RSA-SHA256', Buffer.from(head), key).toString('base64url')}`;
}

const good = {
  iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT,
  sub: 'uid-123', email: 'a@example.com', iat: t - 10, exp: t + 3600, auth_time: t - 10,
};

const verify = (token) => verifyIdToken(token, { projectId: PROJECT, getKey, now });
const rejects = async (token, pattern, label) => {
  await assert.rejects(verify(token), (err) => pattern.test(err.message) && err.status === 401, label);
  console.log(`  ok  rejects ${label}`);
};

(async () => {
  const user = await verify(sign(good));
  assert.equal(user.uid, 'uid-123');
  assert.equal(user.email, 'a@example.com');
  console.log('  ok  accepts a valid token');

  await rejects('not-a-token', /Malformed/, 'a malformed token');
  await rejects(sign(good, { key: other.privateKey }), /signature/, 'a token signed with another key');
  await rejects(sign(good, { kid: 'k9' }), /unknown key/, 'an unknown key id');
  await rejects(sign(good, { alg: 'HS256' }), /algorithm/, 'a non-RS256 token');
  await rejects(sign({ ...good, aud: 'another-project' }), /different Firebase project/, 'another project');
  await rejects(sign({ ...good, iss: 'https://evil.example' }), /issuer/, 'a wrong issuer');
  await rejects(sign({ ...good, exp: t - 120 }), /expired/, 'an expired token');
  await rejects(sign({ ...good, iat: t + 600 }), /not valid yet/, 'a token issued in the future');
  await rejects(sign({ ...good, sub: '' }), /no user/, 'a token with no subject');

  const tampered = sign(good).split('.');
  tampered[1] = Buffer.from(JSON.stringify({ ...good, sub: 'someone-else' })).toString('base64url');
  await rejects(tampered.join('.'), /signature/, 'a token with edited claims');

  /* createAuth against fake Google endpoints. The fake Firestore plays the
     rules: it answers per UID with the status the real rules would produce. */
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' };
  const firestoreStatus = { 'uid-exists': 200, 'uid-listed': 404, 'uid-outsider': 403, 'uid-outage': 500 };
  let firestoreCalls = 0;
  let lastFirestoreAuth = null;
  const fakeFetch = async (url, opts = {}) => {
    if (url.includes('securetoken')) {
      return { ok: true, status: 200, headers: new Headers({ 'cache-control': 'max-age=60' }), json: async () => ({ keys: [jwk] }) };
    }
    assert.match(url, /firestore\.googleapis\.com\/v1\/projects\/gprportal-49b88\/databases\/\(default\)\/documents\/appAccess\/gpr-annotator$/);
    firestoreCalls++;
    lastFirestoreAuth = opts.headers?.Authorization;
    const uid = JSON.parse(Buffer.from(lastFirestoreAuth.split('.')[1], 'base64url')).sub;
    return { ok: false, status: firestoreStatus[uid] };
  };
  const authenticate = createAuth({ projectId: PROJECT, fetchImpl: fakeFetch });
  const as = (sub) => ({ headers: { authorization: `Bearer ${sign({ ...good, sub })}` } });

  assert.equal((await authenticate(as('uid-exists'))).allowed, true);
  assert.equal((await authenticate(as('uid-listed'))).allowed, true);
  console.log('  ok  approved when the rules permit the read (document present or absent)');

  assert.equal((await authenticate(as('uid-outsider'))).allowed, false);
  console.log('  ok  refused when Firestore answers PERMISSION_DENIED');

  await assert.rejects(authenticate(as('uid-outage')), (err) => !err.status && /HTTP 500/.test(err.message));
  console.log('  ok  a Firestore outage is an error, not "not approved"');

  const token = sign({ ...good, sub: 'uid-listed' });
  const before = firestoreCalls;
  await authenticate({ headers: { authorization: `Bearer ${token}` } });
  assert.equal(firestoreCalls, before, 'second check for the same UID should come from the cache');
  const fresh = createAuth({ projectId: PROJECT, fetchImpl: fakeFetch });
  await fresh({ headers: { authorization: `Bearer ${token}` } });
  assert.equal(lastFirestoreAuth, `Bearer ${token}`);
  console.log('  ok  asks Firestore with the user\'s own token, then caches the answer');

  await assert.rejects(authenticate({ headers: {} }), /Sign in with Google/);
  console.log('  ok  a missing Authorization header is refused');

  console.log('All auth checks passed.');
})().catch((err) => { console.error(err); process.exit(1); });
