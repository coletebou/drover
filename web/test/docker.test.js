// core/docker.js: discovery, state, kinds and verdicts from inspect output in the module's own INSPECT_FORMAT shape
// (test/fixtures/docker-inspect.jsonl, synthetic: a web app's stack, a review worktree's stack brought up at two
// commits, Drover's selftest project and a container started with docker run from a compose-built image; nothing
// secret-looking in them but hex ids), the settings that name kinds, the label prefix and the base branch, the code
// line against a fake git, a host that runs no Drover read through a fake exec, and the guarded verbs against a fake
// docker that records every argv. Every test names its settings, so none depends on the environment it runs in.
import './isolate-cache.js';
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const d = await import('../core/docker.js');
const FIXTURE = readFileSync(new URL('./fixtures/docker-inspect.jsonl', import.meta.url), 'utf8');
const RAW = FIXTURE.split('\n').filter(Boolean).map((l) => JSON.parse(l));
const byName = (n) => RAW.find((r) => r.name === `/${n}`);
// The kinds the tests sort the web app's services into (DROVER_DOCKER_KINDS), and the settings in effect: the default
// label prefix (drover), these kinds, no base branch.
const KINDS = JSON.stringify([{ kind: 'app', match: '^web-app-', label: 'apps' }, { kind: 'ml', match: '^web-ml-', label: 'ML' }, { kind: 'core', match: '^web-' }]);
const CONFIG = d.dockerConfig({ DROVER_DOCKER_KINDS: KINDS });
const NONE = d.dockerConfig({});
const parsed = d.parseInspect(FIXTURE, { config: CONFIG }).containers;
const one = (n) => parsed.find((c) => c.name === n);

const TMP = await mkdtemp(path.join(tmpdir(), 'drover-docker-'));
const DOCKER = path.join(TMP, 'docker');
await writeFile(DOCKER, '#!/bin/sh\nexit 0\n'); await chmod(DOCKER, 0o755);
after(async () => { await rm(TMP, { recursive: true, force: true }); });
const real = { ...d._deps };

describe('parsing inspect output', () => {
  test('every fixture line parses; env never appears (the template leaves it out)', () => {
    const r = d.parseInspect(`${FIXTURE}\nnot json\n`, { config: CONFIG });
    assert.equal(r.containers.length, RAW.length);
    assert.equal(r.bad, 1);
    assert.ok(!/"Env"/.test(FIXTURE));
    assert.ok(!d.INSPECT_FORMAT.includes('.Env'));
  });
  test('a container: compose labels, health with its last output, ports, bind mounts', () => {
    const rep = one('web-app-reports');
    assert.equal(rep.project, 'webapp'); assert.equal(rep.service, 'web-app-reports'); assert.equal(rep.workingDir, '/home/dev/src/webapp');
    assert.deepEqual(rep.configFiles, ['/home/dev/src/webapp/compose.yml', '/home/dev/src/webapp/compose.override.yml']);
    assert.equal(rep.health.status, 'unhealthy'); assert.ok(rep.health.failingStreak > 100);
    assert.match(rep.health.last, /Connection refused/);
    assert.deepEqual(rep.ports, ['3930->3930/tcp'], 'IPv4 and IPv6 binds of one port fold');
    assert.ok(rep.binds.some((b) => b.source === '/home/dev/src/webapp/src' && b.rw));
    assert.deepEqual(one('web-ui').ports, ['127.0.0.1:5174->5173/tcp'], 'a loopback bind keeps its address');
    assert.deepEqual(one('review-web-ui').labels, { 'drover.commit': '5d0c9e7b21', 'drover.owner': 'review-42' }, 'labels under the prefix only');
  });
  test('the labels read are the ones under the configured prefix', () => {
    const raw = byName('review-web-app-notify');
    assert.deepEqual(d.normalizeContainer(raw, { config: NONE }).labels, { 'drover.commit': '5d0c9e7b21', 'drover.dev.peers.target': 'web-app-reports', 'drover.owner': 'review-42' });
    const other = d.dockerConfig({ DROVER_DOCKER_LABEL_PREFIX: 'com.example' });
    assert.equal(other.commitKey, 'com.example.commit');
    assert.deepEqual(d.normalizeContainer(raw, { config: other }).labels, { 'com.example.logs': '[{"source": "node", "service": "notify"}]' }, 'a dotted prefix');
    assert.deepEqual(d.normalizeContainer({ ...raw, labels: { ...raw.labels, 'droverish.x': '1', drover: '2' } }, { config: NONE }).labels['droverish.x'], undefined, 'the prefix is a whole word');
  });
  test('a container docker run started from a compose-built image is not in that project', () => {
    const c = one('queue-replay-check');
    assert.equal(c.project, null); assert.equal(c.service, null);
    assert.deepEqual(c.inherited, { project: 'webapp', service: 'web-queue' });
  });
  test('depends_on and port shapes', () => {
    assert.deepEqual(d.parseDependsOn('postgres:service_healthy:false,job:service_completed_successfully:false'), [{ service: 'postgres', condition: 'service_healthy' }, { service: 'job', condition: 'service_completed_successfully' }]);
    assert.deepEqual(d.parseDependsOn(undefined), []);
    assert.deepEqual(d.portsOf({ '80/tcp': null, '53/udp': [{ HostIp: '::1', HostPort: '5353' }], '9/tcp': [{ HostIp: '', HostPort: '' }] }), ['[::1]:5353->53/udp']);
  });
});

