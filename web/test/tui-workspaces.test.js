// The TUI's seven workspaces: every old view id lands through the alias table, a plugin's table joins a workspace (the
// APEX plugin's MRs land in Work whatever its `after` says), digits pick a workspace, < > and Shift-Left/Right its
// sub-views, each workspace remembers its sub-view across runs, the palette lists every one, and the agent selected
// in one agent view is selected in the others without ever arming an answer key in Lanes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WORKSPACES, ALIASES, resolveView, cloneWorkspaces, placePlugin, namesOf } from '../tui/workspaces.js';
import { App } from '../tui/app.js';
import { rowText } from '../tui/screen.js';
import { stripKey, stripFor } from '../tui/board.js';

const key = (id) => ({ name: id, id, ch: id.length === 1 ? id : undefined, ctrl: false, alt: false, shift: false });
const click = (x, y) => ({ name: 'mouse', id: 'mouse', kind: 'down', button: 0, x, y });
const wait = (k, name, hash, extra = {}) => ({ key: k, id: k.split('|')[1], sessionId: k.split('|')[1], name, host: 'local', engine: 'claude', lane: 'wait', kind: 'session', since: '2026-10-20T12:00:00Z', answer: 'keys', hash, keys: ['1', '2', 'Enter', 'Escape'], tmux: `work:${name}`, dialog: { question: `${name} asks`, options: [{ n: 1, label: 'Yes', selected: true }, { n: 2, label: 'No' }] }, ...extra });

function fakeApp({ cols = 160, rows = 45, stateDir = '/nonexistent-drover-test', opts = {}, results = {} } = {}) {
  const calls = [];
  const term = { active: true, mouse: true, size: () => ({ cols, rows }), write() {}, stop() {}, setMouse(on) { this.mouse = on; } };
  const client = { base: { host: '127.0.0.1:7337' }, calls, call: async (op, args) => { calls.push([op, args]); return results[op] ?? { strips: [], hosts: [], totals: {} }; }, stream: () => ({ close() {} }), close() {}, follow: async () => true };
  const app = new App({ client, term, opts, env: { TERM: 'xterm-256color' }, stateDir });
  app.start();
  const stop = () => { clearInterval(app.boardTimer); clearTimeout(app.boardSoon); app.stream?.close(); for (const v of app.views.values()) v.hide?.(); };
  const frame = () => { let f; const d = app.screen.draw.bind(app.screen); app.screen.draw = (x, o) => { f = x; return d(x, o); }; app.draw(); app.screen.draw = d; return f; };
  return { app, calls, stop, frame };
}

test('the alias table: every old id lands on its workspace and sub-view', () => {
  const want = {
    board: 'agents/lanes', sessions: 'agents/list', tmux: 'agents/windows', windows: 'agents/windows', terminals: 'agents/windows', survey: 'agents/list', wall: 'agents/wall', space: 'agents/space', '3d': 'agents/space',
    prompts: 'prompts/mine', spool: 'prompts/mine', requests: 'prompts/mine', prs: 'work/pulls', pr: 'work/pulls', pulls: 'work/pulls', features: 'work/features',
    fleet: 'fleet/hosts', hosts: 'fleet/hosts', stacks: 'fleet/stacks', docker: 'fleet/stacks', launch: 'fleet/launch', profiles: 'fleet/launch',
    search: 'find/search', memory: 'find/memory', reflections: 'find/memory', events: 'find/events', manager: 'manager/manager', settings: 'settings/settings',
  };
  for (const [old, where] of Object.entries(want)) { const r = resolveView(old); assert.equal(`${r.ws.id}/${r.sub?.id}`, where, old); }
  assert.deepEqual(WORKSPACES.map((w) => w.title), ['Manager', 'Agents', 'Prompts', 'Work', 'Fleet', 'Find', 'Settings']);
  assert.deepEqual(WORKSPACES[1].subs.map((s) => s.title), ['Lanes', 'List', 'Windows', 'Wall', 'Space']);
  const r = resolveView('agents'); assert.equal(r.ws.id, 'agents'); assert.equal(r.sub, null, 'a workspace alone: the sub-view it showed last');
  assert.equal(resolveView('TMUX').sub.id, 'windows', 'case does not matter');
  assert.deepEqual([resolveView('mrs').ws.id, resolveView('mrs').sub], ['work', null], 'mrs without the plugin: Work');
  assert.deepEqual([resolveView('files').ws.id, resolveView('files').sub], ['find', null], 'a web-only sub-view: its workspace');
  assert.equal(resolveView('nope'), null);
  assert.equal(resolveView('agents/nope').sub, null);
  for (const p of Object.values(ALIASES)) assert.ok(resolveView(p), p);
});

