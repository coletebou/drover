// core/vitals.js: the Linux and macOS parsers on real command output (test/fixtures/vitals), each agent's process tree
// (nested agents counted once, the Claude desktop app not an agent, no command line in the result), a whole sample
// with the commands faked, grading against thresholds, and the monitor's state machine (sustain, raise, quiet easing,
// cleared, said again, forgotten agents).
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as v from '../core/vitals.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'vitals');
const fx = (n) => readFileSync(path.join(FIX, n), 'utf8');

describe('Linux parsers', () => {
  test('meminfo: MemAvailable, swap used = total - free', () => {
    const m = v.parseMeminfo(fx('linux-meminfo.txt'));
    assert.equal(Math.round(m.totalMB), 15614);
    assert.equal(Math.round(m.availableMB), 5780);
    assert.equal(Math.round(m.swapTotalMB), 16384);
    assert.equal(Math.round(m.swapUsedMB), 12072);
    assert.equal(v.parseMeminfo('nothing here'), null);
  });
  test('meminfo without MemAvailable (old kernels) falls back to free + cached + buffers', () => {
    const m = v.parseMeminfo('MemTotal: 1024000 kB\nMemFree: 102400 kB\nCached: 204800 kB\nBuffers: 102400 kB\n');
    assert.equal(m.availableMB, 400);
    assert.equal(m.swapUsedMB, 0);
  });
  test('PSI and swap counters', () => {
    assert.deepEqual(v.parsePsi(fx('linux-psi-memory.txt')), { some: { avg10: 0, avg60: 0.16, avg300: 0.42 }, full: { avg10: 0, avg60: 0.12, avg300: 0.3 } });
    assert.equal(v.parsePsi(''), null);
    assert.equal(v.parseLinuxVmstat(fx('linux-vmstat-1.txt')), 3_000_000);
    assert.equal(v.parseLinuxVmstat('nr_free_pages 1\n'), null);
  });
  test('a btrfs root mounted as a subvolume is the filesystem, not a bind mount', () => {
    const vols = v.pickLinuxVolumes(v.parseMountinfo('29 1 0:26 /@ / rw,relatime shared:1 - btrfs /dev/nvme0n1p2 rw,subvol=/@\n30 1 0:26 /@home /home rw,relatime shared:2 - btrfs /dev/nvme0n1p2 rw,subvol=/@home\n'));
    assert.deepEqual(vols, [{ mount: '/', fstype: 'btrfs', kind: 'local' }], 'the first mount of the filesystem, once');
  });
  test('volumes: each filesystem once, network and FUSE mounts kept apart, no pseudo, snap, boot, container or bind mounts', () => {
    const vols = v.pickLinuxVolumes(v.parseMountinfo(fx('linux-mountinfo.txt')));
    assert.deepEqual(vols, [
      { mount: '/', fstype: 'ext4', kind: 'local' },
      { mount: '/mnt/data', fstype: 'ext4', kind: 'local' },
      { mount: '/mnt/storage box', fstype: 'fuse.rclone', kind: 'remote' },
      { mount: '/mnt/c', fstype: '9p', kind: 'remote' },
    ]);
  });
});

describe('macOS parsers', () => {
  test('sysctl, swapusage and vm_stat', () => {
    const s = v.parseSysctl(fx('darwin-sysctl.txt'));
    assert.equal(s['hw.memsize'], '17179869184');
    assert.equal(s['kern.memorystatus_vm_pressure_level'], '2');
    assert.deepEqual(v.parseSwapusage(s['vm.swapusage']), { totalMB: 7168, usedMB: 6196.12 });
    assert.deepEqual(v.parseSwapusage('total = 1.50G  used = 512.00K  free = 1.50G'), { totalMB: 1536, usedMB: 0.5 });
    assert.equal(v.parseSwapusage('garbage'), null);
    const vm = v.parseVmStat(fx('darwin-vm_stat.txt'));
    assert.equal(vm.pageSize, 16384);
    assert.equal(vm['pages free'], 4393);
    assert.equal(vm['translation faults'], 25325202185);
    assert.equal(vm.swapins, 16743496);
  });
  test('volumes: the data volume and writable disks under /Volumes (names with spaces too); never the sealed system, VM, Preboot, cryptex, autofs or a read-only image', () => {
    const vols = v.pickDarwinVolumes(v.parseDarwinMount(fx('darwin-mount.txt')));
    assert.deepEqual(vols, [
      { mount: '/System/Volumes/Data', fstype: 'apfs', kind: 'local' },
      { mount: '/Volumes/Archive Disk', fstype: 'apfs', kind: 'local' },
      { mount: '/Volumes/Scratch', fstype: 'apfs', kind: 'local' },
      { mount: '/Volumes/share', fstype: 'smbfs', kind: 'remote' },
    ]);
  });
});

