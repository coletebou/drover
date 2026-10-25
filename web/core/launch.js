// Launch agents: resolve a profile into argv/env, then start it in tmux
// (interactive) or hold it headless in the daemon. Every launch is recorded as
// a `launch` event in the truth file. Claude launches draw a credential from
// the pool in core/credpool.js (profiles.json "credentials"); only the
// credential id is recorded (event, headless entry, result), never a value.
import { readFile } from 'node:fs/promises';
import path, { dirname } from 'node:path';
import { envvar } from './envvars.js';
import { fileURLToPath } from 'node:url';
import { uuidv7 } from './ids.js';
import * as tmux from './tmux.js';
import * as claude from './claude.js';
import * as codex from './codex.js';
import * as hermes from './hermes.js';
import { append } from './events.js';
import { checkEffort, checkModelEffort } from './effort.js';
import { loginShellPath } from './proc.js';
import { trustFolder } from './trust.js';
// Cycle: credpool.js imports loadProfiles from here. Neither module uses the
// other at module load, so the cycle is safe.
import * as credentials from './credpool.js';

function expandHome(s) { return typeof s === 'string' ? s.replace(/^~(?=$|\/)/, process.env.HOME) : s; }

/** The profiles.json beside web/core: the default, and what a custom file falls back to for an engine it has no section for. */
const SHIPPED_PROFILES = path.join(dirname(fileURLToPath(import.meta.url)), '..', 'profiles.json');
/** The launch profiles: DROVER_PROFILES (a leading ~ is this user's home), else the shipped profiles.json. */
export const PROFILES_FILE = expandHome(envvar('PROFILES')) || SHIPPED_PROFILES;
/** The engines a profiles file has a section for. */
const ENGINE_SECTIONS = ['claude', 'codex', 'hermes'];

/**
 * The profiles file. A custom one (DROVER_PROFILES) written before an engine existed, as a fleet's own file usually is
 * when Hermes arrives, gets that engine's shipped section, so the engine launches without the file being edited; a
 * section the file has is always its own.
 */
export async function loadProfiles() {
  const own = JSON.parse(await readFile(PROFILES_FILE, 'utf8'));
  if (PROFILES_FILE === SHIPPED_PROFILES || ENGINE_SECTIONS.every((e) => own[e])) return own;
  const shipped = JSON.parse(await readFile(SHIPPED_PROFILES, 'utf8'));
  return { ...own, ...Object.fromEntries(ENGINE_SECTIONS.filter((e) => !own[e] && shipped[e]).map((e) => [e, shipped[e]])) };
}

/** The tmux session a tmux launch that names none opens its window in, used when the profiles name none either. */
export const FALLBACK_TMUX_SESSION = 'agents';
/** The profiles' tmuxSession, else the first of their tmuxSessions (the suggestions), else FALLBACK_TMUX_SESSION. */
export function defaultTmuxSession(profiles) {
  const named = [profiles?.tmuxSession, ...(Array.isArray(profiles?.tmuxSessions) ? profiles.tmuxSessions : [])];
  return named.find((s) => typeof s === 'string' && s.trim())?.trim() ?? FALLBACK_TMUX_SESSION;
}

export async function resolveProfile(engine, profileId) {
  const all = await loadProfiles();
  const eng = all[engine];
  if (!eng) throw new Error(`unknown engine ${engine}`);
  const p = profileId ? eng.profiles.find((x) => x.id === profileId) : eng.profiles.find((x) => x.default) ?? eng.profiles[0];
  if (!p) throw new Error(`unknown profile ${profileId} for ${engine}`);
  if (p.requires && !process.env[p.requires]) throw new Error(`profile ${p.id} requires ${p.requires} in the environment of this host`);
  return { ...p, argv: (p.argv ?? []).map(expandHome), env: p.env ?? {} };
}

const SAFE_NAME = (s) => String(s ?? '').replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'agent';

