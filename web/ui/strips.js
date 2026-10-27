// The board's strips, wherever they come from: the daemon's compact board (native.board and `board` events: lanes,
// asks, dialogs, hashes and keys computed there) when it has one, else built here from fleet.summary (lanes.js).
// The board, the badge, the waiting window, the drawer's answer card and the palette all read strips through this.
import { allStrips } from './lanes.js';
import { tmuxWindowTarget } from './transcript.js';

/** native.board names hosts as daemons do; the UI calls the front daemon's own host "local". */
export function normalizeBoard(b, frontHost) {
  if (!b || !Array.isArray(b.strips)) return null;
  const ui = (h) => (!h || h === frontHost ? 'local' : h);
  return {
    ...b,
    hosts: (b.hosts ?? []).map((x) => ({ ...x, ui: ui(x.name) })),
    // A window strip's id is its session's when the window runs one; the drawer and lanes.js address a window by target.
    strips: b.strips.map((s) => ({ ...s, host: ui(s.host), ...(s.kind === 'window' && s.tmux ? { id: s.tmux, sessionId: s.sessionId ?? (s.id !== s.tmux ? s.id : null) } : { sessionId: s.sessionId ?? s.id }), tail: Array.isArray(s.tail) ? s.tail : s.headline ? [s.headline] : [], question: s.ask?.text ?? s.dialog?.question ?? null })),
    manager: b.manager ? { ...b.manager, host: b.manager.host ? ui(b.manager.host) : null } : null,
  };
}

export function currentStrips(state, now = Date.now()) { return state?.board?.strips ?? allStrips(state, now); }
export function waitingStrips(state, now) { return currentStrips(state, now).filter((s) => s.lane === 'wait'); }
/** Idle strips that finished recently, newest first (the quieter "Finished" list). */
export function finishedStrips(state, now = Date.now(), withinMs = 3600_000) {
  const ms = (v) => (typeof v === 'number' ? (v < 1e11 ? v * 1000 : v) : Date.parse(v ?? '') || 0);
  return currentStrips(state, now).filter((s) => s.lane === 'idle' && s.finished && now - ms(s.finished.ts) < withinMs).sort((a, b) => ms(b.finished.ts) - ms(a.finished.ts));
}

/** The strip for a drawer target ({ kind, id, host, sessionId?, tmux? }), or null. */
export function stripFor(state, t) {
  if (!t) return null;
  const host = t.host ?? 'local';
  const sid = t.kind === 'session' ? t.id : (t.sessionId ?? t.session?.sessionId ?? null);
  // A strip names its window "session:index". A window opened by id ("session:@12", a launch's target) is matched by
  // the index the drawer found it at (t.tmux), as well as by its id.
  const wins = [t.kind === 'window' ? t.id : null, tmuxWindowTarget(t.tmux)].filter(Boolean);
  const all = currentStrips(state).filter((s) => (s.host ?? 'local') === host);
  return (sid ? all.find((s) => s.sessionId === sid || s.id === sid) : null) ?? all.find((s) => wins.includes(s.tmux)) ?? null;
}

/** Live agents per host: from the board's host counts, else the fleet summary's live sessions. */
export function liveCount(state, host) {
  const b = state?.board?.hosts?.find((x) => x.ui === host || x.name === host);
  if (b) return (b.waiting ?? 0) + (b.working ?? 0) + (b.idle ?? 0);
  const f = state?.fleet?.hosts?.find((x) => x.host === host);
  return f ? f.sessions.filter((s) => s.live).length : null;
}
