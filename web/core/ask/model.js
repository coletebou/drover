// Asks: a question an agent puts to the owner by text message (Telegram, iMessage, SMS) and the answer that comes
// back. This file is the pure part: the shape of an ask event, the fold of the truth file into asks, the short codes
// the owner answers with, and every text that is sent. No I/O here; core/ask/router.js and core/ask/ops.js do that.
//
// One event type, `ask`, with a phase (docs/ask.md):
//   created    the asking host recorded the question (askId, questions, sessionId, urgency, expiresAt, channels)
//   routed     the hub took the ask and gave it a code; it carries a copy of the ask, so the hub's fold is whole
//   sent       a text went out on a channel (kind ask, batch, reminder, escalation, ack), or failed to
//   answered   a verified answer: source <owner>:<channel>, the provider's message id, the sender, the raw text
//   delivered  the answer reached the asking session (or did not, and why)
//   cancelled  the asker withdrew it; expired: nobody answered in time
//   inbound    a reply that was not taken as an answer (unverified sender, no matching ask): untrusted
//   control    the owner's own commands: pause asks for a while, stop, resume
import { OWNER_NAME } from '../owner.js';

export const PHASES = ['created', 'routed', 'sent', 'answered', 'delivered', 'cancelled', 'expired', 'inbound', 'control'];
export const CHANNELS = ['telegram', 'imessage', 'sms'];
export const URGENCY = ['normal', 'urgent'];
export const SEND_KINDS = ['ask', 'batch', 'reminder', 'escalation', 'ack', 'notice'];
export const CONTROL = ['pause', 'resume', 'stop'];
export const TERMINAL = new Set(['answered', 'cancelled', 'expired']);
export const LIMITS = Object.freeze({ questions: 9, options: 9, question: 600, option: 80, raw: 2000, answer: 2000, total: 1200 });
// What one text may hold on each channel (Twilio refuses a body over 1600 characters, Telegram a message over 4096).
export const TEXT_LIMITS = Object.freeze({ sms: 1600, telegram: 4096, imessage: 4000 });

// Codes are one letter and a number: K7. The letter rotates so a code is not reused for 24 asks; the number is the
// smallest one no open ask holds and no ask closed in the last REUSE_MS held, so "7b" (number only) cannot land on a
// newer question that took the number of one just answered. No I or O: they read as 1 and 0.
export const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const CODE_RE = /^([A-HJ-NP-Z])(\d{1,2})$/;
export const REUSE_MS = 30 * 60_000;
export const MAX_NUMBER = 99;

const isStr = (v) => typeof v === 'string';
const clip = (s, n) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** The questions of a create call: {question, options} or questions: [{question, options}]. Throws on bad input. */
export function normalizeQuestions({ question, options, questions } = {}) {
  let list;
  if (questions !== undefined) {
    if (question !== undefined) throw new Error('give question or questions, not both');
    if (!Array.isArray(questions) || !questions.length) throw new Error('questions must be a non-empty array');
    list = questions.map((q) => (isStr(q) ? { question: q } : q));
  } else list = [{ question, options }];
  if (list.length > LIMITS.questions) throw new Error(`at most ${LIMITS.questions} questions in one ask`);
  return list.map((q, i) => {
    if (!q || typeof q !== 'object') throw new Error(`question ${i + 1} must be an object`);
    const text = isStr(q.question) ? q.question.trim() : '';
    if (!text) throw new Error(`question ${i + 1} must be a non-empty string`);
    if (text.length > LIMITS.question) throw new Error(`question ${i + 1} is over ${LIMITS.question} characters`);
    let opts = q.options;
    if (isStr(opts)) opts = opts.split(',');
    if (opts === undefined || opts === null) opts = [];
    if (!Array.isArray(opts)) throw new Error(`options of question ${i + 1} must be a list`);
    opts = opts.map((o) => (isStr(o) ? oneLine(o) : '')).filter(Boolean);
    if (opts.length > LIMITS.options) throw new Error(`at most ${LIMITS.options} options per question`);
    if (opts.some((o) => o.length > LIMITS.option)) throw new Error(`an option is over ${LIMITS.option} characters`);
    if (opts.length === 1) throw new Error(`question ${i + 1} has one option; give two or more, or none for a free answer`);
    return { question: text, options: opts };
  }).map((q, _i, all) => {
    // One ask must fit one text message, the smallest channel's (SMS), with its header and reply line.
    const total = all.reduce((n, x) => n + x.question.length + x.options.reduce((m, o) => m + o.length + 4, 0), 0);
    if (total > LIMITS.total) throw new Error(`too long for one text message: ${total} characters across questions and options, at most ${LIMITS.total}`);
    return q;
  });
}

