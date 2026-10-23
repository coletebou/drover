// native.summary normalisation. The daemon shape (CONTRACT.md):
// { generatedAt, hosts:[{name,up,waiting,working,idle}],
//   waiting:[{id,name,host,engine,since,kind,headline}],
//   working:[{id,name,host,engine,headline}],
//   totals:{waiting,working,idle,hosts}, manager:{up,lastNoteAt}, owner? }
// Every consumer goes through normalizeSummary so a missing or odd field
// degrades to an empty list instead of a thrown TypeError.

// Waiting items may also carry the dialog answer fields (answer, dialog, hash, keys: lib/answer.js).
import { dialogFields } from './answer.js';

// waiting[].kind is decision|question (a finished session is idle); notifications add more kinds.
export const KINDS = Object.freeze(['decision', 'question']);
export const ENGINES = Object.freeze(['claude', 'codex', 'headless', 'openclaw']);

const str = (v, max = 400) => (typeof v === 'string' ? v.slice(0, max) : v == null ? '' : String(v).slice(0, max));
const count = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const time = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : typeof v === 'number' && Number.isFinite(v) ? new Date(v).toISOString() : null);

/**
 * @typedef {{ id: string, name: string, host: string, engine: string, headline: string, state: 'waiting'|'working', kind: string|null, since: string|null }} BoardSession
 * @typedef {{ generatedAt: string|null, hosts: {name:string, up:boolean, waiting:number, working:number, idle:number}[],
 *   waiting: BoardSession[], working: BoardSession[], totals: {waiting:number, working:number, idle:number, hosts:number},
 *   manager: {up:boolean, lastNoteAt:string|null}, owner?: string }} NormalizedSummary
 */

/** The generic actor of the owner's own clients: the daemon records it as its configured owner (DROVER_OWNER). */
export const OWNER_ACTOR = 'owner';

/**
 * Whether `actor` is the fleet's owner: the generic actor, or `owner`, the name the latest native.summary gave
 * (normalizeSummary's `owner`; a daemon from before that field gives none). Case-insensitive, as the daemon compares.
 * @param {unknown} actor @param {string|null|undefined} owner
 */
export function isOwner(actor, owner) {
  const a = typeof actor === 'string' ? actor.toLowerCase() : '';
  return a !== '' && (a === OWNER_ACTOR || (typeof owner === 'string' && owner !== '' && a === owner.toLowerCase()));
}

function session(raw, state) {
  if (!raw || typeof raw !== 'object') return null;
  const id = str(raw.id, 200);
  if (!id) return null;
  const s = {
    id,
    name: str(raw.name, 120) || id.slice(0, 8),
    host: str(raw.host, 120) || 'local',
    engine: ENGINES.includes(raw.engine) ? raw.engine : 'claude',
    headline: str(raw.headline, 140),
    state,
    kind: state === 'waiting' ? (KINDS.includes(raw.kind) ? raw.kind : 'question') : null,
    since: state === 'waiting' ? time(raw.since) : null,
  };
  return state === 'waiting' ? { ...s, ...dialogFields(raw) } : s;
}

/** @param {any} raw @returns {NormalizedSummary} */
export function normalizeSummary(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const list = (v, state) => (Array.isArray(v) ? v.map((x) => session(x, state)).filter(Boolean) : []);
  const waiting = list(r.waiting, 'waiting');
  const working = list(r.working, 'working');
  const hosts = Array.isArray(r.hosts) ? r.hosts.filter((h) => h && typeof h === 'object' && h.name).map((h) => ({ name: str(h.name, 120), up: h.up !== false, waiting: count(h.waiting), working: count(h.working), idle: count(h.idle) })) : [];
  const t = r.totals && typeof r.totals === 'object' ? r.totals : {};
  const sum = (k) => hosts.reduce((a, h) => a + h[k], 0);
  return {
    generatedAt: time(r.generatedAt),
    hosts,
    waiting,
    working,
    totals: {
      waiting: Number.isFinite(t.waiting) ? count(t.waiting) : Math.max(waiting.length, sum('waiting')),
      working: Number.isFinite(t.working) ? count(t.working) : Math.max(working.length, sum('working')),
      idle: Number.isFinite(t.idle) ? count(t.idle) : sum('idle'),
      hosts: Number.isFinite(t.hosts) ? count(t.hosts) : hosts.length,
    },
    manager: { up: Boolean(r.manager?.up), lastNoteAt: time(r.manager?.lastNoteAt), ...(str(r.manager?.host, 120) ? { host: str(r.manager.host, 120) } : {}) },
    ...(typeof r.owner === 'string' && r.owner.trim() ? { owner: str(r.owner.trim(), 120) } : {}),
  };
}

const LANES = ['wait', 'work', 'idle'];

/**
 * native.board (main token): the compact board the side panel draws its picker and answer card from. Strips
 * keep their tmux window, so an answer can fall back to tmux.answer on a daemon from before sessions.answer.
 */
export function normalizeBoard(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const strips = (Array.isArray(r.strips) ? r.strips : []).map((x) => {
    if (!x || typeof x !== 'object') return null;
    const id = str(x.sessionId ?? x.id, 200);
    if (!id) return null;
    return {
      key: str(x.key, 300) || `${str(x.host, 120) || 'local'}|${id}`,
      id,
      tmux: str(x.tmux, 120) || null,
      name: str(x.name, 120) || id.slice(0, 8),
      host: str(x.host, 120) || 'local',
      engine: ENGINES.includes(x.engine) ? x.engine : (str(x.engine, 40) || 'claude'),
      lane: LANES.includes(x.lane) ? x.lane : 'idle',
      status: str(x.status, 40),
      screen: str(x.screen, 40) || null,
      since: time(x.since),
      headline: str(x.headline, 140),
      kind: x.kind === 'window' ? 'window' : 'session',
      finished: x.finished && typeof x.finished === 'object' ? { text: str(x.finished.text, 400), ts: time(x.finished.ts) } : null,
      ...dialogFields(x),
    };
  }).filter(Boolean);
  const m = r.manager && typeof r.manager === 'object' ? r.manager : null;
  return {
    generatedAt: time(r.generatedAt),
    strips,
    manager: m ? { up: Boolean(m.up), host: str(m.host, 120) || 'local', status: str(m.status, 40) || null, lastNoteAt: time(m.lastNoteAt) } : null,
  };
}

/** Waiting first (oldest wait first), then working. The list menus and the omnibox pick from. */
export function targetSessions(summary) {
  const w = [...(summary?.waiting ?? [])].sort((a, b) => (Date.parse(a.since ?? '') || Infinity) - (Date.parse(b.since ?? '') || Infinity));
  return [...w, ...(summary?.working ?? [])];
}

/** A stable key for a session across hosts. */
export function sessionKey(s) {
  return `${s.host}\u0000${s.id}`;
}
