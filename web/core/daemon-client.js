// Reach this host's Drover daemon over its HTTP API. The other Drover processes
// on a host (the MCP server, `drover rpc` serving a peer, `drover op`) forward
// work to it, so one process per host does the expensive part (codex readers,
// the search index) and every caller shares its caches. The daemon never calls
// itself: `drover serve` marks itself before it starts.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { stateDir } from './paths.js';

export const _deps = { fetch: (...a) => fetch(...a), stateDir: () => stateDir(), pid: () => process.pid, retryMs: 30_000 };

let selfIsDaemon = false;
/** `drover serve` calls this first, so its own ops run in-process, never over HTTP to itself. */
export function markDaemon() { selfIsDaemon = true; }

// Loopback, or a literal tailnet address (100.64.0.0/10) for a daemon bound to one.
// The token goes nowhere else, so a name like 100.example.com never qualifies.
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost|::1|\[::1\])$/;
function tailnetIPv4(host) {
  const m = /^100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return Boolean(m) && Number(m[1]) >= 64 && Number(m[1]) <= 127 && Number(m[2]) <= 255 && Number(m[3]) <= 255;
}

/** daemon.json and the token from the state dir. Throws when either is missing or the URL is not local. */
export async function readEndpoint({ dir = _deps.stateDir() } = {}) {
  const d = JSON.parse(await readFile(path.join(dir, 'daemon.json'), 'utf8'));
  const token = (await readFile(path.join(dir, 'token'), 'utf8')).trim();
  const host = new URL(d.url).hostname;
  if (!LOOPBACK.test(host) && !tailnetIPv4(host)) throw new Error(`daemon url ${host} is not local`);
  return { url: d.url, token, pid: d.pid };
}

let probe = null; // { at, hit, ep: Promise<endpoint | null> }

/**
 * The daemon's endpoint once it has answered host.identity, else null: not
 * running, not local, unreadable, or this process is the daemon. A found daemon
 * is kept until a call finds it gone; a miss is retried after 30 s, so a daemon
 * that starts later is picked up.
 */
export async function daemonEndpoint({ log } = {}) {
  if (selfIsDaemon) return null;
  if (probe && (probe.hit || Date.now() - probe.at < _deps.retryMs)) return probe.ep;
  const p = { at: Date.now(), hit: false, ep: null };
  p.ep = (async () => {
    try {
      const ep = await readEndpoint();
      if (ep.pid === _deps.pid()) return null;
      try { process.kill(ep.pid, 0); } catch (e) { if (e.code !== 'EPERM') return null; }
      const res = await _deps.fetch(new URL('api/op/host.identity', ep.url), { headers: { authorization: `Bearer ${ep.token}` }, signal: AbortSignal.timeout(3000) });
      if (!res.ok) return null;
      p.hit = true;
      log?.('using daemon at', ep.url);
      return ep;
    } catch { return null; }
  })();
  probe = p;
  return p.ep;
}

/** Drop the remembered endpoint; the next daemonEndpoint() probes again. */
export function forgetEndpoint() { probe = null; }

/**
 * An op name as the daemon's POST /api/op/<op> route takes it: dot-separated
 * words. URL resolution would let anything else steer the request to another
 * route, since `..`, `%2e%2e` and `\` all act as path segments: the op
 * `../pair/approve` would POST /api/pair/approve, which is deliberately not an
 * op, with the main token. MCP's drover_op passes model-chosen names here.
 */
export const OP_NAME = /^[a-zA-Z]+(?:\.[a-zA-Z]+)*$/;

function opUrl(ep, op) {
  const refuse = () => Object.assign(new Error(`refused: ${JSON.stringify(String(op)).slice(0, 80)} is not an op name`), { badOp: true });
  if (typeof op !== 'string' || !OP_NAME.test(op)) throw refuse();
  const base = new URL('./', ep.url);
  const url = new URL(`api/op/${op}`, base);
  if (url.origin !== base.origin || url.pathname !== `${base.pathname}api/op/${op}`) throw refuse();
  return url;
}

/**
 * POST an op to the daemon. The error says what happened, so the caller can
 * decide whether running the op itself is safe:
 *  - badOp: the name is not an op; nothing was sent;
 *  - unreachable: no answer (connection failed or dropped) or the token was
 *    refused; the endpoint is forgotten, so the next call probes again;
 *  - timedOut: no answer in time, though the daemon may still be working on it;
 *  - incomplete: a 2xx whose body was cut off or unreadable; the op may have run;
 *  - fromDaemon: the daemon ran the op and reported this error (status set).
 */
export async function callDaemon(ep, op, args, { timeoutMs = 45_000, fetchFn = _deps.fetch } = {}) {
  const url = opUrl(ep, op);
  let res;
  try {
    res = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ep.token}` }, body: JSON.stringify(args ?? {}), signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw Object.assign(new Error(`daemon did not answer ${op} within ${timeoutMs} ms`), { timedOut: true });
    forgetEndpoint();
    throw Object.assign(new Error(`daemon not reachable: ${e?.cause?.code ?? e?.message ?? e}`), { unreachable: true });
  }
  // 401 is the token check; a 403 is an op that refused (files.write outside the roots) and stays fromDaemon.
  if (res.status === 401) {
    forgetEndpoint();
    throw Object.assign(new Error('daemon refused the token (HTTP 401)'), { unreachable: true });
  }
  let body;
  try { body = await res.json(); }
  catch (e) {
    if (!res.ok) throw Object.assign(new Error(`daemon answered HTTP ${res.status}`), { fromDaemon: true, status: res.status });
    // Never a silent success: the answer was lost after the headers, and the op may have run.
    throw Object.assign(new Error(`daemon answer to ${op} was cut off: ${e?.message ?? e}`), { incomplete: true, timedOut: e?.name === 'TimeoutError' || e?.name === 'AbortError' });
  }
  if (!res.ok || body?.ok === false) throw Object.assign(new Error(body?.error ?? `daemon answered HTTP ${res.status}`), { fromDaemon: true, status: res.status });
  return body?.result;
}
