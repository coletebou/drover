// Per-launch reasoning effort (core/effort.js): the levels each engine takes, the argv each engine gets
// (Claude --effort, Codex -c model_reasoning_effort) in tmux, headless and resume, composition with a
// profile and a model, that an omitted effort leaves every launch exactly as it was, that an invalid one
// starts, picks and records nothing, the version probe in front of remote launches and in drover_launch, and
// hostile values (shell syntax, a trailing ";" that tmux itself would act on) through a real, private tmux
// server. Profiles, state, events, dotfiles and cache point at scratch files through env; the "secrets" are
// fake values under test-only names; no tmux server, agent or credential of the user is touched.
// Run: node --test test/launch-effort.test.js
import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm, symlink } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(tmpdir(), 'droverfx-'));
process.env.DROVER_PROFILES = path.join(dir, 'profiles.json');
process.env.DROVER_STATE = path.join(dir, 'state');
process.env.DROVER_DOTFILES = path.join(dir, 'dotfiles');
process.env.DROVER_EVENTS = path.join(dir, 'dotfiles', 'claude', 'drover-events.jsonl');
process.env.DROVER_CACHE = path.join(dir, 'cache');
process.env.DROVER_HOST = 'testbox';
process.env.DROVER_TEST_MAIN = 'x-fake-main-value-000001';
process.env.DROVER_TEST_FALLBACK = 'x-fake-fallback-value-000002';
await mkdir(path.join(dir, 'dotfiles', 'claude'), { recursive: true });
await writeFile(path.join(dir, 'dotfiles', 'claude', 'fleet-hosts.txt'), 'effort-old\neffort-stale\neffort-new\neffort-plain\n');

// This file's own profiles (the shapes web/profiles.json uses), so the expected argv below does not move when that file does.
const PROFILES = {
  claude: {
    models: [{ id: 'opus', label: 'Opus' }],
    profiles: [
      { id: 'claude-skip', label: 'skip permissions', argv: ['--dangerously-skip-permissions'], env: {}, default: true },
      { id: 'claude-plan', label: 'plan', argv: ['--dangerously-skip-permissions', '--permission-mode', 'plan'], env: {} },
      { id: 'claude-safe', label: 'safe', argv: [], env: {} },
    ],
  },
  codex: {
    models: [],
    profiles: [
      { id: 'codex-work', label: 'work', argv: ['-p', 'work'], env: {}, default: true },
      { id: 'codex-fast', label: 'fast', argv: ['-p', 'fast'], env: {} },
      { id: 'codex-default', label: 'default', argv: [], env: {} },
    ],
  },
  credentials: {
    pool: [
      { id: 'main', label: 'Main', env: { FAKE_CHILD_TOKEN: '$DROVER_TEST_MAIN' }, weight: 2, maxConcurrent: 50 },
      { id: 'fallback', label: 'Fallback', env: { FAKE_CHILD_TOKEN: '$DROVER_TEST_FALLBACK' }, weight: 1, maxConcurrent: 50 },
    ],
    default: 'auto',
    appliesTo: ['claude'],
  },
};
await writeFile(process.env.DROVER_PROFILES, JSON.stringify(PROFILES));

const effortMod = await import('../core/effort.js');
const { EFFORT_LEVELS, ALL_EFFORTS, checkEffort, effortLevels } = effortMod;
const claude = await import('../core/claude.js');
const codex = await import('../core/codex.js');
const tmux = await import('../core/tmux.js');
const credentials = await import('../core/credpool.js');
const launchMod = await import('../core/launch.js');
const remote = await import('../core/remote.js');
const api = await import('../core/api.js');
const { META } = await import('../core/ops-meta.js');
const { createServer, ALL_TOOLS, TOOLS } = await import('../mcp/server.js');
const { UPDATE_HINT } = await import('../core/util.js');

// ---------------------------------------------------------------- fakes for launch()
const windows = [];
const fakeNewWindow = async (opts) => { windows.push(opts); return { target: `agents:${windows.length}` }; };
launchMod._deps.newWindow = fakeNewWindow;
let seq = 0;
class FakeHeadless {
  constructor(opts) {
    this.opts = opts; this.sessionId = opts.resume ?? `sess-${++seq}`;
    this.argv = claude.headlessArgv(opts.profile, { model: opts.model, effort: opts.effort, resume: opts.resume, sessionId: this.sessionId });
    this.sent = []; this.stopped = false;
    FakeHeadless.instances.push(this);
  }
  send(text) { this.sent.push(text); }
  stop() { this.stopped = true; setTimeout(() => this.opts.onExit(0, null), 5); }
  emit(d) { this.opts.onEvent(d); }
}
FakeHeadless.instances = [];
launchMod._deps.HeadlessClaude = FakeHeadless;
const codexStarts = [];
launchMod._deps.startCodexThread = async (opts) => { codexStarts.push(opts); return { threadId: `thread-${codexStarts.length}`, turnId: null }; };
// The model catalog never comes from a real `codex debug models` here. By default it is unreadable, which
// means the engine-level list applies; the per-model tests install CATALOG.
const catalogCalls = [];
launchMod._deps.codexModelEfforts = async () => { catalogCalls.push(1); return null; };
// The agent PATH is this process's PATH plus a marker dir, read at launch time (the real-tmux block prepends its
// fake claude/codex dir): no login shell of the user runs here, and a test can tell it from the daemon's PATH.
const AGENT_ONLY = '/drover-test/agent-only/bin';
const agentPath = async () => `${process.env.PATH}:${AGENT_ONLY}`;
let agentPathCalls = 0;
launchMod._deps.agentPath = () => { agentPathCalls++; return agentPath(); };
// A tmux launch first trusts its folder in the user's ~/.claude.json or ~/.codex/config.toml: never from here (test/trust.test.js covers that step).
launchMod._deps.trustFolder = async () => null;
// The shape `codex debug models` prints (0.162.1), cut to the parts read: a few models of one catalog.
const CATALOG_JSON = { models: [
  { slug: 'openai.gpt-6.1-sol', default_reasoning_level: 'low', supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((effort) => ({ effort, description: 'x' })) },
  { slug: 'openai.gpt-6-luna', default_reasoning_level: 'medium', supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max'].map((effort) => ({ effort, description: 'x' })) },
  { slug: 'openai.gpt-5.5', default_reasoning_level: 'medium', supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh'].map((effort) => ({ effort, description: 'x' })) },
  { slug: 'openai.no-levels', supported_reasoning_levels: [] },
] };

// headlessStop() on a Codex entry interrupts its turn through the real shared app-server, which would start a
// `codex app-server` child; these entries are fakes, so they are only unhooked and dropped.
const dropCodexHeadless = (id) => { const e = launchMod.headless.get(id); e?.unsub?.(); launchMod.headless.delete(id); };
after(async () => { codex.sharedClient().stop(); remote.stopAll(); await rm(dir, { recursive: true, force: true }); });   // nothing may keep this process alive

const waitFor = async (fn, ms = 5000) => { const t0 = Date.now(); while (!(await fn())) { if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 20)); } };
const eventLines = async () => (existsSync(process.env.DROVER_EVENTS) ? (await readFile(process.env.DROVER_EVENTS, 'utf8')).trim().split('\n').filter(Boolean) : []);
const lastEvent = async () => JSON.parse((await eventLines()).at(-1));
const profile = (engine, id) => PROFILES[engine].profiles.find((p) => p.id === id);

