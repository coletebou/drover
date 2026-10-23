// Credential pool for agent launches. Claude Code reads its credential from its
// environment (ANTHROPIC_API_KEY, or AWS_BEARER_TOKEN_BEDROCK on Bedrock, ...);
// the pool holds several such credentials (accounts with their own quotas) and
// spreads launches across them so throughput is not bounded by one quota.
//
// Secret hygiene: profiles.json holds only `$NAME` references. The value is read
// from this daemon's process.env at launch time and goes straight into the
// child's env. Nothing in this module logs, stores or returns a value: status(),
// the pick/throttle ops, the truth file and the state file carry variable names
// and credential ids only. A literal (non-$) value in profiles.json is rejected.
//
// Usage tracking: active handles (headless ids, tmux targets) live in memory and
// are lost on a daemon restart. Counters, the round-robin cursor and throttle
// history persist in $DROVER_STATE/credentials.json (default
// $HOME/.local/state/drover/credentials.json) so restarts keep the history.
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { stateDir } from './paths.js';
// Cycle: launch.js imports this module and this module imports loadProfiles
// from launch.js. Neither side touches the other at module load, so it is safe.
import { loadProfiles } from './launch.js';

const STATE_DIR = stateDir();
export const STATE_FILE = path.join(STATE_DIR, 'credentials.json');

/** A credential that recorded a throttle this recently is skipped by auto when another is free. */
export const THROTTLE_WINDOW_MS = 2 * 60_000;
const THROTTLE_HISTORY = 50;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const REF_RE = /^\$[A-Za-z_][A-Za-z0-9_]*$/;

/** Time source; tests replace now() to drive the throttle window and tmux expiry. */
export const _clock = { now: () => Date.now() };

const HELP = [
  'Credential pool for Claude Code launches (profiles.json "credentials"). Each entry maps child env vars to $NAME references that are read from this daemon\'s environment at launch time; values are never shown here, only names and ids.',
  'available=false means a referenced variable is not set on this host (see missing); such an entry is never picked. active counts sessions launched through Drover: headless sessions until they exit, tmux windows for 6 hours after launch (a tmux window cannot be observed, so it expires on a timer). uses is the lifetime launch count. throttles is the number of 429-style events recorded by credentials.throttle or by headless failover; recentThrottles counts those inside the avoidance window.',
  'auto picks, among available entries below maxConcurrent, the lowest active/weight ratio, skipping entries throttled in the last 2 minutes when another is free, round robin on ties. recommendation is what auto would pick right now. Pass credential "<id>" to force an entry, or "none" to inherit the daemon environment unmanaged. When you observe a 429 on a session you run yourself, call credentials.throttle with its id so the next pick avoids it.',
].join(' ');

// ---------------------------------------------------------------- pool

/** Read and validate the `credentials` section of profiles.json. */
export async function loadPool() {
  const all = await loadProfiles();
  const c = all.credentials && typeof all.credentials === 'object' ? all.credentials : {};
  const pool = [];
  const seen = new Set();
  for (const raw of Array.isArray(c.pool) ? c.pool : []) {
    if (!raw || typeof raw !== 'object' || !ID_RE.test(String(raw.id))) throw new Error('credentials.pool entries need an id made of letters, digits, _ or -');
    if (seen.has(raw.id)) throw new Error(`duplicate credential id ${raw.id}`);
    seen.add(raw.id);
    const env = {};
    for (const [k, v] of Object.entries(raw.env ?? {})) {
      if (!REF_RE.test(String(v))) throw new Error(`credential ${raw.id}: env.${k} must be a $NAME reference to the daemon environment; never put a value in profiles.json`);
      env[k] = v;
    }
    if (!Object.keys(env).length) throw new Error(`credential ${raw.id} has no env references`);
    const weight = Number(raw.weight ?? 1);
    if (!(weight > 0)) throw new Error(`credential ${raw.id}: weight must be a number above 0`);
    const maxConcurrent = raw.maxConcurrent == null ? Infinity : Number(raw.maxConcurrent);
    if (!(maxConcurrent > 0)) throw new Error(`credential ${raw.id}: maxConcurrent must be a number above 0`);
    pool.push({ id: raw.id, label: String(raw.label ?? raw.id), env, weight, maxConcurrent });
  }
  const def = typeof c.default === 'string' && c.default ? c.default : 'auto';
  if (def !== 'auto' && def !== 'none' && !seen.has(def)) throw new Error(`credentials.default ${def} is not auto, none or a pool id`);
  const appliesTo = Array.isArray(c.appliesTo) ? c.appliesTo.map(String) : ['claude'];
  return { pool, default: def, appliesTo };
}

