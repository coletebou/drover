// HTTP client for the drover daemon. Every op is POST /api/op/<op> with a JSON
// body; responses are {ok, result, ms} or {ok:false, error}. The bearer token
// arrives once in location.hash as #token=... and lives in localStorage.
import { setOwner } from './owner.js';

const TOKEN_KEY = 'drover.token';
const HOST_KEY = 'drover.host';

export function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
export function setToken(t) { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); }

/** If the hash carries token=..., store it and strip it from the URL. */
export function takeTokenFromHash() {
  const hash = location.hash || '';
  const m = hash.match(/token=([A-Za-z0-9_-]+)/);
  if (!m) return false;
  setToken(m[1]);
  let rest = hash.slice(1).replace(/[?&#]?token=[A-Za-z0-9_-]+/, '').replace(/^[?&]+|[?&]+$/g, '');
  if (!rest.startsWith('/')) rest = rest ? '/' + rest : '/board';
  history.replaceState(null, '', location.pathname + location.search + '#' + rest);
  return true;
}

export function getHost() { return localStorage.getItem(HOST_KEY) || 'local'; }
export function setHost(host) { localStorage.setItem(HOST_KEY, host || 'local'); }

export class ApiError extends Error {
  constructor(message, extra = {}) { super(message); this.name = 'ApiError'; Object.assign(this, extra); }
}

function authHeaders() {
  return { 'content-type': 'application/json', authorization: `Bearer ${getToken()}` };
}

// The daemon's op names (core/daemon-client.js OP_NAME): dot-separated words, so
// a name can never resolve the request URL onto another route such as /api/pair/approve.
export const OP_NAME = /^[a-zA-Z]+(?:\.[a-zA-Z]+)*$/;

// What the front daemon serves (GET /api/ops): its op names, the owner's actor (ui/owner.js) and its plugins with
// their views. ops is null until known: hasOp answers true then, so nothing hides before the daemon has said.
const serverInfo = { ops: null, owner: null, plugins: [] };
export async function loadServerInfo() {
  try {
    const r = await fetch('/api/ops', { headers: authHeaders() });
    if (r.ok) { const j = await r.json(); serverInfo.ops = new Set(j.ops ?? []); serverInfo.owner = j.owner ?? null; serverInfo.plugins = Array.isArray(j.plugins) ? j.plugins : []; if (serverInfo.owner) setOwner(serverInfo.owner); }
  } catch { /* an older daemon, or offline: keep the defaults */ }
  return serverInfo;
}
export const hasOp = (op) => serverInfo.ops === null || serverInfo.ops.has(op);
export const pluginViewUrls = () => serverInfo.plugins.flatMap((p) => (Array.isArray(p.views) ? p.views : [])).filter((u) => typeof u === 'string' && u.startsWith('/views/plugin-'));

/**
 * Run one op. `host` defaults to the remembered host; pass {host:'local'} to
 * force the front daemon. FRONT_ONLY ops (host.list, host.probe) ignore host.
 */
export async function call(op, args = {}, { host = getHost(), signal } = {}) {
  if (typeof op !== 'string' || !OP_NAME.test(op)) throw new ApiError(`not an op name: ${JSON.stringify(String(op)).slice(0, 80)}`, { op, badOp: true });
  const body = { ...(args ?? {}) };
  // A direct peer for this host (Settings, Direct peers): talk to its daemon
  // straight from the browser; when it does not answer, fall back to ssh rpc.
  const peer = host && host !== 'local' && !FRONT_ONLY.has(op) ? peerFor(host) : null;
  if (peer) {
    delete body.host;
    try {
      const r = await fetch(`${peer.url}api/op/${op}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${peer.token}` }, body: JSON.stringify(body), signal, mode: 'cors' });
      return await settle(op, host, r);
    } catch (e) {
      if (!e.network && !(e instanceof TypeError)) throw e;
      peerDown.set(host, Date.now());
    }
  }
  if (host && host !== 'local') body.host = host; else delete body.host;
  let res;
  try {
    res = await fetch(`/api/op/${op}`, { method: 'POST', headers: authHeaders(), body: JSON.stringify(body), signal });
  } catch (e) {
    throw new ApiError(`network error: ${e.message}`, { op, network: true });
  }
  return settle(op, host, res);
}
async function settle(op, host, res) {
  let j = null;
  try { j = await res.json(); } catch { /* not JSON */ }
  if (res.status === 401) throw new ApiError('unauthorized: the token was rejected', { op, status: 401 });
  if (!res.ok || !j || j.ok === false) throw new ApiError(j?.error ?? `HTTP ${res.status}`, { op, status: res.status, event: j?.event });
  if (j.cache) lastCache.set(`${op}|${host}`, j.cache);
  return j.result;
}

