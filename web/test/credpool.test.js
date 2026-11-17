// Credential pool tests. Everything points at a scratch profiles.json, state
// dir and events file through env, and the "secrets" are obviously fake
// strings under test-only variable names. The real variable names are never
// read or written here. Run: node --test test/credentials.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(tmpdir(), 'drover-cred-'));
process.env.DROVER_PROFILES = path.join(dir, 'profiles.json');
process.env.DROVER_STATE = path.join(dir, 'state');
process.env.DROVER_EVENTS = path.join(dir, 'events.jsonl');
process.env.DROVER_HOST = 'testbox';
process.env.DROVER_TEST_MAIN = 'x-fake-main-value-000001';
process.env.DROVER_TEST_FALLBACK = 'x-fake-fallback-value-000002';
delete process.env.DROVER_TEST_GOV;
const FAKES = [process.env.DROVER_TEST_MAIN, process.env.DROVER_TEST_FALLBACK];
const noFakes = (obj, what) => { const s = JSON.stringify(obj); for (const f of FAKES) assert.ok(!s.includes(f), `${what} leaks a credential value`); };

const PROFILES = {
  claude: { models: [{ id: 'opus', label: 'Opus' }], profiles: [{ id: 'claude-skip', label: 'skip permissions', argv: ['--dangerously-skip-permissions'], env: {}, default: true }] },
  codex: { models: [], profiles: [{ id: 'codex-work', label: 'work', argv: ['-p', 'work'], env: {}, default: true }] },
  credentials: {
    pool: [
      { id: 'main', label: 'Main', env: { FAKE_CHILD_TOKEN: '$DROVER_TEST_MAIN' }, weight: 2, maxConcurrent: 3 },
      { id: 'fallback', label: 'Fallback', env: { FAKE_CHILD_TOKEN: '$DROVER_TEST_FALLBACK' }, weight: 1, maxConcurrent: 3 },
      { id: 'gov', label: 'Gov', env: { FAKE_CHILD_TOKEN: '$DROVER_TEST_GOV' }, weight: 1, maxConcurrent: 3 },
    ],
    default: 'auto',
    appliesTo: ['claude'],
  },
};
await writeFile(process.env.DROVER_PROFILES, JSON.stringify(PROFILES));

const credentials = await import('../core/credpool.js');
const launchMod = await import('../core/launch.js');
const { _clock } = credentials;
const realNow = _clock.now;

// ---------------------------------------------------------------- fakes for launch()
const windows = [];
launchMod._deps.newWindow = async (opts) => { windows.push(opts); return { target: `agents:${windows.length}` }; };
let seq = 0;
class FakeHeadless {
  constructor(opts) {
    this.opts = opts; this.sessionId = opts.resume ?? `sess-${++seq}`; this.argv = ['-p', '--fake']; this.sent = []; this.stopped = false;
    FakeHeadless.instances.push(this);
  }
  send(text) { this.sent.push(text); }
  stop() { this.stopped = true; setTimeout(() => this.opts.onExit(0, null), 5); }
  emit(d) { this.opts.onEvent(d); }
}
FakeHeadless.instances = [];
launchMod._deps.HeadlessClaude = FakeHeadless;
// No login shell of the user runs here: the agent PATH is this process's.
launchMod._deps.agentPath = async () => process.env.PATH;
// A tmux launch first trusts its folder in the user's ~/.claude.json or ~/.codex/config.toml: never from here (test/trust.test.js covers that step).
launchMod._deps.trustFolder = async () => null;

const waitFor = async (fn, ms = 3000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 10)); } };
const lastEvent = async () => { const lines = (await readFile(process.env.DROVER_EVENTS, 'utf8')).trim().split('\n'); return { raw: lines.at(-1), ev: JSON.parse(lines.at(-1)) }; };

// ---------------------------------------------------------------- pool + availability

test('loadPool validates and an entry with an unset variable is unavailable and never picked', async () => {
  await credentials._reset({ file: true });
  const pool = await credentials.loadPool();
  assert.deepEqual(pool.pool.map((e) => e.id), ['main', 'fallback', 'gov']);
  assert.equal(pool.default, 'auto');
  const st = await credentials.status();
  const gov = st.pool.find((p) => p.id === 'gov');
  assert.equal(gov.available, false);
  assert.deepEqual(gov.missing, ['DROVER_TEST_GOV']);
  assert.equal(st.pool.find((p) => p.id === 'main').available, true);
  for (let i = 0; i < 6; i++) {
    const p = await credentials.pick('auto', { engine: 'claude' });
    assert.notEqual(p.id, 'gov');
    await credentials.acquire(p.id, `h${i}`);
  }
  await assert.rejects(credentials.pick('gov', { engine: 'claude' }), /credential gov is unavailable: DROVER_TEST_GOV not set/);
  await assert.rejects(credentials.resolveEnv('gov'), /DROVER_TEST_GOV/);
  await assert.rejects(credentials.pick('nope', { engine: 'claude' }), /unknown credential "nope"; known: main, fallback, gov, auto, none/);
  assert.equal(await credentials.pick('auto', { engine: 'codex' }), null, 'engine outside appliesTo');
  assert.equal(await credentials.pick('none', { engine: 'claude' }), null);
});

