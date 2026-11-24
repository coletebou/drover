// Workspaces: the seven questions every client answers (docs/specs/2026-11-21-cohesion-overhaul.md, "The method"),
// their sub-views, and the alias table that keeps every old hash (#/tmux, #/board, #/sessions/<id> ...) working.
// Pure: app.js routes through it, draws the workspace and sub-tab rows from it, and the palette lists from it.
// A sub-view names the view module that renders it (`view`, a views/*.js id); a plugin view joins the workspace its
// `workspace` field names, else the one its `after` belongs to. Tests in test/ui-routes.test.js.

/** rollup: false keeps a sub-view's count off its workspace tab (an informational total, not something to act on). */
export const WORKSPACES = [
  { id: 'manager', label: 'Manager', question: 'What should I do next?', subs: [{ id: 'console', label: 'Console', view: 'manager' }] },
  { id: 'agents', label: 'Agents', question: 'What is every agent doing, and who waits on me?', subs: [
    { id: 'lanes', label: 'Lanes', view: 'board' },
    { id: 'list', label: 'List', view: 'sessions', rollup: false },
    { id: 'windows', label: 'Windows', view: 'tmux', rollup: false },
    { id: 'wall', label: 'Wall', view: 'wall' },
    { id: 'space', label: 'Space', view: 'space' }] },
  { id: 'prompts', label: 'Prompts', question: 'What did I ask, where, and when?', subs: [{ id: 'mine', label: 'Mine', view: 'prompts' }, { id: 'all', label: 'All', view: 'prompts-all', rollup: false }] },
  { id: 'work', label: 'Work', question: 'What is shipping?', subs: [{ id: 'pulls', label: 'Pulls', view: 'prs' }, { id: 'features', label: 'Features', view: 'features' }] },
  { id: 'fleet', label: 'Fleet', question: 'Which machines are up and what runs on them?', subs: [{ id: 'hosts', label: 'Hosts', view: 'fleet' }, { id: 'stacks', label: 'Stacks', view: 'stacks' }, { id: 'launch', label: 'Launch', view: 'launch' }] },
  { id: 'find', label: 'Find', question: 'Where did that happen?', subs: [{ id: 'search', label: 'Search', view: 'search' }, { id: 'memory', label: 'Memory', view: 'memory' }, { id: 'skills', label: 'Skills', view: 'skills' }, { id: 'events', label: 'Events', view: 'events', rollup: false }, { id: 'files', label: 'Files', view: 'files' }] },
  { id: 'settings', label: 'Settings', question: 'How does Drover behave?', subs: [{ id: 'general', label: 'Settings', view: 'settings' }] },
];
export const DEFAULT_WS = 'agents';

/**
 * Old id -> [workspace, sub-view, ...params put before the old hash's own]. The compatibility contract for bookmarks
 * and scripts (the spec's "Aliases" table): `#/terminals/<id>` lands on Agents › Windows with that terminal open,
 * `#/survey` on Agents › List with the survey panel. The workspace ids themselves (manager, prompts, fleet, settings)
 * need no entry.
 */
export const ALIASES = {
  board: ['agents', 'lanes'], home: ['agents', 'lanes'], sessions: ['agents', 'list'], survey: ['agents', 'list', 'survey'],
  tmux: ['agents', 'windows'], windows: ['agents', 'windows'], terminals: ['agents', 'windows', 'terminal'],
  wall: ['agents', 'wall'], space: ['agents', 'space'], '3d': ['agents', 'space'],
  spool: ['prompts', 'mine'], requests: ['prompts', 'mine'],
  prs: ['work', 'pulls'], pr: ['work', 'pulls'], pulls: ['work', 'pulls'], features: ['work', 'features'], mrs: ['work', 'mrs'], mr: ['work', 'mrs'],
  hosts: ['fleet', 'hosts'], stacks: ['fleet', 'stacks'], docker: ['fleet', 'stacks'], launch: ['fleet', 'launch'], profiles: ['fleet', 'launch'],
  search: ['find', 'search'], memory: ['find', 'memory'], reflections: ['find', 'memory'], learned: ['find', 'skills'], 'learned-skills': ['find', 'skills'], events: ['find', 'events'], files: ['find', 'files'],
};

const copy = (list) => list.map((w) => ({ ...w, subs: w.subs.map((s) => ({ ...s })) }));
/** The workspace holding a sub-view by its view id or sub id (a plugin's `after` names either). */
function wsOf(list, id) { return list.find((w) => w.subs.some((s) => s.view === id || s.id === id)) ?? null; }

/**
 * The workspaces with plugin views placed: a view's `workspace` names its workspace; else its `after` (a sub id, a view
 * id or an old id) says which one; else it joins Work (what a plugin view has been so far: merge requests). Within the
 * workspace it follows the sub-view `after` names, else it goes last. Its sub id is its `sub`, else its view id.
 */