test('plugin tables: workspace wins, then the alias of their id, then the workspace of their after; inside it, after the sub-view named', () => {
  const ws = cloneWorkspaces();
  // The APEX plugin's three tables, as they are written today (after: an old view id).
  const mrs = placePlugin(ws, { id: 'mrs', title: 'MRs', after: 'tmux' });
  const channel = placePlugin(ws, { id: 'channel', title: 'Channel', after: 'memory' });
  const spaces = placePlugin(ws, { id: 'spaces', title: 'Spaces', after: 'channel' });
  const work = ws.find((w) => w.id === 'work'); const find = ws.find((w) => w.id === 'find');
  assert.deepEqual(work.subs.map((s) => s.id), ['pulls', 'features', 'mrs'], 'MRs land in Work (its id\'s alias), last there');
  assert.deepEqual(find.subs.map((s) => s.id), ['search', 'memory', 'channel', 'spaces', 'events'], 'after an old id: that view\'s workspace, after it');
  assert.equal(mrs.view, 'mrs'); assert.equal(channel.title, 'Channel'); assert.equal(spaces.plugin, true);
  assert.equal(`${resolveView('mrs', ws).ws.id}/${resolveView('mrs', ws).sub.id}`, 'work/mrs');
  assert.equal(resolveView('mr', ws).sub.id, 'mrs');
  assert.equal(`${resolveView('channel', ws).ws.id}/${resolveView('channel', ws).sub.id}`, 'find/channel', 'a plugin id resolves once placed');
  assert.equal(placePlugin(ws, { id: 'mrs', title: 'again' }), null, 'an id already placed is not placed twice');
  placePlugin(ws, { id: 'boxes', title: 'Boxes', workspace: 'fleet', after: 'hosts' });
  assert.deepEqual(ws.find((w) => w.id === 'fleet').subs.map((s) => s.id), ['hosts', 'boxes', 'stacks', 'launch'], 'an explicit workspace wins');
  placePlugin(ws, { id: 'odd', title: 'Odd', workspace: 'nowhere' });
  assert.equal(work.subs.at(-1).id, 'odd', 'an unknown workspace and nothing else to go by: Work');
  assert.deepEqual(namesOf(work, work.subs.find((s) => s.id === 'pulls')), ['prs', 'pr'], 'what the palette lists beside a sub-view');
});

test('app: digits pick a workspace, < > and Shift-arrows its sub-views, Tab the workspaces; old ids work in go() and --view', () => {
  const f = fakeApp();
  try {
    assert.equal(f.app.where(), 'manager/manager');
    f.app.key({ id: 'escape', name: 'escape' });   // the manager starts typing: leave the composer first
    f.app.key(key('2')); assert.equal(f.app.where(), 'agents/lanes');
    f.app.key(key('>')); assert.equal(f.app.where(), 'agents/list');
    f.app.key(key('>')); f.app.key(key('>')); assert.equal(f.app.where(), 'agents/wall');
    f.app.key({ name: 'right', id: 'S-right', shift: true }); assert.equal(f.app.where(), 'agents/space');
    f.app.key(key('>')); assert.equal(f.app.where(), 'agents/lanes', 'it wraps');
    f.app.key({ name: 'left', id: 'S-left', shift: true }); assert.equal(f.app.where(), 'agents/space');
    f.app.key(key('<')); assert.equal(f.app.where(), 'agents/wall');
    f.app.key({ name: 'tab', id: 'tab' }); assert.equal(f.app.where(), 'prompts/mine');
    f.app.key({ name: 'tab', id: 'S-tab', shift: true }); assert.equal(f.app.where(), 'agents/wall', 'back: the sub-view it showed last');
    f.app.key(key('7')); assert.equal(f.app.where(), 'settings/settings');
    f.app.key(key('8')); assert.equal(f.app.where(), 'settings/settings', 'no eighth workspace');
    for (const [old, where] of [['tmux', 'agents/windows'], ['docker', 'fleet/stacks'], ['reflections', 'find/memory'], ['board', 'agents/lanes'], ['events', 'find/events']]) { assert.equal(f.app.go(old), true); assert.equal(f.app.where(), where, old); }
    assert.equal(f.app.go('nope'), false);
  } finally { f.stop(); }
  const g = fakeApp({ opts: { view: 'tmux' } });
  try { assert.equal(g.app.where(), 'agents/windows', '--view tmux'); } finally { g.stop(); }
  const h = fakeApp({ opts: { view: 'fleet/stacks' } });
  try { assert.equal(h.app.where(), 'fleet/stacks', '--view a path'); } finally { h.stop(); }
});

