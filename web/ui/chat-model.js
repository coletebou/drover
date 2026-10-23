// The chat rendering rule shared by the drawer and the manager (and by the TUI, tui/chat.js): turns in, display
// items out. Pure; tested in test/ui-chat-model.test.js.
//
//  - mergeTurns keeps one copy of every turn. A turn is known by its event id (the manager), its transcript uuid
//    (Claude), else its role, time, text and calls. A local echo (sent from here) stands until the server copy
//    arrives: matched by the event id the send returned, else by its text (a Claude copy comes wrapped in a
//    cross-session envelope). A pending or streamed reply gives way to the turn with the same inReplyTo.
//  - chatItems turns a list into what a chat shows: consecutive tool-only assistant turns become one group with
//    a verb line ("Ran 3 commands, read 2 files"), each result under its call (by id, else in order); thinking,
//    titles, whitespace-only text and (unless asked) meta turns are hidden; user turns name who sent them.
import { owner, isOwner } from './owner.js';

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const HOME = /\/(?:Users|home)\/[^/\s]+/g;

/** The identity of a turn across reads and events. */
export function turnKey(t) {
  if (!t) return '';
  if (t.localId) return t.localId;
  if (t.id != null) return `id:${t.id}`;
  if (t.uuid) return `uuid:${t.uuid}`;
  const tools = Array.isArray(t.tools) ? t.tools.map((u) => u.id ?? u.name).join(',') : '';
  const res = Array.isArray(t.results) ? t.results.map((r) => r.toolUseId ?? '').join(',') : '';
  return `${t.role}|${t.ts ?? ''}|${String(t.text ?? '').slice(0, 160)}|${tools}|${res}`;
}

