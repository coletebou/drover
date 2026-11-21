import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAnsi, plainLines, color256, applySgr, stripAnsi } from '../ui/ansi.js';

test('SGR colors and attributes become styled runs', () => {
  const [l] = parseAnsi('\x1b[1;31mred\x1b[0m plain \x1b[38;5;208morange\x1b[38;2;1;2;3mrgb');
  assert.deepEqual(l.map((r) => r.text), ['red', ' plain ', 'orange', 'rgb']);
  assert.equal(l[0].fg, '#cd3131'); assert.equal(l[0].bold, true);
  assert.equal(l[1].fg, null); assert.equal(l[1].bold, false);
  assert.equal(l[2].fg, color256(208)); assert.equal(l[3].fg, '#010203');
});

test('other escapes and control characters never survive', () => {
  const t = 'a\x1b[2J\x1b[10;5Hb\x1b]0;title\x07c\x1b]8;;http://x\x1b\\d\x1bPq#data\x1b\\e\x07\x08f\x1b';
  assert.deepEqual(plainLines(parseAnsi(t)), ['abcdef']);
  assert.equal(stripAnsi('\x1b[31mx\x1b[0m\x9by'), 'xy');
});

test('styles carry across lines; maxLines keeps the bottom; padding lines go', () => {
  const lines = parseAnsi('\x1b[32mone\ntwo\x1b[0m\nthree\n\n\n', { maxLines: 2 });
  assert.deepEqual(plainLines(lines), ['two', 'three']);
  assert.equal(lines[0][0].fg, '#0dbc79');
});

test('tabs expand and maxCols cuts', () => {
  assert.deepEqual(plainLines(parseAnsi('a\tb', { maxCols: 20 })), ['a       b']);
  assert.deepEqual(plainLines(parseAnsi('abcdef', { maxCols: 3 })), ['abc']);
});

test('256 palette edges and 22/39/49 resets', () => {
  assert.equal(color256(16), '#000000'); assert.equal(color256(231), '#ffffff'); assert.equal(color256(232), '#080808'); assert.equal(color256(256), null);
  const s = applySgr(applySgr({}, '1;2;41;94'), '22;39;49');
  assert.equal(s.bold, false); assert.equal(s.dim, false); assert.equal(s.fg, null); assert.equal(s.bg, null);
});
