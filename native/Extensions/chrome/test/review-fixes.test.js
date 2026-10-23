// Regressions for the cross-model review findings (omnibox content, settings
// races, headless transcripts, change detection).
import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestionsFor, resolveInput } from '../lib/omnibox.js';
import { saveSettings, loadSettings } from '../lib/settings.js';
import { mergeTranscript, canIncrement } from '../lib/transcript.js';

const S = (name, id, host = 'local', state = 'waiting') => ({ id, name, host, engine: 'claude', headline: '', state, kind: state === 'waiting' ? 'question' : null, since: null });

test('a suggestion for a name with spaces resolves back to that same session', () => {
  const sessions = [S('release', 'id-rel'), S('release reviewer', 'id-rr')];
  for (const sug of suggestionsFor(sessions, 'rel')) {
    const r = resolveInput(sessions, `${sug.content}hello`);
    assert.ok(r.session, sug.content);
    assert.equal(r.message, 'hello');
  }
  const rr = suggestionsFor(sessions, 'release r')[0];
  assert.ok(!rr || resolveInput(sessions, rr.content).session);
  const byId = suggestionsFor(sessions, 'release').find((x) => x.content.startsWith('id-rr'));
  assert.equal(resolveInput(sessions, `${byId.content}go`).session.id, 'id-rr');
});

test('duplicate names on one host fall back to the id', () => {
  const sessions = [S('demo', 'a1'), S('demo', 'b2')];
  const got = suggestionsFor(sessions, 'demo').map((x) => resolveInput(sessions, `${x.content}x`).session?.id);
  assert.deepEqual(got.sort(), ['a1', 'b2']);
});

function fakeArea(initial) {
  let store = { settings: initial };
  return {
    async get(k) { await new Promise((r) => setTimeout(r, Math.random() * 5)); return { [k]: structuredClone(store[k]) }; },
    async set(o) { await new Promise((r) => setTimeout(r, Math.random() * 5)); store = { ...store, ...structuredClone(o) }; },
    peek: () => store.settings,
  };
}

test('an undefined token in a patch keeps the stored token, and a forgotten token stays forgotten', async () => {
  const area = fakeArea({ baseUrl: 'http://127.0.0.1:7337', token: 'tok-a' });
  await saveSettings(area, { token: undefined, actor: 'demo' });
  assert.equal((await loadSettings(area)).token, 'tok-a');
  await saveSettings(area, { token: '' });
  await saveSettings(area, { baseUrl: 'http://127.0.0.1:7337', token: undefined });
  assert.equal((await loadSettings(area)).token, '');
});

test('concurrent saves do not overwrite each other', async () => {
  const area = fakeArea({ baseUrl: 'http://127.0.0.1:7337', token: 'tok-a' });
  await Promise.all([
    saveSettings(area, { notify: { finished: true } }),
    saveSettings(area, { token: '' }),
    saveSettings(area, { pollMinutes: 5 }),
    saveSettings(area, { notify: { question: false } }),
  ]);
  const s = area.peek();
  assert.equal(s.token, '');
  assert.equal(s.pollMinutes, 5);
  assert.equal(s.notify.finished, true);
  assert.equal(s.notify.question, false);
});

test('headless snapshots replace instead of appending', () => {
  const snap = { engine: 'claude', headless: true, offset: 2, turns: [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }] };
  let st = mergeTranscript(null, snap, {});
  assert.equal(canIncrement(st), false);
  st = mergeTranscript(st, snap, { since: 2 });
  assert.equal(st.turns.length, 2);
  assert.equal(st.changed, false);
});

test('a shifted full snapshot with the same length and last text counts as changed', () => {
  const t = (xs) => xs.map((text, i) => ({ role: i % 2 ? 'assistant' : 'user', text }));
  const a = mergeTranscript(null, { engine: 'codex', offset: 0, turns: t(['q1', 'Done.', 'q2', 'Done.']) }, {});
  const b = mergeTranscript(a, { engine: 'codex', offset: 0, turns: t(['q2', 'Done.', 'q3', 'Done.']) }, {});
  assert.equal(b.changed, true);
});
