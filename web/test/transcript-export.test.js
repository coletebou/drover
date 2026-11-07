// core/transcript-export.js (the messages, calls, full and raw views of Claude Code, Codex and OpenClaw transcripts)
// and the sessions.transcript / transcripts.list ops over it. Scratch Claude, Codex and OpenClaw homes; nothing here
// reads the user's sessions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';

const tmp = await mkdtemp(path.join(tmpdir(), 'drover-tx-'));
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
await writeFile(path.join(bin, 'claude'), '#!/bin/sh\necho "[]"\n');
await writeFile(path.join(bin, 'codex'), '#!/bin/sh\nexit 1\n');
for (const b of ['claude', 'codex']) await chmod(path.join(bin, b), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;

const tx = await import('../core/transcript-export.js');

const L = (o) => JSON.stringify(o);
const ts = (n) => `2026-11-03T10:00:${String(n).padStart(2, '0')}.000Z`;

// ---------------------------------------------------------------- Claude Code
const SID = '0aaaaaaa-0000-4000-8000-00000000000a';
const claudeRecords = [
  { type: 'permission-mode', permissionMode: 'bypassPermissions' },
  { type: 'user', timestamp: ts(1), origin: { kind: 'human' }, message: { role: 'user', content: 'fix the bug<system-reminder>injected</system-reminder>' } },
  { type: 'user', timestamp: ts(2), isMeta: true, message: { role: 'user', content: 'Base directory for this skill: /x' } },
  { type: 'user', timestamp: ts(3), message: { role: 'user', content: '<command-name>/reflect</command-name>' } },
  { type: 'assistant', timestamp: ts(4), message: { model: 'claude-opus-5-5', content: [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test', description: 'Run tests' } }] } },
  { type: 'user', timestamp: ts(5), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: [{ type: 'text', text: 'FAIL 1 test' }] }] } },
  { type: 'assistant', timestamp: ts(6), message: { content: [{ type: 'tool_use', id: 'tu2', name: 'mcp__drover__drover_sessions_lastReply', input: { id: '3c6fead1-4abe-4b5f-b984-28071aeb9dc0' } }] } },
  { type: 'user', timestamp: ts(7), isMeta: true, origin: { kind: 'peer', name: 'drover (mcp)', body: 'keep going' }, message: { role: 'user', content: 'Another Claude session sent a message: ...' } },
  { type: 'user', timestamp: ts(8), isSidechain: true, message: { role: 'user', content: 'inline subagent task' } },
  { type: 'user', timestamp: ts(9), isCompactSummary: true, message: { role: 'user', content: 'Summary of earlier work.' } },
  { type: 'assistant', timestamp: ts(10), message: { content: [{ type: 'text', text: 'Fixed.' }] } },
];

test('claudeEntries: typed text without reminders, peers with their sender, calls, results, summaries; meta, commands and sidechains left out', () => {
  const all = claudeRecords.flatMap((d) => tx.claudeEntries(d));
  assert.deepEqual(all.map((e) => e.role), ['user', 'assistant', 'tool', 'result', 'tool', 'user', 'summary', 'assistant']);
  assert.equal(all[0].text, 'fix the bug');
  assert.equal(all[1].model, 'claude-opus-5-5');
  assert.deepEqual(all[2].input, { command: 'npm test', description: 'Run tests' });
  assert.equal(all[3].isError, true); assert.equal(all[3].text, 'FAIL 1 test'); assert.equal(all[3].id, 'tu1');
  assert.deepEqual([all[5].text, all[5].from], ['keep going', 'drover (mcp)']);
  assert.equal(all[6].text, 'Summary of earlier work.');
  // A subagent's own file marks every record a sidechain: read with sidechain set, it is kept.
  assert.equal(tx.claudeEntries(claudeRecords[8], { sidechain: true })[0].text, 'inline subagent task');
});

test('project: messages, calls and full keep growing layers; brief calls are one line and keep ids readable', () => {
  const all = claudeRecords.flatMap((d) => tx.claudeEntries(d));
  assert.equal(tx.project(all, 'messages').length, 5);
  assert.equal(tx.project(all, 'calls').length, 7);
  assert.equal(tx.project(all, 'full').length, 8);
  const brief = tx.project(all, 'calls', { callStyle: 'brief' }).filter((e) => e.role === 'tool');
  assert.equal(brief[0].summary, 'npm test');
  assert.equal('input' in brief[0], false);
  assert.match(brief[1].summary, /3c6fead1-4abe-4b5f-b984-28071aeb9dc0/, 'a call whose one argument is an id shows the id, not [redacted]');
  assert.equal(tx.briefLine('Bash', { command: 'curl -H "Authorization: Bearer sk-ant-abcdefghijklmnopqrstuvwxyz012345"' }).includes('sk-ant-abcdefghijklmnop'), false, 'secrets stay redacted');
});

const projects = path.join(tmp, 'claude', 'projects', '-work-repo');
await mkdir(path.join(projects, SID, 'subagents'), { recursive: true });
const sessionFile = path.join(projects, `${SID}.jsonl`);
await writeFile(sessionFile, claudeRecords.map(L).join('\n') + '\n');
const AGENT = 'a0179533ce7a686ae';
const subFile = path.join(projects, SID, 'subagents', `agent-${AGENT}.jsonl`);
await writeFile(subFile, [
  { type: 'user', isSidechain: true, agentId: AGENT, timestamp: ts(20), message: { role: 'user', content: 'Review the diff.' } },
  { type: 'assistant', isSidechain: true, agentId: AGENT, timestamp: ts(21), message: { content: [{ type: 'text', text: 'No findings.' }] } },
].map(L).join('\n') + '\n');
await writeFile(subFile.replace(/\.jsonl$/, '.meta.json'), L({ agentType: 'code-reviewer', description: 'review the diff', model: 'opus', finished: true }));

test('readEntries pages by bytes and by count, and the pages add up to one read exactly', async () => {
  const one = await tx.readEntries(sessionFile, 'claude', { format: 'full' });
  assert.equal(one.more, false); assert.equal(one.offset, one.bytes);
  for (const page of [{ maxBytes: 1 }, { limit: 1 }, { maxBytes: 200 }]) {
    const got = []; let since = 0, n = 0;
    for (;;) { const r = await tx.readEntries(sessionFile, 'claude', { format: 'full', since, ...page }); got.push(...r.entries); n++; since = r.offset; if (!r.more) break; assert.ok(n < 50); }
    assert.deepEqual(got, one.entries, JSON.stringify(page));
  }
});

test('a last record still being written is held back until it is whole', async () => {
  const f = path.join(tmp, 'growing.jsonl');
  const whole = L(claudeRecords[1]) + '\n';
  const last = L(claudeRecords[10]);
  await writeFile(f, whole + last.slice(0, 20));
  const r1 = await tx.readEntries(f, 'claude', { format: 'messages' });
  assert.deepEqual(r1.entries.map((e) => e.text), ['fix the bug']);
  assert.equal(r1.offset, Buffer.byteLength(whole));
  await appendFile(f, last.slice(20) + '\n');
  const r2 = await tx.readEntries(f, 'claude', { format: 'messages', since: r1.offset });
  assert.deepEqual(r2.entries.map((e) => e.text), ['Fixed.']);
  // No newline after a whole last record (a finished file): it is read.
  const g = path.join(tmp, 'no-newline.jsonl');
  await writeFile(g, whole + last);
  assert.equal((await tx.readEntries(g, 'claude', { format: 'messages' })).entries.length, 2);
});

test('readRaw returns the bytes as they are, in whole lines, paged', async () => {
  const { readFile } = await import('node:fs/promises');
  const want = await readFile(sessionFile, 'utf8');
  let since = 0, got = '', pages = 0;
  for (;;) { const r = await tx.readRaw(sessionFile, { since, maxBytes: 300 }); got += r.jsonl; pages++; since = r.offset; if (!r.more) break; }
  assert.equal(got, want);
  assert.ok(pages > 1);
});

test('claudeHead says what a run is: a session, a headless run, a reflection by prompt or by its temp dir', async () => {
  assert.deepEqual(await tx.claudeHead(sessionFile), { cwd: null, entrypoint: null, kind: 'session', firstPrompt: 'fix the bug' });
  const h = path.join(tmp, 'head.jsonl');
  await writeFile(h, [{ type: 'attachment', cwd: '/tmp/reflector-x1', entrypoint: 'sdk-cli' }, { type: 'user', cwd: '/tmp/reflector-x1', entrypoint: 'sdk-cli', message: { role: 'user', content: 'Something else' } }].map(L).join('\n') + '\n');
  assert.equal((await tx.claudeHead(h)).kind, 'reflection');
  await writeFile(h, [{ type: 'user', cwd: '/repo', entrypoint: 'sdk-cli', message: { role: 'user', content: 'You keep the durable record of one AI coding session: ...' } }].map(L).join('\n') + '\n');
  assert.equal((await tx.claudeHead(h)).kind, 'reflection');
  await writeFile(h, [{ type: 'user', cwd: '/repo', entrypoint: 'sdk-cli', message: { role: 'user', content: 'do a thing' } }].map(L).join('\n') + '\n');
  assert.equal((await tx.claudeHead(h)).kind, 'headless');
});

// ---------------------------------------------------------------- Codex
const THREAD = '019ab7d9-f7bd-74f2-bdd7-44f5c32ee2c9';
const rolloutDir = path.join(tmp, 'codex', 'sessions', '2026', '11', '03');
await mkdir(rolloutDir, { recursive: true });
const rollout = path.join(rolloutDir, `rollout-2026-11-03T10-00-00-${THREAD}.jsonl`);
await writeFile(rollout, [
  { type: 'session_meta', timestamp: ts(0), payload: { id: THREAD, cwd: '/repo', originator: 'codex_exec' } },
  { type: 'response_item', timestamp: ts(1), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context><cwd>/repo</cwd></environment_context>' }] } },
  { type: 'response_item', timestamp: ts(2), payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'instructions' }] } },
  { type: 'response_item', timestamp: ts(3), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list files' }] } },
  { type: 'event_msg', timestamp: ts(3), payload: { type: 'user_message', message: 'list files' } },
  { type: 'response_item', timestamp: ts(4), payload: { type: 'function_call', name: 'shell_command', call_id: 'c1', arguments: L({ command: 'ls', workdir: '/repo' }) } },
  { type: 'response_item', timestamp: ts(5), payload: { type: 'function_call_output', call_id: 'c1', output: 'Process exited with code 2\nno such dir' } },
  { type: 'response_item', timestamp: ts(6), payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c2', input: '*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch' } },
  { type: 'response_item', timestamp: ts(7), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] } },
].map(L).join('\n') + '\n');

