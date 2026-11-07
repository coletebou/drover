// Dialog answers: the key buttons from the daemon's fields, the press (sessions.answer with the screen hash,
// tmux.answer on "unknown op" for a board strip), refusals. Synthetic fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { answerPlan, shortLabel, dialogFields, pressKey, answerOutcome, isUnknownOp, keyName, UNSUPPORTED } from '../lib/answer.js';
import { normalizeSummary, normalizeBoard } from '../lib/summary.js';
import { ApiError, ErrorKind } from '../lib/api.js';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
const summary = normalizeSummary(fx('native-summary-dialog.json'));
const build = summary.waiting.find((s) => s.name === 'demo-build');
const review = summary.waiting.find((s) => s.name === 'demo-review');

test('normalizeSummary keeps the answer fields of waiting items', () => {
  assert.equal(build.answer, 'keys');
  assert.equal(build.hash, '3f2a9c1e5b7d2a46');
  assert.deepEqual(build.keys, ['1', '2', '3', 'Enter', 'Escape']);
  assert.equal(build.dialog.question, 'Do you want to proceed?');
  assert.deepEqual(build.dialog.options.map((o) => [o.n, o.selected]), [[1, true], [2, false], [3, false]]);
  assert.equal(review.answer, 'reply');
  assert.equal('keys' in review, false);
  // Working items never carry them.
  assert.equal('keys' in summary.working[0], false);
});

test('a permission dialog: one button per listed key, the highlighted option marked', () => {
  const p = answerPlan(build);
  assert.equal(p.mode, 'keys');
  assert.equal(p.question, 'Do you want to proceed?');
  assert.deepEqual(p.buttons.map((b) => b.key), ['1', '2', '3', 'Enter', 'Escape']);
  assert.deepEqual(p.buttons.map((b) => b.title), ['1 Yes', "2 Yes, don't ask again", '3 No', 'Enter', 'Esc']);
  assert.deepEqual(p.buttons.map((b) => b.selected), [true, false, false, false, false]);
  assert.equal(p.buttons[1].help, "2. Yes, and don't ask again for npm test commands in demo-app");
  assert.equal(p.buttons[3].help, 'Press Enter: 1. Yes');
  assert.equal(p.buttons[0].label, 'Answer 1, Yes');
});

test('a multi-select question: Space ticks the highlighted box and is pressed like any listed key', async () => {
  const item = { id: 's1', sessionId: 's1', host: 'local', answer: 'keys', hash: 'h1', keys: ['1', '2', 'Space', 'Enter', 'Escape'],
    dialog: { question: 'Which fixtures?', options: [{ n: 1, label: '[ ] Unit', selected: true }, { n: 2, label: '[x] End to end' }] } };
  const p = answerPlan(item);
  assert.deepEqual(p.buttons.map((b) => b.key), ['1', '2', 'Space', 'Enter', 'Escape']);
  assert.deepEqual(p.buttons[2], { key: 'Space', title: 'Space (tick)', help: 'Press Space: tick the highlighted option', label: 'Press Space to tick the highlighted option', selected: false, role: 'other' });
  const calls = [];
  await pressKey({ op: async (op, args) => { calls.push([op, args.key, args.expect]); return { ok: true }; } }, item, 'Space');
  assert.deepEqual(calls, [['sessions.answer', 'Space', 'h1']]);
});

test('a question asked in text is a reply; an older daemon offers nothing to press', () => {
  assert.equal(answerPlan(review).mode, 'reply');
  const legacy = normalizeSummary(fx('native-summary.json')).waiting[0];
  assert.deepEqual(answerPlan(legacy), { mode: 'none', question: null, buttons: [] });
  assert.equal(answerPlan(build, { supported: false }).mode, 'none');
  assert.equal(answerPlan({ answer: 'keys', keys: [] }).mode, 'none');
});

test('only pressable keys survive, y and n only when listed, duplicates once', () => {
  const f = dialogFields({ keys: ['1', 'F13', 'y', 'rm -rf', 'y', 'Escape'], hash: 'h', answer: 'later', dialog: { question: 3, options: [{ n: 'x' }, { n: 2, label: 'Two' }, { n: 12, label: 'no' }] } });
  assert.deepEqual(f.keys, ['1', 'y', 'Escape']);
  assert.equal(f.answer, undefined);
  assert.equal(f.dialog.question, null);
  assert.deepEqual(f.dialog.options, [{ n: 2, label: 'Two', selected: false }]);
  const p = answerPlan({ keys: ['y', 'n', 'Up', 'Down'], hash: 'h-1', dialog: { question: 'Continue? (y/n)', options: [] } });
  assert.deepEqual(p.buttons.map((b) => b.title), ['y', 'n', '↑', '↓']);
  assert.equal(p.buttons[0].label, 'Answer yes');
});

test('keys without a screen hash: no buttons, and nothing is ever sent', async () => {
  for (const hash of [undefined, '', 7]) {
    const item = { ...build, hash };
    if (hash === undefined) delete item.hash;
    assert.equal(answerPlan(item).mode, 'none', String(hash));
    const c = fakeClient({ 'sessions.answer': { ok: true }, 'tmux.answer': { ok: true } });
    await assert.rejects(() => pressKey(c, item, '1'), /no screen hash/);
    await assert.rejects(() => pressKey(c, { ...item, tmux: 'demo:1' }, '1'), /no screen hash/);
    assert.equal(c.calls.length, 0);
  }
});

