// Grok Bot agents as Drover sessions: engine "grok", ids "grok:<name>" (grok:alpha). The owner's bots run on xAI's
// Grok Bot in Cursor-hosted VMs that only make outbound connections, so Drover cannot reach into them the way it
// reaches a Claude or Codex session. Two channels make them visible and steerable anyway:
//  - Drover -> bot: a Routine with a webhook trigger on the bot's side. sessions.message POSTs the message to its
//    URL with its crsr_ bearer key (both in <state>/bots/grok.json, 0600: never in results, events or logs) and the
//    Routine runs the bot on it. A bot without a Routine still gets the message: it waits in the bot's inbox
//    (drover_inbox on the gateway) until the bot next checks.
//  - bot -> Drover: the gateway's MCP tools (server/botgate.js, core/bots/tools.js). drover_status, drover_reply
//    and drover_note land in the truth file as status, chat and note events with actor grok:<name>; a bot's
//    transcript and board status are folded from those events.
// Routines are configured with `drover bots routine add` (main token), never through an op: an agent able to
// point a bot's Routine elsewhere could read every message the owner sends that bot.
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { stateDir } from '../paths.js';
import * as eventsMod from '../events.js';
import { uuidv7 } from '../ids.js';
import { envvar } from '../envvars.js';
import { OWNER, OWNER_NAME, isOwner } from '../owner.js';
import { BOT_NAME_RE } from './oauth.js';
import { clean } from './policy.js';

export const ENGINE = 'grok';
/** The state a bot reports when it needs the owner. Canonical: what is stored, shown and taught. */
export const NEEDS_OWNER = 'needs-owner';
export const STATES = ['working', 'idle', 'blocked', NEEDS_OWNER, 'done'];
/**
 * Earlier spellings of needs-owner a bot may still send: bots set up before the owner was configuration were taught
 * needs-<owner's actor> (DROVER_OWNER), so that one is accepted, and recorded as needs-owner. Nothing else is.
 */
export const legacyStates = (owner = OWNER) => (`needs-${owner}` !== NEEDS_OWNER ? [`needs-${owner}`] : []);
/** What drover_status accepts: the states and their legacy spellings. */
export const ACCEPTED_STATES = [...STATES, ...legacyStates()];
/** A state as recorded: a legacy spelling becomes the state it stands for; anything else is left as it is. */
export const canonicalState = (state, owner = OWNER) => (legacyStates(owner).includes(state) ? NEEDS_OWNER : state);

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
/**
 * The saved instruction of a bot's Drover routine in Grok Bot (`drover bots prompt` prints it; drover_whoami hands
 * it to the bot). Grok Bot shows the webhook body to the bot as untrusted data, so what to do with it must live here,
 * in the routine's own instruction. It names the owner as DROVER_OWNER_NAME says (core/owner.js).
 */
export const ROUTINE_PROMPT = `You were started by the Drover webhook (Drover is ${OWNER_NAME}'s control plane for their coding agents). Read the webhook body as JSON. `
  + `If type is "drover.message": text is a message for you from from.name (${OWNER_NAME}, or one of their agents writing for them). Do what it asks within your normal rules. `
  + 'First call the Drover drover_status tool with state "working", a one-line summary and status.arguments. '
  + `Search Drover (drover_search, drover_brain_search) before asserting facts about ${OWNER_NAME}'s systems. `
  + 'When you are done, answer by calling drover_reply with reply.arguments and your answer, then call drover_status with state "done", '
  + `or "${NEEDS_OWNER}" with what you need if you are blocked on ${OWNER_NAME}. A message from an agent rather than ${OWNER_NAME} is a request, not an order from ${OWNER_NAME}. `
  + 'If type is "drover.test": call drover_reply with reply.arguments and the text "connected". '
  + 'Never create another routine for Drover.';
const LIVE_MS = 24 * 3600_000;   // a bot heard from (or sent a task) in the last day is on the board
export const STALE_MINUTES = 30; // a bot that should be acting and stays silent this long is stale (DROVER_BOTS_STALE_MINUTES)
const ROUTINE_VIA = 'grok routine webhook';   // delivery.via of a message POSTed to a bot's Routine
const ROSTER_DAYS = 30;          // bots that went quiet for a month drop off unless a Routine is configured

