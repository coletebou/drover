// One manager conversation (a thread) as the TUI shows it, merged from four sources that overlap: the local echo of
// what the owner typed, the sessions.message answer ({ pending, event, turnId }), the `manager` stream events
// (start/delta/done/error) and the `turn` events and transcript reloads with the final turns. Each turn shows
// once: a user turn is matched by its event id (or, before the answer names it, by its text), a reply by the
// message it answers (inReplyTo) or its turn id, and the final reply replaces the pending one in place. A daemon
// that predates async replies answers sessions.message with the reply itself; that lands the same way.
// Pure; tests in test/tui-manager.test.js.

let seq = 0;
const nextKey = () => `local-${++seq}`;
const msOf = (ts) => (typeof ts === 'number' ? (ts < 1e11 ? ts * 1000 : ts) : Date.parse(ts ?? '') || 0);

export class Convo {
  constructor(thread = 'main', { onChange } = {}) { this.thread = thread; this.turns = []; this.version = 0; this.onChange = onChange ?? null; }

  #touch() { this.version++; this.onChange?.(); }
  #indexOf(pred) { return this.turns.findIndex(pred); }
  /** Insert a turn where its time puts it (most land at the end). */
  #insert(t) {
    const at = msOf(t.ts);
    let i = this.turns.length;
    while (i > 0 && at && msOf(this.turns[i - 1].ts) > at && !this.turns[i - 1].local) i--;
    this.turns.splice(i, 0, t);
  }
  #replyIndex({ inReplyTo, turnId, id }) {
    return this.#indexOf((x) => x.role === 'assistant' && ((inReplyTo && x.inReplyTo === inReplyTo) || (turnId && (x.turnId === turnId || x.id === turnId)) || (id && (x.id === id || x.turnId === id))));
  }

  /**
   * A turn from the daemon (transcript or `turn` event). A failed reply comes as a system turn that answers the
   * message (inReplyTo): it takes the place of the pending reply. Returns true when something changed.
   */
  server(t) {
    if (!t || (t.thread && t.thread !== this.thread)) return false;
    const role = t.role === 'user' || t.role === 'assistant' || t.role === 'system' ? t.role : 'assistant';
    const turn = { ...t, role, text: typeof t.text === 'string' ? t.text : '', key: t.id ?? null, ...(role === 'system' ? { style: t.error ? 'err' : 'dim' } : {}) };
    let i = t.id ? this.#indexOf((x) => x.id === t.id) : -1;
    if (i < 0 && role === 'user') i = this.#indexOf((x) => x.local && x.role === 'user' && !x.id && x.text === turn.text);
    if (i < 0 && role === 'assistant') i = this.#replyIndex(t);
    if (i < 0 && role === 'system' && t.inReplyTo) i = this.#replyIndex({ inReplyTo: t.inReplyTo });
    if (i < 0 && !t.id) i = this.#indexOf((x) => x.role === role && x.text === turn.text && msOf(x.ts) === msOf(t.ts));
    if (i >= 0) {
      const old = this.turns[i];
      // A late pending copy (a transcript read during the stream) never overwrites a final reply.
      if (t.pending && old.role === 'assistant' && !old.pending && old.text) return false;
      this.turns[i] = { ...old, ...turn, key: old.key, local: false, sending: false, pending: Boolean(t.pending), waiting: t.pending ? old.waiting : null };
    } else this.#insert({ ...turn, key: turn.key ?? nextKey(), pending: Boolean(t.pending) });
    this.#touch(); return true;
  }

  /** Replace what is known from a transcript read (turns of this thread, oldest first). */
  load(turns) {
    const local = this.turns.filter((x) => x.local || x.role === 'system');
    this.turns = [];
    for (const t of turns ?? []) this.server(t);
    // Keep what the daemon has not confirmed yet: an echo still sending, a reply still streaming, local notes.
    for (const x of local) if (!this.turns.some((y) => (x.id && y.id === x.id) || (x.inReplyTo && y.inReplyTo === x.inReplyTo && y.role === x.role))) this.#insert(x);
    this.#touch();
  }

  /** The local echo of a message the owner sent; returns its key. */
  send(text, ts = new Date().toISOString()) {
    const key = nextKey();
    this.turns.push({ key, role: 'user', text, ts, local: true, sending: true });
    this.#touch(); return key;
  }

  /** The sessions.message answer for an echo: names the event, opens the pending reply (or lands a blocking one). */
  sent(key, r = {}) {
    const i = this.#indexOf((x) => x.key === key); if (i < 0) return;
    const echo = this.turns[i];
    const id = r.event ?? echo.id ?? null;
    // The daemon's `turn` event may have landed first: then the echo is a duplicate of it.
    const dup = id ? this.#indexOf((x) => x !== echo && x.id === id) : -1;
    if (dup >= 0) this.turns.splice(i, 1);
    else this.turns[i] = { ...echo, id, sending: false };
    const w = this.#indexOf((x) => x.localFor === key);
    if (typeof r.reply === 'string') {
      // A daemon from before async replies: the reply came back in the call.
      const reply = { role: 'assistant', text: r.reply, ts: new Date().toISOString(), inReplyTo: id, model: r.model, thread: this.thread };
      if (w >= 0) this.turns.splice(w, 1);
      this.server(reply);
    } else if (r.pending !== false && id && this.#replyIndex({ inReplyTo: id, turnId: r.turnId }) < 0) {
      if (w >= 0) this.turns[w] = { ...this.turns[w], inReplyTo: id, turnId: r.turnId ?? null, waiting: 'stream', localFor: null };
      else this.turns.push({ key: nextKey(), role: 'assistant', text: '', ts: new Date().toISOString(), pending: true, inReplyTo: id, turnId: r.turnId ?? null, waiting: 'stream' });
    } else if (w >= 0) this.turns.splice(w, 1);
    this.#touch();
  }

  /**
   * The call is still open after a moment, as on a daemon that answers in the call itself: the echo counts as
   * sent and a reply is awaited (sent() fills it, or gives it the ids of a stream that does come).
   */
  waitingBlocking(key) {
    const i = this.#indexOf((x) => x.key === key); if (i < 0) return;
    this.turns[i] = { ...this.turns[i], sending: false };
    if (!this.turns.some((x) => x.localFor === key)) this.turns.push({ key: nextKey(), role: 'assistant', text: '', ts: new Date().toISOString(), pending: true, localFor: key, waiting: 'blocking' });
    this.#touch();
  }

  /** sessions.message failed: the echo says so. */
  failed(key, message) {
    const i = this.#indexOf((x) => x.key === key); if (i < 0) return;
    this.turns[i] = { ...this.turns[i], sending: false, error: message };
    const w = this.#indexOf((x) => x.localFor === key); if (w >= 0) this.turns.splice(w, 1);
    this.#touch();
  }

  /** A `manager` stream event: { thread, turnId, inReplyTo, phase, delta?, text?, error? }. */
  stream(ev) {
    if (!ev || (ev.thread ?? 'main') !== this.thread) return false;
    let i = this.#replyIndex(ev);
    if (i >= 0 && !this.turns[i].pending && ev.phase !== 'error') return false;   // already final
    if (i < 0) {
      if (ev.phase === 'done' && !ev.text) return false;
      const t = { key: nextKey(), role: 'assistant', text: '', ts: new Date().toISOString(), pending: true, inReplyTo: ev.inReplyTo ?? null, turnId: ev.turnId ?? null };
      const after = ev.inReplyTo ? this.#indexOf((x) => x.id === ev.inReplyTo) : -1;
      if (after >= 0) this.turns.splice(after + 1, 0, t); else this.turns.push(t);
      i = this.turns.indexOf(t);
    }
    const t = { ...this.turns[i], turnId: this.turns[i].turnId ?? ev.turnId ?? null, inReplyTo: this.turns[i].inReplyTo ?? ev.inReplyTo ?? null, waiting: null };
    if (ev.phase === 'delta') t.text = typeof ev.text === 'string' ? ev.text : t.text + (ev.delta ?? '');
    else if (ev.phase === 'done') { if (typeof ev.text === 'string') t.text = ev.text; t.pending = false; if (ev.id) t.id = ev.id; }
    else if (ev.phase === 'error') { t.pending = false; t.error = ev.error ?? 'the manager failed'; if (ev.id) t.id = ev.id; }
    this.turns[i] = t;
    this.#touch(); return true;
  }

  /** A local note in the conversation (/status output, a thread switch): never sent, kept across reloads. */
  system(text, style = 'dim') { this.turns.push({ key: nextKey(), role: 'system', text, ts: new Date().toISOString(), style, local: true }); this.#touch(); }

  /**
   * Bound the turns kept (a popup manager runs for days): past max, keep the newest keep, never a reply still in
   * flight or a message still sending. The daemon keeps the whole conversation; this is only what is on hand.
   */
  prune({ keep = 400, max = 600 } = {}) {
    if (this.turns.length <= max) return false;
    const cut = this.turns.length - keep;
    this.turns = [...this.turns.slice(0, cut).filter((t) => t.pending || t.sending), ...this.turns.slice(cut)];
    this.version++;   // no onChange: the view prunes while drawing
    return true;
  }

  /** A reply is in flight. */
  get busy() { return this.turns.some((t) => t.role === 'assistant' && t.pending) || this.turns.some((t) => t.sending); }

  /** Turns as chat.js turns: manager replies as assistant text, notes as notes. */
  chatTurns() {
    return this.turns.map((t) => (t.role === 'system' ? { role: 'note', text: t.text, ts: t.ts, uuid: t.key, style: t.style ?? (t.error ? 'err' : 'dim') }
      : { ...t, uuid: t.key, who: t.role === 'assistant' ? 'manager' : undefined, text: t.role === 'assistant' && t.pending && !t.text ? '' : t.text }));
  }
}
