// Routine setup with a pairing code: the owner gives a Grok bot its Drover routine from any device, without a terminal
// and without the routine's key ever passing through a chat. The bot (drover_whoami) hands the owner a link to the bot
// gateway's page (/bots/<bot>/routine, server/botgate.js); the owner pastes the routine's Webhook URL and key there; the
// page shows a 6-digit code; the owner approves that code in Drover (the browser banner, `drover bots routine approve
// <code>`), and only then is the Routine set (core/bots/grok.js setRoutine) and its connection test sent.
//  - A setup waits in this process's memory only, for ten minutes: nothing is written before the owner says yes, and a
//    restart forgets it (its page then says it expired). The URL and key are dropped from memory once it is decided.
//  - The key and the whole URL never reach a log, an event, an alert, a broadcast, a page or a bot: the owner sees the
//    webhook as host and id tail (as `drover bots routines` shows a Routine), and whether it replaces the bot's own.
//  - The page's form carries a nonce it was given (single use, bound to the address that opened it), so another site
//    cannot submit one through the owner's browser; approving and denying are main-token routes (/api/bots/routine/*),
//    never ops, so no agent can let a webhook in.
//  - Limits as for bot connections (core/bots/oauth.js): per address and in all, for the forms open, what waits, a
//    minute's submissions and the alerts they raise. The same address asking again for the same bot replaces its
//    earlier setup; opening the page again and again drops only that address's own oldest forms, never another's.
import { randomBytes, randomInt } from 'node:crypto';
import * as grok from './grok.js';

export const PENDING_TTL_MS = 10 * 60_000;     // the owner has ten minutes to approve
export const COLLECT_MS = 60_000;              // after the decision, the page has a minute to show it
export const NONCE_TTL_MS = 10 * 60_000;       // an opened form can be sent for ten minutes, once
export const MAX_PENDING = 20;                 // setups waiting, in all
export const MAX_PENDING_PER_SOURCE = 3;       // ... sent from one address
export const MAX_PER_MINUTE = 60;              // setups sent a minute, in all
export const MAX_PER_MINUTE_PER_SOURCE = 10;   // ... from one address
export const ALERT_WINDOW_MS = 10 * 60_000;
export const ALERTS_PER_SOURCE = 2;            // alerts per address per window
export const ALERTS_MAX = 6;                   // alerts in all per window
export const MAX_NONCES = 500;                 // forms open, in all: past it a new one waits (none open is dropped for it)
export const MAX_NONCES_PER_SOURCE = 5;        // ... opened from one address: its own oldest goes for a new one
const FROM_MAX = 160;

/** Refused, in Drover's words (never the URL or the key); status is the HTTP status for the page or the route. */
export class SetupError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'SetupError'; this.status = status; }
}

export const _deps = {
  now: () => Date.now(),
  setRoutine: (bot, routine) => grok.setRoutine(bot, routine),
  sendTest: (bot) => grok.sendTest(bot),
  routines: () => grok.routines(),
};

const pending = new Map();   // rid -> { rid, code, bot, url, key, from, source, createdAt, expiresAt, state, webhook, result }
const nonces = new Map();    // nonce -> { bot, source, expiresAt }
let sent = [];               // { at, source } of setups sent in the last minute
let alerted = [];            // { at, source } of alerts raised in the last ALERT_WINDOW_MS
const iso = (ms) => new Date(ms).toISOString();

function sweep(now = _deps.now()) {
  // A setup being saved stays until it is decided (approve() always ends it), so its page never reads as expired then.
  for (const [rid, p] of pending) if (p.expiresAt <= now && p.state !== 'saving') pending.delete(rid);
  for (const [n, x] of nonces) if (x.expiresAt <= now) nonces.delete(n);
  sent = sent.filter((x) => now - x.at < 60_000);
  alerted = alerted.filter((x) => now - x.at < ALERT_WINDOW_MS);
}

/** Tests: forget everything. */
export function _reset() { pending.clear(); nonces.clear(); sent = []; alerted = []; }

