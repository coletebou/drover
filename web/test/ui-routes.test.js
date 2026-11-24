// The browser's workspaces and the alias table (ui/routes.js): every old hash lands on its workspace and sub-view
// with its params kept, plugin views join the workspace they name, counts roll up, the palette finds old names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WORKSPACES, ALIASES, workspaces, resolve, parseHash, hashFor, navSegs, stepSub, locate, wsCount, navEntries } from '../ui/routes.js';

const go = (hash, list = WORKSPACES, last = {}) => { const r = resolve(parseHash(hash), list, last); return [r.ws, r.sub, r.params, r.hash]; };

test('seven workspaces in the spec\'s order, each sub-view naming a view', () => {
  assert.deepEqual(WORKSPACES.map((w) => w.id), ['manager', 'agents', 'prompts', 'work', 'fleet', 'find', 'settings']);
  assert.deepEqual(WORKSPACES.find((w) => w.id === 'agents').subs.map((s) => s.id), ['lanes', 'list', 'windows', 'wall', 'space']);
  assert.deepEqual(WORKSPACES.find((w) => w.id === 'find').subs.map((s) => s.id), ['search', 'memory', 'skills', 'events', 'files']);
  for (const w of WORKSPACES) for (const s of w.subs) assert.ok(s.view && s.label, `${w.id}/${s.id}`);
});

test('every old hash redirects to its workspace and sub-view, params kept', () => {
  assert.deepEqual(go('#/tmux'), ['agents', 'windows', [], '#/agents/windows']);
  assert.deepEqual(go('#/tmux/work%3A3'), ['agents', 'windows', ['work:3'], '#/agents/windows/work%3A3']);
  assert.deepEqual(go('#/board'), ['agents', 'lanes', [], '#/agents/lanes']);
  assert.deepEqual(go('#/sessions/5c1e-abc'), ['agents', 'list', ['5c1e-abc'], '#/agents/list/5c1e-abc']);
  assert.deepEqual(go('#/terminals/t7'), ['agents', 'windows', ['terminal', 't7'], '#/agents/windows/terminal/t7']);
  assert.deepEqual(go('#/survey'), ['agents', 'list', ['survey'], '#/agents/list/survey']);
  assert.deepEqual(go('#/launch/fix%20the%20tests'), ['fleet', 'launch', ['fix the tests'], '#/fleet/launch/fix%20the%20tests']);
  assert.deepEqual(go('#/stacks/devbox'), ['fleet', 'stacks', ['devbox'], '#/fleet/stacks/devbox']);
  assert.deepEqual(go('#/search/needle'), ['find', 'search', ['needle'], '#/find/search/needle']);
  assert.deepEqual(go('#/features/F-12'), ['work', 'features', ['F-12'], '#/work/features/F-12']);
  assert.deepEqual(go('#/files/~%2F.claude%2FCLAUDE.md'), ['find', 'files', ['~/.claude/CLAUDE.md'], '#/find/files/~%2F.claude%2FCLAUDE.md']);
  assert.deepEqual(go('#/settings'), ['settings', 'general', [], '#/settings']);
  assert.deepEqual(go('#/manager'), ['manager', 'console', [], '#/manager']);
  // Every row of the spec's table resolves where it says.
  for (const [old, [wsId, subId]] of Object.entries(ALIASES)) {
    if (subId === 'mrs') continue;   // a plugin's: below
    const [ws, sub] = go(`#/${old}`);
    assert.deepEqual([ws, sub], [wsId, subId], old);
  }
});

test('new hashes: a workspace alone takes the sub-view last used there, else its first', () => {
  assert.deepEqual(go('#/agents/wall'), ['agents', 'wall', [], '#/agents/wall']);
  assert.deepEqual(go('#/agents'), ['agents', 'lanes', [], '#/agents/lanes']);
  assert.deepEqual(go('#/agents', WORKSPACES, { agents: 'wall' }), ['agents', 'wall', [], '#/agents/wall']);
  assert.deepEqual(go('#/agents', WORKSPACES, { agents: 'gone' }), ['agents', 'lanes', [], '#/agents/lanes'], 'a sub-view that is no longer there');
  assert.deepEqual(go('#/prompts/all/parser'), ['prompts', 'all', ['parser'], '#/prompts/all/parser']);
  // A segment that is no sub-view is the default sub-view's param.
  assert.deepEqual(go('#/settings/sounds'), ['settings', 'general', ['sounds'], '#/settings/sounds']);
  // Nothing, or something unknown: Agents.
  assert.deepEqual(go(''), ['agents', 'lanes', [], '#/agents/lanes']);
  assert.deepEqual(go('#/nonsense/x', WORKSPACES, { agents: 'list' }), ['agents', 'list', [], '#/agents/list']);
});

