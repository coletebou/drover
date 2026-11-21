// Hover in the TUI: motion reports (mode 1003, no button) decode as 'move'; the row, strip, tab, sub-tab, key hint or
// palette entry under the pointer is drawn in a hover style and previewed in the bottom bar; a move that changes
// nothing draws nothing; and hovering never selects, so it can never arm an answer key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecoder, mouseEvent } from '../tui/keys.js';
import { TableView } from '../tui/views/table.js';
import { BoardView } from '../tui/views/board.js';
import { Palette } from '../tui/views/overlays.js';
import { App } from '../tui/app.js';
import { rowText, renderRow } from '../tui/screen.js';
import { resolve, sgr, hoverOf } from '../tui/style.js';
import { Terminal, MOUSE_ON, MOUSE_OFF, osc52 } from '../tui/term.js';

const move = (x, y) => ({ name: 'mouse', id: 'mouse', kind: 'move', button: null, x, y });
const text = (rows) => rows.map((r) => rowText(r));
const find = (rows, needle) => { const t = text(rows); const y = t.findIndex((r) => r.includes(needle)); assert.ok(y >= 0, `${needle} not drawn:\n${t.join('\n')}`); return { x: t[y].indexOf(needle), y }; };
const bgOf = (row) => (row && !Array.isArray(row) ? row.bg : null);

function stubApp(strips = []) {
  const app = {
    board: { strips, hosts: [], totals: {}, manager: { up: true } }, frontHost: 'fakehost', popup: null, caps: {}, opts: {}, host: 'local', agentSel: null,
    answers: [], toasts: [], opened: [],
    answer(strip, key) { app.answers.push({ id: strip.id, key }); }, selectAgent(k) { app.agentSel = k; },
    toast(t) { app.toasts.push(t); }, invalidate() {}, refreshBoardSoon() {}, openStrip(s) { app.opened.push(s.key); }, replyTo() {}, hostLabel: (h) => h, cycleHost() {},
    client: { call: async () => ({}) },
  };
  return app;
}

test('motion with no button is a move; with a button held it is still a drag', () => {
  const d = createDecoder();
  const [mv, drag, rdrag, shifted, click] = d.feed('\x1b[<35;10;5M\x1b[<32;11;5M\x1b[<34;12;5M\x1b[<39;3;4M\x1b[<0;1;1M');
  assert.deepEqual([mv.kind, mv.button, mv.x, mv.y], ['move', null, 9, 4]);
  assert.deepEqual([drag.kind, drag.button], ['drag', 0]);
  assert.deepEqual([rdrag.kind, rdrag.button], ['drag', 2]);
  assert.deepEqual([shifted.kind, shifted.shift], ['move', true], 'modifiers ride along');
  assert.equal(click.kind, 'down');
  assert.equal(mouseEvent('<35;0;1', 'M'), null, 'a zero column is still malformed');
  assert.equal(mouseEvent('<67;1;1', 'M'), null, 'a sideways wheel is still dropped');
});

test('the terminal turns motion tracking on with the mouse and off with it, on every way out', () => {
  assert.ok(MOUSE_ON.includes('\x1b[?1003h') && MOUSE_ON.includes('\x1b[?1006h') && MOUSE_ON.includes('\x1b[?1000h'));
  assert.ok(MOUSE_OFF.includes('\x1b[?1003l') && MOUSE_OFF.includes('\x1b[?1006l') && MOUSE_OFF.includes('\x1b[?1000l'));
  const out = []; const input = { isTTY: true, setRawMode() {}, on() {}, off() {}, resume() {}, pause() {} };
  const output = { isTTY: true, columns: 80, rows: 24, write: (s) => out.push(s), on() {}, off() {} };
  const t = new Terminal({ input, output });
  t.start(); t.setMouse(false);
  assert.equal(out.at(-1), MOUSE_OFF, 'setMouse(false)');
  t.setMouse(true); t.stop();
  assert.ok(out.at(-1).startsWith(MOUSE_OFF), 'stop (quit, a signal, a crash, Ctrl-Z) turns motion off too');
});