// ---------------------------------------------------------------- direct peers
// Names and URLs come from the shared settings (settings.peers); tokens live
// only in this browser's localStorage, keyed by peer name.
const FRONT_ONLY = new Set(['host.list', 'host.probe', 'fleet.summary', 'docker.fleet', 'settings.get', 'settings.set', 'settings.reset', 'notify.mute', 'notify.unmute', 'notify.list', 'notify.test']);
const PEER_TOKENS_KEY = 'drover.peerTokens';
let peerConf = { enabled: false, list: [] };
const peerDown = new Map(); // host -> ts of the last failure (skip it for a minute)
export function configurePeers(conf) { peerConf = { enabled: Boolean(conf?.enabled), list: Array.isArray(conf?.list) ? conf.list : [] }; }
export function peerTokens() { try { return JSON.parse(localStorage.getItem(PEER_TOKENS_KEY) || '{}'); } catch { return {}; } }
export function setPeerToken(name, token) { const t = peerTokens(); if (token) t[name] = token; else delete t[name]; localStorage.setItem(PEER_TOKENS_KEY, JSON.stringify(t)); }
export function peerFor(host) {
  if (!peerConf.enabled) return null;
  const p = peerConf.list.find((x) => x.name === host);
  const token = p ? peerTokens()[p.name] : null;
  if (!p || !token) return null;
  if (Date.now() - (peerDown.get(host) ?? 0) < 60_000) return null;
  return { url: p.url.endsWith('/') ? p.url : p.url + '/', token };
}
/** Ask a peer who it is (host.identity), directly, regardless of the enabled switch. */
export async function testPeer(name) {
  const p = peerConf.list.find((x) => x.name === name); const token = peerTokens()[name];
  if (!p) throw new Error('no such peer'); if (!token) throw new Error('no token for this peer in this browser');
  const t0 = Date.now();
  let res; try { res = await fetch(`${p.url}api/op/host.identity`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: '{}', mode: 'cors' }); }
  catch (e) { throw new Error(`no answer (${e.message}); is the port forwarded and the daemon up?`); }
  const j = await res.json().catch(() => null);
  if (res.status === 401) throw new Error('the peer rejected the token');
  if (!res.ok || !j?.ok) throw new Error(j?.error ?? `HTTP ${res.status}`);
  peerDown.delete(name);
  return { ...j.result, ms: Date.now() - t0 };
}
/** Server cache metadata of the last call per op+host ({hit, age, stale, refreshing}). */
export const lastCache = new Map();

// ---------------------------------------------------------------- client-side SWR
// Views call swr(op, args, onData): the last payload for this op+args+host is
// delivered synchronously from sessionStorage (marked stale), then the server
// answer replaces it. Switching tabs therefore paints instantly.
const SWR_PREFIX = 'drover.swr.';
function swrKey(op, args, host) { return SWR_PREFIX + host + '|' + op + '|' + JSON.stringify(args ?? {}); }
export function swrPeek(op, args = {}, host = getHost()) {
  try { const raw = sessionStorage.getItem(swrKey(op, args, host)); if (!raw) return null; const d = JSON.parse(raw); return { result: d.r, ts: d.t, stale: true }; } catch { return null; }
}
export async function swr(op, args = {}, onData, { host = getHost(), signal } = {}) {
  const cached = swrPeek(op, args, host);
  if (cached) { try { onData(cached.result, { stale: true, age: Date.now() - cached.ts, fromClient: true }); } catch (e) { console.error(e); } }
  const result = await call(op, args, { host, signal });
  const meta = lastCache.get(`${op}|${host}`) ?? {};
  try { sessionStorage.setItem(swrKey(op, args, host), JSON.stringify({ r: result, t: Date.now() })); } catch { /* quota; fine */ }
  onData(result, { stale: Boolean(meta.stale), age: meta.age ?? 0, refreshing: Boolean(meta.refreshing), fromClient: false });
  return result;
}
export function swrClear() { for (const k of Object.keys(sessionStorage)) if (k.startsWith(SWR_PREFIX)) sessionStorage.removeItem(k); }

/** Subscribe (on=true) or unsubscribe a Claude session transcript so `turn` SSE events arrive. */
export async function follow(id, on = true) {
  const res = await fetch('/api/follow', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ id, on }) });
  return res.ok;
}

// Every event the daemon can send has a listener here (so the stream stats count it, whatever a daemon sends), but a
// page reacts only to what app.js and its views handle. headless, codex and snapshot-error have no reader in the UI
// (a headless chat is read by the drawer's poll), so app.js's topics leave them out; a view that starts using one
// names it in its `topics`.
const SSE_TYPES = ['hello', 'snapshot', 'snapshot-error', 'fleet', 'board', 'summary', 'probe', 'turn', 'manager', 'headless', 'codex', 'mutation', 'notify', 'alerts', 'settings', 'pair', 'botauth'];
/** Bytes and counts per event type since the page loaded (window.drover.perf.stream). */
export const streamStats = { since: Date.now(), total: 0, events: {} };

