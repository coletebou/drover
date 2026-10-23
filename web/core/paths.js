// Where Drover keeps per-machine state (tokens, daemon.json, credential and
// alert history) and caches (snapshots, uploads), and the one-time move from the
// directories the tool used under its old name (apx-web).
import { lstatSync, mkdirSync, renameSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { envvar } from './envvars.js';

const defaults = (home) => ({
  state: path.join(home, '.local', 'state', 'drover'),
  cache: path.join(home, '.cache', 'drover'),
  share: path.join(home, '.local', 'share', 'drover'),
  legacyState: path.join(home, '.local', 'state', 'apx-web'),
  legacyCache: path.join(home, '.cache', 'apx-web'),
  legacyShare: path.join(home, '.local', 'share', 'apx-web'),
});

/** DROVER_STATE (or legacy APXW_STATE), else ~/.local/state/drover. */
export function stateDir(env = process.env) { return envvar('STATE', env) ?? defaults(env.HOME).state; }

/** DROVER_CACHE (or legacy APXW_CACHE), else ~/.cache/drover. */
export function cacheDir(env = process.env) { return envvar('CACHE', env) ?? defaults(env.HOME).cache; }

/** DROVER_SHARE (or legacy APXW_SHARE), else ~/.local/share/drover: installed runtimes (the search embedder). */
export function shareDir(env = process.env) { return envvar('SHARE', env) ?? defaults(env.HOME).share; }

const lstatOrNull = (p) => { try { return lstatSync(p); } catch { return null; } };

/**
 * Move ~/.local/state/apx-web, ~/.cache/apx-web and ~/.local/share/apx-web to their drover names and
 * leave a symlink at the old path, so a daemon or remote rpc still running the
 * old code keeps reading and writing the same files. Runs at the start of every
 * CLI command. Only acts when the old path is a real directory and the new path
 * does not exist; an explicit DROVER_STATE / DROVER_CACHE / DROVER_SHARE override skips that pair.
 * Never deletes anything and never throws: a failed move leaves the old layout.
 */
export function migrateLegacyDirs(env = process.env) {
  if (!env.HOME) return [];
  const d = defaults(env.HOME);
  const moved = [];
  for (const [name, legacy, next] of [['STATE', d.legacyState, d.state], ['CACHE', d.legacyCache, d.cache], ['SHARE', d.legacyShare, d.share]]) {
    if (envvar(name, env) !== undefined) continue;
    const old = lstatOrNull(legacy);
    if (!old || old.isSymbolicLink() || !old.isDirectory()) continue;
    if (lstatOrNull(next)) continue;
    try {
      mkdirSync(path.dirname(next), { recursive: true });
      renameSync(legacy, next);
    } catch { continue; } // another process moved it first, or the volume refused; both leave data intact
    try { symlinkSync(next, legacy); } catch { /* another process linked it first */ }
    moved.push({ from: legacy, to: next });
  }
  return moved;
}
