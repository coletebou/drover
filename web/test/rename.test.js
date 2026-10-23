// The apx-web -> drover rename: env var fallback, state/cache dir move, the
// legacy truth file carry-over, and the apxw shim. Everything runs in temp dirs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readlink, lstat, appendFile, stat, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { envvar } from '../core/envvars.js';
import { stateDir, cacheDir, migrateLegacyDirs } from '../core/paths.js';
import { syncLegacyEvents, readAll } from '../core/events.js';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'drover');
const line = (id, extra = {}) => JSON.stringify({ id, ts: `2026-10-1${id.length % 10}T00:00:00.000Z`, host: 'h', actor: 'apxw', type: 'note', about: 'x', text: id, ...extra });

test('envvar prefers DROVER_<name> and falls back to APXW_<name>', () => {
  assert.equal(envvar('PORT', { DROVER_PORT: '1', APXW_PORT: '2' }), '1');
  assert.equal(envvar('PORT', { APXW_PORT: '2' }), '2');
  assert.equal(envvar('PORT', {}), undefined);
});

test('stateDir and cacheDir default to the drover names and honor both override spellings', () => {
  assert.equal(stateDir({ HOME: '/h' }), '/h/.local/state/drover');
  assert.equal(cacheDir({ HOME: '/h' }), '/h/.cache/drover');
  assert.equal(stateDir({ HOME: '/h', APXW_STATE: '/old' }), '/old');
  assert.equal(cacheDir({ HOME: '/h', DROVER_CACHE: '/new', APXW_CACHE: '/old' }), '/new');
});

test('migrateLegacyDirs moves real apx-web dirs, leaves symlinks, then is a no-op', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'drover-home-'));
  await mkdir(path.join(home, '.local', 'state', 'apx-web'), { recursive: true });
  await writeFile(path.join(home, '.local', 'state', 'apx-web', 'token'), 'secret-ish\n');
  await mkdir(path.join(home, '.cache', 'apx-web', 'uploads'), { recursive: true });
  await writeFile(path.join(home, '.cache', 'apx-web', 'uploads', 'a.txt'), 'a');
  // a host that ran the pre-rename embed setup: the built llama-server and model must not need a rebuild
  await mkdir(path.join(home, '.local', 'share', 'apx-web', 'embed', 'bin'), { recursive: true });
  await writeFile(path.join(home, '.local', 'share', 'apx-web', 'embed', 'bin', 'llama-server'), 'bin');
  const moved = migrateLegacyDirs({ HOME: home });
  assert.equal(moved.length, 3);
  assert.equal(await readFile(path.join(home, '.local', 'state', 'drover', 'token'), 'utf8'), 'secret-ish\n');
  assert.equal(await readFile(path.join(home, '.cache', 'drover', 'uploads', 'a.txt'), 'utf8'), 'a');
  assert.equal(await readFile(path.join(home, '.local', 'share', 'drover', 'embed', 'bin', 'llama-server'), 'utf8'), 'bin');
  assert.equal(await readlink(path.join(home, '.local', 'share', 'apx-web')), path.join(home, '.local', 'share', 'drover'));
  assert.ok((await lstat(path.join(home, '.local', 'state', 'apx-web'))).isSymbolicLink());
  assert.equal(await readlink(path.join(home, '.cache', 'apx-web')), path.join(home, '.cache', 'drover'));
  // old code writing through the old path lands in the new dir
  assert.equal(await readFile(path.join(home, '.local', 'state', 'apx-web', 'token'), 'utf8'), 'secret-ish\n');
  assert.deepEqual(migrateLegacyDirs({ HOME: home }), [], 'second run: old path is a symlink now');
});

test('migrateLegacyDirs leaves both dirs alone when the new one exists or an override is set', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'drover-home-'));
  await mkdir(path.join(home, '.local', 'state', 'apx-web'), { recursive: true });
  await mkdir(path.join(home, '.local', 'state', 'drover'), { recursive: true });
  await mkdir(path.join(home, '.cache', 'apx-web'), { recursive: true });
  assert.deepEqual(migrateLegacyDirs({ HOME: home, APXW_CACHE: '/elsewhere' }), []);
  assert.ok((await lstat(path.join(home, '.local', 'state', 'apx-web'))).isDirectory(), 'never merged into an existing new dir');
  assert.ok((await lstat(path.join(home, '.cache', 'apx-web'))).isDirectory(), 'override skips the pair');
  assert.equal(existsSync(path.join(home, '.cache', 'drover')), false);
});

async function eventsFixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'drover-ev-'));
  return { file: path.join(dir, 'drover-events.jsonl'), legacy: path.join(dir, 'apx-events.jsonl'), markFile: path.join(dir, 'state', 'legacy-events.json') };
}

test('legacy truth file: first run copies it byte for byte', async () => {
  const f = await eventsFixture();
  const body = line('a1') + '\n' + line('a2') + '\n' + '{"id":"torn","ty';
  await writeFile(f.legacy, body);
  const r = await syncLegacyEvents(f);
  assert.equal(r.copied, true);
  assert.equal(await readFile(f.file, 'utf8'), body);
  assert.equal(await readFile(f.legacy, 'utf8'), body, 'legacy untouched');
});

