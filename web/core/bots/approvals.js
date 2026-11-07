// First-class approvals: a Grok bot asks the owner a question with a few options before it acts (a purchase, an action
// with consequences); the owner answers in one tap on the board, the iPhone, the watch or a notification; the decision
// goes back to the bot.
//  - The store, <state>/bots/approvals.json (0600, beside grok.json), is the authority: what a bot acts on
//    (drover_approvals) comes from here only. The daemon is its one writer, one change at a time.
//  - The truth file is the record: an approval event for the request (actor the bot, marked untrusted), for the
//    decision (actor the owner) and for a withdrawal. Any agent can append to the truth file, so the events.append op
//    refuses approval events (core/api.js) and nothing here reads a decision back from it.
//  - Answering is a main-token HTTP route (server/http.js /api/approvals/answer), never an op: an op is reachable
//    through MCP and ssh rpc, and no agent may approve a purchase for the owner.
//  - The decision reaches the bot as a message from the owner that carries approval { id, n, label }: its Routine runs
//    on it like any message (old Routine instructions included), or it waits in the bot's inbox.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stateDir } from '../paths.js';
import { uuidv7 } from '../ids.js';
import * as eventsMod from '../events.js';
import { notifier } from '../notify.js';
import { OWNER, OWNER_NAME } from '../owner.js';
import * as grok from './grok.js';
import { clean } from './policy.js';

export const KINDS = ['purchase', 'action', 'post', 'other'];
export const STATUSES = ['pending', 'decided', 'withdrawn', 'expired'];
export const DEFAULT_OPTIONS = ['Approve', 'Deny'];
export const PENDING_PER_BOT = 5;
export const PENDING_MAX = 50;
export const QUESTION_MAX = 300;
export const DETAILS_MAX = 2000;
export const LABEL_MAX = 60;
const MINUTES = { min: 5, default: 24 * 60, max: 7 * 24 * 60 };
const KEEP_DONE = 300;   // answered, withdrawn and expired requests kept for drover_approvals and the CLI
/** The label a pending approval's ask carries on the board, in alerts and on native clients. */
export const ASK_LABEL = 'asks for your approval';

export const _deps = {
  now: () => Date.now(),
  file: () => path.join(stateDir(), 'bots', 'approvals.json'),
  append: (ev, opts) => eventsMod.append(ev, opts),
  send: (id, text, opts) => grok.send(id, text, opts),
  emit: (list) => notifier.emit(list),
  host: () => eventsMod.shortHost(),
};

/** Refusals the answer route turns into an HTTP status: 404 no such approval here, 409 it is not pending, 400 a bad choice. */
export class ApprovalError extends Error {
  constructor(message, status = 400, extra = {}) { super(message); this.name = 'ApprovalError'; this.status = status; Object.assign(this, extra); }
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const ID_RE = /^ap_[a-f0-9]{12}$/;
export const isApprovalId = (id) => typeof id === 'string' && ID_RE.test(id);
const newId = () => `ap_${randomBytes(6).toString('hex')}`;

/** One line: control characters out, whitespace runs to one space, secrets redacted, home paths shortened, capped. */
function oneLine(s, max) {
  return clean(String(s ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim(), max);
}
/** Several lines: control characters out but for line breaks, at most two blank lines in a row, cleaned, capped. */
function paragraphs(s, max) {
  return clean(String(s ?? '').replace(/\r\n?/g, '\n').replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), max);
}

// The truth-file records below are best effort, like a receipt (core/bots/grok.js markRead): the store is the
// authority, and a record that fails to land must not undo a request or a decision already made.

// ---------------------------------------------------------------- the store
async function load() {
  try {
    const c = JSON.parse(await readFile(_deps.file(), 'utf8'));
    if (c && typeof c === 'object' && Array.isArray(c.items)) return c;
  } catch { /* missing or unreadable: no approvals */ }
  return { v: 1, items: [] };
}
async function save(c) {
  const file = _deps.file();
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(c, null, 1) + '\n', { mode: 0o600 });
  await rename(tmp, file);
}
let chain = Promise.resolve();
/**
 * Change the store one change at a time, each reading what the one before it wrote (as grok.js updateConfig): two taps
 * on one approval (the phone and the watch) cannot both decide it. change(store) edits in place and returns the
 * result; a throw saves nothing.
 */
