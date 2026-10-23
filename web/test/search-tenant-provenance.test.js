// Tenant search is authorized on each chunk's OWN provenance, end to end: real transcripts and a reflections CLI go
// through the Indexer into a Store, then search() on each host, mergeHosts() and the tenant drover_search tool.
// Regression for two leaks: a later turn in another checkout took the session's first cwd as its authority, and
// reflections lost the host and checkout they were written in (the answering host stood in for both). And for a third:
// a reflection written in a private git worktree carried the CLI's `cwd`, which is the MAIN worktree's root.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../core/search/store.js';
import { Indexer } from '../core/search/indexer.js';
import { search, mergeHosts } from '../core/search/query.js';
import { botTools } from '../core/bots/tools.js';
import { tenantBot } from '../core/bots/access.js';

const j = (o) => JSON.stringify(o) + '\n';
let dir, pub, priv, roots, dbFile, store, indexer;
const policy = () => ({ version: 1, tenant: 'alice', bot: tenantBot('alice'), requester: 'user:alice', projects: [pub], hosts: ['box-a'] });
const grant = () => ({ grantId: 'proof', bot: tenantBot('alice'), scopes: ['drover.read'], resourceAccess: policy() });

/** The tenant tool over this index as host box-a answers it (search.fleet = search on each host, then mergeHosts). */
function tenantSearch(perHost = () => [{ host: 'box-a', store }]) {
  const calls = [];
  const dispatch = async (op, args) => {
    assert.equal(op, 'search.fleet');
    calls.push(args);
    const answers = [];
    for (const h of perHost()) answers.push({ host: h.host, results: (await search(h.store, null, { ...args, mode: 'keyword' })).results });
    return { results: mergeHosts(answers, { limit: args.limit }) };
  };
  const tool = botTools(grant(), { dispatch, host: 'box-a', readEvents: async () => [] }).find((t) => t.name === 'drover_search');
  return { calls, run: async (query) => (await tool.run(null, { query })).results };
}

// As the reflections CLI exports them: cwd is the MAIN worktree's root (or the cwd), checkout the git top level the item
// was written in (the contract in README "Native tenants"). Only checkout and host authorize.
const reflections = () => [
  { id: 'ok', source: 'reflection', kind: 'gotcha', status: 'open', repo: 'Alpha', cwd: pub, checkout: pub, host: 'box-a', title: 'APPROVEDREFLECTION', body: 'written in the approved checkout on box-a', updated_at: '2026-10-22T07:00:00Z' },
  { id: 'foreign-host', source: 'reflection', kind: 'gotcha', status: 'open', repo: pub, cwd: pub, checkout: pub, host: 'pc', title: 'FOREIGNHOSTSECRET', body: 'a reflection authored on an unapproved host', updated_at: '2026-10-22T07:00:00Z' },
  { id: 'conflicting-cwd', source: 'reflection', kind: 'gotcha', status: 'open', repo: pub, cwd: priv, checkout: priv, host: 'box-a', title: 'FOREIGNCWDSECRET', body: 'a reflection whose cwd conflicts with its approved repo label', updated_at: '2026-10-22T07:00:00Z' },
  { id: 'unknown-host', source: 'reflection', kind: 'gotcha', status: 'open', repo: pub, checkout: pub, title: 'UNKNOWNHOSTSECRET', body: 'no origin host in export', updated_at: '2026-10-22T07:00:00Z' },
  { id: 'label-conflict', source: 'reflection', kind: 'gotcha', status: 'open', repo: 'Gamma', cwd: pub, checkout: pub, host: 'box-a', title: 'LABELCONFLICTSECRET', body: 'repo label names another repo', updated_at: '2026-10-22T07:00:00Z' },
  // Written in a private git worktree of the approved checkout: the CLI's cwd (and repo key) is the main checkout's.
  { id: 'worktree', source: 'reflection', kind: 'gotcha', status: 'open', repo: 'alpha', cwd: pub, checkout: path.join(path.dirname(pub), 'Alpha-private-wt'), host: 'box-a', title: 'WORKTREEPRIVATESECRET', body: 'an unreleased branch plan', updated_at: '2026-10-22T07:00:00Z' },
  // A CLI that does not export checkout yet: its cwd reads approved, but says nothing about the worktree it was written in.
  { id: 'cwd-only', source: 'reflection', kind: 'gotcha', status: 'open', repo: 'Alpha', cwd: pub, host: 'box-a', title: 'CWDONLYSECRET', body: 'no checkout exported', updated_at: '2026-10-22T07:00:00Z' },
];