test('shortLabel', () => {
  const cases = [
    ['Yes', 'Yes'],
    ["Yes, and don't ask again for npm test commands in ~/code/demo", "Yes, don't ask again"],
    ['No, and tell Claude what to do differently (esc)', 'No'],
    ['Yes, allow all edits during this session (shift+tab)', 'Yes, allow all edits…'],
    ['Use the in-memory map (Recommended)', 'Use the in-memory map'],
    ['Type something.', 'Type something'],
    ['(esc)', '(esc)'],
    ['Supercalifragilisticexpialidociousness-everywhere', 'Supercalifragilisticexpia…'],
  ];
  for (const [i, o] of cases) {
    assert.equal(shortLabel(i), o, i);
    assert.ok(shortLabel(i).length <= 26, i);
  }
});

function fakeClient(answers) {
  const calls = [];
  return {
    calls,
    async op(name, args) {
      calls.push([name, args]);
      const a = answers[name];
      if (a instanceof Error) throw a;
      return typeof a === 'function' ? a(args) : a;
    },
  };
}

test('pressKey sends sessions.answer with the hash, and reads the outcome', async () => {
  const c = fakeClient({ 'sessions.answer': { ok: true, key: '1', target: 'demo:1', hash: '3f2a9c1e5b7d2a46' } });
  const out = await pressKey(c, build, '1', { actor: 'chrome' });
  assert.deepEqual(out, { ok: true, refused: false, unsupported: false, message: 'Sent 1.' });
  assert.deepEqual(c.calls, [['sessions.answer', { id: build.id, host: 'local', key: '1', actor: 'chrome', expect: '3f2a9c1e5b7d2a46' }]]);
});

test('a refusal is an outcome, not an error', async () => {
  const c = fakeClient({ 'sessions.answer': { ok: false, refused: true, reason: 'the screen changed since you read it; read it again', hash: 'ffff' } });
  const out = await pressKey(c, build, 'Escape');
  assert.equal(out.ok, false);
  assert.equal(out.refused, true);
  assert.equal(out.message, 'Not sent: the screen changed since you read it; read it again.');
  assert.equal(answerOutcome({ ok: false, refused: true }, '1').message, 'Not sent: the dialog changed, look again.');
});

test('a key the dialog does not list is never sent', async () => {
  const c = fakeClient({ 'sessions.answer': { ok: true } });
  await assert.rejects(() => pressKey(c, build, 'y'), /not a key this dialog takes/);
  await assert.rejects(() => pressKey(c, review, '1'));
  assert.equal(c.calls.length, 0);
});

test('unknown op: a board strip falls back to tmux.answer on its window, a summary item is unsupported', async () => {
  const unknown = new ApiError(ErrorKind.SERVER, 'unknown op sessions.answer', { status: 400 });
  assert.ok(isUnknownOp(unknown, 'sessions.answer'));
  assert.ok(!isUnknownOp(new Error('session not found'), 'sessions.answer'));
  const strip = normalizeBoard(fx('native-board.json')).strips.find((s) => s.name === 'demo-build');
  const c = fakeClient({ 'sessions.answer': unknown, 'tmux.answer': { ok: true, key: '2' } });
  const out = await pressKey(c, strip, '2', { actor: 'chrome' });
  assert.equal(out.message, 'Sent 2.');
  assert.deepEqual(c.calls[1], ['tmux.answer', { target: 'demo:1', key: '2', host: 'local', actor: 'chrome', expect: '3f2a9c1e5b7d2a46' }]);
  const c2 = fakeClient({ 'sessions.answer': unknown });
  assert.deepEqual(await pressKey(c2, build, '1'), UNSUPPORTED);
  assert.equal(c2.calls.length, 1);
});

test('other errors (no tmux pane, unreachable) propagate for the page to show', async () => {
  const c = fakeClient({ 'sessions.answer': new ApiError(ErrorKind.SERVER, 'this session has no tmux pane (reply with a message instead)') });
  await assert.rejects(() => pressKey(c, build, '1'), /no tmux pane/);
});

test('keyName', () => {
  assert.equal(keyName('Escape'), 'Esc');
  assert.equal(keyName('3'), '3');
});

test('a Hermes approval strip (its own dialog, reported) is pressed through sessions.answer with its prompt id, never tmux', async () => {
  const item = { id: 'local-ab12', host: 'local', engine: 'hermes', reported: true, tmux: 'agents:@7', answer: 'keys', hash: 'prompt-1', keys: ['1', '2', '3', '4', 'Enter', 'Escape'], dialog: { question: 'Run rm -rf scratch (recursive delete)?', options: [{ n: 1, label: 'Allow once', selected: true }, { n: 2, label: 'Allow this session' }, { n: 3, label: 'Always allow' }, { n: 4, label: 'Deny' }] } };
  const calls = [];
  const out = await pressKey({ op: async (op, args) => { calls.push([op, args.id, args.key, args.expect]); return { ok: true, key: args.key, choice: 'deny' }; } }, item, '4', { actor: 'chrome' });
  assert.deepEqual(calls, [['sessions.answer', 'local-ab12', '4', 'prompt-1']]);
  assert.ok(out);
  await assert.rejects(() => pressKey({ op: async () => ({ ok: true }) }, item, 'y'), /not a key this dialog takes/);
});
