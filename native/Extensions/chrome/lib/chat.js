// The chat rendering rule (docs/specs/2026-10-20-ux-overhaul.md), the same in every client. Pure: turns in,
// display items out; ui/chat.js draws them with textContent only.
//
// 1. Consecutive assistant turns with no text and with tools form one group, with the tool results in between
//    attached to their calls by id. The group line counts by verb ("Ran 3 commands, read 2 files"); collapsed by
//    default, each row is the tool and its summary with the result under it. A group with an error is marked.
// 2. Assistant text is Markdown (paragraphs, lists, headings, fenced code, inline code, bold, links); a turn with
//    text and tools shows the text, then its calls.
// 3. User turns from the owner read "you"; meta turns are hidden unless asked for; another actor is named.
// 4. Thinking is not shown; while the session works a "working" line sits at the bottom.

import { isOwner } from './summary.js';

const COMMAND = /^(bash|shell|exec_command|local_shell|container\.exec|run_terminal_cmd)$/i;
const READ = /^(read|view|read_file|cat)$/i;
const EDIT = /^(edit|multiedit|write|notebookedit|apply_patch|str_replace_editor|create_file)$/i;
const SEARCH = /^(grep|glob|search|find|list|ls)$/i;
const FETCH = /^(webfetch|websearch|web_search|fetch)$/i;
const AGENT = /^(task|agent)$/i;
const TODO = /^(todowrite|update_plan)$/i;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** "Ran 3 commands, read 2 files", in the order the verbs first appear. */
export function toolGroupLabel(calls) {
  const order = [];
  const counts = new Map();
  for (const c of calls ?? []) {
    const n = String(c?.name ?? 'tool');
    const verb = COMMAND.test(n) ? 'cmd' : READ.test(n) ? 'read' : EDIT.test(n) ? 'edit' : SEARCH.test(n) ? 'search' : FETCH.test(n) ? 'fetch' : AGENT.test(n) ? 'agent' : TODO.test(n) ? 'todo' : `use:${n}`;
    if (!counts.has(verb)) order.push(verb);
    counts.set(verb, (counts.get(verb) ?? 0) + 1);
  }
  const parts = order.map((v) => {
    const n = counts.get(v);
    switch (v) {
      case 'cmd': return `ran ${plural(n, 'command', 'commands')}`;
      case 'read': return `read ${plural(n, 'file', 'files')}`;
      case 'edit': return `edited ${plural(n, 'file', 'files')}`;
      case 'search': return `searched ${plural(n, 'time', 'times')}`;
      case 'fetch': return `fetched ${plural(n, 'page', 'pages')}`;
      case 'agent': return `ran ${plural(n, 'agent', 'agents')}`;
      case 'todo': return 'updated the todo list';
      default: return `used ${v.slice(4)}`;
    }
  });
  const s = parts.join(', ');
  return s ? s[0].toUpperCase() + s.slice(1) : 'Used a tool';
}

/** The first `lines` lines of a result, and whether there is more to show. */
export function resultPreview(text, lines = 6) {
  const all = String(text ?? '').trimEnd().split('\n');
  return { head: all.slice(0, lines).join('\n'), more: all.length > lines };
}

const who = (t, me, owner) => {
  if (t.via === 'peer') return t.from ? `from ${t.from}` : 'another session';
  const a = t.actor ?? (typeof t.user === 'string' && t.user.startsWith('drover:') ? t.user.slice(7) : null);
  return !a || isOwner(a, owner) || a === me ? 'you' : a;
};

/**
 * Display items for a run of normalized turns (lib/transcript.js normalizeTurns).
 * @param {any[]} turns @param {{showMeta?: boolean, working?: boolean, me?: string, owner?: string|null}} [opts] `me`:
 *   this client's own actor; `owner`: the latest summary's owner (lib/summary.js isOwner). Their messages read "you".
 * @returns {any[]} items: {type:'user'|'assistant'|'tools'|'system'|'working', key, ...}
 */
