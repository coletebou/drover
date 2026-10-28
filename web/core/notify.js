// Alerts: the daemon watches its own snapshot warmers and turns state
// transitions into `notify` events, so every browser (and every agent reading
// the truth file) sees the same alerts.
//
//   needs-you  a dialog appeared on an agent's screen, the Notification hook
//              fired, or an agent asked for attention through notify.send
//   finished   a session went busy -> idle (with its last line)
//   error      a session died, a headless agent exited non-zero, a host went dark
//   held       Claude's "Held message from another session" dialog appeared
//   mr         a watched merge request got an event, changed mergeability, merged
//   launch     a launch event was recorded
//   manager    the OpenClaw manager replied or wrote to the truth file
//
// Detection is a pure diff of two snapshots (diffSnapshots, diffMRs: tested in
// test/notify.test.js). The Notifier wraps it: it stamps ids, records each alert
// in the WAL, keeps a ring of recent alerts (persisted for `drover rpc`, so a front
// daemon on another machine can pull them with notify.recent instead of running
// its own detector over that host and doubling every alert), and fans batches out
// to listeners (server/http.js turns them into the `alerts` SSE event).
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { stateDir } from './paths.js';
import * as events from './events.js';
import * as settingsMod from './settings.js';
import { muteFor, decide, CATEGORY_IDS, CATEGORIES, foldSettings, classifyAsk, ASK_LABELS } from '../ui/notify-policy.js';
import { pidAlive } from './proc.js';
import { OWNER, isOwner } from './owner.js';

const STATE_DIR = () => stateDir();
export const RING_MAX = 400;

export const _deps = {
  appendEvent: (ev, opts) => events.append(ev, opts),
  readEvents: () => events.readAll(),
  now: () => Date.now(),
  host: () => events.shortHost(),
  ringFile: () => path.join(STATE_DIR(), 'notify-ring.json'),
  daemonFile: () => path.join(STATE_DIR(), 'daemon.json'),
  settings: async () => (await settingsMod.current()).settings,
};

const BUSY = (s) => /^(busy|active|running|working)$/i.test(String(s ?? ''));
const IDLE = (s) => /^(idle|ready|notloaded|completed)$/i.test(String(s ?? ''));
const ASKING = (s) => /wait|permission|input|blocked/i.test(String(s ?? ''));
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

// ------------------------------------------------------------------ pure detector
/** Compact, comparable view of one host's board data ({ ok, sessions, windows }). */
export function snapshotOf(summary) {
  const sessions = new Map();
  for (const s of summary?.sessions ?? []) {
    const id = s.sessionId ?? s.id ?? s.threadId;
    if (!id) continue;
    sessions.set(String(id), {
      id: String(id), engine: s.engine ?? s.kind ?? null, name: s.name ?? s.preview ?? null, status: s.status ?? null,
      live: s.live !== false && s.status !== 'dead', dead: s.status === 'dead', tmux: s.tmux ?? null, cwd: s.cwd ?? null,
      statusUpdatedAt: s.statusUpdatedAt ?? s.updatedAt ?? null, statusAt: s.statusUpdatedAt ?? null, exitCode: s.exitCode ?? null, transcript: s.transcript ?? null, headless: s.kind === 'headless',
      // A prompt the session reports itself (a Hermes approval or question its gateway holds), with what answering it needs.
      ...(s.dialog && s.hash ? { dialog: s.dialog, hash: String(s.hash), keys: Array.isArray(s.keys) ? s.keys : null, promptKind: s.prompt?.kind ?? null, answer: s.answer ?? null } : {}),
    });
  }
  const windows = new Map();
  for (const w of summary?.windows ?? []) {
    if (!w?.target || !w.agent) continue;
    windows.set(w.target, {
      target: w.target, name: w.name ?? null, state: w.screen?.state ?? null, held: Boolean(w.held), heldFrom: w.heldFrom ?? null,
      dialog: w.dialog ?? null, hash: w.hash ?? null, sessionId: w.agent?.sessionId ?? null, agentName: w.agent?.name ?? null, engine: w.agent?.engine ?? null,
      tail: Array.isArray(w.tail) ? w.tail.slice(-3) : [],
    });
  }
  return { ok: summary?.ok !== false, sessions, windows };
}