/** A Claude peer envelope (`<cross-session-message from-name="..">body</cross-session-message>`): { from, mode, body } or null. */
export function unwrapPeer(text) {
  const m = String(text ?? '').match(/^\s*<cross-session-message((?:\s+[\w-]+="[^"]*")*)\s*>\n?([\s\S]*?)\n?<\/cross-session-message>\s*$/);
  if (!m) return null;
  const attrs = Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
  return { from: attrs['from-name'] ?? null, mode: attrs['from-mode'] ?? null, body: m[2].replace(/<\\(?=\/cross-session-message)/g, '<') };
}
/** What a user turn says, for matching a local echo to its server copy. */
export function echoText(t) { const p = unwrapPeer(t?.text); return norm(p ? p.body : t?.text); }

/**
 * Who sent a user turn: { label, actor, via? }. The owner (or Drover relaying the owner) reads "you"; another actor (mcp, a bot,
 * a peer session) is named. Actor comes from the turn (manager transcripts), the gateway user ("drover:<actor>"), or
 * the envelope Drover and peer sessions wrap a Claude message in ("drover (<actor>)" or the sender's name).
 */
export function speaker(t) {
  if (t?.meta) return { label: 'system', actor: 'system' };
  // The daemon names inbox messages: via "drover" with the actor Drover relayed, via "peer" with the sender session.
  let via = t?.via ?? null;
  let actor = t?.actor ?? (via === 'peer' ? t?.from : null) ?? (typeof t?.user === 'string' ? t.user.replace(/^drover:/, '') : null);
  const peer = unwrapPeer(t?.text);
  if (peer && !via) { const m = peer.from?.match(/^(?:drover|apx-web)(?: \((.+)\))?$/i); actor = m ? (m[1] ?? owner()) : (peer.from || null); via = m ? 'drover' : 'peer'; }
  if (via === 'peer' && !actor) actor = 'another session';
  if (!actor || isOwner(actor) || /^(you|ui|web|user)$/i.test(actor)) return { label: 'you', actor: owner(), via };
  return { label: actor, actor, via };
}

/** Claude Code's own markup in user turns: a slash command, its output, an interrupt. null for plain text. */
export function commandOf(text) {
  const s = String(text ?? '');
  let m;
  if ((m = s.match(/<command-name>\s*([^<]+?)\s*<\/command-name>/))) { const args = s.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim(); return { kind: 'command', text: `${m[1].startsWith('/') ? '' : '/'}${m[1]}${args ? ` ${args}` : ''}` }; }
  if ((m = s.match(/^\s*<local-command-stdout>([\s\S]*?)<\/local-command-stdout>\s*$/))) return { kind: 'stdout', text: m[1].trim() };
  if ((m = s.match(/^\s*<bash-input>([\s\S]*?)<\/bash-input>\s*$/))) return { kind: 'command', text: `! ${m[1].trim()}` };
  if ((m = s.match(/^\s*<bash-stdout>([\s\S]*?)<\/bash-stdout>(?:\s*<bash-stderr>([\s\S]*?)<\/bash-stderr>)?\s*$/))) return { kind: 'stdout', text: [m[1], m[2]].filter((x) => x?.trim()).join('\n').trim() };
  if (/^\s*\[Request interrupted by user[^\]]*\]\s*$/.test(s)) return { kind: 'interrupt', text: 'interrupted' };
  return null;
}

/** Do two turns answer the same message? A reply, or the system line that says the reply failed. */
const answers = (p, s) => p.inReplyTo === s.inReplyTo && (p.role === s.role || [p.role, s.role].every((r) => r === 'assistant' || r === 'system'));

/**
 * Merge server turns (a transcript read, a `turn` event, a streamed reply) into a conversation without duplicates.
 * Returns a new array. Rules, in order: same identity replaces in place (a pending copy never shortens what was
 * shown, never reopens a finished turn); a reply with inReplyTo replaces the pending or streamed one it finishes; a
 * user turn replaces the local echo it copies (moved to where the server put it); an assistant turn replaces an
 * inline reply an older daemon returned with the same text; anything else is appended.
 */
export function mergeTurns(list, incoming) {
  let out = (list ?? []).slice();
  let at = new Map(out.map((t, i) => [turnKey(t), i]));
  const reindex = () => { at = new Map(out.map((t, i) => [turnKey(t), i])); };
  for (const s of incoming ?? []) {
    if (!s || typeof s !== 'object') continue;
    const k = turnKey(s);
    let i = at.get(k);
    if (i !== undefined) {
      const prev = out[i];
      if (s.pending && !prev.pending) continue;
      const keep = s.pending && typeof prev.text === 'string' && typeof s.text === 'string' && prev.text.length > s.text.length && prev.text.startsWith(s.text);
      out[i] = keep ? { ...s, text: prev.text } : s;
      continue;
    }
    if (s.inReplyTo != null && s.role !== 'user') {
      // Already answered: a late stream event or a stale pending copy never comes back as a second reply.
      if ((s.pending || s.streamed || s.localReply) && out.some((p) => answers(p, s) && !p.pending && !p.streamed && !p.localReply)) continue;
      i = out.findIndex((p) => answers(p, s) && (p.pending || p.streamed || p.localReply));
      if (i >= 0) {
        const prev = out[i];
        const keep = s.pending && typeof prev.text === 'string' && typeof s.text === 'string' && prev.text.length > s.text.length && prev.text.startsWith(s.text);
        at.delete(turnKey(prev)); out[i] = keep ? { ...s, text: prev.text } : s; at.set(k, i);
        continue;
      }
    }
    if (s.role === 'user' && !s.local) {
      const e = echoText(s);
      i = out.findIndex((p) => p.local && !p.failed && ((s.id != null && p.serverId != null && p.serverId === s.id) || echoText(p) === e));
      if (i >= 0) {
        // In place while only its own reply follows; after server turns that came since (a busy Claude session kept
        // working before it read the message), it moves to where the server put it: the end.
        const own = out.slice(i + 1).every((p) => p.local || p.streamed || p.pending || p.localReply || (s.id != null && p.inReplyTo === s.id));
        if (own) { at.delete(turnKey(out[i])); out[i] = s; at.set(k, i); } else { out.splice(i, 1); out.push(s); reindex(); }
        continue;
      }
    }
    if (s.role === 'assistant' && !s.pending && !s.localReply) {
      const e = norm(s.text);
      i = e ? out.findIndex((p) => p.localReply && norm(p.text) === e) : -1;
      if (i >= 0) { out.splice(i, 1); out.push(s); reindex(); continue; }
    }
    at.set(k, out.length); out.push(s);
  }
  return out;
}

/**
 * A full read (since 0) of a conversation this client already shows: the server's turns in the server's order,
 * deduplicated against what is here, then only what the server could not have yet: echoes still unanswered, a
 * reply still streaming, and turns that arrived after the read was taken.
 */
export function rebase(current, server) {
  const srv = (server ?? []).filter((t) => t && typeof t === 'object');
  if (!current?.length) return mergeTurns([], srv);
  const merged = mergeTurns(current, srv);
  const byKey = new Map(merged.map((t) => [turnKey(t), t]));
  const keys = new Set(srv.map(turnKey));
  // Where the read ends in what this client had: what came after that here is newer than the read. When the read
  // knows none of it, time decides (older turns are outside the read's window and drop).
  let lastKnown = -1; current.forEach((t, i) => { if (keys.has(turnKey(t))) lastKnown = i; });
  const firstTs = srv.find((t) => t.ts)?.ts ?? '';
  const newer = new Set(current.filter((t, i) => !keys.has(turnKey(t)) && (lastKnown >= 0 ? i > lastKnown : !firstTs || !t.ts || t.ts >= firstTs)).map(turnKey));
  const rest = merged.filter((t) => !keys.has(turnKey(t)) && (t.local || t.streamed || t.localReply || t.pending || newer.has(turnKey(t))));
  // A server turn that merging dropped (a stale pending copy of a reply already here) stays dropped.
  return [...srv.map((s) => byKey.get(turnKey(s))).filter(Boolean), ...rest];
}

// ---------------------------------------------------------------- tool calls
const pickFields = (s) => {
  // A daemon from before tool summaries cut an input's JSON at 300 chars: read the string fields that survive.
  const o = {};
  for (const m of String(s).matchAll(/"([A-Za-z_]+)"\s*:\s*"((?:[^"\\]|\\.)*)/g)) { try { o[m[1]] = JSON.parse(`"${m[2]}"`); } catch { o[m[1]] = m[2]; } }
  return o;
};
const oneLine = (s, max = 200) => { const l = String(s ?? '').split('\n').map((x) => x.trim()).find(Boolean) ?? ''; const t = l.replace(HOME, '~').replace(/\s+/g, ' '); return t.length > max ? t.slice(0, max - 1) + '…' : t; };
/** A display name for a tool: MCP tools lose their server prefix (mcp__drover__drover_sessions is drover_sessions). */
export function toolName(name) { return String(name ?? 'tool').replace(/^mcp__.+?__/, ''); }

