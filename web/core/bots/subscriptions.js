// Push subscriptions: a Grok bot asks Drover to run its Routine when something it cares about happens, instead of
// sweeping the fleet on a timer that usually finds nothing. The bot subscribes (drover_subscribe, core/bots/tools.js);
// the daemon on the host that keeps the bots collects what happened, batches it per bot, and POSTs one body of type
// drover.events to the bot's Routine (core/bots/grok.js eventsBody), at most every minIntervalMinutes.
//  - owner-waiting: a session on any machine starts waiting on the owner: a needs-you or held alert about a session that
//    this daemon raises or pulls from another host (a dialog, a question, a hook's notification), not a bot's, not a
//    test, not muted, and never Drover's own (a bot or a device asking to connect is the owner's business alone).
//  - bot-needs-owner: another bot goes blocked or needs the owner (its status), or asks the owner for an approval.
//  - inbox: a message reaches the bot's inbox that its Routine did not already run on (a broadcast to grok:*, one its
//    Routine refused, one sent before it had a Routine).
//  - The statuses, approvals and messages are read from the truth file as it grows (a stat every few seconds, the new
//    bytes only), not from this process's appends: `drover rpc` runs another host's ops in its own process, so its
//    appends never reach this one's listeners. A file rewritten in place (dotsync) restarts at its end.
//  - A push says no more than the bot could read with its own tools (drover_fleet, drover_inbox): which session on
//    which machine and what kind of wait, never a dialog's text; another bot's state and summary (that bot's words,
//    marked untrusted), never its approval question; an inbox message's id and sender, never its text. It is not a
//    message: nothing lands in the inbox, nothing needs an answer.
//  - Only a bot with a Routine and a live connection of its own (not shared, not a tenant's) that may read gets
//    pushes: revoke it and they stop. The first event waits debounceMs() for company; pushes are at least
//    minIntervalMinutes apart and at most PUSHES_PER_DAY attempts a day (failed ones count); one carries at most
//    BATCH_MAX events (the rest counted). A failed push is tried again at the next window, and its batch dropped after
//    FAILURES_MAX in a row. The pace outlives the subscription: unsubscribing and subscribing again resets nothing.
//  - A restart loses nothing and tells nothing twice: the store keeps what waits, how far the truth file was read into
//    it and the ids of what it told (one record), and the daemon carries on from there, so what was appended while it
//    was down is read when it is back (up to READ_MAX of it; more is skipped). The position is stored when someone
//    subscribes and at least every CURSOR_EVERY_MS while it moves; one stored while no one subscribed is not used. An
//    attempt is stored before it goes out, and the store takes what it carries as gone out, so one out when the daemon
//    stopped is neither forgotten nor sent again; a push the store cannot record first is not sent.
//  - The owner sees and ends subscriptions with the main token (/api/bots/subscriptions, `drover bots
//    subscriptions`), never an op. The store is <state>/bots/subscriptions.json (0600).
import { open, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stateDir } from '../paths.js';
import { uuidv7 } from '../ids.js';
import { envvar } from '../envvars.js';
import * as eventsMod from '../events.js';
import * as settingsMod from '../settings.js';
import { OWNER_NAME } from '../owner.js';
import { muteFor } from '../../ui/notify-policy.js';
import * as grok from './grok.js';
import * as botAuth from './oauth.js';
import { clean, cleanId } from './policy.js';
import { isTenantBot } from './access.js';

export const EVENTS = ['owner-waiting', 'bot-needs-owner', 'inbox'];
export const MIN_INTERVAL = { def: 10, min: 5, max: 1440 };   // minutes between pushes, as the bot asks
export const PUSHES_PER_DAY = 144;
export const BATCH_MAX = 50;
export const FAILURES_MAX = 3;
/** How long the first event waits for company: DROVER_BOTS_PUSH_DEBOUNCE_SECONDS, else a minute. */
export function debounceMs(env = process.env) {
  const s = Number(envvar('BOTS_PUSH_DEBOUNCE_SECONDS', env));
  return (Number.isFinite(s) && s > 0 ? s : 60) * 1000;
}
const TAIL_MS = 5_000;
const TIMER_MAX_MS = 2 ** 31 - 1;   // the longest delay a Node timer keeps (a longer one fires at once): it wakes, and waits again
const READ_MAX = 4 * 1024 * 1024;   // new bytes read per look; a burst larger than this is skipped, not replayed
const CURSOR_EVERY_MS = 60_000;     // the read position is stored at least this often while it moves (and someone subscribes)
const KEPT_IDS = 500;               // ids of the events handed on that the store keeps, so a line written again is told once

export const _deps = {
  file: () => path.join(stateDir(), 'bots', 'subscriptions.json'),
  eventsPath: () => eventsMod.EVENTS_PATH,
  now: () => Date.now(),
  post: (name, body) => grok.postEvents(name, body),
  hasRoutine: (name) => grok.hasRoutine(name),
  grants: () => botAuth.grantsList(),
  settings: async () => (await settingsMod.current()).settings,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t),
};

