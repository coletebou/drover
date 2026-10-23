// The chat rendering rule: tool calls grouped with their results, Markdown text, user turns named, meta hidden,
// no turn twice. Synthetic fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chatItems, toolGroupLabel, markdownBlocks, inlineSpans, resultPreview } from '../lib/chat.js';
import { normalizeTurns, mergeTranscript, dedupeTurns } from '../lib/transcript.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/sessions-transcript-tools.json', import.meta.url), 'utf8'));

test('normalizeTurns keeps tool calls and results', () => {
  const t = normalizeTurns(fx.turns);
  const read = t.find((x) => x.uuid === 'u-4');
  assert.deepEqual(read.tools, ['Read']);
  assert.deepEqual(read.calls, [{ id: 'toolu_1', name: 'Read', summary: '~/src/parser.js', description: null }]);
  const res = t.find((x) => x.uuid === 'u-5');
  assert.equal(res.role, 'tool');
  assert.deepEqual(res.results[0], { toolUseId: 'toolu_1', isError: false, text: '1\texport function parse(text) {\n2\t  const tokens = tokenize(text);\n3\t}', chars: 60 });
  assert.equal(t.find((x) => x.uuid === 'u-13').via, 'drover');
  assert.equal(t.find((x) => x.uuid === 'u-12').meta, true);
  assert.ok(!t.some((x) => x.role === 'thinking'));
});

test('a run of tool calls is one group, results attached by id, errors marked', () => {
  const items = chatItems(normalizeTurns(fx.turns));
  assert.deepEqual(items.map((i) => i.type), ['user', 'assistant', 'tools', 'assistant', 'tools', 'user', 'user', 'user']);
  const g = items[2];
  assert.equal(g.label, 'Read 1 file, searched 1 time, ran 1 command');
  assert.equal(g.error, true);
  assert.deepEqual(g.calls.map((c) => [c.name, c.summary, c.result?.isError]), [['Read', '~/src/parser.js', false], ['Grep', '"throw new Error" in src', false], ['Bash', 'npm test', true]]);
  assert.equal(g.calls[2].description, 'Run the unit tests');
  assert.equal(g.calls[2].result.text, '✖ lexer reports the line\nℹ tests 2\nℹ fail 1');
  // Text and tools in one turn: the text, then its calls.
  assert.equal(items[3].text, 'One test fails: the lexer counts lines from 0.');
  assert.equal(items[4].label, 'Edited 1 file');
  assert.equal(items[4].error, false);
});

test('user turns: you, another actor, a peer; meta hidden unless asked', () => {
  const items = chatItems(normalizeTurns(fx.turns));
  const users = items.filter((i) => i.type === 'user');
  assert.deepEqual(users.map((u) => u.who), ['you', 'you', 'from demo-review', 'mcp']);
  assert.ok(!users.some((u) => u.text.startsWith('Caveat')));
  const withMeta = chatItems(normalizeTurns(fx.turns), { showMeta: true }).filter((i) => i.type === 'user');
  assert.equal(withMeta.length, 5);
});

test('user turns: the owner the latest summary names reads "you" too', () => {
  const turns = normalizeTurns([
    { role: 'user', uuid: 'a', text: 'from the web UI', via: 'drover', actor: 'alice' },
    { role: 'user', uuid: 'b', text: 'manager history', user: 'drover:alice' },
    { role: 'user', uuid: 'c', text: 'generic', actor: 'owner' },
    { role: 'user', uuid: 'd', text: 'an agent', actor: 'mcp' },
  ]);
  const who = (opts) => chatItems(turns, opts).map((i) => i.who);
  assert.deepEqual(who({}), ['alice', 'alice', 'you', 'mcp'], 'no summary owner: only the generic actor');
  assert.deepEqual(who({ owner: 'Alice' }), ['you', 'you', 'you', 'mcp']);
  assert.deepEqual(who({ owner: 'bob', me: 'alice' }), ['you', 'you', 'you', 'mcp'], "this client's own actor");
});

test('the working line sits at the bottom while the session works', () => {
  assert.equal(chatItems(normalizeTurns(fx.turns), { working: true }).at(-1).type, 'working');
  assert.notEqual(chatItems(normalizeTurns(fx.turns)).at(-1).type, 'working');
});

test('older daemons: results without ids land on the last open call, a lone result opens a group', () => {
  const items = chatItems(normalizeTurns([
    { role: 'assistant', text: '', tools: [{ name: 'Bash' }] },
    { role: 'tool_result', text: '[error] boom' },
    { role: 'tool_result', text: 'orphan' },
  ]));
  assert.equal(items.length, 1);
  assert.equal(items[0].calls[0].result.text, 'boom');
  assert.equal(items[0].calls[0].result.isError, true);
  assert.equal(items[0].calls[1].name, 'tool');
  assert.equal(items[0].error, true);
});