test('codexEntries: the prompt (not injected context or developer text), calls with parsed input, failed outputs, replies', async () => {
  assert.equal(await tx.sniffEngine(rollout), 'codex');
  const r = await tx.readEntries(rollout, 'codex', { format: 'full' });
  assert.deepEqual(r.entries.map((e) => e.role), ['user', 'tool', 'result', 'tool', 'assistant']);
  assert.equal(r.entries[0].text, 'list files');
  assert.deepEqual(r.entries[1].input, { command: 'ls', workdir: '/repo' });
  assert.equal(r.entries[2].isError, true);
  assert.equal(tx.project(r.entries, 'calls', { callStyle: 'brief' })[2].summary, 'a.txt');
  assert.deepEqual(await tx.codexHead(rollout), { cwd: '/repo', originator: 'codex_exec', kind: 'exec' });
});

// ---------------------------------------------------------------- OpenClaw
const store = path.join(tmp, 'openclaw', 'agents', 'main', 'agent', 'openclaw-agent.sqlite');
await mkdir(path.dirname(store), { recursive: true });
await writeFile(path.join(tmp, 'openclaw', 'openclaw.json'), '{}');
{
  const db = new DatabaseSync(store);
  db.exec(`create table session_nodes (session_key text primary key, current_session_id text, created_via text, category text, label text);
    create table session_windows (session_id text primary key, session_key text, reason text, created_at integer, started_at integer, ended_at integer, status text, model text, display_name text);
    create table transcript_events (session_id text, seq integer, event_json text, created_at integer, event_zstd blob, event_utf8_bytes integer, primary key (session_id, seq));`);
  const now = Date.now();
  const win = db.prepare('insert into session_windows (session_id, session_key, created_at, started_at, model) values (?, ?, ?, ?, ?)');
  win.run('w-chat-1', 'agent:main:openai-user:drover:cole', now - 3000, now - 3000, 'gpt');
  win.run('w-chat-2', 'agent:main:openai-user:drover:cole', now - 2000, now - 2000, 'gpt');   // the same conversation after a rollover
  win.run('w-thread', 'agent:main:openai-user:drover:cole:win-1', now - 1500, now - 1500, 'gpt');
  win.run('w-beat', 'agent:main:main:heartbeat', now - 1000, now - 1000, 'gpt');
  const ev = db.prepare('insert into transcript_events (session_id, seq, event_json, created_at, event_zstd, event_utf8_bytes) values (?, ?, ?, ?, ?, ?)');
  const put = (sid, seq, o, zstd = false) => { const j = L(o); ev.run(sid, seq, zstd ? null : j, now, zstd ? zlib.zstdCompressSync(Buffer.from(j)) : null, zstd ? Buffer.byteLength(j) : null); };
  put('w-chat-1', 1, { type: 'session', id: 'w-chat-1' });
  put('w-chat-1', 2, { type: 'message', timestamp: ts(1), message: { role: 'user', content: 'what is waiting?' } });
  put('w-chat-1', 3, { type: 'message', timestamp: ts(2), message: { role: 'assistant', model: 'gpt', content: [{ type: 'thinking', thinking: 'x' }, { type: 'toolCall', id: 'k1', name: 'tool_call', arguments: { id: 'mcp:drover:drover__drover_fleet_summary', args: { fresh: true } } }] } }, true);
  put('w-chat-1', 4, { type: 'message', timestamp: ts(3), message: { role: 'toolResult', toolCallId: 'k1', toolName: 'tool_call', content: [{ type: 'text', text: '2 waiting' }] } });
  put('w-chat-2', 1, { type: 'message', timestamp: ts(4), message: { role: 'assistant', content: [{ type: 'text', text: 'Two sessions wait on you.' }] } });
  put('w-thread', 1, { type: 'message', timestamp: ts(5), message: { role: 'user', content: 'window question' } });
  put('w-beat', 1, { type: 'message', timestamp: ts(6), message: { role: 'user', content: '[OpenClaw heartbeat poll]', provenance: { kind: 'internal_system', sourceTool: 'heartbeat' } } });
  put('w-beat', 2, { type: 'custom', customType: 'model-snapshot' });
  db.close();
}