describe('df, ps and clocks', () => {
  test('df -Pk: filesystem names and mount points with spaces', () => {
    const d = v.parseDf(fx('darwin-df.txt'));
    assert.deepEqual(d.map((x) => [x.fs, x.mount, x.usedPct, Math.round(x.availGB)]), [['/dev/disk3s5', '/System/Volumes/Data', 89, 23], ['/dev/disk7s1', '/Volumes/Archive Disk', 96, 12], ['/dev/disk9s1', '/Volumes/Scratch', 94, 31]]);
    assert.deepEqual(v.parseDf('Filesystem 1024-blocks Used Available Capacity Mounted on\nmap auto_home 0 0 0 100% /System/Volumes/Data/home\n')[0].fs, 'map auto_home');
    assert.equal(v.parseDf(fx('linux-df-rclone.txt'))[0].mount, '/mnt/storage box');
  });
  test('ps time and etime in both systems\' shapes', () => {
    assert.equal(v.clockSec('00:01:26'), 86);
    assert.equal(v.clockSec('8-19:01:42'), 8 * 86400 + 19 * 3600 + 102);
    assert.equal(v.clockSec('20:53'), 1253);
    assert.equal(v.clockSec('01-21:08:33'), 86400 + 21 * 3600 + 513);
    assert.equal(v.clockSec('0:01.23'), 1.23);
    assert.equal(v.clockSec('123:45.67'), 123 * 60 + 45.67);
    assert.equal(v.clockSec('nonsense'), null);
  });
  test('agent engines: the claude binary, Claude Code under node, codex and its native binary; never the Claude desktop app', () => {
    assert.equal(v.agentEngine('claude --effort max'), 'claude');
    assert.equal(v.agentEngine('/home/u/.local/share/claude/versions/2.1.308 --resume x'), 'claude');
    assert.equal(v.agentEngine('node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'), 'claude');
    assert.equal(v.agentEngine('node /home/u/.npm-global/bin/codex app-server'), 'codex');
    assert.equal(v.agentEngine('/opt/x/vendor/bin/codex exec'), 'codex');
    assert.equal(v.agentEngine('node /opt/rt/node_modules/@openai/codex/bin/codex.js -c x'), 'codex');
    assert.equal(v.agentEngine('/Applications/Claude.app/Contents/MacOS/Claude'), null);
    assert.equal(v.agentEngine('/usr/bin/zsh -c codex exec'), null);
    assert.equal(v.agentEngine('node /home/u/.local/bin/drover mcp'), null);
  });
});

