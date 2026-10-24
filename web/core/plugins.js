// Plugins: op modules kept outside this repository (an integration with a private service, a personal one), loaded
// when a process starts. DROVER_PLUGINS lists plugin directories separated by ':' (a path may start with ~/); unset,
// every directory in ~/.config/drover/plugins is one. A plugin directory holds plugin.js, whose default export
// describes the plugin. Every field is optional:
//
//   name             the plugin's name (default: its directory's name)
//   ops              op name -> async (args) => result, run on the host args.host names (forwarded like core ops)
//   front            op name -> async (args) => result, run on the front daemon only (never forwarded)
//   meta             op name -> { m: mutating, d: description, s: JSON schema } (core/ops-meta.js; the MCP tools)
//   cachePolicy      op name -> ttl in ms for the read cache (core/api.js CACHE_POLICY)
//   invalidates      op name -> op prefixes whose cached answers it drops (core/api.js INVALIDATES)
//   hostTimeoutMs    op name -> how long a forwarded call may take
//   eventTypes       truth-file event type -> validate(ev), which throws on a malformed event (core/events.js)
//   mcpInstructions  lines added to the MCP server's instructions
//   hosts            a host provider: hosts that are not ssh aliases (see hostProvider below)
//   search           { preserved: () => source, restoreCommand: (ref) => string, roles: [...] }: the "preserved"
//                    search kind (core/search: indexer, meta, query); and remote: { <kind>: async ({ query, limit,
//                    kinds, days, project, signal }) => ({ hits, note? }) }: a search kind (brain) the front fetches at
//                    query time and no host indexes, its hits fused with the index's by rank; signal is aborted when
//                    the front stops waiting (core/search/remote.js)
//   start(ctx)       daemon start, returns a stop function; ctx is { dispatch, notifier, broadcast, watching }
//   settle()         awaited before a one-shot process (drover op, rpc, mcp) exits: work that answered "running"
//   ui               { views: ['ui/<file>.js', ...] }: web UI views, served at /views/plugin-<name>-<file>.js so their
//                    own `../dom.js` imports reach the UI's modules
//   tui              { tables: [...] or async () => [...] }: extra tables for `drover tui` (web/tui/views/tables.js
//                    shape, plus `after`: the id of the table it follows)
//
// A plugin's modules import Drover's as `drover/core/<module>.js`: the plugin's repository links
// node_modules/drover to this checkout's web/ directory, so both sides share one copy of every module.
// This module imports nothing of Drover's own, so any module may consult it without an import cycle.
import { readdirSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';

const state = { loading: null, plugins: [], errors: [] };

// `drover/<path>` resolves to this checkout's web/<path>: the modules this process already runs, so a plugin and the
// core share one copy of each (one event listener list, one cache), wherever the plugin's repository lives.
const WEB = new URL('../', import.meta.url);
let hooked = false;
export function hookDroverSpecifier() {
  if (hooked || typeof registerHooks !== 'function') return;
  hooked = true;
  registerHooks({ resolve: (specifier, context, next) => (specifier.startsWith('drover/') ? next(new URL(specifier.slice('drover/'.length), WEB).href, context) : next(specifier, context)) });
}

const expand = (p) => (p.startsWith('~/') ? path.join(homedir(), p.slice(2)) : p);

/** The plugin directories this process loads, in order. */
export function pluginDirs(env = process.env) {
  const listed = env.DROVER_PLUGINS ?? env.APXW_PLUGINS;
  if (typeof listed === 'string') return listed.split(':').map((s) => s.trim()).filter(Boolean).map(expand);
  const base = path.join(homedir(), '.config', 'drover', 'plugins');
  if (!existsSync(base)) return [];
  return readdirSync(base).sort().map((n) => path.join(base, n)).filter((d) => { try { return statSync(d).isDirectory(); } catch { return false; } });
}

/** Add one plugin definition (load() calls this; tests register a definition directly). */
export function register(def, { dir = null } = {}) {
  if (!def || typeof def !== 'object') throw new Error('a plugin must export an object');
  const name = String(def.name ?? (dir ? path.basename(dir) : '')).trim();
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(name)) throw new Error(`plugin name ${JSON.stringify(name)} must be lowercase letters, digits and dashes`);
  if (state.plugins.some((p) => p.name === name)) throw new Error(`plugin ${name} is loaded twice`);
  const p = { ...def, name, dir };
  state.plugins.push(p);
  return p;
}

/**
 * Load every plugin directory once per process. A plugin that fails to load is recorded in errors() and skipped, so
 * a broken private checkout never stops the daemon; the same failure is not retried on the next call.
 */
