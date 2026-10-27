// core/remote.js: a peer that answers "unknown op" (its `drover rpc` started before the host pulled new
// code) is restarted once and the call retried; at most once per 10 minutes per host.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import path from 'node:path';

const tmp = await mkdtemp(path.join(tmpdir(), 'drover-remote-'));
process.env.DROVER_CACHE = path.join(tmp, 'cache');
process.env.DROVER_DOTFILES = path.join(tmp, 'dotfiles');
process.env.DROVER_EVENTS = path.join(tmp, 'dotfiles', 'claude', 'drover-events.jsonl');
await mkdir(path.join(tmp, 'dotfiles', 'claude'), { recursive: true });
await writeFile(path.join(tmp, 'dotfiles', 'claude', 'fleet-hosts.txt'), 'skewbox\n');
const remote = await import('../core/remote.js');
afterEach(() => remote.stopAll());   // a failed test must not hand its peer to the next one

/**
 * Wait until `n` calls are in flight on the host's peer. callOn checks the host (file reads) before it
 * sends, so two calls issued back to back can reach the peer in either order: a test that needs the first
 * one to be on the old child before the second retires it waits here in between.
 */
async function inFlight(n, host = 'skewbox') {
  const p = await remote.peer(host);
  const end = Date.now() + 5000;
  while (p.inFlight < n) {
    if (Date.now() > end) throw new Error(`${n} call(s) never reached ${host} (in flight: ${p.inFlight})`);
    await new Promise((r) => setImmediate(r));
  }
}

/**
 * The fake rpc's reply line for answer `a`: 'ERR:<message>' fails the call, { $stale: true, result } is a reply from an
 * rpc whose host's checkout has moved past its code, and anything else is the result.
 */
function fakeReply(id, a) {
  if (typeof a === 'string' && a.startsWith('ERR:')) return { id, ok: false, error: a.slice(4) };
  if (a?.$stale) return { id, ok: true, result: a.result, stale: true };
  return { id, ok: true, result: a };
}

/** A fake `ssh … drover rpc`: answers every request with `answer(op)` (an error string or a result). */
function fakeSpawn(answers) {
  const spawned = [];
  remote._deps.spawn = () => {
    const c = new EventEmitter();
    c.stdout = new PassThrough(); c.stderr = new PassThrough();
    const generation = spawned.length;
    c.stdin = {
      write(d) {
        for (const line of String(d).split('\n').filter(Boolean)) {
          const req = JSON.parse(line);
          const reply = fakeReply(req.id, answers(generation, req.op));
          setImmediate(() => c.stdout.write(JSON.stringify(reply) + '\n'));
        }
      },
      end() { c.stdinEnded = true; setTimeout(() => c.emit('close', 0), 30); }, on() {},
    };
    c.kill = () => { c.killed = true; setImmediate(() => c.emit('close', null)); };
    spawned.push(c);
    return c;
  };
  return spawned;
}

test('an "unknown op" from a stale peer restarts it once and the retry gets the new code', async () => {
  let clock = 1_000_000;
  remote._deps.now = () => clock;
  // Generation 0 is the stale rpc (old op table); generation 1 runs the new code.
  const spawned = fakeSpawn((gen, op) => (op === 'search.semantic' && gen === 0 ? `ERR:unknown op ${op}` : { gen, op }));
  const r = await remote.callOn('skewbox', 'search.semantic', { query: 'x' }, null, { timeoutMs: 2000 });
  assert.deepEqual(r, { gen: 1, op: 'search.semantic' });
  assert.equal(spawned.length, 2, 'one restart');
  assert.equal(spawned[0].stdinEnded, true, 'the stale child is retired (its stdin ended)');
  assert.notEqual(spawned[0].killed, true, 'not killed: it may still owe answers');
  remote.stopAll();
});

