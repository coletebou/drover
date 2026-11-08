import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, readFile, readdir, rename, rm, cp, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { append, readAll, fileInfo, signature, currentFile, segmentFor, segmentDir, storeFiles } from '../core/events.js';
import { listSources } from '../core/search/indexer.js';

// Daily segments: once <base without .jsonl>/ exists, appends go to <dir>/<UTC day>.jsonl and readAll returns the
// base and every segment as one log. Each check compares the cached answer with a read of a copy of the same files
// at a fresh path (no cache), as events-incremental-read.test.js does for one file.
const line = (id, ts, extra = {}) => JSON.stringify({ id, ts, host: 'h', actor: 't', type: 'note', about: 'x', text: id, ...extra }) + '\n';
const ids = (evs) => evs.map((e) => e.id);
const today = () => new Date().toISOString().slice(0, 10);
let n = 0;
async function setup({ segments = true } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'drover-seg-'));
  const base = path.join(dir, 'events.jsonl');
  if (segments) await mkdir(segmentDir(base));
  return base;
}
async function fresh(base) {
  const root = path.join(path.dirname(base), `fresh-${n++}`);
  await mkdir(root);
  const copy = path.join(root, 'events.jsonl');
  try { await cp(base, copy); } catch { /* no base */ }
  try { await cp(segmentDir(base), segmentDir(copy), { recursive: true }); } catch { /* no segments */ }
  return readAll(copy);
}

test('without the segment directory an append goes to the file itself, as before', async () => {
  const base = await setup({ segments: false });
  const ev = await append({ type: 'note', about: 'x', text: 'one' }, { file: base });
  assert.equal(JSON.parse(await readFile(base, 'utf8')).id, ev.id);
  assert.deepEqual(ids(await readAll(base)), [ev.id]);
  assert.equal(await currentFile(base), base);
});

test('with the directory an append goes to its UTC day and the base file is not touched', async () => {
  const base = await setup();
  await writeFile(base, line('old', '2026-10-01T00:00:00Z'));
  const before = await stat(base);
  const ev = await append({ type: 'note', about: 'x', text: 'new' }, { file: base });
  assert.equal(ev.ts.slice(0, 10), today());
  const seg = path.join(segmentDir(base), `${today()}.jsonl`);
  assert.equal(JSON.parse(await readFile(seg, 'utf8')).id, ev.id);
  const after = await stat(base);
  assert.equal(after.size, before.size);
  assert.equal(await readFile(base, 'utf8'), line('old', '2026-10-01T00:00:00Z'));
  assert.deepEqual(ids(await readAll(base)), ['old', ev.id]);
});

test('an event with its own ts goes in that day; a ts that is not a date goes in today', async () => {
  const base = await setup();
  const a = await append({ type: 'note', about: 'x', text: 'a', ts: '2026-11-03T23:59:59.999Z' }, { file: base });
  const b = await append({ type: 'note', about: 'x', text: 'b', ts: 'yesterday' }, { file: base });
  assert.deepEqual((await readdir(segmentDir(base))).sort(), ['2026-11-03.jsonl', `${today()}.jsonl`].sort());
  assert.equal(segmentFor('2026-11-03T23:59:59.999Z', base), path.join(segmentDir(base), '2026-11-03.jsonl'));
  assert.equal(segmentFor(undefined, base), path.join(segmentDir(base), `${today()}.jsonl`));
  assert.deepEqual(new Set(ids(await readAll(base))), new Set([a.id, b.id]));
});

test('the base and every segment read as one log: sorted by ts, deduped by id across files', async () => {
  const base = await setup();
  const d = segmentDir(base);
  await writeFile(base, line('b1', '2026-10-01T00:00:01Z') + line('dup', '2026-10-02T00:00:00Z') + line('b2', '2026-11-05T12:00:00Z'));
  // A host on older code kept writing the base while others wrote segments: times interleave across files.
  await writeFile(path.join(d, '2026-11-05.jsonl'), line('s1', '2026-11-05T11:00:00Z') + line('dup', '2026-10-02T00:00:00Z') + line('s2', '2026-11-05T13:00:00Z'));
  await writeFile(path.join(d, '2026-11-06.jsonl'), line('s3', '2026-11-06T00:00:00Z'));
  const got = await readAll(base);
  assert.deepEqual(ids(got), ['b1', 'dup', 's1', 'b2', 's2', 's3']);
  assert.deepEqual(got, await fresh(base));
});

