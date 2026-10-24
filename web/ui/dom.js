// DOM helpers. No framework, no innerHTML with data: h() builds elements and
// every string becomes a text node.
import { homeList, tildeWith } from './paths.js';

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}
export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
export function frag(...children) { return append(document.createDocumentFragment(), children); }

// ---------------------------------------------------------------- time
export function toDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return v;
  if (typeof v === 'number' || /^\d+(\.\d+)?$/.test(String(v))) { let n = Number(v); if (n < 1e11) n *= 1000; return new Date(n); }
  const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d;
}
export function toMs(v) { const d = toDate(v); return d ? d.getTime() : 0; }
export function fmtTime(v) {
  const d = toDate(v); if (!d) return '';
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
export function fmtAgo(v, { short = true } = {}) {
  const d = toDate(v); if (!d) return '';
  const s = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
  if (s < 45) return short ? `${s}s` : `${s} seconds ago`;
  const m = Math.round(s / 60); if (m < 60) return short ? `${m}m` : `${m} min ago`;
  const hh = Math.round(m / 60); if (hh < 48) return short ? `${hh}h` : `${hh} hours ago`;
  const dd = Math.round(hh / 24); return short ? `${dd}d` : `${dd} days ago`;
}
/** <time> that re-renders itself every 30 s while attached. */
export function ago(v, opts) {
  const t = h('time', { datetime: toDate(v)?.toISOString() ?? '', title: toDate(v)?.toLocaleString() ?? '' }, fmtAgo(v, opts));
  tickers.add({ el: t, v, opts });
  return t;
}
const tickers = new Set();
setInterval(() => { for (const x of tickers) { if (!x.el.isConnected) { tickers.delete(x); continue; } x.el.textContent = fmtAgo(x.v, x.opts); } }, 30_000).unref?.();   // unref: lets node --test import UI modules

// ---------------------------------------------------------------- text
export function matchQ(obj, q) {
  const words = String(q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = JSON.stringify(obj).toLowerCase();
  return words.every((w) => hay.includes(w));
}
export function debounce(fn, ms) { let t = null; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
export function short(s, n = 8) { return s ? String(s).slice(0, n) : ''; }
// Homes written as ~: the front daemon's own (host.list names it, app.js sets it), then any /Users/<name> or /home/<name>.
let homes = [];
export function setHomes(list) { homes = homeList(list); }
export function tildePath(p) { return tildeWith(homes, p); }
export function shortPath(p, max = 44) { if (!p) return ''; const s = tildePath(p); return s.length > max ? '…' + s.slice(-(max - 1)) : s; }
export function plural(n, one, many = one + 's') { return `${n} ${n === 1 ? one : many}`; }

// ---------------------------------------------------------------- marks
/** State -> color family. */
export function stateColor(state) {
  switch (String(state ?? '')) {
    case 'dialog': case 'waiting-on-user': case 'cut-off': case 'wait': case 'waiting': return 'amber';
    case 'busy': case 'active': case 'running': return 'steel';
    case 'idle': case 'ok': case 'up': case 'ready': case 'done': return 'moss';
    case 'dead': case 'exited': case 'crashed': case 'error': case 'down': case 'unreachable': return 'brick';
    default: return '';
  }
}
export function dot(state, { pulse = false } = {}) {
  const c = stateColor(state);
  return h('span', { class: `dot ${c === 'amber' ? 'wait' : c === 'steel' ? 'busy' : c === 'moss' ? 'idle' : c === 'brick' ? 'dead' : ''}${pulse ? ' pulse' : ''}`, 'aria-hidden': 'true' });
}
export function mark(state, label) { return h('span', { class: 'mark' }, dot(state), label ?? state ?? ''); }
export function engine(e) {
  const k = e === 'claude' ? 'CC' : e === 'codex' ? 'CX' : e === 'headless' ? 'HL' : e === 'openclaw' ? 'OC' : e === 'grok' ? 'GK' : e === 'shell' ? 'sh' : '??';
  return h('span', { class: `engine ${e ?? ''}`, title: e ?? '' }, k);
}
export function empty(title, hint) { return h('div', { class: 'empty' }, title ? h('b', null, title) : null, hint ?? ''); }
export function loading(msg = 'Loading') { return h('div', { class: 'pending' }, msg + '…'); }
export function kv(pairs) {
  const dl = h('dl', { class: 'kv' });
  for (const [k, v] of pairs) { if (v === null || v === undefined || v === '') continue; dl.append(h('dt', null, k), h('dd', null, v)); }
  return dl;
}
export function seg(options, value, onChange) {
  const el = h('div', { class: 'seg', role: 'group' });
  const draw = (val) => { clear(el); for (const [v, label] of options) el.append(h('button', { type: 'button', 'aria-pressed': v === val ? 'true' : 'false', onclick: () => { draw(v); onChange?.(v); } }, label)); };
  draw(value);
  return el;
}
export function chip(label, on, onClick, title) {
  return h('button', { class: 'chip', type: 'button', 'aria-pressed': on ? 'true' : 'false', title: title ?? null, onclick: onClick }, label);
}
export function btn(label, onClick, { cls = '', title, key, disabled } = {}) {
  return h('button', { class: `btn ${cls}`.trim(), type: 'button', title: title ?? null, disabled: disabled ? true : null, onclick: onClick }, label, key ? h('kbd', null, key) : null);
}
export function copyBtn(text, label = 'Copy') {
  return btn(label, async (e) => {
    const b = e.currentTarget;
    try { await navigator.clipboard.writeText(text); b.firstChild.textContent = 'Copied'; } catch { window.prompt('Copy:', text); return; }
    setTimeout(() => { b.firstChild.textContent = label; }, 1200);
  }, { cls: 'sm quiet' });
}
export function field(label, control, { wide = false } = {}) { return h('label', { class: `field${wide ? ' wide' : ''}` }, h('span', null, label), control); }
