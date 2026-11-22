// Agents › Wall: the tile grid at several sizes, tiles drawn to exact widths with the pane's colours and without the
// agent's own furniture (prose wrapped to the tile, never cut), the scopes (Active, Live, All) and the filter, one
// tmux.captureMany per host for the tiles on screen only (none while another view is in front), the last reply of an
// agent with no pane, a failed capture kept and marked stale, the plain fallback on an older daemon, zoom, open, the
// shared selection, and hover.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WallView, wallLayout, tileRows, lineSegs, wrapRuns, contentRows, DENSITIES, COMFORT } from '../tui/views/wall.js';
import { startFakeDaemon } from '../tui/test-support/fake-daemon.js';
import { Client } from '../tui/client.js';
import { rowText, rowWidth } from '../tui/screen.js';
import { parseAnsi } from '../ui/ansi.js';
import { THEME } from '../tui/style.js';

const HOUR = 3600_000;
const strip = (host, id, lane = 'work', extra = {}) => ({ key: `${host}|${id}`, id, sessionId: id, name: `agent-${id}`, host, engine: 'claude', lane, kind: 'session', tmux: `w:${id}`, cwd: '~/code/demo', since: new Date(Date.now() - HOUR).toISOString(), ...extra });
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

test('layout: the sparsest grid that shows every tile while tiles stay comfortable, else the densest comfortable one; + and - step', () => {
  assert.deepEqual(wallLayout(160, 41, 3), { cols: 2, rows: 2, density: 2, w: 79, h: 20 });
  assert.deepEqual(wallLayout(160, 41, 1), { cols: 1, rows: 1, density: 0, w: 160, h: 41 });
  assert.deepEqual(wallLayout(90, 26, 3), { cols: 2, rows: 2, density: 2, w: 44, h: 13 });
  // Too many to show at once: tiles stay wide enough to read (the rest scroll), where 6x5 gave 25 columns a tile.
  assert.deepEqual(wallLayout(160, 41, 30), { cols: 4, rows: 4, density: 6, w: 39, h: 10 }, '30 agents: 4x4, not 6x5');
  assert.deepEqual(wallLayout(200, 44, 130), { cols: 5, rows: 4, density: 7, w: 39, h: 11 });
  for (const [w, h, n] of [[160, 41, 30], [200, 44, 130], [120, 30, 50]]) { const L = wallLayout(w, h, n); assert.ok(L.w >= COMFORT.w && L.h >= COMFORT.h, `${w}x${h}: ${L.w}x${L.h}`); }
  assert.deepEqual(wallLayout(60, 20, 12), { cols: 1, rows: 1, density: 0, w: 60, h: 20 }, 'a narrow view: one readable tile, not nine of 19 columns');
  assert.deepEqual(wallLayout(30, 9, 12), { cols: 1, rows: 1, density: 0, w: 30, h: 9 }, 'too small for a comfortable tile: the densest that keeps the minimum');
  assert.deepEqual(wallLayout(160, 41, 3, 0), { cols: 1, rows: 1, density: 0, w: 160, h: 41 }, 'a density the owner picked');
  assert.deepEqual(wallLayout(160, 41, 30, 8), { cols: 6, rows: 5, density: 8, w: 25, h: 8 }, '+ still goes to 6x5');
  assert.equal(wallLayout(160, 41, 3, 99).density, DENSITIES.length - 1);
  assert.deepEqual(DENSITIES[0], [1, 1]); assert.deepEqual(DENSITIES.at(-1), [6, 5]);
});

