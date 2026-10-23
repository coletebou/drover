// The board for the TUI: strips from native.board, or on a daemon that predates it from fleet.summary through the
// web UI's own lanes (ui/lanes.js, which core/native.js uses too), in board order; and answering a waiting strip:
// which keys its dialog takes, what each means, and the op that presses one (sessions.answer with the screen hash
// the owner saw, tmux.answer on a daemon without it). Pure; tests in test/tui-board.test.js.
import { stripsFor } from '../ui/lanes.js';

export const LANES = [['wait', 'Waiting on you'], ['work', 'Working'], ['idle', 'Idle']];
const ORDER = { wait: 0, work: 1, idle: 2 };
const ms = (v) => (v == null ? 0 : typeof v === 'number' ? (v < 1e11 ? v * 1000 : v) : Date.parse(v) || 0);

/** Strips in board order: wait, work, idle; live before faded; newest first inside a lane. */
export function boardOrder(strips) {
  return [...strips].sort((a, b) => (ORDER[a.lane] ?? 3) - (ORDER[b.lane] ?? 3) || Number(Boolean(a.faded)) - Number(Boolean(b.faded)) || ms(b.since) - ms(a.since));
}

/** A board ({ strips, hosts, totals, manager }) from a native.board result. */
export function fromNativeBoard(r) {
  const strips = boardOrder((r?.strips ?? []).map((s) => ({ ...s, headline: s.headline ?? s.tail?.[0] ?? '' })));
  return { strips, hosts: r?.hosts ?? [], totals: r?.totals ?? totalsOf(strips), manager: r?.manager ?? null, generatedAt: r?.generatedAt ?? null, source: 'native.board' };
}

/** The same board from fleet.summary, for a daemon without native.board. notifies: sessionId -> latest ask. */
export function fromFleet(fleet, { notifies = {}, finished = {}, now = Date.now() } = {}) {
  const strips = [];
  const hosts = [];
  for (const hs of fleet?.hosts ?? []) {
    const own = stripsFor(hs, notifies, now, finished).map((s) => ({ ...s, headline: s.question ?? s.ask?.text ?? s.finished?.text ?? s.tail?.at(-1) ?? s.status ?? '' }));
    strips.push(...own);
    hosts.push({ name: hs.host, up: hs.ok !== false, waiting: own.filter((s) => s.lane === 'wait').length, working: own.filter((s) => s.lane === 'work').length, idle: own.filter((s) => s.lane === 'idle').length, ...(hs.ok === false ? { error: hs.error ?? 'unreachable' } : {}), ...(hs.fallback ? { stale: true } : {}) });
  }
  const ordered = boardOrder(strips);
  return { strips: ordered, hosts, totals: totalsOf(ordered, hosts.length), manager: null, generatedAt: fleet?.ts ?? null, source: 'fleet.summary' };
}
function totalsOf(strips, hosts) {
  return { waiting: strips.filter((s) => s.lane === 'wait').length, working: strips.filter((s) => s.lane === 'work').length, idle: strips.filter((s) => s.lane === 'idle').length, hosts: hosts ?? new Set(strips.map((s) => s.host)).size };
}

/** Strips grouped by lane, each lane in board order. */
export function lanesOf(strips) {
  const out = { wait: [], work: [], idle: [] };
  for (const s of boardOrder(strips)) (out[s.lane] ?? out.idle).push(s);
  return out;
}

const KEY_LABEL = { Enter: 'approve', Escape: 'deny', y: 'yes', n: 'no', Up: 'up', Down: 'down', Tab: 'tab', Space: 'tick' };

/**
 * The keys that answer a strip's dialog, in display order: [{ key, label, hint, selected }]. From the daemon's
 * keys when it sent them (native.board), else from the parsed dialog: its option digits, Enter, Escape. A held
 * peer message takes Enter (deliver) and Escape (drop). A question asked in text (answer: "reply") takes none.
 */
