const DEFAULTS = {
  port: 8080,
  host: '127.0.0.1',

  upstreams: [],

  retry: {
    maxAttempts: 3,
    retryableStatuses: [502, 503, 504],
    connectTimeoutMs: 1000,
    firstHopTimeoutMs: 3000,
    // While waiting for the first body bytes we hold the commit point open:
    // buffer up to N bytes or T ms, so an early body failure can still be retried.
    commitAfterBytes: 16 * 1024,
    commitAfterMs: 200,
    // Bound on the body we keep from a retryable-status response so it can be
    // relayed to the client if we ultimately give up.
    weakBodyBufferBytes: 64 * 1024,
    maxRequestBodyBytes: 4 * 1024 * 1024,
    retryUnsafeWithIdempotencyKey: true,
  },

  budget: {
    capacity: 12,
    refillPerSecond: 3,
  },

  upstreamPolicy: {
    maxInFlightPerUpstream: 8,
    suspectAfterFailures: 2,
    downAfterFailures: 5,
    cooldownMs: 10_000,
  },

  traceBuffer: 200,
  demo: false,
  enableDebugHints: false,
  logLevel: 'info',
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function coerce(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const [rawKey, inline] = arg.slice(2).split('=');
    const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (inline !== undefined) out[key] = inline;
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[key] = argv[++i];
    else out[key] = true;
  }
  return out;
}

export function buildConfig(argv = [], env = process.env) {
  const cfg = clone(DEFAULTS);
  const args = parseArgs(argv);

  cfg.port = coerce(args.port ?? env.PROXY_PORT, cfg.port);
  cfg.host = args.host ?? env.PROXY_HOST ?? cfg.host;
  cfg.demo = Boolean(args.demo);
  cfg.logLevel = args.logLevel ?? env.LOG_LEVEL ?? cfg.logLevel;
  cfg.enableDebugHints = Boolean(args.debugHints) || cfg.demo;

  const upstreamArg = args.upstream ?? env.PROXY_UPSTREAMS;
  if (Array.isArray(upstreamArg)) cfg.upstreams = upstreamArg.slice();
  else if (typeof upstreamArg === 'string' && upstreamArg.length > 0) {
    cfg.upstreams = upstreamArg.split(',').map((s) => s.trim()).filter(Boolean);
  }

  const numeric = [
    ['maxAttempts', 'PROXY_MAX_ATTEMPTS'],
    ['connectTimeoutMs', 'PROXY_CONNECT_TIMEOUT_MS'],
    ['firstHopTimeoutMs', 'PROXY_FIRST_HOP_TIMEOUT_MS'],
    ['commitAfterBytes', 'PROXY_COMMIT_AFTER_BYTES'],
    ['commitAfterMs', 'PROXY_COMMIT_AFTER_MS'],
    ['maxRequestBodyBytes', 'PROXY_MAX_REQUEST_BODY_BYTES'],
  ];
  for (const [key, envKey] of numeric) {
    const v = args[key] ?? env[envKey];
    if (v !== undefined) cfg.retry[key] = coerce(v, cfg.retry[key]);
  }

  cfg.budget.capacity = coerce(args.budgetCapacity ?? env.PROXY_BUDGET_CAPACITY, cfg.budget.capacity);
  cfg.budget.refillPerSecond = coerce(args.budgetRefill ?? env.PROXY_BUDGET_REFILL, cfg.budget.refillPerSecond);
  cfg.upstreamPolicy.maxInFlightPerUpstream = coerce(
    args.maxInFlight ?? env.PROXY_MAX_IN_FLIGHT,
    cfg.upstreamPolicy.maxInFlightPerUpstream,
  );
  cfg.traceBuffer = coerce(args.traceBuffer, cfg.traceBuffer);

  return cfg;
}

export { DEFAULTS };