describe('settings', () => {
  const notes = [];
  beforeEach(() => { notes.length = 0; d._deps.warn = (l) => notes.push(l); });
  after(() => { d._deps.warn = real.warn; });
  test('defaults: the drover prefix, no kinds, no base branch', () => {
    assert.deepEqual({ ...NONE, rules: NONE.rules.length }, { prefix: 'drover', commitKey: 'drover.commit', rules: 0, kinds: ['infra'], labels: {}, base: null });
  });
  test('kinds: rules in order, the first match wins, the rest infra; labels name kinds in summaries', () => {
    assert.deepEqual(CONFIG.kinds, ['app', 'ml', 'core', 'infra']);
    assert.deepEqual(CONFIG.labels, { app: 'apps', ml: 'ML' });
    assert.deepEqual(['web-app-reports', 'web-ml-ranker', 'web-gateway', 'web-queue', 'postgres', 'migrations', 'minio-init'].map((s) => d.kindOf(s, { config: CONFIG })), ['app', 'ml', 'core', 'core', 'infra', 'infra', 'infra']);
    assert.equal(d.kindOf('web-app-api', { config: NONE }), 'infra', 'no rules: every service is infra');
    const own = d.dockerConfig({ DROVER_DOCKER_KINDS: JSON.stringify([{ kind: 'db', match: 'postgres|redis' }, { kind: 'infra', match: '^minio' }, { kind: 'web', match: '^web-' }]) });
    assert.deepEqual(own.kinds, ['db', 'infra', 'web'], 'infra named by a rule keeps its place');
    assert.deepEqual(notes, []);
  });
  test('a value that cannot be used is ignored with one note on stderr, and the default applies', () => {
    for (const bad of ['{', '{"kind":"app"}', '[{"kind":"app"}]', '[{"kind":"app","match":"("}]', '[{"kind":"9x","match":"a"}]', '[{"kind":"app","match":"a","pattern":"b"}]', '[{"kind":"app","match":"a","label":""}]', JSON.stringify(Array(33).fill({ kind: 'a', match: 'a' }))]) {
      const c = d.dockerConfig({ DROVER_DOCKER_KINDS: bad });
      assert.deepEqual([c.rules, c.kinds], [[], ['infra']], bad);
    }
    assert.equal(notes.length, 8);
    assert.ok(notes.every((n) => /^drover: DROVER_DOCKER_KINDS=.* is ignored: .*; no kinds are used$/.test(n)), notes.join('\n'));
    assert.match(notes[3], /rule 1: Invalid regular expression/);
    d.dockerConfig({ DROVER_DOCKER_KINDS: '{' }); d.dockerConfig({});
    d.dockerConfig({ DROVER_DOCKER_KINDS: '{' });
    assert.equal(notes.length, 8, 'a value is noted once');
    assert.equal(d.dockerConfig({ DROVER_DOCKER_LABEL_PREFIX: 'bad prefix!' }).prefix, 'drover');
    assert.equal(d.dockerConfig({ DROVER_DOCKER_LABEL_PREFIX: 'trailing.' }).prefix, 'drover');
    assert.equal(d.dockerConfig({ DROVER_DOCKER_BASE: '--upload-pack=x' }).base, null);
    assert.equal(d.dockerConfig({ DROVER_DOCKER_BASE: 'origin/../x' }).base, null);
    assert.equal(d.dockerConfig({ DROVER_DOCKER_BASE: 'origin/main' }).base, 'origin/main');
    assert.equal(notes.length, 12);
    assert.match(notes.at(-1), /^drover: DROVER_DOCKER_BASE=origin\/\.\.\/x is ignored: not a git ref name/);
  });
});

describe('state of a container', () => {
  const jobsOf = (project) => new Set(parsed.filter((c) => c.project === project).flatMap((c) => c.dependsOn.filter((x) => x.condition === 'service_completed_successfully').map((x) => x.service)));
  test('running: healthy, unhealthy, or up when there is no healthcheck (not healthy)', () => {
    assert.equal(d.classify(one('webapp-postgres')), 'healthy');
    assert.equal(d.classify(one('web-app-reports')), 'unhealthy');
    assert.equal(d.classify(one('web-ui')), 'up');
    assert.equal(d.classify(one('drover-selftest-plain-1')), 'up');
  });
  test('a one-shot job that exited 0 is completed; one that exited 1 failed', () => {
    assert.equal(d.classify(one('webapp-migrations'), { jobs: jobsOf('webapp') }), 'completed');
    assert.equal(d.classify(one('minio-init')), 'completed', 'restart: no and exit 0, even without its dependents in view');
    assert.equal(d.classify(one('drover-selftest-job-ok-1'), { jobs: jobsOf('drover-selftest') }), 'completed');
    assert.equal(d.classify(one('drover-selftest-job-fail-1')), 'failed');
  });
  test('the decision table for the other states', () => {
    const c = (o) => ({ status: 'exited', exitCode: 0, restartPolicy: 'no', oomKilled: false, oneoff: false, service: 'x', health: null, ...o });
    assert.equal(d.classify(c({ restartPolicy: 'unless-stopped', exitCode: 137 })), 'stopped', 'kept running by policy, so exited on purpose');
    assert.equal(d.classify(c({ restartPolicy: 'always', exitCode: 0 })), 'stopped');
    assert.equal(d.classify(c({ exitCode: 0, oomKilled: true })), 'failed');
    assert.equal(d.classify(c({ restartPolicy: 'unless-stopped', exitCode: 1 }), { jobs: new Set(['x']) }), 'failed', 'a job is judged by its exit code first');
    assert.equal(d.classify(c({ oneoff: true, exitCode: 2 })), 'failed');
    for (const s of ['restarting', 'paused', 'created', 'removing', 'dead']) assert.equal(d.classify(c({ status: s })), s);
    assert.equal(d.classify(c({ status: 'running', health: { status: 'starting' } })), 'starting');
    assert.equal(d.classify(c({ status: 'weird' })), 'unknown');
  });
  test('verdicts', () => {
    const v = (...st) => d.verdict(st.map((state) => ({ state })));
    assert.equal(v('healthy', 'up', 'completed'), 'ok');
    assert.equal(v('healthy', 'starting'), 'starting');
    assert.equal(v('healthy', 'unhealthy'), 'degraded');
    assert.equal(v('completed', 'failed'), 'down', 'nothing running');
    assert.equal(v('stopped', 'stopped'), 'down');
    assert.equal(v(), 'empty');
  });
});

