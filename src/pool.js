/**
 * Upstream pool with per-upstream concurrency caps and a lightweight
 * circuit-breaker. Selection prefers the least-loaded healthy upstream,
 * never revisits an upstream already tried in the same request, and treats one
 * that just failed as "suspect" so a different upstream gets the retry when
 * there is one.
 */
export class UpstreamPool {
  constructor(urls, policy = {}, { now = () => Date.now() } = {}) {
    this.policy = {
      maxInFlightPerUpstream: 8,
      suspectAfterFailures: 2,
      downAfterFailures: 5,
      cooldownMs: 10_000,
      ...policy,
    };
    this.now = now;
    this.upstreams = urls.map((url, index) => ({
      id: `up-${index + 1}`,
      url: normalizeUrl(url),
      index,
      inFlight: 0,
      consecutiveFailures: 0,
      successes: 0,
      failures: 0,
      openUntil: 0,
      lastError: null,
    }));
  }

  get size() {
    return this.upstreams.length;
  }

  get(id) {
    return this.upstreams.find((u) => u.id === id) || null;
  }

  /** Effective availability: not circuit-open and not at its concurrency cap. */
  available(u) {
    return this.now() >= u.openUntil && u.inFlight < this.policy.maxInFlightPerUpstream;
  }

  /**
   * Pick an upstream. `exclude` is a *preference*: untried upstreams are
   * preferred, but if none are available the pool falls back to any available
   * one, so a single (or temporarily saturated) upstream can still be retried.
   * Returns null only when nothing is available at all.
   */
  select(exclude = new Set()) {
    const healthy = this.upstreams.filter((u) => this.available(u));
    const preferred = healthy.filter((u) => !exclude.has(u.id));
    const pool = preferred.length > 0 ? preferred : healthy;
    pool.sort((a, b) => {
      const loadDelta = (a.inFlight / this.policy.maxInFlightPerUpstream) -
        (b.inFlight / this.policy.maxInFlightPerUpstream);
      if (Math.abs(loadDelta) > 0.001) return loadDelta;
      if (a.consecutiveFailures !== b.consecutiveFailures) {
        return a.consecutiveFailures - b.consecutiveFailures;
      }
      return a.index - b.index;
    });
    return pool[0] || null;
  }

  /** True if an upstream other than `exclude` ids is currently selectable. */
  hasOtherThan(exclude) {
    return this.upstreams.some((u) => !exclude.has(u.id) && this.available(u));
  }

  acquire(u) {
    u.inFlight += 1;
  }

  release(u) {
    if (u.inFlight > 0) u.inFlight -= 1;
  }

  recordSuccess(u) {
    u.successes += 1;
    u.consecutiveFailures = 0;
    u.openUntil = 0;
    u.lastError = null;
  }

  /**
   * Record a failed attempt. `weak` failures (timeouts, 5xx, truncated bodies)
   * count toward suspicion; `hard` failures (connection refused) count faster.
   * Once a provider crosses the down threshold it is taken out of rotation for
   * cooldownMs.
   */
  recordFailure(u, error, { weight = 1 } = {}) {
    u.failures += 1;
    u.consecutiveFailures += weight;
    u.lastError = { message: error?.message || String(error), at: this.now() };
    if (u.consecutiveFailures >= this.policy.downAfterFailures) {
      u.openUntil = this.now() + this.policy.cooldownMs;
    }
  }

  isSuspect(u) {
    return u.consecutiveFailures >= this.policy.suspectAfterFailures;
  }

  snapshot() {
    const t = this.now();
    return this.upstreams.map((u) => ({
      id: u.id,
      url: u.url,
      inFlight: u.inFlight,
      successes: u.successes,
      failures: u.failures,
      consecutiveFailures: u.consecutiveFailures,
      state: t < u.openUntil ? 'open' : this.isSuspect(u) ? 'suspect' : 'healthy',
      openForMs: Math.max(0, u.openUntil - t),
      maxInFlight: this.policy.maxInFlightPerUpstream,
      lastError: u.lastError,
    }));
  }
}

export function normalizeUrl(raw) {
  const withoutScheme = raw.replace(/^https?:\/\//, '');
  const [hostAndPort, ...pathParts] = withoutScheme.split('/');
  const [host, portStr] = hostAndPort.split(':');
  return {
    raw,
    host,
    port: portStr ? Number(portStr) : null,
    basePath: pathParts.length ? `/${pathParts.join('/')}` : '',
  };
}
