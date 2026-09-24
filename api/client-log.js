'use strict';

const { json, withCors, parseBody, reqId } = require('./_shared.js');

/* Accepts error/timing reports from the browser. Locally these join the server's
   own log file; here there is no file to join, so they go to stdout and show up
   in the Vercel runtime logs. */
module.exports = withCors(async (req, res) => {
  if (req.method !== 'POST') { json(res, 405, { error: 'Use POST.' }); return; }

  try {
    const id = reqId();
    for (const e of [].concat(parseBody(req) || []).slice(0, 50)) {
      const level = ['error', 'warn', 'info', 'debug'].includes(e.level) ? e.level : 'info';
      const line = JSON.stringify({ event: `client.${e.event || 'event'}`, level, reqId: id, ...e.fields, source: 'browser' });
      if (level === 'error') console.error(line);
      else if (level === 'warn') console.warn(line);
      else console.log(line);
    }
    json(res, 202, { accepted: true });
  } catch (err) {
    json(res, 400, { error: err.message });
  }
});
