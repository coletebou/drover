// The dialog answer card (ui/answer-model.js): buttons from a strip's real keys (native.board) or derived from its
// dialog (older daemons), sessions.answer with the screen hash, the tmux.answer fallback on "unknown op", what a
// refusal leaves on the card, and reading a screen the way core/tmux.js does. Synthetic screens only.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { answerModel, deriveKeys, pressKey, afterRefusal, pressedLabel, readScreen, screenHash, isUnknownOp } from '../ui/answer-model.js';

const strip = (extra = {}) => ({ key: 'h|s1', id: 's1', sessionId: 's1', kind: 'session', host: 'local', name: 'api', lane: 'wait', screen: 'dialog', tmux: 'work:@3', hash: 'abc123', dialog: { question: 'Do you want to proceed?', options: [{ n: 1, label: 'Yes', selected: true }, { n: 2, label: "Yes, and don't ask again" }, { n: 3, label: 'No' }] }, ...extra });

describe('answerModel', () => {
  test('the strip\'s keys decide the buttons; options are labelled and the selected one marked', () => {
    const m = answerModel(strip({ keys: ['1', '2', '3', 'Enter', 'Escape'], answer: 'keys' }));
    assert.equal(m.mode, 'keys');
    assert.equal(m.question, 'Do you want to proceed?');
    assert.deepEqual(m.buttons.map((b) => [b.key, b.label, b.kind, Boolean(b.selected)]), [
      ['1', '1. Yes', 'option', true], ['2', "2. Yes, and don't ask again", 'option', false], ['3', '3. No', 'option', false], ['Enter', 'Enter', 'confirm', false], ['Escape', 'Esc', 'cancel', false]]);
    assert.equal(m.buttons.find((b) => b.key === 'Enter').hint, 'picks 1');
    assert.deepEqual([m.id, m.target, m.hash, m.host], ['s1', 'work:@3', 'abc123', 'local']);
  });
  test('an older daemon\'s strip (no keys): digits for the options, Enter and Esc; never y/n', () => {
    assert.deepEqual(answerModel(strip()).buttons.map((b) => b.key), ['1', '2', '3', 'Enter', 'Escape']);
    assert.deepEqual(deriveKeys({ options: [{ n: 1 }], screenText: 'Overwrite? (y/n)' }), ['1', 'y', 'n', 'Enter', 'Escape']);
    assert.deepEqual(deriveKeys({ options: [], screenText: '1. Yes, proceed (y)' }), ['y', 'Enter', 'Escape']);
  });
  test('a held peer message: Deliver and Drop; keys the daemon does not take are dropped', () => {
    const m = answerModel(strip({ held: true, heldFrom: 'webapp-f8', dialog: null, keys: ['Enter', 'Escape', 'F12'] }));
    assert.deepEqual(m.buttons.map((b) => [b.key, b.label]), [['Enter', 'Deliver'], ['Escape', 'Drop']]);
    assert.match(m.question, /webapp-f8/);
  });
  test('a window strip answers by its tmux target; a question asked in text is answered in the composer', () => {
    assert.equal(answerModel(strip({ kind: 'window', id: 'work:@3', sessionId: null })).id, 'work:@3');
    assert.deepEqual(answerModel({ answer: 'reply', ask: { text: 'Push now?' }, screen: 'idle' }), { mode: 'reply', question: 'Push now?' });
    assert.equal(answerModel({ screen: 'idle', lane: 'idle' }), null);
    assert.equal(answerModel(null), null);
  });
  test('what a press did, in words', () => {
    const m = answerModel(strip());
    assert.equal(pressedLabel(m, '3'), 'picked 3. No');
    assert.equal(pressedLabel(m, 'Escape'), 'cancelled');
    assert.equal(pressedLabel(answerModel(strip({ held: true })), 'Enter'), 'delivered');
  });
  test('a multi-select question: Space ticks, kept from the daemon\'s keys and derived as the daemon derives it', async () => {
    const native = await import('../core/native.js');
    const dialog = { question: 'Which fixtures should the review cover?', options: [{ n: 1, label: '[ ] Unit', selected: true }, { n: 2, label: '[x] End to end' }, { n: 3, label: 'Submit' }] };
    const fields = native.answerFields({ screen: 'dialog', dialog, hash: 'h1' });
    assert.deepEqual(fields.keys, ['1', '2', '3', 'Space', 'Enter', 'Escape']);
    assert.deepEqual(deriveKeys({ options: dialog.options }), fields.keys, 'a reading derives them in the daemon\'s order');
    assert.deepEqual(deriveKeys({ options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }] }), ['1', '2', 'Enter', 'Escape'], 'no boxes, no Space');
    const m = answerModel({ screen: 'dialog', dialog, keys: fields.keys, hash: 'h1', kind: 'session', id: 's1' });
    assert.deepEqual(m.buttons.find((b) => b.key === 'Space'), { key: 'Space', label: 'Space (tick)', kind: 'nav' });
    const calls = [];
    await pressKey(async (op, args) => { calls.push([op, args]); return { ok: true }; }, m, 'Space');
    assert.deepEqual(calls, [['sessions.answer', { id: 's1', key: 'Space', expect: 'h1' }]]);
  });
});

