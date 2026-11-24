// Learned skills: the skills Claude Code and Codex agents write for themselves, kept by the dotfiles
// `skill-workshop` CLI (versioned, undoable, with drafts and a change feed). Drover reads its store and makes the
// owner's changes through it, the way core/memory.js fronts the reflections CLI: every call shells out to the CLI on
// the host that runs the op, every write goes in as `--actor user` (the owner acting from a Drover client, or an MCP
// caller on the owner's behalf; the truth file's op event names which), and the CLI's own error comes back as the
// message. Nothing here writes the store itself.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { tryRun } from './proc.js';
import { DOTFILES } from './events.js';
import { envvar } from './envvars.js';

/**
 * The skill-workshop CLI, an external tool the owner installs: DROVER_SKILL_WORKSHOP_BIN (tests, a checkout), else
 * <dotfiles>/scripts/skill-workshop. Read per call.
 */
export function skillWorkshopBin(env = process.env) {
  return envvar('SKILL_WORKSHOP_BIN', env) ?? path.join(envvar('DOTFILES', env) ?? path.join(env.HOME ?? '', '.dotfiles'), 'scripts', 'skill-workshop');
}

// The CLI's vocabulary (scripts/lib/skillstore.py: MODES, NAME_RE; ids from new_id and version_id).
export const MODES = ['auto', 'propose', 'off'];
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const VERSION_RE = /^\d{8}T\d{6}Z-[a-z0-9]{1,16}$/;
const DRAFT_RE = /^d-[a-z0-9]{4,32}$/;
const CHANGE_RE = /^[cr]-[a-z0-9]{4,32}$/;   // a change (c-…) or a background review run (r-…)
const TIMEOUT_MS = 30_000;                  // a write commits to the dotfiles checkout

/**
 * The CLI's environment: the dotfiles checkout Drover uses (unless the daemon's environment names the CLI's own), and
 * none of the agent-session markers the daemon or an MCP server may have inherited. A change made through Drover is
 * the owner's, so the CLI must not stamp it with whatever Claude Code or Codex session started this process.
 */
function swEnv() {
  const env = { ...process.env, SKILL_WORKSHOP_DOTFILES: process.env.SKILL_WORKSHOP_DOTFILES ?? DOTFILES };
  for (const k of Object.keys(env)) if (k === 'CLAUDECODE' || k === 'CLAUDE_CODE_SESSION_ID' || k.startsWith('CODEX_')) delete env[k];
  return env;
}

function text(v, name, { max = 2000, allowEmpty = false } = {}) {
  if (typeof v !== 'string' || (!allowEmpty && !v.trim())) throw new Error(`${name} must be a ${allowEmpty ? '' : 'non-empty '}string`);
  if (v.length > max) throw new Error(`${name} too long (max ${max} characters)`);
  if (v.includes('\0')) throw new Error(`${name} must not contain NUL`);
  return v;
}
const int = (v, name, lo, hi) => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`${name} must be an integer from ${lo} to ${hi}`); return n; };
/** f(v), or undefined when v was not given (so the CLI default applies). */
const maybe = (v, f) => (v === undefined || v === null || v === '' ? undefined : f(v));
const shaped = (re, what, example) => (v, name = what) => {
  const s = text(v, name, { max: 120 }).trim();
  if (!re.test(s)) throw new Error(`${name} must be ${example} (got ${JSON.stringify(s.slice(0, 60))})`);
  return s;
};
export const nameOf = shaped(NAME_RE, 'name', 'a learned-skill name: 1-63 lowercase letters, digits or hyphens, starting with a letter or digit');
const versionOf = shaped(VERSION_RE, 'version', 'a saved version id such as 20261124T013451Z-ab2c (skills.workshop.versions lists them)');
const draftOf = shaped(DRAFT_RE, 'id', 'a draft id such as d-ab2cd3ef (skills.workshop.drafts lists them)');
const changeOf = shaped(CHANGE_RE, 'id', 'a change id (c-…) or a background review run id (r-…) from skills.workshop.changes');
/** A file inside a skill (SKILL.md, references/x.md): relative, no .. segment, no hidden or empty part. */
function fileOf(v) {
  const s = text(v, 'file', { max: 300 }).trim();
  const parts = s.split('/');
  if (s.startsWith('/') || s.includes('\\') || parts.some((p) => !p || p === '.' || p === '..' || p.startsWith('.'))) {
    throw new Error(`file must be a path inside the skill such as SKILL.md or references/notes.md (got ${JSON.stringify(s.slice(0, 60))})`);
  }
  return s;
}
const reasonOf = (v) => text(v, 'reason', { max: 1000 }).replace(/\s+/g, ' ').trim();
// --name=value, so a value that starts with "-" is never taken for a flag.
const opt = (name, v) => (v === undefined || v === null || v === '' ? [] : [`--${name}=${v}`]);
const truthy = (v) => v === true || v === 'true';