const codexFile = () => path.join(roots.codex, 'rollout-2026-10-22T07-00-00-019f0000-aaaa-bbbb-cccc-ddddeeeeffff.jsonl');

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'drover-tenant-prov-'));
  pub = path.join(dir, 'public', 'Alpha'); priv = path.join(dir, 'private', 'Alpha');
  await mkdir(pub, { recursive: true }); await mkdir(priv, { recursive: true });
  roots = { claude: path.join(dir, 'claude'), codex: path.join(dir, 'codex'), reflections: path.join(dir, 'reflections') };
  await mkdir(path.join(roots.claude, 'public-Alpha'), { recursive: true });
  await mkdir(roots.codex, { recursive: true });
  await writeFile(path.join(roots.claude, 'public-Alpha', 'session-moved.jsonl'), [
    j({ type: 'user', uuid: 'public-u', timestamp: '2026-10-22T07:00:00Z', cwd: pub, sessionId: 'session-moved', message: { content: 'PUBLICGREETING from the approved checkout' } }),
    j({ type: 'assistant', uuid: 'private-a', timestamp: '2026-10-22T07:01:00Z', cwd: priv, sessionId: 'session-moved', message: { content: [{ type: 'text', text: 'PRIVATECHECKOUTSECRET from another checkout with the same basename' }] } }),
    // One run of tool calls across the move: the command chunk is cut where the checkout changes.
    j({ type: 'assistant', uuid: 'cmd-pub', timestamp: '2026-10-22T07:02:00Z', cwd: pub, sessionId: 'session-moved', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo PUBLICCOMMAND' } }] } }),
    j({ type: 'assistant', uuid: 'cmd-priv', timestamp: '2026-10-22T07:03:00Z', cwd: priv, sessionId: 'session-moved', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo PRIVATECOMMANDSECRET' } }] } }),
    // A line that names no cwd is of unknown checkout: never borrowed from the line before it.
    j({ type: 'assistant', uuid: 'no-cwd', timestamp: '2026-10-22T07:04:00Z', sessionId: 'session-moved', message: { content: [{ type: 'text', text: 'NOCWDSECRET said with no recorded checkout' }] } }),
  ].join(''));
  // A session whose first prompt (and so its title) was in the private checkout, then moved into the approved one.
  await writeFile(path.join(roots.claude, 'public-Alpha', 'session-titled.jsonl'), [
    j({ type: 'user', uuid: 't-u', timestamp: '2026-10-22T06:00:00Z', cwd: priv, sessionId: 'session-titled', message: { content: 'PRIVATETITLESECRET is the first prompt' } }),
    j({ type: 'assistant', uuid: 't-a', timestamp: '2026-10-22T06:01:00Z', cwd: pub, sessionId: 'session-titled', message: { content: [{ type: 'text', text: 'PUBLICAFTERPRIVATE answered in the approved checkout' }] } }),
  ].join(''));
  await writeFile(codexFile(), [
    j({ type: 'session_meta', payload: { id: '019f0000-aaaa-bbbb-cccc-ddddeeeeffff', cwd: pub } }),
    j({ type: 'turn_context', payload: { cwd: pub } }),
    j({ type: 'response_item', timestamp: '2026-10-22T07:00:01Z', payload: { type: 'message', role: 'user', content: [{ text: 'CODEXPUBLICTURN in the approved checkout' }] } }),
    j({ type: 'turn_context', payload: { cwd: priv } }),
    j({ type: 'response_item', timestamp: '2026-10-22T07:00:02Z', payload: { type: 'message', role: 'user', content: [{ text: 'CODEXPRIVATETURNSECRET in another checkout' }] } }),
  ].join(''));
  await writeFile(roots.reflections, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(reflections().map((x) => JSON.stringify(x)).join('\n') + '\n')});\n`, { mode: 0o700 });
  dbFile = path.join(dir, 'search.sqlite');
  store = new Store(dbFile);
  indexer = new Indexer({ store, roots, memoryHomes: async () => ({}), kinds: ['claude', 'codex', 'reflection'], env: { ...process.env, DROVER_SEARCH_SKIP: 'off' }, log: () => {} });
  await indexer.tick({ embed: false });
});
after(async () => { store?.close(); await rm(dir, { recursive: true, force: true }); });

describe('tenant search on per-chunk provenance', () => {
  test('a later turn in another checkout never takes the session\'s first checkout as its authority', async () => {
    const { run, calls } = tenantSearch();
    assert.deepEqual(await run('PRIVATECHECKOUTSECRET'), []);
    assert.deepEqual(await run('NOCWDSECRET'), [], 'unknown checkout fails closed');
    const ok = await run('PUBLICGREETING');
    assert.equal(ok.length, 1);
    assert.equal(ok[0].project, pub); assert.equal(ok[0].host, 'box-a');
    assert.deepEqual(calls[0].originHosts, ['box-a']);
    // The owner's search still finds every turn of the session.
    assert.equal((await search(store, null, { query: 'PRIVATECHECKOUTSECRET' })).results.length, 1);
  });
  test('a session title from another checkout neither matches nor is released on an approved chunk', async () => {
    const { run } = tenantSearch();
    assert.deepEqual(await run('PRIVATETITLESECRET'), [], 'the approved chunk is not found by its session title');
    const ok = await run('PUBLICAFTERPRIVATE');
    assert.equal(ok.length, 1);
    assert.equal(ok[0].title, null);
    assert.ok(!JSON.stringify(ok).includes('PRIVATETITLESECRET'));
    assert.match((await search(store, null, { query: 'PUBLICAFTERPRIVATE' })).results[0].title, /PRIVATETITLESECRET/, 'the owner keeps titles');
  });
  test('a run of tool calls is cut where the checkout changes, so a public command chunk carries no private command', async () => {
    const { run } = tenantSearch();
    assert.deepEqual(await run('PRIVATECOMMANDSECRET'), []);
    const ok = await run('PUBLICCOMMAND');
    assert.equal(ok.length, 1); assert.ok(!ok[0].snippet.includes('PRIVATECOMMANDSECRET'));
    const cmds = store.db.prepare("SELECT cwd, text FROM chunks WHERE role = 'command' ORDER BY id").all();
    assert.deepEqual(cmds.map((c) => c.cwd), [pub, priv]);
  });
  test('a Codex turn_context moves the checkout for the items after it, across passes too', async () => {
    const { run } = tenantSearch();
    assert.deepEqual(await run('CODEXPRIVATETURNSECRET'), []);
    assert.equal((await run('CODEXPUBLICTURN')).length, 1);
    // The next pass reads on from the stored offset: the turn_context it read last still holds.
    await appendFile(codexFile(), j({ type: 'response_item', timestamp: '2026-10-22T07:00:03Z', payload: { type: 'message', role: 'assistant', content: [{ text: 'CODEXLATERSECRET still in the other checkout' }] } }));
    await indexer.tick({ embed: false });
    assert.equal((await search(store, null, { query: 'CODEXLATERSECRET' })).results.length, 1, 'indexed');
    assert.deepEqual(await run('CODEXLATERSECRET'), []);
    await appendFile(codexFile(), j({ type: 'turn_context', payload: { cwd: pub } }) + j({ type: 'response_item', timestamp: '2026-10-22T07:00:04Z', payload: { type: 'message', role: 'user', content: [{ text: 'CODEXBACKINPUBLIC again' }] } }));
    await indexer.tick({ embed: false });
    assert.equal((await run('CODEXBACKINPUBLIC')).length, 1);
  });
  test('reflections keep the host and checkout they were written in: foreign, contradictory or missing provenance is refused', async () => {
    const { run } = tenantSearch();
    for (const q of ['FOREIGNHOSTSECRET', 'FOREIGNCWDSECRET', 'UNKNOWNHOSTSECRET', 'LABELCONFLICTSECRET', 'WORKTREEPRIVATESECRET', 'CWDONLYSECRET']) assert.deepEqual(await run(q), [], q);
    // Stored: the chunk's cwd is the exported checkout, never the CLI's cwd (none without a checkout).
    const cwdOf = (id) => store.db.prepare('SELECT cwd FROM chunks WHERE path = ?').get(`reflection:${id}`).cwd;
    assert.equal(cwdOf('worktree'), path.join(path.dirname(pub), 'Alpha-private-wt'));
    assert.equal(cwdOf('cwd-only'), null);
    // The owner's search is unchanged.
    for (const q of ['WORKTREEPRIVATESECRET', 'CWDONLYSECRET']) assert.equal((await search(store, null, { query: q })).results.length, 1, q);
    const ok = await run('APPROVEDREFLECTION');
    assert.equal(ok.length, 1); assert.equal(ok[0].id, 'ok'); assert.equal(ok[0].project, pub);
    // Served by another approved host, a reflection still answers for the host that wrote it.
    const pc = tenantSearch(() => [{ host: 'pc', store }]);
    assert.deepEqual(await pc.run('APPROVEDREFLECTION'), [], 'pc is not approved: the answering host is checked too');
  });
  test('a copy from a peer without provenance (an older Drover) withholds the hit, even beside an authorized copy', async () => {
    const legacy = { search: async () => ({ results: (await search(store, null, { query: 'PUBLICGREETING', mode: 'keyword' })).results.map(({ provenance, ...r }) => r) }) };
    const dispatch = async (op, args) => {
      const own = (await search(store, null, { ...args, mode: 'keyword' })).results;
      return { results: mergeHosts([{ host: 'box-a', results: own }, { host: 'box-a', results: (await legacy.search()).results }], { limit: args.limit }) };
    };
    const tool = botTools(grant(), { dispatch, host: 'box-a', readEvents: async () => [] }).find((t) => t.name === 'drover_search');
    assert.deepEqual((await tool.run(null, { query: 'PUBLICGREETING' })).results, []);
  });
  test('an index from before per-chunk provenance answers tenants with nothing until the next pass re-reads it', async () => {
    store.close();
    // Turn the file back into what the previous Drover wrote: no provenance columns, transcripts read by extractor 2.
    const raw = new DatabaseSync(dbFile);
    raw.exec(`DROP INDEX chunks_cwd; ALTER TABLE chunks DROP COLUMN cwd; ALTER TABLE chunks DROP COLUMN host; ALTER TABLE chunks DROP COLUMN pending; ALTER TABLE sources DROP COLUMN last_cwd;
      ALTER TABLE sources DROP COLUMN cwd_state; ALTER TABLE reflections DROP COLUMN host; ALTER TABLE reflections DROP COLUMN cwd; ALTER TABLE reflections DROP COLUMN checkout; UPDATE sources SET xv = 2;`);
    raw.close();
    const ro = new Store(dbFile, { readOnly: true });
    try {
      store = ro;
      assert.deepEqual(await tenantSearch().run('PUBLICGREETING'), [], 'old file, read-only: fail closed');
      assert.ok((await search(ro, null, { query: 'PUBLICGREETING' })).results.length > 0, 'the owner still searches it');
    } finally { ro.close(); }
    store = new Store(dbFile);
    assert.deepEqual(await tenantSearch().run('PUBLICGREETING'), [], 'migrated, not yet re-read: fail closed');
    assert.deepEqual(await tenantSearch().run('APPROVEDREFLECTION'), []);
    indexer = new Indexer({ store, roots, memoryHomes: async () => ({}), kinds: ['claude', 'codex', 'reflection'], env: { ...process.env, DROVER_SEARCH_SKIP: 'off' }, log: () => {} });
    await indexer.tick({ embed: false });
    const { run } = tenantSearch();
    assert.equal((await run('PUBLICGREETING')).length, 1, 'transcripts re-read under the current EXTRACT_VERSION');
    assert.equal((await run('APPROVEDREFLECTION')).length, 1, 'the full reflections export after the migration brought host and checkout');
    for (const q of ['PRIVATECHECKOUTSECRET', 'CODEXLATERSECRET', 'FOREIGNHOSTSECRET', 'FOREIGNCWDSECRET', 'UNKNOWNHOSTSECRET', 'WORKTREEPRIVATESECRET', 'CWDONLYSECRET']) assert.deepEqual(await run(q), [], q);
  });
  test('an index whose reflections took the CLI\'s cwd (before checkout) withholds them at once, and until the next export', async () => {
    store.close();
    // What the previous Drover wrote: every reflection chunk's cwd was the exported cwd, the main worktree's root.
    const raw = new DatabaseSync(dbFile);
    raw.exec(`ALTER TABLE reflections DROP COLUMN checkout; UPDATE chunks SET cwd = '${pub}' WHERE kind = 'reflection'; UPDATE reflections SET cwd = '${pub}';`);
    raw.close();
    const ro = new Store(dbFile, { readOnly: true });
    try {
      store = ro;
      for (const q of ['WORKTREEPRIVATESECRET', 'CWDONLYSECRET', 'APPROVEDREFLECTION']) assert.deepEqual(await tenantSearch().run(q), [], `read-only, no checkout column: ${q}`);
      assert.equal((await search(ro, null, { query: 'WORKTREEPRIVATESECRET' })).results.length, 1, 'the owner still searches it');
    } finally { ro.close(); }
    store = new Store(dbFile);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE kind = 'reflection' AND cwd IS NOT NULL").get().n, 0, 'the migration forgets every reflection checkout');
    for (const q of ['WORKTREEPRIVATESECRET', 'CWDONLYSECRET', 'APPROVEDREFLECTION']) assert.deepEqual(await tenantSearch().run(q), [], `migrated, not yet exported: ${q}`);
    assert.equal(store.getMeta('reflections_day'), '', 'the next pass is a full export');
    indexer = new Indexer({ store, roots, memoryHomes: async () => ({}), kinds: ['claude', 'codex', 'reflection'], env: { ...process.env, DROVER_SEARCH_SKIP: 'off' }, log: () => {} });
    await indexer.tick({ embed: false });
    const { run } = tenantSearch();
    assert.equal((await run('APPROVEDREFLECTION')).length, 1);
    for (const q of ['WORKTREEPRIVATESECRET', 'CWDONLYSECRET']) assert.deepEqual(await run(q), [], q);
  });
});
