/* Browser-side telemetry: a bounded ring buffer of events, span timing, and a
   batched shipper that forwards warnings/errors to the server so client faults
   land in the same log stream as server ones.

   Exposed as window.Telemetry. Read the buffer live from devtools with
   Telemetry.dump(). */

(function (root) {
  'use strict';

  const MAX_EVENTS = 300;
  const FLUSH_MS = 800;        // batch window for info records
  const FLUSH_NOW_MS = 50;     // warn/error: get it to the server immediately
  /* Ship info too: session.start and analyze.* are exactly the records needed to
     tell a stale page or a file:// origin from a genuinely slow model. */
  const SHIP_LEVELS = new Set(['info', 'warn', 'error']);

  /* Bump on every client change. Logged at session start so the server records
     which build the browser is actually running — the only reliable way to catch
     a stale cached page. */
  const CLIENT_VERSION = '2026-09-25.1';

  const buffer = [];
  const pending = [];
  const sessionId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())).slice(0, 8);

  let flushTimer = null;
  let shipping = true;
  let endpoint = '/api/client-log'; // re-pointed by the app once the API is found
  let extraHeaders = {};            // e.g. the access token on a gated deployment

  function record(level, event, fields = {}) {
    const entry = { at: new Date().toISOString(), level, event, fields, sessionId };

    buffer.push(entry);
    if (buffer.length > MAX_EVENTS) buffer.shift();

    const styles = { error: 'color:#ff6b6b', warn: 'color:#ffd166', info: 'color:#4da3ff', debug: 'color:#8d9aad' };
    console.log(`%c[gpr] ${event}`, styles[level] || '', fields);

    if (shipping && SHIP_LEVELS.has(level)) {
      pending.push({ level, event, fields: { ...fields, sessionId } });
      scheduleFlush(level === 'error' || level === 'warn');
    }
    return entry;
  }

  function scheduleFlush(urgent = false) {
    const delay = urgent ? FLUSH_NOW_MS : FLUSH_MS;
    if (flushTimer) {
      if (!urgent) return;
      clearTimeout(flushTimer);   // promote a pending batch to urgent
    }
    flushTimer = setTimeout(flush, delay);
  }

  async function flush() {
    clearTimeout(flushTimer);
    flushTimer = null;
    if (!pending.length) return;

    const batch = pending.splice(0, pending.length);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...extraHeaders },
        body: JSON.stringify(batch),
        keepalive: true,
      });
      /* A gated deployment with no token yet rejects every batch. Retrying would
         just burn invocations, so stop until setEndpoint is called again. */
      if (res.status === 401 || res.status === 403) shipping = false;
    } catch {
      shipping = false; // no server (file:// or offline) — keep logging locally only
    }
  }

  /* Times a block of work and records start/end with duration. */
  function span(event, fields = {}) {
    const started = performance.now();
    record('debug', `${event}.start`, fields);

    return {
      end(extra = {}) {
        const ms = Math.round(performance.now() - started);
        record('info', `${event}.end`, { ...fields, ...extra, ms });
        return ms;
      },
      fail(err, extra = {}) {
        const ms = Math.round(performance.now() - started);
        record('error', `${event}.fail`, {
          ...fields, ...extra, ms,
          error: err?.message || String(err),
          kind: err?.name,
        });
        return ms;
      },
    };
  }

  // Uncaught client faults
  root.addEventListener('error', (e) => {
    record('error', 'window.error', {
      message: e.message,
      source: `${e.filename}:${e.lineno}:${e.colno}`,
      stack: e.error?.stack?.split('\n').slice(0, 4).join(' | '),
    });
  });

  root.addEventListener('unhandledrejection', (e) => {
    record('error', 'window.unhandled_rejection', {
      message: String(e.reason?.message || e.reason),
      stack: e.reason?.stack?.split('\n').slice(0, 4).join(' | '),
    });
  });

  root.addEventListener('beforeunload', () => { if (pending.length) flush(); });

  root.Telemetry = {
    sessionId,
    span,
    /* Point the shipper at the API server once it is located — needed when the
       page is served from a different port than server.js. `headers` carries the
       access token on a gated deployment; call again after it changes. */
    setEndpoint(url, headers = {}) {
      endpoint = url;
      extraHeaders = headers;
      shipping = true;
      if (pending.length) scheduleFlush();
    },
    debug: (event, fields) => record('debug', event, fields),
    info: (event, fields) => record('info', event, fields),
    warn: (event, fields) => record('warn', event, fields),
    error: (event, fields) => record('error', event, fields),
    dump: (level) => (level ? buffer.filter((e) => e.level === level) : [...buffer]),
    clear: () => { buffer.length = 0; },
    flush,
  };

  /* Repeats while a long operation is in flight so a stuck UI leaves a trail
     instead of silence. Returns a stop function. */
  root.Telemetry.heartbeat = function heartbeat(event, fields = {}, everyMs = 3000) {
    const started = performance.now();
    const id = setInterval(() => {
      record('warn', `${event}.still_running`, {
        ...fields,
        elapsedMs: Math.round(performance.now() - started),
      });
    }, everyMs);
    return () => clearInterval(id);
  };

  root.Telemetry.version = CLIENT_VERSION;

  record('info', 'session.start', {
    // How the page was opened decides whether the server proxy is reachable at
    // all — file:// means no /api/*, so this is the first thing to check.
    clientVersion: CLIENT_VERSION,
    href: location.href,
    protocol: location.protocol,
    servedByProxy: location.protocol.startsWith('http'),
    ua: navigator.userAgent,
    viewport: `${root.innerWidth}×${root.innerHeight}`,
    dpr: root.devicePixelRatio,
  });
}(window));
