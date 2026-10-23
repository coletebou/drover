// Markdown blocks and spans (lib/chat.js) as DOM, through textContent only: no HTML is ever parsed.
import { h } from './dom.js';
import { markdownBlocks, inlineSpans } from '../lib/chat.js';

/** Inline spans as nodes; a newline inside a paragraph is a line break. */
export function inline(text) {
  const out = [];
  for (const sp of inlineSpans(text)) {
    if (sp.t === 'code') out.push(h('code', {}, sp.v));
    else if (sp.t === 'b') out.push(h('strong', {}, sp.v));
    else if (sp.t === 'i') out.push(h('em', {}, sp.v));
    else if (sp.t === 'a') out.push(h('a', { href: sp.href, target: '_blank', rel: 'noopener noreferrer' }, sp.v));
    else sp.v.split('\n').forEach((part, i) => { if (i) out.push(h('br')); if (part) out.push(part); });
  }
  return out;
}

/** A Markdown text as a `div.md` of blocks. */
export function markdown(text, cls = 'md') {
  return h('div', { class: cls }, markdownBlocks(text).map((b) => {
    switch (b.type) {
      case 'h': return h(`h${Math.min(6, b.level + 2)}`, { class: 'md-h' }, inline(b.text));
      case 'code': return h('pre', { class: 'md-code' }, h('code', {}, b.text));
      case 'ul': return h('ul', {}, b.items.map((x) => h('li', {}, inline(x))));
      case 'ol': return h('ol', b.start && b.start !== 1 ? { start: String(b.start) } : {}, b.items.map((x) => h('li', {}, inline(x))));
      case 'quote': return h('blockquote', {}, inline(b.text));
      default: return h('p', {}, inline(b.text));
    }
  }));
}
