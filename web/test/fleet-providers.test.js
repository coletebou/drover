// A host provider's hosts (core/plugins.js hosts: the Code Spaces plugin) in the fleet views: they join fleet.summary and
// docker.fleet by default from the provider's cached state, without a probe and without making the rest wait; what the
// provider could not see comes back as coverage notes; and a launch on one is checked by the provider first.
// Synthetic provider; the cache, state, truth file and fleet list are scratch.
// Run: node --test test/fleet-providers.test.js
import './isolate-cache.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmp = await mkdtemp(path.join(tmpdir(), 'drover-fleet-providers-'));
Object.assign(process.env, {
  DROVER_DOTFILES: path.join(tmp, 'dotfiles'), DROVER_STATE: path.join(tmp, 'state'),
  DROVER_EVENTS: path.join(tmp, 'dotfiles', 'claude', 'drover-events.jsonl'),
});
await mkdir(path.join(tmp, 'dotfiles', 'claude'), { recursive: true });
const plugins = await import('../core/plugins.js');
const api = await import('../core/api.js');
after(async () => { plugins._reset(); await rm(tmp, { recursive: true, force: true }); });

const calls = { summary: [], preflight: [], stacks: [], targets: 0 };
let targets = { hosts: ['space:alpha', 'space:slow'], notes: [{ reason: 'Spaces list is 7 min old (refreshing in the background)' }], cacheAgeMs: 420_000 };
let preflightError = null;

describe('a host provider in the fleet views', () => {
  before(() => {
    plugins._reset();
    plugins.register({
      name: 'fake-spaces',
      hosts: {
        match: (n) => /^space:[a-z]+$/.test(n),
        known: async (n) => ['space:alpha', 'space:slow', 'space:stopped'].includes(n),
        unknownError: (n) => `${n} is not listed`,
        entries: async () => [],
        rpcArgv: async () => ({ argv: [process.execPath, '-e', "process.stderr.write('Drover not installed in this Space'); process.exit(97)"] }),
        exec: async () => ({ code: 0, stdout: '' }),
        dockerStacks: async (name) => { calls.stacks.push(name); return { stacks: [{ project: 'p', services: [{}], oneoff: [] }], totals: { stacks: 1 } }; },
        defaultTargets: async () => { calls.targets++; return targets; },
        summary: async (name) => {
          calls.summary.push(name);
          if (name === 'space:slow') return new Promise(() => {});   // never answers
          return { sessions: [], windows: [{ target: 'a:1' }], notify: null, note: 'read by one-shot commands' };
        },
        preflightLaunch: async (name, args) => { calls.preflight.push({ name, args }); if (preflightError) throw new Error(preflightError); },
      },
    });
  });

  test('providerTargets collects the hosts and notes, and a provider that fails or hangs is a note, not an error', async () => {
    const r = await api.providerTargets();
    assert.deepEqual(r.hosts, ['space:alpha', 'space:slow']);
    assert.deepEqual(r.notes.map((n) => n.reason), ['Spaces list is 7 min old (refreshing in the background)']);
    const keep = plugins.hostProviders()[0].defaultTargets;
    plugins.hostProviders()[0].defaultTargets = async () => { throw new Error('list exploded'); };
    assert.deepEqual((await api.providerTargets()).notes.map((n) => n.reason), ['host provider failed: list exploded']);
    plugins.hostProviders()[0].defaultTargets = () => new Promise(() => {});
    api._budgets.providerTargetsMs = 20;
    try { assert.match((await api.providerTargets()).notes[0].reason, /host provider failed: no answer within 0\.02 s/); }
    finally { api._budgets.providerTargetsMs = 4_000; plugins.hostProviders()[0].defaultTargets = keep; }
  });

  test('fleet.summary asks the provider\'s running hosts by default, skips their probe, and reports coverage', async () => {
    api._budgets.providerHostMs = 150;
    try {
      // space:slow never answers: this call returning at all is the proof the board does not wait for it.
      const r = await api.front['fleet.summary']({ fresh: true });
      const alpha = r.hosts.find((h) => h.host === 'space:alpha');
      assert.equal(alpha.ok, true); assert.equal(alpha.probe, 'skipped (provided host)'); assert.deepEqual(alpha.windows, [{ target: 'a:1' }]); assert.equal(alpha.note, 'read by one-shot commands');
      const slow = r.hosts.find((h) => h.host === 'space:slow');
      assert.equal(slow.ok, false); assert.match(slow.error, /no answer within 0\.15 s; still reading it in the background/);
      assert.ok(!r.hosts.some((h) => h.host === 'space:stopped'), 'only what the provider named');
      assert.ok(r.hosts.some((h) => h.host === 'local'), 'this machine is still there');
      assert.ok(r.coverage.searched.includes('space:alpha'));
      assert.ok(r.coverage.notCovered.some((n) => n.host === 'space:slow' && /no answer/.test(n.reason)));
      assert.deepEqual(r.coverage.partial, [{ host: null, reason: 'Spaces list is 7 min old (refreshing in the background)' }]);
    } finally { api._budgets.providerHostMs = 12_000; }
  });

  test('fleet.summary with hosts named asks only those: the provider contributes nothing and is not asked', async () => {
    calls.targets = 0;
    const r = await api.front['fleet.summary']({ hosts: ['space:alpha'], fresh: true });
    assert.deepEqual(r.hosts.map((h) => h.host), ['space:alpha']);
    assert.equal(calls.targets, 0);
    assert.deepEqual(r.coverage.partial, []);
    await assert.rejects(api.front['fleet.summary']({ hosts: ['space:nope'] }), /space:nope is not listed/);
  });

  test('docker.fleet includes the provider\'s hosts too (read through the provider when the Space runs no Drover) and carries its notes', async () => {
    const r = await api.front['docker.fleet']({ fresh: true });
    const alpha = r.hosts.find((h) => h.host === 'space:alpha');
    assert.equal(alpha?.ok, true, JSON.stringify(r.hosts.map((h) => [h.host, h.error])));
    assert.ok(calls.stacks.includes('space:alpha'));
    assert.ok(r.coverage.partial.some((p) => /Spaces list is 7 min old/.test(p.reason)));
  });

  test('search.fleet keeps to the fleet hosts: a Space has no search index to ask', async () => {
    calls.targets = 0;
    const r = await api.front['search.fleet']({ query: 'x', mode: 'keyword', remote: false }).catch((e) => ({ err: e.message }));
    assert.equal(calls.targets, 0, 'the provider was not asked');
    assert.ok(!(r.perHost ?? []).some((h) => String(h.host).startsWith('space:')));
  });

  test('launch.start on a provider host runs the provider\'s preflight first; its refusal stops the launch before anything is sent', async () => {
    calls.preflight.length = 0;
    preflightError = 'Space alpha cannot run a claude agent: missing tmux. Nothing was started.';
    await assert.rejects(api.dispatch('launch.start', { host: 'space:alpha', engine: 'claude', cwd: '/space/apex', prompt: 'x' }), /missing tmux\. Nothing was started\./);
    assert.deepEqual(calls.preflight.map((c) => [c.name, c.args.engine]), [['space:alpha', 'claude']]);
    preflightError = null;
    // a passing preflight lets the launch go on to the host: here the fake transport reports no Drover (exit 97)
    await assert.rejects(api.dispatch('launch.start', { host: 'space:alpha', engine: 'claude', cwd: '/space/apex', prompt: 'x' }), /exited 97/);
    assert.equal(calls.preflight.length, 2);
  });
});
