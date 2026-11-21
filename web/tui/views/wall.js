// Agents › Wall: a grid of live mini terminals, one tile per agent on the board, waiting first, then by name
// (docs/specs/2026-11-21-cohesion-overhaul.md, "Wall"). A tile is a border in its lane's colour (a waiting one pulses
// at about 2 Hz while the Wall is in front) around a header (lane dot, name, host, age) and the bottom of its pane in
// colour: tmux.captureMany with SGR escapes, one call per host per refresh for the tiles on screen only, parsed by
// ui/ansi.js (no escape from a pane reaches the terminal), every 2 s, every 1 s zoomed, paused when another view is in
// front. A capture that fails keeps the last one, marked stale. A daemon without captureMany is asked tmux.capture per
// tile instead (plain text). The selection is the agent selected in every agent view (app.agentSel); a click selects
// a tile and a second click (or z) zooms it to the whole view; Enter opens the session; the pointer highlights a tile.
import { parseAnsi } from '../../ui/ansi.js';
import { THEME } from '../style.js';
import { stripKey } from '../board.js';
import { block, hints, ago } from '../ui.js';
import { strWidth, truncate, oneLine } from '../width.js';

/** Tile grids from the sparsest to the densest: [columns, rows] (+ and - step through them). */
export const DENSITIES = [[1, 1], [2, 1], [2, 2], [3, 2], [3, 3], [4, 3], [4, 4], [5, 4], [6, 5]];
export const MIN_TILE = { w: 18, h: 4 };
export const REFRESH_MS = 2000;
export const ZOOM_REFRESH_MS = 1000;
const ORDER = { wait: 0, work: 1, idle: 2 };
const GAP = 1;

/** Board strips in Wall order: waiting, working, idle; by name inside a lane. */
export function wallOrder(strips) {
  return [...(strips ?? [])].sort((a, b) => (ORDER[a.lane] ?? 3) - (ORDER[b.lane] ?? 3) || String(a.name ?? '').localeCompare(String(b.name ?? '')) || String(stripKey(a)).localeCompare(String(stripKey(b))));
}

/**
 * The grid for count tiles in width x height cells: { cols, rows, w, h, density }. With no density (auto) it is the
 * sparsest grid that shows every tile, as long as tiles keep MIN_TILE; else the densest that still does. Tiles are w
 * columns by h rows with one column between them.
 */
