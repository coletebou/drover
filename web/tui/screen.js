// Frames to terminal output. A frame is an array of rows; a row is a string, an array of segments
// [text, style?, bg?] or { segs, bg } (bg colors the whole row: the selection, a bar; a segment's own bg wins). Every row is rendered to exactly
// the screen width (cut with an ellipsis, padded with its background), and only rows whose rendering changed since
// the last frame are written, inside one synchronized update, so nothing flickers and a streaming reply costs one
// row per delta. Pure apart from Screen.draw's write; tests in test/tui-render.test.js.
import { truncate, strWidth } from './width.js';
import { resolve, sgr } from './style.js';

const CTRL = /[\x00-\x1f\x7f-\x9f]/;
const CTRLS = /[\x00-\x1f\x7f-\x9f]/g;
const RESET = '\x1b[0m';

/** Segments of a row: [[text, style], ...]. */
export function segsOf(row) {
  if (row == null) return [];
  if (typeof row === 'string') return [[row]];
  if (Array.isArray(row)) return row.map((s) => (typeof s === 'string' ? [s] : s));
  return segsOf(row.segs);
}
/** Plain text of a row (tests, search). */
export function rowText(row) { return segsOf(row).map(([t]) => t ?? '').join(''); }
/** Display width of a row. */
export function rowWidth(row) { return segsOf(row).reduce((w, [t]) => w + strWidth(t ?? ''), 0); }

/** One row as terminal output exactly `width` columns wide. cache memoizes SGR strings per style and background. */
export function renderRow(row, width, depth, cache = new Map()) {
  const rowBg = row && typeof row === 'object' && !Array.isArray(row) ? row.bg : null;
  const code = (style, bg) => {
    const k = `${typeof style === 'string' ? style : JSON.stringify(style ?? null)}|${typeof bg === 'string' ? bg : JSON.stringify(bg ?? null)}`;
    let v = cache.get(k); if (v === undefined) { v = sgr(resolve(style ?? 'plain', depth, bg), depth); cache.set(k, v); }
    return v;
  };
  let out = '', used = 0;
  for (const [text, style, segBg] of segsOf(row)) {
    if (used >= width) break;
    let t = String(text ?? '');
    if (!t) continue;
    if (CTRL.test(t)) t = t.replace(CTRLS, '');
    const room = width - used;
    let tw = strWidth(t);
    if (tw > room) { t = truncate(t, room); tw = strWidth(t); }
    const c = code(style, segBg ?? rowBg);
    out += c ? `${c}${t}${RESET}` : t;
    used += tw;
  }
  if (used < width) { const c = code('plain', rowBg); out += c ? `${c}${' '.repeat(width - used)}${RESET}` : ' '.repeat(width - used); }
  return out;
}

/** Terminal output that turns the screen showing `prev` (rendered rows, or null) into `next`. */
export function frameOutput(prev, next) {
  const full = !prev || prev.length !== next.length;
  let out = full ? '\x1b[H\x1b[2J' : '';
  for (let i = 0; i < next.length; i++) if (full || prev[i] !== next[i]) out += `\x1b[${i + 1};1H${next[i]}`;
  return out;
}

/** The screen: remembers what is on the terminal and writes only the difference. */
export class Screen {
  constructor(write, { depth = 8 } = {}) { this.write = write; this.depth = depth; this.prev = null; this.cache = new Map(); this.cols = 0; }
  /** Forget what is on screen (resize, Ctrl-L, after a suspend): the next draw repaints everything. */
  invalidate() { this.prev = null; }
  /** Draw a frame of `rows` rows at `cols` columns; cursor { row, col } shows the text cursor there, else hidden. */
  draw(frame, { rows, cols, cursor = null }) {
    if (cols !== this.cols) { this.prev = null; this.cols = cols; }
    const next = [];
    for (let i = 0; i < rows; i++) next.push(renderRow(frame[i] ?? '', cols, this.depth, this.cache));
    const body = frameOutput(this.prev, next);
    this.prev = next;
    const tail = cursor ? `\x1b[${cursor.row + 1};${cursor.col + 1}H\x1b[?25h` : '\x1b[?25l';
    if (!body && this.lastTail === tail) return 0;
    this.lastTail = tail;
    // Synchronized update (tmux 3.4+, most terminals; others ignore it): the frame appears at once.
    const out = `\x1b[?2026h\x1b[?25l${body}${tail}\x1b[?2026l`;
    this.write(out);
    return out.length;
  }
}
