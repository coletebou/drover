// The TUI's board model (tui/board.js): native.board and fleet.summary strips, answer keys, the answer plan and the
// fallback to tmux.answer on a daemon that predates sessions.answer. Synthetic data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromNativeBoard, fromFleet, boardOrder, lanesOf, answerKeys, dialogKeyFor, answerPlan, pressKey, replyPlan, pressDrawn } from '../tui/board.js';

const dialogStrip = (extra = {}) => ({ key: 'local|s1', id: 's1', name: 'demo-build', host: 'local', engine: 'claude', lane: 'wait', kind: 'session', tmux: 'demo:1', since: '2026-10-20T12:00:00Z', answer: 'keys', dialog: { question: 'Do you want to proceed?', options: [{ n: 1, label: 'Yes', selected: true }, { n: 2, label: 'Yes, always' }, { n: 3, label: 'No' }] }, hash: 'abc123', keys: ['1', '2', '3', 'Enter', 'Escape'], ...extra });
const ev = (id) => ({ id });

test('native.board strips come in board order: waiting, working, idle; live before faded; newest first', () => {
  const b = fromNativeBoard({ hosts: [{ name: 'local', up: true }], strips: [
    { key: 'a', lane: 'idle', since: '2026-10-20T12:00:00Z' }, { key: 'b', lane: 'wait', since: '2026-10-20T11:00:00Z' },
    { key: 'c', lane: 'work', since: '2026-10-20T10:00:00Z' }, { key: 'd', lane: 'wait', since: '2026-10-20T12:00:00Z' },
    { key: 'e', lane: 'wait', since: '2026-10-20T13:00:00Z', faded: true },
  ], totals: { waiting: 3, working: 1, idle: 1, hosts: 1 }, manager: { up: true, host: 'local' } });
  assert.deepEqual(b.strips.map((s) => s.key), ['d', 'b', 'e', 'c', 'a']);
  assert.equal(b.source, 'native.board');
  assert.deepEqual(Object.fromEntries(Object.entries(lanesOf(b.strips)).map(([k, v]) => [k, v.length])), { wait: 3, work: 1, idle: 1 });
  assert.deepEqual(boardOrder([{ key: 'x', lane: 'idle' }, { key: 'y', lane: 'wait' }]).map((s) => s.key), ['y', 'x']);
});

test('an older daemon: the same strips from fleet.summary through the web UI lanes', () => {
  const fleet = { ts: 'x', hosts: [{ host: 'local', ok: true, sessions: [{ id: 's1', sessionId: 's1', live: true, status: 'idle', engine: 'claude', name: 'demo-build', tmux: 'demo:@1.%1' }, { id: 's2', sessionId: 's2', live: true, status: 'busy', engine: 'claude', name: 'demo-work' }], windows: [{ target: 'demo:@1', session: 'demo', windowId: '@1', screen: { state: 'dialog' }, agent: { sessionId: 's1' }, dialog: { question: 'Proceed?', options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }] }, hash: 'h9', tail: ['Proceed?'] }] }, { host: 'devbox', ok: false, error: 'ssh: timeout', sessions: [], windows: [] }] };
  const b = fromFleet(fleet);
  assert.equal(b.source, 'fleet.summary');
  assert.deepEqual(b.strips.map((s) => [s.name, s.lane]), [['demo-build', 'wait'], ['demo-work', 'work']]);
  assert.equal(b.strips[0].hash, 'h9');
  assert.deepEqual(b.hosts.map((h) => [h.name, h.up, h.waiting]), [['local', true, 1], ['devbox', false, 0]]);
  assert.deepEqual(answerKeys(b.strips[0]).map((k) => k.key), ['1', '2', 'Enter', 'Escape'], 'keys derived from the dialog when the daemon sent none');
});

test('answer keys: the daemon\'s keys with option labels; held messages deliver or drop; text questions take a reply', () => {
  assert.deepEqual(answerKeys(dialogStrip()).map((k) => [k.key, k.hint]), [['1', 'Yes'], ['2', 'Yes, always'], ['3', 'No'], ['Enter', 'approve (1)'], ['Escape', 'deny']]);
  assert.deepEqual(answerKeys(dialogStrip({ held: true, keys: ['Enter', 'Escape'], dialog: { question: null, options: [] } })).map((k) => [k.key, k.label]), [['Enter', 'deliver'], ['Escape', 'drop']]);
  assert.deepEqual(answerKeys(dialogStrip({ answer: 'reply', keys: undefined })), [], 'answered with a message (r)');
  assert.deepEqual(answerKeys(dialogStrip({ lane: 'work' })), [], 'only a waiting strip takes answer keys');
  assert.deepEqual(answerKeys(dialogStrip({ keys: undefined, dialog: { question: 'Overwrite? (y/n)', options: [] } })).map((k) => k.key), ['Enter', 'Escape', 'y', 'n']);
});

test('dialogKeyFor: digits, Enter, Esc and y/n press only keys the dialog takes', () => {
  const s = dialogStrip();
  assert.equal(dialogKeyFor(s, ev('2')), '2');
  assert.equal(dialogKeyFor(s, ev('enter')), 'Enter');
  assert.equal(dialogKeyFor(s, ev('escape')), 'Escape');
  assert.equal(dialogKeyFor(s, ev('4')), null, 'not an option on screen');
  assert.equal(dialogKeyFor(s, ev('y')), null, 'Claude Code dialogs ignore y');
  assert.equal(dialogKeyFor(s, ev('j')), null);
  assert.equal(dialogKeyFor({ ...s, lane: 'idle' }, ev('1')), null);
  assert.equal(dialogKeyFor(null, ev('1')), null);
});