export function wallLayout(width, height, count, density = null) {
  const size = ([c, r]) => ({ w: Math.floor((width - GAP * (c - 1)) / c), h: Math.floor(height / r) });
  const fits = (d) => { const s = size(d); return s.w >= MIN_TILE.w && s.h >= MIN_TILE.h; };
  let i = density;
  if (i == null) {
    i = DENSITIES.findIndex((d) => d[0] * d[1] >= count && fits(d));
    if (i < 0) { i = 0; for (let k = 0; k < DENSITIES.length; k++) if (fits(DENSITIES[k])) i = k; }
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

const laneColor = (s) => (s.status === 'dead' ? THEME.err.fg : s.faded ? THEME.dim.fg : THEME[s.lane]?.fg ?? THEME.dim.fg);

/**
 * One tile as h rows of exactly w columns: the border (heavy when selected, the hover tint under the pointer, a waiting
 * tile's border alternating bright and dim with `pulse`), the header, the pane's last lines (or the strip's own lines
 * for an agent with no pane), and a stale marker when the last capture failed.
 */
export function tileRows(strip, cap, w, h, { selected = false, hovered = false, pulse = false, hostLabel = (x) => x, now = Date.now() } = {}) {
  const color = laneColor(strip);
  const waiting = strip.lane === 'wait';
  const border = { fg: color, ...(selected || (waiting && !pulse) ? { bold: true } : {}), ...(waiting && pulse ? { dim: true } : {}), ...(hovered ? { bg: THEME.hover.bg } : {}) };
  const [tl, tr, bl, br, hz, vt] = selected ? ['┏', '┓', '┗', '┛', '━', '┃'] : ['╭', '╮', '╰', '╯', '─', '│'];
  const inner = Math.max(0, w - 2);
  const head = [];
  const dot = strip.lane === 'work' ? '◐' : '●';
  const name = oneLine(strip.name ?? strip.id ?? '');
  // The name comes first: on a narrow tile the host goes before the name is cut.
  const full = ` · ${hostLabel(strip.host)} · ${ago(strip.since, now)}${cap?.stale ? ' · stale' : ''} `;
  const meta = inner - 3 - strWidth(name) >= strWidth(full) ? full : ` · ${ago(strip.since, now)}${cap?.stale ? ' · stale' : ''} `;
  const nameRoom = Math.max(1, inner - 3 - strWidth(meta));
  head.push([tl, border], [' ', border], [dot, { fg: color, bold: true, ...(hovered ? { bg: THEME.hover.bg } : {}) }], [' ', border], [truncate(name, nameRoom), { bold: true, ...(hovered ? { fg: THEME.hover.fg, bg: THEME.hover.bg } : {}) }]);
  const used = 3 + strWidth(truncate(name, nameRoom));
  const metaT = truncate(meta, Math.max(0, inner - used));
  head.push([metaT, cap?.stale ? { fg: THEME.err.fg, ...(hovered ? { bg: THEME.hover.bg } : {}) } : { fg: THEME.dim.fg, ...(hovered ? { bg: THEME.hover.bg } : {}) }]);
  head.push([hz.repeat(Math.max(0, inner - used - strWidth(metaT))), border], [tr, border]);
  const rows = [head];
  const bodyH = Math.max(0, h - 2);
  let lines;
  if (cap?.lines?.length) lines = cap.lines.slice(-bodyH).map((l) => lineSegs(l, inner));
  else {
    const own = [...(strip.tail ?? []).filter(Boolean).map(oneLine)];
    const msg = cap?.error ? [`could not capture: ${oneLine(cap.error)}`] : strip.tmux ? ['capturing the pane…'] : own.length ? [] : ['no pane: open it for the chat'];
    lines = [...own.slice(-(bodyH - msg.length)), ...msg].slice(-bodyH).map((t) => lineSegs([{ text: t, fg: THEME.dim.fg }], inner));
  }
  while (lines.length < bodyH) lines.unshift(lineSegs([], inner));
  for (const l of lines) rows.push([[vt, border], ...l, [vt, border]]);
  const label = waiting ? ` ${oneLine(strip.dialog?.question ?? strip.ask?.label ?? 'waiting on you')} ` : strip.engine ? ` ${strip.engine} ` : '';
  const lab = truncate(label, Math.max(0, inner - 2));
  if (h >= 2) rows.push([[bl, border], [hz, border], [lab, waiting ? { fg: THEME.wait.fg, bold: !pulse, ...(hovered ? { bg: THEME.hover.bg } : {}) } : { fg: THEME.dim.fg, ...(hovered ? { bg: THEME.hover.bg } : {}) }], [hz.repeat(Math.max(0, inner - 1 - strWidth(lab))), border], [br, border]]);
  return rows.slice(0, h);
}

export class WallView {
  constructor(app) {
    this.app = app; this.id = 'wall'; this.title = 'Wall';
    this.density = null; this.zoomed = false; this.topRow = 0; this.hoverKey = null;
    this.caps = new Map();      // strip key -> { lines, hash, at, error, stale }
    this.busy = new Set();      // hosts with a capture out
    this.shown = false; this.timer = null; this.ticks = 0; this.many = null;   // many: tmux.captureMany known (null: not asked yet)
    this.layout = null; this.placed = [];
  }

  strips() { return wallOrder(this.app.board?.strips ?? []); }
  selected() { const k = this.app.agentSel; return k ? this.strips().find((s) => stripKey(s) === k) ?? null : null; }
  select(key) { if (this.app.selectAgent) this.app.selectAgent(key); else this.app.agentSel = key; }

  show() {
    this.shown = true;
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), ZOOM_REFRESH_MS); this.timer.unref?.();
    this.refresh();
  }
  hide() { this.shown = false; clearInterval(this.timer); this.timer = null; this.app.animate?.(this, 0); }
  /** Every second: zoomed, a refresh; else every other second. Nothing while another view is in front. */
  tick() { this.ticks++; if (this.zoomed || this.ticks % 2 === 0) this.refresh(); }
  inFront() { return this.shown && (!this.app.front || this.app.front() === this); }

  /** The strips drawn by the last frame (only these are captured). */
  visible() { return this.placed.map((p) => p.strip); }

  /** Capture every visible tile that has a pane: one tmux.captureMany per host, none for a host still answering. */
  async refresh() {
    if (!this.inFront()) return;
    const byHost = new Map();
    for (const s of this.visible()) if (s.tmux) { const h = s.host ?? 'local'; if (!byHost.has(h)) byHost.set(h, []); byHost.get(h).push(s); }
    const lines = Math.max(10, (this.layout?.h ?? 10) - 2);
    await Promise.all([...byHost].map(([host, list]) => this.#captureHost(host, list.slice(0, 64), lines)));
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
    if (was && c.hash && was.hash === c.hash) { this.caps.set(key, { ...was, at: Date.now(), error: null, stale: false }); return; }
    this.caps.set(key, { lines: parseAnsi(c.text ?? '', { maxLines: 200, maxCols: 400 }), hash: c.hash ?? null, at: Date.now(), error: null, stale: false });
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
  key(ev) {
    switch (ev.id) {
      case 'left': case 'h': this.move(-1, 0); return true;
      case 'right': case 'l': this.move(1, 0); return true;
      case 'up': case 'k': this.move(0, -1); return true;
      case 'down': case 'j': this.move(0, 1); return true;
      case '+': case '=': this.#density(1); return true;
      case '-': case '_': this.#density(-1); return true;
      case 'z': this.zoom(); return true;
      case 'enter': case 'o': { const s = this.selected(); if (s) this.app.openStrip(s); else this.move(0, 0); return true; }
      case 'r': { const s = this.selected(); if (s) this.app.replyTo(s); return true; }
      case 'R': case 'C-r': this.app.refreshBoardSoon?.(0, { toast: true }); this.refresh(); return true;
      case 'escape': if (this.zoomed) { this.zoomed = false; return true; } return false;
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
  hoverPreview() {
    const s = this.hoverKey ? this.strips().find((x) => stripKey(x) === this.hoverKey) : null; if (!s) return null;
    const cap = this.caps.get(this.hoverKey);
    const last = cap?.lines ? [...cap.lines].reverse().map((l) => l.map((r) => r.text).join('').trim()).find(Boolean) : null;
    return `${oneLine(s.name)}: ${oneLine(s.dialog?.question ?? last ?? (s.tail ?? []).filter(Boolean).at(-1) ?? s.headline ?? '')}`;
  }
  hints() {
    const s = this.selected();
    if (this.zoomed) return hints([['Esc', 'unzoom'], ['Enter', 'open'], ['r', 'reply'], ['←→', 'next'], ['z', 'unzoom']]);
    return hints([['←↓↑→', 'move'], ['z', 'zoom'], ['Enter', s ? 'open' : 'select'], ['r', 'reply'], ['+', 'more'], ['-', 'fewer'], ['< >', 'views']]);
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
    const waiting = all.filter((s) => s.lane === 'wait').length;
    const pageNote = totalRows > L.rows ? ` · rows ${this.topRow + 1}-${Math.min(totalRows, this.topRow + L.rows)} of ${totalRows}` : '';
    const head = [[' Wall  ', 'bold'], [b.loading && !all.length ? 'reading the fleet…' : `${all.length} agents, ${waiting} waiting · ${this.zoomed ? `zoomed on ${oneLine(sel.name)}, every 1 s` : `${L.cols}×${L.rows}${this.density == null ? ' (fits)' : ''}, every 2 s`}${pageNote}${this.many === false ? ' · this daemon has no tmux.captureMany: one plain capture per tile' : ''}`, 'dim']];
    const out = [head];
    this.placed = [];
    if (!all.length) { out.push([], [[b.loading ? ' reading the fleet…' : ' No agents on the board.', 'dim']]); this.#pulse(false); return block(out, height); }
    const pulse = Math.floor(Date.now() / 500) % 2 === 1;
    const label = (h) => (!h || h === 'local' ? this.app.frontHost ?? 'local' : h);
    const shown = list.slice(this.topRow * L.cols, (this.topRow + L.rows) * L.cols);
    const gridRows = Array.from({ length: L.rows * L.h }, () => []);
    shown.forEach((s, i) => {
      const c = i % L.cols, r = Math.floor(i / L.cols);
      const x = c * (L.w + GAP), y = 1 + r * L.h;
      const key = stripKey(s);
      this.placed.push({ strip: s, x, y, w: L.w, h: L.h });
      const rows = tileRows(s, this.caps.get(key), L.w, L.h, { selected: key === this.app.agentSel, hovered: key === this.hoverKey, pulse, hostLabel: label });
      rows.forEach((segs, k) => { const row = gridRows[r * L.h + k]; if (c) row.push([' '.repeat(GAP), null]); row.push(...segs); });
    });
    out.push(...gridRows);
    this.#pulse(shown.some((s) => s.lane === 'wait'));
    return block(out, height);
  }
  /** Waiting tiles pulse at 2 Hz while the Wall is in front; nothing to animate, no timer. */
  #pulse(on) { this.app.animate?.(this, on && this.shown ? 2 : 0); }
}
