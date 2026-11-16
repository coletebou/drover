// GitHub pull requests through the gh CLI: the ones you opened and the ones waiting on your review, with the
// mergeable state, the review decision and the checks of one. gh keeps its own login (`gh auth login`), so no token
// passes through Drover. The ops run on the host args.host names, like every other, with that host's gh login.
// A forge that is not GitHub (APEX Repos merge requests) is a plugin's (mrs.*). Pure apart from _deps.run; tests
// in test/prs.test.js.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

export const STATES = ['open', 'closed', 'merged', 'all'];
export const SCOPES = ['both', 'authored', 'review', 'involves'];
const LIST_FIELDS = 'number,title,repository,url,state,isDraft,author,createdAt,updatedAt,closedAt,commentsCount,labels';
const VIEW_FIELDS = 'number,title,state,isDraft,url,author,body,headRefName,baseRefName,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,additions,deletions,changedFiles,comments,reviews,labels,createdAt,updatedAt,mergedAt,closedAt';
// Where gh lives when the daemon's PATH is a service manager's short one.
const GH_PATHS = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh', '/home/linuxbrew/.linuxbrew/bin/gh'];

export class PrsError extends Error { constructor(message, extra = {}) { super(message); this.name = 'PrsError'; Object.assign(this, extra); } }

export const _deps = {
  gh: () => GH_PATHS.find((p) => existsSync(p)) ?? 'gh',
  run: (bin, args, { timeoutMs = 30_000 } = {}) => new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' } },
      (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : err.code === 'ENOENT' ? 127 : 1) : 0, out: String(stdout ?? ''), err: String(stderr || (err?.code === 'ENOENT' ? 'ENOENT' : err?.message) || ''), killed: Boolean(err?.killed) }));
  }),
};

