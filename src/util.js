
/** RFC 9110 idempotent methods. CONNECT/TRACE are not proxied here. */
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE', 'TRACE']);

export const isIdempotent = (method) => IDEMPOTENT_METHODS.has((method || '').toUpperCase());

/** Timestamp for trace display. */
export const isoNow = () => new Date().toISOString();

/** Headers that must not be forwarded hop-by-hop (RFC 9110 §7.6.1). */
export const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export function filterHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(key.toLowerCase()) && value !== undefined) out[key] = value;
  }
  return out;
}

export function buildUpstreamHeaders(req, requestId, body) {
  const headers = filterHeaders(req.headers);
  delete headers.host;
  delete headers['content-length'];
  delete headers['transfer-encoding'];
  delete headers['proxy-connection'];
  delete headers.expect;

  if (body.length > 0 || req.headers['content-length'] !== undefined) {
    headers['content-length'] = String(body.length);
  }
  headers['x-forwarded-for'] = req.headers['x-forwarded-for']
    ? `${req.headers['x-forwarded-for']}, ${req.socket.remoteAddress}`
    : req.socket.remoteAddress;
  headers['x-forwarded-proto'] = 'http';
  headers['x-forwarded-host'] = req.headers.host || '';
  headers['x-request-id'] = requestId;
  return headers;
}

export function createLogger({ level = 'info' } = {}) {
  const levels = { debug: 10, info: 20, warn: 30, error: 40 };
  const min = levels[level] ?? 20;
  const write = (lvl, msg, extra) => {
    if (levels[lvl] < min) return;
    const line = `[${new Date().toISOString()}] ${lvl.toUpperCase()} ${msg}`;
    if (extra !== undefined) console.error(line, extra);
    else console.error(line);
  };
  return {
    debug: (m, e) => write('debug', m, e),
    info: (m, e) => write('info', m, e),
    warn: (m, e) => write('warn', m, e),
    error: (m, e) => write('error', m, e),
  };
}

