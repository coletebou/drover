// core/docker.js against the real docker CLI, skipped where docker or its daemon is not there. Read-only by default:
// docker.stacks must count what `docker ps -a` and `docker compose ls --all` count, on whatever host runs the tests
// (CI's runners included). The verbs run only when DROVER_DOCKER_SELFTEST names a disposable project of yours that is
// up on this host (drover-selftest: see docs/specs/2026-10-20-docker-stacks.md); they are never run on anything else.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const d = await import('../core/docker.js');
const found = await d.findDocker();
const sh = (argv) => { try { return execFileSync(found.bin, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 }); } catch { return null; } };
const daemon = Boolean(found.bin) && sh(['version', '--format', '{{.Server.Version}}']) !== null;
const why = !found.bin ? 'no docker CLI here' : !daemon ? 'no docker daemon answering here' : false;

/** compose ls --all as { project: containers } (its Status is "exited(3), running(80)"), or null without the compose plugin. */
function composeCounts() {
  const out = sh(['compose', 'ls', '--all', '--format', 'json']);
  if (out === null) return null;
  return Object.fromEntries(JSON.parse(out || '[]').map((p) => [p.Name, [...String(p.Status).matchAll(/\((\d+)\)/g)].reduce((n, m) => n + Number(m[1]), 0)]));
}

describe('docker.stacks on this host', { skip: why }, () => {
  test('counts what docker ps -a and docker compose ls count', async (t) => {
    // Containers come and go on a shared box: the read counts only when the ground truth is the same before and after it.
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = { ps: sh(['ps', '-aq'])?.split('\n').filter(Boolean).length, ls: composeCounts() };
      const r = await d.stacks({ git: false });
      const after = { ps: sh(['ps', '-aq'])?.split('\n').filter(Boolean).length, ls: composeCounts() };
      if (JSON.stringify(before) !== JSON.stringify(after)) continue;
      assert.equal(r.docker.available, true);
      assert.equal(r.totals.containers, before.ps, 'every container, one-off runs and loose ones included');
      if (before.ls) {
        const mine = Object.fromEntries(r.stacks.filter((s) => !s.loose).map((s) => [s.project, s.counts.total]));
        for (const [p, n] of Object.entries(before.ls)) if (n) assert.equal(mine[p], n, `${p}: docker compose ls counts ${n}`);
      }
      for (const s of r.stacks) assert.equal(s.services.reduce((n, v) => n + v.count, 0), s.counts.total, `${s.project}: every counted container is under a service`);
      return;
    }
    t.skip('the containers on this host kept changing during the read');
  });
  test('the template for a host that runs no Drover runs on this docker: every line parses, only compose labels and the prefix\'s, one health check, no mounts', () => {
    const ids = sh(['ps', '-aq', '--no-trunc'])?.split('\n').filter(Boolean) ?? [];
    if (!ids.length) return;
    const { prefix } = d.dockerConfig();
    for (const p of [...new Set([prefix, 'com.example'])]) {
      const out = sh(['container', 'inspect', '--format', d.remoteInspectFormat(p), ...ids]);
      assert.ok(out !== null, `the template (prefix ${p}) is valid for this docker`);
      const parsed = d.parseRemoteOutput(out, { config: d.dockerConfig({ DROVER_DOCKER_LABEL_PREFIX: p }) });
      assert.equal(parsed.bad, 0); assert.ok(parsed.containers.length > 0);
      for (const line of out.split('\n').filter(Boolean)) {
        const raw = JSON.parse(line);
        assert.ok(Object.keys(raw.labels).every((k) => k === '_' || k.startsWith(`${p}.`) || k.startsWith('com.docker.compose.')), Object.keys(raw.labels).join(','));
        assert.deepEqual(raw.mounts, []);
        if (raw.health) assert.ok(raw.health.Log.length <= 1 && (raw.health.Log[0]?.Output ?? '').length <= 240);
      }
    }
  });
  test('the script for a host that runs no Drover reads this docker as remoteStacks expects', async (t) => {
    // Run here through sh instead of a provider's transport, with this docker first on PATH.
    const env = { ...process.env, PATH: `${path.dirname(found.bin)}:${process.env.PATH ?? ''}` };
    const run = async (argv) => { try { return { code: 0, stdout: execFileSync(argv[0], argv.slice(1), { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000, maxBuffer: 64 << 20 }) }; } catch (e) { return { code: e.status ?? 1, stdout: String(e.stdout ?? '') }; } };
    const shape = (r) => r.stacks.map((s) => [s.project, s.counts.total, s.verdict]);
    for (let attempt = 0; attempt < 3; attempt++) {
      const local = await d.stacks({ git: false });
      const r = await d.remoteStacks(run, { host: 'this-host', via: 'sh' }, { git: false });
      if (JSON.stringify(shape(local)) !== JSON.stringify(shape(await d.stacks({ git: false })))) continue;
      assert.equal(r.docker.available, true); assert.equal(r.readOnly, true);
      assert.deepEqual(shape(r), shape(local), 'the same stacks, counts and verdicts as a read here');
      return;
    }
    t.skip('the containers on this host kept changing during the read');
  });
  test('the code line reads (git and images) without failing on this host', async () => {
    const r = await d.stacks({});
    for (const s of r.stacks.filter((x) => !x.loose)) {
      assert.ok(s.code, s.project);
      assert.ok(Array.isArray(s.code.notes));
      if (s.code.dir?.git) assert.match(s.code.dir.git.head ?? '', /^[0-9a-f]{40,64}$/);
    }
  });
});

