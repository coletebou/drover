// Markdown for chat (assistant replies, manager answers): a small, safe renderer. Parsing is pure
// (parseBlocks, parseInline: tested in test/ui-markdown.test.js); rendering builds DOM nodes with h(),
// so no text ever becomes markup. Links open only http(s) and mailto; anything else stays text.
// Single newlines inside a paragraph are line breaks, as in GitHub comments: chat text means them.
import { h } from './dom.js';

const MAX_MD = 120_000;   // past this, a reply renders as plain text (a pasted log is not prose)
const FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*([^\s`]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/;
const TABLE_SEP = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const indentOf = (l) => l.match(/^ */)[0].length;
const blank = (l) => !l.trim();

/** Table cells of one row: split on unescaped pipes, the outer pipes dropped. */
export function splitRow(line) {
  let s = line.trim(); if (s.startsWith('|')) s = s.slice(1); if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = []; let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (s[i] === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}
const isTableStart = (lines, i) => lines[i]?.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-') && (lines[i + 1].includes('|') || splitRow(lines[i]).length === 1);
/** Does this line open a block that ends a paragraph? */
function startsBlock(lines, i) {
  const l = lines[i];
  return FENCE.test(l) || HEADING.test(l) || HR.test(l) || QUOTE.test(l) || (ITEM.test(l) && (ITEM.exec(l)[4] ?? '').trim() !== '') || isTableStart(lines, i);
}

/**
 * Block structure of a Markdown text: code (fenced; an unclosed fence runs to the end, as a reply mid-stream
 * does), heading, hr, quote, list (ordered or not, nested by indentation, task items), table, para.
 */
export function parseBlocks(src, depth = 0) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (blank(l)) { i++; continue; }
    let m;
    if ((m = l.match(FENCE))) {
      const [, ind, fence, lang] = m; const body = []; i++;
      const close = new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}[ \\t]*$`);
      while (i < lines.length && !close.test(lines[i])) { const x = lines[i]; body.push(x.slice(Math.min(ind.length, indentOf(x)))); i++; }
      if (i < lines.length) i++;   // the closing fence
      out.push({ type: 'code', lang: lang || null, text: body.join('\n') });
      continue;
    }
    if ((m = l.match(HEADING))) { out.push({ type: 'heading', level: m[1].length, text: (m[2] ?? '').replace(/[ \t]+#+$/, '') }); i++; continue; }
    if (HR.test(l)) { out.push({ type: 'hr' }); i++; continue; }
    if (QUOTE.test(l)) {
      const body = [];
      while (i < lines.length && !blank(lines[i]) && (m = lines[i].match(QUOTE) ?? (body.length && !startsBlock(lines, i) ? [null, lines[i].trim()] : null))) { body.push(m[1]); i++; }
      out.push({ type: 'quote', blocks: depth < 8 ? parseBlocks(body.join('\n'), depth + 1) : [{ type: 'para', text: body.join('\n') }] });
      continue;
    }
    if (isTableStart(lines, i)) {
      const head = splitRow(lines[i]);
      const align = splitRow(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /^-+:$/.test(c) ? 'right' : /^:-+$/.test(c) ? 'left' : null));
      const rows = []; i += 2;
      while (i < lines.length && !blank(lines[i]) && lines[i].includes('|')) { const r = splitRow(lines[i]); rows.push(head.map((_, k) => r[k] ?? '')); i++; }
      out.push({ type: 'table', head, align: head.map((_, k) => align[k] ?? null), rows });
      continue;
    }
    if ((m = l.match(ITEM)) && (m[4] ?? '').trim() !== '') { const r = parseList(lines, i, depth); out.push(r.block); i = r.next; continue; }
    // A paragraph: until a blank line or a line that opens a block.
    const body = [l.trim()]; i++;
    while (i < lines.length && !blank(lines[i]) && !startsBlock(lines, i)) { body.push(lines[i].trim()); i++; }
    out.push({ type: 'para', text: body.join('\n') });
  }
  return out;
}

function parseList(lines, i, depth) {
  const first = lines[i].match(ITEM);
  const ordered = /\d/.test(first[2]);
  const kind = ordered ? first[2].slice(-1) : first[2];
  const base = first[1].length;
  const items = []; let loose = false;
  const sibling = (m) => m && (m[4] ?? '').trim() !== '' && m[1].length <= base + 1 && /\d/.test(m[2]) === ordered && (ordered ? m[2].slice(-1) : m[2]) === kind;
  while (i < lines.length) {
    const m = lines[i].match(ITEM);
    if (!sibling(m)) break;
    const width = m[1].length + m[2].length + Math.min(Math.max((m[3] ?? ' ').length, 1), 4);
    let text = m[4]; let task = null;
    const t = text.match(/^\[([ xX])\][ \t]+(.*)$/); if (t) { task = t[1] !== ' '; text = t[2]; }
    const body = [text]; i++;
    let blanks = 0;
    while (i < lines.length) {
      const l = lines[i];
      if (blank(l)) { blanks++; body.push(''); i++; continue; }
      const ind = indentOf(l);
      if (ind >= width || (ind >= 2 && ind > base)) { body.push(l.slice(Math.min(ind, width))); if (blanks) loose = true; blanks = 0; i++; continue; }
      if (!blanks && !startsBlock(lines, i) && !ITEM.test(l)) { body.push(l.trim()); i++; continue; }   // lazy continuation
      break;
    }
    while (body.length > 1 && !body.at(-1).trim()) body.pop();
    if (blanks && i < lines.length && sibling(lines[i].match(ITEM))) loose = true;
    items.push({ task, blocks: depth < 8 ? parseBlocks(body.join('\n'), depth + 1) : [{ type: 'para', text: body.join('\n') }] });
  }
  return { block: { type: 'list', ordered, start: ordered ? parseInt(first[2], 10) : null, loose, items }, next: i };
}

// ---------------------------------------------------------------- inline
// Earliest match wins; on a tie, the first pattern in this list (code before emphasis, ** before *).
const INLINE = [
  ['code', /(`+)(?!`)([^`]|[^`][\s\S]{0,4000}?[^`])\1(?!`)/g],
  ['esc', /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g],
  ['auto', /<((?:https?:\/\/|mailto:)[^\s<>]+)>/g],
  ['link', /\[((?:[^[\]\\\n]|\\.){0,500})\]\(\s*<?((?:[^\s()<>\\]|\\.|\([^\s()]*\))+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g],
  ['url', /(?<![\w@/])(?:https?:\/\/|www\.)[^\s<>"'`]+/g],
  // Bounded spans: an unclosed marker costs one short scan, not a scan to the end of the text per marker.
  ['strong', /\*\*(?=\S)([\s\S]{0,2000}?\S)\*\*(?!\*)|(?<!\w)__(?=\S)([\s\S]{0,2000}?\S)__(?!\w)/g],
  ['del', /~~(?=\S)([\s\S]{0,2000}?\S)~~/g],
  ['em', /\*(?=[^\s*])([^*\n]{0,500}?[^\s*])\*(?!\*)|(?<!\w)_(?=[^\s_])([^\n]{0,500}?[^\s_])_(?!\w)/g],
];
/** A bare URL without the punctuation that ends its sentence; a closing paren stays when it closes one inside. */
export function trimUrl(u) {
  let s = u.replace(/[.,;:!?'"*_~]+$/, '');
  while (s.endsWith(')') && (s.match(/\(/g)?.length ?? 0) < (s.match(/\)/g)?.length ?? 0)) s = s.slice(0, -1).replace(/[.,;:!?'"*_~]+$/, '');
  return s;
}
/** Only http(s) and mailto become links. */
export function safeHref(href) {
  const s = String(href ?? '').trim().replace(/\\(.)/g, '$1');
  if (/^www\./i.test(s)) return `https://${s}`;
  return /^(https?:\/\/|mailto:)[^\s]+$/i.test(s) ? s : null;
}

/** Inline tokens: text, code, strong, em, del, link {href, children}; text keeps its newlines (the renderer breaks lines). */
export function parseInline(src, depth = 0) {
  const s = String(src ?? '');
  const out = [];
  const text = (v) => { if (!v) return; const last = out.at(-1); if (last?.t === 'text') last.v += v; else out.push({ t: 'text', v }); };
  let pos = 0;
  // Each pattern's next match, kept until the scan passes it: one regex pass per pattern, not one per token.
  const next = new Array(INLINE.length).fill(undefined);
  while (pos < s.length) {
    let best = null;
    for (let k = 0; k < INLINE.length; k++) {
      let c = next[k];
      if (c === null) continue;
      if (c === undefined || c.index < pos) { const re = INLINE[k][1]; re.lastIndex = pos; c = re.exec(s); next[k] = c ?? null; if (!c) continue; }
      if (!best || c.index < best.m.index) best = { t: INLINE[k][0], m: c };
    }
    if (!best) { text(s.slice(pos)); break; }
    const { t, m } = best;
    text(s.slice(pos, m.index));
    let end = m.index + m[0].length;
    const inner = (v) => (depth < 8 ? parseInline(v, depth + 1) : [{ t: 'text', v }]);
    if (t === 'code') out.push({ t: 'code', v: m[2].length > 2 && m[2].startsWith(' ') && m[2].endsWith(' ') && m[2].trim() ? m[2].slice(1, -1) : m[2] });
    else if (t === 'esc') text(m[1]);
    else if (t === 'auto') { const href = safeHref(m[1]); if (href) out.push({ t: 'link', href, children: [{ t: 'text', v: m[1].replace(/^mailto:/i, '') }] }); else text(m[0]); }
    else if (t === 'link') { const href = safeHref(m[2]); const kids = inner(m[1]); if (href) out.push({ t: 'link', href, children: kids.length ? kids : [{ t: 'text', v: href }] }); else out.push(...kids); }
    else if (t === 'url') { const u = trimUrl(m[0]); end = m.index + u.length; const href = safeHref(u); if (href && u.length > (u.startsWith('www.') ? 4 : 8)) out.push({ t: 'link', href, children: [{ t: 'text', v: u }] }); else text(u); }
    else out.push({ t, children: inner(m[1] ?? m[2] ?? '') });
    pos = end;
  }
  return out;
}

/** A Markdown text as plain words, for one-line excerpts (the dock's last reply): markers gone, blocks joined. */
export function mdText(src) {
  const inline = (toks) => toks.map((k) => (k.t === 'text' || k.t === 'code' ? k.v : inline(k.children ?? []))).join('');
  const block = (b) => (b.type === 'code' ? b.text : b.type === 'list' ? b.items.map((it) => it.blocks.map(block).join(' ')).join('; ') : b.type === 'quote' ? b.blocks.map(block).join(' ') : b.type === 'table' ? [b.head, ...b.rows].map((r) => r.map((c) => inline(parseInline(c))).join(' ')).join('; ') : b.type === 'hr' ? '' : inline(parseInline(b.text ?? '')));
  return parseBlocks(String(src ?? '').slice(0, 4000)).map(block).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------- render
function inlineNodes(tokens) {
  const out = [];
  for (const k of tokens) {
    if (k.t === 'text') { const parts = k.v.split('\n'); parts.forEach((p, i) => { if (i) out.push(h('br')); if (p) out.push(p); }); }
    else if (k.t === 'code') out.push(h('code', null, k.v));
    else if (k.t === 'link') out.push(h('a', { href: k.href, target: '_blank', rel: 'noopener noreferrer', title: k.href }, inlineNodes(k.children)));
    else out.push(h(k.t === 'strong' ? 'strong' : k.t === 'del' ? 'del' : 'em', null, inlineNodes(k.children)));
  }
  return out;
}
function blockNodes(blocks, { codeTools } = {}) {
  return blocks.map((b) => {
    switch (b.type) {
      case 'para': return h('p', null, inlineNodes(parseInline(b.text)));
      case 'heading': return h(`h${Math.min(6, b.level + 2)}`, { class: 'md-h' }, inlineNodes(parseInline(b.text)));
      case 'hr': return h('hr');
      case 'code': {
        const pre = h('pre', { class: 'md-code', 'data-lang': b.lang ?? null }, h('code', null, b.text));
        return codeTools ? h('div', { class: 'md-code-wrap' }, h('div', { class: 'md-code-bar' }, h('span', { class: 'md-lang' }, b.lang ?? ''), codeTools(b.text)), pre) : pre;
      }
      case 'quote': return h('blockquote', null, blockNodes(b.blocks, { codeTools }));
      case 'list': return h(b.ordered ? 'ol' : 'ul', { class: b.loose ? 'loose' : null, start: b.ordered && b.start !== 1 ? b.start : null },
        b.items.map((it) => h('li', { class: it.task === null ? null : 'task' }, it.task === null ? null : h('span', { class: `md-check${it.task ? ' done' : ''}`, 'aria-label': it.task ? 'done' : 'to do' }, it.task ? '☑' : '☐'), blockNodes(it.blocks, { codeTools }))));
      case 'table': return h('div', { class: 'md-table-wrap' }, h('table', { class: 'md-table' },
        h('thead', null, h('tr', null, b.head.map((c, k) => h('th', { style: b.align[k] ? { textAlign: b.align[k] } : null }, inlineNodes(parseInline(c)))))),
        h('tbody', null, b.rows.map((r) => h('tr', null, r.map((c, k) => h('td', { style: b.align[k] ? { textAlign: b.align[k] } : null }, inlineNodes(parseInline(c)))))))));
      default: return null;
    }
  });
}

/** A Markdown text as a DOM node (a div.md). codeTools(text) -> node adds a control (a copy button) to each code block. */
export function renderMarkdown(src, { codeTools } = {}) {
  const s = String(src ?? '');
  if (s.length > MAX_MD) return h('div', { class: 'md plain' }, s);
  return h('div', { class: 'md' }, blockNodes(parseBlocks(s), { codeTools }));
}
