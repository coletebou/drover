// Asks, the pure parts: questions, the event's rules, the fold (core/ask/model.js), the reply grammar
// (core/ask/parse.js) and when the hub may text (core/ask/policy.js). No I/O.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeQuestions, validateAskEvent, foldAsks, nextCode, askText, batchText, deliveryText, forChannel, REUSE_MS } from '../core/ask/model.js';
import { parseReply, parseCommand, DEFAULT_PAUSE_MS } from '../core/ask/parse.js';
import { parseWindow, quietState, rateState, pauseState, mayText, channelOrder, reminderAt, readConfig, localMinutes } from '../core/ask/policy.js';

const T0 = Date.parse('2026-11-07T15:00:00Z');   // 10:00 in New York (EST)
const iso = (ms) => new Date(ms).toISOString();
const ask = (over = {}) => ({ askId: over.askId ?? 'a1', code: 'K7', status: 'open', closedAt: null, questions: [{ question: 'Ship it?', options: ['yes', 'no'] }], ...over });

describe('questions', () => {
  test('one question, options as a list or a comma string', () => {
    assert.deepEqual(normalizeQuestions({ question: ' Ship? ', options: ['yes', ' no '] }), [{ question: 'Ship?', options: ['yes', 'no'] }]);
    assert.deepEqual(normalizeQuestions({ question: 'Ship?', options: 'a, b' }), [{ question: 'Ship?', options: ['a', 'b'] }]);
    assert.deepEqual(normalizeQuestions({ question: 'Why?' }), [{ question: 'Why?', options: [] }]);
  });
  test('several questions, strings or objects', () => {
    assert.deepEqual(normalizeQuestions({ questions: ['One?', { question: 'Two?', options: ['x', 'y'] }] }), [{ question: 'One?', options: [] }, { question: 'Two?', options: ['x', 'y'] }]);
  });
  test('bad input is refused with a reason', () => {
    assert.throws(() => normalizeQuestions({}), /non-empty string/);
    assert.throws(() => normalizeQuestions({ question: 'x', questions: ['y'] }), /not both/);
    assert.throws(() => normalizeQuestions({ question: 'x', options: ['only'] }), /one option/);
    assert.throws(() => normalizeQuestions({ questions: Array(10).fill('q') }), /at most 9/);
    assert.throws(() => normalizeQuestions({ question: 'x'.repeat(601) }), /over 600/);
  });
});

describe('the ask event', () => {
  test('each phase has its rules', () => {
    assert.ok(validateAskEvent({ type: 'ask', phase: 'created', askId: 'a', questions: [{ question: 'q', options: [] }] }));
    assert.throws(() => validateAskEvent({ type: 'ask', phase: 'created', questions: [] }), /askId/);
    assert.throws(() => validateAskEvent({ type: 'ask', phase: 'routed', askId: 'a', code: 'I1' }), /code/);
    assert.throws(() => validateAskEvent({ type: 'ask', phase: 'sent', askId: 'a', channel: 'fax', kind: 'ask' }), /channel/);
    assert.throws(() => validateAskEvent({ type: 'ask', phase: 'nope', askId: 'a' }), /phase/);
  });
  test('an answer is verified by definition: untrusted must be false and the source names a channel', () => {
    const ok = { type: 'ask', phase: 'answered', askId: 'a', answers: [{ q: 0, option: 1, text: '' }], source: 'cole:telegram', untrusted: false };
    assert.ok(validateAskEvent(ok));
    assert.throws(() => validateAskEvent({ ...ok, untrusted: true }), /phase inbound/);
    assert.throws(() => validateAskEvent({ ...ok, untrusted: undefined }), /phase inbound/);
    assert.throws(() => validateAskEvent({ ...ok, source: 'lux' }), /source/);
  });
});