test('a tile: exact width on every row, the lane colour on its border, a heavy border when selected, the pane in colour from the top', () => {
  const s = strip('local', 'x', 'wait', { dialog: { question: 'run it?' } });
  const cap = { lines: parseAnsi('plain\n\x1b[1;31mred bold\x1b[0m and \x1b[38;5;208morange\x1b[0m\n'), stale: false };
  for (const [w, h] of [[40, 8], [19, 4], [79, 20]]) {
    const rows = tileRows(s, cap, w, h, { hostLabel: () => 'fakehost' });
    assert.equal(rows.length, h);
    for (const r of rows) assert.equal(rowWidth(r), w, `${w}x${h}: ${rowText(r)}`);
  }
  const rows = tileRows(s, cap, 44, 8, { hostLabel: () => 'fakehost' });
  assert.match(rowText(rows[0]), /^╭ ● agent-x · fakehost · waiting \d+[smhd] ─+╮$/, 'the state is spelled out before the age');
  assert.equal(rows[0][0][1].fg, THEME.wait.fg, 'the waiting lane\'s colour');
  assert.match(rowText(rows.at(-1)), /^╰─ run it\? ─+╯$/, 'a waiting tile says what it asks');
  const red = rows.flat().find((seg) => seg[0] === 'red bold');
  assert.deepEqual(red[1], { fg: '#cd3131', bold: true }, 'SGR colours as style objects');
  assert.equal(rows.flat().find((seg) => seg[0] === 'orange')[1].fg, '#ff8700');
  assert.match(rowText(rows[1]), /│plain\s+│/); assert.match(rowText(rows[2]), /│red bold and orange\s+│/, 'what the pane says, from the top of the tile');
  // Narrow: the host goes first, then the state word; the name is the last thing cut.
  assert.match(rowText(tileRows(s, cap, 30, 8, { hostLabel: () => 'fakehost' })[0]), /^╭ ● agent-x · waiting \d+[smhd] ─+╮$/);
  assert.match(rowText(tileRows(s, cap, 19, 4, { hostLabel: () => 'fakehost' })[0]), /^╭ ● agent-x · \d+[smhd] ─*╮$/);
  const sel = tileRows(s, cap, 40, 8, { selected: true });
  assert.ok(rowText(sel[0]).startsWith('┏') && rowText(sel[1]).startsWith('┃'), 'selected: heavy border');
  const a = tileRows(s, cap, 40, 8, { pulse: false })[0][0][1]; const b = tileRows(s, cap, 40, 8, { pulse: true })[0][0][1];
  assert.notDeepEqual(a, b, 'a waiting tile\'s border pulses');
  const idle = strip('local', 'y', 'idle');
  assert.deepEqual(tileRows(idle, cap, 40, 8, { pulse: false })[0][0][1], tileRows(idle, cap, 40, 8, { pulse: true })[0][0][1], 'others do not');
  assert.equal(tileRows(idle, cap, 40, 8, { hovered: true })[0][0][1].bg, THEME.hover.bg, 'hovered: the hover tint on its border');
  assert.match(rowText(tileRows(idle, { ...cap, stale: true }, 40, 8)[0]), /stale/);
  assert.match(rowText(tileRows(idle, cap, 40, 8).at(-1)), /^╰─ claude · ~\/code\/demo ─+╯$/, 'the footer: the engine and where it works');
  assert.match(rowText(tileRows({ ...idle, cwd: '~/code/a-very-long-project-name/packages/app' }, cap, 40, 8).at(-1)), /^╰─ claude · ….*packages\/app ─+╯$/, 'a long path keeps its last folders');
  assert.match(rowText(tileRows({ ...idle, status: 'failed' }, cap, 44, 8)[0]), /· failed \d+[smhd] /, 'how a background session ended');
  assert.deepEqual(lineSegs([{ text: '漢字漢字', fg: '#ffffff' }], 5).map(([t]) => t), ['漢字', ' '], 'cut by display width, never half a wide character');
});

test('a tile reads as what the agent said: no input box, status line or mode line; prose wraps, never cut; c shows the raw pane', () => {
  const RULE = '─'.repeat(120);
  const pane = ['⏺ The combined branch is green again and the checks pass on every shard, so the only thing left is your review of the merge request.', '',
    '✻ Baked for 26s · done 4:40 AM', `${' '.repeat(80)}new task? /clear to save 261k tokens`, RULE, '❯ ', RULE,
    '  \x1b[48;5;208mbox:1a2b3c\x1b[0m app:main | model | 59%', '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n');
  const s = strip('local', 'p', 'idle', { screen: 'idle' });
  const cap = { lines: parseAnsi(pane), state: 'idle', stale: false };
  const text = tileRows(s, cap, 40, 12).map(rowText);
  const body = text.slice(1, -1).map((r) => r.slice(1, -1).trimEnd());
  assert.deepEqual(body.filter(Boolean), ['⏺ The combined branch is green again', '  and the checks pass on every shard,', '  so the only thing left is your', '  review of the merge request.', '✻ Baked for 26s · done 4:40 AM']);
  for (const r of text) assert.ok(!/bypass permissions|box:1a2b3c|❯|new task\?/.test(r), r);
  for (const r of tileRows(s, cap, 40, 12)) assert.equal(rowWidth(r), 40);
  // Six body rows, like the densest grids: still the agent's words, where the raw pane is all furniture.
  const small = tileRows(s, cap, 40, 6).map(rowText).join('\n');
  assert.match(small, /review of the merge request\./); assert.match(small, /Baked for 26s/);
  const raw = tileRows(s, cap, 40, 6, { raw: true }).map(rowText).join('\n');
  assert.match(raw, /bypass permissions on/); assert.ok(!/merge request/.test(raw), 'raw: the bottom of the pane as it is');
  // A dialog is what the pane asks: nothing is left out of it.
  const dialog = { lines: parseAnsi([' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel'].join('\n')), state: 'dialog' };
  const d = tileRows(strip('local', 'q', 'wait'), dialog, 40, 9).map(rowText).join('\n');
  assert.match(d, /Do you want to proceed\?/); assert.match(d, /❯ 1\. Yes/); assert.match(d, /Esc to cancel/);
  // Wrapping keeps colours and never splits a wide character; a rule or a table row is cut at the edge instead.
  const wrapped = wrapRuns(parseAnsi('  \x1b[32mgreen words that go on\x1b[0m and plain words after them')[0], 20, { hang: 2 });
  assert.deepEqual(wrapped.map((r) => r.map((x) => x.text).join('')), ['  green words that', '  go on and plain', '  words after them']);
  assert.equal(wrapped[1].find((x) => x.text === 'go on')?.fg, '#0dbc79');
  assert.deepEqual(wrapRuns([{ text: '漢字漢字漢字' }], 5).map((r) => r.map((x) => x.text).join('')), ['漢字', '漢字', '漢字']);
  assert.deepEqual(wrapRuns([{ text: 'short' }], 20).length, 1);
  const shaped = contentRows(parseAnsi(`${'─'.repeat(60)}\n│ name │ state │ a long cell that does not fit │`), 20, 8).map(rowText);
  assert.deepEqual(shaped, ['─'.repeat(20), '│ name │ state │ a l']);
  assert.deepEqual(contentRows(parseAnsi('a\n\n\nb'), 10, 2).map((r) => rowText(r).trim()), ['b'], 'the cut never starts on a blank row');
});

