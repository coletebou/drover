// The manager view (the default): the OpenClaw fleet manager's conversation in one thread (main unless --thread or
// /thread), its streamed replies, a composer, and a strip at the top with what waits on the owner and the keys that
// answer it. Messages go out as sessions.message { id: "manager", text, wait: false, thread }; the reply arrives
// as `manager` stream events and a `turn` event (convo.js merges them). A daemon from before async replies
// answers in the call itself, minutes later: the view says so while it waits.
import { Convo } from '../convo.js';
import { Composer } from '../composer.js';
import { chatItems, chatRows, keyHints } from '../chat.js';
import { answerKeys, pressDrawn } from '../board.js';
import { rule, hints, block, keepVisible } from '../ui.js';
import { truncate, oneLine, sanitize } from '../width.js';

const THREAD = /^[A-Za-z0-9_.:@%-]{1,64}$/;   // the daemon's thread names (core/openclaw.js THREAD_RE)
const COMMANDS = [
  ['/thread', '<name>', 'switch to another conversation (main is the shared one)'],
  ['/threads', '', 'list the conversations'],
  ['/look', '[target]', 'attach the last 60 lines of the window you came from to the next message'],
  ['/sweep', '', 'ask the manager to sweep the fleet now'],
  ['/status', '', "the manager's service, gateway, model, cost and automations"],
  ['/board', '', 'the board'],
  ['/help', '', 'these commands and the keys'],
];

export class ManagerView {
  constructor(app, { thread = 'main', from = null } = {}) {
    this.app = app; this.id = 'manager'; this.title = 'Manager';
    this.convo = new Convo(thread, { onChange: () => app.invalidate() }); this.composer = new Composer({ history: app.history('manager') });
    // waitKey: the strip the owner picked with w, by key (never by position: the lane re-sorts on every board event);
    // shown: the strip the last frame drew at the top, and what it drew of it (the hash a press must carry).
    this.focus = 'input'; this.top = 0; this.follow = true; this.waitKey = null; this.shown = null;
    this.from = from; this.look = null; this.loaded = false; this.loading = false; this.lastLayout = null;
  }
  get thread() { return this.convo.thread; }
  get inputActive() { return this.focus === 'input'; }
  get host() { const h = this.app.board.manager?.host; return h && h !== 'local' && h !== this.app.frontHost ? { host: h } : {}; }
  get hostKey() { return this.host.host ?? 'local'; }

  show() { if (!this.loaded) this.load(); }
  async load() {
    if (this.loading) return; this.loading = true;
    const asked = this.hostKey; this.askedHost = asked;
    try {
      const r = await this.app.client.call('sessions.transcript', { id: 'manager', thread: this.thread, limit: 200, ...this.host });
      this.convo.load(r?.turns ?? []); this.loaded = true; this.error = null;
    } catch (e) { this.error = e.message; }
    finally {
      this.loading = false; this.app.invalidate();
      if (this.hostKey !== asked) this.load();   // the board named another host while this read was out
    }
  }
  /**
   * The board changed (App.setBoard). A read made before it named the manager's host, or of another host, went to the
   * wrong daemon (a front with no manager of its own answers "session not found"): read again where the manager is.
   */
  onBoard() { if (this.askedHost !== undefined && this.askedHost !== this.hostKey && !this.loading) return this.load(); }

  // ------------------------------------------------------------ events
  onEvent(type, d) {
    if (type === 'manager') { if (this.convo.stream(d)) this.app.invalidate(); }
    else if (type === 'turn' && d?.id === 'manager') { if (this.convo.server({ ...d.turn, thread: d.thread ?? d.turn?.thread ?? 'main' })) this.app.invalidate(); }
    else if (type === 'hello' && this.loaded) this.load();   // reconnected: what streamed while away is in the transcript
  }