export function load({ dirs = pluginDirs() } = {}) {
  state.loading ??= (async () => {
    if (dirs.length) hookDroverSpecifier();
    for (const dir of dirs) {
      try {
        const file = path.join(dir, 'plugin.js');
        if (!existsSync(file)) throw new Error(`no plugin.js in ${dir}`);
        const mod = await import(pathToFileURL(file).href);
        register(mod.default ?? mod, { dir });
      } catch (e) { state.errors.push({ dir, error: e?.message ?? String(e) }); }
    }
    return state.plugins;
  })();
  return state.loading;
}

export const list = () => state.plugins;
export const errors = () => state.errors;
/** What clients may know about the plugins here: names, op names and UI views, no paths. */
export function summary() {
  return { plugins: state.plugins.map((p) => ({ name: p.name, ops: Object.keys({ ...(p.ops ?? {}), ...(p.front ?? {}) }), views: uiViews().filter((v) => v.plugin === p.name).map((v) => v.url) })), errors: state.errors.length };
}

/**
 * The host provider that owns a host name (a name that is not an ssh alias, such as space:<name>), or null. A provider
 * is { match(name), known(name) -> Promise<boolean>, unknownError(name) -> string, entries() -> Promise<host entries>,
 * rpcArgv(name) -> Promise<{ argv }>, exec(name, argv, opts) -> Promise<run result>, dockerStacks(name, args) }.
 */
export function hostProvider(name) {
  for (const p of state.plugins) if (p.hosts && typeof p.hosts.match === 'function' && p.hosts.match(String(name ?? ''))) return p.hosts;
  return null;
}
export const hostProviders = () => state.plugins.map((p) => p.hosts).filter(Boolean);

/** The validator for a plugin's event type, or null. */
export function eventValidator(type) {
  for (const p of state.plugins) if (p.eventTypes && Object.hasOwn(p.eventTypes, type)) return p.eventTypes[type];
  return null;
}
export const eventTypes = () => state.plugins.flatMap((p) => Object.keys(p.eventTypes ?? {}));

/** The plugin that serves the "preserved" search kind, or null. */
export function preservedSearch() { return state.plugins.find((p) => p.search?.preserved)?.search ?? null; }

/** The remote search sources, kind -> async ({ query, limit, kinds, days, project, signal }) => ({ hits, note? }): the first plugin that serves a kind has it. */
export function remoteSearchSources() {
  const out = {};
  for (const p of state.plugins) {
    const remote = p.search?.remote;
    if (!remote || typeof remote !== 'object') continue;
    for (const [kind, fn] of Object.entries(remote)) if (typeof fn === 'function' && !Object.hasOwn(out, kind)) out[kind] = fn;
  }
  return out;
}

export const mcpInstructions = () => state.plugins.flatMap((p) => (Array.isArray(p.mcpInstructions) ? p.mcpInstructions : []));

/** Web UI views: { plugin, url, file }. */
export function uiViews() {
  return state.plugins.flatMap((p) => (p.ui?.views ?? []).filter((v) => typeof v === 'string' && /^[\w./-]+\.js$/.test(v) && !v.includes('..'))
    .map((v) => ({ plugin: p.name, file: path.join(p.dir ?? '', v), url: `/views/plugin-${p.name}-${path.basename(v)}` })));
}
/** The file behind a /views/plugin-<name>-<file>.js URL, or null. */
export function uiFile(url) { return uiViews().find((v) => v.url === url)?.file ?? null; }

/** Extra tables for `drover tui`: a plugin gives a list, or a function that loads one (so the daemon never loads TUI code). */
export async function tuiTables() {
  const out = [];
  for (const p of state.plugins) {
    try { const t = typeof p.tui?.tables === 'function' ? await p.tui.tables() : p.tui?.tables; if (Array.isArray(t)) out.push(...t); }
    catch (e) { state.errors.push({ dir: p.dir, error: `tui: ${e?.message ?? e}` }); }
  }
  return out;
}

/** Start every plugin's daemon work; the returned function stops it all. */
export function startAll(ctx) {
  const stops = [];
  for (const p of state.plugins) {
    if (typeof p.start !== 'function') continue;
    try { const s = p.start(ctx); if (typeof s === 'function') stops.push(s); } catch (e) { state.errors.push({ dir: p.dir, error: `start: ${e?.message ?? e}` }); }
  }
  return () => { for (const s of stops) { try { s(); } catch { /* stopping must not throw */ } } };
}

/** Let every plugin finish work that answered "running" before a one-shot process exits. */
export async function settleAll() {
  await Promise.all(state.plugins.filter((p) => typeof p.settle === 'function').map((p) => Promise.resolve().then(() => p.settle()).catch(() => {})));
}

/** Tests: forget every plugin. */
export function _reset() { state.loading = null; state.plugins = []; state.errors = []; }
