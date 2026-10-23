// Docker stacks on a host, read on demand: every compose project (and the containers outside one) with the state of
// each service, counts by kind (rules from the settings), and the code a stack runs: the git state of its working dir
// and of the repos behind its bind mounts, its labels under the configured prefix, and whether its images predate the
// checked-out commit. Plus a few guarded verbs on one project that discovery finds on this host: restart, start, exec
// (an argv), run (a one-off job, compose files on disk), and reading one service's logs. Nothing here takes a stack down
// or changes what it is built from: no down, rm, rmi, prune, kill, stop, build, pull, scale, volume or network change,
// and no user, privileged mode, environment, entrypoint or host path from the caller. docker runs through spawn with an
// argv array (never a shell), a timeout and an output cap; container environments are never read (the inspect template
// leaves Config.Env out).
import { existsSync, statSync } from 'node:fs';
import { access, constants } from 'node:fs/promises';
import { userInfo } from 'node:os';
import path from 'node:path';
import { runCapped, loginShellPath } from './proc.js';
import { envvar } from './envvars.js';
import { localShortName } from './hosts.js';
import { gitEnv } from './git-env.js';
import { redactSecrets, redactArgv } from './native.js';

/** A word for a POSIX shell, single-quoted. */
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export const _deps = {
  run: runCapped,
  env: () => process.env,
  now: () => Date.now(),
  loginPath: () => loginShellPath(),
  host: () => localShortName(),
  exists: (p) => existsSync(p),
  stat: (p) => { try { return statSync(p); } catch { return null; } },
  warn: (line) => { process.stderr.write(`${line}\n`); },
};

/** True when a caller gave a value at all: not undefined, null or ''. */
const given = (v) => v !== undefined && v !== null && v !== '';