export async function defaultMode() { return (await loadPool()).default; }

const sourcesOf = (entry) => [...new Set(Object.values(entry.env).map((r) => r.slice(1)))];
const missingOf = (entry) => sourcesOf(entry).filter((n) => !process.env[n]);

/** Concrete env for one entry, values from process.env. Throws naming the missing variables. */
function resolveEntry(entry) {
  const missing = missingOf(entry);
  if (missing.length) throw new Error(`credential ${entry.id} is unavailable: ${missing.join(', ')} not set in the daemon environment`);
  return Object.fromEntries(Object.entries(entry.env).map(([k, r]) => [k, process.env[r.slice(1)]]));
}

/** Concrete env object for a credential id. Only ever handed to a child process; never put it in an op result or an event. */
export async function resolveEnv(id) {
  const pool = await loadPool();
  const entry = pool.pool.find((e) => e.id === id);
  if (!entry) throw new Error(`unknown credential ${JSON.stringify(id)}`);
  return resolveEntry(entry);
}

/** Replace any pool secret value that appears in text (defensive; API errors should never echo a token). */
function redactWith(pool, text) {
  let out = String(text ?? '');
  for (const e of pool.pool) {
    for (const name of sourcesOf(e)) {
      const v = process.env[name];
      if (v && v.length >= 8 && out.includes(v)) out = out.split(v).join('[redacted]');
    }
  }
  return out;
}

// ---------------------------------------------------------------- active handles (memory)

const active = new Map(); // id -> Map(handle -> { since, expiresAt|null })

function handlesOf(id) {
  let m = active.get(id);
  if (!m) { m = new Map(); active.set(id, m); }
  return m;
}

function activeCount(id) {
  const m = active.get(id);
  if (!m) return 0;
  const now = _clock.now();
  for (const [h, x] of m) if (x.expiresAt != null && x.expiresAt <= now) m.delete(h);
  return m.size;
}

// ---------------------------------------------------------------- persisted counters

let state = null;
let saving = Promise.resolve();
let lastPersistError = null;
const emptyState = () => ({ lastPick: null, uses: {}, throttles: {} });

async function loadState() {
  if (state) return state;
  try {
    const d = JSON.parse(await readFile(STATE_FILE, 'utf8'));
    state = {
      lastPick: typeof d.lastPick === 'string' ? d.lastPick : null,
      uses: d.uses && typeof d.uses === 'object' ? d.uses : {},
      throttles: d.throttles && typeof d.throttles === 'object' ? d.throttles : {},
    };
  } catch { state = emptyState(); }
  return state;
}

/** Atomic write-through, serialized. Errors are kept for status() instead of failing a launch. */
function persist() {
  const snapshot = JSON.stringify(state, null, 2) + '\n';
  saving = saving.then(async () => {
    await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    await writeFile(tmp, snapshot, { mode: 0o600 });
    await rename(tmp, STATE_FILE);
    lastPersistError = null;
  }).catch((e) => { lastPersistError = e.message; });
  return saving;
}

// ---------------------------------------------------------------- describe + choose

function describeRows(pool, st) {
  const now = _clock.now();
  return pool.pool.map((e) => {
    const missing = missingOf(e);
    const th = Array.isArray(st.throttles[e.id]) ? st.throttles[e.id] : [];
    return {
      id: e.id, label: e.label,
      env: { ...e.env },                 // $NAME references, not values
      sources: sourcesOf(e), missing, available: missing.length === 0,
      weight: e.weight, maxConcurrent: Number.isFinite(e.maxConcurrent) ? e.maxConcurrent : null,
      active: activeCount(e.id), uses: st.uses[e.id] ?? 0,
      throttles: th.length,
      recentThrottles: th.filter((t) => now - Date.parse(t.ts) < THROTTLE_WINDOW_MS).length,
      lastThrottle: th.at(-1)?.ts ?? null,
    };
  });
}

