// The docker.* ops on the op table and every surface around it: described and generated as drover_docker_* MCP tools
// (the verbs with actor mcp), cached and invalidated, routed with a long enough host timeout, recorded in the truth file
// with their result, docker.fleet fanned out over the per-host cache (a fake ssh peer stands in for the other hosts, a
// host provider registered here for a host that runs no Drover), unknown docker verbs refused before any host is
// reached, and neither the widget token nor the Grok bots gateway able to reach any of them. A temp dotfiles, truth
// file, cache and state dir keep the real ones untouched.
import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import path from 'node:path';

const tmp = await mkdtemp(path.join(tmpdir(), 'drover-docker-ops-'));
process.env.DROVER_CACHE = path.join(tmp, 'cache');
process.env.DROVER_STATE = path.join(tmp, 'state');
process.env.DROVER_DOTFILES = path.join(tmp, 'dotfiles');
process.env.DROVER_EVENTS = path.join(tmp, 'dotfiles', 'claude', 'drover-events.jsonl');
await mkdir(path.join(tmp, 'dotfiles', 'claude'), { recursive: true });
await writeFile(path.join(tmp, 'dotfiles', 'claude', 'fleet-hosts.txt'), 'stackbox\noldbox\n');
await writeFile(process.env.DROVER_EVENTS, '');
const api = await import('../core/api.js');
const remote = await import('../core/remote.js');
const { UPDATE_HINT } = await import('../core/util.js');
const docker = await import('../core/docker.js');
const plugins = await import('../core/plugins.js');
const { readAll } = await import('../core/events.js');
const { META, OPS_KNOWN, isMutating } = await import('../core/ops-meta.js');
const { GENERATED_TOOLS } = await import('../mcp/server.js');
const { botTools } = await import('../core/bots/tools.js');
after(async () => { remote.stopAll(); await rm(tmp, { recursive: true, force: true }); });

const READS = ['docker.stacks', 'docker.fleet', 'docker.logs'];
const VERBS = ['docker.restart', 'docker.start', 'docker.exec', 'docker.run'];
const ALL = [...READS, ...VERBS];
const toolName = (op) => `drover_${op.replace(/\./g, '_')}`;

describe('the op table and MCP', () => {
  test('every docker op is on the table, described, takes host and is an MCP tool; reads do not mutate, verbs do and take actor', () => {
    for (const op of ALL) {
      assert.ok(api.OPS.includes(op), op); assert.ok(OPS_KNOWN.includes(op), op);
      assert.ok(META[op].d.length > 40, op);
      assert.ok(META[op].s.properties.host, `${op} takes host`);
      assert.ok(GENERATED_TOOLS.some((t) => t.name === toolName(op)), op);
      for (const [k, p] of Object.entries(META[op].s.properties)) assert.equal(typeof p.description, 'string', `${op}.${k}`);
    }
    for (const op of READS) assert.equal(isMutating(op), false, op);
    for (const op of VERBS) { assert.equal(isMutating(op), true, op); assert.ok(META[op].s.properties.actor, `${op} declares actor, so MCP calls are recorded as mcp`); }
    assert.deepEqual(META['docker.logs'].s.required, ['project', 'service']);
    assert.deepEqual(META['docker.restart'].s.required, ['project', 'services']);
    assert.deepEqual(META['docker.start'].s.required, ['project', 'services']);
    assert.deepEqual(META['docker.exec'].s.required, ['project', 'service', 'argv']);
    assert.deepEqual(META['docker.run'].s.required, ['project', 'service']);
    for (const op of VERBS) for (const k of ['user', 'privileged', 'env', 'entrypoint', 'volumes', 'workdir']) assert.equal(META[op].s.properties[k], undefined, `${op} offers no ${k}`);
  });
  test('the generated MCP tools of the verbs send actor mcp; reads send what they were given', async () => {
    const seen = [];
    const dispatch = async (op, args) => { seen.push({ op, args }); return {}; };
    await GENERATED_TOOLS.find((t) => t.name === 'drover_docker_exec').run(dispatch, { project: 'p', service: 's', argv: ['true'] });
    await GENERATED_TOOLS.find((t) => t.name === 'drover_docker_restart').run(dispatch, { project: 'p', services: ['s'] });
    await GENERATED_TOOLS.find((t) => t.name === 'drover_docker_stacks').run(dispatch, { host: 'stackbox' });
    assert.deepEqual(seen.map((s) => s.args.actor), ['mcp', 'mcp', undefined]);
  });
  test('cache and routing: stacks cached 30 s, logs and the verbs never, the fleet op front-only, verbs get 120 s on another host', () => {
    assert.equal(api.CACHE_POLICY['docker.stacks'], 30_000);
    for (const op of ['docker.logs', 'docker.fleet', ...VERBS]) assert.equal(api.CACHE_POLICY[op], undefined, op);
    for (const op of VERBS) assert.equal(api.hostTimeoutMs(op), 120_000, op);
    assert.equal(api.hostTimeoutMs('docker.stacks'), 60_000);
  });
  test('a docker verb the table does not have is refused before any host is resolved or reached', async () => {
    for (const op of ['docker.down', 'docker.rm', 'docker.kill', 'docker.build', 'docker.pull', 'docker.compose']) {
      await assert.rejects(api.dispatch(op, { host: 'no-such-host', project: 'webapp' }), (e) => new RegExp(`^unknown op ${op.replace('.', '\\.')}: docker ops are docker\\.stacks, .*; down, rm, rmi, prune, kill, stop, build, pull, scale and volume or network changes are never offered$`).test(e.message), op);
    }
    await assert.rejects(api.dispatchCached('docker.down', { project: 'webapp', actor: 'mcp' }), /never offered/);
  });
});