test('files that are not day segments are not read', async () => {
  const base = await setup();
  const d = segmentDir(base);
  await writeFile(path.join(d, 'README.md'), '# not events\n');
  await writeFile(path.join(d, 'notes.jsonl'), line('nope', '2026-11-01T00:00:00Z'));
  await writeFile(path.join(d, '2026-11-01.jsonl.bak'), line('nope2', '2026-11-01T00:00:00Z'));
  await writeFile(path.join(d, '2026-11-01.jsonl'), line('yes', '2026-11-01T00:00:00Z'));
  assert.deepEqual(ids(await readAll(base)), ['yes']);
  assert.deepEqual((await storeFiles(base)).map((f) => path.basename(f)), ['events.jsonl', '2026-11-01.jsonl']);
});

test('appends to a segment, a new day, and appends to the base by older code are all picked up', async () => {
  const base = await setup();
  const d = segmentDir(base);
  await writeFile(base, line('b1', '2026-11-01T00:00:00Z'));
  await writeFile(path.join(d, '2026-11-07.jsonl'), line('s1', '2026-11-07T10:00:00Z'));
  assert.deepEqual(ids(await readAll(base)), ['b1', 's1']);
  await appendFile(path.join(d, '2026-11-07.jsonl'), line('s2', '2026-11-07T11:00:00Z'));
  assert.deepEqual(ids(await readAll(base)), ['b1', 's1', 's2']);
  await writeFile(path.join(d, '2026-11-08.jsonl'), line('s3', '2026-11-08T00:00:01Z'));
  assert.deepEqual(ids(await readAll(base)), ['b1', 's1', 's2', 's3']);
  // A laggard appends to the base with a time before the newest segment event: it sorts into place.
  await appendFile(base, line('late', '2026-11-07T10:30:00Z'));
  const got = await readAll(base);
  assert.deepEqual(ids(got), ['b1', 's1', 'late', 's2', 's3']);
  assert.deepEqual(got, await fresh(base));
  // The same line arriving in a second file (a union merge, a copy) is still one event.
  await appendFile(path.join(d, '2026-11-08.jsonl'), line('s1', '2026-11-07T10:00:00Z'));
  assert.deepEqual(ids(await readAll(base)), ['b1', 's1', 'late', 's2', 's3']);
});

test('a segment git replaces (a union merge) or removes is read again without losing the other files', async () => {
  const base = await setup();
  const d = segmentDir(base);
  const seg = path.join(d, '2026-11-08.jsonl');
  await writeFile(base, line('b1', '2026-11-01T00:00:00Z'));
  await writeFile(seg, line('s1', '2026-11-08T01:00:00Z') + line('s3', '2026-11-08T03:00:00Z'));
  await readAll(base);
  // git writes the merged file under a new inode: another host's line lands in the middle.
  const tmp = `${seg}.tmp`;
  await writeFile(tmp, line('s1', '2026-11-08T01:00:00Z') + line('s2', '2026-11-08T02:00:00Z') + line('s3', '2026-11-08T03:00:00Z'));
  await rename(tmp, seg);
  let got = await readAll(base);
  assert.deepEqual(ids(got), ['b1', 's1', 's2', 's3']);
  assert.deepEqual(got, await fresh(base));
  await rm(seg);
  got = await readAll(base);
  assert.deepEqual(ids(got), ['b1']);
  // No base at all (only segments) still reads.
  await writeFile(seg, line('s9', '2026-11-08T09:00:00Z'));
  await rm(base);
  assert.deepEqual(ids(await readAll(base)), ['s9']);
});

test('a same-size rewrite that keeps the mtime is caught while the file is fresh (coarse file clocks)', async () => {
  const base = await setup();
  const seg = path.join(segmentDir(base), '2026-11-08.jsonl');
  await writeFile(seg, line('aaaa', '2026-11-08T01:00:00Z'));
  // A whole-millisecond mtime, so setting it again later gives the identical stat.
  const mtime = new Date(Math.floor(Date.now()));
  await utimes(seg, mtime, mtime);
  assert.deepEqual(ids(await readAll(base)), ['aaaa']);
  // Same length, other bytes, and the clock did not tick: only the byte checks can tell.
  await writeFile(seg, line('bbbb', '2026-11-08T01:00:00Z'));
  await utimes(seg, mtime, mtime);
  assert.deepEqual(ids(await readAll(base)), ['bbbb']);
});

