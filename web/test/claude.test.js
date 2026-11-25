import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Point the adapter at a scratch CLAUDE_CONFIG_DIR before importing it.
const home = await mkdtemp(path.join(tmpdir(), 'drover-cc-'));
process.env.CLAUDE_CONFIG_DIR = home;
await mkdir(path.join(home, 'sessions'), { recursive: true });
const claude = await import('../core/claude.js');

test('projectSlug and transcriptPath follow the ~/.claude/projects layout', () => {
  assert.equal(claude.projectSlug('/Users/alice/code/webapp'), '-Users-alice-code-webapp');
  assert.ok(claude.transcriptPath('/Users/alice/code/webapp', 'abc').endsWith('/projects/-Users-alice-code-webapp/abc.jsonl'));
  // A worktree under .claude/worktrees, an underscore, a space: Claude Code turns each into '-'.
  assert.equal(claude.projectSlug('/home/me/code/app/.claude/worktrees/feat_x'), '-home-me-code-app--claude-worktrees-feat-x');
  assert.equal(claude.projectSlug('/Users/a b/My.App'), '-Users-a-b-My-App');
});

test('parseTranscriptLine handles user text, tool results, assistant text+tools, titles', () => {
  const u = claude.parseTranscriptLine(JSON.stringify({ type: 'user', timestamp: 't', uuid: '1', message: { role: 'user', content: 'hello' } }));
  assert.deepEqual(u, { role: 'user', ts: 't', uuid: '1', text: 'hello', meta: false });
  const tr = claude.parseTranscriptLine(JSON.stringify({ type: 'user', timestamp: 't', uuid: '2', message: { role: 'user', content: [{ type: 'tool_result', content: 'out', is_error: true }] } }));
  assert.equal(tr.role, 'tool_result'); assert.match(tr.text, /^\[error\] out/);
  const a = claude.parseTranscriptLine(JSON.stringify({ type: 'assistant', timestamp: 't', uuid: '3', requestedModel: 'm', message: { content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'Reply' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }));
  assert.equal(a.role, 'assistant'); assert.equal(a.text, 'Reply'); assert.equal(a.tools[0].name, 'Bash'); assert.equal(a.model, 'm');
  const th = claude.parseTranscriptLine(JSON.stringify({ type: 'assistant', timestamp: 't', uuid: '4', message: { content: [{ type: 'thinking', thinking: 'x' }] } }));
  assert.equal(th.role, 'thinking');
  assert.equal(claude.parseTranscriptLine('garbage'), null);
  assert.equal(claude.parseTranscriptLine(JSON.stringify({ type: 'attachment' })), null);
});

test('readTranscript tails incrementally by byte offset', async () => {
  const f = path.join(home, 'x.jsonl');
  const line = (i) => JSON.stringify({ type: 'user', timestamp: String(i), uuid: String(i), message: { role: 'user', content: `m${i}` } }) + '\n';
  await writeFile(f, line(1) + line(2));
  const r1 = await claude.readTranscript(f);
  assert.deepEqual(r1.turns.map((t) => t.text), ['m1', 'm2']);
  await writeFile(f, line(1) + line(2) + line(3));
  const r2 = await claude.readTranscript(f, { since: r1.offset });
  assert.deepEqual(r2.turns.map((t) => t.text), ['m3']);
  const r3 = await claude.readTranscript(f, { since: 999999 });
  assert.equal(r3.turns.length, 3, 'offset past EOF rereads from the start');
});

test('sendToSession writes auth + user frames to the inbox socket', async () => {
  const sock = path.join(tmpdir(), `drover-t-${process.pid}.sock`);
  const received = [];
  const srv = createServer((c) => { c.setEncoding('utf8'); c.on('data', (d) => received.push(...d.split('\n').filter(Boolean))); c.on('end', () => c.end()); });
  await new Promise((r) => srv.listen(sock, r));
  const sha = createHash('sha256').update(path.resolve(sock)).digest('hex');
  await writeFile(path.join(home, 'sessions', `${process.pid}.${sha}.key`), JSON.stringify({ peerToken: 'ab'.repeat(16) }));
  const transcript = path.join(home, 'bypass.jsonl');
  await writeFile(transcript, JSON.stringify({ type: 'permission-mode', permissionMode: 'bypassPermissions' }) + '\n');
  const session = { pid: process.pid, socket: sock, alive: true, status: 'busy', transcript };
  const r = await claude.sendToSession(session, 'ping from test', { fromName: 'drover (test)' });
  srv.close();
  assert.deepEqual(r, { ok: true, authed: true, targetMode: 'bypassPermissions', declaredMode: 'bypass', queuedBehindTurn: true });
  assert.equal(received.length, 2);
  assert.deepEqual(JSON.parse(received[0]), { type: 'auth', token: 'ab'.repeat(16) });
  assert.deepEqual(JSON.parse(received[1]), { type: 'user', message: { role: 'user',
    content: '<cross-session-message from-name="drover (test)" from-mode="bypass">\nping from test\n</cross-session-message>' } });
});

test('sendToSession refuses dead or socketless sessions and empty text', async () => {
  await assert.rejects(claude.sendToSession({ pid: 1, socket: null, alive: true }, 'x'), /no messaging socket/);
  await assert.rejects(claude.sendToSession({ pid: 1, socket: '/nope', alive: false }, 'x'), /not alive/);
  await assert.rejects(claude.sendToSession({ pid: 1, socket: '/nope', alive: true }, '  '), /empty message/);
});


test('lastAssistantText: read from the tail, and further back when the tail is all tool calls', async () => {
  const { lastAssistantText } = await import('../core/claude.js');
  const dir = await mkdtemp(path.join(tmpdir(), 'drover-last-'));
  const said = (text, ts) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { role: 'assistant', model: 'm', content: [{ type: 'text', text }] } });
  const tool = (n) => JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:09Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${n}`, name: 'Bash', input: { command: 'x'.repeat(300) } }] } });
  const result = (n) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${n}`, content: 'é'.repeat(200) }] } });
  const run = (n) => Array.from({ length: n }, (_, i) => `${tool(i)}\n${result(i)}`).join('\n');
  const write = async (name, lines) => { const f = path.join(dir, name); await writeFile(f, `${lines.join('\n')}\n`); return f; };
  // In the tail: found on the first read.
  const near = await write('near.jsonl', [said('first words', '2026-01-01T00:00:01Z'), run(2), said('the last words', '2026-01-01T00:00:02Z')]);
  assert.deepEqual(await lastAssistantText(near, { tailBytes: 2000 }), { text: 'the last words', ts: '2026-01-01T00:00:02Z', model: 'm' });
  // Behind a long run of tool calls (about 40 KB, multi-byte output): the read goes further back and finds it.
  const far = await write('far.jsonl', [said('older', '2026-01-01T00:00:01Z'), said('what it said before the long run', '2026-01-01T00:00:03Z'), run(40)]);
  assert.equal((await lastAssistantText(far, { tailBytes: 2000 }))?.text, 'what it said before the long run');
  for (const tailBytes of [1500, 1777, 2048, 3001, 5000]) assert.equal((await lastAssistantText(far, { tailBytes }))?.text, 'what it said before the long run', `wherever the read begins (${tailBytes})`);
  // A bound on how far: past maxBytes it gives up, as before.
  assert.equal(await lastAssistantText(far, { tailBytes: 2000, maxBytes: 8000 }), null);
  // Nothing said at all, a missing file, no file.
  assert.equal(await lastAssistantText(await write('none.jsonl', [run(3)]), { tailBytes: 500 }), null);
  assert.equal(await lastAssistantText(path.join(dir, 'missing.jsonl')), null);
  assert.equal(await lastAssistantText(null), null);
});

