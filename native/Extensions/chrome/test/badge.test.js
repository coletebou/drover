import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { badgeFor, BADGE_COLORS } from '../lib/badge.js';
import { normalizeSummary } from '../lib/summary.js';

const load = (f) => normalizeSummary(JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8')));
const full = load('native-summary.json');
const empty = load('native-summary-empty.json');

test('unconfigured', () => {
  const b = badgeFor({ configured: false, data: null, error: null });
  assert.deepEqual(b, { text: '?', color: '#9c9c95', textColor: '#16191e', title: 'Drover: set the server and token in options' });
});

test('error wins over data and truncates', () => {
  const b = badgeFor({ configured: true, data: full, error: { kind: 'x', message: 'a '.repeat(200) } });
  assert.equal(b.text, '!');
  assert.equal(b.color, BADGE_COLORS.error);
  assert.ok(b.title.startsWith('Drover: '));
  assert.ok(b.title.length <= 'Drover: '.length + 120);
});

test('unconfigured wins over error', () => {
  assert.equal(badgeFor({ configured: false, data: null, error: { kind: 'x', message: 'm' } }).text, '?');
});

test('waiting count from fixture', () => {
  const b = badgeFor({ configured: true, data: full, error: null });
  assert.equal(b.text, String(full.totals.waiting));
  assert.equal(b.color, BADGE_COLORS.waiting);
  assert.equal(b.title, `Drover: ${full.totals.waiting} waiting, ${full.totals.working} working, ${full.totals.idle} idle`);
});

test('waiting above 99', () => {
  const d = { ...full, totals: { ...full.totals, waiting: 150 } };
  assert.equal(badgeFor({ configured: true, data: d, error: null }).text, '99+');
  assert.equal(badgeFor({ configured: true, data: { ...full, totals: { ...full.totals, waiting: 99 } }, error: null }).text, '99');
});

test('zero waiting is quiet', () => {
  const b = badgeFor({ configured: true, data: empty, error: null });
  assert.equal(b.text, '');
  assert.equal(b.color, BADGE_COLORS.quiet);
  assert.equal(b.title, `Drover: 0 waiting, 0 working, ${empty.totals.idle} idle`);
});

test('configured with no data yet is quiet', () => {
  assert.equal(badgeFor({ configured: true, data: null, error: null }).text, '');
});
