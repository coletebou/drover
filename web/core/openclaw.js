// OpenClaw manager adapter. A fleet manager is an OpenClaw gateway on loopback (state dir
// ~/.openclaw-manager, design: specs/2026-10-11-openclaw-manager-design.md section 5.3), installed by
// `drover manager setup` (core/openclaw-install.js) from web/openclaw-manager/. It shows up as one
// session, id "manager", engine "openclaw", on the host that has the state dir.
// Messages go through the gateway's OpenAI-compatible /v1/chat/completions with
// a stable `user` so the conversation continues (the same request shape as
// bin/manager-say). The gateway token comes from the environment or the
// state dir's .env and never leaves this module: not in results, not in events.
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { run as runProc, tryRun } from './proc.js';
import * as eventsMod from './events.js';
import { envvar } from './envvars.js';
import { isOwnerClient } from './util.js';
import { OWNER } from './owner.js';
import * as install from './openclaw-install.js';

export const STATE_DIR = install.layout().state;
export const ID = 'manager';
const ALIASES = new Set([ID, 'openclaw', `openclaw:${ID}`]);
const port = () => Number(process.env.OPENCLAW_GATEWAY_PORT ?? install.gatewayPort());
const base = () => process.env.OPENCLAW_GATEWAY_URL ?? `http://127.0.0.1:${port()}`;
const stateDir = () => install.layout().state;

/** The manager is configured on this host when its state dir holds an openclaw.json. */
export function configured() { return existsSync(path.join(stateDir(), 'openclaw.json')); }
export function isManagerId(id) { return ALIASES.has(String(id ?? '').trim().toLowerCase()); }

/** Gateway bearer: OPENCLAW_GATEWAY_TOKEN in the environment, else in <state>/.env. Used only to build the request. */
async function token() {
  if (process.env.OPENCLAW_GATEWAY_TOKEN) return process.env.OPENCLAW_GATEWAY_TOKEN;
  const file = path.join(stateDir(), '.env');
  if (!existsSync(file)) return null;
  return install.parseEnvFile(await readFile(file, 'utf8')).OPENCLAW_GATEWAY_TOKEN || null;
}

/** Is the gateway answering on loopback? Any HTTP response counts; auth is not needed to see that it is up. */
export async function alive({ timeoutMs = _deps.aliveTimeoutMs } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try { await fetch(`${base()}/`, { signal: ctl.signal }); return true; }
  catch { return false; }
  finally { clearTimeout(t); }
}

// ---------------------------------------------------------------- conversation
// The gateway keeps the model's memory; Drover keeps what was said, in the truth file: a `message` event to
// "manager" when the owner (or an agent) writes, a `chat` event from "manager" when it answers (`error` set when the
// delivery failed). The transcript is rebuilt from those, so it survives a daemon restart and reads the same in
// every client, plus the replies still streaming in this process. A thread is its own gateway conversation
// (`user` drover:<actor> for main, drover:<actor>:<thread> otherwise): a tmux window can keep an independent
// manager while every other client shares main.
export const VIA = 'openclaw chat completions';
export const THREAD_RE = /^[A-Za-z0-9_.:@%-]{1,64}$/;
/** A thread name, main when none is given; anything else is refused before it reaches the gateway or the WAL. */
export function threadOf(t) {
  if (t == null || t === '') return 'main';
  const s = String(t);
  if (!THREAD_RE.test(s)) throw new Error('thread must be 1 to 64 of A-Z a-z 0-9 _ . : @ % -');
  return s;
}
// The owner's own clients (owner.js isOwnerClient): what they say to the manager from any of them is one conversation
// (the actor still records which client sent it). Anything else (an agent over MCP, a script, a bot, another manager)
// keeps a conversation of its own. The actor is what a caller says, since every process of this user can read the
// token, so the MCP server agents call through never passes one of the owner's client names on (mcp/server.js writeActor).
export const gatewayUser = (actor, thread) => `drover:${isOwnerClient(actor) ? OWNER : actor}${thread === 'main' ? '' : `:${thread}`}`;

const progress = new Set();
/** Streaming and turn notices for SSE: fn({ event: 'manager' | 'turn', data }). Returns an unsubscribe. */
export function onProgress(fn) { progress.add(fn); return () => progress.delete(fn); }
const emit = (event, data) => { for (const fn of progress) { try { fn({ event, data }); } catch { /* a listener must never break a send */ } } };

let daemonProcess = false;
/** The daemon keeps a reply going after its request returned (wait: false); any other process waits for it. */
export function markDaemon() { daemonProcess = true; }

