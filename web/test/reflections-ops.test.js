// The reflections ops behind the op table: writes record the caller's actor in the truth file (and pass it to
// the CLI as --agent), an apply batch is summarized there without its bodies, and reflections.semantic maps
// search hits to actionable items, falling back to the CLI's keyword search when the index cannot answer.
// A temp truth file, cache dir and fake CLI keep the real ones untouched.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(tmpdir(), 'drover-refl-ops-'));
process.env.DROVER_EVENTS = path.join(dir, 'events.jsonl');   // before core/events.js reads it
process.env.DROVER_CACHE = path.join(dir, 'cache');
process.env.DROVER_REFLECTIONS_BIN = path.join(dir, 'reflections');
await writeFile(process.env.DROVER_EVENTS, '');
await writeFile(process.env.DROVER_REFLECTIONS_BIN, `#!${process.execPath}
const fs = require('fs'), path = require('path');
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify({ argv, stdin: fs.readFileSync(0, 'utf8') }) + '\\n');
const rest = argv.includes('--') ? argv.slice(argv.indexOf('--') + 1) : [];
if (argv[0] === 'search') process.stdout.write(JSON.stringify([{ id: 'abcd2345', source: 'reflection', kind: 'gotcha', status: 'open', repo: 'webapp', title: 'Breaker', snippet: '[breaker]', updated_at: '2026-10-17T00:00:00Z', session_id: 's1', origin: 'sessionend' }]));
else if (argv[0] === 'apply') process.stdout.write(JSON.stringify({ applied: [], skipped: [] }));
else for (const id of rest) process.stdout.write('#' + id + ' \\u2192 done  title\\n');
`);
await chmod(process.env.DROVER_REFLECTIONS_BIN, 0o755);
const api = await import('../core/api.js');
const { readAll } = await import('../core/events.js');
const { OWNER } = await import('../core/owner.js');

