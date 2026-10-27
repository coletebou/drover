// Native clients (iOS app, widgets, browser extension): two small read ops that
// shape what the daemon already knows into compact, path-free JSON.
//
//   native.summary        the board in one call: per-host lane counts, the sessions
//                         waiting on the owner (decision or question), the working ones,
//                         totals and manager state. Cheap; safe to poll. stopped: true
//                         adds the idle tmux sessions that stopped recently (managers).
//   native.notifications  the alert feed as a cursor: oldest first, muted left out,
//                         optional long poll (`wait` seconds) for the next alert.
//   native.board          the compact board for rich clients (main token only): every live agent as a
//                         strip with what answering it needs. Waiting items, strips and dialog alerts carry
//                         answerFields (dialog, screen hash, keys) for sessions.answer.
//
// The shaping is pure (buildSummary, buildBoard, buildNotifications, headline, toIso:
// tested in test/native.test.js). native.summary and native.notifications are accepted
// with the read-only widget token (server/http.js), so they never return cwd, tmux
// targets, transcript paths or anything that looks like a secret; native.board names
// windows and working dirs and needs the main token. Text goes through clean() first.
import { homedir } from 'node:os';
import { notifier } from './notify.js';
import { stripsFor } from '../ui/lanes.js';
import { OWNER } from './owner.js';
import { redactSecrets } from './redact.js';

// The secret redactor lives in core/redact.js, which imports nothing, so core/proc.js can use it too.
export { redactSecrets, redactArgv } from './redact.js';

export const _deps = {
  dispatch: null,   // set by core/api.js
  now: () => Date.now(),
  subscribe: (fn) => notifier.on(fn),
  isDaemon: () => notifier.daemon,
  localNames: () => new Set(),   // set by core/api.js: this machine's names, which native items call local
};

const ANSI = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g;
const HOME_PATH = /\/(?:Users|home)\/[^\/\s]+/g;
// This daemon's own home, wherever it is (/root, /var/home/<name>), reads ~ too, before the usual homes do.
const OWN_HOME = (() => { const h = homedir().replace(/\/+$/, ''); return h.length > 1 ? new RegExp(`${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-])`, 'g') : null; })();
const homesToTilde = (s) => (OWN_HOME ? s.replace(OWN_HOME, '~') : s).replace(HOME_PATH, '~');