describe('agent trees', () => {
  const comm = v.parsePsComm(fx('ps-linux-comm.txt'));
  const procs = v.parsePs(fx('ps-linux.txt')).map((p) => ({ ...p, comm: comm.get(p.pid) ?? null }));
  const registry = new Map([[300, { pid: 300, sessionId: 'sess-1', name: 'oo-fleet', tmux: 'ops:@3.%3', cwd: '/home/u/code' }]]);

  test('each agent with its whole tree; a codex started from a claude Bash call is its own entry and is not counted twice', () => {
    const { agents } = v.agentTrees(procs, { registry });
    assert.deepEqual(agents.map((a) => [a.engine, a.pid, a.procs, a.rssMB, a.name ?? null, a.role ?? null]), [
      ['claude', 300, 6, 788, 'oo-fleet', null],
      ['codex', 400, 2, 276, null, 'app-server'],
      ['codex', 306, 2, 186, null, 'exec'],
    ]);
    assert.equal(agents[0].tmux, 'ops:@3.%3');
    assert.equal(agents[0].cpuPct, null, 'no earlier reading: no CPU rate');
  });
  test('no command line ever leaves: the prompt in argv is nowhere in the result', () => {
    const r = v.agentTrees(procs, { registry });
    const text = JSON.stringify({ agents: r.agents, top: r.top });
    assert.ok(!/secret prompt|run the review|config-file/.test(text), text);
    assert.deepEqual(r.top.map((t) => [t.program, t.rssMB]), [['openclaw-gatewa', 1367], ['clickhouse-serv', 586], ['init', 12], ['sshd', 4], ['-zsh', 3]]);
    const leaky = [{ pid: 9, ppid: 1, rssKB: 9e6, pcpu: 0, cpuSec: 1, etimeSec: 9, args: '/usr/bin/curl https://user:secret@service.app/Contents/MacOS/x', comm: '/usr/bin/curl' }];
    assert.deepEqual(v.agentTrees(leaky).top.map((t) => t.program), ['curl'], 'the name comes from the executable, never argv');
  });
  test('CPU over the interval from an earlier reading; a process born inside the interval counts all its time', () => {
    const prevTs = 1_000_000, ts = prevTs + 60_000;
    const prev = { ts: prevTs, cpu: new Map(procs.map((p) => [p.pid, p.cpuSec - (p.pid === 300 ? 30 : 0)])) };
    prev.cpu.delete(304);   // vitest (etime 30 s) started after the last reading: its 25 s are all new
    const { agents } = v.agentTrees(procs, { registry, prev, ts });
    const claude = agents.find((a) => a.pid === 300);
    assert.equal(claude.cpuPct, Math.round(((30 + 25) / 60) * 100));
    assert.equal(agents.find((a) => a.pid === 400).cpuPct, 0);
  });
  test('a program name comes from the executable (ps comm) only, and only in a plain-name alphabet', () => {
    assert.equal(v.programName('/Applications/Visual Studio Code.app/Contents/MacOS/Code'), 'Visual Studio Code');
    assert.equal(v.programName('/Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer)'), 'Claude Helper (Renderer)');
    assert.equal(v.programName('/usr/bin/curl'), 'curl');
    assert.equal(v.programName('clickhouse-serv'), 'clickhouse-serv');
    assert.equal(v.programName('/opt/x/token=abc123'), 'process', 'a name that looks like data is dropped');
    assert.equal(v.programName(null), 'process');
    assert.deepEqual([...v.parsePsComm('  12 /Applications/Visual Studio Code.app/Contents/MacOS/Code\n 13 zsh\n')], [[12, '/Applications/Visual Studio Code.app/Contents/MacOS/Code'], [13, 'zsh']]);
  });
  test('macOS: the desktop app and its helpers are not agents; the Claude daemon is, with role daemon', () => {
    const macComm = new Map([[1, '/sbin/launchd'], [19670, '/Applications/Claude.app/Contents/MacOS/Claude'], [19905, '/Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer)'], [61545, '/Users/u/.local/bin/claude'], [70000, '/Users/u/.local/bin/claude'], [70001, 'node']]);
    const mac = v.parsePs(fx('ps-darwin.txt')).map((p) => ({ ...p, comm: macComm.get(p.pid) ?? null }));
    const { agents, top } = v.agentTrees(mac, { registry: new Map([[70000, { pid: 70000, sessionId: 's2', name: 'mac-session' }]]) });
    assert.deepEqual(agents.map((a) => [a.engine, a.pid, a.procs, a.name ?? a.role]), [['claude', 70000, 2, 'mac-session'], ['claude', 61545, 1, 'daemon']]);
    assert.ok(top.some((t) => t.program === 'Claude'), 'the desktop app is an ordinary process, named by its bundle');
  });
  test('a parent loop or a self-parented process cannot hang the walk', () => {
    const loop = [{ pid: 10, ppid: 11, rssKB: 1024, pcpu: 0, cpuSec: 1, etimeSec: 9, args: 'claude' }, { pid: 11, ppid: 10, rssKB: 1024, pcpu: 0, cpuSec: 1, etimeSec: 9, args: 'node x' }, { pid: 12, ppid: 12, rssKB: 1024, pcpu: 0, cpuSec: 1, etimeSec: 9, args: 'sh' }];
    const { agents } = v.agentTrees(loop, { registry: new Map([[10, { pid: 10 }]]) });
    assert.equal(agents.length, 1);
    assert.equal(agents[0].procs, 2);
  });
});

