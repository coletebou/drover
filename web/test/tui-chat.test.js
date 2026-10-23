// The chat rendering rule in the TUI (tui/chat.js) and its Markdown (tui/markdown.js), on synthetic turns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatItems, chatRows, groupSummary, toolSummary, userTurn, answerCardRows, keyHints, rowsText } from '../tui/chat.js';
import { renderMarkdown, inline, wrapSegs } from '../tui/markdown.js';
import { answerKeys } from '../tui/board.js';
import { strWidth } from '../tui/width.js';

const t0 = '2026-10-20T12:00:00.000Z';
const at = (s) => new Date(Date.parse(t0) + s * 1000).toISOString();
// The daemon's shape: tools carry id and summary, results come by call id.
const call = (id, name, summary, input = {}) => ({ id, name, input, summary });
const NEW = [
  { role: 'user', ts: at(0), uuid: 'u1', text: 'Fix the parser and run the tests' },
  { role: 'thinking', ts: at(1), uuid: 'th1' },
  { role: 'assistant', ts: at(2), uuid: 'a1', text: 'I will read the parser first.', tools: [] },
  { role: 'assistant', ts: at(3), uuid: 'a2', text: '', tools: [call('t1', 'Read', '~/code/x/src/parser.js')] },
  { role: 'tool_result', ts: at(4), uuid: 'r1', results: [{ toolUseId: 't1', isError: false, text: 'line 1\nline 2\nline 3\nline 4\nline 5\nline 6' }] },
  { role: 'thinking', ts: at(5), uuid: 'th2' },
  { role: 'assistant', ts: at(6), uuid: 'a3', text: ' \n', tools: [call('t2', 'Bash', 'npm test'), call('t3', 'Bash', 'npm run lint')] },
  { role: 'tool_result', ts: at(7), uuid: 'r2', results: [{ toolUseId: 't3', isError: false, text: 'lint ok' }, { toolUseId: 't2', isError: true, text: '1 failing' }] },
  { role: 'assistant', ts: at(8), uuid: 'a4', text: '', tools: [call('t4', 'Grep', '"throw" in src')] },
  { role: 'tool_result', ts: at(9), uuid: 'r3', results: [{ toolUseId: 't4', isError: false, text: 'src/parser.js:3' }] },
  { role: 'assistant', ts: at(10), uuid: 'a5', text: 'One test fails; fixing it.', tools: [call('t5', 'Edit', '~/code/x/src/parser.js')] },
  { role: 'user', ts: at(11), uuid: 'm1', text: '<system-reminder>x</system-reminder>', meta: true },
];

test('consecutive tool turns form one group; text breaks it; results attach by call id', () => {
  const items = chatItems(NEW);
  assert.deepEqual(items.map((i) => i.kind), ['user', 'text', 'tools', 'text', 'tools'], 'thinking hides and does not split a group; the meta turn is hidden');
  const g = items[2];
  assert.deepEqual(g.calls.map((c) => [c.name, c.summary, c.result?.text, c.result?.isError]), [
    ['Read', '~/code/x/src/parser.js', 'line 1\nline 2\nline 3\nline 4\nline 5\nline 6', false],
    ['Bash', 'npm test', '1 failing', true],
    ['Bash', 'npm run lint', 'lint ok', false],
    ['Grep', '"throw" in src', 'src/parser.js:3', false],
  ]);
  assert.equal(g.error, true, 'a group with an error result says so');
  assert.equal(groupSummary(g.calls), 'Read 1 file, ran 2 commands, searched 1 time');
  assert.equal(items[4].calls[0].name, 'Edit', 'a turn with text and tools shows the text, then its calls');
  assert.equal(chatItems(NEW, { showMeta: true }).at(-1).who, 'system', 'meta turns show when asked for');
});

