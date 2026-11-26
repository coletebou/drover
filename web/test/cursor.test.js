// The Cursor engine (core/cursor.js): cursor-agent's tmux argv, finding the binary, and launch() refusing what it
// cannot run (headless, a host with no cursor-agent, an effort) before anything starts. A fake cursor-agent on a
// scratch PATH stands in; no tmux server, Cursor login or credential of the user is touched.
// Run: node --test test/cursor.test.js
import { test, describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(tmpdir(), 'drovercursor-'));
process.env.DROVER_PROFILES = path.join(dir, 'profiles.json');
process.env.DROVER_STATE = path.join(dir, 'state');
process.env.DROVER_DOTFILES = path.join(dir, 'dotfiles');
process.env.DROVER_EVENTS = path.join(dir, 'dotfiles', 'claude', 'drover-events.jsonl');
process.env.DROVER_CACHE = path.join(dir, 'cache');
process.env.DROVER_HOST = 'testbox';
delete process.env.DROVER_CURSOR_BIN;
delete process.env.DROVER_CURSOR_PROFILE;
await mkdir(path.join(dir, 'dotfiles', 'claude'), { recursive: true });
const BIN = path.join(dir, 'bin');
await mkdir(BIN);
await writeFile(path.join(BIN, 'cursor-agent'), '#!/bin/sh\nexit 0\n');
await chmod(path.join(BIN, 'cursor-agent'), 0o755);

// A fleet file written before Cursor existed: it has no cursor section, so the shipped one is used.
const PROFILES = {
  claude: { models: [], profiles: [{ id: 'claude-skip', label: 's', argv: ['--dangerously-skip-permissions'], env: {}, default: true }] },
  codex: { models: [], profiles: [{ id: 'codex-default', label: 'c', argv: [], env: {}, default: true }] },
  credentials: { pool: [], default: 'auto', appliesTo: ['claude'] },
};
const writeProfiles = (p) => writeFile(process.env.DROVER_PROFILES, JSON.stringify(p));

const cursor = await import('../core/cursor.js');
const launchMod = await import('../core/launch.js');
const windows = [];
let agentPath = BIN;
launchMod._deps.newWindow = async (opts) => { windows.push(opts); return { target: `agents:@${windows.length}` }; };
launchMod._deps.agentPath = async () => agentPath;
const realTrust = launchMod._deps.trustFolder;
// The real trust step: for Cursor it writes nothing and says why.
launchMod._deps.trustFolder = async (engine, d, o) => { assert.equal(engine, 'cursor'); return realTrust(engine, d, o); };
launchMod._deps.onboardClaude = async () => { throw new Error('not a Claude launch'); };
launchMod._deps.answerClaudeApiKey = async () => { throw new Error('not a Claude launch'); };
const lastEvent = async () => (existsSync(process.env.DROVER_EVENTS) ? JSON.parse((await readFile(process.env.DROVER_EVENTS, 'utf8')).trim().split('\n').at(-1)) : null);

after(async () => { await rm(dir, { recursive: true, force: true }); });
beforeEach(async () => { windows.length = 0; agentPath = BIN; delete process.env.DROVER_CURSOR_BIN; await writeProfiles(PROFILES); });

