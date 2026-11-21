// The seven workspaces every client shares (docs/specs/2026-11-21-cohesion-overhaul.md, "The method"), each a question
// with its sub-views, the alias table that keeps every old view id working (--view, go(id), the palette, a plugin's
// `after`), and where a plugin's table lands. Pure; tests in test/tui-workspaces.test.js.
//
// A workspace is { id, title, ask, subs: [{ id, title, view, mode? }] }: `view` is the id of the view object that draws
// the sub-view (several sub-views may share one, `mode` then says which: Prompts Mine and All). A path names one
// sub-view: 'agents/wall'.

export const WORKSPACES = Object.freeze([
  { id: 'manager', title: 'Manager', ask: 'What should I do next?', subs: [{ id: 'manager', title: 'Manager', view: 'manager' }] },
  { id: 'agents', title: 'Agents', ask: 'What is every agent doing, and who waits on me?', subs: [
    { id: 'lanes', title: 'Lanes', view: 'board' }, { id: 'list', title: 'List', view: 'sessions' }, { id: 'windows', title: 'Windows', view: 'tmux' },
    { id: 'wall', title: 'Wall', view: 'wall' }, { id: 'space', title: 'Space', view: 'space' }] },
  { id: 'prompts', title: 'Prompts', ask: 'What did I ask, where, and when?', subs: [{ id: 'mine', title: 'Mine', view: 'prompts', mode: 'mine' }, { id: 'all', title: 'All', view: 'prompts', mode: 'all' }] },
  { id: 'work', title: 'Work', ask: 'What is shipping?', subs: [{ id: 'pulls', title: 'Pulls', view: 'prs' }, { id: 'features', title: 'Features', view: 'features' }] },
  { id: 'fleet', title: 'Fleet', ask: 'Which machines are up and what runs on them?', subs: [{ id: 'hosts', title: 'Hosts', view: 'fleet' }, { id: 'stacks', title: 'Stacks', view: 'stacks' }, { id: 'launch', title: 'Launch', view: 'launch' }] },
  { id: 'find', title: 'Find', ask: 'Where did that happen?', subs: [{ id: 'search', title: 'Search', view: 'search' }, { id: 'memory', title: 'Memory', view: 'memory' }, { id: 'events', title: 'Events', view: 'events' }] },
  { id: 'settings', title: 'Settings', ask: 'How does Drover behave?', subs: [{ id: 'settings', title: 'Settings', view: 'settings' }] },
].map((w) => Object.freeze({ ...w, subs: Object.freeze(w.subs.map((s) => Object.freeze(s))) })));

/** Old view id (and the spec's other names) -> workspace/sub-view. The compatibility contract for scripts and bookmarks. */
export const ALIASES = Object.freeze({
  manager: 'manager/manager',
  board: 'agents/lanes', lanes: 'agents/lanes', sessions: 'agents/list', list: 'agents/list', survey: 'agents/list',
  tmux: 'agents/windows', windows: 'agents/windows', terminals: 'agents/windows', wall: 'agents/wall', space: 'agents/space', '3d': 'agents/space',
  prompts: 'prompts/mine', spool: 'prompts/mine', requests: 'prompts/mine', mine: 'prompts/mine',
  prs: 'work/pulls', pr: 'work/pulls', pulls: 'work/pulls', features: 'work/features', mrs: 'work/mrs', mr: 'work/mrs',
  fleet: 'fleet/hosts', hosts: 'fleet/hosts', stacks: 'fleet/stacks', docker: 'fleet/stacks', launch: 'fleet/launch', profiles: 'fleet/launch',
  search: 'find/search', memory: 'find/memory', reflections: 'find/memory', events: 'find/events', files: 'find/files',
  settings: 'settings/settings',
});

/** A mutable copy (a plugin's tables are placed into it). */
export const cloneWorkspaces = (list = WORKSPACES) => list.map((w) => ({ ...w, subs: w.subs.map((s) => ({ ...s })) }));

/**
 * Where an id lands: { ws, sub } (a workspace and one of its sub-views, sub null for "the one it last showed"), or null.
 * In order: a path ('agents/wall'), an alias (old ids: 'tmux', 'docker', 'prs'), a workspace id ('agents'), a sub-view
 * id or a view id found in exactly one place ('wall', a plugin's 'channel'). A path whose sub-view is not there (the
 * web's find/files, work/mrs without the plugin) lands on its workspace.
 */
export function resolveView(id, workspaces = WORKSPACES) {
  const raw = String(id ?? '').trim().toLowerCase();
  if (!raw) return null;
  const byPath = (p) => {
    const [w, s] = p.split('/');
    const ws = workspaces.find((x) => x.id === w); if (!ws) return null;
    const sub = s ? ws.subs.find((x) => x.id === s) ?? null : null;
    return { ws, sub };
  };
  if (raw.includes('/')) return byPath(raw);
  if (ALIASES[raw]) { const r = byPath(ALIASES[raw]); if (r?.sub) return r; const placed = findSub(raw, workspaces); return placed ?? r; }
  const ws = workspaces.find((x) => x.id === raw);
  if (ws) return { ws, sub: null };
  return findSub(raw, workspaces);
}
function findSub(id, workspaces) {
  const hits = [];
  for (const ws of workspaces) for (const sub of ws.subs) if (sub.id === id || sub.view === id) hits.push({ ws, sub });
  return hits.length ? hits[0] : null;
}

/** The workspace id an id points at (a path, an alias, a workspace, a placed sub-view), or null. */
function workspaceOf(id, workspaces) { return id == null ? null : resolveView(id, workspaces)?.ws.id ?? null; }

/**
 * Put a plugin's table (core/plugins.js tuiTables: { id, title, after?, workspace?, sub? }) into a workspace: the
 * `workspace` it names wins; else the alias of its own id (the APEX plugin's `mrs` is work/mrs, so MRs land in Work
 * whatever its `after` says); else the workspace of the view its `after` names (an older plugin naming only an old
 * view id); else Work. Inside the workspace it follows the sub-view `after` names when that one is there, else it
 * goes last. Returns the sub-view added, or null when the id is taken.
 */
export function placePlugin(workspaces, def) {
  if (!def?.id) return null;
  if (workspaces.some((w) => w.subs.some((s) => s.view === def.id))) return null;
  const alias = ALIASES[String(def.id).toLowerCase()];
  const wsId = [def.workspace, alias?.split('/')[0], workspaceOf(def.after, workspaces), 'work'].find((x) => x && workspaces.some((w) => w.id === x));
  const ws = workspaces.find((w) => w.id === wsId);
  let subId = def.sub ?? (alias?.startsWith(`${wsId}/`) ? alias.split('/')[1] : def.id);
  if (ws.subs.some((s) => s.id === subId)) subId = def.id;
  const sub = { id: subId, title: def.title ?? def.id, view: def.id, plugin: true };
  const after = def.after == null ? null : resolveView(def.after, workspaces);
  const i = after?.ws === ws && after.sub ? ws.subs.indexOf(after.sub) : -1;
  ws.subs.splice(i >= 0 ? i + 1 : ws.subs.length, 0, sub);
  return sub;
}

/** Every name that lands on a sub-view (its path, its id, the aliases that point at it), for the palette and help. */
export function namesOf(ws, sub) {
  const path = `${ws.id}/${sub.id}`;
  return [...new Set([sub.view, ...Object.entries(ALIASES).filter(([, p]) => p === path).map(([k]) => k)])].filter((n) => n && n !== sub.id && n !== ws.id);
}
