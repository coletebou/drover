// The host guard's state file, as an external guard writes it. Drover does not run a guard; any tool that keeps this
// file honest can be one. DROVER_GUARD_STATE names a JSON file:
//
//   { "epoch": 1767000000, "level": "tight", "why": "swap headroom 3 GB", "observe": false,
//     "sig": { "headroom_mb": 3072, "runway_s": 420 } }
//
// epoch is seconds since 1970; level is one of calm, tight, storm, cliff (mildest first); why is a sentence for people;
// observe says the guard is only watching, not acting (Drover grades its reading either way); sig carries the numbers
// behind the level, all optional. A reading older than GUARD_STALE_S seconds, a missing file or a file that does not
// parse counts as no guard at all: the guard failing must never stop work (fail open). Everything is off while
// DROVER_GUARD_STATE is unset. The launch gate (core/launch-gate.js) is the other half of the contract.
import { readFile } from 'node:fs/promises';
import { envvar } from './envvars.js';

export const GUARD_LEVELS = Object.freeze(['calm', 'tight', 'storm', 'cliff']);
/** Mildest first: calm 0, tight 1, storm 2, cliff 3; an unknown level is -1. */
export const guardRank = (level) => GUARD_LEVELS.indexOf(level);
export const GUARD_STALE_S = 30;

const finite = (n) => (typeof n === 'number' && Number.isFinite(n) ? n : null);

/**
 * One state file's text -> { level, why, observe, headroomMB, runwayS, ageS }, or null when it does not parse, names no
 * known level, has no epoch or is older than GUARD_STALE_S at nowMs. An epoch more than a few seconds ahead of nowMs is
 * as unreliable as an old one and is dropped the same way.
 */
export function parseGuard(text, nowMs = Date.now()) {
  let d;
  try { d = JSON.parse(String(text ?? '')); } catch { return null; }
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  const epoch = finite(d.epoch);
  if (epoch === null || guardRank(d.level) < 0) return null;
  const ageS = nowMs / 1000 - epoch;
  if (ageS > GUARD_STALE_S || ageS < -5) return null;
  const sig = d.sig && typeof d.sig === 'object' && !Array.isArray(d.sig) ? d.sig : {};
  return {
    level: d.level, why: typeof d.why === 'string' ? d.why.slice(0, 300) : '', observe: d.observe === true,
    headroomMB: finite(sig.headroom_mb), runwayS: finite(sig.runway_s), ageS: Math.max(0, Math.round(ageS)),
  };
}

/** The path DROVER_GUARD_STATE names, or null when the guard is not configured. */
export const guardStatePath = (env = process.env) => String(envvar('GUARD_STATE', env) ?? '').trim() || null;

/** The fresh guard reading, or null: not configured, no file, unreadable, unparseable or stale. Never throws. */
export async function readGuard({ env = process.env, now = Date.now(), read = (f) => readFile(f, 'utf8') } = {}) {
  const file = guardStatePath(env);
  if (!file) return null;
  try { return parseGuard(await read(file), now); } catch { return null; }
}
