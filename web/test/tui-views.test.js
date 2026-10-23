// The TUI's views against a stub app (synthetic strips): an answer goes to the strip the owner picked, by key, and
// carries the hash of what the last frame drew; a session view finds its strip on its own host; long histories stay
// bounded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManagerView } from '../tui/views/manager.js';
import { BoardView } from '../tui/views/board.js';
import { SessionView, KEEP_EXTRA } from '../tui/views/session.js';

const wait = (key, name, hash, extra = {}) => ({ key, id: key.split('|')[1], name, host: 'local', engine: 'claude', lane: 'wait', kind: 'session', since: '2026-10-20T12:00:00Z', answer: 'keys', hash, keys: ['1', '2', 'Enter', 'Escape'], dialog: { question: `${name} asks`, options: [{ n: 1, label: 'Yes', selected: true }, { n: 2, label: 'No' }] }, ...extra });
const A = wait('local|a', 'agent-a', 'hash-a');
const B = wait('local|b', 'agent-b', 'hash-b', { since: '2026-10-20T12:05:00Z' });
const ch = (c) => ({ id: c, ch: c, name: c });

function stubApp(strips) {
  const app = {
    board: { strips, hosts: [], totals: {}, manager: { up: true } }, frontHost: 'fakehost', popup: null, caps: {}, opts: {},
    answers: [], toasts: [], opened: [],
    answer(strip, key) { app.answers.push({ id: strip.id, name: strip.name, key, hash: strip.hash }); },
    toast(text) { app.toasts.push(text); }, invalidate() {}, history: () => [], saveHistory() {}, refreshBoardSoon() {},
    openStrip(s) { app.opened.push(s.key); }, replyTo() {}, go() {}, help() {},
    client: { call: async () => ({}), follow: async () => true },
  };
  return app;
}

test('manager: a read made before the board named the manager\'s host is read again from that host, once', async () => {
  const app = stubApp([]);
  app.board.manager = null;   // no board yet; this front daemon has no manager of its own
  const calls = [];
  let release;
  app.client.call = async (op, args) => {
    calls.push(args.host ?? 'local');
    if (args.host) return { turns: [{ id: 't1', role: 'assistant', text: 'From the manager on its own host.', thread: 'main' }] };
    await new Promise((r) => { release = r; });   // the first read is still out when the board arrives
    throw new Error('session not found');
  };
  const m = new ManagerView(app);
  const first = m.load();
  app.board.manager = { up: true, host: 'box-b' };
  assert.equal(m.onBoard(), undefined, 'not while a read is out');
  release(); await first;
  await new Promise((r) => setTimeout(r, 10));   // the read the finished one queued for the new host
  assert.deepEqual(calls, ['local', 'box-b']);
  assert.equal(m.loaded, true); assert.equal(m.error, null);
  assert.ok(m.convo.turns.some((t) => t.text === 'From the manager on its own host.'));
  await m.onBoard();
  assert.deepEqual(calls, ['local', 'box-b'], 'the same host again: no further read');
  app.board.manager = { up: true, host: 'devbox' };
  await m.onBoard();
  assert.deepEqual(calls, ['local', 'box-b', 'devbox'], 'the manager moved: read where it is now');
});

test('manager: w picks the strip the frame showed, by key; a newer strip sorting first changes nothing', () => {
  const app = stubApp([A]);
  const m = new ManagerView(app);
  m.render(120, 30);
  m.key({ id: 'escape' });
  m.key(ch('w'));
  m.render(120, 30);
  app.board.strips = [B, A];          // a newer waiting strip arrives and sorts first, before the next frame
  m.key(ch('1'));
  assert.deepEqual(app.answers, [{ id: 'a', name: 'agent-a', key: '1', hash: 'hash-a' }]);
  m.render(120, 30);
  m.key(ch('2'));
  assert.equal(app.answers.at(-1).name, 'agent-a', 'still the one the owner picked, wherever it sorts');
});

