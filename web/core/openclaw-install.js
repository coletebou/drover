// Hermetic install of the OpenClaw manager gateway. web/openclaw-manager/ is the source, plus an optional
// private overlay: `drover manager setup --role <role>` installs or refreshes the manager on this host
// (launchd on a Mac, a systemd user unit on Linux) and writes the manifest that core/openclaw.js reads for its paths.
//
// The code here knows nothing about any one identity or box. What a manager is lives in data:
//   profiles/<p>.json   what the gateway talks to: its config template, where each secret comes from,
//                       extra (non-secret) environment, the template values, and the egress allowlist the check enforces
//   roles/<r>/          what a manager does: role.json (profile, heartbeat prompt, duties such as the
//                       digest with the tools and automations each brings), AGENTS.md (standing orders),
//                       MEMORY.md (seed); the orders, prompt and seed are templates filled per install
//   workspace/          the other seeds (workspace/<profile>/ for one profile's own)
// The overlay (DROVER_OPENCLAW_OVERLAY, or --overlay) is a directory laid out the same way: a profiles/, roles/ or
// workspace/ file there (and the config template a profile names) is read instead of this checkout's at the same
// path, and a profile or role only it has is added. The data of one person's fleet lives there, outside the repo;
// the manifest keeps the overlay, so later runs and the console's checks read the same files.
// What one install covers is its scope, given to setup and kept in its manifest: hosts (local: this
// host; all: every host it reaches, minus exclude), the duties it owns (digest) and its WAL actor. Every
// manager runs the same role; only the scope differs, so two never sweep the same host.
// A box with no manager never runs any of this; a new kind of manager (another identity, another
// machine) is a new profile and role, not a code change.
//
// Where each piece lands:
//   npm/package-lock.json   npm ci into ~/.local/share/drover/openclaw/<version>-<lock sha>/ (one tree per
//                           lockfile, so an install never rewrites the tree a running gateway loaded)
//   config template + role  ~/.openclaw-manager/openclaw.json: {{TOKENS}} filled for this host and role, the
//                           keys OpenClaw writes itself carried over, written only when the content changes
//   roles/<r>/AGENTS.md     the workspace's standing orders (every run); MEMORY.md and workspace/ seed once
//   bin/ro                  ~/.openclaw-manager/bin/ro, the one executable the manager's exec may run
//   exec-approvals.json     imported once by openclaw doctor; later runs fix the stored allowlist in place
//   systemd/ unit, or a launchd plist rendered here; both run the generated bin/run-gateway, which carries
//   the pinned node, the OpenClaw tree, the secrets, the profile's env and every egress off-switch.
//   bin/oc is the same environment for running the manager's CLI by hand.
// What stays host-only: ~/.openclaw-manager/.env (the profile's secrets, 0600, created once from the
// sources the profile names, never printed), the state databases, sessions, memory and digests.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile, rename, chmod, copyFile, rm, symlink } from 'node:fs/promises';
import os, { hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run as runProc, tryRun as tryRunProc } from './proc.js';
import { envvar } from './envvars.js';
import { OWNER, OWNER_NAME } from './owner.js';

export const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'openclaw-manager');
export const SCHEMA = 1;
export const PORT = 18789;
/** How long the gateway gets to close on SIGTERM before SIGKILL: the plist's ExitTimeOut (the unit's TimeoutStopSec too). */
export const STOP_TIMEOUT_SEC = 330;
/** Every phone-home switch from the design (section 3); the gateway and the CLI always run with these. */
export const EGRESS_ENV = {
  OPENCLAW_DISABLE_BONJOUR: '1', OPENCLAW_SKIP_CHANNELS: '1', OPENCLAW_OFFLINE: '1', OPENCLAW_NO_AUTO_UPDATE: '1',
  OPENCLAW_EXEC_SHELL_SNAPSHOT: '0', DO_NOT_TRACK: '1', CLAWHUB_DISABLE_TELEMETRY: '1',
};
/** Config subtrees OpenClaw writes itself (doctor, migrations): kept from the live file, never rendered. */
export const OPENCLAW_OWNED = [['meta'], ['wizard'], ['agents', 'entries']];
const MARKER = '.drover-openclaw';
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

/** The installed gateway's loopback port: the manifest's (a profile may move it off 18789, e.g. where another OpenClaw holds it), else the default. */
export function gatewayPort(lay = layout()) {
  try { const p = JSON.parse(readFileSync(lay.manifest, 'utf8'))?.gateway?.port; return Number.isInteger(p) ? p : PORT; } catch { return PORT; }
}

/** Where everything lives on this host. OPENCLAW_MANAGER_STATE_DIR and DROVER_SHARE move it (tests). */
export function layout({ home = process.env.HOME ?? os.homedir(), platform = _deps.platform(), env = process.env } = {}) {
  const state = env.OPENCLAW_MANAGER_STATE_DIR ?? path.join(home, '.openclaw-manager');
  const bin = path.join(state, 'bin');
  return {
    home, platform, state, bin,
    launcher: path.join(bin, 'run-gateway'), oc: path.join(bin, 'oc'), ro: path.join(bin, 'ro'),
    env: path.join(state, '.env'), config: path.join(state, 'openclaw.json'), workspace: path.join(state, 'workspace'),
    manifest: path.join(state, 'drover-install.json'), approvalsFile: path.join(state, 'exec-approvals.json'),
    log: path.join(home, '.local', 'state', 'logs', 'openclaw-manager.log'),
    installs: path.join(envvar('SHARE', env) ?? path.join(home, '.local', 'share', 'drover'), 'openclaw'),
    droverBin: path.join(home, '.local', 'bin', 'drover'),
    host: (envvar('HOST', env) ?? hostname()).split('.')[0],
    service: platform === 'darwin'
      ? { kind: 'launchd', name: 'dev.drover.manager', file: path.join(home, 'Library', 'LaunchAgents', 'dev.drover.manager.plist') }
      : { kind: 'systemd', name: 'openclaw-manager', file: path.join(home, '.config', 'systemd', 'user', 'openclaw-manager.service') },
  };
}

/** A path as OpenClaw's allowlist writes it: under $HOME as ~/... */
export const tildePath = (lay, p) => (p.startsWith(lay.home + path.sep) ? `~${p.slice(lay.home.length)}` : p);
const expandHome = (home, p) => (p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : p);

/** Installs from before this installer: reported, never deleted (nothing the new install uses lives there). */
export function legacyPaths(lay) {
  return [path.join(lay.home, 'code', 'openclaw-manager-poc'), path.join(lay.home, '.local', 'share', 'openclaw-manager'), path.join(lay.home, '.local', 'state', 'logs', 'drover-manager.log')];
}

// ---------------------------------------------------------------- sources: this checkout, then the overlay
/**
 * The overlay DROVER_OPENCLAW_OVERLAY names (a leading ~/ is this HOME): undefined when it is unset, so the
 * caller falls back to the manifest's; null when it is '' or 'none', an install without one.
 */
export function overlayFromEnv(env = process.env) {
  const v = envvar('OPENCLAW_OVERLAY', env);
  return v === undefined ? undefined : overlayPath(v, env);
}
const overlayPath = (v, env = process.env) => { const s = String(v ?? '').trim(); return s && s !== 'none' ? path.resolve(expandHome(env.HOME ?? os.homedir(), s)) : null; };

/**
 * The overlay an install uses: the one given (--overlay; 'none' for none), else DROVER_OPENCLAW_OVERLAY, else the
 * manifest's, so a later run from a shell without the variable, and the daemon's checks, read what the install did.
 */
export function resolveOverlay(given, { manifest = null, env = process.env } = {}) {
  if (given !== undefined && given !== null) return overlayPath(given, env);
  const fromEnv = overlayFromEnv(env);
  return fromEnv !== undefined ? fromEnv : (typeof manifest?.overlay === 'string' && manifest.overlay ? manifest.overlay : null);
}
const envOverlay = () => resolveOverlay(undefined);
const dirsOf = (src, overlay) => (overlay ? [overlay, src] : [src]);
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

/** rel (a path inside web/openclaw-manager) from the overlay when it has that file, else from src; null when neither has it. */
export function sourceFile(rel, { src = SRC, overlay = null } = {}) {
  for (const d of dirsOf(src, overlay)) { const p = path.join(d, rel); if (existsSync(p)) return p; }
  return null;
}
/** Whether a file sourceFile found came from the overlay. */
export const fromOverlay = (file, overlay) => Boolean(overlay && file && file.startsWith(overlay + path.sep));
const entries = (src, overlay, sub) => [...new Set(dirsOf(src, overlay).flatMap((d) => { try { return readdirSync(path.join(d, sub)); } catch { return []; } }))].sort();

/** The roles this checkout and the overlay define: [{ name, summary, profile, from }]. */
export function listRoles(src = SRC, overlay = envOverlay()) {
  return entries(src, overlay, 'roles').map((n) => [n, sourceFile(path.join('roles', n, 'role.json'), { src, overlay })]).filter(([, f]) => f).map(([n, f]) => {
    const r = JSON.parse(readFileSync(f, 'utf8'));
    return { name: n, summary: r.summary ?? '', profile: r.profile, from: fromOverlay(f, overlay) ? 'overlay' : 'repo' };
  });
}

/** The profiles this checkout and the overlay define: [{ name, summary, port, from }]. */
export function listProfiles(src = SRC, overlay = envOverlay()) {
  return entries(src, overlay, 'profiles').filter((n) => /^[a-z0-9-]+\.json$/.test(n)).map((n) => {
    const f = sourceFile(path.join('profiles', n), { src, overlay });
    // A listing names a broken profile instead of failing: loadProfile reports what is wrong with it when it is used.
    let p; try { p = JSON.parse(readFileSync(f, 'utf8')); } catch (e) { p = { summary: `unreadable: ${e.message}` }; }
    return { name: n.slice(0, -5), summary: p.summary ?? '', port: p.port ?? PORT, from: fromOverlay(f, overlay) ? 'overlay' : 'repo' };
  });
}