// ---------------------------------------------------------------- the allowlist

describe('checkEffort', () => {
  test('each engine takes its own levels: claude low..max, codex low..ultra, hermes none..ultra', () => {
    assert.deepEqual([...EFFORT_LEVELS.claude], ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.deepEqual([...EFFORT_LEVELS.codex], ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    assert.deepEqual([...EFFORT_LEVELS.hermes], ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    for (const lv of EFFORT_LEVELS.claude) assert.equal(checkEffort('claude', lv), lv);
    for (const lv of EFFORT_LEVELS.codex) assert.equal(checkEffort('codex', lv), lv);
    for (const lv of EFFORT_LEVELS.hermes) assert.equal(checkEffort('hermes', lv), lv);
    assert.throws(() => checkEffort('claude', 'ultra'), /effort "ultra" is not valid for claude: use one of low, medium, high, xhigh, max, or omit it/);
    assert.throws(() => checkEffort('codex', 'minimal'), /effort "minimal" is not valid for codex/);
    assert.deepEqual([...ALL_EFFORTS], ['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'none', 'minimal']);
    assert.deepEqual(effortLevels(), { claude: ['low', 'medium', 'high', 'xhigh', 'max'], codex: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], hermes: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] });
  });

  test('omitted (undefined, null, empty string) is null, for both engines', () => {
    for (const engine of ['claude', 'codex']) for (const v of [undefined, null, '']) assert.equal(checkEffort(engine, v), null);
  });

  test('near misses and hostile values are refused with the valid levels named; nothing is trimmed or aliased', () => {
    const bad = ['MAX', 'Max', ' max', 'max ', 'max\n', 'med', 'ultracode', 'minimal', 'none', 'bogus', 'max; touch /tmp/drover-pwned', '$(id)', '`id`', '--effort=max', 'max" -c "x', 5, true, {}, ['max']];
    for (const v of bad) {
      assert.throws(() => checkEffort('claude', v), /is not valid for claude: use one of low, medium, high, xhigh, max/, `claude ${JSON.stringify(v)}`);
      assert.throws(() => checkEffort('codex', v), /is not valid for codex: use one of low, medium, high, xhigh, max, ultra/, `codex ${JSON.stringify(v)}`);
      // Hermes takes none and minimal; every other near miss is refused there too.
      if (v !== 'none' && v !== 'minimal') assert.throws(() => checkEffort('hermes', v), /is not valid for hermes: use one of none, minimal, low, medium, high, xhigh, max, ultra/, `hermes ${JSON.stringify(v)}`);
    }
    assert.throws(() => checkEffort('gemini', 'max'), /unknown engine "gemini" for effort; known: claude, codex, hermes/);
  });
});

// ---------------------------------------------------------------- argv builders

describe('argv builders', () => {
  test('claude interactive: an omitted effort gives exactly the argv from before efforts', () => {
    const skip = profile('claude', 'claude-skip');
    assert.deepEqual(claude.interactiveArgv(skip, {}), ['claude', '--dangerously-skip-permissions']);
    assert.deepEqual(claude.interactiveArgv(skip, { model: 'opus', prompt: 'hi' }), ['claude', '--dangerously-skip-permissions', '--model', 'opus', '--', 'hi']);
    assert.deepEqual(claude.interactiveArgv(skip, { model: 'opus', resume: 'S1', prompt: 'hi', effort: '' }), ['claude', '--dangerously-skip-permissions', '--model', 'opus', '--resume=S1', '--', 'hi']);
    assert.deepEqual(claude.interactiveArgv(profile('claude', 'claude-safe'), { effort: null }), ['claude']);
  });

  test('claude interactive: --effort comes after the model and before resume and the prompt; composes with a profile and a model', () => {
    const plan = profile('claude', 'claude-plan');
    assert.deepEqual(claude.interactiveArgv(plan, { model: 'sonnet', effort: 'max', resume: 'S1', prompt: 'go' }),
      ['claude', '--dangerously-skip-permissions', '--permission-mode', 'plan', '--model', 'sonnet', '--effort', 'max', '--resume=S1', '--', 'go']);
    assert.deepEqual(claude.interactiveArgv(profile('claude', 'claude-safe'), { effort: 'low' }), ['claude', '--effort', 'low']);
    assert.deepEqual(claude.effortArgv('xhigh'), ['--effort', 'xhigh']);
    assert.deepEqual(claude.effortArgv(undefined), []);
  });

  test('claude headless: omitted unchanged; the effort goes last, with --session-id or --resume', () => {
    const skip = profile('claude', 'claude-skip');
    const head = ['--dangerously-skip-permissions', '-p', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages'];
    assert.deepEqual(claude.headlessArgv(skip, { model: 'opus', sessionId: 'U1' }), [...head, '--session-id', 'U1', '--model', 'opus']);
    assert.deepEqual(claude.headlessArgv(skip, { model: 'opus', sessionId: 'U1', effort: 'high' }), [...head, '--session-id', 'U1', '--model', 'opus', '--effort', 'high']);
    assert.deepEqual(claude.headlessArgv(skip, { resume: 'S1', effort: 'low' }), [...head, '--resume=S1', '--effort', 'low']);
  });

  test('codex interactive: omitted unchanged; -c model_reasoning_effort="<level>" after -m and before resume; composes with -p ultra', () => {
    const fast = profile('codex', 'codex-fast');
    assert.deepEqual(codex.interactiveArgv(fast, { model: 'openai.gpt-6-astra', prompt: 'go' }), ['codex', '-p', 'fast', '-m', 'openai.gpt-6-astra', '--', 'go']);
    assert.deepEqual(codex.interactiveArgv(fast, { model: 'openai.gpt-6-astra', effort: 'medium', prompt: 'go' }), ['codex', '-p', 'fast', '-m', 'openai.gpt-6-astra', '-c', 'model_reasoning_effort="medium"', '--', 'go']);
    assert.deepEqual(codex.interactiveArgv(fast, { effort: 'low', resume: 'T1', prompt: 'ignored on resume' }), ['codex', '-p', 'fast', '-c', 'model_reasoning_effort="low"', 'resume', '--', 'T1']);
    assert.deepEqual(codex.interactiveArgv(profile('codex', 'codex-default'), { effort: 'ultra' }), ['codex', '-c', 'model_reasoning_effort="ultra"']);
    assert.deepEqual(codex.interactiveArgv(profile('codex', 'codex-default'), {}), ['codex']);
  });

  test('codex headless thread/start: no config key without an effort; the effort is config.model_reasoning_effort', () => {
    assert.deepEqual(codex.threadStartParams({ cwd: '/w' }), { cwd: '/w', approvalPolicy: 'never', sandbox: 'danger-full-access' });
    assert.deepEqual(codex.threadStartParams({ cwd: '/w', model: 'm', effort: 'max' }), { cwd: '/w', model: 'm', approvalPolicy: 'never', sandbox: 'danger-full-access', config: { model_reasoning_effort: 'max' } });
    assert.deepEqual(codex.threadStartParams({ cwd: '/w', effort: 'low', profileConfig: { model_reasoning_effort: 'high', service_tier: 'x' } }).config, { model_reasoning_effort: 'low', service_tier: 'x' }, 'the launch effort wins over a profile config value');
  });

  test('a prompt or resume id that looks like an option stays text: -- ends the options, the resume id is bound', () => {
    const safe = profile('claude', 'claude-safe');
    const plain = profile('codex', 'codex-default');
    for (const p of ['--version', '--dangerously-skip-permissions', '-p', '--']) {
      assert.deepEqual(claude.interactiveArgv(safe, { prompt: p }), ['claude', '--', p], `claude prompt ${p}`);
      assert.deepEqual(codex.interactiveArgv(plain, { prompt: p }), ['codex', '--', p], `codex prompt ${p}`);
    }
    assert.deepEqual(codex.interactiveArgv(plain, { prompt: 'logout' }), ['codex', '--', 'logout'], 'a Codex subcommand name is a prompt too');
    assert.deepEqual(claude.interactiveArgv(safe, { resume: '--dangerously-skip-permissions' }), ['claude', '--resume=--dangerously-skip-permissions'], 'claude --resume takes an optional value, so it is bound with =');
    assert.deepEqual(claude.headlessArgv(safe, { resume: '--dangerously-skip-permissions' }).at(-1), '--resume=--dangerously-skip-permissions');
    assert.deepEqual(codex.interactiveArgv(profile('codex', 'codex-work'), { resume: '--last' }), ['codex', '-p', 'work', 'resume', '--', '--last']);
    assert.deepEqual(claude.interactiveArgv(safe, { prompt: '' }), ['claude'], 'no prompt, no separator');
    assert.deepEqual(codex.queueArgv('T1', '--version'), ['queue', '--thread=T1', '--message=--version'], 'a message to a Codex thread is bound the same way');
  });

  test('a headless Codex thread starts with params Codex 0.162.1 accepts, and no wider permissions than before', () => {
    // sessionStartSource is an enum (startup | clear): "apx-web", and "drover" after the rename, were refused
    // ("unknown variant"), so every headless Codex launch failed. Omitted, Codex uses its own default.
    for (const req of [{ cwd: '/w' }, { cwd: '/w', model: 'm', effort: 'low' }]) {
      const p = codex.threadStartParams(req);
      assert.ok(!('sessionStartSource' in p), 'no custom session start source');
      assert.equal(p.approvalPolicy, 'never'); assert.equal(p.sandbox, 'danger-full-access');
      assert.deepEqual(Object.keys(p).filter((k) => !['cwd', 'model', 'config'].includes(k)).sort(), ['approvalPolicy', 'sandbox'], 'nothing else is granted or set');
    }
  });

  test('every builder refuses an invalid effort instead of passing it on', () => {
    assert.throws(() => claude.interactiveArgv(profile('claude', 'claude-skip'), { effort: 'ultra' }), /not valid for claude/);
    assert.throws(() => claude.headlessArgv(profile('claude', 'claude-skip'), { effort: 'MAX', sessionId: 'U' }), /not valid for claude/);
    assert.throws(() => codex.interactiveArgv(profile('codex', 'codex-work'), { effort: 'minimal' }), /not valid for codex/);
    assert.throws(() => codex.threadStartParams({ cwd: '/w', effort: 'bogus' }), /not valid for codex/);
  });
});

// ---------------------------------------------------------------- launch()

describe('launch() with fake tmux, headless claude and codex thread start', () => {
  before(async () => { await credentials._reset({ file: true }); });

  test('claude tmux: the effort reaches the spawned argv, the result and the launch event', async () => {
    windows.length = 0;
    const r = await launchMod.launch({ engine: 'claude', mode: 'tmux', profile: 'claude-plan', model: 'sonnet', effort: 'max', cwd: dir, prompt: 'go', name: 'e1' }, { actor: 't' });
    const want = ['claude', '--dangerously-skip-permissions', '--permission-mode', 'plan', '--model', 'sonnet', '--effort', 'max', '--', 'go'];
    assert.deepEqual(windows[0].argv, want);
    assert.deepEqual(r.argv, want);
    assert.equal(r.effort, 'max');
    assert.equal(windows[0].env.CLAUDE_CODE_RETRY_WATCHDOG, '1');
    assert.ok(!Object.keys(windows[0].env).some((k) => /effort/i.test(k)), 'the effort is a flag, never env');
    const ev = await lastEvent();
    assert.equal(ev.type, 'launch'); assert.equal(ev.effort, 'max'); assert.equal(ev.model, 'sonnet'); assert.deepEqual(ev.argv, want); assert.equal(ev.id, r.event);
  });

  test('codex tmux with a profile and a model: -p, -m and -c compose; resume keeps the -c before the subcommand', async () => {
    windows.length = 0;
    const r = await launchMod.launch({ engine: 'codex', mode: 'tmux', profile: 'codex-fast', model: 'openai.gpt-6-astra', effort: 'ultra', cwd: dir, prompt: 'go', name: 'e2' }, { actor: 't' });
    assert.deepEqual(windows[0].argv, ['codex', '-p', 'fast', '-m', 'openai.gpt-6-astra', '-c', 'model_reasoning_effort="ultra"', '--', 'go']);
    assert.equal(r.effort, 'ultra'); assert.equal((await lastEvent()).effort, 'ultra');
    const rs = await launchMod.launch({ engine: 'codex', mode: 'tmux', effort: 'xhigh', resume: 'T-1', cwd: dir, name: 'e3' }, { actor: 't' });
    assert.deepEqual(rs.argv, ['codex', '-p', 'work', '-c', 'model_reasoning_effort="xhigh"', 'resume', '--', 'T-1']);
    const rc = await launchMod.launch({ engine: 'claude', mode: 'tmux', effort: 'low', resume: 'S-1', cwd: dir, name: 'e4' }, { actor: 't' });
    assert.deepEqual(rc.argv, ['claude', '--dangerously-skip-permissions', '--effort', 'low', '--resume=S-1']);
  });

  test('claude headless: HeadlessClaude gets the effort, headless.list shows it, and a failover resume keeps it', async () => {
    await credentials._reset({ file: true });
    FakeHeadless.instances.length = 0;
    const r = await launchMod.launch({ engine: 'claude', mode: 'headless', model: 'opus', effort: 'high', cwd: dir, prompt: 'work' }, { actor: 't' });
    const first = FakeHeadless.instances.at(-1);
    assert.equal(first.opts.effort, 'high');
    assert.deepEqual(first.argv.slice(-4), ['--model', 'opus', '--effort', 'high']);
    assert.equal(r.effort, 'high');
    const listed = launchMod.headlessList().find((x) => x.id === r.headlessId);
    assert.equal(listed.effort, 'high');
    const ev = await lastEvent();
    assert.equal(ev.effort, 'high'); assert.deepEqual(ev.argv, ['claude', ...first.argv]);
    first.emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'starting' }] } });
    first.emit({ type: 'result', is_error: true, result: 'API Error: 429 Too Many Requests' });
    await waitFor(() => launchMod.headlessGet(r.headlessId).failovers === 1);
    const second = FakeHeadless.instances.at(-1);
    assert.notEqual(second, first);
    assert.equal(second.opts.resume, r.sessionId);
    assert.equal(second.opts.effort, 'high', 'the resumed child keeps the launch effort');
    assert.deepEqual(second.argv.slice(-5), [`--resume=${r.sessionId}`, '--model', 'opus', '--effort', 'high']);
    launchMod.headlessStop(r.headlessId);
  });

  test('tmux and headless agents get the login-shell PATH, a failover keeps it, and a profile PATH wins', async () => {
    await credentials._reset({ file: true });
    windows.length = 0; FakeHeadless.instances.length = 0;
    const want = await agentPath();
    await launchMod.launch({ engine: 'claude', mode: 'tmux', cwd: dir, prompt: 'p', name: 'path-c' }, { actor: 't' });
    await launchMod.launch({ engine: 'codex', mode: 'tmux', cwd: dir, prompt: 'p', name: 'path-x' }, { actor: 't' });
    assert.deepEqual(windows.map((w) => w.env.PATH), [want, want], 'claude and codex tmux windows');
    const r = await launchMod.launch({ engine: 'claude', mode: 'headless', cwd: dir, prompt: 'work' }, { actor: 't' });
    const first = FakeHeadless.instances.at(-1);
    assert.equal(first.opts.env.PATH, want, 'headless claude');
    first.emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'starting' }] } });
    first.emit({ type: 'result', is_error: true, result: 'API Error: 429 Too Many Requests' });
    await waitFor(() => launchMod.headlessGet(r.headlessId).failovers === 1);
    assert.equal(FakeHeadless.instances.at(-1).opts.env.PATH, want, 'the resumed child keeps it');
    launchMod.headlessStop(r.headlessId);
    const withPath = structuredClone(PROFILES);
    withPath.claude.profiles.push({ id: 'claude-own-path', label: 'own PATH', argv: [], env: { PATH: '~/own/bin:/usr/bin' } });
    await writeFile(process.env.DROVER_PROFILES, JSON.stringify(withPath));
    try {
      await launchMod.launch({ engine: 'claude', mode: 'tmux', profile: 'claude-own-path', cwd: dir, prompt: 'p', name: 'path-own' }, { actor: 't' });
      assert.equal(windows.at(-1).env.PATH, `${process.env.HOME}/own/bin:/usr/bin`);
    } finally { await writeFile(process.env.DROVER_PROFILES, JSON.stringify(PROFILES)); }
    const calls = agentPathCalls;
    dropCodexHeadless((await launchMod.launch({ engine: 'codex', mode: 'headless', cwd: dir, prompt: 'p' }, { actor: 't' })).headlessId);
    assert.equal(agentPathCalls, calls, 'a headless Codex thread runs in the shared app-server, so no login shell runs');
  });

  test('codex headless: thread/start gets the effort', async () => {
    codexStarts.length = 0;
    const r = await launchMod.launch({ engine: 'codex', mode: 'headless', model: 'openai.gpt-6.1-sol', effort: 'max', cwd: dir, prompt: 'go' }, { actor: 't' });
    assert.deepEqual(codexStarts, [{ cwd: dir, model: 'openai.gpt-6.1-sol', effort: 'max', prompt: 'go' }]);
    assert.equal(r.effort, 'max'); assert.equal(r.threadId, 'thread-1');
    assert.equal(launchMod.headlessList().find((x) => x.id === r.headlessId).effort, 'max');
    assert.equal((await lastEvent()).effort, 'max');
    dropCodexHeadless(r.headlessId);
  });

  test('an omitted effort leaves argv, env, event, result and headless entry exactly as before efforts', async () => {
    await credentials._reset({ file: true });
    windows.length = 0; FakeHeadless.instances.length = 0; codexStarts.length = 0;
    for (const effort of [undefined, null, '']) {
      const req = effort === undefined ? {} : { effort };
      const t = await launchMod.launch({ engine: 'claude', mode: 'tmux', model: 'opus', cwd: dir, prompt: 'hi', name: 'p', ...req }, { actor: 't' });
      assert.deepEqual(t.argv, ['claude', '--dangerously-skip-permissions', '--model', 'opus', '--', 'hi']);
      assert.deepEqual(Object.keys(t), ['ok', 'mode', 'target', 'name', 'argv', 'credential', 'credentialReason', 'event']);
      assert.deepEqual(Object.keys(windows.at(-1).env).sort(), ['CLAUDE_CODE_RETRY_WATCHDOG', 'FAKE_CHILD_TOKEN', 'PATH']);
      const tev = await lastEvent();
      assert.ok(!('effort' in tev), 'no effort key in the launch event');
      assert.deepEqual(Object.keys(tev).filter((k) => !['id', 'ts', 'host', 'actor', 'v'].includes(k)), ['type', 'engine', 'mode', 'profile', 'model', 'cwd', 'prompt', 'credential', 'argv', 'result']);
      const c = await launchMod.launch({ engine: 'codex', mode: 'tmux', profile: 'codex-fast', model: 'openai.gpt-6-astra', cwd: dir, prompt: 'go', name: 'q', ...req }, { actor: 't' });
      assert.deepEqual(c.argv, ['codex', '-p', 'fast', '-m', 'openai.gpt-6-astra', '--', 'go']);
      assert.ok(!('effort' in c));
      const hd = await launchMod.launch({ engine: 'claude', mode: 'headless', cwd: dir, ...req }, { actor: 't' });
      const inst = FakeHeadless.instances.at(-1);
      assert.equal(inst.opts.effort ?? null, null, 'no effort handed to the headless child');
      assert.ok(!inst.argv.includes('--effort'));
      assert.deepEqual(Object.keys(hd), ['ok', 'mode', 'headlessId', 'sessionId', 'credential', 'credentialReason', 'event']);
      assert.ok(!('effort' in launchMod.headlessList().find((x) => x.id === hd.headlessId)));
      launchMod.headlessStop(hd.headlessId);
      const cx = await launchMod.launch({ engine: 'codex', mode: 'headless', cwd: dir, prompt: 'go', ...req }, { actor: 't' });
      assert.deepEqual(codexStarts.at(-1), { cwd: dir, model: undefined, prompt: 'go' }, 'thread/start opts as before: no effort key');
      assert.deepEqual(Object.keys(cx), ['ok', 'mode', 'headlessId', 'threadId', 'credential', 'credentialReason', 'event']);
      dropCodexHeadless(cx.headlessId);
    }
  });

  test('an invalid effort starts, picks and records nothing, in every engine and mode', async () => {
    await credentials._reset({ file: true });
    const snapshot = async () => ({
      windows: windows.length, headless: FakeHeadless.instances.length, codex: codexStarts.length, events: (await eventLines()).length,
      held: launchMod.headlessList().length, pool: (await credentials.status()).pool.map((p) => [p.id, p.active, p.uses]), lastPick: (await credentials.status()).lastPick,
    });
    const before = await snapshot();
    const cases = [
      [{ engine: 'claude', mode: 'tmux', effort: 'ultra' }, /effort "ultra" is not valid for claude: use one of low, medium, high, xhigh, max/],
      [{ engine: 'claude', mode: 'headless', effort: 'MAX' }, /effort "MAX" is not valid for claude/],
      [{ engine: 'codex', mode: 'tmux', effort: 'minimal' }, /effort "minimal" is not valid for codex: use one of low, medium, high, xhigh, max, ultra/],
      [{ engine: 'codex', mode: 'headless', effort: 'max; touch /tmp/drover-pwned' }, /is not valid for codex/],
      [{ engine: 'claude', mode: 'tmux', effort: 7 }, /effort 7 is not valid for claude/],
    ];
    for (const [req, re] of cases) await assert.rejects(launchMod.launch({ cwd: dir, prompt: 'go', ...req }, { actor: 't' }), re);
    assert.deepEqual(await snapshot(), before);
  });
});

