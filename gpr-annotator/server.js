/* Zero-dependency static server + Gemini proxy.
   The API key stays in .env on this process and is never sent to the browser.
   Requires Node 18+ (global fetch). */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const crypto = require('node:crypto');

const { buildRequest, parseResponse, ENDPOINT, DEFAULT_MODEL } = require('./prompt.js');
const { createLogger } = require('./logger.js');
const { createMetrics } = require('./metrics.js');
const { createAuth, AuthError, ACCESS_DOC } = require('./server-auth.js');

const ROOT = __dirname;
const PARENT = path.dirname(ROOT);
const MAX_BODY = 25 * 1024 * 1024; // inline image payloads
const UPSTREAM_TIMEOUT_MS = 110000; // just under the browser's 120s abort

/* ── .env ─────────────────────────────────────────────── */

/* Looked up nearest-first, and within each directory .env.local beats .env
   (the usual convention: .local is your private machine-specific copy).
   First file to define a key wins, so this app overrides the workspace. */
const ENV_CANDIDATES = [
  path.join(ROOT, '.env.local'),
  path.join(ROOT, '.env'),
  path.join(PARENT, '.env.local'),
  path.join(PARENT, '.env'),
];

/* Collected during load (before the logger exists) and reported at startup. A
   silently-ignored duplicate key is exactly the kind of thing that costs an
   hour of debugging, so it must never pass unremarked. */
const envWarnings = [];

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return false;

  const seenInFile = new Set();

  for (const [index, raw] of fs.readFileSync(file, 'utf8').split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    if (!key) continue;

    let value = line.slice(eq + 1).trim();
    if (/^(".*"|'.*')$/s.test(value)) value = value.slice(1, -1);

    if (seenInFile.has(key)) {
      envWarnings.push({
        kind: 'duplicate_key', key, file, line: index + 1,
        ignored: value, using: process.env[key],
      });
      continue;
    }
    seenInFile.add(key);

    // Real process env wins over any file; earlier file wins over later.
    if (process.env[key] === undefined) process.env[key] = value;
    else if (!seenInFile.has(key)) {
      envWarnings.push({ kind: 'shadowed', key, file, ignored: value, using: process.env[key] });
    }
  }
  return true;
}

const envFilesLoaded = ENV_CANDIDATES.filter(loadEnvFile);

const API_KEY = (process.env.GEMINI_API_KEY || '').trim();
const MODEL = (process.env.GEMINI_MODEL || '').trim() || DEFAULT_MODEL;
const FALLBACK_MODEL = (process.env.GEMINI_MODEL_FALLBACK ?? 'gemini-3.5-flash').trim();
const MAX_RETRIES = Math.max(1, Number(process.env.GEMINI_MAX_RETRIES) || 3);
const PORT = Number(process.env.PORT) || 8787;

/* Google sign-in (Firebase Auth). Every /api/* route except /api/config needs a
   valid ID token, and every route except /api/me also needs the Firestore rules
   to approve the user (see server-auth.js and ../firestore.rules). */
const FIREBASE_PROJECT_ID = (process.env.FIREBASE_PROJECT_ID || '').trim() || 'gprportal-49b88';
const authenticate = createAuth({ projectId: FIREBASE_PROJECT_ID });

/* Requests currently being served. Surfaced by /api/health and the dashboard so
   a hung call is visible while it is still hanging, not only after it fails. */
const inFlight = new Map();

const log = createLogger({
  // debug by default: static page fetches are logged, which is how you tell a
  // browser that never loaded the app from one that loaded a stale copy.
  level: (process.env.LOG_LEVEL || 'debug').toLowerCase(),
  dir: process.env.LOG_DIR || path.join(ROOT, 'logs'),
  // Vercel's filesystem is read-only; logs go to stdout (the Vercel log viewer).
  toFile: process.env.LOG_TO_FILE !== 'false' && !process.env.VERCEL,
});
const metrics = createMetrics();

/* ── Static files ─────────────────────────────────────── */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'X-Request-Id': res.reqId || '-',
  });
  res.end(body);
}

/* Static root is the DeltaTemp workspace, not just this folder, so both apps are
   reachable from one server: / is Data Helper, /gpr-annotator/ is this app. That
   is what makes the cross-app nav links work in either direction. */
