// Markdown-ish text to terminal rows: paragraphs (a source line break stays a line break, as agents mean it),
// headings, bullet and numbered lists with hanging indents, block quotes, fenced code (kept verbatim, broken at
// the width), rules, pipe tables (as written), and inline code, bold, italic, strikethrough and links. Rows are
// segment arrays (screen.js) no wider than the width. Pure; tests in test/tui-chat.test.js.
import { strWidth, clusters, clusterWidth, sanitize } from './width.js';
import { THEME } from './style.js';

/** Inline markup to segments [[text, style]]. base is the style of plain text. */
export function inline(text, base = null) {
  const out = [];
  const push = (t, st) => { if (!t) return; const last = out.at(-1); if (last && last[1] === st) last[0] += t; else out.push([t, st]); };
  const re = /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([^*\n]+?)\*\*|__([^_\n]+?)__|(?<![\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])|(?<![\w_])_(?!\s)([^_\n]+?)(?<!\s)_(?![\w_])|~~([^~\n]+?)~~|\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;
  let at = 0, m;
  while ((m = re.exec(text))) {
    push(text.slice(at, m.index), base);
    if (m[2] !== undefined) push(m[2].replace(/^ (.*) $/, '$1'), 'code');
    else if (m[3] ?? m[4]) push(m[3] ?? m[4], merge(base, 'bold'));
    else if (m[5] ?? m[6]) push(m[5] ?? m[6], merge(base, 'italic'));
    else if (m[7]) push(m[7], 'dim');
    else if (m[8]) { push(m[8], 'link'); if (m[9] !== m[8] && !/^#/.test(m[9])) push(` (${m[9]})`, 'dim'); }
    else if (m[10]) push(m[10], 'link');
    at = m.index + m[0].length;
  }
  push(text.slice(at), base);
  return out;
}
/** A style with one more attribute (bold inside a heading, italic inside a quote). */
function merge(base, extra) {
  if (!base) return extra;
  return { ...(typeof base === 'string' ? THEME[base] : base), ...THEME[extra] };
}

/**
 * Styled segments wrapped to width: words move whole to the next line, a word longer than a line is broken.
 * first is the prefix of the first row (a bullet), rest the prefix of the others (its hanging indent).
 */
export function wrapSegs(segs, width, { first = [], rest = [] } = {}) {
  const rows = [];
  const pw = (p) => p.reduce((w, [t]) => w + strWidth(t), 0);
  // Every row gets its own copies of the prefix segments: add() appends to the last segment, and a shared one would
  // carry each continuation row's words into the next.
  let row = first.map((s) => [...s]), used = pw(first);
  const newRow = () => { rows.push(trimEnd(row)); row = rest.map((s) => [...s]); used = pw(rest); };
  const add = (t, st) => { const last = row.at(-1); if (last && last[1] === st) last[0] += t; else row.push([t, st]); used += strWidth(t); };
  let lineHasText = false;
  for (const [text, st] of segs) {
    for (const tok of String(text).split(/(\s+)/)) {
      if (!tok) continue;
      const tw = strWidth(tok);
      if (/^\s/.test(tok)) { if (lineHasText && used + tw <= width) add(tok, st); else if (lineHasText) { newRow(); lineHasText = false; } continue; }
      if (lineHasText && used + tw > width) { newRow(); lineHasText = false; }
      if (used + tw <= width) { add(tok, st); lineHasText = true; continue; }
      // A word longer than the room: break it by clusters.
      for (const g of clusters(tok)) {
        const cw = clusterWidth(g);
        if (used + cw > width && lineHasText) { newRow(); lineHasText = false; }
        add(g, st); lineHasText = true;
      }
    }
  }
  rows.push(trimEnd(row));
  return rows;
}
function trimEnd(row) {
  const r = row.map((s) => [...s]);
  while (r.length && /^\s*$/.test(r.at(-1)[0]) && r.length > 1) r.pop();
  if (r.length) r[r.length - 1][0] = r.at(-1)[0].trimEnd();
  return r;
}

/** Rows for one hard-broken line of verbatim text (code, pane text). */
function verbatim(line, width, prefix, style) {
  const rows = []; let row = [...prefix], used = prefix.reduce((w, [t]) => w + strWidth(t), 0), cur = '';
  const start = used;
  for (const g of clusters(line)) {
    const cw = clusterWidth(g);
    if (used + cw > width && cur) { row.push([cur, style]); rows.push(row); row = [...prefix]; used = start; cur = ''; }
    cur += g; used += cw;
  }
  row.push([cur, style]); rows.push(row);
  return rows;
}

/** Markdown text to rows no wider than width. indent prefixes every row (the chat's left margin). */
export function renderMarkdown(text, width, { indent = '', base = null } = {}) {
  const ind = indent ? [[indent]] : [];
  const w = Math.max(8, width);
  const rows = [];
  const lines = sanitize(text).split('\n');
  let blank = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^(\s*)(```+|~~~+)\s*([\w+#.-]*)\s*$/);
    if (fence) {
      const close = fence[2][0].repeat(fence[2].length);
      const code = [];
      for (i++; i < lines.length && !new RegExp(`^\\s*${close[0] === '`' ? '`' : '~'}{${close.length},}\\s*$`).test(lines[i]); i++) code.push(lines[i].slice(Math.min(fence[1].length, lines[i].length - lines[i].trimStart().length)));
      if (fence[3]) rows.push([...ind, ['  ', null], [fence[3], 'dim']]);
      for (const c of code) rows.push(...verbatim(c, w, [...ind, ['  ', null]], 'code'));
      blank = false; continue;
    }
    if (!line.trim()) { if (!blank && rows.length) rows.push([...ind]); blank = true; continue; }
    blank = false;
    const h = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) { rows.push(...wrapSegs(inline(h[2], h[1].length <= 2 ? 'accentBold' : 'bold'), w, { first: ind, rest: ind })); continue; }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { rows.push([...ind, ['─'.repeat(Math.max(1, w - strWidth(indent))), 'dim']]); continue; }
    const q = line.match(/^\s*>\s?(.*)$/);
    if (q) { rows.push(...wrapSegs(inline(q[1], 'dim'), w, { first: [...ind, ['│ ', 'dim']], rest: [...ind, ['│ ', 'dim']] })); continue; }
    const li = line.match(/^(\s*)([-*+]|\d{1,3}[.)])\s+(\[[ xX]\]\s+)?(.*)$/);
    if (li) {
      const depth = Math.floor(li[1].replace(/\t/g, '    ').length / 2);
      const pad = '  '.repeat(Math.min(depth, 6));
      const mark = /^\d/.test(li[2]) ? `${li[2]} ` : li[3] ? (/x/i.test(li[3]) ? '☑ ' : '☐ ') : '• ';
      const firstP = [...ind, [pad, null], [mark, /^\d/.test(li[2]) ? 'dim' : 'accent']];
      rows.push(...wrapSegs(inline(li[4], base), w, { first: firstP, rest: [...ind, [pad + ' '.repeat(strWidth(mark)), null]] }));
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const sep = /^\s*\|[\s:|-]+\|\s*$/.test(line);
      rows.push(...verbatim(sep ? line.replace(/[-:]/g, '─').replace(/\|/g, '┼') : line.trim(), w, ind, sep ? 'dim' : null));
      continue;
    }
    const lead = line.match(/^\s*/)[0];
    rows.push(...wrapSegs(inline(line.trimStart(), base), w, { first: [...ind, [lead, null]], rest: [...ind, [lead, null]] }));
  }
  while (rows.length && rows.at(-1).every(([t]) => !t || !t.trim()) && rows.length > 1) rows.pop();
  return rows;
}
