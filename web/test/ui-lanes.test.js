// Board lanes (ui/lanes.js), shared by the board, the waiting window and the badge count.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripsFor, waiting } from '../ui/lanes.js';

const now = Date.parse('2026-10-11T22:00:00Z');
const host = (sessions, windows = []) => ({ host: 'h', sessions, windows });
const sess = (status, extra = {}) => ({ id: 'a', sessionId: 'a', live: true, status, tmux: 'w:@1.%1', ...extra });

test('a dialog or a held peer message on screen is waiting; busy is working; else idle', () => {
  assert.equal(stripsFor(host([sess('idle')], [{ target: 'w:@1', screen: { state: 'dialog' }, agent: { sessionId: 'a' } }]), {}, now)[0].lane, 'wait');
  assert.equal(stripsFor(host([sess('idle')], [{ target: 'w:@1', screen: { state: 'idle' }, held: true, agent: { sessionId: 'a' } }]), {}, now)[0].lane, 'wait');
  assert.equal(stripsFor(host([sess('busy')]), {}, now)[0].lane, 'work');
  assert.equal(stripsFor(host([sess('idle')]), {}, now)[0].lane, 'idle');
});
test('a hook ask waits until the session moves on (status changed after it), and expires after 20 minutes', () => {
  const ask = { a: { ts: '2026-10-11T21:50:00Z', message: 'Claude needs your permission' } };
  assert.equal(stripsFor(host([sess('idle', { statusUpdatedAt: Date.parse('2026-10-11T21:49:00Z') })]), ask, now)[0].lane, 'wait');
  assert.equal(stripsFor(host([sess('idle', { statusUpdatedAt: Date.parse('2026-10-11T21:55:00Z') })]), ask, now)[0].lane, 'idle');
  assert.equal(stripsFor(host([sess('idle')]), { a: { ts: '2026-10-11T21:30:00Z', message: 'x' } }, now)[0].lane, 'idle');
});
test('waiting() reads the fleet summary across hosts', () => {
  const state = { fleet: { hosts: [host([sess('idle')], [{ target: 'w:@1', screen: { state: 'dialog' }, agent: { sessionId: 'a' } }]), { host: 'b', sessions: [], windows: [] }] } };
  assert.equal(waiting(state, now).length, 1);
});
test('only decisions and questions wait; a finished ask and its excerpt sit in idle', () => {
  const q = { a: { ts: '2026-10-11T21:59:00Z', message: 'Claude is waiting for your input', ask: { kind: 'question', label: 'asked you a question', text: 'Push now?' } } };
  const s1 = stripsFor(host([sess('idle')]), q, now)[0];
  assert.deepEqual([s1.lane, s1.ask.label, s1.tail[0]], ['wait', 'asked you a question', 'Push now?']);
  const f = { a: { ts: '2026-10-11T21:59:00Z', message: 'Claude is waiting for your input', ask: { kind: 'finished', label: 'finished, no question pending', text: 'x' } } };
  assert.equal(stripsFor(host([sess('idle')]), f, now)[0].lane, 'idle');
  const fin = { a: { ts: '2026-10-11T21:58:00Z', category: 'finished', ask: { kind: 'finished', text: '…all tests pass.' } } };
  const s2 = stripsFor(host([sess('idle')]), {}, now, fin)[0];
  assert.deepEqual([s2.lane, s2.finished.text, s2.tail[0]], ['idle', '…all tests pass.', '…all tests pass.']);
  const dlg = stripsFor(host([sess('idle')], [{ target: 'w:@1', screen: { state: 'dialog' }, dialog: { question: 'Do you want to proceed?', options: [{ n: 1, label: 'Yes' }] }, agent: { sessionId: 'a' } }]), {}, now)[0];
  assert.deepEqual([dlg.ask.label, dlg.ask.text, dlg.ask.options.length], ['needs a decision', 'Do you want to proceed?', 1]);
});
test('a Grok bot that reported needs-owner or blocked waits until its next status, not only while its alert is fresh', () => {
  const bot = (status, state) => ({ id: 'grok:scout', sessionId: 'grok:scout', engine: 'grok', live: true, status, state, summary: 'which region?', statusUpdatedAt: Date.parse('2026-10-11T20:00:00Z') });
  const [s] = stripsFor(host([bot('waiting', 'needs-owner')]), {}, now);   // two hours on, its alert long expired
  assert.deepEqual([s.lane, s.ask.label, s.question, s.asked], ['wait', 'needs you', 'which region?', true]);
  assert.equal(stripsFor(host([bot('waiting', 'blocked')]), {}, now)[0].ask.label, 'is blocked');
  assert.equal(stripsFor(host([bot('busy', 'working')]), {}, now)[0].lane, 'work', 'its next status moves it on');
  assert.equal(stripsFor(host([bot('idle', 'done')]), {}, now)[0].lane, 'idle');
  assert.equal(stripsFor(host([sess('waiting', { engine: 'claude' })]), {}, now)[0].lane, 'idle', 'other engines still need a live ask');
});