const inflight = new Map();   // message event id -> { thread, ts, text } while its reply streams
export const busy = () => inflight.size > 0;

const isConversationEvent = (e, host) => e?.host === host
  && ((e.type === 'message' && e.to?.id === ID && (e.to?.kind ?? 'openclaw') === 'openclaw') || (e.type === 'chat' && e.from === ID));

// The truth file is read again only when it changed and the last read is REREAD_MS old: other processes (a peer's
// drover rpc) append messages too, and every alert and op appends to the same file. Appends from this process
// are seen at once.
const REREAD_MS = 3000;
// The newest this many conversation events stay in memory (the truth file keeps them all); offsets count turns in that window.
const KEEP_EVENTS = 4000;
let wal = { sig: null, at: 0, events: new Map() };
const ownAppends = new Map();
async function conversation() {
  const host = _deps.host();
  let sig = null;
  try { const st = await stat(eventsMod.EVENTS_PATH); sig = `${st.size}:${st.mtimeMs}`; } catch { /* no truth file yet */ }
  if (sig !== wal.sig && Date.now() - wal.at > REREAD_MS) {
    const events = new Map();
    const mine = (await _deps.readEvents().catch(() => [])).filter((e) => isConversationEvent(e, host));
    for (const e of mine.slice(-KEEP_EVENTS)) events.set(e.id, e);   // readAll sorts by ts: the newest are last
    wal = { sig, at: Date.now(), events };
    for (const id of ownAppends.keys()) if (events.has(id)) ownAppends.delete(id);
  }
  return [...wal.events.values(), ...ownAppends.values()].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}
const remember = (e) => { ownAppends.set(e.id, e); if (ownAppends.size > 2000) ownAppends.delete(ownAppends.keys().next().value); };

const userTurn = (e, thread) => ({ id: e.id, uuid: e.id, role: 'user', ts: e.ts, text: e.text ?? '', actor: e.actor ?? null, thread, ...(e.delivery?.ok === false ? { error: String(e.delivery.error ?? 'not delivered') } : {}) });
const replyTurn = (e, thread) => (e.error
  ? { id: e.id, uuid: e.id, role: 'system', ts: e.ts, text: `The manager did not answer: ${e.error}`, error: e.error, inReplyTo: e.inReplyTo ?? null, thread }
  : { id: e.id, uuid: e.id, role: 'assistant', ts: e.ts, text: e.text ?? '', model: e.model ?? null, inReplyTo: e.inReplyTo ?? null, thread });

/** Every turn by thread, oldest first. A message that failed before chat events existed gets its failure as a turn. */
async function threadTurns() {
  const byThread = new Map(), threadOfMsg = new Map(), answered = new Set();
  const add = (t, turn) => { if (!byThread.has(t)) byThread.set(t, []); byThread.get(t).push(turn); };
  for (const e of await conversation()) {
    if (e.type === 'message') {
      const t = e.thread ?? 'main'; threadOfMsg.set(e.id, t); add(t, userTurn(e, t));
      if (e.delivery?.ok === false && !answered.has(e.id)) add(t, { id: `${e.id}:failed`, uuid: `${e.id}:failed`, role: 'system', ts: e.ts, text: `The manager did not answer: ${e.delivery.error ?? 'delivery failed'}`, error: e.delivery.error ?? 'delivery failed', inReplyTo: e.id, thread: t });
    } else {
      const t = e.thread ?? threadOfMsg.get(e.inReplyTo) ?? 'main'; if (e.inReplyTo) answered.add(e.inReplyTo); add(t, replyTurn(e, t));
    }
  }
  return byThread;
}

/**
 * The conversation in one thread. Without since: the newest `limit` turns; with since (a turn count, the offset
 * an earlier read returned): the turns after it. A reply still streaming is a last turn with pending: true, the
 * text so far and the id of the message it answers. offset counts the thread's turns, not the pending one.
 */
export async function transcript({ since = 0, limit = 200, thread } = {}) {
  const th = threadOf(thread);
  const turns = (await threadTurns()).get(th) ?? [];
  const from = Math.max(0, Number(since) || 0), lim = Math.max(1, Math.min(5000, Number(limit) || 200));
  const page = from ? turns.slice(from, from + lim) : turns.slice(-lim);
  const pending = [...inflight.entries()].filter(([, f]) => f.thread === th)
    .map(([id, f]) => ({ id: `pending:${id}`, uuid: `pending:${id}`, role: 'assistant', pending: true, ts: f.ts, text: f.text, inReplyTo: id, thread: th }));
  return { engine: 'openclaw', thread: th, turns: [...page, ...pending], offset: turns.length, busy: pending.length > 0 };
}