test('a call in flight on the stale child when it is retired still gets its answer (nothing is cancelled)', async () => {
  remote._deps.now = () => 7_000_000_000;
  // Generation 0 holds its tmux.send answer until released and does not know search.semantic;
  // generation 1 knows both. (A timed answer raced the probe on a loaded box.)
  const spawned = []; const held = [];
  remote._deps.spawn = () => {
    const c = new EventEmitter();
    c.stdout = new PassThrough(); c.stderr = new PassThrough();
    const gen = spawned.length;
    c.stdin = {
      write(d) {
        for (const line of String(d).split('\n').filter(Boolean)) {
          const req = JSON.parse(line);
          const send = (reply) => c.stdout.write(JSON.stringify(reply) + '\n');
          if (req.op === 'tmux.send' && gen === 0) held.push(() => send({ id: req.id, ok: true, result: { gen, op: req.op } }));
          else setImmediate(() => send(req.op === 'search.semantic' && gen === 0 ? { id: req.id, ok: false, error: 'unknown op search.semantic' } : { id: req.id, ok: true, result: { gen, op: req.op } }));
        }
      },
      end() { c.stdinEnded = true; setTimeout(() => c.emit('close', 0), 200); }, on() {},
    };
    c.kill = () => { c.killed = true; setImmediate(() => c.emit('close', null)); };
    spawned.push(c);
    return c;
  };
  const sibling = remote.callOn('skewbox', 'tmux.send', { text: 'hi' }, null, { timeoutMs: 2000 });
  await inFlight(1);
  const probe = remote.callOn('skewbox', 'search.semantic', { query: 'x' }, null, { timeoutMs: 2000 });
  assert.deepEqual(await probe, { gen: 1, op: 'search.semantic' });
  // The stale child runs an older drover rpc, which exits on EOF without flushing stdout: no EOF until it owes nothing.
  assert.notEqual(spawned[0].stdinEnded, true, 'no EOF while the stale child still owes the sibling');
  held.shift()();
  assert.deepEqual(await sibling, { gen: 0, op: 'tmux.send' }, 'the sibling finished on the old child');
  assert.equal(spawned[0].stdinEnded, true, 'EOF once its last reply arrived');
  assert.equal(spawned.length, 2);
  remote.stopAll();
});

test('a host that really runs old code is not respawned on every call: one restart per 10 minutes', async () => {
  let clock = 8_000_000_000;   // beyond the earlier tests' clocks: the restart memory is per host, module-wide
  remote._deps.now = () => clock;
  const spawned = fakeSpawn((_gen, op) => `ERR:unknown op ${op}`);
  await assert.rejects(remote.callOn('skewbox', 'search.semantic', {}, null, { timeoutMs: 2000 }), /unknown op search\.semantic/);
  assert.equal(spawned.length, 2, 'restarted once, still unknown');
  clock += 60_000;
  await assert.rejects(remote.callOn('skewbox', 'search.semantic', {}, null, { timeoutMs: 2000 }), /unknown op/);
  assert.equal(spawned.length, 2, 'no second restart within 10 minutes');
  clock += 10 * 60_000;
  await assert.rejects(remote.callOn('skewbox', 'search.semantic', {}, null, { timeoutMs: 2000 }), /unknown op/);
  assert.equal(spawned.length, 3, 'tried again after the gap');
  remote.stopAll();
});

test('other remote errors are passed through without a restart', async () => {
  remote._deps.now = () => 9_000_000_000_000;
  const spawned = fakeSpawn(() => 'ERR:query must be a non-empty string');
  await assert.rejects(remote.callOn('skewbox', 'search.semantic', { query: '' }, null, { timeoutMs: 2000 }), /non-empty/);
  assert.equal(spawned.length, 1);
  remote.stopAll();
});