/** Test seams: the tmux window spawner and its window id, the headless Claude and Hermes classes, the Codex thread starter, the Codex model catalog, the agent PATH, the folder trust step and the Hermes pane record. Default to the real adapters. */
export const _deps = { newWindow: (opts) => tmux.newWindow(opts), windowKey: (target) => tmux.windowKey(target), HeadlessClaude: claude.HeadlessClaude, HeadlessHermes: hermes.HeadlessHermes, startCodexThread: (opts) => codex.startThread(opts), codexModelEfforts: () => codex.modelEfforts(), agentPath: () => loginShellPath(), trustFolder: (engine, dir, opts) => trustFolder(engine, dir, opts), rememberHermesPane: (title, window) => hermes.rememberPane(title, window, { home: hermes.rootHome() }) };

/** The engines a launch starts; anything else is a Claude launch, as it always was. */
const ENGINES = new Set(['claude', 'codex', 'hermes']);

/**
 * A tmux window cannot be watched for exit from here, so a tmux launch counts
 * against its credential for this long and then expires. Headless sessions are
 * released the moment their process exits.
 */
export const TMUX_ACTIVE_TTL_MS = 6 * 3600_000;
/** Failovers per headless session; after that a throttle is only recorded. */
export const MAX_FAILOVERS = 3;
const THROTTLE_RE = /\b429\b|throttl|rate.?limit|too many requests/i;
const FAILOVER_NUDGE = 'The previous request was rate limited and this session was resumed under a different credential. Continue the task from where you left off.';
/**
 * Env for every Claude session Drover launches. Nobody watches these, so they run
 * in Claude Code's persistent retry mode (waits out 429/529, retries other
 * transient errors in the turn). Headless failover still fires: each retry
 * emits a stream-json system/api_retry event whose 429 throttleDetail matches.
 * Spread first, so a profile or credential env can override it.
 */