export function workspaces(pluginViews = [], base = WORKSPACES) {
  const list = copy(base);
  for (const v of pluginViews) placeView(list, v);
  return list;
}
export function placeView(list, v) {
  if (!v?.id) return null;
  const alias = v.after ? ALIASES[v.after] : null;
  const ws = list.find((w) => w.id === v.workspace) ?? (v.after ? wsOf(list, v.after) ?? list.find((w) => w.id === alias?.[0]) : null) ?? list.find((w) => w.id === 'work');
  const id = String(v.sub ?? v.id);
  if (ws.subs.some((s) => s.id === id || s.view === v.id)) return null;
  const sub = { id, label: v.label ?? v.id, view: v.id, plugin: true, ...(v.rollup === false ? { rollup: false } : {}) };
  const at = v.after ? ws.subs.findIndex((s) => s.view === v.after || s.id === v.after || (alias && ws.id === alias[0] && s.id === alias[1])) : -1;
  ws.subs.splice(at >= 0 ? at + 1 : ws.subs.length, 0, sub);
  return { ws: ws.id, sub: id };
}

/** "#/agents/windows/work%3A3" -> ['agents', 'windows', 'work:3']. */
export function parseHash(hash) {
  return String(hash ?? '').replace(/^#\/?/, '').split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
}
const pickSub = (ws, last) => ws.subs.find((s) => s.id === last?.[ws.id]) ?? ws.subs[0];

/**
 * Segments -> { ws, sub, view, params, hash }. A workspace id first (its sub-view next, else the one last used there);
 * else an old id through ALIASES (its params kept, after the alias's own); else a sub-view or view id (a plugin's);
 * else the Agents workspace. hash is the canonical form: when it differs from the address bar, the shell replaces it.
 */
export function resolve(segs, list = WORKSPACES, last = {}) {
  const [head, ...rest] = segs ?? [];
  let ws = list.find((w) => w.id === head); let sub = null; let params = rest;
  if (ws) {
    sub = ws.subs.find((s) => s.id === rest[0]) ?? null;
    if (sub) params = rest.slice(1); else sub = pickSub(ws, last);
  } else {
    const a = ALIASES[head] ?? (() => { const w = wsOf(list, head); const s = w?.subs.find((x) => x.view === head || x.id === head); return s ? [w.id, s.id] : null; })();
    ws = (a && list.find((w) => w.id === a[0])) ?? list.find((w) => w.id === DEFAULT_WS) ?? list[0];
    sub = a ? ws.subs.find((s) => s.id === a[1]) ?? null : null;
    // A known sub-view keeps the alias's lead params and the old hash's own; an unknown one (a plugin that is not here) drops them.
    params = sub ? [...a.slice(2), ...rest] : [];
    sub ??= pickSub(ws, last);
  }
  return { ws: ws.id, sub: sub.id, view: sub.view, params, hash: hashFor(list, ws.id, sub.id, params) };
}

/** The canonical hash; a workspace with one sub-view leaves its sub id out (#/settings, #/manager). */
export function hashFor(list, wsId, subId, params = []) {
  const ws = list.find((w) => w.id === wsId);
  const subSeg = ws && ws.subs.length === 1 && ws.subs[0].id === subId ? [] : [subId];
  return '#/' + [wsId, ...subSeg, ...params.filter((p) => p !== undefined && p !== null && p !== '').map(String)].map(encodeURIComponent).join('/');
}

/** What ctx.nav(id, ...params) asks for: an id may be an old view id ('tmux'), a workspace ('agents') or 'agents/wall'. */
export function navSegs(id, params = []) {
  return [...String(id ?? '').split('/').filter(Boolean), ...params.filter((p) => p !== undefined && p !== null && p !== '').map(String)];
}

/** The sub-view `dir` steps (+1 / -1) from subId, wrapping around. */
export function stepSub(list, wsId, subId, dir) {
  const ws = list.find((w) => w.id === wsId); if (!ws) return null;
  const i = ws.subs.findIndex((s) => s.id === subId);
  return ws.subs[(Math.max(0, i) + dir + ws.subs.length) % ws.subs.length].id;
}

/** Where a view id lives: { ws, sub } (ctx.setCount and the tabs use it), or null. */
export function locate(list, viewId) {
  for (const w of list) for (const s of w.subs) if (s.view === viewId) return { ws: w.id, sub: s.id };
  return null;
}

/** A workspace tab's badge: the sum of its sub-views' counts (rollup: false ones left out), null when none has one. */
export function wsCount(ws, counts = {}) {
  let n = null;
  for (const s of ws.subs) { if (s.rollup === false) continue; const c = counts[s.view]; if (typeof c === 'number' && c > 0) n = (n ?? 0) + c; }
  return n;
}

/**
 * What the palette jumps to: each workspace, then each of its sub-views as "Agents › Wall". hay is what it is found
 * by: the labels, the question, and the old ids that land there (so "tmux" finds Agents › Windows).
 */
export function navEntries(list = WORKSPACES) {
  const olds = (wsId, subId) => Object.entries(ALIASES).filter(([, a]) => a[0] === wsId && a[1] === subId).map(([k]) => k);
  const out = [];
  for (const w of list) {
    out.push({ label: w.label, nav: w.id, hay: `${w.label} ${w.question ?? ''}`, ws: w.id });
    if (w.subs.length < 2) continue;
    for (const s of w.subs) out.push({ label: `${w.label} › ${s.label}`, nav: `${w.id}/${s.id}`, hay: `${w.label} ${s.label} ${s.view} ${olds(w.id, s.id).join(' ')}`, ws: w.id, sub: s.id });
  }
  return out;
}