export function answerKeys(strip) {
  if (!strip || strip.lane !== 'wait' || strip.answer === 'reply') return [];
  const options = strip.dialog?.options ?? [];
  let keys = Array.isArray(strip.keys) ? strip.keys.map(String) : null;
  if (!keys) {
    if (strip.held) keys = ['Enter', 'Escape'];
    else if (options.length) keys = [...options.map((o) => String(o.n)).filter((k) => /^[1-9]$/.test(k)), 'Enter', 'Escape'];
    else if (strip.screen === 'dialog' || strip.answer === 'keys' || strip.dialog) keys = ['Enter', 'Escape'];
    else return [];
    if (/\(y\/n\)|\[y\/n\]/i.test(strip.dialog?.question ?? '')) keys.push('y', 'n');
  }
  const selected = options.find((o) => o.selected);
  return keys.map((key) => {
    if (/^[1-9]$/.test(key)) { const o = options.find((x) => String(x.n) === key); return { key, label: o?.label ?? `option ${key}`, hint: o?.label ?? `option ${key}`, selected: Boolean(o?.selected) }; }
    if (strip.held && key === 'Enter') return { key, label: 'deliver', hint: 'deliver' };
    if (strip.held && key === 'Escape') return { key, label: 'drop', hint: 'drop' };
    if (key === 'Enter' && selected) return { key, label: 'approve', hint: `approve (${selected.n})` };
    return { key, label: KEY_LABEL[key] ?? key, hint: KEY_LABEL[key] ?? key };
  });
}

/**
 * The dialog key a key event answers on this strip, or null (the key then does what it does elsewhere). The space bar
 * ticks a multi-select option only where the daemon offers Space; elsewhere it keeps paging.
 */
export function dialogKeyFor(strip, ev) {
  const keys = answerKeys(strip).map((k) => k.key);
  if (!keys.length || !ev) return null;
  const k = ev.id === 'enter' ? 'Enter' : ev.id === 'escape' ? 'Escape' : ev.id === 'space' || ev.id === ' ' ? 'Space' : /^[1-9yn]$/.test(ev.id) ? ev.id : null;
  return k && keys.includes(k) ? k : null;
}

/**
 * A dialog key on the strip the last frame drew (drawn: { key, strip }); current is that strip as the board has it now
 * (null when it is gone). The press acts on exactly what was drawn, so it carries that frame's screen hash and a
 * dialog that changed since is refused by the daemon; when the strip is gone or no longer takes the key, nothing is
 * pressed, for it or for any other strip, and the owner is told. Returns false when ev is not a dialog key there.
 */
export function pressDrawn(app, current, drawn, ev, after) {
  const was = drawn?.strip ?? null;
  const k = was ? dialogKeyFor(was, ev) : null;
  const now = current ? dialogKeyFor(current, ev) : null;
  if (!k && !now) return false;
  if (k && now && current.key === was.key) { app.answer(was, k, after); return true; }
  app.toast(now ? 'the screen changed before that key; look again' : 'that dialog is gone; nothing was pressed', 'wait');
  return true;
}

const hostArg = (h) => (h && h !== 'local' ? { host: h } : {});

/**
 * The calls that press `key` on a strip: sessions.answer first (by session id, or the window target for an agent
 * seen only as a window), and tmux.answer on the strip's window for a daemon that does not know sessions.answer.
 * expect is the screen hash the strip was read with, so a changed screen refuses the press.
 */
export function answerPlan(strip, key) {
  const expect = strip.hash ? { expect: strip.hash } : {};
  const id = strip.kind === 'window' ? strip.tmux ?? strip.id : strip.sessionId ?? strip.id;
  return {
    primary: { op: 'sessions.answer', args: { id, key, ...expect, ...hostArg(strip.host) } },
    fallback: strip.tmux ? { op: 'tmux.answer', args: { target: strip.tmux, key, ...expect, ...hostArg(strip.host) } } : null,
  };
}

/** Press a key through a client: { ok, refused?, reason?, via }. Remembers an old daemon in caps.answer. */
export async function pressKey(client, strip, key, caps = {}) {
  const plan = answerPlan(strip, key);
  let r, via;
  if (caps.answer !== false) {
    try { r = await client.call(plan.primary.op, plan.primary.args); via = 'sessions.answer'; }
    catch (e) { if (!e.unknownOp || !plan.fallback) throw e; caps.answer = false; }
  }
  if (!r) {
    if (!plan.fallback) throw new Error('this daemon cannot answer dialogs and the strip has no tmux window');
    r = await client.call(plan.fallback.op, plan.fallback.args); via = 'tmux.answer';
  }
  return { ...r, via };
}

/** The message target of a strip for `r` (reply): the session inbox, or the pane of an agent seen as a window. */
export function replyPlan(strip, text) {
  if (strip.kind === 'window' || !(strip.sessionId ?? strip.id)) return strip.tmux ? { op: 'tmux.send', args: { target: strip.tmux, text, ...hostArg(strip.host) } } : null;
  return { op: 'sessions.message', args: { id: strip.sessionId ?? strip.id, text, ...hostArg(strip.host) } };
}