test('an agent with no pane: its last reply as Markdown, else the board\'s own lines, else why there is nothing', () => {
  const s = strip('local', 'n', 'idle', { tmux: null, tail: ['last words'] });
  const own = tileRows(s, null, 44, 8).map(rowText);
  assert.match(own[1], /│last words\s+│/, 'the strip\'s own lines');
  assert.match(own[2], /reading its last reply…/);
  assert.match(own.at(-1), /^╰─ claude · ~\/code\/demo · no pane ─+╯$/);
  const said = tileRows(s, null, 44, 8, { reply: { text: 'Done. The parser **keeps line numbers** now.\n\n- suite one passes\n- suite two passes' } });
  const t = said.map(rowText);
  assert.match(t[1], /│Done\. The parser keeps line numbers now\.\s+│/, 'Markdown is rendered, not shown as marks');
  assert.match(t[3], /│• suite one passes\s+│/);
  assert.equal(said.flat().find((seg) => seg[0] === 'keeps line numbers')?.[1], 'bold');
  for (const r of said) assert.equal(rowWidth(r), 44);
  assert.match(tileRows({ ...s, tail: [] }, null, 44, 8, { reply: { text: '' } }).map(rowText)[1], /no pane, and no reply on record/);
  assert.match(tileRows(strip('local', 'c'), null, 44, 8).map(rowText)[1], /capturing the pane…/);
  assert.match(tileRows(strip('local', 'c'), { lines: null, error: 'pane gone', stale: true }, 44, 8).map(rowText)[1], /could not capture: pane gone/);
});

