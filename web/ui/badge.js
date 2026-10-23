// The "waiting on you" count, shown three ways: a "(3)" prefix on the tab
// title, a count drawn onto the favicon, and navigator.setAppBadge for the
// installed app's dock icon. Each can be switched off in Settings.
const base = { title: document.title, href: document.querySelector('link[rel="icon"]')?.href ?? null };
let last = { n: -1, opts: '' };
let titleText = document.title;

export function setTitle(t) { titleText = t; paintTitle(); }
function paintTitle() { document.title = last.n > 0 && last.title ? `(${last.n}) ${titleText}` : titleText; }

function faviconWith(n) {
  const c = document.createElement('canvas'); c.width = 64; c.height = 64;
  const g = c.getContext('2d');
  // The app icon: graphite tile with the amber "needs you" dot.
  g.fillStyle = '#16191e'; roundRect(g, 0, 0, 64, 64, 14); g.fill();
  g.fillStyle = '#e2a73e'; g.beginPath(); g.arc(32, 32, 12, 0, Math.PI * 2); g.fill();
  if (n > 0) {
    const label = n > 99 ? '99+' : String(n);
    const w = label.length > 1 ? 44 : 34;
    g.fillStyle = '#de8c82'; roundRect(g, 64 - w, 0, w, 34, 17); g.fill();
    g.fillStyle = '#16191e'; g.font = 'bold 26px -apple-system, "SF Pro Text", Helvetica, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(label, 64 - w / 2, 18);
  }
  return c.toDataURL('image/png');
}
function roundRect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }

/** Paint the count. opts: { title, favicon, app } from settings.badge. */
export function setCount(n, opts = { title: true, favicon: true, app: true }) {
  const key = JSON.stringify(opts);
  if (n === last.n && key === last.opts) return;
  last = { n, opts: key, title: opts.title };
  paintTitle();
  const link = document.querySelector('link[rel="icon"]');
  if (link) link.href = opts.favicon && n > 0 ? faviconWith(n) : base.href;
  if ('setAppBadge' in navigator) {
    try { if (opts.app && n > 0) navigator.setAppBadge(n).catch(() => {}); else navigator.clearAppBadge?.().catch(() => {}); } catch { /* not installed or unsupported */ }
  }
}
