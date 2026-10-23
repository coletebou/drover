// The fleet catalog and placement: which machines a fleet has, which identity each belongs to, what each may run, and
// where the next workload should go. The catalog is DROVER_FLEET_CATALOG (default ~/.config/drover/fleet.json) plus
// every *.json in DROVER_FLEET_DIR (default ~/.config/drover/fleet.d), where tools that start machines drop an entry
// per machine; a later file's entry for a name extends an earlier one. Every host carries an identity, and every
// fleet op takes only the hosts whose identity matches this machine's, so two fleets that share a catalog (a personal
// and a work one) never see, poll or place on each other's machines. judge() and choose() are pure
// (test/placement.test.js); the ops that read hosts live in core/api.js (fleet.vitals, fleet.place).
//
//   { "hosts": [ { "name": "box-a", "identity": "personal", "aliases": ["a"], "ssh": "box-a",
//       "placement": { "classes": ["claude-session", "heavy-build"], "weight": 1, "reserveMemGB": 2, ... },
//       "monitor": { "enabled": true, "thresholds": { ... }, "volumes": { "/data": { ... } }, "ignore": ["/scratch"] } } ],
//     "placement": { "classes": { "claude-session": { "needMemGB": 3.5 } } },
//     "monitor": { "thresholds": { ... } } }
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { envvar } from './envvars.js';
import { DEFAULT_THRESHOLDS, mergeThresholds, PRESSURE_RANK, vitalsSwitch } from './vitals.js';

const HOST_RE = /^[A-Za-z0-9_.-]{1,80}$/;
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const home = () => process.env.HOME ?? os.homedir();
const expandHome = (p) => (typeof p === 'string' && p ? (p.startsWith('~/') ? path.join(home(), p.slice(2)) : p) : null);
const r1 = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : n);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export const catalogFile = () => expandHome(envvar('FLEET_CATALOG')) ?? path.join(home(), '.config', 'drover', 'fleet.json');
export const catalogDir = () => expandHome(envvar('FLEET_DIR')) ?? path.join(home(), '.config', 'drover', 'fleet.d');

async function dirFiles(dir) {
  if (!dir || !existsSync(dir)) return [];
  return (await readdir(dir).catch(() => [])).filter((n) => n.endsWith('.json')).sort().map((n) => path.join(dir, n));
}

/** The merged catalog: { found, file, hosts, classes, thresholds, errors }. A file that does not parse is an error, never fatal. */
export async function loadCatalog({ file = catalogFile(), dir = catalogDir() } = {}) {
  const out = { found: false, file, hosts: [], classes: {}, thresholds: {}, errors: [] };
  const byName = new Map();
  for (const f of [file, ...(await dirFiles(dir))]) {
    if (!f || !existsSync(f)) continue;
    let doc;
    try { doc = JSON.parse(await readFile(f, 'utf8')); } catch (e) { out.errors.push(`${f}: ${e.message}`); if (f === file) out.invalid = true; continue; }
    if (!isObj(doc) || !Array.isArray(doc.hosts)) { out.errors.push(`${f}: expected an object with a hosts list`); if (f === file) out.invalid = true; continue; }
    out.found = true;
    if (isObj(doc.placement?.classes)) for (const [k, c] of Object.entries(doc.placement.classes)) if (isObj(c)) out.classes[k] = { ...(out.classes[k] ?? {}), ...c };
    if (isObj(doc.monitor?.thresholds)) out.thresholds = mergeThresholds(out.thresholds, doc.monitor.thresholds);
    for (const h of doc.hosts) {
      if (!isObj(h) || typeof h.name !== 'string' || !HOST_RE.test(h.name)) { out.errors.push(`${f}: a host without a valid name`); continue; }
      if (h.ssh !== undefined && (typeof h.ssh !== 'string' || !HOST_RE.test(h.ssh))) { out.errors.push(`${f}: ${h.name}: ssh must be an ssh alias`); continue; }
      const k = h.name.toLowerCase(), prev = byName.get(k);
      // Two fleets may share the catalog: an entry never takes over another identity's machine (or its ssh route).
      if (prev && (prev.identity ?? null) !== (h.identity ?? null)) { out.errors.push(`${f}: ${h.name} is already ${prev.identity ? `a ${prev.identity}` : 'an identity-less'} host (${prev.source}); its ${h.identity ? `${h.identity} ` : 'identity-less '}entry is ignored`); continue; }
      byName.set(k, { ...(prev ?? {}), ...h, source: f });
    }
  }
  out.hosts = [...byName.values()];
  return out;
}

