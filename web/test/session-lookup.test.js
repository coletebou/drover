// claude.findSession and listSessions (core/claude.js) when the registry holds entries that ended beside a running
// one: the registry file an earlier process of the same session left, and another session of the same name. A scratch
// Claude config dir and a stand-in `claude agents`; nothing here reads the user's sessions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmp = await mkdtemp(path.join(tmpdir(), 'drover-lookup-'));
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
const REGISTRY = path.join(tmp, 'claude', 'sessions');
await mkdir(REGISTRY, { recursive: true });
const bin = path.join(tmp, 'bin');
await mkdir(bin);
await writeFile(path.join(bin, 'claude'), '#!/bin/sh\necho "[]"\n');
await chmod(path.join(bin, 'claude'), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;
const claude = await import('../core/claude.js');

const DEAD_PID = 2 ** 31 - 2;   // above any pid_max: never a running process
let n = 100;
const register = (sessionId, name, { live, startedAt }) => writeFile(path.join(REGISTRY, `${n++}.json`), JSON.stringify({ pid: live ? process.pid : DEAD_PID, sessionId, name, cwd: tmp, status: 'idle', startedAt, messagingSocketPath: path.join(tmp, `${n}.sock`) }));
const A = '11111111-0000-4000-8000-000000000001', B = '22222222-0000-4000-8000-000000000002';

test('a session that runs again under its id is listed once, by its running entry, whatever the order of the files', async () => {
  const now = Date.now();
  await register(A, 'kilo', { live: false, startedAt: now - 3_600_000 });   // the earlier process, ended
  await register(A, 'kilo', { live: true, startedAt: now - 60_000 });
  const entries = (await claude.listSessions()).filter((s) => s.sessionId === A);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].alive, true);
  assert.equal(claude.running(entries[0]), true);
  assert.equal((await claude.findSession(A)).alive, true);
  assert.equal((await claude.findSession(A.slice(0, 8))).alive, true);
});

test('a name: the running session answers ahead of one of that name that started later and ended', async () => {
  await register(B, 'kilo', { live: false, startedAt: Date.now() });
  const s = await claude.findSession('kilo');
  assert.equal(s.sessionId, A);
  assert.equal(s.alive, true);
});

test('with nothing running under a name, the lookup still finds the entry that ended, the newest first', async () => {
  const C = '33333333-0000-4000-8000-000000000003', D = '44444444-0000-4000-8000-000000000004';
  await register(C, 'lima', { live: false, startedAt: Date.now() - 7_200_000 });
  await register(D, 'lima', { live: false, startedAt: Date.now() - 600_000 });
  const s = await claude.findSession('lima');
  assert.equal(s.sessionId, D);
  assert.equal(s.alive, false);
  assert.equal(claude.running(s), false);
  assert.equal(claude.running({ pid: null, alive: true }), false, 'an entry without a pid does not run, whatever it says');
});

test('a launch name that only reached the tmux window: the one running session in a window of that name', async () => {
  const E = '55555555-0000-4000-8000-000000000005', F = '66666666-0000-4000-8000-000000000006';
  const reg = (sessionId, name, tmux, live = true) => writeFile(path.join(REGISTRY, `${n++}.json`), JSON.stringify({ pid: live ? process.pid : DEAD_PID, sessionId, name, cwd: tmp, status: 'busy', startedAt: Date.now(), tmux }));
  await reg(E, 'reflect-auto-implement-20261107-aa', 'handoffs:@32.%32');
  await reg(F, 'other-1f', 'main:3.%9');
  const windows = async () => [
    { session: 'handoffs', windowId: '@32', index: 1, name: 'reflect-auto-implement' },
    { session: 'main', windowId: '@40', index: 3, name: 'by-index' },
    { session: 'main', windowId: '@41', index: 4, name: 'twice' }, { session: 'main', windowId: '@42', index: 5, name: 'twice' },
  ];
  assert.equal((await claude.findSession('reflect-auto-implement', { windows }))?.sessionId, E, 'a registry field with the window id');
  assert.equal((await claude.findSession('by-index', { windows }))?.sessionId, F, 'a registry field with the window index');
  assert.equal(await claude.findSession('no-such-window', { windows }), null);
  assert.equal(await claude.findSession('reflect-auto-implement', { windows: async () => { throw new Error('no tmux server'); } }), null, 'no tmux: not found, no throw');
  // The session's own name still wins over a window name, and an exact name is not shadowed by a window.
  assert.equal((await claude.findSession('other-1f', { windows }))?.sessionId, F);
});

test('a window name shared by two running sessions finds neither: a message must not guess', () => {
  const live = { pid: process.pid, alive: true };
  const sessions = [{ ...live, sessionId: 'x', tmux: 'main:@41.%1' }, { ...live, sessionId: 'y', tmux: 'main:@42.%2' }, { pid: DEAD_PID, alive: false, sessionId: 'z', tmux: 'main:@43.%3' }];
  const windows = [{ session: 'main', windowId: '@41', index: 4, name: 'twice' }, { session: 'main', windowId: '@42', index: 5, name: 'twice' }, { session: 'main', windowId: '@43', index: 6, name: 'ended' }];
  assert.equal(claude.byWindowName(sessions, 'twice', windows), null);
  assert.equal(claude.byWindowName(sessions, 'ended', windows), null, 'an ended session is not found by its old window');
  assert.equal(claude.byWindowName(sessions.slice(0, 1), 'twice', windows).sessionId, 'x');
});