test('manager: when the picked strip leaves the lane nothing is pressed, and never another strip', () => {
  const app = stubApp([A, B]);
  const m = new ManagerView(app);
  m.render(120, 30); m.key({ id: 'escape' }); m.key(ch('w')); m.render(120, 30);
  app.board.strips = [B];             // A was answered elsewhere
  m.key(ch('1'));
  m.render(120, 30);
  m.key({ id: 'enter' });
  assert.deepEqual(app.answers, []);
  assert.match(app.toasts.at(-1), /no longer waiting; nothing was pressed/);
  assert.ok(m.render(120, 30).some((r) => r.map(([t]) => t).join('').includes('the strip you picked is no longer waiting')));
  m.key({ id: 'right' }); m.render(120, 30);
  m.key(ch('1'));
  assert.deepEqual(app.answers, [{ id: 'b', name: 'agent-b', key: '1', hash: 'hash-b' }], 'picking another is explicit');
});

test('manager: a dialog that changed after the last frame is pressed with the hash that was drawn (the daemon refuses)', () => {
  const app = stubApp([A]);
  const m = new ManagerView(app);
  m.render(120, 30); m.key({ id: 'escape' }); m.key(ch('w')); m.render(120, 30);
  app.board.strips = [{ ...A, hash: 'hash-a2', dialog: { question: 'something else', options: [{ n: 1, label: 'Delete' }, { n: 2, label: 'Keep' }] } }];
  m.key(ch('1'));
  assert.equal(app.answers[0].hash, 'hash-a', 'what the owner saw, not what arrived after');
});

test('board: answers carry the drawn hash; a selection not drawn yet presses nothing', () => {
  const app = stubApp([A, B]);
  const b = new BoardView(app);
  b.show();
  b.render(120, 30);
  b.key(ch('1'));
  assert.deepEqual(app.answers, [], 'nothing selected: a digit is not an answer');
  b.key(ch('j')); b.render(120, 30);
  const first = app.board.strips.find((s) => s.key === b.selKey);
  app.board.strips = app.board.strips.map((s) => ({ ...s, hash: `${s.hash}-new` }));
  b.key(ch('1'));
  assert.deepEqual(app.answers.at(-1), { id: first.id, name: first.name, key: '1', hash: first.hash });
  b.key(ch('j'));                     // moved, and no frame drew the new selection yet
  b.key(ch('2'));
  assert.equal(app.answers.length, 1);
  assert.match(app.toasts.at(-1), /screen changed before that key/);
});

test('session view: its strip is on its own host, by session first, by window only there', () => {
  const L = wait('local|L', 'local-one', 'hash-l', { id: 'L', sessionId: 'L', tmux: 'work:1' });
  const R = wait('devbox|R', 'remote-one', 'hash-r', { id: 'R', sessionId: 'R', host: 'devbox', tmux: 'work:1' });
  const app = stubApp([L, R]);
  assert.equal(new SessionView(app, { kind: 'window', id: 'work:1', host: 'devbox' }).strip(), R, 'the same work:1 on another host is not this one');
  assert.equal(new SessionView(app, { kind: 'window', id: 'work:1', host: 'local' }).strip(), L);
  assert.equal(new SessionView(app, { kind: 'window', id: 'work:1', host: 'fakehost' }).strip(), L, 'this machine by its name is local');
  assert.equal(new SessionView(app, { kind: 'session', id: 'R', host: 'devbox', tmux: 'work:@9.%9' }).strip(), R);
  assert.equal(new SessionView(app, { kind: 'window', id: 'work:1', host: 'box-b' }).strip(), null, 'no strip on that host: no answer card');
  const W = wait('local|W', 'window-strip', 'hash-w', { id: 'work:1', kind: 'window', tmux: 'work:1' });
  const S = wait('local|S', 'session-strip', 'hash-s', { id: 'S', sessionId: 'S', tmux: 'work:2' });
  assert.equal(new SessionView(stubApp([W, S]), { kind: 'session', id: 'S', host: 'local', tmux: 'work:1' }).strip(), S, 'the session itself before a window match');
});

