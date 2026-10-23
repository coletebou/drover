// What the search index keeps from each source: the words people and agents said,
// not what tools printed. Measured 2026-10-14: that is 1 to 4% of a transcript's
// bytes (tool output, injected context and bookkeeping are the rest), which is
// what makes a full local index cheap. Since 2026-10-20 it also keeps one line per
// thing an agent did (the shell command it ran, the file it wrote or edited, the
// URL it fetched), role "command": still never what the tool printed back.
// Pure functions; test/search-extract.test.js.
import { redactSecrets } from '../native.js';

const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
// Claude Code wraps slash-command echoes, local command output, hook output and
// background-task notices in these tags: bookkeeping, not conversation.
const WRAPPED = /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr|task-notification|user-prompt-submit-hook)>/;
const PEER_OPEN = /<cross-session-message\b[^>]*>/g;
const PEER_CLOSE = /<\/cross-session-message>/g;
const INTERRUPTED = /^\[Request interrupted by user[^\]]*\]$/;
const CODEX_INJECTED = ['<environment_context>', '<user_instructions>', '# AGENTS.md', '<permissions', '<user_shell_command>', '<turn_aborted>', '<developer'];
const ANSI = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** Text ready to index: escapes and control characters gone, secrets redacted, blank runs collapsed. */
export function tidy(text) {
  // Blanks before a newline are tried only where their run starts: tried from every blank of a long run with no
  // newline after it, the scan was quadratic (100 KB of spaces took 5 s).
  return redactSecrets(String(text ?? '').replace(ANSI, '').replace(CONTROL, ' '), { hexSafe: true })
    .replace(/(?<![ \t])[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * s.replace(re, '') for a pattern whose match ends in `close`, run only up to the last `close`: past it nothing can
 * match, and each unclosed start there rescanned the rest of the text (quadratic: 340 KB of unclosed tags took 1.3 s).
 */
const stripToLast = (s, re, close) => {
  const end = s.lastIndexOf(close) + close.length;
  return end < close.length ? s : s.slice(0, end).replace(re, '') + s.slice(end);
};

/** A user turn's own words: reminders stripped, peer envelopes unwrapped, bookkeeping dropped (''). */
export function userText(raw) {
  const s = String(raw ?? '');
  if (WRAPPED.test(s)) return '';
  const t = stripToLast(stripToLast(s, REMINDER, '</system-reminder>'), PEER_OPEN, '>').replace(PEER_CLOSE, '').trim();
  return INTERRUPTED.test(t) ? '' : t;
}

const lineOf = (line) => { if (!line || line[0] !== '{') return null; try { return JSON.parse(line); } catch { return null; } };

/** At most this much of one command or path is kept: enough to find it by its words, never a heredoc's body. */
export const COMMAND_CHARS = 300;

/** One line of tool input: escapes and secrets gone, whitespace folded, cut at `max` (an ellipsis counts). */
function clip(s, max = COMMAND_CHARS) {
  // Tidied whole, then cut: a cut made first can split a quoted secret or a URL's userinfo from what marks it (the
  // closing quote, the @), and the value before the cut stays unredacted. Tidying is linear: a 2 MB heredoc takes ~20 ms.
  const t = tidy(typeof s === 'string' ? s : '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * What one Claude Code tool call did, as one line: the shell command (with its stated purpose), the file it wrote
 * or edited, the URL it fetched, the web search it ran. '' for calls whose input says nothing worth finding later
 * (reads, globs, greps, subagent and MCP plumbing): the subagent's own transcript already holds its prompt.
 */
export function claudeToolLine(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  switch (name) {
    case 'Bash': {
      const cmd = clip(i.command);
      if (!cmd) return '';
      const why = clip(i.description, 120);
      return why ? `$ ${cmd}  # ${why}` : `$ ${cmd}`;
    }
    case 'Write': return i.file_path ? `wrote ${clip(i.file_path)}` : '';
    case 'Edit': case 'MultiEdit': return i.file_path ? `edited ${clip(i.file_path)}` : '';
    case 'NotebookEdit': return i.notebook_path ? `edited ${clip(i.notebook_path)}` : '';
    case 'WebFetch': return i.url ? `fetched ${clip(i.url)}` : '';
    case 'WebSearch': return i.query ? `searched the web: ${clip(i.query)}` : '';
    default: return '';
  }
}

const SHELLS = /(^|\/)(ba|z|da)?sh$/;
const PATCH_VERB = { Add: 'wrote', Update: 'edited', Delete: 'deleted' };
/** One apply_patch or exec cell gives at most this many lines: a patch can touch hundreds of files. */
const CALL_LINES = 20;

/**
 * What one Codex tool call did, as lines (the same shapes as claudeToolLine): exec_command and shell calls give
 * their command, apply_patch the files it touched, and a code-mode `exec` cell every `cmd: "..."` it passes to
 * a tool. Agent messaging (its payloads are encrypted), stdin writes, sleeps and browser calls give nothing.
 */
export function codexToolLines(p) {
  if (!p || typeof p !== 'object') return [];
  if (p.type === 'function_call') {
    let a; try { a = JSON.parse(p.arguments ?? '{}'); } catch { return []; }
    if (typeof a?.cmd === 'string') { const t = clip(a.cmd); return t ? [`$ ${t}`] : []; }
    if (Array.isArray(a?.command) && a.command.every((x) => typeof x === 'string')) {
      const c = a.command;
      const cmd = c.length >= 3 && SHELLS.test(c[0]) && /^-l?c$/.test(c[1]) ? c.slice(2).join(' ') : c.join(' ');
      return cmd.trim() ? [`$ ${clip(cmd)}`] : [];
    }
    return [];
  }
  if (p.type === 'local_shell_call') {
    const c = p.action?.command;
    const cmd = Array.isArray(c) ? clip(c.join(' ')) : '';
    return cmd ? [`$ ${cmd}`] : [];
  }
  if (p.type === 'custom_tool_call') {
    const name = String(p.name ?? ''), input = typeof p.input === 'string' ? p.input : '';
    if (name === 'apply_patch') {
      return [...input.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)].slice(0, CALL_LINES).map((m) => `${PATCH_VERB[m[1]]} ${clip(m[2])}`);
    }
    if (name === 'exec') {
      const out = [];
      for (const m of input.matchAll(/\bcmd\s*:\s*("(?:[^"\\\n]|\\.)*")/g)) {
        let cmd; try { cmd = JSON.parse(m[1]); } catch { continue; }
        const t = clip(cmd);
        if (t) out.push(`$ ${t}`);
        if (out.length >= CALL_LINES) break;
      }
      return out;
    }
  }
  return [];
}

/**
 * One Claude Code transcript line -> { units:[{role,text}], ts, uuid, cwd, sessionId, title }.
 * null when the line is not JSON. Keeps typed user text and assistant text blocks, and
 * one "command" unit per tool call that did something (claudeToolLine); drops tool
 * results, thinking, meta turns (skills, caveats) and wrappers. Compaction summaries
 * are kept as role "summary"; ai-title lines carry the title.
 */
export function claudeLine(line) {
  const d = lineOf(line);
  if (!d) return null;
  const out = { units: [], ts: d.timestamp ?? null, uuid: d.uuid ?? null, cwd: d.cwd ?? null, sessionId: d.sessionId ?? null, title: null };
  if (d.type === 'ai-title') { out.title = tidy(String(d.title ?? d.content ?? '')).replace(/\s+/g, ' ').slice(0, 200) || null; return out; }
  if (d.type === 'summary' && typeof d.summary === 'string') { const t = tidy(d.summary); if (t) out.units.push({ role: 'summary', text: t }); return out; }
  const content = d.message?.content;
  if (d.type === 'user') {
    if (d.isMeta) return out;
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    for (const b of blocks) if (b?.type === 'text') { const t = tidy(userText(b.text)); if (t) out.units.push({ role: 'user', text: t }); }
    return out;
  }
  if (d.type === 'assistant' && Array.isArray(content)) {
    const t = tidy(content.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n'));
    if (t) out.units.push({ role: 'assistant', text: t });
    for (const b of content) {
      if (b?.type !== 'tool_use') continue;
      const c = claudeToolLine(b.name, b.input);
      if (c) out.units.push({ role: 'command', text: c });
    }
  }
  return out;
}

/** Codex events that start, end or abort a turn (v1 names and their v2 aliases), and `error`: a prompt before one has no turn of its own. */
const CODEX_TURN_EVENTS = new Set(['task_started', 'turn_started', 'task_complete', 'turn_complete', 'turn_aborted', 'error']);
const XML_ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
/** Response items the model produced (and their outputs). Snapshots and other bookkeeping items are not output. */
const MODEL_ITEM = /^(reasoning|function_call|custom_tool_call|local_shell_call|web_search_call|tool_search_call|image_generation_call|mcp_tool_call)(_output)?$/;

/**
 * The working directory an <environment_context> item names: undefined when it names none (it changes nothing),
 * null when it names more than one (several environments: which one a turn ran in is unknown), else the path.
 */
export function environmentCwd(text) {
  const cwds = new Set([...String(text ?? '').matchAll(/<cwd>([^<]*)<\/cwd>/g)].map((m) => m[1].trim().replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => XML_ENTITY[e])));
  return cwds.size === 0 ? undefined : cwds.size === 1 ? [...cwds][0] || null : null;
}

/**
 * One Codex rollout line -> { units, ts, cwd, sessionId, mark, envCwd }. Only response_item
 * messages count (event_msg lines repeat them); injected environment, AGENTS.md
 * and permission blocks are dropped, as are developer and system messages. Tool
 * calls give "command" units (codexToolLines); their output is dropped. cwd is set
 * by session_meta and by each turn_context. mark says what the line means for which
 * checkout an item was in (codexAttribute): 'session' (session_meta), 'context' (turn_context),
 * 'env' (an <environment_context> naming a cwd, in envCwd), 'boundary' (a turn started,
 * ended or was aborted), 'prompt' (a user turn with words), 'output' (anything the model did), else null.
 */
export function codexLine(line) {
  const d = lineOf(line);
  if (!d) return null;
  const p = d.payload ?? {};
  const out = { units: [], ts: d.timestamp ?? null, cwd: null, sessionId: null, title: null, mark: null };
  if (d.type === 'session_meta') { out.cwd = typeof p.cwd === 'string' && p.cwd ? p.cwd : null; out.sessionId = p.id ?? p.session_id ?? null; out.mark = 'session'; return out; }
  if (d.type === 'turn_context') { out.cwd = typeof p.cwd === 'string' && p.cwd ? p.cwd : null; out.mark = 'context'; return out; }
  if (d.type === 'event_msg') { if (CODEX_TURN_EVENTS.has(p.type)) out.mark = 'boundary'; return out; }
  if (d.type !== 'response_item') return out;
  if (p.type !== 'message') { if (MODEL_ITEM.test(String(p.type ?? ''))) out.mark = 'output'; for (const c of codexToolLines(p)) out.units.push({ role: 'command', text: c }); return out; }
  const txt = (p.content ?? []).map((b) => b?.text ?? '').join('');
  const head = txt.trimStart();
  if (p.role === 'user' || p.role === 'developer') {
    // A turn whose cwd changed records an <environment_context> naming the new one, before (Codex up to ~0.46) or
    // after (later Codex) that turn's turn_context.
    if (head.startsWith('<environment_context>')) { const c = environmentCwd(txt); if (c !== undefined) { out.mark = 'env'; out.envCwd = c; } return out; }
    if (head.startsWith('<turn_aborted>')) { out.mark = 'boundary'; return out; }
  }
  if (p.role === 'user') {
    if (CODEX_INJECTED.some((x) => head.startsWith(x))) return out;
    const t = tidy(userText(txt)); if (t) { out.units.push({ role: 'user', text: t }); out.mark = 'prompt'; }
  } else if (p.role === 'assistant') {
    out.mark = 'output';
    const t = tidy(txt); if (t) out.units.push({ role: 'assistant', text: t });
  }
  return out;
}

/** The checkout of a Codex item that waits for the next turn_context to settle it (codexAttribute). */
export const PENDING = Symbol('pending checkout');

/** A fresh attribution state: { cwd, ctx, pending }, as codexAttribute keeps it (and the indexer stores it). */
export const codexState = (cwd = null, saved = null) => ({ cwd, ctx: typeof saved?.ctx === 'string' ? saved.ctx : null,
  pending: saved?.pending && typeof saved.pending === 'object' ? { before: typeof saved.pending.before === 'string' ? saved.pending.before : null, mixed: saved.pending.mixed !== false } : null });

/**
 * Which checkout the units of one Codex line (codexLine) were in, failing closed. state (codexState) carries:
 * cwd, the working directory in effect (session_meta, turn_context or an <environment_context> naming one); ctx, the
 * turn_context's cwd while it covers what follows (until the model's first output after it); pending, a run of items
 * still to settle. Codex wrote a turn's prompt after its turn_context (current), or before it (up to ~0.46, which
 * also writes one turn_context per model request), and on some error and abort paths with none at all; `codex
 * resume` in another checkout appends with no new session_meta. So a prompt the current turn_context covers is in
 * that checkout; any other prompt, and every item after it, is PENDING until the next turn_context, which settles
 * them in its cwd only if that is the cwd that was in effect for every one of them, and to null otherwise; a turn
 * boundary (start, end, abort, error) or a new session_meta first settles them to null. Returns { cwd } (a path,
 * null for unknown, or PENDING) and, when this line settled a pending run, resolve (the path or null).
 */
export function codexAttribute(state, r) {
  const s = state;
  const settle = (to) => { const p = s.pending; s.pending = null; return p ? (!p.mixed && p.before !== null && p.before === to ? to : null) : undefined; };
  const hold = () => { if (s.pending.before !== s.cwd) s.pending.mixed = true; return { cwd: PENDING }; };
  switch (r?.mark) {
    case 'session': { const resolve = settle(null); s.cwd = r.cwd ?? null; s.ctx = null; return { cwd: null, resolve }; }
    case 'context': { const resolve = settle(r.cwd ?? null); s.cwd = r.cwd ?? null; s.ctx = s.cwd; return { cwd: s.cwd, resolve }; }
    case 'boundary': { const resolve = settle(null); s.ctx = null; return { cwd: null, resolve }; }
    case 'env': s.cwd = r.envCwd ?? null; if (s.pending && s.pending.before !== s.cwd) s.pending.mixed = true; return { cwd: null };
    case 'prompt':
      if (s.pending) return hold();
      if (s.ctx !== null) return { cwd: s.cwd === s.ctx ? s.ctx : null };
      s.pending = { before: s.cwd, mixed: false };
      return { cwd: PENDING };
    case 'output':
      if (s.pending) return hold();
      s.ctx = null;
      return { cwd: s.cwd };
    default: return { cwd: s.pending ? PENDING : s.cwd };
  }
}

/**
 * One truth-file event -> { id, ts, role, text, title, sessionId } or null for
 * event types that carry no prose (ops, pins, notify alerts, settings...).
 * Survey items carry the AI or mechanical summary and next step per session.
 */
export function walEvent(ev) {
  if (!ev?.id || typeof ev !== 'object') return null;
  const pick = (...xs) => xs.filter((x) => typeof x === 'string' && x.trim()).join('\n');
  let text = '', title = '', sessionId = null;
  switch (ev.type) {
    case 'note': text = pick(ev.about, ev.text); title = `note${ev.about ? ': ' + ev.about : ''}`; break;
    case 'feature': text = pick(ev.title, ev.notes, ev.state ? `state: ${ev.state}` : '', Array.isArray(ev.links) ? ev.links.join(' ') : ''); title = `feature ${ev.fid ?? ''}${ev.title ? ': ' + ev.title : ''}`; break;
    case 'message': text = pick(ev.text); title = `message to ${ev.to?.name ?? ev.to?.id ?? 'a session'}${ev.to?.host ? ' on ' + ev.to.host : ''}`; sessionId = ev.to?.id ?? null; break;
    case 'chat': text = pick(ev.text); title = `chat from ${ev.from ?? 'agent'}`; sessionId = ev.to?.id ?? null; break;
    case 'handoff': text = pick(ev.text, ev.summary, ev.path); title = 'handoff'; break;
    case 'survey-item': {
      const it = ev.item ?? {};
      text = pick(it.title, it.summary, it.next_step ? `next: ${it.next_step}` : '', it.evidence, [...(it.activities ?? []), ...(it.mrs ?? [])].join(' '));
      title = `survey: ${it.title ?? it.id ?? ''}${it.host ? ' on ' + it.host : ''}`;
      sessionId = it.sessionId ?? null;
      break;
    }
    default: return null;
  }
  text = tidy(text);
  return text ? { id: ev.id, ts: ev.ts ?? null, role: ev.type, text, title: tidy(title).slice(0, 200), sessionId } : null;
}

/** A memory markdown file -> { title, text } (frontmatter name/description become the title; the body is the text). */
export function memoryDoc(raw, fileName = '') {
  const s = String(raw ?? '');
  const fm = s.startsWith('---\n') ? s.slice(4, Math.max(4, s.indexOf('\n---', 4))) : '';
  const body = fm ? s.slice(s.indexOf('\n---', 4) + 4) : s;
  const field = (k) => fm.match(new RegExp(`^${k}:\\s*"?(.*?)"?\\s*$`, 'm'))?.[1] ?? '';
  const name = field('name') || fileName.replace(/\.md$/, '');
  const desc = field('description');
  return { title: tidy(desc ? `${name}: ${desc}` : name).slice(0, 240), text: tidy(body) };
}

/**
 * Markdown -> [{ level, heading, body }], cut at level-1 and level-2 headings outside fenced code. Text before the
 * first heading is a section with level 0 and heading ''. Sections with no body are dropped.
 */
export function markdownSections(text, { keepEmpty = false } = {}) {
  const out = [];
  let cur = { level: 0, heading: '', lines: [] }, fence = false;
  for (const line of String(text ?? '').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = fence ? null : line.match(/^(#{1,2})\s+(.+?)\s*#*\s*$/);
    if (m) { out.push(cur); cur = { level: m[1].length, heading: m[2], lines: [] }; continue; }
    cur.lines.push(line);
  }
  out.push(cur);
  return out.map((s) => ({ level: s.level, heading: s.heading, body: s.lines.join('\n').trim() })).filter((s) => s.body || (keepEmpty && s.heading));
}

/** The repo a passage says it applies to: Codex memories carry `applies_to: cwd=<dir>`, rollout summaries `cwd: <dir>`. */
const CWD_HINT = /\bcwd\s*[=:]\s*`?((?:~|\/)[^\s;,`)]*)/;
const cwdProject = (text) => { const m = String(text ?? '').match(CWD_HINT)?.[1]; return m ? projectOf(m.replace(/^~/, '')) : null; };

/**
 * A document for the doc kind -> { sessionId, ts, sections: [{ title, text, project }] }, one section per # and ##
 * heading. The title is the document's (`label` when given, else frontmatter name and description, else its first
 * # heading, else the file name), then the enclosing # heading for a ## section, then the section's own heading.
 * A section that names its working directory (Codex memory task groups, rollout summaries) gets that repo as its
 * project, and a ## section inherits its # section's. A Codex rollout summary's header gives the thread id (a hit
 * then opens that Codex session) and the time it was written.
 */
export function docSections(raw, fileName = '', { label = null } = {}) {
  const s = String(raw ?? '');
  const head = {};
  for (const m of s.slice(0, 2000).matchAll(/^(thread_id|updated_at|cwd):\s*(\S.*)$/gm)) head[m[1]] ??= m[2].trim();
  const { title: named, text } = memoryDoc(s, fileName);
  const fm = s.startsWith('---\n') ? s.slice(4, Math.max(4, s.indexOf('\n---', 4))) : '';
  // The label (built by the caller from a path, e.g. a snapshot's host directory) is not run through redaction: a host
  // name with a long hex id in it (box-<32 hex>) would read as a token and every snapshot would be titled the same.
  const base = label ?? tidy(/^name:\s*\S/m.test(fm) ? named : (text.match(/^#\s+(.+?)\s*#*\s*$/m)?.[1] ?? named));
  const docProject = head.cwd ? projectOf(head.cwd) : null;
  const sections = [];
  let h1 = null, h1Project = null;
  // Empty # sections still count: they are the enclosing heading of the ## sections after them.
  for (const sec of markdownSections(text, { keepEmpty: true })) {
    const own = cwdProject(sec.body);
    if (sec.level === 1) { h1 = sec.heading; h1Project = own; }
    if (!sec.body) continue;
    const parts = [base];
    if (sec.level === 2 && h1 && h1 !== base) parts.push(h1);
    if (sec.heading && sec.heading !== base) parts.push(sec.heading);
    sections.push({ title: [parts[0], ...parts.slice(1).map((x) => tidy(x))].join(' › ').replace(/\s+/g, ' ').slice(0, 240), text: sec.body, project: own ?? (sec.level === 2 ? h1Project : null) ?? docProject });
  }
  return { sessionId: head.thread_id ?? null, ts: head.updated_at ?? null, sections };
}

/** A reflection's text is cut here: items run ~500 characters, and one chunk must stay one embedding input. */
export const REFLECTION_CHARS = 6000;

/**
 * One reflection item (a `reflections export` line) -> { id, ts, role, title, text, project, sessionId, status, origin,
 * checkout, host } or null. checkout and host are where the item was written: the exported `checkout` (the git
 * top level of the directory it was added in, a private worktree included) and the host that added it. They are
 * what a tenant search is authorized on, so they are kept as exported (null when missing, never filled in). The
 * exported `cwd` is not used: the CLI sets it to the MAIN worktree's root, so an item written in a private
 * worktree would pass for one written in the main checkout. The text is
 * what gets embedded and keyword-indexed: title, body and tags, then the item's #id. Search fuses
 * hits by text hash, so without the id two items with the same words (another repo, a closed twin) would come back as
 * one hit carrying one id; with it each item is its own hit, and its id finds it. The status is left out, so closing
 * or reopening an item keeps its vector; role is the item's kind (action, gotcha, decision...).
 */
export function reflectionItem(it, { max = REFLECTION_CHARS } = {}) {
  if (!it || typeof it !== 'object' || typeof it.id !== 'string' || !it.id) return null;
  const title = tidy(it.title).replace(/\s+/g, ' ').slice(0, 240);
  const tags = Array.isArray(it.tags) ? it.tags.filter((t) => typeof t === 'string' && t.trim()) : [];
  const words = tidy([title, typeof it.body === 'string' ? it.body : '', tags.length ? `tags: ${tags.join(' ')}` : ''].filter((x) => x.trim()).join('\n\n')).slice(0, max);
  if (!words) return null;
  return { id: it.id, ts: it.updated_at ?? it.created_at ?? null, role: it.kind ?? null, title: title || null, text: `${words}\n\n#${it.id}`, project: it.repo ?? null, sessionId: it.session_id ?? null, status: it.status ?? null, origin: it.origin ?? null,
    checkout: typeof it.checkout === 'string' && it.checkout ? it.checkout : null, host: typeof it.host === 'string' && it.host ? it.host : null };
}

/** Project label from a cwd: the repo directory, with worktree paths folded back onto their repo. */
export function projectOf(cwd) {
  if (!cwd) return null;
  const s = String(cwd).replace(/\/+$/, '');
  const wt = s.match(/^(.*?)\/\.claude\/worktrees\/[^/]+/);
  const base = (wt ? wt[1] : s).split('/').pop();
  return base || null;
}
