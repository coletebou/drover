// Chrome glue: "drover <session> <message>" in the address bar.
import { DEFAULT_SUGGESTION, escapeXml, suggestionsFor, resolveInput } from '../lib/omnibox.js';
import { targetSessions } from '../lib/summary.js';
import { sessionUrl } from '../lib/links.js';
import { readSummary } from '../ext/summary-store.js';
import { getClient } from '../ext/client.js';

export function registerOmnibox() {
  if (!chrome.omnibox) return;
  chrome.omnibox.setDefaultSuggestion({ description: escapeXml(DEFAULT_SUGGESTION) });
  chrome.omnibox.onInputChanged.addListener(async (text, suggest) => {
    try {
      const entry = await readSummary();
      suggest(suggestionsFor(targetSessions(entry?.data), text));
    } catch { suggest([]); }
  });
  chrome.omnibox.onInputEntered.addListener((text, disposition) => { handleEntered(text, disposition).catch(() => {}); });
}

function toast(message) {
  if (!chrome.notifications?.create) return;
  try {
    chrome.notifications.create(`drover|omnibox|${Date.now()}`, {
      type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon-128.png'), title: 'Drover', message: String(message).slice(0, 300),
    });
  } catch { /* ignore */ }
}

async function handleEntered(text, disposition) {
  try {
    const entry = await readSummary();
    const r = resolveInput(targetSessions(entry?.data), text);
    if (r.error) return toast(r.error);
    const { session, message } = r;
    const { client, settings } = await getClient();
    if (!message) {
      const url = sessionUrl(client.origin, session);
      if (disposition === 'currentTab') await chrome.tabs.update({ url });
      else await chrome.tabs.create({ url, active: disposition !== 'newBackgroundTab' });
      return;
    }
    const res = await client.op('sessions.message', { host: session.host, id: session.id, text: message, actor: settings.actor });
    toast(`Sent to ${session.name}${res?.queuedBehindTurn ? ' (queued, the session is busy)' : ''}`);
  } catch (e) {
    toast(e?.message ?? 'Something went wrong.');
  }
}
