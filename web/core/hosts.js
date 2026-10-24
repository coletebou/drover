// Fleet host list and read-only probes. Hosts come from fleet-hosts.txt and
// ~/.ssh/config (names only); anything else is refused as a target.
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { envvar } from './envvars.js';
import { tryRun } from './proc.js';
import { DOTFILES } from './events.js';
// Hosts that are not ssh aliases (ephemeral dev environments and the like) belong to a plugin's host provider
// (core/plugins.js hostProvider): it says which names are its own, which exist, and how to reach them.
import * as plugins from './plugins.js';
/** Whether a host name belongs to a plugin's host provider rather than ssh. */
export const isProvidedHost = (name) => Boolean(plugins.hostProvider(name));
// The docker CLI is found as the docker.* ops find it (a launchd or systemd PATH may lack it); same import-cycle rule.
import { findDocker, whyUnavailable } from './docker.js';

const FLEET_FILE = path.join(DOTFILES, 'claude', 'fleet-hosts.txt');
const SSH_CONFIG = path.join(process.env.HOME, '.ssh', 'config');
const HOST_RE = /^[A-Za-z0-9_.-]{1,80}$/;
// ssh-config aliases host.list leaves out with includeSsh (DROVER_SSH_EXCLUDE, a regular expression): jump hosts and
// the like, which are not machines to run agents on.
const SSH_EXCLUDE_DEFAULT = '-ssm$|jump$|^github\\.com$';
const SSH_EXCLUDE = (() => {
  try { return new RegExp(envvar('SSH_EXCLUDE') ?? SSH_EXCLUDE_DEFAULT); }
  catch (e) { process.stderr.write(`drover: DROVER_SSH_EXCLUDE is not a regular expression (${e.message}); using the default\n`); return new RegExp(SSH_EXCLUDE_DEFAULT); }
})();

export const LOCAL = 'local';

export function localShortName() {
  return (envvar('HOST') ?? hostname()).split('.')[0];
}

/**
 * Host aliases (names only) from ~/.ssh/config and the files its Include lines name, as ssh reads them: a relative
 * path is under ~/.ssh and a file name may be a glob. One level deep: a tool that adds machines (an ephemeral cloud
 * box) writes them to an included file, and they are fleet targets like the rest.
 */