// ---------------------------------------------------------------- Codex effort per model

describe('Codex effort per model (the model catalog when the model is known, else the engine list)', () => {
  const useCatalog = (map) => { catalogCalls.length = 0; launchMod._deps.codexModelEfforts = async () => { catalogCalls.push(1); return map; }; };
  after(() => { launchMod._deps.codexModelEfforts = async () => { catalogCalls.push(1); return null; }; });

  test('catalogEfforts reads slug -> levels from `codex debug models` JSON, skipping models with no levels', () => {
    const m = codex.catalogEfforts(CATALOG_JSON);
    assert.deepEqual([...m.keys()], ['openai.gpt-6.1-sol', 'openai.gpt-6-luna', 'openai.gpt-5.5']);
    assert.deepEqual(m.get('openai.gpt-6-luna'), ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.deepEqual(codex.catalogEfforts({ models: [{ slug: 's', supported_reasoning_levels: ['low', { effort: 'high' }, 7, null] }] }).get('s'), ['low', 'high']);
    assert.equal(codex.catalogEfforts(null).size, 0);
    assert.equal(codex.catalogEfforts({ models: 'nope' }).size, 0);
  });

  test('a known model refuses a level it does not list, in tmux and headless, and nothing starts', async () => {
    useCatalog(codex.catalogEfforts(CATALOG_JSON));
    const before = { windows: windows.length, codex: codexStarts.length, events: (await eventLines()).length };
    await assert.rejects(launchMod.launch({ engine: 'codex', mode: 'tmux', model: 'openai.gpt-6-luna', effort: 'ultra', cwd: dir, prompt: 'go' }, { actor: 't' }),
      /effort "ultra" is not supported by openai\.gpt-6-luna: it takes low, medium, high, xhigh, max \(the codex model catalog on this host\)/);
    await assert.rejects(launchMod.launch({ engine: 'codex', mode: 'headless', model: 'openai.gpt-5.5', effort: 'max', cwd: dir, prompt: 'go' }, { actor: 't' }),
      /effort "max" is not supported by openai\.gpt-5\.5: it takes low, medium, high, xhigh/);
    assert.deepEqual({ windows: windows.length, codex: codexStarts.length, events: (await eventLines()).length }, before);
    const ok = await launchMod.launch({ engine: 'codex', mode: 'tmux', model: 'openai.gpt-6-luna', effort: 'max', cwd: dir, prompt: 'go', name: 'luna-max' }, { actor: 't' });
    assert.equal(ok.effort, 'max');
    const sol = await launchMod.launch({ engine: 'codex', mode: 'tmux', model: 'openai.gpt-6.1-sol', effort: 'ultra', cwd: dir, prompt: 'go', name: 'sol-ultra' }, { actor: 't' });
    assert.equal(sol.effort, 'ultra');
  });

  test('an unknown model, no model, or an unreadable catalog falls back to the engine list', async () => {
    useCatalog(codex.catalogEfforts(CATALOG_JSON));
    assert.equal((await launchMod.launch({ engine: 'codex', mode: 'tmux', model: 'openai.gpt-9-not-in-catalog', effort: 'ultra', cwd: dir, prompt: 'go', name: 'unknown' }, { actor: 't' })).effort, 'ultra');
    assert.equal((await launchMod.launch({ engine: 'codex', mode: 'tmux', model: 'openai.no-levels', effort: 'ultra', cwd: dir, prompt: 'go', name: 'nolevels' }, { actor: 't' })).effort, 'ultra');
    const calls = catalogCalls.length;
    assert.equal((await launchMod.launch({ engine: 'codex', mode: 'tmux', effort: 'ultra', cwd: dir, prompt: 'go', name: 'nomodel' }, { actor: 't' })).effort, 'ultra');
    assert.equal(catalogCalls.length, calls, 'no model: the catalog is not even read');
    useCatalog(null);
    assert.equal((await launchMod.launch({ engine: 'codex', mode: 'tmux', model: 'openai.gpt-6-luna', effort: 'ultra', cwd: dir, prompt: 'go', name: 'nocatalog' }, { actor: 't' })).effort, 'ultra');
    assert.equal(catalogCalls.length, 1);
    await assert.rejects(launchMod.launch({ engine: 'codex', mode: 'tmux', model: 'openai.gpt-6-luna', effort: 'minimal', cwd: dir }, { actor: 't' }), /not valid for codex/, 'the engine list still applies');
  });

  test('the catalog is read only for a Codex launch that names both a model and an effort', async () => {
    useCatalog(codex.catalogEfforts(CATALOG_JSON));
    await launchMod.launch({ engine: 'codex', mode: 'tmux', model: 'openai.gpt-6-luna', cwd: dir, prompt: 'go', name: 'noeffort' }, { actor: 't' });
    await launchMod.launch({ engine: 'claude', mode: 'tmux', model: 'opus', effort: 'max', cwd: dir, prompt: 'go', name: 'claude' }, { actor: 't' });
    assert.equal(catalogCalls.length, 0);
  });
});

// ---------------------------------------------------------------- real tmux: argv delivery with no shell

const hasTmux = spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status === 0;
describe('real tmux: a launch reaches the agent as the exact argv, with no shell and no tmux command parsing in between', { skip: hasTmux ? false : 'tmux is not installed here' }, () => {
  const TMUX_SESSION = 'drover-effort-test';
  let fakeBin, outDir, tdir, env;
  const MARKER = () => path.join(outDir, 'PWNED');
  // Shell syntax of every kind, a newline, and a trailing ";" (which tmux, not a shell, would act on).
  const hostile = () => `"; touch ${MARKER()}; echo $(touch ${MARKER()}) \`touch ${MARKER()}\` '$HOME' && rm -rf ${outDir}/never | tee ${MARKER()} > ${MARKER()}\nsecond line $((1+1)) #{session_name} \\ end;`;
  const tmuxCmd = (args) => spawnSync('tmux', args, { env, encoding: 'utf8' });
  const alive = () => tmuxCmd(['has-session', '-t', `=${TMUX_SESSION}`]).status === 0;
  const recorded = async (engine) => {
    const f = path.join(outDir, `${engine}.argv`);
    await waitFor(() => existsSync(f));
    const argv = (await readFile(f, 'utf8')).split('\0').slice(0, -1);
    const cwd = (await readFile(path.join(outDir, `${engine}.pwd`), 'utf8')).trim();
    await rm(f); await rm(path.join(outDir, `${engine}.pwd`));
    return { argv, cwd };
  };

  before(async () => {
    // A private tmux server: its own socket directory, no user config, and no TMUX variable that could point
    // a client at the user's server. Every tmux call in this process (core/tmux.js too) goes there.
    tdir = await mkdtemp(path.join(tmpdir(), 'drovertm-'));
    fakeBin = path.join(tdir, 'bin'); outDir = path.join(tdir, 'out');
    await mkdir(fakeBin); await mkdir(outDir);
    for (const name of ['claude', 'codex']) {
      const f = path.join(fakeBin, name);
      // Records each argument NUL-terminated and the physical cwd, then renames into place so a reader never sees half a file.
      await writeFile(f, `#!/bin/sh\nout="$DROVER_FAKE_OUT/$(basename "$0")"\npwd -P > "$out.pwd"\nprintf '%s' "$PATH" > "$out.path"\n: > "$out.argv.tmp"\nfor a in "$@"; do printf '%s\\0' "$a" >> "$out.argv.tmp"; done\nmv "$out.argv.tmp" "$out.argv"\n`);
      await chmod(f, 0o755);
    }
    delete process.env.TMUX; delete process.env.TMUX_PANE;
    process.env.TMUX_TMPDIR = tdir;
    process.env.DROVER_FAKE_OUT = outDir;
    process.env.PATH = `${fakeBin}:${process.env.PATH}`;
    env = { ...process.env };
    // The first window runs sleep, not a login shell, so no shell config of the user runs in here.
    const started = tmuxCmd(['-f', '/dev/null', 'new-session', '-d', '-s', TMUX_SESSION, '-c', tdir, 'sleep', '3600']);
    assert.equal(started.status, 0, started.stderr);
    launchMod._deps.newWindow = (opts) => tmux.newWindow(opts);   // the real adapter for this block
    await credentials._reset({ file: true });
  });
  after(async () => {
    launchMod._deps.newWindow = fakeNewWindow;
    // env is set only once TMUX is unset and TMUX_TMPDIR is private. after() also runs when before() fails earlier,
    // and a kill-server without that env would reach the user's own tmux server.
    // The kill names the private server's socket: with TMUX_TMPDIR alone, a missing folder would send it to the
    // user's default server.
    if (env) tmuxCmd(['-S', path.join(tdir, `tmux-${process.getuid()}`, 'default'), 'kill-server']);
    await rm(tdir, { recursive: true, force: true });
  });

  test('claude: a hostile prompt arrives as one argument, beside --effort, and nothing in it runs', async () => {
    const r = await launchMod.launch({ engine: 'claude', mode: 'tmux', profile: 'claude-plan', model: 'opus', effort: 'max', cwd: tdir, prompt: hostile(), tmuxSession: TMUX_SESSION, name: 'hostile' }, { actor: 't' });
    assert.deepEqual(r.argv, ['claude', '--dangerously-skip-permissions', '--permission-mode', 'plan', '--model', 'opus', '--effort', 'max', '--', hostile()]);
    const got = await recorded('claude');
    assert.deepEqual(got.argv, r.argv.slice(1), 'the agent received exactly the argv the launch built');
    assert.equal(got.cwd, realpathSync(tdir));
    assert.equal(existsSync(MARKER()), false, 'no shell expanded the prompt');
  });

  test('codex: the same with -p, -m and -c model_reasoning_effort', async () => {
    const r = await launchMod.launch({ engine: 'codex', mode: 'tmux', profile: 'codex-fast', model: 'openai.gpt-6-astra', effort: 'ultra', cwd: tdir, prompt: hostile(), tmuxSession: TMUX_SESSION, name: 'hostile-cx' }, { actor: 't' });
    assert.deepEqual((await recorded('codex')).argv, ['-p', 'fast', '-m', 'openai.gpt-6-astra', '-c', 'model_reasoning_effort="ultra"', '--', hostile()]);
    assert.equal(existsSync(MARKER()), false);
    assert.equal(r.effort, 'ultra');
  });

  test("the agent's pane gets the agent PATH, not the daemon's (tmux takes it from the client, not from -e)", async () => {
    assert.ok(!process.env.PATH.split(':').includes(AGENT_ONLY), 'the marker dir is not in the daemon PATH');
    for (const engine of ['claude', 'codex']) {
      await launchMod.launch({ engine, mode: 'tmux', cwd: tdir, prompt: 'p', tmuxSession: TMUX_SESSION, name: `path-${engine}` }, { actor: 't' });
      await recorded(engine);
      assert.equal(await readFile(path.join(outDir, `${engine}.path`), 'utf8'), await agentPath(), engine);
    }
  });

  test('a profile PATH without the tmux dir still launches: the client is the tmux on the daemon PATH', async () => {
    // The fake agent needs basename and mv; link them into a dir of their own, so the profile PATH holds no tmux.
    const tools = path.join(tdir, 'tools'); await mkdir(tools, { recursive: true });
    for (const t of ['basename', 'mv']) await symlink(spawnSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf8' }).stdout.trim(), path.join(tools, t)).catch(() => {});
    const own = `${fakeBin}:${tools}`;
    assert.notEqual(spawnSync('/bin/sh', ['-c', 'command -v tmux'], { env: { PATH: own }, encoding: 'utf8' }).status, 0, 'no tmux on the profile PATH (dash exits 127, bash 1)');
    const withPath = structuredClone(PROFILES);
    withPath.claude.profiles.push({ id: 'claude-own-path', label: 'own PATH', argv: [], env: { PATH: own } });
    await writeFile(process.env.DROVER_PROFILES, JSON.stringify(withPath));
    try {
      await launchMod.launch({ engine: 'claude', mode: 'tmux', profile: 'claude-own-path', cwd: tdir, prompt: 'p', tmuxSession: TMUX_SESSION, name: 'own-path' }, { actor: 't' });
      await recorded('claude');
      assert.equal(await readFile(path.join(outDir, 'claude.path'), 'utf8'), own);
    } finally { await writeFile(process.env.DROVER_PROFILES, JSON.stringify(PROFILES)); }
  });

  test('a value ending in ";" (model, cwd) cannot end the tmux command and start another (kill-server here)', async () => {
    const dirWithSemi = path.join(tdir, 'work;');
    await mkdir(dirWithSemi);
    const r = await launchMod.launch({ engine: 'claude', mode: 'tmux', model: 'x;', cwd: dirWithSemi, prompt: 'kill-server', tmuxSession: TMUX_SESSION, name: 'semi' }, { actor: 't' });
    const got = await recorded('claude');
    assert.deepEqual(got.argv, ['--dangerously-skip-permissions', '--model', 'x;', '--', 'kill-server']);
    assert.deepEqual(got.argv, r.argv.slice(1));
    assert.equal(got.cwd, realpathSync(dirWithSemi), 'the ";" in -c is part of the directory');
    assert.equal(alive(), true, 'kill-server stayed an argument of the agent');
  });

  test('a prompt that looks like a flag reaches the agent after --, on claude-safe and on codex (a subcommand name too)', async () => {
    for (const prompt of ['--dangerously-skip-permissions', '--version']) {
      const r = await launchMod.launch({ engine: 'claude', mode: 'tmux', profile: 'claude-safe', cwd: tdir, prompt, tmuxSession: TMUX_SESSION, name: 'flagprompt' }, { actor: 't' });
      assert.deepEqual(r.argv, ['claude', '--', prompt]);
      assert.deepEqual((await recorded('claude')).argv, ['--', prompt], `${prompt} is prompt text, not an option`);
    }
    await launchMod.launch({ engine: 'codex', mode: 'tmux', profile: 'codex-default', cwd: tdir, prompt: 'logout', tmuxSession: TMUX_SESSION, name: 'subcmd' }, { actor: 't' });
    assert.deepEqual((await recorded('codex')).argv, ['--', 'logout']);
  });

  test('a resume id that looks like a flag stays the id (claude --resume=, codex resume --)', async () => {
    await launchMod.launch({ engine: 'claude', mode: 'tmux', profile: 'claude-safe', cwd: tdir, resume: '--dangerously-skip-permissions', prompt: '--version', tmuxSession: TMUX_SESSION, name: 'res-claude' }, { actor: 't' });
    assert.deepEqual((await recorded('claude')).argv, ['--resume=--dangerously-skip-permissions', '--', '--version']);
    await launchMod.launch({ engine: 'codex', mode: 'tmux', cwd: tdir, resume: '--last', tmuxSession: TMUX_SESSION, name: 'res-codex' }, { actor: 't' });
    assert.deepEqual((await recorded('codex')).argv, ['-p', 'work', 'resume', '--', '--last']);
  });

  test('send-keys gets the same escaping: keys ["a;", "kill-server"] are typed, not run', async () => {
    await tmux.sendKeys(`${TMUX_SESSION}:0`, ['a;', 'kill-server']);
    assert.equal(alive(), true);
  });

  test('a hostile effort is refused before tmux is asked for a window', async () => {
    const count = () => tmuxCmd(['list-windows', '-a']).stdout.split('\n').filter(Boolean).length;
    const n = count();
    for (const effort of [`max; touch ${MARKER()}`, `$(touch ${MARKER()})`, 'max\ntouch x', 'max;']) {
      await assert.rejects(launchMod.launch({ engine: 'claude', mode: 'tmux', effort, cwd: tdir, prompt: 'x', tmuxSession: TMUX_SESSION }, { actor: 't' }), /is not valid for claude/);
    }
    assert.equal(count(), n, 'no window was created');
    assert.equal(existsSync(MARKER()), false);
  });
});

// ---------------------------------------------------------------- version probe: front daemon -> remote host

/** A fake `ssh <host> drover rpc`: generation N answers each request with answer(gen, op, args). Records requests. */
function fakeRemote(answer) {
  const spawned = [];
  remote._deps.spawn = () => {
    const c = new EventEmitter();
    c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.requests = [];
    const gen = spawned.length;
    c.stdin = {
      write(d) {
        for (const line of String(d).split('\n').filter(Boolean)) {
          const req = JSON.parse(line); c.requests.push(req);
          const a = answer(gen, req.op, req.args);
          setImmediate(() => c.stdout.write(JSON.stringify(typeof a === 'string' && a.startsWith('ERR:') ? { id: req.id, ok: false, error: a.slice(4) } : { id: req.id, ok: true, result: a }) + '\n'));
        }
      },
      end() { c.stdinEnded = true; setTimeout(() => c.emit('close', 0), 10); }, on() {},
    };
    c.kill = () => { setImmediate(() => c.emit('close', null)); };
    spawned.push(c);
    return c;
  };
  return spawned;
}
const OLD = (op) => (op === 'launch.efforts' ? `ERR:unknown op ${op}` : null);

describe('dispatch(): a launch with an effort to another host asks that host first', () => {
  afterEach(() => remote.stopAll());

  test('a host on older Drover code is refused with a clear message and never receives launch.start', async () => {
    const spawned = fakeRemote((gen, op, args) => OLD(op) ?? { gen, op, args });
    await assert.rejects(api.dispatch('launch.start', { host: 'effort-old', engine: 'claude', mode: 'tmux', effort: 'max' }),
      /effort-old runs Drover code that cannot set a launch effort \(it does not know launch\.efforts\), so nothing was started/);
    const ops = spawned.flatMap((c) => c.requests.map((r) => r.op));
    assert.deepEqual(ops, ['launch.efforts', 'launch.efforts'], 'probed once, retried once on a fresh peer (skew restart), never launched');
  });

  test('a peer that predates the host update is retired by the probe, and the launch runs on the fresh one with its effort', async () => {
    const spawned = fakeRemote((gen, op, args) => (gen === 0 ? OLD(op) ?? { gen, op } : op === 'launch.efforts' ? effortLevels() : { gen, op, args }));
    const r = await api.dispatch('launch.start', { host: 'effort-stale', engine: 'codex', mode: 'tmux', effort: 'ultra', prompt: 'go' });
    assert.equal(r.gen, 1);
    assert.deepEqual(r.args, { engine: 'codex', mode: 'tmux', effort: 'ultra', prompt: 'go' });
    assert.deepEqual(spawned[0].requests.map((x) => x.op), ['launch.efforts']);
    assert.deepEqual(spawned[1].requests.map((x) => x.op), ['launch.efforts', 'launch.start']);
  });

  test('a current host is probed once, then launched; an omitted effort is forwarded with no probe at all', async () => {
    let spawned = fakeRemote((gen, op, args) => (op === 'launch.efforts' ? effortLevels() : { gen, op, args }));
    const r = await api.dispatch('launch.start', { host: 'effort-new', engine: 'claude', mode: 'headless', effort: 'low' });
    assert.equal(r.args.effort, 'low');
    assert.deepEqual(spawned.flatMap((c) => c.requests.map((x) => x.op)), ['launch.efforts', 'launch.start']);
    remote.stopAll();
    spawned = fakeRemote((gen, op, args) => OLD(op) ?? { gen, op, args });
    const plain = await api.dispatch('launch.start', { host: 'effort-plain', engine: 'claude', mode: 'tmux', prompt: 'hi' });
    assert.deepEqual(plain.args, { engine: 'claude', mode: 'tmux', prompt: 'hi' });
    assert.deepEqual(spawned.flatMap((c) => c.requests.map((x) => x.op)), ['launch.start'], 'no effort, no probe: even an old host launches as before');
  });
});

// ---------------------------------------------------------------- drover_launch (MCP)

function fakeDispatch(results = {}) {
  const calls = [];
  const fn = async (op, args) => { calls.push({ op, args }); const r = results[op]; if (r instanceof Error) throw r; return r ?? { op, echo: args }; };
  fn.calls = calls;
  return fn;
}
const call = (s, args) => s.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'drover_launch', arguments: args } });

