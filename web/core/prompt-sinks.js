// Where the prompt spool (core/prompts.js) goes beyond this machine: the sinks of ~/.config/drover/prompts.json
// (DROVER_PROMPTS_CONFIG moves it; absent = the local spool only). Contract: docs/specs/2026-11-21-cohesion-overhaul.md,
// "Storage: local spool + git sinks"; tests: test/prompts-sink.test.js.
//
//   git      its own clone under $STATE/prompt-sinks/<name>, on a dedicated branch (made as an orphan when the remote
//            has none), never a checkout anyone edits. Each sync appends this host's new records to
//            <dir>/<host>/<YYYY-MM-DD>.jsonl (only records that file does not hold yet), commits that host directory
//            alone ("prompts: <host> +N"), pull --rebase, then push; never a force push. One file per host per day:
//            two hosts never write the same file, so a pull never conflicts. The clone is also what the front reads
//            for a host that did not answer.
//   command  runs its argv (no shell) once per day that gained records, with {file} replaced by a file holding just
//            those new records, {dayfile} by this sink's whole copy of that day, {day} and {host}; or {dayfiles}, an argument that
//            becomes every changed day's copy, for one run per sync. An encrypted
//            append (a sync tool's "push --append <file>") is the intended use.
//
// A sink takes the records whose label it lists ("*" for all). Its read position in each spool day file is kept in
// $STATE/prompt-sinks/<name>.state.json and moves only once the records reached it (a commit, a command that exited
// 0), so a failure retries them; a failing sink waits 1 min, 2, 4 ... up to 6 h before the next scheduled try (a manual
// prompts.sync tries at once). Every git call is an argv with no shell, no prompts (GIT_TERMINAL_PROMPT=0, core/git-env.js)
// and a timeout.
import { mkdir, readFile, writeFile, appendFile, readdir, stat, rename, rm, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { run } from './proc.js';
import { gitEnv } from './git-env.js';
import { envvar } from './envvars.js';
import { readNewLines } from './search/indexer.js';

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const BRANCH_RE = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*\.lock$)[A-Za-z0-9._/-]{1,100}(?<![/.])$/;
const DIR_RE = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._/-]{1,200}$/;
const HOST_DIR = (h) => String(h ?? '').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_') || 'unknown';
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const ID_IN = /"id":"(p_[0-9a-f]{16})"/;
export const DEFAULT_SYNC_MINUTES = 30;
// COMMIT_MS: add and commit run the owner's git hooks (a fleet's global hooks may scan the staged diff for secrets), and
// a first sync stages the whole history (tens of MB): 30 s was not enough on a loaded machine.
const LOCAL_MS = 30_000, NET_MS = 120_000, COMMAND_MS = 120_000, COMMIT_MS = 600_000;
const BACKOFF_MS = 60_000, BACKOFF_MAX_MS = 6 * 3600_000;

/** The prompts config file: DROVER_PROMPTS_CONFIG, else prompts.json in DROVER_CONFIG_DIR (~/.config/drover). */
export function configPath(env = process.env) {
  return envvar('PROMPTS_CONFIG', env) ?? path.join(envvar('CONFIG_DIR', env) ?? path.join(env.HOME ?? '', '.config', 'drover'), 'prompts.json');
}