async function gh(args, opts) {
  const r = await _deps.run(_deps.gh(), args, opts);
  if (r.code === 127 || /ENOENT/.test(r.err)) throw new PrsError('gh is not installed on this host (https://cli.github.com)', { status: 501 });
  if (r.killed) throw new PrsError(`gh ${args[0]} ${args[1] ?? ''} took too long`, { status: 504 });
  if (r.code !== 0) {
    const msg = r.err.trim().split('\n').filter(Boolean).slice(-3).join(' ') || `gh exited ${r.code}`;
    if (/auth login|not logged in|authentication/i.test(msg)) throw new PrsError(`gh is not signed in on this host: run gh auth login (${msg})`, { status: 401 });
    throw new PrsError(`gh: ${msg}`, { status: /not found|could not resolve/i.test(msg) ? 404 : 502 });
  }
  try { return JSON.parse(r.out || 'null'); } catch { throw new PrsError('gh answered something that is not JSON'); }
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const OWNER = /^[A-Za-z0-9_.-]{1,100}$/;
function pick(v, list, name, dflt) { const x = v ?? dflt; if (!list.includes(x)) throw new PrsError(`${name} must be one of ${list.join(', ')}`, { status: 400 }); return x; }

/** A search result or a pr view as the list's row: { id, repo, number, title, state, draft, author, url, ... }. */
export function normalize(p, role = null) {
  const repo = p.repository?.nameWithOwner ?? p.repo ?? null;
  const merged = Boolean(p.mergedAt) || String(p.state).toUpperCase() === 'MERGED';
  return {
    id: `${repo}#${p.number}`, forge: 'github', repo, number: p.number, title: p.title ?? '',
    state: merged ? 'merged' : String(p.state ?? '').toLowerCase() || 'open', draft: Boolean(p.isDraft),
    author: p.author?.login ?? null, url: p.url ?? null,
    created: p.createdAt ?? null, updated: p.updatedAt ?? null, closed: p.closedAt ?? null,
    comments: p.commentsCount ?? (Array.isArray(p.comments) ? p.comments.length : null),
    labels: (p.labels ?? []).map((l) => l.name ?? l).filter(Boolean),
    roles: role ? [role] : [],
  };
}

function searchArgs(who, state, limit, { repo, owner }) {
  const a = ['search', 'prs', `--${who}=@me`, '--limit', String(limit), '--json', LIST_FIELDS, '--sort', 'updated'];
  if (state === 'merged') a.push('--merged'); else if (state !== 'all') a.push('--state', state);
  if (repo) a.push('--repo', repo); else if (owner) a.push('--owner', owner);
  return a;
}

/**
 * Your pull requests, newest update first. scope: both (the ones you opened and the ones that ask your review, each
 * with its roles), authored, review, involves (anything you are part of). state: open, closed, merged, all.
 */
export async function list({ scope, state, limit = 100, repo, owner } = {}) {
  scope = pick(scope, SCOPES, 'scope', 'both'); state = pick(state, STATES, 'state', 'open');
  const n = Math.max(1, Math.min(1000, Number(limit) || 100));
  if (repo !== undefined && !REPO.test(String(repo))) throw new PrsError('repo is owner/name', { status: 400 });
  if (owner !== undefined && !OWNER.test(String(owner))) throw new PrsError('owner is a GitHub user or organization', { status: 400 });
  const asks = scope === 'both' ? [['author', 'author'], ['review-requested', 'reviewer']] : [[{ authored: 'author', review: 'review-requested', involves: 'involves' }[scope], { authored: 'author', review: 'reviewer', involves: null }[scope]]];
  const answers = await Promise.all(asks.map(([who]) => gh(searchArgs(who, state, n, { repo, owner }))));
  const byId = new Map();
  answers.forEach((rows, i) => {
    for (const p of Array.isArray(rows) ? rows : []) {
      const row = normalize(p, asks[i][1]);
      const had = byId.get(row.id);
      if (had) { for (const r of row.roles) if (!had.roles.includes(r)) had.roles.push(r); } else byId.set(row.id, row);
    }
  });
  const items = [...byId.values()].sort((a, b) => (Date.parse(b.updated ?? 0) || 0) - (Date.parse(a.updated ?? 0) || 0)).slice(0, n);
  return { items, count: items.length, scope, state, forge: 'github' };
}

/** The checks of a PR (statusCheckRollup) as counts: pass, fail, pending, skipped, and the failing names. */
export function checks(rollup = []) {
  const out = { total: 0, pass: 0, fail: 0, pending: 0, skipped: 0, failing: [] };
  for (const c of rollup ?? []) {
    out.total++;
    const v = String(c.conclusion || c.state || c.status || '').toUpperCase();
    if (['SUCCESS', 'NEUTRAL'].includes(v)) out.pass++;
    else if (['SKIPPED', 'CANCELLED', 'STALE'].includes(v)) out.skipped++;
    else if (['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(v)) { out.fail++; out.failing.push(c.name || c.context || c.workflowName || '?'); }
    else out.pending++;
  }
  return out;
}

/** One PR with what the list has no room for: branches, mergeable, review decision, checks, size, recent comments. */
export async function get({ repo, number } = {}) {
  if (!REPO.test(String(repo ?? ''))) throw new PrsError('repo is owner/name', { status: 400 });
  const num = Number(number);
  if (!Number.isInteger(num) || num < 1) throw new PrsError('number is a pull request number', { status: 400 });
  const p = await gh(['pr', 'view', String(num), '--repo', repo, '--json', VIEW_FIELDS]);
  const latest = new Map();
  for (const r of p.reviews ?? []) { const who = r.author?.login ?? '?'; const prev = latest.get(who); if (!prev || String(r.submittedAt) > String(prev.submittedAt)) latest.set(who, r); }
  return {
    ...normalize({ ...p, repo }), body: p.body ?? '',
    head: p.headRefName ?? null, base: p.baseRefName ?? null,
    mergeable: p.mergeable ? String(p.mergeable).toLowerCase() : null, mergeState: p.mergeStateStatus ? String(p.mergeStateStatus).toLowerCase() : null,
    reviewDecision: p.reviewDecision ? String(p.reviewDecision).toLowerCase() : null,
    reviews: [...latest.values()].map((r) => ({ author: r.author?.login ?? null, state: String(r.state ?? '').toLowerCase(), at: r.submittedAt ?? null })),
    checks: checks(p.statusCheckRollup),
    size: { additions: p.additions ?? null, deletions: p.deletions ?? null, files: p.changedFiles ?? null },
    recentComments: (p.comments ?? []).slice(-5).map((c) => ({ author: c.author?.login ?? null, at: c.createdAt ?? null, body: String(c.body ?? '').slice(0, 2000) })),
  };
}

export const ops = {
  'prs.list': (a) => list(a),
  'prs.get': (a) => get(a),
};