test('the group line counts by verb, as the spec words it', () => {
  const names = (...n) => n.map((name) => ({ name }));
  assert.equal(groupSummary(names('Bash', 'Bash', 'Bash')), 'Ran 3 commands');
  assert.equal(groupSummary(names('Read', 'Read', 'Edit', 'Write', 'NotebookEdit', 'MultiEdit')), 'Read 2 files, edited 4 files');
  assert.equal(groupSummary(names('Grep', 'Glob')), 'Searched 2 times');
  assert.equal(groupSummary(names('WebFetch', 'WebSearch')), 'Fetched 2 pages');
  assert.equal(groupSummary(names('Task', 'Agent')), 'Ran 2 agents');
  assert.equal(groupSummary(names('TodoWrite', 'TodoWrite')), 'Updated the todo list');
  assert.equal(groupSummary(names('mcp__drover__drover_send')), 'Used mcp__drover__drover_send');
  assert.equal(groupSummary(names('shell', 'exec_command', 'apply_patch')), 'Ran 2 commands, edited 1 file', 'Codex calls');
});

test('the old turn shape: no summaries (computed here), results as one joined text in call order', () => {
  const OLD = [
    { role: 'assistant', ts: at(1), uuid: 'o1', text: '', tools: [{ name: 'Bash', input: { command: 'npm test', description: 'run tests' } }] },
    { role: 'tool_result', ts: at(2), uuid: 'o2', count: 1, text: '[error] 2 failing' },
    { role: 'assistant', ts: at(3), uuid: 'o3', text: '', tools: [{ name: 'Read', input: '{"file_path":"/Users/someone/code/x/a.js","limit":20' + '…' }, { name: 'Grep', input: { pattern: 'TODO', path: 'src' } }] },
    { role: 'tool_result', ts: at(4), uuid: 'o4', count: 2, text: 'content\n---\nsrc/a.js:1' },
  ];
  const [g] = chatItems(OLD);
  assert.deepEqual(g.calls.map((c) => [c.summary, c.result?.text, c.result?.isError]), [['npm test', '2 failing', true], ['~/code/x/a.js', 'content', false], ['"TODO" in src', 'src/a.js:1', false]]);
  assert.equal(toolSummary('WebFetch', { url: 'https://example.com/a' }), 'https://example.com/a');
  assert.equal(toolSummary('WebSearch', { query: 'tmux popup' }), 'tmux popup');
  assert.equal(toolSummary('TodoWrite', { todos: [1, 2, 3] }), '3 items');
  assert.equal(toolSummary('Task', { description: 'review the diff', prompt: 'long' }), 'review the diff');
  assert.equal(toolSummary('Custom', { a: 1, b: 'first string' }), 'first string');
  assert.ok(toolSummary('Bash', { command: 'x'.repeat(500) }).length <= 200);
});

test('user turns: the owner is "you", a relayed peer message names its sender', () => {
  assert.equal(userTurn({ text: 'hi' }).who, 'you');
  assert.deepEqual(userTurn({ text: '<cross-session-message from-name="drover (owner)" from-mode="bypass">\nship it\n</cross-session-message>' }), { who: 'you', text: 'ship it' });
  assert.equal(userTurn({ text: '<cross-session-message from-name="drover (mcp)">\nstatus?\n</cross-session-message>' }).who, 'mcp');
  assert.equal(userTurn({ text: '<cross-session-message from-name="webapp-f8">\ndone\n</cross-session-message>' }).who, 'webapp-f8');
  assert.equal(userTurn({ text: 'x', actor: 'grok:scout' }).who, 'grok:scout');
});

test('rows: a collapsed group is one line, Enter levels show calls, then all output; a selection gutter', () => {
  const items = chatItems(NEW);
  const collapsed = rowsText(chatRows(items, 80).rows);
  const groupLine = collapsed.find((r) => r.includes('Read 1 file, ran 2 commands'));
  assert.ok(groupLine.includes('▸') && groupLine.includes('1 error'), groupLine);
  assert.ok(!collapsed.some((r) => r.includes('line 1')), 'results are hidden while collapsed');
  const one = rowsText(chatRows(items, 80, { expanded: new Map([[items[2].key, 1]]) }).rows);
  assert.ok(one.some((r) => r.includes('Bash') && r.includes('npm test')));
  assert.ok(one.some((r) => r.includes('line 4')) && !one.some((r) => r.includes('line 5')), 'the first four lines of a result');
  assert.ok(one.some((r) => r.includes('… 2 more lines (Enter shows all)')));
  const all = rowsText(chatRows(items, 80, { expanded: new Map([[items[2].key, 2]]) }).rows);
  assert.ok(all.some((r) => r.includes('line 6')));
  const { rows, spans } = chatRows(items, 80, { selected: 1, working: true });
  const [a, b] = spans[1];
  assert.ok(rowsText(rows.slice(a, b)).every((r) => r.startsWith('▌')), 'every row of the selected item is marked');
  assert.match(rowsText(rows).at(-1), /working…/);
  for (const r of rows) assert.ok(strWidth(r.map(([t]) => t).join('')) <= 80);
});

