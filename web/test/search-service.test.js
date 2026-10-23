// Search runtime: the llama-server embedder (with a fake child process and a fake
// HTTP server, so no model is needed), the op layer's forwarding to the local
// daemon and its read-only fallback, and the op/MCP surface.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const STATE = await mkdtemp(path.join(tmpdir(), 'drover-search-svc-'));
process.env.DROVER_STATE = STATE;   // before the modules read it
const { Embedder, defaultThreads, defaultBatch, isLlamaServer, queryText, docText, MODEL_ID, modelIdFor } = await import('../core/search/embed.js');
const service = await import('../core/search/service.js');
const { Store } = await import('../core/search/store.js');
const { META, OPS_KNOWN, isMutating } = await import('../core/ops-meta.js');
const { GENERATED_TOOLS } = await import('../mcp/server.js');

after(async () => { await rm(STATE, { recursive: true, force: true }); });

function fakeRuntime() {
  const bin = path.join(STATE, 'llama-server'), model = path.join(STATE, 'model.gguf');
  return { bin, model, env: { HOME: STATE, DROVER_STATE: STATE, DROVER_LLAMA_SERVER: bin, DROVER_EMBED_MODEL: model, DROVER_EMBED_THREADS: '3', DROVER_EMBED_BATCH: '5' } };
}

function fakes({ healthAfter = 2, status = 200, count = null } = {}) {
  const spawned = [];
  const spawnFn = (file, argv, opts) => {
    const child = new EventEmitter();
    child.pid = 999_999; child.killed = false; child.stderr = new EventEmitter(); child.stderr.setEncoding = () => {};
    child.kill = (sig) => { child.killed = sig; setImmediate(() => child.emit('exit', null, sig)); };
    spawned.push({ file, argv, opts, child });
    return child;
  };
  let health = 0;
  const requests = [];
  const fetchFn = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/health')) { health++; return { ok: health >= healthAfter }; }
    requests.push({ url: u, headers: init.headers, body: JSON.parse(init.body) });
    const inputs = JSON.parse(init.body).input;
    const n = count ?? inputs.length;
    // Out of order on purpose: the client sorts by index.
    const data = Array.from({ length: n }, (_, i) => ({ index: n - 1 - i, embedding: Array.from({ length: 768 }, (_, d) => (d === (n - 1 - i) ? 3 : 0.001)) }));
    return { ok: status === 200, status, text: async () => 'boom', json: async () => ({ data, usage: { prompt_tokens: 7 * inputs.length } }) };
  };
  return { spawnFn, fetchFn, spawned, requests };
}

