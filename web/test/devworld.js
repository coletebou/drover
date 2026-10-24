// The dev world: a Drover daemon that sees only pretend sessions, for trying clients end to end (answer a
// dialog, stream a manager reply, watch a chat grow) without any risk to the real ones. It sets up, under one
// directory: a private tmux server (its own TMUX_TMPDIR) whose windows run test/fake-agent.js (a permission
// dialog, a question, a busy session, an idle one), a Claude config dir whose registry and transcripts are
// theirs (with synthetic history: text, tool calls, results, an error), an empty truth file, no fleet hosts
// and no plugins, stand-in claude, codex, docker and ssh commands (test/showcase/fake-*.js: no Codex thread, no
// container, no host answers), the fake manager gateway (test/fake-gateway.js), and a daemon from this
// checkout (so its web UI too) on --port. Tokens are copied from the real state dir so clients reuse them.
// --showcase builds the showcase world instead (test/showcase/world.js): three hosts, every engine, docker stacks and
// a truth file with history, under a HOME of its own, for screenshots and demos.
//   node test/devworld.js [--port 7338] [--gateway 18799] [--dir DIR] [--showcase]
// Ctrl-C (or SIGTERM) stops the daemon, the gateway and the private tmux servers.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, copyFileSync, existsSync, chmodSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeGateway } from './fake-gateway.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const PORT = Number(arg('port', 7338)), GW = Number(arg('gateway', 18799));
const SHOWCASE = process.argv.includes('--showcase');
// Its real path (macOS: /var is /private/var): tmux reports a pane's folder that way, and paths must match HOME.
const given = path.resolve(arg('dir', path.join(tmpdir(), `drover-devworld-${PORT}`)));
const DIR = path.join(realpathSync(path.dirname(given)), path.basename(given));
const REAL_STATE = process.env.DROVER_STATE ?? path.join(process.env.HOME, '.local', 'state', 'drover');
// The showcase world's HOME (test/showcase/world.js), where the manager's state lives too, as on a real host.
const SHOW_HOME = path.join(DIR, 'home');
const MANAGER = SHOWCASE ? path.join(SHOW_HOME, '.openclaw-manager') : path.join(DIR, 'openclaw');

// Every tmux call here names its server by socket (-S), never by TMUX_TMPDIR alone: when TMUX_TMPDIR names a folder
// that does not exist, tmux silently uses the owner's default server, and a kill-server there ends every real
// session. The socket is the one tmux itself uses for that TMUX_TMPDIR, so the daemon (which picks its server by
// TMUX_TMPDIR) finds the same server; the isolation check below makes sure it does.
const socketOf = (tmuxDir) => path.join(tmuxDir, `tmux-${process.getuid()}`, 'default');
const tmuxAt = (tmuxDir, args, env = process.env) => { const e = { ...env }; delete e.TMUX; delete e.TMUX_PANE; return spawnSync('tmux', ['-S', socketOf(tmuxDir), ...args], { env: e, encoding: 'utf8' }); };
const killTmux = (tmuxDir) => { if (tmuxDir && existsSync(socketOf(tmuxDir))) tmuxAt(tmuxDir, ['kill-server']); };
// A dev world still running in this folder is left alone: removing its tmux folders under its live daemon would send
// that daemon to the owner's default server (it picks its server by TMUX_TMPDIR), still serving the copied token.
const alive = (pid) => { try { return Number.isInteger(pid) && pid > 0 && (process.kill(pid, 0), true); } catch { return false; } };
const running = [path.join(DIR, 'devworld.json'), path.join(DIR, 'state', 'daemon.json')]
  .map((f) => { try { const j = JSON.parse(readFileSync(f, 'utf8')); return j.daemonPid ?? j.pid; } catch { return null; } }).find(alive);
