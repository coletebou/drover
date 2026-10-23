// Search ops and the per-host service behind them. The always-on daemon
// (`drover serve`) owns the index: it is the only writer, runs the indexer every
// minute and holds the one embedding server. Every other process on the host
// (`drover rpc` serving another machine, `drover mcp` serving an agent, `drover op`)
// forwards search ops to the local daemon over its HTTP API, so there is one
// model in memory and one writer. With no daemon reachable they fall back to a
// read-only keyword search of the index file.
//
// Env (per host, e.g. in ~/.local/state/drover/env): DROVER_SEARCH=off disables
// indexing; DROVER_SEARCH_DAYS=N indexes only sources touched in N days;
// DROVER_SEARCH_EVERY_MS sets the pass interval; DROVER_EMBED_THREADS, DROVER_EMBED_HOME,
// DROVER_LLAMA_SERVER, DROVER_EMBED_MODEL steer the embedder (core/search/embed.js).
import { stat, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { Store, DB_PATH, STATE_DIR } from './store.js';
import { Embedder } from './embed.js';
import { Indexer } from './indexer.js';
import { search } from './query.js';
import { grepTranscripts } from './grep.js';
import { memoryHomes } from '../memory.js';
import { localShortName } from '../hosts.js';
import { envvar } from '../envvars.js';
import { readEndpoint, callDaemon } from '../daemon-client.js';

const log = (m) => console.log(`[search] ${m}`);
export const _deps = { fetch: (...a) => fetch(...a), env: process.env };

let daemon = false;
let svc = null;           // { store, embedder, indexer, timer }

/** Called by the HTTP server: this process is the host's daemon and serves search ops itself. */
export function markDaemon() { daemon = true; }
export const enabled = (env = _deps.env) => !/^(0|off|false|no)$/i.test(String(envvar('SEARCH', env) ?? 'on'));

function service() {
  if (svc) return svc;
  const store = new Store(envvar('SEARCH_DB', _deps.env) ?? DB_PATH);
  const embedder = new Embedder({ env: _deps.env, log });
  const days = Number(envvar('SEARCH_DAYS', _deps.env)) || null;
  const indexer = new Indexer({ store, embedder, memoryHomes, days, log });
  svc = { store, embedder, indexer, timer: null, startup: null };
  return svc;
}

/** Daemon only: start indexing (first pass after 15 s, then every DROVER_SEARCH_EVERY_MS, default 60 s). */
export function startService({ firstMs = 15_000 } = {}) {
  if (!enabled()) { log('disabled (DROVER_SEARCH=off)'); return () => {}; }
  const s = service();
  if (s.timer) return () => stopService();
  const every = Math.max(10_000, Number(envvar('SEARCH_EVERY_MS', _deps.env)) || 60_000);
  const pass = async () => {
    const r = await s.indexer.tick();
    if (!r.skipped && (r.added || r.embedded || r.purged)) log(`pass: ${r.changed} changed of ${r.scanned}, +${r.added} chunks, ${r.embedded} embedded, ${r.purged} purged, ${r.ms} ms`);
  };
  s.startup = setTimeout(() => { pass().catch(() => {}); }, firstMs); s.startup.unref?.();
  s.timer = setInterval(() => { pass().catch(() => {}); }, every); s.timer.unref?.();
  return () => stopService();
}

export function stopService() {
  if (!svc) return;
  clearTimeout(svc.startup); clearInterval(svc.timer);
  svc.embedder.stop(); svc.store.close(); svc = null;
}

/** Forward an op to this host's daemon over HTTP (token from the state dir). Throws when it is not reachable. */
async function viaDaemon(op, args) {
  const ep = await readEndpoint({ dir: STATE_DIR });
  return callDaemon(ep, op, args, { timeoutMs: op === 'search.reindex' ? 60_000 : 45_000, fetchFn: _deps.fetch });
}

async function dbBytes(file) {
  let n = 0;
  for (const f of [file, `${file}-wal`, `${file}-shm`]) { try { n += (await stat(f)).size; } catch { /* absent */ } }
  return n;
}

/** Whether this index has finished a full reflections pass: until then a search for reflections finds nothing. */
const reflectionsIndexed = (store) => Boolean(store.getMeta('reflections_day'));

async function semanticHere(args) {
  const s = service();
  const engine = s.embedder.installed() ? { embed: (t) => s.embedder.embed(t) } : null;
  const r = await search(s.store, engine, args);
  const st = s.store.stats();
  return { host: localShortName(), ...r, reflectionsIndexed: reflectionsIndexed(s.store), index: { chunks: st.chunks, vectors: st.vectors, newest: st.newest, building: s.indexer.busy } };
}

async function statusHere() {
  const s = service();
  const file = s.store.file;
  return { host: localShortName(), enabled: enabled(), index: s.store.stats(), indexer: s.indexer.status(), embedder: s.embedder.status(), db: { path: file, bytes: await dbBytes(file) } };
}

/** Keyword-only search of the index file, for when the daemon is down. */
async function semanticReadOnly(args, why) {
  const file = envvar('SEARCH_DB', _deps.env) ?? DB_PATH;
  if (!existsSync(file)) throw new Error(`search index not built on ${localShortName()} yet (the Drover daemon builds it; ${why})`);
  const store = new Store(file, { readOnly: true });
  try {
    const r = await search(store, null, { ...args, mode: args.mode === 'semantic' ? 'keyword' : (args.mode ?? 'keyword') });
    return { host: localShortName(), ...r, reflectionsIndexed: reflectionsIndexed(store), notes: [...(r.notes ?? []), `keyword only: ${why}`] };
  } finally { store.close(); }
}

const local = (fn, fallback) => async (args = {}) => {
  if (!enabled()) throw new Error(`search is disabled on ${localShortName()} (DROVER_SEARCH=off)`);
  if (daemon) return fn(args);
  try { return await viaDaemon(fn.op, args); }
  catch (e) { if (e.fromDaemon || !fallback) throw e; return fallback(args, `daemon not reachable (${e.code ?? e.message})`); }
};
semanticHere.op = 'search.semantic';
statusHere.op = 'search.status';
async function reindexHere({ rebuild = false } = {}) {
  const s = service();
  if (rebuild === true || rebuild === 'true') {
    if (s.indexer.busy) throw new Error('an index pass is running; retry the rebuild in a minute (search.status shows busy)');
    const file = s.store.file;
    stopService();
    for (const f of [file, `${file}-wal`, `${file}-shm`]) await rm(f, { force: true });
    log('index dropped for a rebuild');
    startService({ firstMs: 0 });
    return { ok: true, rebuilt: true, note: 'a fresh pass started; keyword search fills in first, vectors follow (watch search.status)' };
  }
  if (s.indexer.busy) return { ok: true, started: false, note: 'a pass is already running' };
  s.indexer.tick().catch(() => {});
  return { ok: true, started: true };
}
reindexHere.op = 'search.reindex';

/** Raw transcript grep on this host. It needs no index, so it runs in whichever process got the op (no daemon hop). */
async function grepHere(args = {}) {
  return { host: localShortName(), ...(await grepTranscripts(args, { env: _deps.env })) };
}

export const ops = {
  'search.semantic': local(semanticHere, semanticReadOnly),
  'search.status': local(statusHere, async (_args, why) => {
    const file = envvar('SEARCH_DB', _deps.env) ?? DB_PATH;
    if (!existsSync(file)) return { host: localShortName(), enabled: enabled(), index: null, note: `no index yet; ${why}` };
    const store = new Store(file, { readOnly: true });
    try { return { host: localShortName(), enabled: enabled(), index: store.stats(), db: { path: file, bytes: await dbBytes(file) }, note: why }; } finally { store.close(); }
  }),
  'search.reindex': local(reindexHere, null),
  'search.grep': grepHere,
};

export { META } from './meta.js';