test('openclaw: windows with their kinds, entries across a rollover (zstd events too), the tool_call wrapper unwrapped, raw events', async () => {
  const wins = await tx.openclawWindows(store, { agent: 'main' });
  assert.deepEqual(Object.fromEntries(wins.map((w) => [w.sessionId, w.kind])), { 'w-beat': 'heartbeat', 'w-thread': 'manager', 'w-chat-2': 'manager', 'w-chat-1': 'manager' });
  const ids = await tx.openclawSessionIds(store, { key: 'agent:main:openai-user:drover:cole' });
  assert.deepEqual(ids, ['w-chat-1', 'w-chat-2']);
  const r = await tx.readOpenclaw(store, ids, { format: 'full' });
  assert.deepEqual(r.entries.map((e) => e.role), ['user', 'tool', 'result', 'assistant']);
  assert.deepEqual([r.entries[1].name, r.entries[1].input], ['mcp:drover:drover__drover_fleet_summary', { fresh: true }]);
  assert.equal(r.events, 5);
  // Paged one entry at a time, the pages add up to the one read.
  const got = []; let since = 0;
  for (;;) { const p = await tx.readOpenclaw(store, ids, { format: 'full', since, limit: 1 }); got.push(...p.entries); since = p.offset; if (!p.more) break; }
  assert.deepEqual(got, r.entries);
  const raw = await tx.readOpenclaw(store, ids, { format: 'raw' });
  assert.equal(raw.records, 5);
  assert.equal(JSON.parse(raw.jsonl.split('\n')[2]).message.content[1].name, 'tool_call', 'raw keeps the event as stored, decompressed');
  const beat = await tx.readOpenclaw(store, ['w-beat'], { format: 'messages' });
  assert.deepEqual(beat.entries.map((e) => [e.text, e.from]), [['[OpenClaw heartbeat poll]', 'heartbeat']]);
});

