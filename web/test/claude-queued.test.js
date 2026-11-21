// Messages that reach a Claude Code session while a turn runs (core/claude-queued.js): the owner typing into a busy
// session's prompt box or into a background subagent's agent panel, another session's inbox message, the coordinator
// writing to its subagent. Claude Code records them as queued_command attachments, never as user records; every reader
// of Claude transcripts (turns, export, search index, grep, the ops) must show them as user turns. The records below
// copy the shape Claude Code 2.1.322 to 2.1.330 writes (keys, nesting, rendered reminder), with made-up text. Scratch
// homes only; nothing here reads the user's sessions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmp = await mkdtemp(path.join(tmpdir(), 'drover-queued-'));
process.env.DROVER_CACHE = path.join(tmp, 'cache');
process.env.DROVER_STATE = path.join(tmp, 'state');
process.env.DROVER_DOTFILES = path.join(tmp, 'dotfiles');
process.env.DROVER_EVENTS = path.join(tmp, 'dotfiles', 'claude', 'drover-events.jsonl');
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
process.env.CODEX_HOME = path.join(tmp, 'codex');
process.env.OPENCLAW_MANAGER_STATE_DIR = path.join(tmp, 'openclaw');
await mkdir(path.join(tmp, 'dotfiles', 'claude'), { recursive: true });
await writeFile(path.join(tmp, 'dotfiles', 'claude', 'fleet-hosts.txt'), '');
await mkdir(path.join(tmp, 'claude', 'sessions'), { recursive: true });
const bin = path.join(tmp, 'bin');
await mkdir(bin);
await writeFile(path.join(bin, 'claude'), '#!/bin/sh\necho "[]"\n', { mode: 0o755 });
await writeFile(path.join(bin, 'codex'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;

const { queuedMessage, peerSender } = await import('../core/claude-queued.js');
const claude = await import('../core/claude.js');
const tx = await import('../core/transcript-export.js');
const { claudeLine } = await import('../core/search/extract.js');
const { lineParts, grepTranscripts, findRg } = await import('../core/search/grep.js');

const L = (o) => JSON.stringify(o);
const ts = (n) => `2026-11-21T17:00:${String(n).padStart(2, '0')}.000Z`;
const SID = '0bbbbbbb-0000-4000-8000-00000000000b';
const AGENT = 'a0dd00000000000b1';
const CWD = '/work/repo';
const reminder = (who, text) => [{ content: `<system-reminder>\nThe ${who} sent a new message while you were working:\n${text}\n\nThis is how Claude Code surfaces messages typed mid-turn.\n</system-reminder>` }];
const base = (n, extra = {}) => ({ parentUuid: `p-${n}`, type: 'attachment', uuid: `u-${n}`, timestamp: ts(n), userType: 'external', entrypoint: 'cli', cwd: CWD, sessionId: SID, version: '2.1.330', gitBranch: 'main', ...extra });

// A subagent's agent panel ("Message @general-purpose..."): isMeta true although the owner typed it.
const panel = { ...base(3, { isSidechain: true, agentId: AGENT }), attachment: { type: 'queued_command', prompt: 'can the board show a rate gauge', source_uuid: 's-3', origin: { kind: 'human' }, isMeta: true }, rendered: reminder('user', 'can the board show a rate gauge'), renderedRole: 'system' };
// A busy main session's prompt box: commandMode prompt, humanTurn, content blocks with an image.
const typed = { ...base(5, { version: '2.1.322' }), attachment: { type: 'queued_command', prompt: [{ type: 'text', text: 'also check the footer' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }], source_uuid: 's-5', origin: { kind: 'human' }, commandMode: 'prompt', humanTurn: true, delivery_id: 'd-5', timestamp: ts(5) }, rendered: reminder('user', 'also check the footer'), renderedRole: 'system' };
const peer = { ...base(6), attachment: { type: 'queued_command', prompt: '<cross-session-message from-name="drover (owner)">\npause the rollout\n</cross-session-message>', source_uuid: 's-6', origin: { kind: 'peer', name: 'drover (owner)', from: 'drover', fromMode: 'bypass', body: 'pause the rollout', verifiedPeerPid: 4242 }, isMeta: true, commandMode: 'prompt', delivery_id: 'd-6', timestamp: ts(6) }, renderedRole: 'system' };
const otherPeer = { ...base(7), attachment: { type: 'queued_command', prompt: '<cross-session-message from-name="builder">\nbranch pushed\n</cross-session-message>', origin: { kind: 'peer', name: 'builder', body: 'branch pushed' }, isMeta: true, commandMode: 'prompt' } };
const coordinator = { ...base(8, { isSidechain: true, agentId: AGENT }), attachment: { type: 'queued_command', prompt: 'Coordinator: stop after the tests pass', source_uuid: 's-8', origin: { kind: 'coordinator' }, isMeta: true }, rendered: [{ content: '<system-reminder>\nThe coordinator sent a message while you were working:\nCoordinator: stop after the tests pass\n</system-reminder>' }], renderedRole: 'system' };
const notice = { ...base(9), attachment: { type: 'queued_command', prompt: '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>', source_uuid: 's-9', origin: { kind: 'task-notification' }, commandMode: 'task-notification', delivery_id: 'd-9', runId: 'r-9', timestamp: ts(9) }, renderedRole: 'system' };
const cont = { ...base(10), attachment: { type: 'queued_command', prompt: 'continue', origin: { kind: 'auto-continuation' }, commandMode: 'prompt' } };
// Before origin existed (2.1.2xx): commandMode alone.
const oldTyped = { ...base(11, { version: '2.1.178' }), attachment: { type: 'queued_command', prompt: 'old style typed note', commandMode: 'prompt', timestamp: ts(11) } };
const oldNotice = { ...base(12, { version: '2.1.220' }), attachment: { type: 'queued_command', prompt: '<task-notification>done</task-notification>', commandMode: 'task-notification', timestamp: ts(12) } };
const otherAttachment = { ...base(13), attachment: { type: 'todo_reminder', content: [] } };

test('queuedMessage: the owner, an inbox message and the coordinator count; bookkeeping and other attachments do not', () => {
  assert.deepEqual(queuedMessage(panel), { kind: 'human', via: 'queued', from: null, actor: null, text: 'can the board show a rate gauge', parts: ['can the board show a rate gauge'], images: 0 });
  assert.deepEqual([queuedMessage(typed).text, queuedMessage(typed).images, queuedMessage(typed).via], ['also check the footer', 1, 'queued']);
  assert.deepEqual(queuedMessage(peer), { kind: 'peer', via: 'drover', from: null, actor: 'owner', text: 'pause the rollout', parts: ['pause the rollout'], images: 0 });
  assert.deepEqual([queuedMessage(otherPeer).via, queuedMessage(otherPeer).from], ['peer', 'builder']);
  assert.deepEqual([queuedMessage(coordinator).via, queuedMessage(coordinator).actor, queuedMessage(coordinator).text], ['coordinator', 'coordinator', 'Coordinator: stop after the tests pass']);
  assert.equal(queuedMessage(oldTyped).text, 'old style typed note');
  for (const d of [notice, cont, oldNotice, otherAttachment, { type: 'user', message: { content: 'hi' } }, null]) assert.equal(queuedMessage(d), null);
  // An empty prompt is no message.
  assert.equal(queuedMessage({ ...panel, attachment: { ...panel.attachment, prompt: '   ' } }), null);
  assert.equal(peerSender({ kind: 'peer', name: 'apx-web (cole)', body: 'x' }).via, 'drover');
});

test('turns: a queued message is a user turn marked queued, with via and sender; bookkeeping gives none', () => {
  const t = claude.parseTranscriptLine(L(panel));
  assert.deepEqual(t, { role: 'user', ts: ts(3), uuid: 'u-3', text: 'can the board show a rate gauge', meta: false, via: 'queued', queued: true });
  assert.equal(claude.parseTranscriptLine(L(typed)).images, 1);
  assert.deepEqual(['via', 'actor', 'queued'].map((k) => claude.parseTranscriptLine(L(peer))[k]), ['drover', 'owner', true]);
  assert.deepEqual(['via', 'from', 'actor'].map((k) => claude.parseTranscriptLine(L(coordinator))[k]), ['coordinator', 'coordinator', 'coordinator']);
  for (const d of [notice, cont, otherAttachment]) assert.equal(claude.parseTranscriptLine(L(d)), null);
  // A user record from the inbox still reads as before.
  const inbox = claude.parseTranscriptLine(L({ type: 'user', timestamp: ts(1), uuid: 'u-1', isMeta: true, origin: { kind: 'peer', name: 'drover (mcp)', body: 'keep going' }, message: { role: 'user', content: '...' } }));
  assert.deepEqual([inbox.text, inbox.via, inbox.actor, inbox.from, 'queued' in inbox], ['keep going', 'drover', 'mcp', null, false]);
});

test('askFromLines: the owner typing while it ran answers a pending question; a task notice does not', () => {
  const ask = L({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: { questions: [{ question: 'Ship it?', options: [{ label: 'Yes' }] }] } }] } });
  assert.equal(claude.askFromLines([ask, L(notice)]).pendingAsk?.question, 'Ship it?');
  assert.equal(claude.askFromLines([ask, L(panel)]).pendingAsk, null);
});

