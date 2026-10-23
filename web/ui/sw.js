// Drover service worker. Two jobs:
//  1. Notification actions (Approve / Deny / Reply / Open): a click focuses an
//     open Drover window (or opens one) and hands it the action; the page makes
//     the API call with its own token. The worker never sees or stores the token.
//  2. Offline shell: the static UI files are cached network-first so the app
//     opens when the daemon is restarting. Nothing under /api/ is ever cached or
//     even intercepted: those responses carry fleet state and are bearer-gated.
const SHELL = 'drover-shell-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.searchParams.has('token')) return;   // never touch API traffic
  if (!/\.(js|css|svg|html|webmanifest)$|\/$/.test(url.pathname)) return;
  event.respondWith((async () => {
    try {
      const res = await fetch(event.request, { cache: 'no-cache' });
      if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(event.request, copy)).catch(() => {}); }
      return res;
    } catch (e) {
      const hit = await caches.match(event.request, { ignoreSearch: true });
      if (hit) return hit;
      throw e;
    }
  })());
});

async function deliver(message) {
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  // Prefer a full Drover window over a pop-out or PiP opener.
  const main = wins.find((w) => !/#\/(pop|pip)\//.test(w.url) && !w.url.includes('#/pip')) ?? wins[0];
  if (main) {
    try { await main.focus(); } catch { /* focus needs a user gesture on some platforms; the click is one */ }
    main.postMessage(message);
    return;
  }
  // No window: open one; the page reads the action from the hash on boot.
  const payload = btoa(unescape(encodeURIComponent(JSON.stringify(message)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await self.clients.openWindow(`/#/act/${payload}`);
}

self.addEventListener('notificationclick', (event) => {
  const n = event.notification;
  const action = event.action || 'open';
  n.close();
  event.waitUntil(deliver({ type: 'drover-notification', action, data: n.data ?? {}, reply: typeof event.reply === 'string' ? event.reply : null }));
});
