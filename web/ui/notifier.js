// Browser side of alerts. The daemon detects transitions and sends `alerts`
// batches over SSE; this module decides what this device does with them,
// using the same policy module as the daemon (notify-policy.js):
//
//  - settings: cached in localStorage, refreshed from settings.get, kept current
//    by the `settings` SSE event; changes go through settings.set
//  - one leader tab per browser (Web Locks) plays sounds and raises desktop
//    notifications, so three open tabs do not ring three times
//  - away detection: the Idle Detection API when permitted, else page
//    visibility and focus
//  - a short coalescing window: a burst becomes one grouped notification and
//    one sound; desktop notifications are rate limited per minute
//  - notifications go through the service worker when it is active (action
//    buttons: Approve / Deny / Reply / Open), else the plain Notification API
import { DEFAULT_SETTINGS, CATEGORIES, decide, coalesce, rateLimit, speechFor, mergeSettings, clone } from './notify-policy.js';
import { pressKey, announceAnswered } from './answer-model.js';
import * as sounds from './sounds.js';
import * as speech from './speech.js';

const CACHE_KEY = 'drover.settings';
const HISTORY_MAX = 200;

export class Notifier {
  constructor(ctx) {
    this.ctx = ctx;
    this.settings = loadCached();
    this.meta = { updated: null, by: null, catalog: { categories: CATEGORIES } };
    this.leader = false;
    this.away = false; this.idleState = null; this.idleDetector = null; this.idleError = null;
    this.buffer = []; this.flushTimer = null; this.shownTimes = []; this.sounded = new Map(); this.stats = { received: 0, desktop: 0, sounds: 0, toasts: 0 };
    this.history = []; // alerts this tab saw, newest first (the Settings view shows them)
    this.listeners = new Set();
    this.sw = null;
    this.#elect();
    this.#watchPresence();
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  #changed(kind) { for (const l of this.listeners) { try { l(kind, this); } catch (e) { console.error(e); } } }

  // ------------------------------------------------------------ settings
  async refresh() {
    try {
      const r = await this.ctx.callQuiet('settings.get', {}, { host: 'local' });
      this.#apply(r);
    } catch (e) { console.warn('settings.get failed; using the cached copy', e.message); }
    return this.settings;
  }
  #apply(r) {
    if (!r?.settings) return;
    this.settings = r.settings; this.meta = { updated: r.updated, by: r.by, catalog: r.catalog ?? this.meta.catalog, activeMutes: r.activeMutes ?? [], defaults: r.defaults };
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ settings: r.settings, updated: r.updated })); } catch { /* quota */ }
    this.#changed('settings');
    this.#startIdle().catch(() => {});
  }
  /** SSE `settings` (another tab, an agent, or settings.set from here). */
  onSettings(r) { this.#apply(r); }
  async set(patch, { reason } = {}) {
    const r = await this.ctx.call('settings.set', { patch, ...(reason ? { reason } : {}) }, { host: 'local' });
    this.#apply(r); return r;
  }
  /** Patch the local copy at once for a responsive control; the server answer replaces it. */
  preview(patch) { this.settings = mergeSettings(this.settings, patch); this.#changed('settings'); }

  // ------------------------------------------------------------ leader election
  #elect() {
    if (document.documentElement.classList.contains('solo')) return;   // pop-out windows never ring
    if (!navigator.locks?.request) { this.leader = true; return; }
    navigator.locks.request('drover-alerts-leader', { mode: 'exclusive' }, () => { this.leader = true; this.#changed('leader'); return new Promise(() => {}); }).catch(() => { this.leader = true; });
  }

  // ------------------------------------------------------------ presence
  #watchPresence() {
    const upd = () => { const was = this.away; this.away = this.#computeAway(); if (was !== this.away) this.#changed('presence'); };
    document.addEventListener('visibilitychange', upd);
    window.addEventListener('focus', upd); window.addEventListener('blur', upd);
    this.updPresence = upd; upd();
  }
  #computeAway() {
    if (this.idleState && (this.idleState.user === 'idle' || this.idleState.screen === 'locked')) return true;
    if (document.visibilityState !== 'visible') return true;
    // Without idle detection, a window that has lost focus counts as away.
    return !this.idleDetector && !document.hasFocus();
  }
  presence() { return { away: this.away, visible: document.visibilityState === 'visible', focused: document.hasFocus(), idle: this.idleState, idleDetection: Boolean(this.idleDetector), idleError: this.idleError }; }
  async idlePermission() {
    if (!('IdleDetector' in window)) return 'unsupported';
    try { return (await navigator.permissions.query({ name: 'idle-detection' })).state; } catch { return 'unknown'; }
  }
  /** Ask for idle detection (needs a click). */
  async requestIdle() {
    if (!('IdleDetector' in window)) throw new Error('This browser has no Idle Detection API');
    const p = await IdleDetector.requestPermission();
    if (p !== 'granted') throw new Error('Idle detection was not allowed');
    await this.#startIdle(true);
    return p;
  }
  async #startIdle(force = false) {
    if (!this.settings.away?.useIdleDetection) { this.#stopIdle(); return; }
    if (!('IdleDetector' in window)) return;
    if (!force && (await this.idlePermission()) !== 'granted') return;
    const threshold = Math.max(60, Number(this.settings.away?.idleSeconds) || 60) * 1000;
    if (this.idleDetector && this.idleThreshold === threshold) return;
    this.#stopIdle();
    try {
      const ctl = new AbortController(); const d = new IdleDetector();
      d.addEventListener('change', () => { this.idleState = { user: d.userState, screen: d.screenState }; this.updPresence(); });
      await d.start({ threshold, signal: ctl.signal });
      this.idleDetector = d; this.idleCtl = ctl; this.idleThreshold = threshold; this.idleError = null;
      this.idleState = { user: d.userState, screen: d.screenState }; this.updPresence();
    } catch (e) { this.idleError = e.message; }
  }
  #stopIdle() { try { this.idleCtl?.abort(); } catch { /* fine */ } this.idleDetector = null; this.idleCtl = null; this.idleState = null; }

  // ------------------------------------------------------------ desktop permission + service worker
  permission() { return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission; }
  async requestPermission() { if (typeof Notification === 'undefined') throw new Error('This browser has no Notification API'); const p = await Notification.requestPermission(); this.#changed('permission'); return p; }
  useServiceWorker(reg) { this.sw = reg; }

  // ------------------------------------------------------------ alerts in
  /** An `alerts` SSE batch (or a local test). */
  receive(items = []) {
    for (const a of items) {
      if (!a) continue;
      this.history.unshift(a); if (this.history.length > HISTORY_MAX) this.history.length = HISTORY_MAX;
      this.buffer.push(a); this.stats.received++;
    }
    this.#changed('history');
    const win = Math.max(0, Number(this.settings.coalesce?.windowMs ?? 2500));
    clearTimeout(this.flushTimer);
    // The first alert of a quiet spell waits the window so its siblings can join it.
    this.flushTimer = setTimeout(() => this.#flush(), this.buffer.some((a) => a.test) ? 0 : win);
  }

  async #flush() {
    const batch = this.buffer.splice(0);
    if (!batch.length) return;
    const now = Date.now();
    const visible = document.visibilityState === 'visible';
    const decided = batch.map((a) => ({ a, d: decide(a, this.settings, { now, away: this.away, visible }) })).filter((x) => x.d.show);
    if (!decided.length) return;
    // Toasts: in every visible tab, one per group.
    const groups = coalesce(decided.map((x) => ({ ...x.a, _d: x.d })));
    for (const g of groups) {
      const d = g.alerts.map((a) => a._d);
      if (d.some((x) => x.toast)) this.ctx.toast(`${g.title}${g.body ? ': ' + g.body : ''}`, g.category === 'error' ? 'error' : g.category === 'finished' ? 'ok' : 'info', d.some((x) => x.sticky) ? 12_000 : 6000, { onClick: () => this.open(g) });
    }
    if (!this.leader) return;
    // One sound per flush (the highest-priority group's), then desktop + speech per group.
    // An ask that only upgrades one already sounded for the same session (hook, then the
    // dialog itself) stays quiet.
    const fresh = (a) => !(a.sessionId && a.category === 'needs-you' && now - (this.sounded.get(a.sessionId) ?? 0) < 90_000);
    const loud = groups.find((g) => g.alerts.some((a) => a._d.sound !== 'none' && (a.test || fresh(a))));
    if (loud) { const d = loud.alerts.find((a) => a._d.sound !== 'none')._d; sounds.play(d.sound, d.volume).catch(() => {}); }
    for (const g of groups) for (const a of g.alerts) if (a.sessionId && a.category === 'needs-you') this.sounded.set(a.sessionId, now);
    for (const g of groups) {
      const d = g.alerts.map((a) => a._d);
      if (d.some((x) => x.desktop)) {
        const rl = rateLimit(this.shownTimes, { now, maxPerMinute: this.settings.coalesce?.maxPerMinute ?? 8 });
        this.shownTimes = rl.history;
        if (rl.allowed || g.alerts.some((a) => a.test)) await this.#desktop(g, { sticky: d.some((x) => x.sticky) }).catch((e) => console.warn('notification failed', e));
      }
      if (d.some((x) => x.speak)) speech.speak(speechFor(g), this.settings.speech).catch(() => {});
    }
  }

  /** Notification actions for a group (at most two; Chrome shows two). */
  actionsFor(g) {
    if (!g.single) return [{ action: 'open', title: 'Open board' }];
    const a = g.alerts[0];
    if ((a.category === 'needs-you' && a.kind === 'dialog') || a.category === 'held') return a.target && a.meta?.hash ? [{ action: 'approve', title: a.category === 'held' ? 'Deliver (Enter)' : 'Approve (Enter)' }, { action: 'deny', title: 'Deny (Esc)' }] : [{ action: 'open', title: 'Open' }];
    if (a.sessionId && ['finished', 'needs-you'].includes(a.category)) return [{ action: 'reply', title: 'Reply', type: 'text', placeholder: `Reply to ${a.name ?? 'the session'}` }, { action: 'open', title: 'Open' }];
    if (a.category === 'mr' && a.meta?.url) return [{ action: 'open', title: 'Open MR' }];
    return [{ action: 'open', title: 'Open' }];
  }
  dataFor(g) {
    const a = g.alerts[0];
    return { single: g.single, ids: g.alerts.map((x) => x.id), category: g.category, host: hostForUi(a.host, this.ctx), sessionId: a.sessionId ?? null, target: a.target ?? null, hash: a.meta?.hash ?? null, name: a.name ?? null, engine: a.engine ?? null, url: a.meta?.url ?? null, number: a.meta?.number ?? null, kind: a.kind ?? null };
  }
  async #desktop(g, { sticky }) {
    if (this.permission() !== 'granted') return false;
    const a0 = g.alerts[0];
    // Asks for one session share a tag, so a dialog alert replaces the hook's plainer one.
    const tag = g.single ? (a0.sessionId && ['needs-you', 'held'].includes(a0.category) && !a0.test ? `drover-ask-${a0.host}-${a0.sessionId}` : `drover-${a0.key ?? a0.id}`) : `drover-group-${g.category}`;
    const opts = { body: g.body ?? '', tag, renotify: true, requireInteraction: Boolean(sticky), silent: true, icon: '/icon.svg', badge: '/icon.svg', data: this.dataFor(g), timestamp: Date.now() };
    if (this.sw?.active && this.sw.showNotification) {
      await this.sw.showNotification(g.title, { ...opts, actions: this.actionsFor(g) });
      this.stats.desktop++; this.lastDesktop = { title: g.title, tag, actions: this.actionsFor(g).map((x) => x.action) };
      return true;
    }
    const n = new Notification(g.title, opts);
    n.onclick = () => { window.focus(); this.handleAction('open', opts.data); n.close(); };
    return true;
  }

  // ------------------------------------------------------------ actions (clicks, SW messages, PiP buttons)
  open(g) { this.handleAction('open', this.dataFor(g)); }
  async handleAction(action, data = {}, reply) {
    window.focus();
    const host = data.host ?? 'local';
    if (action === 'approve' || action === 'deny') {
      // sessions.answer on the dialog the alert was raised on (its hash); tmux.answer on a daemon without the op.
      const m = { id: data.sessionId ?? data.target, target: data.target, host, hash: data.hash ?? null };
      try {
        const r = await pressKey((op, args, opts) => this.ctx.callQuiet(op, args, opts), m, action === 'approve' ? 'Enter' : 'Escape', { verify: true });
        if (r.refused) { this.ctx.toast(`Not sent: ${r.reason}. Opening the pane.`, 'error', 8000); this.ctx.open({ kind: 'window', id: data.target, host, name: data.name, sessionId: data.sessionId, tab: 'screen' }); }
        else { this.ctx.toast(`${action === 'approve' ? 'Approved' : 'Denied'}${r.dialog?.question ? `: ${r.dialog.question}` : ''}`, 'ok'); announceAnswered(m, action === 'approve' ? 'Enter' : 'Escape'); }
      } catch (e) { this.ctx.toast(`Answer: ${e.message}`, 'error'); }
      return;
    }
    if (action === 'reply') {
      if (reply && data.sessionId) {
        try { await this.ctx.callQuiet('sessions.message', { id: data.sessionId, text: reply }, { host }); this.ctx.toast(`Sent to ${data.name ?? 'the session'}`, 'ok'); }
        catch (e) { this.ctx.toast(`sessions.message: ${e.message}`, 'error'); }
        return;
      }
      if (data.sessionId) { this.ctx.open({ kind: 'session', id: data.sessionId, host, name: data.name, engine: data.engine, focusComposer: true }); return; }
    }
    if (data.category === 'mr' && data.number) { this.ctx.nav('mrs', String(data.number)); return; }
    if (!data.single) { this.ctx.nav('board'); return; }
    if (data.sessionId && data.sessionId !== 'manager') this.ctx.open({ kind: 'session', id: data.sessionId, host, name: data.name, engine: data.engine });
    else if (data.sessionId === 'manager') this.ctx.open({ kind: 'session', id: 'manager', host, engine: 'openclaw', name: 'manager' });
    else if (data.target) this.ctx.open({ kind: 'window', id: data.target, host, name: data.name });
    else this.ctx.nav('board');
  }

  /** Fire a category's sound + speech here at once (the Settings preview buttons). */
  async audition(category) {
    const c = this.settings.categories?.[category] ?? DEFAULT_SETTINGS.categories[category];
    await sounds.play(c.sound, c.volume);
    if (c.speak) await speech.speak(`${CATEGORIES.find((x) => x.id === category)?.label ?? category} alert`, this.settings.speech);
  }
}

/** Alerts name the host as the daemon saw it; the UI calls the front daemon's own host "local". */
export function hostForUi(host, ctx) {
  if (!host) return 'local';
  if (host === ctx.state.frontHost) return 'local';
  return ctx.hosts().some((h) => h.name === host) ? host : 'local';
}

function loadCached() {
  try { const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); if (c?.settings) return mergeSettings(DEFAULT_SETTINGS, c.settings); } catch { /* bad cache */ }
  return clone(DEFAULT_SETTINGS);
}
