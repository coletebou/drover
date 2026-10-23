// Settings and storage keys shared by every page and the service worker.
// Storage areas are injected (chrome.storage.local / chrome.storage.session or
// a fake in tests). The token lives in chrome.storage.local only, never sync.

/** chrome.storage.local keys (survive restarts). */
export const LOCAL = Object.freeze({
  SETTINGS: 'settings',
});

/** chrome.storage.session keys (memory only, gone when the browser quits). */
export const SESSION = Object.freeze({
  SUMMARY: 'summary',          // { at: ms, data: NormalizedSummary|null, error: {kind,message}|null }
  NOTIF_CURSOR: 'notifCursor', // string|null: native.notifications cursor; null = next poll is a baseline
  NOTIF_SEEN: 'notifSeen',     // string[]: item ids already shown (capped)
  DRAFT: 'draft',              // { host, id, name, text, at }: context menu hand-off to the side panel
  PANEL_TARGET: 'panelTarget', // { host, id, name, engine }: the session the side panel shows
  NOTIF_DIALOGS: 'notifDialogs', // { [notificationId]: { id, host, hash, keys, at } }: what a dialog alert's buttons answer
});

export const POLL_MINUTES = Object.freeze([1, 2, 5, 10]);

export const DEFAULTS = Object.freeze({
  baseUrl: '',
  token: '',
  actor: 'chrome',
  pollMinutes: 1,
  notify: Object.freeze({ enabled: true, decision: true, question: true, finished: false }),
});

/**
 * Fill gaps and drop junk so callers can trust the shape.
 * @param {any} raw @returns {{baseUrl:string, token:string, actor:string, pollMinutes:number, notify:{enabled:boolean, decision:boolean, question:boolean, finished:boolean}}}
 */
export function normalizeSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const n = r.notify && typeof r.notify === 'object' ? r.notify : {};
  const bool = (v, d) => (typeof v === 'boolean' ? v : d);
  const actor = typeof r.actor === 'string' && /^[\w .()@-]{1,40}$/.test(r.actor.trim()) ? r.actor.trim() : DEFAULTS.actor;
  return {
    baseUrl: typeof r.baseUrl === 'string' ? r.baseUrl.trim() : '',
    token: typeof r.token === 'string' ? r.token.trim() : '',
    actor,
    pollMinutes: POLL_MINUTES.includes(r.pollMinutes) ? r.pollMinutes : DEFAULTS.pollMinutes,
    notify: {
      enabled: bool(n.enabled, DEFAULTS.notify.enabled),
      decision: bool(n.decision, DEFAULTS.notify.decision),
      question: bool(n.question, DEFAULTS.notify.question),
      finished: bool(n.finished, DEFAULTS.notify.finished),
    },
  };
}

/** True when both a server URL and a token are set. */
export function isConfigured(s) {
  return Boolean(s?.baseUrl && s?.token);
}

/** @param {{get: Function}} area chrome.storage.local */
export async function loadSettings(area) {
  const got = await area.get(LOCAL.SETTINGS);
  return normalizeSettings(got?.[LOCAL.SETTINGS]);
}

let saving = Promise.resolve();

/**
 * Merge a patch into the stored settings. Keys whose value is undefined are left
 * as stored (so "keep the token" re-reads storage instead of a stale copy), and
 * saves from one page or worker run one at a time so they cannot overwrite each other.
 * @param {{get: Function, set: Function}} area
 */
export function saveSettings(area, patch) {
  const run = saving.then(async () => {
    const p = Object.fromEntries(Object.entries(patch ?? {}).filter(([, v]) => v !== undefined));
    const cur = await loadSettings(area);
    const next = normalizeSettings({ ...cur, ...p, notify: { ...cur.notify, ...(p.notify ?? {}) } });
    await area.set({ [LOCAL.SETTINGS]: next });
    return next;
  });
  saving = run.catch(() => {});
  return run;
}

/** Settings safe to hand to UI code that only needs to know whether a token exists. */
export function redacted(s) {
  return { ...s, token: s.token ? '[redacted]' : '' };
}