/** Plain one-line text, no escapes, no secret-looking substrings, at most `max` chars (an ellipsis counts). */
export function clean(text, max = 140) {
  if (text == null) return '';
  let s = String(text).replace(ANSI, '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  s = redactSecrets(homesToTilde(s));
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export function headline(text) { return clean(text, 140); }

/** ms (> 1e11) or seconds or an ISO/date string -> ISO string; anything unusable -> null. */
export function toIso(v) {
  if (v == null || v === '') return null;
  const d = typeof v === 'number' ? new Date(v > 1e11 ? v : v * 1000) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const ms = (v) => { const i = toIso(v); return i ? Date.parse(i) : 0; };

const displayName = (st) => clean(st.name, 80) || String(st.sessionId ?? st.id ?? '').slice(0, 8);

const YN = /\(y\/n\)|\[Y\/n\]|\[y\/N\]/i;

/**
 * How a waiting session is answered, for clients that show buttons: the dialog (question, options), the screen hash to
 * pass back as sessions.answer's expect, and the keys that dialog takes. A held peer message takes Enter (deliver) or
 * Escape (drop). y and n only for a (y/n) prompt or an option that shows the letter as its shortcut: Claude Code's own
 * dialogs answer to Enter, Escape and digits only (core/tmux.js keyFitsDialog). An ask with nothing on screen (a
 * question in the last reply) is answered with a message. Pure.
 */
export function answerFields({ screen, held, dialog, hash, ask } = {}, { pathless = false } = {}) {
  if (screen !== 'dialog' && !held) return ask && ask.kind !== 'finished' ? { answer: 'reply' } : {};
  // The widget-token ops name no paths: a dialog's own text keeps only the last part of one ("in ~/code/x" -> "in x").
  const text = (s, max) => clean(pathless ? noPaths(s) : s, max);
  const options = (dialog?.options ?? []).filter((o) => Number.isInteger(o?.n) && o.n >= 1 && o.n <= 9).slice(0, 9)
    .map((o) => ({ n: o.n, label: text(o.label, 120), ...(o.selected ? { selected: true } : {}) }));
  const question = dialog?.question ? text(dialog.question, 300) : null;
  const keys = held ? [] : options.map((o) => String(o.n));
  if (!held && (YN.test(dialog?.question ?? '') || options.some((o) => /\(y\)/i.test(o.label)))) keys.push('y');
  if (!held && (YN.test(dialog?.question ?? '') || options.some((o) => /\(n\)/i.test(o.label)))) keys.push('n');
  // A multi-select question draws a box per option: Space ticks the highlighted one, Enter submits.
  if (!held && (dialog?.options ?? []).some((o) => /^\s*(?:\[[ xX✓✔]?\]|[☐☑☒◯◉●○])/.test(String(o?.label ?? '')))) keys.push('Space');
  keys.push('Enter', 'Escape');
  return { answer: 'keys', dialog: { question, options }, ...(hash ? { hash: String(hash) } : {}), keys };
}

const PATH_RUN = /(?:~|\/(?:Users|home|private|var|tmp|opt|mnt|srv|Volumes|root|etc))(?:\/[^\s/'"`)]+)+\/?/g;
/** Paths down to their last part, so text naming a file or project keeps the name and not where it lives. */
export function noPaths(s) {
  return homesToTilde(String(s ?? '')).replace(PATH_RUN, (m) => m.replace(/\/+$/, '').split('/').at(-1) || m);
}

/** The latest needs-you ask and finished alert per session, from the detector's alerts (muted and test ones left out). */
function alertMaps(alerts) {
  const notifyMap = {}, finishedMap = {};
  for (const a of alerts) {
    if (!a?.sessionId || a.test) continue;
    if (a.category === 'needs-you' && !a.muted) {
      const cur = notifyMap[a.sessionId];
      if (!cur || Date.parse(a.ts) >= Date.parse(cur.ts)) notifyMap[a.sessionId] = { ts: a.ts, message: a.body, title: a.title, kind: a.kind, ask: a.ask };
    } else if (a.category === 'finished') {
      const cur = finishedMap[a.sessionId];
      if (!cur || Date.parse(a.ts) >= Date.parse(cur.ts)) finishedMap[a.sessionId] = { ts: a.ts, ask: a.ask, body: a.body };
    }
  }
  return { notifyMap, finishedMap };
}

/**
 * The board. stoppedWithinMs > 0 adds `stopped`: agent sessions in a tmux window, idle (not waiting, not
 * working), that stopped within that window, newest first; never an SDK helper (entrypoint sdk-cli) or the
 * manager. What a manager drives forward: id, cleaned name, host, engine and when it stopped.
 */
export function buildSummary(fleet, alerts = [], { now = Date.now(), managerLastNoteAt = null, stoppedWithinMs = 0 } = {}) {
  const { notifyMap, finishedMap } = alertMaps(alerts);
  const waiting = [], working = [], stopped = [], hosts = [];
  let managerUp = false;
  for (const hs of fleet?.hosts ?? []) {
    const strips = stripsFor(hs, notifyMap, now, finishedMap);
    const counts = { waiting: 0, working: 0, idle: 0 };
    for (const st of strips) {
      const engine = st.engine ?? 'claude';
      if (st.lane === 'wait') {
        counts.waiting++;
        waiting.push({ id: st.sessionId ?? st.id, name: displayName(st), host: hs.host, engine, since: toIso(st.since), kind: st.ask?.kind === 'question' ? 'question' : 'decision', headline: headline(st.ask?.text || st.question || (st.tail ?? []).join(' ')), ...answerFields(st, { pathless: true }) });
      } else if (st.lane === 'work') {
        counts.working++;
        const last = [...(st.tail ?? [])].reverse().find((l) => l && String(l).trim());
        working.push({ id: st.sessionId ?? st.id, name: displayName(st), host: hs.host, engine, headline: headline(last ?? st.status ?? '') });
      } else {
        counts.idle++;
        const at = ms(st.since);
        // No headline: an idle pane's last line is its prompt. A manager reads sessions.lastReply instead.
        if (stoppedWithinMs > 0 && st.kind === 'session' && st.tmux && st.entrypoint !== 'sdk-cli' && engine !== 'openclaw' && at && now - at <= stoppedWithinMs) {
          stopped.push({ id: st.sessionId ?? st.id, name: displayName(st), host: hs.host, engine, stoppedAt: toIso(at) });
        }
      }
    }
    if ((hs.sessions ?? []).some((s) => s.engine === 'openclaw' && s.live !== false)) managerUp = true;
    hosts.push({ name: hs.host, up: hs.ok !== false, ...counts });
  }
  waiting.sort((a, b) => (a.since === null) - (b.since === null) || (a.since && b.since ? Date.parse(a.since) - Date.parse(b.since) : 0));
  const newestManager = alerts.filter((a) => a?.category === 'manager').reduce((m, a) => Math.max(m, ms(a.ts)), 0);
  const last = Math.max(ms(managerLastNoteAt), newestManager);
  return {
    generatedAt: new Date(now).toISOString(),
    hosts,
    waiting,
    working,
    totals: { waiting: waiting.length, working: working.length, idle: hosts.reduce((n, h) => n + h.idle, 0), hosts: hosts.length },
    manager: { up: managerUp, lastNoteAt: last ? new Date(last).toISOString() : null },
    // Not capped: live tmux sessions bound it, and a cap would starve older stops and other managers' hosts.
    ...(stoppedWithinMs > 0 ? { stopped: stopped.sort((a, b) => Date.parse(b.stoppedAt) - Date.parse(a.stoppedAt)) } : {}),
  };
}

const LANE_ORDER = { wait: 0, work: 1, idle: 2 };

/** One strip of the compact board: what a board row shows and what answering it needs, text cleaned. */
export function boardStrip(st, host) {
  const engine = st.engine ?? 'claude';
  const last = [...(st.tail ?? [])].reverse().find((l) => l && String(l).trim());
  const head = st.lane === 'wait' ? st.ask?.text || st.question || (st.tail ?? []).join(' ') : st.lane === 'work' ? last ?? st.status ?? '' : st.finished?.text ?? '';
  const out = {
    key: `${host}|${st.id}`, id: st.sessionId ?? st.id, name: displayName(st), host, engine, lane: st.lane, status: st.status ?? null, kind: st.kind ?? 'session',
    headline: headline(head),
  };
  if (st.sessionId && st.sessionId !== out.id) out.sessionId = st.sessionId;
  if (st.screen) out.screen = st.screen;
  if (st.tmux) out.tmux = st.tmux;
  if (st.windowName && st.windowName !== st.name) out.windowName = clean(st.windowName, 80);
  if (st.cwd) out.cwd = clean(st.cwd, 160);   // clean() writes home dirs as ~
  const since = toIso(st.since); if (since) out.since = since;
  if (st.tail?.length) out.tail = st.tail.slice(-3).map((l) => clean(l, 200));
  if (st.ask) out.ask = { kind: st.ask.kind, label: st.ask.label ?? null, text: clean(st.ask.text, 300), options: (st.ask.options ?? []).slice(0, 9).map((o) => ({ n: o.n, label: clean(o.label, 120) })) };
  if (st.held) { out.held = true; if (st.heldFrom) out.heldFrom = clean(st.heldFrom, 120); }
  if (st.finished?.ts) out.finished = { text: clean(st.finished.text, 300), ts: toIso(st.finished.ts) };
  if (st.entrypoint) out.entrypoint = st.entrypoint;
  if (st.faded) out.faded = true;
  if (st.unread) out.unread = st.unread;   // a Grok bot's replies the owner has not read
  if (st.lane === 'wait') Object.assign(out, answerFields(st));
  return out;
}

/**
 * The compact board for rich clients: per-host counts and every live agent as a
 * strip, in board order (waiting, working, idle; inside a lane what is not faded first, then newest), a few KB per host
 * where fleet.summary carries every session record. Main token only: strips name tmux windows and working dirs.
 */
export function buildBoard(fleet, alerts = [], { now = Date.now(), managerLastNoteAt = null } = {}) {
  const { notifyMap, finishedMap } = alertMaps(alerts);
  const strips = [], hosts = [];
  let manager = { up: false, host: null };
  for (const hs of fleet?.hosts ?? []) {
    const counts = { waiting: 0, working: 0, idle: 0 };
    for (const st of stripsFor(hs, notifyMap, now, finishedMap)) {
      counts[st.lane === 'wait' ? 'waiting' : st.lane === 'work' ? 'working' : 'idle']++;
      strips.push(boardStrip(st, hs.host));
    }
    const mgr = (hs.sessions ?? []).find((s) => s.engine === 'openclaw' && s.live !== false);
    if (mgr && !manager.up) manager = { up: true, host: hs.host, status: mgr.status ?? null };
    hosts.push({ name: hs.host, up: hs.ok !== false, ...counts, ...(hs.error ? { error: clean(hs.error, 200) } : {}), ...(hs.cache?.stale || hs.fallback ? { stale: true } : {}) });
  }
  strips.sort((a, b) => LANE_ORDER[a.lane] - LANE_ORDER[b.lane] || (a.faded === true) - (b.faded === true) || (b.since ? Date.parse(b.since) : 0) - (a.since ? Date.parse(a.since) : 0));
  const newestManager = alerts.filter((a) => a?.category === 'manager').reduce((m, a) => Math.max(m, ms(a.ts)), 0);
  const last = Math.max(ms(managerLastNoteAt), newestManager);
  const count = (lane) => strips.filter((s) => s.lane === lane).length;
  return {
    generatedAt: new Date(now).toISOString(),
    hosts,
    strips,
    totals: { waiting: count('wait'), working: count('work'), idle: count('idle'), hosts: hosts.length },
    manager: { ...manager, lastNoteAt: last ? new Date(last).toISOString() : null },
  };
}

/** The kind a client shows for an alert: decision, question, finished, error, mr, launch, manager. */
export function notificationKind(a) {
  const k = a?.ask?.kind;
  if (k === 'decision' || k === 'question' || k === 'finished') return k;
  switch (a?.category) {
    case 'needs-you': return a.kind === 'agent' ? 'question' : 'decision';
    case 'held': return 'decision';
    case 'finished': return 'finished';
    case 'error': case 'mr': case 'launch': case 'manager': return a.category;
    default: return a?.category ? String(a.category) : 'decision';
  }
}

// Cursor: "c1." + base64url(JSON {t, s}). t is the newest delivered time (ms); s lists [id, ms] of
// delivered items newer than t - LOOKBACK. Remote alerts reach a front daemon up to a minute late
// with their original ts, so a poll looks back LOOKBACK and skips only the ids it already sent.
const LOOKBACK_MS = 5 * 60_000;
const SEEN_MAX = 200;
const encodeCursor = (t, seen) => 'c1.' + Buffer.from(JSON.stringify({ t, s: seen })).toString('base64url');
function decodeCursor(v) {
  if (typeof v !== 'string' || !v) return null;
  if (v.startsWith('c1.')) {
    try {
      const o = JSON.parse(Buffer.from(v.slice(3), 'base64url').toString('utf8'));
      if (!Number.isFinite(o?.t) || !Array.isArray(o.s) || !o.s.every((e) => Array.isArray(e) && typeof e[0] === 'string' && Number.isFinite(e[1]))) return null;
      return { t: o.t, s: o.s, legacy: false };
    } catch { return null; }
  }
  const t = Date.parse(v);   // a plain ISO string from an older client: no ids, so no lookback
  return Number.isNaN(t) ? null : { t, s: [], legacy: true };
}

/**
 * A dialog or held-message alert with a session behind it carries what answering it from the notification needs
 * (answerFields: dialog, the screen hash it was raised on, the keys); sessions.answer refuses once that screen is gone.
 */
function alertAnswer(a) {
  if (!a?.sessionId || !a.meta?.hash) return {};
  const held = a.category === 'held';
  if (!held && !(a.category === 'needs-you' && (a.kind === 'dialog' || a.ask?.kind === 'decision'))) return {};
  return answerFields({ screen: held ? null : 'dialog', held, hash: a.meta.hash, dialog: { question: a.ask?.text ?? a.title ?? null, options: a.meta.options ?? a.ask?.options ?? [] } }, { pathless: true });
}

export function buildNotifications(alerts = [], { since, limit = 50, now = Date.now(), localNames = new Set() } = {}) {
  // This machine's own alerts name it by hostname (the detector, the hook); the native contract's value for it is local.
  const hostOf = (h) => (h == null ? null : localNames.has(h) ? 'local' : h);
  const lim = Math.max(1, Math.min(200, Math.floor(Number(limit)) || 50));
  const all = alerts.filter((a) => a && !a.muted).map((a) => ({
    id: a.id, at: toIso(a.ts), kind: notificationKind(a), category: a.category,
    title: clean(a.title, 200), body: clean(a.body, 600), sessionId: a.sessionId ?? null, host: hostOf(a.host),
    ...(a.test ? { test: true } : {}), ...alertAnswer(a),
  })).filter((x) => x.at).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const at = (x) => Date.parse(x.at);
  const cur = decodeCursor(since);
  let items, t, seen;
  if (cur) {
    const have = new Set(cur.s.map((e) => e[0]));
    items = all.filter((x) => (cur.legacy ? at(x) > cur.t : at(x) > cur.t - LOOKBACK_MS && !have.has(String(x.id)))).slice(0, lim);
    t = Math.max(cur.t, ...items.map(at));
    seen = [...cur.s, ...items.map((x) => [String(x.id), at(x)])];
  } else {
    items = all.slice(-lim);
    t = items.length ? at(items[items.length - 1]) : (all.length ? at(all[all.length - 1]) : now);
    // A first page shows only the newest items; everything up to t counts as seen, so the next poll does not backfill older ones.
    seen = all.filter((x) => at(x) <= t).map((x) => [String(x.id), at(x)]);
  }
  const byId = new Map();
  for (const e of seen) if (e[1] > t - LOOKBACK_MS) byId.set(e[0], e);
  const kept = [...byId.values()].sort((a, b) => a[1] - b[1]).slice(-SEEN_MAX);
  return { cursor: encodeCursor(t, kept), items };
}

const withTimeout = (p, msMax) => new Promise((resolve) => {
  const t = setTimeout(() => resolve(null), msMax); t.unref?.();
  Promise.resolve(p).then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(null); });
});

const numish = (v, name) => {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
};

/** What the summary and the board are built from: the fleet (cached), the detector's alerts, the manager's last note. */
async function boardInputs() {
  const [fleet, recent] = await Promise.all([
    _deps.dispatch('fleet.summary', {}),
    _deps.dispatch('notify.recent', { limit: 400 }).catch(() => ({ items: [] })),
  ]);
  // openclaw.feed reads the local truth file (no ssh), so it is cheap; bound it anyway.
  const feed = await withTimeout(_deps.dispatch('openclaw.feed', { limit: 1 }), 1500);
  return { fleet, alerts: recent?.items ?? [], managerLastNoteAt: Array.isArray(feed) ? (feed[0]?.ts ?? null) : null };
}

export const ops = {
  'native.summary': async ({ stopped, stoppedHours } = {}) => {
    if (stopped != null && typeof stopped !== 'boolean') throw new Error('stopped must be a boolean');
    const hours = numish(stoppedHours, 'stoppedHours') ?? 12;
    if (hours < 1 || hours > 48) throw new Error('stoppedHours must be 1 to 48');
    const { fleet, alerts, managerLastNoteAt } = await boardInputs();
    // owner: the actor the owner's own clients write as (core/owner.js), so an app shows their turns as "you".
    return { ...buildSummary(fleet, alerts, { now: _deps.now(), managerLastNoteAt, stoppedWithinMs: stopped ? hours * 3600_000 : 0 }), owner: OWNER };
  },
  'native.board': async () => {
    const { fleet, alerts, managerLastNoteAt } = await boardInputs();
    return { ...buildBoard(fleet, alerts, { now: _deps.now(), managerLastNoteAt }), owner: OWNER };
  },
  'native.notifications': async ({ since, limit, wait } = {}) => {
    if (since != null && typeof since !== 'string') throw new Error('since must be a string');
    const lim = numish(limit, 'limit');
    const w = Math.max(0, Math.min(25, numish(wait, 'wait') ?? 0));
    const compute = async () => buildNotifications((await _deps.dispatch('notify.recent', { limit: 400 }))?.items ?? [], { since: since || undefined, limit: lim, now: _deps.now(), localNames: _deps.localNames() });
    // Subscribe before the first read so an alert landing in between wakes the wait. A waiter lives
    // at most 25 s, so a client that disconnects early is not tracked.
    let off = null, timer = null, woke = false, wake = null;
    if (w > 0 && _deps.isDaemon()) off = _deps.subscribe(() => { woke = true; wake?.(); }) ?? null;
    let r;
    try {
      r = await compute();
      if (!r.items.length && off) {
        if (!woke) await new Promise((resolve) => { wake = resolve; timer = setTimeout(resolve, w * 1000); timer.unref?.(); });
        r = await compute();
      }
    } finally { if (timer) clearTimeout(timer); off?.(); }
    return r;
  },
};
