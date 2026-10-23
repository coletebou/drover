import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// A fake `codex` on PATH that speaks just enough JSON-RPC for the client.
const bin = await mkdtemp(path.join(tmpdir(), 'drover-cx-'));
await writeFile(path.join(bin, 'codex'), `#!/usr/bin/env node
// FAKE_CODEX_IGNORE_TERM plays a reader too starved to act on SIGTERM.
if (process.env.FAKE_CODEX_IGNORE_TERM) { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
process.stdin.setEncoding('utf8'); let buf='';
process.stdin.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i+1); if (!l.trim()) continue; const m = JSON.parse(l);
  if (m.method === 'initialize') process.stdout.write(JSON.stringify({ id: m.id, result: { userAgent: 'fake' } }) + '\\n');
  else if (m.method === 'thread/list' && process.env.FAKE_CODEX_LIST_FAIL) process.stdout.write(JSON.stringify({ id: m.id, error: { code: -1, message: 'thread/list failed' } }) + '\\n');
  else if (m.method === 'thread/list') process.stdout.write(JSON.stringify({ id: m.id, result: { data: [{ id: 't1', name: 'one', cwd: '/x', status: { type: 'idle' } }, { id: 't2', cwd: '/y', status: 'active' }] } }) + '\\n');
  else if (m.method === 'thread/loaded/list') process.stdout.write(JSON.stringify({ id: m.id, result: { threadIds: ['t2'] } }) + '\\n');
  else if (m.method === 'thread/start') { process.stdout.write(JSON.stringify({ method: 'thread/started', params: { thread: { id: 'new1' } } }) + '\\n'); process.stdout.write(JSON.stringify({ id: m.id, result: { thread: { id: 'new1' } } }) + '\\n'); }
  else if (m.method === 'turn/start') process.stdout.write(JSON.stringify({ id: m.id, result: { turn: { id: 'turn1' } } }) + '\\n');
  else if (m.method === 'boom') process.stdout.write(JSON.stringify({ id: m.id, error: { code: -1, message: 'kaboom' } }) + '\\n');
  else if (m.id !== undefined) process.stdout.write(JSON.stringify({ id: m.id, error: { code: -32601, message: 'nope' } }) + '\\n');
} });
`);
await chmod(path.join(bin, 'codex'), 0o755);
// A `ps` that fails while FAKE_PS_FAIL is set, as one does when it times out on a thrashing host.
await writeFile(path.join(bin, 'ps'), `#!/bin/sh
[ -n "$FAKE_PS_FAIL" ] && exit 1
for p in /bin/ps /usr/bin/ps; do [ -x "$p" ] && exec "$p" "$@"; done
exit 127
`);
await chmod(path.join(bin, 'ps'), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.CODEX_HOME = await mkdtemp(path.join(tmpdir(), 'drover-cxh-'));
const codex = await import('../core/codex.js');

test('listThreads normalizes and marks loaded threads', async () => {
  const th = await codex.listThreads({ limit: 5 });
  assert.deepEqual(th.map((t) => [t.threadId, t.status, t.loaded]), [['t1', 'idle', false], ['t2', 'active', true]]);
});

test('startThread owns the thread so sendTurn uses turn/start, not codex queue', async () => {
  const notes = [];
  const off = codex.onNotification((m) => notes.push(m));
  const r = await codex.startThread({ cwd: '/tmp', prompt: 'hi' });
  off();
  assert.equal(r.threadId, 'new1'); assert.equal(r.turnId, 'turn1');
  assert.ok(notes.includes('thread/started'));
  const s = await codex.sendTurn('new1', 'again');
  assert.equal(s.via, 'turn/start'); assert.equal(s.turnId, 'turn1');
});

test('read client is separate from the headless server and retires when old', async () => {
  process.env.DROVER_CODEX_READ_MAX_CALLS = '1000'; // the age rule is under test here, not the call budget
  const first = codex.readClient(); await first.init();
  assert.notEqual(first, codex.sharedClient());
  const firstChild = first.child;
  process.env.DROVER_CODEX_READ_MAX_AGE_MS = '0';
  try {
    const second = codex.readClient();
    assert.notEqual(second, first, 'an expired idle reader is replaced');
    await new Promise((r) => setImmediate(r)); // stops land a turn after retirement
    assert.equal(first.child === null || firstChild.killed, true, 'the expired reader process is stopped');
    const th = await codex.listThreads({ limit: 5 });
    assert.equal(th.length, 2);
  } finally { delete process.env.DROVER_CODEX_READ_MAX_AGE_MS; delete process.env.DROVER_CODEX_READ_MAX_CALLS; }
});

test('a reader with a request in flight is not retired', async () => {
  process.env.DROVER_CODEX_READ_MAX_CALLS = '1000'; // the age rule is under test here, not the call budget
  const c = codex.readClient(); await c.init();
  process.env.DROVER_CODEX_READ_MAX_AGE_MS = '0';
  try {
    c.pending.set(-1, { resolve() {}, reject() {} });
    assert.equal(codex.readClient(), c);
  } finally { c.pending.delete(-1); delete process.env.DROVER_CODEX_READ_MAX_AGE_MS; delete process.env.DROVER_CODEX_READ_MAX_CALLS; }
});

const until = async (cond, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
};

test('a reader is retired once it has served its call budget', async () => {
  codex.stopReadClient();
  process.env.DROVER_CODEX_READ_MAX_CALLS = '2';
  try {
    const a = codex.readClient(); await a.init();
    assert.equal(codex.readClient(), a, 'the second call is within budget');
    const child = a.child;
    assert.notEqual(codex.readClient(), a, 'the third call gets a fresh reader');
    await until(() => child.killed);
  } finally { delete process.env.DROVER_CODEX_READ_MAX_CALLS; }
});

test('a busy reader past its budget takes no new work and stops once its request settles', async () => {
  codex.stopReadClient();
  process.env.DROVER_CODEX_READ_MAX_CALLS = '1';
  try {
    const a = codex.readClient(); await a.init();
    const child = a.child;
    a.pending.set(-1, { resolve() {}, reject() {} });
    assert.notEqual(codex.readClient(), a, 'new work goes to a fresh reader');
    await new Promise((r) => setImmediate(r));
    assert.equal(child.killed, false, 'the request in flight is not cut');
    a.pending.delete(-1);
    codex.readClient();
    await until(() => child.killed);
  } finally { delete process.env.DROVER_CODEX_READ_MAX_CALLS; }
});

test('a retired reader that ignores SIGTERM is killed after the grace period', async () => {
  codex.stopReadClient();
  process.env.DROVER_CODEX_READ_MAX_CALLS = '1';
  process.env.DROVER_CODEX_READ_KILL_GRACE_MS = '50';
  process.env.FAKE_CODEX_IGNORE_TERM = '1';
  try {
    const a = codex.readClient(); await a.init();
    delete process.env.FAKE_CODEX_IGNORE_TERM;
    const child = a.child;
    codex.readClient();
    await until(() => child.signalCode !== null || child.exitCode !== null);
    assert.equal(child.signalCode, 'SIGKILL');
  } finally {
    delete process.env.FAKE_CODEX_IGNORE_TERM;
    delete process.env.DROVER_CODEX_READ_MAX_CALLS;
    delete process.env.DROVER_CODEX_READ_KILL_GRACE_MS;
  }
});

test('a reader that exits on SIGTERM is never sent SIGKILL, so a reused pid is safe', async () => {
  codex.stopReadClient();
  process.env.DROVER_CODEX_READ_MAX_CALLS = '1';
  // Long enough that the fake exits on SIGTERM first even under a loaded full-suite
  // run; with 50 ms it sometimes had not, and was SIGKILLed as a genuinely live reader.
  process.env.DROVER_CODEX_READ_KILL_GRACE_MS = '3000';
  const kill = process.kill; const killed = [];
  process.kill = (pid, sig) => { if (sig === 'SIGKILL') killed.push(pid); return kill.call(process, pid, sig); };
  try {
    const a = codex.readClient(); await a.init();
    const child = a.child;
    const retiredAt = Date.now();
    codex.readClient();
    await until(() => child.signalCode !== null || child.exitCode !== null, 2_500);
    await new Promise((r) => setTimeout(r, Math.max(0, retiredAt + 3_300 - Date.now()))); // past the grace period
    assert.notEqual(child.signalCode, 'SIGKILL');
    assert.deepEqual(killed, []);
  } finally {
    process.kill = kill;
    delete process.env.DROVER_CODEX_READ_MAX_CALLS;
    delete process.env.DROVER_CODEX_READ_KILL_GRACE_MS;
  }
});

test('a failed process listing is retried until the lingering reader is killed', async () => {
  codex.stopReadClient();
  process.env.DROVER_CODEX_READ_MAX_CALLS = '1';
  process.env.DROVER_CODEX_READ_KILL_GRACE_MS = '50';
  process.env.FAKE_CODEX_IGNORE_TERM = '1';
  try {
    const a = codex.readClient(); await a.init();
    delete process.env.FAKE_CODEX_IGNORE_TERM;
    const child = a.child;
    process.env.FAKE_PS_FAIL = '1';
    codex.readClient();
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(child.exitCode === null && child.signalCode === null, true, 'without a listing nothing is killed yet');
    delete process.env.FAKE_PS_FAIL;
    await until(() => child.signalCode !== null || child.exitCode !== null);
    assert.equal(child.signalCode, 'SIGKILL');
  } finally {
    delete process.env.FAKE_PS_FAIL;
    delete process.env.FAKE_CODEX_IGNORE_TERM;
    delete process.env.DROVER_CODEX_READ_MAX_CALLS;
    delete process.env.DROVER_CODEX_READ_KILL_GRACE_MS;
  }
});

test('identical listings within the TTL share one thread/list call; an expired one is refreshed behind it', async () => {
  codex.clearListCache();
  const a = await codex.listThreads({ limit: 7 });
  const b = await codex.listThreads({ limit: 7 });
  assert.equal(a, b, 'the second call returns the cached result');
  process.env.DROVER_CODEX_LIST_TTL_MS = '0';
  try {
    assert.equal(await codex.listThreads({ limit: 7 }), a, 'an expired entry is still served at once');
    let c = a;
    for (let i = 0; i < 100 && c === a; i++) { await new Promise((r) => setTimeout(r, 20)); c = await codex.listThreads({ limit: 7 }); }
    assert.notEqual(c, a, 'the refresh that ran behind it replaced it');
  } finally { delete process.env.DROVER_CODEX_LIST_TTL_MS; codex.clearListCache(); }
});

test('concurrent first calls for a key share one load', async () => {
  codex.clearListCache();
  const [x, y] = await Promise.all([codex.listThreads({ limit: 12 }), codex.listThreads({ limit: 12 })]);
  assert.equal(x, y);
  codex.clearListCache();
});

test('a failed refresh keeps serving the last good list', async () => {
  codex.clearListCache(); codex.stopReadClient();
  const good = await codex.listThreads({ limit: 9 });
  const logged = []; const write = process.stderr.write;
  process.stderr.write = (s, ...rest) => { if (String(s).startsWith('[codex-list]')) logged.push(String(s)); return write.call(process.stderr, s, ...rest); };
  process.env.DROVER_CODEX_LIST_TTL_MS = '0';
  process.env.FAKE_CODEX_LIST_FAIL = '1';
  codex.stopReadClient(); // the next reader starts as the failing fake
  try {
    assert.equal(await codex.listThreads({ limit: 9 }), good, 'served at once while the refresh runs');
    await until(() => logged.length > 0);
    assert.match(logged[0], /refresh failed/);
    assert.equal(await codex.listThreads({ limit: 9 }), good, 'the failed refresh did not replace it');
  } finally {
    process.stderr.write = write;
    delete process.env.FAKE_CODEX_LIST_FAIL; delete process.env.DROVER_CODEX_LIST_TTL_MS;
    codex.stopReadClient(); codex.clearListCache();
  }
});

test('a list past the max stale age is reloaded before it is returned', async () => {
  codex.clearListCache();
  const first = await codex.listThreads({ limit: 11 });
  process.env.DROVER_CODEX_LIST_MAX_STALE_MS = '0';
  try { assert.notEqual(await codex.listThreads({ limit: 11 }), first); }
  finally { delete process.env.DROVER_CODEX_LIST_MAX_STALE_MS; codex.clearListCache(); }
});

test('a stopped client rejects a request instead of writing after its stdin closed', async () => {
  const c = new codex.AppServerClient(); await c.init();
  c.stop();
  await assert.rejects(c.request('thread/list'), /stopped before thread\/list/);
  const s = codex.sharedClient(); s.stop();
  assert.notEqual(codex.sharedClient(), s, 'a stopped shared client is replaced, not reused');
});

test('rpc errors reject with the server message', async () => {
  const c = codex.sharedClient(); await c.init();
  await assert.rejects(c.request('boom'), /kaboom/);
});

test('sendTurn validates input', async () => {
  await assert.rejects(codex.sendTurn('t1', ''), /empty message/);
  await assert.rejects(codex.sendTurn('bad id!', 'x'), /bad threadId/);
});

// Tool calls come in the Claude transcript shape (tui/chat.js, ui/chat-model.js): a call turn with tools[]
// and its summary, then a tool_result turn whose results[] carry the output under the call's id.
test('threadToTurns flattens a thread/read result', () => {
  const turns = codex.threadToTurns({ thread: { turns: [{ createdAt: 1, items: [{ type: 'userMessage', content: [{ text: 'q' }] }, { type: 'agentMessage', text: 'a' }, { id: 'c1', type: 'commandExecution', command: 'ls', aggregatedOutput: 'a.txt', exitCode: 0 }, { id: 'c2', type: 'fileChange', changes: [{ path: 'src/x.js' }] }] }] } });
  assert.deepEqual(turns.map((t) => [t.role, t.text]), [['user', 'q'], ['assistant', 'a'], ['assistant', ''], ['tool_result', 'a.txt'], ['assistant', '']]);
  assert.deepEqual(turns[2].tools.map((x) => [x.id, x.name, x.summary]), [['c1', 'shell', 'ls']]);
  assert.deepEqual(turns[3].results, [{ toolUseId: 'c1', isError: false, text: 'a.txt', chars: 5 }]);
  assert.equal(turns[4].tools[0].summary, 'src/x.js');
});

test('readRollout parses session_meta and messages', async () => {
  const dir = path.join(process.env.CODEX_HOME, 'sessions', '2026', '10', '11');
  await mkdir(dir, { recursive: true });
  const f = path.join(dir, 'rollout-2026-10-11T10-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl');
  await writeFile(f, [
    JSON.stringify({ type: 'session_meta', payload: { id: 'aaaa', cwd: '/w', model_provider: 'p' } }),
    JSON.stringify({ type: 'response_item', timestamp: 't1', payload: { type: 'message', role: 'user', content: [{ text: 'hello' }] } }),
    JSON.stringify({ type: 'response_item', timestamp: 't2', payload: { type: 'agent_message', content: [{ text: 'world' }] } }),
    JSON.stringify({ type: 'response_item', timestamp: 't3', payload: { type: 'function_call', name: 'shell', arguments: '{"cmd":"ls"}', call_id: 'k1' } }),
    JSON.stringify({ type: 'response_item', timestamp: 't4', payload: { type: 'function_call_output', call_id: 'k1', output: 'Process exited with code 2\nOutput:\nnope' } }),
    JSON.stringify({ type: 'response_item', timestamp: 't5', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'k2', input: 'const r = await tools.exec_command({cmd:"npm test"}); text(r);' } }),
    JSON.stringify({ type: 'response_item', timestamp: 't6', payload: { type: 'custom_tool_call_output', call_id: 'k2', output: [{ type: 'input_text', text: 'Script completed\nOutput:\nok' }] } }),
  ].join('\n'));
  const r = await codex.readRollout(f);
  assert.equal(r.meta.cwd, '/w');
  assert.deepEqual(r.turns.map((t) => t.role), ['user', 'assistant', 'assistant', 'tool_result', 'assistant', 'tool_result']);
  assert.deepEqual(r.turns[2].tools.map((x) => [x.id, x.name, x.summary]), [['k1', 'shell', 'ls']]);
  assert.equal(r.turns[3].results[0].toolUseId, 'k1');
  assert.equal(r.turns[3].results[0].isError, true, 'a non-zero exit code is a failed call');
  assert.equal(r.turns[4].tools[0].summary, 'npm test', 'the command inside a code-mode exec call');
  assert.deepEqual([r.turns[5].results[0].isError, r.turns[5].results[0].text], [false, 'Script completed\nOutput:\nok']);
  const recent = await codex.recentRollouts({ days: 36500 });
  assert.equal(recent[0].threadId, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  codex.sharedClient().stop();
  codex.stopReadClient();
});