test('a literal value in profiles.json is rejected, never resolved', async () => {
  const bad = structuredClone(PROFILES);
  bad.credentials.pool[0].env.FAKE_CHILD_TOKEN = 'literal-secret-looking-string';
  await writeFile(process.env.DROVER_PROFILES, JSON.stringify(bad));
  try { await assert.rejects(credentials.loadPool(), /must be a \$NAME reference/); }
  finally { await writeFile(process.env.DROVER_PROFILES, JSON.stringify(PROFILES)); }
});

// ---------------------------------------------------------------- auto pick rules

test('auto picks the lowest active/weight ratio, round robin on ties by lastPick', async () => {
  await credentials._reset({ file: true });
  let p = await credentials.pick('auto', { engine: 'claude' });
  assert.equal(p.id, 'main', 'fresh pool: tie at 0, first in pool order');
  assert.deepEqual(p.env, { FAKE_CHILD_TOKEN: process.env.DROVER_TEST_MAIN });
  assert.match(p.reason, /^auto: tie on load 0 between main, fallback; round robin after none/);
  await credentials.acquire('main', 'a');                      // main 1/2 = 0.5, fallback 0/1 = 0
  p = await credentials.pick('auto', { engine: 'claude' });
  assert.equal(p.id, 'fallback'); assert.match(p.reason, /lowest load 0\/1/);
  await credentials.acquire('fallback', 'b');                  // main 0.5, fallback 1
  p = await credentials.pick('auto', { engine: 'claude' });
  assert.equal(p.id, 'main');
  await credentials.acquire('main', 'c');                      // main 2/2 = 1, fallback 1/1 = 1: tie, lastPick main
  p = await credentials.pick('auto', { engine: 'claude' });
  assert.equal(p.id, 'fallback'); assert.match(p.reason, /tie on load 1 between main, fallback; round robin after main/);
  await credentials.acquire('fallback', 'd');                  // main 1, fallback 2
  p = await credentials.pick('auto', { engine: 'claude' });
  assert.equal(p.id, 'main');
  assert.deepEqual((await credentials.pick('fallback', { engine: 'claude' })).env, { FAKE_CHILD_TOKEN: process.env.DROVER_TEST_FALLBACK });
});

test('maxConcurrent excludes a saturated entry; a fully saturated pool is an error, released handles free it', async () => {
  await credentials._reset({ file: true });
  for (const hnd of ['1', '2', '3']) await credentials.acquire('main', hnd);          // main 3/3
  let p = await credentials.pick('auto', { engine: 'claude' });
  assert.equal(p.id, 'fallback');
  for (const hnd of ['4', '5', '6']) await credentials.acquire('fallback', hnd);      // fallback 3/3
  await assert.rejects(credentials.pick('auto', { engine: 'claude' }), /every available credential is at maxConcurrent: main 3\/3, fallback 3\/3/);
  const rec = await credentials.recommend('auto', { engine: 'claude' });
  assert.equal(rec.id, null); assert.match(rec.reason, /maxConcurrent/);
  const st = await credentials.status();
  assert.equal(st.recommendation, null);
  assert.deepEqual(credentials.release('main', '2'), { id: 'main', released: true, active: 2 });
  assert.deepEqual(credentials.release('main', '2'), { id: 'main', released: false, active: 2 }, 'release is idempotent');
  p = await credentials.pick('auto', { engine: 'claude' });
  assert.equal(p.id, 'main');
});

