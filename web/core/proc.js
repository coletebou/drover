// Child-process helpers. Every command is spawn(file, argv): no shell, so no
// interpolation of page text into a command line ever happens.
import { spawn } from 'node:child_process';
import { userInfo } from 'node:os';
import path from 'node:path';

export class ProcError extends Error {
  constructor(file, argv, code, stderr) {
    super(`${file} ${argv.join(' ')} exited ${code}: ${stderr.trim().slice(0, 500)}`);
    this.file = file; this.argv = argv; this.code = code; this.stderr = stderr;
  }
}

/**
 * Run a command to completion.
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
export function run(file, argv = [], { input, timeoutMs = 30_000, env, cwd, okCodes = [0] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, argv, { stdio: ['pipe', 'pipe', 'pipe'], env: env ?? process.env, cwd });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${file} timed out after ${timeoutMs}ms`)); }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (okCodes.includes(code)) resolve({ code, stdout, stderr });
      else reject(new ProcError(file, argv, code, stderr));
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** Like run() but never rejects on a non-zero exit; returns code for the caller to judge. */
export function tryRun(file, argv = [], opts = {}) {
  return run(file, argv, { ...opts, okCodes: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 255] }).catch((e) => ({ code: -1, stdout: '', stderr: String(e.message ?? e) }));
}

/**
 * Run a command to completion, keeping at most maxBytes of stdout and maxStderr of stderr: past a cap the rest is read
 * and dropped (truncated: true), so a chatty command can neither fill memory nor stall on a full pipe, and still ends
 * with its real exit code. A timeout kills its whole process group (SIGKILL, timedOut: true): the child runs in a group
 * of its own because what it starts holds the pipes too (`docker compose` is a plugin the docker CLI runs as a child,
 * and a shell's commands are its children), so killing the child alone would leave the wait running. Never rejects on
 * an exit code or a timeout; rejects only when the file cannot be started (ENOENT, EACCES). tail: keep the last bytes
 * of each stream instead of the first (logs, where the newest lines matter).
 * Resolves { code, signal, stdout, stderr, truncated, timedOut }.
 */
export function runCapped(file, argv = [], { input, timeoutMs = 30_000, env, cwd, maxBytes = 1 << 20, maxStderr = 64 << 10, tail = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, argv, { stdio: ['pipe', 'pipe', 'pipe'], env: env ?? process.env, cwd, detached: true });
    const out = { chunks: [], bytes: 0, cut: false }, err = { chunks: [], bytes: 0, cut: false };
    const keep = (sink, cap) => (d) => {
      if (tail) {
        sink.chunks.push(d); sink.bytes += d.length;
        while (sink.bytes > cap) {
          const over = sink.bytes - cap, head = sink.chunks[0];
          if (head.length <= over) { sink.chunks.shift(); sink.bytes -= head.length; } else { sink.chunks[0] = head.subarray(over); sink.bytes -= over; }
          sink.cut = true;
        }
        return;
      }
      const room = cap - sink.bytes;
      if (room <= 0) { sink.cut = true; return; }
      if (d.length > room) { sink.cut = true; d = d.subarray(0, room); }
      sink.chunks.push(d); sink.bytes += d.length;
    };
    let timedOut = false, done = false;
    const finish = (code, signal) => {
      if (done) return;
      done = true; clearTimeout(timer);
      resolve({ code, signal, stdout: Buffer.concat(out.chunks).toString('utf8'), stderr: Buffer.concat(err.chunks).toString('utf8'), truncated: out.cut || err.cut, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }, timeoutMs);
    child.stdout.on('data', keep(out, maxBytes));
    child.stderr.on('data', keep(err, maxStderr));
    child.stdin.on('error', () => { /* the child exited before reading its input */ });
    child.on('error', (e) => { if (done) return; done = true; clearTimeout(timer); reject(e); });
    // After a timeout the child's exit settles it: a process that left the group could still hold the pipes open.
    child.on('exit', (code, signal) => { if (timedOut) { child.stdout.destroy(); child.stderr.destroy(); finish(code, signal); } });
    child.on('close', finish);
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** Start a long-lived child and return it with line-oriented stdout handling. */
export function startLines(file, argv, { env, cwd, onLine, onStderr, onExit } = {}) {
  const child = spawn(file, argv, { stdio: ['pipe', 'pipe', 'pipe'], env: env ?? process.env, cwd });
  let buf = '';
  child.stdout.setEncoding('utf8').on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (line.trim()) onLine?.(line);
    }
  });
  child.stderr.setEncoding('utf8').on('data', (d) => onStderr?.(d));
  // A command that is not installed (codex on a box without it) fails as an 'error' event, which unheard ends the
  // whole process: it is the exit instead, once (a 'close' can follow it), and a write to its stdin fails quietly.
  let ended = false;
  const end = (code, sig) => { if (ended) return; ended = true; if (buf.trim()) onLine?.(buf); onExit?.(code, sig); };
  child.on('error', (e) => { onStderr?.(`${file}: ${e.message}\n`); end(null, e.code ?? 'error'); });
  child.stdin.on('error', () => { /* the child's own error or close reports it */ });
  child.on('close', end);
  return child;
}

const LOGIN_PATH_MARK = '__DROVER_LOGIN_PATH__=';

/**
 * The PATH a login shell of the user's own shell builds from env, for the agents Drover launches. The daemon's own
 * PATH is whatever its launcher left: the LaunchAgent's `bash -lc` runs macOS path_helper, which puts /usr/bin and
 * /bin first, so on 2026-10-17 an agent's `bash` was /bin/bash 3.2 and dotsync and the dotfiles pre-push hook refused
 * to run in it. The shell's entries come first, then any entry of env.PATH it dropped, so whatever resolved before
 * still resolves. Only absolute dirs are taken from the shell's PATH line. Falls back to env.PATH when there is no
 * shell, or it fails, hangs or prints no PATH line with an absolute dir. The command is a constant and stdin is
 * closed, so a profile that reads input gets EOF.
 */
export async function loginShellPath({ env = process.env, shell = env.SHELL || passwdShell(), timeoutMs = 10_000 } = {}) {
  const base = env.PATH ?? '';
  if (!shell || !path.isAbsolute(shell)) return base;
  const out = await run(shell, ['-l', '-c', `printf '\\n${LOGIN_PATH_MARK}%s\\n' "$PATH"`], { env, timeoutMs }).catch(() => null);
  const line = out?.stdout.split('\n').findLast((l) => l.startsWith(LOGIN_PATH_MARK));
  const login = line?.slice(LOGIN_PATH_MARK.length).split(':').filter((d) => path.isAbsolute(d)) ?? [];
  if (!login.length) return base;
  return [...new Set([...login, ...base.split(':').filter(Boolean)])].join(':');
}

function passwdShell() {
  try { return userInfo().shell; } catch { return null; }   // no passwd entry (some containers)
}

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
