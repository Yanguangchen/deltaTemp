/* Shared bits for the Vercel serverless build of the API.

   server.js is the local story: one long-lived Node process that serves the
   static files AND the /api routes. Vercel never runs it — the repo deploys as
   a static site, so these files re-expose the same /api surface as individual
   functions. Both read the same env vars and both go through prompt.js, so a
   request means the same thing in either place.

   Differences that are the platform's, not ours:
     - no .env file loading (Vercel injects env vars into the process)
     - no file logging or in-memory metrics (each invocation is its own process)
     - request bodies are capped at 4.5 MB by the platform, not 25 MB */

'use strict';

const crypto = require('node:crypto');

const { ENDPOINT, DEFAULT_MODEL } = require('../gpr-annotator/prompt.js');

const API_KEY = (process.env.GEMINI_API_KEY || '').trim();
const MODEL = (process.env.GEMINI_MODEL || '').trim() || DEFAULT_MODEL;
const FALLBACK_MODEL = (process.env.GEMINI_MODEL_FALLBACK ?? 'gemini-3.5-flash').trim();
const MAX_RETRIES = Math.max(1, Number(process.env.GEMINI_MAX_RETRIES) || 3);

/* The gate on the routes that spend the API key. Locally server.js needs none —
   it listens on your machine only. A public deployment does: without this, the
   URL alone is enough for anyone to run analyses on your key.

   Deliberately a shared secret, not real auth. It turns "anyone with the URL"
   into "anyone you gave the token to", which is the right size for one operator
   and a handful of colleagues. Unset = open, which is correct for local use and
   wrong for production — hence the startup warning below. */
const ACCESS_TOKEN = (process.env.GPR_ACCESS_TOKEN || '').trim();
const TOKEN_HEADER = 'x-gpr-token';

if (!ACCESS_TOKEN && process.env.VERCEL_ENV === 'production') {
  console.warn(JSON.stringify({
    event: 'auth.open',
    warning: 'GPR_ACCESS_TOKEN is not set — /api/annotate and /api/models are reachable by anyone with the URL, spending GEMINI_API_KEY.',
  }));
}

/* Compare digests, not the raw strings: timingSafeEqual throws on a length
   mismatch, which would otherwise leak the token's length. */
function tokenOk(req) {
  if (!ACCESS_TOKEN) return true;

  const offered = req.headers[TOKEN_HEADER];
  if (typeof offered !== 'string' || !offered) return false;

  const digest = (s) => crypto.createHash('sha256').update(s).digest();
  return crypto.timingSafeEqual(digest(offered), digest(ACCESS_TOKEN));
}

function json(res, status, payload) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

/* These endpoints spend a real API key, so the allow-list stays narrow: our own
   deployment (same host) plus local dev servers. Never a wildcard. */
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;                       // same-origin GET, or curl
  if (LOCAL_ORIGIN.test(origin)) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/* Wraps a handler with the preflight/origin/token checks every route needs.
   `open: true` skips the token gate — used by /api/config and /api/health, which
   spend nothing and have to stay reachable for the client to discover that a
   token is required at all. */
function withCors(handler, { open = false } = {}) {
  return async (req, res) => {
    const origin = req.headers.origin;

    if (origin && originAllowed(req)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', `Content-Type, X-Request-Id, ${TOKEN_HEADER}`);
      res.setHeader('Access-Control-Max-Age', '600');
    }

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    if (!originAllowed(req)) {
      json(res, 403, { error: 'Cross-origin API access is limited to this site and local development servers.' });
      return;
    }

    if (!open && !tokenOk(req)) {
      json(res, 401, {
        error: 'This deployment requires an access token. Paste it into Settings → "Access token".',
        requiresToken: true,
      });
      return;
    }

    res.setHeader('Cache-Control', 'no-store');

    try {
      await handler(req, res);
    } catch (err) {
      if (!res.writableEnded) json(res, 500, { error: err?.message || 'Unhandled server error.' });
    }
  };
}

/* Vercel parses JSON bodies for us, but a client that omits Content-Type lands
   here as a raw string. Accept both rather than 400-ing on a technicality. */
function parseBody(req) {
  const body = req.body;
  if (body && typeof body === 'object') return body;
  if (typeof body === 'string' && body) return JSON.parse(body);
  return null;
}

const reqId = () => Math.random().toString(16).slice(2, 10);

module.exports = {
  API_KEY, MODEL, FALLBACK_MODEL, MAX_RETRIES, ENDPOINT,
  REQUIRES_TOKEN: Boolean(ACCESS_TOKEN), TOKEN_HEADER,
  json, withCors, parseBody, reqId,
};
