// The mouse in the TUI against stub apps and a real App on a fake terminal: tabs, rows, key hints and composers are
// clicked, the wheel scrolls. Two things must hold however the mouse is used: the wheel never selects a strip (so a
// digit pressed later cannot answer a dialog nobody picked), and a dialog is answered only by a second click, on a
// strip already picked, with the hash the last frame drew.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManagerView } from '../tui/views/manager.js';
import { BoardView } from '../tui/views/board.js';
import { SessionView } from '../tui/views/session.js';
import { TableView } from '../tui/views/table.js';
import { Palette, Help, Prompt } from '../tui/views/overlays.js';
import { App, MAIN } from '../tui/app.js';
import { rowText } from '../tui/screen.js';
import { hintKey } from '../tui/ui.js';
import { Composer } from '../tui/composer.js';
import { Terminal, MOUSE_ON, MOUSE_OFF, mouseWanted } from '../tui/term.js';

const wait = (key, name, hash, extra = {}) => ({ key, id: key.split('|')[1], name, host: 'local', engine: 'claude', lane: 'wait', kind: 'session', since: '2026-10-20T12:00:00Z', answer: 'keys', hash, keys: ['1', '2', 'Enter', 'Escape'], dialog: { question: `${name} asks`, options: [{ n: 1, label: 'Yes', selected: true }, { n: 2, label: 'No' }] }, ...extra });
const idle = (key, name) => ({ key, id: key.split('|')[1], name, host: 'local', engine: 'claude', lane: 'idle', kind: 'session', since: '2026-10-20T11:00:00Z' });
const A = wait('local|a', 'agent-a', 'hash-a');
const click = (x, y) => ({ name: 'mouse', id: 'mouse', kind: 'down', button: 0, x, y });
const wheel = (dir, x = 5, y = 5) => ({ name: 'mouse', id: 'mouse', kind: 'wheel', wheel: dir, button: null, x, y });
const text = (rows) => rows.map((r) => rowText(r));
/** Column and row of the first `needle` in rendered rows. */
const find = (rows, needle) => { const t = text(rows); const y = t.findIndex((r) => r.includes(needle)); assert.ok(y >= 0, `${needle} not drawn:\n${t.join('\n')}`); return { x: t[y].indexOf(needle), y }; };

function stubApp(strips) {
  const app = {
    board: { strips, hosts: [], totals: {}, manager: { up: true } }, frontHost: 'fakehost', popup: null, caps: {}, opts: {}, host: 'local',
    answers: [], toasts: [], opened: [],
    answer(strip, key) { app.answers.push({ id: strip.id, key, hash: strip.hash }); },
    toast(t) { app.toasts.push(t); }, invalidate() {}, history: () => [], saveHistory() {}, refreshBoardSoon() {},
    openStrip(s) { app.opened.push(s.key); }, replyTo() {}, go() {}, help() {}, hostLabel: (h) => h, cycleHost() {},
    client: { call: async () => ({}), follow: async () => true },
  };
  return app;
}

test('footer hints name the key a click presses; ranges and groups name none', () => {
  assert.equal(hintKey('Enter').id, 'enter');
  assert.equal(hintKey('Esc').id, 'escape');
  assert.equal(hintKey('C-j').id, 'C-j');
  assert.equal(hintKey('/help').id, 'f1');
  assert.equal(hintKey('w').ch, 'w');
  assert.equal(hintKey('R').shift, true);
  for (const t of ['j/k', '1-9', '1-3', '←→', '↑↓', 'PgUp/PgDn', '[ ]', 'type', 'any key']) assert.equal(hintKey(t), null, t);
});

test('the composer puts its cursor where it was clicked', () => {
  const c = new Composer(); c.set('hello world\nsecond line');
  c.moveTo(0, 6, 40); assert.equal(c.cur, 6);
  c.moveTo(1, 3, 40); assert.equal(c.cur, 'hello world\n'.length + 3);
  c.moveTo(1, 99, 40); assert.equal(c.cur, c.value.length, 'past the end of a row: its end');
  c.moveTo(9, 0, 40); assert.equal(c.cur, 'hello world\n'.length, 'below the last row: the last row');
  c.set('漢字abc'); c.moveTo(0, 3, 40); assert.equal(c.cur, 1, 'a click inside a wide character lands before it');
});