function dialogBody(d, tail) {
  if (d?.question) return clip(d.question + (d.options?.length ? ' ' + d.options.map((o) => `${o.n}. ${o.label}`).join(' / ') : ''), 300);
  return clip((tail ?? []).join(' '), 300);
}
/** Tmux window "session:@12" or "session:3" for a registry "session:@12.%3". */
export function windowOf(t) { const m = String(t ?? '').match(/^(.+?):(@\d+|\d+)/); return m ? `${m[1]}:${m[2]}` : (t || null); }

/**
 * Transitions between two snapshots of one host. prev undefined = first look,
 * which only sets the baseline. Returns alert bodies without id/ts.
 */
export function diffSnapshots(prev, next, { host }) {
  if (!prev || !next) return [];
  const out = [];
  const dialogSessions = new Set();
  const sessionName = (sid, fallback) => next.sessions.get(sid)?.name ?? prev.sessions.get(sid)?.name ?? fallback;
  // Screens: a dialog or a held peer message appearing.
  for (const [target, w] of next.windows) {
    const was = prev.windows.get(target);
    const name = w.agentName ?? sessionName(w.sessionId, w.name) ?? target;
    if (w.held && !was?.held) {
      if (w.sessionId) dialogSessions.add(w.sessionId);
      const ask = classifyAsk({ held: true, heldFrom: w.heldFrom, dialog: w.dialog });
      out.push({ category: 'held', kind: 'held-message', host, sessionId: w.sessionId, target, name, engine: w.engine, title: `${name} is holding a peer message`, body: w.heldFrom ? `from ${clip(w.heldFrom, 120)}; deliver or drop it` : 'deliver or drop it', key: `${host}|${target}|held|${w.hash ?? ''}`, ask, meta: { hash: w.hash, options: w.dialog?.options ?? [] } });
      continue;
    }
    if (w.state === 'dialog' && !w.held && was?.state !== 'dialog') {
      if (w.sessionId) dialogSessions.add(w.sessionId);
      const ask = classifyAsk({ screenState: 'dialog', dialog: w.dialog });
      out.push({ category: 'needs-you', kind: 'dialog', host, sessionId: w.sessionId, target, name, engine: w.engine, title: `${name} ${ASK_LABELS.decision}`, body: dialogBody(w.dialog, w.tail), key: `${host}|${target}|dialog|${w.hash ?? ''}`, ask, meta: { hash: w.hash, options: w.dialog?.options ?? [] } });
    }
  }
  // A prompt a session reports itself, once per prompt (its hash is the prompt id). Its alert names no pane: the prompt
  // is not drawn in one, so an answer goes to the session (sessions.answer), never to a pane read first.
  for (const [sid, s] of next.sessions) {
    if (!s.live || !s.hash || !s.dialog) continue;
    dialogSessions.add(sid);
    if (prev.sessions.get(sid)?.hash === s.hash) continue;
    const name = s.name ?? sid.slice(0, 8);
    const question = s.promptKind === 'clarify';
    const ask = question ? classifyAsk({ pendingAsk: s.dialog }) : classifyAsk({ screenState: 'dialog', dialog: s.dialog });
    out.push({ category: 'needs-you', kind: question ? 'question' : 'dialog', host, sessionId: sid, target: null, name, engine: s.engine, title: `${name} ${ask.label}`, body: dialogBody(s.dialog, []), key: `${host}|${sid}|prompt|${s.hash}`, ask,
      meta: { hash: s.hash, options: s.dialog.options ?? [], ...(s.keys ? { keys: s.keys } : {}), ...(s.answer === 'reply' ? { answer: 'reply' } : {}), reported: true } });
  }
  // Sessions: busy -> idle, -> asking, -> dead / exited.
  for (const [sid, s] of next.sessions) {
    const was = prev.sessions.get(sid);
    if (!was) continue;
    const name = s.name ?? was.name ?? sid.slice(0, 8);
    const target = windowOf(s.tmux ?? was.tmux);
    const base = { host, sessionId: sid, target, name, engine: s.engine };
    if (was.live && (s.dead || (s.status === 'exited' && s.exitCode !== 0 && s.exitCode !== null))) {
      out.push({ ...base, category: 'error', kind: s.dead ? 'died' : 'exit', title: `${name} ${s.dead ? 'exited unexpectedly' : `exited with code ${s.exitCode}`}`, body: clip(s.cwd ?? was.cwd ?? '', 200), key: `${host}|${sid}|error|${s.statusUpdatedAt ?? s.exitCode ?? ''}` });
      continue;
    }
    if (!s.live) continue;
    if (ASKING(s.status) && !ASKING(was.status) && !dialogSessions.has(sid)) {
      out.push({ ...base, category: 'needs-you', kind: 'status', title: `${name} needs you`, body: `status: ${s.status}`, key: `${host}|${sid}|asking|${s.statusUpdatedAt ?? ''}` });
      continue;
    }
    // A turn shorter than the poll (idle -> busy -> idle between two looks) still moves
    // the registry's statusUpdatedAt; that is a finish too.
    const quick = IDLE(was.status) && IDLE(s.status) && s.statusAt && was.statusAt && s.statusAt > was.statusAt;
    if ((BUSY(was.status) || quick) && IDLE(s.status) && !dialogSessions.has(sid) && s.engine !== 'openclaw') {   // a manager reply raises its own alert
      // A screen still showing a dialog means it is not finished, it is asking.
      const w = target ? next.windows.get(target) : null;
      if (w?.state === 'dialog' || w?.held) continue;
      out.push({ ...base, category: 'finished', kind: 'busy-idle', title: `${name} finished`, body: '', key: `${host}|${sid}|finished|${s.statusUpdatedAt ?? ''}`, meta: { transcript: s.transcript, tmux: s.tmux ?? was.tmux, headless: s.headless } });
    }
  }
  return out;
}

