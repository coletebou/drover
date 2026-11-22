// The Wall's pure half (views/wall.js renders it; the TUI's wall shares the tiles, scopes and state words): which
// tiles, in what order, how many per row, which panes to capture from which host, where the arrows move the
// selection, and how a parsed run of pane text (ansi.js parseAnsi) is styled. A color reaches the DOM only as a
// validated #rrggbb in an inline style; text only as textContent. Tests in test/ui-wall.test.js.

import { tailContent } from './pane-content.js';

const LANE_ORDER = { wait: 0, work: 1, idle: 2 };
const ms = (v) => (v == null ? 0 : typeof v === 'number' ? (v < 1e11 ? v * 1000 : v) : Date.parse(v) || 0);

/** What the Wall shows: [id, label, what it means]. Active is the default in every client. */
export const SCOPES = [
  ['active', 'Active', 'waiting, working, and idle for less than a day'],
  ['live', 'Live', 'waiting and working'],
  ['all', 'All', 'every agent on the board'],
];
/** How long an idle agent stays in Active. */
export const RECENT_MS = 24 * 3600_000;
/** A program's run (claude -p, the Agent SDK) with no pane: it lives for seconds and has nothing to watch. */
export const isHelper = (s) => s?.entrypoint === 'sdk-cli' && !s?.tmux;

/** Whether a strip belongs to a scope. Waiting is in every scope: the Wall never hides what waits on its owner. */
export function inScope(s, scope = 'all', now = Date.now()) {
  if (scope === 'all' || s.lane === 'wait') return true;
  if (isHelper(s)) return false;
  if (s.lane === 'work') return true;
  if (scope === 'live') return false;
  const at = ms(s.since);
  return at > 0 && now - at <= RECENT_MS;
}

/**
 * Board strips as tiles, in the board's own order: waiting first, then working, then idle; inside a lane what is not
 * faded first, then the newest. (By name, months-old sessions took the first rows.) The manager has its own place.
 */
export function wallTiles(strips = [], { scope = 'all', now = Date.now() } = {}) {
  return strips.filter((s) => s && s.engine !== 'openclaw' && inScope(s, scope, now))
    .slice().sort((a, b) => (LANE_ORDER[a.lane] ?? 3) - (LANE_ORDER[b.lane] ?? 3) || Number(Boolean(a.faded)) - Number(Boolean(b.faded)) || ms(b.since) - ms(a.since)
      || String(a.name ?? '').localeCompare(String(b.name ?? '')) || String(a.host ?? '').localeCompare(String(b.host ?? '')));
}

const ENDED = new Set(['done', 'failed', 'blocked', 'stopped', 'dead']);
/** The state a tile's header spells out before the age: waiting, working, idle, or how a background session ended. */
export function stateWord(s) {
  if (s?.lane === 'wait') return 'waiting';
  if (s?.lane === 'work') return 'working';
  return ENDED.has(s?.status) ? s.status : 'idle';
}

/** Tiles with no pane whose last reply is worth asking for (sessions.lastReply): a session, not a bare window. */
export const wantsReply = (s) => Boolean(s) && !s.tmux && s.kind !== 'window' && Boolean(s.sessionId ?? s.id);
/** How often a tile with no pane asks for its agent's last reply: while it works, and otherwise. */
export const REPLY_MS = { work: 8000, other: 60_000 };
/** At most this many sessions.lastReply calls per refresh. */
export const REPLY_MAX = 6;
/**
 * The tiles to ask now: on screen, no pane, not being asked already, and not asked for REPLY_MS. replies: key ->
 * { at }; asking: the keys with a call out.
 */
export function repliesDue(tiles, { replies = new Map(), asking = new Set(), now = Date.now(), keyOf = (s) => s.key } = {}) {
  return (tiles ?? []).filter((s) => { const k = keyOf(s); return wantsReply(s) && !asking.has(k) && now - (replies.get(k)?.at ?? 0) >= (s.lane === 'work' ? REPLY_MS.work : REPLY_MS.other); }).slice(0, REPLY_MAX);
}
/**
 * What a tile keeps after a sessions.lastReply answer: the text, or what it said before when the answer has none (a
 * turn that is all tool output so far reads as nothing said).
 */
export function replyText(answer, was) { return typeof answer?.text === 'string' && answer.text.trim() ? answer.text : was?.text ?? ''; }

/** Density 1..6: columns and rows of tiles that fill the view (1x1 up to 6x5). */
const GRIDS = [[1, 1], [2, 2], [3, 2], [4, 3], [5, 4], [6, 5]];
export const DENSITY_MIN = 1, DENSITY_MAX = GRIDS.length;
export function densityGrid(level) {
  const i = Math.max(DENSITY_MIN, Math.min(DENSITY_MAX, Math.round(Number(level) || 3))) - 1;
  return { cols: GRIDS[i][0], rows: GRIDS[i][1] };
}

/** At most this many targets per tmux.captureMany call (the op's own cap). */
export const CAPTURE_MAX = 64;
/**
 * host -> [tmux targets] for the tiles on screen: one call per host per refresh. Tiles without a pane (a headless
 * session, a Grok bot) show their board tail instead and are not asked for.
 */
export function capturePlan(tiles, visible) {
  const out = new Map();
  for (const t of tiles) {
    if (!t?.tmux || (visible && !visible.has(t.key))) continue;
    const host = t.host ?? 'local';
    const list = out.get(host) ?? [];
    if (!list.includes(t.tmux) && list.length < CAPTURE_MAX) list.push(t.tmux);
    out.set(host, list);
  }
  return out;
}

/** The selection after a key: arrows or h j k l on a grid of `cols`, clamped to n tiles; -1 (nothing yet) starts at 0. */
export function moveIndex(i, key, cols, n) {
  if (!n) return -1;
  if (i < 0 || i >= n) return 0;
  const step = { ArrowLeft: -1, h: -1, ArrowRight: 1, l: 1, ArrowUp: -cols, k: -cols, ArrowDown: cols, j: cols }[key];
  if (step === undefined) return i;
  const next = i + step;
  return next < 0 || next >= n ? i : next;
}

const HEX = /^#[0-9a-f]{6}$/i;
/**
 * Inline style for one run ({ fg, bg, bold, dim, italic, underline, reverse }): colors only when they are #rrggbb,
 * reverse swaps them (the terminal's own colors standing in for a missing one), dim lowers the opacity.
 */
export function runStyle(run, { fg = 'var(--term-fg)', bg = 'var(--term-bg)' } = {}) {
  const st = {};
  let f = HEX.test(run?.fg ?? '') ? run.fg : null; let b = HEX.test(run?.bg ?? '') ? run.bg : null;
  if (run?.reverse) { const x = f ?? fg; f = b ?? bg; b = x; }
  if (f) st.color = f;
  if (b) st.backgroundColor = b;
  if (run?.bold) st.fontWeight = '600';
  if (run?.dim) st.opacity = '0.6';
  if (run?.italic) st.fontStyle = 'italic';
  if (run?.underline) st.textDecoration = 'underline';
  return st;
}

/** How many whole lines of `lineHeight` fit in `height` (at least 1). */
export function fitLines(height, lineHeight) { return Math.max(1, Math.floor((Number(height) || 0) / (Number(lineHeight) || 16))); }

/**
 * A tile's text when there is no capture: its board tail (an ask's question, the last line) without the agent's
 * furniture (pane-content.js tailContent: an older daemon's tail is the bottom of the pane), else its question or status.
 */
export function tailText(s) { const t = tailContent(s?.tail); return t.length ? t.join('\n') : s?.question ?? s?.status ?? ''; }
