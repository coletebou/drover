// Codex adapter: JSON-RPC client over `codex app-server proxy` (stdio to the
// running daemon), thread listing/reading, sending turns, plus rollout JSONL
// reading and interactive spawn argv.
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { startLines, run } from './proc.js';
import { checkEffort } from './effort.js';
import { envvar } from './envvars.js';
import { toolSummary, resultEntry, codexOutputFailed } from './toolcalls.js';

export const CODEX_HOME = process.env.CODEX_HOME ?? path.join(process.env.HOME, '.codex');
const SESSIONS_DIR = path.join(CODEX_HOME, 'sessions');

/**
 * Minimal JSON-RPC 2.0 client over a stdio `codex app-server` we own.
 * Why not `codex app-server proxy` to the shared daemon: its control socket
 * does not answer JSON-RPC (verified 0.162.1: connects, never replies). Thread
 * list/read are DB reads so our own server sees every thread; delivery into a
 * thread that the TUI daemon owns goes through `codex queue` (see sendTurn).
 */
export class AppServerClient {
  constructor({ onNotification, onExit } = {}) {
    this.nextId = 1; this.pending = new Map(); this.onNotification = onNotification; this.onExit = onExit;
    this.child = null; this.initialized = null;
  }
  start() {
    if (this.child) return;
    if (this.stopped) throw new Error('app-server client was stopped');
    this.child = startLines('codex', ['app-server'], {
      onLine: (l) => this.#onLine(l),
      onStderr: (d) => { this.lastStderr = d; },
      onExit: (code, sig) => { this.child = null; this.initialized = null; for (const [, p] of this.pending) p.reject(new Error(`app-server proxy exited (${code ?? sig})`)); this.pending.clear(); this.onExit?.(code, sig); },
    });
  }
  #onLine(line) {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id); if (!p) return; this.pending.delete(msg.id);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message ?? 'rpc error'), { rpc: msg.error })); else p.resolve(msg.result);
      return;
    }
    if (msg.method) {
      if (msg.id !== undefined) {
        // Server request (approval etc.). We never approve on the user's behalf; decline politely.
        this.#respondToServerRequest(msg);
        return;
      }
      this.onNotification?.(msg.method, msg.params);
    }
  }
  #respondToServerRequest(msg) {
    this.onNotification?.('serverRequest', { method: msg.method, params: msg.params, id: msg.id });
    const decision = { decision: 'denied' };
    this.child?.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: decision }) + '\n');
  }
  request(method, params = {}, { timeoutMs = 60_000 } = {}) {
    // A caller handed this client before it was stopped (a background list refresh as
    // `drover op` exits) gets a rejection, not a write after stdin closed, which throws.
    if (this.stopped) return Promise.reject(new Error(`app-server stopped before ${method}`));
    this.start();
    rpcCounts.set(method, (rpcCounts.get(method) ?? 0) + 1);
    const id = this.nextId++;
    const p = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    });
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return p;
  }
  notify(method, params = {}) {
    if (this.stopped) return;
    this.start();
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }
  async init() {
    if (!this.initialized) {
      this.initialized = (async () => {
        const res = await this.request('initialize', { clientInfo: { name: 'drover', title: 'drover', version: '0.1.0' }, capabilities: { experimentalApi: true } }, { timeoutMs: 20_000 });
        this.notify('initialized', {});
        return res;
      })().catch((e) => { this.initialized = null; throw e; });
    }
    return this.initialized;
  }
  stop() { this.stopped = true; if (this.child) { try { this.child.stdin.end(); } catch { /* closed */ } this.child.kill('SIGTERM'); } }
}

/** RPC calls since the last log line; one line a minute names what is driving the app-server. */
const rpcCounts = new Map();
const rpcLog = setInterval(() => {
  if (!rpcCounts.size) return;
  process.stderr.write(`[codex-rpc] ${[...rpcCounts].map(([m, n]) => `${m}=${n}`).join(' ')}\n`); rpcCounts.clear();
}, 60_000);
rpcLog.unref?.();

