// Prompts: every prompt typed into a Claude Code or Codex session on this machine, verbatim (secrets redacted), kept
// in an append-only local spool and pushed to the sinks the prompts config names (core/prompt-sinks.js). The contract
// is docs/specs/2026-11-21-cohesion-overhaul.md, "Prompts: the spool"; tests: test/prompts.test.js, prompts-sink.test.js.
//
// One pass (Collector.scan) reads what each transcript gained since the last pass, by byte offset per file
// ($STATE/prompts-offsets.json), the way the search indexer does (search/indexer.js listSources, readNewLines):
//   claude  ~/.claude/projects/<slug>/<session>.jsonl   (never <session>/subagents/: a subagent's prompt is its parent's)
//   codex   ~/.codex/sessions/**/rollout-*.jsonl        (never a subagent thread: session_meta source.subagent)
// "A user turn's own words" is search/extract.js's: userText (reminders stripped, peer envelopes unwrapped, Claude
// Code bookkeeping dropped), tidy (escapes gone, secrets redacted), codexLine (Codex's injected blocks dropped), and
// claude-queued.js for a message that reached a busy session. Sessions the index skips are skipped here too
// (indexer.js skipReason: temp working directories, generated prompts).
//
// Each prompt is one record (one JSON line) in $STATE/prompts/<YYYY-MM-DD>.jsonl, by its own timestamp's UTC day,
// mode 0600, only ever appended. Its id hashes where and what it was, so a re-read or a second copy of a transcript is
// one record. via says where it came from:
//   typed     a person at the agent's prompt
//   queued    typed while a turn ran (Claude Code writes it as a queued_command attachment, or promptSource queued)
//   peer      a <cross-session-message> from another session
//   drover    sent through Drover: a Claude inbox message Drover relayed (from "drover (<actor>)"), or text that a
//             `message` event in the truth file sent to this host within MESSAGE_WINDOW_MS (tmux.send, a Codex turn)
//   headless  the prompt a headless launch started with (a `launch` event, mode headless); a tmux launch's is drover
//   sdk       a program's run (claude -p / the Agent SDK, codex exec) that no Drover launch started
// "Mine" (the default of prompts.list) is typed, queued, drover and headless.
import { readdir, stat, readFile, writeFile, appendFile, mkdir, rename, chmod } from 'node:fs/promises';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { userText, tidy, codexLine, projectOf } from './search/extract.js';
import { queuedMessage, peerSender } from './claude-queued.js';
import { listSources, readNewLines, skipReason, dfIdentity, defaultRoots } from './search/indexer.js';
import { stateDir } from './paths.js';
import { envvar } from './envvars.js';
import { localShortName } from './hosts.js';
import * as events from './events.js';
import { daemonEndpoint, callDaemon } from './daemon-client.js';
import { loadConfig, Sinks, cloneHostDirs } from './prompt-sinks.js';

export const VIA = ['typed', 'queued', 'peer', 'drover', 'headless', 'sdk'];
export const MINE = ['typed', 'queued', 'drover', 'headless'];
export const ENGINES = ['claude', 'codex'];
export const LIMIT = 200, MAX_LIMIT = 2000;
/** A `message` event counts for a prompt within this of its time, either side (clocks, delivery, the paste). */
export const MESSAGE_WINDOW_MS = 5 * 60_000;
/** A launch prompt reaches the transcript once the agent has started: up to this long after the launch event. */
export const LAUNCH_WINDOW_MS = 15 * 60_000;

const log = (m) => console.log(`[prompts] ${m}`);
const yieldNow = () => new Promise((r) => setImmediate(r));

/** Off with DROVER_PROMPTS=off; off under node --test unless a test turns it on (no test ever reads real transcripts). */
export function enabled(env = process.env) {
  const v = String(envvar('PROMPTS', env) ?? '');
  if (/^(0|off|false|no)$/i.test(v)) return false;
  return !(env.NODE_TEST_CONTEXT && !/^(1|on|true|yes)$/i.test(v));
}
export const spoolDir = (env = process.env) => path.join(stateDir(env), 'prompts');
export const offsetsPath = (env = process.env) => path.join(stateDir(env), 'prompts-offsets.json');

/** p_ + 16 hex of sha1(host, engine, session, the transcript line's uuid or ts, text). */
export function promptId({ host, engine, session, ref, text }) {
  return `p_${createHash('sha1').update([host, engine, session ?? '', ref ?? '', text].join('\0')).digest('hex').slice(0, 16)}`;
}

