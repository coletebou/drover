// Hybrid search over one host's index: FTS5 BM25 for words and a vector kNN
// for meaning, fused by reciprocal rank (k = 60), plus a boost for exact
// strings no embedding holds reliably (#1234, commit SHAs, file paths,
// identifiers). A mild recency factor breaks ties toward newer work.
// Pure over a Store; tests in test/search-index.test.js.
import { queryText } from './embed.js';
import { REFLECTION_STATUSES } from '../memory.js';
import * as plugins from '../plugins.js';
import { isRepoIdentity } from '../bots/access.js';

const RRF_K = 60;
const LEG = 200;           // candidates per leg
export const KINDS = ['claude', 'subagent', 'codex', 'wal', 'memory', 'doc', 'reflection', 'preserved'];
const list = (v) => (Array.isArray(v) ? v : v ? String(v).split(',') : []).map((x) => String(x).trim()).filter(Boolean);

/** Words for the FTS leg: letters/digits runs of 2+ chars, deduped, at most 24. */
export function ftsTerms(q) {
  const seen = new Set();
  for (const m of String(q).toLowerCase().matchAll(/[\p{L}\p{N}]{2,}/gu)) { if (seen.size >= 24) break; seen.add(m[0]); }
  return [...seen];
}

/** FTS5 MATCH expression: every term quoted (no operator injection), OR-ed so BM25 ranks partial matches. */
export function ftsExpr(terms) { return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR '); }

/**
 * Strings to match exactly: MR (!N) and activity (#N) refs, hex SHAs (7-40,
 * at least one digit and one letter), paths and dotted/underscored identifiers.
 */
export function exactTokens(q) {
  const out = new Set();
  const s = String(q);
  for (const m of s.matchAll(/(?:^|[\s(])([!#]\d{2,7})\b/g)) out.add(m[1]);
  for (const m of s.matchAll(/\b([0-9a-f]{7,40})\b/gi)) if (/\d/.test(m[1]) && /[a-f]/i.test(m[1])) out.add(m[1].toLowerCase());
  for (const m of s.matchAll(/(?:^|\s)((?:[\w.~-]+\/)+[\w.-]+|[\w-]+\.(?:js|ts|tsx|mjs|py|sh|md|json|yml|yaml|tf|swift|go|rs)\b|[A-Za-z][\w]*_[\w]+)/g)) if (m[1].length >= 4) out.add(m[1]);
  return [...out].slice(0, 8);
}

/** Transcript kinds: files on the answering host itself, so a chunk with no recorded host is that host's own. */
const LOCAL_FILES = ['claude', 'subagent', 'codex'];
const HOST_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const where = ({ kinds, days, project, repoIdentity, originHosts, role, session, status }, alias = 'c', { provenance = true, checkouts = true } = {}) => {
  const sql = [], args = [];
  const ks = list(kinds).filter((k) => KINDS.includes(k));
  if (ks.length) { sql.push(`${alias}.kind IN (${ks.map(() => '?').join(',')})`); args.push(...ks); }
  // A reflection's status lives beside its chunk (the reflections table), so a status filter keeps only reflections.
  const st = list(status).filter((x) => REFLECTION_STATUSES.includes(x));
  if (st.length) { sql.push(`${alias}.kind = 'reflection' AND ${alias}.ref IN (SELECT id FROM reflections WHERE status IN (${st.map(() => '?').join(',')}))`); args.push(...st); }
  if (days) { sql.push(`${alias}.ts >= ?`); args.push(new Date(Date.now() - Number(days) * 86400_000).toISOString()); }
  if (repoIdentity !== undefined) {
    if (!isRepoIdentity(repoIdentity)) throw new Error('invalid canonical repo identity');
    // Every leg and representative selection is scoped BEFORE ranking/limit/dedup, on the chunk's OWN provenance: the
    // checkout its turn ran in, and where it was written. A session's first cwd says nothing about a later turn in
    // another checkout, and a repo label never establishes authority. Unknown provenance (rows indexed before
    // chunks carried it, a line with no cwd, an index file without the columns) matches nothing.
    if (!provenance) sql.push('0 = 1');
    else {
      const hs = list(originHosts);
      if (hs.some((h) => !HOST_NAME.test(h))) throw new Error('invalid origin host');
      // A transcript is this host's own file: no recorded host. A reflection was written on the host it names, which
      // must be one of originHosts (none given: no reflection), in the exact checkout its state row records (the
      // exported `checkout`, never the CLI's `cwd`, which is the main worktree's root even for an item written in a
      // private worktree; an index without that column has no reflection for a tenant), and its repo label, when it
      // has one, must not contradict that checkout.
      const refl = hs.length && checkouts ? ` OR (${alias}.kind = 'reflection' AND ${alias}.host IN (${hs.map(() => '?').join(',')}) AND (${alias}.project IS NULL OR ${alias}.project IN (?, ?))
        AND EXISTS (SELECT 1 FROM reflections rf WHERE rf.id = ${alias}.ref AND rf.checkout = ${alias}.cwd AND rf.host = ${alias}.host))` : '';
      sql.push(`${alias}.cwd = ? AND ((${alias}.kind IN (${LOCAL_FILES.map(() => '?').join(',')}) AND ${alias}.host IS NULL)${refl})`);
      args.push(repoIdentity, ...LOCAL_FILES, ...(refl ? [...hs, repoIdentity, repoIdentity.split('/').pop()] : []));
    }
  }
  if (project && repoIdentity === undefined) { sql.push(`${alias}.project LIKE ? ESCAPE '\\'`); args.push(`%${String(project).replace(/[\\%_]/g, (c) => '\\' + c)}%`); }
  if (role) { sql.push(`${alias}.role = ?`); args.push(String(role)); }
  if (session) { sql.push(`${alias}.session_id LIKE ? ESCAPE '\\'`); args.push(`${String(session).replace(/[\\%_]/g, (c) => '\\' + c)}%`); }
  return { sql: sql.length ? ' AND ' + sql.join(' AND ') : '', args };
};

/** A ~320-char window of a chunk around the first query term (or its start), on one line. */
export function snippet(text, terms, max = 320) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  const low = flat.toLowerCase();
  let at = -1;
  for (const t of terms) { const i = low.indexOf(t); if (i >= 0 && (at < 0 || i < at)) at = i; }
  if (at < 0 || flat.length <= max) return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
  const start = Math.max(0, Math.min(at - Math.floor(max / 3), flat.length - max));
  const body = flat.slice(start, start + max);
  return (start > 0 ? '…' : '') + body.trim() + (start + max < flat.length ? '…' : '');
}

/**
 * @param {import('./store.js').Store} store
 * @param {{embed?: (texts: string[]) => Promise<Float32Array[]>}} engine  null embed = keyword only
 * @param {object} q  { query, limit=20, mode='hybrid'|'keyword'|'semantic', kinds, days, project, repoIdentity, originHosts, role, session, status, perSession=3 }
 *   A hit whose chunk has its own provenance carries provenance: { cwd, host } (host null: the answering host's own file).
 */
export async function search(store, engine, q) {
  const query = String(q.query ?? '').trim();
  if (!query) throw new Error('query must be a non-empty string');
  if (query.length > 2000) throw new Error('query too long');
  const limit = Math.max(1, Math.min(100, Number(q.limit) || 20));
  const perSession = Math.max(1, Math.min(50, Number(q.perSession) || 3));
  const mode = ['hybrid', 'keyword', 'semantic'].includes(q.mode) ? q.mode : 'hybrid';
  const t0 = Date.now();
  const prov = store.provenance !== false;
  const f = where(q, 'c', { provenance: prov, checkouts: store.reflectionCheckouts !== false });
  const scoped = q.repoIdentity !== undefined;
  // A checkout-scoped search matches a chunk's own words only: a transcript's title belongs to its whole session (the
  // first prompt, an ai-title), which may have run in another checkout.
  const match = (expr) => (scoped ? `text : (${expr})` : expr);
  const terms = ftsTerms(query);
  const exact = exactTokens(query);
  // Every leg is keyed by text hash (a resumed or forked session carries identical copies with their own
  // row ids): fts hash -> rank, vec hash -> {rank, sim}, exact = set of hashes. Fusion scores each text
  // once; a representative chunk (the newest copy that passes the filters) is chosen afterwards.
  const legs = { fts: new Map(), vec: new Map(), exact: new Set() };
  const notes = [];

  // ---- keyword leg (BM25, one row per hash; the inner LIMIT bounds the work)
  if (mode !== 'semantic' && terms.length) {
    const rows = store.db.prepare(`SELECT hash, MIN(r) AS r FROM (SELECT c.hash AS hash, bm25(chunks_fts, 1.0, 0.4) AS r
      FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid WHERE chunks_fts MATCH ?${f.sql} ORDER BY r LIMIT ${LEG * 20})
      GROUP BY hash ORDER BY r LIMIT ${LEG}`).all(match(ftsExpr(terms)), ...f.args);
    rows.forEach((r, i) => legs.fts.set(r.hash, i + 1));
  }
  // ---- exact strings: candidates from FTS on the token's word parts, confirmed by substring
  for (const tok of exact) {
    const parts = ftsTerms(tok);
    if (!parts.length) continue;
    const rows = store.db.prepare(`SELECT hash, MAX(ts) AS ts FROM (SELECT c.hash AS hash, c.ts AS ts
      FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid WHERE chunks_fts MATCH ? AND instr(lower(c.text), ?) > 0${f.sql} ORDER BY c.ts DESC LIMIT ${LEG * 20})
      GROUP BY hash ORDER BY ts DESC LIMIT ${LEG}`).all(match(parts.map((p) => `"${p}"*`).join(' ')), tok.toLowerCase(), ...f.args);
    for (const r of rows) legs.exact.add(r.hash);
  }
  // ---- vector leg
  // Not for a checkout-scoped search: a transcript chunk's vector embeds its session's title (docText) with its words,
  // and that title may come from another checkout, so ranking by it would let a tenant probe a title it never sees.
  let vectorState = 'off';
  if (mode !== 'keyword' && scoped) notes.push('vector leg off for a checkout-scoped search');
  else if (mode !== 'keyword') {
    if (!engine?.embed) vectorState = 'unavailable';   // checked first: no engine, no need to load the vectors
    else {
      const m = store.vectors();
      if (!m.n) vectorState = 'empty';
      else {
        try {
          const [qv] = await engine.embed([queryText(query)]);
          // With filters, rank only eligible vectors: the 200 nearest overall could all be filtered out.
          const allow = f.sql ? new Set(store.db.prepare(`SELECT DISTINCT c.hash AS hash FROM chunks c WHERE 1 = 1${f.sql}`).all(...f.args).map((r) => r.hash)) : null;
          const top = allow && !allow.size ? [] : m.topK(qv, LEG, allow);
          top.forEach(([h, sim], i) => legs.vec.set(h, { rank: i + 1, sim }));
          vectorState = 'ok';
        } catch (e) { vectorState = 'error'; notes.push(`vector leg failed: ${e.message}`); }
      }
    }
  }

  // ---- fuse by hash, then pick each text's representative chunk
  const hashes = [...new Set([...legs.fts.keys(), ...legs.vec.keys(), ...legs.exact])];
  if (!hashes.length) return { query, mode, vector: vectorState, results: [], sessions: [], ms: Date.now() - t0, notes };
  const rep = new Map();
  for (let i = 0; i < hashes.length; i += 400) {
    const part = hashes.slice(i, i + 400);
    const rows = store.db.prepare(`SELECT c.id, c.path, c.kind, c.session_id, c.project, c.role, c.ts, c.text, c.hash, c.ref,
        COALESCE(s.title, c.title) AS title, s.cwd AS cwd, ${prov ? 'c.cwd AS chunk_cwd, c.host AS chunk_host' : 'NULL AS chunk_cwd, NULL AS chunk_host'}
      FROM chunks c LEFT JOIN sources s ON s.path = c.path WHERE c.hash IN (${part.map(() => '?').join(',')})${f.sql} ORDER BY c.ts DESC`).all(...part, ...f.args);
    for (const r of rows) if (!rep.has(r.hash)) rep.set(r.hash, r);
  }
  const now = Date.now();
  const scored = [...rep.values()].map((r) => {
    const fr = legs.fts.get(r.hash), vr = legs.vec.get(r.hash), ex = legs.exact.has(r.hash);
    let score = (fr ? 1 / (RRF_K + fr) : 0) + (vr ? 1 / (RRF_K + vr.rank) : 0) + (ex ? 2 / RRF_K : 0);
    const age = r.ts ? (now - Date.parse(r.ts)) / 86400_000 : 365;
    score *= 0.85 + 0.15 * Math.pow(2, -Math.max(0, age) / 30);
    return { r, score, legs: { fts: fr ?? null, vec: vr ? { rank: vr.rank, sim: Number(vr.sim.toFixed(4)) } : null, exact: ex } };
  }).sort((a, b) => b.score - a.score);

  // ---- per-session cap, then shape
  const perKey = new Map(), results = [], sessions = new Map();
  for (const x of scored) {
    // Cap per session; sessionless truth-file events (notes, features, handoffs) and reflections (which keep the
    // session that wrote them) are each their own record.
    const key = x.r.kind === 'reflection' ? x.r.path : x.r.session_id ?? (x.r.kind === 'wal' ? `${x.r.path}#${x.r.ref}` : x.r.path);
    const n = perKey.get(key) ?? 0;
    const sess = sessions.get(key) ?? { sessionId: x.r.session_id, kind: x.r.kind, title: x.r.title, project: x.r.project, best: x.score, hits: 0, lastTs: x.r.ts };
    sess.hits++; if (x.r.ts && (!sess.lastTs || x.r.ts > sess.lastTs)) sess.lastTs = x.r.ts;
    sessions.set(key, sess);
    if (n >= perSession || results.length >= limit) continue;
    perKey.set(key, n + 1);
    const hit = {
      score: Number(x.score.toFixed(5)), kind: x.r.kind, sessionId: x.r.session_id, title: x.r.title, project: x.r.project, cwd: x.r.chunk_cwd ?? x.r.cwd,
      role: x.r.role, ts: x.r.ts, snippet: snippet(x.r.text, [...exact.map((e) => e.toLowerCase()), ...terms]), hash: x.r.hash, ref: x.r.ref, path: x.r.path, legs: x.legs,
      ...(x.r.chunk_cwd ? { provenance: { cwd: x.r.chunk_cwd, host: x.r.chunk_host ?? null } } : {}),
    };
    results.push(hit);
  }
  // A reflection hit carries what a caller needs to act on it: the item id, its current status and repo.
  const refl = results.filter((r) => r.kind === 'reflection');
  if (refl.length) {
    const state = store.reflectionsById(refl.map((r) => r.ref));
    for (const r of refl) { const s = state.get(r.ref); Object.assign(r, { id: r.ref, status: s?.status ?? null, repo: s?.repo ?? r.project, origin: s?.origin ?? null }); }
  }
  // A preserved ref hit carries the ref and the command that restores it.
  const restore = plugins.preservedSearch()?.restoreCommand;
  for (const r of results) if (r.kind === 'preserved' && r.ref) Object.assign(r, { id: r.ref, restore: typeof restore === 'function' ? restore(r.ref) : null });
  // How many sessions carry each result's exact text (a fork or resume copies its parent's history).
  const copies = store.copies(results.map((r) => r.hash));
  for (const r of results) { const n = Math.max(r.copies ?? 1, copies.get(r.hash) ?? 1); if (n > 1) r.copies = n; else delete r.copies; }
  return {
    query, mode, vector: vectorState, results,
    sessions: [...sessions.values()].sort((a, b) => b.best - a.best).slice(0, limit).map((s) => ({ ...s, best: Number(s.best.toFixed(5)) })),
    counts: { fts: legs.fts.size, vec: legs.vec.size, exact: legs.exact.size },
    ms: Date.now() - t0, notes,
  };
}

/**
 * Merge per-host results into one list: identical chunk text found on several
 * hosts (dotsync'd memory, the merge=union truth file) appears once with every
 * host it was found on; ranking is by score, then recency. host is the host that
 * answered; origins keeps every folded copy's own provenance, { cwd, host } with
 * host the host that wrote it (the answering host for its own transcripts), or null
 * for a copy that carried none, so no copy takes another's authority.
 */
export function mergeHosts(perHost, { limit = 20 } = {}) {
  const byHash = new Map();
  const origin = (r, host) => (r.provenance && typeof r.provenance === 'object' ? { cwd: r.provenance.cwd ?? null, host: r.provenance.host ?? host } : null);
  for (const { host, results = [] } of perHost) {
    for (const r of results) {
      const cur = byHash.get(r.hash);
      if (!cur) byHash.set(r.hash, { ...r, host, hosts: [host], origins: [origin(r, host)] });
      else {
        if (!cur.hosts.includes(host)) cur.hosts.push(host);
        cur.origins.push(origin(r, host));
        if (r.score > cur.score) Object.assign(cur, { ...r, host, hosts: cur.hosts, origins: cur.origins });
      }
    }
  }
  return [...byHash.values()].sort((a, b) => b.score - a.score || String(b.ts ?? '').localeCompare(String(a.ts ?? ''))).slice(0, limit);
}
