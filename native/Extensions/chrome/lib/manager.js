// The manager conversation (UX overhaul contract), shared by the popup (its last exchange) and the side panel
// (the whole thread). Pure: a reducer over the send, the SSE stream and transcript reads.
//
// - sessions.message {id: "manager", text, wait: false} answers {pending, event, turnId}: the question is shown
//   at once (a local echo) and the reply streams as SSE `manager` events (phase start|delta|done|error, `text`
//   so far, turnId, inReplyTo), then lands as a `turn` event and in the transcript.
// - Turns are deduped by their event id; the local echo is replaced by the server copy, so nothing shows twice.
// - Older daemons answer inside the call ({reply}); a transcript read settles a reply the stream never delivered.

export const MANAGER_ID = 'manager';
export const MAIN = 'main';
const MAX = 200;

export const isMainThread = (t) => t == null || t === '' || t === MAIN;
const trim = (s) => String(s ?? '').trim();

export function managerInit() {
  return { turns: [], sending: false, seq: 0 };
}

/** A reply is being written, or the question is on its way. */
export const managerBusy = (s) => Boolean(s?.sending || s?.turns?.some((t) => t.role === 'assistant' && (t.pending || t.streaming)));

/** The newest question and the reply after it (the popup's box). */
export function lastExchange(s) {
  const turns = s?.turns ?? [];
  const qi = turns.findLastIndex((t) => t.role === 'user');
  const question = qi >= 0 ? turns[qi] : null;
  const reply = turns.slice(qi + 1).find((t) => t.role === 'assistant' || t.role === 'system') ?? (qi < 0 ? turns.findLast((t) => t.role === 'assistant') ?? null : null);
  return { question, reply };
}

function fromServer(t) {
  const role = t?.role === 'user' || t?.role === 'assistant' ? t.role : 'system';
  return {
    key: t.id ?? t.uuid ?? `s:${t.ts ?? ''}:${trim(t.text).slice(0, 40)}`,
    id: t.id ?? t.uuid ?? null,
    role,
    text: String(t.text ?? ''),
    ts: t.ts ?? null,
    actor: t.actor ?? (typeof t.user === 'string' && t.user.startsWith('drover:') ? t.user.slice(7) : null),
    inReplyTo: t.inReplyTo ?? null,
    turnId: t.turnId ?? null,
    pending: t.pending === true,
    streaming: t.pending === true,
    error: role === 'system' && /fail|error/i.test(t.text ?? '') ? String(t.text) : null,
    thread: t.thread ?? MAIN,
  };
}

const cap = (turns) => (turns.length > MAX ? turns.slice(-MAX) : turns);

/** The reply slot an event belongs to: its turn id, else the question it answers, else the reply in flight. */
function findReply(turns, { turnId, inReplyTo }) {
  if (turnId) { const i = turns.findIndex((t) => t.role === 'assistant' && (t.turnId === turnId || t.id === turnId)); if (i >= 0) return i; }
  if (inReplyTo) { const i = turns.findIndex((t) => t.role === 'assistant' && t.inReplyTo === inReplyTo); if (i >= 0) return i; }
  if (!inReplyTo) return turns.findLastIndex((t) => t.role === 'assistant' && (t.pending || t.streaming) && !t.turnId);
  // The question is known but its reply slot has no link yet (the stream raced the POST answer).
  const qi = turns.findIndex((t) => t.role === 'user' && t.id === inReplyTo);
  if (qi >= 0) return turns.findIndex((t, i) => i > qi && t.role === 'assistant' && (t.pending || t.streaming) && !t.inReplyTo);
  return turns.findLastIndex((t) => t.role === 'assistant' && t.local && (t.pending || t.streaming) && !t.turnId);
}

/** Put a server turn in: replace its copy (by id), adopt the local echo it confirms, or append it. */
function upsert(turns, turn) {
  const out = [...turns];
  if (turn.id) {
    const i = out.findIndex((t) => t.id === turn.id);
    if (i >= 0) { out[i] = { ...out[i], ...turn, local: false }; return out; }
  }
  if (turn.role === 'user') {
    const i = out.findIndex((t) => t.role === 'user' && t.local && !t.id && trim(t.text) === trim(turn.text));
    if (i >= 0) {
      out[i] = { ...out[i], ...turn, local: false };
      // Its reply slot now knows what it answers.
      const r = out.findIndex((t, j) => j > i && t.role === 'assistant' && t.local && !t.inReplyTo);
      if (r >= 0) out[r] = { ...out[r], inReplyTo: turn.id };
      return out;
    }
  }
  if (turn.role === 'assistant') {
    const i = findReply(out, turn);
    if (i >= 0) {
      const settled = !turn.pending;
      out[i] = { ...out[i], ...turn, key: out[i].key, local: false, streaming: !settled && (out[i].streaming || turn.pending), pending: !settled };
      return out;
    }
  }
  out.push(turn);
  return out;
}

/**
 * @param {ReturnType<typeof managerInit>} state
 * @param {{type:'send', text:string} | {type:'sent', res:any} | {type:'fail', message:string} | {type:'stream', data:any}
 *   | {type:'turn', data:any} | {type:'transcript', res:any}} action
 */
