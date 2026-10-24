// Remote search sources (core/plugins.js search.remote): entries a plugin fetches at query time from a service of its
// own, such as the Badland brain (kind brain), and that no host ever indexes. Only a front asks them, and only when the
// call says so (remote: true, which the MCP server, drover search, drover op and the web UI add): a call without it, a
// search a host gets over rpc or one from a client older than this guard, searches the index alone, so nothing that
// predates the work guard can ever send a query out. The front is the process that answers the search. It asks each
// source once per query, beside its own index search or the fleet fan-out, under DROVER_SEARCH_REMOTE_TIMEOUT_MS
// (default 5000), and every index search it sends on carries remote: false, so the host (or this host's daemon,
// reached over HTTP) that runs that search does not ask them again. The two lists are fused by rank, since the
// index's scores and a remote service's (other embeddings, another ranking) do not compare: a hit at 0-based position
// p of its own list scores 1 / (61 + p). A source that is slow or fails leaves the index's answer as it was.
//
// The work guard runs first, so a query never leaves the machine when this machine's dotfiles identity is work
// (DF_IDENTITY in the environment or ~/.df-profile), when the query, the project or checkout it is scoped to, a host it
// names or the caller's working directory (callerCwd, set by the MCP server and the CLI) looks like work
// (WORK_CONTEXT, the pattern scripts/brain-sync in the dotfiles keeps work out of the brain with), or when
// DROVER_SEARCH_<KIND>=off (DROVER_SEARCH_BRAIN=off for the brain). Tests: test/search-remote.test.js.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import * as plugins from '../plugins.js';
import { envvar } from '../envvars.js';
import { REMOTE_KINDS, snippet } from './query.js';

/** Injection points: tests give their own environment, home directory and clock. */
export const _deps = { env: process.env, home: () => process.env.HOME || homedir(), now: () => Date.now() };

/** What looks like work (employer, ACME) content, as the dotfiles' scripts/brain-sync matches it. */
export const WORK_CONTEXT = /\b(acme|ini-?tech|initech|onedrive-ini-tech|acme-dev\w*|privcloud|us-priv|acme-beta|wk\d{6}\w*|dev ?pods?|nexus)\b/i;
/** The fields of a search call the work guard reads, in the order it reports them. */
const CONTEXT_FIELDS = ['query', 'project', 'repoIdentity', 'callerCwd', 'host', 'hosts'];
/** Filters only the index's own records can meet (a checkout's chunks, a session's, a reflection's status): no remote source is asked. */
const LOCAL_ONLY = ['repoIdentity', 'session', 'status'];
const RRF_K = 61;
const DEFAULT_TIMEOUT_MS = 5_000;
// Keys of an index hit that point at a record on a host (a transcript, a chunk, a checkout): a remote hit never has them.
const HOST_RECORD_KEYS = ['sessionId', 'path', 'cwd', 'provenance', 'hash', 'legs', 'route', 'hosts', 'origins', 'copies'];

const list = (v) => (Array.isArray(v) ? v : v ? String(v).split(',') : []).map((x) => String(x).trim()).filter(Boolean);
const given = (v) => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== '');
const off = (v) => /^(0|off|false|no)$/i.test(String(v ?? '').trim());
const clampLimit = (v) => Math.max(1, Math.min(100, Number(v) || 20));

/** Whether this machine's dotfiles identity is work: DF_IDENTITY in the environment or in ~/.df-profile, either one. */
export function workIdentity(env = _deps.env, home = _deps.home()) {
  if (/^work$/i.test(String(env.DF_IDENTITY ?? '').trim())) return true;
  try { return /DF_IDENTITY=["']?work\b/i.test(readFileSync(path.join(home, '.df-profile'), 'utf8')); } catch { return false; }
}

/** The first field of a search call that looks like work (CONTEXT_FIELDS), or null. */
export function workContext(fields = {}) {
  for (const k of CONTEXT_FIELDS) for (const v of [fields[k]].flat()) if (typeof v === 'string' && WORK_CONTEXT.test(v)) return k;
  return null;
}

/** DROVER_SEARCH_<KIND> (DROVER_SEARCH_BRAIN for kind brain): off, 0, false or no keeps that source from being asked. */
export const remoteEnabled = (kind, env = _deps.env) => !off(envvar(`SEARCH_${kind.toUpperCase().replace(/-/g, '_')}`, env));

/** DROVER_SEARCH_REMOTE_TIMEOUT_MS: how long a front waits for a remote source, default 5000, at most a minute. */
export function remoteTimeoutMs(env = _deps.env) {
  const n = Number(envvar('SEARCH_REMOTE_TIMEOUT_MS', env));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 60_000) : DEFAULT_TIMEOUT_MS;
}

/** Whether a search call asks for its remote sources: only remote: true does (the front entry points add it). */
export const frontCall = (args = {}) => args.remote === true || args.remote === 'true';

/** Why a remote kind is not asked for this call ({ reason, field? }), or null when it may be. */
export function blocked(kind, args = {}, where = {}) {
  if (!remoteEnabled(kind)) return { reason: 'disabled' };
  if (workIdentity()) return { reason: 'work identity' };
  const field = workContext({ ...args, ...where });
  if (field) return { reason: 'work context', field };
  const scope = LOCAL_ONLY.find((k) => given(args[k]));
  return scope ? { reason: `scoped by ${scope}` } : null;
}

/**
 * A source's hit as a search hit: kind and host are the source's kind, title and snippet one line each (the index's
 * snippet length), ts an ISO time or null, score a number or null; keys that point at a record on a host are dropped.
 * Everything else the plugin mapped (slug, namespace, author...) is kept.
 */
export function normalizeHit(kind, h) {
  if (!h || typeof h !== 'object' || Array.isArray(h)) return null;
  const out = { ...h };
  for (const k of HOST_RECORD_KEYS) delete out[k];
  const line = (v, max) => (typeof v === 'string' && v.trim() ? snippet(v, [], max) : null);
  return {
    ...out, kind, host: kind, title: line(h.title, 200), snippet: line(h.snippet, 320) ?? '',
    ts: typeof h.ts === 'string' && Number.isFinite(Date.parse(h.ts)) ? h.ts : null,
    role: typeof h.role === 'string' && h.role ? h.role : null,
    score: typeof h.score === 'number' && Number.isFinite(h.score) ? h.score : null,
  };
}

/** The call's own filters a remote hit can be checked against: days (its ts) and role. */
function keeps({ days, role } = {}) {
  const since = Number(days) > 0 ? _deps.now() - Number(days) * 86400_000 : null;
  return (h) => (since === null || (h.ts !== null && Date.parse(h.ts) >= since)) && (!role || h.role === String(role));
}

const TIMED_OUT = Symbol('timed out');
/**
 * Ask one source; never rejects. { status, hits }: status is what the answer's remote.<kind> says. The source also gets
 * signal, aborted once the front stops waiting, so a request still in flight does not keep a one-shot process (drover
 * search, drover op) alive after it has answered.
 */
async function ask(kind, fn, q, filters, timeoutMs) {
  const t0 = _deps.now();
  const stop = new AbortController();
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs, TIMED_OUT); });
  try {
    const r = await Promise.race([Promise.resolve().then(() => fn({ ...q, signal: stop.signal })), late]);
    const ms = _deps.now() - t0;
    if (r === TIMED_OUT) { stop.abort(); return { status: { included: false, reason: 'timeout', ms }, hits: [] }; }
    const hits = (Array.isArray(r?.hits) ? r.hits : []).map((h) => normalizeHit(kind, h)).filter(Boolean).filter(keeps(filters)).slice(0, q.limit);
    return { status: { included: true, hits: hits.length, ms, ...(typeof r?.note === 'string' && r.note ? { note: r.note.slice(0, 300) } : {}) }, hits };
  } catch (e) {
    return { status: { included: false, reason: String(e?.message ?? e).slice(0, 300) || 'failed', ms: _deps.now() - t0 }, hits: [] };
  } finally { clearTimeout(timer); }
}

