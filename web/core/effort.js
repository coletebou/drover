// Per-launch reasoning effort: the levels each engine accepts, and the one check every launch path uses.
// No dependencies, so the MCP server and the op metadata can import it without loading the rest of core.
//
// Verified 2026-10-15 against the installed CLIs:
// - Claude Code 2.1.301: `claude --help` lists `--effort <level>` "for the current session" with low, medium,
//   high, xhigh, max. An unknown value only prints a warning and the session runs at the default effort.
// - Codex 0.162.1: model_reasoning_effort is a free string ("a value advertised by the model"); `codex debug
//   models` advertises low, medium, high, xhigh, max and ultra on the models it was checked against (some stop at
//   max or xhigh). Codex itself accepts any string, even a typo, and sends it.
// So Drover validates here, before anything is picked, started or recorded. A launch effort only ever reaches the
// agent as a setting of that one session (claude --effort, codex -c model_reasoning_effort, or the same key in
// a headless thread's thread/start config), never as /effort or /model typed inside it, which in Claude Code
// overwrite the user's global default in ~/.claude/settings.json.

export const EFFORT_LEVELS = Object.freeze({
  claude: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']),
  codex: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
});

/** Every level any engine accepts (for a schema enum); the per-engine check is checkEffort(). */
export const ALL_EFFORTS = Object.freeze([...new Set(Object.values(EFFORT_LEVELS).flat())]);

/** Omitted: undefined, null or the empty string (a form's "profile default"). */
export const effortGiven = (effort) => effort !== undefined && effort !== null && effort !== '';

/**
 * The effort to pass for this engine, or null when none was asked for. Throws a message that names the valid
 * levels for an unknown engine or a value the engine does not take. Exact match only: the values travel as
 * argv elements, so nothing is trimmed, lowercased or aliased into one.
 */
export function checkEffort(engine, effort) {
  if (!effortGiven(effort)) return null;
  const levels = EFFORT_LEVELS[engine];
  if (!levels) throw new Error(`unknown engine ${JSON.stringify(engine)} for effort; known: ${Object.keys(EFFORT_LEVELS).join(', ')}`);
  if (typeof effort !== 'string' || !levels.includes(effort)) {
    throw new Error(`effort ${JSON.stringify(effort)} is not valid for ${engine}: use one of ${levels.join(', ')}, or omit it for the profile default`);
  }
  return effort;
}

/**
 * The per-model rule, for a model the catalog knows: `levels` is that model's own list, or not an array when
 * the model is unknown or the catalog could not be read (then the engine list, already checked, is the rule).
 * Codex accepts and sends a level the model does not advertise without complaint (Luna with ultra ran on
 * 0.162.1), so this is the only place such a combination is caught.
 */
export function checkModelEffort(engine, model, effort, levels) {
  if (!effortGiven(effort) || !model || !Array.isArray(levels)) return effort;
  if (!levels.includes(effort)) {
    throw new Error(`effort ${JSON.stringify(effort)} is not supported by ${model}: it takes ${levels.join(', ')} (the ${engine} model catalog on this host)`);
  }
  return effort;
}

/** A plain copy for the launch.efforts op (and anything else that serializes it). */
export function effortLevels() {
  return Object.fromEntries(Object.entries(EFFORT_LEVELS).map(([engine, levels]) => [engine, [...levels]]));
}