describe('Embedder', () => {
  before(async () => { const rt = fakeRuntime(); await writeFile(rt.bin, '#!/bin/sh\n'); await writeFile(rt.model, 'gguf'); });

  test('starts llama-server on loopback with the key in the environment, not argv; embeds in input order at 256 dims', async () => {
    const rt = fakeRuntime(); const f = fakes();
    const e = new Embedder({ env: rt.env, spawnFn: f.spawnFn, fetchFn: f.fetchFn, idleMs: 60_000 });
    const out = await e.embed([queryText('one'), docText('t', 'two'), docText(null, 'three')]);
    assert.equal(f.spawned.length, 1);
    const { argv, opts } = f.spawned[0];
    const all = argv.join(' ');
    assert.match(all, /--embedding/); assert.match(all, /--host 127\.0\.0\.1/); assert.match(all, /--parallel 2/); assert.match(all, /-t 3\b/);
    assert.match(all, process.platform === 'darwin' ? /-ngl 99/ : /-ngl 0/);
    const key = opts.env.LLAMA_API_KEY;
    assert.ok(key && key.length >= 20); assert.ok(!all.includes(key), 'the API key is not on the command line');
    assert.equal(f.requests[0].headers.authorization, `Bearer ${key}`);
    assert.deepEqual(f.requests[0].body.input, ['task: search result | query: one', 'title: t | text: two', 'title: none | text: three']);
    assert.equal(out.length, 3);
    for (let i = 0; i < 3; i++) { assert.equal(out[i].length, 256); assert.ok(out[i][i] > 0.99, `vector ${i} is the one for input ${i}`); }
    assert.equal(e.status().inputs, 3); assert.equal(e.status().tokens, 21); assert.equal(e.status().batch, 5);
    assert.ok(existsSync(path.join(STATE, 'embed-server.pid')));
    await e.embed(['again']);
    assert.equal(f.spawned.length, 1, 'the running server is reused');
    e.stop();
    assert.equal(f.spawned[0].child.killed, 'SIGTERM');
    assert.ok(!existsSync(path.join(STATE, 'embed-server.pid')));
    assert.equal(e.running, false);
  });
  test('stops itself when idle, and starts again on the next request', async () => {
    const rt = fakeRuntime(); const f = fakes({ healthAfter: 1 });
    const e = new Embedder({ env: rt.env, spawnFn: f.spawnFn, fetchFn: f.fetchFn, idleMs: 30 });
    await e.embed(['a']);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(e.running, false);
    await e.embed(['b']);
    assert.equal(f.spawned.length, 2);
    e.stop();
  });
  test('HTTP errors and short answers are errors, recorded in status', async () => {
    const rt = fakeRuntime();
    const bad = new Embedder({ env: rt.env, ...fakes({ healthAfter: 1, status: 500 }) });
    await assert.rejects(bad.embed(['x']), /embed HTTP 500: boom/);
    assert.match(bad.status().lastError, /HTTP 500/); bad.stop();
    const short = new Embedder({ env: rt.env, ...fakes({ healthAfter: 1, count: 1 }) });
    await assert.rejects(short.embed(['x', 'y']), /1 vectors for 2 inputs/); short.stop();
  });
  test('a dropped keep-alive connection (ECONNRESET) is retried on a fresh connection; a timeout is not', async () => {
    const rt = fakeRuntime(); const f = fakes({ healthAfter: 1 });
    let resets = 1;
    const flaky = async (url, init) => { if (String(url).endsWith('/v1/embeddings') && resets-- > 0) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); return f.fetchFn(url, init); };
    const e = new Embedder({ env: rt.env, spawnFn: f.spawnFn, fetchFn: flaky });
    const [v] = await e.embed(['x']);
    assert.equal(v.length, 256); assert.equal(e.status().retries, 1); assert.equal(f.spawned.length, 1);
    e.stop();
    let posts = 0;
    const slow = async (url, init) => { if (String(url).endsWith('/v1/embeddings')) { posts++; throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); } return f.fetchFn(url, init); };
    const t = new Embedder({ env: rt.env, spawnFn: f.spawnFn, fetchFn: slow });
    await assert.rejects(t.embed(['x']), /timeout/);
    assert.equal(posts, 1, 'no retry after a timeout'); t.stop();
  });
  test('callers during model load wait for the health check instead of posting to an unready server', async () => {
    const rt = fakeRuntime(); const f = fakes({ healthAfter: 4 });
    let healthy = 0, earlyPosts = 0;
    const watch = async (url, init) => { const r = await f.fetchFn(url, init); if (String(url).endsWith('/health')) { if (r.ok) healthy++; } else if (!healthy) earlyPosts++; return r; };
    const e = new Embedder({ env: rt.env, spawnFn: f.spawnFn, fetchFn: watch });
    assert.equal(e.running, false);
    const [[a], [b]] = await Promise.all([e.embed(['one']), e.embed(['two'])]);
    assert.equal(a.length, 256); assert.equal(b.length, 256);
    assert.equal(earlyPosts, 0); assert.equal(f.spawned.length, 1, 'one server for both callers');
    e.stop();
  });
  test('a server killed by a signal it was not sent records why; our own stop does not', async () => {
    const rt = fakeRuntime(); const f = fakes({ healthAfter: 1 });
    const e = new Embedder({ env: rt.env, spawnFn: f.spawnFn, fetchFn: f.fetchFn });
    await e.embed(['x']);
    const child = f.spawned[0].child;
    child.stderr.emit('data', 'GGML_ASSERT(n_tokens <= n_ubatch) failed\n');
    child.emit('exit', null, 'SIGABRT');
    assert.match(e.status().lastError, /exited SIGABRT: .*GGML_ASSERT/);
    assert.equal(e.running, false);
    const g = new Embedder({ env: rt.env, spawnFn: f.spawnFn, fetchFn: f.fetchFn });
    await g.embed(['y']); g.stop();
    await new Promise((r) => setImmediate(r));
    assert.equal(g.status().lastError, null);
  });
  test('without the runtime installed it says how to install it', async () => {
    const e = new Embedder({ env: { HOME: STATE, DROVER_LLAMA_SERVER: path.join(STATE, 'nope'), DROVER_EMBED_MODEL: path.join(STATE, 'nope.gguf') } });
    assert.equal(e.installed(), false);
    await assert.rejects(e.embed(['x']), /drover embed setup/);
  });
  test('defaults: threads a quarter of the cores (2-8), batch 16 on a Mac and 4 elsewhere; pid check by command', () => {
    assert.equal(defaultThreads({}, 32), 8); assert.equal(defaultThreads({}, 4), 2); assert.equal(defaultThreads({ DROVER_EMBED_THREADS: '12' }, 4), 12);
    assert.equal(defaultBatch({}, 'darwin'), 16); assert.equal(defaultBatch({}, 'linux'), 4); assert.equal(defaultBatch({ DROVER_EMBED_BATCH: '200' }, 'linux'), 64);
    assert.equal(isLlamaServer(process.pid), false, 'node is not llama-server');
    assert.equal(isLlamaServer(1), false); assert.equal(isLlamaServer(-5), false);
    assert.match(MODEL_ID, /^embeddinggemma-2-q8_0@2188ac1deca4\/256$/);
  });
});

