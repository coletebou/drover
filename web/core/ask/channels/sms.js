// SMS through Twilio, from a number in an approved US A2P 10DLC campaign, to the owner's phone.
//
//   DROVER_ASK_TWILIO_ACCOUNT_SID, DROVER_ASK_TWILIO_AUTH_TOKEN   the account (secrets: ~/.env_secrets). Drover's own
//                               names, so a dev server reading TWILIO_* never picks them up.
//   DROVER_ASK_SMS_FROM         the sending number, E.164 (+18065550123)
//   DROVER_ASK_SMS_TO           the owner's phone, E.164: the only sender whose replies count
//   DROVER_ASK_TWILIO_API       the API origin (tests point it at a fake)
//
// An inbound webhook is believed only with a valid X-Twilio-Signature (HMAC-SHA1 of the URL Twilio called and the
// sorted form fields, keyed by the auth token, compared in constant time), the account's own AccountSid, To our
// number and From the owner's. Twilio itself answers STOP/START on a Messaging Service (opt-out); Drover's own
// stop/resume ride on top.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { envvar } from '../../envvars.js';
import { clip } from '../model.js';

export const NAME = 'sms';
export const _deps = { fetch: (...a) => fetch(...a), env: process.env };

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
});

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

/** Whether a webhook's X-Twilio-Signature is right for this URL and these fields. */
export function authentic(url, params, header, { env = _deps.env } = {}) {
  const c = cfg(env);
  if (!c.token || typeof header !== 'string' || !header) return false;
  const a = Buffer.from(signature(c.token, url, params)), b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** An inbound SMS as the router reads it. Verified only for our account, our number, and the owner's phone. */
export function readInbound(params, { env = _deps.env } = {}) {
  const c = cfg(env);
  const from = e164(params.From), to = e164(params.To);
  const why = params.AccountSid !== c.sid ? 'another Twilio account' : to !== c.from ? 'sent to another number' : from !== c.to ? 'not the owner\'s phone' : null;
  return { channel: NAME, verified: !why, reason: why, sender: `sms:${from}`, text: String(params.Body ?? ''), providerMessageId: `sms:${params.MessageSid ?? params.SmsSid ?? ''}`, replyTo: null, button: null };
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
