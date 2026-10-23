// The compact board and the answer fields (core/native.js: answerFields, buildBoard, the waiting items of
// buildSummary, dialog alerts in buildNotifications) and fleet slimming (core/api.js slimSessions). Synthetic data.
import './isolate-cache.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const native = await import('../core/native.js');
const { answerFields, buildBoard, buildSummary, buildNotifications } = native;
const { slimSessions } = await import('../core/api.js');

const NOW = Date.parse('2026-10-20T18:00:00Z');
const sess = (id, name, status, extra = {}) => ({ id, sessionId: id, name, live: true, status, engine: 'claude', cwd: '/Users/demo/code/demo-app', tmux: `demo:@1${id.slice(-1)}.%1`, statusUpdatedAt: NOW - 60_000, ...extra });
const permission = { question: 'Do you want to proceed?', options: [{ n: 1, label: 'Yes', selected: true }, { n: 2, label: "Yes, and don't ask again for npm commands" }, { n: 3, label: 'No, and tell Claude what to do differently (esc)' }] };
const fleet = {
  ts: NOW,
  hosts: [
    {
      host: 'local', ok: true, ms: 120,
      sessions: [sess('s1', 'demo-build', 'idle'), sess('s2', 'demo-work', 'busy'), sess('s3', 'demo-idle', 'idle', { statusUpdatedAt: NOW - 3600_000 }), sess('s4', 'demo-held', 'idle')],
      windows: [
        { target: 'demo:@11', name: 'build', screen: { state: 'dialog' }, dialog: permission, hash: 'abc123def4567890', agent: { sessionId: 's1' }, tail: ['Bash command', 'npm test'], activityTs: NOW - 30_000 },
        { target: 'demo:@12', name: 'work', screen: { state: 'busy' }, agent: { sessionId: 's2' }, tail: ['Running tests', '', 'token=abcd1234secretvalue9 in log'] },
        { target: 'demo:@14', name: 'held', screen: { state: 'idle' }, held: true, heldFrom: 'demo-review', dialog: { question: null, options: [] }, hash: 'feedfacecafebeef', agent: { sessionId: 's4' }, tail: [] },
        { target: 'demo:@20', name: 'shell-codex', screen: { state: 'dialog' }, dialog: { question: 'Allow command? (y/n)', options: [] }, hash: '0011223344556677', agent: { engine: 'codex', status: 'unknown' }, tail: ['Allow command? (y/n)'] },
      ],
    },
    { host: 'demo-box', ok: true, sessions: [{ id: 'manager', name: 'manager', engine: 'openclaw', live: true, status: 'busy' }], windows: [] },
    { host: 'demo-lab', ok: false, error: 'ssh: connect timed out', sessions: [], windows: [], fallback: { source: 'inventory' } },
  ],
};

test('answerFields: a permission dialog takes its digits, Enter and Escape, never y or n', () => {
  const a = answerFields({ screen: 'dialog', dialog: permission, hash: 'h1' });
  assert.equal(a.answer, 'keys');
  assert.deepEqual(a.keys, ['1', '2', '3', 'Enter', 'Escape']);
  assert.equal(a.hash, 'h1');
  assert.deepEqual(a.dialog.options.map((o) => [o.n, o.selected ?? false]), [[1, true], [2, false], [3, false]]);
  assert.equal(a.dialog.question, 'Do you want to proceed?');
});

test('answerFields: y and n only where the prompt takes them; a held message is deliver or drop; a text question is a reply', () => {
  assert.deepEqual(answerFields({ screen: 'dialog', dialog: { question: 'Overwrite? (y/n)', options: [] } }).keys, ['y', 'n', 'Enter', 'Escape']);
  assert.deepEqual(answerFields({ screen: 'dialog', dialog: { question: 'Go?', options: [{ n: 1, label: 'Yes, proceed (y)' }, { n: 2, label: 'No (n)' }] } }).keys, ['1', '2', 'y', 'n', 'Enter', 'Escape']);
  assert.deepEqual(answerFields({ held: true, dialog: { question: null, options: [] }, hash: 'h2' }).keys, ['Enter', 'Escape']);
  assert.deepEqual(answerFields({ screen: 'idle', ask: { kind: 'question', text: 'Ship it?' } }), { answer: 'reply' });
  assert.deepEqual(answerFields({ screen: 'idle', ask: { kind: 'finished' } }), {});
  assert.deepEqual(answerFields({}), {});
  assert.deepEqual(answerFields({ screen: 'dialog', dialog: { question: 'Which?', options: [{ n: 1, label: '[ ] Lexer' }, { n: 2, label: '[x] Parser' }] } }).keys, ['1', '2', 'Space', 'Enter', 'Escape'], 'multi-select: Space ticks');
  const many = answerFields({ screen: 'dialog', dialog: { options: Array.from({ length: 12 }, (_, i) => ({ n: i + 1, label: `option ${i + 1}` })) } });
  assert.deepEqual(many.keys.slice(0, -2), ['1', '2', '3', '4', '5', '6', '7', '8', '9'], 'digits 1 to 9 only');
  const dirty = answerFields({ screen: 'dialog', dialog: { question: 'Use api_key=sk-abcdefghij1234567890?', options: [{ n: 1, label: '\x1b[1mYes\x1b[0m' }] } });
  assert.ok(!dirty.dialog.question.includes('sk-abcdefghij'), 'question text is cleaned');
  assert.equal(dirty.dialog.options[0].label, 'Yes');
});

