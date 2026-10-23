// One-time carry-over of this browser's settings from the tool's old name:
// every localStorage key `apxw.<rest>` is copied to `drover.<rest>` when the new
// key is missing, so the token (and with it the login), the host, theme and view
// state survive the rename. Old keys are left in place. Imported first by app.js
// so it runs before any module reads storage.
const OLD = 'apxw.';
const NEW = 'drover.';

try {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k?.startsWith(OLD)) keys.push(k); }
  for (const k of keys) {
    const next = NEW + k.slice(OLD.length);
    if (localStorage.getItem(next) === null) localStorage.setItem(next, localStorage.getItem(k));
  }
} catch { /* storage blocked or full: start fresh, as on a new browser */ }