describe('cursor.interactiveArgv', () => {
  test('profile argv, model, workspace and --trust, then the prompt after --', () => {
    assert.deepEqual(cursor.interactiveArgv({ argv: ['--force'] }, { model: 'gpt-5', cwd: '/w', prompt: '--do it' }),
      ['cursor-agent', '--force', '--model', 'gpt-5', '--workspace', '/w', '--trust', '--', '--do it']);
  });
  test('trust off leaves --trust out; a profile that already says --trust is not doubled', () => {
    assert.deepEqual(cursor.interactiveArgv({ argv: [] }, { cwd: '/w', prompt: 'p', trust: false }), ['cursor-agent', '--workspace', '/w', '--', 'p']);
    assert.deepEqual(cursor.interactiveArgv({ argv: ['--trust'] }, {}), ['cursor-agent', '--trust']);
  });
  test('resume continues a chat and drops the prompt', () => {
    assert.deepEqual(cursor.interactiveArgv({ argv: [] }, { resume: 'c1', prompt: 'ignored' }), ['cursor-agent', '--trust', '--resume', 'c1']);
  });
  test('DROVER_CURSOR_BIN names the binary', () => {
    assert.equal(cursor.cursorBin({ DROVER_CURSOR_BIN: '/opt/c/agent' }), '/opt/c/agent');
    assert.equal(cursor.interactiveArgv({ argv: [] }, { env: { DROVER_CURSOR_BIN: '/opt/c/agent' } })[0], '/opt/c/agent');
  });
  test('findBin looks on the given PATH, and an absolute bin must exist', () => {
    assert.equal(cursor.findBin(`/nonexistent${path.delimiter}${BIN}`, {}), path.join(BIN, 'cursor-agent'));
    assert.equal(cursor.findBin('/nonexistent', {}), null);
    assert.equal(cursor.findBin('', { DROVER_CURSOR_BIN: path.join(BIN, 'cursor-agent') }), path.join(BIN, 'cursor-agent'));
    assert.equal(cursor.findBin('', { DROVER_CURSOR_BIN: path.join(BIN, 'nope') }), null);
  });
});

describe('launch() with engine cursor', () => {
  test('the shipped cursor profiles fill in for a fleet file that has none; cursor-default is the default', async () => {
    const all = await launchMod.loadProfiles();
    assert.deepEqual(all.cursor.profiles.map((p) => p.id), ['cursor-default', 'cursor-yolo']);
    assert.equal((await launchMod.resolveProfile('cursor')).id, 'cursor-default');
    assert.deepEqual((await launchMod.resolveProfile('cursor', 'cursor-yolo')).argv, ['--force']);
  });

  test('tmux: the window runs cursor-agent in cwd with the prompt; no trust file, no pool credential; the event says so', async () => {
    const r = await launchMod.launch({ engine: 'cursor', mode: 'tmux', profile: 'cursor-yolo', cwd: dir, prompt: 'Read brief.md', name: 'impl-x', credential: 'none' }, { actor: 't' });
    const want = ['cursor-agent', '--force', '--workspace', dir, '--trust', '--', 'Read brief.md'];
    assert.deepEqual(windows[0].argv, want);
    assert.deepEqual(r.argv, want);
    assert.equal(r.ok, true);
    assert.equal(r.credential, null);
    assert.match(r.trust.skipped, /--trust/);
    const ev = await lastEvent();
    assert.equal(ev.engine, 'cursor'); assert.equal(ev.profile, 'cursor-yolo'); assert.deepEqual(ev.argv, want);
  });

  test('trust: false drops --trust', async () => {
    const r = await launchMod.launch({ engine: 'cursor', mode: 'tmux', cwd: dir, prompt: 'p', name: 'c2', trust: false }, { actor: 't' });
    assert.ok(!r.argv.includes('--trust'));
  });

  test('refused before anything starts: headless mode, no cursor-agent on the PATH, an effort', async () => {
    await assert.rejects(launchMod.launch({ engine: 'cursor', mode: 'headless', cwd: dir, prompt: 'p' }), /tmux window only/);
    agentPath = '/nonexistent';
    await assert.rejects(launchMod.launch({ engine: 'cursor', mode: 'tmux', cwd: dir, prompt: 'p', name: 'c3' }), /cursor-agent is not on this host's PATH/);
    agentPath = BIN;
    await assert.rejects(launchMod.launch({ engine: 'cursor', mode: 'tmux', cwd: dir, prompt: 'p', name: 'c4', effort: 'high' }), /not valid for cursor/);
    assert.equal(windows.length, 0, 'no window opened');
  });
});
