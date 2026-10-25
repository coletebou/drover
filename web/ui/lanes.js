// Board lanes, shared by the board, the waiting PiP window and the badge count:
// every live agent on a host becomes a strip in "wait" (a dialog is open, a peer
// message is held, or the agent asked through the Notification hook), "work"
// (busy) or "idle".
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
    // A prompt the session reports itself (a Hermes approval or question its gateway holds, core/hermes.js) is what it
    // waits on, whatever a pane shows; one answered with keys counts as a dialog on screen, one answered in text as a question.
    const own = s.dialog && s.hash && (s.dialog.question || s.dialog.options?.length) ? s : null;
    const screen = own ? (own.answer === 'reply' ? undefined : 'dialog') : w?.screen?.state;
    const n = notifyMap[s.sessionId ?? s.id];
    // An ask stands until the session moves on: a status change after it (it got its
    // answer and worked) clears it, unless the screen still shows the dialog.
    const toMs = (v) => (v == null ? 0 : typeof v === 'number' ? (v < 1e11 ? v * 1000 : v) : Date.parse(v) || 0);
    const movedOn = n && toMs(s.statusUpdatedAt) > Date.parse(n.ts) + 2000 && screen !== 'dialog';
    const asked = n && now - Date.parse(n.ts) < NOTIFY_FRESH_MS && s.status !== 'busy' && !movedOn;
    // The ask: the screen wins (a live dialog), then a hook or agent ask with real context, then what a bot reports.
    const ask = own ? (own.prompt?.kind === 'clarify' ? classifyAsk({ pendingAsk: own.dialog }) : classifyAsk({ screenState: 'dialog', dialog: own.dialog }))
      : screen === 'dialog' || w?.held ? classifyAsk({ screenState: screen, dialog: w?.dialog, held: w?.held, heldFrom: w?.heldFrom }) : asked ? askOfNotify(n) : reportedAsk(s);
    const waits = ask && ask.kind !== 'finished';
    const lane = waits ? 'wait' : (s.status === 'busy' || screen === 'busy') ? 'work' : s.engine === 'codex' && /active|running/i.test(s.status) ? 'work' : 'idle';
    const fin = lane === 'idle' ? finishedMap[s.sessionId ?? s.id] : null;
    const finished = fin && now - Date.parse(fin.ts) < 2 * 3600_000 ? { text: fin.ask?.text ?? fin.body ?? '', ts: fin.ts } : null;
    out.push({
      key: `${host}|${s.id}`, host, lane, engine: s.engine ?? s.kind, name: s.name ?? s.preview ?? String(s.id).slice(0, 8), id: s.id, sessionId: s.sessionId ?? s.id, status: s.status, screen, entrypoint: s.entrypoint ?? null,
      tmux: w?.target ?? tmuxWindowTarget(s.tmux), windowName: w?.name, held: Boolean(!own && w?.held), heldFrom: own ? null : w?.heldFrom ?? null, dialog: own?.dialog ?? w?.dialog ?? null, hash: own?.hash ?? w?.hash ?? null,
      ...(own ? { reported: true, ...(Array.isArray(own.keys) ? { keys: own.keys } : {}), ...(own.answer === 'reply' ? { answer: 'reply' } : {}) } : {}),
      ask: waits ? ask : null, finished,
      tail: waits ? [ask.text, ...(w?.tail ?? []).slice(-1)].filter(Boolean) : finished?.text ? [finished.text] : (w?.tail ?? reportedTail(s)), question: waits ? ask.text : null,
      since: asked && !w?.held && screen !== 'dialog' && !own ? Date.parse(n.ts) : (s.statusUpdatedAt ?? s.updatedAt ?? s.startedAt ?? w?.activityTs), cwd: s.cwd ?? w?.cwd, kind: 'session', asked: Boolean(waits),
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