test('a throttle recorded in the last 2 minutes steers auto away, then expires', async () => {
  await credentials._reset({ file: true });
  let t = Date.parse('2026-10-11T12:00:00Z');
  _clock.now = () => t;
  try {
    const r = await credentials.recordThrottle('main', 'HTTP 429 Too Many Requests');
    assert.equal(r.recentThrottles, 1);
    assert.equal(r.avoidedUntil, '2026-10-11T12:02:00.000Z');
    let p = await credentials.pick('auto', { engine: 'claude' });
    assert.equal(p.id, 'fallback'); assert.match(p.reason, /skipped main \(throttled in the last 2 min\)/);
    const st = await credentials.status();
    assert.equal(st.pool.find((x) => x.id === 'main').recentThrottles, 1);
    assert.equal(st.pool.find((x) => x.id === 'main').lastThrottle, '2026-10-11T12:00:00.000Z');
    assert.equal(st.recommendation, 'fallback');
    await credentials.recordThrottle('fallback', 'throttled too');
    p = await credentials.pick('auto', { engine: 'claude' });
    assert.ok(['main', 'fallback'].includes(p.id), 'when everything is throttled auto still picks');
    t += 2 * 60_000 + 1;
    assert.equal((await credentials.status()).pool.find((x) => x.id === 'main').recentThrottles, 0);
    p = await credentials.pick('auto', { engine: 'claude' });
    assert.equal(p.id, 'main', 'window passed: back to the normal rule (tie, pool order)');
    await assert.rejects(credentials.recordThrottle('nope', 'x'), /unknown credential/);
  } finally { _clock.now = realNow; }
});

test('acquire/release track handles; a ttl handle (tmux) expires on its own', async () => {
  await credentials._reset({ file: true });
  let t = 1_000_000;
  _clock.now = () => t;
  try {
    assert.deepEqual(await credentials.acquire('main', 'tmux:agents:3', { ttlMs: 6 * 3600_000 }), { id: 'main', handle: 'tmux:agents:3', active: 1 });
    await credentials.acquire('main', 'headless-1');
    assert.equal((await credentials.status()).pool[0].active, 2);
    t += 6 * 3600_000 + 1;
    assert.equal((await credentials.status()).pool[0].active, 1, 'the tmux handle expired, the headless one stays');
    credentials.release('main', 'headless-1');
    assert.equal((await credentials.status()).pool[0].active, 0);
    assert.equal((await credentials.status()).pool[0].uses, 2, 'uses counts launches, not current activity');
    await assert.rejects(credentials.acquire('nope', 'x'), /unknown credential/);
  } finally { _clock.now = realNow; }
});

// ---------------------------------------------------------------- persistence + secret hygiene

test('counters, lastPick and throttles persist to the state file and survive a fresh module instance', async () => {
  await credentials._reset({ file: true });
  await credentials.acquire('main', 'p1'); await credentials.acquire('main', 'p2'); await credentials.acquire('fallback', 'p3');
  await credentials.recordThrottle('fallback', 'slow down ' + process.env.DROVER_TEST_FALLBACK);
  await credentials._reset();   // drops memory, flushes writes, keeps the file
  const raw = await readFile(credentials.STATE_FILE, 'utf8');
  const disk = JSON.parse(raw);
  assert.equal(disk.uses.main, 2); assert.equal(disk.uses.fallback, 1); assert.equal(disk.lastPick, 'fallback');
  assert.equal(disk.throttles.fallback.length, 1);
  assert.equal(disk.throttles.fallback[0].detail, 'slow down [redacted]', 'a value that sneaks into a detail is redacted');
  noFakes(raw, 'the state file');
  const fresh = await import('../core/credpool.js?instance=fresh');
  const st = await fresh.status();
  assert.equal(st.pool.find((p) => p.id === 'main').uses, 2);
  assert.equal(st.pool.find((p) => p.id === 'fallback').throttles, 1);
  assert.equal(st.lastPick, 'fallback');
  assert.equal(st.pool.find((p) => p.id === 'main').active, 0, 'active handles do not survive a restart');
});

test('status() and the ops expose names and ids only, never a value', async () => {
  await credentials._reset({ file: true });
  const st = await credentials.status();
  noFakes(st, 'status()');
  assert.deepEqual(Object.keys(st).sort(), ['appliesTo', 'defaultMode', 'help', 'lastPick', 'pool', 'recommendation', 'recommendationReason', 'stateFile', 'throttleWindowMs']);
  assert.deepEqual(st.pool[0].env, { FAKE_CHILD_TOKEN: '$DROVER_TEST_MAIN' }, 'env shows the reference');
  assert.deepEqual(st.pool[0].sources, ['DROVER_TEST_MAIN']);
  assert.equal(st.recommendation, 'main'); assert.equal(st.defaultMode, 'auto');
  assert.match(st.help, /never shown here/);
  const picked = await credentials.ops['credentials.pick']({ mode: 'auto', engine: 'claude' });
  assert.deepEqual(Object.keys(picked).sort(), ['id', 'label', 'reason']);
  noFakes(picked, 'credentials.pick');
  assert.equal(await credentials.ops['credentials.pick']({ mode: 'auto', engine: 'codex' }), null);
  const second = await credentials.ops['credentials.pick']({ mode: 'auto', engine: 'claude' });
  assert.equal(second.id, 'fallback', 'an orchestrator picking twice rotates on the tie because the op records lastPick');
  const th = await credentials.ops['credentials.throttle']({ id: 'main', detail: 'x'.repeat(500) });
  assert.equal(th.detail.length, 200); assert.equal(th.id, 'main');
  noFakes(await credentials.ops['credentials.status'](), 'credentials.status');
});

