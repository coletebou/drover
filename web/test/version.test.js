// Which Drover code a machine runs (core/version.js): the commit `drover serve` recorded in daemon.json against the
// checkout's HEAD, host.version and fleet.versions through the op table (a fake ssh peer stands in for the other
// hosts), and a real `drover serve` in a scratch HOME recording its commit for `drover status`.
import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tmp = await mkdtemp(path.join(tmpdir(), 'drover-version-'));
process.env.DROVER_CACHE = path.join(tmp, 'cache');
process.env.DROVER_STATE = path.join(tmp, 'state');
process.env.DROVER_DOTFILES = path.join(tmp, 'dotfiles');
process.env.DROVER_EVENTS = path.join(tmp, 'dotfiles', 'claude', 'drover-events.jsonl');
await mkdir(path.join(tmp, 'dotfiles', 'claude'), { recursive: true });
await mkdir(process.env.DROVER_STATE, { recursive: true });
await writeFile(process.env.DROVER_EVENTS, '');
await writeFile(path.join(tmp, 'dotfiles', 'claude', 'fleet-hosts.txt'), 'newbox\nstalebox\noldbox\n');
const version = await import('../core/version.js');
const api = await import('../core/api.js');
const remote = await import('../core/remote.js');
const { UPDATE_HINT } = await import('../core/util.js');
const { META, isMutating } = await import('../core/ops-meta.js');
const { GENERATED_TOOLS } = await import('../mcp/server.js');
after(async () => { remote.stopAll(); await rm(tmp, { recursive: true, force: true }); });

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
const daemonFile = path.join(process.env.DROVER_STATE, 'daemon.json');
const writeDaemon = (d) => writeFile(daemonFile, JSON.stringify(d) + '\n');