/** Device pairing on this daemon (core/pair.js): not ops, so they never ride the host routing. */
async function pairFetch(route, body) {
  const init = { headers: { authorization: `Bearer ${getToken()}` } };
  if (body !== undefined) Object.assign(init, { method: 'POST', body: JSON.stringify(body), headers: { ...init.headers, 'content-type': 'application/json' } });
  const res = await fetch(`/api/pair/${route}`, init);
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.ok === false) throw new Error(j.error ?? `HTTP ${res.status}`);
  return j.result;
}
export const pairPending = () => pairFetch('pending');
export const pairDecide = (code, approve) => pairFetch(approve ? 'approve' : 'deny', { code });

/** Grok bots asking to connect through the bot gateway (core/bots/oauth.js): main token, not ops, like pairing. */
async function botsFetch(route, body) {
  const init = { headers: { authorization: `Bearer ${getToken()}` } };
  if (body !== undefined) Object.assign(init, { method: 'POST', body: JSON.stringify(body), headers: { ...init.headers, 'content-type': 'application/json' } });
  const res = await fetch(`/api/bots/${route}`, init);
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.ok === false) throw new Error(j.error ?? `HTTP ${res.status}`);
  return j.result;
}
export const botsPending = () => botsFetch('pending');
export const botsDecide = (code, approve, bot) => botsFetch(approve ? 'approve' : 'deny', approve ? { code, bot } : { code });
/** Routine setups sent from the gateway's page (core/bots/routine-setup.js), and the owner's answer by their code. */
export const routineSetups = () => botsFetch('routine/pending');
export const routineSetupDecide = (code, approve) => botsFetch(approve ? 'routine/approve' : 'routine/deny', { code });
/** A bot's Routine, set by the owner from the drawer (POST /api/bots/routine), and its connection test. */
export const botRoutines = () => botsFetch('routines');
export const setBotRoutine = (bot, url, key) => botsFetch('routine', { bot, url, key });
export const testBotRoutine = (bot) => botsFetch('routine/test', { bot });

/**
 * Answer a Grok bot's approval request (core/bots/approvals.js): option choice (its n) of request id. A main-token
 * route on the daemon that keeps the bots, never an op, so it does not ride ssh rpc: a bot on another host is answered
 * through that host's direct peer (its own main token), or on its own Drover page. A refusal (already answered,
 * withdrawn, expired) throws with the request as it is now (error.approval).
 */
export async function approvalsAnswer(id, choice, { host = 'local', via = 'web' } = {}) {
  let base = '', token = getToken();
  if (host && host !== 'local') {
    const peer = peerFor(host);
    if (!peer) throw new ApiError(`${host} keeps this bot: answer it on ${host}'s own Drover page, or add ${host} as a direct peer (Settings)`, { remote: true });
    base = peer.url.replace(/\/$/, ''); token = peer.token;
  }
  let res;
  try { res = await fetch(`${base}/api/approvals/answer`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ id, choice, via }), ...(base ? { mode: 'cors' } : {}) }); }
  catch (e) { throw new ApiError(`network error: ${e.message}`, { network: true }); }
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.ok === false) throw new ApiError(j.error ?? `HTTP ${res.status}`, { status: res.status, approval: j.approval ?? null });
  return j.result;
}

/**
 * Open the SSE stream. onEvent(type, data); onState('open'|'reconnecting'|'closed'). topics: a comma list of the
 * events wanted (the daemon then sends only those, plus hello and pings; one that predates topics sends all).
 */
export function openStream(onEvent, onState, { topics } = {}) {
  const es = new EventSource(`/api/stream?token=${encodeURIComponent(getToken())}${topics ? `&topics=${encodeURIComponent(topics)}` : ''}`);
  for (const t of SSE_TYPES) {
    es.addEventListener(t, (e) => {
      const n = e.data?.length ?? 0;
      const st = streamStats.events[t] ??= { n: 0, bytes: 0, max: 0 };
      st.n++; st.bytes += n; st.max = Math.max(st.max, n); streamStats.total += n;
      let d = null;
      try { d = JSON.parse(e.data); } catch { d = e.data; }
      onEvent(t, d);
    });
  }
  es.onopen = () => onState?.('open');
  es.onerror = () => onState?.(es.readyState === EventSource.CLOSED ? 'closed' : 'reconnecting');
  return { es, close: () => es.close() };
}
