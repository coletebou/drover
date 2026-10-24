// core/placement.js and the ops on it: the catalog (files merged, bad entries reported, never fatal), this machine's
// identity and the hosts it may see (never another identity's), the monitor policy, judge/choose/reasonFor, and through
// the op table fleet.place, fleet.vitals and launch.start host "auto" with fake ssh peers standing in for the other
// machines. ssh config Include lines count as known hosts. Temp HOME, dotfiles, state and cache keep the real ones untouched.
import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import path from 'node:path';

const tmp = await mkdtemp(path.join(tmpdir(), 'drover-placement-'));
const HOME = path.join(tmp, 'home');
process.env.HOME = HOME;
process.env.DROVER_CACHE = path.join(tmp, 'cache');
process.env.DROVER_STATE = path.join(tmp, 'state');
process.env.DROVER_DOTFILES = path.join(tmp, 'dotfiles');
process.env.DROVER_EVENTS = path.join(tmp, 'dotfiles', 'claude', 'drover-events.jsonl');
process.env.DROVER_FLEET_CATALOG = path.join(tmp, 'fleet.json');
process.env.DROVER_FLEET_DIR = path.join(tmp, 'fleet.d');
process.env.DROVER_HOST = 'box-a';
delete process.env.DROVER_VITALS;
await mkdir(path.join(HOME, '.ssh', 'config.d'), { recursive: true });
await mkdir(path.join(tmp, 'dotfiles', 'claude'), { recursive: true });
await mkdir(process.env.DROVER_STATE, { recursive: true });
await mkdir(process.env.DROVER_FLEET_DIR, { recursive: true });
await writeFile(path.join(tmp, 'dotfiles', 'claude', 'fleet-hosts.txt'), 'box-b\nbox-c\nmac-a\n');
await writeFile(process.env.DROVER_EVENTS, '');
await writeFile(path.join(HOME, '.df-profile'), 'export DF_MACHINE=box-a\nexport DF_IDENTITY=personal\nexport DF_ROLE=server\n');
await writeFile(path.join(HOME, '.ssh', 'config'), 'Include ~/.ssh/config.local\nInclude config.d/*.conf\nHost box-b\n  HostName 10.0.0.2\nHost *\n  ServerAliveInterval 30\n');
await writeFile(path.join(HOME, '.ssh', 'config.local'), '# BEGIN burst\nHost burst-one\n  HostName 203.0.113.9\n# END burst\n');
await writeFile(path.join(HOME, '.ssh', 'config.d', 'extra.conf'), 'Host extra-box other-alias\n  HostName 10.0.0.9\n');

const placement = await import('../core/placement.js');
const vitals = await import('../core/vitals.js');
const api = await import('../core/api.js');
const remote = await import('../core/remote.js');
const hosts = await import('../core/hosts.js');
const { META } = await import('../core/ops-meta.js');
const { ALL_TOOLS } = await import('../mcp/server.js');
after(async () => { remote.stopAll(); await rm(tmp, { recursive: true, force: true }); });

const GB = 1024;
/** A vitals sample as host.vitals answers it. */
const sampleOf = ({ host, os = 'linux', availGB = 10, totalGB = 16, load = 1, cores = 8, swapPct = 10, pressure = null, diskFreeGB = 100, ts = new Date().toISOString(), checks = [] } = {}) => ({
  host, os, ts, cpu: { cores, load1: load, perCore: load / cores },
  mem: { totalMB: totalGB * GB, availableMB: availGB * GB, availablePct: Math.round((availGB / totalGB) * 100), pressure },
  swap: { totalMB: 8 * GB, usedMB: (8 * GB * swapPct) / 100, usedPct: swapPct, ...(os === 'darwin' ? { dynamic: true } : {}) },
  disks: [{ mount: os === 'darwin' ? '/System/Volumes/Data' : '/', usedPct: 50, availGB: diskFreeGB }], agents: [], checks, monitor: { raised: [] },
});

