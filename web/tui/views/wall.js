// Agents › Wall: a grid of live tiles, one per agent on the board, in the board's order: waiting, working, idle,
// the newest first (docs/specs/2026-11-21-cohesion-overhaul.md, "Wall"). A tile is a border in its lane's colour (a
// waiting one pulses at about 2 Hz while the Wall is in front) around a header (lane dot, name, host, state and age),
// what the agent's pane says, and a footer (engine and working directory; what a waiting one asks). The pane comes
// from tmux.captureMany with SGR escapes, one call per host per refresh for the tiles on screen only, parsed by
// ui/ansi.js (no escape from a pane reaches the terminal); ui/pane-content.js then leaves out the agent's own
// furniture (input box, status line, mode line, notices), and long lines wrap to the tile instead of being cut, so a
// tile reads as what the agent last said and not as its status line. `c` shows the pane as it is. An agent with no
// pane shows its last reply (sessions.lastReply). By default only what is active is shown (waiting, working, idle for
// less than a day; `f` steps Active, Live, All), `/` filters by name, host, directory. Every 2 s, every 1 s zoomed,
// paused when another view is in front. A capture that fails keeps the last one, marked stale. A daemon without
// captureMany is asked tmux.capture per tile instead (plain text). The selection is the agent selected in every agent
// view (app.agentSel); a click selects a tile and a second click (or z) zooms it to the whole view; Enter opens the
// session; the pointer highlights a tile.
import { parseAnsi } from '../../ui/ansi.js';
import { paneContent, tailContent, keepsShape, hangingIndent, lastText } from '../../ui/pane-content.js';
import { wallTiles, stateWord, wantsReply, repliesDue, replyText, SCOPES } from '../../ui/wall-model.js';
import { THEME } from '../style.js';
import { stripKey } from '../board.js';
import { rowWidth } from '../screen.js';
import { renderMarkdown } from '../markdown.js';
import { block, hints, ago, cut } from '../ui.js';
import { strWidth, truncate, oneLine, clusters, clusterWidth } from '../width.js';

/** Tile grids from the sparsest to the densest: [columns, rows] (+ and - step through them). */
export const DENSITIES = [[1, 1], [2, 1], [2, 2], [3, 2], [3, 3], [4, 3], [4, 4], [5, 4], [6, 5]];
export const MIN_TILE = { w: 18, h: 4 };
/** The smallest tile the Wall picks on its own: a few lines of prose still read. + goes denser, down to MIN_TILE. */
export const COMFORT = { w: 36, h: 8 };
export const REFRESH_MS = 2000;
export const ZOOM_REFRESH_MS = 1000;
const GAP = 1;
const EXTRA_LINES = 14;   // asked for on top of a tile's rows: the furniture left out, and blank runs collapsed

/**
 * The grid for count tiles in width x height cells: { cols, rows, w, h, density }. With no density (auto): the
 * sparsest grid that shows every tile while tiles stay comfortable to read (COMFORT); when they cannot all be shown
 * that way, the densest comfortable grid (the rest scroll); on a view too small for any, the densest that keeps
 * MIN_TILE. Tiles are w columns by h rows with one column between them.
 */
export function wallLayout(width, height, count, density = null) {
  const size = ([c, r]) => ({ w: Math.floor((width - GAP * (c - 1)) / c), h: Math.floor(height / r) });
  const atLeast = (min) => (d) => { const s = size(d); return s.w >= min.w && s.h >= min.h; };
  const last = (ok) => { let i = -1; for (let k = 0; k < DENSITIES.length; k++) if (ok(DENSITIES[k])) i = k; return i; };
  let i = density;
  if (i == null) {
    const comfy = atLeast(COMFORT), fits = atLeast(MIN_TILE);
    i = DENSITIES.findIndex((d) => d[0] * d[1] >= count && comfy(d));
    if (i < 0) i = last(comfy);
    if (i < 0) i = DENSITIES.findIndex((d) => d[0] * d[1] >= count && fits(d));
    if (i < 0) i = Math.max(0, last(fits));
  }
  i = Math.max(0, Math.min(DENSITIES.length - 1, i));
  const [cols, rows] = DENSITIES[i];
  return { cols, rows, density: i, ...size(DENSITIES[i]) };
}