after(async () => { await rm(dir, { recursive: true, force: true }); });
const cliCalls = async () => (await readFile(path.join(dir, 'calls.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const opEvents = async (op) => (await readAll(process.env.DROVER_EVENTS)).filter((e) => e.type === 'op' && e.op === op);

describe('writes through the op table', () => {
  test('a write from the MCP server records actor mcp in the truth file and reaches the CLI as --agent', async () => {
    const { result } = await api.dispatchCached('reflections.mark', { op: 'done', ids: ['abcd2345'], note: 'shipped', actor: 'mcp' });
    assert.deepEqual(result.marked, [{ id: 'abcd2345', status: 'done', title: 'title' }]);
    const [ev] = await opEvents('reflections.mark');
    assert.equal(ev.actor, 'mcp');
    assert.deepEqual(ev.args, { op: 'done', ids: ['abcd2345'], note: 'shipped', actor: 'mcp' });
    assert.deepEqual((await cliCalls()).at(-1).argv, ['done', '--note=shipped', '--agent=mcp', '--', 'abcd2345']);
  });
  test('without an actor (the UI) the truth file names the owner (DROVER_OWNER) and the CLI detects the agent itself', async () => {
    await api.dispatchCached('reflections.mark', { op: 'drop', ids: ['efgh2345'] });
    assert.equal((await opEvents('reflections.mark')).at(-1).actor, OWNER);
    assert.deepEqual((await cliCalls()).at(-1).argv, ['drop', '--', 'efgh2345']);
  });
  test('an apply batch is summarized as op and id per entry: edit bodies stay out of the truth file', async () => {
    const ops = [{ op: 'edit', id: 'abcd2345', body: 'a long new body '.repeat(50) }, { op: 'done', id: 'efgh2345', note: 'n' }];
    await api.dispatchCached('reflections.apply', { ops, anyRepo: true, actor: 'mcp' });
    const ev = (await opEvents('reflections.apply')).at(-1);
    assert.deepEqual(ev.args.ops, [{ op: 'edit', id: 'abcd2345' }, { op: 'done', id: 'efgh2345' }]);
    assert.equal(ev.actor, 'mcp');
    assert.deepEqual(JSON.parse((await cliCalls()).at(-1).stdin), ops, 'the CLI still gets the whole batch');
  });
});

describe('reflections.semantic', () => {
  test('restricts the search to reflections, passes repo, status and kind as filters, and returns actionable items', async () => {
    const real = api.local['search.semantic'];
    let seen = null;
    api.local['search.semantic'] = async (args) => { seen = args; return { host: 'laptop', query: args.query, vector: 'ok', notes: [], reflectionsIndexed: true, results: [{ kind: 'reflection', ref: 'abcd2345', id: 'abcd2345', status: 'stale', repo: 'webapp', project: 'webapp', role: 'action', title: 'Rotate the token', snippet: 'Rotate the token…', score: 0.031, ts: '2026-10-17T00:00:00Z', origin: 'precompact', sessionId: 's1' }] }; };
    try {
      const r = await api.dispatch('reflections.semantic', { query: 'token rotation', repo: 'webapp', status: 'open,stale', kind: 'action', limit: 5 });
      assert.deepEqual(seen, { query: 'token rotation', kinds: ['reflection'], limit: 5, project: 'webapp', status: 'open,stale', role: 'action' });
      assert.deepEqual(r, { host: 'laptop', query: 'token rotation', vector: 'ok', notes: [], items: [{ id: 'abcd2345', status: 'stale', repo: 'webapp', kind: 'action', title: 'Rotate the token', snippet: 'Rotate the token…', score: 0.031, updatedAt: '2026-10-17T00:00:00Z', origin: 'precompact', sessionId: 's1' }] });
      await assert.rejects(api.dispatch('reflections.semantic', { query: 'x', kind: 'chore' }), /kind must be one of/);
      await assert.rejects(api.dispatch('reflections.semantic', { query: 'x', status: 'closed' }), /status must be/);
      await assert.rejects(api.dispatch('reflections.semantic', { query: ' ' }), /query must be a non-empty string/);
    } finally { api.local['search.semantic'] = real; }
  });
  test('an index that has not finished a reflections pass would answer with nothing: the CLI answers instead', async () => {
    const real = api.local['search.semantic'];
    api.local['search.semantic'] = async (args) => ({ host: 'laptop', query: args.query, vector: 'ok', notes: [], results: [], reflectionsIndexed: false });
    try {
      const r = await api.dispatch('reflections.semantic', { query: 'breaker' });
      assert.match(r.notes[0], /^reflections are not indexed on laptop yet; these are the reflections CLI's keyword matches$/);
      assert.deepEqual(r.items.map((x) => x.id), ['abcd2345']);
    } finally { api.local['search.semantic'] = real; }
  });
  test('a daemon from before reflections were indexed (no flag, transcripts back): the CLI answers, and no transcript is passed off as a reflection', async () => {
    const real = api.local['search.semantic'];
    api.local['search.semantic'] = async (args) => ({ host: 'devbox', query: args.query, vector: 'ok', notes: [], results: [{ kind: 'claude', ref: 'uuid-1', sessionId: 's9', title: 'a session', snippet: 'breaker talk', score: 0.03, ts: '2026-10-17T00:00:00Z' }] });
    try {
      const r = await api.dispatch('reflections.semantic', { query: 'breaker' });
      assert.match(r.notes[0], /not indexed on devbox yet/);
      assert.deepEqual(r.items.map((x) => x.id), ['abcd2345']);
    } finally { api.local['search.semantic'] = real; }
  });
  test('an indexed host with no match answers empty, without asking the CLI', async () => {
    const real = api.local['search.semantic'];
    api.local['search.semantic'] = async (args) => ({ host: 'laptop', query: args.query, vector: 'ok', notes: [], results: [], reflectionsIndexed: true });
    const before = (await cliCalls()).length;
    try {
      const r = await api.dispatch('reflections.semantic', { query: 'nothing like this' });
      assert.deepEqual(r.items, []); assert.deepEqual(r.notes, []);
      assert.equal((await cliCalls()).length, before);
    } finally { api.local['search.semantic'] = real; }
  });
  test('when the index cannot answer, the CLI\'s keyword search does, and the result says so', async () => {
    const real = api.local['search.semantic'];
    api.local['search.semantic'] = async () => { throw new Error('search is disabled on laptop (DROVER_SEARCH=off)'); };
    try {
      const r = await api.dispatch('reflections.semantic', { query: 'breaker', repo: 'webapp', status: 'open' });
      assert.equal(r.vector, 'off');
      assert.match(r.notes[0], /could not answer \(search is disabled/);
      assert.deepEqual(r.items, [{ id: 'abcd2345', status: 'open', repo: 'webapp', kind: 'gotcha', title: 'Breaker', snippet: '[breaker]', score: null, updatedAt: '2026-10-17T00:00:00Z', origin: 'sessionend', sessionId: 's1' }]);
      assert.deepEqual((await cliCalls()).at(-1).argv, ['search', '--json', '--repo=webapp', '--status=open', '--source=reflection', '--limit=20', '--', 'breaker']);
    } finally { api.local['search.semantic'] = real; }
  });
});