test('an old segment that does not change is not reopened, and still reads right when it does change', async () => {
  const base = await setup();
  const seg = path.join(segmentDir(base), '2026-11-01.jsonl');
  await writeFile(seg, line('o1', '2026-11-01T01:00:00Z'));
  const old = new Date(Date.now() - 3600_000);
  await utimes(seg, old, old);
  assert.deepEqual(ids(await readAll(base)), ['o1']);
  assert.deepEqual(ids(await readAll(base)), ['o1']);
  // A late line for that day arrives (git pulls another host's append): size and mtime move.
  await appendFile(seg, line('o2', '2026-11-01T02:00:00Z'));
  const got = await readAll(base);
  assert.deepEqual(ids(got), ['o1', 'o2']);
  assert.deepEqual(got, await fresh(base));
});

test('signature moves with any file of the store and holds still otherwise', async () => {
  const base = await setup();
  assert.equal(await signature(base), null);
  await writeFile(base, line('b1', '2026-11-01T00:00:00Z'));
  const s1 = await signature(base);
  assert.equal(await signature(base), s1);
  await appendFile(base, line('b2', '2026-11-01T00:00:01Z'));
  const s2 = await signature(base);
  assert.notEqual(s2, s1);
  await append({ type: 'note', about: 'x', text: 'seg' }, { file: base });
  const s3 = await signature(base);
  assert.notEqual(s3, s2);
  await append({ type: 'note', about: 'x', text: 'seg2' }, { file: base });
  assert.notEqual(await signature(base), s3);
});

test('currentFile follows the newest segment up to today, never one from a clock running ahead', async () => {
  const base = await setup();
  const d = segmentDir(base);
  const now = new Date('2026-11-08T12:00:00Z');
  assert.equal(await currentFile(base, now), base, 'no segment yet: the base');
  await writeFile(path.join(d, '2026-11-07.jsonl'), line('a', '2026-11-07T00:00:00Z'));
  assert.equal(await currentFile(base, now), path.join(d, '2026-11-07.jsonl'));
  await writeFile(path.join(d, '2026-11-09.jsonl'), line('f', '2026-11-09T00:00:00Z'));
  assert.equal(await currentFile(base, now), path.join(d, '2026-11-07.jsonl'));
  await writeFile(path.join(d, '2026-11-08.jsonl'), line('b', '2026-11-08T00:00:00Z'));
  assert.equal(await currentFile(base, now), path.join(d, '2026-11-08.jsonl'));
});

test('fileInfo counts the base and every segment', async () => {
  const base = await setup();
  assert.deepEqual(await fileInfo(base), { path: base, exists: false, bytes: 0, segments: 0, segmentDir: segmentDir(base) });
  const a = line('b1', '2026-11-01T00:00:00Z'), b = line('s1', '2026-11-08T00:00:00Z');
  await writeFile(base, a);
  await writeFile(path.join(segmentDir(base), '2026-11-08.jsonl'), b);
  const info = await fileInfo(base);
  assert.equal(info.bytes, Buffer.byteLength(a) + Buffer.byteLength(b));
  assert.equal(info.segments, 1);
  assert.equal(info.exists, true);
  const plain = await setup({ segments: false });
  await writeFile(plain, a);
  const p = await fileInfo(plain);
  assert.equal(p.segments, 0);
  assert.equal('segmentDir' in p, false);
});

test('the search indexer lists every segment as a wal source', async () => {
  const base = await setup();
  await writeFile(base, line('b1', '2026-11-01T00:00:00Z'));
  await writeFile(path.join(segmentDir(base), '2026-11-08.jsonl'), line('s1', '2026-11-08T00:00:00Z'));
  await writeFile(path.join(segmentDir(base), 'README.md'), 'x\n');
  const list = await listSources({ wal: base });
  // listSources orders newest first by mtime; both were written in the same instant here.
  assert.deepEqual(list.filter((s) => s.kind === 'wal').map((s) => path.basename(s.path)).sort(), ['2026-11-08.jsonl', 'events.jsonl']);
});

test('reads of the same store at once see every event once', async () => {
  const base = await setup();
  const d = segmentDir(base);
  await writeFile(base, line('b1', '2026-11-01T00:00:00Z'));
  await readAll(base);
  await writeFile(path.join(d, '2026-11-08.jsonl'), line('s1', '2026-11-08T00:00:00Z'));
  await appendFile(base, line('b2', '2026-11-02T00:00:00Z'));
  const [x, y] = await Promise.all([readAll(base), readAll(base)]);
  assert.deepEqual(ids(x), ['b1', 'b2', 's1']);
  assert.deepEqual(ids(y), ['b1', 'b2', 's1']);
});