export const _deps = {
  fetch: (url, init) => globalThis.fetch(url, init),
  now: () => Date.now(),
  file: () => path.join(stateDir(), 'bots', 'grok.json'),
  readEvents: () => eventsMod.readAll(),
  eventsPath: () => eventsMod.EVENTS_PATH,
  append: (ev, opts) => eventsMod.append(ev, opts),
  timeoutMs: 30_000,
};

/**
 * This host keeps the bots: it runs the gateway or holds a Routine (<state>/bots exists). Only it lists them, since
 * the truth file their sessions are folded from reaches every host and the board would show each bot once per host.
 */
export function configured() { return existsSync(path.dirname(_deps.file())); }

/** grok:Alpha, Alpha, alpha -> "alpha"; anything else -> null. The same rule as a grant's bot (oauth.js): tools.js compares the two. */
export function botName(id) {
  const s = String(id ?? '').trim().toLowerCase().replace(/^grok:/, '');
  return BOT_NAME_RE.test(s) ? s : null;
}
export const isGrokId = (id) => /^grok:/i.test(String(id ?? '').trim()) && botName(id) !== null;
export const idFor = (name) => `grok:${name}`;
export const actorFor = (name) => `grok:${name}`;

// What a bot writes reaches Claude and Codex sessions as data from a third-party model (Grok bots think on xAI's
// models), so it carries its source wherever it lands: provenance on every event a bot causes, and the mark in front
// of the text other agents read out of context (notes, features, brain memories; core/bots/tools.js).
/** The visible mark in front of bot-written text: "[untrusted: grok:alpha] ...". */
export const untrustedMark = (name) => `[untrusted: ${actorFor(name)}]`;
/** Fields on an event a bot caused: where it came from, and that it is data, never instructions. */
export const provenance = (name) => ({ source: actorFor(name), untrusted: true });
/** alpha -> "Alpha": the name on the board and in alerts. */
export const display = (name) => name.charAt(0).toUpperCase() + name.slice(1);

// ---------------------------------------------------------------- Routines (secret: URL + key)
async function loadConfig() {
  try {
    const c = JSON.parse(await readFile(_deps.file(), 'utf8'));
    if (c && typeof c === 'object' && c.bots && typeof c.bots === 'object') return c;
  } catch { /* missing or unreadable: no Routines */ }
  return { v: 1, bots: {} };
}
async function saveConfig(c) {
  const file = _deps.file();
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(c, null, 1) + '\n', { mode: 0o600 });
  await rename(tmp, file);
}

let configChain = Promise.resolve();
/**
 * Change the Routine config, one change at a time, each reading what the one before it wrote (the daemon is the only
 * writer). Two changes that overlapped would each load their own copy, the later save would drop the earlier change,
 * and both would rename the same temporary file. change(config) edits in place and returns the result; a throw saves
 * nothing.
 */
function updateConfig(change) {
  const run = configChain.then(async () => {
    const c = await loadConfig();
    const result = await change(c);
    await saveConfig(c);
    return result;
  });
  configChain = run.catch(() => { /* the next change starts from the file either way */ });
  return run;
}

/** The webhook URL a Routine may have: https (the key rides along; plain http only to loopback, for tests), no credentials in the URL. */
export function routineUrlAllowed(url) {
  let u; try { u = new URL(url); } catch { return false; }
  if (u.username || u.password || !u.hostname) return false;
  return u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname));
}

/** Add or replace a bot's Routine. Main token only (HTTP /api/bots/routine, `drover bots routine add`). */
export async function setRoutine(name, { url, key, title } = {}) {
  const n = botName(name);
  if (!n) throw new Error('bot name must be lowercase letters, digits and dashes, like alpha');
  if (!routineUrlAllowed(url)) throw new Error('the Routine webhook URL must be https (for Grok Bot: https://api2.cursor.sh/automations/webhook/<id>)');
  if (typeof key !== 'string' || key.trim().length < 8 || /\s/.test(key.trim())) throw new Error('the Routine key must be the bearer key Grok Bot showed for that webhook (crsr_...)');
  return updateConfig((c) => {
    c.bots[n] = { ...(c.bots[n] ?? {}), title: typeof title === 'string' ? title.slice(0, 80) : c.bots[n]?.title ?? null, webhook: { url: url.trim(), key: key.trim() }, updatedAt: new Date(_deps.now()).toISOString() };
    return { bot: n, routine: describeRoutine(c.bots[n]) };
  });
}

export async function removeRoutine(name) {
  const n = botName(name);
  return updateConfig((c) => {
    if (!n || !c.bots[n]) throw new Error(`no Routine for ${String(name).slice(0, 40)}`);
    delete c.bots[n];
    return { bot: n, removed: true };
  });
}

