// Pairing with the Drover daemon, so nobody pastes the token: the extension asks
// to pair, shows a short code, someone at the Mac approves that code (drover pair
// approve <code>, or Approve in Drover's browser UI) and the next status check
// hands over the token, once. Pure: fetch, timers and the clock are injected so
// node --test can drive it. No chrome.* and no DOM here.
//
// Neither request carries a secret. The token goes from the status answer
// straight to saveToken: never into an update, an error message, a URL or a log
// line. The request id is the only claim on that token, so it stays in this
// closure and is dropped when pairing ends.
import { normalizeBaseUrl, safeMessage, ApiError, ErrorKind } from './api.js';

export const PAIR_REQUEST_PATH = '/api/pair/request';
export const PAIR_STATUS_PATH = '/api/pair/status';
export const PAIR_CLIENT = 'Drover for Chrome';

/** Error kinds pairing adds to ErrorKind (lib/api.js). */
export const PairErrorKind = Object.freeze({
  BUSY: 'busy',               // 429: too many pairing requests waiting
  UNSUPPORTED: 'unsupported', // 401 or 404 on the request: the daemon predates pairing
  STORAGE: 'storage',         // approved, but saveToken failed
});

const LABEL_MAX = 64;     // the daemon refuses longer labels
const POLL_MS = Object.freeze({ min: 500, max: 10_000, fallback: 1500 });
const RETRIES = 2;        // failed status checks in a row tolerated while waiting
const DEFAULT_TIMEOUT_MS = 15_000;
const REQUEST_ID = /^[A-Za-z0-9_-]{16,128}$/;
const CODE = /^\d{4,12}$/;

/** "123456" -> "123 456": digits in groups of three, the way the daemon shows them. */
export function formatCode(code) {
  return String(code ?? '').replace(/\D/g, '').replace(/(\d{3})(?=\d)/g, '$1 ');
}

/** The command that approves a code on the daemon's machine. */
export function approveCommand(code) {
  return `drover pair approve ${String(code ?? '').replace(/\D/g, '')}`;
}

/** Time left as m:ss, rounded up so the last second shows 0:01, never below 0:00. */
export function formatTimeLeft(ms) {
  const s = Number.isFinite(ms) ? Math.max(0, Math.ceil(ms / 1000)) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Control characters out, whitespace collapsed, at most 64 characters. */
export function cleanLabel(s) {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX).trim();
}

/** Chrome's made-up brands ("Not=A?Brand", " Not A;Brand", ...). */
const isGrease = (brand) => brand.replace(/[^a-z]/gi, '').toLowerCase() === 'notabrand';

/**
 * A short label for the approver, who reads "Drover for Chrome on <label> wants to pair": the
 * platform, plus the browser when it is not Google Chrome. Empty when unknown (Safari has no
 * userAgentData).
 * @param {{ userAgentData?: { platform?: string, brands?: { brand: string }[] } }} [nav] navigator
 */
export function deviceLabel(nav) {
  const ua = nav?.userAgentData;
  const platform = typeof ua?.platform === 'string' ? ua.platform : '';
  const brands = (Array.isArray(ua?.brands) ? ua.brands : []).map((b) => (typeof b?.brand === 'string' ? b.brand.trim() : '')).filter((b) => b && !isGrease(b));
  const brand = brands.find((b) => b !== 'Chromium') ?? brands[0] ?? '';
  return cleanLabel([platform, brand === 'Google Chrome' ? '' : brand].filter(Boolean).join(', '));
}

