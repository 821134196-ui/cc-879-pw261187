import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { FAILURE, runAttempt, isRetryableFailure } from './delivery.js';
import { isIdempotent, filterHeaders, buildUpstreamHeaders, isoNow } from './util.js';

const DEFAULT_AGENT = new http.Agent({ keepAlive: true, maxSockets: 64 });

/**
 * The proxy engine. Handles one downstream request end to end:
 *
 *   read body → pick upstream → attempt → classify → (retry | deliver)
 *
 * Retry eligibility is decided once up front (method idempotency or an explicit
 * Idempotency-Key) and re-checked after every attempt against the *stage* the
 * attempt reached. A request that has already committed a response head or a
 * body byte is not replayable regardless of what went wrong afterwards.
 */
export class ProxyEngine {
  constructor({ config, pool, budget, traceStore, logger }) {
    this.config = config;
    this.pool = pool;
    this.budget = budget;
    this.traceStore = traceStore;
    this.logger = logger;
    this.agent = DEFAULT_AGENT;
  }

  async readBody(req) {
    const limit = this.config.retry.maxRequestBodyBytes;
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > limit) {
        const err = new Error(`request body exceeds ${limit} bytes`);
        err.statusCode = 413;
        throw err;
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async handle(req, res) {
    const requestId = req.headers['x-request-id'] || randomUUID();
    const startedAt = performance.now();

    let body;
    try {
      body = await this.readBody(req);
    } catch (err) {
      this.sendError(res, err.statusCode || 400, 'payload_too_large', err.message);
      return;
    }

    const url = new URL(req.url, 'http://proxy.local');
    const method = (req.method || 'GET').toUpperCase();
    const idempotent = isIdempotent(method);
    const hasIdempotencyKey = Boolean(req.headers['idempotency-key']);
    const replayable = idempotent ||
      (this.config.retry.retryUnsafeWithIdempotencyKey && hasIdempotencyKey);

    if (this.pool.size === 0) {
      this.sendError(res, 502, 'no_upstreams', 'The proxy has no upstreams configured.');
      return;
    }

    // SSE and other streaming responses are detected downstream from the
    // upstream's content-type (see delivery.isStreaming); they opt out of the
    // deferred commit point automatically, so no request-level hint is needed.

    const trace = this.traceStore.create({
      id: requestId,
      startedAt: isoNow(),
      method,
      url: req.url,
      path: url.pathname + url.search,
      client: req.socket.remoteAddress,
      idempotent,
      hasIdempotencyKey,
      replayable,
      requestBytes: body.length,
      requestHeaders: filterHeaders(req.headers),
      requestBodyPreview: body.length ? body.subarray(0, 2048).toString('utf8') : null,
    });

    const ctxBase = {
      agent: this.agent,
      body,
      res,
      req,
      config: this.config,
      requestId,
    };

    this.traceStore.note(trace, {
      kind: 'eligibility',
      replayable,
      reason: replayable
        ? idempotent ? 'method is idempotent' : 'Idempotency-Key present'
        : 'unsafe method without Idempotency-Key',
    });

    const tried = new Set();
    let attempts = 0;
    const maxAttempts = replayable ? this.config.retry.maxAttempts : 1;
    let lastWeakReply = null;
    let lastFailure = null;

    while (attempts < maxAttempts) {
      const upstream = this.pool.select(tried);
      if (!upstream) {
        this.traceStore.note(trace, {
          kind: 'no-upstream',
          tried: [...tried],
          reason: tried.size > 0 ? 'all upstreams already tried' : 'all upstreams at capacity or circuit-open',
        });
        break;
      }

      attempts += 1;
      tried.add(upstream.id);
      this.pool.acquire(upstream);

      const attemptStart = performance.now();
      const headers = buildUpstreamHeaders(req, `${requestId}-${attempts}`, body);
      headers['x-proxy-request-id'] = requestId;
      headers['x-proxy-attempt'] = String(attempts);
      const ctx = {
        attempt: attempts,
        path: url.pathname + url.search,
        headers,
        agent: this.agent,
        canRetry: replayable && attempts < maxAttempts,
        replayable,
        // Whether an *other* upstream is selectable right now. The current
        // attempt holds its upstream in-flight at this point, so exclude it;
        // if no other backend can take the retry, a weak status is relayed
        // rather than spending a token on a replay that could not move.
        hasAlternative: () => {
          const others = new Set(tried);
          others.add(upstream.id);
          return this.pool.hasOtherThan(others);
        },
        takeRetryToken: () => this.budget.tryTake(),
        onCommit: () => {
          this.traceStore.note(trace, { kind: 'commit', attempt: attempts, upstreamId: upstream.id });
        },
        onBudgetDenied: (status) => {
          this.traceStore.note(trace, {
            kind: 'budget-denied',
            attempt: attempts,
            upstreamId: upstream.id,
            status,
            reason: 'shared retry budget empty — relaying the weak reply instead of retrying',
            budget: this.budget.snapshot(),
          });
        },
        onWeakNotRetried: (status, why) => {
          const tail = {
            'not replayable': 'the request is not replayable (unsafe method without Idempotency-Key)',
            'last attempt': 'there is no attempt left',
            'no alternative upstream': 'no other upstream is available to take it',
          }[why] || 'it cannot be retried';
          this.traceStore.note(trace, {
            kind: 'retry-decision',
            attempt: attempts,
            retry: false,
            reason: `upstream returned retryable status ${status}, but ${tail} — relaying it`,
          });
        },
      };

      this.traceStore.note(trace, {
        kind: 'attempt-start',
        attempt: attempts,
        upstreamId: upstream.id,
        upstreamUrl: `${upstream.url.host}:${upstream.url.port || 80}`,
        headers,
      });

      let result;
      try {
        result = await runAttempt(ctxBase, upstream, ctx);
      } finally {
        this.pool.release(upstream);
      }

      result.attemptStartOffsetMs = Math.round(attemptStart - startedAt);
      this.traceStore.pushAttempt(trace, result);

      const weakReply = result.reason === FAILURE.UPSTREAM_STATUS;
      if (weakReply) {
        // Token was already spent inside runAttempt when it decided to retry.
        // Remember this reply: if every later attempt fails before any byte
        // reaches the client, this is the last real upstream answer we can
        // degrade to, rather than inventing a 502.
        this.pool.recordFailure(upstream, new Error(result.error), { weight: 1 });
        lastWeakReply = result;
        lastFailure = result;
        this.traceStore.note(trace, {
          kind: 'retry-decision',
          attempt: attempts,
          retry: true,
          reason: `upstream returned retryable status ${result.status}`,
          budget: this.budget.snapshot(),
        });
        this.logger.warn(`attempt ${attempts} ${upstream.id} weak status ${result.status}, retrying`);
        continue;
      }

      if (result.committed) {
        // Head or body already on the wire: this is the final answer, success or truncation.
        this.pool.recordSuccess(upstream);
        this.finalize(trace, result, 'delivered');
        return;
      }

      if (result.outcome === 'delivered' || !result.reason) {
        this.pool.recordSuccess(upstream);
        this.finalize(trace, result, 'delivered');
        return;
      }

      // A failure in PRE_HEADERS: invisible to the client.
      lastFailure = result;
      const retryable = isRetryableFailure(result.reason) && replayable && attempts < maxAttempts;
      this.pool.recordFailure(upstream, new Error(result.error), {
        weight: result.reason === FAILURE.CONNECTION_REFUSED ? 2 : 1,
      });

      if (result.reason === FAILURE.CLIENT_GONE) {
        this.traceStore.note(trace, {
          kind: 'retry-decision', attempt: attempts, retry: false,
          reason: 'client disconnected; nothing to deliver',
        });
        this.finalize(trace, result, 'client-gone');
        return;
      }

      if (!retryable) {
        this.traceStore.note(trace, {
          kind: 'retry-decision',
          attempt: attempts,
          retry: false,
          reason: !replayable
            ? 'request is not replayable (unsafe method without Idempotency-Key)'
            : attempts >= maxAttempts
              ? 'attempt limit reached'
              : 'failure is not retryable',
        });
        break;
      }

      // Charge the shared budget *before* starting the next attempt.
      if (!this.budget.tryTake()) {
        this.traceStore.note(trace, {
          kind: 'retry-decision',
          attempt: attempts,
          retry: false,
          reason: 'shared retry budget empty',
          budget: this.budget.snapshot(),
        });
        break;
      }

      this.traceStore.note(trace, {
        kind: 'retry-decision',
        attempt: attempts,
        retry: true,
        reason: `${result.reason} before any byte reached the client`,
        budget: this.budget.snapshot(),
      });
      this.logger.warn(`attempt ${attempts} ${upstream.id} failed (${result.reason}) in ${result.stage}, retrying`);
    }

    // Exhausted without a delivered response.
    if (lastWeakReply) {
      this.relayWeakReply(res, lastWeakReply, requestId);
      this.finalize(trace, { ...lastWeakReply, relayedWeak: true }, 'gave-up-weak');
      return;
    }

    const allOpen = this.pool.snapshot().every((u) => u.state === 'open');
    const status = allOpen ? 503 : 502;
    this.traceStore.note(trace, {
      kind: 'give-up',
      attempts,
      lastFailure: lastFailure?.reason || null,
      upstreams: this.pool.snapshot(),
    });
    this.sendError(res, status, lastFailure?.reason || 'upstream_failed',
      lastFailure ? lastFailure.error : 'No upstream attempt succeeded.');
    this.finalize(trace, lastFailure || {}, 'gave-up');
  }

  relayWeakReply(res, attempt, requestId) {
    if (res.headersSent || res.writableEnded || res.destroyed) return;
    // The weak reply's body was drained and discarded when we chose to retry,
    // so synthesize a small body and drop the upstream's framing headers. Copying
    // an upstream content-length here would promise bytes that never arrive.
    const body = Buffer.from(JSON.stringify({
      error: 'upstream_status',
      message: `upstream ${attempt.upstreamId} responded ${attempt.status} on attempt ${attempt.attempt}`,
      traceId: requestId,
    }));
    const headers = {};
    for (const [k, v] of Object.entries(attempt.headers || {})) {
      const lower = k.toLowerCase();
      if (lower === 'content-length' || lower === 'transfer-encoding' ||
          lower === 'connection' || lower === 'keep-alive') continue;
      headers[k] = v;
    }
    const plain = {};
    for (const [k, v] of Object.entries(headers)) plain[k.toLowerCase()] = v;
    delete plain['content-type'];
    plain['content-type'] = 'application/json';
    plain['content-length'] = String(body.length);
    plain['x-proxy-upstream'] = attempt.upstreamId;
    plain['x-proxy-attempt'] = String(attempt.attempt);
    plain['x-proxy-trace-id'] = requestId;
    plain['x-proxy-degraded'] = 'weak-reply-relayed';
    res.writeHead(attempt.status || 502, plain);
    res.end(body);
  }

  sendError(res, status, code, message) {
    if (res.headersSent || res.writableEnded || res.destroyed) {
      if (!res.destroyed) res.destroy();
      return;
    }
    const payload = Buffer.from(JSON.stringify({ error: code, message }));
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': String(payload.length),
      'x-proxy-error': code,
    });
    res.end(payload);
  }

  finalize(trace, attempt, outcome) {
    const upstreams = this.pool.snapshot();
    const last = trace.attempts.at(-1) || {};
    // "committed + a failure reason + a partial body" means the client got a
    // truncated stream; that is its own outcome, not a plain success.
    const truncated = outcome === 'delivered' && Boolean(last.committed) &&
      Boolean(last.reason) && last.stage === 'body-partial';
    // A weak (retryable) status that we forwarded unchanged because no retry was
    // possible (lone upstream) or affordable. Normatively delivered, but the
    // debug page should say it was a degraded outcome, not a clean success.
    const weakRelayed = outcome === 'delivered' && !truncated &&
      this.config.retry.retryableStatuses.includes(last.status) && !last.reason;
    const summary = {
      outcome: truncated ? 'truncated' : weakRelayed ? 'weak-relayed' : outcome,
      attempts: trace.attempts.length,
      status: attempt.status ?? last.status ?? null,
      finalUpstream: attempt.upstreamId ?? last.upstreamId ?? null,
      stage: attempt.stage ?? last.stage ?? null,
      reason: attempt.reason ?? null,
      error: attempt.error ?? null,
      committed: Boolean(attempt.committed ?? last.committed),
      truncated,
      bytesFromUpstream: attempt.bytesFromUpstream ?? last.bytesFromUpstream ?? 0,
      bytesToClient: attempt.bytesToClient ?? last.bytesToClient ?? 0,
      budget: this.budget.snapshot(),
      upstreams,
    };
    this.traceStore.finish(trace, summary);
    this.logger.info(
      `${trace.method} ${trace.path} → ${outcome} (${summary.attempts} attempt${summary.attempts === 1 ? '' : 's'}, ${summary.status ?? '-'})`,
    );
  }
}
