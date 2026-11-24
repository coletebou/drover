// The browser's line diff (ui/line-diff.js), used by the Learned skills view to compare a saved version or a draft
// with the live text: the ops reproduce both texts, a change is found in the middle of shared lines, hunks keep three
// lines of context and merge when close, and a middle too large for the table degrades to remove-then-add.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lines, lineDiff, hunks } from '../ui/line-diff.js';

const side = (ops, t) => ops.filter((o) => o.t === ' ' || o.t === t).map((o) => o.s);

test('lines: a final newline makes no empty last line; empty text has none', () => {
  assert.deepEqual(lines('a\nb\n'), ['a', 'b']);
  assert.deepEqual(lines('a\n\nb'), ['a', '', 'b']);
  assert.deepEqual(lines(''), []);
  assert.deepEqual(lines(null), []);
});

test('the ops rebuild both texts, and only the changed lines are marked', () => {
  const a = 'one\ntwo\nthree\nfour\nfive\n', b = 'one\n2\nthree\nfour\nfive\nsix\n';
  const d = lineDiff(a, b);
  assert.deepEqual(side(d.ops, '-'), lines(a));
  assert.deepEqual(side(d.ops, '+'), lines(b));
  assert.deepEqual(d.ops.filter((o) => o.t !== ' ').map((o) => `${o.t}${o.s}`), ['-two', '+2', '+six']);
  assert.deepEqual([d.added, d.removed, d.exact], [2, 1, true]);
  assert.deepEqual(d.ops.find((o) => o.s === 'four'), { t: ' ', s: 'four', a: 4, b: 4 });
});

test('identical texts: no changes, no hunks; one side empty: all added or all removed', () => {
  const same = lineDiff('x\ny\n', 'x\ny\n');
  assert.deepEqual([same.added, same.removed], [0, 0]);
  assert.deepEqual(hunks(same.ops), []);
  assert.deepEqual(lineDiff('', 'a\nb').ops.map((o) => o.t), ['+', '+']);
  assert.deepEqual(lineDiff('a\nb', '').ops.map((o) => o.t), ['-', '-']);
});

test('hunks keep three lines of context around a change and merge changes that are close', () => {
  const a = Array.from({ length: 30 }, (_, i) => `l${i + 1}`);
  const b = a.slice(); b[4] = 'X'; b[8] = 'Y'; b[24] = 'Z';
  const hs = hunks(lineDiff(a, b).ops);
  assert.equal(hs.length, 2, 'lines 5 and 9 share a hunk, line 25 has its own');
  assert.deepEqual([hs[0].aStart, hs[0].aLines, hs[0].bStart, hs[0].bLines], [2, 11, 2, 11]);
  assert.deepEqual([hs[1].aStart, hs[1].aLines], [22, 7]);
  assert.deepEqual(hs[1].ops.filter((o) => o.t !== ' ').map((o) => `${o.t}${o.s}`), ['-l25', '+Z']);
});

test('a middle too large for the table comes back as one block removed and one added, marked inexact', () => {
  const a = Array.from({ length: 50 }, (_, i) => `a${i}`), b = Array.from({ length: 50 }, (_, i) => `b${i}`);
  const d = lineDiff(['head', ...a, 'tail'], ['head', ...b, 'tail'], { maxCells: 100 });
  assert.equal(d.exact, false);
  assert.deepEqual([d.removed, d.added], [50, 50]);
  assert.deepEqual([d.ops[0].s, d.ops.at(-1).s], ['head', 'tail'], 'the shared head and tail still match');
});
