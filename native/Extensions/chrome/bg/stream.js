// Chrome glue: the service worker's own stream (topics summary and alerts). A summary event is stored and shown
// on the badge as a poll would be, with no request; an alerts event checks the notifications at once instead of
// on the next alarm. The stream lives as long as the worker does; the alarm restarts it and stays the fallback.
import { connectStream } from '../lib/sse.js';
import { routeEvent, honoursTopics } from '../lib/topics.js';
import { getClient } from '../ext/client.js';

export const BG_TOPICS = Object.freeze(['summary', 'alerts']);

let conn = null;
let starting = null;
let legacy = false;
let alertTimer = null;

/**
 * @param {{ onSummary: (raw: any) => Promise<any>, onAlerts: () => Promise<any>, onLegacy: () => Promise<any> }} handlers
 */
export function ensureStream(handlers) {
  if (conn || starting) return starting ?? Promise.resolve();
  starting = (async () => {
    try {
      const { client } = await getClient();
      conn = connectStream({
        request: client.streamRequest({ topics: BG_TOPICS }),
        fetch: globalThis.fetch.bind(globalThis),
        onEvent: (name, data) => {
          const r = routeEvent(name, data, BG_TOPICS);
          if (r.kind === 'hello') legacy = !honoursTopics(r.data);
          else if (r.kind === 'summary') handlers.onSummary(r.data).catch(() => {});
          else if (r.kind === 'alerts' || (legacy && r.kind === 'legacy' && name === 'notify')) {
            // Several alerts land together: one check for the lot.
            clearTimeout(alertTimer);
            alertTimer = setTimeout(() => { handlers.onAlerts().catch(() => {}); }, 400);
          }
        },
        onState: (state) => {
          // A rejected token or origin: stop until the settings change (the alarm keeps polling).
          if (state === 'error') stopStream();
        },
      });
    } catch { conn = null; /* not configured or no access: polling only */ }
    finally { starting = null; }
  })();
  return starting;
}

export function stopStream() {
  try { conn?.close(); } catch { /* ignore */ }
  conn = null;
  clearTimeout(alertTimer);
}

export const streamOpen = () => conn !== null;