// ---------------------------------------------------------------- launch() integration (fake tmux and claude)

test('throttleDetail recognises 429 results and stderr while busy, ignores prose and ordinary numbers', () => {
  const { throttleDetail } = launchMod;
  assert.equal(throttleDetail({ type: 'result', is_error: true, result: 'API Error: 429 Too Many Requests' }), 'API Error: 429 Too Many Requests');
  assert.equal(throttleDetail({ type: 'result', is_error: true, result: 'ThrottlingException: Rate exceeded' }), 'ThrottlingException: Rate exceeded');
  assert.equal(throttleDetail({ type: 'result', is_error: false, result: '429 lines changed' }), null);
  assert.equal(throttleDetail({ type: 'result', is_error: true, result: 'exit code 1' }), null);
  assert.equal(throttleDetail({ type: 'stderr', text: 'retrying after 429 rate limit' }, { busy: true }), 'retrying after 429 rate limit');
  assert.equal(throttleDetail({ type: 'stderr', text: 'retrying after 429 rate limit' }, { busy: false }), null);
  assert.equal(throttleDetail({ type: 'stderr', text: 'processed 1429 files' }, { busy: true }), null);
  assert.equal(throttleDetail({ type: 'system', subtype: 'api_retry', error: 'rate_limit_error', attempt: 1 }, { busy: true }).includes('rate_limit'), true);
  assert.equal(throttleDetail({ type: 'system', subtype: 'init', session_id: 'x', model: 'rate-limit-tester' }, { busy: true }), null);
  assert.equal(throttleDetail({ type: 'assistant', message: { content: [{ type: 'text', text: 'Rate limits return 429; here is how to handle them.' }] } }), null, 'model prose about rate limits is not a throttle');
  assert.equal(throttleDetail({ type: 'assistant', message: { content: [{ type: 'text', text: 'API Error: 429 {"message":"Too many requests"}' }] } }).startsWith('API Error: 429'), true);
  assert.equal(throttleDetail(null), null);
});

test('tmux launch: the value travels only in the spawned argv; result and event carry the id', async () => {
  await credentials._reset({ file: true });
  windows.length = 0;
  const r = await launchMod.launch({ engine: 'claude', mode: 'tmux', cwd: dir, prompt: 'hi', name: 'demo' }, { actor: 't' });
  assert.equal(r.ok, true); assert.equal(r.credential, 'main'); assert.match(r.credentialReason, /^auto:/);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].argv[0], 'claude', 'no env prefix in the argv (tmux -e carries the env)');
  assert.equal(windows[0].env.FAKE_CHILD_TOKEN, process.env.DROVER_TEST_MAIN, 'the child gets the resolved value through env');
  assert.equal(windows[0].env.CLAUDE_CODE_RETRY_WATCHDOG, '1', 'a Drover-launched claude runs in persistent retry mode');
  assert.deepEqual(r.argv, ['claude', '--dangerously-skip-permissions', '--name=demo', '--', 'hi']);
  noFakes(r, 'launch result');
  const { raw, ev } = await lastEvent();
  assert.equal(ev.type, 'launch'); assert.equal(ev.credential, 'main'); assert.deepEqual(ev.argv, r.argv); assert.equal(ev.id, r.event);
  noFakes(raw, 'launch event');
  const st = await credentials.status();
  assert.equal(st.pool.find((p) => p.id === 'main').active, 1, 'a tmux launch counts as active (6 h ttl)');
  assert.equal(st.pool.find((p) => p.id === 'main').uses, 1);
});

test('credential none and non-claude engines launch without pool env and record credential null', async () => {
  await credentials._reset({ file: true });
  windows.length = 0;
  const r = await launchMod.launch({ engine: 'claude', mode: 'tmux', cwd: dir, credential: 'none', name: 'plain' }, { actor: 't' });
  assert.equal(r.credential, null); assert.match(r.credentialReason, /inherits the daemon environment/);
  assert.ok(!(windows[0].env ?? {}).FAKE_CHILD_TOKEN);
  assert.equal((await lastEvent()).ev.credential, null);
  const c = await launchMod.launch({ engine: 'codex', mode: 'tmux', cwd: dir, name: 'cx' }, { actor: 't' });
  assert.equal(c.credential, null); assert.match(c.credentialReason, /apply to claude, not codex/);
  assert.ok(!(windows[1].env ?? {}).FAKE_CHILD_TOKEN);
  await assert.rejects(launchMod.launch({ engine: 'claude', mode: 'tmux', cwd: dir, credential: 'gov' }, { actor: 't' }), /DROVER_TEST_GOV not set/);
  const explicit = await launchMod.launch({ engine: 'claude', mode: 'tmux', cwd: dir, credential: 'fallback' }, { actor: 't' });
  assert.equal(explicit.credential, 'fallback'); assert.match(explicit.credentialReason, /^explicit: fallback/);
  assert.equal(windows.at(-1).env.FAKE_CHILD_TOKEN, process.env.DROVER_TEST_FALLBACK);
  assert.equal((await credentials.status()).pool.find((p) => p.id === 'main').active, 0);
});

