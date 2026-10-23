import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionUrl, boardUrl } from '../lib/links.js';
import { truncate, ago, plural } from '../lib/text.js';

const O = 'http://127.0.0.1:7337';

test('sessionUrl builds the solo view path', () => {
  assert.equal(sessionUrl(O, { host: 'demo-box', id: 'abc', engine: 'codex', name: 'demo-build' }), `${O}/#/pop/session/demo-box/abc/codex/demo-build`);
});

test('sessionUrl defaults host to local', () => {
  assert.match(sessionUrl(O, { id: 'abc' }), /\/pop\/session\/local\/abc\//);
  assert.match(sessionUrl(O, { id: 'abc', engine: 'claude', name: 'n' }), /\/pop\/session\/local\/abc\/claude\/n$/);
});

test('sessionUrl encodes slash, space and hash in segments', () => {
  const u = sessionUrl(O, { host: 'h', id: 'a/b', engine: 'claude', name: 'my build #2' });
  assert.equal(u, `${O}/#/pop/session/h/a%2Fb/claude/my%20build%20%232`);
  assert.ok(!u.slice(u.indexOf('#') + 1).includes('#'));
});

test('boardUrl', () => {
  assert.equal(boardUrl(O), `${O}/#/board`);
});

test('truncate: short strings untouched, whitespace collapsed', () => {
  assert.equal(truncate('hello', 10), 'hello');
  assert.equal(truncate('  a \n\t b   c ', 20), 'a b c');
  assert.equal(truncate(null, 5), '');
});

test('truncate: cuts on a word boundary with an ellipsis', () => {
  const t = truncate('the quick brown fox jumps over the lazy dog', 20);
  assert.equal(t, 'the quick brown fox…');
  assert.equal(truncate('the quick brown foxes jump', 20), 'the quick brown…');
  assert.ok(t.length <= 20);
});

test('truncate: hard cut when no good boundary', () => {
  const t = truncate('abcdefghijklmnopqrstuvwxyz', 10);
  assert.equal(t, 'abcdefghi…');
});

test('ago: now, minutes, hours, days', () => {
  const now = Date.parse('2026-10-11T18:00:00Z');
  const at = (ms) => new Date(now - ms).toISOString();
  assert.equal(ago(at(10_000), now), 'now');
  assert.equal(ago(at(0), now), 'now');
  assert.equal(ago(at(4 * 60_000), now), '4m');
  assert.equal(ago(at(3 * 3_600_000), now), '3h');
  assert.equal(ago(at(2 * 86_400_000), now), '2d');
  assert.equal(ago(at(-60_000), now), 'now'); // future clamps to now
});

test('ago: bad input is empty', () => {
  for (const v of ['', 'nope', null, undefined]) assert.equal(ago(v), '');
});

test('plural', () => {
  assert.equal(plural(1, 'session'), '1 session');
  assert.equal(plural(0, 'session'), '0 sessions');
  assert.equal(plural(2, 'session'), '2 sessions');
});
