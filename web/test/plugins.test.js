// Plugins (core/plugins.js, core/api.js applyPlugin, core/ops-meta.js addMeta, mcp/server.js allTools): the plugin
// directories a process loads (DROVER_PLUGINS, ~/ allowed), a broken plugin recorded and skipped, and a loaded
// plugin's ops joining the op table with their description, cache rule, invalidations and host timeout, listed as
// MCP tools, and recorded in the truth file when they write, like a core op; a plugin adds ops but never replaces
// a core one. Synthetic plugins in a temp dir; the truth file, state and cache are scratch files.
// Run: node --test test/plugins.test.js
import './isolate-cache.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

const tmp = await mkdtemp(path.join(tmpdir(), 'drover-plugins-'));
const ENV = {
  DROVER_DOTFILES: path.join(tmp, 'dotfiles'), DROVER_STATE: path.join(tmp, 'state'),
  DROVER_EVENTS: path.join(tmp, 'dotfiles', 'claude', 'drover-events.jsonl'),
};
Object.assign(process.env, ENV);
await mkdir(path.join(tmp, 'dotfiles', 'claude'), { recursive: true });
const plugins = await import('../core/plugins.js');
const api = await import('../core/api.js');
const { META, isMutating } = await import('../core/ops-meta.js');
const { OWNER } = await import('../core/owner.js');
const mcp = await import('../mcp/server.js');
after(async () => { plugins._reset(); await rm(tmp, { recursive: true, force: true }); });

