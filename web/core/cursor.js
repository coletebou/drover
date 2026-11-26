// Cursor CLI adapter (cursor-agent, https://cursor.com/cli). Drover starts it in a tmux window only: an interactive
// `cursor-agent` session in cwd with the prompt as its first input. It bills the Cursor login on that host (its
// included plan usage); Drover passes no API key and no credential pool entry reaches it. Whether that login is
// live is `cursor-agent status` on the host (agent-budget probes it before routing work here), and the keychain it
// reads on macOS must be unlocked in the session the window runs in.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { envvar } from './envvars.js';

export const ENGINE = 'cursor';

/** The cursor-agent executable: DROVER_CURSOR_BIN, else `cursor-agent` on the PATH. */
export const cursorBin = (env = process.env) => envvar('CURSOR_BIN', env)?.trim() || 'cursor-agent';

/** The cursor-agent executable as it would run with this PATH: an absolute path, or null when there is none. */
export function findBin(PATH, env = process.env) {
  const bin = cursorBin(env);
  if (path.isAbsolute(bin)) return existsSync(bin) ? bin : null;
  for (const d of String(PATH ?? '').split(path.delimiter)) {
    if (!d) continue;
    const f = path.join(d, bin);
    if (existsSync(f)) return f;
  }
  return null;
}

/**
 * The tmux window's argv: cursor-agent, the profile's argv, --model, --workspace cwd, --trust (unless trust is off:
 * Cursor records no folder trust in a file Drover could write ahead, so the flag answers its first-run workspace
 * question instead), --resume, then the prompt after `--` so a prompt that starts with a dash stays a prompt.
 */
export function interactiveArgv(profile, { model, cwd, prompt, resume, trust = true, env = process.env } = {}) {
  const argv = [cursorBin(env), ...(profile?.argv ?? [])];
  if (model) argv.push('--model', model);
  if (cwd) argv.push('--workspace', cwd);
  if (trust && !argv.includes('--trust')) argv.push('--trust');
  if (resume) { argv.push('--resume', resume); return argv; }
  if (prompt) argv.push('--', prompt);
  return argv;
}
