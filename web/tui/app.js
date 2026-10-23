// The TUI application: one daemon connection (ops and the SSE stream with topics), the board every view shares,
// the views (the manager first), a session view opened over them, overlays, key routing and drawing. A daemon
// that predates native.board, sessions.answer or async manager replies still works: the board comes from
// fleet.summary, answers go through tmux.answer and the manager answers in the call (capabilities are learned from
// the first "unknown op" and remembered).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { Screen } from './screen.js';
import { colorDepth } from './style.js';
import { fromNativeBoard, fromFleet, pressKey, replyPlan } from './board.js';
import { ManagerView, COMMANDS } from './views/manager.js';
import { BoardView } from './views/board.js';
import { SessionView } from './views/session.js';
import { TableView } from './views/table.js';
import { TABLES } from './views/tables.js';
import { Help, Palette, Prompt } from './views/overlays.js';
import { block } from './ui.js';
import { strWidth, truncate, oneLine } from './width.js';

export const TOPICS = ['board', 'alerts', 'turn', 'manager', 'mutation'];
// What an older daemon needs instead (it ignores topics and sends everything; these are the ones read).
const FALLBACK_TOPICS = ['fleet', 'alerts', 'turn', 'mutation', 'notify'];
// A plugin's tables (opts.tables, from core/plugins.js tuiTables) join this list in the constructor, after their `after`.
export const MAIN = ['manager', 'board', 'sessions', 'tmux', 'events', 'features', 'fleet', 'search', 'memory', 'stacks', 'launch', 'settings'];
export const ALIASES = { reflections: 'memory', mr: 'mrs', windows: 'tmux', profiles: 'launch', docker: 'stacks' };
const WORD_MOVES = new Set(['M-b', 'M-f']);
const digitOf = (i) => (i < 9 ? String(i + 1) : i === 9 ? '0' : null);

export class App {
  constructor({ client, term, opts = {}, env = process.env, stateDir }) {
    this.client = client; this.term = term; this.opts = opts; this.env = env; this.stateDir = stateDir;
    this.popup = env.DROVER_TUI_POPUP || null; this.popupSession = env.DROVER_TUI_SESSION || null;
    this.caps = { board: null, answer: null, managerAsync: null, topics: null };
    this.board = { strips: [], hosts: [], totals: {}, manager: null, source: null, loading: true, error: null };
    this.live = 'connecting'; this.liveWhy = ''; this.frontHost = null; this.host = 'local'; this.hosts = [];
    this.notifies = {}; this.finished = {}; this.lastFleet = null;
    this.toastMsg = null; this.modal = null; this.overlay = null; this.dirty = false; this.drawTimer = null; this.lastDraw = 0;
    this.histories = this.#readHistory();
    this.views = new Map();
    this.views.set('manager', new ManagerView(this, { thread: opts.thread ?? 'main', from: opts.from ?? null }));
    this.views.set('board', new BoardView(this));
    for (const def of TABLES) this.views.set(def.id, new TableView(this, def));
    for (const def of opts.tables ?? []) {
      if (!def?.id || this.views.has(def.id)) continue;
      this.views.set(def.id, new TableView(this, def));
      if (!MAIN.includes(def.id)) { const after = MAIN.indexOf(def.after); MAIN.splice(after >= 0 ? after + 1 : MAIN.indexOf('settings'), 0, def.id); }
    }
    const start = ALIASES[opts.view] ?? opts.view ?? 'manager';
    this.cur = Math.max(0, MAIN.indexOf(MAIN.includes(start) ? start : 'manager'));
  }