/** KEY=VALUE pairs from ~/.df-profile-style files (DF_MACHINE, DF_IDENTITY), when the machine has one. */
async function profile() {
  try {
    const t = await readFile(path.join(home(), '.df-profile'), 'utf8');
    return Object.fromEntries([...t.matchAll(/^(?:export\s+)?(DF_\w+)=["']?([^"'\n]*)["']?\s*$/gm)].map((m) => [m[1], m[2]]));
  } catch { return {}; }
}

/** Every name a catalog host answers to, lower case. */
export const hostNames = (h) => [h.name, h.ssh, ...(Array.isArray(h.aliases) ? h.aliases : [])].filter((s) => typeof s === 'string').map((s) => s.toLowerCase());

/** This machine in the catalog: { entry, identity, names }. identity is the entry's, else DF_IDENTITY, else null. */
export async function whoAmI(catalog, shortName = os.hostname().split('.')[0]) {
  const p = await profile();
  const names = new Set([p.DF_MACHINE, shortName, os.hostname().split('.')[0]].filter(Boolean).map((s) => s.toLowerCase()));
  const byMachine = p.DF_MACHINE ? catalog.hosts.find((h) => hostNames(h).includes(p.DF_MACHINE.toLowerCase())) : null;
  const byHost = byMachine ? null : catalog.hosts.find((h) => hostNames(h).some((n) => names.has(n)) && (!p.DF_IDENTITY || !h.identity || h.identity === p.DF_IDENTITY)) ?? null;
  const entry = byMachine ?? byHost;
  return { entry, identity: entry?.identity ?? (p.DF_IDENTITY || null), names };
}

/**
 * The catalog hosts of one identity. With an identity, a host that names none is left out too: never cross. Without
 * one (this machine is not in the catalog and has no DF_IDENTITY), only a catalog that names no identity at all is
 * readable; one that does fails closed, since this machine could belong to either fleet.
 */
export const scoped = (catalog, identity) => (identity ? catalog.hosts.filter((h) => h.identity === identity) : catalog.hosts.some((h) => h.identity) ? [] : catalog.hosts);

/** Whether a catalog host may be read from a machine of this identity (scoped, for one host). */
export const sameFleet = (catalog, identity, host) => scoped(catalog, identity).includes(host);

/** Thresholds for one catalog host: the defaults, the catalog's, then the host's own (with its volumes and ignore list). */
export function thresholdsFor(catalog, entry) {
  const m = isObj(entry?.monitor) ? entry.monitor : {};
  const th = mergeThresholds(DEFAULT_THRESHOLDS, catalog?.thresholds, m.thresholds);
  if (isObj(m.volumes)) th.volumes = mergeThresholds(isObj(th.volumes) ? th.volumes : {}, m.volumes);
  if (Array.isArray(m.ignore)) th.ignore = m.ignore.filter((s) => typeof s === 'string');
  return th;
}

/**
 * Whether this machine's monitor runs, and with which thresholds. DROVER_VITALS=on or off decides outright; otherwise
 * it runs on a machine with no catalog (nothing says otherwise) and, where there is one, only for a host whose entry
 * says monitor.enabled: true.
 */
export async function monitorPolicy({ shortName } = {}) {
  const cat = await loadCatalog();
  const { entry } = await whoAmI(cat, shortName);
  const enabled = vitalsSwitch() ?? (!cat.found || entry?.monitor?.enabled === true);
  return { enabled, thresholds: thresholdsFor(cat, entry), catalog: cat.found ? cat.file : null, host: entry?.name ?? null };
}

// ------------------------------------------------------------------ placement
/**
 * Workload classes: what one more of each needs. A catalog's placement.classes adds classes or changes these.
 * needMemGB is a session's typical whole tree (a Claude Code session with its MCP servers runs about 3.5 GB).
 */
export const DEFAULT_CLASSES = Object.freeze({
  'claude-session': { needMemGB: 3.5, needCores: 0.5 },
  'codex-session': { needMemGB: 2, needCores: 0.5 },
  'heavy-build': { needMemGB: 6, needCores: 4, minFreeDiskGB: 20 },
  'macos-only': { needMemGB: 2, needCores: 1, os: 'darwin', maxPressure: 'warn' },
});
export function classesOf(catalog) {
  const out = { ...DEFAULT_CLASSES };
  for (const [k, c] of Object.entries(catalog?.classes ?? {})) if (/^[a-z][a-z0-9-]{0,40}$/.test(k)) out[k] = { ...(DEFAULT_CLASSES[k] ?? {}), ...c };
  return out;
}

