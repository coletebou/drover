// Which checkout a Codex item was in, end to end (real rollout files through the Indexer into a Store, then search(),
// mergeHosts() and the tenant drover_search tool), for the orders Codex actually writes:
//  - up to ~0.46 a turn's prompt is recorded BEFORE its turn_context (one per model request), and a cwd change first
//    records an <environment_context> item naming the new cwd;
//  - `codex resume` appends to the same rollout with no new session_meta, possibly from another checkout;
//  - current Codex records the turn_context first, but its error and abort paths record a prompt with none.
// A prompt no turn_context covers waits for the next one and is released only when that agrees with the cwd in effect;
// anything else fails closed (cwd NULL). The vector leg is off for tenants: vectors embed session titles.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../core/search/store.js';
import { Indexer } from '../core/search/indexer.js';
import { search, mergeHosts } from '../core/search/query.js';
import { botTools } from '../core/bots/tools.js';
import { tenantBot } from '../core/bots/access.js';

const j = (o) => JSON.stringify(o) + '\n';
const meta = (id, cwd) => j({ type: 'session_meta', payload: { id, cwd } });
const ctx = (cwd) => j({ type: 'turn_context', payload: { cwd, model: 'gpt-5' } });
const ev = (type) => j({ type: 'event_msg', payload: { type } });
const msg = (role, text, ts = '2026-10-22T07:00:00Z') => j({ type: 'response_item', timestamp: ts, payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
const user = (t) => msg('user', t), said = (t) => msg('assistant', t);
const envCtx = (...cwds) => user(`<environment_context>\n${cwds.map((c) => `  <cwd>${c}</cwd>`).join('\n')}\n  <shell>zsh</shell>\n</environment_context>`);
const tool = (cmd) => j({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd }) } });