async function send(fetchImpl, origin, path, init, { signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  if (signal?.aborted) ctrl.abort(); else signal?.addEventListener('abort', onAbort, { once: true });
  try {
    let res;
    try {
      res = await fetchImpl(`${origin}${path}`, { ...init, signal: ctrl.signal, credentials: 'omit', cache: 'no-store' });
    } catch {
      throw new ApiError(ErrorKind.UNREACHABLE, ctrl.signal.aborted && !signal?.aborted ? `${origin} did not answer in time.` : `Cannot reach ${origin}.`);
    }
    let body = null;
    try { body = await res.json(); } catch { /* not JSON: callers check the shape */ }
    return { status: res.status, ok: res.ok, body };
  } finally {
    clearTimeout(t);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** An HTTP failure as an ApiError whose message is safe to show. */
function refused({ status, body }) {
  if (status === 403) {
    const why = body?.error === 'bad origin' ? 'The daemon refused this extension\'s origin. Add it to DROVER_ALLOW_ORIGINS.' : safeMessage(body?.error) ?? 'Refused by the daemon.';
    return new ApiError(ErrorKind.FORBIDDEN, why, { status });
  }
  return new ApiError(ErrorKind.SERVER, safeMessage(body?.error) ?? `HTTP ${status}`, { status });
}

const unexpected = (status) => new ApiError(ErrorKind.BAD_RESPONSE, `Unexpected answer from the daemon (HTTP ${status}).`, { status });

const pollInterval = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(POLL_MS.max, Math.max(POLL_MS.min, v)) : POLL_MS.fallback);

/**
 * POST /api/pair/request, with no Authorization header: pairing is how the extension gets a token.
 * @param {{ baseUrl: string, device?: string, fetch?: typeof fetch, signal?: AbortSignal, timeoutMs?: number }} opts
 * @returns {Promise<{ requestId: string, code: string, expiresAt: number, pollMs: number }>} expiresAt in epoch ms
 */
export async function requestPairing({ baseUrl, device = '', fetch: fetchImpl = globalThis.fetch, signal, timeoutMs }) {
  const origin = normalizeBaseUrl(baseUrl);
  const r = await send(fetchImpl, origin, PAIR_REQUEST_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client: PAIR_CLIENT, device: cleanLabel(device) }),
  }, { signal, timeoutMs });
  if (r.status === 429) throw new ApiError(PairErrorKind.BUSY, 'Too many pairing requests are waiting. Approve or deny them on your Mac, or wait for them to expire, then try again.', { status: 429 });
  if (r.status === 401 || r.status === 404) throw new ApiError(PairErrorKind.UNSUPPORTED, 'This Drover daemon cannot pair yet. Update Drover, or paste the token instead.', { status: r.status });
  if (!r.ok) throw refused(r);
  const b = r.body ?? {};
  const expiresAt = typeof b.expiresAt === 'string' ? Date.parse(b.expiresAt) : NaN;
  if (typeof b.requestId !== 'string' || !REQUEST_ID.test(b.requestId) || typeof b.code !== 'string' || !CODE.test(b.code) || !Number.isFinite(expiresAt)) throw unexpected(r.status);
  return { requestId: b.requestId, code: b.code, expiresAt, pollMs: pollInterval(b.pollMs) };
}

/**
 * GET /api/pair/status?requestId=, with no Authorization header. Resolves { status: 'pending' | 'denied' | 'expired' }
 * or { status: 'approved', token }; 404 means unknown, expired or already collected. The widget token in an
 * approved answer is dropped: the extension uses only the main token, so it keeps no second secret.
 * @param {{ baseUrl: string, requestId: string, fetch?: typeof fetch, signal?: AbortSignal, timeoutMs?: number }} opts
 */
export async function checkPairing({ baseUrl, requestId, fetch: fetchImpl = globalThis.fetch, signal, timeoutMs }) {
  const origin = normalizeBaseUrl(baseUrl);
  const r = await send(fetchImpl, origin, `${PAIR_STATUS_PATH}?requestId=${encodeURIComponent(String(requestId ?? ''))}`, { method: 'GET' }, { signal, timeoutMs });
  if (r.status === 404) return { status: 'expired' };
  if (!r.ok) throw refused(r);
  const s = r.body?.status;
  if (s === 'pending' || s === 'denied' || s === 'expired') return { status: s };
  if (s === 'approved' && typeof r.body.token === 'string' && r.body.token.trim()) return { status: 'approved', token: r.body.token.trim() };
  throw unexpected(r.status);
}

/**
 * Run one pairing: ask for a code, then check every pollMs until the code is approved, denied or
 * expired, stopping at expiresAt. On approval the token goes to saveToken and nowhere else.
 *
 * onUpdate gets, in order (never the token, never the request id):
 *   { state: 'requesting', origin }
 *   { state: 'waiting', origin, code, display, command, expiresAt }   expiresAt in epoch ms
 *   { state: 'approved', origin }                                      saveToken is running
 * then exactly one final update, which `done` also resolves with:
 *   { state: 'paired' | 'denied' | 'expired' | 'cancelled', origin }
 *   { state: 'error', origin, error: { kind, message } }               message is safe to show
 *
 * The first update comes after startPairing returns. cancel() stops polling, aborts a request in
 * flight and returns true; once the daemon has approved, the token is already on its way to
 * storage and cancel() returns false.
 * @param {{ baseUrl: string, device?: string, saveToken: (token: string) => Promise<unknown>, onUpdate?: (u: object) => void,
 *   fetch?: typeof fetch, setTimer?: Function, clearTimer?: Function, now?: () => number, timeoutMs?: number }} opts
 * @returns {{ cancel: () => boolean, done: Promise<object> }}
 */
