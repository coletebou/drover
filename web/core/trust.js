// Folder trust for the agents launch.start opens in tmux. Claude Code and Codex each ask once per folder before
// they start ("Accessing workspace: ... Yes, I trust this folder"), Claude Code with "No, exit" focused, so a
// launched agent sat at that dialog until someone pressed Down and Enter: every worker of one fan-out of launched
// agents, --dangerously-skip-permissions or not. A launch records its folder as trusted first, the way
// accepting the dialog would, so the agent starts at its prompt. Headless agents never ask (claude -p skips the
// dialog; a headless Codex thread runs on the app-server, which has no dialog).
//
// Claude Code 2.1.308, read in its bundle and checked by accepting the dialog in scratch folders:
//  - it writes projects[<key>].hasTrustDialogAccepted = true in ~/.claude.json (getGlobalClaudeFile: under
//    CLAUDE_CONFIG_DIR when set, and the legacy ~/.claude/.config.json while that is in use). <key> is the
//    physical path of its cwd (getcwd: a symlinked cwd is keyed by its target), NFC; inside git it is the
//    canonical root instead: the checkout root, and for a linked worktree its main checkout, so accepting in one
//    worktree trusts the repository and all its worktrees.
//  - it looks that key up, then every folder from the cwd up to its git root (outside git, up to /), so a
//    trusted parent covers a plain folder but not a repository below it. For a worktree Drover also writes the
//    worktree's own root (claudeKeys), the last folder of that walk.
//  - in the home folder the answer lasts one session and is never written. Drover writes nothing there either.
//  - its writers hold <the config path it uses>.lock (proper-lockfile: a directory made with mkdir, abandoned after
//    10 s without an mtime refresh; Claude Code passes that lockfilePath, so a symlink is not resolved for it) and
//    re-read the file under it.
// Codex 0.163.0 asks only inside a git repository ("Trusting will apply to the repository root") and writes
// [projects."<root>"] trust_level = "trusted" to $CODEX_HOME/config.toml, <root> the main checkout, canonicalized.
import { readFile, writeFile, rename, stat, lstat, chmod, mkdir, rmdir, realpath, unlink } from 'node:fs/promises';
import { readFileSync, statSync, realpathSync, existsSync } from 'node:fs';
import path from 'node:path';

export const _deps = { home: () => process.env.HOME, log: (m) => console.error(`[trust] ${m}`), now: () => Date.now(), lockWaitMs: 3000 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Claude Code's findGitRoot: the nearest folder at or above dir whose .git is a directory or a file (a worktree, a submodule). */
export function gitRootOf(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    try { const s = statSync(path.join(d, '.git')); if (s.isDirectory() || s.isFile()) return d; } catch { /* not here */ }
    if (path.dirname(d) === d) return null;
  }
}

/**
 * The checkout a git root belongs to, as Claude Code resolves it: a linked worktree (.git is a file naming
 * <common>/worktrees/<name>, whose commondir leads to <common> and whose gitdir file points back at this .git)
 * counts as its main checkout, or as the bare repository itself. Anything else keeps its own root (a submodule,
 * a worktree whose metadata does not check out), as it does there.
 */
export function canonicalRoot(root) {
  try {
    const text = readFileSync(path.join(root, '.git'), 'utf8').trim();   // EISDIR: an ordinary checkout
    if (!text.startsWith('gitdir:')) return root;
    const gitdir = path.resolve(root, text.slice(7).trim());
    const common = path.resolve(gitdir, readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim());
    if (path.dirname(gitdir) !== path.join(common, 'worktrees')) return root;
    const back = path.resolve(gitdir, readFileSync(path.join(gitdir, 'gitdir'), 'utf8').trim());
    if (realpathSync(back) !== path.join(realpathSync(root), '.git')) return root;
    if (path.basename(common) !== '.git') return existsSync(path.join(common, '.git')) ? root : common;
    return path.dirname(common);
  } catch { return root; }
}