let shared = null;
const listeners = new Set();
export function sharedClient() {
  if (!shared || shared.stopped) {
    // onExit clears only its own client: a stopped one exiting late must not drop its replacement.
    const c = new AppServerClient({
      onNotification: (m, p) => { for (const l of listeners) { try { l(m, p); } catch { /* listener error */ } } },
      onExit: () => { if (shared === c) shared = null; },
    });
    shared = c;
  }
  return shared;
}
export function onNotification(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/**
 * A separate app-server for read-only thread/list and thread/read. Each read
 * loads that thread into the server and it stays resident: under the daemon's
 * polling one grew to 12 GB in 30 minutes (2026-10-15) and starved the Mac
 * into watchdog panics. Reads keep no state, so this client is retired once it
 * is old, idle, too big or out of calls; headless threads stay on sharedClient()
 * and are never cut.
 *
 * Waiting for a big reader to be idle was not enough. On 2026-10-17 every read
 * was slow under memory pressure, so a polled reader almost never was, and
 * three of them (the daemon's plus one per peer `drover rpc`) passed 2 GB each
 * until the Mac's WindowServer hit its watchdog. A reader that is out of calls
 * or too big is now taken out of service at once and stops when its last request
 * settles. The call budget is the bound that holds even when the memory probe
 * itself times out. Measured that night: a fresh reader went from 73 MiB to
 * 680 MiB on its first 40-thread thread/list and to about 1 GiB on the second,
 * and a warm reader listed no faster (18-39 s a call), so reuse buys nothing.
 */
const readMaxAgeMs = () => Number(envvar('CODEX_READ_MAX_AGE_MS') ?? 600_000);
const readIdleMs = () => Number(envvar('CODEX_READ_IDLE_MS') ?? 120_000);
const readMaxMb = () => Number(envvar('CODEX_READ_MAX_MB') ?? 1536);
const readMaxCalls = () => Number(envvar('CODEX_READ_MAX_CALLS') ?? 2);
const readKillGraceMs = () => Number(envvar('CODEX_READ_KILL_GRACE_MS') ?? 5_000);

/** rootPid and its descendants, from one `ps` listing. */
async function treePids(rootPid) {
  const { stdout } = await run('ps', ['-axo', 'pid=,ppid='], { timeoutMs: 5_000 });
  const kids = new Map();
  for (const l of stdout.trim().split('\n')) { const [pid, ppid] = l.trim().split(/\s+/).map(Number); if (!kids.has(ppid)) kids.set(ppid, []); kids.get(ppid).push(pid); }
  const pids = []; const q = [rootPid];
  while (q.length) { const x = q.pop(); pids.push(x); q.push(...(kids.get(x) ?? [])); }
  return pids;
}

/**
 * Memory of a process tree in MiB. The app-server's native child keeps most of
 * its growth compressed, which `ps` RSS does not show, so macOS reads top's MEM.
 */
export async function treeMemoryMb(rootPid) {
  if (!rootPid) return 0;
  const pids = await treePids(rootPid);
  if (process.platform === 'darwin') {
    const { stdout: t } = await run('top', ['-l', '1', '-stats', 'pid,mem', ...pids.flatMap((x) => ['-pid', String(x)])], { timeoutMs: 10_000 });
    let mb = 0;
    for (const l of t.split('\n')) {
      const m = l.trim().match(/^(\d+)\s+([\d.]+)([KMGB])\+?-?$/); if (!m || !pids.includes(Number(m[1]))) continue;
      mb += Number(m[2]) * ({ K: 1 / 1024, M: 1, G: 1024, B: 1 / 1048576 })[m[3]];
    }
    return mb;
  }
  let kb = 0;
  for (const x of pids) { try { const st = await readFile(`/proc/${x}/status`, 'utf8'); kb += Number(st.match(/VmRSS:\s+(\d+)/)?.[1] ?? 0); } catch { /* exited */ } }
  return kb / 1024;
}
let reader = null; let readerBorn = 0; let readerUsed = 0; let readerCalls = 0; let reaper = null;
/** Retired readers, each stopped once nothing is in flight on it; every request times out, so that always comes. */
const draining = new Set();
let drainScheduled = false;
function retireReader() { if (reader) draining.add(reader); reader = null; scheduleDrain(); }
/**
 * Stops run a turn later, not inside the call that retired the reader: a caller
 * handed it in the same turn sends its request from a microtask, which runs
 * first, so it is never cut or written to after stdin has closed.
 */
function scheduleDrain() {
  if (drainScheduled || !draining.size) return;
  drainScheduled = true;
  setImmediate(() => {
    drainScheduled = false;
    for (const r of draining) if (!r.pending.size) { draining.delete(r); stopReader(r); }
  });
}
/**
 * SIGTERM, then SIGKILL for the tree if it outlives the grace period: a
 * thrashing Mac took over 10 s to deliver SIGTERM to a reader, and a reader
 * keeps no state. The tree is listed only when the grace period ends, from the
 * npm shim we spawned. Until Node sees the shim exit its pid cannot be reused,
 * and the shim forwards SIGTERM to its native server and waits for it, so the
 * server is still its child. A failed listing is tried again a period later.
 */
function stopReader(r) {
  const child = r.child;
  r.stop();
  if (child) killIfLingering(child);
}
function killIfLingering(child) {
  const lingering = () => child.exitCode === null && child.signalCode === null;
  setTimeout(async () => {
    if (!lingering()) return;
    const tree = await treePids(child.pid).catch(() => null);
    if (!lingering()) return;
    if (!tree) { killIfLingering(child); return; }
    for (const p of tree) { try { process.kill(p, 'SIGKILL'); } catch { /* exited */ } }
  }, readKillGraceMs()).unref?.();
}
function readerExpired(now) {
  return reader && reader.pending.size === 0 && (now - readerBorn >= readMaxAgeMs() || now - readerUsed >= readIdleMs());
}
export function readClient() {
  const now = Date.now();
  scheduleDrain();
  if (reader && (readerCalls >= readMaxCalls() || (reader.pending.size === 0 && now - readerBorn >= readMaxAgeMs()))) retireReader();
  if (!reader) {
    const c = new AppServerClient({ onExit: () => { if (reader === c) reader = null; } });
    reader = c; readerBorn = now; readerCalls = 0;
    if (!reaper) {
      reaper = setInterval(async () => {
        scheduleDrain();
        // A spent reader goes here too, rather than staying resident until the next caller.
        if (readerExpired(Date.now()) || (reader && readerCalls >= readMaxCalls())) { retireReader(); return; }
        const r = reader; if (!r?.child?.pid) return;
        // A probe that fails counts as too big: under the pressure this guards against, `top` is what times out.
        const mb = await treeMemoryMb(r.child.pid).catch(() => Infinity);
        if (mb > readMaxMb() && reader === r) { process.stderr.write(`[codex-read] retiring reader at ${Number.isFinite(mb) ? `${Math.round(mb)} MiB` : 'unmeasured size'}\n`); retireReader(); }
      }, 30_000);
      reaper.unref?.();
    }
  }
  readerUsed = now; readerCalls += 1;
  return reader;
}
export function stopReadClient() {
  for (const r of draining) r.stop();
  draining.clear();
  reader?.stop(); reader = null;
  if (reaper) { clearInterval(reaper); reaper = null; }
}

export async function daemonStatus() {
  try {
    const { stdout } = await run('codex', ['app-server', 'daemon', 'version'], { timeoutMs: 10_000 });
    return JSON.parse(stdout);
  } catch (e) { return { status: 'unavailable', error: String(e.message ?? e) }; }
}

function normThread(t) {
  return {
    kind: 'codex', threadId: t.id ?? t.threadId, name: t.name ?? t.title ?? null, cwd: t.cwd ?? null,
    status: typeof t.status === 'string' ? t.status : (t.status?.type ?? t.status?.kind ?? 'unknown'),
    model: t.model ?? null, modelProvider: t.modelProvider ?? null, createdAt: t.createdAt ?? null, updatedAt: t.updatedAt ?? null,
    preview: t.preview ?? null, source: t.source ?? t.sourceKind ?? null, raw: undefined,
  };
}

/**
 * Each thread/list grows the app-server by about 130 MB (measured 2026-10-15:
 * 7 calls a minute took it to 959 MB in 90 s), took 18-39 s a call under memory
 * pressure on 2026-10-18, and every Drover view polls it. So listings are
 * stale-while-revalidate: a list younger than the TTL is reused; an older one, up
 * to the max stale age, comes back at once while one refresh per key runs behind
 * it; a failed refresh keeps serving the last good list and waits a TTL before
 * the next try. Only the first call for a key (or one past the max stale age) waits.
 */
const LIST_TTL_MS = () => Number(envvar('CODEX_LIST_TTL_MS') ?? 30_000);
const LIST_MAX_STALE_MS = () => Number(envvar('CODEX_LIST_MAX_STALE_MS') ?? 600_000);
const listCache = new Map(); // key -> { at, value, loading, failedAt }
export function clearListCache() { listCache.clear(); }
export async function listThreads(opts = {}) {
  const key = JSON.stringify([opts.limit ?? 50, opts.cwd ?? null, !!opts.includeArchived]);
  let entry = listCache.get(key);
  if (!entry) { entry = { at: 0, value: undefined, loading: null, failedAt: 0 }; listCache.set(key, entry); }
  const now = Date.now(); const age = now - entry.at;
  if (entry.value === undefined || age >= LIST_MAX_STALE_MS()) return loadList(entry, opts);
  if (age >= LIST_TTL_MS() && !entry.loading && now - entry.failedAt >= LIST_TTL_MS()) {
    loadList(entry, opts).catch((e) => {
      entry.failedAt = Date.now();
      process.stderr.write(`[codex-list] refresh failed, serving the list from ${Math.round(age / 1000)} s ago: ${e.message}\n`);
    });
  }
  return entry.value;
}
/** One thread/list per key at a time; concurrent callers share it. */
function loadList(entry, opts) {
  if (!entry.loading) {
    entry.loading = listThreadsUncached(opts)
      .then((value) => { entry.at = Date.now(); entry.value = value; entry.failedAt = 0; return value; })
      .finally(() => { entry.loading = null; });
  }
  return entry.loading;
}
async function listThreadsUncached({ limit = 50, cwd, includeArchived = false } = {}) {
  const c = readClient(); await c.init();
  const res = await c.request('thread/list', { limit, ...(cwd ? { cwd } : {}), ...(includeArchived ? { archived: true } : {}), sortKey: 'updated_at', sortDirection: 'desc' }, { timeoutMs: 30_000 });
  const items = res?.data ?? res?.threads ?? res?.items ?? [];
  // Headless threads live on the shared server; ask it too, without starting one.
  const loadedSet = new Set();
  for (const server of [c, shared?.child ? shared : null]) {
    if (!server) continue;
    try {
      const l = await server.request('thread/loaded/list', {}, { timeoutMs: 10_000 });
      for (const x of l?.threadIds ?? l?.data ?? []) loadedSet.add(typeof x === 'string' ? x : x.id ?? x.threadId);
    } catch { /* optional */ }
  }
  return items.map((t) => ({ ...normThread(t), loaded: loadedSet.has(t.id ?? t.threadId) }));
}

export async function readThread(threadId, { includeTurns = true } = {}) {
  const c = readClient(); await c.init();
  const res = await c.request('thread/read', { threadId, includeTurns }, { timeoutMs: 30_000 });
  return res;
}

/** Flatten a thread/read result into chat turns the UI can show. */
export function threadToTurns(res) {
  const thread = res?.thread ?? res;
  const turns = [];
  for (const turn of thread?.turns ?? []) {
    for (const item of turn.items ?? []) {
      const t = item.type ?? item.kind;
      if (t === 'userMessage' || t === 'user_message') turns.push({ role: 'user', ts: item.createdAt ?? turn.createdAt, text: textOf(item.content ?? item.text) });
      else if (t === 'agentMessage' || t === 'agent_message') turns.push({ role: 'assistant', ts: item.createdAt ?? turn.createdAt, text: textOf(item.content ?? item.text) });
      else if (t === 'commandExecution' || t === 'command_execution') pushItemCall(turns, item, 'shell', { command: item.command ?? '' }, item.aggregatedOutput ?? item.output, item.exitCode != null && item.exitCode !== 0);
      else if (t === 'fileChange' || t === 'file_change') pushItemCall(turns, item, 'apply_patch', { files: (item.changes ?? []).map((c) => c.path) }, null, item.status === 'failed');
    }
  }
  return turns;
}

/** An app-server command or file change as a call turn (and its output, when the item carries one). */
function pushItemCall(turns, item, name, input, output, failed) {
  const summary = name === 'apply_patch' ? toolSummary('Write', { file_path: input.files.join(', ') }) : toolSummary(name, input);
  turns.push({ role: 'assistant', ts: item.createdAt, text: '', tools: [{ id: item.id ?? null, name, input, summary }] });
  if (output != null || failed) { const e = resultEntry(item.id ?? null, output ?? ''); e.isError = Boolean(failed); turns.push({ role: 'tool_result', ts: item.createdAt, count: 1, text: (failed ? '[error] ' : '') + e.text.slice(0, 400), results: [e] }); }
}
function textOf(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => (typeof b === 'string' ? b : b.text ?? '')).join('');
  return c?.text ?? '';
}

