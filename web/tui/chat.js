// Transcript turns to chat items and rows, by the chat rendering rule every Drover client shares (the browser's
// half is ui/chat-model.js):
//   1. consecutive assistant turns with no text and tool calls form one group, "Ran 3 commands, read 2 files",
//      collapsed by default; expanded, one row per call (name and summary) with its result's first lines under
//      it, and all of it one level further; a group with an error result says so;
//   2. assistant text renders as Markdown; a turn with text and tools shows the text, then its calls;
//   3. user turns from the owner read "you", meta turns are hidden, another sender is named;
//   4. thinking is not shown; a "working" row sits at the bottom while the session works;
//   5. a waiting dialog puts an answer card at the bottom.
// Works with the old turn shape too (tools without summary, results as one joined text). Pure; tests in
// test/tui-chat.test.js.
import { renderMarkdown, wrapSegs, inline } from './markdown.js';
import { sanitize, oneLine, truncate, wrap } from './width.js';
import { isOwner } from '../ui/owner.js';

const HOME = /(?:\/Users|\/home)\/[^/\s"']+/g;
const short = (s) => String(s ?? '').replace(HOME, '~');

/** The one-line summary of a tool call, when the daemon sent none: the command, path, pattern, URL or query. */
export function toolSummary(name, input) {
  let o = input;
  if (typeof o === 'string') { try { o = JSON.parse(o); } catch { o = fieldsFromCut(o); } }
  if (!o || typeof o !== 'object') return '';
  const pick = (...ks) => { for (const k of ks) if (typeof o[k] === 'string' && o[k].trim()) return o[k]; return ''; };
  let s;
  switch (name) {
    case 'Bash': case 'shell': case 'exec_command': case 'local_shell': s = Array.isArray(o.command) ? o.command.join(' ') : pick('command', 'cmd'); break;
    case 'Read': case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit': s = pick('file_path', 'notebook_path', 'path'); break;
    case 'Grep': case 'Glob': { const p = pick('pattern'); const where = pick('path', 'glob'); s = p ? `"${p}"${where ? ` in ${where}` : ''}` : where; break; }
    case 'Task': case 'Agent': s = pick('description', 'prompt'); break;
    case 'WebFetch': s = pick('url'); break;
    case 'WebSearch': s = pick('query'); break;
    case 'TodoWrite': s = Array.isArray(o.todos) ? `${o.todos.length} items` : ''; break;
    default: s = Object.values(o).find((v) => typeof v === 'string' && v.trim()) ?? '';
  }
  return truncate(oneLine(short(s)), 200);
}
/** Fields of a JSON object cut short ("{\"command\":\"npm te…"), which the old daemon sends for long inputs. */
function fieldsFromCut(s) {
  const o = {};
  for (const m of s.matchAll(/"([A-Za-z_]+)"\s*:\s*"((?:[^"\\]|\\.)*)/g)) { try { o[m[1]] = JSON.parse(`"${m[2].replace(/\\$/, '')}"`); } catch { o[m[1]] = m[2]; } }
  return o;
}

// How a group line counts calls, by verb (in the spec's words).
const VERBS = [
  [/^(Bash|shell|exec_command|local_shell|BashOutput|KillShell|KillBash)$/, 'ran', 'command', 'commands'],
  [/^Read$/, 'read', 'file', 'files'],
  [/^(Edit|MultiEdit|Write|NotebookEdit|apply_patch)$/, 'edited', 'file', 'files'],
  [/^(Grep|Glob)$/, 'searched', 'time', 'times'],
  [/^(WebFetch|WebSearch)$/, 'fetched', 'page', 'pages'],
  [/^(Task|Agent)$/, 'ran', 'agent', 'agents'],
  [/^TodoWrite$/, 'updated the todo list'],
];
/** "Ran 3 commands, read 2 files" for a group's calls, in the order the kinds first appear. */
export function groupSummary(calls) {
  const parts = new Map();
  for (const c of calls) {
    const v = VERBS.find(([re]) => re.test(c.name));
    const k = v ? `${v[1]}|${v[2] ?? ''}` : `used|${c.name}`;
    const p = parts.get(k) ?? { v, name: c.name, n: 0 }; p.n++; parts.set(k, p);
  }
  const words = [...parts.values()].map(({ v, name, n }) => {
    if (!v) return n > 1 ? `used ${name} ${n} times` : `used ${name}`;
    if (!v[2]) return v[1];
    return `${v[1]} ${n} ${n === 1 ? v[2] : v[3]}`;
  });
  const s = words.join(', ');
  return s ? s[0].toUpperCase() + s.slice(1) : 'Used tools';
}

