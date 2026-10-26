// sessions.answer (core/api.js): a key pressed on the dialog a session shows, found by session id or window target,
// with tmux.answer's guards; and on a host whose Drover predates the op, the same press through sessions.get and
// tmux.answer. A private tmux server (its own TMUX_TMPDIR, no TMUX variable) and a fake Claude registry; nothing
// here reaches the user's tmux, sessions or hosts.
import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmp = await mkdtemp(path.join(tmpdir(), 'drover-answer-'));
process.env.DROVER_CACHE = path.join(tmp, 'cache');
process.env.DROVER_STATE = path.join(tmp, 'state');
process.env.DROVER_DOTFILES = path.join(tmp, 'dotfiles');
process.env.DROVER_EVENTS = path.join(tmp, 'dotfiles', 'claude', 'drover-events.jsonl');
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
await mkdir(path.join(tmp, 'dotfiles', 'claude'), { recursive: true });
await writeFile(path.join(tmp, 'dotfiles', 'claude', 'fleet-hosts.txt'), 'oldbox\n');
await mkdir(path.join(tmp, 'claude', 'sessions'), { recursive: true });
// `claude agents --json` is part of the session list: a stand-in that lists nothing.
const bin = path.join(tmp, 'bin');
await mkdir(bin);
await writeFile(path.join(bin, 'claude'), '#!/bin/sh\necho "[]"\n');
await chmod(path.join(bin, 'claude'), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;

const { dispatch } = await import('../core/api.js');
const { capture, screenHash } = await import('../core/tmux.js');
const remote = await import('../core/remote.js');

const hasTmux = spawnSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).status === 0;
const PERMISSION = '\n Bash command\n\n   npm test\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don\'t ask again for npm commands\n   3. No, and tell Claude what to do differently (esc)\n\n Esc to cancel\n';

describe('real tmux: sessions.answer presses one key on the dialog the session shows', { skip: hasTmux ? false : 'tmux is not installed here' }, () => {
  let env, realTmux, tdir;
  const SESSION = 'drover-sa-test';
  const tmuxCmd = (args) => spawnSync(realTmux, args, { env, encoding: 'utf8' });
  before(async () => {
    realTmux = spawnSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).stdout.trim();
    tdir = await mkdtemp(path.join(tmpdir(), 'droversa-'));
    delete process.env.TMUX; delete process.env.TMUX_PANE;
    process.env.TMUX_TMPDIR = tdir;
    env = { ...process.env };
    assert.equal(tmuxCmd(['-f', '/dev/null', 'new-session', '-d', '-s', SESSION, '-x', '120', '-y', '40', 'sleep', '3600']).status, 0);
  });
  after(async () => {
    // The kill names the private server's socket: with TMUX_TMPDIR alone, a missing folder would send it to the
    // user's default server.
    if (env) tmuxCmd(['-S', path.join(tdir, `tmux-${process.getuid()}`, 'default'), 'kill-server']);
    if (tdir) await rm(tdir, { recursive: true, force: true });
  });
  /** A window that draws a dialog and logs every key; a registry entry for a session in it. */
  const dialogSession = async (name, sid) => {
    const log = path.join(tdir, `${name}.keys`), script = path.join(tdir, `${name}.cjs`);
    await writeFile(log, '');
    await writeFile(script, `const fs = require('node:fs'); process.stdout.write(${JSON.stringify(PERMISSION)}); process.stdin.setRawMode?.(true); process.stdin.on('data', (b) => fs.appendFileSync(${JSON.stringify(log)}, b)); setInterval(() => {}, 1000);`);
    assert.equal(tmuxCmd(['new-window', '-d', '-t', SESSION, '-n', name, process.execPath, script]).status, 0);
    const [winId, paneId] = tmuxCmd(['display-message', '-p', '-t', `${SESSION}:${name}`, '#{window_id} #{pane_id}']).stdout.trim().split(' ');
    for (let i = 0; i < 100 && !(await capture(`${SESSION}:${name}`, { lines: 60 })).includes('Esc to cancel'); i++) await new Promise((r) => setTimeout(r, 50));
    if (sid) await writeFile(path.join(tmp, 'claude', 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: sid, cwd: tdir, name, status: 'idle', tmux: `${SESSION}:${winId}.${paneId}` }));
    return { window: `${SESSION}:${winId}`, keys: async () => { await new Promise((r) => setTimeout(r, 300)); return readFileSync(log, 'utf8'); } };
  };

  test('by session id, with the hash of the screen it was read on: the digit is typed', async () => {
    const s = await dialogSession('perm1', '11111111-1111-4111-8111-111111111111');
    const hash = screenHash(await capture(s.window, { lines: 60 }));
    const r = await dispatch('sessions.answer', { id: '11111111-1111-4111-8111-111111111111', key: '1', expect: hash });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.target, s.window, 'the window from the registry, not the pane');
    assert.equal(r.dialog.question, 'Do you want to proceed?');
    assert.equal(await s.keys(), '1');
  });
  test('a screen that changed since it was read, and y on a Claude dialog: refused, nothing typed', async () => {
    const s = await dialogSession('perm2', '22222222-2222-4222-8222-222222222222');
    const stale = await dispatch('sessions.answer', { id: 'perm2', key: '1', expect: '0000000000000000' });
    assert.equal(stale.refused, true); assert.match(stale.reason, /screen changed/);
    assert.equal(stale.dialog.question, 'Do you want to proceed?', 'the dialog now on screen comes with the refusal');
    const yes = await dispatch('sessions.answer', { id: 'perm2', key: 'y' });
    assert.equal(yes.refused, true); assert.match(yes.reason, /does not take "y"/);
    assert.equal(await s.keys(), '');
  });
  test('by window target (an agent seen only as a window): Escape reaches it', async () => {
    const s = await dialogSession('perm3', null);
    const r = await dispatch('sessions.answer', { id: s.window, key: 'Escape' });
    assert.equal(r.ok, true, r.reason);
    assert.equal(await s.keys(), '\x1b');
  });
  test('a session without a pane, an unknown id and a bad key are errors', async () => {
    await writeFile(path.join(tmp, 'claude', 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: '33333333-3333-4333-8333-333333333333', cwd: tdir, name: 'paneless', status: 'idle', tmux: null }));
    await assert.rejects(dispatch('sessions.answer', { id: 'paneless', key: 'Enter' }), /no tmux pane; reply with a message instead/);
    await assert.rejects(dispatch('sessions.answer', { id: 'nobody-here', key: 'Enter' }), /session not found/);
    await assert.rejects(dispatch('sessions.answer', { id: `${SESSION}:@1`, key: 'q' }), /key must be one of/);
  });
});