/** Run the CLI. A non-zero exit throws the CLI's own message (stderr, without its "skill-workshop: " prefix). */
async function sw(argv, { bin = skillWorkshopBin(), timeoutMs = TIMEOUT_MS } = {}) {
  if (!existsSync(bin)) throw new Error(`skill-workshop CLI missing: ${bin}`);
  const r = await tryRun(bin, argv, { env: swEnv(), timeoutMs });
  if (r.code !== 0) {
    const err = r.stderr.trim();
    // A refusal is one "skill-workshop: <why>" line; an argument error is argparse's usage text, whose last line says why.
    const why = (err.match(/^skill-workshop: (.+)$/m)?.[1] ?? err.split('\n').filter(Boolean).at(-1) ?? (r.stdout.trim() || `exited ${r.code}`)).slice(0, 500);
    throw Object.assign(new Error(`skill-workshop ${argv[0]}: ${why}`), { code: r.code });
  }
  return r.stdout;
}
function parsed(out, what) {
  try { return JSON.parse(out); } catch { throw new Error(`skill-workshop ${what} did not print JSON (a CLI older than this Drover?): ${String(out).trim().slice(0, 200)}`); }
}
/** A write's answer, with the id of the change it recorded on top (the truth file's op event keeps top-level ids). */
const written = (res) => ({ ok: true, id: res?.change?.id ?? null, ...res });

/**
 * Live skills (most used first: uses, lastUsed, bytes, description, files), archived skills with their newest
 * versions, waiting drafts and the learning mode. A host without the CLI answers available: false with the reason,
 * so a view can say so instead of failing.
 */
export async function list() {
  const bin = skillWorkshopBin();
  if (!existsSync(bin)) return { available: false, bin, error: `skill-workshop CLI missing: ${bin}`, mode: null, skills: [], archived: [], drafts: [] };
  return { available: true, ...parsed(await sw(['list', '--json'], { bin }), 'list') };
}

/** The change feed, newest first: one row per create, patch, archive, restore, diet or undo, with what to undo it by. */
export async function changes({ limit, run, skill } = {}) {
  const argv = ['changes', '--json', ...opt('limit', maybe(limit, (v) => int(v, 'limit', 1, 1000))),
    ...opt('run', maybe(run, (v) => shaped(/^r-[a-z0-9]{4,32}$/, 'run', 'a review run id (r-…)')(v, 'run'))), ...opt('skill', maybe(skill, (v) => nameOf(v, 'skill')))];
  const rows = parsed(await sw(argv), 'changes');
  return Array.isArray(rows) ? rows : [];
}

/**
 * One file's text: a live skill's (name), a saved version's (name + version) or a waiting draft's (draft). file
 * defaults to SKILL.md.
 */
