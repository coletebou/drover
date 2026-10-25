// One session or tmux window, opened from the board, Sessions or Tmux: Chat (the transcript by the shared chat
// rule, new turns from `turn` events and `since` reads, an answer card when it waits on a dialog), Screen (the
// pane, captured every 1.5 s while shown), Info. The composer sends to the session's inbox (sessions.message) or
// pastes into its pane (tmux.send, which refuses while a dialog is on screen unless forced); K sends one raw key.
import { Composer } from '../composer.js';
import { chatItems, chatRows, answerCardRows, keyHints } from '../chat.js';
import { answerKeys, pressDrawn } from '../board.js';
import { rule, hints, block, kvRows, ago, tilde } from '../ui.js';
import { sanitize, truncate, oneLine } from '../width.js';
import { renderMarkdown } from '../markdown.js';

const TABS = [['chat', 'Chat'], ['screen', 'Screen'], ['info', 'Info']];
const INBOX = new Set(['claude', 'codex', 'headless', 'openclaw', 'grok', 'hermes']);
const winTarget = (t) => { const m = String(t ?? '').match(/^(.+?):(@\d+)/); return m ? `${m[1]}:${m[2]}` : (t || null); };
// As the web UI's turnKey (ui/chat-model.js): without an id, a turn's calls and results are part of what it is, so two
// tool-only turns (Codex's thread/read gives them no id and maybe no time) stay two.
const keyOf = (t) => {
  if (t.uuid ?? t.id) return t.uuid ?? t.id;
  const tools = Array.isArray(t.tools) ? t.tools.map((u) => u.id ?? u.name).join(',') : '';
  const res = Array.isArray(t.results) ? t.results.map((r) => r.toolUseId ?? '').join(',') : '';
  return `${t.role}|${t.ts ?? ''}|${String(t.text ?? '').slice(0, 160)}|${tools}|${res}`;
};
// Turns kept beyond what was asked for (limit): a session view left open on a busy agent must not grow without end.
export const KEEP_EXTRA = 500;
// What K then a key sends to the pane (tmux key names).
const PANE_KEY = { enter: 'Enter', escape: 'Escape', up: 'Up', down: 'Down', left: 'Left', right: 'Right', tab: 'Tab', 'S-tab': 'BTab', backspace: 'BSpace', space: 'Space', ' ': 'Space', pgup: 'PPage', pgdn: 'NPage', home: 'Home', end: 'End', delete: 'DC' };

