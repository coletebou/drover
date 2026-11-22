// The side panel's Prompts section: its pure half (lib/prompts.js), the links into the web UI's workspaces checked
// against the web UI's own router when it is in this checkout, and prompts.list over real HTTP against the fake daemon.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { listArgs, mergePrompts, normalizePrompts, fmtTime, promptRow, stripForPrompt, statusLine, isUnknownPromptsOp, PANEL_PAGE, VIA_LABEL } from '../lib/prompts.js';
import { boardUrl, managerUrl, promptsUrl, sessionUrl } from '../lib/links.js';
import { startFakeDaemon, FAKE_TOKEN } from '../tools/fake-daemon.mjs';
import { createClient } from '../lib/api.js';

const NOW = Date.parse('2026-11-21T23:00:00Z');
const rec = (id, ts, extra = {}) => ({ v: 1, id, ts, host: 'demo-mac', engine: 'claude', session: null, cwd: '~/code/demo', project: 'demo', label: 'work', via: 'typed', text: id, route: 'local', ...extra });

test('listArgs: the daemon default via set, search words, before, a clamped limit', () => {
  assert.deepEqual(listArgs(), { limit: PANEL_PAGE });
  assert.deepEqual(listArgs({ q: '  fix the parser ', before: 'p_1' }), { limit: PANEL_PAGE, q: 'fix the parser', before: 'p_1' });
  assert.deepEqual(listArgs({ q: '   ', before: '' }), { limit: PANEL_PAGE });
  assert.equal(listArgs({ limit: 99999 }).limit, 2000);
  assert.equal(listArgs({ limit: -3 }).limit, 1);
  assert.equal(listArgs({ q: 'x'.repeat(900) }).q.length, 500);
  assert.ok(!('via' in listArgs({ q: 'x' })), 'Mine: no via, the daemon picks its default');
});

test('mergePrompts: by id, newest first, ties by id', () => {
  const a = [rec('a', '2026-11-21T22:00:00Z'), rec('b', '2026-11-21T21:00:00Z')];
  const b = [rec('b', '2026-11-21T21:00:00Z'), rec('c', '2026-11-21T20:00:00Z'), rec('d', '2026-11-21T22:00:00Z'), null, { id: 3 }];
  assert.deepEqual(mergePrompts(a, b).map((p) => p.id), ['d', 'a', 'b', 'c']);
  assert.deepEqual(mergePrompts(null, undefined), []);
});

test('normalizePrompts keeps only well-formed records', () => {
  const res = { prompts: [rec('ok', '2026-11-21T22:00:00Z'), { id: 'no-text', ts: '2026-11-21T22:00:00Z' }, { id: 'bad-ts', ts: 'yesterday', text: 'x' }, { text: 'no id', ts: '2026-11-21T22:00:00Z' }, 7] };
  assert.deepEqual(normalizePrompts(res).map((p) => p.id), ['ok']);
  assert.deepEqual(normalizePrompts(null), []);
  assert.deepEqual(normalizePrompts({ prompts: 'nope' }), []);
});

test('fmtTime: today, this week, older; 24-hour', () => {
  assert.equal(fmtTime('2026-11-21T22:03:11Z', NOW, { utc: true }), '22:03');
  assert.equal(fmtTime('2026-11-21T00:05:00Z', NOW, { utc: true }), '00:05');
  assert.equal(fmtTime('2026-11-18T09:05:00Z', NOW, { utc: true }), 'Wed 09:05');
  assert.equal(fmtTime('2026-10-02T09:05:00Z', NOW, { utc: true }), '2 Oct 09:05');
  assert.equal(fmtTime('nope', NOW), '');
});

test('promptRow: the meta line and the text verbatim', () => {
  const r = promptRow(rec('p1', '2026-11-21T21:58:40Z', { host: 'demo-box', engine: 'codex', project: 'webapp', via: 'queued', text: 'Review the form:\n\n- labels\n<b>not markup</b>' }), { now: NOW, utc: true });
  assert.equal(r.meta, '21:58 · demo-box · codex · webapp · queued');
  assert.equal(r.text, 'Review the form:\n\n- labels\n<b>not markup</b>', 'verbatim: the DOM gets it through textContent');
  assert.equal(promptRow(rec('p2', '2026-11-21T21:58:40Z'), { now: NOW, utc: true }).meta, '21:58 · demo-mac · claude · demo', 'typed says nothing');
  assert.equal(promptRow(rec('p3', '2026-11-21T21:58:40Z', { via: 'peer', from: 'demo-review', project: null }), { now: NOW, utc: true }).meta, '21:58 · demo-mac · claude · from demo-review');
  assert.equal(promptRow(rec('p4', '2026-11-21T21:58:40Z', { via: 'someday' }), { now: NOW, utc: true }).meta.endsWith('someday'), true, 'an unknown via shows as itself');
  assert.equal(promptRow(rec('p5', '2026-11-21T21:58:40Z', { source: 'sink:personal' })).fromSink, true);
  assert.equal(VIA_LABEL.drover, 'via Drover');
});