test('session view: the answer card presses what was drawn', () => {
  const R = wait('devbox|R', 'remote-one', 'hash-r', { id: 'R', sessionId: 'R', host: 'devbox', tmux: 'work:1' });
  const app = stubApp([R]);
  const v = new SessionView(app, { kind: 'session', id: 'R', host: 'devbox' });
  v.render(120, 30);
  v.key(ch('a')); v.render(120, 30);
  app.board.strips = [{ ...R, hash: 'hash-r2' }];
  v.key(ch('2'));
  assert.deepEqual(app.answers, [{ id: 'R', name: 'remote-one', key: '2', hash: 'hash-r' }]);
});

test('session view: tool-only turns with no id and no time (Codex thread/read) stay one per call', () => {
  const v = new SessionView(stubApp([]), { kind: 'session', id: 'S', host: 'local' });
  const call = (id, command) => ({ role: 'assistant', text: '', tools: [{ id, name: 'commandExecution', summary: command }] });
  const out = (id, text) => ({ role: 'tool_result', text, results: [{ toolUseId: id, text }] });
  for (const t of [call('i1', 'npm test'), out('i1', 'ok'), call('i2', 'git status'), out('i2', 'clean'), call('i1', 'npm test')]) v.take(t);
  assert.deepEqual(v.turns.map((t) => t.tools?.[0]?.summary ?? t.text), ['npm test', 'ok', 'git status', 'clean'], 'both calls, each output, a repeat once');
});

test('session view: a long-running view keeps the newest turns and forgets the ids of the rest', () => {
  const app = stubApp([]);
  const v = new SessionView(app, { kind: 'session', id: 'S', host: 'local' });
  v.limit = 100;
  const turn = (i) => ({ id: 'S', turn: { role: 'assistant', uuid: `u${i}`, ts: i, text: `t${i}`, tools: [] } });
  for (let i = 0; i < 2000; i++) v.onEvent('turn', turn(i));
  assert.equal(v.turns.length, 100 + KEEP_EXTRA);
  assert.equal(v.seen.size, v.turns.length);
  assert.equal(v.turns[0].uuid, `u${2000 - 100 - KEEP_EXTRA}`);
  v.onEvent('turn', turn(1999));
  assert.equal(v.turns.length, 100 + KEEP_EXTRA, 'a repeat is still a repeat');
  v.follow = false;                   // scrolled up: what the owner reads stays
  for (let i = 2000; i < 2100; i++) v.onEvent('turn', turn(i));
  assert.equal(v.turns.length, 100 + KEEP_EXTRA + 100);
  v.follow = true; v.onEvent('turn', turn(2100));
  assert.equal(v.turns.length, 100 + KEEP_EXTRA);
});

test('memory table: a daemon with no default repo refuses a list that names none, so the table shows every repo', async () => {
  const { TABLES } = await import('../tui/views/tables.js');
  const def = TABLES.find((t) => t.id === 'memory');
  const calls = [];
  const items = [{ id: 'r1', kind: 'gotcha', status: 'open', repo: 'billing', title: 'x' }];
  const app = { client: { call: async (op, args) => { calls.push(args); if (!args.all) throw new Error('repo is required (or set DROVER_DEFAULT_REPO)'); return { items }; } } };
  const v = { state: { ...def.state }, visible: () => items };
  assert.deepEqual(await def.load(app, v), { items });
  assert.deepEqual(calls.map((a) => a.all ?? false), [false, true], 'asked for the default repo once, then for every repo');
  assert.equal(v.state.all, true);
  assert.equal(def.meta({ items }, v), '1 open reflections in every repo');
  // With a default repo the first answer stands and the header names the repo its items come from.
  const named = { state: { ...def.state }, visible: () => items };
  const once = { client: { call: async () => ({ items }) } };
  await def.load(once, named);
  assert.equal(def.meta({ items }, named), '1 open reflections in billing');
  // Any other failure is the table's error, as before.
  const down = { client: { call: async () => { throw new Error('the daemon at x is not answering'); } } };
  await assert.rejects(def.load(down, { state: { ...def.state } }), /not answering/);
});
