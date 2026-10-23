// The manager conversation: local echo replaced by the server copy, the reply streamed by `manager` events and
// settled by `turn` events or a transcript read, nothing twice, other threads left out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { managerInit, managerReduce, managerBusy, lastExchange } from '../lib/manager.js';

const run = (actions, s = managerInit()) => actions.reduce(managerReduce, s);
const stream = (phase, extra = {}) => ({ type: 'stream', data: { host: 'local', thread: 'main', turnId: 't-1', inReplyTo: 'ev-1', phase, ...extra } });
const turn = (t) => ({ type: 'turn', data: { id: 'manager', host: 'local', thread: 'main', turn: t } });

test('send, stream, done: one question and one reply', () => {
  let s = run([{ type: 'send', text: ' Who is waiting on me? ' }]);
  assert.equal(managerBusy(s), true);
  assert.equal(s.turns.length, 2);
  assert.equal(s.turns[0].text, 'Who is waiting on me?');
  assert.equal(s.turns[0].local, true);
  s = run([{ type: 'sent', res: { ok: true, pending: true, event: 'ev-1', turnId: 't-1', thread: 'main' } }, stream('start'), stream('delta', { delta: 'Two ' }), stream('delta', { delta: 'sessions.' })], s);
  assert.equal(lastExchange(s).reply.text, 'Two sessions.');
  assert.equal(lastExchange(s).reply.streaming, true);
  s = run([stream('delta', { text: 'Two sessions wait.' }), stream('done', { text: 'Two sessions wait: demo-build, demo-review.' })], s);
  assert.equal(managerBusy(s), false);
  // The turn events for both: the echo becomes the server copy, the reply settles, nothing is added.
  s = run([turn({ id: 'ev-1', role: 'user', text: 'Who is waiting on me?', actor: 'owner' }), turn({ id: 'ev-2', role: 'assistant', text: 'Two sessions wait: demo-build, demo-review.', inReplyTo: 'ev-1' })], s);
  assert.deepEqual(s.turns.map((t) => [t.role, t.id, t.local]), [['user', 'ev-1', false], ['assistant', 'ev-2', false]]);
  assert.equal(lastExchange(s).question.text, 'Who is waiting on me?');
});

test('the stream may race the POST answer', () => {
  const s = run([
    { type: 'send', text: 'What finished?' },
    turn({ id: 'ev-9', role: 'user', text: 'What finished?' }),
    stream('start', { turnId: 't-9', inReplyTo: 'ev-9' }),
    stream('delta', { turnId: 't-9', inReplyTo: 'ev-9', text: 'demo-docs finished.' }),
    { type: 'sent', res: { pending: true, event: 'ev-9', turnId: 't-9' } },
    stream('done', { turnId: 't-9', inReplyTo: 'ev-9' }),
  ]);
  assert.deepEqual(s.turns.map((t) => [t.role, t.text]), [['user', 'What finished?'], ['assistant', 'demo-docs finished.']]);
  assert.equal(managerBusy(s), false);
});

test('a transcript read settles a reply the stream never delivered, and keeps server order', () => {
  let s = run([{ type: 'send', text: 'Q2' }, { type: 'sent', res: { pending: true, event: 'ev-3', turnId: 't-3' } }]);
  s = managerReduce(s, { type: 'transcript', res: { turns: [
    { id: 'ev-1', role: 'user', text: 'Q1', thread: 'main' },
    { id: 'ev-2', role: 'assistant', text: 'A1', inReplyTo: 'ev-1', thread: 'main' },
    { id: 'ev-3', role: 'user', text: 'Q2', thread: 'main' },
    { id: 'ev-4', role: 'assistant', text: 'A2 so far', inReplyTo: 'ev-3', pending: true, thread: 'main' },
  ] } });
  assert.deepEqual(s.turns.map((t) => t.text), ['Q1', 'A1', 'Q2', 'A2 so far']);
  assert.equal(managerBusy(s), true);
  s = managerReduce(s, { type: 'transcript', res: { turns: [
    { id: 'ev-3', role: 'user', text: 'Q2' },
    { id: 'ev-4', role: 'assistant', text: 'A2, all of it.', inReplyTo: 'ev-3' },
  ] } });
  assert.deepEqual(s.turns.map((t) => t.text), ['Q1', 'A1', 'Q2', 'A2, all of it.']);
  assert.equal(managerBusy(s), false);
});

test('someone else asks: their question and its reply join the thread', () => {
  let s = run([turn({ id: 'ev-5', role: 'user', text: 'Launch the docs agent', actor: 'mcp' })]);
  s = run([stream('start', { turnId: 't-5', inReplyTo: 'ev-5' }), stream('delta', { turnId: 't-5', inReplyTo: 'ev-5', delta: 'Launching.' })], s);
  const ex = lastExchange(s);
  assert.equal(ex.question.actor, 'mcp');
  assert.equal(ex.reply.text, 'Launching.');
});

test('errors and failed sends end the reply', () => {
  let s = run([{ type: 'send', text: 'fail now' }, { type: 'sent', res: { pending: true, event: 'ev-1', turnId: 't-1' } }, stream('error', { error: 'gateway 502' })]);
  assert.equal(lastExchange(s).reply.role, 'system');
  assert.equal(lastExchange(s).reply.text, 'Not answered: gateway 502');
  assert.equal(managerBusy(s), false);
  s = run([{ type: 'send', text: 'hello' }, { type: 'fail', message: 'Cannot reach http://127.0.0.1:7338.' }]);
  assert.equal(lastExchange(s).reply.text, 'Not sent: Cannot reach http://127.0.0.1:7338.');
  assert.equal(lastExchange(s).question.text, 'hello');
  assert.equal(managerBusy(s), false);
});

test('an older daemon answers inside the call', () => {
  const s = run([{ type: 'send', text: 'Q' }, { type: 'sent', res: { ok: true, reply: 'The whole reply.', event: 'ev-1' } }]);
  assert.equal(lastExchange(s).reply.text, 'The whole reply.');
  assert.equal(managerBusy(s), false);
});

test('other threads and other sessions are left out', () => {
  const s = run([
    { type: 'stream', data: { thread: 'win-@12', turnId: 't-1', phase: 'delta', delta: 'x' } },
    { type: 'turn', data: { id: 'manager', thread: 'win-@12', turn: { id: 'e', role: 'user', text: 'a window' } } },
    { type: 'turn', data: { id: 'not-the-manager', turn: { id: 'e2', role: 'user', text: 'x' } } },
    { type: 'stream', data: { thread: 'main', turnId: 't-2', phase: 'error', error: 'not ours' } },
  ]);
  assert.deepEqual(s.turns, []);
  assert.deepEqual(lastExchange(s), { question: null, reply: null });
});

test('empty sends do nothing; a late delta cannot reopen a settled reply', () => {
  assert.deepEqual(managerReduce(managerInit(), { type: 'send', text: '  ' }), managerInit());
  let s = run([{ type: 'send', text: 'Q' }, { type: 'sent', res: { pending: true, event: 'ev-1', turnId: 't-1' } }, stream('done', { text: 'Final.' })]);
  s = managerReduce(s, stream('delta', { delta: ' late' }));
  assert.equal(lastExchange(s).reply.text, 'Final.');
});
