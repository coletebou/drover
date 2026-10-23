// The dev world: a Drover daemon that sees only pretend sessions, for trying clients end to end (answer a
// dialog, stream a manager reply, watch a chat grow) without any risk to the real ones. It sets up, under one
// directory: a private tmux server (its own TMUX_TMPDIR) whose windows run test/fake-agent.js (a permission
// dialog, a question, a busy session, an idle one), a Claude config dir whose registry and transcripts are
// theirs (with synthetic history: text, tool calls, results, an error), an empty truth file, no fleet hosts
// and no plugins, stand-in claude and codex commands, the fake manager gateway (test/fake-gateway.js), and a daemon from this
// checkout (so its web UI too) on --port. Tokens are copied from the real state dir so clients reuse them.
//   node test/devworld.js [--port 7338] [--gateway 18799] [--dir DIR]
// Ctrl-C (or SIGTERM) stops the daemon, the gateway and the private tmux server.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, copyFileSync, existsSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeGateway } from './fake-gateway.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const PORT = Number(arg('port', 7338)), GW = Number(arg('gateway', 18799));
const DIR = path.resolve(arg('dir', path.join(tmpdir(), `drover-devworld-${PORT}`)));
const REAL_STATE = process.env.DROVER_STATE ?? path.join(process.env.HOME, '.local', 'state', 'drover');

// A dev world left from an earlier run: stop its tmux server (and so its agents) before its directory goes.
{ const e = { ...process.env, TMUX_TMPDIR: path.join(DIR, 'tmux') }; delete e.TMUX; delete e.TMUX_PANE; if (existsSync(path.join(DIR, 'tmux'))) spawnSync('tmux', ['kill-server'], { env: e }); }
rmSync(DIR, { recursive: true, force: true });
for (const d of ['state', 'cache', 'dotfiles/claude', 'claude/sessions', 'claude/projects', 'codex', 'bin', 'tmux', 'openclaw', 'work', 'socks']) mkdirSync(path.join(DIR, d), { recursive: true });
for (const f of ['token', 'widget-token']) if (existsSync(path.join(REAL_STATE, f))) { copyFileSync(path.join(REAL_STATE, f), path.join(DIR, 'state', f)); chmodSync(path.join(DIR, 'state', f), 0o600); }
writeFileSync(path.join(DIR, 'dotfiles', 'claude', 'fleet-hosts.txt'), '');
writeFileSync(path.join(DIR, 'dotfiles', 'claude', 'drover-events.jsonl'), '');
writeFileSync(path.join(DIR, 'openclaw', 'openclaw.json'), '{}\n');
// A stand-in for the manager's OpenClaw CLI (core/openclaw.js status and sweep), named by an install manifest.
writeFileSync(path.join(DIR, 'openclaw', 'fake-openclaw.mjs'), `const a = process.argv.slice(2).join(' ');
const out = /system event/.test(a) ? { ok: true, queued: true } : /health/.test(a) ? { ok: true, plugins: { loaded: ['dev-world'], errors: [], unavailable: [] }, configReload: { hotReloadStatus: 'active' } }
  : /automations/.test(a) ? { jobs: [{ id: 'sweep', displayName: 'Sweep (dev world)', enabled: true, status: 'idle', schedule: { kind: 'every', everyMs: 300000 } }] }
  : /usage-cost/.test(a) ? { totals: { totalCost: 0, totalTokens: 0 }, cacheStatus: { status: 'fresh' } } : {};
process.stdout.write(JSON.stringify(out));
`);
writeFileSync(path.join(DIR, 'openclaw', 'drover-install.json'), JSON.stringify({ schema: 1, role: 'manager', profile: 'default', actor: 'manager-dev', node: { path: process.execPath, version: process.version }, openclaw: { version: 'dev-world', mjs: path.join(DIR, 'openclaw', 'fake-openclaw.mjs'), dir: path.join(DIR, 'openclaw') }, source: { commit: 'dev-world', dirty: false } }));
writeFileSync(path.join(DIR, 'bin', 'claude'), '#!/bin/sh\n# dev world: `claude agents --json` lists nothing beyond the registry\necho "[]"\n');
writeFileSync(path.join(DIR, 'bin', 'codex'), '#!/bin/sh\necho "codex is not part of the dev world" >&2\nexit 1\n');
for (const b of ['claude', 'codex']) chmodSync(path.join(DIR, 'bin', b), 0o755);