test('search index and grep: a queued message is user text; its rendered reminder stays meta', () => {
  assert.deepEqual(claudeLine(L(panel)).units, [{ role: 'user', text: 'can the board show a rate gauge' }]);
  assert.deepEqual(claudeLine(L(peer)).units, [{ role: 'user', text: 'pause the rollout' }]);
  assert.deepEqual(claudeLine(L(notice)).units, []);
  assert.equal(claudeLine(L(panel)).cwd, CWD);
  const parts = lineParts(panel, 'subagent');
  assert.deepEqual(parts.map((p) => p.role), ['user', 'meta']);
  assert.equal(parts[0].text, 'can the board show a rate gauge');
  assert.deepEqual(lineParts(notice, 'claude').map((p) => p.role), ['meta']);
});

test('export: a queued message is a user entry marked queued, from naming any other sender; Markdown says so', () => {
  assert.deepEqual(tx.claudeEntries(panel, { sidechain: true }), [{ role: 'user', ts: ts(3), text: 'can the board show a rate gauge', queued: true }]);
  assert.deepEqual(tx.claudeEntries(panel), [], 'a sidechain record in a session file stays out, as any other');
  assert.deepEqual(tx.claudeEntries(peer), [{ role: 'user', ts: ts(6), text: 'pause the rollout', queued: true, from: 'drover (owner)' }]);
  assert.equal(tx.claudeEntries(otherPeer)[0].from, 'builder');
  assert.equal(tx.claudeEntries(coordinator, { sidechain: true })[0].from, 'coordinator');
  assert.deepEqual(tx.claudeEntries(notice), []);
  assert.match(tx.renderText(tx.claudeEntries(typed)), /## user · 2026-11-21 17:00:05Z · sent while it worked\n\nalso check the footer/);
});

// ---------------------------------------------------------------- files and ops
const proj = path.join(tmp, 'claude', 'projects', claude.projectSlug(CWD));
await mkdir(path.join(proj, SID, 'subagents'), { recursive: true });
const sessionFile = path.join(proj, `${SID}.jsonl`);
await writeFile(sessionFile, [
  { type: 'user', timestamp: ts(1), uuid: 'm-1', cwd: CWD, sessionId: SID, message: { role: 'user', content: 'start the review' } },
  { type: 'assistant', timestamp: ts(2), uuid: 'm-2', cwd: CWD, sessionId: SID, message: { content: [{ type: 'tool_use', id: 't1', name: 'Agent', input: { description: 'review the board', subagent_type: 'general-purpose' } }] } },
  typed, notice,
  { type: 'assistant', timestamp: ts(14), uuid: 'm-14', cwd: CWD, sessionId: SID, message: { content: [{ type: 'text', text: 'Footer checked.' }] } },
].map(L).join('\n') + '\n');
const subFile = path.join(proj, SID, 'subagents', `agent-${AGENT}.jsonl`);
await writeFile(subFile, [
  { type: 'user', isSidechain: true, agentId: AGENT, timestamp: ts(2), uuid: 'a-2', cwd: CWD, sessionId: SID, message: { role: 'user', content: 'Review the board layout.' } },
  panel, coordinator,
  { type: 'assistant', isSidechain: true, agentId: AGENT, timestamp: ts(15), uuid: 'a-15', cwd: CWD, sessionId: SID, message: { content: [{ type: 'text', text: 'A gauge fits beside the clock.' }] } },
].map(L).join('\n') + '\n');
await writeFile(subFile.replace(/\.jsonl$/, '.meta.json'), L({ agentType: 'general-purpose', isBuiltIn: true, description: 'review the board', toolUseId: 'toolu_x', spawnDepth: 1, requestShape: 'background', model: 'opus', pickedEffortModel: 'claude-opus-5-5' }));
const DONE = 'a0dd00000000000c2';
const doneFile = path.join(proj, SID, 'subagents', `agent-${DONE}.jsonl`);
await writeFile(doneFile, L({ type: 'assistant', isSidechain: true, agentId: DONE, timestamp: ts(4), message: { content: [{ type: 'text', text: 'Done.' }] } }) + '\n');
await writeFile(doneFile.replace(/\.jsonl$/, '.meta.json'), L({ agentType: 'Explore', description: 'map the files', finished: true }));
// The session is live: a registry entry for this test's own (running) process.
await writeFile(path.join(tmp, 'claude', 'sessions', `${process.pid}.json`), L({ pid: process.pid, sessionId: SID, cwd: CWD, status: 'busy', startedAt: Date.now() }));

await import('./isolate-cache.js');
const api = await import('../core/api.js');
const op = (name, args) => api.dispatch(name, args);

test('sessions.transcript: a subagent by its id shows what the owner typed in its agent panel as a user turn', async () => {
  for (const id of [AGENT, `agent-${AGENT}`, `${SID}/${AGENT}`]) {
    const r = await op('sessions.transcript', { id });
    const users = r.turns.filter((t) => t.role === 'user');
    assert.deepEqual(users.map((t) => [t.text, t.via ?? null, t.queued ?? false]), [['Review the board layout.', null, false], ['can the board show a rate gauge', 'queued', true], ['Coordinator: stop after the tests pass', 'coordinator', true]], id);
  }
  const m = await op('sessions.transcript', { id: AGENT, format: 'messages', as: 'text' });
  assert.match(m.text, /sent while it worked\n\ncan the board show a rate gauge/);
  // The main session's own typing while it ran.
  const s = await op('sessions.transcript', { id: SID });
  assert.deepEqual(s.turns.filter((t) => t.role === 'user').map((t) => [t.text, t.via ?? null]), [['start the review', null], ['also check the footer', 'queued']]);
});

test('subagents: true lists the subagents a session started, with status; sessions.list does too', async () => {
  const r = await op('sessions.transcript', { id: SID, subagents: true, limit: 1 });
  const byId = (a, b) => (a[0] < b[0] ? -1 : 1);
  assert.deepEqual(r.subagents.map((a) => [a.id, a.agentType, a.description, a.status]).sort(byId), [[AGENT, 'general-purpose', 'review the board', 'running'], [DONE, 'Explore', 'map the files', 'finished']].sort(byId));
  assert.ok(r.subagents.every((a) => typeof a.lastActivity === 'string' && a.bytes > 0));
  assert.equal(r.subagents.find((a) => a.id === AGENT).model, 'claude-opus-5-5');
  assert.equal('subagents' in (await op('sessions.transcript', { id: SID })), false, 'only when asked for');
  const e = await op('sessions.transcript', { id: SID, format: 'messages', subagents: true });
  assert.equal(e.subagents.length, 2, 'the export formats take it too');
  const l = await op('sessions.list', { includeRecent: false, subagents: true });
  const mine = l.sessions.find((s) => s.id === SID);
  assert.deepEqual(mine.subagents.map((a) => a.id).sort(), [AGENT, DONE].sort());
  assert.equal('subagents' in ((await op('sessions.list', { includeRecent: false })).sessions.find((s) => s.id === SID)), false);
});

test('sessions.lastReply answers for a subagent id', async () => {
  const r = await op('sessions.lastReply', { id: `agent-${AGENT}` });
  assert.deepEqual([r.kind, r.id, r.parent, r.text, r.name], ['subagent', AGENT, SID, 'A gauge fits beside the clock.', 'review the board']);
  await assert.rejects(op('sessions.lastReply', { id: 'agent-ffffffffffffffff' }), /session not found/);
});

test('grep finds a message typed into a subagent panel as a user hit naming the subagent', { skip: !findRg() && 'no ripgrep' }, async () => {
  const roots = { claude: path.join(tmp, 'claude', 'projects'), codex: path.join(tmp, 'codex', 'sessions') };
  const r = await grepTranscripts({ pattern: 'rate gauge', roles: ['user'] }, { roots, rg: findRg() });
  assert.equal(r.results.length, 1);
  assert.deepEqual([r.results[0].kind, r.results[0].sessionId, r.results[0].agentId, r.results[0].role], ['subagent', SID, AGENT, 'user']);
  assert.match(r.results[0].snippet, /can the board show a rate gauge/);
});
