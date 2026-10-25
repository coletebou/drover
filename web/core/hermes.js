// Hermes Agent adapter (Nous Research's hermes-agent). Every Hermes surface, the classic REPL, the TUI, Desktop,
// ACP editors and one-shots, is a client of one gateway daemon per profile home, and that gateway is the only
// writer of <home>/state.db (SQLite, WAL). Drover reads the database read-only for lists, transcripts and last
// replies, and asks the gateway for what only it knows or can do: which sessions are live and in what state, a
// turn into a session, and the answer to an approval or a question.
//
// The gateway's private control socket (<home>/gateway.sock, or the path gateway.sock.path names) takes one JSON
// line per request: identify gives the loopback WebSocket origin, session-ticket a single-use ticket (30 s). The
// WebSocket (/api/ws, subprotocols hermes-gateway-v1 and hermes-gateway-ticket.<ticket>, no Origin header) speaks
// JSON-RPC 2.0, and Node's own WebSocket sends no Origin. Checked against Hermes 2026.9.24 (eb1b4c5b) on
// 2026-10-25. None of this is a published Hermes API, so every read here fails soft: a host whose Hermes answers
// differently lists its sessions from the database, or none, and never breaks the rest of the list.
import net from 'node:net';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync, accessSync, constants } from 'node:fs';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { run, startLines } from './proc.js';
import { envvar } from './envvars.js';
import { checkEffort } from './effort.js';
import { toolSummary, resultEntry } from './toolcalls.js';
import { stateDir } from './paths.js';
import * as tmux from './tmux.js';

export const ENGINE = 'hermes';
const PROTOCOL = 'hermes-gateway-v1';
const TICKET_PREFIX = 'hermes-gateway-ticket.';
// A Hermes session id: "local-" and 64 hex for gateway-local sessions (hermes_state_keys.py); older and platform
// sessions use other shapes, so the check is a safe character set, not the exact form.
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;

/** Test seams: the WebSocket class, the process list, tmux's pane ttys, the clock, the environment and the turn spawner. */
export const _deps = {
  WebSocket: globalThis.WebSocket,
  ps: async () => (await run('ps', ['-axww', '-o', 'pid=,command='], { timeoutMs: 5_000 })).stdout,
  paneTtys: () => tmux.paneTtys(),
  now: () => Date.now(),
  env: () => process.env,
  spawn: (file, argv, opts) => startLines(file, argv, opts),
};

/** The hermes executable: DROVER_HERMES_BIN, else `hermes` on the PATH. */
export const hermesBin = () => envvar('HERMES_BIN', _deps.env())?.trim() || 'hermes';

/** The hermes executable as it would run with this PATH: an absolute path, or null when there is none. */
export function findBin(PATH = _deps.env().PATH ?? '') {
  const bin = hermesBin();
  const ok = (f) => { try { if (!statSync(f).isFile()) return false; accessSync(f, constants.X_OK); return true; } catch { return false; } };
  if (bin.includes('/')) return ok(path.resolve(bin)) ? path.resolve(bin) : null;
  for (const dir of String(PATH).split(path.delimiter)) if (dir && path.isAbsolute(dir) && ok(path.join(dir, bin))) return path.join(dir, bin);
  return null;
}

/** The Hermes home: HERMES_HOME, else ~/.hermes (hermes_constants.get_hermes_home). */
export function rootHome(env = _deps.env()) {
  return env.HERMES_HOME ? path.resolve(env.HERMES_HOME) : path.join(env.HOME ?? '', '.hermes');
}

/** This host keeps Hermes sessions: its home, or one of its named profiles, has a session database. */
export function configured(env = _deps.env()) { return homes(env).length > 0; }

/**
 * The homes to read, { home, profile }: the root, then each named profile under it (~/.hermes/profiles/<name>,
 * hermes profile create), each when it has a database: a named profile keeps its own, so it may have one while the
 * root has none. profile is null for the root.
 */
export function homes(env = _deps.env()) {
  const root = rootHome(env);
  const out = existsSync(path.join(root, 'state.db')) ? [{ home: root, profile: null }] : [];
  let names = [];
  try { names = readdirSync(path.join(root, 'profiles'), { withFileTypes: true }); } catch { /* no named profiles */ }
  for (const e of names) {
    if (e.isDirectory() && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(e.name) && existsSync(path.join(root, 'profiles', e.name, 'state.db'))) out.push({ home: path.join(root, 'profiles', e.name), profile: e.name });
  }
  return out;
}

function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const real = (p) => { try { return realpathSync(p); } catch { return path.resolve(p); } };
  return real(a) === real(b);
}

// ---------------------------------------------------------------- the control socket

const myUid = typeof process.getuid === 'function' ? process.getuid() : null;
/**
 * A socket or pointer file only this user can reach, which is what Hermes itself requires of them
 * (gateway_runtime_discovery._private_node): another local user's socket in the home would otherwise hear every
 * prompt Drover sends.
 */
function privateNode(p, kind) {
  try {
    const s = lstatSync(p);
    return (myUid === null || s.uid === myUid) && (s.mode & 0o077) === 0 && (kind === 'socket' ? s.isSocket() : s.isFile());
  } catch { return false; }
}

/** The control socket of a home's gateway, or null: gateway.sock, else the socket gateway.sock.path names (a home whose path is too long for a socket). */
export function controlSocket(home) {
  const direct = path.join(home, 'gateway.sock');
  let exists = false;
  try { lstatSync(direct); exists = true; } catch { /* none */ }
  if (exists) return privateNode(direct, 'socket') ? direct : null;
  const pointer = path.join(home, 'gateway.sock.path');
  if (!privateNode(pointer, 'file')) return null;
  let target;
  try { target = readFileSync(pointer, 'utf8').trim(); } catch { return null; }
  if (!path.isAbsolute(target) || path.basename(target) !== 'control.sock' || !/^hermes-gw-[0-9a-f]{8,64}$/.test(path.basename(path.dirname(target)))) return null;
  return privateNode(target, 'socket') ? target : null;
}

/** One request on a gateway's control socket: its result, or a throw (refused, closed early, timed out). */
export function control(socket, verb, params, { timeoutMs = 3_000 } = {}) {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(socket);
    let buf = '', settled = false;
    const done = (err, v) => { if (settled) return; settled = true; clearTimeout(timer); c.destroy(); if (err) reject(err); else resolve(v); };
    const timer = setTimeout(() => done(new Error(`the Hermes gateway did not answer ${verb} within ${timeoutMs} ms`)), timeoutMs);
    c.setEncoding('utf8');
    c.on('connect', () => c.write(JSON.stringify({ protocol: 1, id: 1, verb, ...(params ? { params } : {}) }) + '\n'));
    c.on('data', (d) => {
      buf += d;
      if (buf.length > 1 << 20) { done(new Error('the Hermes gateway sent an oversized control reply')); return; }
      const i = buf.indexOf('\n');
      if (i < 0) return;
      let r;
      try { r = JSON.parse(buf.slice(0, i)); } catch { done(new Error('the Hermes gateway sent an unreadable control reply')); return; }
      if (r?.ok !== true || r.id !== 1) { done(new Error(`the Hermes gateway refused ${verb}: ${JSON.stringify(r?.error ?? r?.reason ?? 'no reason').slice(0, 200)}`)); return; }
      done(null, r.result ?? {});
    });
    c.on('error', (e) => done(e));
    c.on('close', () => done(new Error(`the Hermes gateway closed the control socket before answering ${verb}`)));
  });
}

