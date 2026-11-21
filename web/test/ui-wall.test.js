// The Wall's pure half (ui/wall-model.js): tile order, density, the capture plan (one call per host, panes on
// screen only), keyboard movement, and how a parsed pane run is styled (validated colors only). Synthetic strips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wallTiles, densityGrid, capturePlan, moveIndex, runStyle, fitLines, tailText, CAPTURE_MAX } from '../ui/wall-model.js';
import { parseAnsi } from '../ui/ansi.js';

const S = (key, lane, name, host = 'local', extra = {}) => ({ key, lane, name, host, engine: 'claude', tmux: `work:${key}`, ...extra });

test('tiles: waiting first, then working, then idle, by name; the manager is not a tile', () => {
  const t = wallTiles([S('a', 'idle', 'alpha'), S('b', 'work', 'zeta'), S('c', 'wait', 'mid'), S('d', 'work', 'beta'), S('m', 'idle', 'manager', 'local', { engine: 'openclaw' }), S('e', 'wait', 'mid', 'devbox')]);
  assert.deepEqual(t.map((x) => x.key), ['e', 'c', 'd', 'b', 'a']);
});

test('density: 1x1 up to 6x5, clamped', () => {
  assert.deepEqual(densityGrid(1), { cols: 1, rows: 1 });
  assert.deepEqual(densityGrid(6), { cols: 6, rows: 5 });
  assert.deepEqual(densityGrid(99), { cols: 6, rows: 5 });
  assert.deepEqual(densityGrid('x'), { cols: 3, rows: 2 });
});

test('capture plan: one list per host, only tiles on screen, no pane no capture, capped', () => {
  const tiles = [S('a', 'wait', 'a'), S('b', 'work', 'b', 'devbox'), S('c', 'idle', 'c'), S('g', 'idle', 'bot', 'local', { tmux: null, engine: 'grok' })];
  const plan = capturePlan(tiles, new Set(['a', 'b', 'g']));
  assert.deepEqual([...plan.entries()], [['local', ['work:a']], ['devbox', ['work:b']]]);
  const many = Array.from({ length: 80 }, (_, i) => S(`k${i}`, 'work', `n${i}`));
  assert.equal(capturePlan(many).get('local').length, CAPTURE_MAX);
});

test('arrows and h j k l move on the grid and stop at its edges', () => {
  assert.equal(moveIndex(-1, 'ArrowRight', 3, 7), 0, 'nothing selected: the first tile');
  assert.equal(moveIndex(0, 'ArrowRight', 3, 7), 1);
  assert.equal(moveIndex(0, 'ArrowLeft', 3, 7), 0);
  assert.equal(moveIndex(1, 'ArrowDown', 3, 7), 4);
  assert.equal(moveIndex(4, 'j', 3, 7), 4, 'no tile below');
  assert.equal(moveIndex(4, 'k', 3, 7), 1);
  assert.equal(moveIndex(2, 'x', 3, 7), 2);
  assert.equal(moveIndex(0, 'ArrowRight', 3, 0), -1);
});

test('runs are styled from validated colors only; reverse swaps; attributes map', () => {
  const [line] = parseAnsi('\x1b[1;38;5;208mhot\x1b[0m \x1b[7mrev\x1b[27m \x1b[2;3;4mdim\x1b[0m');
  const [hot, , rev, , dim] = line;
  assert.deepEqual(runStyle(hot), { color: '#ff8700', fontWeight: '600' });
  assert.deepEqual(runStyle(rev), { color: 'var(--term-bg)', backgroundColor: 'var(--term-fg)' });
  assert.deepEqual(runStyle(dim), { opacity: '0.6', fontStyle: 'italic', textDecoration: 'underline' });
  assert.deepEqual(runStyle({ fg: 'red;background:url(x)', bg: 'javascript:1' }), {}, 'anything but #rrggbb is dropped');
  assert.deepEqual(runStyle({ fg: '#00ff00', bg: '#000000', reverse: true }), { color: '#000000', backgroundColor: '#00ff00' });
});

test('fitLines and tailText', () => {
  assert.equal(fitLines(100, 16), 6);
  assert.equal(fitLines(0, 16), 1);
  assert.equal(tailText({ tail: ['Do you want to proceed?', ''] }), 'Do you want to proceed?');
  assert.equal(tailText({ tail: [], status: 'idle' }), 'idle');
});
