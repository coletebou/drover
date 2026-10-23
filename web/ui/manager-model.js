// The manager conversation, shared by everything that shows it on a page (the board's dock, the popup, the Manager
// view, a floating window): one store, so a thread, a draft and a reply in flight are the same everywhere.
// DOM-free: it is given the call function and fed SSE events (tested in test/ui-manager-model.test.js).
//
// Sending uses sessions.message { id: "manager", text, wait: false, thread }: the answer is { pending: true,
// event, turnId } and the reply streams as `manager` events (start, delta, done, error), then lands as a `turn`
// event and in sessions.transcript. A daemon from before that answers with `reply` in the call; both work. When
// no event arrives (a manager on another host, an old daemon), the transcript is read every few seconds until the
// reply is there.
import { mergeTurns, rebase } from './chat-model.js';
import { owner } from './owner.js';

export const THREAD_RE = /^[A-Za-z0-9_.:@%-]{1,64}$/;   // core/openclaw.js threadOf
export const MAIN = 'main';
const HISTORY_KEY = 'drover.manager.history';
const HOST_KEY = 'drover.manager.host';
const THREAD_KEY = 'drover.manager.thread';
const DRAFT_KEY = 'drover.manager.drafts';
const COST_EVERY_MS = 5 * 60_000;
const QUIET_MS = 5000;      // no stream event this long after a send: read the transcript instead
const POLL_MS = 3000;
const GIVE_UP_MS = 15 * 60_000;
const MAX_TURNS = 400;      // a conversation keeps its newest turns in memory; a read brings back the window it shows
const iso = (ms) => new Date(ms).toISOString();

