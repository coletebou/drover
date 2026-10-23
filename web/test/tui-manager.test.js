// The manager conversation model (tui/convo.js): the local echo, the async answer, the stream, and the final
// turns merge so every turn shows once, with the shapes the daemon sends (core/openclaw.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Convo } from '../tui/convo.js';

const roles = (c) => c.turns.map((t) => `${t.role}${t.pending ? '*' : ''}:${t.text}`);

test('send, async answer, stream deltas, done, then the turn event: one reply, replaced in place', () => {
  const c = new Convo('main');
  const k = c.send('who is waiting on me?');
  assert.equal(c.turns[0].sending, true);
  c.sent(k, { ok: true, pending: true, event: 'm1', turnId: 'pending:m1', thread: 'main' });
  assert.deepEqual(roles(c), ['user:who is waiting on me?', 'assistant*:']);
  c.stream({ thread: 'main', turnId: 'pending:m1', inReplyTo: 'm1', phase: 'start', text: '' });
  c.stream({ thread: 'main', turnId: 'pending:m1', inReplyTo: 'm1', phase: 'delta', delta: 'Two ', text: 'Two ' });
  c.stream({ thread: 'main', turnId: 'pending:m1', inReplyTo: 'm1', phase: 'delta', delta: 'sessions.', text: 'Two sessions.' });
  assert.deepEqual(roles(c), ['user:who is waiting on me?', 'assistant*:Two sessions.']);
  c.stream({ thread: 'main', turnId: 'pending:m1', inReplyTo: 'm1', phase: 'done', text: 'Two sessions are waiting.', id: 'c1' });
  c.server({ id: 'c1', role: 'assistant', text: 'Two sessions are waiting.', inReplyTo: 'm1', thread: 'main', model: 'm' });
  assert.deepEqual(roles(c), ['user:who is waiting on me?', 'assistant:Two sessions are waiting.']);
  // The user turn's own turn event (it may come before or after the HTTP answer) does not add a copy.
  c.server({ id: 'm1', role: 'user', text: 'who is waiting on me?', thread: 'main' });
  assert.equal(c.turns.length, 2);
  assert.equal(c.busy, false);
});

test('the turn event and the stream can beat the HTTP answer', () => {
  const c = new Convo('main');
  const k = c.send('status?');
  c.server({ id: 'm2', role: 'user', text: 'status?', thread: 'main' });
  c.stream({ thread: 'main', turnId: 'pending:m2', inReplyTo: 'm2', phase: 'delta', text: 'All' });
  c.sent(k, { pending: true, event: 'm2', turnId: 'pending:m2' });
  assert.deepEqual(roles(c), ['user:status?', 'assistant*:All'], 'no second echo, no second pending reply');
  c.server({ id: 'c2', role: 'assistant', text: 'All quiet.', inReplyTo: 'm2', thread: 'main' });
  assert.deepEqual(roles(c), ['user:status?', 'assistant:All quiet.']);
});

test('a transcript read during the stream (pending turn) does not duplicate or regress the reply', () => {
  const c = new Convo('main');
  c.load([{ id: 'm3', role: 'user', text: 'q', ts: '2026-10-20T12:00:00Z' }, { id: 'pending:m3', role: 'assistant', pending: true, text: 'part', inReplyTo: 'm3', ts: '2026-10-20T12:00:01Z' }]);
  c.stream({ thread: 'main', turnId: 'pending:m3', inReplyTo: 'm3', phase: 'delta', text: 'partial answer' });
  assert.deepEqual(roles(c), ['user:q', 'assistant*:partial answer']);
  c.stream({ thread: 'main', turnId: 'pending:m3', inReplyTo: 'm3', phase: 'done', text: 'final answer', id: 'c3' });
  assert.equal(c.server({ id: 'pending:m3', role: 'assistant', pending: true, text: 'part', inReplyTo: 'm3' }), false, 'a late pending copy is ignored');
  assert.deepEqual(roles(c), ['user:q', 'assistant:final answer']);
  c.load([{ id: 'm3', role: 'user', text: 'q' }, { id: 'c3', role: 'assistant', text: 'final answer', inReplyTo: 'm3' }]);
  assert.deepEqual(roles(c), ['user:q', 'assistant:final answer'], 'a reload after reconnecting changes nothing');
});