test('the answer card shows the question, each option (the highlighted one marked) and the keys', () => {
  const strip = { lane: 'wait', name: 'demo-build', ask: { label: 'needs a decision' }, dialog: { question: 'Do you want to proceed?', options: [{ n: 1, label: 'Yes', selected: true }, { n: 2, label: "Yes, and don't ask again" }, { n: 3, label: 'No' }] }, keys: ['1', '2', '3', 'Enter', 'Escape'], hash: 'h1' };
  const rows = rowsText(answerCardRows(strip, answerKeys(strip), 70));
  assert.deepEqual(rows, [
    ' ┌ needs a decision',
    ' │ Do you want to proceed?',
    ' │ ❯ 1 Yes',
    " │   2 Yes, and don't ask again",
    ' │   3 No',
    ' └ 1-3 pick · Enter approve (1) · Esc deny',
  ]);
  assert.equal(keyHints([{ key: 'Enter', label: 'deliver', hint: 'deliver' }, { key: 'Escape', label: 'drop', hint: 'drop' }]).map(([t]) => t).join(''), 'Enter deliver · Esc drop');
});

test('Markdown: headings, lists with hanging indents, verbatim code, quotes, inline styles', () => {
  const md = '# Status\n\nThree **waiting**, see `drover tui` and [the board](https://x.example/b).\n\n- first item that is long enough to wrap onto a second line\n  - nested\n1. one\n\n> quoted\n\n```js\nconst x = 1;   // spaces kept\n```\n---';
  const rows = renderMarkdown(md, 40);
  const text = rowsText(rows);
  assert.equal(text[0], 'Status');
  assert.ok(text.includes('• first item that is long enough to wrap'));
  assert.ok(text.includes('  onto a second line'), 'the hanging indent');
  assert.ok(text.includes('  • nested'));
  assert.ok(text.includes('1. one'));
  assert.ok(text.includes('│ quoted'));
  assert.ok(text.includes('  const x = 1;   // spaces kept'), 'code is verbatim');
  assert.ok(text.at(-1).startsWith('────'));
  for (const r of text) assert.ok(strWidth(r) <= 40, r);
  assert.deepEqual(inline('a **b** `c` _d_ snake_case_x [e](http://u)'), [['a ', null], ['b', 'bold'], [' ', null], ['c', 'code'], [' ', null], ['d', 'italic'], [' snake_case_x ', null], ['e', 'link'], [' (http://u)', 'dim']]);
});

test('a long wrapped paragraph keeps every word once, in order: continuation rows do not share their prefix', () => {
  const words = Array.from({ length: 120 }, (_, i) => `w${i}`);
  for (const md of [`- ${words.join(' ')}`, `  ${words.join(' ')}`, `> ${words.join(' ')}`, words.join(' ')]) {
    const rows = rowsText(renderMarkdown(md, 30, { indent: ' ' }));
    const got = rows.join(' ').split(/\s+/).filter((w) => /^w\d+$/.test(w));
    assert.deepEqual(got, words, `every word exactly once for ${JSON.stringify(md.slice(0, 4))}`);
    assert.ok(rows.length < 40, `${rows.length} rows: no runaway`);
    for (const r of rows) assert.ok(strWidth(r) <= 30, r);
  }
  const first = [['>', null]], rest = [['   ', null]];
  wrapSegs([['one two three four five six seven eight nine ten', null]], 12, { first, rest });
  assert.deepEqual([first, rest], [[['>', null]], [['   ', null]]], 'the prefixes passed in are not changed');
});