/** A parsed pane line (ui/ansi.js runs) as screen.js segments cut to exactly w columns, colours as style objects. */
export function lineSegs(runs, w) {
  const out = []; let used = 0;
  for (const r of runs ?? []) {
    if (used >= w) break;
    let t = String(r.text ?? ''); if (!t) continue;
    let tw = strWidth(t);
    if (used + tw > w) { t = truncate(t, w - used, ''); tw = strWidth(t); }
    if (!tw) break;
    const st = {}; for (const k of ['fg', 'bg']) if (r[k]) st[k] = r[k]; for (const k of ['bold', 'dim', 'italic', 'underline', 'reverse']) if (r[k]) st[k] = true;
    out.push([t, st]); used += tw;
  }
  if (used < w) out.push([' '.repeat(w - used), null]);
  return out;
}

/**
 * One parsed line as rows of runs no wider than width: it breaks at a space when there is one, later rows are
 * indented by hang columns, and every run keeps its colours. Trailing spaces go.
 */
export function wrapRuns(runs, width, { hang = 0 } = {}) {
  const cells = [];
  for (const r of runs ?? []) for (const g of clusters(String(r.text ?? ''))) cells.push([g, clusterWidth(g), r]);
  while (cells.length && cells.at(-1)[0] === ' ') cells.pop();
  const toRuns = (slice, pad) => {
    const out = pad ? [{ text: ' '.repeat(pad) }] : [];
    for (const [g, , r] of slice) { const l = out.at(-1); if (l && l.of === r) l.text += g; else out.push({ ...r, text: g, of: r }); }
    return out;
  };
  if (cells.reduce((n, c) => n + c[1], 0) <= width) return [toRuns(cells, 0)];
  const lead = cells.findIndex((c) => c[0] !== ' ');
  const rows = []; let start = 0;
  while (start < cells.length) {
    const pad = rows.length ? Math.min(hang, Math.max(0, width - 8)) : 0;
    const room = Math.max(1, width - pad);
    let w = 0, end = start, space = -1;
    while (end < cells.length && w + cells[end][1] <= room) { if (cells[end][0] === ' ' && end > lead) space = end; w += cells[end][1]; end++; }
    if (end < cells.length && cells[end][0] !== ' ' && space > start) end = space;
    if (end === start) end = start + 1;   // a wide character in a one-column room still moves on
    rows.push(toRuns(cells.slice(start, end), pad));
    start = end; while (start < cells.length && cells[start][0] === ' ') start++;
  }
  return rows;
}

const textOf = (line) => (line ?? []).map((r) => r.text ?? '').join('');

/** The last h rows of parsed lines at w columns: prose wrapped, a rule, a box or a table row cut at the edge. */
export function contentRows(lines, w, h) {
  const rows = [];
  for (let i = (lines ?? []).length - 1; i >= 0 && rows.length < h; i--) {
    const t = textOf(lines[i]);
    const wrapped = keepsShape(t) ? [lines[i]] : wrapRuns(lines[i], w, { hang: hangingIndent(t) });
    rows.unshift(...wrapped.map((r) => lineSegs(r, w)));
  }
  const out = rows.slice(-h);
  while (out.length && !out[0].some(([t]) => t.trim())) out.shift();   // the cut can land on a blank row: start at text
  return out;
}

/** The last h rows of Markdown text (a reply, the board's own lines) at exactly w columns. */
export function textRows(text, w, h, base = null) {
  return renderMarkdown(String(text ?? ''), w, { base }).slice(-h).map((row) => {
    const segs = cut(row, w); const pad = w - rowWidth(segs);
    return pad > 0 ? [...segs, [' '.repeat(pad), null]] : segs;
  });
}

const laneColor = (s) => (s.status === 'dead' || s.status === 'failed' ? THEME.err.fg : s.faded ? THEME.dim.fg : THEME[s.lane]?.fg ?? THEME.dim.fg);
/** s cut to w columns from the left, so a path keeps its last folders. */
const tailCut = (s, w) => { const g = clusters(String(s ?? '')); let out = '', used = 0; if (strWidth(s) <= w) return String(s ?? ''); for (let i = g.length - 1; i >= 0; i--) { const cw = clusterWidth(g[i]); if (used + cw > w - 1) break; out = g[i] + out; used += cw; } return w > 0 ? `…${out}` : ''; };

/**
 * What a tile says, as rows of exactly w columns (at most h; fewer when there is less to say): the pane without the
 * agent's furniture (raw: the bottom of the pane as it is), else the agent's last reply, else the board's own lines,
 * else one dim line saying why there is nothing. Cached on the capture or reply it was made from.
 */
