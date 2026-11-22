// The Prompts workspace's pure half (views/prompts.js renders it): the prompts.list args for a filter (`who`, never
// `via`), merging pages and live refreshes by id (newest first), finding the board strip a prompt's session is, and
// the status line from prompts.status. Record shape: docs/specs/2026-11-21-cohesion-overhaul.md ("Record") — each
// record now also carries `mine` (bool, after marks), `marked` (true once a person decided it) and maybe `actor`.
// Tests in test/ui-prompts.test.js.
import { fmtAgo } from './dom.js';

/** The six filter chips, in the order they're offered; who the daemon's prompts.list/prompts.local takes. */
export const FILTERS = ['mine', 'manager', 'agents', 'programs', 'not-mine', 'all'];
export const FILTER_LABEL = { mine: 'Mine', manager: 'Manager', agents: 'Agents', programs: 'Programs', 'not-mine': 'Not mine', all: 'All' };
export const PAGE = 200;

/** prompts.list args: empty filters left out; `who` is always sent (never `via` — the daemon's old-client fallback). */
export function listArgs({ scope = 'mine', q, host, engine, label, before, limit = PAGE } = {}) {
  const a = { limit, who: FILTERS.includes(scope) ? scope : 'mine' };
  if (q && String(q).trim()) a.q = String(q).trim();
  if (host) a.host = host;
  if (engine) a.engine = engine;
  if (label) a.label = label;
  if (before) a.before = before;
  return a;
}

/** prompts.mark args: one id or many; mine true/false marks it, null clears the mark (back to automatic). */
export function markArgs(ids, mine) {
  return { ids: Array.isArray(ids) ? ids : [ids], mine };
}

const tsOf = (p) => Date.parse(p?.ts ?? '') || 0;
/** Records by id, newest first (a refresh and a page overlap; a record collected twice is one). */
export function mergePrompts(...lists) {
  const by = new Map();
  for (const l of lists) for (const p of l ?? []) if (p?.id && !by.has(p.id)) by.set(p.id, p);
  return [...by.values()].sort((a, b) => tsOf(b) - tsOf(a) || String(b.id).localeCompare(String(a.id)));
}

/** The board strip for a prompt's session (the UI calls the front daemon's own host "local"), or null. */
export function stripForPrompt(strips = [], p, frontHost = null) {
  if (!p?.session) return null;
  const host = !p.host || p.host === frontHost ? 'local' : p.host;
  return strips.find((s) => (s.host ?? 'local') === host && (s.sessionId === p.session || s.id === p.session)) ?? null;
}

/** "1,204 prompts, newest 3m ago; personal synced 4m ago, work: push failed" from prompts.status. */
export function statusLine(st) {
  if (!st) return '';
  const parts = [`${Number(st.records ?? 0).toLocaleString('en-US')} prompt${st.records === 1 ? '' : 's'}`];
  if (st.newest) parts[0] += `, newest ${fmtAgo(st.newest)} ago`;
  if (st.scanning) parts[0] += ', scanning';
  const sinks = (st.sinks ?? []).map((s) => (s.lastError ? `${s.name}: ${s.lastError}` : s.lastSync ? `${s.name} synced ${fmtAgo(s.lastSync)} ago${s.pending ? ` (${s.pending} to push)` : ''}` : `${s.name} not synced yet`));
  return [parts[0], sinks.length ? sinks.join(', ') : 'local spool only'].join('; ');
}

/** The first line of a prompt for a one-line preview (hover, a toast). */
export function firstLine(text, max = 160) { const t = String(text ?? '').trim().split('\n').find((l) => l.trim()) ?? ''; return t.length > max ? t.slice(0, max - 1) + '…' : t; }