/**
 * Pure selection. Returns { row, reason } or { row: null, reason } when there is
 * nothing to pick, or { row: null, fail } when the request cannot be honoured
 * (explicit id unknown/unavailable, or every candidate at maxConcurrent).
 */
function choose(mode, rows, { exclude = [], lastPick = null } = {}) {
  if (mode === 'none') return { row: null, reason: 'credential none: the child inherits the daemon environment unmanaged' };
  if (mode !== 'auto') {
    const row = rows.find((r) => r.id === mode);
    if (!row) return { row: null, fail: `unknown credential ${JSON.stringify(mode)}; known: ${rows.map((r) => r.id).join(', ') || '(empty pool)'}, auto, none` };
    if (!row.available) return { row: null, fail: `credential ${mode} is unavailable: ${row.missing.join(', ')} not set in the daemon environment` };
    return { row, reason: `explicit: ${mode} (${row.active} active)` };
  }
  if (!rows.length) return { row: null, reason: 'credential pool is empty' };
  const avail = rows.filter((r) => r.available);
  if (!avail.length) return { row: null, reason: `no credential available on this host: ${rows.map((r) => `${r.id} needs ${r.missing.join(', ')}`).join('; ')}` };
  const open = avail.filter((r) => !exclude.includes(r.id));
  if (!open.length) return { row: null, reason: `every available credential is excluded (${exclude.join(', ')})` };
  const free = open.filter((r) => r.active < (r.maxConcurrent ?? Infinity));
  if (!free.length) return { row: null, fail: `every available credential is at maxConcurrent: ${open.map((r) => `${r.id} ${r.active}/${r.maxConcurrent}`).join(', ')}; wait for a session to end, raise maxConcurrent in profiles.json, or pass credential "none"` };
  const calm = free.filter((r) => r.recentThrottles === 0);
  const cands = calm.length ? calm : free;
  const skipped = free.filter((r) => !cands.includes(r)).map((r) => r.id);
  const ratio = (r) => r.active / r.weight;
  const min = Math.min(...cands.map(ratio));
  const tied = cands.filter((r) => ratio(r) === min);
  let row = tied[0];
  let how = `lowest load ${row.active}/${row.weight} (active/weight) of ${free.length} free`;
  if (tied.length > 1) {
    const i = tied.findIndex((r) => r.id === lastPick);   // -1 -> tied[0]
    row = tied[(i + 1) % tied.length];
    how = `tie on load ${Number(min.toFixed(3))} between ${tied.map((r) => r.id).join(', ')}; round robin after ${lastPick ?? 'none'}`;
  }
  return { row, reason: `auto: ${how}${skipped.length ? `; skipped ${skipped.join(', ')} (throttled in the last 2 min)` : ''}` };
}

const normMode = (mode) => (mode == null || mode === '' ? 'auto' : String(mode));

async function select(mode, { engine, exclude } = {}) {
  const pool = await loadPool();
  if (engine && !pool.appliesTo.includes(engine)) return { pool, st: null, row: null, reason: `credentials apply to ${pool.appliesTo.join(', ') || 'nothing'}, not ${engine}` };
  const st = await loadState();
  const r = choose(normMode(mode), describeRows(pool, st), { exclude, lastPick: st.lastPick });
  return { pool, st, ...r };
}

/**
 * Choose a credential. mode: 'auto' | 'none' | <id>. Returns { id, label, env,
 * reason } or null when there is nothing to pick (engine not covered, mode
 * none, pool empty or nothing available). Throws when an explicit id is
 * unknown/unavailable or when every candidate is at maxConcurrent. `exclude`
 * skips ids (failover); `record` persists the id as lastPick so repeated picks
 * by an outside orchestrator rotate on ties.
 */