export async function read({ name, file, version, draft } = {}) {
  const f = maybe(file, fileOf);
  if (draft !== undefined && draft !== null && draft !== '') {
    if (name || version) throw new Error('read takes a draft id, or a name (and optional version), not both');
    const id = draftOf(draft, 'draft');
    return { draft: id, file: f ?? 'SKILL.md', text: await sw(['view', `--draft=${id}`, ...opt('file', f)]) };
  }
  const n = nameOf(name);
  const v = maybe(version, versionOf);
  return { name: n, file: f ?? 'SKILL.md', version: v ?? null, text: await sw(['view', ...opt('file', f), ...opt('version', v), '--', n]) };
}

/** A skill's saved versions (a full copy before each change), newest first. */
export async function versions({ name } = {}) {
  const vs = parsed(await sw(['versions', '--json', '--', nameOf(name)]), 'versions');
  return Array.isArray(vs) ? vs : [];
}

/** Drafts waiting for review (propose mode saves background reviews here): id, skill, reason, replaces, absorbs. */
export async function drafts({ skill } = {}) {
  const ds = parsed(await sw(['drafts', '--json', ...opt('skill', maybe(skill, (v) => nameOf(v, 'skill')))]), 'drafts');
  return Array.isArray(ds) ? ds : [];
}

/** Which skills sessions read: uses, last read, engines, SKILL.md bytes, whether it is a learned one. */
export async function usage({ all = false, days } = {}) {
  const rows = parsed(await sw(['usage', '--json', ...(truthy(all) ? ['--all'] : []), ...opt('days', maybe(days, (v) => int(v, 'days', 1, 3650)))]), 'usage');
  return Array.isArray(rows) ? rows : [];
}

/** The learning mode: auto, propose or off. */
export async function mode() { return { mode: (await sw(['mode'])).trim() }; }

// ---- writes: always --actor user (the CLI's actors are agent, review, curator and user; a Drover client is the owner)

/** Hide a live skill (a full copy is saved first; restore brings it back). */
export async function archive({ name, reason, absorbedInto } = {}) {
  const argv = ['archive', '--json', '--actor=user', `--reason=${reasonOf(reason)}`, ...opt('absorbed-into', maybe(absorbedInto, (v) => nameOf(v, 'absorbedInto'))), '--', nameOf(name)];
  return written(parsed(await sw(argv), 'archive'));
}

/** Bring back a saved version (default the newest), of a live skill or an archived one. Undoable like any change. */
export async function restore({ name, version, reason } = {}) {
  const argv = ['restore', '--json', '--actor=user', ...opt('version', maybe(version, versionOf)), ...opt('reason', maybe(reason, reasonOf)), '--', nameOf(name)];
  return written(parsed(await sw(argv), 'restore'));
}

/** Revert one change (c-…) or every change of one background review (r-…). Twice answers already-undone. */
export async function undo({ id } = {}) {
  const res = parsed(await sw(['undo', '--json', '--actor=user', '--', changeOf(id)]), 'undo');
  const rows = Array.isArray(res?.changes) ? res.changes : [];
  return { ok: true, id: rows.at(-1)?.id ?? null, count: rows.length, ...res };
}

/** Save a waiting draft through the normal versioned write (and archive the skill it absorbs, if any). */
export async function applyDraft({ id } = {}) {
  return written(parsed(await sw(['apply-draft', '--json', '--actor=user', '--', draftOf(id)]), 'apply-draft'));
}

/** Delete a waiting draft; no skill changes. */
export async function discardDraft({ id } = {}) {
  const meta = parsed(await sw(['discard', '--json', '--actor=user', '--', draftOf(id)]), 'discard');
  return { ok: true, ...meta };
}

/** Set the learning mode (a synced setting: every machine sharing the dotfiles store follows it). */
export async function setMode({ mode: m } = {}) {
  if (!MODES.includes(m)) throw new Error(`mode must be one of ${MODES.join(', ')}`);
  return { ok: true, mode: (await sw(['mode', '--actor=user', m])).trim() };
}

