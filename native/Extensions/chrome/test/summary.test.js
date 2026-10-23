import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeSummary, targetSessions, sessionKey, isOwner, OWNER_ACTOR } from '../lib/summary.js';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));

test('normalizeSummary: the full fixture', () => {
  const s = normalizeSummary(fx('native-summary.json'));
  assert.equal(s.generatedAt, '2026-10-11T18:00:00.000Z');
  assert.equal(s.hosts.length, 3);
  assert.equal(s.hosts.find((h) => h.name === 'demo-offline').up, false);
  assert.equal(s.waiting.length, 3);
  assert.equal(s.working.length, 2);
  assert.deepEqual(s.totals, { waiting: 3, working: 2, idle: 3, hosts: 3 });
  assert.deepEqual(s.manager, { up: true, lastNoteAt: '2026-10-11T17:30:00.000Z' });
  const w = s.waiting[0];
  assert.equal(w.state, 'waiting'); assert.equal(w.kind, 'decision'); assert.equal(w.engine, 'claude'); assert.equal(w.host, 'local');
  assert.equal(s.working[0].state, 'working'); assert.equal(s.working[0].kind, null); assert.equal(s.working[0].since, null);
  assert.equal(s.working[1].engine, 'headless');
});

test('normalizeSummary: the empty fixture', () => {
  const s = normalizeSummary(fx('native-summary-empty.json'));
  assert.deepEqual(s.waiting, []); assert.deepEqual(s.working, []);
  assert.deepEqual(s.totals, { waiting: 0, working: 0, idle: 4, hosts: 1 });
  assert.deepEqual(s.manager, { up: false, lastNoteAt: null });
});

test('normalizeSummary: null, {} and non-objects degrade to empty', () => {
  for (const raw of [null, undefined, {}, 5, 'x', []]) {
    const s = normalizeSummary(raw);
    assert.deepEqual(s, { generatedAt: null, hosts: [], waiting: [], working: [], totals: { waiting: 0, working: 0, idle: 0, hosts: 0 }, manager: { up: false, lastNoteAt: null } });
  }
});

test('normalizeSummary: junk entries', () => {
  const s = normalizeSummary({
    waiting: [
      null, 'x', {}, { name: 'no-id' },
      { id: 'a1', engine: 'gpt-9', kind: 'weird', since: 'not a date', headline: 'h' },
      { id: 'a2', kind: 'decision', since: '2026-10-11T10:00:00Z' },
    ],
    working: [{ id: 'w1', kind: 'decision', since: '2026-10-11T10:00:00Z' }],
    hosts: [null, {}, { name: 'h1', waiting: -3, working: 'x', idle: 2.7 }],
  });
  assert.equal(s.waiting.length, 2);
  const a1 = s.waiting[0];
  assert.equal(a1.engine, 'claude'); assert.equal(a1.kind, 'question'); assert.equal(a1.since, null);
  assert.equal(a1.name, 'a1'); assert.equal(a1.host, 'local');
  assert.equal(s.waiting[1].kind, 'decision');
  assert.equal(s.working[0].kind, null); assert.equal(s.working[0].since, null);
  assert.deepEqual(s.hosts, [{ name: 'h1', up: true, waiting: 0, working: 0, idle: 2 }]);
});

test('normalizeSummary: negative counts become 0', () => {
  const s = normalizeSummary({ totals: { waiting: -1, working: -2, idle: -3, hosts: -4 } });
  assert.deepEqual(s.totals, { waiting: 0, working: 0, idle: 0, hosts: 0 });
});

test('normalizeSummary: totals derived from hosts when missing', () => {
  const s = normalizeSummary({ hosts: [{ name: 'a', waiting: 2, working: 1, idle: 4 }, { name: 'b', waiting: 1, working: 0, idle: 1 }] });
  assert.deepEqual(s.totals, { waiting: 3, working: 1, idle: 5, hosts: 2 });
  const t = normalizeSummary({ hosts: [{ name: 'a', waiting: 0, working: 0, idle: 0 }], waiting: [{ id: '1' }, { id: '2' }] });
  assert.equal(t.totals.waiting, 2);
});

test('normalizeSummary: headline capped at 140', () => {
  const s = normalizeSummary({ waiting: [{ id: '1', headline: 'x'.repeat(500) }] });
  assert.equal(s.waiting[0].headline.length, 140);
});

test('targetSessions: waiting oldest first, then working', () => {
  const t = targetSessions(normalizeSummary(fx('native-summary.json')));
  assert.deepEqual(t.map((x) => x.name), ['demo-review', 'demo-build', 'demo-docs', 'demo-tests', 'demo-refactor']);
  assert.deepEqual(targetSessions(null), []);
});

test('targetSessions: waiting entries without a time sort last among waiting', () => {
  const t = targetSessions(normalizeSummary({ waiting: [{ id: 'n' }, { id: 'o', since: '2026-10-11T10:00:00Z' }], working: [{ id: 'w' }] }));
  assert.deepEqual(t.map((x) => x.id), ['o', 'n', 'w']);
});

test('sessionKey is distinct across hosts', () => {
  assert.notEqual(sessionKey({ host: 'a', id: '1' }), sessionKey({ host: 'b', id: '1' }));
  assert.notEqual(sessionKey({ host: 'a', id: 'b1' }), sessionKey({ host: 'ab', id: '1' }));
  assert.equal(sessionKey({ host: 'a', id: '1' }), sessionKey({ host: 'a', id: '1' }));
});

test('normalizeSummary keeps the owner the daemon names; an older daemon names none', () => {
  assert.equal(normalizeSummary({ owner: ' alice ' }).owner, 'alice');
  assert.equal('owner' in normalizeSummary({}), false, 'absent: no field');
  for (const owner of ['', '  ', 5, null, { name: 'x' }]) assert.equal('owner' in normalizeSummary({ owner }), false, String(owner));
  assert.equal(normalizeSummary({ owner: 'x'.repeat(500) }).owner.length, 120);
});

test('isOwner: the generic actor, or the name the latest summary gave', () => {
  assert.equal(OWNER_ACTOR, 'owner');
  assert.equal(isOwner('owner', undefined), true);
  assert.equal(isOwner('Owner', null), true, 'case-insensitive, as the daemon compares');
  assert.equal(isOwner('alice', undefined), false, 'an older daemon names no owner');
  assert.equal(isOwner('alice', 'Alice'), true);
  assert.equal(isOwner('mcp', 'alice'), false);
  assert.equal(isOwner('', ''), false);
  assert.equal(isOwner(null, 'alice'), false);
  assert.equal(isOwner(undefined, undefined), false);
});
