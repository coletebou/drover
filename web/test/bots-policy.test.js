// What a remote bot gets back (core/bots/policy.js): no content filter, but every string that leaves is cleaned
// (secrets redacted, home paths as ~, long text cut) and results keep only the fields a bot needs.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as policy from '../core/bots/policy.js';

const HOME = process.env.HOME;

describe('core/bots/policy', () => {
  test('worktrees and sibling checkouts count as their repo; lookalikes do not', () => {
    for (const v of ['Webapp', '/Users/c/code/Webapp', '/Users/c/code/Webapp/.claude/worktrees/feat-login', 'Webapp-create-api-key']) assert.equal(policy.projectMatches('webapp', v), true, v);
    for (const v of ['webappish', '/Users/c/code/billing/.claude/worktrees/webapp', 'billing-webapp', '', null, undefined]) assert.equal(policy.projectMatches('webapp', v), false, String(v));
    assert.equal(policy.projectOf('/Users/c/code/Webapp/.claude/worktrees/x'), 'Webapp');
    assert.equal(policy.projectOf('/Users/c/code/billing'), 'billing');
    assert.equal(policy.projectOf(''), null);
  });

  test('clean() redacts secrets, shortens home paths and cuts long text', () => {
    const out = policy.clean(`token sk-abcdefghijklmnopqrstu and Bearer abc.def at ${HOME}/code/x`, 2000);
    assert.doesNotMatch(out, /sk-abcdefghijklmnopqrstu|Bearer abc\.def/);
    assert.match(out, /~\/code\/x/);
    assert.equal(policy.clean('x'.repeat(50), 10), `${'x'.repeat(10)}…`);
    assert.equal(policy.clean(undefined), undefined);
  });

  test('search hits: nothing is withheld (any project, merge request refs, any host, documents), every string cleaned', () => {
    const hits = policy.sanitizeSearchHits([
      { kind: 'claude', project: 'billing', title: 'broker', snippet: `fixed with sk-abcdefghijklmnopqrstu in ${HOME}/code/billing`, sessionId: 's2', host: 'box-b', score: 1, extra: 'dropped' },
      { kind: 'wal', project: null, title: 'note', snippet: 'review !4469 on staging' },
      { kind: 'doc', project: null, title: 'spec', snippet: 'words' },
      { kind: 'reflection', repo: 'billing', id: 'zzz', status: 'open', title: 'customer item', snippet: 'x' },
    ]);
    assert.deepEqual(hits.map((h) => h.title), ['broker', 'note', 'spec', 'customer item']);
    assert.deepEqual([hits[0].project, hits[0].host, hits[0].sessionId, hits[0].extra], ['billing', 'box-b', 's2', undefined]);
    assert.doesNotMatch(hits[0].snippet, /sk-abcdefghijklmnopqrstu/, 'secrets are still redacted');
    assert.match(hits[0].snippet, /in ~\/code\/billing/);
    assert.equal(hits[1].snippet, 'review !4469 on staging');
    assert.deepEqual([hits[3].id, hits[3].status, hits[3].project], ['zzz', 'open', 'billing']);
  });

  test('features and sessions keep their names and projects, cleaned', () => {
    const [f] = policy.sanitizeFeatures([{ fid: 'b', state: 'shipped', title: 'Billing broker', repo: 'billing', notes: `linked to !4469; key sk-abcdefghijklmnopqrstu`, links: ['!4469'] }]);
    assert.deepEqual([f.fid, f.state, f.title, f.repo, f.links], ['b', 'shipped', 'Billing broker', 'billing', ['!4469']]);
    assert.match(f.notes, /^linked to !4469/);
    assert.doesNotMatch(f.notes, /sk-abcdefghijklmnopqrstu/);
    const s = policy.sanitizeSession({ id: 'x2', engine: 'claude', status: 'idle', live: true, name: 'billing-f8', cwd: '/Users/c/code/billing', tmux: { target: 'w:1' } }, { host: 'box-b' });
    assert.deepEqual(s, { host: 'box-b', engine: 'claude', status: 'idle', live: true, id: 'x2', name: 'billing-f8', project: 'billing' });
    assert.equal(policy.sanitizeSession({ id: 'grok:alpha', engine: 'grok', status: 'busy', live: true, name: 'Alpha', summary: 'deploying' }).summary, 'deploying');
  });
});
