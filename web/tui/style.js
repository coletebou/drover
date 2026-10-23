// Colors and attributes for the TUI as SGR escapes at the terminal's color depth: truecolor (COLORTERM), 256
// colors, 16, or none (NO_COLOR, TERM=dumb). With no color the attributes stay (bold, dim, reverse, underline),
// so selection and emphasis still read. Styles are named (THEME) or plain objects { fg, bg, bold, dim, italic,
// underline, reverse } with colors as #rrggbb. Pure; tests in test/tui-render.test.js.

/** 0 (no color), 4 (16 colors), 8 (256) or 24 (truecolor) for this environment. */
export function colorDepth(env = process.env) {
  const forced = String(env.DROVER_TUI_COLOR ?? '').toLowerCase();
  if (forced) return { none: 0, never: 0, '16': 4, '256': 8, truecolor: 24, '24bit': 24 }[forced] ?? 8;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 0;   // no-color.org: any non-empty value
  const term = String(env.TERM ?? '');
  if (!term || term === 'dumb') return 0;
  if (/^(truecolor|24bit)$/i.test(env.COLORTERM ?? '')) return 24;
  if (/256|^(tmux|screen|xterm-ghostty|xterm-kitty|alacritty|wezterm|foot)/.test(term)) return 8;
  return 4;
}

// One palette, readable on dark and light terminal backgrounds (foregrounds are mid-tone; the only backgrounds are
// the selection and the bars, which carry their own foreground).
const C = {
  text: null, faint: '#8a8f98', accent: '#5fa8d3', wait: '#e0a030', work: '#5f9fdf', idle: '#7fb069', err: '#e05d5d',
  you: '#5fa8d3', mgr: '#b48ead', code: '#c7a76c', link: '#5fa8d3', key: '#e0a030', barBg: '#30343c', barFg: '#d8dce3',
  selBg: '#3c4656', selFg: '#ffffff', tabOn: '#ffffff', tabOnBg: '#4a6a8a', okFg: '#7fb069',
};

export const THEME = {
  plain: {},
  bold: { bold: true },
  dim: { fg: C.faint },
  italic: { italic: true },
  under: { underline: true },
  accent: { fg: C.accent },
  accentBold: { fg: C.accent, bold: true },
  wait: { fg: C.wait }, waitBold: { fg: C.wait, bold: true },
  work: { fg: C.work }, idle: { fg: C.idle }, ok: { fg: C.okFg },
  err: { fg: C.err }, errBold: { fg: C.err, bold: true },
  you: { fg: C.you, bold: true }, mgr: { fg: C.mgr, bold: true }, other: { fg: C.wait, bold: true },
  code: { fg: C.code }, link: { fg: C.link, underline: true },
  key: { fg: C.key, bold: true },
  head: { bold: true, underline: true },
  bar: { fg: C.barFg, bg: C.barBg }, barDim: { fg: C.faint, bg: C.barBg }, barKey: { fg: C.key, bg: C.barBg, bold: true },
  barOk: { fg: C.okFg, bg: C.barBg }, barWait: { fg: C.wait, bg: C.barBg, bold: true }, barErr: { fg: C.err, bg: C.barBg, bold: true },
  tab: { fg: C.barFg, bg: C.barBg }, tabOn: { fg: C.tabOn, bg: C.tabOnBg, bold: true }, tabNum: { fg: C.faint, bg: C.barBg },
  sel: { fg: C.selFg, bg: C.selBg },
  cursor: { reverse: true },
};
// What a style becomes with no color: emphasis through attributes alone.
const MONO = { sel: { reverse: true }, tabOn: { reverse: true, bold: true }, bar: {}, barDim: { dim: true }, barKey: { bold: true }, barOk: {}, barWait: { bold: true }, barErr: { bold: true }, tab: {}, tabNum: { dim: true }, dim: { dim: true }, wait: { bold: true }, waitBold: { bold: true }, err: { bold: true }, errBold: { bold: true }, you: { bold: true }, mgr: { bold: true }, other: { bold: true }, link: { underline: true }, key: { bold: true } };

const hex = (c) => { const n = parseInt(c.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const CUBE = [0, 95, 135, 175, 215, 255];
function to256([r, g, b]) {
  const near = (v) => CUBE.reduce((best, x, i) => (Math.abs(x - v) < Math.abs(CUBE[best] - v) ? i : best), 0);
  const ci = 16 + 36 * near(r) + 6 * near(g) + near(b);
  const cc = [CUBE[near(r)], CUBE[near(g)], CUBE[near(b)]];
  const avg = Math.round((r + g + b) / 3); const gi = Math.max(0, Math.min(23, Math.round((avg - 8) / 10)));
  const gv = 8 + gi * 10;
  const d = (a) => (a[0] - r) ** 2 + (a[1] - g) ** 2 + (a[2] - b) ** 2;
  return d([gv, gv, gv]) < d(cc) ? 232 + gi : ci;
}
const BASIC = [[0, 0, 0], [205, 49, 49], [13, 188, 121], [229, 229, 16], [36, 114, 200], [188, 63, 188], [17, 168, 205], [229, 229, 229],
  [102, 102, 102], [241, 76, 76], [35, 209, 139], [245, 245, 67], [59, 142, 234], [214, 112, 214], [41, 184, 219], [255, 255, 255]];
function to16(rgb) {
  let best = 0, bd = Infinity;
  BASIC.forEach((c, i) => { const d = (c[0] - rgb[0]) ** 2 + (c[1] - rgb[1]) ** 2 + (c[2] - rgb[2]) ** 2; if (d < bd) { bd = d; best = i; } });
  return best;
}
function colorCode(c, depth, bg) {
  const rgb = hex(c);
  if (depth === 24) return `${bg ? 48 : 38};2;${rgb.join(';')}`;
  if (depth === 8) return `${bg ? 48 : 38};5;${to256(rgb)}`;
  const i = to16(rgb); return String((i < 8 ? 30 : 90) + (i % 8) + (bg ? 10 : 0));
}

/** The style object for a name or object, with the line background merged in (a segment's own bg wins). */
export function resolve(style, depth, bg) {
  const base = typeof style === 'string' ? ((depth === 0 && MONO[style]) || THEME[style] || {}) : (style ?? {});
  if (!bg) return base;
  const back = typeof bg === 'string' ? ((depth === 0 && MONO[bg]) || THEME[bg] || {}) : bg;
  return { ...back, ...base, bg: base.bg ?? back.bg, fg: base.fg ?? back.fg, reverse: base.reverse || back.reverse };
}

/** The SGR escape that sets exactly this style from a reset state ('' for the plain style). */
export function sgr(st, depth) {
  const p = [];
  if (st.bold) p.push('1'); if (st.dim) p.push('2'); if (st.italic) p.push('3'); if (st.underline) p.push('4'); if (st.reverse) p.push('7');
  if (depth > 0 && st.fg) p.push(colorCode(st.fg, depth, false));
  if (depth > 0 && st.bg) p.push(colorCode(st.bg, depth, true));
  return p.length ? `\x1b[${p.join(';')}m` : '';
}
