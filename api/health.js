'use strict';

const { API_KEY, MODEL, FALLBACK_MODEL, REQUIRES_TOKEN, json, withCors } = require('./_shared.js');

/* The serverless twin of server.js's /api/health. Uptime, in-flight requests and
   log/metric state are properties of a long-lived process, so they are absent
   here by nature — hence `runtime`, which tells the observability page which of
   the two it is talking to. /api/metrics and /api/logs exist only locally. */
module.exports = withCors(async (req, res) => {
  json(res, 200, {
    status: API_KEY ? 'ok' : 'degraded',
    reason: API_KEY ? undefined : 'no GEMINI_API_KEY configured',
    runtime: 'vercel-function',
    region: process.env.VERCEL_REGION || null,
    deployment: process.env.VERCEL_ENV || null,
    model: MODEL,
    fallback: FALLBACK_MODEL || null,
    requiresToken: REQUIRES_TOKEN,
    node: process.version,
  });
}, { open: true });
