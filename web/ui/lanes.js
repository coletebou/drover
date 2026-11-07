// Board lanes, shared by the board, the waiting PiP window and the badge count:
// every live agent on a host becomes a strip in "wait" (a dialog is open, a peer
// message is held, the agent asked through the Notification hook, or a Grok bot
// asks for approval), "work" (busy) or "idle".
import { tmuxWindowTarget, isWindow } from './transcript.js';
import { classifyAsk, ASK_LABELS } from './notify-policy.js';

export const NOTIFY_FRESH_MS = 20 * 60_000;

/** Merge one host's sessions and windows into strips. notifyMap: sessionId -> latest hook/agent ask. */
/** What a hook/agent ask says, for events from before ask context existed too. */
function askOfNotify(n) {
  if (n.ask) return n.ask;
  return { kind: 'decision', label: n.kind === 'agent' ? ASK_LABELS.question : ASK_LABELS.decision, text: n.title ? `${n.title}${n.message ? ': ' + n.message : ''}` : n.message ?? '', options: [] };
}

/**
 * What an agent with no pane that reports its own state (a Grok bot) is waiting on: needs-owner and blocked hold it in
 * the wait lane until its next status, not only while the alert it raised is fresh.
 */
function reportedAsk(s) {
  if (s.engine !== 'grok' || s.status !== 'waiting') return null;
  return { kind: 'decision', label: s.state === 'blocked' ? 'is blocked' : 'needs you', text: s.summary ?? '', options: [] };
}

/**
 * A Grok bot's oldest pending approval request (core/bots/approvals.js) as the strip's ask: its question and options.
 * It holds the strip in the wait lane until it is answered, withdrawn or expired, whatever alert came before or after.
 */
function approvalAsk(a) {
  return { kind: 'decision', label: 'asks for your approval', text: a.question ?? '', options: (a.options ?? []).map((o) => ({ n: o.n, label: o.label })) };
}

/** The tail of an agent with no pane (a Grok bot): why it went stale, else the summary it last reported. */
function reportedTail(s) {
  if (s.stale?.reason) return [`stale: ${s.stale.reason}`];
  return s.summary ? [s.summary] : [];
}