const isoOf = (ts) => { const ms = typeof ts === 'number' ? ts : Date.parse(ts ?? ''); return Number.isFinite(ms) ? new Date(ms).toISOString() : null; };
const homeOf = (env) => String(env.HOME ?? '').replace(/\/+$/, '');
const tilde = (p, home) => (p && home && (p === home || p.startsWith(home + '/')) ? `~${p.slice(home.length)}` : p ?? null);
const untilde = (p, home) => (typeof p === 'string' && (p === '~' || p.startsWith('~/')) ? home + p.slice(1) : p);

// ---------------------------------------------------------------- what one transcript line says

const PEER_HEAD = /^\s*<cross-session-message\b/;
const PEER_ATTRS = /<cross-session-message\b([^>]*)>/;
const attr = (attrs, name) => attrs.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))?.[1] ?? null;
// Turns Claude Code starts itself: a background task's notice, a /loop or scheduled wake-up, its own system turns.
const MACHINE_ORIGINS = new Set(['task_notification', 'scheduled', 'system', 'auto_continuation']);

/**
 * One Claude Code transcript line -> null (not a user line), or { ts, ref, cwd, sessionId, prompt } where prompt is
 * null (a user line that is no prompt: a tool result, a compaction summary, bookkeeping) or { via, from, text }.
 * Lines that cannot be a prompt are rejected before they are parsed: a tool result (toolUseResult) is most of a
 * transcript's bytes. A peer message to an idle session is a meta user line (turnOrigin peer); every other meta line
 * (skill text, caveats) is no prompt.
 */
export function claudePrompt(line) {
  if (!line || line[0] !== '{') return null;
  if (!line.includes('"type":"user"') && !line.includes('"queued_command"')) return null;
  if (line.includes('"toolUseResult":')) return null;
  let d; try { d = JSON.parse(line); } catch { return null; }
  if (d?.type !== 'user' && d?.type !== 'attachment') return null;
  const out = { ts: d.timestamp ?? null, ref: d.uuid ?? null, cwd: typeof d.cwd === 'string' && d.cwd ? d.cwd : null, sessionId: d.sessionId ?? null, prompt: null };
  if (d.isSidechain) return out;
  if (d.type === 'attachment') {
    const q = queuedMessage(d);
    if (!q || q.kind === 'coordinator') return out;
    const text = tidy(userText(q.text));
    if (text) out.prompt = { via: q.via, from: q.from ?? null, text };
    return out;
  }
  if (d.isCompactSummary || d.isVisibleInTranscriptOnly) return out;
  const origin = typeof d.turnOrigin === 'string' ? d.turnOrigin : null;
  if (origin && MACHINE_ORIGINS.has(origin)) return out;
  const c = d.message?.content;
  const raw = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n') : '';
  if (!raw.trim()) return out;
  const peer = origin === 'peer' || PEER_HEAD.test(raw);
  if (!peer && (d.isMeta || d.promptSource === 'system')) return out;
  const text = tidy(userText(raw));
  if (!text) return out;
  if (peer) {
    const a = raw.match(PEER_ATTRS)?.[1] ?? '';
    const who = peerSender({ kind: 'peer', name: attr(a, 'from-name') ?? attr(a, 'from'), body: '' });
    out.prompt = { via: who?.via ?? 'peer', from: who?.from ?? null, text };
  } else {
    const sdk = origin === 'sdk' || d.promptSource === 'sdk' || /^sdk/.test(String(d.entrypoint ?? ''));
    out.prompt = { via: d.promptSource === 'queued' ? 'queued' : sdk ? 'sdk' : 'typed', from: null, text };
  }
  return out;
}

/**
 * One Codex rollout line, with the file's state st ({ cwd, session, source, skipped, decided }) carried across lines:
 * session_meta sets the session, its cwd and where it came from (a subagent thread is skipped whole, a codex exec run is
 * sdk), turn_context and an <environment_context> move the cwd. Returns null, or { ts, ref, cwd, sessionId, prompt }
 * for a user turn with words (codexLine decides which those are).
 */
export function codexPrompt(line, st) {
  if (!line || line[0] !== '{') return null;
  if (line.includes('"type":"session_meta"')) {
    let d; try { d = JSON.parse(line); } catch { return null; }
    if (d?.type !== 'session_meta') return null;
    const p = d.payload ?? {};
    st.session = p.id ?? p.session_id ?? st.session ?? null;
    if (typeof p.cwd === 'string' && p.cwd) st.cwd = p.cwd;
    const src = p.source;
    st.source = typeof src === 'string' ? src : src && typeof src === 'object' ? Object.keys(src)[0] ?? null : null;
    if (st.source === 'subagent') { st.skipped = 'subagent thread'; st.decided = true; }
    return null;
  }
  if (!line.includes('"type":"turn_context"') && !(line.includes('"type":"response_item"') && line.includes('"role":"user"'))) return null;
  const r = codexLine(line);
  if (!r) return null;
  if (r.mark === 'context' && r.cwd) st.cwd = r.cwd;
  if (r.mark === 'env' && r.envCwd) st.cwd = r.envCwd;
  if (r.mark !== 'prompt') return null;
  const text = r.units.find((u) => u.role === 'user')?.text;
  if (!text) return null;
  return { ts: r.ts, ref: null, cwd: st.cwd ?? null, sessionId: st.session ?? null, prompt: { via: st.source === 'exec' ? 'sdk' : 'typed', from: null, text } };
}