// ---------------------------------------------------------------- the store
async function load() {
  try {
    const c = JSON.parse(await readFile(_deps.file(), 'utf8'));
    if (c && typeof c === 'object' && c.bots && typeof c.bots === 'object' && !Array.isArray(c.bots)) return c;
  } catch { /* missing or unreadable: none */ }
  return { v: 1, bots: {} };
}
async function save(c) {
  const file = _deps.file();
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(c, null, 1) + '\n', { mode: 0o600 });
  await rename(tmp, file);
}
let chain = Promise.resolve();
/** One at a time, each reading what the one before it wrote (as grok.js updateConfig). */
function inTurn(fn) {
  const run = chain.then(fn);
  chain = run.catch(() => { /* the next one starts from the file either way */ });
  return run;
}
const update = (change) => inTurn(async () => { const c = await load(); const r = await change(c); await save(c); return r; });
const own = (c, n) => (Object.hasOwn(c.bots, n) ? c.bots[n] : null);
/** What a push repeats of an event or alert: cleaned (secrets redacted) and short, whoever wrote it. */
const textOf = (v, max = 120) => (v === undefined || v === null || v === '' ? null : clean(String(v), max));
/** An id it repeats (a session id, a message ref): as drover_fleet and drover_inbox show it, UUIDs whole; short. */
const idOf = (v, max = 120) => (v === undefined || v === null || v === '' ? null : cleanId(String(v), max));
const timeOf = (v) => { const t = Date.parse(v ?? ''); return new Date(Number.isFinite(t) ? t : _deps.now()).toISOString(); };
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Whether a stored subscription wants this kind of event (a store can be old or edited: events may be anything). */
const wants = (s, kind) => Array.isArray(s?.events) && s.events.includes(kind);

function eventsArg(v) {
  if (v === undefined || v === null) return [...EVENTS];
  if (!Array.isArray(v) || !v.length || v.some((e) => !EVENTS.includes(e))) throw new Error(`events must be some of ${EVENTS.join(', ')}`);
  return EVENTS.filter((e) => v.includes(e));
}
/** The interval a stored subscription paces by: its own when it is one subscribe() takes, else the default (a store can be old or edited). */
const intervalMs = (s) => (Number.isInteger(s?.minIntervalMinutes) && s.minIntervalMinutes >= MIN_INTERVAL.min && s.minIntervalMinutes <= MIN_INTERVAL.max ? s.minIntervalMinutes : MIN_INTERVAL.def) * 60_000;
function minutesArg(v) {
  if (v === undefined || v === null) return MIN_INTERVAL.def;
  const m = Number(v);
  if (!Number.isInteger(m) || m < MIN_INTERVAL.min || m > MIN_INTERVAL.max) throw new Error(`minIntervalMinutes must be a whole number from ${MIN_INTERVAL.min} to ${MIN_INTERVAL.max}`);
  return m;
}

/** What the bot (whoami) and the owner see of a subscription. */
function view(n, s, c, now = _deps.now()) {
  if (!s) return null;
  const b = batches.get(n);
  return {
    events: s.events, minIntervalMinutes: s.minIntervalMinutes, createdAt: s.createdAt, lastPushAt: s.lastPushAt ?? null,
    lastResult: s.lastResult ?? null, pushesToday: paceOf(c, n).today(dayOf(now)), waiting: b ? b.items.size + overOf(b) : 0,
  };
}

/** The bot `name` subscribes (or changes what to): it needs a Routine for Drover to run. */
export async function subscribe(name, { events, minIntervalMinutes } = {}) {
  const n = grok.botName(name);
  if (!n) throw new Error('not a Grok bot');
  const list = eventsArg(events), minutes = minutesArg(minIntervalMinutes);
  if (!(await _deps.hasRoutine(n))) throw new Error(`refused: Drover pushes by running your Drover routine, and you have none yet: ask ${OWNER_NAME} to set one up (drover_whoami routine says how)`);
  const r = await update((c) => {
    const now = _deps.now(), was = own(c, n);
    c.bots[n] = { ...(was ?? {}), events: list, minIntervalMinutes: minutes, createdAt: was?.createdAt ?? new Date(now).toISOString(), updatedAt: new Date(now).toISOString() };
    remember(c);   // from here on: where the file was read to, so a restart reads on from now, never from before
    return view(n, c.bots[n], c, now);
  });
  subsCache = null;
  // What it no longer wants goes from the batch waiting for it, and what waits keeps the new interval.
  const b = batches.get(n);
  if (b) {
    for (const [k, e] of b.items) if (!list.includes(e.item.kind)) b.items.delete(k);
    for (const kind of [...b.over.keys()]) if (!list.includes(kind)) b.over.delete(kind);
    if (b.timer) { _deps.clearTimeout(b.timer); b.timer = null; }
    if (!b.items.size) drop(n);   // a count of overflowed events alone is never a push
    await update((c) => { remember(c); const s = own(c, n); if (s && batches.has(n)) schedule(n, s, paceOf(c, n)); }).catch(() => { /* stored with the next change */ });
  }
  return r;
}

