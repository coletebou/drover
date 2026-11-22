// ui/pane-content.js: what an agent's pane says without the agent's own furniture. Claude Code's input box, status
// line, mode line and notice row, the older ╭─╮ box and Codex's › line with its footer are left out; what was typed
// and not sent stays; a dialog, a shell and anything unrecognised come back whole; prose the agent wrapped at the
// pane's width is one line again; rules, boxes and tables keep their shape. Synthetic panes, drawn as the agents draw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paneContent, tailContent, reflow, keepsShape, hangingIndent, lastText, isFaint } from '../ui/pane-content.js';
import { parseAnsi, plainLines } from '../ui/ansi.js';

const RULE = '─'.repeat(100);
const DIM = (t) => `\x1b[2m${t}\x1b[0m`;
const clean = (text, opts) => { const r = paneContent(parseAnsi(text), opts); return { ...r, text: plainLines(r.lines).map((l) => l.trimEnd()) }; };

const CLAUDE_IDLE = [
  '⏺ The parser keeps line numbers now.',
  '',
  '  All three suites pass.',
  '',
  '✻ Baked for 26s · done 4:40 AM',
  `${' '.repeat(60)}new task? /clear to save 261k tokens`,
  RULE,
  '❯ ',
  RULE,
  '  \x1b[48;5;208mbox:1a2b3c\x1b[0m app:main | model | 59%',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 4 agents',
].join('\n');

test('Claude Code: the input box, the status line, the mode line and the notice row are left out', () => {
  const r = clean(CLAUDE_IDLE, { state: 'idle' });
  assert.deepEqual(r.text, ['⏺ The parser keeps line numbers now.', '', '  All three suites pass.', '', '✻ Baked for 26s · done 4:40 AM']);
  assert.equal(r.chrome, 6, 'the notice, two rules, the prompt, the status line, the mode line');
  assert.ok(!r.text.join('\n').includes('bypass permissions'), 'no mode line');
  // A working pane keeps its spinner line: that is what the agent is doing.
  const busy = clean(['⏺ Running the suite', '', '✶ Envisioning… (2m 13s · ↓ 4.2k tokens)', '', `${'─'.repeat(88)} code-profiles`, '❯ ', RULE, '  status', '  ⏵⏵ bypass permissions on · esc to interrupt'].join('\n'), { state: 'busy' });
  assert.equal(busy.text.at(-1), '✶ Envisioning… (2m 13s · ↓ 4.2k tokens)');
  // A left-aligned notice (a narrow pane) is known by its words.
  const narrow = clean(['  done', '  new task? /clear to save 755.3k to… · ✔ Update installed · Restart to update', RULE, '❯ ', RULE, '  ⏵⏵ accept edits on'].join('\n'));
  assert.deepEqual(narrow.text, ['  done']);
});