/**
 * MR transitions for the watched set. prev: Map number -> mr (null = baseline).
 * mine: Set of author ids, or null for all. One alert per MR per call.
 */
export function diffMRs(prev, nextList, { mine = null } = {}) {
  if (!prev) return [];
  const out = [];
  const watched = (mr) => !mine || mine.has(mr.author);
  const next = new Map(nextList.map((m) => [m.number, m]));
  for (const mr of nextList) {
    if (!watched(mr)) continue;
    const was = prev.get(mr.number);
    const reasons = [];
    let kind = null;
    if (!was) { reasons.push('opened'); kind = 'opened'; }
    else {
      if ((mr.eventCount ?? 0) > (was.eventCount ?? 0) && mr.lastEvent) {
        const ev = mr.lastEvent;
        const self = ev.actor && ev.actor === mr.author && /^(pushed|created|updated)$/i.test(ev.kind ?? '');
        if (!self) { const k = /pipeline|ci|check|build/i.test(ev.kind ?? '') ? 'pipeline' : (ev.kind ?? 'event'); reasons.push(k === 'pipeline' ? `pipeline ${ev.status ?? ev.kind}` : `${String(ev.kind ?? 'event').replace(/_/g, ' ')}`); kind = kind ?? k; }
      }
      if (was.mergeStatus && mr.mergeStatus && was.mergeStatus !== mr.mergeStatus && mr.mergeStatus !== 'unknown') { reasons.push(mr.mergeStatus === 'mergeable' ? 'now mergeable' : mr.mergeStatus === 'conflicts' ? 'now has conflicts' : `merge status ${mr.mergeStatus}`); kind = kind ?? 'mergeable'; }
      if ((mr.approvals ?? 0) > (was.approvals ?? 0) && !reasons.some((r) => /approv/.test(r))) { reasons.push('approved'); kind = kind ?? 'approved'; }
      if (was.state !== mr.state && mr.state) { reasons.push(mr.state); kind = kind ?? mr.state; }
    }
    if (reasons.length) out.push({ category: 'mr', kind, number: mr.number, name: `!${mr.number}`, title: `!${mr.number} ${reasons.join(', ')}`, body: clip(mr.title, 200), key: `mr|${mr.number}|${mr.eventCount ?? 0}|${mr.mergeStatus ?? ''}|${mr.state ?? ''}`, meta: { url: mr.url ?? null, number: mr.number } });
  }
  for (const [n, was] of prev) if (!next.has(n) && watched(was)) out.push({ category: 'mr', kind: 'left-open', number: n, name: `!${n}`, title: `!${n} merged or closed`, body: clip(was.title, 200), key: `mr|${n}|left-open`, meta: { url: was.url ?? null, number: n } });
  return out;
}