describe('drover_launch effort', () => {
  test('the schema offers every level; the probe runs first, then launch.start carries the effort (and the host)', async () => {
    const tool = TOOLS.find((t) => t.name === 'drover_launch');
    assert.deepEqual(tool.inputSchema.properties.effort.enum, [...ALL_EFFORTS]);
    assert.match(tool.description, /effort/); assert.match(tool.inputSchema.properties.effort.description, /claude: low, medium, high, xhigh, max\. codex: low, medium, high, xhigh, max, ultra/);
    const d = fakeDispatch({ 'launch.efforts': effortLevels() });
    const s = createServer({ dispatch: d, log: () => {} });
    const r = await call(s, { engine: 'codex', effort: 'max', profile: 'codex-fast', model: 'openai.gpt-6.1-sol', prompt: 'go', host: 'devbox' });
    assert.equal(r.result.isError, false);
    assert.deepEqual(d.calls, [
      { op: 'launch.efforts', args: { host: 'devbox' } },
      { op: 'launch.start', args: { engine: 'codex', profile: 'codex-fast', model: 'openai.gpt-6.1-sol', effort: 'max', prompt: 'go', host: 'devbox', actor: 'mcp' } },
    ]);
  });

  test('a daemon or host on older code: isError naming the fix, and nothing launched', async () => {
    const d = fakeDispatch({ 'launch.efforts': new Error('unknown op launch.efforts') });
    const s = createServer({ dispatch: d, log: () => {} });
    const r = await call(s, { engine: 'claude', effort: 'high', prompt: 'go' });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /effort not applied and nothing was started: the Drover daemon on this machine runs Drover code from before launch efforts\. Restart it onto the current code \(launchctl kickstart -k gui\/\$\(id -u\)\/dev\.drover\.daemon on a Mac/);
    assert.deepEqual(d.calls.map((c) => c.op), ['launch.efforts']);
    const remoteOld = fakeDispatch({ 'launch.efforts': new Error('unknown op launch.efforts') });
    const r1 = await call(createServer({ dispatch: remoteOld, log: () => {} }), { engine: 'codex', effort: 'max', host: 'devbox' });
    // How to update another host is the fleet's own (DROVER_UPDATE_HINT), with a generic default.
    assert.ok(r1.result.content[0].text.includes(`nothing was started: devbox, or the Drover daemon in front of it, runs Drover code from before launch efforts. Update Drover on devbox (${UPDATE_HINT}),`), r1.result.content[0].text);
    assert.deepEqual(remoteOld.calls, [{ op: 'launch.efforts', args: { host: 'devbox' } }]);
    const other = fakeDispatch({ 'launch.efforts': new Error('ssh devbox drover rpc exited 255: ssh could not connect') });
    const r2 = await call(createServer({ dispatch: other, log: () => {} }), { engine: 'claude', effort: 'high', host: 'devbox' });
    assert.equal(r2.result.isError, true);
    assert.equal(r2.result.content[0].text, 'ssh devbox drover rpc exited 255: ssh could not connect', 'other probe failures pass through unchanged');
    assert.deepEqual(other.calls.map((c) => c.op), ['launch.efforts']);
  });

  test('a level no engine takes is rejected by the schema before any dispatch; an omitted effort is the single call it always was', async () => {
    const d = fakeDispatch();
    const s = createServer({ dispatch: d, log: () => {} });
    const bad = await call(s, { engine: 'claude', effort: 'turbo' });
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /argument "effort" must be one of low, medium, high, xhigh, max, ultra/);
    assert.equal(d.calls.length, 0);
    await call(s, { engine: 'claude', mode: 'tmux', prompt: 'go', effort: null });
    assert.deepEqual(d.calls, [{ op: 'launch.start', args: { engine: 'claude', mode: 'tmux', prompt: 'go', actor: 'mcp' } }]);
  });
});