describe('the fold', () => {
  const created = { id: 'e1', ts: iso(T0), type: 'ask', phase: 'created', askId: 'a1', origin: 'forge', sessionId: 's1', sessionName: 'worker', questions: [{ question: 'Ship?', options: ['yes', 'no'] }], urgency: 'normal' };
  const routed = { id: 'e2', ts: iso(T0 + 1000), type: 'ask', phase: 'routed', askId: 'a1', code: 'K7', hub: 'mini', ask: { origin: 'forge', sessionId: 's1', questions: created.questions, urgency: 'normal', createdAt: created.ts } };
  const answered = (id, ts, msg, option) => ({ id, ts: iso(ts), type: 'ask', phase: 'answered', askId: 'a1', answers: [{ q: 0, option, text: '' }], source: 'cole:sms', providerMessageId: msg, untrusted: false });
  test('the hub alone (routed carries the ask) and both files merged give the same ask', () => {
    const hubOnly = foldAsks([routed]).asks.get('a1');
    const merged = foldAsks([created, routed]).asks.get('a1');
    for (const a of [hubOnly, merged]) {
      assert.equal(a.code, 'K7'); assert.equal(a.origin, 'forge'); assert.equal(a.sessionId, 's1'); assert.equal(a.status, 'open'); assert.equal(a.questions[0].question, 'Ship?');
    }
  });
  test('the first answer wins, later ones are follow-ups, and one provider message counts once', () => {
    const a = foldAsks([created, routed, answered('e3', T0 + 5000, 'SM1', 1), answered('e3b', T0 + 5001, 'SM1', 1), answered('e4', T0 + 9000, 'SM2', 0)]).asks.get('a1');
    assert.equal(a.status, 'answered');
    assert.equal(a.answers.length, 1); assert.equal(a.answers[0].answers[0].option, 1);
    assert.equal(a.followUps.length, 1);
  });
  test('a multi-question ask is answered question by question: open until every question has its first answer', () => {
    const q3 = { ...created, questions: [{ question: 'A?', options: [] }, { question: 'B?', options: [] }] };
    const part = (id, ts, msg, qs) => ({ ...answered(id, ts, msg, null), answers: qs.map((q) => ({ q, option: null, text: `t${q}` })) });
    const one = foldAsks([q3, routed, part('p1', T0 + 1000, 'SMp1', [0])]).asks.get('a1');
    assert.equal(one.status, 'open'); assert.deepEqual([...one.answeredQs], [0]);
    const both = foldAsks([q3, routed, part('p1', T0 + 1000, 'SMp1', [0]), part('p2', T0 + 2000, 'SMp2', [0, 1]), part('p3', T0 + 3000, 'SMp3', [1])]).asks.get('a1');
    assert.equal(both.status, 'answered'); assert.equal(both.answers.length, 2); assert.equal(both.followUps.length, 1);
    assert.deepEqual(both.merged.map((x) => x.text), ['t0', 't1'], 'each question keeps its first answer');
  });
  test('a cancel after the answer does not undo it; an answer after a cancel is kept as a follow-up', () => {
    const cancel = (ts) => ({ id: `c${ts}`, ts: iso(ts), type: 'ask', phase: 'cancelled', askId: 'a1' });
    assert.equal(foldAsks([created, answered('e3', T0 + 5000, 'SM1', 0), cancel(T0 + 6000)]).asks.get('a1').status, 'answered');
    const b = foldAsks([created, cancel(T0 + 2000), answered('e3', T0 + 5000, 'SM1', 0)]).asks.get('a1');
    assert.equal(b.status, 'cancelled'); assert.equal(b.followUps.length, 1);
  });
  test('sends attach to every ask of a batch; an ask known only from sends is not an ask', () => {
    const r = foldAsks([created, routed, { id: 's', ts: iso(T0 + 2000), type: 'ask', phase: 'sent', askIds: ['a1', 'ghost'], channel: 'telegram', kind: 'batch', ok: true }]);
    assert.equal(r.asks.get('a1').sends.length, 1);
    assert.equal(r.asks.has('ghost'), false);
    assert.equal(r.sends.length, 1);
  });
});

