// core/trust.js and the launch's trust step: a tmux launch records its folder as trusted in the agent's own config,
// the way accepting the agent's first-run trust dialog would (Claude Code: ~/.claude.json projects[<key>]
// .hasTrustDialogAccepted; Codex: config.toml [projects."<root>"] trust_level), and changes nothing else.
// Everything runs in a temp HOME with fake configs; the git repositories and worktrees are real ones made there.
// Run: node --test test/trust.test.js
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat, lstat, chmod, utimes, rmdir } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import path from 'node:path';

const T = realpathSync(await mkdtemp(path.join(tmpdir(), 'drover-trust-')));   // macOS tmpdir is a symlink: keys are real paths
const HOME = path.join(T, 'home');
await mkdir(path.join(T, 'dotfiles', 'claude'), { recursive: true });
await mkdir(HOME, { recursive: true });
process.env.DROVER_PROFILES = path.join(T, 'profiles.json');
process.env.DROVER_STATE = path.join(T, 'state');
process.env.DROVER_DOTFILES = path.join(T, 'dotfiles');
process.env.DROVER_EVENTS = path.join(T, 'dotfiles', 'claude', 'drover-events.jsonl');
process.env.DROVER_CACHE = path.join(T, 'cache');
process.env.DROVER_HOST = 'testbox';
await writeFile(path.join(T, 'dotfiles', 'claude', 'fleet-hosts.txt'), 'trustbox\n');
await writeFile(process.env.DROVER_PROFILES, JSON.stringify({
  claude: { models: [], profiles: [{ id: 'claude-skip', label: 'skip permissions', argv: ['--dangerously-skip-permissions'], env: {}, default: true }] },
  codex: { models: [], profiles: [{ id: 'codex-default', label: 'default', argv: [], env: {}, default: true }] },
}));