const catalog = {
  version: 1,
  hosts: [
    { name: 'box-a', identity: 'personal', aliases: ['alpha'], placement: { classes: ['claude-session', 'codex-session'], weight: 0.6, reserveMemGB: 3 }, monitor: { enabled: true } },
    { name: 'box-b', identity: 'personal', placement: { classes: ['claude-session', 'codex-session', 'heavy-build'] }, monitor: { enabled: true } },
    { name: 'box-c', identity: 'personal', placement: {}, monitor: { enabled: true } },
    { name: 'mac-a', identity: 'personal', placement: { classes: ['macos-only', 'claude-session'], weight: 0.5, maxLoad: 50, maxLoadPerCore: 5 } },
    { name: 'work-1', identity: 'work', ssh: 'box-b', placement: {}, monitor: { enabled: true } },
    { name: 'nobody', placement: {}, monitor: { enabled: true } },
  ],
  placement: { classes: { 'gpu-job': { needMemGB: 12, needCores: 2 } } },
  monitor: { thresholds: { diskUsedPct: { warn: 80 } } },
};
await writeFile(process.env.DROVER_FLEET_CATALOG, JSON.stringify(catalog));

/** Fake `ssh <host> drover rpc` peers: answers[host](op, args) returns a result, or 'ERR:...'; null means the host is down (exit 255). */
let answers = {};
const calls = [];
remote._deps.spawn = (file, argv) => {
  const host = argv[argv.indexOf('--') - 1];
  const c = new EventEmitter();
  c.stdout = new PassThrough(); c.stderr = new PassThrough();
  c.stdin = {
    write(d) {
      for (const line of String(d).split('\n').filter(Boolean)) {
        const req = JSON.parse(line); calls.push({ host, op: req.op, args: req.args });
        const fn = answers[host];   // read per request: a test may take a host down while its peer is still open
        if (!fn) { setImmediate(() => { c.stderr.write(`ssh: connect to host ${host} port 22: Connection timed out\n`); c.emit('close', 255); }); return; }
        const a = fn(req.op, req.args);
        setImmediate(() => c.stdout.write(JSON.stringify(typeof a === 'string' && a.startsWith('ERR:') ? { id: req.id, ok: false, error: a.slice(4) } : { id: req.id, ok: true, result: a }) + '\n'));
      }
    },
    end() { setTimeout(() => c.emit('close', 0), 5); }, on() {},
  };
  c.kill = () => setImmediate(() => c.emit('close', null));
  return c;
};
/** This machine's own sample: written where the daemon keeps its last one. */
const setLocal = (s) => writeFile(path.join(process.env.DROVER_STATE, 'vitals.json'), JSON.stringify(s));

