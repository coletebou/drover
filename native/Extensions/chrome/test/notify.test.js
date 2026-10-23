import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encodeNotificationId, decodeNotificationId, shouldShow, planNotifications, notificationOptions, overflowOptions } from '../lib/notify.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/native-notifications.json', import.meta.url), 'utf8'));
const fxResp = fx.result ?? fx;
const ALL = { enabled: true, decision: true, question: true, finished: true };

test('id round trip with awkward chars', () => {
  const v = { host: 'my box|x', sessionId: 'a b|c', id: 'n|1 2' };
  const nid = encodeNotificationId(v);
  assert.equal(nid.split('|').length, 4);
  assert.deepEqual(decodeNotificationId(nid), v);
});

test('id format and defaults', () => {
  assert.equal(encodeNotificationId({ host: '', sessionId: null, id: 'n-1' }), 'drover|local||n-1');
  assert.deepEqual(decodeNotificationId('drover|local||n-1'), { host: 'local', sessionId: '', id: 'n-1' });
});

test('non Drover ids decode to null', () => {
  assert.equal(decodeNotificationId('other|a|b|c'), null);
  assert.equal(decodeNotificationId('drover|overflow'), null);
  assert.equal(decodeNotificationId('drover|a|b|c|d'), null);
  assert.equal(decodeNotificationId(undefined), null);
  assert.equal(decodeNotificationId('drover|%E0%A4%A|b|c'), null);
});

test('shouldShow matrix', () => {
  assert.equal(shouldShow({ kind: 'decision' }, { ...ALL, enabled: false }), false);
  assert.equal(shouldShow({ kind: 'mr', test: true }, { ...ALL, enabled: false }), false);
  assert.equal(shouldShow({ kind: 'mr', test: true }, ALL), true);
  for (const k of ['decision', 'question', 'finished']) {
    assert.equal(shouldShow({ kind: k }, ALL), true);
    assert.equal(shouldShow({ kind: k }, { ...ALL, [k]: false }), false);
  }
  for (const k of ['error', 'mr', 'launch', 'manager', 'weird', undefined]) assert.equal(shouldShow({ kind: k }, ALL), false);
});

test('baseline shows nothing and seeds seen', () => {
  const p = planNotifications({ cursor: null, seen: [], response: fxResp, settings: ALL });
  assert.deepEqual(p.show, []);
  assert.equal(p.overflow, 0);
  assert.equal(p.cursor, 'c-0004');
  assert.deepEqual(p.seen, ['n-0001', 'n-0002', 'n-0003', 'n-0004']);
});

test('normal tick filters by kind and settings', () => {
  const p = planNotifications({ cursor: 'c-0', seen: [], response: fxResp, settings: { ...ALL, finished: false } });
  assert.deepEqual(p.show.map((i) => i.id), ['n-0001', 'n-0002']);
  const q = planNotifications({ cursor: 'c-0', seen: [], response: fxResp, settings: ALL });
  assert.deepEqual(q.show.map((i) => i.id), ['n-0001', 'n-0002', 'n-0003']);
});

test('dedupe via seen', () => {
  const p = planNotifications({ cursor: 'c-0', seen: ['n-0001', 'n-0002'], response: fxResp, settings: ALL });
  assert.deepEqual(p.show.map((i) => i.id), ['n-0003']);
  assert.deepEqual(p.seen, ['n-0001', 'n-0002', 'n-0003', 'n-0004']);
});

test('max and overflow keep the most recent', () => {
  const items = Array.from({ length: 7 }, (_, i) => ({ id: `i${i}`, kind: 'decision' }));
  const p = planNotifications({ cursor: 'c', seen: [], response: { cursor: 'c2', items }, settings: ALL });
  assert.deepEqual(p.show.map((i) => i.id), ['i4', 'i5', 'i6']);
  assert.equal(p.overflow, 4);
  const q = planNotifications({ cursor: 'c', seen: [], response: { cursor: 'c2', items }, settings: ALL, max: 5 });
  assert.equal(q.show.length, 5);
  assert.equal(q.overflow, 2);
});

test('seen is capped at 200, dropping oldest', () => {
  const seen = Array.from({ length: 199 }, (_, i) => `s${i}`);
  const items = [{ id: 'a', kind: 'x' }, { id: 'b', kind: 'x' }, { id: 'c', kind: 'x' }];
  const p = planNotifications({ cursor: 'c', seen, response: { cursor: 'c2', items }, settings: ALL });
  assert.equal(p.seen.length, 200);
  assert.equal(p.seen[0], 's2');
  assert.equal(p.seen.at(-1), 'c');
});

test('malformed responses', () => {
  for (const response of [null, undefined, {}, { cursor: '', items: 'no' }, 'str']) {
    const p = planNotifications({ cursor: 'old', seen: ['x'], response, settings: ALL });
    assert.equal(p.cursor, 'old');
    assert.deepEqual(p.show, []);
    assert.deepEqual(p.seen, ['x']);
  }
  assert.equal(planNotifications({ cursor: null, seen: [], response: {}, settings: ALL }).cursor, null);
});

test('notificationOptions', () => {
  const o = notificationOptions({ kind: 'decision', title: 'T', body: 'B', host: 'demo-box', sessionId: 's1' }, { iconUrl: 'u' });
  assert.deepEqual(o, { type: 'basic', iconUrl: 'u', title: 'T', message: 'B', contextMessage: 'demo-box', priority: 2, requireInteraction: true, buttons: [{ title: 'Reply' }, { title: 'Open' }], silent: false });
  const p = notificationOptions({ kind: 'finished', title: '', body: 'x'.repeat(500), host: 'local', sessionId: null }, { iconUrl: 'u' });
  assert.equal('contextMessage' in p, false);
  assert.equal(p.title, 'Drover');
  assert.equal(p.priority, 1);
  assert.equal(p.requireInteraction, false);
  assert.equal('buttons' in p, false);
  assert.ok(p.message.length <= 200);
  assert.equal(notificationOptions({ kind: 'question', title: 'q' }, { iconUrl: 'u' }).requireInteraction, true);
  assert.ok(notificationOptions({ title: 'y'.repeat(300) }, { iconUrl: 'u' }).title.length <= 80);
});

test('overflowOptions', () => {
  assert.equal(overflowOptions(4, { iconUrl: 'u' }).message, '4 more alerts. Open the popup to see them.');
  assert.match(overflowOptions(1, { iconUrl: 'u' }).message, /^1 more alert\./);
  assert.equal(overflowOptions(2, { iconUrl: 'u' }).priority, 0);
});