/**
 * Start the remote leg of a search at the front. args: the search's own (query, limit, kinds, days, project, role,
 * session, status, repoIdentity, callerCwd...); where: the host or hosts the call names. Returns
 * { local, localArgs, done }: local is false when the call asks for remote kinds only (no index search at all);
 * localArgs are what every index search gets (callerCwd dropped, remote kinds taken out of kinds, remote: false); done
 * resolves, never rejects, to { remote, lists }: remote is kind -> { included: true, hits, ms } or { included: false,
 * reason }, undefined when no remote kind was in play (kinds without one, or no plugin serves it and the call did not
 * name it), and lists the hits of each source that answered.
 */
export function begin(args = {}, where = {}) {
  const { callerCwd, remote, ...rest } = args;
  const front = frontCall({ remote });
  const asked = list(rest.kinds);
  const localKinds = asked.filter((k) => !REMOTE_KINDS.includes(k));
  const local = !asked.length || localKinds.length > 0;
  const localArgs = { ...rest, ...(asked.length ? { kinds: localKinds } : {}), remote: false };
  const sources = plugins.remoteSearchSources();
  const legs = [];
  for (const kind of REMOTE_KINDS.filter((k) => !asked.length || asked.includes(k))) {
    const fn = sources[kind];
    const absent = !front ? 'not asked (the call did not say remote: true)' : typeof fn !== 'function' ? 'no source' : null;
    if (absent) { if (asked.includes(kind)) legs.push([kind, Promise.resolve({ status: { included: false, reason: absent }, hits: [] })]); continue; }
    const no = blocked(kind, { ...rest, callerCwd }, where);
    if (no) { legs.push([kind, Promise.resolve({ status: { included: false, ...no }, hits: [] })]); continue; }
    const q = { query: String(rest.query ?? ''), limit: clampLimit(rest.limit), ...(asked.length ? { kinds: asked } : {}), ...(Number(rest.days) > 0 ? { days: Number(rest.days) } : {}), ...(typeof rest.project === 'string' && rest.project ? { project: rest.project } : {}) };
    legs.push([kind, ask(kind, fn, q, rest, remoteTimeoutMs())]);
  }
  const done = Promise.all(legs.map(([, p]) => p)).then((answers) => ({
    remote: legs.length ? Object.fromEntries(legs.map(([kind], i) => [kind, answers[i].status])) : undefined,
    lists: answers.map((a) => a.hits).filter((h) => h.length),
  }));
  return { local, localArgs, done };
}

/**
 * Fuse the index's hits with each remote source's by rank: a hit at 0-based position p of its own list scores
 * 1 / (61 + p), the index's hit first on a tie, and limit are kept. score becomes that fused score; sourceScore keeps
 * the score the hit had in its own list.
 */
export function fuse(local = [], remote = [], limit = 20) {
  const all = [local, ...remote].flatMap((hits, li) => hits.map((r, p) => ({ r, s: 1 / (RRF_K + p), li, p })));
  all.sort((a, b) => b.s - a.s || a.li - b.li || a.p - b.p);
  return all.slice(0, clampLimit(limit)).map(({ r, s }) => ({ ...r, score: Number(s.toFixed(6)), sourceScore: typeof r.score === 'number' ? r.score : null }));
}

/** The index's hits with the remote ones fused in, or the index's own list unchanged when no source answered with any. */
export function withRemote(local, lists, limit) {
  return lists.some((l) => l.length) ? fuse(local, lists, limit) : local;
}