export function chatItems(turns, { showMeta = false, working = false, me = null, owner = null } = {}) {
  const items = [];
  let group = null; // the open tool group
  const byCall = new Map(); // tool use id -> call row
  const close = () => { group = null; };
  const openGroup = (key) => {
    if (!group) { group = { type: 'tools', key: `g:${key}`, calls: [], error: false, label: '' }; items.push(group); }
    return group;
  };
  (turns ?? []).forEach((t, i) => {
    const key = t.uuid ?? t.id ?? `${t.role}:${t.ts ?? ''}:${i}`;
    if (t.role === 'tool') {
      // Results land on their calls; a result without a call (older daemons send none) opens a group of its own.
      const results = Array.isArray(t.results) && t.results.length ? t.results : [{ toolUseId: null, isError: /^\[error\]/.test(t.text ?? ''), text: t.text ?? '' }];
      for (const r of results) {
        const call = r.toolUseId ? byCall.get(r.toolUseId) : null;
        const target = call ?? (group?.calls.findLast((c) => !c.result) ?? null);
        const res = { text: String(r.text ?? '').replace(/^\[error\] /, ''), isError: r.isError === true, chars: Number.isFinite(r.chars) ? r.chars : null };
        if (target) target.result = res;
        else openGroup(key).calls.push({ id: null, name: 'tool', summary: '', result: res });
        const g = group ?? items.findLast((x) => x.type === 'tools');
        if (g && res.isError) g.error = true;
      }
      return;
    }
    if (t.role === 'assistant') {
      const text = String(t.text ?? '');
      if (text.trim()) { close(); items.push({ type: 'assistant', key, text, ts: t.ts ?? null, pending: t.pending === true }); }
      const calls = Array.isArray(t.calls) ? t.calls : [];
      if (calls.length) {
        const g = openGroup(key);
        for (const c of calls) {
          const row = { id: c.id ?? null, name: c.name ?? 'tool', summary: c.summary ?? '', description: c.description ?? null, result: null };
          g.calls.push(row);
          if (row.id) byCall.set(row.id, row);
        }
      } else if (!text.trim()) {
        // An empty reply in flight: the working line covers it.
      }
      return;
    }
    close();
    if (t.role === 'user') {
      if (t.meta && !showMeta) return;
      items.push({ type: 'user', key, text: String(t.text ?? ''), who: t.local ? 'you' : who(t, me, owner), ts: t.ts ?? null, local: t.local === true });
      return;
    }
    if (t.role === 'result') { items.push({ type: 'system', key, text: String(t.text ?? ''), error: false }); return; }
    if (t.role === 'system') items.push({ type: 'system', key, text: String(t.text ?? ''), error: Boolean(t.error) || /fail|error|not sent|not answered/i.test(t.text ?? '') });
  });
  for (const it of items) {
    if (it.type !== 'tools') continue;
    it.label = toolGroupLabel(it.calls);
    it.errors = it.calls.filter((c) => c.result?.isError).length;
  }
  if (working) items.push({ type: 'working', key: 'working' });
  return items;
}

// ---------------------------------------------------------------- Markdown (a safe subset, as data)

const SAFE_HREF = /^(https?:\/\/|mailto:)/i;

/**
 * Inline spans: `code`, **bold**, *em* / _em_, [text](http...) and bare http(s) links. Everything else is text.
 * @returns {{t:'text'|'code'|'b'|'i'|'a', v:string, href?:string}[]}
 */
export function inlineSpans(text) {
  const s = String(text ?? '');
  const out = [];
  const re = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\*\*([^*\n]+?)\*\*|__([^_\n]+?)__|\*([^*\s][^*\n]*?)\*|(?<![\w])_([^_\s][^_\n]*?)_(?![\w])|\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;
  let last = 0;
  for (const m of s.matchAll(re)) {
    if (m.index > last) out.push({ t: 'text', v: s.slice(last, m.index) });
    if (m[2] !== undefined) out.push({ t: 'code', v: m[2].replace(/^ (?=.* $)|(?<=^ .*) $/g, '') });
    else if (m[3] !== undefined || m[4] !== undefined) out.push({ t: 'b', v: m[3] ?? m[4] });
    else if (m[5] !== undefined || m[6] !== undefined) out.push({ t: 'i', v: m[5] ?? m[6] });
    else if (m[7] !== undefined) out.push(SAFE_HREF.test(m[8]) ? { t: 'a', v: m[7], href: m[8] } : { t: 'text', v: m[7] });
    else if (m[9] !== undefined) out.push({ t: 'a', v: m[9], href: m[9] });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ t: 'text', v: s.slice(last) });
  return out.filter((x) => x.v !== '');
}

/**
 * Blocks: headings, fenced code, bullet and numbered lists, quotes, paragraphs (lines joined; a blank line ends one).
 * @returns {({type:'h', level:number, text:string}|{type:'code', lang:string, text:string}|{type:'ul'|'ol', items:string[], start?:number}|{type:'quote', text:string}|{type:'p', text:string})[]}
 */
export function markdownBlocks(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let para = [];
  const flush = () => { if (para.length) { blocks.push({ type: 'p', text: para.join('\n') }); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+.-]*)\s*$/);
    if (fence) {
      flush();
      const body = [];
      let j = i + 1;
      for (; j < lines.length && !lines[j].trim().startsWith(fence[1]); j++) body.push(lines[j]);
      blocks.push({ type: 'code', lang: fence[2] ?? '', text: body.join('\n') });
      i = j;
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) { flush(); blocks.push({ type: 'h', level: h[1].length, text: h[2] }); continue; }
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*(\d{1,3})[.)]\s+(.*)$/);
    if (ul || ol) {
      flush();
      const type = ul ? 'ul' : 'ol';
      const prev = blocks.at(-1);
      const item = ul ? ul[1] : ol[2];
      if (prev?.type === type && prev.open) prev.items.push(item);
      else blocks.push({ type, items: [item], open: true, ...(ol ? { start: Number(ol[1]) } : {}) });
      continue;
    }
    const q = line.match(/^\s*>\s?(.*)$/);
    if (q) {
      flush();
      const prev = blocks.at(-1);
      if (prev?.type === 'quote' && prev.open) prev.text += `\n${q[1]}`;
      else blocks.push({ type: 'quote', text: q[1], open: true });
      continue;
    }
    if (!line.trim()) { flush(); const prev = blocks.at(-1); if (prev) prev.open = false; continue; }
    // A line under a list item that is indented continues it.
    const prev = blocks.at(-1);
    if (!para.length && (prev?.type === 'ul' || prev?.type === 'ol') && prev.open && /^\s{2,}\S/.test(line)) { prev.items[prev.items.length - 1] += ` ${line.trim()}`; continue; }
    if (prev) prev.open = false;
    para.push(line);
  }
  flush();
  return blocks.map(({ open, ...b }) => b);
}
