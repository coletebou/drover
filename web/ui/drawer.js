// The details drawer: one place to read a session, see its pane, talk to it,
// answer its dialog, press keys, pin it, note it. Opened by the board, Sessions and Tmux views.
// target = { kind: 'session'|'window', id, host, name?, tmux?, engine?, session?, window?, tab?, focusComposer? }
//
// Chat follows the shared rendering rule (chat-model.js, chat.js): tool calls grouped with their results,
// Markdown replies, one copy of every turn (a local echo gives way to the server's), a working line while the
// session works. Live turns arrive as `turn` events; the transcript is read again only as a fallback (every 3 s
// for a session no event covers, every 15 s for a followed one). When the session shows a dialog, an answer
// card sits above the composer in Chat and Screen, and the composer's key row is that dialog's keys. One click on
// an option presses it; the card then follows the screen (the next question, a review screen, or nothing).
//
// The composer takes pasted or dropped files (uploaded to the session's host,
// the message names their absolute paths), push-to-talk dictation (on-device
// recognition when Chrome has it; cloud only when allowed in Settings), and the
// usual history / nudges / keys. The head has copy, pop-out, mute and share.
import { h, clear, btn, engine, dot, ago, kv, fmtTime, shortPath, loading, empty, seg, plural } from './dom.js';
import { tmuxWindowTarget, isWindow } from './transcript.js';
import { copyButton, copyText, saveText, canShare, share, fileToBase64 } from './clip.js';
import { openMenu } from './menu.js';
import * as dictation from './dictation.js';
import { ChatView, atBottom } from './chat.js';
import { chatItems, mergeTurns, rebase, withReceipts, lastUnreadReply } from './chat-model.js';
import { answerCard } from './answer.js';
import { answerModel, readScreen, screenHash } from './answer-model.js';
import { owner } from './owner.js';

// Outside a dialog the key row is the keys that move a session along; a dialog brings its own (answer card).
const KEYS = [['Enter', 'Enter'], ['Escape', 'Esc'], ['C-c', '^C'], ['Up', '↑'], ['Down', '↓']];
const NUDGES = ['continue', 'status?', 'go ahead', 'yes'];
const WIDTH_KEY = 'drover.drawer.w';
const HISTORY_KEY = 'drover.composer.history';
const META_KEY = 'drover.chat.meta';
const MAX_UPLOAD = 20 * 1024 * 1024;
const POLL_TICK_MS = 3000;        // the poll timer; whether a tick reads depends on the session
const FOLLOWED_POLL_MS = 15_000;  // once turn events arrive for a session, a read is only a safety net
const AFTER_PRESS_MS = 4000;      // how long after a press the answered dialog's screen counts as not moved on yet
const BOARD_LAG_MS = 20_000;      // how long after a press the board's strip is older than the pane

export class Drawer {
  constructor(el, stage, ctx) {
    this.el = el; this.stage = stage; this.ctx = ctx; this.target = null; this.tab = 'chat';
    this.turns = []; this.offset = 0; this.alive = false; this.timers = []; this.seq = 0;
    this.history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); this.histIdx = -1;
    this.attachments = []; this.dict = null;
    this.showMeta = localStorage.getItem(META_KEY) === '1';
    // following: the session id /api/follow was asked for (undone on close); pushed: its turn events are arriving.
    this.chat = null; this.following = null; this.pushed = false; this.lastTurnAt = 0; this.lastReadAt = 0; this.screenRead = null; this.pressedAt = 0; this.pressedHash = null;
    this.card = answerCard({
      call: (op, args, opts) => this.ctx.callQuiet(op, args, opts), toast: (m, k, ms) => this.ctx.toast(m, k, ms),
      approve: (id, n, opts) => this.ctx.answerApproval(id, n, opts),
      // After a press the card follows the screen: nothing until the pane shows what comes next.
      onDone: (_r, m) => { this.pressedAt = Date.now(); this.pressedHash = m?.hash ?? null; this.screenRead = null; this.#readDialogSoon(250); if (this.tab === 'screen') setTimeout(() => this.#poll(), 400); },
      onRefresh: () => this.#readDialogSoon(0),
    });
    const w = localStorage.getItem(WIDTH_KEY); if (w) document.documentElement.style.setProperty('--drawer', w);
    this.#resizer();
  }
  get isOpen() { return Boolean(this.target); }