export function managerReduce(state, action) {
  const s = state ?? managerInit();
  switch (action?.type) {
    case 'send': {
      const text = trim(action.text);
      if (!text) return s;
      const seq = s.seq + 1;
      return {
        ...s, seq, sending: true,
        turns: cap([...s.turns,
          { key: `local:${seq}`, id: null, role: 'user', text, ts: new Date().toISOString(), actor: null, local: true, thread: MAIN },
          { key: `local:${seq}:reply`, id: null, role: 'assistant', text: '', ts: null, local: true, pending: true, streaming: false, inReplyTo: null, turnId: null, thread: MAIN }]),
      };
    }
    case 'sent': {
      const r = action.res ?? {};
      let turns = [...s.turns];
      const qi = turns.findLastIndex((t) => t.role === 'user' && t.local && !t.id);
      if (qi >= 0 && r.event) {
        if (turns.some((t) => t.id === r.event && !t.local)) turns.splice(qi, 1); // the server copy already arrived
        else turns[qi] = { ...turns[qi], id: r.event, key: r.event };
      }
      const ri = turns.findLastIndex((t) => t.role === 'assistant' && t.local && (t.pending || t.streaming));
      if (ri >= 0) {
        if (typeof r.reply === 'string') turns[ri] = { ...turns[ri], text: r.reply, pending: false, streaming: false, inReplyTo: turns[ri].inReplyTo ?? r.event ?? null };
        else turns[ri] = { ...turns[ri], turnId: turns[ri].turnId ?? r.turnId ?? null, inReplyTo: turns[ri].inReplyTo ?? r.event ?? null };
      }
      return { ...s, sending: false, turns };
    }
    case 'fail': {
      const turns = [...s.turns];
      const ri = turns.findLastIndex((t) => t.role === 'assistant' && t.local && (t.pending || t.streaming));
      const message = trim(action.message) || 'Could not send.';
      if (ri >= 0) turns[ri] = { ...turns[ri], role: 'system', text: `Not sent: ${message}`, error: message, pending: false, streaming: false };
      else turns.push({ key: `err:${s.seq}`, id: null, role: 'system', text: `Not sent: ${message}`, error: message, thread: MAIN });
      return { ...s, sending: false, turns };
    }
    case 'stream': {
      const e = action.data ?? {};
      if (!isMainThread(e.thread)) return s;
      const turns = [...s.turns];
      let i = findReply(turns, e);
      if (i < 0) {
        if (!['start', 'delta', 'done'].includes(e.phase)) return s;
        // Someone else's question is being answered: its reply joins the thread.
        turns.push({ key: `stream:${e.turnId ?? s.seq}`, id: null, role: 'assistant', text: '', ts: new Date().toISOString(), pending: true, streaming: true, inReplyTo: e.inReplyTo ?? null, turnId: e.turnId ?? null, thread: MAIN });
        i = turns.length - 1;
      }
      const t = { ...turns[i], turnId: turns[i].turnId ?? e.turnId ?? null, inReplyTo: turns[i].inReplyTo ?? e.inReplyTo ?? null };
      if (e.phase === 'start') { if (t.pending) { t.streaming = true; if (typeof e.text === 'string') t.text = e.text; } }
      else if (e.phase === 'delta') { if (t.pending) { t.streaming = true; t.text = typeof e.text === 'string' ? e.text : t.text + String(e.delta ?? ''); } }
      else if (e.phase === 'done') { if (typeof e.text === 'string') t.text = e.text; t.pending = false; t.streaming = false; }
      else if (e.phase === 'error') { t.role = 'system'; t.error = trim(e.error) || 'The manager did not answer.'; t.text = `Not answered: ${t.error}`; t.pending = false; t.streaming = false; }
      else return s;
      turns[i] = t;
      return { ...s, turns };
    }
    case 'turn': {
      const d = action.data ?? {};
      if (d.id !== MANAGER_ID || !d.turn) return s;
      const turn = fromServer({ ...d.turn, thread: d.turn.thread ?? d.thread });
      if (!isMainThread(turn.thread)) return s;
      return { ...s, turns: cap(upsert(s.turns, turn)) };
    }
    case 'transcript': {
      const raw = Array.isArray(action.res?.turns) ? action.res.turns : [];
      let turns = [...s.turns];
      for (const t of raw) {
        if (!t || typeof t !== 'object' || (t.role !== 'user' && t.role !== 'assistant' && t.role !== 'system')) continue;
        const turn = fromServer(t);
        if (!isMainThread(turn.thread)) continue;
        turns = upsert(turns, turn);
      }
      // The page is the newest turns: older confirmed turns first, then the page in its own order, then what the
      // server has not confirmed yet (a local echo, a reply still streaming).
      const order = new Map(raw.map((t, i) => [t?.id ?? t?.uuid, i]));
      const page = turns.filter((t) => t.id && order.has(t.id)).sort((a, b) => order.get(a.id) - order.get(b.id));
      const older = turns.filter((t) => t.id && !order.has(t.id) && !t.local);
      const unconfirmed = turns.filter((t) => !t.id || (t.local && !order.has(t.id)));
      return { ...s, turns: cap([...older, ...page, ...unconfirmed]) };
    }
    default:
      return s;
  }
}