// ---------------------------------------------------------------- labels

const globRe = (g) => new RegExp(`^${g.split(/(\*\*|\*)/).map((p) => (p === '**' ? '.*' : p === '*' ? '[^/]*' : p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))).join('').replace(/\/+$/, '')}(?:/.*)?$`);

/** The git remotes' URLs of a repository root (.git a directory, or a worktree's .git file), read from its config: no git run. */
export function repoRemotes(root) {
  try {
    let gitDir = path.join(root, '.git');
    if (statSync(gitDir).isFile()) {
      const m = readFileSync(gitDir, 'utf8').match(/^gitdir:\s*(.+?)\s*$/m);
      if (!m) return [];
      gitDir = path.resolve(root, m[1]);
      const common = path.join(gitDir, 'commondir');
      if (existsSync(common)) gitDir = path.resolve(gitDir, readFileSync(common, 'utf8').trim());
    }
    const cfg = readFileSync(path.join(gitDir, 'config'), 'utf8');
    const urls = [];
    let inRemote = false, origin = false;
    for (const line of cfg.split('\n')) {
      const sec = line.match(/^\s*\[\s*([^\]\s"]+)(?:\s+"([^"]*)")?\s*\]/);
      if (sec) { inRemote = sec[1].toLowerCase() === 'remote'; origin = sec[2] === 'origin'; continue; }
      const u = inRemote ? line.match(/^\s*url\s*=\s*(.+?)\s*$/i) : null;
      if (u) { if (origin) urls.unshift(u[1]); else urls.push(u[1]); }
    }
    return urls;
  } catch { return []; }
}

/**
 * label for a working directory: the first cwd rule whose glob matches it (a leading ~ is the home; * stays in one
 * path segment, ** crosses them; a directory under a match matches), else the first remote rule whose regular
 * expression matches a git remote URL of the cwd's repository, else this machine's DF_IDENTITY, else 'default'.
 * Repository roots and their remotes are cached (per directory and per root): a prompt never runs git.
 */
export class Labeler {
  constructor({ rules = [], identity = null, home = '' } = {}) {
    this.cwdRules = []; this.remoteRules = []; this.errors = [];
    for (const r of Array.isArray(rules) ? rules : []) {
      if (!r || typeof r.label !== 'string' || !r.label.trim()) { this.errors.push('a rule needs a label'); continue; }
      if (typeof r.cwd === 'string' && r.cwd) this.cwdRules.push({ re: globRe(untilde(r.cwd, home)), label: r.label });
      else if (typeof r.remote === 'string' && r.remote) {
        try { this.remoteRules.push({ re: new RegExp(r.remote), label: r.label }); } catch (e) { this.errors.push(`remote ${JSON.stringify(r.remote)}: ${e.message}`); }
      } else this.errors.push(`rule for ${r.label} names no cwd or remote`);
    }
    this.fallback = identity || 'default';
    this.roots = new Map(); this.remotes = new Map(); this.memo = new Map();
  }
  label(cwd) {
    if (!cwd) return this.fallback;
    const hit = this.memo.get(cwd);
    if (hit) return hit;
    let label = this.cwdRules.find((r) => r.re.test(cwd))?.label;
    if (!label && this.remoteRules.length) {
      const root = this.repoRoot(cwd);
      const urls = root ? this.remotesOf(root) : [];
      label = this.remoteRules.find((r) => urls.some((u) => r.re.test(u)))?.label;
    }
    label ??= this.fallback;
    if (this.memo.size > 20_000) this.memo.clear();
    this.memo.set(cwd, label);
    return label;
  }
  repoRoot(dir) {
    const walked = [];
    let d = dir, root = null;
    for (let i = 0; i < 64; i++) {
      if (this.roots.has(d)) { root = this.roots.get(d); break; }
      walked.push(d);
      if (existsSync(path.join(d, '.git'))) { root = d; break; }
      const up = path.dirname(d);
      if (up === d) break;
      d = up;
    }
    if (this.roots.size > 20_000) this.roots.clear();
    for (const w of walked) this.roots.set(w, root);
    return root;
  }
  remotesOf(root) {
    if (!this.remotes.has(root)) this.remotes.set(root, repoRemotes(root));
    return this.remotes.get(root);
  }
}

// ---------------------------------------------------------------- what Drover sent (the truth file)

const matchKey = (s) => tidy(String(s ?? '')).replace(/\s+/g, ' ').trim().slice(0, 1500);

/** The truth file's `message` and `launch` events for this host, by their text: which prompts Drover sent. */
export class TruthIndex {
  constructor({ file = events.EVENTS_PATH, host } = {}) { this.file = file; this.host = host; this.map = new Map(); this.sig = null; }
  async refresh() {
    const all = await events.readAll(this.file).catch(() => null);
    if (!all) return;
    const sig = `${all.length}|${all.at(-1)?.id ?? ''}`;
    if (sig === this.sig) return;
    this.sig = sig;
    const map = new Map();
    const add = (text, e) => { const k = matchKey(text); if (!k) return; let l = map.get(k); if (!l) map.set(k, (l = [])); l.push(e); };
    for (const ev of all) {
      const ms = Date.parse(ev?.ts ?? '');
      if (!Number.isFinite(ms)) continue;
      if (ev.type === 'message' && typeof ev.text === 'string' && ev.delivery?.ok !== false && (!ev.to?.host || ev.to.host === this.host)) add(ev.text, { ms, via: 'drover', launch: false });
      else if (ev.type === 'launch' && typeof ev.prompt === 'string' && (!ev.host || ev.host === this.host)) add(ev.prompt, { ms, via: ev.mode === 'headless' ? 'headless' : 'drover', launch: true });
    }
    this.map = map;
  }
  /** 'drover' or 'headless' when Drover sent this text near this time, else null. */
  match(text, ms) {
    const l = this.map.get(matchKey(text));
    if (!l || !Number.isFinite(ms)) return null;
    for (const e of l) {
      if (e.launch ? ms >= e.ms - 60_000 && ms - e.ms <= LAUNCH_WINDOW_MS : Math.abs(ms - e.ms) <= MESSAGE_WINDOW_MS) return e.via;
    }
    return null;
  }
}

// ---------------------------------------------------------------- the collector (the daemon's one writer)

const LEAD = /^\{"v":1,"id":"(p_[0-9a-f]{16})","ts":"([^"]*)"/;

export class Collector {
  /**
   * @param {object} o
   * @param {{claude?: string, codex?: string}} [o.roots] transcript roots (default search/indexer.js defaultRoots)
   * @param {string} [o.dir] the spool directory; o.offsets the offsets file; o.host the name records carry
   * @param {string} [o.eventsFile] the truth file whose message and launch events say what Drover sent
   */
  constructor({ env = process.env, roots, dir, offsets, host, eventsFile, identity, log: logFn = log } = {}) {
    this.env = env;
    const d = roots ?? defaultRoots(env);
    this.roots = { claude: d.claude ?? null, codex: d.codex ?? null };
    this.dir = dir ?? spoolDir(env); this.offsetsFile = offsets ?? offsetsPath(env);
    this.host = host ?? localShortName(); this.home = homeOf(env);
    this.identity = identity !== undefined ? identity : dfIdentity(env);
    this.truth = new TruthIndex({ file: eventsFile ?? events.EVENTS_PATH, host: this.host });
    this.log = logFn;
    this.files = new Map(); this.ids = new Set(); this.days = new Set();
    this.loaded = null; this.running = null; this.labeler = null; this.rulesSig = null;
    this.state = { lastScan: null, lastMs: null, lastError: null, scans: 0, added: 0, oldest: null, newest: null, sources: 0, config: null };
  }

  /** Read the spool's ids (so nothing is written twice) and the offsets, once. */
  load() {
    this.loaded ??= (async () => {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      for (const f of (await readdir(this.dir).catch(() => [])).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort()) {
        this.days.add(f.slice(0, 10));
        const file = path.join(this.dir, f);
        const size = (await stat(file)).size;
        for await (const win of readNewLines(file, 0, size)) {
          for (const line of win.lines) {
            let id, ts;
            const m = line.match(LEAD);
            if (m) [, id, ts] = m; else { try { const r = JSON.parse(line); id = r.id; ts = r.ts; } catch { continue; } }
            if (typeof id !== 'string') continue;
            this.ids.add(id); this.#seen(ts);
          }
          await yieldNow();
        }
      }
      try {
        const o = JSON.parse(await readFile(this.offsetsFile, 'utf8'));
        for (const [p, v] of Object.entries(o?.files ?? {})) if (v && typeof v === 'object') this.files.set(p, v);
        if (o?.lastScan) this.state.lastScan = o.lastScan;
      } catch { /* none yet: everything is new */ }
    })();
    return this.loaded;
  }

  #seen(ts) {
    if (typeof ts !== 'string' || !ts) return;
    if (!this.state.oldest || ts < this.state.oldest) this.state.oldest = ts;
    if (!this.state.newest || ts > this.state.newest) this.state.newest = ts;
  }

  /** One pass over every transcript that changed. A pass already running is shared, never started twice. */
  scan() {
    this.running ??= this.#scan().finally(() => { this.running = null; });
    return this.running;
  }

  async #scan() {
    await this.load();
    const t0 = Date.now();
    const run = { scanned: 0, changed: 0, added: 0 };
    try {
      const cfg = await loadConfig(this.env);
      this.state.config = { file: cfg.file, found: cfg.found, errors: cfg.errors };
      const sig = JSON.stringify(cfg.rules);
      if (!this.labeler || sig !== this.rulesSig) { this.labeler = new Labeler({ rules: cfg.rules, identity: this.identity, home: this.home }); this.rulesSig = sig; }
      if (this.labeler.errors.length) this.state.config.errors = [...cfg.errors, ...this.labeler.errors];
      await this.truth.refresh();
      const list = (await listSources(this.roots)).filter((s) => s.kind === 'claude' || s.kind === 'codex');
      const live = new Set(list.map((s) => s.path));
      for (const p of this.files.keys()) if (!live.has(p)) this.files.delete(p);
      this.state.sources = list.length;
      let lastSave = Date.now();
      for (const src of list) {
        run.scanned++;
        const prev = this.files.get(src.path);
        if (prev && prev.size === src.size && prev.mtime_ms === src.mtime_ms && prev.ino === src.ino) continue;
        run.changed++;
        try { run.added += await this.#readSource(src, prev); }
        catch (e) { this.log(`${src.path} not read: ${e.code ?? e.message}`); }
        if (Date.now() - lastSave > 2000) { await this.#saveOffsets(); lastSave = Date.now(); }
        await yieldNow();
      }
      this.state.lastError = null;
    } catch (e) {
      this.state.lastError = String(e.message ?? e).slice(0, 300);
      this.log(`pass failed: ${this.state.lastError}`);
    } finally {
      this.state.scans++; this.state.added += run.added;
      this.state.lastScan = new Date().toISOString(); this.state.lastMs = Date.now() - t0;
      await this.#saveOffsets().catch((e) => this.log(`offsets not saved: ${e.message}`));
    }
    return { ...run, ms: Date.now() - t0 };
  }

  async #readSource(src, prev) {
    const engine = src.kind;
    const replaced = Boolean(prev && (src.size < (prev.offset ?? 0) || (prev.ino && prev.ino !== src.ino)));
    const st = prev && !replaced ? { ...prev } : { offset: 0, session: src.session_id ?? null, cwd: null, source: null, decided: false, skipped: null };
    const stamp = { size: src.size, mtime_ms: src.mtime_ms, ino: src.ino };
    // A skipped session stays skipped: only its read position moves.
    if (st.skipped) { this.files.set(src.path, { ...st, ...stamp, offset: src.size }); return 0; }
    if (engine === 'claude' && !st.decided) {
      const why = skipReason({ slug: path.basename(path.dirname(src.path)) }, this.env);
      if (why) { this.files.set(src.path, { ...st, ...stamp, offset: src.size, decided: true, skipped: why }); return 0; }
    }
    const fallbackTs = isoOf(src.mtime_ms);
    let added = 0;
    for await (const win of readNewLines(src.path, st.offset ?? 0, src.size)) {
      const recs = [];
      for (const line of win.lines) {
        const r = engine === 'codex' ? codexPrompt(line, st) : claudePrompt(line);
        if (st.skipped) break;
        if (!r) continue;
        if (engine === 'claude') { if (r.cwd) st.cwd = r.cwd; if (r.sessionId && !st.session) st.session = r.sessionId; }
        if (!r.prompt) continue;
        if (!st.decided) {
          st.decided = true;
          st.skipped = skipReason({ cwd: r.cwd ?? st.cwd, firstUser: r.prompt.text }, this.env);
          if (st.skipped) break;
        }
        recs.push(this.#record(engine, st, r, fallbackTs));
      }
      if (st.skipped) { st.offset = src.size; break; }
      added += await this.#append(recs);
      st.offset = win.end;
      // size -1 while reading: a pass that stops here (a crash, a restart) carries on from offset instead of skipping the rest.
      this.files.set(src.path, { ...st, ...stamp, size: -1 });
      await yieldNow();
    }
    this.files.set(src.path, { ...st, ...stamp });
    return added;
  }

  #record(engine, st, r, fallbackTs) {
    const cwd = r.cwd ?? st.cwd ?? null;
    const ts = isoOf(r.ts) ?? fallbackTs ?? new Date().toISOString();
    const { text } = r.prompt;
    let via = r.prompt.via;
    if (via === 'typed' || via === 'queued' || via === 'sdk') via = this.truth.match(text, Date.parse(ts)) ?? via;
    const session = st.session ?? null;
    const rec = { v: 1, id: promptId({ host: this.host, engine, session, ref: r.ref ?? ts, text }), ts, host: this.host, engine, session,
      cwd: tilde(cwd, this.home), project: projectOf(cwd), label: this.labeler?.label(cwd) ?? (this.identity || 'default'), via, text };
    if (r.prompt.from) rec.from = r.prompt.from;
    return rec;
  }

  /** Append the records not in the spool yet, each to its own UTC day's file. Returns how many were new. */
  async #append(recs) {
    const byDay = new Map();
    for (const r of recs) {
      if (this.ids.has(r.id)) continue;
      this.ids.add(r.id);
      const day = r.ts.slice(0, 10);
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(JSON.stringify(r));
      this.#seen(r.ts);
    }
    let n = 0;
    for (const [day, lines] of byDay) {
      const file = path.join(this.dir, `${day}.jsonl`);
      const fresh = !this.days.has(day);
      await appendFile(file, lines.join('\n') + '\n', { mode: 0o600 });
      if (fresh) { await chmod(file, 0o600).catch(() => {}); this.days.add(day); }
      n += lines.length;
    }
    return n;
  }

  async #saveOffsets() {
    const tmp = `${this.offsetsFile}.${process.pid}.tmp`;
    await mkdir(path.dirname(this.offsetsFile), { recursive: true, mode: 0o700 });
    await writeFile(tmp, JSON.stringify({ v: 1, lastScan: this.state.lastScan, files: Object.fromEntries(this.files) }), { mode: 0o600 });
    await rename(tmp, this.offsetsFile);
  }

  status() {
    return { files: this.days.size, records: this.ids.size, oldest: this.state.oldest, newest: this.state.newest, lastScan: this.state.lastScan,
      lastMs: this.state.lastMs, lastError: this.state.lastError, scanning: Boolean(this.running), sources: this.state.sources, config: this.state.config };
  }
}