test('the hover style is its own: unlike the selection at every depth, underlined where colour cannot show it', () => {
  for (const depth of [24, 8, 4]) assert.notEqual(sgr(resolve('hover', depth), depth), sgr(resolve('sel', depth), depth), `depth ${depth}`);
  assert.ok(resolve('hover', 24).fg && resolve('hover', 24).bg, 'its own foreground: readable on a light terminal too');
  assert.equal(resolve('hover', 4).underline, true, '16 colours: the band maps to black, so it underlines');
  assert.deepEqual(resolve('hover', 0), { underline: true }, 'no colour: underline');
  assert.notEqual(sgr(resolve('hover', 0), 0), sgr(resolve('sel', 0), 0));
  assert.equal(hoverOf('barKey'), 'barKeyHover'); assert.equal(hoverOf('tab'), 'tabHover'); assert.equal(hoverOf('sub'), 'subHover'); assert.equal(hoverOf('dim'), 'hover');
  assert.match(renderRow({ segs: [['row']], bg: 'hover' }, 10, 24), /48;2;38;44;52/);
});

test('tables: the pointer over a row tints it and previews it; it selects nothing; the same row again draws nothing', () => {
  const app = stubApp();
  const entered = [];
  const def = { id: 't', title: 'Things', load: async () => null, rows: () => [], columns: [{ title: 'name', flex: 1, get: (r) => r.name }], enter: (r) => entered.push(r), preview: (r) => `about ${r.name}` };
  const v = new TableView(app, def);
  v.rowsAll = Array.from({ length: 20 }, (_, i) => ({ name: `row-${i}` })); v.data = {};
  let rows = v.render(100, 20);
  const at = find(rows, 'row-4');
  assert.equal(v.mouse(move(at.x, at.y)), true, 'what is hovered changed');
  assert.equal(v.mouse(move(at.x + 3, at.y)), false, 'the same row: nothing to draw');
  rows = v.render(100, 20);
  assert.equal(bgOf(rows[at.y]), 'hover');
  assert.equal(bgOf(rows[find(rows, 'row-0').y]), 'sel', 'the selection keeps its own band');
  assert.equal(v.sel, 0, 'hover selects nothing'); assert.deepEqual(entered, []);
  assert.equal(v.hoverPreview(), 'about row-4');
  assert.equal(v.mouse(move(at.x, 1)), true, 'off the rows');
  assert.equal(v.hoverPreview(), null);
  assert.ok(!v.render(100, 20).some((r) => bgOf(r) === 'hover'));
});

test('board: the pointer over a strip tints it and previews its last line; a digit after hovering answers nothing', () => {
  const A = { key: 'local|a', id: 'a', name: 'agent-a', host: 'local', engine: 'claude', lane: 'wait', kind: 'session', since: '2026-10-20T12:00:00Z', answer: 'keys', hash: 'h', keys: ['1', '2', 'Enter', 'Escape'], dialog: { question: 'run the tests?', options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }] }, tail: ['Bash(npm test)'] };
  const app = stubApp([A]);
  const b = new BoardView(app);
  b.show();
  let rows = b.render(100, 20);
  const at = find(rows, 'agent-a');
  assert.equal(b.mouse(move(at.x, at.y)), true);
  assert.equal(b.mouse(move(at.x + 1, at.y)), false);
  rows = b.render(100, 20);
  assert.equal(bgOf(rows[at.y]), 'hover');
  assert.equal(app.agentSel, null, 'hover is not a selection');
  assert.match(b.hoverPreview(), /agent-a: run the tests\?/);
  b.key({ id: '1', ch: '1', name: '1' });
  assert.deepEqual(app.answers, [], 'so it never arms an answer key');
});

test('palette: the pointer over an entry tints it; only a click runs it', () => {
  let ran = 0;
  const app = { closeModal() {} };
  const p = new Palette(app, [{ label: 'Go to Agents', run: () => ran++ }, { label: 'Go to Fleet', run: () => ran++ }]);
  const frame = Array.from({ length: 30 }, () => []);
  p.overlay(frame, 120, 30);
  const at = find(frame, 'Go to Fleet');
  assert.equal(p.mouse(move(at.x, at.y)), true);
  p.overlay(frame, 120, 30);
  assert.ok(frame[at.y].some((seg) => seg[2] === 'hover'), 'the entry is drawn on the hover tint');
  assert.equal(ran, 0); assert.equal(p.sel, 0, 'the keyboard choice stays');
});