const LOOPBACK = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):\d{1,5}$/;

/**
 * The gateway serving one home, or null when none is ready: the home's own socket, else, for a named profile
 * the root's gateway multiplexes (hermes_cli/gateway_runtime.py), the root's, which lists the profile in
 * served_profiles. A gateway that is starting or draining, or whose WebSocket is not on loopback, counts as none.
 * { socket, pid, instanceId, profileId, origin, home }
 */
export async function gatewayFor(home, root = rootHome()) {
  const sockets = [controlSocket(home), samePath(home, root) ? null : controlSocket(root)].filter(Boolean);
  for (const socket of sockets) {
    let id;
    try { id = await control(socket, 'identify'); } catch { continue; }
    if (id?.kind !== 'hermes-gateway' || id.state !== 'ready' || !LOOPBACK.test(String(id.api_origin ?? '')) || typeof id.instance_id !== 'string') continue;
    const served = (Array.isArray(id.served_profiles) ? id.served_profiles : []).find((p) => samePath(p?.home, home));
    const profileId = served?.profile_id ?? (samePath(id.hermes_home, home) ? id.hermes_home : null);
    if (typeof profileId !== 'string') continue;
    return { socket, pid: Number.isInteger(id.pid) ? id.pid : null, instanceId: id.instance_id, profileId, origin: id.api_origin, home };
  }
  return null;
}

// ---------------------------------------------------------------- may a listing reach the gateway?

// A Hermes client among the first argv words: the hermes, hermes-agent or hermes-acp script, python -m
// hermes_cli, or the TUI's node entry (ui-tui/dist/entry.js). The gateway itself (gateway run) is not a client, and
// neither is a shell that started one (`sh -c "hermes chat"`): the client is its own process, and the shell can
// outlive it.
const CLIENT_WORD = /(?:^|\/)hermes(?:-agent|-acp)?$|(?:^|[/.])hermes_cli(?:[/.]|$)|\/ui-tui\/dist\/entry\.js$/;
const SHELL = /(?:^|\/)-?(?:sh|bash|zsh|fish|dash|ksh)$/;

/** Pids of the Hermes clients in a `ps -o pid=,command=` listing, leaving out the pids in exclude. Pure. */
export function clientPids(psText, { exclude = [] } = {}) {
  const skip = new Set(exclude.filter(Number.isInteger));
  const out = [];
  for (const line of String(psText ?? '').split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!m || skip.has(Number(m[1])) || /\sgateway\s+(?:run|start|ensure|stop|restart)\b/.test(m[2])) continue;
    const words = m[2].split(/\s+/);
    if (!SHELL.test(words[0]) && words.slice(0, 3).some((w) => CLIENT_WORD.test(w))) out.push(Number(m[1]));
  }
  return out;
}

let psCache = { at: -Infinity, text: '' };
async function processList() {
  const now = _deps.now();
  if (now - psCache.at < 5_000) return psCache.text;
  const text = await _deps.ps().catch(() => '');
  psCache = { at: now, text };
  return text;
}

/**
 * May a listing open a WebSocket to this gateway? Any HTTP or WebSocket traffic counts as client activity, which
 * holds off the idle exit of a gateway a client started on its own (`gateway run --idle-exit`, after 600 s with no
 * clients and no work: gateway/run_idle_exit.py), and Drover lists sessions every few seconds, so polling it would
 * keep that daemon up for good. The control socket's identify and status do not count. So a listing goes to the
 * WebSocket only when that cannot change how long the gateway lives: it was not started with --idle-exit (a
 * service, `hermes gateway run` by hand, Desktop), or a Hermes client is running here, which holds it up anyway.
 * Otherwise no client is attached, so no session is live, and the list comes from the database alone. A turn in
 * flight (busy: the database shows one queued or started) also allows it: the gateway stays up for that work anyway,
 * and a turn Drover sent with no client attached may be waiting on an approval only the gateway can show.
 */
export async function mayPoll(gw, { busy = false } = {}) {
  let argv = null;
  try { argv = (await control(gw.socket, 'status')).argv; } catch { /* judged by its clients and work alone */ }
  if (Array.isArray(argv) && !argv.includes('--idle-exit')) return true;
  // A turn in flight holds the gateway up too, and may be waiting on an approval no client is attached to see.
  if (busy) return true;
  return clientPids(await processList(), { exclude: [gw.pid, process.pid] }).length > 0;
}

// ---------------------------------------------------------------- the WebSocket

/**
 * A JSON-RPC connection to a gateway, opened with a fresh ticket: { call(method, params, opts), on(fn) -> off,
 * close() }. Hold it only for what one operation needs: an open connection counts as an attached client.
 */