/**
 * The keys to trust for a session started in dir: first the one Claude Code records (see the header), then, for a
 * linked worktree, the worktree's own root too. That is the key a version that keeps worktrees apart writes and
 * looks up, so a box that is a release behind still starts at its prompt; in this version it is the last folder of
 * the cwd-to-git-root walk, so it trusts nothing the first key does not already.
 */
export function claudeKeys(dir) {
  const real = realpathSync(dir), root = gitRootOf(real);
  if (!root) return [real.normalize('NFC')];
  const canonical = canonicalRoot(root).normalize('NFC'), own = root.normalize('NFC');
  return canonical === own ? [canonical] : [canonical, own];
}
export const claudeKey = (dir) => claudeKeys(dir)[0];

/** The folder Codex records trust for, or null outside git, where it does not ask. */
export function codexRoot(dir) {
  const root = gitRootOf(realpathSync(dir));
  return root ? realpathSync(canonicalRoot(root)) : null;
}

/** The file Claude Code keeps its config in, for an agent started with env. */
export function claudeConfigFile(env = process.env, home = _deps.home()) {
  const dir = path.isAbsolute(env.CLAUDE_CONFIG_DIR ?? '') ? env.CLAUDE_CONFIG_DIR : '';
  const file = path.join(dir || home, `.claude${env.CLAUDE_CODE_CUSTOM_OAUTH_URL ? '-custom-oauth' : ''}.json`);
  const legacy = path.join(dir || path.join(home, '.claude'), '.config.json');
  try { const s = statSync(legacy); if (s.isFile() && (s.size > 0 || ((s.mode & 0o222) && !existsSync(file)))) return legacy; } catch { /* not in use */ }
  return file;
}

export function codexConfigFile(env = process.env, home = _deps.home()) {
  return path.join(path.isAbsolute(env.CODEX_HOME ?? '') ? env.CODEX_HOME : path.join(home, '.codex'), 'config.toml');
}

/** Take one mkdir lock: one older than proper-lockfile's 10 s is abandoned and taken, one held past lockWaitMs is busy. */
async function takeLock(lock) {
  const t0 = _deps.now();
  for (;;) {
    try { await mkdir(lock); return; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (_deps.now() - t0 > _deps.lockWaitMs) throw Object.assign(new Error(`${lock} is held by another process`), { busy: true });
      const s = await stat(lock).catch(() => null);
      if (s && _deps.now() - s.mtimeMs > 10_000) await rmdir(lock).catch(() => {});
      else await sleep(20 + Math.random() * 40);
    }
  }
}

/**
 * A lock's physical identity: the real path of the folder it is made in, joined with its name. Two spellings of one
 * lock (a symlinked folder above it: a CLAUDE_CONFIG_DIR linked into dotfiles, a symlinked /home, macOS /var or
 * /tmp) are one directory on disk; taking both would make the second wait on the first until it reports busy.
 */
async function lockIdentity(lock) {
  return path.join(await realpath(path.dirname(lock)).catch(() => path.dirname(lock)), path.basename(lock));
}

/**
 * Run fn holding each lock in locks, once per directory on disk (lockIdentity), for the few milliseconds of a
 * read-modify-write: taken in the order given, released in reverse, all or none. Every writer takes the lock of the
 * path it uses before the lock of the file behind it, so two of them never wait on each other in a circle.
 */
export async function withLocks(locks, fn) {
  const held = [];
  try {
    for (const want of locks) {
      const lock = await lockIdentity(want);
      if (held.includes(lock)) continue;
      await takeLock(lock); held.push(lock);
    }
    return await fn();
  } finally { for (const lock of held.reverse()) await rmdir(lock).catch(() => {}); }
}

/**
 * The file behind a config path, the one identity for its lock, its read and its replacement: its real path, so a
 * symlinked config is its target, or the path itself while nothing is there. A link to a missing file is refused:
 * renaming over it would replace the link, and writing its target would create a file somewhere else.
 */
