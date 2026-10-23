import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { boardModel, replyState } from '../lib/board.js';
import { normalizeSummary } from '../lib/summary.js';

const fx = (n) => normalizeSummary(JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), 'utf8')));
const now = Date.parse('2026-10-11T18:00:00.000Z');

test('null entry is empty', () => {
  const m = boardModel(null, now);
  assert.equal(m.status, 'empty');
  assert.deepEqual(m.waiting, []);
  assert.equal(m.totals.waiting, 0);
});

test('error only', () => {
  const m = boardModel({ at: now, data: null, error: { kind: 'unreachable', message: 'Cannot reach' } }, now);
  assert.equal(m.status, 'error');
  assert.equal(m.error.kind, 'unreachable');
});

test('stale keeps data and error', () => {
  const m = boardModel({ at: now - 300_000, data: fx('native-summary'), error: { kind: 'server', message: 'boom' } }, now);
  assert.equal(m.status, 'stale');
  assert.equal(m.waiting.length, 3);
  assert.equal(m.updated, '5m');
});

test('ok with fixture', () => {
  const m = boardModel({ at: now, data: fx('native-summary'), error: null }, now);
  assert.equal(m.status, 'ok');
  assert.deepEqual(m.waiting.map((s) => s.name), ['demo-review', 'demo-build', 'demo-docs']);
  assert.deepEqual(m.waiting.map((s) => s.ago), ['20m', '8m', '2m']);
  assert.equal(m.waiting[0].kindLabel, 'Asked a question');
  assert.equal(m.waiting[1].kindLabel, 'Needs a decision');
  assert.equal(m.waiting[0].key, 'local\u000011111111-aaaa-4bbb-8ccc-000000000002');
  assert.equal(m.working.length, 2);
  assert.ok(m.working[0].key);
  assert.deepEqual(m.idle, { total: 3, byHost: [{ name: 'local', idle: 3 }] });
  assert.deepEqual(m.hosts.map((h) => h.label), ['', '', 'offline']);
  assert.equal(m.manager.up, true);
  assert.equal(m.updated, 'now');
});

test('empty fixture', () => {
  const m = boardModel({ at: now, data: fx('native-summary-empty'), error: null }, now);
  assert.equal(m.status, 'ok');
  assert.equal(m.waiting.length, 0);
  assert.equal(m.idle.total, 4);
  assert.equal(m.manager.up, false);
});

test('replyState transitions', () => {
  let s = replyState(null, { type: 'send' });
  assert.equal(s.phase, 'sending');
  assert.equal(replyState(s, { type: 'send' }), s);
  assert.equal(replyState(s, { type: 'ok', queued: false }).message, 'Sent');
  const q = replyState(s, { type: 'ok', queued: true });
  assert.equal(q.phase, 'queued');
  assert.equal(q.message, 'Queued: the session is busy');
  const f = replyState(s, { type: 'fail', message: 'nope' });
  assert.deepEqual(f, { phase: 'error', message: 'nope' });
  assert.equal(replyState(f, { type: 'edit' }).phase, 'idle');
  assert.equal(replyState(q, { type: 'edit' }).phase, 'idle');
  assert.equal(replyState(s, { type: 'edit' }), s);
});

test('panelPoll: the board is read on the poll only while the stream is down', async () => {
  const { panelPoll } = await import('../lib/board.js');
  const base = { now: 100_000, lastTranscript: 0, lastBoard: 0 };
  assert.deepEqual(panelPoll({ ...base, live: false, streaming: false }), { transcript: true, board: true, dropBoard: false });
  // Live: board events keep it current; the transcript is read less often while turns stream in.
  assert.deepEqual(panelPoll({ ...base, live: true, streaming: true }), { transcript: true, board: false, dropBoard: false });
  assert.equal(panelPoll({ ...base, live: true, streaming: true, lastTranscript: 90_000 }).transcript, false);
  assert.equal(panelPoll({ ...base, live: true, streaming: false, lastTranscript: 90_000 }).transcript, true);
  // Down: the board every 10 s, not on every tick.
  assert.equal(panelPoll({ ...base, live: false, streaming: false, lastBoard: 95_000 }).board, false);
  assert.equal(panelPoll({ ...base, live: false, streaming: false, lastBoard: 90_000 }).board, true);
  // A board that cannot be read again for a minute gives way to the summary the worker keeps fresh.
  assert.equal(panelPoll({ ...base, live: false, streaming: false, lastBoard: 30_000, boardFailedAt: 99_000 }).dropBoard, true);
  assert.equal(panelPoll({ ...base, live: false, streaming: false, lastBoard: 50_000, boardFailedAt: 99_000 }).dropBoard, false);
  assert.equal(panelPoll({ ...base, live: true, streaming: false, lastBoard: 30_000, boardFailedAt: 99_000 }).dropBoard, false);
});
