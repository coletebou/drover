import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, readFile, rename, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readAll } from '../core/events.js';

// readAll caches what it parsed and next time reads only appended bytes. Each test
// checks the cached answer against a full parse of the same bytes at a fresh path
// (a path readAll has never seen has no cache, so it is parsed in full).
const line = (id, ts, extra = {}) => JSON.stringify({ id, ts, host: 'h', actor: 't', type: 'note', about: 'x', text: id, ...extra }) + '\n';
const ids = (evs) => evs.map((e) => e.id);
let n = 0;
async function fresh(file) {
  const copy = path.join(path.dirname(file), `fresh-${n++}.jsonl`);
  await copyFile(file, copy);
  return readAll(copy);
}
async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), 'drover-incr-'));
  return path.join(dir, 'events.jsonl');
}

test('appended lines are picked up and match a full parse', async () => {
  const file = await setup();
  await writeFile(file, line('a', '2026-01-01T00:00:01Z') + line('b', '2026-01-01T00:00:02Z'));
  assert.deepEqual(ids(await readAll(file)), ['a', 'b']);
  await appendFile(file, line('c', '2026-01-01T00:00:03Z'));
  const got = await readAll(file);
  assert.deepEqual(ids(got), ['a', 'b', 'c']);
  assert.deepEqual(got, await fresh(file));
});

test('a final line still being written is read once it is complete, and only once', async () => {
  const file = await setup();
  await writeFile(file, line('a', '2026-01-01T00:00:01Z'));
  await readAll(file);
  const whole = line('b', '2026-01-01T00:00:02Z');
  await appendFile(file, whole.slice(0, 20));
  assert.deepEqual(ids(await readAll(file)), ['a']);
  await appendFile(file, whole.slice(20));
  assert.deepEqual(ids(await readAll(file)), ['a', 'b']);
  assert.deepEqual(ids(await readAll(file)), ['a', 'b']);
});

test('a complete last line without a newline is not doubled when the newline arrives', async () => {
  const file = await setup();
  await writeFile(file, line('a', '2026-01-01T00:00:01Z') + line('b', '2026-01-01T00:00:02Z').trimEnd());
  assert.deepEqual(ids(await readAll(file)), ['a', 'b']);
  await appendFile(file, '\n' + line('c', '2026-01-01T00:00:03Z'));
  assert.deepEqual(ids(await readAll(file)), ['a', 'b', 'c']);
});

test('lines inserted in the middle of the same inode (a union merge) force a full parse', async () => {
  const file = await setup();
  const a = line('a', '2026-01-01T00:00:01Z'), b = line('b', '2026-01-01T00:00:03Z');
  await writeFile(file, a + b);
  await readAll(file);
  // writeFile on an existing path truncates and rewrites the same inode.
  await writeFile(file, a + line('m', '2026-01-01T00:00:02Z') + b + line('c', '2026-01-01T00:00:04Z'));
  const got = await readAll(file);
  assert.deepEqual(ids(got), ['a', 'm', 'b', 'c']);
  assert.deepEqual(got, await fresh(file));
});

test('a rewrite that only changes the start of the file forces a full parse', async () => {
  const file = await setup();
  const big = Array.from({ length: 200 }, (_, i) => line(`e${String(i).padStart(3, '0')}`, `2026-01-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`)).join('');
  await writeFile(file, big);
  await readAll(file);
  await writeFile(file, line('zero', '2026-01-01T00:00:00Z') + big);
  const got = await readAll(file);
  assert.equal(got[0].id, 'zero');
  assert.equal(got.length, 201);
});

test('a file replaced by rename (new inode) is parsed in full', async () => {
  const file = await setup();
  await writeFile(file, line('a', '2026-01-01T00:00:01Z'));
  await readAll(file);
  const tmp = file + '.tmp';
  await writeFile(tmp, line('x', '2026-01-01T00:00:05Z'));
  await rename(tmp, file);
  assert.deepEqual(ids(await readAll(file)), ['x']);
});