// ------------------------------------------------------------------ event -> alert
/** Alerts derived from truth-file appends (hook notifications, manager chat, launches). Pure. */
export function alertFromEvent(ev, { names = new Map() } = {}) {
  if (!ev || typeof ev !== 'object') return null;
  if (ev.type === 'notify') {
    if (ev.source === 'detector' || ev.source === 'mr' || ev.source === 'test' || ev.source === 'agent' || ev.source === 'bots') return null; // emitted directly by the Notifier
    const ask = ev.ask ?? null;
    const category = CATEGORY_IDS.includes(ev.category) ? ev.category : ask?.kind === 'finished' || (!ask && ev.kind === 'idle_prompt') ? 'finished' : 'needs-you';
    const name = ev.sessionName ?? names.get(ev.sessionId) ?? ev.sessionId?.slice(0, 8) ?? 'an agent';
    const kind = ev.kind ?? 'notification';
    const title = ask ? (ask.kind === 'finished' ? `${name} finished` : `${name} ${ask.label}`) : category === 'finished' ? `${name} finished` : `${name} needs you`;
    // Claude's generic text ("Claude is waiting for your input") says nothing; the ask text says what.
    const body = ask?.text ? clip(ask.text, 300) : /waiting for your input/i.test(ev.message ?? '') ? 'finished, no question pending' : clip(ev.message, 300);
    return { id: ev.id, ts: ev.ts, category, kind, host: ev.hostname ?? ev.host, sessionId: ev.sessionId ?? null, target: ev.tmuxTarget ?? null, name, engine: 'claude', title, body, key: `${ev.hostname ?? ev.host}|${ev.sessionId}|hook|${ev.id}`, source: 'hook', ...(ask ? { ask } : {}), ...(ev.meta?.hash ? { meta: { hash: String(ev.meta.hash), options: ev.meta.options ?? ask?.options ?? [] } } : {}) };
  }
  // A Grok bot answering (core/bots/grok.js): its chat event comes in through the bot gateway as grok:<name>.
  // Its asks (needs-owner, blocked) are emitted directly through notify.send, so they need no rule here.
  if (ev.type === 'chat' && /^grok:[a-z][a-z0-9-]{0,31}$/.test(ev.actor ?? '')) {
    const name = ev.to?.id === ev.actor && ev.to?.name ? ev.to.name : ev.actor.slice(5);
    return { id: ev.id, ts: ev.ts, category: 'finished', kind: 'bot-reply', host: ev.host, sessionId: ev.actor, name, engine: 'grok', title: `${name} replied`, body: clip(ev.text, 300), key: `grok|${ev.id}`, source: 'grok' };
  }
  if (ev.type === 'chat' && (ev.from === 'manager' || ev.actor === 'manager')) return { id: ev.id, ts: ev.ts, category: 'manager', kind: 'reply', host: ev.host, sessionId: 'manager', name: 'manager', engine: 'openclaw', title: 'The manager replied', body: clip(ev.text, 300), key: `manager|${ev.id}`, source: 'manager' };
  // Every manager writes as `manager` or `manager-<name>` (one per host that runs one).
  if (/^manager(-[a-z0-9-]+)?$/.test(ev.actor ?? '') && (ev.type === 'note' || ev.type === 'feature' || ev.type === 'message')) {
    const who = ev.actor === 'manager' ? 'The manager' : ev.actor;
    return { id: ev.id, ts: ev.ts, category: 'manager', kind: ev.type, host: ev.host, sessionId: 'manager', name: ev.actor, engine: 'openclaw', title: ev.type === 'message' ? `${who} messaged ${ev.to?.name ?? ev.to?.id ?? 'a session'}` : `${who} wrote a ${ev.type}`, body: clip(ev.text ?? ev.title ?? ev.notes ?? '', 300), key: `manager|${ev.id}`, source: 'manager' };
  }
  if (ev.type === 'launch') {
    const where = ev.result?.tmux ?? ev.result?.headlessId ?? ev.result?.threadId ?? '';
    return { id: ev.id, ts: ev.ts, category: 'launch', kind: ev.mode, host: ev.host, sessionId: ev.result?.sessionId ?? ev.result?.headlessId ?? null, target: ev.result?.tmux ?? null, name: ev.name ?? ev.profile ?? ev.engine, engine: ev.engine, title: `Launched ${ev.engine} ${ev.mode === 'headless' ? 'headless' : 'in ' + (where || 'tmux')}${ev.actor && !isOwner(ev.actor) ? ` (by ${ev.actor})` : ''}`, body: clip(ev.prompt ?? `${ev.profile ?? ''} in ${ev.cwd ?? '~'}`, 200), key: `launch|${ev.id}`, source: 'launch' };
  }
  return null;
}

