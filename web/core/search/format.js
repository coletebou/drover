// Plain-text rendering of search results for `drover search`. Pure; tests in test/search-index.test.js.
import { hostTime } from '../../ui/fleet-time.js';

const C = { dim: '\x1b[2m', bold: '\x1b[1m', cyan: '\x1b[36m', yellow: '\x1b[33m', off: '\x1b[0m' };

const when = (ts) => (ts ? String(ts).replace('T', ' ').slice(0, 16) : '-');

/** How to reopen the session a hit came from, when that is a resumable agent session; for a preserved ref, how to restore it. */
export function resumeHint(r) {
  if (r.kind === 'preserved') return r.restore ?? null;
  if (!r.sessionId) return null;
  if (r.kind === 'claude' || r.kind === 'subagent') return `claude --resume ${r.sessionId}`;
  // A Codex rollout summary (kind doc) carries the thread it summarizes.
  if (r.kind === 'codex' || r.kind === 'doc') return `codex resume ${r.sessionId}`;
  return null;
}

/** Hosts a fleet search could not see, one line, or null when it saw them all. */
export function coverageLine(cov) {
  const miss = [...(cov?.notCovered ?? []), ...(cov?.partial ?? [])].map((x) => `${x.host} (${x.reason})`);
  return miss.length ? `not covered: ${miss.join(' · ')}` : null;
}

/** Plain-text rendering of search.grep / search.grepFleet results for `drover grep`. */
export function formatGrep(res, { color = false } = {}) {
  const c = (k, s) => (color ? `${C[k]}${s}${C.off}` : s);
  const results = res?.results ?? [];
  const lines = [];
  const per = res?.perHost;
  if (per) lines.push(c('dim', `${results.length} hits from ${per.length} host${per.length === 1 ? '' : 's'} in ${res.ms} ms: ${per.map((h) => `${h.host} ${h.ok ? `${h.hits}${h.truncated ? '+' : ''}${hostTime(h) ? ` in ${hostTime(h)}` : ''}` : `error: ${String(h.error ?? '').slice(0, 80)}`}`).join(' · ')}`));
  else if (res) lines.push(c('dim', `${results.length} hits on ${res.host} in ${res.ms} ms${res.truncated ? ' (more matched)' : ''}`));
  const cov = coverageLine(res?.coverage);
  if (cov) lines.push(c('yellow', cov));
  for (const n of res?.notes ?? []) lines.push(c('yellow', `note: ${n}`));
  results.forEach((r, i) => {
    const head = [`${String(i + 1).padStart(2)}.`, c('cyan', r.host ?? res?.host ?? ''), r.kind, when(r.ts), r.project ? `${r.project} ·` : '', c('bold', `[${r.role}${r.tool ? ` ${r.tool}` : ''}]`)].filter(Boolean).join('  ');
    lines.push('', head, `    ${r.snippet ?? ''}`);
    const hint = resumeHint(r);
    lines.push(c('dim', `    ${r.sessionId ? `session ${r.sessionId}` : r.path ?? ''}${r.line ? ` line ${r.line}` : ''}${hint ? `  ·  ${hint}` : ''}`));
  });
  if (!results.length) lines.push('', 'No matches.');
  return lines.join('\n') + '\n';
}

export function formatResults(res, { color = false } = {}) {
  const c = (k, s) => (color ? `${C[k]}${s}${C.off}` : s);
  const lines = [];
  const results = res?.results ?? [];
  const per = res?.perHost;
  if (per) {
    const hostLine = per.map((h) => `${h.host} ${h.ok ? `${h.hits} hit${h.hits === 1 ? '' : 's'}${h.vector && h.vector !== 'ok' ? ` (vectors ${h.vector})` : ''}${hostTime(h) ? ` in ${hostTime(h)}` : ''}` : `error: ${String(h.error ?? '').slice(0, 80)}`}`).join(' · ');
    lines.push(c('dim', `${results.length} results from ${per.length} host${per.length === 1 ? '' : 's'} in ${res.ms} ms: ${hostLine}`));
  } else if (res) lines.push(c('dim', `${results.length} results on ${res.host} in ${res.ms} ms${res.vector && res.vector !== 'ok' ? ` (vectors ${res.vector})` : ''}`));
  const cov = coverageLine(res?.coverage);
  if (cov) lines.push(c('yellow', cov));
  for (const n of res?.notes ?? []) lines.push(c('yellow', `note: ${n}`));
  results.forEach((r, i) => {
    const host = r.hosts?.length > 1 ? `${r.host} +${r.hosts.length - 1}` : r.host ?? res?.host ?? '';
    const head = [`${String(i + 1).padStart(2)}.`, c('cyan', host), r.kind, when(r.ts), r.project ? `${r.project} ·` : '', c('bold', String(r.title ?? '(untitled)').slice(0, 90))].filter(Boolean).join('  ');
    lines.push('', head);
    lines.push(`    ${r.role ? c('dim', `[${r.role}] `) : ''}${r.snippet ?? ''}`);
    const hint = resumeHint(r);
    const legs = [r.legs?.fts ? `words #${r.legs.fts}` : null, r.legs?.vec ? `meaning #${r.legs.vec.rank} (${r.legs.vec.sim})` : null, r.legs?.exact ? 'exact' : null].filter(Boolean).join(', ');
    const at = r.kind === 'reflection' ? `reflection ${r.id ?? r.ref}${r.status ? ` (${r.status})` : ''}` : r.sessionId ? `session ${r.sessionId}` : r.ref ? `ref ${r.ref}` : '';
    lines.push(c('dim', `    ${at}${hint ? `  ·  ${hint}` : ''}${legs ? `  ·  ${legs}` : ''}`));
  });
  if (!results.length) lines.push('', 'No matches.');
  return lines.join('\n') + '\n';
}