const opEvents = async () => (await readFile(ENV.DROVER_EVENTS, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'op');

describe('which plugins a process loads', () => {
  test('DROVER_PLUGINS lists directories separated by ":" (a leading ~/ is the home); an empty list loads none', () => {
    assert.deepEqual(plugins.pluginDirs({ DROVER_PLUGINS: '~/p/one: /opt/two :' }), [path.join(homedir(), 'p', 'one'), '/opt/two']);
    assert.deepEqual(plugins.pluginDirs({ DROVER_PLUGINS: '' }), []);
    assert.deepEqual(plugins.pluginDirs({ APXW_PLUGINS: '/legacy' }), ['/legacy'], 'the old prefix still works until the shim goes');
  });

  test('each directory\'s plugin.js is loaded once; a missing or broken one is recorded and skipped, the rest load', async () => {
    plugins._reset();
    const good = path.join(tmp, 'good'), none = path.join(tmp, 'none'), broken = path.join(tmp, 'broken');
    for (const d of [good, none, broken]) await mkdir(d, { recursive: true });
    await writeFile(path.join(good, 'plugin.js'), "export default { ops: { 'good.ping': async () => ({ pong: true }) } };\n");
    await writeFile(path.join(broken, 'plugin.js'), 'export default {\n');
    try {
      const list = await plugins.load({ dirs: [good, none, broken] });
      assert.deepEqual(list.map((p) => p.name), ['good'], 'named after its directory when it names none');
      assert.equal(await plugins.load({ dirs: [good] }), list, 'a second load in the same process is the first one');
      const errs = plugins.errors();
      assert.equal(errs.length, 2);
      assert.match(errs.find((e) => e.dir === none).error, /no plugin\.js/);
      assert.ok(errs.find((e) => e.dir === broken), 'the syntax error is recorded');
      assert.deepEqual(plugins.summary(), { plugins: [{ name: 'good', ops: ['good.ping'], views: [] }], errors: 2 }, 'names and ops only, no paths');
      assert.throws(() => plugins.register({ name: 'Not Valid' }), /must be lowercase letters, digits and dashes/);
      assert.throws(() => plugins.register({ name: 'good' }), /loaded twice/);
    } finally { plugins._reset(); }
  });
});

describe('a loaded plugin\'s ops', () => {
  let reads = 0;
  const hijack = async () => 'not the core op';
  // Registered when this block runs, not when the file is read: the block above resets the plugin list.
  before(() => {
    const p = plugins.register({
      name: 'fake-ops',
      ops: {
        'fake.read': async (a) => { reads++; return { read: a.what ?? null }; },
        'fake.write': async () => ({ ok: true, id: 'w-1' }),
        'tmux.capture': hijack,
      },
      meta: {
        'fake.read': { m: false, d: 'Read a fake record for the plugin test, by name.', s: { type: 'object', properties: { what: { type: 'string', description: 'which record' } }, required: [] } },
        'fake.write': { m: true, d: 'Write a fake record for the plugin test.' },
        'tmux.capture': { m: true, d: 'A plugin cannot redescribe a core op either.' },
      },
      // Rules for a core write and for the refused op: neither may change how core caches, routes or times them.
      cachePolicy: { 'fake.read': 60_000, 'sessions.message': 60_000, 'tmux.capture': 1 },
      invalidates: { 'fake.write': ['fake.'], 'events.append': ['fake.'], 'tmux.capture': ['fake.'] },
      hostTimeoutMs: { 'fake.write': 123_000, 'tmux.send': 1 },
      frontOnly: ['tmux.send'],
    });
    api.applyPlugin(p);
    api.applyPlugin(p);   // applying the same plugin again changes nothing
  });

  test('join the op table with their description, mutability, cache rule and host timeout', () => {
    assert.equal(api.OPS.filter((o) => o === 'fake.read').length, 1);
    assert.ok(api.OPS.includes('fake.write'));
    assert.match(META['fake.read'].d, /fake record/);
    assert.ok(META['fake.write'].s.properties.host, 'every op takes host');
    assert.equal(isMutating('fake.read'), false); assert.equal(isMutating('fake.write'), true);
    assert.equal(api.CACHE_POLICY['fake.read'], 60_000);
    assert.equal(api.hostTimeoutMs('fake.write'), 123_000);
    assert.equal(api.hostTimeoutMs('fake.read'), 60_000, 'the default for an op that names none');
  });

  test('never replace a core op or its description', () => {
    assert.notEqual(api.local['tmux.capture'], hijack);
    assert.equal(isMutating('tmux.capture'), false);
    assert.ok(plugins.errors().some((e) => /plugin fake-ops: op tmux\.capture is already defined/.test(e.error)));
  });

  test('never change how a core op is cached, routed or timed; may only add what a core op invalidates', () => {
    assert.equal(api.CACHE_POLICY['sessions.message'], undefined, 'a core write stays uncached, so it is still recorded');
    assert.notEqual(api.CACHE_POLICY['tmux.capture'], 1);
    assert.notEqual(api.hostTimeoutMs('tmux.send'), 1);
    assert.equal(api.isWrite('tmux.capture'), false, 'a core read stays a read');
    for (const [field, op] of [['cachePolicy', 'sessions.message'], ['cachePolicy', 'tmux.capture'], ['hostTimeoutMs', 'tmux.send'], ['frontOnly', 'tmux.send'], ['invalidates', 'tmux.capture']]) {
      assert.ok(plugins.errors().some((e) => e.error === `plugin fake-ops: ${field} for ${op}, which is not its op`), `${field} ${op}`);
    }
    assert.ok(!plugins.errors().some((e) => /invalidates for events\.append/.test(e.error)), 'a core write may drop the plugin\'s cached reads');
  });

  test('are MCP tools; a write through one is stamped with the server\'s actor, a read is not', async () => {
    const tools = mcp.allTools();
    const tool = (name) => tools.find((t) => t.name === name);
    assert.ok(tool('drover_fake_read') && tool('drover_fake_write'));
    assert.match(tool('drover_fake_read').description, /fake record/);
    const seen = [];
    const fake = async (op, args) => { seen.push({ op, args }); return {}; };
    await tool('drover_fake_write').run(fake, {});
    await tool('drover_fake_read').run(fake, { what: 'x' });
    assert.deepEqual(seen, [{ op: 'fake.write', args: { actor: 'mcp' } }, { op: 'fake.read', args: { what: 'x' } }]);
  });

  test('a read is cached by its rule; a write is recorded in the truth file and drops what it invalidates', async () => {
    reads = 0;
    assert.deepEqual((await api.dispatchCached('fake.read', { what: 'a' })).result, { read: 'a' });
    assert.deepEqual((await api.dispatchCached('fake.read', { what: 'a' })).result, { read: 'a' });
    assert.equal(reads, 1, 'the second read came from the cache');
    assert.ok(!(await opEvents()).some((e) => e.op === 'fake.read'), 'a read is not logged');
    assert.deepEqual((await api.dispatchCached('fake.write', {})).result, { ok: true, id: 'w-1' });
    const rec = (await opEvents()).filter((e) => e.op === 'fake.write').at(-1);
    assert.ok(rec, 'the write is in the truth file');
    assert.equal(rec.actor, OWNER); assert.equal(rec.ok, true); assert.equal(rec.result.id, 'w-1');
    await api.dispatchCached('fake.read', { what: 'a' });
    assert.equal(reads, 2, 'the write dropped the cached read');
    await api.dispatchCached('events.append', { event: { type: 'note', about: 'plugin-test', text: 'a core write' } });
    await api.dispatchCached('fake.read', { what: 'a' });
    assert.equal(reads, 3, 'a core write the plugin names drops its cached read too');
  });
});
