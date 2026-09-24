/* Structured logger: JSON lines to disk, readable text to the console, and an
   in-memory ring buffer the dashboard reads over HTTP.

   Every record is {ts, level, event, ...fields}. `event` is a dotted name like
   "gemini.attempt" so records can be grouped without parsing messages. */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 };

const COLOR = {
  trace: '\x1b[90m', debug: '\x1b[36m', info: '\x1b[32m',
  warn: '\x1b[33m', error: '\x1b[31m', dim: '\x1b[90m', reset: '\x1b[0m',
};

/* Anything that looks like a credential is masked before it can reach a log
   sink. Logs get pasted into issues; keys must never ride along. */
const SECRET_KEYS = /^(.*(key|token|secret|password|authorization|credential).*)$/i;

function maskSecret(value) {
  const s = String(value);
  if (s.length <= 8) return '***';
  return `${s.slice(0, 3)}***${s.slice(-2)} (len ${s.length})`;
}

function redact(value, depth = 0) {
  if (value === null || typeof value !== 'object' || depth > 6) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    // Booleans/numbers carry no secret ("hasKey: true" must stay readable).
    if (SECRET_KEYS.test(k) && typeof v === 'string') out[k] = maskSecret(v);
    else if (k === 'base64' || k === 'data') out[k] = `<${String(v).length} chars>`;
    else out[k] = redact(v, depth + 1);
  }
  return out;
}

function createLogger(options = {}) {
  const level = LEVELS[options.level] || LEVELS.info;
  const dir = options.dir || path.join(__dirname, 'logs');
  const toFile = options.toFile !== false;
  const bufferSize = options.bufferSize || 500;

  const buffer = [];
  let stream = null;
  let streamDay = null;

  if (toFile) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      console.error(`logger: cannot create ${dir}, file logging off (${err.message})`);
    }
  }

  function sink(record) {
    if (!toFile) return;
    const day = record.ts.slice(0, 10);
    try {
      if (day !== streamDay) {          // daily rotation
        if (stream) stream.end();
        stream = fs.createWriteStream(path.join(dir, `app-${day}.jsonl`), { flags: 'a' });
        stream.on('error', (err) => console.error(`logger: ${err.message}`));
        streamDay = day;
      }
      stream.write(`${JSON.stringify(record)}\n`);
    } catch { /* logging must never break the request path */ }
  }

  function emit(levelName, event, fields = {}) {
    if (LEVELS[levelName] < level) return;

    const record = { ts: new Date().toISOString(), level: levelName, event, ...redact(fields) };

    buffer.push(record);
    if (buffer.length > bufferSize) buffer.shift();

    sink(record);

    const { ts, level: _l, event: _e, ...rest } = record;
    const detail = Object.entries(rest)
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join(' ');

    const line = `${COLOR.dim}${ts.slice(11, 23)}${COLOR.reset} ` +
      `${COLOR[levelName]}${levelName.padEnd(5)}${COLOR.reset} ` +
      `${event}${detail ? ` ${COLOR.dim}${detail}${COLOR.reset}` : ''}`;

    (levelName === 'error' || levelName === 'warn' ? console.error : console.log)(line);
  }

  const api = {
    levelName: options.level || 'info',
    dir: toFile ? dir : null,
    recent: (limit = 100, minLevel = 'trace') => buffer
      .filter((r) => LEVELS[r.level] >= (LEVELS[minLevel] || 0))
      .slice(-limit),
  };
  for (const name of Object.keys(LEVELS)) {
    api[name] = (event, fields) => emit(name, event, fields);
  }
  return api;
}

module.exports = { createLogger, LEVELS, redact };