/** End the bot's subscription (the bot, or the owner with the main token). */
export async function unsubscribe(name) {
  const n = grok.botName(name);
  if (!n) throw new Error('not a Grok bot');
  // The pace stays (c.pace): a bot that unsubscribes and subscribes again gets no sooner push for it.
  const removed = await update((c) => { const had = Boolean(own(c, n)); delete c.bots[n]; if (c.pending) delete c.pending[n]; return had; });
  subsCache = null;
  drop(n);
  return { bot: grok.idFor(n), removed };
}

export async function forBot(name) {
  const n = grok.botName(name);
  if (!n) return null;
  const c = await load();
  return view(n, own(c, n), c);
}

/** Every subscription, for the owner (the route, `drover bots subscriptions`). */
export async function list() {
  const c = await load();
  return Object.entries(c.bots).sort(([a], [b]) => a.localeCompare(b)).map(([n, s]) => ({ bot: grok.idFor(n), name: grok.display(n), ...view(n, s, c) }));
}

// ---------------------------------------------------------------- what happened
/** A needs-you or held alert about a session (never a bot's: those come from the truth file) -> owner-waiting. */
export function fromAlert(a) {
  if (!a || a.test || a.muted || !['needs-you', 'held'].includes(a.category)) return null;
  if (grok.isGrokId(a.sessionId ?? '') || a.engine === grok.ENGINE || a.kind === 'approval') return null;
  // A session, which the bot can look at with drover_fleet: not Drover's own asks (a bot or a device that wants to
  // connect, whose code is the owner's to check) nor an alert that names no session.
  if (a.source === 'bots' || a.kind === 'bot-auth' || a.kind === 'pair' || (!a.sessionId && !a.target)) return null;
  const wait = a.category === 'held' ? 'is holding a peer message' : a.ask?.label ?? 'needs you';
  const at = timeOf(a.ts);
  return {
    key: `owner-waiting|${String(a.host ?? '').slice(0, 120)}|${String(a.sessionId ?? a.target ?? a.name ?? '').slice(0, 200)}`,
    about: null,
    // What this host's mutes look at: an alert pulled from another host was judged by that host's settings.
    mute: muteOf({ category: a.category, host: a.host, sessionId: a.sessionId, name: a.name, target: a.target, engine: a.engine }),
    // An alert can carry what an agent chose (notify.send): every field cleaned and short.
    item: { kind: 'owner-waiting', at, host: textOf(a.host, 80), session: { id: idOf(a.sessionId), name: textOf(a.name), engine: textOf(a.engine, 40) }, wait: clean(wait, 80) },
  };
}

/** What the owner's mutes look at for a bot's own event: the bot as a session, on the host the event came from. */
const botMute = (n, host) => ({ category: 'needs-you', sessionId: grok.idFor(n), name: grok.display(n), engine: grok.ENGINE, host: textOf(host, 80) });

/**
 * A truth-file event -> what it means for subscribers: { key, about (the bot it concerns, which is not told), to (only
 * this bot, for inbox), item }, or null. Statuses and approvals of bots, messages to bots.
 */
export function fromEvent(ev) {
  if (!ev || typeof ev !== 'object') return null;
  if (ev.type === 'status' && grok.isGrokId(ev.agent ?? '')) {
    const state = grok.canonicalState(ev.state);
    if (state !== 'blocked' && state !== grok.NEEDS_OWNER) return null;
    const n = grok.botName(ev.agent);
    return { id: ev.id, key: `bot-needs-owner|${ev.agent}|status`, about: n, mute: botMute(n, ev.host), item: { kind: 'bot-needs-owner', at: timeOf(ev.ts), bot: grok.idFor(n), name: grok.display(n), state, summary: `${grok.untrustedMark(n)} ${clean(ev.summary ?? '', 500)}` } };
  }
  // A request is between that bot and the owner: that one waits, never what it asks.
  if (ev.type === 'approval' && ev.state === 'pending' && grok.isGrokId(ev.bot ?? '')) {
    const n = grok.botName(ev.bot);
    return { id: ev.id, key: `bot-needs-owner|${ev.bot}|approval`, about: n, mute: botMute(n, ev.host), item: { kind: 'bot-needs-owner', at: timeOf(ev.ts), bot: grok.idFor(n), name: grok.display(n), state: 'approval' } };
  }
  if (ev.type === 'message' && ev.to?.kind === grok.ENGINE) {
    const broadcast = ev.to.id === grok.BROADCAST;
    const to = broadcast ? null : grok.botName(ev.to.id);
    if (!broadcast && (!to || grok.deliveredByRoutine(ev))) return null;   // its Routine ran on it already
    const from = grok.isGrokId(ev.actor ?? '') ? grok.botName(ev.actor) : null;
    const messageId = idOf(ev.ref ?? ev.id);
    return { id: ev.id, key: `inbox|${messageId}`, about: from, to, item: { kind: 'inbox', at: timeOf(ev.ts), messageId, from: textOf(ev.actor), broadcast } };
  }
  return null;
}

