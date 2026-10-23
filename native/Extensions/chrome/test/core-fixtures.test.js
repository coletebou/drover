// The extension's parsers against core's shared fixtures (repo root Fixtures/).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSseParser } from '../lib/sse.js';
import { normalizeTurns, mergeTranscript } from '../lib/transcript.js';
import { planNotifications } from '../lib/notify.js';
import { DEFAULTS } from '../lib/settings.js';

const root = fileURLToPath(new URL('../../../Fixtures/', import.meta.url));
const has = (f) => existsSync(root + f);
const read = (f) => readFileSync(root + f, 'utf8');

test('events.sse.txt parses into the documented events, in byte-sized chunks too', { skip: !has('events.sse.txt') }, () => {
  const text = read('events.sse.txt');
  const whole = []; const p1 = createSseParser((e) => whole.push(e)); p1.push(text); p1.end();
  const bytes = []; const p2 = createSseParser((e) => bytes.push(e)); for (const c of text) p2.push(c); p2.end();
  assert.deepEqual(bytes, whole);
  const names = whole.map((e) => e.event);
  assert.ok(names.includes('hello') && names.includes('mutation'));
  for (const e of whole) assert.doesNotThrow(() => JSON.parse(e.data), e.event);
  const m = JSON.parse(whole.find((e) => e.event === 'mutation').data);
  assert.equal(m.op, 'sessions.message');
});

test('sessions.transcript.json normalizes (thinking dropped, tool_result as tool)', { skip: !has('sessions.transcript.json') }, () => {
  const env = JSON.parse(read('sessions.transcript.json'));
  const turns = normalizeTurns(env.result.turns);
  assert.ok(turns.length > 0);
  assert.ok(!turns.some((t) => t.role === 'thinking'));
  const st = mergeTranscript(null, env.result, {});
  assert.equal(st.engine, env.result.engine);
  assert.equal(st.offset, env.result.offset);
});

test('native.notifications.json: baseline then a fresh tick shows only allowed kinds', { skip: !has('native.notifications.json') }, () => {
  const { result } = JSON.parse(read('native.notifications.json'));
  const base = planNotifications({ cursor: null, seen: [], response: result, settings: DEFAULTS.notify });
  assert.equal(base.show.length, 0);
  assert.equal(base.cursor, result.cursor);
  const tick = planNotifications({ cursor: 'older', seen: [], response: result, settings: { enabled: true, decision: true, question: true, finished: true } });
  for (const it of tick.show) assert.ok(it.test === true || ['decision', 'question', 'finished'].includes(it.kind), it.kind);
});
