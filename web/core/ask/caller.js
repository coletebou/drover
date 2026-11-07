// Which agent session a process works for: the nearest ancestor that is a Claude Code session, by its registry file
// (~/.claude/sessions/<pid>.json). drover_ask (the MCP server's parent is the session) and `drover ask` (run from an
// agent's Bash tool: session -> shell -> drover) use it so an answer comes back to whoever asked without the agent
// having to know its own id. Codex threads have no such file: they pass sessionId themselves.
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';

export const _deps = {
  sessionsDir: () => path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(process.env.HOME, '.claude'), 'sessions'),
  readFile: (f) => readFile(f, 'utf8'),
  platform: () => process.platform,
  ps: (pid) => new Promise((resolve) => execFile('ps', ['-o', 'ppid=', '-p', String(pid)], { timeout: 3000 }, (e, out) => resolve(e ? null : Number(String(out).trim()) || null))),
  psComm: (pid) => new Promise((resolve) => execFile('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { timeout: 3000 }, (e, out) => { const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(String(out)); resolve(e || !m ? null : { ppid: Number(m[1]), comm: m[2] }); })),
};

async function parentOf(pid) {
  if (_deps.platform() === 'linux') {
    try {
      // /proc/<pid>/stat: "pid (comm) state ppid ...", and comm may hold spaces or parentheses: read after the last ")".
      const stat = await _deps.readFile(`/proc/${pid}/stat`);
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      return Number.isInteger(ppid) && ppid > 0 ? ppid : null;
    } catch { return null; }
  }
  return _deps.ps(pid);
}

/** This process and its ancestors, nearest first: [{ pid, comm }] (comm the program's base name), up to depth entries. */
export async function ancestry(pid = process.pid, depth = 4) {
  const out = [];
  let p = pid;
  for (let i = 0; i < depth && p && p > 0; i++) {
    let comm = null, ppid = null;
    if (_deps.platform() === 'linux') {
      try {
        const stat = await _deps.readFile(`/proc/${p}/stat`);
        comm = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'));
        ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) || null;
      } catch { break; }
    } else {
      const r = await _deps.psComm(p);
      if (!r) break;
      ({ comm, ppid } = r);
    }
    out.push({ pid: p, comm: path.basename(String(comm ?? '')) });
    p = ppid;
  }
  return out;
}

/** { sessionId, name, cwd, pid } of the nearest Claude Code session above pid (default this process's parent), or null. */
export async function callerSession({ pid = process.ppid, depth = 8 } = {}) {
  let p = pid;
  for (let i = 0; i < depth && p && p > 1; i++) {
    try {
      const d = JSON.parse(await _deps.readFile(path.join(_deps.sessionsDir(), `${p}.json`)));
      if (typeof d?.sessionId === 'string' && d.sessionId) return { sessionId: d.sessionId, name: typeof d.name === 'string' ? d.name : null, cwd: typeof d.cwd === 'string' ? d.cwd : null, pid: p };
    } catch { /* not a session */ }
    p = await parentOf(p);
  }
  return null;
}
