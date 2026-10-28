// Hermes Agent sessions (core/hermes.js and its wiring): the pure shapes (prompt dialogs, keys, argv, transcript
// turns, the process list), the read-only state.db reads (reset lineages and compression chains folded into one
// conversation, hidden sources, rewound rows, the policy rows' client environment never read), and the gateway
// protocol against a stand-in gateway with a real control socket and WebSocket (test/fake-hermes.js): when a listing
// may reach it, live state and pending prompts, answering, messaging, a named profile the root gateway multiplexes.
// Then launches (tmux, headless one-shot turns, the remote guard), the op table, board strips and alerts. Everything
// lives in a temp dir: HERMES_HOME, Drover's state and events, Claude and Codex homes; nothing here reads ~/.hermes.
import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { chmodSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeHome, startFakeHermes, sid } from './fake-hermes.js';

const tmp = await mkdtemp(path.join(tmpdir(), 'drover-hermes-'));
const HOME = path.join(tmp, 'hermes');
process.env.HERMES_HOME = HOME;
process.env.DROVER_STATE = path.join(tmp, 'state');
process.env.DROVER_CACHE = path.join(tmp, 'cache');
process.env.DROVER_DOTFILES = path.join(tmp, 'dotfiles');
process.env.DROVER_EVENTS = path.join(tmp, 'events.jsonl');
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
process.env.CODEX_HOME = path.join(tmp, 'codex');
process.env.DROVER_HOST = 'testbox';
await mkdir(path.join(tmp, 'claude', 'sessions'), { recursive: true });
await mkdir(path.join(tmp, 'dotfiles', 'claude'), { recursive: true });
await writeFile(path.join(tmp, 'dotfiles', 'claude', 'fleet-hosts.txt'), 'hermes-old\nhermes-new\n');
// `claude agents --json` is part of the session list: a stand-in that lists nothing.
const bin = path.join(tmp, 'bin');
await mkdir(bin);
await writeFile(path.join(bin, 'claude'), '#!/bin/sh\necho "[]"\n');
await chmod(path.join(bin, 'claude'), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;

const hermes = await import('../core/hermes.js');
const api = await import('../core/api.js');
const launchMod = await import('../core/launch.js');
const remote = await import('../core/remote.js');
const { stripsFor } = await import('../ui/lanes.js');
const { snapshotOf, diffSnapshots } = await import('../core/notify.js');
const native = await import('../core/native.js');
const { answerModel } = await import('../ui/answer-model.js');

let psText = '';
hermes._deps.ps = async () => psText;
let panes = [];
hermes._deps.paneTtys = async () => panes;
const reset = () => { hermes.clearCaches(); psText = ''; panes = []; };
after(async () => { remote.stopAll(); await rm(tmp, { recursive: true, force: true }); });

const NOW = Date.now() / 1000;
const S = { plain: sid(1), comp: sid(2), compChild: sid(3), reset: sid(4), resetNext: sid(5), tool: sid(6), archived: sid(7), sub: sid(8), tui: sid(9), ended: sid(10), old: sid(11), oneshot: sid(12) };

// ---------------------------------------------------------------- pure shapes

describe('pure: prompts, keys, argv, turns, clients', () => {
  test('an approval is a dialog: its choices as 1..n in the order the TUI numbers them, option 1 highlighted, Enter picks it, Escape denies; the hash is the prompt id', () => {
    // The gateway lists once, deny, session, always; the TUI numbers once, session, always, deny (Deny last), and a
    // digit must mean here what it means in the pane.
    const d = hermes.promptDialog({ kind: 'approval', prompt_id: 'p1', execution_generation: 3, command: 'rm -rf ./scratch', description: 'recursive delete', choices: ['once', 'deny', 'session', 'always'] });
    assert.equal(d.dialog.question, 'Run rm -rf ./scratch (recursive delete)?');
    assert.deepEqual(d.dialog.options, [{ n: 1, label: 'Allow once', selected: true }, { n: 2, label: 'Allow this session' }, { n: 3, label: 'Always allow' }, { n: 4, label: 'Deny' }]);
    assert.deepEqual(d.keys, ['1', '2', '3', '4', 'Enter', 'Escape']);
    assert.equal(d.hash, 'p1'); assert.equal(d.answer, 'keys'); assert.equal(d.kind, 'approval');
    // A smart-denied approval offers once and deny only (session_pending_controls.py).
    assert.deepEqual(hermes.promptDialog({ kind: 'approval', prompt_id: 'p2', choices: ['once', 'deny'] }).keys, ['1', '2', 'Enter', 'Escape']);
    // No permanent allow offered: always drops out and deny moves up, as in the TUI.
    assert.deepEqual(hermes.promptDialog({ kind: 'approval', prompt_id: 'p3', choices: ['once', 'deny', 'session'] }).dialog.options.map((o) => o.label), ['Allow once', 'Allow this session', 'Deny']);
  });

  test('a clarify with choices takes their digits; one without, or a multi-select, is answered in text; a secret prompt is not Drover\'s', () => {
    const c = hermes.promptDialog({ kind: 'clarify', prompt_id: 'c1', question: 'Which fixture?', choices: ['small', 'large'] });
    assert.deepEqual(c.dialog, { question: 'Which fixture?', options: [{ n: 1, label: 'small' }, { n: 2, label: 'large' }] });
    assert.deepEqual(c.keys, ['1', '2']);
    assert.equal(hermes.promptDialog({ kind: 'clarify', prompt_id: 'c2', question: 'Name it?' }).answer, 'reply');
    assert.equal(hermes.promptDialog({ kind: 'clarify', prompt_id: 'c3', question: 'Pick', choices: ['a', 'b'], multi_select: true }).answer, 'reply');
    assert.equal(hermes.promptDialog({ kind: 'secret', prompt_id: 's1' }), null);
    assert.equal(hermes.promptDialog({ kind: 'approval' }), null);
  });

  test('a key becomes the response the gateway takes, and anything else is refused with what would work', () => {
    const a = { kind: 'approval', choices: ['once', 'deny', 'session', 'always'] };
    assert.deepEqual(hermes.promptResponse(a, '2'), { method: 'approval.respond', field: 'choice', value: 'session' });
    assert.deepEqual(hermes.promptResponse(a, '3'), { method: 'approval.respond', field: 'choice', value: 'always' });
    assert.deepEqual(hermes.promptResponse(a, '4'), { method: 'approval.respond', field: 'choice', value: 'deny' });
    assert.deepEqual(hermes.promptResponse(a, 'Enter'), { method: 'approval.respond', field: 'choice', value: 'once' });
    assert.deepEqual(hermes.promptResponse(a, 'Escape'), { method: 'approval.respond', field: 'choice', value: 'deny' });
    assert.match(hermes.promptResponse(a, '9').refused, /takes 1, 2, 3, 4, Enter \(once\) or Escape \(deny\)/);
    assert.match(hermes.promptResponse(a, 'y').refused, /takes/);
    assert.deepEqual(hermes.promptResponse({ kind: 'clarify', choices: ['small', 'large'] }, '2'), { method: 'clarify.respond', field: 'answer', value: 'large' });
    assert.match(hermes.promptResponse({ kind: 'clarify', choices: [] }, '1').refused, /answered with a message/);
    assert.match(hermes.promptResponse({ kind: 'sudo' }, 'Enter').refused, /answer it in its terminal/);
  });

  test('interactive argv: values bound with "=", a unique title for a new session, no model or effort on a resume', () => {
    const p = { argv: ['--tui'] };
    assert.deepEqual(hermes.interactiveArgv(p, { model: 'm1', effort: 'high', cwd: '/w', prompt: '--version please', title: 'fix-a1b2c3' }),
      ['hermes', 'chat', '--tui', '--model=m1', '--reasoning', 'high', '--in=/w', '--continue=fix-a1b2c3', '--create-if-missing', '--query=--version please']);
    assert.deepEqual(hermes.interactiveArgv(p, { model: 'm1', effort: 'high', cwd: '/w', resume: sid(1) }), ['hermes', 'chat', '--tui', '--in=/w', `--resume=${sid(1)}`]);
    assert.deepEqual(hermes.interactiveArgv(p, { prompt: 'line one\nline two' }).at(-1), '--query=line one\nline two');
    assert.throws(() => hermes.interactiveArgv(p, { resume: '--x; rm' }), /bad Hermes session id/);
    assert.throws(() => hermes.interactiveArgv(p, { prompt: 'a\u0000b' }), /NUL/);
    assert.throws(() => hermes.interactiveArgv(p, { effort: 'MAX' }), /is not valid for hermes/);
    assert.match(hermes.launchTitle('fix'), /^fix-[0-9a-f]{6}$/);
  });

  test('one-shot argv: stream-json, the prompt on stdin, the profile\'s interactive-only flags dropped', () => {
    assert.deepEqual(hermes.oneShotArgv({ argv: ['--tui', '--yolo'] }, { model: 'm', effort: 'low', cwd: '/w' }),
      ['chat', '--oneshot', '--query-file', '-', '--format', 'stream-json', '--yolo', '--model=m', '--reasoning', 'low', '--in=/w']);
    assert.deepEqual(hermes.oneShotArgv({}, { model: 'm', effort: 'low', resume: sid(2) }), ['chat', '--oneshot', '--query-file', '-', '--format', 'stream-json', `--resume=${sid(2)}`]);
  });

  test('message rows become chat turns: tool calls summarized, terminal results with their exit code', () => {
    const turns = hermes.rowsToTurns([
      { id: 1, role: 'user', content: 'run the tests', timestamp: NOW },
      { id: 2, role: 'assistant', content: '', tool_calls: JSON.stringify([{ id: 't1', function: { name: 'terminal', arguments: JSON.stringify({ command: 'npm test' }) } }]), timestamp: NOW },
      { id: 3, role: 'tool', content: JSON.stringify({ output: '1 failing', exit_code: 1, error: null }), tool_call_id: 't1', timestamp: NOW },
      { id: 4, role: 'tool', content: 'plain text result', tool_call_id: 't2', timestamp: NOW },
      { id: 5, role: 'assistant', content: '', reasoning: 'thinking', timestamp: NOW },
      { id: 6, role: 'assistant', content: 'One test fails.', timestamp: NOW },
      { id: 7, role: 'system', content: 'ignored', timestamp: NOW },
    ]);
    assert.deepEqual(turns.map((t) => t.role), ['user', 'assistant', 'tool_result', 'tool_result', 'thinking', 'assistant']);
    assert.deepEqual(turns[1].tools, [{ id: 't1', name: 'terminal', input: { command: 'npm test' }, summary: 'npm test' }]);
    assert.equal(turns[2].results[0].isError, true); assert.match(turns[2].text, /^\[error\] 1 failing/);
    assert.equal(turns[3].results[0].isError, false); assert.equal(turns[3].text, 'plain text result');
    assert.deepEqual(hermes.toolOutput(JSON.stringify({ output: '', exit_code: -1, error: 'BLOCKED: denied' })), { text: 'error: BLOCKED: denied', failed: true });
  });

  test('Hermes clients in a process list: the hermes scripts, python -m hermes_cli, the TUI; never the gateway, an editor or a prompt that names hermes', () => {
    const ps = [
      '  101 /usr/bin/Python -m hermes_cli.main --profile default gateway run --quiet --idle-exit',
      '  102 /usr/bin/Python /home/u/.hermes/hermes-agent/venv/bin/hermes chat -q hi',
      '  103 /home/u/.hermes/tools/node/bin/node --expose-gc /home/u/hermes-agent/ui-tui/dist/entry.js',
      '  104 vim core/hermes.js',
      '  105 claude --model x tell hermes-agent/bin/hermes about it',
      '  106 /usr/local/bin/hermes-acp',
      '  107 zsh -c /home/u/bin/hermes chat --tui',   // the shell that started a client: the client counts, not it
      '  108 /usr/bin/Python /src/hermes_cli/main.py chat --tui',
    ].join('\n');
    assert.deepEqual(hermes.clientPids(ps, { exclude: [108] }), [102, 103, 106]);
  });
});

// ---------------------------------------------------------------- the database

function homeRows() {
  const ago = (s) => NOW - s;
  return {
    sessions: [
      { id: S.plain, title: 'fix the parser', cwd: '/work/a', started_at: ago(900), last_activity_at: ago(100), message_count: 4 },
      { id: S.comp, title: 'long job', cwd: '/work/old', started_at: ago(3000), ended_at: ago(2000), end_reason: 'compression', last_activity_at: ago(2000), message_count: 2 },
      { id: S.compChild, cwd: '/work/b', started_at: ago(1999), parent_session_id: S.comp, last_activity_at: ago(50), message_count: 2 },
      { id: S.reset, title: 'reset me', cwd: '/work/c', started_at: ago(4000), ended_at: ago(3500), end_reason: 'session_reset', message_count: 2 },
      { id: S.resetNext, cwd: '/work/c', started_at: ago(3400), last_activity_at: ago(30), message_count: 2 },
      { id: S.tool, title: 'a tool call', started_at: ago(500), source: 'tool', created_source: 'tool' },
      { id: S.archived, title: 'archived', started_at: ago(500), archived: true },
      { id: S.sub, title: 'subagent', started_at: ago(500), source: 'subagent', created_source: 'subagent' },
      { id: S.tui, title: 'tui session', cwd: null, started_at: ago(400), last_activity_at: ago(400) },
      { id: S.ended, title: 'closed one', cwd: '/work/d', started_at: ago(800), ended_at: ago(700), end_reason: 'cli_close', last_activity_at: ago(700) },
      { id: S.old, title: 'last month', cwd: '/work/e', started_at: ago(30 * 86400), last_activity_at: ago(30 * 86400) },
      { id: S.oneshot, cwd: '/work/f', started_at: ago(300), source: 'oneshot', created_source: 'oneshot' },
      { id: sid(13), title: 'a telegram chat', started_at: ago(200), source: 'telegram', created_source: 'telegram' },
      { id: sid(14), title: 'desktop chat', cwd: '/work/g', started_at: ago(250), source: 'local', created_source: 'gui' },
    ],
    messages: [
      { session_id: S.plain, role: 'user', content: 'fix the parser please' },
      { session_id: S.plain, role: 'assistant', content: 'Looking.\nDone: the parser handles tabs.' },
      { session_id: S.plain, role: 'assistant', content: 'an undone reply', active: false },
      { session_id: S.plain, role: 'assistant', content: 'an old compacted reply', active: false, compacted: true },
      { session_id: S.comp, role: 'user', content: 'start the long job' },
      { session_id: S.compChild, role: 'user', content: 'summary of earlier turns', summary: true },
      { session_id: S.compChild, role: 'assistant', content: 'long job finished' },
      { session_id: S.reset, role: 'user', content: 'before the reset' },
      { session_id: S.resetNext, role: 'assistant', content: 'after the reset' },
      { session_id: S.oneshot, role: 'user', content: 'a one-shot prompt that names the session' },
    ],
    policies: [{ id: S.reset, lineage: [S.reset, S.resetNext], cwd: '/work/c' }, { id: S.tui, cwd: '/work/tui' }, { id: S.plain, cwd: '/work/a' }],
  };
}

describe('state.db: conversations, transcripts, last replies', () => {
  before(() => { rmSync(HOME, { recursive: true, force: true }); makeHome(HOME, homeRows()); reset(); });

  test('a reset lineage and a compression chain are each one conversation; hidden sources, archived and old rows are left out', () => {
    const list = hermes.storedSessions(HOME, {});
    const byId = new Map(list.map((s) => [s.id, s]));
    // Local surfaces only: a messaging platform's chat (telegram) is Hermes' own business.
    assert.deepEqual(new Set(list.map((s) => s.id)), new Set([S.plain, S.comp, S.reset, S.tui, S.ended, S.oneshot, sid(14)]));
    // The compression chain under its first id, with the newest row's cwd and activity, and both rows' messages counted.
    assert.equal(byId.get(S.comp).cwd, '/work/b'); assert.equal(byId.get(S.comp).messageCount, 4); assert.equal(byId.get(S.comp).name, 'long job');
    assert.ok(Date.parse(byId.get(S.comp).updatedAt) > Date.parse(byId.get(S.plain).updatedAt));
    assert.equal(byId.get(S.reset).status, 'stored', 'a reset segment that ended is not the conversation ending');
    assert.equal(byId.get(S.ended).status, 'ended'); assert.equal(byId.get(S.ended).endReason, 'cli_close');
    assert.equal(byId.get(S.tui).cwd, '/work/tui', 'a TUI row has no cwd until it closes: the policy row\'s cwd stands in');
    assert.equal(byId.get(S.oneshot).name, 'a one-shot prompt that names the session', 'no title: its first prompt');
    assert.ok(list.every((s) => s.engine === 'hermes' && s.live === false));
    assert.doesNotMatch(JSON.stringify(list), /never-read|SECRET_TOKEN|system prompt/, 'the client environment and system prompts are never read');
  });

  test('a transcript spans the conversation\'s rows, leaves out rewound rows and compression summaries, and reads on from an offset', () => {
    const t = hermes.transcriptOf(HOME, S.plain, {});
    assert.deepEqual(t.turns.map((x) => x.text), ['fix the parser please', 'Looking.\nDone: the parser handles tabs.', 'an old compacted reply']);
    const c = hermes.transcriptOf(HOME, S.comp, {});
    assert.deepEqual(c.turns.map((x) => x.text), ['start the long job', 'long job finished']);
    const r = hermes.transcriptOf(HOME, S.reset, {});
    assert.deepEqual(r.turns.map((x) => x.text), ['before the reset', 'after the reset']);
    const next = hermes.transcriptOf(HOME, S.plain, { since: t.offset });
    assert.deepEqual(next.turns, []); assert.equal(next.offset, t.offset);
    assert.deepEqual(hermes.transcriptOf(HOME, S.plain, { limit: 1 }).turns.map((x) => x.text), ['an old compacted reply']);
  });

  test('findSession resolves an id, a later segment and an exact title to the conversation; lastReply is its newest shown text', async () => {
    assert.equal((await hermes.findSession(S.resetNext))?.id, S.reset);
    assert.equal((await hermes.findSession(S.compChild))?.id, S.comp);
    assert.equal((await hermes.findSession('fix the parser'))?.id, S.plain);
    assert.equal(await hermes.findSession('no such session'), null);
    // With no live listing to name it, the gateway is addressed by what it knows: a compression chain's newest row, or
    // the conversation's own id when it keeps a policy row for it (its logical id).
    assert.equal((await hermes.findSession(S.comp)).gatewayId, S.compChild);
    assert.equal((await hermes.findSession(S.reset)).gatewayId, undefined);
    assert.equal(hermes.conversationIdOf(S.compChild), S.comp);
    assert.equal(await hermes.findSession(''), null);
    const s = await hermes.findSession(S.plain);
    assert.equal(hermes.lastReply(s).text, 'an old compacted reply');
    assert.equal(hermes.lastReply(await hermes.findSession(S.comp)).text, 'long job finished');
  });

  test('a branch of a row that ended in compression is its own conversation; the continuation (the newest child) folds in', () => {
    const home = path.join(tmp, 'branch-home');
    rmSync(home, { recursive: true, force: true });
    makeHome(home, { sessions: [
      { id: sid(51), title: 'trunk', started_at: NOW - 900, ended_at: NOW - 300, end_reason: 'compression' },
      { id: sid(52), title: 'a branch', started_at: NOW - 600, parent_session_id: sid(51), last_activity_at: NOW - 500 },
      { id: sid(53), started_at: NOW - 299, parent_session_id: sid(51), last_activity_at: NOW - 10 },
    ], messages: [
      { session_id: sid(51), role: 'user', content: 'trunk first' }, { session_id: sid(52), role: 'user', content: 'on the branch' }, { session_id: sid(53), role: 'assistant', content: 'trunk goes on' },
    ] });
    const ids = hermes.storedSessions(home, {}).map((x) => x.id).sort();
    assert.deepEqual(ids, [sid(51), sid(52)].sort());
    assert.deepEqual(hermes.transcriptOf(home, sid(51), {}).turns.map((t) => t.text), ['trunk first', 'trunk goes on']);
    assert.deepEqual(hermes.transcriptOf(home, sid(52), {}).turns.map((t) => t.text), ['on the branch']);
    assert.deepEqual([...hermes.conversationsOf(home, [sid(52), sid(53)])], [[sid(52), sid(52)], [sid(53), sid(51)]]);
  });

  test('a named profile with a database is found when the root has none', () => {
    const root = path.join(tmp, 'profiles-only');
    makeHome(path.join(root, 'profiles', 'work'), { sessions: [{ id: sid(61), title: 'work only', started_at: NOW - 60 }] });
    assert.deepEqual(hermes.homes({ HERMES_HOME: root, HOME: tmp }).map((h) => h.profile), ['work']);
    assert.equal(hermes.configured({ HERMES_HOME: root, HOME: tmp }), true);
  });

  test('a host without Hermes state lists nothing and reads nothing', async () => {
    const was = process.env.HERMES_HOME;
    process.env.HERMES_HOME = path.join(tmp, 'no-hermes-here');
    try {
      reset();
      assert.equal(hermes.configured(), false);
      assert.deepEqual(hermes.homes(), []);
      assert.deepEqual(await hermes.listSessions({}), []);
      assert.equal(await hermes.findSession(S.plain), null);
    } finally { process.env.HERMES_HOME = was; reset(); }
  });
});

// ---------------------------------------------------------------- the gateway

describe('the gateway: when a listing may ask it, live state, prompts', () => {
  let gw;
  const APPROVAL = { kind: 'approval', prompt_id: 'prm-1', execution_generation: 1, command: 'rm -rf ./scratch', description: 'recursive delete', choices: ['once', 'deny', 'session', 'always'] };
  before(async () => { rmSync(HOME, { recursive: true, force: true }); makeHome(HOME, homeRows()); });
  afterEach(async () => { await gw?.close(); gw = null; reset(); });
  const start = (opts) => startFakeHermes(HOME, { live: { [S.plain]: { status: 'waiting', title: 'fix the parser', prompts: [{ ...APPROVAL }] }, [S.tui]: { status: 'idle', title: 'tui session' }, [S.comp]: { status: 'working', title: 'long job' }, [sid(13)]: { status: 'working', source: 'telegram' }, [sid(99)]: { status: 'working', source: 'slack' } }, ...opts });

  test('an idle-exit gateway with no Hermes client running is never dialed: the database answers, and nothing is live', async () => {
    gw = await start();
    const list = await hermes.listSessions({ includeRecent: true });
    assert.equal(gw.connections, 0, 'no WebSocket: polling would hold off its idle exit');
    assert.ok(list.every((s) => !s.live));
    assert.equal((await hermes.listSessions({ includeRecent: false })).length, 0);
  });

  test('with a Hermes client running, the gateway gives live status and the pending approval as a dialog', async () => {
    gw = await start();
    psText = '  555 /x/venv/bin/python /x/venv/bin/hermes chat --tui';
    const list = await hermes.listSessions({ includeRecent: true });
    assert.equal(gw.connections, 1, 'one connection for the whole listing');
    const byId = new Map(list.map((s) => [s.id, s]));
    assert.equal(byId.get(S.plain).live, true); assert.equal(byId.get(S.plain).status, 'waiting');
    assert.deepEqual(byId.get(S.plain).keys, ['1', '2', '3', '4', 'Enter', 'Escape']);
    assert.equal(byId.get(S.plain).hash, 'prm-1');
    assert.equal(byId.get(S.plain).dialog.question, 'Run rm -rf ./scratch (recursive delete)?');
    assert.deepEqual(byId.get(S.plain).prompt, { kind: 'approval', id: 'prm-1' });
    assert.equal(byId.get(S.plain).summary, 'an old compacted reply');
    assert.equal(byId.get(S.comp).status, 'busy'); assert.equal(byId.get(S.tui).status, 'idle');
    assert.equal(byId.get(S.ended).live, false);
    assert.equal(byId.has(sid(13)), false, 'a messaging platform\'s live chat is not listed (its stored row is left out)');
    assert.equal(byId.has(sid(99)), false, 'nor one the database has no row for yet');
    // The waiting session's prompts came from a resume without its messages.
    assert.deepEqual(gw.calls.filter((c) => c.method === 'session.resume').map((c) => c.params), [{ session_id: S.plain, omit_messages: true }]);
  });

  test('a gateway that is not --idle-exit (a service) is dialed with no client running; a turn in flight allows it too', async () => {
    gw = await start({ idleExit: false });
    assert.equal((await hermes.listSessions({})).find((s) => s.id === S.plain).status, 'waiting');
    await gw.close(); reset();
    rmSync(HOME, { recursive: true, force: true }); makeHome(HOME, { ...homeRows(), admissions: [{ session_id: S.compChild, status: 'started' }] });
    gw = await start();
    const list = await hermes.listSessions({});
    assert.equal(gw.connections, 1, 'the database shows work in flight: the gateway is up for it anyway');
    assert.equal(list.find((s) => s.id === S.plain).status, 'waiting');
  });

  test('with no gateway at all, a turn the database shows in flight is live and busy under its conversation', async () => {
    rmSync(HOME, { recursive: true, force: true }); makeHome(HOME, { ...homeRows(), admissions: [{ session_id: S.compChild, status: 'started' }, { session_id: S.ended, status: 'terminal' }] });
    const live = (await hermes.listSessions({ includeRecent: false }));
    assert.deepEqual(live.map((s) => [s.id, s.status, s.live]), [[S.comp, 'busy', true]]);
    rmSync(HOME, { recursive: true, force: true }); makeHome(HOME, homeRows());
  });

  test('a control socket another user could reach is not used; a pointer must name a private hermes-gw-* socket', async () => {
    gw = await start();
    psText = '  555 /x/hermes chat';
    chmodSync(gw.socket, 0o666);
    assert.equal(hermes.controlSocket(HOME), null);
    assert.ok((await hermes.listSessions({})).every((s) => !s.live));
    chmodSync(gw.socket, 0o600);
    assert.equal(hermes.controlSocket(HOME), gw.socket);
    // The pointer form, for a home whose path is too long for a socket.
    const other = path.join(tmp, 'ptr-home'); mkdirSync(other, { recursive: true });
    writeFileSync(path.join(other, 'gateway.sock.path'), `${gw.socket}\n`, { mode: 0o600 });
    assert.equal(hermes.controlSocket(other), null, 'a target not named hermes-gw-<hash>/control.sock');
    chmodSync(path.join(other, 'gateway.sock.path'), 0o644);
    assert.equal(hermes.controlSocket(other), null, 'a pointer others can write');
  });

  test('the window a session is in: the one Drover launched its title in, else the pane whose tty a REPL recorded', async () => {
    gw = await start();
    psText = '  555 /x/hermes chat';
    await hermes.rememberPane('fix the parser', 'agents:@7', { home: HOME });
    mkdirSync(path.join(HOME, 'terminal-sessions'), { recursive: true });
    writeFileSync(path.join(HOME, 'terminal-sessions', 'tty-dev-ttys009'), JSON.stringify({ session_id: S.tui, cwd: '/work/tui', ts: NOW }));
    // A compressed REPL session: the breadcrumb names the segment the gateway names, which folds into its conversation.
    gw.live.set(S.compChild, { status: 'idle', prompts: [], generation: 1 }); gw.live.delete(S.comp);
    writeFileSync(path.join(HOME, 'terminal-sessions', 'tty-dev-ttys011'), JSON.stringify({ session_id: S.compChild, ts: NOW }));
    panes = [{ tty: '/dev/ttys004', window: 'main:@1' }, { tty: '/dev/ttys009', window: 'main:@3' }, { tty: '/dev/ttys011', window: 'main:@4' }];
    const list = await hermes.listSessions({ includeRecent: false });
    assert.equal(list.find((s) => s.id === S.plain).tmux, 'agents:@7');
    assert.equal(list.find((s) => s.id === S.tui).tmux, 'main:@3');
    assert.deepEqual([list.find((s) => s.id === S.comp).gatewayId, list.find((s) => s.id === S.comp).tmux], [S.compChild, 'main:@4']);
  });

  test('answer: the prompt the hash names, with exactly the params the gateway checks; anything else is refused with the dialog as it is now', async () => {
    gw = await start();
    const s = await hermes.findSession(S.plain);
    const stale = await hermes.answer(s, '1', { expect: 'prm-0' });
    assert.equal(stale.refused, true); assert.match(stale.reason, /changed since you read it/); assert.equal(stale.hash, 'prm-1');
    const wrong = await hermes.answer(s, 'y', { expect: 'prm-1' });
    assert.equal(wrong.refused, true); assert.match(wrong.reason, /takes 1, 2, 3, 4/);
    const ok = await hermes.answer(s, '2', { expect: 'prm-1' });
    assert.deepEqual([ok.ok, ok.choice, ok.via], [true, 'session', 'hermes approval.respond']);
    assert.deepEqual(gw.live.get(S.plain).answered, [{ prompt_id: 'prm-1', choice: 'session' }]);
    const again = await hermes.answer(s, '1', { expect: 'prm-1' });
    assert.equal(again.refused, true); assert.match(again.reason, /no Hermes prompt is waiting/);
  });

  test('a live id that is a later segment (the gateway names the compression continuation) is listed under its conversation and answered by its own id', async () => {
    gw = await startFakeHermes(HOME, { live: { [S.compChild]: { status: 'waiting', prompts: [{ ...APPROVAL, prompt_id: 'seg-1' }] } } });
    psText = '  555 /x/hermes chat';
    const list = await hermes.listSessions({ includeRecent: true });
    assert.deepEqual(list.filter((x) => [S.comp, S.compChild].includes(x.id)).map((x) => [x.id, x.live, x.gatewayId, x.hash]), [[S.comp, true, S.compChild, 'seg-1']], 'one item, under the conversation, not a second stored one');
    const r = await hermes.answer(await hermes.findSession(S.comp), '4', { expect: 'seg-1' });
    assert.deepEqual([r.ok, r.choice], [true, 'deny']);
    assert.deepEqual(gw.live.get(S.compChild).answered, [{ prompt_id: 'seg-1', choice: 'deny' }]);
  });

  test('answer: Escape denies, Enter allows once; a clarify takes its choice digit', async () => {
    gw = await startFakeHermes(HOME, { live: {
      [S.plain]: { status: 'waiting', prompts: [{ ...APPROVAL, prompt_id: 'a-esc' }] },
      [S.tui]: { status: 'waiting', prompts: [{ ...APPROVAL, prompt_id: 'a-enter' }] },
      // A compressed conversation: the gateway holds it under its newest row.
      [S.compChild]: { status: 'waiting', prompts: [{ kind: 'clarify', prompt_id: 'q-1', execution_generation: 1, question: 'Which fixture?', choices: ['small', 'large'] }] },
    } });
    assert.equal((await hermes.answer(await hermes.findSession(S.plain), 'Escape', { expect: 'a-esc' })).choice, 'deny');
    assert.equal((await hermes.answer(await hermes.findSession(S.tui), 'Enter', {})).choice, 'once', 'one prompt waiting: no expect needed');
    const q = await hermes.answer(await hermes.findSession(S.comp), '2', { expect: 'q-1' });
    assert.deepEqual([q.ok, q.answer, q.via], [true, 'large', 'hermes clarify.respond']);
  });

  test('send: a turn through prompt.submit after session.resume, with an input id; the reply lands in the transcript', async () => {
    gw = await start();
    const s = await hermes.findSession(S.tui);
    const r = await hermes.send(s, 'From Drover: say ACK');
    assert.deepEqual([r.ok, r.via, r.status], [true, 'hermes prompt.submit', 'queued']);
    const methods = gw.calls.map((c) => c.method);
    assert.deepEqual(methods.slice(-2), ['session.resume', 'prompt.submit']);
    assert.match(gw.submitted.at(-1).input_id, /^drover-[0-9a-f-]{36}$/);
    await new Promise((res) => setTimeout(res, 80));
    assert.equal(hermes.transcript(s, {}).turns.at(-1).text, 'echo: From Drover: say ACK');
    assert.equal(hermes.lastReply(s).text, 'echo: From Drover: say ACK');
    await assert.rejects(hermes.send(s, '   '), /empty message/);
  });

  test('send: a question the session is waiting on gets the message as its answer (free text, or "Other" for one with choices), not a new turn', async () => {
    gw = await startFakeHermes(HOME, { live: { [S.tui]: { status: 'waiting', prompts: [{ kind: 'clarify', prompt_id: 'q-free', execution_generation: 1, question: 'What should I call it?', choices: [] }] } } });
    const r = await hermes.send(await hermes.findSession(S.tui), 'call it parser-v2');
    assert.deepEqual([r.ok, r.via, r.answered], [true, 'hermes clarify.respond', 'q-free']);
    assert.deepEqual(gw.live.get(S.tui).answered, [{ prompt_id: 'q-free', answer: 'call it parser-v2' }]);
    assert.equal(gw.submitted.length, 0);
    await gw.close(); reset();
    gw = await startFakeHermes(HOME, { live: { [S.tui]: { status: 'waiting', prompts: [{ kind: 'clarify', prompt_id: 'q-pick', execution_generation: 1, question: 'Which fixture?', choices: ['small', 'large'] }] } } });
    const other = await hermes.send(await hermes.findSession(S.tui), 'medium, please');
    assert.deepEqual([other.via, other.answered], ['hermes clarify.respond', 'q-pick']);
    assert.deepEqual(gw.live.get(S.tui).answered, [{ prompt_id: 'q-pick', answer: 'medium, please' }]);
  });

  test('a named profile the root gateway multiplexes is reached through the root socket with its own profile id', async () => {
    const work = path.join(HOME, 'profiles', 'work');
    try {
      makeHome(work, { sessions: [{ id: sid(77), title: 'work job', cwd: '/w', started_at: NOW - 60, last_activity_at: NOW - 30 }] });
      gw = await startFakeHermes(HOME, { servedHomes: [HOME, work], live: { [sid(77)]: { status: 'working', profile: work }, [S.tui]: { status: 'idle' } } });
      assert.deepEqual(hermes.homes().map((h) => h.profile), [null, 'work']);
      const g = await hermes.gatewayFor(work);
      assert.equal(g.socket, gw.socket); assert.equal(g.profileId, work);
      psText = '  555 /x/hermes chat';
      const live = await hermes.listSessions({ includeRecent: false });
      assert.deepEqual(live.map((x) => [x.id, x.profile ?? null, x.status]), [[S.tui, null, 'idle'], [sid(77), 'work', 'busy']]);
      assert.equal(live.find((x) => x.id === sid(77)).name, 'work job', 'read from the profile\'s own database');
    } finally { rmSync(path.join(HOME, 'profiles'), { recursive: true, force: true }); }
  });

  test('hermes.status: state, profiles, the gateway and whether it exits when idle, the binary', async () => {
    gw = await start();
    const fake = path.join(tmp, 'bin', 'hermes-fake');
    writeFileSync(fake, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    process.env.DROVER_HERMES_BIN = fake;
    try {
      const st = await hermes.status();
      assert.equal(st.configured, true); assert.deepEqual(st.profiles, []);
      assert.deepEqual(st.gateways, [{ profile: null, up: true, pid: 424242, idleExit: true }]);
      assert.equal(st.bin, fake);
    } finally { delete process.env.DROVER_HERMES_BIN; }
    assert.equal(hermes.findBin('/nowhere'), null);
  });
});

// ---------------------------------------------------------------- a fake hermes executable

// Each run: records its argv and stdin to <log>, prints the stream-json a one-shot prints (Session on stderr first),
// then a reply. A prompt that starts with "slow" takes 300 ms.
const FAKE_BIN = path.join(tmp, 'bin', 'hermes');
const RUN_LOG = path.join(tmp, 'hermes-runs.jsonl');
writeFileSync(FAKE_BIN, `#!/usr/bin/env node
const fs = require('fs');
let input = ''; process.stdin.on('data', (d) => { input += d; }); process.stdin.on('end', () => {
  const resume = (process.argv.find((a) => a.startsWith('--resume=')) || '').slice(9);
  const id = resume || 'local-' + 'f'.repeat(60) + String(fs.existsSync(${JSON.stringify(RUN_LOG)}) ? fs.readFileSync(${JSON.stringify(RUN_LOG)}, 'utf8').split('\\n').filter(Boolean).length : 0).padStart(4, '0');
  fs.appendFileSync(${JSON.stringify(RUN_LOG)}, JSON.stringify({ argv: process.argv.slice(2), input, env: process.env.HERMES_HOME || null }) + '\\n');
  process.stderr.write('Session: ' + id + '\\n');
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  // "needs-human": the turn stops at an approval, which the gateway holds; the one-shot leaves it there (exit 3).
  if (input.startsWith('needs-human')) { setTimeout(() => { out({ type: 'system', subtype: 'init', model: '', session_id: '' }); out({ type: 'result', session_id: id, exit_code: 3, failed: true, error: 'waiting for approval' }); process.stderr.write('This turn is waiting for approval\\n'); process.exitCode = 3; }, input.includes('slow') ? 300 : 10); return; }
  setTimeout(() => {
    out({ type: 'system', subtype: 'init', model: '', session_id: '' });
    out({ type: 'tool_use', name: 'terminal', tool_call_id: 't1', input: { command: 'ls' } });
    out({ type: 'tool_result', name: 'terminal', tool_call_id: 't1', output: JSON.stringify({ output: 'a.txt', exit_code: 0, error: null }), is_error: false });
    out({ type: 'text', text: 'echo: ' }); out({ type: 'text', text: input.trim() });
    out({ type: 'result', session_id: id, exit_code: 0, text: 'echo: ' + input.trim() });
  }, input.startsWith('slow') ? 300 : 10);
});
`, { mode: 0o755 });

describe('HeadlessHermes: one --oneshot run per turn, resumed by the id it reported', () => {
  before(() => { process.env.DROVER_HERMES_BIN = FAKE_BIN; rmSync(RUN_LOG, { force: true }); });
  after(() => { delete process.env.DROVER_HERMES_BIN; });

  test('the first turn makes the session, the next resumes it; a message sent mid-turn waits for it', async () => {
    const events = [], statuses = [];
    const h = new hermes.HeadlessHermes({ cwd: tmp, profile: { argv: ['--tui', '--yolo'] }, model: 'm', effort: 'low', onEvent: (e) => events.push(e), onStatus: (s) => statuses.push(s) });
    h.send('slow first');
    assert.equal(h.send('second').queued, true);
    const t0 = Date.now();
    while (statuses.at(-1) !== 'idle' && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 20));
    const runs = (await readFile(RUN_LOG, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(runs.length, 2);
    assert.deepEqual(runs[0].argv, ['chat', '--oneshot', '--query-file', '-', '--format', 'stream-json', '--yolo', '--model=m', '--reasoning', 'low', `--in=${tmp}`]);
    assert.equal(runs[0].input, 'slow first');
    assert.ok(runs[1].argv.includes(`--resume=${h.sessionId}`), 'the second turn resumes the session the first reported');
    assert.ok(!runs[1].argv.includes('--model=m'), 'a resume takes no model');
    assert.deepEqual(statuses, ['busy', 'busy', 'idle']);
    assert.deepEqual([...new Set(events.map((e) => e.type))], ['hermes/system', 'hermes/tool_use', 'hermes/tool_result', 'hermes/text', 'hermes/result']);
    h.stop();
    assert.throws(() => h.send('after stop'), /stopped/);
  });
});

// ---------------------------------------------------------------- the op table and launches

describe('ops: sessions.list, get, transcript, lastReply, message and answer reach Hermes', () => {
  let gw;
  before(async () => { rmSync(HOME, { recursive: true, force: true }); makeHome(HOME, homeRows()); reset(); });
  afterEach(async () => { await gw?.close(); gw = null; reset(); });

  test('the session list carries live Hermes sessions with their dialog; a title finds one', async () => {
    gw = await startFakeHermes(HOME, { live: { [S.plain]: { status: 'waiting', title: 'fix the parser', prompts: [{ kind: 'approval', prompt_id: 'p9', execution_generation: 1, command: 'make deploy', choices: ['once', 'deny'] }] } } });
    psText = '  555 /x/hermes chat';
    const r = await api.dispatch('sessions.list', { includeRecent: false });
    const h = r.sessions.filter((s) => s.engine === 'hermes');
    assert.deepEqual(h.map((s) => [s.id, s.status, s.hash]), [[S.plain, 'waiting', 'p9']]);
    assert.equal((await api.dispatch('sessions.get', { id: 'fix the parser' })).id, S.plain);
    const t = await api.dispatch('sessions.transcript', { id: S.plain });
    assert.equal(t.engine, 'hermes'); assert.equal(t.turns[0].text, 'fix the parser please');
    const last = await api.dispatch('sessions.lastReply', { id: S.plain });
    assert.equal(last.engine, 'hermes'); assert.equal(last.ask.kind, 'decision', 'the pending approval is what it waits on');
  });

  test('sessions.answer presses the approval through the gateway and records it; sessions.message submits a turn and records it', async () => {
    gw = await startFakeHermes(HOME, { live: { [S.plain]: { status: 'waiting', prompts: [{ kind: 'approval', prompt_id: 'p10', execution_generation: 1, command: 'make deploy', choices: ['once', 'deny'] }] }, [S.tui]: { status: 'idle' } } });
    const a = await api.dispatchRecorded('sessions.answer', { id: S.plain, key: 'Enter', expect: 'p10', actor: 'tester' });
    assert.deepEqual([a.ok, a.choice, a.target], [true, 'once', S.plain]);
    const m = await api.dispatchRecorded('sessions.message', { id: S.tui, text: 'hello hermes', actor: 'tester' });
    assert.deepEqual([m.ok, m.via], [true, 'hermes prompt.submit']);
    const evs = (await readFile(process.env.DROVER_EVENTS, 'utf8')).trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.type === 'message');
    assert.deepEqual(evs.slice(-2).map((e) => [e.to.kind, e.text, e.delivery.via]), [['hermes', '[approval: once]', 'hermes approval.respond'], ['hermes', 'hello hermes', 'hermes prompt.submit']]);
    const refused = await api.dispatch('sessions.answer', { id: S.plain, key: '1' });
    assert.equal(refused.refused, true);
  });
});

describe('launch.start engine hermes', () => {
  const windows = [];
  let gw = null;
  afterEach(async () => { await gw?.close(); gw = null; reset(); });
  before(() => {
    process.env.DROVER_HERMES_BIN = FAKE_BIN;
    // newWindow answers the window's own id (session:@id), which stays put when tmux renumbers windows.
    launchMod._deps.newWindow = async (o) => { windows.push(o); return { target: `${o.session}:@55` }; };
    launchMod._deps.agentPath = async () => process.env.PATH;
    launchMod._deps.trustFolder = async () => null;
    rmSync(RUN_LOG, { force: true });
  });
  after(() => { delete process.env.DROVER_HERMES_BIN; for (const [id, e] of launchMod.headless) if (e.engine === 'hermes') { e.handle.stop(); launchMod.headless.delete(id); } });

  test('tmux: hermes chat with a unique title, the window remembered for it; the event and result carry the title', async () => {
    const r = await api.dispatch('launch.start', { engine: 'hermes', mode: 'tmux', cwd: tmp, prompt: 'fix it', name: 'fixer', model: 'm2', effort: 'max', tmuxSession: 'agents' });
    assert.match(r.title, /^fixer-[0-9a-f]{6}$/);
    assert.deepEqual(r.argv, [FAKE_BIN, 'chat', '--tui', '--model=m2', '--reasoning', 'max', `--in=${tmp}`, `--continue=${r.title}`, '--create-if-missing', '--query=fix it']);
    assert.equal(windows.at(-1).name, 'fixer');
    const panesFile = JSON.parse(await readFile(path.join(process.env.DROVER_STATE, 'hermes-panes.json'), 'utf8'));
    assert.equal(panesFile[r.title].window, 'agents:@55');
    const ev = (await readFile(process.env.DROVER_EVENTS, 'utf8')).trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.type === 'launch').at(-1);
    assert.deepEqual([ev.engine, ev.result.title], ['hermes', r.title]);
  });

  test('headless: each turn a one-shot run; the transcript joins its text into one reply; a second message resumes', async () => {
    const r = await api.dispatch('launch.start', { engine: 'hermes', mode: 'headless', cwd: tmp, prompt: 'first' });
    const t0 = Date.now();
    while (launchMod.headlessGet(r.headlessId).status !== 'idle' && Date.now() - t0 < 10_000) await new Promise((res) => setTimeout(res, 20));
    const sessionId = launchMod.headlessGet(r.headlessId).sessionId;
    assert.match(sessionId, /^local-f+\d{4}$/);
    await api.dispatch('sessions.message', { id: r.headlessId, text: 'second' });
    while (launchMod.headlessGet(r.headlessId).status !== 'idle' && Date.now() - t0 < 10_000) await new Promise((res) => setTimeout(res, 20));
    await new Promise((res) => setTimeout(res, 50));
    const t = await api.dispatch('sessions.transcript', { id: r.headlessId });
    const said = t.turns.filter((x) => x.role === 'assistant' && x.text).map((x) => x.text);
    assert.deepEqual(said, ['echo: first', 'echo: second']);
    assert.ok(t.turns.some((x) => x.role === 'assistant' && x.tools?.[0]?.summary === 'ls'));
    assert.ok(t.turns.some((x) => x.role === 'tool_result' && x.text === 'a.txt'));
    const runs = (await readFile(RUN_LOG, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(runs.at(-1).argv.includes(`--resume=${sessionId}`));
    const listed = (await api.dispatch('sessions.list', { includeRecent: true })).sessions.filter((s) => s.id === sessionId);
    assert.deepEqual(listed, [], 'a headless Hermes session is listed once, as its headless entry');
  });

  test('headless: a turn that needs a human waits with the gateway\'s prompt, answered and read through the conversation; stop interrupts the gateway\'s turn', async () => {
    rmSync(HOME, { recursive: true, force: true }); makeHome(HOME, homeRows()); reset();
    const r = await api.dispatch('launch.start', { engine: 'hermes', mode: 'headless', cwd: tmp, prompt: 'needs-human: delete the build folder' });
    const t0 = Date.now();
    while (launchMod.headlessGet(r.headlessId).status !== 'waiting' && Date.now() - t0 < 10_000) await new Promise((res) => setTimeout(res, 20));
    const sessionId = launchMod.headlessGet(r.headlessId).sessionId;
    assert.equal(launchMod.headlessGet(r.headlessId).status, 'waiting');
    // The gateway holds the conversation (the fake binary wrote no rows; the gateway's turn does).
    gw = await startFakeHermes(HOME, { live: { [sessionId]: { status: 'waiting', prompts: [{ kind: 'approval', prompt_id: 'hl-1', execution_generation: 1, command: 'rm -rf build', choices: ['once', 'deny'] }] } } });
    gw.writeTurn(sessionId, 'needs-human: delete the build folder');
    psText = '  555 /x/hermes chat'; hermes.clearCaches();
    const listed = (await api.dispatch('sessions.list', { includeRecent: true })).sessions;
    const entry = listed.find((x) => x.id === r.headlessId);
    assert.deepEqual([entry.status, entry.hash, entry.kind], ['waiting', 'hl-1', 'headless']);
    assert.equal(listed.filter((x) => x.id === sessionId).length, 0, 'listed once, as the headless entry');
    const a = await api.dispatch('sessions.answer', { id: r.headlessId, key: '1', expect: 'hl-1' });
    assert.deepEqual([a.ok, a.choice, a.target], [true, 'once', sessionId]);
    const t = await api.dispatch('sessions.transcript', { id: r.headlessId, since: 3 });
    assert.equal(t.headless, true); assert.equal(t.turns.at(-1).text, 'echo: needs-human: delete the build folder', 'read from the conversation');
    assert.equal(t.offset, 0, 'a full read: an earlier event-count cursor means nothing to the database');
    assert.equal(t.turns[0].text, 'needs-human: delete the build folder', 'since is not read as a row id');
    gw.live.get(sessionId).status = 'working';
    hermes.clearCaches();
    await api.dispatch('headless.stop', { id: r.headlessId });
    const t1 = Date.now();
    while (!gw.calls.some((c) => c.method === 'session.interrupt') && Date.now() - t1 < 5_000) await new Promise((res) => setTimeout(res, 20));
    assert.deepEqual(gw.calls.filter((c) => c.method === 'session.interrupt').map((c) => c.params), [{ session_id: sessionId }]);
    const submits = gw.submitted.length;
    await assert.rejects(api.dispatch('sessions.message', { id: r.headlessId, text: 'after stop' }), /stopped/);
    assert.equal(gw.submitted.length, submits, 'a stopped session sends nothing, even with its gateway up');
    await gw.close(); gw = null;
  });

  test('headless: a message sent mid-turn reaches the gateway when the turn leaves a prompt; the entry settles busy, then idle, then runs one-shots again', async () => {
    // The gateway owns the conversation before the one-shot leaves it (the fake binary's next id is predictable), and its
    // turn, waiting on the approval, is in flight (a started admission), as Hermes keeps it.
    const runs = (await readFile(RUN_LOG, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
    const sessionId = `local-${'f'.repeat(60)}${String(runs).padStart(4, '0')}`;
    rmSync(HOME, { recursive: true, force: true }); makeHome(HOME, { ...homeRows(), admissions: [{ session_id: sessionId, status: 'started' }] }); reset();
    gw = await startFakeHermes(HOME, { live: { [sessionId]: { status: 'waiting', prompts: [{ kind: 'approval', prompt_id: 'hl-2', execution_generation: 1, command: 'rm -rf build', choices: ['once', 'deny'] }] } } });
    gw.writeTurn(sessionId, 'needs-human: slow start');
    const r = await api.dispatch('launch.start', { engine: 'hermes', mode: 'headless', cwd: tmp, prompt: 'needs-human: slow start' });
    await api.dispatch('sessions.message', { id: r.headlessId, text: 'and then the docs' });   // queued behind the running one-shot
    const t0 = Date.now();
    while (!gw.submitted.length && Date.now() - t0 < 10_000) await new Promise((res) => setTimeout(res, 20));
    assert.deepEqual(gw.submitted.map((x) => [x.session_id, x.text]), [[sessionId, 'and then the docs']], `the queued message went to the gateway, behind the prompt; events: ${JSON.stringify(launchMod.headlessGet(r.headlessId).events.map((e) => [e.type, e.code ?? '', String(e.text ?? '').slice(0, 80)]))}`);
    assert.equal(launchMod.headlessGet(r.headlessId).status, 'waiting');
    hermes.clearCaches();
    const listed = (await api.dispatch('sessions.list', { includeRecent: false })).sessions.find((x) => x.id === r.headlessId);
    assert.deepEqual([listed.status, listed.hash], ['waiting', 'hl-2'], 'no Hermes client runs, but the turn in flight lets the listing see the prompt');
    await api.dispatch('sessions.answer', { id: r.headlessId, key: '1', expect: 'hl-2' });
    hermes.clearCaches();
    assert.equal((await api.dispatch('sessions.list', { includeRecent: false })).sessions.find((x) => x.id === r.headlessId).status, 'busy', 'answered: the gateway runs the turn on');
    assert.equal(launchMod.headlessGet(r.headlessId).status, 'busy');
    // A message now goes to the gateway (it queues behind the running turn), not to a one-shot of its own.
    const runsNow = (await readFile(RUN_LOG, 'utf8')).trim().split('\n').length;
    const m = await api.dispatch('sessions.message', { id: r.headlessId, text: 'then the changelog' });
    assert.equal(m.via, 'hermes prompt.submit');
    assert.equal((await readFile(RUN_LOG, 'utf8')).trim().split('\n').length, runsNow, 'no one-shot was started');
    gw.live.get(sessionId).status = 'idle'; psText = '  555 /x/hermes chat'; hermes.clearCaches();
    await api.dispatch('sessions.list', { includeRecent: false });
    assert.equal(launchMod.headlessGet(r.headlessId).status, 'idle', 'the gateway is done: idle');
    await gw.close(); gw = null; hermes.clearCaches();
    const before = (await readFile(RUN_LOG, 'utf8')).trim().split('\n').length;
    await api.dispatch('sessions.message', { id: r.headlessId, text: 'one more' });
    const t1 = Date.now();
    while ((await readFile(RUN_LOG, 'utf8')).trim().split('\n').length === before && Date.now() - t1 < 10_000) await new Promise((res) => setTimeout(res, 20));
    assert.ok(JSON.parse((await readFile(RUN_LOG, 'utf8')).trim().split('\n').at(-1)).argv.includes(`--resume=${sessionId}`), 'with no gateway, a one-shot this entry tracks');
    launchMod.headlessStop(r.headlessId);
  });

  test('a host with no hermes on the PATH refuses before anything starts', async () => {
    process.env.DROVER_HERMES_BIN = path.join(tmp, 'bin', 'not-there');
    const before = windows.length;
    try { await assert.rejects(api.dispatch('launch.start', { engine: 'hermes', mode: 'tmux', cwd: tmp }), /hermes is not on this host's PATH .* nothing was started/); }
    finally { process.env.DROVER_HERMES_BIN = FAKE_BIN; }
    assert.equal(windows.length, before);
  });
});

/** A fake `ssh <host> drover rpc` (as in launch-effort.test.js): answer(gen, op, args) per request; records them. */
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
      end() { setTimeout(() => c.emit('close', 0), 10); }, on() {},
    };
    c.kill = () => { setImmediate(() => c.emit('close', null)); };
    spawned.push(c);
    return c;
  };
  return spawned;
}

describe('a Hermes launch to another host asks that host first', () => {
  afterEach(() => remote.stopAll());
  test('a host on code from before Hermes is refused and never gets launch.start (older code would start Claude)', async () => {
    const spawned = fakeRemote((gen, op) => (op === 'hermes.status' ? 'ERR:unknown op hermes.status' : { gen, op }));
    await assert.rejects(api.dispatch('launch.start', { host: 'hermes-old', engine: 'hermes', mode: 'tmux' }), /hermes-old runs Drover code that cannot launch Hermes \(it would start Claude instead\), so nothing was started/);
    assert.ok(spawned.flatMap((c) => c.requests.map((r) => r.op)).every((op) => op === 'hermes.status'));
  });
  test('a current host is probed, then launched; a stale peer is retired first', async () => {
    const spawned = fakeRemote((gen, op, args) => (gen === 0 && op === 'hermes.status' ? 'ERR:unknown op hermes.status' : op === 'hermes.status' ? { configured: true } : { gen, op, args }));
    const r = await api.dispatch('launch.start', { host: 'hermes-new', engine: 'hermes', mode: 'tmux', prompt: 'go' });
    assert.equal(r.op, 'launch.start'); assert.equal(r.gen, 1);
    assert.deepEqual(spawned[1].requests.map((x) => x.op), ['hermes.status', 'launch.start']);
  });
});

// ---------------------------------------------------------------- board strips, answer fields, alerts

describe('a prompt the session reports itself, on the board and in alerts', () => {
  const approval = { id: S.plain, sessionId: S.plain, engine: 'hermes', name: 'fix the parser', live: true, status: 'waiting', tmux: 'agents:@7', dialog: { question: 'Run make deploy?', options: [{ n: 1, label: 'Allow once', selected: true }, { n: 2, label: 'Deny' }] }, hash: 'p1', keys: ['1', '2', 'Enter', 'Escape'], answer: 'keys', prompt: { kind: 'approval', id: 'p1' } };
  const question = { id: S.tui, sessionId: S.tui, engine: 'hermes', name: 'tui session', live: true, status: 'waiting', dialog: { question: 'What should I call it?', options: [] }, hash: 'q1', keys: [], answer: 'reply', prompt: { kind: 'clarify', id: 'q1' } };
  // A Hermes TUI in its window: the pane's own screen says nothing about the prompt.
  const windows = [{ target: 'agents:7', session: 'agents', windowId: '@7', name: 'fixer', screen: { state: 'idle' }, tail: ['❯'] }];

  test('the strip waits on it with its keys, whatever the pane shows; a text question waits as a question answered by reply', () => {
    const [a, q] = stripsFor({ host: 'local', sessions: [approval, question], windows });
    assert.deepEqual([a.lane, a.screen, a.reported, a.hash, a.ask.kind], ['wait', 'dialog', true, 'p1', 'decision']);
    assert.deepEqual(a.keys, ['1', '2', 'Enter', 'Escape']);
    assert.deepEqual([q.lane, q.screen, q.answer, q.ask.kind, q.ask.text], ['wait', undefined, 'reply', 'question', 'What should I call it?']);
    const strip = native.boardStrip(a, 'local');
    assert.deepEqual([strip.answer, strip.reported, strip.hash], ['keys', true, 'p1']);
    assert.deepEqual(strip.keys, ['1', '2', 'Enter', 'Escape'], 'the keys it named, not a pane dialog\'s y/n/Space');
    assert.deepEqual(native.boardStrip(q, 'local').answer, 'reply');
    // The browser's card presses through sessions.answer only: no pane to read first, no tmux fallback.
    const m = answerModel({ ...a, kind: 'session', host: 'local' });
    assert.equal(m.target, null); assert.equal(m.hash, 'p1');
    assert.deepEqual(m.buttons.map((b) => b.key), ['1', '2', 'Enter', 'Escape']);
  });

  test('the detector raises one alert per prompt, answerable from a notification; no second "needs you" for its waiting status', () => {
    const base = { ok: true, windows: [] };
    const prev = snapshotOf({ ...base, sessions: [{ ...approval, status: 'busy', dialog: undefined, hash: undefined }] });
    const next = snapshotOf({ ...base, sessions: [approval] });
    const alerts = diffSnapshots(prev, next, { host: 'testbox' });
    assert.equal(alerts.length, 1);
    assert.deepEqual([alerts[0].category, alerts[0].kind, alerts[0].target, alerts[0].meta.hash, alerts[0].meta.reported], ['needs-you', 'dialog', null, 'p1', true]);
    assert.deepEqual(diffSnapshots(next, snapshotOf({ ...base, sessions: [approval] }), { host: 'testbox' }), [], 'the same prompt again is no new alert');
    const n = native.buildNotifications([{ ...alerts[0], id: 'a1', ts: new Date().toISOString() }]).items[0];
    assert.deepEqual([n.answer, n.hash, n.reported], ['keys', 'p1', true]);
    assert.deepEqual(n.keys, ['1', '2', 'Enter', 'Escape']);
    const qa = diffSnapshots(snapshotOf({ ...base, sessions: [{ ...question, status: 'busy', dialog: undefined, hash: undefined }] }), snapshotOf({ ...base, sessions: [question] }), { host: 'testbox' });
    assert.deepEqual([qa[0].kind, qa[0].ask.kind], ['question', 'question']);
    assert.equal(native.buildNotifications([{ ...qa[0], id: 'a2', ts: new Date().toISOString() }]).items[0].answer, 'reply');
  });
});