/** Threads this process started (headless); turns go straight to our server. */
const owned = new Set();

/**
 * Deliver a user message into an existing thread.
 * - Owned (headless, started here): turn/start on our server.
 * - Anything else (an interactive TUI, another daemon): `codex queue --thread`,
 *   which hands the message to whatever process runs that thread.
 */
export async function sendTurn(threadId, text, { cwd, model } = {}) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('empty message');
  if (!/^[0-9a-f-]{36}$|^[A-Za-z0-9_.-]{1,80}$/.test(threadId)) throw new Error('bad threadId');
  if (owned.has(threadId)) {
    const c = sharedClient(); await c.init();
    const res = await c.request('turn/start', { threadId, input: [{ type: 'text', text }], ...(cwd ? { cwd } : {}), ...(model ? { model } : {}) }, { timeoutMs: 30_000 });
    return { ok: true, via: 'turn/start', turnId: res?.turn?.id ?? res?.turnId ?? null };
  }
  const { stdout } = await run('codex', queueArgv(threadId, text), { timeoutMs: 30_000 });
  return { ok: true, via: 'codex queue', detail: stdout.trim().slice(0, 300) };
}

/**
 * `codex queue` argv. Both values are bound with "=": as a separate value, a message that starts with "-" was
 * refused ("unexpected argument '--version' found", 0.162.1), so it never arrived; the id check above lets a
 * leading "-" through too.
 */