test('headless launch: env goes to HeadlessClaude, the entry holds the id, exit releases', async () => {
  await credentials._reset({ file: true });
  FakeHeadless.instances.length = 0;
  const r = await launchMod.launch({ engine: 'claude', mode: 'headless', cwd: dir, prompt: 'go' }, { actor: 't' });
  assert.equal(r.credential, 'main');
  const inst = FakeHeadless.instances.at(-1);
  assert.deepEqual(inst.opts.env, { CLAUDE_CODE_RETRY_WATCHDOG: '1', PATH: process.env.PATH, FAKE_CHILD_TOKEN: process.env.DROVER_TEST_MAIN });
  assert.deepEqual(inst.sent, ['go']);
  const got = launchMod.headlessGet(r.headlessId);
  assert.equal(got.credential, 'main'); assert.equal(got.failovers, 0); assert.equal(got.status, 'busy');
  noFakes(got, 'headlessGet'); noFakes(launchMod.headlessList(), 'headlessList'); noFakes(r, 'launch result');
  const { raw, ev } = await lastEvent();
  assert.equal(ev.credential, 'main'); assert.deepEqual(ev.result, { headlessId: r.headlessId, sessionId: r.sessionId });
  noFakes(raw, 'launch event');
  assert.equal((await credentials.status()).pool[0].active, 1);
  inst.opts.onExit(0, null);
  assert.equal(launchMod.headlessGet(r.headlessId).status, 'exited');
  assert.equal((await credentials.status()).pool[0].active, 0, 'released on exit');
});

test('headless failover: a 429 result records the throttle, resumes the session under the other credential, capped at 3', async () => {
  await credentials._reset({ file: true });
  FakeHeadless.instances.length = 0;
  const r = await launchMod.launch({ engine: 'claude', mode: 'headless', cwd: dir, prompt: 'work' }, { actor: 't' });
  const first = FakeHeadless.instances.at(-1);
  assert.equal(r.credential, 'main');
  first.emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'starting' }] } });
  first.emit({ type: 'result', is_error: true, result: 'API Error: 429 Too Many Requests' });
  await waitFor(() => launchMod.headlessGet(r.headlessId).failovers === 1);
  const second = FakeHeadless.instances.at(-1);
  assert.notEqual(second, first);
  assert.equal(first.stopped, true);
  assert.equal(second.opts.resume, r.sessionId, 'the same session id is resumed');
  assert.deepEqual(second.opts.env, { CLAUDE_CODE_RETRY_WATCHDOG: '1', PATH: process.env.PATH, FAKE_CHILD_TOKEN: process.env.DROVER_TEST_FALLBACK });
  assert.equal(second.opts.profile.id, 'claude-skip');
  assert.match(second.sent[0], /resumed under a different credential/);
  const got = launchMod.headlessGet(r.headlessId);
  assert.equal(got.credential, 'fallback'); assert.equal(got.status, 'busy'); assert.equal(got.sessionId, r.sessionId);
  const note = got.events.find((e) => e.type === 'failover');
  assert.equal(note.from, 'main'); assert.equal(note.to, 'fallback'); assert.equal(note.detail, 'API Error: 429 Too Many Requests');
  noFakes(got, 'headlessGet after failover');
  let st = await credentials.status();
  assert.equal(st.pool.find((p) => p.id === 'main').throttles, 1);
  assert.equal(st.pool.find((p) => p.id === 'main').active, 0);
  assert.equal(st.pool.find((p) => p.id === 'fallback').active, 1);

  // Two more failovers bounce back and forth (the only other entry is throttled, but it is the only other one).
  second.emit({ type: 'result', is_error: true, result: 'API Error: 429' });
  await waitFor(() => launchMod.headlessGet(r.headlessId).failovers === 2);
  assert.equal(launchMod.headlessGet(r.headlessId).credential, 'main');
  FakeHeadless.instances.at(-1).emit({ type: 'stderr', text: 'ThrottlingException' });
  await waitFor(() => launchMod.headlessGet(r.headlessId).failovers === 3);
  assert.equal(launchMod.headlessGet(r.headlessId).credential, 'fallback');
  // The fourth throttle is recorded but no longer fails over.
  const fourth = FakeHeadless.instances.at(-1);
  const count = FakeHeadless.instances.length;
  fourth.emit({ type: 'result', is_error: true, result: 'API Error: 429 again' });
  await waitFor(() => launchMod.headlessGet(r.headlessId).events.some((e) => e.type === 'failover' && e.to === null));
  const capped = launchMod.headlessGet(r.headlessId).events.findLast((e) => e.type === 'failover');
  assert.equal(capped.to, null); assert.match(capped.reason, /cap of 3 failovers/);
  assert.equal(FakeHeadless.instances.length, count, 'no new child after the cap');
  assert.equal(fourth.stopped, false);
  assert.equal(launchMod.headlessGet(r.headlessId).failovers, 3);
  st = await credentials.status();
  assert.equal(st.pool.find((p) => p.id === 'fallback').throttles, 2);
  assert.equal(st.pool.find((p) => p.id === 'main').throttles, 2);
  noFakes(st, 'status after failovers');
  // Stop releases the current credential.
  launchMod.headlessStop(r.headlessId);
  assert.equal((await credentials.status()).pool.find((p) => p.id === 'fallback').active, 0);
});

