// Stalled work, judged from the board data a host already serves (fleet.summary): what is waiting on the owner but
// does not show as waiting, because nothing on screen is a dialog. Three kinds, each from one clear signal:
//
//   unsent-input  typed into an agent's input box and never submitted: the box holds plain (not faint) text, the
//                 agent is not working, and its window has not changed for inputMinutes (tmux.windows input)
//   owner-ask     the session's final reply asks the owner something (ownerAsk in notify-policy.js: a closing
//                 question, or a hand-over such as "Decision for you" or "say go") and it has sat idle since, for
//                 askMinutes. The board's wait lane holds such an ask only while its alert is fresh (lanes.js).
//   unfinished    a session launched through Drover with a completion text (launch.start done) that died, or has
//                 been idle for unfinishedMinutes, and whose final reply does not contain that text
//
// Pure: read only, no clock but `now`, so node --test covers it (test/stalls.test.js). It reports; what to do about
// an item stays with the owner or the agent reading it.

export const STALL_DEFAULTS = Object.freeze({ inputMinutes: 5, askMinutes: 10, unfinishedMinutes: 30, launchDays: 3 });
export const STALL_KINDS = ['unsent-input', 'owner-ask', 'unfinished'];

const toMs = (v) => (v == null || v === '' ? 0 : typeof v === 'number' ? (v < 1e11 ? v * 1000 : v) : Date.parse(v) || 0);
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
const windowOf = (t) => String(t ?? '').replace(/\.%\d+$/, '');
const lastLine = (text, max = 200) => {
  const l = String(text ?? '').split('\n').map((x) => x.replace(/^[#>*\-\s`]+/, '').trim()).filter(Boolean).at(-1) ?? '';
  return l ? (l.length > max ? l.slice(0, max - 1) + '…' : l) : null;
};
const DONE_MAX = 200;

/**
 * The completion texts launches declared, by session id: { done, ts, name } for each launch in the last `days` days
 * that named one. Read from the truth file: a launch event (written where the launch ran) and the front's op record
 * of a launch.start it forwarded to another host (the same launch; the newest declaration wins).
 */
export function launchDeclarations(events = [], { now = Date.now(), days = STALL_DEFAULTS.launchDays } = {}) {
  const cutoff = now - days * 86400_000;
  const out = new Map();
  for (const e of events) {
    if (!e || toMs(e.ts) < cutoff) continue;
    const fromLaunch = e.type === 'launch' && typeof e.done === 'string';
    // The op record counts only when the host echoed done back: one on older code ignores it (doneIgnored).
    const fromOp = e.type === 'op' && e.op === 'launch.start' && e.ok !== false && typeof e.result?.done === 'string';
    if (!fromLaunch && !fromOp) continue;
    const sid = e.result?.sessionId;
    const done = (fromLaunch ? e.done : e.result.done).trim();
    if (typeof sid !== 'string' || !sid || !done) continue;
    const cur = out.get(sid);
    if (!cur || toMs(e.ts) >= toMs(cur.ts)) out.set(sid, { done: done.slice(0, DONE_MAX), ts: e.ts, name: (fromLaunch ? e.result?.name : e.args?.name) ?? null });
  }
  return out;
}

/**
 * The stalled items of one host's board data ({ host, sessions, windows }), oldest first:
 * { kind, host, id, sessionId, name, engine, tmux, since, minutes, text, why?, done?, ended?, launchedAt? }.
 * text is what the owner needs to read: the unsent input, the line that asks, or the final reply's last line.
 */
export function stallsFor(hostSummary, { now = Date.now(), declared = new Map(), ...opts } = {}) {
  const t = { ...STALL_DEFAULTS, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => Number.isFinite(v) && v >= 0)) };
  const { host = null, sessions = [], windows = [] } = hostSummary ?? {};
  const byId = new Map(sessions.filter((s) => s?.sessionId ?? s?.id).map((s) => [s.sessionId ?? s.id, s]));
  const winOf = (s) => windows.find((w) => w.agent?.sessionId && w.agent.sessionId === (s.sessionId ?? s.id)) ?? (s.tmux ? windows.find((w) => w.target === windowOf(s.tmux) || `${w.session}:${w.windowId}` === windowOf(s.tmux)) : null);
  const waitingOnScreen = (w) => w?.screen?.state === 'dialog' || Boolean(w?.held);
  const out = [];
  const item = (kind, s, w, sinceMs, extra) => out.push({
    kind, host, id: s?.id ?? w?.target ?? null, sessionId: s?.sessionId ?? w?.agent?.sessionId ?? null, name: s?.name ?? w?.agent?.name ?? w?.name ?? null,
    engine: s?.engine ?? w?.agent?.engine ?? null, tmux: w?.target ?? (s?.tmux ? windowOf(s.tmux) : null), since: iso(sinceMs), minutes: Math.floor((now - sinceMs) / 60_000), ...extra,
  });

  // 1. Typed and never sent. A working agent may hold typed text on purpose (it is read when the turn ends), and a
  //    window that changed recently is someone typing: neither counts.
  for (const w of windows) {
    if (!w?.agent || !w.input?.text || waitingOnScreen(w) || w.screen?.state === 'busy') continue;
    const s = w.agent.sessionId ? byId.get(w.agent.sessionId) : null;
    if ((s?.status ?? w.agent.status) === 'busy') continue;
    const quiet = toMs(w.activityTs);
    if (!quiet || now - quiet < t.inputMinutes * 60_000) continue;
    item('unsent-input', s, w, quiet, { text: w.input.text });
  }

  for (const s of sessions) {
    if (s?.engine !== 'claude' || s.status === 'busy') continue;
    const w = winOf(s);
    const replyMs = toMs(s.reply?.ts), quietMs = Math.max(replyMs, toMs(s.statusUpdatedAt));
    // 2. The final reply asks the owner, and nobody answered. A dialog on screen is already in the wait lane, and a
    //    helper run (claude -p) has nobody to ask.
    if (s.live && s.reply?.ask?.line && !waitingOnScreen(w) && s.entrypoint !== 'sdk-cli' && quietMs && now - quietMs >= t.askMinutes * 60_000) {
      item('owner-ask', s, w, quietMs, { text: s.reply.ask.line, why: s.reply.ask.why ?? null });
    }
    // 3. Launched with a completion text that its final reply does not hold: it died (a dead process: a crash, a lost
    //    credential, a reboot), or it has been idle too long. Judged only on a reply the host could read: one that
    //    exited cleanly is no longer listed, and one whose transcript was not found (or a host on older code) sent none.
    const d = declared.get(s.sessionId ?? s.id);
    if (!d || !s.reply) continue;
    const ended = s.live === false;
    const sinceMs = quietMs || toMs(d.ts);
    if (!ended && (!quietMs || now - quietMs < t.unfinishedMinutes * 60_000)) continue;
    if (String(s.reply?.end ?? '').includes(d.done)) continue;
    item('unfinished', s, w, sinceMs, { text: lastLine(s.reply?.end), done: d.done, ended, launchedAt: d.ts });
  }
  return out.sort((a, b) => toMs(a.since) - toMs(b.since));
}
