// Every session's transcript in the views a reader needs, the same for every engine: Claude Code JSONL (interactive,
// --bg, -p, headless, subagents, the reflector and dream runs are all this), Codex rollouts (interactive and exec)
// and OpenClaw's SQLite transcript_events (the manager's chats, heartbeats and cron runs).
//
//   messages  what was said: typed user text, peer messages, assistant text, compaction summaries
//   calls     messages plus every tool call with its whole input (callStyle brief: one line per call); no outputs
//   full      calls plus every tool output, nothing cut
//   raw       the source records as they are: JSONL text, paged
//
// (turns, the compact view the web, iOS, Mac and Chrome clients poll, stays in claude.js and codex.js.)
//
// Entries are engine-agnostic: { role, ts, text?, from?, model?, id?, name?, input?, isError? } with role one of
// user, assistant, summary (a compaction summary), tool (a call) and result (a call's output). Measured on a 6.3 MB
// Claude transcript (2026-11-03): messages 30 KB, calls 356 KB, full 807 KB.
import { open, readdir, stat, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { userText, CODEX_INJECTED } from './search/extract.js';
import { toolSummary, resultText, codexOutputFailed } from './toolcalls.js';
import { redactSecrets } from './redact.js';

export const FORMATS = ['turns', 'messages', 'calls', 'full', 'raw'];
export const EXPORT_FORMATS = FORMATS.filter((f) => f !== 'turns');
export const CALL_STYLES = ['input', 'brief'];
/** One page holds at most this much (JSON of the entries, or raw bytes) unless the caller asks for another size. */
export const PAGE_BYTES = 1024 * 1024;
const KEEP = {
  messages: new Set(['user', 'assistant', 'summary']),
  calls: new Set(['user', 'assistant', 'summary', 'tool']),
  full: new Set(['user', 'assistant', 'summary', 'tool', 'result']),
};

export function checkFormat(format) {
  if (!FORMATS.includes(format)) throw new Error(`format must be one of ${FORMATS.join(', ')}`);
  return format;
}

const textBlocks = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n') : '');

// ---------------------------------------------------------------- parsers: one source record -> entries

/**
 * One Claude Code transcript record -> entries. Meta turns (skills, caveats), wrappers and thinking give none. A
 * subagent's own file marks every record isSidechain; in a session's file such records are a subagent run inline (as
 * Claude Code wrote them before subagents got files) and are left out unless sidechain is set.
 */
export function claudeEntries(d, { sidechain = false } = {}) {
  if (!d || typeof d !== 'object' || (d.isSidechain && !sidechain)) return [];
  const ts = d.timestamp ?? null;
  if (d.type === 'summary' && typeof d.summary === 'string') return d.summary.trim() ? [{ role: 'summary', ts, text: d.summary.trim() }] : [];
  const c = d.message?.content;
  if (d.type === 'user') {
    const o = d.origin;
    // A message from another session (or relayed by Drover): its body, and who sent it.
    if (o?.kind === 'peer' && typeof o.body === 'string') return o.body.trim() ? [{ role: 'user', ts, text: o.body.trim(), from: typeof o.name === 'string' ? o.name : 'peer' }] : [];
    if (d.isCompactSummary) { const t = textBlocks(c).trim(); return t ? [{ role: 'summary', ts, text: t }] : []; }
    if (d.isMeta) return [];
    const blocks = typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : [];
    const out = [], said = [];
    for (const b of blocks) {
      if (b?.type === 'text') { const t = userText(b.text); if (t) said.push(t); }
      else if (b?.type === 'image') said.push('[image]');
      else if (b?.type === 'tool_result') out.push({ role: 'result', ts, id: b.tool_use_id ?? null, isError: Boolean(b.is_error), text: resultText(b.content) });
    }
    if (said.some((t) => t !== '[image]')) out.unshift({ role: 'user', ts, text: said.join('\n') });
    return out;
  }
  if (d.type === 'assistant' && Array.isArray(c)) {
    const model = d.message?.model ?? null;
    const out = [];
    const t = textBlocks(c).trim();
    if (t) out.push({ role: 'assistant', ts, text: t, ...(model ? { model } : {}) });
    for (const b of c) if (b?.type === 'tool_use') out.push({ role: 'tool', ts, id: b.id ?? null, name: b.name ?? 'tool', input: b.input ?? null });
    return out;
  }
  return [];
}

const CODEX_CALLS = new Set(['function_call', 'custom_tool_call', 'local_shell_call', 'web_search_call']);
const CODEX_OUTPUTS = new Set(['function_call_output', 'custom_tool_call_output', 'local_shell_call_output']);

/** One Codex rollout record -> entries. Only response_item lines count (event_msg lines repeat them); injected context is dropped. */
export function codexEntries(d) {
  if (d?.type !== 'response_item') return [];
  const p = d.payload ?? {}, ts = d.timestamp ?? null;
  if (p.type === 'message') {
    const txt = (p.content ?? []).map((b) => b?.text ?? '').join('');
    if (p.role === 'user') {
      const head = txt.trimStart();
      if (CODEX_INJECTED.some((x) => head.startsWith(x)) || head.startsWith('<environment_context>')) return [];
      const t = userText(txt);
      return t ? [{ role: 'user', ts, text: t }] : [];
    }
    if (p.role === 'assistant') { const t = txt.trim(); return t ? [{ role: 'assistant', ts, text: t }] : []; }
    return [];   // developer and system messages: instructions, not conversation
  }
  if (p.type === 'agent_message') { const t = ((p.content ?? []).map((b) => b?.text ?? '').join('') || p.text || '').trim(); return t ? [{ role: 'assistant', ts, text: t }] : []; }
  if (CODEX_CALLS.has(p.type)) {
    let input = p.input ?? p.action ?? p.arguments ?? null;
    if (p.type === 'function_call' && typeof p.arguments === 'string') { try { input = JSON.parse(p.arguments); } catch { input = p.arguments; } }
    const name = p.type === 'local_shell_call' ? 'local_shell' : p.type === 'web_search_call' ? 'web_search' : p.name ?? 'tool';
    return [{ role: 'tool', ts, id: p.call_id ?? p.id ?? null, name, input }];
  }
  if (CODEX_OUTPUTS.has(p.type)) {
    const o = p.output;
    const text = resultText(typeof o === 'object' && o !== null && !Array.isArray(o) ? o.content ?? o.output ?? '' : o);
    return [{ role: 'result', ts, id: p.call_id ?? null, isError: codexOutputFailed(text) || p.status === 'failed', text }];
  }
  return [];
}

/** One OpenClaw transcript event -> entries. Its MCP calls go through a tool_call wrapper: the wrapped tool is the call. */
export function openclawEntries(d) {
  if (d?.type !== 'message') return [];
  const m = d.message ?? {}, ts = d.timestamp ?? null;
  if (m.role === 'user') {
    const t = (typeof m.content === 'string' ? m.content : resultText(m.content)).trim();
    const from = m.provenance?.kind === 'internal_system' ? m.provenance.sourceTool ?? 'system' : null;
    return t ? [{ role: 'user', ts, text: t, ...(from ? { from } : {}) }] : [];
  }
  if (m.role === 'assistant' && Array.isArray(m.content)) {
    const out = [];
    const t = textBlocks(m.content).trim();
    if (t) out.push({ role: 'assistant', ts, text: t, ...(m.model ? { model: m.model } : {}) });
    for (const b of m.content) {
      if (b?.type !== 'toolCall') continue;
      const a = b.arguments;
      const wrapped = b.name === 'tool_call' && a && typeof a === 'object' && typeof a.id === 'string';
      out.push({ role: 'tool', ts, id: b.id ?? null, name: wrapped ? a.id : b.name ?? 'tool', input: wrapped ? a.args ?? null : a ?? null });
    }
    return out;
  }
  if (m.role === 'toolResult') return [{ role: 'result', ts, id: m.toolCallId ?? null, isError: Boolean(m.isError), text: resultText(m.content) }];
  return [];   // custom (cache, nested-tool bookkeeping, model snapshots)
}

export const PARSERS = { claude: claudeEntries, codex: codexEntries, openclaw: openclawEntries };

/**
 * One line for a call: toolSummary's (the command, the path, the pattern), else its arguments as compact JSON. Ids
 * stay readable there (hexSafe): toolSummary's own redaction turns a call whose one argument is a session id into
 * "[redacted]". At most 200 characters, secrets redacted either way.
 */
export function briefLine(name, input) {
  const s = toolSummary(name, input);
  if (s && !s.includes('[redacted]')) return s;
  if (input == null || (typeof input === 'object' && !Object.keys(input).length)) return s;
  const j = redactSecrets(typeof input === 'string' ? input : JSON.stringify(input), { hexSafe: true }).replace(/\s+/g, ' ').trim();
  return j.length > 200 ? `${j.slice(0, 199)}…` : j;
}

/** The entries a format keeps; callStyle brief turns each call's input into one line (toolSummary: redacted, at most 200 chars). */
export function project(entries, format, { callStyle = 'input' } = {}) {
  const keep = KEEP[format];
  if (!keep) throw new Error(`no entries for format ${format}`);
  const out = [];
  for (const e of entries) {
    if (!keep.has(e.role)) continue;
    if (e.role === 'tool' && callStyle === 'brief') { const { input, ...rest } = e; out.push({ ...rest, summary: briefLine(e.name, input) }); }
    else out.push(e);
  }
  return out;
}

// ---------------------------------------------------------------- readers

/** Whole lines of a JSONL file from byte `start`, with the byte offset after each. A last line still being written is held back. */
export async function* jsonlLines(file, start = 0) {
  const fh = await open(file, 'r');
  try {
    const CHUNK = 1 << 20;
    let pos = start, carry = Buffer.alloc(0), lineStart = start;
    for (;;) {
      const buf = Buffer.allocUnsafe(CHUNK);
      const { bytesRead } = await fh.read(buf, 0, CHUNK, pos);
      if (!bytesRead) break;
      pos += bytesRead;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      let from = 0, i;
      while ((i = data.indexOf(10, from)) >= 0) {
        const end = lineStart + (i - from) + 1;
        yield { line: data.subarray(from, i).toString('utf8'), end };
        lineStart = end; from = i + 1;
      }
      carry = Buffer.from(data.subarray(from));
    }
    // No newline after the last record: yield it only when it is whole JSON (a finished file), else it is mid-write.
    if (carry.length) { const line = carry.toString('utf8'); try { JSON.parse(line); yield { line, end: lineStart + carry.length }; } catch { /* mid-write */ } }
  } finally { await fh.close(); }
}

const startAt = (since, size) => { const s = Math.max(0, Number(since) || 0); return s > size ? 0 : s; };

/**
 * A JSONL transcript as entries of one format, from byte offset `since` (default the start: the whole transcript).
 * A page ends after `limit` entries or `maxBytes` of entry JSON (always at least one record's entries); offset is
 * where the next page starts and more says whether there is one.
 */
export async function readEntries(file, engine, { format, since = 0, limit = Infinity, maxBytes = PAGE_BYTES, callStyle, sidechain = false } = {}) {
  const parse = PARSERS[engine];
  if (!parse) throw new Error(`no parser for engine ${engine}`);
  const { size } = await stat(file);
  const start = startAt(since, size);
  const entries = [];
  let offset = start, used = 0, more = false;
  for await (const { line, end } of jsonlLines(file, start)) {
    let d; try { d = JSON.parse(line); } catch { offset = end; continue; }
    const got = project(parse(d, { sidechain }), format, { callStyle });
    const cost = got.reduce((n, e) => n + JSON.stringify(e).length, 0);
    if (entries.length && (entries.length + got.length > limit || used + cost > maxBytes)) { more = true; break; }
    entries.push(...got); used += cost; offset = end;
  }
  return { entries, offset, more, bytes: size };
}

/** A JSONL file's records as they are, from byte offset `since`: whole lines, at most maxBytes (always at least one line). */
export async function readRaw(file, { since = 0, maxBytes = PAGE_BYTES } = {}) {
  const { size } = await stat(file);
  const start = startAt(since, size);
  const lines = [];
  let offset = start, used = 0, more = false;
  for await (const { line, end } of jsonlLines(file, start)) {
    const cost = Buffer.byteLength(line) + 1;
    if (lines.length && used + cost > maxBytes) { more = true; break; }
    lines.push(line); used += cost; offset = end;
  }
  return { jsonl: lines.length ? lines.join('\n') + '\n' : '', records: lines.length, offset, more, bytes: size };
}

/** Which engine wrote a JSONL transcript: a Codex rollout starts with session_meta, anything else is read as Claude Code. */
export async function sniffEngine(file) {
  for await (const { line } of jsonlLines(file, 0)) {
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (d.type === 'session_meta' || (d.type === 'response_item' && d.payload)) return 'codex';
    if (d.type === 'user' || d.type === 'assistant' || d.sessionId) return 'claude';
  }
  return 'claude';
}

// ---------------------------------------------------------------- OpenClaw (SQLite)

/** OpenClaw agent stores under a state dir: [{ agent, file }]. */
export async function openclawStores(stateDir) {
  const root = path.join(stateDir, 'agents');
  const out = [];
  for (const agent of await readdir(root).catch(() => [])) {
    const file = path.join(root, agent, 'agent', 'openclaw-agent.sqlite');
    if (existsSync(file)) out.push({ agent, file });
  }
  return out;
}

async function openStore(file) {
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(file, { readOnly: true });
}

function eventJson(row) {
  if (row.event_json != null) return row.event_json;
  if (typeof zlib.zstdDecompressSync !== 'function') throw new Error('this Node has no zstd: OpenClaw stores events compressed (Node 22.15+ or 23.8+)');
  return zlib.zstdDecompressSync(row.event_zstd).toString('utf8');
}

/** Every OpenClaw session window in one store, newest first, with what it was (created_via: cron, heartbeat, talk...). */
export async function openclawWindows(file, { agent = null } = {}) {
  const db = await openStore(file);
  try {
    return db.prepare(`select w.session_id, w.session_key, w.reason, w.created_at, w.started_at, w.ended_at, w.status, w.model, w.display_name,
        n.created_via, n.category, n.label, (select count(*) from transcript_events e where e.session_id = w.session_id) as events
      from session_windows w left join session_nodes n on n.session_key = w.session_key order by w.created_at desc`).all()
      .map((r) => ({ engine: 'openclaw', kind: openclawKind(r), id: `openclaw:${r.session_id}`, sessionId: r.session_id, key: r.session_key, agent,
        store: file, status: r.status ?? null, model: r.model ?? null, label: r.display_name ?? r.label ?? null, events: r.events,
        startedAt: iso(r.started_at ?? r.created_at), endedAt: iso(r.ended_at), mtime: iso(r.ended_at ?? r.started_at ?? r.created_at) }));
  } finally { db.close(); }
}
/** heartbeat and cron runs by their key (agent:<agent>:<scope>:heartbeat, agent:<agent>:cron:<job>), chats to the manager as manager. */
function openclawKind(r) {
  const k = String(r.session_key ?? '');
  if (k.endsWith(':heartbeat')) return 'heartbeat';
  if (/:cron(:|$)/.test(k) || r.created_via === 'cron') return 'cron';
  if (/:openai-user:drover:/.test(k)) return 'manager';
  return r.created_via ?? 'session';
}
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

/**
 * The session windows a key, a key prefix or one session id names, oldest first: one OpenClaw conversation is a
 * chain of windows (a reset, a rollover or a compaction starts the next one).
 */
export async function openclawSessionIds(file, { sessionId, key, keyPrefix } = {}) {
  const db = await openStore(file);
  try {
    if (sessionId) return db.prepare('select session_id from session_windows where session_id = ?').all(sessionId).map((r) => r.session_id);
    if (key) return db.prepare('select session_id from session_windows where session_key = ? order by created_at').all(key).map((r) => r.session_id);
    if (keyPrefix) return db.prepare('select session_id from session_windows where session_key = ? or session_key like ? escape \'\\\' order by created_at')
      .all(keyPrefix, keyPrefix.replace(/[\\%_]/g, '\\$&') + ':%').map((r) => r.session_id);
    return [];
  } finally { db.close(); }
}

/**
 * OpenClaw events of some session windows in order, as entries (format messages/calls/full) or raw JSONL (raw).
 * since counts the events already read across the windows, so a page continues where the last one stopped.
 */
export async function readOpenclaw(file, sessionIds, { format, since = 0, limit = Infinity, maxBytes = PAGE_BYTES, callStyle } = {}) {
  const db = await openStore(file);
  try {
    const count = db.prepare('select count(*) as n from transcript_events where session_id = ?');
    const rows = db.prepare('select event_json, event_zstd from transcript_events where session_id = ? order by seq limit -1 offset ?');
    let skip = Math.max(0, Number(since) || 0), offset = skip, used = 0, more = false, total = 0;
    const entries = [], lines = [];
    for (const sid of sessionIds) total += count.get(sid).n;
    outer: for (const sid of sessionIds) {
      const n = count.get(sid).n;
      if (skip >= n) { skip -= n; continue; }
      for (const r of rows.iterate(sid, skip)) {
        const j = eventJson(r);
        if (format === 'raw') {
          const cost = Buffer.byteLength(j) + 1;
          if (lines.length && used + cost > maxBytes) { more = true; break outer; }
          lines.push(j); used += cost;
        } else {
          let d; try { d = JSON.parse(j); } catch { offset++; continue; }
          const got = project(openclawEntries(d), format, { callStyle });
          const cost = got.reduce((s, e) => s + JSON.stringify(e).length, 0);
          if (entries.length && (entries.length + got.length > limit || used + cost > maxBytes)) { more = true; break outer; }
          entries.push(...got); used += cost;
        }
        offset++;
      }
      skip = 0;
    }
    return format === 'raw' ? { jsonl: lines.length ? lines.join('\n') + '\n' : '', records: lines.length, offset, more, events: total }
      : { entries, offset, more, events: total };
  } finally { db.close(); }
}

// ---------------------------------------------------------------- Claude subagents

/** A subagent id as its file names it: agent-<id>.jsonl. Accepts "a0179…", "agent-a0179…" or "<parent session>/<agent id>". */
export function subagentRef(id) {
  const m = String(id ?? '').match(/^(?:([0-9a-f-]{36})\/)?(?:agent-)?([0-9a-f]{8,40})$/i);
  return m ? { parent: m[1] ?? null, agentId: m[2] } : null;
}

/** The transcript of a subagent: its file, parent session and the meta Claude Code keeps beside it (type, task, model). */
export async function findSubagent(projectsDir, id) {
  const ref = subagentRef(id);
  if (!ref) return null;
  const name = `agent-${ref.agentId}.jsonl`;
  for (const slug of await readdir(projectsDir).catch(() => [])) {
    const dir = path.join(projectsDir, slug);
    const parents = ref.parent ? [ref.parent] : (await readdir(dir, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory()).map((e) => e.name);
    for (const parent of parents) {
      const file = path.join(dir, parent, 'subagents', name);
      if (existsSync(file)) return { engine: 'claude', kind: 'subagent', id: ref.agentId, parent, path: file, meta: await subagentMeta(file) };
    }
  }
  return null;
}

async function subagentMeta(file) {
  try {
    const m = JSON.parse(await readFile(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
    return { agentType: m.agentType ?? null, description: m.description ?? null, model: m.pickedEffortModel ?? m.model ?? null, finished: m.finished ?? null };
  } catch { return null; }
}

/** The subagents of every session folder under one project dir changed within `days`: [{ kind: 'subagent', id, parent, path, ... }]. */
export async function listSubagents(projectsDir, { days = 4, parent = null } = {}) {
  const cutoff = Date.now() - days * 86400_000;
  const out = [];
  for (const slug of await readdir(projectsDir).catch(() => [])) {
    const dir = path.join(projectsDir, slug);
    const parents = parent ? [parent] : (await readdir(dir, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory()).map((e) => e.name);
    for (const p of parents) {
      const sub = path.join(dir, p, 'subagents');
      for (const n of await readdir(sub).catch(() => [])) {
        if (!n.endsWith('.jsonl')) continue;
        const f = path.join(sub, n);
        let s; try { s = await stat(f); } catch { continue; }
        if (!parent && s.mtimeMs < cutoff) continue;
        out.push({ engine: 'claude', kind: 'subagent', id: n.slice(6, -6), parent: p, path: f, mtime: s.mtime.toISOString(), bytes: s.size, ...(await subagentMeta(f) ?? {}) });
      }
    }
  }
  return out.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
}

// ---------------------------------------------------------------- what a transcript is, cheaply

// One-shot helper runs, by what their prompt starts with or where they run: the session reflector (a temp dir per run),
// the fleet summarizer, the dotsync agent. (search/indexer.js DERIVED_PROMPTS skips the same runs from the index.)
const RUN_PROMPTS = [['You keep the durable record of one AI coding session', 'reflection'], ['You are writing the durable reflection of one AI', 'reflection'], ['You are summarizing the state of coding-agent sessions', 'summary-run']];
const RUN_DIRS = [[/\/reflector-[^/]+$/, 'reflection'], [/\/dotsync-agent$/, 'dotsync']];

/**
 * What a Claude transcript is, from its first records (at most `bytes`): cwd, entrypoint (cli, sdk-cli...), the first
 * prompt and its kind: session (interactive), headless (-p and SDK runs), or the helper run it is (RUN_PROMPTS, RUN_DIRS).
 */
export async function claudeHead(file, { bytes = 4 * 1024 * 1024 } = {}) {
  let cwd = null, entrypoint = null, firstPrompt = null;
  for await (const { line, end } of jsonlLines(file, 0)) {
    let d; try { d = JSON.parse(line); } catch { d = null; }
    if (d) {
      cwd ??= d.cwd ?? null; entrypoint ??= d.entrypoint ?? null;
      if (!firstPrompt) { const u = claudeEntries(d, { sidechain: true }).find((e) => e.role === 'user'); if (u) firstPrompt = u.text.slice(0, 300); }
    }
    if ((cwd && entrypoint && firstPrompt) || end >= bytes) break;
  }
  const run = RUN_PROMPTS.find(([p]) => firstPrompt?.startsWith(p))?.[1] ?? RUN_DIRS.find(([re]) => cwd && re.test(cwd))?.[1];
  const kind = run ?? (entrypoint && entrypoint !== 'cli' ? 'headless' : 'session');
  return { cwd, entrypoint, kind, firstPrompt };
}

/** From a Codex rollout's session_meta: cwd and originator (codex_exec for `codex exec`, else interactive). */
export async function codexHead(file) {
  for await (const { line } of jsonlLines(file, 0)) {
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (d.type !== 'session_meta') continue;
    const p = d.payload ?? {};
    return { cwd: p.cwd ?? null, originator: p.originator ?? null, kind: /exec/i.test(String(p.originator ?? '')) ? 'exec' : 'session' };
  }
  return { cwd: null, originator: null, kind: 'session' };
}

// ---------------------------------------------------------------- text

const fence = (t) => { let n = 3; for (const m of String(t).matchAll(/`{3,}/g)) n = Math.max(n, m[0].length + 1); return '`'.repeat(n); };
const when = (ts) => (typeof ts === 'string' ? ts.replace(/\.\d+Z$/, 'Z').replace('T', ' ') : '');

/** Entries as Markdown a person (or a model) reads: a heading per message, calls under the reply that made them. */
export function renderText(entries) {
  const out = [];
  for (const e of entries) {
    if (e.role === 'user' || e.role === 'assistant' || e.role === 'summary') {
      const who = e.role === 'summary' ? 'summary (compaction)' : e.role;
      const tail = [when(e.ts), e.from ? `from ${e.from}` : null, e.model && e.role === 'assistant' ? e.model : null].filter(Boolean).join(' · ');
      out.push(`## ${who}${tail ? ` · ${tail}` : ''}\n\n${e.text}\n`);
    } else if (e.role === 'tool') {
      if ('summary' in e) out.push(`→ ${e.name}${e.summary ? `: ${e.summary}` : ''}\n`);
      else {
        const body = typeof e.input === 'string' ? e.input : JSON.stringify(e.input ?? null, null, 2);
        const f = fence(body);
        out.push(`→ ${e.name}\n${f}${typeof e.input === 'string' ? '' : 'json'}\n${body}\n${f}\n`);
      }
    } else if (e.role === 'result') {
      const f = fence(e.text);
      out.push(`← result${e.isError ? ' (error)' : ''}\n${f}\n${e.text}\n${f}\n`);
    }
  }
  return out.join('\n');
}