test('stripForPrompt: the session on the board, on the host the record routes to', () => {
  const strips = [
    { host: 'local', id: 'sess-1', name: 'demo-build' },
    { host: 'demo-box', id: 'demo:3', sessionId: 'thread-9', name: 'demo-review' },
    { host: 'local', id: 'manager', name: 'Manager' },
  ];
  assert.equal(stripForPrompt(strips, rec('a', 'x', { session: 'sess-1' }))?.name, 'demo-build');
  assert.equal(stripForPrompt(strips, rec('b', 'x', { session: 'thread-9', route: 'demo-box' }))?.name, 'demo-review', 'a window strip by its sessionId');
  assert.equal(stripForPrompt(strips, rec('c', 'x', { session: 'sess-1', route: 'demo-box' })), null, 'the same id on another host is another session');
  assert.equal(stripForPrompt(strips, rec('d', 'x', { session: 'manager' })), null, 'never the manager');
  assert.equal(stripForPrompt(strips, rec('e', 'x', { session: null })), null);
  assert.equal(stripForPrompt(strips, rec('f', 'x', { session: 'sess-1', route: null, host: 'local' }))?.name, 'demo-build', 'no route: the record host');
  assert.equal(stripForPrompt(null, rec('g', 'x', { session: 'sess-1' })), null);
});

test('statusLine from prompts.status', () => {
  const st = { records: 1204, newest: '2026-11-21T22:57:00Z', sinks: [{ name: 'personal', lastSync: '2026-11-21T22:54:00Z' }, { name: 'work', lastError: 'push failed' }, { name: 'sealed' }] };
  assert.equal(statusLine(st, NOW), '1,204 prompts, newest 3m ago; personal synced 6m ago, work: push failed, sealed not synced yet');
  assert.equal(statusLine({ records: 1 }, NOW), '1 prompt');
  assert.equal(statusLine(null), '');
});

test('isUnknownPromptsOp', () => {
  assert.ok(isUnknownPromptsOp(new Error('unknown op prompts.list')));
  assert.ok(!isUnknownPromptsOp(new Error('Cannot reach the daemon')));
});

// Every link the extension builds is the web UI's canonical hash: its router resolves it to itself, no redirect.
const ROUTES = fileURLToPath(new URL('../../../../web/ui/routes.js', import.meta.url));
test('links are the web UI router\'s canonical hashes', { skip: !existsSync(ROUTES) && 'web/ui/routes.js is not in this checkout' }, async () => {
  const { resolve, parseHash, WORKSPACES } = await import(ROUTES);
  const O = 'http://127.0.0.1:7337';
  for (const url of [boardUrl(O), managerUrl(O), promptsUrl(O), promptsUrl(O, 'fix the parser')]) {
    const hash = url.slice(O.length + 1);
    assert.equal(resolve(parseHash(hash), WORKSPACES).hash, hash, `${hash} is canonical`);
  }
  assert.deepEqual((({ ws, sub, params }) => ({ ws, sub, params }))(resolve(parseHash(promptsUrl(O, 'fix the parser').slice(O.length + 1)), WORKSPACES)), { ws: 'prompts', sub: 'mine', params: ['fix the parser'] }, 'the search lands in the view');
  assert.equal(resolve(parseHash('#/board'), WORKSPACES).hash, boardUrl(O).slice(O.length + 1), 'the old board hash redirects to the one the extension now builds');
  assert.match(sessionUrl(O, { id: 'x' }), /#\/pop\/session\//, 'the solo session window is outside the workspaces and unchanged');
});

let daemon;
before(async () => { daemon = await startFakeDaemon({ token: FAKE_TOKEN }); });
after(async () => { await daemon.close(); });

test('prompts.list over HTTP: Mine by default, a search, then the next page with before', async () => {
  const client = createClient({ baseUrl: daemon.url, token: FAKE_TOKEN });
  const first = await client.op('prompts.list', listArgs({ limit: 2 }));
  const page1 = normalizePrompts(first);
  assert.deepEqual(page1.map((p) => p.id), ['p_0d1e2f3a4b5c6d7e', 'p_1a2b3c4d5e6f7081']);
  assert.equal(first.more, true);
  const next = await client.op('prompts.list', listArgs({ limit: 2, before: page1.at(-1).id }));
  const all = mergePrompts(page1, normalizePrompts(next));
  assert.equal(all.length, 4);
  assert.ok(all.every((p) => p.via !== 'peer'), 'Mine leaves peer messages out');
  assert.equal(next.more, false);
  const found = normalizePrompts(await client.op('prompts.list', listArgs({ q: 'THE tests' })));
  assert.deepEqual(found.map((p) => p.id), ['p_0d1e2f3a4b5c6d7e'], 'every word, any case');
  assert.deepEqual(daemon.promptQueries.at(-1), { limit: PANEL_PAGE, q: 'THE tests' });
  const st = await client.op('prompts.status', {});
  assert.match(statusLine(st), /^1,204 prompts/);
});
