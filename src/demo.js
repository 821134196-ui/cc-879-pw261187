import http from 'node:http';
import { buildConfig } from './config.js';
import { startProxy } from './server.js';

/**
 * Self-contained demo: starts three mock upstreams that misbehave in
 * scriptable ways, then runs the proxy in front of them so the debug console
 * shows real forwards with real retries. No external dependencies.
 *
 * Each mock backend picks behavior from its path:
 *   /ok                      normal 200 JSON body
 *   /slow-first-hop?ms=N     accepts the TCP connection, never sends a head
 *   /weak?status=503         retryable status
 *   /flaky?fail=N            fails the first N attempts, then succeeds
 *   /hit-and-drop?after=N    sends N body bytes, then destroys the socket
 *   /hit-and-drop-before     close before any body byte after the head
 *   /stream                  chunked body over 1.2s
 *   /big?bytes=N             large body for backpressure
 *   /echo                    echoes method + body
 */

const backendCounters = new Map();

function counter(key) {
  const n = backendCounters.get(key) || 0;
  backendCounters.set(key, n + 1);
  return n;
}

function makeBackend({ id, port, latencyMs }) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://backend.local');
    const path = url.pathname;
    const total = counter(`${id}:${path}`);

    const finish = (status, headers, payload) => {
      const body = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload ?? {}));
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(body.length), ...headers });
      res.end(body);
    };

    const route = () => {
      if (path === '/ok' || path === '/') {
        finish(200, { 'x-backend': id }, { backend: id, path, ok: true });
        return;
      }
      if (path === '/echo') {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => finish(200, { 'x-backend': id }, {
          backend: id,
          method: req.method,
          body: Buffer.concat(chunks).toString('utf8'),
          idempotencyKey: req.headers['idempotency-key'] || null,
        }));
        return;
      }
      if (path === '/slow-first-hop') {
        const ms = Number(url.searchParams.get('ms') || 5000);
        const timer = setTimeout(() => finish(200, { 'x-backend': id }, { backend: id, slow: true, ms }), ms);
        res.on('close', () => clearTimeout(timer));
        return;
      }
      if (path === '/weak') {
        const status = Number(url.searchParams.get('status') || 503);
        finish(status, { 'x-backend': id, 'retry-after': '1' }, { backend: id, weak: status });
        return;
      }
      if (path === '/flaky') {
        const failFirst = Number(url.searchParams.get('fail') ?? 1);
        // The proxy stamps every forwarded attempt with the logical attempt
        // number, so this backend can fail deterministically *without* keeping
        // its own counter: attempt 1 fails for a fresh request, attempt 2 wins.
        // That makes the retry land as a genuine recovery rather than depending
        // on whichever backend happened to have served earlier traffic.
        const attempt = Number(req.headers['x-proxy-attempt'] || 1);
        if (attempt <= failFirst) {
          finish(Number(url.searchParams.get('status') || 503), { 'x-backend': id }, {
            backend: id, failedAttempt: attempt,
          });
          return;
        }
        finish(200, { 'x-backend': id }, { backend: id, ok: true, succeededAfter: attempt - 1 });
        return;
      }
      if (path === '/hit-and-drop') {
        const after = Number(url.searchParams.get('after') || 8);
        const body = Buffer.from('0123456789abcdefghij');
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(body.length), 'x-backend': id });
        res.write(body.subarray(0, after), () => {
          res.socket?.destroy();
        });
        return;
      }
      if (path === '/hit-and-drop-before') {
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': '64', 'x-backend': id });
        setTimeout(() => res.socket?.destroy(), 120);
        return;
      }
      if (path === '/stream') {
        res.writeHead(200, { 'content-type': 'text/plain', 'x-backend': id });
        let i = 0;
        const timer = setInterval(() => {
          res.write(`chunk ${i++} @ ${Date.now()}\n`);
          if (i >= 6) {
            clearInterval(timer);
            res.end('done\n');
          }
        }, 200);
        res.on('close', () => clearInterval(timer));
        return;
      }
      if (path === '/big') {
        const bytes = Number(url.searchParams.get('bytes') || 1_000_000);
        const body = Buffer.alloc(bytes, 0x61);
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(body.length), 'x-backend': id });
        res.end(body);
        return;
      }
      finish(404, { 'x-backend': id }, { backend: id, notFound: path });
    };

    setTimeout(route, latencyMs);
  });
  server.keepAliveTimeout = 5_000;
  return server;
}

export async function startDemo(baseConfig) {
  const port = baseConfig.port;
  const upstreams = [
    { id: 'mock-a', port: port + 1, latencyMs: 5 },
    { id: 'mock-b', port: port + 2, latencyMs: 5 },
    { id: 'mock-c', port: port + 3, latencyMs: 5 },
  ];

  for (const u of upstreams) {
    const srv = makeBackend(u);
    await new Promise((resolve) => srv.listen(u.port, '127.0.0.1', resolve));
  }

  const config = buildConfig([
    ...process.argv.slice(2).filter((a) => a !== '--demo'),
    '--upstream',
    upstreams.map((u) => `127.0.0.1:${u.port}`).join(','),
  ]);
  config.port = baseConfig.port;
  config.host = baseConfig.host;
  config.demo = true;

  const app = await startProxy(config);
  await app.listen();

  const url = `http://${config.host}:${config.port}`;
  app.logger.info('demo mode: 3 mock upstreams started');
  for (const u of upstreams) app.logger.info(`  ${u.id} → http://127.0.0.1:${u.port}`);
  app.logger.info(`debug console: ${url}/`);
  app.logger.info(`try: curl ${url}/ok  ·  ${url}/flaky?fail=1  ·  ${url}/hit-and-drop?after=4`);

  const shutdown = async () => {
    await app.close();
    for (const u of upstreams) {
      void u;
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return app;
}