describe('host.version on this machine', () => {
  const repo = path.join(tmp, 'checkout');
  let first, second;
  const realDeps = { ...version._deps };
  before(async () => {
    await mkdir(repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'master');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'one'); first = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'two'); second = git(repo, 'rev-parse', 'HEAD');
  });
  afterEach(async () => { Object.assign(version._deps, realDeps); version._reset(); await rm(daemonFile, { force: true }); });
  const here = () => { version._deps.checkoutDir = () => repo; version._deps.pidAlive = (pid) => pid === 4242; };

  test('no daemon: stopped, and nothing says what its sessions run (each loaded the checkout whenever it started)', async () => {
    here();
    const v = await version.hostVersion({ commit: first });
    assert.deepEqual({ state: v.state, loaded: v.loaded, daemon: v.daemon, contains: v.contains }, { state: 'stopped', loaded: null, daemon: null, contains: null });
    assert.deepEqual(v.checkout, { path: repo, commit: second, branch: 'master' });
    assert.equal((await version.hostVersion()).contains, undefined, 'contains only when a commit is asked about');
  });
  test('a daemon that loaded an older commit than the checkout holds must restart; the fix is not in what it runs', async () => {
    here();
    await writeDaemon({ pid: 4242, startedAt: '2026-10-27T01:00:00.000Z', commit: first, branch: 'master' });
    const v = await version.hostVersion({ commit: second.slice(0, 7) });
    assert.deepEqual({ state: v.state, loaded: v.loaded, contains: v.contains }, { state: 'restart', loaded: first, contains: false });
    assert.equal(version.statusLine(v), `code ${first.slice(0, 7)} (master); the checkout is now at ${second.slice(0, 7)}: restart the daemon to load it`);
  });
  test('a daemon on the checkout is live and contains every earlier commit', async () => {
    here();
    await writeDaemon({ pid: 4242, startedAt: '2026-10-27T01:00:00.000Z', commit: second, branch: 'master' });
    const v = await version.hostVersion({ commit: first });
    assert.deepEqual({ state: v.state, contains: v.contains }, { state: 'live', contains: true });
    assert.equal(version.statusLine(v), `code ${second.slice(0, 7)} (master)`);
  });
  test('a commit this checkout does not have, a daemon from before the commit was recorded, a dead pid', async () => {
    here();
    await writeDaemon({ pid: 4242, startedAt: '2026-10-27T01:00:00.000Z', commit: second });
    assert.equal((await version.hostVersion({ commit: 'deadbeefdeadbeef' })).contains, null, 'not fetched here: git cannot tell');
    await writeDaemon({ pid: 4242, startedAt: '2026-10-27T01:00:00.000Z' });
    const old = await version.hostVersion({ commit: first });
    assert.deepEqual({ state: old.state, loaded: old.loaded, contains: old.contains }, { state: 'unknown', loaded: null, contains: null });
    assert.match(version.statusLine(old), /^code unknown: this daemon started before Drover recorded its commit/);
    await writeDaemon({ pid: 999999, startedAt: '2026-10-27T01:00:00.000Z', commit: first });
    const dead = await version.hostVersion();
    assert.deepEqual({ state: dead.state, loaded: dead.loaded, running: dead.daemon.running }, { state: 'stopped', loaded: null, running: false });
    assert.equal(version.statusLine(dead), null);
  });
  test('daemon.json that is not an object, or carries a commit that is not hex, is not believed', async () => {
    here();
    await writeFile(daemonFile, '[1,2]\n');
    assert.equal((await version.hostVersion()).daemon, null);
    await writeDaemon({ pid: 4242, commit: '--exec=evil' });
    assert.equal((await version.hostVersion()).daemon.commit, null);
  });
  test('not a git checkout: no checkout, and a running daemon reads as unknown', async () => {
    version._deps.checkoutDir = () => path.join(tmp, 'not-a-repo'); version._deps.pidAlive = () => true;
    await mkdir(path.join(tmp, 'not-a-repo'), { recursive: true });
    await writeDaemon({ pid: 4242, commit: first });
    const v = await version.hostVersion();
    assert.deepEqual({ state: v.state, checkout: v.checkout }, { state: 'unknown', checkout: null });
  });
  test('an ssh peer started before a pull runs the old code: answeredBy is not current and the fix is not contained', async () => {
    const peerRepo = path.join(tmp, 'peer-checkout');
    await mkdir(peerRepo, { recursive: true });
    git(peerRepo, 'init', '-q', '-b', 'master'); git(peerRepo, 'commit', '-q', '--allow-empty', '-m', 'old');
    const old = git(peerRepo, 'rev-parse', 'HEAD');
    version._deps.checkoutDir = () => peerRepo; version._deps.pidAlive = (pid) => pid === 4242;
    assert.equal((await version.noteLoaded('rpc')).commit, old, 'the rpc process notes the commit it started on');
    git(peerRepo, 'commit', '-q', '--allow-empty', '-m', 'the fix'); const fix = git(peerRepo, 'rev-parse', 'HEAD');
    await writeDaemon({ pid: 4242, startedAt: '2026-10-27T01:00:00.000Z', commit: fix, branch: 'master' });   // the daemon restarted on the fix
    const v = await version.hostVersion({ commit: fix });
    assert.equal(v.state, 'live', 'the daemon itself is live');
    assert.deepEqual({ kind: v.answeredBy.kind, pid: v.answeredBy.pid, commit: v.answeredBy.commit, current: v.answeredBy.current }, { kind: 'rpc', pid: process.pid, commit: old, current: false });
    assert.equal(v.contains, false, 'what this peer runs for its front lacks the fix');
    assert.equal((await version.hostVersion({ commit: old })).contains, true, 'both have the older commit');
    await rm(daemonFile, { force: true });
    assert.equal((await version.hostVersion({ commit: fix })).contains, false, 'no daemon, but the peer surely lacks it: false beats unknown');
    assert.equal((await version.hostVersion({ commit: old })).contains, null, 'no daemon and the peer has it: the sessions here are unknown');
  });
  test('a daemon answering for itself is checked once; a process that noted no start adds nothing', async () => {
    here();
    version._deps.pidAlive = () => true;
    await version.noteLoaded('daemon');
    await writeDaemon({ pid: process.pid, startedAt: '2026-10-27T01:00:00.000Z', commit: second, branch: 'master' });
    const v = await version.hostVersion({ commit: first });
    assert.deepEqual({ kind: v.answeredBy.kind, current: v.answeredBy.current, contains: v.contains }, { kind: 'daemon', current: true, contains: true });
    version._reset();
    const cli = await version.hostVersion({ commit: first });
    assert.equal(cli.answeredBy, undefined); assert.equal(cli.contains, true);
  });
  test('codeMoved: false until the checkout\'s HEAD moves off the commit this process noted, then true', async () => {
    const repo2 = path.join(tmp, 'moving-checkout');
    await mkdir(repo2, { recursive: true });
    git(repo2, 'init', '-q', '-b', 'master'); git(repo2, 'commit', '-q', '--allow-empty', '-m', 'one');
    version._deps.checkoutDir = () => repo2;
    assert.equal(await version.codeMoved(), false, 'nothing noted yet');
    await version.noteLoaded('rpc');
    assert.equal(await version.codeMoved(), false);
    git(repo2, 'commit', '-q', '--allow-empty', '-m', 'two');
    assert.equal(await version.codeMoved(), true);
  });
  test('commit is hex only, so it can never reach git as an option', async () => {
    for (const bad of ['--output=/tmp/x', 'HEAD', 'abc', 'g'.repeat(10), 'a'.repeat(65), 'abcd;rm']) {
      await assert.rejects(version.hostVersion({ commit: bad }), /commit must be 4 to 64 hex digits/, bad);
      await assert.rejects(api.front['fleet.versions']({ hosts: ['local'], commit: bad }), /commit must be 4 to 64 hex digits/, bad);
    }
    assert.equal(version.commitArg(''), undefined);
    assert.equal(version.commitArg('E3D5B04'), 'E3D5B04');
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

describe('fleet.versions', () => {
  const real = { ...api.local };
  afterEach(() => { Object.assign(api.local, real); remote.stopAll(); });
  const at = (loaded, contains) => ({ state: 'live', loaded, checkout: { commit: loaded, branch: 'master' }, daemon: { running: true, commit: loaded }, ...(contains === undefined ? {} : { contains }) });

  test('everywhere only when every fleet host answered with the commit in what its daemon loaded', async () => {
    api.local['host.version'] = async ({ commit }) => at('e3d5b04aaaa', commit ? true : undefined);
    const calls = fakeSpawn((host, op, args) => (host === 'oldbox' ? `ERR:unknown op ${op}` : at(host === 'stalebox' ? 'd1a1ec8bbbb' : 'e3d5b04aaaa', args.commit ? host !== 'stalebox' : undefined)));
    const all = await api.front['fleet.versions']({ hosts: ['local', 'newbox', 'stalebox', 'oldbox'], commit: 'e3d5b04' });
    assert.equal(all.commit, 'e3d5b04');
    assert.equal(all.everywhere, undefined, 'a named subset gets no verdict that would read as the fleet\'s');
    assert.deepEqual(all.hosts.map((h) => [h.ok, h.contains ?? null]), [[true, true], [true, true], [true, false], [false, null]]);
    assert.equal(all.hosts[3].error, `oldbox runs Drover code from before host.version: update Drover there (${UPDATE_HINT})`);
    assert.equal(all.hosts[3].results, undefined, 'no search-shaped leftovers on a failed row');
    assert.equal(all.coverage.notCovered[0].host, 'oldbox');
    assert.ok(calls.filter((c) => c.op === 'host.version').every((c) => c.args.commit === 'e3d5b04'), 'the commit is asked about on each host');
  });
  test('fleet-wide, everywhere is false while any fleet host lacks the commit or was not asked, true when none', async () => {
    api.local['host.version'] = async () => at('e3d5b04aaaa', true);
    let lacking = new Set(['stalebox']);
    fakeSpawn((host) => at('e3d5b04aaaa', !lacking.has(host)));
    api.rememberProbe(['newbox', 'stalebox', 'oldbox'].map((host) => ({ host, up: true })));
    const one = await api.front['fleet.versions']({ commit: 'e3d5b04' });
    assert.deepEqual([one.everywhere, one.hosts.length], [false, 4]);
    lacking = new Set();
    api.rememberProbe([{ host: 'oldbox', up: false, error: 'ssh: connect timed out' }]);
    const down = await api.front['fleet.versions']({ commit: 'e3d5b04' });
    assert.equal(down.everywhere, false, 'a host that could not be asked might lack it');
    assert.match(down.coverage.notCovered.find((n) => n.host === 'oldbox').reason, /down at the last probe/);
    api.rememberProbe([{ host: 'oldbox', up: true }]);
    const every = await api.front['fleet.versions']({ commit: 'e3d5b04' });
    assert.deepEqual([every.everywhere, every.hosts.every((h) => h.contains === true), every.coverage.notCovered], [true, true, []]);
  });
  test('a daemon that runs here but does not answer: the answer made here says its peers were not asked, everywhere null', async () => {
    api.local['host.version'] = async () => at('e3d5b04aaaa', true);
    fakeSpawn(() => at('e3d5b04aaaa', true));
    api.rememberProbe(['newbox', 'stalebox', 'oldbox'].map((host) => ({ host, up: true })));
    // A live pid that is not this process, at a URL nothing answers (no token either): daemonEndpoint finds no daemon.
    await writeDaemon({ pid: process.ppid, url: 'http://127.0.0.1:9/', startedAt: '2026-10-27T01:00:00.000Z', commit: 'e3d5b04aaaa' });
    try {
      const r = await api.front['fleet.versions']({ commit: 'e3d5b04' });
      assert.equal(r.everywhere, null, 'every row has it, but the daemon\'s own peers were not asked');
      assert.match(r.note, new RegExp(`outside this machine's daemon \\(pid ${process.ppid}\\), which did not answer`));
    } finally { await rm(daemonFile, { force: true }); }
    const none = await api.front['fleet.versions']({ commit: 'e3d5b04' });
    assert.deepEqual([none.everywhere, none.note], [true, undefined], 'no daemon here: nothing was left out');
  });
  test('without a commit: each host\'s state and loaded commit, and no everywhere verdict', async () => {
    api.local['host.version'] = async () => at('e3d5b04aaaa');
    fakeSpawn(() => ({ ...at('d1a1ec8bbbb'), state: 'restart' }));
    const r = await api.front['fleet.versions']({ hosts: ['local', 'stalebox'] });
    assert.equal(r.everywhere, undefined); assert.equal(r.commit, undefined);
    assert.deepEqual(r.hosts.map((h) => [h.state, h.loaded]), [['live', 'e3d5b04aaaa'], ['restart', 'd1a1ec8bbbb']]);
  });
  test('on the op table and an MCP tool each; reads; never cached; the fleet op is the front\'s own', () => {
    for (const op of ['host.version', 'fleet.versions']) {
      assert.ok(api.OPS.includes(op), op);
      assert.ok(META[op].d.length > 80, op);
      assert.equal(isMutating(op), false, op);
      assert.equal(api.CACHE_POLICY[op], undefined, `${op} is never cached`);
      assert.equal(typeof META[op].s.properties.commit.description, 'string', op);
      assert.equal(typeof META[op].s.properties.host.description, 'string', `${op} takes host`);
      const tool = GENERATED_TOOLS.find((t) => t.name === `drover_${op.replace('.', '_')}`);
      assert.ok(tool, op);
      assert.ok(JSON.stringify(tool).includes('"host"'), `the ${tool?.name} tool offers host`);
    }
    assert.equal(typeof api.local['host.version'], 'function');
    assert.equal(api.local['fleet.versions'], undefined);
    assert.equal(typeof api.front['fleet.versions'], 'function');
  });
});

describe('drover serve and drover status', () => {
  test('a real daemon records the commit it loaded, status names it, and an rpc process reports both', { timeout: 60_000 }, async () => {
    const home = await mkdtemp(path.join(tmp, 'home-'));
    // A scratch HOME and no DROVER_* or APXW_* settings: no plugins, bot gateway, settings or state of this machine.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(DROVER|APXW)_/.test(k)));
    Object.assign(env, { HOME: home, DROVER_STATE: path.join(home, 'state'), DROVER_CACHE: path.join(home, 'cache'), DROVER_SHARE: path.join(home, 'share'), DROVER_DOTFILES: path.join(home, 'dotfiles') });
    const bin = path.join(WEB, 'bin', 'drover');
    const child = spawn(process.execPath, [bin, 'serve', '--port', '0', '--no-snapshots'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = ''; child.stderr.on('data', (d) => { err += d; });
    const exited = new Promise((resolve) => child.on('exit', resolve));
    try {
      const file = path.join(home, 'state', 'daemon.json');
      for (let i = 0; i < 300 && !existsSync(file); i++) await new Promise((r) => setTimeout(r, 100));
      assert.ok(existsSync(file), `daemon.json was written (stderr: ${err.slice(0, 400)})`);
      const d = JSON.parse(await readFile(file, 'utf8'));
      let head = null; try { head = git(WEB, 'rev-parse', 'HEAD'); } catch { /* not a checkout */ }
      assert.equal(d.pid, child.pid);
      assert.equal(d.commit, head, 'the commit of the checkout it loaded');
      const out = execFileSync(process.execPath, [bin, 'status'], { env, encoding: 'utf8' });
      const lines = out.trim().split('\n');
      assert.match(lines[0], new RegExp(`^running pid ${child.pid} since `));
      if (head) assert.match(lines[1], new RegExp(`^code ${head.slice(0, 7)}`));
      assert.equal(lines.at(-1), d.url);
      // A `drover rpc` beside it, as a front's ssh peer: it answers for itself and names the daemon's code.
      const rpc = spawnSync(process.execPath, [bin, 'rpc'], { env, encoding: 'utf8', input: JSON.stringify({ id: 1, op: 'host.version', args: head ? { commit: head } : {} }) + '\n', timeout: 30_000 });
      const line = rpc.stdout.trim().split('\n').filter(Boolean).at(-1);
      assert.ok(line, `drover rpc replied (status ${rpc.status}, signal ${rpc.signal}, error ${rpc.error?.message}, stderr ${rpc.stderr.slice(-600)})`);
      const reply = JSON.parse(line);
      assert.equal(reply.ok, true, line);
      assert.equal(reply.result.daemon.pid, child.pid);
      assert.equal(reply.result.answeredBy.kind, 'rpc');
      if (head) assert.deepEqual([reply.result.state, reply.result.answeredBy.current, reply.result.contains], ['live', true, true]);
      // `drover op fleet.versions` reads in its own process, whose ssh peers would be new: the daemon answers it instead.
      // First one answered call, so the CLI's 3 s daemon probe (host.identity, cached after this) does not miss a daemon
      // still starting up on a loaded machine (that miss is the note case above).
      const token = (await readFile(path.join(home, 'state', 'token'), 'utf8')).trim();
      for (let i = 0; i < 60; i++) {
        const ok = await fetch(new URL('api/op/host.identity', d.url), { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) }).then((r) => r.ok, () => false);
        if (ok) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      const fleet = JSON.parse(execFileSync(process.execPath, [bin, 'op', 'fleet.versions', JSON.stringify(head ? { commit: head } : {})], { env, encoding: 'utf8', timeout: 60_000 }));
      const here = fleet.hosts.find((h) => h.answeredBy);
      assert.deepEqual([here?.answeredBy.kind, here?.answeredBy.pid], ['daemon', child.pid], 'answered inside the daemon');
      if (head) assert.equal(fleet.everywhere, true, 'a one-host fleet on its own HEAD');
    } finally { child.kill('SIGTERM'); await exited; }
  });
});

describe('a real drover rpc whose checkout moves under it', () => {
  test('its replies say stale once the checkout\'s HEAD has moved, so its front retires it', { timeout: 60_000 }, async () => {
    // A copy of web/ in a scratch git repository stands in for a host's checkout, so a commit can land under the process.
    const repo = await mkdtemp(path.join(tmp, 'rpc-checkout-'));
    await cp(WEB, path.join(repo, 'web'), { recursive: true, filter: (src) => !src.startsWith(path.join(WEB, 'test')) });
    git(repo, 'init', '-q', '-b', 'master'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'old');
    const home = await mkdtemp(path.join(tmp, 'rpc-home-'));
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(DROVER|APXW)_/.test(k)));
    Object.assign(env, { HOME: home, DROVER_STATE: path.join(home, 'state'), DROVER_CACHE: path.join(home, 'cache'), DROVER_DOTFILES: path.join(home, 'dotfiles'), DROVER_RPC_STALE_CHECK_MS: '100' });
    const child = spawn(process.execPath, [path.join(repo, 'web', 'bin', 'drover'), 'rpc'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const replies = []; let buf = '';
    child.stdout.setEncoding('utf8').on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) replies.push(JSON.parse(l)); } });
    const ask = async (id) => {
      child.stdin.write(JSON.stringify({ id, op: 'host.version', args: {} }) + '\n');
      for (let i = 0; i < 400 && !replies.some((r) => r.id === id); i++) await new Promise((r) => setTimeout(r, 50));
      return replies.find((r) => r.id === id);
    };
    try {
      const first = await ask(1);
      assert.equal(first?.ok, true, JSON.stringify(first));
      assert.equal(first.stale, undefined, 'its checkout has not moved');
      assert.equal(first.result.answeredBy.current, true);
      git(repo, 'commit', '-q', '--allow-empty', '-m', 'the fix');
      let later;
      for (let id = 2; id < 40 && !later?.stale; id++) { later = await ask(id); await new Promise((r) => setTimeout(r, 100)); }
      assert.equal(later?.stale, true, 'it says stale after the checkout moved');
      assert.equal(later.result.answeredBy.current, false, 'and host.version agrees');
    } finally { child.stdin.end(); child.kill('SIGTERM'); }
  });
});