test('plugin views join the workspace they name, else the one their after belongs to', () => {
  const list = workspaces([
    { id: 'mrs', label: 'MRs', after: 'prs' },                       // an older plugin: after an old view id
    { id: 'brain', label: 'Brain', workspace: 'find', after: 'memory' },
    { id: 'odd', label: 'Odd' },                                    // names neither: Work
    { id: 'late', label: 'Late', after: 'launch' },
  ]);
  assert.deepEqual(list.find((w) => w.id === 'work').subs.map((s) => s.id), ['pulls', 'mrs', 'features', 'odd']);
  assert.deepEqual(list.find((w) => w.id === 'find').subs.map((s) => s.id), ['search', 'memory', 'brain', 'skills', 'events', 'files']);
  assert.deepEqual(list.find((w) => w.id === 'fleet').subs.map((s) => s.id), ['hosts', 'stacks', 'launch', 'late']);
  assert.equal(WORKSPACES.find((w) => w.id === 'work').subs.length, 2, 'the base table is not changed');
  assert.deepEqual(go('#/mrs/42', list), ['work', 'mrs', ['42'], '#/work/mrs/42']);
  assert.deepEqual(go('#/mr', list), ['work', 'mrs', [], '#/work/mrs']);
  assert.deepEqual(go('#/brain', list), ['find', 'brain', [], '#/find/brain'], 'a plugin view by its own id');
  // Without the plugin, its old hash still lands in its workspace (and drops what only the plugin understood).
  assert.deepEqual(go('#/mrs/42'), ['work', 'pulls', [], '#/work/pulls']);
  // Placed once: a second view with the same id is not added again.
  const twice = workspaces([{ id: 'mrs', after: 'prs' }, { id: 'mrs', after: 'prs' }]);
  assert.equal(twice.find((w) => w.id === 'work').subs.filter((s) => s.id === 'mrs').length, 1);
});

test('hashFor, navSegs, stepSub and locate', () => {
  assert.equal(hashFor(WORKSPACES, 'agents', 'windows', ['work:@12', '', null]), '#/agents/windows/work%3A%4012');
  assert.equal(hashFor(WORKSPACES, 'settings', 'general'), '#/settings');
  assert.deepEqual(navSegs('tmux', ['work:3', undefined]), ['tmux', 'work:3']);
  assert.deepEqual(navSegs('fleet/launch', ['a prompt']), ['fleet', 'launch', 'a prompt']);
  assert.deepEqual(go('#/' + navSegs('fleet/launch', ['a/b']).map(encodeURIComponent).join('/')), ['fleet', 'launch', ['a/b'], '#/fleet/launch/a%2Fb'], 'a slash in a param survives');
  assert.equal(stepSub(WORKSPACES, 'agents', 'lanes', 1), 'list');
  assert.equal(stepSub(WORKSPACES, 'agents', 'lanes', -1), 'space', 'wraps around');
  assert.equal(stepSub(WORKSPACES, 'settings', 'general', 1), 'general');
  assert.deepEqual(locate(WORKSPACES, 'tmux'), { ws: 'agents', sub: 'windows' });
  assert.equal(locate(WORKSPACES, 'nope'), null);
});

test('counts roll up to the workspace tab, leaving informational totals out', () => {
  const agents = WORKSPACES.find((w) => w.id === 'agents');
  assert.equal(wsCount(agents, { board: 3, sessions: 12, tmux: 2 }), 3, 'waiting counts; live sessions and dialogs on screen do not');
  assert.equal(wsCount(WORKSPACES.find((w) => w.id === 'work'), { prs: 2, features: 4 }), 6);
  assert.equal(wsCount(WORKSPACES.find((w) => w.id === 'find'), { events: 900 }), null);
  assert.equal(wsCount(agents, {}), null);
});

test('the palette lists workspaces and sub-views, found by their old names', () => {
  const e = navEntries(WORKSPACES);
  const wall = e.find((x) => x.label === 'Agents › Wall');
  assert.equal(wall.nav, 'agents/wall');
  const win = e.find((x) => x.nav === 'agents/windows');
  assert.match(win.hay, /\btmux\b/); assert.match(win.hay, /\bterminals\b/);
  assert.ok(e.some((x) => x.label === 'Settings' && x.nav === 'settings'));
  assert.ok(!e.some((x) => x.label === 'Settings › Settings'), 'a workspace with one view lists once');
});