test('headless failover is skipped, with a note, when no other credential is available', async () => {
  await credentials._reset({ file: true });
  FakeHeadless.instances.length = 0;
  for (const hnd of ['1', '2', '3']) await credentials.acquire('fallback', hnd);   // fallback saturated: main is the only pick
  const r = await launchMod.launch({ engine: 'claude', mode: 'headless', cwd: dir, prompt: 'work' }, { actor: 't' });
  assert.equal(r.credential, 'main');
  const inst = FakeHeadless.instances.at(-1);
  inst.emit({ type: 'result', is_error: true, result: 'API Error: 429' });
  await waitFor(() => launchMod.headlessGet(r.headlessId).events.some((e) => e.type === 'failover'));
  const note = launchMod.headlessGet(r.headlessId).events.find((e) => e.type === 'failover');
  assert.equal(note.to, null); assert.match(note.reason, /maxConcurrent/);
  assert.equal(inst.stopped, false);
  assert.equal(launchMod.headlessGet(r.headlessId).credential, 'main');
  assert.equal((await credentials.status()).pool.find((p) => p.id === 'main').throttles, 1, 'the throttle is still recorded');
  launchMod.headlessStop(r.headlessId);
});

// ---------------------------------------------------------------- routes

const ROUTED = {
  ...PROFILES,
  claude: {
    models: PROFILES.claude.models,
    profiles: [
      ...PROFILES.claude.profiles,
      { id: 'claude-gov', label: 'gov endpoint', argv: [], env: {}, route: 'gov' },
      { id: 'claude-com', label: 'commercial endpoint', argv: [], env: {}, route: 'commercial' },
      { id: 'claude-sub', label: 'subscription login', argv: [], env: {}, route: 'subscription' },
    ],
  },
  credentials: {
    pool: [
      { id: 'main', label: 'Main', env: { FAKE_CHILD_TOKEN: '$DROVER_TEST_MAIN' }, weight: 2, maxConcurrent: 3, route: 'gov' },
      { id: 'gov2', label: 'Second gov', env: { FAKE_CHILD_TOKEN: '$DROVER_TEST_GOV' }, weight: 1, maxConcurrent: 3, route: 'gov' },
      { id: 'fallback', label: 'Fallback', env: { FAKE_CHILD_TOKEN: '$DROVER_TEST_FALLBACK' }, weight: 1, maxConcurrent: 3, route: 'commercial' },
    ],
    default: 'auto',
    appliesTo: ['claude'],
  },
};
const FAKE_GOV = 'x-fake-gov-value-000003';
FAKES.push(FAKE_GOV);

/** Run fn against a profiles.json, then put the shared one back. */
async function withProfiles(profiles, fn) {
  await writeFile(process.env.DROVER_PROFILES, JSON.stringify(profiles));
  try { await fn(); } finally {
    await writeFile(process.env.DROVER_PROFILES, JSON.stringify(PROFILES));
    delete process.env.DROVER_TEST_GOV;
  }
}

