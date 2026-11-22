// The TUI application: one daemon connection (ops and the SSE stream with topics), the board every view shares,
// the views (the manager first), a session view opened over them, overlays, key routing and drawing. A daemon
// that predates native.board, sessions.answer or async manager replies still works: the board comes from
// fleet.summary, answers go through tmux.answer and the manager answers in the call (capabilities are learned from
// the first "unknown op" and remembered).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { Screen } from './screen.js';
import { colorDepth, hoverOf } from './style.js';
import { fromNativeBoard, fromFleet, pressKey, replyPlan, stripKey } from './board.js';
import { ManagerView, COMMANDS } from './views/manager.js';
import { BoardView } from './views/board.js';
import { SessionView } from './views/session.js';
import { TableView } from './views/table.js';
import { TABLES } from './views/tables.js';
import { WallView } from './views/wall.js';
import { SpaceView } from './views/space.js';
import { PromptsView } from './views/prompts.js';
import { Help, Palette, Prompt } from './views/overlays.js';
import { block, setHomes, hintKey, hitAt } from './ui.js';
import { strWidth, truncate, oneLine } from './width.js';
import { osc52 } from './term.js';
import { WORKSPACES, ALIASES, cloneWorkspaces, resolveView, placePlugin, namesOf } from './workspaces.js';

export { WORKSPACES, ALIASES, resolveView };

export const TOPICS = ['board', 'alerts', 'turn', 'manager', 'mutation'];
// What an older daemon needs instead (it ignores topics and sends everything; these are the ones read).
const FALLBACK_TOPICS = ['fleet', 'alerts', 'turn', 'mutation', 'notify'];
const WORD_MOVES = new Set(['M-b', 'M-f']);
const digitOf = (i) => (i < 9 ? String(i + 1) : null);
const SUB_KEYS = { '<': -1, '>': 1, 'S-left': -1, 'S-right': 1 };

export class App {
  constructor({ client, term, opts = {}, env = process.env, stateDir }) {
    this.client = client; this.term = term; this.opts = opts; this.env = env; this.stateDir = stateDir;
    this.popup = env.DROVER_TUI_POPUP || null; this.popupSession = env.DROVER_TUI_SESSION || null;
    this.caps = { board: null, answer: null, managerAsync: null, topics: null };
    this.board = { strips: [], hosts: [], totals: {}, manager: null, source: null, loading: true, error: null };
    this.live = 'connecting'; this.liveWhy = ''; this.frontHost = null; this.host = 'local'; this.hosts = [];
    this.notifies = {}; this.finished = {}; this.lastFleet = null;
    this.toastMsg = null; this.modal = null; this.overlay = null; this.dirty = false; this.drawTimer = null; this.lastDraw = 0;
    // What the last frame drew on the tab bar, the sub-tab row and the footer that a click can press: [{ x0, x1, run, g }].
    this.tabHits = []; this.subHits = []; this.footHits = [];
    // The agent selected in Lanes, List, Windows, Wall and Space, by strip key (board.js stripKey); where the mouse is.
    this.agentSel = null; this.hover = null; this.barHover = null; this.animations = new Map();
    this.histories = this.#readHistory();
    this.workspaces = cloneWorkspaces(WORKSPACES);
    this.views = new Map();
    this.views.set('manager', new ManagerView(this, { thread: opts.thread ?? 'main', from: opts.from ?? null }));
    this.views.set('board', new BoardView(this));
    for (const def of TABLES) this.views.set(def.id, new TableView(this, def));
    this.views.set('wall', new WallView(this));
    this.views.set('space', new SpaceView(this));
    this.views.set('prompts', new PromptsView(this));
    // A plugin's tables (opts.tables, from core/plugins.js tuiTables) join a workspace (workspaces.js placePlugin).
    for (const def of opts.tables ?? []) {
      if (!def?.id || this.views.has(def.id)) continue;
      if (placePlugin(this.workspaces, def)) this.views.set(def.id, new TableView(this, def));
    }
    // The sub-view each workspace showed last, kept with the composer history.
    const kept = this.histories.subs && typeof this.histories.subs === 'object' ? this.histories.subs : {};
    this.subSel = Object.fromEntries(this.workspaces.map((w) => [w.id, w.subs.some((x) => x.id === kept[w.id]) ? kept[w.id] : w.subs[0].id]));
    const start = resolveView(opts.view ?? 'manager', this.workspaces) ?? resolveView('manager', this.workspaces);
    this.ws = this.workspaces.indexOf(start.ws);
    if (start.sub) this.subSel[start.ws.id] = start.sub.id;
    this.#applyMode();
  }