test('what was typed and not sent stays; a faint placeholder or prediction does not', () => {
  const typed = clean(['  reply', '', RULE, '❯ fix the flaky test', RULE, '  \x1b[35m⏵⏵ bypass permissions on\x1b[0m'].join('\n'));
  assert.deepEqual(typed.text, ['  reply', '', '❯ fix the flaky test']);
  const faint = clean(['  reply', '', RULE, `❯ ${DIM('Try "write a test for parser.js"')}`, RULE, '  ⏵⏵ bypass permissions on'].join('\n'));
  assert.deepEqual(faint.text, ['  reply']);
  const cursor = clean(['  reply', '', RULE, '❯ \x1b[7m \x1b[0m', RULE, '  ⏵⏵ bypass permissions on'].join('\n'));
  assert.deepEqual(cursor.text, ['  reply'], 'the cursor block is not text');
  // Without colours (an older daemon's plain capture) typed and placeholder look the same: no draft either way.
  assert.deepEqual(clean(['  reply', RULE, '❯ fix it', RULE, '  status'].join('\n').replace(/\x1b\[[0-9;]*m/g, '')).text, ['  reply']);
  assert.equal(isFaint({ dim: true }), true); assert.equal(isFaint({ fg: '#808080' }), true); assert.equal(isFaint({ fg: '#ff8700' }), false); assert.equal(isFaint({}), false);
});

test('Codex: the › line and its footer; the older Claude box; tips', () => {
  const codex = clean(['• Ran npm test', '  └ 3 passing', '', '• Working (1h 48m 24s • esc to interrupt) · 4 background terminals running', '  └ Tip: use /usage to check your account usage.', '', '', `› ${DIM('Ask Codex to do anything')}`, '', '  GPT-6 max · ~/code/app · Context 45% used', '  ← for agents · ? for shortcuts'].join('\n'), { state: 'busy' });
  assert.deepEqual(codex.text, ['• Ran npm test', '  └ 3 passing', '', '• Working (1h 48m 24s • esc to interrupt) · 4 background terminals running']);
  const draft = clean(['• Done.', '', '› ship it \x1b[7m \x1b[0m', '', '  GPT-6 max · ~/code/app', '  ← for agents · ? for shortcuts'].join('\n'));
  assert.deepEqual(draft.text, ['• Done.', '', '› ship it'], 'a Codex draft stays');
  const old = clean(['  reply', '', `╭${'─'.repeat(40)}╮`, `│ > ${' '.repeat(37)}│`, `╰${'─'.repeat(40)}╯`, '  ? for shortcuts'].join('\n'));
  assert.deepEqual(old.text, ['  reply']);
});

test('a dialog is never cut; a shell and an unrecognised pane come back whole', () => {
  const dialog = [' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel · Tab to amend'].join('\n');
  assert.deepEqual(clean(dialog, { state: 'dialog' }).text, dialog.split('\n').map((l) => l.trimEnd()));
  assert.equal(clean(dialog).chrome, 0, 'even when no one said it is a dialog: an option line is not an input line');
  // A question drawn between two rules with its options (AskUserQuestion): the ❯ marks an option, not a prompt.
  const ask = [RULE, '❯ 1. Table dialog fix', '  2. Picture resizing', RULE, 'Enter to select · Esc to cancel'].join('\n');
  assert.equal(clean(ask).chrome, 0);
  assert.equal(clean(ask).text.length, 5);
  const shell = ['$ npm test', '✓ 3 passing', '$ '].join('\n');
  assert.deepEqual(clean(shell).text, ['$ npm test', '✓ 3 passing', '$']);
  assert.deepEqual(paneContent([]).lines, []);
  assert.deepEqual(paneContent(null).lines, []);
});

test('blank runs collapse to one row, none at either end', () => {
  const r = clean(['', '', 'one', '', '', '', 'two', '', '', RULE, '❯ ', RULE, '  status'].join('\n'));
  assert.deepEqual(r.text, ['one', '', 'two']);
});

test('reflow: prose the agent wrapped at the pane\'s edge is one line again, and keeps its colours', () => {
  const w = 60;
  const pane = [
    '⏺ The combined branch is green again after the rebase onto',     // 57 columns: reached the edge
    '  dev, and the checks pass.',
    '  - A bullet that also runs all the way out to the right edge',
    '    and continues here.',
    '  - A short bullet.',
    '    not a continuation: the row above stopped short',
    '',
    '※ recap: everything is merged and the stack is down, nothing',
    '  is left for you. (turn off recaps in /config)',
    '─'.repeat(w), '❯ ', '─'.repeat(w), '  status',
  ].join('\n');
  const r = clean(pane);
  assert.deepEqual(r.text, [
    '⏺ The combined branch is green again after the rebase onto dev, and the checks pass.',
    '  - A bullet that also runs all the way out to the right edge and continues here.',
    '  - A short bullet.',
    '    not a continuation: the row above stopped short',
    '',
    '※ recap: everything is merged and the stack is down, nothing is left for you.',
  ]);
  // Colours ride along: the second row's red stays red after the join.
  const [joined] = reflow(parseAnsi(`  ${'word '.repeat(11)}\n  \x1b[31mred tail\x1b[0m`), 60);
  assert.equal(joined.find((x) => x.text === 'red tail')?.fg, '#cd3131');
  // Nothing is joined without an indent or a bullet (a shell's output), across a table row, or in a narrow pane.
  const flat = parseAnsi(`${'x'.repeat(58)}\n${'y'.repeat(10)}`);
  assert.equal(reflow(flat, 60).length, 2);
  const table = parseAnsi(`  ${'a'.repeat(56)}\n  │ cell │ cell │`);
  assert.equal(reflow(table, 60).length, 2);
  assert.equal(reflow(parseAnsi('  aaaaaaaaaaaaaaaa\n  b'), 18).length, 2, 'too narrow to judge');
});

test('the board\'s own tail: nothing from the input box down, no notice, tip or mode line', () => {
  assert.deepEqual(tailContent(['new task? /clear to save 556.6k tokens', `${'─'.repeat(40)} apex-144e-2 ─`, '❯', 'app:main | model | 74%']), [], 'an idle pane\'s tail is all furniture');
  assert.deepEqual(tailContent(['  All three suites pass.', '', '✻ Baked for 26s', RULE, '❯ ', RULE, '  status', '  ⏵⏵ bypass permissions on']), ['  All three suites pass.', '✻ Baked for 26s']);
  assert.deepEqual(tailContent(['a dialog is open', `${'─'.repeat(40)} demo ─`]), ['a dialog is open']);
  assert.deepEqual(tailContent(['Compiling the parser', '  ⎿  Tip: drag images in', '  ? for shortcuts']), ['Compiling the parser']);
  assert.deepEqual(tailContent(['…to you. The stack is down.']), ['…to you. The stack is down.'], 'a line the daemon wrote is kept as it is');
  assert.deepEqual(tailContent(null), []); assert.deepEqual(tailContent(['', null]), []);
});

test('keepsShape, hangingIndent, lastText', () => {
  for (const t of ['────────────', '│ a │ b │', '  ├─ agent', '  └ 3 passing', 'name │ state │ age']) assert.equal(keepsShape(t), true, t);
  for (const t of ['⏺ prose', '  - a bullet', '  ⎿  tool output that runs long', 'a | b']) assert.equal(keepsShape(t), false, t);
  assert.equal(hangingIndent('⏺ prose'), 2);
  assert.equal(hangingIndent('  - a bullet'), 4);
  assert.equal(hangingIndent('  12. numbered'), 6);
  assert.equal(hangingIndent('            deep code'), 6, 'capped');
  assert.equal(hangingIndent('plain'), 0);
  assert.equal(lastText(parseAnsi('one\n\x1b[32mtwo\x1b[0m  \n\n')), 'two');
  assert.equal(lastText([]), '');
});