test('manager: one click on an option picks the strip and presses nothing; a second click presses it with the drawn hash', () => {
  const app = stubApp([A]);
  const m = new ManagerView(app);
  let rows = m.render(120, 30);
  const yes = find(rows, '1 Yes');
  m.mouse(click(yes.x + 1, yes.y));
  assert.deepEqual(app.answers, [], 'the first click only picks it');
  assert.equal(m.focus, 'waiting'); assert.equal(m.waitKey, A.key);
  assert.match(app.toasts.at(-1), /click 1 again/);
  rows = m.render(120, 30);
  app.board.strips = [{ ...A, hash: 'hash-a2' }];   // the screen changed after that frame
  m.mouse(click(find(rows, '1 Yes').x + 1, yes.y));
  assert.deepEqual(app.answers, [{ id: 'a', key: '1', hash: 'hash-a' }], 'the hash the owner saw');
  rows = m.render(120, 30);
  const enter = find(rows, 'Enter');
  m.mouse(click(enter.x, enter.y));
  assert.equal(app.answers.at(-1).key, 'Enter', 'the key hints on the strip are buttons too');
});

test('manager: the wheel scrolls the conversation and never picks or answers; a click on the composer types there', () => {
  const app = stubApp([A]);
  const m = new ManagerView(app);
  m.convo.load(Array.from({ length: 40 }, (_, i) => ({ id: `t${i}`, role: i % 2 ? 'assistant' : 'user', text: `message ${i}`, thread: 'main' })));
  m.render(120, 30);
  m.mouse(wheel(-1)); m.render(120, 30);
  assert.equal(m.follow, false, 'scrolled up off the bottom');
  for (let i = 0; i < 100; i++) m.mouse(wheel(1));
  m.render(120, 30);
  assert.equal(m.follow, true, 'and back down to it');
  assert.deepEqual(app.answers, []); assert.equal(m.waitKey, null);
  m.focus = 'chat';
  m.composer.set('draft text');
  const rows = m.render(120, 30);
  const at = find(rows, 'draft text');
  m.mouse(click(at.x + 5, at.y));
  assert.equal(m.focus, 'input');
  assert.equal(m.composer.cur, 5, 'the cursor where the click was');
});

test('board: the wheel scrolls without selecting; a click selects (digits then answer it); a second click opens', () => {
  const strips = [A, ...Array.from({ length: 30 }, (_, i) => idle(`local|i${i}`, `idle-${i}`))];
  const app = stubApp(strips);
  const b = new BoardView(app);
  b.show();
  b.render(100, 20);
  b.mouse(wheel(1)); b.mouse(wheel(1)); b.render(100, 20);
  assert.equal(b.selKey, null, 'the wheel selects nothing');
  assert.equal(b.top, 6);
  b.key({ id: '1', ch: '1', name: '1' });
  assert.deepEqual(app.answers, [], 'so a digit after scrolling answers nothing');
  b.mouse(wheel(-1)); b.mouse(wheel(-1));
  let rows = b.render(100, 20);
  const at = find(rows, 'agent-a');
  b.mouse(click(at.x, at.y));
  assert.equal(b.selKey, A.key);
  assert.deepEqual(app.opened, [], 'one click selects');
  rows = b.render(100, 20);
  b.key({ id: '2', ch: '2', name: '2' });
  assert.deepEqual(app.answers, [{ id: 'a', key: '2', hash: 'hash-a' }], 'a strip picked by a click is picked');
  b.mouse(click(at.x, at.y));
  assert.deepEqual(app.opened, [A.key], 'the second click opens it');
  b.mouse(click(at.x, 1));
  assert.equal(b.selKey, A.key, 'a click on the head or a lane title changes nothing');
  b.mouse(wheel(1)); b.mouse(wheel(1)); b.mouse(wheel(1)); b.mouse(wheel(1));
  rows = b.render(100, 20);
  assert.ok(!text(rows).some((r) => r.includes('● agent-a')), 'scrolled, the selected row may leave the view (the details below still name it)');
  b.key({ id: 'j', ch: 'j', name: 'j' }); rows = b.render(100, 20);
  assert.ok(text(rows).some((r) => r.includes('idle-0')), 'a key brings the selection back into view');
});