export async function configTarget(file) {
  try { return await realpath(file); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
    if ((await lstat(file).catch(() => null))?.isSymbolicLink()) throw new Error(`${file} is a link to a missing file; left as it is`);
    return file;
  }
}

/**
 * Write text over a file through a temp file beside its real path (a symlinked config stays a link), mode kept. The
 * temp name is this call's alone and is created exclusively, so two writers can never share one.
 */
let tmpSeq = 0;
async function replaceFile(real, text, mode) {
  const tmp = path.join(path.dirname(real), `.${path.basename(real)}.drover-${process.pid}-${_deps.now()}-${++tmpSeq}.tmp`);
  try {
    await writeFile(tmp, text, { mode, flag: 'wx' });
    await chmod(tmp, mode);   // writeFile's mode passes through the umask
    await rename(tmp, real);
  } catch (e) { await unlink(tmp).catch(() => {}); throw e; }
}

/** A config file's current text and mode, read at its target (configTarget); a missing file reads as '' with Claude Code's own 0600. */
async function readConfig(real) {
  try { const [text, s] = await Promise.all([readFile(real, 'utf8'), stat(real)]); return { text, mode: s.mode & 0o777 }; }
  catch (e) { if (e.code === 'ENOENT') return { text: '', mode: 0o600 }; throw e; }
}

const tilde = (p, home) => (home && (p === home || p.startsWith(home + path.sep)) ? `~${p.slice(home.length)}` : p);

/**
 * Record dir as trusted for Claude Code: projects[key].hasTrustDialogAccepted = true for its keys (claudeKeys) and
 * nothing else changes (the rest of the file, the rest of each project's entry, the file's mode). A missing or empty
 * file starts from {}; a file that does not parse is left as it is and logged. The remaining race: a writer that
 * skips the lock (Claude Code falls back to an unlocked write when it cannot get the lock; older versions may not
 * lock) can still drop the key before the agent starts. The cost is the old dialog, never the file.
 */
export async function trustClaude(dir, { env = process.env } = {}) {
  const engine = 'claude', home = _deps.home();
  const keys = claudeKeys(dir);
  const shown = { key: tilde(keys[0], home), ...(keys.length > 1 ? { also: keys.slice(1).map((k) => tilde(k, home)) } : {}) };
  if (realpathSync(dir) === (home ? await realpath(home).catch(() => home) : null)) return { engine, ...shown, skipped: 'the home folder: Claude Code trusts it for one session at a time and never saves that' };
  const file = claudeConfigFile(env, home), real = await configTarget(file);
  const out = { engine, ...shown, file: tilde(file, home) };
  // Claude Code locks <the path it uses>.lock: it hands proper-lockfile that lockfilePath, which wins over the
  // realpath proper-lockfile would derive a lock from. When the config is itself a link, its target's lock is taken
  // too, so a write that reaches the same file by another path (a second CLAUDE_CONFIG_DIR, say) queues with this
  // one. A symlinked folder above a plain file changes the lock's spelling, not its directory: one lock then.
  const linked = Boolean((await lstat(file).catch(() => null))?.isSymbolicLink());
  return withLocks(linked ? [`${file}.lock`, `${real}.lock`] : [`${file}.lock`], async () => {
    const { text, mode } = await readConfig(real);
    let cfg = {};
    if (text.trim()) {
      try { cfg = JSON.parse(text); } catch (e) { _deps.log(`${file} does not parse (${e.message}): left as it is, ${keys[0]} not trusted`); return { ...out, skipped: `${out.file} does not parse; left as it is` }; }
    }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return { ...out, skipped: `${out.file} is not a JSON object; left as it is` };
    const projects = cfg.projects ?? {};
    const odd = (e) => e !== undefined && (!e || typeof e !== 'object' || Array.isArray(e));
    if (typeof projects !== 'object' || Array.isArray(projects) || keys.some((k) => odd(projects[k]))) return { ...out, skipped: `${out.file} has projects in a shape this does not edit; left as it is` };
    const todo = keys.filter((k) => projects[k]?.hasTrustDialogAccepted !== true);
    if (!todo.length) return { ...out, changed: false };
    cfg.projects = projects;
    for (const k of todo) projects[k] = { ...projects[k], hasTrustDialogAccepted: true };
    await replaceFile(real, JSON.stringify(cfg, null, 2), mode);   // Claude Code's own layout: two spaces, no final newline
    return { ...out, changed: true };
  });
}