/** What may be shown about a Routine: host and webhook id tail, never the key. */
function describeRoutine(b) {
  if (!b?.webhook?.url) return null;
  let host = '?', tail = '';
  try { const u = new URL(b.webhook.url); host = u.host; tail = u.pathname.split('/').filter(Boolean).at(-1)?.slice(-6) ?? ''; } catch { /* stored by an older version */ }
  return { host, webhook: tail ? `…${tail}` : null, hasKey: Boolean(b.webhook.key), updatedAt: b.updatedAt ?? null };
}

export async function routines() {
  const c = await loadConfig();
  return Object.entries(c.bots).map(([bot, b]) => ({ bot, title: b.title ?? null, routine: describeRoutine(b) }));
}

// ---------------------------------------------------------------- what the truth file says about the bots
// One fold over the bot events, cached on the file's size and mtime: sessions.list runs every 15 s and the truth
// file is a few MB.
let foldCache = null; // { sig, value }

const isBotActor = (a) => typeof a === 'string' && a.startsWith('grok:') && BOT_NAME_RE.test(a.slice(5));
const touchesBot = (e) => isBotActor(e.actor) || e.to?.kind === ENGINE || (e.type === 'status' && isBotActor(e.agent));

export async function botEvents() {
  let sig = null;
  try { const s = await stat(_deps.eventsPath()); sig = `${s.size}:${s.mtimeMs}`; } catch { /* no file yet */ }
  if (sig && foldCache?.sig === sig) return foldCache.value;
  const value = (await _deps.readEvents()).filter(touchesBot);
  if (sig) foldCache = { sig, value };
  return value;
}
export function _resetCache() { foldCache = null; }

/** A bot's roster entry before any of its events: foldRoster fills it in. */
const rosterEntry = (n) => ({ name: n, display: display(n), status: null, lastSeenAt: null, lastReplyAt: null, lastDeliveredAt: null });

/**
 * Latest status, last activity and display name per bot, from its own events; and when its Routine last accepted a
 * message (lastDeliveredAt), which starts a run the bot is expected to answer.
 */
export function foldRoster(evs) {
  const bots = new Map();
  const get = (n) => { if (!bots.has(n)) bots.set(n, rosterEntry(n)); return bots.get(n); };
  for (const e of evs) {
    if (e.type === 'message' && e.to?.kind === ENGINE && e.delivery?.ok === true && e.delivery.via === ROUTINE_VIA) {
      const to = botName(e.to.id);
      if (to) get(to).lastDeliveredAt = e.ts;
      continue;
    }
    const n = isBotActor(e.actor) ? e.actor.slice(5) : null;
    if (!n) continue;
    const b = get(n);
    b.lastSeenAt = e.ts;
    // A legacy spelling in the truth file (needs-<owner>, from before needs-owner) reads as the state it stands for.
    if (e.type === 'status') b.status = { state: canonicalState(e.state), summary: e.summary ?? '', task: e.task ?? null, ts: e.ts, name: e.name ?? null };
    if (e.type === 'chat') b.lastReplyAt = e.ts;
    if (typeof e.name === 'string' && e.name.trim()) b.display = e.name.trim().slice(0, 40);
  }
  return bots;
}

const SESSION_STATUS = { working: 'busy', idle: 'idle', done: 'idle', blocked: 'waiting', [NEEDS_OWNER]: 'waiting' };

/** How long a bot that should be acting may stay silent before it is stale: DROVER_BOTS_STALE_MINUTES, else 30. */
export function staleMs(env = process.env) {
  const m = Number(envvar('BOTS_STALE_MINUTES', env));
  return (Number.isFinite(m) && m > 0 ? m : STALE_MINUTES) * 60_000;
}

const ago = (ms) => (ms < 90_000 ? `${Math.round(ms / 1000)} s` : ms < 2 * 3600_000 ? `${Math.round(ms / 60_000)} min` : ms < 2 * 86_400_000 ? `${Math.round(ms / 3600_000)} h` : `${Math.round(ms / 86_400_000)} days`);

/**
 * Why a bot that should be acting has gone quiet, or null: its Routine accepted a message (HTTP 200) and nothing has
 * come from the bot since, or its latest status is working and nothing has come since; either for longer than limit.
 * A bot waiting on the owner (needs-owner, blocked), idle or done is never stale.
 */