  // ------------------------------------------------------------ sending
  async submit(text) {
    if (!text.trim()) return;
    if (/^\/\S*/.test(text.trim()) && !/^\/\//.test(text.trim())) return this.command(text.trim());
    const look = this.look; this.look = null;
    const full = look ? `${text}\n\n[${look.label}, last ${look.lines} lines]\n\`\`\`\n${look.text}\n\`\`\`` : text;
    const key = this.convo.send(full);
    this.follow = true; this.app.invalidate();
    // A daemon from before async replies holds the call until the reply: after a moment, say what is happening.
    const slow = setTimeout(() => { if (this.convo.turns.find((t) => t.key === key)?.sending) { this.convo.waitingBlocking(key); this.app.invalidate(); } }, this.app.caps.managerAsync === false ? 0 : 2500);
    try {
      const r = await this.app.client.call('sessions.message', { id: 'manager', text: full, wait: false, thread: this.thread, ...this.host }, { timeoutMs: 16 * 60_000 });
      if (r?.pending) this.app.caps.managerAsync = true; else if (typeof r?.reply === 'string') this.app.caps.managerAsync = false;
      this.convo.sent(key, r ?? {});
    } catch (e) { this.convo.failed(key, e.message); if (look) this.look = look; }
    finally { clearTimeout(slow); this.app.invalidate(); }
  }

  async command(line) {
    const [cmd, ...rest] = line.split(/\s+/); const arg = rest.join(' ').trim();
    switch (cmd) {
      case '/thread': {
        if (!arg) { this.convo.system(`thread ${this.thread}. /thread <name> switches; main is the conversation every client shares.`); return; }
        if (!THREAD.test(arg)) { this.convo.system('a thread name is 1 to 64 letters, digits, _ . : @ % or -', 'err'); return; }
        return this.switchThread(arg);
      }
      case '/threads': return this.threads();
      case '/look': return this.lookAt(arg || null);
      case '/sweep': {
        try { await this.app.client.call('openclaw.sweep', { ...this.host }); this.convo.system('the manager is sweeping; its notes land in the truth file (Events) as it goes'); }
        catch (e) { this.convo.system(`sweep: ${e.message}`, 'err'); }
        return;
      }
      case '/status': return this.status();
      case '/board': this.app.go('board'); return;
      case '/help': case '/?': this.app.help(); return;
      case '/quit': this.app.quit(); return;
      default: this.convo.system(`unknown command ${cmd}; /help lists them`, 'err');
    }
  }

  async switchThread(name) {
    if (name === this.thread) return;
    this.convo = new Convo(name, { onChange: () => this.app.invalidate() }); this.loaded = false; this.top = 0; this.follow = true;
    this.convo.system(`thread ${name}${name === 'main' ? ' (shared by every client)' : ''}`);
    this.app.invalidate();
    await this.load();
  }

  async threads() {
    try {
      const list = await this.app.client.call('openclaw.threads', { ...this.host });
      if (!list?.length) { this.convo.system('no threads yet besides main'); return; }
      this.convo.system(['threads, newest first:', ...list.map((t) => `  ${t.thread === this.thread ? '▸' : ' '} ${t.thread}  ${t.turns ?? '?'} turns  ${oneLine(t.lastText ?? '').slice(0, 80)}`)].join('\n'));
    } catch (e) { this.convo.system(e.unknownOp ? 'this daemon predates threads: there is one conversation (main)' : `threads: ${e.message}`, e.unknownOp ? 'dim' : 'err'); }
  }

  async status() {
    try {
      const s = await this.app.client.call('openclaw.status', { ...this.host });
      if (!s?.configured) { this.convo.system(`no manager on ${s?.host ?? 'this host'}${s?.reason ? `: ${s.reason}` : ''}`, 'err'); return; }
      const u = s.unit ?? {}; const m = s.model ?? {}; const a = s.automations ?? {}; const c = s.cost ?? {};
      const up = u.uptimeSec != null ? (u.uptimeSec < 3600 ? `${Math.round(u.uptimeSec / 60)} min` : `${(u.uptimeSec / 3600).toFixed(1)} h`) : '';
      this.convo.system([
        `manager on ${s.host ?? 'this host'} (writes as ${s.actor ?? 'manager'})`,
        `  service   ${u.active ?? '?'}${up ? `, up ${up}` : ''}${u.restarts ? `, ${u.restarts} restarts` : ''}`,
        `  gateway   ${s.gateway?.up ? 'answering' : 'not answering'}  ${s.gateway?.url ?? ''}`,
        `  health    ${s.health?.ok ? 'ok' : `not ok${s.health?.error ? `: ${s.health.error}` : ''}`}`,
        `  model     ${m.primary ?? '?'}${m.fallbacks?.length ? `, then ${m.fallbacks.join(', ')}` : ''}`,
        `  last run  ${a.lastRunAt ?? 'none recorded'}${a.nextRunAt ? `, next ${a.nextRunAt}` : ''}`,
        `  cost      ${c.todayUsd != null ? `$${Number(c.todayUsd).toFixed(2)} today` : 'unknown'} (no spend cap)`,
        `  24 h      ${s.wal24h?.notes ?? 0} notes, ${s.wal24h?.pins ?? 0} pins, ${s.wal24h?.chats ?? 0} chat replies`,
      ].join('\n'));
    } catch (e) { this.convo.system(`status: ${e.message}`, 'err'); }
  }

  /** /look: capture the window the owner came from and hold it for the next message. */
  async lookAt(target) {
    const where = target ?? (await this.app.origin()) ?? this.from;
    if (!where) { this.convo.system('no window to look at: open the manager from a window (drover manager popup), start it with --from <target>, or say /look <target>', 'err'); return; }
    try {
      const r = await this.app.client.call('tmux.capture', { target: where, lines: 60 });
      // capture-pane -S -60 is 60 lines of history plus the screen: keep the last 60.
      const text = sanitize(r?.text ?? '').trimEnd().split('\n').slice(-60).join('\n');
      const label = await this.app.describeTarget(where);
      const lines = text ? text.split('\n').length : 0;
      this.look = { target: where, label, text, lines };
      this.convo.system(`attached ${lines} lines of ${label}; they go with your next message`);
    } catch (e) { this.convo.system(`look: ${e.message}`, 'err'); }
  }

  // ------------------------------------------------------------ keys
  waiting() { return this.app.board.strips.filter((s) => s.lane === 'wait'); }
  clearInput() { if (this.focus === 'input' && !this.composer.empty) { this.composer.clear(); return true; } if (this.look) { this.look = null; this.convo.system('dropped the attached window'); return true; } return false; }

  key(ev) {
    const page = Math.max(3, (this.lastLayout?.chatH ?? 20) - 3);
    if (ev.id === 'pgup') { this.scroll(-page); return true; }
    if (ev.id === 'pgdn') { this.scroll(page); return true; }
    if (this.focus === 'input') {
      if (ev.id === 'escape') { this.focus = 'chat'; return true; }
      if (ev.id === 'tab' && /^\/\w*$/.test(this.composer.value)) { const m = COMMANDS.map(([c]) => c).filter((c) => c.startsWith(this.composer.value)); if (m.length === 1) { this.composer.set(`${m[0]} `); return true; } }
      if (ev.id === 'C-up') { this.scroll(-1); return true; }
      if (ev.id === 'C-down') { this.scroll(1); return true; }
      const r = this.composer.handle(ev, this.lastLayout?.inputW ?? 80);
      if (r === 'submit') { const v = this.composer.commit(); this.app.saveHistory('manager', this.composer.history); this.submit(v); return true; }
      return r;
    }
    if (this.focus === 'waiting') {
      const list = this.waiting();
      const i = this.waitKey ? list.findIndex((x) => x.key === this.waitKey) : -1;
      if (['left', 'h', 'k', 'up'].includes(ev.id)) { if (list.length) this.waitKey = list[i < 0 ? list.length - 1 : (i - 1 + list.length) % list.length].key; return true; }
      if (['right', 'l', 'j', 'down'].includes(ev.id)) { if (list.length) this.waitKey = list[i < 0 ? 0 : (i + 1) % list.length].key; return true; }
      if (ev.id === 'w' || ev.id === 'i' || ev.id === 'tab') { this.focus = 'input'; this.waitKey = null; return true; }
      const s = i >= 0 ? list[i] : null;
      // A dialog key presses exactly what the last frame drew, or nothing (board.js pressDrawn): never another strip.
      if (pressDrawn(this.app, s, this.shown?.key === this.waitKey ? this.shown : null, ev)) return true;
      if (!s) {
        if (ev.id === 'escape') { this.focus = 'input'; this.waitKey = null; return true; }
        if (ev.id === 'enter' || /^[1-9yn]$/.test(ev.id)) { this.app.toast('the strip you picked is no longer waiting; nothing was pressed', 'wait'); return true; }
        return false;
      }
      if (ev.id === 'o') { this.app.openStrip(s); return true; }
      if (ev.id === 'r') { this.app.replyTo(s); return true; }
      return false;
    }
    // chat focus (normal mode)
    switch (ev.id) {
      case 'i': case 'a': case 'enter': this.focus = 'input'; return true;
      case '/': this.focus = 'input'; this.composer.set('/'); return true;
      case 'paste': this.focus = 'input'; this.composer.handle(ev); return true;
      case 'j': case 'down': this.scroll(1); return true;
      case 'k': case 'up': this.scroll(-1); return true;
      case 'space': case ' ': this.scroll(page); return true;
      case 'b': this.scroll(-page); return true;
      case 'g': case 'home': this.follow = false; this.top = 0; return true;
      case 'G': case 'end': this.follow = true; return true;
      // The strip the last frame showed, not whatever sorts first now.
      case 'w': if (this.shown?.key) { this.focus = 'waiting'; this.waitKey = this.shown.key; } return true;
      default: return false;
    }
  }
  scroll(n) {
    const L = this.lastLayout; if (!L) return;
    const max = Math.max(0, L.total - L.chatH);
    const cur = this.follow ? max : this.top;
    this.top = Math.max(0, Math.min(max, cur + n));
    this.follow = this.top >= max;
  }

  hints() {
    if (this.focus === 'waiting') {
      const s = this.waiting().find((x) => x.key === this.waitKey);
      if (!s) return hints([['←→', 'pick another'], ['w', 'back to typing']]);
      const keys = answerKeys(s);
      return [...(keys.length ? keyHints(keys).map(([t, st]) => [t, st === 'key' ? 'barKey' : 'bar']) : [['r', 'barKey'], [' reply', 'bar']]), ['  ', 'barDim'], ...hints([['←→', 'next'], ['o', 'open'], ['r', 'reply'], ['w', 'back to typing']])];
    }
    if (this.focus === 'input') return hints([['Enter', 'send'], ['C-j', 'new line'], ['↑↓', 'history'], ['PgUp/PgDn', 'scroll'], ['Esc', 'keys'], ['/help', 'commands'], ['Tab', 'next view']]);
    return hints([['i', 'type'], ['j/k', 'scroll'], ['w', 'answer waiting'], ['1-9', 'views'], [':', 'commands'], ['?', 'help'], ['q', this.app.popup ? 'hide' : 'quit']]);
  }

  // ------------------------------------------------------------ render
  render(width, height) {
    const out = [];
    // What waits on the owner, with the keys that answer it.
    const list = this.waiting();
    const sel = this.focus === 'waiting';
    const i = sel ? list.findIndex((x) => x.key === this.waitKey) : list.length ? 0 : -1;
    const s = i >= 0 ? list[i] : null;
    this.shown = s ? { key: s.key, strip: s } : null;
    if (!list.length && !sel) out.push([[' nothing waits on you', 'dim'], ...(this.app.board.error ? [[`  (board: ${this.app.board.error})`, 'err']] : [])]);
    else if (!s) out.push([['▌', 'accent'], [' the strip you picked is no longer waiting', 'wait'], [list.length ? `; ${list.length} still waiting, ←→ picks one` : '; nothing else waits on you', 'dim']], [['▌', 'accent'], ['  w goes back to typing', 'dim']]);
    else {
      out.push([[sel ? '▌' : ' ', 'accent'], [`${list.length} waiting `, 'waitBold'], [list.length > 1 ? `${i + 1}/${list.length} ` : '', 'dim'], [s.name, 'bold'], [`  ${s.host === 'local' ? this.app.frontHost ?? 'local' : s.host}  `, 'dim'], [truncate(oneLine(s.dialog?.question ?? s.ask?.text ?? s.headline ?? ''), Math.max(10, width - 40)), null]]);
      const keys = answerKeys(s);
      const opts = (s.dialog?.options ?? []).map((o) => [[`${o.selected ? '❯' : ' '}${o.n} `, 'key'], [`${truncate(oneLine(o.label), 28)}  `, null]]).flat();
      out.push([[sel ? '▌' : ' ', 'accent'], ['  ', null], ...opts, ...(keys.length ? keyHints(keys.filter((k) => !/^[1-9]$/.test(k.key))) : [['r reply', 'dim']]), [sel ? '' : '   w to answer', 'dim']]);
    }
    out.push(rule(width, `manager · thread ${this.thread}`, 'dim', this.app.board.manager ? (this.app.board.manager.up ? 'up' : 'down') : ''));
    // The composer: up to a third of the screen.
    const inputW = Math.max(10, width - 3);
    const L = this.composer.layout(inputW);
    const maxIn = Math.max(1, Math.min(8, Math.floor(height / 3)));
    const inTop = Math.max(0, Math.min(L.rows.length - maxIn, L.cursorRow - maxIn + 1));
    const inRows = L.rows.slice(inTop, inTop + maxIn);
    const lookRow = this.look ? [[[' + ', 'accent'], [`${this.look.label}, ${this.look.lines} lines attached  (Ctrl-C drops it)`, 'dim']]] : [];
    const chatH = Math.max(1, height - out.length - inRows.length - 1 - lookRow.length);
    // The conversation (bounded while the owner reads the bottom of it; scrolled up, what they read stays).
    if (this.follow) this.convo.prune();
    const items = chatItems(this.convo.chatTurns());
    const pending = this.convo.turns.find((t) => t.role === 'assistant' && t.pending && !t.text);
    const footer = [];
    if (pending) footer.push([], [[' ', null], [' ● ', 'mgr'], [pending.waiting === 'blocking' ? 'waiting for the reply (this daemon answers when the manager is done)' : 'the manager is thinking…', 'dim']]);
    if (this.error) footer.push([[' ', null], [`could not read the conversation: ${this.error}`, 'err']]);
    if (!items.length && !pending) footer.push([[' ', null], [this.loading ? 'reading the conversation…' : 'Ask the manager anything: who is waiting on me, what is devbox doing, start an agent on…', 'dim']]);
    const { rows } = chatRows(items, width, { names: { you: 'you', assistant: 'manager' }, footer });
    const total = rows.length;
    const max = Math.max(0, total - chatH);
    if (this.follow) this.top = max; else this.top = Math.min(this.top, max);
    out.push(...block(rows.slice(this.top, this.top + chatH), chatH));
    out.push(...lookRow);
    out.push(rule(width, '', this.focus === 'input' ? 'accent' : 'dim', this.top < max ? `${max - this.top} more below · End` : ''));
    inRows.forEach((r, i) => out.push([[i === 0 && inTop === 0 ? '› ' : '  ', this.focus === 'input' ? 'accent' : 'dim'], [r, null]]));
    if (!this.composer.value && this.focus === 'input') out[out.length - 1] = [['› ', 'accent'], ['message the manager · /help for commands', 'dim']];
    this.lastLayout = { chatH, total, inputW, inStart: out.length - inRows.length, inTop, L };
    return block(out, height);
  }
  cursor() {
    if (this.focus !== 'input' || !this.lastLayout) return null;
    const { inStart, inTop, L } = this.lastLayout;
    return { row: inStart + (L.cursorRow - inTop), col: 2 + L.cursorCol };
  }
}

export { COMMANDS };
