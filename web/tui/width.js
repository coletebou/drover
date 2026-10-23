// Display width of terminal text, measured per grapheme cluster the way terminals draw it: East Asian wide and
// fullwidth characters and emoji take two columns, combining marks, joiners and other format characters none, a
// flag or a ZWJ sequence is one two-column cell. Also the cutting helpers every view uses: truncate with an
// ellipsis, pad to a width, wrap to a width, and sanitize (what data may reach the terminal). Pure; tests in
// test/tui-width.test.js.

const ASCII = /^[\x20-\x7e]*$/;
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const ZERO = /^[\p{Mn}\p{Me}\p{Cf}\u1160-\u11ff]$/u;           // marks, ZWJ/ZWNJ/bidi controls, Hangul medial and final jamo
const EMOJI = /\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F|\u20E3/u;   // drawn as emoji (two columns)
const FLAG = /^\p{Regional_Indicator}{2}$/u;

// East Asian Wide (W) and Fullwidth (F) ranges outside the emoji blocks (Unicode 15.1 EastAsianWidth.txt, merged).
const WIDE = [
  [0x1100, 0x115f], [0x2329, 0x232a], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
  [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f],
  [0xff00, 0xff60], [0xffe0, 0xffe6], [0x16fe0, 0x16fe4], [0x16ff0, 0x16ff1], [0x17000, 0x187f7], [0x18800, 0x18cd5],
  [0x18d00, 0x18d08], [0x1aff0, 0x1b2fb], [0x1f200, 0x1f2ff], [0x20000, 0x2fffd], [0x30000, 0x3fffd],
];
function inWide(cp) {
  let lo = 0, hi = WIDE.length - 1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; const [a, b] = WIDE[mid]; if (cp < a) hi = mid - 1; else if (cp > b) lo = mid + 1; else return true; }
  return false;
}

/** Columns one code point takes on its own: 0 for controls and zero-width characters, 2 for wide ones, else 1. */
export function codePointWidth(cp) {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp < 0x300) return 1;
  if (ZERO.test(String.fromCodePoint(cp))) return 0;
  return inWide(cp) || EMOJI.test(String.fromCodePoint(cp)) ? 2 : 1;
}

/** Columns one grapheme cluster takes. */
export function clusterWidth(g) {
  const cp = g.codePointAt(0);
  if (g.length === 1 && cp < 0x7f) return cp < 0x20 ? 0 : 1;
  if (FLAG.test(g) || EMOJI.test(g)) return 2;
  return codePointWidth(cp);
}

/** Grapheme clusters of s (ASCII without the segmenter: it is most of what a terminal shows). */
export function clusters(s) {
  s = String(s ?? '');
  if (ASCII.test(s)) return s.split('');
  return Array.from(segmenter.segment(s), (x) => x.segment);
}

/** Display width of s in columns. */
export function strWidth(s) {
  s = String(s ?? '');
  if (ASCII.test(s)) return s.length;
  let w = 0;
  for (const { segment } of segmenter.segment(s)) w += clusterWidth(segment);
  return w;
}

/**
 * s cut to at most width columns. A cut string ends in the ellipsis; a wide character that would straddle the
 * limit is left out rather than half drawn.
 */
export function truncate(s, width, ellipsis = '…') {
  s = String(s ?? '');
  if (width <= 0) return '';
  if (ASCII.test(s)) return s.length <= width ? s : width <= ellipsis.length ? ellipsis.slice(0, width) : s.slice(0, width - ellipsis.length) + ellipsis;
  if (strWidth(s) <= width) return s;
  const ew = strWidth(ellipsis);
  if (width <= ew) return ew === width ? ellipsis : '';
  let out = '', w = 0;
  for (const { segment } of segmenter.segment(s)) {
    const cw = clusterWidth(segment);
    if (w + cw > width - ew) break;
    out += segment; w += cw;
  }
  return out + ellipsis;
}

/** s truncated and then padded with spaces to exactly width columns. */
export function fit(s, width, ellipsis = '…') {
  const t = truncate(s, width, ellipsis);
  const w = strWidth(t);
  return w < width ? t + ' '.repeat(width - w) : t;
}

/** s padded on the left to width columns (numbers, ages). */
export function padStart(s, width) {
  const t = truncate(s, width);
  const w = strWidth(t);
  return w < width ? ' '.repeat(width - w) + t : t;
}

/**
 * s wrapped to width columns: words move to the next line whole, a word longer than a line is broken, newlines
 * start new lines, trailing spaces are dropped. words: false breaks at the width anywhere (code, pane text).
 */
export function wrap(s, width, { words = true } = {}) {
  width = Math.max(1, width);
  const out = [];
  for (const para of String(s ?? '').split('\n')) {
    if (strWidth(para) <= width) out.push(para.trimEnd());
    else if (!words) out.push(...hardBreak(para, width));
    else out.push(...wrapWords(para, width));
  }
  return out;
}

function wrapWords(para, width) {
  const out = []; let line = '', lw = 0;
  const flush = () => { if (line.trim() || !out.length) out.push(line.trimEnd()); line = ''; lw = 0; };
  for (const tok of para.split(/(\s+)/)) {
    if (!tok) continue;
    const tw = strWidth(tok);
    if (/^\s/.test(tok)) {
      if (!lw && out.length) continue;              // a continuation line starts at a word, not at spaces
      if (lw + tw <= width) { line += tok; lw += tw; } else flush();
      continue;
    }
    if (lw && lw + tw > width) flush();
    if (tw <= width) { line += tok; lw += tw; continue; }
    const parts = hardBreak(tok, width);
    if (line.trim()) flush(); else { line = ''; lw = 0; }
    out.push(...parts.slice(0, -1));
    line = parts.at(-1); lw = strWidth(line);
  }
  if (line || !out.length) out.push(line.trimEnd());
  return out;
}

function hardBreak(s, width) {
  const out = []; let line = '', lw = 0;
  for (const g of clusters(s)) {
    const cw = clusterWidth(g);
    if (lw + cw > width && lw) { out.push(line); line = ''; lw = 0; }
    line += g; lw += cw;
  }
  out.push(line);
  return out;
}

// ESC sequences (CSI, OSC, DCS and the two-byte forms) and the C0 and C1 controls other than tab and newline: text
// from a transcript or a pane must never reach the terminal as control (an OSC 52 would set the clipboard).
const ESCAPES = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b[\]P^_][\s\S]*?(?:\x07|\x1b\\|$)|\x1b[@-Z\\-_]?/g;
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/** s without escape sequences or control characters, tabs expanded to tabSize columns. Keeps newlines. */
export function sanitize(s, { tabSize = 4 } = {}) {
  let t = String(s ?? '');
  if (t.includes('\x1b')) t = t.replace(ESCAPES, '');
  t = t.replace(/\r\n?/g, '\n').replace(CONTROLS, '');
  if (t.includes('\t')) t = t.split('\n').map((line) => expandTabs(line, tabSize)).join('\n');
  return t;
}
function expandTabs(line, size) {
  let out = '', col = 0;
  for (const g of clusters(line)) {
    if (g === '\t') { const n = size - (col % size); out += ' '.repeat(n); col += n; } else { out += g; col += clusterWidth(g); }
  }
  return out;
}

/** One line of s: newlines and runs of spaces collapsed to one space (headlines, table cells). */
export function oneLine(s) { return sanitize(s).replace(/\s+/g, ' ').trim(); }