export async function connect(gw, { timeoutMs = 8_000 } = {}) {
  const grant = await control(gw.socket, 'session-ticket', { profile_id: gw.profileId, instance_id: gw.instanceId, purpose: 'interactive' });
  if (typeof grant?.ticket !== 'string' || !grant.ticket || grant.instance_id !== gw.instanceId) throw new Error('the Hermes gateway did not grant a session ticket');
  const ws = new _deps.WebSocket(`${gw.origin.replace(/^http:/, 'ws:')}/api/ws`, [PROTOCOL, `${TICKET_PREFIX}${grant.ticket}`]);
  const pending = new Map(), listeners = new Set();
  let nextId = 0, closed = null;
  const fail = (why) => { for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error(why)); } pending.clear(); };
  ws.addEventListener('message', (m) => {
    let d;
    try { d = JSON.parse(typeof m.data === 'string' ? m.data : Buffer.from(m.data).toString('utf8')); } catch { return; }
    if (d?.id != null && pending.has(d.id)) {
      const p = pending.get(d.id); pending.delete(d.id); clearTimeout(p.timer);
      if (d.error) p.reject(Object.assign(new Error(`Hermes ${p.method}: ${d.error.message ?? d.error.code ?? 'error'}`), { rpc: d.error }));
      else p.resolve(d.result);
      return;
    }
    if (d?.method === 'event' && d.params) for (const l of listeners) { try { l(d.params); } catch { /* a listener's own error */ } }
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { try { ws.close(); } catch { /* closing */ } reject(new Error('the Hermes gateway WebSocket did not open')); }, timeoutMs);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); });
    ws.addEventListener('close', (e) => {
      closed = e; clearTimeout(timer);
      fail(`the Hermes gateway closed the connection (${e?.code ?? 'closed'})`);
      reject(new Error(`the Hermes gateway refused the WebSocket (${e?.code ?? 'closed'})`));
    });
  });
  if (ws.protocol !== PROTOCOL) { ws.close(); throw new Error(`the Hermes gateway answered with protocol ${JSON.stringify(ws.protocol)}, not ${PROTOCOL}`); }
  return {
    call(method, params = {}, { timeoutMs: t = 30_000 } = {}) {
      if (closed) return Promise.reject(new Error('the Hermes gateway connection is closed'));
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Hermes ${method} timed out`)); }, t);
        pending.set(id, { resolve, reject, timer, method });
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      });
    },
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    close() { listeners.clear(); try { ws.close(); } catch { /* closed */ } },
  };
}

/** fn(connection) on a fresh connection to gw, closed afterwards whatever happens. */
export async function withGateway(gw, fn) {
  const c = await connect(gw);
  try { return await fn(c); } finally { c.close(); }
}

// ---------------------------------------------------------------- the database

const dbErrors = new Set();
function dbError(home, e) {
  const msg = `${home}: ${e.message}`;
  if (dbErrors.has(msg)) return;
  dbErrors.add(msg);
  process.stderr.write(`[hermes] reading state.db failed: ${msg}\n`);
}

/** fn(db) on a read-only handle to a home's state.db, closed afterwards; fallback when there is none or the read fails. */
function withDb(home, fn, fallback) {
  const f = path.join(home, 'state.db');
  if (!existsSync(f)) return fallback;
  let db;
  try { db = new DatabaseSync(f, { readOnly: true, timeout: 2_000 }); } catch (e) { dbError(home, e); return fallback; }
  try { return fn(db); } catch (e) { dbError(home, e); return fallback; } finally { try { db.close(); } catch { /* closed */ } }
}

// The session columns Drover reads, whichever of them this Hermes has: never `SELECT *`, which would pull each
// row's system prompt along.
const SESSION_COLS = ['id', 'title', 'cwd', 'model', 'started_at', 'ended_at', 'end_reason', 'last_activity_at', 'source', 'created_source', 'parent_session_id', 'archived', 'hidden', 'message_count', 'git_branch'];
function sessionCols(db) {
  const have = new Set(db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name));
  const cols = SESSION_COLS.filter((c) => have.has(c));
  const activity = ['last_activity_at', 'ended_at', 'started_at'].filter((c) => have.has(c));
  return { list: cols.join(', '), activity: activity.length > 1 ? `COALESCE(${activity.join(', ')})` : activity[0] ?? 'rowid' };
}

// The surfaces a person runs Hermes at on this machine (a row's created_source; source is rewritten to local per turn):
// the CLI and TUI, Desktop, an ACP editor, one-shots. The rest are not listed: Hermes' own tool calls, subagents, kanban
// and cron runs, and the conversations of its messaging platforms (Telegram, Slack and the like), where Drover is not
// a party to the chat.
const LOCAL_SURFACES = new Set(['cli', 'tui', 'gui', 'desktop', 'acp', 'oneshot', 'local']);
const POLICY_PREFIX = 'gateway.local_policy.v1:';
const secs = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const isoOf = (v) => { const s = secs(v); return s === null ? null : new Date(s * 1000).toISOString(); };

/**
 * Reset lineages: a gateway-local conversation that was reset keeps its creation id as the owner and goes on in
 * new rows; its policy row in state_meta lists every row in order (hermes_state_local.local_lineage_index). Only
 * the owner and the lineage are read: the same value holds the client's environment, which Drover never reads.
 * { owners: id -> owner, chains: owner -> [ids] }
 */
function lineages(db) {
  const owners = new Map(), chains = new Map();
  let rows = [];
  try {
    rows = db.prepare(`SELECT json_extract(value, '$.session_id') AS owner, json_extract(value, '$.lineage') AS lineage FROM state_meta
      WHERE key GLOB ? AND json_valid(value) AND json_type(value, '$.lineage') = 'array' AND json_array_length(value, '$.lineage') > 1`).all(`${POLICY_PREFIX}*`);
  } catch { return { owners, chains }; }
  for (const r of rows) {
    let ids;
    try { ids = JSON.parse(r.lineage); } catch { continue; }
    if (typeof r.owner !== 'string' || !Array.isArray(ids) || !ids.every((x) => typeof x === 'string')) continue;
    chains.set(r.owner, ids);
    for (const id of ids) owners.set(id, r.owner);
    owners.set(r.owner, r.owner);
  }
  return { owners, chains };
}

/**
 * The working directory the gateway recorded for conversations whose row has none yet (a TUI session leaves the
 * row's cwd empty until it closes): $.policy.cwd of their policy rows, that one field only. id -> cwd.
 */
function policyCwds(db, ids) {
  if (!ids.length) return new Map();
  try {
    const rows = db.prepare(`SELECT key, json_extract(value, '$.policy.cwd') AS cwd FROM state_meta WHERE key IN (${marks(ids.length)}) AND json_valid(value)`).all(...ids.map((id) => POLICY_PREFIX + id));
    return new Map(rows.filter((r) => typeof r.cwd === 'string' && r.cwd).map((r) => [r.key.slice(POLICY_PREFIX.length), r.cwd]));
  } catch { return new Map(); }
}

/** The conversation a row belongs to: its lineage owner, else the root of its compression chain (a compressed session goes on in a child row). */
function conversationOf(db, id, lin) {
  if (lin.owners.has(id)) return lin.owners.get(id);
  const parentOf = db.prepare('SELECT s.parent_session_id AS parent, p.end_reason AS reason FROM sessions s LEFT JOIN sessions p ON p.id = s.parent_session_id WHERE s.id = ?');
  let cur = id;
  for (let i = 0; i < 100; i++) {
    const r = parentOf.get(cur);
    // Hermes' own edge (hermes_state_common.py _COMPRESSION_CHILD_SQL) is a child of a row that ended in compression;
    // a branch of that row carries the same parent, so only its continuation, the newest child, goes on in it.
    if (!r?.parent || r.reason !== 'compression' || continuationOf(db, r.parent) !== cur) break;
    cur = r.parent;
  }
  return lin.owners.get(cur) ?? cur;
}

/** The row a compression-ended row went on in: its newest child (a branch made before the compression is older), or null. */
function continuationOf(db, id) {
  return db.prepare("SELECT c.id FROM sessions c JOIN sessions p ON p.id = c.parent_session_id WHERE c.parent_session_id = ? AND p.end_reason = 'compression' ORDER BY c.started_at DESC, c.rowid DESC LIMIT 1").get(id)?.id ?? null;
}

/** Every row of a conversation, oldest first: its lineage, else the row and the compression continuations it went on in. */
function rowsOf(db, id, lin) {
  if (lin.chains.has(id)) return lin.chains.get(id);
  const out = [id];
  for (let i = 0; i < 100; i++) { const next = continuationOf(db, out.at(-1)); if (!next || out.includes(next)) break; out.push(next); }
  return out;
}

/** id -> the conversation it belongs to, for ids the gateway names (a live one may be a later segment). */
export function conversationsOf(home, ids) {
  return withDb(home, (db) => { const lin = lineages(db); return new Map(ids.map((id) => [id, conversationOf(db, id, lin)])); }, new Map(ids.map((id) => [id, id])));
}

const marks = (n) => Array.from({ length: n }, () => '?').join(', ');

/** The parts of a messages query this Hermes's schema allows: which rows are still shown, and the optional columns. */
function messageCols(db) {
  const have = new Set(db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name));
  const shown = have.has('active') ? (have.has('compacted') ? '(active = 1 OR compacted = 1)' : 'active = 1') : '1 = 1';
  return {
    shown,
    notSummary: have.has('_compressed_summary') ? 'COALESCE(_compressed_summary, 0) = 0' : '1 = 1',
    extra: ['tool_calls', 'tool_call_id', 'tool_name', 'reasoning', 'reasoning_content'].filter((c) => have.has(c)).join(', '),
  };
}

/**
 * The conversations of one home active within `days`, newest first, as Drover session items (not yet overlaid
 * with live state). The DB shapes are folded: a reset lineage or a compression chain is one conversation under
 * its first id, with the newest row's cwd and model and the activity of all of them.
 */
export function storedSessions(home, { profile = null, days = 4, limit = 200, ids = null } = {}) {
  return withDb(home, (db) => {
    const { list, activity } = sessionCols(db);
    const lin = lineages(db);
    const since = _deps.now() / 1000 - days * 86400;
    const rows = ids
      ? db.prepare(`SELECT ${list} FROM sessions WHERE id IN (${marks(ids.length)})`).all(...ids)
      : db.prepare(`SELECT ${list} FROM sessions WHERE ${activity} >= ? ORDER BY ${activity} DESC LIMIT ?`).all(since, limit * 3);
    const groups = new Map();
    const one = db.prepare(`SELECT ${list} FROM sessions WHERE id = ?`);
    for (const r of rows) {
      if (!LOCAL_SURFACES.has(r.created_source ?? r.source ?? 'local') || r.archived || r.hidden) continue;
      const conv = conversationOf(db, r.id, lin);
      if (!groups.has(conv)) groups.set(conv, { head: conv === r.id ? r : one.get(conv) ?? r, rows: [] });
      groups.get(conv).rows.push(r);
    }
    const preview = db.prepare("SELECT substr(content, 1, 300) AS text FROM messages WHERE session_id = ? AND role = 'user' AND content IS NOT NULL AND content != '' ORDER BY id LIMIT 1");
    const cwds = policyCwds(db, [...groups].filter(([, g]) => ![g.head, ...g.rows].some((r) => r.cwd)).map(([id]) => id));
    const out = [];
    for (const [id, g] of groups) {
      const all = [g.head, ...g.rows.filter((r) => r.id !== g.head.id)];
      const act = (r) => secs(r.last_activity_at) ?? secs(r.ended_at) ?? secs(r.started_at) ?? 0;
      const latest = all.reduce((a, b) => (act(b) > act(a) ? b : a));
      const tip = all.reduce((a, b) => ((secs(b.started_at) ?? 0) > (secs(a.started_at) ?? 0) ? b : a));
      const ended = tip.ended_at != null && !['compression', 'session_reset'].includes(tip.end_reason);
      const title = typeof g.head.title === 'string' && g.head.title.trim() ? g.head.title.trim() : null;
      const first = title ? null : preview.get(g.head.id)?.text ?? null;
      out.push({
        id, sessionId: id, kind: 'hermes', engine: ENGINE,
        name: (title ?? first ?? id.replace(/^local-/, '').slice(0, 8)).replace(/\s+/g, ' ').slice(0, 120),
        title, cwd: latest.cwd ?? g.head.cwd ?? all.find((r) => r.cwd)?.cwd ?? cwds.get(id) ?? null, model: latest.model ?? g.head.model ?? null,
        source: g.head.created_source ?? g.head.source ?? null, ...(profile ? { profile } : {}),
        startedAt: isoOf(g.head.started_at), updatedAt: isoOf(act(latest)), statusUpdatedAt: isoOf(act(latest)),
        messageCount: all.reduce((n, r) => n + (Number(r.message_count) || 0), 0),
        ...(first ? { preview: first.slice(0, 200) } : {}),
        live: false, status: ended ? 'ended' : 'stored', ...(ended ? { endReason: tip.end_reason ?? null } : {}),
      });
      if (!ids && out.length >= limit) break;
    }
    return out;
  }, []);
}

/** Conversations with a turn queued or running (session_admissions), from the database: what is live with no gateway to ask. */
function inFlight(home) {
  return withDb(home, (db) => {
    const lin = lineages(db);
    const rows = db.prepare("SELECT target_session_id AS id, status FROM session_admissions WHERE status IN ('queued', 'started')").all();
    return new Map(rows.map((r) => [conversationOf(db, r.id, lin), r.status]));
  }, new Map());
}

/** The last thing a conversation said, { text, ts } or null: its newest assistant text that is still shown (not rewound). */
function lastAssistant(home, id) {
  return withDb(home, (db) => {
    const ids = rowsOf(db, id, lineages(db));
    const { shown } = messageCols(db);
    const r = db.prepare(`SELECT content, timestamp FROM messages WHERE session_id IN (${marks(ids.length)}) AND role = 'assistant' AND content IS NOT NULL AND trim(content) != '' AND ${shown} ORDER BY id DESC LIMIT 1`).get(...ids);
    return r ? { text: r.content, ts: isoOf(r.timestamp) } : null;
  }, null);
}

// ---------------------------------------------------------------- transcripts

// Hermes tool names onto the names Drover's tool summaries know (core/toolcalls.js).
const TOOL_ALIAS = { terminal: 'Bash', read_file: 'Read', write_file: 'Write', patch: 'Edit', search_files: 'Grep', web_search: 'WebSearch', web_extract: 'WebFetch', delegate_task: 'Task', todo: 'TodoWrite' };
const compact = (v) => { const s = typeof v === 'string' ? v : JSON.stringify(v ?? ''); return s.length > 300 ? `${s.slice(0, 300)}…` : v; };

function toolCallsOf(raw) {
  let calls;
  try { calls = JSON.parse(raw); } catch { return []; }
  return (Array.isArray(calls) ? calls : []).map((c) => {
    const name = c?.function?.name ?? c?.name ?? 'tool';
    let input = c?.function?.arguments ?? c?.arguments ?? c?.input ?? '';
    if (typeof input === 'string') { try { input = JSON.parse(input); } catch { /* the raw text */ } }
    return { id: c?.id ?? c?.call_id ?? null, name, input: compact(input), summary: toolSummary(TOOL_ALIAS[name] ?? name, input) };
  });
}

/** A tool row's content as text and whether the call failed: Hermes' terminal writes {"output", "exit_code", "error"}. */
export function toolOutput(content) {
  const raw = typeof content === 'string' ? content : JSON.stringify(content ?? '');
  let d = null;
  try { d = JSON.parse(raw); } catch { /* plain text */ }
  if (d && typeof d === 'object' && !Array.isArray(d) && ('output' in d || 'error' in d || 'exit_code' in d)) {
    const failed = (d.error != null && d.error !== '') || (Number.isInteger(d.exit_code) && d.exit_code !== 0);
    return { text: [typeof d.output === 'string' ? d.output : d.output == null ? '' : JSON.stringify(d.output), d.error ? `error: ${d.error}` : ''].filter(Boolean).join('\n'), failed };
  }
  return { text: raw, failed: false };
}

/** messages rows as Drover chat turns (user, assistant with its tool calls, tool_result, thinking). Pure. */
export function rowsToTurns(rows) {
  const turns = [];
  for (const r of rows) {
    const ts = isoOf(r.timestamp);
    if (r.role === 'user') { if (typeof r.content === 'string' && r.content.trim()) turns.push({ role: 'user', ts, text: r.content, id: r.id }); continue; }
    if (r.role === 'assistant') {
      const tools = r.tool_calls ? toolCallsOf(r.tool_calls) : [];
      const text = typeof r.content === 'string' ? r.content : '';
      if (text.trim() || tools.length) turns.push({ role: 'assistant', ts, text, tools, id: r.id });
      else if (r.reasoning || r.reasoning_content) turns.push({ role: 'thinking', ts, id: r.id });
      continue;
    }
    if (r.role === 'tool') {
      const out = toolOutput(r.content);
      const e = resultEntry(r.tool_call_id ?? null, out.text, { isError: out.failed });
      turns.push({ role: 'tool_result', ts, count: 1, text: (out.failed ? '[error] ' : '') + e.text.slice(0, 400), results: [e], id: r.id });
    }
  }
  return turns;
}

/**
 * A conversation's turns from the database, oldest first, at most `limit` of the newest. since is a messages row
 * id from a previous call's offset (rows after it only), so a client can poll; offset is the newest row read.
 * Rewound rows (active = 0, compacted = 0) were undone and are left out; compacted ones are history and stay.
 */
export function transcriptOf(home, id, { since = 0, limit = 200 } = {}) {
  return withDb(home, (db) => {
    const ids = rowsOf(db, id, lineages(db));
    const { shown, notSummary, extra } = messageCols(db);
    const rows = db.prepare(`SELECT id, role, content, timestamp${extra ? `, ${extra}` : ''} FROM messages
      WHERE session_id IN (${marks(ids.length)}) AND id > ? AND ${shown} AND ${notSummary} ORDER BY id DESC LIMIT ?`).all(...ids, Number(since) || 0, Math.max(1, Math.min(2000, Number(limit) || 200)) * 2).reverse();
    const turns = rowsToTurns(rows).slice(-(Number(limit) || 200));
    return { turns: turns.map(({ id: _rowId, ...t }) => t), offset: rows.length ? rows.at(-1).id : Number(since) || 0 };
  }, { turns: [], offset: Number(since) || 0 });
}

// ---------------------------------------------------------------- prompts the gateway is holding

const CHOICE_LABEL = { once: 'Allow once', session: 'Allow this session', always: 'Always allow', deny: 'Deny' };
// The order the Hermes TUI numbers an approval's choices in, Deny last (ui-tui/src/components/prompts.tsx
// APPROVAL_OPTS), keeping only those the gateway offers. The gateway's own list is in another order (once, deny,
// session, always), so numbering by it would make a digit pressed here mean another choice than the same digit in
// the pane: 4 would allow always where the pane says deny.
const APPROVAL_ORDER = ['once', 'session', 'always', 'deny'];
const approvalChoices = (p) => APPROVAL_ORDER.filter((c) => Array.isArray(p?.choices) && p.choices.includes(c));

/**
 * A pending gateway prompt as a dialog Drover's clients answer like a pane's: { dialog: { question, options },
 * hash, keys, answer }. An approval's choices become 1..n in the TUI's order (Enter picks the first, once; Escape
 * denies); a clarify
 * with choices becomes 1..n;
 * a clarify without them, or one that takes several choices, is answered with a message (answer: "reply"). hash is
 * the prompt id, the `expect` an answer must carry. null for a prompt Drover does not answer (a secret, sudo or
 * vault prompt: those are answered at the terminal). Pure.
 */
export function promptDialog(p) {
  if (!p || typeof p.prompt_id !== 'string') return null;
  if (p.kind === 'approval') {
    const choices = approvalChoices(p);
    const what = [p.command, p.description ? `(${p.description})` : ''].filter(Boolean).join(' ');
    // Option 1 (Hermes lists once first) counts as highlighted, so Enter (a notification's Approve) picks it, as in a pane.
    const options = choices.map((c, i) => ({ n: i + 1, label: CHOICE_LABEL[c] ?? c, ...(i === 0 ? { selected: true } : {}) }));
    return { dialog: { question: `Run ${what || 'this command'}?`.slice(0, 300), options }, hash: p.prompt_id, keys: [...options.map((o) => String(o.n)), ...(options.length ? ['Enter'] : []), ...(choices.includes('deny') ? ['Escape'] : [])], answer: 'keys', kind: 'approval' };
  }
  if (p.kind === 'clarify') {
    const choices = (Array.isArray(p.choices) ? p.choices : []).filter((c) => typeof c === 'string');
    const question = String(p.question ?? 'Hermes asks a question').slice(0, 300);
    if (!choices.length || p.multi_select || choices.length > 9) return { dialog: { question, options: [] }, hash: p.prompt_id, keys: [], answer: 'reply', kind: 'clarify' };
    const options = choices.map((c, i) => ({ n: i + 1, label: c.slice(0, 120) }));
    return { dialog: { question, options }, hash: p.prompt_id, keys: options.map((o) => String(o.n)), answer: 'keys', kind: 'clarify' };
  }
  return null;
}

/** What answering a prompt with one key sends, { method, field, value } or { refused: reason }. Pure. */
export function promptResponse(p, key) {
  const n = /^[1-9]$/.test(String(key)) ? Number(key) : null;
  if (p?.kind === 'approval') {
    const choices = approvalChoices(p);
    if (key === 'Escape' && choices.includes('deny')) return { method: 'approval.respond', field: 'choice', value: 'deny' };
    if (key === 'Enter' && choices.length) return { method: 'approval.respond', field: 'choice', value: choices[0] };
    if (n && n <= choices.length) return { method: 'approval.respond', field: 'choice', value: choices[n - 1] };
    return { refused: `this approval takes ${choices.map((_, i) => i + 1).join(', ')}, Enter (${choices[0] ?? 'the first'})${choices.includes('deny') ? ' or Escape (deny)' : ''}` };
  }
  if (p?.kind === 'clarify') {
    const choices = (Array.isArray(p.choices) ? p.choices : []).filter((c) => typeof c === 'string');
    if (n && n <= choices.length && !p.multi_select) return { method: 'clarify.respond', field: 'answer', value: choices[n - 1] };
    return { refused: choices.length && !p.multi_select ? `this question takes ${choices.map((_, i) => i + 1).join(', ')}` : 'this question is answered with a message' };
  }
  return { refused: 'Drover does not answer this kind of Hermes prompt; answer it in its terminal' };
}

const STATUS = { working: 'busy', starting: 'busy', waiting: 'waiting', idle: 'idle' };

/**
 * What the gateway says is live: id -> { status, title, model, startedAt, lastActive, prompts }. A waiting
 * session's prompts come from session.resume without its messages; the connection closes right after, which
 * detaches that viewer again.
 */
async function gatewayLive(gw) {
  return withGateway(gw, async (c) => {
    const r = await c.call('session.active_list', {}, { timeoutMs: 10_000 });
    const out = new Map();
    for (const s of Array.isArray(r?.sessions) ? r.sessions : []) {
      if (typeof s?.id !== 'string') continue;
      let prompts = [];
      if (s.status === 'waiting') {
        try { prompts = (await c.call('session.resume', { session_id: s.id, omit_messages: true }, { timeoutMs: 10_000 }))?.prompts ?? []; } catch { /* shown as waiting, unanswerable here */ }
      }
      out.set(s.id, { status: STATUS[s.status] ?? String(s.status ?? 'unknown'), title: s.title ?? null, model: s.model ?? null, startedAt: isoOf(s.started_at), lastActive: isoOf(s.last_active), source: typeof s.source === 'string' ? s.source : null, prompts: Array.isArray(prompts) ? prompts : [] });
    }
    return out;
  });
}

const RANK = { waiting: 3, busy: 2, starting: 2, idle: 1 };
/**
 * Live entries keyed by conversation: the gateway may name a later segment of one (a compressed or reset session).
 * Two entries for one conversation keep the one that asks the most of the owner (waiting, then busy), with the
 * gateway's own id (gatewayId), which is what session.resume and every answer must name.
 */
function foldLive(live, convs) {
  const out = new Map();
  for (const [gid, l] of live) {
    const conv = convs.get(gid) ?? gid;
    const was = out.get(conv);
    if (!was || (RANK[l.status] ?? 0) > (RANK[was.status] ?? 0)) out.set(conv, { ...l, gatewayId: gid });
  }
  return out;
}

// ---------------------------------------------------------------- which tmux window a session is in

const PANES_FILE = () => path.join(stateDir(), 'hermes-panes.json');

/** Remember the window Drover launched a titled Hermes session in (title -> window), kept to the newest 200. */
export async function rememberPane(title, window, { home } = {}) {
  const f = PANES_FILE();
  let map = {};
  try { map = JSON.parse(await readFile(f, 'utf8')); } catch { /* first one */ }
  map[title] = { window, home: home ?? null, ts: new Date(_deps.now()).toISOString() };
  const keep = Object.entries(map).sort((a, b) => String(b[1].ts).localeCompare(String(a[1].ts))).slice(0, 200);
  await mkdir(path.dirname(f), { recursive: true, mode: 0o700 });
  const tmp = `${f}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(Object.fromEntries(keep)), { mode: 0o600 });
  await rename(tmp, f);
}