export function queueArgv(threadId, text) {
  return ['queue', `--thread=${threadId}`, `--message=${text}`];
}

export async function steerTurn(threadId, text) {
  const c = sharedClient(); await c.init();
  return c.request('turn/steer', { threadId, input: [{ type: 'text', text }] }, { timeoutMs: 30_000 });
}

export async function interruptTurn(threadId, turnId) {
  const c = sharedClient(); await c.init();
  return c.request('turn/interrupt', { threadId, ...(turnId ? { turnId } : {}) }, { timeoutMs: 15_000 });
}

/**
 * Effort for one Codex session, as config overrides: `-c model_reasoning_effort="<level>"` on the command line
 * (verified on 0.162.1: it wins over a -p profile's own value, composes with -m, and applies on `resume`,
 * where Codex then takes the model from the profile or config instead of the thread) and the same key in
 * thread/start's config for a headless thread. [] / {} when not asked for. Throws for a level not in the list:
 * Codex itself would accept any string.
 */
export function effortArgv(effort) {
  const e = checkEffort('codex', effort);
  return e ? ['-c', `model_reasoning_effort="${e}"`] : [];
}
export function effortConfig(effort) {
  const e = checkEffort('codex', effort);
  return e ? { model_reasoning_effort: e } : {};
}

/**
 * Model slug -> the reasoning levels it supports, from the JSON `codex debug models` prints (0.162.1:
 * models[].slug and models[].supported_reasoning_levels[].effort). Models that list no levels are left out,
 * so a launch with them falls back to the engine list. Pure.
 */