const trust = await import('../core/trust.js');
const launchMod = await import('../core/launch.js');
const remote = await import('../core/remote.js');
const api = await import('../core/api.js');
const codex = await import('../core/codex.js');
const logs = [];
trust._deps.home = () => HOME;
trust._deps.log = (m) => logs.push(m);
const NO_ENV = {};   // no CLAUDE_CONFIG_DIR or CODEX_HOME: the files under HOME
const CLAUDE = path.join(HOME, '.claude.json');
const CODEX = path.join(HOME, '.codex', 'config.toml');

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
const git = (...args) => { const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { env: GIT_ENV, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
const hasGit = spawnSync('git', ['--version']).status === 0;
let n = 0;
const freshDir = async (name = 'work') => { const d = path.join(T, `${name}-${++n}`); await mkdir(d, { recursive: true }); return d; };
async function repoWithWorktree() {
  const repo = await freshDir('repo'), wt = path.join(T, `wt-${n}`);
  git('init', '-q', repo); git('-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init'); git('-C', repo, 'worktree', 'add', '-q', wt, '-b', `wt-${n}`);
  return { repo, wt };
}
const readJson = async (f) => JSON.parse(await readFile(f, 'utf8'));
const modeOf = async (f) => (await stat(f)).mode & 0o777;

after(async () => { codex.sharedClient().stop(); remote.stopAll(); await rm(T, { recursive: true, force: true }); });   // nothing may keep this process alive

describe('Claude Code: ~/.claude.json projects[<key>].hasTrustDialogAccepted', () => {
  test('the key is added; every other key, project and the file mode stay; the layout is Claude Code\'s own', async () => {
    const dir = await freshDir();
    const original = { numStartups: 5, oauthAccount: { emailAddress: 'someone@example.com' }, projects: { '/elsewhere': { allowedTools: ['Bash'], hasTrustDialogAccepted: false, lastCost: 1.5 } }, tipsHistory: { a: 1 } };
    await writeFile(CLAUDE, JSON.stringify(original, null, 2), { mode: 0o640 }); await chmod(CLAUDE, 0o640);
    const r = await trust.trustFolder('claude', dir, { env: NO_ENV });
    assert.deepEqual(r, { engine: 'claude', key: dir, file: '~/.claude.json', changed: true });
    const want = { ...original, projects: { ...original.projects, [dir]: { hasTrustDialogAccepted: true } } };
    assert.equal(await readFile(CLAUDE, 'utf8'), JSON.stringify(want, null, 2), 'two-space JSON, no final newline, nothing else changed');
    assert.equal(await modeOf(CLAUDE), 0o640);
    assert.ok(!existsSync(`${CLAUDE}.lock`), 'the lock is released');
  });

  test('an existing entry keeps its other fields; a second launch there rewrites nothing', async () => {
    const dir = await freshDir();
    await writeFile(CLAUDE, JSON.stringify({ projects: { [dir]: { allowedTools: ['Read'], hasTrustDialogAccepted: false, lastSessionId: 's1' } } }, null, 2));
    assert.equal((await trust.trustClaude(dir, { env: NO_ENV })).changed, true);
    assert.deepEqual((await readJson(CLAUDE)).projects[dir], { allowedTools: ['Read'], hasTrustDialogAccepted: true, lastSessionId: 's1' });
    const s1 = await stat(CLAUDE);
    assert.equal((await trust.trustClaude(dir, { env: NO_ENV })).changed, false);
    const s2 = await stat(CLAUDE);
    assert.deepEqual([s2.ino, s2.mtimeMs], [s1.ino, s1.mtimeMs], 'already trusted: the file is not touched');
  });

  test('a file that does not parse, or is not an object, is left byte for byte and logged', async () => {
    const dir = await freshDir();
    for (const text of ['{"projects": {"/x": ', '[]', 'null', '{"projects": []}']) {
      await writeFile(CLAUDE, text);
      logs.length = 0;
      const r = await trust.trustFolder('claude', dir, { env: NO_ENV });
      assert.match(r.skipped, /does not parse|not a JSON object|projects in a shape/, text);
      assert.equal(r.changed, undefined);
      assert.equal(await readFile(CLAUDE, 'utf8'), text, 'never truncated or rewritten');
    }
    await writeFile(CLAUDE, '{"projects": {"/x": ');
    logs.length = 0;
    await trust.trustFolder('claude', dir, { env: NO_ENV });
    assert.ok(logs.some((l) => /does not parse/.test(l)), 'the skip is logged');
  });

  test('a missing file is created 0600; an empty one starts from {} and keeps its mode', async () => {
    const dir = await freshDir();
    await rm(CLAUDE, { force: true });
    assert.equal((await trust.trustClaude(dir, { env: NO_ENV })).changed, true);
    assert.deepEqual(await readJson(CLAUDE), { projects: { [dir]: { hasTrustDialogAccepted: true } } });
    assert.equal(await modeOf(CLAUDE), 0o600, 'Claude Code\'s own mode for a new config');
    await writeFile(CLAUDE, '', { mode: 0o644 }); await chmod(CLAUDE, 0o644);
    await trust.trustClaude(dir, { env: NO_ENV });
    assert.deepEqual(await readJson(CLAUDE), { projects: { [dir]: { hasTrustDialogAccepted: true } } });
    assert.equal(await modeOf(CLAUDE), 0o644);
  });

  test('a symlinked folder is keyed by its real path, and a trailing slash changes nothing', async () => {
    const dir = await freshDir(), link = path.join(T, `link-${n}`);
    await symlink(dir, link);
    assert.equal(trust.claudeKey(`${link}/`), dir);
    await writeFile(CLAUDE, '{}');
    assert.equal((await trust.trustClaude(`${link}/`, { env: NO_ENV })).key, dir);
    assert.deepEqual(Object.keys((await readJson(CLAUDE)).projects), [dir]);
  });

  test('the home folder is never written: Claude Code keeps that answer for one session', async () => {
    await writeFile(CLAUDE, '{}');
    const r = await trust.trustFolder('claude', HOME, { env: NO_ENV });
    assert.match(r.skipped, /the home folder/);
    assert.equal(await readFile(CLAUDE, 'utf8'), '{}');
  });

  test('a missing folder or a relative path is skipped, never thrown', async () => {
    assert.match((await trust.trustFolder('claude', path.join(T, 'nope', 'x'), { env: NO_ENV })).skipped, /ENOENT/);
    assert.deepEqual(await trust.trustFolder('claude', 'relative/dir', { env: NO_ENV }), { engine: 'claude', skipped: 'cwd is not an absolute path' });
  });

  test('CLAUDE_CONFIG_DIR and a legacy .config.json in use decide the file, as in Claude Code', async () => {
    const cfg = await freshDir('cfgdir');
    assert.equal(trust.claudeConfigFile({}, HOME), CLAUDE);
    assert.equal(trust.claudeConfigFile({ CLAUDE_CONFIG_DIR: cfg }, HOME), path.join(cfg, '.claude.json'));
    assert.equal(trust.claudeConfigFile({ CLAUDE_CONFIG_DIR: 'relative' }, HOME), CLAUDE, 'a relative CLAUDE_CONFIG_DIR is not used');
    await writeFile(path.join(cfg, '.config.json'), '{"numStartups": 1}');
    assert.equal(trust.claudeConfigFile({ CLAUDE_CONFIG_DIR: cfg }, HOME), path.join(cfg, '.config.json'), 'a non-empty legacy file is the one in use');
    const dir = await freshDir();
    await trust.trustClaude(dir, { env: { CLAUDE_CONFIG_DIR: cfg } });
    assert.deepEqual(await readJson(path.join(cfg, '.config.json')), { numStartups: 1, projects: { [dir]: { hasTrustDialogAccepted: true } } });
  });
});

describe('Claude Code\'s config lock (<file>.lock, proper-lockfile)', () => {
  test('a held lock is waited for, then taken and released', async () => {
    const dir = await freshDir();
    await writeFile(CLAUDE, '{}');
    await mkdir(`${CLAUDE}.lock`);
    const t0 = Date.now();
    setTimeout(() => rmdir(`${CLAUDE}.lock`), 200);
    assert.equal((await trust.trustClaude(dir, { env: NO_ENV })).changed, true);
    assert.ok(Date.now() - t0 >= 180, 'waited for the holder');
    assert.ok(!existsSync(`${CLAUDE}.lock`));
  });

  test('an abandoned lock (no refresh for 10 s) is taken, as Claude Code takes it', async () => {
    const dir = await freshDir();
    await writeFile(CLAUDE, '{}');
    await mkdir(`${CLAUDE}.lock`);
    const old = new Date(Date.now() - 20_000);
    await utimes(`${CLAUDE}.lock`, old, old);
    assert.equal((await trust.trustClaude(dir, { env: NO_ENV })).changed, true);
    assert.ok(!existsSync(`${CLAUDE}.lock`));
  });

  test('a lock held past lockWaitMs: nothing is written, the holder\'s lock stays, the launch is told', async () => {
    const dir = await freshDir(), wait = trust._deps.lockWaitMs;
    await writeFile(CLAUDE, '{}');
    await mkdir(`${CLAUDE}.lock`);
    trust._deps.lockWaitMs = 150;
    try {
      const r = await trust.trustFolder('claude', dir, { env: NO_ENV });
      assert.match(r.skipped, /held by another process/);
      assert.equal(await readFile(CLAUDE, 'utf8'), '{}');
      assert.ok(existsSync(`${CLAUDE}.lock`), 'a live holder\'s lock is not ours to remove');
    } finally { trust._deps.lockWaitMs = wait; await rmdir(`${CLAUDE}.lock`); }
  });
});

describe('a symlinked config: one identity for its lock, its read and its write', () => {
  const target = path.join(HOME, 'dotfiles-claude.json');
  after(async () => { await rm(CLAUDE, { force: true }); await rm(target, { force: true }); });

  test('Claude Code\'s lock on the path it uses and the target\'s lock are both held; the write lands in the target and the link stays', async () => {
    const dir = await freshDir();
    await rm(CLAUDE, { force: true });
    await writeFile(target, '{"numStartups": 3}', { mode: 0o600 });
    await symlink(target, CLAUDE);
    // Claude Code locks <the path it uses>.lock (it passes that lockfilePath to proper-lockfile); another path to the
    // same file is serialized by the target's lock. Either one held makes the step wait for it.
    for (const held of [`${CLAUDE}.lock`, `${target}.lock`]) {
      await writeFile(target, '{"numStartups": 3}');
      await mkdir(held);
      const t0 = Date.now();
      setTimeout(() => rmdir(held), 200);
      assert.equal((await trust.trustClaude(dir, { env: NO_ENV })).changed, true, held);
      assert.ok(Date.now() - t0 >= 180, `waited for ${path.basename(held)}`);
    }
    assert.ok((await lstat(CLAUDE)).isSymbolicLink(), 'still a link');
    assert.deepEqual(await readJson(target), { numStartups: 3, projects: { [dir]: { hasTrustDialogAccepted: true } } });
    const { readdirSync } = await import('node:fs');
    assert.deepEqual(readdirSync(HOME).filter((f) => /lock$|\.tmp$/.test(f)), [], 'every lock released, no temp file left');
  });

  test('two config paths to one file (two CLAUDE_CONFIG_DIRs) queue on the target, so concurrent launches keep every key', async () => {
    const a = await freshDir('cfg-a'), b = await freshDir('cfg-b');
    await writeFile(target, '{}', { mode: 0o600 });
    await symlink(target, path.join(a, '.claude.json')); await symlink(target, path.join(b, '.claude.json'));
    const dirs = [];
    for (let i = 0; i < 6; i++) dirs.push(await freshDir());
    await Promise.all(dirs.map((d, i) => trust.trustClaude(d, { env: { CLAUDE_CONFIG_DIR: i % 2 ? a : b } })));
    assert.deepEqual(Object.keys((await readJson(target)).projects).sort(), [...dirs].sort());
  });

  test('a plain config under a symlinked folder (a CLAUDE_CONFIG_DIR linked into dotfiles) takes one lock: quick, never busy', async () => {
    const realDir = await freshDir('dotfiles-claude'), linkDir = path.join(T, `claude-config-${n}`);
    await symlink(realDir, linkDir);
    const config = path.join(realDir, '.claude.json'), env = { CLAUDE_CONFIG_DIR: linkDir };
    await writeFile(config, '{}', { mode: 0o600 });
    const dir = await freshDir(), t0 = Date.now();
    const r = await trust.trustFolder('claude', dir, { env });
    assert.equal(r.changed, true, JSON.stringify(r));
    assert.ok(Date.now() - t0 < 1000, `${Date.now() - t0} ms: the lock's two spellings are one directory, taken once`);
    assert.deepEqual((await readJson(config)).projects, { [dir]: { hasTrustDialogAccepted: true } });
    // It is the lock Claude Code takes through that folder: held by its link spelling, the step waits for it.
    await mkdir(path.join(linkDir, '.claude.json.lock'));
    setTimeout(() => rmdir(path.join(realDir, '.claude.json.lock')), 200);
    const t1 = Date.now();
    assert.equal((await trust.trustClaude(await freshDir(), { env })).changed, true);
    assert.ok(Date.now() - t1 >= 180, 'waited for Claude Code\'s lock');
    const { readdirSync } = await import('node:fs');
    assert.deepEqual(readdirSync(realDir).filter((f) => /lock$|\.tmp$/.test(f)), [], 'released, no temp file left');
  });

  test('a symlinked config under a symlinked folder: Claude Code\'s lock and the target\'s are two directories, both held', async () => {
    const realDir = await freshDir('dotfiles-claude'), linkDir = path.join(T, `claude-config-${n}`);
    await symlink(realDir, linkDir);
    const targetFile = path.join(await freshDir('elsewhere'), 'claude.json'), env = { CLAUDE_CONFIG_DIR: linkDir };
    await writeFile(targetFile, '{}', { mode: 0o600 });
    await symlink(targetFile, path.join(realDir, '.claude.json'));
    for (const held of [path.join(linkDir, '.claude.json.lock'), `${targetFile}.lock`]) {
      await mkdir(held);
      setTimeout(() => rmdir(held), 200);
      const t0 = Date.now();
      assert.equal((await trust.trustClaude(await freshDir(), { env })).changed, true, held);
      assert.ok(Date.now() - t0 >= 180, `waited for ${held}`);
    }
    const t1 = Date.now();
    assert.equal((await trust.trustClaude(await freshDir(), { env })).changed, true);
    assert.ok(Date.now() - t1 < 1000, 'with nobody holding them, each is taken once and nothing reports busy');
    assert.ok((await lstat(path.join(realDir, '.claude.json'))).isSymbolicLink(), 'still a link');
    assert.equal(Object.keys((await readJson(targetFile)).projects).length, 3, 'every write landed in the target');
  });

  test('a link to a missing file is left as it is, not replaced by a file', async () => {
    await rm(CLAUDE, { force: true });
    await symlink(path.join(HOME, 'nowhere.json'), CLAUDE);
    const r = await trust.trustFolder('claude', await freshDir(), { env: NO_ENV });
    assert.match(r.skipped, /a link to a missing file; left as it is/);
    assert.ok((await lstat(CLAUDE)).isSymbolicLink()); assert.ok(!existsSync(path.join(HOME, 'nowhere.json')));
    await rm(CLAUDE, { force: true });
  });
});

describe('git: the canonical root', { skip: hasGit ? false : 'git is not installed here' }, () => {
  test('a subfolder of a checkout is keyed by the checkout; a linked worktree by its main checkout', async () => {
    const { repo, wt } = await repoWithWorktree();
    await mkdir(path.join(repo, 'sub', 'deep'), { recursive: true });
    await mkdir(path.join(wt, 'pkg'), { recursive: true });
    assert.equal(trust.claudeKey(path.join(repo, 'sub', 'deep')), repo);
    assert.equal(trust.claudeKey(wt), repo, 'accepting in a worktree trusts the repository, so writing the main checkout is what the dialog does');
    assert.equal(trust.claudeKey(path.join(wt, 'pkg')), repo);
    assert.deepEqual(trust.claudeKeys(path.join(wt, 'pkg')), [repo, wt], 'and the worktree root, for a version that keys worktrees apart');
    assert.deepEqual(trust.claudeKeys(path.join(repo, 'sub')), [repo]);
    assert.equal(trust.codexRoot(wt), repo);
    assert.equal(trust.codexRoot(path.join(repo, 'sub')), repo);
  });

  test('a worktree launch trusts the main checkout and the worktree root in one write; done once, it is left alone', async () => {
    const { repo, wt } = await repoWithWorktree();
    await writeFile(CLAUDE, JSON.stringify({ projects: { [repo]: { allowedTools: [], hasTrustDialogAccepted: false } } }, null, 2));
    assert.deepEqual(await trust.trustClaude(wt, { env: NO_ENV }), { engine: 'claude', key: repo, also: [wt], file: '~/.claude.json', changed: true });
    assert.deepEqual((await readJson(CLAUDE)).projects, { [repo]: { allowedTools: [], hasTrustDialogAccepted: true }, [wt]: { hasTrustDialogAccepted: true } });
    assert.equal((await trust.trustClaude(path.join(wt, '.'), { env: NO_ENV })).changed, false);
  });

  test('a worktree of a bare repository is keyed by the repository; a .git file that is not a worktree keeps its own root', async () => {
    const { repo } = await repoWithWorktree();
    const bare = path.join(T, `bare-${n}.git`), bwt = path.join(T, `bwt-${n}`);
    git('clone', '-q', '--bare', repo, bare); git('-C', bare, 'worktree', 'add', '-q', bwt);
    assert.deepEqual(trust.claudeKeys(bwt), [bare, bwt]);
    const sub = await freshDir('submodule-like');
    await mkdir(path.join(T, `modules-${n}`), { recursive: true });
    await writeFile(path.join(sub, '.git'), `gitdir: ${path.join(T, `modules-${n}`)}\n`);   // no commondir: a submodule's layout
    assert.deepEqual(trust.claudeKeys(sub), [sub]);
  });
});

describe('Codex: config.toml [projects."<root>"] trust_level = "trusted"', { skip: hasGit ? false : 'git is not installed here' }, () => {
  const head = 'model = "m"\napproval_policy = "never"\n\n[profiles.p]\nmodel = "x"\n\n[projects."/somewhere"]\ntrust_level = "trusted"\n';

  test('a table for the repository root is added at the end and nothing else changes; the mode stays', async () => {
    const { repo, wt } = await repoWithWorktree();
    await mkdir(path.dirname(CODEX), { recursive: true });
    await writeFile(CODEX, head, { mode: 0o600 });
    const r = await trust.trustFolder('codex', wt, { env: NO_ENV });
    assert.deepEqual(r, { engine: 'codex', key: repo, file: '~/.codex/config.toml', changed: true });
    assert.equal(await readFile(CODEX, 'utf8'), `${head}\n[projects.${trust.tomlString(repo)}]\ntrust_level = "trusted"\n`);
    assert.equal(await modeOf(CODEX), 0o600);
    assert.equal((await trust.trustCodex(wt, { env: NO_ENV })).changed, false, 'the second time it is already there');
  });

  test('a table already there is only read: its decision is kept, quoted keys too; one without a trust_level is left alone', async () => {
    const { repo, wt } = await repoWithWorktree();
    const table = `[projects.${trust.tomlString(repo)}]`;
    for (const [body, want] of [['trust_level = "untrusted"', /already records trust_level = "untrusted"/], ['"trust_level" = "untrusted"', /already records trust_level = "untrusted"/], ["'trust_level' = 'untrusted' # by hand", /already records trust_level = 'untrusted'/], ['note = 1', /has a table for it with no trust_level this reads/]]) {
      const text = `${head}\n${table}\n${body}\n\n[other]\nx = 1\n`;
      await writeFile(CODEX, text);
      assert.match((await trust.trustCodex(wt, { env: NO_ENV })).skipped, want, body);
      assert.equal(await readFile(CODEX, 'utf8'), text, `${body}: never edited`);
    }
    for (const body of ['trust_level = "trusted"', '"trust_level" = \'trusted\'']) {
      await writeFile(CODEX, `${table}\n${body}\n`);
      assert.equal((await trust.trustCodex(wt, { env: NO_ENV })).changed, false, body);
    }
  });

  test('projects written in any other form is left alone: a second definition would stop Codex from starting', async () => {
    const { repo, wt } = await repoWithWorktree();
    for (const text of [`[projects]\n${trust.tomlString(repo)} = { trust_level = "trusted" }\n`, 'projects = {}\n', '"projects" = { }\n', `projects.${trust.tomlString(repo)}.trust_level = "untrusted"\n`, `[projects.'${repo}']\nx = 1\n`,
      `["projects".${trust.tomlString(repo)}]\ntrust_level = "untrusted"\n`, `[ "projects" . '${repo}' ]\ntrust_level = "untrusted"\n`, `[sandbox_workspace_write]\nwritable_roots = [${trust.tomlString(repo)}]\n`]) {
      await writeFile(CODEX, text);
      assert.match((await trust.trustCodex(wt, { env: NO_ENV })).skipped, /in a form this does not edit/, text);
      assert.equal(await readFile(CODEX, 'utf8'), text);
    }
  });

  test('concurrent launches keep every entry, Codex and Claude alike, and leave no temp file or lock behind', async () => {
    const made = [];
    for (let i = 0; i < 5; i++) made.push(await repoWithWorktree());   // made one by one: the launches below run at once
    await writeFile(CODEX, head);
    const rs = await Promise.all(made.map(({ wt }) => trust.trustCodex(wt, { env: NO_ENV })));
    assert.deepEqual(rs.map((r) => r.changed), [true, true, true, true, true]);
    const text = await readFile(CODEX, 'utf8');
    for (const { repo } of made) assert.equal(text.split('\n').filter((l) => l === `[projects.${trust.tomlString(repo)}]`).length, 1, repo);
    assert.ok(text.startsWith(head), 'what was there is untouched');
    await writeFile(CLAUDE, '{}');
    await Promise.all(made.map(({ repo }) => trust.trustClaude(repo, { env: NO_ENV })));
    assert.deepEqual(Object.keys((await readJson(CLAUDE)).projects).sort(), made.map(({ repo }) => repo).sort());
    const { readdirSync } = await import('node:fs');
    for (const dir of [HOME, path.dirname(CODEX)]) assert.deepEqual(readdirSync(dir).filter((f) => /\.tmp$|lock$/.test(f)), [], dir);
  });

  test('outside git there is nothing to do; a missing config.toml is created 0600', async () => {
    await writeFile(CODEX, head);
    assert.deepEqual(await trust.trustFolder('codex', await freshDir(), { env: NO_ENV }), { engine: 'codex', skipped: 'not inside a git repository, where Codex does not ask' });
    assert.equal(await readFile(CODEX, 'utf8'), head);
    const { repo, wt } = await repoWithWorktree();
    await rm(CODEX);
    await trust.trustCodex(wt, { env: NO_ENV });
    assert.equal(await readFile(CODEX, 'utf8'), `[projects.${trust.tomlString(repo)}]\ntrust_level = "trusted"\n`);
    assert.equal(await modeOf(CODEX), 0o600);
    const home = await freshDir('codexhome');
    assert.equal(trust.codexConfigFile({ CODEX_HOME: home }, HOME), path.join(home, 'config.toml'));
  });

  test('a symlinked config.toml is written at its target, under the target\'s lock; the link stays a link', async () => {
    const { repo, wt } = await repoWithWorktree();
    const real = path.join(HOME, 'dotfiles-codex.toml');
    await writeFile(real, head, { mode: 0o600 });
    await rm(CODEX, { force: true }); await symlink(real, CODEX);
    try {
      await mkdir(`${real}.drover-lock`);
      const t0 = Date.now();
      setTimeout(() => rmdir(`${real}.drover-lock`), 200);
      assert.equal((await trust.trustCodex(wt, { env: NO_ENV })).changed, true);
      assert.ok(Date.now() - t0 >= 180, 'waited for the target\'s lock');
      assert.ok((await lstat(CODEX)).isSymbolicLink());
      assert.equal(await readFile(real, 'utf8'), `${head}\n[projects.${trust.tomlString(repo)}]\ntrust_level = "trusted"\n`);
    } finally { await rm(CODEX, { force: true }); await rm(real, { force: true }); }
  });

  test('tomlString writes a basic string, as Codex does', () => {
    assert.equal(trust.tomlString('/a/b'), '"/a/b"');
    assert.equal(trust.tomlString('/a "q" \\ b\tc\u0001'), '"/a \\"q\\" \\\\ b\\u0009c\\u0001"');
  });
});

// ---------------------------------------------------------------- the launch

const windows = [];
launchMod._deps.newWindow = async (opts) => {
  // What the agent will read when it starts: the config as it is when the window opens.
  windows.push({ ...opts, configThen: existsSync(CLAUDE) ? await readFile(CLAUDE, 'utf8') : null });
  return { target: `agents:${windows.length}` };
};
launchMod._deps.agentPath = async () => process.env.PATH;
const lastEvent = async () => JSON.parse((await readFile(process.env.DROVER_EVENTS, 'utf8')).trim().split('\n').at(-1));

describe('launch.start in tmux', () => {
  before(() => { launchMod._deps.trustFolder = (engine, dir, opts) => trust.trustFolder(engine, dir, { ...opts, env: NO_ENV }); });

  test('trusts cwd before the window opens; the result and the launch event say what was done', async () => {
    const dir = await freshDir();
    await writeFile(CLAUDE, '{}');
    const r = await launchMod.launch({ engine: 'claude', mode: 'tmux', cwd: dir, credential: 'none', name: 't1' }, { actor: 't' });
    const want = { engine: 'claude', key: dir, file: '~/.claude.json', changed: true };
    assert.deepEqual(r.trust, want);
    assert.deepEqual(JSON.parse(windows.at(-1).configThen).projects[dir], { hasTrustDialogAccepted: true }, 'on disk before the agent starts');
    const ev = await lastEvent();
    assert.equal(ev.type, 'launch'); assert.deepEqual(ev.trust, want); assert.equal(ev.id, r.event);
  });

  test('trust: false (or "false") leaves the config alone and says nothing about it', async () => {
    const dir = await freshDir();
    for (const off of [false, 'false']) {
      await writeFile(CLAUDE, '{}');
      const r = await launchMod.launch({ engine: 'claude', mode: 'tmux', cwd: dir, credential: 'none', name: 't2', trust: off }, { actor: 't' });
      assert.equal(await readFile(CLAUDE, 'utf8'), '{}');
      assert.ok(!('trust' in r)); assert.ok(!('trust' in (await lastEvent())));
    }
  });

  test('a Codex launch trusts its repository in config.toml; a headless launch trusts nothing (it never asks)', async () => {
    const { repo, wt } = await repoWithWorktree();
    await writeFile(CODEX, '');
    const r = await launchMod.launch({ engine: 'codex', mode: 'tmux', cwd: wt, credential: 'none', name: 't3' }, { actor: 't' });
    assert.deepEqual(r.trust, { engine: 'codex', key: repo, file: '~/.codex/config.toml', changed: true });
    let called = 0;
    const real = launchMod._deps.trustFolder;
    launchMod._deps.trustFolder = async () => { called++; return null; };
    launchMod._deps.startCodexThread = async () => ({ threadId: 'thread-x' });
    try {
      const h = await launchMod.launch({ engine: 'codex', mode: 'headless', cwd: wt, credential: 'none' }, { actor: 't' });
      assert.equal(called, 0); assert.ok(!('trust' in h));
      h.headlessId && launchMod.headless.get(h.headlessId)?.unsub?.(); launchMod.headless.delete(h.headlessId);
    } finally { launchMod._deps.trustFolder = real; }
  });

  test('a trust step that fails does not fail the launch', async () => {
    const dir = await freshDir();
    await writeFile(CLAUDE, '{"projects": ');
    const r = await launchMod.launch({ engine: 'claude', mode: 'tmux', cwd: dir, credential: 'none', name: 't4' }, { actor: 't' });
    assert.equal(r.ok, true); assert.match(r.trust.skipped, /does not parse/);
    assert.equal(await readFile(CLAUDE, 'utf8'), '{"projects": ');
  });

  test('a launch on another host is trusted there: the request goes to that host\'s drover rpc, nothing is written here', async () => {
    const sent = [];
    remote._deps.spawn = () => {
      const c = new EventEmitter();
      c.stdout = new PassThrough(); c.stderr = new PassThrough();
      c.stdin = { write(d) { for (const line of String(d).split('\n').filter(Boolean)) { const q = JSON.parse(line); sent.push(q); setImmediate(() => c.stdout.write(JSON.stringify({ id: q.id, ok: true, result: { ok: true, trust: { engine: 'claude', key: '/remote/dir', changed: true } } }) + '\n')); } }, end() { setImmediate(() => c.emit('close', 0)); }, on() {} };
      c.kill = () => setImmediate(() => c.emit('close', null));
      return c;
    };
    let local = 0;
    const real = launchMod._deps.trustFolder;
    launchMod._deps.trustFolder = async () => { local++; return null; };
    try {
      const r = await api.dispatch('launch.start', { host: 'trustbox', engine: 'claude', mode: 'tmux', cwd: '/remote/dir', trust: false });
      assert.deepEqual(sent.map((q) => [q.op, q.args.cwd, q.args.trust]), [['launch.start', '/remote/dir', false]], 'the trust choice travels with the launch');
      assert.equal(r.trust.key, '/remote/dir');
      assert.equal(local, 0, 'no trust step on the calling host');
    } finally { launchMod._deps.trustFolder = real; remote.stopAll(); }
  });
});