test('native.summary waiting items carry what answering them needs', () => {
  const s = buildSummary(fleet, [], { now: NOW });
  const build = s.waiting.find((w) => w.id === 's1');
  assert.deepEqual([build.answer, build.hash, build.keys], ['keys', 'abc123def4567890', ['1', '2', '3', 'Enter', 'Escape']]);
  const held = s.waiting.find((w) => w.id === 's4');
  assert.deepEqual(held.keys, ['Enter', 'Escape']);
  const codex = s.waiting.find((w) => w.id === 'demo:@20');
  assert.deepEqual(codex.keys, ['y', 'n', 'Enter', 'Escape'], 'a window-only agent answers by its window target');
  assert.ok(!JSON.stringify(s).includes('demo:@11'), 'still no tmux targets for a session in the widget-token op');
});

test('the widget-token ops name no paths in dialog text; the board keeps them', () => {
  const pathy = { hosts: [{ host: 'local', ok: true, sessions: [sess('s9', 'demo-path', 'idle')], windows: [
    { target: 'demo:@19', screen: { state: 'dialog' }, dialog: { question: 'Edit /Users/demo/code/demo-app/src/a.js?', options: [{ n: 1, label: 'Yes' }, { n: 2, label: "Yes, and don't ask again for edits in ~/code/demo-app" }] }, hash: 'aa', agent: { sessionId: 's9' }, tail: [] }] }] };
  const w = buildSummary(pathy, [], { now: NOW }).waiting[0];
  assert.equal(w.dialog.question, 'Edit a.js?');
  assert.equal(w.dialog.options[1].label, "Yes, and don't ask again for edits in demo-app");
  assert.ok(!JSON.stringify(w.dialog).includes('/code/'), 'dialog text names no paths (the headline keeps its own home-as-~ rule)');
  const strip = buildBoard(pathy, [], { now: NOW }).strips[0];
  assert.equal(strip.dialog.question, 'Edit ~/code/demo-app/src/a.js?', 'the main-token board keeps the path (home as ~)');
  assert.equal(native.noPaths('rm -rf /tmp/build/out/ and ~/x'), 'rm -rf out and x');
});

test('native.board: strips in board order with windows, short cwd, cleaned text, answer fields; hosts and manager', () => {
  const b = buildBoard(fleet, [], { now: NOW });
  assert.deepEqual(b.strips.map((s) => `${s.lane}:${s.name}`).slice(0, 3).map((x) => x.split(':')[0]), ['wait', 'wait', 'wait']);
  assert.deepEqual(b.strips.map((s) => s.lane), [...b.strips.map((s) => s.lane)].sort((x, y) => ({ wait: 0, work: 1, idle: 2 }[x] - { wait: 0, work: 1, idle: 2 }[y])));
  const build = b.strips.find((s) => s.id === 's1');
  assert.equal(build.tmux, 'demo:@11');
  assert.equal(build.cwd, '~/code/demo-app');
  assert.equal(build.key, 'local|s1');
  assert.deepEqual(build.keys, ['1', '2', '3', 'Enter', 'Escape']);
  assert.equal(build.hash, 'abc123def4567890');
  assert.equal(build.dialog.options.length, 3);
  const work = b.strips.find((s) => s.id === 's2');
  assert.equal(work.lane, 'work');
  assert.ok(!JSON.stringify(work).includes('abcd1234secretvalue9'), 'tail lines are cleaned');
  assert.equal(work.keys, undefined, 'only waiting strips carry keys');
  assert.deepEqual(b.totals, { waiting: 3, working: 2, idle: 1, hosts: 3 }, 'a busy manager counts as working');
  assert.deepEqual(b.hosts.map((h) => [h.name, h.up, h.waiting, h.working, h.stale ?? false]), [['local', true, 3, 1, false], ['demo-box', true, 0, 1, false], ['demo-lab', false, 0, 0, true]]);
  assert.equal(b.hosts[2].error, 'ssh: connect timed out');
  assert.deepEqual([b.manager.up, b.manager.host, b.manager.status], [true, 'demo-box', 'busy']);
  assert.ok(JSON.stringify(b).length < 6000, 'a few KB, not a megabyte');
  assert.ok(b.hosts.every((h) => !('ms' in h)), 'no per-fetch timing: a board is re-sent only when what it shows changed');
});