test('group labels count by verb', () => {
  const calls = (...names) => names.map((name) => ({ name }));
  assert.equal(toolGroupLabel(calls('Bash', 'Bash', 'Bash', 'Read', 'Read')), 'Ran 3 commands, read 2 files');
  assert.equal(toolGroupLabel(calls('Edit', 'MultiEdit', 'Write', 'NotebookEdit')), 'Edited 4 files');
  assert.equal(toolGroupLabel(calls('Grep', 'Glob')), 'Searched 2 times');
  assert.equal(toolGroupLabel(calls('WebFetch', 'WebSearch')), 'Fetched 2 pages');
  assert.equal(toolGroupLabel(calls('Task', 'Agent')), 'Ran 2 agents');
  assert.equal(toolGroupLabel(calls('TodoWrite', 'TodoWrite')), 'Updated the todo list');
  assert.equal(toolGroupLabel(calls('mcp__drover__drover_send')), 'Used mcp__drover__drover_send');
  assert.equal(toolGroupLabel(calls('shell', 'apply_patch')), 'Ran 1 command, edited 1 file');
  assert.equal(toolGroupLabel([]), 'Used a tool');
});

test('no turn twice: copies with the same uuid collapse, the later copy wins', () => {
  const t = dedupeTurns([{ uuid: 'a', text: 'x' }, { uuid: 'b', text: 'y' }, { uuid: 'a', text: 'x2' }, { text: 'same' }, { text: 'same' }]);
  assert.deepEqual(t.map((x) => x.text), ['x2', 'y', 'same', 'same']);
  // An incremental read that overlaps a live turn does not repeat it.
  const s1 = mergeTranscript(null, { engine: 'claude', offset: 100, turns: [{ role: 'user', uuid: 'u1', text: 'hi' }] }, {});
  const live = { ...s1, turns: [...s1.turns, ...normalizeTurns([{ role: 'assistant', uuid: 'u2', text: 'hello' }])] };
  const s2 = mergeTranscript(live, { engine: 'claude', offset: 200, turns: [{ role: 'assistant', uuid: 'u2', text: 'hello' }] }, { since: 100 });
  assert.deepEqual(s2.turns.map((x) => x.uuid), ['u1', 'u2']);
});

test('markdown blocks: headings, lists, fenced code, quotes, paragraphs', () => {
  const b = markdownBlocks('# Plan\nFirst line\nsecond line\n\n- one\n- two\n  continued\n\n3. three\n4. four\n\n```js\nlet x = 1;\n```\n> quoted\n> more');
  assert.deepEqual(b, [
    { type: 'h', level: 1, text: 'Plan' },
    { type: 'p', text: 'First line\nsecond line' },
    { type: 'ul', items: ['one', 'two continued'] },
    { type: 'ol', items: ['three', 'four'], start: 3 },
    { type: 'code', lang: 'js', text: 'let x = 1;' },
    { type: 'quote', text: 'quoted\nmore' },
  ]);
  assert.deepEqual(markdownBlocks(''), []);
  assert.deepEqual(markdownBlocks('```\nunclosed'), [{ type: 'code', lang: '', text: 'unclosed' }]);
});

test('inline spans: code, bold, em, safe links only', () => {
  assert.deepEqual(inlineSpans('Run `npm test`, then **ship** it, *carefully*.'), [
    { t: 'text', v: 'Run ' }, { t: 'code', v: 'npm test' }, { t: 'text', v: ', then ' }, { t: 'b', v: 'ship' },
    { t: 'text', v: ' it, ' }, { t: 'i', v: 'carefully' }, { t: 'text', v: '.' },
  ]);
  assert.deepEqual(inlineSpans('[docs](https://docs.example.test/a) and [bad](javascript:alert(1))'), [
    { t: 'a', v: 'docs', href: 'https://docs.example.test/a' }, { t: 'text', v: ' and ' }, { t: 'text', v: 'bad' }, { t: 'text', v: ')' },
  ]);
  assert.deepEqual(inlineSpans('see https://example.test/x.'), [{ t: 'text', v: 'see ' }, { t: 'a', v: 'https://example.test/x', href: 'https://example.test/x' }, { t: 'text', v: '.' }]);
  assert.deepEqual(inlineSpans('snake_case_name stays'), [{ t: 'text', v: 'snake_case_name stays' }]);
});

test('resultPreview shows the first lines', () => {
  assert.deepEqual(resultPreview('a\nb\nc', 2), { head: 'a\nb', more: true });
  assert.deepEqual(resultPreview('a\nb\n', 2), { head: 'a\nb', more: false });
  const t0 = Date.now();
  assert.deepEqual(resultPreview(`${' '.repeat(100_000)}x\n\n`, 2), { head: `${' '.repeat(100_000)}x`, more: false }, 'a long blank run before text');
  assert.ok(Date.now() - t0 < 1500, `trimmed in linear time: took ${Date.now() - t0} ms`);
});
