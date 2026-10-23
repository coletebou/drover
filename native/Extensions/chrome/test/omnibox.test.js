import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseInput, matchSessions, suggestionsFor, resolveInput, escapeXml, DEFAULT_SUGGESTION } from '../lib/omnibox.js';
import { normalizeSummary, targetSessions } from '../lib/summary.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/native-summary.json', import.meta.url), 'utf8'));
const sessions = targetSessions(normalizeSummary(fx));
const mk = (name, host, id = name, state = 'working', headline = '') => ({ id, name, host, state, headline, engine: 'claude', kind: null, since: null });

test('parseInput', () => {
  assert.deepEqual(parseInput('demo'), { query: 'demo', host: null, message: '' });
  assert.deepEqual(parseInput('demo hello world'), { query: 'demo', host: null, message: 'hello world' });
  assert.deepEqual(parseInput('demo@box  hi  '), { query: 'demo', host: 'box', message: 'hi' });
  assert.deepEqual(parseInput('   demo    x'), { query: 'demo', host: null, message: 'x' });
  assert.deepEqual(parseInput(''), { query: '', host: null, message: '' });
  assert.deepEqual(parseInput('   '), { query: '', host: null, message: '' });
});

test('matchSessions ranks exact, prefix, substring, id prefix', () => {
  const list = [mk('xdemo', 'l', 'a1'), mk('demo-b', 'l', 'a2'), mk('demo', 'l', 'a3'), mk('other', 'l', 'demo9')];
  assert.deepEqual(matchSessions(list, { query: 'DEMO', host: null }).map((s) => s.id), ['a3', 'a2', 'a1', 'demo9']);
});

test('matchSessions with fixture and host filter', () => {
  assert.equal(matchSessions(sessions, { query: '', host: null }).length, 5);
  assert.deepEqual(matchSessions(sessions, { query: 'demo-', host: 'DEMO-BOX' }).map((s) => s.name), ['demo-docs', 'demo-refactor']);
  assert.deepEqual(matchSessions(sessions, { query: 'review', host: null }).map((s) => s.name), ['demo-review']);
  assert.deepEqual(matchSessions(sessions, { query: 'zzz', host: null }), []);
  // stable: waiting first
  assert.equal(matchSessions(sessions, { query: 'demo', host: null })[0].state, 'waiting');
});

test('suggestionsFor shape, escaping, caps', () => {
  const [s] = suggestionsFor([mk('a&b<c>', 'h"1', 'x', 'waiting', "it's <b>")], 'a hello & bye');
  assert.equal(s.deletable, false);
  assert.equal(s.content, 'a&b<c> hello & bye');
  assert.ok(s.description.includes('<match>a&amp;b&lt;c&gt;</match>'));
  assert.ok(s.description.includes('h&quot;1 · waiting · it&apos;s &lt;b&gt;'));
  assert.ok(s.description.endsWith('<url>send: hello &amp; bye</url>'));
  const noMsg = suggestionsFor([mk('a', 'h')], 'a')[0];
  assert.equal(noMsg.content, 'a ');
  assert.ok(!noMsg.description.includes('<url>'));
  assert.equal(suggestionsFor(sessions, '', { max: 2 }).length, 2);
  assert.equal(suggestionsFor(sessions, '').length, 5);
});

test('duplicate names get @host', () => {
  const list = [mk('same', 'one', '1'), mk('same', 'two', '2'), mk('solo', 'one', '3')];
  const s = suggestionsFor(list, 'same hi');
  assert.deepEqual(s.map((x) => x.content), ['same@one hi', 'same@two hi']);
  assert.equal(suggestionsFor(list, 'solo')[0].content, 'solo ');
});

test('resolveInput', () => {
  const ok = resolveInput(sessions, 'demo-tests run it');
  assert.equal(ok.session.name, 'demo-tests');
  assert.equal(ok.message, 'run it');
  assert.equal(resolveInput(sessions, 'review').session.name, 'demo-review');
  assert.deepEqual(resolveInput(sessions, 'nope x'), { error: 'No session matches "nope".' });
  assert.deepEqual(resolveInput(sessions, 'demo x'), { error: '"demo" matches several sessions. Add @host or more letters.' });
  assert.deepEqual(resolveInput(sessions, ''), { error: 'Type a session name.' });
});

test('resolveInput exact name beats longer names, @host disambiguates', () => {
  const list = [mk('demo-long', 'a', '1'), mk('demo', 'a', '2')];
  assert.equal(resolveInput(list, 'demo hi').session.id, '2');
  const dup = [mk('d', 'a', '1'), mk('d', 'b', '2')];
  assert.ok(resolveInput(dup, 'd hi').error);
  assert.equal(resolveInput(dup, 'd@b hi').session.id, '2');
});

test('escapeXml and default suggestion', () => {
  assert.equal(escapeXml(`&<>"'`), '&amp;&lt;&gt;&quot;&apos;');
  assert.ok(escapeXml(DEFAULT_SUGGESTION).includes('&lt;session&gt;'));
});
