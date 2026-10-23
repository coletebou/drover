// Private tmux servers for the TUI's end-to-end tests. Each one has its own socket directory (TMUX_TMPDIR), its own
// socket name (-L), no user config (-f /dev/null), no TMUX or TMUX_PANE from the caller, and a scratch HOME: a test
// can never reach the user's tmux server, and a TUI started in it can never fall back to the real state dir.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const hasTmux = spawnSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).status === 0;

/**
 * A scratch directory with home/, state/, cache/, share/ and xdg/ inside, and a socket directory for tmux under a
 * short /tmp path: a Unix socket path is limited to about 104 bytes on macOS, and the per-user temp dir is deep.
 */
export function scratch(prefix = 'drover-tui-') {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  for (const d of ['home', 'state', 'cache', 'share', 'xdg']) mkdirSync(path.join(dir, d), { recursive: true, mode: 0o700 });
  const sock = mkdtempSync(path.join(existsSync('/tmp') ? '/tmp' : tmpdir(), 'dtui-'));
  return { dir, sock, rm: () => { rmSync(dir, { recursive: true, force: true }); rmSync(sock, { recursive: true, force: true }); }, p: (...x) => (x[0] === 'tmux' ? path.join(sock, ...x.slice(1)) : path.join(dir, ...x)) };
}

/** The environment of processes in a test server: scratch HOME and state, a UTF-8 locale, the caller's PATH. */
export function testEnv(s, extra = {}) {
  const env = {
    PATH: process.env.PATH, HOME: s.p('home'), TMUX_TMPDIR: s.p('tmux'), LANG: 'en_US.UTF-8', TERM: 'xterm-256color',
    DROVER_STATE: s.p('state'), DROVER_CACHE: s.p('cache'), DROVER_SHARE: s.p('share'), XDG_CONFIG_HOME: s.p('xdg'), ...extra,
  };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  return env;
}

export function server(name, env) {
  const t = (args, opts = {}) => spawnSync('tmux', ['-L', name, ...args], { env, encoding: 'utf8', ...opts });
  const socket = path.join(env.TMUX_TMPDIR, `tmux-${process.getuid()}`, name);
  return {
    name, socket, env,
    run: t,
    /** The environment a command inside this server's pane would have (for CLIs that act on "their" tmux). */
    paneEnv: (pane = '%0', extra = {}) => ({ ...env, TMUX: `${socket},0,0`, TMUX_PANE: pane, ...extra }),
    capture: (target) => t(['capture-pane', '-p', '-t', target]).stdout,
    keys: (target, ...keys) => t(['send-keys', '-t', target, ...keys]),
    type: (target, text) => t(['send-keys', '-t', target, '-l', text]),
    kill: () => t(['kill-server']),
  };
}

/** Poll fn until it returns something truthy; throws with the last value (a screen) when time runs out. */
export async function waitFor(fn, { timeout = 10_000, every = 80, what = 'condition' } = {}) {
  const end = Date.now() + timeout; let last;
  for (;;) {
    last = await fn();
    if (last) return last;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, every));
  }
}
