import { EventEmitter } from 'node:events';

/**
 * In-memory ring of request traces. A trace is a mutable object that is
 * appended-to as the request moves through the proxy, and published live to
 * SSE clients after every meaningful change so the debug page shows the real
 * forward as it happens rather than a post-hoc reconstruction.
 */
export class TraceStore extends EventEmitter {
  constructor({ capacity = 200 } = {}) {
    super();
    this.capacity = capacity;
    this.traces = [];
    this.byId = new Map();
    this.seq = 0;
  }

  create(seed) {
    const trace = {
      id: seed.id,
      seq: ++this.seq,
      createdAt: Date.now(),
      startedAt: seed.startedAt,
      method: seed.method,
      url: seed.url,
      path: seed.path,
      client: seed.client,
      idempotent: seed.idempotent,
      hasIdempotencyKey: seed.hasIdempotencyKey,
      replayable: seed.replayable,
      requestBytes: seed.requestBytes,
      requestHeaders: seed.requestHeaders,
      requestBodyPreview: seed.requestBodyPreview,
      attempts: [],
      decisions: [],
      result: null,
      finishedAt: null,
      durationMs: null,
    };
    this.traces.push(trace);
    this.byId.set(trace.id, trace);
    while (this.traces.length > this.capacity) {
      const evicted = this.traces.shift();
      this.byId.delete(evicted.id);
    }
    return trace;
  }

  update(trace, patch) {
    Object.assign(trace, patch);
    this.emit('update', trace);
  }

  note(trace, decision) {
    trace.decisions.push({ at: Date.now(), ...decision });
    this.emit('update', trace);
  }

  pushAttempt(trace, attempt) {
    trace.attempts.push(attempt);
    this.emit('update', trace);
  }

  finish(trace, result) {
    trace.result = result;
    trace.finishedAt = Date.now();
    trace.durationMs = Math.round(trace.finishedAt - trace.createdAt);
    this.emit('update', trace);
    this.emit('finish', trace);
  }

  list() {
    return [...this.traces].reverse();
  }

  clear() {
    this.traces = [];
    this.byId.clear();
    this.emit('cleared');
  }

  get(id) {
    return this.byId.get(id) || null;
  }
}
