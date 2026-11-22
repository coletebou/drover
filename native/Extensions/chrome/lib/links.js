// Links into the Drover UI. Never carry the token: the web UI keeps its own. Hashes follow the web UI's workspaces
// (web/ui/routes.js: #/<workspace>/<sub-view>[/params]); old ones still redirect there, but links are current.

/**
 * The web UI's solo session view: #/pop/session/<host>/<id>/<engine>/<name>.
 * @param {string} origin normalized base URL @param {{host?:string, id:string, engine?:string, name?:string}} s
 */
export function sessionUrl(origin, s) {
  const segs = ['pop', 'session', s.host || 'local', s.id, s.engine || '', s.name || ''].map((x) => encodeURIComponent(String(x)));
  return `${origin}/#/${segs.join('/')}`;
}

/** Agents › Lanes: the board. */
export function boardUrl(origin) {
  return `${origin}/#/agents/lanes`;
}

/** The Manager workspace (one sub-view, so its hash is the workspace alone). */
export function managerUrl(origin) {
  return `${origin}/#/manager`;
}

/** Prompts › Mine, optionally searching for `q` (the view's first param is its search). */
export function promptsUrl(origin, q) {
  const words = String(q ?? '').trim();
  return `${origin}/#/prompts/mine${words ? `/${encodeURIComponent(words)}` : ''}`;
}