/** finishedMap: sessionId -> the latest finished alert (its excerpt shows on idle strips). */
export function stripsFor(hostSummary, notifyMap = {}, now = Date.now(), finishedMap = {}) {
  const { host, sessions = [], windows = [] } = hostSummary ?? {};
  const byWin = new Map(windows.filter((w) => w.agent?.sessionId).map((w) => [w.agent.sessionId, w]));
  const out = [];
  const seen = new Set();
  for (const s of sessions) {
    if (!s.live) continue;
    const w = byWin.get(s.sessionId ?? s.id) ?? (s.tmux ? windows.find((x) => isWindow(x, tmuxWindowTarget(s.tmux))) : null);
    const screen = w?.screen?.state;
    // An approval request's alert is not an ask of its own: the request is (approvals below), while it is pending.
    const n0 = notifyMap[s.sessionId ?? s.id];
    const n = n0?.kind === 'approval' ? null : n0;
    const approvals = s.engine === 'grok' && Array.isArray(s.approvals) ? s.approvals : [];
    const approval = approvals[0] ?? null;
    // An ask stands until the session moves on: a status change after it (it got its
    // answer and worked) clears it, unless the screen still shows the dialog.
    const toMs = (v) => (v == null ? 0 : typeof v === 'number' ? (v < 1e11 ? v * 1000 : v) : Date.parse(v) || 0);
    const movedOn = n && toMs(s.statusUpdatedAt) > Date.parse(n.ts) + 2000 && screen !== 'dialog';
    const asked = n && now - Date.parse(n.ts) < NOTIFY_FRESH_MS && s.status !== 'busy' && !movedOn;
    // The ask: the screen wins (a live dialog), then a bot's approval request, then a hook or agent ask with real
    // context, then what a bot reports.
    const ask = screen === 'dialog' || w?.held ? classifyAsk({ screenState: screen, dialog: w?.dialog, held: w?.held, heldFrom: w?.heldFrom }) : approval ? approvalAsk(approval) : asked ? askOfNotify(n) : reportedAsk(s);
    const waits = ask && ask.kind !== 'finished';
    const lane = waits ? 'wait' : (s.status === 'busy' || screen === 'busy') ? 'work' : s.engine === 'codex' && /active|running/i.test(s.status) ? 'work' : 'idle';
    const fin = lane === 'idle' ? finishedMap[s.sessionId ?? s.id] : null;
    const finished = fin && now - Date.parse(fin.ts) < 2 * 3600_000 ? { text: fin.ask?.text ?? fin.body ?? '', ts: fin.ts } : null;
    out.push({
      key: `${host}|${s.id}`, host, lane, engine: s.engine ?? s.kind, name: s.name ?? s.preview ?? String(s.id).slice(0, 8), id: s.id, sessionId: s.sessionId ?? s.id, status: s.status, screen, entrypoint: s.entrypoint ?? null,
      tmux: w?.target ?? tmuxWindowTarget(s.tmux), windowName: w?.name, held: Boolean(w?.held), heldFrom: w?.heldFrom ?? null, dialog: w?.dialog ?? null, hash: w?.hash ?? null,
      ask: waits ? ask : null, finished,
      tail: waits ? [ask.text, ...(w?.tail ?? []).slice(-1)].filter(Boolean) : finished?.text ? [finished.text] : (w?.tail ?? reportedTail(s)), question: waits ? ask.text : null,
      since: approval ? Date.parse(approval.createdAt) : asked && !w?.held && screen !== 'dialog' ? Date.parse(n.ts) : (s.statusUpdatedAt ?? s.updatedAt ?? s.startedAt ?? w?.activityTs), cwd: s.cwd ?? w?.cwd, kind: 'session', asked: Boolean(waits),
      // A Grok bot's replies the owner has not read (read receipts, core/bots/grok.js).
      ...(s.engine === 'grok' && Number(s.unread) > 0 ? { unread: Number(s.unread) } : {}),
      // Answered with one tap (answer-model.js approvalModel): the oldest pending request, and how many wait behind it.
      ...(approval ? { approval, answer: 'approval', ...(approvals.length > 1 ? { moreApprovals: approvals.length - 1 } : {}) } : {}),
    });
    if (w) seen.add(w.target);
  }
  // Windows with an agent that matched no live session still get a strip, faded.
  for (const w of windows) {
    if (seen.has(w.target) || !w.agent) continue;
    const lane = w.screen?.state === 'dialog' || w.held ? 'wait' : w.screen?.state === 'busy' ? 'work' : 'idle';
    const ask = lane === 'wait' ? classifyAsk({ screenState: w.screen?.state, dialog: w.dialog, held: w.held, heldFrom: w.heldFrom }) : null;
    out.push({ key: `${host}|${w.target}`, host, lane, ask, engine: w.agent.engine ?? 'shell', name: w.agent.name ?? w.name, id: w.target, sessionId: w.agent.sessionId, status: w.agent.status ?? w.screen?.state, screen: w.screen?.state, tmux: w.target, windowName: w.name, held: Boolean(w.held), heldFrom: w.heldFrom ?? null, dialog: w.dialog ?? null, hash: w.hash ?? null, tail: ask ? [ask.text, ...(w.tail ?? []).slice(-1)] : w.tail ?? [], question: ask?.text ?? null, since: w.activityTs, cwd: w.cwd, kind: 'window', faded: !w.agent.sessionId });
  }
  return out;
}

/** Every strip across the fleet summary (falls back to the local snapshot before the first fleet event). */
export function allStrips(state, now = Date.now()) {
  const notifyMap = state?.notifies ?? {};
  const fin = state?.finished ?? {};
  if (state?.fleet?.hosts?.length) return state.fleet.hosts.flatMap((hs) => stripsFor(hs, notifyMap, now, fin));
  if (state?.snapshot) return stripsFor({ host: 'local', sessions: state.snapshot.sessions ?? [], windows: state.snapshot.windows ?? [] }, notifyMap, now, fin);
  return [];
}

export function waiting(state, now = Date.now()) { return allStrips(state, now).filter((s) => s.lane === 'wait'); }
/** Idle strips that finished recently, newest first (the quieter "Finished" list). */
export function recentlyFinished(state, now = Date.now(), withinMs = 3600_000) { return allStrips(state, now).filter((s) => s.lane === 'idle' && s.finished && now - Date.parse(s.finished.ts) < withinMs).sort((a, b) => Date.parse(b.finished.ts) - Date.parse(a.finished.ts)); }
