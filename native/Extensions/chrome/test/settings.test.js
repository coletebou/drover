import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, LOCAL, POLL_MINUTES, normalizeSettings, isConfigured, loadSettings, saveSettings, redacted } from '../lib/settings.js';

function fakeArea(initial = {}) {
  const data = { ...initial };
  return { data, async get(key) { return key in data ? { [key]: data[key] } : {}; }, async set(obj) { Object.assign(data, JSON.parse(JSON.stringify(obj))); } };
}

test('normalizeSettings: defaults for nothing and for junk', () => {
  for (const raw of [undefined, null, 5, 'x', [], {}]) {
    const s = normalizeSettings(raw);
    assert.deepEqual(s, { baseUrl: '', token: '', actor: 'chrome', pollMinutes: 1, notify: { enabled: true, decision: true, question: true, finished: false } });
  }
});

test('normalizeSettings: trims strings and ignores wrong types', () => {
  const s = normalizeSettings({ baseUrl: '  http://127.0.0.1:7337 ', token: ' test-token-not-secret ' });
  assert.equal(s.baseUrl, 'http://127.0.0.1:7337');
  assert.equal(s.token, 'test-token-not-secret');
  const j = normalizeSettings({ baseUrl: 5, token: {}, notify: 'yes' });
  assert.equal(j.baseUrl, ''); assert.equal(j.token, ''); assert.deepEqual(j.notify, DEFAULTS.notify);
});

test('normalizeSettings: actor validation', () => {
  assert.equal(normalizeSettings({ actor: ' chrome (work) ' }).actor, 'chrome (work)');
  for (const bad of ['', '   ', 'a'.repeat(41), 'x<script>', 'a/b', 7, null]) assert.equal(normalizeSettings({ actor: bad }).actor, 'chrome');
});

test('normalizeSettings: pollMinutes only from POLL_MINUTES', () => {
  for (const m of POLL_MINUTES) assert.equal(normalizeSettings({ pollMinutes: m }).pollMinutes, m);
  for (const bad of [0, 3, 60, '5', 1.5, -1, null, NaN]) assert.equal(normalizeSettings({ pollMinutes: bad }).pollMinutes, 1);
});

test('normalizeSettings: notify merges over defaults and rejects non-booleans', () => {
  const s = normalizeSettings({ notify: { finished: true, decision: 'no', question: false } });
  assert.deepEqual(s.notify, { enabled: true, decision: true, question: false, finished: true });
});

test('load and save with a fake storage area', async () => {
  const area = fakeArea();
  assert.deepEqual(await loadSettings(area), normalizeSettings({}));
  const saved = await saveSettings(area, { baseUrl: 'http://127.0.0.1:7337', token: 'test-token-not-secret' });
  assert.equal(saved.baseUrl, 'http://127.0.0.1:7337');
  assert.deepEqual(area.data[LOCAL.SETTINGS], saved);
  assert.equal(LOCAL.SETTINGS, 'settings');
  assert.deepEqual(await loadSettings(area), saved);
});

test('saveSettings merges notify partially and keeps other fields', async () => {
  const area = fakeArea({ settings: { baseUrl: 'http://127.0.0.1:7337', token: 't', pollMinutes: 5, notify: { finished: true } } });
  const s = await saveSettings(area, { notify: { decision: false } });
  assert.deepEqual(s.notify, { enabled: true, decision: false, question: true, finished: true });
  assert.equal(s.pollMinutes, 5); assert.equal(s.token, 't');
  const s2 = await saveSettings(area, { pollMinutes: 99 });
  assert.equal(s2.pollMinutes, 1);
  assert.equal((await saveSettings(area, undefined)).token, 't');
});

test('isConfigured needs both URL and token', () => {
  assert.equal(isConfigured({ baseUrl: 'http://x', token: 't' }), true);
  assert.equal(isConfigured({ baseUrl: 'http://x', token: '' }), false);
  assert.equal(isConfigured({ baseUrl: '', token: 't' }), false);
  assert.equal(isConfigured(null), false);
});

test('redacted hides the token', () => {
  const r = redacted(normalizeSettings({ baseUrl: 'http://x', token: 'test-token-not-secret' }));
  assert.equal(r.token, '[redacted]');
  assert.ok(!JSON.stringify(r).includes('test-token-not-secret'));
  assert.equal(redacted(normalizeSettings({})).token, '');
});