// ---------------------------------------------------------------- batches and pushes (the daemon)
// bot -> { items: Map(key -> { item, mute }), over: Map(kind -> how many did not fit), firstAt, failures, timer,
// sending: the entries a push in flight carries, sendingOver: the counts it carries (with those of its entries that
// newer ones pushed out of the batch while it was out) }
const batches = new Map();
const overOf = (b) => [...b.over.values()].reduce((a, c) => a + c, 0);
const flushing = new Set();
const memPace = new Map();   // bot -> { lastAttemptAt, day, today }: the pace as this process last knew it
const ahead = new Map();     // bot -> { t, at }: a stored last attempt later than now, and the moment it counts as (paceOf)
let subsCache = null;        // the store, re-read after each change (subscribe, unsubscribe, a push)
let collected = null;        // how far the truth file has been read into the batches (position()), as the store keeps it
let restoring = null;        // start(): what the store kept, being put back before anything else is collected
let storedPos = null, storedAt = 0;   // the position the store was last given, and when
const keptIds = new Set();   // ids of the events handed on (the last KEPT_IDS), kept in the store with the position
function keep(id) {
  if (typeof id !== 'string' || !id) return;
  keptIds.delete(id); keptIds.add(id);
  if (keptIds.size > KEPT_IDS) keptIds.delete(keptIds.values().next().value);
}

/**
 * What the store keeps of a batch. What a push in flight carries counts as gone out (with its overflow counts), so a
 * restart while it is out never sends it again; null when nothing is left to push.
 */
function stored(b) {
  const items = [...b.items].filter(([, e]) => !b.sending?.has(e)).map(([key, e]) => ({ key, item: e.item, mute: e.mute }));
  if (!items.length) return null;   // a count of overflowed events alone is never a push
  const over = {};
  for (const [kind, c] of b.over) { const left = c - (b.sendingOver?.get(kind) ?? 0); if (left > 0) over[kind] = left; }
  return { items, over, firstAt: b.firstAt, failures: b.sending ? 0 : b.failures };
}
/** Into a store record being written: every batch, how far the file was read into them and what was told, as one. */
function remember(c) {
  const pending = {};
  for (const [n, b] of batches) { const x = stored(b); if (x) pending[n] = x; }
  c.pending = pending;
  if (collected) { c.cursor = collected; storedPos = collected; storedAt = _deps.now(); }
  c.seen = [...keptIds];
}

function drop(n) {
  const b = batches.get(n);
  if (b?.timer) _deps.clearTimeout(b.timer);
  batches.delete(n);
}

/**
 * How fast the bot may be pushed to: when it last was (an attempt, failed or not) and how many attempts the day
 * holds. Kept apart from the subscription, so unsubscribing and subscribing again starts no new pace, and the
 * larger of the store and this process's memory wins, so a store that could not be written never makes it sooner.
 * A time later than now (a clock set back since, an edited store) counts as the moment this process first met it, and
 * stays that: it neither holds the bot's pushes until the clock gets there nor moves with the clock. This process's
 * own time is set back in place; the store's is pinned in `ahead` for as long as the store says it.
 */
function paceOf(c, n) {
  const d = (c?.pace && Object.hasOwn(c.pace, n) ? c.pace[n] : null) ?? {}, m = memPace.get(n) ?? {}, now = _deps.now();
  if (Date.parse(m.lastAttemptAt ?? '') > now) m.lastAttemptAt = new Date(now).toISOString();
  let stored = Date.parse(d.lastAttemptAt ?? '') || 0;
  if (stored > now) {
    if (ahead.get(n)?.t !== stored) ahead.set(n, { t: stored, at: now });
    stored = ahead.get(n).at;
  } else ahead.delete(n);
  return {
    last: Math.max(stored, Date.parse(m.lastAttemptAt ?? '') || 0),
    today: (day) => Math.max(d.day === day ? d.today ?? 0 : 0, m.day === day ? m.today ?? 0 : 0),
  };
}

/** The store's paces, to write one into: an object, whatever an edited store holds there. */
const pacesOf = (c) => (c.pace && typeof c.pace === 'object' && !Array.isArray(c.pace) ? c.pace : (c.pace = {}));

/** What the owner's mutes are matched against for a queued entry: those fields only, each bounded (an alert can carry what an agent chose). */
const capped = (v) => (v === undefined || v === null || v === '' ? null : String(v).slice(0, 200));
const muteOf = (m) => (m && typeof m === 'object' && !Array.isArray(m) ? { category: capped(m.category), host: capped(m.host), sessionId: capped(m.sessionId), name: capped(m.name), target: capped(m.target), engine: capped(m.engine) } : null);

/** Owner mutes hold for pushes too: what the owner muted does not wake their bots either (an inbox message has none). */
function mutedFor(x, settings) {
  return Boolean(settings && x.mute && muteFor(x.mute, settings, _deps.now()));
}

/**
 * Hand what happened to every bot that subscribed to it (never to the bot it is about), and store the batches. `through`
 * (the tail's look, position()) is how far the truth file has been read into them once these are in.
 */