function bodyRows(strip, cap, reply, w, h, raw) {
  if (h <= 0 || w <= 0) return [];
  const note = (t) => [lineSegs([{ text: truncate(t, w), fg: THEME.dim.fg }], w)];
  const memo = (holder, key, make) => { if (holder.rowsKey !== key) { holder.rowsKey = key; holder.rows = make(); } return holder.rows; };
  if (cap?.lines?.length) {
    if (raw) return cap.lines.slice(-h).map((l) => lineSegs(l, w));
    const rows = memo(cap, `${w}x${h}`, () => { cap.content ??= paneContent(cap.lines, { state: cap.state ?? strip.screen }).lines; return contentRows(cap.content, w, h); });
    if (rows.length) return rows;
  }
  const said = reply?.text?.trim() ? reply : null;
  if (said) return memo(said, `${w}x${h}`, () => textRows(said.text, w, h));
  const own = tailContent(strip.tail).join('\n').trim();
  const why = cap?.error ? `could not capture: ${oneLine(cap.error)}` : cap?.lines?.length ? 'nothing on screen yet' : strip.tmux ? 'capturing the pane…' : reply ? null : wantsReply(strip) ? 'reading its last reply…' : null;
  const ownRows = own && own !== strip.status ? textRows(own, w, why ? h - 1 : h, 'dim') : [];
  if (ownRows.length || why) return [...ownRows, ...(why ? note(why) : [])].slice(-h);
  return note(strip.tmux ? 'nothing on screen yet' : 'no pane, and no reply on record');
}

/**
 * One tile as h rows of exactly w columns: the border (heavy when selected, the hover tint under the pointer, a waiting
 * tile's border alternating bright and dim with `pulse`), the header (lane dot, name, host, state and age, a stale
 * marker when the last capture failed), what the agent says from the top (bodyRows), and the footer: what a waiting
 * tile asks, else the engine and the working directory.
 */
export function tileRows(strip, cap, w, h, { selected = false, hovered = false, pulse = false, hostLabel = (x) => x, now = Date.now(), reply = null, raw = false } = {}) {
  const color = laneColor(strip);
  const waiting = strip.lane === 'wait';
  const tint = hovered ? { bg: THEME.hover.bg } : {};
  const border = { fg: color, ...(selected || (waiting && !pulse) ? { bold: true } : {}), ...(waiting && pulse ? { dim: true } : {}), ...tint };
  const [tl, tr, bl, br, hz, vt] = selected ? ['┏', '┓', '┗', '┛', '━', '┃'] : ['╭', '╮', '╰', '╯', '─', '│'];
  const inner = Math.max(0, w - 2);
  const head = [];
  const dot = strip.lane === 'work' ? '◐' : '●';
  const name = oneLine(strip.name ?? strip.id ?? '');
  // The name comes first: on a narrow tile the host goes, then the state word, before the name is cut.
  const age = ago(strip.since, now); const state = stateWord(strip); const stale = cap?.stale ? ' · stale' : '';
  const when = `${state}${age ? ` ${age}` : ''}`;
  const room = inner - 3 - strWidth(name);
  const meta = [` · ${hostLabel(strip.host)} · ${when}${stale} `, ` · ${when}${stale} `].find((m) => room >= strWidth(m)) ?? ` · ${age || state}${stale} `;
  const nameRoom = Math.max(1, inner - 3 - strWidth(meta));
  head.push([tl, border], [' ', border], [dot, { fg: color, bold: true, ...tint }], [' ', border], [truncate(name, nameRoom), { bold: true, ...(hovered ? { fg: THEME.hover.fg, bg: THEME.hover.bg } : {}) }]);
  const used = 3 + strWidth(truncate(name, nameRoom));
  const metaT = truncate(meta, Math.max(0, inner - used));
  head.push([metaT, { fg: cap?.stale || state === 'failed' || state === 'dead' ? THEME.err.fg : THEME.dim.fg, ...tint }]);
  head.push([hz.repeat(Math.max(0, inner - used - strWidth(metaT))), border], [tr, border]);
  const rows = [head];
  const bodyH = Math.max(0, h - 2);
  const lines = bodyRows(strip, cap, reply, inner, bodyH, raw);
  while (lines.length < bodyH) lines.push(lineSegs([], inner));
  for (const l of lines) rows.push([[vt, border], ...l, [vt, border]]);
  const labRoom = Math.max(0, inner - 2);
  let label = '';
  if (waiting) label = ` ${oneLine(strip.dialog?.question ?? strip.ask?.label ?? 'waiting on you')} `;
  else {
    const eng = strip.engine ? String(strip.engine) : ''; const tag = !strip.tmux && strip.kind !== 'window' ? ' · no pane' : '';
    const cwdRoom = labRoom - 2 - strWidth(eng) - strWidth(tag) - (eng ? 3 : 0);
    const cwd = strip.cwd && cwdRoom >= 6 ? tailCut(oneLine(strip.cwd), cwdRoom) : '';
    label = eng || cwd ? ` ${[eng, cwd].filter(Boolean).join(' · ')}${tag} ` : '';
  }
  const lab = truncate(label, labRoom);
  if (h >= 2) rows.push([[bl, border], [hz, border], [lab, waiting ? { fg: THEME.wait.fg, bold: !pulse, ...tint } : { fg: THEME.dim.fg, ...tint }], [hz.repeat(Math.max(0, inner - 1 - strWidth(lab))), border], [br, border]]);
  return rows.slice(0, h);
}

