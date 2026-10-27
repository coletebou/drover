// A search's remote leg (core/search/remote.js): a plugin's remote source (kind brain) asked once by the front, beside
// the index search or the fleet fan-out, fused by rank, kept from work by the guard, and never asked again by the host
// (or this host's daemon) that runs a forwarded index search. The source is a fake registered as a plugin; the other
// host is a fake `ssh boxa drover rpc` that answers in this process through dispatch, the way that host's daemon
// would (rpc -> search service -> daemon HTTP -> dispatch), so a second brain call there would be counted here.
import { test, describe, before, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import path from 'node:path';

const tmp = await mkdtemp(path.join(tmpdir(), 'drover-remote-search-'));
process.env.DROVER_CACHE = path.join(tmp, 'cache');
process.env.DROVER_STATE = path.join(tmp, 'state');
process.env.DROVER_DOTFILES = path.join(tmp, 'dotfiles');
process.env.DROVER_EVENTS = path.join(tmp, 'dotfiles', 'claude', 'drover-events.jsonl');
await mkdir(path.join(tmp, 'dotfiles', 'claude'), { recursive: true });
await mkdir(path.join(tmp, 'state'), { recursive: true });
await writeFile(path.join(tmp, 'dotfiles', 'claude', 'fleet-hosts.txt'), 'boxa\nacme-dev\n');
const HOME = path.join(tmp, 'home');
await mkdir(HOME, { recursive: true });

const api = await import('../core/api.js');
const plugins = await import('../core/plugins.js');
const rs = await import('../core/search/remote.js');
const remote = await import('../core/remote.js');
const { search, KINDS, REMOTE_KINDS, QUERY_KINDS } = await import('../core/search/query.js');
const { Store } = await import('../core/search/store.js');
const cli = await import('../core/cli-op.js');
const { formatResults, remoteLine } = await import('../core/search/format.js');
const { localShortName } = await import('../core/hosts.js');

// ---------------------------------------------------------------- fakes
// One clock reading for every fake hit: mergeHosts breaks a score tie by recency, so equal hits must have equal times.
const NOW = Date.now();
const ts = (daysAgo) => new Date(NOW - daysAgo * 86400_000).toISOString();
/** The index's answer on a host: three hits, best first, as search() shapes them. */
const indexHits = (host = 'mac') => [
  { hash: `${host}-h1`, score: 0.0312, kind: 'claude', sessionId: 's1', title: 'one', role: 'assistant', snippet: 'first', ts: ts(1) },
  { hash: `${host}-h2`, score: 0.0201, kind: 'wal', title: 'two', role: 'note', snippet: 'second', ts: ts(2) },
  { hash: `${host}-h3`, score: 0.0105, kind: 'memory', title: 'three', role: 'memory', snippet: 'third', ts: ts(3) },
];
/** Two brain hits as the personal plugin maps them (its own test covers that mapping). */
const brainHits = () => [
  { title: 'Drover search index', snippet: 'the index\n\nlives on   every host', ts: ts(1), slug: 'drover-search-index-1', namespace: 'repo:drover', tier: 'episodic', author: 'agent@mac', role: 'decision', score: 0.84, sessionId: 'not-a-session', path: '/etc/passwd' },
  { title: 'Older note', snippet: 'from last year', ts: ts(400), slug: 'older-note-2', namespace: 'shared', tier: 'curated', author: 'agent@pc', role: 'memory', score: 0.61 },
];

// What looks like work in these tests (DROVER_WORK_CONTEXT), made-up names only: an operator sets their own.
const WORK = String.raw`\b(acme|ini-?tech|initech|onedrive-ini-tech|acme-dev\w*|privcloud|us-priv|acme-beta|wk\d{6}\w*|dev ?pods?|nexus)\b`;

let indexCalls = [], brainCalls = [], rpcCalls = [];
let brainImpl = async () => ({ hits: brainHits() });
const realIndex = api.local['search.semantic'];

/** The fake `ssh <host> drover rpc`: every request goes through dispatch, as that host's daemon would run it. */
function fakeRpcHosts() {
  remote._deps.spawn = (_bin, argv) => {
    const host = argv.find((a) => ['boxa', 'acme-dev'].includes(a)) ?? '?';
    const c = new EventEmitter();
    c.stdout = new PassThrough(); c.stderr = new PassThrough();
    const reply = (msg) => c.stdout.write(JSON.stringify(msg) + '\n');
    c.stdin = {
      write(d, cb) {
        for (const line of String(d).split('\n').filter(Boolean)) {
          const req = JSON.parse(line);
          rpcCalls.push({ host, op: req.op, args: req.args });
          Promise.resolve().then(() => api.dispatch(req.op, req.args))
            .then((r) => reply({ id: req.id, ok: true, result: { ...r, host, results: (r.results ?? []).map((x) => ({ ...x, hash: `${host}:${x.hash}` })) } }), (e) => reply({ id: req.id, ok: false, error: e.message }));
        }
        cb?.();
      },
      end() { setImmediate(() => c.emit('close', 0)); }, on() {},
    };
    c.kill = () => { setImmediate(() => c.emit('close', null)); };
    return c;
  };
}

before(() => {
  fakeRpcHosts();
  plugins.register({ name: 'brainfake', search: { remote: { brain: (q) => { brainCalls.push(q); return brainImpl(q); } } } });
  api.local['search.semantic'] = async (args) => { indexCalls.push(args); return { host: 'mac', query: args.query, mode: 'hybrid', vector: 'ok', results: indexHits(), sessions: [], ms: 3, notes: [] }; };
});
beforeEach(() => {
  indexCalls = []; brainCalls = []; rpcCalls = [];
  brainImpl = async () => ({ hits: brainHits() });
  rs._deps.env = { DROVER_WORK_CONTEXT: WORK };   // no DF_IDENTITY, no DROVER_SEARCH_* settings
  rs._deps.home = () => HOME;       // no ~/.df-profile unless a test writes one
});
afterEach(() => remote.stopAll());
after(async () => { api.local['search.semantic'] = realIndex; plugins._reset(); await rm(tmp, { recursive: true, force: true }); });

// ---------------------------------------------------------------- fusion
describe('fusion by rank', () => {
  test('position p of either list scores 1/(61+p), the index first on a tie; limit keeps the best; sourceScore keeps the own score', () => {
    const local = [{ title: 'L0', score: 0.03 }, { title: 'L1', score: 0.02 }, { title: 'L2', score: 0.01 }];
    const brain = [{ title: 'B0', score: 0.9 }, { title: 'B1', score: 0.8 }];
    const out = rs.fuse(local, [brain], 4);
    assert.deepEqual(out.map((r) => r.title), ['L0', 'B0', 'L1', 'B1']);
    assert.deepEqual(out.map((r) => r.score), [1 / 61, 1 / 61, 1 / 62, 1 / 62].map((s) => Number(s.toFixed(6))));
    assert.deepEqual(out.map((r) => r.sourceScore), [0.03, 0.9, 0.02, 0.8]);
    assert.deepEqual(rs.fuse(local, [brain], 20).map((r) => r.title), ['L0', 'B0', 'L1', 'B1', 'L2'], 'the shorter list runs out, the rest follow in order');
    assert.equal(rs.fuse(local, [brain], 1).length, 1);
    assert.deepEqual(rs.fuse([], [brain], 20).map((r) => r.title), ['B0', 'B1']);
  });
  test('no remote hits: the index\'s own list, unchanged (same scores)', () => {
    const local = indexHits();
    assert.equal(rs.withRemote(local, [], 20), local);
    assert.equal(rs.withRemote(local, [[]], 20), local);
  });
  test('kind brain is a query kind, never an indexed one', () => {
    assert.deepEqual(REMOTE_KINDS, ['brain']);
    assert.ok(!KINDS.includes('brain'), 'KINDS drives the indexer and purges: brain is not in it');
    assert.deepEqual(QUERY_KINDS, [...KINDS, 'brain']);
  });
});

// ---------------------------------------------------------------- search.semantic at the front
describe('search.semantic with the brain', () => {
  test('one brain call beside the index search; hits fused by rank in the result shape; remote.brain says it was included', async () => {
    const r = await api.dispatch('search.semantic', { remote: true, query: 'drover search index', limit: 4, callerCwd: '/Users/c/code/drover' });
    assert.equal(brainCalls.length, 1);
    const { signal, ...asked } = brainCalls[0];
    assert.deepEqual(asked, { query: 'drover search index', limit: 4 });
    assert.ok(signal instanceof AbortSignal); assert.equal(signal.aborted, false, 'an answered source is not aborted');
    assert.equal(indexCalls.length, 1);
    assert.equal(indexCalls[0].remote, false, 'the index search says the remote leg is done');
    assert.equal('callerCwd' in indexCalls[0], false, 'callerCwd stays at the front');
    assert.deepEqual(r.results.map((x) => x.title), ['one', 'Drover search index', 'two', 'Older note']);
    const b = r.results[1];
    assert.deepEqual({ kind: b.kind, host: b.host, slug: b.slug, namespace: b.namespace, tier: b.tier, author: b.author, role: b.role, sourceScore: b.sourceScore }, { kind: 'brain', host: 'brain', slug: 'drover-search-index-1', namespace: 'repo:drover', tier: 'episodic', author: 'agent@mac', role: 'decision', sourceScore: 0.84 });
    assert.equal(b.snippet, 'the index lives on every host', 'one line, as the index\'s snippets');
    assert.equal(b.sessionId, undefined, 'a remote hit never names a session or a path on a host');
    assert.equal(b.path, undefined);
    assert.equal(r.results[0].score, Number((1 / 61).toFixed(6)));
    assert.equal(r.results[0].sourceScore, 0.0312);
    assert.equal(r.remote.brain.included, true); assert.equal(r.remote.brain.hits, 2); assert.equal(typeof r.remote.brain.ms, 'number');
    assert.equal(r.host, 'mac'); assert.equal(r.vector, 'ok');
  });
  test('kinds ["brain"] only: no index search at all', async () => {
    const r = await api.dispatch('search.semantic', { remote: true, query: 'drover search index', kinds: ['brain'] });
    assert.equal(indexCalls.length, 0);
    assert.equal(brainCalls.length, 1);
    assert.deepEqual(r.results.map((x) => x.kind), ['brain', 'brain']);
    assert.deepEqual(r.sessions, []); assert.equal(r.vector, null);
    assert.equal(r.remote.brain.included, true);
  });
  test('kinds without brain: the brain is not asked and the answer is the index\'s, with no remote field', async () => {
    const r = await api.dispatch('search.semantic', { remote: true, query: 'drover search index', kinds: ['claude', 'wal'] });
    assert.equal(brainCalls.length, 0);
    assert.deepEqual(indexCalls[0].kinds, ['claude', 'wal']);
    assert.equal(r.remote, undefined);
    assert.deepEqual(r.results.map((x) => [x.hash, x.score, x.sourceScore]), indexHits().map((x) => [x.hash, x.score, undefined]), 'scores untouched, nothing fused');
  });
  test('kinds with brain and others: the index gets the others, the brain is asked', async () => {
    await api.dispatch('search.semantic', { remote: true, query: 'q', kinds: ['brain', 'reflection'] });
    assert.deepEqual(indexCalls[0].kinds, ['reflection']);
    assert.equal(brainCalls.length, 1);
    assert.deepEqual(brainCalls[0].kinds, ['brain', 'reflection'], 'the source sees the kinds asked for');
  });
  test('a brain that times out leaves the index\'s answer as it was', async () => {
    rs._deps.env = { DROVER_WORK_CONTEXT: WORK, DROVER_SEARCH_REMOTE_TIMEOUT_MS: '40' };
    brainImpl = () => new Promise(() => {});   // never answers
    const t0 = Date.now();
    const r = await api.dispatch('search.semantic', { remote: true, query: 'q' });
    assert.ok(Date.now() - t0 < 2000, 'the front waits the timeout, not forever');
    assert.deepEqual(r.results.map((x) => [x.hash, x.score]), indexHits().map((x) => [x.hash, x.score]));
    assert.equal(r.remote.brain.included, false); assert.equal(r.remote.brain.reason, 'timeout');
    assert.equal(brainCalls[0].signal.aborted, true, 'the source is told to stop, so its request does not keep the process alive');
    assert.equal(rs.remoteTimeoutMs({}), 5000, 'default 5 s');
  });
  test('a brain that fails leaves the index\'s answer as it was, with the error as the reason', async () => {
    brainImpl = async () => { throw new Error('the brain is unavailable (HTTP 503 brain_unavailable)'); };
    const r = await api.dispatch('search.semantic', { remote: true, query: 'q' });
    assert.deepEqual(r.results.map((x) => x.hash), indexHits().map((x) => x.hash));
    assert.deepEqual({ included: r.remote.brain.included, reason: r.remote.brain.reason }, { included: false, reason: 'the brain is unavailable (HTTP 503 brain_unavailable)' });
  });
  test('no plugin serves the brain: no remote field, unless the call names the kind (then "no source")', async () => {
    plugins._reset();
    try {
      const all = await api.dispatch('search.semantic', { remote: true, query: 'q' });
      assert.equal(all.remote, undefined);
      assert.equal(all.results.length, 3);
      const named = await api.dispatch('search.semantic', { remote: true, query: 'q', kinds: ['brain'] });
      assert.deepEqual(named.remote, { brain: { included: false, reason: 'no source' } });
      assert.deepEqual(named.results, []);
      assert.equal(indexCalls.length, 1, 'kinds ["brain"] searched no index');
    } finally { plugins.register({ name: 'brainfake', search: { remote: { brain: (q) => { brainCalls.push(q); return brainImpl(q); } } } }); }
  });
  test('days and role filter remote hits too; hits are checked and cut to one line', async () => {
    const r = await api.dispatch('search.semantic', { remote: true, query: 'q', days: 30 });
    assert.deepEqual(r.results.filter((x) => x.kind === 'brain').map((x) => x.slug), ['drover-search-index-1'], 'the 400-day-old entry is out');
    assert.equal(r.remote.brain.hits, 1);
    const byRole = await api.dispatch('search.semantic', { remote: true, query: 'q', role: 'memory' });
    assert.deepEqual(byRole.results.filter((x) => x.kind === 'brain').map((x) => x.slug), ['older-note-2']);
    brainImpl = async () => ({ hits: [null, 'text', { title: 'x'.repeat(500), snippet: 's', ts: 'not a date', score: 'high', kind: 'claude', host: 'mac' }], note: 'stale index' });
    const odd = await api.dispatch('search.semantic', { remote: true, query: 'q', kinds: ['brain'] });
    assert.equal(odd.results.length, 1);
    const h = odd.results[0];
    assert.deepEqual({ kind: h.kind, host: h.host, ts: h.ts, sourceScore: h.sourceScore, titleLength: h.title.length }, { kind: 'brain', host: 'brain', ts: null, sourceScore: null, titleLength: 200 });
    assert.equal(odd.remote.brain.note, 'stale index');
  });
  test('reflections.semantic (the index restricted to reflections) never asks the brain', async () => {
    api.local['search.semantic'] = async (args) => { indexCalls.push(args); return { host: 'mac', query: args.query, vector: 'ok', notes: [], reflectionsIndexed: true, results: [] }; };
    try {
      await api.local['reflections.semantic']({ query: 'breaker' });
      assert.equal(brainCalls.length, 0);
      assert.deepEqual(indexCalls[0].kinds, ['reflection']);
    } finally { api.local['search.semantic'] = async (args) => { indexCalls.push(args); return { host: 'mac', query: args.query, mode: 'hybrid', vector: 'ok', results: indexHits(), sessions: [], ms: 3, notes: [] }; }; }
  });
  test('the index file holds no brain entries: an index search for kinds ["brain"] finds nothing there', async () => {
    const s = new Store(path.join(tmp, 'idx.sqlite'));
    try {
      s.addChunks([{ path: '/x/a.jsonl', kind: 'claude', session_id: 's1', project: 'drover', role: 'user', ts: ts(1), title: 'Breaker', text: 'the circuit breaker trips after five seconds' }]);
      assert.equal((await search(s, null, { query: 'circuit breaker' })).results.length, 1);
      assert.equal((await search(s, null, { query: 'circuit breaker', kinds: ['brain'] })).results.length, 0);
      assert.equal((await search(s, null, { query: 'circuit breaker', kinds: ['brain', 'claude'] })).results.length, 1);
    } finally { s.close(); }
  });
});

// ---------------------------------------------------------------- the work guard
describe('the work guard keeps the query from the brain', () => {
  const blockedBy = async (args, env = {}) => {
    rs._deps.env = { DROVER_WORK_CONTEXT: WORK, ...env };
    const r = await api.dispatch('search.semantic', { remote: true, query: 'how does the search index work', ...args });
    assert.equal(brainCalls.length, 0, `the brain was asked for ${JSON.stringify(args)}`);
    assert.equal(r.remote.brain.included, false);
    assert.equal(r.results.length, 3, 'the index still answers');
    brainCalls = [];
    return r.remote.brain;
  };
  test('control: a personal machine, query and checkout reach the brain', async () => {
    await writeFile(path.join(HOME, '.df-profile'), 'export DF_MACHINE=mac\nexport DF_IDENTITY=personal\n');
    try {
      const r = await api.dispatch('search.semantic', { remote: true, query: 'how does the search index work', project: 'drover', callerCwd: '/Users/c/code/drover' });
      assert.equal(brainCalls.length, 1); assert.equal(r.remote.brain.included, true);
    } finally { await rm(path.join(HOME, '.df-profile'), { force: true }); }
  });
  test('a work identity: DF_IDENTITY in the environment, or ~/.df-profile', async () => {
    assert.deepEqual(await blockedBy({}, { DF_IDENTITY: 'work' }), { included: false, reason: 'work identity' });
    await writeFile(path.join(HOME, '.df-profile'), '# Written by install.sh\nexport DF_MACHINE=roc\nexport DF_IDENTITY=work\nexport DF_ROLE=local\n');
    try { assert.deepEqual(await blockedBy({}, { DF_IDENTITY: 'personal' }), { included: false, reason: 'work identity' }, 'the profile counts even when the environment says personal'); }
    finally { await rm(path.join(HOME, '.df-profile'), { force: true }); }
  });
  test('a work context: the query, project, repoIdentity or the caller\'s checkout', async () => {
    assert.deepEqual(await blockedBy({ query: 'ACME broker auth flow' }), { included: false, reason: 'work context', field: 'query' });
    assert.deepEqual(await blockedBy({ query: 'deploy to acme-dev2 tonight' }), { included: false, reason: 'work context', field: 'query' });
    assert.deepEqual(await blockedBy({ project: 'acme' }), { included: false, reason: 'work context', field: 'project' });
    assert.deepEqual(await blockedBy({ repoIdentity: '/Users/c/code/acme-preserve' }), { included: false, reason: 'work context', field: 'repoIdentity' });
    assert.deepEqual(await blockedBy({ callerCwd: '/Users/c/code/acme/.claude/worktrees/9257-fix' }), { included: false, reason: 'work context', field: 'callerCwd' });
    assert.deepEqual(await blockedBy({ callerCwd: '/Users/c/Library/CloudStorage/OneDrive-Ini-Tech/notes' }), { included: false, reason: 'work context', field: 'callerCwd' });
  });
  test('a work host named: search.semantic host, search.fleet hosts', async () => {
    assert.deepEqual(await blockedBy({ host: 'acme-dev' }), { included: false, reason: 'work context', field: 'host' });
    const f = await api.dispatch('search.fleet', { remote: true, query: 'q', hosts: ['local', 'acme-dev'] });
    assert.equal(brainCalls.length, 0);
    assert.deepEqual(f.remote.brain, { included: false, reason: 'work context', field: 'hosts' });
  });
  test('DROVER_SEARCH_BRAIN=off', async () => {
    assert.deepEqual(await blockedBy({}, { DROVER_SEARCH_BRAIN: 'off' }), { included: false, reason: 'disabled' });
    assert.equal(rs.remoteEnabled('brain', { DROVER_SEARCH_BRAIN: 'on' }), true);
  });
  test('a search scoped to the index\'s own records (a checkout, a session, a reflection status) does not ask', async () => {
    assert.deepEqual(await blockedBy({ repoIdentity: '/Users/c/code/drover' }), { included: false, reason: 'scoped by repoIdentity' });
    assert.deepEqual(await blockedBy({ session: 'abc123' }), { included: false, reason: 'scoped by session' });
    assert.deepEqual(await blockedBy({ status: 'open' }), { included: false, reason: 'scoped by status' });
  });
  test('the operator\'s pattern decides what is work, case-insensitively, as it is written', () => {
    const { re, error } = rs.workPattern({ DROVER_WORK_CONTEXT: WORK });
    assert.equal(error, null);
    for (const s of ['acme', 'ini-tech', 'IniTech', 'onedrive-ini-tech', 'acme-dev', 'acme-devbox', 'privcloud', 'us-priv', 'acme-beta', 'wk102101', 'dev pods', 'devpod', 'Nexus']) assert.equal(rs.workContext({ query: s }, re), 'query', s);
    for (const s of ['drover search index', 'acmes', 'badland brain', 'nexuses', '/Users/c/code/Badland']) assert.equal(rs.workContext({ query: s }, re), null, s);
    // Read at every call: a changed setting holds at once, no restart.
    assert.equal(rs.workContext({ query: 'globex' }, rs.workPattern({ DROVER_WORK_CONTEXT: 'globex' }).re), 'query');
    assert.equal(rs.workPattern({ APXW_WORK_CONTEXT: 'globex' }).re.source, 'globex', 'the old APXW_ spelling, until the shim goes');
  });
  test('a process whose very first read finds it unset fails closed too (a fresh module, nothing cached)', async () => {
    const fresh = await import(`../core/search/remote.js?first-read-${Date.now()}`);
    assert.deepEqual(fresh.workPattern({}), { source: undefined, re: null, error: 'DROVER_WORK_CONTEXT is not set' });
    fresh._deps.env = {}; fresh._deps.home = () => HOME;
    assert.deepEqual(fresh.blocked('brain', { query: 'q' }), { reason: 'DROVER_WORK_CONTEXT is not set' });
  });
  test('it fails closed: unset, empty or a pattern that does not compile asks no remote source, and says what to fix', async () => {
    for (const v of [undefined, '', '   ']) assert.deepEqual(await blockedBy({}, { DROVER_WORK_CONTEXT: v }), { included: false, reason: 'DROVER_WORK_CONTEXT is not set' }, JSON.stringify(v));
    const bad = await blockedBy({}, { DROVER_WORK_CONTEXT: String.raw`\b(acme|initech` });
    assert.deepEqual(bad, { included: false, reason: 'DROVER_WORK_CONTEXT does not compile' });
    assert.doesNotMatch(bad.reason, /acme|initech/, 'the reason never repeats the pattern');
    // Written as a JavaScript literal it would match its own slashes and nothing else: refused rather than taken so.
    assert.deepEqual(await blockedBy({}, { DROVER_WORK_CONTEXT: String.raw`/\b(acme)\b/i` }), { included: false, reason: 'DROVER_WORK_CONTEXT must be the pattern alone, without /.../' });
    // The settings that say no remote search anyway still come first, and say so.
    assert.deepEqual(await blockedBy({}, { DROVER_WORK_CONTEXT: undefined, DROVER_SEARCH_BRAIN: 'off' }), { included: false, reason: 'disabled' });
    assert.deepEqual(await blockedBy({}, { DROVER_WORK_CONTEXT: undefined, DF_IDENTITY: 'work' }), { included: false, reason: 'work identity' });
    assert.equal(remoteLine({ brain: { included: false, reason: 'DROVER_WORK_CONTEXT is not set' } }), 'brain: not searched (DROVER_WORK_CONTEXT is not set)');
  });
  test('DROVER_WORK_CONTEXT=none is the explicit opt-out: nothing is work, and the brain is asked', async () => {
    for (const v of ['none', 'NONE', ' none ']) {
      rs._deps.env = { DROVER_WORK_CONTEXT: v };
      const r = await api.dispatch('search.semantic', { remote: true, query: 'ACME broker auth flow', callerCwd: '/Users/c/code/acme' });
      assert.equal(r.remote.brain.included, true, v);
      assert.equal(brainCalls.length, 1, v);
      brainCalls = [];
    }
    assert.deepEqual(rs.workPattern({ DROVER_WORK_CONTEXT: 'none' }), { source: 'none', re: null, error: null });
  });
});

// ---------------------------------------------------------------- exactly one brain call per query
describe('forwarded and fleet searches ask the brain once, at the front', () => {
  test('search.semantic on another host: the brain is asked here once; the host gets remote: false and no callerCwd', async () => {
    const r = await api.dispatch('search.semantic', { remote: true, host: 'boxa', query: 'drover search index', callerCwd: '/Users/c/code/drover' });
    assert.equal(brainCalls.length, 1, 'one brain call for the query');
    assert.deepEqual(rpcCalls.map((c) => [c.host, c.op]), [['boxa', 'search.semantic']]);
    assert.equal(rpcCalls[0].args.remote, false);
    assert.equal('callerCwd' in rpcCalls[0].args, false);
    assert.equal(rpcCalls[0].args.host, undefined);
    assert.equal(indexCalls.length, 1, 'boxa ran the index search (through its dispatch) without asking the brain');
    assert.equal(r.host, 'boxa');
    assert.deepEqual(r.results.map((x) => x.host ?? 'index'), ['index', 'brain', 'index', 'brain', 'index']);
  });
  test('search.fleet: one brain call for every host searched; each host gets remote: false and no callerCwd', async () => {
    const r = await api.dispatch('search.fleet', { remote: true, query: 'drover search index', hosts: ['local', 'boxa'], limit: 5, callerCwd: '/Users/c/code/drover' });
    assert.equal(brainCalls.length, 1);
    assert.equal(indexCalls.length, 2, 'here and on boxa');
    for (const a of indexCalls) { assert.equal(a.remote, false); assert.equal('callerCwd' in a, false); }
    assert.deepEqual(r.perHost.map((p) => [p.host, p.ok, p.hits]), [[localShortName(), true, 3], ['boxa', true, 3]]);
    // The merged fleet list (here's h1, boxa's h1, here's h2, ...) and the brain's, fused by rank, limit 5.
    assert.deepEqual(r.results.map((x) => [x.host, x.kind]), [[localShortName(), 'claude'], ['brain', 'brain'], ['boxa', 'claude'], ['brain', 'brain'], [localShortName(), 'wal']]);
    assert.equal(r.results[1].slug, 'drover-search-index-1');
    assert.equal(r.remote.brain.included, true);
    assert.deepEqual(r.coverage.searched.length, 2);
  });
  test('search.fleet for kinds ["brain"] asks no host', async () => {
    const r = await api.dispatch('search.fleet', { remote: true, query: 'drover search index', kinds: ['brain'] });
    assert.equal(rpcCalls.length, 0); assert.equal(indexCalls.length, 0);
    assert.equal(brainCalls.length, 1);
    assert.deepEqual(r.perHost, []); assert.deepEqual(r.coverage, { searched: [], notCovered: [], partial: [] });
    assert.deepEqual(r.results.map((x) => x.slug), ['drover-search-index-1', 'older-note-2']);
    await assert.rejects(api.dispatch('search.fleet', { remote: true, query: 'q', kinds: ['brain'], hosts: ['nosuchhost'] }), /not in fleet-hosts\.txt/);
  });
  test('search.fleet with kinds without brain (the bots\' drover_search): no brain call, no remote field', async () => {
    const r = await api.dispatch('search.fleet', { remote: true, query: 'q', hosts: ['local'], kinds: ['claude', 'codex', 'subagent', 'wal', 'memory', 'reflection'] });
    assert.equal(brainCalls.length, 0);
    assert.equal(r.remote, undefined);
    assert.deepEqual(indexCalls[0].kinds, ['claude', 'codex', 'subagent', 'wal', 'memory', 'reflection']);
  });
  test('callerCwd never reaches another host, even on a call that already says remote: false', async () => {
    await api.dispatch('search.semantic', { host: 'boxa', query: 'q', remote: false, callerCwd: '/Users/c/code/drover' });
    assert.equal(brainCalls.length, 0);
    assert.equal('callerCwd' in rpcCalls[0].args, false);
  });
});

// ---------------------------------------------------------------- opt-in: only a front that says so asks
describe('a search that does not say remote: true asks no remote source', () => {
  test('a host over rpc or an older client (no remote: true): the index alone, callerCwd dropped, no remote field', async () => {
    const r = await api.dispatch('search.semantic', { query: 'drover search index', callerCwd: '/Users/c/code/drover' });
    assert.equal(brainCalls.length, 0);
    assert.equal(r.remote, undefined);
    assert.equal(indexCalls.length, 1);
    assert.equal('callerCwd' in indexCalls[0], false);
    const f = await api.dispatch('search.fleet', { query: 'drover search index', hosts: ['local'] });
    assert.equal(brainCalls.length, 0);
    assert.equal(f.remote, undefined);
  });
  test('naming kind brain without remote: true asks nothing; search.fleet says why', async () => {
    const r = await api.dispatch('search.semantic', { query: 'drover search index', kinds: ['brain'] });
    assert.equal(brainCalls.length, 0);
    assert.equal(r.remote, undefined, 'an index search, nothing more');
    const f = await api.dispatch('search.fleet', { query: 'drover search index', kinds: ['brain'] });
    assert.equal(brainCalls.length, 0);
    assert.equal(f.remote.brain.included, false);
    assert.match(f.remote.brain.reason, /remote: true/);
  });
  test('search.fleet naming a work host with host (not hosts) is refused too', async () => {
    const f = await api.dispatch('search.fleet', { remote: true, query: 'release rollout plan', host: 'acme-dev', hosts: ['local'] });
    assert.equal(brainCalls.length, 0);
    assert.deepEqual(f.remote.brain, { included: false, reason: 'work context', field: 'host' });
  });
});

// ---------------------------------------------------------------- the CLI front and the formatter
describe('CLI', () => {
  test('drover op search.semantic and search.fleet carry the command\'s own working directory', async () => {
    const seen = [];
    const real = cli._deps.dispatchRecorded;
    cli._deps.dispatchRecorded = async (op, args) => { seen.push({ op, args }); return {}; };
    try {
      await cli.cliOp('search.fleet', { query: 'q', callerCwd: '/somewhere/else' });
      await cli.cliOp('search.semantic', { query: 'q' });
      await cli.cliOp('search.status', {});
      assert.deepEqual(seen.map((s) => s.args.callerCwd), [process.cwd(), process.cwd(), undefined]);
      assert.deepEqual(seen.map((s) => s.args.remote), [true, true, undefined], 'the CLI is a front');
    } finally { cli._deps.dispatchRecorded = real; }
  });
  test('formatResults names a brain hit\'s slug and how the brain went', () => {
    const out = formatResults({ host: 'mac', ms: 4, remote: { brain: { included: true, hits: 1, ms: 640 } }, results: [{ kind: 'brain', host: 'brain', title: 'Drover search index', snippet: 'the index', role: 'decision', ts: '2026-10-20T20:16:40.798Z', slug: 'drover-search-index-1', namespace: 'repo:drover', author: 'agent@mac' }] });
    assert.match(out, /brain: 1 hit in 640 ms/);
    assert.match(out, /brain drover-search-index-1 \(repo:drover\) by agent@mac/);
    assert.equal(remoteLine({ brain: { included: false, reason: 'work context', field: 'callerCwd' } }), 'brain: not searched (work context)');
    assert.equal(remoteLine(undefined), null);
  });
});
