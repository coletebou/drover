// Settings files (~/.config/drover/*.env) and the secrets file: what loads, in which order, and what wins; then the
// CLI end to end: a settings file names a plugin, `drover op` runs its op, and a plugin that fails to load is named on
// stderr while the command goes on.
import './isolate-cache.js';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { loadSettings, loadSecrets, configFiles } from '../core/env.js';

const run = promisify(execFile);
const BIN = fileURLToPath(new URL('../bin/drover', import.meta.url));
const DIR = await mkdtemp(path.join(tmpdir(), 'drover-env-'));
after(() => rm(DIR, { recursive: true, force: true }));

const names = ['DROVER_T_A', 'DROVER_T_B', 'DROVER_T_C', 'DROVER_T_Q', 'DROVER_T_JSON', 'DROVER_T_SECRET', 'DROVER_T_SET'];
const clear = () => { for (const n of names) delete process.env[n]; };

describe('settings files, then secrets', () => {
  test('*.env in name order, the first value wins, quotes and comments, other files ignored', async () => {
    clear();
    const cfg = path.join(DIR, 'cfg1');
    await mkdir(cfg);
    await writeFile(path.join(cfg, '10-b.env'), 'DROVER_T_A=second\nDROVER_T_B=from-b\n');
    await writeFile(path.join(cfg, '00-a.env'), '# a comment\nDROVER_T_A=first   # trailing comment\nexport DROVER_T_Q="quoted value"\nDROVER_T_JSON=[{"kind":"app","match":"^web-"}]\n');
    await writeFile(path.join(cfg, 'notes.txt'), 'DROVER_T_C=never\n');
    process.env.DROVER_T_SET = 'from the environment';
    await writeFile(path.join(cfg, '20-c.env'), 'DROVER_T_SET=from a file\n');
    assert.deepEqual((await configFiles(cfg)).map((f) => path.basename(f)), ['00-a.env', '10-b.env', '20-c.env']);
    const { loaded } = await loadSettings({ configDir: cfg });
    assert.deepEqual(loaded.sort(), ['DROVER_T_A', 'DROVER_T_B', 'DROVER_T_JSON', 'DROVER_T_Q']);
    assert.equal(process.env.DROVER_T_A, 'first');
    assert.equal(process.env.DROVER_T_B, 'from-b');
    assert.equal(process.env.DROVER_T_Q, 'quoted value');
    assert.deepEqual(JSON.parse(process.env.DROVER_T_JSON), [{ kind: 'app', match: '^web-' }]);
    assert.equal(process.env.DROVER_T_C, undefined, 'only *.env files');
    assert.equal(process.env.DROVER_T_SET, 'from the environment', 'the environment wins');
    clear();
  });

  test('a missing settings directory loads nothing; settings load before the secrets file', async () => {
    clear();
    assert.deepEqual(await loadSettings({ configDir: path.join(DIR, 'nowhere') }), { loaded: [] });
    const cfg = path.join(DIR, 'cfg2');
    await mkdir(cfg);
    await writeFile(path.join(cfg, 'x.env'), 'DROVER_T_A=setting\n');
    const secrets = path.join(DIR, 'secrets');
    await writeFile(secrets, 'DROVER_T_A=secret-file\nDROVER_T_SECRET=s3cret\n');
    const r = await loadSecrets({ file: secrets, configDir: cfg });
    assert.deepEqual(r.loaded, ['DROVER_T_A', 'DROVER_T_SECRET']);
    assert.equal(process.env.DROVER_T_A, 'setting', 'a setting is not replaced by the secrets file');
    assert.equal(process.env.DROVER_T_SECRET, 's3cret');
    clear();
  });
  test('a settings file may name the secrets file: it is read after the settings', async () => {
    clear();
    const cfg = path.join(DIR, 'cfg4');
    await mkdir(cfg);
    const secrets = path.join(DIR, 'other-secrets');
    await writeFile(secrets, 'DROVER_T_SECRET=from-the-named-file\n');
    await writeFile(path.join(cfg, '00.env'), `DROVER_SECRETS_FILE=${secrets}\n`);
    const before = process.env.DROVER_SECRETS_FILE;
    delete process.env.DROVER_SECRETS_FILE;
    try {
      const r = await loadSecrets({ configDir: cfg });
      assert.equal(r.file, secrets);
      assert.equal(process.env.DROVER_T_SECRET, 'from-the-named-file');
    } finally { if (before === undefined) delete process.env.DROVER_SECRETS_FILE; else process.env.DROVER_SECRETS_FILE = before; clear(); }
  });
});

describe('drover op with a plugin a settings file names', () => {
  test('the op runs; a plugin that fails to load is named on stderr and skipped', async () => {
    const plugin = path.join(DIR, 'plugins', 'hello');
    await mkdir(plugin, { recursive: true });
    await writeFile(path.join(plugin, 'plugin.js'), `export default {
  name: 'hello',
  ops: { 'hello.say': async ({ to = 'world' }) => ({ text: \`hello, \${to}\` }) },
  meta: { 'hello.say': { m: false, d: 'Say hello.', s: { type: 'object', properties: { to: { type: 'string' } }, additionalProperties: false } } },
};\n`);
    const broken = path.join(DIR, 'plugins', 'broken');
    await mkdir(broken, { recursive: true });
    await writeFile(path.join(broken, 'plugin.js'), 'export default { name: "Not A Valid Name" };\n');
    const cfg = path.join(DIR, 'cfg3');
    await mkdir(cfg);
    await writeFile(path.join(cfg, '00-plugins.env'), `DROVER_PLUGINS=${plugin}:${broken}\n`);
    const env = { ...process.env, DROVER_CONFIG_DIR: cfg, DROVER_SECRETS_FILE: path.join(DIR, 'no-secrets') };
    delete env.DROVER_PLUGINS; delete env.APXW_PLUGINS;
    const { stdout, stderr } = await run(process.execPath, [BIN, 'op', 'hello.say', '{"to":"you"}'], { env, timeout: 60_000 });
    assert.deepEqual(JSON.parse(stdout), { text: 'hello, you' });
    assert.match(stderr, new RegExp(`drover: plugin ${broken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} not loaded: plugin name "Not A Valid Name" must be lowercase`));
  });
});