/** Does a turn finish a request: a reply, or the daemon's line saying the reply failed? */
export const finishes = (t) => Boolean(t) && !t.pending && (t.role === 'assistant' || (t.role === 'system' && t.error != null));
/** The newest MAX_TURNS turns; what only this client has (an echo, a reply still streaming) is never dropped. */
export function capTurns(turns, max = MAX_TURNS) {
  if (turns.length <= max) return turns;
  let drop = turns.length - max;
  return turns.filter((t) => { if (drop > 0 && !t.local && !t.pending && !t.streamed && !t.localReply) { drop--; return false; } return true; });
}
/** The manager's own window (app.js boots it): #/pop/manager/<host>/<thread>. */
export const popHash = (host = 'local', thread = MAIN) => `#/pop/manager/${encodeURIComponent(host || 'local')}${thread && thread !== MAIN ? `/${encodeURIComponent(thread)}` : ''}`;
export function parsePopHash(hash) {
  const m = String(hash ?? '').match(/^#\/pop\/manager(?:\/([^/]*))?(?:\/([^/]*))?/);
  if (!m) return null;
  const dec = (v) => { try { return decodeURIComponent(v ?? ''); } catch { return v ?? ''; } };
  return { host: dec(m[1]) || 'local', thread: dec(m[2]) || MAIN };
}

export class ManagerStore {
  /**
   * call(op, args, { host }) -> result; storage: localStorage-like (optional); frontHost() -> this daemon's host
   * name, so a `manager` event named for it counts as "local".
   */
  constructor({ call, storage = null, now = () => Date.now(), frontHost = () => null, timers = { set: (f, ms) => setTimeout(f, ms), clear: (t) => clearTimeout(t) } } = {}) {
    Object.assign(this, { callOp: call, storage, now, frontHost, timers });
    this.pinnedHost = Boolean(this.#get(HOST_KEY));
    this.host = this.#get(HOST_KEY) || 'local';
    this.thread = THREAD_RE.test(this.#get(THREAD_KEY) ?? '') ? this.#get(THREAD_KEY) : MAIN;
    this.convs = new Map();
    this.threads = null;         // [{ thread, turns, lastTs, lastText }] once openclaw.threads answered; null before (or never, on an old daemon)
    this.threadsOp = null;       // false: the daemon has no openclaw.threads (asked once per host)
    this.status = { up: null, sessionStatus: null, cost: null, costAt: 0, lastNoteAt: null };
    this.history = this.#json(HISTORY_KEY, []);
    this.drafts = new Map(Object.entries(this.#json(DRAFT_KEY, {})));
    this.listeners = new Set();
    this.seq = 0; this.lastEventAt = 0;
    this.awaiting = new Map();   // thread -> { since, event, turnId, timer }
  }
  #get(k) { try { return this.storage?.getItem(k) ?? null; } catch { return null; } }
  #set(k, v) { try { if (v == null) this.storage?.removeItem(k); else this.storage?.setItem(k, v); } catch { /* quota */ } }
  #json(k, d) { try { return JSON.parse(this.#get(k) ?? '') ?? d; } catch { return d; } }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(what, thread = this.thread) { for (const l of [...this.listeners]) { try { l(what, thread); } catch (e) { console.error('manager listener', e); } } }
  call(op, args) { return this.callOp(op, args, { host: this.host }); }

  conv(thread = this.thread) {
    if (!this.convs.has(thread)) this.convs.set(thread, { turns: [], offset: 0, loaded: false, loading: null, error: null });
    return this.convs.get(thread);
  }
  turns(thread = this.thread) { return this.conv(thread).turns; }
  /** A reply is in flight in this thread (streaming, or sent and not answered yet). */
  busy(thread = this.thread) { return this.awaiting.has(thread) || this.turns(thread).some((t) => t.pending); }
  /** 'busy' | 'up' | 'down' | 'unknown', for the status mark. */
  state(thread = this.thread) {
    if (this.busy(thread) || this.status.sessionStatus === 'busy') return 'busy';
    if (this.status.up === false || this.conv(thread).error) return 'down';
    return this.status.up ? 'up' : 'unknown';
  }

  /** Is an event from this host's manager? Events name the daemon's host; "local" is the front daemon. */
  mine(host) {
    if (host == null) return this.host === 'local';
    if (host === this.host) return true;
    return this.host === 'local' && (host === 'local' || host === this.frontHost());
  }
  setHost(host, { pin = true } = {}) {
    const h = host || 'local';
    if (pin) { this.pinnedHost = true; this.#set(HOST_KEY, h); }
    if (h === this.host) return;
    for (const a of this.awaiting.values()) this.timers.clear(a.timer);
    this.host = h; this.convs.clear(); this.awaiting.clear(); this.threads = null; this.threadsOp = null;
    this.status = { up: null, sessionStatus: null, cost: null, costAt: 0, lastNoteAt: null };
    this.emit('host');
    this.load();
  }
  setThread(thread) {
    const t = String(thread ?? '').trim() || MAIN;
    if (!THREAD_RE.test(t)) throw new Error('a thread name is 1 to 64 letters, digits, or . _ : @ % -');
    if (t === this.thread) return;
    this.thread = t; this.#set(THREAD_KEY, t === MAIN ? null : t);
    this.emit('thread', t);
    this.ensure(t);
  }
  ensure(thread = this.thread) { const c = this.conv(thread); return c.loaded || c.loading ? c.loading : this.load(thread); }

  /** Read the whole conversation (the last 200 turns) and line it up with what is shown. */
  load(thread = this.thread) {
    const c = this.conv(thread);
    if (c.loading) return c.loading;
    c.loading = (async () => {
      try {
        const r = await this.call('sessions.transcript', { id: 'manager', thread, since: 0, limit: 200 });
        // An older daemon has one conversation and no thread field: it is "main".
        const server = (r?.turns ?? []).filter((t) => (t.thread ?? MAIN) === thread);
        c.turns = capTurns(rebase(c.turns, server));
        c.offset = r?.offset ?? c.turns.length; c.loaded = true; c.error = null;
        if (this.status.up == null) this.status.up = true;
        this.#settleIf(thread, server);
        this.#adoptPending(thread);
      } catch (e) {
        c.error = /not found/i.test(e.message) ? `No manager on ${this.host === 'local' ? 'this machine' : this.host}` : e.message;
        if (/not found/i.test(e.message)) this.status.up = false;
      } finally { c.loading = null; }
      this.emit('turns', thread);
    })();
    return c.loading;
  }

  // ------------------------------------------------------------ events
  /** SSE `manager`: { host, thread, turnId, inReplyTo, phase, delta?, text?, error? }. */
  onStream(ev) {
    if (!ev || !this.mine(ev.host)) return;
    this.lastEventAt = this.now();
    const thread = ev.thread ?? MAIN;
    const c = this.conv(thread);
    // The turn a stream event grows is one of the last few: look there, not through the whole conversation.
    let i = -1;
    for (let k = c.turns.length - 1; k >= Math.max(0, c.turns.length - 12); k--) {
      const t = c.turns[k];
      if ((ev.turnId != null && t.id === ev.turnId) || (ev.inReplyTo != null && t.role === 'assistant' && t.inReplyTo === ev.inReplyTo && (t.pending || t.streamed))) { i = k; break; }
    }
    const prev = i >= 0 ? c.turns[i] : null;
    const text = typeof ev.text === 'string' ? ev.text : `${prev?.text ?? ''}${ev.delta ?? ''}`;
    const turn = { ...(prev ?? {}), role: 'assistant', id: ev.turnId ?? prev?.id ?? `stream:${ev.inReplyTo}`, thread, inReplyTo: ev.inReplyTo ?? prev?.inReplyTo ?? null, text, ts: prev?.ts ?? iso(this.now()), streamed: true, pending: ev.phase === 'start' || ev.phase === 'delta', error: ev.phase === 'error' ? (ev.error || 'the manager did not answer') : null };
    if (prev && (prev.pending || prev.streamed)) { const next = c.turns.slice(); next[i] = turn; c.turns = next; }
    else c.turns = capTurns(mergeTurns(c.turns, [turn]));   // first event of a reply, or one after its final turn (dropped there)
    if (ev.phase === 'done' || ev.phase === 'error') this.#settle(thread, ev.inReplyTo);
    this.emit('turns', thread);
  }
  /** SSE `turn` with id "manager": { host, thread, turn }. */
  onTurn(ev) {
    if (!ev?.turn || !this.mine(ev.host)) return;
    this.lastEventAt = this.now();
    const thread = ev.thread ?? ev.turn.thread ?? MAIN;
    const c = this.conv(thread);
    c.turns = capTurns(mergeTurns(c.turns, [ev.turn]));
    c.offset = Math.max(c.offset, c.turns.filter((t) => !t.local && !t.streamed && !t.localReply && !t.pending).length);
    if (finishes(ev.turn)) this.#settle(thread, ev.turn.inReplyTo);
    this.emit('turns', thread);
    if (this.threads && !this.threads.some((t) => t.thread === thread)) this.refreshThreads();
  }
  /** The board's manager field ({ up, host, lastNoteAt }), host already in the UI's names. */
  onBoard(m) {
    if (!m) return;
    if (!this.pinnedHost && m.host && m.host !== this.host) this.setHost(m.host, { pin: false });
    const was = this.status.up;
    this.status.up = m.up ?? this.status.up; this.status.lastNoteAt = m.lastNoteAt ?? this.status.lastNoteAt;
    if (was !== this.status.up) this.emit('status');
  }
  /** After an SSE reconnect: events may have been missed while it was down. */
  resync() { for (const [thread, c] of this.convs) if (c.loaded) this.load(thread); }
  #settle(thread, inReplyTo) {
    const a = this.awaiting.get(thread);
    if (!a || (inReplyTo != null && a.event != null && inReplyTo !== a.event)) return;
    this.timers.clear(a.timer); this.awaiting.delete(thread);
  }
  /** A read that holds the turn finishing what is awaited (a reply, or its failure) ends the wait. */
  #settleIf(thread, turns) {
    const a = this.awaiting.get(thread);
    if (!a) return;
    const ends = (t) => finishes(t) && (a.event != null ? t.inReplyTo === a.event : Date.parse(t.ts ?? '') >= a.since - 2000);
    if (turns.some(ends)) this.#settle(thread, a.event);
  }
  /**
   * A reply already on its way when this page read the conversation (opened mid-reply, or after a dropped stream):
   * wait for it like one sent from here, so the transcript is read when no event brings it (a remote manager).
   */
  #adoptPending(thread) {
    if (this.awaiting.has(thread)) return;
    const p = [...this.conv(thread).turns].reverse().find((t) => t.pending && t.role === 'assistant');
    if (!p) return;
    const wait = { since: this.now(), event: p.inReplyTo ?? null, turnId: p.id ?? null, timer: null };
    this.awaiting.set(thread, wait);
    this.#watch(thread, wait);
  }

  // ------------------------------------------------------------ actions
  /** Send a message to the manager in a thread. The echo shows at once and gives way to the server's copy. */
  async send(text, { thread = this.thread, keepDraft = false } = {}) {
    const body = String(text ?? '');
    if (!body.trim()) return null;
    const c = this.conv(thread);
    const echo = { role: 'user', text: body, ts: iso(this.now()), local: true, localId: `local:${++this.seq}`, thread, actor: owner() };
    c.turns = capTurns([...c.turns, echo]);
    this.pushHistory(body); if (!keepDraft) this.setDraft(thread, '');
    const wait = { since: this.now(), event: null, turnId: null, timer: null };
    this.awaiting.set(thread, wait);
    this.emit('turns', thread);
    let r;
    try { r = await this.call('sessions.message', { id: 'manager', text: body, wait: false, thread }); }
    catch (e) {
      c.turns = c.turns.map((t) => (t.localId === echo.localId ? { ...t, failed: e.message } : t));
      if (this.awaiting.get(thread) === wait) this.awaiting.delete(thread);
      this.emit('turns', thread);
      throw e;
    }
    const mine = c.turns.find((t) => t.localId === echo.localId); if (mine && r?.event != null) mine.serverId = r.event;
    if (typeof r?.reply === 'string') {
      // A daemon from before streaming answers inside the call; its transcript (read next) has the same turns.
      const answered = c.turns.some((t) => t.role === 'assistant' && !t.local && r.event != null && t.inReplyTo === r.event);
      if (!answered) c.turns = mergeTurns(c.turns, [{ role: 'assistant', text: r.reply, ts: iso(this.now()), localReply: true, localId: `local:${++this.seq}`, inReplyTo: r.event ?? null, model: r.model ?? null, thread }]);
      if (this.awaiting.get(thread) === wait) this.awaiting.delete(thread);
      this.emit('turns', thread);
      this.load(thread);
    } else if (r?.pending && this.awaiting.get(thread) === wait) {
      Object.assign(wait, { event: r.event ?? null, turnId: r.turnId ?? null });
      // Settled already by a fast reply's events that beat this answer here?
      if (r.event != null && c.turns.some((t) => finishes(t) && t.inReplyTo === r.event)) this.#settle(thread, r.event);
      else this.#watch(thread, wait);
    } else if (this.awaiting.get(thread) === wait) this.awaiting.delete(thread);
    this.emit('turns', thread);
    return r;
  }
  /** Read the transcript while a reply is awaited and no event has come for a while. */
  #watch(thread, wait) {
    const tick = async () => {
      if (this.awaiting.get(thread) !== wait) return;
      if (this.now() - wait.since > GIVE_UP_MS) { this.awaiting.delete(thread); this.emit('turns', thread); return; }
      if (this.now() - Math.max(this.lastEventAt, wait.since) >= QUIET_MS) await this.poll(thread).catch(() => {});
      if (this.awaiting.get(thread) === wait) wait.timer = this.timers.set(tick, POLL_MS);
    };
    wait.timer = this.timers.set(tick, POLL_MS);
  }
  /** One incremental read: the last few turns again (a pending turn changes in place) plus anything new. */
  async poll(thread = this.thread) {
    const c = this.conv(thread);
    const r = await this.call('sessions.transcript', { id: 'manager', thread, since: Math.max(0, (c.offset ?? 0) - 4), limit: 200 });
    const server = (r?.turns ?? []).filter((t) => (t.thread ?? MAIN) === thread);
    c.turns = capTurns(mergeTurns(c.turns, server)); c.offset = r?.offset ?? c.offset;
    this.#settleIf(thread, server);
    this.emit('turns', thread);
    return r;
  }
  /** Ask the manager to sweep now (not a chat message); a line in the conversation says so. */
  async sweep(thread = this.thread) {
    const r = await this.call('openclaw.sweep', {});
    const c = this.conv(thread);
    c.turns = capTurns([...c.turns, { role: 'system', text: 'Asked the manager to sweep now. Its notes land in the truth file (the Manager view feed).', ts: iso(this.now()), local: true, localId: `local:${++this.seq}`, thread }]);
    this.emit('turns', thread);
    return r;
  }
  async refreshThreads() {
    if (this.threadsOp === false) return null;   // a daemon without threads: asked once
    try { const r = await this.call('openclaw.threads', {}); this.threads = Array.isArray(r) ? r : Array.isArray(r?.threads) ? r.threads : []; this.threadsOp = true; }
    catch (e) { if (/unknown op/i.test(e.message)) { this.threads = null; this.threadsOp = false; } }
    this.emit('threads');
    return this.threads;
  }
  /** Today's cost from openclaw.status (cached on the daemon; asked at most every five minutes here). */
  async refreshCost({ force = false } = {}) {
    if (!force && this.now() - this.status.costAt < COST_EVERY_MS) return this.status.cost;
    this.status.costAt = this.now();
    try {
      const st = await this.call('openclaw.status', {});
      if (st?.configured === false) this.status.up = false;
      const usd = st?.cost?.todayUsd;
      this.status.cost = Number.isFinite(Number(usd)) && usd != null ? { usd: Number(usd), fresh: Boolean(st.cost.fresh) } : null;
      if (st?.gateway) this.status.up = Boolean(st.gateway.up);
    } catch { /* the console shows why */ }
    this.emit('status');
    return this.status.cost;
  }
  async refreshSession() {
    try { const s = await this.call('sessions.get', { id: 'manager' }); this.status.sessionStatus = s?.status ?? null; this.status.up = s ? s.live !== false && s.status !== 'down' : false; }
    catch { this.status.up = false; }
    this.emit('status');
  }

  // ------------------------------------------------------------ drafts and history
  draft(thread = this.thread) { return this.drafts.get(thread) ?? ''; }
  /** Every mounted composer shows the same draft: a change here (typing, or a send clearing it) reaches the others. */
  setDraft(thread, text) {
    const was = this.drafts.get(thread) ?? '';
    if (text) this.drafts.set(thread, text); else this.drafts.delete(thread);
    this.#set(DRAFT_KEY, this.drafts.size ? JSON.stringify(Object.fromEntries(this.drafts)) : null);
    if (was !== (text ?? '')) this.emit('draft', thread);
  }
  pushHistory(text) {
    const t = String(text).trim(); if (!t) return;
    this.history = [t, ...this.history.filter((x) => x !== t)].slice(0, 50);
    this.#set(HISTORY_KEY, JSON.stringify(this.history));
  }
}
