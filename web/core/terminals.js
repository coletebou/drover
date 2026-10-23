// Real terminals in the browser: one ttyd per opened tmux target, bound to
// 127.0.0.1 on an ephemeral port, reaped when the page closes it or after idle.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { tryRun } from './proc.js';
import { assertTarget } from './tmux.js';
import { uuidv7 } from './ids.js';

const terms = new Map(); // id -> { id, target, port, pid, startedAt, child, credential }

export async function ttydAvailable() {
  const r = await tryRun('ttyd', ['--version']);
  return r.code === 0 ? r.stdout.trim() || r.stderr.trim() : null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer(); s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/** Start a ttyd attached (read-write) to a tmux target. Returns {id, url}. */
export async function open(target, { bind = '127.0.0.1', readOnly = false } = {}) {
  assertTarget(target);
  const existing = [...terms.values()].find((t) => t.target === target && t.child.exitCode === null);
  if (existing) return describe(existing);
  if (!(await ttydAvailable())) throw new Error('ttyd is not installed on this host');
  const port = await freePort();
  const id = uuidv7();
  // -O (check origin): the terminal's websocket takes only its own page. Without it any web page the browser opens
  // could connect to 127.0.0.1:<port>/ws and type into the tmux session (browsers let any origin open a websocket to
  // loopback). The iframe Drover shows loads ttyd's own page, so its Origin matches.
  const argv = ['-p', String(port), '-i', bind, '-O', '-t', 'disableLeaveAlert=true', '-t', 'macOptionIsMeta=true', '-o', ...(readOnly ? [] : ['-W']), 'tmux', 'attach-session', '-t', target];
  const child = spawn('ttyd', argv, { stdio: ['ignore', 'pipe', 'pipe'] });
  const entry = { id, target, port, bind, pid: child.pid, startedAt: new Date().toISOString(), child, readOnly, lastSeen: Date.now() };
  child.on('close', () => { entry.exited = true; setTimeout(() => terms.delete(id), 30_000).unref(); });
  terms.set(id, entry);
  await new Promise((r) => setTimeout(r, 250));
  return describe(entry);
}

function describe(t) {
  return { id: t.id, target: t.target, port: t.port, bind: t.bind, url: `http://${t.bind}:${t.port}/`, startedAt: t.startedAt, readOnly: t.readOnly, alive: t.child.exitCode === null && !t.exited };
}

export function list() { return [...terms.values()].map(describe); }

export function close(id) {
  const t = terms.get(id); if (!t) return { ok: false, error: 'no such terminal' };
  t.child.kill('SIGTERM'); terms.delete(id); return { ok: true };
}

export function touch(id) { const t = terms.get(id); if (t) t.lastSeen = Date.now(); }

export function closeAll() { for (const t of terms.values()) t.child.kill('SIGTERM'); terms.clear(); }

setInterval(() => {
  const now = Date.now();
  for (const t of terms.values()) if (now - t.lastSeen > 2 * 3600_000) { t.child.kill('SIGTERM'); terms.delete(t.id); }
}, 5 * 60_000).unref();
