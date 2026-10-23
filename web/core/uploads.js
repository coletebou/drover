// Files pasted or dropped into the composer. The browser sends the bytes
// (base64) to the daemon serving that session's host; the daemon writes them to
// ~/.cache/drover/uploads/<session>/ and returns the absolute path, which the
// message then names so the agent can Read the file. For a remote host the op
// travels through `drover rpc` like every other op. This is the owner's own tool on
// their own machines: the size cap (20 MB decoded per file) is the guard. The WAL
// records the path and byte count only.
import { mkdir, writeFile, readdir, stat, unlink, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { envvar } from './envvars.js';
import { cacheDir } from './paths.js';
import { createHash } from 'node:crypto';
import * as events from './events.js';
import { OWNER } from './owner.js';

export const MAX_BYTES = 20 * 1024 * 1024;
export const ROOT = () => envvar('UPLOADS') ?? path.join(cacheDir(), 'uploads');
export const _deps = { appendEvent: (ev, opts) => events.append(ev, opts), now: () => Date.now() };

/** Directory-safe form of a session id or name. */
export function sessionDir(session) {
  if (typeof session !== 'string' || !session.trim()) throw new Error('session must be a non-empty string');
  const s = session.trim().replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^[.-]+/, '').slice(0, 80);
  if (!s) throw new Error('session has no usable characters');
  return s;
}

/** File-name-safe form of an uploaded name; keeps the extension. */
export function safeName(name, mime) {
  let n = String(name ?? '').split(/[\\/]/).pop().normalize('NFKC').replace(/[^\p{L}\p{N}_.() -]+/gu, '-').replace(/\s+/g, ' ').trim();
  n = n.replace(/^\.+/, '');
  if (!n) n = 'pasted';
  if (!/\.[A-Za-z0-9]{1,8}$/.test(n)) { const ext = EXT[mime]; if (ext) n += ext; }
  if (n.length > 120) { const ext = path.extname(n); n = n.slice(0, 120 - ext.length) + ext; }
  return n;
}
const EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg', 'application/pdf': '.pdf', 'text/plain': '.txt', 'text/markdown': '.md', 'application/json': '.json', 'text/csv': '.csv', 'text/html': '.html' };

function decode(data) {
  if (typeof data !== 'string' || !data) throw new Error('data must be a base64 string');
  const b64 = data.replace(/^data:[^,]*;base64,/, '');
  if (!/^[A-Za-z0-9+/=\s_-]*$/.test(b64)) throw new Error('data is not base64');
  if (Math.floor(b64.length * 3 / 4) > MAX_BYTES + 4) throw new Error(`file too large: the cap is ${MAX_BYTES / 1024 / 1024} MB`);
  const buf = Buffer.from(b64, b64.includes('-') || b64.includes('_') ? 'base64url' : 'base64');
  if (buf.length > MAX_BYTES) throw new Error(`file too large: the cap is ${MAX_BYTES / 1024 / 1024} MB`);
  if (!buf.length) throw new Error('file is empty');
  return buf;
}

export async function put({ session, name, mime, data, actor = OWNER } = {}) {
  const dirName = sessionDir(session);
  const buf = decode(data);
  const root = ROOT();
  const dir = path.join(root, dirName);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // The session dir must still be inside the uploads root after symlinks.
  const realRoot = await realpath(root); const realDir = await realpath(dir);
  if (realDir !== path.join(realRoot, dirName)) throw new Error('upload directory escapes the uploads root');
  const stamp = new Date(_deps.now()).toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
  const file = path.join(realDir, `${stamp}-${safeName(name, mime)}`);
  let final = file; let i = 1;
  while (existsSync(final)) { const ext = path.extname(file); final = `${file.slice(0, -ext.length || undefined)}-${i++}${ext}`; }
  await writeFile(final, buf, { mode: 0o600, flag: 'wx' });
  const sha256 = createHash('sha256').update(buf).digest('hex');
  await _deps.appendEvent({ type: 'upload', path: final, bytes: buf.length, session: dirName, mime: typeof mime === 'string' ? mime.slice(0, 100) : null, sha256 }, { actor });
  return { ok: true, path: final, bytes: buf.length, name: path.basename(final), mime: mime ?? null, sha256 };
}

export async function list({ session } = {}) {
  const root = ROOT();
  const dirs = session ? [sessionDir(session)] : (existsSync(root) ? await readdir(root) : []);
  const out = [];
  for (const d of dirs) {
    const dir = path.join(root, d);
    if (!existsSync(dir)) continue;
    for (const f of await readdir(dir)) {
      try { const s = await stat(path.join(dir, f)); if (s.isFile()) out.push({ session: d, name: f, path: path.join(dir, f), bytes: s.size, mtime: s.mtime.toISOString() }); } catch { /* raced */ }
    }
  }
  return { root, items: out.sort((a, b) => (a.mtime < b.mtime ? 1 : -1)).slice(0, 500) };
}

export async function remove({ path: p, actor = OWNER } = {}) {
  if (typeof p !== 'string') throw new Error('path must be a string');
  const realRoot = await realpath(ROOT()).catch(() => null);
  if (!realRoot) throw new Error('no uploads yet');
  const real = await realpath(p).catch(() => null);
  if (!real || !real.startsWith(realRoot + path.sep)) throw new Error('path is not an upload');
  const s = await stat(real);
  await unlink(real);
  await _deps.appendEvent({ type: 'upload', path: real, bytes: s.size, removed: true }, { actor });
  return { ok: true, removed: real };
}

export const ops = {
  'uploads.put': (a = {}) => put(a),
  'uploads.list': (a = {}) => list(a),
  'uploads.remove': (a = {}) => remove(a),
};