if (running) { console.error(`[devworld] a dev world is still running in ${DIR} (daemon pid ${running}): stop it first (Ctrl-C, or kill -TERM its devworld.js), or use another --dir or --port`); process.exit(1); }
// A dev world left from an earlier run: stop its tmux servers (and so its agents) before its directory goes, the
// showcase's other hosts' too (devworld.json names them; their sockets live under /tmp, see showcase/world.js).
killTmux(path.join(DIR, 'tmux'));
try { for (const r of JSON.parse(readFileSync(path.join(DIR, 'devworld.json'), 'utf8')).remotes ?? []) { killTmux(r.tmuxTmpdir); if (r.run) rmSync(r.run, { recursive: true, force: true }); } } catch { /* no earlier showcase */ }
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true, mode: 0o700 });
for (const d of ['state', 'cache', 'dotfiles/claude', 'claude/sessions', 'claude/projects', 'codex', 'bin', 'tmux', 'work', 'socks']) mkdirSync(path.join(DIR, d), { recursive: true });
mkdirSync(MANAGER, { recursive: true });
for (const f of ['token', 'widget-token']) if (existsSync(path.join(REAL_STATE, f))) { copyFileSync(path.join(REAL_STATE, f), path.join(DIR, 'state', f)); chmodSync(path.join(DIR, 'state', f), 0o600); }
writeFileSync(path.join(DIR, 'dotfiles', 'claude', 'fleet-hosts.txt'), '');
writeFileSync(path.join(DIR, 'dotfiles', 'claude', 'drover-events.jsonl'), '');
writeFileSync(path.join(MANAGER, 'openclaw.json'), '{}\n');
// A stand-in for the manager's OpenClaw CLI (core/openclaw.js status and sweep), named by an install manifest.
writeFileSync(path.join(MANAGER, 'fake-openclaw.mjs'), `const a = process.argv.slice(2).join(' ');
const out = /system event/.test(a) ? { ok: true, queued: true } : /health/.test(a) ? { ok: true, plugins: { loaded: ['dev-world'], errors: [], unavailable: [] }, configReload: { hotReloadStatus: 'active' } }
  : /automations/.test(a) ? { jobs: [{ id: 'sweep', displayName: 'Sweep (dev world)', enabled: true, status: 'idle', schedule: { kind: 'every', everyMs: 300000 } }] }
  : /usage-cost/.test(a) ? { totals: { totalCost: ${SHOWCASE ? 1.84 : 0}, totalTokens: ${SHOWCASE ? 412000 : 0} }, cacheStatus: { status: 'fresh' } } : {};
process.stdout.write(JSON.stringify(out));
`);
writeFileSync(path.join(MANAGER, 'drover-install.json'), JSON.stringify({ schema: 1, role: 'manager', profile: 'default', actor: 'manager-dev', node: { path: process.execPath, version: process.version }, openclaw: { version: 'dev-world', mjs: path.join(MANAGER, 'fake-openclaw.mjs'), dir: MANAGER }, source: { commit: 'dev-world', dirty: false } }));
// The stand-ins. A real docker would show (and restart) real stacks, and a real ssh would reach real machines.
writeFileSync(path.join(DIR, 'bin', 'claude'), '#!/bin/sh\n# dev world: `claude agents --json` lists nothing beyond the registry\necho "[]"\n');
for (const b of ['codex', 'docker', 'ssh']) writeFileSync(path.join(DIR, 'bin', b), `#!/bin/sh\nexec "${process.execPath}" "${path.join(HERE, 'showcase', `fake-${b}.js`)}" "$@"\n`);
// This checkout's CLI, for a shell that sources env.sh (written below once the daemon's environment is known).
writeFileSync(path.join(DIR, 'bin', 'drover'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(ROOT, 'bin', 'drover')}" "$@"\n`);
for (const b of ['claude', 'codex', 'docker', 'ssh', 'drover']) chmodSync(path.join(DIR, 'bin', b), 0o755);
writeFileSync(path.join(DIR, 'containers.jsonl'), '');
writeFileSync(path.join(DIR, 'hosts.json'), JSON.stringify({ drover: path.join(ROOT, 'bin', 'drover'), hosts: {} }), { mode: 0o600 });

// Secrets come in through the inherited environment too (the shell may export ~/.env_secrets), whatever
// DROVER_SECRETS_FILE says below: with them a plugin's ops here would reach the real services they talk to, as the
// owner, where a comment is a real comment. No plugin loads here (DROVER_PLUGINS below), and every name that file
// sets is dropped as well (only the names are kept from it), before any of the dev world's own settings go on top
// (so none of those can go with them).
const REAL_SECRETS = process.env.DROVER_SECRETS_FILE ?? path.join(process.env.HOME, '.env_secrets');
const secretNames = existsSync(REAL_SECRETS) ? readFileSync(REAL_SECRETS, 'utf8').split('\n').map((l) => l.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1]).filter(Boolean) : [];
const inherited = { ...process.env };
for (const k of secretNames) delete inherited[k];
for (const k of ['TMUX', 'TMUX_PANE', 'DROVER_BOTS_URL', 'DROVER_BIND', 'APXW_STATE', 'APXW_CACHE']) delete inherited[k];
// A GIT_DIR, GIT_WORK_TREE or GIT_INDEX_FILE from the caller would point every git call here (the world's checkouts,
// the daemon's look at a stack's code) at the caller's own repository.
for (const k of Object.keys(inherited)) if (k.startsWith('GIT_')) delete inherited[k];
// What every daemon here runs with: no plugins (an empty list, not the default plugin directory: a plugin's hosts
// would be real hosts here, and a press or a message on one of them would go to a real session; its ops would reach
// real services), no secrets file, no search index, and the stand-ins first on PATH.
const isolated = {
  ...inherited,
  PATH: `${path.join(DIR, 'bin')}:${process.env.PATH}`,
  DROVER_DOTFILES: path.join(DIR, 'dotfiles'), DROVER_EVENTS: path.join(DIR, 'dotfiles', 'claude', 'drover-events.jsonl'),
  DROVER_SECRETS_FILE: '/dev/null', DROVER_SEARCH: 'off', DROVER_PLUGINS: '',
  DROVER_DOCKER: path.join(DIR, 'bin', 'docker'), DEVWORLD_CONTAINERS: path.join(DIR, 'containers.jsonl'), DEVWORLD_HOSTS: path.join(DIR, 'hosts.json'),
};
const show = SHOWCASE ? (await import('./showcase/world.js')).prepare({ dir: DIR, root: ROOT, base: isolated, home: SHOW_HOME }) : null;

