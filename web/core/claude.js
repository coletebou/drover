// Claude Code adapter: live session registry, direct messaging over the UDS
// inbox, transcript reading, and spawning (tmux or headless).
//
// Protocol (verified against claude 2.1.296): each interactive session writes
// ~/.claude/sessions/<pid>.json and <pid>.<sha256(socketPath)>.key, and listens
// on messagingSocketPath for newline-delimited JSON:
//   {"type":"auth","token":<peerToken>}
//   {"type":"user","message":{"role":"user","content":"..."}}
import { readdir, readFile, stat, open } from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { connect } from 'node:net';
import path from 'node:path';
import { pidAlive, run, startLines } from './proc.js';
import { uuidv7 } from './ids.js';
import { checkEffort } from './effort.js';
import { toolSummary, toolDescription, resultEntry } from './toolcalls.js';

export const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR ?? path.join(process.env.HOME, '.claude');
const SESSIONS_DIR = path.join(CLAUDE_HOME, 'sessions');
const PROJECTS_DIR = path.join(CLAUDE_HOME, 'projects');

export function projectSlug(cwd) {
  return cwd.replace(/[\\/:]/g, '-');
}

export function transcriptPath(cwd, sessionId) {
  return path.join(PROJECTS_DIR, projectSlug(cwd), `${sessionId}.jsonl`);
}

