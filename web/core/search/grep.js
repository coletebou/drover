// Raw transcript grep: ripgrep over this host's Claude Code and Codex JSONL, for what the
// search index leaves out on purpose (tool output and results, thinking, injected context)
// and for history no index covers yet. Read-only, bounded (limit, per-session cap, time
// budget), newest files first, never given a path by the caller: it only reads the
// transcript roots. Each hit names the part of the transcript that matched and carries a
// redacted snippet. Tests: test/search-grep.test.js.
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { defaultRoots, skipReason } from './indexer.js';
import { tidy, projectOf } from './extract.js';
import { envvar } from '../envvars.js';

export const GREP_KINDS = ['claude', 'subagent', 'codex'];
export const GREP_ROLES = ['user', 'assistant', 'thinking', 'tool_use', 'tool_result', 'summary', 'meta'];
const SNIP = 160;          // characters of context on each side of the match
const PER_FILE = 200;      // matches ripgrep reports per file before moving on (a file that reaches it is reported)
const MARGIN = 2000;       // redaction context kept around a snippet, so a label (Authorization: Bearer) stays with its value
const BLOB = 200;          // an unbroken base64-alphabet run this long is encoded data: longer than any path, id or digest
const CHANCE = 12;         // a needle this long does not match base64 by chance (under 1 in 32^12 per position)
const B64 = /[a-z0-9+/=_-]/; // one base64 or base64url character, in folded text
/** Lowercase ASCII only, so a position found in the folded text holds in the original ('İ' lowercases to two). */
const fold = (s) => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());

/** The ripgrep binary: DROVER_RG, else the first rg on PATH or in the usual install places (a launchd PATH is short). */
export function findRg(env = process.env) {
  const named = envvar('RG', env);
  if (named) return existsSync(named) ? named : null;
  const dirs = [...String(env.PATH ?? '').split(':'), path.join(env.HOME ?? '', 'homebrew', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  for (const d of dirs) { if (!d) continue; const f = path.join(d, 'rg'); try { if (statSync(f).isFile()) return f; } catch { /* not here */ } }
  return null;
}

/** What message, tool-result or reasoning content is made of: a string, the strings and text blocks of a list, else the value. */
function contentOf(c) {
  if (typeof c === 'string') return [c];
  if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? x : String(x?.text ?? '')));
  return c == null ? [] : [c];
}

/** Every string inside a value, in order: a structured tool result as plain text. */
function leaves(v) {
  if (typeof v === 'string') return v ? [v] : [];
  return v && typeof v === 'object' ? Object.values(v).flatMap(leaves) : [];
}

/** A part made of values, one per line: strings as they are, anything else as its JSON. src keeps the values (spans). */
function made(role, src, tool) {
  return { role, ...(tool === undefined ? {} : { tool }), text: src.map((v) => (typeof v === 'string' ? v : JSON.stringify(v ?? {}))).join('\n'), src };
}

/**
 * The searchable parts of one transcript line, in order: [{ role, tool?, text, src }]. Claude Code: typed text,
 * assistant text, thinking, tool calls (their input), tool results, compaction summaries; other line types are
 * "meta". Codex: response_item messages, tool calls and their output, reasoning summaries; event_msg lines repeat
 * the response items and give nothing.
 */
export function lineParts(obj, kind) {
  if (!obj || typeof obj !== 'object') return [];
  if (kind === 'codex') {
    const p = obj.payload ?? {};
    if (obj.type === 'event_msg') return [];
    if (obj.type !== 'response_item') return [made('meta', [p])];
    if (p.type === 'message') return [made(p.role === 'assistant' || p.role === 'user' ? p.role : 'meta', contentOf(p.content))];
    if (p.type === 'function_call') return [made('tool_use', [String(p.arguments ?? '')], p.name ?? null)];
    if (p.type === 'custom_tool_call') return [made('tool_use', [String(p.input ?? '')], p.name ?? null)];
    if (p.type === 'local_shell_call') return [made('tool_use', [p.action ?? {}], 'shell')];
    if (/_output$/.test(p.type ?? '')) return [made('tool_result', contentOf(p.output))];
    if (p.type === 'reasoning') { const s = made('thinking', contentOf(p.summary)); return [s.text ? s : made('thinking', contentOf(p.content))]; }
    return [made('meta', [p])];
  }
  if (obj.type === 'summary') return [made('summary', [String(obj.summary ?? '')])];
  const c = obj.message?.content;
  if (obj.type === 'user' || obj.type === 'assistant') {
    const blocks = typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : [];
    const out = [];
    for (const b of blocks) {
      if (b?.type === 'text') out.push(made(obj.isMeta ? 'meta' : obj.type, [String(b.text ?? '')]));
      else if (b?.type === 'thinking') out.push(made('thinking', [String(b.thinking ?? '')]));
      else if (b?.type === 'tool_use') out.push(made('tool_use', [b.input ?? {}], b.name ?? null));
      else if (b?.type === 'tool_result') out.push(made('tool_result', contentOf(b.content)));
    }
    // Claude Code keeps a tool's whole result beside the tool_result it sent (all of stdout, the file written or
    // edited, the patch). It comes last, so it only answers for what the message itself lacks.
    if (obj.toolUseResult != null) out.push(made('tool_result', leaves(obj.toolUseResult)));
    return out;
  }
  return [made('meta', [obj])];
}

