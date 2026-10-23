// The board: every live agent on every reachable host in three lanes (Waiting on you, Working, Idle), live from the
// `board` stream event (fleet.summary on an older daemon), with the selected strip's details beside it. A waiting
// strip shows its dialog; digits, Enter and Esc answer it (sessions.answer with the hash of the screen shown).
// Answer keys work only on a strip the owner selected themself: the selection starts empty whenever the board is shown,
// so a digit pressed to switch views never lands on a dialog.
import { LANES, answerKeys, pressDrawn } from '../board.js';
import { answerCardRows, keyHints } from '../chat.js';
import { rule, hints, block, keepVisible, sideBySide, ago, tilde } from '../ui.js';
import { fit, truncate, oneLine, padStart, wrap } from '../width.js';

const DOT = { wait: 'wait', work: 'work', idle: 'idle' };
const EMPTY = { wait: 'Nothing waits on you.', work: 'No one is working.', idle: 'Nothing idle.' };

export class BoardView {
  constructor(app) { this.app = app; this.id = 'board'; this.title = 'Board'; this.selKey = null; this.top = 0; this.filter = ''; this.filtering = false; }
  get inputActive() { return this.filtering; }
  /** Shown fresh, nothing is selected; back from a session it opened, the selection the owner made stays. */
  show({ back = false } = {}) { if (!back) this.selKey = null; this.app.refreshBoardSoon(0); }

  strips() {
    const q = this.filter.toLowerCase();
    return this.app.board.strips.filter((s) => !q || [s.name, s.host, s.engine, s.headline, s.cwd, s.tmux, s.windowName].join(' ').toLowerCase().includes(q));
  }
  selected() { return this.selKey ? this.strips().find((s) => s.key === this.selKey) ?? null : null; }
  move(n) {
    const list = this.strips(); if (!list.length) return;
    const cur = this.selKey ? list.findIndex((s) => s.key === this.selKey) : -1;
    const i = cur < 0 ? (n >= 1e6 ? list.length - 1 : 0) : Math.max(0, Math.min(list.length - 1, cur + n));
    this.selKey = list[i].key;
  }
  clearInput() { if (this.filtering || this.filter) { this.filter = ''; this.filtering = false; return true; } if (this.selKey) { this.selKey = null; return true; } return false; }

  key(ev) {
    if (this.filtering) {
      if (ev.id === 'enter') { this.filtering = false; return true; }
      if (ev.id === 'escape') { this.filtering = false; this.filter = ''; return true; }
      if (ev.id === 'backspace') { this.filter = this.filter.slice(0, -1); return true; }
      if (ev.id === 'paste') { this.filter += oneLine(ev.text); return true; }
      if (ev.ch && !ev.ctrl && !ev.alt) { this.filter += ev.ch; this.selKey = null; return true; }
      return false;
    }
    const s = this.selected();
    // A dialog key presses exactly what the last frame drew, or nothing (board.js pressDrawn).
    if (this.selKey && pressDrawn(this.app, s, this.drawn?.key === this.selKey ? this.drawn : null, ev)) return true;
    switch (ev.id) {
      case 'j': case 'down': this.move(1); return true;
      case 'k': case 'up': this.move(-1); return true;
      case 'pgdn': this.move(10); return true;
      case 'pgup': this.move(-10); return true;
      case 'g': case 'home': this.selKey = null; this.move(1); return true;
      case 'G': case 'end': this.move(1e6); return true;
      case 'enter': if (!s) { this.move(1); return true; } this.app.openStrip(s); return true;
      case 'o': case 'right': case 'l': if (s) this.app.openStrip(s); return true;
      case 'r': if (s) this.app.replyTo(s); return true;
      case '/': this.filtering = true; return true;
      case 'R': case 'C-r': this.app.refreshBoardSoon(0, { toast: true }); return true;
      case 'escape': if (this.selKey) { this.selKey = null; return true; } return false;
      default: return false;
    }
  }

  hints() {
    if (this.filtering) return hints([['type', 'to filter'], ['Enter', 'keep'], ['Esc', 'clear']]);
    const s = this.selected();
    const keys = answerKeys(s);
    if (keys.length) return [...keyHints(keys).map(([t, st]) => [t, st === 'key' ? 'barKey' : 'bar']), ['   ', 'barDim'], ...hints([['o', 'open'], ['r', 'reply'], ['j/k', 'move']])];
    return hints([['j/k', 'select'], ['Enter', s ? 'open' : 'select'], ['r', 'reply'], ['/', 'filter'], ['R', 'refresh'], ['1-9', 'views'], ['?', 'help']]);
  }