test('findSession answers a live session from the registry without listing every session', async () => {
  const live = { sessionId: 'aaaa-1111', name: 'voice', pid: 4242, alive: true };
  let fullLists = 0;
  const sessions = async () => { fullLists++; return [live]; };
  const registry = async () => [{ sessionId: 'aaaa-0000', name: 'voice', pid: 1, alive: false }, live];
  for (const q of ['aaaa-1111', 'voice', 'aaaa-1']) {
    assert.equal(await claude.findSession(q, { registry, sessions, windows: async () => [] }), live, q);
  }
  assert.equal(fullLists, 0, 'the claude agents listing is not needed for a running registry hit');
});

test('findSession falls back to the full list for sessions the registry does not run', async () => {
  const ended = { sessionId: 'bbbb-2222', name: 'old', pid: 7, alive: false };
  const cliOnly = { sessionId: 'cccc-3333', name: 'cli', pid: null, alive: true, fromCli: true };
  let fullLists = 0;
  const registry = async () => [ended];
  const sessions = async () => { fullLists++; return [ended, cliOnly]; };
  assert.equal(await claude.findSession('cli', { registry, sessions, windows: async () => [] }), cliOnly);
  assert.equal(await claude.findSession('old', { registry, sessions, windows: async () => [] }), ended);
  assert.equal(await claude.findSession('nope', { registry, sessions, windows: async () => [] }), null);
  assert.equal(fullLists, 3);
});