/** The match as it reads in the decoded text: ripgrep reports it as it sits in the JSON line, escapes and all. */
function decodedNeedle(raw) {
  if (!raw) return '';
  try { return JSON.parse(`"${raw}"`); } catch { return raw; }
}

/**
 * What one ripgrep match can read as in a part's text, folded and cut to SNIP characters: the match decoded, and, as
 * a regex can run on past the end of the JSON string it started in (build.* takes the closing quote and the rest of
 * the line), the match up to that string's end. Never the user's regex run again here: JavaScript's backtracks.
 */
function readings(raw) {
  if (!raw) return [];
  let i = 0;
  while (i < raw.length && raw[i] !== '"') i += raw[i] === '\\' ? 2 : 1;
  return [decodedNeedle(raw), i < raw.length ? decodedNeedle(raw.slice(0, i)) : ''].filter(Boolean).map((s) => fold(s.slice(0, SNIP)));
}

/** ripgrep's submatches as character offsets in the line, in order ({ s, e }): it counts bytes. */
function charOffsets(raw, subs) {
  const buf = Buffer.from(raw);
  const out = [];
  let byte = 0, ch = 0;
  for (const m of subs ?? []) {
    if (!Number.isInteger(m?.start) || !Number.isInteger(m?.end) || m.start < byte) continue;
    ch += buf.toString('utf8', byte, m.start).length; byte = m.start;
    out.push({ s: ch, e: ch + buf.toString('utf8', m.start, m.end).length });
  }
  return out;
}

/**
 * Where a part's values sit in the raw line: [{ at, end, off, str }], at..end a value's JSON there (a string's quotes
 * included), off where it starts in the part's text; null when one is not there (written in a spelling JSON.stringify
 * does not reproduce, such as 1.0). JSON.stringify spells strings as both writers do, and an identical copy found
 * first holds the same matches, so it serves as well.
 */
function spans(raw, part) {
  const out = [];
  let off = 0;
  for (const v of part.src) {
    const str = typeof v === 'string';
    if (str && !v) { off += 1; continue; }
    const lit = JSON.stringify(str ? v : v ?? {}), at = raw.indexOf(lit);
    if (at < 0) return null;
    out.push({ at, end: at + lit.length, off, str });
    off += (str ? v : lit).length + 1;
  }
  return out;
}

/** How long a piece of a JSON string's inside reads once decoded; a piece cut inside an escape leaves the escape out. */
function decodedLength(piece) {
  for (let k = 0; k < 6 && k <= piece.length; k++) { try { return JSON.parse(`"${piece.slice(0, piece.length - k)}"`).length; } catch { /* inside an escape */ } }
  return piece.length;
}

/**
 * The matches inside one part, lazily and in order: [needle (folded, cut to SNIP), where it starts in the part's
 * text], or [null] for one inside encoded data, judged on the folded line (lowRaw), where base64 reads the same, so a
 * line full of chance matches costs no decoding. Placed by where ripgrep found them in the line, so a regex's own
 * context holds (\bgo\b in the cwd is not "going" in the text) and a match that runs on past the closing quote of its
 * string (build.*) ends there. A part whose values are not all in the line falls back to what each match reads as,
 * looked for in its text.
 */
