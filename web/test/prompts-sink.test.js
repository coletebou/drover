// The prompt sinks (core/prompt-sinks.js): the config checked entry by entry, a git sink's own clone on a dedicated
// branch made as an orphan, two hosts sharing one bare remote in a temp dir (each writes only its own day files, so
// pulls never conflict, and nothing is ever force-pushed), records appended only once per file, labels routing records
// to sinks, the clone read back for a host that is down, and a command sink run as an argv with {file} replaced (a
// failure backs off and retries the same records). No network: the remote is a local bare repository; git runs with no
// global or system config, so the user's hooks, signing and identity never apply.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmp = await mkdtemp(path.join(tmpdir(), 'drover-prompt-sinks-'));
Object.assign(process.env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', DROVER_STATE: path.join(tmp, 'state-box-a'), DROVER_PROMPTS_CONFIG: path.join(tmp, 'prompts.json') });
const S = await import('../core/prompt-sinks.js');
const P = await import('../core/prompts.js');
after(async () => { await rm(tmp, { recursive: true, force: true }); });

const J = (o) => JSON.stringify(o);
const git = (cwd, ...args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: process.env }); assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const rec = (host, n, label = 'personal', day = '2026-11-21') => ({ v: 1, id: `p_${host === 'box-a' ? 'a' : 'b'}${String(n).padStart(15, '0')}`, ts: `${day}T10:00:0${n % 10}.000Z`, host, engine: 'claude', session: 's', cwd: '~/x', project: 'x', label, via: 'typed', text: `${host} says ${n}` });

/** One "host": its own state dir and spool, appending records the way the collector does. */
function host(name) {
  const state = path.join(tmp, `state-${name}`), spool = path.join(state, 'prompts');
  const sinks = new S.Sinks({ env: { ...process.env, DROVER_STATE: state }, stateDir: state, spoolDir: spool, host: name });
  const add = async (...recs) => { await mkdir(spool, { recursive: true }); for (const r of recs) await appendFile(path.join(spool, `${r.ts.slice(0, 10)}.jsonl`), J(r) + '\n'); };
  return { name, state, spool, sinks, add };
}

describe('config', () => {
  test('absent: the local spool only; a bad entry is named and left out, the rest kept', async () => {
    const none = await S.loadConfig({ ...process.env, DROVER_PROMPTS_CONFIG: path.join(tmp, 'missing.json') });
    assert.deepEqual([none.found, none.sinks, none.errors, none.syncEveryMinutes], [false, [], [], 30]);
    await writeFile(path.join(tmp, 'bad.json'), J({ rules: [{ cwd: '~/w', label: 'work' }], syncEveryMinutes: 5, sinks: [
      { name: 'ok', type: 'git', remote: 'git@forge.example:me/dotfiles.git' },
      { name: 'ok', type: 'git', remote: 'x' }, { name: '../evil', type: 'git', remote: 'x' }, { name: 'opt', type: 'git', remote: '--upload-pack=touch /tmp/x' },
      { name: 'ext', type: 'git', remote: 'ext::sh -c x' }, { name: 'br', type: 'git', remote: 'x', branch: '../main' }, { name: 'dir', type: 'git', remote: 'x', dir: '../up' },
      { name: 'cmd', type: 'command', argv: ['sync-tool', 'push', '{file}'], labels: ['work'] }, { name: 'nocmd', type: 'command', argv: 'sh -c x' }, { name: 'what', type: 'ftp' },
    ] }));
    const c = await S.loadConfig({ ...process.env, DROVER_PROMPTS_CONFIG: path.join(tmp, 'bad.json') });
    assert.deepEqual(c.sinks, [
      { name: 'ok', type: 'git', labels: ['*'], remote: 'git@forge.example:me/dotfiles.git', branch: 'drover-prompts', dir: 'prompts', sign: false },
      { name: 'cmd', type: 'command', labels: ['work'], argv: ['sync-tool', 'push', '{file}'] }]);
    assert.equal(c.errors.length, 8, c.errors.join('\n'));
    assert.equal(c.syncEveryMinutes, 5); assert.deepEqual(c.rules, [{ cwd: '~/w', label: 'work' }]);
  });
});