/** Live registry entries (pid files whose process is alive). */
export async function listRegistry() {
  if (!existsSync(SESSIONS_DIR)) return [];
  const names = await readdir(SESSIONS_DIR);
  const out = [];
  for (const n of names) {
    if (!/^\d+\.json$/.test(n)) continue;
    let d;
    try { d = JSON.parse(await readFile(path.join(SESSIONS_DIR, n), 'utf8')); } catch { continue; }
    if (!d?.pid || !d.sessionId) continue;
    const alive = pidAlive(d.pid);
    out.push({
      kind: 'claude', pid: d.pid, sessionId: d.sessionId, cwd: d.cwd, name: d.name, nameSource: d.nameSource,
      status: alive ? (d.status ?? 'unknown') : 'dead', alive, tmux: d.tmux ?? null, entrypoint: d.entrypoint,
      sessionKind: d.kind, version: d.version, peerProtocol: d.peerProtocol, startedAt: d.startedAt,
      updatedAt: d.updatedAt, statusUpdatedAt: d.statusUpdatedAt, socket: d.messagingSocketPath ?? null,
      transcript: d.cwd ? transcriptPath(d.cwd, d.sessionId) : null,
    });
  }
  return out.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

/** `claude agents --json` also lists background (headless) sessions; merge for completeness. */
export async function listAgentsCli() {
  try {
    const { stdout } = await run('claude', ['agents', '--json', '--all'], { timeoutMs: 15_000 });
    const arr = JSON.parse(stdout);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

export async function listSessions() {
  const [reg, cli] = await Promise.all([listRegistry(), listAgentsCli()]);
  const byId = new Map(reg.map((r) => [r.sessionId, r]));
  for (const a of cli) {
    if (!a.sessionId || byId.has(a.sessionId)) continue;
    byId.set(a.sessionId, {
      kind: 'claude', pid: a.pid ?? null, sessionId: a.sessionId, cwd: a.cwd, name: a.name, status: a.state ?? a.status ?? 'unknown',
      alive: a.pid ? pidAlive(a.pid) : a.state !== 'completed', tmux: null, sessionKind: a.kind, startedAt: a.startedAt,
      socket: null, transcript: a.cwd ? transcriptPath(a.cwd, a.sessionId) : null, fromCli: true,
    });
  }
  return [...byId.values()];
}

export async function findSession(idOrName) {
  const all = await listSessions();
  return all.find((s) => s.sessionId === idOrName || s.name === idOrName || s.sessionId.startsWith(idOrName)) ?? null;
}

async function readPeerToken(pid, socketPath) {
  const sha = createHash('sha256').update(path.resolve(socketPath)).digest('hex');
  const f = path.join(SESSIONS_DIR, `${pid}.${sha}.key`);
  try { return JSON.parse(await readFile(f, 'utf8')).peerToken ?? null; } catch { /* fall through */ }
  // Fallback: any key file for this pid (socket path canonicalization differences).
  const names = await readdir(SESSIONS_DIR).catch(() => []);
  for (const n of names) {
    if (n.startsWith(`${pid}.`) && n.endsWith('.key')) {
      try { return JSON.parse(await readFile(path.join(SESSIONS_DIR, n), 'utf8')).peerToken ?? null; } catch { /* next */ }
    }
  }
  return null;
}

/**
 * Latest permission mode recorded in a session's transcript (`permission-mode`
 * entries, or `permissionMode` on user lines). Reads only the tail.
 */
export async function latestPermissionMode(transcript, { tailBytes = 512 * 1024 } = {}) {
  if (!transcript) return null;
  let fh;
  try {
    fh = await open(transcript, 'r');
    const { size } = await fh.stat();
    const start = Math.max(0, size - tailBytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const all = [...buf.toString('utf8').matchAll(/"permissionMode":"([A-Za-z]+)"/g)];
    return all.length ? all.at(-1)[1] : null;
  } catch { return null; } finally { await fh?.close(); }
}

/**
 * Peer envelope, byte-compatible with Claude Code 2.1.296's own sender
 * (`<cross-session-message from-name=".." from-mode="..">\n<body>\n</cross-session-message>`).
 * A session that bypasses permission prompts holds any peer message that does
 * not declare its sender's mode class ("no-mode-asserted"), so a bare frame
 * shows the "Held message from an unidentified session" dialog. Drover relays
 * the human's own typing, so it declares the target's class: "bypass" for a
 * bypassPermissions target, nothing for a prompting one (prompting sessions
 * accept undeclared senders). The receiver re-renders the envelope and drops
 * the attributes unless the round trip is exact, so the body's closing-tag
 * text is escaped the way the receiver escapes it ("<\").
 */
export const PEER_TAG = 'cross-session-message';
export function peerEnvelope(body, { fromName = 'drover', fromMode } = {}) {
  const attrs = [];
  const name = String(fromName ?? '').replace(/["<>\n\r]/g, '').trim().slice(0, 120);
  if (name) attrs.push(`from-name="${name}"`);
  if (fromMode === 'bypass' || fromMode === 'prompting') attrs.push(`from-mode="${fromMode}"`);
  const safe = String(body).replace(new RegExp(`<(?!\\\\)(?=/${PEER_TAG}(?:[^A-Za-z0-9_-]|$))`, 'giu'), '<\\');
  return `<${PEER_TAG}${attrs.length ? ' ' + attrs.join(' ') : ''}>\n${safe}\n</${PEER_TAG}>`;
}
/** Claude's class rule: bypassPermissions, or plan mode with bypass available. */
export function modeClass(permissionMode, { bypassAvailable = false } = {}) {
  if (!permissionMode) return undefined;
  if (permissionMode === 'bypassPermissions') return 'bypass';
  if (permissionMode === 'plan' && bypassAvailable) return 'bypass';
  return 'prompting';
}

/** Mode flags from a claude argv: launch mode and whether bypass is available. */
export function modeFromArgv(args) {
  const a = String(args ?? '').split(/\s+/);
  const skip = a.includes('--dangerously-skip-permissions');
  const allow = skip || a.includes('--allow-dangerously-skip-permissions');
  const i = a.findIndex((x) => x === '--permission-mode' || x.startsWith('--permission-mode='));
  const pm = i < 0 ? null : a[i].includes('=') ? a[i].split('=')[1] : a[i + 1] ?? null;
  return { mode: skip ? 'bypassPermissions' : pm, bypassAvailable: allow || pm === 'bypassPermissions' };
}

async function defaultModeFromSettings() {
  try { return JSON.parse(await readFile(path.join(CLAUDE_HOME, 'settings.json'), 'utf8'))?.permissions?.defaultMode ?? null; } catch { return null; }
}

/**
 * Best evidence of a live session's permission class: the transcript's latest
 * mode (tracks shift+tab changes), else its launch flags, else settings default.
 */
export async function sessionModeClass(session) {
  let argv = { mode: null, bypassAvailable: false };
  if (session?.pid) { try { argv = modeFromArgv((await run('ps', ['-o', 'args=', '-p', String(session.pid)], { timeoutMs: 3000 })).stdout); } catch { /* gone */ } }
  const mode = (await latestPermissionMode(session?.transcript)) ?? argv.mode ?? (await defaultModeFromSettings());
  return { mode, cls: modeClass(mode, { bypassAvailable: argv.bypassAvailable }) };
}

/**
 * Deliver a user message into a live interactive session through its inbox.
 * Resolves after the frames are flushed and the socket closes cleanly.
 */
export async function sendToSession(session, text, { timeoutMs = 5000, fromName = 'drover' } = {}) {
  if (!session?.socket) throw new Error('session has no messaging socket (headless or old version)');
  if (!session.alive) throw new Error('session process is not alive');
  if (typeof text !== 'string' || !text.trim()) throw new Error('empty message');
  const token = await readPeerToken(session.pid, session.socket);
  const { mode: targetMode, cls } = await sessionModeClass(session);
  // Only declare "bypass"; a prompting target accepts an undeclared sender.
  const content = peerEnvelope(text, { fromName, fromMode: cls === 'bypass' ? 'bypass' : undefined });
  const frames = [];
  if (token) frames.push(JSON.stringify({ type: 'auth', token }));
  frames.push(JSON.stringify({ type: 'user', message: { role: 'user', content } }));
  const payload = frames.join('\n') + '\n';
  await new Promise((resolve, reject) => {
    const sock = connect(session.socket);
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('inbox write timed out')); }, timeoutMs);
    let replied = '';
    sock.on('connect', () => sock.end(payload));
    sock.on('data', (d) => { replied += d; });
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
    sock.on('close', () => { clearTimeout(timer); resolve(replied); });
  });
  return { ok: true, authed: Boolean(token), targetMode, declaredMode: cls === 'bypass' ? 'bypass' : null, queuedBehindTurn: session.status === 'busy' };
}

/**
 * A message another session (or Drover, relaying the owner) put in the inbox: Claude Code records it as a meta user
 * turn whose origin names the sender and carries the body. Shown as what was said, not as a harness turn.
 */
function peerTurn(d) {
  const o = d.origin;
  if (o?.kind !== 'peer' || typeof o.body !== 'string') return null;
  const from = typeof o.name === 'string' ? o.name : null;
  // "drover (<actor>)" (and "apx-web (<actor>)" before the rename): someone typing through Drover, the owner as OWNER.
  const relay = from?.match(/^(?:drover|apx-web)\s*\(([^)]+)\)$/i);
  return { role: 'user', ts: d.timestamp, uuid: d.uuid, text: o.body, meta: false, via: relay ? 'drover' : 'peer', from: relay ? null : from, actor: relay ? relay[1] : null };
}

/** Parse transcript JSONL lines into a compact chat-ish list. */
export function parseTranscriptLine(line) {
  let d; try { d = JSON.parse(line); } catch { return null; }
  const t = d.type;
  if (t === 'user') {
    const peer = peerTurn(d);
    if (peer) return peer;
    const c = d.message?.content;
    if (typeof c === 'string') return { role: 'user', ts: d.timestamp, uuid: d.uuid, text: c, meta: Boolean(d.isMeta) };
    if (Array.isArray(c)) {
      const texts = c.filter((b) => b.type === 'text').map((b) => b.text);
      const results = c.filter((b) => b.type === 'tool_result');
      const images = c.filter((b) => b.type === 'image').length;
      if (texts.length) return { role: 'user', ts: d.timestamp, uuid: d.uuid, text: texts.join('\n'), meta: Boolean(d.isMeta), ...(images ? { images } : {}) };
      if (results.length) return { role: 'tool_result', ts: d.timestamp, uuid: d.uuid, count: results.length, text: summarizeToolResults(results), results: results.map((r) => resultEntry(r.tool_use_id, r.content, { isError: r.is_error })) };
      if (images) return { role: 'user', ts: d.timestamp, uuid: d.uuid, text: '', meta: Boolean(d.isMeta), images };
    }
    return null;
  }
  if (t === 'assistant') {
    const c = d.message?.content ?? [];
    const texts = c.filter((b) => b.type === 'text').map((b) => b.text);
    const tools = c.filter((b) => b.type === 'tool_use').map((b) => {
      const description = toolDescription(b.name, b.input);
      return { id: b.id ?? null, name: b.name, input: compactInput(b.input), summary: toolSummary(b.name, b.input), ...(description ? { description } : {}) };
    });
    const thinking = c.some((b) => b.type === 'thinking');
    if (!texts.length && !tools.length) return thinking ? { role: 'thinking', ts: d.timestamp, uuid: d.uuid } : null;
    return { role: 'assistant', ts: d.timestamp, uuid: d.uuid, text: texts.join('\n'), tools, model: d.message?.model ?? d.requestedModel };
  }
  if (t === 'ai-title') return { role: 'title', ts: d.timestamp, text: d.title ?? d.content ?? '' };
  if (t === 'queue-operation') return { role: 'queue', ts: d.timestamp, text: `${d.operation}: ${String(d.content ?? '').slice(0, 200)}` };
  return null;
}

function compactInput(input) {
  if (!input || typeof input !== 'object') return input;
  const s = JSON.stringify(input);
  return s.length > 300 ? s.slice(0, 300) + '…' : input;
}
function summarizeToolResults(results) {
  return results.map((r) => {
    const c = r.content;
    const txt = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '';
    return (r.is_error ? '[error] ' : '') + txt.slice(0, 400);
  }).join('\n---\n');
}

/**
 * Read the transcript tail. `since` is a byte offset (returned as `offset`) so
 * the UI can poll incrementally. Returns the last `limit` parsed turns.
 */
export async function readTranscript(file, { since = 0, limit = 200, maxBytes = 8 * 1024 * 1024 } = {}) {
  if (!file || !existsSync(file)) return { turns: [], offset: 0, exists: false };
  const s = await stat(file);
  let start = Math.max(0, Number(since) || 0);
  if (start > s.size) start = 0;                 // file was truncated/rotated
  if (!since && s.size > maxBytes) start = s.size - maxBytes;
  const fh = await open(file, 'r');
  try {
    const len = s.size - start;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    let text = buf.toString('utf8');
    if (start > 0 && !since) { const nl = text.indexOf('\n'); text = nl >= 0 ? text.slice(nl + 1) : ''; }
    const turns = [];
    for (const line of text.split('\n')) { if (!line.trim()) continue; const p = parseTranscriptLine(line); if (p) turns.push(p); }
    return { turns: turns.slice(-limit), offset: s.size, exists: true, bytes: s.size };
  } finally { await fh.close(); }
}

/**
 * The last thing the assistant said in a transcript (its final text block),
 * read from the tail only so it stays cheap on multi-megabyte transcripts.
 * Returns { text, ts, model } or null.
 */
export async function lastAssistantText(file, { tailBytes = 384 * 1024 } = {}) {
  if (!file || !existsSync(file)) return null;
  const s = await stat(file);
  const start = Math.max(0, s.size - tailBytes);
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(s.size - start);
    await fh.read(buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"assistant"')) continue;
      const p = parseTranscriptLine(lines[i]);
      if (p?.role === 'assistant' && p.text?.trim()) return { text: p.text.trim(), ts: p.ts ?? null, model: p.model ?? null };
    }
    return null;
  } finally { await fh.close(); }
}

/**
 * What a stopped session left for the human, from raw transcript lines (oldest
 * first): its last assistant text and an AskUserQuestion tool call that has no
 * tool_result yet. Pure; askContext() feeds it the transcript tail.
 */
export function askFromLines(lines) {
  let text = null, ts = null;
  const pending = new Map(); // tool_use id -> { question, options }
  for (const line of lines) {
    if (!line || line[0] !== '{') continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    const content = d.message?.content;
    if (d.type === 'assistant' && Array.isArray(content)) {
      const t = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      if (t) { text = t; ts = d.timestamp ?? null; }
      for (const b of content) {
        if (b.type !== 'tool_use' || b.name !== 'AskUserQuestion') continue;
        const q = Array.isArray(b.input?.questions) ? b.input.questions[0] : b.input;
        pending.set(b.id, { question: String(q?.question ?? q?.header ?? '').trim() || null, options: (Array.isArray(q?.options) ? q.options : []).map((o, i) => ({ n: i + 1, label: String(o?.label ?? o ?? '').slice(0, 120) })).filter((o) => o.label) });
      }
    } else if (d.type === 'user') {
      if (Array.isArray(content)) for (const b of content) if (b.type === 'tool_result' && b.tool_use_id) pending.delete(b.tool_use_id);
      // A typed reply after the question also answers it.
      if (typeof content === 'string' || (Array.isArray(content) && content.some((b) => b.type === 'text'))) { if (!d.isMeta) pending.clear(); }
    }
  }
  const pendingAsk = [...pending.values()].at(-1) ?? null;
  return { text, ts, pendingAsk };
}

/** askFromLines over the last few hundred KB of a transcript file. */
export async function askContext(file, { tailBytes = 384 * 1024 } = {}) {
  if (!file || !existsSync(file)) return { text: null, ts: null, pendingAsk: null };
  const s = await stat(file);
  const start = Math.max(0, s.size - tailBytes);
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(s.size - start);
    await fh.read(buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return askFromLines(lines);
  } finally { await fh.close(); }
}

/** The last non-empty line of a reply, trimmed for an alert ("Done. 3 files changed."). */
export function lastLine(text, max = 200) {
  const lines = String(text ?? '').split('\n').map((l) => l.replace(/^[#>*\-\s`]+/, '').trim()).filter(Boolean);
  const l = lines.at(-1) ?? '';
  return l.length > max ? l.slice(0, max - 1) + '…' : l;
}

/** Follow a transcript file; calls onTurn for each new parsed line. Returns a stop(). */
export function followTranscript(file, onTurn, { pollMs = 700 } = {}) {
  let offset = 0, stopped = false, pending = '';
  (async () => { try { offset = (await stat(file)).size; } catch { offset = 0; } })();
  const tick = async () => {
    if (stopped) return;
    try {
      const s = await stat(file);
      if (s.size < offset) offset = 0;
      if (s.size > offset) {
        await new Promise((res, rej) => {
          const rs = createReadStream(file, { start: offset, end: s.size - 1, encoding: 'utf8' });
          rs.on('data', (d) => { pending += d; });
          rs.on('end', res); rs.on('error', rej);
        });
        offset = s.size;
        let i;
        while ((i = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, i); pending = pending.slice(i + 1);
          const p = parseTranscriptLine(line); if (p) onTurn(p);
        }
      }
    } catch { /* file may not exist yet */ }
    if (!stopped) setTimeout(tick, pollMs);
  };
  setTimeout(tick, pollMs);
  return () => { stopped = true; };
}

/**
 * `--effort <level>` for one session (verified on 2.1.301: the header reads "with <level> effort" and
 * ~/.claude/settings.json is untouched, unlike /effort typed inside a session). [] when not asked for.
 * Throws for a level Claude Code does not take, which it would otherwise only warn about.
 */
export function effortArgv(effort) {
  const e = checkEffort('claude', effort);
  return e ? ['--effort', e] : [];
}

/**
 * Request values never become options (verified on 2.1.301). The prompt goes after `--`: without it a prompt
 * of `--version` printed the version, and one of `--dangerously-skip-permissions` would turn the flag on.
 * `--resume` takes an optional value, so a separate id that starts with "-" is parsed as the next option
 * (`--resume --version` printed the version); `--resume=<id>` binds it ("--version" is not a UUID). `--model`
 * takes a required value, which commander consumes even when it starts with "-", so it stays as it is.
 */
function resumeArg(resume) { return `--resume=${resume}`; }

/** Build the argv for an interactive claude launch from a resolved profile: profile argv, model, effort, resume, then -- and the prompt. */
export function interactiveArgv(profile, { model, effort, resume, prompt, extra = [] } = {}) {
  const argv = ['claude', ...(profile.argv ?? [])];
  if (model) argv.push('--model', model);
  argv.push(...effortArgv(effort));
  if (resume) argv.push(resumeArg(resume));
  argv.push(...extra);
  if (prompt) argv.push('--', prompt);
  return argv;
}

/** The argv (after the `claude` binary) of a headless stream-json session. The prompt goes on stdin, never argv. */
export function headlessArgv(profile, { model, effort, resume, sessionId } = {}) {
  const argv = [...(profile?.argv ?? []), '-p', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages'];
  if (resume) argv.push(resumeArg(resume)); else argv.push('--session-id', sessionId);
  if (model) argv.push('--model', model);
  argv.push(...effortArgv(effort));
  return argv;
}

/**
 * Headless (outside tmux) Claude session held open by the daemon. stream-json
 * both ways so the page can chat with it; it registers in the session registry
 * as an sdk-cli session so it shows up everywhere else too.
 */
export class HeadlessClaude {
  constructor({ cwd, profile, model, effort, resume, env, onEvent, onExit }) {
    this.sessionId = resume ?? uuidv7();
    this.cwd = cwd; this.onEvent = onEvent; this.onExit = onExit;
    const argv = headlessArgv(profile, { model, effort, resume, sessionId: this.sessionId });
    this.argv = argv;
    this.child = startLines('claude', argv, {
      cwd, env: { ...process.env, ...(env ?? {}) },
      onLine: (l) => { let d; try { d = JSON.parse(l); } catch { d = { type: 'raw', text: l }; } this.onEvent?.(d); },
      onStderr: (d) => this.onEvent?.({ type: 'stderr', text: d }),
      onExit: (code, sig) => this.onExit?.(code, sig),
    });
  }
  send(text) {
    const msg = { type: 'user', message: { role: 'user', content: text } };
    this.child.stdin.write(JSON.stringify(msg) + '\n');
  }
  stop() { try { this.child.stdin.end(); } catch { /* already closed */ } setTimeout(() => this.child.kill('SIGTERM'), 2000).unref(); }
}

/** Recent transcript files across all projects (for the Sessions view when a session is not live). */
export async function recentTranscripts({ days = 4, limit = 300 } = {}) {
  if (!existsSync(PROJECTS_DIR)) return [];
  const cutoff = Date.now() - days * 86400_000;
  const out = [];
  for (const slug of await readdir(PROJECTS_DIR)) {
    const dir = path.join(PROJECTS_DIR, slug);
    let names; try { names = await readdir(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const f = path.join(dir, n);
      let s; try { s = await stat(f); } catch { continue; }
      if (s.mtimeMs < cutoff || s.size < 2000) continue;
      out.push({ kind: 'claude', sessionId: n.slice(0, -6), slug, transcript: f, mtime: s.mtime.toISOString(), bytes: s.size });
    }
  }
  out.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
  return out.slice(0, limit);
}

/** First user prompt + last assistant text of a transcript, cheaply. */
export async function transcriptSummary(file) {
  const head = await readTranscript(file, { since: 0, limit: 400, maxBytes: 256 * 1024 });
  const firstUser = head.turns.find((t) => t.role === 'user' && !t.meta && t.text && !t.text.startsWith('<'));
  const tail = await readTranscript(file, { limit: 60 });
  const lastAssistant = [...tail.turns].reverse().find((t) => t.role === 'assistant' && t.text);
  const title = [...tail.turns].reverse().find((t) => t.role === 'title')?.text;
  return { title: title ?? firstUser?.text?.slice(0, 120) ?? '', firstPrompt: firstUser?.text?.slice(0, 500) ?? '', lastReply: lastAssistant?.text?.slice(0, 800) ?? '', lastTs: tail.turns.at(-1)?.ts ?? null };
}