test('stopAll also stops a retired child that still owes an answer, failing what it owed', async () => {
  remote._deps.now = () => 10_000_000_000_000;
  // Generation 0 never answers tmux.send (hung) and does not know search.semantic; generation 1 knows both.
  const spawned = [];
  remote._deps.spawn = () => {
    const c = new EventEmitter();
    c.stdout = new PassThrough(); c.stderr = new PassThrough();
    const gen = spawned.length;
    c.stdin = {
      write(d) {
        for (const line of String(d).split('\n').filter(Boolean)) {
          const req = JSON.parse(line);
          if (req.op === 'tmux.send' && gen === 0) continue;
          const reply = req.op === 'search.semantic' && gen === 0 ? { id: req.id, ok: false, error: 'unknown op search.semantic' } : { id: req.id, ok: true, result: { gen } };
          setImmediate(() => c.stdout.write(JSON.stringify(reply) + '\n'));
        }
      },
      end() { c.stdinEnded = true; }, on() {},   // stays open: it still owes tmux.send
    };
    c.kill = () => { c.killed = true; setImmediate(() => c.emit('close', null)); };
    spawned.push(c);
    return c;
  };
  const owed = remote.callOn('skewbox', 'tmux.send', { text: 'hi' }, null, { timeoutMs: 5000 });
  await inFlight(1);
  assert.deepEqual(await remote.callOn('skewbox', 'search.semantic', {}, null, { timeoutMs: 2000 }), { gen: 1 }, 'generation 0 was retired');
  assert.notEqual(spawned[0].stdinEnded, true, 'and still owes tmux.send, so it has no EOF yet');
  remote.stopAll();
  assert.equal(spawned[0].killed, true, 'the retired child is stopped too, not left running');
  assert.equal(spawned[1].killed, true);
  await assert.rejects(owed, /exited/, 'what the retired child owed fails at once instead of waiting out its timeout');
});

test('a retired child that hangs is killed past the last deadline of what it owed, not before', async (t) => {
  // Not at a fixed 150 s: files.wait runs up to an hour, and a retired child's long calls are still live work.
  t.mock.timers.enable({ apis: ['setTimeout'] });   // the owed call is due at 300 s, the kill 30 s after; setImmediate stays real
  remote._deps.now = () => 11_000_000_000_000;
  // Generation 0 never answers tmux.send and never exits; generation 1 knows search.semantic.
  const spawned = [];
  remote._deps.spawn = () => {
    const c = new EventEmitter();
    c.stdout = new PassThrough(); c.stderr = new PassThrough();
    const gen = spawned.length;
    c.stdin = {
      write(d) {
        for (const line of String(d).split('\n').filter(Boolean)) {
          const req = JSON.parse(line);
          if (req.op === 'tmux.send' && gen === 0) continue;
          const reply = req.op === 'search.semantic' && gen === 0 ? { id: req.id, ok: false, error: 'unknown op search.semantic' } : { id: req.id, ok: true, result: { gen } };
          setImmediate(() => c.stdout.write(JSON.stringify(reply) + '\n'));
        }
      },
      end() { c.stdinEnded = true; }, on() {},
    };
    c.kill = () => { c.killed = true; setImmediate(() => c.emit('close', null)); };
    spawned.push(c);
    return c;
  };
  const owed = remote.callOn('skewbox', 'tmux.send', { text: 'hi' }, null, { timeoutMs: 300_000 });
  await inFlight(1);
  assert.deepEqual(await remote.callOn('skewbox', 'search.semantic', {}, null, { timeoutMs: 2000 }), { gen: 1 });
  t.mock.timers.tick(150_000);
  assert.notEqual(spawned[0].killed, true, 'not at 150 s: it still owes a call due at 300 s');
  t.mock.timers.tick(150_000);
  await assert.rejects(owed, /timed out/, 'the owed call ends at its own deadline');
  assert.notEqual(spawned[0].killed, true, 'the child gets a margin past that');
  t.mock.timers.tick(30_000);
  assert.equal(spawned[0].killed, true, 'then a child that still has not exited is killed');
  assert.notEqual(spawned[1].killed, true, 'the fresh child is untouched');
});

