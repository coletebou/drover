// Rows to terminal output and the line differ (tui/screen.js), color depth and SGR (tui/style.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderRow, frameOutput, Screen, rowText } from '../tui/screen.js';
import { colorDepth, sgr, resolve } from '../tui/style.js';
import { strWidth } from '../tui/width.js';

const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

test('a row renders to exactly the screen width: padded, or cut with an ellipsis', () => {
  assert.equal(renderRow('abc', 6, 0), 'abc   ');
  assert.equal(renderRow([['abc'], ['def']], 4, 0), 'abc…');
  assert.equal(strWidth(plain(renderRow([['漢字漢字漢字', 'bold']], 7, 8))), 7);
  assert.equal(plain(renderRow([['a\x1b]52;c;x\x07b']], 5, 8)), 'a]52;c;xb'.slice(0, 4) + '…', 'controls are stripped before measuring');
  assert.equal(plain(renderRow(null, 3, 8)), '   ');
});

test('styles become SGR at the color depth, and a row background reaches its padding', () => {
  const r = renderRow([['hi', 'accent']], 5, 8);
  assert.match(r, /^\x1b\[38;5;\d+mhi\x1b\[0m   $/);
  const t = renderRow([['hi', 'accent']], 2, 24);
  assert.match(t, /^\x1b\[38;2;95;168;211mhi\x1b\[0m$/, 'truecolor');
  const sel = renderRow({ segs: [['x', 'accent']], bg: 'sel' }, 3, 8);
  assert.equal((sel.match(/48;5;/g) ?? []).length, 2, 'the segment and the padding both get the selection background');
  const mono = renderRow({ segs: [['x']], bg: 'sel' }, 2, 0);
  assert.equal(mono, '\x1b[7mx\x1b[0m\x1b[7m \x1b[0m', 'no color: the selection is reverse video');
  const own = renderRow([['a', null, 'sel'], ['b']], 2, 8);
  assert.match(own, /48;5;\d+ma\x1b\[0mb$/, 'a segment can carry its own background');
});

test('the differ writes only rows that changed', () => {
  const a = ['one', 'two', 'three'];
  assert.match(frameOutput(null, a), /^\x1b\[H\x1b\[2J/, 'the first frame clears and writes everything');
  assert.equal(frameOutput(a, ['one', 'TWO', 'three']), '\x1b[2;1HTWO');
  assert.equal(frameOutput(a, a), '');
  assert.match(frameOutput(a, ['one', 'two']), /\x1b\[2J/, 'a different height repaints');
});

test('Screen writes one synchronized update per frame and nothing when nothing changed', () => {
  const out = [];
  const s = new Screen((x) => out.push(x), { depth: 0 });
  s.draw(['hello', 'world'], { rows: 2, cols: 10 });
  assert.equal(out.length, 1);
  assert.match(out[0], /^\x1b\[\?2026h/);
  assert.match(out[0], /\x1b\[\?2026l$/);
  assert.equal(s.draw(['hello', 'world'], { rows: 2, cols: 10 }), 0, 'an identical frame writes nothing');
  s.draw(['hello', 'there'], { rows: 2, cols: 10 });
  assert.equal(out.length, 2);
  assert.ok(!out[1].includes('hello'), 'the unchanged row is not rewritten');
  assert.ok(out[1].includes('\x1b[2;1Hthere'));
  s.draw(['hello', 'there'], { rows: 2, cols: 10, cursor: { row: 1, col: 3 } });
  assert.match(out[2], /\x1b\[2;4H\x1b\[\?25h/, 'the cursor moves and shows');
  s.draw(['hello', 'there'], { rows: 2, cols: 12 });
  assert.match(out[3], /\x1b\[2J/, 'a resize repaints');
  assert.equal(rowText([['a', 'x'], ['b']]), 'ab');
});

test('color depth follows NO_COLOR, TERM and COLORTERM', () => {
  assert.equal(colorDepth({ TERM: 'xterm-256color', NO_COLOR: '1' }), 0, 'NO_COLOR with any value');
  assert.equal(colorDepth({ TERM: 'xterm-256color', NO_COLOR: '' }), 8, 'an empty NO_COLOR is not set');
  assert.equal(colorDepth({ TERM: 'dumb' }), 0);
  assert.equal(colorDepth({}), 0);
  assert.equal(colorDepth({ TERM: 'xterm-256color', COLORTERM: 'truecolor' }), 24);
  assert.equal(colorDepth({ TERM: 'tmux-256color' }), 8);
  assert.equal(colorDepth({ TERM: 'screen' }), 8);
  assert.equal(colorDepth({ TERM: 'xterm' }), 4);
  assert.equal(colorDepth({ TERM: 'xterm', DROVER_TUI_COLOR: 'truecolor', NO_COLOR: '1' }), 24, 'the explicit override wins');
  assert.equal(sgr(resolve('dim', 0), 0), '\x1b[2m', 'no color keeps attributes');
  assert.equal(sgr(resolve('plain', 8), 8), '');
  assert.match(sgr(resolve('wait', 4), 4), /^\x1b\[(3|9)\dm$/, '16 colors');
});
