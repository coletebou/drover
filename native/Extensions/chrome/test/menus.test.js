import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MENU, menuSpec, parseMenuId, menuSignature, composeText, childId, childTitle } from '../lib/menus.js';
import { normalizeSummary, targetSessions } from '../lib/summary.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/native-summary.json', import.meta.url), 'utf8'));
const sessions = targetSessions(normalizeSummary(fx));
const mk = (name, host, id, state = 'working') => ({ id, name, host, state });

test('menuSpec structure', () => {
  const spec = menuSpec(sessions);
  assert.deepEqual(spec.slice(0, 3).map((p) => p.id), ['drover-sel', 'drover-page', 'drover-link']);
  assert.deepEqual(spec[0], { id: 'drover-sel', title: 'Send selection to session', contexts: ['selection'] });
  assert.equal(spec.length, 3 + 3 * (5 + 1));
  const kids = spec.filter((p) => p.parentId === MENU.PAGE);
  assert.equal(kids.length, 6);
  assert.ok(kids[0].title.startsWith('Waiting: '));
  assert.equal(kids[0].title, 'Waiting: demo-review (local)');
  assert.ok(!kids[4].title.startsWith('Waiting'));
  assert.deepEqual(kids[5], { id: 'drover-page|pick', parentId: 'drover-page', title: 'Choose in side panel', contexts: ['page'] });
  assert.deepEqual(kids[0].contexts, ['page']);
});

test('menuSpec max cap', () => {
  const spec = menuSpec(sessions, { max: 2 });
  assert.equal(spec.filter((p) => p.parentId === MENU.LINK).length, 3);
});

test('no sessions', () => {
  const spec = menuSpec([]);
  assert.equal(spec.length, 6);
  assert.deepEqual(spec[3], { id: 'drover-sel|none', parentId: 'drover-sel', title: 'No active sessions', contexts: ['selection'], enabled: false });
  assert.ok(!spec.some((p) => p.id.endsWith('|pick')));
});

test('ampersand escaped', () => {
  assert.equal(childTitle(mk('a&b', 'h&1', 'x')), 'a&&b (h&&1)');
});

test('parseMenuId round trip', () => {
  const s = mk('n', 'ho|st/1', 'id|with/odd%chars');
  const id = childId(MENU.LINK, s);
  assert.equal(id.split('|').length, 3);
  assert.deepEqual(parseMenuId(id), { parent: 'drover-link', host: 'ho|st/1', sessionId: 'id|with/odd%chars' });
  assert.deepEqual(parseMenuId('drover-sel|pick'), { parent: 'drover-sel', pick: true });
});

test('parseMenuId rejects', () => {
  for (const id of ['drover-sel|none', 'drover-sel', 'other|a|b', 'drover-sel|%E0%A4%A|x', 'drover-sel||x', 'drover-sel|a|b|c', null, 5]) assert.equal(parseMenuId(id), null, String(id));
});

test('menuSignature changes with title, enabled, ids', () => {
  const a = menuSpec([mk('a', 'h', '1')]);
  assert.equal(menuSignature(a), menuSignature(menuSpec([mk('a', 'h', '1')])));
  assert.notEqual(menuSignature(a), menuSignature(menuSpec([mk('b', 'h', '1')])));
  assert.notEqual(menuSignature(a), menuSignature(menuSpec([mk('a', 'h', '1', 'waiting')])));
  assert.notEqual(menuSignature(menuSpec([])), menuSignature(a));
});

test('composeText', () => {
  assert.equal(composeText(MENU.SELECTION, { selectionText: ' hi ', pageUrl: 'https://x.test/p' }), 'hi \n\nSource: https://x.test/p');
  assert.equal(composeText(MENU.SELECTION, { selectionText: 'hi' }), 'hi');
  assert.equal(composeText(MENU.PAGE, { pageUrl: 'https://x.test/' }), 'https://x.test/');
  assert.equal(composeText(MENU.LINK, { linkUrl: 'https://y.test/', pageUrl: 'https://x.test/' }), 'https://y.test/');
  assert.equal(composeText(MENU.LINK, {}), '');
  assert.equal(composeText(MENU.SELECTION, { selectionText: 'a'.repeat(9000) }).length, 8000);
});