describe('stacks from containers', () => {
  const stacks = d.buildStacks(parsed, { config: CONFIG });
  const get = (p) => stacks.find((s) => s.project === p);
  test('one stack per project, sorted, the containers outside any project last', () => {
    assert.deepEqual(stacks.map((s) => s.project), ['drover-selftest', 'webapp', 'webapp-review', null]);
    assert.equal(stacks.at(-1).loose, true);
  });
  test('webapp: counts by state, the failing service named with why, kinds from service names', () => {
    const s = get('webapp');
    assert.equal(s.verdict, 'degraded');
    assert.deepEqual(Object.fromEntries(Object.entries(s.counts).filter(([, n]) => n)), { total: 10, running: 7, unhealthy: 1, up: 2, healthy: 4, completed: 3 });
    assert.deepEqual(s.failing.map((f) => [f.service, f.kind, f.state]), [['web-app-reports', 'app', 'unhealthy']]);
    assert.match(s.failing[0].detail, /^health: .*Connection refused/);
    assert.deepEqual(Object.keys(s.kinds), ['app', 'ml', 'core', 'infra'], 'in the order the rules name them');
    assert.deepEqual(s.kinds.app, { total: 2, healthy: 0, up: 1, completed: 0, starting: 0, failing: ['web-app-reports'], label: 'apps' });
    assert.deepEqual(s.kinds.infra, { total: 4, healthy: 1, up: 0, completed: 3, starting: 0, failing: [] });
    assert.equal(s.kinds.ml.total, 1); assert.equal(s.kinds.ml.label, 'ML'); assert.equal(s.kinds.core.total, 3);
    assert.deepEqual(s.services.map((x) => x.service), ['web-app-api', 'web-app-reports', 'web-ml-ranker', 'web-gateway', 'web-queue', 'web-ui', 'migrations', 'minio-data-owner', 'minio-init', 'postgres'], 'by kind, then name');
    assert.equal(s.services.find((x) => x.service === 'migrations').job, true, 'web-gateway waits for it to complete');
    assert.equal(s.workingDir, '/home/dev/src/webapp');
  });
  test('without kind rules no stack has kinds, and every service is infra', () => {
    const plain = d.buildStacks(parsed, { config: NONE });
    assert.ok(plain.every((s) => s.kinds === null));
    assert.ok(plain.flatMap((s) => s.services).every((v) => v.kind === 'infra'));
    assert.deepEqual(plain.map((s) => [s.project, s.verdict, s.counts.total]), stacks.map((s) => [s.project, s.verdict, s.counts.total]), 'kinds change nothing else');
  });
  test('any kind names: what the rules say, in their order', () => {
    const own = d.dockerConfig({ DROVER_DOCKER_KINDS: JSON.stringify([{ kind: 'data', match: '^(postgres|redis)$', label: 'stores' }, { kind: 'jobs', match: 'migrations|-init$' }]) });
    const s = d.buildStacks(parsed, { config: own }).find((x) => x.project === 'webapp-review');
    assert.deepEqual(Object.fromEntries(Object.entries(s.kinds).map(([k, v]) => [k, [v.total, v.label ?? null]])), { data: [2, 'stores'], jobs: [1, null], infra: [5, null] });
    assert.deepEqual(s.services.slice(0, 3).map((x) => [x.service, x.kind]), [['postgres', 'data'], ['redis', 'data'], ['migrations', 'jobs']]);
  });
  test('a project whose containers disagree on the commit label keeps every value', () => {
    assert.deepEqual(get('webapp-review').labels['drover.commit'], ['5d0c9e7b21', '8e4f3a6c90']);
    assert.equal(get('webapp-review').verdict, 'ok');
  });
  test('drover-selftest: a stack no kind rule matches has no kinds; a depended-on job is a job', () => {
    const s = get('drover-selftest');
    assert.equal(s.kinds, null);
    assert.deepEqual(s.failing.map((f) => [f.service, f.state, f.detail ?? null]), [['job-fail', 'failed', 'exit 1'], ['sick', 'unhealthy', null]]);
    assert.equal(s.services.find((x) => x.service === 'job-ok').job, true);
    assert.deepEqual(s.services.find((x) => x.service === 'web').ports, ['127.0.0.1:18080->8080/tcp']);
  });
  test('the docker-run container sits outside with a note saying why', () => {
    const s = stacks.at(-1);
    assert.deepEqual(s.services.map((x) => x.service), ['queue-replay-check']);
    assert.equal(s.kinds, null, 'containers outside compose get no kinds');
    assert.match(s.notes[0], /compose labels from its image.*docker run.*queue-replay-check \(webapp\/web-queue\)/);
  });
  test('one-off runs are listed apart and not counted; totals count every container', () => {
    const job = { ...one('drover-selftest-job-ok-1'), id: 'f'.repeat(64), name: 'drover-selftest-job-ok-run-1', oneoff: true };
    const [s] = d.buildStacks([one('drover-selftest-web-1'), job], { config: CONFIG });
    assert.equal(s.counts.total, 1);
    assert.deepEqual(s.oneoff.map((o) => [o.name, o.state]), [['drover-selftest-job-ok-run-1', 'completed']]);
    const t = d.totalsOf([s]);
    assert.equal(t.containers, 2); assert.equal(t.oneoff, 1); assert.equal(t.stacks, 1);
  });
  test('a service with several containers shows its worst one', () => {
    const ok = one('drover-selftest-plain-1');
    const bad = { ...ok, id: 'e'.repeat(64), name: 'drover-selftest-plain-2', status: 'exited', exitCode: 137, number: 2 };
    const [s] = d.buildStacks([ok, bad], { config: CONFIG });
    assert.equal(s.services[0].count, 2);
    assert.equal(s.services[0].state, 'stopped');
    assert.equal(s.verdict, 'degraded');
  });
});

describe('git status', () => {
  test('porcelain v2: head, branch, upstream, ahead/behind, changes (a rename takes two records)', () => {
    const z = ['# branch.oid ' + 'a'.repeat(40), '# branch.head report-fixes', '# branch.upstream origin/report-fixes', '# branch.ab +3 -12',
      '1 .M N... 100644 100644 100644 x y file1', '2 R. N... 100644 100644 100644 x y R100 new', 'old', 'u UU N... 1 2 3 4 a b c conflict', '? untracked.txt', '! ignored', ''].join('\0');
    assert.deepEqual(d.parseStatusV2(z), { head: 'a'.repeat(40), branch: 'report-fixes', detached: false, upstream: 'origin/report-fixes', ahead: 3, behind: 12, changed: 3, untracked: 1, conflicted: 1 });
    assert.deepEqual(d.parseStatusV2(['# branch.oid ' + 'b'.repeat(40), '# branch.head (detached)', ''].join('\0')), { head: 'b'.repeat(40), branch: null, detached: true, upstream: null, ahead: null, behind: null, changed: 0, untracked: 0, conflicted: 0 });
    assert.equal(d.parseStatusV2('# branch.oid (initial)\0# branch.head main\0').head, null);
  });
});