const UNATTENDED_CLAUDE_ENV = Object.freeze({ CLAUDE_CODE_RETRY_WATCHDOG: '1' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref());

/** Headless sessions the daemon is holding. */
export const headless = new Map();   // id -> { engine, handle, cwd, events[], subscribers:Set, credential, failovers, ... }

function recordHeadlessEvent(entry, ev) {
  entry.events.push({ ts: new Date().toISOString(), ...ev });
  if (entry.events.length > 2000) entry.events.splice(0, entry.events.length - 2000);
  for (const s of entry.subscribers) { try { s(ev); } catch { /* subscriber gone */ } }
}

/**
 * Is this stream-json event a throttle (429 / rate limit) worth failing over
 * for? Returns a short detail string or null. Model prose that merely talks
 * about rate limits does not count: assistant text only matches in the
 * "API Error ..." form, and stderr/system lines only while a turn is in flight.
 */
export function throttleDetail(d, { busy = true } = {}) {
  if (!d || typeof d !== 'object') return null;
  const text = (s) => (typeof s === 'string' ? s : s == null ? '' : JSON.stringify(s));
  if (d.type === 'result') {
    if (!d.is_error) return null;
    const t = text(d.result ?? d.error ?? d.message ?? '');
    return THROTTLE_RE.test(t) ? t.slice(0, 200) : null;
  }
  if (d.type === 'stderr' || (d.type === 'system' && d.subtype !== 'init')) {
    if (!busy) return null;
    const t = d.type === 'stderr' ? text(d.text) : text({ ...d, type: undefined });
    return THROTTLE_RE.test(t) ? t.slice(0, 200) : null;
  }
  if (d.type === 'assistant') {
    for (const b of d.message?.content ?? []) {
      if (b?.type === 'text' && typeof b.text === 'string' && /^\s*API Error/i.test(b.text) && THROTTLE_RE.test(b.text)) return b.text.slice(0, 200);
    }
  }
  return null;
}

/**
 * Start (or restart, on failover) the claude child for a headless entry. Each
 * attach bumps entry.generation so callbacks from a replaced child are ignored.
 */
function attachHeadlessClaude(entry, { profile, model, effort, resume, env }) {
  const gen = ++entry.generation;
  let resolveExit;
  const exited = new Promise((r) => { resolveExit = r; });
  const h = new _deps.HeadlessClaude({
    cwd: entry.cwd, profile, model, effort, resume, env,
    onEvent: (d) => {
      if (entry.generation !== gen) return;
      const busy = entry.status === 'busy';
      if (d.type === 'system' && d.subtype === 'init') { entry.sessionId = d.session_id; entry.status = 'ready'; }
      if (d.type === 'result') entry.status = 'idle';
      if (d.type === 'assistant') entry.status = 'busy';
      recordHeadlessEvent(entry, d);
      const detail = throttleDetail(d, { busy });
      if (detail) maybeFailover(entry, detail);
    },
    onExit: (code) => {
      resolveExit();
      if (entry.generation !== gen) return;
      entry.status = 'exited'; entry.exitCode = code;
      if (entry.credential) credentials.release(entry.credential, entry.id);
      recordHeadlessEvent(entry, { type: 'exit', code });
    },
  });
  h.exited = exited;
  entry.handle = h;
  if (!entry.sessionId) entry.sessionId = h.sessionId;
  return h;
}

function maybeFailover(entry, detail) {
  if (entry.failoverInFlight || entry.status === 'stopped' || entry.status === 'exited') return;
  entry.failoverInFlight = failover(entry, detail)
    .catch((e) => recordHeadlessEvent(entry, { type: 'failover', from: entry.credential, to: null, reason: `failover failed: ${e.message}` }))
    .finally(() => { entry.failoverInFlight = null; });
}

/**
 * Headless failover: record the throttle against the current credential, pick
 * another one, stop the child, resume the same session id under the new env,
 * and nudge it to continue. Capped at MAX_FAILOVERS per session.
 */
async function failover(entry, detail) {
  const from = entry.credential;
  let clean = detail.slice(0, 200);
  if (from) clean = (await credentials.recordThrottle(from, detail)).detail;
  if (!from) { recordHeadlessEvent(entry, { type: 'failover', from: null, to: null, reason: 'session has no pool credential', detail: clean }); return; }
  if (entry.failovers >= MAX_FAILOVERS) { recordHeadlessEvent(entry, { type: 'failover', from, to: null, reason: `cap of ${MAX_FAILOVERS} failovers reached; throttle recorded only`, detail: clean }); return; }
  let next = null;
  try { next = await credentials.pick('auto', { engine: 'claude', exclude: [from] }); }
  catch (e) { recordHeadlessEvent(entry, { type: 'failover', from, to: null, reason: e.message, detail: clean }); return; }
  if (!next) { recordHeadlessEvent(entry, { type: 'failover', from, to: null, reason: 'no other credential available', detail: clean }); return; }

  const old = entry.handle;
  entry.generation++;                       // the old child's callbacks are stale from here on
  entry.status = 'failover';
  old.stop();
  await Promise.race([old.exited, sleep(3000)]);
  if (entry.status === 'stopped') return;   // stopped by hand while we waited
  credentials.release(from, entry.id);
  await credentials.acquire(next.id, entry.id);
  entry.credential = next.id;
  entry.failovers += 1;
  // The resumed child keeps the session's launch effort, as it keeps the profile and model.
  const h = attachHeadlessClaude(entry, { profile: entry.profileResolved, model: entry.model, effort: entry.effort, resume: entry.sessionId, env: { ...UNATTENDED_CLAUDE_ENV, PATH: entry.agentPath, ...entry.profileEnv, ...next.env } });
  recordHeadlessEvent(entry, { type: 'failover', from, to: next.id, reason: next.reason, detail: clean, failovers: entry.failovers });
  h.send(FAILOVER_NUDGE);
  entry.status = 'busy';
}

/**
 * @param {object} req {engine:'claude'|'codex'|'hermes', mode:'tmux'|'headless', profile, model, effort, cwd, prompt, tmuxSession, name, resume, credential:'auto'|<id>|'none', trust}
 *
 * effort (core/effort.js) is the reasoning effort of this one session: claude `--effort <level>`, codex
 * `-c model_reasoning_effort="<level>"` (a headless Codex thread gets the same key in thread/start config), hermes
 * `--reasoning <level>`.
 *
 * A Hermes tmux launch names its new session with a unique title (the window name and a short tail, `-c <title>
 * --create-if-missing`) and remembers that title's window, so the session's strip opens its pane; the result and
 * event carry the title. A headless Hermes session runs each turn as one `hermes chat --oneshot` (core/hermes.js).
 * It is checked before anything else happens, so an invalid value starts, picks and records nothing; omitted,
 * the launch is exactly what it was before efforts existed (same argv, env, event and result).
 *
 * trust (default on, tmux only; core/trust.js): before the window opens, cwd is recorded as trusted in the agent's
 * own config, as accepting its first-run trust dialog would, so the agent starts at its prompt instead of at that
 * dialog. trust: false leaves the config alone. Runs where the launch runs, so a remote launch writes that host's file.
 */
export async function launch(req, { actor = 'drover' } = {}) {
  const engine = ENGINES.has(req.engine) ? req.engine : 'claude';
  const mode = req.mode === 'headless' ? 'headless' : 'tmux';
  const effort = checkEffort(engine, req.effort);
  const model = req.model || undefined;
  // A Codex model named in the request is checked against its own levels; without a model (the profile or
  // config picks it) or when the catalog does not know it, the engine list above is the rule.
  if (effort && engine === 'codex' && model) checkModelEffort('codex', model, effort, (await _deps.codexModelEfforts())?.get(model));
  const withEffort = effort ? { effort } : {};
  const cwd = expandHome(req.cwd) || process.env.HOME;
  const profile = await resolveProfile(engine, req.profile);
  const credMode = req.credential == null || req.credential === '' ? await credentials.defaultMode() : String(req.credential);
  // Throws for an explicit id that is unknown/unavailable and when every candidate is at maxConcurrent;
  // null when the pool does not apply (engine, none, nothing available), in which case the child inherits the daemon env.
  const cred = await credentials.pick(credMode, { engine });
  const credentialReason = cred ? cred.reason : (await credentials.recommend(credMode, { engine })).reason;
  const credEnv = cred?.env ?? {};
  // The PATH of a login shell, computed fresh for each launch (about 0.25 s), not the daemon's own: see
  // loginShellPath. Spread before the profile env, so a profile that names a PATH keeps it. A headless Codex
  // thread runs in the shared app-server (core/codex.js) and keeps that process's PATH, so it skips this.
  const agentPath = mode === 'tmux' || engine !== 'codex' ? await _deps.agentPath() : undefined;
  // A Hermes launch with no hermes to run would open a window that only says "command not found", or a headless session whose every turn fails.
  if (engine === 'hermes' && !hermes.findBin(profile.env.PATH ?? agentPath)) throw new Error(`hermes is not on this host's PATH (${hermes.hermesBin()}): install Hermes Agent there, or set DROVER_HERMES_BIN to it; nothing was started`);
  const base = { type: 'launch', engine, mode, profile: profile.id, model: model ?? null, ...withEffort, cwd, prompt: req.prompt ? String(req.prompt).slice(0, 2000) : null, credential: cred?.id ?? null };

  if (mode === 'tmux') {
    const session = tmux.assertName(req.tmuxSession || defaultTmuxSession(await loadProfiles()));
    const name = SAFE_NAME(req.name || `${engine}-${(req.prompt ?? '').slice(0, 20) || 'new'}`);
    // An argv array end to end: tmux gets each element as its own argument (tmux.newWindow escapes the one
    // thing tmux's own parser would act on, a trailing ";") and, given more than one, execs them with no
    // shell in between (test/launch-effort.test.js sends hostile values through a real tmux server), so PATH
    // is the one newWindow sets on the tmux client from env.PATH. The effort is a value from the allowlist in
    // core/effort.js, never text from the request.
    const title = engine === 'hermes' && !req.resume ? hermes.launchTitle(name) : null;
    const argv = engine === 'claude'
      ? claude.interactiveArgv(profile, { model, effort, resume: req.resume, prompt: req.prompt })
      : engine === 'hermes'
        ? hermes.interactiveArgv(profile, { model, effort, cwd, prompt: req.prompt, resume: req.resume, title })
        : codex.interactiveArgv(profile, { model, effort, prompt: req.prompt, resume: req.resume });
    // Credential and profile env go through tmux -e flags (never an `env K=V` argv prefix, which
    // would leave the token readable in #{pane_start_command}); the event stores only the bare argv.
    const childEnv = { ...(engine === 'claude' ? UNATTENDED_CLAUDE_ENV : {}), PATH: agentPath, ...Object.fromEntries(Object.entries(profile.env).map(([k, v]) => [k, expandHome(v)])), ...credEnv };
    // Before the window opens: the agent reads its trust as it starts. The env decides which config file it reads.
    const trust = req.trust === false || req.trust === 'false' ? null : await _deps.trustFolder(engine, cwd, { env: { ...process.env, ...childEnv } });
    const withTrust = trust ? { trust } : {};
    const { target } = await _deps.newWindow({ session, name, cwd, argv, env: childEnv });
    if (cred) await credentials.acquire(cred.id, `tmux:${target}`, { ttlMs: TMUX_ACTIVE_TTL_MS });
    // Which window the titled Hermes session is in: a failure here costs only the strip's link to its pane.
    if (title) { try { await _deps.rememberHermesPane(title, await _deps.windowKey(target)); } catch (e) { console.error(`[launch] hermes pane for ${title}: ${e.message}`); } }
    const withTitle = title ? { title } : {};
    const ev = await append({ ...base, argv, ...withTrust, result: { tmux: target, name, ...withTitle } }, { actor });
    return { ok: true, mode, target, name, argv, ...withTitle, ...withEffort, ...withTrust, credential: cred?.id ?? null, credentialReason, event: ev.id };
  }

  // headless
  const id = uuidv7();
  const entry = {
    id, engine, cwd, profile: profile.id, model: model ?? null, ...withEffort, startedAt: new Date().toISOString(), events: [], subscribers: new Set(), status: 'starting',
    name: SAFE_NAME(req.name || `${engine}-headless`), credential: cred?.id ?? null, failovers: 0, generation: 0, failoverInFlight: null,
    profileResolved: profile, profileEnv: profile.env, agentPath,
  };
  headless.set(id, entry);
  if (engine === 'claude') {
    const h = attachHeadlessClaude(entry, { profile, model, effort, resume: req.resume, env: { ...UNATTENDED_CLAUDE_ENV, PATH: agentPath, ...profile.env, ...credEnv } });
    if (cred) await credentials.acquire(cred.id, id);
    if (req.prompt) { h.send(req.prompt); entry.status = 'busy'; }
    const ev = await append({ ...base, argv: ['claude', ...h.argv], result: { headlessId: id, sessionId: h.sessionId } }, { actor });
    return { ok: true, mode, headlessId: id, sessionId: h.sessionId, ...withEffort, credential: cred?.id ?? null, credentialReason, event: ev.id };
  }
  if (engine === 'hermes') {
    const h = new _deps.HeadlessHermes({
      cwd, profile, model, effort, resume: req.resume, env: { PATH: agentPath, ...profile.env },
      onEvent: (d) => { entry.sessionId = entry.handle?.sessionId ?? entry.sessionId; recordHeadlessEvent(entry, d); },
      onStatus: (st) => { entry.sessionId = entry.handle?.sessionId ?? entry.sessionId; if (entry.status !== 'stopped') entry.status = st; },
    });
    entry.handle = h; entry.status = 'idle';
    if (req.resume) entry.sessionId = req.resume;
    if (req.prompt) { recordHeadlessEvent(entry, { type: 'hermes/user', text: req.prompt }); h.send(req.prompt); }
    const ev = await append({ ...base, argv: h.argv, result: { headlessId: id, ...(req.resume ? { sessionId: req.resume } : {}) } }, { actor });
    return { ok: true, mode, headlessId: id, sessionId: entry.sessionId ?? null, ...withEffort, credential: null, credentialReason, event: ev.id };
  }
  // codex headless: thread on the shared app-server
  const started = await _deps.startCodexThread({ cwd, model, ...withEffort, prompt: req.prompt });
  entry.threadId = started.threadId; entry.status = req.prompt ? 'busy' : 'idle';
  entry.unsub = codex.onNotification((method, params) => {
    const tid = params?.threadId ?? params?.thread?.id ?? params?.item?.threadId;
    if (tid && tid !== entry.threadId) return;
    if (method === 'turn/completed') entry.status = 'idle';
    if (method === 'turn/started') entry.status = 'busy';
    recordHeadlessEvent(entry, { type: method, params });
  });
  const ev = await append({ ...base, argv: ['codex', 'app-server', 'thread/start'], result: { headlessId: id, threadId: started.threadId } }, { actor });
  return { ok: true, mode, headlessId: id, threadId: started.threadId, ...withEffort, credential: null, credentialReason, event: ev.id };
}

export async function headlessSend(id, text) {
  const e = headless.get(id); if (!e) throw new Error('no such headless session');
  if (e.engine === 'claude') { e.handle.send(text); e.status = 'busy'; recordHeadlessEvent(e, { type: 'user', text }); return { ok: true }; }
  if (e.engine === 'hermes') {
    recordHeadlessEvent(e, { type: 'hermes/user', text });
    // Between one-shots the conversation is the gateway's while one is up: the message goes there, where it answers a
    // question, or queues behind a turn or an approval, as a message to any Hermes session does (and its transcript is
    // the conversation's). With no gateway, a one-shot this entry tracks. A message acts, so it may dial a gateway a
    // listing would leave alone (hermes.js mayPoll).
    if (e.status === 'stopped') throw new Error('this headless Hermes session was stopped');
    if (!e.handle.child && e.sessionId) {
      const s = await hermes.findSession(e.sessionId);
      if (s && await hermes.gatewayFor(s.home ?? hermes.rootHome())) return hermes.send(s, text);
    }
    // A Hermes turn already running: this one waits for it (HeadlessHermes), so its output still comes back here.
    const r = e.handle.send(text); return { ok: true, ...(r.queued ? { queuedBehindTurn: true } : {}) };
  }
  const r = await codex.sendTurn(e.threadId, text, { cwd: e.cwd }); e.status = 'busy'; recordHeadlessEvent(e, { type: 'user', text }); return r;
}

/**
 * A headless Hermes entry with no one-shot running takes the status of its conversation (waiting, busy or idle), which
 * the gateway serves from then on: core/api.js listSessionsLocal derives it each listing. A running one-shot's own
 * status stands.
 */
export function headlessSettle(id, status) {
  const e = headless.get(id);
  if (e?.engine === 'hermes' && e.status !== 'stopped' && !e.handle?.child && ['waiting', 'busy', 'idle'].includes(status)) e.status = status;
}

export function headlessStop(id) {
  const e = headless.get(id); if (!e) throw new Error('no such headless session');
  // A Hermes turn belongs to the gateway, which runs it on with its client gone: stop it there too.
  if (e.engine === 'hermes' && e.sessionId) hermes.findSession(e.sessionId).then((s) => (s?.live ? hermes.interrupt(s) : null)).catch(() => {});
  if (e.engine === 'claude' || e.engine === 'hermes') e.handle.stop(); else { e.unsub?.(); codex.interruptTurn(e.threadId).catch(() => {}); }
  e.status = 'stopped';
  if (e.credential) credentials.release(e.credential, e.id);
  return { ok: true };
}

export function headlessList() {
  return [...headless.values()].map((e) => ({ id: e.id, engine: e.engine, name: e.name, cwd: e.cwd, profile: e.profile, model: e.model, ...(e.effort ? { effort: e.effort } : {}), status: e.status, ...(e.engine === 'hermes' ? { running: Boolean(e.handle?.child) } : {}), exitCode: e.exitCode ?? null, startedAt: e.startedAt, sessionId: e.sessionId ?? null, threadId: e.threadId ?? null, eventCount: e.events.length, credential: e.credential ?? null, failovers: e.failovers ?? 0 }));
}

export function headlessGet(id) {
  const e = headless.get(id); if (!e) return null;
  return { ...headlessList().find((x) => x.id === id), events: e.events.slice(-300) };
}

export function headlessSubscribe(id, fn) {
  const e = headless.get(id); if (!e) throw new Error('no such headless session');
  e.subscribers.add(fn); return () => e.subscribers.delete(fn);
}