// ---------------------------------------------------------------- the op surface and the real profiles

describe('where a tmux launch opens its window, and which profiles file is read', () => {
  test('defaultTmuxSession: the profiles\' tmuxSession, else the first suggestion, else agents', () => {
    assert.equal(launchMod.defaultTmuxSession({ tmuxSession: 'work', tmuxSessions: ['other'] }), 'work');
    assert.equal(launchMod.defaultTmuxSession({ tmuxSession: '  ', tmuxSessions: ['', 'first', 'second'] }), 'first');
    assert.equal(launchMod.defaultTmuxSession({}), 'agents');
    assert.equal(launchMod.defaultTmuxSession(null), launchMod.FALLBACK_TMUX_SESSION);
  });

  test('a launch that names no session opens its window in the profiles\' tmuxSession; one that names a session keeps it', async () => {
    windows.length = 0;
    const named = structuredClone(PROFILES);
    named.tmuxSession = 'fleet-work'; named.tmuxSessions = ['later'];
    await writeFile(process.env.DROVER_PROFILES, JSON.stringify(named));
    try {
      await launchMod.launch({ engine: 'claude', mode: 'tmux', cwd: dir, prompt: 'go', name: 'where' }, { actor: 't' });
      await launchMod.launch({ engine: 'claude', mode: 'tmux', cwd: dir, prompt: 'go', name: 'there', tmuxSession: 'mine' }, { actor: 't' });
      await writeFile(process.env.DROVER_PROFILES, JSON.stringify(PROFILES));
      await launchMod.launch({ engine: 'codex', mode: 'tmux', cwd: dir, prompt: 'go', name: 'plain' }, { actor: 't' });
    } finally { await writeFile(process.env.DROVER_PROFILES, JSON.stringify(PROFILES)); }
    assert.deepEqual(windows.map((w) => w.session), ['fleet-work', 'mine', 'agents']);
  });

  test('DROVER_PROFILES may start with ~/ (the user\'s home), and the shipped profiles.json is the default', () => {
    const home = realpathSync(dir);
    const read = (env) => {
      const e = { ...process.env, HOME: home, ...env };
      for (const k of ['DROVER_PROFILES', 'APXW_PROFILES']) if (!(k in env)) delete e[k];
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', "const m = await import('./core/launch.js'); process.stdout.write(JSON.stringify([m.PROFILES_FILE, Object.keys(await m.loadProfiles())]))"], { cwd: path.join(import.meta.dirname, '..'), env: e, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout);
    };
    const [file, keys] = read({ DROVER_PROFILES: '~/profiles.json' });
    assert.equal(file, path.join(home, 'profiles.json'));
    // The file under the home was read; it predates Hermes, so the shipped hermes section is added to it.
    assert.deepEqual(keys, [...Object.keys(PROFILES), 'hermes'], 'the file under the home was read');
    const [shipped] = read({});
    assert.equal(shipped, path.join(import.meta.dirname, '..', 'profiles.json'));
  });

  test('a custom profiles file keeps its own engine sections; only an engine it has none for gets the shipped one', async () => {
    const real = JSON.parse(await readFile(new URL('../profiles.json', import.meta.url), 'utf8'));
    const p = await launchMod.loadProfiles();
    assert.deepEqual(p.claude, PROFILES.claude, 'its own claude section, not the shipped one');
    assert.deepEqual(p.hermes, real.hermes);
    const own = { ...structuredClone(PROFILES), hermes: { models: [], profiles: [{ id: 'hermes-mine', label: 'mine', argv: ['--cli'], env: {}, default: true }] } };
    await writeFile(process.env.DROVER_PROFILES, JSON.stringify(own));
    try { assert.deepEqual((await launchMod.loadProfiles()).hermes, own.hermes); }
    finally { await writeFile(process.env.DROVER_PROFILES, JSON.stringify(PROFILES)); }
  });
});