/** The threads that have turns, newest activity first: { thread, turns, lastTs, lastText }. */
export async function threads() {
  const out = [];
  for (const [thread, turns] of await threadTurns()) {
    const last = turns.at(-1);
    out.push({ thread, turns: turns.length, lastTs: last?.ts ?? null, lastText: String(last?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 140), busy: [...inflight.values()].some((f) => f.thread === thread) });
  }
  for (const f of inflight.values()) if (!out.some((x) => x.thread === f.thread)) out.push({ thread: f.thread, turns: 0, lastTs: f.ts, lastText: '', busy: true });
  return out.sort((a, b) => String(b.lastTs ?? '').localeCompare(String(a.lastTs ?? '')));
}

export async function listSessions() {
  if (!configured()) return [];
  const live = await alive();
  return [{ id: ID, name: ID, engine: 'openclaw', kind: 'openclaw', live, status: live ? (busy() ? 'busy' : 'ready') : 'down', cwd: path.join(stateDir(), 'workspace'), startedAt: null, gateway: base() }];
}

export async function findSession(id) {
  if (!configured() || !isManagerId(id)) return null;
  return (await listSessions())[0];
}

/**
 * One chat turn with the manager over the gateway's streaming chat completions. Returns { ok, reply, model, via,
 * user }; onDelta(delta, textSoFar) hears the reply as it streams. Throws on transport, auth or gateway errors.
 * A gateway that ignores stream: true and answers with one JSON body works too.
 */