describe('codes', () => {
  const at = (code, status = 'open', closedAgoMs = null, routedAt = iso(T0)) => ({ code, status, routedAt, closedAt: closedAgoMs === null ? null : iso(T0 - closedAgoMs) });
  test('the smallest free number and the next letter', () => {
    assert.equal(nextCode([], T0), 'A1');
    assert.equal(nextCode([at('A1'), { ...at('B2'), routedAt: iso(T0 + 1) }], T0), 'C3');
  });
  test('a number closed a moment ago is not reused; one closed long ago is', () => {
    assert.equal(nextCode([at('A1', 'answered', 60_000)], T0), 'B2');
    assert.equal(nextCode([at('A1', 'answered', REUSE_MS + 1)], T0), 'B1');
  });
  test('letters skip I and O and wrap', () => {
    assert.equal(nextCode([at('H1', 'answered', REUSE_MS + 1)], T0), 'J1');
    assert.equal(nextCode([at('N1', 'answered', REUSE_MS + 1)], T0), 'P1');
    assert.equal(nextCode([at('Z1', 'answered', REUSE_MS + 1)], T0), 'A1');
  });
});

describe('texts', () => {
  const a = { askId: 'x', code: 'K7', origin: 'hz-forge', sessionName: 'drover-ask', urgency: 'urgent', questions: [{ question: 'Ship the “SMS” adapter — today?', options: ['yes', 'no'] }] };
  test('an ask names its code, who asks and the options', () => {
    const t = askText(a);
    assert.match(t, /^Drover ask K7 · drover-ask on hz-forge \(urgent\)\n/);
    assert.match(t, /a\) yes {2}b\) no/);
    assert.match(t, /Reply: K7 a, tap a button, or any text/);
  });
  test('SMS gets the GSM alphabet: typographic marks take their plain forms (one other character makes every segment UCS-2)', () => {
    const t = askText(a, { channel: 'sms' });
    assert.equal(/[^\x09\x0a\x0d\x20-\x7e]/.test(t), false, t);
    assert.match(t, /"SMS" adapter - today\?/);
    assert.equal(forChannel('→ · …', 'sms'), '-> - ...');
  });
  test('SMS keeps every letter: an accent GSM lacks loses only its mark; text with no GSM form goes as written (UCS-2)', () => {
    assert.equal(forChannel('Réunion à Zürich, São Paulo, façade, Kraków?', 'sms'), 'Réunion à Zürich, Sao Paulo, facade, Krakow?');
    assert.equal(forChannel('Cafe\u0301 or the hotel?', 'sms'), 'Café or the hotel?');   // decomposed: é is GSM, kept whole
    assert.equal(forChannel('Move the launch to 会议在苏黎世举行吗?', 'sms'), 'Move the launch to 会议在苏黎世举行吗?');
    assert.equal(forChannel('Ship it ✅ — “now”?', 'sms'), 'Ship it ✅ - "now"?');   // as written, marks still plain
    assert.equal(forChannel('run `npm test`\tnow, 2:05\u202fPM\u00a0ET', 'sms'), "run 'npm test' now, 2:05 PM ET");   // ` and tab are not GSM
    assert.equal(forChannel('a [b] {c} ~ | € \\ ^', 'sms'), 'a [b] {c} ~ | € \\ ^');   // GSM's escaped characters stay
    assert.equal(forChannel('Réunion', 'telegram'), 'Réunion');
  });
  test('several questions are numbered; several asks are listed with their codes', () => {
    const m = askText({ ...a, urgency: 'normal', questions: [{ question: 'One?', options: ['x', 'y'] }, { question: 'Two?', options: [] }] });
    assert.match(m, /1\) One\? {2}a\) x {2}b\) y\n2\) Two\?/);
    assert.match(m, /Reply like: K7 1b 2 yes/);
    const b = batchText([a, { ...a, askId: 'y', code: 'M8', sessionName: 'tg', urgency: 'normal', questions: [{ question: 'Pick?', options: [] }] }]);
    assert.match(b, /^Drover: 2 asks\nK7 · drover-ask on hz-forge \(urgent\): Ship/);
    assert.match(b, /\nM8 · tg on hz-forge: Pick\?/);
  });
  test('what the session receives says who answered, how, and how to check', () => {
    const t = deliveryText(a, { channel: 'telegram', source: 'cole:telegram', answers: [{ q: 0, option: 1, text: '' }] }, { ownerName: 'Cole' });
    assert.match(t, /^\[Cole via telegram, verified\] K7 → b \(no\)\nQuestion: Ship/);
    assert.match(t, /check it with drover_ask_get/);
    assert.match(deliveryText(a, { channel: 'sms', answers: [{ q: 0, option: null, text: 'after lunch' }] }, { ownerName: 'Cole', followUp: true }), /^\[Cole via sms, verified, follow-up\] K7 → "after lunch"/);
  });
});

