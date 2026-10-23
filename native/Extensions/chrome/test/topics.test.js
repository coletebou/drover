// SSE topics: each page asks only for what it draws; events route by name; a daemon that ignores topics falls
// back to refresh-on-event.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { POPUP_TOPICS, PANEL_TOPICS, routeEvent, honoursTopics } from '../lib/topics.js';
import { createClient } from '../lib/api.js';
import { normalizeBoard } from '../lib/summary.js';
import { dialogActions, notificationOptions } from '../lib/notify.js';

test('the stream request names the topics, the token stays in the header', () => {
  const c = createClient({ baseUrl: 'http://127.0.0.1:7338', token: 'test-token-not-secret' });
  const r = c.streamRequest({ topics: POPUP_TOPICS });
  assert.equal(r.url, 'http://127.0.0.1:7338/api/stream?topics=summary,alerts,manager,turn');
  assert.equal(r.init.headers.authorization, 'Bearer test-token-not-secret');
  assert.ok(!r.url.includes('token'));
  assert.equal(c.streamRequest().url, 'http://127.0.0.1:7338/api/stream');
  assert.equal(c.streamRequest({ topics: ['turn', 'bad topic', 'x&y=1'] }).url, 'http://127.0.0.1:7338/api/stream?topics=turn');
  assert.deepEqual(PANEL_TOPICS, ['turn', 'manager', 'board']);
});

test('routeEvent', () => {
  assert.deepEqual(routeEvent('hello', { topics: ['summary'] }, POPUP_TOPICS), { kind: 'hello', data: { topics: ['summary'] } });
  assert.equal(routeEvent('summary', { waiting: [] }, POPUP_TOPICS).kind, 'summary');
  assert.equal(routeEvent('summary', 'not json', POPUP_TOPICS).kind, 'ignore');
  assert.equal(routeEvent('board', { strips: [] }, POPUP_TOPICS).kind, 'ignore', 'not asked for: a daemon that ignored topics');
  assert.equal(routeEvent('board', { strips: [] }, PANEL_TOPICS).kind, 'board');
  assert.equal(routeEvent('turn', { id: 'manager', turn: { role: 'user' } }, PANEL_TOPICS).kind, 'turn');
  assert.equal(routeEvent('turn', { id: 'manager' }, PANEL_TOPICS).kind, 'ignore');
  assert.equal(routeEvent('manager', { phase: 'delta' }, POPUP_TOPICS).kind, 'manager');
  for (const legacy of ['fleet', 'snapshot', 'mutation', 'notify']) assert.equal(routeEvent(legacy, {}, POPUP_TOPICS).kind, 'legacy', legacy);
  assert.equal(routeEvent('probe', {}, POPUP_TOPICS).kind, 'ignore');
  assert.equal(honoursTopics({ host: 'x', topics: ['turn'] }), true);
  assert.equal(honoursTopics({ host: 'x' }), false);
  assert.equal(honoursTopics(null), false);
});

test('normalizeBoard keeps windows and dialog fields, and the manager', () => {
  const b = normalizeBoard(JSON.parse(readFileSync(new URL('./fixtures/native-board.json', import.meta.url), 'utf8')));
  assert.equal(b.strips.length, 4);
  const build = b.strips[0];
  assert.equal(build.tmux, 'demo:1');
  assert.equal(build.lane, 'wait');
  assert.deepEqual(build.keys, ['1', '2', '3', 'Enter', 'Escape']);
  assert.equal(b.strips[2].kind, 'window');
  assert.deepEqual(b.manager, { up: true, host: 'local', status: 'ready', lastNoteAt: '2026-10-20T17:30:00.000Z' });
  assert.deepEqual(normalizeBoard(null), { generatedAt: null, strips: [], manager: null });
});

test('dialog alerts get Approve and Deny (Deliver and Drop when held), only with a session, the hash and both keys', () => {
  const item = { id: 'n-1', kind: 'decision', category: 'needs-you', title: 'demo-build needs a decision', body: 'Do you want to proceed?', sessionId: 's-1', host: 'local', hash: 'h-1', keys: ['1', '2', 'Enter', 'Escape'], answer: 'keys', dialog: { question: 'Do you want to proceed?', options: [{ n: 1, label: 'Yes' }] } };
  assert.deepEqual(dialogActions(item), { id: 's-1', host: 'local', hash: 'h-1', keys: ['1', '2', 'Enter', 'Escape'], buttons: [{ title: 'Approve (Enter)', key: 'Enter' }, { title: 'Deny (Esc)', key: 'Escape' }] });
  assert.deepEqual(notificationOptions(item, { iconUrl: 'u' }).buttons, [{ title: 'Approve (Enter)' }, { title: 'Deny (Esc)' }]);
  assert.deepEqual(dialogActions({ ...item, category: 'held', keys: ['Enter', 'Escape'] }).buttons.map((b) => b.title), ['Deliver (Enter)', 'Drop (Esc)']);
  for (const bad of [{ hash: undefined }, { sessionId: null }, { keys: ['1', '2'] }, { answer: 'reply' }]) {
    const x = { ...item, ...bad };
    assert.equal(dialogActions(x), null, JSON.stringify(bad));
    assert.deepEqual(notificationOptions(x, { iconUrl: 'u' }).buttons ?? null, x.sessionId ? [{ title: 'Reply' }, { title: 'Open' }] : null);
  }
});

test('a remembered dialog alert is bound to the server that raised it', async () => {
  const { rememberDialog, dialogPress, OTHER_SERVER } = await import('../lib/notify.js');
  const item = { id: 'n-1', kind: 'decision', category: 'needs-you', sessionId: 's-1', host: 'local', hash: 'h-1', keys: ['1', 'Enter', 'Escape'], answer: 'keys' };
  const r = rememberDialog(item, 'http://127.0.0.1:7338', 1000);
  assert.deepEqual(r, { id: 's-1', host: 'local', hash: 'h-1', keys: ['1', 'Enter', 'Escape'], server: 'http://127.0.0.1:7338', at: 1000 });
  assert.equal(JSON.stringify(r).includes('token'), false);
  assert.deepEqual(dialogPress(r, 0, 'http://127.0.0.1:7338'), { key: 'Enter' });
  assert.deepEqual(dialogPress(r, 1, 'http://127.0.0.1:7338'), { key: 'Escape' });
  // After the server changed, an old alert's press is refused, not sent to the new daemon.
  assert.deepEqual(dialogPress(r, 0, 'http://100.64.0.9:7337'), { refused: OTHER_SERVER });
  // Entries remembered before the binding existed carry no server: refused too.
  assert.deepEqual(dialogPress({ id: 's-1', host: 'local', hash: 'h-1', keys: ['Enter'] }, 0, 'http://127.0.0.1:7338'), { refused: OTHER_SERVER });
  assert.equal(rememberDialog(item, ''), null);
  assert.equal(rememberDialog({ ...item, hash: '' }, 'http://127.0.0.1:7338'), null);
});
