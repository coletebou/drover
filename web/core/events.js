// The single source of truth: ~/.dotfiles/claude/drover-events.jsonl, append-only.
// State is a fold over the events. Nothing here rewrites a line.
import { appendFile, copyFile, mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { envvar } from './envvars.js';
import { uuidv7 } from './ids.js';
import { stateDir } from './paths.js';
import { ownerActor } from './owner.js';
import * as plugins from './plugins.js';
import { validateAskEvent } from './ask/model.js';

export const DOTFILES = envvar('DOTFILES') ?? path.join(process.env.HOME, '.dotfiles');
const EVENTS_OVERRIDE = envvar('EVENTS');
export const EVENTS_PATH = EVENTS_OVERRIDE ?? path.join(DOTFILES, 'claude', 'drover-events.jsonl');
// The truth file's name before the rename. Boxes still on the old code keep
// appending there until they dotsync; see syncLegacyEvents.
export const LEGACY_EVENTS_PATH = path.join(DOTFILES, 'claude', 'apx-events.jsonl');
// APX_FEATURE_LOG is this override's pre-rename name (not APXW_, so envvar() does not cover it).
export const LEGACY_FEATURE_LOG = process.env.DROVER_FEATURE_LOG ?? process.env.APX_FEATURE_LOG ?? path.join(DOTFILES, 'claude', 'feature-log.jsonl');

export const FEATURE_STATES = ['not-started', 'in-progress', 'shipped', 'abandoned'];
export const EVENT_TYPES = ['feature', 'note', 'pin', 'unpin', 'message', 'launch', 'survey', 'survey-item', 'handoff', 'chat', 'failover', 'review', 'op', 'notify', 'settings', 'file-write', 'upload', 'status', 'receipt', 'approval', 'ask'];
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
    // A question to the owner by text and what came of it (core/ask: docs/ask.md).
    case 'ask': validateAskEvent(ev); break;
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

// readAll keeps what it parsed, per file, and next time parses only the bytes appended
// since. Every state, tail, notify, settings, bot and manager read went through a full
// parse of the truth file (62k lines, 55 MB on 2026-11-03), behind a 5 s cache.
// The file only grows by appends, except when git rewrites it (dotsync's union merge
// puts another host's lines in the middle, a checkout or reset replaces it). So the
// cache is used only when the file is the same inode, no shorter, and the bytes at
// both ends of the part already read are unchanged; anything else is a full parse.
const CHECK_BYTES = 4096;
const readCache = new Map(); // file -> { dev, ino, offset, head, tail, events, seen, lastTs }

function parseLines(text, events, seen) {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; } // a torn line from a concurrent append; skip
    // Two processes importing the same legacy lines at once, or a union merge, can repeat a line.
    if (e?.id) { if (seen.has(e.id)) continue; seen.add(e.id); }
    events.push(e);
  }
}

const byTs = (a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0);

async function readRange(fh, start, length) {
  const buf = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const { bytesRead } = await fh.read(buf, got, length - got, start + got);
    if (!bytesRead) break;
    got += bytesRead;
  }
  return got === length ? buf : buf.subarray(0, got);
}

async function fullRead(file, fh, size) {
  const buf = await readRange(fh, 0, size);
  const events = [];
  const seen = new Set();
  parseLines(buf.toString('utf8'), events, seen);
  events.sort(byTs);
  // Resume after the last complete line. A final line still being written is parsed
  // again next time (its id is in seen if it already parsed, so it is not doubled).
  const offset = buf.lastIndexOf(0x0a) + 1;
  return {
    offset,
    head: Buffer.from(buf.subarray(0, Math.min(CHECK_BYTES, offset))),
    tail: Buffer.from(buf.subarray(Math.max(0, offset - CHECK_BYTES), offset)),
    events, seen,
    lastTs: events.at(-1)?.ts ?? '',
  };
}

// One read of a file at a time in this process: two overlapping incremental reads
// would both parse the same appended bytes and both advance the offset past them.
const readQueue = new Map(); // file -> the read in progress
export function readAll(file = EVENTS_PATH) {
  const run = (readQueue.get(file) ?? Promise.resolve()).catch(() => {}).then(() => readAllOnce(file));
  readQueue.set(file, run);
  run.catch(() => {}).finally(() => { if (readQueue.get(file) === run) readQueue.delete(file); });
  return run;
}

async function readAllOnce(file) {
  await maybeSyncLegacy(file);
  let fh;
  try { fh = await open(file, 'r'); } catch (e) { if (e.code === 'ENOENT') { readCache.delete(file); return []; } throw e; }
  try {
    const st = await fh.stat();
    let c = readCache.get(file);
    const usable = c && c.dev === st.dev && c.ino === st.ino && st.size >= c.offset
      && (await readRange(fh, 0, c.head.length)).equals(c.head)
      && (await readRange(fh, c.offset - c.tail.length, c.tail.length)).equals(c.tail);
    if (!usable) {
      c = { dev: st.dev, ino: st.ino, ...(await fullRead(file, fh, st.size)) };
      readCache.set(file, c);
    } else if (st.size > c.offset) {
      const buf = await readRange(fh, c.offset, st.size - c.offset);
      const end = buf.lastIndexOf(0x0a) + 1;
      if (end > 0) {
        const added = [];
        parseLines(buf.subarray(0, end).toString('utf8'), added, c.seen);
        if (added.length) {
          c.events.push(...added);
          // Appends are almost always newer; a host with a skewed clock is not.
          if (added.some((e) => e.ts < c.lastTs) || added.some((e, i) => i && e.ts < added[i - 1].ts)) c.events.sort(byTs);
          c.lastTs = c.events.at(-1)?.ts ?? '';
        }
        c.offset += end;
        c.tail = Buffer.from((await readRange(fh, Math.max(0, c.offset - CHECK_BYTES), Math.min(CHECK_BYTES, c.offset))));
        if (c.head.length < CHECK_BYTES) c.head = await readRange(fh, 0, Math.min(CHECK_BYTES, c.offset));
      }
      // Bytes after the last newline are a line still being written: read next time.
    }
    return c.events.slice();
  } finally { await fh.close(); }
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