export class SessionView {
  constructor(app, target) {
    this.app = app; this.t = { host: 'local', ...target }; this.id = 'session';
    this.session = null; this.window = null;
    this.turns = []; this.seen = new Set(); this.offset = 0; this.limit = 300; this.chatLoaded = false; this.chatError = null;
    this.expanded = new Map(); this.sel = -1; this.top = 0; this.follow = true;
    this.screen = null; this.screenError = null; this.sTop = 0; this.sFollow = true;
    this.composer = new Composer({ history: app.history('session') }); this.focus = 'normal'; this.mode = null; this.pendingForce = null; this.keysMode = false;
    this.tab = target.tab ?? (this.sid() ? 'chat' : 'screen');
    this.timers = []; this.followed = null;
  }
  get title() { return oneLine(this.t.name ?? this.session?.name ?? this.t.id); }
  get inputActive() { return this.focus === 'input'; }
  get hostArg() { return this.t.host && this.t.host !== 'local' ? { host: this.t.host } : {}; }
  sid() { return this.t.kind === 'session' ? this.t.id : this.t.sessionId ?? this.session?.sessionId ?? this.window?.agent?.sessionId ?? null; }
  win() { return this.t.kind === 'window' ? this.t.id : winTarget(this.session?.tmux ?? this.t.tmux); }
  engine() { return this.session?.engine ?? this.t.engine ?? this.window?.agent?.engine ?? null; }
  canInbox() { return Boolean(this.sid()) && INBOX.has(this.engine() ?? (this.t.kind === 'session' ? 'claude' : '')); }
  /**
   * This session's strip on the board: on its own host only (two hosts can both have a work:1), the session itself
   * first, its window only when no strip names the session.
   */
  strip() {
    const sid = this.sid(), win = this.win(), host = this.#hostKey(this.t.host);
    const here = this.app.board.strips.filter((s) => this.#hostKey(s.host) === host);
    return (sid && here.find((s) => s.sessionId === sid || s.id === sid)) || (win && here.find((s) => s.tmux && winTarget(s.tmux) === win)) || null;
  }
  #hostKey(h) { return !h || h === 'local' || h === this.app.frontHost ? 'local' : h; }
  waitingStrip() { const s = this.strip(); return s && s.lane === 'wait' ? s : null; }

  show() {
    this.loadMeta();
    this.#arm();
  }
  hide() { for (const t of this.timers) clearInterval(t); this.timers = []; if (this.followed) { this.app.client.follow(this.followed, false); this.followed = null; } }
  #arm() {
    for (const t of this.timers) clearInterval(t); this.timers = [];
    if (this.tab === 'chat') { this.loadChat(); this.timers.push(setInterval(() => this.loadChat({ incremental: true }), 3000)); }
    if (this.tab === 'screen') { this.loadScreen(); this.timers.push(setInterval(() => this.loadScreen(), 1500)); }
  }
  setTab(tab) { this.tab = tab; this.#arm(); this.app.invalidate(); }

  async loadMeta() {
    try {
      if (this.t.kind === 'session') { const s = await this.app.client.call('sessions.get', { id: this.t.id, ...this.hostArg }); if (s) this.session = s; }
      else { const wins = await this.app.client.call('tmux.windows', { classify: false, ...this.hostArg }); this.window = (wins ?? []).find((w) => w.target === this.t.id || `${w.session}:${w.windowId}` === this.t.id) ?? null; }
    } catch (e) { this.metaError = e.message; }
    if (this.mode === null) this.mode = this.canInbox() ? 'inbox' : 'pane';
    if (this.tab === 'chat' && !this.chatLoaded) this.loadChat();
    this.app.invalidate();
  }

  async loadChat({ incremental = false } = {}) {
    const sid = this.sid(); if (!sid) return;
    if (this.busyChat) return; this.busyChat = true;
    try {
      const r = await this.app.client.call('sessions.transcript', { id: sid, since: incremental ? this.offset : 0, limit: this.limit, ...this.hostArg });
      if (!incremental) { this.turns = []; this.seen = new Set(); }
      let added = 0;
      for (const t of r?.turns ?? []) if (this.take(t)) added++;
      this.trim();
      if (r?.offset !== undefined) this.offset = r.offset;
      this.summary = r?.summary ?? this.summary;
      this.chatLoaded = true; this.chatError = null;
      if (!incremental && !this.followed && this.engine() === 'claude' && !this.hostArg.host) { this.followed = sid; this.app.client.follow(sid, true); }
      if (added || !incremental) this.app.invalidate();
    } catch (e) { if (!incremental) { this.chatError = e.message; this.app.invalidate(); } }
    finally { this.busyChat = false; }
  }

  async loadScreen() {
    const win = this.win(); if (!win) return;
    try {
      const r = await this.app.client.call('tmux.capture', { target: win, lines: 400, ...this.hostArg });
      this.screen = { text: sanitize(r?.text ?? '', { tabSize: 8 }), state: r?.screen?.state ?? 'unknown', reason: r?.screen?.reason ?? '', at: Date.now() };
      this.screenError = null;
    } catch (e) { this.screenError = e.message; }
    this.app.invalidate();
  }

  onEvent(type, d) {
    if (type === 'turn' && d?.id && d.id === this.sid() && d.turn) {
      if (!this.take(d.turn)) return;
      this.trim(); this.app.invalidate();
    }
  }

  /** Add a turn unless it is already here (an incremental read and a turn event can both bring it). */
  take(t) { const k = keyOf(t); if (this.seen.has(k)) return false; this.seen.add(k); this.turns.push(t); return true; }
  /**
   * Keep the newest limit + KEEP_EXTRA turns and forget the ids of the rest (`since` reads never bring them back).
   * Not while the owner is scrolled up: what they are reading stays until they are back at the bottom.
   */
  trim() {
    const cap = this.limit + KEEP_EXTRA;
    if (this.turns.length <= cap || !this.follow || this.sel >= 0) return;
    for (const t of this.turns.splice(0, this.turns.length - cap)) this.seen.delete(keyOf(t));
  }

  // ------------------------------------------------------------ actions
  async send(text) {
    if (!text.trim()) return;
    const sid = this.sid(), win = this.win();
    try {
      if (this.mode === 'inbox' && this.canInbox()) {
        const r = await this.app.client.call('sessions.message', { id: sid, text, ...this.hostArg }, { timeoutMs: this.engine() === 'openclaw' ? 16 * 60_000 : 30_000 });
        this.app.toast(r?.queuedBehindTurn ? 'queued: the session takes it after this turn' : `delivered${r?.via ? ` via ${r.via}` : ''}`, 'ok');
      } else {
        if (!win) throw new Error('this session has no pane');
        const r = await this.app.client.call('tmux.send', { target: win, text, enter: true, ...this.hostArg });
        if (r?.refused) { this.pendingForce = text; this.app.toast('refused: a dialog is on screen. Read it (Screen), then F forces the paste', 'err', 8000); return; }
        this.app.toast('pasted into the pane', 'ok');
      }
      this.pendingForce = null;
      setTimeout(() => (this.tab === 'chat' ? this.loadChat({ incremental: true }) : this.loadScreen()), 600);
    } catch (e) { this.app.toast(`not sent: ${e.message}`, 'err', 8000); this.composer.set(text); this.focus = 'input'; }
  }
  async force() {
    const text = this.pendingForce; if (!text) return;
    try { await this.app.client.call('tmux.send', { target: this.win(), text, enter: true, force: true, ...this.hostArg }); this.pendingForce = null; this.app.toast('forced into the pane', 'ok'); }
    catch (e) { this.app.toast(`force: ${e.message}`, 'err'); }
  }
  async paneKey(name) {
    const win = this.win(); if (!win) { this.app.toast('no pane to send keys to', 'err'); return; }
    try { await this.app.client.call('tmux.keys', { target: win, keys: [name], ...this.hostArg }); this.app.toast(`sent ${name} to ${win}`, 'ok'); setTimeout(() => this.loadScreen(), 350); }
    catch (e) { this.app.toast(`keys: ${e.message}`, 'err'); }
  }

  clearInput() { if (this.focus === 'input' && !this.composer.empty) { this.composer.clear(); return true; } if (this.keysMode) { this.keysMode = false; return true; } return false; }

  // ------------------------------------------------------------ keys
  key(ev) {
    if (this.keysMode) {
      this.keysMode = false;
      if (ev.id === 'K') return true;
      const name = PANE_KEY[ev.id] ?? (ev.ctrl && /^[a-z]$/.test(ev.name) ? `C-${ev.name}` : ev.ch && ev.ch.length === 1 ? ev.ch : null);
      if (name) this.paneKey(name); else this.app.toast(`cannot send ${ev.id} to a pane`, 'err');
      return true;
    }
    if (this.focus === 'input') {
      if (ev.id === 'escape') { this.focus = 'normal'; return true; }
      if (ev.id === 'C-t') { this.toggleMode(); return true; }
      if (ev.id === 'pgup' || ev.id === 'pgdn') return this.#scrollKey(ev);
      const r = this.composer.handle(ev, this.inputW ?? 80);
      if (r === 'submit') { const v = this.composer.commit(); this.app.saveHistory('session', this.composer.history); this.send(v); return true; }
      return r;
    }
    const items = this.items ?? [];
    // With the answer card selected, a dialog key presses exactly the card the last frame drew, or nothing.
    if (this.cardIndex >= 0 && this.sel === this.cardIndex && pressDrawn(this.app, this.waitingStrip(), this.drawnCard, ev, () => setTimeout(() => this.#refreshAfterAnswer(), 400))) return true;
    switch (ev.id) {
      case 'tab': this.setTab(TABS[(TABS.findIndex(([id]) => id === this.tab) + 1) % TABS.length][0]); return true;
      case 'S-tab': this.setTab(TABS[(TABS.findIndex(([id]) => id === this.tab) + TABS.length - 1) % TABS.length][0]); return true;
      case 'c': this.setTab('chat'); return true;
      case 's': this.setTab('screen'); return true;
      case 'I': this.setTab('info'); return true;
      case 'i': case 'r': case 'a': if (ev.id === 'a' && this.cardIndex >= 0) { this.sel = this.cardIndex; this.follow = false; return true; } if (!this.sid() && !this.win()) return true; this.focus = 'input'; return true;
      case 'paste': this.focus = 'input'; this.composer.handle(ev); return true;
      case 't': this.toggleMode(); return true;
      case 'K': this.keysMode = true; return true;
      case 'F': this.force(); return true;
      case 'R': case 'C-r': if (this.tab === 'chat') this.loadChat(); else if (this.tab === 'screen') this.loadScreen(); else this.loadMeta(); return true;
      case 'enter': {
        if (this.tab !== 'chat') return true;
        const it = items[this.sel];
        if (it?.kind === 'tools') { const l = this.expanded.get(it.key) ?? 0; this.expanded.set(it.key, (l + 1) % 3); return true; }
        return true;
      }
      default: return this.#scrollKey(ev);
    }
  }
  #scrollKey(ev) {
    const page = Math.max(3, (this.bodyH ?? 20) - 3);
    if (this.tab === 'screen') {
      const max = Math.max(0, (this.screenRows ?? 0) - (this.bodyH ?? 20));
      const cur = this.sFollow ? max : this.sTop;
      const d = { j: 1, down: 1, k: -1, up: -1, pgdn: page, pgup: -page, space: page, b: -page }[ev.id];
      if (ev.id === 'g' || ev.id === 'home') { this.sTop = 0; this.sFollow = false; return true; }
      if (ev.id === 'G' || ev.id === 'end') { this.sFollow = true; return true; }
      if (d === undefined) return false;
      this.sTop = Math.max(0, Math.min(max, cur + d)); this.sFollow = this.sTop >= max; return true;
    }
    if (this.tab !== 'chat') return false;
    const n = (this.items ?? []).length;
    if (ev.id === 'j' || ev.id === 'down') { if (this.sel < 0) return true; this.sel++; if (this.sel >= n) { this.sel = -1; this.follow = true; } return true; }
    if (ev.id === 'k' || ev.id === 'up') { this.sel = this.sel < 0 ? n - 1 : Math.max(0, this.sel - 1); this.follow = false; return true; }
    if (ev.id === 'g' || ev.id === 'home') { this.sel = n ? 0 : -1; this.follow = false; this.top = 0; return true; }
    if (ev.id === 'G' || ev.id === 'end') { this.sel = -1; this.follow = true; return true; }
    if (ev.id === 'pgup' || ev.id === 'b') { this.sel = -1; this.follow = false; this.top = Math.max(0, this.top - page); if (this.top === 0 && this.limit < 3000 && this.turns.length >= this.limit * 0.9) { this.limit *= 3; this.loadChat(); } return true; }
    if (ev.id === 'pgdn' || ev.id === 'space') { this.sel = -1; this.top += page; return true; }
    return false;
  }
  toggleMode() {
    if (!this.canInbox() || !this.win()) { this.app.toast(this.canInbox() ? 'no pane: messages go to the inbox' : 'no inbox: text goes to the pane', 'dim'); return; }
    this.mode = this.mode === 'inbox' ? 'pane' : 'inbox';
  }
  async #refreshAfterAnswer() { this.app.refreshBoardSoon(0); if (this.tab === 'screen') this.loadScreen(); else this.loadChat({ incremental: true }); }

  hints() {
    if (this.keysMode) return hints([['any key', 'goes to the pane: Enter Esc arrows digits y n C-c'], ['K', 'cancel']]);
    if (this.focus === 'input') return hints([['Enter', this.mode === 'pane' ? 'paste into the pane' : 'send to the session'], ['C-j', 'new line'], ['C-t', this.mode === 'pane' ? 'to session' : 'to pane'], ['↑↓', 'history'], ['Esc', 'keys']]);
    const card = this.cardIndex >= 0 && this.sel === this.cardIndex ? this.waitingStrip() : null;
    if (card) return [...keyHints(answerKeys(card)).map(([t, st]) => [t, st === 'key' ? 'barKey' : 'bar']), ['   ', 'barDim'], ...hints([['k', 'up'], ['Esc', 'back']])];
    return hints([['Tab', 'chat/screen/info'], ['r', 'reply'], ['j/k', 'select'], ['Enter', 'expand'], ...(this.cardIndex >= 0 ? [['a', 'answer']] : []), ['K', 'key to pane'], ['t', this.mode === 'pane' ? 'to session' : 'to pane'], ['Esc', 'back']]);
  }

  // ------------------------------------------------------------ render
  render(width, height) {
    const s = this.session ?? {}; const w = this.window ?? {};
    const status = s.status ?? w.agent?.status ?? this.strip()?.status ?? this.screen?.state ?? '';
    const strip = this.strip();
    const head = [[` ${this.title}`, 'bold'], [`  ${this.engine() ?? (this.t.kind === 'window' ? 'window' : '')}`, 'dim'], [status ? `  ${status}` : '', status === 'busy' ? 'work' : strip?.lane === 'wait' ? 'waitBold' : 'dim'], [`  ${[this.t.host !== 'local' ? this.t.host : null, this.win(), tilde(s.cwd ?? w.cwd ?? this.t.cwd ?? '')].filter(Boolean).join('  ')}`, 'dim']];
    const tabs = [[' ', null]];
    for (const [id, label] of TABS) tabs.push([` ${label} `, id === this.tab ? 'tabOn' : 'dim'], [' ', null]);
    if (this.pendingForce) tabs.push(['  refused paste waiting: F forces it', 'err']);
    // Composer.
    const target = this.mode === 'pane' ? `pane ${this.win() ?? ''}` : 'session';
    const inputW = Math.max(10, width - 3); this.inputW = inputW;
    const L = this.composer.layout(inputW);
    const maxIn = Math.max(1, Math.min(6, Math.floor(height / 4)));
    const inTop = Math.max(0, Math.min(L.rows.length - maxIn, L.cursorRow - maxIn + 1));
    const inRows = L.rows.slice(inTop, inTop + maxIn);
    const canSend = this.sid() || this.win();
    const bodyH = Math.max(1, height - 3 - (canSend ? inRows.length + 1 : 0)); this.bodyH = bodyH;
    const out = [head, tabs, rule(width)];
    if (this.tab === 'chat') out.push(...this.#chat(width, bodyH));
    else if (this.tab === 'screen') out.push(...this.#screen(width, bodyH));
    else out.push(...block(this.#info(width), bodyH));
    if (canSend) {
      out.push(rule(width, `to ${target}`, this.focus === 'input' ? 'accent' : 'dim'));
      inRows.forEach((r, i) => out.push([[i === 0 && inTop === 0 ? '› ' : '  ', this.focus === 'input' ? 'accent' : 'dim'], [r, null]]));
      if (!this.composer.value) out[out.length - 1] = [['› ', this.focus === 'input' ? 'accent' : 'dim'], [this.focus === 'input' ? `message the ${target}` : 'r to reply', 'dim']];
      this.inLayout = { inStart: out.length - inRows.length, inTop, L };
    } else this.inLayout = null;
    return block(out, height);
  }
  cursor() {
    if (this.focus !== 'input' || !this.inLayout) return null;
    const { inStart, inTop, L } = this.inLayout;
    return { row: inStart + (L.cursorRow - inTop), col: 2 + L.cursorCol };
  }

  #chat(width, h) {
    if (!this.sid()) return block([[[' No agent session in this window: Screen shows the pane (Tab).', 'dim']]], h);
    if (this.chatError && !this.turns.length) return block([[[` could not read the transcript: ${this.chatError}`, 'err']]], h);
    const items = chatItems(this.turns);
    const ws = this.waitingStrip();
    this.drawnCard = ws ? { key: ws.key, strip: ws } : null;
    this.cardIndex = -1;
    if (ws) { this.cardIndex = items.length; items.push({ kind: 'card', key: `card|${ws.hash ?? ''}`, rows: answerCardRows(ws, answerKeys(ws), width - 1) }); }
    this.items = items;
    if (this.sel >= items.length) this.sel = -1;
    const busy = (this.session?.status ?? this.strip()?.status) === 'busy' || this.strip()?.lane === 'work';
    const footer = !this.chatLoaded ? [[[' reading the transcript…', 'dim']]] : !items.length ? [[[' No turns yet.', 'dim']]] : [];
    const { rows, spans } = chatRows(items, width, { expanded: this.expanded, selected: this.sel, working: busy && !ws, names: { assistant: this.engine() === 'openclaw' ? 'manager' : this.engine() ?? 'assistant' }, footer });
    const max = Math.max(0, rows.length - h);
    if (this.follow) this.top = max;
    else if (this.sel >= 0 && spans[this.sel]) {
      const [a, b] = spans[this.sel];
      if (a < this.top) this.top = a; else if (b > this.top + h) this.top = Math.min(a, b - h);
    }
    this.top = Math.max(0, Math.min(this.top, max));
    if (this.top >= max && this.sel < 0) this.follow = true;
    const view = rows.slice(this.top, this.top + h);
    if (this.top > 0) view[0] = [[`  ↑ ${this.top} more rows${this.limit < 3000 ? ' (PgUp at the top loads older turns)' : ''}`, 'dim']];
    return block(view, h);
  }

  #screen(width, h) {
    if (!this.win()) return block([[[' No tmux window: headless sessions have no pane.', 'dim']]], h);
    if (!this.screen) return block([[[this.screenError ? ` could not capture the pane: ${this.screenError}` : ' capturing the pane…', this.screenError ? 'err' : 'dim']]], h);
    const lines = this.screen.text.split('\n');
    const state = [[' ● ', this.screen.state === 'dialog' ? 'wait' : this.screen.state === 'busy' ? 'work' : 'idle'], [this.screen.state, 'bold'], [this.screen.reason ? `  ${this.screen.reason}` : '', 'dim'], [`  ${ago(this.screen.at)} ago`, 'dim'], [this.screenError ? `  ${this.screenError}` : '', 'err'], ['   K then ', 'dim'], ['Enter Esc ↑ ↓ 1-9 y n C-c', 'key'], [' sends that key', 'dim']];
    const bh = h - 1;
    this.screenRows = lines.length;
    const max = Math.max(0, lines.length - bh);
    if (this.sFollow) this.sTop = max; else this.sTop = Math.min(this.sTop, max);
    const view = lines.slice(this.sTop, this.sTop + bh).map((l) => [[' ', null], [truncate(l, width - 1, ''), null]]);
    return block([state, ...view], h);
  }

  #info(width) {
    const s = this.session ?? {}; const w = this.window ?? {}; const t = this.t;
    const sid = s.sessionId ?? s.threadId ?? this.sid() ?? '';
    const cwd = s.cwd ?? w.cwd;
    const resume = this.engine() === 'codex' && (s.threadId ?? sid) ? `codex resume ${s.threadId ?? sid}` : this.engine() === 'hermes' && sid ? `hermes --tui --resume ${sid}` : sid && (this.engine() === 'claude' || !this.engine()) ? `claude --resume ${sid}` : null;
    const rows = kvRows([
      ['engine', this.engine()], ['name', t.name ?? s.name], ['status', s.status ?? w.agent?.status], ['host', t.host === 'local' ? `${this.app.frontHost ?? 'local'} (this machine)` : t.host],
      ['session id', sid], ['tmux', this.win()], ['pid', s.pid ?? w.panePid], ['cwd', cwd ? tilde(cwd) : null], ['started', s.startedAt ? new Date(s.startedAt < 1e11 ? s.startedAt * 1000 : s.startedAt).toLocaleString() : null],
      ['version', s.version], ['model', s.model], ['resume', resume ? `${cwd ? `cd ${tilde(cwd)} && ` : ''}${resume}` : null], ['transcript', s.transcript ? tilde(s.transcript) : null],
      ['socket', s.socket], ['kind', s.sessionKind ?? s.kind], ['command', w.cmd], ['panes', w.panes], ['entrypoint', s.entrypoint],
    ], width - 2).map((r) => [[' ', null], ...r]);
    if (this.summary?.firstPrompt) { rows.push([], [[' first prompt', 'dim']]); rows.push(...renderMarkdown(truncate(this.summary.firstPrompt, 600), width - 2, { indent: '   ' })); }
    if (this.metaError) rows.push([], [[` ${this.metaError}`, 'err']]);
    return rows;
  }
}