export async function send(text, { user = gatewayUser(OWNER, 'main'), timeoutMs = 900_000, onDelta } = {}) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('empty message');
  const bearer = await token();
  if (!bearer) throw new Error(`no OPENCLAW_GATEWAY_TOKEN (environment or ${path.join(stateDir(), '.env')})`);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base()}/v1/chat/completions`, {
      method: 'POST',
      signal: ctl.signal,
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ model: 'openclaw/default', user, stream: true, messages: [{ role: 'user', content: text }] }),
    });
    if (!res.ok || !/event-stream/i.test(res.headers.get('content-type') ?? '')) {
      const body = await res.text();
      let data = null;
      try { data = JSON.parse(body); } catch { /* a non-JSON error body */ }
      if (!res.ok) throw new Error(`gateway ${res.status}: ${String(data?.error?.message ?? body).slice(0, 300)}`);
      const reply = data?.choices?.[0]?.message?.content ?? '';
      if (reply) onDelta?.(reply, reply);
      return { ok: true, reply, model: data?.model ?? null, via: VIA, user };
    }
    let reply = '', model = null, buf = '';
    const dec = new TextDecoder();
    const line = (l) => {
      if (!l.startsWith('data:')) return;
      const d = l.slice(5).trim();
      if (!d || d === '[DONE]') return;
      let j; try { j = JSON.parse(d); } catch { return; }
      if (j.error) throw new Error(`gateway: ${String(j.error.message ?? j.error).slice(0, 300)}`);
      model = j.model ?? model;
      const c = j.choices?.[0]?.delta?.content;
      if (typeof c === 'string' && c) { reply += c; onDelta?.(c, reply); }
    };
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i).replace(/\r$/, '')); buf = buf.slice(i + 1); }
    }
    line((buf + dec.decode()).trim());
    return { ok: true, reply, model, via: VIA, user };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`the manager did not answer within ${Math.round(timeoutMs / 1000)} s`);
    throw e;
  } finally { clearTimeout(t); }
}

const DELTA_MS = 80;   // stream notices at most this often; the done notice always carries the whole reply

/**
 * Say something to the manager. The message is recorded first (a `message` event, so it is in every transcript at
 * once), the reply streams as `manager` notices and is recorded as a `chat` event (`error` when it failed).
 * wait: false returns as soon as the message is recorded ({ pending: true, event, turnId }); only the daemon does
 * that, a short-lived process waits. Otherwise the result is { ok, reply, model, via, user, event, thread }, and a
 * failed delivery throws with the message's event id.
 */
export async function message(text, { actor = OWNER, thread, wait = true, timeoutMs } = {}) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('empty message');
  const th = threadOf(thread);
  const user = gatewayUser(actor, th);
  const host = _deps.host();
  const to = { kind: 'openclaw', host, id: ID, name: ID };
  const msg = await eventsMod.append({ type: 'message', to, text, ...(th !== 'main' ? { thread: th } : {}), delivery: { ok: true, pending: true, via: VIA, user } }, { actor });
  remember(msg);
  emit('turn', { id: ID, host, thread: th, turn: userTurn(msg, th) });
  const run = deliver(msg, { text, user, thread: th, timeoutMs });
  if (wait === false && daemonProcess) {
    run.catch(() => { /* recorded as a chat event with error, and sent as a manager error notice */ });
    return { ok: true, pending: true, event: msg.id, turnId: `pending:${msg.id}`, thread: th, via: VIA, user };
  }
  const r = await run;
  return { ...r, event: msg.id, thread: th };
}

async function deliver(msg, { text, user, thread, timeoutMs }) {
  const host = _deps.host(), to = msg.to, turnId = `pending:${msg.id}`;
  const note = { host, thread, turnId, inReplyTo: msg.id };
  const f = { thread, ts: new Date().toISOString(), text: '' };
  inflight.set(msg.id, f);
  emit('manager', { ...note, phase: 'start', text: '' });
  let sent = 0, timer = null;
  const flush = () => { timer = null; if (f.text.length > sent) { emit('manager', { ...note, phase: 'delta', delta: f.text.slice(sent), text: f.text }); sent = f.text.length; } };
  const tag = thread !== 'main' ? { thread } : {};
  try {
    const r = await send(text, { user, ...(timeoutMs ? { timeoutMs } : {}), onDelta: (_d, soFar) => { f.text = soFar; if (!timer) timer = setTimeout(flush, DELTA_MS); } });
    clearTimeout(timer);
    const chat = await _deps.appendEvent({ type: 'chat', to, from: ID, text: r.reply, inReplyTo: msg.id, ...tag, ...(r.model ? { model: r.model } : {}) }, { actor: ID });
    remember(chat);
    // Keep pending/busy until the durable reply is visible, not merely until SSE ends.
    inflight.delete(msg.id);
    emit('manager', { ...note, phase: 'done', text: r.reply, id: chat.id });
    emit('turn', { id: ID, host, thread, turn: replyTurn(chat, thread) });
    return r;
  } catch (e) {
    clearTimeout(timer);
    const error = String(e.message ?? e).slice(0, 300);
    const chat = await _deps.appendEvent({ type: 'chat', to, from: ID, text: '', error, inReplyTo: msg.id, ...tag }, { actor: ID }).catch(() => null);
    if (chat) remember(chat);
    inflight.delete(msg.id);
    emit('manager', { ...note, phase: 'error', error, ...(chat ? { id: chat.id } : {}) });
    if (chat) emit('turn', { id: ID, host, thread, turn: replyTurn(chat, thread) });
    throw Object.assign(new Error(error), { event: msg.id });
  }
}

// ---------------------------------------------------------------- console ops (status, check, sweep, feed)
// The manager's own OpenClaw CLI (the tree the install manifest names) answers what the chat endpoint
// cannot: gateway health, automations and their last/next runs, recorded cost. It is spawned as
// `node openclaw.mjs ...` without a shell, with a clean environment (install.cliEnv): the state dir,
// the egress switches and the gateway token, nothing from this daemon's environment, which holds other
// providers' keys. (OpenClaw itself also reads the manager's own .env from its state dir.) Nothing here
// reads, returns or logs a secret value.

export const LANGFUSE_URL = envvar('LANGFUSE_URL') ?? null;
export const _deps = {
  run: (file, argv, opts) => runProc(file, argv, opts),
  tryRun: (file, argv, opts) => tryRun(file, argv, opts),
  readEvents: () => eventsMod.readAll(),
  appendEvent: (event, opts) => eventsMod.append(event, opts),
  now: () => Date.now(),
  alive: () => alive(),
  serviceState: (lay) => install.serviceState(lay),
  host: () => eventsMod.shortHost(),
  aliveTimeoutMs: 2000,   // how long alive() waits for the gateway; a swapping Mac answers in seconds, tests on a loaded box raise it
};
const ANY_EXIT = Array.from({ length: 256 }, (_, i) => i);

/** argv for the manager's OpenClaw CLI on this host (the manifest's node and tree, else a pre-manifest install), or null. */
export function cliArgv(args) {
  const rt = install.runtimeFor(install.layout());
  return rt ? { file: rt.node, argv: [rt.mjs, ...args], mjs: rt.mjs } : null;
}

/** The install's profile, read from the overlay the install used (the manifest's, unless DROVER_OPENCLAW_OVERLAY says otherwise). */
function profileOf(manifest) { try { return manifest?.profile ? install.loadProfile(manifest.profile, install.SRC, install.resolveOverlay(undefined, { manifest })) : null; } catch { return null; } }

async function cliJson(args, { timeoutMs = 45_000, profile = null } = {}) {
  const lay = install.layout();
  const a = cliArgv([...args, '--json']);
  if (!a) throw new Error('no OpenClaw install on this host (drover manager setup installs one)');
  const r = await _deps.run(a.file, a.argv, { env: install.cliEnv(lay, a.file, { profile }), cwd: lay.home, timeoutMs, okCodes: ANY_EXIT });
  if (r.code !== 0) throw new Error(install.cliError(r, args));
  return install.parseCliJson(r.stdout);
}
const errInfo = (e) => ({ error: String(e?.message ?? e).slice(0, 300) });

/** The model and loop settings from openclaw.json (no secrets live there; env refs only). */
export function modelInfo(cfg) {
  const d = cfg?.agents?.defaults ?? {};
  return { primary: d.model?.primary ?? null, fallbacks: d.model?.fallbacks ?? [], thinking: d.thinkingDefault ?? null, heartbeatEvery: d.heartbeat?.every ?? null, heartbeatModel: d.heartbeat?.model ?? null, timeoutSeconds: d.timeoutSeconds ?? null };
}

/** Automations -> { jobs, lastRunAt, nextRunAt } with only the fields the console shows. */
export function jobsInfo(list) {
  const jobs = (list?.jobs ?? (Array.isArray(list) ? list : [])).map((j) => ({
    id: j.id, name: j.displayName ?? j.name ?? j.id, enabled: j.enabled !== false, status: j.status ?? j.state?.status ?? null, lastStatus: j.state?.lastRunStatus ?? null,
    lastRunAt: j.state?.lastRunAtMs ?? j.lastRunAtMs ?? null, nextRunAt: j.state?.nextRunAtMs ?? j.nextRunAtMs ?? null,
    schedule: j.schedule?.kind === 'every' ? `every ${Math.round((j.schedule.everyMs ?? 0) / 60000)} min` : j.schedule?.expr ?? j.schedule?.kind ?? null,
  }));
  const last = Math.max(0, ...jobs.map((j) => j.lastRunAt ?? 0));
  const next = jobs.filter((j) => j.enabled).map((j) => j.nextRunAt).filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b)[0] ?? null;
  return { jobs, lastRunAt: last ? new Date(last).toISOString() : null, nextRunAt: next ? new Date(next).toISOString() : null };
}

/** `gateway usage-cost --days 1` -> today's USD. The figure is final only once OpenClaw's cost cache reads "fresh". */
export function costInfo(c) {
  const status = c?.cacheStatus?.status ?? null;
  return { todayUsd: c?.totals?.totalCost ?? c?.daily?.at(-1)?.totalCost ?? null, cacheStatus: status, fresh: status === 'fresh', tokens: c?.totals?.totalTokens ?? null };
}

/** `health --json` -> gateway health without the session lists. */
export function healthInfo(h) {
  const hb = h?.agents?.find((a) => a.isDefault)?.heartbeat ?? h?.agents?.[0]?.heartbeat ?? null;
  return { ok: h?.ok === true, plugins: h?.plugins?.loaded ?? [], pluginErrors: (h?.plugins?.errors ?? []).length, unavailable: h?.plugins?.unavailable ?? [], configReload: h?.configReload?.hotReloadStatus ?? null, heartbeat: hb ? { enabled: hb.enabled !== false, every: hb.every ?? null, model: hb.model ?? null } : null };
}

/** The actor this host's manager writes as: its live config's DROVER_MCP_ACTOR, else the install manifest's, else "manager". */
export function managerActor(cfg, manifest) {
  return cfg?.mcp?.servers?.drover?.env?.DROVER_MCP_ACTOR ?? manifest?.actor ?? ID;
}

/**
 * Is this truth-file event the manager's? Its own writes (notes, pins) carry its actor wherever the
 * file syncs to. Chat replies and messages to it are written by the daemon on the manager's host with
 * id "manager", whatever the host, so those count only for that host when one is given.
 */
export function isManagerEvent(e, { actor = ID, host = null } = {}) {
  if (!e) return false;
  if (e.type === 'chat' && e.from === ID) return host == null || e.host === host;
  if (e.type === 'message' && e.to?.id === ID) return host == null || e.host === host;
  return e.actor === actor;
}

/** Who "the manager" is when this host's daemon answers: the local manager, or (no manager here) the default actor anywhere. */
function localManager() {
  if (!configured()) return { actor: ID, host: null };
  const lay = install.layout();
  let cfg = null; try { cfg = JSON.parse(readFileSync(lay.config, 'utf8')); } catch { /* unreadable */ }
  return { actor: managerActor(cfg, install.readManifest(lay)), host: _deps.host() };
}

/** Where the Langfuse traces go: the origin of the config's OTLP endpoint (DROVER_LANGFUSE_URL overrides), with a note when it is a private address. */
export function tracesInfo(cfg) {
  const ep = LANGFUSE_URL ?? cfg?.diagnostics?.otel?.endpoint ?? null;
  if (!ep || cfg?.diagnostics?.otel?.enabled === false) return { url: null, note: 'no trace export configured' };
  let u; try { u = new URL(ep); } catch { return { url: ep, note: 'unparsable endpoint' }; }
  const priv = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|localhost$)/.test(u.hostname);
  return { url: `${u.protocol}//${u.host}`, note: priv ? `private address: reachable only from inside its network (${u.hostname})` : '' };
}