// ---------------------------------------------------------------- reading (any process: the spool and the sink clones are files)

/** A time bound: an ISO time, epoch ms, or a span back from now (30m, 12h, 7d, 2w). null when absent or unreadable. */
export function whenMs(v, now = Date.now()) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const m = String(v).trim().match(/^(\d+(?:\.\d+)?)\s*(m|h|d|w)$/i);
  if (m) return now - Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2].toLowerCase()];
  if (/^\d{10,}$/.test(String(v))) return Number(v);
  const ms = Date.parse(String(v));
  return Number.isFinite(ms) ? ms : null;
}

const setOf = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const s = new Set((Array.isArray(v) ? v : String(v).split(',')).map((x) => String(x).trim()).filter(Boolean));
  return s.size ? s : null;
};

/**
 * The filters of prompts.list and prompts.local as one test: q (words, every one in the text, any case), engine,
 * label and via (a value or a list; via defaults to MINE, 'all' or '*' is every via; an id filter alone takes every
 * via), since and until (whenMs), session (an id or its prefix), cwd (the directory or one under it; ~ allowed), id
 * (one or a list). Also the days to read and the paging cursor (before + beforeTs: what comes after that record).
 */
export function compileFilter(a = {}, { env = process.env } = {}) {
  const home = homeOf(env);
  const words = String(a.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const engine = setOf(a.engine), label = setOf(a.label), ids = setOf(a.id ?? a.ids);
  let via = setOf(a.via);
  if (via && (via.has('all') || via.has('*'))) via = null;
  else if (!via && !ids) via = new Set(MINE);
  const since = whenMs(a.since), until = whenMs(a.until);
  const session = typeof a.session === 'string' && a.session ? a.session : null;
  let cwd = typeof a.cwd === 'string' && a.cwd ? a.cwd.replace(/\/+$/, '') : null;
  if (cwd) cwd = tilde(untilde(cwd, home), home);
  const sinceIso = since !== null ? new Date(since).toISOString() : null, untilIso = until !== null ? new Date(until).toISOString() : null;
  const test = (r) => {
    if (!r || typeof r.id !== 'string' || typeof r.ts !== 'string') return false;
    if (ids && !ids.has(r.id)) return false;
    if (via && !via.has(r.via)) return false;
    if (engine && !engine.has(r.engine)) return false;
    if (label && !label.has(r.label)) return false;
    if (sinceIso && r.ts < sinceIso) return false;
    if (untilIso && r.ts > untilIso) return false;
    if (session && !String(r.session ?? '').startsWith(session)) return false;
    if (cwd && !(r.cwd === cwd || String(r.cwd ?? '').startsWith(cwd + '/'))) return false;
    if (words.length) { const t = String(r.text ?? '').toLowerCase(); if (!words.every((w) => t.includes(w))) return false; }
    return true;
  };
  return { test, sinceDay: sinceIso?.slice(0, 10) ?? null, untilDay: untilIso?.slice(0, 10) ?? null, before: typeof a.before === 'string' && a.before ? a.before : null, beforeTs: typeof a.beforeTs === 'string' && a.beforeTs ? a.beforeTs : null };
}

/** Newest first: ts, then id (so a page boundary between two prompts of the same millisecond is still exact). */
export const newestFirst = (a, b) => (a.ts === b.ts ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : a.ts < b.ts ? 1 : -1);
/** Whether r comes after the cursor (ts, id) in newestFirst order. */
export const afterCursor = (r, ts, id) => r.ts < ts || (r.ts === ts && r.id < id);
export const clampLimit = (v) => Math.max(1, Math.min(MAX_LIMIT, Math.floor(Number(v)) || LIMIT));

const dayCache = new Map();   // file -> { size, mtimeMs, recs }
const DAY_CACHE_MAX = 96;
/** One day file's records (deduped by id), cached by size and mtime: this process may answer many pages. */
export async function dayRecords(file) {
  let st;
  try { st = await stat(file); } catch { return []; }
  const c = dayCache.get(file);
  if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) { dayCache.delete(file); dayCache.set(file, c); return c.recs; }
  const raw = await readFile(file, 'utf8').catch(() => '');
  const seen = new Set(), recs = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (!r || typeof r.id !== 'string' || seen.has(r.id)) continue;
    seen.add(r.id); recs.push(r);
  }
  dayCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, recs });
  while (dayCache.size > DAY_CACHE_MAX) dayCache.delete(dayCache.keys().next().value);
  return recs;
}

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
async function dayFiles(dir, f) {
  return (await readdir(dir).catch(() => [])).map((n) => n.match(DAY_FILE)?.[1]).filter(Boolean)
    .filter((d) => (!f.sinceDay || d >= f.sinceDay) && (!f.untilDay || d <= f.untilDay)).sort().reverse().map((d) => path.join(dir, `${d}.jsonl`));
}

