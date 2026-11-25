// A Claude launch profile's `command` (core/claude.js claudeCommand, checked in core/launch.js resolveProfile): a
// wrapper that starts Claude Code itself runs instead of `claude`, with Claude's own argv after it, in tmux,
// headless (a real child here, through a fake wrapper that reports the argv it got) and in the launch event and
// the launch view's preview. And DROVER_<ENGINE>_PROFILE, the host's own default profile over the file's.
// Profiles, state, events and dotfiles point at scratch files through env; no tmux server, agent or credential of
// the user is touched.
// Run: node --test test/launch-command.test.js
import { test, describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(tmpdir(), 'drovercmd-'));
process.env.DROVER_PROFILES = path.join(dir, 'profiles.json');
process.env.DROVER_STATE = path.join(dir, 'state');
process.env.DROVER_DOTFILES = path.join(dir, 'dotfiles');
process.env.DROVER_EVENTS = path.join(dir, 'dotfiles', 'claude', 'drover-events.jsonl');
process.env.DROVER_CACHE = path.join(dir, 'cache');
process.env.DROVER_HOST = 'testbox';
process.env.DROVER_TEST_MAIN = 'x-fake-main-value-000001';
delete process.env.DROVER_CLAUDE_PROFILE;
delete process.env.DROVER_CODEX_PROFILE;
await mkdir(path.join(dir, 'dotfiles', 'claude'), { recursive: true });

// A stand-in for a launcher like claude-space: it takes `--` as "everything after is Claude's" and reports, as one
// stream-json-shaped line, the argv it would hand to Claude, then exits.
const WRAPPER = path.join(dir, 'fake-wrapper');
await writeFile(WRAPPER, `#!/usr/bin/env node
const a = process.argv.slice(2);
const i = a.indexOf('--');
process.stdout.write(JSON.stringify({ type: 'wrapper', lead: i < 0 ? a : a.slice(0, i), claude: i < 0 ? [] : a.slice(i + 1) }) + '\\n');
`);
await chmod(WRAPPER, 0o755);

const PROFILES = {
  claude: {
    models: [{ id: 'opus', label: 'Opus' }],
    profiles: [
      { id: 'claude-skip', label: 'skip permissions', argv: ['--dangerously-skip-permissions'], env: {}, default: true },
      { id: 'claude-gw', label: 'through a wrapper', command: [WRAPPER, '--'], argv: ['--dangerously-skip-permissions'], env: {}, route: 'gateway' },
      { id: 'claude-home', label: 'wrapper under ~', command: ['~/bin/launcher', '--'], argv: [], env: {} },
    ],
  },
  codex: {
    models: [],
    profiles: [
      { id: 'codex-work', label: 'work', argv: ['-p', 'work'], env: {}, default: true },
      { id: 'codex-fast', label: 'fast', argv: ['-p', 'fast'], env: {} },
    ],
  },
  credentials: {
    // Routed, as a fleet's entries are: an unrouted entry fits every route, so it would serve the gateway profile too.
    pool: [{ id: 'main', label: 'Main', route: 'commercial', env: { FAKE_CHILD_TOKEN: '$DROVER_TEST_MAIN' }, weight: 1, maxConcurrent: 50 }],
    default: 'auto',
    appliesTo: ['claude'],
  },
};
const writeProfiles = (p) => writeFile(process.env.DROVER_PROFILES, JSON.stringify(p));
await writeProfiles(PROFILES);

const claude = await import('../core/claude.js');
const credentials = await import('../core/credpool.js');
const launchMod = await import('../core/launch.js');

const windows = [];
launchMod._deps.newWindow = async (opts) => { windows.push(opts); return { target: `agents:${windows.length}` }; };
launchMod._deps.agentPath = async () => process.env.PATH;
launchMod._deps.trustFolder = async () => null;
launchMod._deps.onboardClaude = async () => null;
launchMod._deps.answerClaudeApiKey = async () => null;
const RealHeadless = launchMod._deps.HeadlessClaude;
class FakeHeadless {
  constructor(opts) { this.opts = opts; this.sessionId = opts.resume ?? 'sess-1'; this.argv = claude.headlessArgv(opts.profile, { model: opts.model, effort: opts.effort, resume: opts.resume, sessionId: this.sessionId }); FakeHeadless.instances.push(this); }
  send() {}
  stop() { setTimeout(() => this.opts.onExit(0, null), 5); }
}
FakeHeadless.instances = [];
launchMod._deps.HeadlessClaude = FakeHeadless;

