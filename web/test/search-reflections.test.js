// Reflections as a search source: the indexer runs a fake `reflections` CLI (a node script that serves
// `export` from items.json, honours --since like the real one, and logs every argv), so no dotfiles,
// python or model is needed. A bag-of-words embedder stands in for llama-server.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../core/search/store.js';
import { Indexer } from '../core/search/indexer.js';
import { search, mergeHosts } from '../core/search/query.js';
import { formatResults } from '../core/search/format.js';
import { truncateNormalize } from '../core/search/vec.js';

const FAKE_CLI = `#!${process.execPath}
// Fake reflections CLI: 'export [--since=T]' prints items.json as JSON Lines (updated_at >= T), every call is
// logged to calls.jsonl, and the mode file makes it fail (exit 2) or cut its output off mid-line.
const fs = require('fs'), path = require('path');
const dir = __dirname, argv = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify(argv) + '\\n');
const mode = fs.existsSync(path.join(dir, 'mode')) ? fs.readFileSync(path.join(dir, 'mode'), 'utf8').trim() : '';
if (mode === 'fail') { process.stderr.write('reflections: index is locked\\n'); process.exit(2); }
if (argv[0] !== 'export') { process.stderr.write('reflections: unexpected command ' + argv[0] + '\\n'); process.exit(2); }
const since = (argv.find((a) => a.startsWith('--since=')) || '').slice(8);
for (const it of JSON.parse(fs.readFileSync(path.join(dir, 'items.json'), 'utf8'))) if (!since || it.updated_at >= since) process.stdout.write(JSON.stringify(it) + '\\n');
if (mode === 'garbage') process.stdout.write('{"id":"cut-off-mid-li');
`;

const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString().replace(/\.\d{3}Z$/, 'Z');
const item = (id, o = {}) => ({ id, source: 'reflection', kind: 'gotcha', status: 'open', repo: 'webapp', title: `title ${id}`, body: `body ${id}`, tags: [], priority: null, session_id: 'sess-1', host: 'laptop', agent: 'claude', origin: 'sessionend', cwd: '/Users/x/code/webapp', branch: 'dev', created_at: iso(7200_000), updated_at: iso(3600_000), done_at: null, path: '/x/webapp/reflections', notes: [], ...o });

function bagVec(text) {
  const v = new Float32Array(768);
  for (const w of String(text).toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (['task', 'search', 'result', 'query', 'title', 'text', 'none'].includes(w)) continue;
    let h = 7; for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    v[h % 256] += 1;
  }
  return v;
}
const fakeEmbedder = () => ({ batch: 8, inputs: 0, installed: () => true, async embed(texts) { this.inputs += texts.length; return texts.map((t) => truncateNormalize(bagVec(t))); } });

let dir, items, store, emb, idx, logs, wal;
const cliPath = () => path.join(dir, 'reflections');
const setItems = async (list) => { items = list; await writeFile(path.join(dir, 'items.json'), JSON.stringify(list)); };
const setMode = (m) => writeFile(path.join(dir, 'mode'), m);
const calls = async () => (await readFile(path.join(dir, 'calls.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const chunk = (id) => store.db.prepare('SELECT * FROM chunks WHERE path = ?').all(`reflection:${id}`);
const reflChunks = () => store.db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE kind = 'reflection'").get().n;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'drover-refl-search-'));
  await writeFile(cliPath(), FAKE_CLI); await chmod(cliPath(), 0o755);
  await setItems([
    item('brk12345', { title: 'Circuit breaker trips after five seconds', body: 'The breaker in embedding-service.ts uses a 5 s timeout.', tags: ['breaker', 'timeout'] }),
    item('lrn23456', { kind: 'learning', status: 'note', repo: 'drover', title: 'node:sqlite has FTS5 on every box', body: 'Verified on the fleet.', session_id: 'sess-2', origin: 'reflect' }),
    item('act34567', { kind: 'action', status: 'stale', title: 'Rotate the bedrock token', body: 'Old token expires soon.' }),
  ]);
  wal = path.join(dir, 'drover-events.jsonl');
  await writeFile(wal, '');
  store = new Store(path.join(dir, 'search.sqlite'));
  emb = fakeEmbedder();
  logs = [];
  idx = new Indexer({ store, embedder: emb, roots: { claude: null, codex: null, wal, reflections: cliPath() }, log: (m) => logs.push(m) });
});
after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });

describe('indexing reflections', () => {
  test('the first pass exports everything (no --since): one chunk per item at reflection:<id>, state beside it', async () => {
    const r = await idx.tick();
    assert.deepEqual((await calls()).at(-1), ['export']);
    assert.equal(r.added, 3);
    assert.equal(reflChunks(), 3);
    const [c] = chunk('brk12345');
    assert.equal(c.kind, 'reflection'); assert.equal(c.ref, 'brk12345'); assert.equal(c.project, 'webapp'); assert.equal(c.role, 'gotcha');
    assert.equal(c.session_id, 'sess-1'); assert.equal(c.title, 'Circuit breaker trips after five seconds'); assert.equal(c.ts, items[0].updated_at);
    assert.equal(c.text, 'Circuit breaker trips after five seconds\n\nThe breaker in embedding-service.ts uses a 5 s timeout.\n\ntags: breaker timeout\n\n#brk12345');
    assert.ok(!/\bopen\b/.test(c.text), 'the status is not part of the text');
    const state = store.reflectionStates();
    assert.equal(state.get('lrn23456').status, 'note'); assert.equal(state.get('act34567').status, 'stale'); assert.equal(state.get('lrn23456').repo, 'drover');
    assert.equal(store.stats().kinds.reflection.chunks, 3);
    assert.equal(emb.inputs, 3); assert.equal(store.pendingCount(), 0);
    assert.equal(idx.status().reflections.full, true); assert.equal(idx.status().reflections.exported, 3);
  });

  test('the next pass the same day asks only for a day behind its cursor; an unchanged store changes nothing', async () => {
    const r = await idx.tick();
    const last = (await calls()).at(-1);
    assert.equal(last[0], 'export'); assert.match(last[1], /^--since=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/, 'whole seconds, the CLI\'s own format');
    const since = Date.parse(last[1].slice(8));
    assert.ok(Math.abs(Date.now() - 24 * 3600_000 - since) < 120_000, `since ${last[1]} is a day back`);
    assert.equal(r.added, 0); assert.equal(idx.status().reflections.changed, 0); assert.equal(emb.inputs, 3);
  });

  test('a status change moves the state and keeps the vector; search shows the item\'s id, new status and repo', async () => {
    const vectors = store.stats().vectors;
    await setItems(items.map((it) => (it.id === 'brk12345' ? { ...it, status: 'done', done_at: iso(), updated_at: iso(), notes: ['fixed in !5678'] } : it)));
    const r = await idx.tick();
    assert.equal(r.added, 0, 'no new text');
    assert.equal(emb.inputs, 3, 'nothing re-embedded');
    assert.equal(store.stats().vectors, vectors);
    assert.equal(store.reflectionStates().get('brk12345').status, 'done');
    assert.equal(chunk('brk12345')[0].ts, items[0].updated_at, 'the chunk carries the new updated_at');
    const res = await search(store, { embed: (t) => emb.embed(t) }, { query: 'breaker timeout', kinds: ['reflection'] });
    const hit = res.results.find((x) => x.ref === 'brk12345');
    assert.ok(hit, JSON.stringify(res.results));
    assert.deepEqual([hit.id, hit.status, hit.repo, hit.kind, hit.role, hit.sessionId], ['brk12345', 'done', 'webapp', 'reflection', 'gotcha', 'sess-1']);
    assert.match(formatResults({ host: 'h', ms: 1, ...res }), /reflection brk12345 \(done\)/);
  });

  test('a state row whose chunk went missing gets the chunk back on the next change', async () => {
    store.db.prepare('DELETE FROM chunks WHERE path = ?').run('reflection:lrn23456');
    await setItems(items.map((it) => (it.id === 'lrn23456' ? { ...it, status: 'dropped', updated_at: iso() } : it)));
    await idx.tick();
    const [c] = chunk('lrn23456');
    assert.ok(c, 'restored'); assert.equal(c.ts, items[1].updated_at); assert.match(c.text, /^node:sqlite has FTS5 on every box/);
    assert.equal(store.reflectionStates().get('lrn23456').status, 'dropped');
  });

  test('an edited title re-embeds that item alone, and its old vector is collected', async () => {
    await setItems(items.map((it) => (it.id === 'act34567' ? { ...it, title: 'Rotate the bedrock bearer token before Friday', updated_at: iso() } : it)));
    const inputs = emb.inputs;
    const r = await idx.tick();
    assert.equal(r.added, 1); assert.equal(emb.inputs, inputs + 1);
    assert.match(chunk('act34567')[0].text, /^Rotate the bedrock bearer token before Friday\n\n/);
    assert.equal(chunk('act34567').length, 1);
    const st = store.stats();
    assert.equal(st.vectors, st.distinct, 'the replaced text\'s vector is gone');
  });
});