test('cpuBusyPct: busy share across cores between two readings', () => {
  const a = [{ times: { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 } }, { times: { user: 0, nice: 0, sys: 0, idle: 1000, irq: 0 } }];
  const b = [{ times: { user: 200, nice: 0, sys: 100, idle: 900, irq: 0 } }, { times: { user: 50, nice: 0, sys: 0, idle: 1150, irq: 0 } }];
  assert.equal(v.cpuBusyPct(a, b), 50);
  assert.equal(v.cpuBusyPct(a, [b[0]]), null);
  assert.equal(v.cpuBusyPct(null, b), null);
});

describe('sample() with the commands faked', () => {
  const real = { ...v._deps };
  afterEach(() => { Object.assign(v._deps, real); v._resetRates(); });
  const cpus = (idle) => Array.from({ length: 4 }, () => ({ times: { user: 1000, nice: 0, sys: 0, idle, irq: 0 } }));

  test('Linux: memory, PSI, every volume (the FUSE one in its own df), agents, and the swap rate from the second reading on', async () => {
    let now = 1_000_000, vmstat = fx('linux-vmstat-1.txt'), idle = 3000;
    const calls = [];
    Object.assign(v._deps, {
      platform: () => 'linux', now: () => now, host: () => 'box-a', loadavg: () => [2, 1.5, 1], cpus: () => cpus(idle += 1000),
      registry: async () => [{ pid: 300, sessionId: 'sess-1', name: 'oo-fleet', alive: true }],
      read: async (f) => ({ '/proc/meminfo': fx('linux-meminfo.txt'), '/proc/vmstat': vmstat, '/proc/pressure/memory': fx('linux-psi-memory.txt'), '/proc/self/mountinfo': fx('linux-mountinfo.txt') }[f] ?? Promise.reject(new Error('ENOENT'))),
      run: async (file, argv) => {
        calls.push([file, ...argv]);
        if (file === 'ps') return { code: 0, stdout: fx(argv.includes(v.PS_COMM[1]) ? 'ps-linux-comm.txt' : 'ps-linux.txt'), stderr: '' };
        if (file === 'df' && argv.includes('/mnt/storage box')) return { code: 0, stdout: fx('linux-df-rclone.txt'), stderr: '' };
        if (file === 'df' && argv.includes('/mnt/c')) return { code: null, stdout: '', stderr: '', timedOut: true };
        if (file === 'df') return { code: 0, stdout: fx('linux-df.txt'), stderr: '' };
        throw new Error(`unexpected ${file}`);
      },
    });
    const s = await v.sample();
    assert.equal(s.host, 'box-a'); assert.equal(s.os, 'linux');
    assert.deepEqual(s.cpu.cores, 4); assert.equal(s.cpu.perCore, 0.5);
    assert.equal(s.mem.availablePct, 37); assert.deepEqual(s.mem.pressure, { kind: 'psi', some60: 0.16, full60: 0.12 });
    assert.equal(s.swap.usedPct, 74); assert.equal(s.swap.ioPerSec, null, 'one reading: no rate yet');
    assert.deepEqual(s.disks.map((d) => [d.mount, d.kind, d.usedPct]), [['/', 'local', 83], ['/mnt/data', 'local', 62], ['/mnt/storage box', 'remote', 21]]);
    assert.ok(s.errors.some((e) => /df timed out on \/mnt\/c/.test(e)), 'a hung mount is reported, the rest still measured');
    assert.ok(calls.some((c) => c.join(' ') === 'df -Pk / /mnt/data'), 'the local volumes share one df');
    assert.equal(s.agents[0].name, 'oo-fleet');
    assert.equal(s.top[0].program, 'openclaw-gatewa', 'top programs come from the comm column');
    assert.deepEqual(s.agentTotals, { claude: { count: 1, rssMB: 788 }, codex: { count: 2, rssMB: 462 } });
    now += 60_000; vmstat = fx('linux-vmstat-2.txt');
    const s2 = await v.sample({ ignore: ['/mnt/c', '/mnt/storage box'] });
    assert.equal(s2.swap.ioPerSec, 500, '30000 pages in 60 s');
    assert.ok(Number.isFinite(s2.cpu.busyPct));
    assert.ok(s2.agents[0].cpuPct !== null, 'the second reading has a CPU rate per agent');
    assert.deepEqual(s2.disks.map((d) => d.mount), ['/', '/mnt/data'], 'ignored mounts are never measured');
    assert.equal(s2.errors, undefined);
  });

  test('macOS: kernel memory level and pressure, dynamic swap, the data and overflow volumes', async () => {
    Object.assign(v._deps, {
      platform: () => 'darwin', now: () => 5_000_000, host: () => 'mac-a', loadavg: () => [17.8, 20.35, 15.05], cpus: () => cpus(3000),
      registry: async () => [], read: async () => { throw new Error('no /proc on macOS'); },
      run: async (file, argv) => {
        if (file === 'sysctl') return { code: 0, stdout: fx('darwin-sysctl.txt'), stderr: '' };
        if (file === 'vm_stat') return { code: 0, stdout: fx('darwin-vm_stat.txt'), stderr: '' };
        if (file === 'mount') return { code: 0, stdout: fx('darwin-mount.txt'), stderr: '' };
        if (file === 'ps') return { code: 0, stdout: fx('ps-darwin.txt'), stderr: '' };
        if (file === 'df' && argv.includes('/Volumes/share')) return { code: 0, stdout: fx('darwin-df-smb.txt'), stderr: '' };
        if (file === 'df') return { code: 0, stdout: fx('darwin-df.txt'), stderr: '' };
        throw new Error(`unexpected ${file}`);
      },
    });
    const s = await v.sample();
    assert.equal(s.os, 'darwin');
    // free + inactive + speculative + purgeable pages (220381 x 16 KB); the kernel's broader 41% is reported beside it.
    assert.deepEqual([s.mem.totalMB, s.mem.availableMB, s.mem.availablePct, s.mem.kernelFreePct, s.mem.pressure], [16384, 3443, 21, 41, { kind: 'kernel', level: 'warn' }]);
    assert.deepEqual([s.swap.usedMB, s.swap.dynamic, s.swap.pageKB], [6196, true, 16]);
    assert.deepEqual(s.disks.map((d) => [d.mount, d.usedPct]), [['/System/Volumes/Data', 89], ['/Volumes/Archive Disk', 96], ['/Volumes/Scratch', 94], ['/Volumes/share', 20]]);
    assert.equal(s.cpu.perCore, 4.45);
    const checks = v.evaluate(s, v.mergeThresholds(v.DEFAULT_THRESHOLDS, { loadPerCore: { warn: 4, crit: 5 }, load: { crit: 50 }, swapUsedGB: { warn: 10, crit: 16 } }));
    // vm_stat fails: memory is unreadable (never the kernel's broader estimate), pressure is still graded.
    const realRun = v._deps.run;
    v._deps.run = async (file, argv) => (file === 'vm_stat' ? { code: null, stdout: '', stderr: '', timedOut: true } : realRun(file, argv));
    v._resetRates();
    const s2 = await v.sample();
    assert.deepEqual([s2.mem.availableMB, s2.mem.availablePct], [null, null]);
    assert.ok(s2.errors.includes('vm_stat unreadable'));
    const c2 = v.evaluate(s2).map((c) => c.key);
    assert.ok(!c2.includes('mem') && c2.includes('pressure'), c2.join());
    const lv = Object.fromEntries(checks.map((c) => [c.key, c.level]));
    assert.deepEqual([lv.load, lv.pressure, lv.swap, lv['disk:/System/Volumes/Data'], lv['disk:/Volumes/Archive Disk']], ['warn', 'warn', 'ok', 'warn', 'crit']);
  });
});

