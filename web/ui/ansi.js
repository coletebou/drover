// Pane text captured with escapes (tmux capture-pane -e) as styled lines, for the Wall's live tiles in the TUI and
// the browser. Only SGR (colors and attributes) is understood; every other escape (cursor moves, OSC titles and
// hyperlinks, DCS, mode changes) and every control character is dropped, so nothing from a pane ever reaches a
// terminal or the DOM as an escape. Colors come out as #rrggbb (16, 256 and truecolor alike). Pure; shared by
// web/tui/views/wall.js and web/ui/views/wall.js; tests in test/ansi.test.js.

/** The xterm 16-color palette (what most terminals ship), then the 6x6x6 cube and the gray ramp. */
const BASE16 = ['#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
  '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff'];
const hex2 = (n) => n.toString(16).padStart(2, '0');
const CUBE = [0, 95, 135, 175, 215, 255];

/** #rrggbb for a 256-color index (null for anything out of range). */
export function color256(i) {
  const n = Number(i);
  if (!Number.isInteger(n) || n < 0 || n > 255) return null;
  if (n < 16) return BASE16[n];
  if (n < 232) { const k = n - 16; return `#${hex2(CUBE[Math.floor(k / 36)])}${hex2(CUBE[Math.floor(k / 6) % 6])}${hex2(CUBE[k % 6])}`; }
  const g = 8 + (n - 232) * 10; return `#${hex2(g)}${hex2(g)}${hex2(g)}`;
}
const rgb = (r, g, b) => ([r, g, b].every((v) => Number.isInteger(v) && v >= 0 && v <= 255) ? `#${hex2(r)}${hex2(g)}${hex2(b)}` : null);

const PLAIN = Object.freeze({ fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, reverse: false });

/** The style after one SGR parameter list ("1;38;5;208", "" = reset) is applied to `st`. */
export function applySgr(st, params) {
  const p = String(params ?? '').split(/[;:]/).map((x) => (x === '' ? 0 : Number(x)));
  let s = { ...st };
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (!Number.isFinite(c)) continue;
    if (c === 0) s = { ...PLAIN };
    else if (c === 1) s.bold = true;
    else if (c === 2) s.dim = true;
    else if (c === 3) s.italic = true;
    else if (c === 4) s.underline = true;
    else if (c === 7) s.reverse = true;
    else if (c === 22) { s.bold = false; s.dim = false; }
    else if (c === 23) s.italic = false;
    else if (c === 24) s.underline = false;
    else if (c === 27) s.reverse = false;
    else if (c >= 30 && c <= 37) s.fg = BASE16[c - 30];
    else if (c >= 90 && c <= 97) s.fg = BASE16[c - 90 + 8];
    else if (c >= 40 && c <= 47) s.bg = BASE16[c - 40];
    else if (c >= 100 && c <= 107) s.bg = BASE16[c - 100 + 8];
    else if (c === 39) s.fg = null;
    else if (c === 49) s.bg = null;
    else if (c === 38 || c === 48) {
      const key = c === 38 ? 'fg' : 'bg';
      if (p[i + 1] === 5) { s[key] = color256(p[i + 2]); i += 2; }
      else if (p[i + 1] === 2) { s[key] = rgb(p[i + 2], p[i + 3], p[i + 4]); i += 4; }
    }
  }
  return s;
}

const same = (a, b) => a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.dim === b.dim && a.italic === b.italic && a.underline === b.underline && a.reverse === b.reverse;

// ESC [ params intermediates final | ESC ] ... (BEL | ESC \) | ESC P/X/^/_ ... ESC \ | ESC + one char.
const ESC_RE = /\x1b(?:\[([0-?]*)([ -/]*)([@-~])|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[PX^_][^\x1b]*(?:\x1b\\)?|[@-Z\\-_]|.)?/y;
const CTRL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/**
 * Lines of styled runs: [[{ text, fg, bg, bold, dim, italic, underline, reverse }]]. Tabs expand to 8 columns;
 * maxLines keeps the last lines (a tile shows the bottom of a pane); maxCols cuts each line (by UTF-16 units, the
 * callers cut again by display width). Styles carry across line breaks, as in a terminal.
 */
export function parseAnsi(text, { maxLines = Infinity, maxCols = Infinity } = {}) {
  const lines = [];
  let line = []; let col = 0; let st = { ...PLAIN }; let buf = '';
  const flush = () => {
    if (!buf) return;
    const last = line.at(-1);
    if (last && same(last, st)) last.text += buf; else line.push({ text: buf, ...st });
    buf = '';
  };
  const s = String(text ?? '');
  for (let i = 0; i < s.length;) {
    const ch = s[i];
    if (ch === '\x1b') {
      ESC_RE.lastIndex = i;
      const m = ESC_RE.exec(s);
      const len = m ? m[0].length : 1;
      if (m && m[3] === 'm' && !m[2]) { flush(); st = applySgr(st, m[1]); }
      i += Math.max(1, len);
      continue;
    }
    if (ch === '\n') { flush(); lines.push(line); line = []; col = 0; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\t') { const n = 8 - (col % 8); if (col + n <= maxCols) { buf += ' '.repeat(n); col += n; } i++; continue; }
    const code = ch.charCodeAt(0);
    if ((code < 0x20) || (code >= 0x7f && code <= 0x9f)) { i++; continue; }
    if (col < maxCols) { buf += ch; col++; }
    i++;
  }
  flush(); lines.push(line);
  while (lines.length > 1 && !lines.at(-1).some((r) => r.text.trim())) lines.pop();   // tmux pads the pane bottom
  return Number.isFinite(maxLines) && lines.length > maxLines ? lines.slice(lines.length - maxLines) : lines;
}

/** Plain text of parsed lines (tests, previews, accessibility labels). */
export const plainLines = (lines) => lines.map((l) => l.map((r) => r.text).join(''));

/** Text with every escape and control character removed (one line of a pane for a label). */
export function stripAnsi(text) { return plainLines(parseAnsi(text)).join('\n').replace(CTRL, ''); }
