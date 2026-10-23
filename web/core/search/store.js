// The search index: one SQLite file per host (node:sqlite, built into Node 24;
// FTS5 verified on every fleet box 2026-10-15). Chunks carry their text and
// where they came from; chunks_fts is an external-content FTS5 index over them;
// vecs holds one quantized vector per distinct chunk text (sha1), so a turn
// copied into a resumed or forked session is embedded once. sources records how
// far each file has been read so indexing is incremental. reflections holds each
// reflection item's state (status, kind, repo) beside its chunk, which lives at
// path reflection:<id>: the state changes without the text, so it never re-embeds.
// preserved holds each preserved ref's tip and text hash beside its chunks at path
// preserved:<ref> (refs from the plugin that keeps them, core/plugins.js search.preserved),
// so an unchanged ref is never re-chunked.
// Each chunk also carries its own provenance: cwd, the checkout that turn (or reflection) was in, and host, the
// host that wrote it when that is not this index's host (reflections; NULL for this host's own transcripts). Tenant
// search is authorized on these per-chunk values, never on a source's first cwd or a repo label; rows from before
// the columns existed have neither and are invisible to it until re-read (indexer.js EXTRACT_VERSION). A Codex chunk
// whose checkout waits for the next turn_context (extract.js codexAttribute) has cwd NULL and pending 1 until then.
// A reflection's cwd is its exported `checkout` (the git top level it was written in), mirrored in reflections.checkout.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { VectorMatrix, DIMS } from './vec.js';
import { envvar } from '../envvars.js';
import { stateDir } from '../paths.js';

export const STATE_DIR = stateDir();
export const DB_PATH = envvar('SEARCH_DB') ?? path.join(STATE_DIR, 'search.sqlite');
const SCHEMA = 1;

export const sha1 = (s) => createHash('sha1').update(String(s)).digest('hex');
/** Chunk roles indexed for keyword search only (no vector): what an agent ran, one line per tool call. */
export const KEYWORD_ONLY = ['command'];
const EMBEDDABLE = `COALESCE(c.role, '') NOT IN (${KEYWORD_ONLY.map((r) => `'${r}'`).join(', ')})`;
/** Failure marks newer than this keep a chunk out of the backfill; older ones get another try. */
const failedSince = () => new Date(Date.now() - 86400_000).toISOString();

