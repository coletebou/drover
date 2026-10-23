// Chrome glue: open the side panel on a session, optionally with a draft.
// chrome.sidePanel.open() must run inside the user gesture, so it is called
// first and synchronously; the target and draft are written to
// chrome.storage.session right after and the panel picks them up through
// storage.onChanged. Where there is no side panel (Safari, or no window/tab id),
// the same page opens in a small popup window with the target in its query.
import { SESSION } from '../lib/settings.js';

/**
 * @param {{ windowId?: number, tabId?: number }} ctx where the click happened
 * @param {{ host: string, id: string, name?: string, engine?: string }} target
 * @param {string} [text] draft to put in the compose box (not sent)
 */
export function openSessionPanel(ctx, target, text) {
  let opened = null;
  if (chrome.sidePanel?.open && (ctx?.tabId != null || ctx?.windowId != null)) {
    try { opened = chrome.sidePanel.open(ctx.tabId != null ? { tabId: ctx.tabId } : { windowId: ctx.windowId }); } catch { opened = null; }
  }
  const t = { host: target.host || 'local', id: target.id, name: target.name ?? '', engine: target.engine ?? '' };
  const writes = { [SESSION.PANEL_TARGET]: t };
  if (typeof text === 'string' && text) writes[SESSION.DRAFT] = { ...t, text, at: Date.now() };
  const stored = chrome.storage.session.set(writes);
  const fallback = () => openPanelWindow(t);
  if (!opened) return stored.then(fallback);
  return Promise.all([opened, stored]).then(() => undefined, fallback);
}

/** The side panel page as a popup window (query carries the target; the draft stays in storage). */
export function openPanelWindow(target) {
  const q = new URLSearchParams({ host: target.host || 'local', id: target.id, name: target.name ?? '', engine: target.engine ?? '' });
  const url = chrome.runtime.getURL(`sidepanel.html?${q}`);
  if (chrome.windows?.create) return chrome.windows.create({ url, type: 'popup', width: 440, height: 680 });
  return chrome.tabs.create({ url });
}
