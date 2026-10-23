// Stale-while-revalidate cache for read ops. The page always gets an answer at
// once (the last known value, marked stale when old) and the daemon refreshes
// behind it. Hot keys are kept warm on a timer. Values persist under
// ~/.cache/drover so a restarted daemon serves last-known state immediately,
// the way an fzf tmux picker reads pre-written inventory files.
// Only a process that outlives its answers (the daemon, the MCP server: markLongLived) refreshes behind them; the CLI
// and drover rpc read a stale value again first.
import { mkdir, readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { cacheDir } from './paths.js';
import { envvar } from './envvars.js';

const DIR = cacheDir();
const mem = new Map();      // key -> { value, ts, ms, error }
const inflight = new Map(); // key -> { p, gen }: the load running for a key, and the generation it started in
const warmers = new Map();  // key -> { every, timer, loader, listeners }
// A key's generation goes up each time it is invalidated. A load that started in an older generation may hold the value
// from before the change that invalidated it (a docker.stacks read racing a docker.restart): it answers its own caller
// but is neither stored nor joined by a later read. lastDrop keeps when each prefix was last invalidated, so a copy that
// was being persisted while it was dropped (the unlink can land before the write) is never hydrated afterwards.
const gens = new Map();     // key -> generation
const lastDrop = new Map(); // op prefix -> ms of its last invalidation
const LAST_DROP_MAX = 500;
let dirReady = false;
let longLived = false;

/**
 * This process outlives its answers (the daemon; the MCP stdio server, which ends only through its shutdown), so a
 * stale value is served at once and refreshed behind it. Any other process reads it again before answering: the CLI
 * exits once it prints, and a refresh left behind its answer opened ssh peers after the CLI had stopped them, which kept
 * it running long after it printed the old value; `drover rpc` answers a front daemon that waits for the answer and
 * already refreshes behind its own cache, so a stale copy from the rpc's disk would only reach it as its refresh.
 * Returns what it was before, so a test can put it back.
 */
export function markLongLived(on = true) { const was = longLived; longLived = on; return was; }

async function ensureDir() { if (!dirReady) { await mkdir(DIR, { recursive: true, mode: 0o700 }); dirReady = true; } }
function fileFor(key) { return path.join(DIR, createHash('sha1').update(key).digest('hex').slice(0, 24) + '.json'); }

export function keyFor(op, args = {}, { host } = {}) {
  const parts = Object.entries(args ?? {}).filter(([k, v]) => v !== undefined && k !== 'fresh').sort(([a], [b]) => (a < b ? -1 : 1));
  return `${host || 'local'}|${op}|${JSON.stringify(parts)}`;
}

/** The op segment of a key (host|op|args, as keyFor builds it). */
const opOf = (key) => key.split('|')[1] ?? '';

/** True when key was invalidated at or after ts (an entry stored then is from before the change). */
function droppedSince(key, ts) {
  const op = opOf(key);
  for (const [p, at] of lastDrop) if (op.startsWith(p) && ts <= at) return true;
  return false;
}

/** Load the persisted copy for a key (used on first access after a restart). */
async function hydrate(key) {
  try {
    const f = fileFor(key);
    if (!existsSync(f)) return null;
    const d = JSON.parse(await readFile(f, 'utf8'));
    if (d?.key !== key) return null;
    if (droppedSince(key, d.ts)) { unlink(f).catch(() => {}); return null; }
    const entry = { value: d.value, ts: d.ts, ms: d.ms ?? 0, persisted: true };
    mem.set(key, entry);
    return entry;
  } catch { return null; }
}
async function persist(key, entry) {
  try { await ensureDir(); await writeFile(fileFor(key), JSON.stringify({ key, ts: entry.ts, ms: entry.ms, value: entry.value }), 'utf8'); } catch { /* cache is best effort */ }
}

async function refresh(key, loader, { persistIt = true } = {}) {
  const gen = gens.get(key) ?? 0;
  const cur = inflight.get(key);
  if (cur && cur.gen === gen) return cur.p;
  const job = { gen, p: null };
  inflight.set(key, job);   // before the loader starts: it may settle at once
  const current = () => (gens.get(key) ?? 0) === gen;
  job.p = (async () => {
    const t0 = Date.now();
    try {
      const value = await loader();
      const entry = { value, ts: Date.now(), ms: Date.now() - t0 };
      if (!current()) return entry;   // invalidated meanwhile: this caller's answer, not the cache's
      mem.set(key, entry);
      if (persistIt) persist(key, entry);
      for (const l of warmers.get(key)?.listeners ?? []) { try { l(value, entry); } catch { /* listener error */ } }
      return entry;
    } catch (e) {
      if (!current()) throw e;
      const prev = mem.get(key);
      const entry = { ...(prev ?? { value: undefined, ts: 0 }), error: e.message, errorTs: Date.now() };
      mem.set(key, entry);
      if (!prev || prev.value === undefined) throw e;
      return entry;
    } finally { if (inflight.get(key) === job) inflight.delete(key); }
  })();
  return job.p;
}

/**
 * Get a value through the cache.
 *  - fresh: skip the cache, load now, store the result.
 *  - ttl: serve from memory when younger than this; in a long-lived process older
 *    values are returned at once AND refreshed in the background (stale-while-revalidate),
 *    anywhere else they are loaded again first, the old value kept (with the
 *    error) when that load fails.
 *  - maxStale: never serve values older than this; load synchronously instead.
 * Returns { value, meta: { hit, age, stale, refreshing, ms, error, persisted } }.
 */
export async function get(key, loader, { ttl = 10_000, maxStale = 6 * 3600_000, fresh = false, persist: persistIt = true } = {}) {
  if (fresh) { const e = await refresh(key, loader, { persistIt }); return wrap(e, { hit: false }); }
  let e = mem.get(key) ?? (await hydrate(key));
  const age = e ? Date.now() - e.ts : Infinity;
  if (!e || e.value === undefined || age > maxStale) { e = await refresh(key, loader, { persistIt }); return wrap(e, { hit: false }); }
  if (age > ttl && !longLived) { e = await refresh(key, loader, { persistIt }); return wrap(e, e.error ? { hit: true, stale: true } : { hit: false }); }
  if (age > ttl) { refresh(key, loader, { persistIt }).catch(() => {}); return wrap(e, { hit: true, stale: true, refreshing: true }); }
  return wrap(e, { hit: true });
}
function wrap(e, extra) { return { value: e.value, meta: { hit: false, stale: false, refreshing: false, ...extra, age: Date.now() - e.ts, ms: e.ms ?? 0, error: e.error ?? null, persisted: Boolean(e.persisted) } }; }

export function peek(key) { const e = mem.get(key); return e ? wrap(e, { hit: true, stale: true }) : null; }

/**
 * Drop keys whose op segment matches any of the given op prefixes (after a mutation), with their persisted copies; a
 * load of such a key already running is left to finish for its caller but will not be stored or joined.
 */
export function invalidate(...opPrefixes) {
  let n = 0;
  const now = Date.now();
  // Deleted first so a prefix dropped again moves to the end: the cap below forgets the ones dropped longest ago.
  for (const p of opPrefixes) { lastDrop.delete(p); lastDrop.set(p, now); }
  while (lastDrop.size > LAST_DROP_MAX) lastDrop.delete(lastDrop.keys().next().value);
  for (const key of new Set([...mem.keys(), ...inflight.keys()])) {
    const op = opOf(key);
    if (!opPrefixes.some((p) => op.startsWith(p))) continue;
    gens.set(key, (gens.get(key) ?? 0) + 1);
    if (mem.delete(key)) n++;
    unlink(fileFor(key)).catch(() => {});
  }
  return n;
}

/** Keep a key warm: refresh every `every` ms; listeners get each new value (SSE snapshots). */
export function warm(key, loader, { every, onValue, persist: persistIt = true } = {}) {
  let w = warmers.get(key);
  if (!w) { w = { every, loader, listeners: new Set(), timer: null }; warmers.set(key, w); }
  if (onValue) w.listeners.add(onValue);
  w.loader = loader;
  if (!w.timer) {
    const tick = () => refresh(key, w.loader, { persistIt }).catch(() => {});
    w.timer = setInterval(tick, every); w.timer.unref();
    tick();
  }
  return () => { if (onValue) w.listeners.delete(onValue); };
}

export function stopWarmers() { for (const w of warmers.values()) { clearInterval(w.timer); w.timer = null; } }

export async function stats() {
  const entries = [...mem.entries()].map(([key, e]) => ({ key, age: Date.now() - e.ts, ms: e.ms ?? 0, error: e.error ?? null, bytes: e.value === undefined ? 0 : JSON.stringify(e.value).length }));
  let files = 0; try { files = (await readdir(DIR)).length; } catch { /* none */ }
  return { dir: DIR, entries: entries.sort((a, b) => a.age - b.age), warm: [...warmers.keys()], persistedFiles: files };
}

/**
 * Last-resort fallback for a host that is down: claude/tmux-inventory-<host>.jsonl in the dotfiles (DROVER_DOTFILES,
 * default ~/.dotfiles), which a tmux picker there may write and the dotfiles sync brings to every host.
 */
export async function tmuxInventoryFallback(host, dotfiles = envvar('DOTFILES') ?? path.join(process.env.HOME, '.dotfiles')) {
  const f = path.join(dotfiles, 'claude', `tmux-inventory-${host}.jsonl`);
  if (!existsSync(f)) return null;
  const rows = [];
  for (const line of (await readFile(f, 'utf8')).split('\n')) { if (!line.trim()) continue; try { rows.push(JSON.parse(line)); } catch { /* skip */ } }
  if (!rows.length) return null;
  const ts = Math.max(...rows.map((r) => (r.ts ?? 0) * 1000));
  return {
    source: 'tmux-inventory', ts: new Date(ts).toISOString(),
    windows: rows.map((r) => ({ target: `${r.session}:${r.window_idx}`, session: r.session, index: r.window_idx, name: r.window_name, active: Boolean(r.active), panes: r.panes, cmd: r.cmd, cwd: r.path, panePid: r.pane_pid, activityTs: (r.ts ?? 0) * 1000, agent: r.claude ? { engine: 'claude', sessionId: r.claude.uuid, name: r.claude.name, status: r.claude.status } : null, screen: null, tail: [] })),
  };
}
