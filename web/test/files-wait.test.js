// files.wait (core/filewait.js): what wakes a wait (a file modified, replaced, removed or appearing; a directory's
// entries added, removed or modified; only those a glob matches), the timeout, the clamps, since, stopWaits, and the
// wait served by a real `drover rpc` (it outlives an ended stdin, and ends when its caller is gone). Short intervals
// in a temp dir throughout. Run: node --test test/files-wait.test.js
import './isolate-cache.js';   // hostTimeoutMs comes from the op table, which loads core/cache.js
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rename, rm, utimes } from 'node:fs/promises';
import { realpathSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wait, waitLimits, globRe, stopWaits, LIMITS } from '../core/filewait.js';
import * as files from '../core/files.js';
import { hostTimeoutMs } from '../core/api.js';

const T = realpathSync(await mkdtemp(path.join(tmpdir(), 'drover-wait-')));
after(() => rm(T, { recursive: true, force: true }));
let n = 0;
const fresh = async () => { const d = path.join(T, `case-${++n}`); await mkdir(d, { recursive: true }); return d; };
const later = (ms, fn) => new Promise((r) => setTimeout(() => r(fn()), ms));
const FAST = { intervalMs: 100, timeoutSec: 10 };

describe('a file', () => {
  test('modified: an append wakes the wait with what changed and how long it waited', async () => {
    const f = path.join(await fresh(), 'WS-01.md');
    await writeFile(f, 'working\n');
    const [r] = await Promise.all([wait({ path: f, ...FAST }), later(300, () => appendFile(f, 'done\n'))]);
    assert.equal(r.changed, true);
    assert.deepEqual(r.changes, [{ path: f, kind: 'modified' }]);
    assert.ok(r.waitedMs >= 250 && r.waitedMs < 5000, `waited ${r.waitedMs} ms`);
    assert.equal(r.path, f); assert.ok(!Number.isNaN(Date.parse(r.ts)));
  });

  test('replaced by an atomic save (same size, renamed over it) counts as modified: the inode changed', async () => {
    const d = await fresh(), f = path.join(d, 'status.md');
    await writeFile(f, 'aaaa');
    const [r] = await Promise.all([wait({ path: f, ...FAST }), later(250, async () => { await writeFile(path.join(d, '.tmp'), 'bbbb'); await rename(path.join(d, '.tmp'), f); })]);
    assert.deepEqual(r.changes, [{ path: f, kind: 'modified' }]);
  });

  test('removed, and a missing path that appears', async () => {
    const d = await fresh(), f = path.join(d, 'x.md');
    await writeFile(f, 'x');
    const [gone] = await Promise.all([wait({ path: f, ...FAST }), later(250, () => rm(f))]);
    assert.deepEqual(gone.changes, [{ path: f, kind: 'removed' }]);
    const [back] = await Promise.all([wait({ path: f, ...FAST }), later(250, () => writeFile(f, 'y'))]);
    assert.deepEqual(back.changes, [{ path: f, kind: 'added' }], 'a missing path is a wait until it appears');
    const deep = path.join(d, 'not', 'yet', 'status');
    const [made] = await Promise.all([wait({ path: deep, ...FAST }), later(250, () => mkdir(deep, { recursive: true }))]);
    assert.deepEqual(made.changes, [{ path: deep, kind: 'added' }]);
  });
});