test('tables: a click selects a row, a second click is Enter; the wheel scrolls and keeps the selection', () => {
  const app = stubApp([]);
  const entered = [];
  const def = { id: 't', title: 'Things', load: async () => null, rows: () => [], columns: [{ title: 'name', flex: 1, get: (r) => r.name }], enter: (r) => entered.push(r.name) };
  const v = new TableView(app, def);
  v.rowsAll = Array.from({ length: 50 }, (_, i) => ({ name: `row-${i}` })); v.data = {};
  let rows = v.render(100, 20);
  const r3 = find(rows, 'row-3');
  v.mouse(click(r3.x, r3.y));
  assert.equal(v.sel, 3); assert.deepEqual(entered, []);
  v.mouse(click(r3.x, r3.y));
  assert.deepEqual(entered, ['row-3']);
  v.mouse(wheel(1)); v.mouse(wheel(1)); rows = v.render(100, 20);
  assert.equal(v.sel, 3, 'the wheel moves no selection');
  assert.ok(text(rows).some((r) => r.includes('row-20')) && !text(rows).some((r) => r.includes('row-3 ')), 'it scrolls the rows');
  const r20 = find(rows, 'row-20');
  v.mouse(click(r20.x, r20.y));
  assert.equal(v.sel, 20, 'a click on a scrolled row selects that row');
  v.mouse(click(r20.x, 2)); assert.equal(v.sel, 20, 'the column header is not a row');
});

test('session view: a click on Screen or Info switches tabs; a click on a chat item selects it, again expands it', () => {
  const app = stubApp([]);
  const v = new SessionView(app, { kind: 'session', id: 's1', host: 'local', name: 'demo' });
  v.chatLoaded = true;
  v.turns = [
    { id: 'u1', role: 'user', text: 'run the tests', ts: '2026-10-20T12:00:00Z' },
    { id: 'a1', role: 'assistant', text: '', ts: '2026-10-20T12:00:01Z', tools: [{ id: 'c1', name: 'Bash', input: { command: 'npm test' } }] },
    { id: 'r1', role: 'tool_result', ts: '2026-10-20T12:00:02Z', results: [{ toolUseId: 'c1', isError: false, text: 'ok 1 passes' }] },
  ];
  let rows = v.render(120, 30);
  const tool = find(rows, 'Ran 1 command');
  v.mouse(click(tool.x, tool.y));
  assert.equal(v.items[v.sel]?.kind, 'tools');
  rows = v.render(120, 30);
  v.mouse(click(tool.x, tool.y));
  assert.equal(v.expanded.get(v.items[v.sel].key), 1, 'the second click expands the group');
  rows = v.render(120, 30);
  v.timers.push = () => 0;   // no capture loop in a unit test
  v.mouse(click(find(rows, 'Info').x, 1));
  assert.equal(v.tab, 'info');
  v.mouse(click(find(v.render(120, 30), 'Chat').x, 1));
  assert.equal(v.tab, 'chat');
  v.hide();
});

test('palette: a click runs an entry, the wheel moves the choice, a click outside closes it; a prompt ignores outside clicks', () => {
  const ran = []; let closed = 0;
  const app = { closeModal() { closed++; } };
  const p = new Palette(app, [{ label: 'Go to Board', run: () => ran.push('board') }, { label: 'Go to Fleet', run: () => ran.push('fleet') }]);
  const frame = Array.from({ length: 30 }, () => []);
  p.overlay(frame, 120, 30);
  const fleet = find(frame, 'Go to Fleet');
  p.mouse(wheel(1)); assert.equal(p.sel, 1);
  p.mouse(click(fleet.x, fleet.y));
  assert.deepEqual(ran, ['fleet']); assert.equal(closed, 1);
  p.overlay(frame, 120, 30);
  p.mouse(click(0, 29)); assert.equal(closed, 2, 'outside the box');
  const h = new Help(app, [['Everywhere', [['q', 'quit']]]]);
  h.overlay(Array.from({ length: 30 }, () => []), 120, 30);
  h.mouse(click(0, 0)); assert.equal(closed, 3);
  const q = new Prompt(app, { title: 'Reply', onSubmit() {} });
  q.input.set('half a reply');
  q.overlay(Array.from({ length: 30 }, () => []), 120, 30);
  assert.equal(q.mouse, undefined, 'a prompt takes no clicks, so a stray one cannot lose what is typed');
});

