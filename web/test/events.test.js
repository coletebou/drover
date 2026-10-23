import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { append, readAll, fold, validateEvent, importLegacyFeatureLog, since } from '../core/events.js';
import { uuidv7, isUuid } from '../core/ids.js';
import * as plugins from '../core/plugins.js';

test('uuidv7 is time ordered and well formed', () => {
  const a = uuidv7(1000), b = uuidv7(2000);
  assert.ok(isUuid(a)); assert.ok(a < b);
  assert.equal(a[14], '7');
});

test('validateEvent rejects unknown types and bad payloads', () => {
  assert.throws(() => validateEvent({ type: 'nope' }), /unknown event type/);
  assert.throws(() => validateEvent({ type: 'feature' }), /fid required/);
  assert.throws(() => validateEvent({ type: 'feature', fid: 'x', state: 'done' }), /bad feature.state/);
  assert.throws(() => validateEvent({ type: 'note', about: 'x' }), /note.about and note.text/);
  assert.throws(() => validateEvent({ type: 'message', to: {} }), /message.to and message.text/);
  assert.ok(validateEvent({ type: 'pin', target: 'x' }));
});

test('validateEvent: a plugin event type is checked by the plugin that registered it', () => {
  plugins._reset();
  try {
    plugins.register({
      name: 'fake-events',
      eventTypes: {
        stamp: (ev) => { if (typeof ev.label !== 'string' || !ev.label) throw new Error('stamp.label required'); },
      },
    });
    const good = { type: 'stamp', label: 'x' };
    assert.equal(validateEvent(good), good);
    assert.throws(() => validateEvent({ type: 'stamp' }), /stamp.label required/);
    assert.throws(() => validateEvent({ type: 'stamp', label: '' }), /stamp.label required/);
    assert.throws(() => validateEvent({ type: 'not-registered', label: 'x' }), /unknown event type/);
  } finally { plugins._reset(); }
  // Without the plugin its type is unknown again.
  assert.throws(() => validateEvent({ type: 'stamp', label: 'x' }), /unknown event type/);
});

test('append + readAll + fold produce current state', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'drover-ev-'));
  const file = path.join(dir, 'events.jsonl');
  await append({ type: 'feature', fid: 'f1', title: 'First', state: 'not-started', repo: 'webapp' }, { file, actor: 't' });
  await append({ type: 'feature', fid: 'f1', state: 'in-progress', links: ['#1'] }, { file, actor: 't' });
  await append({ type: 'feature', fid: 'f1', links: ['!2', '#1'] }, { file, actor: 't' });
  await append({ type: 'note', about: 'f1', text: 'hello' }, { file, actor: 't' });
  await append({ type: 'pin', target: 'f1' }, { file, actor: 't' });
  await append({ type: 'pin', target: 'f2' }, { file, actor: 't' });
  await append({ type: 'unpin', target: 'f2' }, { file, actor: 't' });
  await append({ type: 'message', to: { kind: 'claude', host: 'mac', id: 's1' }, text: 'hi', delivery: { ok: true } }, { file, actor: 't' });
  await append({ type: 'launch', engine: 'claude', mode: 'tmux', result: { tmux: 'agents:9' } }, { file, actor: 't' });
  const all = await readAll(file);
  assert.equal(all.length, 9);
  assert.ok(all.every((e) => isUuid(e.id) && e.ts && e.host && e.actor === 't'));
  const st = fold(all);
  assert.equal(st.features.length, 1);
  assert.deepEqual(st.features[0].links, ['#1', '!2']);
  assert.equal(st.features[0].state, 'in-progress');
  assert.equal(st.features[0].title, 'First');
  assert.deepEqual(st.pins, ['f1']);
  assert.equal(st.notes.f1.length, 1);
  assert.equal(st.chats['claude:mac:s1'].length, 1);
  assert.equal(st.launches.length, 1);
  assert.equal(st.count, 9);
  const tail = await since(all[6].id, file);
  assert.equal(tail.length, 2);
});

test('readAll skips a torn trailing line', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'drover-ev-'));
  const file = path.join(dir, 'events.jsonl');
  await append({ type: 'pin', target: 'a' }, { file });
  await writeFile(file, (await readFile(file, 'utf8')) + '{"id":"zzz","type":"pin","targ', 'utf8');
  const all = await readAll(file);
  assert.equal(all.length, 1);
});

test('legacy feature-log import is idempotent', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'drover-ev-'));
  const file = path.join(dir, 'events.jsonl');
  const legacy = path.join(dir, 'feature-log.jsonl');
  await writeFile(legacy, [
    JSON.stringify({ ts: '2026-05-11T00:00:00Z', id: 'feat-1', state: 'in-progress', title: 'Old', repo: 'webapp', notes: 'n' }),
    JSON.stringify({ ts: '2026-05-12T00:00:00Z', id: 'feat-1', state: 'shipped' }),
    'not json',
    '',
  ].join('\n'));
  const r1 = await importLegacyFeatureLog({ legacy, file });
  assert.deepEqual(r1, { imported: 2, skipped: 1 });
  const r2 = await importLegacyFeatureLog({ legacy, file });
  assert.deepEqual(r2, { imported: 0, skipped: 3 });
  const st = fold(await readAll(file));
  assert.equal(st.features[0].state, 'shipped');
  assert.equal(st.features[0].title, 'Old');
});

test('fold: only real asks mark a session as waiting (not finished asks, not the bare idle reminder)', () => {
  const ev = (o) => ({ id: o.sessionId, ts: '2026-10-11T22:00:00Z', type: 'notify', message: 'm', ...o });
  const st = fold([
    ev({ sessionId: 'a', kind: 'permission_prompt' }),
    ev({ sessionId: 'b', kind: 'idle_prompt' }),
    ev({ sessionId: 'c', kind: 'idle_prompt', category: 'finished', ask: { kind: 'finished' } }),
    ev({ sessionId: 'd', kind: 'idle_prompt', category: 'needs-you', ask: { kind: 'question', text: 'Push?' } }),
    ev({ sessionId: 'e', kind: 'dialog', category: 'needs-you', source: 'detector' }),
    ev({ sessionId: 'f', kind: 'question', category: 'needs-you', source: 'detector', ask: { kind: 'question', text: 'Red or blue?' } }),
  ]);
  assert.deepEqual(Object.keys(st.notifies).sort(), ['a', 'd', 'f']);
});
