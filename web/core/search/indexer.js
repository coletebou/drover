// Keeps this host's search index current. One pass (tick) reads what changed:
//   claude    ~/.claude/projects/<slug>/<session>.jsonl        (appended JSONL: read from the stored offset)
//   subagent  ~/.claude/projects/<slug>/<session>/subagents/*.jsonl
//   codex     ~/.codex/sessions/**/rollout-*.jsonl
//   wal       the truth file (git merge=union can insert lines anywhere: new events are found by id)
//   memory    *.md under every memory home of this machine's identity (memory-homes.conf): re-read whole when changed
//   doc       documents (DEFAULT_DOCS: Codex memories and their dotfiles snapshots, dotfiles specs and docs): re-read
//             whole when changed, one section per # and ## heading
//   reflection  items from the reflections CLI (`reflections export --since`), not a file: one chunk per item
//   preserved   preserved refs from the plugin that keeps them (core/plugins.js search.preserved), not a file: one
//               item per ref, rebuilt only when the plugin's generation changes
// then embeds chunks that have no vector yet, newest first, within a time budget.
// Transcripts also give one keyword-only "command" chunk per run of tool calls (what the agent ran or wrote).
// The daemon runs a tick every minute; the event loop is yielded to often so
// HTTP and SSE stay responsive while a large backfill runs.
import { readdir, stat, open, readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { claudeLine, codexLine, codexAttribute, codexState, PENDING, walEvent, memoryDoc, docSections, reflectionItem, projectOf } from './extract.js';
import { chunkText } from './chunk.js';
import { quantize } from './vec.js';
import { docText, MODEL_ID } from './embed.js';
import { sha1 } from './store.js';
import { KINDS } from './query.js';
import { envvar } from '../envvars.js';
import { reflectionsBin, reflectionsExport } from '../memory.js';
import * as plugins from '../plugins.js';

/**
 * Bump when extraction changes what a transcript yields: every transcript is then read again once, its chunks
 * replaced (vectors are keyed by text, so turns that did not change keep theirs). 1: what was said. 2: commands too.
 * 3: each chunk keeps the checkout its own turn ran in (a Claude line's cwd, a Codex turn_context's), not the session's first.
 * 4: a Codex prompt no turn_context covers waits for the next one, and an <environment_context> cwd counts (codexAttribute).
 */
export const EXTRACT_VERSION = 4;
const TRANSCRIPTS = new Set(['claude', 'subagent', 'codex']);
/** Consecutive tool calls share one command chunk up to about this many characters. */
const COMMAND_CHUNK = 1200;

/** This machine's dotfiles identity (personal or work): DF_IDENTITY, else ~/.df-profile; null when unknown. */
export function dfIdentity(env = process.env) {
  if (env.DF_IDENTITY) return env.DF_IDENTITY;
  try { return readFileSync(path.join(env.HOME ?? '', '.df-profile'), 'utf8').match(/DF_IDENTITY=(\w+)/)?.[1] ?? null; } catch { return null; }
}

/** The source kinds this host indexes: DROVER_SEARCH_KINDS (comma-separated), default all. An archive host sets claude,subagent. */
export function searchKinds(env = process.env) {
  const picked = String(envvar('SEARCH_KINDS', env) ?? '').split(',').map((k) => k.trim()).filter((k) => KINDS.includes(k));
  return new Set(picked.length ? picked : KINDS);
}

/**
 * Documents indexed as kind "doc". {codex} is the Codex home, {dotfiles} the dotfiles checkout, {identity} this
 * machine's identity (a pattern that needs it is dropped while it is unknown); a * matches within one path segment.
 * Everything else under the dotfiles (the other identity's files, generated digests, media) is left out on purpose:
 * it is the other identity's business, or restates what is indexed already.
 */
export const DEFAULT_DOCS = [
  '{codex}/memories/MEMORY.md',
  '{codex}/memories/memory_summary.md',
  '{codex}/memories/rollout_summaries/*.md',
  '{dotfiles}/identities/{identity}/codex/snapshots/*/MEMORY.md',
  '{dotfiles}/identities/{identity}/codex/snapshots/*/memory_summary.md',
  '{dotfiles}/identities/{identity}/*.md',
  '{dotfiles}/specs/*.md',
  '{dotfiles}/docs/*.md',
];

// The dotfiles checkout and the Codex home, resolved one way for the doc patterns and for the indexer's scope:
// docLabel knows a Codex memory by comparing its path with the Codex home its pattern was resolved under.
const dotfilesDir = (env) => envvar('DOTFILES', env) ?? path.join(env.HOME ?? '', '.dotfiles');
const codexHomeDir = (env) => env.CODEX_HOME ?? path.join(env.HOME ?? '', '.codex');

/** The doc patterns, resolved: DROVER_SEARCH_DOCS ('|'-separated, same placeholders; off for none) replaces DEFAULT_DOCS. */
export function docPatterns(env = process.env, identity = dfIdentity(env)) {
  const raw = String(envvar('SEARCH_DOCS', env) ?? '').trim();
  if (/^(off|none|0)$/i.test(raw)) return [];
  const list = raw ? raw.split('|').map((p) => p.trim()).filter(Boolean) : DEFAULT_DOCS;
  const home = env.HOME ?? '';
  const vars = { codex: codexHomeDir(env), dotfiles: dotfilesDir(env), identity };
  return list.filter((p) => identity || !p.includes('{identity}'))
    .map((p) => path.normalize(p.replace(/^~(?=\/|$)/, home).replace(/\{(codex|dotfiles|identity)\}/g, (_, k) => vars[k])));
}

/** A glob (* within one path segment) as an anchored regex over a path or a name. */
const globRe = (glob) => new RegExp(`^${glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);

/** The files a doc pattern matches, walking only the segments that hold a *. Dot-files are never matched. */
async function expandPattern(pattern) {
  const parts = pattern.split('/');
  let bases = [parts[0] === '' ? '/' : parts[0]];
  for (let i = 1; i < parts.length && bases.length; i++) {
    const seg = parts[i], last = i === parts.length - 1, next = [];
    if (!seg.includes('*')) { for (const b of bases) next.push(path.join(b, seg)); }
    else {
      const re = globRe(seg);
      for (const b of bases) {
        for (const e of await readdir(b, { withFileTypes: true }).catch(() => [])) {
          if (!e.name.startsWith('.') && re.test(e.name) && (last ? e.isFile() : e.isDirectory())) next.push(path.join(b, e.name));
        }
      }
    }
    bases = next;
  }
  return bases;
}

/** False for a memory home under the other identity's tree (<dotfiles>/identities/<other>/...). */
export function homeInIdentity(home, { dotfiles, identity }) {
  if (!identity || !dotfiles) return true;
  const root = path.join(dotfiles, 'identities') + path.sep;
  return !home.startsWith(root) || home.slice(root.length).split(path.sep)[0] === identity;
}

/** Codex's own memory files by name, and what their documents are called. */
const CODEX_MEMORY_FILES = new Map([['MEMORY.md', 'Codex memory'], ['memory_summary.md', 'Codex memory summary']]);

/** "Codex memory (<host>)" for Codex's own memory files and their dotfiles snapshots; null for any other document. */
function docLabel(file, codexHome) {
  const what = CODEX_MEMORY_FILES.get(path.basename(file));
  if (!what) return null;
  const snap = file.match(/\/codex\/snapshots\/([^/]+)\/[^/]+$/);
  if (snap) return `${what} (${snap[1]})`;
  return codexHome && path.dirname(file) === path.join(codexHome, 'memories') ? what : null;
}

const yieldNow = () => new Promise((r) => setImmediate(r));
const READ_WINDOW = 4 * 1024 * 1024;
// Each pass re-reads a day of reflections behind its cursor: an item another host wrote keeps that host's
// timestamp, and dotsync can bring it in well after this host's cursor moved past it.
const REFLECTIONS_LOOKBACK_MS = 24 * 3600_000;
const isoSeconds = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');   // the CLI's own format, for --since
const isoTime = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);   // null for no time or an unparsable one

// Sessions that only re-say other sessions: one-shot helper runs in a temp directory (the reflection
// writer, model probes, judges) and known generator prompts that embed other transcripts. Measured on
// 2026-10-15: the reflection writer alone was 34% of a Mac's conversation chunks, all duplicates.
const TEMP_CWD = /^\/(private\/)?(var\/folders|tmp|var\/tmp)\//;
const TEMP_SLUG = /^-(private-)?(var-folders|tmp|var-tmp)-/;
export const DERIVED_PROMPTS = ['You are writing the durable reflection of one AI', 'You are summarizing the state of coding-agent sessions'];
export function skipReason({ cwd, slug, firstUser }, env = process.env) {
  if (/^(0|off|none)$/i.test(String(envvar('SEARCH_SKIP', env) ?? ''))) return null;
  if ((cwd && TEMP_CWD.test(cwd)) || (slug && TEMP_SLUG.test(slug))) return 'temp working directory';
  const extra = String(envvar('SEARCH_SKIP_PROMPTS', env) ?? '').split('|').map((x) => x.trim()).filter(Boolean);
  const head = String(firstUser ?? '').trimStart();
  for (const p of [...DERIVED_PROMPTS, ...extra]) if (head.startsWith(p)) return `generated prompt: ${p.slice(0, 40)}`;
  return null;
}

export function defaultRoots(env = process.env) {
  const home = env.HOME;
  return {
    claude: path.join(env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude'), 'projects'),
    codex: path.join(env.CODEX_HOME ?? path.join(home, '.codex'), 'sessions'),
    wal: envvar('EVENTS', env) ?? path.join(envvar('DOTFILES', env) ?? path.join(home, '.dotfiles'), 'claude', 'drover-events.jsonl'),
    reflections: reflectionsBin(env),
    docs: docPatterns(env),
    // Preserved refs come from the plugin that keeps them (core/plugins.js search.preserved), if one is loaded.
    preserved: async () => (await plugins.preservedSearch()?.preserved?.()) ?? null,
  };
}

/**
 * Every file to index with its kind, newest first. homes: the memory homes ({repo: dir}); scope: { identity, dotfiles }
 * keeps them to this machine's identity; docs: doc patterns (docPatterns()).
 */
export async function listSources(roots, { homes = {}, scope = {}, docs = [] } = {}) {
  const out = [], seen = new Set();
  const add = async (file, kind, extra = {}) => {
    if (seen.has(file)) return;
    try { const s = await stat(file); if (s.isFile()) { seen.add(file); out.push({ path: file, kind, size: s.size, mtime_ms: s.mtimeMs, ino: String(s.ino), ...extra }); } } catch { /* vanished */ }
  };
  if (roots.claude && existsSync(roots.claude)) {
    for (const slug of await readdir(roots.claude).catch(() => [])) {
      const dir = path.join(roots.claude, slug);
      for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (e.isFile() && e.name.endsWith('.jsonl')) await add(path.join(dir, e.name), 'claude', { session_id: e.name.slice(0, -6) });
        else if (e.isDirectory()) {
          const sub = path.join(dir, e.name, 'subagents');
          for (const n of await readdir(sub).catch(() => [])) if (n.endsWith('.jsonl')) await add(path.join(sub, n), 'subagent', { session_id: e.name });
        }
      }
    }
  }
  if (roots.codex && existsSync(roots.codex)) {
    const walk = async (dir, depth) => {
      for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const f = path.join(dir, e.name);
        if (e.isDirectory()) { if (depth < 5) await walk(f, depth + 1); }
        else if (/^rollout-.*\.jsonl$/.test(e.name)) await add(f, 'codex', { session_id: e.name.match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/)?.[1] ?? null });
      }
    };
    await walk(roots.codex, 0);
  }
  if (roots.wal && existsSync(roots.wal)) await add(roots.wal, 'wal');
  for (const [repo, home] of Object.entries(homes ?? {})) {
    if (!home || !existsSync(home) || !homeInIdentity(home, scope)) continue;
    const walk = async (dir, depth) => {
      for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (e.name.startsWith('.')) continue;   // .analysis reports and other generated output
        const f = path.join(dir, e.name);
        if (e.isDirectory()) { if (depth < 3) await walk(f, depth + 1); }
        else if (e.name.endsWith('.md')) await add(f, 'memory', { project: repo });
      }
    };
    await walk(home, 0);
  }
  for (const p of docs) for (const f of await expandPattern(p)) await add(f, 'doc');
  out.sort((a, b) => b.mtime_ms - a.mtime_ms);
  return out;
}

/**
 * The complete lines appended to a file since `offset`, a window at a time:
 * yields { lines, end } where end is the byte offset just after the last full
 * line so far. Works on bytes, so a multi-byte character split across a window
 * boundary is never mis-decoded; a trailing partial line (the writer is mid-line)
 * is left for the next pass.
 */
export async function* readNewLines(file, offset, size, { window = READ_WINDOW } = {}) {
  const fh = await open(file, 'r');
  try {
    let pos = offset, carry = Buffer.alloc(0);
    while (pos < size) {
      const len = Math.min(window, size - pos);
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, pos);
      if (!bytesRead) break;
      pos += bytesRead;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      const cut = data.lastIndexOf(0x0a);
      if (cut < 0) { carry = Buffer.from(data); continue; }
      const lines = data.subarray(0, cut).toString('utf8').split('\n').filter(Boolean);
      carry = Buffer.from(data.subarray(cut + 1));
      yield { lines, end: pos - carry.length };
    }
  } finally { await fh.close(); }
}

export class Indexer {
  /**
   * @param {object} o
   * @param {import('./store.js').Store} o.store
   * @param {import('./embed.js').Embedder | null} o.embedder
   * @param {object} [o.roots] defaultRoots()
   * @param {() => Promise<Record<string,string>>} [o.memoryHomes]
   * @param {number} [o.days] only index sources modified in the last N days (default: everything)
   * @param {string[]} [o.docs] doc patterns (default roots.docs: docPatterns(), DEFAULT_DOCS or DROVER_SEARCH_DOCS)
   * @param {string|null} [o.identity] this machine's identity (default dfIdentity())
   * @param {string[]} [o.kinds] source kinds to index (default searchKinds(): DROVER_SEARCH_KINDS or all)
   */
  constructor({ store, embedder = null, roots = defaultRoots(), memoryHomes, days = null, docs = null, identity, kinds = null, log = () => {}, env = process.env }) {
    this.store = store; this.embedder = embedder; this.roots = roots; this.memoryHomes = memoryHomes; this.days = days; this.log = log; this.env = env;
    this.docs = docs; this.identity = identity; this.kinds = kinds;
    this.scope = null;     // what the last pass covered (#scope)
    this.busy = false;
    this.state = { ticks: 0, lastTick: null, lastMs: null, lastError: null, scanned: 0, readBytes: 0, added: 0, embedded: 0, purged: 0, vectorsDropped: false,
      reflections: { lastRun: null, lastFull: null, full: null, exported: 0, changed: 0, removed: 0, ms: null, lastError: null },
      preserved: { lastRun: null, refs: null, changed: 0, removed: 0, ms: null, lastError: null } };
  }

  /** One pass. budgetMs bounds the embedding part; reading always finishes so keyword search is complete. */
  async tick({ budgetMs = 45_000, embed = true } = {}) {
    if (this.busy) return { skipped: true };
    this.busy = true;
    const t0 = Date.now();
    const run = { scanned: 0, changed: 0, added: 0, embedded: 0, purged: 0, collected: 0 };
    try {
      if (this.embedder && this.store.ensureModel(this.embedder.modelId?.() ?? MODEL_ID)) this.state.vectorsDropped = true;
      const scope = this.scope = this.#scope();
      const homes = this.memoryHomes ? await this.memoryHomes().catch(() => null) : null;
      let list = (await listSources(this.roots, { homes, scope, docs: scope.docs })).filter((s) => scope.kinds.has(s.kind));
      run.purged = this.store.purgeMissing(new Set(list.map((s) => s.path)));
      run.purged += this.#purgeOutOfScope(scope, homes);
      // Reflections first: one quick export, so they are searchable after the first pass even while a large
      // transcript backfill is still reading (and a transcript that fails to read does not keep them out).
      if (this.roots.reflections && scope.kinds.has('reflection')) run.added += await this.#indexReflections();
      if (this.roots.preserved && scope.kinds.has('preserved')) run.added += await this.#indexPreserved();
      if (this.days) { const cut = Date.now() - this.days * 86400_000; list = list.filter((s) => s.mtime_ms >= cut || s.kind === 'wal'); }
      let lastYield = Date.now();
      for (const src of list) {
        run.scanned++;
        const prev = this.store.source(src.path);
        // A transcript read by an older extractor is read again once, even though the file did not change.
        const stale = Boolean(prev && TRANSCRIPTS.has(src.kind) && !prev.skipped && (prev.xv ?? 1) < EXTRACT_VERSION);
        if (prev && !stale && prev.size === src.size && prev.mtime_ms === src.mtime_ms && prev.ino === src.ino) continue;
        run.changed++;
        run.added += await this.#indexSource(src, prev);
        if (Date.now() - lastYield > 40) { await yieldNow(); lastYield = Date.now(); }
      }
      if (this.store.dirty) run.collected = this.store.gcVectors();
      if (embed && this.embedder?.installed()) run.embedded = await this.#embedPending(t0 + budgetMs);
      this.state.lastError = null;
    } catch (e) {
      this.state.lastError = String(e.message ?? e).slice(0, 300);
      this.log(`search index tick failed: ${this.state.lastError}`);
    } finally {
      this.busy = false;
      this.state.ticks++; this.state.lastTick = new Date().toISOString(); this.state.lastMs = Date.now() - t0;
      this.state.scanned = run.scanned; this.state.added += run.added; this.state.embedded += run.embedded; this.state.purged += run.purged;
    }
    return { ...run, ms: Date.now() - t0 };
  }

  /** What this pass covers: source kinds, this machine's identity, the dotfiles and Codex homes, the doc patterns. */
  #scope() {
    const env = this.env;
    const kinds = this.kinds ? new Set(this.kinds) : searchKinds(env);
    const identity = this.identity !== undefined ? this.identity : dfIdentity(env);
    const docs = kinds.has('doc') ? (this.docs ?? this.roots.docs ?? []) : [];
    return { kinds, identity, dotfiles: dotfilesDir(env), codexHome: codexHomeDir(env), docs };
  }

  /**
   * Forget what this host no longer covers: kinds DROVER_SEARCH_KINDS turned off, memory homes of the other identity
   * or no longer in memory-homes.conf, documents no doc pattern matches. Decided from the paths alone, never from a
   * listing (a listing that failed must not look like a deleted tree), and an unreadable or empty memory-homes.conf
   * purges no memory.
   */
  #purgeOutOfScope(scope, homes) {
    const held = (k) => (k === 'reflection' ? this.store.reflectionStates().size > 0 : k === 'preserved' ? this.store.preservedStates().size > 0 : this.store.sourcesOfKind(k).length > 0);
    let n = this.store.purgeKinds(KINDS.filter((k) => !scope.kinds.has(k) && held(k)));
    if (homes && Object.keys(homes).length) {
      const dirs = Object.values(homes).filter((h) => h && homeInIdentity(h, scope)).map((h) => h.replace(/\/+$/, '') + path.sep);
      for (const s of this.store.sourcesOfKind('memory')) if (!dirs.some((d) => s.path.startsWith(d))) { this.store.purgeSource(s.path); n++; }
    }
    const docRes = scope.docs.map(globRe);
    for (const s of this.store.sourcesOfKind('doc')) if (!docRes.some((re) => re.test(s.path))) { this.store.purgeSource(s.path); n++; }
    return n;
  }

  async #indexSource(src, prev) {
    if (src.kind === 'memory') return this.#indexMemory(src);
    if (src.kind === 'doc') return this.#indexDoc(src);
    if (src.kind === 'wal') return this.#indexWal(src);
    const xv = EXTRACT_VERSION;
    // A skipped session stays skipped; only its read position moves, nothing is parsed.
    if (prev?.skipped && src.size >= prev.offset && prev.ino === src.ino) { this.store.upsertSource({ ...src, ...prev, size: src.size, mtime_ms: src.mtime_ms, offset: src.size, decided: true, xv }); return 0; }
    const slug = path.basename(path.dirname(src.kind === 'subagent' ? path.dirname(path.dirname(src.path)) : src.path));
    // A subagent of a skipped session is skipped with it (its own first prompt is the subagent's task, not the generator's).
    const parentSkip = src.kind === 'subagent' ? this.store.source(path.join(path.dirname(path.dirname(path.dirname(src.path))), `${src.session_id}.jsonl`))?.skipped : null;
    const early = skipReason({ slug }, this.env) ?? (parentSkip ? `parent session skipped: ${parentSkip}` : null);
    if (early) { this.store.purgeSource(src.path); this.store.upsertSource({ ...src, offset: src.size, skipped: early, decided: true, xv }); return 0; }
    // Appended JSONL. A shrunk or replaced file is read again from the start, and so is one an older extractor read.
    let offset = prev?.offset ?? 0;
    // meta.cwd is the session's first working directory (its skip decision and label); last_cwd the one in effect where
    // reading stopped and cwd_state the rest of a Codex reader's attribution state there (extract.js codexAttribute),
    // so the next pass, and the next window, carry on exactly where this one stopped.
    let meta = { session_id: prev?.session_id ?? src.session_id, title: prev?.title ?? null, cwd: prev?.cwd ?? null, project: prev?.project ?? null, last_cwd: prev?.last_cwd ?? null, cwd_state: prev?.cwd_state ?? null };
    let decided = Boolean(prev?.decided);
    const replaced = Boolean(prev && (src.size < prev.offset || (prev.ino && prev.ino !== src.ino)));
    if (replaced) { this.store.purgeSource(src.path); offset = 0; meta = { session_id: src.session_id, title: null, cwd: null, project: null, last_cwd: null, cwd_state: null }; decided = false; }
    // The same file under a newer extractor keeps its title, directory and skip decision: its chunks come back with the
    // title their vectors were made with, so no retitle drops those vectors and nothing is embedded twice.
    else if (prev && (prev.xv ?? 1) < xv) { this.store.purgeSource(src.path); offset = 0; meta.last_cwd = null; meta.cwd_state = null; }
    const parse = src.kind === 'codex' ? codexLine : claudeLine;
    const codex = src.kind === 'codex';
    let att = null;
    if (codex) { let saved = null; try { saved = JSON.parse(meta.cwd_state ?? 'null'); } catch { /* unreadable: as if none */ } att = codexState(meta.last_cwd, saved); }
    const keep = () => { if (att) { meta.last_cwd = att.cwd; meta.cwd_state = JSON.stringify({ ctx: att.ctx, pending: att.pending }); } };
    let n = 0, firstUser = null, end = offset, skipped = null;
    // One transaction per window, and the read position saved after each, so a
    // 100 MB transcript neither sits in memory whole nor holds the event loop.
    for await (const win of readNewLines(src.path, offset, src.size)) {
      const rows = [];
      // A run of consecutive tool calls is one command chunk (keyword-only, see store.js KEYWORD_ONLY): a session runs
      // hundreds of commands, and a row each would multiply the index for no better match.
      let cmd = null;
      const flush = () => { if (cmd) rows.push({ path: src.path, kind: src.kind, role: 'command', ts: cmd.ts, text: cmd.lines.join('\n'), ref: cmd.ref, cwd: cmd.cwd }); cmd = null; };
      for (const line of win.lines) {
        const r = parse(line);
        if (!r) continue;
        if (r.title) meta.title = r.title;
        if (r.cwd && !meta.cwd) { meta.cwd = r.cwd; meta.project = projectOf(r.cwd); }
        if (r.sessionId && !meta.session_id) meta.session_id = r.sessionId;
        // The checkout this line's words were said in: a Claude line names its own (none: unknown, never borrowed from
        // another line); a Codex item's comes from the turn_context that covers it, or waits for the next (PENDING).
        let cwd = r.cwd ?? null;
        if (codex) {
          const a = codexAttribute(att, r);
          if (a.resolve !== undefined) {
            // The pending run is settled: in this window's rows (not stored yet) and in what earlier windows and passes stored.
            flush();
            for (const row of rows) if (row.cwd === PENDING) row.cwd = a.resolve;
            this.store.settlePending(src.path, a.resolve);
          }
          cwd = a.cwd;
        }
        for (const u of r.units) {
          if (u.role === 'command') {
            if (cmd && (cmd.len + u.text.length + 1 > COMMAND_CHUNK || cmd.cwd !== cwd)) flush();
            cmd ??= { lines: [], len: 0, ts: r.ts, ref: r.uuid ?? null, cwd };
            cmd.lines.push(u.text); cmd.len += u.text.length + 1;
            continue;
          }
          flush();
          if (!firstUser && u.role === 'user') firstUser = u.text;
          for (const text of chunkText(u.text)) rows.push({ path: src.path, kind: src.kind, role: u.role, ts: r.ts, text, ref: r.uuid ?? null, cwd });
        }
      }
      flush();
      if (!meta.title && firstUser) meta.title = firstUser.replace(/\s+/g, ' ').slice(0, 120);
      // Decide once the first user turn (or the working directory) is known, on whichever pass that is.
      if (!decided) { skipped = skipReason({ cwd: meta.cwd, firstUser }, this.env); decided = Boolean(firstUser || skipped); }
      if (skipped) {
        this.store.purgeSource(src.path); n = 0; end = win.end;
        if (src.kind === 'claude') this.store.skipUnder(path.join(path.dirname(src.path), path.basename(src.path, '.jsonl'), 'subagents') + path.sep, `parent session skipped: ${skipped}`);
        this.store.upsertSource({ ...src, ...meta, size: -1, offset: end, skipped, decided: true, xv }); await yieldNow(); continue;
      }
      for (const row of rows) { row.title = meta.title; row.project = meta.project; row.session_id = meta.session_id; if (row.cwd === PENDING) { row.cwd = null; row.pending = true; } }
      keep();
      n += this.store.addChunks(rows);
      this.state.readBytes += win.end - end;
      end = win.end;
      // size -1 = still reading: a pass that stops here (crash, restart) resumes from `offset` instead of skipping the rest.
      this.store.upsertSource({ ...src, ...meta, size: -1, offset: end, decided, xv });
      await yieldNow();
    }
    // A title that arrived after earlier chunks were indexed (ai-title, or the first prompt) is applied to them too.
    // A replaced file's chunks all come from this pass, so its old title says nothing about theirs.
    if (!skipped && meta.title && (replaced || meta.title !== prev?.title)) this.store.retitle(src.path, meta.title);
    this.store.upsertSource({ ...src, ...meta, offset: end, skipped, decided, xv });
    return n;
  }

  /** A document: re-read whole, one section per # and ## heading, each section chunked under its own title. */
  async #indexDoc(src) {
    // Read before purging: a file that cannot be read now keeps what was indexed, and with no source update the next
    // pass tries again (an empty read recorded as indexed would hide the document until it next changed).
    const raw = await readFile(src.path, 'utf8').catch((e) => { this.log(`search: ${src.path} not read: ${e.code ?? e.message}`); return null; });
    if (raw == null) return 0;
    this.store.purgeSource(src.path);
    this.state.readBytes += Buffer.byteLength(raw);
    const st = await stat(src.path).catch(() => null);
    const name = path.basename(src.path);
    const doc = docSections(raw, name, { label: docLabel(src.path, this.scope?.codexHome) });
    // Dated by when it says it was written (a rollout summary's updated_at), else by its mtime.
    const ts = isoTime(Date.parse(doc.ts ?? '')) ?? isoTime(st?.mtimeMs);
    const rows = doc.sections.flatMap((s) => chunkText(s.text).map((text) => ({ path: src.path, kind: 'doc', session_id: doc.sessionId, project: s.project, role: 'doc', ts, title: s.title, text, ref: name })));
    const n = this.store.addChunks(rows);
    // No source title: each section keeps its own (search and the embedder prefer a source's title when it has one).
    this.store.upsertSource({ ...src, session_id: doc.sessionId, title: null, offset: src.size });
    return n;
  }

  async #indexMemory(src) {
    const raw = await readFile(src.path, 'utf8').catch((e) => { this.log(`search: ${src.path} not read: ${e.code ?? e.message}`); return null; });
    if (raw == null) return 0;   // as for documents: keep what was indexed and try again next pass
    this.store.purgeSource(src.path);
    this.state.readBytes += Buffer.byteLength(raw);
    const doc = memoryDoc(raw, path.basename(src.path));
    const st = await stat(src.path).catch(() => null);
    const ts = st ? new Date(st.mtimeMs).toISOString() : null;
    const rows = chunkText(doc.text).map((text) => ({ path: src.path, kind: 'memory', session_id: null, project: src.project ?? null, role: 'memory', ts, title: doc.title, text, ref: path.basename(src.path) }));
    const n = this.store.addChunks(rows);
    this.store.upsertSource({ ...src, title: doc.title, offset: src.size });
    return n;
  }

  async #indexWal(src) {
    const raw = await readFile(src.path, 'utf8').catch(() => '');
    this.state.readBytes += Buffer.byteLength(raw);
    // The whole file is scanned (merge=union can insert lines anywhere), but a line whose id was
    // already indexed is skipped on a regex before any JSON parse, and the loop yields as it goes.
    const rows = [], seen = [], known = this.store.walSeenIds();
    let lineNo = 0;
    for (const line of raw.split('\n')) {
      if (++lineNo % 2000 === 0) await yieldNow();
      if (!line || line[0] !== '{') continue;
      const id = line.match(/"id":"([^"\\]+)"/)?.[1];
      if (id && known.has(id)) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      if (!ev?.id || known.has(ev.id)) continue;
      known.add(ev.id); seen.push(ev.id);
      const u = walEvent(ev);
      if (!u) continue;
      // A survey item about a derived session (the reflection writer, a probe) is as much a copy as the session.
      if (ev.type === 'survey-item' && skipReason({ cwd: ev.item?.cwd, firstUser: ev.item?.title }, this.env)) continue;
      for (const text of chunkText(u.text)) rows.push({ path: src.path, kind: 'wal', session_id: u.sessionId, project: null, role: u.role, ts: u.ts, title: u.title, text, ref: u.id });
    }
    const n = this.store.addChunks(rows);
    this.store.markWal(seen);
    this.store.upsertSource({ ...src, offset: src.size });
    return n;
  }

  /**
   * Reflections come from the reflections CLI: `reflections export --since` each pass (a day behind the cursor, see
   * REFLECTIONS_LOOKBACK_MS), and every item once per UTC day, because a derived `stale` status changes with the clock
   * rather than with an event. One chunk per item at path reflection:<id> holds the title, body and tags; status,
   * kind and repo sit beside it in the reflections table, so closing an item never re-embeds it. The export keeps to
   * this machine's identity (the CLI's default), so a personal box never indexes work items or the other way round.
   * A missing or failing CLI, or a failure while storing, is logged (once per distinct error) and skipped: it never
   * fails the pass or moves the cursor, so the next pass tries again from the same place.
   */
  async #indexReflections() {
    const st = this.state.reflections;
    try { return await this.#reflectionsPass(st); }
    catch (e) {
      const msg = String(e.message ?? e).slice(0, 300);
      if (msg !== st.lastError) this.log(`search: reflections skipped: ${msg}`);
      st.lastError = msg;
      return 0;
    }
  }

  async #reflectionsPass(st) {
    const t0 = Date.now();
    const day = new Date(t0).toISOString().slice(0, 10);
    const full = this.store.getMeta('reflections_day') !== day;
    const cursor = Date.parse(this.store.getMeta('reflections_since') ?? '');
    const since = full || !Number.isFinite(cursor) ? undefined : isoSeconds(cursor - REFLECTIONS_LOOKBACK_MS);
    const items = await reflectionsExport({ since, bin: this.roots.reflections });
    const known = this.store.reflectionStates();
    const seen = new Set(), changes = [];
    for (const it of items) {
      const doc = reflectionItem(it);
      if (!doc || seen.has(doc.id)) continue;
      seen.add(doc.id);
      const hash = sha1(doc.text), prev = known.get(doc.id);
      if (prev && prev.hash === hash && prev.status === doc.status && prev.kind === doc.role && prev.repo === doc.project
        && prev.origin === doc.origin && prev.session_id === doc.sessionId && prev.updated_at === doc.ts
        && (prev.host ?? null) === doc.host && (prev.checkout ?? null) === doc.checkout) continue;
      changes.push({ ...doc, hash, textChanged: prev?.hash !== hash });
    }
    // A full export is the whole store, so what it lacks is gone. An empty one while the index holds reflections
    // reads as a broken CLI environment rather than an emptied store: nothing is dropped then.
    const gone = full && seen.size ? [...known.keys()].filter((id) => !seen.has(id)) : [];
    if (gone.length) this.store.dropReflections(gone);
    for (let i = 0; i < changes.length; i += 500) { this.store.upsertReflections(changes.slice(i, i + 500)); await yieldNow(); }
    if (full) this.store.setMeta('reflections_day', day);
    this.store.setMeta('reflections_since', new Date(t0).toISOString());
    Object.assign(st, { lastRun: new Date().toISOString(), full, exported: items.length, changed: changes.length, removed: gone.length, ms: Date.now() - t0, lastError: null });
    if (full) st.lastFull = st.lastRun;
    return changes.filter((c) => c.textChanged).length;
  }

  /**
   * Preserved refs come from the plugin that keeps them (roots.preserved: core/plugins.js search.preserved). No
   * source (no such plugin, or it has nothing here) forgets what was indexed; an unchanged generation costs one
   * for-each-ref. Each ref is one item at path preserved:<ref> whose chunks are replaced only when its text changed,
   * so an unchanged ref keeps its vector. A failure is logged once per distinct error and changes nothing.
   */
  async #indexPreserved() {
    const st = this.state.preserved;
    const t0 = Date.now();
    try {
      const src = await this.roots.preserved();
      if (!src) {
        const held = [...this.store.preservedStates().keys()];
        if (held.length) this.store.dropPreserved(held);
        this.store.setMeta('preserved_gen', '');
        Object.assign(st, { lastRun: new Date().toISOString(), refs: 0, changed: 0, removed: held.length, ms: Date.now() - t0, lastError: null });
        return 0;
      }
      if (this.store.getMeta('preserved_gen') === src.generation) return 0;
      const docs = await src.build();
      const known = this.store.preservedStates();
      const seen = new Set(), changes = [];
      for (const d of docs) {
        if (!d?.ref || seen.has(d.ref)) continue;
        seen.add(d.ref);
        // The plugin hands the text over redacted where it is free text; names are kept whole on purpose.
        const text = String(d.text ?? '').trim();
        if (!text) continue;
        const hash = sha1(text), prev = known.get(d.ref);
        if (prev && prev.hash === hash && prev.sha === d.sha) continue;
        changes.push({ ref: d.ref, sha: d.sha, hash, textChanged: prev?.hash !== hash, chunks: chunkText(text).map((t) => ({ text: t, title: d.title, ts: d.ts, role: d.role, project: d.project })) });
      }
      const gone = [...known.keys()].filter((r) => !seen.has(r));
      if (gone.length) this.store.dropPreserved(gone);
      let added = 0;
      for (let i = 0; i < changes.length; i += 300) { added += this.store.upsertPreserved(changes.slice(i, i + 300)); await yieldNow(); }
      this.store.setMeta('preserved_gen', src.generation);
      Object.assign(st, { lastRun: new Date().toISOString(), refs: seen.size, changed: changes.length, removed: gone.length, ms: Date.now() - t0, lastError: null });
      return added;
    } catch (e) {
      const msg = String(e.message ?? e).slice(0, 300);
      if (msg !== st.lastError) this.log(`search: preserved refs skipped: ${msg}`);
      st.lastError = msg;
      return 0;
    }
  }

  async #embedPending(deadline) {
    let done = 0;
    const step = this.embedder.batch ?? 16;
    while (Date.now() < deadline) {
      const batch = this.store.pending(64);
      if (!batch.length) break;
      for (let i = 0; i < batch.length && Date.now() < deadline; i += step) {
        done += await this.#embedPart(batch.slice(i, i + step));
        await yieldNow();
      }
    }
    return done;
  }

  /**
   * Embed one request's worth. If the request fails after the embedder's own retries,
   * each item is tried alone, and an item that still fails is marked so one bad input
   * can never stall the backfill. If even a single item cannot be embedded because the
   * runtime is down, the error propagates and the pass ends (nothing is marked).
   */
  async #embedPart(part) {
    const save = (items, vecs) => this.store.addVectors(items.map((p, j) => { const { q, scale } = quantize(vecs[j]); return { hash: p.hash, q, scale }; }));
    try { save(part, await this.embedder.embed(part.map((p) => docText(p.title, p.text)))); return part.length; }
    catch (e) {
      if (part.length === 1 && !/HTTP 4\d\d|HTTP 5\d\d|vectors for/.test(e.message)) throw e;
      let n = 0;
      for (const p of part) {
        try { save([p], await this.embedder.embed([docText(p.title, p.text)])); n++; }
        catch (e1) {
          if (!/HTTP 4\d\d|HTTP 5\d\d|vectors for/.test(e1.message)) throw e1;   // the runtime, not this input
          this.store.markEmbedFailed(p.hash, e1.message);
          this.log(`search: chunk ${p.hash.slice(0, 10)} skipped: ${e1.message}`);
        }
      }
      return n;
    }
  }

  status() {
    const s = this.scope;
    const scope = s ? { kinds: [...s.kinds], identity: s.identity, docs: s.docs, extractVersion: EXTRACT_VERSION } : null;
    return { ...this.state, busy: this.busy, days: this.days, roots: this.roots, scope, pending: this.store.pendingCount() };
  }
}