test('native.notifications: a dialog alert with a session carries dialog, hash and keys; others do not', () => {
  const alerts = [
    { id: 'n1', ts: new Date(NOW - 5000).toISOString(), category: 'needs-you', kind: 'dialog', sessionId: 's1', host: 'local', target: 'demo:@11', title: 'demo-build needs a decision', body: 'Do you want to proceed? 1. Yes / 2. No', ask: { kind: 'decision', text: 'Do you want to proceed?' }, meta: { hash: 'abc123def4567890', options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }] } },
    { id: 'n2', ts: new Date(NOW - 4000).toISOString(), category: 'held', kind: 'held-message', sessionId: 's4', host: 'local', title: 'demo-held is holding a peer message', body: 'deliver or drop it', meta: { hash: 'feedfacecafebeef', options: [] } },
    { id: 'n3', ts: new Date(NOW - 3000).toISOString(), category: 'finished', kind: 'busy-idle', sessionId: 's2', host: 'local', title: 'demo-work finished', body: '' },
    { id: 'n4', ts: new Date(NOW - 2000).toISOString(), category: 'needs-you', kind: 'dialog', host: 'local', target: 'demo:@20', title: 'shell needs a decision', body: '', meta: { hash: '0011', options: [] } },
  ];
  const { items } = buildNotifications(alerts, { now: NOW });
  const by = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.deepEqual([by.n1.answer, by.n1.hash, by.n1.keys], ['keys', 'abc123def4567890', ['1', '2', 'Enter', 'Escape']]);
  assert.deepEqual(by.n2.keys, ['Enter', 'Escape']);
  assert.equal(by.n3.keys, undefined);
  assert.equal(by.n4.keys, undefined, 'no session to answer by: the widget-token feed names no tmux targets');
  const hook = buildNotifications([{ id: 'n5', ts: new Date(NOW - 1000).toISOString(), category: 'needs-you', kind: 'permission_prompt', source: 'hook', sessionId: 's1', host: 'local', title: 'demo-build needs a decision', body: '', ask: { kind: 'decision', text: 'Do you want to proceed?' }, meta: { hash: 'h5', options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }] } }], { now: NOW }).items[0];
  assert.deepEqual([hook.hash, hook.keys], ['h5', ['1', '2', 'Enter', 'Escape']], 'a hook alert on a dialog answers like a dialog alert');
  assert.ok(!JSON.stringify(items).includes('demo:@'), 'no tmux targets');
});

test('native.notifications names this machine local, the host value every other op takes back', () => {
  const a = { id: 'l1', ts: new Date(NOW - 1000).toISOString(), category: 'needs-you', kind: 'dialog', sessionId: 's1', host: 'demo-mac', title: 't', body: '', meta: { hash: 'h', options: [] } };
  const { items } = buildNotifications([a, { ...a, id: 'l2', host: 'demo-box' }], { now: NOW, localNames: new Set(['demo-mac']) });
  assert.deepEqual(items.map((i) => i.host), ['local', 'demo-box']);
});

test('slimSessions keeps what a board or the alert detector reads, and cuts previews', () => {
  const list = [
    { id: 'a', engine: 'claude', live: true, status: 'busy' },
    { id: 'b', engine: 'claude', live: false, status: 'dead' },
    { id: 'c', engine: 'codex', live: false, status: 'notLoaded', preview: 'x'.repeat(5000) },
    { id: 'd', engine: 'codex', live: true, status: 'active', preview: 'y'.repeat(5000) },
    { id: 'e', kind: 'headless', engine: 'claude', live: false, status: 'exited', exitCode: 1 },
    { id: 'f', engine: 'openclaw', live: true, status: 'ready' },
  ];
  const out = slimSessions(list);
  assert.deepEqual(out.map((s) => s.id), ['a', 'b', 'd', 'e', 'f']);
  assert.equal(out.find((s) => s.id === 'd').preview.length, 200);
  assert.equal(list[3].preview.length, 5000, 'the input is not changed');
});