test('routes: a routed launch only gets entries on its route, for auto, an explicit id and status', () => withProfiles(ROUTED, async () => {
  await credentials._reset({ file: true });
  for (let i = 0; i < 6; i++) {
    const p = await credentials.pick('auto', { engine: 'claude', route: 'gov' });
    assert.equal(p.id, 'main', 'gov2 is unavailable and fallback is on another route');
    assert.match(p.reason, /^auto on route gov:/);
    await credentials.acquire(p.id, `g${i}`).catch(() => {});
    credentials.release(p.id, `g${i}`);
  }
  assert.equal((await credentials.pick('auto', { engine: 'claude', route: 'commercial' })).id, 'fallback');
  await assert.rejects(credentials.pick('fallback', { engine: 'claude', route: 'gov' }), /credential fallback is for route commercial.*route gov \(main, gov2\)/);
  assert.equal((await credentials.pick('fallback', { engine: 'claude', route: 'commercial' })).id, 'fallback', 'an explicit id on the right route is honoured');
  assert.equal(await credentials.pick('auto', { engine: 'claude', route: 'subscription' }), null, 'a route no entry serves gets no pool credential');
  assert.match((await credentials.recommend('auto', { engine: 'claude', route: 'subscription' })).reason, /no credential in the pool is for route subscription \(pool routes: gov, commercial\)/);
  const st = await credentials.status();
  assert.deepEqual(st.pool.map((p) => [p.id, p.route]), [['main', 'gov'], ['gov2', 'gov'], ['fallback', 'commercial']]);
  assert.equal(st.recommendationByRoute.gov.id, 'main');
  assert.equal(st.recommendationByRoute.commercial.id, 'fallback');
  assert.deepEqual(st.profileRoutes, { 'claude-skip': null, 'claude-gov': 'gov', 'claude-com': 'commercial', 'claude-sub': 'subscription' });
  noFakes(st, 'status with routes');
  assert.deepEqual(await credentials.ops['credentials.pick']({ profile: 'claude-gov' }).then((r) => r.id), 'main');
  assert.deepEqual(await credentials.ops['credentials.pick']({ route: 'commercial' }).then((r) => r.id), 'fallback');
}));

test('routes: an unrouted entry serves every route and an unrouted launch takes any entry', () => withProfiles({
  ...ROUTED,
  credentials: { ...ROUTED.credentials, pool: [ROUTED.credentials.pool[2], { id: 'shared', label: 'Shared', env: { FAKE_CHILD_TOKEN: '$DROVER_TEST_MAIN' }, weight: 1, maxConcurrent: 3 }] },
}, async () => {
  await credentials._reset({ file: true });
  assert.equal((await credentials.pick('auto', { engine: 'claude', route: 'gov' })).id, 'shared');
  assert.equal((await credentials.pick('shared', { engine: 'claude', route: 'gov' })).id, 'shared');
  const ids = new Set();
  for (let i = 0; i < 4; i++) ids.add((await credentials.pick('auto', { engine: 'claude', record: true })).id);
  assert.deepEqual([...ids].sort(), ['fallback', 'shared'], 'no route: both entries take turns, as before routes existed');
}));

test('routes: a malformed route is rejected', () => withProfiles({
  ...ROUTED,
  credentials: { ...ROUTED.credentials, pool: [{ ...ROUTED.credentials.pool[0], route: 'gov cloud' }] },
}, async () => {
  await assert.rejects(credentials.loadPool(), /route must be made of letters/);
  assert.throws(() => credentials.profileRoute({ id: 'p', route: 'a;b' }), /route must be made of letters/);
  assert.equal(credentials.profileRoute({ id: 'p' }), null);
  // A route read from the daemon environment, for a profile whose endpoint differs by host.
  delete process.env.DROVER_TEST_ROUTE;
  assert.equal(credentials.profileRoute({ id: 'p', route: '$DROVER_TEST_ROUTE' }), null, 'unset with no default: unrouted');
  assert.equal(credentials.profileRoute({ id: 'p', route: '${DROVER_TEST_ROUTE:-commercial}' }), 'commercial');
  process.env.DROVER_TEST_ROUTE = 'gov';
  try {
    assert.equal(credentials.profileRoute({ id: 'p', route: '$DROVER_TEST_ROUTE' }), 'gov');
    assert.equal(credentials.profileRoute({ id: 'p', route: '${DROVER_TEST_ROUTE:-commercial}' }), 'gov');
    process.env.DROVER_TEST_ROUTE = 'not ok';
    assert.throws(() => credentials.profileRoute({ id: 'p', route: '$DROVER_TEST_ROUTE' }), /route must be made of letters/);
  } finally { delete process.env.DROVER_TEST_ROUTE; }
  assert.throws(() => credentials.profileRoute({ id: 'p', route: '$(id)' }), /must be a route, \$NAME/);
  assert.throws(() => credentials.profileRoute({ id: 'p', route: '${X:-a b}' }), /must be a route, \$NAME/);
}));

