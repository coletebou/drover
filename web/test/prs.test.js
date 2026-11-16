// core/prs.js against a fake gh: the arguments it runs (scope, state, filters), the merge of authored and
// review-requested results, the checks summary, and the errors a missing or signed-out gh gives.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as prs from '../core/prs.js';

const { _deps } = prs;
const pr = (n, repo, extra = {}) => ({ number: n, title: `PR ${n}`, repository: { nameWithOwner: repo }, url: `https://github.com/${repo}/pull/${n}`, state: 'OPEN', isDraft: false, author: { login: 'me' }, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-10T00:00:00Z', commentsCount: 2, labels: [{ name: 'bug' }], ...extra });
let calls;
function fakeGh(answer) { calls = []; _deps.gh = () => '/fake/gh'; _deps.run = async (bin, args) => { calls.push(args); const r = await answer(args); return typeof r === 'string' ? { code: 0, out: r, err: '' } : r; }; }
beforeEach(() => fakeGh(() => '[]'));

test('both: the PRs you opened and the ones asking your review, merged by id with their roles, newest first', async () => {
  fakeGh((a) => JSON.stringify(a.includes('--author=@me') ? [pr(1, 'o/a'), pr(2, 'o/b', { updatedAt: '2026-11-12T00:00:00Z' })] : [pr(2, 'o/b', { updatedAt: '2026-11-12T00:00:00Z' }), pr(7, 'x/y', { author: { login: 'them' }, updatedAt: '2026-11-11T00:00:00Z' })]));
  const r = await prs.list({});
  assert.deepEqual(r.items.map((p) => [p.id, p.roles]), [['o/b#2', ['author', 'reviewer']], ['x/y#7', ['reviewer']], ['o/a#1', ['author']]]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].slice(0, 3), ['search', 'prs', '--author=@me']);
  assert.ok(calls[1].includes('--review-requested=@me'));
  assert.ok(calls.every((a) => a.join(' ').includes('--state open') && a.includes('--json')));
  assert.deepEqual(r.items[2], { id: 'o/a#1', forge: 'github', repo: 'o/a', number: 1, title: 'PR 1', state: 'open', draft: false, author: 'me', url: 'https://github.com/o/a/pull/1', created: '2026-11-01T00:00:00Z', updated: '2026-11-10T00:00:00Z', closed: null, comments: 2, labels: ['bug'], roles: ['author'] });
});

test('scope, state and filters become gh search flags; bad ones are refused before gh runs', async () => {
  await prs.list({ scope: 'involves', state: 'merged', repo: 'o/a', limit: 5 });
  assert.deepEqual(calls.at(-1), ['search', 'prs', '--involves=@me', '--limit', '5', '--json', calls.at(-1)[6], '--sort', 'updated', '--merged', '--repo', 'o/a']);
  await prs.list({ scope: 'review', state: 'all', owner: 'coletebou' });
  assert.ok(calls.at(-1).includes('--review-requested=@me') && calls.at(-1).includes('--owner') && !calls.at(-1).includes('--state'));
  const n = calls.length;
  await assert.rejects(prs.list({ scope: 'everyone' }), /scope must be one of/);
  await assert.rejects(prs.list({ state: 'draft' }), /state must be one of/);
  await assert.rejects(prs.list({ repo: 'not a repo; rm -rf' }), /owner\/name/);
  await assert.rejects(prs.get({ repo: 'o/a', number: 'x' }), /number/);
  assert.equal(calls.length, n, 'gh never ran for them');
});

test('get: branches, mergeable, the review decision, the latest review per reviewer and the checks as counts', async () => {
  fakeGh(() => JSON.stringify({ ...pr(9, 'o/a'), state: 'MERGED', mergedAt: '2026-11-12T00:00:00Z', headRefName: 'feat/x', baseRefName: 'master', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'CHANGES_REQUESTED', additions: 10, deletions: 2, changedFiles: 3, body: 'the body',
    reviews: [{ author: { login: 'r1' }, state: 'COMMENTED', submittedAt: '2026-11-10T00:00:00Z' }, { author: { login: 'r1' }, state: 'APPROVED', submittedAt: '2026-11-11T00:00:00Z' }, { author: { login: 'r2' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-11-11T00:00:00Z' }],
    statusCheckRollup: [{ name: 'web', conclusion: 'SUCCESS' }, { name: 'lint', conclusion: 'FAILURE' }, { context: 'ci/legacy', state: 'PENDING' }, { name: 'skip', conclusion: 'SKIPPED' }],
    comments: [{ author: { login: 'bot' }, createdAt: '2026-11-11T00:00:00Z', body: 'looks fine' }] }));
  const d = await prs.get({ repo: 'o/a', number: 9 });
  assert.deepEqual(calls[0].slice(0, 5), ['pr', 'view', '9', '--repo', 'o/a']);
  assert.equal(d.state, 'merged');
  assert.deepEqual([d.head, d.base, d.mergeable, d.mergeState, d.reviewDecision], ['feat/x', 'master', 'mergeable', 'clean', 'changes_requested']);
  assert.deepEqual(d.reviews, [{ author: 'r1', state: 'approved', at: '2026-11-11T00:00:00Z' }, { author: 'r2', state: 'changes_requested', at: '2026-11-11T00:00:00Z' }]);
  assert.deepEqual(d.checks, { total: 4, pass: 1, fail: 1, pending: 1, skipped: 1, failing: ['lint'] });
  assert.deepEqual(d.size, { additions: 10, deletions: 2, files: 3 });
  assert.equal(d.recentComments[0].body, 'looks fine');
});

test('a missing gh, a signed-out gh and another gh failure each say what to do', async () => {
  fakeGh(() => ({ code: 127, out: '', err: 'ENOENT' }));
  await assert.rejects(prs.list({}), (e) => e.status === 501 && /not installed/.test(e.message));
  fakeGh(() => ({ code: 4, out: '', err: 'To get started with GitHub CLI, please run:  gh auth login' }));
  await assert.rejects(prs.list({}), (e) => e.status === 401 && /gh auth login/.test(e.message));
  fakeGh(() => ({ code: 1, out: '', err: 'GraphQL: Could not resolve to a Repository with the name o/nope.' }));
  await assert.rejects(prs.get({ repo: 'o/nope', number: 1 }), (e) => e.status === 404);
  fakeGh(() => ({ code: 0, out: 'not json', err: '' }));
  await assert.rejects(prs.list({}), /not JSON/);
});
