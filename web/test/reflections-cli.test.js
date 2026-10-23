// The reflections CLI adapter (core/memory.js) against a fake CLI: what argv and stdin each call builds,
// what is refused before anything runs, and how the CLI's own errors come back. DROVER_REFLECTIONS_BIN
// points at the fake (read per call), so no dotfiles or python is involved. DROVER_DEFAULT_REPO (read per call) is
// the repo a call that names none means: webapp here, whatever the environment running the tests sets.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as memory from '../core/memory.js';

const FAKE_CLI = `#!${process.execPath}
// Fake reflections CLI: logs {argv, stdin} to calls.jsonl and answers each command the way the real one does.
const fs = require('fs'), path = require('path');
const argv = process.argv.slice(2);
const stdin = fs.readFileSync(0, 'utf8');
fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify({ argv, stdin }) + '\\n');
const flag = (n) => { const a = argv.find((x) => x.startsWith('--' + n + '=')); return a === undefined ? undefined : a.slice(n.length + 3); };
const rest = argv.includes('--') ? argv.slice(argv.indexOf('--') + 1) : [];
const die = (m) => { process.stderr.write('reflections: ' + m + '\\n'); process.exit(2); };
const out = (o) => process.stdout.write(typeof o === 'string' ? o : JSON.stringify(o) + '\\n');
switch (argv[0]) {
  case 'list': out([{ id: 'abcd2345', status: flag('status') || 'open' }]); break;
  case 'repos': out([{ repo: 'webapp', o: 3, s: 2, d: 5, n: 7, last: '2026-10-18T00:00:00Z' }]); break;
  case 'search': out([{ id: 'abcd2345', snippet: '[' + rest.join(' ') + ']' }]); break;
  case 'show': if (rest[0] === 'missing') die("no reflection matches id 'missing'"); out({ id: rest[0], title: 'T', notes: '' }); break;
  case 'add': out({ repo: flag('repo'), log: '/x/reflections/h.jsonl', items: [flag('title') === 'dup' ? { id: 'olditem2', title: 'dup', duplicate: true } : { id: 'newitem2', title: flag('title') }] }); break;
  case 'done': case 'reopen': case 'drop': {
    const st = { done: 'done', reopen: 'open', drop: 'dropped' }[argv[0]];
    for (const id of rest) { if (id === 'bad') die("no reflection matches id 'bad'"); out('#' + id + ' \\u2192 ' + st + '  title of ' + id + '\\n'); }
    break;
  }
  case 'edit': out('#' + rest[0] + ' edited\\n'); break;
  case 'apply': { const ops = JSON.parse(stdin); out({ applied: ops.map((o) => ({ id: o.id, op: o.op, title: 't' })), skipped: [] }); break; }
  case 'candidates': { const f = flag('query-file'); out({ repo: flag('repo'), terms: f ? ['file:' + fs.readFileSync(f, 'utf8').length] : rest, items: [] }); break; }
  case 'export': out(JSON.stringify({ id: 'abcd2345', updated_at: '2026-10-17T00:00:00Z' }) + '\\n' + JSON.stringify({ id: 'efgh2345', updated_at: '2026-10-18T00:00:00Z' }) + '\\n' + (flag('since') === 'cut' ? '{"id":' : '')); break;
  default: die('unknown command ' + argv[0]);
}
`;