/** A TOML basic string, as Codex writes its project keys. */
export const tomlString = (s) => `"${s.replace(/[\\"\u0000-\u001f\u007f]/g, (c) => (c === '\\' || c === '"' ? `\\${c}` : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`))}"`;

/**
 * Record dir's repository as trusted for Codex: a [projects."<root>"] table with trust_level = "trusted", added at
 * the end of config.toml, and nothing else touched. A table already there is only read: its decision ("untrusted"
 * too) is kept, and one without a trust_level this reads is left alone. A config that names the root anywhere
 * else (another quoting such as ["projects"."<root>"], a [projects] entry, dotted keys, any other key), or holds
 * projects as an inline table, is left alone: a second definition would stop Codex from starting. Drover's writers queue on
 * <target>.drover-lock (configTarget), so concurrent launches keep every entry, whatever path they reach it by.
 * Codex itself keeps no lock, so one race stays: a Codex write in the same few milliseconds drops one of the two
 * changes (ours costs the old prompt; theirs, say another folder's trust answer, is asked again).
 */
export async function trustCodex(dir, { env = process.env } = {}) {
  const engine = 'codex', home = _deps.home();
  const root = codexRoot(dir);
  if (!root) return { engine, skipped: 'not inside a git repository, where Codex does not ask' };
  const file = codexConfigFile(env, home), real = await configTarget(file);
  const out = { engine, key: tilde(root, home), file: tilde(file, home) };
  return withLocks([`${real}.drover-lock`], async () => {
    const { text, mode } = await readConfig(real);
    const header = `[projects.${tomlString(root)}]`;
    const lines = text.split('\n');
    const at = lines.findIndex((l) => l.trim() === header);
    if (at >= 0) {
      // Codex writes the table with its decision: read it, and never edit a table that is already there.
      for (let i = at + 1; i < lines.length && !/^\s*\[/.test(lines[i]); i++) {
        const m = lines[i].match(/^\s*(["']?)trust_level\1\s*=\s*(.*?)\s*(#.*)?$/);
        if (m) return /^(["'])trusted\1$/.test(m[2]) ? { ...out, changed: false } : { ...out, skipped: `${out.file} already records trust_level = ${m[2]} for it; kept` };
      }
      return { ...out, skipped: `${out.file} has a table for it with no trust_level this reads; left as it is` };
    }
    if (lines.some((l) => l.includes(root) || /^\s*["']?projects["']?\s*=/.test(l))) return { ...out, skipped: `${out.file} names it, or defines projects, in a form this does not edit; left as it is` };
    await replaceFile(real, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${text.trim() ? '\n' : ''}${header}\ntrust_level = "trusted"\n`, mode);
    return { ...out, changed: true };
  });
}

/**
 * The launch's trust step: never throws, because a launch must not fail over a dialog it would otherwise just show.
 * dir must be absolute and exist (tmux would not start the agent there otherwise). Returns what was done, for the
 * launch result and event: { engine, key, file, changed } or { engine, skipped }.
 */
export async function trustFolder(engine, dir, opts = {}) {
  try {
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) return { engine, skipped: 'cwd is not an absolute path' };
    // Hermes asks no folder trust question at start (2026.9.24); its first run asks about telemetry, which stays the owner's.
    if (engine === 'hermes') return { engine, skipped: 'Hermes does not ask to trust a folder' };
    return await (engine === 'codex' ? trustCodex : trustClaude)(dir, opts);
  } catch (e) {
    _deps.log(`${engine} ${dir}: ${e.message}`);
    return { engine, skipped: e.busy ? e.message : `${e.code ?? 'error'}: ${e.message}`.slice(0, 300) };
  }
}