/** The ask event's own rules (core/events.js validateEvent calls this for type ask). Throws on bad input. */
export function validateAskEvent(ev) {
  if (!PHASES.includes(ev.phase)) throw new Error(`ask.phase must be one of ${PHASES.join(', ')}`);
  const needsId = !['inbound', 'control'].includes(ev.phase) && !(ev.phase === 'sent' && Array.isArray(ev.askIds));
  if (needsId && (!isStr(ev.askId) || !ev.askId)) throw new Error(`ask ${ev.phase} needs askId`);
  switch (ev.phase) {
    case 'created':
      normalizeQuestions({ questions: ev.questions });
      if (ev.urgency !== undefined && !URGENCY.includes(ev.urgency)) throw new Error('ask.urgency must be normal or urgent');
      if (ev.channels !== undefined && (!Array.isArray(ev.channels) || ev.channels.some((c) => !CHANNELS.includes(c)))) throw new Error(`ask.channels must be a list of ${CHANNELS.join(', ')}`);
      break;
    case 'routed':
      if (!isStr(ev.code) || !CODE_RE.test(ev.code)) throw new Error('ask routed needs a code like K7');
      break;
    case 'sent':
      if (!CHANNELS.includes(ev.channel)) throw new Error('ask sent needs a channel');
      if (!SEND_KINDS.includes(ev.kind)) throw new Error(`ask sent kind must be one of ${SEND_KINDS.join(', ')}`);
      break;
    case 'answered':
      if (!Array.isArray(ev.answers) || !ev.answers.length) throw new Error('ask answered needs answers');
      if (!isStr(ev.source) || !/^[a-z][a-z0-9_-]{0,40}:(telegram|imessage|sms)$/.test(ev.source)) throw new Error('ask answered needs a source like <owner>:<channel>');
      if (ev.untrusted !== false) throw new Error('only a verified answer is an answer; record an unverified reply as phase inbound');
      break;
    case 'inbound':
      if (!CHANNELS.includes(ev.channel)) throw new Error('ask inbound needs a channel');
      if (ev.untrusted !== true && ev.untrusted !== false) throw new Error('ask inbound needs untrusted true or false');
      break;
    case 'control':
      if (!CONTROL.includes(ev.command)) throw new Error(`ask control command must be one of ${CONTROL.join(', ')}`);
      break;
    default: break;
  }
  return ev;
}

/** A blank ask, filled by the events that name it. */
function blank(askId) {
  return { askId, answeredQs: new Set(), merged: [], status: 'open', code: null, origin: null, deliverTo: null, sessionId: null, sessionName: null, questions: [], urgency: 'normal', expiresAt: null, channels: null, createdAt: null, createdBy: null, routedAt: null, closedAt: null, answers: [], followUps: [], deliveries: [], sends: [], inbound: [], why: null };
}

