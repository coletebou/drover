// The owner's reply, read as answers to open asks (pure; tests in test/ask-parse.test.js).
//
//   K7 b            option b of ask K7          7b, 7 b     the same, by number (numbers are unique among open asks)
//   b, yes, ship it the only open ask           K7 ship it  free text for K7
//   K7 1a 2b 3 yes  a multi-question ask        1a 2b 3 yes the same, when K7 is the only open ask or replied to
//   K7 b M8 a       two asks in one reply       7b 8a       the same, by number
//   stop | resume | start (after a stop: resume) | pause [asks] [for] 2h | status | help   (Telegram's /stop, /help too)
//
// A number is a sub-question when the ask in hand has several questions and the number is one of them, else the
// number of an open ask. A letter is an option when the question in hand has that many options and none chosen yet;
// anything else is the answer's text. A word equal to an option's label (yes, no, go) picks that option.
import { CODE_RE, numberOf } from './model.js';

const TRIM = /^[("'[]+|[)"'\],;:.!?]+$/g;
const UNITS = { m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000, h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000, d: 86_400_000, day: 86_400_000, days: 86_400_000 };
export const DEFAULT_PAUSE_MS = 2 * 3_600_000;
export const MAX_PAUSE_MS = 7 * 86_400_000;

/** A whole-message command, or null: {command: stop|resume|start|pause|status|help, ms?}. */
export function parseCommand(text) {
  // Telegram sends commands as /stop, or /stop@SomeBot in a group: the same words.
  const t = String(text ?? '').trim().toLowerCase().replace(/^\/([a-z]+)(@[a-z0-9_]+)?/, '$1').replace(/[.!]+$/, '');
  if (/^(stop|stop asks|stopall|unsubscribe|cancel all)$/.test(t)) return { command: 'stop' };
  if (/^(resume|unpause|unstop|resume asks|start asks)$/.test(t)) return { command: 'resume' };
  // Telegram's first message to a bot is /start: a greeting, not a resume (only start after a stop is one).
  if (/^start$/.test(t)) return { command: 'start' };
  if (/^(help|\?)$/.test(t)) return { command: 'help' };
  if (/^(status|asks|list|open)$/.test(t)) return { command: 'status' };
  const m = /^pause(?:\s+asks)?(?:\s+for)?(?:\s+(\d{1,4})\s*([a-z]+)?)?$/.exec(t);
  if (m) {
    if (!m[1]) return { command: 'pause', ms: DEFAULT_PAUSE_MS };
    const unit = UNITS[m[2] ?? 'h'];
    if (!unit) return null;
    return { command: 'pause', ms: Math.min(MAX_PAUSE_MS, Number(m[1]) * unit) };
  }
  return null;
}

const optionByLabel = (q, text) => {
  const t = String(text ?? '').trim().toLowerCase().replace(TRIM, '');
  if (!t || !q?.options?.length) return null;
  const i = q.options.findIndex((o) => o.toLowerCase() === t);
  return i >= 0 ? i : null;
};

/**
 * Read a reply against the asks it could answer.
 * ctx.asks: asks with code, questions, status, closedAt (open ones and recently closed ones, for follow-ups).
 * ctx.target: the askId the reply is tied to (a Telegram reply to that ask's message), or null.
 * Returns { command, answers: [{askId, code, answers: [{q, option, text}], closed}], ambiguous, unmatched }:
 * ambiguous is {why, codes} when the reply names no ask and several are open; unmatched is true when there is
 * nothing to answer at all.
 */
export function parseReply(text, { asks = [], target = null } = {}) {
  const raw = String(text ?? '').trim();
  const out = { command: null, answers: [], ambiguous: null, unmatched: false };
  if (!raw) { out.unmatched = true; return out; }
  const cmd = parseCommand(raw);
  if (cmd) { out.command = cmd; return out; }
  const open = asks.filter((a) => a.status === 'open' && a.code);
  const byCode = new Map(asks.filter((a) => a.code).map((a) => [a.code.toUpperCase(), a]));
  const byNumber = new Map(open.map((a) => [numberOf(a.code), a]));
  // A number an open ask does not hold may still be a just-closed ask's (a late "8a"): a follow-up there, newest first.
  const closedByNumber = new Map();
  for (const a of asks.filter((x) => x.code && x.status !== 'open').sort((x, y) => ((x.closedAt ?? '') < (y.closedAt ?? '') ? 1 : -1))) if (!closedByNumber.has(numberOf(a.code))) closedByNumber.set(numberOf(a.code), a);
  // A reply tied to an ask's message (Telegram, iMessage) is that ask's, open or not: never another's.
  const targetAsk = target ? asks.find((a) => a.askId === target) ?? null : null;
  if (target && !targetAsk) { out.ambiguous = { why: 'the message replied to belongs to no ask here', codes: open.map((a) => a.code) }; return out; }
  const implicit = targetAsk ?? (open.length === 1 ? open[0] : null);

  const results = new Map();   // askId -> { ask, per: Map q -> {q, option, text: []} }
  const slot = (ask, q) => {
    let r = results.get(ask.askId);
    if (!r) { r = { ask, per: new Map() }; results.set(ask.askId, r); }
    let x = r.per.get(q);
    if (!x) { x = { q, option: null, text: [] }; r.per.set(q, x); }
    return x;
  };
  let cur = implicit ? { ask: implicit, q: 0 } : null;
  // Where a code or a number may pick another ask: at the start, or right after a chosen option ("K7 b M8 a"). Right
  // after a bare code only a question of that ask may follow ("B3 1b"). Once an answer's words start, codes and numbers
  // are those words: "K7 wait 2 days" never answers ask 2, "A1 2 a week" is A1's.
  let canSwitch = true, canSub = true;
  const loose = [];   // words before any ask is in hand, when none is implied
  let unknown = null; // a reference to an ask that is not there ("K9 b", "8a" with no ask 8): the reply is unclear
  const pickOption = (c, letterChar) => {
    const q = c.ask.questions[c.q];
    const i = letterChar.toLowerCase().charCodeAt(0) - 97;
    if (!q?.options?.length || i < 0 || i >= q.options.length) return false;
    const x = slot(c.ask, c.q);
    if (x.option !== null || x.text.length) return false;
    x.option = i;
    return true;
  };
  /** Take an ask (or a question of the one in hand), with a letter glued on: an option, else the start of the text. */
  const take = (next, glued) => {
    cur = next;
    if (glued && pickOption(cur, glued)) { canSwitch = canSub = true; return; }
    if (glued) { slot(cur.ask, cur.q).text.push(glued); canSwitch = canSub = false; return; }
    slot(cur.ask, cur.q);
    canSwitch = false; canSub = true;
  };
  for (const tok of raw.split(/\s+/)) {
    const clean = tok.replace(TRIM, '');
    if ((canSwitch || canSub) && !unknown) {
      // A code: K7, K7b.
      let m = /^([a-z])(\d{1,2})([a-z])?$/i.exec(clean);
      if (canSwitch && m && CODE_RE.test(`${m[1].toUpperCase()}${Number(m[2])}`)) {
        const a = byCode.get(`${m[1].toUpperCase()}${Number(m[2])}`);
        if (a) { take({ ask: a, q: 0 }, m[3]); continue; }
        unknown = clean; continue;
      }
      // A number: a question of a multi-question ask in hand, else an open ask's number, else a just-closed one's.
      m = /^(\d{1,2})([a-z])?$/i.exec(clean);
      if (m) {
        const n = Number(m[1]);
        const inHand = cur?.ask;
        if (canSub && inHand && inHand.questions.length > 1 && n >= 1 && n <= inHand.questions.length) { take({ ask: inHand, q: n - 1 }, m[2]); continue; }
        const a = canSwitch ? byNumber.get(n) ?? (m[2] ? closedByNumber.get(n) : null) : null;
        if (a) { take({ ask: a, q: 0 }, m[2]); continue; }
        if (canSwitch && m[2]) { unknown = clean; continue; }
        // A bare number that names no ask is a number answering the ask in hand ("how many days?" "3").
      }
    }
    // An option letter for the question in hand.
    if (cur && /^[a-z]$/i.test(clean) && pickOption(cur, clean)) { canSwitch = canSub = true; continue; }
    // Anything else is the answer's words.
    if (cur) { slot(cur.ask, cur.q).text.push(tok); canSwitch = canSub = false; }
    else loose.push(tok);
  }
  if (unknown) { out.ambiguous = { why: `no open ask is ${unknown.toUpperCase()}`, codes: open.map((a) => a.code) }; return out; }
  if (loose.length) {
    if (!open.length) { out.unmatched = true; return out; }
    out.ambiguous = { why: `${open.length} asks are open; say which one`, codes: open.map((a) => a.code) };
    return out;
  }
  for (const { ask, per } of results.values()) {
    const answers = [];
    for (const s of [...per.values()].sort((a, b) => a.q - b.q)) {
      const text = s.text.join(' ').trim();
      let option = s.option;
      if (option === null) option = optionByLabel(ask.questions[s.q], text);
      if (option === null && !text) continue;   // a bare code with nothing after it
      answers.push({ q: s.q, option, text: option !== null && optionByLabel(ask.questions[s.q], text) === option ? '' : text });
    }
    if (answers.length) out.answers.push({ askId: ask.askId, code: ask.code, answers, closed: ask.status !== 'open' });
  }
  if (!out.answers.length && !out.ambiguous) out.unmatched = true;
  return out;
}
