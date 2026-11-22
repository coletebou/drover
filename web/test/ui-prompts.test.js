// The Prompts workspace's pure half (ui/prompts-model.js): list args per scope and filter, page merging by id, the
// board strip a prompt's session is, and the status line. Synthetic records in the spec's shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listArgs, markArgs, mergePrompts, stripForPrompt, statusLine, firstLine, FILTERS, FILTER_LABEL } from '../ui/prompts-model.js';

const P = (id, ts, extra = {}) => ({ v: 1, id, ts, host: 'box-a', engine: 'claude', session: 's1', cwd: '~/code/app', project: 'app', label: 'work', via: 'typed', mine: true, marked: false, text: 'verbatim prompt', ...extra });

test('list args: who is always sent (never via), empty filters left out, paging by id, an unknown scope falls back to mine', () => {
  assert.deepEqual(listArgs({}), { limit: 200, who: 'mine' });
  assert.deepEqual(listArgs({ scope: 'mine', q: '  parser  ', host: 'box-a', engine: '', label: 'work' }), { limit: 200, who: 'mine', q: 'parser', host: 'box-a', label: 'work' });
  assert.deepEqual(listArgs({ scope: 'all', before: 'p_1' }), { limit: 200, who: 'all', before: 'p_1' });
  assert.deepEqual(listArgs({ scope: 'manager' }), { limit: 200, who: 'manager' });
  assert.deepEqual(listArgs({ scope: 'agents' }), { limit: 200, who: 'agents' });
  assert.deepEqual(listArgs({ scope: 'programs' }), { limit: 200, who: 'programs' });
  assert.deepEqual(listArgs({ scope: 'not-mine' }), { limit: 200, who: 'not-mine' });
  assert.deepEqual(listArgs({ scope: 'bogus' }), { limit: 200, who: 'mine' });
  assert.deepEqual(FILTERS, ['mine', 'manager', 'agents', 'programs', 'not-mine', 'all']);
  assert.ok(FILTERS.every((f) => FILTER_LABEL[f]));
});

test('mark args: one id or many, mine true/false/null', () => {
  assert.deepEqual(markArgs('p_1', true), { ids: ['p_1'], mine: true });
  assert.deepEqual(markArgs(['p_1', 'p_2'], false), { ids: ['p_1', 'p_2'], mine: false });
  assert.deepEqual(markArgs('p_1', null), { ids: ['p_1'], mine: null });
});

test('pages merge by id, newest first', () => {
  const a = [P('p_3', '2026-11-21T10:03:00Z'), P('p_2', '2026-11-21T10:02:00Z')];
  const b = [P('p_2', '2026-11-21T10:02:00Z'), P('p_1', '2026-11-21T10:01:00Z')];
  const fresh = [P('p_4', '2026-11-21T10:04:00Z'), P('p_3', '2026-11-21T10:03:00Z')];
  assert.deepEqual(mergePrompts(fresh, a, b).map((p) => p.id), ['p_4', 'p_3', 'p_2', 'p_1']);
  assert.deepEqual(mergePrompts(null, [{ text: 'no id' }]), []);
});

test('a prompt finds its session\'s strip; the front host is "local" on the board', () => {
  const strips = [{ key: 'local|s1', host: 'local', id: 's1', sessionId: 's1' }, { key: 'devbox|w', host: 'devbox', id: 'work:3', sessionId: 's2', kind: 'window' }];
  assert.equal(stripForPrompt(strips, P('p', 't', { host: 'studio' }), 'studio')?.key, 'local|s1');
  assert.equal(stripForPrompt(strips, P('p', 't', { host: 'devbox', session: 's2' }), 'studio')?.key, 'devbox|w');
  assert.equal(stripForPrompt(strips, P('p', 't', { host: 'devbox', session: 's1' }), 'studio'), null, 'same session id, another host');
  assert.equal(stripForPrompt(strips, P('p', 't', { session: null })), null);
});

test('status line and first line', () => {
  assert.equal(statusLine(null), '');
  assert.match(statusLine({ records: 1204, sinks: [] }), /^1,204 prompts; local spool only$/);
  const s = statusLine({ records: 3, newest: new Date(Date.now() - 180_000).toISOString(), sinks: [{ name: 'personal', lastSync: new Date(Date.now() - 240_000).toISOString() }, { name: 'work', lastError: 'push failed' }, { name: 'sealed' }] });
  assert.equal(s, '3 prompts, newest 3m ago; personal synced 4m ago, work: push failed, sealed not synced yet');
  assert.equal(firstLine('\n\n  first\nsecond'), 'first');
  assert.equal(firstLine('x'.repeat(200), 10), 'xxxxxxxxx…');
});
