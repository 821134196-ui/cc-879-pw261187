import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { RetryBudget } from './budget.js';
import { UpstreamPool } from './pool.js';
import { TraceStore } from './trace.js';
import { ProxyEngine } from './proxy.js';
import { createLogger } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function json(res, status, value) {
  const payload = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function serveStatic(req, res, url) {
  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  if (rel.includes('..')) {
    res.writeHead(400).end('bad path');
    return;
  }
  const file = path.join(PUBLIC_DIR, rel);
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'content-length': String(data.length),
      'cache-control': 'no-store',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
}

function summary(config, budget, pool, traceStore) {
  const traces = traceStore.list();
  const finished = traces.filter((t) => t.result);
  const retried = finished.filter((t) => t.attempts.length > 1);
  const gaveUp = finished.filter((t) => ['gave-up', 'gave-up-weak'].includes(t.result.outcome));
  const delivered = finished.filter((t) => t.result.outcome === 'delivered');
  const truncated = finished.filter((t) => t.result.outcome === 'truncated');
  const weakRelayed = finished.filter((t) => t.result.outcome === 'weak-relayed');
  const latencies = delivered.map((t) => t.durationMs).filter((n) => Number.isFinite(n));
  latencies.sort((a, b) => a - b);
  const p = (q) => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))] : null);
  return {
    config: {
      retry: config.retry,
      budget: config.budget,
      upstreamPolicy: config.upstreamPolicy,
      demo: config.demo,
    },
    budget: budget.snapshot(),
    upstreams: pool.snapshot(),
    totals: {
      traces: traces.length,
      finished: finished.length,
      retried: retried.length,
      delivered: delivered.length,
      truncated: truncated.length,
      weakRelayed: weakRelayed.length,
      gaveUp: gaveUp.length,
      p50Ms: p(0.5),
      p95Ms: p(0.95),
    },
  };
}

function adminRouter({ config, budget, pool, traceStore }) {
  return async (req, res, url) => {
    if (url.pathname === '/admin/traces' && req.method === 'GET') {
      json(res, 200, { traces: traceStore.list() });
      return true;
    }
    if (url.pathname.startsWith('/admin/traces/') && req.method === 'GET') {
      const id = decodeURIComponent(url.pathname.slice('/admin/traces/'.length));
      const trace = traceStore.get(id);
      if (!trace) json(res, 404, { error: 'trace_not_found' });
      else json(res, 200, trace);
      return true;
    }
    if (url.pathname === '/admin/stream' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      const send = (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      send('snapshot', summary(config, budget, pool, traceStore));
      const onUpdate = (t) => send('trace', t);
      const onFinish = (t) => send('finished', { id: t.id, result: t.result });
      const heartbeat = setInterval(() => send('heartbeat', { at: Date.now() }), 15_000);
      traceStore.on('update', onUpdate);
      traceStore.on('finish', onFinish);
      req.on('close', () => {
        clearInterval(heartbeat);
        traceStore.off('update', onUpdate);
        traceStore.off('finish', onFinish);
      });
      return true;
    }
    if (url.pathname === '/admin/stats' && req.method === 'GET') {
      json(res, 200, summary(config, budget, pool, traceStore));
      return true;
    }
    if (url.pathname === '/admin/budget' && req.method === 'POST') {
      // Demo helper: let the debug page spend tokens to visualise the shared
      // budget under concurrent weak failures.
      const spend = Number(url.searchParams.get('spend') || 1);
      const results = [];
      for (let i = 0; i < spend; i++) results.push(budget.tryTake() ? 'granted' : 'denied');
      json(res, 200, { results, budget: budget.snapshot() });
      return true;
    }
    if (url.pathname === '/admin/reset-budget' && req.method === 'POST') {
      budget.granted = 0;
      budget.denied = 0;
      budget.since = Date.now();
      budget.reset();
      json(res, 200, budget.snapshot());
      return true;
    }
    if (url.pathname === '/admin/clear-traces' && req.method === 'POST') {
      traceStore.clear();
      json(res, 200, { cleared: true });
      return true;
    }
    if (url.pathname === '/admin/upstreams' && req.method === 'GET') {
      json(res, 200, { upstreams: pool.snapshot() });
      return true;
    }
    if (url.pathname === '/admin/health') {
      json(res, 200, { ok: true, at: new Date().toISOString() });
      return true;
    }
    if (url.pathname.startsWith('/admin')) {
      json(res, 404, { error: 'not_found', path: url.pathname });
      return true;
    }
    return false;
  };
}

export async function startProxy(config, { traceStore, budget, pool, logger } = {}) {
  const log = logger || createLogger({ level: config.logLevel });
  const budgetInstance = budget || new RetryBudget(config.budget);
  const poolInstance = pool || new UpstreamPool(config.upstreams, config.upstreamPolicy);
  const store = traceStore || new TraceStore({ capacity: config.traceBuffer });
  const engine = new ProxyEngine({
    config,
    pool: poolInstance,
    budget: budgetInstance,
    traceStore: store,
    logger: log,
  });

  const admin = adminRouter({ config, budget: budgetInstance, pool: poolInstance, traceStore: store });

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'proxy.local'}`);
    } catch {
      res.writeHead(400).end('bad url');
      return;
    }

    try {
      if (await admin(req, res, url)) return;
      if (url.pathname === '/' || url.pathname.startsWith('/assets/') || url.pathname === '/index.html') {
        await serveStatic(req, res, url);
        return;
      }
      // Everything else is proxied.
      await engine.handle(req, res);
    } catch (err) {
      log.error('unhandled proxy error', err);
      if (!res.headersSent) {
        const payload = Buffer.from(JSON.stringify({ error: 'internal', message: err.message }));
        res.writeHead(500, { 'content-type': 'application/json' }).end(payload);
      } else if (!res.destroyed) {
        res.destroy();
      }
    }
  });

  server.keepAliveTimeout = 30_000;

  return {
    server,
    engine,
    pool: poolInstance,
    budget: budgetInstance,
    traceStore: store,
    logger: log,
    listen: () => new Promise((resolve) => server.listen(config.port, config.host, resolve)),
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}
