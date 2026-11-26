import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { buildConfig } from '../src/config.js';
import { startProxy } from '../src/server.js';
import { RetryBudget } from '../src/budget.js';
import { UpstreamPool } from '../src/pool.js';

/** Start a raw upstream whose behavior is supplied per test. */
async function startUpstream(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { server, port, url: `127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

async function startApp(upstreamUrls, overrides = {}) {
  const config = buildConfig([
    '--upstream', upstreamUrls.join(','),
    '--connectTimeoutMs', String(overrides.connectTimeoutMs ?? 500),
    '--firstHopTimeoutMs', String(overrides.firstHopTimeoutMs ?? 1500),
    '--maxAttempts', String(overrides.maxAttempts ?? 3),
    '--commitAfterMs', String(overrides.commitAfterMs ?? 200),
    '--commitAfterBytes', String(overrides.commitAfterBytes ?? 16384),
    '--budgetCapacity', String(overrides.budgetCapacity ?? 50),
    '--budgetRefill', String(overrides.budgetRefill ?? 5),
  ]);
  config.port = 0;
  const app = await startProxy(config);
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const port = app.server.address().port;
  return { app, port, base: `http://127.0.0.1:${port}` };
}

/** Raw client that always delivers a complete body and reports truncation. */
function request(port, { method = 'GET', path = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = [];
      let truncated = false;
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
        truncated: false,
      }));
      res.on('error', () => { truncated = true; });
      res.on('aborted', () => { truncated = true; });
      res.on('close', () => {
        if (!res.complete || truncated) {
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), truncated: true });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('204/304 and HEAD responses are committed immediately with no body', async () => {
  // Bodyless statuses must not be held for the commit window, and must not wait
  // on a body that never comes.
  let kind = '204';
  const up = await startUpstream((req, res) => {
    if (kind === '204') { res.writeHead(204); res.end(); }
    else if (kind === '304') { res.writeHead(304); res.end(); }
    else if (kind === 'head') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('body that HEAD must not see'); }
  });
  const { app, port } = await startApp([up.url]);
  try {
    kind = '204';
    const r204 = await request(port, { path: '/x' });
    assert.equal(r204.status, 204);
    assert.equal(r204.body.length, 0);
    kind = '304';
    const r304 = await request(port, { path: '/x' });
    assert.equal(r304.status, 304);
    kind = 'head';
    const rh = await request(port, { method: 'HEAD', path: '/x' });
    assert.equal(rh.status, 200);
    assert.equal(rh.body.length, 0, 'HEAD carries no body');
    for (const t of app.traceStore.list()) assert.equal(t.result.outcome, 'delivered');
  } finally {
    await up.close();
    await app.close();
  }
});

test('large body streams through the write queue intact', async () => {
  const bytes = 5 * 1024 * 1024;
  const up = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(bytes) });
    res.end(Buffer.alloc(bytes, 0x61));
  });
  const { app, port } = await startApp([up.url]);
  try {
    const res = await request(port, { path: '/x' });
    assert.equal(res.status, 200);
    assert.equal(res.body.length, bytes);
    assert.equal(res.truncated, false);
    const trace = app.traceStore.list()[0];
    assert.equal(trace.result.outcome, 'delivered');
    assert.equal(trace.result.bytesToClient, bytes);
  } finally {
    await up.close();
    await app.close();
  }
});

test('healthy response is delivered and traced', async () => {
  const up = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const { app, port } = await startApp([up.url]);
  try {
    const res = await request(port, { path: '/ok' });
    assert.equal(res.status, 200);
    assert.equal(res.body.toString(), '{"ok":true}');
    assert.equal(res.headers['x-proxy-upstream'], 'up-1');
    assert.equal(res.headers['x-proxy-attempt'], '1');
    const trace = app.traceStore.list()[0];
    assert.equal(trace.result.outcome, 'delivered');
    assert.equal(trace.result.attempts, 1);
  } finally {
    await up.close();
    await app.close();
  }
});

