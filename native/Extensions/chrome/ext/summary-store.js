// Chrome glue: the last native.summary the service worker fetched, shared via
// chrome.storage.session as { at, data: NormalizedSummary|null, error: {kind,message}|null }.
import { SESSION } from '../lib/settings.js';

/** @returns {Promise<{at:number, data:any, error:any}|null>} */
export async function readSummary() {
  const got = await chrome.storage.session.get(SESSION.SUMMARY);
  return got?.[SESSION.SUMMARY] ?? null;
}

/** Call cb(entry) whenever the service worker stores a new summary. Returns an unsubscribe function. */
export function onSummary(cb) {
  const fn = (changes, area) => { if (area === 'session' && changes[SESSION.SUMMARY]) cb(changes[SESSION.SUMMARY].newValue ?? null); };
  chrome.storage.onChanged.addListener(fn);
  return () => chrome.storage.onChanged.removeListener(fn);
}

/** Ask the service worker to poll now. Resolves with the fresh entry (or null if the worker did not answer). */
export async function requestRefresh() {
  try { const r = await chrome.runtime.sendMessage({ type: 'drover:refresh' }); return r?.summary ?? null; } catch { return null; }
}

/**
 * Hand a native.summary result that arrived on a page's stream to the service worker, which stores it and sets the
 * badge as a poll would: the board stays current without another fetch.
 */
export async function pushSummary(raw) {
  try { await chrome.runtime.sendMessage({ type: 'drover:summary', summary: raw }); } catch { /* worker asleep: the next poll catches up */ }
}

/** Tell the service worker that settings changed (reschedule, reset notification cursor, poll). */
export async function notifySettingsChanged() {
  try { await chrome.runtime.sendMessage({ type: 'drover:settings-changed' }); } catch { /* worker asleep: the next alarm picks it up */ }
}