describe('model identity and fleet routing', () => {
  test('the pinned model has MODEL_ID; another model file gets its own identity, so its vectors are not mixed', async () => {
    assert.equal(modelIdFor({ HOME: STATE }), MODEL_ID);
    const other = path.join(STATE, 'other-embedder.gguf');
    await writeFile(other, 'not the pinned model');
    const id = modelIdFor({ HOME: STATE, DROVER_EMBED_MODEL: other });
    assert.match(id, /^other-embedder\.gguf@20-\d+\/256$/);
    assert.notEqual(id, MODEL_ID);
  });
  test('search.fleet tags every hit with the alias to open it with', async () => {
    const api = await import('../core/api.js');
    const real = api.local['search.semantic'];
    api.local['search.semantic'] = async () => ({ host: 'ip-10-0-1-23', results: [{ hash: 'h1', score: 0.03, kind: 'claude', sessionId: 's1' }] });
    try {
      let seen = null;
      api.local['search.semantic'] = async (args) => { seen = args; return { host: 'ip-10-0-1-23', results: [{ hash: 'h1', score: 0.03, kind: 'claude', sessionId: 's1' }] }; };
      const r = await api.front['search.fleet']({ query: 'anything', hosts: ['local'], host: 'devbox' });
      assert.equal(seen.host, undefined, 'a host argument never rides along to the per-host searches');
      assert.equal(r.results.length, 1);
      assert.equal(r.results[0].route, 'local');
      assert.equal(r.perHost[0].ok, true);
    } finally { api.local['search.semantic'] = real; }
  });
  test('search.grepFleet reports what each host matched and skipped, not only its hits', async () => {
    const api = await import('../core/api.js');
    const real = api.local['search.grep'];
    const skipped = { blob: 1, outside: 7, filtered: 2, capped: 0, unparsed: 0 };
    api.local['search.grep'] = async () => ({ host: 'ip-10-0-1-23', results: [{ kind: 'claude', sessionId: 's1', role: 'user', ts: '2026-05-01T00:00:00Z', snippet: 'turbo' }], matched: 11, skipped, truncated: false, notes: [] });
    try {
      const r = await api.front['search.grepFleet']({ pattern: 'turbo', hosts: ['local'] });
      assert.equal(r.results[0].route, 'local');
      assert.deepEqual({ hits: r.perHost[0].hits, matched: r.perHost[0].matched, skipped: r.perHost[0].skipped }, { hits: 1, matched: 11, skipped });
    } finally { api.local['search.grep'] = real; }
  });
  test('fleet searches report each host\'s own search time next to the round trip', async () => {
    const api = await import('../core/api.js');
    const sem = api.local['search.semantic'], grep = api.local['search.grep'];
    // The host says its search took 7 ms, but answering took longer (a slow link or a busy front, here a 60 ms wait).
    const later = (v) => new Promise((r) => setTimeout(() => r(v), 60));
    api.local['search.semantic'] = async () => later({ host: 'h', results: [], vector: 'ok', ms: 7, notes: [] });
    api.local['search.grep'] = async () => later({ host: 'h', results: [], matched: 0, ms: 9, notes: [] });
    try {
      const s = await api.front['search.fleet']({ query: 'anything', hosts: ['local'] });
      assert.equal(s.perHost[0].searchMs, 7);
      assert.ok(s.perHost[0].ms >= 55, `round trip ${s.perHost[0].ms} ms includes the wait`);
      const g = await api.front['search.grepFleet']({ pattern: 'turbo', hosts: ['local'] });
      assert.equal(g.perHost[0].searchMs, 9);
      assert.ok(g.perHost[0].ms >= 55);
      api.local['search.semantic'] = async () => ({ host: 'h', results: [] });   // an older host reports no ms
      assert.equal((await api.front['search.fleet']({ query: 'x', hosts: ['local'] })).perHost[0].searchMs, null);
    } finally { api.local['search.semantic'] = sem; api.local['search.grep'] = grep; }
  });
});

