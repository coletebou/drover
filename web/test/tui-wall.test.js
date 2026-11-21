// Agents › Wall: the tile grid at several sizes, tiles drawn to exact widths with the pane's colours, one
// tmux.captureMany per host for the tiles on screen only (none while another view is in front), a failed capture kept
// and marked stale, the plain fallback on an older daemon, zoom, open, the shared selection, and hover.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WallView, wallLayout, wallOrder, tileRows, lineSegs, DENSITIES } from '../tui/views/wall.js';
import { startFakeDaemon } from '../tui/test-support/fake-daemon.js';
import { Client } from '../tui/client.js';
import { rowText, rowWidth } from '../tui/screen.js';
import { parseAnsi } from '../ui/ansi.js';
import { THEME } from '../tui/style.js';

const strip = (host, id, lane = 'work', extra = {}) => ({ key: `${host}|${id}`, id, sessionId: id, name: `agent-${id}`, host, engine: 'claude', lane, kind: 'session', tmux: `w:${id}`, since: '2026-11-21T12:00:00Z', ...extra });
const click = (x, y) => ({ name: 'mouse', id: 'mouse', kind: 'down', button: 0, x, y });
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function stub(strips, { call } = {}) {
  const app = {
    board: { strips }, frontHost: 'fakehost', agentSel: null, opened: [], replied: [], calls: [], frontView: null,
    selectAgent(k) { app.agentSel = k; }, invalidate() {}, animate() {}, front: () => app.frontView,
    openStrip(s) { app.opened.push(s.key); }, replyTo(s) { app.replied.push(s.key); }, refreshBoardSoon() {},
    client: { call: call ?? (async (op, args) => { app.calls.push([op, args]); return { captures: (args.targets ?? []).map((target) => ({ target, ok: true, text: `\x1b[32m${target} ok\x1b[0m`, hash: target })) }; }) },
  };
  return app;
}

test('layout: the sparsest grid that shows every tile while tiles stay readable, else the densest that does; + and - step', () => {
  assert.deepEqual(wallLayout(160, 41, 3), { cols: 2, rows: 2, density: 2, w: 79, h: 20 });
  assert.deepEqual(wallLayout(160, 41, 1), { cols: 1, rows: 1, density: 0, w: 160, h: 41 });
  assert.deepEqual(wallLayout(90, 26, 3), { cols: 2, rows: 2, density: 2, w: 44, h: 13 });
  assert.deepEqual(wallLayout(160, 41, 30), { cols: 6, rows: 5, density: 8, w: 25, h: 8 }, '30 agents: 6x5');
  assert.deepEqual(wallLayout(60, 20, 12), { cols: 3, rows: 3, density: 4, w: 19, h: 6 }, 'too many for a small view: the densest that keeps tiles readable');
  assert.deepEqual(wallLayout(160, 41, 3, 0), { cols: 1, rows: 1, density: 0, w: 160, h: 41 }, 'a density the owner picked');
  assert.equal(wallLayout(160, 41, 3, 99).density, DENSITIES.length - 1);
  assert.deepEqual(DENSITIES[0], [1, 1]); assert.deepEqual(DENSITIES.at(-1), [6, 5]);
  assert.deepEqual(wallOrder([strip('l', 'c', 'idle'), strip('l', 'b', 'work'), strip('l', 'z', 'wait'), strip('l', 'a', 'wait')]).map((s) => s.id), ['a', 'z', 'b', 'c'], 'waiting first, then by name');
});

