// sessions.list filters (core/session-filter.js): cwd, name, engine, live and limit on synthetic session lists, and
// drover_sessions, which passes them (and compact) to the op and filters an answer from Drover code that predates
// them, so the whole list never reaches the conversation. Run: node --test test/session-filter.test.js
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { filterSessions, filtersGiven, activityMs, cwdRoots } from '../core/session-filter.js';
import { createServer } from '../mcp/server.js';

const HOME = '/home/u';
// The shapes the merged list carries (2026-10-22): Claude updatedAt in ms, Codex updatedAt in s, a bot's lastSeenAt,
// a transcript's mtime, a headless agent's startedAt.
const LIST = [
  { id: 'c1', engine: 'claude', name: 'webapp-f8', live: true, cwd: '/home/u/code/webapp', updatedAt: 1_792_661_284_197 },
  { id: 'c2', engine: 'claude', name: 'Review Bot', live: false, cwd: '/home/u/code/webapp/.claude/worktrees/review', updatedAt: 1_792_600_000_000 },
  { id: 'c3', engine: 'claude', name: null, live: true, cwd: '/home/u/code/webapp-wt', updatedAt: 1_792_661_000_000 },
  { id: 'x1', engine: 'codex', name: 'Monitor deploy', live: false, cwd: '/home/u/code/billing', updatedAt: 1_792_658_735, preview: 'x'.repeat(5000) },
  { id: 'x2', engine: 'codex', name: 'webapp lint', live: true, cwd: '/home/u/code/webapp', updatedAt: 1_792_661_300 },
  { id: 'g1', engine: 'grok', name: 'Scout', live: false, cwd: null, lastSeenAt: '2026-10-20T20:13:40.513Z' },
  { id: 't1', engine: 'claude', live: false, status: 'transcript', cwd: null, mtime: '2026-10-21T08:00:00.000Z' },
  { id: 'h1', engine: 'claude', kind: 'headless', name: 'claude-headless', live: true, cwd: '/home/u', startedAt: '2026-10-22T09:30:00.000Z' },
];
const ids = (r) => r.sessions.map((s) => s.id);

const tmp = realpathSync(await mkdtemp(path.join(tmpdir(), 'drover-sfilter-')));
after(() => rm(tmp, { recursive: true, force: true }));

