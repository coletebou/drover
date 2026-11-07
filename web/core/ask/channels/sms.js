// SMS through Twilio, from a number in an approved US A2P 10DLC campaign, to the owner's phone.
//
//   DROVER_ASK_TWILIO_ACCOUNT_SID, DROVER_ASK_TWILIO_AUTH_TOKEN   the account (secrets: ~/.env_secrets). Drover's own
//                               names, so a dev server reading TWILIO_* never picks them up.
//   DROVER_ASK_SMS_FROM         the sending number, E.164 (+18065550123)
//   DROVER_ASK_SMS_TO           the owner's phone, E.164: the only sender whose replies count
//   DROVER_ASK_TWILIO_API       the API origin (tests point it at a fake)
//   DROVER_ASK_SMS_INBOUND      webhook (default when the bot gateway has a public URL) or poll: read the owner's
//                               replies from the account's message log every 15 s (filtered to the owner's number by
//                               Twilio, so no one else's message is ever fetched), for a hub with no public endpoint
//                               or a number whose Messaging Service sends no webhook
//
// An inbound webhook is believed only with a valid X-Twilio-Signature (HMAC-SHA1 of the URL Twilio called and the
// sorted form fields, keyed by the auth token, compared in constant time), the account's own AccountSid, To our
// number and From the owner's. Twilio itself answers STOP/START on a Messaging Service (opt-out); Drover's own
// stop/resume ride on top.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { envvar } from '../../envvars.js';
import { stateDir } from '../../paths.js';
import { clip } from '../model.js';

export const NAME = 'sms';
export const _deps = { fetch: (...a) => fetch(...a), env: process.env, stateDir: () => stateDir() };
export const POLL_MS = 15_000;

/** +1 (704) 555-0123 -> +17045550123; a 10-digit US number gets +1. Anything else: as given, trimmed. */
export function e164(s) {
  const t = String(s ?? '').trim();
  const d = t.replace(/[^\d]/g, '');
  if (t.startsWith('+') && d.length >= 8 && d.length <= 15) return `+${d}`;
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return t;
}

const cfg = (env = _deps.env) => ({
  sid: (envvar('ASK_TWILIO_ACCOUNT_SID', env) ?? '').trim(),
  token: (envvar('ASK_TWILIO_AUTH_TOKEN', env) ?? '').trim(),
  from: e164(envvar('ASK_SMS_FROM', env)),
  to: e164(envvar('ASK_SMS_TO', env)),
  api: (envvar('ASK_TWILIO_API', env) ?? 'https://api.twilio.com').replace(/\/+$/, ''),
  inbound: String(envvar('ASK_SMS_INBOUND', env) ?? '').trim().toLowerCase(),
});
/** webhook or poll: poll when asked for, or when there is no public URL to take a webhook. */
export const inboundMode = ({ publicBase, env = _deps.env } = {}) => (cfg(env).inbound === 'poll' || !publicBase ? 'poll' : 'webhook');

export function missing(env = _deps.env) {
  const c = cfg(env);
  return [!/^AC[0-9a-f]{32}$/i.test(c.sid) && 'DROVER_ASK_TWILIO_ACCOUNT_SID', !c.token && 'DROVER_ASK_TWILIO_AUTH_TOKEN', !/^\+\d{8,15}$/.test(c.from) && 'DROVER_ASK_SMS_FROM', !/^\+\d{8,15}$/.test(c.to) && 'DROVER_ASK_SMS_TO'].filter(Boolean);
}
export const configured = (env) => missing(env).length === 0;

async function api(method, pathname, form = null, { env = _deps.env, timeoutMs = 20_000 } = {}) {
  const c = cfg(env);
  let res;
  try {
    res = await _deps.fetch(`${c.api}${pathname}`, {
      method,
      headers: { authorization: `Basic ${Buffer.from(`${c.sid}:${c.token}`).toString('base64')}`, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      ...(form ? { body: new URLSearchParams(form).toString() } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) { throw new Error(`twilio: ${e?.name === 'TimeoutError' ? `no answer in ${timeoutMs / 1000} s` : `unreachable (${e?.cause?.code ?? e?.name ?? 'error'})`}`); }
  let j = null;
  try { j = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) throw Object.assign(new Error(`twilio ${res.status}: ${clip(j?.message ?? 'error', 200)}${j?.code ? ` (${j.code})` : ''}`), { code: j?.code ?? null });
  return j;
}

/** Send one SMS to the owner. Returns { providerId }. */
export async function send({ text }, { env = _deps.env } = {}) {
  const c = cfg(env);
  const r = await api('POST', `/2010-04-01/Accounts/${c.sid}/Messages.json`, { To: c.to, From: c.from, Body: text }, { env });
  return { providerId: `sms:${r.sid}`, messageIds: [`sms:${r.sid}`] };
}

/** Twilio's request signature for a URL and its form fields (base64 HMAC-SHA1, keyed by the auth token). */
export function signature(token, url, params = {}) {
  const pairs = Object.entries(params).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, String(x)]) : [[k, String(v)]]));
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return createHmac('sha1', token).update(url + pairs.map(([k, v]) => k + v).join('')).digest('base64');
}