function update(change) {
  const run = chain.then(async () => {
    const c = await load();
    expire(c);
    const result = await change(c);
    prune(c);
    await save(c);
    return result;
  });
  chain = run.catch(() => { /* the next change starts from the file either way */ });
  return run;
}
/** A pending request past its time is written as expired, so it counts as done (and is pruned like the rest). */
function expire(c, now = _deps.now()) {
  for (const x of c.items) if (x.status === 'pending' && statusOf(x, now) === 'expired') x.status = 'expired';
}
/** When a request stopped being pending: answered, withdrawn, or expired. */
const endedAt = (x) => Date.parse(x.decision?.at ?? x.withdrawnAt ?? x.expiresAt ?? x.createdAt) || 0;
/**
 * Every pending request stays; of the rest, the KEEP_DONE that ended last. By end time, not creation: a request
 * answered just now must stay for the bot to confirm, however many newer ones ended before it.
 */
function prune(c) {
  const done = c.items.filter((x) => x.status !== 'pending');
  if (done.length <= KEEP_DONE) return;
  const drop = new Set(done.sort((a, b) => endedAt(b) - endedAt(a)).slice(KEEP_DONE));
  c.items = c.items.filter((x) => !drop.has(x));
}

/** Pending, decided, withdrawn, or expired: a pending request past its time expired, whether or not anyone wrote that. */
export const statusOf = (x, now = _deps.now()) => (x.status === 'pending' && now > Date.parse(x.expiresAt) ? 'expired' : x.status);

/** A request as the bot that made it sees it (drover_approvals): the question, its options and the owner's answer. */
export function botView(x, now = _deps.now()) {
  return {
    id: x.id, status: statusOf(x, now), kind: x.kind, question: x.question, options: x.options, details: x.details || null,
    ...(x.messageId ? { messageId: x.messageId } : {}), createdAt: x.createdAt, expiresAt: x.expiresAt,
    decision: x.decision ? { n: x.decision.n, label: x.decision.label, at: x.decision.at, by: x.decision.by } : null,
    ...(x.withdrawnAt ? { withdrawnAt: x.withdrawnAt } : {}),
  };
}
/**
 * A request as the owner's clients see it: which bot asks, and that its words are the bot's (untrusted). The client
 * that answered (via) is in decision, as native/CONTRACT.md has it, and at the top too, where the CLI and the native
 * clients' "answered already" read it.
 */
export function ownerView(x, now = _deps.now()) {
  const v = botView(x, now);
  return { ...v, ...(v.decision ? { decision: { ...v.decision, via: x.decision.via ?? null } } : {}), bot: grok.idFor(x.bot), botName: grok.display(x.bot), via: x.decision?.via ?? null, ...grok.provenance(x.bot) };
}

/** Pending requests per bot (name -> owner views, oldest first). grok.listSessions shows a bot with any as waiting. */
export async function pendingByBot() {
  const now = _deps.now();
  const out = new Map();
  for (const x of (await load()).items) {
    if (statusOf(x, now) !== 'pending') continue;
    if (!out.has(x.bot)) out.set(x.bot, []);
    out.get(x.bot).push(ownerView(x, now));
  }
  for (const list of out.values()) list.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  return out;
}
grok._deps.approvals = pendingByBot;

/** Requests, newest first: one bot's (name), or every bot's; status one of STATUSES, or all. */
export async function list({ bot, status, limit = 50, view = ownerView } = {}) {
  const now = _deps.now();
  const n = bot === undefined || bot === null ? null : grok.botName(bot);
  if (bot !== undefined && bot !== null && !n) throw new Error('bot must be a Grok bot name, like alpha');
  if (status !== undefined && status !== 'all' && !STATUSES.includes(status)) throw new Error(`status must be one of ${STATUSES.join(', ')} or all`);
  const lim = Math.max(1, Math.min(300, Math.floor(Number(limit)) || 50));
  return (await load()).items
    .filter((x) => (!n || x.bot === n) && (!status || status === 'all' || statusOf(x, now) === status))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, lim).map((x) => view(x, now));
}

/** One request by id, or null. */
export async function get(id) {
  if (!isApprovalId(id)) return null;
  return (await load()).items.find((x) => x.id === id) ?? null;
}

// ---------------------------------------------------------------- a bot asks
/** The options a request offers: 2 to 4 distinct one-line labels, numbered from 1. Default Approve / Deny. */
export function normalizeOptions(options) {
  const raw = options === undefined || options === null ? DEFAULT_OPTIONS : options;
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 4) throw new Error('options must be 2 to 4 short labels, like ["Approve", "Deny"]');
  const labels = raw.map((o) => (typeof o === 'string' && o.length <= 2 * LABEL_MAX ? oneLine(o, LABEL_MAX + 1) : ''));
  if (labels.some((l) => l.length > LABEL_MAX)) throw new Error(`each option must be a label of 1 to ${LABEL_MAX} characters`);
  if (labels.some((l) => !l)) throw new Error(`each option must be a label of 1 to ${LABEL_MAX} characters`);
  if (new Set(labels.map((l) => l.toLowerCase())).size !== labels.length) throw new Error('options must differ from each other');
  return labels.map((label, i) => ({ n: i + 1, label }));
}

