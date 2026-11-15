// A private tmux server for the tests that need a real one: its own socket directory (TMUX_TMPDIR), no TMUX or
// TMUX_PANE that could point a client at the user's server, its own config (/dev/null unless a test gives one), and a
// stop that names the private socket. Every tmux call in the test process (core/tmux.js too) goes to that server.
// A bare `kill-server` is never sent: with TMUX_TMPDIR alone, a socket folder that is already gone would send it to the
// user's default server.
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** tmux is installed here: the real-tmux suites skip without it (CI installs it, so they run there). */
export const hasTmux = spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status === 0;

/**
 * Start the server, with its first session when `session` is given: `-f <config> new-session -d -s <session>
 * ...sessionArgs ...cmd`. The first window runs `cmd` (sleep by default), not a login shell, so no shell config of the
 * user runs. `dir` is the socket directory (made under the OS temp dir when not given); `conf` is the text of a config
 * file written there. TMUX and TMUX_PANE are removed from process.env and TMUX_TMPDIR set to `dir` before anything
 * else; `env` is a copy of process.env taken then. `restoreEnv`: stop() puts TMUX, TMUX_PANE and TMUX_TMPDIR back as
 * they were (else they stay pointed away from the user's server for the rest of the process).
 * @returns {{ dir, env, socket, bin, tmux: (args: string[]) => import('node:child_process').SpawnSyncReturns<string>, stop: () => Promise<void> }}
 */
export async function startPrivateTmux({ dir, prefix = 'drover-tmux-', conf, session, sessionArgs = [], cmd = ['sleep', '3600'], restoreEnv = false, removeDir = true } = {}) {
  const bin = spawnSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).stdout.trim() || 'tmux';
  dir ??= await mkdtemp(path.join(tmpdir(), prefix));
  const saved = Object.fromEntries(['TMUX', 'TMUX_PANE', 'TMUX_TMPDIR'].map((k) => [k, process.env[k]]));
  delete process.env.TMUX; delete process.env.TMUX_PANE;
  process.env.TMUX_TMPDIR = dir;
  const env = { ...process.env };
  const socket = path.join(dir, `tmux-${process.getuid()}`, 'default');
  const tmux = (args) => spawnSync(bin, args, { env, encoding: 'utf8' });
  const stop = async () => {
    tmux(['-S', socket, 'kill-server']);
    if (restoreEnv) for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    if (removeDir) await rm(dir, { recursive: true, force: true });
  };
  try {
    let confFile = '/dev/null';
    if (conf !== undefined) { confFile = path.join(dir, 'tmux.conf'); await writeFile(confFile, conf); }
    if (session) {
      const r = tmux(['-f', confFile, 'new-session', '-d', '-s', session, ...sessionArgs, ...cmd]);
      if (r.status !== 0) throw new Error(`private tmux: new-session failed: ${r.stderr}`);
    }
  } catch (e) { await stop(); throw e; }
  return { dir, env, socket, bin, tmux, stop };
}
