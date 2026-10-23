// `drover stacks` text (core/docker-format.js) from stacks (the docker fixture through buildStacks), one host and
// the fleet shape: verdicts, counts, kinds, failing services with why, the code line, hosts that did not answer.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseInspect, buildStacks, totalsOf, dockerConfig } from '../core/docker.js';
import { formatStacks } from '../core/docker-format.js';

// The default label prefix and the kinds the docker tests use (DROVER_DOCKER_KINDS), whatever the environment says.
const config = dockerConfig({ DROVER_DOCKER_KINDS: JSON.stringify([{ kind: 'app', match: '^web-app-', label: 'apps' }, { kind: 'ml', match: '^web-ml-', label: 'ML' }, { kind: 'core', match: '^web-' }]) });
const stacks = buildStacks(parseInspect(readFileSync(new URL('./fixtures/docker-inspect.jsonl', import.meta.url), 'utf8'), { config }).containers, { config });
const get = (p) => stacks.find((s) => s.project === p);
const git = { toplevel: '/home/dev/src/webapp', worktree: false, branch: 'report-fixes', detached: false, short: 'fabd88b036', subject: 'test(reports): speed up', dirty: { changed: 0, untracked: 1 }, ahead: 12, behind: 51, against: 'origin/main' };
get('webapp').code = { dir: { path: '/home/dev/src/webapp', exists: true, git }, sources: [], notes: ['1 built image predates HEAD fabd88b036 without mounting the source (webapp-web-ml-ranker): likely stale, rebuild to run HEAD'] };
get('webapp-review').code = { dir: { path: '/srv/webapp-review', exists: true, git: { ...git, toplevel: '/srv/webapp-review', worktree: true, mainRepo: '/home/dev/src/webapp', detached: true, branch: null, short: 'b7c3d91e2f', dirty: { changed: 0, untracked: 0 }, ahead: 2, behind: 220 } }, sources: [], notes: [] };
const host = { host: 'box-a', docker: { available: true, version: '29.8.1' }, totals: totalsOf(stacks), stacks, notes: [] };

describe('formatStacks', () => {
  test('one host: verdicts, counts, kinds, failing with why, code lines, loose containers summed up', () => {
    const t = formatStacks(host);
    assert.match(t, /^box-a {2}docker 29\.8\.1 {2}3 stacks, 24 containers, 4 failing$/m);
    assert.match(t, /^ {2}● webapp {2}degraded {2}7 running: 4 healthy, 2 up \(no check\), 1 unhealthy; 3 completed$/m);
    assert.match(t, /^ {6}apps 1\/2 · ML 1\/1 · core 3\/3 · infra 4\/4$/m, 'a kind\'s label, else its name');
    assert.match(t, /^ {6}✗ web-app-reports unhealthy: health: Connecting to localhost:3930/m);
    assert.match(t, /^ {6}code ~\/src\/webapp {2}report-fixes @ fabd88b036 {2}"test\(reports\): speed up" {2}0 changed, 1 untracked {2}\+12\/-51 vs origin\/main$/m);
    assert.match(t, /^ {6}code \/srv\/webapp-review {2}\(worktree of ~\/src\/webapp\) {2}detached @ b7c3d91e2f/m);
    assert.match(t, /^ {2}outside compose: 1 failed \(failing: queue-replay-check\)$/m);
    assert.ok(!/^ {2}● drover-selftest.*\n {6}(apps|infra)/m.test(t), 'no kinds line for a stack no rule matches');
    assert.ok(!/\x1b\[/.test(t), 'no color unless asked');
    assert.match(formatStacks(host, { loose: true }), /^ {6}1 container carries compose labels from its image/m);
    assert.match(formatStacks(host, { color: true }), /\x1b\[33mdegraded\x1b\[0m/);
  });
  test('the fleet: a host without docker, one that did not answer, and the hosts not reached', () => {
    const t = formatStacks({ hosts: [host, { host: 'laptop', ok: true, docker: { available: false, reason: 'no docker daemon is answering: Cannot connect' }, stacks: [] }, { host: 'oldbox', ok: false, error: 'oldbox runs Drover code from before docker stacks' }],
      coverage: { notCovered: [{ host: 'oldbox', reason: 'x' }, { host: 'box-c', reason: 'down at the last probe' }], partial: [] } });
    assert.match(t, /^laptop {2}docker unavailable: no docker daemon is answering/m);
    assert.match(t, /^oldbox {2}no answer: oldbox runs Drover code from before docker stacks$/m);
    assert.match(t, /^not covered: box-c \(down at the last probe\)$/m, 'a host already shown with its error is not repeated');
  });
});