/** The config, checked: { file, found, rules, sinks, syncEveryMinutes, errors }. Never throws: a bad entry is named in errors and left out. */
export async function loadConfig(env = process.env) {
  const file = configPath(env);
  const out = { file, found: false, rules: [], sinks: [], syncEveryMinutes: DEFAULT_SYNC_MINUTES, errors: [] };
  let raw;
  try { raw = await readFile(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') out.errors.push(`${file}: ${e.code ?? e.message}`); return out; }
  out.found = true;
  let c;
  try { c = JSON.parse(raw); } catch (e) { out.errors.push(`${file}: not JSON (${e.message})`); return out; }
  if (!c || typeof c !== 'object') { out.errors.push(`${file}: not an object`); return out; }
  if (Array.isArray(c.rules)) out.rules = c.rules.filter((r) => r && typeof r === 'object');
  const m = Number(c.syncEveryMinutes);
  if (c.syncEveryMinutes !== undefined) { if (Number.isFinite(m) && m >= 1) out.syncEveryMinutes = m; else out.errors.push('syncEveryMinutes: a number of minutes, 1 or more'); }
  const names = new Set();
  for (const s of Array.isArray(c.sinks) ? c.sinks : []) {
    const bad = (why) => out.errors.push(`sink ${JSON.stringify(s?.name ?? '?')}: ${why}`);
    if (!s || typeof s !== 'object') { bad('not an object'); continue; }
    if (typeof s.name !== 'string' || !NAME_RE.test(s.name)) { bad('name: letters, digits, . _ - (up to 64)'); continue; }
    if (names.has(s.name)) { bad('name used twice'); continue; }
    const labels = s.labels === undefined ? ['*'] : Array.isArray(s.labels) ? s.labels.filter((l) => typeof l === 'string' && l) : null;
    if (!labels?.length) { bad('labels: a list of label strings ("*" for every label)'); continue; }
    if (s.type === 'git') {
      if (typeof s.remote !== 'string' || !s.remote.trim() || s.remote.startsWith('-') || /^ext::/i.test(s.remote)) { bad('remote: a git URL'); continue; }
      const branch = s.branch ?? 'drover-prompts', dir = String(s.dir ?? 'prompts').replace(/^\/+|\/+$/g, '');
      if (typeof branch !== 'string' || !BRANCH_RE.test(branch)) { bad('branch: a plain branch name'); continue; }
      if (!DIR_RE.test(dir)) { bad('dir: a relative path inside the repository'); continue; }
      out.sinks.push({ name: s.name, type: 'git', labels, remote: s.remote.trim(), branch, dir, sign: s.sign === true });
    } else if (s.type === 'command') {
      if (!Array.isArray(s.argv) || !s.argv.length || !s.argv.every((a) => typeof a === 'string') || !s.argv[0]) { bad('argv: a list of strings, the program first'); continue; }
      out.sinks.push({ name: s.name, type: 'command', labels, argv: s.argv });
    } else { bad('type: git or command'); continue; }
    names.add(s.name);
  }
  return out;
}

/** The host directories of every git sink's clone, as this machine last pulled them: [{ sink, host, dir }]. */
export async function cloneHostDirs(cfg, env = process.env) {
  const root = path.join(stateDirOf(env), 'prompt-sinks');
  const out = [];
  for (const s of cfg.sinks.filter((x) => x.type === 'git')) {
    const base = path.join(root, s.name, s.dir);
    for (const e of await readdir(base, { withFileTypes: true }).catch(() => [])) if (e.isDirectory() && !e.name.startsWith('.')) out.push({ sink: s.name, host: e.name, dir: path.join(base, e.name) });
  }
  return out;
}
// $STATE without core/paths.js's import-time defaults: the env passed in decides (tests pass their own).
const stateDirOf = (env) => envvar('STATE', env) ?? path.join(env.HOME ?? '', '.local', 'state', 'drover');

const wants = (sink, label) => sink.labels.includes('*') || sink.labels.includes(label);
const idsIn = async (file) => {
  const ids = new Set();
  const raw = await readFile(file, 'utf8').catch(() => '');
  for (const line of raw.split('\n')) { const m = line.match(ID_IN); if (m) ids.add(m[1]); }
  return ids;
};
const oneLine = (e) => String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 400);

export class Sinks {
  constructor({ env = process.env, stateDir, spoolDir, host, log = () => {} } = {}) {
    this.env = env; this.root = path.join(stateDir ?? stateDirOf(env), 'prompt-sinks'); this.spool = spoolDir;
    this.host = host; this.hostDir = HOST_DIR(host); this.log = log;
    this.busy = new Map();   // name -> the sync in progress
  }

  statePath(name) { return path.join(this.root, `${name}.state.json`); }
  async loadState(name) {
    try { const s = JSON.parse(await readFile(this.statePath(name), 'utf8')); return { offsets: {}, failures: 0, ...s }; }
    catch { return { offsets: {}, failures: 0, lastSync: null, lastAttempt: null, lastError: null, nextAttempt: null, pending: 0 }; }
  }
  async saveState(name, st) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const f = this.statePath(name), tmp = `${f}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(st), { mode: 0o600 });
    await rename(tmp, f);
  }

  /** prompts.status's sinks: [{ name, type, labels, lastSync, lastAttempt, lastError, nextAttempt, pending }]. pending: records not delivered yet. */
  async status(cfg) {
    const out = [];
    for (const s of cfg.sinks) {
      const st = await this.loadState(s.name);
      const { records } = await this.#newRecords(s, st).catch(() => ({ records: 0 }));
      out.push({ name: s.name, type: s.type, labels: s.labels, ...(s.type === 'git' ? { branch: s.branch, dir: s.dir } : {}), lastSync: st.lastSync ?? null, lastAttempt: st.lastAttempt ?? null,
        lastError: st.lastError ?? null, nextAttempt: st.nextAttempt ?? null, failures: st.failures ?? 0, pending: records + (st.unpushed ?? 0), syncing: this.busy.has(s.name) });
    }
    return out;
  }

  /** The sinks whose time has come (syncEveryMinutes since the last try, and past any backoff). */
  async syncDue(cfg, now = Date.now()) {
    const due = [];
    for (const s of cfg.sinks) {
      const st = await this.loadState(s.name);
      const last = Date.parse(st.lastAttempt ?? '') || 0, next = Date.parse(st.nextAttempt ?? '') || 0;
      if (now - last >= cfg.syncEveryMinutes * 60_000 && now >= next) due.push(s.name);
    }
    return due.length ? this.syncAll(cfg, { names: new Set(due) }) : [];
  }

  /** Sync the sinks (names: a Set, or all). force skips the backoff wait. [{ name, type, ok, added, ms, error?, pushed? }] */
  async syncAll(cfg, { names = null, force = false } = {}) {
    const out = [];
    for (const s of cfg.sinks) {
      if (names && !names.has(s.name)) continue;
      out.push(await this.sync(s, { force }));
    }
    if (names) for (const n of names) if (!cfg.sinks.some((s) => s.name === n)) out.push({ name: n, ok: false, error: `no sink ${n} in ${cfg.file}` });
    return out;
  }

  /** One sink, one sync at a time (a second call waits for the first and gets its answer). */
  sync(sink, opts = {}) {
    if (!this.busy.has(sink.name)) this.busy.set(sink.name, this.#sync(sink, opts).finally(() => this.busy.delete(sink.name)));
    return this.busy.get(sink.name);
  }

  async #sync(sink, { force = false } = {}) {
    const t0 = Date.now();
    const st = await this.loadState(sink.name);
    if (!force && Date.now() < (Date.parse(st.nextAttempt ?? '') || 0)) return { name: sink.name, type: sink.type, ok: false, skipped: true, error: `backing off until ${st.nextAttempt}: ${st.lastError}`, ms: 0 };
    st.lastAttempt = new Date().toISOString();
    try {
      const r = sink.type === 'git' ? await this.#syncGit(sink, st) : await this.#syncCommand(sink, st);
      Object.assign(st, { lastSync: new Date().toISOString(), lastError: null, failures: 0, nextAttempt: null });
      await this.saveState(sink.name, st);
      return { name: sink.name, type: sink.type, ok: true, ...r, ms: Date.now() - t0 };
    } catch (e) {
      st.failures = (st.failures ?? 0) + 1;
      st.lastError = oneLine(e);
      st.nextAttempt = new Date(Date.now() + Math.min(BACKOFF_MAX_MS, BACKOFF_MS * 2 ** (st.failures - 1))).toISOString();
      await this.saveState(sink.name, st).catch(() => {});
      return { name: sink.name, type: sink.type, ok: false, error: st.lastError, nextAttempt: st.nextAttempt, ms: Date.now() - t0 };
    }
  }

  /**
   * The spool records this sink has not taken yet, per day: { days: [{ day, end, records: [...] }], records }. Read from
   * each day file's saved position to its end; only the sink's labels.
   */
  async #newRecords(sink, st, { parse = false } = {}) {
    const days = [];
    let n = 0;
    for (const name of (await readdir(this.spool).catch(() => [])).sort()) {
      const day = name.match(DAY_FILE)?.[1];
      if (!day) continue;
      const file = path.join(this.spool, name);
      const size = (await stat(file).catch(() => null))?.size ?? 0;
      const from = Math.min(st.offsets?.[day] ?? 0, size);
      if (size <= from) continue;
      const recs = [];
      let end = from;
      for await (const win of readNewLines(file, from, size)) {
        for (const line of win.lines) {
          let r; try { r = JSON.parse(line); } catch { continue; }
          if (r && typeof r.id === 'string' && wants(sink, r.label)) recs.push(parse ? r : line);
        }
        end = win.end;
      }
      n += recs.length;
      days.push({ day, end, records: recs });
    }
    return { days, records: n };
  }

  // ---------------------------------------------------------------- git

  #git(cwd, args, { timeoutMs = LOCAL_MS, okCodes } = {}) {
    return run('git', args, { cwd, env: gitEnv(), timeoutMs, ...(okCodes ? { okCodes } : {}) });
  }

  async #syncGit(sink, st) {
    const repo = path.join(this.root, sink.name);
    const branch = sink.branch, ref = `refs/heads/${branch}`, tracking = `refs/remotes/origin/${branch}`;
    await mkdir(repo, { recursive: true, mode: 0o700 });
    if (!existsSync(path.join(repo, '.git'))) {
      await this.#git(repo, ['init', '-q']);
      await this.#git(repo, ['remote', 'add', 'origin', sink.remote]);
    } else await this.#git(repo, ['remote', 'set-url', 'origin', sink.remote]);
    // The dedicated branch is the one checked out, whatever init called its first branch.
    const head = (await this.#git(repo, ['symbolic-ref', '-q', 'HEAD'], { okCodes: [0, 1] })).stdout.trim();
    if (head !== ref) await this.#git(repo, ['symbolic-ref', 'HEAD', ref]);
    const localHas = (await this.#git(repo, ['rev-parse', '--verify', '-q', ref], { okCodes: [0, 1] })).code === 0;
    const ls = await this.#git(repo, ['ls-remote', '--heads', 'origin', ref], { timeoutMs: NET_MS });
    const remoteHas = ls.stdout.trim().length > 0;
    if (remoteHas) {
      await this.#git(repo, ['fetch', '-q', 'origin', `+${ref}:${tracking}`], { timeoutMs: NET_MS });
      // A new clone starts from what the remote holds (the other hosts' files and this host's own, from before).
      if (!localHas) { await this.#git(repo, ['update-ref', ref, tracking]); await this.#git(repo, ['reset', '-q', '--hard', ref]); }
    }
    // An identity for the commits, when git has none here.
    const email = (await this.#git(repo, ['config', 'user.email'], { okCodes: [0, 1] })).stdout.trim();
    if (!email) { await this.#git(repo, ['config', 'user.email', 'drover@localhost']); await this.#git(repo, ['config', 'user.name', 'Drover']); }

    const { days } = await this.#newRecords(sink, st);
    const hostRel = path.posix.join(sink.dir, this.hostDir);
    const hostAbs = path.join(repo, sink.dir, this.hostDir);
    let added = 0;
    for (const d of days) {
      if (!d.records.length) continue;
      await mkdir(hostAbs, { recursive: true });
      const file = path.join(hostAbs, `${d.day}.jsonl`);
      const have = await idsIn(file);
      const lines = d.records.filter((l) => { const id = l.match(ID_IN)?.[1]; if (!id || have.has(id)) return false; have.add(id); return true; });
      if (lines.length) { await appendFile(file, lines.join('\n') + '\n'); added += lines.length; }
    }
    if (added) {
      await this.#git(repo, ['add', '--', hostRel], { timeoutMs: COMMIT_MS });
      await this.#git(repo, ['-c', `commit.gpgsign=${sink.sign ? 'true' : 'false'}`, 'commit', '-q', '-m', `prompts: ${this.host} +${added}`, '--', hostRel], { timeoutMs: COMMIT_MS });
    }
    // Delivered to the clone: the spool positions move now, the push below (or the next sync's) carries them out.
    for (const d of days) st.offsets[d.day] = d.end;
    st.unpushed = (st.unpushed ?? 0) + added;
    await this.saveState(sink.name, st);
    const hasCommits = (await this.#git(repo, ['rev-parse', '--verify', '-q', ref], { okCodes: [0, 1] })).code === 0;
    let pushed = false;
    if (hasCommits) {
      for (let attempt = 0; ; attempt++) {
        if (remoteHas || attempt > 0) await this.#pullRebase(repo, branch);
        try { await this.#git(repo, ['push', '-q', 'origin', `${ref}:${ref}`], { timeoutMs: COMMIT_MS }); pushed = true; break; }   // pre-push hooks scan too
        catch (e) { if (attempt >= 1 || !/rejected|non-fast-forward|fetch first/i.test(e.message)) throw e; }
      }
      st.unpushed = 0; st.lastPush = new Date().toISOString();
    }
    return { added, pushed };
  }

  async #pullRebase(repo, branch) {
    try { await this.#git(repo, ['-c', 'rebase.autoStash=false', 'pull', '-q', '--rebase', '--no-autostash', 'origin', branch], { timeoutMs: NET_MS }); }
    catch (e) {
      await this.#git(repo, ['rebase', '--abort'], { okCodes: [0, 1, 128] }).catch(() => {});
      throw e;
    }
  }

  // ---------------------------------------------------------------- command

  async #syncCommand(sink, st) {
    const { days } = await this.#newRecords(sink, st);
    const base = path.join(this.root, sink.name);
    const mirror = path.join(base, this.hostDir);
    let added = 0, runs = 0;
    // {dayfiles}: one run for every day that gained records, the argument replaced by each day's whole copy (a
    // backfill of months is then one push, not one per day). The days move on together once that run succeeds.
    if (sink.argv.includes('{dayfiles}')) {
      const files = [];
      for (const d of days) {
        if (!d.records.length) continue;
        await mkdir(mirror, { recursive: true, mode: 0o700 });
        const dayfile = path.join(mirror, `${d.day}.jsonl`);
        const have = await idsIn(dayfile);
        const fresh = d.records.filter((l) => !have.has(l.match(ID_IN)?.[1]));
        if (fresh.length) await appendFile(dayfile, fresh.join('\n') + '\n', { mode: 0o600 });
        files.push(dayfile); added += d.records.length;
      }
      if (files.length) {
        const sub = { '{host}': this.host };
        const argv = sink.argv.flatMap((a) => (a === '{dayfiles}' ? files : [a.replace(/\{host\}/g, () => sub['{host}'])]));
        await run(argv[0], argv.slice(1), { timeoutMs: Math.max(COMMAND_MS, files.length * 15_000), env: this.env });
        runs = 1;
      }
      for (const d of days) st.offsets[d.day] = d.end;
      await this.saveState(sink.name, st);
      return { added, runs };
    }
    for (const d of days) {
      if (!d.records.length) { st.offsets[d.day] = d.end; continue; }
      await mkdir(mirror, { recursive: true, mode: 0o700 });
      const dayfile = path.join(mirror, `${d.day}.jsonl`);
      const have = await idsIn(dayfile);
      const fresh = d.records.filter((l) => !have.has(l.match(ID_IN)?.[1]));
      if (fresh.length) await appendFile(dayfile, fresh.join('\n') + '\n', { mode: 0o600 });
      const batch = path.join(base, `new-${d.day}.jsonl`);
      await writeFile(batch, d.records.join('\n') + '\n', { mode: 0o600 });
      await chmod(batch, 0o600).catch(() => {});
      const sub = { '{file}': batch, '{dayfile}': dayfile, '{day}': d.day, '{host}': this.host };
      const argv = sink.argv.map((a) => a.replace(/\{(file|dayfile|day|host)\}/g, (m) => sub[m]));
      try { await run(argv[0], argv.slice(1), { timeoutMs: COMMAND_MS, env: this.env }); }
      finally { await rm(batch, { force: true }).catch(() => {}); }
      runs++; added += d.records.length;
      // Each day moves on its own success: a failure later retries only the days not delivered.
      st.offsets[d.day] = d.end;
      await this.saveState(sink.name, st);
    }
    return { added, runs };
  }
}
