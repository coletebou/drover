// Telegram: a bot of the owner's own (created with @BotFather), messaging one chat, the owner's.
//
//   DROVER_ASK_TELEGRAM_TOKEN   the bot token (a secret: ~/.env_secrets)
//   DROVER_ASK_TELEGRAM_CHAT    the owner's numeric Telegram user id: the only sender whose replies count
//   DROVER_ASK_TELEGRAM_INBOUND webhook (default when the bot gateway's public URL is on a port Telegram calls: 443,
//                               80, 88 or 8443) or poll (long polling: no inbound port at all; the default otherwise)
//   DROVER_ASK_TELEGRAM_API     the Bot API origin (tests point it at a fake)
//
// Webhook updates are believed only with the secret header Telegram was given at setWebhook (a random value kept in
// the state directory, mode 0600, never derived from the token), and an update counts as the owner's only when both
// the sender and the private chat are the owner's id. Errors never carry the token (it is in every request path).
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { envvar } from '../../envvars.js';
import { stateDir } from '../../paths.js';
import { letter, clip } from '../model.js';

export const NAME = 'telegram';
export const _deps = { fetch: (...a) => fetch(...a), env: process.env, stateDir: () => stateDir() };

// Message and update ids are the bot account's: a replaced bot numbers from 1 again, in a chat whose id is the owner's
// for every bot. So every id Drover keeps carries the bot's own id (the token's number before the colon, not secret).
const cfg = (env = _deps.env) => ({
  token: envvar('ASK_TELEGRAM_TOKEN', env) ?? '',
  bot: /^(\d+):/.exec(envvar('ASK_TELEGRAM_TOKEN', env) ?? '')?.[1] ?? '0',
  chat: String(envvar('ASK_TELEGRAM_CHAT', env) ?? '').trim(),
  api: (envvar('ASK_TELEGRAM_API', env) ?? 'https://api.telegram.org').replace(/\/+$/, ''),
  inbound: String(envvar('ASK_TELEGRAM_INBOUND', env) ?? '').trim().toLowerCase(),
});

/** What is missing for this channel to work (names only). */
export function missing(env = _deps.env) {
  const c = cfg(env);
  return [!c.token && 'DROVER_ASK_TELEGRAM_TOKEN', !/^\d{3,15}$/.test(c.chat) && 'DROVER_ASK_TELEGRAM_CHAT'].filter(Boolean);
}
export const configured = (env) => missing(env).length === 0;
// Telegram calls a webhook only on these ports (core.telegram.org/bots/api#setwebhook); '' is the scheme's default (443).
export const WEBHOOK_PORTS = new Set(['', '443', '80', '88', '8443']);
/**
 * webhook or poll. poll when asked for, when there is no public URL, or when that URL's port is not one Telegram calls
 * (a Tailscale Funnel on :10000, say): long polling needs no inbound port at all. webhook when asked for.
 */
export function inboundMode({ publicBase, env = _deps.env } = {}) {
  const want = cfg(env).inbound;
  if (want === 'poll' || !publicBase) return 'poll';
  if (want === 'webhook') return 'webhook';
  try { return WEBHOOK_PORTS.has(new URL(publicBase).port) ? 'webhook' : 'poll'; } catch { return 'poll'; }
}

class TelegramError extends Error {
  constructor(method, description, code) { super(`telegram ${method}: ${description}`); this.code = code ?? null; }
}