export function catalogEfforts(catalog) {
  const out = new Map();
  for (const m of Array.isArray(catalog?.models) ? catalog.models : []) {
    if (typeof m?.slug !== 'string') continue;
    const levels = (Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : [])
      .map((l) => (typeof l === 'string' ? l : l?.effort)).filter((x) => typeof x === 'string');
    if (levels.length) out.set(m.slug, levels);
  }
  return out;
}

/**
 * This host's Codex model catalog as slug -> levels, from `codex debug models` (about 0.1 s, 0.5 MB). It is the
 * base config's catalog: `debug models` refuses -p, and the profiles' own catalogs (<profile>.models.json) listed
 * the same levels for the models they shared when this was checked (2026-10-16). Cached for 10 minutes; null when it cannot be read, which means the engine list applies.
 */
let catalogCache = null;
export async function modelEfforts({ maxAgeMs = 600_000 } = {}) {
  if (catalogCache && Date.now() - catalogCache.at < maxAgeMs) return catalogCache.map;
  try {
    const { stdout } = await run('codex', ['debug', 'models'], { timeoutMs: 20_000 });
    const map = catalogEfforts(JSON.parse(stdout));
    catalogCache = { at: Date.now(), map };
    return map;
  } catch { return null; }
}

/**
 * thread/start params for a headless thread. Without an effort or profileConfig there is no config key at all.
 * No sessionStartSource: it is an enum (startup | clear), and the custom value sent before ("apx-web", then
 * "drover") made Codex 0.162.1 refuse every headless launch with "unknown variant". Omitted, Codex uses its
 * own default. (threadSource, the free-form label, changes nothing visible: the thread's source stays the
 * app-server's own.) approvalPolicy and sandbox are what they always were.
 */