describe('a git sink shared by two hosts', () => {
  const remote = path.join(tmp, 'remote.git');
  const sink = { name: 'personal', type: 'git', labels: ['personal', 'default'], remote, branch: 'drover-prompts', dir: 'prompts', sign: false };
  const a = host('box-a'), b = host('box-b');
  const remoteFile = (h, day = '2026-11-21') => spawnSync('git', ['show', `drover-prompts:prompts/${h}/${day}.jsonl`], { cwd: remote, encoding: 'utf8', env: process.env });
  before(() => {
    spawnSync('git', ['init', '-q', '--bare', remote], { env: process.env });
    // The remote already has another branch: the prompts branch is made beside it as an orphan, sharing no history.
    const seed = path.join(tmp, 'seed');
    spawnSync('git', ['init', '-q', seed], { env: process.env });
    git(seed, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'dotfiles');
    git(seed, 'push', '-q', remote, 'HEAD:refs/heads/master');
  });

  test('the first sync makes the branch as an orphan, writes <dir>/<host>/<day>.jsonl and pushes; only the sink\'s labels', async () => {
    await a.add(rec('box-a', 1), rec('box-a', 2, 'work'), rec('box-a', 3, 'default'), rec('box-a', 4, 'personal', '2026-11-20'));
    const [r] = await a.sinks.syncAll({ sinks: [sink], file: 'x' });
    assert.equal(r.ok, true, r.error); assert.deepEqual([r.added, r.pushed], [3, true]);
    assert.equal(git(remote, 'log', '--format=%s', 'drover-prompts'), 'prompts: box-a +3');
    assert.equal(spawnSync('git', ['merge-base', 'master', 'drover-prompts'], { cwd: remote, env: process.env }).status, 1, 'no common history with the other branch');
    assert.deepEqual(remoteFile('box-a').stdout.trim().split('\n').map((l) => JSON.parse(l).id), ['p_a000000000000001', 'p_a000000000000003']);
    assert.equal(git(remote, 'ls-tree', '-r', '--name-only', 'drover-prompts'), 'prompts/box-a/2026-11-20.jsonl\nprompts/box-a/2026-11-21.jsonl');
    const st = await a.sinks.loadState('personal');
    assert.deepEqual([st.failures, st.lastError, st.unpushed], [0, null, 0]);
  });

  test('a second host clones what is there, adds its own files, and both keep pulling and pushing with no conflict', async () => {
    await b.add(rec('box-b', 1), rec('box-b', 2));
    const [rb] = await b.sinks.syncAll({ sinks: [sink] });
    assert.equal(rb.ok, true, rb.error); assert.equal(rb.added, 2);
    // a writes again after b pushed: its pull rebases onto b's commit, then pushes (never a force push).
    await a.add(rec('box-a', 5));
    const [ra] = await a.sinks.syncAll({ sinks: [sink] });
    assert.equal(ra.ok, true, ra.error); assert.equal(ra.added, 1);
    assert.deepEqual(git(remote, 'log', '--format=%s', 'drover-prompts').split('\n'), ['prompts: box-a +1', 'prompts: box-b +2', 'prompts: box-a +3']);
    assert.equal(git(remote, 'rev-list', '--merges', '--count', 'drover-prompts'), '0', 'linear: rebased, not merged');
    // b, behind again, appends to the same day file it already has and catches up.
    await b.add(rec('box-b', 3));
    const [rb2] = await b.sinks.syncAll({ sinks: [sink] });
    assert.equal(rb2.ok, true, rb2.error);
    assert.equal(remoteFile('box-b').stdout.trim().split('\n').length, 3);
    assert.equal(remoteFile('box-a').stdout.trim().split('\n').length, 3);
  });

  test('records already in a day file are never written twice (a lost state file reads the spool again)', async () => {
    await rm(a.sinks.statePath('personal'));
    const [r] = await a.sinks.syncAll({ sinks: [sink] });
    assert.equal(r.ok, true, r.error); assert.equal(r.added, 0);
    assert.equal(git(remote, 'log', '-1', '--format=%s', 'drover-prompts'), 'prompts: box-b +1', 'nothing new, no commit');
    const [again] = await a.sinks.syncAll({ sinks: [sink] });
    assert.equal(again.added, 0);
  });

  test('the clone is a read source: prompts.list\'s fallback reads the other host\'s files from it', async () => {
    await writeFile(process.env.DROVER_PROMPTS_CONFIG, J({ sinks: [sink] }));
    const got = await P.listClones({}, { exclude: new Set(['box-a']) });
    assert.deepEqual(got.map((h) => [h.host, h.sinks, h.prompts.map((p) => p.id)]), [['box-b', ['personal'], ['p_b000000000000003', 'p_b000000000000002', 'p_b000000000000001']]]);
    assert.equal(await P.findTs('p_b000000000000002'), '2026-11-21T10:00:02.000Z');
  });

  test('a remote that cannot be reached: the error is kept, the next try backs off, records stay pending; a forced sync retries', async () => {
    const gone = { ...sink, name: 'gone', remote: path.join(tmp, 'no-such-remote.git') };
    const [r] = await a.sinks.syncAll({ sinks: [gone] });
    assert.equal(r.ok, false); assert.ok(r.nextAttempt);
    const [skip] = await a.sinks.syncAll({ sinks: [gone] }, { force: false });
    assert.equal(skip.skipped, true);
    const [st] = await a.sinks.status({ sinks: [gone] });
    assert.ok(st.lastError); assert.equal(st.failures, 1); assert.equal(st.pending, 4, 'the personal and default records, not delivered');
    assert.deepEqual(await a.sinks.syncDue({ sinks: [gone], syncEveryMinutes: 30 }), [], 'not due: tried just now');
    const [forced] = await a.sinks.syncAll({ sinks: [gone] }, { force: true });
    assert.equal(forced.skipped, undefined); assert.equal(forced.ok, false);
    assert.equal((await a.sinks.loadState('gone')).failures, 2);
  });
});

