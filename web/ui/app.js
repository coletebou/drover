// Shell: token gate, host strip, tab strip, hash router, SSE fan-out, drawer,
// command palette, toasts, keyboard, alerts (notifier, badges, service worker),
// the manager (one conversation store, the popup, the floating window), and the
// solo windows (a popped-out drawer, the waiting board popup, the manager).
// Views live in ./views/*.js and expose { id, label, key, topics?, mount(root, ctx, params) -> ctrl }.
import './legacy-storage.js';
import * as api from './api.js';
import { h, clear, dot, setHomes } from './dom.js';
import { Drawer } from './drawer.js';
import { Palette } from './palette.js';
import { Notifier } from './notifier.js';
import * as badge from './badge.js';
import { openWaitingWindow, mountWaiting } from './pip.js';
import { openMenu } from './menu.js';
import { normalizeBoard, currentStrips, waitingStrips, stripFor, liveCount } from './strips.js';
import { ManagerStore, popHash, parsePopHash } from './manager-model.js';
import { ManagerUI } from './manager-ui.js';
import { mountManagerChat } from './manager-chat.js';
import board from './views/board.js';
import sessions from './views/sessions.js';
import tmux from './views/tmux.js';
import launch from './views/launch.js';
import features from './views/features.js';
import memory from './views/memory.js';
import events from './views/events.js';
import fleet from './views/fleet.js';
import terminals from './views/terminals.js';
import survey from './views/survey.js';
import stacks from './views/stacks.js';
import files from './views/files.js';
import settings from './views/settings.js';
import manager from './views/manager.js';
import search from './views/search.js';

// A plugin's views (core/plugins.js ui.views) join at boot (loadPluginViews), each after the view its `after` names.
const VIEWS = [board, sessions, tmux, launch, features, memory, files, manager, events, fleet, stacks, terminals, survey, search, settings];
const byId = new Map(VIEWS.map((v) => [v.id, v]));
const $ = (id) => document.getElementById(id);
const main = $('main'), tabsEl = $('tabs'), hostStrip = $('hoststrip'), hostSelect = $('hostSelect'), qInput = $('q'), liveEl = $('live'), liveText = $('liveText'), toastsEl = $('toasts'), stage = $('stage');

// Solo windows: #/pop/manager is the manager filling a window; #/pop/<kind>/<host>/<id>/<engine>/<name> is one
// drawer filling a popup; #/pip is the waiting board in a popup. Decided before anything renders.
const SOLO = /^#\/pop\/manager\b/.test(location.hash) ? 'manager' : /^#\/pop\//.test(location.hash) ? 'pop' : /^#\/pip\b/.test(location.hash) ? 'pip' : null;
if (SOLO) document.documentElement.classList.add('solo', `solo-${SOLO}`);

// ---------------------------------------------------------------- theme (auto | light | dark)
const THEME_KEY = 'drover.theme';
const THEMES = ['auto', 'light', 'dark'];
function applyTheme(t) {
  if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  const b = $('theme'); if (b) { b.textContent = t; b.title = `Color scheme: ${t} (click to change)`; }
  localStorage.setItem(THEME_KEY, t);
  const pip = window.documentPictureInPicture?.window; if (pip) { if (t === 'auto') delete pip.document.documentElement.dataset.theme; else pip.document.documentElement.dataset.theme = t; }
}
applyTheme(THEMES.includes(localStorage.getItem(THEME_KEY)) ? localStorage.getItem(THEME_KEY) : 'auto');
$('theme').addEventListener('click', () => { const cur = localStorage.getItem(THEME_KEY) || 'auto'; applyTheme(THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length]); });
window.addEventListener('storage', (e) => { if (e.key === THEME_KEY && e.newValue) applyTheme(e.newValue); });

// board: the daemon's compact board (native.board, `board` events); boardOp: whether this daemon has it (null: not asked yet).
const state = { snapshot: null, frontHost: null, hosts: [], probe: new Map(), fleet: null, board: null, boardOp: null, counts: {}, notifies: {}, finished: {} };
/** Latest finished alert per session (its excerpt shows on idle strips and in the waiting window's quieter list). */
function rememberFinished(list) { for (const a of list) if (a?.sessionId && (a.category === 'finished' || a.ask?.kind === 'finished') && !a.test) { const prev = state.finished[a.sessionId]; if (!prev || prev.ts < a.ts) state.finished[a.sessionId] = { ts: a.ts, body: a.body ?? a.message ?? '', ask: a.ask ?? null, name: a.name ?? a.sessionName ?? null, host: a.host ?? a.hostname ?? null, target: a.target ?? a.tmuxTarget ?? null }; } }
let current = null; let stream = null; let pendingStream = null; let streamTopics = null;

// ---------------------------------------------------------------- measurements (window.drover.perf)
// Render times and stream sizes, kept small: "everything is laggy" is checked here, not guessed at.
const perf = { renders: {}, stream: api.streamStats };
function perfMark(name, ms) { const r = perf.renders[name] ??= { n: 0, total: 0, max: 0, last: 0 }; r.n++; r.total += ms; r.max = Math.max(r.max, ms); r.last = ms; }

