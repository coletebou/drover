// The manager conversation store (ui/manager-model.js): async send, the streamed reply assembled from `manager`
// events, `turn` events, threads, an older daemon's inline reply, the transcript fallback when no event comes, and
// no turn ever shown twice. A fake call function and fake timers stand in for the daemon and the clock.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ManagerStore, THREAD_RE, capTurns, finishes, popHash, parsePopHash } from '../ui/manager-model.js';
import { chatItems } from '../ui/chat-model.js';

function rig({ answers = {}, host = 'local', front = 'laptop' } = {}) {
  const calls = []; const timers = []; let clock = Date.parse('2026-10-20T12:00:00Z');
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  if (host !== 'local') storage.setItem('drover.manager.host', host);
  const call = async (op, args, opts) => {
    calls.push({ op, args, host: opts?.host });
    const a = answers[op];
    if (a instanceof Error) throw a;
    return typeof a === 'function' ? a(args) : a;
  };
  const store = new ManagerStore({ call, storage, now: () => clock, frontHost: () => front, timers: { set: (f, ms) => { const t = { f, at: clock + ms, done: false }; timers.push(t); return t; }, clear: (t) => { if (t) t.done = true; } } });
  const tick = async (ms) => { clock += ms; for (const t of timers.filter((x) => !x.done && x.at <= clock)) { t.done = true; await t.f(); } };
  const shown = (thread) => chatItems(store.turns(thread)).map((i) => `${i.kind}:${i.label ? i.label + ':' : ''}${i.text}${i.pending ? ' …' : ''}`);
  return { store, calls, tick, storage, shown, advance: (ms) => { clock += ms; } };
}
const settle = () => new Promise((r) => setImmediate(r));

