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

test('interactiveArgv composes profile, model, resume, prompt; the resume id is bound and the prompt follows --', () => {
  const argv = claude.interactiveArgv({ argv: ['--dangerously-skip-permissions'] }, { model: 'opus', resume: 'abc', prompt: 'go' });
  assert.deepEqual(argv, ['claude', '--dangerously-skip-permissions', '--model', 'opus', '--resume=abc', '--', 'go']);
});
