// SSE topics (UX overhaul contract): each page asks only for the events it draws, instead of the whole fleet
// every 20 seconds. Pure.

/** The popup (and the badge it refreshes): the light summary, alerts and the manager's stream and turns. */
export const POPUP_TOPICS = Object.freeze(['summary', 'alerts', 'manager', 'turn']);
/** The side panel: transcript turns, the manager, and the compact board for its picker and answer card. */
export const PANEL_TOPICS = Object.freeze(['turn', 'manager', 'board']);

/** A daemon that honours topics echoes them in `hello`; one from before sends every event and no list. */
export function honoursTopics(hello) {
  return Array.isArray(hello?.topics);
}

/**
 * Route one SSE event for a page that asked for `topics`. Returns what the page should do:
 * `{ kind: 'summary'|'board'|'manager'|'turn'|'alerts'|'hello'|'legacy'|'ignore', data }`.
 * A daemon that ignored the topics also sends `fleet`, `snapshot`, `mutation` and the rest: those come back as
 * `legacy` (the page then refreshes the old way, debounced) only for the events that used to mean a change.
 */
export function routeEvent(name, data, topics) {
  if (name === 'hello') return { kind: 'hello', data };
  if (topics.includes(name)) {
    if (name === 'turn' && (!data || typeof data !== 'object' || !data.id || !data.turn)) return { kind: 'ignore' };
    if ((name === 'summary' || name === 'board') && (!data || typeof data !== 'object')) return { kind: 'ignore' };
    return { kind: name, data };
  }
  return ['mutation', 'notify', 'alerts', 'fleet', 'snapshot'].includes(name) ? { kind: 'legacy', data } : { kind: 'ignore' };
}