test('captures: one tmux.captureMany per host, for the tiles on screen only, with escapes', async () => {
  const strips = [strip('local', 'a'), strip('local', 'b'), strip('local', 'n', 'work', { tmux: null }), strip('box-a', 'c'), strip('box-a', 'd'), strip('box-b', 'e')];
  const app = stub(strips);
  const v = new WallView(app); app.frontView = v;
  v.density = 3;   // 3x2: all six on screen
  v.render(160, 40);
  v.shown = true; await v.refresh();
  const captures = app.calls.filter(([op]) => op === 'tmux.captureMany');
  const byHost = Object.fromEntries(captures.map(([op, a]) => [a.host ?? 'local', { op, targets: a.targets, escapes: a.escapes }]));
  assert.equal(captures.length, 3, 'one call per host');
  assert.deepEqual(app.calls.filter(([op]) => op === 'sessions.lastReply').map(([, a]) => a), [{ id: 'n' }], 'the one without a pane is asked what it said last');
  assert.deepEqual(byHost.local, { op: 'tmux.captureMany', targets: ['w:a', 'w:b'], escapes: true }, 'a strip without a pane is not captured');
  assert.deepEqual(byHost['box-a'].targets, ['w:c', 'w:d']);
  assert.deepEqual(byHost['box-b'].targets, ['w:e']);
  const rows = v.render(160, 40);
  assert.ok(rows.flat().some((seg) => seg[0] === 'w:a ok' && seg[1]?.fg === '#0dbc79'), 'the capture drawn in its colour');
  app.calls.length = 0;
  v.density = 0; v.render(160, 40);   // 1x1: only the first tile on screen
  await v.refresh();
  assert.deepEqual(app.calls.map(([, a]) => a.targets), [['w:a']], 'only what is visible');
  assert.equal(app.calls[0][1].lines, 39 - 2 + 14, 'the tile\'s rows and what the furniture takes');
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

test('scopes and the filter: Active by default (old idle sessions and program runs are not tiles), f steps Live and All, / filters', () => {
  const old = new Date(Date.now() - 40 * 24 * HOUR).toISOString();
  const strips = [strip('local', 'ask', 'wait', { since: old }), strip('local', 'busy', 'work'), strip('local', 'helper', 'work', { tmux: null, entrypoint: 'sdk-cli' }),
    strip('local', 'fresh', 'idle'), strip('box-a', 'newer', 'idle', { since: new Date(Date.now() - 60_000).toISOString() }), strip('local', 'ancient', 'idle', { since: old, tmux: null, status: 'failed' }),
    strip('local', 'manager', 'idle', { engine: 'openclaw', tmux: null })];
  const app = stub(strips);
  const v = new WallView(app); app.frontView = v;
  const ids = () => v.strips().map((s) => s.id);
  assert.deepEqual(ids(), ['ask', 'busy', 'newer', 'fresh'], 'Active: waiting however old, working, idle within a day, the newest first');
  let head = rowText(v.render(160, 40)[0]);
  assert.match(head, /^ Wall {2}1 waiting · 2 working · 3 idle {3}Active 4 of 6 {3}2×2/, 'the board\'s counts, then what this scope shows of it');
  assert.match(rowText(v.hints()), /f show live/);
  v.key({ id: 'f' }); assert.equal(v.scope, 'live'); assert.deepEqual(ids(), ['ask', 'busy']);
  v.key({ id: 'f' }); assert.equal(v.scope, 'all'); assert.deepEqual(ids(), ['ask', 'busy', 'helper', 'newer', 'fresh', 'ancient'], 'All: every agent but the manager');
  assert.match(rowText(v.render(160, 40)[0]), /All 6 /);
  v.key({ id: 'F' }); assert.equal(v.scope, 'live', 'F steps back');
  v.key({ id: 'f' }); v.key({ id: 'f' }); assert.equal(v.scope, 'active', 'and round again');
  // The filter: typed after /, it narrows the tiles at once; Enter keeps it, Esc clears it.
  v.key({ id: '/' }); assert.equal(v.inputActive, true, 'typing: digits and q are text, not the app\'s keys');
  for (const ch of 'box-a') v.key({ id: ch, ch });
  assert.deepEqual(ids(), ['newer'], 'by host');
  assert.match(rowText(v.render(160, 40)[0]), /Active 1 of 6 {3}filter: box-a▍/);
  v.key({ id: 'enter' }); assert.equal(v.inputActive, false); assert.deepEqual(ids(), ['newer']);
  v.key({ id: 'escape' }); assert.equal(v.filter, ''); assert.equal(ids().length, 4);
  v.key({ id: '/' }); for (const ch of 'zzz') v.key({ id: ch, ch }); v.key({ id: 'enter' });
  assert.match(v.render(160, 40).map(rowText).join('\n'), /Nothing matches "zzz" in Active/);
  assert.equal(v.clearInput(), true); assert.equal(v.filter, '');
  // Nothing in the scope: the Wall says how to see more instead of an empty grid.
  const quiet = stub([strip('local', 'ancient', 'idle', { since: old })]);
  const w = new WallView(quiet); quiet.frontView = w;
  assert.match(w.render(160, 40).map(rowText).join('\n'), /Nothing is active right now: f shows more \(1 on the board\)/);
  // c: the panes as they are, furniture and all, and back.
  v.key({ id: 'c' }); assert.equal(v.raw, true); assert.match(rowText(v.render(160, 40)[0]), /raw panes/);
  assert.match(rowText(v.hints()), /c clean/);
  v.key({ id: 'c' }); assert.equal(v.raw, false);
  v.hide(); w.hide();
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
    assert.deepEqual(calls[0].args, { targets: ['work:1', 'work:2'], lines: 31, escapes: true });
    assert.deepEqual(daemon.callsOf('sessions.lastReply').map((c) => c.args), [{ id: 's-idle' }], 'demo-idle is asked what it said last');
    const rows = v.render(160, 40);
    assert.ok(rows.flat().some((seg) => seg[0] === '✓' && seg[1]?.fg === '#0dbc79' && seg[1]?.bold), 'the green tick of the pane');
    assert.match(rows.map(rowText).join('\n'), /✗ 1 failing: parser keeps line numbers/);
    assert.match(rows.map(rowText).join('\n'), /Done\. The parser keeps line numbers now, and the three suites pass\./, 'the reply of the one with no pane');
    v.key({ id: 'right' }); v.key({ id: 'enter' });
    assert.deepEqual(app.opened, ['local|s-build'], 'waiting first: demo-build');
    v.hide();
  } finally { client.close(); await daemon.close(); }
});
