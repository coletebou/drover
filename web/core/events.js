// The single source of truth: ~/.dotfiles/claude/drover-events.jsonl, append-only.
// State is a fold over the events. Nothing here rewrites a line.
import { appendFile, copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { envvar } from './envvars.js';
import { uuidv7 } from './ids.js';
import { stateDir } from './paths.js';
import { ownerActor } from './owner.js';
import * as plugins from './plugins.js';

export const DOTFILES = envvar('DOTFILES') ?? path.join(process.env.HOME, '.dotfiles');
const EVENTS_OVERRIDE = envvar('EVENTS');
export const EVENTS_PATH = EVENTS_OVERRIDE ?? path.join(DOTFILES, 'claude', 'drover-events.jsonl');
// The truth file's name before the rename. Boxes still on the old code keep
// appending there until they dotsync; see syncLegacyEvents.
export const LEGACY_EVENTS_PATH = path.join(DOTFILES, 'claude', 'apx-events.jsonl');
// APX_FEATURE_LOG is this override's pre-rename name (not APXW_, so envvar() does not cover it).
export const LEGACY_FEATURE_LOG = process.env.DROVER_FEATURE_LOG ?? process.env.APX_FEATURE_LOG ?? path.join(DOTFILES, 'claude', 'feature-log.jsonl');

export const FEATURE_STATES = ['not-started', 'in-progress', 'shipped', 'abandoned'];
export const EVENT_TYPES = ['feature', 'note', 'pin', 'unpin', 'message', 'launch', 'survey', 'survey-item', 'handoff', 'chat', 'failover', 'review', 'op', 'notify', 'settings', 'file-write', 'upload', 'status', 'receipt', 'approval'];
// A plugin adds its own event types with a validator each (core/plugins.js eventTypes).

export function shortHost() {
  return (envvar('HOST') ?? hostname()).split('.')[0];
}

/** Validate an event body (without id/ts/host which we add). Throws on bad input. */
export function validateEvent(ev) {
  if (!ev || typeof ev !== 'object') throw new Error('event must be an object');
  if (!EVENT_TYPES.includes(ev.type)) {
    const validate = typeof ev.type === 'string' ? plugins.eventValidator(ev.type) : null;
    if (!validate) throw new Error(`unknown event type ${JSON.stringify(ev.type)}`);
    validate(ev);
    return ev;
  }
  switch (ev.type) {
    case 'feature':
      if (!ev.fid || typeof ev.fid !== 'string') throw new Error('feature.fid required');
      if (ev.state !== undefined && !FEATURE_STATES.includes(ev.state)) throw new Error(`bad feature.state ${ev.state}`);
      break;
    case 'note':
      if (!ev.about || typeof ev.text !== 'string') throw new Error('note.about and note.text required');
      break;
    case 'pin': case 'unpin':
      if (!ev.target) throw new Error(`${ev.type}.target required`);
      break;
    case 'message':
      if (!ev.to || typeof ev.text !== 'string') throw new Error('message.to and message.text required');
      break;
    case 'launch':
      if (!ev.engine || !ev.mode) throw new Error('launch.engine and launch.mode required');
      break;
    case 'handoff':
      if (!ev.path) throw new Error('handoff.path required');
      break;
    case 'notify':
      if (typeof ev.message !== 'string') throw new Error('notify.message required');
      break;
    case 'settings':
      if (!ev.patch || typeof ev.patch !== 'object' || Array.isArray(ev.patch)) throw new Error('settings.patch must be an object');
      break;
    case 'file-write': case 'upload':
      if (typeof ev.path !== 'string' || !Number.isFinite(ev.bytes)) throw new Error(`${ev.type}.path and ${ev.type}.bytes required`);
      if ('content' in ev || 'data' in ev) throw new Error(`${ev.type} records path and size only, never content`);
      break;
    // An agent's own report of what it is doing (Grok bots through the bot gateway: core/bots/grok.js).
    case 'status':
      if (typeof ev.agent !== 'string' || !ev.agent || typeof ev.state !== 'string' || !ev.state) throw new Error('status.agent and status.state required');
      break;
    // Who read which message or reply (core/bots/grok.js receipts): of names one id or up to 200.
    case 'receipt': {
      const ids = typeof ev.of === 'string' ? [ev.of] : ev.of;
      if (!Array.isArray(ids) || !ids.length || ids.length > 200 || ids.some((x) => typeof x !== 'string' || !x || x.length > 200)) throw new Error('receipt.of must be an id or a list of 1 to 200 ids');
      if (ev.state !== 'read' || typeof ev.by !== 'string' || !ev.by) throw new Error('receipt.state (read) and receipt.by required');
      break;
    }
    // A Grok bot's approval request, the owner's decision on it, or its withdrawal (core/bots/approvals.js).
    case 'approval':
      if (typeof ev.aid !== 'string' || !/^ap_[a-f0-9]{12}$/.test(ev.aid) || !['pending', 'decided', 'withdrawn'].includes(ev.state) || typeof ev.bot !== 'string' || !ev.bot) throw new Error('approval.aid (ap_ and 12 hex digits), approval.state (pending, decided or withdrawn) and approval.bot required');
      if (ev.state === 'decided' && (!Number.isInteger(ev.decision?.n) || typeof ev.decision?.label !== 'string')) throw new Error('a decided approval needs decision { n, label }');
      break;
    default: break;
  }
  return ev;
}

// In-process listeners on every append (the notifier turns hook, manager and
// launch events into alerts). Only appends to the real truth file fan out.
const appendListeners = new Set();
export function onAppend(fn) { appendListeners.add(fn); return () => appendListeners.delete(fn); }

// ---------------------------------------------------------------- legacy truth file (until 2026-11-15)
// The first run on a box copies claude/apx-events.jsonl to drover-events.jsonl
// byte for byte. After that, whenever the legacy file's size or mtime changes (a
// laggard box appended and dotsync brought it here), every legacy line whose id
// the new file lacks is appended to the new file verbatim. The legacy file is
// only ever read: changing or deleting it on one box while laggards append to it
// would turn every dotsync into a rebase conflict. It is removed from dotfiles
// by hand when the apxw shim goes. An explicit DROVER_EVENTS skips all of this.
const legacySeen = new Map(); // "<file> < <legacy>" -> "size:mtimeMs" last imported

const legacyMarkFile = () => path.join(stateDir(), 'legacy-events.json');
async function readMarks(markFile) { try { return JSON.parse(await readFile(markFile, 'utf8')); } catch { return {}; } }
async function writeMark(markFile, key, sig) {
  try {
    const marks = await readMarks(markFile);
    marks[key] = sig;
    await mkdir(path.dirname(markFile), { recursive: true, mode: 0o700 });
    const tmp = `${markFile}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(marks) + '\n', { mode: 0o600 });
    await rename(tmp, markFile);
  } catch { /* the marker only saves work; the import is idempotent without it */ }
}

/**
 * Bring legacy events into the new truth file. Cheap when nothing changed (one
 * stat). Returns what it did: {copied}, {imported: n}, or {skipped: reason}.
 */
export async function syncLegacyEvents({ file = EVENTS_PATH, legacy = LEGACY_EVENTS_PATH, markFile = legacyMarkFile() } = {}) {
  let st; try { st = await stat(legacy); } catch { return { skipped: 'no legacy file' }; }
  const sig = `${st.size}:${st.mtimeMs}`;
  const key = `${file} < ${legacy}`;
  if (!existsSync(file)) {
    try { await copyFile(legacy, file, constants.COPYFILE_EXCL); } catch (e) { if (e.code !== 'EEXIST') throw e; return syncLegacyEvents({ file, legacy, markFile }); }
    legacySeen.set(key, sig); await writeMark(markFile, key, sig);
    return { copied: true, bytes: st.size };
  }
  if (legacySeen.get(key) === sig) return { skipped: 'unchanged' };
  if ((await readMarks(markFile))[key] === sig) { legacySeen.set(key, sig); return { skipped: 'unchanged' }; }
  const current = await readFile(file, 'utf8');
  const ids = new Set();
  for (const line of current.split('\n')) { const id = idOf(line); if (id) ids.add(id); }
  const add = [];
  for (const line of (await readFile(legacy, 'utf8')).split('\n')) {
    const id = idOf(line);
    if (!id || ids.has(id)) continue; // blank, torn (picked up once complete) or already here
    ids.add(id); add.push(line);
  }
  if (add.length) await appendFile(file, (current && !current.endsWith('\n') ? '\n' : '') + add.join('\n') + '\n', 'utf8');
  legacySeen.set(key, sig); await writeMark(markFile, key, sig);
  return { imported: add.length };
}

function idOf(line) {
  if (!line.trim()) return null;
  try { const id = JSON.parse(line).id; return typeof id === 'string' && id ? id : null; } catch { return null; }
}

// Only the default truth file has a legacy twin; tests and explicit files never do.
async function maybeSyncLegacy(file) {
  if (EVENTS_OVERRIDE !== undefined || file !== EVENTS_PATH) return;
  try { await syncLegacyEvents(); } catch { /* never block a read or an append on the migration */ }
}

/** Append one event. Returns the stored event (with id, ts, host, actor). */
export async function append(ev, { actor = 'drover', file = EVENTS_PATH } = {}) {
  validateEvent(ev);
  await maybeSyncLegacy(file);
  // A client that sends the generic "owner" is recorded as the configured owner (core/owner.js).
  const stored = { id: uuidv7(), ts: new Date().toISOString(), host: shortHost(), actor: ownerActor(actor), ...ev };
  await appendFile(file, JSON.stringify(stored) + '\n', 'utf8');
  if (file === EVENTS_PATH) for (const l of appendListeners) { try { l(stored); } catch { /* a listener must never break an append */ } }
  return stored;
}

export async function readAll(file = EVENTS_PATH) {
  await maybeSyncLegacy(file);
  if (!existsSync(file)) return [];
  const text = await readFile(file, 'utf8');
  const out = [];
  const seen = new Set();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; } // a torn line from a concurrent append; skip
    // Two processes importing the same legacy lines at once, or a union merge, can repeat a line.
    if (e?.id) { if (seen.has(e.id)) continue; seen.add(e.id); }
    out.push(e);
  }
  out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return out;
}

/** Tail: events after a given id/ts. */
export async function since(tsOrId, file = EVENTS_PATH) {
  const all = await readAll(file);
  if (!tsOrId) return all;
  const idx = all.findIndex((e) => e.id === tsOrId);
  if (idx >= 0) return all.slice(idx + 1);
  return all.filter((e) => e.ts > tsOrId);
}

/** Fold the log into current state. Pure. */
export function fold(events) {
  const features = new Map();
  const notes = new Map();      // about -> [note]
  const pins = new Set();
  const chats = new Map();      // key -> [message]
  const launches = [];
  const surveys = [];
  const surveyItems = [];
  const ops = [];
  const notifies = new Map(); // sessionId -> latest notify
  let handoff = null;
  for (const e of events) {
    switch (e.type) {
      case 'feature': {
        const prev = features.get(e.fid) ?? { fid: e.fid, created: e.ts, state: 'not-started', title: '', repo: '', notes: '', links: [] };
        features.set(e.fid, {
          ...prev,
          updated: e.ts,
          ...(e.state !== undefined && { state: e.state }),
          ...(e.title !== undefined && { title: e.title }),
          ...(e.repo !== undefined && { repo: e.repo }),
          ...(e.notes !== undefined && { notes: e.notes }),
          ...(Array.isArray(e.links) && { links: [...new Set([...(prev.links ?? []), ...e.links])] }),
          // Written to by a Grok bot (an untrusted event, core/bots/tools.js): marked for good, with every bot that did.
          ...(e.untrusted === true && { untrusted: true, untrustedBy: [...new Set([...(prev.untrustedBy ?? []), e.source ?? e.actor])] }),
        });
        break;
      }
      case 'note': {
        const arr = notes.get(e.about) ?? []; arr.push(e); notes.set(e.about, arr); break;
      }
      case 'pin': pins.add(e.target); break;
      case 'unpin': pins.delete(e.target); break;
      case 'message': case 'chat': {
        const key = e.to ? `${e.to.kind}:${e.to.host ?? ''}:${e.to.id}` : e.key;
        const arr = chats.get(key) ?? []; arr.push(e); chats.set(key, arr); break;
      }
      case 'launch': launches.push(e); break;
      case 'survey': surveys.push(e); break;
      case 'survey-item': surveyItems.push(e); break;
      case 'handoff': handoff = e; break;
      case 'op': ops.push(e); break;
      // Only "needs you" alerts (and hook events from before categories existed)
      // mark a session as waiting; finished/error/mr alerts are history, not asks.
      // Detector dialogs are covered by the live screen state, so only hook and agent asks count.
      // Claude's bare idle reminder (no ask context, before enrichment existed) is not a question.
      case 'notify': if (e.sessionId && (!e.category || e.category === 'needs-you') && (!e.source || e.source === 'hook' || e.source === 'agent' || (e.source === 'detector' && e.ask?.kind === 'question')) && !e.test && (e.ask ? e.ask.kind !== 'finished' : e.kind !== 'idle_prompt')) notifies.set(e.sessionId, e); break;
      default: break;
    }
  }
  return {
    features: [...features.values()].sort((a, b) => (a.updated < b.updated ? 1 : -1)),
    notes: Object.fromEntries(notes),
    pins: [...pins],
    chats: Object.fromEntries(chats),
    launches: launches.slice().reverse(),
    surveys,
    surveyItems,
    handoff,
    ops: ops.slice(-200).reverse(),
    notifies: Object.fromEntries(notifies),
    count: events.length,
    last: events.at(-1)?.id ?? null,
  };
}

/** One-time import of the legacy feature-log.jsonl rows as feature events (idempotent). */
export async function importLegacyFeatureLog({ legacy = LEGACY_FEATURE_LOG, file = EVENTS_PATH } = {}) {
  if (!existsSync(legacy)) return { imported: 0, skipped: 0, reason: 'no legacy file' };
  const existing = await readAll(file);
  const seen = new Set(existing.filter((e) => e.type === 'feature' && e.legacyTs).map((e) => `${e.fid}|${e.legacyTs}`));
  const text = await readFile(legacy, 'utf8');
  let imported = 0, skipped = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row; try { row = JSON.parse(line); } catch { skipped++; continue; }
    if (!row.id) { skipped++; continue; }
    const key = `${row.id}|${row.ts}`;
    if (seen.has(key)) { skipped++; continue; }
    await append({ type: 'feature', fid: row.id, legacyTs: row.ts, state: FEATURE_STATES.includes(row.state) ? row.state : undefined, title: row.title, repo: row.repo, notes: row.notes }, { actor: 'import:feature-log', file });
    seen.add(key); imported++;
  }
  return { imported, skipped };
}

export async function fileInfo(file = EVENTS_PATH) {
  if (!existsSync(file)) return { path: file, exists: false, bytes: 0 };
  const s = await stat(file);
  return { path: file, exists: true, bytes: s.size, mtime: s.mtime.toISOString() };
}