/**
 * The matching records of some day-file directories, newest first, after the cursor, at most limit. more: there are
 * matches past this page. total: how many match in all (cursor aside), only when every day was read anyway.
 */
export async function readDirs(dirs, f, { limit = LIMIT } = {}) {
  const lim = clampLimit(limit);
  // Every directory's days, newest first, merged: a day is read in all directories before the one before it.
  const byDay = new Map();
  for (const dir of dirs) for (const file of await dayFiles(dir, f)) { const d = path.basename(file, '.jsonl'); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(file); }
  const days = [...byDay.keys()].sort().reverse();
  let cursor = f.before ? (f.beforeTs ? { ts: f.beforeTs, id: f.before } : null) : undefined;
  const out = [], seen = new Set();
  let total = 0, complete = true, more = false;
  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    const recs = [];
    for (const file of byDay.get(day)) for (const r of await dayRecords(file)) if (!seen.has(r.id)) { seen.add(r.id); recs.push(r); }
    // The cursor's own record names its time: found here, the rest of this day and every earlier day come after it.
    if (cursor === null) { const hit = recs.find((r) => r.id === f.before); if (hit) cursor = { ts: hit.ts, id: hit.id }; else continue; }
    const hits = recs.filter(f.test).sort(newestFirst);
    total += hits.length;
    for (const r of hits) {
      if (cursor && !afterCursor(r, cursor.ts, cursor.id)) continue;
      if (out.length < lim) out.push(r); else more = true;
    }
    if (out.length >= lim && i < days.length - 1) { complete = false; more = true; break; }
    await yieldNow();
  }
  if (cursor === null) throw new Error(`before: no prompt ${f.before} here (pass beforeTs, its ts)`);
  return { prompts: out, more, ...(complete && !f.before ? { total } : {}) };
}

