// The side panel's Prompts section, its pure half: the prompts.list arguments, merging pages by id, the rows a list
// draws, the status line, and finding the board strip of a prompt's session. No chrome.* and no DOM.
// Record shape: native/CONTRACT.md "Ops added 2026-11-21" (docs/specs/2026-11-21-cohesion-overhaul.md "Record").

/** Prompts asked for per page: a side panel shows recent ones, the web UI has the rest. */
export const PANEL_PAGE = 50;

/**
 * prompts.list args: the daemon's default via set (Mine), the search words when there are any, and `before` (the last
 * id shown) for the next page.
 * @param {{ q?: string, before?: string, limit?: number }} [o]
 */
export function listArgs({ q, before, limit = PANEL_PAGE } = {}) {
  const a = { limit: Math.max(1, Math.min(2000, Number(limit) || PANEL_PAGE)) };
  const words = String(q ?? '').trim();
  if (words) a.q = words.slice(0, 500);
  if (typeof before === 'string' && before) a.before = before;
  return a;
}

const tsOf = (p) => Date.parse(p?.ts ?? '') || 0;

/** Records by id, newest first (a page and a refresh overlap; a record collected twice is one). */
export function mergePrompts(...lists) {
  const by = new Map();
  for (const l of lists) for (const p of Array.isArray(l) ? l : []) if (p && typeof p.id === 'string' && !by.has(p.id)) by.set(p.id, p);
  return [...by.values()].sort((a, b) => tsOf(b) - tsOf(a) || String(b.id).localeCompare(String(a.id)));
}

/** Only well-formed records, from whatever prompts.list answered (an older or newer daemon). */
export function normalizePrompts(res) {
  const list = Array.isArray(res?.prompts) ? res.prompts : [];
  return list.filter((p) => p && typeof p.id === 'string' && typeof p.text === 'string' && !Number.isNaN(Date.parse(p.ts ?? '')));
}

const pad = (n) => String(n).padStart(2, '0');
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "22:03" today, "Tue 22:03" within the week, else "21 Nov 22:03" (24-hour, local time unless `utc`).
 * @param {string} iso @param {number} [now] @param {{utc?: boolean}} [o]
 */
export function fmtTime(iso, now = Date.now(), { utc = false } = {}) {
  const t = Date.parse(iso ?? '');
  if (Number.isNaN(t)) return '';
  const d = new Date(t), n = new Date(now);
  const get = (x) => (utc
    ? { y: x.getUTCFullYear(), m: x.getUTCMonth(), day: x.getUTCDate(), wd: x.getUTCDay(), h: x.getUTCHours(), min: x.getUTCMinutes() }
    : { y: x.getFullYear(), m: x.getMonth(), day: x.getDate(), wd: x.getDay(), h: x.getHours(), min: x.getMinutes() });
  const a = get(d), b = get(n);
  const hm = `${pad(a.h)}:${pad(a.min)}`;
  if (a.y === b.y && a.m === b.m && a.day === b.day) return hm;
  const days = Math.round((Date.UTC(b.y, b.m, b.day) - Date.UTC(a.y, a.m, a.day)) / 86_400_000);
  if (days > 0 && days < 6) return `${DAYS[a.wd]} ${hm}`;
  return `${a.day} ${MONTHS[a.m]} ${hm}`;
}

/** Where a turn came from, for a row (typed, the common case, says nothing). */
export const VIA_LABEL = Object.freeze({ typed: '', queued: 'queued', drover: 'via Drover', headless: 'launch', peer: 'from an agent', sdk: 'program' });

/**
 * What a row shows: the meta line ("22:03 · demo-box · codex · webapp · queued"), the text verbatim (the row clamps
 * it), and the full time for a tooltip.
 * @param {object} p a prompts.list record @param {{ now?: number, utc?: boolean }} [o]
 */
export function promptRow(p, { now = Date.now(), utc = false } = {}) {
  const via = p.from ? `from ${p.from}` : (VIA_LABEL[p.via] ?? String(p.via ?? ''));
  const meta = [fmtTime(p.ts, now, { utc }), p.host ?? '', p.engine ?? '', p.project ?? '', via].filter(Boolean).join(' · ');
  return { id: p.id, meta, text: String(p.text ?? ''), when: p.ts, cwd: p.cwd ?? null, fromSink: Boolean(p.source) };
}

/**
 * The board strip of a prompt's session, when it is on the board now: same host (the record's route, the alias ops
 * take; `local` for the daemon's machine) and the session id as the strip's id or its sessionId. Never the manager.
 * @param {Array<object>} strips normalizeBoard(...).strips @param {object} p
 */
export function stripForPrompt(strips, p) {
  if (!p?.session || p.session === 'manager' || !Array.isArray(strips)) return null;
  const host = p.route || p.host || 'local';
  return strips.find((s) => (s.host || 'local') === host && s.id !== 'manager' && (s.id === p.session || s.sessionId === p.session)) ?? null;
}

/** "1,204 prompts, newest 3m ago; personal synced 4m ago" from prompts.status (the web UI's line, shorter). */
export function statusLine(st, now = Date.now()) {
  if (!st || typeof st !== 'object') return '';
  const n = Number(st.records ?? 0) || 0;
  let first = `${n.toLocaleString('en-US')} prompt${n === 1 ? '' : 's'}`;
  if (st.newest) first += `, newest ${shortAgo(st.newest, now)} ago`;
  const sinks = (Array.isArray(st.sinks) ? st.sinks : []).map((s) => (s.lastError ? `${s.name}: ${s.lastError}` : s.lastSync ? `${s.name} synced ${shortAgo(s.lastSync, now)} ago` : `${s.name} not synced yet`));
  return sinks.length ? `${first}; ${sinks.join(', ')}` : first;
}

function shortAgo(iso, now) {
  const t = Date.parse(iso ?? '');
  if (Number.isNaN(t)) return '?';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
}

/** The daemon predates the spool ("unknown op prompts.list"). */
export function isUnknownPromptsOp(err) {
  return /unknown op/i.test(String(err?.message ?? ''));
}