describe('filterSessions', () => {
  test('cwd: that folder or inside it, on path boundaries; ~ is the host\'s home; a trailing slash is ignored', () => {
    assert.deepEqual(ids(filterSessions(LIST, { cwd: '/home/u/code/webapp' }, { home: HOME })), ['c1', 'c2', 'x2'], 'not webapp-wt: a prefix ends at a /');
    assert.deepEqual(ids(filterSessions(LIST, { cwd: '~/code/webapp/' }, { home: HOME })), ['c1', 'c2', 'x2']);
    assert.deepEqual(ids(filterSessions(LIST, { cwd: '~/code/./webapp//' }, { home: HOME })), ['c1', 'c2', 'x2']);
    assert.deepEqual(ids(filterSessions(LIST, { cwd: '~' }, { home: HOME })), ['c1', 'c2', 'c3', 'x1', 'x2', 'h1'], 'sessions with no cwd never match a cwd filter');
    assert.throws(() => filterSessions(LIST, { cwd: 'code/webapp' }, { home: HOME }), /cwd must be absolute or start with ~\//);
    assert.throws(() => filterSessions(LIST, { cwd: '~/x' }, { home: null }), /the home folder is not known here/);
  });

  test('cwd: a symlinked folder also matches the real path its sessions report', async () => {
    const real = path.join(tmp, 'real'), link = path.join(tmp, 'link');
    await mkdir(path.join(real, 'sub'), { recursive: true }); await symlink(real, link);
    assert.deepEqual(cwdRoots(`${link}/`, HOME), [link, real]);
    const list = [{ id: 'a', cwd: path.join(real, 'sub') }, { id: 'b', cwd: path.join(tmp, 'other') }];
    assert.deepEqual(ids(filterSessions(list, { cwd: link }, { home: HOME })), ['a']);
  });

  test('name: a substring in any case; a session without a name never matches', () => {
    assert.deepEqual(ids(filterSessions(LIST, { name: 'WEBAPP' })), ['c1', 'x2']);
    assert.deepEqual(ids(filterSessions(LIST, { name: 'review b' })), ['c2']);
  });

  test('engine: one, or several comma-separated, in any case', () => {
    assert.deepEqual(ids(filterSessions(LIST, { engine: 'codex' })), ['x1', 'x2']);
    assert.deepEqual(ids(filterSessions(LIST, { engine: 'Grok, codex' })), ['x1', 'x2', 'g1']);
    assert.deepEqual(ids(filterSessions(LIST, { engine: 'openclaw' })), []);
  });

  test('live: true or false (also as strings, from a URL); anything else is refused', () => {
    assert.deepEqual(ids(filterSessions(LIST, { live: true })), ['c1', 'c3', 'x2', 'h1']);
    assert.deepEqual(ids(filterSessions(LIST, { live: 'false' })), ['c2', 'x1', 'g1', 't1']);
    assert.throws(() => filterSessions(LIST, { live: 'yes' }), /live must be true or false/);
  });

  test('limit: the most recently active first, whatever the time field; matched counts before the cut', () => {
    const r = filterSessions(LIST, { limit: 4 });
    assert.deepEqual(ids(r), ['h1', 'x2', 'c1', 'c3'], 'an ISO start (09:30Z), Codex seconds (09:28:20) and Claude milliseconds (09:28:04) on one clock');
    assert.equal(r.matched, LIST.length);
    assert.deepEqual(filterSessions(LIST, { engine: 'claude', live: true, limit: 0 }), { sessions: [], matched: 3 }, 'limit 0: just the count');
    for (const bad of [-1, 2.5, 'ten']) assert.throws(() => filterSessions(LIST, { limit: bad }), /limit must be a whole number/);
    assert.deepEqual(ids(filterSessions(LIST, { engine: 'codex' })), ['x1', 'x2'], 'without limit the list keeps its own order');
  });

  test('filters combine; the input list is not changed', () => {
    const before = JSON.stringify(LIST);
    assert.deepEqual(filterSessions(LIST, { cwd: '~/code', engine: 'claude', live: true, limit: 5 }, { home: HOME }), { sessions: [LIST[0], LIST[2]], matched: 2 });
    assert.equal(JSON.stringify(LIST), before);
  });

  test('activityMs reads every shape; filtersGiven ignores compact, includeRecent and empty values', () => {
    assert.equal(activityMs({ updatedAt: 1_792_658_735 }), 1_792_658_735_000);
    assert.equal(activityMs({ updatedAt: 1_792_661_284_197 }), 1_792_661_284_197);
    assert.equal(activityMs({ lastSeenAt: '2026-10-20T20:13:40.513Z' }), Date.parse('2026-10-20T20:13:40.513Z'));
    assert.equal(activityMs({}), 0);
    assert.equal(filtersGiven({}), false);
    assert.equal(filtersGiven({ compact: true, includeRecent: true, host: 'x' }), false);
    assert.equal(filtersGiven({ name: '', cwd: null }), false);
    for (const k of ['cwd', 'name', 'engine', 'live', 'limit']) assert.equal(filtersGiven({ [k]: k === 'live' ? false : k === 'limit' ? 0 : 'x' }), true, k);
  });
});

// ---------------------------------------------------------------- drover_sessions

const req = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });
function serverWith(answer) {
  const calls = [];
  const s = createServer({ dispatch: async (op, args) => { calls.push({ op, args }); return answer(args); }, log: () => {} });
  const call = async (args) => { const r = await s.handleMessage(req(1, 'tools/call', { name: 'drover_sessions', arguments: args })); assert.equal(r.result.isError, false, r.result.content[0].text); return JSON.parse(r.result.content[0].text); };
  return { calls, call };
}

describe('drover_sessions', () => {
  test('compact and the filters go to sessions.list as given, with includeRecent false; nothing undefined is added', async () => {
    const { calls, call } = serverWith(() => ({ sessions: [], matched: 0, host: 'h' }));
    await call({ host: 'box-a', compact: true, cwd: '~/code/billing', name: 'ws', engine: 'claude', live: true, limit: 5 });
    await call({});
    assert.deepEqual(calls, [
      { op: 'sessions.list', args: { includeRecent: false, host: 'box-a', compact: true, cwd: '~/code/billing', name: 'ws', engine: 'claude', live: true, limit: 5 } },
      { op: 'sessions.list', args: { includeRecent: false } },
    ]);
  });

  test('a filtered answer (it has matched) comes back as the host sent it', async () => {
    const answer = { sessions: [LIST[0]], matched: 7, host: 'box-a', codexError: null };
    const { call } = serverWith(() => answer);
    assert.deepEqual(await call({ host: 'box-a', engine: 'claude', limit: 1 }), answer);
  });

  test('an answer from Drover code that predates the filters is filtered here and says so', async () => {
    const { call } = serverWith(() => ({ sessions: LIST, codexError: null, host: 'h' }));
    const local = await call({ engine: 'codex', live: false });
    assert.deepEqual(local.sessions.map((s) => s.id), ['x1']);
    assert.equal(local.matched, 1);
    assert.match(local.note, /predates sessions\.list filters/);
    const abs = await call({ host: 'box-a', cwd: '/home/u/code/webapp', limit: 2 });
    assert.deepEqual(abs.sessions.map((s) => s.id), ['x2', 'c1'], 'an absolute cwd works for any host');
    const tilde = await call({ host: 'box-a', cwd: '~/code/webapp', engine: 'grok' });
    assert.deepEqual(tilde.sessions.map((s) => s.id), ['g1'], 'the other filters still apply');
    assert.match(tilde.note, /cwd ~\/code\/webapp was not applied, because ~ is box-a's home/);
    const none = await call({});
    assert.equal(none.note, undefined, 'no filter asked: nothing to do here');
  });
});