/** The ask's own fields from a created or routed event (routed carries a copy for asks made on another host). */
function fill(a, src, e) {
  if (Array.isArray(src.questions) && !a.questions.length) a.questions = src.questions;
  for (const k of ['origin', 'sessionId', 'sessionName', 'cwd', 'expiresAt', 'channels', 'context']) if (src[k] !== undefined && src[k] !== null && (a[k] === null || a[k] === undefined)) a[k] = src[k];
  if (src.urgency && a.urgency === 'normal') a.urgency = src.urgency;
  if (!a.createdAt && (src.createdAt || e.phase === 'created')) a.createdAt = src.createdAt ?? e.ts;
  if (!a.createdBy && (src.createdBy || e.phase === 'created')) a.createdBy = src.createdBy ?? e.actor ?? null;
}

/**
 * Fold the truth file's ask events into asks. Pure and order-tolerant: the same ask can arrive from two files (the
 * asking host's created and the hub's routed, merged by dotsync), and the first answer, cancel or expiry wins.
 * Returns { asks: Map askId -> ask, sends: [sent events], controls: [control events] }.
 */
export function foldAsks(events = []) {
  const asks = new Map();
  const sends = [];
  const controls = [];
  const handled = new Set();   // provider message ids already read (answers, commands, replies that answered nothing)
  const get = (id) => { let a = asks.get(id); if (!a) { a = blank(id); asks.set(id, a); } return a; };
  for (const e of events) {
    if (e?.type !== 'ask') continue;
    if (e.providerMessageId && (e.phase === 'answered' || e.phase === 'control' || (e.phase === 'inbound' && e.untrusted === false))) handled.add(e.providerMessageId);
    switch (e.phase) {
      case 'created': { const a = get(e.askId); fill(a, e, e); a.origin ??= e.origin ?? e.host ?? null; break; }
      case 'routed': {
        const a = get(e.askId);
        if (e.ask && typeof e.ask === 'object') fill(a, e.ask, e);
        if (!a.code) { a.code = e.code; a.routedAt = e.ts; a.hub = e.hub ?? e.host ?? null; }
        if (e.origin && !a.origin) a.origin = e.origin;
        // The hub's routed event names the asking host as the hub reaches it (its ssh alias), which can differ from
        // the name that host gives itself: that one is where answers go.
        if (e.origin && !a.deliverTo) a.deliverTo = e.origin;
        break;
      }
      case 'sent': {
        sends.push(e);
        for (const id of e.askIds ?? [e.askId]) if (id) get(id).sends.push({ ts: e.ts, channel: e.channel, kind: e.kind, ok: e.ok !== false, providerId: e.providerId ?? null, error: e.error ?? null, messageIds: e.messageIds ?? null });
        break;
      }
      case 'answered': {
        const a = get(e.askId);
        const ans = { ts: e.ts, answers: e.answers, source: e.source, channel: e.channel ?? null, providerMessageId: e.providerMessageId ?? null, sender: e.sender ?? null, raw: e.raw ?? null, untrusted: false };
        // The same provider message recorded twice (the hub's event and the asking host's copy): one answer.
        if (a.answers.some((x) => x.providerMessageId && x.providerMessageId === ans.providerMessageId && x.source === ans.source)) break;
        // Each question takes its first answer; the ask is answered once every question has one. An answer that adds no
        // question (or comes after a cancel or expiry) is a follow-up: kept, still passed on, never reopening the ask.
        const fresh = a.status === 'open' ? e.answers.filter((x) => !a.answeredQs.has(x.q)) : [];
        if (fresh.length) {
          a.answers.push(ans);
          // Each question's answer keeps the reply it came in (several replies may answer one ask, on several
          // channels), so every decision can be checked against its own provider message.
          for (const x of fresh) { a.answeredQs.add(x.q); a.merged[x.q] = { ...x, source: ans.source, channel: ans.channel, providerMessageId: ans.providerMessageId, sender: ans.sender, ts: ans.ts }; }
          if (a.answeredQs.size >= Math.max(1, a.questions.length)) { a.status = 'answered'; a.closedAt = e.ts; }
        } else a.followUps.push(ans);
        break;
      }
      case 'delivered': get(e.askId).deliveries.push({ ts: e.ts, ok: e.ok !== false, final: e.final === true, error: e.error ?? null, to: e.to ?? null, kind: e.kind ?? 'answer', providerMessageId: e.providerMessageId ?? null }); break;
      case 'cancelled': case 'expired': {
        const a = get(e.askId);
        if (a.status === 'open') { a.status = e.phase; a.closedAt = e.ts; a.why = e.reason ?? null; }
        break;
      }
      case 'inbound': if (e.askId) get(e.askId).inbound.push({ ts: e.ts, channel: e.channel, sender: e.sender ?? null, untrusted: e.untrusted, reason: e.reason ?? null }); break;
      case 'control': controls.push(e); break;
      default: break;
    }
  }
  // An ask the fold only heard about through sends or inbound replies has no question: not an ask to show.
  for (const [id, a] of asks) if (!a.questions.length) asks.delete(id);
  return { asks, sends, controls, handled };
}

