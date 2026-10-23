// files.wait: wait until a file, or a directory's direct entries, change on this host, then say what changed. A
// coordinator waiting on its workers' status files ran `sleep N; ssh host cat ...` loops: every tick woke the model
// (tokens, context, a prompt-cache miss) and a change between ticks was seen a tick late. `drover op files.wait`
// under Claude Code's background Bash wakes the session once, when the command exits.
//
// It polls stat (mtime, size, inode) rather than using fs.watch, which misses changes on WSL (/mnt/c and the other
// 9p mounts), on network mounts and on some container bind mounts, and on Linux follows an inode, so a file replaced
// by an atomic save (a temp file renamed over it) leaves it watching the old file. One stat per entry per interval,
// metadata only (never content), any path. Nothing outlives the call: no daemon state, lock or channel. The wait
// runs in the process that asked: `drover op`, the daemon, or the `drover rpc` serving a caller on another host,
// which stops waiting when that caller is gone (bin/drover).
import { readdir, stat, lstat } from 'node:fs/promises';
import path from 'node:path';
import { expand } from './files.js';

export const LIMITS = { timeoutSec: { def: 1800, min: 1, max: 3600 }, intervalMs: { def: 2000, min: 100, max: 60_000 }, entries: 10_000, changes: 500 };

const given = (v) => v !== undefined && v !== null && v !== '';
function clamp(v, name, { def, min, max }) {
  if (!given(v)) return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return Math.min(max, Math.max(min, n));
}

/** The timeout and interval a call gets: absent is the default, anything else is clamped into LIMITS. */
export function waitLimits({ timeoutSec, intervalMs } = {}) {
  return { timeoutSec: clamp(timeoutSec, 'timeoutSec', LIMITS.timeoutSec), intervalMs: Math.round(clamp(intervalMs, 'intervalMs', LIMITS.intervalMs)) };
}

/** A simple glob over entry names: * and ? (never /), [abc] and [!abc]; everything else is literal. */
export function globRe(glob) {
  const g = String(glob);
  if (g.includes('/')) throw new Error('glob matches the names of the directory\'s own entries: no /');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i], end = c === '[' ? g.indexOf(']', i + 2) : -1;
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (end > 0) { const body = g.slice(i + 1, end), neg = body[0] === '!'; re += `[${neg ? '^' : ''}${(neg ? body.slice(1) : body).replace(/[\\\]\[^]/g, '\\$&')}]`; i = end; }
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** One path's state: a signature that changes with any write, truncation or replacement (inode); ms is its newest mtime or ctime. */
async function entry(p) {
  let s;
  try { s = await stat(p, { bigint: true }); }
  catch (e) {
    if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
    try { s = await lstat(p, { bigint: true }); } catch { return null; }   // a dangling link is still an entry
  }
  const kind = s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other';
  return { kind, sig: `${kind}:${s.ino}:${s.size}:${s.mtimeNs}`, ms: Number(s.mtimeNs > s.ctimeNs ? s.mtimeNs : s.ctimeNs) / 1e6 };
}

/**
 * What is there now: a file is itself; a directory is itself (its kind only: its own mtime moves with every entry,
 * which is reported per entry) and its direct entries that match; a missing path is nothing. The matching entries
 * are counted before any of them is statted, on every scan, so a directory that grows past LIMITS.entries during a
 * wait ends it with that error instead of a stat storm every interval.
 */
async function snapshot(p, match) {
  const snap = new Map(), root = await entry(p);
  if (!root) return snap;
  if (root.kind !== 'dir') return snap.set(p, root);
  snap.set(p, { ...root, sig: 'dir', root: true });
  let names;
  try { names = (await readdir(p)).filter((n) => !match || match.test(n)); }
  catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return new Map(); throw e; }   // gone between the stat and the read
  if (names.length > LIMITS.entries) throw Object.assign(new Error(`${p} has ${names.length} entries to watch, more than ${LIMITS.entries}: narrow it with glob, or wait on one file`), { tooMany: true });
  for (let i = 0; i < names.length; i += 256) {
    const part = await Promise.all(names.slice(i, i + 256).map(async (n) => [path.join(p, n), await entry(path.join(p, n))]));
    for (const [f, e] of part) if (e) snap.set(f, e);
  }
  return snap;
}

const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
function diff(prev, next) {
  const out = [];
  for (const [p, e] of next) { const o = prev.get(p); if (!o) out.push({ path: p, kind: 'added' }); else if (o.sig !== e.sig) out.push({ path: p, kind: 'modified' }); }
  for (const p of prev.keys()) if (!next.has(p)) out.push({ path: p, kind: 'removed' });
  return out.sort(byPath);
}

