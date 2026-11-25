// The external host guard's state file (core/guard.js) and what vitals does with it: attach a fresh reading to a sample,
// grade it, skip the process listing while it says storm or cliff, and the macOS swap headroom (free swap-volume space
// plus unused swap) with its swapHeadroomGB threshold. The commands are faked as in vitals.test.js.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as v from '../core/vitals.js';
import { parseGuard, readGuard, guardRank, guardStatePath, GUARD_STALE_S } from '../core/guard.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'vitals');
const fx = (n) => readFileSync(path.join(FIX, n), 'utf8');
const NOW = Date.parse('2026-11-24T10:00:00.000Z');
const state = (over = {}) => JSON.stringify({ epoch: NOW / 1000 - 4, level: 'tight', why: 'swap headroom 3 GB', observe: false, sig: { headroom_mb: 3072, runway_s: 420 }, ...over });

describe('parseGuard and readGuard', () => {
  test('a fresh reading: level, why, observe, the two signals and its age', () => {
    assert.deepEqual(parseGuard(state(), NOW), { level: 'tight', why: 'swap headroom 3 GB', observe: false, headroomMB: 3072, runwayS: 420, ageS: 4 });
    assert.deepEqual(parseGuard(state({ level: 'cliff', observe: true, sig: undefined, why: undefined }), NOW), { level: 'cliff', why: '', observe: true, headroomMB: null, runwayS: null, ageS: 4 });
    assert.equal(parseGuard(state({ sig: { headroom_mb: 'lots', runway_s: null } }), NOW).headroomMB, null, 'a signal that is not a number is absent');
  });
  test('stale (older than 30 s), from the future, unparseable, no epoch or an unknown level: absent, so everything fails open', () => {
    assert.equal(GUARD_STALE_S, 30);
    assert.notEqual(parseGuard(state({ epoch: NOW / 1000 - 30 }), NOW), null, 'exactly 30 s is still fresh');
    assert.equal(parseGuard(state({ epoch: NOW / 1000 - 31 }), NOW), null);
    assert.equal(parseGuard(state({ epoch: NOW / 1000 + 600 }), NOW), null);
    for (const bad of ['', 'not json', '[]', 'null', '{}', state({ epoch: undefined }), state({ epoch: '1767000000' }), state({ level: 'panic' }), state({ level: undefined })]) assert.equal(parseGuard(bad, NOW), null, bad);
  });
  test('levels rank mildest first', () => {
    assert.deepEqual(['calm', 'tight', 'storm', 'cliff', 'x'].map(guardRank), [0, 1, 2, 3, -1]);
  });
  test('readGuard reads the file DROVER_GUARD_STATE names; unset, missing or unreadable is null and never throws', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'drover-guard-'));
    try {
      const f = path.join(dir, 'guard.json');
      await writeFile(f, state());
      assert.equal(guardStatePath({}), null);
      assert.equal(await readGuard({ env: {}, now: NOW }), null, 'unset: off');
      assert.equal(guardStatePath({ DROVER_GUARD_STATE: f }), f);
      assert.equal((await readGuard({ env: { DROVER_GUARD_STATE: f }, now: NOW })).level, 'tight');
      assert.equal((await readGuard({ env: { APXW_GUARD_STATE: f }, now: NOW })).level, 'tight', 'the legacy spelling works');
      assert.equal(await readGuard({ env: { DROVER_GUARD_STATE: path.join(dir, 'missing.json') }, now: NOW }), null);
      assert.equal(await readGuard({ env: { DROVER_GUARD_STATE: dir }, now: NOW }), null, 'a directory');
      assert.equal(await readGuard({ env: { DROVER_GUARD_STATE: f }, now: NOW + 60_000 }), null, 'a minute later it is stale');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe('sample() with a guard', () => {
  const real = { ...v._deps };
  afterEach(() => { Object.assign(v._deps, real); v._resetRates(); });
  const cpus = () => Array.from({ length: 4 }, () => ({ times: { user: 1000, nice: 0, sys: 0, idle: 3000, irq: 0 } }));
  const darwin = (calls, guard) => Object.assign(v._deps, {
    platform: () => 'darwin', now: () => NOW, host: () => 'mac-a', loadavg: () => [2, 2, 2], cpus, guard: async () => guard,
    registry: async () => { calls.push('registry'); return []; }, read: async () => { throw new Error('no /proc on macOS'); },
    run: async (file, argv) => {
      calls.push(file);
      if (file === 'sysctl') return { code: 0, stdout: fx('darwin-sysctl.txt'), stderr: '' };
      if (file === 'vm_stat') return { code: 0, stdout: fx('darwin-vm_stat.txt'), stderr: '' };
      if (file === 'mount') return { code: 0, stdout: fx('darwin-mount.txt'), stderr: '' };
      if (file === 'ps') return { code: 0, stdout: argv.includes(v.PS_COMM[1]) ? '' : fx('ps-darwin.txt'), stderr: '' };
      if (file === 'df' && argv.includes('/Volumes/share')) return { code: 0, stdout: fx('darwin-df-smb.txt'), stderr: '' };
      if (file === 'df') return { code: 0, stdout: fx('darwin-df.txt'), stderr: '' };
      throw new Error(`unexpected ${file}`);
    },
  });
  const level = (l, extra = {}) => ({ level: l, why: `why ${l}`, observe: false, headroomMB: 2048, runwayS: 60, ageS: 5, ...extra });

  test('no guard: the sample has no guard field and no stale agents', async () => {
    darwin([], null);
    const s = await v.sample();
    assert.equal('guard' in s, false);
    assert.ok(s.agents.every((a) => a.stale === undefined));
  });

  test('a fresh guard is attached as { level, why, observe, headroomMB, runwayS, ageS }', async () => {
    darwin([], level('tight', { observe: true }));
    const s = await v.sample();
    assert.deepEqual(s.guard, { level: 'tight', why: 'why tight', observe: true, headroomMB: 2048, runwayS: 60, ageS: 5 });
  });

  test('macOS swap headroom: the data volume\'s free space (one APFS container with the swap volume) plus unused swap', async () => {
    darwin([], null);
    const s = await v.sample();
    // 24260272 KB free = 23.1 GB (a tenth of a GB is what a volume reports) + 7168 - 6196 MB of swap made and not in use
    assert.equal(s.swap.headroomMB, 24626);
    assert.equal(v.historyLine(s).swapHeadroomMB, 24626);
    assert.equal(v.historyLine(s).guard, null);
  });

  test('swapHeadroom: absent on Linux (fixed swap), when the data volume was not measured, and never negative on unused swap', () => {
    const vols = [{ mount: '/System/Volumes/Data', availGB: 10 }];
    assert.deepEqual(v.swapHeadroom({ dynamic: true, totalMB: 4096, usedMB: 1024 }, vols), { headroomMB: 10 * 1024 + 3072 });
    assert.deepEqual(v.swapHeadroom({ dynamic: true, totalMB: 1000, usedMB: 2000 }, vols), { headroomMB: 10 * 1024 }, 'used past total: no negative unused swap');
    assert.deepEqual(v.swapHeadroom({ totalMB: 4096, usedMB: 1024 }, vols), {});
    assert.deepEqual(v.swapHeadroom({ dynamic: true, totalMB: 4096, usedMB: 1024 }, []), {});
    assert.deepEqual(v.swapHeadroom(null, vols), {});
  });

  test('storm or cliff: no ps and no registry read, the previous agents come back marked stale; a calm tick samples again', async () => {
    const calls = [];
    darwin(calls, level('calm'));
    const first = await v.sample();
    assert.ok(first.agents.length > 0 && calls.includes('ps'), 'the fixture has agents');
    for (const l of ['storm', 'cliff']) {
      calls.length = 0;
      darwin(calls, level(l));
      const s = await v.sample();
      assert.equal(calls.includes('ps'), false, `${l}: ps is skipped`);
      assert.equal(calls.includes('registry'), false, `${l}: so is the registry`);
      assert.ok(calls.includes('df') && calls.includes('vm_stat'), 'the cheap readings still run');
      assert.deepEqual(s.agents.map((a) => a.pid), first.agents.map((a) => a.pid), 'the same agents');
      assert.ok(s.agents.every((a) => a.stale === true));
      assert.deepEqual(s.top, first.top);
      assert.deepEqual(s.agentTotals, first.agentTotals);
    }
    calls.length = 0;
    darwin(calls, level('tight'));
    const back = await v.sample();
    assert.ok(calls.includes('ps'), 'tight still samples processes');
    assert.ok(back.agents.every((a) => a.stale === undefined));
  });

  test('storm with nothing sampled before: no agents, not an error', async () => {
    const calls = [];
    darwin(calls, level('storm'));
    const s = await v.sample();
    assert.deepEqual([s.agents, s.top, s.errors], [[], [], undefined]);
  });
});

describe('evaluate: the guard and swap headroom', () => {
  const key = (checks, k) => checks.find((c) => c.key === k);
  test('guard: calm is ok, tight warn, storm and cliff crit, graded whether or not the guard only observes; the text carries its why', () => {
    const grade = (l, extra) => key(v.evaluate({ guard: { level: l, why: 'swap runway 20 s', ...extra } }), 'guard');
    assert.deepEqual([grade('calm').level, grade('tight').level, grade('storm').level, grade('cliff').level], ['ok', 'warn', 'crit', 'crit']);
    assert.equal(grade('storm').text, 'host guard storm: swap runway 20 s');
    assert.equal(grade('storm', { observe: true }).level, 'crit', 'observe-only is still what the guard saw');
    assert.equal(key(v.evaluate({ guard: { level: 'calm', why: '' } }), 'guard').text, 'host guard calm');
    assert.equal(key(v.evaluate({}), 'guard'), undefined, 'no guard, no check');
    assert.equal(key(v.evaluate({ guard: { level: 'panic', why: '' } }), 'guard'), undefined, 'an unknown level is no reading');
  });
  test('swapHeadroomGB grades below, on macOS dynamic swap only; unset thresholds stay ok; swapUsedGB still works beside it', () => {
    const th = v.mergeThresholds(v.DEFAULT_THRESHOLDS, { swapHeadroomGB: { warn: 30, crit: 10 }, swapUsedGB: { warn: 5, crit: 16 } });
    const mac = (headroomMB, usedMB = 6196) => ({ swap: { totalMB: 7168, usedMB, usedPct: 86, dynamic: true, headroomMB } });
    assert.deepEqual(['warn', 'crit', 'ok'].map((l, i) => key(v.evaluate(mac([20, 8, 50][i] * 1024), th), 'swapheadroom').level), ['warn', 'crit', 'ok']);
    const c = key(v.evaluate(mac(8 * 1024), th), 'swapheadroom');
    assert.equal(c.text, 'swap headroom 8 GB (free disk plus unused swap)');
    assert.equal(c.limitText, '10 GB');
    assert.equal(key(v.evaluate(mac(2 * 1024)), 'swapheadroom').level, 'ok', 'default thresholds are off');
    assert.equal(key(v.evaluate(mac(8 * 1024), th), 'swap').level, 'warn', 'swapUsedGB (6.1 GB over 5) is graded as it always was');
    assert.equal(key(v.evaluate({ swap: { totalMB: 8192, usedMB: 100, usedPct: 1, headroomMB: 1 } }, th), 'swapheadroom'), undefined, 'a fixed-size swap has no headroom check');
    assert.equal(key(v.evaluate({ swap: { totalMB: 7168, usedMB: 6196, usedPct: 86, dynamic: true } }, th), 'swapheadroom'), undefined, 'no reading, no check');
  });
  test('the monitor forgets the guard check when its reading goes away, instead of keeping it raised', () => {
    const m = new v.Monitor({ host: 'h' });
    const crit = [{ key: 'guard', level: 'crit', text: 'host guard storm: x' }];
    assert.equal(m.step(crit, { sustain: 1 }, 1_000_000)[0].kind, 'crit');
    assert.deepEqual(m.raised().map((r) => r.key), ['guard']);
    m.step([], { sustain: 1 }, 1_001_000);
    assert.deepEqual(m.raised(), []);
  });
});