describe('the catalog', () => {
  test('files merge by name (fleet.d extends), bad entries and files are reported, never fatal', async () => {
    await writeFile(path.join(process.env.DROVER_FLEET_DIR, '10-burst.json'), JSON.stringify({ hosts: [{ name: 'burst-one', identity: 'personal', ephemeral: true, placement: { classes: ['heavy-build'] } }, { name: 'bad name!' }, { name: 'box-b', identity: 'personal', placement: { classes: ['heavy-build'] } }, { name: 'work-1', identity: 'personal', ssh: 'box-c' }, { name: 'box-c', ssh: 'box-b', placement: { weight: 9 } }] }));
    await writeFile(path.join(process.env.DROVER_FLEET_DIR, '20-broken.json'), '{ not json');
    await writeFile(path.join(process.env.DROVER_FLEET_DIR, 'notes.txt'), 'ignored');
    try {
      const cat = await placement.loadCatalog();
      assert.equal(cat.found, true);
      assert.deepEqual(cat.hosts.map((h) => h.name), ['box-a', 'box-b', 'box-c', 'mac-a', 'work-1', 'nobody', 'burst-one']);
      assert.deepEqual(cat.hosts.find((h) => h.name === 'box-b').placement, { classes: ['heavy-build'] }, 'a later file\'s entry extends (and here replaces) a field');
      assert.equal(cat.errors.length, 4);
      assert.match(cat.errors.join('\n'), /a host without a valid name[\s\S]*work-1 is already a work host .* its personal entry is ignored[\s\S]*box-c is already a personal host .* its identity-less entry is ignored[\s\S]*20-broken\.json/);
      assert.equal(cat.hosts.find((h) => h.name === 'box-c').ssh, undefined, 'an identity-less entry never rewrites a host of an identity');
      assert.equal(cat.hosts.find((h) => h.name === 'work-1').identity, 'work', 'an entry of another identity never takes over a host');
      assert.equal(cat.classes['gpu-job'].needMemGB, 12);
      assert.equal(cat.thresholds.diskUsedPct.warn, 80);
    } finally {
      await rm(path.join(process.env.DROVER_FLEET_DIR, '10-burst.json')); await rm(path.join(process.env.DROVER_FLEET_DIR, '20-broken.json'));
    }
  });
  test('this machine is its DF_MACHINE entry before any hostname match, and a hostname never adopts another identity', async () => {
    const cat = { hosts: [{ name: 'ubuntu', identity: 'personal' }, { name: 'work-a', identity: 'work' }] };
    await writeFile(path.join(HOME, '.df-profile'), 'export DF_MACHINE=work-a\nexport DF_IDENTITY=work\n');
    try {
      assert.equal((await placement.whoAmI(cat, 'ubuntu')).entry.name, 'work-a');
      await writeFile(path.join(HOME, '.df-profile'), 'export DF_IDENTITY=work\n');
      const me = await placement.whoAmI(cat, 'ubuntu');
      assert.deepEqual([me.entry, me.identity], [null, 'work'], 'the personal "ubuntu" entry is not this work machine');
    } finally { await writeFile(path.join(HOME, '.df-profile'), 'export DF_MACHINE=box-a\nexport DF_IDENTITY=personal\nexport DF_ROLE=server\n'); }
    assert.ok(placement.hostNames({ name: 'prod-1', ssh: 'p1', aliases: ['prod'] }).includes('p1'), 'an entry answers to its ssh alias');
  });
  test('no catalog file: found false, nothing to scope', async () => {
    const cat = await placement.loadCatalog({ file: path.join(tmp, 'missing.json'), dir: path.join(tmp, 'missing.d') });
    assert.deepEqual([cat.found, cat.hosts, cat.errors], [false, [], []]);
  });
  test('this machine is found by DF_MACHINE or an alias; its identity scopes the fleet; hosts of another identity or of none are never in it', async () => {
    const cat = await placement.loadCatalog();
    const me = await placement.whoAmI(cat, 'some-hostname');
    assert.equal(me.entry.name, 'box-a'); assert.equal(me.identity, 'personal');
    assert.deepEqual(placement.scoped(cat, 'personal').map((h) => h.name), ['box-a', 'box-b', 'box-c', 'mac-a']);
    assert.deepEqual(placement.scoped(cat, 'work').map((h) => h.name), ['work-1']);
    assert.deepEqual(placement.scoped(cat, null), [], 'a machine with no identity sees nothing of a catalog that names identities');
    assert.equal(placement.scoped({ hosts: [{ name: 'a' }, { name: 'b' }] }, null).length, 2, 'a catalog with no identities at all is one fleet');
  });
  test('thresholds: defaults, then the catalog, then the host (volumes and ignore included)', () => {
    const th = placement.thresholdsFor({ thresholds: { diskUsedPct: { warn: 80 } } }, { monitor: { thresholds: { memAvailableGB: { crit: 3 } }, volumes: { '/data': { diskUsedPct: { crit: 90 } } }, ignore: ['/mnt/x'] } });
    assert.deepEqual(th.diskUsedPct, { warn: 80, crit: 95 });
    assert.deepEqual(th.memAvailableGB, { warn: null, crit: 3 });
    assert.deepEqual(th.volumes['/data'], { diskUsedPct: { crit: 90 } });
    assert.deepEqual(th.ignore, ['/mnt/x']);
  });
  test('the monitor runs where the catalog enables it, everywhere without a catalog, and DROVER_VITALS decides outright', async () => {
    assert.equal((await placement.monitorPolicy({ shortName: 'box-a' })).enabled, true);
    await writeFile(path.join(HOME, '.df-profile'), 'export DF_MACHINE=mac-a\nexport DF_IDENTITY=personal\n');
    try {
      assert.equal((await placement.monitorPolicy({ shortName: 'mac-a' })).enabled, false, 'mac-a has no monitor.enabled');
      process.env.DROVER_VITALS = 'on';
      assert.equal((await placement.monitorPolicy({ shortName: 'mac-a' })).enabled, true);
      process.env.DROVER_VITALS = 'off';
      assert.equal((await placement.monitorPolicy({ shortName: 'mac-a' })).enabled, false);
    } finally { delete process.env.DROVER_VITALS; await writeFile(path.join(HOME, '.df-profile'), 'export DF_MACHINE=box-a\nexport DF_IDENTITY=personal\nexport DF_ROLE=server\n'); }
  });
});

