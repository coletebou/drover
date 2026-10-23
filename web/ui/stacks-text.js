// One-line summaries of a docker stack and which of its notes are warnings, shared by the Stacks view
// (ui/views/stacks.js) and `drover stacks` (core/docker-format.js), the way notify-policy.js is shared: pure, no DOM.


/** "80 running: 77 healthy, 2 up (no check), 1 unhealthy; 3 completed" from a stack's counts. */
export function countsLine(c) {
  if (!c?.total) return 'no containers';
  const part = (pairs) => pairs.filter(([k]) => c[k]).map(([k, l]) => `${c[k]} ${l}`);
  const run = part([['healthy', 'healthy'], ['up', 'up (no check)'], ['starting', 'starting'], ['unhealthy', 'unhealthy']]);
  const rest = part([['completed', 'completed'], ['restarting', 'restarting'], ['failed', 'failed'], ['stopped', 'stopped'], ['created', 'created'], ['paused', 'paused'], ['dead', 'dead'], ['removing', 'removing'], ['unknown', 'unknown']]);
  return [c.running ? `${c.running} running${run.length ? `: ${run.join(', ')}` : ''}` : null, rest.join(', ') || null].filter(Boolean).join('; ');
}

/**
 * "apps 58/59 · ML 2/2 · core 14/14 · infra 8/8" (ok of total per kind, named by its label, else the kind), or null for
 * a stack without kinds (no kind rule matches its services; core/docker.js DROVER_DOCKER_KINDS).
 */
export function kindsLine(kinds) {
  if (!kinds) return null;
  return Object.entries(kinds).filter(([, k]) => k.total).map(([name, k]) => `${k.label ?? name} ${k.total - (k.failing?.length ?? 0)}/${k.total}`).join(' · ');
}

/** True for a code note that needs a look (image and source disagree, a likely stale image, a working dir gone). */
export function isWarning(note) {
  return /disagree|likely stale|no longer exists/.test(note);
}