/** The one line a call shows when the daemon sent no summary (core/toolcalls.js has the authoritative version). */
export function toolSummary(name, input) {
  let i = input;
  if (typeof i === 'string') { try { i = JSON.parse(i); } catch { i = /^\s*[{[]/.test(i) ? pickFields(i) : { _: i }; } }
  if (!i || typeof i !== 'object') i = { _: String(i ?? '') };
  const n = String(name ?? '');
  const cmd = Array.isArray(i.command) ? (i.command.includes('-lc') ? i.command[i.command.indexOf('-lc') + 1] : i.command.join(' ')) : i.command ?? i.cmd;
  let s;
  switch (n) {
    case 'Bash': case 'shell': case 'exec_command': case 'local_shell': s = cmd; break;
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': s = i.file_path ?? i.path; break;
    case 'NotebookEdit': case 'NotebookRead': s = i.notebook_path ?? i.file_path; break;
    case 'Grep': s = i.pattern ? `"${i.pattern}"${i.path ? ` in ${i.path}` : i.glob ? ` in ${i.glob}` : ''}` : ''; break;
    case 'Glob': s = i.pattern ? `${i.pattern}${i.path ? ` in ${i.path}` : ''}` : ''; break;
    case 'WebFetch': s = i.url; break;
    case 'WebSearch': case 'ToolSearch': s = i.query; break;
    case 'Task': case 'Agent': s = i.description; break;
    case 'TodoWrite': s = Array.isArray(i.todos) ? `${i.todos.length} item${i.todos.length === 1 ? '' : 's'}` : ''; break;
    default: s = Object.values(i).find((v) => typeof v === 'string' && v.trim()) ?? '';
  }
  return oneLine(s ?? '');
}

const VERB = [
  ['command', /^(Bash|BashOutput|KillShell|KillBash|shell|exec_command|local_shell|exec|unified_exec|write_stdin)$/],
  ['read', /^(Read|NotebookRead|read_file|view_image)$/],
  ['edit', /^(Edit|MultiEdit|Write|NotebookEdit|apply_patch|write_file|edit_file)$/],
  ['search', /^(Grep|Glob|LS|grep|glob|list_dir|find_files)$/],
  ['fetch', /^(WebFetch|WebSearch|web_search|web_fetch)$/],
  ['agent', /^(Task|Agent|spawn_agent)$/],
  ['todo', /^(TodoWrite|update_plan)$/],
];
export function verbOf(name) { const n = String(name ?? ''); return VERB.find(([, re]) => re.test(n))?.[0] ?? null; }

/** "Ran 3 commands, read 2 files": one phrase per kind of call, in the order they first ran. Files count once each. */
export function verbLine(calls) {
  const order = []; const by = new Map();
  for (const c of calls ?? []) {
    const v = verbOf(c.name) ?? `use:${toolName(c.name)}`;
    if (!by.has(v)) { by.set(v, { n: 0, files: new Set(), bare: 0 }); order.push(v); }
    const e = by.get(v); e.n++;
    if (v === 'read' || v === 'edit') { const fs = c.name === 'apply_patch' && c.summary ? c.summary.split(', ') : [c.summary]; for (const f of fs) if (f) e.files.add(f); else e.bare++; }
  }
  const pl = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const parts = order.map((v) => {
    const { n, files, bare } = by.get(v);
    const f = files.size + bare;
    switch (v) {
      case 'command': return `ran ${pl(n, 'command')}`;
      case 'read': return `read ${pl(f, 'file')}`;
      case 'edit': return `edited ${pl(f, 'file')}`;
      case 'search': return n === 1 ? 'searched once' : `searched ${n} times`;
      case 'fetch': return `fetched ${pl(n, 'page')}`;
      case 'agent': return `ran ${pl(n, 'agent')}`;
      case 'todo': return 'updated the todo list';
      default: return `used ${v.slice(4)}${n > 1 ? ` ${n} times` : ''}`;
    }
  });
  const s = parts.join(', ');
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}

/** The first lines of a result and whether there is more ("show all"). */
export function headOf(text, { lines = 6, chars = 600 } = {}) {
  const s = String(text ?? '').trimEnd();
  const ls = s.split('\n');
  let head = ls.slice(0, lines).join('\n');
  if (head.length > chars) head = head.slice(0, chars);
  return { head, more: head.length < s.length, lines: ls.length };
}

// ---------------------------------------------------------------- items
/** A daemon from before tools[] on Codex turns: a "tool" turn reads name(args). */
function legacyToolTurn(t) {
  const m = String(t.text ?? '').match(/^([\w.:-]+)\(([\s\S]*)\)$/);
  return m ? { ...t, role: 'assistant', text: '', tools: [{ name: m[1], input: m[2] }] } : null;
}

/**
 * Display items for a conversation: { kind: 'user'|'assistant'|'tools'|'system'|'result', key, ... }.
 * A tools item: { calls: [{ key, id, name, summary, description, input, result: { text, isError, chars } | null }],
 * line (the verb line), errors, ts, endTs }.
 */
export function chatItems(turns, { showMeta = false } = {}) {
  const items = [];
  let group = null;
  const byId = new Map(); const open = new Set();   // calls by id; calls still without a result, oldest first
  const give = (c, r) => { if (!c) return; c.result = r; open.delete(c); };
  // A result with no id (an older daemon) goes to the oldest call still waiting, in the current group first.
  const oldest = () => group?.calls.find((c) => open.has(c)) ?? open.values().next().value;
  for (const raw of turns ?? []) {
    const t = raw?.role === 'tool' ? legacyToolTurn(raw) ?? raw : raw;
    if (!t) continue;
    const role = t.role;
    if (role === 'assistant') {
      const text = typeof t.text === 'string' ? t.text : '';
      const tools = Array.isArray(t.tools) ? t.tools : [];
      if (text.trim() || ((t.pending || t.error) && !tools.length)) { group = null; items.push({ kind: 'assistant', key: turnKey(t), turn: t, text, pending: Boolean(t.pending), error: t.error ?? null, model: t.model ?? null }); }
      if (tools.length) {
        if (!group) { group = { kind: 'tools', key: `tools:${turnKey(t)}`, calls: [], ts: t.ts ?? null, endTs: t.ts ?? null }; items.push(group); }
        tools.forEach((u, n) => {
          const c = { key: u.id ? `call:${u.id}` : `${turnKey(t)}#${n}`, id: u.id ?? null, name: String(u.name ?? 'tool'), summary: u.summary ?? toolSummary(u.name, u.input), description: u.description ?? null, input: u.input, result: null, ts: t.ts ?? null };
          group.calls.push(c); open.add(c); if (c.id) byId.set(c.id, c);
        });
        group.endTs = t.ts ?? group.endTs;
      }
      continue;
    }
    if (role === 'tool_result') {   // never closes a group: Claude writes results between the calls
      if (Array.isArray(t.results) && t.results.length) {
        // A result whose call fell outside the window stays unattached rather than landing under another call.
        for (const r of t.results) give(r.toolUseId != null ? byId.get(r.toolUseId) : oldest(), { text: String(r.text ?? ''), isError: Boolean(r.isError), chars: r.chars ?? null });
      } else if (t.text) {   // a daemon from before results[]: one text, results joined by ---, 400 chars each
        const parts = (t.count ?? 1) > 1 ? String(t.text).split('\n---\n') : [String(t.text)];
        for (const p of parts) give(oldest(), { text: p.replace(/^\[error\] /, ''), isError: p.startsWith('[error] '), chars: null });
      }
      continue;
    }
    if (role === 'thinking' || role === 'title') continue;
    if (role === 'queue' && !showMeta) continue;   // Claude Code's own input queue: the message itself follows as a user turn
    if (role === 'user') {
      if (t.meta && !showMeta) continue;
      const cmd = commandOf(t.text);
      if (cmd) { if (cmd.kind === 'stdout' && !cmd.text && !showMeta) continue; group = null; items.push({ kind: 'system', key: turnKey(t), turn: t, sub: cmd.kind, text: cmd.text }); continue; }
      const sp = speaker(t);
      const peer = unwrapPeer(t.text);
      const text = peer ? peer.body : String(t.text ?? '');
      if (!text.trim() && !t.local) continue;
      group = null;
      items.push({ kind: 'user', key: turnKey(t), turn: t, label: sp.label, actor: sp.actor, via: sp.via, text, local: Boolean(t.local), failed: t.failed ?? null, meta: Boolean(t.meta) });
      continue;
    }
    if (role === 'tool') { group = null; items.push({ kind: 'system', key: turnKey(t), turn: t, sub: 'tool', text: String(t.text ?? '') }); continue; }
    const text = String(t.text ?? '');
    if (!text.trim() && role !== 'result') continue;
    group = null;
    items.push({ kind: role === 'result' ? 'result' : 'system', key: turnKey(t), turn: t, sub: role, text, error: t.error ?? null });
  }
  for (const it of items) if (it.kind === 'tools') { it.line = verbLine(it.calls); it.errors = it.calls.filter((c) => c.result?.isError).length; it.waiting = it.calls.filter((c) => !c.result).length; }
  return items;
}

/** A stable signature of what an item shows: unchanged signature, unchanged DOM. */
export function itemSig(it) {
  switch (it.kind) {
    case 'tools': return `t|${it.calls.length}|${it.calls.map((c) => `${c.key}:${c.result ? (c.result.isError ? 'e' : 'r') + c.result.text.length : '-'}`).join(',')}`;
    case 'assistant': return `a|${it.pending ? 1 : 0}|${it.error ?? ''}|${it.text.length}|${it.text.slice(-64)}`;
    case 'user': return `u|${it.local ? 1 : 0}|${it.failed ?? ''}|${it.label}|${it.text.length}|${it.text.slice(0, 64)}`;
    default: return `${it.kind}|${it.text.length}|${String(it.text).slice(0, 64)}`;
  }
}