export async function collect(found, { through } = {}) {
  if (restoring) await restoring;
  const list = (Array.isArray(found) ? found : [found]).filter(Boolean);
  const c = subsCache ?? (subsCache = await load());
  const anyone = Object.keys(c.bots).length > 0;
  const settings = list.length && anyone ? await _deps.settings().catch(() => null) : null;
  // From the adds to `collected` nothing waits: a store record written meanwhile has both or neither.
  let added = 0;
  if (anyone) for (const x of list) {
    if (through !== undefined) keep(x.id);   // read from the file: a line written there again is not told again
    if (mutedFor(x, settings)) continue;
    for (const [n, s] of Object.entries(c.bots)) {
      if (!wants(s, x.item.kind) || x.about === n || (x.to && x.to !== n)) continue;
      add(n, s, x, paceOf(c, n));
      added++;
    }
  }
  if (through !== undefined) collected = through;
  // Stored when anything came in, or when the file was read past lines that matter (muted ones too: a restart reads
  // them again only to skip them again), and while someone subscribes at least every CURSOR_EVERY_MS that it moved:
  // lines that matter to no one are only read again for nothing, but their bytes count toward READ_MAX after a restart.
  const moved = through && (storedPos?.ino !== through.ino || storedPos?.size !== through.size);
  const due = moved && _deps.now() - storedAt >= CURSOR_EVERY_MS;
  if (added || (through !== undefined && anyone && (list.length || due))) await update((c2) => remember(c2)).catch(() => { /* kept in memory; stored with the next change */ });
  return added;
}

function add(n, s, x, pace) {
  let b = batches.get(n);
  if (!b) batches.set(n, b = { items: new Map(), over: new Map(), firstAt: _deps.now(), failures: 0, timer: null, sending: null, sendingOver: null });
  b.items.delete(x.key);   // the latest of the same thing, at the end
  b.items.set(x.key, { item: x.item, mute: muteOf(x.mute) });
  while (b.items.size > BATCH_MAX) {
    const [k, e] = b.items.entries().next().value;
    b.items.delete(k);
    // Counted by kind (so narrowing drops it too). One a push in flight carries counts with what that push carries
    // too (sendingOver): gone with it when it goes through, still counted when it fails.
    b.over.set(e.item.kind, (b.over.get(e.item.kind) ?? 0) + 1);
    if (b.sending?.has(e)) b.sendingOver.set(e.item.kind, (b.sendingOver.get(e.item.kind) ?? 0) + 1);
  }
  schedule(n, s, pace);
}

/**
 * When the batch may be pushed: a debounce after its first event and an interval after the last attempt (paceOf). A
 * first event later than now (a clock set back since, a stored batch) is set back to now in place, once, as paceOf does.
 */
function dueOf(b, s, pace, now) {
  if (b.firstAt > now) b.firstAt = now;
  return Math.max(b.firstAt + debounceMs(), pace.last + intervalMs(s));
}

function schedule(n, s, pace) {
  const b = batches.get(n);
  if (!b || b.timer || flushing.has(n)) return;
  const now = _deps.now(), day = dayOf(now);
  let due = dueOf(b, s, pace, now);
  // The day's attempts are spent: the batch waits for the next day (it keeps at most BATCH_MAX, the rest counted).
  if (pace.today(day) >= PUSHES_PER_DAY) due = Math.max(due, Date.parse(`${day}T00:00:00Z`) + 86_400_000);
  // A timer only clears itself: one cleared and replaced (a new interval) must not clear its successor.
  const t = _deps.setTimeout(() => { if (b.timer === t) b.timer = null; return flush(n).catch(() => {}); }, Math.min(TIMER_MAX_MS, Math.max(0, due - now)));
  b.timer = t;
  t?.unref?.();
}

/** Whether the bot may get a push now: a Routine, and a live connection of its own that may read. */
async function eligible(n) {
  // As the gateway sees it: a native tenant's name is never one of the owner's bots, whatever grant it still holds.
  if (isTenantBot(n)) return 'a native tenant gets no pushes';
  if (!(await _deps.hasRoutine(n))) return 'no Routine is set up for it';
  const grants = await _deps.grants().catch(() => []);
  const ok = grants.some((g) => g.bot === n && !g.shared && g.connected && g.resourceAccess === undefined && Array.isArray(g.scopes) && g.scopes.includes('drover.read'));
  return ok ? null : 'it has no live connection that may read (revoked or expired)';
}

/** Words for a routine saved with an older instruction (and for anyone reading the body). */
export function summaryText(items, more = 0) {
  const waiting = items.filter((i) => i.kind === 'owner-waiting'), bots = items.filter((i) => i.kind === 'bot-needs-owner'), inbox = items.filter((i) => i.kind === 'inbox');
  const parts = [];
  if (waiting.length) parts.push(`${waiting.length} ${waiting.length === 1 ? 'session waits' : 'sessions wait'} on ${OWNER_NAME} (${waiting.slice(0, 3).map((i) => `${i.session?.name ?? i.session?.id ?? 'a session'}${i.host ? ` on ${i.host}` : ''} ${i.wait ?? 'needs you'}`).join('; ')}${waiting.length > 3 ? '; ...' : ''})`);
  if (bots.length) parts.push(bots.slice(0, 3).map((i) => `${i.name ?? i.bot ?? 'a bot'} ${i.state === 'approval' ? `asked ${OWNER_NAME} for an approval` : i.state === 'blocked' ? 'is blocked' : `needs ${OWNER_NAME}`}`).join(', ') + (bots.length > 3 ? ', ...' : ''));
  if (inbox.length) parts.push(`${inbox.length} new ${inbox.length === 1 ? 'message' : 'messages'} in your inbox`);
  return `[Drover] Things you subscribed to happened: ${parts.join('; ')}${more ? ` (and ${more} more)` : ''}. This is not a message and needs no reply: look into what matters with drover_fleet and drover_inbox.`;
}