function* matchesIn(raw, lowRaw, part, subs) {
  const sp = spans(raw, part);
  if (!sp) {
    const low = fold(part.text);
    for (const n of new Set(subs.flatMap(({ s, e }) => readings(raw.slice(s, e))))) if (low.includes(n)) yield [n, undefined];
    return;
  }
  for (const { s, e } of subs) {
    const v = sp.find((x) => (x.str ? x.at < s && s < x.end - 1 : x.at <= s && s < x.end));
    if (!v) continue;
    const piece = raw.slice(s, Math.min(e, v.str ? v.end - 1 : v.end));
    if (inRun(lowRaw, fold(piece.slice(0, SNIP)), s)) { yield [null]; continue; }
    yield [fold((v.str ? decodedNeedle(piece) : piece).slice(0, SNIP)), v.off + (v.str ? decodedLength(raw.slice(v.at + 1, s)) : s - v.at)];
  }
}

/**
 * The occurrence of needle (folded) at `at` in low sits inside BLOB or more base64-alphabet characters, base64 and the
 * like, where a short needle matches by chance. A missing space proves nothing: tool input is JSON, and a tool can
 * print one path. A needle with any other character is never inside a run, and a long one was meant even there.
 */
function inRun(low, needle, at) {
  if (needle.length >= CHANCE || [...needle].some((ch) => !B64.test(ch))) return false;
  let a = at, b = at + needle.length;
  while (a > 0 && b - a < BLOB && B64.test(low[a - 1])) a--;
  while (b < low.length && b - a < BLOB && B64.test(low[b])) b++;
  return b - a >= BLOB;
}

/** Where needle (folded) first occurs in low, at or after `at`, outside such a run; -1 when it never does. */
function readableAt(low, needle, at) {
  while (at >= 0 && inRun(low, needle, at)) at = low.indexOf(needle, at + 1);
  return at;
}

/**
 * ~2×SNIP characters around needle (case-insensitive), on one line, secrets redacted: around the occurrence that
 * starts at pos in text when given (the one ripgrep matched), else the first readable one. '' when that occurrence
 * is not there or sits inside encoded data.
 */
export function grepSnippet(text, needle, pos) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  const want = fold(String(needle ?? '').replace(/\s+/g, ' '));
  const low = fold(flat);
  // pos measured again in the folded whitespace (a run there may straddle it, so allow a character either way).
  const near = pos == null ? 0 : Math.max(0, String(text).slice(0, pos).replace(/\s+/g, ' ').trimStart().length - 1);
  const first = want ? low.indexOf(want, near) : -1;
  const hit = pos != null ? (first >= 0 && first <= near + 2 && !inRun(low, want, first) ? first : -1) : first < 0 ? -1 : readableAt(low, want, first);
  if (hit < 0 && (pos != null || first >= 0)) return '';
  // Redact before cutting: a window that starts between a label and its value (Authorization: Bearer x, a known
  // token prefix) would hand the redactor an unlabelled fragment. The wide margin keeps any label near the snippet.
  const from = hit < 0 ? 0 : Math.max(0, hit - MARGIN);
  const red = tidy(flat.slice(from, hit < 0 ? 2 * SNIP + MARGIN : hit + want.length + MARGIN)).replace(/\s+/g, ' ');
  // Find the occurrence chosen above where it landed after redaction: at est, or one past it when a trailing space was
  // trimmed. Anywhere else it is another occurrence and the chosen one was redacted (inside a token, or a path with an
  // id in it): then the snippet centres on where it was.
  const est = hit < 0 ? 0 : tidy(flat.slice(from, hit)).replace(/\s+/g, ' ').length;
  let at = want ? fold(red).indexOf(want, Math.max(0, est - 1)) : -1, len = want.length;
  if (hit >= 0 && (at < 0 || at > est + 1)) { at = Math.min(red.length, est); len = 0; }
  const start = at < 0 ? 0 : Math.max(0, at - SNIP);
  const end = at < 0 ? Math.min(red.length, 2 * SNIP) : Math.min(red.length, at + len + SNIP);
  return `${start > 0 || from > 0 ? '…' : ''}${red.slice(start, end)}${end < red.length || hit + want.length + MARGIN < flat.length ? '…' : ''}`;
}

/** Which transcript kind a path under the roots is, and its session id. */
function placeOf(file, roots) {
  if (roots.claude && file.startsWith(roots.claude + path.sep)) {
    const rel = file.slice(roots.claude.length + 1).split(path.sep);
    if (rel.length >= 4 && rel[2] === 'subagents') return { kind: 'subagent', sessionId: rel[1], slug: rel[0] };
    return { kind: 'claude', sessionId: path.basename(file, '.jsonl'), slug: rel[0] };
  }
  if (roots.codex && file.startsWith(roots.codex + path.sep)) return { kind: 'codex', sessionId: path.basename(file).match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/)?.[1] ?? null, slug: null };
  return null;
}