test('a shorter file is parsed in full', async () => {
  const file = await setup();
  await writeFile(file, line('a', '2026-01-01T00:00:01Z') + line('b', '2026-01-01T00:00:02Z'));
  await readAll(file);
  await writeFile(file, line('a', '2026-01-01T00:00:01Z'));
  assert.deepEqual(ids(await readAll(file)), ['a']);
});

test('appended events older than the newest are sorted in, like a full parse', async () => {
  const file = await setup();
  await writeFile(file, line('a', '2026-01-01T00:00:01Z') + line('c', '2026-01-01T00:00:03Z'));
  await readAll(file);
  await appendFile(file, line('b', '2026-01-01T00:00:02Z') + line('d', '2026-01-01T00:00:04Z'));
  const got = await readAll(file);
  assert.deepEqual(ids(got), ['a', 'b', 'c', 'd']);
  assert.deepEqual(got, await fresh(file));
});

test('an appended duplicate id is ignored, like a full parse', async () => {
  const file = await setup();
  await writeFile(file, line('a', '2026-01-01T00:00:01Z'));
  await readAll(file);
  await appendFile(file, line('a', '2026-01-01T00:00:01Z') + line('b', '2026-01-01T00:00:02Z'));
  assert.deepEqual(ids(await readAll(file)), ['a', 'b']);
});

test('changing the returned array does not change the next read', async () => {
  const file = await setup();
  await writeFile(file, line('a', '2026-01-01T00:00:01Z') + line('b', '2026-01-01T00:00:02Z'));
  const first = await readAll(file);
  first.reverse(); first.pop();
  assert.deepEqual(ids(await readAll(file)), ['a', 'b']);
});

test('a deleted file reads as empty and a new one at the same path is read from scratch', async () => {
  const file = await setup();
  await writeFile(file, line('a', '2026-01-01T00:00:01Z'));
  await readAll(file);
  await rm(file);
  assert.deepEqual(await readAll(file), []);
  await writeFile(file, line('b', '2026-01-01T00:00:02Z'));
  assert.deepEqual(ids(await readAll(file)), ['b']);
});

test('multi-byte text split across reads is decoded correctly', async () => {
  const file = await setup();
  await writeFile(file, line('a', '2026-01-01T00:00:01Z', { text: 'héllo ✓ 日本' }));
  await readAll(file);
  await appendFile(file, line('b', '2026-01-01T00:00:02Z', { text: 'naïve — ünïcode ✓' }));
  const got = await readAll(file);
  assert.equal(got[1].text, 'naïve — ünïcode ✓');
  assert.deepEqual(got, await fresh(file));
  assert.ok((await readFile(file, 'utf8')).includes('日本'));
});

test('lines a union merge inserts near the end of a large file force a full parse', async () => {
  // Past the head window, so only the check on the end of the part already read sees it.
  const file = await setup();
  const ts = (i) => `2026-01-01T${String(Math.floor(i / 3600)).padStart(2, '0')}:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`;
  const body = Array.from({ length: 300 }, (_, i) => line(`e${i}`, ts(i * 2))).join('');
  const last = line('last', ts(1000));
  await writeFile(file, body + last);
  await readAll(file);
  // The other host's line lands before our newest one, the way union merge orders hunks.
  await writeFile(file, body + line('theirs', ts(999)) + last + line('next', ts(1001)));
  const got = await readAll(file);
  assert.ok(got.some((e) => e.id === 'theirs'), 'the merged-in line is read');
  assert.deepEqual(got, await fresh(file));
});

test('a same-length edit at the start of a large file forces a full parse', async () => {
  // Only the head check sees it: the size and the end of the file are unchanged.
  const file = await setup();
  const ts = (i) => `2026-01-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`;
  const rest = Array.from({ length: 300 }, (_, i) => line(`e${String(i).padStart(3, '0')}`, ts(i + 1))).join('');
  await writeFile(file, line('AAAA', ts(0)) + rest);
  await readAll(file);
  await writeFile(file, line('BBBB', ts(0)) + rest);
  const got = await readAll(file);
  assert.equal(got[0].id, 'BBBB');
  assert.deepEqual(got, await fresh(file));
});