/**
 * A host's placement policy (catalog host.placement over these): classes it takes (null: every class), weight (a
 * multiplier on its score: below 1 for a production box or a machine to spare), reserveMemGB it must keep available
 * after the new workload, caps on load (per core and absolute), the worst memory pressure (macOS) or stall share
 * (Linux PSI) it may be at, swap caps, and the free space its work volume (diskPath, else the root or data volume) needs.
 */
export const DEFAULT_POLICY = Object.freeze({
  classes: null, weight: 1, reserveMemGB: 2, maxLoadPerCore: 1.5, maxLoad: null, maxPressure: 'normal', maxPsiSome60: 25,
  maxSwapPct: 90, maxSwapGB: null, maxSwapIoPerSec: 500, minFreeDiskGB: 5, diskPath: null,
});

function workDisk(v, mount) {
  const ds = Array.isArray(v?.disks) ? v.disks : [];
  if (mount) return ds.find((d) => d.mount === mount) ?? null;
  // The root (or macOS data) volume only: a network or FUSE mount that happened to answer says nothing about where work goes.
  return ds.find((d) => d.mount === (v.os === 'darwin' ? '/System/Volumes/Data' : '/')) ?? null;
}

/**
 * Whether a host can take one more workload of a class, and how well: { eligible, score, why, facts }. vitals is the
 * host's sample (host.vitals), null when it could not be read. The score is weight x (0.6 memory headroom + 0.4 CPU
 * headroom), each left after the workload and the reserve as a share of the host, scaled down for heavy swap use and
 * for macOS memory pressure at warn. A host that fails any rule scores 0 and says why.
 */