// ------------------------------------------------------------ synthetic history
const sid = () => randomUUID();
const AGENTS = (show?.front.agents ?? [
  { name: 'demo-build', mode: 'dialog' },
  { name: 'demo-review', mode: 'question' },
  { name: 'demo-work', mode: 'busy' },
  { name: 'demo-idle', mode: 'idle' },
]).map((a) => ({ ...a, sid: sid() }));
/** A Claude transcript for one agent, in the Claude config dir of its host. */
function seed({ name, sid, cwd = path.join(DIR, 'work', name), title = `${name}: parser work` }, claudeDir = path.join(DIR, 'claude')) {
  mkdirSync(cwd, { recursive: true });
  const file = path.join(claudeDir, 'projects', cwd.replace(/[\\/:]/g, '-'), `${sid}.jsonl`);
  mkdirSync(path.dirname(file), { recursive: true });
  let t = Date.now() - 40 * 60_000;
  const lines = [];
  const at = () => new Date((t += 20_000)).toISOString();
  const base = () => ({ sessionId: sid, cwd, version: '2.1.304', timestamp: at(), uuid: randomUUID() });
  const user = (content, extra = {}) => lines.push({ ...base(), type: 'user', message: { role: 'user', content }, ...extra });
  const assistant = (block) => lines.push({ ...base(), type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5-5', content: [block] } });
  const tool = (name, input, output, isError = false) => { const id = `toolu_seed_${randomUUID().slice(0, 10)}`; assistant({ type: 'tool_use', id, name, input }); user([{ type: 'tool_result', tool_use_id: id, content: output, is_error: isError }]); };
  lines.push({ type: 'ai-title', title, timestamp: at() });
  user(`Make the demo parser keep line numbers in its errors, then run the tests. (${name})`);
  assistant({ type: 'thinking', thinking: '', signature: 'x' });
  assistant({ type: 'text', text: 'I will read the parser first, find where errors are raised, then add the line number.\n\n1. Read `src/parser.js`\n2. Find every `throw`\n3. Add a test' });
  tool('Read', { file_path: path.join(cwd, 'src/parser.js') }, '1\texport function parse(text) {\n2\t  const tokens = tokenize(text);\n3\t  if (!tokens.length) throw new Error("empty input");\n4\t  return build(tokens);\n5\t}');
  tool('Grep', { pattern: 'throw new Error', path: 'src', output_mode: 'content' }, 'src/parser.js:3:  if (!tokens.length) throw new Error("empty input");\nsrc/lexer.js:18:    throw new Error(`bad token ${c}`);');
  tool('Edit', { file_path: path.join(cwd, 'src/lexer.js'), old_string: 'throw new Error(`bad token ${c}`);', new_string: 'throw new Error(`bad token ${c} at line ${line}`);' }, 'The file src/lexer.js has been updated successfully.');
  tool('Bash', { command: 'npm test', description: 'Run the unit tests' }, '> demo@1.0.0 test\n> node --test\n\n✖ lexer reports the line (3.1ms)\n  AssertionError: expected "bad token % at line 2"\nℹ tests 2\nℹ fail 1', true);
  assistant({ type: 'text', text: 'One test fails: the lexer counts lines from 0. Fixing the off-by-one:\n\n```js\nlet line = 1;\nfor (const c of text) if (c === "\\n") line++;\n```' });
  tool('Edit', { file_path: path.join(cwd, 'src/lexer.js'), old_string: 'let line = 0;', new_string: 'let line = 1;' }, 'The file src/lexer.js has been updated successfully.');
  tool('TodoWrite', { todos: [{ content: 'line numbers in lexer errors', status: 'completed' }, { content: 'line numbers in parser errors', status: 'in_progress' }] }, 'Todos have been modified successfully.');
  assistant({ type: 'text', text: 'The lexer now reports **line numbers**. Next: the same for parser errors.' });
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}
for (const a of AGENTS) seed(a);

// ------------------------------------------------------------ the private tmux servers and their agents
// TMUX names the world's own socket too: tmux takes it over TMUX_TMPDIR, and when that socket is gone (the world stopped,
// its folder removed) a call fails instead of falling back to the owner's default server. The daemon, env.sh and the
// shells it starts all get it; the world's own tmux calls name the socket themselves (tmuxAt).
const tmuxEnv = { ...isolated, TMUX_TMPDIR: path.join(DIR, 'tmux'), TMUX: `${socketOf(path.join(DIR, 'tmux'))},0,0`, CLAUDE_CONFIG_DIR: path.join(DIR, 'claude'), ...show?.front.env };
const tmuxIn = (env) => {
  mkdirSync(path.dirname(socketOf(env.TMUX_TMPDIR)), { recursive: true, mode: 0o700 });
  return (args) => { const r = tmuxAt(env.TMUX_TMPDIR, args, env); if (r.status !== 0) throw new Error(`tmux ${args.join(' ')}: ${r.stderr}`); return r.stdout; };
};
/** One host's tmux server: a shell window in home, then a window per agent in its folder, each running test/fake-agent.js. */
function startAgents(env, agents, hostDir, session, home, socks) {
  const tmux = tmuxIn(env);
  tmux(['-f', '/dev/null', 'new-session', '-d', '-s', session, '-x', '160', '-y', '45', '-n', 'shell', '-c', home, 'sleep', '100000000']);
  for (const a of agents) {
    const cwd = a.cwd ?? path.join(hostDir, 'work', a.name);
    const extra = [...(a.task ? ['--task', a.task] : []), ...(a.done ? ['--done', a.done] : [])];
    tmux(['new-window', '-d', '-t', `${session}:`, '-n', a.name, '-c', cwd, process.execPath, path.join(HERE, 'fake-agent.js'), '--mode', a.mode, '--name', a.name, '--sid', a.sid, '--dir', hostDir, '--cwd', cwd, ...(socks ? ['--socks', socks] : []), ...extra]);
  }
}
startAgents(tmuxEnv, AGENTS, DIR, show ? 'work' : 'demo', show?.home ?? DIR);
// The showcase's other hosts: their own Claude config dir, tmux server and agents, reached through the stand-in ssh.
const remotes = (show?.remotes ?? []).map((r) => ({ ...r, agents: r.agents.map((a) => ({ ...a, sid: sid() })) }));
for (const r of remotes) {
  for (const a of r.agents) seed(a, r.env.CLAUDE_CONFIG_DIR);
  startAgents(r.env, r.agents, r.dir, 'work', show.home, r.socks);
}

// ------------------------------------------------------------ gateway and daemon
const gateway = await startFakeGateway({ port: GW, token: 'dev', ...(show ? { replies: show.replies } : {}) });
const env = {
  ...tmuxEnv,
  DROVER_STATE: path.join(DIR, 'state'), DROVER_CACHE: path.join(DIR, 'cache'), DROVER_SHARE: path.join(DIR, 'share'),
  CODEX_HOME: path.join(DIR, 'codex'),
  OPENCLAW_MANAGER_STATE_DIR: MANAGER, OPENCLAW_GATEWAY_URL: `http://127.0.0.1:${gateway.port}`, OPENCLAW_GATEWAY_TOKEN: 'dev',
};
// What a shell needs to use the CLI and the TUI here (`. <dir>/env.sh`): the settings the daemon got on top of the
// shell's own environment (TMUX among them, naming the world's socket: the shell's own TMUX would reach the owner's
// server), no TMUX_PANE and no GIT_* (a GIT_DIR would point the CLI's look at a stack's code at the shell's own repository).
const shq = (v) => `'${String(v).replaceAll("'", "'\\''")}'`;
writeFileSync(path.join(DIR, 'env.sh'), 'unset TMUX TMUX_PANE\nfor v in $(env | awk -F= \'/^GIT_/ { print $1 }\'); do unset "$v"; done\n' + Object.entries(env).filter(([k, v]) => inherited[k] !== v).map(([k, v]) => `export ${k}=${shq(v)}`).join('\n') + '\n', { mode: 0o600 });
const daemon = spawn(process.execPath, [path.join(ROOT, 'bin', 'drover'), 'serve', '--port', String(PORT)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
daemon.stdout.on('data', (d) => process.stdout.write(`[daemon] ${d}`));
daemon.stderr.on('data', (d) => process.stderr.write(`[daemon] ${d}`));
daemon.on('exit', (code) => { console.log(`[devworld] daemon exited ${code}`); stop(1); });

let stopped = false;
async function stop(code = 0) {
  if (stopped) return; stopped = true;
  try { daemon.kill('SIGTERM'); } catch { /* gone */ }
  for (const e of [tmuxEnv, ...remotes.map((r) => r.env)]) { try { killTmux(e.TMUX_TMPDIR); } catch { /* gone */ } }
  for (const r of remotes) rmSync(r.run, { recursive: true, force: true });
  // A shell that sourced env.sh keeps the stand-in ssh: once stopped, it knows no host.
  try { writeFileSync(path.join(DIR, 'hosts.json'), JSON.stringify({ drover: path.join(ROOT, 'bin', 'drover'), hosts: {} }), { mode: 0o600 }); } catch { /* gone */ }
  await gateway.close().catch(() => {});
  process.exit(code);
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

const token = existsSync(path.join(DIR, 'state', 'token')) ? readFileSync(path.join(DIR, 'state', 'token'), 'utf8').trim() : null;
// The daemon that answers must be the one started here: its pid in its own daemon.json, the port its URL. Another
// daemon already on the port (this one then fails to bind and exits) would pass every check below with the copied token.
const ownDaemon = () => { try { const d = JSON.parse(readFileSync(path.join(DIR, 'state', 'daemon.json'), 'utf8')); return d.pid === daemon.pid && new URL(d.url).port === String(PORT); } catch { return false; } };
for (let i = 0; i < 100 && daemon.exitCode === null; i++) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/api/op/host.identity`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' }); if (r.ok && ownDaemon()) break; } catch { /* not yet */ }
  await new Promise((r) => setTimeout(r, 200));
}
if (daemon.exitCode !== null || !ownDaemon()) { console.error(`[devworld] the daemon started here is not the one answering on port ${PORT}, stopping`); await stop(1); }
// It runs only isolated: its own hosts alone (this one, and the showcase's pretend ones), no plugin loaded, and its
// own tmux server alone (a daemon that reached the owner's would answer and type into their real sessions),
// whatever the daemon's own defaults become.
const op = async (name) => {
  try { return await (await fetch(`http://127.0.0.1:${PORT}/api/op/${name}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' })).json(); }
  catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
};
const seen = (await op('host.list')).result?.map((h) => h.name) ?? null;
let loaded = null;
try { loaded = (await (await fetch(`http://127.0.0.1:${PORT}/api/ops`, { headers: { authorization: `Bearer ${token}` } })).json()).plugins?.map((p) => p.name) ?? null; } catch { /* no answer: not isolated */ }
const sessions = (await op('tmux.sessions')).result?.map((x) => x.name) ?? null;
if (JSON.stringify(seen) !== JSON.stringify(show?.expectedHosts ?? ['local']) || !Array.isArray(loaded) || loaded.length || JSON.stringify(sessions) !== JSON.stringify([show ? 'work' : 'demo'])) {
  console.error(`[devworld] not isolated, stopping: hosts ${JSON.stringify(seen)}, plugins ${JSON.stringify(loaded)}, tmux sessions ${JSON.stringify(sessions)}`);
  await stop(1);
}
writeFileSync(path.join(DIR, 'devworld.json'), JSON.stringify({ port: PORT, gateway: gateway.port, dir: DIR, daemonPid: daemon.pid, tmuxTmpdir: tmuxEnv.TMUX_TMPDIR, agents: AGENTS, showcase: SHOWCASE, ...(show ? { home: show.home, remotes: remotes.map((r) => ({ name: r.name, tmuxTmpdir: r.env.TMUX_TMPDIR, run: r.run, agents: r.agents })) } : {}) }, null, 2));
console.log(`[devworld] daemon http://127.0.0.1:${PORT} (token: the real token file, copied), fake manager gateway :${gateway.port}`);
console.log(`[devworld] agents in a private tmux server: ${AGENTS.map((a) => `${a.name} (${a.mode})`).join(', ')}`);
for (const r of remotes) console.log(`[devworld] ${r.name}: ${r.agents.map((a) => `${a.name} (${a.mode})`).join(', ')} (tmux -S ${socketOf(r.env.TMUX_TMPDIR)} attach -t work)`);
// Named by socket: pasted inside the owner's tmux, TMUX would beat TMUX_TMPDIR and attach their own session of that name.
console.log(`[devworld] watch them: tmux -S ${socketOf(tmuxEnv.TMUX_TMPDIR)} attach -t ${show ? 'work' : 'demo'}`);
console.log(`[devworld] the CLI and the TUI here: . ${path.join(DIR, 'env.sh')} && drover tui`);
console.log(`[devworld] a dialog comes back about 12 s after it is answered; manager messages starting "slow " stream for about 8 s, "fail " fail, "echo " echo`);