describe('sending and the streamed reply', () => {
  test('wait:false; the reply streams in, lands as a turn, and every turn shows once', async () => {
    const { store, calls, shown } = rig({ answers: { 'sessions.message': { ok: true, pending: true, event: 'm1', turnId: 't1', thread: 'main' } } });
    const sent = store.send('Who is waiting on me?');
    assert.deepEqual(shown(), ['user:you:Who is waiting on me?'], 'the echo shows at once');
    assert.equal(store.busy(), true);
    await sent;
    assert.deepEqual(calls[0], { op: 'sessions.message', args: { id: 'manager', text: 'Who is waiting on me?', wait: false, thread: 'main' }, host: 'local' });
    store.onStream({ host: 'laptop', thread: 'main', turnId: 't1', inReplyTo: 'm1', phase: 'start', text: '' });
    assert.deepEqual(shown(), ['user:you:Who is waiting on me?', 'assistant: …']);
    store.onStream({ host: 'laptop', thread: 'main', turnId: 't1', inReplyTo: 'm1', phase: 'delta', delta: 'Two sessions', text: 'Two sessions' });
    store.onStream({ host: 'laptop', thread: 'main', turnId: 't1', inReplyTo: 'm1', phase: 'delta', delta: ' wait on you' });
    assert.deepEqual(shown(), ['user:you:Who is waiting on me?', 'assistant:Two sessions wait on you …'], 'a delta without text appends');
    store.onTurn({ id: 'manager', host: 'laptop', thread: 'main', turn: { role: 'user', id: 'm1', text: 'Who is waiting on me?', actor: 'owner' } });
    store.onStream({ host: 'laptop', thread: 'main', turnId: 't1', inReplyTo: 'm1', phase: 'done', text: 'Two sessions wait on you: a and b.' });
    assert.equal(store.busy(), false);
    store.onTurn({ id: 'manager', host: 'laptop', thread: 'main', turn: { role: 'assistant', id: 'c1', inReplyTo: 'm1', text: 'Two sessions wait on you: a and b.' } });
    assert.deepEqual(shown(), ['user:you:Who is waiting on me?', 'assistant:Two sessions wait on you: a and b.']);
    assert.deepEqual(store.turns().map((t) => t.id), ['m1', 'c1']);
  });
  test('the message turn can arrive before the send answers: the echo is matched by its text', async () => {
    let release; const gate = new Promise((r) => { release = r; });
    const { store, shown } = rig({ answers: { 'sessions.message': () => gate.then(() => ({ ok: true, pending: true, event: 'm2', turnId: 't2' })) } });
    const sent = store.send('status?');
    store.onTurn({ id: 'manager', host: 'laptop', turn: { role: 'user', id: 'm2', text: 'status?' } });
    store.onTurn({ id: 'manager', host: 'laptop', turn: { role: 'assistant', id: 'c2', inReplyTo: 'm2', text: 'All quiet.' } });
    release(); await sent;
    assert.deepEqual(shown(), ['user:you:status?', 'assistant:All quiet.']);
    assert.equal(store.busy(), false, 'the reply already landed, nothing to wait for');
  });
  test('an older daemon answers inside the call; its transcript, with no ids, replaces the local copies', async () => {
    const transcript = { engine: 'openclaw', offset: 2, turns: [{ role: 'user', ts: '2026-10-20T12:00:00.100Z', text: 'hi', user: 'drover:owner' }, { role: 'assistant', ts: '2026-10-20T12:00:03Z', text: 'Hi there', model: 'openclaw/default' }] };
    const { store, shown } = rig({ answers: { 'sessions.message': { ok: true, reply: 'Hi there', model: 'openclaw/default', event: 'e1' }, 'sessions.transcript': transcript } });
    await store.send('hi');
    assert.deepEqual(shown(), ['user:you:hi', 'assistant:Hi there']);
    await store.load();
    assert.deepEqual(shown(), ['user:you:hi', 'assistant:Hi there'], 'the four turns the old drawer showed are two');
    assert.ok(store.turns().every((t) => !t.local && !t.localReply));
  });
  test('no event comes (a manager on another host): the transcript is read until the reply is there', async () => {
    let reads = 0;
    const { store, tick, calls, shown } = rig({ answers: {
      'sessions.message': { ok: true, pending: true, event: 'm3', turnId: 't3' },
      'sessions.transcript': () => (++reads < 2 ? { offset: 1, turns: [{ role: 'user', id: 'm3', text: 'sweep?', thread: 'main' }, { role: 'assistant', id: 't3', inReplyTo: 'm3', pending: true, text: 'Look', thread: 'main' }] }
        : { offset: 2, turns: [{ role: 'user', id: 'm3', text: 'sweep?', thread: 'main' }, { role: 'assistant', id: 'c3', inReplyTo: 'm3', text: 'Looked: all fine.', thread: 'main' }] }),
    } });
    await store.send('sweep?');
    await tick(3000); assert.equal(calls.filter((c) => c.op === 'sessions.transcript').length, 0, 'not before the quiet period');
    await tick(3000); await settle();
    assert.deepEqual(shown(), ['user:you:sweep?', 'assistant:Look …']);
    await tick(3000); await settle();
    assert.deepEqual(shown(), ['user:you:sweep?', 'assistant:Looked: all fine.']);
    assert.equal(store.busy(), false);
    const n = calls.length; await tick(10_000); assert.equal(calls.length, n, 'reading stops once answered');
  });
  test('an error ends the stream: the text so far stays, the error shows, nothing waits', async () => {
    const { store, shown } = rig({ answers: { 'sessions.message': { ok: true, pending: true, event: 'm4', turnId: 't4' } } });
    await store.send('go');
    store.onStream({ host: 'laptop', turnId: 't4', inReplyTo: 'm4', phase: 'delta', text: 'Half' });
    store.onStream({ host: 'laptop', turnId: 't4', inReplyTo: 'm4', phase: 'error', error: 'gateway 502' });
    assert.equal(chatItems(store.turns()).at(-1).error, 'gateway 502');
    assert.equal(store.busy(), false);
    assert.deepEqual(shown(), ['user:you:go', 'assistant:Half']);
  });
  test('a send that fails marks its echo and stops waiting', async () => {
    const { store } = rig({ answers: { 'sessions.message': new Error('session not found') } });
    await assert.rejects(store.send('x'), /session not found/);
    assert.equal(store.turns()[0].failed, 'session not found');
    assert.equal(store.busy(), false);
  });
});