describe('the reply grammar', () => {
  const k7 = ask();
  const m8 = ask({ askId: 'a2', code: 'M8', questions: [{ question: 'Name?', options: [] }] });
  const b3 = ask({ askId: 'a3', code: 'B3', questions: [{ question: 'One?', options: ['x', 'y'] }, { question: 'Two?', options: ['p', 'q', 'r'] }, { question: 'Three?', options: [] }] });
  const one = (r) => r.answers.map((x) => [x.code, x.answers.map((y) => [y.q, y.option, y.text])]);
  test('code and option, glued or apart, any case', () => {
    for (const s of ['K7 b', 'k7b', 'K7: b', 'k7 B']) assert.deepEqual(one(parseReply(s, { asks: [k7, m8] })), [['K7', [[0, 1, '']]]], s);
  });
  test('by number alone, since numbers are unique among open asks', () => {
    assert.deepEqual(one(parseReply('7b', { asks: [k7, m8] })), [['K7', [[0, 1, '']]]]);
    assert.deepEqual(one(parseReply('7 b', { asks: [k7, m8] })), [['K7', [[0, 1, '']]]]);
  });
  test('a bare answer goes to the only open ask; with several open it is ambiguous', () => {
    assert.deepEqual(one(parseReply('b', { asks: [k7] })), [['K7', [[0, 1, '']]]]);
    assert.deepEqual(one(parseReply('No', { asks: [k7] })), [['K7', [[0, 1, '']]]]);   // the label picks the option
    const r = parseReply('yes', { asks: [k7, m8] });
    assert.deepEqual(r.answers, []); assert.deepEqual(r.ambiguous.codes, ['K7', 'M8']);
  });
  test('free text, with or without a code, and an option with words after it', () => {
    assert.deepEqual(one(parseReply('M8 call it Drover', { asks: [k7, m8] })), [['M8', [[0, null, 'call it Drover']]]]);
    assert.deepEqual(one(parseReply('K7 b but only after lunch', { asks: [k7, m8] })), [['K7', [[0, 1, 'but only after lunch']]]]);
    assert.deepEqual(one(parseReply('ship it after lunch', { asks: [m8] })), [['M8', [[0, null, 'ship it after lunch']]]]);
  });
  test('several asks in one reply', () => {
    assert.deepEqual(one(parseReply('K7 b M8 Drover', { asks: [k7, m8] })), [['K7', [[0, 1, '']]], ['M8', [[0, null, 'Drover']]]]);
    assert.deepEqual(one(parseReply('7a, 8 Drover', { asks: [k7, m8] })), [['K7', [[0, 0, '']]], ['M8', [[0, null, 'Drover']]]]);
  });
  test('a multi-question ask: 1a 2b 3 yes when it is the only open ask or replied to; with its code otherwise', () => {
    assert.deepEqual(one(parseReply('1a 2c 3 yes please', { asks: [b3] })), [['B3', [[0, 0, ''], [1, 2, ''], [2, null, 'yes please']]]]);
    assert.deepEqual(one(parseReply('1a 2c', { asks: [k7, b3], target: 'a3' })), [['B3', [[0, 0, ''], [1, 2, '']]]]);
    // After the words of an answer start, a code is one of those words: a second ask needs its code first, or after an option.
    assert.deepEqual(one(parseReply('B3 1b 3 later K7 a', { asks: [k7, b3] })), [['B3', [[0, 1, ''], [2, null, 'later K7 a']]]]);
    assert.deepEqual(one(parseReply('B3 1b 2c K7 a', { asks: [k7, b3] })), [['B3', [[0, 1, ''], [1, 2, '']]], ['K7', [[0, 0, '']]]]);
  });
  test('numbers and codes inside an answer\'s words never pick another ask', () => {
    const b2 = ask({ askId: 'a4', code: 'B2', questions: [{ question: 'Pick?', options: ['x', 'y'] }] });
    const c3 = ask({ askId: 'a5', code: 'C3', questions: [{ question: 'Room?', options: [] }] });
    assert.deepEqual(one(parseReply('K7 wait 2 days', { asks: [k7, b2] })), [['K7', [[0, null, 'wait 2 days']]]]);
    assert.deepEqual(one(parseReply('M8 move it to room C3', { asks: [m8, c3] })), [['M8', [[0, null, 'move it to room C3']]]]);
    assert.deepEqual(one(parseReply('M8 2 a week', { asks: [m8, b2] })), [['M8', [[0, null, '2 a week']]]], 'a bare code is no answer yet: 2 is its words');
    assert.deepEqual(one(parseReply('K7 b 2a', { asks: [k7, b2] })), [['K7', [[0, 1, '']]], ['B2', [[0, 0, '']]]], 'after a chosen option, another ask');
    assert.deepEqual(one(parseReply('M8 call it 2 a week', { asks: [m8, b2] })), [['M8', [[0, null, 'call it 2 a week']]]]);
  });
  test('a reference to an ask that is not open is unclear, or a late follow-up of a just-closed one; never the open ask\'s words', () => {
    const m8closed = ask({ askId: 'a2', code: 'M8', status: 'answered', closedAt: iso(T0), questions: [{ question: 'Name?', options: ['a1', 'b1'] }] });
    const late = parseReply('8a', { asks: [k7, m8closed] });
    assert.deepEqual(one(late), [['M8', [[0, 0, '']]]]); assert.equal(late.answers[0].closed, true);
    assert.deepEqual(parseReply('K9 b', { asks: [k7] }).ambiguous.why, 'no open ask is K9');
    assert.deepEqual(parseReply('9a', { asks: [k7] }).ambiguous.why, 'no open ask is 9A');
    assert.deepEqual(one(parseReply('3', { asks: [m8] })), [['M8', [[0, null, '3']]]], 'a bare number naming no ask is a number');
  });
  test('a reply bound to an ask\'s message is that ask\'s, open or closed; one bound to nothing here is unclear', () => {
    const old = ask({ askId: 'old', code: 'D4', status: 'answered', closedAt: iso(T0 - 7_200_000) });
    const r = parseReply('b', { asks: [k7, old], target: 'old' });
    assert.deepEqual(one(r), [['D4', [[0, 1, '']]]]); assert.equal(r.answers[0].closed, true);
    assert.ok(parseReply('b', { asks: [k7], target: 'gone' }).ambiguous);
  });
  test('a letter past the options is text; a second letter is text', () => {
    assert.deepEqual(one(parseReply('K7 c', { asks: [k7, m8] })), [['K7', [[0, null, 'c']]]]);
    assert.deepEqual(one(parseReply('K7 a b', { asks: [k7, m8] })), [['K7', [[0, 0, 'b']]]]);
  });
  test('an answer to an ask closed a moment ago is marked closed (a follow-up), never moved to a newer ask', () => {
    const old = ask({ status: 'answered', closedAt: iso(T0) });
    const r = parseReply('K7 a', { asks: [old, m8] });
    assert.deepEqual(one(r), [['K7', [[0, 0, '']]]]); assert.equal(r.answers[0].closed, true);
  });
  test('nothing open: unmatched', () => {
    assert.equal(parseReply('hello', { asks: [] }).unmatched, true);
    assert.equal(parseReply('', { asks: [k7] }).unmatched, true);
  });
  test('commands', () => {
    assert.deepEqual(parseCommand('STOP'), { command: 'stop' });
    assert.deepEqual(parseCommand('resume'), { command: 'resume' });
    assert.deepEqual(parseCommand('pause asks 2h'), { command: 'pause', ms: 2 * 3_600_000 });
    assert.deepEqual(parseCommand('pause for 30 min'), { command: 'pause', ms: 30 * 60_000 });
    assert.deepEqual(parseCommand('pause'), { command: 'pause', ms: DEFAULT_PAUSE_MS });
    assert.deepEqual(parseCommand('status'), { command: 'status' });
    assert.deepEqual(parseCommand('/stop'), { command: 'stop' });
    assert.deepEqual(parseCommand('/status@drover_test_bot'), { command: 'status' });
    assert.deepEqual(parseCommand('/start'), { command: 'start' });
    assert.deepEqual(parseCommand('help'), { command: 'help' });
    assert.equal(parseCommand('pause 3 fortnights'), null);
    assert.equal(parseCommand('stop the deploy'), null);
    assert.deepEqual(parseReply('Stop', { asks: [k7] }).command, { command: 'stop' });
  });
  test('C1: a spaced late reference ("8 b") resolves exactly like the glued form ("8b")', () => {
    const m8c = ask({ askId: 'a9', code: 'M8', status: 'answered', closedAt: iso(T0), questions: [{ question: 'Name?', options: ['a1', 'b1'] }] });
    const r = parseReply('8 b', { asks: [k7, m8c] });
    assert.deepEqual(one(r), [['M8', [[0, 1, '']]]], 'a just-closed ask by number, never K7\'s words');
    assert.equal(r.answers[0].closed, true);
    assert.deepEqual(parseReply('8 b', { asks: [k7] }).ambiguous.why, 'no open ask is 8 B', 'no ask 8 at all is unclear, not K7\'s words');
  });
  test('C2: a free-text answer starting with the ask in hand\'s own number keeps the number', () => {
    const a1 = ask({ askId: 'a10', code: 'A1', questions: [{ question: 'How many retries?', options: [] }] });
    assert.deepEqual(one(parseReply('1 more', { asks: [a1] })), [['A1', [[0, null, '1 more']]]]);
    assert.deepEqual(one(parseReply('1', { asks: [a1] })), [['A1', [[0, null, '1']]]], 'a bare own-number is still an answer, not unmatched');
    const b2 = ask({ askId: 'a11', code: 'B2', questions: [{ question: 'How long?', options: [] }] });
    assert.deepEqual(one(parseReply('2 hours', { asks: [b2] })), [['B2', [[0, null, '2 hours']]]]);
  });
  test('X2: bound to one ask\'s message, a code or number may only mean that ask - never a guess among others', () => {
    const a1Old = ask({ askId: 'oldA1', code: 'A1', status: 'answered', closedAt: iso(T0 - 7_200_000), questions: [{ question: 'Ship?', options: ['yes', 'no'] }] });
    const b1Open = ask({ askId: 'b1open', code: 'B1', status: 'open', questions: [{ question: 'Pick?', options: ['x', 'y'] }] });
    const c2Open = ask({ askId: 'c2open', code: 'C2', status: 'open', questions: [{ question: 'Pick?', options: ['p', 'q'] }] });
    // B1 reused A1's old number: a reply to A1's own message still means A1, not the open ask that now holds "1".
    const r = parseReply('1b', { asks: [a1Old, b1Open], target: 'oldA1' });
    assert.deepEqual(one(r), [['A1', [[0, 1, '']]]]);
    assert.equal(r.answers[0].closed, true);
    const r2 = parseReply('B1 b', { asks: [a1Old, b1Open], target: 'oldA1' });
    assert.ok(r2.ambiguous, 'naming B1\'s own code while bound to A1 is unclear, not a switch');
    assert.equal(r2.answers.length, 0);
    const r3 = parseReply('2b', { asks: [a1Old, b1Open, c2Open], target: 'oldA1' });
    assert.ok(r3.ambiguous, 'naming a different open ask by its own number is unclear, not a switch');
    assert.equal(r3.answers.length, 0);
  });
  test('a spaced letter is an option only at the reply\'s end or before another reference: "2 a day" stays words', () => {
    const m2c = ask({ askId: 'm2c', code: 'M2', status: 'answered', closedAt: iso(T0), questions: [{ question: 'Pick?', options: ['x', 'y'] }] });
    assert.deepEqual(one(parseReply('2 a day', { asks: [k7, m2c] })), [['K7', [[0, null, '2 a day']]]], 'never a follow-up of the closed M2');
    const m8c = ask({ askId: 'm8c2', code: 'M8', status: 'answered', closedAt: iso(T0), questions: [{ question: 'Name?', options: ['a1', 'b1'] }] });
    assert.deepEqual(one(parseReply('8 b', { asks: [k7, m8c] })), [['M8', [[0, 1, '']]]]);
  });
  test('bound to an ask\'s message, a bare number or a code naming no ask is that ask\'s words; one naming another ask is unclear', () => {
    const m3 = ask({ askId: 'm3open', code: 'M3', status: 'open', questions: [{ question: 'Pick?', options: ['x', 'y'] }] });
    assert.deepEqual(one(parseReply('3', { asks: [k7, m3], target: k7.askId })), [['K7', [[0, null, '3']]]], 'how many? 3: whichever ask holds 3');
    assert.deepEqual(one(parseReply('B2 works', { asks: [k7, m3], target: k7.askId })), [['K7', [[0, null, 'B2 works']]]]);
    assert.deepEqual(one(parseReply('3 b', { asks: [k7], target: k7.askId })), [['K7', [[0, null, '3 b']]]], 'no ask 3: words');
    assert.ok(parseReply('3b', { asks: [k7, m3], target: k7.askId }).ambiguous);
    assert.ok(parseReply('M3 b', { asks: [k7, m3], target: k7.askId }).ambiguous);
  });
  test('a separator inside one answer\'s words stays in them', () => {
    assert.deepEqual(one(parseReply('ship it; after lunch', { asks: [k7] })), [['K7', [[0, null, 'ship it; after lunch']]]]);
  });
  test('X6: a ; or a line break ends an answer\'s words, so the next sub-question may start again', () => {
    const k7m = ask({ askId: 'k7m', code: 'K7', questions: [{ question: 'Name?', options: [] }, { question: 'When?', options: [] }] });
    assert.deepEqual(one(parseReply('K7 1 Lantern; 2 tomorrow', { asks: [k7m] })), [['K7', [[0, null, 'Lantern'], [1, null, 'tomorrow']]]]);
    assert.deepEqual(one(parseReply('K7 1 Lantern\n2 tomorrow', { asks: [k7m] })), [['K7', [[0, null, 'Lantern'], [1, null, 'tomorrow']]]], 'one answer per line');
    const k7m2 = ask({ askId: 'k7m2', code: 'K7', questions: [{ question: 'Name?', options: [] }, { question: 'Confirm?', options: ['x', 'y'] }] });
    assert.deepEqual(one(parseReply('K7 1 call it Lantern; 2a', { asks: [k7m2] })), [['K7', [[0, null, 'call it Lantern'], [1, 0, '']]]], 'free text then an option after the separator');
    // No separator needed between several options: unchanged from before.
    assert.deepEqual(one(parseReply('1a 2c 3 yes please', { asks: [b3] })), [['B3', [[0, 0, ''], [1, 2, ''], [2, null, 'yes please']]]]);
  });
});

