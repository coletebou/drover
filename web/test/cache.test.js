// core/cache.js: reads (stale-while-revalidate in a long-lived process, a stale value read again first anywhere else),
// and what an invalidation (after a mutation) guarantees: a load that was already running when the key was dropped
// answers its own caller but is not stored, and a later fresh read does not join it; a copy persisted around the drop is
// never hydrated after it. Temp cache dir.
import './isolate-cache.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const cache = await import('../core/cache.js');
await mkdir(process.env.DROVER_CACHE, { recursive: true });
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const fresh = () => cache.keyFor(`test.op${++n}`, {});   // a key of its own per test (op test.opN)

describe('reads', () => {
  test('in a long-lived process: a miss loads; a hit within ttl is served without loading; past ttl it is served stale and refreshed behind', async (t) => {
    const was = cache.markLongLived(); t.after(() => cache.markLongLived(was));
    const key = fresh(); let loads = 0;
    const loader = async () => ++loads;
    assert.equal((await cache.get(key, loader, { ttl: 50 })).value, 1);
    const hit = await cache.get(key, loader, { ttl: 50 });
    assert.equal(hit.value, 1); assert.equal(hit.meta.hit, true); assert.equal(loads, 1);
    await tick(60);
    const stale = await cache.get(key, loader, { ttl: 50 });
    assert.equal(stale.value, 1); assert.equal(stale.meta.stale, true); assert.equal(stale.meta.refreshing, true);
    await tick(5);
    assert.equal((await cache.get(key, loader, { ttl: 50 })).value, 2);
  });
  test('anywhere else past ttl the value is read again before it is returned, and kept with the error when that read fails', async (t) => {
    // A one-shot process (drover op, drover stacks) exits once it prints: a refresh left running behind its answer
    // would hold it open, and it would have printed the old value.
    const was = cache.markLongLived(false); t.after(() => cache.markLongLived(was));
    const key = fresh(); let loads = 0, fail = false;
    const loader = async () => { loads++; await tick(5); if (fail) throw new Error('boom'); return loads; };
    assert.equal((await cache.get(key, loader, { ttl: 50 })).value, 1);
    await tick(60);
    const again = await cache.get(key, loader, { ttl: 50 });
    assert.equal(again.value, 2, 'the read made for this caller, not the stale value');
    assert.equal(again.meta.hit, false); assert.equal(again.meta.stale, false); assert.equal(again.meta.refreshing, false);
    await tick(60); fail = true;
    const kept = await cache.get(key, loader, { ttl: 50 });
    assert.equal(kept.value, 2); assert.equal(kept.meta.stale, true); assert.equal(kept.meta.error, 'boom');
    await tick(20);
    assert.equal(loads, 3, 'nothing was left loading behind an answer');
  });
  test('fresh loads now; concurrent reads share one load; a failed refresh keeps the last value with the error', async () => {
    const key = fresh(); let loads = 0, fail = false;
    const loader = async () => { loads++; await tick(10); if (fail) throw new Error('boom'); return loads; };
    const [a, b] = await Promise.all([cache.get(key, loader, { fresh: true }), cache.get(key, loader, { fresh: true })]);
    assert.equal(a.value, 1); assert.equal(b.value, 1); assert.equal(loads, 1);
    fail = true;
    const r = await cache.get(key, loader, { fresh: true });
    assert.equal(r.value, 1); assert.equal(r.meta.error, 'boom');
  });
});

describe('invalidation', () => {
  test('a load running when its key is invalidated answers its caller but is not stored, and a fresh read starts its own', async () => {
    const key = fresh(); let release; let loads = 0;
    const slow = () => { loads++; return new Promise((r) => { release = r; }); };
    const before = cache.get(key, slow, { fresh: true });   // e.g. a docker.stacks read that saw the old state
    await tick();
    cache.invalidate(`test.op${n}`);                         // e.g. docker.restart lands meanwhile
    const after = cache.get(key, async () => { loads++; return 'after'; }, { fresh: true });
    release('before');
    assert.equal((await before).value, 'before', 'its own caller still gets an answer');
    assert.equal((await after).value, 'after', 'the read after the change did not join the load from before it');
    assert.equal(loads, 2);
    assert.equal(cache.peek(key).value, 'after');
    const again = await cache.get(key, async () => 'never', { ttl: 60_000 });
    assert.equal(again.value, 'after', 'the old load did not overwrite the new value when it settled');
  });
  test('a copy persisted around an invalidation is never hydrated after it', async () => {
    // The write of an entry stored before the drop can land after the drop's unlink: written here by hand, as the cache
    // names its files (sha1 of the key), dated before the invalidation.
    const key = fresh();
    const before = Date.now() - 1;
    cache.invalidate(`test.op${n}`);
    await writeFile(path.join(process.env.DROVER_CACHE, createHash('sha1').update(key).digest('hex').slice(0, 24) + '.json'), JSON.stringify({ key, ts: before, ms: 0, value: 'old' }));
    let loads = 0;
    const r = await cache.get(key, async () => { loads++; return 'new'; }, { ttl: 60_000 });
    assert.equal(r.value, 'new'); assert.equal(loads, 1);
  });
  test('invalidate drops matching keys only and says how many', async () => {
    const a = cache.keyFor('test.keep.a', {}), b = cache.keyFor('test.drop.b', {});
    await cache.get(a, async () => 1); await cache.get(b, async () => 2);
    assert.equal(cache.invalidate('test.drop.'), 1);
    assert.ok(cache.peek(a)); assert.equal(cache.peek(b), null);
    assert.ok((await readdir(process.env.DROVER_CACHE)).length >= 1);
  });
});