let dir, savedDefault;
const calls = async () => { const f = path.join(dir, 'calls.jsonl'); return existsSync(f) ? (await readFile(f, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; };
const last = async () => (await calls()).at(-1);

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'drover-refl-cli-'));
  await writeFile(path.join(dir, 'reflections'), FAKE_CLI); await chmod(path.join(dir, 'reflections'), 0o755);
  process.env.DROVER_REFLECTIONS_BIN = path.join(dir, 'reflections');
  savedDefault = { DROVER_DEFAULT_REPO: process.env.DROVER_DEFAULT_REPO, APXW_DEFAULT_REPO: process.env.APXW_DEFAULT_REPO };
  process.env.DROVER_DEFAULT_REPO = 'webapp'; delete process.env.APXW_DEFAULT_REPO;
});
beforeEach(async () => { await rm(path.join(dir, 'calls.jsonl'), { force: true }); });
after(async () => {
  delete process.env.DROVER_REFLECTIONS_BIN;
  for (const [k, v] of Object.entries(savedDefault)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await rm(dir, { recursive: true, force: true });
});

describe('reading', () => {
  test('list: filters as --name=value flags, --all instead of a repo, --json last', async () => {
    const r = await memory.reflectionsList('webapp', { status: 'open,stale', kind: 'action', session: 's1', limit: 5 });
    assert.deepEqual(r.items, [{ id: 'abcd2345', status: 'open,stale' }]);
    assert.deepEqual((await last()).argv, ['list', '--repo=webapp', '--status=open,stale', '--kind=action', '--session=s1', '--limit=5', '--json']);
    await memory.reflectionsList('webapp', { all: true });
    assert.deepEqual((await last()).argv, ['list', '--all', '--json']);
  });
  test('list: the default repo when none is named; all needs neither a repo nor a default', async () => {
    await memory.reflectionsList();
    assert.deepEqual((await last()).argv, ['list', '--repo=webapp', '--json']);
    delete process.env.DROVER_DEFAULT_REPO;
    try {
      await memory.reflectionsList(undefined, { all: true });
      assert.deepEqual((await last()).argv, ['list', '--all', '--json']);
      await assert.rejects(memory.reflectionsList(), /repo is required/);
    } finally { process.env.DROVER_DEFAULT_REPO = 'webapp'; }
  });
  test('list and search keep to this machine\'s identity unless anyIdentity; repos maps the CLI\'s counts', async () => {
    await memory.reflectionsList('webapp', { anyIdentity: true });
    assert.deepEqual((await last()).argv, ['list', '--repo=webapp', '--any-identity', '--json']);
    await memory.reflectionsSearch('breaker', { anyIdentity: true });
    assert.deepEqual((await last()).argv, ['search', '--json', '--any-identity', '--', 'breaker']);
    assert.deepEqual(await memory.reflectionsRepos(), [{ repo: 'webapp', open: 3, stale: 2, done: 5, notes: 7, last: '2026-10-18T00:00:00Z' }]);
    assert.deepEqual((await last()).argv, ['repos', '--json']);
  });
  test('bad filters are refused before the CLI runs', async () => {
    await assert.rejects(memory.reflectionsList('webapp', { status: 'closed' }), /status must be open, stale, done, dropped, note, all/);
    await assert.rejects(memory.reflectionsList('webapp', { kind: 'chore' }), /kind must be/);
    await assert.rejects(memory.reflectionsList('webapp', { limit: 0 }), /limit must be an integer/);
    assert.equal((await calls()).length, 0);
  });
  test('search: --json, filters, then the query after -- (so a query that starts with "-" is not a flag)', async () => {
    const r = await memory.reflectionsSearch('-x breaker', { repo: 'webapp', status: 'all', kind: 'memory', source: 'reflection,memory', limit: 3 });
    assert.deepEqual(r, { items: [{ id: 'abcd2345', snippet: '[-x breaker]' }] });
    assert.deepEqual((await last()).argv, ['search', '--json', '--repo=webapp', '--status=all', '--kind=memory', '--source=reflection,memory', '--limit=3', '--', '-x breaker']);
    await assert.rejects(memory.reflectionsSearch('  '), /query must be a non-empty string/);
  });
  test('show: one item by id (a leading # is dropped); the CLI\'s own error comes back', async () => {
    assert.deepEqual(await memory.reflectionShow('#abcd2345'), { id: 'abcd2345', title: 'T', notes: '' });
    assert.deepEqual((await last()).argv, ['show', '--json', '--', 'abcd2345']);
    await assert.rejects(memory.reflectionShow('missing'), /^Error: reflections show: no reflection matches id 'missing'$/);
  });
  test('candidates: a short text is positional; a long one goes through a private temp file that is removed after', async () => {
    const short = await memory.reflectionsCandidates({ query: 'breaker timeout', session: 's1', limit: 9, notes: 0, closed: 2 });
    assert.deepEqual((await last()).argv, ['candidates', '--json', '--repo=webapp', '--session=s1', '--limit=9', '--notes=0', '--closed=2', '--', 'breaker timeout']);
    assert.deepEqual(short.terms, ['breaker timeout']);
    const long = await memory.reflectionsCandidates({ query: 'x'.repeat(5000), repo: 'drover' });
    assert.deepEqual(long.terms, ['file:5000']);
    const argv = (await last()).argv;
    const file = argv.find((a) => a.startsWith('--query-file=')).slice(13);
    assert.ok(!existsSync(file), 'the temp file is gone');
    assert.deepEqual(argv.slice(0, 3), ['candidates', '--json', '--repo=drover']);
  });
  test('export: JSON Lines parsed, --since passed; a line cut off fails the whole export', async () => {
    const items = await memory.reflectionsExport({ since: '2026-10-17T00:00:00Z' });
    assert.deepEqual(items.map((i) => i.id), ['abcd2345', 'efgh2345']);
    assert.deepEqual((await last()).argv, ['export', '--since=2026-10-17T00:00:00Z']);
    await assert.rejects(memory.reflectionsExport({ since: 'cut' }), /line 3 is not JSON/);
  });
  test('a missing CLI: list reports it in the result (the Memory view shows it), the rest throw', async () => {
    process.env.DROVER_REFLECTIONS_BIN = path.join(dir, 'nope');
    try {
      assert.deepEqual(await memory.reflectionsList('webapp'), { items: [], error: 'reflections CLI missing' });
      await assert.rejects(memory.reflectionShow('abcd2345'), /reflections CLI missing/);
    } finally { process.env.DROVER_REFLECTIONS_BIN = path.join(dir, 'reflections'); }
  });
});

describe('writing', () => {
  test('add: --json, the body on stdin, the actor as --agent; returns the new id', async () => {
    const r = await memory.reflectionAdd({ repo: 'webapp', kind: 'gotcha', title: '-starts with a dash', body: '--body looks like a flag', tags: ['a', 'b'], priority: 2, session: 's1', actor: 'mcp' });
    assert.deepEqual(r, { id: 'newitem2', kind: 'gotcha', title: '-starts with a dash', repo: 'webapp' });
    const c = await last();
    assert.deepEqual(c.argv, ['add', '--json', '--repo=webapp', '--kind=gotcha', '--title=-starts with a dash', '--tags=a,b', '--priority=2', '--session=s1', '--agent=mcp', '--body=-']);
    assert.equal(c.stdin, '--body looks like a flag');
    assert.deepEqual(await memory.reflectionAdd({ title: 'dup' }), { id: 'olditem2', kind: 'note', title: 'dup', repo: 'webapp', duplicate: true });
    assert.deepEqual((await last()).argv, ['add', '--json', '--repo=webapp', '--kind=note', '--title=dup'], 'no body, tags or agent when not given');
    await assert.rejects(memory.reflectionAdd({ title: 'x', kind: 'chore' }), /kind must be one of/);
    await assert.rejects(memory.reflectionAdd({ title: 'x', priority: 9 }), /priority must be an integer from 1 to 5/);
  });
  test('a call that names no repo means DROVER_DEFAULT_REPO; without the setting it is refused before the CLI runs', async () => {
    process.env.DROVER_DEFAULT_REPO = 'billing';
    try {
      assert.equal((await memory.reflectionAdd({ title: 't' })).repo, 'billing');
      assert.deepEqual((await last()).argv, ['add', '--json', '--repo=billing', '--kind=note', '--title=t']);
      delete process.env.DROVER_DEFAULT_REPO;
      await rm(path.join(dir, 'calls.jsonl'), { force: true });
      for (const call of [() => memory.reflectionAdd({ title: 't' }), () => memory.reflectionsCandidates({ query: 'q' }), () => memory.reflectionsList()]) {
        await assert.rejects(call(), /^Error: repo is required \(or set DROVER_DEFAULT_REPO\)$/);
      }
      assert.equal((await calls()).length, 0);
      assert.equal((await memory.reflectionsList('billing')).items.length, 1, 'a call that names its repo needs no setting');
    } finally { process.env.DROVER_DEFAULT_REPO = 'webapp'; }
  });
  test('done/reopen/drop: note and agent, ids after --; the marked items come back', async () => {
    const r = await memory.reflectionMark('done', ['abcd2345', '#efgh2345'], { note: 'shipped in !5678', actor: 'mcp' });
    assert.deepEqual((await last()).argv, ['done', '--note=shipped in !5678', '--agent=mcp', '--', 'abcd2345', 'efgh2345']);
    assert.deepEqual(r.marked, [{ id: 'abcd2345', status: 'done', title: 'title of abcd2345' }, { id: 'efgh2345', status: 'done', title: 'title of efgh2345' }]);
    assert.equal(r.ok, true); assert.equal(r.op, 'done');
    assert.deepEqual((await memory.reflectionMark('reopen', ['abcd2345'])).marked[0].status, 'open');
    assert.deepEqual((await last()).argv, ['reopen', '--', 'abcd2345']);
  });
  test('a failure part-way says which ids were already marked', async () => {
    await assert.rejects(memory.reflectionMark('drop', ['abcd2345', 'bad', 'efgh2345']), /reflections drop: no reflection matches id 'bad' \(already marked drop: abcd2345\)/);
    await assert.rejects(memory.reflectionMark('close', ['abcd2345']), /op must be done\|reopen\|drop/);
    await assert.rejects(memory.reflectionMark('done', []), /ids required/);
  });
  test('edit: changed fields only, the body on stdin, an empty tag list clears the tags', async () => {
    const r = await memory.reflectionEdit({ id: 'abcd2345', title: 'New title', body: '-new body', tags: [], kind: 'idea', priority: 1, actor: 'mcp' });
    assert.deepEqual(r, { ok: true, id: 'abcd2345', text: '#abcd2345 edited' });
    const c = await last();
    assert.deepEqual(c.argv, ['edit', '--title=New title', '--tags=', '--kind=idea', '--priority=1', '--body=-', '--agent=mcp', '--', 'abcd2345']);
    assert.equal(c.stdin, '-new body');
    await memory.reflectionEdit({ id: 'abcd2345', priority: 3 });
    assert.deepEqual((await last()).argv, ['edit', '--priority=3', '--', 'abcd2345']);
    await rm(path.join(dir, 'calls.jsonl'), { force: true });
    await assert.rejects(memory.reflectionEdit({ id: 'abcd2345' }), /nothing to change/);
    await assert.rejects(memory.reflectionEdit({ id: 'abcd2345', kind: 'chore' }), /kind must be one of/);
    assert.equal((await calls()).length, 0, 'refused before the CLI runs');
  });
  test('apply: the ops go in on stdin as JSON; scope is a repo or anyRepo; malformed input never reaches the CLI', async () => {
    const ops = [{ op: 'done', id: 'abcd2345', note: 'fixed' }, { op: 'edit', id: 'efgh2345', title: 'better title' }];
    const r = await memory.reflectionsApply(ops, { repo: 'webapp', note: 'reconciled', actor: 'mcp' });
    assert.deepEqual(r.applied.map((a) => [a.op, a.id]), [['done', 'abcd2345'], ['edit', 'efgh2345']]);
    assert.deepEqual(r.skipped, []);
    const c = await last();
    assert.deepEqual(c.argv, ['apply', '--batch=-', '--json', '--repo=webapp', '--note=reconciled', '--agent=mcp']);
    assert.deepEqual(JSON.parse(c.stdin), ops);
    await memory.reflectionsApply(ops, { anyRepo: true });
    assert.deepEqual((await last()).argv, ['apply', '--batch=-', '--json', '--any-repo']);
    await rm(path.join(dir, 'calls.jsonl'), { force: true });
    await assert.rejects(memory.reflectionsApply({ op: 'done', id: 'abcd2345' }, { repo: 'webapp' }), /ops must be a list/);
    await assert.rejects(memory.reflectionsApply('done abcd2345', { repo: 'webapp' }), /ops must be a list/);
    await assert.rejects(memory.reflectionsApply([], { repo: 'webapp' }), /ops must not be empty/);
    await assert.rejects(memory.reflectionsApply([['done', 'abcd2345']], { repo: 'webapp' }), /ops\[0\] must be an object/);
    await assert.rejects(memory.reflectionsApply(ops, {}), /apply needs repo .* or anyRepo: true/);
    assert.equal((await calls()).length, 0);
  });
});
