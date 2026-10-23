// Omnibox logic: parse "<session>[@host] <message>", rank sessions, build
// suggestions. Pure: no chrome.*, no DOM.
import { truncate } from './text.js';

export const DEFAULT_SUGGESTION = 'Send to a Drover session: <session> <message>';

/** @param {string} text @returns {{query:string, host:string|null, message:string}} */
export function parseInput(text) {
  const t = String(text ?? '').trimStart();
  const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(t);
  if (!m) return { query: '', host: null, message: '' };
  let query = m[1];
  let host = null;
  const at = query.lastIndexOf('@');
  if (at > 0 && at < query.length - 1) {
    host = query.slice(at + 1);
    query = query.slice(0, at);
  }
  return { query, host, message: (m[2] ?? '').trim() };
}

const lc = (s) => String(s ?? '').toLowerCase();

function rankOf(s, q) {
  if (!q) return 4;
  const name = lc(s.name);
  if (name === q || lc(s.id) === q) return 0;
  if (name.startsWith(q)) return 1;
  if (name.includes(q)) return 2;
  if (lc(s.id).startsWith(q)) return 3;
  return -1;
}

/** Ranked matches (best first, stable within a rank). Returns [{ session, rank }]. */
function ranked(sessions, { query, host }) {
  const q = lc(query);
  const h = host ? lc(host) : null;
  const out = [];
  (sessions ?? []).forEach((session, i) => {
    if (h && lc(session.host) !== h) return;
    const rank = rankOf(session, q);
    if (rank >= 0) out.push({ session, rank, i });
  });
  out.sort((a, b) => a.rank - b.rank || a.i - b.i);
  return out;
}

export function matchSessions(sessions, { query, host }) {
  return ranked(sessions, { query, host }).map((r) => r.session);
}

export function escapeXml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
}

export function suggestionsFor(sessions, text, { max = 5 } = {}) {
  const { query, host, message } = parseInput(text);
  const matches = matchSessions(sessions, { query, host });
  const counts = new Map();
  for (const s of matches) counts.set(lc(s.name), (counts.get(lc(s.name)) ?? 0) + 1);
  return matches.slice(0, max).map((s) => {
    // The content is parsed again when chosen, so it must name exactly this session:
    // a name with spaces (or a duplicate name on the same host) falls back to the id.
    const plain = /^\S+$/.test(s.name) && !s.name.includes('@');
    const label = !plain || matches.some((o) => o !== s && lc(o.name) === lc(s.name) && lc(o.host) === lc(s.host)) ? `${s.id}@${s.host}`
      : counts.get(lc(s.name)) > 1 ? `${s.name}@${s.host}` : s.name;
    const content = `${label} ${message}`.trimEnd() + (message ? '' : ' ');
    let description = `<match>${escapeXml(s.name)}</match> <dim>${escapeXml(s.host)} · ${escapeXml(s.state === 'waiting' ? 'waiting' : 'working')}${s.headline ? ' · ' + escapeXml(truncate(s.headline, 60)) : ''}</dim>`;
    if (message) description += ` <url>send: ${escapeXml(truncate(message, 40))}</url>`;
    return { content, description, deletable: false };
  });
}

/** @returns {{session: object, message: string} | {error: string}} */
export function resolveInput(sessions, text) {
  const { query, host, message } = parseInput(text);
  if (!query) return { error: 'Type a session name.' };
  const r = ranked(sessions, { query, host });
  if (!r.length) return { error: `No session matches "${query}".` };
  const best = r.filter((x) => x.rank === r[0].rank);
  if (best.length === 1) return { session: best[0].session, message };
  return { error: `"${query}" matches several sessions. Add @host or more letters.` };
}