// ---------------------------------------------------------------- toasts
function toast(msg, kind = 'info', ms, { onClick } = {}) {
  const t = h('div', { class: `toast ${kind}${onClick ? ' clickable' : ''}`, role: kind === 'error' ? 'alert' : 'status' },
    h('span', { class: 'msg', onclick: onClick ? () => { t.remove(); onClick(); } : null }, msg),
    h('button', { class: 'btn sm quiet', type: 'button', 'aria-label': 'Dismiss', onclick: () => t.remove() }, '×'));
  toastsEl.append(t);
  setTimeout(() => t.remove(), ms ?? (kind === 'error' ? 10_000 : 3500));
  while (toastsEl.children.length > 4) toastsEl.firstChild.remove();
}

// ---------------------------------------------------------------- device helpers (wake lock, install, service worker)
const WAKE_KEY = 'drover.wake';
const wakeLock = {
  supported: 'wakeLock' in navigator, on: false, sentinel: null,
  async acquire() { if (!this.supported || document.visibilityState !== 'visible') return; try { this.sentinel = await navigator.wakeLock.request('screen'); this.sentinel.addEventListener('release', () => { this.sentinel = null; }); } catch (e) { console.warn('wake lock', e.message); } },
  async set(v) { this.on = Boolean(v); localStorage.setItem(WAKE_KEY, this.on ? '1' : '0'); if (this.on) await this.acquire(); else { await this.sentinel?.release().catch(() => {}); this.sentinel = null; } drawAlertsBtn(); },
};
document.addEventListener('visibilitychange', () => {
  if (wakeLock.on && !wakeLock.sentinel) wakeLock.acquire();
  // "What finished since I last looked?" asks from here: the last time this page went out of sight.
  if (document.visibilityState === 'hidden' && !SOLO) localStorage.setItem('drover.lastSeen', String(Date.now()));
});
window.addEventListener('pagehide', () => { if (!SOLO) localStorage.setItem('drover.lastSeen', String(Date.now())); });
let installEvent = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; });
window.addEventListener('appinstalled', () => { installEvent = null; toast('Drover installed as an app', 'ok'); });
const installState = () => (matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: window-controls-overlay)').matches ? 'installed' : installEvent ? 'available' : 'not offered by Chrome right now');
const sw = { reg: null, active: false, error: null };

// ---------------------------------------------------------------- context
const isManagerTarget = (t) => t && (t.id === 'manager' || t.sessionId === 'manager' || t.engine === 'openclaw');
const ctx = {
  state, toast, nav, solo: Boolean(SOLO),
  host: () => api.getHost(),
  isLocal: () => api.getHost() === 'local',
  hosts: () => state.hosts,
  hostUp: (name) => name === 'local' ? true : (state.probe.get(name)?.up ?? null),
  setHost(host, { remount = true } = {}) { if (host === api.getHost()) return; api.setHost(host); drawHosts(); if (remount) remountView(); },
  query: () => qInput.value,
  follow: api.follow,
  callQuiet: (op, args, opts) => api.call(op, args, opts),
  /** Answer a Grok bot's approval request: a main-token route on the daemon that keeps the bots (ui/api.js). */
  answerApproval: (id, n, opts = {}) => api.approvalsAnswer(id, n, { ...opts, via: 'web' }),
  /** Stale-while-revalidate: onData fires with the last payload immediately, then with the server's. */
  swr: (op, args, onData, opts) => api.swr(op, args, onData, opts).catch((e) => { if (e.status === 401) { api.setToken(''); showTokenGate('The server rejected the stored token.'); } else toast(`${op}: ${e.message}`, 'error'); throw e; }),
  swrPeek: api.swrPeek,
  cacheMeta: (op, host) => api.lastCache.get(`${op}|${host ?? api.getHost()}`) ?? null,
  async call(op, args, opts) {
    try { return await api.call(op, args, opts); }
    catch (e) {
      if (e.status === 401) { api.setToken(''); showTokenGate('The server rejected the stored token.'); }
      else toast(`${op}: ${e.message}`, 'error');
      throw e;
    }
  },
  /** Open the details drawer for a session or tmux window: {kind:'session'|'window', id, host, ...}. The manager opens as the manager. */
  open: (target) => (isManagerTarget(target) ? ctx.manager.show({ host: target.host }) : drawer.open(target)),
  closeDrawer: () => drawer.close(),
  drawerTarget: () => drawer.target,
  setCount(viewId, n) { state.counts[viewId] = n; const el = tabsEl.querySelector(`[data-view="${viewId}"] .count`); if (el) el.textContent = n == null ? '' : String(n); },
  showShortcuts: () => showShortcuts(),
  openPip: () => openPip(),
  /** Every strip the board shows (the daemon's compact board, else built from the fleet summary). */
  strips: () => currentStrips(state),
  stripFor: (t) => stripFor(state, t),
  perf: perfMark,
  wakeLock, installState, install: async () => { if (!installEvent) return; installEvent.prompt(); await installEvent.userChoice.catch(() => null); installEvent = null; },
  swState: () => ({ active: sw.active, error: sw.error }),
};
const drawer = new Drawer($('drawer'), stage, ctx);
const palette = new Palette(ctx, VIEWS);
const notifier = new Notifier(ctx);
ctx.notifier = notifier;
const managerStore = new ManagerStore({ call: (op, args, opts) => api.call(op, args, opts), storage: localStorage, frontHost: () => state.frontHost });
ctx.manager = new ManagerUI(ctx, managerStore);
// A handle for debugging from DevTools (no secrets here: the token stays in localStorage).
window.drover = { ctx, notifier, drawer, state, manager: managerStore, perf };
notifier.on((kind) => { if (kind === 'settings') { api.configurePeers(notifier.settings.peers); updateBadge(); drawAlertsBtn(); } });
api.configurePeers(notifier.settings.peers);