/**
 * A nonce for the form a page shows to source for bot: what the form must send back, once. An address keeps its newest
 * few (its own oldest goes for a new one) and never takes another address's: past the limit in all, none is given
 * until one is sent or expires (SetupError 429), so no one can push the owner's open form out by asking for pages.
 */
export function formNonce(bot, { source } = {}) {
  const n = grok.botName(bot);
  if (!n) throw new SetupError('not a bot name', 404);
  sweep();
  const src = source || null;
  const mine = [...nonces].filter(([, x]) => x.source === src).map(([k]) => k);   // oldest first
  for (const k of mine.slice(0, Math.max(0, mine.length - MAX_NONCES_PER_SOURCE + 1))) nonces.delete(k);
  if (nonces.size >= MAX_NONCES) throw new SetupError('too many setup pages are open right now; try again in a few minutes', 429);
  const nonce = randomBytes(16).toString('hex');
  nonces.set(nonce, { bot: n, source: src, expiresAt: _deps.now() + NONCE_TTL_MS });
  return nonce;
}

const label = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * The owner sent the form: the bot's routine webhook, waiting for the owner's approval of the code it returns. source is
 * the address key for the limits (botgate.js sourceKey), from what the approver is shown. Returns { rid (the page's
 * secret), code, bot, expiresAt, alert } (alert: whether to raise one).
 */
export function submit(bot, { url, key, nonce } = {}, { source = null, from = '' } = {}) {
  const n = grok.botName(bot);
  if (!n) throw new SetupError('not a bot name', 404);
  const now = _deps.now();
  sweep(now);
  // Single use, from the page this address opened for this bot: another site cannot send one through a browser.
  const f = typeof nonce === 'string' ? nonces.get(nonce) : null;
  if (!f || f.bot !== n || f.source !== (source || null)) throw new SetupError('this form has expired: open the link again', 400);
  nonces.delete(nonce);
  if (typeof url !== 'string' || !grok.routineUrlAllowed(url.trim())) throw new SetupError('the Webhook URL must be the https address Grok Bot shows for the routine (https://api2.cursor.sh/automations/webhook/...)');
  if (!grok.routineKeyAllowed(key)) throw new SetupError('the Webhook key must be the one Grok Bot shows for that webhook (crsr_..., one word)');
  if (source && sent.filter((x) => x.source === source).length >= MAX_PER_MINUTE_PER_SOURCE) throw new SetupError('too many setups from your address; wait a minute', 429);
  if (sent.length >= MAX_PER_MINUTE) throw new SetupError('too many setups; wait a minute', 429);
  sent.push({ at: now, source: source || null });
  const waiting = [...pending.values()].filter((p) => p.state === 'pending');
  // The same address asking again for the same bot (a second try, a fixed paste) replaces the earlier one.
  const again = source ? waiting.filter((p) => p.source === source && p.bot === n) : [];
  const others = waiting.filter((p) => !again.includes(p));
  if (source && others.filter((p) => p.source === source).length >= MAX_PENDING_PER_SOURCE) throw new SetupError('too many setups are already waiting from your address; approve or deny them in Drover, or wait for them to expire', 429);
  if (others.length >= MAX_PENDING) throw new SetupError('too many setups are waiting in Drover; approve or deny them first', 429);
  for (const p of again) pending.delete(p.rid);   // its page now reads as expired
  const live = new Set([...pending.values()].map((p) => p.code));
  let code;
  do code = String(randomInt(0, 1_000_000)).padStart(6, '0'); while (live.has(code));
  const p = {
    rid: randomBytes(16).toString('hex'), code, bot: n, url: url.trim(), key: key.trim(), webhook: grok.describeWebhook(url.trim()),
    from: label(from, FROM_MAX), source: source || null, createdAt: now, expiresAt: now + PENDING_TTL_MS, state: 'pending', result: null,
  };
  pending.set(p.rid, p);
  return { rid: p.rid, code, bot: n, expiresAt: iso(p.expiresAt), alert: !again.length && mayAlert(now, source) };
}

function mayAlert(now, source) {
  if (alerted.length >= ALERTS_MAX) return false;
  if (source && alerted.filter((a) => a.source === source).length >= ALERTS_PER_SOURCE) return false;
  alerted.push({ at: now, source: source || null });
  return true;
}