describe('a verb through the op table', () => {
  const real = { ...api.local };
  afterEach(() => { Object.assign(api.local, real); });
  const opEvents = async (op) => (await readAll(process.env.DROVER_EVENTS)).filter((e) => e.type === 'op' && e.op === op);

  test('the truth file records actor, args and the result with its exit code; docker caches are dropped', async () => {
    api.local['docker.restart'] = async (a) => ({ ok: true, host: 'testbox', project: a.project, verb: 'restart', services: a.services, count: 2, exitCode: 0, timedOut: false, output: 'drover-selftest-web-1', containers: [{ name: 'x', before: 'healthy', after: 'starting' }], ms: 4 });
    const key = api.cache.keyFor('docker.stacks', {});
    await api.cache.get(key, async () => ({ stacks: [] }), { ttl: 60_000 });
    assert.ok(api.cache.peek(key));
    const { result } = await api.dispatchCached('docker.restart', { project: 'drover-selftest', services: ['web'], actor: 'mcp' });
    assert.equal(result.count, 2);
    const [ev] = await opEvents('docker.restart');
    assert.equal(ev.actor, 'mcp'); assert.equal(ev.ok, true); assert.equal(ev.target, 'local');
    assert.deepEqual(ev.args, { project: 'drover-selftest', services: ['web'], actor: 'mcp' });
    assert.deepEqual(ev.result, { ok: true, project: 'drover-selftest', verb: 'restart', count: 2, exitCode: 0, timedOut: false }, 'scalars only: no output, no container list');
    assert.equal(api.cache.peek(key), null, 'a verb drops every docker.* entry');
  });
  test('an exec argv is redacted in the truth file, whether the verb ran or was refused', async () => {
    const key = ['sk', 'ant', 'api03', 'EXAMPLE0EXAMPLE0EXAMPLE0EXAMPLE0'].join('-');
    const argv = ['tool', '--password', 'hunter2', `TOKEN=${key}`, '--api-key', 'x9', 'ls'];
    api.local['docker.exec'] = async (a) => ({ ok: true, project: a.project, service: a.service, verb: 'exec', exitCode: 0, timedOut: false, stdout: '', stderr: '' });
    await api.dispatchCached('docker.exec', { project: 'drover-selftest', service: 'plain', argv, actor: 'mcp' });
    api.local['docker.exec'] = async () => { throw new docker.Refused('plain is not running'); };
    await assert.rejects(api.dispatchCached('docker.exec', { project: 'drover-selftest', service: 'plain', argv, actor: 'mcp' }), /not running/);
    const evs = (await opEvents('docker.exec')).slice(-2);
    assert.deepEqual(evs.map((e) => e.ok), [true, false]);
    for (const e of evs) {
      const text = JSON.stringify(e);
      assert.ok(!text.includes('hunter2') && !text.includes(key) && !text.includes('x9'), text);
      assert.deepEqual(e.args.argv.filter((x) => x === 'tool' || x === 'ls'), ['tool', 'ls'], 'the rest of the command stays readable');
    }
  });
  test('a refused verb is recorded as failed with the reason, and the caller gets the reason', async () => {
    api.local['docker.exec'] = async () => { throw new docker.Refused('no compose project nope on testbox (projects here: webapp)'); };
    await assert.rejects(api.dispatchCached('docker.exec', { project: 'nope', service: 'web', argv: ['id'], actor: 'mcp' }), /^Error: refused: no compose project nope on testbox/);
    const ev = (await opEvents('docker.exec')).at(-1);
    assert.equal(ev.ok, false); assert.equal(ev.actor, 'mcp');
    assert.match(ev.error, /^refused: no compose project nope on testbox \(projects here: webapp\)$/);
  });
});

