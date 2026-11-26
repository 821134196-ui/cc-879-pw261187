import http from 'node:http';
import { performance } from 'node:perf_hooks';

/**
 * Pointwise delivery.
 *
 * One upstream attempt is a small state machine over three delivery stages:
 *
 *   PRE_HEADERS        nothing has been written to the client. A failure here is
 *                      invisible to the client and therefore replayable.
 *   HEADERS_COMMITTED  the response head (status + headers) is on the wire. The
 *                      reply is pinned to that upstream; we can only finish or
 *                      truncate it.
 *   BODY_PARTIAL       at least one body byte reached the client. Replaying would
 *                      splice two different bodies together, so this is never
 *                      retried; the client socket is destroyed so the truncation
 *                      is visible rather than looking like a short, whole reply.
 *
 * The commit point is intentionally *held* for replayable requests: headers are
 * buffered until either `commitAfterBytes` body bytes or `commitAfterMs` passes.
 * An upstream that dies inside that window is still in PRE_HEADERS and can be
 * retried without the client ever seeing a partial reply. Streaming responses
 * (`text/event-stream`) opt out of the hold so SSE latency is unaffected.
 *
 * Two distinct timeouts drive the failure taxonomy:
 *   connect timeout     TCP never established
 *   first-hop timeout   socket opened but the response head never arrived
 */

export const STAGE = Object.freeze({
  PRE_HEADERS: 'pre-headers',
  HEADERS_COMMITTED: 'headers-committed',
  BODY_PARTIAL: 'body-partial',
});

export const FAILURE = Object.freeze({
  CONNECT_TIMEOUT: 'connect_timeout',
  FIRST_HOP_TIMEOUT: 'first_hop_timeout',
  CONNECTION_REFUSED: 'connection_refused',
  CONNECTION_RESET: 'connection_reset',
  STREAM_ABORTED: 'stream_aborted',
  UPSTREAM_STATUS: 'upstream_status',
  CLIENT_GONE: 'client_gone',
});

const REFUSED_CODES = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'ENOTFOUND']);
const RESET_CODES = new Set(['ECONNRESET', 'EPIPE', 'ECONNABORTED']);

function classifyError(err) {
  const code = err?.code || '';
  if (err?.timeoutKind === 'connect') return FAILURE.CONNECT_TIMEOUT;
  if (err?.timeoutKind === 'first-hop') return FAILURE.FIRST_HOP_TIMEOUT;
  if (REFUSED_CODES.has(code)) return FAILURE.CONNECTION_REFUSED;
  if (RESET_CODES.has(code)) return FAILURE.CONNECTION_RESET;
  return FAILURE.STREAM_ABORTED;
}

/** Failures that justify trying another upstream (everything except client abort). */
export function isRetryableFailure(reason) {
  return reason !== FAILURE.CLIENT_GONE;
}

const HOP_BY_HOP_RESPONSE = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function downstreamHeaders(upstreamHeaders, { requestId, upstreamId, attempt, deferred }) {
  const out = {};
  for (const [key, value] of Object.entries(upstreamHeaders)) {
    if (!HOP_BY_HOP_RESPONSE.has(key.toLowerCase())) out[key] = value;
  }
  out['x-proxy-upstream'] = upstreamId;
  out['x-proxy-attempt'] = String(attempt);
  out['x-proxy-trace-id'] = requestId;
  if (deferred) out['x-proxy-commit'] = 'deferred';
  return out;
}

const isStreaming = (headers) =>
  String(headers['content-type'] || '').toLowerCase().startsWith('text/event-stream');
const isBodyless = (status, method) => status === 204 || status === 304 || method === 'HEAD';

/**
 * Run one upstream attempt.
 *
 * @param {object} args
 * @param {import('node:http').ClientRequest} args.req   the downstream request
 * @param {import('node:http').ServerResponse} args.res  the downstream response
 * @param {Buffer} args.body                             fully-buffered request body
 * @param {object} args.config
 * @param {string} args.requestId
 * @param {object} args.upstream                         pool entry
 * @param {object} args.ctx  { attempt, path, headers, agent, canRetry,
 *                             takeRetryToken(), onCommit() }
 * @returns {Promise<AttemptResult>}
 */