describe('searching reflections', () => {
  before(async () => {
    const osprey = Array.from({ length: 5 }, (_, i) => item(`osp${i}0000`, { title: `Osprey nest count ${i}`, body: `osprey survey note ${i}`, status: i % 2 ? 'open' : 'note', kind: i % 2 ? 'action' : 'learning', updated_at: iso() }));
    await setItems([...items, ...osprey]);
    await idx.tick();
  });
  test('each reflection is its own record: five from one session are not capped at three', async () => {
    const r = await search(store, null, { query: 'osprey nest', kinds: ['reflection'], limit: 20 });
    assert.equal(r.results.filter((x) => x.ref.startsWith('osp')).length, 5);
    assert.ok(r.results.every((x) => x.kind === 'reflection' && x.id === x.ref && x.status && x.repo === 'webapp'));
  });
  test('two items with the same words (another repo, a closed twin) stay two hits with their own ids, through the fleet merge too', async () => {
    const twin = { title: 'Pin the heron feeder schedule', body: 'Feed at dawn only.', tags: ['heron'], updated_at: iso() };
    await setItems([...items, item('twin2345', { ...twin, repo: 'webapp' }), item('twin6789', { ...twin, repo: 'code', status: 'done' })]);
    await idx.tick();
    const r = await search(store, { embed: (t) => emb.embed(t) }, { query: 'heron feeder schedule', kinds: ['reflection'] });
    const twins = (list) => list.filter((x) => x.id?.startsWith('twin'));
    assert.deepEqual(twins(r.results).map((x) => [x.id, x.repo, x.status]).sort(), [['twin2345', 'webapp', 'open'], ['twin6789', 'code', 'done']]);
    assert.deepEqual(r.results.slice(0, 2).map((x) => x.id).sort(), ['twin2345', 'twin6789'], 'both rank first');
    assert.ok(twins(r.results).every((x) => x.copies === undefined), 'not copies of one text');
    const fleet = twins(mergeHosts([{ host: 'laptop', results: r.results }, { host: 'devbox', results: r.results }]));
    assert.deepEqual(fleet.map((x) => x.id).sort(), ['twin2345', 'twin6789'], 'the same item on two hosts folds; two items do not');
    assert.deepEqual(fleet.map((x) => x.hosts.length), [2, 2]);
    const byId = await search(store, null, { query: 'twin6789' });
    assert.equal(byId.results[0].id, 'twin6789', 'an id finds its item');
  });
  test('status filters to reflections with that status; role filters by kind', async () => {
    const open = await search(store, null, { query: 'osprey nest', status: 'open', limit: 20 });
    assert.deepEqual(open.results.map((x) => x.ref).sort(), ['osp10000', 'osp30000']);
    const both = await search(store, null, { query: 'osprey nest', status: 'open,note', limit: 20 });
    assert.equal(both.results.length, 5);
    const learnings = await search(store, null, { query: 'osprey nest', kinds: ['reflection'], role: 'learning', limit: 20 });
    assert.deepEqual(learnings.results.map((x) => x.ref).sort(), ['osp00000', 'osp20000', 'osp40000']);
    const repo = await search(store, null, { query: 'fts5 sqlite', kinds: 'reflection', project: 'drover' });
    assert.deepEqual(repo.results.map((x) => x.id), ['lrn23456']);
  });
});