/** A fake `ssh <host> drover rpc` per host: answer(host, op, args) is a result or 'ERR:<message>'. */
function fakeSpawn(answer) {
  const calls = [];
  remote._deps.spawn = (file, argv) => {
    const host = argv[argv.indexOf('--') - 1];
    const c = new EventEmitter();
    c.stdout = new PassThrough(); c.stderr = new PassThrough();
    c.stdin = {
      write(d) {
        for (const line of String(d).split('\n').filter(Boolean)) {
          const req = JSON.parse(line); calls.push({ host, op: req.op, args: req.args });
          const a = answer(host, req.op, req.args);
          setImmediate(() => c.stdout.write(JSON.stringify(typeof a === 'string' && a.startsWith('ERR:') ? { id: req.id, ok: false, error: a.slice(4) } : { id: req.id, ok: true, result: a }) + '\n'));
        }
      },
      end() { setTimeout(() => c.emit('close', 0), 10); }, on() {},
    };
    c.kill = () => setImmediate(() => c.emit('close', null));
    return c;
  };
  return calls;
}

describe('docker.fleet', () => {
  const real = { ...api.local };
  afterEach(() => { Object.assign(api.local, real); remote.stopAll(); api.cache.invalidate('docker.'); });
  const answer = (host, totals) => ({ host, ts: '2026-10-20T16:00:00.000Z', docker: { available: true, version: '29.5.1' }, totals, stacks: [{ project: 'webapp', verdict: 'ok' }], notes: [] });

  test('every named host in parallel, local included; totals summed; a host on old Drover is named as such and not covered', async () => {
    api.local['docker.stacks'] = async () => answer('box-a', { containers: 83, running: 80, failing: 1, stacks: 1 });
    const calls = fakeSpawn((host, op) => (host === 'oldbox' ? `ERR:unknown op ${op}` : answer(host, { containers: 147, running: 140, failing: 1, stacks: 5 })));
    const r = await api.front['docker.fleet']({ hosts: ['local', 'stackbox', 'oldbox'] });
    assert.deepEqual(r.hosts.map((h) => [h.route, h.ok]), [['local', true], ['stackbox', true], ['oldbox', false]]);
    assert.equal(r.hosts[2].error, `oldbox runs Drover code from before docker stacks: update Drover there (${UPDATE_HINT})`);
    assert.deepEqual(r.totals, { containers: 230, running: 220, failing: 2, stacks: 6 });
    assert.deepEqual(r.coverage.searched.sort(), [r.hosts[0].host, 'stackbox'].sort());
    assert.equal(r.coverage.notCovered[0].host, 'oldbox');
    assert.ok(calls.every((c) => c.op === 'docker.stacks'));
  });
  test('a summary per stack unless services is asked for, from the same cached per-host answer', async () => {
    let reads = 0;
    const stack = { project: 'webapp', verdict: 'degraded', counts: { total: 2 }, failing: [{ service: 'web-app-reports', state: 'unhealthy' }], services: [{ service: 'web-app-reports' }, { service: 'postgres' }], oneoff: [{ name: 'run-1' }], code: { notes: [] } };
    api.local['docker.stacks'] = async () => { reads++; return { ...answer('box-a', { containers: 2 }), stacks: [stack] }; };
    const brief = await api.front['docker.fleet']({ hosts: ['local'] });
    const [s] = brief.hosts[0].stacks;
    assert.equal(s.services, undefined); assert.equal(s.oneoff, undefined);
    assert.equal(s.serviceCount, 2); assert.equal(s.oneoffCount, 1);
    assert.deepEqual(s.failing, stack.failing, 'what is failing, and why, stays in the summary');
    const full = await api.front['docker.fleet']({ hosts: ['local'], services: true });
    assert.deepEqual(full.hosts[0].stacks[0].services, stack.services);
    assert.equal(reads, 1, 'both come from one cached per-host read');
  });
  test('each host is read through the cache a single-host docker.stacks uses; fresh reads every host again', async () => {
    let local = 0;
    api.local['docker.stacks'] = async () => { local++; return answer('box-a', { containers: 1 }); };
    const calls = fakeSpawn((host) => answer(host, { containers: 2 }));
    await api.front['docker.fleet']({ hosts: ['local', 'stackbox'] });
    await api.front['docker.fleet']({ hosts: ['local', 'stackbox'] });
    assert.equal(local, 1); assert.equal(calls.length, 1, 'the second read is served from the cache');
    const single = await api.dispatchCached('docker.stacks', { host: 'stackbox' });
    assert.equal(single.cache.hit, true, 'a single-host read shares the entry');
    const r = await api.front['docker.fleet']({ hosts: ['local', 'stackbox'], fresh: true });
    assert.equal(local, 2); assert.equal(calls.length, 2);
    assert.equal(r.hosts[1].cache.hit, false);
  });
  test('outside the daemon a host answer past its ttl is read again before the fleet answers, so drover stacks can exit', async () => {
    // Seen on 2026-10-20: `drover op docker.fleet` printed an answer 8 minutes old at once, and the refresh behind it opened
    // ssh peers after the CLI had stopped them, so it was still running when timeout killed it 150 s later.
    const ttl = api.CACHE_POLICY['docker.stacks'], was = api.cache.markLongLived(false);
    api.CACHE_POLICY['docker.stacks'] = 20;
    try {
      let n = 0;
      const calls = fakeSpawn((host) => answer(host, { containers: ++n }));
      await api.front['docker.fleet']({ hosts: ['stackbox'] });
      await new Promise((r) => setTimeout(r, 30));
      const r = await api.front['docker.fleet']({ hosts: ['stackbox'] });
      assert.equal(r.hosts[0].totals.containers, 2, 'the answer comes from the read made for it, not the stale one');
      assert.equal(r.hosts[0].cache.refreshing, false);
      assert.equal(calls.length, 2, 'both reads happened before their answers');
    } finally { api.CACHE_POLICY['docker.stacks'] = ttl; api.cache.markLongLived(was); }
  });
  test('a host that cannot answer now keeps its last answer, flagged in coverage.partial with the error', async () => {
    api.local['docker.stacks'] = async () => answer('box-a', { containers: 1 });
    let up = true;
    fakeSpawn((host) => (up ? answer(host, { containers: 2 }) : 'ERR:docker container inspect did not finish within 30 s'));
    await api.front['docker.fleet']({ hosts: ['stackbox'] });
    up = false;
    const r = await api.front['docker.fleet']({ hosts: ['stackbox'], fresh: true });
    assert.equal(r.hosts[0].ok, true); assert.equal(r.hosts[0].totals.containers, 2);
    assert.match(r.coverage.partial[0].reason, /^showing its answer from 0 min ago; refreshing failed: docker container inspect did not finish/);
  });
  test('the fleet op stays on the front even when a host is given', async () => {
    api.local['docker.stacks'] = async () => answer('box-a', { containers: 1 });
    const calls = fakeSpawn((host) => answer(host, { containers: 2 }));
    const r = await api.dispatch('docker.fleet', { host: 'stackbox', hosts: ['local'] });
    assert.deepEqual(r.hosts.map((h) => h.route), ['local']);
    assert.equal(calls.length, 0);
  });
});

