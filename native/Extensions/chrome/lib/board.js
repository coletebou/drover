// Pure view model for the popup board. No chrome.*, no DOM.
import { sessionKey } from './summary.js';
import { ago, KIND_LABEL } from './text.js';

/**
 * @param {{at:number, data:any, error:any}|null} entry the stored summary entry
 * @param {number} [now]
 */
export function boardModel(entry, now = Date.now()) {
  const data = entry?.data ?? null;
  const error = entry?.error ?? null;
  const status = !entry || (!data && !error) ? 'empty' : !data ? 'error' : error ? 'stale' : 'ok';
  const since = (s) => Date.parse(s.since ?? '') || Infinity;
  const waiting = data
    ? [...data.waiting].sort((a, b) => since(a) - since(b)).map((s) => ({ ...s, key: sessionKey(s), ago: ago(s.since, now), kindLabel: KIND_LABEL[s.kind] ?? 'Waiting' }))
    : [];
  const working = data ? data.working.map((s) => ({ ...s, key: sessionKey(s) })) : [];
  const hosts = data ? data.hosts.map((h) => ({ name: h.name, up: h.up, label: h.up ? '' : 'offline' })) : [];
  const idle = {
    total: data?.totals.idle ?? 0,
    byHost: data ? data.hosts.filter((h) => h.idle > 0).map((h) => ({ name: h.name, idle: h.idle })) : [],
  };
  return {
    status,
    error,
    waiting,
    working,
    idle,
    hosts,
    totals: data?.totals ?? { waiting: 0, working: 0, idle: 0, hosts: 0 },
    manager: data?.manager ?? { up: false, lastNoteAt: null },
    updated: entry?.at ? ago(new Date(entry.at).toISOString(), now) : '',
  };
}

/** Reply box reducer. @param {{phase:string, message:string}|null} prev @param {{type:string, queued?:boolean, message?:string}} event */
export function replyState(prev, event) {
  const cur = prev ?? { phase: 'idle', message: '' };
  switch (event?.type) {
    case 'send':
      return cur.phase === 'sending' ? cur : { phase: 'sending', message: 'Sending' };
    case 'ok':
      return event.queued ? { phase: 'queued', message: 'Queued: the session is busy' } : { phase: 'sent', message: 'Sent' };
    case 'fail':
      return { phase: 'error', message: event.message || 'Could not send.' };
    case 'edit':
      return ['sent', 'queued', 'error'].includes(cur.phase) ? { phase: 'idle', message: '' } : cur;
    default:
      return cur;
  }
}

/**
 * What the side panel's poll tick reads. The transcript every `every` ms (slower while live turns stream in); the
 * board only while the stream is down, since then nothing pushes it and new waiting sessions, keys and screen hashes
 * would never show. A board older than `staleAfter` that cannot be read again gives way to the summary.
 * @returns {{ transcript: boolean, board: boolean, dropBoard: boolean }}
 */
export function panelPoll({ now, live, streaming, lastTranscript, lastBoard, boardFailedAt = 0, every = 5000, liveEvery = 15000, boardEvery = 10000, staleAfter = 60000 }) {
  const slack = 100;
  return {
    transcript: now - lastTranscript >= (live && streaming ? liveEvery : every) - slack,
    board: !live && now - lastBoard >= boardEvery - slack,
    dropBoard: !live && boardFailedAt > lastBoard && now - lastBoard >= staleAfter,
  };
}