// ------------------------------------------------------------ synthetic history
const AGENTS = [
  { name: 'demo-build', mode: 'dialog', sid: randomUUID() },
  { name: 'demo-review', mode: 'question', sid: randomUUID() },
  { name: 'demo-work', mode: 'busy', sid: randomUUID() },
  { name: 'demo-idle', mode: 'idle', sid: randomUUID() },
];
function seed({ name, sid }) {
  const cwd = path.join(DIR, 'work', name);
  mkdirSync(cwd, { recursive: true });
  const file = path.join(DIR, 'claude', 'projects', cwd.replace(/[\\/:]/g, '-'), `${sid}.jsonl`);
  mkdirSync(path.dirname(file), { recursive: true });
  let t = Date.now() - 40 * 60_000;
  const lines = [];
  const at = () => new Date((t += 20_000)).toISOString();
  const base = () => ({ sessionId: sid, cwd, version: '2.1.304', timestamp: at(), uuid: randomUUID() });
  const user = (content, extra = {}) => lines.push({ ...base(), type: 'user', message: { role: 'user', content }, ...extra });
  const assistant = (block) => lines.push({ ...base(), type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5-5', content: [block] } });
  const tool = (name, input, output, isError = false) => { const id = `toolu_seed_${randomUUID().slice(0, 10)}`; assistant({ type: 'tool_use', id, name, input }); user([{ type: 'tool_result', tool_use_id: id, content: output, is_error: isError }]); };
  lines.push({ type: 'ai-title', title: `${name}: parser work`, timestamp: at() });
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

// ------------------------------------------------------------ the private tmux server and its agents
// Secrets come in through the inherited environment too (the shell may export ~/.env_secrets), whatever
// DROVER_SECRETS_FILE says below: with them a plugin's ops here would reach the real services they talk to, as the
// owner, where a comment is a real comment. No plugin loads here (DROVER_PLUGINS below), and every name that file
// sets is dropped as well (only the names are kept from it), before any of the dev world's own settings go on top
// (so none of those can go with them).
const REAL_SECRETS = process.env.DROVER_SECRETS_FILE ?? path.join(process.env.HOME, '.env_secrets');
const secretNames = existsSync(REAL_SECRETS) ? readFileSync(REAL_SECRETS, 'utf8').split('\n').map((l) => l.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1]).filter(Boolean) : [];
const inherited = { ...process.env };
for (const k of secretNames) delete inherited[k];
const tmuxEnv = { ...inherited, TMUX_TMPDIR: path.join(DIR, 'tmux'), CLAUDE_CONFIG_DIR: path.join(DIR, 'claude') };
delete tmuxEnv.TMUX; delete tmuxEnv.TMUX_PANE;
const tmux = (args) => { const r = spawnSync('tmux', args, { env: tmuxEnv, encoding: 'utf8' }); if (r.status !== 0) throw new Error(`tmux ${args.join(' ')}: ${r.stderr}`); return r.stdout; };
tmux(['-f', '/dev/null', 'new-session', '-d', '-s', 'demo', '-x', '160', '-y', '45', '-n', 'shell', 'sleep', '100000000']);
for (const a of AGENTS) tmux(['new-window', '-d', '-t', 'demo:', '-n', a.name, process.execPath, path.join(HERE, 'fake-agent.js'), '--mode', a.mode, '--name', a.name, '--sid', a.sid, '--dir', DIR]);

// ------------------------------------------------------------ gateway and daemon
const gateway = await startFakeGateway({ port: GW, token: 'dev' });
const env = {
  ...tmuxEnv,
  PATH: `${path.join(DIR, 'bin')}:${process.env.PATH}`,
  DROVER_STATE: path.join(DIR, 'state'), DROVER_CACHE: path.join(DIR, 'cache'), DROVER_SHARE: path.join(DIR, 'share'),
  DROVER_DOTFILES: path.join(DIR, 'dotfiles'), DROVER_EVENTS: path.join(DIR, 'dotfiles', 'claude', 'drover-events.jsonl'),
  DROVER_SECRETS_FILE: '/dev/null', DROVER_SEARCH: 'off',
  // No plugins (an empty list, not the default plugin directory): a plugin's hosts would be real hosts here, and a
  // press or a message on one of them would go to a real session; its ops would reach real services.
  DROVER_PLUGINS: '',
  CODEX_HOME: path.join(DIR, 'codex'),
  OPENCLAW_MANAGER_STATE_DIR: path.join(DIR, 'openclaw'), OPENCLAW_GATEWAY_URL: `http://127.0.0.1:${gateway.port}`, OPENCLAW_GATEWAY_TOKEN: 'dev',
};
for (const k of ['DROVER_BOTS_URL', 'DROVER_BIND', 'APXW_STATE', 'APXW_CACHE']) delete env[k];
const daemon = spawn(process.execPath, [path.join(ROOT, 'bin', 'drover'), 'serve', '--port', String(PORT)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
daemon.stdout.on('data', (d) => process.stdout.write(`[daemon] ${d}`));
daemon.stderr.on('data', (d) => process.stderr.write(`[daemon] ${d}`));
daemon.on('exit', (code) => { console.log(`[devworld] daemon exited ${code}`); stop(1); });

let stopped = false;
async function stop(code = 0) {
  if (stopped) return; stopped = true;
  try { daemon.kill('SIGTERM'); } catch { /* gone */ }
  try { spawnSync('tmux', ['kill-server'], { env: tmuxEnv }); } catch { /* gone */ }
  await gateway.close().catch(() => {});
  process.exit(code);
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

const token = existsSync(path.join(DIR, 'state', 'token')) ? (await import('node:fs')).readFileSync(path.join(DIR, 'state', 'token'), 'utf8').trim() : null;
for (let i = 0; i < 100; i++) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/api/op/host.identity`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' }); if (r.ok) break; } catch { /* not yet */ }
  await new Promise((r) => setTimeout(r, 200));
}
// It runs only isolated: this host alone (no fleet) and no plugin loaded, whatever the daemon's own defaults become.
const op = async (name) => {
  try { return await (await fetch(`http://127.0.0.1:${PORT}/api/op/${name}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' })).json(); }
  catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
};
const seen = (await op('host.list')).result?.map((h) => h.name) ?? null;
let loaded = null;
try { loaded = (await (await fetch(`http://127.0.0.1:${PORT}/api/ops`, { headers: { authorization: `Bearer ${token}` } })).json()).plugins?.map((p) => p.name) ?? null; } catch { /* no answer: not isolated */ }
if (JSON.stringify(seen) !== '["local"]' || !Array.isArray(loaded) || loaded.length) {
  console.error(`[devworld] not isolated, stopping: hosts ${JSON.stringify(seen)}, plugins ${JSON.stringify(loaded)}`);
  await stop(1);
}
writeFileSync(path.join(DIR, 'devworld.json'), JSON.stringify({ port: PORT, gateway: gateway.port, dir: DIR, daemonPid: daemon.pid, tmuxTmpdir: tmuxEnv.TMUX_TMPDIR, agents: AGENTS }, null, 2));
console.log(`[devworld] daemon http://127.0.0.1:${PORT} (token: the real token file, copied), fake manager gateway :${gateway.port}`);
console.log(`[devworld] agents in a private tmux server: ${AGENTS.map((a) => `${a.name} (${a.mode})`).join(', ')}`);
console.log(`[devworld] watch them: TMUX_TMPDIR=${tmuxEnv.TMUX_TMPDIR} tmux attach -t demo`);
console.log(`[devworld] a dialog comes back about 12 s after it is answered; manager messages starting "slow " stream for about 8 s, "fail " fail, "echo " echo`);