describe('a host a plugin provides that runs no Drover, in the fleet op', () => {
  // A host provider as a plugin registers one (core/plugins.js hosts): its own host names, an rpc argv for hosts that
  // run Drover, and a docker read (docker.remoteStacks through its own exec) for those that do not.
  const seen = [];
  const provider = {
    match: (name) => name.startsWith('dev:'),
    known: async (name) => name === 'dev:ws9',
    unknownError: (name) => `no dev environment ${name}`,
    entries: async () => [{ name: 'dev:ws9', display: 'ws9', source: 'test-hosts', ephemeral: true }],
    rpcArgv: async (name) => ({ argv: ['test-transport', name, 'drover', 'rpc'] }),
    dockerStacks: (name, args) => docker.remoteStacks(async (argv, opts) => { seen.push([name, ...argv.slice(3), opts.timeoutMs]); return { code: 0, stdout: '__DROVER_DOCKER_VERSION__\t29.6.1\n' }; }, { host: name, via: 'test transport' }, args),
  };
  before(() => { api.applyPlugin(plugins.register({ name: 'test-hosts', hosts: provider })); });
  after(() => { plugins._reset(); });
  afterEach(() => { remote.stopAll(); api.cache.invalidate('docker.'); seen.length = 0; });

  test('the rpc that exits 97 (no Drover there) falls back to the provider\'s docker read', async () => {
    const spawned = [];
    remote._deps.spawn = (file, argv) => {
      spawned.push([file, ...argv]);
      const c = new EventEmitter(); c.stdout = new PassThrough(); c.stderr = new PassThrough();
      c.stdin = { write() { setImmediate(() => { c.stderr.write('Drover not installed on this host (no ~/.local/bin/drover)\n'); setImmediate(() => c.emit('close', 97)); }); }, end() {}, on() {} };
      c.kill = () => {};
      return c;
    };
    const r = await api.front['docker.fleet']({ hosts: ['dev:ws9'] });
    assert.deepEqual(spawned, [['test-transport', 'dev:ws9', 'drover', 'rpc']], 'the rpc was tried first, through the provider\'s argv');
    assert.deepEqual(seen, [['dev:ws9', 'sh', '', 'git', 90_000]]);
    await api.front['docker.fleet']({ hosts: ['dev:ws9'], project: 'webapp', git: false });
    assert.deepEqual(seen[1], ['dev:ws9', 'sh', 'webapp', 'nogit', 90_000], 'the options reach the provider\'s read, which the cache keys by them');
    assert.deepEqual(r.hosts.map((h) => [h.route, h.ok, h.via, h.readOnly, h.docker.version]), [['dev:ws9', true, 'test transport', true, '29.6.1']]);
    assert.deepEqual(r.coverage.notCovered, []);
  });
  test('an rpc that fails some other way is that host\'s error, not a docker read', async () => {
    remote._deps.spawn = () => {
      const c = new EventEmitter(); c.stdout = new PassThrough(); c.stderr = new PassThrough();
      c.stdin = { write() { setImmediate(() => { c.stderr.write('connection refused\n'); setImmediate(() => c.emit('close', 255)); }); }, end() {}, on() {} };
      c.kill = () => {};
      return c;
    };
    const r = await api.front['docker.fleet']({ hosts: ['dev:ws9'] });
    assert.deepEqual(seen, []);
    assert.equal(r.hosts[0].ok, false); assert.match(r.hosts[0].error, /exited 255: connection refused/);
    await assert.rejects(api.front['docker.fleet']({ hosts: ['dev:gone'] }), /no dev environment dev:gone/, 'a name the provider does not know is refused');
  });
});