test('app: the sub-tab row shows the workspace\'s sub-views and its question; clicks on it switch; the active one is marked', () => {
  const f = fakeApp();
  try {
    f.app.go('agents/windows');
    let fr = f.frame();
    const subRow = rowText(fr[1]);
    assert.match(subRow, /Lanes\s+List\s+Windows\s+Wall\s+Space/);
    assert.match(subRow, /What is every agent doing, and who waits on me\?/);
    assert.ok(fr[1].some(([t, st]) => t === ' Windows ' && st === 'subOn'), 'the active sub-view is drawn on');
    f.app.mouse(click(subRow.indexOf('Wall') + 1, 1));
    assert.equal(f.app.where(), 'agents/wall');
    fr = f.frame();
    f.app.mouse(click(rowText(fr[1]).indexOf('Lanes'), 1));
    assert.equal(f.app.where(), 'agents/lanes');
    f.app.go('manager');
    fr = f.frame();
    assert.match(rowText(fr[1]), /Manager.*What should I do next\?/, 'a single-view workspace still has its row');
    f.app.mouse(click(rowText(fr[0]).indexOf('3 Prompts') + 1, 0));
    assert.equal(f.app.where(), 'prompts/mine');
    fr = f.frame();
    f.app.mouse(click(rowText(fr[1]).indexOf('All') + 1, 1));
    assert.equal(f.app.where(), 'prompts/all');
    assert.equal(f.app.views.get('prompts').who, 'all', 'Mine and All are one view, two of its six filters');
  } finally { f.stop(); }
});