describe('threads, hosts, drafts', () => {
  test('events go to their own thread; another host\'s events are not this manager\'s', async () => {
    const { store, shown } = rig();
    store.onTurn({ id: 'manager', host: 'laptop', thread: 'w12', turn: { role: 'assistant', id: 'x', text: 'only in w12' } });
    store.onTurn({ id: 'manager', host: 'devbox', thread: 'main', turn: { role: 'assistant', id: 'y', text: 'another manager' } });
    store.onTurn({ id: 'manager', host: 'local', thread: 'main', turn: { role: 'assistant', id: 'z', text: 'this one' } });
    assert.deepEqual(shown('main'), ['assistant:this one']);
    assert.deepEqual(shown('w12'), ['assistant:only in w12']);
    assert.throws(() => store.setThread('bad name!'), /thread name/);
    assert.ok(THREAD_RE.test('tmux:work.3') && !THREAD_RE.test('x'.repeat(65)));
  });
  test('switching thread reads it; sends go to the current thread', async () => {
    const { store, calls } = rig({ answers: { 'sessions.transcript': (a) => ({ offset: 0, turns: [] }), 'sessions.message': { ok: true, pending: true, event: 'm', turnId: 't' } } });
    store.setThread('w12'); await settle();
    assert.deepEqual(calls.at(-1), { op: 'sessions.transcript', args: { id: 'manager', thread: 'w12', since: 0, limit: 200 }, host: 'local' });
    await store.send('in w12');
    assert.equal(calls.at(-1).args.thread, 'w12');
  });
  test('a remote manager host: calls go there and its own events count', async () => {
    const { store, calls } = rig({ host: 'box-b', answers: { 'sessions.transcript': { offset: 0, turns: [] } } });
    await store.load();
    assert.equal(calls[0].host, 'box-b');
    store.onTurn({ id: 'manager', host: 'box-b', turn: { role: 'assistant', id: 'r', text: 'remote' } });
    assert.equal(store.turns().length, 1);
  });
  test('no manager on the host reads as down, with the reason', async () => {
    const { store } = rig({ answers: { 'sessions.transcript': new Error('session not found') } });
    await store.load();
    assert.equal(store.state(), 'down');
    assert.match(store.conv().error, /No manager on this machine/);
  });
  test('drafts and history persist; the board names where the manager runs unless the owner picked a host', async () => {
    const { store, storage } = rig({ answers: { 'sessions.transcript': { offset: 0, turns: [] }, 'sessions.message': { ok: true, pending: true, event: 'm', turnId: 't' } } });
    store.setDraft('main', 'half a thought');
    assert.match(storage.getItem('drover.manager.drafts'), /half a thought/);
    await store.send('first'); await store.send('second'); await store.send('first');
    assert.deepEqual(store.history, ['first', 'second']);
    assert.equal(store.draft('main'), '', 'sending clears the draft');
    store.onBoard({ up: true, host: 'box-b' });
    assert.equal(store.host, 'box-b');
    store.setHost('local');
    store.onBoard({ up: true, host: 'box-b' });
    assert.equal(store.host, 'local', 'a host the owner chose stays');
  });
  test('sweep is an op, not a message, and leaves a line in the conversation', async () => {
    const { store, calls } = rig({ answers: { 'openclaw.sweep': { ok: true, queued: 'sweep now' } } });
    await store.sweep();
    assert.equal(calls[0].op, 'openclaw.sweep');
    assert.match(store.turns()[0].text, /sweep now/);
  });
});