describe('the daily full export and failures', () => {
  test('a new UTC day re-exports everything: derived statuses flip, and items the store no longer has are dropped', async () => {
    store.setMeta('reflections_day', '2026-01-01');
    // osp40000 went stale with the clock (same updated_at, no event); osp30000 is gone from the store.
    await setItems(items.filter((it) => it.id !== 'osp30000').map((it) => (it.id === 'osp40000' ? { ...it, status: 'stale' } : it)));
    const inputs = emb.inputs;
    await idx.tick();
    assert.deepEqual((await calls()).at(-1), ['export'], 'no --since on the daily pass');
    assert.equal(store.reflectionStates().get('osp40000').status, 'stale');
    assert.equal(chunk('osp30000').length, 0); assert.equal(store.reflectionStates().has('osp30000'), false);
    assert.equal(idx.status().reflections.removed, 1);
    assert.equal(emb.inputs, inputs, 'a status flip re-embeds nothing');
    const st = store.stats();
    assert.equal(st.vectors, st.distinct, 'the dropped item\'s vector is collected');
    assert.equal(store.getMeta('reflections_day'), new Date().toISOString().slice(0, 10));
  });

  test('an empty full export while the index holds reflections drops nothing (a broken CLI environment, not an empty store)', async () => {
    const before = reflChunks();
    store.setMeta('reflections_day', '2026-01-01');
    const saved = items;
    await setItems([]);
    await idx.tick();
    assert.equal(reflChunks(), before);
    await setItems(saved);
  });

  test('a failing CLI never fails the pass: other sources still index, the error is logged once, the cursor stays', async () => {
    const cursor = store.getMeta('reflections_since');
    await setMode('fail');
    await appendFile(wal, JSON.stringify({ id: 'ev-heron', ts: iso(), type: 'note', about: 'heron', text: 'heron nesting season starts' }) + '\n');
    const r = await idx.tick();
    assert.equal(r.skipped, undefined);
    assert.equal(idx.status().lastError, null, 'the pass itself succeeded');
    assert.match(idx.status().reflections.lastError, /index is locked/);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE kind = 'wal' AND ref = 'ev-heron'").get().n, 1, 'the truth file was still read');
    await idx.tick();
    assert.equal(logs.filter((m) => /reflections skipped/.test(m)).length, 1, 'one log line for a repeating failure');
    assert.equal(store.getMeta('reflections_since'), cursor);
  });

  test('output cut off mid-line is a failed export, not a smaller store', async () => {
    const before = reflChunks();
    store.setMeta('reflections_day', '2026-01-01');
    await setMode('garbage');
    await idx.tick();
    assert.match(idx.status().reflections.lastError, /not JSON/);
    assert.equal(reflChunks(), before);
    assert.equal(store.getMeta('reflections_day'), '2026-01-01', 'the daily pass is retried');
    await setMode('');
    await idx.tick();
    assert.equal(idx.status().reflections.lastError, null);
    assert.equal(idx.status().reflections.full, true);
  });

  test('reflections are indexed first in a pass: a transcript source that fails does not keep them out', async () => {
    const s2 = new Store(path.join(dir, 'first.sqlite'));
    const realAdd = s2.addChunks.bind(s2);
    s2.addChunks = () => { throw new Error('disk I/O error'); };   // every file source stores through addChunks
    const i2 = new Indexer({ store: s2, embedder: null, roots: { claude: null, codex: null, wal, reflections: cliPath() }, log: () => {} });
    await i2.tick();
    assert.match(i2.status().lastError, /disk I\/O error/, 'the truth file failed the pass');
    assert.ok(s2.db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE kind = 'reflection'").get().n > 0, 'the reflections were already in');
    s2.addChunks = realAdd;
    s2.close();
  });

  test('a failure while storing reflections is logged and skipped: the rest of the pass still runs', async () => {
    const s3 = new Store(path.join(dir, 'store-fail.sqlite'));
    s3.upsertReflections = () => { throw new Error('database is locked'); };
    const seen = [];
    const i3 = new Indexer({ store: s3, embedder: null, roots: { claude: null, codex: null, wal, reflections: cliPath() }, log: (m) => seen.push(m) });
    await i3.tick();
    assert.equal(i3.status().lastError, null, 'the pass itself succeeded');
    assert.match(i3.status().reflections.lastError, /database is locked/);
    assert.ok(seen.some((m) => /reflections skipped: database is locked/.test(m)));
    assert.equal(s3.getMeta('reflections_day'), null, 'not marked done, so the next pass tries again');
    assert.ok(s3.db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE kind = 'wal'").get().n > 0, 'the truth file was still read');
    s3.close();
  });

  test('a missing CLI is skipped quietly', async () => {
    const blind = new Indexer({ store, embedder: emb, roots: { claude: null, codex: null, wal: null, reflections: path.join(dir, 'no-such-cli') }, log: () => {} });
    const r = await blind.tick();
    assert.equal(blind.status().lastError, null);
    assert.match(blind.status().reflections.lastError, /reflections CLI missing/);
    assert.equal(r.added, 0);
  });
});
