// Chrome glue for desktop notifications.
import { SESSION } from '../lib/settings.js';
import { planNotifications, notificationOptions, overflowOptions, encodeNotificationId, decodeNotificationId, rememberDialog, dialogPress } from '../lib/notify.js';
import { pressKey } from '../lib/answer.js';
import { sessionUrl } from '../lib/links.js';
import { getClient } from '../ext/client.js';
import { openPanelWindow } from '../ext/panel.js';

const OVERFLOW_ID = 'drover|overflow';

export async function pollNotifications(client, settings) {
  const got = await chrome.storage.session.get([SESSION.NOTIF_CURSOR, SESSION.NOTIF_SEEN]);
  const cursor = typeof got[SESSION.NOTIF_CURSOR] === 'string' ? got[SESSION.NOTIF_CURSOR] : null;
  const seen = Array.isArray(got[SESSION.NOTIF_SEEN]) ? got[SESSION.NOTIF_SEEN] : [];
  const response = await client.op('native.notifications', cursor ? { since: cursor, limit: 50 } : { limit: 50 });
  const plan = planNotifications({ cursor, seen, response, settings: settings.notify });
  const writes = { [SESSION.NOTIF_SEEN]: plan.seen };
  if (plan.cursor != null) writes[SESSION.NOTIF_CURSOR] = plan.cursor;
  await chrome.storage.session.set(writes);
  if (!chrome.notifications?.create) return plan;
  const iconUrl = chrome.runtime.getURL('icons/icon-128.png');
  const dialogs = {};
  for (const item of plan.show) {
    const nid = encodeNotificationId({ host: item.host, sessionId: item.sessionId, id: item.id });
    // Bound to the daemon that raised it, so a press after a server change is refused, not sent to the new one.
    const d = rememberDialog(item, client.origin);
    if (d) dialogs[nid] = d;
    chrome.notifications.create(nid, notificationOptions(item, { iconUrl }));
  }
  if (Object.keys(dialogs).length) await rememberDialogs(dialogs);
  if (plan.overflow > 0) chrome.notifications.create(OVERFLOW_ID, overflowOptions(plan.overflow, { iconUrl }));
  return plan;
}

/** What each dialog alert's buttons answer, kept across service worker restarts (capped, newest kept). */
async function rememberDialogs(add) {
  const got = (await chrome.storage.session.get(SESSION.NOTIF_DIALOGS))[SESSION.NOTIF_DIALOGS] ?? {};
  const all = Object.entries({ ...got, ...add }).sort((a, b) => (a[1]?.at ?? 0) - (b[1]?.at ?? 0)).slice(-50);
  await chrome.storage.session.set({ [SESSION.NOTIF_DIALOGS]: Object.fromEntries(all) });
}

async function dialogFor(nid) {
  const got = (await chrome.storage.session.get(SESSION.NOTIF_DIALOGS))[SESSION.NOTIF_DIALOGS] ?? {};
  return got[nid] ?? null;
}

function toast(message) {
  try {
    chrome.notifications.create(`drover|answer|${Date.now()}`, { type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon-128.png'), title: 'Drover', message: String(message).slice(0, 300) });
  } catch { /* ignore */ }
}

export function resetNotificationCursor() {
  return chrome.storage.session.remove(SESSION.NOTIF_CURSOR);
}

async function openInWeb(target) {
  const { client } = await getClient();
  await chrome.tabs.create({ url: sessionUrl(client.origin, { host: target.host, id: target.sessionId }) });
}

/**
 * A notification button: a dialog alert's Approve (Enter) or Deny (Esc), only on the server that raised it and
 * only on the screen it was raised for; other alerts' Reply (the side panel) and Open (the web UI). Returns what
 * happened, for the dev harness (tools/headless.mjs drives it from a page).
 */
export async function handleButton(nid, index) {
  let result = null;
  try {
    const t = decodeNotificationId(nid);
    if (!t || !t.sessionId) return null;
    const dialog = await dialogFor(nid);
    if (dialog) {
      const { client, settings } = await getClient();
      const press = dialogPress(dialog, index, client.origin);
      if (press.refused) { toast(press.refused); result = { ok: false, message: press.refused }; }
      else {
        result = await pressKey(client, dialog, press.key, { actor: settings.actor });
        if (!result.ok) { toast(result.message); await openPanelWindow({ host: t.host, id: t.sessionId }); }
      }
    } else if (index === 0) await openPanelWindow({ host: t.host, id: t.sessionId });
    else if (index === 1) await openInWeb(t);
  } catch (e) { toast(e?.message ?? 'That did not work.'); result = { ok: false, message: e?.message ?? 'That did not work.' }; }
  try { chrome.notifications.clear(nid); } catch { /* ignore */ }
  return result;
}

export function registerNotificationHandlers() {
  if (!chrome.notifications) return;
  chrome.notifications.onButtonClicked?.addListener((nid, index) => { handleButton(nid, index); });
  chrome.notifications.onClicked?.addListener(async (nid) => {
    try {
      if (nid === OVERFLOW_ID) {
        try { await chrome.action.openPopup?.(); } catch { /* needs a focused window */ }
      } else {
        const t = decodeNotificationId(nid);
        if (t?.sessionId) await openInWeb(t);
      }
    } catch { /* ignore */ }
    try { chrome.notifications.clear(nid); } catch { /* ignore */ }
  });
}