describe('search ops (not the daemon)', () => {
  let db;
  before(async () => {
    db = path.join(STATE, 'idx.sqlite');
    const s = new Store(db);
    s.addChunks([{ path: '/x/a.jsonl', kind: 'claude', session_id: 's1', project: 'webapp', role: 'user', ts: new Date().toISOString(), title: 'Breaker', text: 'the circuit breaker trips after five seconds' }]);
    s.close();
    service._deps.env = { ...process.env, DROVER_SEARCH_DB: db };
  });

  test('no daemon running: a read-only keyword search of the index file, with a note', async () => {
    await rm(path.join(STATE, 'daemon.json'), { force: true });
    const r = await service.ops['search.semantic']({ query: 'circuit breaker' });
    assert.equal(r.results.length, 1); assert.equal(r.vector, 'off');
    assert.ok(r.notes.some((n) => /keyword only: daemon not reachable/.test(n)));
    const st = await service.ops['search.status']({});
    assert.equal(st.index.chunks, 1); assert.match(st.note, /not reachable/);
  });
  test('the answer says whether this index has finished a reflections pass (until then reflection searches find nothing)', async () => {
    assert.equal((await service.ops['search.semantic']({ query: 'circuit' })).reflectionsIndexed, false);
    const w = new Store(db); w.setMeta('reflections_day', '2026-10-18'); w.close();
    assert.equal((await service.ops['search.semantic']({ query: 'circuit' })).reflectionsIndexed, true);
  });
  test('a running daemon gets the op over HTTP with the main token; its errors are not masked by the fallback', async () => {
    await writeFile(path.join(STATE, 'daemon.json'), JSON.stringify({ url: 'http://127.0.0.1:7337/' }));
    await writeFile(path.join(STATE, 'token'), 'tok-123\n');
    const calls = [];
    service._deps.fetch = async (url, init) => { calls.push({ url: String(url), init }); return { ok: true, status: 200, json: async () => ({ ok: true, result: { host: 'h', results: [{ hash: 'x' }] } }) }; };
    const r = await service.ops['search.semantic']({ query: 'q', limit: 3 });
    assert.deepEqual(r, { host: 'h', results: [{ hash: 'x' }] });
    assert.equal(calls[0].url, 'http://127.0.0.1:7337/api/op/search.semantic');
    assert.equal(calls[0].init.headers.authorization, 'Bearer tok-123');
    assert.deepEqual(JSON.parse(calls[0].init.body), { query: 'q', limit: 3 });
    service._deps.fetch = async () => ({ ok: false, status: 400, json: async () => ({ ok: false, error: 'query must be a non-empty string' }) });
    await assert.rejects(service.ops['search.semantic']({ query: ' ' }), /non-empty/);
    await assert.rejects(service.ops['search.reindex']({}), /non-empty/, 'reindex has no fallback');
  });
  test('a daemon URL that is not local is refused (falls back), and DROVER_SEARCH=off disables the ops', async () => {
    await writeFile(path.join(STATE, 'daemon.json'), JSON.stringify({ url: 'http://example.com:7337/' }));
    service._deps.fetch = async () => { throw new Error('must not be called'); };
    const r = await service.ops['search.semantic']({ query: 'circuit' });
    assert.ok(r.notes.some((n) => /not local/.test(n)));
    service._deps.env = { ...service._deps.env, DROVER_SEARCH: 'off' };
    await assert.rejects(service.ops['search.semantic']({ query: 'x' }), /disabled/);
    service._deps.env = { ...service._deps.env, DROVER_SEARCH: 'on' };
  });
});