describe('judge, choose, reasonFor', () => {
  const cls = placement.DEFAULT_CLASSES['claude-session'];
  const j = (s, policy = {}, c = cls, className = 'claude-session') => placement.judge({ vitals: s, policy, cls: c, className });
  test('memory: what is left after the workload must cover the reserve', () => {
    assert.equal(j(sampleOf({ availGB: 6.6 }), { reserveMemGB: 3 }).eligible, true);
    const r = j(sampleOf({ availGB: 6 }), { reserveMemGB: 3 });
    assert.equal(r.eligible, false); assert.match(r.why[0], /6 GB available, and 3\.5 GB for a claude-session would leave 2\.5 GB, under its 3 GB reserve/);
  });
  test('load caps per core and absolute; the Mac guard: macOS pressure at warn refuses ordinary work, macos-only may still go at warn, never at critical', () => {
    assert.match(j(sampleOf({ load: 14, cores: 8 })).why[0], /over its cap of 1\.5 per core/);
    assert.equal(j(sampleOf({ load: 45, cores: 10, os: 'darwin' }), { maxLoadPerCore: 5, maxLoad: 50 }).eligible, true);
    assert.match(j(sampleOf({ load: 50, cores: 10, os: 'darwin' }), { maxLoadPerCore: 5, maxLoad: 50 }).why.join(), /over its cap of 50/);
    const warn = { kind: 'kernel', level: 'warn' }, crit = { kind: 'kernel', level: 'critical' };
    assert.match(j(sampleOf({ os: 'darwin', pressure: warn })).why.join(), /memory pressure warn/);
    const mo = placement.DEFAULT_CLASSES['macos-only'];
    assert.equal(j(sampleOf({ os: 'darwin', pressure: warn }), {}, mo, 'macos-only').eligible, true);
    assert.match(j(sampleOf({ os: 'darwin', pressure: crit }), {}, mo, 'macos-only').why.join(), /memory pressure critical/);
    assert.match(j(sampleOf({ os: 'linux' }), {}, mo, 'macos-only').why.join(), /macos-only needs macOS/);
  });
  test('swap, swap rate, PSI stalls, disk and class rules', () => {
    assert.match(j(sampleOf({ swapPct: 95 })).why.join(), /swap 95% used/);
    const s = sampleOf(); s.swap.ioPerSec = 900;
    assert.match(j(s).why.join(), /swapping 900 pages\/s/, 'a sample with no in/out split still refuses on ioPerSec');
    // The false storm the monitor stopped raising: 1731 pages/s in, none out, 6.5 of 15.6 GB free.
    const recovering = sampleOf({ availGB: 6.5, totalGB: 15.6 });
    recovering.swap = { ...recovering.swap, ioPerSec: 1731, inPerSec: 1731, outPerSec: 0 };
    assert.equal(j(recovering).eligible, true, 'swap-in with memory to spare is recovery, not a reason to refuse');
    const pushing = sampleOf();
    pushing.swap = { ...pushing.swap, ioPerSec: 600, inPerSec: 0, outPerSec: 600 };
    assert.match(j(pushing).why.join(), /swapping out 600 pages\/s/);
    // 7 GB of 64 is under the 12% mem warn, and 7 - 3.5 still clears the 2 GB reserve.
    const tight = sampleOf({ availGB: 7, totalGB: 64 });
    tight.swap = { ...tight.swap, ioPerSec: 1900, inPerSec: 1800, outPerSec: 100 };
    assert.match(j(tight).why.join(), /swapping 1900 pages\/s in and out while memory is short/);
    const spare = sampleOf({ availGB: 20, totalGB: 64 });
    spare.swap = { ...spare.swap, ioPerSec: 1900, inPerSec: 1800, outPerSec: 100 };
    assert.equal(j(spare).eligible, true, 'the same in plus out is fine while memory is not short and swap-out is under the cap');
    const floored = sampleOf({ availGB: 6.5, totalGB: 15.6 });
    floored.swap = { ...floored.swap, ioPerSec: 1731, inPerSec: 1731, outPerSec: 0 };
    const th = vitals.mergeThresholds(vitals.DEFAULT_THRESHOLDS, { memAvailableGB: { warn: 8, crit: 4 } });
    assert.match(placement.judge({ vitals: floored, cls, className: 'claude-session', thresholds: th }).why.join(), /while memory is short/, 'a host memory floor makes combined swap count');
    assert.match(j(sampleOf({ pressure: { kind: 'psi', some60: 40 } })).why.join(), /memory stalls 40%/);
    assert.match(j(sampleOf({ diskFreeGB: 4 })).why.join(), /disk \/ has 4 GB free, under 5 GB/);
    assert.match(j(sampleOf({ diskFreeGB: 15 }), {}, placement.DEFAULT_CLASSES['heavy-build'], 'heavy-build').why.join(), /under 20 GB/);
    assert.match(j(sampleOf(), { classes: ['codex-session'] }).why.join(), /does not take claude-session/);
    assert.match(j(sampleOf(), { diskPath: '/srv' }).why.join(), /work volume \/srv was not measured/);
    const noDisks = { ...sampleOf(), disks: [] };
    assert.match(j(noDisks).why.join(), /its disks were not measured/, 'no disk figures: a class that needs free disk is refused');
    assert.match(j({ ...sampleOf(), disks: [{ mount: '/mnt/storage box', usedPct: 20, availGB: 4000 }] }).why.join(), /its disks were not measured/, 'a network mount never stands in for the root volume');
    assert.match(j({ ...sampleOf(), mem: { totalMB: 16384, availableMB: null } }).why.join(), /memory unreadable/);
    assert.equal(j(noDisks, { minFreeDiskGB: 0 }).eligible, true, 'unless nothing asks for free disk');
    assert.deepEqual(placement.judge({ vitals: null, error: 'timed out', cls, className: 'claude-session' }).why, ['unreachable: timed out']);
  });
  test('score: headroom times weight, scaled down by heavy swap and by macOS pressure at warn', () => {
    const a = j(sampleOf({ availGB: 12, load: 1 })), b = j(sampleOf({ availGB: 12, load: 1 }), { weight: 0.5 });
    assert.ok(a.score > 0 && Math.abs(b.score - a.score / 2) < 0.002);
    assert.ok(j(sampleOf({ availGB: 12, swapPct: 80 })).score < a.score);
    assert.ok(j(sampleOf({ availGB: 12, load: 6 })).score < a.score);
  });
  test('choose: highest score; prefer wins a near tie only; then less load per core; reasonFor names the runner-up or every blocker', () => {
    const c = (name, score, load = 1) => ({ name, eligible: true, score, why: [], facts: { load, cores: 8, availGB: 9, totalGB: 16 } });
    assert.equal(placement.choose([c('x', 0.40), c('y', 0.43)], { prefer: 'x' }).name, 'x');
    assert.equal(placement.choose([c('x', 0.30), c('y', 0.43)], { prefer: 'x' }).name, 'y');
    assert.equal(placement.choose([c('x', 0.4, 6), c('y', 0.4, 1)]).name, 'y');
    assert.equal(placement.choose([{ name: 'z', eligible: false, score: 0, why: ['no'], facts: {} }]), null);
    const best = c('y', 0.43);
    assert.match(placement.reasonFor(best, [c('x', 0.3), best], 'claude-session'), /^y: 9 GB of 16 GB available, load 1 on 8 cores; score 0\.43 \(next x 0\.3\)$/);
    assert.equal(placement.reasonFor(null, [{ name: 'x', display: 'box-x', why: ['unreachable'] }], 'claude-session'), 'no eligible host for claude-session: box-x: unreachable');
  });
});

