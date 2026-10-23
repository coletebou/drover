// A small editor surface for the files that steer the agents: memory files,
// CLAUDE.md / AGENTS.md, skills, settings. Reads and writes go through these ops
// and only inside an allowlist:
//
//   ~/.dotfiles/**   ~/.claude/**   ~/.codex/**   ~/code/*/CLAUDE.md   ~/code/*/AGENTS.md
//
// Every path is ~-expanded, normalized and resolved through symlinks; both the
// path asked for and the real file must sit inside an allowed root, so `..` and
// a symlink that points out of the roots are both refused. Secret-looking files
// (auth.json, credentials, .env*, keys, ~/.claude/sessions, .git, .ssh) are
// refused for reading and writing, so an agent cannot pull a token into a
// transcript through this op. Writes are atomic (temp file + rename onto the
// real path, mode preserved), refuse when the file changed since it was read
// (expectSha256), and land in the WAL as a `file-write` event with the path,
// byte count and hashes, never the content.
import { readFile, writeFile, stat, readdir, realpath, rename, mkdir, lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import * as events from './events.js';
import { OWNER } from './owner.js';

export const MAX_READ = 2 * 1024 * 1024;
export const MAX_WRITE = 2 * 1024 * 1024;
export const _deps = { appendEvent: (ev, opts) => events.append(ev, opts), home: () => process.env.HOME };

const HOME = () => _deps.home();
export function dirRoots() { return ['.dotfiles', '.claude', '.codex'].map((d) => path.join(HOME(), d)); }
const CODE = () => path.join(HOME(), 'code');
const CODE_FILES = new Set(['CLAUDE.md', 'AGENTS.md']);

/** Names and path segments that are never readable or writable here. */
const SECRET_NAME = [
  /^(auth|credentials?|\.credentials)(\.[\w-]+)?\.json$/i,
  /^\.env(?!\.(example|sample|template)$)/i,
  /^\.?env_secrets/i,
  /(secret|token|passw(or)?d|private[_-]?key|apikey|api[_-]key)/i,
  /\.(pem|key|p12|pfx|keychain|gpg|asc|age|kdbx|der|crt)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /^(\.netrc|\.npmrc|\.pypirc|\.git-credentials|known_hosts|authorized_keys)$/i,
];
const SECRET_SEGMENT = new Set(['.git', '.ssh', '.gnupg', 'sessions', 'node_modules', 'shell-snapshots', 'statsig']);

export function secretLooking(p) {
  const parts = p.split(path.sep).filter(Boolean);
  if (parts.some((s) => SECRET_SEGMENT.has(s))) return true;
  return SECRET_NAME.some((re) => re.test(parts.at(-1) ?? ''));
}

export function expand(p) {
  if (typeof p !== 'string' || !p.trim()) throw new Error('path must be a non-empty string');
  if (p.includes('\0')) throw new Error('path has a NUL byte');
  const e = p.trim().replace(/^~(?=$|\/)/, HOME());
  if (!path.isAbsolute(e)) throw new Error('path must be absolute or start with ~/');
  return path.normalize(e);
}

/** Is a normalized absolute path inside the allowlist (lexically)? */
export function allowedPath(p, { realRoots } = {}) {
  const roots = realRoots?.dirs ?? dirRoots();
  for (const r of roots) if (p === r || p.startsWith(r + path.sep)) return { ok: true, root: r, kind: 'dir' };
  const code = realRoots?.code ?? CODE();
  if (path.dirname(path.dirname(p)) === code && CODE_FILES.has(path.basename(p))) return { ok: true, root: code, kind: 'code-file' };
  return { ok: false };
}

async function realRoots() {
  const dirs = [];
  for (const r of dirRoots()) { dirs.push(r); try { const rr = await realpath(r); if (rr !== r) dirs.push(rr); } catch { /* missing root */ } }
  let code = CODE(); try { code = await realpath(code); } catch { /* none */ }
  return { dirs, code, codeLexical: CODE() };
}

/**
 * Resolve a requested path to the real file to act on, or throw. forWrite allows
 * a file that does not exist yet (its parent must exist and resolve inside).
 */
export async function resolveAllowed(requested, { forWrite = false } = {}) {
  const p = expand(requested);
  const lexical = allowedPath(p);
  if (!lexical.ok) throw new Error(`outside the editable roots (~/.dotfiles, ~/.claude, ~/.codex, ~/code/*/CLAUDE.md, ~/code/*/AGENTS.md): ${requested}`);
  if (secretLooking(p)) throw new Error(`refused: ${path.basename(p)} looks like a secret or private state`);
  const roots = await realRoots();
  let real;
  if (existsSync(p)) real = await realpath(p);
  else {
    if (!forWrite) throw new Error(`not found: ${requested}`);
    const parent = await realpath(path.dirname(p)).catch(() => null);
    if (!parent) throw new Error(`parent directory does not exist: ${path.dirname(requested)}`);
    real = path.join(parent, path.basename(p));
  }
  const realOk = allowedPath(real, { realRoots: roots }).ok || allowedPath(real, { realRoots: { dirs: roots.dirs, code: roots.codeLexical } }).ok;
  if (!realOk) throw new Error(`refused: ${requested} resolves outside the editable roots (${real})`);
  if (secretLooking(real)) throw new Error(`refused: ${path.basename(real)} looks like a secret or private state`);
  return { path: p, real, kind: lexical.kind };
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

export async function read({ path: requested } = {}) {
  const { path: p, real } = await resolveAllowed(requested);
  const s = await stat(real);
  if (s.isDirectory()) throw new Error('that is a directory; use files.list');
  if (s.size > MAX_READ) throw new Error(`file too large to edit here (${s.size} bytes, cap ${MAX_READ})`);
  const buf = await readFile(real);
  if (buf.includes(0)) throw new Error('binary file: not editable here');
  return { path: p, real, text: buf.toString('utf8'), bytes: buf.length, mtime: s.mtime.toISOString(), sha256: sha(buf), symlink: real !== p };
}

export async function write({ path: requested, content, expectSha256, create = false, actor = OWNER } = {}) {
  if (typeof content !== 'string') throw new Error('content must be a string');
  const buf = Buffer.from(content, 'utf8');
  if (buf.length > MAX_WRITE) throw new Error(`content too large (${buf.length} bytes, cap ${MAX_WRITE})`);
  const { path: p, real } = await resolveAllowed(requested, { forWrite: true });
  let prevSha = null; let mode = 0o644;
  if (existsSync(real)) {
    const s = await stat(real);
    if (s.isDirectory()) throw new Error('that is a directory');
    mode = s.mode & 0o777;
    prevSha = sha(await readFile(real));
    if (expectSha256 && expectSha256 !== prevSha) throw Object.assign(new Error('the file changed on disk since you read it; reload, merge your edit and save again'), { conflict: true, sha256: prevSha });
  } else if (!create) throw new Error(`not found: ${requested} (pass create:true to make a new file)`);
  else if (path.extname(real) === '') throw new Error('new files need an extension (.md, .json, .toml, .sh ...)');
  const tmp = path.join(path.dirname(real), `.${path.basename(real)}.drover-${process.pid}-${Date.now()}.tmp`);
  await writeFile(tmp, buf, { mode });
  await rename(tmp, real);
  const next = sha(buf);
  const ev = await _deps.appendEvent({ type: 'file-write', path: p, ...(real !== p ? { real } : {}), bytes: buf.length, sha256: next, prevSha256: prevSha, created: prevSha === null }, { actor });
  return { ok: true, path: p, real, bytes: buf.length, sha256: next, prevSha256: prevSha, event: ev.id, unchanged: prevSha === next };
}

export async function list({ dir } = {}) {
  const target = dir ? expand(dir) : null;
  if (!target) return roots();
  const { real } = await resolveAllowed(target);
  const s = await stat(real);
  if (!s.isDirectory()) throw new Error('not a directory');
  const entries = [];
  for (const name of (await readdir(real)).sort((a, b) => a.localeCompare(b))) {
    const full = path.join(target, name);
    if (secretLooking(full)) continue;
    let st; try { st = await stat(path.join(real, name)); } catch { continue; }   // dangling link
    const ls = await lstat(path.join(real, name)).catch(() => null);
    entries.push({ name, path: full, type: st.isDirectory() ? 'dir' : 'file', bytes: st.isDirectory() ? null : st.size, mtime: st.mtime.toISOString(), link: Boolean(ls?.isSymbolicLink()) });
  }
  entries.sort((a, b) => (a.type === b.type ? 0 : a.type === 'dir' ? -1 : 1));
  return { dir: target, entries: entries.slice(0, 2000), truncated: entries.length > 2000 };
}

// The roots plus quick picks: every repo CLAUDE.md and AGENTS.md under ~/code, global agent configs, skills, memory indexes.
export async function roots() {
  const picks = [];
  const add = async (p, group, label) => { if (existsSync(p) && !secretLooking(p)) { try { const s = await stat(p); if (s.isFile()) picks.push({ path: p.replace(HOME(), '~'), group, label: label ?? path.basename(p), bytes: s.size, mtime: s.mtime.toISOString() }); } catch { /* raced */ } } };
  if (existsSync(CODE())) for (const d of (await readdir(CODE())).sort()) for (const f of CODE_FILES) await add(path.join(CODE(), d, f), 'Repos', `${d}/${f}`);
  await add(path.join(HOME(), '.claude', 'CLAUDE.md'), 'Global', '~/.claude/CLAUDE.md');
  await add(path.join(HOME(), '.codex', 'AGENTS.md'), 'Global', '~/.codex/AGENTS.md');
  await add(path.join(HOME(), '.claude', 'settings.json'), 'Global', '~/.claude/settings.json');
  await add(path.join(HOME(), '.codex', 'config.toml'), 'Global', '~/.codex/config.toml');
  for (const base of [path.join(HOME(), '.claude', 'skills'), path.join(HOME(), '.dotfiles', 'base', 'claude', 'skills')]) {
    if (!existsSync(base)) continue;
    for (const d of (await readdir(base)).sort()) await add(path.join(base, d, 'SKILL.md'), base.includes('.dotfiles') ? 'Skills (dotfiles)' : 'Skills (~/.claude)', d);
  }
  // Memory indexes under the dotfiles identities (MEMORY.md + session_handoff.md).
  const idRoot = path.join(HOME(), '.dotfiles', 'identities');
  if (existsSync(idRoot)) {
    for (const ident of await readdir(idRoot)) {
      const memRoot = path.join(idRoot, ident, 'claude', 'memory');
      if (!existsSync(memRoot)) continue;
      for (const repo of await readdir(memRoot).catch(() => [])) { await add(path.join(memRoot, repo, 'MEMORY.md'), 'Memory', `${ident}/${repo}/MEMORY.md`); await add(path.join(memRoot, repo, 'session_handoff.md'), 'Memory', `${ident}/${repo}/session_handoff.md`); }
    }
  }
  return { roots: [...dirRoots().map((r) => ({ path: r.replace(HOME(), '~'), kind: 'dir' })), { path: '~/code/*/CLAUDE.md', kind: 'pattern' }, { path: '~/code/*/AGENTS.md', kind: 'pattern' }], picks };
}

/** Find files by name under the dir roots (bounded walk, skips private dirs and transcripts). */
export async function find({ query, limit = 60 } = {}) {
  if (typeof query !== 'string' || query.trim().length < 2) throw new Error('query must be at least 2 characters');
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const out = []; let visited = 0;
  const lim = Math.max(1, Math.min(300, Number(limit) || 60));
  const walk = async (dir, depth) => {
    if (depth > 7 || out.length >= lim || visited > 20_000) return;
    let names; try { names = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const d of names) {
      if (out.length >= lim) return;
      visited++;
      const full = path.join(dir, d.name);
      if (secretLooking(full) || d.name === 'projects' || d.name === 'file-history' || d.name === 'todos' || d.name === '.cache') continue;
      if (d.isDirectory()) { await walk(full, depth + 1); continue; }
      if (!d.isFile()) continue;
      const rel = full.replace(HOME(), '~').toLowerCase();
      if (words.every((w) => rel.includes(w))) out.push({ path: full.replace(HOME(), '~'), name: d.name });
    }
  };
  for (const r of dirRoots()) await walk(r, 0);
  return { query, items: out, truncated: out.length >= lim };
}

export const ops = {
  'files.roots': () => roots(),
  'files.list': (a = {}) => list(a),
  'files.read': (a = {}) => read(a),
  'files.write': (a = {}) => write(a),
  'files.find': (a = {}) => find(a),
};