export function startPairing({ baseUrl, device = '', saveToken, onUpdate = () => {}, fetch: fetchImpl = globalThis.fetch, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now, timeoutMs }) {
  if (typeof saveToken !== 'function') throw new TypeError('startPairing needs saveToken');
  const origin = normalizeBaseUrl(baseUrl);
  const ctrl = new AbortController();
  const net = { baseUrl: origin, fetch: fetchImpl, signal: ctrl.signal, timeoutMs };
  let requestId = null; // the only claim on the token: memory only, dropped when pairing ends
  let deadline = 0;
  let pollMs = POLL_MS.fallback;
  let timer = null;
  let failures = 0;
  let saving = false;
  let over = false;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });

  const emit = (u) => { try { onUpdate(u); } catch { /* a bad handler must not stop pairing */ } };

  function finish(u) {
    if (over) return;
    over = true;
    requestId = null;
    if (timer != null) clearTimer(timer);
    timer = null;
    ctrl.abort();
    emit(u);
    resolveDone(u);
  }
  const fail = (e) => finish({ state: 'error', origin, error: e instanceof ApiError ? { kind: e.kind, message: e.message } : { kind: ErrorKind.SERVER, message: 'Pairing failed.' } });

  function schedule() {
    if (over) return;
    timer = setTimer(() => { timer = null; check(); }, Math.max(0, Math.min(pollMs, deadline - now())));
  }

  async function check() {
    if (over) return;
    let r;
    try {
      r = await checkPairing({ ...net, requestId });
    } catch (e) {
      if (over) return;
      // A network blip while someone walks to the Mac should not end pairing.
      if (e?.kind === ErrorKind.UNREACHABLE && ++failures <= RETRIES && now() < deadline) return schedule();
      return fail(e);
    }
    if (over) return;
    failures = 0;
    if (r.status === 'approved') return approved(r.token);
    if (r.status !== 'pending') return finish({ state: r.status, origin });
    if (now() >= deadline) return finish({ state: 'expired', origin });
    schedule();
  }

  async function approved(token) {
    saving = true;
    requestId = null;
    emit({ state: 'approved', origin });
    try {
      await saveToken(token);
    } catch {
      return fail(new ApiError(PairErrorKind.STORAGE, 'Approved, but the token could not be saved. Pair again.'));
    }
    finish({ state: 'paired', origin });
  }

  async function run() {
    if (over) return;
    emit({ state: 'requesting', origin });
    let r;
    try {
      r = await requestPairing({ ...net, device });
    } catch (e) {
      return fail(e); // a no-op after cancel()
    }
    if (over) return;
    ({ requestId, expiresAt: deadline, pollMs } = r);
    emit({ state: 'waiting', origin, code: r.code, display: formatCode(r.code), command: approveCommand(r.code), expiresAt: r.expiresAt });
    schedule();
  }

  Promise.resolve().then(run);
  return {
    cancel() {
      if (over || saving) return false;
      finish({ state: 'cancelled', origin });
      return true;
    },
    done,
  };
}

/** "Pairing code 1 2 3 4 5 6": the code as a screen reader should say it. */
const spoken = (code) => `Pairing code ${String(code ?? '').split('').join(' ')}`;

function errorText(error) {
  const msg = error?.message || 'Pairing failed.';
  return error?.kind === ErrorKind.UNREACHABLE ? `${msg} Is Drover running? Try drover status on that machine.` : msg;
}

/**
 * What the options page shows for a pairing update, as plain data the page turns into DOM. Built only
 * from the update, which never holds the token or the request id. Message parts are strings or
 * { code } (shown as <code>). busy: the form waits; cancel and retry: which buttons to show;
 * originHint: show the DROVER_ALLOW_ORIGINS hint.
 * @param {object|null} u an update from startPairing; a 'paired' one may carry connected: boolean once the page has checked
 * @param {number} [now] epoch ms, for the countdown
 */
export function pairingView(u, now = Date.now()) {
  const view = { tone: 'info', code: null, codeLabel: null, message: [], timer: null, command: null, busy: false, cancel: false, retry: false, originHint: false };
  switch (u?.state) {
    case 'requesting':
      return { ...view, busy: true, cancel: true, message: [`Asking ${u.origin} for a pairing code…`] };
    case 'waiting':
      return {
        ...view, busy: true, cancel: true, code: u.display, codeLabel: spoken(u.code), command: u.command,
        message: ['Approve this code on your Mac: run ', { code: u.command }, ' or use Approve in Drover\'s browser UI.'],
        timer: `Expires in ${formatTimeLeft(u.expiresAt - now)}.`,
      };
    case 'approved':
      return { ...view, busy: true, tone: 'ok', message: ['Approved. Saving the token…'] };
    case 'paired':
      if (u.connected === true) return { ...view, tone: 'ok', message: [`Paired with ${u.origin} and connected.`] };
      if (u.connected === false) return { ...view, message: [`Paired with ${u.origin} and saved the token, but the connection check failed. See Connection below.`] };
      return { ...view, busy: true, tone: 'ok', message: [`Paired with ${u.origin}. Checking the connection…`] };
    case 'denied':
      return { ...view, tone: 'error', retry: true, message: ['The code was denied on your Mac. Nothing was saved.'] };
    case 'expired':
      return { ...view, tone: 'error', retry: true, message: ['The code expired before it was approved. Nothing was saved.'] };
    case 'cancelled':
      return { ...view, message: ['Pairing cancelled.'] };
    case 'error':
      return { ...view, tone: 'error', retry: true, originHint: u.error?.kind === ErrorKind.FORBIDDEN, message: [errorText(u.error)] };
    default:
      return null;
  }
}