  #listRows(width) {
    const rows = []; const index = [];
    const list = this.strips();
    const nameW = Math.max(10, Math.min(28, Math.floor(width * 0.24)));
    const hostW = Math.max(6, Math.min(16, Math.floor(width * 0.13)));
    for (const [lane, title] of LANES) {
      const items = list.filter((s) => s.lane === lane);
      rows.push([[` ${title}`, lane === 'wait' ? 'waitBold' : 'bold'], [items.length ? ` ${items.length}` : '', 'dim']]); index.push(null);
      if (!items.length) { rows.push([['   ' + EMPTY[lane], 'dim']]); index.push(null); }
      for (const s of items) {
        const on = s.key === this.selKey;
        const host = s.host === 'local' ? this.app.frontHost ?? 'local' : s.host;
        const dot = s.status === 'dead' ? 'err' : s.faded ? 'dim' : DOT[s.lane];
        const head = oneLine(s.dialog?.question ?? s.ask?.text ?? s.headline ?? '');
        const segs = [[on ? '▌' : ' ', 'accent'], [s.lane === 'work' ? '◐ ' : '● ', dot], [fit(oneLine(s.name), nameW), s.faded ? 'dim' : on ? 'bold' : null], [' ', null], [fit(host, hostW), 'dim'], [' ', null], [fit(s.engine ?? '', 7), 'dim'], [padStart(ago(s.since), 4), 'dim'], ['  ', null], [head, s.lane === 'wait' ? 'wait' : 'dim']];
        rows.push(on ? { segs, bg: 'sel' } : segs); index.push(s.key);
      }
      rows.push([]); index.push(null);
    }
    return { rows, index };
  }

  #detailRows(s, width) {
    if (!s) {
      const t = this.app.board.totals ?? {};
      const out = [[[' Select an agent with j/k', 'dim']], [], [[` ${t.waiting ?? 0} waiting, ${t.working ?? 0} working, ${t.idle ?? 0} idle`, null]]];
      for (const h of this.app.board.hosts ?? []) out.push([[`  ${h.up === false ? '○' : '●'} `, h.up === false ? 'err' : 'idle'], [fit(h.name === 'local' ? this.app.frontHost ?? 'local' : h.name, 18), null], [`${h.waiting ?? 0} waiting  ${h.working ?? 0} working  ${h.idle ?? 0} idle`, 'dim'], [h.error ? `  ${truncate(oneLine(h.error), 40)}` : h.stale ? '  last inventory' : '', 'err']]);
      return out;
    }
    const host = s.host === 'local' ? this.app.frontHost ?? 'local' : s.host;
    const out = [[[` ${oneLine(s.name)}`, 'bold'], [`  ${s.engine ?? ''} on ${host}`, 'dim']]];
    out.push([[` ${s.lane === 'wait' ? (s.ask?.label ?? 'waiting on you') : s.lane === 'work' ? 'working' : s.status === 'dead' ? 'dead' : 'idle'}`, s.lane === 'wait' ? 'waitBold' : s.lane === 'work' ? 'work' : 'idle'], [s.since ? `  since ${ago(s.since)} ago` : '', 'dim']]);
    out.push([]);
    if (s.lane === 'wait') { out.push(...answerCardRows(s, answerKeys(s), width)); out.push([]); }
    const kv = [['tmux', s.tmux ? `${s.tmux}${s.windowName && s.windowName !== s.name ? `  (${s.windowName})` : ''}` : null], ['cwd', s.cwd ? tilde(s.cwd) : null], ['session', s.sessionId ?? (s.kind === 'session' ? s.id : null)], ['status', s.status ?? null]];
    for (const [k, v] of kv) if (v) out.push([[` ${fit(k, 9)}`, 'dim'], [truncate(String(v), Math.max(4, width - 11)), null]]);
    if (s.finished?.text) { out.push([], [[' finished: ', 'idle'], [truncate(oneLine(s.finished.text), Math.max(4, width - 12)), null]]); }
    const tail = (s.tail ?? []).filter(Boolean);
    if (tail.length) { out.push([], [[' last lines', 'dim']]); for (const l of tail.slice(-6)) for (const w of wrap(oneLine(l), Math.max(8, width - 3), { words: false }).slice(0, 2)) out.push([['   ', null], [w, 'dim']]); }
    out.push([], [[' ', null], ...keyHintsPlain(s)]);
    return out;
  }

  render(width, height) {
    const b = this.app.board;
    const t = b.totals ?? {};
    const meta = b.loading && !b.strips.length ? 'reading the fleet…' : `${t.waiting ?? 0} waiting · ${t.working ?? 0} working · ${t.idle ?? 0} idle on ${b.hosts?.length ?? t.hosts ?? 0} hosts${b.source === 'fleet.summary' ? ' (fleet.summary: this daemon has no native.board)' : ''}${b.error ? ` · ${b.error}` : ''}`;
    const head = [[' Board  ', 'bold'], [meta, b.error ? 'err' : 'dim'], ...(this.filtering || this.filter ? [['   filter: ', 'dim'], [this.filter, 'accent'], [this.filtering ? '▍' : '', 'accent']] : [])];
    const { rows, index } = this.#listRows(width >= 110 ? Math.floor(width * 0.56) : width);
    const s = this.selected();
    this.drawn = s ? { key: s.key, strip: s } : null;
    const selRow = s ? index.indexOf(s.key) : -1;
    const bodyH = height - 2;
    if (width >= 110) {
      const lw = Math.floor(width * 0.56);
      this.top = selRow >= 0 ? keepVisible(selRow, this.top, bodyH, rows.length) : Math.min(this.top, Math.max(0, rows.length - bodyH));
      const left = rows.slice(this.top, this.top + bodyH);
      const right = this.#detailRows(s, width - lw - 3);
      return block([head, rule(width), ...sideBySide(left, right, lw, width, bodyH)], height);
    }
    const detail = s ? this.#detailRows(s, width) : [];
    const dh = s ? Math.min(detail.length + 1, Math.floor(bodyH / 2)) : 0;
    const lh = bodyH - dh;
    this.top = selRow >= 0 ? keepVisible(selRow, this.top, lh, rows.length) : Math.min(this.top, Math.max(0, rows.length - lh));
    return block([head, rule(width), ...block(rows.slice(this.top, this.top + lh), lh), ...(dh ? [rule(width), ...detail.slice(0, dh - 1)] : [])], height);
  }
}

function keyHintsPlain(s) {
  const keys = answerKeys(s);
  return [...(keys.length ? [...keyHints(keys), [' · ', 'dim']] : []), ['o', 'key'], [' open', 'dim'], [' · ', 'dim'], ['r', 'key'], [' reply', 'dim']];
}
