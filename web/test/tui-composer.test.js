// The TUI composer (tui/composer.js): editing by grapheme, readline keys, history, layout with the cursor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Composer } from '../tui/composer.js';

const k = (id, extra = {}) => ({ id, ...extra });
const ch = (c) => ({ id: c, ch: c, name: c });
const type = (c, s) => { for (const x of s) c.handle(ch(x)); };

test('typing, Enter submits, Ctrl-J and Alt-Enter add lines, paste keeps newlines', () => {
  const c = new Composer();
  type(c, 'hi');
  assert.equal(c.handle(k('C-j')), true);
  type(c, 'there');
  c.handle(k('M-enter'));
  c.handle({ id: 'paste', text: 'a\r\nb\tc' });
  assert.equal(c.value, 'hi\nthere\na\nb    c');
  assert.equal(c.handle(k('enter')), 'submit');
  assert.equal(c.handle(k('escape')), false, 'keys it does not use go back to the caller');
  assert.equal(c.handle(k('f5')), false);
});

test('backspace, delete and arrows move by grapheme, never inside an emoji or a combined letter', () => {
  const c = new Composer();
  c.set('a\u{1F469}‍\u{1F4BB}éz');
  c.handle(k('backspace'));
  assert.equal(c.value, 'a\u{1F469}‍\u{1F4BB}é');
  c.handle(k('backspace'));
  assert.equal(c.value, 'a\u{1F469}‍\u{1F4BB}');
  c.handle(k('left'));
  assert.equal(c.cur, 1);
  c.handle(k('delete'));
  assert.equal(c.value, 'a');
  c.set('abc def', 7); c.handle(k('C-w')); assert.equal(c.value, 'abc ');
  c.set('one two', 3); c.handle(k('C-k')); assert.equal(c.value, 'one');
  c.set('line1\nline2', 11); c.handle(k('C-u')); assert.equal(c.value, 'line1\n');
  c.set('a b', 3); c.handle(k('M-b')); assert.equal(c.cur, 2); c.handle(k('C-a')); assert.equal(c.cur, 0); c.handle(k('C-e')); assert.equal(c.cur, 3);
});

test('Up and Down move through rows first, then through the history; the draft comes back', () => {
  const c = new Composer({ history: ['newest', 'older'] });
  type(c, 'draft');
  c.handle(k('up')); assert.equal(c.value, 'newest');
  c.handle(k('up')); assert.equal(c.value, 'older');
  c.handle(k('up')); assert.equal(c.value, 'older', 'the end of the history stays put');
  c.handle(k('down')); c.handle(k('down')); assert.equal(c.value, 'draft');
  c.set('row one\nrow two', 15);
  c.handle(k('up'), 40);
  assert.equal(c.value, 'row one\nrow two', 'up inside the text moves the cursor');
  assert.equal(c.cur, 7);
  c.set('abcdefghij', 9);
  c.handle(k('up'), 4);
  assert.equal(c.cur, 5, 'up moves one wrapped row at the same column');
  const sent = c.commit();
  assert.equal(sent, 'abcdefghij');
  assert.deepEqual(c.history.slice(0, 2), ['abcdefghij', 'newest']);
  assert.equal(c.value, '');
});

test('layout wraps rows at the width and puts the cursor where the text is', () => {
  const c = new Composer();
  c.set('abcdef', 6);
  assert.deepEqual(c.layout(3), { rows: ['abc', 'def', ''], info: [{ start: 0, end: 3 }, { start: 3, end: 6 }, { start: 6, end: 6 }], cursorRow: 2, cursorCol: 0 }, 'a cursor after a full row starts the next one');
  c.set('漢字x', 1);
  const L = c.layout(3);
  assert.deepEqual(L.rows, ['漢', '字x']);
  assert.deepEqual([L.cursorRow, L.cursorCol], [1, 0]);
  c.set('a\nb', 3);
  assert.deepEqual([c.layout(10).cursorRow, c.layout(10).cursorCol], [1, 1]);
});
