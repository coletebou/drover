// Things drawn over a view: the help sheet (?), the command palette (: or Ctrl-P), a prompt (a reply to a session, a
// new thread name) and the launch prompt (a new agent from a prompt). Each owns all keys and the mouse while open and
// draws a box into the frame: the wheel scrolls it, a click on a palette entry runs it (the pointer over one
// highlights it), a click outside the help or the palette closes them (never a prompt's: a stray click must not lose
// a reply being typed).
import { Composer } from '../composer.js';
import { fit, truncate, strWidth } from '../width.js';
import { hints } from '../ui.js';

/** Draw rows in a centered box over the frame (rows 1 .. n-2, the bars stay). */
function boxOver(frame, cols, rows, { title, body, width, top }) {
  const w = Math.max(20, Math.min(width, cols - 4));
  const inner = w - 4;
  const h = Math.min(body.length + 2, rows - 4);
  const left = Math.floor((cols - w) / 2);
  const y0 = top ?? Math.max(1, Math.floor((rows - h) / 2));
  const pad = ' '.repeat(left);
  const frameRow = (segs) => [[pad, null], ...segs];
  const t = title ? ` ${title} ` : '';
  frame[y0] = frameRow([[`╭─${t}${'─'.repeat(Math.max(0, w - 3 - strWidth(t)))}╮`, 'accent']]);
  for (let i = 0; i < h - 2; i++) {
    const r = body[i] ?? [];
    const segs = Array.isArray(r) ? r : r.segs;
    let used = 0; const cut = [];
    for (const [tx, st] of segs) { if (used >= inner) break; const s = truncate(String(tx ?? ''), inner - used); cut.push([s, st, Array.isArray(r) ? null : r.bg]); used += strWidth(s); }
    frame[y0 + 1 + i] = frameRow([['│ ', 'accent'], ...cut, [' '.repeat(Math.max(0, inner - used)), null, Array.isArray(r) ? null : r.bg], [' │', 'accent']]);
  }
  frame[y0 + h - 1] = frameRow([[`╰${'─'.repeat(w - 2)}╯`, 'accent']]);
  return { y0, left, inner, w, h };
}
const inside = (box, ev) => Boolean(box) && ev.x >= box.left && ev.x < box.left + box.w && ev.y >= box.y0 && ev.y < box.y0 + box.h;
const clicked = (ev) => ev.kind === 'down' && ev.button === 0;

export class Help {
  constructor(app, sections) { this.app = app; this.sections = sections; this.top = 0; }
  key(ev) {
    if (['escape', 'q', '?', 'enter', 'f1'].includes(ev.id)) { this.app.closeModal(); return; }
    if (ev.id === 'j' || ev.id === 'down') this.top++; else if (ev.id === 'k' || ev.id === 'up') this.top = Math.max(0, this.top - 1);
    else if (ev.id === 'pgdn' || ev.id === ' ') this.top += 10; else if (ev.id === 'pgup') this.top = Math.max(0, this.top - 10);
  }
  hints() { return hints([['Esc', 'close'], ['j/k', 'scroll']]); }
  mouse(ev) {
    if (ev.kind === 'wheel') { this.top = Math.max(0, this.top + 3 * ev.wheel); return true; }
    if (clicked(ev) && !inside(this.box, ev)) { this.app.closeModal(); return true; }
    return false;
  }
  overlay(frame, cols, rows) {
    const body = [];
    for (const [head, list] of this.sections) {
      if (body.length) body.push([]);
      body.push([[head, 'bold']]);
      for (const [k, what] of list) body.push([[fit(k, 18), 'key'], [what, null]]);
    }
    const h = Math.min(body.length, rows - 6);
    this.top = Math.min(this.top, Math.max(0, body.length - h));
    this.box = boxOver(frame, cols, rows, { title: 'Keys', body: body.slice(this.top, this.top + h), width: 96 });
  }
  cursor() { return null; }
}

