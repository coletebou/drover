// Service worker: listeners are registered synchronously at top level.
import { pollOnce, scheduleAlarm, applyStreamedSummary, checkNotifications, ALARM } from './bg/poll.js';
import { ensureStream, stopStream } from './bg/stream.js';
import { registerNotificationHandlers, resetNotificationCursor } from './bg/notifications.js';
import { registerMenus } from './bg/menus.js';
import { registerOmnibox } from './bg/omnibox.js';
import { loadSettings, isConfigured } from './lib/settings.js';

registerNotificationHandlers();
registerMenus();
registerOmnibox();

// The worker's stream (summary, alerts) while it is awake; the alarm wakes it, polls, and restarts the stream.
const streamHandlers = { onSummary: applyStreamedSummary, onAlerts: checkNotifications };
const tick = async () => { try { await scheduleAlarm(); await pollOnce(); ensureStream(streamHandlers); } catch { /* ignore */ } };

chrome.runtime.onInstalled.addListener(async (details) => {
  await tick();
  if (details?.reason === 'install') {
    try {
      if (!isConfigured(await loadSettings(chrome.storage.local))) chrome.runtime.openOptionsPage();
    } catch { /* ignore */ }
  }
});

chrome.runtime.onStartup.addListener(() => { tick(); });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name === ALARM) { pollOnce().catch(() => {}); ensureStream(streamHandlers); }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  if (msg?.type === 'drover:refresh') {
    ensureStream(streamHandlers);
    pollOnce().then((summary) => sendResponse({ ok: true, summary }), () => sendResponse({ ok: false }));
    return true;
  }
  if (msg?.type === 'drover:summary') {
    applyStreamedSummary(msg.summary).then((summary) => sendResponse({ ok: true, summary }), () => sendResponse({ ok: false }));
    return true;
  }
  if (msg?.type === 'drover:settings-changed') {
    (async () => {
      try {
        await resetNotificationCursor();
        await scheduleAlarm();
        stopStream();
        const summary = await pollOnce({ fresh: true });
        ensureStream(streamHandlers);
        sendResponse({ ok: true, summary });
      } catch { sendResponse({ ok: false }); }
    })();
    return true;
  }
  return false;
});