/** prompts.local: this host's records. */
export async function listLocal(args = {}, { env = process.env } = {}) {
  const t0 = Date.now();
  const f = compileFilter(args, { env });
  const r = await readDirs([spoolDir(env)], f, { limit: args.limit });
  return { host: localShortName(), ...r, ms: Date.now() - t0 };
}

/**
 * Records other hosts pushed to a git sink, read from this machine's clone of it (as of its last pull): what the
 * front shows for a host that did not answer. include: the host directories to read (null: all but exclude).
 */
export async function listClones(args = {}, { env = process.env, include = null, exclude = new Set() } = {}) {
  const cfg = await loadConfig(env);
  const f = compileFilter(args, { env });
  const byHost = new Map();
  for (const { sink, host, dir } of await cloneHostDirs(cfg, env)) {
    if (exclude.has(host) || (include && !include.has(host))) continue;
    if (!byHost.has(host)) byHost.set(host, { dirs: [], sinks: [] });
    byHost.get(host).dirs.push(dir); byHost.get(host).sinks.push(sink);
  }
  const out = [];
  for (const [host, { dirs, sinks: names }] of byHost) {
    const r = await readDirs(dirs, { ...f, before: null }, { limit: args.limit });
    const cursor = f.before && f.beforeTs ? { ts: f.beforeTs, id: f.before } : null;
    const prompts = cursor ? r.prompts.filter((p) => afterCursor(p, cursor.ts, cursor.id)) : r.prompts;
    out.push({ host, sinks: [...new Set(names)], prompts, more: r.more });
  }
  return out;
}