export async function sshAliases() {
  const out = new Set(), files = [SSH_CONFIG], seen = new Set();
  for (let i = 0; i < files.length && seen.size < 32; i++) {
    if (seen.has(files[i])) continue;
    seen.add(files[i]);
    let text;
    try { text = await readFile(files[i], 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      const inc = line.match(/^\s*Include\s+(.+)$/i);
      if (inc) { if (i === 0) for (const p of inc[1].trim().split(/\s+/)) files.push(...(await includeFiles(p))); continue; }
      const m = line.match(/^\s*Host\s+(.+)$/i);
      if (!m) continue;
      for (const h of m[1].trim().split(/\s+/)) if (!h.includes('*') && !h.includes('?') && HOST_RE.test(h)) out.add(h);
    }
  }
  return [...out];
}

async function includeFiles(p) {
  const abs = p.startsWith('~/') ? path.join(process.env.HOME, p.slice(2)) : path.isAbsolute(p) ? p : path.join(process.env.HOME, '.ssh', p);
  const name = path.basename(abs), dir = path.dirname(abs);
  if (!/[*?]/.test(name)) return [abs];
  if (/[*?]/.test(dir)) return [];
  const re = new RegExp(`^${name.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  try { return (await readdir(dir)).filter((n) => re.test(n)).sort().map((n) => path.join(dir, n)); } catch { return []; }
}

export async function fleetHosts() {
  if (!existsSync(FLEET_FILE)) return [];
  const text = await readFile(FLEET_FILE, 'utf8');
  return text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && HOST_RE.test(l));
}

/** This machine's fleet alias (DF_MACHINE from ~/.df-profile), so it is not listed as a remote. */
async function selfAliases() {
  const out = new Set([localShortName(), localShortName().toLowerCase()]);
  try { const prof = await readFile(path.join(process.env.HOME, '.df-profile'), 'utf8'); const m = prof.match(/DF_MACHINE=(\S+)/); if (m) out.add(m[1]); } catch { /* no profile */ }
  return out;
}

/**
 * Hosts the UI offers. Default: local + the fleet list (machines that exist).
 * includeSsh adds every other ~/.ssh/config alias (old EC2s, jumps, one-offs);
 * they are allowed as explicit targets but not shown by default.
 */
export async function knownHosts({ includeSsh = false } = {}) {
  const [fleet, ssh, self] = await Promise.all([fleetHosts(), sshAliases(), selfAliases()]);
  const sshSet = new Set(ssh);
  const seen = new Set();
  const out = [{ name: LOCAL, display: localShortName(), source: 'local', inSshConfig: false }];
  for (const h of fleet) { if (seen.has(h) || self.has(h)) continue; seen.add(h); out.push({ name: h, display: h, source: 'fleet', inSshConfig: sshSet.has(h) }); }
  if (includeSsh) for (const h of ssh) { if (seen.has(h) || self.has(h) || SSH_EXCLUDE.test(h)) continue; seen.add(h); out.push({ name: h, display: h, source: 'ssh-config', inSshConfig: true }); }
  return out;
}

export async function assertKnownHost(name) {
  if (name === LOCAL || name === undefined || name === null || name === '') return LOCAL;
  // A provider's host is accepted when its provider knows it (from its own cached list).
  const provider = plugins.hostProvider(name);
  if (provider) {
    if (await provider.known(name)) return name;
    throw new Error(provider.unknownError?.(name) ?? `host ${name} is not known to its provider`);
  }
  if (!HOST_RE.test(name)) throw new Error(`bad host ${JSON.stringify(name)}`);
  const known = await knownHosts({ includeSsh: true });
  if (!known.some((h) => h.name === name)) throw new Error(`host ${name} is not in fleet-hosts.txt or ~/.ssh/config`);
  return name;
}

export function sshArgv(host, remoteArgv, { connectTimeout = 12 } = {}) {
  return ['ssh', '-o', 'BatchMode=yes', '-o', `ConnectTimeout=${connectTimeout}`, '-o', 'StrictHostKeyChecking=accept-new', host, '--', ...remoteArgv];
}

/** Why localFacts lists no containers: no docker CLI (dk is findDocker's answer), docker ps timing out, or what docker ps said. */
function dockerWhy(dk, ps) {
  if (!dk.bin) return dk.reason;
  if (/timed out/.test(ps.stderr)) return 'docker ps did not answer within 8 s (is the daemon wedged?)';
  return whyUnavailable(ps);
}

/**
 * Local read-only facts: uptime, load, disk, docker, identity. docker is the running containers, or null with
 * dockerUnavailable saying why (no CLI, no daemon, no permission); docker.stacks has the full picture.
 */
export async function localFacts() {
  const dk = await findDocker();
  const [up, df, dfn, docker, prof, tmux] = await Promise.all([
    tryRun('uptime', []),
    tryRun('df', ['-h', '/']),
    tryRun('df', ['-h', '/mnt/nvme']),
    dk.bin ? tryRun(dk.bin, ['ps', '--format', '{{.Names}}\t{{.Status}}'], { timeoutMs: 8000 }) : null,
    readFile(path.join(process.env.HOME, '.df-profile'), 'utf8').catch(() => ''),
    tryRun('tmux', ['list-windows', '-a']),
  ]);
  const dfLine = (s) => s.split('\n').filter(Boolean).at(-1)?.split(/\s+/) ?? [];
  const root = dfLine(df.stdout); const nvme = dfn.code === 0 ? dfLine(dfn.stdout) : null;
  const containers = docker?.code === 0 ? docker.stdout.split('\n').filter(Boolean).map((l) => { const [name, status] = l.split('\t'); return { name, status }; }) : null;
  const dockerUnavailable = containers ? null : dockerWhy(dk, docker);
  const identity = Object.fromEntries([...prof.matchAll(/^export (DF_\w+)=(.*)$/gm)].map((m) => [m[1], m[2]]));
  return {
    host: localShortName(), ts: new Date().toISOString(), uptime: up.stdout.trim(),
    disk: { root: root.length ? { size: root[1], used: root[2], avail: root[3], pct: root[4] } : null, nvme: nvme?.length ? { size: nvme[1], used: nvme[2], avail: nvme[3], pct: nvme[4] } : null },
    docker: containers ? { total: containers.length, unhealthy: containers.filter((c) => /unhealthy/i.test(c.status)).length, containers } : null,
    ...(dockerUnavailable ? { dockerUnavailable } : {}),
    tmuxWindows: tmux.code === 0 ? tmux.stdout.split('\n').filter(Boolean).length : 0,
    identity, node: process.version,
  };
}

/** Quick reachability probe via ssh (true/false + latency). */
export async function probe(host, { connectTimeout = 8 } = {}) {
  const t0 = Date.now();
  const r = await tryRun('ssh', sshArgv(host, ['echo', 'ok'], { connectTimeout }).slice(1), { timeoutMs: (connectTimeout + 4) * 1000 });
  return { host, up: r.code === 0 && r.stdout.trim() === 'ok', ms: Date.now() - t0, error: r.code === 0 ? null : r.stderr.trim().split('\n').at(-1)?.slice(0, 200) ?? null };
}

export async function probeAll(hosts, { concurrency = 8 } = {}) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, async () => {
    while (i < hosts.length) { const h = hosts[i++]; out.push(await probe(h)); }
  }));
  return out.sort((a, b) => hosts.indexOf(a.host) - hosts.indexOf(b.host));
}