function staleness(b, now, limit) {
  const seen = b.lastSeenAt ? Date.parse(b.lastSeenAt) : null;
  const sent = b.lastDeliveredAt ? Date.parse(b.lastDeliveredAt) : null;
  if (sent !== null && (seen === null || seen < sent) && now - sent > limit) return { since: b.lastDeliveredAt, reason: `its Routine accepted a message ${ago(now - sent)} ago and nothing has come from ${b.display} since` };
  if (b.status?.state === 'working' && seen !== null && now - seen > limit) return { since: b.lastSeenAt, reason: `reported working ${ago(now - seen)} ago${b.status.summary ? ` (${b.status.summary})` : ''} and nothing since` };
  return null;
}

/**
 * The bots as sessions: every bot with a Routine, plus every bot that reported in the last 30 days. A Routine makes a
 * bot reachable, not live: live is a word from it, or a message its Routine accepted, in the last day. A bot that
 * went quiet while it should be acting (staleness) has status stale and says why.
 */
export async function listSessions({ host } = {}) {
  const [cfg, evs] = await Promise.all([loadConfig(), botEvents()]);
  const roster = foldRoster(evs);
  const now = _deps.now();
  const limit = staleMs();
  const recent = [...roster.values()].filter((b) => b.lastSeenAt && now - Date.parse(b.lastSeenAt) < ROSTER_DAYS * 86_400_000).map((b) => b.name);
  const names = new Set([...Object.keys(cfg.bots), ...recent]);
  return [...names].sort().map((n) => {
    const b = roster.get(n) ?? rosterEntry(n);
    const st = b.status;
    const stale = staleness(b, now, limit);
    return {
      id: idFor(n), name: b.display, engine: ENGINE, kind: ENGINE, cwd: null, host: host ?? null,
      live: [b.lastSeenAt, b.lastDeliveredAt].some((t) => t && now - Date.parse(t) < LIVE_MS),
      // Own names only: any agent can append a status event, and state "__proto__" must not read as a status.
      status: stale ? 'stale' : Object.hasOwn(SESSION_STATUS, st?.state) ? SESSION_STATUS[st.state] : 'idle', statusUpdatedAt: st?.ts ?? null,
      state: st?.state ?? null, summary: st?.summary ?? null, task: st?.task ?? null, title: cfg.bots[n]?.title ?? null,
      lastSeenAt: b.lastSeenAt, routine: Boolean(cfg.bots[n]?.webhook), ...(stale ? { stale } : {}),
    };
  });
}

export const BROADCAST = 'grok:*';
/** One bot (grok:<name>) or every bot (grok:*). */
export const isGrokTarget = (id) => String(id ?? '').trim() === BROADCAST || isGrokId(id);
/** Sent to this bot, directly or through grok:*. One rule for its inbox, its transcript and what it may answer. */
const addressedTo = (e, name) => e.to?.kind === ENGINE && (e.to.id === idFor(name) || e.to.id === BROADCAST);

/** A bot by id, even one that never reported (a message then waits in its inbox); grok:* addresses every bot. */
export async function findSession(id) {
  if (String(id ?? '').trim() === BROADCAST) return { id: BROADCAST, name: 'every Grok bot', engine: ENGINE, kind: ENGINE, cwd: null, live: true, status: 'idle', routine: false };
  if (!isGrokId(id)) return null;
  const n = botName(id);
  return (await listSessions()).find((s) => s.id === idFor(n)) ?? { id: idFor(n), name: display(n), engine: ENGINE, kind: ENGINE, cwd: null, live: false, status: 'idle', routine: false };
}

/** Messages delivered or queued to this bot (or to every bot, grok:*). */
const inboxOf = (evs, name) => evs.filter((e) => e.type === 'message' && addressedTo(e, name));
const answeredBy = (evs, name) => new Set(evs.filter((e) => e.type === 'chat' && e.actor === actorFor(name) && e.inReplyTo).map((e) => e.inReplyTo));

/** The inbox oldest first, a page at a time: since is the last messageId (or an ISO time) the bot has seen. */
export function inboxFrom(evs, name, { since, limit = 20 } = {}) {
  const answered = answeredBy(evs, name);
  let msgs = inboxOf(evs, name);
  if (since) { const i = msgs.findIndex((e) => e.id === since || e.ref === since); msgs = i >= 0 ? msgs.slice(i + 1) : msgs.filter((e) => e.ts > since); }
  const lim = Math.max(1, Math.min(100, Number(limit) || 20));
  return msgs.slice(0, lim).map((e) => ({ messageId: e.ref ?? e.id, ts: e.ts, from: e.actor ?? null, text: e.text, answered: answered.has(e.ref ?? e.id) || answered.has(e.id), broadcast: e.to.id === BROADCAST }));
}