/** The ts of a record by id, in this host's spool or a sink clone; null when neither has it. */
export async function findTs(id, { env = process.env } = {}) {
  const f = compileFilter({ id }, { env });
  const here = await readDirs([spoolDir(env)], f, { limit: 1 });
  if (here.prompts[0]) return here.prompts[0].ts;
  const there = await listClones({ id, limit: 1 }, { env });
  return there.find((h) => h.prompts[0])?.prompts[0].ts ?? null;
}

// ---------------------------------------------------------------- the service (daemon) and the ops

let daemon = false;
let svc = null;
export const _deps = { env: process.env };
/** Called by the HTTP server: this process is the host's daemon and owns the collector and the sinks. */
export function markDaemon() { daemon = true; }

function service() {
  if (svc) return svc;
  const env = _deps.env;
  const collector = new Collector({ env });
  const sinks = new Sinks({ env, stateDir: stateDir(env), spoolDir: spoolDir(env), host: collector.host, log });
  svc = { collector, sinks, timer: null, startup: null };
  return svc;
}
/** Tests: forget the service (and its in-memory state) so the next op builds a new one from the environment. */
export function _reset() { if (svc) { clearTimeout(svc.startup); clearInterval(svc.timer); } svc = null; daemon = false; }

/** Daemon only: a pass 20 s after start, then every DROVER_PROMPTS_EVERY_MS (default 60 s); sinks when they are due. */
export function startService({ firstMs = 20_000 } = {}) {
  if (!enabled(_deps.env)) { log('off (DROVER_PROMPTS=off)'); return () => {}; }
  const s = service();
  if (s.timer) return stopService;
  const every = Math.max(10_000, Number(envvar('PROMPTS_EVERY_MS', _deps.env)) || 60_000);
  const pass = async () => {
    const r = await s.collector.scan();
    if (r.added) log(`pass: ${r.changed} changed of ${r.scanned}, +${r.added} prompts, ${r.ms} ms`);
    const synced = await s.sinks.syncDue(await loadConfig(_deps.env));
    for (const x of synced) if (!x.ok) log(`sink ${x.name}: ${x.error}`);
  };
  s.startup = setTimeout(() => { pass().catch((e) => log(`pass failed: ${e.message}`)); }, firstMs); s.startup.unref?.();
  s.timer = setInterval(() => { pass().catch((e) => log(`pass failed: ${e.message}`)); }, every); s.timer.unref?.();
  return stopService;
}
export function stopService() { if (!svc) return; clearTimeout(svc.startup); clearInterval(svc.timer); svc.timer = null; svc.startup = null; }