describe('pressing', () => {
  test('sessions.answer with the hash; "unknown op" falls back to tmux.answer on the window', async () => {
    const calls = [];
    const fake = (fail) => async (op, args, opts) => { calls.push([op, args, opts.host]); if (op === 'sessions.answer' && fail) throw new Error('unknown op: sessions.answer'); return { ok: true, key: args.key }; };
    const m = { ...answerModel(strip()), host: 'devbox' };
    await pressKey(fake(false), m, '1');
    assert.deepEqual(calls.at(-1), ['sessions.answer', { id: 's1', key: '1', expect: 'abc123' }, 'devbox']);
    await pressKey(fake(true), m, 'Enter');
    assert.deepEqual(calls.slice(-2), [['sessions.answer', { id: 's1', key: 'Enter', expect: 'abc123' }, 'devbox'], ['tmux.answer', { target: 'work:@3', key: 'Enter', expect: 'abc123' }, 'devbox']]);
    await assert.rejects(pressKey(async () => { throw new Error('session not found'); }, m, '1'), /not found/);
    await assert.rejects(pressKey(fake(false), m, 'F5'), /not a key/);
    assert.ok(isUnknownOp(new Error('unknown op: x')) && !isUnknownOp(new Error('refused')));
  });
  test('verify: a press from a board strip reads the pane first and sends nothing when the prompt is at its bottom', async () => {
    const m = answerModel(strip());
    const idle = ' Do you want to proceed?\n ❯ 1. Yes\n   2. No\n Esc to cancel\n⏺ done\n╭───╮\n│ > │\n╰───╯\n  ? for shortcuts      bypass permissions on';
    const calls = [];
    const fake = (text) => async (op, args) => { calls.push(op); return op === 'tmux.capture' ? { text, screen: { state: 'dialog' } } : { ok: true, key: args.key }; };
    const r = await pressKey(fake(idle), m, '1', { verify: true });
    assert.deepEqual([r.ok, r.refused, r.local, calls], [false, true, true, ['tmux.capture']], 'no key is sent to the prompt');
    calls.length = 0;
    const ok = await pressKey(fake(' Do you want to proceed?\n ❯ 1. Yes\n   2. No\n Esc to cancel'), m, '1', { verify: true });
    assert.deepEqual([ok.ok, calls], [true, ['tmux.capture', 'sessions.answer']]);
    calls.length = 0;
    await pressKey(fake(idle), m, '1');
    assert.deepEqual(calls, ['sessions.answer'], 'a card read from the pane itself presses at once');
  });
  test('a refusal: the new dialog with its own hash, or no card when the dialog is gone, or stale without buttons', () => {
    const m = answerModel(strip());
    const next = afterRefusal(m, { ok: false, refused: true, reason: 'this dialog does not take "y"', hash: 'def', dialog: { question: 'Allow write?', options: [{ n: 1, label: 'Allow' }, { n: 2, label: 'Deny' }] } });
    assert.deepEqual([next.question, next.hash, next.reason, next.buttons.map((b) => b.key)], ['Allow write?', 'def', 'this dialog does not take "y"', ['1', '2', 'Enter', 'Escape']]);
    assert.equal(afterRefusal(m, { ok: false, refused: true, reason: 'no dialog is on screen any more', hash: 'x' }), null);
    const stale = afterRefusal(m, { ok: false, refused: true, reason: 'the screen changed since you read it; read it again', hash: 'zzz', preview: '...' });
    assert.deepEqual([stale.stale, stale.hash], [true, 'abc123'], 'a new hash without its dialog is not adopted');
    assert.equal(afterRefusal(m, { ok: true }), m);
  });
  test('a held message that gave way to a permission prompt is read as the prompt the refusal quotes', () => {
    const held = answerModel(strip({ held: true, heldFrom: 'webapp-f8', dialog: null, keys: ['Enter', 'Escape'] }));
    const preview = ' Bash command\n   rm -rf build\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n Esc to cancel';
    const next = afterRefusal(held, { ok: false, refused: true, reason: 'the screen changed since you read it; read it again', hash: 'h2', dialog: { question: 'Do you want to proceed?', options: [{ n: 1, label: 'Yes', selected: true }, { n: 2, label: 'No' }] }, preview });
    assert.deepEqual([next.held, next.question, next.buttons.map((b) => b.label), next.hash], [false, 'Do you want to proceed?', ['1. Yes', '2. No', 'Enter', 'Esc'], 'h2']);
    // and the other way round: a prompt that gave way to a held message is held (Deliver, Drop) when the quote says so
    const back = afterRefusal(answerModel(strip()), { ok: false, refused: true, reason: 'the screen changed since you read it; read it again', hash: 'h3', dialog: { question: 'Deliver it?', options: [] }, preview: 'Held message from another session\nAnother Claude session sent a message: from webapp-c2 (bypass)\nDeliver it?' });
    assert.deepEqual([back.held, back.heldFrom, back.buttons.map((b) => b.label)], [true, 'webapp-c2', ['Deliver', 'Drop']]);
    // a refusal that quotes no screen (a key the dialog does not take) is the same screen: the card keeps what it was
    const same = afterRefusal(held, { ok: false, refused: true, reason: 'this dialog does not take "y"', hash: 'h1', dialog: { question: 'Deliver it?', options: [] } });
    assert.equal(same.held, true);
    // y and n come back only when the quoted screen offers them
    const yn = afterRefusal(answerModel(strip()), { ok: false, refused: true, reason: 'the screen changed', hash: 'h4', dialog: { question: 'Overwrite package.json? (y/n)', options: [] }, preview: 'Overwrite package.json? (y/n)' });
    assert.deepEqual(yn.buttons.map((b) => b.key), ['y', 'n', 'Enter', 'Escape']);
  });
});