function fakeApp({ cols = 160, rows = 45 } = {}) {
  const term = { active: true, mouse: true, size: () => ({ cols, rows }), write() {}, stop() {}, setMouse(on) { this.mouse = on; } };
  const client = { base: { host: '127.0.0.1:7337' }, call: async () => ({ strips: [], hosts: [], totals: {} }), stream: () => ({ close() {} }), close() {}, follow: async () => true };
  const app = new App({ client, term, env: { TERM: 'xterm-256color' }, stateDir: '/nonexistent-drover-test' });
  app.start();
  let invalidations = 0; const inv = app.invalidate.bind(app); app.invalidate = () => { invalidations++; inv(); };
  const frame = () => { let f; const d = app.screen.draw.bind(app.screen); app.screen.draw = (x, o) => { f = x; return d(x, o); }; app.draw(); app.screen.draw = d; return f; };
  return { app, frame, count: () => invalidations, stop: () => { clearInterval(app.boardTimer); clearTimeout(app.boardSoon); app.stream?.close(); for (const v of app.views.values()) v.hide?.(); } };
}

test('app: tabs, sub-tabs and key hints under the pointer are drawn in their hover style; moves that change nothing draw nothing', () => {
  const f = fakeApp();
  try {
    f.app.go('agents/lanes');
    let fr = f.frame();
    const tab = rowText(fr[0]).indexOf('3 Prompts');
    const before = f.count();
    f.app.mouse(move(tab + 1, 0));
    assert.equal(f.count(), before + 1, 'onto a tab: one redraw');
    f.app.mouse(move(tab + 2, 0)); f.app.mouse(move(tab + 3, 0));
    assert.equal(f.count(), before + 1, 'along the same tab: none');
    fr = f.frame();
    assert.ok(fr[0].segs.some(([t, st]) => t === ' 3 Prompts ' && st === 'tabHover'));
    assert.equal(f.app.where(), 'agents/lanes', 'hovering a tab goes nowhere');
    f.app.mouse(move(rowText(fr[1]).indexOf('Wall') + 1, 1));
    fr = f.frame();
    assert.ok(fr[1].some(([t, st]) => t === ' Wall ' && st === 'subHover'));
    const foot = rowText(fr.at(-1)); const slash = foot.indexOf('/ filter');
    f.app.mouse(move(slash, 44));
    fr = f.frame();
    const segs = fr.at(-1).segs;
    assert.ok(segs.some(([t, st]) => t === '/' && st === 'barKeyHover') && segs.some(([t, st]) => t === ' filter' && st === 'barHover'), 'the whole hint, key and words');
    assert.ok(!segs.some(([t, st]) => t === 'R' && st === 'barKeyHover'), 'only that hint');
    f.app.mouse(move(5, 20));
    fr = f.frame();
    assert.ok(!fr.at(-1).segs.some(([, st]) => /Hover$/.test(st ?? '')), 'off the bar: nothing hovered there');
    assert.equal(f.app.hover.y, 20);
  } finally { f.stop(); }
});

test('app: a hovered row\'s preview sits on the right of the bottom bar while no toast does', () => {
  const f = fakeApp();
  try {
    f.app.go('find/events');
    const v = f.app.views.get('events');
    v.rowsAll = [{ id: 'e1', ts: '2026-11-21T12:00:00Z', type: 'note', actor: 'owner', about: 'demo', text: 'a synthetic note' }]; v.data = [];
    let fr = f.frame();
    const at = find(fr, 'a synthetic note');
    f.app.toastMsg = null;
    f.app.mouse(move(at.x, at.y));
    fr = f.frame();
    assert.match(rowText(fr.at(-1)), /demo: a synthetic note\s*$/);
    f.app.toast('something happened', 'ok');
    fr = f.frame();
    assert.match(rowText(fr.at(-1)), /something happened/, 'a toast wins');
  } finally { f.stop(); }
});

test('OSC 52: the clipboard sequence, wrapped for tmux passthrough, cut past the cap on a character boundary', () => {
  assert.equal(osc52('hi').seq, '\x1b]52;c;aGk=\x07');
  const t = osc52('hi', { tmux: true }).seq;
  assert.ok(t.startsWith('\x1bPtmux;\x1b\x1b]52;c;aGk=\x07\x1b\\'), 'the DCS passthrough form, inner ESC doubled');
  assert.ok(t.endsWith('\x1b]52;c;aGk=\x07'), 'and the bare form for tmux set-clipboard');
  const big = osc52('é'.repeat(100), { max: 40 });
  assert.equal(big.truncated, true);
  assert.equal(Buffer.from(big.seq.slice(7, -1), 'base64').toString('utf8'), 'é'.repeat(15), 'whole characters only');
});