/**
 * id -> tmux window ("session:@id") for live sessions: the window Drover launched a session's title in, else
 * the pane whose tty a classic Hermes REPL recorded in <home>/terminal-sessions (the TUI records none).
 */
async function windowsOf(home, live) {
  const out = new Map();
  if (!live.length) return out;
  let launched = {};
  try { launched = JSON.parse(await readFile(PANES_FILE(), 'utf8')); } catch { /* none launched */ }
  let panes = null;
  for (const s of live) {
    const l = s.title ? launched[s.title] : null;
    if (l?.window && (!l.home || samePath(l.home, home))) { out.set(s.id, l.window); continue; }
  }
  const dir = path.join(home, 'terminal-sessions');
  let names = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const n of names) {
    const m = n.match(/^tty-(.+)$/);
    if (!m) continue;
    let crumb;
    try { crumb = JSON.parse(readFileSync(path.join(dir, n), 'utf8')); } catch { continue; }
    // The breadcrumb names the segment the REPL runs, which the gateway names too (gatewayId once folded).
    const s = live.find((x) => (x.id === crumb?.session_id || x.gatewayId === crumb?.session_id) && !out.has(x.id));
    if (!s) continue;
    panes ??= await _deps.paneTtys().catch(() => []);
    // The breadcrumb names the tty as Hermes sanitized it: /dev/ttys003 -> dev-ttys003.
    const p = panes.find((x) => String(x.tty ?? '').replace(/^\/+/, '').replace(/[^A-Za-z0-9_.-]+/g, '-') === m[1]);
    if (p) out.set(s.id, p.window);
  }
  return out;
}