// ---------------------------------------------------------------- routing
function parseHash() {
  const raw = (location.hash || '#/board').replace(/^#\/?/, '');
  const segs = raw.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  const id = byId.has(segs[0]) ? segs[0] : 'board';
  return { id, params: segs.slice(1) };
}
function nav(id, ...params) {
  if (SOLO) { window.opener?.focus?.(); return; }
  const next = '#/' + [id, ...params.filter((p) => p !== undefined && p !== null && p !== '').map((p) => encodeURIComponent(String(p)))].join('/');
  if (location.hash === next) route(); else location.hash = next;
}
function drawTabs(activeId) {
  clear(tabsEl);
  VIEWS.forEach((v, i) => tabsEl.append(h('button', {
    class: 'tab', type: 'button', 'data-view': v.id, 'aria-current': v.id === activeId ? 'page' : null, title: `${v.label}${i < 9 ? ` (${i + 1})` : v.key === ',' ? ' (,)' : ''}`, onclick: () => nav(v.id),
  }, v.label, h('span', { class: 'count' }, state.counts[v.id] ?? ''), i < 9 ? h('kbd', null, String(i + 1)) : null)));
}
function destroyCurrent() { try { current?.ctrl?.destroy?.(); } catch (e) { console.error('view destroy failed', e); } current = null; }
function route() {
  if (SOLO) return;
  if (!api.getToken()) return showTokenGate();
  const { id, params } = parseHash();
  const view = byId.get(id);
  drawTabs(id);
  badge.setTitle(`${view.label} · Drover`);
  if (current && current.view === view && current.ctrl?.params) { current.ctrl.params(params); return; }
  destroyCurrent();
  clear(main); main.scrollTop = 0;
  try {
    const ctrl = view.mount(main, ctx, params) || {};
    current = { view, ctrl };
    if (qInput.value) ctrl.search?.(qInput.value);
  } catch (e) { console.error(e); main.append(h('div', { class: 'empty' }, h('b', null, 'This view failed to render'), e.message)); }
  if (stream) connectStream();   // a view can ask for more events (Tmux and Sessions follow the local snapshot)
}
function remountView() { destroyCurrent(); route(); }

// ---------------------------------------------------------------- hosts
function drawHosts() {
  clear(hostStrip);
  const cur = api.getHost();
  for (const hst of state.hosts) {
    const p = hst.name === 'local' ? { up: true } : state.probe.get(hst.name);
    const st = p ? (p.up ? 'up' : 'down') : '';
    const live = liveCount(state, hst.name);
    const direct = api.peerFor(hst.name);
    hostStrip.append(h('button', {
      class: 'host', type: 'button', 'aria-pressed': hst.name === cur ? 'true' : 'false',
      title: (hst.name === 'local' ? 'this machine' : p ? (p.up ? `${hst.name}: reachable, ${p.ms} ms` : `${hst.name}: ${p.error ?? 'unreachable'}`) : `${hst.name}: not probed yet`) + (direct ? ' (direct peer)' : '') + (live != null ? `; ${live} live agents` : ''),
      onclick: () => ctx.setHost(hst.name),
    }, dot(st), hst.name === 'local' ? hst.display : hst.name, direct ? h('span', { class: 'n' }, 'direct') : null, live != null ? h('span', { class: 'n' }, String(live)) : null));
  }
  // Compact select for narrow screens (CSS swaps which one is visible).
  clear(hostSelect);
  for (const hst of state.hosts) {
    const p = hst.name === 'local' ? { up: true } : state.probe.get(hst.name);
    hostSelect.append(h('option', { value: hst.name, selected: hst.name === cur ? true : null }, `${p ? (p.up ? '● ' : '○ ') : '· '}${hst.name === 'local' ? hst.display : hst.name}`));
  }
}
hostSelect.addEventListener('change', () => ctx.setHost(hostSelect.value));
$('palBtn').addEventListener('click', () => palette.open(''));

// ---------------------------------------------------------------- alerts button + quick menu
function drawAlertsBtn() {
  const b = $('bell'); if (!b) return;
  const on = notifier.settings.master !== false;
  const n = waitingStrips(state).length;
  clear(b);
  b.append(h('span', { class: `dot ${on ? (n ? 'wait' : 'idle') : ''}`, 'aria-hidden': 'true' }), h('span', { class: 'bell-label' }, on ? (n ? `${n} waiting` : 'alerts') : 'alerts off'), ...(n ? [h('span', { class: 'bell-n' }, String(n))] : []));
  b.title = `Alerts are ${on ? 'on' : 'off'}${n ? `; ${n} waiting on you` : ''}. Click for the quick menu.`;
  b.setAttribute('aria-pressed', on ? 'true' : 'false');
}
$('bell').addEventListener('click', (e) => {
  const on = notifier.settings.master !== false;
  const perm = notifier.permission();
  openMenu(e.currentTarget, [
    { label: 'Alerts', checked: on, hint: on ? 'on' : 'off', run: () => notifier.set({ master: !on }, { reason: 'quick menu' }) },
    perm === 'default' ? { label: 'Allow desktop notifications', run: () => notifier.requestPermission().then((p) => toast(p === 'granted' ? 'Desktop notifications allowed' : 'Desktop notifications not allowed', p === 'granted' ? 'ok' : 'error')) } : null,
    { label: 'Test an alert', hint: 'needs you', run: () => ctx.call('notify.test', { category: 'needs-you' }, { host: 'local' }) },
    { sep: true },
    { label: 'Waiting board window', hint: 'w', run: () => openPip() },
    { label: 'Manager', hint: 'm', run: () => ctx.manager.summon() },
    { label: 'Manager in a floating window', run: () => ctx.manager.popOut() },
    drawer.isOpen && !SOLO ? { label: 'Pop out this drawer', hint: 'p', run: () => drawer.popOut() } : null,
    wakeLock.supported ? { label: 'Keep screen awake', checked: wakeLock.on, run: () => wakeLock.set(!wakeLock.on) } : null,
    installEvent ? { label: 'Install Drover as an app', run: () => ctx.install() } : null,
    { sep: true },
    { label: 'Settings', hint: ',', run: () => nav('settings') },
    { label: 'Keyboard shortcuts', hint: '?', run: () => showShortcuts() },
  ], { label: 'Alerts and window' });
});
function updateBadge() {
  const n = waitingStrips(state).length;
  badge.setCount(notifier.settings.master === false ? 0 : n, notifier.settings.badge ?? {});
  drawAlertsBtn();
  window.dispatchEvent(new CustomEvent('drover:fleet'));
}

async function openPip() {
  try { await openWaitingWindow(ctx); } catch (e) { toast(`Waiting board: ${e.message}`, 'error'); }
}

async function loadHosts() {
  try { state.hosts = await api.call('host.list', {}, { host: 'local' }); }
  catch (e) {
    if (e.status === 401) { api.setToken(''); showTokenGate('The server rejected the stored token.'); return false; }
    state.hosts = [{ name: 'local', display: 'local', source: 'local' }]; toast(`host.list: ${e.message}`, 'error');
  }
  setHomes([state.hosts.find((x) => x.name === 'local')?.home]);
  if (!state.hosts.some((x) => x.name === api.getHost())) api.setHost('local');
  drawHosts();
  return true;
}
/** The daemon's compact board, once: it decides whether the stream carries `board` or the full `fleet`. */
async function loadBoard() {
  try {
    const t0 = performance.now();
    const r = await api.call('native.board', {}, { host: 'local' });
    perfMark('board.fetch', performance.now() - t0);
    setBoard(r); state.boardOp = true;
  } catch (e) { if (/unknown op/i.test(e.message)) state.boardOp = false; }
}
function frontName() { return state.frontHost ?? state.hosts.find((x) => x.name === 'local')?.display ?? null; }
function setBoard(raw) {
  const b = normalizeBoard(raw, frontName());
  if (!b) return;
  state.board = b;
  if (b.manager) managerStore.onBoard(b.manager);
  drawHosts(); updateBadge();
}
/** Probe the fleet in the background; only fleet-listed hosts, so dead ssh aliases do not stall. */
async function probeFleet() {
  const names = state.hosts.filter((x) => x.source === 'fleet').map((x) => x.name);
  if (!names.length) return;
  try {
    const r = await api.call('host.probe', { hosts: names }, { host: 'local' });
    for (const p of r) state.probe.set(p.host, p);
    drawHosts();
    current?.ctrl?.probe?.(r);
  } catch (e) { console.warn('probe failed', e.message); }
}
let probeTimer = null;

// ---------------------------------------------------------------- pairing
// A device with no token asked to pair (core/pair.js). Approve only when the device shows the same code;
// the device then collects its tokens. Names come from an unauthenticated request: h() keeps them text.
const pairEl = h('div', { class: 'pairing', 'aria-live': 'assertive' });
document.body.append(pairEl);
async function drawPairing() {
  let list;
  try { list = await api.pairPending(); } catch { return; }
  clear(pairEl);
  for (const r of list) {
    const code = `${r.code.slice(0, 3)} ${r.code.slice(3)}`;
    const decide = async (approve) => {
      try {
        const res = await api.pairDecide(r.code, approve);
        toast(`${approve ? 'Paired' : 'Denied'}: ${res.client}${res.device ? ` on ${res.device}` : ''}`, approve ? 'ok' : 'info');
      } catch (e) { toast(`Pairing: ${e.message}`, 'error'); }
      drawPairing();
    };
    pairEl.append(h('div', { class: 'pair-req', role: 'alert' },
      h('div', { class: 'pair-text' },
        h('strong', null, r.client), r.device ? ` on ${r.device}` : '', ' wants to pair',
        h('div', { class: 'pair-sub' }, `Approve only if the device shows this code. From ${r.from || 'an unknown address'}.`)),
      h('code', { class: 'pair-code' }, code),
      h('button', { class: 'btn sm', type: 'button', onclick: () => decide(true) }, 'Approve'),
      h('button', { class: 'btn sm quiet', type: 'button', onclick: () => decide(false) }, 'Deny')));
  }
}
setInterval(() => { if (pairEl.childElementCount) drawPairing(); }, 10_000);   // drop requests that expired

// ---------------------------------------------------------------- Grok bots asking to connect
// The bot gateway's authorize page shows a code (core/bots/oauth.js); approve only when it matches, naming the bot
// the connection belongs to (one connection per bot; the read-only shared kind is `drover bots approve --shared`).
// The client name comes from an unauthenticated registration: h() keeps it text.
const botAuthEl = h('div', { class: 'pairing', 'aria-live': 'assertive' });
document.body.append(botAuthEl);
async function drawBotAuth() {
  // Both lists before anything is cleared: two redraws at once (an event and the 10 s timer) then each draw it whole,
  // never one row twice. A daemon without routine setups (an older one) has none.
  let list, setups;
  try { [list, setups] = await Promise.all([api.botsPending(), api.routineSetups().catch(() => [])]); } catch { return; }
  // The banner redraws every 10 s and on every botauth event: keep what the owner is typing, and where.
  const typed = new Map([...botAuthEl.querySelectorAll('input[data-code]')].map((i) => [i.dataset.code, i.value]));
  const focused = document.activeElement?.closest?.('.pairing') === botAuthEl ? document.activeElement.dataset.code : null;
  clear(botAuthEl);
  for (const r of list) {
    const code = `${r.code.slice(0, 3)} ${r.code.slice(3)}`;
    // A request through a bot's own URL (/bots/<bot>/mcp) already names its bot: show it, nothing to type.
    const who = r.bot ? h('strong', { class: 'pair-bot' }, r.bot) : h('input', { type: 'text', placeholder: 'bot name', 'aria-label': 'which bot this connection belongs to', size: 12, maxlength: 32, autocomplete: 'off', spellcheck: 'false', dataset: { code: r.code } });
    if (!r.bot) who.value = typed.get(r.code) ?? '';
    const decide = async (approve) => {
      const bot = r.bot ?? who.value.trim().toLowerCase();
      if (approve && !bot) { toast('Name the bot this connection belongs to: each bot gets its own', 'error'); who.focus(); return; }
      try {
        const res = await api.botsDecide(r.code, approve, bot);
        toast(approve ? `Connected ${res.client} as ${res.bot}` : `Denied ${res.client}`, approve ? 'ok' : 'info');
      } catch (e) { toast(`Bot connection: ${e.message}`, 'error'); }
      drawBotAuth();
    };
    botAuthEl.append(h('div', { class: 'pair-req', role: 'alert' },
      h('div', { class: 'pair-text' },
        h('strong', null, r.client), r.bot ? ` wants to connect ${r.bot}` : ' wants to connect a Grok bot',
        h('div', { class: 'pair-sub' }, `${r.scopes.map((s) => s.replace('drover.', '')).join(', ')}. Approve only if its page shows this code.`)),
      h('code', { class: 'pair-code' }, code), who,
      h('button', { class: 'btn sm', type: 'button', onclick: () => decide(true) }, 'Approve'),
      h('button', { class: 'btn sm quiet', type: 'button', onclick: () => decide(false) }, 'Deny')));
    if (focused === r.code) who.focus();
  }
  // Routine setups sent from the gateway's page: where the webhook leads (host and id tail), never its URL or key.
  // Everything shown came from an unauthenticated form or request (from): h() keeps it text.
  for (const r of setups) {
    const code = `${r.code.slice(0, 3)} ${r.code.slice(3)}`;
    const decide = async (approve) => {
      try {
        const res = await api.routineSetupDecide(r.code, approve);
        if (!approve) toast(`Denied: ${res.bot}'s routine did not change`, 'info');
        else toast(res.test.ok ? `Set ${res.bot}'s routine and sent it a connection test` : `Set ${res.bot}'s routine, but the connection test failed: ${res.test.error}`, res.test.ok ? 'ok' : 'error');
      } catch (e) { toast(`Routine setup: ${e.message}`, 'error'); }
      drawBotAuth();
    };
    const where = `${r.webhook.host} ${r.webhook.webhook ?? ''}`.trim();
    botAuthEl.append(h('div', { class: 'pair-req', role: 'alert' },
      h('div', { class: 'pair-text' },
        'Set ', h('strong', null, r.bot), '\'s Drover routine to ', h('code', null, where),
        h('div', { class: 'pair-sub' }, `${r.replaces ? `Replaces ${r.replaces.host} ${r.replaces.webhook ?? ''}. ` : ''}Sent from ${r.from || 'an unknown address'}. Approve only if your setup page shows this code.`)),
      h('code', { class: 'pair-code' }, code),
      h('button', { class: 'btn sm', type: 'button', onclick: () => decide(true) }, 'Approve'),
      h('button', { class: 'btn sm quiet', type: 'button', onclick: () => decide(false) }, 'Deny')));
  }
}
setInterval(() => { if (botAuthEl.childElementCount) drawBotAuth(); }, 10_000);

// ---------------------------------------------------------------- SSE
// The stream carries only what this page uses (?topics=, older daemons ignore it and send everything): the compact
// `board` instead of the full `fleet` when the daemon has it, `snapshot` only for a view that asks (Tmux, Sessions).
const BASE_TOPICS = ['probe', 'turn', 'manager', 'mutation', 'notify', 'alerts', 'settings', 'pair', 'botauth'];
function topicsFor(view) {
  const t = new Set(BASE_TOPICS);
  if (state.boardOp !== false) t.add('board');
  if (state.boardOp !== true) t.add('fleet');
  for (const x of view?.topics ?? []) t.add(x);
  if (SOLO === 'pop') t.add('snapshot');
  return [...t].sort().join(',');
}
function setLive(s) {
  liveEl.firstElementChild.className = `dot ${s === 'open' ? 'up' : s === 'reconnecting' ? 'wait pulse' : 'down'}`;
  liveText.textContent = s === 'open' ? `live${state.frontHost ? ' on ' + state.frontHost : ''}` : s === 'reconnecting' ? 'reconnecting' : 'offline';
}
const seenAlerts = new Set();
function handle(type, data) {
  if (type === 'pair') drawPairing();
  if (type === 'botauth') drawBotAuth();
  if (type === 'snapshot') { state.snapshot = data; if (!state.board) updateBadge(); }
  if (type === 'fleet') { state.fleet = data; drawHosts(); if (!state.board) updateBadge(); }
  if (type === 'board') setBoard(data);
  if (type === 'probe' && Array.isArray(data)) { for (const p of data) state.probe.set(p.host, p); drawHosts(); }
  if (type === 'notify' && data?.sessionId) { state.notifies[data.sessionId] = data; updateBadge(); }
  if (type === 'alerts' && Array.isArray(data?.items)) {
    // Two streams overlap for a moment while topics change: an alert rings once.
    const fresh = data.items.filter((a) => !a?.id || !seenAlerts.has(a.id));
    for (const a of fresh) if (a?.id) seenAlerts.add(a.id);
    if (seenAlerts.size > 600) for (const id of [...seenAlerts].slice(0, 300)) seenAlerts.delete(id);
    // A manager reply while the manager is on screen is already in front of the owner: no toast, no sound for it.
    const ring = ctx.manager.isShown() ? fresh.filter((a) => !(a?.category === 'manager' && a.kind === 'reply')) : fresh;
    if (fresh.length) { rememberFinished(fresh); if (ring.length) notifier.receive(ring); updateBadge(); }
  }
  if (type === 'settings') notifier.onSettings(data);
  if (type === 'manager') managerStore.onStream(data);
  if (type === 'turn' && data?.id === 'manager') managerStore.onTurn(data);
  try { current?.ctrl?.sse?.(type, data); } catch (e) { console.error('view sse handler failed', e); }
  try { drawer.sse(type, data); } catch (e) { console.error('drawer sse failed', e); }
}
/** (Re)connect when the topics this page needs changed. The old stream reports until the new one says hello. */
function connectStream({ force = false } = {}) {
  const want = topicsFor(current?.view);
  if (!force && (pendingStream ? pendingStream.topics === want : stream && streamTopics === want)) return;
  pendingStream?.close();
  let hellos = 0;
  const s = api.openStream((type, data) => {
    if (s !== stream && s !== pendingStream) return;
    if (type === 'hello') {
      hellos++;
      state.frontHost = data?.host ?? state.frontHost;
      if (s === pendingStream) { stream?.close(); stream = s; streamTopics = want; pendingStream = null; }
      setLive('open'); drawPairing(); drawBotAuth();
      if (hellos > 1) { managerStore.resync(); drawer.resync?.(); }   // back after a drop: events may be missing
    }
    if (s !== stream) return;
    handle(type, data);
  }, (st) => { if (s === stream) setLive(st); }, { topics: want });
  s.topics = want;
  if (!stream) { stream = s; streamTopics = want; } else pendingStream = s;
}

// ---------------------------------------------------------------- token gate
function showTokenGate(msg) {
  destroyCurrent(); drawer.close();
  clear(main); drawTabs(null);
  const input = h('input', { type: 'password', autocomplete: 'off', placeholder: 'token', 'aria-label': 'API token' });
  main.append(h('form', { class: 'gate', onsubmit: async (e) => { e.preventDefault(); const t = input.value.trim(); if (!t) return; api.setToken(t); await boot(); } },
    h('h1', null, 'Drover'),
    h('p', null, msg || 'This browser has no API token yet.'),
    h('p', { class: 'muted small' }, 'Run "drover open" on the daemon host. It opens a URL ending in #token=… that stores the token here and then removes it from the address bar. Or paste the token from ~/.local/state/drover/token.'),
    h('div', { class: 'toolbar' }, input, h('button', { class: 'btn primary', type: 'submit' }, 'Use token'))));
  input.focus();
}

// ---------------------------------------------------------------- shortcuts
const SHORTCUTS = [
  ['General', [['/', 'search this view'], ['g', 'search every session on every machine'], ['⌘K', 'command palette (jump, msg, ask, capture, keys, launch, host, search)'], ['1 to 9', 'switch view'], [',', 'settings'], ['?', 'this sheet'], ['w', 'waiting board window (always on top)'], ['Esc', 'close the manager popup, the drawer, the palette or a menu']]],
  ['Manager', [['m', 'talk to the manager: the board\'s dock, or a popup anywhere else'], ['Enter / Shift+Enter', 'send / new line'], ['↑ / ↓', 'your earlier questions'], ['Esc', 'close the popup (the draft stays)']]],
  ['Board', [['j / k', 'next / previous agent'], ['Enter', 'open the drawer']]],
  ['Drawer', [['r', 'reply (focus the composer)'], ['p', 'pop the drawer out into its own window'], ['Option+Space (hold)', 'dictate while held; release to stop'], ['Enter / Shift+Enter', 'send / new line'], ['↑ / ↓', 'message history'], ['paste, drop', 'attach files (sent to the session as paths)']]],
  ['Files', [['⌘S', 'save'], ['Tab', 'indent']]],
];
let sheet = null;
function showShortcuts() {
  if (sheet) { sheet.remove(); sheet = null; return; }
  sheet = h('div', { class: 'palette-bg', onclick: (e) => { if (e.target === sheet) { sheet.remove(); sheet = null; } } },
    h('div', { class: 'palette sheet', role: 'dialog', 'aria-label': 'Keyboard shortcuts' },
      h('div', { class: 'sheet-head' }, h('h2', null, 'Keyboard shortcuts'), h('span', { class: 'spacer' }), h('button', { class: 'btn sm quiet', type: 'button', onclick: () => { sheet.remove(); sheet = null; } }, 'Close')),
      h('div', { class: 'sheet-body' }, ...SHORTCUTS.map(([g, rows]) => h('section', null, h('h3', null, g), h('dl', { class: 'kv' }, ...rows.flatMap(([k, d]) => [h('dt', null, h('kbd', null, k)), h('dd', null, d)])))))));
  document.body.append(sheet);
}

// ---------------------------------------------------------------- keyboard
let holdTalk = false;
document.addEventListener('keydown', (e) => {
  // Hold Option+Space to dictate into the open drawer's composer (works while typing in it).
  if (e.altKey && e.code === 'Space' && drawer.isOpen) { e.preventDefault(); if (!e.repeat && !holdTalk) { holdTalk = true; drawer.dictateStart({ hold: true }); } return; }
  const tag = e.target?.tagName;
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); palette.open(qInput.value); return; }
  if (e.key === 'Escape') {
    if (sheet) { sheet.remove(); sheet = null; return; }
    if (palette.isOpen) { palette.close(); return; }
    if (e.target === qInput) { qInput.value = ''; current?.ctrl?.search?.(''); qInput.blur(); return; }
    if (ctx.manager.isOpen) { ctx.manager.close(); return; }
    if (!typing && drawer.isOpen) { drawer.close(); return; }
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === '?') { e.preventDefault(); showShortcuts(); return; }
  if (e.key === '/') { e.preventDefault(); qInput.focus(); qInput.select(); return; }
  if (e.key === ',') { e.preventDefault(); nav('settings'); return; }
  if (e.key === 'w') { e.preventDefault(); openPip(); return; }
  if (e.key === 'm' && SOLO !== 'manager') { e.preventDefault(); ctx.manager.summon(); return; }
  if (e.key === 'g') { e.preventDefault(); nav('search'); return; }
  if (/^[1-9]$/.test(e.key)) { const v = VIEWS[Number(e.key) - 1]; if (v) { e.preventDefault(); nav(v.id); } return; }
  if (e.key === 'r' && drawer.isOpen) { e.preventDefault(); drawer.focusComposer(); return; }
  if (e.key === 'p' && drawer.isOpen && !SOLO) { e.preventDefault(); drawer.popOut(); return; }
  current?.ctrl?.key?.(e);
});
document.addEventListener('keyup', (e) => { if (holdTalk && (e.code === 'Space' || e.key === 'Alt')) { holdTalk = false; drawer.dictateStop(); } });
window.addEventListener('blur', () => { if (holdTalk) { holdTalk = false; drawer.dictateStop(); } });
qInput.addEventListener('input', () => current?.ctrl?.search?.(qInput.value));
qInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); palette.open(qInput.value); } });
$('cmd').addEventListener('click', (e) => { if (e.target !== qInput) qInput.focus(); });
window.addEventListener('hashchange', route);
window.addEventListener('error', (e) => console.error('uncaught', e.error ?? e.message));