test('routes: a profile whose route comes from the daemon environment follows it per host', () => withProfiles({
  ...ROUTED,
  claude: { ...ROUTED.claude, profiles: [...ROUTED.claude.profiles, { id: 'claude-host', label: 'host default', argv: [], env: {}, route: '${DROVER_TEST_ROUTE:-commercial}' }] },
}, async () => {
  await credentials._reset({ file: true });
  windows.length = 0;
  delete process.env.DROVER_TEST_ROUTE;
  assert.equal((await launchMod.launch({ engine: 'claude', mode: 'tmux', cwd: dir, profile: 'claude-host', name: 'h1' }, { actor: 't' })).credential, 'fallback', 'the default route');
  process.env.DROVER_TEST_ROUTE = 'gov';
  try {
    assert.equal((await launchMod.launch({ engine: 'claude', mode: 'tmux', cwd: dir, profile: 'claude-host', name: 'h2' }, { actor: 't' })).credential, 'main', 'the host\'s own route');
  } finally { delete process.env.DROVER_TEST_ROUTE; }
}));

test('routes: launch follows the profile route; a mismatched explicit id starts nothing', () => withProfiles(ROUTED, async () => {
  await credentials._reset({ file: true });
  windows.length = 0;
  const gov = await launchMod.launch({ engine: 'claude', mode: 'tmux', cwd: dir, profile: 'claude-gov', name: 'gov' }, { actor: 't' });
  assert.equal(gov.credential, 'main'); assert.match(gov.credentialReason, /^auto on route gov:/);
  assert.equal(windows.at(-1).env.FAKE_CHILD_TOKEN, process.env.DROVER_TEST_MAIN);
  const com = await launchMod.launch({ engine: 'claude', mode: 'tmux', cwd: dir, profile: 'claude-com', name: 'com' }, { actor: 't' });
  assert.equal(com.credential, 'fallback');
  assert.equal(windows.at(-1).env.FAKE_CHILD_TOKEN, process.env.DROVER_TEST_FALLBACK);
  const sub = await launchMod.launch({ engine: 'claude', mode: 'tmux', cwd: dir, profile: 'claude-sub', name: 'sub' }, { actor: 't' });
  assert.equal(sub.credential, null); assert.match(sub.credentialReason, /no credential in the pool is for route subscription/);
  assert.ok(!windows.at(-1).env.FAKE_CHILD_TOKEN, 'a subscription launch gets no pool token');
  const before = windows.length;
  await assert.rejects(launchMod.launch({ engine: 'claude', mode: 'tmux', cwd: dir, profile: 'claude-gov', credential: 'fallback' }, { actor: 't' }), /credential fallback is for route commercial/);
  assert.equal(windows.length, before, 'nothing was started');
  noFakes([gov, com, sub], 'routed launch results');
}));

test('routes: headless failover stays on the session\'s route', () => withProfiles(ROUTED, async () => {
  await credentials._reset({ file: true });
  FakeHeadless.instances.length = 0;
  process.env.DROVER_TEST_GOV = FAKE_GOV;
  const r = await launchMod.launch({ engine: 'claude', mode: 'headless', cwd: dir, profile: 'claude-gov', prompt: 'work' }, { actor: 't' });
  assert.equal(r.credential, 'main');
  FakeHeadless.instances.at(-1).emit({ type: 'result', is_error: true, result: 'API Error: 429' });
  await waitFor(() => launchMod.headlessGet(r.headlessId).failovers === 1);
  assert.equal(launchMod.headlessGet(r.headlessId).credential, 'gov2', 'the other gov entry, never the commercial one');
  assert.equal(FakeHeadless.instances.at(-1).opts.env.FAKE_CHILD_TOKEN, FAKE_GOV);
  noFakes(launchMod.headlessGet(r.headlessId), 'headlessGet after a routed failover');
  launchMod.headlessStop(r.headlessId);

  // With the second gov entry gone, a throttle has nowhere to go on this route: no failover to commercial.
  delete process.env.DROVER_TEST_GOV;
  await credentials._reset({ file: true });
  const s = await launchMod.launch({ engine: 'claude', mode: 'headless', cwd: dir, profile: 'claude-gov', prompt: 'work' }, { actor: 't' });
  const inst = FakeHeadless.instances.at(-1);
  inst.emit({ type: 'result', is_error: true, result: 'API Error: 429' });
  await waitFor(() => launchMod.headlessGet(s.headlessId).events.some((e) => e.type === 'failover'));
  const note = launchMod.headlessGet(s.headlessId).events.find((e) => e.type === 'failover');
  assert.equal(note.to, null); assert.match(note.reason, /no other credential available/);
  assert.equal(inst.stopped, false);
  assert.equal(launchMod.headlessGet(s.headlessId).credential, 'main');
  launchMod.headlessStop(s.headlessId);
}));