// ---------------------------------------------------------------- the session list

/**
 * Hermes sessions on this host, as Drover session items: the live ones always (from the gateway when a listing may
 * ask it, mayPoll; else the turns the database shows in flight), and with includeRecent the stored conversations of
 * the last `days` days too. A live item carries status busy | waiting | idle, and while a prompt is pending its
 * dialog, hash and keys (promptDialog), so every client answers it the way it answers a dialog in a pane. Callers
 * within two seconds of each other share one listing (the board, the alert detector and a lookup arrive together).
 */
const LIST_MEMO_MS = 2_000;
let listMemo = new Map();   // includeRecent -> { at, value }
/** Forget the shared listing and the process list (tests, and a caller that just changed what Hermes holds). */
export function clearCaches() { listMemo = new Map(); psCache = { at: -Infinity, text: '' }; }
export function listSessions(opts = {}) {
  const key = JSON.stringify([opts.includeRecent !== false, opts.days ?? 4, opts.limit ?? 200]);
  const m = listMemo.get(key);
  if (m && _deps.now() - m.at < LIST_MEMO_MS) return m.value;
  const value = listSessionsUncached(opts);
  listMemo.set(key, { at: _deps.now(), value });
  value.catch(() => listMemo.delete(key));
  return value;
}

async function listSessionsUncached({ includeRecent = true, days = 4, limit = 200 } = {}) {
  const out = [];
  const root = rootHome();
  for (const { home, profile } of homes()) {
    const gw = await gatewayFor(home, root).catch(() => null);
    const busy = inFlight(home);
    let live = null;
    if (gw && (await mayPoll(gw, { busy: busy.size > 0 }).catch(() => false))) live = await gatewayLive(gw).catch(() => null);
    if (!live) live = new Map([...busy].map(([id]) => [id, { status: 'busy', source: null, prompts: [] }]));
    live = foldLive(live, conversationsOf(home, [...live.keys()]));
    const stored = storedSessions(home, { profile, days, limit });
    const byId = new Map(stored.map((s) => [s.id, s]));
    const missing = [...live.keys()].filter((id) => !byId.has(id));
    if (missing.length) for (const s of storedSessions(home, { profile, ids: missing })) byId.set(s.id, s);
    const items = [];
    for (const [id, l] of live) {
      // Not a conversation of a local surface (its stored row was left out, or the gateway names a messaging platform): not listed.
      if (!byId.has(id) && !(l.source && LOCAL_SURFACES.has(l.source))) continue;
      const base = byId.get(id) ?? { id, sessionId: id, kind: 'hermes', engine: ENGINE, name: l.title ?? id.replace(/^local-/, '').slice(0, 8), title: l.title ?? null, cwd: null, model: l.model ?? null, ...(profile ? { profile } : {}), startedAt: l.startedAt ?? null };
      const pending = l.prompts.map(promptDialog).find(Boolean);
      const last = lastAssistant(home, id);
      items.push({
        ...base, live: true, status: l.status, ...(l.gatewayId && l.gatewayId !== id ? { gatewayId: l.gatewayId } : {}), model: l.model ?? base.model ?? null, updatedAt: base.updatedAt ?? l.lastActive ?? null, statusUpdatedAt: base.statusUpdatedAt ?? l.lastActive ?? null,
        ...(last?.text ? { summary: last.text.split('\n').map((x) => x.trim()).filter(Boolean).at(-1)?.slice(0, 200) ?? null } : {}),
        ...(pending ? { dialog: pending.dialog, hash: pending.hash, keys: pending.keys, answer: pending.answer, prompt: { kind: pending.kind, id: pending.hash } } : {}),
      });
    }
    const wins = await windowsOf(home, items);
    for (const s of items) if (wins.has(s.id)) s.tmux = wins.get(s.id);
    out.push(...items);
    if (includeRecent) for (const s of byId.values()) if (!live.has(s.id)) out.push(s);
  }
  return out;
}

