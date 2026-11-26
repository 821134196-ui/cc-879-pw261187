# Local reverse proxy — pointwise delivery

A local reverse proxy that treats a forwarded request as *pointwise* rather than
all-or-nothing. Retry safety is decided by **how far a response has been
delivered**, not just by the HTTP method. A single shared retry budget bounds
retries across concurrent requests so a weak backend cannot be crushed under a
storm of retries. A live debug console shows exactly which upstreams a real
forward passed through and how it ended.

No runtime dependencies — Node's standard library only.

## Run the demo

```bash
npm run demo
# proxy          → http://127.0.0.1:8080
# debug console  → http://127.0.0.1:8080/
# mock upstreams → :8081, :8082, :8083
```

The demo starts three mock backends with scriptable failure modes. Open the
console and hit **Send once** / **Concurrent ×8 (weak)**, or curl the proxy:

```bash
curl -i http://127.0.0.1:8080/ok
curl -i "http://127.0.0.1:8080/flaky?fail=1"            # first attempt 503, retried
curl -i "http://127.0.0.1:8080/hit-and-drop-before"     # dies before the body
curl -i "http://127.0.0.1:8080/hit-and-drop?after=6"    # dies mid-body (truncated)
curl -i -X POST -H 'idempotency-key: k1' -d hi http://127.0.0.1:8080/echo
```

## Run against your own upstreams

```bash
node src/main.js --upstream 127.0.0.1:9000,127.0.0.1:9001 --port 8080
```

Configuration comes from flags or environment; see `src/config.js` for the full
list. Key knobs:

| Flag (env) | Default | Meaning |
|---|---|---|
| `--maxAttempts` (`PROXY_MAX_ATTEMPTS`) | 3 | total attempts per request |
| `--connectTimeoutMs` (`PROXY_CONNECT_TIMEOUT_MS`) | 1000 | TCP/TLS never established |
| `--firstHopTimeoutMs` (`PROXY_FIRST_HOP_TIMEOUT_MS`) | 3000 | socket open, no response head |
| `--commitAfterMs` (`PROXY_COMMIT_AFTER_MS`) | 200 | hold the commit point up to this long |
| `--commitAfterBytes` (`PROXY_COMMIT_AFTER_BYTES`) | 16384 | …or until this many body bytes |
| `--budgetCapacity` (`PROXY_BUDGET_CAPACITY`) | 12 | retry tokens available |
| `--budgetRefill` (`PROXY_BUDGET_REFILL`) | 3 | tokens refilled per second |
| `--maxInFlight` (`PROXY_MAX_IN_FLIGHT`) | 8 | concurrent requests per upstream |

## The three delivery stages

Each attempt runs a small state machine. The stage at the moment of failure
decides whether the request can be replayed.

| Stage | What has reached the client | On failure |
|---|---|---|
| `pre-headers` | nothing | **retry** — the client cannot tell it happened |
| `headers-committed` | status + headers | **no retry** — finish or truncate |
| `body-partial` | ≥ 1 body byte | **no retry** — destroy the socket so truncation is visible |

To make more failures replayable, the proxy **holds the commit point** for
replayable requests: headers are buffered until either `commitAfterBytes` body
bytes or `commitAfterMs` elapses. An upstream that dies inside that window is
still in `pre-headers` and can be retried cleanly. Streaming responses
(`text/event-stream`) opt out so SSE latency is unaffected.

Two timeouts are classified separately and both are retryable (they fail in
`pre-headers`):

- **connect timeout** — the TCP connection was never established.
- **first-hop timeout** — the socket opened but the response head never arrived.

### Why "weak status" is its own path

A retryable status (`502/503/504`) is not a network failure. When one arrives,
the proxy asks the **shared budget** for a token *before* consuming the body.
Granted → the response is drained and discarded, and the retry lands elsewhere.
Denied → the reply is relayed instead of retried. It only attempts this when
another upstream is actually selectable, so a token is never spent on a replay
that could not go anywhere.

## Replay eligibility

A request is replayable if either:

- its method is **idempotent** (`GET/HEAD/OPTIONS/PUT/DELETE/TRACE`), or
- it carries an **`Idempotency-Key`** header (unsafe methods opt in explicitly).

A non-idempotent `POST` without that header is sent exactly once, whatever
fails. This is a header-level decision made before any upstream is contacted.

## Shared retry budget

A single token bucket, shared by every request the proxy handles. Attempt 0 is
always free; only **retries** cost tokens. N concurrent weak failures draw from
the same pool, so they cannot multiply into N×maxAttempts upstream calls. When
the bucket is empty, failures degrade to a relayed weak reply rather than a
retry. Track the live token count in the console or `GET /admin/stats`.

## Upstream selection

- least-loaded among healthy upstreams, never revisiting one already tried;
- per-upstream in-flight cap (`maxInFlightPerUpstream`);
- a light circuit breaker: after repeated failures an upstream goes `suspect`,
  then `open` (out of rotation) for a cooldown.

## Debug console

`GET /` is a live view of **real** forwards, driven by Server-Sent Events:

- **KPI row** — traced / delivered / retried / gave up / p95.
- **Shared retry budget** — a meter plus a one-minute sparkline of tokens with
  grant/deny event dots. (Table view included.)
- **Outcomes by delivery stage** — every request bucketed as delivered,
  truncated, weak-relayed, or gave up, split by the terminal stage.
- **Live traces** — one row per forward. Expand a row for a per-attempt
  waterfall (which upstream, ttfb, bytes, terminal stage) and a decision log
  (eligibility, token grants, every retry decision and why).

JSON endpoints: `GET /admin/stats`, `GET /admin/traces`,
`GET /admin/traces/:id`, `GET /admin/upstreams`, `GET /admin/stream` (SSE).

## Tests

```bash
npm test
```

Covers each delivery stage, first-hop vs connect timeout, deferred commit,
truncation visibility, idempotency-key replay, the shared-budget bound under
concurrency, upstream caps, and the debug endpoints.