const STATIC_ROOT = PARENT;

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';

  // Resolve inside STATIC_ROOT only — no traversal, and no dotfiles (.env, .git).
  const target = path.resolve(STATIC_ROOT, `.${rel}`);
  const escapes = target !== STATIC_ROOT && !target.startsWith(STATIC_ROOT + path.sep);
  const hidden = rel.split(/[\\/]/).some((seg) => seg.startsWith('.'));

  if (escapes || hidden) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const data = await fsp.readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}

/* ── Request body ─────────────────────────────────────── */

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    let aborted = false;

    req.on('data', (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        // Stop buffering, but keep draining so the response can still be written.
        aborted = true;
        chunks.length = 0;
        reject(new Error('Image payload too large (limit 25 MB). Use a smaller image.'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* ── Routes ───────────────────────────────────────────── */

async function annotate(req, res) {
  if (!API_KEY) {
    json(res, 503, { error: 'Server has no GEMINI_API_KEY. Copy .env.example to .env and set it.' });
    return;
  }

  let input;
  try {
    input = JSON.parse(await readBody(req));
  } catch (err) {
    json(res, 400, { error: err.message || 'Invalid JSON body.' });
    return;
  }

  if (!input || typeof input.base64 !== 'string' || !input.base64) {
    json(res, 400, { error: 'Missing image data.' });
    return;
  }

  const model = (typeof input.model === 'string' && input.model.trim()) || MODEL;
  const imageBytes = Math.round(input.base64.length * 0.75);
  const mb = +(imageBytes / 1048576).toFixed(2);
  const reqId = res.reqId;
  const analysisStart = Date.now();

  log.info('analyze.start', {
    reqId, model, fallback: FALLBACK_MODEL || null,
    imageMb: mb, mimeType: input.mimeType, focus: input.focus ? input.focus.length : 0,
  });
  metrics.increment('analyze.requests', { model });
  metrics.observe('analyze.image_mb', mb, { model });

  // Hard ceiling so a stalled upstream call can never hang the browser.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  const body = JSON.stringify(buildRequest({
    mimeType: input.mimeType,
    base64: input.base64,
    focus: input.focus,
  }));

  /* Popular models return 503 "high demand" in bursts, so retry with backoff
     before giving up, then fall back to a less contended model. */
  const attempt = async (name, tryNo) => {
    const started = Date.now();
    log.debug('gemini.attempt', { reqId, model: name, try: tryNo + 1 });

    try {
      const upstream = await fetch(`${ENDPOINT}/${encodeURIComponent(name)}:generateContent`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
        body,
      });
      const payload = await upstream.json().catch(() => null);
      const ms = Date.now() - started;
      const usage = payload?.usageMetadata || {};

      metrics.observe('gemini.latency', ms, { model: name });
      metrics.increment('gemini.attempts', { model: name, status: upstream.status });

      log[upstream.ok ? 'info' : 'warn']('gemini.response', {
        reqId, model: name, try: tryNo + 1, status: upstream.status, ms,
        promptTokens: usage.promptTokenCount ?? null,
        outputTokens: usage.candidatesTokenCount ?? null,
        totalTokens: usage.totalTokenCount ?? null,
        finishReason: payload?.candidates?.[0]?.finishReason ?? null,
        error: upstream.ok ? undefined : payload?.error?.message,
      });

      if (usage.totalTokenCount) {
        metrics.increment('gemini.tokens_total', { model: name }, usage.totalTokenCount);
        metrics.increment('gemini.tokens_prompt', { model: name }, usage.promptTokenCount || 0);
        metrics.increment('gemini.tokens_output', { model: name }, usage.candidatesTokenCount || 0);
      }

      return { ok: upstream.ok, status: upstream.status, payload, ms };
    } catch (err) {
      const ms = Date.now() - started;
      metrics.increment('gemini.attempts', { model: name, status: err.name === 'AbortError' ? 'timeout' : 'network' });
      log.error('gemini.failed', { reqId, model: name, try: tryNo + 1, ms, error: err.message, kind: err.name });
      throw err;
    }
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const BUSY = new Set([429, 503]);

  try {
    const chain = FALLBACK_MODEL && FALLBACK_MODEL !== model ? [model, FALLBACK_MODEL] : [model];
    let last = null;
    // Per-model outcome, so the failure message can name which model got which
    // status instead of blaming "all busy" for two different problems.
    const outcomes = [];

    for (const name of chain) {
      for (let tryNo = 0; tryNo < MAX_RETRIES; tryNo++) {
        if (tryNo) {
          const wait = 1000 * 2 ** (tryNo - 1);
          metrics.increment('gemini.retries', { model: name });
          log.warn('gemini.retry', { reqId, model: name, try: tryNo, waitMs: wait, reason: last?.status });
          await sleep(wait);
        }

        const result = await attempt(name, tryNo);
        last = { ...result, name };

        if (result.ok) {
          const annotations = parseResponse(result.payload, { velocityMPerNs: input.velocityMPerNs });
          const totalMs = Date.now() - analysisStart;
          const usedFallback = name !== model;

          if (usedFallback) metrics.increment('gemini.fallbacks', { from: model, to: name });
          metrics.observe('analyze.duration', totalMs, { model: name });
          metrics.increment('analyze.success', { model: name });
          metrics.observe('analyze.annotations', annotations.length, { model: name });
          metrics.recordAnalysis({
            reqId, requested: model, modelUsed: name, ok: true,
            ms: totalMs, imageMb: mb, annotations: annotations.length,
            attempts: tryNo + 1, usedFallback,
            tokens: result.payload?.usageMetadata?.totalTokenCount ?? null,
          });

          log.info('analyze.success', {
            reqId, model: name, requested: model, usedFallback,
            annotations: annotations.length, attempts: tryNo + 1, totalMs,
            labels: annotations.map((a) => a.label).slice(0, 10),
          });

          json(res, 200, { annotations, modelUsed: name, reqId, ms: totalMs });
          return;
        }
        if (!BUSY.has(result.status)) break; // 404/400/403 — retrying won't help
      }
      outcomes.push({ name, status: last?.status ?? 0 });
    }

    const status = last?.status || 502;
    const detail = last?.payload?.error?.message || `Gemini returned HTTP ${status}`;
    const totalMs = Date.now() - analysisStart;

    metrics.increment('analyze.failure', { model: last?.name || model, status });
    metrics.observe('analyze.duration', totalMs, { model: last?.name || model });
    metrics.recordAnalysis({
      reqId, requested: model, modelUsed: last?.name || model, ok: false,
      ms: totalMs, imageMb: mb, status, error: detail,
    });
    log.error('analyze.failure', {
      reqId, requested: model, tried: chain, status, totalMs, error: detail,
      outcomes: outcomes.map((o) => `${o.name}:${o.status}`).join(','),
    });

    /* 429 and 503 both mean "no answer", but they need opposite responses: a 429
       is this key's quota and waiting does not clear it, while a 503 really is
       contention. Say which, and show the per-model statuses either way. */
    const tried = outcomes.map((o) => `${o.name} → HTTP ${o.status || 'no response'}`).join(', ');
    json(res, status, {
      error: status === 404
        ? `Model "${last.name}" does not exist for this key. Open Settings → "List models my key can call" to see valid names.`
        : status === 429
          ? `Quota exhausted for this API key, not a traffic spike — waiting will not clear it. Check the quota/billing for the key's Google project, or use a different key. Tried: ${tried}. Google said: ${detail.replace(/\s+$/, '')}`
          : status === 503
            ? `${detail.replace(/\s+$/, '')} Tried: ${tried}. If this persists for more than an hour it is not congestion — try a model from a different family in Settings, or a smaller image (this one was ${mb} MB).`
            : `${detail} (HTTP ${status}; tried: ${tried})`,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      json(res, 504, { error: `Gemini did not respond within ${UPSTREAM_TIMEOUT_MS / 1000}s. Try a smaller image or a flash model.` });
    } else {
      json(res, 502, { error: err.message || 'Upstream request failed.' });
    }
  } finally {
    clearTimeout(timer);
  }
}

/* Ask Google which models this key can actually call, so the Settings dialog can
   offer real names instead of guesses. */
async function listModels(res) {
  if (!API_KEY) {
    json(res, 503, { error: 'Server has no GEMINI_API_KEY.' });
    return;
  }

  try {
    const upstream = await fetch(`${ENDPOINT}?pageSize=200`, {
      headers: { 'x-goog-api-key': API_KEY },
    });
    const payload = await upstream.json().catch(() => null);

    if (!upstream.ok) {
      json(res, upstream.status, { error: payload?.error?.message || `HTTP ${upstream.status}` });
      return;
    }

    const models = (payload?.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => ({
        id: String(m.name || '').replace(/^models\//, ''),
        label: m.displayName || '',
      }))
      .filter((m) => m.id);

    json(res, 200, { models });
  } catch (err) {
    json(res, 502, { error: err.message || 'Could not reach Google.' });
  }
}

/* Accepts error/timing reports from the browser so client-side failures land in
   the same log stream as server ones. */
async function clientLog(req, res) {
  try {
    const events = JSON.parse(await readBody(req));
    for (const e of [].concat(events).slice(0, 50)) {
      const level = ['error', 'warn', 'info', 'debug'].includes(e.level) ? e.level : 'info';
      log[level](`client.${e.event || 'event'}`, { reqId: res.reqId, ...e.fields, source: 'browser' });
      metrics.increment('client.events', { level, event: e.event || 'event' });
    }
    json(res, 202, { accepted: true });
  } catch (err) {
    json(res, 400, { error: err.message });
  }
}

/* Allow the API to be called from another local dev server (VS Code Live Server
   on :5500, etc.). Local origins only — never a wildcard, since these endpoints
   spend a real API key. */
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/* Browsers send Origin on same-origin POSTs too, so the deployed page calling
   its own /api/* must not be mistaken for a cross-origin caller. */
function isSameOrigin(req) {
  const origin = req.headers.origin;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  try { return Boolean(host) && new URL(origin).host === host; } catch { return false; }
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin || !LOCAL_ORIGIN.test(origin)) return;

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Request-Id, Authorization');
  res.setHeader('Access-Control-Max-Age', '600');
}

function handler(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  const started = Date.now();

  if (pathname.startsWith('/api/')) {
    applyCors(req, res);
    if (req.method === 'OPTIONS') {
      log.debug('http.preflight', { path: pathname, origin: req.headers.origin });
      res.writeHead(204).end();
      return;
    }
    if (req.headers.origin && !LOCAL_ORIGIN.test(req.headers.origin) && !isSameOrigin(req)) {
      log.warn('http.origin_rejected', { path: pathname, origin: req.headers.origin });
      json(res, 403, { error: 'Cross-origin API access is limited to local development servers.' });
      return;
    }
  }

  res.reqId = (req.headers['x-request-id'] || crypto.randomUUID().slice(0, 8)).toString().slice(0, 36);

  log.trace('http.request', { reqId: res.reqId, method: req.method, path: pathname });

  if (pathname.startsWith('/api/') && pathname !== '/api/health' && pathname !== '/api/metrics' && pathname !== '/api/logs') {
    inFlight.set(res.reqId, { path: pathname, method: req.method, startedAt: started });
  }

  // A client that navigates away or times out leaves a half-finished request.
  res.on('close', () => {
    if (!res.writableFinished && inFlight.has(res.reqId)) {
      const ms = Date.now() - started;
      metrics.increment('http.aborted', { path: pathname });
      log.warn('http.client_aborted', { reqId: res.reqId, path: pathname, ms });
    }
    inFlight.delete(res.reqId);
  });

  res.on('finish', () => {
    const ms = Date.now() - started;
    const isApi = pathname.startsWith('/api/');

    metrics.increment('http.responses', { status: res.statusCode, kind: isApi ? 'api' : 'static' });
    if (isApi) metrics.observe('http.latency', ms, { path: pathname });

    // Static 200s are noise; log them at debug, everything else at info/warn.
    const level = res.statusCode >= 500 ? 'error'
      : res.statusCode >= 400 ? 'warn'
        : isApi ? 'info' : 'debug';

    log[level]('http.response', {
      reqId: res.reqId, method: req.method, path: pathname, status: res.statusCode, ms,
      uid: res.user?.uid,
    });
  });

  if (pathname === '/api/config') {
    json(res, 200, {
      hasServerKey: Boolean(API_KEY), model: MODEL, fallback: FALLBACK_MODEL || null, reqId: res.reqId,
      auth: { provider: 'google', projectId: FIREBASE_PROJECT_ID },
    });
    return;
  }

  if (pathname.startsWith('/api/')) {
    authorize(req, res, pathname).then((user) => { if (user) routeApi(req, res, pathname); });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    json(res, 405, { error: 'Method not allowed.' });
    return;
  }

  serveStatic(req, res);
}

/* Resolves to the user when the request may go on to a route. Otherwise it has
   already answered (401, 403, 503, or /api/me) and resolves to null. */
async function authorize(req, res, pathname) {
  let user;
  try {
    user = await authenticate(req);
  } catch (err) {
    if (!(err instanceof AuthError)) {
      log.error('auth.check_failed', { reqId: res.reqId, error: err.message });
      json(res, 503, { error: 'Could not check your Google sign-in right now. Try again shortly.' });
      return null;
    }
    log.warn('auth.rejected', { reqId: res.reqId, path: pathname, reason: err.message });
    json(res, err.status, { error: err.message });
    return null;
  }

  res.user = user;

  if (pathname === '/api/me') {
    json(res, 200, { uid: user.uid, email: user.email, name: user.name, allowed: user.allowed });
    return null;
  }

  if (!user.allowed) {
    log.warn('auth.not_allowed', { reqId: res.reqId, path: pathname, uid: user.uid, email: user.email });
    json(res, 403, {
      error: `${user.email || user.uid} is not approved for GPR Annotator. Ask an admin to add UID ${user.uid} to the Firestore rules.`,
    });
    return null;
  }

  return user;
}

function routeApi(req, res, pathname) {
  if (pathname === '/api/health') {
    const snap = metrics.snapshot();
    json(res, 200, {
      status: API_KEY ? 'ok' : 'degraded',
      reason: API_KEY ? undefined : 'no GEMINI_API_KEY configured',
      uptimeSeconds: snap.uptimeSeconds,
      startedAt: snap.startedAt,
      model: MODEL,
      fallback: FALLBACK_MODEL || null,
      envFiles: envFilesLoaded.map((f) => path.relative(PARENT, f)),
      logLevel: log.levelName,
      logDir: log.dir,
      process: snap.process,
      inFlight: [...inFlight.entries()].map(([id, r]) => ({
        reqId: id, path: r.path, method: r.method, elapsedMs: Date.now() - r.startedAt,
      })),
    });
    return;
  }

  if (pathname === '/api/metrics') {
    json(res, 200, metrics.snapshot());
    return;
  }

  if (pathname === '/api/logs') {
    const q = new URL(req.url, 'http://localhost').searchParams;
    json(res, 200, {
      entries: log.recent(Math.min(500, Number(q.get('limit')) || 100), q.get('level') || 'trace'),
    });
    return;
  }

  if (pathname === '/api/client-log') {
    if (req.method !== 'POST') { json(res, 405, { error: 'Use POST.' }); return; }
    clientLog(req, res);
    return;
  }

  if (pathname === '/api/models') {
    listModels(res);
    return;
  }

  if (pathname === '/api/annotate') {
    if (req.method !== 'POST') { json(res, 405, { error: 'Use POST.' }); return; }
    annotate(req, res);
    return;
  }

  json(res, 404, { error: 'Unknown API route.' });
}

/* On Vercel this file is imported by api/index.js and only `handler` is used;
   the platform serves the static files and owns the process. */
module.exports = { handler };

if (require.main === module) startServer();

function startServer() {
  const server = http.createServer(handler);

  server.listen(PORT, () => {
    console.log(`\nDeltaTemp workspace  →  http://localhost:${PORT}`);
    console.log(`  Data Helper:    http://localhost:${PORT}/`);
    console.log(`  GPR Annotator:  http://localhost:${PORT}/gpr-annotator/`);
    console.log(`  Observability:  http://localhost:${PORT}/gpr-annotator/observability.html\n`);

    log.info('server.start', {
      port: PORT,
      model: MODEL,
      fallback: FALLBACK_MODEL || null,
      maxRetries: MAX_RETRIES,
      hasKey: Boolean(API_KEY),
      firebaseProject: FIREBASE_PROJECT_ID,
      accessDoc: ACCESS_DOC,
      envFiles: envFilesLoaded.map((f) => path.relative(PARENT, f)),
      logLevel: log.levelName,
      logDir: log.dir,
      node: process.version,
    });

    if (!API_KEY) {
      log.warn('server.no_key', {
        hint: 'copy .env.example to .env.local and set GEMINI_API_KEY',
        looked: ENV_CANDIDATES.map((f) => path.relative(PARENT, f)),
      });
    }
  });

  /* Never die silently — a crash must leave a record in the same log stream. */
  process.on('uncaughtException', (err) => {
    log.error('process.uncaught_exception', { error: err.message, stack: err.stack });
    process.exitCode = 1;
  });
  process.on('unhandledRejection', (reason) => {
    log.error('process.unhandled_rejection', { error: String(reason?.message || reason), stack: reason?.stack });
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      log.info('server.stop', { signal, ...metrics.snapshot().counters });
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000).unref();
    });
  }
}