export function loadProfile(name, src = SRC, overlay = envOverlay()) {
  if (typeof name !== 'string' || !/^[a-z0-9-]+$/.test(name)) throw new Error(`bad profile name ${JSON.stringify(name)}`);
  const file = sourceFile(path.join('profiles', `${name}.json`), { src, overlay });
  if (!file) throw new Error(`no profile ${name} (profiles/${name}.json in ${dirsOf(src, overlay).reverse().join(' or ')}); profiles here: ${listProfiles(src, overlay).map((p) => p.name).join(', ') || 'none'}`);
  const p = JSON.parse(readFileSync(file, 'utf8'));
  const secrets = p.secrets ?? {};
  if (!secrets.OPENCLAW_GATEWAY_TOKEN) throw new Error(`profile ${name}: secrets must include OPENCLAW_GATEWAY_TOKEN (the gateway's loopback bearer)`);
  for (const [k, s] of Object.entries(secrets)) {
    if (!ENV_NAME.test(k)) throw new Error(`profile ${name}: bad secret name ${k}`);
    if (!s?.generate && typeof s?.from !== 'string') throw new Error(`profile ${name}: secret ${k} needs "from" (a file holding it) or "generate": true`);
    if (s.basicAuth && !(Array.isArray(s.basicAuth) && s.basicAuth.length === 2 && s.basicAuth.every((n) => ENV_NAME.test(n)) && /\{\}/.test(s.format ?? ''))) throw new Error(`profile ${name}: secret ${k} basicAuth needs [userName, secretName] and a format with {}`);
  }
  for (const k of Object.keys(p.env ?? {})) if (!ENV_NAME.test(k)) throw new Error(`profile ${name}: bad env name ${k}`);
  const port = p.port ?? PORT;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`profile ${name}: port must be an integer in 1024-65535, not ${JSON.stringify(p.port)}`);
  for (const k of Object.keys(p.vars ?? {})) if (!/^[A-Z_]+$/.test(k)) throw new Error(`profile ${name}: bad template var ${k}`);
  // Role flags: lowercase on/off switches the role files read as {{#flag}}...{{/flag}} sections, for what differs
  // between one fleet's managers and another's (which forge holds the owner's merge requests, say).
  const flags = p.flags ?? {};
  if (typeof flags !== 'object' || Array.isArray(flags)) throw new Error(`profile ${name}: flags must be an object of name: true|false`);
  for (const [k, v] of Object.entries(flags)) {
    if (!/^[a-z]+$/.test(k)) throw new Error(`profile ${name}: bad flag ${k} (lowercase letters only)`);
    if (typeof v !== 'boolean') throw new Error(`profile ${name}: flag ${k} must be true or false`);
  }
  // Template tokens the profile fills ({{PORT}}, {{OTEL_ENDPOINT}}, {{CLIPROXY_API_KEY}}): what differs between one fleet's boxes and another's.
  const vars = { ...(p.vars ?? {}), PORT: port };
  const configRel = p.config ?? 'openclaw.json';
  return { name, file, summary: p.summary ?? '', config: sourceFile(configRel, { src, overlay }) ?? path.join(src, configRel), env: p.env ?? {}, secrets, egress: p.egress ?? { allow: [] }, port, vars, flags };
}

export function loadRole(name, src = SRC, overlay = envOverlay()) {
  const known = listRoles(src, overlay);
  if (!known.some((r) => r.name === name)) throw new Error(`unknown role ${JSON.stringify(name)}; ${overlay ? 'this checkout and its overlay define' : 'this checkout defines'}: ${known.map((r) => `${r.name} (${r.summary})`).join('; ') || 'none'}`);
  // Each file on its own: the overlay may replace the orders and keep this checkout's role.json, or the reverse.
  const file = (f) => sourceFile(path.join('roles', name, f), { src, overlay });
  const json = file('role.json'); const dir = path.dirname(json);
  const role = JSON.parse(readFileSync(json, 'utf8'));
  for (const k of ['profile', 'heartbeatPrompt']) if (typeof role[k] !== 'string' || !role[k]) throw new Error(`roles/${name}/role.json has no ${k}`);
  const level = (v, where) => { if (v != null && !THINK_LEVELS.includes(v)) throw new Error(`roles/${name}/role.json ${where} must be one of ${THINK_LEVELS.join(', ')}, not ${JSON.stringify(v)}`); };
  level(role.heartbeatThinking, 'heartbeatThinking');
  for (const [d, x] of Object.entries(role.duties ?? {})) for (const a of x.automations ?? []) level(a.thinking, `duties.${d} automation ${a.name} thinking`);
  return { name, dir, duties: {}, ...role, roleFile: json, agentsFile: file('AGENTS.md') ?? path.join(dir, 'AGENTS.md'), memoryFile: file('MEMORY.md') ?? path.join(dir, 'MEMORY.md') };
}

/**
 * OpenClaw 2026.10.1's thinking levels (normalizeThinkLevel: the /think directive, automations --thinking and a run's
 * override). A run lowers a level its model row does not list to the highest listed one below it: max on a row
 * whose supportedReasoningEfforts stop at xhigh runs at xhigh.
 */
export const THINK_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'adaptive', 'max', 'ultra'];