export async function pick(mode = 'auto', { engine, exclude = [], record = false } = {}) {
  const r = await select(mode, { engine, exclude });
  if (r.fail) throw new Error(r.fail);
  if (!r.row) return null;
  const entry = r.pool.pool.find((e) => e.id === r.row.id);
  const env = resolveEntry(entry);
  if (record && r.st.lastPick !== entry.id) { r.st.lastPick = entry.id; persist(); }
  return { id: entry.id, label: entry.label, env, reason: r.reason };
}

/** What pick() would do, as { id, label, reason }, never throwing and never resolving values. */
export async function recommend(mode = 'auto', { engine, exclude = [] } = {}) {
  const r = await select(mode, { engine, exclude });
  if (r.fail) return { id: null, label: null, reason: r.fail };
  return { id: r.row?.id ?? null, label: r.row?.label ?? null, reason: r.reason };
}

// ---------------------------------------------------------------- usage

/** Count a launch against a credential. ttlMs for handles that cannot be released precisely (tmux). */
export async function acquire(id, handle, { ttlMs = null } = {}) {
  const pool = await loadPool();
  if (!pool.pool.some((e) => e.id === id)) throw new Error(`unknown credential ${JSON.stringify(id)}`);
  const st = await loadState();
  const now = _clock.now();
  handlesOf(id).set(String(handle), { since: now, expiresAt: ttlMs ? now + ttlMs : null });
  st.uses[id] = (st.uses[id] ?? 0) + 1;
  st.lastPick = id;
  persist();
  return { id, handle: String(handle), active: activeCount(id) };
}

/** Idempotent; unknown ids and handles are a no-op. */
export function release(id, handle) {
  const m = id ? active.get(id) : null;
  const released = Boolean(m?.delete(String(handle)));
  return { id: id ?? null, released, active: id ? activeCount(id) : 0 };
}

/** Record a 429-style event against a credential so auto avoids it for THROTTLE_WINDOW_MS. */
export async function recordThrottle(id, detail = '') {
  const pool = await loadPool();
  if (!pool.pool.some((e) => e.id === id)) throw new Error(`unknown credential ${JSON.stringify(id)}`);
  const st = await loadState();
  const clean = redactWith(pool, detail).slice(0, 200);
  const list = Array.isArray(st.throttles[id]) ? st.throttles[id] : (st.throttles[id] = []);
  const now = _clock.now();
  const ts = new Date(now).toISOString();
  list.push({ ts, detail: clean });
  if (list.length > THROTTLE_HISTORY) list.splice(0, list.length - THROTTLE_HISTORY);
  persist();
  return {
    ok: true, id, ts, detail: clean,
    recentThrottles: list.filter((t) => now - Date.parse(t.ts) < THROTTLE_WINDOW_MS).length,
    avoidedUntil: new Date(now + THROTTLE_WINDOW_MS).toISOString(),
  };
}

/** The orchestrator view: pool rows (names and ids only), what auto would pick now, and how to read it. */
export async function status() {
  const pool = await loadPool();
  const st = await loadState();
  const rows = describeRows(pool, st);
  const rec = await recommend('auto', { engine: 'claude' });
  return {
    pool: rows,
    recommendation: rec.id,
    recommendationReason: rec.reason,
    defaultMode: pool.default,
    appliesTo: pool.appliesTo,
    lastPick: st.lastPick,
    throttleWindowMs: THROTTLE_WINDOW_MS,
    stateFile: { path: STATE_FILE, error: lastPersistError },
    help: HELP,
  };
}

/** Ops for core/api.js to spread into `local`. None of them returns an env value. */
export const ops = {
  'credentials.status': () => status(),
  'credentials.pick': async ({ mode = 'auto', engine = 'claude' } = {}) => {
    const p = await pick(mode, { engine, record: true });
    return p && { id: p.id, label: p.label, reason: p.reason };
  },
  'credentials.throttle': ({ id, detail } = {}) => recordThrottle(String(id ?? ''), String(detail ?? '').slice(0, 200)),
};

/** Test seam: forget in-memory handles and counters; with file=true also delete the state file. */
export async function _reset({ file = false } = {}) {
  active.clear();
  await saving.catch(() => {});
  state = null;
  if (file) await rm(STATE_FILE, { force: true });
}
