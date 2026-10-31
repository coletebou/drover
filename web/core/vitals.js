// Host vitals: what a machine has left (load, CPU, memory, swap, every real volume) and what each Claude Code and
// Codex session on it costs (its whole process tree: MCP servers, language servers and the builds it runs), on Linux
// and macOS with no dependencies. The parsers are pure and take command output, so test/vitals.test.js runs them on
// fixtures from both systems; sample() runs the commands. evaluate() grades a sample against thresholds (the defaults
// below, overridden per host by the fleet catalog: core/placement.js). Monitor watches the daemon's own machine: a
// level must hold for `sustain` samples before it is raised or cleared, so a spike is not news. Its alerts
// (category `resource`) go through the notifier's ring, not the truth file, and front daemons pull them with
// notify.recent like every other alert. A sample never carries a command line: argv can hold a whole prompt.
import { readFile, writeFile, mkdir, rename, appendFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCapped } from './proc.js';
import { stateDir } from './paths.js';
import { envvar } from './envvars.js';
import { listRegistry } from './claude.js';

const KB_PER_GB = 1024 * 1024;
const round = (n, d = 1) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null);
const lines = (t) => String(t ?? '').split('\n');

// ------------------------------------------------------------------ Linux parsers
/** /proc/meminfo (kB) -> MB. MemAvailable is the kernel's own estimate of what can be had without swapping. */
export function parseMeminfo(text) {
  const kb = {};
  for (const l of lines(text)) { const m = l.match(/^(\w+):\s+(\d+)/); if (m) kb[m[1]] = Number(m[2]); }
  if (!kb.MemTotal) return null;
  const avail = kb.MemAvailable ?? (kb.MemFree ?? 0) + (kb.Cached ?? 0) + (kb.Buffers ?? 0);
  return { totalMB: kb.MemTotal / 1024, availableMB: avail / 1024, swapTotalMB: (kb.SwapTotal ?? 0) / 1024, swapUsedMB: Math.max(0, (kb.SwapTotal ?? 0) - (kb.SwapFree ?? 0)) / 1024 };
}

/** /proc/pressure/<resource>: the share of time some (or all) tasks stalled, over 10, 60 and 300 seconds. */
export function parsePsi(text) {
  const out = {};
  for (const l of lines(text)) {
    const m = l.match(/^(some|full)\s+avg10=([\d.]+)\s+avg60=([\d.]+)\s+avg300=([\d.]+)/);
    if (m) out[m[1]] = { avg10: Number(m[2]), avg60: Number(m[3]), avg300: Number(m[4]) };
  }
  return out.some ? out : null;
}

/**
 * /proc/vmstat: pages swapped in and out since boot, { in, out }. The two are apart because they mean different
 * things: a sustained swap-out rate is memory being pushed to disk, while swap-in alone is pages coming back after a
 * squeeze has passed.
 */
export function parseLinuxVmstat(text) {
  const v = {};
  for (const l of lines(text)) { const [k, n] = l.split(/\s+/); if (k === 'pswpin' || k === 'pswpout') v[k] = Number(n); }
  return Number.isFinite(v.pswpin) && Number.isFinite(v.pswpout) ? { in: v.pswpin, out: v.pswpout } : null;
}

const unescapeMount = (s) => s.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
/** /proc/self/mountinfo -> [{ dev, root, mount, fstype, source }]. */
export function parseMountinfo(text) {
  const out = [];
  for (const l of lines(text)) {
    const p = l.trim().split(' ');
    const dash = p.indexOf('-');
    if (dash < 6 || p.length < dash + 3) continue;
    out.push({ dev: p[2], root: unescapeMount(p[3]), mount: unescapeMount(p[4]), fstype: p[dash + 1], source: unescapeMount(p[dash + 2]) });
  }
  return out;
}