export function threadStartParams({ cwd, model, effort, approvalPolicy = 'never', sandbox = 'danger-full-access', profileConfig } = {}) {
  const config = { ...(profileConfig ?? {}), ...effortConfig(effort) };
  return { cwd, ...(model ? { model } : {}), approvalPolicy, sandbox, ...(Object.keys(config).length ? { config } : {}) };
}

/** Start a headless thread (outside tmux) and optionally send the first turn. */
export async function startThread({ cwd, model, effort, approvalPolicy = 'never', sandbox = 'danger-full-access', prompt, profileConfig } = {}) {
  const params = threadStartParams({ cwd, model, effort, approvalPolicy, sandbox, profileConfig });
  const c = sharedClient(); await c.init();
  const res = await c.request('thread/start', params, { timeoutMs: 60_000 });
  const threadId = res?.thread?.id ?? res?.threadId;
  if (threadId) owned.add(threadId);
  let turnId = null;
  if (prompt && threadId) {
    const t = await c.request('turn/start', { threadId, input: [{ type: 'text', text: prompt }], cwd }, { timeoutMs: 30_000 });
    turnId = t?.turn?.id ?? null;
  }
  return { threadId, turnId };
}

/**
 * Interactive codex argv from a resolved profile: profile argv, model, effort, cwd, then `resume -- <id>` or
 * `-- <prompt>`. The `--` keeps a request value from becoming an option or a subcommand (verified on 0.162.1:
 * after it, `--version` and `completion` were submitted as prompts, and `resume -- --last` looked for a session
 * with that id instead of resuming the latest). `-m` already refuses a value that starts with "-".
 */
export function interactiveArgv(profile, { model, effort, cwd, prompt, resume, extra = [] } = {}) {
  const argv = ['codex', ...(profile.argv ?? [])];
  if (model) argv.push('-m', model);
  argv.push(...effortArgv(effort));
  if (cwd) argv.push('-C', cwd);
  argv.push(...extra);
  if (resume) { argv.push('resume', '--', resume); return argv; }
  if (prompt) argv.push('--', prompt);
  return argv;
}