describe('host.facts', () => {
  test('says why docker is unavailable instead of a bare null', async () => {
    const hosts = await import('../core/hosts.js');
    docker._reset(); process.env.DROVER_DOCKER = path.join(tmp, 'no-docker-here');
    try {
      const f = await hosts.localFacts();
      assert.equal(f.docker, null);
      assert.equal(f.dockerUnavailable, `DROVER_DOCKER=${path.join(tmp, 'no-docker-here')} is not an executable file`);
    } finally { delete process.env.DROVER_DOCKER; docker._reset(); }
  });
});

describe('who cannot reach docker ops', () => {
  let srv, base, widget, main, longLived;
  before(async () => {
    const http = await import('../server/http.js');
    longLived = api.cache.markLongLived(false);   // startServer marks the process long-lived; put it back after
    srv = await http.startServer({ port: 0 });
    base = srv.url.replace(/\/$/, ''); main = srv.token;
    widget = (await readFile(path.join(process.env.DROVER_STATE, 'widget-token'), 'utf8')).trim();
  });
  after(async () => { api.cache.markLongLived(longLived); await new Promise((r) => { srv?.server.close(r); srv?.server.closeAllConnections?.(); }); });

  test('the widget token gets 403 on every docker op, read or write', async () => {
    for (const op of ALL) {
      for (const method of ['GET', 'POST']) {
        const r = await fetch(`${base}/api/op/${op}`, { method, headers: { authorization: `Bearer ${widget}`, 'content-type': 'application/json' }, ...(method === 'POST' ? { body: '{"project":"webapp","services":["x"]}' } : {}) });
        assert.equal(r.status, 403, `${method} ${op}`);
        assert.equal((await r.json()).error, 'widget token: read-only scope');
      }
    }
    const r = await fetch(`${base}/api/op/docker.restart`, { headers: { authorization: `Bearer ${main}` } });
    assert.equal(r.status, 405, 'and a verb is never a GET, even with the main token');
  });
  test('the Grok bots gateway offers no docker tool and its code dispatches no docker op', () => {
    const grant = { bot: 'testbot', clientName: 'test', scopes: ['drover.read', 'drover.write', 'drover.notify'] };
    const names = botTools(grant, { dispatch: async () => ({}) }).map((t) => t.name);
    assert.ok(names.length > 5);
    assert.ok(!names.some((n) => /docker/i.test(n)), names.join(', '));
    for (const f of ['../core/bots/tools.js', '../core/bots/policy.js', '../core/bots/grok.js', '../server/botgate.js']) {
      assert.ok(!/docker/i.test(readFileSync(new URL(f, import.meta.url), 'utf8')), `${f} never names docker`);
    }
  });
});