// ---------------------------------------------------------------- settings
// Three settings shape what docker.stacks says about a stack. They are environment variables (core/envvars.js, so
// DROVER_<NAME>, usually from ~/.config/drover/*.env), read on every call; a value that cannot be used is ignored with
// one line on stderr, and the default applies.
//
//   DROVER_DOCKER_LABEL_PREFIX  The label namespace read off containers, default "drover". Labels under it
//                               (<prefix>.owner, <prefix>.dev.*, ...) come back in labels, a secret-named one withheld;
//                               <prefix>.commit, the commit a container was brought up for, is checked against the HEAD
//                               of the stack's source. Words of letters, digits, - and _, joined by dots.
//   DROVER_DOCKER_KINDS         Rules that sort a stack's services into kinds by service name, as a JSON array:
//                                 [{"kind":"app","match":"^web-app-","label":"apps"},{"kind":"core","match":"^web-"}]
//                               match is a regular expression tested against the service name; the first rule that
//                               matches wins, and a service no rule matches is "infra". label (optional) is how the
//                               kind is named in summaries (default the kind). Kinds are listed in the order the rules
//                               first name them, then infra. A stack gets counts per kind (kinds) only when a rule
//                               matches one of its services; with no rules (the default) no stack has them.
//   DROVER_DOCKER_BASE          The ref ahead/behind is counted against when the checked-out branch has no upstream
//                               (a detached worktree, a local branch), tried before the remote's default branch
//                               (origin/HEAD), which is the default. A ref a repo does not have is skipped there.
const DEFAULT_PREFIX = 'drover';
const PREFIX_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,30}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9_-]{0,30}[A-Za-z0-9])?){0,3}$/;
const KIND_RE = /^[A-Za-z][A-Za-z0-9_-]{0,23}$/;
const KIND_LABEL_RE = /^[^\x00-\x1f\x7f]{1,24}$/;
const REF_RE = /^(?!.*\.\.)(?!.*[/.]$)[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const MAX_RULES = 32;
/** The kind of a service no rule matches. */
export const OTHER_KIND = 'infra';

/** DROVER_DOCKER_KINDS as rules: { rules: [{ kind, re, label? }], error } (an error means the value is not used at all). */
export function parseKinds(raw) {
  if (!given(raw)) return { rules: [], error: null };
  const no = (why) => ({ rules: [], error: why });
  let list;
  try { list = JSON.parse(raw); } catch (e) { return no(`not JSON: ${e.message}`); }
  if (!Array.isArray(list)) return no('not a JSON array of rules');
  if (list.length > MAX_RULES) return no(`more than ${MAX_RULES} rules`);
  const rules = [];
  for (const [i, r] of list.entries()) {
    const at = `rule ${i + 1}`;
    if (!r || typeof r !== 'object' || Array.isArray(r)) return no(`${at} is not an object`);
    const extra = Object.keys(r).filter((k) => !['kind', 'match', 'label'].includes(k));
    if (extra.length) return no(`${at} has ${extra.join(', ')}; a rule has kind, match and label`);
    if (typeof r.kind !== 'string' || !KIND_RE.test(r.kind)) return no(`${at}: kind must be a word of letters, digits, - and _ that starts with a letter`);
    if (typeof r.match !== 'string' || !r.match || r.match.length > 200) return no(`${at}: match must be a regular expression of 1 to 200 characters`);
    let re;
    try { re = new RegExp(r.match); } catch (e) { return no(`${at}: ${e.message}`); }
    if (r.label !== undefined && (typeof r.label !== 'string' || !KIND_LABEL_RE.test(r.label))) return no(`${at}: label must be 1 to 24 printable characters`);
    rules.push({ kind: r.kind, re, ...(r.label !== undefined ? { label: r.label } : {}) });
  }
  return { rules, error: null };
}

const noted = new Set();
/** One stderr line per setting value that cannot be used. */
function ignored(name, value, why) {
  const k = `${name}\0${value}`;
  if (noted.has(k)) return;
  noted.add(k);
  _deps.warn(`drover: DROVER_${name}=${clip(String(value).replace(/\s+/g, ' '), 120)} is ignored: ${why}`);
}

let configMemo = null;
/**
 * The settings in effect (env: a process environment, default this one's): { prefix, commitKey, rules, kinds, labels,
 * base }. kinds is every kind in listing order (OTHER_KIND last), labels the summary name of each kind that has one.
 */
export function dockerConfig(env = _deps.env()) {
  const raw = { prefix: envvar('DOCKER_LABEL_PREFIX', env), kinds: envvar('DOCKER_KINDS', env), base: envvar('DOCKER_BASE', env) };
  const key = JSON.stringify(raw);
  if (configMemo?.key === key) return configMemo.config;
  let prefix = DEFAULT_PREFIX;
  if (given(raw.prefix)) {
    if (PREFIX_RE.test(raw.prefix)) prefix = raw.prefix;
    else ignored('DOCKER_LABEL_PREFIX', raw.prefix, `a label prefix is words of letters, digits, - and _ joined by dots; using ${DEFAULT_PREFIX}`);
  }
  const parsed = parseKinds(raw.kinds);
  if (parsed.error) ignored('DOCKER_KINDS', raw.kinds, `${parsed.error}; no kinds are used`);
  let base = null;
  if (given(raw.base)) {
    if (REF_RE.test(raw.base)) base = raw.base;
    else ignored('DOCKER_BASE', raw.base, 'not a git ref name; ahead/behind falls back to origin/HEAD');
  }
  const kinds = [...new Set([...parsed.rules.map((r) => r.kind), OTHER_KIND])];
  const labels = {};
  for (const r of parsed.rules) if (r.label && !labels[r.kind]) labels[r.kind] = r.label;
  const config = { prefix, commitKey: `${prefix}.commit`, rules: parsed.rules, kinds, labels, base };
  configMemo = { key, config };
  return config;
}

// ---------------------------------------------------------------- the docker CLI
const FIND_TTL_MS = 10 * 60_000;
const MISS_TTL_MS = 60_000;
// Where a docker CLI lives when no PATH has it: distro packages, Homebrew, Docker Desktop, OrbStack.
const EXTRA_DIRS = ['/usr/bin', '/usr/local/bin', '/opt/homebrew/bin', '/Applications/Docker.app/Contents/Resources/bin', '~/.docker/bin', '~/.orbstack/bin'];
let found = null;   // { at, bin, reason }

/** True when file is an executable regular file. */
async function executable(file) {
  try { await access(file, constants.X_OK); } catch { return false; }
  return _deps.stat(file)?.isFile() ?? false;
}

/** The first dir in dirs holding an executable `docker`, or null. */
async function inDirs(dirs) {
  for (const d of dirs) if (d && path.isAbsolute(d) && (await executable(path.join(d, 'docker')))) return path.join(d, 'docker');
  return null;
}

/**
 * The docker CLI: DROVER_DOCKER when set, else the first docker on PATH, on a login shell's PATH (a launchd or systemd
 * PATH is short) or in the usual install dirs. Kept ten minutes (a miss one minute, so a fresh install is seen soon).
 */
export async function findDocker({ fresh = false } = {}) {
  const now = _deps.now();
  if (!fresh && found && now - found.at < (found.bin ? FIND_TTL_MS : MISS_TTL_MS)) return found;
  const env = _deps.env();
  const pinned = envvar('DOCKER', env);
  let bin = null, reason = null;
  if (pinned) {
    bin = path.isAbsolute(pinned) && (await executable(pinned)) ? pinned : null;
    if (!bin) reason = `DROVER_DOCKER=${pinned} is not an executable file`;
  } else {
    const split = (p) => String(p ?? '').split(':').filter(Boolean);
    bin = await inDirs(split(env.PATH));
    if (!bin) bin = await inDirs(split(await _deps.loginPath().catch(() => '')));
    if (!bin) bin = await inDirs(EXTRA_DIRS.map((d) => d.replace(/^~(?=\/)/, env.HOME ?? '~')));
  }
  found = { at: now, bin, reason: bin ? null : reason ?? 'no docker CLI on PATH, on a login shell\'s PATH or in the usual install dirs' };
  return found;
}

/** docker is missing, cannot start, or has no daemon answering: the host answers `available: false` with the reason. */
export class DockerUnavailable extends Error {
  constructor(reason) { super(`docker unavailable: ${reason}`); this.reason = reason; this.unavailable = true; }
}

/** A request this module will not carry out, with why. The message starts with "refused:" (HTTP 403). */
export class Refused extends Error {
  constructor(why) { super(`refused: ${why}`); this.refused = true; }
}

/** Run the docker CLI with an argv (never a shell): { code, stdout, stderr, truncated, timedOut }. */
async function docker(argv, opts = {}) {
  const d = await findDocker();
  if (!d.bin) throw new DockerUnavailable(d.reason);
  try { return await _deps.run(d.bin, argv, { timeoutMs: 20_000, ...opts }); }
  catch (e) { found = null; throw new DockerUnavailable(`${d.bin} could not be started (${e.code ?? e.message})`); }
}

const firstLine = (s) => String(s ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
const clip = (s, n) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
// ANSI escapes and control characters (tab kept) never reach a caller: logs and exec output are often colored.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b[\]P^_][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]/g;
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;
// The redactor's key=value rule costs the square of a run of [A-Za-z0-9_.-] that has word boundaries inside it (a
// dotted run of 16 KB took 670 ms, so a 256 KB log line of one would hold the daemon for minutes). A run that long is
// a token (a JWT is one) or noise, so it is withheld whole first, and the rest costs about a millisecond per 6 KB.
const LONG_WORDS = /[A-Za-z0-9_.-]{257,}/g;
/** Text fit to leave the host: escapes and control characters out, secrets redacted (lowercase hex such as SHAs and UUIDs kept). */
export function cleanText(s) { return redactSecrets(String(s ?? '').replace(ANSI, '').replace(/\r\n?/g, '\n').replace(CONTROL, ' ').replace(LONG_WORDS, '[redacted]'), { hexSafe: true }); }
const escapeRe = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * docker's output about a project's containers, cleaned with their names kept: docker echoes the ids it was given and
 * compose names one-off containers <project>-<service>-run-<hex>, both of which the redactor would hide as tokens. The
 * ids become names first; names are then left as they are while everything around them is cleaned.
 */
export function cleanOutput(text, { project, containers = [] } = {}) {
  let t = String(text ?? '');
  for (const c of containers) if (c.id && c.name) t = t.split(c.id).join(c.name);
  const names = [...new Set(containers.map((c) => c.name).filter(Boolean))].sort((a, b) => b.length - a.length).map(escapeRe);
  if (project) names.unshift(`${escapeRe(project)}-[A-Za-z0-9_.-]+-run-[0-9a-f]{6,64}`);
  if (!names.length) return cleanText(t);
  const keep = new RegExp(`(${names.join('|')})`, 'g');
  return t.split(keep).map((part, i) => (i % 2 ? part : cleanText(part))).join('');
}
/** One line of at most n characters, cleaned. */
const oneLine = (s, n) => clip(cleanText(s).replace(/\s+/g, ' ').trim(), n);

/** Why `docker ps` failed, in words: no daemon, no permission on its socket, a timeout, or the CLI's own message. */
export function whyUnavailable(r) {
  const line = clip(firstLine(r?.stderr), 200);
  if (r?.timedOut) return 'docker did not answer within 15 s (is the daemon wedged?)';
  if (/permission denied/i.test(line)) {
    let user = 'this user'; try { user = userInfo().username; } catch { /* no passwd entry */ }
    return `permission denied on the docker socket (is ${user} in the docker group?): ${line}`;
  }
  if (/cannot connect to the docker daemon|is the docker daemon running|error during connect|docker\.sock/i.test(line)) return `no docker daemon is answering: ${line}`;
  return `docker ps failed (exit ${r?.code}): ${line || 'no output'}`;
}

// ---------------------------------------------------------------- discovery
// One `docker container inspect` for every container, projected by a template: no Config.Env (secrets stay in docker),
// one JSON object per line. .ID, not .Id: the template runs on Docker's typed struct, where an absent health or
// healthcheck is a nil the template can test; a name the struct lacks (.Id is only the JSON tag) makes docker fall back
// to the raw map, where every container without a healthcheck fails with "map has no entry for key Health".
export const INSPECT_FORMAT = '{"id":{{json .ID}},"name":{{json .Name}},"created":{{json .Created}},"image":{{json .Config.Image}},"imageId":{{json .Image}},"labels":{{json .Config.Labels}},"status":{{json .State.Status}},"exitCode":{{json .State.ExitCode}},"error":{{json .State.Error}},"startedAt":{{json .State.StartedAt}},"finishedAt":{{json .State.FinishedAt}},"oomKilled":{{json .State.OOMKilled}},"health":{{if .State.Health}}{{json .State.Health}}{{else}}null{{end}},"restartCount":{{json .RestartCount}},"restartPolicy":{{json .HostConfig.RestartPolicy.Name}},"ports":{{json .NetworkSettings.Ports}},"mounts":{{json .Mounts}}}';
export const IMAGE_FORMAT = '{"id":{{json .ID}},"created":{{json .Created}},"tags":{{json .RepoTags}},"labels":{{if .Config}}{{json .Config.Labels}}{{else}}null{{end}}}';

const ID_RE = /^[0-9a-f]{12,64}$/;
const L = { project: 'com.docker.compose.project', service: 'com.docker.compose.service', oneoff: 'com.docker.compose.oneoff', number: 'com.docker.compose.container-number', workingDir: 'com.docker.compose.project.working_dir', configFiles: 'com.docker.compose.project.config_files', envFiles: 'com.docker.compose.project.environment_file', version: 'com.docker.compose.version', dependsOn: 'com.docker.compose.depends_on' };

/** com.docker.compose.depends_on ("db:service_healthy:false,job:service_completed_successfully:false") as a list. */
export function parseDependsOn(label) {
  return String(label ?? '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => { const [service, condition = null] = x.split(':'); return { service, condition }; }).filter((x) => x.service);
}

/** Published ports as short strings: "3930->3930/tcp", "127.0.0.1:18080->8080/tcp" (IPv4 and IPv6 binds of one port folded). */
export function portsOf(ports) {
  const out = new Set();
  for (const [inner, binds] of Object.entries(ports ?? {})) {
    if (!Array.isArray(binds)) continue;
    for (const b of binds) {
      if (!b?.HostPort) continue;
      const ip = b.HostIp && b.HostIp !== '0.0.0.0' && b.HostIp !== '::' ? (b.HostIp.includes(':') ? `[${b.HostIp}]:` : `${b.HostIp}:`) : '';
      out.add(`${ip}${b.HostPort}->${inner}`);
    }
  }
  return [...out];
}

/** A container's health as shown: status, failing streak and the last check's output (one cleaned line). */
function healthOf(h) {
  if (!h || typeof h !== 'object') return null;
  const last = Array.isArray(h.Log) && h.Log.length ? h.Log.at(-1) : null;
  return { status: h.Status ?? null, failingStreak: Number(h.FailingStreak) || 0, ...(last ? { lastExit: last.ExitCode ?? null, lastAt: last.End || last.Start || null, last: oneLine(last.Output, 240) } : {}) };
}

// A label whose name says its value is a secret (<prefix>.password, <prefix>.api_key): its value alone reads like any word.
const SECRET_LABEL = /token|secret|passw(?:or)?d|api[-_]?key|access[-_]?key|private[-_]?key|authorization|credentials?/i;

/** The labels under prefix of a container (values cleaned and cut, a secret-named one withheld): <prefix>.commit, ... */
function prefixLabels(labels, prefix) {
  return Object.fromEntries(Object.entries(labels ?? {}).filter(([k]) => k.startsWith(`${prefix}.`)).slice(0, 20).map(([k, v]) => [clip(k, 80), SECRET_LABEL.test(k) ? '[redacted]' : oneLine(v, 200)]));
}

/**
 * One inspect line as the rest of this module reads a container; labels are the ones under the configured prefix
 * (config: dockerConfig()). A container is in a compose project only when compose created it: compose labels every
 * container it makes with com.docker.compose.oneoff, and `docker compose ls` counts by that label. A container started
 * with `docker run` from an image compose built inherits the image's project and service labels and nothing else (seen
 * 2026-10-20): it is kept outside the project, its labels in inherited.
 */
export function normalizeContainer(raw, { config = dockerConfig() } = {}) {
  const labels = raw.labels && typeof raw.labels === 'object' ? raw.labels : {};
  const list = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const composed = labels[L.oneoff] !== undefined;
  return {
    id: String(raw.id ?? ''), name: String(raw.name ?? '').replace(/^\//, ''), created: raw.created ?? null,
    image: raw.image ?? null, imageId: raw.imageId ?? null,
    project: composed ? labels[L.project] || null : null, service: composed ? labels[L.service] || null : null, oneoff: labels[L.oneoff] === 'True',
    inherited: !composed && labels[L.project] ? { project: labels[L.project], service: labels[L.service] ?? null } : null,
    number: Number(labels[L.number]) || null, workingDir: labels[L.workingDir] || null,
    configFiles: list(labels[L.configFiles]), envFiles: list(labels[L.envFiles]), composeVersion: labels[L.version] || null,
    dependsOn: parseDependsOn(labels[L.dependsOn]), labels: prefixLabels(labels, config.prefix),
    status: raw.status ?? 'unknown', exitCode: Number.isInteger(raw.exitCode) ? raw.exitCode : null,
    error: raw.error ? oneLine(raw.error, 240) : null, startedAt: raw.startedAt ?? null, finishedAt: raw.finishedAt ?? null,
    oomKilled: raw.oomKilled === true, health: healthOf(raw.health), restartCount: Number(raw.restartCount) || 0,
    restartPolicy: raw.restartPolicy || 'no', ports: portsOf(raw.ports),
    binds: (Array.isArray(raw.mounts) ? raw.mounts : []).filter((m) => m?.Type === 'bind' && typeof m.Source === 'string').map((m) => ({ source: m.Source, destination: m.Destination ?? null, rw: m.RW !== false })),
  };
}

/** Inspect output (one JSON object per line) -> { containers, bad }; a line that is not JSON is counted, never fatal. */
export function parseInspect(text, { config = dockerConfig() } = {}) {
  const containers = []; let bad = 0;
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    try { const raw = JSON.parse(line); if (raw && typeof raw === 'object' && raw.id) containers.push(normalizeContainer(raw, { config })); else bad++; }
    catch { bad++; }
  }
  return { containers, bad };
}

/**
 * Every container on this host (or of one project), inspected in one call. Throws DockerUnavailable when docker cannot
 * answer. A container removed between the listing and the inspect is just missing (inspect exits 1 and prints the rest).
 */
async function listContainers({ project, config = dockerConfig() } = {}) {
  const ps = await docker(['ps', '-aq', '--no-trunc', ...(project ? ['--filter', `label=${L.project}=${project}`] : [])], { timeoutMs: 15_000, maxBytes: 4 << 20 });
  if (ps.code !== 0 || ps.timedOut) throw new DockerUnavailable(whyUnavailable(ps));
  const ids = ps.stdout.split('\n').map((s) => s.trim()).filter((s) => ID_RE.test(s));
  if (!ids.length) return { containers: [], bad: 0, vanished: 0 };
  const r = await docker(['container', 'inspect', '--format', INSPECT_FORMAT, ...ids], { timeoutMs: 30_000, maxBytes: 64 << 20, maxStderr: 256 << 10 });
  if (r.timedOut) throw new Error('docker container inspect did not finish within 30 s');
  const parsed = parseInspect(r.stdout, { config });
  return { ...parsed, vanished: Math.max(0, ids.length - parsed.containers.length - parsed.bad) };
}

// Image metadata by image id. An id names immutable content, so what docker said about it never changes: kept for the
// life of the process (bounded), because `docker image inspect` costs about 25 ms an image with the containerd store
// (2 s for a stack of 80) while the rest of a read takes a few hundred ms. An id docker did not know is kept as null.
const imageMemo = new Map();
const IMAGE_MEMO_MAX = 4000;

/** Created time, tags and labels of each image id, from the memo or one `docker image inspect` for the rest: a Map by id. */
async function inspectImages(ids) {
  const want = [...new Set(ids.filter((i) => /^sha256:[0-9a-f]{64}$/.test(i ?? '')))];
  const missing = want.filter((i) => !imageMemo.has(i));
  if (missing.length) {
    const r = await docker(['image', 'inspect', '--format', IMAGE_FORMAT, ...missing], { timeoutMs: 30_000, maxBytes: 16 << 20 }).catch(() => null);
    const seen = new Set();
    for (const line of (r?.stdout ?? '').split('\n')) {
      try { const d = JSON.parse(line); if (d?.id) { seen.add(d.id); imageMemo.set(d.id, { created: d.created ?? null, tags: Array.isArray(d.tags) ? d.tags : [], labels: d.labels && typeof d.labels === 'object' ? d.labels : {} }); } } catch { /* skip */ }
    }
    // Only a finished inspect proves an id unknown; a timeout or a failed start leaves those ids to be asked again.
    if (r && !r.timedOut) for (const i of missing) if (!seen.has(i)) imageMemo.set(i, null);
    while (imageMemo.size > IMAGE_MEMO_MAX) imageMemo.delete(imageMemo.keys().next().value);
  }
  return new Map(want.filter((i) => imageMemo.get(i)).map((i) => [i, imageMemo.get(i)]));
}

const VERSION_RE = /^[0-9][\w.+-]{0,40}$/;   // a docker server version as docker prints it: 29.8.1, 28.0.0-rc.1

/** The daemon's version, or null. */
async function serverVersion() {
  const r = await docker(['version', '--format', '{{.Server.Version}}'], { timeoutMs: 10_000, maxBytes: 4096 }).catch(() => null);
  const v = r?.code === 0 ? r.stdout.trim() : '';
  return VERSION_RE.test(v) ? v : null;
}

// ---------------------------------------------------------------- state, kinds, verdicts
// Restart policies under which docker keeps a container running: one that is exited anyway was stopped on purpose.
const KEEPS_RUNNING = new Set(['always', 'unless-stopped']);
/** Container states, worst first: a service with several containers shows its worst one. */
export const STATES = ['dead', 'failed', 'restarting', 'unhealthy', 'stopped', 'created', 'paused', 'unknown', 'removing', 'starting', 'up', 'healthy', 'completed'];
/** States that need someone: listed by name under failing. */
export const FAILING = new Set(['dead', 'failed', 'restarting', 'unhealthy', 'stopped', 'created', 'paused', 'unknown']);
const RUNNING = new Set(['healthy', 'up', 'unhealthy', 'starting']);

/**
 * One container's state. Running: healthy, unhealthy or starting from its healthcheck, else up (no check, which is not
 * healthy). Exited: a one-shot job (something depends on it with service_completed_successfully, or a compose run
 * container) is completed at exit 0 and failed otherwise; a container whose restart policy keeps it running was
 * stopped; anything else is completed at exit 0 (a restart: no job) and failed otherwise (OOM-killed included).
 */
export function classify(c, { jobs = new Set() } = {}) {
  switch (c.status) {
    case 'running': {
      const h = c.health?.status;
      return h === 'healthy' || h === 'unhealthy' || h === 'starting' ? h : 'up';
    }
    case 'restarting': case 'paused': case 'created': case 'removing': case 'dead': return c.status;
    case 'exited': {
      if (c.oneoff || (c.service && jobs.has(c.service))) return c.exitCode === 0 && !c.oomKilled ? 'completed' : 'failed';
      if (KEEPS_RUNNING.has(c.restartPolicy)) return 'stopped';
      return c.exitCode === 0 && !c.oomKilled ? 'completed' : 'failed';
    }
    default: return 'unknown';
  }
}

/** The services something waits on to exit 0 (service_completed_successfully), classify's jobs: migrations, minio-init, ... */
function jobsOf(containers) {
  return new Set(containers.flatMap((c) => c.dependsOn.filter((d) => d.condition === 'service_completed_successfully').map((d) => d.service)));
}

/** A service's kind: the first rule (DROVER_DOCKER_KINDS, see dockerConfig) that matches its name, else OTHER_KIND. */
export function kindOf(service, { config = dockerConfig() } = {}) {
  const s = String(service ?? '');
  return config.rules.find((r) => r.re.test(s))?.kind ?? OTHER_KIND;
}

/** The worst of several states (STATES order). */
const worst = (states) => states.slice().sort((a, b) => STATES.indexOf(a) - STATES.indexOf(b))[0] ?? 'unknown';

/**
 * A stack's verdict: ok, starting, degraded (something failing while something runs) or down (nothing running). Judged
 * on every container, so a scaled service with one container up and one stopped counts as running.
 */
export function verdict(services) {
  const st = services.flatMap((s) => (s.containers?.length ? s.containers.map((c) => c.state) : [s.state]));
  if (!st.length) return 'empty';
  if (st.some((s) => FAILING.has(s))) return st.some((s) => RUNNING.has(s)) ? 'degraded' : 'down';
  if (st.includes('starting')) return 'starting';
  return 'ok';
}

/** Zero for every state, plus total and running. */
const zeroCounts = () => Object.fromEntries([['total', 0], ['running', 0], ...STATES.map((s) => [s, 0])]);

/** Why a service is in its state, in a few words: the exit code, the OOM kill, the last health check, docker's error. */
function detailOf(c, state) {
  if (state === 'unhealthy' || state === 'starting') return c.health?.last ? `health: ${c.health.last}` : null;
  if (state === 'failed' || state === 'stopped' || state === 'dead' || state === 'restarting') return [c.exitCode !== null ? `exit ${c.exitCode}` : null, c.oomKilled ? 'OOM-killed' : null, c.error].filter(Boolean).join(', ') || null;
  if (state === 'created') return c.error ?? 'never started';
  return null;
}

/** A container as listed under its service. */
const brief = (c, state) => ({
  name: c.name, id: c.id.slice(0, 12), state, status: c.status, exitCode: c.exitCode, startedAt: c.startedAt, finishedAt: c.finishedAt,
  restartCount: c.restartCount, ...(c.health ? { health: c.health } : {}), ...(c.oomKilled ? { oomKilled: true } : {}), ...(c.error ? { error: c.error } : {}),
});

/** The most common value of fn over items (null when none). */
function mostCommon(items, fn) {
  const n = new Map();
  for (const x of items) { const v = fn(x); if (v) n.set(v, (n.get(v) ?? 0) + 1); }
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/**
 * Containers -> stacks: one per compose project (sorted by name), then the containers outside any project as one
 * stack with loose: true. Kinds come from config (dockerConfig()). Pure; the code line (git, images) is added by stacks().
 */
export function buildStacks(containers, { config = dockerConfig() } = {}) {
  const order = config.kinds;
  const groups = new Map();
  for (const c of containers) { const k = c.project ?? ''; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(c); }
  const out = [];
  for (const [project, cs] of [...groups.entries()].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))) {
    const loose = project === '';
    const jobs = jobsOf(cs);
    const counts = zeroCounts();
    const byService = new Map(); const oneoff = [];
    for (const c of cs) {
      const state = classify(c, { jobs });
      // One-off runs (compose run) are listed apart and not counted, as `docker compose ls` does not count them.
      if (!loose && c.oneoff) { oneoff.push({ name: c.name, service: c.service, state, exitCode: c.exitCode, created: c.created }); continue; }
      counts.total++; counts[state]++; if (RUNNING.has(state)) counts.running++;
      const key = loose ? c.name : (c.service ?? c.name);
      if (!byService.has(key)) byService.set(key, []);
      byService.get(key).push({ c, state });
    }
    const services = [...byService.entries()].map(([service, list]) => {
      const state = worst(list.map((x) => x.state));
      const pick = list.find((x) => x.state === state) ?? list[0];
      return {
        service, kind: kindOf(service, { config }), state, count: list.length, job: jobs.has(service), image: pick.c.image,
        ports: [...new Set(list.flatMap((x) => x.c.ports))], detail: detailOf(pick.c, state),
        containers: list.map((x) => brief(x.c, x.state)),
      };
    }).sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.service.localeCompare(b.service));
    // Counts per kind, for a stack where a rule matches a service (a breakdown that is all OTHER_KIND says nothing).
    const hasKinds = !loose && services.some((s) => config.rules.some((r) => r.re.test(s.service)));
    const kinds = hasKinds ? Object.fromEntries(order.map((k) => {
      const ss = services.filter((s) => s.kind === k);
      const n = (state) => ss.filter((s) => s.state === state).length;
      return [k, { total: ss.length, healthy: n('healthy'), up: n('up'), completed: n('completed'), starting: n('starting'), failing: ss.filter((s) => FAILING.has(s.state)).map((s) => s.service), ...(config.labels[k] ? { label: config.labels[k] } : {}) }];
    })) : null;
    // Labels under the prefix across the project: one value per key, or every distinct value when containers disagree.
    const labels = {};
    for (const c of cs) for (const [k, v] of Object.entries(c.labels)) { labels[k] ??= new Set(); labels[k].add(v); }
    const workingDir = loose ? null : mostCommon(cs, (c) => c.workingDir);
    const inherited = cs.filter((c) => c.inherited);
    const single = inherited.length === 1;
    const notes = inherited.length ? [`${inherited.length} container${single ? ' carries' : 's carry'} compose labels from ${single ? 'its image' : 'their images'}, so ${single ? 'it was' : 'they were'} started with docker run, not compose, and ${single ? 'is' : 'are'} not counted in that project: ${inherited.slice(0, 6).map((c) => `${c.name} (${c.inherited.project}/${c.inherited.service ?? '?'})`).join(', ')}${inherited.length > 6 ? ', ...' : ''}`] : [];
    const cfgFrom = cs.find((c) => c.workingDir === workingDir && c.configFiles.length) ?? cs.find((c) => c.configFiles.length);
    out.push({
      project: loose ? null : project, loose, verdict: verdict(services), counts, kinds,
      failing: services.filter((s) => FAILING.has(s.state)).map((s) => ({ service: s.service, kind: s.kind, state: s.state, ...(s.detail ? { detail: s.detail } : {}) })),
      services, oneoff,
      workingDir, configFiles: (cfgFrom?.configFiles ?? []).map((p) => ({ path: p, exists: _deps.exists(p) })), envFiles: cfgFrom?.envFiles ?? [],
      composeVersion: mostCommon(cs, (c) => c.composeVersion),
      labels: Object.fromEntries(Object.entries(labels).map(([k, set]) => [k, set.size === 1 ? [...set][0] : [...set].slice(0, 10)])),
      notes,
    });
  }
  return out;
}

/**
 * Totals over a host's stacks: containers by state (one-off runs apart, in oneoff), stacks, failing services, and
 * containers: every container on the host, as `docker ps -a` counts them.
 */
export function totalsOf(stacks) {
  const t = zeroCounts(); t.stacks = 0; t.failing = 0; t.oneoff = 0;
  for (const s of stacks) {
    if (!s.loose) t.stacks++;
    t.failing += s.failing.length; t.oneoff += s.oneoff.length;
    for (const k of Object.keys(s.counts)) t[k] = (t[k] ?? 0) + s.counts[k];
  }
  t.containers = t.total + t.oneoff;
  return t;
}

// ---------------------------------------------------------------- code: git and images
const GIT_ENV = { GIT_OPTIONAL_LOCKS: '0' };   // reading never writes the index (another agent may be committing)
// A repo's own config never runs a command while it is read: core.fsmonitor names one that `git status` would start.
const GIT_SAFE = ['-c', 'core.fsmonitor=false'];
const SHA_RE = /^[0-9a-f]{40,64}$/;
/** Unix seconds (git's %ct) as an ISO time, or null when s is not a count of seconds. */
const unixToIso = (s) => (/^\d+$/.test(s ?? '') ? new Date(Number(s) * 1000).toISOString() : null);
// Bind sources that are never source code: the docker socket, system and device trees.
const SYSTEM_BIND = /^\/(proc|sys|dev|run|var\/run|var\/lib\/docker|etc|usr|lib|lib64|bin|sbin|boot)(\/|$)|docker\.sock$/;

/** A small concurrency gate: at most n of the given functions run at once. */
function gate(n) {
  let active = 0; const q = [];
  const next = () => { if (active >= n || !q.length) return; active++; const { fn, res, rej } = q.shift(); Promise.resolve().then(fn).then(res, rej).finally(() => { active--; next(); }); };
  return (fn) => new Promise((res, rej) => { q.push({ fn, res, rej }); next(); });
}

/** Read-only git with the safe environment (core/git-env.js: no prompts, nothing inherited that points git elsewhere). */
function git(argv, { timeoutMs = 15_000 } = {}) {
  return _deps.run('git', [...GIT_SAFE, ...argv], { timeoutMs, maxBytes: 4 << 20, env: gitEnv(GIT_ENV) });
}

/** git status --porcelain=v2 --branch -z: HEAD, branch or detached, upstream, ahead/behind, changed and untracked files. */
export function parseStatusV2(text) {
  const o = { head: null, branch: null, detached: false, upstream: null, ahead: null, behind: null, changed: 0, untracked: 0, conflicted: 0 };
  const recs = String(text ?? '').split('\0');
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    if (r.startsWith('# branch.oid ')) { const v = r.slice(13); o.head = SHA_RE.test(v) ? v : null; }
    else if (r.startsWith('# branch.head ')) { const v = r.slice(14); if (v === '(detached)') o.detached = true; else o.branch = v; }
    else if (r.startsWith('# branch.upstream ')) o.upstream = r.slice(18);
    else if (r.startsWith('# branch.ab ')) { const m = /^# branch\.ab \+(\d+) -(\d+)$/.exec(r); if (m) { o.ahead = Number(m[1]); o.behind = Number(m[2]); } }
    else if (r.startsWith('1 ')) o.changed++;
    else if (r.startsWith('2 ')) { o.changed++; i++; }   // a rename or copy carries its original path in the next record
    else if (r.startsWith('u ')) { o.changed++; o.conflicted++; }
    else if (r.startsWith('? ')) o.untracked++;
  }
  return o;
}

/**
 * A per-read memo of git answers, so a repo several stacks share (or one stack mounts many times) is read once, and at
 * most 8 git processes run at a time. config.base is the ref ahead/behind falls back to first (dockerConfig()).
 */
function gitReader({ config = dockerConfig() } = {}) {
  // Without an upstream: DROVER_DOCKER_BASE when set, then the remote's default branch.
  const bases = [...new Set([config.base, 'origin/HEAD'].filter(Boolean))];
  const run = gate(8);
  const tops = new Map(); const facts = new Map();
  const home = _deps.env().HOME;

  /** The work tree holding dir: { toplevel, gitDir, common }, or null (not a repo, a bare one, or the home dir itself). */
  const where = (dir) => {
    if (!tops.has(dir)) tops.set(dir, run(async () => {
      const r = await git(['-C', dir, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir']).catch(() => null);
      if (r?.code !== 0) return null;
      const [toplevel, gitDir, common] = r.stdout.trim().split('\n');
      // A home directory kept in git (dotfiles) holds every bind source under it; it is never the code a stack runs.
      if (!toplevel || toplevel === '/' || toplevel === home) return null;
      return { toplevel, gitDir, common };
    }));
    return tops.get(dir);
  };

  /** git rev-list --left-right --count of range in top: [left, right], or null when git cannot count it. */
  const leftRight = async (top, range) => {
    const r = await run(() => git(['-C', top, 'rev-list', '--left-right', '--count', range, '--'])).catch(() => null);
    const m = r?.code === 0 ? /^(\d+)\s+(\d+)\s*$/.exec(r.stdout) : null;
    return m ? [Number(m[1]), Number(m[2])] : null;
  };

  /** The git state of the work tree at loc (from where()), read once per toplevel. */
  const state = (loc) => {
    if (!facts.has(loc.toplevel)) facts.set(loc.toplevel, (async () => {
      const top = loc.toplevel;
      const [st, log] = await Promise.all([
        run(() => git(['-C', top, 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal', '--ignore-submodules=all'], { timeoutMs: 20_000 })).catch((e) => ({ code: -1, stdout: '', stderr: e.message })),
        run(() => git(['-C', top, 'log', '-1', '--format=%H%x00%ct%x00%s'])).catch(() => null),
      ]);
      const s = st.code === 0 && !st.timedOut ? parseStatusV2(st.stdout) : null;
      const [sha, ct, subject] = log?.code === 0 ? log.stdout.replace(/\n$/, '').split('\0') : [];
      const head = s?.head ?? (SHA_RE.test(sha ?? '') ? sha : null);
      let ahead = s?.ahead ?? null, behind = s?.behind ?? null, against = ahead !== null ? s.upstream : null;
      // No upstream (a detached worktree, a local branch): count against the configured base, else origin/HEAD, the
      // first that names a commit in this repo.
      if (ahead === null && head) {
        for (const ref of bases) {
          const n = await leftRight(top, `HEAD...${ref}`);
          if (n) { [ahead, behind] = n; against = ref; break; }
        }
      }
      const worktree = loc.gitDir !== loc.common;
      return {
        toplevel: top, worktree, mainRepo: worktree && path.basename(loc.common) === '.git' ? path.dirname(loc.common) : null,
        branch: s?.branch ?? null, detached: Boolean(s?.detached), head, short: head ? head.slice(0, 10) : null,
        subject: subject ? oneLine(subject, 200) : null, committedAt: unixToIso(ct),
        dirty: s ? { changed: s.changed, untracked: s.untracked, ...(s.conflicted ? { conflicted: s.conflicted } : {}) } : null,
        upstream: s?.upstream ?? null, ahead, behind, against,
        ...(s ? {} : { error: clip(st.stderr ? firstLine(st.stderr) : 'git status did not answer', 200) }),
      };
    })());
    return facts.get(loc.toplevel);
  };

  /** How many commits HEAD of top is after (and before) rev, when rev names a commit there: { ahead, behind } or null. */
  const distance = async (top, rev) => {
    const n = await leftRight(top, `${rev}...HEAD`);
    return n ? { behind: n[0], ahead: n[1] } : null;
  };
  return { where, state, distance };
}

/**
 * Commit label values (key: <prefix>.commit) across every container of every service (a scaled service's replicas can
 * disagree): a Map of value -> the services carrying it, each counted once. full maps a listed container to its
 * inspected one.
 */
function commitsOf(services, full, key) {
  const out = new Map();
  for (const sv of services) for (const c of sv.containers) {
    const v = full(c)?.labels?.[key];
    if (typeof v !== 'string' || !COMMIT_RE.test(v)) continue;
    if (!out.has(v)) out.set(v, []);
    if (!out.get(v).includes(sv.service)) out.get(v).push(sv.service);
  }
  return out;
}

/** The image is built from this stack's source: compose labels what it builds; a hand-built image is named after the project. */
function builtImage(img, name, project) {
  return Boolean(img?.labels?.[L.project]) || (Boolean(project) && String(name ?? '').startsWith(`${project}-`));
}

const COMMIT_RE = /^[0-9a-f]{7,64}$/;   // a commit label value: a commit sha, full or abbreviated
/** True when a commit label value names the HEAD sha (either one may be the abbreviation of the other). */
const sameCommit = (head, value) => Boolean(head) && (head.startsWith(value) || value.startsWith(head));

/**
 * What code a stack runs. The working dir's git state; the repos behind its bind mounts when they differ (a generated
 * runtime dir is no repo at all); which services run straight from a work tree (they bind a source directory); the
 * commit label (config.commitKey) against the source's HEAD; and built images older than that HEAD commit. images is
 * a promise of the image metadata (inspectImages), read while git works.
 */
async function codeFor(stack, { reader, images, config = dockerConfig() }) {
  const notes = [];
  const wd = stack.workingDir;
  const wdLoc = wd && _deps.exists(wd) ? await reader.where(wd) : null;
  const dir = wd ? { path: wd, exists: _deps.exists(wd), git: wdLoc ? await reader.state(wdLoc) : null } : null;
  // Bind sources -> the directory each lives in, and which services mount a directory (not just a file) from it.
  const dirs = new Map();   // dir -> { services: Set, dirMount: Set }
  for (const s of stack.services) for (const c of s.containers) {
    const full = stack.raw?.get(c.id);
    for (const b of full?.binds ?? []) {
      if (SYSTEM_BIND.test(b.source) || dirs.size >= 200) continue;
      const st = _deps.stat(b.source);
      if (!st) continue;
      const d = st.isDirectory() ? b.source : path.dirname(b.source);
      if (!dirs.has(d)) dirs.set(d, { services: new Set(), dirMount: new Set() });
      dirs.get(d).services.add(s.service);
      if (st.isDirectory()) dirs.get(d).dirMount.add(s.service);
    }
  }
  const repos = new Map();   // toplevel -> { loc, services: Set, fromTree: Set }
  await Promise.all([...dirs.entries()].map(async ([d, use]) => {
    const loc = await reader.where(d);
    if (!loc) return;
    if (!repos.has(loc.toplevel)) repos.set(loc.toplevel, { loc, services: new Set(), fromTree: new Set() });
    const r = repos.get(loc.toplevel);
    for (const s of use.services) r.services.add(s);
    for (const s of use.dirMount) r.fromTree.add(s);
  }));
  const fromTree = new Set([...repos.values()].flatMap((r) => [...r.fromTree]));
  const others = [...repos.values()].filter((r) => r.loc.toplevel !== wdLoc?.toplevel).sort((a, b) => b.services.size - a.services.size).slice(0, 8);
  const sources = await Promise.all(others.map(async (r) => ({ ...(await reader.state(r.loc)), services: r.services.size, fromTree: r.fromTree.size })));
  // The code the stack is checked out at: its working dir's repo, else the repo most of its services mount.
  const source = dir?.git ?? sources[0] ?? null;
  if (dir && !dir.exists) notes.push(`the working dir ${wd} no longer exists`);
  else if (dir && !dir.git && source) notes.push(`the working dir is not a git repo; the code comes from bind mounts of ${source.toplevel}`);
  else if (dir && !dir.git) notes.push('the working dir is not a git repo and no bind mount comes from one');
  // The commit label: the commit each container was brought up for. One that is not the source's HEAD means image and
  // source disagree; several values mean the containers were brought up at different commits (seen 2026-10-20).
  const key = config.commitKey;
  const byCommit = commitsOf(stack.services, (c) => stack.raw?.get(c.id), key);
  let commitLabel = null;
  if (byCommit.size) {
    const values = await Promise.all([...byCommit.entries()].map(async ([value, svcs]) => {
      const matches = sameCommit(source?.head, value);
      const dist = source?.head && !matches ? await reader.distance(source.toplevel, value) : null;
      return { value, services: svcs.length, matches, ...(dist ?? {}), ...(source?.head && !matches && !dist ? { inRepo: false } : {}) };
    }));
    values.sort((a, b) => b.services - a.services || a.value.localeCompare(b.value));
    commitLabel = { key, head: source?.short ?? null, matches: values.every((v) => v.matches), values };
    const off = values.filter((v) => !v.matches);
    if (source?.head && off.length) {
      const say = (v) => `${v.value} (${v.services} service${v.services === 1 ? '' : 's'}; ${v.inRepo === false ? 'not a commit in that repo' : `HEAD is ${v.ahead} commit${v.ahead === 1 ? '' : 's'} after it${v.behind ? `, and ${v.behind} of its commits ${v.behind === 1 ? 'is' : 'are'} not in HEAD` : ''}`})`;
      notes.push(`containers carry ${key} ${off.map(say).join(' and ')} but the source is at ${source.short}: image and source disagree`);
    }
  }
  // Built images (from this stack's source) and the ones older than the commit the source is at. A stale image matters
  // only where its services do not mount the source: those are listed; the rest are counted.
  const headAt = source?.committedAt ? Date.parse(source.committedAt) : NaN;
  const imageMeta = await images;
  const builtImages = new Map();   // image name -> { image, created, services, stale, fromTree }
  for (const s of stack.services) {
    const img = imageMeta.get(stack.raw?.get(s.containers[0]?.id)?.imageId);
    if (!img || !builtImage(img, s.image, stack.project)) continue;
    const created = Date.parse(img.created ?? '');
    if (!builtImages.has(s.image)) builtImages.set(s.image, { image: s.image, created: img.created ?? null, services: [], stale: Number.isFinite(headAt) && Number.isFinite(created) && created < headAt });
    builtImages.get(s.image).services.push(s.service);
  }
  const built = [...builtImages.values()].map((x) => ({ ...x, fromTree: x.services.every((sv) => fromTree.has(sv)) }));
  const stale = built.filter((x) => x.stale);
  const staleNotMounted = stale.filter((x) => !x.fromTree);
  const imageSummary = {
    built: built.length, stale: stale.length, staleFromTree: stale.length - staleNotMounted.length,
    oldest: built.map((x) => x.created).filter(Boolean).sort()[0] ?? null,
    staleNotMounted: staleNotMounted.slice(0, 20).map(({ image, created, services }) => ({ image, created, services })),
  };
  if (stale.length) {
    const n = stale.length, m = staleNotMounted.length;
    notes.push(m === 0
      ? `${n} built image${n === 1 ? ' predates' : 's predate'} HEAD ${source.short}; ${n === 1 ? 'its services bind-mount' : 'their services bind-mount'} the working tree, so the running code is the working tree and the images mostly hold dependencies`
      : `${m} built image${m === 1 ? ' predates' : 's predate'} HEAD ${source.short} without mounting the source (${staleNotMounted.slice(0, 5).map((x) => x.image).join(', ')}${m > 5 ? ', ...' : ''}): likely stale, rebuild to run HEAD${n > m ? `; ${n - m} more run the bind-mounted working tree` : ''}`);
  }
  return { dir, sources, source: source ? { toplevel: source.toplevel, head: source.head, short: source.short } : null, fromTree: fromTree.size, services: stack.services.length, commitLabel, images: imageSummary, notes };
}

// ---------------------------------------------------------------- docker.stacks
const PROJECT_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;    // what compose accepts as a project name
const SERVICE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;

/** A compose project name, or a refusal saying why not. */
function assertProject(p) {
  if (typeof p !== 'string' || !PROJECT_RE.test(p)) throw new Refused(`${JSON.stringify(String(p)).slice(0, 80)} is not a compose project name (lowercase letters, digits, - and _)`);
  return p;
}

/** A host's answer when its docker cannot be read: no stacks, and docker.available false with d's reason (and bin). */
const unavailableAnswer = (d) => ({ docker: { available: false, ...d }, totals: totalsOf([]), stacks: [], notes: [] });

/**
 * Every compose stack on this host (or one project): services with their state, counts, kinds, what is failing and
 * the code line (git: false skips it). A host without docker, or whose daemon does not answer, says so in
 * docker.available and docker.reason instead of failing.
 */
export async function stacks({ project, git: withGit = true } = {}) {
  const t0 = _deps.now();
  const host = _deps.host();
  const p = given(project) ? assertProject(project) : null;
  const done = (body) => ({ host, ts: new Date(_deps.now()).toISOString(), ms: _deps.now() - t0, ...body });
  const d = await findDocker();
  if (!d.bin) return done(unavailableAnswer({ reason: d.reason }));
  const config = dockerConfig();
  let listed;
  try { listed = await listContainers({ project: p, config }); }
  catch (e) { if (e.unavailable) return done(unavailableAnswer({ bin: d.bin, reason: e.reason })); throw e; }
  const code = withGit !== false && withGit !== 'false';
  // Images are only read for the code line, and alongside the git reads (codeFor awaits them last).
  const images = code ? inspectImages(listed.containers.map((c) => c.imageId)) : null;
  const versionP = serverVersion();
  const raw = new Map(listed.containers.map((c) => [c.id.slice(0, 12), c]));
  const built = buildStacks(listed.containers, { config });
  if (code) {
    const reader = gitReader({ config });
    await Promise.all(built.filter((s) => !s.loose).map(async (s) => { s.code = await codeFor({ ...s, raw }, { reader, images, config }); }));
  }
  const version = await versionP;
  const notes = [];
  if (listed.vanished) notes.push(`${listed.vanished} container${listed.vanished === 1 ? '' : 's'} went away during the read`);
  if (listed.bad) notes.push(`${listed.bad} inspect line${listed.bad === 1 ? ' was' : 's were'} not readable`);
  return done({ docker: { available: true, bin: d.bin, version }, totals: totalsOf(built), stacks: built, notes });
}

// ---------------------------------------------------------------- guarded verbs on one project
const ACT_TIMEOUT_MS = 110_000;   // under core/api.js's 120 s host timeout for these ops

/** Refuses any argument the op does not take, saying what docker ops never accept from a caller. */
function onlyArgs(op, args, allowed) {
  const extra = Object.keys(args ?? {}).filter((k) => !allowed.includes(k) && k !== 'actor' && k !== 'fresh' && args[k] !== undefined);
  if (extra.length) throw new Refused(`${op} does not take ${extra.join(', ')}: docker ops never take a user, privileged mode, environment, entrypoint, working dir, volume or host path from the caller`);
}

/** A list of service names (one string is a list of one), each a valid compose service name. */
function serviceList(v, op) {
  const list = typeof v === 'string' ? [v] : v;
  if (!Array.isArray(list) || !list.length || list.some((s) => typeof s !== 'string' || !SERVICE_RE.test(s))) throw new Refused(`${op} needs services: a list of compose service names as docker.stacks lists them`);
  if (list.length > 40) throw new Refused(`${op} acts on at most 40 services at once`);
  return [...new Set(list)];
}

/** The one service exec, run and logs act on: a compose service name (a list of one is fine; more is refused). */
function oneService(v, op) {
  const list = Array.isArray(v) ? v : [v];
  if (list.length !== 1 || typeof list[0] !== 'string' || !SERVICE_RE.test(list[0])) throw new Refused(`${op} needs service: one compose service name as docker.stacks lists it`);
  return list;
}

/** An argv for exec or run: strings only, bounded; a shell string is never taken. */
export function assertArgv(argv, { required = true } = {}) {
  if (argv === undefined || argv === null) {
    if (required) throw new Refused('argv is required: an array of strings such as ["ls", "-la"]');
    return [];
  }
  if (!Array.isArray(argv) || argv.some((a) => typeof a !== 'string')) throw new Refused('argv must be an array of strings; a shell string is never taken (pass ["sh", "-c", "..."] to run one inside the container)');
  if (required && !argv.length) throw new Refused('argv must not be empty');
  if (argv.length > 64) throw new Refused('argv has more than 64 items');
  if (argv.some((a) => a.includes('\0'))) throw new Refused('argv items must not contain NUL');
  if (argv.reduce((n, a) => n + a.length, 0) > 16_384) throw new Refused('argv is longer than 16 KB');
  return argv;
}

/** A timeout in ms within [1 s, 110 s]; def when not given. */
function timeoutArg(v, def) {
  if (!given(v)) return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Refused('timeoutMs must be a positive number of milliseconds');
  return Math.max(1000, Math.min(ACT_TIMEOUT_MS, Math.round(n)));
}

/** Compose projects on this host, for a refusal that says what is there. */
async function projectsHere() {
  const r = await docker(['ps', '-a', '--format', `{{.Label "${L.project}"}}`], { timeoutMs: 15_000, maxBytes: 1 << 20 }).catch(() => null);
  return r?.code === 0 ? [...new Set(r.stdout.split('\n').map((s) => s.trim()).filter(Boolean))].sort() : [];
}

/**
 * What discovery finds of a project right now (never the cache): its containers by service, one-off runs left out. A
 * project with no container on this host is refused, naming the projects that are here.
 */
async function discoverProject(project) {
  assertProject(project);
  const { containers } = await listContainers({ project, config: dockerConfig() });
  const own = containers.filter((c) => c.project === project && !c.oneoff);
  if (!own.length) {
    const here = await projectsHere();
    throw new Refused(`no compose project ${project} on ${_deps.host()}${here.length ? ` (projects here: ${here.join(', ')})` : ' (no compose projects here)'}`);
  }
  const jobs = jobsOf(own);
  const byService = new Map();
  for (const c of own) { if (!byService.has(c.service)) byService.set(c.service, []); byService.get(c.service).push({ ...c, state: classify(c, { jobs }) }); }
  for (const list of byService.values()) list.sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
  return { project, byService };
}

/** What cleanOutput keeps readable in docker's output about a discovered project: its name and its containers' names. */
const scopeOf = (found) => ({ project: found.project, containers: [...found.byService.values()].flat() });

/** The named services of a discovered project, or a refusal listing the services it has. */
function pickServices(found, names) {
  const missing = names.filter((s) => !found.byService.has(s));
  if (missing.length) throw new Refused(`${found.project} has no service ${missing.join(', ')} (services: ${[...found.byService.keys()].sort().join(', ')})`);
  return names.map((s) => ({ service: s, containers: found.byService.get(s) }));
}

/** One container of a service: the given container number (index), else the first running one, else the first. */
function oneContainer(svc, index, { running = false } = {}) {
  let list = svc.containers;
  if (given(index)) {
    const n = Number(index);
    list = list.filter((c) => c.number === n);
    if (!list.length) throw new Refused(`${svc.service} has no container number ${index} (numbers: ${svc.containers.map((c) => c.number).join(', ')})`);
  }
  const c = list.find((x) => x.status === 'running') ?? list[0];
  if (running && c.status !== 'running') throw new Refused(`${svc.service} is not running (${c.state}${c.exitCode !== null && c.status === 'exited' ? `, exit ${c.exitCode}` : ''}): exec needs a running container; start or restart it first`);
  return c;
}

/** Container states after a verb, read again (short ids and names). */
async function statesAfter(ids) {
  const r = await docker(['container', 'inspect', '--format', INSPECT_FORMAT, ...ids], { timeoutMs: 20_000, maxBytes: 8 << 20 }).catch(() => null);
  return new Map(parseInspect(r?.stdout ?? '', { config: dockerConfig() }).containers.map((c) => [c.id, classify(c)]));
}

/** The result of a lifecycle verb: what docker said (cleaned, cut) and each container before and after. */
async function lifecycleResult(verb, project, targets, r, t0) {
  const after = await statesAfter(targets.map((c) => c.id));
  const exitCode = r.timedOut ? null : r.code;
  return {
    ok: exitCode === 0, host: _deps.host(), project, verb, services: [...new Set(targets.map((c) => c.service))], count: targets.length, exitCode, timedOut: r.timedOut,
    output: clip(cleanOutput(`${r.stdout}${r.stderr}`, { project, containers: targets }).trim(), 4000) || null,
    containers: targets.map((c) => ({ name: c.name, service: c.service, before: c.state, after: after.get(c.id) ?? 'unknown' })), ms: _deps.now() - t0,
  };
}

/** docker.restart: restart every container of the named services (docker restart, 10 s stop timeout each). */
export async function restart(args = {}) {
  onlyArgs('docker.restart', args, ['project', 'services']);
  const t0 = _deps.now();
  const found = await discoverProject(args.project);
  const targets = pickServices(found, serviceList(args.services, 'docker.restart')).flatMap((s) => s.containers);
  const r = await docker(['restart', '--timeout', '10', ...targets.map((c) => c.id)], { timeoutMs: ACT_TIMEOUT_MS, maxBytes: 64 << 10 });
  return lifecycleResult('restart', found.project, targets, r, t0);
}

/**
 * docker.start: start the stopped containers of the named services (exited or created: a service that exited, or a
 * one-shot job to run again). A service with nothing to start, running or paused, is refused: use docker.restart.
 */
export async function start(args = {}) {
  onlyArgs('docker.start', args, ['project', 'services']);
  const t0 = _deps.now();
  const found = await discoverProject(args.project);
  const picked = pickServices(found, serviceList(args.services, 'docker.start'));
  const startable = (c) => c.status === 'exited' || c.status === 'created';
  const busy = picked.filter((s) => !s.containers.some(startable));
  if (busy.length) throw new Refused(`nothing to start in ${busy.map((s) => `${s.service} (${s.containers.map((c) => c.state).join(', ')})`).join(', ')}: start only starts exited or created containers; restart a running one`);
  const targets = picked.flatMap((s) => s.containers.filter(startable));
  const r = await docker(['start', ...targets.map((c) => c.id)], { timeoutMs: ACT_TIMEOUT_MS, maxBytes: 64 << 10 });
  return lifecycleResult('start', found.project, targets, r, t0);
}

/** Output of exec or run as returned: cleaned with the project's container names kept, at most 64 KB each (the runner kept no more). */
const outputOf = (r, found) => {
  const scope = scopeOf(found);
  return { stdout: cleanOutput(r.stdout, scope), stderr: cleanOutput(r.stderr, scope), truncated: r.truncated };
};

/**
 * docker.exec: run an argv in a running container of one service (docker exec, no TTY, no stdin, the container's own
 * user and working dir). Bounded by timeoutMs (default 30 s, max 110 s); stdout and stderr are capped at 64 KB each and
 * redacted.
 */
export async function exec(args = {}) {
  onlyArgs('docker.exec', args, ['project', 'service', 'argv', 'timeoutMs', 'index']);
  const t0 = _deps.now();
  const argv = assertArgv(args.argv);
  const timeoutMs = timeoutArg(args.timeoutMs, 30_000);
  const found = await discoverProject(args.project);
  const [svc] = pickServices(found, oneService(args.service, 'docker.exec'));
  const c = oneContainer(svc, args.index, { running: true });
  const r = await docker(['exec', c.id, ...argv], { timeoutMs, maxBytes: 64 << 10, maxStderr: 64 << 10 });
  return {
    ok: !r.timedOut && r.code === 0, host: _deps.host(), project: found.project, service: svc.service, container: c.name, verb: 'exec', argv: redactArgv(argv, { hexSafe: true }),
    exitCode: r.timedOut ? null : r.code, timedOut: r.timedOut, ...outputOf(r, found), ms: _deps.now() - t0,
    ...(r.timedOut ? { note: `docker exec was stopped after ${Math.round(timeoutMs / 1000)} s; the command may still be running inside the container` } : {}),
  };
}

/**
 * docker.run: a one-off job from a service's own definition, `docker compose run --rm -T --no-deps --pull never`, with
 * the project's compose files, which must all still exist on disk. Only for an image already on the host (nothing is
 * built or pulled); dependencies are not started. argv (optional) replaces the service's command.
 */
export async function runJob(args = {}) {
  onlyArgs('docker.run', args, ['project', 'service', 'argv', 'timeoutMs']);
  const t0 = _deps.now();
  const argv = assertArgv(args.argv, { required: false });
  const timeoutMs = timeoutArg(args.timeoutMs, 60_000);
  const found = await discoverProject(args.project);
  const [svc] = pickServices(found, oneService(args.service, 'docker.run'));
  const c = svc.containers[0];
  const wd = c.workingDir, files = c.configFiles;
  if (!wd || !_deps.exists(wd)) throw new Refused(`${found.project}'s working dir ${wd ?? '(unknown)'} is not on disk, so its compose project cannot be loaded`);
  const gone = files.filter((f) => !_deps.exists(f));
  if (!files.length || gone.length) throw new Refused(`${found.project}'s compose files ${files.length ? `are not all on disk (missing: ${gone.join(', ')})` : 'are not recorded on its containers'}: run needs them`);
  const goneEnv = c.envFiles.filter((f) => !_deps.exists(f));
  if (goneEnv.length) throw new Refused(`${found.project}'s env files are not all on disk (missing: ${goneEnv.join(', ')})`);
  const project = ['compose', '-p', found.project, '--project-directory', wd, ...files.flatMap((f) => ['-f', f]), ...c.envFiles.flatMap((f) => ['--env-file', f])];
  // The image is the one the service resolves to in its compose files as they are now, not the old container's: a
  // checkout may have moved the service to an image that is not built yet, and compose run builds a missing image of a
  // service with a build section whatever --pull says. Without an image compose names it <project>-<service>. The
  // config is parsed here and dropped (env files are not resolved into it; interpolated values never leave this call).
  const conf = await docker([...project, 'config', '--format', 'json', '--no-env-resolution', svc.service], { timeoutMs: 30_000, maxBytes: 16 << 20, maxStderr: 16 << 10, cwd: wd });
  let def = null;
  try { def = JSON.parse(conf.stdout)?.services?.[svc.service] ?? null; } catch { /* refused below */ }
  if (conf.code !== 0 || !def) throw new Refused(`${svc.service} could not be read from ${found.project}'s compose files: ${clip(cleanText(firstLine(conf.stderr) || `exit ${conf.code}`), 200)}`);
  const image = typeof def.image === 'string' && def.image ? def.image : `${found.project}-${svc.service}`;
  const img = await docker(['image', 'inspect', '--format', '{{.ID}}', image], { timeoutMs: 15_000, maxBytes: 4096 });
  if (img.code !== 0) throw new Refused(`${svc.service}'s image ${image} (from its compose files as they are now) is not on ${_deps.host()}; run never builds or pulls one`);
  const r = await docker([...project, 'run', '--rm', '-T', '--no-deps', '--pull', 'never', '--', svc.service, ...argv], { timeoutMs, maxBytes: 64 << 10, maxStderr: 64 << 10, cwd: wd });
  return {
    ok: !r.timedOut && r.code === 0, host: _deps.host(), project: found.project, service: svc.service, verb: 'run', argv: redactArgv(argv, { hexSafe: true }),
    exitCode: r.timedOut ? null : r.code, timedOut: r.timedOut, ...outputOf(r, found), configFiles: files, ms: _deps.now() - t0,
    ...(r.timedOut ? { note: `docker compose run was stopped after ${Math.round(timeoutMs / 1000)} s; the job container may still be running (docker.stacks lists it under oneoff)` } : {}),
  };
}

// ---------------------------------------------------------------- docker.logs
// What docker logs --since takes: a Go duration (90s, 10m, 1h30m), unix seconds, or an RFC 3339 date or time.
const SINCE_RE = /^(?:(?:\d+(?:\.\d+)?(?:ns|us|ms|s|m|h))+|\d{9,10}(?:\.\d+)?|\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?)$/;
const LOG_CAP = 256 << 10;

/** docker logs --timestamps output (one stream) as [{ ts, text }]. */
function logLines(text, stream) {
  return String(text ?? '').split('\n').filter((l, i, a) => l || i < a.length - 1).map((l) => { const m = /^(\d{4}-\d{2}-\d{2}T\S+)\s?(.*)$/.exec(l); return m ? { ts: m[1], text: m[2], stream } : { ts: '', text: l, stream }; });
}

/** Two time-ordered line lists merged in time order (docker's timestamps have a fixed width, so they sort as strings). */
export function mergeLogs(out, err) {
  const a = logLines(out, 'stdout'), b = logLines(err, 'stderr'), m = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) m.push(j >= b.length || (i < a.length && a[i].ts <= b[j].ts) ? a[i++] : b[j++]);
  return m;
}

/**
 * docker.logs: the last lines (tail, default 200, max 2000) of one service's container, optionally since a time, its
 * stdout and stderr merged in time order, escapes stripped and secrets redacted, at most 256 KB. Never cached.
 */
export async function logs(args = {}) {
  onlyArgs('docker.logs', args, ['project', 'service', 'tail', 'since', 'timestamps', 'index']);
  const t0 = _deps.now();
  const tail = Math.max(1, Math.min(2000, Math.round(Number(args.tail ?? 200)) || 200));
  const since = given(args.since) ? String(args.since) : null;
  if (since !== null && !SINCE_RE.test(since)) throw new Refused('since must be a duration (10m, 1h30m), unix seconds or an RFC 3339 time');
  const found = await discoverProject(args.project);
  const [svc] = pickServices(found, oneService(args.service, 'docker.logs'));
  const c = oneContainer(svc, args.index);
  // The newest 2 MB of each stream: lines can be long enough that the tail asked for is more than that.
  const r = await docker(['logs', '--timestamps', '--tail', String(tail), ...(since ? ['--since', since] : []), c.id], { timeoutMs: 20_000, maxBytes: 2 << 20, maxStderr: 2 << 20, tail: true });
  if (r.timedOut) throw new Error(`docker logs ${c.name} did not finish within 20 s`);
  if (r.code !== 0) throw new Error(`docker logs ${c.name} failed (exit ${r.code}): ${clip(cleanText(firstLine(r.stderr)), 300)}`);
  // A stream that was cut starts inside a line (every whole line starts with docker's timestamp): that part goes.
  const whole = (t) => (r.truncated && t && !/^\d{4}-\d{2}-\d{2}T/.test(t) ? t.slice(t.indexOf('\n') + 1 || t.length) : t);
  const merged = mergeLogs(whole(r.stdout), whole(r.stderr));
  const stamp = args.timestamps === true || args.timestamps === 'true';
  let text = merged.map((l) => `${stamp && l.ts ? `${l.ts} ` : ''}${l.text}`).join('\n');
  let truncated = r.truncated;
  if (text.length > LOG_CAP) { text = text.slice(-LOG_CAP); text = text.slice(text.indexOf('\n') + 1); truncated = true; }
  return {
    host: _deps.host(), project: found.project, service: svc.service, container: c.name, state: c.state, tail, since,
    lines: merged.length, stderrLines: merged.filter((l) => l.stream === 'stderr').length, truncated, text: cleanOutput(text, scopeOf(found)), ms: _deps.now() - t0,
  };
}

// ---------------------------------------------------------------- hosts that run no Drover
// A host a plugin provides (core/plugins.js hosts) may run docker but no Drover. A projected inspect runs there through
// the provider's own transport (its dockerStacks hands remoteStacks an exec), which may keep only line-oriented output:
// one JSON object per line is that; whether each compose file exists there, and a few plain git commands per working
// dir (branch, HEAD, dirty files), come back as tab-separated lines. Redaction runs on this side, so what leaves that
// host is cut down there: only the labels this module reads (compose's and those under the label prefix), the last
// health check with its output cut to 240 characters, and no mounts. Read only: the verbs, and logs, need Drover there.
// The script takes the project ('' for all) and git or nogit as $1 and $2.
const REMOTE_GIT = '__DROVER_GIT__';
const REMOTE_FILE = '__DROVER_FILE__';
const REMOTE_NO_DOCKER = '__DROVER_NO_DOCKER__';
const REMOTE_VERSION = '__DROVER_DOCKER_VERSION__';
const KEEP_LABELS = [L.project, L.service, L.oneoff, L.number, L.workingDir, L.configFiles, L.envFiles, L.version, L.dependsOn];

/**
 * INSPECT_FORMAT cut down for a host that runs no Drover: compose's labels and those under prefix (default the
 * configured one) only, the last health check with its output cut to 240 characters, no mounts. A key is tested for the
 * prefix by its length and its first characters (Go templates have no prefix test; slice past the end would fail).
 */
export function remoteInspectFormat(prefix = dockerConfig().prefix) {
  if (!PREFIX_RE.test(prefix)) throw new Error(`${JSON.stringify(String(prefix)).slice(0, 80)} is not a label prefix`);
  const head = `${prefix}.`;
  const keep = `{{json $k}}:{{json $v}},`;
  return INSPECT_FORMAT
    .replace('"labels":{{json .Config.Labels}}', `"labels":{ {{- range $k, $v := .Config.Labels}}{{if or ${KEEP_LABELS.map((k) => `(eq $k ${JSON.stringify(k)})`).join(' ')}}}${keep}{{else if ge (len $k) ${head.length}}}{{if eq (slice $k 0 ${head.length}) ${JSON.stringify(head)}}}${keep}{{end}}{{end}}{{end}}"_":""}`)
    .replace('"health":{{if .State.Health}}{{json .State.Health}}{{else}}null{{end}}', '"health":{{if .State.Health}}{"Status":{{json .State.Health.Status}},"FailingStreak":{{json .State.Health.FailingStreak}},"Log":[{{$l := ""}}{{range .State.Health.Log}}{{$l = .}}{{end}}{{if $l}}{"ExitCode":{{json $l.ExitCode}},"End":{{json $l.End}},"Output":{{json (truncate $l.Output 240)}}}{{end}}]}{{else}}null{{end}}')
    .replace('"mounts":{{json .Mounts}}', '"mounts":[]');
}

/** The shell script remoteStacks runs on a host that runs no Drover (`sh -c <script> sh <project> git|nogit`). */
export function remoteScript(prefix = dockerConfig().prefix) {
  return [
    'p=$1; g=$2',
    `T=${shq(remoteInspectFormat(prefix))}`,
    `v=$(docker version --format '{{.Server.Version}}' 2>/dev/null) || { printf '${REMOTE_NO_DOCKER}\\t%s\\n' "$(docker version 2>&1 | grep -im1 -e 'cannot connect' -e 'permission denied' -e 'not found')"; exit 0; }`,
    `printf '${REMOTE_VERSION}\\t%s\\n' "$v"`,
    `if [ -n "$p" ]; then ids=$(docker ps -aq --no-trunc --filter "label=${L.project}=$p"); else ids=$(docker ps -aq --no-trunc); fi`,
    '[ -n "$ids" ] || exit 0',
    'docker container inspect --format "$T" $ids',
    `docker container inspect --format '{{index .Config.Labels "${L.configFiles}"}},{{index .Config.Labels "${L.envFiles}"}}' $ids | tr ',' '\\n' | sort -u | while read -r f; do [ -n "$f" ] || continue; printf '${REMOTE_FILE}\\t%s\\t%s\\n' "$f" "$([ -e "$f" ] && echo 1 || echo 0)"; done`,
    '[ "$g" = nogit ] && exit 0',
    `docker container inspect --format '{{index .Config.Labels "${L.workingDir}"}}' $ids | sort -u | while read -r d; do [ -n "$d" ] && [ -d "$d" ] || continue; printf '${REMOTE_GIT}\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$d" "$(git -C "$d" rev-parse --show-toplevel 2>/dev/null)" "$(git -C "$d" symbolic-ref -q --short HEAD 2>/dev/null)" "$(git -C "$d" rev-parse -q --verify HEAD 2>/dev/null)" "$(git -C "$d" log -1 --format=%ct 2>/dev/null)" "$(GIT_OPTIONAL_LOCKS=0 git -c core.fsmonitor=false -C "$d" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"; done`,
  ].join('\n');
}

/** The output of remoteScript -> { containers, bad, git: Map(working dir -> facts), files: Map(path -> exists), noDocker, version }. */
export function parseRemoteOutput(text, { config = dockerConfig() } = {}) {
  const lines = String(text ?? '').split('\n');
  const git = new Map(), files = new Map(); let noDocker = null, version = null;
  for (const l of lines) {
    if (l.startsWith(`${REMOTE_FILE}\t`)) { const [, f, e] = l.split('\t'); if (f) files.set(f, e === '1'); continue; }
    if (l.startsWith(`${REMOTE_VERSION}\t`)) { const v = l.slice(REMOTE_VERSION.length + 1).trim(); version = VERSION_RE.test(v) ? v : null; }
    if (l.startsWith(`${REMOTE_NO_DOCKER}\t`)) noDocker = oneLine(l.slice(REMOTE_NO_DOCKER.length + 1), 200) || 'no docker daemon is answering on that host';
    if (!l.startsWith(`${REMOTE_GIT}\t`)) continue;
    const [, dir, top, branch, head, ct, dirty] = l.split('\t');
    const sha = SHA_RE.test(head ?? '') ? head : null;
    git.set(dir, { toplevel: top || null, branch: branch || null, detached: Boolean(head) && !branch, head: sha, short: sha ? sha.slice(0, 10) : null, committedAt: unixToIso(ct), dirty: /^\d+$/.test(dirty ?? '') ? { changed: Number(dirty), untracked: null } : null });
  }
  return { ...parseInspect(lines.filter((l) => l.startsWith('{')).join('\n'), { config }), git, files, noDocker, version };
}

/**
 * docker.stacks for a host that runs no Drover, read by running remoteScript there through exec(argv, { timeoutMs })
 * -> { code, stdout } (a host provider's own transport, core/plugins.js dockerStacks): stacks and health in full, a
 * lighter code line; project and git as docker.stacks takes them. host names the host in the answer, via the transport.
 * The answer is readOnly: there is no Drover there to read logs or carry out a verb.
 */
export async function remoteStacks(exec, { host, via = 'its host provider' } = {}, { project, git: withGit = true } = {}) {
  const t0 = _deps.now();
  const only = given(project) ? assertProject(project) : '';
  const code = withGit !== false && withGit !== 'false';
  const config = dockerConfig();
  const r = await exec(['sh', '-c', remoteScript(config.prefix), 'sh', only, code ? 'git' : 'nogit'], { timeoutMs: 90_000 });
  const p = parseRemoteOutput(r.stdout, { config });
  const done = (body) => ({ host, ts: new Date(_deps.now()).toISOString(), ms: _deps.now() - t0, via, readOnly: true, ...body });
  if (p.noDocker) return done(unavailableAnswer({ reason: p.noDocker }));
  if (r.code !== 0 && !p.containers.length) throw new Error(`docker on ${host} did not answer through ${via} (exit ${r.code}): ${clip(cleanText(firstLine(r.stdout)), 200)}`);
  const built = buildStacks(p.containers, { config });
  for (const s of built.filter((x) => !x.loose)) {
    // Whether a compose file exists is a fact of that host's disk, not of this one's.
    s.configFiles = s.configFiles.map((f) => ({ path: f.path, exists: p.files.has(f.path) ? p.files.get(f.path) : null }));
    if (!code) continue;
    const g = s.workingDir ? p.git.get(s.workingDir) : null;
    const values = [...commitsOf(s.services, (c) => p.containers.find((x) => x.id.startsWith(c.id)), config.commitKey).keys()];
    const commits = values.map((value) => ({ value, matches: sameCommit(g?.head, value) }));
    s.code = {
      dir: s.workingDir ? { path: s.workingDir, exists: p.git.has(s.workingDir) ? true : null, git: g?.toplevel ? g : null } : null, sources: [], source: g?.head ? { toplevel: g.toplevel, head: g.head, short: g.short } : null,
      commitLabel: commits.length ? { key: config.commitKey, head: g?.short ?? null, matches: commits.every((c) => c.matches), values: commits } : null,
      notes: [`read through ${via}: this host runs no Drover, so bind-mount repos, ahead/behind and image ages are not read`],
    };
  }
  return done({ docker: { available: true, version: p.version }, totals: totalsOf(built), stacks: built, notes: p.bad ? [`${p.bad} lines were not readable`] : [] });
}

/** Tests: forget the docker CLI found and the image metadata kept. */
export function _reset() { found = null; imageMemo.clear(); }

// ---------------------------------------------------------------- ops (spread into core/api.js `local`; docker.fleet is a front op there)
// An op name in the docker family that is not one of these is a verb Drover never offers (down, rm, kill, build, ...).
export const NOT_OFFERED = 'docker ops are docker.stacks, docker.fleet, docker.logs, docker.restart, docker.start, docker.exec and docker.run; down, rm, rmi, prune, kill, stop, build, pull, scale and volume or network changes are never offered';

export const ops = {
  'docker.stacks': (a = {}) => stacks(a ?? {}),
  'docker.logs': (a = {}) => logs(a ?? {}),
  'docker.restart': (a = {}) => restart(a ?? {}),
  'docker.start': (a = {}) => start(a ?? {}),
  'docker.exec': (a = {}) => exec(a ?? {}),
  'docker.run': (a = {}) => runJob(a ?? {}),
};

// Descriptions and schemas in core/ops-meta.js shape, for the parent to merge into META.
const S = (props, required = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const str = (d) => ({ type: 'string', description: d });
const num = (d) => ({ type: 'number', description: d });
const bool = (d) => ({ type: 'boolean', description: d });
const names = (d) => ({ type: 'array', items: { type: 'string' }, description: d });
const projectArg = str('compose project name, as docker.stacks lists it (only projects discovered on that host are accepted)');
const actorArg = str('who is acting (default the owner; MCP tools send mcp)');
const ABOUT_STACKS = 'Per stack: verdict (ok, starting, degraded, down), container counts by state (healthy, up = running with no healthcheck, unhealthy, starting, restarting, completed = a one-shot job that exited 0, failed, stopped, created, paused, dead), services by kind with the failing ones named (kinds from the DROVER_DOCKER_KINDS rules on service names, first match wins, the rest infra; null where no rule matches a service), and the code line: the working dir\'s git state (toplevel, branch or detached HEAD, sha and subject, dirty files, ahead/behind its upstream, else DROVER_DOCKER_BASE, else origin/HEAD, worktree and its main repo), the repos behind bind mounts when they differ, which services run straight from the work tree, the labels under the label prefix (DROVER_DOCKER_LABEL_PREFIX, default drover) with <prefix>.commit checked against HEAD (code.commitLabel), compose files (and whether they exist), published ports, and built images older than HEAD. Container environments are never read; labels, health output and commit subjects are redacted.';
export const META = {
  'docker.stacks': { m: false, d: `Docker on one machine: every compose project and the containers outside one. ${ABOUT_STACKS} A machine without docker or a daemon answers docker.available false with the reason. Cached 30 s; fresh=true forces.`, s: S({ project: str('only this compose project'), git: bool('read the git state of each stack\'s code (default true; false is cheaper)'), fresh: bool('bypass the 30 s cache') }) },
  'docker.fleet': { m: false, d: `docker.stacks on every reachable machine at once (local plus the hosts up at the last probe, or the hosts named; a host a plugin provides only when named, and one of those that runs no Drover is read through its plugin: readOnly, health in full, a lighter code line, no logs or verbs), each host's answer cached 30 s, a host that cannot answer now shown with its last answer and the error. totals sum the fleet; coverage.notCovered names the hosts not seen. Each stack comes as a summary (counts, kinds, failing services with why, the code line; serviceCount instead of the service list) unless services=true; docker.stacks on one host has every service. ${ABOUT_STACKS}`, s: S({ hosts: names('subset of hosts; default local plus every host up at the last probe'), project: str('only this compose project'), git: bool('read the git state of the code (default true)'), services: bool('also every service with its containers (large: a fleet runs to half a megabyte; default false gives counts, kinds, failing services and the code line; drill into one host with docker.stacks)'), fresh: bool('bypass the per-host cache') }) },
  'docker.logs': { m: false, d: 'The last lines of one service\'s container in a compose project on a machine: stdout and stderr merged in time order, escapes stripped, secrets redacted, at most 256 KB; never cached. tail (default 200, max 2000), since (10m, 1h30m, unix seconds or an RFC 3339 time), timestamps to keep docker\'s, index for one container of a scaled service.', s: S({ project: projectArg, service: str('compose service name'), tail: num('lines from the end, default 200, max 2000'), since: str('only lines after this: a duration such as 10m, unix seconds or an RFC 3339 time'), timestamps: bool('prefix each line with docker\'s timestamp'), index: num('container number of a scaled service (default: the running one)') }, ['project', 'service']) },
  'docker.restart': { m: true, d: 'Restart services of a compose project on a machine (docker restart of their containers, 10 s stop timeout each). The project and services must be ones docker.stacks finds there. Returns each container\'s state before and after; recorded in the truth file.', s: S({ project: projectArg, services: names('compose service names (up to 40)'), actor: actorArg }, ['project', 'services']) },
  'docker.start': { m: true, d: 'Start services of a compose project on a machine whose containers exited (or were never started): a crashed or stopped service, or a one-shot job to run again. A running service is refused (use docker.restart). Recorded in the truth file.', s: S({ project: projectArg, services: names('compose service names (up to 40)'), actor: actorArg }, ['project', 'services']) },
  'docker.exec': { m: true, d: 'Run an argv in the running container of one service of a compose project on a machine (docker exec: no TTY, no stdin, the container\'s own user and working dir). argv is an array of strings, never a shell string (use ["sh", "-c", "..."] for one inside the container). timeoutMs default 30 s, max 110 s; stdout and stderr capped at 64 KB each and redacted. Recorded in the truth file with the argv redacted.', s: S({ project: projectArg, service: str('compose service name'), argv: names('command argv, e.g. ["node", "-v"]'), timeoutMs: num('stop waiting after this many ms (default 30000, max 110000)'), index: num('container number of a scaled service (default: the running one)'), actor: actorArg }, ['project', 'service', 'argv']) },
  'docker.run': { m: true, d: 'Run a one-off job from a service\'s own definition in a compose project on a machine, such as migrations: docker compose run --rm -T --no-deps --pull never with the project\'s compose files, which must still be on disk, and an image already on the host (nothing is built or pulled, no dependency is started). argv, optional, replaces the service\'s command. timeoutMs default 60 s, max 110 s; output capped at 64 KB per stream and redacted. Recorded in the truth file.', s: S({ project: projectArg, service: str('compose service name'), argv: names('command argv replacing the service\'s command (optional)'), timeoutMs: num('stop waiting after this many ms (default 60000, max 110000)'), actor: actorArg }, ['project', 'service']) },
};
