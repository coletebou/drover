// HTTP client for the Drover daemon. Pure: no chrome.* here, `fetch` is
// injected so node --test can drive it. The token is sent only as a bearer
// header and never appears in an error message, a URL or a log line.

export const STREAM_PATH = '/api/stream';
const DEFAULT_TIMEOUT_MS = 15_000;

/** Error kinds the UI knows how to explain. */
export const ErrorKind = Object.freeze({
  NOT_CONFIGURED: 'not-configured', // no server URL or token yet
  NO_PERMISSION: 'no-permission',   // host permission for the origin not granted
  UNAUTHORIZED: 'unauthorized',     // 401: wrong token
  FORBIDDEN: 'forbidden',           // 403: bad origin (DROVER_ALLOW_ORIGINS) or refused op
  UNREACHABLE: 'unreachable',       // network error or timeout
  SERVER: 'server',                 // 5xx or { ok: false }
  BAD_RESPONSE: 'bad-response',     // not JSON, or not the expected envelope
});

export class ApiError extends Error {
  /** @param {string} kind one of ErrorKind @param {string} message safe to show @param {{status?: number, op?: string}} [extra] */
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = extra.status ?? null;
    this.op = extra.op ?? null;
  }
}

/**
 * The daemon's origin from what the user typed: scheme and host[:port], no
 * path, no trailing slash. Throws ApiError(NOT_CONFIGURED) when unusable.
 * @param {string} input
 * @returns {string} e.g. "http://127.0.0.1:7337"
 */
export function normalizeBaseUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new ApiError(ErrorKind.NOT_CONFIGURED, 'Set the server URL in options.');
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`); } catch { throw new ApiError(ErrorKind.NOT_CONFIGURED, 'The server URL is not a valid URL.'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ApiError(ErrorKind.NOT_CONFIGURED, 'The server URL must start with http:// or https://.');
  if (u.username || u.password) throw new ApiError(ErrorKind.NOT_CONFIGURED, 'Put the token in the token field, not in the URL.');
  return u.origin;
}

/**
 * The host-permission match pattern for a base URL (port kept, path wildcard).
 * @param {string} baseUrl @returns {string} e.g. "http://127.0.0.1:7337/*"
 */
export function originPattern(baseUrl) {
  return `${normalizeBaseUrl(baseUrl)}/*`;
}

/**
 * @param {{ baseUrl: string, token: string, fetch?: typeof fetch, timeoutMs?: number }} opts
 */
export function createClient({ baseUrl, token, fetch: fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const origin = normalizeBaseUrl(baseUrl);
  if (typeof token !== 'string' || !token.trim()) throw new ApiError(ErrorKind.NOT_CONFIGURED, 'Set the token in options.');
  const auth = `Bearer ${token.trim()}`;

  /**
   * Call an op (always POST: the daemon accepts reads that way and refuses mutating GETs).
   * Resolves with `result` from `{ ok: true, result }`.
   * @param {string} op @param {object} [args] @param {{ signal?: AbortSignal, timeoutMs?: number }} [o]
   */
  async function op(name, args = {}, o = {}) {
    if (!/^[a-zA-Z.]+$/.test(name)) throw new ApiError(ErrorKind.BAD_RESPONSE, `Bad op name.`, { op: name });
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), o.timeoutMs ?? timeoutMs);
    const onAbort = () => ctrl.abort();
    o.signal?.addEventListener('abort', onAbort, { once: true });
    let res;
    try {
      res = await fetchImpl(`${origin}/api/op/${name}`, {
        method: 'POST',
        headers: { authorization: auth, 'content-type': 'application/json' },
        body: JSON.stringify(args ?? {}),
        signal: ctrl.signal,
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch (e) {
      throw new ApiError(ErrorKind.UNREACHABLE, ctrl.signal.aborted && !o.signal?.aborted ? `${origin} did not answer in time.` : `Cannot reach ${origin}.`, { op: name });
    } finally {
      clearTimeout(t);
      o.signal?.removeEventListener('abort', onAbort);
    }
    return parseEnvelope(res, name);
  }

  /**
   * The fetch init for the SSE stream (used by lib/sse.js). `topics` asks for only those events (`?topics=a,b`);
   * a daemon from before topics ignores it and sends everything. The token stays in the header.
   * @param {{topics?: string[]}} [o]
   */
  function streamRequest({ topics } = {}) {
    const list = Array.isArray(topics) ? topics.filter((t) => /^[a-z]+$/.test(t)) : [];
    const query = list.length ? `?topics=${list.join(',')}` : '';
    return { url: `${origin}${STREAM_PATH}${query}`, init: { method: 'GET', headers: { authorization: auth, accept: 'text/event-stream' }, credentials: 'omit', cache: 'no-store' } };
  }

  /**
   * Ask the daemon to stream a local Claude session's new turns as SSE `turn` events (POST /api/follow), or to
   * stop (`on: false`). Best effort: a daemon or browser that refuses it leaves the page on polling.
   */
  async function follow(id, on = true) {
    if (typeof id !== 'string' || !id) return false;
    try {
      const res = await fetchImpl(`${origin}/api/follow`, {
        method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify({ id, on }),
        credentials: 'omit', cache: 'no-store', keepalive: !on,
      });
      return res.ok;
    } catch { return false; }
  }

  return { origin, op, streamRequest, follow };
}

async function parseEnvelope(res, op) {
  let body = null;
  try { body = await res.json(); } catch { /* handled below */ }
  if (res.status === 401) throw new ApiError(ErrorKind.UNAUTHORIZED, 'The daemon rejected the token.', { status: 401, op });
  if (res.status === 403) {
    const why = body?.error === 'bad origin' ? 'The daemon refused this extension\'s origin. Add it to DROVER_ALLOW_ORIGINS.' : safeMessage(body?.error) ?? 'Refused by the daemon.';
    throw new ApiError(ErrorKind.FORBIDDEN, why, { status: 403, op });
  }
  if (!body || typeof body !== 'object') throw new ApiError(ErrorKind.BAD_RESPONSE, `Unexpected answer from the daemon (HTTP ${res.status}).`, { status: res.status, op });
  if (!res.ok || body.ok === false) throw new ApiError(ErrorKind.SERVER, safeMessage(body.error) ?? `HTTP ${res.status}`, { status: res.status, op });
  if (!('result' in body)) throw new ApiError(ErrorKind.BAD_RESPONSE, 'The daemon answered without a result.', { status: res.status, op });
  return body.result;
}

/** Server error strings are shown in the UI: cap their length and drop anything token-like. */
export function safeMessage(s) {
  if (typeof s !== 'string' || !s.trim()) return null;
  return s.replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]').slice(0, 200);
}
