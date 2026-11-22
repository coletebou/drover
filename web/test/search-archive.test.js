// Transcript archives (DROVER_SEARCH_ARCHIVE): a hub indexes every machine's pushed copies beside its own, each chunk
// keeping the machine it came from, zstd-compressed copies read whole, and a tenant search never admitting them.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { zstdCompressSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { Store } = await import('../core/search/store.js');
const { Indexer, archiveRoots, listSources, readCompressedLines } = await import('../core/search/indexer.js');
const { search } = await import('../core/search/query.js');

const j = (o) => JSON.stringify(o) + '\n';
const turn = (sid, text, ts = '2026-11-01T10:00:00Z', cwd = '/home/u/code/webapp') => j({ type: 'user', timestamp: ts, uuid: `u-${sid}-${ts}`, cwd, sessionId: sid, message: { content: text } });

let dir, archive, store, idx;
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'drover-archive-'));
  archive = path.join(dir, 'agent-archive');
  const proj = (host) => path.join(archive, host, 'claude-projects', '-home-u-code-webapp');
  await mkdir(proj('box-a'), { recursive: true });
  await mkdir(path.join(proj('box-a'), 'live1', 'subagents'), { recursive: true });
  await mkdir(proj('box-b'), { recursive: true });
  await mkdir(path.join(archive, 'box-b', 'codex-sessions', '2026', '10', '02'), { recursive: true });
  await writeFile(path.join(proj('box-a'), 'live1.jsonl'), turn('live1', 'heron migration survey on the plain copy'));
  await writeFile(path.join(proj('box-a'), 'live1', 'subagents', 'agent-x.jsonl'), turn('live1', 'subagent counted the kestrels'));
  // An old compressed copy of a session that was resumed and pushed again: only the plain one is read.
  await writeFile(path.join(proj('box-a'), 'live1.jsonl.zst'), zstdCompressSync(Buffer.from(turn('live1', 'stale compressed words nobody should find'))));
  await writeFile(path.join(proj('box-b'), 'old2.jsonl.zst'), zstdCompressSync(Buffer.from(turn('old2', 'osprey nesting platform inspection, archived and compressed'))));
  await writeFile(path.join(archive, 'box-b', 'codex-sessions', '2026', '10', '02', 'rollout-2026-10-02T04-22-53-01a0fad9-ceb9-7520-ac5f-c0ffcc6d77a3.jsonl.zst'),
    zstdCompressSync(Buffer.from(j({ type: 'response_item', timestamp: '2026-10-02T04:23:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'codex asked about the plover census' }] } }))));
  await mkdir(path.join(archive, '.hidden-not-a-host'), { recursive: true });
  store = new Store(path.join(dir, 'index.sqlite'));
  idx = new Indexer({ store, embedder: null, roots: { claude: null, codex: null, wal: null, archive: [archive] } });
});
after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });

describe('transcript archives', () => {
  test('DROVER_SEARCH_ARCHIVE: |-separated directories, ~ expanded, off/none/empty for none', () => {
    assert.deepEqual(archiveRoots({ HOME: '/h', DROVER_SEARCH_ARCHIVE: '~/agent-archive | /srv/b' }), ['/h/agent-archive', '/srv/b']);
    for (const v of ['', 'off', 'none', '0']) assert.deepEqual(archiveRoots({ HOME: '/h', DROVER_SEARCH_ARCHIVE: v }), []);
    assert.deepEqual(archiveRoots({ HOME: '/h' }), []);
  });

  test('every host directory is listed as its own transcripts, the plain copy winning over a stale compressed one', async () => {
    const list = await listSources({ archive: [archive] });
    const rel = list.map((s) => [path.relative(archive, s.path), s.kind, s.host, s.session_id]).sort((a, b) => a[0].localeCompare(b[0]));
    assert.deepEqual(rel, [
      ['box-a/claude-projects/-home-u-code-webapp/live1.jsonl', 'claude', 'box-a', 'live1'],
      ['box-a/claude-projects/-home-u-code-webapp/live1/subagents/agent-x.jsonl', 'subagent', 'box-a', 'live1'],
      ['box-b/claude-projects/-home-u-code-webapp/old2.jsonl.zst', 'claude', 'box-b', 'old2'],
      ['box-b/codex-sessions/2026/10/02/rollout-2026-10-02T04-22-53-01a0fad9-ceb9-7520-ac5f-c0ffcc6d77a3.jsonl.zst', 'codex', 'box-b', '01a0fad9-ceb9-7520-ac5f-c0ffcc6d77a3'],
    ]);
  });

  test('indexed with the machine each came from; compressed copies are read, and read once', async () => {
    const r = await idx.tick({ embed: false });
    assert.ok(r.added >= 4, `added ${r.added}`);
    const rows = store.db.prepare("SELECT kind, host, session_id, text FROM chunks WHERE role = 'user' ORDER BY text").all();
    assert.deepEqual(rows.map((x) => [x.kind, x.host, x.session_id]), [
      ['codex', 'box-b', '01a0fad9-ceb9-7520-ac5f-c0ffcc6d77a3'],
      ['claude', 'box-a', 'live1'],
      ['claude', 'box-b', 'old2'],
      ['subagent', 'box-a', 'live1'],
    ]);
    assert.ok(!rows.some((x) => /stale compressed/.test(x.text)));
    const again = await idx.tick({ embed: false });
    assert.equal(again.changed, 0, 'nothing changed: nothing read again');
  });

  test('a compressed copy is streamed a window at a time; only the last window reports the end', async () => {
    const f = path.join(dir, 'big.jsonl.zst');
    const lines = Array.from({ length: 500 }, (_, i) => JSON.stringify({ i, pad: 'x'.repeat(i % 37) }));
    await writeFile(f, zstdCompressSync(Buffer.from(lines.join('\n') + '\n')));
    const { size } = await stat(f);
    const wins = [];
    for await (const w of readCompressedLines(f, 0, size, { window: 256 })) wins.push(w);
    assert.ok(wins.length > 5, `windows ${wins.length}`);
    assert.deepEqual(wins.flatMap((w) => w.lines), lines, 'every line, in order, none split');
    assert.deepEqual(wins.map((w) => w.end), [...wins.slice(0, -1).map(() => 0), size]);
    const noNewline = path.join(dir, 'tail.jsonl.zst');
    await writeFile(noNewline, zstdCompressSync(Buffer.from('a\nb')));
    const t = []; for await (const w of readCompressedLines(noNewline, 0, (await stat(noNewline)).size)) t.push(...w.lines);
    assert.deepEqual(t, ['a', 'b'], 'a last line with no newline is kept');
  });

  test('a compressed copy a pass left partway is read again from the start, with no duplicate chunks', async () => {
    const zp = path.join(archive, 'box-b', 'claude-projects', '-home-u-code-webapp', 'old2.jsonl.zst');
    const count = () => store.db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE path = ?').get(zp).n;
    const before = count();
    assert.ok(before > 0);
    store.db.prepare('UPDATE sources SET size = -1, offset = 0 WHERE path = ?').run(zp);
    await idx.tick({ embed: false });
    assert.equal(count(), before);
    assert.equal(store.source(zp).offset, (await stat(zp)).size);
  });

  test('a keyword search finds an archived hit and says whose it was; a tenant search admits no archived copy', async () => {
    const r = await search(store, null, { query: 'osprey nesting platform', mode: 'keyword' });
    assert.equal(r.results[0]?.sessionId, 'old2');
    assert.equal(r.results[0]?.provenance?.host, 'box-b');
    const tenant = await search(store, null, { query: 'osprey nesting platform', mode: 'keyword', repoIdentity: '/home/u/code/webapp' });
    assert.equal(tenant.results.length, 0);
  });
});
