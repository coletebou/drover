// Chrome glue: context menus that hand a draft to the side panel. Never sends.
import { menuSpec, menuSignature, parseMenuId, composeText } from '../lib/menus.js';
import { targetSessions } from '../lib/summary.js';
import { openSessionPanel } from '../ext/panel.js';

const SIG_KEY = 'menuSig';
let lastSig = null;
let chain = Promise.resolve();

export function registerMenus() {
  if (!chrome.contextMenus) return;
  chrome.contextMenus.onClicked.addListener(onClick);
  chrome.runtime.onInstalled.addListener(() => { refreshMenus(null); });
}

export function refreshMenus(summary) {
  if (!chrome.contextMenus) return Promise.resolve();
  const run = chain.then(() => doRefresh(summary)).catch(() => {});
  chain = run;
  return run;
}

async function doRefresh(summary) {
  const spec = menuSpec(targetSessions(summary));
  const sig = menuSignature(spec);
  if (sig === lastSig) return;
  const stored = (await chrome.storage.session.get(SIG_KEY))?.[SIG_KEY];
  if (stored === sig && lastSig === null) { lastSig = sig; return; }
  await chrome.contextMenus.removeAll();
  for (const props of spec) {
    await new Promise((resolve) => {
      chrome.contextMenus.create(props, () => { void chrome.runtime.lastError; resolve(); });
    });
  }
  lastSig = sig;
  await chrome.storage.session.set({ [SIG_KEY]: sig });
}

function onClick(info, tab) {
  const parsed = parseMenuId(info?.menuItemId);
  if (!parsed) return;
  const text = composeText(parsed.parent, info);
  const ctx = { windowId: tab?.windowId, tabId: tab?.id };
  const target = parsed.pick ? { host: 'local', id: '', name: '' } : { host: parsed.host, id: parsed.sessionId };
  // Must be the first call, synchronously, to stay inside the user gesture.
  Promise.resolve(openSessionPanel(ctx, target, text)).catch(() => {});
}
