// The composer: a small multi-line editor. Text and a cursor (a UTF-16 index kept on a grapheme boundary), the
// readline keys people type without thinking (Ctrl-A/E/U/W/K, Alt-B/F, Ctrl and Alt arrows), Enter to send,
// Ctrl-J or Alt-Enter for a new line, Up and Down through the rows and then through the history, bracketed paste,
// and the layout to rows of a width with the cursor's row and column. Pure; tests in test/tui-composer.test.js.
import { clusters, clusterWidth } from './width.js';

const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

export class Composer {
  constructor({ history = [], maxHistory = 200 } = {}) {
    this.text = ''; this.cur = 0; this.history = history; this.hi = -1; this.draft = ''; this.maxHistory = maxHistory; this.width = 80;
  }
  get value() { return this.text; }
  get empty() { return !this.text; }
  set(text, cur) { this.text = String(text ?? ''); this.cur = Math.max(0, Math.min(this.text.length, cur ?? this.text.length)); }
  clear() { this.set(''); this.hi = -1; }

  #prev(i) { if (i <= 0) return 0; const ls = this.text.lastIndexOf('\n', i - 1) + 1; if (ls === i) return i - 1; let b = ls; for (const { index } of seg.segment(this.text.slice(ls, i))) b = ls + index; return b; }
  #next(i) { if (i >= this.text.length) return this.text.length; if (this.text[i] === '\n') return i + 1; const le = this.text.indexOf('\n', i); const end = le < 0 ? this.text.length : le; const first = seg.segment(this.text.slice(i, end))[Symbol.iterator]().next().value; return i + (first ? first.segment.length : 1); }
  #lineStart(i = this.cur) { return this.text.lastIndexOf('\n', i - 1) + 1; }
  #lineEnd(i = this.cur) { const e = this.text.indexOf('\n', i); return e < 0 ? this.text.length : e; }

  insert(s) {
    const t = String(s ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').replace(CONTROL, '');
    if (!t) return;
    this.text = this.text.slice(0, this.cur) + t + this.text.slice(this.cur); this.cur += t.length; this.hi = -1;
  }
  backspace() { if (!this.cur) return; const p = this.#prev(this.cur); this.text = this.text.slice(0, p) + this.text.slice(this.cur); this.cur = p; }
  del() { if (this.cur >= this.text.length) return; const n = this.#next(this.cur); this.text = this.text.slice(0, this.cur) + this.text.slice(n); }
  left() { this.cur = this.#prev(this.cur); }
  right() { this.cur = this.#next(this.cur); }
  home() { this.cur = this.#lineStart(); }
  end() { this.cur = this.#lineEnd(); }
  wordLeft() { let i = this.cur; while (i > 0 && /\s/.test(this.text[i - 1])) i--; while (i > 0 && !/\s/.test(this.text[i - 1])) i--; this.cur = i; }
  wordRight() { let i = this.cur; const n = this.text.length; while (i < n && /\s/.test(this.text[i])) i++; while (i < n && !/\s/.test(this.text[i])) i++; this.cur = i; }
  deleteWordBefore() { const end = this.cur; this.wordLeft(); this.text = this.text.slice(0, this.cur) + this.text.slice(end); }
  killBefore() { const s = this.#lineStart(); if (s === this.cur && s > 0) { this.backspace(); return; } this.text = this.text.slice(0, s) + this.text.slice(this.cur); this.cur = s; }
  killAfter() { const e = this.#lineEnd(); if (e === this.cur && e < this.text.length) { this.del(); return; } this.text = this.text.slice(0, this.cur) + this.text.slice(e); }

  /** Move the cursor one visual row up or down at the same column; false when there is no such row. */
  vertical(dir, width = this.width) {
    const L = this.layout(width);
    const r = L.cursorRow + dir;
    if (r < 0 || r >= L.rows.length) return false;
    const row = L.info[r];
    let i = row.start, col = 0;
    for (const g of clusters(this.text.slice(row.start, row.end))) { const w = clusterWidth(g); if (col + w > L.cursorCol) break; col += w; i += g.length; }
    this.cur = i; return true;
  }

  historyPrev() {
    if (this.hi + 1 >= this.history.length) return false;
    if (this.hi === -1) this.draft = this.text;
    this.hi++; this.set(this.history[this.hi]); return true;
  }
  historyNext() {
    if (this.hi < 0) return false;
    this.hi--; this.set(this.hi < 0 ? this.draft : this.history[this.hi]); return true;
  }
  /** The text to send; it goes to the front of the history and the composer empties. */
  commit() {
    const v = this.text;
    if (v.trim()) { this.history = [v, ...this.history.filter((x) => x !== v)].slice(0, this.maxHistory); }
    this.clear(); this.draft = '';
    return v;
  }

  /**
   * One key event. Returns 'submit' for Enter, true when the composer used the key, false when it did not (the
   * caller then treats it as a command key: Escape, Tab, PgUp, F-keys, Ctrl-C ...).
   */
  handle(ev, width = this.width) {
    this.width = width;
    switch (ev.id) {
      case 'enter': return 'submit';
      case 'C-j': case 'M-enter': case 'S-enter': this.insert('\n'); return true;
      case 'paste': this.insert(ev.text); return true;
      case 'backspace': case 'C-h': this.backspace(); return true;
      case 'delete': case 'C-d': if (ev.id === 'C-d' && !this.text) return false; this.del(); return true;
      case 'left': case 'C-b': this.left(); return true;
      case 'right': case 'C-f': this.right(); return true;
      case 'home': case 'C-a': this.home(); return true;
      case 'end': case 'C-e': this.end(); return true;
      case 'C-left': case 'M-left': case 'M-b': this.wordLeft(); return true;
      case 'C-right': case 'M-right': case 'M-f': this.wordRight(); return true;
      case 'C-w': case 'M-backspace': case 'C-backspace': this.deleteWordBefore(); return true;
      case 'C-u': this.killBefore(); return true;
      case 'C-k': this.killAfter(); return true;
      case 'up': if (this.vertical(-1, width)) return true; return this.historyPrev() || true;
      case 'down': if (this.vertical(1, width)) return true; return this.historyNext() || true;
      default:
        if (ev.ch && !ev.ctrl && !ev.alt) { this.insert(ev.ch); return true; }
        return false;
    }
  }

  /**
   * Rows of the text at a width (hard wrapped: an editor must put the cursor where the text is), the cursor's row
   * and column, and each row's text range. A cursor after a full row starts the next one.
   */
  layout(width = this.width) {
    width = Math.max(2, width);
    const rows = [], info = []; let cursorRow = 0, cursorCol = 0, offset = 0;
    for (const line of this.text.split('\n')) {
      const start = offset; let chunk = '', cw = 0, cs = start, idx = start, placed = this.cur < start || this.cur > start + line.length;
      for (const g of clusters(line)) {
        const w = clusterWidth(g);
        if (cw + w > width) { rows.push(chunk); info.push({ start: cs, end: idx }); chunk = ''; cw = 0; cs = idx; }
        if (!placed && idx === this.cur) { cursorRow = rows.length; cursorCol = cw; placed = true; }
        chunk += g; cw += w; idx += g.length;
      }
      if (!placed) { if (cw >= width) { rows.push(chunk); info.push({ start: cs, end: idx }); chunk = ''; cw = 0; cs = idx; } cursorRow = rows.length; cursorCol = cw; }
      rows.push(chunk); info.push({ start: cs, end: idx });
      offset = start + line.length + 1;
    }
    return { rows, info, cursorRow, cursorCol };
  }
}