/**
 * Where a session id or exact title is, { home, profile, id } with id its conversation, or null when no home's
 * database has it (the root first, then the named profiles).
 */
function locate(idOrTitle) {
  for (const h of homes()) {
    const id = withDb(h.home, (db) => {
      const row = db.prepare('SELECT id FROM sessions WHERE id = ?').get(idOrTitle) ?? db.prepare('SELECT id FROM sessions WHERE title = ? ORDER BY started_at DESC LIMIT 1').get(idOrTitle);
      const lin = lineages(db);
      if (!row && !lin.owners.has(idOrTitle)) return null;
      return conversationOf(db, row?.id ?? idOrTitle, lin);
    }, null);
    if (id) return { ...h, id };
  }
  return null;
}

/** One session by id or exact title (a row of any segment resolves to its conversation), live state included; null when unknown. */
export async function findSession(idOrTitle) {
  if (typeof idOrTitle !== 'string' || !idOrTitle.trim() || idOrTitle.length > 300) return null;
  const h = locate(idOrTitle);
  if (!h) return null;
  const conv = h.id;
  const all = await listSessions({ includeRecent: false }).catch(() => []);
  const live = all.find((s) => s.id === conv);
  if (live) return { ...live, home: h.home };
  const [stored] = storedSessions(h.home, { profile: h.profile, ids: [conv] });
  return stored ? { ...stored, home: h.home } : null;
}