describe('in the daemon', () => {
  let srv, longLived;
  // Not long-lived before startServer, so the test below shows that startServer marked it; put back after.
  before(async () => { longLived = api.cache.markLongLived(false); srv = await (await import('../server/http.js')).startServer({ port: 0 }); });
  after(async () => { api.cache.markLongLived(longLived); await new Promise((r) => { srv?.server.close(r); srv?.server.closeAllConnections?.(); }); });
  test('startServer marks the daemon long-lived, so it serves a host answer past its ttl at once and refreshes it behind', async () => {
    const real = api.local['docker.stacks'], ttl = api.CACHE_POLICY['docker.stacks'];
    api.CACHE_POLICY['docker.stacks'] = 20;
    try {
      let n = 0;
      api.local['docker.stacks'] = async () => ({ host: 'box-a', docker: { available: true }, totals: { containers: ++n }, stacks: [], notes: [] });
      await api.front['docker.fleet']({ hosts: ['local'] });
      await new Promise((r) => setTimeout(r, 30));
      const stale = await api.front['docker.fleet']({ hosts: ['local'] });
      assert.equal(stale.hosts[0].totals.containers, 1); assert.equal(stale.hosts[0].cache.refreshing, true);
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(n, 2, 'and the refresh behind it ran');
    } finally { api.local['docker.stacks'] = real; api.CACHE_POLICY['docker.stacks'] = ttl; api.cache.invalidate('docker.'); }
  });
});
