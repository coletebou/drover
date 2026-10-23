// Display width, cutting and sanitizing for the TUI (tui/width.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strWidth, truncate, fit, padStart, wrap, sanitize, oneLine, clusters, codePointWidth } from '../tui/width.js';

test('width counts columns the way terminals draw them', () => {
  assert.equal(strWidth('hello'), 5);
  assert.equal(strWidth(''), 0);
  assert.equal(strWidth('漢字'), 4, 'CJK is two columns each');
  assert.equal(strWidth('ｱｲ'), 2, 'halfwidth katakana is one column');
  assert.equal(strWidth('Ａ'), 2, 'fullwidth Latin is two');
  assert.equal(strWidth('한국'), 4, 'Hangul syllables are wide');
  assert.equal(strWidth('e\u0301'), 1, 'a combining mark adds nothing');
  assert.equal(strWidth('\u00e9'), 1, 'and the precomposed form is one column too');
  assert.equal(strWidth('a\u200bb'), 2, 'a zero width space adds nothing');
  assert.equal(strWidth('👍'), 2);
  assert.equal(strWidth('\u{1F44D}\u{1F3FD}'), 2, 'a skin tone joins its emoji');
  assert.equal(strWidth('\u{1F469}\u200D\u{1F4BB}'), 2, 'a ZWJ sequence is one cell');
  assert.equal(strWidth('\u{1F1FA}\u{1F1F8}'), 2, 'a flag is one cell');
  assert.equal(strWidth('\u263A'), 1, 'text presentation by default');
  assert.equal(strWidth('\u263A\uFE0F'), 2, 'VS16 asks for the emoji form');
  assert.equal(strWidth('1\uFE0F\u20E3'), 2, 'a keycap');
  assert.equal(strWidth('a\x07b'), 2, 'controls take no column');
  assert.equal(codePointWidth(0x4e00), 2);
  assert.equal(codePointWidth(0x0301), 0);
  assert.deepEqual(clusters('ab'), ['a', 'b']);
  assert.deepEqual(clusters('e\u0301\u{1F44D}\u{1F3FD}'), ['e\u0301', '\u{1F44D}\u{1F3FD}']);
  assert.equal(strWidth('a\u0301b\u0302'), 2, 'marks after each letter');
});

test('truncate cuts to the width with an ellipsis and never splits a wide character', () => {
  assert.equal(truncate('hello world', 20), 'hello world');
  assert.equal(truncate('hello world', 8), 'hello w…');
  assert.equal(strWidth(truncate('hello world', 8)), 8);
  assert.equal(truncate('漢字漢字漢字', 7), '漢字漢…', 'two columns per character, one for the ellipsis');
  assert.equal(truncate('漢字漢字漢字', 6), '漢字…', 'the third character would straddle the limit');
  assert.equal(strWidth(truncate('漢字漢字漢字', 6)), 5);
  assert.equal(truncate('abc', 1), '…');
  assert.equal(truncate('abc', 0), '');
  assert.equal(truncate('\u{1F469}\u200D\u{1F4BB}'.repeat(3), 5), '\u{1F469}\u200D\u{1F4BB}'.repeat(2) + '…');
  assert.equal(truncate('abcdef', 4, ''), 'abcd', 'no ellipsis when asked');
});

test('fit and padStart make exact widths', () => {
  assert.equal(fit('ab', 5), 'ab   ');
  assert.equal(fit('漢字漢字', 5), '漢字…');
  assert.equal(strWidth(fit('漢字漢字漢', 6)), 6);
  assert.equal(padStart('42', 5), '   42');
  assert.equal(padStart('toolong', 3), 'to…');
});

test('wrap moves words whole, breaks words longer than a line, keeps paragraphs and indentation', () => {
  assert.deepEqual(wrap('the quick brown fox jumps over the lazy dog', 10), ['the quick', 'brown fox', 'jumps over', 'the lazy', 'dog']);
  assert.deepEqual(wrap('a\n\nb', 10), ['a', '', 'b']);
  assert.deepEqual(wrap('  indented text that wraps around here', 12), ['  indented', 'text that', 'wraps around', 'here']);
  assert.deepEqual(wrap('averyveryverylongword ok', 8), ['averyver', 'yverylon', 'gword ok']);
  assert.deepEqual(wrap('漢字漢字漢字', 5, { words: false }), ['漢字', '漢字', '漢字']);
  for (const line of wrap('Two sessions are waiting on you: demo-build wants to run npm test 漢字 👍🏽 and more words here', 13)) assert.ok(strWidth(line) <= 13, line);
  assert.deepEqual(wrap('trailing spaces   ', 40), ['trailing spaces']);
});

test('sanitize removes escape sequences and controls, so data never drives the terminal', () => {
  assert.equal(sanitize('a\x1b[31mred\x1b[0mb'), 'aredb');
  assert.equal(sanitize('x\x1b]52;c;aGk=\x07y'), 'xy', 'an OSC 52 (clipboard) is dropped');
  assert.equal(sanitize('x\x1b]8;;http://e\x1b\\link\x1b]8;;\x1b\\y'), 'xlinky', 'hyperlink OSC with ST');
  assert.equal(sanitize('a\x00b\x08c\x9bd'), 'abcd', 'C0 and C1 controls go');
  assert.equal(sanitize('a\r\nb\rc'), 'a\nb\nc');
  assert.equal(sanitize('a\tb', { tabSize: 4 }), 'a   b');
  assert.equal(sanitize('ab\tc', { tabSize: 8 }), 'ab      c');
  assert.equal(oneLine('  two\n lines\t here '), 'two lines here');
});