const lastEvent = async () => (existsSync(process.env.DROVER_EVENTS) ? JSON.parse((await readFile(process.env.DROVER_EVENTS, 'utf8')).trim().split('\n').at(-1)) : null);
const waitFor = async (fn, ms = 5000) => { const t0 = Date.now(); while (!(await fn())) { if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 20)); } };

after(async () => { await rm(dir, { recursive: true, force: true }); });
beforeEach(async () => { windows.length = 0; FakeHeadless.instances.length = 0; delete process.env.DROVER_CLAUDE_PROFILE; delete process.env.DROVER_CODEX_PROFILE; await writeProfiles(PROFILES); await credentials._reset({ file: true }); });

describe('claudeCommand and the argv builders', () => {
  test('no command is exactly `claude`, as before', () => {
    assert.deepEqual(claude.claudeCommand({}), ['claude']);
    assert.deepEqual(claude.claudeCommand({ command: [] }), ['claude']);
    assert.deepEqual(claude.interactiveArgv({ argv: ['--x'] }, { model: 'opus', prompt: 'hi' }), ['claude', '--x', '--model', 'opus', '--', 'hi']);
  });

  test('a command replaces `claude`; profile argv, model, effort, resume, name and the -- prompt follow it unchanged', () => {
    const p = { command: ['/w', '--'], argv: ['--dangerously-skip-permissions'] };
    assert.deepEqual(claude.interactiveArgv(p, { model: 'opus', effort: 'high', resume: 'S1', name: 'n', prompt: '--version' }),
      ['/w', '--', '--dangerously-skip-permissions', '--model', 'opus', '--effort', 'high', '--resume=S1', '--name=n', '--', '--version']);
    assert.deepEqual(claude.claudeCommand(p), ['/w', '--']);
    p.command.push('mutated');
    assert.deepEqual(claude.claudeCommand({ command: ['/w'] }), ['/w'], 'a copy, never the profile array');
  });
});

describe('resolveProfile checks the command', () => {
  test('a leading ~ is this user\'s home; other strings are kept as they are', async () => {
    const p = await launchMod.resolveProfile('claude', 'claude-home');
    assert.deepEqual(p.command, [`${process.env.HOME}/bin/launcher`, '--']);
    assert.equal((await launchMod.resolveProfile('claude', 'claude-skip')).command, undefined, 'no command, no key');
  });

  test('a malformed command is refused before anything starts, and so is one on a Codex profile', async () => {
    for (const bad of ['claude-space', [], [''], ['/w', 3], ['/w\u0000x']]) {
      const ps = structuredClone(PROFILES);
      ps.claude.profiles.push({ id: 'claude-bad', label: 'bad', command: bad, argv: [], env: {} });
      await writeProfiles(ps);
      await assert.rejects(launchMod.resolveProfile('claude', 'claude-bad'), /profile claude-bad: command must be a non-empty array of non-empty strings/, JSON.stringify(bad));
      await assert.rejects(launchMod.launch({ engine: 'claude', mode: 'tmux', profile: 'claude-bad', cwd: dir, name: 'x' }), /command must be/);
    }
    assert.equal(windows.length, 0, 'no window opened');
    const ps = structuredClone(PROFILES);
    ps.codex.profiles.push({ id: 'codex-wrapped', label: 'w', command: ['/w'], argv: [], env: {} });
    await writeProfiles(ps);
    await assert.rejects(launchMod.resolveProfile('codex', 'codex-wrapped'), /profile codex-wrapped: command is supported for Claude profiles only/);
  });
});

