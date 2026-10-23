// Chrome glue: one poll tick (summary, badge, menus, notifications) and the alarm.
import { SESSION, loadSettings, isConfigured } from '../lib/settings.js';
import { normalizeSummary } from '../lib/summary.js';
import { badgeFor } from '../lib/badge.js';
import { getClient, errorInfo } from '../ext/client.js';
import { refreshMenus } from './menus.js';
import { pollNotifications } from './notifications.js';

export const ALARM = 'drover-poll';

async function applyBadge(entry, configured) {
  const b = badgeFor({ configured, data: entry.data, error: entry.error });
  try {
    await chrome.action.setBadgeText({ text: b.text });
    await chrome.action.setBadgeBackgroundColor({ color: b.color });
    if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: b.textColor });
    await chrome.action.setTitle({ title: b.title });
  } catch { /* badge is best effort */ }
}

async function run() {
  const settings = await loadSettings(chrome.storage.local);
  const configured = isConfigured(settings);
  const prev = (await chrome.storage.session.get(SESSION.SUMMARY))[SESSION.SUMMARY];
  let entry;
  let fetched = false;
  let client = null;
  try {
    ({ client } = await getClient());
    const raw = await client.op('native.summary');
    entry = { at: Date.now(), data: normalizeSummary(raw), error: null };
    fetched = true;
  } catch (err) {
    entry = { at: Date.now(), data: prev?.data ?? null, error: errorInfo(err) };
  }
  await chrome.storage.session.set({ [SESSION.SUMMARY]: entry });
  await applyBadge(entry, configured);
  try { await refreshMenus(entry.data); } catch { /* a menu failure never breaks polling */ }
  if (fetched && settings.notify.enabled) {
    try { await pollNotifications(client, settings); } catch { /* older daemon (unknown op) or transient error */ }
  }
  return entry;
}

/**
 * A summary a page received on its stream (topics summary): stored and shown like a fetched one, no request.
 * Only while the settings are complete; never replaces a newer entry.
 */
export async function applyStreamedSummary(raw) {
  const settings = await loadSettings(chrome.storage.local);
  const configured = isConfigured(settings);
  if (!configured || !raw || typeof raw !== 'object') return null;
  const entry = { at: Date.now(), data: normalizeSummary(raw), error: null };
  await chrome.storage.session.set({ [SESSION.SUMMARY]: entry });
  await applyBadge(entry, configured);
  try { await refreshMenus(entry.data); } catch { /* best effort */ }
  return entry;
}

/** The alert feed now (an alerts event arrived on the worker's stream), as a poll tick would check it. */
export async function checkNotifications() {
  const settings = await loadSettings(chrome.storage.local);
  if (!isConfigured(settings) || !settings.notify.enabled) return null;
  const { client } = await getClient();
  return pollNotifications(client, settings);
}

let inFlight = null;

/** One poll at a time. `fresh` (after a settings change) never reuses a poll that started with the old settings. */
export function pollOnce({ fresh = false } = {}) {
  if (inFlight && !fresh) return inFlight;
  const start = () => run().finally(() => { if (inFlight === p) inFlight = null; });
  const p = inFlight ? inFlight.then(start, start) : start();
  inFlight = p;
  return p;
}

export async function scheduleAlarm() {
  const settings = await loadSettings(chrome.storage.local);
  await chrome.alarms.create(ALARM, { periodInMinutes: settings.pollMinutes, delayInMinutes: settings.pollMinutes });
}