let dir, pub, priv, codexRoot, store, indexer;
const file = (n) => path.join(codexRoot, `rollout-2026-10-22T07-00-00-019f0000-0000-0000-0000-${String(n).padStart(12, '0')}.jsonl`);
const id = (n) => `019f0000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const grant = () => ({ grantId: 'proof', bot: tenantBot('alice'), scopes: ['drover.read'], resourceAccess: { version: 1, tenant: 'alice', bot: tenantBot('alice'), requester: 'user:alice', projects: [pub], hosts: ['box-a'] } });
async function tenant(query, { engine = null, mode = 'keyword', on = store } = {}) {
  const dispatch = async (op, args) => ({ results: mergeHosts([{ host: 'box-a', results: (await search(on, engine, { ...args, mode })).results }], { limit: args.limit }) });
  return (await botTools(grant(), { dispatch, host: 'box-a', readEvents: async () => [] }).find((t) => t.name === 'drover_search').run(null, { query })).results;
}
const owner = async (query) => (await search(store, null, { query, mode: 'keyword' })).results;
const chunk = (word) => store.db.prepare('SELECT cwd, pending FROM chunks WHERE text LIKE ?').get(`%${word}%`);
const tick = () => indexer.tick({ embed: false });
const released = async (word) => (await tenant(word)).length;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'drover-tenant-codex-'));
  pub = path.join(dir, 'code', 'alpha'); priv = path.join(dir, 'private', 'alpha');
  codexRoot = path.join(dir, 'codex');
  await mkdir(pub, { recursive: true }); await mkdir(priv, { recursive: true }); await mkdir(codexRoot, { recursive: true });
  store = new Store(path.join(dir, 'search.sqlite'));
  indexer = new Indexer({ store, roots: { codex: codexRoot }, memoryHomes: async () => ({}), kinds: ['codex'], env: { ...process.env, DROVER_SEARCH_SKIP: 'off' }, log: () => {} });
});
after(async () => { store?.close(); await rm(dir, { recursive: true, force: true }); });

describe('Codex items are attributed to the checkout their own turn ran in, failing closed', () => {
  test('Codex 0.46 order (prompt before its turn_context): an <environment_context> cwd switch moves the prompt with it', async () => {
    await writeFile(file(1), [
      meta(id(1), pub), envCtx(pub), user('# AGENTS.md instructions'),
      user('OLDPUBLICPROMPT first turn'), ctx(pub), said('OLDPUBLICANSWER'), tool('echo OLDPUBLICCOMMAND'), ctx(pub), said('OLDPUBLICSECONDREQUEST'),
      // A UserTurn with another cwd: the environment_context naming it comes first, then the prompt, then its turn_context.
      envCtx(priv), user('OLDSWITCHPROMPTSECRET typed in the private checkout'), ctx(priv), said('OLDSWITCHANSWERSECRET'), tool('echo OLDSWITCHCOMMANDSECRET'),
      // Back, the same way.
      envCtx(pub), user('OLDBACKPROMPT in the approved checkout again'), ctx(pub), said('OLDBACKANSWER'),
    ].join(''));
    await tick();
    for (const w of ['OLDPUBLICPROMPT', 'OLDPUBLICANSWER', 'OLDPUBLICCOMMAND', 'OLDPUBLICSECONDREQUEST', 'OLDBACKPROMPT', 'OLDBACKANSWER']) assert.equal(await released(w), 1, w);
    for (const w of ['OLDSWITCHPROMPTSECRET', 'OLDSWITCHANSWERSECRET', 'OLDSWITCHCOMMANDSECRET']) {
      assert.deepEqual(await tenant(w), [], w);
      assert.equal((await owner(w)).length, 1, `owner still finds ${w}`);
    }
    assert.equal(chunk('OLDSWITCHPROMPTSECRET').cwd, priv, 'the prompt is in the checkout its turn ran in, not the one before it');
  });
  test('a cwd change with no <environment_context>: the prompt before the new turn_context is of unknown checkout', async () => {
    await writeFile(file(2), [meta(id(2), pub), user('NOENVFIRST'), ctx(pub), said('ok'), user('NOENVSWITCHSECRET'), ctx(priv), said('NOENVANSWERSECRET')].join(''));
    await tick();
    assert.equal(await released('NOENVFIRST'), 1);
    for (const w of ['NOENVSWITCHSECRET', 'NOENVANSWERSECRET']) assert.deepEqual(await tenant(w), [], w);
    assert.deepEqual({ ...chunk('NOENVSWITCHSECRET') }, { cwd: null, pending: null }, 'settled to unknown for good');
  });
  test('`codex resume` in another checkout appends with no session_meta: the resumed prompt is never released', async () => {
    await writeFile(file(3), [meta(id(3), pub), user('RESUMEFIRST public'), ctx(pub), said('ok')].join(''));
    await tick();
    await appendFile(file(3), [user('RESUMEDPROMPTSECRET typed after resuming in the private checkout'), ctx(priv), said('RESUMEDANSWERSECRET')].join(''));
    await tick();
    assert.equal(await released('RESUMEFIRST'), 1);
    for (const w of ['RESUMEDPROMPTSECRET', 'RESUMEDANSWERSECRET']) assert.deepEqual(await tenant(w), [], w);
    // Resumed again, in the approved checkout: the prompt was typed while the private checkout was in effect, so it
    // stays unknown; the answers after the approved turn_context are released.
    await appendFile(file(3), [user('RESUMEDBACKPROMPT'), ctx(pub), said('RESUMEDBACKANSWER')].join(''));
    await tick();
    assert.deepEqual(await tenant('RESUMEDBACKPROMPT'), []);
    assert.equal(await released('RESUMEDBACKANSWER'), 1);
  });
  test('a prompt waiting for its turn_context stays withheld across passes, then is settled by it', async () => {
    await writeFile(file(4), [meta(id(4), pub), user('WAITFIRST'), ctx(pub), said('ok'), user('WAITINGPROMPT not yet answered')].join(''));
    await tick();
    assert.deepEqual(await tenant('WAITINGPROMPT'), [], 'pending: withheld');
    assert.deepEqual({ ...chunk('WAITINGPROMPT') }, { cwd: null, pending: 1 });
    assert.equal((await owner('WAITINGPROMPT')).length, 1, 'the owner finds it at once');
    assert.match(store.source(file(4)).cwd_state, /"pending":\{"before":"[^"]+alpha","mixed":false\}/);
    await appendFile(file(4), [ctx(pub), said('WAITANSWER')].join(''));
    await tick();
    assert.equal(await released('WAITINGPROMPT'), 1, 'the next pass settles what the previous one stored');
    assert.deepEqual({ ...chunk('WAITINGPROMPT') }, { cwd: pub, pending: null });
    // The same, settled by a turn_context in another checkout: unknown for good.
    await appendFile(file(4), user('WAITINGOTHERSECRET'));
    await tick();
    await appendFile(file(4), [ctx(priv), said('x')].join(''));
    await tick();
    assert.deepEqual(await tenant('WAITINGOTHERSECRET'), []);
    assert.deepEqual({ ...chunk('WAITINGOTHERSECRET') }, { cwd: null, pending: null });
  });
  test('current Codex: a prompt its error or abort path recorded with no turn_context is never released', async () => {
    await writeFile(file(5), [
      meta(id(5), pub),
      ev('task_started'), ctx(pub), envCtx(pub), user('CURRENTPUBLIC prompt after its turn_context'), said('CURRENTANSWER'), ev('task_complete'),
      // A turn (here with a cwd override to the private checkout) whose pre-sampling compaction failed: the prompt is
      // recorded, no turn_context or environment_context, then the turn ends.
      ev('task_started'), user('ABORTEDPROMPTSECRET for a turn that never ran'), ev('error'), ev('task_complete'),
      ev('task_started'), user('INTERRUPTEDPROMPTSECRET'), ev('turn_aborted'),
      ev('task_started'), ctx(pub), user('AFTERABORT next turn'), said('AFTERABORTANSWER'), ev('task_complete'),
    ].join(''));
    await tick();
    for (const w of ['CURRENTPUBLIC', 'CURRENTANSWER', 'AFTERABORT', 'AFTERABORTANSWER']) assert.equal(await released(w), 1, w);
    for (const w of ['ABORTEDPROMPTSECRET', 'INTERRUPTEDPROMPTSECRET']) assert.deepEqual(await tenant(w), [], w);
    // Cut at the aborted prompt (the pass ends there): the next pass's turn boundary settles it to unknown, never
    // the next turn's turn_context.
    await writeFile(file(6), [meta(id(6), pub), ev('task_started'), ctx(pub), user('CUTFIRST'), said('ok'), ev('task_complete'), ev('task_started'), user('CUTABORTEDSECRET')].join(''));
    await tick();
    await appendFile(file(6), [user('<turn_aborted>\nThe user interrupted the previous turn.\n</turn_aborted>'), ev('task_started'), ctx(pub), user('CUTNEXT'), said('ok')].join(''));
    await tick();
    assert.deepEqual(await tenant('CUTABORTEDSECRET'), []);
    assert.equal(await released('CUTNEXT'), 1);
  });
  test('current Codex order with an <environment_context> before the turn_context, and several environments', async () => {
    await writeFile(file(7), [
      meta(id(7), pub),
      ev('task_started'), envCtx(priv), ctx(priv), user('CURRENTSWITCHSECRET'), said('CURRENTSWITCHANSWERSECRET'), ev('task_complete'),
      ev('task_started'), envCtx(pub), ctx(pub), user('CURRENTBACK'), ev('task_complete'),
      // Two environments: which one the turn ran in is unknown, so its items are too.
      ev('task_started'), ctx(pub), envCtx(pub, priv), user('TWOENVSECRET'), said('TWOENVANSWERSECRET'), ev('task_complete'),
      // Steered input mid-turn has no turn_context of its own: withheld (fail closed), the turn's prompt is released.
      ev('task_started'), ctx(pub), user('STEERFIRST'), said('working'), user('STEEREDINPUT'), said('done'), ev('task_complete'),
    ].join(''));
    await tick();
    for (const w of ['CURRENTSWITCHSECRET', 'CURRENTSWITCHANSWERSECRET', 'TWOENVSECRET', 'TWOENVANSWERSECRET', 'STEEREDINPUT']) assert.deepEqual(await tenant(w), [], w);
    for (const w of ['CURRENTBACK', 'STEERFIRST']) assert.equal(await released(w), 1, w);
  });
  test('the chunks of an old extraction are read again: EXTRACT_VERSION covers the new attribution', async () => {
    const { EXTRACT_VERSION } = await import('../core/search/indexer.js');
    assert.ok(EXTRACT_VERSION >= 4);
    assert.ok(store.sources().filter((s) => s.kind === 'codex').every((s) => s.xv === EXTRACT_VERSION));
  });
});

describe('checkout-scoped search ranks without vectors', () => {
  test('a hidden session title cannot be probed through the vector leg; the owner keeps semantic ranking', async () => {
    // Two sessions whose first prompt (their title) was in a private checkout and whose answers were in the approved one.
    const claude = path.join(dir, 'claude');
    await mkdir(path.join(claude, 'x'), { recursive: true });
    const sess = (sid, first, then) => writeFile(path.join(claude, 'x', `${sid}.jsonl`), j({ type: 'user', uuid: `${sid}u`, timestamp: '2026-10-22T07:00:00Z', cwd: priv, sessionId: sid, message: { content: first } })
      + j({ type: 'assistant', uuid: `${sid}a`, timestamp: '2026-10-22T07:00:01Z', cwd: pub, sessionId: sid, message: { content: [{ type: 'text', text: then }] } }));
    await sess('s1', 'falcon acquisition merger term sheet', 'ran the unit tests, all green');
    await sess('s2', 'weekly lunch menu planning', 'ran the unit tests, all good');
    const VOCAB = ['falcon', 'acquisition', 'merger', 'lunch', 'menu', 'tests'];
    const vec = (t) => { const s = t.toLowerCase(); const v = new Float32Array(256); VOCAB.forEach((w, i) => { v[i] = s.includes(w) ? 1 : 0; }); v[VOCAB.length] = 0.1; const n = Math.hypot(...v); return v.map((x) => x / n); };
    const embedder = { installed: () => true, batch: 16, embed: async (ts) => ts.map(vec), modelId: () => 'toy' };
    const vs = new Store(path.join(dir, 'vec.sqlite'));
    try {
      await new Indexer({ store: vs, embedder, roots: { claude }, memoryHomes: async () => ({}), kinds: ['claude'], env: { ...process.env, DROVER_SEARCH_SKIP: 'off' }, log: () => {} }).tick();
      assert.ok(vs.vectors().n >= 4, 'vectors built (from title and text)');
      for (const q of ['falcon acquisition', 'lunch menu']) {
        assert.deepEqual(await tenant(q, { engine: embedder, mode: 'hybrid', on: vs }), [], `${q}: nothing ranks by the hidden title`);
        const r = await search(vs, embedder, { query: q, mode: 'hybrid', repoIdentity: pub, originHosts: ['box-a'] });
        assert.equal(r.vector, 'off'); assert.deepEqual(r.results, []);
      }
      // The answers are still found by their own words, with no vector leg.
      const words = await tenant('unit tests', { engine: embedder, mode: 'hybrid', on: vs });
      assert.equal(words.length, 2); assert.ok(words.every((h) => h.title === null && h.legs?.vec == null));
      const own = await search(vs, embedder, { query: 'falcon acquisition', mode: 'hybrid' });
      assert.equal(own.vector, 'ok'); assert.equal(own.results[0].sessionId, 's1', 'owner search unchanged');
    } finally { vs.close(); }
  });
});