function minutesArg(v) {
  if (v === undefined || v === null) return MINUTES.default;
  const m = Number(v);
  if (!Number.isFinite(m) || m < MINUTES.min || m > MINUTES.max) throw new Error(`expiresInMinutes must be ${MINUTES.min} to ${MINUTES.max} (7 days)`);
  return Math.round(m);
}

/** The ask an approval shows wherever Drover shows asks (board strips, alerts, native clients). */
export const askOf = (x) => ({ kind: 'decision', label: ASK_LABEL, text: x.question, options: x.options.map((o) => ({ n: o.n, label: o.label })) });

/**
 * The bot `name` asks the owner. Validates and cleans the request; the same question, options, details, kind and
 * message while one is pending returns that one (created false) and raises nothing. mayAlert() is asked before a new request is made
 * (the bot's alert budget): false refuses it. A new request is stored, recorded in the truth file as the bot's
 * (marked untrusted) and raised as a needs-you alert that carries it (kind approval).
 */
export async function request(name, { question, options, details, kind = 'other', expiresInMinutes, messageId } = {}, { mayAlert } = {}) {
  const n = grok.botName(name);
  if (!n) throw new Error('not a Grok bot');
  if (typeof question !== 'string' || !question.trim()) throw new Error('question is required: what exactly you want approved, in one line');
  // Bounded before the redactor sees them (it is slow on long runs): twice the limit leaves room for whitespace it drops.
  if (question.length > 2 * QUESTION_MAX) throw new Error(`question must be at most ${QUESTION_MAX} characters; put the rest in details`);
  if (typeof details === 'string' && details.length > 2 * DETAILS_MAX) throw new Error(`details must be at most ${DETAILS_MAX} characters`);
  const q = oneLine(question, QUESTION_MAX + 1);
  if (q.length > QUESTION_MAX) throw new Error(`question must be at most ${QUESTION_MAX} characters; put the rest in details`);
  const opts = normalizeOptions(options);
  if (details !== undefined && details !== null && typeof details !== 'string') throw new Error('details must be text');
  const d = details ? paragraphs(details, DETAILS_MAX + 1) : '';
  if (d.length > DETAILS_MAX) throw new Error(`details must be at most ${DETAILS_MAX} characters`);
  if (!KINDS.includes(kind)) throw new Error(`kind must be one of ${KINDS.join(', ')}`);
  const minutes = minutesArg(expiresInMinutes);
  let about = null;
  if (messageId !== undefined && messageId !== null) {
    if (typeof messageId !== 'string' || !messageId.trim() || messageId.length > 200) throw new Error('messageId must be a messageId from drover_inbox');
    about = await grok.inboxMessage(n, messageId.trim());
    if (!about) throw new Error(`no message ${messageId.slice(0, 60)} in your inbox (drover_inbox lists them)`);
  }
  // The same request is the same in every word the owner reads, and about the same message: a later one that differs
  // only in its details (another item, another price) is another request, never a ride on the first one's answer.
  const sigOf = (x) => JSON.stringify([x.question, x.options.map((o) => o.label), x.details ?? '', x.kind, x.messageId ?? null]);
  const sig = sigOf({ question: q, options: opts, details: d, kind, messageId: about ? about.id : null });
  const made = await update((c) => {
    const now = _deps.now();
    const mine = c.items.filter((x) => x.bot === n && statusOf(x, now) === 'pending');
    const same = mine.find((x) => sigOf(x) === sig);
    if (same) return { item: same, created: false };
    if (mine.length >= PENDING_PER_BOT) throw new Error(`refused: ${mine.length} of your approval requests are pending already; withdraw one you no longer need (drover_approval_withdraw) or wait for ${OWNER_NAME}'s answer`);
    if (c.items.filter((x) => statusOf(x, now) === 'pending').length >= PENDING_MAX) throw new Error(`refused: ${PENDING_MAX} approval requests are pending across the bots; wait for ${OWNER_NAME} to answer some`);
    if (mayAlert && !mayAlert()) throw new Error(`refused: you raised too many alerts in the last hour; an approval request is one. Write a drover_note, and ask again later`);
    const item = {
      // The message by its event id, which Drover stamps: its ref is the sender's to choose, and this id rides in owner
      // records (the decision's approval.messageId). drover_reply answers a message by either.
      id: newId(), bot: n, question: q, options: opts, details: d, kind, ...(about ? { messageId: about.id } : {}),
      createdAt: new Date(now).toISOString(), expiresAt: new Date(now + minutes * 60_000).toISOString(), status: 'pending', decision: null,
    };
    c.items.push(item);
    return { item, created: true };
  });
  if (!made.created) return made;
  const { item } = made;
  const mark = grok.untrustedMark(n);
  // The record: the bot's words carry the mark wherever an agent reads them.
  await _deps.append({
    type: 'approval', aid: item.id, state: 'pending', bot: grok.idFor(n), kind: item.kind, question: `${mark} ${item.question}`, options: item.options,
    ...(item.details ? { details: `${mark} ${item.details}` } : {}), expiresAt: item.expiresAt, ...(item.messageId ? { messageId: item.messageId } : {}), ...grok.provenance(n),
  }, { actor: grok.actorFor(n) }).catch(() => null);
  await _deps.emit([{
    category: 'needs-you', kind: 'approval', source: 'bots', actor: grok.actorFor(n), host: _deps.host(), sessionId: grok.idFor(n), name: grok.display(n), engine: grok.ENGINE,
    // The question and labels are the bot's: marked in the body, and the recorded notify event says untrusted.
    title: `${grok.display(n)} ${ASK_LABEL}`, body: `${mark} ${item.question} (${item.options.map((o) => o.label).join(' / ')})`, key: `approval|${item.id}`,
    ask: askOf(item), meta: { approval: ownerView(item) }, untrusted: true,
  }]).catch(() => []);
  _deps.changed?.();
  return made;
}