test('a failed reply: the error event, then the system turn that takes the pending reply\'s place', () => {
  const c = new Convo('main');
  const k = c.send('fail now');
  c.sent(k, { pending: true, event: 'm4', turnId: 'pending:m4' });
  c.stream({ thread: 'main', turnId: 'pending:m4', inReplyTo: 'm4', phase: 'error', error: 'gateway 502', id: 'c4' });
  assert.equal(c.turns[1].error, 'gateway 502');
  c.server({ id: 'c4', role: 'system', text: 'The manager did not answer: gateway 502', error: 'gateway 502', inReplyTo: 'm4', thread: 'main' });
  assert.deepEqual(roles(c), ['user:fail now', 'system:The manager did not answer: gateway 502']);
  assert.equal(c.chatTurns()[1].style, 'err');
});

test('a daemon from before async replies: the reply arrives in the call, after a "waiting" turn', () => {
  const c = new Convo('main');
  const k = c.send('hello');
  c.waitingBlocking(k);
  assert.deepEqual(roles(c), ['user:hello', 'assistant*:']);
  assert.equal(c.turns[1].waiting, 'blocking');
  c.sent(k, { ok: true, reply: 'hi there', event: 'm5', model: 'x' });
  assert.deepEqual(roles(c), ['user:hello', 'assistant:hi there']);
  assert.equal(c.turns[0].id, 'm5');
  // A slow new daemon: the waiting turn takes the stream's ids instead of a second pending turn.
  const d = new Convo('main'); const k2 = d.send('slow'); d.waitingBlocking(k2);
  d.sent(k2, { pending: true, event: 'm6', turnId: 'pending:m6' });
  d.stream({ thread: 'main', inReplyTo: 'm6', turnId: 'pending:m6', phase: 'delta', text: 'ok' });
  assert.deepEqual(roles(d), ['user:slow', 'assistant*:ok']);
});

test('threads: events of another thread are not this conversation\'s', () => {
  const c = new Convo('win-@12');
  assert.equal(c.stream({ thread: 'main', inReplyTo: 'x', phase: 'delta', text: 'no' }), false);
  assert.equal(c.server({ id: 'y', role: 'user', text: 'no', thread: 'main' }), false);
  assert.equal(c.server({ id: 'z', role: 'user', text: 'yes', thread: 'win-@12' }), true);
  assert.equal(new Convo().stream({ inReplyTo: 'q', phase: 'delta', text: 'a stream without a thread is main' }), true);
});

test('a failed send keeps the echo with its error; local notes survive reloads', () => {
  const c = new Convo('main');
  const k = c.send('x');
  c.failed(k, 'the daemon at 127.0.0.1:7337 is not answering');
  assert.equal(c.turns[0].error, 'the daemon at 127.0.0.1:7337 is not answering');
  c.system('thread main');
  c.load([{ id: 'm9', role: 'user', text: 'earlier' }]);
  assert.deepEqual(roles(c), ['user:earlier', 'user:x', 'system:thread main']);
});

test('a long-running conversation keeps the newest turns, and never drops a reply in flight', () => {
  const c = new Convo('main');
  const k = c.send('still sending');                      // the oldest turn is a message not yet answered by the call
  for (let i = 0; i < 700; i++) c.server({ id: `t${i}`, role: i % 2 ? 'assistant' : 'user', text: `turn ${i}`, inReplyTo: i % 2 ? `t${i - 1}` : undefined, thread: 'main' });
  assert.equal(c.prune(), true);
  assert.equal(c.turns.length, 401, 'the newest 400, plus the message still sending');
  assert.equal(c.turns[0].key, k);
  assert.equal(c.turns[1].id, 't300');
  assert.equal(c.turns.at(-1).id, 't699');
  assert.equal(c.prune(), false, 'under the bound nothing changes');
  c.sent(k, { pending: true, event: 'm-late', turnId: 'pending:m-late' });
  assert.equal(c.turns.at(-1).inReplyTo, 'm-late', 'the kept message still gets its reply');
});