describe('evaluate', () => {
  const base = {
    cpu: { cores: 8, load1: 13, perCore: 1.63, busyPct: 99 },
    mem: { totalMB: 16000, availableMB: 2400, availablePct: 15, pressure: { kind: 'psi', some60: 30 } },
    swap: { totalMB: 16000, usedMB: 15400, usedPct: 96, ioPerSec: 2000 },
    disks: [{ mount: '/', usedPct: 94, availGB: 9 }, { mount: '/srv', usedPct: 50, availGB: 400 }, { mount: '/tmpdisk', usedPct: 99, availGB: 1 }],
    agents: [{ engine: 'claude', pid: 9, sessionId: 's9', name: 'big', tmux: 'w:@1.%1', rssMB: 13 * 1024, procs: 40 }],
  };
  test('one check per metric with level, text and the limit crossed; ok ones kept so a level can clear', () => {
    const c = Object.fromEntries(v.evaluate(base).map((x) => [x.key, x]));
    assert.equal(c.load.level, 'warn'); assert.equal(c.load.limitText, '1.5 per core');
    assert.equal(c.cpu.level, 'ok', 'CPU busy alone is off by default');
    assert.equal(c.mem.level, 'ok');
    assert.equal(c.pressure.level, 'warn'); assert.match(c.pressure.text, /30% of the last minute/);
    assert.equal(c.swap.level, 'crit'); assert.equal(c.swapio.level, 'crit');
    assert.equal(c['disk:/'].level, 'warn'); assert.equal(c['disk:/srv'].level, 'ok'); assert.equal(c['disk:/tmpdisk'].level, 'crit');
    assert.equal(c['agent:claude:s9'].level, 'crit'); assert.equal(c['agent:claude:s9'].tmux, 'w:@1.%1'); assert.match(c['agent:claude:s9'].text, /claude session big uses 13 GB \(40 processes\)/);
    assert.equal(v.worstLevel(Object.values(c)), 'crit');
  });
  test('a host floor in GB, per-volume overrides, ignored mounts', () => {
    const th = v.mergeThresholds(v.DEFAULT_THRESHOLDS, { memAvailableGB: { warn: 4, crit: 3 }, volumes: { '/': { diskUsedPct: { warn: 80, crit: 90 } }, '/srv': { diskFreeGB: { warn: 500, crit: null } } }, ignore: ['/tmpdisk'] });
    const c = Object.fromEntries(v.evaluate(base, th).map((x) => [x.key, x]));
    assert.equal(c.mem.level, 'crit'); assert.equal(c.mem.limitText, '3 GB available');
    assert.equal(c['disk:/'].level, 'crit');
    assert.equal(c['disk:/srv'].level, 'warn'); assert.equal(c['disk:/srv'].limitText, '500 GB free');
    assert.equal(c['disk:/tmpdisk'], undefined);
  });
  test('macOS: swap share is not graded (it grows on demand), its size is; kernel pressure maps warn and critical', () => {
    const mac = { mem: { totalMB: 16384, availableMB: 9000, availablePct: 55, pressure: { kind: 'kernel', level: 'critical' } }, swap: { totalMB: 7168, usedMB: 6800, usedPct: 95, dynamic: true } };
    const c = Object.fromEntries(v.evaluate(mac).map((x) => [x.key, x]));
    assert.equal(c.swap.level, 'ok');
    assert.equal(c.pressure.level, 'crit');
    const c2 = Object.fromEntries(v.evaluate(mac, v.mergeThresholds(v.DEFAULT_THRESHOLDS, { swapUsedGB: { warn: 6 }, pressure: { crit: null } })).map((x) => [x.key, x]));
    assert.equal(c2.swap.level, 'warn');
    assert.equal(c2.pressure.level, 'warn', 'crit turned off: critical pressure still warns');
  });
  test('mergeThresholds is deep and copies: the defaults never change', () => {
    const m = v.mergeThresholds(v.DEFAULT_THRESHOLDS, { loadPerCore: { warn: 9 } });
    assert.deepEqual(m.loadPerCore, { warn: 9, crit: 3 });
    m.diskUsedPct.warn = 1;
    assert.equal(v.DEFAULT_THRESHOLDS.diskUsedPct.warn, 88);
  });
});