/** The bot `name` takes back a pending request of its own. */
export async function withdraw(name, id) {
  const n = grok.botName(name);
  if (!isApprovalId(id)) throw new Error('id must be an approval id, ap_ and 12 hex digits (drover_approvals lists yours)');
  const item = await update((c) => {
    const x = c.items.find((y) => y.id === id && y.bot === n);
    if (!x) throw new Error(`no approval request ${id} of yours`);
    const st = statusOf(x, _deps.now());
    if (st !== 'pending') throw new Error(`approval ${id} is ${st} already${x.decision ? `: ${OWNER_NAME} answered ${x.decision.label}` : ''}`);
    x.status = 'withdrawn'; x.withdrawnAt = new Date(_deps.now()).toISOString();
    return x;
  });
  await _deps.append({ type: 'approval', aid: item.id, state: 'withdrawn', bot: grok.idFor(n), ...grok.provenance(n) }, { actor: grok.actorFor(n) }).catch(() => null);
  _deps.changed?.();
  return botView(item);
}

// ---------------------------------------------------------------- the owner answers
/** How a client answered (decision.via): a short client name, like web, ios, ios-notification, watch, cli. */
const viaArg = (v) => (typeof v === 'string' && /^[a-z][a-z0-9-]{0,23}$/.test(v) ? v : 'drover');

/**
 * The option the owner picked, as the owner's records carry it: its number, and its label with the bot's mark (the bot
 * wrote the label; a record written as the owner must not pass it off as the owner's words).
 */
export const markedLabel = (x) => `${grok.untrustedMark(x.bot)} ${x.decision.label}`;

/**
 * The message that tells the bot the owner's decision: the request, the option picked, and to confirm it before acting.
 * It is recorded as the owner's, so it quotes none of the bot's question, and the label only with the bot's mark.
 */
export function decisionText(x) {
  const who = cap(OWNER_NAME);
  return [
    `[Drover] ${who} answered your approval request ${x.id} with option ${x.decision.n} of ${x.options.length} (your label: ${markedLabel(x)}).`,
    // The id rides in approval.messageId: text is cleaned on its way to the bot, and the redactor takes ids for secrets.
    // Not who sent it: an agent picks its own actor name, and this text is recorded as the owner's.
    x.messageId ? 'It was about the message in your inbox that approval.messageId names: answer that message with drover_reply too once you are done.' : null,
    `Confirm the decision with drover_approvals (action "show", id "${x.id}") before you act on it, then do only what it allows, and answer this message with drover_reply saying what you did.`,
  ].filter(Boolean).join(' ');
}