  // ------------------------------------------------------------ lifecycle
  start() {
    this.screen = new Screen((s) => this.term.write(s), { depth: colorDepth(this.env) });
    this.term.onKey = (ev) => this.key(ev);
    this.term.onResize = () => { this.screen.invalidate(); this.draw(); };
    this.term.onResume = () => { this.screen.invalidate(); this.draw(); };
    this.term.onError = (e) => this.toast(`error: ${e.message}`, 'err', 8000);
    this.draw();
    this.connect(TOPICS);
    this.loadBoard();
    this.loadHosts();
    this.front().show?.();
    // The session that hosts a popup manager: no status line, and the thread it holds, so a popup for another thread
    // never attaches to it (popup.js checks @drover-thread before reuse), however the session was started.
    if (this.popup && this.popupSession) {
      this.#tmux(['set-option', '-t', `=${this.popupSession}:`, 'status', 'off']).catch(() => {});
      this.#tmux(['set-option', '-t', `=${this.popupSession}:`, '@drover-thread', this.opts.thread ?? 'main']).catch(() => {});
    }
    this.boardTimer = setInterval(() => this.loadBoard(), 30_000);   // the stream carries changes; this is the safety net
    this.boardTimer.unref?.();
  }
  quit(code = 0) {
    for (const v of [...this.views.values(), this.overlay]) v?.hide?.();
    this.stream?.close(); clearInterval(this.boardTimer);
    this.term.stop();
    this.client.close();
    this.onQuit?.(code);
  }
  /** In a popup backed by a tmux session: detach it (the manager keeps its state for the next popup). Else quit. */
  hide() {
    if (!this.popup) return this.quit();
    const args = this.popupSession ? ['detach-client', '-s', `=${this.popupSession}`] : ['detach-client'];
    this.#tmux(args).catch((e) => this.toast(`could not hide: ${e.message}`, 'err'));
  }
  #tmux(args) { return new Promise((resolve, reject) => execFile('tmux', args, { timeout: 5000 }, (err, out) => (err ? reject(err) : resolve(String(out))))); }