// ---------------------------------------------------------------- service worker (notification actions, offline shell)
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) { sw.error = 'unsupported'; return; }
  try {
    sw.reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    const ready = await navigator.serviceWorker.ready;
    sw.reg = ready; sw.active = Boolean(ready.active);
    notifier.useServiceWorker(ready);
  } catch (e) { sw.error = e.message; console.warn('service worker', e.message); }
}
navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.type === 'drover-notification') notifier.handleAction(e.data.action, e.data.data ?? {}, e.data.reply ?? undefined);
});
/** #/act/<base64url json>: a notification action that opened this window. */
function takeActionFromHash() {
  const m = location.hash.match(/^#\/act\/([A-Za-z0-9_-]+)/);
  if (!m) return null;
  history.replaceState(null, '', location.pathname + location.search + '#/board');
  try { return JSON.parse(decodeURIComponent(escape(atob(m[1].replace(/-/g, '+').replace(/_/g, '/'))))); } catch { return null; }
}

// ---------------------------------------------------------------- boot
/**
 * The asks and finished alerts lanes.js needs to build strips from the fleet summary. The daemon's compact board
 * has them already (and the truth file's fold is megabytes), so with it only the `notify` events keep these.
 */
async function loadNotifies() {
  if (state.boardOp === true) return;
  try { const st = await api.call('events.state', {}, { host: 'local' }); state.notifies = { ...(st?.notifies ?? {}), ...state.notifies }; updateBadge(); } catch { /* the board retries */ }
  try { rememberFinished((await api.call('notify.list', { category: 'finished', limit: 120 }, { host: 'local' })).map((e) => ({ ...e, body: e.message }))); updateBadge(); } catch { /* older daemon */ }
}
async function bootSolo() {
  if (!(await loadHosts())) return;
  await loadBoard();   // a few KB, and it tells the stream to carry the compact board instead of the full fleet
  connectStream();
  notifier.refresh();
  if (SOLO === 'manager') {
    // #/pop/manager[/<host>[/<thread>]]: the manager alone in a window of its own (manager-model.js popHash).
    const { host, thread } = parsePopHash(location.hash) ?? {};
    if (host) managerStore.setHost(host);
    if (thread) { try { managerStore.setThread(thread); } catch { /* a bad name in the URL: main */ } }
    document.title = 'Manager · Drover';
    clear(main); main.classList.add('mgr-solo-root');
    mountManagerChat(main, ctx, { store: managerStore, variant: 'solo', autofocus: true });
    return;
  }
  if (SOLO === 'pop') {
    const [, , kind, host, id, eng, name] = location.hash.replace(/^#/, '').split('/').map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
    if (isManagerTarget({ id, engine: eng })) { location.replace(`/${popHash(host || 'local')}`); location.reload(); return; }
    document.title = `${name || id} · Drover`;
    drawer.open({ kind: kind === 'window' ? 'window' : 'session', host: host || 'local', id, engine: eng || undefined, name: name || undefined });
    return;
  }
  // #/pip fallback popup: the waiting board alone.
  document.title = 'Waiting on you · Drover';
  clear(main); main.classList.add('pip-root');
  const view = mountWaiting(main, ctx, { compact: true, onOpen: (s) => { const o = window.opener; if (o && !o.closed) { o.focus(); o.postMessage({ type: 'drover-open', target: { kind: s.kind, id: s.id, host: s.host, engine: s.engine, name: s.name, tmux: s.tmux, sessionId: s.sessionId } }, location.origin); } else drawer.open({ kind: s.kind, id: s.id, host: s.host, engine: s.engine, name: s.name }); } });
  window.addEventListener('drover:fleet', () => view.update());
  if (!state.board) api.swr('fleet.summary', {}, (r) => { state.fleet = r; view.update(); }, { host: 'local' }).catch(() => {});
  loadNotifies();
}
window.addEventListener('message', (e) => { if (e.origin === location.origin && e.data?.type === 'drover-open' && e.data.target) ctx.open(e.data.target); });

/** The front daemon's plugin views, added to the tabs in place (the palette and the router read the same list). */
async function loadPluginViews() {
  await api.loadServerInfo();
  for (const url of api.pluginViewUrls()) {
    try {
      const v = (await import(url)).default;
      if (!v?.id || typeof v.mount !== 'function' || byId.has(v.id)) continue;
      const after = v.after ? VIEWS.findIndex((x) => x.id === v.after) : -1;
      const at = after >= 0 ? after + 1 : VIEWS.findIndex((x) => x.id === 'settings');
      VIEWS.splice(at >= 0 ? at : VIEWS.length, 0, v);
      byId.set(v.id, v);
    } catch (e) { console.error('plugin view failed to load', url, e); }
  }
}

async function boot() {
  const act = takeActionFromHash();
  api.takeTokenFromHash();
  if (!api.getToken()) return showTokenGate();
  await loadPluginViews();
  if (wakeLock.supported && localStorage.getItem(WAKE_KEY) === '1') wakeLock.set(true);
  if (SOLO) return bootSolo();
  if (!(await loadHosts())) return;
  await loadBoard();
  route();
  connectStream();
  notifier.refresh().then(() => { api.configurePeers(notifier.settings.peers); drawHosts(); });
  loadNotifies();
  registerServiceWorker();
  probeFleet();
  clearInterval(probeTimer); probeTimer = setInterval(probeFleet, 120_000);
  drawAlertsBtn();
  if (act?.action) setTimeout(() => notifier.handleAction(act.action, act.data ?? {}, act.reply ?? undefined), 300);
}
export function setFleet(f) { state.fleet = f; drawHosts(); updateBadge(); }
ctx.setFleet = setFleet;
ctx.setBoard = setBoard;
boot();