export class Store {
  /** @param {string} file  @param {{readOnly?: boolean}} opts */
  constructor(file = DB_PATH, { readOnly = false } = {}) {
    this.file = file; this.readOnly = readOnly;
    this.st = {};          // prepared statements, by SQL
    this.matrix = null;    // in-memory vectors, loaded on first search
    this.dirty = false;    // a purge happened: unreferenced vectors are collected at the end of the pass
    if (!readOnly) mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (readOnly && !existsSync(file)) throw new Error('search index not built on this host yet');
    this.db = new DatabaseSync(file, readOnly ? { readOnly: true } : {});
    if (!readOnly) { try { chmodSync(file, 0o600); } catch { /* best effort */ } }
    this.db.exec('PRAGMA busy_timeout = 5000;');
    if (!readOnly) { this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;'); this.#migrate(); }
  }

  #migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS sources (
        path TEXT PRIMARY KEY, kind TEXT NOT NULL, session_id TEXT, title TEXT, cwd TEXT, project TEXT,
        size INTEGER NOT NULL DEFAULT 0, mtime_ms REAL NOT NULL DEFAULT 0, ino TEXT, offset INTEGER NOT NULL DEFAULT 0,
        indexed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY, path TEXT NOT NULL, kind TEXT NOT NULL, session_id TEXT, project TEXT, role TEXT,
        ts TEXT, title TEXT, text TEXT NOT NULL, hash TEXT NOT NULL, ref TEXT
      );
      CREATE INDEX IF NOT EXISTS chunks_path ON chunks(path);
      CREATE INDEX IF NOT EXISTS chunks_hash ON chunks(hash);
      CREATE INDEX IF NOT EXISTS chunks_session ON chunks(session_id);
      CREATE INDEX IF NOT EXISTS chunks_ts ON chunks(ts);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, title, content='chunks', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
      CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts(rowid, text, title) VALUES (new.id, new.text, new.title);
      END;
      CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, text, title) VALUES ('delete', old.id, old.text, old.title);
      END;
      CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE OF text, title ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, text, title) VALUES ('delete', old.id, old.text, old.title);
        INSERT INTO chunks_fts(rowid, text, title) VALUES (new.id, new.text, new.title);
      END;
      CREATE TABLE IF NOT EXISTS vecs (hash TEXT PRIMARY KEY, scale REAL NOT NULL, v BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS embed_failed (hash TEXT PRIMARY KEY, error TEXT, at TEXT);
      CREATE TABLE IF NOT EXISTS wal_seen (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS reflections (
        id TEXT PRIMARY KEY, repo TEXT, kind TEXT, status TEXT, origin TEXT, session_id TEXT, updated_at TEXT, hash TEXT
      );
      CREATE TABLE IF NOT EXISTS preserved (ref TEXT PRIMARY KEY, sha TEXT, hash TEXT, updated_at TEXT);
    `);
    if (!this.db.prepare("SELECT 1 FROM pragma_table_info('sources') WHERE name = 'skipped'").get()) this.db.exec('ALTER TABLE sources ADD COLUMN skipped TEXT;');
    // decided = 1 once the skip check has seen the session's first user turn (or a temp working directory).
    if (!this.db.prepare("SELECT 1 FROM pragma_table_info('sources') WHERE name = 'decided'").get()) this.db.exec('ALTER TABLE sources ADD COLUMN decided INTEGER NOT NULL DEFAULT 0;');
    // xv = the extraction version a transcript was read with (indexer.js EXTRACT_VERSION); rows from before it existed read as 1.
    if (!this.db.prepare("SELECT 1 FROM pragma_table_info('sources') WHERE name = 'xv'").get()) this.db.exec('ALTER TABLE sources ADD COLUMN xv INTEGER NOT NULL DEFAULT 1;');
    // last_cwd = the working directory in effect where reading stopped (a Codex turn_context holds for the items after it).
    if (!this.db.prepare("SELECT 1 FROM pragma_table_info('sources') WHERE name = 'last_cwd'").get()) this.db.exec('ALTER TABLE sources ADD COLUMN last_cwd TEXT;');
    if (!this.db.prepare("SELECT 1 FROM pragma_table_info('chunks') WHERE name = 'cwd'").get()) this.db.exec('ALTER TABLE chunks ADD COLUMN cwd TEXT; ALTER TABLE chunks ADD COLUMN host TEXT;');
    // cwd_state = a Codex reader's attribution state where reading stopped (extract.js codexState, as JSON); pending = 1
    // on a chunk whose checkout the next turn_context settles.
    if (!this.db.prepare("SELECT 1 FROM pragma_table_info('sources') WHERE name = 'cwd_state'").get()) this.db.exec('ALTER TABLE sources ADD COLUMN cwd_state TEXT;');
    if (!this.db.prepare("SELECT 1 FROM pragma_table_info('chunks') WHERE name = 'pending'").get()) this.db.exec('ALTER TABLE chunks ADD COLUMN pending INTEGER;');
    this.db.exec('CREATE INDEX IF NOT EXISTS chunks_cwd ON chunks(cwd);');
    if (!this.db.prepare("SELECT 1 FROM pragma_table_info('reflections') WHERE name = 'host'").get()) {
      // The next pass is a full export, so every item's host and cwd reach its chunk (an unchanged item is otherwise skipped).
      this.db.exec('ALTER TABLE reflections ADD COLUMN host TEXT; ALTER TABLE reflections ADD COLUMN cwd TEXT;');
      if (this.getMeta('reflections_day')) this.setMeta('reflections_day', '');
    }
    if (!this.db.prepare("SELECT 1 FROM pragma_table_info('reflections') WHERE name = 'checkout'").get()) {
      // A reflection's checkout was taken from the exported cwd, which the CLI sets to the MAIN worktree's root: an
      // item written in a private worktree read as the main checkout. Forget it now (tenant search fails closed at
      // once) and make the next pass a full export, which brings each item's own `checkout` where the CLI writes one.
      this.db.exec("ALTER TABLE reflections ADD COLUMN checkout TEXT; UPDATE reflections SET cwd = NULL; UPDATE chunks SET cwd = NULL WHERE kind = 'reflection';");
      if (this.getMeta('reflections_day')) this.setMeta('reflections_day', '');
    }
    if (!this.getMeta('schema')) this.setMeta('schema', String(SCHEMA));
  }

  /** Whether chunks carry per-chunk provenance (cwd, host): false for an index file an older Drover wrote, opened read-only. */
  get provenance() { return (this._prov ??= Boolean(this.db.prepare("SELECT 1 FROM pragma_table_info('chunks') WHERE name = 'cwd'").get())); }
  /** Whether reflections carry the checkout they were written in: false for an index file an older Drover wrote, opened read-only. */
  get reflectionCheckouts() { return (this._rco ??= Boolean(this.db.prepare("SELECT 1 FROM pragma_table_info('reflections') WHERE name = 'checkout'").get())); }

  #p(sql) { return (this.st[sql] ??= this.db.prepare(sql)); }

  getMeta(key) { return this.#p('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null; }
  setMeta(key, value) { this.#p('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value)); }

  /**
   * The model that made the stored vectors. A different model (or dims) means the
   * vectors are not comparable with new queries: drop them so they are rebuilt.
   * @returns {boolean} true when vectors were dropped
   */
  ensureModel(id) {
    const cur = this.getMeta('model');
    if (cur === id) return false;
    if (cur) this.db.exec('DELETE FROM vecs; DELETE FROM embed_failed;');
    this.setMeta('model', id);
    this.matrix = null;
    return Boolean(cur);
  }

  source(p) { return this.#p('SELECT * FROM sources WHERE path = ?').get(p) ?? null; }
  sources() { return this.#p('SELECT * FROM sources').all(); }
  upsertSource(s) {
    this.#p(`INSERT INTO sources(path, kind, session_id, title, cwd, project, size, mtime_ms, ino, offset, indexed_at, skipped, decided, xv, last_cwd, cwd_state)
      VALUES (@path, @kind, @session_id, @title, @cwd, @project, @size, @mtime_ms, @ino, @offset, @indexed_at, @skipped, @decided, @xv, @last_cwd, @cwd_state)
      ON CONFLICT(path) DO UPDATE SET kind = excluded.kind, session_id = excluded.session_id, title = excluded.title, cwd = excluded.cwd,
        project = excluded.project, size = excluded.size, mtime_ms = excluded.mtime_ms, ino = excluded.ino, offset = excluded.offset, indexed_at = excluded.indexed_at,
        skipped = excluded.skipped, decided = excluded.decided, xv = excluded.xv, last_cwd = excluded.last_cwd, cwd_state = excluded.cwd_state`)
      .run({ path: s.path, kind: s.kind, session_id: s.session_id ?? null, title: s.title ?? null, cwd: s.cwd ?? null, project: s.project ?? null, size: s.size ?? 0, mtime_ms: s.mtime_ms ?? 0, ino: s.ino ?? null, offset: s.offset ?? 0, indexed_at: new Date().toISOString(), skipped: s.skipped ?? null, decided: s.decided ? 1 : 0, xv: Number.isInteger(s.xv) ? s.xv : 1, last_cwd: s.last_cwd ?? null, cwd_state: s.cwd_state ?? null });
  }
  /**
   * Forget a file: its chunks and its read position. Vectors are shared by text hash, so the
   * ones no chunk references any more are collected by gcVectors() at the end of the pass. A
   * purged truth file also forgets which event ids were indexed, so a restored file is read again.
   */
  purgeSource(p) {
    const kind = this.source(p)?.kind;
    this.#p('DELETE FROM chunks WHERE path = ?').run(p); this.#p('DELETE FROM sources WHERE path = ?').run(p);
    if (kind === 'wal') this.#p('DELETE FROM wal_seen').run();
    this.dirty = true;
  }
  /** The sources of one kind (memory, doc...): their paths and read state. */
  sourcesOfKind(kind) { return this.#p('SELECT * FROM sources WHERE kind = ?').all(kind); }
  /**
   * Forget every source of these kinds, and for reflection every item: what a host no longer indexes (DROVER_SEARCH_KINDS)
   * must not keep answering from what it indexed before. Returns how many sources and items went.
   */
  purgeKinds(kinds) {
    let n = 0;
    for (const kind of kinds) {
      if (kind === 'preserved') {
        n += this.dropPreserved([...this.preservedStates().keys()]);
        if (this.#p("DELETE FROM chunks WHERE kind = 'preserved'").run().changes) this.dirty = true;
        this.setMeta('preserved_gen', '');
        continue;
      }
      if (kind === 'reflection') {
        n += this.dropReflections([...this.reflectionStates().keys()]);
        if (this.#p("DELETE FROM chunks WHERE kind = 'reflection'").run().changes) this.dirty = true;
        // Turned back on later, the first pass is then a full export again.
        this.setMeta('reflections_day', ''); this.setMeta('reflections_since', '');
        continue;
      }
      for (const s of this.sourcesOfKind(kind)) { this.purgeSource(s.path); n++; }
    }
    return n;
  }
  /** Skip every source under a directory prefix (a skipped session's subagents): purge their chunks and mark them. */
  skipUnder(prefix, reason) {
    const like = `${prefix.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    const rows = this.#p("SELECT path FROM sources WHERE path LIKE ? ESCAPE '\\' AND skipped IS NULL").all(like);
    for (const r of rows) { this.#p('DELETE FROM chunks WHERE path = ?').run(r.path); this.#p('UPDATE sources SET skipped = ?, decided = 1 WHERE path = ?').run(reason, r.path); }
    if (rows.length) this.dirty = true;
    return rows.length;
  }
  /** Distinct-text copies of each hash: how many sessions (or files) carry that exact chunk. */
  copies(hashes) {
    if (!hashes.length) return new Map();
    const rows = this.db.prepare(`SELECT hash, COUNT(DISTINCT COALESCE(session_id, path)) AS n FROM chunks WHERE hash IN (${hashes.map(() => '?').join(',')}) GROUP BY hash`).all(...hashes);
    return new Map(rows.map((r) => [r.hash, r.n]));
  }
  /** Drop vectors and failure marks that no chunk references (they would take kNN candidate slots). */
  gcVectors() {
    const n = this.#p('DELETE FROM vecs WHERE hash NOT IN (SELECT hash FROM chunks)').run().changes;
    this.#p('DELETE FROM embed_failed WHERE hash NOT IN (SELECT hash FROM chunks)').run();
    if (n) this.matrix = null;
    this.dirty = false;
    return n;
  }
  /**
   * Drop sources (and their chunks) whose files are gone. A source missing from the listing is purged only when
   * its own stat says ENOENT: a listing that failed (EMFILE, EIO, an unreadable memory-homes.conf) must never look
   * like every file was deleted, which would wipe the index and cost hours of re-embedding.
   */
  purgeMissing(present) {
    let n = 0;
    for (const s of this.sources()) {
      if (present.has(s.path)) continue;
      let gone = false;
      try { statSync(s.path); } catch (e) { gone = e?.code === 'ENOENT' || e?.code === 'ENOTDIR'; }
      if (gone) { this.purgeSource(s.path); n++; }
    }
    return n;
  }

  /**
   * Insert chunks in one transaction. Each: {path, kind, session_id, project, role, ts, title, text, ref, cwd, host,
   * pending}. A pending chunk is stored with no cwd, whatever its row says, until settlePending gives it one.
   */
  addChunks(rows) {
    if (!rows.length) return 0;
    const ins = this.#p('INSERT INTO chunks(path, kind, session_id, project, role, ts, title, text, hash, ref, cwd, host, pending) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    this.db.exec('BEGIN');
    try {
      for (const r of rows) ins.run(r.path, r.kind, r.session_id ?? null, r.project ?? null, r.role ?? null, r.ts ?? null, r.title ?? null, r.text, sha1(r.text), r.ref ?? null, r.pending ? null : r.cwd ?? null, r.host ?? null, r.pending ? 1 : null);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return rows.length;
  }
  /** Settle a file's pending chunks: they get this cwd (null: unknown for good) and stop being pending. */
  settlePending(p, cwd) { return this.#p('UPDATE chunks SET cwd = ?, pending = NULL WHERE path = ? AND pending = 1').run(cwd ?? null, p).changes; }

  /** A session's title changed (ai-title arrived later): rewrite it on its chunks (the update trigger re-indexes FTS). */
  retitle(p, title) {
    const n = this.#p('UPDATE chunks SET title = ? WHERE path = ? AND title IS NOT ?').run(title ?? null, p, title ?? null).changes;
    // Their vectors were embedded with the old title (docText): drop them so the backfill embeds them again.
    if (n && this.#p('DELETE FROM vecs WHERE hash IN (SELECT hash FROM chunks WHERE path = ?)').run(p).changes) this.matrix = null;
    return n;
  }

  /** Every indexed reflection item's state: Map id -> {id, repo, kind, status, origin, session_id, updated_at, hash, host, checkout}. */
  reflectionStates() { return new Map(this.#p('SELECT * FROM reflections').all().map((r) => [r.id, r])); }
  /** The state rows for these ids (search attaches status and repo to reflection hits). */
  reflectionsById(ids) {
    const out = new Map();
    for (let i = 0; i < ids.length; i += 400) {
      const part = ids.slice(i, i + 400);
      for (const r of this.db.prepare(`SELECT * FROM reflections WHERE id IN (${part.map(() => '?').join(',')})`).all(...part)) out.set(r.id, r);
    }
    return out;
  }
  /**
   * Upsert reflection items in one transaction. Each: {id, text, hash, title, ts, role, project, sessionId, status,
   * origin, checkout, host, textChanged}. The chunk at reflection:<id> (its cwd is the checkout) is replaced only when
   * the text changed; otherwise only its metadata (provenance included) moves, so the vector (keyed by text hash) stays.
   */
  upsertReflections(items) {
    if (!items.length) return 0;
    const del = this.#p('DELETE FROM chunks WHERE path = ?');
    const ins = this.#p('INSERT INTO chunks(path, kind, session_id, project, role, ts, title, text, hash, ref, cwd, host) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const meta = this.#p('UPDATE chunks SET session_id = ?, project = ?, role = ?, ts = ?, cwd = ?, host = ? WHERE path = ?');
    const row = this.#p(`INSERT INTO reflections(id, repo, kind, status, origin, session_id, updated_at, hash, host, checkout) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET repo = excluded.repo, kind = excluded.kind, status = excluded.status, origin = excluded.origin,
        session_id = excluded.session_id, updated_at = excluded.updated_at, hash = excluded.hash, host = excluded.host, checkout = excluded.checkout`);
    this.db.exec('BEGIN');
    try {
      for (const it of items) {
        const p = `reflection:${it.id}`;
        const add = () => ins.run(p, 'reflection', it.sessionId ?? null, it.project ?? null, it.role ?? null, it.ts ?? null, it.title ?? null, it.text, it.hash, it.id, it.checkout ?? null, it.host ?? null);
        if (it.textChanged) { if (del.run(p).changes) this.dirty = true; add(); }
        // The same text: move the metadata. A state row whose chunk is missing gets the chunk back.
        else if (!meta.run(it.sessionId ?? null, it.project ?? null, it.role ?? null, it.ts ?? null, it.checkout ?? null, it.host ?? null, p).changes) add();
        row.run(it.id, it.project ?? null, it.role ?? null, it.status ?? null, it.origin ?? null, it.sessionId ?? null, it.ts ?? null, it.hash, it.host ?? null, it.checkout ?? null);
      }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return items.length;
  }
  /** Forget reflection items: their chunks and state rows (the vectors go at the end of the pass). */
  dropReflections(ids) {
    if (!ids.length) return 0;
    const del = this.#p('DELETE FROM chunks WHERE path = ?'), row = this.#p('DELETE FROM reflections WHERE id = ?');
    this.db.exec('BEGIN');
    try { for (const id of ids) { del.run(`reflection:${id}`); row.run(id); } this.db.exec('COMMIT'); }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
    this.dirty = true;
    return ids.length;
  }

  /** Every indexed preserved ref: Map ref -> {ref, sha, hash, updated_at}. */
  preservedStates() { return new Map(this.#p('SELECT * FROM preserved').all().map((r) => [r.ref, r])); }
  /**
   * Upsert preserved refs in one transaction. Each: {ref, sha, hash, chunks: [{text, title, ts, role, project}]}. A ref's
   * chunks at preserved:<ref> are replaced only when its text hash changed; otherwise only its row moves.
   */
  upsertPreserved(items) {
    if (!items.length) return 0;
    const del = this.#p('DELETE FROM chunks WHERE path = ?');
    const ins = this.#p('INSERT INTO chunks(path, kind, session_id, project, role, ts, title, text, hash, ref) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)');
    const row = this.#p(`INSERT INTO preserved(ref, sha, hash, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(ref) DO UPDATE SET sha = excluded.sha, hash = excluded.hash, updated_at = excluded.updated_at`);
    const now = new Date().toISOString();
    let added = 0;
    this.db.exec('BEGIN');
    try {
      for (const it of items) {
        const p = `preserved:${it.ref}`;
        if (it.textChanged) {
          if (del.run(p).changes) this.dirty = true;
          for (const c of it.chunks) { ins.run(p, 'preserved', c.project ?? null, c.role ?? null, c.ts ?? null, c.title ?? null, c.text, sha1(c.text), it.ref); added++; }
        }
        row.run(it.ref, it.sha ?? null, it.hash, now);
      }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return added;
  }
  /** Forget preserved refs: their chunks and rows (the vectors go at the end of the pass). */
  dropPreserved(refs) {
    if (!refs.length) return 0;
    const del = this.#p('DELETE FROM chunks WHERE path = ?'), row = this.#p('DELETE FROM preserved WHERE ref = ?');
    this.db.exec('BEGIN');
    try { for (const r of refs) { del.run(`preserved:${r}`); row.run(r); } this.db.exec('COMMIT'); }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
    this.dirty = true;
    return refs.length;
  }

  walSeen(id) { return Boolean(this.#p('SELECT 1 FROM wal_seen WHERE id = ?').get(id)); }
  walSeenIds() { return new Set(this.#p('SELECT id FROM wal_seen').all().map((r) => r.id)); }
  markWal(ids) { const ins = this.#p('INSERT OR IGNORE INTO wal_seen(id) VALUES (?)'); for (const id of ids) ins.run(id); }

  /**
   * Distinct chunk texts with no vector yet, newest first: [{hash, text, title, kind}]. The title is the source's current
   * one. Command chunks (KEYWORD_ONLY roles) never get a vector: they are found by their words, and embedding them
   * would multiply the backfill on CPU-only boxes for little gain in meaning.
   */
  pending(limit = 64) {
    return this.#p(`SELECT c.hash AS hash, c.text AS text, COALESCE(s.title, c.title) AS title, c.kind AS kind, MAX(c.ts) AS ts
      FROM chunks c LEFT JOIN vecs v ON v.hash = c.hash LEFT JOIN sources s ON s.path = c.path
      WHERE v.hash IS NULL AND ${EMBEDDABLE} AND c.hash NOT IN (SELECT hash FROM embed_failed WHERE at > ?)
      GROUP BY c.hash ORDER BY ts DESC LIMIT ?`).all(failedSince(), limit);
  }
  pendingCount() { return this.#p(`SELECT COUNT(DISTINCT c.hash) AS n FROM chunks c LEFT JOIN vecs v ON v.hash = c.hash WHERE v.hash IS NULL AND ${EMBEDDABLE} AND c.hash NOT IN (SELECT hash FROM embed_failed WHERE at > ?)`).get(failedSince()).n; }
  /** A chunk the model would not embed (it failed alone, after retries): skipped for a day (a 500 may be transient), and cleared on a model change. */
  markEmbedFailed(hash, error) { this.#p('INSERT OR REPLACE INTO embed_failed(hash, error, at) VALUES (?, ?, ?)').run(hash, String(error ?? '').slice(0, 300), new Date().toISOString()); }
  embedFailedCount() { return this.#p('SELECT COUNT(*) AS n FROM embed_failed').get().n; }

  /** Store vectors [{hash, q: Int8Array, scale}] and keep the in-memory matrix in step. */
  addVectors(list) {
    if (!list.length) return 0;
    const ins = this.#p('INSERT OR REPLACE INTO vecs(hash, scale, v) VALUES (?, ?, ?)');
    this.db.exec('BEGIN');
    try { for (const x of list) ins.run(x.hash, x.scale, new Uint8Array(x.q.buffer, x.q.byteOffset, x.q.byteLength)); this.db.exec('COMMIT'); }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
    if (this.matrix) for (const x of list) this.matrix.add(x.hash, x.q, x.scale);
    return list.length;
  }

  /** All vectors as one matrix, loaded once and then appended to by addVectors. */
  vectors() {
    if (this.matrix) return this.matrix;
    const m = new VectorMatrix(DIMS);
    for (const r of this.#p('SELECT hash, scale, v FROM vecs').iterate()) {
      const q = new Int8Array(r.v.buffer, r.v.byteOffset, r.v.byteLength);
      if (q.length === DIMS) m.add(r.hash, q, r.scale);
    }
    this.matrix = m;
    return m;
  }

  stats() {
    const one = (sql) => this.#p(sql).get();
    const kinds = this.#p('SELECT kind, COUNT(*) AS chunks, COUNT(DISTINCT session_id) AS sessions FROM chunks GROUP BY kind').all();
    return {
      chunks: one('SELECT COUNT(*) AS n FROM chunks').n,
      distinct: one('SELECT COUNT(DISTINCT hash) AS n FROM chunks').n,
      keywordOnly: one(`SELECT COUNT(*) AS n FROM chunks c WHERE NOT ${EMBEDDABLE}`).n,
      vectors: one('SELECT COUNT(*) AS n FROM vecs').n,
      embedFailed: one('SELECT COUNT(*) AS n FROM embed_failed').n,
      sources: one('SELECT COUNT(*) AS n FROM sources').n,
      skippedSources: one('SELECT COUNT(*) AS n FROM sources WHERE skipped IS NOT NULL').n,
      newest: one('SELECT MAX(ts) AS t FROM chunks').t ?? null,
      kinds: Object.fromEntries(kinds.map((k) => [k.kind, { chunks: k.chunks, sessions: k.sessions }])),
      model: this.getMeta('model'),
    };
  }

  close() { try { this.db.close(); } catch { /* closed */ } }
}