describe('review fixes: replies already on their way, failures, a long-lived page, drafts, the window route', () => {
  test('a conversation read mid-reply waits for that reply too: with no event, the transcript is read until it lands', async () => {
    let reads = 0;
    const { store, tick, shown } = rig({ answers: { 'sessions.transcript': () => (++reads < 3
      ? { offset: 1, turns: [{ role: 'user', id: 'm9', text: 'who waits?', thread: 'main' }, { role: 'assistant', id: 'pending:m9', inReplyTo: 'm9', pending: true, text: 'Two', thread: 'main' }] }
      : { offset: 2, turns: [{ role: 'user', id: 'm9', text: 'who waits?', thread: 'main' }, { role: 'assistant', id: 'c9', inReplyTo: 'm9', text: 'Two sessions.', thread: 'main' }] }) } });
    await store.load();
    assert.equal(store.busy(), true);
    assert.equal(store.awaiting.size, 1, 'the reply in flight is awaited like one sent from here');
    await tick(3000); await tick(3000); await settle(); await tick(3000); await settle();
    assert.deepEqual(shown(), ['user:you:who waits?', 'assistant:Two sessions.']);
    assert.equal(store.busy(), false);
  });
  test('the daemon\'s failure line ends a wait, from a turn event and from a read', async () => {
    const a = rig({ answers: { 'sessions.message': { ok: true, pending: true, event: 'm1', turnId: 'pending:m1' } } });
    await a.store.send('go');
    a.store.onTurn({ id: 'manager', host: 'laptop', turn: { role: 'system', id: 'e1', inReplyTo: 'm1', error: 'gateway 502', text: 'The manager did not answer: gateway 502' } });
    assert.equal(a.store.busy(), false);
    const b = rig({ answers: { 'sessions.message': { ok: true, pending: true, event: 'm2', turnId: 'pending:m2' }, 'sessions.transcript': { offset: 2, turns: [{ role: 'user', id: 'm2', text: 'go', thread: 'main' }, { role: 'system', id: 'e2', inReplyTo: 'm2', error: 'gateway 502', text: 'The manager did not answer: gateway 502', thread: 'main' }] } } });
    await b.store.send('go');
    await b.tick(6000); await settle();
    assert.equal(b.store.busy(), false);
    assert.ok(finishes({ role: 'system', error: 'x' }) && finishes({ role: 'assistant' }) && !finishes({ role: 'assistant', pending: true }) && !finishes({ role: 'system', text: 'swept' }));
  });
  test('a page open for days keeps the newest turns; what only it has is never dropped; deltas update in place', () => {
    const many = Array.from({ length: 450 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', id: `t${i}`, text: `${i}` }));
    const kept = capTurns([{ role: 'user', localId: 'local:1', local: true, text: 'echo' }, ...many, { role: 'assistant', id: 'p', pending: true, text: '' }]);
    assert.equal(kept.length, 400);
    assert.ok(kept.some((t) => t.local) && kept.some((t) => t.pending));
    assert.equal(kept.find((t) => !t.local).id, 't52', 'the oldest server turns go first');
    const { store } = rig();
    for (let i = 0; i < 300; i++) store.onTurn({ id: 'manager', host: 'local', turn: { role: i % 2 ? 'assistant' : 'user', id: `e${i}`, text: `${i}` } });
    for (let i = 300; i < 520; i++) store.onTurn({ id: 'manager', host: 'local', turn: { role: i % 2 ? 'assistant' : 'user', id: `e${i}`, text: `${i}` } });
    assert.equal(store.turns().length, 400);
    store.onStream({ host: 'local', turnId: 'pending:x', inReplyTo: 'x', phase: 'start', text: '' });
    const before = store.turns();
    const at = before.findIndex((t) => t.id === 'pending:x');
    store.onStream({ host: 'local', turnId: 'pending:x', inReplyTo: 'x', phase: 'delta', delta: 'Hel', text: 'Hel' });
    assert.equal(store.turns()[at].text, 'Hel');
    assert.equal(store.turns().length, before.length);
  });
  test('drafts: a change tells every composer; a send clears it for all; a quick prompt leaves it', async () => {
    const { store } = rig({ answers: { 'sessions.message': { ok: true, pending: true, event: 'm', turnId: 't' } } });
    const seen = []; store.on((what, thread) => { if (what === 'draft') seen.push(thread); });
    store.setDraft('main', 'half');
    store.setDraft('main', 'half');
    assert.deepEqual(seen, ['main'], 'only a change is news');
    await store.send('Who is waiting on me?', { keepDraft: true });
    assert.equal(store.draft('main'), 'half');
    await store.send('half');
    assert.equal(store.draft('main'), '');
    assert.deepEqual(seen, ['main', 'main']);
  });
  test('the manager\'s own window route round-trips its host and thread', () => {
    assert.equal(popHash('local'), '#/pop/manager/local');
    assert.equal(popHash('devbox', 'win-@12'), '#/pop/manager/devbox/win-%4012');
    assert.deepEqual(parsePopHash(popHash('devbox', 'win-@12')), { host: 'devbox', thread: 'win-@12' });
    assert.deepEqual(parsePopHash('#/pop/manager'), { host: 'local', thread: 'main' });
    assert.equal(parsePopHash('#/pop-manager'), null);
  });
});
