'use strict';

const { API_KEY, ENDPOINT, json, withCors } = require('./_shared.js');

/* Ask Google which models this key can actually call, so the Settings dialog can
   offer real names instead of guesses. */
module.exports = withCors(async (req, res) => {
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
});
