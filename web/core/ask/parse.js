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
  const targetAsk = target ? asks.find((a) => a.askId === target) ?? null : null;
  const implicit = targetAsk ?? (open.length === 1 ? open[0] : null);

  const results = new Map();   // askId -> { ask, per: Map q -> {q, option, text: []} }
  const slot = (ask, q) => {
    let r = results.get(ask.askId);
    if (!r) { r = { ask, per: new Map() }; results.set(ask.askId, r); }
    let s = r.per.get(q);
    if (!s) { s = { q, option: null, text: [] }; r.per.set(q, s); }
    return s;
  };
  let cur = implicit ? { ask: implicit, q: 0, explicit: false } : null;
  const loose = [];   // words before any ask is in hand, when none is implied
  const pickOption = (c, letterChar) => {
    const q = c.ask.questions[c.q];
    const i = letterChar.toLowerCase().charCodeAt(0) - 97;
    if (!q?.options?.length || i < 0 || i >= q.options.length) return false;
    const s = slot(c.ask, c.q);
    if (s.option !== null || s.text.length) return false;
    s.option = i;
    return true;
  };
  for (const tok of raw.split(/\s+/)) {
    const clean = tok.replace(TRIM, '');
    // A code: K7, K7b.
    let m = /^([a-z])(\d{1,2})([a-z])?$/i.exec(clean);
    if (m && CODE_RE.test(`${m[1].toUpperCase()}${m[2]}`) && byCode.has(`${m[1].toUpperCase()}${Number(m[2])}`)) {
      cur = { ask: byCode.get(`${m[1].toUpperCase()}${Number(m[2])}`), q: 0, explicit: true };
      if (m[3] && !pickOption(cur, m[3])) slot(cur.ask, cur.q).text.push(m[3]);
      else if (!m[3]) slot(cur.ask, cur.q);
      continue;
    }
    // A number: a sub-question of the ask in hand, else an open ask's number.
    m = /^(\d{1,2})([a-z])?$/i.exec(clean);
    if (m) {
      const n = Number(m[1]);
      const inHand = cur?.ask;
      if (inHand && inHand.questions.length > 1 && n >= 1 && n <= inHand.questions.length) {
        cur = { ask: inHand, q: n - 1, explicit: cur.explicit };
        if (m[2] && !pickOption(cur, m[2])) slot(cur.ask, cur.q).text.push(m[2]);
        else if (!m[2]) slot(cur.ask, cur.q);
        continue;
      }
      if (byNumber.has(n) && (!inHand || byNumber.get(n) !== inHand || !m[2] || inHand.questions.length === 1)) {
        cur = { ask: byNumber.get(n), q: 0, explicit: true };
        if (m[2] && !pickOption(cur, m[2])) slot(cur.ask, cur.q).text.push(m[2]);
        else if (!m[2]) slot(cur.ask, cur.q);
        continue;
      }
    }
    // An option letter for the question in hand.
    if (cur && /^[a-z]$/i.test(clean) && pickOption(cur, clean)) continue;
    // Anything else is text.
    if (cur) slot(cur.ask, cur.q).text.push(tok);
    else loose.push(tok);
  }
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
