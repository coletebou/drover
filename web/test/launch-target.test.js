// The window a tmux launch opens, through a real, private tmux server set up as the owner's is (base-index 1,
// renumber-windows on). The session is named exactly ("=session:"), so a session whose name starts a window name, in
// it or in the newest session, still gets its window, at the next free index. The target returned names the window by
// its id ("session:@12"), so it stays right when a new session's placeholder window is dropped and when any other
// window closes later, while the index it opened at comes to name another window. tmux.send, sessions.answer, a
// launch's event and the UI's window lookups take that target. No tmux server, agent or credential of the user is
// touched: the server has its own socket directory and a config of its own, the agent is a fake, and the credential
// is a fake value under a test-only name.
// Run: node --test test/launch-target.test.js
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Lowercase letters only: no redaction rule knows it by its shape, so only the launch keeping it out of text can.
const fakeValue = () => Array.from(randomBytes(32), (b) => String.fromCharCode(97 + (b % 26))).join('');

const dir = await mkdtemp(path.join(tmpdir(), 'drover-target-'));
process.env.DROVER_PROFILES = path.join(dir, 'profiles.json');
process.env.DROVER_STATE = path.join(dir, 'state');
process.env.DROVER_DOTFILES = path.join(dir, 'dotfiles');
process.env.DROVER_EVENTS = path.join(dir, 'dotfiles', 'claude', 'drover-events.jsonl');
process.env.DROVER_CACHE = path.join(dir, 'cache');
process.env.DROVER_HOST = 'testbox';
process.env.DROVER_TEST_CRED = fakeValue();
await mkdir(path.join(dir, 'dotfiles', 'claude'), { recursive: true });
await writeFile(process.env.DROVER_PROFILES, JSON.stringify({
  claude: { models: [], profiles: [{ id: 'claude-plain', label: 'plain', argv: [], env: {}, default: true }] },
  codex: { models: [], profiles: [{ id: 'codex-plain', label: 'plain', argv: [], env: {}, default: true }] },
  credentials: { pool: [{ id: 'main', label: 'Main', env: { FAKE_CHILD_CRED: '$DROVER_TEST_CRED' }, weight: 1, maxConcurrent: 50 }], default: 'auto', appliesTo: ['claude'] },
}));

const tmux = await import('../core/tmux.js');
const launchMod = await import('../core/launch.js');
const credentials = await import('../core/credpool.js');
const api = await import('../core/api.js');
const { isWindow } = await import('../ui/transcript.js');
const { stripFor } = await import('../ui/strips.js');
// Here, not in a suite's after(): a suite skipped where tmux is missing runs no hooks.
after(() => rm(dir, { recursive: true, force: true }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, ms = 5000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(50)) if (await cond()) return true;
  return false;
}

test('the UI finds a window by its index or by its id, and nothing else', () => {
  const w = { target: 'work:2', session: 'work', index: 2, windowId: '@7' };
  assert.equal(isWindow(w, 'work:2'), true);
  assert.equal(isWindow(w, 'work:@7'), true);
  for (const other of ['work:@8', 'wor:@7', 'work:1', 'work:', '', null, undefined]) assert.equal(isWindow(w, other), false, String(other));
  assert.equal(isWindow({ target: 'work:2', session: 'work' }, 'work:undefined'), false, 'a window listed without its id matches by index only');
});

test('stripFor: a drawer on a launch target finds the board strip through the index it found the window at', () => {
  const strip = { host: 'local', kind: 'window', id: 'work:2', tmux: 'work:2', lane: 'wait' };
  const state = { board: { strips: [strip, { host: 'local', kind: 'window', id: 'work:1', tmux: 'work:1', lane: 'idle' }] } };
  assert.equal(stripFor(state, { kind: 'window', id: 'work:@7', host: 'local' }), null, 'a strip names its window by index only');
  assert.equal(stripFor(state, { kind: 'window', id: 'work:@7', tmux: 'work:2', host: 'local' }), strip);
  assert.equal(stripFor(state, { kind: 'window', id: 'work:2', tmux: 'work:2', host: 'local' }), strip, 'by index, as before');
  assert.equal(stripFor(state, { kind: 'window', id: 'work:2', host: 'local' }), strip);
});