  // ------------------------------------------------------------ daemon
  connect(topics) {
    this.stream?.close();
    this.topics = topics;
    this.stream = this.client.stream({
      topics,
      onEvent: (type, raw) => this.#onStream(type, raw),
      onState: (s, why) => {
        this.live = s; this.liveWhy = why ?? '';
        if (s === 'unauthorized') this.toast('the daemon rejected the token (~/.local/state/drover/token)', 'err', 0);
        this.invalidate();
      },
    });
  }
  #onStream(type, raw) {
    const want = type === 'hello' || TOPICS.includes(type) || (this.caps.board === false && (type === 'fleet' || type === 'notify'));
    if (!want) return;
    let d; try { d = JSON.parse(raw); } catch { d = raw; }
    switch (type) {
      case 'hello': {
        this.frontHost = d?.host ?? this.frontHost; this.live = 'open';
        this.caps.topics = Array.isArray(d?.topics);
        if (this.reconnected) this.loadBoard();
        this.reconnected = true;
        break;
      }
      case 'board': this.caps.board = true; this.setBoard(fromNativeBoard(d)); break;
      case 'fleet': this.lastFleet = d; this.setBoard(fromFleet(d, { notifies: this.notifies, finished: this.finished })); break;
      case 'notify': if (d?.sessionId) { this.notifies[d.sessionId] = d; if (this.lastFleet) this.setBoard(fromFleet(this.lastFleet, { notifies: this.notifies, finished: this.finished })); } break;
      case 'alerts': this.#alerts(d?.items ?? []); this.refreshBoardSoon(1200); break;
      case 'mutation': this.refreshBoardSoon(1500); break;
      default: break;
    }
    for (const v of this.views.values()) v.onEvent?.(type, d);
    this.overlay?.onEvent?.(type, d);
    this.invalidate();
  }
  #alerts(items) {
    const fresh = items.filter((a) => !a.test && !a.muted && (a.category === 'needs-you' || a.category === 'held' || a.category === 'error'));
    const a = fresh.at(-1);
    if (a) this.toast(`${a.category === 'error' ? 'error' : 'needs you'}: ${oneLine(a.title ?? a.name ?? '')}${a.body ? `: ${oneLine(a.body)}` : ''}`, a.category === 'error' ? 'err' : 'wait', 8000);
    for (const x of items) if (x?.sessionId && (x.category === 'finished' || x.ask?.kind === 'finished')) this.finished[x.sessionId] = { ts: x.ts, body: x.body ?? '', ask: x.ask ?? null };
  }
  setBoard(b) {
    this.board = { ...b, loading: false, error: null, at: Date.now() };
    // Views that read from where the board says things are (the manager's host) hear of every board, polled or streamed.
    for (const v of this.views.values()) v.onBoard?.();
    this.overlay?.onBoard?.();
    this.invalidate();
  }

  async loadBoard() {
    if (this.boardBusy) return; this.boardBusy = true;
    try {
      if (this.caps.board !== false) {
        try { const r = await this.client.call('native.board', {}); this.caps.board = true; this.setBoard(fromNativeBoard(r)); return; }
        catch (e) { if (!e.unknownOp) throw e; this.caps.board = false; this.connect(FALLBACK_TOPICS); }
      }
      const f = await this.client.call('fleet.summary', {}, { timeoutMs: 90_000 });
      this.lastFleet = f;
      this.setBoard(fromFleet(f, { notifies: this.notifies, finished: this.finished }));
      if (!this.notifiesAsked) { this.notifiesAsked = true; this.client.call('events.state', {}, { timeoutMs: 90_000 }).then((st) => { this.notifies = { ...(st?.notifies ?? {}), ...this.notifies }; if (this.lastFleet) this.setBoard(fromFleet(this.lastFleet, { notifies: this.notifies, finished: this.finished })); }, () => {}); }
    } catch (e) { this.board = { ...this.board, loading: false, error: e.message }; this.invalidate(); }
    finally { this.boardBusy = false; }
  }
  refreshBoardSoon(ms = 600, { toast = false } = {}) {
    clearTimeout(this.boardSoon);
    this.boardSoon = setTimeout(() => { this.loadBoard().then(() => toast && this.toast('board refreshed', 'ok', 1500)); }, ms);
  }
  async loadHosts() {
    try { const list = await this.client.call('host.list', {}); this.hosts = (Array.isArray(list) ? list : []).filter((x) => x.source !== 'ssh-config'); }
    catch { this.hosts = [{ name: 'local', display: 'local' }]; }
  }
  cycleHost(dir) {
    const names = ['local', ...this.hosts.map((x) => x.name).filter((n) => n !== 'local')];
    const i = Math.max(0, names.indexOf(this.host));
    this.host = names[(i + dir + names.length) % names.length];
    this.toast(`host ${this.hostLabel(this.host)}`, 'dim', 1500);
  }
  hostLabel(h) { return !h || h === 'local' ? `${this.frontHost ?? 'this machine'}` : h; }

  // ------------------------------------------------------------ actions views share
  /** Press a dialog key on a strip; refusals are normal answers and say why. */
  async answer(strip, key, after) {
    const label = key === 'Escape' ? 'Esc' : key;
    this.toast(`pressing ${label} on ${oneLine(strip.name)}…`, 'dim', 2000);
    try {
      const r = await pressKey(this.client, strip, key, this.caps);
      if (r?.refused) { this.toast(`refused: ${r.reason ?? 'the screen changed'}`, 'err', 8000); this.refreshBoardSoon(0); return r; }
      if (r?.ok === false) { this.toast(`not answered: ${r.error ?? r.reason ?? 'unknown'}`, 'err', 8000); return r; }
      this.toast(`pressed ${label} on ${oneLine(strip.name)}${r?.dialog?.question ? `: ${truncate(oneLine(r.dialog.question), 60)}` : ''}${r?.via === 'tmux.answer' ? ' (tmux.answer)' : ''}`, 'ok', 4000);
      this.refreshBoardSoon(500);
      after?.(r);
      return r;
    } catch (e) { this.toast(`answer: ${e.message}`, 'err', 8000); return null; }
  }
  replyTo(strip) {
    const plan = replyPlan(strip, '');
    if (!plan) { this.toast('nothing to reply to: this agent has no inbox and no pane', 'err'); return; }
    this.modal = new Prompt(this, {
      title: `Reply to ${oneLine(strip.name)}`, placeholder: strip.lane === 'wait' ? 'your answer' : 'a message',
      onSubmit: async (text) => {
        const p = replyPlan(strip, text);
        try {
          const r = await this.client.call(p.op, p.args, { timeoutMs: strip.engine === 'openclaw' ? 16 * 60_000 : 30_000 });
          if (r?.refused) this.toast('refused: a dialog is on screen; answer it with its keys first', 'err', 8000);
          else this.toast(r?.queuedBehindTurn ? `queued for ${oneLine(strip.name)} (busy)` : `sent to ${oneLine(strip.name)}`, 'ok');
          this.refreshBoardSoon(800);
        } catch (e) { this.toast(`reply: ${e.message}`, 'err', 8000); }
      },
    });
    this.invalidate();
  }
  openStrip(s) { this.openSession({ kind: s.kind === 'window' ? 'window' : 'session', id: s.kind === 'window' ? s.tmux ?? s.id : s.sessionId ?? s.id, host: s.host, name: s.name, engine: s.engine, tmux: s.tmux, sessionId: s.sessionId ?? (s.kind === 'session' ? s.id : undefined) }); }
  openSession(target) {
    // The manager has its own view: async sends, streaming, threads.
    if (target.id === 'manager' || target.engine === 'openclaw') { this.go('manager'); return; }
    this.overlay?.hide();
    this.overlay = new SessionView(this, target);
    this.overlay.show();
    this.invalidate();
  }
  closeOverlay() { this.overlay?.hide(); this.overlay = null; this.front().show?.({ back: true }); this.invalidate(); }
  front() { return this.overlay ?? this.views.get(MAIN[this.cur]); }
  go(id) {
    const i = MAIN.indexOf(ALIASES[id] ?? id); if (i < 0) return;
    if (this.overlay) { this.overlay.hide(); this.overlay = null; }
    if (i !== this.cur) { this.views.get(MAIN[this.cur]).hide?.(); this.cur = i; }
    this.front().show?.();
    this.invalidate();
  }
  /** The window /look captures: the popup's latest origin (set on each open), else --from. */
  async origin() {
    if (this.popupSession && this.env.TMUX) { try { const v = (await this.#tmux(['show-options', '-t', `=${this.popupSession}:`, '-qv', '@drover-from'])).trim(); if (v) return v; } catch { /* not set */ } }
    return this.opts.from ?? null;
  }
  async describeTarget(t) {
    if (this.env.TMUX) { try { const [s, i, n, p] = (await this.#tmux(['display-message', '-p', '-t', t, '#{session_name}\t#{window_index}\t#{window_name}\t#{pane_id}'])).trim().split('\t'); if (s) return `tmux window ${s}:${i} "${n}" (pane ${p}) on ${this.frontHost ?? 'this machine'}`; } catch { /* not on this server */ } }
    return `tmux pane ${t} on ${this.frontHost ?? 'this machine'}`;
  }

  // ------------------------------------------------------------ history (composer Up/Down), kept across runs
  #readHistory() { try { return JSON.parse(readFileSync(path.join(this.stateDir, 'tui-history.json'), 'utf8')); } catch { return {}; } }
  history(kind) { return Array.isArray(this.histories[kind]) ? [...this.histories[kind]] : []; }
  saveHistory(kind, list) {
    this.histories[kind] = list.slice(0, 200);
    clearTimeout(this.histTimer);
    this.histTimer = setTimeout(() => { try { mkdirSync(this.stateDir, { recursive: true, mode: 0o700 }); writeFileSync(path.join(this.stateDir, 'tui-history.json'), JSON.stringify(this.histories), { mode: 0o600 }); } catch { /* history is a convenience */ } }, 500);
  }

  // ------------------------------------------------------------ overlays and toasts
  toast(text, style = 'dim', ms = 4000) { this.toastMsg = { text: oneLine(text), style, until: ms ? Date.now() + ms : Infinity }; clearTimeout(this.toastTimer); if (ms) this.toastTimer = setTimeout(() => this.invalidate(), ms + 20); this.invalidate(); }
  closeModal() { this.modal = null; this.invalidate(); }
  help() { this.modal = new Help(this, this.#helpSections()); this.invalidate(); }
  palette() { this.modal = new Palette(this, this.#commands()); this.invalidate(); }
  #helpSections() {
    const out = [['Everywhere', [['1-9, 0', 'switch view (when not typing)'], ['Tab / Shift-Tab', 'next / previous view (in a session: its tabs)'], [': or Ctrl-P', 'command palette: any view, host, thread, action'], ['?  F1', 'this help'], ['Esc', 'back (close a session, leave a text box)'], ['q', this.popup ? 'hide the manager (it keeps running)' : 'quit'], ['Ctrl-C', `clear the text box, else ${this.popup ? 'hide' : 'quit'}`], ['Ctrl-L', 'redraw'], ['Ctrl-Z', 'suspend']]]];
    out.push(['Manager', [['Enter', 'send'], ['Ctrl-J, Alt-Enter', 'new line'], ['↑ ↓', 'history'], ['PgUp PgDn', 'scroll the conversation'], ['Esc then w', 'answer what waits (←→ choose, digits Enter Esc press)'], ...COMMANDS.map(([c, a, d]) => [`${c}${a ? ` ${a}` : ''}`, d])]]);
    out.push(['Board', [['j k', 'select a strip (answer keys work only on a strip you selected)'], ['1-9 Enter Esc', 'answer the selected waiting strip (sessions.answer, guarded by the screen hash)'], ['Enter / o', 'open the session'], ['r', 'reply with a message'], ['/', 'filter'], ['R', 'refresh']]]);
    out.push(['Session', [['Tab', 'Chat / Screen / Info'], ['j k Enter', 'select, expand a tool group (Enter again shows all output)'], ['a', 'jump to the answer card'], ['r or i', 'type a message'], ['t or Ctrl-T', 'send to the session inbox or paste into the pane'], ['K then a key', 'send one key to the pane'], ['F', 'force a paste a dialog refused'], ['Esc', 'back']]]);
    out.push(['Tables', [['j k PgUp PgDn', 'move'], ['/', 'filter (Search: the query)'], ['Enter', 'open or details'], ['[ ]', 'previous / next host (Sessions, Tmux)'], ['R', 'refresh']]]);
    return out;
  }
  #commands() {
    const items = MAIN.map((id, i) => ({ label: `Go to ${this.views.get(id).title}`, hint: digitOf(i) ?? '', run: () => this.go(id) }));
    const m = this.views.get('manager');
    items.push({ label: 'Manager: switch thread', hint: `now ${m.thread}`, run: () => { this.modal = new Prompt(this, { title: 'Thread', placeholder: 'main, or a name for an independent conversation', onSubmit: (t) => { this.go('manager'); m.command(`/thread ${t.trim()}`); } }); } });
    items.push({ label: 'Manager: threads', run: () => { this.go('manager'); m.threads(); } });
    items.push({ label: 'Manager: sweep now', run: () => { this.go('manager'); m.command('/sweep'); } });
    items.push({ label: 'Manager: status', run: () => { this.go('manager'); m.status(); } });
    items.push({ label: 'Manager: look at the window I came from', run: () => { this.go('manager'); m.lookAt(null); } });
    for (const s of this.board.strips.slice(0, 80)) items.push({ label: `Open ${oneLine(s.name)}`, hint: `${s.lane === 'wait' ? 'waiting' : s.lane === 'work' ? 'working' : 'idle'} · ${s.host === 'local' ? this.frontHost ?? 'local' : s.host}`, run: () => this.openStrip(s) });
    for (const x of ['local', ...this.hosts.map((y) => y.name).filter((n) => n !== 'local')]) items.push({ label: `Host ${this.hostLabel(x)}`, hint: 'for Sessions and Tmux', run: () => { this.host = x; const v = this.front(); if (v.def?.perHost) v.show(); this.toast(`host ${this.hostLabel(x)}`, 'dim', 1500); } });
    items.push({ label: 'Refresh the board', run: () => this.refreshBoardSoon(0, { toast: true }) });
    items.push({ label: 'Redraw the screen', run: () => { this.screen.invalidate(); this.invalidate(); } });
    if (this.popup) items.push({ label: 'Hide the manager', hint: 'q', run: () => this.hide() });
    items.push({ label: 'Quit', hint: this.popup ? 'ends this manager window' : 'q', run: () => this.quit() });
    return items;
  }

  // ------------------------------------------------------------ keys
  key(ev) {
    const v = this.front();
    // An Alt-key is usually ESC and a key that arrived in one read (typed fast, or joined by tmux or ssh): only a
    // text box's word moves (Alt-B, Alt-F) are taken as Alt.
    if (ev.alt && ev.ch && !ev.ctrl && !(WORD_MOVES.has(ev.id) && (this.modal || v.inputActive))) {
      this.key({ name: 'escape', id: 'escape', ctrl: false, alt: false, shift: false });
      this.key({ ...ev, alt: false, id: ev.ch, name: ev.ch });
      return;
    }
    if (this.modal) { this.modal.key(ev); this.invalidate(); return; }
    if (ev.id === 'C-c') { if (v.clearInput?.()) { this.invalidate(); return; } return this.popup ? this.hide() : this.quit(); }
    if (ev.id === 'C-l') { this.screen.invalidate(); this.invalidate(); return; }
    if (ev.id === 'C-z' && !this.popup) { this.term.suspend(); return; }
    if (ev.id === 'C-p') { this.palette(); return; }
    if (ev.id === 'f1') { this.help(); return; }
    if (v.key(ev)) { this.invalidate(); return; }
    if (ev.id === 'tab' || ev.id === 'S-tab') { this.go(MAIN[(this.cur + (ev.id === 'tab' ? 1 : MAIN.length - 1)) % MAIN.length]); return; }
    if (ev.id === 'escape' || (ev.id === 'backspace' && !v.inputActive)) { if (this.overlay) this.closeOverlay(); return; }
    if (v.inputActive) return;
    if (/^[0-9]$/.test(ev.id)) { const i = ev.id === '0' ? 9 : Number(ev.id) - 1; if (MAIN[i]) this.go(MAIN[i]); return; }
    if (ev.id === ':') { this.palette(); return; }
    if (ev.id === '?') { this.help(); return; }
    if (ev.id === 'q') { this.popup ? this.hide() : this.quit(); }
  }

  // ------------------------------------------------------------ drawing
  /** Ask for a frame; frames are coalesced (a streaming reply asks many times a second). */
  invalidate() {
    if (this.drawTimer) return;
    const wait = Math.max(0, 16 - (Date.now() - this.lastDraw));
    this.drawTimer = setTimeout(() => { this.drawTimer = null; this.draw(); }, wait);
  }
  draw() {
    if (!this.term.active) return;
    this.lastDraw = Date.now();
    const { cols, rows } = this.term.size();
    if (cols < 40 || rows < 10) { this.screen.draw([[[' make the window bigger (40x10 at least)', 'bold']]], { rows, cols }); return; }
    const v = this.front();
    const frame = [this.#tabBar(cols)];
    let body;
    try { body = v.render(cols, rows - 2); } catch (e) { body = [[[` this view failed to draw: ${e.message}`, 'err']]]; }
    frame.push(...block(body, rows - 2));
    frame.push(this.#footer(cols, v));
    let cursor = null;
    if (this.modal) { this.modal.overlay(frame, cols, rows); cursor = this.modal.cursor(); }
    else { const c = v.cursor?.(); if (c) cursor = { row: c.row + 1, col: Math.min(cols - 1, c.col) }; }
    this.screen.draw(frame, { rows, cols, cursor });
  }
  #tabBar(cols) {
    const tabs = MAIN.map((id, i) => ({ id, text: ` ${digitOf(i) ? `${digitOf(i)} ` : ''}${this.views.get(id).title} ` }));
    if (this.overlay) tabs.push({ id: 'session', text: ` ▸ ${truncate(this.overlay.title, 28)} ` });
    const active = this.overlay ? tabs.length - 1 : this.cur;
    const w = this.board.totals?.waiting ?? 0;
    const live = this.live === 'open' ? ['live', 'barOk'] : this.live === 'reconnecting' ? ['reconnecting', 'barWait'] : this.live === 'unauthorized' ? ['token rejected', 'barErr'] : [this.live, 'barDim'];
    // Any daemon but the usual local one is named, so a TUI pointed elsewhere (--url, DROVER_STATE) says so.
    const where = this.client.base?.host && this.client.base.host !== '127.0.0.1:7337' ? ` ${this.client.base.host} ` : '';
    const right = [[` ${live[0]} `, live[1]], [where, 'barWait'], [w ? ` ${w} waiting ` : ' 0 waiting ', w ? 'barWait' : 'barDim'], [this.popup ? ` ${this.popup} manager ` : '', 'barDim']];
    const head = [[' drover ', 'tabOn']];
    const room = cols - strWidth(' drover ') - right.reduce((s, [t]) => s + strWidth(t), 0) - 2;
    // Show as many tabs as fit, the active one always, widening around it.
    let lo = active, hi = active, used = strWidth(tabs[active].text);
    for (let grew = true; grew;) {
      grew = false;
      if (hi + 1 < tabs.length && used + strWidth(tabs[hi + 1].text) <= room) { hi++; used += strWidth(tabs[hi].text); grew = true; }
      if (lo > 0 && used + strWidth(tabs[lo - 1].text) <= room) { lo--; used += strWidth(tabs[lo].text); grew = true; }
    }
    const segs = [...head, [lo > 0 ? '‹' : ' ', 'barDim']];
    for (let i = lo; i <= hi; i++) segs.push([tabs[i].text, i === active ? 'tabOn' : 'tab']);
    segs.push([hi < tabs.length - 1 ? '›' : ' ', 'barDim']);
    const pad = Math.max(0, cols - segs.reduce((s, [t]) => s + strWidth(t), 0) - right.reduce((s, [t]) => s + strWidth(t), 0));
    return { segs: [...segs, [' '.repeat(pad), 'bar'], ...right], bg: 'bar' };
  }
  #footer(cols, v) {
    const left = (this.modal ? this.modal.hints() : v.hints?.()) ?? [];
    const t = this.toastMsg && this.toastMsg.until > Date.now() ? this.toastMsg : null;
    if (!t) return { segs: [[' ', 'bar'], ...left], bg: 'bar' };
    const st = { ok: 'barOk', err: 'barErr', wait: 'barWait' }[t.style] ?? 'bar';
    const tw = Math.min(strWidth(t.text) + 2, Math.max(20, Math.floor(cols * 0.6)));
    const lw = Math.max(0, cols - tw - 1);
    const leftSegs = []; let used = 1;
    for (const [s, style] of left) { if (used >= lw) break; const x = truncate(s, lw - used); leftSegs.push([x, style]); used += strWidth(x); }
    return { segs: [[' ', 'bar'], ...leftSegs, [' '.repeat(Math.max(0, lw - used)), 'bar'], [` ${truncate(t.text, tw - 2)} `, st]], bg: 'bar' };
  }
}