function fakeApp({ cols = 160, rows = 45 } = {}) {
  const writes = [];
  const term = { active: true, mouse: true, size: () => ({ cols, rows }), write: (s) => writes.push(s), stop() {}, setMouse(on) { this.mouse = on; } };
  const client = { base: { host: '127.0.0.1:7337' }, call: async () => ({ strips: [], hosts: [], totals: {} }), stream: () => ({ close() {} }), close() {}, follow: async () => true };
  const app = new App({ client, term, env: { TERM: 'xterm-256color' }, stateDir: '/nonexistent-drover-test' });
  app.start();
  const frames = [];
  const draw = app.screen.draw.bind(app.screen);
  app.screen.draw = (frame, o) => { frames.push(frame); return draw(frame, o); };
  return { app, term, frames, last: () => { app.draw(); return frames.at(-1); }, stop: () => { clearInterval(app.boardTimer); clearTimeout(app.boardSoon); app.stream?.close(); } };
}

test('app: a click on a tab goes there, on " drover " opens the palette, on a footer hint presses its key', () => {
  const f = fakeApp();
  try {
    let frame = f.last();
    const bar = rowText(frame[0]);
    f.app.mouse(click(bar.indexOf('2 Board'), 0));
    assert.equal(MAIN[f.app.cur], 'board');
    frame = f.last();
    f.app.mouse(click(rowText(frame[0]).indexOf('6 Events') + 2, 0));
    assert.equal(MAIN[f.app.cur], 'events');
    f.app.mouse(click(1, 0));
    assert.ok(f.app.modal instanceof Palette, 'the name opens the palette');
    f.app.mouse(click(0, 44));
    assert.equal(f.app.modal, null, 'a click outside closes it');
    f.app.go('manager');
    frame = f.last();
    const foot = rowText(frame.at(-1));
    f.app.mouse(click(foot.indexOf('Esc'), 44));
    assert.equal(f.app.views.get('manager').focus, 'chat', 'Esc, clicked, leaves the composer');
    frame = f.last();
    f.app.mouse(click(rowText(frame.at(-1)).indexOf('help'), 44));
    assert.ok(f.app.modal instanceof Help, 'a hint\'s words are part of its button');
    f.app.closeModal();
    f.app.mouse(click(rowText(f.last().at(-1)).indexOf('j/k'), 44));
    assert.equal(f.app.modal, null); assert.equal(MAIN[f.app.cur], 'manager', 'j/k names two keys: no button');
    f.app.mouse(wheel(1, 3, 0));
    assert.equal(MAIN[f.app.cur], 'manager', 'the wheel on the bar does nothing');
  } finally { f.stop(); }
});

test('app: the palette turns the mouse off and on', () => {
  const f = fakeApp();
  try {
    f.app.palette();
    const off = f.app.modal.items.find((it) => /^Mouse: off/.test(it.label));
    assert.ok(off); off.run();
    assert.equal(f.term.mouse, false);
    f.app.palette();
    assert.ok(f.app.modal.items.some((it) => /^Mouse: on/.test(it.label)));
  } finally { f.stop(); }
});

test('the terminal asks for clicks and the wheel (SGR) and gives them back on every way out', () => {
  const out = []; const input = { isTTY: true, setRawMode() {}, on() {}, off() {}, resume() {}, pause() {} };
  const output = { isTTY: true, columns: 80, rows: 24, write: (s) => out.push(s), on() {}, off() {} };
  const t = new Terminal({ input, output });
  t.start();
  assert.ok(out.join('').includes(MOUSE_ON) && MOUSE_ON === '\x1b[?1000h\x1b[?1006h', 'press, release and wheel in SGR; no motion tracking');
  t.setMouse(false); assert.ok(out.at(-1) === MOUSE_OFF);
  t.stop(); assert.ok(out.at(-1).startsWith(MOUSE_OFF));
  out.length = 0;
  new Terminal({ input, output, mouse: false }).start();
  assert.ok(!out.join('').includes(MOUSE_ON));
  assert.equal(mouseWanted({}), true);
  for (const v of ['0', 'off', 'no', 'FALSE']) assert.equal(mouseWanted({ DROVER_TUI_MOUSE: v }), false, v);
});
