// Paths as the clients show them: under a known home (the daemon's own, from host.list) or under any /Users/<name> or
// /home/<name>, as ~. Pure and shared: the web UI (dom.js), the TUI (tui/ui.js) and `drover stacks` (core/docker-format.js).

/** Homes as tildeWith takes them: strings only, no trailing slash, the longest first (the home that holds a path wins). */
export function homeList(list) {
  return [...new Set((list ?? []).filter((x) => typeof x === 'string' && x.length > 1).map((x) => x.replace(/\/+$/, '')))].sort((a, b) => b.length - a.length);
}

/** p with the home it is under written as ~; homes from homeList. A home holds whole folders only: /srv/me never /srv/meta. */
export function tildeWith(homes, p) {
  const s = String(p ?? '');
  for (const home of homes) if (s === home || s.startsWith(`${home}/`)) return `~${s.slice(home.length)}`;
  return s.replace(/^\/(?:Users|home)\/[^/]+/, '~');
}