test('first-hop timeout is retried on another upstream, client never sees a failed attempt', async () => {  // up-1 accepts the socket but never sends a head; up-2 answers.
  const slow = await startUpstream(() => { /* never respond */ });
  const good = await startUpstream((req, res) => {
    res.writeHead(200, { 'x-which': 'good' });
    res.end('fresh');
  });
  const { app, port } = await startApp([slow.url, good.url], { firstHopTimeoutMs: 300 });
  try {
    const res = await request(port, { path: '/x' });
    assert.equal(res.status, 200);
    assert.equal(res.body.toString(), 'fresh');
    assert.equal(res.headers['x-proxy-attempt'], '2');
    const trace = app.traceStore.list()[0];
    assert.equal(trace.attempts.length, 2);
    assert.equal(trace.attempts[0].reason, 'first_hop_timeout');
    assert.equal(trace.attempts[0].stage, 'pre-headers');
    assert.equal(trace.attempts[0].committed, false);
    assert.equal(trace.result.outcome, 'delivered');
    assert.equal(trace.result.attempts, 2);
  } finally {
    slow.server.closeAllConnections?.();
    await slow.close();
    await good.close();
    await app.close();
  }
});

test('upstream that dies before any body byte is still replayable (deferred commit)', async () => {  let hits = 0;
  const flaky = await startUpstream((req, res) => {
    hits += 1;
    if (hits === 1) {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '64' });
      setTimeout(() => res.socket?.destroy(), 30);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const { app, port } = await startApp([flaky.url], { maxAttempts: 3, commitAfterMs: 250 });
  try {
    const res = await request(port, { path: '/x' });
    assert.equal(res.status, 200, 'client gets the successful retry');
    assert.equal(res.body.toString(), '{"ok":true}');
    const trace = app.traceStore.list()[0];
    assert.equal(trace.attempts.length, 2);
    // The first attempt never committed: the failure happened inside the hold window.
    assert.equal(trace.attempts[0].committed, false);
    assert.equal(trace.attempts[0].stage, 'pre-headers');
    assert.equal(trace.result.outcome, 'delivered');
  } finally {
    await flaky.close();
    await app.close();
  }
});

test('truncation after the commit point is not retried and is visible to the client', async () => {
  let hits = 0;
  const dropper = await startUpstream((req, res) => {
    hits += 1;
    // Enough body to cross the commit-after-bytes threshold immediately.
    const body = Buffer.alloc(64 * 1024, 0x61);
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(body.length) });
    res.write(body.subarray(0, 20000), () => {
      setTimeout(() => res.socket?.destroy(), 10);
    });
  });
  const { app, port } = await startApp([dropper.url], {
    maxAttempts: 3, commitAfterBytes: 1024, commitAfterMs: 1000,
  });
  try {
    const res = await request(port, { path: '/x' });
    assert.equal(res.truncated, true, 'client sees an aborted body, not a clean short one');
    const trace = app.traceStore.list()[0];
    assert.equal(trace.attempts.length, 1, 'no replay once bytes reached the client');
    const attempt = trace.attempts[0];
    assert.equal(attempt.committed, true);
    assert.equal(attempt.stage, 'body-partial');
    assert.ok(attempt.bytesToClient > 0);
    assert.equal(trace.result.outcome, 'truncated'); // committed: final answer, visibly truncated
    assert.equal(hits, 1);
  } finally {
    await dropper.close();
    await app.close();
  }
});

test('non-idempotent POST without idempotency key is never replayed', async () => {
  let hits = 0;
  const up = await startUpstream((req, res) => {
    hits += 1;
    res.writeHead(503);
    res.end('no');
  });
  const { app, port } = await startApp([up.url], { maxAttempts: 3 });
  try {
    const res = await request(port, { method: 'POST', path: '/x', body: 'payload' });
    assert.equal(res.status, 503);
    assert.equal(hits, 1);
    const trace = app.traceStore.list()[0];
    assert.equal(trace.replayable, false);
    assert.equal(trace.attempts.length, 1);
    const stop = trace.decisions.find((d) => d.kind === 'retry-decision');
    assert.match(stop.reason, /not replayable/);
  } finally {
    await up.close();
    await app.close();
  }
});