/**
 * What changed after `since`: entries whose mtime or ctime is at or after it (written, or renamed in), and the
 * directory itself when its own mtime is (an entry was added, removed or renamed). That holds with a glob too: a
 * matching file deleted between two waits leaves only the directory's mtime behind, so churn among entries the glob
 * does not match wakes the caller as well. For a wake-up a false wake costs one look; a missed one costs the whole
 * timeout. All "modified": a snapshot from then is not kept to tell more. Linux stamps files from a coarse clock
 * that runs up to a tick (a few ms) behind Date.now(), so a write made just after `since` can carry an earlier
 * time: SINCE_SLACK_MS reaches back past that. A change made within it of the last snapshot may be reported twice;
 * none is missed.
 */
const SINCE_SLACK_MS = 50;
function newerThan(snap, sinceMs) {
  const out = [];
  for (const [p, e] of snap) if (e.ms >= sinceMs - SINCE_SLACK_MS) out.push({ path: p, kind: 'modified' });
  return out.sort(byPath);
}

function parseSince(since) {
  if (!given(since)) return null;
  const s = String(since).trim(), n = typeof since === 'number' ? since : /^\d+(\.\d+)?$/.test(s) ? Number(s) : Date.parse(s);
  if (!Number.isFinite(n)) throw new Error('since must be the ts of a previous answer, an ISO time or epoch milliseconds');
  return n;
}

const waits = new Set();
/** End every wait in this process now; each answers stopped: true. drover rpc calls it when its caller is gone. */
export function stopWaits() { for (const w of waits) w.stop(); }

/**
 * Wait for a change under path (see the header and META files.wait). The first snapshot is the baseline; every
 * intervalMs a new one is compared with the last, and the first difference is the answer. Each answer carries ts,
 * when its last snapshot was taken, and exists, whether path was there then. Pass them to the next wait as since
 * and existed and nothing that changed in between is missed: a write by its time, an entry added or removed by the
 * directory's, and a watched file that vanished (or appeared) by existed, since a removal leaves no time behind.
 */
export async function wait({ path: requested, glob, timeoutSec, intervalMs, since, existed } = {}) {
  const p = expand(requested);
  const match = given(glob) ? globRe(glob) : null;
  const lim = waitLimits({ timeoutSec, intervalMs });
  const after = parseSince(since);
  if (given(existed) && typeof existed !== 'boolean' && existed !== 'true' && existed !== 'false') throw new Error('existed must be true or false (the exists of the previous answer)');
  const t0 = Date.now(), deadline = t0 + lim.timeoutSec * 1000;
  let ts = new Date(), prev = await snapshot(p, match);
  const answer = (o, snap) => ({ ...o, waitedMs: Date.now() - t0, ts: ts.toISOString(), path: p, exists: snap.has(p), ...(match ? { glob: String(glob) } : {}), timeoutSec: lim.timeoutSec, intervalMs: lim.intervalMs });
  const changed = (list, snap) => answer({ changed: true, changes: list.slice(0, LIMITS.changes), ...(list.length > LIMITS.changes ? { more: list.length - LIMITS.changes } : {}) }, snap);
  if (given(existed) && (existed === true || existed === 'true') !== prev.has(p)) return changed([{ path: p, kind: prev.has(p) ? 'added' : 'removed' }], prev);
  if (after !== null) { const early = newerThan(prev, after); if (early.length) return changed(early, prev); }
  const w = { stopped: false, wake: () => {}, stop() { this.stopped = true; this.wake(); } };
  waits.add(w);
  try {
    for (;;) {
      const left = deadline - Date.now();
      if (w.stopped) return answer({ changed: false, stopped: true }, prev);
      if (left <= 0) return answer({ changed: false }, prev);
      // A live timer, deliberately: under `drover op` nothing else keeps the process up while it waits.
      await new Promise((resolve) => { const t = setTimeout(resolve, Math.min(lim.intervalMs, left)); w.wake = () => { clearTimeout(t); resolve(); }; });
      if (w.stopped) return answer({ changed: false, stopped: true }, prev);
      ts = new Date();
      const next = await snapshot(p, match), list = diff(prev, next);
      if (list.length) return changed(list, next);
      prev = next;
    }
  } finally { waits.delete(w); }
}

export const ops = { 'files.wait': (a = {}) => wait(a) };
