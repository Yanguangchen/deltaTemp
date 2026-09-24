/* In-process metrics: counters, latency histograms, and a rolling window of
   recent analyses. Everything is bounded — this runs forever on a laptop. */

'use strict';

const MAX_SAMPLES = 500;   // per histogram
const MAX_RECENT = 50;     // recent analyses kept for the dashboard

function createMetrics() {
  const startedAt = Date.now();
  const counters = new Map();
  const histograms = new Map();
  const recent = [];

  const key = (name, tags) => {
    if (!tags || !Object.keys(tags).length) return name;
    const parts = Object.keys(tags).sort().map((k) => `${k}=${tags[k]}`);
    return `${name}{${parts.join(',')}}`;
  };

  function increment(name, tags, by = 1) {
    const k = key(name, tags);
    counters.set(k, (counters.get(k) || 0) + by);
  }

  function observe(name, ms, tags) {
    const k = key(name, tags);
    let samples = histograms.get(k);
    if (!samples) histograms.set(k, (samples = []));
    samples.push(ms);
    if (samples.length > MAX_SAMPLES) samples.shift();
  }

  function recordAnalysis(entry) {
    recent.push({ at: new Date().toISOString(), ...entry });
    if (recent.length > MAX_RECENT) recent.shift();
  }

  function percentile(sorted, p) {
    if (!sorted.length) return null;
    const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return Math.round(sorted[Math.max(0, idx)]);
  }

  function summarize(samples) {
    const sorted = [...samples].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    return {
      count: sorted.length,
      min: sorted.length ? Math.round(sorted[0]) : null,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      max: sorted.length ? Math.round(sorted[sorted.length - 1]) : null,
      mean: sorted.length ? Math.round(sum / sorted.length) : null,
    };
  }

  function snapshot() {
    const mem = process.memoryUsage();
    return {
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      startedAt: new Date(startedAt).toISOString(),
      counters: Object.fromEntries([...counters.entries()].sort()),
      latencyMs: Object.fromEntries(
        [...histograms.entries()].sort().map(([k, v]) => [k, summarize(v)]),
      ),
      recentAnalyses: [...recent].reverse(),
      process: {
        pid: process.pid,
        node: process.version,
        rssMb: +(mem.rss / 1048576).toFixed(1),
        heapUsedMb: +(mem.heapUsed / 1048576).toFixed(1),
      },
    };
  }

  /* Wraps an async op: times it, counts ok/fail, rethrows unchanged. */
  async function time(name, tags, fn) {
    const started = process.hrtime.bigint();
    try {
      const result = await fn();
      observe(name, Number(process.hrtime.bigint() - started) / 1e6, { ...tags, outcome: 'ok' });
      increment(`${name}.total`, { ...tags, outcome: 'ok' });
      return result;
    } catch (err) {
      observe(name, Number(process.hrtime.bigint() - started) / 1e6, { ...tags, outcome: 'error' });
      increment(`${name}.total`, { ...tags, outcome: 'error' });
      throw err;
    }
  }

  return { increment, observe, recordAnalysis, snapshot, time };
}

module.exports = { createMetrics };