const LINUX_LOCAL_FS = new Set(['ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'zfs', 'f2fs', 'jfs', 'bcachefs', 'ntfs', 'ntfs3', 'exfat', 'vfat']);
// Network and FUSE filesystems are measured one per df call, each with its own timeout: a hung remote must not take
// the local volumes' figures with it.
const LINUX_REMOTE_FS = /^(nfs4?|cifs|smb3|9p|drvfs|virtiofs|ceph|glusterfs|fuse\.(rclone|sshfs|s3fs|gcsfuse|juicefs|mergerfs))$/;
const LINUX_SKIP_MOUNT = /^\/(snap|boot|run|proc|sys|dev|var\/lib\/(docker|containers|snapd|kubelet))(\/|$)/;

/** The volumes worth watching on Linux: each filesystem once (its first full mount), no pseudo, snap or container mounts. */
export function pickLinuxVolumes(mounts) {
  const seen = new Set(), out = [];
  for (const m of mounts) {
    const local = LINUX_LOCAL_FS.has(m.fstype), remote = LINUX_REMOTE_FS.test(m.fstype);
    if (!local && !remote) continue;
    if (local && m.root !== '/' && m.fstype !== 'btrfs') continue;   // a bind mount of part of a filesystem (a btrfs subvolume is the filesystem)
    if (LINUX_SKIP_MOUNT.test(m.mount)) continue;
    const id = local ? `dev:${m.dev}` : `${m.fstype}:${m.source}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ mount: m.mount, fstype: m.fstype, kind: local ? 'local' : 'remote' });
  }
  return out;
}

// ------------------------------------------------------------------ macOS parsers
/** `sysctl a b c` lines ("name: value"); a name this kernel lacks is simply missing. */
export function parseSysctl(text) {
  const out = {};
  for (const l of lines(text)) { const i = l.indexOf(': '); if (i > 0) out[l.slice(0, i).trim()] = l.slice(i + 2).trim(); }
  return out;
}

/** vm.swapusage ("total = 7168.00M  used = 6196.12M  free = 971.88M  (encrypted)") -> MB. */
export function parseSwapusage(s) {
  const UNIT = { K: 1 / 1024, M: 1, G: 1024, T: 1024 * 1024 };
  const num = (k) => { const m = String(s ?? '').match(new RegExp(`${k} = ([\\d.]+)([KMGT])`)); return m ? Number(m[1]) * UNIT[m[2]] : null; };
  const total = num('total'), used = num('used');
  return total === null || used === null ? null : { totalMB: total, usedMB: used };
}

/** vm_stat: the page size and every counter, keyed in lower case ("pages free", "swapins", ...). */
export function parseVmStat(text) {
  const t = String(text ?? '');
  const ps = t.match(/page size of (\d+) bytes/);
  const v = { pageSize: ps ? Number(ps[1]) : 4096 };
  for (const l of lines(t)) { const m = l.match(/^"?([^":]+)"?:\s+(\d+)\.?$/); if (m) v[m[1].trim().toLowerCase()] = Number(m[2]); }
  return v;
}

/** macOS `mount` lines: "/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect, root data)". */
export function parseDarwinMount(text) {
  const out = [];
  for (const l of lines(text)) {
    const m = l.match(/^(.+?) on (\/.*) \(([^)]*)\)$/);
    if (!m) continue;
    const opts = m[3].split(',').map((s) => s.trim());
    out.push({ source: m[1], mount: m[2], fstype: opts[0], opts: opts.slice(1) });
  }
  return out;
}

const DARWIN_LOCAL_FS = new Set(['apfs', 'hfs', 'exfat', 'msdos', 'ntfs']);
const DARWIN_REMOTE_FS = /^(smbfs|nfs|afpfs|webdav|macfuse|osxfuse|fuse.*)$/;
/** The volumes worth watching on macOS: the data volume and each writable disk under /Volumes; never the sealed system snapshot, VM, Preboot or cryptex mounts. */
export function pickDarwinVolumes(mounts) {
  const out = [];
  for (const m of mounts) {
    const local = DARWIN_LOCAL_FS.has(m.fstype), remote = DARWIN_REMOTE_FS.test(m.fstype);
    if (!local && !remote) continue;
    if (m.mount !== '/System/Volumes/Data' && !m.mount.startsWith('/Volumes/')) continue;
    if (m.opts.includes('read-only')) continue;   // disk images, installers
    out.push({ mount: m.mount, fstype: m.fstype, kind: local ? 'local' : 'remote' });
  }
  return out;
}

// ------------------------------------------------------------------ both systems
/** POSIX `df -Pk` -> volumes in GB. A filesystem name may hold spaces, so the numbers and the Capacity column anchor the parse. */
export function parseDf(text) {
  const out = [];
  for (const l of lines(text).slice(1)) {
    const m = l.match(/^(.*?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(\/.*)$/);
    if (!m) continue;
    out.push({ fs: m[1], mount: m[6], sizeGB: Number(m[2]) / KB_PER_GB, usedGB: Number(m[3]) / KB_PER_GB, availGB: Number(m[4]) / KB_PER_GB, usedPct: Number(m[5]) });
  }
  return out;
}

/** ps time and etime, [[dd-]hh:]mm:ss[.cc], in seconds (Linux and macOS print both shapes). */
export function clockSec(s) {
  const m = String(s ?? '').match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}

export const PS_ARGS = ['-axo', 'pid=,ppid=,rss=,pcpu=,time=,etime=,args='];
// The executable alone (macOS: its path; Linux: its name), read apart from argv so a program name can never carry an argument.
export const PS_COMM = ['-axo', 'pid=,comm='];
/** `ps -axo pid=,comm=` -> Map pid -> executable. */
export function parsePsComm(text) {
  const out = new Map();
  for (const l of lines(text)) { const m = l.match(/^\s*(\d+)\s+(.*\S)\s*$/); if (m) out.set(Number(m[1]), m[2]); }
  return out;
}
/** `ps -axo pid=,ppid=,rss=,pcpu=,time=,etime=,args=` -> processes. args never leave this module. */
export function parsePs(text) {
  const out = [];
  for (const l of lines(text)) {
    const m = l.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), rssKB: Number(m[3]), pcpu: Number(m[4]), cpuSec: clockSec(m[5]), etimeSec: clockSec(m[6]), args: m[7] });
  }
  return out;
}

const base = (p) => String(p ?? '').split('/').pop();
/** The agent a command line starts, if any: Claude Code (its binary, or the npm build under node), or Codex (its node wrapper or native binary). */
export function agentEngine(args) {
  const [a0 = '', a1 = ''] = String(args ?? '').trim().split(/\s+/);
  const b0 = base(a0);
  if (b0 === 'claude' || /\/claude\/versions\/[\d.]+$/.test(a0)) return 'claude';
  if (b0 === 'codex') return 'codex';
  if (b0 === 'node' || b0 === 'bun') {
    if (/claude-code\/cli\.js$/.test(a1)) return 'claude';
    if (/(^|\/)codex(\.js)?$/.test(a1)) return 'codex';
  }
  return null;
}

/**
 * A short program name for a process from its executable alone (ps comm: the path on macOS, the name on Linux), never
 * its arguments: the app of a macOS bundle, else the file name, and only in a plain-name alphabet ("process" otherwise).
 */
export function programName(comm) {
  const s = String(comm ?? '').trim();
  const app = s.match(/([^/]+)\.app\/Contents\/MacOS\/[^/]+$/);
  const name = (app ? app[1] : base(s)).slice(0, 40);
  return name && /^[\w .()+-]+$/.test(name) ? name : 'process';
}

/**
 * Each agent with its whole process tree, and the biggest processes outside any agent. An agent started inside
 * another (codex from a Claude Bash call) is an entry of its own and is not counted twice. registry maps a Claude
 * pid to its session (name, id, tmux pane, cwd). prev ({ cpu: Map pid -> cpuSec, ts }) turns CPU time into a
 * percentage over the interval; without it, cpuPct is null (Linux ps %cpu is a lifetime average, not the present).
 */
export function agentTrees(procs, { registry = new Map(), prev = null, ts = Date.now(), topN = 5 } = {}) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const kids = Map.groupBy(procs.filter((p) => p.ppid !== p.pid), (p) => p.ppid);
  const engineOf = (p) => (registry.has(p.pid) ? 'claude' : agentEngine(p.args));
  // A process is its own agent unless its parent runs the same engine (the Codex native binary under its node wrapper).
  const roots = procs.filter((p) => { const e = engineOf(p); if (!e) return false; if (registry.has(p.pid)) return true; const up = byPid.get(p.ppid); return !(up && engineOf(up) === e); });
  const rootPids = new Set(roots.map((r) => r.pid));
  const dt = prev?.ts ? (ts - prev.ts) / 1000 : 0;
  const cpuOf = (p) => {
    if (!(dt > 0) || p.cpuSec === null) return null;
    const was = prev.cpu.get(p.pid);
    if (was !== undefined && p.cpuSec >= was) return p.cpuSec - was;
    return p.etimeSec !== null && p.etimeSec <= dt + 1 ? p.cpuSec : 0;   // started inside the interval: all of its time is new
  };
  const inTree = new Set();
  const agents = roots.map((r) => {
    let rssKB = 0, cpu = 0, cpuKnown = dt > 0, n = 0;
    const stack = [r], seen = new Set();
    while (stack.length) {
      const p = stack.pop();
      if (seen.has(p.pid)) continue;
      seen.add(p.pid); inTree.add(p.pid);
      n++; rssKB += p.rssKB;
      const c = cpuOf(p); if (c === null) cpuKnown = false; else cpu += c;
      for (const k of kids.get(p.pid) ?? []) if (!rootPids.has(k.pid)) stack.push(k);
    }
    const reg = registry.get(r.pid), engine = engineOf(r);
    const role = engine === 'codex' ? (/\bapp-server\b/.test(r.args) ? 'app-server' : /\bexec\b/.test(r.args) ? 'exec' : null) : (/\bdaemon\b/.test(r.args) && !reg ? 'daemon' : null);
    return {
      engine, pid: r.pid, procs: n, rssMB: round(rssKB / 1024, 0), cpuPct: cpuKnown ? round((cpu / dt) * 100, 0) : null, etimeSec: r.etimeSec,
      ...(reg ? { sessionId: reg.sessionId ?? null, name: reg.name ?? null, tmux: reg.tmux ?? null, cwd: reg.cwd ?? null, status: reg.status ?? null } : {}),
      ...(role ? { role } : {}),
    };
  }).sort((a, b) => b.rssMB - a.rssMB);
  const top = procs.filter((p) => !inTree.has(p.pid)).sort((a, b) => b.rssKB - a.rssKB).slice(0, topN)
    .map((p) => ({ pid: p.pid, program: programName(p.comm), rssMB: round(p.rssKB / 1024, 0) }));
  return { agents, top, cpu: new Map(procs.map((p) => [p.pid, p.cpuSec])) };
}

/** CPU busy share between two os.cpus() readings (all cores), or null. */
export function cpuBusyPct(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let busy = 0, total = 0;
  for (let i = 0; i < a.length; i++) {
    const t0 = a[i].times, t1 = b[i].times;
    const d = (k) => Math.max(0, t1[k] - t0[k]);
    const all = d('user') + d('nice') + d('sys') + d('idle') + d('irq');
    total += all; busy += all - d('idle');
  }
  return total > 0 ? round((busy / total) * 100, 0) : null;
}

// ------------------------------------------------------------------ sampling
/** Seams for tests: the command runner, file reads, the clock, the platform and the Claude registry. */
export const _deps = {
  run: (file, argv, opts) => runCapped(file, argv, { timeoutMs: 8000, maxBytes: 4 << 20, ...opts }),
  read: (f) => readFile(f, 'utf8'),
  now: () => Date.now(),
  platform: () => process.platform,
  cpus: () => os.cpus(),
  loadavg: () => os.loadavg(),
  registry: () => listRegistry(),
  host: () => (envvar('HOST') ?? os.hostname()).split('.')[0],
};

// Per process, for rates between samples: CPU readings, swap counters, process CPU times.
const noReadings = () => ({ cpus: null, cpusTs: 0, swapPages: null, swapTs: 0, ps: null });
const last = noReadings();
export function _resetRates() { Object.assign(last, noReadings()); }

const readOr = (f) => _deps.read(f).catch(() => null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function dfVolumes(vols, errors) {
  const local = vols.filter((v) => v.kind === 'local').map((v) => v.mount), remote = vols.filter((v) => v.kind !== 'local');
  const volumesOf = (run, timedOutOn, failedAs) => run.then((r) => (r.timedOut ? (errors.push(`df timed out on ${timedOutOn}`), []) : parseDf(r.stdout))).catch((e) => (errors.push(`${failedAs}: ${e.message}`), []));
  const runs = [];
  if (local.length) runs.push(volumesOf(_deps.run('df', ['-Pk', ...local]), 'the local volumes', 'df'));
  for (const v of remote) runs.push(volumesOf(_deps.run('df', ['-Pk', v.mount], { timeoutMs: 10_000 }), v.mount, `df ${v.mount}`));
  const byMount = new Map(vols.map((v) => [v.mount, v]));
  return (await Promise.all(runs)).flat().filter((d) => byMount.has(d.mount))
    .map((d) => ({ mount: d.mount, fstype: byMount.get(d.mount).fstype, kind: byMount.get(d.mount).kind, sizeGB: round(d.sizeGB), usedGB: round(d.usedGB), availGB: round(d.availGB), usedPct: d.usedPct }));
}

async function memLinux(errors) {
  const [meminfo, vmstat, psiMem, psiCpu] = await Promise.all(['/proc/meminfo', '/proc/vmstat', '/proc/pressure/memory', '/proc/pressure/cpu'].map(readOr));
  const mi = parseMeminfo(meminfo);
  if (!mi) errors.push('no /proc/meminfo');
  const psi = parsePsi(psiMem), cpuPsi = parsePsi(psiCpu);
  return {
    mem: mi ? { totalMB: round(mi.totalMB, 0), availableMB: round(mi.availableMB, 0), availablePct: round((mi.availableMB / mi.totalMB) * 100, 0), pressure: psi ? { kind: 'psi', some60: psi.some.avg60, full60: psi.full?.avg60 ?? null } : null } : null,
    swap: mi ? { totalMB: round(mi.swapTotalMB, 0), usedMB: round(mi.swapUsedMB, 0), usedPct: mi.swapTotalMB > 0 ? round((mi.swapUsedMB / mi.swapTotalMB) * 100, 0) : 0, pageKB: 4 } : null,
    swapPages: parseLinuxVmstat(vmstat),
    cpuPressure: cpuPsi ? { some60: cpuPsi.some.avg60 } : null,
  };
}

const PRESSURE = { 1: 'normal', 2: 'warn', 4: 'critical' };
async function memDarwin(errors) {
  const [sys, vm] = await Promise.all([
    _deps.run('sysctl', ['hw.memsize', 'kern.memorystatus_level', 'kern.memorystatus_vm_pressure_level', 'vm.swapusage']),
    _deps.run('vm_stat', []),
  ]);
  const s = parseSysctl(sys.stdout), v = parseVmStat(vm.stdout);
  const totalMB = Number(s['hw.memsize']) / (1024 * 1024);
  if (!(totalMB > 0)) errors.push('sysctl hw.memsize unreadable');
  // Available is what can be had without compressing or swapping: free, inactive, speculative and purgeable pages.
  // kern.memorystatus_level (what memory_pressure prints as free) counts a broader pool that can include pages apps
  // still use, so it only ever lowers the figure; the kernel's pressure level stays a separate guard.
  const level = Number(s['kern.memorystatus_level']);
  const pagesMB = (n) => ((n ?? 0) * v.pageSize) / (1024 * 1024);
  const reclaimMB = pagesMB(v['pages free']) + pagesMB(v['pages inactive']) + pagesMB(v['pages speculative']) + pagesMB(v['pages purgeable']);
  const kernelFree = Number.isFinite(level) && level >= 0 && level <= 100 ? level : null;
  // No page counts (vm_stat failed or timed out): memory is unreadable, never the kernel's broader estimate.
  if (!Number.isFinite(v['pages free'])) errors.push('vm_stat unreadable');
  const availableMB = Number.isFinite(v['pages free']) ? (kernelFree === null ? reclaimMB : Math.min(reclaimMB, (totalMB * kernelFree) / 100)) : null;
  const sw = parseSwapusage(s['vm.swapusage']);
  const pl = PRESSURE[Number(s['kern.memorystatus_vm_pressure_level'])] ?? null;
  return {
    mem: totalMB > 0 ? { totalMB: round(totalMB, 0), availableMB: availableMB === null ? null : round(availableMB, 0), availablePct: availableMB === null ? null : round((availableMB / totalMB) * 100, 0), ...(kernelFree === null ? {} : { kernelFreePct: kernelFree }), pressure: pl ? { kind: 'kernel', level: pl } : null, compressedMB: round(pagesMB(v['pages occupied by compressor']), 0) } : null,
    swap: sw ? { totalMB: round(sw.totalMB, 0), usedMB: round(sw.usedMB, 0), usedPct: sw.totalMB > 0 ? round((sw.usedMB / sw.totalMB) * 100, 0) : 0, pageKB: v.pageSize / 1024, dynamic: true } : null,
    swapPages: Number.isFinite(v.swapins) && Number.isFinite(v.swapouts) ? { in: v.swapins, out: v.swapouts } : null,
    cpuPressure: null,
  };
}

/**
 * One reading of this machine. Rates (CPU busy, swap pages per second in and out, per-agent CPU) come from the
 * previous reading in this process when it is recent; otherwise CPU busy is measured over a quarter second and the
 * others are null. ignore lists mount points never to measure (a remote mount another machine already watches).
 */
export async function sample({ ignore = [] } = {}) {
  const skip = new Set(Array.isArray(ignore) ? ignore : []);
  const t0 = _deps.now(), platform = _deps.platform(), errors = [];
  const darwin = platform === 'darwin';
  const cpusA = _deps.cpus();
  const [memPart, vols, ps, registry] = await Promise.all([
    (darwin ? memDarwin(errors) : memLinux(errors)).catch((e) => { errors.push(`memory: ${e.message}`); return { mem: null, swap: null, swapPages: null, cpuPressure: null }; }),
    (darwin ? _deps.run('mount', []).then((r) => pickDarwinVolumes(parseDarwinMount(r.stdout))) : readOr('/proc/self/mountinfo').then((t) => pickLinuxVolumes(parseMountinfo(t))))
      .then((v) => dfVolumes(v.filter((x) => !skip.has(x.mount)), errors)).catch((e) => { errors.push(`volumes: ${e.message}`); return []; }),
    Promise.all([_deps.run('ps', PS_ARGS), _deps.run('ps', PS_COMM).catch(() => ({ stdout: '' }))])
      .then(([r, c]) => { const comm = parsePsComm(c.stdout); return parsePs(r.stdout).map((p) => ({ ...p, comm: comm.get(p.pid) ?? null })); })
      .catch((e) => { errors.push(`ps: ${e.message}`); return []; }),
    _deps.registry().then((list) => new Map(list.filter((r) => r.alive !== false).map((r) => [r.pid, r]))).catch(() => new Map()),
  ]);
  const now = _deps.now();
  const recent = (ts) => now - ts < 600_000;
  // CPU busy over the time since the last reading, or over 250 ms when there is none within ten minutes.
  let busy = null;
  if (last.cpus && recent(last.cpusTs)) busy = cpuBusyPct(last.cpus, cpusA);
  else { await sleep(250); busy = cpuBusyPct(cpusA, _deps.cpus()); }
  last.cpus = cpusA; last.cpusTs = t0;
  // Swap pages per second each way since the last reading; ioPerSec is the two together, as it always was.
  let swapRates = { ioPerSec: null, inPerSec: null, outPerSec: null };
  const sp = memPart.swapPages;
  if (sp && last.swapPages && now > last.swapTs && recent(last.swapTs)) {
    const perSec = (k) => round(Math.max(0, sp[k] - last.swapPages[k]) / ((now - last.swapTs) / 1000), 0);
    const inPerSec = perSec('in'), outPerSec = perSec('out');
    swapRates = { ioPerSec: inPerSec + outPerSec, inPerSec, outPerSec };
  }
  if (sp) { last.swapPages = sp; last.swapTs = now; }
  const prev = last.ps && recent(last.ps.ts) ? last.ps : null;
  const trees = agentTrees(ps, { registry, prev, ts: now });
  if (ps.length) last.ps = { cpu: trees.cpu, ts: now };
  const [l1, l5, l15] = _deps.loadavg();
  const cores = cpusA.length || 1;
  const totals = {};
  for (const a of trees.agents) { const t = (totals[a.engine] ??= { count: 0, rssMB: 0 }); t.count++; t.rssMB += a.rssMB ?? 0; }
  return {
    host: _deps.host(), os: darwin ? 'darwin' : platform, ts: new Date(now).toISOString(), ms: now - t0,
    cpu: { cores, load1: round(l1, 2), load5: round(l5, 2), load15: round(l15, 2), perCore: round(l1 / cores, 2), busyPct: busy, ...(memPart.cpuPressure ? { pressure: memPart.cpuPressure } : {}) },
    mem: memPart.mem, swap: memPart.swap ? { ...memPart.swap, ...swapRates } : null,
    disks: vols, agents: trees.agents, agentTotals: totals, top: trees.top,
    ...(errors.length ? { errors } : {}),
  };
}

// ------------------------------------------------------------------ thresholds
/**
 * Defaults for every host; the fleet catalog overrides them per host (monitor.thresholds) and per volume
 * (monitor.volumes["/mnt/data"]). Each pair is { warn, crit }; null turns a level off. "below" checks (memory, free
 * disk) fire when the value drops to the limit, the others when it reaches it.
 */
export const DEFAULT_THRESHOLDS = Object.freeze({
  loadPerCore: { warn: 1.5, crit: 3 },        // load1 / cores
  load: { warn: null, crit: null },           // absolute load1, for a host with a hard ceiling whatever its cores
  cpuBusyPct: { warn: null, crit: null },     // every core busy is often just a build; off unless a host asks
  memAvailablePct: { warn: 12, crit: 6 },     // below
  memAvailableGB: { warn: null, crit: null }, // below: a production host's floor
  pressure: { warn: 'warn', crit: 'critical' }, // macOS kernel memory pressure
  psiMemSome60: { warn: 25, crit: 50 },       // Linux: share of the last minute some task stalled on memory
  swapUsedPct: { warn: 85, crit: 95 },        // Linux; macOS swap grows on demand, so its share means little there
  swapUsedGB: { warn: null, crit: null },     // macOS: swap files grow into the data volume
  swapOutPerSec: { warn: 300, crit: 1500 },   // pages swapped out per second: memory pushed to disk
  swapIoPerSec: { warn: 300, crit: 1500 },    // pages in plus out per second, graded only while memory is short
  diskUsedPct: { warn: 88, crit: 95 },
  diskFreeGB: { warn: null, crit: null },     // below
  agentRssGB: { warn: 6, crit: 12 },          // one session's process tree
  sustain: 3,                                 // samples a new level must hold before it is raised or cleared
  renotifyHours: 6,                           // a critical level that lasts is said again this often
});

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
/** Deep merge of plain objects (arrays and scalars replace); the result shares nothing with its inputs. */
export function mergeThresholds(baseTh, ...overs) {
  const out = structuredClone(baseTh);
  for (const o of overs) {
    if (!isObj(o)) continue;
    for (const [k, v] of Object.entries(o)) out[k] = isObj(v) && isObj(out[k]) ? mergeThresholds(out[k], v) : structuredClone(v);
  }
  return out;
}

export const LEVELS = ['ok', 'warn', 'crit'];
export const levelRank = (l) => Math.max(0, LEVELS.indexOf(l));
export const PRESSURE_RANK = { normal: 0, warn: 1, critical: 2 };   // macOS kernel memory pressure, mildest first; core/placement.js judges by it too

/** One value against a { warn, crit } pair: dir "above" (bigger is worse) or "below"; unit labels the limit for people. */
export function grade(value, limits, dir = 'above', unit = '') {
  if (!Number.isFinite(value) || !isObj(limits)) return { level: 'ok', limit: null };
  const hit = (lim) => Number.isFinite(lim) && (dir === 'above' ? value >= lim : value <= lim);
  if (hit(limits.crit)) return { level: 'crit', limit: limits.crit, unit };
  if (hit(limits.warn)) return { level: 'warn', limit: limits.warn, unit };
  return { level: 'ok', limit: null };
}
const worst = (...gs) => gs.reduce((a, b) => (levelRank(b.level) > levelRank(a.level) ? b : a), { level: 'ok', limit: null });

/**
 * The mem check's grade. Warn or worse means memory is short: available is at or under
 * memAvailablePct or memAvailableGB. Unreadable memory grades ok here; the caller refuses it itself.
 */
export function memoryGrade(mem, th = DEFAULT_THRESHOLDS) {
  if (!mem || !Number.isFinite(mem.availableMB)) return { level: 'ok', limit: null };
  return worst(grade(mem.availablePct, th.memAvailablePct, 'below', '% available'), grade(mem.availableMB / 1024, th.memAvailableGB, 'below', ' GB available'));
}

/** True while the mem check would be warn or worse. Placement counts combined swap I/O only then. */
export const memoryIsShort = (mem, th = DEFAULT_THRESHOLDS) => memoryGrade(mem, th).level !== 'ok';

const gb = (mb) => round(mb / 1024, 1);
const pct = (n) => `${round(n, 0)}%`;

/**
 * The swap rate check, as [grade, text, value]. Swap-out is graded on its own (swapOutPerSec): memory pushed to disk
 * is the trouble. Pages in plus out (swapIoPerSec) count only while memory is short (memShort: the mem check at warn
 * or worse). Swap-in alone, with memory to spare, is pages coming back after a squeeze: reported, never raised.
 */
function swapRate(inPerSec, outPerSec, memShort, th) {
  const io = inPerSec + outPerSec;
  const out = grade(outPerSec, th.swapOutPerSec, 'above', ' pages/s out');
  const both = memShort ? grade(io, th.swapIoPerSec, 'above', ' pages/s in and out') : { level: 'ok', limit: null };
  if (levelRank(both.level) > levelRank(out.level)) return [both, `swapping ${io} pages/s in and out while memory is short (${inPerSec} in, ${outPerSec} out)`, io];
  const text = outPerSec > 0 ? `swapping out ${outPerSec} pages/s${inPerSec > 0 ? ` (${inPerSec} in)` : ''}` : inPerSec > 0 ? `swap-in ${inPerSec} pages/s` : 'no swapping';
  return [out, out.level === 'ok' && !memShort && inPerSec > 0 ? `${text}, no shortage` : text, outPerSec];
}

/**
 * Grade a sample: one check per metric (key, level, text, value, limit, limitText), ok ones included so the monitor
 * can see a level clear. Volumes take monitor.volumes overrides by mount point; monitor.ignore lists mounts to skip.
 */
export function evaluate(v, th = DEFAULT_THRESHOLDS) {
  const checks = [];
  const add = (key, g, text, value, extra = {}) => checks.push({ key, level: g.level, text, value: round(value, 2), limit: g.limit, ...(g.limit !== null && g.limit !== undefined ? { limitText: `${g.limit}${g.unit ?? ''}` } : {}), ...extra });
  if (v?.cpu) {
    const c = v.cpu;
    add('load', worst(grade(c.perCore, th.loadPerCore, 'above', ' per core'), grade(c.load1, th.load)), `load ${c.load1} on ${c.cores} cores (${c.perCore} per core)`, c.load1);
    if (Number.isFinite(c.busyPct)) add('cpu', grade(c.busyPct, th.cpuBusyPct, 'above', '%'), `CPU ${pct(c.busyPct)} busy`, c.busyPct);
  }
  let memShort = false;
  if (v?.mem) {
    const m = v.mem;
    if (Number.isFinite(m.availableMB)) {
      const g = memoryGrade(m, th);
      memShort = g.level !== 'ok';
      add('mem', g, `memory ${gb(m.availableMB)} GB available of ${gb(m.totalMB)} (${pct(m.availablePct)})`, m.availableMB / 1024);
    }
    if (m.pressure?.kind === 'kernel') {
      const r = PRESSURE_RANK[m.pressure.level] ?? 0;
      const lv = ['crit', 'warn'].find((l) => th.pressure?.[l] && r >= (PRESSURE_RANK[th.pressure[l]] ?? 9)) ?? 'ok';
      add('pressure', { level: lv, limit: lv === 'ok' ? null : th.pressure[lv], unit: '' }, `memory pressure ${m.pressure.level}`, r);
    } else if (m.pressure?.kind === 'psi') add('pressure', grade(m.pressure.some60, th.psiMemSome60, 'above', '%'), `memory stalls ${pct(m.pressure.some60)} of the last minute`, m.pressure.some60);
  }
  if (v?.swap) {
    const s = v.swap;
    const bySize = grade(s.usedMB / 1024, th.swapUsedGB, 'above', ' GB');
    if (s.dynamic) add('swap', bySize, `swap ${gb(s.usedMB)} GB used`, s.usedMB / 1024);   // macOS swap grows on demand: only its size counts
    else add('swap', worst(grade(s.usedPct, th.swapUsedPct, 'above', '%'), bySize), `swap ${gb(s.usedMB)} of ${gb(s.totalMB)} GB used (${pct(s.usedPct)})`, s.usedPct);
    if (Number.isFinite(s.inPerSec) && Number.isFinite(s.outPerSec)) add('swapio', ...swapRate(s.inPerSec, s.outPerSec, memShort, th));
  }
  const ignore = Array.isArray(th.ignore) ? th.ignore : [];
  for (const d of v?.disks ?? []) {
    if (ignore.includes(d.mount)) continue;
    const vt = mergeThresholds({ diskUsedPct: th.diskUsedPct, diskFreeGB: th.diskFreeGB }, th.volumes?.[d.mount]);
    add(`disk:${d.mount}`, worst(grade(d.usedPct, vt.diskUsedPct, 'above', '% full'), grade(d.availGB, vt.diskFreeGB, 'below', ' GB free')), `disk ${d.mount} ${pct(d.usedPct)} full (${round(d.availGB, 0)} GB free)`, d.usedPct, { mount: d.mount });
  }
  for (const a of v?.agents ?? []) {
    const label = a.name ? `${a.engine} session ${a.name}` : `${a.engine}${a.role ? ` ${a.role}` : ''} pid ${a.pid}`;
    add(`agent:${a.engine}:${a.sessionId ?? a.pid}`, grade((a.rssMB ?? 0) / 1024, th.agentRssGB, 'above', ' GB'), `${label} uses ${gb(a.rssMB ?? 0)} GB (${a.procs} processes)`, (a.rssMB ?? 0) / 1024,
      { ...(a.sessionId ? { sessionId: a.sessionId } : {}), ...(a.tmux ? { tmux: a.tmux } : {}) });
  }
  return checks;
}

/** The worst level among checks. */
export const worstLevel = (checks = []) => checks.reduce((w, c) => (levelRank(c.level) > levelRank(w) ? c.level : w), 'ok');

// ------------------------------------------------------------------ the monitor
const windowOfPane = (t) => (t ? String(t).replace(/\.%\d+$/, '') : null);

/**
 * Watches one machine. step() is the pure state machine (test/vitals.test.js): per check key it holds the raised
 * level, a pending level with its count, when the level was raised and when it was last said. A level must hold for
 * `sustain` samples to be raised or cleared; rising raises an alert, a critical level clearing to ok says so, easing
 * (crit to warn, warn to ok) is quiet, and a critical level is said again every renotifyHours while it lasts. A check
 * that disappears (an agent exited) is forgotten quietly; a volume that is missing from one sample keeps its state.
 */
export class Monitor {
  constructor({ host, state = {} } = {}) {
    this.host = host;
    this.state = new Map(Object.entries(state));
  }

  step(checks, { sustain = DEFAULT_THRESHOLDS.sustain, renotifyHours = DEFAULT_THRESHOLDS.renotifyHours } = {}, now = Date.now()) {
    const out = [], seen = new Set();
    const need = Math.max(1, Math.floor(Number(sustain)) || 1);
    for (const c of checks) {
      seen.add(c.key);
      const s = this.state.get(c.key) ?? { level: 'ok', pending: null, since: now, lastAlertAt: 0 };
      s.text = c.text;
      if (c.level === s.level) {
        s.pending = null;
        if (s.level === 'crit' && renotifyHours > 0 && now - s.lastAlertAt >= renotifyHours * 3600_000) { out.push(this.#alert(c, 'still', s, now)); s.lastAlertAt = now; }
      } else {
        s.pending = s.pending?.level === c.level ? { level: c.level, count: s.pending.count + 1 } : { level: c.level, count: 1 };
        if (s.pending.count >= need) {
          const from = s.level;
          s.level = c.level; s.pending = null; s.since = now;
          if (levelRank(c.level) > levelRank(from)) { out.push(this.#alert(c, 'raised', s, now)); s.lastAlertAt = now; }
          else if (from === 'crit' && c.level === 'ok') out.push(this.#alert(c, 'cleared', s, now));
        }
      }
      this.state.set(c.key, s);
    }
    for (const k of [...this.state.keys()]) if (!seen.has(k) && k.startsWith('agent:')) this.state.delete(k);
    return out;
  }

  /** The alert for check c; why is 'raised' (to c.level), 'still' (a lasting critical level) or 'cleared'. */
  #alert(c, why, s, now) {
    const cleared = why === 'cleared', still = why === 'still';
    const kind = cleared ? 'cleared' : c.level;
    const lim = c.limitText ? ` (limit ${c.limitText})` : '';
    return {
      category: 'resource', kind, source: 'vitals', host: this.host, name: this.host,
      sessionId: c.sessionId ?? null, target: windowOfPane(c.tmux),
      title: cleared ? `${this.host}: ${c.text}, back to normal` : `${this.host}: ${c.text}`,
      body: cleared ? 'it had been critical' : still ? `still critical since ${new Date(s.since).toISOString().slice(0, 16)}Z${lim}` : `${c.level === 'crit' ? 'critical' : 'warning'}${lim}`,
      key: `${this.host}|vitals|${c.key}|${kind}|${Math.floor(now / 3_600_000)}`,
      meta: { check: c.key, level: c.level, value: c.value, limit: c.limit },
    };
  }

  /** Raised levels (not ok), for host.vitals and the persisted state. */
  raised() { return [...this.state.entries()].filter(([, s]) => s.level !== 'ok').map(([key, s]) => ({ key, level: s.level, since: new Date(s.since).toISOString(), text: s.text ?? null })); }
  toJSON() { return Object.fromEntries([...this.state.entries()].map(([k, s]) => [k, { level: s.level, pending: s.pending, since: s.since, lastAlertAt: s.lastAlertAt, text: s.text ?? null }])); }
}

// ------------------------------------------------------------------ the daemon's loop and its files
export const files = () => {
  const d = stateDir();
  return { latest: path.join(d, 'vitals.json'), state: path.join(d, 'vitals-state.json'), history: path.join(d, 'vitals-history.jsonl'), alerts: path.join(d, 'vitals-alerts.jsonl') };
};
const HISTORY_MAX_BYTES = 2 << 20;

async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file + '.tmp', JSON.stringify(value), { mode: 0o600 });
  await rename(file + '.tmp', file);
}

/** Append a line, keeping the newest half when the file passes its cap. */
async function appendCapped(file, line, maxBytes = HISTORY_MAX_BYTES) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await appendFile(file, line + '\n', { mode: 0o600 });
  const st = await stat(file).catch(() => null);
  if (st && st.size > maxBytes) {
    const all = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
    await writeFile(file + '.tmp', all.slice(Math.floor(all.length / 2)).join('\n') + '\n', { mode: 0o600 });
    await rename(file + '.tmp', file);
  }
}

/** One compact line per sample for the history file: the numbers a trend needs. */
export function historyLine(v) {
  const disks = Object.fromEntries((v.disks ?? []).map((d) => [d.mount, d.usedPct]));
  return { ts: v.ts, load1: v.cpu?.load1 ?? null, busy: v.cpu?.busyPct ?? null, memAvailPct: v.mem?.availablePct ?? null, memAvailMB: v.mem?.availableMB ?? null, pressure: v.mem?.pressure?.level ?? v.mem?.pressure?.some60 ?? null, swapMB: v.swap?.usedMB ?? null, swapIo: v.swap?.ioPerSec ?? null, swapIn: v.swap?.inPerSec ?? null, swapOut: v.swap?.outPerSec ?? null, disks, agents: v.agents?.length ?? 0, agentMB: (v.agents ?? []).reduce((n, a) => n + (a.rssMB ?? 0), 0) };
}

let current = null;   // the daemon's monitor: { monitor, latest, enabled, thresholds }

/** The newest sample this machine's daemon took (in memory in the daemon, else from its file), if younger than maxAgeMs. */
export async function latest({ maxAgeMs = 150_000 } = {}) {
  const fresh = (v) => v && Number.isFinite(Date.parse(v.ts)) && _deps.now() - Date.parse(v.ts) <= maxAgeMs;
  if (current?.latest && fresh(current.latest)) return { ...current.latest, cached: true };
  try { const v = JSON.parse(await readFile(files().latest, 'utf8')); if (fresh(v)) return { ...v, cached: true }; } catch { /* no daemon sample */ }
  return null;
}

/** What DROVER_VITALS decides: true (on), false (off), or null when it is unset or says neither (the fleet catalog decides). */
export function vitalsSwitch() {
  const env = String(envvar('VITALS') ?? '');
  return /^(on|1|true|yes)$/i.test(env) ? true : /^(off|0|false|no)$/i.test(env) ? false : null;
}

/**
 * Start watching this machine (the daemon calls this once). policy() answers { enabled, thresholds } from the fleet
 * catalog each tick, so a catalog edit applies without a restart; DROVER_VITALS=off stops it outright and
 * DROVER_VITALS_SECONDS sets the interval (default 60). emit(list) raises alerts. Returns a stop function. Never throws:
 * a failed tick is logged on stderr at most once an hour and the next one tries again.
 */
export function startMonitor({ emit, policy = async () => ({ enabled: true, thresholds: DEFAULT_THRESHOLDS }), intervalSec = Number(envvar('VITALS_SECONDS')) || 60 } = {}) {
  if (vitalsSwitch() === false) return () => {};
  const f = files();
  let monitor = null, running = false, lastErrorAt = 0, stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const p = await policy();
      if (!p.enabled) { current = { ...(current ?? {}), enabled: false }; return; }
      if (!monitor) {
        let state = {};
        try { state = JSON.parse(await readFile(f.state, 'utf8')).levels ?? {}; } catch { /* first start */ }
        monitor = new Monitor({ host: _deps.host(), state });
      }
      const th = p.thresholds ?? DEFAULT_THRESHOLDS;
      const v = await sample({ ignore: th.ignore });
      v.checks = evaluate(v, th);
      const alerts = monitor.step(v.checks, th, _deps.now());
      v.monitor = { raised: monitor.raised(), intervalSec };
      current = { monitor, latest: v, enabled: true, thresholds: th };
      await writeJsonAtomic(f.latest, v);
      await appendCapped(f.history, JSON.stringify(historyLine(v)));
      if (alerts.length) {
        const stored = await emit(alerts.map((a, i) => ({ ...a, id: `vitals-${a.host}-${_deps.now()}-${i}` }))).catch(() => alerts);
        for (const a of stored ?? []) await appendCapped(f.alerts, JSON.stringify({ ts: a.ts ?? new Date(_deps.now()).toISOString(), title: a.title, body: a.body, kind: a.kind, check: a.meta?.check, muted: a.muted ?? null }));
      }
      await writeJsonAtomic(f.state, { ts: new Date(_deps.now()).toISOString(), levels: monitor.toJSON() });
    } catch (e) {
      if (_deps.now() - lastErrorAt > 3600_000) { lastErrorAt = _deps.now(); process.stderr.write(`drover: vitals tick failed: ${e?.message ?? e}\n`); }
    } finally { running = false; }
  };
  const first = setTimeout(tick, 5_000); first.unref?.();
  const timer = setInterval(tick, Math.max(10, intervalSec) * 1000); timer.unref?.();
  return () => { stopped = true; clearTimeout(first); clearInterval(timer); };
}

/** This process's monitor state, for host.vitals: whether it runs here and what it has raised. */
export function monitorInfo() { return current ? { enabled: current.enabled !== false, raised: current.monitor?.raised() ?? [] } : null; }