test('a tile: exact width on every row, the lane colour on its border, a heavy border when selected, the pane in colour', () => {
  const s = strip('local', 'x', 'wait', { dialog: { question: 'run it?' } });
  const cap = { lines: parseAnsi('plain\n\x1b[1;31mred bold\x1b[0m and \x1b[38;5;208morange\x1b[0m\n'), stale: false };
  for (const [w, h] of [[40, 8], [19, 4], [79, 20]]) {
    const rows = tileRows(s, cap, w, h, { hostLabel: () => 'fakehost' });
    assert.equal(rows.length, h);
    for (const r of rows) assert.equal(rowWidth(r), w, `${w}x${h}: ${rowText(r)}`);
  }
  const rows = tileRows(s, cap, 40, 8, { hostLabel: () => 'fakehost' });
  assert.match(rowText(rows[0]), /^╭ ● agent-x · fakehost · \d+[smhd] ─+╮$/);
  assert.equal(rows[0][0][1].fg, THEME.wait.fg, 'the waiting lane\'s colour');
  assert.match(rowText(rows.at(-1)), /^╰─ run it\? ─+╯$/, 'a waiting tile says what it asks');
  const red = rows.flat().find((seg) => seg[0] === 'red bold');
  assert.deepEqual(red[1], { fg: '#cd3131', bold: true }, 'SGR colours as style objects');
  assert.equal(rows.flat().find((seg) => seg[0] === 'orange')[1].fg, '#ff8700');
  assert.match(rowText(rows.at(-2)), /│red bold and orange\s+│/, 'the bottom of the pane, at the bottom of the tile');
  const sel = tileRows(s, cap, 40, 8, { selected: true });
  assert.ok(rowText(sel[0]).startsWith('┏') && rowText(sel[1]).startsWith('┃'), 'selected: heavy border');
  const a = tileRows(s, cap, 40, 8, { pulse: false })[0][0][1]; const b = tileRows(s, cap, 40, 8, { pulse: true })[0][0][1];
  assert.notDeepEqual(a, b, 'a waiting tile\'s border pulses');
  const idle = strip('local', 'y', 'idle');
  assert.deepEqual(tileRows(idle, cap, 40, 8, { pulse: false })[0][0][1], tileRows(idle, cap, 40, 8, { pulse: true })[0][0][1], 'others do not');
  assert.equal(tileRows(idle, cap, 40, 8, { hovered: true })[0][0][1].bg, THEME.hover.bg, 'hovered: the hover tint on its border');
  assert.match(rowText(tileRows(idle, { ...cap, stale: true }, 40, 8)[0]), /stale/);
  assert.match(rowText(tileRows({ ...idle, tmux: null, tail: ['last words'] }, null, 40, 8).at(-2)), /last words/, 'no pane: the strip\'s own lines');
  assert.deepEqual(lineSegs([{ text: '漢字漢字', fg: '#ffffff' }], 5).map(([t]) => t), ['漢字', ' '], 'cut by display width, never half a wide character');
});

test('captures: one tmux.captureMany per host, for the tiles on screen only, with escapes', async () => {
  const strips = [strip('local', 'a'), strip('local', 'b'), strip('local', 'n', 'work', { tmux: null }), strip('box-a', 'c'), strip('box-a', 'd'), strip('box-b', 'e')];
  const app = stub(strips);
  const v = new WallView(app); app.frontView = v;
  v.density = 3;   // 3x2: all six on screen
  v.render(160, 40);
  v.shown = true; await v.refresh();
  const byHost = Object.fromEntries(app.calls.map(([op, a]) => [a.host ?? 'local', { op, targets: a.targets, escapes: a.escapes }]));
  assert.equal(app.calls.length, 3, 'one call per host');
  assert.deepEqual(byHost.local, { op: 'tmux.captureMany', targets: ['w:a', 'w:b'], escapes: true }, 'a strip without a pane is not captured');
  assert.deepEqual(byHost['box-a'].targets, ['w:c', 'w:d']);
  assert.deepEqual(byHost['box-b'].targets, ['w:e']);
  const rows = v.render(160, 40);
  assert.ok(rows.flat().some((seg) => seg[0] === 'w:a ok' && seg[1]?.fg === '#0dbc79'), 'the capture drawn in its colour');
  app.calls.length = 0;
  v.density = 0; v.render(160, 40);   // 1x1: only the first tile on screen
  await v.refresh();
  assert.deepEqual(app.calls.map(([, a]) => a.targets), [['w:a']], 'only what is visible');
  app.calls.length = 0; app.frontView = { other: true };
  await v.refresh();
  assert.deepEqual(app.calls, [], 'paused while another view (a session, Lanes) is in front');
  v.hide();
});

test('a capture that fails keeps the last one, marked stale; an older daemon gets one plain tmux.capture per tile', async () => {
  let fail = false;
  const app = stub([strip('local', 'a')], { call: async (op, args) => { app.calls.push([op, args]); return { captures: args.targets.map((target) => (fail ? { target, ok: false, error: 'pane gone' } : { target, ok: true, text: 'line one\nline two' })) }; } });
  const v = new WallView(app); app.frontView = v; v.shown = true;
  v.render(100, 30); await v.refresh();
  fail = true; await v.refresh();
  const rows = v.render(100, 30).map(rowText);
  assert.match(rows[1], /stale/);
  assert.ok(rows.some((r) => r.includes('line two')), 'the last capture is still drawn');
  const calls = [];
  const old = stub([strip('local', 'a'), strip('local', 'b')], { call: async (op, args) => { calls.push(op); if (op === 'tmux.captureMany') { const e = new Error('unknown op tmux.captureMany'); e.unknownOp = true; throw e; } return { text: `plain ${args.target}` }; } });
  const w = new WallView(old); old.frontView = w; w.shown = true;
  w.render(100, 30); await w.refresh(); await w.refresh();
  assert.deepEqual(calls, ['tmux.captureMany', 'tmux.capture', 'tmux.capture', 'tmux.capture', 'tmux.capture'], 'asked once, then per tile');
  assert.ok(w.render(100, 30).map(rowText).some((r) => r.includes('plain w:b')));
  assert.match(rowText(w.render(100, 30)[0]), /no tmux\.captureMany/);
});