  #resizer() {
    const r = h('div', { class: 'resizer', title: 'Drag to resize' });
    this.stage.append(r);
    let startX = 0, startW = 0;
    const move = (e) => { const w = Math.max(360, Math.min(window.innerWidth - 320, startW + (startX - e.clientX))); document.documentElement.style.setProperty('--drawer', w + 'px'); };
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); localStorage.setItem(WIDTH_KEY, document.documentElement.style.getPropertyValue('--drawer')); };
    r.addEventListener('mousedown', (e) => { startX = e.clientX; startW = this.el.getBoundingClientRect().width; document.addEventListener('mousemove', move); document.addEventListener('mouseup', up); e.preventDefault(); });
    this.resizerEl = r;
    this.#placeResizer();
    window.addEventListener('resize', () => this.#placeResizer());
  }
  #placeResizer() { const w = this.el.getBoundingClientRect(); this.resizerEl.style.left = (w.left - 3) + 'px'; this.resizerEl.hidden = !this.isOpen; }

  async open(target) {
    if (!target) return;
    const same = this.target && this.target.kind === target.kind && this.target.id === target.id && (this.target.host ?? 'local') === (target.host ?? 'local');
    this.#stopTimers();
    if (this.following && !same) { this.ctx.follow(this.following, false).catch(() => {}); this.following = null; }
    if (!same) { this.dict?.abort(); this.dict = null; this.attachments = []; this.mode = undefined; this.pendingForce = null; this.pushed = false; this.pressedHash = null; }
    this.target = { host: this.ctx.host(), ...target };
    this.alive = true;
    if (!same) {
      this.turns = []; this.offset = 0; this.chat = null; this.lastTurnAt = 0; this.lastReadAt = 0; this.screenRead = null; this.card.set(null);
      this.tab = target.tab ?? (target.kind === 'window' && !target.session && !target.sessionId ? 'screen' : 'chat');
    } else if (target.tab) this.tab = target.tab;
    this.stage.classList.add('drawer-open');
    requestAnimationFrame(() => this.#placeResizer());
    this.#render();
    if (target.focusComposer) setTimeout(() => this.focusComposer(), 50);
    await this.#load();
    document.dispatchEvent(new CustomEvent('drover:drawer', { detail: this.target }));
  }
  close() {
    if (!this.target) return;
    if (this.ctx.solo) { window.close(); return; }
    if (this.following) this.ctx.follow(this.following, false).catch(() => {});
    this.dict?.abort(); this.dict = null;
    this.#stopTimers(); this.alive = false; this.target = null; this.following = null; this.pushed = false; this.chat = null; this.card.set(null);
    this.stage.classList.remove('drawer-open'); clear(this.el); this.#placeResizer();
    document.dispatchEvent(new CustomEvent('drover:drawer', { detail: null }));
  }
  focusComposer() { this.ta?.focus(); }
  #stopTimers() { for (const t of this.timers) clearInterval(t); this.timers = []; clearTimeout(this.dialogTimer); }
  #startPoll() { this.#stopTimers(); this.timers.push(setInterval(() => { if (this.alive) this.#poll(); }, this.tab === 'screen' ? 2000 : POLL_TICK_MS)); }
  #call(op, args) { return this.ctx.call(op, { ...args }, { host: this.target.host }); }
  #quiet(op, args) { return this.ctx.callQuiet(op, { ...args }, { host: this.target.host }); }

  // ------------------------------------------------------------ data
  async #load() {
    const t = this.target;
    try {
      if (t.kind === 'session') {
        const s = await this.#quiet('sessions.get', { id: t.id });
        if (!this.alive) return;
        if (s) Object.assign(t, { session: s, engine: s.engine ?? t.engine, name: s.name ?? t.name, tmux: s.tmux ?? t.tmux, status: s.status, cwd: s.cwd });
      } else if (t.kind === 'window') {
        const wins = await this.#quiet('tmux.windows', { classify: false });
        if (!this.alive) return;
        const w = wins.find((x) => isWindow(x, t.id));
        if (w) { t.window = w; t.name = t.name ?? w.name; t.tmux = w.target; if (w.agent?.sessionId && !t.session) { t.engine = w.agent.engine; t.sessionId = w.agent.sessionId; } }
      }
    } catch { /* header shows what we have */ }
    if (!this.alive) return;
    this.#render();
    this.#loadTab();
    this.#startPoll();
    this.#readDialogSoon(0);
  }
  sessionIdForChat() { const t = this.target; return t.kind === 'session' ? t.id : (t.sessionId ?? t.session?.sessionId ?? null); }
  windowTarget() { const t = this.target; return t.kind === 'window' ? t.id : tmuxWindowTarget(t.tmux); }
  hostLabel() { const host = this.target?.host ?? 'local'; return host === 'local' ? (this.ctx.state.frontHost ?? 'local') : host; }
  /** The board's strip for this target (lane, status, dialog, hash, keys), when the board has one. */
  strip() { return this.target ? this.ctx.stripFor?.(this.target) ?? null : null; }
  /** The head's status: the board's lane when the board has this session (it is the freshest), else the session's own. */
  statusLabel() {
    const s = this.strip(); const t = this.target ?? {};
    // Just answered here, and this drawer's own read shows no dialog any more: the board's "waiting" is behind.
    const r = this.screenRead;
    if (s?.lane === 'wait' && Date.now() - this.pressedAt < BOARD_LAG_MS && r && r.at >= this.pressedAt && !r.dialog) return 'idle';
    if (s) return s.lane === 'wait' ? 'waiting' : s.lane === 'work' ? 'busy' : s.status && s.status !== 'busy' ? s.status : 'idle';
    return t.session?.status ?? t.window?.agent?.status ?? t.window?.screen?.state ?? null;
  }
  isWorking() {
    const s = this.strip();
    if (s) return s.lane === 'work';
    const st = this.target?.session?.status ?? this.target?.window?.agent?.status;
    return st === 'busy' || this.screenState === 'busy' || (this.target?.engine === 'codex' && /active|running/i.test(st ?? ''));
  }

  async #loadTab() {
    const body = this.el.querySelector('.drawer-body'); if (!body) return;
    if (this.tab === 'chat') await this.#loadChat(body);
    else if (this.tab === 'screen') await this.#loadScreen(body);
    else this.#renderInfo(body);
  }
  async #poll() {
    if (this.tab === 'chat') {
      // While a dialog is (or may be) up, or just after a press (the next question may follow), the card's reading
      // stays a few seconds fresh.
      if ((this.card.model || this.strip()?.lane === 'wait' || Date.now() - this.pressedAt < BOARD_LAG_MS) && Date.now() - (this.screenRead?.at ?? 0) > 4000) this.#readDialogSoon(0);
      // Live turns come as events; read only when none covers this session, or now and then as a safety net.
      const every = this.pushed ? FOLLOWED_POLL_MS : POLL_TICK_MS;
      if (Date.now() - Math.max(this.lastTurnAt, this.lastReadAt) < every - 250) return;
      await this.#loadChat(this.el.querySelector('.drawer-body'), { incremental: true });
    } else if (this.tab === 'screen') await this.#loadScreen(this.el.querySelector('.drawer-body'), { quiet: true });
  }
  async #loadChat(body, { incremental = false } = {}) {
    const sid = this.sessionIdForChat();
    if (!body) return;
    if (!sid) { clear(body); body.append(empty('No agent session in this window', 'Use the Screen tab to read and type into the pane.')); return; }
    if (!incremental && !this.turns.length) { clear(body); body.append(loading('Reading transcript')); }
    else if (!incremental && !this.chat) this.#renderChat(body, null);   // back on Chat: what is known shows at once, the read lines it up
    this.lastReadAt = Date.now();
    try {
      const t0 = performance.now();
      // A Grok bot's replies are read once they are on screen here (read receipts): only while this page is visible.
      const seen = this.target.engine === 'grok' && document.visibilityState === 'visible' ? { seenBy: 'owner' } : {};
      const r = await this.#quiet('sessions.transcript', { id: sid, since: incremental ? this.offset : 0, limit: 300, ...seen });
      if (!this.alive || this.tab !== 'chat' || this.sessionIdForChat() !== sid) return;
      // The front daemon pushes turns only for a local interactive Claude session; a headless, Codex or remote one is
      // read every 3 s, and so is a followed one until its first turn event shows the push works.
      const sess = this.target.session;
      if (!incremental && !this.following && this.target.engine === 'claude' && (this.target.host ?? 'local') === 'local' && !sess?.headless && sess?.kind !== 'headless') { this.following = sid; this.ctx.follow(sid, true).catch(() => { this.following = null; }); }
      const turns = r.turns ?? [];
      // Codex rollouts answer offset 0 every time: a read is the whole tail again, so it lines up like a full read.
      this.turns = withReceipts(!incremental || !r.offset ? rebase(this.turns, turns) : mergeTurns(this.turns, turns), r.receipts);
      if (r.offset !== undefined) this.offset = r.offset;
      // Replies read in while the page was hidden were not marked; now that it shows them, they are read.
      if (seen.seenBy) this.#markShown(sid);
      if (!incremental || !this.chat || !body.querySelector('.turns')) this.#renderChat(body, r.summary);
      else this.#updateChat();
      this.ctx.perf?.('drawer.read', performance.now() - t0);
    } catch (e) { if (!incremental) { clear(body); body.append(empty('Could not read the transcript', e.message)); } }
  }
  /** Mark a bot's thread read up to the last reply shown that the owner has not read (sessions.seen), once per reply. */
  #markShown(sid) {
    const upTo = lastUnreadReply(this.turns);
    if (!upTo || this.markedUpTo === upTo) return;
    this.markedUpTo = upTo;
    this.#quiet('sessions.seen', { id: sid, upTo }).catch(() => { this.markedUpTo = null; });
  }
  #renderChat(body, summary) {
    // A chat already on screen (shown from what was known while the read ran) keeps its open groups: only the
    // first-prompt line is added.
    if (this.chat && body.contains(this.chat.el)) {
      if (summary?.firstPrompt && !body.querySelector('.first-prompt')) body.insertBefore(h('p', { class: 'muted small first-prompt' }, h('span', { class: 'em' }, 'First prompt: '), summary.firstPrompt.slice(0, 400)), this.chat.el);
      this.#updateChat();
      return;
    }
    clear(body);
    const sid = this.sessionIdForChat();
    const bar = h('div', { class: 'toolbar chat-tools' },
      h('span', { class: 'muted small chat-count' }), h('span', { class: 'spacer' }),
      h('label', { class: 'check small', title: 'Show the turns Claude Code adds for itself: hook output, reminders, queue operations' }, h('input', { type: 'checkbox', checked: this.showMeta ? true : null, onchange: (e) => { this.showMeta = e.target.checked; localStorage.setItem(META_KEY, this.showMeta ? '1' : '0'); this.#updateChat(); } }), 'system turns'),
      copyButton(() => transcriptMarkdown(this.target, this.turns, { last: 1 }), 'Copy last reply', { title: 'Copy the last assistant reply' }),
      copyButton(() => transcriptMarkdown(this.target, this.turns), 'Copy all', { title: 'Copy the transcript as Markdown' }),
      btn('Save', (e) => openMenu(e.currentTarget, [
        { label: 'Markdown (.md)', run: () => this.#export('md') },
        { label: 'JSON (.json)', run: () => this.#export('json') },
      ], { label: 'Save transcript' }), { cls: 'sm quiet', title: 'Save the transcript to a file on this computer' }),
      canShare({ text: 'x' }) ? btn('Share', () => share({ title: this.target.name ?? 'Drover session', text: transcriptMarkdown(this.target, this.turns, { last: 3 }) }).catch((e) => this.ctx.toast(e.message, 'error')), { cls: 'sm quiet', title: 'Share the last turns' }) : null);
    body.append(bar);
    // The last Notification-hook question for this session, when recent.
    const n = this.ctx.state.notifies?.[sid];
    if (n && Date.now() - Date.parse(n.ts) < 20 * 60_000) body.append(h('div', { class: 'notice' }, h('span', { class: 'em' }, `asked ${fmtTime(n.ts)}: `), n.message));
    if (summary?.firstPrompt) body.append(h('p', { class: 'muted small first-prompt' }, h('span', { class: 'em' }, 'First prompt: '), summary.firstPrompt.slice(0, 400)));
    // A Grok bot's replies carry its name, which its receipts use too ("queued in Dominus's inbox").
    this.chat = new ChatView({ assistantLabel: this.target.engine === 'codex' ? 'codex' : this.target.engine === 'grok' ? (this.target.name ?? 'bot') : 'assistant', onRetry: (t) => this.send(t.text) });
    body.append(this.chat.el);
    this.#updateChat({ stick: true });
  }
  /** Re-render the chat from this.turns: only items that changed are rebuilt. */
  #updateChat({ stick } = {}) {
    const body = this.el.querySelector('.drawer-body');
    if (!this.chat || !body) return;
    const t0 = performance.now();
    const keep = stick ?? atBottom(body);
    const items = chatItems(this.turns.slice(-400), { showMeta: this.showMeta });
    const built = this.chat.update(items, { working: this.isWorking(), workingText: 'working', empty: empty('No turns yet') });
    const c = body.querySelector('.chat-count'); if (c) c.textContent = `${plural(items.length, 'item')}, ${plural(this.turns.length, 'turn')}`;
    if (keep) body.scrollTop = body.scrollHeight;
    this.ctx.perf?.('drawer.render', performance.now() - t0, built);
  }
  async #export(fmt) {
    const base = `${(this.target.name ?? this.sessionIdForChat() ?? 'session').replace(/[^A-Za-z0-9_.-]+/g, '-')}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}`;
    // Pull the whole transcript (not just what is rendered) for the export.
    let turns = this.turns;
    try { const r = await this.#quiet('sessions.transcript', { id: this.sessionIdForChat(), since: 0, limit: 100000 }); if (r?.turns?.length) turns = r.turns; } catch { /* use what we have */ }
    const out = fmt === 'json' ? JSON.stringify({ session: { id: this.sessionIdForChat(), name: this.target.name, host: this.hostLabel(), cwd: this.target.cwd ?? this.target.session?.cwd ?? null, engine: this.target.engine }, exportedAt: new Date().toISOString(), turns }, null, 2)
      : transcriptMarkdown(this.target, turns, { host: this.hostLabel() });
    const r = await saveText(`${base}.${fmt}`, out, fmt === 'json' ? 'application/json' : 'text/markdown');
    if (r !== 'cancelled') this.ctx.toast(r === 'saved' ? `Saved ${turns.length} turns` : `Downloaded ${base}.${fmt}`, 'ok');
  }
  async #loadScreen(body, { quiet = false } = {}) {
    const target = this.windowTarget();
    if (!body) return;
    if (!target) { clear(body); body.append(empty('No tmux window for this session', 'Headless sessions have no pane.')); return; }
    const at = Date.now();
    try {
      const r = await this.#quiet('tmux.capture', { target, lines: this.screenLines ?? 200 });
      if (!this.alive || this.tab !== 'screen' || this.windowTarget() !== target) return;
      let pre = body.querySelector('.screen');
      const atEnd = !pre || pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
      if (!pre) {
        clear(body);
        const head = h('div', { class: 'toolbar' },
          h('span', { class: 'mark', id: 'scr-state' }, dot(r.screen?.state), r.screen?.state ?? 'unknown', h('span', { class: 'muted small' }, r.screen?.reason ? ` · ${r.screen.reason}` : '')),
          h('span', { class: 'spacer' }),
          copyButton(() => body.querySelector('.screen')?.textContent ?? '', 'Copy pane', { title: 'Copy the captured pane text' }),
          seg([[100, '100'], [200, '200'], [600, '600'], [2000, '2000']], this.screenLines ?? 200, (v) => { this.screenLines = v; this.#loadScreen(body); }),
          h('span', { class: 'muted small', id: 'scr-ts' }, fmtTime(Date.now())));
        pre = h('pre', { class: 'screen tall' });
        body.append(head, pre);
      }
      // A capture repeats every 2 s: the pane text is swapped only when it changed, so selection and scroll stay put.
      if (pre.textContent !== r.text) pre.textContent = r.text;
      const st = body.querySelector('#scr-state'); if (st) { clear(st); st.append(dot(r.screen?.state), r.screen?.state ?? 'unknown', h('span', { class: 'muted small' }, r.screen?.reason ? ` · ${r.screen.reason}` : '')); }
      const ts = body.querySelector('#scr-ts'); if (ts) ts.textContent = fmtTime(Date.now());
      this.screenState = r.screen?.state;
      if (atEnd) pre.scrollTop = pre.scrollHeight;
      this.#takeScreen(r.text, at);
    } catch (e) { if (!quiet) { clear(body); body.append(empty('Could not capture the pane', e.message)); } }
  }

  // ------------------------------------------------------------ the answer card
  /** A screen read (the Screen tab, or a read for the card): the freshest word on what the dialog is. */
  async #takeScreen(text, startedAt = Date.now()) {
    if (startedAt < this.pressedAt) return;   // read before the last press landed: it shows the dialog that was answered
    const d = readScreen(text);
    const hash = d ? await screenHash(text) : null;
    if (!this.alive) return;
    // The pane has not moved since the press yet: that is the dialog just answered, not one to answer again. Read
    // again shortly; after a few seconds an unchanged screen is shown (the key may not have registered).
    if (d && hash && hash === this.pressedHash && Date.now() - this.pressedAt < AFTER_PRESS_MS) { if (this.tab !== 'screen') this.#readDialogSoon(350); return; }
    this.screenRead = { at: Date.now(), dialog: d, hash, text };
    this.#paintCard();
    const st = this.statusLabel(); if (st) this.#paintStatus(st);
  }
  /** Read the pane once for the card (the Chat tab has no capture of its own); a burst of triggers reads once. */
  #readDialogSoon(ms = 500) {
    clearTimeout(this.dialogTimer);
    const win = this.windowTarget();
    if (!win || this.tab === 'screen') { this.#paintCard(); return; }
    this.dialogTimer = setTimeout(async () => {
      const at = Date.now();
      try { const r = await this.#quiet('tmux.capture', { target: win, lines: 60 }); if (this.alive && this.windowTarget() === win) { this.screenState = r.screen?.state ?? this.screenState; await this.#takeScreen(r.text, at); } }
      catch { this.#paintCard(); }
    }, ms);
  }
  /** The card from the freshest reading: this drawer's own screen read when recent, else the board's strip. */
  #model() {
    const t = this.target; if (!t) return null;
    const s = this.strip();
    const win = this.windowTarget();
    const base = { kind: t.kind, id: t.kind === 'window' ? win : (this.sessionIdForChat() ?? t.id), tmux: win, host: t.host ?? 'local', sessionId: this.sessionIdForChat() };
    const r = this.screenRead;
    // The board lags the pane by up to a warm cycle: after a press only this drawer's own later reads say what is on
    // screen (the next question, a review screen, or nothing), never the board's copy of the dialog just answered.
    // A card from this drawer's own read is marked source "screen"; one from the board's strip is checked against the
    // pane before a press (answer-model.js pressKey verify).
    const fromRead = () => ({ ...answerModel({ ...base, screen: 'dialog', held: r.dialog.held, heldFrom: r.dialog.heldFrom, dialog: { question: r.dialog.question, options: r.dialog.options }, keys: r.dialog.keys, hash: r.hash }), source: 'screen' });
    if (Date.now() - this.pressedAt < BOARD_LAG_MS) return r && r.at >= this.pressedAt && r.dialog ? fromRead() : null;
    const boardNewer = s && r && s.hash && s.hash !== r.hash && Date.now() - r.at > 8000;
    if (r && Date.now() - r.at < 30_000 && !boardNewer) {
      if (!r.dialog) return s?.answer === 'reply' && s.lane === 'wait' ? answerModel(s) : null;
      return fromRead();
    }
    if (!s || s.lane !== 'wait') return null;
    return answerModel({ ...s, ...base, kind: t.kind });
  }
  #paintCard() {
    if (!this.target) return;
    const m = this.tab === 'info' ? null : this.#model();
    this.card.set(m);
    this.#renderKeys();
  }

  resumeCommand() {
    const t = this.target; const s = t.session ?? {};
    const sid = s.sessionId ?? t.sessionId ?? (t.kind === 'session' ? t.id : null);
    const cwd = s.cwd ?? t.cwd ?? t.window?.cwd;
    let cmd = null;
    if (t.engine === 'codex' && (s.threadId ?? sid)) cmd = `codex resume ${s.threadId ?? sid}`;
    else if (sid && (t.engine === 'claude' || !t.engine)) cmd = `claude --resume ${sid}`;
    if (!cmd) return null;
    if (cwd) cmd = `cd ${shq(cwd)} && ${cmd}`;
    return t.host && t.host !== 'local' ? `ssh -t ${t.host} ${shq(cmd)}` : cmd;
  }
  #renderInfo(body) {
    clear(body);
    const t = this.target; const s = t.session ?? {}; const w = t.window ?? {};
    const sid = s.sessionId ?? s.threadId ?? t.sessionId ?? '';
    const resume = this.resumeCommand();
    body.append(h('div', { class: 'toolbar' },
      sid ? copyButton(sid, 'Copy session id') : null,
      resume ? copyButton(resume, 'Copy resume command', { title: resume }) : null,
      (s.cwd ?? w.cwd) ? copyButton(s.cwd ?? w.cwd, 'Copy cwd') : null,
      this.windowTarget() ? copyButton(this.windowTarget(), 'Copy tmux target') : null));
    body.append(kv([
      ['engine', t.engine], ['name', t.name], ['status', s.status ?? w.agent?.status], ['host', this.hostLabel()], ['session id', h('code', null, sid)],
      ['tmux', h('code', null, t.tmux ?? w.target ?? '')], ['pid', s.pid ?? w.panePid], ['cwd', h('code', null, s.cwd ?? w.cwd ?? '')], ['started', s.startedAt ? fmtTime(s.startedAt) : null], ['version', s.version], ['model', s.model],
      ['resume', resume ? h('code', null, resume) : null],
      ['transcript', s.transcript ? h('code', null, s.transcript) : null], ['socket', s.socket ? h('code', null, s.socket) : null], ['kind', s.sessionKind ?? s.kind], ['command', w.cmd], ['panes', w.panes],
    ]));
    const notes = h('div', { style: { marginTop: '16px' } }, h('h3', null, 'Notes'), h('p', { class: 'muted small' }, 'Notes are kept in the truth file against this id.'));
    const ta = h('textarea', { rows: 3, placeholder: 'Write a note about this session' });
    notes.append(ta, h('div', { class: 'toolbar', style: { marginTop: '6px' } }, btn('Save note', async () => { if (!ta.value.trim()) return; await this.#call('events.append', { event: { type: 'note', about: this.sessionIdForChat() ?? t.id, text: ta.value.trim() } }); ta.value = ''; this.ctx.toast('Note saved', 'ok'); }, { cls: 'sm' })));
    body.append(notes);
    const up = h('div', { style: { marginTop: '16px' } }, h('h3', null, 'Uploaded files'), h('div', { class: 'muted small' }, 'Loading…'));
    body.append(up);
    const key = sid || this.windowTarget();
    if (key) this.#quiet('uploads.list', { session: key }).then((r) => {
      up.lastChild.remove();
      if (!r.items.length) { up.append(h('p', { class: 'muted small' }, 'Paste or drop files into the composer to send them to this session.')); return; }
      for (const f of r.items) up.append(h('div', { class: 'row static' }, h('span', { class: 'mono small' }, fmtBytes(f.bytes)), h('div', { class: 'main-col' }, h('div', { class: 'l1' }, h('span', { class: 'trunc' }, f.name)), h('div', { class: 'l2' }, f.path)), copyButton(f.path, 'Copy path')));
    }).catch(() => { up.lastChild.textContent = 'Could not list uploads.'; });
  }

  // ------------------------------------------------------------ actions
  async send(text) {
    const t = this.target; const sid = this.sessionIdForChat(); const win = this.windowTarget();
    if (this.attachments.some((a) => a.status === 'uploading')) { this.ctx.toast('Waiting for uploads to finish', 'info', 2000); await Promise.all(this.attachments.map((a) => a.promise).filter(Boolean)); }
    const ready = this.attachments.filter((a) => a.status === 'ready');
    if (!text.trim() && !ready.length) return;
    const full = ready.length ? `${text.trim()}${text.trim() ? '\n\n' : ''}Attached file${ready.length > 1 ? 's' : ''} on ${this.hostLabel()} (read ${ready.length > 1 ? 'them' : 'it'} with the Read tool):\n${ready.map((a) => `- ${a.path}`).join('\n')}` : text;
    const viaInbox = Boolean(sid) && (t.engine === 'claude' || t.engine === 'codex' || t.engine === 'headless' || t.engine === 'grok') && this.mode !== 'pane';
    let echo = null;
    try {
      if (viaInbox) {
        // The echo shows at once and gives way to the transcript's copy (chat-model.js mergeTurns).
        echo = { role: 'user', ts: new Date().toISOString(), text: full, local: true, localId: `local:${++this.seq}`, actor: owner() };
        this.turns = [...this.turns, echo]; this.#updateChat({ stick: true });
        const r = await this.#call('sessions.message', { id: sid, text: full });
        const mine = this.turns.find((x) => x.localId === echo.localId); if (mine && r?.event) mine.serverId = r.event;
        this.ctx.toast(r.queuedBehindTurn ? 'Queued; the session is busy and will take it after this turn' : `Delivered${r.via ? ' via ' + r.via : ''}`, 'ok');
        this.lastReadAt = 0;   // the next poll tick reads (an unfollowed session's copy arrives by reading)
      } else {
        if (!win) throw new Error('nothing to send to');
        const r = await this.#call('tmux.send', { target: win, text: full, enter: this.enter !== false });
        if (r.refused) { this.pendingForce = full; this.#renderComposer({ keep: text }); this.ctx.toast('Refused: a dialog is on screen. Answer it above, or Force if you mean it.', 'error', 7000); this.#readDialogSoon(0); return; }
        this.ctx.toast('Pasted into the pane', 'ok');
      }
      this.#pushHistory(text);
      this.pendingForce = null; this.attachments = []; this.#renderComposer({ keep: '' });
    } catch (e) {
      if (echo) { this.turns = this.turns.map((x) => (x.localId === echo.localId ? { ...x, failed: e.message } : x)); this.#updateChat(); }
      this.#renderComposer({ keep: text }); /* ctx.call toasted */
    }
  }
  async force() {
    const text = this.pendingForce; if (!text) return;
    const win = this.windowTarget();
    try { await this.#call('tmux.send', { target: win, text, enter: this.enter !== false, force: true }); this.pendingForce = null; this.attachments = []; this.#renderComposer({ keep: '' }); this.ctx.toast('Forced into the pane', 'ok'); } catch { /* toasted */ }
  }
  async keys(k) { const win = this.windowTarget(); if (!win) return; try { await this.#call('tmux.keys', { target: win, keys: [k] }); if (this.tab === 'screen') setTimeout(() => this.#poll(), 350); else this.#readDialogSoon(400); } catch { /* toasted */ } }
  #pushHistory(text) { if (!text.trim()) return; this.history = [text, ...this.history.filter((x) => x !== text)].slice(0, 50); localStorage.setItem(HISTORY_KEY, JSON.stringify(this.history)); this.histIdx = -1; }

  // ------------------------------------------------------------ attachments
  /** Upload files (pasted, dropped or picked) to the session's host inbox. */
  async attach(files) {
    const key = this.sessionIdForChat() ?? this.windowTarget();
    if (!key) { this.ctx.toast('Nothing to attach to', 'error'); return; }
    for (const f of [...files]) {
      if (f.size > MAX_UPLOAD) { this.ctx.toast(`${f.name || 'file'} is ${fmtBytes(f.size)}; the cap is 20 MB`, 'error'); continue; }
      const a = { name: f.name || `pasted${extFor(f.type)}`, bytes: f.size, mime: f.type || null, status: 'uploading', path: null };
      a.promise = (async () => {
        try {
          const data = await fileToBase64(f);
          const r = await this.ctx.call('uploads.put', { session: key, name: a.name, mime: a.mime, data }, { host: this.target.host });
          Object.assign(a, { status: 'ready', path: r.path, bytes: r.bytes });
        } catch (e) { Object.assign(a, { status: 'error', error: e.message }); }
        this.#renderChips();
      })();
      this.attachments.push(a);
    }
    this.#renderChips();
  }
  #renderChips() {
    const box = this.el.querySelector('.attachments'); if (!box) return;
    clear(box); box.hidden = !this.attachments.length;
    for (const a of this.attachments) {
      box.append(h('span', { class: `att ${a.status}`, title: a.path ?? a.error ?? a.name },
        h('span', { class: 'att-name' }, a.name), h('span', { class: 'att-meta' }, a.status === 'uploading' ? 'uploading…' : a.status === 'error' ? `failed: ${a.error}` : fmtBytes(a.bytes)),
        a.path ? h('button', { type: 'button', class: 'att-x', 'aria-label': `Copy path of ${a.name}`, title: 'Copy the path', onclick: () => copyText(a.path).then(() => this.ctx.toast('Path copied', 'ok', 1500)) }, 'path') : null,
        h('button', { type: 'button', class: 'att-x', 'aria-label': `Remove ${a.name}`, title: 'Do not attach (the uploaded file stays in the inbox)', onclick: () => { this.attachments = this.attachments.filter((x) => x !== a); this.#renderChips(); } }, '×')));
    }
  }

  // ------------------------------------------------------------ dictation
  async dictateStart({ hold = false } = {}) {
    if (this.dict) return;
    if (!this.ta) return;
    const st = this.ctx.notifier?.settings?.dictation ?? {};
    const ta = this.ta; const base = ta.value; const sep = base && !/\s$/.test(base) ? ' ' : '';
    this.dictHold = hold;
    try {
      this.dict = await dictation.start({
        lang: st.lang || 'en-US', allowCloud: Boolean(st.allowCloud),
        onText: (fin, interim) => { ta.value = base + sep + fin + (interim ? (fin ? ' ' : '') + interim : ''); ta.dispatchEvent(new Event('input')); },
        onEnd: (fin) => {
          this.dict = null; this.#drawMic();
          ta.value = base + (fin ? sep + fin : ''); ta.focus();
          if (fin && st.autoSend && this.dictHold) { const v = ta.value; ta.value = ''; this.send(v); }
        },
        onError: (m) => this.ctx.toast(m, 'error', 6000),
        onState: () => this.#drawMic(),
      });
      this.#drawMic();
    } catch (e) { this.dict = null; this.#drawMic(); this.ctx.toast(e.message, 'error', 7000); }
  }
  dictateStop() { this.dict?.stop(); }
  #drawMic() {
    const b = this.el.querySelector('.mic'); if (!b) return;
    const on = Boolean(this.dict);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.classList.toggle('live', on);
    b.firstChild.textContent = on ? `Listening${this.dict?.engine === 'cloud' ? ' (cloud)' : ''}` : 'Dictate';
  }

  // ------------------------------------------------------------ mute / pop-out
  #muteMenu(anchor) {
    const t = this.target; const host = this.hostLabel(); const tmuxSession = (this.windowTarget() ?? '').split(':')[0] || null;
    const mute = (scope, target, minutes, hostScoped = true) => this.ctx.callQuiet('notify.mute', { scope, target, ...(minutes ? { minutes } : {}), ...(hostScoped && scope !== 'host' ? { host } : {}), label: `${scope} ${target}${scope !== 'host' ? ' on ' + host : ''}` }, { host: 'local' })
      .then((r) => { this.ctx.notifier?.onSettings(r); this.ctx.toast(`Muted ${scope} ${target}${minutes ? ` for ${minutes >= 60 ? minutes / 60 + ' h' : minutes + ' min'}` : ' until unmuted'}`, 'ok'); }).catch((e) => this.ctx.toast(e.message, 'error'));
    const name = t.name ?? this.sessionIdForChat();
    const muted = (this.ctx.notifier?.meta?.activeMutes ?? this.ctx.notifier?.settings?.mutes ?? []).filter((m) => (m.scope === 'session' && (m.target === name || m.target === this.sessionIdForChat())) || (m.scope === 'host' && m.target === host) || (m.scope === 'tmux' && m.target === tmuxSession));
    openMenu(anchor, [
      ...muted.map((m) => ({ label: `Unmute ${m.scope} ${m.target}`, hint: m.until ? `until ${fmtTime(m.until)}` : 'until unmuted', run: () => this.ctx.callQuiet('notify.unmute', { id: m.id }, { host: 'local' }).then((r) => { this.ctx.notifier?.onSettings(r); this.ctx.toast('Unmuted', 'ok'); }) })),
      muted.length ? { sep: true } : null,
      name ? { label: `This session for 1 hour`, hint: name, run: () => mute('session', name, 60) } : null,
      name ? { label: 'This session until unmuted', run: () => mute('session', name) } : null,
      tmuxSession ? { label: `tmux session ${tmuxSession} for 1 hour`, run: () => mute('tmux', tmuxSession, 60) } : null,
      { label: `Host ${host} for 1 hour`, run: () => mute('host', host, 60, false) },
      { label: `Host ${host} until unmuted`, run: () => mute('host', host, null, false) },
    ], { label: 'Mute alerts' });
  }
  popOut() {
    const t = this.target; if (!t) return;
    const url = `/#/pop/${encodeURIComponent(t.kind)}/${encodeURIComponent(t.host ?? 'local')}/${encodeURIComponent(t.id)}/${encodeURIComponent(t.engine ?? '')}/${encodeURIComponent(t.name ?? '')}`;
    const w = window.open(url, `drover-pop-${t.host}-${t.id}`.replace(/[^A-Za-z0-9_-]/g, '_'), 'popup,width=760,height=900');
    if (!w) this.ctx.toast('The browser blocked the pop-out window', 'error'); else if (!this.ctx.solo) this.close();
  }

  // ------------------------------------------------------------ render
  #render() {
    const t = this.target; if (!t) return;
    const keep = this.ta?.value ?? '';
    clear(this.el);
    const s = t.session ?? {}; const w = t.window ?? {};
    const status = this.statusLabel();
    const sub = [this.hostLabel() !== this.ctx.state.frontHost ? this.hostLabel() : null, t.tmux ?? w.target, shortPath(s.cwd ?? w.cwd, 60), s.sessionId ? s.sessionId.slice(0, 8) : null].filter(Boolean).join('   ');
    const sid = s.sessionId ?? s.threadId ?? t.sessionId ?? (t.kind === 'session' ? t.id : null);
    const head = h('div', { class: 'drawer-head' },
      h('div', { class: 'title' }, t.engine ? engine(t.engine) : null, h('h2', null, t.name ?? t.id), h('span', { class: 'mark' }, status ? [dot(status, { pulse: status === 'busy' }), status] : null), s.startedAt ? h('span', { class: 'muted small' }, 'since ', ago(s.startedAt)) : null),
      h('div', { class: 'actions' },
        sid ? copyButton(sid, 'Copy id', { title: `Copy the session id ${sid}` }) : null,
        this.windowTarget() ? btn('Terminal', () => this.#openTerminal(), { cls: 'sm quiet', title: 'Open a real terminal attached to this window' }) : null,
        btn('Mute', (e) => this.#muteMenu(e.currentTarget), { cls: 'sm quiet', title: 'Mute alerts from this session, its tmux session or its host' }),
        !this.ctx.solo ? btn('Pop out', () => this.popOut(), { cls: 'sm quiet', title: 'Open this drawer in its own window (p)' }) : null,
        btn('Pin', () => this.#call('events.append', { event: { type: 'pin', target: this.sessionIdForChat() ?? t.id } }).then(() => this.ctx.toast('Pinned', 'ok')), { cls: 'sm quiet' }),
        btn(this.ctx.solo ? 'Close window' : 'Close', () => this.close(), { cls: 'sm quiet', key: 'esc' })),
      h('div', { class: 'sub' }, sub));
    const tabs = h('div', { class: 'drawer-tabs' },
      ...[['chat', 'Chat'], ['screen', 'Screen'], ['info', 'Info']].map(([id, label]) => h('button', { class: 'tab', type: 'button', 'aria-current': this.tab === id ? 'page' : null, onclick: () => { if (this.tab === id) return; this.tab = id; this.chat = null; this.#render(); this.#loadTab(); this.#startPoll(); this.#paintCard(); } }, label)));
    const body = h('div', { class: 'drawer-body' });
    const foot = h('div', { class: 'drawer-foot' });
    this.card.el.remove();
    this.el.append(head, tabs, body, this.card.el, foot);
    this.#renderComposer({ keep });
  }
  /** The head's status mark, from the session record, the strip or the screen. */
  #paintStatus(status) {
    const m = this.el.querySelector('.drawer-head .mark'); if (!m) return;
    clear(m); if (status) m.append(dot(status, { pulse: status === 'busy' }), status);
  }
  #renderKeys() {
    const box = this.el.querySelector('.composer .keys'); if (!box) return;
    clear(box);
    const m = this.card.model;
    if (m?.mode === 'keys' && !m.stale) {
      box.classList.add('dialog');
      box.append(h('span', { class: 'keys-label' }, 'dialog'), ...m.buttons.map((b) => btn(b.kind === 'option' ? String(b.n) : b.label, () => this.card.press(b.key), { cls: `sm${b.selected ? ' selected' : ''}`, title: `${b.kind === 'option' ? b.label : `Press ${b.key}`} (only on the dialog shown above)` })));
      return;
    }
    box.classList.remove('dialog');
    box.append(...KEYS.map(([k, label]) => btn(label, () => this.keys(k), { cls: 'sm', title: `send ${k} to the pane` })));
  }
  #renderComposer({ keep } = {}) {
    const foot = this.el.querySelector('.drawer-foot'); if (!foot) return;
    const prior = keep ?? this.ta?.value ?? '';
    clear(foot);
    const t = this.target; const sid = this.sessionIdForChat(); const win = this.windowTarget();
    const canInbox = Boolean(sid) && ['claude', 'codex', 'headless', 'grok'].includes(t.engine);
    if (!canInbox && !win) { this.ta = null; foot.append(h('div', { class: 'muted small' }, 'Nothing to send to.')); return; }
    if (this.mode === undefined) this.mode = canInbox ? 'inbox' : 'pane';
    if (!canInbox) this.mode = 'pane';
    const ta = h('textarea', { placeholder: this.mode === 'inbox' ? `Message ${t.name ?? 'this session'}. Enter sends, Shift+Enter for a new line, ↑ for history. Paste or drop files to attach.` : `Text to paste into ${win}. Enter sends.`, rows: 2, 'aria-label': 'Message' });
    ta.value = prior;
    this.ta = ta;
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); const v = ta.value; ta.value = ''; this.send(v); }
      else if (e.key === 'ArrowUp' && !ta.value) { this.histIdx = Math.min(this.history.length - 1, this.histIdx + 1); ta.value = this.history[this.histIdx] ?? ''; }
      else if (e.key === 'ArrowDown' && this.histIdx >= 0) { this.histIdx = Math.max(-1, this.histIdx - 1); ta.value = this.history[this.histIdx] ?? ''; }
      else if (e.key === 'Escape') { ta.blur(); }
    });
    // Files: paste (screenshots arrive as files) and drag and drop.
    ta.addEventListener('paste', (e) => { const files = [...(e.clipboardData?.files ?? [])]; if (files.length) { e.preventDefault(); this.attach(files); } });
    const composer = h('div', { class: 'composer' });
    composer.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types ?? [])].includes('Files')) { e.preventDefault(); composer.classList.add('dropping'); } });
    composer.addEventListener('dragleave', (e) => { if (!composer.contains(e.relatedTarget)) composer.classList.remove('dropping'); });
    composer.addEventListener('drop', (e) => { composer.classList.remove('dropping'); const files = [...(e.dataTransfer?.files ?? [])]; if (files.length) { e.preventDefault(); this.attach(files); } });
    const picker = h('input', { type: 'file', multiple: true, hidden: true, onchange: () => { if (picker.files?.length) this.attach(picker.files); picker.value = ''; } });
    const bar = h('div', { class: 'bar' });
    if (canInbox && win) bar.append(seg([['inbox', 'to session'], ['pane', 'to pane']], this.mode, (v) => { this.mode = v; this.#renderComposer(); }));
    if (this.mode === 'pane') bar.append(h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: this.enter !== false ? true : null, onchange: (e) => { this.enter = e.target.checked; } }), 'press Enter'));
    if (win) bar.append(h('span', { class: 'keys', role: 'group', 'aria-label': 'Keys' }));
    bar.append(h('span', { class: 'spacer' }));
    for (const n of NUDGES) bar.append(btn(n, () => this.send(n), { cls: 'sm quiet', title: `send "${n}"` }));
    bar.append(btn('Attach', () => picker.click(), { cls: 'sm quiet', title: 'Attach files (or paste / drop them into the box)' }));
    if (dictation.supported()) {
      const mic = btn('Dictate', () => { if (this.dict) this.dictateStop(); else this.dictateStart(); }, { cls: 'sm quiet mic', title: 'Dictate into the message (hold Option+Space to talk)' });
      mic.setAttribute('aria-pressed', 'false');
      bar.append(mic);
    }
    if (this.pendingForce) bar.append(btn('Force', () => this.force(), { cls: 'sm danger', title: 'A dialog was on screen. Send anyway.' }));
    bar.append(btn('Send', () => { const v = ta.value; ta.value = ''; this.send(v); }, { cls: 'sm primary' }));
    composer.append(h('div', { class: 'attachments', hidden: true, 'aria-label': 'Attachments' }), ta, bar, picker);
    foot.append(composer);
    this.#renderChips(); this.#drawMic(); this.#renderKeys();
  }
  async #openTerminal() {
    const win = this.windowTarget(); if (!win) return;
    try { const r = await this.#call('terminals.open', { target: win }); this.ctx.toast(`Terminal on ${r.url}`, 'ok'); window.open(r.url, '_blank', 'noopener'); } catch { /* toasted */ }
  }

  // ------------------------------------------------------------ live updates
  /** After a dropped stream: read the whole conversation again (events may be missing). */
  resync() { if (this.target && this.tab === 'chat') this.#loadChat(this.el.querySelector('.drawer-body')); }
  sse(type, data) {
    if (!this.target) return;
    if (type === 'turn' && data?.id && data.id !== 'manager' && data.id === this.sessionIdForChat() && (this.target.host ?? 'local') === 'local') {
      this.lastTurnAt = Date.now(); this.pushed = true;
      if (this.tab !== 'chat' || !data.turn) return;
      this.turns = mergeTurns(this.turns, [data.turn]);
      this.#updateChat();
      return;
    }
    if (type === 'board' || type === 'fleet' || (type === 'snapshot' && this.target.host === 'local')) {
      const s = this.strip();
      // The head's mark and the working line follow the board; a board that now says "waiting" reads the pane.
      const sess = type === 'snapshot' ? data?.sessions?.find((x) => x.id === this.sessionIdForChat() || x.sessionId === this.sessionIdForChat()) : null;
      if (sess && this.target.session && sess.status !== this.target.session.status) this.target.session.status = sess.status;
      const status = this.statusLabel();
      if (status) this.#paintStatus(status);
      const sig = s ? `${s.lane}|${s.hash ?? ''}|${s.screen ?? ''}` : '';
      if (sig !== this.stripSig) { this.stripSig = sig; if (s?.lane === 'wait' || this.card.model) this.#readDialogSoon(300); else this.#paintCard(); }
      if (this.tab === 'chat') this.#updateChat();
    }
  }
}
function shq(s) { return /^[A-Za-z0-9_./~:@%+=-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`; }
export function fmtBytes(n) { if (n == null) return ''; if (n < 1024) return `${n} B`; if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`; return `${(n / 1024 / 1024).toFixed(1)} MB`; }
function extFor(mime) { return { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'application/pdf': '.pdf', 'text/plain': '.txt' }[mime] ?? ''; }

/** A transcript as Markdown (all turns as a chat shows them, or the last N assistant replies). */
export function transcriptMarkdown(target, turns, { last, host } = {}) {
  if (last) {
    const pick = turns.filter((t) => t.role === 'assistant' && t.text?.trim()).slice(-last);
    return last === 1 ? pick[0]?.text ?? '' : pick.map((t) => t.text).join('\n\n---\n\n');
  }
  const head = `# ${target?.name ?? 'session'}\n\n${[host ? `host: ${host}` : null, target?.session?.cwd ? `cwd: ${target.session.cwd}` : null, target?.session?.sessionId ? `session: ${target.session.sessionId}` : null].filter(Boolean).join('  \n')}\n\n`;
  const when = (t) => (t?.ts ? ` (${new Date(t.ts).toLocaleString()})` : '');
  return head + chatItems(turns).map((it) => {
    if (it.kind === 'tools') return `*${it.line}*${it.errors ? ` (${it.errors} failed)` : ''}\n\n${it.calls.map((c) => `- ${c.name}${c.summary ? `: \`${c.summary.replace(/`/g, "'")}\`` : ''}${c.result?.isError ? ' (error)' : ''}`).join('\n')}\n`;
    if (it.kind === 'user') return `### ${it.label}${when(it.turn)}\n\n${it.text}\n`;
    if (it.kind === 'assistant') return `### ${target?.engine === 'codex' ? 'codex' : 'assistant'}${when(it.turn)}\n\n${it.text}\n`;
    return `> ${String(it.text).split('\n').join('\n> ')}\n`;
  }).join('\n');
}