/**
 * Take what a push carried out of the batch it was for (the same entries: a newer one for the same thing stays). A batch
 * made since (the bot unsubscribed and subscribed again while it was out) is another one, and keeps its own counts.
 */
function consume(n, b, sent, sentOver) {
  const cur = batches.get(n);
  if (!cur || cur !== b) return;
  for (const [k, it] of sent) if (cur.items.get(k) === it) cur.items.delete(k);
  for (const [kind, c] of sentOver) { const left = (cur.over.get(kind) ?? 0) - c; if (left > 0) cur.over.set(kind, left); else cur.over.delete(kind); }
  cur.failures = 0;
  cur.sending = null; cur.sendingOver = null;
  if (!cur.items.size) drop(n);   // a count of overflowed events alone is never a push
}

/** Push the bot's batch to its Routine, if it may get one now; record how it went. */
export async function flush(name) {
  const n = grok.botName(name);
  const b = batches.get(n);
  if (!n || !b || flushing.has(n)) return null;
  flushing.add(n);
  try {
    const c = await load();
    const s = own(c, n);
    if (!s) { if (batches.get(n) === b) drop(n); return null; }
    const now = _deps.now(), day = dayOf(now), pace = paceOf(c, n);
    // Not before it is due under the subscription as it stands now (its interval may have changed since).
    if (pace.today(day) >= PUSHES_PER_DAY || now < dueOf(b, s, pace, now)) return null;
    const settings = await _deps.settings().catch(() => null);
    const why = await eligible(n);
    // An unsubscribe or a narrowing subscribe while those were looked up decided for itself: this is no longer the batch.
    if (batches.get(n) !== b) return null;
    // What the owner muted while it waited goes, and what the subscription no longer wants (an event collected while a
    // narrowing subscribe was being stored); a batch left with nothing is no push.
    let dropped = 0;
    for (const [k, e] of b.items) if (!wants(s, e.item.kind) || mutedFor(e, settings)) { b.items.delete(k); dropped++; }
    for (const kind of [...b.over.keys()]) if (!wants(s, kind)) b.over.delete(kind);
    if (!b.items.size) {   // nothing left to tell (a count alone is never a push), in the store too
      drop(n);
      if (dropped) await update((c2) => remember(c2)).catch(() => { /* stored with the next change */ });
      return null;
    }
    // What this push carries: anything that comes in while it is out stays for the next one.
    const sent = new Map(b.items), sentOver = new Map(b.over), more = overOf(b);
    b.sending = new Set(sent.values()); b.sendingOver = sentOver;
    const items = [...sent.values()].map((e) => e.item).sort((x, y) => String(x.at).localeCompare(String(y.at)));
    let result;
    if (why) result = { ok: false, error: why };
    else {
      // The attempt counts before it goes out (failed ones too), in memory and in the store, and the store takes what
      // it carries as gone out (stored()): a restart while it is out neither forgets the attempt nor sends it again.
      // A push the store cannot record first is not sent: it waits for the next window, as a failed one does.
      memPace.set(n, { lastAttemptAt: new Date(now).toISOString(), day, today: pace.today(day) + 1 });
      // Built before anything is reserved: one that cannot be built is a failed attempt, and the store keeps the batch.
      let body = null;
      try { body = grok.eventsBody(n, { ref: uuidv7(), events: items, more, text: summaryText(items, more) }); }
      catch (e) { result = { ok: false, error: `not sent: Drover could not build the push (${String(e?.message ?? e).slice(0, 120)})` }; }
      const reserved = body && await update((c2) => { pacesOf(c2)[n] = { ...memPace.get(n) }; remember(c2); }).then(() => true, () => false);
      if (body && !reserved) result = { ok: false, error: 'not sent: Drover could not record the push first (its state is not writable)' };
      else if (body) {
        try { result = await _deps.post(n, body); } catch (e) { result = { ok: false, error: e.message }; }
      }
    }
    const ok = result?.ok === true;
    // Pushed, or nobody to push to (no Routine, no connection), or failed too often: the batch is done. In memory
    // first, so a store that cannot be written never sends the same batch again.
    if (ok || why || ++b.failures >= FAILURES_MAX) consume(n, b, sent, sentOver);
    else { b.sending = null; b.sendingOver = null; }   // back in the batch (and in the store, below) for the next window
    const at = new Date(_deps.now()).toISOString();
    await update((c2) => {
      const x = own(c2, n);
      if (!why && memPace.has(n)) pacesOf(c2)[n] = { ...memPace.get(n) };
      remember(c2);
      if (!x) return;
      x.lastResult = { ok, at, ...(ok ? { events: items.length + more } : { error: String(result?.error ?? 'failed').slice(0, 300) }) };
      if (ok) x.lastPushAt = at;
    }).catch(() => { /* recorded next time; the pace is held in memory */ });
    subsCache = null;
    return { ok, ...(result?.error ? { error: result.error } : {}) };
  } finally {
    flushing.delete(n);
    const b2 = batches.get(n);
    if (b2 && !b2.timer) { const c3 = await load(); const s3 = own(c3, n); if (s3) schedule(n, s3, paceOf(c3, n)); }
  }
}