/** One Bot API call. The token never reaches an error message. */
export async function call(method, body = {}, { timeoutMs = 20_000, env = _deps.env, signal = null } = {}) {
  const c = cfg(env);
  if (!c.token) throw new TelegramError(method, 'DROVER_ASK_TELEGRAM_TOKEN is not set');
  let res;
  try {
    res = await _deps.fetch(`${c.api}/bot${c.token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new TelegramError(method, e?.name === 'TimeoutError' ? `no answer in ${timeoutMs / 1000} s` : e?.name === 'AbortError' ? 'stopped' : `unreachable (${e?.cause?.code ?? e?.name ?? 'error'})`);
  }
  let j = null;
  try { j = await res.json(); } catch { /* not JSON */ }
  if (!j?.ok) throw new TelegramError(method, clip(j?.description ?? `HTTP ${res.status}`, 200), j?.error_code ?? res.status);
  return j.result;
}

/** Inline buttons for an ask's options: one row per question, data ask:<code>:<q>:<o> (the message id pins the ask). */
export function buttonsFor(asks) {
  const rows = [];
  for (const a of asks) {
    const multi = a.questions.length > 1 || asks.length > 1;
    a.questions.forEach((q, qi) => {
      if (!q.options.length) return;
      const row = q.options.map((o, oi) => ({ text: clip(`${multi ? `${asks.length > 1 ? `${a.code} ` : ''}${a.questions.length > 1 ? qi + 1 : ''}${letter(oi)}) ` : `${letter(oi)}) `}${o}`, 40), callback_data: `ask:${a.code}:${qi}:${oi}` }));
      for (let i = 0; i < row.length; i += 3) rows.push(row.slice(i, i + 3));
    });
  }
  return rows.length && rows.length <= 12 ? { inline_keyboard: rows } : null;
}

/** Send one text to the owner's chat. Returns { providerId, messageIds }. */
export async function send({ text, asks = [] }, { env = _deps.env } = {}) {
  const c = cfg(env);
  const markup = buttonsFor(asks);
  const r = await call('sendMessage', { chat_id: c.chat, text, link_preview_options: { is_disabled: true }, ...(markup ? { reply_markup: markup } : {}) }, { env });
  const id = `tg:${cfg(env).bot}:${r.message_id}`;
  return { providerId: id, messageIds: [id] };
}

/** Rewrite a sent message (answered, expired, cancelled): the buttons go. */
export async function edit(providerId, text, { env = _deps.env } = {}) {
  const m = /^tg:(?:(\d+):)?(\d+)$/.exec(String(providerId));
  if (!m || (m[1] && m[1] !== cfg(env).bot)) return;   // another bot's message: this one cannot edit it
  const id = Number(m[2]);
  await call('editMessageText', { chat_id: cfg(env).chat, message_id: id, text, link_preview_options: { is_disabled: true } }, { env });
}

export async function answerButton(callbackId, text, { env = _deps.env } = {}) {
  await call('answerCallbackQuery', { callback_query_id: callbackId, text: clip(text, 190) }, { env }).catch(() => {});
}

// ---------------------------------------------------------------- inbound
/**
 * An update as the router reads it: { channel, verified, reason, sender, text, providerMessageId, replyTo, button }.
 * Verified only when the sender and the private chat are the owner's id and the sender is no bot.
 */
export function readUpdate(update, { env = _deps.env } = {}) {
  const { chat: owner, bot } = cfg(env);
  const cq = update?.callback_query;
  if (cq) {
    const from = String(cq.from?.id ?? ''), chat = String(cq.message?.chat?.id ?? '');
    const verified = Boolean(owner) && from === owner && chat === owner && cq.from?.is_bot !== true;
    return { channel: NAME, verified, reason: verified ? null : 'not the owner\'s chat', sender: `tg:${from}`, text: String(cq.data ?? ''), providerMessageId: `tgcb:${bot}:${cq.id}`, replyTo: cq.message?.message_id ? `tg:${bot}:${cq.message.message_id}` : null, button: { id: cq.id, data: String(cq.data ?? '') } };
  }
  const m = update?.message ?? update?.edited_message;
  if (!m) return null;   // channel posts, member updates: nothing to read
  const from = String(m.from?.id ?? ''), chat = String(m.chat?.id ?? '');
  const verified = Boolean(owner) && from === owner && chat === owner && m.chat?.type === 'private' && m.from?.is_bot !== true;
  const text = typeof m.text === 'string' ? m.text : typeof m.caption === 'string' ? m.caption : '';
  // Telegram numbers messages per chat: the chat is part of the id, so another chat's message never shadows the owner's.
  // An edit keeps the id of the message it changes (original): the router reads it only as that message's follow-up.
  const id = `tg:${bot}:${chat}:${m.message_id}`;
  const edit = Boolean(update.edited_message);
  return { channel: NAME, verified, reason: verified ? null : 'not the owner\'s private chat', sender: `tg:${from}`, text, providerMessageId: edit ? `${id}:edit:${m.edit_date ?? ''}` : id, ...(edit ? { edit: true, original: id } : {}), replyTo: m.reply_to_message?.message_id ? `tg:${bot}:${m.reply_to_message.message_id}` : null, button: null };
}

// One secret per bot: a webhook is the bot account's own, and a replaced bot's stays registered with Telegram, posting
// the old bot's updates with the old secret. Those must never read as the new bot's (its ids would be stamped on them,
// and the two bots' message ids collide), so the new bot's secret is its own.
const secretFile = (env = _deps.env) => path.join(_deps.stateDir(), 'ask', `telegram-webhook-secret-${cfg(env).bot}`);

/** The webhook's secret header value for the configured bot: created once, kept 0600 in the state directory. */
export async function webhookSecret({ create = true, env = _deps.env } = {}) {
  const file = secretFile(env);
  try { const s = (await readFile(file, 'utf8')).trim(); if (/^[A-Za-z0-9_-]{32,256}$/.test(s)) return s; } catch { /* none yet */ }
  if (!create) return null;
  const s = randomBytes(32).toString('base64url');
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${s}\n`, { mode: 0o600 });
  await rename(tmp, file);
  return s;
}

/** Whether a webhook request carries the configured bot's secret (constant-time). */
export async function webhookAuthentic(headerValue, { env = _deps.env } = {}) {
  const want = await webhookSecret({ create: false, env });
  if (!want || typeof headerValue !== 'string') return false;
  const a = Buffer.from(headerValue), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Point the bot's webhook at the gateway (only when it points elsewhere). */
export async function ensureWebhook(url, { env = _deps.env } = {}) {
  const secret = await webhookSecret({ env });
  const info = await call('getWebhookInfo', {}, { env });
  // Set every start, even for the same URL: Telegram keeps the secret it was given, and a new state directory has a new one.
  await call('setWebhook', { url, secret_token: secret, allowed_updates: ['message', 'edited_message', 'callback_query'], max_connections: 4 }, { env });
  return { changed: info.url !== url, pending: info.pending_update_count ?? 0, lastError: info.last_error_message ?? null };
}

/**
 * Long polling, for a hub without a public endpoint: getUpdates in a loop (Telegram holds each call up to 50 s), the
 * offset kept on disk so a restart neither loses nor repeats an update. Returns stop().
 */
export function startPolling(onUpdate, { log = () => {}, env = _deps.env } = {}) {
  let stopped = false, ctl = null;
  // Update ids are the bot's too: a replaced bot starts its own count, so its offset is kept apart.
  const offsetFile = path.join(_deps.stateDir(), 'ask', `telegram-offset-${cfg(env).bot}`);
  const loop = async () => {
    let offset = 0;
    try { offset = Number((await readFile(offsetFile, 'utf8')).trim()) || 0; } catch { /* first run */ }
    try { await call('deleteWebhook', { drop_pending_updates: false }, { env }); } catch (e) { log('telegram deleteWebhook', e.message); }
    let backoff = 1000;
    while (!stopped) {
      try {
        ctl = new AbortController();
        const updates = await call('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'edited_message', 'callback_query'] }, { timeoutMs: 65_000, env, signal: ctl.signal });
        backoff = 1000;
        for (const u of updates ?? []) {
          offset = Math.max(offset, Number(u.update_id) + 1);
          try { await onUpdate(u); } catch (e) { log('telegram update', e.message); }
        }
        if (updates?.length) {
          await mkdir(path.dirname(offsetFile), { recursive: true, mode: 0o700 });
          await writeFile(offsetFile, `${offset}\n`, { mode: 0o600 });
        }
      } catch (e) {
        if (stopped) break;
        log('telegram getUpdates', e.message);
        await new Promise((r) => setTimeout(r, backoff).unref?.());
        backoff = Math.min(60_000, backoff * 2);
      }
    }
  };
  loop();
  return () => { stopped = true; ctl?.abort(); };
}

/** Health: the bot answers getMe and the owner's chat is reachable (getChat fails until the owner pressed Start). */
export async function health({ env = _deps.env } = {}) {
  const miss = missing(env);
  if (miss.length) return { ok: false, configured: false, missing: miss };
  try {
    const me = await call('getMe', {}, { env, timeoutMs: 10_000 });
    let chat = null;
    try { chat = await call('getChat', { chat_id: cfg(env).chat }, { env, timeoutMs: 10_000 }); } catch (e) { return { ok: false, configured: true, bot: me.username, error: `the owner's chat is not reachable: ${e.message} (open the bot and press Start)` }; }
    return { ok: true, configured: true, bot: me.username, chatType: chat?.type ?? null };
  } catch (e) { return { ok: false, configured: true, error: e.message }; }
}
