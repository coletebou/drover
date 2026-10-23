import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeTurns, mergeTranscript, canIncrement } from '../lib/transcript.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/sessions-transcript.json', import.meta.url), 'utf8'));

test('normalizeTurns drops thinking and maps roles', () => {
  const t = normalizeTurns(fx.turns);
  assert.deepEqual(t.map((x) => x.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.deepEqual(t[1].tools, ['Read']);
  assert.deepEqual(t[0].tools, []);
});

test('normalizeTurns drops empty, maps unknown roles, caps', () => {
  const t = normalizeTurns([
    { role: 'assistant', text: '  ' },
    { role: 'assistant', text: '', tools: [{ name: 'Bash' }] },
    { role: 'weird', text: 'x' },
    { role: 'tool_result', text: 'y'.repeat(1000) },
    { role: 'user', text: 'z'.repeat(30000) },
    { role: 'result', text: 'done', ts: '2026-10-11T18:00:00.000Z' },
  ]);
  assert.deepEqual(t.map((x) => x.role), ['assistant', 'system', 'tool', 'user', 'result']);
  assert.equal(t[2].text.length, 400);
  assert.ok(t[2].text.endsWith('…'));
  assert.equal(t[3].text.length, 20000);
  assert.equal(t[4].ts, '2026-10-11T18:00:00.000Z');
  assert.equal(t[1].ts, null);
});

const resp = (engine, offset, texts) => ({ engine, offset, turns: texts.map((text) => ({ role: 'assistant', text })) });

test('claude increment appends', () => {
  const s1 = mergeTranscript(null, resp('claude', 100, ['a', 'b']), {});
  assert.equal(s1.changed, true);
  const s2 = mergeTranscript(s1, resp('claude', 200, ['c']), { since: 100 });
  assert.deepEqual(s2.turns.map((t) => t.text), ['a', 'b', 'c']);
  assert.equal(s2.offset, 200);
  assert.equal(s2.changed, true);
  const s3 = mergeTranscript(s2, resp('claude', 200, []), { since: 200 });
  assert.equal(s3.changed, false);
  assert.equal(s3.turns.length, 3);
});

test('codex replaces', () => {
  const s1 = mergeTranscript(null, resp('codex', 2, ['a', 'b']), {});
  const s2 = mergeTranscript(s1, resp('codex', 3, ['a', 'b', 'c']), { since: 2 });
  assert.equal(s2.turns.length, 3);
});

test('offset going backwards replaces', () => {
  const s1 = mergeTranscript(null, resp('claude', 500, ['a', 'b']), {});
  const s2 = mergeTranscript(s1, resp('claude', 50, ['x']), { since: 500 });
  assert.deepEqual(s2.turns.map((t) => t.text), ['x']);
});

test('keeps last 300', () => {
  const many = Array.from({ length: 350 }, (_, i) => `t${i}`);
  const s = mergeTranscript(null, resp('claude', 10, many), {});
  assert.equal(s.turns.length, 300);
  assert.equal(s.turns[299].text, 't349');
  const s2 = mergeTranscript(s, resp('claude', 20, ['n1', 'n2']), { since: 10 });
  assert.equal(s2.turns.length, 300);
  assert.equal(s2.turns[299].text, 'n2');
});

test('canIncrement', () => {
  assert.equal(canIncrement(null), false);
  assert.equal(canIncrement({ engine: 'claude', offset: 5 }), true);
  assert.equal(canIncrement({ engine: 'claude', offset: 0 }), false);
  assert.equal(canIncrement({ engine: 'codex', offset: 5 }), false);
});
