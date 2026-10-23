// Plain-text rendering of docker.stacks and docker.fleet for `drover stacks`. Pure; tests in test/docker-format.test.js.
import { countsLine, kindsLine, isWarning } from '../ui/stacks-text.js';

const C = { dim: '\x1b[2m', bold: '\x1b[1m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', off: '\x1b[0m' };
const VERDICT = { ok: 'green', starting: 'cyan', degraded: 'yellow', down: 'red', empty: 'dim' };
const home = (p) => String(p ?? '').replace(/^\/(?:home|Users)\/[^/]+/, '~');
/** s cut to n characters, the last one an ellipsis when s was longer. */
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** One git state as a line: path, worktree, branch or detached HEAD, subject, dirty files, ahead/behind. */
function gitText(g) {
  const parts = [home(g.toplevel)];
  if (g.worktree) parts.push(`(worktree of ${home(g.mainRepo ?? '?')})`);
  parts.push(g.detached ? `detached @ ${g.short}` : `${g.branch ?? '?'} @ ${g.short}`);
  if (g.subject) parts.push(`"${cut(g.subject, 70)}"`);
  if (g.dirty) parts.push(g.dirty.changed || g.dirty.untracked ? `${g.dirty.changed} changed, ${g.dirty.untracked} untracked` : 'clean');
  if (g.ahead !== null && g.ahead !== undefined) parts.push(`+${g.ahead}/-${g.behind} vs ${g.against}`);
  return parts.join('  ');
}

/** One host's stacks (a docker.stacks answer, or one entry of docker.fleet's hosts). loose: also list containers outside compose. */
function hostText(x, { c, loose }) {
  const d = x.docker;
  if (x.ok === false) return [`${c('bold', x.host)}  ${c('red', `no answer: ${x.error}`)}`];
  if (d?.available === false) return [`${c('bold', x.host)}  ${c('dim', `docker unavailable: ${d.reason}`)}`];
  const out = [];
  const t = x.totals ?? {};
  out.push(`${c('bold', x.host)}  ${c('dim', `docker ${d?.version ?? '?'}`)}  ${t.stacks ?? 0} stack${t.stacks === 1 ? '' : 's'}, ${t.containers ?? 0} containers${t.failing ? `, ${c('yellow', `${t.failing} failing`)}` : ''}${x.cache?.error ? c('yellow', `  (answer from ${Math.round((x.cache.age ?? 0) / 60_000)} min ago; refreshing failed)`) : ''}`);
  for (const n of x.notes ?? []) out.push(`  ${c('dim', n)}`);
  for (const s of x.stacks ?? []) {
    if (s.loose) {
      if (!loose) { out.push(`  ${c('dim', `outside compose: ${countsLine(s.counts)}${s.failing.length ? ` (failing: ${s.failing.map((f) => f.service).join(', ')})` : ''}`)}`); continue; }
      out.push(`  ${c('dim', 'outside compose')}  ${countsLine(s.counts)}`);
    } else out.push(`  ${c(VERDICT[s.verdict] ?? 'dim', '●')} ${c('bold', s.project)}  ${c(VERDICT[s.verdict] ?? 'dim', s.verdict)}  ${countsLine(s.counts)}`);
    if (s.kinds) out.push(`      ${c('dim', kindsLine(s.kinds))}`);
    for (const f of s.failing ?? []) out.push(`      ${c('red', '✗')} ${f.service} ${f.state}${f.detail ? `: ${cut(f.detail, 110)}` : ''}`);
    const code = s.code;
    if (code?.dir?.git) out.push(`      code ${gitText(code.dir.git)}`);
    else if (code?.dir) out.push(`      code ${home(code.dir.path)}  ${c('dim', code.dir.exists ? 'not a git repo' : 'missing')}`);
    for (const src of code?.sources ?? []) out.push(`      bind mounts (${src.services} service${src.services === 1 ? '' : 's'}): ${gitText(src)}`);
    for (const n of [...(code?.notes ?? []), ...(s.loose ? [] : s.notes ?? [])]) out.push(`      ${c(isWarning(n) ? 'yellow' : 'dim', n)}`);
    if (loose && s.loose) for (const n of s.notes ?? []) out.push(`      ${c('dim', n)}`);
  }
  if (!(x.stacks ?? []).some((s) => !s.loose)) out.push(`  ${c('dim', 'no compose stacks')}`);
  return out;
}

/** docker.stacks (one host) or docker.fleet (several) as text. */
export function formatStacks(res, { color = false, loose = false } = {}) {
  const c = (k, s) => (color ? `${C[k]}${s}${C.off}` : s);
  const lines = [];
  const hosts = Array.isArray(res?.hosts) ? res.hosts : [res];
  for (const x of hosts) lines.push(...hostText(x, { c, loose }), '');
  if (res?.hosts) {
    const asked = new Set(res.hosts.map((x) => x.host));
    const miss = [...(res.coverage?.notCovered ?? []).filter((m) => !asked.has(m.host)), ...(res.coverage?.partial ?? [])];
    if (miss.length) lines.push(c('dim', `not covered: ${miss.map((m) => `${m.host} (${m.reason})`).join(' · ')}`), '');
  }
  return lines.join('\n');
}