describe('launch() through a command', () => {
  test('tmux: the window runs the command with Claude\'s argv after it; the result and the event say so; a route no entry serves gets no pool credential', async () => {
    const r = await launchMod.launch({ engine: 'claude', mode: 'tmux', profile: 'claude-gw', model: 'opus', effort: 'high', cwd: dir, prompt: 'go', name: 'gw1' }, { actor: 't' });
    const want = [WRAPPER, '--', '--dangerously-skip-permissions', '--model', 'opus', '--effort', 'high', '--name=gw1', '--', 'go'];
    assert.deepEqual(windows[0].argv, want);
    assert.deepEqual(r.argv, want);
    assert.equal(r.credential, null, 'route gateway: no pool entry serves it');
    assert.equal(windows[0].env.FAKE_CHILD_TOKEN, undefined, 'and no pool value reaches the window');
    const ev = await lastEvent();
    assert.deepEqual(ev.argv, want); assert.equal(ev.profile, 'claude-gw');
  });

  test('headless: HeadlessClaude gets the profile with its command, and the event records the command, not `claude`', async () => {
    const r = await launchMod.launch({ engine: 'claude', mode: 'headless', profile: 'claude-gw', model: 'opus', cwd: dir, prompt: 'work' }, { actor: 't' });
    const h = FakeHeadless.instances.at(-1);
    assert.deepEqual(h.opts.profile.command, [WRAPPER, '--']);
    assert.deepEqual((await lastEvent()).argv, [WRAPPER, '--', ...h.argv]);
    launchMod.headlessStop(r.headlessId);
  });

  test('a real headless child: the wrapper runs, with its leading arguments, then the stream-json argv after --', async () => {
    const events = [];
    let exited = false;
    const p = await launchMod.resolveProfile('claude', 'claude-gw');
    const h = new RealHeadless({ cwd: dir, profile: p, model: 'opus', effort: 'low', env: {}, onEvent: (d) => events.push(d), onExit: () => { exited = true; } });
    await waitFor(() => exited);
    const got = events.find((d) => d.type === 'wrapper');
    assert.ok(got, `the wrapper reported its argv (events: ${JSON.stringify(events)})`);
    assert.deepEqual(got.lead, []);
    assert.deepEqual(got.claude, claude.headlessArgv(p, { model: 'opus', effort: 'low', sessionId: h.sessionId }));
    assert.deepEqual(h.command, [WRAPPER, '--']);
  });

  test('a profile without a command launches `claude` exactly as before', async () => {
    const r = await launchMod.launch({ engine: 'claude', mode: 'tmux', cwd: dir, prompt: 'go', name: 'plain' }, { actor: 't' });
    assert.deepEqual(r.argv, ['claude', '--dangerously-skip-permissions', '--name=plain', '--', 'go']);
  });
});

describe('DROVER_<ENGINE>_PROFILE: the host\'s default profile', () => {
  test('unset, the file\'s default stands', async () => {
    assert.equal((await launchMod.resolveProfile('claude')).id, 'claude-skip');
    const all = await launchMod.loadProfiles();
    assert.deepEqual(all.claude.profiles.filter((p) => p.default).map((p) => p.id), ['claude-skip']);
  });

  test('set, the named profile is the only default: a launch with no profile uses it, and launch.profiles shows it', async () => {
    process.env.DROVER_CLAUDE_PROFILE = 'claude-gw';
    assert.equal((await launchMod.resolveProfile('claude')).id, 'claude-gw');
    const all = await launchMod.loadProfiles();
    assert.deepEqual(all.claude.profiles.filter((p) => p.default).map((p) => p.id), ['claude-gw']);
    assert.deepEqual(all.codex.profiles.filter((p) => p.default).map((p) => p.id), ['codex-work'], 'other engines keep their own default');
    const r = await launchMod.launch({ engine: 'claude', mode: 'tmux', cwd: dir, prompt: 'go', name: 'dflt' }, { actor: 't' });
    assert.equal(r.argv[0], WRAPPER);
    assert.equal((await launchMod.resolveProfile('claude', 'claude-skip')).id, 'claude-skip', 'an explicit profile still wins');
    process.env.DROVER_CODEX_PROFILE = 'codex-fast';
    assert.equal((await launchMod.resolveProfile('codex')).id, 'codex-fast');
  });

  test('a name the file does not have: a launch that would fall back to the file\'s default is refused; an explicit profile still runs', async () => {
    process.env.DROVER_CLAUDE_PROFILE = 'claude-nope';
    const all = await launchMod.loadProfiles();
    assert.equal(all.claude.hostDefaultMissing, 'claude-nope');
    await assert.rejects(launchMod.launch({ engine: 'claude', mode: 'tmux', cwd: dir, name: 'x' }), /DROVER_CLAUDE_PROFILE names profile claude-nope, which the profiles file has no claude profile for; nothing was started/);
    assert.equal(windows.length, 0);
    assert.equal((await launchMod.resolveProfile('claude', 'claude-skip')).id, 'claude-skip');
  });

  test('the file on disk is never changed', async () => {
    process.env.DROVER_CLAUDE_PROFILE = 'claude-gw';
    await launchMod.loadProfiles();
    assert.deepEqual(JSON.parse(await readFile(process.env.DROVER_PROFILES, 'utf8')), PROFILES);
  });
});
