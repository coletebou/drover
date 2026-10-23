// Small text helpers shared by pages, notifications, menus and the omnibox.

/** Cut to max characters on a word boundary when possible, with an ellipsis. */
export function truncate(s, max) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  if (t[max - 1] === ' ') return `${cut}…`; // the cut already ends on a word
  const sp = cut.lastIndexOf(' ');
  return `${sp > max * 0.6 ? cut.slice(0, sp) : cut}…`;
}

/** "now", "4m", "3h", "2d" since an ISO time. Empty string when unknown. */
export function ago(iso, now = Date.now()) {
  const t = Date.parse(iso ?? '');
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
}

/** Labels for waiting kinds (sentence case). */
export const KIND_LABEL = Object.freeze({ decision: 'Needs a decision', question: 'Asked a question', finished: 'Finished' });

/** Plural helper: plural(2, 'session') -> "2 sessions". */
export function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}
