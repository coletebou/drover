// Handoff lineage: which live session carries on the work of a Claude Code session that handed off. A handoff tool
// that starts a fresh session to continue one records the chain on disk, and that record is what is read here; a
// session's name is never parsed for a generation number.
//
//   <markers>/<session id>.json      {"gen": 3, "chain": "<name>", "dir": "<chain dir>"}, one per session in a chain
//   <chain dir>/chain.json           {"name": "<name>", ...}
//   <chain dir>/gen-NN/session.json  generation NN: {"session_id", "name", "ssh_alias", "started_at",
//                                    "first_response_at", ...}; NN+1 continues NN
//
// <markers> is DROVER_HANDOFF_CHAINS, else HANDOFF_CHAIN_STATE_DIR (the writer's own setting), else
// ~/.claude/state/handoff-chain. A chain never branches: it holds one record per generation. sessions.message
// (core/api.js) asks here only when the Claude session it was given is not live.
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { envvar } from './envvars.js';

export function markersDir(env = process.env) {
  return envvar('HANDOFF_CHAINS', env) || env.HANDOFF_CHAIN_STATE_DIR || path.join(env.HOME || homedir(), '.claude', 'state', 'handoff-chain');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A short id as people pass one around ("1a2b3c4d"): 8 hex digits or more.
const ID_PREFIX = /^[0-9a-f]{8}[0-9a-f-]*$/i;
const GEN_DIR = /^gen-(\d+)$/;
// The writer's file name for a session id.
const safeId = (sid) => String(sid).replace(/[^A-Za-z0-9._-]/g, '_');
// Absent: nothing there. Anything else that keeps a file from being read (no file descriptor left, no permission,
// text that is not JSON) throws, so a chain that could not be read is never taken for one that is not there, which
// could hide an ambiguity. The writer replaces these files whole, so a reader never sees half of one.
const absent = (e) => e.code === 'ENOENT' || e.code === 'ENOTDIR';
async function readJson(f) {
  let text;
  try { text = await readFile(f, 'utf8'); } catch (e) { if (absent(e)) return null; throw e; }
  try { return JSON.parse(text); } catch { throw new Error(`${f} is not JSON`); }
}
async function list(dir) { try { return await readdir(dir); } catch (e) { if (absent(e)) return []; throw e; } }

function markerOf(m) {
  const gen = Number(m?.gen);
  if (!Number.isInteger(gen) || gen < 1 || typeof m.dir !== 'string' || !path.isAbsolute(m.dir)) return null;
  return { gen, dir: path.resolve(m.dir), chain: typeof m.chain === 'string' ? m.chain : null };
}

// Files are read one at a time here: a host can hold thousands of markers, and opening them all at once can run out
// of file descriptors.
async function allMarkers(dir) {
  const out = [];
  for (const n of await list(dir)) if (n.endsWith('.json')) { const m = markerOf(await readJson(path.join(dir, n))); if (m) out.push(m); }
  return out;
}

/**
 * One chain, its generations oldest first: { gen, sessionId, name, alias, started }. null when dir holds no chain.json,
 * so a marker cannot point anywhere else. A generation directory without a record that names its session throws, as
 * an unreadable file does: the writer never leaves one, and it could be the generation a target names.
 */
export async function loadChain(dir, fallbackName = null) {
  const chain = await readJson(path.join(dir, 'chain.json'));
  if (!chain || typeof chain !== 'object') return null;
  const gens = [];
  for (const [n, g] of (await list(dir)).map((x) => x.match(GEN_DIR)).filter(Boolean)) {
    const file = path.join(dir, n, 'session.json');
    const r = await readJson(file);
    if (typeof r?.session_id !== 'string' || !r.session_id) throw new Error(`${file} names no session`);
    gens.push({ gen: Number(g), sessionId: r.session_id, name: typeof r.name === 'string' && r.name ? r.name : null,
      alias: typeof r.ssh_alias === 'string' && r.ssh_alias ? r.ssh_alias : null, started: Boolean(r.started_at || r.first_response_at) });
  }
  gens.sort((a, b) => a.gen - b.gen);
  return { dir, name: typeof chain.name === 'string' && chain.name ? chain.name : fallbackName ?? path.basename(dir), gens };
}

/**
 * The chains target is a generation of, [{ chain, gen, matched }]: gen the newest generation it matches, matched every
 * one (a name can be recorded for more than one generation). sessionId given (target is that session's full id): that
 * id only. Otherwise a generation's session id, an id prefix of 8 hex digits or more, or its name. A full id's own
 * marker names its chain at once; anything else reads every chain the markers name.
 */
export async function chainsOf(target, { sessionId = null, dir = markersDir() } = {}) {
  const want = sessionId ?? String(target ?? '');
  if (!want) return [];
  if (UUID.test(want)) {
    const m = markerOf(await readJson(path.join(dir, `${safeId(want)}.json`)));
    const chain = m ? await loadChain(m.dir, m.chain) : null;
    const g = chain?.gens.find((x) => x.sessionId === want);
    if (g) return [{ chain, gen: g.gen, matched: [g] }];
  }
  const matches = sessionId ? (g) => g.sessionId === sessionId
    : (g) => g.sessionId === want || g.name === want || (ID_PREFIX.test(want) && g.sessionId.startsWith(want));
  const dirs = new Map();
  for (const m of await allMarkers(dir)) if (!dirs.has(m.dir)) dirs.set(m.dir, m.chain);
  const out = [];
  for (const [d, name] of dirs) {
    const chain = await loadChain(d, name);
    const matched = chain?.gens.filter(matches) ?? [];
    if (matched.length) out.push({ chain, gen: matched.at(-1).gen, matched });
  }
  return out;
}

/**
 * A generation's state here, from this host's Claude registry (session id -> entry): live, no messaging socket (its
 * process runs without an inbox), ended, elsewhere (started on another host, alias; only that host knows), or not
 * started (its launch never got that far).
 */
export function stateOf(g, registry) {
  const e = registry.get(g.sessionId);
  if (e?.alive) return e.socket ? 'live' : 'no messaging socket';
  if (e) return 'ended';
  if (g.alias) return 'elsewhere';
  return g.started ? 'ended' : 'not started';
}

/** session id -> registry entry, a live entry ahead of a dead one left by the same session. */
export function registryIndex(entries = []) {
  const out = new Map();
  for (const e of entries) {
    if (!e?.sessionId) continue;
    const cur = out.get(e.sessionId);
    if (!cur || (e.alive && !cur.alive)) out.set(e.sessionId, e);
  }
  return out;
}

// g: a generation ({ sessionId }) or a candidate ({ id }).
const label = (g) => `${g.name ?? 'unnamed'} (generation ${g.gen}, ${g.sessionId ?? g.id})`;
/** One candidate ({ gen, id, name, state, host? }) for an error message. */
function describe(c) {
  if (c.state === 'elsewhere') return `${label(c)} on ${c.host}: resend with host ${c.host}`;
  return `${label(c)}, ${c.state}`;
}
const candidateOf = (chain, g, state) => ({ chain: chain.name, gen: g.gen, id: g.sessionId ?? null, name: g.name ?? null, state, ...(g.alias ? { host: g.alias } : {}) });

/**
 * Where the work of a session that is not live went. The successor is the newest generation after it that got
 * started (one whose launch never got that far is passed over), and it is delivered to only when it is live here,
 * target names a generation of exactly one chain, that generation does not itself run here (a renamed session still
 * answers to its old name in the chain record), and no other session answers to target: answering lists the sessions
 * the caller found under it ({ id, name }, by name or id prefix), each of which must be a generation of that chain. A
 * live generation in between handed off to the successor, so it is not a candidate.
 *
 *   { to: { session, gen, id, name }, chain, from, why }   deliver to `to.session` (a registry entry); why reads
 *                                                          "generation 2 of handoff chain c, whose ..."
 *   { to: null, note, candidates }                         do not; note (null when target is in no chain) and
 *                                                          candidates ({ chain, gen, id, name, state, host? }) say
 *                                                          what the chain holds
 * Throws when a marker or a chain cannot be read (see readJson).
 */
export async function successor(target, { sessionId = null, registry = [], answering = [], dir } = {}) {
  const at = dir ? { dir } : {};
  const found = await chainsOf(target, { sessionId, ...at });
  const listed = new Set(answering.map((a) => a.id));
  // A session listed under target as its name, a name no record of its chain keeps (it was renamed): its own marker
  // finds that chain. One listed by an id prefix only is not followed this way: a short prefix could be anyone's.
  for (const { id, name } of answering) {
    if (name === target && !found.some((f) => f.chain.gens.some((g) => g.sessionId === id))) found.push(...await chainsOf(id, { sessionId: id, ...at }));
  }
  if (!found.length) return { to: null, note: null, candidates: [] };
  const reg = registryIndex(registry);
  const rows = found.map(({ chain, matched: byRecord }) => {
    // A session listed under target that is a generation of this chain is one it names too: its name now need not be
    // the one its record keeps.
    const matched = chain.gens.filter((g) => byRecord.includes(g) || listed.has(g.sessionId));
    const from = matched.at(-1), gen = from.gen;
    const later = chain.gens.filter((g) => g.gen > gen).reverse().map((g) => ({ g, state: stateOf(g, reg) }));
    const head = later.find((x) => x.state !== 'not started') ?? null;
    // What the sender is shown: the head, and every other later generation still live here or started elsewhere.
    const shown = later.filter((x) => x === head || ['live', 'no messaging socket', 'elsewhere'].includes(x.state)).map((x) => candidateOf(chain, x.g, x.state));
    return { chain, from, matched, later, head, shown };
  });
  const inChains = new Set(rows.flatMap((r) => r.matched.map((g) => g.sessionId)));
  const outside = [...listed].filter((x) => !inChains.has(x));
  // A generation the target names may still run under another name (a session can be renamed): it is live, so its
  // message is not sent on.
  const stillRuns = rows.flatMap((r) => r.matched.map((g) => ({ chain: r.chain, g, state: stateOf(g, reg) })))
    .filter((x) => x.state === 'live' || x.state === 'no messaging socket');
  if (rows.length === 1 && !outside.length && !stillRuns.length && rows[0].head?.state === 'live') {
    const { chain, from, later, head } = rows[0];
    const passed = later.filter((x) => x !== head && x.state === 'live').map((x) => x.g.name ?? x.g.sessionId);
    const why = `generation ${from.gen} of handoff chain ${chain.name}, whose newest live generation is ${head.g.name ?? head.g.sessionId} (generation ${head.g.gen})`
      + (passed.length ? `; ${passed.join(', ')} ${passed.length > 1 ? 'are' : 'is'} live too but handed off` : '');
    return { to: { session: reg.get(head.g.sessionId), gen: head.g.gen, id: head.g.sessionId, name: head.g.name }, chain: chain.name, from, why };
  }
  const candidates = [...stillRuns.map((x) => candidateOf(x.chain, x.g, x.state)), ...rows.flatMap((r) => r.shown)];
  let note;
  if (stillRuns.length) {
    note = stillRuns.map((x) => `${label(x.g)} of handoff chain ${x.chain.name} still runs here${x.g.name === target ? ' under another name' : ''}`).join('; ')
      + `, so nothing was redirected: send to ${stillRuns.length > 1 ? 'one by its' : 'its'} session id`;
  } else if (outside.length) {
    note = `${target} also names ${outside.length > 1 ? `${outside.length} sessions` : 'a session'} in no handoff chain (${outside.join(', ')}), so nothing was redirected: `
      + rows.map((r) => `chain ${r.chain.name}: ${label(r.from)}${r.shown.length ? `, then ${r.shown.map(describe).join('; ')}` : ' is its newest generation'}`).join(' | ');
  } else if (rows.length > 1) {
    note = `${target} is a generation of ${rows.length} handoff chains, so nothing was redirected: `
      + rows.map((r) => `chain ${r.chain.name}: ${r.shown.length ? r.shown.map(describe).join('; ') : `${label(r.from)} is its newest generation`}`).join(' | ');
  } else {
    const { chain, from, shown } = rows[0];
    note = shown.length
      ? `handoff chain ${chain.name} has no live successor of ${label(from)}: ${shown.map(describe).join('; ')}`
      : `${label(from)} is the newest generation of handoff chain ${chain.name}; nothing continues it`;
  }
  return { to: null, note, candidates };
}