/**
 * The owner picks option `choice` (its n) of a pending request. Main token only: the HTTP route is its one caller.
 * Recorded in the store and the truth file, then delivered to the bot as a message from the owner carrying approval.
 * Refuses (ApprovalError) an unknown id (404), a request that is no longer pending (409, with what it is now) and a
 * choice it does not offer (400).
 */
export async function answer(id, { choice, via } = {}) {
  if (!isApprovalId(id)) throw new ApprovalError('id must be an approval id, like ap_0123456789ab', 400);
  if (!grok.configured()) throw new ApprovalError(`no approval ${id} here: this host keeps no Grok bots; answer it on the host that runs the bot gateway`, 404);
  const n = typeof choice === 'string' && /^\d+$/.test(choice.trim()) ? Number(choice) : choice;
  const item = await update((c) => {
    const x = c.items.find((y) => y.id === id);
    if (!x) throw new ApprovalError(`no approval ${id} here`, 404);
    const st = statusOf(x, _deps.now());
    if (st !== 'pending') throw new ApprovalError(st === 'decided' ? `approval ${id} was answered already: ${x.decision.label} (${x.decision.via})` : `approval ${id} is ${st}`, 409, { approval: ownerView(x) });
    const opt = Number.isInteger(n) ? x.options.find((o) => o.n === n) : null;
    if (!opt) throw new ApprovalError(`choice must be the number of one of its options: ${x.options.map((o) => `${o.n} ${o.label}`).join(', ')}`, 400);
    x.status = 'decided';
    x.decision = { n: opt.n, label: opt.label, at: new Date(_deps.now()).toISOString(), by: OWNER, via: viaArg(via) };
    return x;
  });
  await _deps.append({ type: 'approval', aid: item.id, state: 'decided', bot: grok.idFor(item.bot), decision: { n: item.decision.n, label: markedLabel(item) }, via: item.decision.via }, { actor: OWNER }).catch(() => null);
  _deps.changed?.();   // the boards drop the card now, not after the bot's Routine answers (up to 30 s)
  const delivery = await deliver(item);
  return { ...ownerView(item), delivery: { ok: delivery.ok, via: delivery.via ?? null, ...(delivery.queued ? { queued: true } : {}), ...(delivery.error ? { error: delivery.error } : {}) } };
}

/** Send the decision to the bot as the owner's message (its Routine runs on it, or it waits in the inbox) and record it. */
async function deliver(x) {
  const text = decisionText(x);
  const approval = { id: x.id, n: x.decision.n, label: markedLabel(x), ...(x.messageId ? { messageId: x.messageId } : {}) };
  // The message's ref is stored before it is sent: the bot may read its inbox the moment its Routine starts.
  const ref = uuidv7();
  await update((c) => { const y = c.items.find((z) => z.id === x.id); if (y) y.toldRef = ref; });
  x.toldRef = ref;
  let delivery;
  try { delivery = await _deps.send(grok.idFor(x.bot), text, { actor: OWNER, approval, ref }); }
  catch (e) { delivery = { ok: false, error: e.message }; }
  const to = { kind: grok.ENGINE, host: _deps.host(), id: grok.idFor(x.bot), name: grok.display(x.bot) };
  // The stored ref, whatever the send did: a send that threw still leaves the decision in the bot's inbox, with its note.
  await _deps.append({ type: 'message', to, text, ref, delivery, approval }, { actor: OWNER }).catch(() => null);
  return delivery;
}

/**
 * The bot's decided requests, id -> the option the owner picked: what an inbox note must match before a bot is shown
 * it (core/bots/grok.js inboxFrom). The truth file syncs from every host, older ones too: a note there proves nothing.
 */
export async function decidedFor(name) {
  const n = grok.botName(name);
  // Everything a note says comes from here, and it goes only on the message that told the bot (its ref, toldRef).
  return new Map((await load()).items.filter((x) => x.bot === n && x.status === 'decided' && x.decision).map((x) => [x.id, { n: x.decision.n, label: markedLabel(x), ...(x.messageId ? { messageId: x.messageId } : {}), ref: x.toldRef ?? null }]));
}

/** whoami's numbers: pending requests, and requests answered in the last day. */
export async function counts(name, now = _deps.now()) {
  const n = grok.botName(name);
  let pending = 0, answered = 0;
  for (const x of (await load()).items) {
    if (x.bot !== n) continue;
    const st = statusOf(x, now);
    if (st === 'pending') pending++;
    else if (st === 'decided' && now - Date.parse(x.decision.at) < 86_400_000) answered++;
  }
  return { pending, answered };
}

export function _reset() { chain = Promise.resolve(); }