describe('launch.efforts op and the real profiles', () => {
  test('launch.efforts is in the op table and ops-meta, read-only, returns the levels, and is an MCP tool', async () => {
    assert.ok(api.OPS.includes('launch.efforts'));
    assert.equal(META['launch.efforts'].m, false);
    assert.ok(META['launch.efforts'].d.length > 40);
    assert.deepEqual(await api.dispatchLocal('launch.efforts'), effortLevels());
    assert.ok(ALL_TOOLS.some((t) => t.name === 'drover_launch_efforts'), 'generated MCP tool');
    assert.deepEqual(META['launch.start'].s.properties.effort.enum, [...ALL_EFFORTS]);
  });

  test('no profile in web/profiles.json sets an effort of its own, so a launch effort is the only one in the argv', async () => {
    const real = JSON.parse(await readFile(new URL('../profiles.json', import.meta.url), 'utf8'));
    for (const engine of ['claude', 'codex']) {
      for (const p of real[engine].profiles) {
        assert.ok(!(p.argv ?? []).some((a) => /--effort|model_reasoning_effort/.test(a)), `${p.id} carries an effort flag`);
        const lv = EFFORT_LEVELS[engine].at(-1);
        const argv = engine === 'claude' ? claude.interactiveArgv(p, { effort: lv }) : codex.interactiveArgv(p, { effort: lv });
        assert.deepEqual(argv, [engine, ...(p.argv ?? []), ...(engine === 'claude' ? ['--effort', lv] : ['-c', `model_reasoning_effort="${lv}"`])]);
      }
    }
  });
});