/** A fake `ssh oldbox drover rpc` from before sessions.answer: it knows sessions.get and tmux.answer only. */
function oldPeer() {
  const calls = [];
  remote._deps.spawn = () => {
    const c = new EventEmitter();
    c.stdout = new PassThrough(); c.stderr = new PassThrough();
    c.stdin = {
      write(d) {
        for (const line of String(d).split('\n').filter(Boolean)) {
          const req = JSON.parse(line);
          calls.push({ op: req.op, args: req.args });
          const reply = req.op === 'sessions.get' ? { ok: true, result: req.args.id === 'cx1' ? { engine: 'codex', threadId: 'cx1', tmux: 'work:@8.%1' } : { engine: 'claude', sessionId: 'abc', tmux: 'work:@7.%9' } }
            : req.op === 'tmux.answer' ? { ok: true, result: { ok: true, key: req.args.key, hash: 'h', dialog: { question: 'Go?', options: [] } } }
            : { ok: false, error: `unknown op ${req.op}` };
          setImmediate(() => c.stdout.write(JSON.stringify({ id: req.id, ...reply }) + '\n'));
        }
      },
      end() { setTimeout(() => c.emit('close', 0), 10); }, on() {},
    };
    c.kill = () => setImmediate(() => c.emit('close', null));
    return c;
  };
  return calls;
}

describe('sessions.answer on a host that predates it', () => {
  afterEach(() => remote.stopAll());
  test('falls back to sessions.get there and presses with tmux.answer on its window', async () => {
    const calls = oldPeer();
    const r = await dispatch('sessions.answer', { host: 'oldbox', id: 'abc', key: '2', expect: 'h' });
    assert.equal(r.ok, true);
    assert.equal(r.target, 'work:@7');
    const ops = calls.map((c) => c.op);
    assert.ok(ops.includes('sessions.answer'), 'the new op is tried first');
    assert.deepEqual(ops.filter((o) => o !== 'sessions.answer'), ['sessions.get', 'tmux.answer']);
    assert.deepEqual(calls.at(-1).args, { target: 'work:@7', key: '2', expect: 'h' });
  });
  test('a session that is not Claude names no pane there either: refused, nothing pressed', async () => {
    const calls = oldPeer();
    await assert.rejects(dispatch('sessions.answer', { host: 'oldbox', id: 'cx1', key: 'Enter' }), /no tmux pane; reply with a message instead/);
    assert.ok(!calls.some((c) => c.op === 'tmux.answer'));
  });
  test('a window target needs no lookup', async () => {
    const calls = oldPeer();
    const r = await dispatch('sessions.answer', { host: 'oldbox', id: 'work:3', key: 'Enter' });
    assert.equal(r.target, 'work:3');
    assert.ok(!calls.some((c) => c.op === 'sessions.get'));
  });
});