export class WallView {
  constructor(app) {
    this.app = app; this.id = 'wall'; this.title = 'Wall';
    this.density = null; this.zoomed = false; this.topRow = 0; this.hoverKey = null;
    this.scope = 'active'; this.filter = ''; this.filtering = false; this.raw = false;
    this.caps = new Map();      // strip key -> { lines, state, hash, at, error, stale } (+ the rows drawn from it)
    this.replies = new Map();   // strip key -> { text, at, error } for agents with no pane
    this.busy = new Set();      // hosts with a capture out
    this.asking = new Set();    // strip keys with a sessions.lastReply out
    this.shown = false; this.timer = null; this.ticks = 0; this.many = null;   // many: tmux.captureMany known (null: not asked yet)
    this.replyOp = null;        // sessions.lastReply known (false: this daemon has none)
    this.layout = null; this.placed = [];
  }
  get inputActive() { return this.filtering; }

  /** The tiles: the board's strips in this scope (wall-model.js wallTiles), then the words typed after `/`. */
  strips() {
    const q = this.filter.trim().toLowerCase();
    const list = wallTiles(this.app.board?.strips ?? [], { scope: this.scope });
    return q ? list.filter((s) => [s.name, s.host, s.engine, s.cwd, s.tmux, s.windowName, s.status].join(' ').toLowerCase().includes(q)) : list;
  }
  selected() { const k = this.app.agentSel; return k ? this.strips().find((s) => stripKey(s) === k) ?? null : null; }
  select(key) { if (this.app.selectAgent) this.app.selectAgent(key); else this.app.agentSel = key; }