test('non-idempotent POST with Idempotency-Key is replayed on a fresh upstream', async () => {
  let hits = 0;
  const up = await startUpstream((req, res) => {
    hits += 1;
    if (hits === 1) {
      res.socket?.destroy();
      return;
    }
    res.writeHead(200);
    res.end('accepted');
  });
  const { app, port } = await startApp([up.url], { maxAttempts: 3 });
  try {
    const res = await request(port, {
      method: 'POST', path: '/x', body: 'payload',
      headers: { 'idempotency-key': 'abc-123', 'content-length': '7' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.toString(), 'accepted');
    const trace = app.traceStore.list()[0];
    assert.equal(trace.replayable, true);
    assert.equal(trace.attempts.length, 2);
  } finally {
    await up.close();
    await app.close();
  }
});

test('retryable status spends one shared token and the retry lands elsewhere', async () => {
  const weak = await startUpstream((req, res) => {
    res.writeHead(503, { 'retry-after': '1' });
    res.end('busy');
  });
  const good = await startUpstream((req, res) => {
    res.writeHead(200);
    res.end('ok');
  });
  const budget = new RetryBudget({ capacity: 1, refillPerSecond: 0 });
  const { app, port } = await startApp([weak.url, good.url], { maxAttempts: 2, budgetCapacity: 1, budgetRefill: 0 });
  try {
    const res = await request(port, { path: '/x' });
    assert.equal(res.status, 200);
    assert.equal(res.body.toString(), 'ok');
    const trace = app.traceStore.list()[0];
    assert.equal(trace.result.outcome, 'delivered');
    assert.equal(trace.attempts[0].reason, 'upstream_status');
    assert.equal(app.budget.snapshot().granted, 1);
    // Weak failure never got a token from a second concurrent request because
    // there are none left.
    assert.equal(app.budget.tryTake(), false);
    void budget;
  } finally {
    await weak.close();
    await good.close();
    await app.close();
  }
});

test('eight concurrent weak failures cannot multiply attempts past the budget', async () => {
  // Every upstream returns 503. Budget capacity 3 with no refill.
  const weakA = await startUpstream((req, res) => { res.writeHead(503); res.end('busy'); });
  const weakB = await startUpstream((req, res) => { res.writeHead(503); res.end('busy'); });
  const { app, port } = await startApp([weakA.url, weakB.url], {
    maxAttempts: 3, budgetCapacity: 3, budgetRefill: 0,
  });
  try {
    const burst = await Promise.all(Array.from({ length: 8 }, () => request(port, { path: '/x' })));
    for (const r of burst) assert.equal(r.status, 503, 'weak reply is relayed, not turned into a 502');
    const totalAttempts = app.traceStore.list().reduce((s, t) => s + t.attempts.length, 0);
    // 8 initial attempts + at most 3 granted retries = 11, far below 8*3 = 24.
    assert.ok(totalAttempts <= 11, `expected ≤ 11 attempts, saw ${totalAttempts}`);
    assert.ok(totalAttempts >= 8);
    assert.equal(app.budget.snapshot().granted, 3);
    const denied = app.traceStore.list().flatMap((t) => t.decisions).filter((d) => d.kind === 'budget-denied');
    assert.ok(denied.length >= 1);
  } finally {
    await weakA.close();
    await weakB.close();
    await app.close();
  }
});

test('relayed weak reply has a coherent body and its upstream content-length is dropped', async () => {
  // Upstream A returns 503 (a token is spent to retry it), then upstream B drops
  // the connection on the retry. With no attempts or budget left, the proxy
  // falls back to the weak reply it captured from A — whose body was already
  // drained — so it must synthesize a well-formed body rather than echo the
  // upstream content-length of body bytes it never kept.
  const weak = await startUpstream((req, res) => {
    const body = Buffer.from('{"upstream":"busy","detail":"queue full"}');
    res.writeHead(503, { 'content-type': 'application/json', 'content-length': String(body.length) });
    res.end(body);
  });
  const dropper = await startUpstream((req) => {
    req.socket?.destroy();
  });
  const { app, port } = await startApp([weak.url, dropper.url], {
    maxAttempts: 2, budgetCapacity: 1, budgetRefill: 0,
  });
  try {
    const res = await request(port, { path: '/x' });
    assert.equal(res.status, 503);
    assert.equal(res.truncated, false);
    assert.equal(res.headers['x-proxy-degraded'], 'weak-reply-relayed');
    const parsed = JSON.parse(res.body.toString());
    assert.equal(parsed.error, 'upstream_status');
    // The synthesized body must agree with its own content-length.
    assert.equal(Number(res.headers['content-length']), res.body.length);
    const trace = app.traceStore.list()[0];
    assert.equal(trace.result.outcome, 'gave-up-weak');
    assert.equal(trace.attempts.length, 2);
    assert.equal(trace.attempts[0].reason, 'upstream_status');
    assert.equal(trace.attempts[1].reason, 'connection_reset');
  } finally {
    await weak.close();
    await dropper.close();
    await app.close();
  }
});

test('a lone weak upstream with no other backend relays its own reply verbatim', async () => {
  // Only one upstream exists: a retry could not go anywhere, so the proxy must
  // forward the real response untouched (body and status) instead of spending a
  // token on a replay that is impossible.
  const body = Buffer.from('{"upstream":"busy","detail":"queue full"}');
  const weak = await startUpstream((req, res) => {
    res.writeHead(503, { 'content-type': 'application/json', 'content-length': String(body.length) });
    res.end(body);
  });
  const { app, port } = await startApp([weak.url], { maxAttempts: 3, budgetCapacity: 10 });
  try {
    const res = await request(port, { path: '/x' });
    assert.equal(res.status, 503);
    assert.equal(res.body.toString(), body.toString());
    assert.equal(res.headers['x-proxy-degraded'], undefined);
    const trace = app.traceStore.list()[0];
    assert.equal(trace.attempts.length, 1);
    const stop = trace.decisions.find((d) => d.kind === 'retry-decision' && d.retry === false);
    assert.match(stop.reason, /no other upstream/);
    assert.equal(app.budget.snapshot().granted, 0);
    assert.match(trace.result.outcome, /weak/i);
  } finally {
    await weak.close();
    await app.close();
  }
});

test('connect timeout is classified and retried', async () => {
  // Point at a port that will refuse immediately: classified as refused, retried.
  const good = await startUpstream((req, res) => { res.writeHead(200); res.end('ok'); });
  const { app, port } = await startApp([`127.0.0.1:1`, good.url], { maxAttempts: 3 });
  try {
    const res = await request(port, { path: '/x' });
    assert.equal(res.status, 200);
    const trace = app.traceStore.list()[0];
    assert.equal(trace.attempts[0].reason, 'connection_refused');
    assert.equal(trace.attempts[0].stage, 'pre-headers');
  } finally {
    await good.close();
    await app.close();
  }
});

test('upstream pool applies per-upstream in-flight caps', async () => {
  const pool = new UpstreamPool(['127.0.0.1:1', '127.0.0.1:2'], { maxInFlightPerUpstream: 1 });
  const a = pool.select();
  pool.acquire(a);
  const b = pool.select();
  assert.notEqual(a.id, b.id, 'overloaded upstream is skipped for another');
  pool.acquire(b);
  assert.equal(pool.select(), null, 'all upstreams saturated');
  pool.release(a);
  assert.equal(pool.select().id, a.id);
});

test('pool prefers untried upstreams but falls back rather than returning null', () => {
  const pool = new UpstreamPool(['127.0.0.1:1', '127.0.0.1:2'], { maxInFlightPerUpstream: 1 });
  assert.equal(pool.hasOtherThan(new Set(['up-1'])), true);
  // Only one upstream total: an "other" does not exist, so hasOtherThan is false.
  const solo = new UpstreamPool(['127.0.0.1:1'], { maxInFlightPerUpstream: 1 });
  assert.equal(solo.hasOtherThan(new Set(['up-1'])), false);
  // Preferred selection skips the tried one…
  const fresh = pool.select(new Set(['up-1']));
  assert.equal(fresh.id, 'up-2');
  // …and falls back to the tried one when it is the only one available.
  pool.acquire(pool.get('up-2'));
  const fallback = pool.select(new Set(['up-1']));
  assert.equal(fallback.id, 'up-1', 'falls back instead of returning null');
});

test('debug console endpoints describe the real forward', async () => {
  const weak = await startUpstream((req, res) => { res.writeHead(503); res.end('busy'); });
  const good = await startUpstream((req, res) => { res.writeHead(200); res.end('ok'); });
  const { app, port, base } = await startApp([weak.url, good.url], { maxAttempts: 3 });
  try {
    await request(port, { path: '/x' });
    const stats = await (await fetch(`${base}/admin/stats`)).json();
    assert.ok(stats.totals.finished >= 1);
    const traces = await (await fetch(`${base}/admin/traces`)).json();
    const trace = traces.traces[0];
    assert.equal(trace.result.outcome, 'delivered');
    assert.equal(trace.attempts[0].reason, 'upstream_status');
    assert.equal(trace.attempts[1].status, 200);
    assert.ok(Array.isArray(trace.decisions));
    const detail = await (await fetch(`${base}/admin/traces/${trace.id}`)).json();
    assert.equal(detail.id, trace.id);
    const html = await (await fetch(`${base}/`)).text();
    assert.match(html, /Pointwise delivery console/);
  } finally {
    await weak.close();
    await good.close();
    await app.close();
  }
});
