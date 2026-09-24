'use strict';

const { buildRequest, parseResponse } = require('../gpr-annotator/prompt.js');
const {
  API_KEY, MODEL, FALLBACK_MODEL, MAX_RETRIES, ENDPOINT,
  json, withCors, parseBody, reqId,
} = require('./_shared.js');

const UPSTREAM_TIMEOUT_MS = 110000; // just under the browser's 120s abort
const BUSY = new Set([429, 503]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = withCors(async (req, res) => {
  if (req.method !== 'POST') { json(res, 405, { error: 'Use POST.' }); return; }

  if (!API_KEY) {
    json(res, 503, { error: 'Server has no GEMINI_API_KEY. Set it in the Vercel project environment variables and redeploy.' });
    return;
  }

  let input;
  try {
    input = parseBody(req);
  } catch (err) {
    json(res, 400, { error: err.message || 'Invalid JSON body.' });
    return;
  }

  if (!input || typeof input.base64 !== 'string' || !input.base64) {
    json(res, 400, { error: 'Missing image data.' });
    return;
  }

  const model = (typeof input.model === 'string' && input.model.trim()) || MODEL;
  const id = (req.headers['x-request-id'] || reqId()).toString().slice(0, 36);
  const analysisStart = Date.now();

  // Hard ceiling so a stalled upstream call can never hang the browser.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  const body = JSON.stringify(buildRequest({
    mimeType: input.mimeType,
    base64: input.base64,
    focus: input.focus,
  }));

  const attempt = async (name) => {
    const upstream = await fetch(`${ENDPOINT}/${encodeURIComponent(name)}:generateContent`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
      body,
    });
    const payload = await upstream.json().catch(() => null);
    return { ok: upstream.ok, status: upstream.status, payload };
  };

  /* Popular models return 503 "high demand" in bursts, so retry with backoff
     before giving up, then fall back to a less contended model. */
  try {
    const chain = FALLBACK_MODEL && FALLBACK_MODEL !== model ? [model, FALLBACK_MODEL] : [model];
    let last = null;

    for (const name of chain) {
      for (let tryNo = 0; tryNo < MAX_RETRIES; tryNo++) {
        if (tryNo) await sleep(1000 * 2 ** (tryNo - 1));

        const result = await attempt(name);
        last = { ...result, name };

        if (result.ok) {
          const annotations = parseResponse(result.payload, { velocityMPerNs: input.velocityMPerNs });
          const totalMs = Date.now() - analysisStart;

          console.log(JSON.stringify({
            event: 'analyze.success', reqId: id, model: name, requested: model,
            usedFallback: name !== model, annotations: annotations.length,
            attempts: tryNo + 1, totalMs,
          }));

          json(res, 200, { annotations, modelUsed: name, reqId: id, ms: totalMs });
          return;
        }
        if (!BUSY.has(result.status)) break; // 404/400/403 — retrying won't help
      }
    }

    const status = last?.status || 502;
    const detail = last?.payload?.error?.message || `Gemini returned HTTP ${status}`;

    console.error(JSON.stringify({
      event: 'analyze.failure', reqId: id, requested: model, tried: chain, status, error: detail,
    }));

    json(res, status, {
      error: status === 404
        ? `Model "${last.name}" does not exist for this key. Open Settings → "List models my key can call" to see valid names.`
        : BUSY.has(status)
          ? `${detail.replace(/\s+$/, '')} Tried ${chain.join(' then ')} — all busy. Wait a moment, or pick a different model in Settings.`
          : detail,
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
});