export function runAttempt({ req, res, body, config, requestId }, upstream, ctx) {
  const cfg = config.retry;

  return new Promise((resolve) => {
    const t0 = performance.now();
    let settled = false;
    let stage = STAGE.PRE_HEADERS;
    let committed = false;
    let status = null;
    let upstreamHeaders = null;
    let ttfbMs = null;
    let bytesFromUpstream = 0;
    let bytesToClient = 0;
    let reason = null;
    let errorMessage = null;
    let deferredCommit = false;

    // Held-commit buffer (PRE_HEADERS only).
    const held = [];
    let heldLen = 0;

    // Post-commit write queue.
    const queue = [];
    let draining = false;
    let drainRegistered = false;
    let upstreamRes = null;
    let upstreamPaused = false;

    let connectTimer = null;
    let firstHopTimer = null;
    let commitTimer = null;

    const upReq = http.request({
      host: upstream.url.host,
      port: upstream.url.port || 80,
      method: req.method,
      path: upstream.url.basePath + ctx.path,
      headers: ctx.headers,
      agent: ctx.agent,
    });
    upReq.setNoDelay?.(true);

    const clearTimers = () => {
      for (const t of [connectTimer, firstHopTimer, commitTimer]) {
        if (t) clearTimeout(t);
      }
      connectTimer = firstHopTimer = commitTimer = null;
    };

    const result = (extra = {}) => ({
      upstreamId: upstream.id,
      upstreamUrl: `${upstream.url.host}:${upstream.url.port || 80}`,
      attempt: ctx.attempt,
      stage,
      committed,
      status,
      headers: upstreamHeaders,
      ttfbMs,
      startedAt: t0,
      durationMs: Math.round(performance.now() - t0),
      bytesFromUpstream,
      bytesToClient,
      reason,
      error: errorMessage,
      ...extra,
    });

    const settle = (extra) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve(result(extra));
    };

    const fail = (r, err, extra = {}) => {
      if (settled) return;
      reason = r;
      errorMessage = err?.message ? `${err.code ? `${err.code}: ` : ''}${err.message}` : String(err || r);
      // Anything already on the wire cannot be replayed; make the truncation visible.
      if (committed) truncateClient();
      settle(extra);
    };

    const truncateClient = () => {
      if (!res.writableEnded && !res.destroyed) res.destroy();
    };

    // ---- request body -----------------------------------------------------
    upReq.on('error', (err) => {
      if (settled) return;
      fail(classifyError(err), err);
    });

    if (cfg.connectTimeoutMs > 0) {
      connectTimer = setTimeout(() => {
        const err = new Error(`upstream connect timed out after ${cfg.connectTimeoutMs}ms`);
        err.timeoutKind = 'connect';
        upReq.destroy(err);
      }, cfg.connectTimeoutMs);
      connectTimer.unref?.();
      upReq.on('socket', (socket) => {
        const connected = () => {
          if (connectTimer) {
            clearTimeout(connectTimer);
            connectTimer = null;
          }
        };
        if (socket.connecting) socket.once('connect', connected);
        else connected();
      });
    }

    if (cfg.firstHopTimeoutMs > 0) {
      firstHopTimer = setTimeout(() => {
        const err = new Error(`first hop timed out after ${cfg.firstHopTimeoutMs}ms`);
        err.timeoutKind = 'first-hop';
        upReq.destroy(err);
      }, cfg.firstHopTimeoutMs);
      firstHopTimer.unref?.();
    }

    // ---- response head ----------------------------------------------------
    upReq.on('response', (upRes) => {
      if (settled) return;
      clearTimers();
      upstreamRes = upRes;
      ttfbMs = Math.round(performance.now() - t0);
      status = upRes.statusCode;
      upstreamHeaders = upRes.headers;

      const weak = cfg.retryableStatuses.includes(status);
      if (weak && ctx.canRetry && ctx.hasAlternative?.()) {
        // Ask the shared budget *now*, before consuming the body: granted →
        // discard this response and retry; denied → relay it as-is. Only retry
        // when an *other* upstream is actually selectable, so a token is never
        // spent on a replay that could not go anywhere.
        if (ctx.takeRetryToken()) {
          reason = FAILURE.UPSTREAM_STATUS;
          errorMessage = `upstream responded ${status}`;
          stage = STAGE.PRE_HEADERS;
          upRes.resume(); // drain and ignore
          settle({ retryTokenSpent: true, retryPrompt: true });
          return;
        }
        // No budget left: fall through and deliver the weak reply unchanged.
        ctx.onBudgetDenied?.(status);
      } else if (weak) {
        // A retryable status with no retry coming: this was the last attempt, the
        // request is not replayable, or no other upstream is available.
        const why = !ctx.replayable ? 'not replayable'
          : !ctx.canRetry ? 'last attempt'
            : 'no alternative upstream';
        ctx.onWeakNotRetried?.(status, why);
      }

      const streaming = isStreaming(upstreamHeaders);
      deferredCommit = ctx.canRetry && !weak && !streaming && !isBodyless(status, req.method);
      const hold = !weak && deferredCommit;

      if (isBodyless(status, req.method) || !hold) {
        commitHead();
        if (isBodyless(status, req.method)) {
          if (upRes.complete) {
            finishDelivered();
          } else {
            // Drain any body the upstream still sends (HEAD/204/304 should have
            // none, but a misbehaving upstream might) and end cleanly.
            upRes.resume();
            upRes.on('end', () => {
              if (settled) return;
              if (!upRes.complete) {
                fail(FAILURE.STREAM_ABORTED, new Error('upstream closed before bodyless response completed'));
                return;
              }
              finishDelivered();
            });
            onUpstreamErrorHandler(upRes);
          }
        } else {
          streamBody();
        }
        return;
      }

      // Hold the commit point until the window closes or the response ends.
      commitTimer = setTimeout(() => {
        if (stage === STAGE.PRE_HEADERS && !settled) {
          commitHead();
          flushHeld();
        }
      }, cfg.commitAfterMs);
      commitTimer.unref?.();

      upRes.on('data', (chunk) => {
        if (settled) return;
        bytesFromUpstream += chunk.length;
        if (committed) {
          push(chunk);
          return;
        }
        held.push(chunk);
        heldLen += chunk.length;
        if (heldLen >= cfg.commitAfterBytes) {
          commitHead();
          flushHeld();
        }
      });
      upRes.on('end', () => {
        if (settled) return;
        if (!upRes.complete) {
          fail(FAILURE.STREAM_ABORTED, new Error('upstream closed before body completed'));
          return;
        }
        if (stage === STAGE.PRE_HEADERS) {
          commitHead();
          flushHeld();
        }
        finishDelivered();
      });
      onUpstreamErrorHandler(upRes);
    });

    function onUpstreamError(err) {
      if (settled) return;
      fail(committed ? FAILURE.STREAM_ABORTED : classifyError(err), err);
    }

    function onUpstreamErrorHandler(upRes) {
      upRes.on('aborted', () => {
        if (settled) return;
        fail(FAILURE.STREAM_ABORTED, new Error('upstream aborted the response'));
      });
      upRes.on('error', (err) => {
        if (settled) return;
        fail(committed ? FAILURE.STREAM_ABORTED : classifyError(err), err);
      });
      upRes.on('close', () => {
        if (settled || upRes.complete) return;
        fail(FAILURE.STREAM_ABORTED, new Error('upstream closed mid-response'));
      });
    }

    function streamBody() {
      upstreamRes.on('data', (chunk) => {
        if (settled) return;
        bytesFromUpstream += chunk.length;
        push(chunk);
      });
      upstreamRes.on('end', () => {
        if (settled) return;
        if (!upstreamRes.complete) {
          fail(FAILURE.STREAM_ABORTED, new Error('upstream closed before body completed'));
          return;
        }
        finishDelivered();
      });
      onUpstreamErrorHandler(upstreamRes);
    }

    function finishDelivered() {
      if (settled) return;
      if (res.writableEnded || res.destroyed) {
        settle({ outcome: 'delivered' });
        return;
      }
      waitQueue(() => {
        if (res.writableEnded || res.destroyed) {
          settle({ outcome: 'delivered' });
          return;
        }
        res.end(() => settle({ outcome: 'delivered' }));
      });
    }

    // ---- commit & write path ---------------------------------------------
    function commitHead() {
      if (committed || settled || res.destroyed || res.writableEnded) return;
      committed = true;
      if (commitTimer) {
        clearTimeout(commitTimer);
        commitTimer = null;
      }
      stage = STAGE.HEADERS_COMMITTED;
      res.writeHead(status, downstreamHeaders(upstreamHeaders || {}, {
        requestId,
        upstreamId: upstream.id,
        attempt: ctx.attempt,
        deferred: deferredCommit,
      }));
      ctx.onCommit?.();
    }

    function flushHeld() {
      const chunks = held.splice(0, held.length);
      heldLen = 0;
      for (const c of chunks) push(c);
    }

    /** Write a chunk to the client; pause upstream when the client falls behind. */
    function push(chunk) {
      if (!chunk || chunk.length === 0 || settled) return;
      queue.push(chunk);
      drainQueue();
    }

    function drainQueue() {
      if (settled) return;
      while (!draining && queue.length > 0) {
        const item = queue.shift();
        if (typeof item === 'object' && item && item.__idle) {
          item.__idle();
          continue;
        }
        const ok = res.write(item);
        bytesToClient += item.length;
        if (stage === STAGE.HEADERS_COMMITTED) stage = STAGE.BODY_PARTIAL;
        if (!ok) {
          draining = true;
          if (upstreamRes && !upstreamPaused) {
            upstreamPaused = true;
            upstreamRes.pause();
          }
        }
      }
      if (draining && !drainRegistered) {
        drainRegistered = true;
        res.once('drain', () => {
          drainRegistered = false;
          draining = false;
          if (upstreamPaused && upstreamRes) {
            upstreamPaused = false;
            upstreamRes.resume();
          }
          drainQueue();
        });
      }
    }

    /**
     * Run `cb` once every queued chunk has been written. The callback is queued
     * as a sentinel so it keeps its ordering behind any pending bytes, and
     * drainQueue() is always called so it cannot be stranded while the socket is
     * waiting for a 'drain' it will never receive.
     */
    function waitQueue(cb) {
      if (settled) return;
      queue.push({ __idle: cb });
      drainQueue();
    }

    // Client vanished mid-flight.
    res.on('close', () => {
      if (settled || res.writableEnded) return;
      const err = new Error('client closed the connection');
      fail(FAILURE.CLIENT_GONE, err);
    });

    if (body && body.length > 0) upReq.write(body);
    upReq.end();
  });
}