// ---------------------------------------------------------------- the truth file, as it grows
const ANCHOR = 64;   // the bytes before the read position, checked each time: a rewrite under the same inode shows
let cursor = null;   // { ino, size, tail }: how far this daemon has read, and the bytes just before that
let partial = Buffer.alloc(0);   // the start of a line still being written, as bytes (a character may be cut)
let lineTail = Buffer.alloc(0);  // the bytes before the end of the last complete line read (where position() is)
// Event ids already handed on: a line the file gets again (a union merge, a legacy import) is told once.
const seenIds = new Set();
const SEEN_MAX = 5000;
function firstTime(id) {
  if (typeof id !== 'string' || !id) return true;
  if (seenIds.has(id)) return false;
  seenIds.add(id);
  if (seenIds.size > SEEN_MAX) seenIds.delete(seenIds.values().next().value);
  return true;
}

async function readAt(file, pos, len) {
  const fh = await open(file, 'r');
  try { const buf = Buffer.alloc(len); const { bytesRead } = await fh.read(buf, 0, len, pos); return buf.subarray(0, bytesRead); }
  finally { await fh.close(); }
}

/**
 * The complete lines appended since the last look. A file rewritten in place (another inode, shorter, or other bytes
 * where the last look ended) restarts at its end, so nothing is told twice.
 */
export async function newEvents() {
  const file = _deps.eventsPath();
  const st = await stat(file).catch(() => null);
  if (!st) { cursor = null; partial = Buffer.alloc(0); lineTail = Buffer.alloc(0); return []; }
  const restart = async () => { cursor = { ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, tail: Buffer.from(await readAt(file, Math.max(0, st.size - ANCHOR), Math.min(ANCHOR, st.size))) }; partial = Buffer.alloc(0); lineTail = cursor.tail; return []; };
  if (!cursor || st.ino !== cursor.ino || st.size < cursor.size) return restart();
  // The same size but written since: rewritten in place (reordered) unless the bytes before the cursor are the same.
  if (st.size === cursor.size) {
    if (st.mtimeMs !== cursor.mtimeMs && cursor.tail.length && !(await readAt(file, cursor.size - cursor.tail.length, cursor.tail.length)).equals(cursor.tail)) return restart();
    cursor.mtimeMs = st.mtimeMs;
    return [];
  }
  // Nothing subscribes, or a burst too large to be news: move on without reading it.
  if (!Object.keys((subsCache ?? (subsCache = await load())).bots).length || st.size - cursor.size > READ_MAX) return restart();
  if (cursor.tail.length && !(await readAt(file, cursor.size - cursor.tail.length, cursor.tail.length)).equals(cursor.tail)) return restart();
  const bytes = await readAt(file, cursor.size, st.size - cursor.size);
  cursor.size += bytes.length;
  cursor.mtimeMs = st.mtimeMs;
  cursor.tail = Buffer.from(Buffer.concat([cursor.tail, bytes.subarray(-ANCHOR)]).subarray(-ANCHOR));
  const all = Buffer.concat([partial, bytes]);
  const cut = all.lastIndexOf(0x0a);   // a newline byte never sits inside a UTF-8 character
  partial = Buffer.from(all.subarray(cut + 1));
  if (cut >= 0) { const done = all.subarray(0, cut + 1); lineTail = Buffer.from((done.length >= ANCHOR ? done : Buffer.concat([lineTail, done])).subarray(-ANCHOR)); }
  if (partial.length > READ_MAX) { partial = Buffer.alloc(0); lineTail = Buffer.from(cursor.tail); }   // not a line that will end
  if (cut < 0) return [];
  const out = [];
  for (const l of all.subarray(0, cut).toString('utf8').split('\n')) {
    if (!l.trim()) continue;
    let ev; try { ev = JSON.parse(l); } catch { continue; }   // not an event
    if (firstTime(ev?.id)) out.push(ev);
  }
  return out;
}

/**
 * Where the complete lines read so far end, as the store keeps it: a line still being written is read again whole
 * after a restart. Null before the first look.
 */
export function position() {
  return cursor ? { ino: cursor.ino, size: cursor.size - partial.length, mtimeMs: cursor.mtimeMs, tail: lineTail.toString('base64') } : null;
}

/** Whether a stored entry is one a push can carry: every field its kind has, of the right type (a store can be old or edited). */
const text = (v, max) => typeof v === 'string' && v.length <= max;
const textOrNone = (v, max) => v === null || v === undefined || text(v, max);
function wholeItem(i) {
  if (!i || typeof i !== 'object' || !text(i.at, 40) || !Number.isFinite(Date.parse(i.at))) return false;
  if (i.kind === 'owner-waiting') return textOrNone(i.host, 200) && Boolean(i.session) && typeof i.session === 'object' && textOrNone(i.session.id, 200) && textOrNone(i.session.name, 200) && textOrNone(i.session.engine, 80) && text(i.wait, 200);
  if (i.kind === 'bot-needs-owner') return text(i.bot, 200) && text(i.name, 200) && text(i.state, 40) && textOrNone(i.summary, 1200);
  if (i.kind === 'inbox') return text(i.messageId, 200) && textOrNone(i.from, 200) && typeof i.broadcast === 'boolean';
  return false;
}

