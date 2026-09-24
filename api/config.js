'use strict';

const {
  API_KEY, MODEL, FALLBACK_MODEL, REQUIRES_TOKEN, TOKEN_HEADER,
  json, withCors, reqId,
} = require('./_shared.js');

/* The probe the browser uses to decide whether a server proxy exists at all.
   Its shape is the contract: app.js only accepts a candidate base whose
   /api/config returns a boolean hasServerKey.

   Ungated on purpose. If the token gate answered here too, a client without a
   token could not tell "no server" from "server, needs a token" — so it would
   silently fall back to calling Google direct instead of asking for the token.
   Nothing here is worth protecting: a model name and two booleans. */
module.exports = withCors(async (req, res) => {
  json(res, 200, {
    hasServerKey: Boolean(API_KEY),
    model: MODEL,
    fallback: FALLBACK_MODEL || null,
    requiresToken: REQUIRES_TOKEN,
    tokenHeader: REQUIRES_TOKEN ? TOKEN_HEADER : undefined,
    reqId: reqId(),
  });
}, { open: true });