export function transcript(s, { since = 0, limit = 200 } = {}) {
  return { engine: ENGINE, ...transcriptOf(s.home ?? rootHome(), s.id, { since, limit }) };
}

export function lastReply(s) { return lastAssistant(s.home ?? rootHome(), s.id); }

// ---------------------------------------------------------------- acting on a session

/** The gateway for a session's home, or a throw that says what to do. */
async function gatewayOrThrow(s) {
  const gw = await gatewayFor(s.home ?? rootHome());
  if (!gw) throw new Error('no Hermes gateway is running for this session\'s profile');
  return gw;
}

/**
 * The prompt a session is holding now, read from a fresh session.resume on c (which also subscribes c, as
 * approval.respond requires): the one whose id is expect when given, else the only one.
 */
async function currentPrompt(c, id) {
  const snap = await c.call('session.resume', { session_id: id, omit_messages: true }, { timeoutMs: 15_000 });
  return { snap, prompts: (Array.isArray(snap?.prompts) ? snap.prompts : []).filter((p) => p && typeof p.prompt_id === 'string') };
}

/**
 * Answer the prompt a Hermes session is holding with one key (promptResponse), and only that prompt: refused
 * (refused: true, with the dialog as it is now) when nothing is pending, when expect names another prompt, or when
 * the key does not fit it. { ok, key, choice, dialog, hash } on success.
 */
export async function answer(s, key, { expect } = {}) {
  const gw = await gatewayOrThrow(s);
  return withGateway(gw, async (c) => {
    const gid = s.gatewayId ?? s.id;
    const { prompts } = await currentPrompt(c, gid);
    const shown = prompts.map((p) => ({ p, d: promptDialog(p) })).filter((x) => x.d);
    if (!shown.length) return { ok: false, refused: true, reason: 'no Hermes prompt is waiting any more' };
    const hit = expect ? shown.find((x) => x.p.prompt_id === expect) : shown.length === 1 ? shown[0] : null;
    if (!hit) return { ok: false, refused: true, reason: expect ? 'the prompt changed since you read it; read it again' : 'more than one prompt is waiting: pass the one you mean as expect', dialog: shown[0].d.dialog, hash: shown[0].d.hash, keys: shown[0].d.keys };
    const r = promptResponse(hit.p, key);
    if (r.refused) return { ok: false, refused: true, reason: r.refused, dialog: hit.d.dialog, hash: hit.d.hash, keys: hit.d.keys };
    const res = await c.call(r.method, { session_id: gid, execution_generation: hit.p.execution_generation, prompt_id: hit.p.prompt_id, [r.field]: r.value }, { timeoutMs: 15_000 });
    if (res?.status !== 'resolved') return { ok: false, refused: true, reason: res?.status === 'already_resolved' ? 'that prompt was already answered' : `Hermes answered ${JSON.stringify(res?.status ?? null)}`, dialog: hit.d.dialog, hash: hit.d.hash };
    return { ok: true, key, [r.field]: r.value, dialog: hit.d.dialog, hash: hit.d.hash, via: `hermes ${r.method}` };
  });
}

/**
 * Deliver a message into a Hermes session. Through the gateway: a question it is holding (a clarify) gets the text as
 * its answer, which is what the TUI's "Other (type your answer)" sends too, so a session blocked on a question moves on
 * instead of queueing the message behind it; anything else becomes a turn (session.resume to subscribe, then
 * prompt.submit, which queues it behind a running turn or a pending prompt); turn: true always does that. With no
 * gateway up, a one-shot `hermes chat --resume` runs the turn and starts one. Returns the delivery for the message event.
 */
export async function send(s, text, { model, turn = false } = {}) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('empty message');
  const gw = await gatewayFor(s.home ?? rootHome());
  if (!gw) return resumeOneShot(s, text, { model });
  const gid = s.gatewayId ?? s.id;
  return withGateway(gw, async (c) => {
    const { snap, prompts } = await currentPrompt(c, gid);
    // turn: a message accepted as a turn of its own before the question was asked; it stays one.
    const free = turn ? null : prompts.find((p) => p.kind === 'clarify');
    if (free) {
      const res = await c.call('clarify.respond', { session_id: gid, execution_generation: free.execution_generation, prompt_id: free.prompt_id, answer: text }, { timeoutMs: 15_000 });
      return { ok: res?.status === 'resolved', via: 'hermes clarify.respond', answered: free.prompt_id, ...(res?.status === 'resolved' ? {} : { error: `Hermes answered ${res?.status ?? 'nothing'}` }) };
    }
    const receipt = await c.call('prompt.submit', { session_id: gid, text, input_id: `drover-${randomUUID()}` }, { timeoutMs: 30_000 });
    return { ok: true, via: 'hermes prompt.submit', admissionId: receipt?.admission_id ?? null, status: receipt?.status ?? null, ...(snap?.running ? { queuedBehindTurn: true } : {}) };
  });
}

/** Stop the turn a session is running (session.interrupt). */
export async function interrupt(s) {
  const gw = await gatewayOrThrow(s);
  return withGateway(gw, async (c) => {
    const gid = s.gatewayId ?? s.id;
    await c.call('session.resume', { session_id: gid, omit_messages: true }, { timeoutMs: 15_000 });
    return c.call('session.interrupt', { session_id: gid }, { timeoutMs: 15_000 });
  });
}

/**
 * A turn into a stored session with no gateway running: `hermes chat --resume <id> --oneshot`, the text on stdin
 * (never on the command line). Hermes starts a gateway for it, which exits on its own once idle. Waits a moment so
 * a refusal (an unknown id, no hermes) is the caller's error; the turn itself runs on.
 */
async function resumeOneShot(s, text, { model } = {}) {
  const argv = oneShotArgv({}, { resume: s.id, cwd: s.cwd ?? undefined, model });
  let stderr = '';
  const ended = new Promise((resolve) => {
    const child = _deps.spawn(hermesBin(), argv, { env: homeEnv(s.home), onLine: () => {}, onStderr: (d) => { stderr = (stderr + d).slice(-2000); }, onExit: (code) => resolve(code) });
    child.stdin.end(text);
  });
  const code = await Promise.race([ended, new Promise((r) => setTimeout(() => r(undefined), 2_500).unref?.())]);
  if (code !== undefined && code !== 0) return { ok: false, via: 'hermes chat --resume --oneshot', error: `hermes exited ${code}: ${stderr.trim().slice(-300)}` };
  return { ok: true, via: 'hermes chat --resume --oneshot', note: 'no Hermes gateway was running; this started one for the turn' };
}

/** HERMES_HOME for a session's home when it is not the default one, so a spawned hermes reads the right profile. */
function homeEnv(home) {
  const env = _deps.env();
  return home && !samePath(home, path.join(env.HOME ?? '', '.hermes')) ? { ...env, HERMES_HOME: home } : env;
}

// ---------------------------------------------------------------- launching

/** Effort for one Hermes session: `--reasoning <level>` (hermes chat --help). [] when not asked for. */
export function effortArgv(effort) {
  const e = checkEffort(ENGINE, effort);
  return e ? ['--reasoning', e] : [];
}

const bound = (flag, v, what) => {
  if (typeof v !== 'string' || !v) return [];
  if (v.includes('\u0000')) throw new Error(`${what} has a NUL character`);
  return [`${flag}=${v}`];
};