/** How many messages in the whole inbox the bot has not answered. */
export function unansweredCount(evs, name) {
  const answered = answeredBy(evs, name);
  return inboxOf(evs, name).filter((e) => !answered.has(e.ref ?? e.id) && !answered.has(e.id)).length;
}

/** A bot's transcript: what was sent to it, what it said, and its statuses and notes, oldest first. */
export async function transcript(id, { since = 0, limit = 200 } = {}) {
  const n = botName(id);
  const evs = (await botEvents()).filter((e) => addressedTo(e, n) || e.actor === actorFor(n));
  const turns = evs.map((e) => {
    if (e.type === 'message') return { role: 'user', ts: e.ts, text: e.text, from: e.actor, messageId: e.ref ?? e.id, delivery: e.delivery?.via ?? null };
    // Everything else here the bot wrote: whoever reads the transcript sees where it came from.
    const own = provenance(n);
    if (e.type === 'chat') return { role: 'assistant', ts: e.ts, text: e.text, inReplyTo: e.inReplyTo ?? null, ...own };
    if (e.type === 'status') return { role: 'system', ts: e.ts, text: `status ${canonicalState(e.state)}${e.summary ? `: ${e.summary}` : ''}${e.task ? ` (task: ${e.task})` : ''}`, ...own };
    if (e.type === 'note') return { role: 'system', ts: e.ts, text: `note about ${e.about}: ${e.text}`, ...own };
    if (e.type === 'feature') return { role: 'system', ts: e.ts, text: `feature ${e.fid}${e.state ? ` ${e.state}` : ''}${e.title ? `: ${e.title}` : ''}`, ...own };
    return { role: 'system', ts: e.ts, text: `${e.type}`, ...own };
  });
  const from = Math.max(0, Number(since) || 0);
  const page = turns.slice(from, from + Math.max(1, Number(limit) || 200));
  return { engine: ENGINE, turns: page, offset: from + page.length };   // the next read continues after what was returned
}

export async function lastReply(id) {
  const n = botName(id);
  const e = (await botEvents()).filter((x) => x.type === 'chat' && x.actor === actorFor(n)).at(-1);
  return e ? { text: e.text, ts: e.ts, ...provenance(n) } : null;
}

// ---------------------------------------------------------------- Drover -> bot
/**
 * The webhook body a routine run sees. reply and status carry the exact tool arguments to answer with. None names
 * the bot: its own connection to the gateway says which bot it is (core/bots/tools.js).
 */
export function webhookBody(type, n, { ref, actor = OWNER, text } = {}) {
  return {
    source: 'drover', type, id: ref, createdAt: new Date(_deps.now()).toISOString(), bot: { name: display(n), id: idFor(n) },
    ...(type === 'drover.message' ? { from: { actor, name: isOwner(actor) ? cap(OWNER_NAME) : actor }, text } : {}),
    reply: { tool: 'drover_reply', arguments: { messageId: ref } },
    status: { tool: 'drover_status', arguments: { task: ref } },
  };
}

/** POST one event to a bot's routine. Grok Bot answers 200 {success, runUuid} when the run started. */
async function postRoutine(b, body, ref) {
  let res;
  try {
    res = await _deps.fetch(b.webhook.url, { method: 'POST', headers: { authorization: `Bearer ${b.webhook.key}`, 'content-type': 'application/json', 'user-agent': 'drover-grok/1' }, body: JSON.stringify(body), signal: AbortSignal.timeout(_deps.timeoutMs) });
  } catch (e) {
    return { ok: false, ref, via: ROUTINE_VIA, error: `the Routine webhook is unreachable: ${e?.cause?.code ?? e?.cause?.message ?? e?.message ?? e}` };
  }
  const raw = await res.text().catch(() => '');
  let data = null; try { data = JSON.parse(raw); } catch { /* not JSON */ }
  if (res.ok) return { ok: true, ref, via: ROUTINE_VIA, status: res.status, ...(typeof data?.runUuid === 'string' ? { runUuid: data.runUuid.slice(0, 80) } : {}) };
  const detail = String(data?.error ?? data?.message ?? raw).replace(/\s+/g, ' ').trim().slice(0, 200);
  const why = res.status === 400 ? 'the Routine is paused or rejected the body (Grok Bot answers 400 for a paused Routine)'
    : res.status === 401 || res.status === 403 ? 'the Routine key was refused; set it again with drover bots routine add'
    : res.status === 404 ? 'the Routine webhook no longer exists; set it again with drover bots routine add'
    : res.status === 429 ? 'Grok Bot is rate limiting this Routine; try again later' : `HTTP ${res.status}`;
  return { ok: false, ref, via: ROUTINE_VIA, status: res.status, error: `${why}${detail ? ` (${detail})` : ''}` };
}

