// Memory surfaces: the dotfiles memory home for a repo, session handoff,
// MEMORY.md index, analyzer output, dream diary, and the reflections CLI.
import { readFile, writeFile, readdir, stat, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { tryRun } from './proc.js';
import { DOTFILES, append } from './events.js';
import { envvar } from './envvars.js';

const HOMES_CONF = path.join(DOTFILES, 'claude', 'memory-homes.conf');

/**
 * The reflections CLI, an external tool the owner installs: DROVER_REFLECTIONS_BIN (tests, a checkout), else
 * <dotfiles>/scripts/reflections. Read per call.
 */
export function reflectionsBin(env = process.env) {
  return envvar('REFLECTIONS_BIN', env) ?? path.join(envvar('DOTFILES', env) ?? path.join(env.HOME ?? '', '.dotfiles'), 'scripts', 'reflections');
}

function expand(p) { return p.replace(/^~(?=$|\/)/, process.env.HOME); }

/** repo name -> absolute memory home, from memory-homes.conf. */
export async function memoryHomes() {
  if (!existsSync(HOMES_CONF)) return {};
  const text = await readFile(HOMES_CONF, 'utf8');
  const out = {};
  for (const line of text.split('\n')) {
    const t = line.trim(); if (!t || t.startsWith('#')) continue;
    const [repo, ...rest] = t.split(/\s+/); if (repo && rest.length) out[repo] = expand(rest.join(' '));
  }
  return out;
}

/** The repo a call means when it names none: DROVER_DEFAULT_REPO; without it the call must name one. */
export function defaultRepo() {
  const r = envvar('DEFAULT_REPO');
  if (!r) throw new Error('repo is required (or set DROVER_DEFAULT_REPO)');
  return r;
}

/**
 * A repo's memory home: its line in memory-homes.conf, else <DROVER_MEMORY_ROOT>/<repo>; without that setting,
 * <dotfiles>/identities/<identity>/claude/memory/<repo> on a machine whose ~/.df-profile (or DF_IDENTITY) names a
 * dotfiles identity, else <dotfiles>/claude/memory/<repo>.
 */
export async function homeFor(repo = defaultRepo()) {
  const homes = await memoryHomes();
  if (homes[repo]) return homes[repo];
  const name = repo.toLowerCase();
  const root = envvar('MEMORY_ROOT');
  if (root) return path.join(expand(root), name);
  const id = (await readFile(path.join(process.env.HOME, '.df-profile'), 'utf8').catch(() => '')).match(/DF_IDENTITY=(\w+)/)?.[1] ?? process.env.DF_IDENTITY?.match(/^\w+$/)?.[0];
  return id ? path.join(DOTFILES, 'identities', id, 'claude', 'memory', name) : path.join(DOTFILES, 'claude', 'memory', name);
}

async function readIf(f, { maxBytes = 512 * 1024 } = {}) {
  if (!existsSync(f)) return null;
  const s = await stat(f);
  const text = await readFile(f, 'utf8');
  return { path: f, mtime: s.mtime.toISOString(), bytes: s.size, text: text.length > maxBytes ? text.slice(-maxBytes) : text };
}

/** Everything the Memory view shows for one repo. */
export async function overview(repo = defaultRepo()) {
  const home = await homeFor(repo);
  const [handoff, index, dreams] = await Promise.all([
    readIf(path.join(home, 'session_handoff.md')),
    readIf(path.join(home, 'MEMORY.md')),
    readIf(path.join(home, 'DREAMS.md'), { maxBytes: 64 * 1024 }),
  ]);
  const analysis = [];
  const aDir = path.join(home, '.analysis');
  if (existsSync(aDir)) {
    for (const host of await readdir(aDir).catch(() => [])) {
      const f = path.join(aDir, host, 'unfinished.md');
      const r = await readIf(f, { maxBytes: 64 * 1024 }); if (r) analysis.push({ host, ...r });
    }
  }
  const reflections = await reflectionsList(repo).catch((e) => ({ error: e.message, items: [] }));
  const dreamDirs = [];
  for (const phase of ['light', 'rem', 'deep']) {
    const d = path.join(home, 'dreaming', phase);
    if (!existsSync(d)) continue;
    const files = (await readdir(d)).filter((n) => n.endsWith('.md')).sort().slice(-3);
    dreamDirs.push({ phase, latest: files });
  }
  return { repo, home, handoff, memoryIndex: index, dreams, dreamDirs, analysis, reflections };
}

export async function writeHandoff(repo, text, { actor = 'drover' } = {}) {
  if (typeof text !== 'string') throw new Error('text required');
  const home = await homeFor(repo);
  const f = path.join(home, 'session_handoff.md');
  await writeFile(f, text, 'utf8');
  const sha256 = createHash('sha256').update(text).digest('hex');
  const ev = await append({ type: 'handoff', path: f, sha256, bytes: text.length, repo }, { actor });
  return { path: f, sha256, event: ev.id };
}

function reflEnv() { return { ...process.env, REFLECTIONS_DOTFILES: DOTFILES }; }

// The CLI's vocabulary (scripts/reflections: KINDS, STATUSES plus the derived `stale`, SOURCES).
export const REFLECTION_KINDS = ['action', 'question', 'handoff', 'learning', 'decision', 'gotcha', 'idea', 'note'];
export const REFLECTION_STATUSES = ['open', 'stale', 'done', 'dropped', 'note'];
const SEARCH_KINDS = [...REFLECTION_KINDS, 'memory', 'analysis', 'feature'];   // search also covers the memories the CLI mirrors
const SOURCES = ['reflection', 'memory', 'codex', 'feature', 'analysis'];
const TIMEOUT_MS = 20_000;

function text(v, name, { max = 20_000, allowEmpty = false } = {}) {
  if (typeof v !== 'string' || (!allowEmpty && !v.trim())) throw new Error(`${name} must be a ${allowEmpty ? '' : 'non-empty '}string`);
  if (v.length > max) throw new Error(`${name} too long (max ${max} characters)`);
  if (v.includes('\0')) throw new Error(`${name} must not contain NUL`);
  return v;
}
const int = (v, name, lo, hi) => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`${name} must be an integer from ${lo} to ${hi}`); return n; };
/** f(v), or undefined when v was not given (so the CLI default applies). */
const maybe = (v, f) => (v === undefined || v === null || v === '' ? undefined : f(v));
const idOf = (v, name = 'id') => text(v, name, { max: 120 }).trim().replace(/^#/, '');
const repoOf = (v) => text(v, 'repo', { max: 200 }).trim();
/** A comma list (or an array) whose every value is allowed, joined the way the CLI takes it. */
function csv(v, allowed, name) {
  const xs = (Array.isArray(v) ? v : String(v).split(',')).map((x) => String(x).trim()).filter(Boolean);
  if (!xs.length || xs.some((x) => !allowed.includes(x))) throw new Error(`${name} must be ${allowed.join(', ')} (comma-separated)`);
  return xs.join(',');
}
/** A status filter: the CLI's statuses, the derived stale, or all; comma-separated. */
export const reflectionStatusFilter = (v) => csv(v, [...REFLECTION_STATUSES, 'all'], 'status');
const tagsOf = (v) => (Array.isArray(v) ? v.map((t) => text(t, 'tags', { max: 80 }).trim()) : [text(v, 'tags', { max: 2000, allowEmpty: true })]).join(',');
// --name=value, so a value that starts with "-" is never taken for a flag.
const opt = (name, v) => (v === undefined || v === null || v === '' ? [] : [`--${name}=${v}`]);
const agentOpt = (actor) => opt('agent', maybe(actor, (v) => text(v, 'actor', { max: 80 }).trim()));

/** Run the CLI. A non-zero exit throws the CLI's own message (stderr); what it printed before failing stays on the error. */
async function refl(argv, { input, bin = reflectionsBin(), timeoutMs = TIMEOUT_MS } = {}) {
  if (!existsSync(bin)) throw new Error(`reflections CLI missing: ${bin}`);
  const r = await tryRun(bin, argv, { env: reflEnv(), timeoutMs, input });
  if (r.code !== 0) {
    const why = (r.stderr.trim() || r.stdout.trim() || `exited ${r.code}`).replace(/^reflections: /, '').slice(0, 500);
    throw Object.assign(new Error(`reflections ${argv[0]}: ${why}`), { stdout: r.stdout });
  }
  return r.stdout;
}
function parsed(out, what) {
  try { return JSON.parse(out); } catch { throw new Error(`reflections ${what} did not print JSON (a CLI older than this Drover?): ${String(out).trim().slice(0, 200)}`); }
}

// list, search and export keep to this machine's identity (the CLI decides which that is) unless anyIdentity: one
// repo key can hold both identities' logs, and one identity's items must not reach the other's sessions unless asked.
export async function reflectionsList(repo, { all = false, status, kind, session, limit, anyIdentity = false } = {}) {
  const bin = reflectionsBin();
  if (!existsSync(bin)) return { items: [], error: 'reflections CLI missing' };
  // all lists every repo, so it needs no repo (nor the default one).
  const argv = ['list', ...(all ? ['--all'] : [`--repo=${repoOf(repo ?? defaultRepo())}`]), ...(anyIdentity === true ? ['--any-identity'] : []), ...opt('status', maybe(status, reflectionStatusFilter)), ...opt('kind', maybe(kind, (v) => csv(v, REFLECTION_KINDS, 'kind'))),
    ...opt('session', maybe(session, (v) => text(v, 'session', { max: 200 }).trim())), ...opt('limit', maybe(limit, (v) => int(v, 'limit', 1, 1000)))];
  const r = await tryRun(bin, [...argv, '--json'], { env: reflEnv(), timeoutMs: TIMEOUT_MS });
  if (r.code !== 0) {
    // Older CLI without --json: fall back to plain text.
    const t = await tryRun(bin, argv, { env: reflEnv(), timeoutMs: TIMEOUT_MS });
    return { items: [], text: t.stdout, error: t.code === 0 ? null : t.stderr.trim().slice(0, 300) };
  }
  try { const j = JSON.parse(r.stdout); return { items: Array.isArray(j) ? j : j.items ?? [], raw: undefined }; } catch { return { items: [], text: r.stdout }; }
}

/** Full-text search (BM25 over the CLI's index) across reflections and the memories it mirrors: items with a snippet. */
export async function reflectionsSearch(query, { repo, status, kind, source, limit, anyIdentity = false } = {}) {
  const argv = ['search', '--json', ...(anyIdentity === true ? ['--any-identity'] : []), ...opt('repo', maybe(repo, repoOf)), ...opt('status', maybe(status, reflectionStatusFilter)), ...opt('kind', maybe(kind, (v) => csv(v, SEARCH_KINDS, 'kind'))),
    ...opt('source', maybe(source, (v) => csv(v, SOURCES, 'source'))), ...opt('limit', maybe(limit, (v) => int(v, 'limit', 1, 200))), '--', text(query, 'query', { max: 2000 }).trim()];
  const items = parsed(await refl(argv), 'search');
  return { items: Array.isArray(items) ? items : [] };
}

/** Per repo: open, stale, done and note counts and the last change (`reflections repos`). */
export async function reflectionsRepos() {
  const rows = parsed(await refl(['repos', '--json']), 'repos');
  return (Array.isArray(rows) ? rows : []).map((r) => ({ repo: r.repo, open: r.o ?? 0, stale: r.s ?? 0, done: r.d ?? 0, notes: r.n ?? 0, last: r.last ?? null }));
}

/** One item in full, by id or a unique prefix of at least 3 characters. */
export async function reflectionShow(id) { return parsed(await refl(['show', '--json', '--', idOf(id)]), 'show'); }

export async function reflectionAdd({ repo = defaultRepo(), kind = 'note', title, body, tags, priority, session, actor }) {
  if (!REFLECTION_KINDS.includes(kind)) throw new Error(`kind must be one of ${REFLECTION_KINDS.join(', ')}`);
  const argv = ['add', '--json', `--repo=${repoOf(repo)}`, `--kind=${kind}`, `--title=${text(title, 'title', { max: 1000 })}`, ...opt('tags', maybe(tags, tagsOf)),
    ...opt('priority', maybe(priority, (v) => int(v, 'priority', 1, 5))), ...opt('session', maybe(session, (v) => text(v, 'session', { max: 200 }).trim())), ...agentOpt(actor)];
  // The body goes in on stdin (--body=-): no argv limit, and a body that starts with "-" stays a body.
  if (body) argv.push('--body=-');
  const j = parsed(await refl(argv, { input: body ? text(body, 'body', { allowEmpty: true }) : undefined }), 'add');
  const it = j.items?.[0];
  if (!it?.id) throw new Error('reflections add recorded nothing (the title was empty once whitespace was collapsed)');
  return { id: it.id, kind, title: it.title ?? title, repo: j.repo ?? repo, ...(it.duplicate ? { duplicate: true } : {}), ...(it.reopened ? { reopened: true } : {}) };
}

export async function reflectionMark(op, ids, { note, actor } = {}) {
  if (!['done', 'reopen', 'drop'].includes(op)) throw new Error('op must be done|reopen|drop');
  if (!Array.isArray(ids) || !ids.length) throw new Error('ids required');
  const argv = [op, ...opt('note', maybe(note, (v) => text(v, 'note', { max: 1000 }))), ...agentOpt(actor), '--', ...ids.map((x) => idOf(x, 'ids'))];
  // One "#<id> → <status>  <title>" line per item. The CLI stops at the first id it cannot resolve,
  // after marking the ones before it, so a failure says which ids did change.
  const marked = (out) => [...String(out ?? '').matchAll(/^#(\S+) → (\S+) {2}(.*)$/gm)].map((m) => ({ id: m[1], status: m[2], title: m[3] }));
  try {
    const out = await refl(argv);
    return { ok: true, op, marked: marked(out), text: out.trim() };
  } catch (e) {
    const before = marked(e.stdout);
    if (before.length) e.message += ` (already marked ${op}: ${before.map((m) => m.id).join(', ')})`;
    throw e;
  }
}

/** Change an item's title, body, tags (an empty list clears them), kind or priority. */
export async function reflectionEdit({ id, title, body, tags, kind, priority, actor } = {}) {
  const argv = ['edit', ...opt('title', maybe(title, (v) => text(v, 'title', { max: 1000 })))];
  if (tags !== undefined && tags !== null) argv.push(`--tags=${tagsOf(tags)}`);
  if (kind !== undefined && kind !== null) { if (!REFLECTION_KINDS.includes(kind)) throw new Error(`kind must be one of ${REFLECTION_KINDS.join(', ')}`); argv.push(`--kind=${kind}`); }
  argv.push(...opt('priority', maybe(priority, (v) => int(v, 'priority', 1, 5))));
  const hasBody = body !== undefined && body !== null;
  if (hasBody) argv.push('--body=-');
  if (argv.length === 1) throw new Error('nothing to change: pass title, body, tags, kind or priority');
  argv.push(...agentOpt(actor), '--', idOf(id));
  const out = await refl(argv, { input: hasBody ? text(body, 'body', { allowEmpty: true }) : undefined });
  return { ok: true, id: out.match(/^#(\S+) edited/m)?.[1] ?? idOf(id), text: out.trim() };
}

/**
 * Status changes and edits in one call (`reflections apply --batch -`): ops [{op: done|drop|reopen|edit, id, note,
 * ...edit fields}] by exact id. Scoped to one repo unless anyRepo; returns {applied, skipped} with a reason per skip.
 */
export async function reflectionsApply(ops, { repo, anyRepo = false, note, actor } = {}) {
  if (!Array.isArray(ops)) throw new Error('ops must be a list of {"op": "done"|"drop"|"reopen"|"edit", "id": ...} objects');
  if (!ops.length) throw new Error('ops must not be empty');
  ops.forEach((o, i) => { if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error(`ops[${i}] must be an object like {"op": "done", "id": "abcd2345"}`); });
  const any = anyRepo === true || anyRepo === 'true';
  // Without either, the CLI would scope the batch to the repo of the daemon's working directory.
  if (!any && !repo) throw new Error('apply needs repo (only that repo\'s items change) or anyRepo: true');
  const argv = ['apply', '--batch=-', '--json', ...(any ? ['--any-repo'] : [`--repo=${repoOf(repo)}`]), ...opt('note', maybe(note, (v) => text(v, 'note', { max: 1000 }))), ...agentOpt(actor)];
  const j = parsed(await refl(argv, { input: JSON.stringify(ops) }), 'apply');
  return { applied: j.applied ?? [], skipped: j.skipped ?? [] };
}

/** The items a reflection of a session may close, reopen or edit, or must not repeat (`reflections candidates`). */
export async function reflectionsCandidates({ query, session, repo = defaultRepo(), limit, notes, closed } = {}) {
  const q = maybe(query, (v) => text(v, 'query', { max: 1_000_000, allowEmpty: true })) ?? '';
  const argv = ['candidates', '--json', `--repo=${repoOf(repo)}`, ...opt('session', maybe(session, (v) => text(v, 'session', { max: 200 }).trim())),
    ...opt('limit', maybe(limit, (v) => int(v, 'limit', 1, 500))), ...opt('notes', maybe(notes, (v) => int(v, 'notes', 0, 200))), ...opt('closed', maybe(closed, (v) => int(v, 'closed', 0, 200)))];
  // A long text (a session excerpt) goes through a private temp file, not the command line.
  let dir = null;
  try {
    if (q.length > 4000) {
      dir = await mkdtemp(path.join(tmpdir(), 'drover-refl-'));
      await writeFile(path.join(dir, 'query.txt'), q, { mode: 0o600 });
      argv.push(`--query-file=${path.join(dir, 'query.txt')}`);
    } else if (q.trim()) argv.push('--', q);
    return parsed(await refl(argv), 'candidates');
  } finally { if (dir) await rm(dir, { recursive: true, force: true }); }
}

/**
 * Every reflection item, all statuses and repos (`reflections export [--since]`, JSON Lines), for the search
 * indexer. A line that is not JSON fails the whole export, so a cut-off run is never taken for the store.
 */
export async function reflectionsExport({ since, bin = reflectionsBin(), timeoutMs = 60_000 } = {}) {
  const out = await refl(['export', ...opt('since', since)], { bin, timeoutMs });
  const items = [];
  for (const [i, line] of out.split('\n').entries()) {
    if (!line.trim()) continue;
    let it;
    try { it = JSON.parse(line); } catch { throw new Error(`reflections export: line ${i + 1} is not JSON`); }
    if (it && typeof it === 'object' && typeof it.id === 'string' && it.id) items.push(it);
  }
  return items;
}

export async function reflectionsContext(repo = defaultRepo()) {
  const r = await tryRun(reflectionsBin(), ['context', '--repo', repo], { env: reflEnv(), timeoutMs: TIMEOUT_MS });
  return r.stdout;
}