describe('fleet.place, fleet.vitals and launch.start host auto through the op table', () => {
  afterEach(() => { remote.stopAll(); api.cache.invalidate('fleet.'); api._resetReservations(); calls.length = 0; });

  test('the eligible host with the most headroom; other identities and hosts without placement are never asked', async () => {
    await setLocal(sampleOf({ host: 'box-a', availGB: 5 }));   // 5 - 3.5 < its 3 GB reserve
    answers = { 'box-b': () => sampleOf({ host: 'box-b', availGB: 12 }), 'box-c': () => sampleOf({ host: 'box-c', availGB: 7, load: 6 }), 'mac-a': () => sampleOf({ host: 'mac-a', os: 'darwin', availGB: 9, pressure: { kind: 'kernel', level: 'warn' } }) };
    const r = await api.front['fleet.place']({ class: 'claude-session' });
    assert.equal(r.host, 'box-b'); assert.equal(r.alias, 'box-b'); assert.equal(r.identity, 'personal');
    assert.match(r.reason, /^box-b: 12 GB of 16 GB available/);
    const by = Object.fromEntries(r.candidates.map((c) => [c.name, c]));
    assert.equal(by['box-a'].host, 'local'); assert.equal(by['box-a'].eligible, false);
    assert.equal(by['mac-a'].eligible, false); assert.match(by['mac-a'].why.join(), /memory pressure warn/);
    assert.equal(by['box-c'].eligible, true);
    assert.deepEqual(Object.keys(by).sort(), ['box-a', 'box-b', 'box-c', 'mac-a'], 'work-1 (reached as box-b) and nobody are not candidates');
    assert.equal(calls.filter((c) => c.op === 'host.vitals').length, 3, 'one host.vitals per remote candidate, none for another identity');
  });
  test('exclude by alias or "local"; "local" when this machine is the best; nothing eligible: host null and every blocker named', async () => {
    await setLocal(sampleOf({ host: 'box-a', availGB: 14 }));
    // box-a (weight 0.6) scores 0.38, plus 0.05 for being the caller's own machine; box-b with 6 GB scores 0.37.
    answers = { 'box-b': () => sampleOf({ host: 'box-b', availGB: 6 }), 'box-c': null, 'mac-a': () => 'ERR:unknown op host.vitals' };
    const r = await api.front['fleet.place']({ class: 'claude-session' });
    assert.equal(r.host, 'local'); assert.equal(r.alias, 'box-a');
    assert.match(r.candidates.find((c) => c.name === 'box-c').why[0], /^unreachable: .*exited 255/);
    assert.match(r.candidates.find((c) => c.name === 'mac-a').why[0], /unreachable: unknown op host\.vitals/);
    const r2 = await api.front['fleet.place']({ class: 'claude-session', exclude: ['alpha', 'box-b'] });
    assert.equal(r2.host, null);
    assert.deepEqual(r2.excluded, ['box-a', 'box-b']);
    assert.match(r2.reason, /^no eligible host for claude-session: box-c: unreachable/);
    const r3 = await api.front['fleet.place']({ class: 'codex-session', exclude: ['local'] });
    assert.equal(r3.host, 'box-b');
  });
  test('macos-only goes only to macOS; a catalog class works; an unknown class is refused', async () => {
    await setLocal(sampleOf({ host: 'box-a', availGB: 14 }));
    answers = { 'box-b': () => sampleOf({ host: 'box-b', availGB: 15 }), 'box-c': () => sampleOf({ host: 'box-c', availGB: 15 }), 'mac-a': () => sampleOf({ host: 'mac-a', os: 'darwin', availGB: 9, load: 20, cores: 10, pressure: { kind: 'kernel', level: 'warn' } }) };
    const r = await api.front['fleet.place']({ class: 'macos-only' });
    assert.equal(r.host, 'mac-a', 'pressure at warn is allowed for macos-only; load 20 is under its cap of 50');
    const g = await api.front['fleet.place']({ class: 'gpu-job' });
    assert.equal(g.host, 'box-c', 'box-c lists no classes, so it takes the catalog\'s own class; 12 GB plus its 2 GB reserve fit');
    assert.match(g.candidates.find((c) => c.name === 'box-a').why.join(), /does not take gpu-job/);
    assert.match(g.candidates.find((c) => c.name === 'box-b').why.join(), /does not take gpu-job/);
    assert.match((await api.front['fleet.place']({ class: 'gpu-job', needMemGB: 14 })).reason, /^no eligible host for gpu-job:.*box-c: memory: 15 GB available, and 14 GB for a gpu-job would leave 1 GB/);
    await assert.rejects(api.front['fleet.place']({ class: 'nope' }), /unknown class "nope": one of claude-session, codex-session, heavy-build, macos-only, gpu-job/);
  });
  test('fleet.vitals: this machine and the monitored hosts; a host that stops answering shows its last sample, stale, with the error', async () => {
    await setLocal(sampleOf({ host: 'box-a', checks: [{ key: 'disk:/', level: 'warn', text: 'disk / 90% full' }] }));
    answers = { 'box-b': () => sampleOf({ host: 'box-b' }), 'box-c': () => sampleOf({ host: 'box-c', checks: [{ key: 'mem', level: 'crit', text: 'memory low' }] }) };
    const r = await api.front['fleet.vitals']({});
    assert.deepEqual(r.hosts.map((h) => [h.host, h.route, h.ok, h.level]), [['box-a', 'local', true, 'warn'], ['box-b', 'box-b', true, 'ok'], ['box-c', 'box-c', true, 'crit']]);
    assert.deepEqual(r.hosts[2].problems, [{ key: 'mem', level: 'crit', text: 'memory low' }]);
    answers['box-c'] = null;
    const r2 = await api.front['fleet.vitals']({ fresh: true });
    const c = r2.hosts.find((h) => h.host === 'box-c');
    assert.equal(c.ok, false); assert.equal(c.stale, true); assert.match(c.error, /exited 255/);
    assert.equal(c.vitals.host, 'box-c', 'the last sample is still shown');
    const r3 = await api.front['fleet.vitals']({ hosts: ['local', 'box-b'] });
    assert.deepEqual(r3.hosts.map((h) => h.route), ['local', 'box-b']);
    const before = calls.length;
    await assert.rejects(api.front['fleet.vitals']({ hosts: ['work-1'] }), /work-1 is not a host of this machine's fleet \(personal\)/, 'a host of another identity, even named, is never read');
    await assert.rejects(api.front['fleet.vitals']({ hosts: ['extra-box'] }), /extra-box is not a host of this machine's fleet/, 'nor a known ssh host the catalog does not list');
    assert.equal(calls.length, before, 'no rpc was made for either');
  });
  test('launch.start host auto: placed, launched there, the placement in the result; nothing eligible starts nothing', async () => {
    await setLocal(sampleOf({ host: 'box-a', availGB: 5 }));
    const launched = [];
    answers = { 'box-b': (op, args) => (op === 'host.vitals' ? sampleOf({ host: 'box-b', availGB: 12 }) : op === 'launch.start' ? (launched.push(args), { ok: true, tmux: 'agents:@4' }) : 'ERR:unexpected'), 'box-c': null, 'mac-a': null };
    const r = await api.dispatch('launch.start', { host: 'auto', engine: 'claude', prompt: 'hi', name: 'placed', placement: 'claude-session' });
    assert.deepEqual(r.placement.host, 'box-b'); assert.equal(r.tmux, 'agents:@4');
    assert.equal(launched.length, 1); assert.equal(launched[0].prompt, 'hi');
    assert.equal(launched[0].placement, undefined, 'the placement fields stay on this side');
    // box-b goes down after its vitals were read: its launch never connects, so the launch is placed again without it.
    answers['box-b'] = null;
    await assert.rejects(api.dispatch('launch.start', { host: 'auto', engine: 'claude', prompt: 'hi' }), /nothing was started: no eligible host for claude-session: .*; before that box-b could not be reached \(ssh box-b drover rpc exited 255: ssh: connect to host box-b port 22: Connection timed out\)$/);
    assert.equal(launched.length, 1);
    await assert.rejects(api.dispatch('launch.start', { host: 'auto', engine: 'claude', prompt: 'hi' }), /nothing was started: no eligible host/, 'with fresh figures it is unreachable before any launch');
  });
  test('placements are reserved for a few minutes, so back-to-back launches do not all land on one host', async () => {
    await setLocal(sampleOf({ host: 'box-a', availGB: 5 }));
    answers = { 'box-b': () => sampleOf({ host: 'box-b', availGB: 9 }), 'box-c': () => sampleOf({ host: 'box-c', availGB: 7 }), 'mac-a': null };
    const first = await api.front['fleet.place']({ class: 'claude-session', reserve: true });
    assert.deepEqual([first.host, first.reserved], ['box-b', 3.5]);
    const second = await api.front['fleet.place']({ class: 'claude-session', reserve: true });
    assert.equal(second.host, 'box-c', 'box-b now counts the 3.5 GB just placed there');
    assert.match(second.candidates.find((c) => c.name === 'box-b').why.join() || 'eligible', /after 3.5 GB just placed there|eligible/);
    const probe = await api.front['fleet.place']({ class: 'claude-session' });
    assert.equal(probe.reserved, undefined, 'a placement without reserve holds nothing');
  });
  test('an invalid catalog fails closed: only this machine, no candidates, named hosts refused', async () => {
    const good = process.env.DROVER_FLEET_CATALOG;
    process.env.DROVER_FLEET_CATALOG = path.join(tmp, 'broken-fleet.json');
    await writeFile(process.env.DROVER_FLEET_CATALOG, '{ "hosts": [ broken');
    try {
      await setLocal(sampleOf({ host: 'box-a' }));
      answers = { 'box-b': () => sampleOf({ host: 'box-b', availGB: 12 }) };
      const r = await api.front['fleet.vitals']({});
      assert.deepEqual(r.hosts.map((h) => h.route), ['local']);
      assert.equal((await api.front['fleet.place']({ class: 'claude-session' })).host, null);
      await assert.rejects(api.front['fleet.vitals']({ hosts: ['box-b'] }), /fleet catalog is invalid/);
      assert.equal(calls.length, 0, 'no other host was read');
    } finally { process.env.DROVER_FLEET_CATALOG = good; }
  });
  test('a launch that fails after it may have started is not placed again', async () => {
    await setLocal(sampleOf({ host: 'box-a', availGB: 5 }));
    let n = 0;
    answers = { 'box-b': (op) => (op === 'host.vitals' ? sampleOf({ host: 'box-b', availGB: 12 }) : (n++, 'ERR:tmux: session agents not found')), 'box-c': null, 'mac-a': null };
    await assert.rejects(api.dispatch('launch.start', { host: 'auto', engine: 'claude', prompt: 'hi' }), /tmux: session agents not found/);
    assert.equal(n, 1);
  });
});

describe('the surfaces', () => {
  test('ssh config Include lines (a file, a relative glob) count as known hosts', async () => {
    const names = await hosts.sshAliases();
    for (const n of ['box-b', 'burst-one', 'extra-box', 'other-alias']) assert.ok(names.includes(n), n);
    assert.ok(!names.includes('*'));
    assert.equal(await hosts.assertKnownHost('burst-one'), 'burst-one');
  });
  test('the new ops are described for MCP; drover_launch takes host auto and a placement class', () => {
    for (const op of ['host.vitals', 'fleet.vitals', 'fleet.place']) {
      assert.equal(META[op].m, false, op);
      assert.ok(META[op].d.length > 80, op);
      for (const [k, p] of Object.entries(META[op].s.properties)) assert.equal(typeof p.description, 'string', `${op}.${k}`);
      assert.ok(ALL_TOOLS.some((t) => t.name === `drover_${op.replace(/\./g, '_')}`), op);
    }
    const launch = ALL_TOOLS.find((t) => t.name === 'drover_launch');
    assert.match(launch.inputSchema.properties.host.description, /"auto"/);
    assert.ok(launch.inputSchema.properties.placement);
    assert.match(META['launch.start'].s.properties.host.description, /"auto"/);
  });
  test('resource is an alert category with its own sound settings', async () => {
    const policy = await import('../ui/notify-policy.js');
    assert.ok(policy.CATEGORY_IDS.includes('resource'));
    assert.equal(policy.DEFAULT_SETTINGS.categories.resource.enabled, true);
    const d = policy.decide({ category: 'resource', kind: 'crit', title: 't' }, policy.DEFAULT_SETTINGS);
    assert.equal(d.show, true); assert.equal(d.sound, 'fall');
  });
});