/** What the page sees for its setup: pending (its code), decided (saved, with how the test went, or denied), or null. */
export function status(rid) {
  sweep();
  if (typeof rid !== 'string' || !/^[0-9a-f]{32}$/.test(rid)) return null;
  const p = pending.get(rid);
  if (!p) return null;
  if (p.state === 'pending' || p.state === 'saving') return { status: 'pending', code: p.code, bot: p.bot, expiresAt: iso(p.expiresAt) };
  return { status: p.state, bot: p.bot, ...(p.result ? { test: p.result } : {}) };
}

/**
 * Setups waiting for the owner, for the banner and `drover bots routine pending`: the code, the bot, the webhook as
 * host and id tail, where it was sent from, and the Routine it would replace (host and tail). Never the URL or the key,
 * never rid (the page's secret).
 */
export async function pendingList() {
  sweep();
  const list = [...pending.values()].filter((p) => p.state === 'pending');
  if (!list.length) return [];
  const current = new Map((await _deps.routines().catch(() => [])).filter((r) => r.routine).map((r) => [r.bot, r.routine]));
  return list.sort((a, b) => a.createdAt - b.createdAt).map((p) => ({
    code: p.code, bot: p.bot, webhook: p.webhook, from: p.from, createdAt: iso(p.createdAt), expiresAt: iso(p.expiresAt),
    replaces: current.has(p.bot) ? { host: current.get(p.bot).host, webhook: current.get(p.bot).webhook } : null,
  }));
}

function findPending(code) {
  const c = String(code ?? '').replace(/[\s-]/g, '');
  if (!/^\d{6}$/.test(c)) throw new SetupError('code must be the 6 digits the setup page shows', 400);
  sweep();
  const p = [...pending.values()].find((x) => x.state === 'pending' && x.code === c);
  if (!p) throw new SetupError(`no routine setup waiting with code ${c} (it may have expired, or been answered)`, 404);
  return p;
}

/** How the connection test went, as its page may say it: Drover's words only, never what the webhook answered. */
const WHY = { 400: 'the routine is paused, or refused the test', 401: 'the key was refused', 403: 'the key was refused', 404: 'there is no such webhook', 429: 'Grok Bot is rate limiting it' };
const shownTest = (t) => (t?.ok === true ? { ok: true } : { ok: false, why: Number.isInteger(t?.status) ? WHY[t.status] ?? `the webhook answered HTTP ${t.status}` : 'the webhook could not be reached' });

/** Forget what was pasted: once a setup is decided, only grok.json (0600) has it, and only when it was approved. */
const decided = (p, state, result = null) => { p.state = state; p.result = result; p.url = null; p.key = null; p.expiresAt = Math.max(p.expiresAt, _deps.now() + COLLECT_MS); };

/**
 * The owner approves the setup with this code: the Routine is set, then its connection test sent. Returns { bot,
 * routine (host, id tail), test: { ok, runUuid?, error? } }. A setup is decided once: a second approval finds nothing.
 */
export async function approve(code) {
  const p = findPending(code);
  p.state = 'saving';   // decided now: a second approval (two screens at once) finds nothing to approve
  let set;
  try { set = await _deps.setRoutine(p.bot, { url: p.url, key: p.key }); }
  catch (e) { p.state = 'pending'; throw new SetupError(`the Routine was not saved: ${String(e?.message ?? e).slice(0, 200)}`, 500); }
  const t = await _deps.sendTest(p.bot).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
  decided(p, 'saved', shownTest(t));
  // The owner's own answer says all of it (what the webhook answered included): the page says only shownTest.
  const test = t?.ok === true ? { ok: true, ...(t.runUuid ? { runUuid: String(t.runUuid).slice(0, 80) } : {}) } : { ok: false, error: String(t?.error ?? 'failed').slice(0, 300) };
  return { bot: p.bot, routine: set?.routine ?? p.webhook, test };
}

/** The owner denies the setup with this code: nothing is kept. */
export function deny(code) {
  const p = findPending(code);
  decided(p, 'denied');
  return { bot: p.bot, denied: true };
}