describe('a directory', () => {
  test('its direct entries: added, removed and modified, together and sorted', async () => {
    const d = await fresh();
    await writeFile(path.join(d, 'a.md'), '1'); await writeFile(path.join(d, 'b.md'), '1');
    await mkdir(path.join(d, 'sub')); await writeFile(path.join(d, 'sub', 'deep.md'), '1');
    // Every change lands while the wait sleeps (sync, one callback, a 400 ms interval), so one snapshot sees them all.
    const [r] = await Promise.all([wait({ path: d, intervalMs: 400, timeoutSec: 10 }), later(150, () => { appendFileSync(path.join(d, 'a.md'), '2'); rmSync(path.join(d, 'b.md')); writeFileSync(path.join(d, 'c.md'), '1'); })]);
    assert.deepEqual(r.changes, [{ path: path.join(d, 'a.md'), kind: 'modified' }, { path: path.join(d, 'b.md'), kind: 'removed' }, { path: path.join(d, 'c.md'), kind: 'added' }]);
  });

  test('only direct entries: a write deeper down does not wake it', async () => {
    const d = await fresh();
    await mkdir(path.join(d, 'sub')); await writeFile(path.join(d, 'sub', 'deep.md'), '1');
    const [r] = await Promise.all([wait({ path: d, intervalMs: 100, timeoutSec: 1 }), later(200, () => appendFile(path.join(d, 'sub', 'deep.md'), '2'))]);
    assert.equal(r.changed, false);
  });

  test('the directory itself going away is reported with what it held', async () => {
    const d = await fresh(), w = path.join(d, 'status');
    await mkdir(w); await writeFile(path.join(w, 'WS-01.md'), '1');
    const [r] = await Promise.all([wait({ path: w, ...FAST }), later(250, () => rm(w, { recursive: true }))]);
    assert.deepEqual(r.changes, [{ path: w, kind: 'removed' }, { path: path.join(w, 'WS-01.md'), kind: 'removed' }]);
  });

  test('glob: only matching entries count, and a change to another file does not wake the wait', async () => {
    const d = await fresh();
    await writeFile(path.join(d, 'WS-01.md'), '1'); await writeFile(path.join(d, 'notes.txt'), '1');
    const [quiet] = await Promise.all([wait({ path: d, glob: 'WS-*.md', intervalMs: 100, timeoutSec: 1 }), later(200, () => { appendFileSync(path.join(d, 'notes.txt'), '2'); writeFileSync(path.join(d, '.WS-01.md.swp'), 'x'); })]);
    assert.equal(quiet.changed, false, 'notes.txt and a swap file are not WS-*.md');
    assert.equal(quiet.glob, 'WS-*.md');
    const [r] = await Promise.all([wait({ path: d, glob: 'WS-*.md', ...FAST }), later(250, () => writeFile(path.join(d, 'WS-02.md'), '1'))]);
    assert.deepEqual(r.changes, [{ path: path.join(d, 'WS-02.md'), kind: 'added' }]);
  });

  test('globRe: * ? [abc] [!abc], everything else literal, and no /', () => {
    assert.ok(globRe('WS-*.md').test('WS-12.md')); assert.ok(!globRe('WS-*.md').test('WS-12.mdx')); assert.ok(!globRe('WS-*.md').test('xWS-1.md'));
    assert.ok(globRe('WS-??.md').test('WS-07.md')); assert.ok(!globRe('WS-??.md').test('WS-7.md'));
    assert.ok(globRe('WS-[0-9][0-9].md').test('WS-42.md')); assert.ok(!globRe('WS-[0-9].md').test('WS-a.md'));
    assert.ok(globRe('[!.]*').test('a.md')); assert.ok(!globRe('[!.]*').test('.swp'));
    assert.ok(globRe('a+b(c).md').test('a+b(c).md')); assert.ok(!globRe('a.md').test('aXmd'), 'a dot is a dot');
    assert.throws(() => globRe('sub/*.md'), /no \//);
  });
});

describe('timeout, clamps and since', () => {
  test('nothing changes: changed false after timeoutSec, with ts and the limits it ran with', async () => {
    const f = path.join(await fresh(), 'idle.md');
    await writeFile(f, 'x');
    const r = await wait({ path: f, timeoutSec: 1, intervalMs: 100 });
    assert.equal(r.changed, false); assert.equal(r.changes, undefined);
    assert.ok(r.waitedMs >= 1000 && r.waitedMs < 2500, `waited ${r.waitedMs} ms`);
    assert.equal(r.timeoutSec, 1); assert.equal(r.intervalMs, 100);
  });

  test('timeoutSec is 1 to 3600 (default 1800), intervalMs 100 to 60000 (default 2000); a non-number is refused', async () => {
    assert.deepEqual(waitLimits({}), { timeoutSec: 1800, intervalMs: 2000 });
    assert.deepEqual(waitLimits({ timeoutSec: 99_999, intervalMs: 5 }), { timeoutSec: 3600, intervalMs: 100 });
    assert.deepEqual(waitLimits({ timeoutSec: 0, intervalMs: 999_999 }), { timeoutSec: 1, intervalMs: 60_000 });
    assert.deepEqual(waitLimits({ timeoutSec: '30', intervalMs: '250' }), { timeoutSec: 30, intervalMs: 250 });
    assert.throws(() => waitLimits({ timeoutSec: '30m' }), /timeoutSec must be a number/);
    assert.throws(() => waitLimits({ intervalMs: 'fast' }), /intervalMs must be a number/);
    const r = await wait({ path: path.join(await fresh(), 'none'), timeoutSec: 0.01, intervalMs: 1 });
    assert.equal(r.timeoutSec, 1); assert.equal(r.intervalMs, 100);
    assert.ok(r.waitedMs >= 1000, 'the clamped timeout is the one waited');
    // A forwarded wait gets its whole wait plus a minute (ssh, the remote rpc starting, the last stat pass).
    assert.equal(hostTimeoutMs('files.wait', {}), 1_860_000);
    assert.equal(hostTimeoutMs('files.wait', { timeoutSec: 99_999 }), 3_660_000);
    assert.equal(hostTimeoutMs('files.wait', { timeoutSec: 30 }), 90_000);
  });

  test('since: what changed after it counts at once, so back-to-back waits miss nothing', async () => {
    const d = await fresh(), f = path.join(d, 'WS-01.md');
    await writeFile(f, '1');
    const first = await wait({ path: d, timeoutSec: 1, intervalMs: 100 });
    assert.equal(first.changed, false);
    await appendFile(f, '2');   // between two waits, which a plain baseline would never see
    const next = await wait({ path: d, since: first.ts, timeoutSec: 5, intervalMs: 100 });
    assert.equal(next.changed, true);
    assert.ok(next.waitedMs < 500, `at once, not after an interval (${next.waitedMs} ms)`);
    assert.ok(next.changes.some((c) => c.path === f && c.kind === 'modified'));
    const old = new Date(Date.now() - 60_000);
    await utimes(f, old, old); await utimes(d, old, old);
    const settled = await wait({ path: f, since: new Date(Date.now() + 5_000).toISOString(), timeoutSec: 1, intervalMs: 100 });
    assert.equal(settled.changed, false, 'nothing newer than since: an ordinary wait');
    await assert.rejects(wait({ path: f, since: 'yesterday-ish' }), /since must be/);
  });

  test('since on a directory: a removal shows as the directory modified, with a glob too, so a deleted match is never missed', async () => {
    const d = await fresh();
    for (const f of ['WS-01.md', 'WS-02.md', 'old.txt']) await writeFile(path.join(d, f), '1');
    const old = new Date(Date.now() - 60_000);
    for (const f of ['WS-01.md', 'WS-02.md', 'old.txt']) await utimes(path.join(d, f), old, old);   // sets their ctime to now, so since comes well after it
    await later(300, () => {});
    const since = new Date().toISOString();
    // The status-directory case: a worker's file is deleted between one answer and the next wait.
    await later(300, () => rm(path.join(d, 'WS-02.md')));
    const t0 = Date.now();
    const globbed = await wait({ path: d, glob: 'WS-*.md', since, timeoutSec: 5, intervalMs: 100 });
    assert.equal(globbed.changed, true); assert.ok(Date.now() - t0 < 1000, 'at once, not after the timeout');
    assert.deepEqual(globbed.changes, [{ path: d, kind: 'modified' }], 'the directory says an entry went');
    const plain = await wait({ path: d, since, timeoutSec: 5, intervalMs: 100 });
    assert.deepEqual(plain.changes, [{ path: d, kind: 'modified' }]);
    // The price, documented: churn the glob does not match wakes it too. One extra look, never a missed wake.
    const since2 = new Date().toISOString();
    await later(300, () => rm(path.join(d, 'old.txt')));
    const churn = await wait({ path: d, glob: 'WS-*.md', since: since2, timeoutSec: 5, intervalMs: 100 });
    assert.deepEqual(churn.changes, [{ path: d, kind: 'modified' }]);
  });

  test('existed: a watched file that vanished, or appeared, between two waits counts at once; every answer says exists', async () => {
    const d = await fresh(), f = path.join(d, 'WS-04.md');
    await writeFile(f, 'working');
    const first = await wait({ path: f, timeoutSec: 1, intervalMs: 100 });
    assert.equal(first.changed, false); assert.equal(first.exists, true);
    await rm(f);   // gone before the next wait starts: its baseline has nothing, and a removal leaves no time behind
    const t0 = Date.now();
    const gone = await wait({ path: f, since: first.ts, existed: first.exists, timeoutSec: 5, intervalMs: 100 });
    assert.ok(Date.now() - t0 < 1000, 'at once');
    assert.deepEqual([gone.changed, gone.changes, gone.exists], [true, [{ path: f, kind: 'removed' }], false]);
    await writeFile(f, 'back');
    const back = await wait({ path: f, existed: gone.exists, timeoutSec: 5, intervalMs: 100 });
    assert.deepEqual([back.changed, back.changes, back.exists], [true, [{ path: f, kind: 'added' }], true]);
    const same = await wait({ path: f, existed: 'true', timeoutSec: 1, intervalMs: 100 });
    assert.deepEqual([same.changed, same.exists], [false, true], 'still there: an ordinary wait');
    const dirGone = path.join(d, 'status');
    assert.deepEqual((await wait({ path: dirGone, existed: true, timeoutSec: 5, intervalMs: 100 })).changes, [{ path: dirGone, kind: 'removed' }], 'a directory too');
    await assert.rejects(wait({ path: f, existed: 'yes' }), /existed must be true or false/);
  });
});

describe('limits and stopping', () => {
  test('stopWaits ends every wait in the process at once, each with stopped: true', async () => {
    const d = await fresh();
    const t0 = Date.now();
    const [a, b] = await Promise.all([wait({ path: d, timeoutSec: 60, intervalMs: 100 }), wait({ path: path.join(d, 'x'), timeoutSec: 60, intervalMs: 100 }), later(200, stopWaits)]);
    for (const r of [a, b]) { assert.equal(r.changed, false); assert.equal(r.stopped, true); }
    assert.ok(Date.now() - t0 < 2000);
  });

  test('LIMITS.entries: refused up front, counted on every scan (a directory that grows past it ends the wait), glob matches only', async () => {
    const d = await fresh(), cap = LIMITS.entries;
    for (const f of ['a', 'b', 'c', 'd']) await writeFile(path.join(d, f), '1');
    LIMITS.entries = 3;
    try {
      await assert.rejects(wait({ path: d, timeoutSec: 1 }), /4 entries to watch, more than 3: narrow it with glob/);
      const quiet = await wait({ path: d, glob: '[ab]', timeoutSec: 1, intervalMs: 100 });
      assert.equal(quiet.changed, false, 'only the names the glob matches count against the cap');
      const g = await fresh();
      await writeFile(path.join(g, 'WS-01.md'), '1'); await writeFile(path.join(g, 'WS-02.md'), '1');
      await assert.rejects(Promise.all([wait({ path: g, intervalMs: 400, timeoutSec: 10 }), later(150, () => { for (const f of ['WS-03.md', 'WS-04.md', 'WS-05.md']) writeFileSync(path.join(g, f), '1'); })]),
        /5 entries to watch, more than 3: narrow it with glob/, 'grown during the wait: the next scan ends it with the error');
    } finally { LIMITS.entries = cap; }
  });

  test('a burst of changes is cut at LIMITS.changes, with more', async () => {
    const d = await fresh(), keep = LIMITS.changes;
    for (const f of ['a', 'b', 'c', 'd']) await writeFile(path.join(d, f), '1');
    LIMITS.changes = 2;
    try {
      const [r] = await Promise.all([wait({ path: d, intervalMs: 400, timeoutSec: 10 }), later(150, () => { for (const f of ['e', 'f', 'g', 'h']) writeFileSync(path.join(d, f), '1'); })]);
      assert.equal(r.changes.length, 2); assert.equal(r.more, 2);
    } finally { LIMITS.changes = keep; }
  });

  test('the path is absolute or ~/ (the host\'s home): anything else is refused', async () => {
    await assert.rejects(wait({ path: 'relative/status' }), /path must be absolute or start with ~\//);
    await assert.rejects(wait({}), /path must be a non-empty string/);
    const home = files._deps.home;
    files._deps.home = () => T;
    try {
      const d = await fresh(), rel = path.relative(T, d);
      const [r] = await Promise.all([wait({ path: `~/${rel}`, ...FAST }), later(250, () => writeFile(path.join(d, 'n.md'), '1'))]);
      assert.equal(r.path, d);
      assert.deepEqual(r.changes, [{ path: path.join(d, 'n.md'), kind: 'added' }]);
    } finally { files._deps.home = home; }
  });
});

// ---------------------------------------------------------------- served by drover rpc

const BIN = fileURLToPath(new URL('../bin/drover', import.meta.url));
function rpc(env = {}) {
  const home = path.join(T, `rpc-home-${++n}`);
  const child = spawn(process.execPath, [BIN, 'rpc'], {
    env: { PATH: process.env.PATH, HOME: home, DROVER_DOTFILES: path.join(home, 'dotfiles'), DROVER_CACHE: path.join(home, 'cache'), DROVER_EVENTS: path.join(home, 'events.jsonl'), DROVER_SECRETS_FILE: path.join(home, 'no-secrets'), DROVER_SEARCH: 'off', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '', err = '';
  child.stdout.setEncoding('utf8').on('data', (d) => { out += d; });
  child.stderr.setEncoding('utf8').on('data', (d) => { err += d; });
  const replies = () => out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  /** Resolves with reply `id` once it has arrived. */
  const reply = async (id, ms = 15_000) => { const end = Date.now() + ms; for (;;) { const r = replies().find((m) => m.id === id); if (r) return r; if (Date.now() > end) throw new Error(`no reply ${id}: ${err}`); await later(25, () => {}); } };
  return { child, reply, err: () => err };
}

describe('over drover rpc (how another host serves it)', () => {
  test('the wait answers after stdin has ended: callers end it and still read their replies', async () => {
    const d = await fresh();
    const { child, reply, err } = rpc();
    const closed = once(child, 'close');
    child.stdin.write(JSON.stringify({ id: 0, op: 'launch.efforts', args: {} }) + '\n');
    await reply(0);   // the rpc is up: the wait below takes its baseline as soon as it reads the request
    child.stdin.end(JSON.stringify({ id: 1, op: 'files.wait', args: { path: d, intervalMs: 100, timeoutSec: 20 } }) + '\n');
    await later(400, () => writeFile(path.join(d, 'WS-01.md'), 'done'));
    const msg = await reply(1);
    assert.equal(msg.ok, true, msg.error);
    assert.deepEqual(msg.result.changes, [{ path: path.join(d, 'WS-01.md'), kind: 'added' }]);
    const [code] = await closed;
    assert.equal(code, 0, err());
  });

  test('a caller that has gone away ends the wait at the next blank-line heartbeat, not after timeoutSec', async () => {
    const d = await fresh();
    const { child, reply, err } = rpc({ DROVER_RPC_BEAT_MS: '200' });
    const closed = once(child, 'close');
    child.stdin.write(JSON.stringify({ id: 0, op: 'launch.efforts', args: {} }) + '\n');
    await reply(0);
    child.stdin.write(JSON.stringify({ id: 1, op: 'files.wait', args: { path: d, intervalMs: 100, timeoutSec: 120 } }) + '\n');
    await later(600, () => {});   // heartbeats are written and read while the caller is there
    const t0 = Date.now();
    child.stdout.destroy();   // the ssh session is gone: the rpc's next write fails
    child.stdin.end();
    const [code] = await closed;
    assert.ok(Date.now() - t0 < 5000, `exited ${Date.now() - t0} ms after its caller left (${err()})`);
    assert.equal(code, 0);
  });
});