/**
 * Interactive hermes argv from a resolved profile: `hermes chat <profile argv> [--model=] [--reasoning] [--in=]`,
 * then `--resume <id>`, or `-c <title> --create-if-missing [--query=<prompt>]` for a new session Drover can find again
 * by its title (the TUI records no terminal breadcrumb). Values are bound with "=" so one that starts with "-" stays
 * a value. A resume takes no model or effort: Hermes refuses a resume that changes how the session was created.
 */
export function interactiveArgv(profile, { model, effort, cwd, prompt, resume, title } = {}) {
  const argv = [hermesBin(), 'chat', ...(profile?.argv ?? [])];
  if (resume) { if (!SESSION_ID.test(resume)) throw new Error('bad Hermes session id'); argv.push(...bound('--in', cwd, 'cwd'), `--resume=${resume}`); return argv; }
  argv.push(...bound('--model', model, 'model'), ...effortArgv(effort), ...bound('--in', cwd, 'cwd'));
  if (title) argv.push(...bound('--continue', title, 'title'), '--create-if-missing');
  argv.push(...bound('--query', prompt, 'prompt'));
  return argv;
}

// Interactive-only flags a one-shot cannot take (stream-json refuses --tui).
const INTERACTIVE_ONLY = new Set(['--tui', '--cli', '--native', '--tui-native', '--dev']);

/** One-shot argv (no binary): `chat --oneshot --query-file - --format stream-json`, the profile's non-interactive flags, then model, effort, cwd, resume. */
export function oneShotArgv(profile, { model, effort, cwd, resume } = {}) {
  if (resume && !SESSION_ID.test(resume)) throw new Error('bad Hermes session id');
  return ['chat', '--oneshot', '--query-file', '-', '--format', 'stream-json', ...(profile?.argv ?? []).filter((a) => !INTERACTIVE_ONLY.has(a)),
    ...(resume ? [] : [...bound('--model', model, 'model'), ...effortArgv(effort)]), ...bound('--in', cwd, 'cwd'), ...(resume ? [`--resume=${resume}`] : [])];
}

/** A unique session title for a launch: the window name and a short random tail (titles are unique in Hermes). */
export const launchTitle = (name) => `${name}-${randomUUID().slice(0, 6)}`;

/**
 * A headless Hermes session: each turn is one `hermes chat --oneshot --format stream-json` run (the first creates
 * the session, later ones resume it by the id it reported), its stream-json lines recorded as events typed
 * hermes/<type>. A message sent while a turn runs waits for it. onEvent(ev), onStatus(status).
 */
export class HeadlessHermes {
  constructor({ cwd, profile, model, effort, resume, env, onEvent, onStatus }) {
    this.cwd = cwd; this.profile = profile; this.model = model; this.effort = effort; this.env = env ?? {};
    this.onEvent = onEvent; this.onStatus = onStatus;
    if (resume && !SESSION_ID.test(resume)) throw new Error('bad Hermes session id');
    this.sessionId = resume ?? null; this.child = null; this.queue = []; this.stopped = false;
    this.argv = ['hermes', ...oneShotArgv(profile, { model, effort, cwd })];
  }
  send(text) {
    if (this.stopped) throw new Error('this headless Hermes session was stopped');
    if (this.child) { this.queue.push(text); return { ok: true, queued: true }; }
    this.#turn(text);
    return { ok: true };
  }
  #turn(text) {
    const argv = oneShotArgv(this.profile, { model: this.model, effort: this.effort, cwd: this.cwd, resume: this.sessionId ?? undefined });
    let sawResult = false, stderr = '';
    this.onStatus?.('busy');
    this.child = _deps.spawn(hermesBin(), argv, {
      cwd: this.cwd, env: { ..._deps.env(), ...this.env },
      onLine: (l) => {
        let d;
        try { d = JSON.parse(l); } catch { return; }
        if (!d || typeof d.type !== 'string') return;
        if (typeof d.session_id === 'string' && SESSION_ID.test(d.session_id)) this.sessionId = d.session_id;
        if (d.type === 'result') sawResult = true;
        this.onEvent?.({ ...d, type: `hermes/${d.type}` });
      },
      onStderr: (d) => {
        stderr = (stderr + d).slice(-4000);
        // "Session: <id>" comes on stderr before any output, so a session is known even when the turn fails.
        const m = String(d).match(/^Session: (\S+)$/m);
        if (m && SESSION_ID.test(m[1])) this.sessionId ??= m[1];
      },
      onExit: (code) => {
        this.child = null;
        if (code !== 0 || !sawResult) this.onEvent?.({ type: 'hermes/error', code, text: stderr.trim().split('\n').slice(-3).join('\n').slice(0, 600) });
        if (this.stopped) return;
        // 3: the turn needs a human (an approval or a question; gateway_chat_view.py _detach), which the gateway holds
        // for whoever attaches. It is answered through the gateway (sessions.answer, a message), not a new one-shot.
        if (code === 3) { const queued = this.queue; this.queue = []; this.onStatus?.('waiting'); this.#handOff(queued); return; }
        const next = this.queue.shift();
        if (next !== undefined) this.#turn(next);
        else this.onStatus?.('idle');
      },
    });
    this.child.stdin.end(text);
  }
  /** Messages sent while a turn ran that then left a prompt to the gateway: they go to the gateway, in order, behind it. */
  async #handOff(texts) {
    for (const text of texts) {
      try {
        const s = this.sessionId ? await findSession(this.sessionId) : null;
        if (!s) throw new Error('its conversation is not known yet');
        const r = await send(s, text, { turn: true });
        this.onEvent?.({ type: 'hermes/handoff', text: text.slice(0, 200), via: r.via ?? null, ok: r.ok !== false });
      } catch (e) { this.onEvent?.({ type: 'hermes/error', code: null, text: `a queued message could not be delivered: ${e.message}`.slice(0, 600) }); }
    }
  }
  stop() {
    this.stopped = true; this.queue = [];
    const c = this.child;
    if (c) { c.kill('SIGTERM'); setTimeout(() => { if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL'); }, 3_000).unref?.(); }
  }
}

/**
 * What Drover sees of Hermes on this host, for hermes.status: whether it keeps Hermes state, its named profiles, each
 * home's gateway (up, pid, whether it exits when idle) and the hermes executable on this process's PATH. Paths under
 * the home are shown with ~. Also the probe a front daemon makes before a Hermes launch goes to another host: code
 * that predates Hermes does not know the op.
 */
export async function status() {
  const root = rootHome(), home = _deps.env().HOME ?? '';
  const tilde = (p) => (p && home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p);
  const hs = homes();
  const gateways = [];
  for (const h of hs) {
    const gw = await gatewayFor(h.home, root).catch(() => null);
    let idleExit = null;
    if (gw) { try { const argv = (await control(gw.socket, 'status')).argv; idleExit = Array.isArray(argv) ? argv.includes('--idle-exit') : null; } catch { /* unknown */ } }
    gateways.push({ profile: h.profile, up: Boolean(gw), pid: gw?.pid ?? null, idleExit });
  }
  return { configured: hs.length > 0, home: tilde(root), profiles: hs.filter((h) => h.profile).map((h) => h.profile), gateways, bin: tilde(findBin()) };
}

/** A stream-json tool_use line (a headless turn) as a chat's tool call: { id, name, input, summary }. */
export function streamToolCall(e) {
  const name = typeof e?.name === 'string' ? e.name : 'tool';
  return { id: e?.tool_call_id ?? null, name, input: compact(e?.input ?? null), summary: toolSummary(TOOL_ALIAS[name] ?? name, e?.input) };
}
