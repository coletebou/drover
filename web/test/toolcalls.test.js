// Tool calls and results as a chat shows them (core/toolcalls.js, and the transcript turns built with it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolSummary, toolDescription, resultEntry, resultText, oneLine, RESULT_MAX, codexOutputFailed } from '../core/toolcalls.js';
import * as claude from '../core/claude.js';

test('toolSummary names what a call did, per tool', () => {
  const home = process.env.HOME;
  assert.equal(toolSummary('Bash', { command: 'npm test\n# second line', description: 'Run tests' }), 'npm test');
  assert.equal(toolSummary('Read', { file_path: '/Users/demo/code/x/a.js' }), '~/code/x/a.js');
  assert.equal(toolSummary('Edit', { file_path: '/home/demo/code/x/b.js', old_string: 'a', new_string: 'b' }), '~/code/x/b.js');
  assert.equal(toolSummary('Write', { file_path: 'notes.md', content: 'hello' }), 'notes.md');
  assert.equal(toolSummary('Grep', { pattern: 'TODO', path: 'web/core' }), '"TODO" in web/core');
  assert.equal(toolSummary('Glob', { pattern: '**/*.swift' }), '**/*.swift');
  assert.equal(toolSummary('WebFetch', { url: 'https://example.com/a', prompt: 'p' }), 'https://example.com/a');
  assert.equal(toolSummary('WebSearch', { query: 'swift ui windows' }), 'swift ui windows');
  assert.equal(toolSummary('Task', { description: 'Explore the board', subagent_type: 'Explore', prompt: 'long' }), 'Explore the board (Explore)');
  assert.equal(toolSummary('TodoWrite', { todos: [{}, {}, {}] }), '3 items');
  assert.equal(toolSummary('AskUserQuestion', { questions: [{ question: 'Which one?' }] }), 'Which one?');
  assert.equal(toolSummary('mcp__drover__drover_sessions', { host: 'demo-box' }), 'demo-box');
  assert.equal(toolSummary('shell', { command: ['bash', '-lc', 'git status'] }), 'git status');
  assert.equal(toolSummary('exec_command', { cmd: 'ls -la' }), 'ls -la');
  assert.equal(toolSummary('apply_patch', '*** Begin Patch\n*** Update File: a.js\n*** Add File: b.js\n*** End Patch'), 'a.js, b.js');
  assert.equal(toolSummary('Unknown', { anything: 'first string' }), 'first string');
  assert.equal(toolSummary('Unknown', null), '');
  assert.ok(!toolSummary('Bash', { command: `cat ${home}/x` }).includes(home), 'home dirs read as ~');
});

test('toolSummary is one bounded line with secrets redacted', () => {
  const s = toolSummary('Bash', { command: `curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789" https://x/${'a'.repeat(400)}` });
  assert.ok(s.length <= 200);
  assert.ok(!s.includes('abcdefghijklmnopqrstuvwxyz0123456789'));
  assert.equal(oneLine('  \n  second  line \n third'), 'second line');
});

test('toolDescription is Bash only', () => {
  assert.equal(toolDescription('Bash', { command: 'ls', description: 'List files' }), 'List files');
  assert.equal(toolDescription('Read', { file_path: 'a', description: 'x' }), null);
  assert.equal(toolDescription('Bash', { command: 'ls' }), null);
});

test('resultEntry keeps the output, cut, with its full length and error flag', () => {
  assert.deepEqual(resultEntry('t1', 'ok'), { toolUseId: 't1', isError: false, text: 'ok', chars: 2 });
  const long = resultEntry('t2', 'x'.repeat(RESULT_MAX + 50), { isError: true });
  assert.equal(long.text.length, RESULT_MAX); assert.equal(long.chars, RESULT_MAX + 50); assert.equal(long.isError, true);
  assert.equal(resultText([{ type: 'text', text: 'a' }, { type: 'image', source: {} }, { type: 'text', text: 'b' }]), 'a\n[image]\nb');
  assert.equal(codexOutputFailed('Process exited with code 1\nOutput:'), true);
  assert.equal(codexOutputFailed('Process exited with code 0'), false);
  assert.equal(codexOutputFailed('no code line'), false);
});

test('parseTranscriptLine gives each call an id and summary and each result its call id', () => {
  const a = claude.parseTranscriptLine(JSON.stringify({ type: 'assistant', timestamp: 't', uuid: 'a1', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test', description: 'Run the tests' } }] } }));
  assert.deepEqual(a.tools, [{ id: 'toolu_1', name: 'Bash', input: { command: 'npm test', description: 'Run the tests' }, summary: 'npm test', description: 'Run the tests' }]);
  assert.equal(a.text, '');
  const r = claude.parseTranscriptLine(JSON.stringify({ type: 'user', timestamp: 't', uuid: 'u1', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'all green' }], is_error: false }] } }));
  assert.equal(r.role, 'tool_result');
  assert.deepEqual(r.results, [{ toolUseId: 'toolu_1', isError: false, text: 'all green', chars: 9 }]);
  assert.equal(r.text, 'all green', 'the short text older clients read stays');
});

test('a message relayed through the inbox reads as what was said, not as a meta turn', () => {
  const env = '<cross-session-message from-name="drover (owner)" from-mode="bypass">\nship it\n</cross-session-message>';
  const viaDrover = claude.parseTranscriptLine(JSON.stringify({ type: 'user', timestamp: 't', uuid: 'p1', isMeta: true, origin: { kind: 'peer', name: 'drover (owner)', body: 'ship it' }, message: { role: 'user', content: `Another Claude session sent a message:\n${env}` } }));
  assert.deepEqual([viaDrover.role, viaDrover.text, viaDrover.meta, viaDrover.via, viaDrover.actor], ['user', 'ship it', false, 'drover', 'owner']);
  const peer = claude.parseTranscriptLine(JSON.stringify({ type: 'user', timestamp: 't', uuid: 'p2', isMeta: true, origin: { kind: 'peer', name: 'demo-review', body: 'done' }, message: { role: 'user', content: 'x' } }));
  assert.deepEqual([peer.via, peer.from, peer.text], ['peer', 'demo-review', 'done']);
  const img = claude.parseTranscriptLine(JSON.stringify({ type: 'user', timestamp: 't', uuid: 'i1', message: { content: [{ type: 'text', text: 'look' }, { type: 'image', source: {} }] } }));
  assert.equal(img.images, 1);
});