/** Rollout files (transcripts) modified recently. */
export async function recentRollouts({ days = 4, limit = 200 } = {}) {
  if (!existsSync(SESSIONS_DIR)) return [];
  const cutoff = Date.now() - days * 86400_000;
  const out = [];
  const walk = async (dir, depth) => {
    let names; try { names = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 4) await walk(f, depth + 1); continue; }
      if (!e.name.endsWith('.jsonl')) continue;
      let s; try { s = await stat(f); } catch { continue; }
      if (s.mtimeMs < cutoff) continue;
      const m = e.name.match(/rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-([0-9a-f-]{36})\.jsonl$/);
      out.push({ kind: 'codex', threadId: m?.[2] ?? e.name, startedAt: m?.[1]?.replace(/T(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3') ?? null, file: f, mtime: s.mtime.toISOString(), bytes: s.size });
    }
  };
  await walk(SESSIONS_DIR, 0);
  out.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
  return out.slice(0, limit);
}

/** Parse a rollout JSONL into chat turns + meta. */
export async function readRollout(file, { limit = 200 } = {}) {
  if (!existsSync(file)) return { turns: [], meta: null };
  const text = await readFile(file, 'utf8');
  const turns = []; let meta = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    const p = d.payload ?? {};
    if (d.type === 'session_meta') { meta = { threadId: p.id ?? p.session_id, cwd: p.cwd, model_provider: p.model_provider, originator: p.originator, cli_version: p.cli_version, startedAt: p.timestamp }; continue; }
    if (d.type !== 'response_item') continue;
    if (p.type === 'message') {
      const txt = (p.content ?? []).map((b) => b.text ?? '').join('');
      if (p.role === 'user' && !txt.startsWith('<')) turns.push({ role: 'user', ts: d.timestamp, text: txt });
      else if (p.role === 'assistant') turns.push({ role: 'assistant', ts: d.timestamp, text: txt });
    } else if (p.type === 'agent_message') turns.push({ role: 'assistant', ts: d.timestamp, text: (p.content ?? []).map((b) => b.text ?? '').join('') || p.text || '' });
    else if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') turns.push(codexCallTurn(p, d.timestamp));
    else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output' || p.type === 'local_shell_call_output') turns.push(codexOutputTurn(p, d.timestamp));
  }
  return { turns: turns.slice(-limit), meta };
}

/** A Codex tool call as a Claude-shaped assistant turn: tools [{ id, name, input, summary }], no text. */
export function codexCallTurn(p, ts) {
  let input = p.input ?? p.action ?? p.arguments ?? '';
  if (p.type === 'function_call' && typeof p.arguments === 'string') { try { input = JSON.parse(p.arguments); } catch { input = p.arguments; } }
  const name = p.type === 'local_shell_call' ? 'local_shell' : p.name ?? 'tool';
  const compact = typeof input === 'string' ? (input.length > 300 ? input.slice(0, 300) + '…' : input) : (JSON.stringify(input ?? '').length > 300 ? JSON.stringify(input).slice(0, 300) + '…' : input);
  return { role: 'assistant', ts, text: '', tools: [{ id: p.call_id ?? p.id ?? null, name, input: compact, summary: toolSummary(name, input) }] };
}

/** A Codex tool output as a tool_result turn: results [{ toolUseId, isError, text }] plus the short text older clients read. */
export function codexOutputTurn(p, ts) {
  const out = typeof p.output === 'object' && p.output !== null && !Array.isArray(p.output) ? p.output.content ?? p.output.output ?? '' : p.output;
  const entry = resultEntry(p.call_id ?? null, out);
  entry.isError = entry.isError || codexOutputFailed(entry.text) || p.status === 'failed';
  return { role: 'tool_result', ts, count: 1, text: (entry.isError ? '[error] ' : '') + entry.text.slice(0, 400), results: [entry] };
}
