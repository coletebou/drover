// Chat items (lib/chat.js chatItems) as DOM, textContent only. Tool groups are <details> (collapsed by default,
// kept open across repaints by their key); results show their first lines with "Show all" for the rest.
import { h } from './dom.js';
import { markdown } from './markdown.js';
import { resultPreview } from '../lib/chat.js';
import { ago } from '../lib/text.js';

/**
 * @param {any[]} items
 * @param {{ open: Set<string>, full: Set<string>, onToggle?: () => void }} state which groups are open and which
 *   results show in full (keys survive repaints)
 */
export function chatNodes(items, state) {
  return items.map((it) => {
    const time = it.ts ? h('time', { datetime: it.ts }, ago(it.ts)) : null;
    switch (it.type) {
      case 'user':
        return h('div', { class: `turn user${it.local ? ' local' : ''}` },
          h('div', { class: 'who' }, it.who === 'you' ? 'You' : it.who, time ? ' · ' : null, time),
          h('div', { class: 'body' }, it.text));
      case 'assistant':
        return h('div', { class: `turn assistant${it.pending ? ' streaming' : ''}` }, h('span', { class: 'sr-only' }, 'Agent'), markdown(it.text));
      case 'tools': return toolGroup(it, state);
      case 'system':
        return h('div', { class: `turn system${it.error ? ' error' : ''}`, role: it.error ? 'alert' : null }, it.text);
      case 'working':
        return h('div', { class: 'turn working', role: 'status' }, h('span', { class: 'dot working', 'aria-hidden': 'true' }), 'Working');
      default: return null;
    }
  });
}

function toolGroup(g, state) {
  const details = h('details', { class: `tools-group${g.error ? ' has-error' : ''}`, open: state.open.has(g.key) },
    h('summary', {}, g.label, g.error ? h('span', { class: 'err-mark' }, ` · ${g.errors > 1 ? `${g.errors} errors` : 'an error'}`) : null),
    h('ol', { class: 'calls' }, g.calls.map((c, i) => callRow(c, `${g.key}:${i}`, state))));
  details.addEventListener('toggle', () => { if (details.open) state.open.add(g.key); else state.open.delete(g.key); });
  return details;
}

function callRow(c, key, state) {
  const res = c.result;
  let resultNode = null;
  if (res && res.text) {
    const full = state.full.has(key);
    const p = resultPreview(res.text, 6);
    // The daemon sends at most 2000 characters of a result; `chars` is its whole length.
    const cut = Number.isFinite(res.chars) && res.chars > res.text.length;
    resultNode = h('div', { class: `result${res.isError ? ' error' : ''}` },
      res.isError ? h('span', { class: 'sr-only' }, 'Error: ') : null,
      h('pre', {}, full ? res.text : p.head),
      p.more ? h('button', {
        type: 'button', class: 'ghost show-all',
        onclick: () => { if (full) state.full.delete(key); else state.full.add(key); state.onToggle?.(); },
      }, full ? 'Show less' : 'Show all') : null,
      cut && (full || !p.more) ? h('span', { class: 'faint cut' }, `First ${res.text.length} of ${res.chars} characters`) : null);
  }
  return h('li', { class: 'call' },
    h('div', { class: 'call-head' }, h('span', { class: 'tool' }, c.name), c.summary ? h('span', { class: 'summary' }, c.summary) : null),
    c.description && c.description !== c.summary ? h('div', { class: 'desc' }, c.description) : null,
    resultNode);
}