/** A Codex rollout's working directory, from its session_meta line (read once per file). */
async function codexCwd(file, cache) {
  if (cache.has(file)) return cache.get(file);
  let cwd = null;
  try {
    const fh = await open(file, 'r');
    try {
      const buf = Buffer.alloc(64 * 1024);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      for (const line of buf.subarray(0, bytesRead).toString('utf8').split('\n')) {
        if (!line.includes('"session_meta"')) continue;
        try { cwd = JSON.parse(line)?.payload?.cwd ?? null; } catch { /* torn */ }
        break;
      }
    } finally { await fh.close(); }
  } catch { /* gone */ }
  cache.set(file, cwd);
  return cwd;
}

const list = (v) => (Array.isArray(v) ? v : v ? String(v).split(',') : []).map((x) => String(x).trim()).filter(Boolean);
const clamp = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.floor(n))) : d; };

/**
 * @param {object} q  { pattern, regex=false, caseSensitive=false, kinds, roles, days, project, limit=50, perSession=3 }
 * @param {object} [o] { roots (defaultRoots()), rg (findRg()), timeoutMs (30 s), env }
 * @returns {Promise<{pattern, results, matched, skipped, truncated, ms, notes}>}
 */
export async function grepTranscripts(q, { env = process.env, roots = defaultRoots(env), rg = findRg(env), timeoutMs = 30_000 } = {}) {
  const pattern = String(q?.pattern ?? '').trim();
  if (pattern.length < 2 || pattern.length > 300) throw new Error('pattern must be 2 to 300 characters');
  if (!rg) throw new Error('ripgrep (rg) is not installed on this host; set DROVER_RG to its path');
  const t0 = Date.now();
  const limit = clamp(q.limit, 1, 200, 50), perSession = clamp(q.perSession, 1, 50, 3);
  const picked = list(q.kinds).filter((k) => GREP_KINDS.includes(k));
  const kinds = new Set(picked.length ? picked : GREP_KINDS);
  const roles = new Set(list(q.roles).filter((r) => GREP_ROLES.includes(r)));
  const since = q.days ? new Date(Date.now() - Number(q.days) * 86400_000).toISOString() : null;
  const project = q.project ? String(q.project).toLowerCase() : null;
  const dirs = [];
  if ((kinds.has('claude') || kinds.has('subagent')) && roots.claude && existsSync(roots.claude)) dirs.push(roots.claude);
  if (kinds.has('codex') && roots.codex && existsSync(roots.codex)) dirs.push(roots.codex);
  const notes = [];
  const results = [], perKey = new Map(), seen = new Set(), cwdCache = new Map();
  const perFile = new Map();
  let cappedFiles = 0;
  const skipped = { blob: 0, outside: 0, filtered: 0, capped: 0, unparsed: 0 };
  let matched = 0, truncated = false;
  if (!dirs.length) return { pattern, results, matched, skipped, truncated, ms: Date.now() - t0, notes: ['no transcript directories on this host'] };

  // A fixed string is searched as the JSON lines spell it ("hi" as \"hi\", C:\x as C:\\x), and as JSON inside a JSON
  // string spells it (Codex tool arguments: \\\"hi\\\"), so it matches the text at either depth; a regex runs on the
  // raw line as written.
  const once = JSON.stringify(pattern).slice(1, -1);
  const exprs = q.regex === true ? [pattern] : [...new Set([once, JSON.stringify(once).slice(1, -1)])];
  const args = ['--json', '--no-messages', '--sortr=modified', '--max-count', String(PER_FILE), '--glob', '*.jsonl',
    q.caseSensitive === true ? '--case-sensitive' : '--ignore-case', ...(q.regex === true ? [] : ['--fixed-strings']), ...exprs.flatMap((x) => ['-e', x]), '--', ...dirs];
  const child = spawn(rg, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, RIPGREP_CONFIG_PATH: '' } });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
  const timer = setTimeout(() => { truncated = true; notes.push(`stopped after ${Math.round(timeoutMs / 1000)} s`); child.kill('SIGTERM'); }, timeoutMs);
  timer.unref?.();

  const handle = async (ev) => {
    if (ev.type !== 'match') return;
    matched++;
    const file = ev.data?.path?.text, raw = ev.data?.lines?.text;
    if (file) { const n = (perFile.get(file) ?? 0) + 1; perFile.set(file, n); if (n === PER_FILE) cappedFiles++; }
    if (!file || typeof raw !== 'string') { skipped.unparsed++; return; }
    const place = placeOf(file, roots);
    if (!place || !kinds.has(place.kind)) { skipped.filtered++; return; }
    if (place.slug && skipReason({ slug: place.slug }, env)) { skipped.filtered++; return; }
    let obj; try { obj = JSON.parse(raw); } catch { skipped.unparsed++; return; }
    const ts = obj.timestamp ?? null;
    if (since && !(ts && ts >= since)) { skipped.filtered++; return; }   // untimed lines (ai-title, last-prompt) fail a days filter, as in the index
    const cwd = place.kind === 'codex' ? await codexCwd(file, cwdCache) : obj.cwd ?? null;
    const proj = projectOf(cwd);
    if (project && !(proj ?? '').toLowerCase().includes(project)) { skipped.filtered++; return; }
    const subs = charOffsets(raw, ev.data?.submatches), lowRaw = fold(raw);
    const parts = lineParts(obj, place.kind);
    // The first part that shows a match outside encoded data. With roles asked for, it must be one of them: a line
    // whose text and tool call both match counts as a tool_use hit for roles [tool_use], not as a rejected assistant
    // hit. A chance match in base64 gives way to a later match, or to a later part such as the kept tool result.
    let part = null, snippet = '', candidates = 0;
    for (const p of parts) {
      if (roles.size && !roles.has(p.role)) continue;
      for (const [n, at] of matchesIn(raw, lowRaw, p, subs)) { candidates++; if (n !== null && (snippet = grepSnippet(p.text, n, at))) break; }
      if (snippet) { part = p; break; }
    }
    // Else the matches are only inside encoded data; or in parts of other roles; or in what a reader never sees (a
    // thinking signature, encrypted reasoning, image data, an id, the line's cwd or model), and another part's text
    // would be a hit that does not show its match.
    if (!part) { if (candidates) skipped.blob++; else if (parts.some((p) => !matchesIn(raw, lowRaw, p, subs).next().done)) skipped.filtered++; else skipped.outside++; return; }
    const sessionId = place.kind === 'claude' ? obj.sessionId ?? place.sessionId : place.sessionId;
    const key = sessionId ?? file;
    const dup = `${key}\u0000${snippet}`;
    if (seen.has(dup)) return;
    seen.add(dup);
    // A transcript is read oldest line first: past the cap, the oldest hit kept gives way to a newer one, so a long
    // session shows its latest matches, as newest first promises (an untimed hit counts as the oldest).
    const kept = perKey.get(key) ?? [];
    if (kept.length >= perSession) {
      const old = kept.reduce((a, b) => (String(b.ts ?? '') < String(a.ts ?? '') ? b : a));
      skipped.capped++;
      if (String(ts ?? '') <= String(old.ts ?? '')) return;
      kept.splice(kept.indexOf(old), 1); results.splice(results.indexOf(old), 1);
    }
    const hit = { kind: place.kind, sessionId, project: proj, cwd, role: part.role, ...(part.tool ? { tool: part.tool } : {}), ts, path: file, line: ev.data?.line_number ?? null, snippet };
    kept.push(hit); perKey.set(key, kept); results.push(hit);
    if (results.length >= limit) { truncated = true; child.kill('SIGTERM'); }
  };

  let buf = '', chain = Promise.resolve();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line || results.length >= limit) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      chain = chain.then(() => (results.length >= limit ? null : handle(ev))).catch(() => {});
    }
  });
  const code = await new Promise((resolve) => { child.on('close', (c) => resolve(c)); child.on('error', (e) => { notes.push(`rg: ${e.message}`); resolve(-1); }); });
  clearTimeout(timer);
  await chain;
  // 0 = matches, 1 = none; anything else is an error unless we stopped it ourselves.
  if (code !== 0 && code !== 1 && !truncated) notes.push(`rg exited ${code}${stderr.trim() ? `: ${stderr.trim().split('\n').at(-1).slice(0, 200)}` : ''}`);
  // ripgrep stops reading a file at PER_FILE matches, before any filter here: say so rather than look complete.
  if (cappedFiles) { truncated = true; notes.push(`${cappedFiles} file${cappedFiles === 1 ? '' : 's'} hit the ${PER_FILE}-match cap per file; later matches there were not read (narrow the pattern)`); }
  results.sort((a, b) => String(b.ts ?? '').localeCompare(String(a.ts ?? '')));
  return { pattern, results: results.slice(0, limit), matched, skipped, truncated, ms: Date.now() - t0, notes };
}