/**
 * Put back what the store kept, before anything else is collected: the batches of bots still subscribed (only whole
 * entries of the kinds they still want, at most BATCH_MAX each), how far the file was read into them (unless this
 * process has read it already, or no one subscribes), and the ids it told. Then each batch is scheduled under its
 * pace. It writes nothing: the next change stores what is back (remember), and what was not put back goes then.
 */
async function restore() {
  const c = await inTurn(async () => {
    const c = await load();
    for (const [n, p] of Object.entries(c.pending && typeof c.pending === 'object' ? c.pending : {})) {
      const s = own(c, n);
      if (!s || batches.has(n) || !Array.isArray(p?.items)) continue;
      const items = new Map();
      for (const e of p.items.slice(-BATCH_MAX)) {
        if (typeof e?.key === 'string' && e.key.length <= 400 && wholeItem(e.item) && wants(s, e.item.kind)) items.set(e.key, { item: e.item, mute: muteOf(e.mute) });
      }
      if (!items.size) continue;
      const over = new Map(Object.entries(p.over && typeof p.over === 'object' ? p.over : {}).filter(([kind, v]) => wants(s, kind) && Number.isInteger(v) && v > 0));
      batches.set(n, { items, over, firstAt: Number.isFinite(p.firstAt) ? p.firstAt : _deps.now(), failures: Number.isInteger(p.failures) ? p.failures : 0, timer: null, sending: null, sendingOver: null });
    }
    // A position stored while no one subscribed says nothing about now: without a subscriber the tail skips to the end.
    // Nor does one whose anchor is longer than the bytes before it (an edited store): it could never be checked.
    const k = c.cursor;
    const anchor = typeof k?.tail === 'string' ? Buffer.from(Buffer.from(k.tail, 'base64').subarray(-ANCHOR)) : null;
    if (!cursor && Object.keys(c.bots).length && Number.isFinite(k?.ino) && Number.isInteger(k.size) && k.size >= 0 && anchor && anchor.length <= k.size) {
      cursor = { ino: k.ino, size: k.size, mtimeMs: Number(k.mtimeMs) || 0, tail: anchor };
      partial = Buffer.alloc(0); lineTail = cursor.tail; collected = { ino: k.ino, size: k.size, mtimeMs: cursor.mtimeMs, tail: lineTail.toString('base64') };
      storedPos = collected; storedAt = _deps.now();
    }
    for (const id of Array.isArray(c.seen) ? c.seen.slice(-KEPT_IDS) : []) if (typeof id === 'string' && id && id.length <= 200) { keep(id); firstTime(id); }
    return c;
  });
  subsCache = c;
  for (const n of batches.keys()) { const s = own(c, n); if (s) schedule(n, s, paceOf(c, n)); }
}

let started = null;
/**
 * In the daemon: put back what the store kept, listen to alerts, follow the truth file (every tailMs). Idempotent;
 * returns stop(), whose `ready` settles once the store's batches are back.
 */
export function start({ notifier, tailMs = TAIL_MS } = {}) {
  if (started) return started;
  const offAlerts = notifier?.on((items) => { collect(items.map(fromAlert)).catch(() => {}); }) ?? (() => {});
  let busy = false;
  const tick = setInterval(async () => {
    if (busy) return; busy = true;
    try { if (restoring) await restoring; const evs = await newEvents(); await collect(evs.map(fromEvent), { through: position() }); } catch { /* the next look tries again */ } finally { busy = false; }
  }, tailMs);
  tick.unref?.();
  // Where the store says the file was read to, the next look carries on from; without it, only what comes after this
  // start. Collecting and the tick wait for both (one look at the file at a time).
  const ready = restoring = restore().catch(() => { /* an unreadable store: nothing to put back */ })
    .then(() => (cursor ? null : newEvents())).catch(() => {})
    .then(() => { collected ??= position(); restoring = null; });
  const stop = () => { offAlerts(); clearInterval(tick); for (const n of [...batches.keys()]) drop(n); started = null; };
  stop.ready = ready;
  started = stop;
  return started;
}

/**
 * Tests: forget batches, the cache and the file position (the store stays: a restart is _reset() then start()).
 * Returns the store work still under way, to wait for before touching the file.
 */
export function _reset() {
  for (const n of [...batches.keys()]) drop(n);
  subsCache = null; cursor = null; partial = Buffer.alloc(0); lineTail = Buffer.alloc(0); collected = null; restoring = null;
  storedPos = null; storedAt = 0;
  memPace.clear(); ahead.clear(); seenIds.clear(); keptIds.clear();
  started?.();
  const was = chain;
  chain = Promise.resolve();
  return was;
}