/** Hosts named by http(s) URLs anywhere in a config. */
export function urlHosts(cfg) {
  const out = new Set();
  const walk = (v) => {
    if (typeof v === 'string') { if (/^https?:\/\//.test(v)) { try { out.add(new URL(v).hostname); } catch { /* not a URL */ } } }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(cfg);
  return [...out].sort();
}

/** "10.0.0.1:443" | "[::1]:7337" | "::1:7337" -> the address without its port. */
export function peerHost(peer) {
  const m = String(peer ?? '').match(/^\[?([^\]]+?)\]?:(\d+)$/);
  return m ? m[1] : String(peer ?? '');
}

/** TCP peers of the gateway and its children (MCP servers): Linux ss, macOS lsof. [{ pid, peer }] */
async function gatewayPeers(pid) {
  if (!pid) return [];
  const kids = await _deps.tryRun('pgrep', ['-P', String(pid)], { timeoutMs: 5000 });
  const pids = [pid, ...String(kids.stdout ?? '').split(/\s+/).map(Number).filter(Boolean)];
  const out = [];
  if (process.platform === 'darwin') {
    const r = await _deps.tryRun('lsof', ['-nP', '-a', '-iTCP', '-sTCP:ESTABLISHED', '-p', pids.join(','), '-Fpn'], { timeoutMs: 10_000 });
    let cur = null;
    for (const l of String(r.stdout ?? '').split('\n')) {
      if (l.startsWith('p')) cur = Number(l.slice(1));
      else if (l.startsWith('n') && l.includes('->')) out.push({ pid: cur, peer: l.slice(l.indexOf('->') + 2) });
    }
  } else {
    const r = await _deps.tryRun('ss', ['-tnpH', 'state', 'established'], { timeoutMs: 10_000 });
    for (const l of String(r.stdout ?? '').split('\n')) {
      const p = pids.find((x) => l.includes(`pid=${x},`));
      if (p) { const cols = l.trim().split(/\s+/); out.push({ pid: p, peer: cols[3] ?? cols.at(-2) }); }
    }
  }
  return out;
}

/**
 * The egress check (the design's section 3, formerly check-egress.sh): every host the config names
 * against the install profile's allowlist, the phone-home switches in the config and in the launcher,
 * the secret names, the loopback proxy's upstreams, and with live:true the gateway's TCP peers.
 * ok is false when anything is unexpected. Reads names, never secret values.
 */
export async function check({ live = false } = {}) {
  if (!configured()) return { configured: false, ok: null, reason: `no ${path.join(stateDir(), 'openclaw.json')} on this host` };
  const lay = install.layout();
  const manifest = install.readManifest(lay);
  const profile = profileOf(manifest);
  const items = []; const add = (area, name, ok, detail) => items.push({ area, name, ok, ...(detail ? { detail } : {}) });
  let cfg = null; try { cfg = JSON.parse(await readFile(lay.config, 'utf8')); } catch (e) { add('config', lay.config, false, `unreadable: ${e.message}`); }
  const overlay = manifest ? install.resolveOverlay(undefined, { manifest }) : null;
  if (!profile) add('profile', 'install profile', false, manifest ? `profile ${manifest.profile} not found in this checkout${overlay ? ` or the overlay ${overlay}` : ' (no overlay: set DROVER_OPENCLAW_OVERLAY if it lives in one)'}` : 'no install manifest; run drover manager setup so the allowlist is known');
  const allow = new Set(profile?.egress?.allow ?? []);
  if (cfg) {
    for (const h of urlHosts(cfg)) add('config', h, profile ? allow.has(h) : null, profile && !allow.has(h) ? `not in profile ${profile.name}'s egress.allow` : 'configured endpoint');
    for (const [k, want] of [['update.checkOnStart', false], ['telemetry.enabled', false], ['tools.web.fetch.enabled', false]]) {
      const v = k.split('.').reduce((x, p) => x?.[p], cfg);
      add('switch', k, v === want, `is ${JSON.stringify(v)}`);
    }
    add('plugins', 'plugins.allow', true, (cfg.plugins?.allow ?? []).join(', '));
  }
  try {
    const names = Object.keys(install.parseEnvFile(await readFile(lay.env, 'utf8')));
    for (const n of names) { const known = profile ? n in profile.secrets : null; add('secrets', n, known, known === false ? 'not a name the profile uses (extra provider keys widen what OpenClaw can reach)' : null); }
  } catch { add('secrets', lay.env, false, 'missing'); }
  const rt = install.runtimeFor(lay, manifest);
  if (rt) for (const l of install.peerLinks(lay, rt.mjs)) add('plugins', l.plugin, l.ok, l.ok ? null : `peer link points at ${l.target}, not this install's tree; the plugin is unavailable until drover manager setup relinks it`);
  const launcher = await readFile(lay.launcher, 'utf8').catch(() => null);
  for (const [k, v] of Object.entries(install.EGRESS_ENV)) add('launcher', k, launcher == null ? false : new RegExp(`\\b${k}=${v}\\b`).test(launcher), launcher == null ? 'no generated launcher (pre-installer install); drover manager setup writes one' : null);
  const cp = profile?.egress?.cliproxy;
  if (cp?.config) {
    const file = cp.config.startsWith('~/') ? path.join(lay.home, cp.config.slice(2)) : cp.config;
    const text = await readFile(file, 'utf8').catch(() => null);
    if (text == null) add('cliproxy', file, null, 'not on this host');
    else for (const h of [...new Set([...text.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)].map((m) => m[1]))].sort()) add('cliproxy', h, (cp.allow ?? []).includes(h) || (cp.unused ?? []).includes(h), (cp.unused ?? []).includes(h) ? 'allowed, unused by the manager' : (cp.allow ?? []).includes(h) ? 'upstream' : 'unexpected upstream');
  }
  let peers = null;
  if (live) {
    const st = await _deps.serviceState(lay);
    peers = (await gatewayPeers(st.pid)).map((p) => {
      const ip = peerHost(p.peer);
      return { ...p, kind: /^(127\.|::1$|localhost$)/.test(ip) ? 'loopback' : allow.has(ip) ? 'allowed' : 'remote' };
    });
  }
  const unexpected = items.filter((i) => i.ok === false).map((i) => `${i.area}: ${i.name}${i.detail ? ` (${i.detail})` : ''}`);
  return { configured: true, ok: unexpected.length === 0, profile: profile?.name ?? null, unexpected, items, ...(peers ? { peers } : {}) };
}

export async function status() {
  const host = _deps.host();
  if (!configured()) return { configured: false, host, reason: `no ${path.join(stateDir(), 'openclaw.json')} on this host` };
  const lay = install.layout();
  const manifest = install.readManifest(lay);
  const profile = profileOf(manifest);
  const rt = install.runtimeFor(lay, manifest);
  const cfgText = await readFile(lay.config, 'utf8').catch(() => null);
  let cfg = null; try { cfg = cfgText ? JSON.parse(cfgText) : null; } catch { /* hand-edited */ }
  const actor = managerActor(cfg, manifest);
  const [unit, up, health, jobs, cost, evs, egress] = await Promise.all([
    _deps.serviceState(lay).catch(errInfo),
    _deps.alive(),
    cliJson(['health', '--timeout', '20000'], { profile }).then(healthInfo).catch(errInfo),
    cliJson(['automations', 'list', '--timeout', '30000'], { profile }).then(jobsInfo).catch(errInfo),
    cliJson(['gateway', 'usage-cost', '--days', '1', '--timeout', '30000'], { profile }).then(costInfo).catch(errInfo),
    _deps.readEvents().catch(() => []),
    check().catch(errInfo),
  ]);
  const dayAgo = _deps.now() - 24 * 3600_000;
  const mine = evs.filter((e) => isManagerEvent(e, { actor, host }) && Date.parse(e.ts) > dayAgo);
  const expected = manifest && cfg ? install.expectedConfig({ manifest, live: cfg, lay }) : null;
  const tokenCommand = existsSync(lay.oc) ? `${install.tildePath(lay, lay.oc)} gateway auth-token --show` : rt ? `OPENCLAW_STATE_DIR=${install.tildePath(lay, lay.state)} OPENCLAW_CONFIG_PATH=${install.tildePath(lay, lay.config)} ${rt.node} ${rt.mjs} gateway auth-token --show` : null;
  return {
    configured: true, host, role: manifest?.role ?? null, actor, scope: manifest?.scope ?? null,
    unit,
    gateway: { url: base(), up },
    health,
    // The sweep's effort is not in openclaw.json: the launcher hands it to the heartbeat-thinking patch.
    model: { ...modelInfo(cfg), heartbeatThinking: install.launcherHeartbeatThinking(await readFile(lay.launcher, 'utf8').catch(() => null)) },
    automations: jobs,
    cost,
    wal24h: { actor, notes: mine.filter((e) => e.type === 'note').length, pins: mine.filter((e) => e.type === 'pin').length, chats: mine.filter((e) => e.type === 'chat').length, events: mine.length, last: mine.at(-1)?.ts ?? null },
    install: manifest
      ? { managed: true, role: manifest.role, profile: manifest.profile, overlay: manifest.overlay ?? null, openclaw: manifest.openclaw?.version ?? null, node: manifest.node?.version ?? null, source: manifest.source ?? null, refreshedAt: manifest.refreshedAt ?? null, drift: expected ? install.diffPaths(cfg, expected) : null, legacy: install.legacyPaths(lay).filter((p) => existsSync(p)) }
      : { managed: false, runtime: rt?.from ?? null, hint: 'not installed by drover manager setup; run it (with --role) to manage this install' },
    checks: { egress: egress?.error ? egress : { ok: egress?.ok ?? null, unexpected: egress?.unexpected ?? [] } },
    langfuse: tracesInfo(cfg),
    // forward names this host by its hostname; a viewer elsewhere uses the ssh alias it reached this host by.
    dashboard: { port: port(), url: `http://127.0.0.1:${port()}/`, forward: `ssh -L ${port()}:127.0.0.1:${port()} ${host}`, tokenCommand, secretHint: tokenCommand ? `on ${host}: ${tokenCommand}` : null },
  };
}

/** Ask the manager to sweep now (a system event that wakes it immediately). */
export async function sweep({ text = 'sweep now' } = {}) {
  if (!configured()) throw new Error(`the manager is not configured on this host (no ${path.join(stateDir(), 'openclaw.json')})`);
  if (typeof text !== 'string' || !text.trim() || text.length > 500) throw new Error('text must be a short non-empty string');
  const lay = install.layout();
  const a = cliArgv(['system', 'event', '--text', text, '--mode', 'now', '--json']);
  if (!a) throw new Error('no OpenClaw install on this host (drover manager setup installs one)');
  const r = await _deps.run(a.file, a.argv, { env: install.cliEnv(lay, a.file, { profile: profileOf(install.readManifest(lay)) }), cwd: lay.home, timeoutMs: 90_000, okCodes: ANY_EXIT });
  if (r.code !== 0) throw new Error(install.cliError(r, ['system', 'event']));
  let out = null; try { out = install.parseCliJson(r.stdout); } catch { out = { raw: String(r.stdout ?? '').trim().slice(0, 400) }; }
  return { ok: true, queued: text, result: out };
}

/** This host's manager's recent truth-file events (notes, chat, messages, sweeps), newest first. */
export async function feed({ limit = 60, since } = {}) {
  const lim = Math.max(1, Math.min(500, Number(limit) || 60));
  const who = localManager();
  let evs = (await _deps.readEvents()).filter((e) => isManagerEvent(e, who));
  if (since) evs = evs.filter((e) => e.ts > since);
  return evs.slice(-lim).reverse().map((e) => ({ id: e.id, ts: e.ts, type: e.type, actor: e.actor, about: e.about ?? null, to: e.to?.name ?? e.to?.id ?? null, text: String(e.type === 'chat' && e.error ? `did not answer: ${e.error}` : e.text ?? e.title ?? e.notes ?? '').slice(0, 2000), ...(e.thread ? { thread: e.thread } : {}), host: e.host }));
}

export const consoleOps = {
  'openclaw.status': () => status(),
  'openclaw.check': (a = {}) => check(a),
  'openclaw.sweep': (a = {}) => sweep(a),
  'openclaw.feed': (a = {}) => feed(a),
  'openclaw.threads': () => threads(),
};