const SELFTEST = process.env.DROVER_DOCKER_SELFTEST;
describe(`verbs on ${SELFTEST ?? 'a selftest project'}`, { skip: why || (!SELFTEST && 'DROVER_DOCKER_SELFTEST is not set (the verbs only run on a disposable project)') }, () => {
  let stack;
  before(async () => {
    stack = (await d.stacks({ project: SELFTEST })).stacks.find((s) => s.project === SELFTEST);
    assert.ok(stack, `${SELFTEST} is not up on this host`);
  });
  const running = () => stack.services.find((s) => ['healthy', 'up'].includes(s.state));
  test('exec runs an argv in a running service and reports its exit code', async () => {
    const svc = running();
    const r = await d.exec({ project: SELFTEST, service: svc.service, argv: ['sh', '-c', 'echo drover-selftest-ok; echo to-stderr >&2; exit 3'] });
    assert.equal(r.exitCode, 3); assert.equal(r.stdout, 'drover-selftest-ok\n'); assert.equal(r.stderr, 'to-stderr\n');
  });
  test('logs reads a service; restart restarts it; the next read sees it', async () => {
    const svc = running();
    const l = await d.logs({ project: SELFTEST, service: svc.service, tail: 5 });
    assert.equal(l.service, svc.service);
    const r = await d.restart({ project: SELFTEST, services: [svc.service] });
    assert.equal(r.ok, true); assert.equal(r.count, svc.count);
    const after = (await d.stacks({ project: SELFTEST, git: false })).stacks[0].services.find((s) => s.service === svc.service);
    assert.ok(['healthy', 'up', 'starting'].includes(after.state), after.state);
  });
  test('refusals: a project that is not here, a service it lacks, a running service to start, an argument no verb takes', async () => {
    await assert.rejects(d.restart({ project: `${SELFTEST}-absent`, services: ['x'] }), /^Error: refused: no compose project/);
    await assert.rejects(d.restart({ project: SELFTEST, services: ['no-such-service'] }), /has no service no-such-service/);
    await assert.rejects(d.start({ project: SELFTEST, services: [running().service] }), /nothing to start/);
    await assert.rejects(d.exec({ project: SELFTEST, service: running().service, argv: ['id'], user: 'root' }), /does not take user/);
  });
});
