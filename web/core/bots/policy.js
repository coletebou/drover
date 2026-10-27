// What a remote bot gets back from the gateway (server/botgate.js, core/bots/tools.js). Grok Bot agents think on
// xAI's models inside Cursor-hosted VMs, so everything returned leaves the owner's machines for a third party. There
// is no content filter: a bot sees what the owner's agents see. Every string that goes out is cleaned on the way:
// secrets redacted (core/native.js redactSecrets), home paths shortened to ~, long text cut.
import { redactSecrets } from '../native.js';

/** The project names a path or a session's project field stands for: its repo directory, worktrees folded in. */
export function projectOf(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parts = value.trim().replace(/\\/g, '/').split('/').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  // <repo>/.claude/worktrees/<slug> belongs to <repo>.
  const wt = parts.lastIndexOf('.claude');
  if (wt > 0 && parts[wt + 1] === 'worktrees') return parts[wt - 1];
  return parts.at(-1);
}

/** Does a project (name, cwd or worktree path) belong to repo? `Webapp-feat-x` and `Webapp/.claude/worktrees/x` belong to webapp. */
export function projectMatches(repo, value) {
  const name = projectOf(value)?.toLowerCase();
  const p = String(repo ?? '').toLowerCase();
  return Boolean(name && p) && (name === p || name.startsWith(`${p}-`) || name.startsWith(`${p}.`));
}

const HOME_RE = new RegExp(`${(process.env.HOME ?? '/nonexistent').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=/|\\b)`, 'g');
/** A string fit to leave: secrets redacted, home paths as ~, cut to max characters. */
export function clean(value, max = 2000) {
  if (value === undefined || value === null) return value;
  const s = redactSecrets(String(value).replace(HOME_RE, '~'));
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * An id (a session id, a message ref) as a bot's own reads show ids: session and event UUIDs whole, so the bot can look
 * them up (clean() takes a UUID for a secret), while every other secret shape is still redacted; short.
 */
export function cleanId(value, max = 120) {
  if (value === undefined || value === null) return value;
  const s = redactSecrets(String(value).replace(HOME_RE, '~'), { hexSafe: true });
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Search hits as a bot sees them: what it needs to read a hit and follow it up, cleaned. */
export function sanitizeSearchHits(hits = []) {
  return hits.map((h) => ({
    score: h.score ?? null, kind: h.kind ?? null, title: clean(h.title, 200), project: projectOf(h.project ?? h.repo ?? h.cwd ?? null) ?? null,
    role: h.role ?? null, ts: h.ts ?? null, snippet: clean(h.snippet, 600), host: h.host ?? null,
    ...(h.sessionId ? { sessionId: h.sessionId } : {}), ...(h.kind === 'reflection' && h.id ? { id: h.id, status: h.status ?? null } : {}),
  }));
}

/** Features from the folded truth file, cleaned. */
export function sanitizeFeatures(features = []) {
  return features.map((f) => ({
    fid: f.fid, state: f.state, title: clean(f.title, 300), repo: f.repo, notes: clean(f.notes, 2000), links: (f.links ?? []).map((l) => clean(l, 300)), created: f.created ?? null, updated: f.updated ?? null,
    ...(f.untrusted ? { untrusted: true, untrustedBy: f.untrustedBy ?? [] } : {}),
  }));
}

/** One session as a bot sees it on the board: host, engine and status, its name and project, its last line. */
export function sanitizeSession(s, { host } = {}) {
  return {
    host: host ?? s.host ?? null, engine: s.engine ?? null, status: s.status ?? null, live: Boolean(s.live),
    id: s.id ?? null, name: clean(s.name ?? null, 120), project: projectOf(s.cwd ?? s.project ?? null),
    ...(s.headline ? { headline: clean(s.headline, 200) } : {}), ...(s.summary ? { summary: clean(s.summary, 500) } : {}),
  };
}