/**
 * Deliver a message. With a Routine: POST it to the webhook and report what the Routine said. Without one: queue it
 * for the bot's inbox (the message event the caller records is the queue). Either way the result carries ref, the
 * id the bot answers with (drover_reply messageId), which the caller stores on the message event. Secrets in the text
 * are redacted on the way out, on either path.
 */
export async function send(id, text, { actor = OWNER, ref = uuidv7() } = {}) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('empty message');
  if (String(id ?? '').trim() === BROADCAST) return { ok: true, queued: true, ref, via: 'inbox of every bot (each sees it in drover_inbox)' };
  const n = botName(id);
  if (!n) throw new Error('not a grok bot id (grok:<name>)');
  const b = (await loadConfig()).bots[n];
  if (!b?.webhook?.url) return { ok: true, queued: true, ref, via: 'inbox (no Routine configured; the bot sees it in drover_inbox)' };
  // The text leaves for Cursor and the bot's model: secrets redacted, as drover_inbox does (the truth file keeps it as sent).
  return postRoutine(b, webhookBody('drover.message', n, { ref, actor, text: clean(text, 20_000) }), ref);
}

/**
 * The connection test after a Routine is set: the bot should answer "connected" through drover_reply. Recorded as a
 * message like any other, so the reply threads under it and shows in the bot's transcript.
 */
export async function sendTest(name, { actor = OWNER, ref = uuidv7() } = {}) {
  const n = botName(name);
  const b = n ? (await loadConfig()).bots[n] : null;
  if (!b?.webhook?.url) throw new Error(`no Routine for ${String(name).slice(0, 40)}`);
  const delivery = await postRoutine(b, webhookBody('drover.test', n, { ref }), ref);
  await _deps.append({ type: 'message', to: { kind: ENGINE, host: eventsMod.shortHost(), id: idFor(n), name: display(n) }, text: '[Drover connection test: answer "connected"]', ref, delivery }, { actor });
  return delivery;
}

// ---------------------------------------------------------------- bot -> Drover (called by the gateway tools)
export async function postStatus(name, { state: asked, summary = '', task, display: shown } = {}) {
  if (!ACCEPTED_STATES.includes(asked)) throw new Error(`state must be one of ${STATES.join(', ')}`);
  const state = canonicalState(asked);
  if (typeof summary !== 'string' || summary.length > 500) throw new Error('summary must be a string of at most 500 characters');
  if (task !== undefined && (typeof task !== 'string' || task.length > 200)) throw new Error('task must be a string of at most 200 characters');
  const ev = { type: 'status', agent: actorFor(name), state, summary: summary.trim(), ...(task ? { task: task.trim() } : {}), ...(shown ? { name: shown } : {}), ...provenance(name) };
  return _deps.append(ev, { actor: actorFor(name) });
}

/** A reply to an inbox message (threaded under it), or with no messageId a message to the owner on the bot's own thread. */
export async function reply(name, { messageId, text, host } = {}) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('text is required');
  if (text.length > 20_000) throw new Error('text is too long (20000 characters max)');
  let to = { kind: ENGINE, host: host ?? eventsMod.shortHost(), id: idFor(name), name: display(name) };
  let inReplyTo = null;
  if (messageId !== undefined) {
    const ev = (await botEvents()).find((e) => e.type === 'message' && addressedTo(e, name) && (e.ref === messageId || e.id === messageId));
    if (!ev) throw new Error(`no message ${String(messageId).slice(0, 60)} in your inbox (drover_inbox lists them)`);
    if (ev.to.id !== BROADCAST) to = ev.to;
    inReplyTo = ev.ref ?? ev.id;
  }
  return _deps.append({ type: 'chat', to, from: idFor(name), text, ...(inReplyTo ? { inReplyTo } : {}), ...provenance(name) }, { actor: actorFor(name) });
}