test('dialogKeyFor: the space bar ticks a multi-select option only where the daemon offers Space', () => {
  const multi = dialogStrip({ dialog: { question: 'Which fixtures?', options: [{ n: 1, label: '[ ] Unit', selected: true }, { n: 2, label: '[x] End to end' }] }, keys: ['1', '2', 'Space', 'Enter', 'Escape'] });
  assert.equal(dialogKeyFor(multi, ev('space')), 'Space');
  assert.equal(dialogKeyFor(multi, ev(' ')), 'Space', 'the bare character too');
  assert.equal(answerKeys(multi).find((k) => k.key === 'Space').label, 'tick');
  assert.equal(dialogKeyFor(dialogStrip(), ev('space')), null, 'elsewhere the space bar keeps paging');
});

test('the answer plan: sessions.answer by session (or window) with the hash, tmux.answer as the fallback', () => {
  assert.deepEqual(answerPlan(dialogStrip(), '1'), { primary: { op: 'sessions.answer', args: { id: 's1', key: '1', expect: 'abc123' } }, fallback: { op: 'tmux.answer', args: { target: 'demo:1', key: '1', expect: 'abc123' } } });
  const remote = answerPlan(dialogStrip({ host: 'devbox', kind: 'window', id: 'work:@3', tmux: 'work:@3' }), 'Escape');
  assert.deepEqual(remote.primary.args, { id: 'work:@3', key: 'Escape', expect: 'abc123', host: 'devbox' }, 'a window strip is answered by its target, on its host');
  assert.equal(answerPlan(dialogStrip({ hash: null }), 'Enter').primary.args.expect, undefined);
});

test('pressKey: sessions.answer; on "unknown op" tmux.answer, remembered; a refusal is an answer, not an error', async () => {
  const calls = [];
  const unknown = Object.assign(new Error('unknown op sessions.answer'), { unknownOp: true });
  const client = { call: async (op, args) => { calls.push([op, args]); if (op === 'sessions.answer') throw unknown; return { ok: true, key: args.key }; } };
  const caps = {};
  const r = await pressKey(client, dialogStrip(), '1', caps);
  assert.equal(r.via, 'tmux.answer');
  assert.equal(caps.answer, false);
  await pressKey(client, dialogStrip(), '2', caps);
  assert.deepEqual(calls.map(([op, a]) => [op, a.key]), [['sessions.answer', '1'], ['tmux.answer', '1'], ['tmux.answer', '2']], 'the second press skips the unknown op');
  const refusing = { call: async () => ({ ok: false, refused: true, reason: 'the screen changed since you read it; read it again', hash: 'new' }) };
  const rr = await pressKey(refusing, dialogStrip(), '1', {});
  assert.deepEqual([rr.refused, rr.via], [true, 'sessions.answer']);
  const failing = { call: async () => { throw new Error('session not found'); } };
  await assert.rejects(pressKey(failing, dialogStrip(), '1', {}), /session not found/);
});

test('reply: the inbox of a session, the pane of an agent seen only as a window', () => {
  assert.deepEqual(replyPlan(dialogStrip(), 'yes'), { op: 'sessions.message', args: { id: 's1', text: 'yes' } });
  assert.deepEqual(replyPlan(dialogStrip({ kind: 'window', host: 'devbox' }), 'go'), { op: 'tmux.send', args: { target: 'demo:1', text: 'go', host: 'devbox' } });
});

test('pressDrawn: the strip as it was drawn, or nothing, never another strip', () => {
  const app = { answers: [], toasts: [], answer(strip, key) { this.answers.push([strip.id, key, strip.hash]); }, toast(t) { this.toasts.push(t); } };
  const drawn = { key: 'local|s1', strip: dialogStrip() };
  assert.equal(pressDrawn(app, { ...dialogStrip(), hash: 'newer' }, drawn, ev('2')), true);
  assert.deepEqual(app.answers, [['s1', '2', 'abc123']], 'the drawn hash: a dialog that changed since is refused by the daemon');
  assert.equal(pressDrawn(app, null, drawn, ev('1')), true, 'the strip is gone');
  assert.equal(pressDrawn(app, dialogStrip({ lane: 'work' }), drawn, ev('1')), true, 'it is no longer waiting');
  assert.deepEqual(app.toasts, ['that dialog is gone; nothing was pressed', 'that dialog is gone; nothing was pressed']);
  assert.equal(pressDrawn(app, dialogStrip({ key: 'local|s2', id: 's2' }), drawn, ev('1')), true, 'another strip in its place');
  assert.match(app.toasts.at(-1), /screen changed before that key/);
  assert.equal(pressDrawn(app, dialogStrip(), null, ev('1')), true, 'never drawn: nothing pressed');
  assert.equal(app.answers.length, 1);
  assert.equal(pressDrawn(app, dialogStrip(), drawn, ev('j')), false, 'not a dialog key: the view handles it');
});