describe('Monitor.step', () => {
  const chk = (key, level, extra = {}) => ({ key, level, text: `${key} is ${level}`, value: 1, limit: level === 'ok' ? null : 9, ...(level === 'ok' ? {} : { limitText: '9%' }), ...extra });
  const T = 1_800_000_000_000;

  test('a level must hold for sustain samples; then one alert, and nothing more while it holds', () => {
    const m = new v.Monitor({ host: 'box-a' });
    assert.deepEqual(m.step([chk('mem', 'warn')], { sustain: 3 }, T), []);
    assert.deepEqual(m.step([chk('mem', 'warn')], { sustain: 3 }, T + 60e3), []);
    const [a] = m.step([chk('mem', 'warn')], { sustain: 3 }, T + 120e3);
    assert.equal(a.category, 'resource'); assert.equal(a.kind, 'warn'); assert.equal(a.source, 'vitals');
    assert.equal(a.title, 'box-a: mem is warn'); assert.equal(a.body, 'warning (limit 9%)');
    assert.equal(m.step([chk('mem', 'warn')], { sustain: 3 }, T + 180e3).length, 0);
    assert.deepEqual(m.raised().map((r) => [r.key, r.level]), [['mem', 'warn']]);
  });
  test('a spike that does not hold raises nothing', () => {
    const m = new v.Monitor({ host: 'box-a' });
    m.step([chk('load', 'crit')], { sustain: 3 }, T); m.step([chk('load', 'crit')], { sustain: 3 }, T + 1);
    assert.deepEqual(m.step([chk('load', 'ok')], { sustain: 3 }, T + 2), []);
    assert.deepEqual(m.step([chk('load', 'crit')], { sustain: 3 }, T + 3), [], 'the count restarts');
  });
  test('rising raises again; easing is quiet; crit back to ok says so', () => {
    const m = new v.Monitor({ host: 'h' });
    const run = (level, n, t0) => { let out = []; for (let i = 0; i < n; i++) out = out.concat(m.step([chk('disk:/', level)], { sustain: 2 }, t0 + i)); return out; };
    assert.deepEqual(run('warn', 2, T).map((a) => a.kind), ['warn']);
    assert.deepEqual(run('crit', 2, T + 10).map((a) => a.kind), ['crit']);
    assert.deepEqual(run('warn', 2, T + 20), [], 'crit to warn is quiet');
    assert.deepEqual(run('crit', 2, T + 30).map((a) => a.kind), ['crit']);
    const cleared = run('ok', 2, T + 40);
    assert.deepEqual(cleared.map((a) => [a.kind, a.title, a.body]), [['cleared', 'h: disk:/ is ok, back to normal', 'it had been critical']]);
    assert.deepEqual(run('warn', 2, T + 50).map((a) => a.kind), ['warn']);
    assert.deepEqual(run('ok', 2, T + 60), [], 'warn to ok is quiet');
  });
  test('a critical level that lasts is said again every renotifyHours, with its key changing so the notifier does not drop it', () => {
    const m = new v.Monitor({ host: 'h' });
    const [first] = m.step([chk('swap', 'crit')], { sustain: 1, renotifyHours: 6 }, T);
    assert.equal(m.step([chk('swap', 'crit')], { sustain: 1, renotifyHours: 6 }, T + 5 * 3600e3).length, 0);
    const [again] = m.step([chk('swap', 'crit')], { sustain: 1, renotifyHours: 6 }, T + 6 * 3600e3);
    assert.match(again.body, /^still critical since /);
    assert.notEqual(again.key, first.key);
  });
  test('an agent that exits is forgotten quietly; a volume missing from one sample keeps its level', () => {
    const m = new v.Monitor({ host: 'h' });
    m.step([chk('agent:claude:s1', 'crit', { sessionId: 's1', tmux: 'w:@2.%5' }), chk('disk:/data', 'crit')], { sustain: 1 }, T);
    assert.deepEqual(m.step([], { sustain: 1 }, T + 1), []);
    assert.deepEqual(m.raised().map((r) => r.key), ['disk:/data']);
  });
  test('an agent alert names its session and window, so a client can jump to it', () => {
    const m = new v.Monitor({ host: 'h' });
    const [a] = m.step([chk('agent:claude:s1', 'warn', { sessionId: 's1', tmux: 'w:@2.%5' })], { sustain: 1 }, T);
    assert.equal(a.sessionId, 's1'); assert.equal(a.target, 'w:@2');
  });
  test('state survives a restart (toJSON and back): a level raised before is not raised again', () => {
    const m = new v.Monitor({ host: 'h' });
    m.step([chk('mem', 'crit')], { sustain: 1 }, T);
    const m2 = new v.Monitor({ host: 'h', state: JSON.parse(JSON.stringify(m.toJSON())) });
    assert.deepEqual(m2.step([chk('mem', 'crit')], { sustain: 1, renotifyHours: 6 }, T + 60e3), []);
  });
});