test('the idle reaper leaves a peer alone while a retired child still owes an answer', async () => {
  remote._deps.now = () => 12_000_000_000_000;   // clocks rise through the file: the restart memory is module-wide
  // Generation 0 holds its tmux.send answer until released and does not know search.semantic.
  const spawned = []; const held = [];
  remote._deps.spawn = () => {
    const c = new EventEmitter();
    c.stdout = new PassThrough(); c.stderr = new PassThrough();
    const gen = spawned.length;
    c.stdin = {
      write(d) {
        for (const line of String(d).split('\n').filter(Boolean)) {
          const req = JSON.parse(line);
          const send = (reply) => c.stdout.write(JSON.stringify(reply) + '\n');
          if (req.op === 'tmux.send' && gen === 0) held.push(() => send({ id: req.id, ok: true, result: { gen } }));
          else setImmediate(() => send(req.op === 'search.semantic' && gen === 0 ? { id: req.id, ok: false, error: 'unknown op search.semantic' } : { id: req.id, ok: true, result: { gen } }));
        }
      },
      end() { c.stdinEnded = true; }, on() {},
    };
    c.kill = () => { c.killed = true; setImmediate(() => c.emit('close', null)); };
    spawned.push(c);
    return c;
  };
  const owed = remote.callOn('skewbox', 'tmux.send', { text: 'hi' }, null, { timeoutMs: 5000 });
  await inFlight(1);
  assert.deepEqual(await remote.callOn('skewbox', 'search.semantic', {}, null, { timeoutMs: 2000 }), { gen: 1 });
  const later = Date.now() + 11 * 60_000;   // past the idle window for the fresh child
  remote.reapIdle(later);
  assert.notEqual(spawned[0].killed, true, 'not reaped while the retired child owes tmux.send');
  assert.notEqual(spawned[1].killed, true);
  held.shift()();
  assert.deepEqual(await owed, { gen: 0 });
  remote.reapIdle(later);
  assert.equal(spawned[1].killed, true, 'reaped once nothing is owed');
  remote.stopAll();
});

test('a reply saying stale retires the peer once: what it owed still arrives, new calls get a fresh child', async () => {
  remote._deps.now = () => 9_000_000_000;
  // Generation 0's host has pulled new code since it started: its replies say stale. Generation 1 is fresh.
  const spawned = fakeSpawn((gen, op) => (gen === 0 ? { $stale: true, result: { gen, op } } : { gen, op }));
  const p = await remote.peer('skewbox');
  const [a, b] = await Promise.all([p.call('host.version', {}, { timeoutMs: 2000 }), p.call('tmux.windows', {}, { timeoutMs: 2000 })]);
  assert.deepEqual([a.gen, b.gen], [0, 0], 'both calls sent before the stale reply are answered by the child they went to');
  assert.equal(spawned[0].stdinEnded, true, 'the stale child is retired once it owes nothing');
  assert.notEqual(spawned[0].killed, true);
  const c = await p.call('host.version', {}, { timeoutMs: 2000 });
  assert.equal(c.gen, 1, 'the next call goes to a fresh child, which loads the new code');
  assert.equal(spawned.length, 2, 'retired once, not once per stale reply');
  remote.stopAll();
});

test('a retired child is killed only past the deadline of what it still owes (an hour-long files.wait included)', () => {
  const now = 1_000;
  assert.equal(remote.retireKillMs(new Map(), now), 150_000, 'nothing owed: the floor');
  assert.equal(remote.retireKillMs(new Map([[1, { deadline: now + 60_000 }]]), now), 150_000, 'a short call: the floor');
  assert.equal(remote.retireKillMs(new Map([[1, { deadline: now + 60_000 }], [2, { deadline: now + 3_660_000 }]]), now), 3_690_000, 'the longest deadline, plus a margin');
});