describe('text that leaves the host', () => {
  test('escapes and control characters out, secrets redacted, hex short SHAs kept', () => {
    const tok = ['ghp', 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2'].join('_');
    const t = d.cleanText(`\x1b[31merror\x1b[0m\r\nkey=${tok}\x07 sha a13ec9b946 Authorization: Bearer abc.def`);
    assert.ok(!t.includes(tok)); assert.ok(!t.includes('\x1b')); assert.ok(!t.includes('\x07'));
    assert.match(t, /^error\nkey=\[redacted\]/); assert.match(t, /sha a13ec9b946/); assert.match(t, /Authorization: \[redacted\]/);
  });
  test("docker's own output keeps container names: ids echoed back become names, compose run names are not taken for tokens", () => {
    const tok = ['ghp', 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2'].join('_');
    const id = 'a'.repeat(52) + '0123456789ab';
    const out = d.cleanOutput(`${id}\n Container drover-selftest-job-ok-run-2811e91b1ca3 Creating\nTOKEN=${tok} drover-selftest-web-1\n`, { project: 'drover-selftest', containers: [{ id, name: 'drover-selftest-web-1' }] });
    assert.equal(out, `drover-selftest-web-1\n Container drover-selftest-job-ok-run-2811e91b1ca3 Creating\nTOKEN=[redacted] drover-selftest-web-1\n`);
    assert.match(d.cleanText(' Container drover-selftest-job-ok-run-2811e91b1ca3 Creating'), /\[redacted\]/, 'the plain cleaner would have hidden it');
  });
  test('a label whose name says it holds a secret is withheld whatever its value looks like', () => {
    const c = d.normalizeContainer({ id: 'f'.repeat(64), name: '/x', labels: { 'com.docker.compose.oneoff': 'False', 'drover.password': 'hunter2', 'drover.api_key': 'short', 'drover.owner': 'review-42' } }, { config: NONE });
    assert.deepEqual(c.labels, { 'drover.password': '[redacted]', 'drover.api_key': '[redacted]', 'drover.owner': 'review-42' });
  });
  test('a long dotted or dashed run is withheld whole, so redacting stays linear (the redactor is quadratic on one)', () => {
    const t0 = performance.now();
    const out = d.cleanText(`start ${'a.'.repeat(32_768)} end ${'b-1-'.repeat(16_384)} done`);
    assert.ok(performance.now() - t0 < 300, `took ${performance.now() - t0} ms`);
    assert.equal(out, 'start [redacted] end [redacted] done');
    assert.equal(d.cleanText(`ok ${'x.'.repeat(128)}`), `ok ${'x.'.repeat(128)}`, 'a run of 256 is kept');
  });
  test('docker unavailable, in words', () => {
    assert.match(d.whyUnavailable({ code: 1, stderr: 'Cannot connect to the Docker daemon at unix:///Users/me/.docker/run/docker.sock. Is the docker daemon running?\n' }), /^no docker daemon is answering/);
    assert.match(d.whyUnavailable({ code: 1, stderr: 'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock' }), /^permission denied on the docker socket \(is .+ in the docker group\?\)/);
    assert.match(d.whyUnavailable({ code: null, timedOut: true, stderr: '' }), /did not answer within 15 s/);
    assert.match(d.whyUnavailable({ code: 125, stderr: 'boom' }), /^docker ps failed \(exit 125\): boom/);
  });
  test('stdout and stderr merge in time order', () => {
    const m = d.mergeLogs('2026-10-20T16:00:00.000000001Z a\n2026-10-20T16:00:02.000000000Z c\n', '2026-10-20T16:00:01.500000000Z b\n');
    assert.deepEqual(m.map((l) => [l.text, l.stream]), [['a', 'stdout'], ['b', 'stderr'], ['c', 'stdout']]);
  });
});

describe('argv for exec and run', () => {
  test('an array of strings, bounded; a shell string is refused', () => {
    assert.deepEqual(d.assertArgv(['ls', '-la']), ['ls', '-la']);
    assert.throws(() => d.assertArgv('rm -rf /'), /^Error: refused: argv must be an array of strings; a shell string is never taken/);
    assert.throws(() => d.assertArgv(['ls', 1]), /array of strings/);
    assert.throws(() => d.assertArgv([]), /must not be empty/);
    assert.throws(() => d.assertArgv(undefined), /argv is required/);
    assert.deepEqual(d.assertArgv(undefined, { required: false }), []);
    assert.throws(() => d.assertArgv(Array(65).fill('x')), /more than 64/);
    assert.throws(() => d.assertArgv(['a\0b']), /NUL/);
    assert.throws(() => d.assertArgv(['x'.repeat(16_385)]), /longer than 16 KB/);
  });
});

// ---------------------------------------------------------------- a fake host: docker and git answer from tables
const IMG = (id, created, labels) => JSON.stringify({ id, created, tags: [], labels });
/**
 * Install fakes: docker answers from containers/images, git from repos (by toplevel), the file system from paths. env
 * is the settings (DROVER_*) on top of a bare environment, so the one the tests run in never leaks in.
 */
function fakeHost({ raws = RAW, images = [], repos = {}, paths = {}, docker = {}, ps, env = {} } = {}) {
  const calls = [];
  const repoOf = (dir) => Object.keys(repos).sort((a, b) => b.length - a.length).find((t) => dir === t || dir.startsWith(`${t}/`));
  d._deps.env = () => ({ HOME: '/home/dev', DROVER_DOCKER: DOCKER, PATH: '', ...env });
  d._deps.host = () => 'testbox';
  d._deps.exists = (p) => (p in paths ? Boolean(paths[p]) : p === DOCKER);
  d._deps.stat = (p) => (p === DOCKER ? statSync(DOCKER) : paths[p] === 'dir' ? { isDirectory: () => true, isFile: () => false } : paths[p] === 'file' ? { isDirectory: () => false, isFile: () => true } : null);
  d._deps.run = async (file, argv, opts) => {
    calls.push({ file, argv, opts });
    const ok = (stdout = '', extra = {}) => ({ code: 0, signal: null, stdout, stderr: '', truncated: false, timedOut: false, ...extra });
    if (file === 'git') {
      const a = argv.slice(argv.indexOf('-C') + 2), dir = argv[argv.indexOf('-C') + 1], top = repoOf(dir), r = repos[top];
      if (!r) return { code: 128, stdout: '', stderr: `fatal: not a git repository: ${dir}`, timedOut: false };
      if (a[0] === 'rev-parse') return ok(`${top}\n${r.gitDir ?? `${top}/.git`}\n${r.common ?? `${top}/.git`}\n`);
      if (a[0] === 'status') return ok(r.status);
      if (a[0] === 'log') return ok(`${r.head}\0${r.ct}\0${r.subject}\n`);
      if (a[0] === 'rev-list') { const v = r.counts?.[a[3]]; return v ? ok(`${v}\n`) : { code: 128, stdout: '', stderr: 'bad revision', timedOut: false }; }
      return { code: 1, stdout: '', stderr: 'unexpected git', timedOut: false };
    }
    assert.equal(file, DOCKER, 'docker runs as the CLI that was found');
    const [cmd, ...rest] = argv;
    if (docker[cmd]) { const r = docker[cmd](rest); if (r) return { ...ok(), ...r }; }
    if (cmd === 'ps' && rest[0] === '-aq') {
      if (ps) return ps;
      const f = rest.indexOf('--filter'), proj = f >= 0 ? rest[f + 1].split('=').at(-1) : null;
      return ok(raws.filter((r) => !proj || r.labels['com.docker.compose.project'] === proj).map((r) => r.id).join('\n') + '\n');
    }
    if (cmd === 'ps' && rest[0] === '-a') return ok([...new Set(raws.map((r) => r.labels['com.docker.compose.project']).filter(Boolean))].join('\n') + '\n');
    if (cmd === 'container' && rest[0] === 'inspect') { const ids = new Set(rest.slice(3)); return ok(raws.filter((r) => ids.has(r.id)).map((r) => JSON.stringify(r)).join('\n') + '\n'); }
    if (cmd === 'image' && rest[0] === 'inspect' && rest[2] === d.IMAGE_FORMAT) return ok(images.join('\n') + '\n');
    if (cmd === 'image' && rest[0] === 'inspect') return ok('sha256:x\n');
    if (cmd === 'version') return ok('29.8.1\n');
    return ok();
  };
  return calls;
}
const restore = () => { Object.assign(d._deps, real); d._reset(); };

describe('docker.stacks on a fake host', () => {
  beforeEach(() => { restore(); });
  after(restore);
  const status = (branch, extra = [], head = '1'.repeat(40)) => [`# branch.oid ${head}`, `# branch.head ${branch}`, ...extra, ''].join('\0');
  const WT_HEAD = 'b7c3d91e2f'.padEnd(40, '7');

  test('the code line: main checkout ahead/behind the configured base, a worktree in detached HEAD with two commit labels, stale images', async () => {
    const appImg = byName('web-app-reports').imageId, uiImg = byName('review-web-ui').imageId;
    fakeHost({
      env: { DROVER_DOCKER_BASE: 'origin/main' },
      images: [IMG(appImg, '2026-10-19T17:58:10Z', { 'com.docker.compose.project': 'webapp' }), IMG(uiImg, '2026-10-13T20:00:34Z', { 'com.docker.compose.project': 'webapp-review' })],
      repos: {
        '/home/dev/src/webapp': { status: status('report-fixes', ['? x']), head: '1'.repeat(40), ct: String(Date.parse('2026-10-20T15:27:00Z') / 1000), subject: 'test(reports): speed up', counts: { 'HEAD...origin/main': '12\t51', 'HEAD...origin/HEAD': '99\t99' } },
        '/srv/webapp-review': { gitDir: '/home/dev/src/webapp/.git/worktrees/webapp-review', common: '/home/dev/src/webapp/.git', status: [`# branch.oid ${WT_HEAD}`, '# branch.head (detached)', ''].join('\0'), head: WT_HEAD, ct: '1791923259', subject: 'fix(notify): the review reason', counts: { 'HEAD...origin/main': '2\t220', '5d0c9e7b21...HEAD': '0\t1', '8e4f3a6c90...HEAD': '1\t88' } },
      },
      paths: { '/home/dev/src/webapp': 'dir', '/home/dev/src/webapp/src': 'dir', '/home/dev/src/webapp/.env': 'file', '/srv/webapp-review': 'dir', '/srv/webapp-review/src': 'dir', '/home/dev/src/webapp/compose.yml': 'file', '/home/dev/src/webapp/compose.override.yml': 'file' },
    });
    const r = await d.stacks({});
    assert.deepEqual(r.docker, { available: true, bin: DOCKER, version: '29.8.1' });
    assert.equal(r.totals.containers, RAW.length);
    const web = r.stacks.find((s) => s.project === 'webapp');
    assert.deepEqual(web.configFiles.map((f) => f.exists), [true, true]);
    assert.deepEqual({ ...web.code.dir.git, committedAt: undefined }, { toplevel: '/home/dev/src/webapp', worktree: false, mainRepo: null, branch: 'report-fixes', detached: false, head: '1'.repeat(40), short: '1111111111', subject: 'test(reports): speed up', committedAt: undefined, dirty: { changed: 0, untracked: 1 }, upstream: null, ahead: 12, behind: 51, against: 'origin/main' });
    assert.ok(web.code.fromTree >= 1, 'services that bind-mount src run from the work tree');
    assert.equal(web.code.images.stale, 1);
    const n = r.stacks.find((s) => s.project === 'webapp-review');
    assert.equal(n.code.dir.git.worktree, true); assert.equal(n.code.dir.git.mainRepo, '/home/dev/src/webapp'); assert.equal(n.code.dir.git.detached, true);
    assert.deepEqual(n.code.commitLabel, { key: 'drover.commit', head: 'b7c3d91e2f', matches: false, values: [{ value: '5d0c9e7b21', services: 6, matches: false, behind: 0, ahead: 1 }, { value: '8e4f3a6c90', services: 2, matches: false, behind: 1, ahead: 88 }] });
    assert.match(n.code.notes.join('\n'), /drover\.commit 5d0c9e7b21 \(6 services; HEAD is 1 commit after it\) and 8e4f3a6c90 \(2 services; HEAD is 88 commits after it, and 1 of its commits is not in HEAD\) but the source is at b7c3d91e2f: image and source disagree/);
  });

  test('ahead/behind without an upstream: DROVER_DOCKER_BASE where the repo has it, else origin/HEAD; an upstream always wins', async () => {
    const head = '1'.repeat(40), raws = [{ ...byName('drover-selftest-web-1'), mounts: [] }], paths = { '/home/dev/drover-selftest': 'dir' };
    const repo = (extra, counts) => ({ '/home/dev/drover-selftest': { status: status('main', extra, head), head, ct: '1792000000', subject: 's', counts } });
    const ab = async (opts) => { restore(); fakeHost({ raws, paths, ...opts }); const g = (await d.stacks({})).stacks[0].code.dir.git; return [g.ahead, g.behind, g.against]; };
    const both = { 'HEAD...origin/next': '3\t4', 'HEAD...origin/HEAD': '5\t6' };
    assert.deepEqual(await ab({ repos: repo([], both) }), [5, 6, 'origin/HEAD'], 'default: the remote\'s default branch');
    assert.deepEqual(await ab({ repos: repo([], both), env: { DROVER_DOCKER_BASE: 'origin/next' } }), [3, 4, 'origin/next'], 'the configured base first');
    assert.deepEqual(await ab({ repos: repo([], { 'HEAD...origin/HEAD': '5\t6' }), env: { DROVER_DOCKER_BASE: 'origin/next' } }), [5, 6, 'origin/HEAD'], 'a base the repo lacks is skipped');
    assert.deepEqual(await ab({ repos: repo(['# branch.upstream origin/topic', '# branch.ab +7 -8'], both), env: { DROVER_DOCKER_BASE: 'origin/next' } }), [7, 8, 'origin/topic'], 'the upstream wins');
    assert.deepEqual(await ab({ repos: repo([], {}) }), [null, null, null], 'nothing to count against');
  });

  test('replicas of one service that disagree on the commit label are all seen, so HEAD on one does not hide an old one', async () => {
    const head = '1'.repeat(40), base = byName('drover-selftest-web-1');
    const replica = (n, commit) => ({ ...base, id: String(n).repeat(64).slice(0, 64), name: `/drover-selftest-web-${n}`, labels: { ...base.labels, 'com.docker.compose.container-number': String(n), 'drover.commit': commit }, mounts: [] });
    fakeHost({
      raws: [replica(1, '1111111111'), replica(2, '2222222222')],
      repos: { '/home/dev/drover-selftest': { status: status('main', [], head), head, ct: '1792000000', subject: 's', counts: { '2222222222...HEAD': '0\t3' } } },
      paths: { '/home/dev/drover-selftest': 'dir' },
    });
    const [s] = (await d.stacks({})).stacks;
    assert.equal(s.services[0].count, 2);
    assert.equal(s.code.commitLabel.matches, false);
    assert.deepEqual(s.code.commitLabel.values.map((v) => [v.value, v.services, v.matches]), [['1111111111', 1, true], ['2222222222', 1, false]]);
  });
  test('the commit label is the one under the configured prefix', async () => {
    const head = '1'.repeat(40), base = byName('drover-selftest-web-1');
    const raws = [{ ...base, labels: { ...base.labels, 'com.example.commit': '2222222222' }, mounts: [] }];
    const repos = { '/home/dev/drover-selftest': { status: status('main', [], head), head, ct: '1792000000', subject: 's', counts: { '2222222222...HEAD': '0\t3' } } };
    fakeHost({ raws, repos, paths: { '/home/dev/drover-selftest': 'dir' }, env: { DROVER_DOCKER_LABEL_PREFIX: 'com.example' } });
    const [s] = (await d.stacks({})).stacks;
    assert.deepEqual(s.labels, { 'com.example.commit': '2222222222' }, 'drover.* labels are not read under another prefix');
    assert.equal(s.code.commitLabel.key, 'com.example.commit');
    assert.match(s.code.notes.join('\n'), /containers carry com\.example\.commit 2222222222 \(1 service; HEAD is 3 commits after it\)/);
  });
  test('a working dir that is no repo takes its code from the bind mounts (a generated runtime dir)', async () => {
    const base = byName('drover-selftest-web-1');
    const raws = [{ ...base, labels: { ...base.labels, 'com.docker.compose.project': 'webapp-check', 'com.docker.compose.project.working_dir': '/srv/check-runtime', 'drover.commit': undefined }, mounts: [{ Type: 'bind', Source: '/srv/check-source/src', Destination: '/app/src', RW: true }, { Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock', RW: true }] }];
    raws[0].labels = Object.fromEntries(Object.entries(raws[0].labels).filter(([, v]) => v !== undefined));
    const calls = fakeHost({
      raws,
      repos: { '/srv/check-source': { status: status('live-check', [], '3a7e9c1b5d'.padEnd(40, '0')), head: '3a7e9c1b5d'.padEnd(40, '0'), ct: '1792000000', subject: 'feat: verify', counts: { 'HEAD...origin/HEAD': '5\t9' } } },
      paths: { '/srv/check-runtime': 'dir', '/srv/check-source/src': 'dir', '/var/run/docker.sock': 'file' },
    });
    const [s] = (await d.stacks({})).stacks;
    assert.equal(s.code.dir.git, null);
    assert.deepEqual(s.code.sources.map((x) => [x.toplevel, x.branch, x.services, x.fromTree, x.against]), [['/srv/check-source', 'live-check', 1, 1, 'origin/HEAD']]);
    assert.equal(s.code.source.short, '3a7e9c1b5d');
    assert.match(s.code.notes[0], /working dir is not a git repo; the code comes from bind mounts of \/srv\/check-source/);
    assert.ok(!calls.some((c) => c.file === 'git' && c.argv.includes('/var/run')), 'the docker socket is never treated as source');
  });

  test('git: false skips the code line; a project filter asks docker for that project only', async () => {
    const calls = fakeHost();
    const r = await d.stacks({ project: 'drover-selftest', git: false });
    assert.deepEqual(r.stacks.map((s) => s.project), ['drover-selftest']);
    assert.equal(r.stacks[0].code, undefined);
    assert.ok(!calls.some((c) => c.file === 'git' || c.argv[0] === 'image'));
    assert.deepEqual(calls[0].argv, ['ps', '-aq', '--no-trunc', '--filter', 'label=com.docker.compose.project=drover-selftest']);
    await assert.rejects(d.stacks({ project: 'Bad Name' }), /^Error: refused: "Bad Name" is not a compose project name/);
  });
  test('kinds come from the settings of the host that reads', async () => {
    fakeHost({ env: { DROVER_DOCKER_KINDS: KINDS } });
    const sorted = (await d.stacks({ git: false })).stacks.find((s) => s.project === 'webapp');
    assert.equal(sorted.kinds.app.label, 'apps');
    restore(); fakeHost();
    assert.equal((await d.stacks({ git: false })).stacks.find((s) => s.project === 'webapp').kinds, null);
  });

  test('no daemon, no CLI: available false with the reason, never an error', async () => {
    fakeHost({ ps: { code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon at unix:///Users/me/.docker/run/docker.sock. Is the docker daemon running?\n', timedOut: false } });
    const r = await d.stacks({});
    assert.equal(r.docker.available, false); assert.match(r.docker.reason, /no docker daemon is answering/);
    assert.deepEqual(r.stacks, []); assert.equal(r.totals.containers, 0);
    restore();
    d._deps.env = () => ({ HOME: TMP, PATH: TMP + '/none' }); d._deps.loginPath = async () => '/nonexistent';
    const missing = path.join(TMP, 'nothing');
    d._deps.env = () => ({ HOME: TMP, PATH: missing, DROVER_DOCKER: undefined });
    const real = d._deps.stat; d._deps.stat = (p) => (p.startsWith('/') && !p.startsWith(TMP) ? null : real(p));
    const r2 = await d.stacks({});
    assert.equal(r2.docker.available, false); assert.match(r2.docker.reason, /no docker CLI on PATH, on a login shell's PATH or in the usual install dirs/);
  });

  test('image metadata is read once per image id for the life of the process', async () => {
    const img = byName('web-app-reports').imageId;
    const calls = fakeHost({ images: [IMG(img, '2026-10-19T17:58:10Z', { 'com.docker.compose.project': 'webapp' })], repos: {}, paths: {} });
    await d.stacks({}); await d.stacks({});
    const reads = calls.filter((c) => c.argv[0] === 'image' && c.argv[3] === d.IMAGE_FORMAT);
    assert.equal(reads.length, 1, 'the second read asks for no image');
  });
});

describe('a host that runs no Drover, read through its provider\'s exec', () => {
  beforeEach(() => { restore(); d._deps.env = () => ({}); });
  after(restore);
  const review = RAW.filter((r) => r.labels['com.docker.compose.project'] === 'webapp-review');
  const HEAD = 'b7c3d91e2f4a6c8e0d1b3f5a7c9e1d3b5f7a9c0e';
  const gitLine = ['__DROVER_GIT__', '/srv/webapp-review', '/srv/webapp-review', '', HEAD, '1791923259', '2'].join('\t');
  /** An exec as a host provider hands remoteStacks: records each argv, answers stdout (or stdout(argv)) with code. */
  const fakeExec = (stdout, code = 0) => {
    const calls = [];
    return { calls, exec: async (argv, opts) => { calls.push({ argv, opts }); return { code, stdout: typeof stdout === 'function' ? stdout(argv) : stdout }; } };
  };

  test('the script runs through the exec as an argv; stacks, health and a lighter code line come back, read only', async () => {
    const { calls, exec } = fakeExec(['__DROVER_DOCKER_VERSION__\t29.6.1', ...review.map((r) => JSON.stringify(r)), gitLine, ''].join('\n'));
    const r = await d.remoteStacks(exec, { host: 'dev:ws1', via: 'test transport' });
    assert.deepEqual(calls[0].argv.slice(0, 2), ['sh', '-c']); assert.equal(calls[0].argv[2], d.remoteScript('drover')); assert.deepEqual(calls[0].argv.slice(3), ['sh', '', 'git']);
    assert.equal(calls[0].opts.timeoutMs, 90_000);
    assert.equal(r.host, 'dev:ws1'); assert.equal(r.via, 'test transport'); assert.equal(r.readOnly, true);
    assert.deepEqual(r.docker, { available: true, version: '29.6.1' });
    const [s] = r.stacks;
    assert.equal(s.project, 'webapp-review'); assert.equal(s.counts.total, 8);
    assert.deepEqual({ ...s.code.dir.git }, { toplevel: '/srv/webapp-review', branch: null, detached: true, head: HEAD, short: 'b7c3d91e2f', committedAt: '2026-10-13T20:27:39.000Z', dirty: { changed: 2, untracked: null } });
    assert.equal(s.code.commitLabel.key, 'drover.commit');
    assert.deepEqual(s.code.commitLabel.values.map((v) => [v.value, v.matches]).sort(), [['5d0c9e7b21', false], ['8e4f3a6c90', false]]);
    assert.match(s.code.notes[0], /^read through test transport: this host runs no Drover/);
  });
  test('the reading host\'s settings apply: its label prefix in the script, its kinds on the stacks', async () => {
    d._deps.env = () => ({ DROVER_DOCKER_LABEL_PREFIX: 'com.example', DROVER_DOCKER_KINDS: KINDS });
    const { calls, exec } = fakeExec([...review.map((r) => JSON.stringify(r)), ''].join('\n'));
    const r = await d.remoteStacks(exec, { host: 'dev:ws1' });
    assert.equal(calls[0].argv[2], d.remoteScript('com.example'));
    assert.equal(r.via, 'its host provider', 'the default name of the transport');
    const [s] = r.stacks;
    assert.deepEqual(Object.keys(s.labels), ['com.example.logs', 'com.example.checks']);
    assert.equal(s.kinds.app.total, 2);
    assert.equal(s.code.commitLabel, null, 'no container carries com.example.commit');
  });
  test('the script itself: one JSON object per line from the same template, escapes printf reads, no expansion of ours', () => {
    const lines = d.remoteScript('drover').split('\n');
    assert.equal(lines.length, 10);
    assert.equal(lines[0], 'p=$1; g=$2');
    assert.ok(lines[1].startsWith("T='{\"id\":{{json .ID}}"), 'the cut-down template, single-quoted');
    assert.ok(lines.every((l) => !l.includes('\t')), 'printf gets \\t, not a tab');
    assert.match(lines[3], /^printf '__DROVER_DOCKER_VERSION__\\t%s\\n' "\$v"$/);
    assert.throws(() => d.remoteScript("x'; id; '"), /is not a label prefix/);
  });
  test('project and git reach the host as $1 and $2; compose files are checked on its disk; git: false skips the code line', async () => {
    const files = [['__DROVER_FILE__', '/srv/webapp-review/compose.yml', '1'].join('\t'), ['__DROVER_FILE__', '/srv/webapp-review/stack/override.yml', '0'].join('\t')];
    const { calls, exec } = fakeExec([...review.map((r) => JSON.stringify(r)), ...files, ''].join('\n'));
    const r = await d.remoteStacks(exec, { host: 'dev:ws1' }, { project: 'webapp-review', git: false });
    assert.deepEqual(calls[0].argv.slice(3), ['sh', 'webapp-review', 'nogit']);
    const [s] = r.stacks;
    assert.equal(s.code, undefined);
    assert.deepEqual(s.configFiles.map((f) => f.exists), [true, false], 'from that host, not from this one (where neither exists)');
    await d.remoteStacks(exec, { host: 'dev:ws1' });
    assert.deepEqual(calls[1].argv.slice(3), ['sh', '', 'git']);
    await assert.rejects(d.remoteStacks(exec, { host: 'dev:ws1' }, { project: '$(id)' }), /is not a compose project name/);
    assert.equal(calls.length, 2, 'a bad project never reaches the host');
  });
  test('what leaves the host is cut down there: compose labels and the prefix\'s only, the last health check cut short, no mounts', () => {
    const f = d.remoteInspectFormat('drover');
    assert.ok(!f.includes('{{json .Config.Labels}}') && !f.includes('{{json .Mounts}}') && !f.includes('{{json .State.Health}}'));
    assert.ok(f.includes('{{else if ge (len $k) 7}}{{if eq (slice $k 0 7) "drover."}}'), 'a key is under the prefix by its first characters, tested only when it is long enough');
    assert.ok(d.remoteInspectFormat('com.example').includes('{{if eq (slice $k 0 12) "com.example."}}'));
    assert.match(f, /\(eq \$k "com\.docker\.compose\.project"\)/);
    assert.match(f, /truncate \$l\.Output 240/);
    assert.ok(d.remoteScript('drover').includes(`T='${f.replace(/'/g, "'\\''")}'`), 'the script uses it');
  });
  test('no daemon on that host is an answer; a transport failure with no output is an error', async () => {
    const r = await d.remoteStacks(fakeExec('__DROVER_NO_DOCKER__\tCannot connect to the Docker daemon at unix:///var/run/docker.sock\n').exec, { host: 'dev:ws', via: 'test transport' });
    assert.deepEqual(r.docker, { available: false, reason: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock' });
    assert.equal(r.readOnly, true);
    await assert.rejects(d.remoteStacks(fakeExec('ssh: connect to host failed', 255).exec, { host: 'dev:ws', via: 'test transport' }), /^Error: docker on dev:ws did not answer through test transport \(exit 255\): ssh: connect to host failed/);
  });
});

describe('guarded verbs on a fake host', () => {
  beforeEach(() => { restore(); });
  after(restore);
  const ids = (n) => RAW.filter((r) => r.labels['com.docker.compose.project'] === 'drover-selftest' && r.labels['com.docker.compose.service'] === n).map((r) => r.id);
  const paths = { '/home/dev/drover-selftest': 'dir', '/home/dev/drover-selftest/compose.yml': 'file' };

  test('a project or service discovery did not find is refused, naming what is there', async () => {
    fakeHost();
    await assert.rejects(d.restart({ project: 'nope', services: ['web'] }), (e) => e.refused && /^refused: no compose project nope on testbox \(projects here: drover-selftest, webapp, webapp-review\)/.test(e.message));
    await assert.rejects(d.restart({ project: 'drover-selftest', services: ['web', 'ghost'] }), /^Error: refused: drover-selftest has no service ghost \(services: job-fail, job-ok, plain, sick, web\)/);
    await assert.rejects(d.restart({ project: '../etc', services: ['web'] }), /is not a compose project name/);
    await assert.rejects(d.restart({ project: 'drover-selftest', services: ['--all'] }), /needs services: a list of compose service names/);
    await assert.rejects(d.exec({ project: 'drover-selftest', service: ['web', 'sick'], argv: ['true'] }), /needs service: one compose service name/);
  });
  test('arguments a verb does not take are refused: no user, privileged mode, env, entrypoint or host path', async () => {
    fakeHost();
    for (const extra of [{ user: 'root' }, { privileged: true }, { env: ['A=1'] }, { entrypoint: 'sh' }, { volumes: ['/:/host'] }, { workdir: '/' }]) {
      await assert.rejects(d.exec({ project: 'drover-selftest', service: 'web', argv: ['id'], ...extra }), (e) => e.refused && /docker ops never take a user, privileged mode, environment, entrypoint, working dir, volume or host path from the caller/.test(e.message), JSON.stringify(extra));
    }
    await assert.rejects(d.restart({ project: 'drover-selftest', services: ['web'], signal: 'KILL' }), /does not take signal/);
  });
  test('restart: docker restart of the service containers, states before and after', async () => {
    const calls = fakeHost();
    const r = await d.restart({ project: 'drover-selftest', services: ['web', 'sick'], actor: 'mcp' });
    const call = calls.find((c) => c.argv[0] === 'restart');
    assert.deepEqual(call.argv, ['restart', '--timeout', '10', ...ids('web'), ...ids('sick')]);
    assert.equal(r.ok, true); assert.equal(r.verb, 'restart'); assert.equal(r.count, 2); assert.equal(r.exitCode, 0);
    assert.deepEqual(r.containers.map((c) => [c.service, c.before, c.after]), [['web', 'healthy', 'healthy'], ['sick', 'unhealthy', 'unhealthy']]);
  });
  test('start: only exited or created containers; a running service is refused', async () => {
    const calls = fakeHost();
    await assert.rejects(d.start({ project: 'drover-selftest', services: ['web'] }), /^Error: refused: nothing to start in web \(healthy\): start only starts exited or created containers; restart a running one/);
    const r = await d.start({ project: 'drover-selftest', services: ['job-fail'] });
    assert.deepEqual(calls.find((c) => c.argv[0] === 'start').argv, ['start', ...ids('job-fail')]);
    assert.equal(r.containers[0].before, 'failed');
  });
  test('exec: docker exec <container> <argv> with nothing in between; not running is refused; output redacted', async () => {
    const tok = ['sk', 'ant', 'api03', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6'].join('-');
    const calls = fakeHost({ docker: { exec: () => ({ stdout: `TOKEN=${tok}\nok\n`, stderr: '', code: 0 }) } });
    const r = await d.exec({ project: 'drover-selftest', service: 'web', argv: ['sh', '-c', 'env | grep TOKEN'], actor: 'mcp' });
    assert.deepEqual(calls.find((c) => c.argv[0] === 'exec').argv, ['exec', ids('web')[0], 'sh', '-c', 'env | grep TOKEN']);
    assert.equal(calls.find((c) => c.argv[0] === 'exec').opts.timeoutMs, 30_000);
    assert.equal(r.exitCode, 0); assert.ok(!r.stdout.includes(tok)); assert.match(r.stdout, /TOKEN=\[redacted\]\nok/);
    await assert.rejects(d.exec({ project: 'drover-selftest', service: 'job-ok', argv: ['true'] }), /^Error: refused: job-ok is not running \(completed, exit 0\): exec needs a running container/);
    await assert.rejects(d.exec({ project: 'drover-selftest', service: 'web', argv: 'id' }), /a shell string is never taken/);
  });
  test('exec: a timeout says the command may still be running in the container', async () => {
    const calls = fakeHost({ docker: { exec: () => ({ code: null, signal: 'SIGKILL', timedOut: true }) } });
    const r = await d.exec({ project: 'drover-selftest', service: 'web', argv: ['sleep', '600'], timeoutMs: 999_999 });
    assert.equal(calls.find((c) => c.argv[0] === 'exec').opts.timeoutMs, 110_000, 'clamped under the host timeout');
    assert.equal(r.ok, false); assert.equal(r.timedOut, true); assert.equal(r.exitCode, null);
    assert.match(r.note, /may still be running inside the container/);
  });
  const conf = (service) => ({ compose: (a) => (a.includes('config') ? { stdout: JSON.stringify({ services: { [a.at(-1)]: service } }) } : null) });
  test('run: compose run --rm -T --no-deps --pull never with the project files; refused without them or without the image', async () => {
    let calls = fakeHost({ paths, docker: conf({ image: 'alpine:3' }) });
    const r = await d.runJob({ project: 'drover-selftest', service: 'job-ok', argv: ['echo', 'again'] });
    const call = calls.find((c) => c.argv[0] === 'compose' && c.argv.includes('run'));
    assert.deepEqual(call.argv, ['compose', '-p', 'drover-selftest', '--project-directory', '/home/dev/drover-selftest', '-f', '/home/dev/drover-selftest/compose.yml', 'run', '--rm', '-T', '--no-deps', '--pull', 'never', '--', 'job-ok', 'echo', 'again']);
    assert.equal(r.ok, true); assert.equal(r.verb, 'run');
    restore(); fakeHost({ paths: { '/home/dev/drover-selftest': 'dir' } });
    await assert.rejects(d.runJob({ project: 'drover-selftest', service: 'job-ok' }), /compose files are not all on disk \(missing: \/home\/dev\/drover-selftest\/compose\.yml\): run needs them/);
    restore(); calls = fakeHost({ paths, docker: { ...conf({ image: 'alpine:3' }), image: (a) => (a[2] === '{{.ID}}' ? { code: 1, stdout: '', stderr: 'No such image' } : null) } });
    await assert.rejects(d.runJob({ project: 'drover-selftest', service: 'job-ok' }), /image alpine:3 \(from its compose files as they are now\) is not on testbox; run never builds or pulls one/);
    assert.ok(!calls.some((c) => c.argv[0] === 'compose' && c.argv.includes('run')));
  });
  test('run: the image is the one the compose files name now, not the old container\'s, so nothing missing gets built', async () => {
    // The container was made from alpine:3, but the checkout moved the service to an image with a build section that
    // does not exist yet: compose run would build it. The old check passed because alpine:3 is on the host.
    const have = new Set(['alpine:3']);
    const imageCheck = { image: (a) => (a[2] === '{{.ID}}' ? (have.has(a[3]) ? { stdout: 'sha256:x\n' } : { code: 1, stdout: '', stderr: 'No such image' }) : null) };
    let calls = fakeHost({ paths, docker: { ...conf({ image: 'selftest-job:next', build: { context: '.' } }), ...imageCheck } });
    await assert.rejects(d.runJob({ project: 'drover-selftest', service: 'job-ok' }), /image selftest-job:next \(from its compose files as they are now\) is not on testbox/);
    assert.ok(!calls.some((c) => c.argv.includes('run')));
    const cfg = calls.find((c) => c.argv.includes('config')).argv;
    assert.deepEqual(cfg.slice(-5), ['config', '--format', 'json', '--no-env-resolution', 'job-ok']);
    restore(); calls = fakeHost({ paths, docker: { ...conf({ build: { context: '.' } }), ...imageCheck } });
    await assert.rejects(d.runJob({ project: 'drover-selftest', service: 'job-ok' }), /image drover-selftest-job-ok \(from its compose files/, 'no image: compose names it <project>-<service>');
    restore(); calls = fakeHost({ paths, docker: { compose: (a) => (a.includes('config') ? { code: 15, stdout: '', stderr: 'no such service: job-ok' } : null) } });
    await assert.rejects(d.runJob({ project: 'drover-selftest', service: 'job-ok' }), /job-ok could not be read from drover-selftest's compose files: no such service: job-ok/);
  });
  test('logs: --timestamps --tail of one container, merged, stamps dropped unless asked, escapes stripped', async () => {
    const calls = fakeHost({ docker: { logs: () => ({ stdout: '2026-10-20T16:00:00.000000001Z \x1b[32mready\x1b[0m\n2026-10-20T16:00:02.000000000Z served\n', stderr: '2026-10-20T16:00:01.000000000Z warn\n', code: 0 }) } });
    const r = await d.logs({ project: 'drover-selftest', service: 'web', tail: 50, since: '10m' });
    assert.deepEqual(calls.find((c) => c.argv[0] === 'logs').argv, ['logs', '--timestamps', '--tail', '50', '--since', '10m', ids('web')[0]]);
    assert.equal(r.text, 'ready\nwarn\nserved'); assert.equal(r.lines, 3); assert.equal(r.stderrLines, 1);
    const r2 = await d.logs({ project: 'drover-selftest', service: 'web', timestamps: true, tail: 99_999 });
    assert.match(r2.text, /^2026-10-20T16:00:00.000000001Z ready/);
    assert.equal(calls.filter((c) => c.argv[0] === 'logs').at(-1).argv[3], '2000', 'tail is capped');
    await assert.rejects(d.logs({ project: 'drover-selftest', service: 'web', since: '$(id)' }), /since must be a duration/);
    assert.equal(calls.filter((c) => c.argv[0] === 'logs').at(-1).opts.tail, true, 'logs keep the newest output past the cap');
    restore(); fakeHost({ docker: { logs: () => ({ stdout: 'cut-off middle of a line\n2026-10-20T16:00:05.000000000Z newest\n', stderr: '', code: 0, truncated: true }) } });
    assert.equal((await d.logs({ project: 'drover-selftest', service: 'web' })).text, 'newest', 'a cut stream loses the part line it starts with');
  });
});