// ------------------------------------------------------------------ the Notifier
export class Notifier {
  constructor() {
    this.prev = new Map();        // host -> snapshot
    this.fails = new Map();       // host -> consecutive failures
    this.ring = [];               // newest last
    this.seen = new Set();        // alert ids already in the ring (remote pulls dedupe on this)
    this.keys = new Map();        // alert key -> ts (suppress repeats of the same transition)
    this.listeners = new Set();
    this.names = new Map();       // sessionId -> name (for hook events)
    this.mrPrev = null;
    this.daemon = false;
    this.ringTimer = null;
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  #fan(items) { if (!items.length) return; for (const l of this.listeners) { try { l(items); } catch { /* listener error */ } } }

  #remember(alert) {
    if (this.seen.has(alert.id)) return false;
    this.seen.add(alert.id);
    this.ring.push(alert);
    if (this.ring.length > RING_MAX) { const drop = this.ring.splice(0, this.ring.length - RING_MAX); for (const d of drop) this.seen.delete(d.id); }
    if (this.daemon) this.#persistSoon();
    return true;
  }
  #persistSoon() {
    if (this.ringTimer) return;
    this.ringTimer = setTimeout(async () => {
      this.ringTimer = null;
      try {
        const f = _deps.ringFile(); await mkdir(path.dirname(f), { recursive: true, mode: 0o700 });
        await writeFile(f + '.tmp', JSON.stringify({ host: _deps.host(), pid: process.pid, ts: new Date(_deps.now()).toISOString(), items: this.ring.slice(-200) }), { mode: 0o600 });
        await rename(f + '.tmp', f);
      } catch { /* best effort */ }
    }, 400);
    this.ringTimer.unref?.();
  }
  /** Repeated transitions with the same key inside 10 minutes are one alert. */
  #fresh(alert) {
    const now = _deps.now();
    for (const [k, t] of this.keys) if (now - t > 10 * 60_000) this.keys.delete(k);
    if (alert.key && this.keys.has(alert.key)) return false;
    if (alert.key) this.keys.set(alert.key, now);
    return true;
  }

  /**
   * One dialog tends to arrive three ways within seconds: the Notification hook,
   * the screen (a dialog with options and a hash) and the registry status. Keep
   * the first, except that a dialog alert (it carries Approve / Deny) may follow
   * a hook or status alert for the same session.
   */
  #duplicateAsk(a) {
    if (a.category !== 'needs-you' || !a.sessionId || a.test) return false;
    const now = _deps.now();
    const prev = this.ring.findLast((x) => x.category === 'needs-you' && x.sessionId === a.sessionId && !x.test && now - Date.parse(x.ts) < 90_000);
    if (!prev) return false;
    return !(a.kind === 'dialog' && prev.kind !== 'dialog');
  }

  /** Stamp, record in the WAL, remember and fan out. Returns the stored alerts. */
  async emit(list, { record = true } = {}) {
    const settings = await _deps.settings().catch(() => null);
    const out = [];
    for (const a of list) {
      if (!a || this.#duplicateAsk(a) || !this.#fresh(a)) continue;
      const m = settings ? muteFor(a, settings, _deps.now()) : null;
      const alert = { ...a, observer: _deps.host(), ...(m ? { muted: `${m.scope} ${m.target}` } : {}) };
      if (record) {
        try {
          const ev = await _deps.appendEvent({ type: 'notify', category: alert.category, kind: alert.kind, source: alert.source ?? 'detector', sessionId: alert.sessionId ?? null, tmuxTarget: alert.target ?? null, sessionName: alert.name ?? null, hostname: alert.host ?? null, title: alert.title, message: alert.body ?? '', key: alert.key ?? null, observer: alert.observer, ...(alert.muted ? { muted: alert.muted } : {}), ...(alert.test ? { test: true } : {}), ...(alert.meta?.number ? { mr: alert.meta.number } : {}), ...(alert.ask ? { ask: alert.ask } : {}) }, { actor: alert.actor ?? 'drover' });
          alert.id = ev.id; alert.ts = ev.ts;
        } catch { alert.id = `local-${_deps.now()}-${out.length}`; alert.ts = new Date(_deps.now()).toISOString(); }
      } else { alert.id = alert.id ?? `local-${_deps.now()}-${out.length}`; alert.ts = alert.ts ?? new Date(_deps.now()).toISOString(); }
      if (this.#remember(alert)) out.push(alert);
    }
    this.#fan(out);
    return out;
  }

  /**
   * Feed one host's board data. lastReply(alert) fills a finished alert's body
   * (the session's last line); it may be slow, so it is bounded.
   */
  async observe(host, summary, { lastReply } = {}) {
    if (summary?.ok === false) {
      const n = (this.fails.get(host) ?? 0) + 1; this.fails.set(host, n);
      // Three misses in a row (about a minute on the fleet warmer) before a host counts as dark; once an hour at most.
      if (n === 3 && this.prev.has(host)) return this.emit([{ category: 'error', kind: 'host-down', host, name: host, title: `${host} stopped answering`, body: clip(summary.error ?? 'ssh rpc failed', 200), key: `${host}|host-down|${Math.floor(_deps.now() / 3_600_000)}` }]);
      return [];
    }
    this.fails.set(host, 0);
    const next = snapshotOf(summary);
    for (const s of next.sessions.values()) if (s.name) this.names.set(s.id, s.name);
    const prev = this.prev.get(host);
    this.prev.set(host, next);
    const found = diffSnapshots(prev, next, { host });
    if (!found.length) return [];
    if (lastReply) {
      await Promise.all(found.filter((a) => a.category === 'finished').map(async (a) => {
        try {
          const r = await Promise.race([lastReply(a), new Promise((res) => setTimeout(() => res(null), 4000).unref?.())]);
          // The real context: an open question is needs-you ("asked you a question"), else
          // finished with an excerpt of the reply, never Claude's generic idle string.
          const ask = r?.ask ?? (r?.text ? classifyAsk({ text: r.text }) : null);
          if (ask) {
            a.ask = { kind: ask.kind, label: ask.label, text: ask.text, options: (ask.options ?? []).slice(0, 9) };
            if (ask.kind === 'finished') { a.body = ask.text || (r?.line ?? ''); }
            else { a.category = 'needs-you'; a.kind = ask.kind; a.title = `${a.name} ${ask.label}`; a.body = ask.text; a.key = a.key.replace('|finished|', `|${ask.kind}|`); }
          } else if (r?.text) a.body = r.line ?? clip(r.text, 200);
          if (r?.ts) a.meta = { ...(a.meta ?? {}), replyTs: r.ts };
          // A dialog that showed up as the turn ended: the screen hash lets a notification answer exactly that dialog.
          if (ask?.kind === 'decision' && r?.ask?.hash) a.meta = { ...(a.meta ?? {}), hash: r.ask.hash, options: a.ask.options };
        } catch { /* body stays empty */ }
      }));
    }
    for (const a of found) if (a.meta) { delete a.meta.transcript; delete a.meta.tmux; }
    return this.emit(found);
  }

  /** An event was appended to the truth file in this process (hook, manager, launch). */
  async ingestEvent(ev) {
    const a = alertFromEvent(ev, { names: this.names });
    if (!a) return [];
    // Claude's idle reminder a minute after a finish is the same news twice.
    // Claude's idle reminder a minute after the detector saw the finish (or the question) is old news.
    if (a.kind === 'idle_prompt' && this.ring.some((x) => x.sessionId === a.sessionId && (x.category === 'finished' || x.kind === 'question') && !x.test && _deps.now() - Date.parse(x.ts) < 10 * 60_000)) return [];
    if (this.#duplicateAsk(a)) return [];
    const settings = await _deps.settings().catch(() => null);
    const m = settings ? muteFor(a, settings, _deps.now()) : null;
    if (m) a.muted = `${m.scope} ${m.target}`;
    a.observer = _deps.host();
    if (!this.#fresh(a) || !this.#remember(a)) return [];
    this.#fan([a]);
    return [a];
  }

  /** Alerts pulled from another host's daemon (already in its WAL): remember and fan out only. */
  ingestRemote(items = [], { silent = false } = {}) {
    const out = [];
    for (const it of items) { if (!it?.id || this.seen.has(it.id)) continue; const a = { ...it, remote: true }; if (this.#remember(a)) out.push(a); }
    if (!silent) this.#fan(out);
    return silent ? [] : out;
  }

  /** MR list snapshot -> alerts for the watched authors (null = all). */
  async observeMRs(list, { mine } = {}) {
    const found = diffMRs(this.mrPrev, list, { mine });
    this.mrPrev = new Map(list.map((m) => [m.number, { number: m.number, author: m.author, eventCount: m.eventCount, mergeStatus: m.mergeStatus, approvals: m.approvals, state: m.state, title: m.title, url: m.url, lastEvent: m.lastEvent }]));
    return this.emit(found.map((a) => ({ ...a, source: 'mr', host: _deps.host() })));
  }

  recent({ since, limit = 100 } = {}) {
    const lim = Math.max(1, Math.min(RING_MAX, Number(limit) || 100));
    const items = since ? this.ring.filter((a) => a.ts > since || a.id === since) : this.ring;
    return items.slice(-lim);
  }
}

export const notifier = new Notifier();

/** Ring for `drover rpc` / MCP processes: read what the daemon on this machine wrote. */
async function ringFromDisk() {
  try {
    const d = JSON.parse(await readFile(_deps.ringFile(), 'utf8'));
    let running = false;
    try { const dj = JSON.parse(await readFile(_deps.daemonFile(), 'utf8')); running = pidAlive(dj.pid) && dj.pid === d.pid; } catch { /* no daemon */ }
    return { running, items: Array.isArray(d.items) ? d.items : [], host: d.host ?? null, pid: d.pid ?? null };
  } catch { return { running: false, items: [], host: null, pid: null }; }
}

const SAMPLES = {
  'needs-you': { title: 'webapp-f8 needs you', body: 'Do you want to proceed? 1. Yes / 2. Yes, and do not ask again / 3. No' },
  finished: { title: 'webapp-f8 finished', body: 'Done: 148 tests pass, pushed 3 commits to origin/main.' },
  error: { title: 'billing-22 exited unexpectedly', body: '~/code/billing' },
  held: { title: 'base-8f is holding a peer message', body: 'from webapp-06; accept or drop it in the pane' },
  mr: { title: '!42 comment, now mergeable', body: 'feat(billing): structured logging for the invoice export' },
  launch: { title: 'Launched claude in agents:12', body: 'claude-default in ~/code/webapp' },
  manager: { title: 'The manager replied', body: 'Two sessions are waiting on you: webapp-f8 (dialog) and base-8f (held message).' },
};

async function notifyList({ since, limit = 100, category, includeTests = false } = {}) {
  const all = await _deps.readEvents();
  let items = all.filter((e) => e.type === 'notify' && (includeTests || !e.test));
  if (category) items = items.filter((e) => (e.category ?? 'needs-you') === category);
  if (since) items = items.filter((e) => e.ts > since || e.id === since);
  // Two daemons can record the same transition (same key); keep the first.
  const seenKeys = new Set();
  items = items.filter((e) => { if (!e.key) return true; if (seenKeys.has(e.key)) return false; seenKeys.add(e.key); return true; });
  const lim = Math.max(1, Math.min(1000, Number(limit) || 100));
  return items.slice(-lim).reverse();
}

export const ops = {
  /** Recent alerts on this machine (from the daemon's ring); the front pulls these from other hosts. */
  'notify.recent': async ({ since, limit } = {}) => {
    if (notifier.daemon) return { detector: { running: true, host: _deps.host(), pid: process.pid }, items: notifier.recent({ since, limit }) };
    const disk = await ringFromDisk();
    const lim = Math.max(1, Math.min(RING_MAX, Number(limit) || 100));
    const items = (since ? disk.items.filter((a) => a.ts > since) : disk.items).slice(-lim);
    return { detector: { running: disk.running, host: disk.host ?? _deps.host(), pid: disk.pid }, items };
  },
  'notify.list': (a = {}) => notifyList(a),
  /** Fire a sample alert in a category so the Settings view (or an agent) can hear and see it. */
  'notify.test': async ({ category = 'needs-you', actor = OWNER } = {}) => {
    if (!CATEGORY_IDS.includes(category)) throw new Error(`category must be one of ${CATEGORY_IDS.join(', ')}`);
    const s = SAMPLES[category];
    const [alert] = await notifier.emit([{ category, kind: 'test', test: true, source: 'test', actor, host: _deps.host(), name: 'test', title: `Test: ${s.title}`, body: s.body, key: `test|${category}|${_deps.now()}` }]);
    const settings = await _deps.settings();
    return { alert, decision: decide(alert, settings, { now: _deps.now() }), label: CATEGORIES.find((c) => c.id === category)?.label };
  },
  /** An agent asks for the owner's attention (lands as an alert and in the truth file). */
  'notify.send': async ({ title, body = '', category = 'needs-you', sessionId, name, actor = 'mcp' } = {}) => {
    if (typeof title !== 'string' || !title.trim()) throw new Error('title must be a non-empty string');
    if (!CATEGORY_IDS.includes(category)) throw new Error(`category must be one of ${CATEGORY_IDS.join(', ')}`);
    const [alert] = await notifier.emit([{ category, kind: 'agent', source: 'agent', actor, host: _deps.host(), sessionId: sessionId ?? null, name: name ?? actor, title: clip(title, 200), body: clip(body, 600), key: `agent|${actor}|${title}|${Math.floor(_deps.now() / 30_000)}` }]);
    return { ok: Boolean(alert), alert: alert ?? null, deduped: !alert };
  },
};

export { foldSettings };