  // ------------------------------------------------------------ workspaces
  workspace() { return this.workspaces[this.ws]; }
  /** The sub-view in front of the current workspace: { id, title, view, mode? }. */
  sub() { const w = this.workspace(); return w.subs.find((x) => x.id === this.subSel[w.id]) ?? w.subs[0]; }
  /** Where the front view is: "agents/wall". */
  where() { return `${this.workspace().id}/${this.sub().id}`; }
  #applyMode() { const s = this.sub(); if (s.mode) this.views.get(s.view)?.setMode?.(s.mode); }

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
    for (const t of this.animations.values()) clearInterval(t.timer);
    if (this.histTimer) this.#flushHistory();   // a sub-view picked or a line sent just before q is kept
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
    try { const list = await this.client.call('host.list', {}); this.hosts = (Array.isArray(list) ? list : []).filter((x) => x.source !== 'ssh-config'); setHomes([this.hosts.find((x) => x.name === 'local')?.home]); }
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
  openStrip(s) { this.selectAgent(stripKey(s)); this.openSession({ kind: s.kind === 'window' ? 'window' : 'session', id: s.kind === 'window' ? s.tmux ?? s.id : s.sessionId ?? s.id, host: s.host, name: s.name, engine: s.engine, tmux: s.tmux, sessionId: s.sessionId ?? (s.kind === 'session' ? s.id : undefined) }); }
  openSession(target) {
    // The manager has its own view: async sends, streaming, threads.
    if (target.id === 'manager' || target.engine === 'openclaw') { this.go('manager'); return; }
    this.overlay?.hide();
    this.overlay = new SessionView(this, target);
    this.overlay.show();
    this.invalidate();
  }
  closeOverlay() { this.overlay?.hide(); this.overlay = null; this.front().show?.({ back: true }); this.invalidate(); }
  front() { return this.overlay ?? this.views.get(this.sub().view); }
  /**
   * Show a workspace or a sub-view by any name it has (workspaces.js resolveView: 'agents/wall', 'agents', an old id
   * such as 'tmux' or 'docker', a plugin's id). A workspace alone shows the sub-view it showed last. false: no such view.
   */
  go(id) {
    const r = resolveView(id, this.workspaces); if (!r) return false;
    const before = this.overlay ? null : this.views.get(this.sub().view);
    if (this.overlay) { this.overlay.hide(); this.overlay = null; }
    this.ws = this.workspaces.indexOf(r.ws);
    if (r.sub) this.subSel[r.ws.id] = r.sub.id;
    const after = this.views.get(this.sub().view);
    if (before && before !== after) before.hide?.();
    this.#applyMode();
    after.show?.();
    this.#saveSubs();
    this.invalidate();
    return true;
  }
  /** The workspace n places on (Tab, Shift-Tab). */
  cycleWorkspace(n) { this.go(this.workspaces[(this.ws + n + this.workspaces.length * 4) % this.workspaces.length].id); }
  /** The sub-view n places on inside the workspace (< >, Shift-Left/Right). */
  cycleSub(n) { const w = this.workspace(); const i = w.subs.indexOf(this.sub()); this.go(`${w.id}/${w.subs[(i + n + w.subs.length * 4) % w.subs.length].id}`); }

  /**
   * Select an agent (a strip key, or null) in every view that shows agents. Selecting never arms an answer key: the
   * board arms only a strip selected there (views/board.js).
   */
  selectAgent(key) {
    const k = key ?? null; if (k === this.agentSel) return;
    this.agentSel = k;
    for (const v of this.views.values()) v.onSelect?.(k);
    this.invalidate();
  }
  /** The selected agent's strip as the board has it now (null when none, or when it left the board). */
  selectedStrip() { return this.agentSel ? this.board.strips.find((s) => stripKey(s) === this.agentSel) ?? null : null; }