/** Fuzzy-ish match: every character of q in order; a smaller span scores better, a word start better still. */
export function score(q, text) {
  if (!q) return 1;
  const t = text.toLowerCase(); q = q.toLowerCase();
  if (t.includes(q)) return 1000 - t.indexOf(q) - (t.length / 100);
  let i = 0, first = -1, last = -1;
  for (const ch of q) { const j = t.indexOf(ch, i); if (j < 0) return 0; if (first < 0) first = j; last = j; i = j + 1; }
  return 500 - (last - first) - (t.length / 100);
}

export class Palette {
  constructor(app, items) { this.app = app; this.items = items; this.input = new Composer(); this.sel = 0; this.hoverIdx = -1; }
  matches() { const q = this.input.value.trim(); return this.items.map((it) => ({ it, s: score(q, `${it.label} ${it.hint ?? ''}`) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.it).slice(0, 200); }
  key(ev) {
    const m = this.matches();
    if (ev.id === 'escape' || ev.id === 'C-c') { this.app.closeModal(); return; }
    if (ev.id === 'enter') { const it = m[Math.min(this.sel, m.length - 1)]; this.app.closeModal(); if (it) it.run(this.input.value.trim()); return; }
    if (ev.id === 'down' || ev.id === 'C-n' || ev.id === 'tab') { this.sel = Math.min(m.length - 1, this.sel + 1); return; }
    if (ev.id === 'up' || ev.id === 'C-p' || ev.id === 'S-tab') { this.sel = Math.max(0, this.sel - 1); return; }
    if (ev.id === 'pgdn') { this.sel = Math.min(m.length - 1, this.sel + 10); return; }
    if (ev.id === 'pgup') { this.sel = Math.max(0, this.sel - 10); return; }
    if (ev.id === 'up' || ev.id === 'down') return;
    if (this.input.handle(ev) === true) this.sel = 0;
  }
  hints() { return hints([['type', 'to filter'], ['↑↓', 'choose'], ['Enter', 'run'], ['Esc', 'close']]); }
  /** The entry index at a screen position, or -1. Entries start two rows into the box body (the input, a blank row). */
  #at(ev, m) {
    if (!this.box || !inside(this.box, ev)) return -1;
    const i = (this.top ?? 0) + ev.y - (this.box.y0 + 1) - 2;
    return i >= (this.top ?? 0) && ev.y < this.box.y0 + this.box.h - 1 && m[i] ? i : -1;
  }
  mouse(ev) {
    const m = this.matches();
    if (ev.kind === 'move') { const i = this.#at(ev, m); if (i === this.hoverIdx) return false; this.hoverIdx = i; return true; }
    if (ev.kind === 'wheel') { this.sel = Math.max(0, Math.min(m.length - 1, this.sel + ev.wheel)); return true; }
    if (!clicked(ev)) return false;
    if (!inside(this.box, ev)) { this.app.closeModal(); return true; }
    const i = this.#at(ev, m);
    const it = i >= 0 ? m[i] : null;
    if (!it) return false;
    this.app.closeModal(); it.run(this.input.value.trim()); return true;
  }
  overlay(frame, cols, rows) {
    const m = this.matches();
    const h = Math.max(3, Math.min(16, rows - 8));
    const top = Math.max(0, Math.min(this.sel - h + 1, m.length - h)); this.top = top;
    const body = [[['› ', 'accent'], [this.input.value, null]], []];
    m.slice(top, top + h).forEach((it, i) => {
      const on = top + i === this.sel;
      const segs = [[on ? '▸ ' : '  ', 'accent'], [it.label, on ? 'bold' : null], ...(it.hint ? [[`  ${it.hint}`, 'dim']] : [])];
      body.push(on ? { segs, bg: 'sel' } : top + i === this.hoverIdx ? { segs, bg: 'hover' } : segs);
    });
    if (!m.length) body.push([['  nothing matches', 'dim']]);
    const r = boxOver(frame, cols, rows, { title: 'Commands', body, width: 80, top: 2 }); this.box = r;
    this.cur = { row: r.y0 + 1, col: r.left + 4 + this.input.layout(1000).cursorCol };
  }
  cursor() { return this.cur ?? null; }
}

/** A one or more line prompt: Enter submits, Ctrl-J adds a line, Esc cancels. */
export class Prompt {
  constructor(app, { title, placeholder = '', initial = '', onSubmit }) { this.app = app; this.title = title; this.placeholder = placeholder; this.onSubmit = onSubmit; this.input = new Composer(); this.input.set(initial); }
  key(ev) {
    if (ev.id === 'escape' || ev.id === 'C-c') { this.app.closeModal(); return; }
    const r = this.input.handle(ev, this.w ?? 60);
    if (r === 'submit') { const v = this.input.value; this.app.closeModal(); if (v.trim()) this.onSubmit(v); }
  }
  hints() { return hints([['Enter', 'send'], ['C-j', 'new line'], ['Esc', 'cancel']]); }
  overlay(frame, cols, rows) {
    const w = Math.min(100, cols - 4); this.w = w - 6;
    const L = this.input.layout(this.w);
    const body = [...L.rows.slice(-8).map((r, i) => [[i === 0 ? '› ' : '  ', 'accent'], [r, null]])];
    if (!this.input.value) body[0] = [['› ', 'accent'], [this.placeholder, 'dim']];
    body.push([], [[' Enter sends · Ctrl-J new line · Esc cancels', 'dim']]);
    const r = boxOver(frame, cols, rows, { title: this.title, body, width: w });
    const shown = Math.min(8, L.rows.length);
    this.cur = { row: r.y0 + 1 + (L.cursorRow - (L.rows.length - shown)), col: r.left + 4 + L.cursorCol };
  }
  cursor() { return this.cur ?? null; }
}

/**
 * The launch prompt: a new agent started with a prompt's text (launch.start). The text is edited as in a prompt; Tab
 * and Shift-Tab pick the host, Ctrl-E the engine; Enter launches with { text, host, engine, cwd }, Esc cancels.
 */
export class LaunchPrompt extends Prompt {
  constructor(app, { title = 'Launch an agent with this prompt', initial = '', hosts = ['local'], host = 'local', engine = 'claude', engines = ['claude', 'codex', 'hermes'], cwd = null, onLaunch }) {
    super(app, { title, initial, placeholder: 'the first prompt', onSubmit: (text) => onLaunch({ text, host: this.host, engine: this.engine, cwd: this.cwd }) });
    this.hosts = hosts.length ? hosts : ['local']; this.host = this.hosts.includes(host) ? host : this.hosts[0];
    this.engines = engines; this.engine = engines.includes(engine) ? engine : engines[0]; this.cwd = cwd;
  }
  key(ev) {
    if (ev.id === 'tab' || ev.id === 'S-tab') { const n = this.hosts.length; this.host = this.hosts[(this.hosts.indexOf(this.host) + (ev.id === 'tab' ? 1 : n - 1)) % n]; return; }
    if (ev.id === 'C-e') { this.engine = this.engines[(this.engines.indexOf(this.engine) + 1) % this.engines.length]; return; }
    super.key(ev);
  }
  hints() { return hints([['Enter', 'launch'], ['Tab', 'host'], ['C-e', 'engine'], ['C-j', 'new line'], ['Esc', 'cancel']]); }
  overlay(frame, cols, rows) {
    const w = Math.min(100, cols - 4); this.w = w - 6;
    const L = this.input.layout(this.w);
    const body = [...L.rows.slice(-8).map((r, i) => [[i === 0 ? '› ' : '  ', 'accent'], [r, null]])];
    if (!this.input.value) body[0] = [['› ', 'accent'], [this.placeholder, 'dim']];
    const label = (h) => (h === 'local' ? this.app.hostLabel?.(h) ?? h : h);
    body.push([], [['host ', 'dim'], ['‹ ', 'dim'], [label(this.host), 'accent'], [' ›', 'dim'], ['   engine ', 'dim'], [this.engine, 'accent'], ...(this.cwd ? [['   in ', 'dim'], [this.cwd, null]] : [])]);
    body.push([], [[' Enter launches in a tmux window · Tab host · Ctrl-E engine · Ctrl-J new line · Esc cancels', 'dim']]);
    const r = boxOver(frame, cols, rows, { title: this.title, body, width: w });
    const shown = Math.min(8, L.rows.length);
    this.cur = { row: r.y0 + 1 + (L.cursorRow - (L.rows.length - shown)), col: r.left + 4 + L.cursorCol };
  }
}