test('keys and clicks: move, select (shared), zoom with z or a second click, Esc unzooms, Enter opens, r replies, + and -', async () => {
  const strips = [strip('local', 'a', 'wait'), strip('local', 'b'), strip('local', 'c'), strip('local', 'd', 'idle')];
  const app = stub(strips);
  const v = new WallView(app); app.frontView = v;
  v.render(160, 40);   // 2x2
  v.key({ id: 'right' }); assert.equal(app.agentSel, 'local|a', 'the first move selects the first tile');
  v.key({ id: 'l' }); assert.equal(app.agentSel, 'local|b');
  v.key({ id: 'j' }); assert.equal(app.agentSel, 'local|d', 'down a row');
  v.key({ id: 'k' }); v.key({ id: 'h' }); assert.equal(app.agentSel, 'local|a');
  v.key({ id: 'enter' }); assert.deepEqual(app.opened, ['local|a']);
  v.key({ id: 'r' }); assert.deepEqual(app.replied, ['local|a']);
  v.key({ id: 'z' }); let rows = v.render(160, 40);
  assert.equal(v.zoomed, true);
  assert.match(rowText(rows[1]), /^┏ ● agent-a .*━┓$/); assert.equal(rowText(rows[1]).length, 160, 'zoomed: the whole width');
  assert.equal(v.placed.length, 1);
  assert.equal(v.key({ id: 'escape' }), true); assert.equal(v.zoomed, false);
  assert.equal(v.key({ id: 'escape' }), false, 'not zoomed: Esc is the app\'s');
  rows = v.render(160, 40);
  const t = v.placed.find((p) => p.strip.id === 'c');
  v.mouse(click(t.x + 2, t.y + 2)); assert.equal(app.agentSel, 'local|c', 'a click selects');
  assert.equal(v.zoomed, false);
  v.mouse(click(t.x + 2, t.y + 2)); assert.equal(v.zoomed, true, 'a second click zooms');
  v.render(160, 40);
  v.mouse(click(3, 3)); assert.equal(v.zoomed, false, 'a click on the zoomed tile unzooms it');
  v.key({ id: '-' }); assert.equal(v.density, 1); v.key({ id: '+' }); v.key({ id: '+' }); assert.equal(v.density, 3);
  v.ticks = 0; let n = 0; v.refresh = () => { n++; }; v.tick(); v.tick(); assert.equal(n, 1, 'every 2 s');
  v.zoomed = true; n = 0; v.tick(); v.tick(); assert.equal(n, 2, 'zoomed: every second');
  v.hide();
});

test('hover: a tile under the pointer is tinted and previewed; it selects nothing', () => {
  const app = stub([strip('local', 'a', 'work', { tail: ['compiling the parser'] }), strip('local', 'b')]);
  const v = new WallView(app); app.frontView = v;
  v.render(160, 40);
  const t = v.placed[0];
  assert.equal(v.mouse({ kind: 'move', x: t.x + 5, y: t.y + 3 }), true);
  assert.equal(v.mouse({ kind: 'move', x: t.x + 6, y: t.y + 3 }), false, 'the same tile: nothing to redraw');
  assert.equal(app.agentSel, null);
  assert.equal(v.render(160, 40)[t.y][0][1].bg, THEME.hover.bg);
  assert.match(v.hoverPreview(), /agent-a: compiling the parser/);
  assert.equal(v.mouse({ kind: 'move', x: 0, y: 0 }), true, 'off the tiles');
  assert.equal(v.hoverPreview(), null);
});

test('against the fake daemon: the board\'s tiles in one captureMany, drawn in colour; Enter opens the selected one', async () => {
  const daemon = await startFakeDaemon();
  const client = new Client({ url: daemon.url, token: daemon.token });
  try {
    const board = await client.call('native.board', {});
    const app = stub(board.strips); app.client = client;
    const v = new WallView(app); app.frontView = v;
    v.render(160, 40); v.shown = true; await v.refresh();
    const calls = daemon.callsOf('tmux.captureMany');
    assert.equal(calls.length, 1, 'one host, one call; demo-idle has no pane');
    assert.deepEqual(calls[0].args, { targets: ['work:1', 'work:2'], lines: 17, escapes: true });
    const rows = v.render(160, 40);
    assert.ok(rows.flat().some((seg) => seg[0] === '✓' && seg[1]?.fg === '#0dbc79' && seg[1]?.bold), 'the green tick of the pane');
    assert.match(rows.map(rowText).join('\n'), /✗ 1 failing: parser keeps line numbers/);
    v.key({ id: 'right' }); v.key({ id: 'enter' });
    assert.deepEqual(app.opened, ['local|s-build'], 'waiting first: demo-build');
    v.hide();
  } finally { client.close(); await daemon.close(); }
});