const ENVELOPE = /^\s*<cross-session-message([^>]*)>\n?([\s\S]*?)\n?<\/cross-session-message>\s*$/;
// A pane attached with the manager's /look: "[tmux window work:3 "editor" (pane %12) on host, last 60 lines]" and a fence.
const ATTACHED = /\n\n\[(tmux (?:window|pane) [^\n\]]*), last (\d+) lines\]\n```\n[\s\S]*\n?```\s*$/;

/** Who sent a user turn and what it says: the owner ("you"), or the peer named in a message envelope. */
export function userTurn(t) {
  let text = t.text ?? '', who = t.actor && !isOwner(t.actor) ? t.actor : 'you';
  const m = text.match(ENVELOPE);
  if (m) {
    text = m[2];
    const name = m[1].match(/from-name="([^"]*)"/)?.[1] ?? '';
    const actor = name.match(/^drover \(([^)]+)\)$/)?.[1];
    who = actor ? (isOwner(actor) ? 'you' : actor) : name || 'another session';
  }
  const a = text.match(ATTACHED);
  if (a) return { who, text: text.slice(0, a.index), attachment: `${a[1]}, ${a[2]} lines` };
  return { who, text };
}

/** Chat items from transcript turns (rule 1 to 4). Each item has a stable key, so expansion survives reloads. */
export function chatItems(turns, { showMeta = false } = {}) {
  const items = []; let group = null; const byId = new Map();
  const flush = () => { if (group) { group.error = group.calls.some((c) => c.result?.isError); items.push(group); } group = null; };
  const keyOf = (t, i) => t.uuid ?? t.id ?? `${t.role}|${t.ts ?? ''}|${i}`;
  turns.forEach((t, i) => {
    switch (t.role) {
      case 'assistant': {
        const text = typeof t.text === 'string' ? t.text : '';
        if (text.trim()) { flush(); items.push({ kind: 'text', key: keyOf(t, i), text, ts: t.ts, model: t.model, pending: Boolean(t.pending), error: t.error ?? null, who: t.who }); }
        const tools = Array.isArray(t.tools) ? t.tools : [];
        if (!tools.length) return;
        if (!group) group = { kind: 'tools', key: `tools|${keyOf(t, i)}`, ts: t.ts, calls: [] };
        for (const u of tools) {
          const call = { id: u.id ?? null, name: String(u.name ?? 'tool'), input: u.input, summary: typeof u.summary === 'string' ? truncate(oneLine(short(u.summary)), 200) : toolSummary(u.name, u.input), result: null };
          group.calls.push(call); if (call.id) byId.set(call.id, call);
        }
        return;
      }
      case 'tool_result': {
        if (Array.isArray(t.results) && t.results.length) {
          for (const r of t.results) {
            const call = (r.toolUseId && byId.get(r.toolUseId)) ?? group?.calls.find((c) => !c.result);
            if (call) call.result = { isError: Boolean(r.isError), text: String(r.text ?? '') };
          }
        } else if (group) {
          // The old shape: the results of one transcript line joined by "---", each cut to 400 chars.
          const parts = String(t.text ?? '').split('\n---\n');
          for (const p of parts) { const call = group.calls.find((c) => !c.result); if (!call) break; const err = p.startsWith('[error] '); call.result = { isError: err, text: err ? p.slice(8) : p }; }
        }
        return;
      }
      case 'thinking': case 'title': return;
      case 'user': {
        if (t.meta && !showMeta) return;
        flush();
        const u = userTurn(t);
        items.push({ kind: 'user', key: keyOf(t, i), who: t.meta ? 'system' : u.who, text: u.text, attachment: u.attachment ?? null, ts: t.ts, pending: Boolean(t.sending), error: t.error ?? null, local: Boolean(t.local) });
        return;
      }
      default: {
        flush();
        const text = t.role === 'queue' ? `queued: ${t.text ?? ''}` : t.role === 'result' ? `${t.text ?? ''}${t.cost != null ? `  ($${Number(t.cost).toFixed(3)})` : ''}` : t.text ?? '';
        if (String(text).trim()) items.push({ kind: 'note', key: keyOf(t, i), text, ts: t.ts, style: t.style ?? (t.role === 'error' ? 'err' : 'dim') });
      }
    }
  });
  flush();
  return items;
}