describe('policy', () => {
  const cfg = { ...readConfig({}), quiet: parseWindow('22:00-08:00'), tz: 'America/New_York', ratePerHour: 2 };
  test('settings: defaults, and what the environment says', () => {
    const d = readConfig({});
    assert.deepEqual(d.order, ['telegram', 'imessage', 'sms']); assert.equal(d.hub, null); assert.equal(d.ratePerHour, 6);
    const c = readConfig({ DROVER_ASK_HUB: 'mini', DROVER_ASK_CHANNELS: 'sms, fax,telegram', DROVER_ASK_QUIET: 'off', DROVER_ASK_TZ: 'Not/AZone', DROVER_ASK_RATE: '0' });
    assert.equal(c.hub, 'mini'); assert.deepEqual(c.order, ['sms', 'telegram']); assert.equal(c.quiet, null); assert.equal(c.tz, 'America/New_York'); assert.equal(c.ratePerHour, 6);
  });
  test('quiet hours in the owner\'s zone, across midnight', () => {
    assert.equal(localMinutes(T0, 'America/New_York'), 600);
    assert.deepEqual(quietState(T0, cfg), { quiet: false, endsAt: null });
    const late = Date.parse('2026-11-08T03:30:00Z');   // 22:30 EST
    const q = quietState(late, cfg);
    assert.equal(q.quiet, true); assert.equal(iso(q.endsAt), '2026-11-08T13:00:00.000Z');   // 08:00 EST
    const early = Date.parse('2026-11-08T12:59:00Z');  // 07:59 EST
    assert.equal(iso(quietState(early, cfg).endsAt), '2026-11-08T13:00:00.000Z');
  });
  test('the rate limit counts texts of the last hour, not acks or failures', () => {
    const s = (agoMin, kind = 'ask', ok = true) => ({ ts: iso(T0 - agoMin * 60_000), kind, ok });
    assert.equal(rateState([s(10), s(70)], T0, cfg).allowed, true);
    const full = rateState([s(50), s(10), s(5, 'ack'), s(1, 'ask', false)], T0, cfg);
    assert.equal(full.allowed, false); assert.equal(iso(full.nextAt), iso(T0 + 10 * 60_000));
  });
  test('pause, stop and resume, in order', () => {
    const c = (command, agoMin, extra = {}) => ({ command, ts: iso(T0 - agoMin * 60_000), ...extra });
    assert.deepEqual(pauseState([c('pause', 10, { ms: 3_600_000 })], T0), { stopped: false, pausedUntil: T0 + 50 * 60_000, stoppedSince: null });
    assert.equal(pauseState([c('pause', 90, { ms: 3_600_000 })], T0).pausedUntil, null);
    assert.equal(pauseState([c('stop', 5)], T0).stopped, true);
    assert.equal(pauseState([c('stop', 5), c('resume', 1)], T0).stopped, false);
  });
  test('may it text now: urgent skips quiet, pause and rate; a stop holds everything', () => {
    const late = Date.parse('2026-11-08T03:30:00Z');
    assert.deepEqual(mayText({ urgency: 'normal' }, { now: late, config: cfg }).why, 'quiet hours');
    assert.deepEqual(mayText({ urgency: 'urgent' }, { now: late, config: cfg }), { send: true });
    assert.equal(mayText({ urgency: 'normal' }, { now: T0, config: cfg, controls: [{ command: 'pause', ts: iso(T0), ms: 60_000 }] }).why, 'paused');
    assert.equal(mayText({ urgency: 'urgent' }, { now: T0, config: cfg, controls: [{ command: 'stop', ts: iso(T0) }] }).why, 'stopped');
    assert.equal(mayText({ urgency: 'normal' }, { now: T0, config: cfg, sends: [{ ts: iso(T0 - 1000), kind: 'ask' }, { ts: iso(T0 - 2000), kind: 'batch' }] }).why, 'rate limit');
  });
  test('channels: the ask\'s own order or the configured one, only usable ones', () => {
    assert.deepEqual(channelOrder({}, { order: ['telegram', 'imessage', 'sms'], usable: ['sms', 'telegram'] }), ['telegram', 'sms']);
    assert.deepEqual(channelOrder({ channels: ['sms', 'imessage'] }, { order: ['telegram'], usable: ['sms', 'telegram'] }), ['sms']);
  });
  test('one reminder before expiry: a fifth of the life, at least ten minutes; none for a short life', () => {
    assert.equal(reminderAt({ routedAt: iso(T0), expiresAt: iso(T0 + 10 * 3_600_000) }), T0 + 8 * 3_600_000);
    assert.equal(reminderAt({ routedAt: iso(T0), expiresAt: iso(T0 + 30 * 60_000) }), T0 + 20 * 60_000);
    assert.equal(reminderAt({ routedAt: iso(T0), expiresAt: iso(T0 + 5 * 60_000) }), null);
    assert.equal(reminderAt({ routedAt: iso(T0) }), null);
  });
});
