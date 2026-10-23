// sessions.list filters: cwd, name, engine, live and limit. They run on the host that holds the sessions, where ~
// is its home and the paths are the ones its sessions report: one busy host's whole list ran to about 300 KB (mostly
// Codex first prompts) and overflowed the context of the agent that asked for it.
import { realpathSync } from 'node:fs';
import path from 'node:path';

const FILTERS = ['cwd', 'name', 'engine', 'live', 'limit'];
const given = (v) => v !== undefined && v !== null && v !== '';
export const filtersGiven = (args = {}) => FILTERS.some((k) => given(args?.[k]));

/**
 * The folder a cwd filter names, as sessions report theirs: ~ expanded to home, trailing slashes and . or ..
 * dropped, plus its real path when that differs (macOS /tmp is /private/tmp, and sessions report the real one).
 */
export function cwdRoots(cwd, home) {
  const raw = String(cwd).trim();
  if (/^~(?=$|\/)/.test(raw) && !home) throw new Error('cwd starts with ~ but the home folder is not known here');
  const abs = raw.replace(/^~(?=$|\/)/, home ?? '');
  if (!path.isAbsolute(abs)) throw new Error('cwd must be absolute or start with ~/');
  const out = [path.resolve(abs)];
  try { const real = realpathSync(out[0]); if (real !== out[0]) out.push(real); } catch { /* not on this host */ }
  return out;
}
const inside = (dir, roots) => typeof dir === 'string' && roots.some((r) => dir === r || dir.startsWith(r.endsWith('/') ? r : `${r}/`));

/** When a session last did something, in ms: Claude updatedAt (ms), Codex updatedAt (s), a bot's lastSeenAt, a transcript's mtime, a headless start. */
export function activityMs(s) {
  for (const v of [s?.updatedAt, s?.lastSeenAt, s?.statusUpdatedAt, s?.mtime, s?.startedAt, s?.createdAt]) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < 1e12 ? v * 1000 : v;
    if (typeof v === 'string') { const t = Date.parse(v); if (Number.isFinite(t)) return t; }
  }
  return 0;
}

/**
 * The sessions that pass every filter given: cwd (that folder or inside it), name (substring, any case), engine
 * (one, or several comma-separated), live (true or false). matched counts them; limit then keeps that many, the
 * most recently active first (without limit the order is the list's own). Bad values throw, so a typo is not an
 * empty answer.
 */
export function filterSessions(list = [], { cwd, name, engine, live, limit } = {}, { home = process.env.HOME } = {}) {
  let out = Array.isArray(list) ? list : [];
  if (given(cwd)) { const roots = cwdRoots(cwd, home); out = out.filter((s) => inside(s?.cwd, roots)); }
  if (given(name)) { const n = String(name).toLowerCase(); out = out.filter((s) => typeof s?.name === 'string' && s.name.toLowerCase().includes(n)); }
  if (given(engine)) { const want = new Set(String(engine).split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)); out = out.filter((s) => want.has(String(s?.engine).toLowerCase())); }
  if (given(live)) {
    const want = live === true || live === 'true' ? true : live === false || live === 'false' ? false : null;
    if (want === null) throw new Error('live must be true or false');
    out = out.filter((s) => Boolean(s?.live) === want);
  }
  const matched = out.length;
  if (given(limit)) {
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 0) throw new Error('limit must be a whole number, 0 or more');
    out = [...out].sort((a, b) => activityMs(b) - activityMs(a)).slice(0, n);
  }
  return { sessions: out, matched };
}
