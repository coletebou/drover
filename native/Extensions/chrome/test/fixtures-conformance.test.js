import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeSummary } from '../lib/summary.js';

const REPO_FIXTURES = fileURLToPath(new URL('../../../Fixtures/', import.meta.url));
const LOCAL_FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));

function checkSummary(raw, label) {
  const s = normalizeSummary(raw);
  if (raw.totals) {
    assert.equal(s.totals.waiting, raw.totals.waiting, `${label}: totals.waiting`);
    assert.equal(s.totals.working, raw.totals.working, `${label}: totals.working`);
    assert.equal(raw.waiting.length, raw.totals.waiting, `${label}: waiting list length vs totals`);
    assert.equal(raw.working.length, raw.totals.working, `${label}: working list length vs totals`);
    assert.equal(s.waiting.length, raw.waiting.length, `${label}: normalized waiting count`);
    assert.equal(s.working.length, raw.working.length, `${label}: normalized working count`);
  }
  for (const w of raw.waiting) {
    for (const k of ['id', 'name', 'host', 'engine', 'kind']) assert.ok(typeof w[k] === 'string' && w[k], `${label}: waiting item missing ${k}`);
    assert.ok(['decision', 'question'].includes(w.kind), `${label}: bad kind ${w.kind}`);
  }
}

function checkNotifications(result, label) {
  assert.ok(typeof result.cursor === 'string' && result.cursor, `${label}: cursor`);
  assert.ok(Array.isArray(result.items), `${label}: items`);
  for (const it of result.items) for (const k of ['id', 'at', 'kind', 'title']) assert.ok(typeof it[k] === 'string' && it[k], `${label}: item missing ${k}`);
}

function checkEnvelope(env, label) {
  assert.equal(env.ok, true, `${label}: ok`);
  assert.ok(env.result && typeof env.result === 'object', `${label}: result`);
  return env.result;
}

test('extension fixtures: native-summary.json', () => {
  checkSummary(read(`${LOCAL_FIXTURES}native-summary.json`), 'test/fixtures/native-summary.json');
});

test('extension fixtures: native-summary-empty.json', () => {
  checkSummary(read(`${LOCAL_FIXTURES}native-summary-empty.json`), 'test/fixtures/native-summary-empty.json');
});

test('extension fixtures: native-notifications.json', () => {
  checkNotifications(read(`${LOCAL_FIXTURES}native-notifications.json`), 'test/fixtures/native-notifications.json');
});

test('repo Fixtures/native-summary.json (bare result)', (t) => {
  const p = `${REPO_FIXTURES}native-summary.json`;
  if (!existsSync(p)) return t.skip('Fixtures/native-summary.json absent');
  checkSummary(read(p), 'Fixtures/native-summary.json');
});

test('repo Fixtures/native.summary.json (envelope)', (t) => {
  const p = `${REPO_FIXTURES}native.summary.json`;
  if (!existsSync(p)) return t.skip('Fixtures/native.summary.json absent');
  checkSummary(checkEnvelope(read(p), 'native.summary.json'), 'Fixtures/native.summary.json');
});

test('repo Fixtures/native.notifications.json (envelope)', (t) => {
  const p = `${REPO_FIXTURES}native.notifications.json`;
  if (!existsSync(p)) return t.skip('Fixtures/native.notifications.json absent');
  checkNotifications(checkEnvelope(read(p), 'native.notifications.json'), 'Fixtures/native.notifications.json');
});
