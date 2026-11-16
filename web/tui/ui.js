// Small row builders the views share: rules, key hints, key/value rows, ages, scrolling a list to keep the
// selection in view, and padding a block of rows to a height. Rows are screen.js rows. Pure.
import { strWidth, truncate, fit, oneLine, padStart } from './width.js';
import { rowWidth } from './screen.js';
import { homeList, tildeWith } from '../ui/paths.js';

/** A rule across the width with an optional label: "── label ─────". */
export function rule(width, label = '', style = 'dim', right = '') {
  const l = label ? `── ${label} ` : '';
  const r = right ? ` ${right} ──` : '';
  const fill = Math.max(0, width - strWidth(l) - strWidth(r));
  return [[l + '─'.repeat(fill) + r, style]];
}

/** Footer hint segments from [key, what] pairs: "j/k move · Enter open". */
export function hints(pairs) {
  const segs = [];
  pairs.filter(Boolean).forEach(([k, what], i) => { if (i) segs.push(['  ', 'barDim']); segs.push([k, 'barKey'], [` ${what}`, 'bar']); });
  return segs;
}

/**
 * The key event a footer hint (or a key drawn on a dialog) names, for a click on it to press; null for one that names
 * a range or a group ("j/k", "1-9", "←→", "PgUp/PgDn", "[ ]"), which no single click can mean.
 */
export function hintKey(label) {
  const t = String(label ?? '').trim();
  const named = { Enter: 'enter', Esc: 'escape', Escape: 'escape', Tab: 'tab', Space: 'space', '/help': 'f1', F1: 'f1', PgUp: 'pgup', PgDn: 'pgdn' }[t];
  if (named) return { name: named, id: named, ctrl: false, alt: false, shift: false };
  const c = t.match(/^C-([a-z])$/);
  if (c) return { name: c[1], id: `C-${c[1]}`, ctrl: true, alt: false, shift: false };
  if (/^[!-~]$/.test(t)) return { name: t, ch: t, id: t, ctrl: false, alt: false, shift: t !== t.toLowerCase() };
  return null;
}

/** The [start, end) columns of each segment of a row drawn from column x. */
export function spansOf(segs, x = 0) {
  return segs.map(([t]) => { const w = strWidth(String(t ?? '')); const span = [x, x + w]; x += w; return span; });
}

/** The first region { x0, x1, ... } holding column x, or null. */
export const hitAt = (regions, x) => (regions ?? []).find((r) => x >= r.x0 && x < r.x1) ?? null;

/** Key/value rows: keys padded to one column, values cut to the width (or wrapped when wrap is set). */
export function kvRows(pairs, width, { keyWidth } = {}) {
  const shown = pairs.filter(([, v]) => v !== null && v !== undefined && v !== '');
  const kw = keyWidth ?? Math.min(18, Math.max(4, ...shown.map(([k]) => strWidth(k))) + 2);
  return shown.map(([k, v, st]) => [[fit(k, kw), 'dim'], [truncate(oneLine(typeof v === 'object' ? JSON.stringify(v) : String(v)), Math.max(1, width - kw)), st ?? null]]);
}

/** "3s", "4m", "2h", "5d": how long ago ts was. */
export function ago(ts, now = Date.now()) {
  const n = typeof ts === 'number' ? (ts < 1e11 ? ts * 1000 : ts) : Date.parse(ts ?? '');
  if (!Number.isFinite(n) || !n) return '';
  const s = Math.max(0, Math.round((now - n) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 172800 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
}

/** The first visible index that keeps `sel` inside a window of `height` rows over `total` (top is the old one). */
export function keepVisible(sel, top, height, total) {
  if (height <= 0) return 0;
  let t = Math.max(0, Math.min(top, Math.max(0, total - height)));
  if (sel < t) t = sel;
  if (sel >= t + height) t = sel - height + 1;
  return Math.max(0, t);
}

/** rows cut or padded to exactly h rows. */
export function block(rows, h) {
  const out = rows.slice(0, Math.max(0, h));
  while (out.length < h) out.push([]);
  return out;
}

/** Two blocks side by side: left at lw columns (a selected row keeps its background there), a divider, right. */
export function sideBySide(left, right, lw, width, h) {
  const out = [];
  const rw = Math.max(1, width - lw - 3);
  for (let i = 0; i < h; i++) {
    const l = left[i] ?? []; const r = right[i] ?? [];
    const bg = Array.isArray(l) ? null : l.bg ?? null;
    const lsegs = cut(Array.isArray(l) ? l : l.segs ?? [], lw);
    const pad = Math.max(0, lw - rowWidth(lsegs));
    out.push([...lsegs.map(([t, st]) => [t, st, bg]), ...(pad ? [[' '.repeat(pad), null, bg]] : []), [' │ ', 'dim'], ...cut(Array.isArray(r) ? r : r.segs ?? [], rw)]);
  }
  return out;
}
/** Segments cut to w columns (the last one ends in an ellipsis when cut). */
export function cut(segs, w) {
  const out = []; let used = 0;
  for (const [t, st] of segs) {
    if (used >= w) break;
    const s = String(t ?? ''); const sw = strWidth(s);
    if (used + sw <= w) { out.push([s, st]); used += sw; } else { out.push([truncate(s, w - used), st]); used = w; }
  }
  return out;
}

/** A number right-aligned in n columns, blank for null. */
export const num = (v, n) => padStart(v == null ? '' : String(v), n);
// Home paths shortened to ~: under the front daemon's own home (host.list names it, app.js sets it), or any /Users/<name> or
// /home/<name>.
let homes = [];
export function setHomes(list) { homes = homeList(list); }
export const tilde = (p) => tildeWith(homes, p);