describe('a command sink', () => {
  const c = host('box-c');
  const out = path.join(tmp, 'command-out.jsonl');
  // The "sync tool": records its argv and the file it was given; fails while a marker file exists.
  const tool = path.join(tmp, 'tool.mjs'), fail = path.join(tmp, 'fail-now');
  before(() => writeFile(tool, `import { appendFileSync, readFileSync, existsSync } from 'node:fs';\nif (existsSync(${J(fail)})) process.exit(3);\nconst [file, day, h, dayfile] = process.argv.slice(2);\nappendFileSync(${J(out)}, JSON.stringify({ day, h, ids: readFileSync(file, 'utf8').trim().split('\\n').map((l) => JSON.parse(l).id), whole: readFileSync(dayfile, 'utf8').trim().split('\\n').length }) + '\\n');\n`));
  const sink = { name: 'sealed', type: 'command', labels: ['*'], argv: [process.execPath, tool, '{file}', '{day}', '{host}', '{dayfile}'] };
  const runs = async () => (await readFile(out, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

  test('its argv runs once per day with new records, {file} holding only those; no shell', async () => {
    await c.add(rec('box-a', 1, 'work'), rec('box-a', 2), rec('box-a', 3, 'x', '2026-11-22'));
    const [r] = await c.sinks.syncAll({ sinks: [sink] });
    assert.equal(r.ok, true, r.error); assert.deepEqual([r.added, r.runs], [3, 2]);
    assert.deepEqual(await runs(), [{ day: '2026-11-21', h: 'box-c', ids: ['p_a000000000000001', 'p_a000000000000002'], whole: 2 }, { day: '2026-11-22', h: 'box-c', ids: ['p_a000000000000003'], whole: 1 }]);
    await c.add(rec('box-a', 4));
    await c.sinks.syncAll({ sinks: [sink] });
    assert.deepEqual((await runs()).at(-1), { day: '2026-11-21', h: 'box-c', ids: ['p_a000000000000004'], whole: 3 }, 'only the new record; the day copy grows');
  });

  test('{dayfiles}: one run for every changed day, each day file whole', async () => {
    const d = host('box-d');
    const seen = path.join(tmp, 'dayfiles-out.jsonl'), t2 = path.join(tmp, 'tool2.mjs');
    await writeFile(t2, `import { appendFileSync, readFileSync } from 'node:fs';\nconst [h, ...files] = process.argv.slice(2);\nappendFileSync(${J(seen)}, JSON.stringify({ h, days: files.map((f) => f.split('/').pop()), lines: files.map((f) => readFileSync(f, 'utf8').trim().split('\\n').length) }) + '\\n');\n`);
    const many = { name: 'batch', type: 'command', labels: ['*'], argv: [process.execPath, t2, '{host}', '{dayfiles}'] };
    await d.add(rec('box-a', 11), rec('box-a', 12), rec('box-a', 13, 'x', '2026-11-22'), rec('box-a', 14, 'x', '2026-11-23'));
    const [r] = await d.sinks.syncAll({ sinks: [many] });
    assert.equal(r.ok, true, r.error); assert.deepEqual([r.added, r.runs], [4, 1]);
    const got = (await readFile(seen, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(got, [{ h: 'box-d', days: ['2026-11-21.jsonl', '2026-11-22.jsonl', '2026-11-23.jsonl'], lines: [2, 1, 1] }]);
    const [again] = await d.sinks.syncAll({ sinks: [many] }, { force: true });
    assert.equal(again.runs, 0, 'nothing new: no run');
  });

  test('a failing command keeps its records for the next try', async () => {
    await c.add(rec('box-a', 5));
    await writeFile(fail, '');
    const [r] = await c.sinks.syncAll({ sinks: [sink] });
    assert.equal(r.ok, false); assert.match(r.error, /exited 3/);
    await rm(fail);
    const [ok] = await c.sinks.syncAll({ sinks: [sink] }, { force: true });
    assert.equal(ok.ok, true, ok.error);
    assert.deepEqual((await runs()).at(-1).ids, ['p_a000000000000005']);
  });
});