test('renderText: headings per message, a fenced call input, a fence longer than any backtick run in an output', () => {
  const t = tx.renderText([
    { role: 'user', ts: ts(1), text: 'hi', from: 'drover (mcp)' },
    { role: 'tool', name: 'Bash', input: { command: 'ls' } },
    { role: 'result', text: 'has ``` inside', isError: true },
  ]);
  assert.match(t, /^## user · 2026-11-03 10:00:01Z · from drover \(mcp\)\n\nhi\n/);
  assert.match(t, /→ Bash\n```json\n\{\n {2}"command": "ls"\n\}\n```/);
  assert.match(t, /← result \(error\)\n````\nhas ``` inside\n````/);
});

// ---------------------------------------------------------------- the ops
await import('./isolate-cache.js');
const api = await import('../core/api.js');
const T = (args) => api.dispatch('sessions.transcript', args);

test('sessions.transcript resolves a finished session, a subagent in every id form, a Codex thread and a transcript path', async () => {
  const s = await T({ id: SID, format: 'messages' });
  assert.deepEqual([s.engine, s.kind, s.id, s.entries.length], ['claude', 'session', SID, 5]);
  for (const id of [AGENT, `agent-${AGENT}`, `${SID}/${AGENT}`, subFile]) {
    const r = await T({ id, format: 'messages' });
    assert.deepEqual([r.kind, r.id, r.parent, r.entries.map((e) => e.text)], ['subagent', AGENT, SID, ['Review the diff.', 'No findings.']], id);
  }
  assert.equal((await T({ id: AGENT, format: 'messages' })).meta.agentType, 'code-reviewer');
  assert.equal((await T({ id: AGENT })).turns.length, 2, 'turns reads a subagent through its file');
  const c = await T({ id: rollout, format: 'calls', callStyle: 'brief' });
  assert.deepEqual([c.engine, c.kind, c.id], ['codex', 'thread', THREAD]);
  const text = await T({ id: SID, format: 'calls', as: 'text' });
  assert.equal(text.count, 7); assert.equal('entries' in text, false); assert.match(text.text, /→ Bash/);
  const raw = await T({ id: SID, format: 'raw', maxBytes: 100 });
  assert.equal(raw.more, true); assert.ok(raw.records >= 1);
});

test('sessions.transcript reads a path only under the Claude projects or Codex sessions dir, symlinks resolved first', async () => {
  const outside = path.join(tmp, 'elsewhere.jsonl');
  await writeFile(outside, claudeRecords.map(L).join('\n') + '\n');
  await assert.rejects(T({ id: outside, format: 'raw' }), /must be under/);
  const link = path.join(tmp, 'claude', 'projects', '-work-repo', 'escape.jsonl');
  await symlink(outside, link);
  await assert.rejects(T({ id: link, format: 'raw' }), /must be under/);
  await assert.rejects(T({ id: path.join(tmp, 'claude', 'projects', '-work-repo', 'notes.txt'), format: 'raw' }), /\.jsonl/);
  await assert.rejects(T({ id: SID, format: 'everything' }), /format must be one of/);
});

test('sessions.transcript: manager and its threads map to their OpenClaw sessions; openclaw:<id or key> reads any run', async () => {
  const main = await T({ id: 'manager', format: 'messages' });
  assert.deepEqual([main.engine, main.kind, main.thread], ['openclaw', 'manager', 'main']);
  assert.deepEqual(main.entries.map((e) => e.text), ['what is waiting?', 'Two sessions wait on you.']);
  const thread = await T({ id: 'manager', thread: 'win-1', format: 'messages' });
  assert.deepEqual(thread.entries.map((e) => e.text), ['window question']);
  const none = await T({ id: 'manager', thread: 'never-used', format: 'messages' });
  assert.deepEqual(none.entries, []);
  assert.equal((await T({ id: 'openclaw:w-beat', format: 'messages' })).entries[0].from, 'heartbeat');
  assert.equal((await T({ id: 'openclaw:agent:main:main:heartbeat', format: 'raw' })).records, 2);
  await assert.rejects(T({ id: 'openclaw:w-beat' }), /format messages, calls, full or raw/);
});

test('transcripts.list: sessions, subagents with their meta, Codex exec, OpenClaw runs; kind filters on the head', async () => {
  const r = await api.dispatch('transcripts.list', { days: 1, limit: 100 });
  const by = Object.fromEntries(r.transcripts.map((t) => [t.id, t]));
  assert.equal(by[SID].kind, 'session');
  assert.deepEqual([by[AGENT].kind, by[AGENT].parent, by[AGENT].agentType], ['subagent', SID, 'code-reviewer']);
  assert.deepEqual([by[THREAD].kind, by[THREAD].originator], ['exec', 'codex_exec']);
  assert.equal(by['openclaw:w-beat'].kind, 'heartbeat');
  assert.deepEqual((await api.dispatch('transcripts.list', { kind: 'exec' })).transcripts.map((t) => t.id), [THREAD]);
  assert.deepEqual((await api.dispatch('transcripts.list', { parent: SID })).transcripts.map((t) => t.id), [AGENT]);
  assert.ok((await api.dispatch('transcripts.list', { engine: 'openclaw' })).transcripts.every((t) => t.engine === 'openclaw'));
});
