/**
 * Distance-aware retry budget.
 *
 * A token bucket shared by every request handled by the proxy. Attempt 0 of a
 * healthy request is always free; the bucket is only spent when we decide to
 * retry. This means N concurrent weak failures draw from one pool and cannot
 * multiply into N * maxAttempts upstream calls, so a flapping backend is not
 * hammered by the retries of everyone talking to it simultaneously.
 *
 * Refill is continuous (lazy, computed on demand) so tests can inject a clock.
 */
export class RetryBudget {
  constructor({ capacity = 12, refillPerSecond = 3, now = () => Date.now() } = {}) {
    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
    this.now = now;
    this.tokens = capacity;
    this.lastRefill = now();
    this.granted = 0;
    this.denied = 0;
    this.since = now();
  }

  refill() {
    const t = this.now();
    const elapsed = Math.max(0, t - this.lastRefill);
    this.lastRefill = t;
    if (elapsed === 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed / 1000) * this.refillPerSecond);
  }

  /** Try to spend one retry token. Non-blocking: denial is a decision, not a wait. */
  tryTake() {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      this.granted += 1;
      return true;
    }
    this.denied += 1;
    return false;
  }

  snapshot() {
    this.refill();
    return {
      capacity: this.capacity,
      refillPerSecond: this.refillPerSecond,
      tokens: Math.round(this.tokens * 100) / 100,
      granted: this.granted,
      denied: this.denied,
      since: this.since,
    };
  }

  /** For tests / demos: refill to full immediately without touching counters. */
  reset() {
    this.tokens = this.capacity;
    this.lastRefill = this.now();
  }
}