test('app: each workspace\'s last sub-view is kept in the history file and comes back on the next run', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'drover-tui-subs-'));
  try {
    const f = fakeApp({ stateDir: dir });
    try { f.app.go('agents/wall'); f.app.go('find/events'); f.app.go('manager'); } finally { f.stop(); }
    await new Promise((r) => setTimeout(r, 600));
    const saved = JSON.parse(readFileSync(path.join(dir, 'tui-history.json'), 'utf8'));
    assert.equal(saved.subs.agents, 'wall'); assert.equal(saved.subs.find, 'events');
    const g = fakeApp({ stateDir: dir });
    try {
      assert.equal(g.app.where(), 'manager/manager', 'a run starts on the manager');
      g.app.go('agents'); assert.equal(g.app.where(), 'agents/wall');
      g.app.go('find'); assert.equal(g.app.where(), 'find/events');
    } finally { g.stop(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('app: a plugin\'s MRs table lands in Work and answers to its old names', () => {
  const tables = [{ after: 'tmux', id: 'mrs', title: 'MRs', load: async () => [], rows: () => [], columns: [{ title: 'x', flex: 1, get: () => '' }] }];
  const f = fakeApp({ opts: { tables, view: 'mr' } });
  try {
    assert.equal(f.app.where(), 'work/mrs');
    assert.deepEqual(f.app.workspace().subs.map((s) => s.title), ['Pulls', 'Features', 'MRs']);
    assert.match(rowText(f.frame()[1]), /Pulls\s+Features\s+MRs/);
  } finally { f.stop(); }
});

test('palette: every workspace and sub-view ("Agents › Wall"), found by its old names too; help is grouped by workspace', () => {
  const f = fakeApp();
  try {
    f.app.palette();
    const labels = f.app.modal.items.map((it) => it.label);
    for (const w of WORKSPACES) assert.ok(labels.includes(`Go to ${w.title}`), w.title);
    for (const l of ['Agents › Lanes', 'Agents › List', 'Agents › Windows', 'Agents › Wall', 'Agents › Space', 'Prompts › Mine', 'Prompts › All', 'Work › Pulls', 'Fleet › Stacks', 'Find › Events']) assert.ok(labels.includes(l), l);
    f.app.modal.input.set('tmux');
    assert.equal(f.app.modal.matches()[0].label, 'Agents › Windows', 'typing an old name finds where it went');
    f.app.modal.key({ id: 'enter', name: 'enter' });
    assert.equal(f.app.where(), 'agents/windows');
    f.app.help();
    const heads = f.app.modal.sections.map(([h]) => h);
    assert.deepEqual(heads.filter((h) => /^\d /.test(h)).map((h) => h.split(' ')[1]), ['Manager', 'Agents', 'Prompts', 'Work', 'Fleet', 'Find', 'Settings']);
  } finally { f.stop(); }
});

test('one agent selection: Lanes, List, Windows and Wall share it by strip key; carried into Lanes it arms no answer key', async () => {
  const A = wait('local|a', 'agent-a', 'hash-a');
  const B = wait('local|b', 'agent-b', 'hash-b', { since: '2026-10-20T12:05:00Z' });
  const sessions = { sessions: [{ id: 'a', sessionId: 'a', engine: 'claude', name: 'agent-a', live: true, status: 'idle', tmux: 'work:@1.%1' }, { id: 'b', sessionId: 'b', engine: 'claude', name: 'agent-b', live: true, status: 'idle' }, { id: 'z', sessionId: 'z', engine: 'claude', name: 'no-strip', live: true, status: 'idle' }] };
  const windows = [{ target: 'work:agent-a', name: 'a' }, { target: 'work:agent-b', name: 'b', agent: { engine: 'claude', sessionId: 'b' } }, { target: 'work:shell', name: 'zsh', cmd: 'zsh' }];
  const f = fakeApp({ results: { 'sessions.list': sessions, 'tmux.windows': windows, 'native.board': { strips: [A, B], hosts: [], totals: { waiting: 2 } } } });
  const answered = [];
  f.app.answer = (s, k) => { answered.push([s.id, k]); };
  try {
    await new Promise((r) => setTimeout(r, 5));   // the board the app reads at start
    assert.equal(stripKey(A), 'local|a'); assert.equal(stripKey({ host: 'box', id: 'x' }), 'box|x', 'a strip without a key gets the board\'s shape');
    assert.equal(stripFor([A, B], { host: 'fakehost', sessionId: 'b' }, 'fakehost'), B, 'this machine by its name');
    assert.equal(stripFor([A, B], { host: 'box-a', sessionId: 'b' }, 'fakehost'), null, 'never another host\'s strip');
    f.app.go('agents/lanes'); f.frame();
    f.app.key(key('j')); f.frame();
    const first = f.app.agentSel; assert.ok(first);
    f.app.go('agents/list'); await new Promise((r) => setTimeout(r, 5)); f.frame();
    const list = f.app.views.get('sessions');
    assert.equal(list.def.agentKey(list.selected(), list), first, 'List selects the row of the agent picked in Lanes');
    f.app.key(key('k')); f.frame();
    const second = f.app.agentSel; assert.equal(second, 'local|a', 'moving in List selects that agent everywhere');
    f.app.go('agents/windows'); await new Promise((r) => setTimeout(r, 5)); f.frame();
    const win = f.app.views.get('tmux');
    assert.equal(win.def.agentKey(win.selected(), win), second, 'Windows too: a window with no agent field, by its target');
    f.app.key(key('j')); assert.equal(f.app.agentSel, 'local|b', 'a window by its agent\'s session');
    f.app.key(key('j')); assert.equal(f.app.agentSel, null, 'a row that is no agent selects none');
    f.app.key(key('k')); assert.equal(f.app.agentSel, 'local|b');
    f.app.go('agents/wall'); f.frame();
    const wall = f.app.views.get('wall');
    assert.equal(stripKey(wall.selected()), 'local|b', 'the Wall selects the same tile');
    f.app.key(key('l')); f.app.key(key('h'));   // moved on the Wall: still one of the two
    f.app.go('agents/lanes'); f.frame();
    const lanes = f.app.views.get('board');
    assert.ok(f.app.agentSel, 'Lanes shows the selection carried in');
    assert.equal(lanes.isArmed(), false, 'but it was not made here');
    f.app.key(key('1')); f.app.key({ id: 'enter', name: 'enter' });
    assert.deepEqual(answered, [], 'neither a digit nor Enter answers a carried strip');
    assert.equal(f.app.where(), 'manager/manager', 'the digit switched workspaces instead');
    f.app.key({ id: 'escape', name: 'escape' });
    f.app.go('agents/lanes'); f.frame();
    f.app.key({ id: 'enter', name: 'enter' }); f.frame();
    assert.equal(lanes.isArmed(), true, 'Enter picks the carried strip here');
    f.app.key(key('2'));
    assert.equal(answered.length, 1, 'then its keys answer it');
  } finally { f.stop(); }
});

test('Agents › Space: the 3D view sits under the tab bar and the sub-tab row with the view interface', async () => {
  const { SpaceView } = await import('../tui/views/space.js');
  const f = fakeApp();
  try {
    assert.equal(f.app.go('3d'), true);
    assert.equal(f.app.where(), 'agents/space');
    const v = f.app.front();
    assert.ok(v instanceof SpaceView); assert.equal(v.title, 'Space');
    const rows = v.render(120, 30);
    assert.equal(rows.length, 30);
    assert.match(rowText(rows[0]), /^ Space /);
    assert.equal(v.key({ id: 'x' }), false); assert.equal(v.mouse({ kind: 'move', x: 0, y: 1 }), false, 'the sky is not an object');
    assert.equal(v.key({ id: '1' }), false, 'digits stay the workspaces');
    assert.ok(Array.isArray(v.hints()));
    assert.match(rowText(f.frame()[2]), /^ Space /, 'drawn under the tab bar and the sub-tab row');
  } finally { f.stop(); }
});