export function judge({ vitals, policy = {}, cls = {}, className = 'claude-session', error = null, pendingMemGB = 0 } = {}) {
  const p = { ...DEFAULT_POLICY, ...(isObj(policy) ? policy : {}) };
  if (!vitals) return { eligible: false, score: 0, why: [`unreachable${error ? `: ${String(error).slice(0, 160)}` : ''}`], facts: {} };
  const why = [];
  if (Array.isArray(p.classes) && !p.classes.includes(className)) why.push(`does not take ${className}`);
  if (cls.os && vitals.os !== cls.os) why.push(`${className} needs ${cls.os === 'darwin' ? 'macOS' : cls.os}`);
  const need = Number(cls.needMemGB) || 0, needCores = Number(cls.needCores) || 0;
  const cores = vitals.cpu?.cores || 1, load = Number(vitals.cpu?.load1) || 0, loadAfter = load + needCores;
  // pendingMemGB: what was placed there in the last few minutes, which its sample may not show yet.
  const pending = Math.max(0, Number(pendingMemGB) || 0);
  const availGB = (vitals.mem?.availableMB ?? 0) / 1024 - pending, totalGB = (vitals.mem?.totalMB ?? 0) / 1024;
  const left = availGB - need;
  if (!vitals.mem || !Number.isFinite(vitals.mem.availableMB)) why.push('memory unreadable');
  else if (left < p.reserveMemGB) why.push(`memory: ${r1(availGB)} GB available${pending ? ` after ${r1(pending)} GB just placed there` : ''}, and ${need} GB for a ${className} would leave ${r1(left)} GB, under its ${p.reserveMemGB} GB reserve`);
  if (Number.isFinite(p.maxLoadPerCore) && loadAfter / cores > p.maxLoadPerCore) why.push(`load ${load} on ${cores} cores is over its cap of ${p.maxLoadPerCore} per core`);
  if (Number.isFinite(p.maxLoad) && loadAfter > p.maxLoad) why.push(`load ${load} is over its cap of ${p.maxLoad}`);
  const pr = vitals.mem?.pressure;
  const maxP = cls.maxPressure ?? p.maxPressure;
  if (pr?.kind === 'kernel' && maxP && (PRESSURE_RANK[pr.level] ?? 0) > (PRESSURE_RANK[maxP] ?? 0)) why.push(`memory pressure ${pr.level}`);
  if (pr?.kind === 'psi' && Number.isFinite(p.maxPsiSome60) && pr.some60 > p.maxPsiSome60) why.push(`memory stalls ${pr.some60}% of the last minute`);
  const sw = vitals.swap;
  if (sw && !sw.dynamic && Number.isFinite(p.maxSwapPct) && sw.usedPct > p.maxSwapPct) why.push(`swap ${sw.usedPct}% used, over its cap of ${p.maxSwapPct}%`);
  if (sw && Number.isFinite(p.maxSwapGB) && sw.usedMB / 1024 > p.maxSwapGB) why.push(`swap ${r1(sw.usedMB / 1024)} GB used, over its cap of ${p.maxSwapGB} GB`);
  if (sw && Number.isFinite(sw.ioPerSec) && Number.isFinite(p.maxSwapIoPerSec) && sw.ioPerSec > p.maxSwapIoPerSec) why.push(`swapping ${sw.ioPerSec} pages/s`);
  const disk = workDisk(vitals, p.diskPath);
  const minDisk = Math.max(Number(p.minFreeDiskGB) || 0, Number(cls.minFreeDiskGB) || 0);
  if (p.diskPath && !disk) why.push(`its work volume ${p.diskPath} was not measured`);
  else if (!disk && minDisk > 0) why.push('its disks were not measured');
  else if (disk && disk.availGB < minDisk) why.push(`disk ${disk.mount} has ${r1(disk.availGB)} GB free, under ${minDisk} GB`);
  const memHead = totalGB > 0 ? clamp((left - p.reserveMemGB) / totalGB, 0, 1) : 0;
  const cpuCap = cores * (Number.isFinite(p.maxLoadPerCore) ? p.maxLoadPerCore : DEFAULT_POLICY.maxLoadPerCore);
  const cpuHead = clamp(1 - loadAfter / cpuCap, 0, 1);
  let factor = 1;
  if (sw && !sw.dynamic && sw.usedPct > 50) factor *= 1 - 0.5 * clamp((sw.usedPct - 50) / 50, 0, 1);
  if (pr?.kind === 'kernel' && pr.level === 'warn') factor *= 0.5;
  const weight = Number.isFinite(Number(p.weight)) ? Number(p.weight) : 1;
  const facts = { availGB: r1(availGB), totalGB: r1(totalGB), load, cores, ...(pr ? { pressure: pr.level ?? pr.some60 } : {}), ...(sw ? { swapPct: sw.usedPct, swapGB: r1(sw.usedMB / 1024) } : {}), ...(disk ? { disk: disk.mount, diskFreeGB: r1(disk.availGB) } : {}) };
  const score = Math.round(weight * (0.6 * memHead + 0.4 * cpuHead) * factor * 1000) / 1000;
  return { eligible: why.length === 0, score: why.length ? 0 : score, why, facts };
}

/**
 * The best eligible candidate ({ name, eligible, score, facts }): the highest score, where prefer (the caller's own
 * machine, so a near tie does not move work for nothing) counts 0.05 more; then less load per core, then name.
 */
export function choose(judged, { prefer = null } = {}) {
  const bonus = (j) => (prefer && j.name === prefer ? 0.05 : 0);
  const perCore = (j) => (Number(j.facts?.load) || 0) / (Number(j.facts?.cores) || 1);
  return judged.filter((j) => j.eligible).sort((a, b) => (b.score + bonus(b)) - (a.score + bonus(a)) || perCore(a) - perCore(b) || String(a.name).localeCompare(String(b.name)))[0] ?? null;
}

/** One line for people: why this host, or why none. */
export function reasonFor(best, judged, className) {
  if (!best) {
    if (!judged.length) return `no host in this fleet takes ${className}`;
    return `no eligible host for ${className}: ${judged.map((j) => `${j.display ?? j.name}: ${j.why.join('; ')}`).join(' | ')}`;
  }
  const f = best.facts;
  const next = judged.filter((j) => j !== best && j.eligible).sort((a, b) => b.score - a.score)[0];
  return `${best.display ?? best.name}: ${f.availGB} GB of ${f.totalGB} GB available, load ${f.load} on ${f.cores} cores${f.diskFreeGB !== undefined ? `, ${f.diskFreeGB} GB free on ${f.disk}` : ''}; score ${best.score}${next ? ` (next ${next.display ?? next.name} ${next.score})` : ' (the only eligible host)'}`;
}
