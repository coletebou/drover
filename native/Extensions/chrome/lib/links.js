// Links into the Drover UI. Never carry the token: the web UI keeps its own.

/**
 * The web UI's solo session view: #/pop/session/<host>/<id>/<engine>/<name>.
 * @param {string} origin normalized base URL @param {{host?:string, id:string, engine?:string, name?:string}} s
 */
export function sessionUrl(origin, s) {
  const segs = ['pop', 'session', s.host || 'local', s.id, s.engine || '', s.name || ''].map((x) => encodeURIComponent(String(x)));
  return `${origin}/#/${segs.join('/')}`;
}

/** The web UI board. */
export function boardUrl(origin) {
  return `${origin}/#/board`;
}

/** The web UI's Manager view. */
export function managerUrl(origin) {
  return `${origin}/#/manager`;
}