async function statusHere() {
  const s = service();
  await s.collector.load();
  const cfg = await loadConfig(_deps.env);
  return { host: localShortName(), enabled: enabled(_deps.env), daemon, ...s.collector.status(), config: s.collector.state.config ?? { file: cfg.file, found: cfg.found, errors: cfg.errors }, sinks: await s.sinks.status(cfg) };
}

async function syncHere({ sinks: names } = {}) {
  const s = service();
  const t0 = Date.now();
  const r = await s.collector.scan();
  const cfg = await loadConfig(_deps.env);
  const pick = setOf(names);
  const sinks = await s.sinks.syncAll(cfg, { names: pick, force: true });
  return { host: localShortName(), scanned: r.scanned, added: r.added, sinks, ms: Date.now() - t0 };
}

/** Run in the daemon; any other process (an rpc peer, the MCP server, drover op) asks it, and with no daemon runs here. */
const viaDaemon = (op, fn, timeoutMs) => async (args = {}) => {
  if (daemon) return fn(args);
  const ep = await daemonEndpoint().catch(() => null);
  if (ep) {
    try { return await callDaemon(ep, op, args, { timeoutMs }); }
    catch (e) { if (!e.unreachable && !(e.fromDaemon && /unknown op/i.test(e.message))) throw e; }
  }
  return fn(args);
};

export const ops = {
  'prompts.local': (args = {}) => listLocal(args, { env: _deps.env }),
  'prompts.status': viaDaemon('prompts.status', statusHere, 15_000),
  'prompts.sync': viaDaemon('prompts.sync', syncHere, 600_000),
};