export const clock = (ts) => {
  if (ts == null || ts === '') return '';
  const n = typeof ts === 'number' ? (ts < 1e11 ? ts * 1000 : ts) : Date.parse(ts);
  if (!Number.isFinite(n)) return '';
  const d = new Date(n); const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === now.toDateString() ? hm : `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${hm}`;
};

const RESULT_LINES = 4;
/** Rows of one expanded call: name and summary, then its result (first lines, or all at level 2). */
function callRows(c, width, level) {
  const rows = [];
  rows.push(...wrapSegs([[c.name, c.result?.isError ? 'errBold' : 'accent'], ['  ', null], ...inline(c.summary || '', null)], width, { first: [['    ', null]], rest: [['      ', null]] }));
  if (!c.result) { rows.push([['      ', null], ['(no result yet)', 'dim']]); return rows; }
  const lines = sanitize(c.result.text).trimEnd().split('\n');
  const shown = level >= 2 ? lines.slice(0, 2000) : lines.slice(0, RESULT_LINES);
  for (const l of shown) for (const w of wrap(l, Math.max(8, width - 6), { words: false })) rows.push([['      ', null], [w, c.result.isError ? 'err' : 'dim']]);
  const more = lines.length - shown.length;
  if (more > 0) rows.push([['      ', null], [`… ${more} more line${more === 1 ? '' : 's'}${level >= 2 ? '' : ' (Enter shows all)'}`, 'dim']]);
  return rows;
}

/**
 * Rows for chat items. names: { you, assistant } labels. expanded: Map key -> 1 (calls) | 2 (all output).
 * Returns { rows, spans } where spans[i] = [firstRow, endRow) of item i, for selection and scrolling.
 */
