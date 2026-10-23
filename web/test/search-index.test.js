// Search index end to end on synthetic files: Store (node:sqlite) + Indexer + search(),
// with a deterministic bag-of-words embedder standing in for llama-server.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store, sha1 } from '../core/search/store.js';
import { Indexer, readNewLines, skipReason } from '../core/search/indexer.js';
import { search, mergeHosts, exactTokens, ftsTerms, ftsExpr, snippet } from '../core/search/query.js';
import { truncateNormalize, quantize } from '../core/search/vec.js';
import { formatResults, formatGrep, resumeHint } from '../core/search/format.js';

const j = (o) => JSON.stringify(o) + '\n';
function bagVec(text) {
  const v = new Float32Array(768);
  for (const w of String(text).toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (['task', 'search', 'result', 'query', 'title', 'text', 'none'].includes(w)) continue;   // the prefixes
    let h = 7; for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    v[h % 256] += 1;
  }
  return v;
}
const fakeEmbedder = () => ({ batch: 4, calls: 0, inputs: 0, down: false, installed: () => true, async embed(texts) {
  this.calls++; this.inputs += texts.length;
  if (this.down) throw new TypeError('fetch failed');
  if (texts.some((t) => t.includes('POISON'))) throw new Error('embed HTTP 500: input is too large');
  return texts.map((t) => truncateNormalize(bagVec(t)));
} });
const engineOf = (e) => ({ embed: (t) => e.embed(t) });

let dir, roots, store, emb, idx, memHome;
const SID = '11111111-2222-3333-4444-555555555555';
const claudeFile = () => path.join(roots.claude, '-Users-x-code-webapp', `${SID}.jsonl`);

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'drover-search-'));
  roots = { claude: path.join(dir, 'claude-projects'), codex: path.join(dir, 'codex-sessions'), wal: path.join(dir, 'drover-events.jsonl') };
  memHome = path.join(dir, 'memory', 'webapp');
  await mkdir(path.join(roots.claude, '-Users-x-code-webapp', SID, 'subagents'), { recursive: true });
  await mkdir(path.join(roots.codex, '2026', '10', '14'), { recursive: true });
  await mkdir(path.join(memHome, '.analysis'), { recursive: true });
  await writeFile(claudeFile(), [
    j({ type: 'user', timestamp: '2026-10-14T10:00:00Z', uuid: 'u1', cwd: '/Users/x/code/webapp', sessionId: SID, message: { content: 'Why does the circuit breaker trip after five seconds?' } }),
    j({ type: 'ai-title', title: 'Breaker timeout investigation' }),
    j({ type: 'assistant', timestamp: '2026-10-14T10:01:00Z', uuid: 'a1', message: { content: [{ type: 'text', text: 'The breaker uses a 5 s timeout in embedding-service.ts; MR !5678 raises it.' }, { type: 'tool_use', name: 'Read', input: {} }] } }),
    j({ type: 'user', timestamp: '2026-10-14T10:02:00Z', message: { content: [{ type: 'tool_result', content: 'BIG FILE DUMP about bananas' }] } }),
  ].join(''));
  await writeFile(path.join(roots.claude, '-Users-x-code-webapp', SID, 'subagents', 'agent-a1.jsonl'),
    j({ type: 'assistant', timestamp: '2026-10-14T10:05:00Z', message: { content: [{ type: 'text', text: 'Explore report: the retry policy lives in llm-client.ts.' }] } }));
  await writeFile(path.join(roots.codex, '2026', '10', '14', 'rollout-2026-10-14T09-00-00-019f0000-aaaa-bbbb-cccc-ddddeeeeffff.jsonl'), [
    j({ type: 'session_meta', payload: { id: '019f0000-aaaa-bbbb-cccc-ddddeeeeffff', cwd: '/home/u/code/Billing' } }),
    j({ type: 'response_item', timestamp: '2026-10-14T09:00:01Z', payload: { type: 'message', role: 'user', content: [{ text: '<environment_context>x</environment_context>' }] } }),
    j({ type: 'response_item', timestamp: '2026-10-14T09:00:02Z', payload: { type: 'message', role: 'user', content: [{ text: 'Make the Brain reindex after a model change' }] } }),
    j({ type: 'response_item', timestamp: '2026-10-14T09:00:03Z', payload: { type: 'message', role: 'assistant', content: [{ text: 'Brain now marks the index stale when the embedding model changes.' }] } }),
  ].join(''));
  await writeFile(roots.wal, [
    j({ id: 'ev1', ts: '2026-10-13T08:00:00Z', type: 'note', about: 'photos', text: 'Look-alike opponents for pairwise photo comparison' }),
    j({ id: 'ev2', ts: '2026-10-13T08:01:00Z', type: 'op', op: 'tmux.send' }),
  ].join(''));
  await writeFile(path.join(memHome, 'reference_regions.md'), '---\nname: region-embeddings\ndescription: embedding models per region\n---\n\nNova 2 multimodal embeddings is West only.\n');
  await writeFile(path.join(memHome, '.analysis', 'unfinished.md'), 'generated report about zebras');
  store = new Store(path.join(dir, 'search.sqlite'));
  emb = fakeEmbedder();
  idx = new Indexer({ store, embedder: emb, roots, memoryHomes: async () => ({ webapp: memHome }) });
});
after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });

describe('indexing', () => {
  test('first pass reads every source kind, keeps only conversation, embeds every distinct chunk', async () => {
    const r = await idx.tick();
    assert.ok(r.added >= 6, `added ${r.added}`);
    const st = store.stats();
    assert.deepEqual(Object.keys(st.kinds).sort(), ['claude', 'codex', 'memory', 'subagent', 'wal']);
    assert.equal(st.vectors, st.distinct);
    assert.equal(store.pendingCount(), 0);
    const all = store.db.prepare('SELECT kind, role, text, title, project, session_id FROM chunks').all();
    assert.ok(!all.some((c) => /BIG FILE DUMP|environment_context|zebras/.test(c.text)), 'tool output, injected context and dot-dirs are not indexed');
    const claude = all.filter((c) => c.kind === 'claude');
    assert.ok(claude.every((c) => c.project === 'webapp' && c.session_id === SID && c.title === 'Breaker timeout investigation'));
    assert.equal(all.find((c) => c.kind === 'subagent').session_id, SID, 'subagent hits link to the parent session');
    assert.equal(all.find((c) => c.kind === 'codex').project, 'Billing');
    assert.equal(all.filter((c) => c.kind === 'wal').length, 1, 'the op event carries no prose');
  });
  test('an unchanged tree is a no-op', async () => {
    const r = await idx.tick();
    assert.equal(r.changed, 0); assert.equal(r.added, 0);
  });
  test('appended lines are read from the stored offset; a partial line waits until it is complete', async () => {
    const before = store.stats().chunks;
    const line = j({ type: 'assistant', timestamp: '2026-10-14T11:00:00Z', message: { content: [{ type: 'text', text: 'Follow-up: the timeout is now configurable via DROVER_BREAKER_MS.' }] } });
    await appendFile(claudeFile(), line.slice(0, 40));
    let r = await idx.tick();
    assert.equal(r.added, 0, 'half a line is not indexed');
    await appendFile(claudeFile(), line.slice(40));
    r = await idx.tick();
    assert.equal(r.added, 1);
    assert.equal(store.stats().chunks, before + 1);
  });
  test('a pass that died mid-file (size -1) resumes from its offset instead of skipping', async () => {
    const src = store.source(claudeFile());
    store.upsertSource({ ...src, size: -1 });
    const r = await idx.tick();
    assert.equal(r.added, 0, 'nothing re-read before the offset');
    assert.equal(store.source(claudeFile()).size > 0, true);
  });
  test('a shrunk (rotated) file is purged and read again from the start', async () => {
    await writeFile(claudeFile(), j({ type: 'user', timestamp: '2026-10-14T12:00:00Z', cwd: '/Users/x/code/webapp', message: { content: 'fresh start after rotation' } }));
    await idx.tick();
    const texts = store.db.prepare('SELECT text FROM chunks WHERE path = ?').all(claudeFile()).map((r) => r.text);
    assert.deepEqual(texts, ['fresh start after rotation']);
  });
  test('truth-file events inserted mid-file (merge=union) are found by id and never duplicated', async () => {
    const raw = await readFile(roots.wal, 'utf8');
    const [first, ...rest] = raw.split('\n');
    await writeFile(roots.wal, [first, JSON.stringify({ id: 'ev9', ts: '2026-10-13T07:00:00Z', type: 'message', to: { id: 's1', name: 'webapp-26' }, text: 'rebase onto dev and open the MR' }), ...rest].join('\n'));
    await idx.tick(); await idx.tick();
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE kind = 'wal' AND ref = 'ev9'").get().n, 1);
  });
  test('an edited memory file is re-chunked; a deleted file is purged', async () => {
    await writeFile(path.join(memHome, 'reference_regions.md'), '---\nname: region-embeddings\n---\n\nTitan V2 is in both regions.\n');
    await idx.tick();
    const mem = store.db.prepare("SELECT text FROM chunks WHERE kind = 'memory'").all().map((r) => r.text);
    assert.deepEqual(mem, ['Titan V2 is in both regions.']);
    await rm(path.join(memHome, 'reference_regions.md'));
    const r = await idx.tick();
    assert.equal(r.purged, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE kind = 'memory'").get().n, 0);
  });
  test('a different model id drops the stored vectors so they are rebuilt', () => {
    assert.ok(store.stats().vectors > 0);
    assert.equal(store.ensureModel('another-model/256'), true);
    assert.equal(store.stats().vectors, 0);
    assert.equal(store.ensureModel('another-model/256'), false);
  });
  test('the next pass re-embeds under the real model id', async () => {
    await idx.tick();
    assert.equal(store.pendingCount(), 0);
    assert.match(store.getMeta('model'), /^embeddinggemma-2-q8_0@/);
  });
});

describe('robustness', () => {
  test('one input the model rejects is skipped alone; the rest of its batch is embedded; a down runtime marks nothing', async () => {
    const f = path.join(roots.claude, '-Users-x-code-webapp', 'poison.jsonl');
    await writeFile(f, ['alpha turn about sqlite', 'POISON payload', 'gamma turn about vectors'].map((t, i) => j({ type: 'user', timestamp: `2026-10-14T13:0${i}:00Z`, cwd: '/Users/x/code/webapp', message: { content: t } })).join(''));
    emb.down = true;
    await idx.tick();
    assert.equal(store.embedFailedCount(), 0, 'a down runtime is not blamed on the input');
    assert.ok(store.pendingCount() >= 3);
    emb.down = false;
    await idx.tick();
    assert.equal(store.embedFailedCount(), 1);
    assert.equal(store.pendingCount(), 0, 'nothing left pending; the poison chunk is not retried forever');
    const failed = store.db.prepare('SELECT c.text FROM embed_failed e JOIN chunks c ON c.hash = e.hash').get();
    assert.equal(failed.text, 'POISON payload');
  });
  test('a title that arrives in a later pass is applied to the chunks already indexed, and keyword search finds it', async () => {
    const f = path.join(roots.claude, '-Users-x-code-webapp', 'late-title.jsonl');
    await writeFile(f, j({ type: 'user', timestamp: '2026-10-14T14:00:00Z', cwd: '/Users/x/code/webapp', message: { content: 'a turn before the title' } }));
    await idx.tick();
    await appendFile(f, j({ type: 'ai-title', title: 'Zanzibar migration plan' }));
    await idx.tick();
    const titles = store.db.prepare('SELECT DISTINCT title FROM chunks WHERE path = ?').all(f).map((r) => r.title);
    assert.deepEqual(titles, ['Zanzibar migration plan']);
    const r = await search(store, null, { query: 'zanzibar' });
    assert.ok(r.results.some((x) => x.path === f), 'FTS sees the new title');
  });
  test('canonical checkout filter matches each chunk\'s OWN checkout and origin on every leg; labels and source cwd never authorize', async () => {
    const scoped = new Store(path.join(dir, 'canonical.sqlite'));
    try {
      // [session, source first cwd, chunk cwd, chunk host, kind, project label]
      const identities = [
        ['approved', '/public/Alpha', '/public/Alpha', null, 'claude', 'Alpha'],
        ['moved-in', '/elsewhere/Beta', '/public/Alpha', null, 'codex', 'Beta'],
        ['moved-out', '/public/Alpha', '/private/Alpha', null, 'claude', 'Alpha'],
        ['worktree', '/public/Alpha/.claude/worktrees/fix', '/public/Alpha/.claude/worktrees/fix', null, 'claude', 'Alpha'],
        ['legacy', '/public/Alpha', null, null, 'claude', 'Alpha'],
        ['label-only', null, null, null, 'wal', '/public/Alpha'],
        ['claims-host', '/public/Alpha', '/public/Alpha', 'box-a', 'claude', 'Alpha'],
        ['refl-ok', null, '/public/Alpha', 'box-a', 'reflection', 'Alpha'],
        ['refl-foreign-host', null, '/public/Alpha', 'box-b', 'reflection', 'Alpha'],
        ['refl-no-host', null, '/public/Alpha', null, 'reflection', 'Alpha'],
        ['refl-label-conflict', null, '/public/Alpha', 'box-a', 'reflection', 'Gamma'],
        ['refl-foreign-cwd', null, '/private/Alpha', 'box-a', 'reflection', '/public/Alpha'],
        // A reflection chunk whose cwd reads approved but whose state row records no checkout (an index written before
        // reflections carried one, where the chunk's cwd was the CLI's main-worktree cwd): withheld.
        ['refl-no-checkout', null, '/public/Alpha', 'box-a', 'reflection-chunk-only', 'Alpha'],
      ];
      for (const [sid, srcCwd, cwd, host, kind, project] of identities) {
        const text = `quantum capacitor alignment !5678 ${sid}`;
        if (kind === 'reflection') { scoped.upsertReflections([{ id: sid, text, hash: sha1(text), project, role: 'user', ts: '2026-10-14T00:00:00Z', sessionId: sid, status: 'open', checkout: cwd, host, textChanged: true }]); continue; }
        if (kind === 'reflection-chunk-only') { scoped.addChunks([{ path: `reflection:${sid}`, kind: 'reflection', session_id: sid, project, role: 'user', ts: '2026-10-14T00:00:00Z', text, ref: sid, cwd, host }]); continue; }
        const file = `/d/${sid}.jsonl`;
        scoped.upsertSource({ path: file, kind, cwd: srcCwd, project });
        scoped.addChunks([{ path: file, kind, session_id: sid, project, role: 'user', ts: '2026-10-14T00:00:00Z', text, cwd, host }]);
      }
      const embedder = fakeEmbedder();
      scoped.addVectors(scoped.pending().map((r) => ({ hash: r.hash, ...quantize(truncateNormalize(bagVec(r.text))) })));
      // A checkout-scoped search ranks by words only (here the exact !5678 in every mode): a vector embeds its session's
      // title, which may be another checkout's.
      for (const mode of ['keyword', 'semantic', 'hybrid']) {
        const r = await search(scoped, engineOf(embedder), { query: 'quantum capacitor !5678', repoIdentity: '/public/Alpha', originHosts: ['box-a'], mode });
        assert.deepEqual(r.results.map((r) => r.sessionId).sort(), ['approved', 'moved-in', 'refl-ok'], mode);
        assert.equal(r.vector, 'off', mode);
        assert.ok(r.results.every((h) => h.legs.vec === null), `${mode}: no vector leg`);
        for (const h of r.results) assert.equal(h.provenance.cwd, '/public/Alpha', mode);
        assert.equal(r.results.find((h) => h.sessionId === 'refl-ok').provenance.host, 'box-a');
        assert.equal(r.results.find((h) => h.sessionId === 'approved').provenance.host, null, 'a transcript is the answering host\'s own');
        const noHosts = await search(scoped, engineOf(embedder), { query: 'quantum capacitor !5678', repoIdentity: '/public/Alpha', mode });
        assert.deepEqual(noHosts.results.map((r) => r.sessionId).sort(), ['approved', 'moved-in'], 'no originHosts: no reflection');
      }
      // Owner search (no repoIdentity) is unchanged: every row, the legacy ones too.
      assert.equal((await search(scoped, null, { query: 'quantum capacitor', limit: 50 })).results.length, identities.length);
      await assert.rejects(search(scoped, null, { query: 'quantum', repoIdentity: 'Alpha' }), /invalid canonical/);
      await assert.rejects(search(scoped, null, { query: 'quantum', repoIdentity: '/public/../Alpha' }), /invalid canonical/);
      await assert.rejects(search(scoped, null, { query: 'quantum', repoIdentity: '/public/Alpha', originHosts: ['box-a', "x' OR 1"] }), /invalid origin host/);
    } finally { scoped.close(); }
  });
  test('an index file written before chunks carried provenance (opened read-only) answers a checkout filter with nothing', async () => {
    const file = path.join(dir, 'old-schema.sqlite');
    const { DatabaseSync } = await import('node:sqlite');
    const old = new Store(file);
    old.upsertSource({ path: '/d/old.jsonl', kind: 'claude', cwd: '/public/Alpha', project: 'Alpha' });
    old.addChunks([{ path: '/d/old.jsonl', kind: 'claude', session_id: 'old', project: 'Alpha', role: 'user', text: 'legacy quantum row', cwd: '/public/Alpha' }]);
    old.close();
    // Strip the columns, as an index an older Drover wrote has none.
    const raw = new DatabaseSync(file);
    raw.exec('DROP INDEX chunks_cwd; ALTER TABLE chunks DROP COLUMN cwd; ALTER TABLE chunks DROP COLUMN host;');
    raw.close();
    const ro = new Store(file, { readOnly: true });
    try {
      assert.equal(ro.provenance, false);
      assert.equal((await search(ro, null, { query: 'legacy quantum' })).results.length, 1, 'owner search still works');
      assert.deepEqual((await search(ro, null, { query: 'legacy quantum', repoIdentity: '/public/Alpha', originHosts: ['box-a'] })).results, []);
    } finally { ro.close(); }
    const migrated = new Store(file);
    try {
      assert.equal(migrated.provenance, true);
      assert.deepEqual((await search(migrated, null, { query: 'legacy quantum', repoIdentity: '/public/Alpha' })).results, [], 'migrated rows have no provenance until re-read');
    } finally { migrated.close(); }
  });
  test('filters apply before vector candidates are cut, so eligible matches are not crowded out', async () => {
    const s2 = new Store(path.join(dir, 'filters.sqlite'));
    const rows = [];
    for (let i = 0; i < 300; i++) rows.push({ path: `/d/${i}.jsonl`, kind: 'claude', session_id: `decoy${i}`, project: 'other', role: 'user', ts: '2026-10-14T00:00:00Z', title: null, text: `quantum flux capacitor alignment ${i}` });
    rows.push({ path: '/d/target.jsonl', kind: 'claude', session_id: 'target', project: 'webapp', role: 'user', ts: '2026-10-14T00:00:00Z', title: null, text: 'notes on the capacitor bench' });
    s2.addChunks(rows);
    const e2 = fakeEmbedder();
    const i2 = new Indexer({ store: s2, embedder: e2, roots: { claude: null, codex: null, wal: null } });
    await i2.tick();
    const r = await search(s2, engineOf(e2), { query: 'quantum flux capacitor alignment', mode: 'semantic', project: 'webapp' });
    assert.deepEqual(r.results.map((x) => x.sessionId), ['target']);
    const none = await search(s2, engineOf(e2), { query: 'quantum flux capacitor', mode: 'semantic', project: 'nowhere' });
    assert.equal(none.results.length, 0);
    s2.close();
  });
});

describe('collection and restore', () => {
  test('vectors no chunk references are collected after a purge, so they cannot take kNN slots', async () => {
    const f = path.join(memHome, 'gc_note.md');
    await writeFile(f, '---\nname: gc-note\n---\n\nfirst version about orchids\n');
    await idx.tick();
    await writeFile(f, '---\nname: gc-note\n---\n\nsecond version about cacti\n');
    const r = await idx.tick();
    assert.ok(r.collected >= 1, `collected ${r.collected}`);
    const st = store.stats();
    assert.equal(st.vectors + st.embedFailed, st.distinct, 'every distinct live chunk has a vector or a failure mark, and nothing else is stored');
    const live = new Set(store.db.prepare('SELECT hash FROM chunks').all().map((x) => x.hash));
    assert.ok(store.vectors().keys.every((k) => live.has(k)), 'the in-memory matrix was rebuilt without the orphans');
  });
  test('a truth file that vanishes and comes back is indexed again', async () => {
    const before = store.db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE kind = 'wal'").get().n;
    assert.ok(before > 0);
    const raw = await readFile(roots.wal, 'utf8');
    await rm(roots.wal);
    await idx.tick();
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE kind = 'wal'").get().n, 0);
    await writeFile(roots.wal, raw);
    await idx.tick();
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE kind = 'wal'").get().n, before);
  });
});

describe('derived sessions and duplicate copies', () => {
  test('skipReason: temp working directories and known generator prompts; off switch and extra prompts by env', () => {
    assert.equal(skipReason({ cwd: '/private/var/folders/l1/x/T/tmp.abc' }), 'temp working directory');
    assert.equal(skipReason({ cwd: '/tmp/judge_1' }), 'temp working directory');
    assert.equal(skipReason({ slug: '-private-var-folders-l1-m188-T-tmp' }), 'temp working directory');
    assert.match(skipReason({ cwd: '/Users/x/code/webapp', firstUser: 'You are writing the durable reflection of one AI coding session' }), /generated prompt/);
    assert.equal(skipReason({ cwd: '/Users/x/code/webapp', firstUser: 'fix the breaker' }), null);
    assert.equal(skipReason({ cwd: '/tmp/x' }, { DROVER_SEARCH_SKIP: 'off' }), null);
    assert.match(skipReason({ cwd: '/Users/x', firstUser: 'JUDGE THIS FILM' }, { DROVER_SEARCH_SKIP_PROMPTS: 'GRADE IT|JUDGE THIS' }), /generated prompt: JUDGE THIS/);
  });
  test('a helper run in a temp directory and a reflection-writer session are skipped and stay skipped', async () => {
    const tmpSlug = path.join(roots.claude, '-private-var-folders-l1-abc-T-tmp.xyz');
    await mkdir(tmpSlug, { recursive: true });
    const a = path.join(tmpSlug, 'helper.jsonl');
    await writeFile(a, j({ type: 'user', cwd: '/private/var/folders/l1/abc/T/tmp.xyz', message: { content: 'Reply with exactly: OK' } }));
    const b = path.join(roots.claude, '-Users-x-code-webapp', 'reflection.jsonl');
    await writeFile(b, j({ type: 'user', cwd: '/Users/x/code/webapp', message: { content: 'You are writing the durable reflection of one AI coding session. TOOL Bash: command=grep secret-ish stuff' } }) + j({ type: 'assistant', message: { content: [{ type: 'text', text: '{"topic":"copy of another session"}' }] } }));
    const before = store.stats().skippedSources;
    await idx.tick();
    assert.equal(store.stats().skippedSources, before + 2);
    for (const f of [a, b]) assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE path = ?').get(f).n, 0, f);
    await appendFile(b, j({ type: 'assistant', message: { content: [{ type: 'text', text: 'more derived text' }] } }));
    const r = await idx.tick();
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE path = ?').get(b).n, 0, 'appending to a skipped session parses nothing');
    assert.equal(store.source(b).offset, store.source(b).size);
    assert.equal(r.added, 0);
  });
  test('survey items about a derived session are not indexed', async () => {
    const raw = await readFile(roots.wal, 'utf8');
    await writeFile(roots.wal, raw + j({ id: 'svy-derived', ts: '2026-10-14T16:00:00Z', type: 'survey-item', item: { title: 'You are writing the durable reflection of one AI coding session', summary: 'copy', cwd: '/private/var/folders/x/T/tmp.1' } }) + j({ id: 'svy-real', ts: '2026-10-14T16:01:00Z', type: 'survey-item', item: { title: 'Fix the breaker', summary: 'halfway', cwd: '/Users/x/code/webapp' } }));
    await idx.tick();
    const refs = store.db.prepare("SELECT ref FROM chunks WHERE kind = 'wal' AND ref LIKE 'svy-%'").all().map((r) => r.ref);
    assert.deepEqual(refs, ['svy-real']);
  });
  test('a session whose first pass saw no user turn is still skipped when the generator prompt arrives later', async () => {
    const f = path.join(roots.claude, '-Users-x-code-webapp', 'late-generator.jsonl');
    await writeFile(f, j({ type: 'file-history-snapshot', snapshot: {} }));
    await idx.tick();
    assert.equal(store.source(f).skipped, null);
    await appendFile(f, j({ type: 'user', cwd: '/Users/x/code/webapp', message: { content: 'You are summarizing the state of coding-agent sessions on every host' } }) + j({ type: 'assistant', message: { content: [{ type: 'text', text: 'derived summary text' }] } }));
    await idx.tick();
    assert.match(store.source(f).skipped, /generated prompt/);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE path = ?').get(f).n, 0);
  });
  test('subagents of a skipped session are skipped with it, whichever is read first', async () => {
    const dirS = path.join(roots.claude, '-Users-x-code-webapp');
    const sid = 'gen-parent-0001';
    await mkdir(path.join(dirS, sid, 'subagents'), { recursive: true });
    const sub = path.join(dirS, sid, 'subagents', 'agent-x.jsonl');
    await writeFile(sub, j({ type: 'user', message: { content: 'Explore the repo and report' } }) + j({ type: 'assistant', message: { content: [{ type: 'text', text: 'subagent report text' }] } }));
    await idx.tick();
    assert.ok(store.db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE path = ?').get(sub).n > 0, 'indexed while the parent is unknown');
    await writeFile(path.join(dirS, `${sid}.jsonl`), j({ type: 'user', cwd: '/Users/x/code/webapp', message: { content: 'You are writing the durable reflection of one AI coding session' } }));
    await idx.tick();
    assert.match(store.source(sub).skipped, /parent session skipped/);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE path = ?').get(sub).n, 0);
    const sub2 = path.join(dirS, sid, 'subagents', 'agent-y.jsonl');
    await writeFile(sub2, j({ type: 'user', message: { content: 'another subagent task' } }));
    await idx.tick();
    assert.match(store.source(sub2).skipped, /parent session skipped/, 'a subagent that appears after the parent was skipped');
  });
  test('copies of one turn in hundreds of sessions do not crowd distinct keyword matches out of the candidates', async () => {
    const s3 = new Store(path.join(dir, 'copies.sqlite'));
    const rows = [];
    for (let i = 0; i < 250; i++) rows.push({ path: `/c/${i}.jsonl`, kind: 'claude', session_id: `copy${i}`, project: 'webapp', role: 'user', ts: '2026-10-14T00:00:00Z', title: null, text: 'zebra zebra zebra crossing plan' });
    rows.push({ path: '/c/other.jsonl', kind: 'claude', session_id: 'distinct', project: 'webapp', role: 'user', ts: '2026-10-13T00:00:00Z', title: null, text: 'a zebra in the second plan' });
    s3.addChunks(rows);
    const r = await search(s3, null, { query: 'zebra plan', limit: 10 });
    assert.ok(r.results.some((x) => x.sessionId === 'distinct'), 'the distinct match is still found');
    const twin = r.results.find((x) => x.snippet.includes('crossing'));
    assert.equal(twin.copies, 250, 'copies counts every session carrying the text');
    s3.close();
  });
  test('copies of one text with different titles and times are fused once: both legs credit the same hit', async () => {
    const s4 = new Store(path.join(dir, 'fuse.sqlite'));
    const twin = 'heron migration dusk wetland survey notes';
    s4.addChunks([
      { path: '/f/a.jsonl', kind: 'claude', session_id: 'older', project: 'p', role: 'user', ts: '2026-09-01T00:00:00Z', title: 'heron migration dusk wetland', text: twin },
      { path: '/f/b.jsonl', kind: 'claude', session_id: 'newer', project: 'p', role: 'user', ts: '2026-10-14T00:00:00Z', title: 'misc', text: twin },
      { path: '/f/c.jsonl', kind: 'claude', session_id: 'unique', project: 'p', role: 'user', ts: '2026-10-14T00:00:00Z', title: 'misc', text: 'heron migration dusk wetland photos' },
    ]);
    const e4 = fakeEmbedder();
    await new Indexer({ store: s4, embedder: e4, roots: { claude: null, codex: null, wal: null } }).tick();
    const r = await search(s4, engineOf(e4), { query: 'heron migration dusk wetland survey notes', limit: 5 });
    assert.equal(r.results[0].snippet, twin);
    assert.ok(r.results[0].legs.fts && r.results[0].legs.vec, 'one hit carries both legs');
    assert.equal(r.results[0].sessionId, 'newer', 'the representative is the newest copy');
    assert.equal(r.results[0].copies, 2);
    assert.equal(r.results.filter((x) => x.snippet === twin).length, 1);
    s4.close();
  });
  test('a prompt-skipped session that is rotated (shrunk) is decided again, and stays skipped', async () => {
    const f = path.join(roots.claude, '-Users-x-code-webapp', 'rotated-generator.jsonl');
    const gen = j({ type: 'user', cwd: '/Users/x/code/webapp', message: { content: 'You are writing the durable reflection of one AI coding session' } });
    await writeFile(f, gen + j({ type: 'assistant', message: { content: [{ type: 'text', text: 'a long derived reply '.repeat(20) }] } }));
    await idx.tick();
    assert.match(store.source(f).skipped, /generated prompt/);
    await writeFile(f, gen);   // shorter: rotated
    await idx.tick();
    assert.match(store.source(f).skipped, /generated prompt/);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE path = ?').get(f).n, 0);
  });
  test('a late title drops the old vectors so the session is embedded again with it', async () => {
    const f = path.join(roots.claude, '-Users-x-code-webapp', 'late-title-vec.jsonl');
    await writeFile(f, j({ type: 'user', timestamp: '2026-10-14T17:00:00Z', cwd: '/Users/x/code/webapp', message: { content: 'kingfisher nesting turn' } }));
    await idx.tick();
    assert.equal(store.pendingCount(), 0);
    await appendFile(f, j({ type: 'ai-title', title: 'Kingfisher season' }));
    await idx.tick();
    assert.equal(store.pendingCount(), 0, 're-embedded within the same pass');
    const h = store.db.prepare('SELECT hash FROM chunks WHERE path = ?').get(f).hash;
    assert.ok(store.vectors().has(h));
  });
  test('the same text in a parent and its fork shows once, with the copies counted', async () => {
    const twinText = 'Decision: keep the breaker at 5 s and make it configurable (twin text).';
    for (const name of ['parent-session', 'forked-session']) await writeFile(path.join(roots.claude, '-Users-x-code-webapp', `${name}.jsonl`), j({ type: 'assistant', timestamp: '2026-10-14T15:00:00Z', cwd: '/Users/x/code/webapp', message: { content: [{ type: 'text', text: twinText }] } }));
    await idx.tick();
    const r = await search(store, engineOf(emb), { query: 'twin text configurable breaker', limit: 10 });
    const twins = r.results.filter((x) => x.snippet.includes('twin text'));
    assert.equal(twins.length, 1);
    assert.equal(twins[0].copies, 2);
  });
});

describe('round five', () => {
  test('a listing that fails (a root that cannot be read, memory homes that throw) purges nothing', async () => {
    const before = store.stats();
    const blind = new Indexer({ store, embedder: emb, roots: { claude: path.join(dir, 'unreadable-root'), codex: path.join(dir, 'nope'), wal: path.join(dir, 'nope.jsonl') }, memoryHomes: async () => { throw new Error('EMFILE: too many open files'); } });
    const r = await blind.tick();
    assert.equal(r.purged, 0);
    assert.equal(store.stats().chunks, before.chunks);
    assert.equal(store.stats().vectors, before.vectors);
  });
  test('sessionless truth-file events are each their own record under the per-session cap', async () => {
    const raw = await readFile(roots.wal, 'utf8');
    const notes = Array.from({ length: 5 }, (_, i) => j({ id: `osprey-${i}`, ts: `2026-10-14T18:0${i}:00Z`, type: 'note', about: `osprey ${i}`, text: `osprey nest count ${i}` })).join('');
    await writeFile(roots.wal, raw + notes);
    await idx.tick();
    const r = await search(store, null, { query: 'osprey nest count', kinds: ['wal'], limit: 20 });
    assert.equal(r.results.filter((x) => String(x.ref).startsWith('osprey-')).length, 5);
  });
  test('a failure mark older than a day lets the chunk be tried again', async () => {
    const h = store.db.prepare('SELECT hash FROM chunks LIMIT 1').get().hash;
    store.db.prepare('DELETE FROM vecs WHERE hash = ?').run(h);
    store.markEmbedFailed(h, 'embed HTTP 500: busy');
    assert.ok(!store.pending(100000).some((p) => p.hash === h), 'a fresh mark keeps it out');
    store.db.prepare('UPDATE embed_failed SET at = ? WHERE hash = ?').run('2026-01-01T00:00:00.000Z', h);
    assert.ok(store.pending(100000).some((p) => p.hash === h), 'an old mark lets it back in');
    await idx.tick();
    assert.ok(store.vectors().has(h));
  });
});

describe('readNewLines', () => {
  test('multi-byte characters split across read windows decode intact; end is the byte after the last newline', async () => {
    const f = path.join(dir, 'utf8.jsonl');
    const lines = ['{"t":"café ☕ — ok"}', '{"t":"日本語のテキスト 🚀"}', '{"t":"plain"}'];
    await writeFile(f, lines.join('\n') + '\n{"t":"partial');
    const size = Buffer.byteLength(lines.join('\n') + '\n{"t":"partial');
    const got = []; let end = 0;
    for await (const w of readNewLines(f, 0, size, { window: 5 })) { got.push(...w.lines); end = w.end; }
    assert.deepEqual(got, lines);
    assert.equal(end, Buffer.byteLength(lines.join('\n') + '\n'));
  });
});

describe('search', () => {
  before(async () => {
    // A richer corpus for ranking: several sessions in one fresh file.
    const f = path.join(roots.claude, '-Users-x-code-webapp', 'rank.jsonl');
    const rows = [];
    for (let i = 0; i < 6; i++) rows.push(j({ type: 'user', timestamp: `2026-10-0${i + 1}T00:00:00Z`, sessionId: 'rank', cwd: '/Users/x/code/webapp', message: { content: `Note ${i}: the circuit breaker timeout discussion, part ${i}.` } }));
    rows.push(j({ type: 'assistant', timestamp: '2026-10-10T00:00:00Z', sessionId: 'rank', message: { content: [{ type: 'text', text: 'Pushed 2188ac1deca4 for !5678 and #1234.' }] } }));
    await writeFile(f, rows.join(''));
    await idx.tick();
  });
  test('hybrid: words and meaning both find the breaker discussion; snippets show the match', async () => {
    const r = await search(store, engineOf(emb), { query: 'circuit breaker timeout', limit: 10, perSession: 10 });
    assert.equal(r.vector, 'ok');
    assert.ok(r.results.length >= 3);
    // The top hits carry the words; below them the vector leg may add neighbours that only share meaning.
    assert.ok(r.results.slice(0, 3).every((x) => /breaker/i.test(x.snippet)), JSON.stringify(r.results.map((x) => x.snippet)));
    assert.ok(r.results[0].legs.fts && r.results[0].legs.vec);
    assert.ok(r.sessions.length >= 1);
  });
  test('exact strings (!MR, #activity, short SHA) rank the chunk that contains them first', async () => {
    for (const q of ['!5678', '#1234', '2188ac1d', 'what landed in !5678']) {
      const r = await search(store, engineOf(emb), { query: q });
      assert.ok(r.results.length, q);
      assert.match(r.results[0].snippet, /2188ac1deca4 for !5678/, q);
      assert.equal(r.results[0].legs.exact, true, q);
    }
    assert.deepEqual(exactTokens('see !5678, #1234 and 2188ac1deca4 in core/api.js and embedding-service.ts with DROVER_EMBED_THREADS'),
      ['!5678', '#1234', '2188ac1deca4', 'core/api.js', 'embedding-service.ts', 'DROVER_EMBED_THREADS']);
    assert.deepEqual(exactTokens('deadbeef is a word'), [], 'hex without a digit is not a SHA');
  });
  test('filters: kinds, project, days, role, session; perSession caps one long session', async () => {
    const codex = await search(store, engineOf(emb), { query: 'brain index model', kinds: ['codex'] });
    assert.ok(codex.results.length && codex.results.every((x) => x.kind === 'codex'));
    const bad = await search(store, engineOf(emb), { query: 'brain index model', project: 'webapp', kinds: 'codex' });
    assert.equal(bad.results.length, 0);
    const recent = await search(store, engineOf(emb), { query: 'circuit breaker', days: 1 });
    assert.ok(recent.results.every((x) => Date.parse(x.ts) > Date.now() - 86400_000));
    const users = await search(store, engineOf(emb), { query: 'circuit breaker', role: 'user', perSession: 50 });
    assert.ok(users.results.every((x) => x.role === 'user'));
    const capped = await search(store, engineOf(emb), { query: 'circuit breaker timeout discussion', perSession: 2, limit: 20 });
    assert.ok(capped.results.filter((x) => x.sessionId === 'rank').length <= 2);
    const sess = await search(store, engineOf(emb), { query: 'circuit breaker', session: 'ran' });
    assert.ok(sess.results.length && sess.results.every((x) => x.sessionId === 'rank'));
  });
  test('keyword mode skips vectors; no engine reports vectors unavailable; semantic mode skips words', async () => {
    const k = await search(store, engineOf(emb), { query: 'circuit breaker', mode: 'keyword' });
    assert.equal(k.vector, 'off'); assert.ok(k.results.every((x) => !x.legs.vec));
    const none = await search(store, null, { query: 'circuit breaker' });
    assert.equal(none.vector, 'unavailable'); assert.ok(none.results.length);
    const s = await search(store, engineOf(emb), { query: 'circuit breaker', mode: 'semantic' });
    assert.ok(s.results.every((x) => !x.legs.fts));
  });
  test('hostile queries cannot break out of the FTS expression', async () => {
    for (const q of ['foo" OR bar*(', 'NEAR(a b)', '"; DROP TABLE chunks; --', '^title:x', '***']) {
      const r = await search(store, engineOf(emb), { query: q });
      assert.ok(Array.isArray(r.results), q);
    }
    assert.equal(store.stats().chunks > 0, true, 'the table is still there');
    assert.equal(ftsExpr(ftsTerms('say "hi" now')), '"say" OR "hi" OR "now"');
    await assert.rejects(search(store, null, { query: '   ' }), /non-empty/);
    await assert.rejects(search(store, null, { query: 'x'.repeat(2001) }), /too long/);
  });
  test('snippet centers on the first matched term', () => {
    const s = snippet('a'.repeat(500) + ' the breaker trips ' + 'b'.repeat(500), ['breaker'], 120);
    assert.ok(s.includes('breaker')); assert.ok(s.startsWith('…') && s.endsWith('…'));
  });
});

describe('fleet merge and formatting', () => {
  test('identical chunks found on several hosts fold into one result listing every host', () => {
    const a = { score: 0.03, hash: 'h1', ts: '2026-10-14', kind: 'memory', snippet: 'x' };
    const merged = mergeHosts([{ host: 'laptop', results: [a, { score: 0.02, hash: 'h2', ts: '2026-10-13', kind: 'claude' }] }, { host: 'devbox', results: [{ ...a, score: 0.031 }] }], { limit: 10 });
    assert.equal(merged.length, 2);
    assert.deepEqual(merged[0].hosts, ['laptop', 'devbox']);
    assert.equal(merged[0].host, 'devbox', 'the best-scoring copy wins');
    assert.deepEqual(merged[0].origins, [null, null], 'copies without provenance are kept as unknown');
  });
  test('the merge keeps every copy\'s own origin: the host that wrote it, else the host that answered', () => {
    const t = { score: 0.03, hash: 'h1', kind: 'claude', provenance: { cwd: '/public/Alpha', host: null } };
    const refl = { score: 0.02, hash: 'h2', kind: 'reflection', provenance: { cwd: '/public/Alpha', host: 'box-b' } };
    const merged = mergeHosts([{ host: 'box-a', results: [t, refl] }, { host: 'devbox', results: [{ ...t, score: 0.04, provenance: undefined, origins: [{ cwd: '/public/Alpha', host: 'box-a' }] }] }], { limit: 10 });
    const one = merged.find((r) => r.hash === 'h1');
    assert.equal(one.host, 'devbox');
    assert.deepEqual(one.origins, [{ cwd: '/public/Alpha', host: 'box-a' }, null], 'a peer cannot supply origins; its copy without provenance stays unknown');
    const r = merged.find((x) => x.hash === 'h2');
    assert.equal(r.host, 'box-a', 'host is the answering host');
    assert.deepEqual(r.origins, [{ cwd: '/public/Alpha', host: 'box-b' }], 'a reflection keeps the host that wrote it');
  });
  test('formatResults prints a resume command per agent session and the per-host summary', () => {
    const out = formatResults({ ms: 12, perHost: [{ host: 'laptop', ok: true, hits: 1, vector: 'ok' }, { host: 'devbox', ok: false, error: 'timed out', hits: 0 }], results: [{ host: 'laptop', hosts: ['laptop'], kind: 'claude', ts: '2026-10-14T10:01:00Z', project: 'webapp', title: 'Breaker', role: 'assistant', snippet: 'the breaker', sessionId: SID, legs: { fts: 1, vec: { rank: 2, sim: 0.8 }, exact: false } }] });
    assert.match(out, /1 results from 2 hosts/); assert.match(out, /devbox error: timed out/);
    assert.match(out, new RegExp(`claude --resume ${SID}`)); assert.match(out, /words #1, meaning #2/);
    assert.equal(resumeHint({ kind: 'codex', sessionId: 't1' }), 'codex resume t1');
    assert.equal(resumeHint({ kind: 'wal', sessionId: 's' }), null);
    assert.match(formatResults({ host: 'h', ms: 1, results: [] }), /No matches/);
  });
  test('the per-host summary gives each host\'s time, and its own search time when the wait was mostly elsewhere', () => {
    const perHost = [{ host: 'laptop', ok: true, hits: 1, vector: 'ok', ms: 159, searchMs: 150 }, { host: 'devbox', ok: true, hits: 2, vector: 'ok', ms: 6574, searchMs: 212 }, { host: 'old', ok: true, hits: 0, vector: 'ok' }];
    const out = formatResults({ ms: 6600, perHost, results: [] });
    assert.match(out, /laptop 1 hit in 159 ms · devbox 2 hits in 6\.6 s \(search 212 ms\) · old 0 hits(\n|$)/);
    const g = formatGrep({ ms: 6600, perHost: perHost.map((p) => ({ ...p, vector: undefined })), results: [] });
    assert.match(g, /devbox 2 in 6\.6 s \(search 212 ms\)/);
  });
});