const hasTmux = spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status === 0;
describe('real tmux, set up as the owner\'s (base-index 1, renumber-windows on)', { skip: hasTmux ? false : 'tmux is not installed here' }, () => {
  let tdir, env, fakeBin, outDir, savedPath;
  const tmuxCmd = (args) => spawnSync('tmux', args, { env, encoding: 'utf8' });
  const ok = (r) => { assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  const windowsOf = async (session) => (await tmux.listWindows()).filter((w) => w.session === session).sort((a, b) => a.index - b.index);
  const byTarget = async (target) => (await tmux.listWindows()).find((w) => isWindow(w, target));
  // A window that prints its mark and waits: what is on screen says which window a target reached.
  const marked = (mark) => ['sh', '-c', `echo ${mark}; exec sleep 3600`];
  const shows = (target, text) => waitFor(async () => (await tmux.capture(target, { lines: 20 }).catch(() => '')).includes(text));

  before(async () => {
    // A private tmux server: its own socket directory, no TMUX variable that could point a client at the user's
    // server, and its own config. Every tmux call in this process (core/tmux.js too) goes there. This comes before
    // anything else that can fail: after() runs even when before() throws, and its kill-server must use this env.
    tdir = await mkdtemp(path.join(tmpdir(), 'drovertt-'));
    delete process.env.TMUX; delete process.env.TMUX_PANE;
    process.env.TMUX_TMPDIR = tdir;
    env = { ...process.env };
    // A window opened with no command (a new session's placeholder) runs sh -c, not the user's login shell and its config.
    const conf = path.join(tdir, 'tmux.conf');
    await writeFile(conf, "set -g base-index 1\nset -g renumber-windows on\nset -g default-shell /bin/sh\nset -g default-command 'exec sleep 3600'\n");
    ok(tmuxCmd(['-f', conf, 'new-session', '-d', '-s', 'work', '-n', 'work-notes', '-c', tdir, 'sleep', '3600']));
    // The agent: records the credential it was started with, then waits.
    fakeBin = path.join(tdir, 'bin'); outDir = path.join(tdir, 'out');
    await mkdir(fakeBin); await mkdir(outDir);
    await writeFile(path.join(fakeBin, 'claude'), `#!/bin/sh\nprintf '%s' "$FAKE_CHILD_CRED" > "${outDir}/cred.tmp" && mv "${outDir}/cred.tmp" "${outDir}/cred"\nexec sleep 3600\n`);
    await chmod(path.join(fakeBin, 'claude'), 0o755);
    savedPath = process.env.PATH;
    process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH}`;
    launchMod._deps.agentPath = async () => process.env.PATH;
    await credentials._reset({ file: true });
  });
  after(async () => {
    // The kill names the private server's socket: with TMUX_TMPDIR alone, a missing folder would send it to the
    // user's default server.
    if (env) tmuxCmd(['-S', path.join(tdir, `tmux-${process.getuid()}`, 'default'), 'kill-server']);
    if (savedPath) process.env.PATH = savedPath;
    if (tdir) await rm(tdir, { recursive: true, force: true });
  });

  test('a session whose name starts a window name in it: the window opens there, at the next free index', async () => {
    // What a launch used to run: a bare name is a window first, and "work" starts "work-notes" (index 1).
    assert.match(tmuxCmd(['new-window', '-d', '-t', 'work', '-n', 'old-way', 'sleep', '1']).stderr, /index 1 in use/);
    const { target } = await tmux.newWindow({ session: 'work', name: 'agent', cwd: tdir, argv: marked('MARK-A') });
    assert.match(target, /^work:@\d+$/);
    const w = await byTarget(target);
    assert.deepEqual([w.session, w.index, w.name], ['work', 2, 'agent']);
    assert.deepEqual((await windowsOf('work')).map((x) => x.name), ['work-notes', 'agent']);
    assert.ok(await shows(target, 'MARK-A'));
  });

  test('the newest session holding a window whose name the session name starts does not take the window', async () => {
    ok(tmuxCmd(['new-session', '-d', '-s', 'ops', '-n', 'shell', 'sleep', '3600']));
    ok(tmuxCmd(['new-session', '-d', '-s', 'main', '-n', 'ops-notes', 'sleep', '3600']));
    // The bare name used to be looked up as a window of the current session (here the newest, main) first: on tmux 3.4
    // it fails on main's "ops-notes"; whatever a tmux picks, the bare form does not put the window in ops.
    const old = tmuxCmd(['new-window', '-d', '-P', '-F', '#{session_name}', '-t', 'ops', '-n', 'old-way', 'sleep', '1']);
    assert.ok(old.status !== 0 || old.stdout.trim() !== 'ops', `the bare form went to ${old.stdout.trim() || old.stderr.trim()}`);
    const { target } = await tmux.newWindow({ session: 'ops', name: 'agent', cwd: tdir, argv: marked('MARK-B') });
    assert.match(target, /^ops:@\d+$/);
    assert.deepEqual((await windowsOf('ops')).map((x) => [x.index, x.name]), [[1, 'shell'], [2, 'agent']]);
    assert.deepEqual((await windowsOf('main')).map((x) => x.name).filter((n) => n !== 'old-way'), ['ops-notes']);
    assert.ok(await shows(target, 'MARK-B'));
  });

  test('a session name that starts another session\'s name gets a session of its own', async () => {
    const workIds = (await windowsOf('work')).map((w) => w.windowId);
    const { target } = await tmux.newWindow({ session: 'wor', name: 'own', cwd: tdir, argv: marked('MARK-C') });
    assert.match(target, /^wor:@\d+$/);
    assert.deepEqual((await windowsOf('wor')).map((w) => [w.index, w.name]), [[1, 'own']]);
    assert.deepEqual((await windowsOf('work')).map((w) => w.windowId), workIds);
  });

  test('a new session: the target still names the window once the placeholder is dropped and the windows renumbered', async () => {
    const { target } = await tmux.newWindow({ session: 'fresh', name: 'agent', cwd: tdir, argv: marked('MARK-D') });
    assert.match(target, /^fresh:@\d+$/);
    const wins = await windowsOf('fresh');
    assert.deepEqual(wins.map((w) => [w.index, w.name, `${w.session}:${w.windowId}`]), [[1, 'agent', target]], 'the placeholder is gone and the window moved from 2 to 1');
    assert.ok(await shows(target, 'MARK-D'));
    // The index it opened at, which a launch used to return, names no window now.
    await assert.rejects(tmux.capture('fresh:2'), /can't find window/);
  });

  test('a window closing later renumbers the rest: the target goes on naming its window, the index it had names another', async () => {
    ok(tmuxCmd(['new-session', '-d', '-s', 'later', '-n', 'first', 'sleep', '3600']));
    ok(tmuxCmd(['new-window', '-d', '-t', '=later:', '-n', 'second', 'sleep', '3600']));
    const { target } = await tmux.newWindow({ session: 'later', name: 'agent', cwd: tdir, argv: marked('MARK-E') });
    assert.equal((await byTarget(target)).index, 3);
    ok(tmuxCmd(['kill-window', '-t', '=later:1']));
    ok(tmuxCmd(['new-window', '-d', '-t', '=later:', '-n', 'newcomer', ...marked('MARK-NEW')]));
    assert.deepEqual((await windowsOf('later')).map((w) => [w.index, w.name]), [[1, 'second'], [2, 'agent'], [3, 'newcomer']]);
    assert.ok(await shows(target, 'MARK-E'));
    assert.ok(await shows('later:3', 'MARK-NEW'), 'the index the agent opened at is another window now');
  });

  test('tmux.send types into the window the target names, and sessions.answer takes it as a window, not a session id', async () => {
    const { target } = await tmux.newWindow({ session: 'work', name: 'typed', cwd: tdir, argv: ['cat'] });
    assert.equal((await tmux.send(target, 'typed-through-the-id', { enter: false })).ok, true);
    assert.ok(await shows(target, 'typed-through-the-id'));
    const a = await api.local['sessions.answer']({ id: target, key: 'Enter' });
    assert.deepEqual([a.ok, a.refused, a.reason, a.target], [false, true, 'no dialog is on screen any more', target]);
  });

  test('launch: a credentialed claude window in session "work"; its event records the target, the agent alone gets the credential', async () => {
    const r = await launchMod.launch({ engine: 'claude', mode: 'tmux', tmuxSession: 'work', name: 'launched', cwd: tdir, prompt: 'hello', credential: 'main', trust: false }, { actor: 't' });
    assert.match(r.target, /^work:@\d+$/);
    assert.equal(r.credential, 'main');
    const w = await byTarget(r.target);
    assert.deepEqual([w.session, w.name], ['work', 'launched']);
    assert.ok(await waitFor(() => existsSync(path.join(outDir, 'cred'))), 'the agent started');
    assert.equal(await readFile(path.join(outDir, 'cred'), 'utf8'), process.env.DROVER_TEST_CRED, 'the agent got its credential through tmux -e');
    const wal = await readFile(process.env.DROVER_EVENTS, 'utf8');
    const ev = wal.trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.id === r.event);
    assert.deepEqual([ev.type, ev.result.tmux, ev.result.name], ['launch', r.target, 'launched']);
    assert.ok(!wal.includes(process.env.DROVER_TEST_CRED), 'no credential value in the truth file');
  });
});