describe('op and MCP surface', () => {
  test('every search op has a schema and a generated MCP tool; reindex is the only mutating one', () => {
    for (const op of ['search.semantic', 'search.fleet', 'search.status', 'search.reindex', 'search.grep', 'search.grepFleet']) {
      assert.ok(OPS_KNOWN.includes(op), op);
      assert.ok(META[op].d.length > 40);
      assert.ok(GENERATED_TOOLS.some((t) => t.name === `drover_${op.replace(/\./g, '_')}`), op);
    }
    assert.deepEqual(META['search.semantic'].s.required, ['query']);
    assert.deepEqual(META['search.fleet'].s.required, ['query']);
    assert.equal(isMutating('search.reindex'), true);
    assert.equal(isMutating('search.semantic'), false);
    assert.equal(isMutating('search.grep'), false); assert.equal(isMutating('search.grepFleet'), false);
    assert.deepEqual(META['search.grep'].s.required, ['pattern']);
    assert.deepEqual(META['search.semantic'].s.properties.kinds.items.enum, ['claude', 'subagent', 'codex', 'wal', 'memory', 'doc', 'reflection', 'preserved']);
  });
});

describe('Search view helpers', () => {
  test('resumeCommand: claude and subagent hits resume the parent session, codex its thread, others none', async () => {
    const { resumeCommand } = await import('../ui/views/search.js');
    assert.equal(resumeCommand({ kind: 'claude', sessionId: 'abc' }), 'claude --resume abc');
    assert.equal(resumeCommand({ kind: 'subagent', sessionId: 'abc' }), 'claude --resume abc');
    assert.equal(resumeCommand({ kind: 'codex', sessionId: 't1' }), 'codex resume t1');
    assert.equal(resumeCommand({ kind: 'wal', sessionId: 's' }), null);
    assert.equal(resumeCommand({ kind: 'claude' }), null);
    // A preserved ref is restored, with the command the hit carries.
    assert.equal(resumeCommand({ kind: 'preserved', ref: 'wip/x-laptop-20261019', restore: `drover op preserve.restore '{"ref":"wip/x-laptop-20261019"}'` }), `drover op preserve.restore '{"ref":"wip/x-laptop-20261019"}'`);
    assert.equal(resumeCommand({ kind: 'preserved', ref: 'wip/x' }), null);
  });
});