  /** Put text on the clipboard of the terminal the TUI runs in (OSC 52; wrapped for tmux's passthrough under tmux). */
  copy(text, what = 'text') {
    const { seq, truncated } = osc52(text, { tmux: Boolean(this.env.TMUX) });
    this.term.write(seq);
    this.toast(`copied ${what}${truncated ? ' (cut: the terminal takes about 75 KB)' : ''} to the clipboard`, 'ok', 2500);
  }

  /**
   * Frames for a view that moves (the Wall's pulse, the Space's camera): fps redraws a second while the view is in
   * front, calling view.onFrame?.(now) first; 0 stops. The timer skips frames while another view is in front.
   */
  animate(view, fps) {
    const was = this.animations.get(view);
    if (was?.fps === fps) return;
    if (was) { clearInterval(was.timer); this.animations.delete(view); }
    if (!fps) return;
    const timer = setInterval(() => { if (this.front() !== view || !this.term.active) return; view.onFrame?.(Date.now()); this.invalidate(); }, Math.max(16, Math.round(1000 / fps)));
    timer.unref?.();
    this.animations.set(view, { fps, timer });
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
  saveHistory(kind, list) { this.histories[kind] = list.slice(0, 200); this.#writeHistory(); }
  #saveSubs() { const was = JSON.stringify(this.histories.subs ?? null); this.histories.subs = { ...this.subSel }; if (JSON.stringify(this.histories.subs) !== was) this.#writeHistory(); }
  #writeHistory() {
    clearTimeout(this.histTimer);
    this.histTimer = setTimeout(() => this.#flushHistory(), 500);
  }
  #flushHistory() { clearTimeout(this.histTimer); this.histTimer = null; try { mkdirSync(this.stateDir, { recursive: true, mode: 0o700 }); writeFileSync(path.join(this.stateDir, 'tui-history.json'), JSON.stringify(this.histories), { mode: 0o600 }); } catch { /* history is a convenience */ } }

  // ------------------------------------------------------------ overlays and toasts
  toast(text, style = 'dim', ms = 4000) { this.toastMsg = { text: oneLine(text), style, until: ms ? Date.now() + ms : Infinity }; clearTimeout(this.toastTimer); if (ms) this.toastTimer = setTimeout(() => this.invalidate(), ms + 20); this.invalidate(); }
  closeModal() { this.modal = null; this.invalidate(); }
  help() { this.modal = new Help(this, this.#helpSections()); this.invalidate(); }
  palette() { this.modal = new Palette(this, this.#commands()); this.invalidate(); }
  #helpSections() {
    const ws = (id) => { const i = this.workspaces.findIndex((w) => w.id === id); const w = this.workspaces[i]; return `${i + 1} ${w.title}${w.subs.length > 1 ? ` (${w.subs.map((x) => x.title).join(' · ')})` : ''}`; };
    const out = [['Everywhere', [['1-7', 'a workspace (when not typing): it shows the sub-view it showed last'], ['< >  S-← S-→', 'previous / next sub-view of the workspace'], ['Tab / Shift-Tab', 'next / previous workspace (in a session: its tabs)'], [': or Ctrl-P', 'command palette: any workspace, sub-view (old names too), host, thread, action'], ['?  F1', 'this help'], ['Esc', 'back (close a session, leave a text box)'], ['q', this.popup ? 'hide the manager (it keeps running)' : 'quit'], ['Ctrl-C', `clear the text box, else ${this.popup ? 'hide' : 'quit'}`], ['Ctrl-L', 'redraw'], ['Ctrl-Z', 'suspend']]]];
    out.push(['Mouse', [['click', 'a workspace, a sub-view, a row, a strip, a tile, a session tab, a key hint'], ['click again', 'open it (Enter); on a dialog option or key: press it'], ['hover', 'highlights what is under the pointer and previews it in the bottom bar (it never selects)'], ['wheel', 'scroll (it never selects a strip)'], ['Shift-drag', 'select text in most terminals'], ['palette', `Mouse: ${this.term.mouse === false ? 'on' : 'off'}`]]]);
    out.push([ws('manager'), [['Enter', 'send'], ['Ctrl-J, Alt-Enter', 'new line'], ['↑ ↓', 'history'], ['PgUp PgDn', 'scroll the conversation'], ['Esc then w', 'answer what waits (←→ choose, digits Enter Esc press)'], ...COMMANDS.map(([c, a, d]) => [`${c}${a ? ` ${a}` : ''}`, d])]]);
    out.push([ws('agents'), [['', 'one agent selected across Lanes, List, Windows, Wall and Space'], ['Lanes j k', 'select a strip (answer keys work only on a strip you selected in Lanes)'], ['Lanes 1-9 Enter Esc', 'answer the selected waiting strip (sessions.answer, guarded by the screen hash)'], ['Enter / o', 'open the session'], ['r', 'reply with a message'], ['/', 'filter'], ['R', 'refresh'], ['List, Windows [ ]', 'previous / next host (a: live or all, agents only)'], ['Wall ←↓↑→ hjkl', 'move between tiles; + - density; z or a second click zooms, Esc unzooms'], ['Space', 'the fleet in 3D']]]);
    out.push([ws('prompts'), [['/', 'search the words (the daemon matches them)'], ['Enter', 'open the session the prompt was typed in'], ['y', 'copy the prompt (OSC 52)'], ['l', 'launch a new agent with it'], ['v', 'Mine / All'], ['[ ]', 'one host / every host'], ['j past the end', 'older prompts']]]);
    out.push([ws('work'), [['Pulls s t', 'scope, state'], ['Enter / o', 'open in the browser']]]);
    out.push([ws('fleet'), [['Hosts p', 'probe the host'], ['Stacks Enter', 'details'], ['Launch', 'profiles, models and credentials (read-only)']]]);
    out.push([ws('find'), [['Search /', 'type the query, Enter searches every machine'], ['Memory a s', 'all repos, status'], ['Events', 'the truth file, newest first']]]);
    out.push([ws('settings'), [['Enter', 'edit a setting (settings.set)'], ['Space', 'flip a yes/no'], ['u', 'remove an active mute']]]);
    out.push(['Session', [['Tab', 'Chat / Screen / Info'], ['j k Enter', 'select, expand a tool group (Enter again shows all output)'], ['a', 'jump to the answer card'], ['r or i', 'type a message'], ['t or Ctrl-T', 'send to the session inbox or paste into the pane'], ['K then a key', 'send one key to the pane'], ['F', 'force a paste a dialog refused'], ['Esc', 'back']]]);
    out.push(['Tables', [['j k PgUp PgDn', 'move'], ['/', 'filter (Search: the query)'], ['Enter', 'open or details'], ['R', 'refresh']]]);
    return out;
  }
  #commands() {
    const items = [];
    this.workspaces.forEach((w, i) => {
      items.push({ label: `Go to ${w.title}`, hint: `${digitOf(i) ?? ''}  ${w.ask}`, run: () => this.go(w.id) });
      if (w.subs.length > 1) for (const x of w.subs) items.push({ label: `${w.title} › ${x.title}`, hint: namesOf(w, x).join(', '), run: () => this.go(`${w.id}/${x.id}`) });
    });
    const m = this.views.get('manager');
    items.push({ label: 'Manager: switch thread', hint: `now ${m.thread}`, run: () => { this.modal = new Prompt(this, { title: 'Thread', placeholder: 'main, or a name for an independent conversation', onSubmit: (t) => { this.go('manager'); m.command(`/thread ${t.trim()}`); } }); } });
    items.push({ label: 'Manager: threads', run: () => { this.go('manager'); m.threads(); } });
    items.push({ label: 'Manager: sweep now', run: () => { this.go('manager'); m.command('/sweep'); } });
    items.push({ label: 'Manager: status', run: () => { this.go('manager'); m.status(); } });
    items.push({ label: 'Manager: look at the window I came from', run: () => { this.go('manager'); m.lookAt(null); } });
    for (const s of this.board.strips.slice(0, 80)) items.push({ label: `Open ${oneLine(s.name)}`, hint: `${s.lane === 'wait' ? 'waiting' : s.lane === 'work' ? 'working' : 'idle'} · ${s.host === 'local' ? this.frontHost ?? 'local' : s.host}`, run: () => this.openStrip(s) });
    for (const x of ['local', ...this.hosts.map((y) => y.name).filter((n) => n !== 'local')]) items.push({ label: `Host ${this.hostLabel(x)}`, hint: 'for Agents › List and Windows', run: () => { this.host = x; const v = this.front(); if (v.def?.perHost) v.show({ hostChange: true }); this.toast(`host ${this.hostLabel(x)}`, 'dim', 1500); } });
    items.push({ label: 'Refresh the board', run: () => this.refreshBoardSoon(0, { toast: true }) });
    items.push({ label: 'Redraw the screen', run: () => { this.screen.invalidate(); this.invalidate(); } });
    items.push({ label: this.term.mouse === false ? 'Mouse: on (click, hover and scroll in the TUI)' : 'Mouse: off (leave it to the terminal: select text, its own scrolling)', run: () => { this.term.setMouse?.(this.term.mouse === false); this.toast(`mouse ${this.term.mouse === false ? 'off' : 'on'}`, 'dim', 1500); } });
    if (this.popup) items.push({ label: 'Hide the manager', hint: 'q', run: () => this.hide() });
    items.push({ label: 'Quit', hint: this.popup ? 'ends this manager window' : 'q', run: () => this.quit() });
    return items;
  }

  // ------------------------------------------------------------ keys
  key(ev) {
    if (ev.name === 'mouse') { this.mouse(ev); return; }
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
    if (ev.id === 'tab' || ev.id === 'S-tab') { this.cycleWorkspace(ev.id === 'tab' ? 1 : -1); return; }
    if (ev.id === 'escape' || (ev.id === 'backspace' && !v.inputActive)) { if (this.overlay) this.closeOverlay(); return; }
    if (v.inputActive) return;
    if (SUB_KEYS[ev.id]) { this.cycleSub(SUB_KEYS[ev.id]); return; }
    if (/^[1-9]$/.test(ev.id)) { const w = this.workspaces[Number(ev.id) - 1]; if (w) this.go(w.id); return; }
    if (ev.id === ':') { this.palette(); return; }
    if (ev.id === '?') { this.help(); return; }
    if (ev.id === 'q') { this.popup ? this.hide() : this.quit(); }
  }

  // ------------------------------------------------------------ mouse
  /**
   * A mouse report: the tab bar and the footer here (from what the last frame drew there), the rest to the open
   * dialog box or the front view with y counted from the view's first row. A click is a left button press; the
   * wheel scrolls. Nothing a click presses differs from the key it stands for, so the keys' guards hold for it too.
   */
  mouse(ev) {
    const { cols, rows } = this.term.size();
    if (cols < 40 || rows < 10) return;
    // A key that changed the view (a digit, Tab) may not be drawn yet: the hit regions and the view's own layout are the
    // last frame's, so a click right after would land on what the old view had there (a sub-tab of the workspace just
    // left). Draw first when the front view is not the one the last frame showed. Within one view nothing is redrawn
    // here, so a click on a strip still acts on exactly what was drawn (the answer guard's screen hash).
    if (this.drawTimer && this.front() !== this.drawnView) { clearTimeout(this.drawTimer); this.drawTimer = null; this.draw(); }
    if (ev.kind === 'move') { this.#move(ev, rows); return; }
    if (this.modal) { if (this.modal.mouse?.(ev)) this.invalidate(); return; }
    const click = ev.kind === 'down' && ev.button === 0;
    const bar = this.#barAt(ev.y, rows);
    if (bar) {
      const hit = click ? hitAt(bar, ev.x) : null;
      if (hit) { hit.run(); this.invalidate(); }
      return;
    }
    if (this.front().mouse?.({ ...ev, y: ev.y - 2 })) this.invalidate();
  }
  #barAt(y, rows) { return y === 0 ? this.tabHits : y === 1 ? this.subHits : y === rows - 1 ? this.footHits : null; }
  /**
   * The pointer moved (mode 1003, no button): remember where, and redraw only when what is under it changed (a bar
   * entry, or whatever the view says changed: its mouse() returns true). Motion comes hundreds of times a second;
   * a move that changes nothing draws nothing. Hover never selects.
   */
  #move(ev, rows) {
    this.hover = { x: ev.x, y: ev.y };
    let changed = false;
    if (this.modal) { if (this.modal.mouse?.(ev)) changed = true; }
    else {
      const bar = this.#barAt(ev.y, rows);
      const key = bar ? `${ev.y === rows - 1 ? 'f' : ev.y}:${hitAt(bar, ev.x)?.g ?? '-'}` : null;
      if (key !== this.barHover) { this.barHover = key; changed = true; }
      if (this.front().mouse?.({ ...ev, y: ev.y - 2 })) changed = true;
    }
    if (changed) this.invalidate();
  }
  /** Whether the pointer is on column x of screen row y (the bars ask, as they draw). */
  hovered(x0, x1, y) { const h = this.hover; return Boolean(h) && h.y === y && h.x >= x0 && h.x < x1; }

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
    this.drawnView = v;
    const frame = [this.#tabBar(cols), this.#subBar(cols)];
    let body;
    try { body = v.render(cols, rows - 3); } catch (e) { body = [[[` this view failed to draw: ${e.message}`, 'err']]]; }
    frame.push(...block(body, rows - 3));
    frame.push(this.#footer(cols, v, rows - 1));
    let cursor = null;
    if (this.modal) { this.modal.overlay(frame, cols, rows); cursor = this.modal.cursor(); }
    else { const c = v.cursor?.(); if (c) cursor = { row: c.row + 2, col: Math.min(cols - 1, c.col) }; }
    this.screen.draw(frame, { rows, cols, cursor });
  }
  #tabBar(cols) {
    const tabs = this.workspaces.map((w, i) => ({ id: w.id, text: ` ${digitOf(i) ? `${digitOf(i)} ` : ''}${w.title} ` }));
    if (this.overlay) tabs.push({ id: 'session', text: ` ▸ ${truncate(this.overlay.title, 28)} ` });
    const active = this.overlay ? tabs.length - 1 : this.ws;
    const w = this.board.totals?.waiting ?? 0;
    const live = this.live === 'open' ? ['live', 'barOk'] : this.live === 'reconnecting' ? ['reconnecting', 'barWait'] : this.live === 'unauthorized' ? ['token rejected', 'barErr'] : [this.live, 'barDim'];
    // Any daemon but the usual local one is named, so a TUI pointed elsewhere (--url, DROVER_STATE) says so.
    const where = this.client.base?.host && this.client.base.host !== '127.0.0.1:7337' ? ` ${this.client.base.host} ` : '';
    const right = [[` ${live[0]} `, live[1]], [where, 'barWait'], [w ? ` ${w} waiting ` : ' 0 waiting ', w ? 'barWait' : 'barDim'], [this.popup ? ` ${this.popup} manager ` : '', 'barDim']];
    const head = [[' drover ', 'tabOn']];
    const room = cols - strWidth(' drover ') - right.reduce((s, [t]) => s + strWidth(t), 0) - 2;
    // Narrow: the tabs lose their trailing space (one space still parts them) before any is scrolled out of view.
    if (tabs.reduce((n, t) => n + strWidth(t.text), 0) > room) for (const t of tabs) t.text = t.text.trimEnd();
    // Show as many tabs as fit, the active one always, widening around it.
    let lo = active, hi = active, used = strWidth(tabs[active].text);
    for (let grew = true; grew;) {
      grew = false;
      if (hi + 1 < tabs.length && used + strWidth(tabs[hi + 1].text) <= room) { hi++; used += strWidth(tabs[hi].text); grew = true; }
      if (lo > 0 && used + strWidth(tabs[lo - 1].text) <= room) { lo--; used += strWidth(tabs[lo].text); grew = true; }
    }
    // Each tab is clicked to go there; the arrows go to the tab just out of view; " drover " opens the palette and
    // the waiting count Agents › Lanes. Under the pointer an entry is drawn in its hover style.
    const bar = this.#bar(0);
    bar.put(head[0], () => this.palette());
    bar.put([lo > 0 ? '‹' : ' ', 'barDim'], lo > 0 ? () => this.#goTab(tabs[lo - 1].id) : null);
    for (let i = lo; i <= hi; i++) bar.put([tabs[i].text, i === active ? 'tabOn' : 'tab'], () => this.#goTab(tabs[i].id));
    bar.put([hi < tabs.length - 1 ? '›' : ' ', 'barDim'], hi < tabs.length - 1 ? () => this.#goTab(tabs[hi + 1].id) : null);
    const pad = Math.max(0, cols - bar.x - right.reduce((s, [t]) => s + strWidth(t), 0));
    bar.put([' '.repeat(pad), 'bar']);
    for (const seg of right) bar.put(seg, seg === right[2] ? () => this.go('agents/lanes') : null);
    this.tabHits = bar.hits;
    return { segs: bar.segs, bg: 'bar' };
  }
  /** Segments put left to right on screen row y, each with a click region when it runs something, hovered when under the pointer. */
  #bar(y) {
    const b = { x: 0, segs: [], hits: [], g: 0 };
    b.put = ([text, style], run, group) => {
      const w = strWidth(text);
      const g = group ?? b.g++;
      const on = Boolean(run) && w > 0 && this.hovered(b.x, b.x + w, y);
      if (run && w) b.hits.push({ x0: b.x, x1: b.x + w, run, g });
      b.segs.push([text, on ? hoverOf(style) : style]); b.x += w;
    };
    return b;
  }
  /** The workspace's sub-views (a click goes there; < > step through them), and the question it answers. */
  #subBar(cols) {
    const w = this.workspace(); const cur = this.overlay ? null : this.sub();
    const bar = this.#bar(1);
    bar.put([' ', null]);
    if (w.subs.length > 1) for (const x of w.subs) bar.put([` ${x.title} `, x === cur ? 'subOn' : 'sub'], () => this.go(`${w.id}/${x.id}`));
    else bar.put([` ${w.title} `, cur ? 'subOn' : 'sub'], () => this.go(w.id));
    const ask = w.subs.length > 1 ? `${w.ask}  < > ` : w.ask;
    const room = cols - bar.x - 1;
    if (room > 8) { const t = truncate(ask, room); bar.put([' '.repeat(Math.max(1, room - strWidth(t))), null]); bar.put([t, 'dim']); }
    this.subHits = bar.hits;
    return bar.segs;
  }
  /** A tab clicked: a workspace by id, or the open session's own tab (nothing to do, it is in front). */
  #goTab(id) { if (id !== 'session') this.go(id); }
  #footer(cols, v, y) {
    const left = (this.modal ? this.modal.hints() : v.hints?.()) ?? [];
    const t = this.toastMsg && this.toastMsg.until > Date.now() ? this.toastMsg : null;
    // With no toast, what is under the pointer is previewed on the right (a prompt's text, a strip's last line).
    const preview = !t && !this.modal ? oneLine(v.hoverPreview?.() ?? '') : '';
    const rw = t ? Math.min(strWidth(t.text) + 2, Math.max(20, Math.floor(cols * 0.6))) : preview ? Math.min(strWidth(preview) + 2, Math.max(20, Math.floor(cols * 0.45))) : 0;
    const lw = rw ? Math.max(0, cols - rw - 1) : cols;
    // A hint's key and its words press that key when clicked (only hints that name one key: not j/k or 1-9); under
    // the pointer the whole hint is drawn in its hover style.
    const laid = []; let used = 1, key = null, g = -1;
    for (const [s, style] of left) {
      if (used >= lw) break;
      const x = truncate(s, lw - used); const w = strWidth(x);
      if (style === 'barKey') { key = hintKey(s); g++; } else if (style === 'barDim' || /^\s*(·\s*)?$/.test(s)) key = null;
      laid.push({ x, style, x0: used, x1: used + w, key, g: key ? g : null }); used += w;
    }
    const hits = laid.filter((l) => l.key && l.x1 > l.x0).map((l) => { const ev = l.key; return { x0: l.x0, x1: l.x1, g: l.g, run: () => this.key({ ...ev }) }; });
    const over = hits.find((h) => this.hovered(h.x0, h.x1, y));
    const leftSegs = laid.map((l) => [l.x, over && l.g === over.g ? hoverOf(l.style) : l.style]);
    if (!t && !preview) { this.footHits = hits; return { segs: [[' ', 'bar'], ...leftSegs], bg: 'bar' }; }
    const pad = [' '.repeat(Math.max(0, lw - used)), 'bar'];
    if (!t) { this.footHits = hits; return { segs: [[' ', 'bar'], ...leftSegs, pad, [` ${truncate(preview, rw - 2)} `, 'barDim']], bg: 'bar' }; }
    const st = { ok: 'barOk', err: 'barErr', wait: 'barWait' }[t.style] ?? 'bar';
    hits.push({ x0: lw, x1: cols, g: 'toast', run: () => { this.toastMsg = null; } });   // a click on a toast dismisses it
    this.footHits = hits;
    return { segs: [[' ', 'bar'], ...leftSegs, pad, [` ${truncate(t.text, rw - 2)} `, st]], bg: 'bar' };
  }
}
