// Desktop notification planning. Pure: no chrome.* here.
import { truncate } from './text.js';
import { dialogFields } from './answer.js';

const SEEN_CAP = 200;

/** Format is shared with the Safari app: drover|<host>|<sessionId>|<id>, each part URI-encoded. */
export function encodeNotificationId({ host, sessionId, id }) {
  return `drover|${encodeURIComponent(host || 'local')}|${encodeURIComponent(sessionId || '')}|${encodeURIComponent(id)}`;
}

export function decodeNotificationId(nid) {
  if (typeof nid !== 'string' || !nid.startsWith('drover|')) return null;
  const parts = nid.split('|');
  if (parts.length !== 4) return null;
  try {
    return { host: decodeURIComponent(parts[1]), sessionId: decodeURIComponent(parts[2]), id: decodeURIComponent(parts[3]) };
  } catch {
    return null;
  }
}

export function shouldShow(item, notify) {
  if (!notify?.enabled) return false;
  if (item?.test === true) return true;
  if (item?.kind === 'decision' || item?.kind === 'question' || item?.kind === 'finished') return notify[item.kind] === true;
  return false;
}

export function planNotifications({ cursor, seen, response, settings, max = 3 }) {
  const items = Array.isArray(response?.items) ? response.items.filter((i) => i && typeof i === 'object' && i.id != null) : [];
  const newCursor = typeof response?.cursor === 'string' && response.cursor ? response.cursor : (cursor ?? null);
  const prev = Array.isArray(seen) ? seen : [];
  const ids = items.map((i) => String(i.id));
  const nextSeen = [...prev, ...ids.filter((id) => !prev.includes(id))].slice(-SEEN_CAP);
  if (cursor == null) return { cursor: newCursor, seen: nextSeen, show: [], overflow: 0 };
  const seenSet = new Set(prev);
  const candidates = items.filter((i) => !seenSet.has(String(i.id)) && shouldShow(i, settings));
  const show = candidates.slice(-max);
  return { cursor: newCursor, seen: nextSeen, show, overflow: candidates.length - show.length };
}

/**
 * A dialog alert's two buttons (Chrome shows two): Approve (Enter) and Deny (Esc), or Deliver and Drop for a held
 * peer message, pressed with sessions.answer on the screen the alert was raised for. Only when the alert carries
 * a session, the screen hash and both keys; otherwise null (Reply and Open, as before).
 * @returns {{ id: string, host: string, hash: string, keys: string[], buttons: {title: string, key: string}[] } | null}
 */
export function dialogActions(item) {
  const f = dialogFields(item);
  if (!item?.sessionId || f.answer === 'reply' || !f.hash || !f.keys?.includes('Enter') || !f.keys.includes('Escape')) return null;
  const held = item.category === 'held';
  return {
    id: item.sessionId, host: item.host || 'local', hash: f.hash, keys: f.keys,
    buttons: [{ title: held ? 'Deliver (Enter)' : 'Approve (Enter)', key: 'Enter' }, { title: held ? 'Drop (Esc)' : 'Deny (Esc)', key: 'Escape' }],
  };
}

/**
 * What a dialog alert's buttons answer, remembered when it is shown: the session, the screen hash and the keys,
 * bound to `server`, the origin of the daemon that raised it (scheme, host and port: no token, no path).
 */
export function rememberDialog(item, server, at = Date.now()) {
  const d = dialogActions(item);
  return d && typeof server === 'string' && server ? { id: d.id, host: d.host, hash: d.hash, keys: d.keys, server, at } : null;
}

export const OTHER_SERVER = 'This alert came from a server this extension no longer uses. Nothing was sent.';

/**
 * The key a remembered dialog alert's button presses, only on the server that raised the alert: after the server
 * changes, an old alert's press would reach the new daemon. Button 0 is Enter (Approve, Deliver), 1 is Escape.
 * @returns {{key: string} | {refused: string}}
 */
export function dialogPress(remembered, index, origin) {
  if (!remembered?.server || remembered.server !== origin) return { refused: OTHER_SERVER };
  return { key: index === 0 ? 'Enter' : 'Escape' };
}

export function notificationOptions(item, { iconUrl }) {
  const o = {
    type: 'basic',
    iconUrl,
    title: truncate(item.title || 'Drover', 80),
    message: truncate(item.body || '', 200),
  };
  if (item.host && item.host !== 'local') o.contextMessage = item.host;
  o.priority = item.kind === 'decision' ? 2 : 1;
  o.requireInteraction = item.kind === 'decision' || item.kind === 'question';
  const dialog = dialogActions(item);
  if (dialog) o.buttons = dialog.buttons.map((b) => ({ title: b.title }));
  else if (item.sessionId) o.buttons = [{ title: 'Reply' }, { title: 'Open' }];
  o.silent = false;
  return o;
}

export function overflowOptions(n, { iconUrl }) {
  return { type: 'basic', iconUrl, title: 'Drover', message: n === 1 ? '1 more alert. Open the popup to see it.' : `${n} more alerts. Open the popup to see them.`, priority: 0 };
}