// ---------------------------------------------------------------- scope
/** Mustache-lite for role files: {{NAME}} values, and {{#flag}}...{{/flag}} or {{^flag}}...{{/flag}} sections kept when the flag is on or off. */
export function renderTemplate(text, vars) {
  let out = String(text);
  for (let i = 0; i < 8; i++) {
    const next = out.replace(/\{\{([#^])([a-z]+)\}\}([\s\S]*?)\{\{\/\2\}\}/g, (_, kind, name, body) => ((kind === '#') === Boolean(vars[name]) ? body : ''));
    if (next === out) break;
    out = next;
  }
  return out.replace(/\{\{([A-Z_]+)\}\}/g, (m, n) => { if (!(n in vars)) throw new Error(`role template value {{${n}}} has no value`); return String(vars[n]); });
}

const SCOPES = ['local', 'all'];
/** Installs from before scopes had two roles; their manifest maps to the scope each one covered. */
const LEGACY_ROLES = { fleet: { hosts: 'all', exclude: ['macbook'], digest: true }, mac: { hosts: 'local', exclude: [], digest: false } };

/** What a manager covers: flags first, then its manifest, then (an install from before scopes) its old role. */
export function resolveScope({ prev = null, scope, exclude, digest, actor, host }) {
  const was = prev?.scope ?? LEGACY_ROLES[prev?.role] ?? null;
  const hosts = scope ?? was?.hosts;
  if (!hosts) throw new Error('first install on this host: pass --scope local (this host only) or --scope all (every host it reaches; --exclude hosts that run their own manager), and --digest on the one manager that owns the daily digest');
  if (!SCOPES.includes(hosts)) throw new Error(`scope must be ${SCOPES.join(' or ')}, not ${JSON.stringify(hosts)}`);
  const ex = (exclude ?? was?.exclude ?? []).map((h) => String(h).trim()).filter(Boolean);
  for (const h of ex) if (!/^[A-Za-z0-9_.-]{1,80}$/.test(h)) throw new Error(`bad host in --exclude: ${JSON.stringify(h)}`);
  const act = actor ?? prev?.actor ?? `manager-${String(host).toLowerCase().replace(/[^a-z0-9-]+/g, '-')}`;
  if (!/^manager(-[a-z0-9-]+)?$/.test(act)) throw new Error(`actor must be manager or manager-<name>, not ${JSON.stringify(act)}`);
  return { hosts, exclude: hosts === 'all' ? ex : [], digest: Boolean(digest ?? was?.digest ?? false), actor: act };
}

/** The Drover checkout the manager's drover MCP server runs: where ~/.local/bin/drover leads, else the one at src. */
export function droverRepo(lay, src = SRC) {
  try { const real = realpathSync(lay.droverBin); if (real.endsWith(`${path.sep}${path.join('web', 'bin', 'drover')}`)) return path.resolve(real, '..', '..', '..'); } catch { /* not installed, or not a link into a checkout */ }
  return path.resolve(src, '..', '..');
}

/**
 * The role applied to one install: its actor, the filled heartbeat prompt and template values, the tool prefixes
 * of duties it does not own, and the automations it owns or must keep off. The owner (DROVER_OWNER, prose name
 * DROVER_OWNER_NAME) is a template value, so the orders name whoever runs this fleet.
 */
export function roleView(role, sc, host, { repo = path.resolve(SRC, '..', '..'), flags = {} } = {}) {
  const short = sc.hosts === 'local' ? 'this host only' : `every host it reaches${sc.exclude.length ? `, except ${sc.exclude.join(', ')}` : ''}`;
  const vars = {
    ACTOR: sc.actor, HOST: host, SCOPE_SHORT: short, HOME: process.env.HOME ?? os.homedir(), OWNER, OWNER_NAME, DROVER_REPO: repo,
    SCOPE: sc.hosts === 'local' ? `this host only (${host}): call the \`drover_*\` tools with \`host\` omitted and keep only the \`host: local\` entries of \`drover_native_summary\``
      : `every host in \`drover_fleet\` you can reach${sc.exclude.length ? `, except ${sc.exclude.map((h) => `\`${h}\``).join(', ')} (each covers itself)` : ''}`,
    local: sc.hosts === 'local', all: sc.hosts === 'all',
  };
  const duties = Object.entries(role.duties ?? {});
  // The profile's flags; a scope or duty section keeps its meaning (a flag cannot turn the digest on).
  for (const [k, v] of Object.entries(flags)) {
    if (k in vars || duties.some(([d]) => d === k)) throw new Error(`profile flag ${k} clashes with a scope or duty section of the same name`);
    vars[k] = v;
  }
  for (const [d] of duties) vars[d] = Boolean(sc[d]);
  return {
    // The sweep's effort: OpenClaw's heartbeat config has no thinking level (a /think directive does not reach it
    // either: a heartbeat turn's message is a fixed poll), so the launcher passes it to the heartbeat-thinking patch.
    actor: sc.actor, vars, heartbeatPrompt: renderTemplate(role.heartbeatPrompt, vars), heartbeatThinking: role.heartbeatThinking ?? null,
    automations: duties.filter(([d]) => sc[d]).flatMap(([, x]) => x.automations ?? []),
    offAutomations: duties.filter(([d]) => !sc[d]).flatMap(([, x]) => (x.automations ?? []).map((a) => a.name)),
  };
}

/** The pinned OpenClaw from the committed lockfile: version, engines, and the tree's directory name. */
export function lockInfo(src = SRC) {
  const text = readFileSync(path.join(src, 'npm', 'package-lock.json'), 'utf8');
  const pkg = JSON.parse(text).packages?.['node_modules/openclaw'];
  if (!pkg?.version) throw new Error('npm/package-lock.json does not pin openclaw');
  const lockSha256 = createHash('sha256').update(text).digest('hex');
  // Patches to the pinned OpenClaw (npm/patches.json) are part of a tree's identity: a changed patch builds a new tree.
  const pfile = path.join(src, 'npm', 'patches.json');
  const ptext = existsSync(pfile) ? readFileSync(pfile, 'utf8') : null;
  const patches = ptext ? JSON.parse(ptext) : [];
  for (const p of patches) for (const k of ['name', 'file', 'find', 'replace']) if (typeof p?.[k] !== 'string' || !p[k]) throw new Error(`npm/patches.json: every patch needs ${k}`);
  const patchSha256 = patches.length ? createHash('sha256').update(ptext).digest('hex') : null;
  return { version: pkg.version, engines: pkg.engines?.node ?? null, lockSha256, patches, patchSha256, dirName: `${pkg.version}-${lockSha256.slice(0, 12)}${patchSha256 ? `-p${patchSha256.slice(0, 8)}` : ''}` };
}

/**
 * Apply npm/patches.json to a fresh OpenClaw package: each patch has exactly one site, in exactly one file matching
 * its glob, or the install fails, so a new OpenClaw version never silently loses a patch. A site is the anchor, or
 * a replacement made earlier (a re-run changes nothing), so a second anchor beside a patched one fails too.
 */
export async function applyPatches(pkgDir, patches, version) {
  const count = (t, s) => t.split(s).length - 1;
  for (const p of patches) {
    const dir = path.join(pkgDir, path.dirname(p.file));
    const re = new RegExp(`^${path.basename(p.file).split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    const inReplace = count(p.replace, p.find);   // a patched site still holds the anchor when the replacement does
    const sites = [];
    for (const n of readdirSync(dir).filter((x) => re.test(x))) { const t = await readFile(path.join(dir, n), 'utf8'); const done = count(t, p.replace); const todo = count(t, p.find) - done * inReplace; if (done || todo) sites.push({ n, t, done, todo }); }
    const done = sites.reduce((s, x) => s + x.done, 0); const todo = sites.reduce((s, x) => s + x.todo, 0);
    if (sites.length !== 1 || done + todo !== 1) throw new Error(`patch ${p.name} does not apply to openclaw ${version}: its anchor occurs ${todo} times${done ? ` (and ${done} patched)` : ''} in ${sites.length} files matching ${p.file}; update npm/patches.json for this version`);
    if (todo) await writeFile(path.join(dir, sites[0].n), sites[0].t.replace(p.find, () => p.replace));
  }
}

// ---------------------------------------------------------------- node
const parseV = (v) => String(v).trim().replace(/^v/, '').split('.').map((x) => Number.parseInt(x, 10) || 0);
const cmpV = (a, b) => { for (let i = 0; i < 3; i++) { const d = (a[i] ?? 0) - (b[i] ?? 0); if (d) return Math.sign(d); } return 0; };

/** npm-style range check for the subset engines fields use: >=, <=, >, <, =, spaces (and), || (or). */
export function satisfies(version, range) {
  if (!range) return true;
  const v = parseV(version);
  return String(range).split('||').some((alt) => {
    const parts = alt.trim().split(/\s+/).filter(Boolean);
    return parts.length > 0 && parts.every((c) => {
      const m = c.match(/^(>=|<=|>|<|=)?v?(\d+(?:\.\d+){0,2})$/);
      if (!m) return false;
      const d = cmpV(v, parseV(m[2]));
      return { '>=': d >= 0, '<=': d <= 0, '>': d > 0, '<': d < 0, '=': d === 0 }[m[1] ?? '='];
    });
  });
}

/** fnm-installed nodes plus the one running this code: [{ path, version }]. */
export function nodeCandidates({ home = process.env.HOME, running = _deps.runningNode() } = {}) {
  const out = [];
  const root = path.join(home, '.local', 'share', 'fnm', 'node-versions');
  let dirs = [];
  try { dirs = readdirSync(root); } catch { /* no fnm */ }
  for (const d of dirs) {
    const p = path.join(root, d, 'installation', 'bin', 'node');
    if (/^v\d+\.\d+\.\d+$/.test(d) && existsSync(p)) out.push({ path: p, version: d });
  }
  if (running?.path && !out.some((c) => c.path === running.path)) out.push(running);
  return out;
}

/** The newest candidate inside OpenClaw's engines range, or null. */
export function pickNode(range, candidates) {
  return candidates.filter((c) => satisfies(c.version, range)).sort((a, b) => cmpV(parseV(b.version), parseV(a.version)))[0] ?? null;
}

// ---------------------------------------------------------------- config
const TOKEN = /^\{\{([A-Z_]+)\}\}$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const getPath = (o, p) => p.reduce((x, k) => (isObj(x) ? x[k] : undefined), o);
const setPath = (o, p, v) => { let x = o; for (const k of p.slice(0, -1)) { if (!isObj(x[k])) x[k] = {}; x = x[k]; } x[p.at(-1)] = v; };

/** Replace whole-string {{NAME}} tokens (never substrings: OpenClaw owns ${...} for its env refs). */
export function fillTokens(value, vars) {
  if (typeof value === 'string') {
    const m = value.match(TOKEN);
    if (!m) return value;
    if (!(m[1] in vars)) throw new Error(`config template token {{${m[1]}}} has no value`);
    return vars[m[1]];
  }
  if (Array.isArray(value)) return value.map((v) => fillTokens(v, vars));
  if (isObj(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillTokens(v, vars)]));
  return value;
}

/** The gateway config for this host and role: the template with its tokens filled and the OpenClaw-owned keys from the live file. Pure. */
export function renderConfig({ template, role, vars, live = null }) {
  const c = fillTokens(structuredClone(template), { ACTOR: role.actor, HEARTBEAT_PROMPT: role.heartbeatPrompt, ...vars });
  if (live) for (const p of OPENCLAW_OWNED) { const v = getPath(live, p); if (v !== undefined && getPath(c, p) === undefined) setPath(c, p, structuredClone(v)); }
  return c;
}

/** The config this install would write for a manifest's role, scope and overlay, or null when the role or template is gone. */
export function expectedConfig({ manifest, live, lay = layout(), src = SRC, overlay = resolveOverlay(undefined, { manifest }) }) {
  try {
    const role = loadRole(LEGACY_ROLES[manifest.role] ? 'manager' : manifest.role, src, overlay); const profile = loadProfile(manifest.profile ?? role.profile, src, overlay);
    const template = JSON.parse(readFileSync(profile.config, 'utf8'));
    const view = roleView(role, resolveScope({ prev: manifest, host: lay.host }), lay.host, { repo: droverRepo(lay, src), flags: profile.flags });
    return renderConfig({ template, role: view, vars: { ...profile.vars, NODE: manifest.node.path, DROVER_BIN: lay.droverBin, HOME: lay.home }, live });
  } catch { return null; }
}

/** JSON with sorted keys, for comparing configs by content rather than by formatting. */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

/** Dotted paths where b differs from a (arrays compare whole), minus the OpenClaw-owned subtrees. */
export function diffPaths(a, b, prefix = [], out = []) {
  if (OPENCLAW_OWNED.some((p) => p.length === prefix.length && p.every((k, i) => k === prefix[i]))) return out;
  if (isObj(a) && isObj(b)) {
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) diffPaths(a[k], b[k], [...prefix, k], out);
  } else if (canonical(a) !== canonical(b)) out.push(prefix.join('.') || '(root)');
  return out;
}

// ---------------------------------------------------------------- generated files
export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Homebrew's bin (Apple Silicon /opt/homebrew, an untarred ~/homebrew, Linuxbrew): ro's rg, fd, tmux and jq live there.
const brewBins = (lay) => (lay.platform === 'darwin' ? ['/opt/homebrew/bin', path.join(lay.home, 'homebrew', 'bin')] : ['/home/linuxbrew/.linuxbrew/bin']);
// The manager's own bin first: its exec allowlist admits only bin/ro, and OpenClaw matches a command the model runs by
// bare name (`ro cat ...`) through PATH, so without this every `ro` was an allowlist miss (all 7 on the Mac, 2026-10-20).
const searchPath = (lay, node) => [lay.bin, path.dirname(node), path.join(lay.home, '.local', 'bin'), path.join(lay.home, '.bun', 'bin'), path.join(lay.home, '.cargo', 'bin'), ...brewBins(lay), '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');

/**
 * The environment block both wrappers share. They first re-run themselves under `env -i` with an
 * allowlist: an interactive shell (or a supervisor) may export other providers' keys, OPENAI_API_KEY and
 * the like, and bash passes every inherited export on to OpenClaw, which would activate those providers.
 * The user's session bus is kept (XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS): `ro systemctl --user` needs it.
 * Then: the secrets, the isolated state dir, the profile's env, every egress switch, the pinned node first
 * on PATH. Bash 3.2 (macOS /bin/bash) compatible.
 */
function envBlock(lay, node, profile, self, extraEnv = {}) {
  const extra = Object.entries(profile.env ?? {}).map(([k, v]) => `${k}=${shq(v)}`);
  const lines = [
    'if [ -z "${DROVER_MANAGER_CLEAN_ENV:-}" ]; then',
    `  keep=(DROVER_MANAGER_CLEAN_ENV=1 ${shq(`HOME=${lay.home}`)} "LANG=\${LANG:-en_US.UTF-8}")`,
    '  for v in USER LOGNAME TMPDIR TERM SSH_AUTH_SOCK XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS; do if [ -n "${!v:-}" ]; then keep+=("$v=${!v}"); fi; done',
    `  exec /usr/bin/env -i "\${keep[@]}" /bin/bash ${shq(self)} "$@"`,
    'fi',
    'unset keep v DROVER_MANAGER_CLEAN_ENV',
    `set -a; . ${shq(lay.env)}; set +a`,
    `export HOME=${shq(lay.home)} LANG="\${LANG:-en_US.UTF-8}"${extra.length ? ` ${extra.join(' ')}` : ''}`,
    `export OPENCLAW_STATE_DIR=${shq(lay.state)} OPENCLAW_CONFIG_PATH=${shq(lay.config)} OPENCLAW_WORKSPACE_DIR=${shq(lay.workspace)}`,
    `export ${Object.entries(EGRESS_ENV).map(([k, v]) => `${k}=${v}`).join(' ')}`,
    `export PATH=${shq(searchPath(lay, node))}`,
    ...Object.entries(extraEnv).filter(([, v]) => v != null && v !== '').map(([k, v]) => `export ${k}=${shq(v)}`),
  ];
  if (lay.platform !== 'darwin') lines.push('if [ -f /etc/ssl/certs/ca-certificates.crt ]; then export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt; fi');
  return lines.join('\n');
}

/** The gateway launcher. heartbeatThinking: the sweep's effort, read by the heartbeat-thinking patch (npm/patches.json). */
export function renderLauncher(lay, { node, mjs }, profile, { heartbeatThinking = null } = {}) {
  return `#!/bin/bash
# Generated by \`drover manager setup\` (drover web/core/openclaw-install.js); re-run it instead of editing.
# The manager gateway: the pinned node and OpenClaw tree, the secrets from .env, the isolated state dir,
# the profile's environment and every egress off-switch. ${lay.service.kind === 'launchd' ? `launchd (${lay.service.name})` : `systemd (${lay.service.name}.service)`} runs this.
set -euo pipefail
${envBlock(lay, node, profile, lay.launcher, { OPENCLAW_HEARTBEAT_THINKING: heartbeatThinking })}
exec ${shq(node)} ${shq(mjs)} gateway --port ${profile.port ?? PORT}
`;
}

/** The sweep's effort a rendered launcher passes the patch, or null: the sweep then runs at the chat default. */
export const launcherHeartbeatThinking = (text) => /^export OPENCLAW_HEARTBEAT_THINKING='([a-z]+)'$/m.exec(text ?? '')?.[1] ?? null;

export function renderOc(lay, { node, mjs }, profile) {
  return `#!/bin/bash
# Generated by \`drover manager setup\`; re-run it instead of editing. The manager's OpenClaw CLI with the
# gateway's own environment, e.g.  oc health --json  |  oc automations list  |  oc gateway auth-token --show
set -euo pipefail
${envBlock(lay, node, profile, lay.oc)}
exec ${shq(node)} ${shq(mjs)} "$@"
`;
}

export function renderPlist(lay) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(lay.service.name)}</string>
  <!-- OpenClaw manager gateway; installed by drover manager setup (web/core/openclaw-install.js), re-run it instead of editing -->
  <key>ProgramArguments</key><array><string>${xml(lay.launcher)}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <!-- OpenClaw closes its SQLite state cleanly on SIGTERM; give it the ${STOP_TIMEOUT_SEC} s the systemd unit gives before SIGKILL -->
  <key>ExitTimeOut</key><integer>${STOP_TIMEOUT_SEC}</integer>
  <key>WorkingDirectory</key><string>${xml(lay.home)}</string>
  <key>StandardOutPath</key><string>${xml(lay.log)}</string>
  <key>StandardErrorPath</key><string>${xml(lay.log)}</string>
</dict>
</plist>
`;
}

/** The exec approvals to import on a first install: the repo's policy (full exec, no prompts), no allowlist. */
export function renderApprovals(base) {
  const c = structuredClone(base);
  for (const a of Object.values(c.agents ?? {})) delete a.allowlist;
  return JSON.stringify(c, null, 2) + '\n';
}

/** The policy fields fixApprovals keeps the stored approvals at. */
const POLICY_KEYS = ['security', 'ask', 'askFallback', 'autoAllowSkills'];
/** Where the stored approvals differ from the repo's policy: ['defaults.security', 'main.ask', ...]. Pure. */
export function approvalsDrift(stored, want) {
  const out = [];
  for (const k of POLICY_KEYS) if (stored?.defaults?.[k] !== want.defaults?.[k]) out.push(`defaults.${k}`);
  for (const [id, a] of Object.entries(want.agents ?? {})) for (const k of POLICY_KEYS) if (stored?.agents?.[id]?.[k] !== a[k]) out.push(`${id}.${k}`);
  return out;
}

// ---------------------------------------------------------------- secrets (names only, values never printed)
/** KEY=value lines (optional `export `, optional quotes) -> { KEY: value }. */
export function parseEnvFile(text) {
  const out = {};
  for (const raw of String(text).split('\n')) {
    const m = raw.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/** One .env line that the wrappers' `.` and parseEnvFile read the same way: plain values bare, anything else single-quoted. */
export function envLine(name, v) {
  if (/[\n\r']/.test(v)) throw new Error(`${name}: a value with a newline or a single quote cannot be written to the manager's .env (the launcher sources it); write that line by hand`);
  return /^[A-Za-z0-9_./+=:@%,-]*$/.test(v) ? `${name}=${v}` : `${name}='${v}'`;
}

/**
 * One profile secret's value from its source, or null: a `from` file's NAME= line, or with basicAuth a
 * header built from two names in that file (format "...{}" around base64("user:secret")).
 */
export function secretValue(name, spec, { home, read }) {
  const src = parseEnvFile(read(expandHome(home, spec.from)) ?? '');
  if (!spec.basicAuth) return src[name] || null;
  const [u, p] = spec.basicAuth.map((n) => src[n]);
  return u && p ? spec.format.replace('{}', Buffer.from(`${u}:${p}`).toString('base64')) : null;
}

/** A first install's .env: each profile secret from its source or freshly generated; an optional one whose source lacks it is left out. read(path) returns the file text or null. */
export function newEnvFile(profile, { home, read, random = (n) => randomBytes(n) }) {
  const lines = [];
  for (const [name, s] of Object.entries(profile.secrets)) {
    if (s.generate) { lines.push(envLine(name, random(30).toString('base64url').slice(0, 40))); continue; }
    const v = secretValue(name, s, { home, read });
    if (!v && s.optional) continue;
    if (!v) throw new Error(`${name} not found in ${s.from} (profile ${profile.name}); add it there, or write ${name}= into the manager's .env by hand`);
    lines.push(envLine(name, v));
  }
  return lines.join('\n') + '\n';
}

/** Problems with an .env by name: missing or empty secrets, and names that would widen what OpenClaw can reach. */
export function envProblems(text, profile) {
  const env = parseEnvFile(text);
  const missing = Object.entries(profile.secrets).filter(([n, s]) => !s.optional && !env[n]).map(([n]) => n);
  const unexpected = Object.keys(env).filter((n) => !(n in profile.secrets));
  return { missing, unexpected };
}

// ---------------------------------------------------------------- running OpenClaw's CLI
const SYSTEM_CA = '/etc/ssl/certs/ca-certificates.crt';

/**
 * The environment OpenClaw's CLI is spawned with: nothing inherited from the caller (a Drover daemon has
 * loaded ~/.env_secrets, whose provider keys would activate providers the manager must not have), the
 * isolated state dir, every egress switch, the profile's env, and the secrets asked for: 'token' (the
 * gateway bearer; gateway calls fail without it in the environment), 'all' or 'none'. OpenClaw also reads
 * its own $OPENCLAW_STATE_DIR/.env at startup (documented, never overriding), so a CLI process can hold
 * the manager's own secrets either way; what this keeps out is everything else.
 */
export function cliEnv(lay, node, { secrets = 'token', profile = null, base = process.env } = {}) {
  const env = {
    HOME: lay.home, PATH: searchPath(lay, node), LANG: base.LANG ?? 'en_US.UTF-8', ...(profile?.env ?? {}),
    OPENCLAW_STATE_DIR: lay.state, OPENCLAW_CONFIG_PATH: lay.config, OPENCLAW_WORKSPACE_DIR: lay.workspace, ...EGRESS_ENV,
  };
  for (const k of ['USER', 'LOGNAME', 'TMPDIR']) if (base[k]) env[k] = base[k];
  if (lay.platform !== 'darwin' && existsSync(SYSTEM_CA)) env.NODE_EXTRA_CA_CERTS = SYSTEM_CA;
  if (secrets === 'none') return env;
  let file = {};
  try { file = parseEnvFile(readFileSync(lay.env, 'utf8')); } catch { /* no secrets yet */ }
  const wanted = secrets === 'all' ? Object.keys(file).filter((k) => !profile || k in profile.secrets) : ['OPENCLAW_GATEWAY_TOKEN'];
  for (const k of wanted) if (file[k]) env[k] = file[k];
  return env;
}

/** npm ci's environment: no secrets (install scripts run with it), plus whatever this network needs to reach the registry. */
export function npmEnv(lay, node, base = process.env) {
  const env = { ...cliEnv(lay, node, { secrets: 'none', base }), npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' };
  for (const [k, v] of Object.entries(base)) if (/^(https?_proxy|no_proxy|all_proxy|ssl_cert_file|ssl_cert_dir|node_extra_ca_certs)$/i.test(k) || /^npm_config_(registry|cafile|ca|strict_ssl|proxy|https_proxy|noproxy)$/i.test(k)) env[k] = v;
  return env;
}

/** OpenClaw prints {"ok":false,"error":{...}} on stdout when a gateway call fails; that text, else stderr, is the error. */
export function cliError(r, argv) {
  let msg = null;
  const s = String(r.stdout ?? '').trim(); const i = s.indexOf('{');
  if (i >= 0) { try { const j = JSON.parse(s.slice(i)); msg = j?.error?.message ?? (typeof j?.error === 'string' ? j.error : null); } catch { /* not JSON */ } }
  if (!msg) msg = String(r.stderr ?? '').trim().split('\n').filter(Boolean).slice(-3).join(' | ');
  return `openclaw ${argv.slice(0, 2).join(' ')} exited ${r.code}${msg ? `: ${msg.slice(0, 300)}` : ''}`;
}

/** Parse the JSON document a --json command printed (some commands print a banner line first). */
export function parseCliJson(stdout) {
  const s = String(stdout ?? '').trim(); const i = s.search(/[{[]/);
  return JSON.parse(i >= 0 ? s.slice(i) : s);
}

// ---------------------------------------------------------------- manifest
export function readManifest(lay = layout()) {
  try { const m = JSON.parse(readFileSync(lay.manifest, 'utf8')); return m?.schema === SCHEMA ? m : null; } catch { return null; }
}

/** node + openclaw.mjs for this host: the manifest's, else a pre-manifest install found on disk. */
export function runtimeFor(lay = layout(), manifest = readManifest(lay), env = process.env) {
  if (manifest?.openclaw?.mjs && manifest?.node?.path) return { node: manifest.node.path, mjs: manifest.openclaw.mjs, from: 'manifest' };
  const mjs = env.OPENCLAW_MJS ?? [
    path.join(lay.home, '.local', 'share', 'openclaw-manager', 'npm', 'node_modules', 'openclaw', 'openclaw.mjs'),
    path.join(lay.home, 'code', 'openclaw-manager-poc', 'npm', 'node_modules', 'openclaw', 'openclaw.mjs'),
  ].find((p) => existsSync(p));
  if (!mjs) return null;
  let range = null;
  try { range = JSON.parse(readFileSync(path.join(path.dirname(mjs), 'package.json'), 'utf8')).engines?.node ?? null; } catch { /* unreadable */ }
  const node = env.OPENCLAW_NODE ?? pickNode(range, nodeCandidates({ home: lay.home }))?.path;
  return node ? { node, mjs, from: 'legacy' } : null;
}

// ---------------------------------------------------------------- plugin peer links
/**
 * OpenClaw installs plugins outside its own tree, into <state>/extensions/<plugin>/ or as npm projects
 * under <state>/npm/projects/<project>/node_modules/<package>/, and links each one's node_modules/openclaw
 * to the tree that installed it; a plugin whose link points at another tree is "configured-unavailable"
 * (missing-openclaw-peer-link). [{ plugin, link, target, ok }] for this tree. A bounded walk that never
 * follows a symlinked directory.
 */
export function peerLinks(lay, mjs) {
  const want = path.dirname(mjs);
  const out = [];
  const walk = (dir, depth, name) => {
    let entries = []; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((x, y) => x.name.localeCompare(y.name))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth > 0) walk(p, depth - 1, name);
      else if (e.isSymbolicLink() && e.name === 'openclaw' && path.basename(dir) === 'node_modules') {
        let target; try { target = readlinkSync(p); } catch { continue; }
        out.push({ plugin: name(p), link: p, target, ok: path.resolve(dir, target) === want });
      }
    }
  };
  const ext = path.join(lay.state, 'extensions');
  walk(ext, 3, (link) => path.relative(ext, link).split(path.sep)[0]);
  // npm/projects/<project>/node_modules/[@scope/]<package>/node_modules/openclaw: named by its package
  const proj = path.join(lay.state, 'npm', 'projects');
  walk(proj, 6, (link) => { const r = path.relative(proj, link).split(path.sep); return r[2]?.startsWith('@') ? `${r[2]}/${r[3]}` : r[2] ?? r[0]; });
  return out;
}

/** Point every stale peer link at this tree (atomically; run it with the gateway stopped). openclaw doctor --fix does the same repair but also fetches plugins it considers missing. */
async function relink(links, mjs) {
  for (const l of links.filter((x) => !x.ok)) {
    const tmp = `${l.link}.tmp-${process.pid}`;
    await rm(tmp, { force: true });
    await symlink(path.dirname(mjs), tmp);
    await rename(tmp, l.link);
  }
}

// ---------------------------------------------------------------- the service
export const _deps = {
  run: (file, argv, opts) => runProc(file, argv, opts),
  tryRun: (file, argv, opts) => tryRunProc(file, argv, opts),
  uid: () => process.getuid?.() ?? 0,
  platform: () => process.platform,
  runningNode: () => ({ path: process.execPath, version: process.version }),
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  alive: async (timeoutMs = 2000, port = gatewayPort()) => {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    try { await fetch(`http://127.0.0.1:${port}/`, { signal: ctl.signal }); return true; } catch { return false; } finally { clearTimeout(t); }
  },
};

/** "[[dd-]hh:]mm:ss" from ps -o etime= -> seconds. */
export function parseEtime(s) {
  const m = String(s).trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  return m ? ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3])) * 60 + Number(m[4]) : null;
}

/** `launchctl print gui/<uid>/<label>` -> the fields the status card shows. */
export function parseLaunchctlPrint(text) {
  const get = (re) => String(text).match(re)?.[1] ?? null;
  const runs = Number(get(/^\s*runs = (\d+)/m));
  const exit = String(text).match(/^\s*last exit code = (-?\d+)(?::\s*(.+))?$/m);
  return { state: get(/^\s*state = (\S+)/m), pid: Number(get(/^\s*pid = (\d+)/m)) || null, runs: Number.isFinite(runs) ? runs : null, lastExitCode: exit ? Number(exit[1]) : null, lastExitReason: exit?.[2]?.trim() ?? null };
}

/**
 * The supervisor's view of the gateway, the same shape for launchd and systemd. `active` is
 * systemd's vocabulary (active, inactive, failed, ...), so a running LaunchAgent reads "active".
 */
export async function serviceState(lay = layout(), { now = _deps.now() } = {}) {
  const svc = lay.service;
  const base = { kind: svc.kind, name: svc.name, file: svc.file, installed: existsSync(svc.file) };
  if (svc.kind === 'launchd') {
    const r = await _deps.tryRun('launchctl', ['print', `gui/${_deps.uid()}/${svc.name}`], { timeoutMs: 5000 });
    if (r.code !== 0) return { ...base, loaded: false, active: 'inactive', state: 'not loaded', since: null, uptimeSec: null, pid: null, restarts: 0, lastExitCode: null, lastExitReason: null };
    const p = parseLaunchctlPrint(r.stdout);
    let uptimeSec = null;
    if (p.pid) { const e = await _deps.tryRun('ps', ['-o', 'etime=', '-p', String(p.pid)], { timeoutMs: 5000 }); uptimeSec = e.code === 0 ? parseEtime(e.stdout) : null; }
    return { ...base, loaded: true, active: p.state === 'running' ? 'active' : p.state ?? 'unknown', state: p.state, since: uptimeSec != null ? new Date(now - uptimeSec * 1000).toISOString() : null, uptimeSec, pid: p.pid, restarts: p.runs ? p.runs - 1 : 0, lastExitCode: p.lastExitCode, lastExitReason: p.lastExitReason };
  }
  const [act, show] = await Promise.all([
    _deps.tryRun('systemctl', ['--user', 'is-active', svc.name], { timeoutMs: 5000 }),
    _deps.tryRun('systemctl', ['--user', 'show', svc.name, '-p', 'ActiveEnterTimestamp', '-p', 'MainPID', '-p', 'NRestarts', '-p', 'ExecMainStatus', '-p', 'LoadState', '-p', 'SubState'], { timeoutMs: 5000 }),
  ]);
  const kv = Object.fromEntries(String(show.stdout ?? '').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  const since = kv.ActiveEnterTimestamp ? Date.parse(kv.ActiveEnterTimestamp) : NaN;
  const active = (act.stdout ?? '').trim() || 'unknown';
  const up = active === 'active' && Number.isFinite(since);
  return {
    ...base, loaded: kv.LoadState === 'loaded', active, state: kv.SubState || null,
    since: up ? new Date(since).toISOString() : null, uptimeSec: up ? Math.round((now - since) / 1000) : null,
    pid: Number(kv.MainPID) || null, restarts: Number(kv.NRestarts ?? 0) || 0, lastExitCode: kv.ExecMainStatus ? Number(kv.ExecMainStatus) : null, lastExitReason: null,
  };
}

// ---------------------------------------------------------------- setup
async function readText(p) { try { return await readFile(p, 'utf8'); } catch { return null; } }
const sha = (s) => createHash('sha256').update(s).digest('hex');

/** Write only when the content differs, atomically; back up a file a person may have edited. Returns 'created' | 'updated' | 'unchanged' (or 'would ...' in a dry run). */
async function put(file, text, { mode = 0o644, backup = false, dryRun = false, stamp } = {}) {
  const old = await readText(file);
  if (old === text) { if (!dryRun) await chmod(file, mode).catch(() => {}); return 'unchanged'; }
  if (dryRun) return old == null ? 'would create' : 'would update';
  await mkdir(path.dirname(file), { recursive: true });
  if (backup && old != null) await writeFile(`${file}.bak-${stamp}`, old, { mode });
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, text, { mode });
  await chmod(tmp, mode);
  await rename(tmp, file);
  return old == null ? 'created' : 'updated';
}

async function npmCi({ lay, lock, node, src, dir }) {
  const tmp = `${dir}.tmp-${process.pid}`;
  // A run killed mid-install (a timeout on a thrashing box) leaves its half-written tree behind under its own pid.
  for (const n of readdirSync(path.dirname(dir))) if (n.startsWith(`${path.basename(dir)}.tmp-`)) await rm(path.join(path.dirname(dir), n), { recursive: true, force: true });
  await mkdir(tmp, { recursive: true, mode: 0o700 });
  for (const f of ['package.json', 'package-lock.json']) await copyFile(path.join(src, 'npm', f), path.join(tmp, f));
  // The npm that ships with the chosen node, with that node first on PATH (npm-cli.js is `#!/usr/bin/env node`).
  await _deps.run(path.join(path.dirname(node), 'npm'), ['ci', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: tmp, env: npmEnv(lay, node), timeoutMs: 30 * 60_000 });
  const got = JSON.parse(await readFile(path.join(tmp, 'node_modules', 'openclaw', 'package.json'), 'utf8')).version;
  if (got !== lock.version) throw new Error(`npm ci installed openclaw ${got}, the lockfile pins ${lock.version}`);
  await applyPatches(path.join(tmp, 'node_modules', 'openclaw'), lock.patches ?? [], lock.version);
  await writeFile(path.join(tmp, MARKER), JSON.stringify({ version: lock.version, lockSha256: lock.lockSha256, patches: (lock.patches ?? []).map((p) => p.name), patchSha256: lock.patchSha256 ?? null, node, installedAt: new Date(_deps.now()).toISOString() }) + '\n');
  await rename(tmp, dir);
}

/** git facts about the checkout this code runs from (recorded in the manifest), or nulls outside a checkout. */
async function sourceInfo(src) {
  const root = path.join(src, '..', '..');
  const [head, dirty] = await Promise.all([
    _deps.tryRun('git', ['-C', root, 'rev-parse', '--short=12', 'HEAD'], { timeoutMs: 5000 }),
    _deps.tryRun('git', ['--no-optional-locks', '-C', root, 'status', '--porcelain', '--', 'web/openclaw-manager', 'web/core/openclaw-install.js'], { timeoutMs: 5000 }),
  ]);
  return { repo: root, commit: head.code === 0 ? head.stdout.trim() : null, dirty: dirty.code === 0 ? dirty.stdout.trim().length > 0 : null };
}

function oc(lay, rt, args, { secrets = 'token', profile = null, timeoutMs = 120_000, input } = {}) {
  return _deps.tryRun(rt.node, [rt.mjs, ...args], { env: cliEnv(lay, rt.node, { secrets, profile }), cwd: lay.home, timeoutMs, ...(input !== undefined ? { input } : {}) });
}

async function ocJson(lay, rt, args, opts) {
  const r = await oc(lay, rt, [...args, '--json'], opts);
  if (r.code !== 0) throw new Error(cliError(r, args));
  return parseCliJson(r.stdout);
}

/** Keep the stored exec approvals at the repo's policy (full exec, ask off): installs from the read-only era move to it here. */
async function fixApprovals(lay, rt, { src, dryRun, step }) {
  const want = JSON.parse(renderApprovals(JSON.parse(await readFile(path.join(src, 'exec-approvals.json'), 'utf8'))));
  // A gateway that just started answers HTTP before it serves RPCs (reads time out, mutations are refused): retry for a while.
  let snap, err;
  for (let i = 0; i < 18 && !snap; i++) { try { snap = await ocJson(lay, rt, ['approvals', 'get']); } catch (e) { err = e; await _deps.sleep(10_000); } }
  if (!snap) { step('approvals', 'error', err.message); return; }
  const drift = approvalsDrift(snap.file, want);
  if (!drift.length) { step('approvals', 'unchanged', `exec ${want.agents?.main?.security ?? want.defaults.security}, ask ${want.defaults.ask}`); return; }
  if (dryRun) { step('approvals', 'would update', drift.join(', ')); return; }
  let r;
  for (let i = 0; i < 18; i++) { r = await oc(lay, rt, ['approvals', 'set', '--stdin'], { input: JSON.stringify(want) }); if (r.code === 0) break; await _deps.sleep(10_000); }
  if (r.code !== 0) throw new Error(cliError(r, ['approvals', 'set']));
  const left = approvalsDrift((await ocJson(lay, rt, ['approvals', 'get']))?.file, want);
  if (left.length) throw new Error(`exec approvals still differ after the fix: ${left.join(', ')}`);
  step('approvals', 'updated', drift.join(', '));
}

/**
 * First install: write the approvals file, let doctor import it (and materialize the heartbeat monitor),
 * then drop the file (a second copy is a legacy file that blocks every agent tool). Never on an install
 * setup made before (fixApprovals keeps its allowlist right), and never because a read failed: a busy
 * gateway can fail `approvals get`, and that is not the same as nothing stored.
 */
async function importApprovals(lay, rt, { src, profile, dryRun, step, prev }) {
  if (prev) return false;
  const hasDb = existsSync(path.join(lay.state, 'state'));
  let snap = null, err = null;
  for (let i = 0; i < (hasDb ? 18 : 1) && !snap; i++) { try { snap = await ocJson(lay, rt, ['approvals', 'get']); } catch (e) { err = e; if (hasDb) await _deps.sleep(10_000); } }
  if (!snap && hasDb) throw new Error(`could not read the stored exec approvals, so none were imported over this install: ${err?.message ?? 'no answer'}`);
  if (snap?.exists === true) return false;
  if (dryRun) { step('approvals', 'would import', 'exec-approvals.json via openclaw doctor --fix'); return true; }
  await writeFile(lay.approvalsFile, renderApprovals(JSON.parse(await readFile(path.join(src, 'exec-approvals.json'), 'utf8'))), { mode: 0o600 });
  await oc(lay, rt, ['doctor', '--fix', '--yes', '--non-interactive'], { secrets: 'all', profile, timeoutMs: 600_000 }); // warns about the loopback-only bind by design
  const after = await ocJson(lay, rt, ['approvals', 'get']).catch(() => null);
  await rm(lay.approvalsFile, { force: true });
  if (after?.exists !== true) throw new Error(`exec approvals were not imported (run ${lay.oc} doctor --fix and read its output)`);
  step('approvals', 'imported', 'exec-approvals.json via openclaw doctor --fix');
  return true;
}

/**
 * A restart aborts the turn in flight: wait (bounded) until no automation (the heartbeat included) is
 * running. A list that cannot be read is not an idle one: it is waited on like a running heartbeat.
 */
async function waitIdle(lay, rt, { waitIdleSec, step }) {
  const start = _deps.now(); let waitedFor = null; let unread = false;
  for (;;) {
    const jobs = (await ocJson(lay, rt, ['automations', 'list', '--timeout', '60000']).catch(() => null))?.jobs;
    const busy = Array.isArray(jobs) ? jobs.filter((j) => j.status === 'running').map((j) => j.displayName ?? j.name ?? j.id) : null;
    const secs = Math.round((_deps.now() - start) / 1000);
    if (busy?.length === 0) {
      if (waitedFor || unread) step('service', 'waited', `${secs} s for ${waitedFor ? `${waitedFor.join(', ')} to finish` : 'the automation list to answer'}`);
      return true;
    }
    if (busy) waitedFor ??= busy; else unread = true;
    if (secs >= waitIdleSec) { step('service', 'still busy', `${busy ? `${busy.join(', ')} still running` : 'the automation list did not answer'} after ${secs} s; restarting anyway`); return false; }
    await _deps.sleep(10_000);
  }
}

/**
 * Restart when what the service runs differs from what it would start now. `was` is what the last
 * restart by setup started (launcher, service file and secrets hashes, its tree, and when); `now` is what
 * this run would start. A launcher or service file this run had to rewrite also counts when the service
 * was restarted since setup did (a crash restart re-reads whatever file was there, hand edits included).
 */
export function restartReasons({ was, now, active, since, rewritten, stalePlugins = [] }) {
  if (active !== 'active') return [`was ${active}`];
  if (!was) return ['not started by drover manager setup yet'];
  const out = [];
  if (stalePlugins.length) out.push(`plugin peer links point at another OpenClaw tree (${stalePlugins.join(', ')})`);
  if (was.launcher !== now.launcher) out.push('launcher changed');
  if (was.unit !== now.unit) out.push('service file changed');
  if (was.env && now.env && was.env !== now.env) out.push('secrets changed (the gateway reads .env only at start)');
  if (!out.length && rewritten?.length && since && Date.parse(since) > Date.parse(was.at) + 5000) out.push(`restarted outside setup while its ${rewritten.join(' and ')} differed`);
  return out;
}

async function applyService(lay, { was, now, rewritten, restart, dryRun, step, rt, waitIdleSec }) {
  const svc = lay.service; const st = await serviceState(lay);
  const links = peerLinks(lay, rt.mjs); const stale = links.filter((l) => !l.ok);
  const reasons = restartReasons({ was, now, active: st.active, since: st.since, rewritten, stalePlugins: stale.map((l) => l.plugin) });
  const why = restart === 'always' ? 'asked for' : reasons.join(', ') || null;
  if (!why) { step('service', 'unchanged', `${svc.name} ${st.active}`); return false; }
  if (restart === 'never') { step('service', 'not restarted', `--restart never; due at the next run (${why})`); return false; }
  if (dryRun) { step('service', 'would restart', why); if (stale.length) step('plugin links', 'would relink', `${stale.map((l) => l.plugin).join(', ')} -> ${path.dirname(rt.mjs)}`); return true; }
  if (st.active === 'active' && rt && existsSync(rt.mjs) && await _deps.alive()) await waitIdle(lay, rt, { waitIdleSec, step });
  // A service file this run put back counts too: the supervisor may hold a hand edit it already loaded.
  const unitChanged = !was || was.unit !== now.unit || Boolean(rewritten?.includes('service file'));
  // Stop, relink with nothing holding the old tree, start: a plain restart would come up with those plugins unavailable.
  const swap = async () => { if (stale.length) { await relink(stale, rt.mjs); step('plugin links', 'relinked', `${stale.map((l) => l.plugin).join(', ')} -> ${path.dirname(rt.mjs)}`); } };
  if (svc.kind === 'launchd') {
    const target = `gui/${_deps.uid()}`;
    if (unitChanged || !st.loaded || stale.length) {
      await _deps.tryRun('launchctl', ['bootout', `${target}/${svc.name}`], { timeoutMs: 360_000 });
      // bootout returns at once; the job stays listed until the gateway has closed (40 s on a loaded Mac, SIGKILL at
      // ExitTimeOut), and a bootstrap before that fails with "5: Input/output error", leaving the manager unloaded.
      // A print that hangs (a loaded Mac) says nothing about the job: only a print that ends and fails means gone.
      const gone = async () => { const r = await _deps.tryRun('launchctl', ['print', `${target}/${svc.name}`], { timeoutMs: 5000 }); return r.code !== 0 && !/timed out after/.test(r.stderr ?? ''); };
      // A deadline in wall time: a hung print takes its whole 5 s, which a count of sleeps would not see.
      const waitMs = (STOP_TIMEOUT_SEC + 30) * 1000; const deadline = _deps.now() + waitMs;
      let left = await gone();
      while (!left && _deps.now() < deadline) { await _deps.sleep(500); left = await gone(); }
      if (!left) throw new Error(`${svc.name} was still loaded ${waitMs / 1000} s after launchctl bootout; nothing was started (launchctl print ${target}/${svc.name})`);
      await swap();
      await _deps.run('launchctl', ['bootstrap', target, svc.file], { timeoutMs: 30_000 });
    } else await _deps.run('launchctl', ['kickstart', '-k', `${target}/${svc.name}`], { timeoutMs: 360_000 });
  } else {
    // Setup reloads when it writes the unit (above); this is for a changed unit an earlier run wrote but did not start.
    if (unitChanged && !rewritten?.includes('service file')) await _deps.run('systemctl', ['--user', 'daemon-reload'], { timeoutMs: 30_000 });
    const en = await _deps.tryRun('systemctl', ['--user', 'is-enabled', svc.name], { timeoutMs: 5000 });
    if ((en.stdout ?? '').trim() !== 'enabled') await _deps.run('systemctl', ['--user', 'enable', svc.name], { timeoutMs: 30_000 });
    if (stale.length) { await _deps.run('systemctl', ['--user', 'stop', svc.name], { timeoutMs: 360_000 }); await swap(); await _deps.run('systemctl', ['--user', 'start', svc.name], { timeoutMs: 360_000 }); }
    else await _deps.run('systemctl', ['--user', 'restart', svc.name], { timeoutMs: 360_000 });
  }
  step('service', 'restarted', why);
  return true;
}

/**
 * Install or refresh the manager on this host. Idempotent: a second run with nothing changed writes
 * nothing and restarts nothing. Returns { role, profile, overlay, actor, scope, dryRun, steps[], manifest }; never prints a secret.
 *   role       a role under web/openclaw-manager/roles or the overlay's (default manager; later runs reuse the manifest's)
 *   profile    a profile under web/openclaw-manager/profiles or the overlay's (default: the role's; later runs reuse the manifest's)
 *   overlay    the private overlay directory, 'none' for none (default: DROVER_OPENCLAW_OVERLAY, else the manifest's)
 *   restart    auto (when the launcher, the service file, the tree or node changed since the service last
 *              started, or it is not running) | always | never (the restart stays pending for a later run)
 *   dryRun     report what would change, change nothing
 *   waitSec    how long to wait for the gateway after a restart (a loaded Mac can take minutes)
 *   waitIdleSec  how long a restart waits for a running heartbeat or automation to finish first
 */
export async function setup({ role: name = 'manager', profile: profileName, overlay: overlayArg, scope, exclude, digest, actor, restart = 'auto', dryRun = false, waitSec = 300, waitIdleSec = 900, node: nodeOverride, src = SRC, log = () => {} } = {}) {
  if (!['auto', 'always', 'never'].includes(restart)) throw new Error('restart must be auto, always or never');
  const lay = layout();
  const prev = readManifest(lay);
  if (prev?.role && prev.role !== name && !LEGACY_ROLES[prev.role]) throw new Error(`this host is installed as role ${prev.role}; run drover manager uninstall first to change roles`);
  // The overlay is part of what an install is: a named one that is not there fails here, before anything is read.
  const overlay = resolveOverlay(overlayArg, { manifest: prev });
  if (overlay && !isDir(overlay)) {
    const by = overlayArg != null ? '--overlay' : overlayFromEnv() !== undefined ? 'DROVER_OPENCLAW_OVERLAY' : 'the install manifest';
    throw new Error(`overlay ${overlay} (from ${by}) is not a directory; pass --overlay none to install without one`);
  }
  const role = loadRole(name, src, overlay);
  const sc = resolveScope({ prev, scope, exclude, digest, actor, host: lay.host });
  // --profile picks what the gateway talks to; later runs keep the manifest's, like the scope.
  const profile = loadProfile(profileName ?? prev?.profile ?? role.profile, src, overlay);
  const view = roleView(role, sc, lay.host, { repo: droverRepo(lay, src), flags: profile.flags });
  // The workspace seeds, each from the overlay when it has one. A profile may carry its own (workspace/<profile>/):
  // what the owner works on differs between one fleet's boxes and another's.
  const seed = (f) => sourceFile(path.join('workspace', profile.name, f), { src, overlay }) ?? sourceFile(path.join('workspace', f), { src, overlay });
  const seeds = [['SOUL.md', seed('SOUL.md')], ['USER.md', seed('USER.md')], ['IDENTITY.md', sourceFile(path.join('workspace', 'IDENTITY.md'), { src, overlay })], ['MEMORY.md', role.memoryFile]];
  const lock = lockInfo(src);
  const nodeAbs = nodeOverride ? path.resolve(nodeOverride) : null;
  const node = nodeAbs ? { path: nodeAbs, version: (await _deps.run(nodeAbs, ['-v'], { timeoutMs: 10_000 })).stdout.trim() } : pickNode(lock.engines, nodeCandidates({ home: lay.home }));
  if (!node || !satisfies(node.version, lock.engines)) throw new Error(`no node in ${lock.engines} (have: ${nodeCandidates({ home: lay.home }).map((c) => c.version).join(', ') || 'none'}); fnm install 24`);
  if (!existsSync(lay.droverBin)) throw new Error(`${lay.droverBin} is missing (link it to a Drover checkout's web/bin/drover; the manager's drover MCP server runs it)`);
  const stamp = new Date(_deps.now()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const steps = [];
  const step = (s, action, detail) => { steps.push({ step: s, action, ...(detail ? { detail } : {}) }); log(`${s}: ${action}${detail ? ` (${detail})` : ''}`); };

  // 0. Which files the overlay supplies (names only), so a run shows where its profile, orders and seeds came from.
  if (overlay) {
    const used = [role.roleFile, role.agentsFile, role.memoryFile, profile.file, profile.config, ...seeds.map(([, f]) => f)].filter((f) => fromOverlay(f, overlay) && existsSync(f));
    step('overlay', used.length ? 'used' : 'unused', `${overlay}${used.length ? `: ${[...new Set(used)].map((f) => path.relative(overlay, f)).join(', ')}` : ''}`);
  }

  // 1. The OpenClaw tree for this lockfile.
  const dir = path.join(lay.installs, lock.dirName);
  const rt = { node: node.path, mjs: path.join(dir, 'node_modules', 'openclaw', 'openclaw.mjs') };
  if (existsSync(path.join(dir, MARKER))) step('openclaw', 'unchanged', `${lock.version} in ${dir}`);
  else if (dryRun) step('openclaw', 'would install', `${lock.version} (npm ci, lock ${lock.lockSha256.slice(0, 12)}) into ${dir}`);
  else { await mkdir(lay.installs, { recursive: true, mode: 0o700 }); await npmCi({ lay, lock, node: node.path, src, dir }); step('openclaw', 'installed', `${lock.version} with node ${node.version} into ${dir}`); }

  // 2. State dir and secrets.
  if (!dryRun) { for (const d of [lay.state, lay.bin, path.join(lay.workspace, 'memory', 'state'), path.dirname(lay.log)]) await mkdir(d, { recursive: true }); await chmod(lay.state, 0o700); }
  const envText = await readText(lay.env);
  if (envText == null) {
    if (dryRun) step('secrets', 'would create', `${lay.env} (${Object.keys(profile.secrets).join(', ')}; 0600)`);
    else {
      await put(lay.env, newEnvFile(profile, { home: lay.home, read: (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } } }), { mode: 0o600 });
      step('secrets', 'created', `${lay.env} (${Object.keys(profile.secrets).length} names, 0600)`);
    }
  } else {
    const { missing, unexpected } = envProblems(envText, profile);
    if (missing.length || unexpected.length) throw new Error(`${lay.env}: ${[missing.length ? `missing ${missing.join(', ')}` : '', unexpected.length ? `unexpected ${unexpected.join(', ')} (profile ${profile.name} allows ${Object.keys(profile.secrets).join(', ')})` : ''].filter(Boolean).join('; ')}`);
    // An optional secret the profile can now derive (a trace header whose keys reached ~/.env_secrets) is added once.
    const have = parseEnvFile(envText);
    const read = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
    const add = Object.entries(profile.secrets).filter(([n, s]) => s.optional && !have[n]).map(([n, s]) => [n, secretValue(n, s, { home: lay.home, read })]).filter(([, v]) => v);
    if (add.length) {
      const r = await put(lay.env, `${envText.replace(/\n?$/, '\n')}${add.map(([n, v]) => envLine(n, v)).join('\n')}\n`, { mode: 0o600, backup: true, dryRun, stamp });
      step('secrets', r === 'updated' ? 'added' : r, add.map(([n]) => n).join(', '));
    } else {
      if (!dryRun) await chmod(lay.env, 0o600);
      step('secrets', 'unchanged', `${Object.keys(have).length} names present`);
    }
  }

  // 3. Gateway config (OpenClaw hot-reloads most keys, so a config change alone restarts nothing).
  const template = JSON.parse(await readFile(profile.config, 'utf8'));
  const liveText = await readText(lay.config);
  let live = null;
  try { live = liveText ? JSON.parse(liveText) : null; } catch { throw new Error(`${lay.config} is not valid JSON; fix or move it, then re-run`); }
  const config = renderConfig({ template, role: view, vars: { ...profile.vars, NODE: node.path, DROVER_BIN: lay.droverBin, HOME: lay.home }, live });
  if (live && canonical(live) === canonical(config)) step('config', 'unchanged', lay.config);
  else {
    const paths = live ? diffPaths(live, config) : [];
    const r = await put(lay.config, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, backup: true, dryRun, stamp });
    step('config', r, live ? `${paths.length} path${paths.length === 1 ? '' : 's'}: ${paths.slice(0, 12).join(', ')}${paths.length > 12 ? ', ...' : ''}` : lay.config);
  }

  // 4. Workspace: standing orders every run, seeds once (they are the manager's own memory afterwards).
  step('AGENTS.md', await put(path.join(lay.workspace, 'AGENTS.md'), renderTemplate(await readFile(role.agentsFile, 'utf8'), view.vars), { backup: true, dryRun, stamp }), `${sc.actor}: ${view.vars.SCOPE_SHORT}${sc.digest ? ', owns the digest' : ''}`);
  for (const [f, from] of seeds) {
    const to = path.join(lay.workspace, f);
    if (existsSync(to) || !from || !existsSync(from)) continue;
    if (!dryRun) await writeFile(to, renderTemplate(await readFile(from, 'utf8'), view.vars));
    step(f, dryRun ? 'would seed' : 'seeded', to);
  }

  // 5. Executables: the ro shim, the launcher the service runs, and oc.
  step('bin/ro', await put(lay.ro, await readFile(path.join(src, 'bin', 'ro'), 'utf8'), { mode: 0o755, dryRun }));
  const launcherText = renderLauncher(lay, rt, profile, { heartbeatThinking: view.heartbeatThinking });
  const launcherR = await put(lay.launcher, launcherText, { mode: 0o700, dryRun });
  step('bin/run-gateway', launcherR);
  step('bin/oc', await put(lay.oc, renderOc(lay, rt, profile), { mode: 0o700, dryRun }));

  // 6. The service definition.
  const svcText = lay.service.kind === 'launchd' ? renderPlist(lay) : await readFile(path.join(src, 'systemd', 'openclaw-manager.service'), 'utf8');
  const svcR = await put(lay.service.file, svcText, { mode: 0o644, dryRun });
  if (svcR !== 'unchanged' && !dryRun && lay.service.kind === 'launchd') await _deps.run('plutil', ['-lint', lay.service.file], { timeoutMs: 10_000 });
  // systemd keeps the unit it loaded until a reload: re-read it whenever setup writes it, restart or not, or an
  // operator's daemon-reload of a hand edit outlives the restore (a later crash restart would run the edit).
  if (svcR !== 'unchanged' && !dryRun && lay.service.kind !== 'launchd') await _deps.run('systemctl', ['--user', 'daemon-reload'], { timeoutMs: 30_000 });
  step('service file', svcR, lay.service.file);
  // What a restart now would start (the launcher pins node and tree, so a new runtime shows up here too);
  // the manifest keeps what the last restart by setup started, so one a --restart never run skipped stays due.
  const startedWith = { launcher: sha(launcherText), unit: sha(svcText), env: sha((await readText(lay.env)) ?? ''), tree: dir };
  const was = prev?.service?.startedWith ?? null;

  // 7. Validate with the CLI that will run it, import approvals on a first install, then (re)start.
  if (!dryRun) {
    const v = await oc(lay, rt, ['config', 'validate'], { secrets: 'all', profile });
    if (v.code !== 0) throw new Error(`openclaw config validate failed: ${cliError(v, ['config', 'validate'])}`);
    step('config validate', 'ok');
  }
  const first = existsSync(rt.mjs) ? await importApprovals(lay, rt, { src, profile, dryRun, step, prev }) : false;
  if (dryRun && !existsSync(rt.mjs)) step('approvals', 'would check', 'after the tree is installed');
  const rewritten = [launcherR !== 'unchanged' && 'launcher', svcR !== 'unchanged' && 'service file'].filter(Boolean);
  const restarted = await applyService(lay, { was, now: startedWith, rewritten, restart, dryRun, step, rt, waitIdleSec });

  // 8. The manifest, before anything waits on the gateway: the status op reads its paths.
  const manifest = {
    schema: SCHEMA, role: name, profile: profile.name, overlay, actor: sc.actor, scope: { hosts: sc.hosts, exclude: sc.exclude, digest: sc.digest },
    installedAt: prev?.installedAt ?? new Date(_deps.now()).toISOString(),
    refreshedAt: new Date(_deps.now()).toISOString(), source: await sourceInfo(src),
    openclaw: { version: lock.version, lockSha256: lock.lockSha256, dir, mjs: rt.mjs }, node: { path: node.path, version: node.version },
    gateway: { port: profile.port },
    service: { ...lay.service, startedWith: restarted ? { ...startedWith, at: new Date(_deps.now()).toISOString() } : was ?? null },
    log: lay.log, state: lay.state,
  };
  if (!dryRun) await put(lay.manifest, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });

  // 9. Gateway up, then what needs it: the stored allowlist and the role's automations.
  if (!dryRun) {
    let up = await _deps.alive(2000, profile.port);
    for (let t = 0; !up && t < waitSec; t += 3) { await _deps.sleep(3000); up = await _deps.alive(2000, profile.port); }
    if (!up) step('gateway', 'not answering', `nothing on 127.0.0.1:${profile.port} after ${waitSec} s; read ${lay.log}`);
    else {
      step('gateway', 'answering', `127.0.0.1:${profile.port}`);
      if (!first) await fixApprovals(lay, rt, { src, dryRun, step });
      // Duties this manager owns get their automations (created, or re-enabled); a duty it does not own keeps
      // its automation disabled (not deleted), so moving the digest to another manager stops it here.
      // The list decides what to create, enable and disable, so one that does not answer is retried, then
      // reported: taken for empty, it would leave a duty this manager gave up still running here.
      let list = null;
      for (let i = 0; i < 6 && !list; i++) {
        const got = (await ocJson(lay, rt, ['automations', 'list', '--timeout', '60000']).catch(() => null))?.jobs;
        if (Array.isArray(got)) list = got; else await _deps.sleep(10_000);
      }
      if (!list) step('automations', 'not ok', 'the automation list did not answer; duties not reconciled, re-run drover manager setup');
      else {
        const jobs = new Map(list.map((j) => [j.name, j]));
        const ocOk = async (args) => { const r = await oc(lay, rt, args); if (r.code !== 0) throw new Error(cliError(r, args.slice(0, 2))); };
        for (const a of view.automations) {
          const j = jobs.get(a.name);
          if (!j) {
            await ocOk(['automations', 'add', '--name', a.name, '--declaration-key', `drover:${name}:${a.name}`, '--cron', a.cron, '--tz', a.tz ?? 'UTC', '--session', a.session ?? 'isolated', '--message', a.message, '--model', a.model, '--thinking', a.thinking ?? 'low', '--no-deliver']);
            step(`automation ${a.name}`, 'created', a.cron);
            continue;
          }
          // An existing job is brought to the role's definition in place: an older one may carry no declaration
          // key, so a second add would run the duty twice. Only the fields that differ are edited.
          const want = { cron: a.cron, tz: a.tz ?? 'UTC', session: a.session ?? 'isolated', message: a.message, model: a.model, thinking: a.thinking ?? 'low' };
          const have = { cron: j.schedule?.expr, tz: j.schedule?.tz, session: j.sessionTarget, message: j.payload?.message, model: j.payload?.model, thinking: j.payload?.thinking };
          const diff = Object.keys(want).filter((k) => want[k] !== have[k]);
          if (diff.length) await ocOk(['automations', 'edit', j.id, ...diff.flatMap((k) => [`--${k}`, want[k]])]);
          if (j.enabled === false) await ocOk(['automations', 'enable', j.id]);
          step(`automation ${a.name}`, j.enabled === false ? 'enabled' : diff.length ? 'updated' : 'unchanged', diff.length ? diff.join(', ') : undefined);
        }
        for (const n of view.offAutomations) {
          const j = jobs.get(n);
          if (j && j.enabled !== false) { await ocOk(['automations', 'disable', j.id]); step(`automation ${n}`, 'disabled', 'this manager does not own that duty'); }
        }
      }
      const h = await ocJson(lay, rt, ['health', '--timeout', '60000']).catch((e) => ({ error: e.message }));
      step('health', h?.ok ? 'ok' : 'not ok', h?.error ?? `plugins ${(h?.plugins?.loaded ?? []).join(', ')}${h?.plugins?.errors?.length ? `; errors ${JSON.stringify(h.plugins.errors).slice(0, 200)}` : ''}`);
    }
  } else if (view.automations.length) step('automations', 'would ensure', view.automations.map((a) => a.name).join(', '));

  // 10. Old trees this installer made (keep the one in use and the one before it); report older installs.
  if (!dryRun) {
    // Never the tree the running gateway started from: a skipped restart (--restart never) leaves it in use.
    const keep = new Set([dir, prev?.openclaw?.dir, manifest.service.startedWith?.tree].filter(Boolean));
    let names = []; try { names = readdirSync(lay.installs); } catch { /* none */ }
    for (const n of names) {
      const p = path.join(lay.installs, n);
      if (keep.has(p) || !existsSync(path.join(p, MARKER))) continue;
      await rm(p, { recursive: true, force: true }); step('prune', 'removed', p);
    }
  }
  for (const p of legacyPaths(lay)) if (existsSync(p)) step('legacy', 'unused', `${p} (from before this installer; remove it by hand once this install is verified)`);
  return { role: name, profile: profile.name, overlay, actor: sc.actor, scope: manifest.scope, dryRun, steps, manifest };
}

/** Stop and remove the service, the generated files and the manifest. purge also removes the state dir (memory, sessions, secrets) and the installed trees. */
export async function uninstall({ purge = false, dryRun = false } = {}) {
  const lay = layout(); const steps = []; const step = (s, action, detail) => steps.push({ step: s, action, ...(detail ? { detail } : {}) });
  const svc = lay.service;
  if (dryRun) step('service', 'would stop and remove', svc.file);
  else if (svc.kind === 'launchd') { await _deps.tryRun('launchctl', ['bootout', `gui/${_deps.uid()}/${svc.name}`], { timeoutMs: 360_000 }); await rm(svc.file, { force: true }); step('service', 'removed', svc.file); }
  else { await _deps.tryRun('systemctl', ['--user', 'disable', '--now', svc.name], { timeoutMs: 360_000 }); await rm(svc.file, { force: true }); await _deps.tryRun('systemctl', ['--user', 'daemon-reload'], { timeoutMs: 30_000 }); step('service', 'removed', svc.file); }
  const targets = purge ? [lay.state, lay.installs] : [lay.launcher, lay.oc, lay.ro, lay.manifest];
  for (const t of targets) { if (!existsSync(t)) continue; if (!dryRun) await rm(t, { recursive: true, force: true }); step('remove', dryRun ? 'would remove' : 'removed', t); }
  if (!purge) step('kept', 'state', `${lay.state} (memory, sessions, secrets) and ${lay.installs}; purge removes them`);
  return { dryRun, purge, steps };
}