test('legacy truth file: laggard appends are imported once, deduped by id, verbatim', async () => {
  const f = await eventsFixture();
  await writeFile(f.legacy, line('a1') + '\n');
  await syncLegacyEvents(f);
  await appendFile(f.file, line('n1', { actor: 'drover' }) + '\n'); // this box, new code
  const laggard = line('a2', { text: 'from a box still on apxw' });
  const legacyBody = line('a1') + '\n' + laggard + '\n' + line('a1') + '\n' + '\n';
  await writeFile(f.legacy, legacyBody); // a1 again (union merge) plus one new line
  const legacyStat = await stat(f.legacy);
  const r = await syncLegacyEvents(f);
  assert.deepEqual(r, { imported: 1 });
  const lines = (await readFile(f.file, 'utf8')).trim().split('\n');
  assert.deepEqual(lines, [line('a1'), line('n1', { actor: 'drover' }), laggard]);
  assert.equal(await readFile(f.legacy, 'utf8'), legacyBody, 'legacy untouched');
  assert.equal((await stat(f.legacy)).mtimeMs, legacyStat.mtimeMs);
  assert.deepEqual((await readAll(f.file)).map((e) => e.id).sort(), ['a1', 'a2', 'n1']);
});

test('legacy truth file: no-op while the legacy file is unchanged, and a torn new file gets its newline', async () => {
  const f = await eventsFixture();
  await writeFile(f.legacy, line('a1') + '\n');
  await writeFile(f.file, line('n1') + '\n' + '{"id":"tor'); // new file exists, ends mid-line
  assert.deepEqual(await syncLegacyEvents(f), { imported: 1 });
  const after = await readFile(f.file, 'utf8');
  assert.ok(after.endsWith('{"id":"tor\n' + line('a1') + '\n'), 'imported line starts on its own line');
  assert.deepEqual(await syncLegacyEvents(f), { skipped: 'unchanged' });
  assert.equal(await readFile(f.file, 'utf8'), after);
  assert.ok(JSON.parse(await readFile(f.markFile, 'utf8')), 'the import is remembered in the state dir');
});

test('legacy truth file: nothing to do without one', async () => {
  const f = await eventsFixture();
  assert.deepEqual(await syncLegacyEvents(f), { skipped: 'no legacy file' });
  assert.equal(existsSync(f.file), false);
});

test('readAll drops a repeated id', async () => {
  const f = await eventsFixture();
  await writeFile(f.file, line('a1') + '\n' + line('a1') + '\n' + line('a2') + '\n');
  assert.deepEqual((await readAll(f.file)).map((e) => e.id), ['a1', 'a2']);
});

test('apxw shim: one deprecation line on stderr, stdout unchanged', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'drover-shim-'));
  const apxw = path.join(dir, 'apxw');
  await symlink(BIN, apxw);
  const env = { ...process.env, HOME: dir, DROVER_STATE: path.join(dir, 'state'), DROVER_CACHE: path.join(dir, 'cache') };
  const old = spawnSync(process.execPath, [apxw, 'help'], { env, encoding: 'utf8' });
  const neu = spawnSync(process.execPath, [BIN, 'help'], { env, encoding: 'utf8' });
  assert.equal(old.status, 0);
  assert.equal(old.stderr, 'apxw is deprecated and will be removed on 2026-11-15; use drover\n');
  assert.equal(old.stdout, neu.stdout);
  assert.equal(neu.stderr, '');
  assert.match(neu.stdout, /drover serve .*\(alias: up\)/);
});

test('migrateLegacyDirs is a no-op without HOME instead of throwing', () => {
  assert.deepEqual(migrateLegacyDirs({}), []);
});

test('every bin/ script the drover CLI spawns exists under its new name', async () => {
  const src = await readFile(BIN, 'utf8');
  const spawned = [...src.matchAll(/path\.join\(ROOT, 'bin', '([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(spawned.includes('drover-embed-setup'), 'embed setup is spawned by its renamed path');
  for (const name of spawned) assert.ok(existsSync(path.join(path.dirname(BIN), name)), `bin/${name} exists`);
});

test('the legacy feature log honours DROVER_FEATURE_LOG, then the pre-rename APX_FEATURE_LOG', () => {
  const events = new URL('../core/events.js', import.meta.url).href;
  const run = (env) => spawnSync(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(events)}).then((m) => process.stdout.write(m.LEGACY_FEATURE_LOG))`],
    { env: { PATH: process.env.PATH, HOME: '/h', ...env }, encoding: 'utf8' }).stdout;
  assert.equal(run({ APX_FEATURE_LOG: '/old.jsonl' }), '/old.jsonl');
  assert.equal(run({ DROVER_FEATURE_LOG: '/new.jsonl', APX_FEATURE_LOG: '/old.jsonl' }), '/new.jsonl');
});