export function chatRows(items, width, { expanded = new Map(), names = {}, selected = -1, working = false, footer = [] } = {}) {
  const rows = [], spans = [];
  const W = Math.max(16, width - 1);   // a one column gutter marks the selected item
  let prevKind = null;
  items.forEach((it, i) => {
    const start = rows.length;
    const out = [];
    const head = (label, style, extra = []) => out.push([[` ${label}`, style], ...(extra.length ? [['  ', null], ...extra] : [])]);
    if (it.kind === 'user') {
      if (rows.length) out.push([]);
      head(it.who === 'you' ? (names.you ?? 'you') : it.who, it.who === 'you' ? 'you' : 'other', [[clock(it.ts), 'dim'], ...(it.pending ? [['  sending…', 'dim']] : []), ...(it.error ? [[`  not sent: ${it.error}`, 'err']] : [])]);
      out.push(...renderMarkdown(it.text, W, { indent: ' ' }));
      if (it.attachment) out.push([[' + ', 'accent'], [`attached ${it.attachment}`, 'dim']]);
    } else if (it.kind === 'text') {
      if (prevKind !== 'text' && prevKind !== 'tools') { if (rows.length) out.push([]); head(it.who ?? names.assistant ?? 'assistant', 'mgr', [[clock(it.ts), 'dim'], ...(it.model ? [[`  ${it.model}`, 'dim']] : [])]); }
      out.push(...renderMarkdown(it.text, W, { indent: ' ' }));
      if (it.pending) out.at(-1)?.push(['▍', 'accent']);
      if (it.error) out.push([[' ', null], [`error: ${it.error}`, 'err']]);
    } else if (it.kind === 'tools') {
      if (prevKind !== 'text' && prevKind !== 'tools') { if (rows.length) out.push([]); head(names.assistant ?? 'assistant', 'mgr', [[clock(it.ts), 'dim']]); }
      const level = expanded.get(it.key) ?? 0;
      const errs = it.calls.filter((c) => c.result?.isError).length;
      out.push([[` ${level ? '▾' : '▸'} `, 'dim'], [groupSummary(it.calls), 'dim'], ...(errs ? [[`  ${errs === 1 ? '1 error' : `${errs} errors`}`, 'err']] : []), ...(!level ? [['  ' + truncate(it.calls.at(-1)?.summary ?? '', Math.max(0, W - 40)), 'dim']] : [])]);
      if (level) for (const c of it.calls) out.push(...callRows(c, W, level));
    } else if (it.kind === 'note') {
      for (const line of sanitize(it.text).trimEnd().split('\n')) out.push(...wrapSegs([[line, it.style ?? 'dim']], W, { first: [[' ', null]], rest: [['   ', null]] }));
    } else if (it.kind === 'card') {
      out.push([]); out.push(...it.rows);
    }
    for (const r of out) rows.push([[i === selected ? '▌' : ' ', i === selected ? 'accent' : null], ...r]);
    spans.push([start, rows.length]);
    prevKind = it.kind;
  });
  if (working) rows.push([], [[' ', null], [' ● ', 'work'], ['working…', 'dim']]);
  for (const f of footer) rows.push(f);
  return { rows, spans };
}

/**
 * The answer card of a waiting dialog (rule 5): the question, one row per option (the highlighted one marked),
 * and the keys. keys come from board.js answerKeys.
 */
export function answerCardRows(strip, keys, width) {
  const W = Math.max(16, width - 1);
  const rows = [];
  const label = strip.held ? `held message${strip.heldFrom ? ` from ${strip.heldFrom}` : ''}` : strip.ask?.label ?? 'waiting on you';
  rows.push([[' ┌ ', 'wait'], [label, 'waitBold']]);
  const q = strip.dialog?.question ?? strip.ask?.text ?? strip.headline;
  if (q) for (const r of wrapSegs([[oneLine(q), 'bold']], W, { first: [[' │ ', 'wait']], rest: [[' │ ', 'wait']] })) rows.push(r);
  for (const o of strip.dialog?.options ?? []) rows.push(...wrapSegs([[oneLine(o.label), o.selected ? 'bold' : null]], W, { first: [[' │ ', 'wait'], [o.selected ? '❯ ' : '  ', 'accent'], [`${o.n} `, 'key']], rest: [[' │     ', 'wait']] }));
  if (keys.length) rows.push([[' └ ', 'wait'], ...keyHints(keys)]);
  else rows.push([[' └ ', 'wait'], ['answer with a message: r', 'dim']]);
  return rows;
}

/** "1-3 pick · Enter approve · Esc deny" segments for answer keys. */
export function keyHints(keys) {
  const digits = keys.filter((k) => /^[1-9]$/.test(k.key));
  const parts = [];
  if (digits.length) parts.push([digits.length > 1 ? `${digits[0].key}-${digits.at(-1).key}` : digits[0].key, 'pick']);
  for (const k of keys) if (!/^[1-9]$/.test(k.key)) parts.push([k.key === 'Escape' ? 'Esc' : k.key, k.hint ?? k.label]);
  const segs = [];
  parts.forEach(([key, what], i) => { if (i) segs.push([' · ', 'dim']); segs.push([key, 'key'], [` ${what}`, 'dim']); });
  return segs;
}

/** The strings of rows (tests, search). */
export const rowsText = (rows) => rows.map((r) => r.map(([t]) => t ?? '').join(''));