describe('reading a screen', () => {
  const screen = ['', '  Bash command', '    rm -rf build', '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. Yes, and don\'t ask again for rm commands', '   3. No, and tell Claude what to do differently (esc)', '', ' Esc to cancel'].join('\n');
  test('a permission dialog: its question, numbered options, the selected one, the keys it takes', () => {
    assert.deepEqual(readScreen(screen), { dialog: true, held: false, heldFrom: null, question: 'Do you want to proceed?', options: [{ n: 1, label: 'Yes', selected: true }, { n: 2, label: "Yes, and don't ask again for rm commands", selected: false }, { n: 3, label: 'No, and tell Claude what to do differently (esc)', selected: false }], keys: ['1', '2', '3', 'Enter', 'Escape'] });
  });
  test('prose that says yes is not a dialog; a held peer message is', () => {
    assert.equal(readScreen('All tests pass. Would you like me to push? yes, they pass.\n> '), null);
    const held = readScreen('Held message from another session\nAnother Claude session sent a message: from webapp-f8 (bypass)\nEnter to deliver · Esc to drop');
    assert.deepEqual([held.held, held.heldFrom, held.keys], [true, 'webapp-f8', ['Enter', 'Escape']]);
  });
  test('reads every screen the way the daemon does (core/tmux.js), so a press from the Screen tab is not refused', async () => {
    const tmux = await import('../core/tmux.js');
    const screens = [
      screen,
      'Overwrite package.json? (y/n)',
      ' Run a dynamic workflow?\n ❯ 1. Yes\n   2. No\n Enter to confirm · Esc to cancel',
      'Held message from another session\nAnother Claude session sent a message: from drover (mcp)\n',
      '  Select an option\n  › 1. Fast\n    2. Thorough (Recommended)\n  Esc to cancel',
      'esc to interrupt\n✻ Working…',
      '? for shortcuts',
      'plain text with 1. a list\n2. and more',
      // AskUserQuestion's review screen, with and without its last line; a dialog drawn twice (scrollback).
      ' Review your answers\n\n  ● Fixtures: Yes, all of them\n\n Ready to submit your answers?\n\n ❯ 1. Submit answers\n   2. Cancel\n\n Enter to select · Esc to cancel',
      ' Review your answers\n ❯ 1. Submit answers\n   2. Cancel\n Enter to select',
      ' Pick a fixture set?\n ❯ 1. All\n   2. New\n ❯ 1. All\n   2. New\n Esc to cancel',
    ];
    for (const s of screens) {
      const mine = readScreen(s);
      const theirs = tmux.classifyScreen(s).state === 'dialog' || Boolean(tmux.heldMessage(s));
      assert.equal(Boolean(mine), theirs, `dialog or not: ${JSON.stringify(s.slice(0, 40))}`);
      if (mine) { const d = tmux.dialogSummary(s); assert.deepEqual([mine.question, mine.options], [d.question, d.options]); }
      assert.equal(await screenHash(s), tmux.screenHash(s));
      if (mine) for (const k of mine.keys) assert.equal(tmux.keyFitsDialog(s, k).ok, true, `${k} fits ${JSON.stringify(s.slice(0, 30))}`);
    }
  });
  test('an idle prompt at the bottom is no dialog, though the scrollback above still holds the one just answered', async () => {
    const tmux = await import('../core/tmux.js');
    const answered = [' ☐ Fixtures', ' Should the review cover the test fixtures too (ask 2)?', ' ❯ 1. Yes, all of them (Recommended)', '   2. Only the new ones', ' Enter to select · ↑/↓ to navigate · Esc to cancel',
      '⏺ demo-review: working in ~/work', 'Done. The parser builds and the tests pass.', '╭──────────╮', '│ >        │', '╰──────────╯', '  ? for shortcuts                       bypass permissions on'].join('\n');
    assert.equal(tmux.classifyScreen(answered).state, 'idle', 'the daemon agrees: the screen is what is lowest');
    assert.equal(readScreen(answered), null, 'the card does not offer the answered dialog again');
    assert.equal(answerModel(strip({ tail: ['Do you want to proceed?', '  ? for shortcuts                bypass permissions on'] })), null, 'nor does a board strip whose last pane line is the prompt');
    assert.ok(answerModel(strip({ tail: ['Do you want to proceed?', ' Esc to cancel'] })), 'a dialog with its own footer last is answered as before');
    assert.ok(readScreen(screen), 'a dialog at the bottom is still read');
  });
  test('reading costs linear time, as in core/tmux.js: a long blank line, thousands of blank lines, other line breaks', async () => {
    const tmux = await import('../core/tmux.js');
    const dialog = 'Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel';
    for (const [name, s] of [
      ['a 100K blank line', `${' '.repeat(100_000)}x\n${dialog}`], ['tabs and blanks', `${' \t'.repeat(50_000)}x\n${dialog}`], ['5,000 blank lines', `out${'\n'.repeat(5000)}${dialog}`],
      ['carriage returns', `${'\r'.repeat(100_000)}x\n${dialog}`], ['line separators', `${'\u2028'.repeat(100_000)}x\n${dialog}`], ['paragraph separators', `${'\u2029'.repeat(100_000)}x\n${dialog}`],
    ]) {
      const t0 = Date.now();
      assert.deepEqual(readScreen(s)?.options.map((o) => o.n), [1, 2], name);
      assert.equal(readScreen(s.slice(0, -dialog.length)), null, `${name}: the run alone is no dialog`);
      assert.equal(await screenHash(s), tmux.screenHash(s), `${name}: the daemon's hash`);
      assert.ok(Date.now() - t0 < 1500, `${name}: took ${Date.now() - t0} ms`);
    }
  });
  test('the hash is the daemon\'s: sha1 of the last 20 non-empty lines, 16 hex chars', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => (i % 4 === 0 ? '   ' : `line ${i}   `)).join('\n') + '\n\n';
    const want = createHash('sha1').update(lines.replace(/\s+$/, '').split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim()).slice(-20).join('\n')).digest('hex').slice(0, 16);
    assert.equal(await screenHash(lines), want);
    assert.equal(await screenHash(screen), createHash('sha1').update(screen.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim()).slice(-20).join('\n')).digest('hex').slice(0, 16));
  });
});