/** The number in a code (K7 -> 7), or null. */
export const numberOf = (code) => { const m = CODE_RE.exec(String(code ?? '')); return m ? Number(m[2]) : null; };

/**
 * The next code: the smallest number 1..99 that no open ask holds and no ask closed in the last REUSE_MS held, with
 * the letter after the last one given. Null when every number is taken (99 open asks).
 */
export function nextCode(asks, now = Date.now()) {
  const taken = new Set();
  let last = null;
  for (const a of asks) {
    if (!a.code) continue;
    if (!last || (a.routedAt ?? '') > (last.routedAt ?? '')) last = a;
    const closedRecently = a.closedAt && now - Date.parse(a.closedAt) < REUSE_MS;
    if (a.status === 'open' || closedRecently) taken.add(numberOf(a.code));
  }
  let n = 1;
  while (taken.has(n) && n <= MAX_NUMBER) n++;
  if (n > MAX_NUMBER) return null;
  const li = last ? LETTERS.indexOf(last.code[0]) : -1;
  return `${LETTERS[(li + 1) % LETTERS.length]}${n}`;
}

// ---------------------------------------------------------------- texts
// Plain text everywhere (no Markdown: a question is an agent's words and must not format the message). SMS gets ASCII
// only, since one non-GSM character turns every segment into 70-character UCS-2 ones.
const ascii = (s) => String(s ?? '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...').replace(/→/g, '->').replace(/·/g, '-').replace(/[^\x09\x0a\x0d\x20-\x7e]/g, '');
export const forChannel = (text, channel) => (channel === 'sms' ? ascii(text) : text);
const letter = (i) => String.fromCharCode(97 + i);
export const optionLine = (opts) => opts.map((o, i) => `${letter(i)}) ${o}`).join('  ');

/** Who is asking, as one short label: name@host, name, or host. */
export function whoLabel(a) {
  const name = a.sessionName || (a.sessionId ? String(a.sessionId).slice(0, 8) : null);
  return name && a.origin ? `${name} on ${a.origin}` : name || a.origin || 'an agent';
}

/** One ask as a text. */
export function askText(a, { channel = 'telegram', reminder = false, escalation = false } = {}) {
  const head = `${reminder ? 'Reminder: ' : escalation ? 'Still waiting: ' : ''}Drover ask ${a.code} · ${whoLabel(a)}${a.urgency === 'urgent' ? ' (urgent)' : ''}${a.questions.length > 1 ? ` · ${a.questions.length} questions` : ''}`;
  const lines = [head];
  if (a.questions.length === 1) {
    const q = a.questions[0];
    lines.push(q.question);
    if (q.options.length) lines.push(optionLine(q.options));
    lines.push(q.options.length ? `Reply: ${a.code} ${letter(0)}${channel === 'telegram' ? ', tap a button,' : ''} or any text` : `Reply: ${a.code} <your answer>`);
  } else {
    a.questions.forEach((q, i) => lines.push(`${i + 1}) ${q.question}${q.options.length ? `  ${optionLine(q.options)}` : ''}`));
    const sample = a.questions.map((q, i) => `${i + 1}${q.options.length ? letter(Math.min(1, q.options.length - 1)) : ' yes'}`).join(' ');
    // A ; or a line break splits one answer from the next, so a free-text answer does not swallow a later question.
    lines.push(`Reply like: ${a.code} ${sample} (; or a new line splits answers)`);
  }
  if (a.expiresAt && !reminder) lines.push(`Expires ${shortTime(a.expiresAt)}`);
  return forChannel(lines.join('\n'), channel);
}