/** The URL with its port written out and without it: Twilio signs the form it was given, as its own SDKs check both. */
export function urlForms(url) {
  let u; try { u = new URL(url); } catch { return [url]; }
  const port = u.port || (u.protocol === 'https:' ? '443' : u.protocol === 'http:' ? '80' : '');
  const rest = `${u.pathname}${u.search}`;
  return [...new Set([url, `${u.protocol}//${u.hostname}${rest}`, `${u.protocol}//${u.hostname}:${port}${rest}`])];
}

/** Whether a webhook's X-Twilio-Signature is right for this URL (with or without its port) and these fields. */
export function authentic(url, params, header, { env = _deps.env } = {}) {
  const c = cfg(env);
  if (!c.token || typeof header !== 'string' || !header) return false;
  const b = Buffer.from(header);
  return urlForms(url).some((form) => { const a = Buffer.from(signature(c.token, form, params)); return a.length === b.length && timingSafeEqual(a, b); });
}

/** An inbound SMS as the router reads it. Verified only for our account, our number, and the owner's phone. */
export function readInbound(params, { env = _deps.env } = {}) {
  const c = cfg(env);
  const from = e164(params.From), to = e164(params.To);
  const why = params.AccountSid !== c.sid ? 'another Twilio account' : to !== c.from ? 'sent to another number' : from !== c.to ? 'not the owner\'s phone' : null;
  return { channel: NAME, verified: !why, reason: why, sender: `sms:${from}`, text: String(params.Body ?? ''), providerMessageId: `sms:${params.MessageSid ?? params.SmsSid ?? ''}`, replyTo: null, button: null };
}

/**
 * Polling, for a hub that takes no webhook: the owner's messages to our number from the account's log (Twilio filters
 * by From and To), newest first, each handed on once. What was there at the first look is the baseline, never
 * replayed; the message ids seen are kept on disk across restarts. Returns stop().
 */
export function startPolling(onInbound, { log = () => {}, env = _deps.env, everyMs = POLL_MS } = {}) {
  const c = cfg(env);
  const file = path.join(_deps.stateDir(), 'ask', 'sms-seen.json');
  let stopped = false, timer = null, seen = null;
  const save = async () => {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ sids: [...seen].slice(-300) }) + '\n', { mode: 0o600 });
    await rename(tmp, file);
  };
  const look = async () => {
    const q = new URLSearchParams({ To: c.from, From: c.to, PageSize: '20' });
    const r = await api('GET', `/2010-04-01/Accounts/${c.sid}/Messages.json?${q}`, null, { env, timeoutMs: 15_000 });
    const msgs = (r.messages ?? []).filter((m) => m.direction === 'inbound' && m.sid);
    if (seen === null) {
      try { seen = new Set(JSON.parse(await readFile(file, 'utf8')).sids ?? []); }
      catch { seen = new Set(msgs.map((m) => m.sid)); await save(); return; }   // first look ever: the baseline
    }
    const fresh = msgs.filter((m) => !seen.has(m.sid)).reverse();   // oldest first
    for (const m of fresh) {
      seen.add(m.sid);
      try { await onInbound(readInbound({ AccountSid: m.account_sid, From: m.from, To: m.to, Body: m.body, MessageSid: m.sid }, { env })); }
      catch (e) { log('sms inbound', e.message); }
    }
    if (fresh.length) await save();
  };
  const loop = async () => {
    if (stopped) return;
    try { await look(); } catch (e) { log('sms poll', e.message); }
    if (!stopped) { timer = setTimeout(loop, everyMs); timer.unref?.(); }
  };
  loop();
  return () => { stopped = true; clearTimeout(timer); };
}

/** Health: the account answers and the sending number is on it with SMS. */
export async function health({ env = _deps.env } = {}) {
  const miss = missing(env);
  if (miss.length) return { ok: false, configured: false, missing: miss };
  const c = cfg(env);
  try {
    const r = await api('GET', `/2010-04-01/Accounts/${c.sid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(c.from)}`, null, { env, timeoutMs: 10_000 });
    const n = r.incoming_phone_numbers?.[0];
    if (!n) return { ok: false, configured: true, error: 'the sending number is not on this account' };
    if (n.capabilities && n.capabilities.sms === false) return { ok: false, configured: true, error: 'the sending number has no SMS' };
    return { ok: true, configured: true, number: c.from, inboundUrl: n.sms_url ? 'set' : 'none' };
  } catch (e) { return { ok: false, configured: true, error: e.message }; }
}