  show() {
    this.shown = true;
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), ZOOM_REFRESH_MS); this.timer.unref?.();
    this.refresh();
  }
  hide() { this.shown = false; this.filtering = false; clearInterval(this.timer); this.timer = null; this.app.animate?.(this, 0); }
  /** Every second: zoomed, a refresh; else every other second. Nothing while another view is in front. */
  tick() { this.ticks++; if (this.zoomed || this.ticks % 2 === 0) this.refresh(); }
  inFront() { return this.shown && (!this.app.front || this.app.front() === this); }

  /** The strips drawn by the last frame (only these are captured). */
  visible() { return this.placed.map((p) => p.strip); }

  /**
   * Read every visible tile: one tmux.captureMany per host for the ones with a pane (none for a host still
   * answering), and the last reply of the ones without (sessions.lastReply, a few at a time, seldom).
   */
  async refresh() {
    if (!this.inFront()) return;
    const byHost = new Map();
    for (const s of this.visible()) if (s.tmux) { const h = s.host ?? 'local'; if (!byHost.has(h)) byHost.set(h, []); byHost.get(h).push(s); }
    const lines = Math.max(20, (this.layout?.h ?? 10) - 2 + EXTRA_LINES);
    await Promise.all([...[...byHost].map(([host, list]) => this.#captureHost(host, list.slice(0, 64), lines)), this.#askReplies()]);
  }
  async #captureHost(host, list, lines) {
    if (this.busy.has(host)) return;
    this.busy.add(host);
    const hostArg = host && host !== 'local' ? { host } : {};
    try {
      if (this.many !== false) {
        try {
          const r = await this.app.client.call('tmux.captureMany', { targets: list.map((s) => s.tmux), lines, escapes: true, ...hostArg }, { timeoutMs: 15_000 });
          this.many = true;
          const got = new Map((r?.captures ?? []).map((c) => [c.target, c]));
          for (const s of list) this.#take(s, got.get(s.tmux) ?? { ok: false, error: 'not in the answer' });
          return;
        } catch (e) { if (!e.unknownOp) throw e; this.many = false; }
      }
      // An older daemon: one plain capture per tile.
      await Promise.all(list.map(async (s) => {
        try { const c = await this.app.client.call('tmux.capture', { target: s.tmux, lines, ...hostArg }, { timeoutMs: 15_000 }); this.#take(s, { ok: true, text: c?.text ?? '' }); }
        catch (e) { this.#take(s, { ok: false, error: e.message }); }
      }));
    } catch (e) {
      for (const s of list) this.#take(s, { ok: false, error: e.message });
    } finally { this.busy.delete(host); this.app.invalidate(); }
  }
  #take(s, c) {
    const key = stripKey(s); const was = this.caps.get(key);
    if (c?.ok === false || c?.error) { this.caps.set(key, { ...(was ?? {}), lines: was?.lines ?? null, error: c.error ?? 'capture failed', stale: true }); return; }
    const state = c.screen?.state ?? (typeof c.screen === 'string' ? c.screen : null);
    if (was && c.hash && was.hash === c.hash && was.state === state) { was.at = Date.now(); was.error = null; was.stale = false; return; }
    this.caps.set(key, { lines: parseAnsi(c.text ?? '', { maxLines: 200, maxCols: 400 }), state, hash: c.hash ?? null, at: Date.now(), error: null, stale: false });
  }
  /** The last reply of each visible agent that has no pane: a few calls a refresh, each agent seldom (wall-model.js repliesDue). */
  async #askReplies() {
    if (this.replyOp === false) return;
    const due = repliesDue(this.visible(), { replies: this.replies, asking: this.asking, keyOf: stripKey });
    await Promise.all(due.map(async (s) => {
      const key = stripKey(s); const was = this.replies.get(key);
      this.asking.add(key);
      try {
        const r = await this.app.client.call('sessions.lastReply', { id: s.sessionId ?? s.id, ...(s.host && s.host !== 'local' ? { host: s.host } : {}) }, { timeoutMs: 15_000 });
        this.replyOp = true;
        const text = replyText(r, was);
        if (was && was.text === text) { was.at = Date.now(); was.error = null; } else this.replies.set(key, { text, at: Date.now(), error: null });
      } catch (e) {
        if (e.unknownOp) this.replyOp = false;
        this.replies.set(key, { ...(was ?? { text: '' }), at: Date.now(), error: e.message });
      } finally { this.asking.delete(key); this.app.invalidate(); }
    }));
  }

  // ------------------------------------------------------------ keys and mouse
  move(dx, dy) {
    const list = this.strips(); if (!list.length) return;
    const cols = this.zoomed ? 1 : this.layout?.cols ?? 1;
    const cur = list.findIndex((s) => stripKey(s) === this.app.agentSel);
    const i = cur < 0 ? 0 : Math.max(0, Math.min(list.length - 1, cur + dx + dy * cols));
    this.select(stripKey(list[i])); this.scrolled = false;
  }
  zoom(on = !this.zoomed) {
    if (on && !this.selected()) this.move(0, 0);
    this.zoomed = Boolean(on) && Boolean(this.selected());
    this.ticks = 0; this.refresh();
  }
  /** The scope n places on (Active, Live, All): what is shown changes, so the grid goes back to its first row. */
  cycleScope(n = 1) {
    const ids = SCOPES.map(([id]) => id);
    this.scope = ids[(ids.indexOf(this.scope) + n + ids.length) % ids.length];
    this.zoomed = false; this.topRow = 0; this.scrolled = false;
    this.app.invalidate?.(); setTimeout(() => this.refresh(), 0);
  }
  clearInput() { if (this.filtering || this.filter) { this.filter = ''; this.filtering = false; this.topRow = 0; return true; } return false; }
  key(ev) {
    if (this.filtering) {
      if (ev.id === 'enter') { this.filtering = false; setTimeout(() => this.refresh(), 0); return true; }
      if (ev.id === 'escape') { this.filtering = false; this.filter = ''; return true; }
      if (ev.id === 'backspace') { this.filter = this.filter.slice(0, -1); this.topRow = 0; return true; }
      if (ev.id === 'paste') { this.filter += oneLine(ev.text); this.topRow = 0; return true; }
      if (ev.ch && !ev.ctrl && !ev.alt) { this.filter += ev.ch; this.topRow = 0; return true; }
      return false;
    }
    switch (ev.id) {
      case 'left': case 'h': this.move(-1, 0); return true;
      case 'right': case 'l': this.move(1, 0); return true;
      case 'up': case 'k': this.move(0, -1); return true;
      case 'down': case 'j': this.move(0, 1); return true;
      case '+': case '=': this.#density(1); return true;
      case '-': case '_': this.#density(-1); return true;
      case 'z': this.zoom(); return true;
      case 'f': this.cycleScope(1); return true;
      case 'F': this.cycleScope(-1); return true;
      case 'c': this.raw = !this.raw; return true;
      case '/': this.filtering = true; this.zoomed = false; return true;
      case 'enter': case 'o': { const s = this.selected(); if (s) this.app.openStrip(s); else this.move(0, 0); return true; }
      case 'r': { const s = this.selected(); if (s) this.app.replyTo(s); return true; }
      case 'R': case 'C-r': this.app.refreshBoardSoon?.(0, { toast: true }); this.refresh(); return true;
      case 'escape': if (this.zoomed) { this.zoomed = false; return true; } if (this.filter) { this.filter = ''; this.topRow = 0; return true; } return false;
      default: return false;
    }
  }
  #density(n) { const cur = this.density ?? this.layout?.density ?? 3; this.density = Math.max(0, Math.min(DENSITIES.length - 1, cur + n)); this.zoomed = false; this.refresh(); }

  /** The tile under a view position, or null. */
  tileAt(x, y) { return this.placed.find((p) => x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h) ?? null; }
  mouse(ev) {
    const hit = this.tileAt(ev.x, ev.y);
    if (ev.kind === 'move') { const k = hit ? stripKey(hit.strip) : null; if (k === this.hoverKey) return false; this.hoverKey = k; return true; }
    if (ev.kind === 'wheel') { if (this.zoomed) return false; this.topRow = Math.max(0, this.topRow + ev.wheel); this.scrolled = true; return true; }
    if (ev.kind !== 'down' || ev.button !== 0 || !hit) return false;
    const k = stripKey(hit.strip);
    if (k === this.app.agentSel) { this.zoom(); return true; }   // the second click zooms (or unzooms)
    this.select(k); return true;
  }
  /** The hovered tile's last line whole (a tile wraps and clips): what its pane says, else its reply, else the board's line. */
  hoverPreview() {
    const s = this.hoverKey ? this.strips().find((x) => stripKey(x) === this.hoverKey) : null; if (!s) return null;
    const cap = this.caps.get(this.hoverKey);
    const said = cap?.lines ? lastText(this.raw ? cap.lines : cap.content ?? paneContent(cap.lines, { state: cap.state ?? s.screen }).lines) : null;
    const reply = (this.replies.get(this.hoverKey)?.text ?? '').trim().split('\n').filter((l) => l.trim()).at(-1);
    return `${oneLine(s.name)}: ${oneLine(s.dialog?.question ?? (said || reply || tailContent(s.tail).at(-1) || s.headline || ''))}`;
  }
  hints() {
    if (this.filtering) return hints([['type', 'to filter'], ['Enter', 'keep'], ['Esc', 'clear']]);
    const s = this.selected();
    if (this.zoomed) return hints([['Esc', 'unzoom'], ['Enter', 'open'], ['r', 'reply'], ['←→', 'next'], ['c', this.raw ? 'clean' : 'raw pane'], ['z', 'unzoom']]);
    const next = SCOPES[(SCOPES.findIndex(([id]) => id === this.scope) + 1) % SCOPES.length][1].toLowerCase();
    return hints([['←↓↑→', 'move'], ['z', 'zoom'], ['Enter', s ? 'open' : 'select'], ['r', 'reply'], ['f', `show ${next}`], ['/', 'filter'], ['+', 'more'], ['-', 'fewer'], ['c', this.raw ? 'clean' : 'raw panes'], ['< >', 'views']]);
  }

  // ------------------------------------------------------------ drawing
  render(width, height) {
    const all = this.strips();
    const sel = this.selected();
    if (this.zoomed && !sel) this.zoomed = false;
    const gridH = Math.max(1, height - 1);
    const L = this.zoomed ? { cols: 1, rows: 1, w: width, h: gridH, density: this.layout?.density ?? 0 } : wallLayout(width, gridH, all.length, this.density);
    this.layout = L;
    const list = this.zoomed ? [sel] : all;
    // Keep the selected tile's row on screen (the wheel scrolls freely until a key moves the selection).
    const totalRows = Math.ceil(list.length / L.cols);
    const si = sel ? list.indexOf(sel) : -1;
    if (si >= 0 && !this.scrolled) { const r = Math.floor(si / L.cols); if (r < this.topRow) this.topRow = r; if (r >= this.topRow + L.rows) this.topRow = r - L.rows + 1; }
    this.topRow = Math.max(0, Math.min(this.topRow, Math.max(0, totalRows - L.rows)));
    const b = this.app.board ?? {};
    const board = (b.strips ?? []).filter((s) => s.engine !== 'openclaw');
    const count = (lane) => board.filter((s) => s.lane === lane).length;
    const waiting = count('wait');
    const scope = SCOPES.find(([id]) => id === this.scope) ?? SCOPES[0];
    const head = [[' Wall  ', 'bold']];
    if (b.loading && !board.length) head.push(['reading the fleet…', 'dim']);
    else {
      head.push([`${waiting} waiting`, waiting ? 'waitBold' : 'dim'], [` · ${count('work')} working · ${count('idle')} idle`, 'dim'], ['   ', null], [scope[1], 'accentBold'],
        [all.length === board.length ? ` ${all.length}` : ` ${all.length} of ${board.length}`, 'dim']);
      if (this.filtering || this.filter) head.push(['   filter: ', 'dim'], [this.filter, 'accent'], [this.filtering ? '▍' : '', 'accent']);
      const page = totalRows > L.rows ? ` · rows ${this.topRow + 1}-${Math.min(totalRows, this.topRow + L.rows)} of ${totalRows}` : '';
      head.push([`   ${this.zoomed ? `zoomed on ${oneLine(sel.name)}` : `${L.cols}×${L.rows}`}${page}${this.raw ? ' · raw panes' : ''}${this.many === false ? ' · this daemon has no tmux.captureMany: one plain capture per tile' : ''}`, 'dim']);
    }
    const out = [head];
    this.placed = [];
    if (!all.length) {
      const why = b.loading && !board.length ? ' reading the fleet…' : !board.length ? ' No agents on the board.' : this.filter ? ` Nothing matches "${this.filter}" in ${scope[1]}. Esc clears the filter.`
        : ` Nothing is ${this.scope === 'live' ? 'waiting or working' : 'active'} right now: f shows more (${board.length} on the board).`;
      out.push([], [[why, 'dim']]); this.#pulse(false); return block(out, height);
    }
    const pulse = Math.floor(Date.now() / 500) % 2 === 1;
    const label = (h) => (!h || h === 'local' ? this.app.frontHost ?? 'local' : h);
    const shown = list.slice(this.topRow * L.cols, (this.topRow + L.rows) * L.cols);
    const gridRows = Array.from({ length: L.rows * L.h }, () => []);
    shown.forEach((s, i) => {
      const c = i % L.cols, r = Math.floor(i / L.cols);
      const x = c * (L.w + GAP), y = 1 + r * L.h;
      const key = stripKey(s);
      this.placed.push({ strip: s, x, y, w: L.w, h: L.h });
      const rows = tileRows(s, this.caps.get(key), L.w, L.h, { selected: key === this.app.agentSel, hovered: key === this.hoverKey, pulse, hostLabel: label, reply: this.replies.get(key) ?? null, raw: this.raw });
      rows.forEach((segs, k) => { const row = gridRows[r * L.h + k]; if (c) row.push([' '.repeat(GAP), null]); row.push(...segs); });
    });
    out.push(...gridRows);
    this.#pulse(shown.some((s) => s.lane === 'wait'));
    return block(out, height);
  }
  /** Waiting tiles pulse at 2 Hz while the Wall is in front; nothing to animate, no timer. */
  #pulse(on) { this.app.animate?.(this, on && this.shown ? 2 : 0); }
}