/** Several asks in one text (held asks released together). */
export function batchText(list, { channel = 'telegram' } = {}) {
  if (list.length === 1) return askText(list[0], { channel });
  const lines = [`Drover: ${list.length} asks`];
  for (const a of list) {
    const q = a.questions[0];
    const first = `${a.code} · ${whoLabel(a)}${a.urgency === 'urgent' ? ' (urgent)' : ''}: ${a.questions.length > 1 ? `${a.questions.length} questions. 1) ` : ''}${q.question}${q.options.length ? `  ${optionLine(q.options)}` : ''}`;
    lines.push(first);
    a.questions.slice(1).forEach((x, i) => lines.push(`   ${i + 2}) ${x.question}${x.options.length ? `  ${optionLine(x.options)}` : ''}`));
  }
  lines.push(`Reply like: ${list.slice(0, 2).map((a) => `${a.code} ${a.questions[0].options.length ? 'a' : 'yes'}`).join(' ')}`);
  return forChannel(lines.join('\n'), channel);
}

/** "14:05 ET"-style time for texts, in the owner's zone. */
export function shortTime(iso, tz = 'America/New_York') {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(iso)); } catch { return String(iso); }
}

/** One answer as words: "b (no, tomorrow)" or "\"ship it after lunch\"". */
export function answerWords(q, x) {
  if (x.option !== null && x.option !== undefined && q?.options?.[x.option] !== undefined) return `${letter(x.option)} (${q.options[x.option]})${x.text ? ` + "${clip(oneLine(x.text), 300)}"` : ''}`;
  return `"${clip(oneLine(x.text ?? ''), 600)}"`;
}

/** What the asking session receives: provenance first, then the answer, then how to check it. remaining: open questions. */
export function deliveryText(a, ans, { followUp = false, channel, ownerName = OWNER_NAME, remaining = [] } = {}) {
  const via = channel ?? ans.channel ?? String(ans.source ?? '').split(':')[1] ?? 'text';
  const parts = a.questions.length === 1
    ? [answerWords(a.questions[0], ans.answers[0] ?? {})]
    : ans.answers.map((x) => `${x.q + 1}: ${answerWords(a.questions[x.q], x)}`);
  const head = `[${ownerName} via ${via}, verified${followUp ? ', follow-up' : ''}] ${a.code ?? 'ask'} → ${parts.join(' · ')}`;
  const q = a.questions.length === 1 ? `Question: ${clip(a.questions[0].question, 300)}` : `Questions: ${a.questions.map((x, i) => `${i + 1}) ${clip(x.question, 120)}`).join(' ')}`;
  const still = remaining.length ? `\nStill open: ${remaining.map((i) => `${i + 1}) ${clip(a.questions[i]?.question ?? '', 80)}`).join(' ')}` : '';
  return `${head}\n${q}${still}\n(ask ${a.askId}; check it with drover_ask_get)`;
}

/** What the asking session receives when nobody answered in time, or the owner stopped asks. */
export function closedText(a, why) {
  return `[Drover ask ${a.code ?? a.askId}] ${why}. Question: ${clip(a.questions[0]?.question ?? '', 200)}\n(ask ${a.askId})`;
}

export { clip, oneLine, letter };
