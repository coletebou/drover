// The ask webhooks on the bot gateway's public listener (server/botgate.js), served only on the ask hub
// (core/ask/ops.js isHub), with that channel configured and set to take its replies by webhook; anywhere else, and
// when the hub polls that channel instead, they are 404 like any unknown path. A hook nobody is meant to call is only
// a way in: Twilio signs with the account's auth token, which any holder can use to sign a forged reply.
//
//   POST /hooks/telegram     Telegram's update, believed only with the secret header given at setWebhook
//   POST /hooks/twilio/sms   Twilio's inbound SMS, believed only with a valid X-Twilio-Signature for this URL
//
// Both answer at once (a provider retries a slow webhook) and hand the reply to the router, which decides whether it
// is the owner's (the sender) and what it answers. A request that fails its provider's check is refused and recorded
// nowhere: it is not even a reply.
import * as telegram from '../core/ask/channels/telegram.js';
import * as sms from '../core/ask/channels/sms.js';
import { router } from '../core/ask/router.js';
import { isHub } from '../core/ask/ops.js';

const TELEGRAM_LIMIT = 256 * 1024;
const SMS_LIMIT = 32 * 1024;
export const HOOK_ROUTES = new Set(['/hooks/telegram', '/hooks/twilio/sms']);

/** Form fields, a repeated key kept as a list (Twilio signs every value). */
function formFields(raw) {
  const out = {};
  for (const [k, v] of new URLSearchParams(raw)) out[k] = Object.hasOwn(out, k) ? [].concat(out[k], v) : v;
  return out;
}

/** Serve one hook request. helpers: { base, readRaw, json, tooLarge, log }. */
export async function serveHook(route, req, res, { base, readRaw, json, tooLarge, log = () => {} }) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' }, { allow: 'POST' });
  if (route === '/hooks/telegram') {
    if (!isHub() || !telegram.configured() || telegram.inboundMode({ publicBase: base }) !== 'webhook') return json(res, 404, { error: 'not found' });
    if (!(await telegram.webhookAuthentic(req.headers['x-telegram-bot-api-secret-token']))) return json(res, 401, { error: 'unauthorized' });
    let update;
    try { update = JSON.parse(await readRaw(req, TELEGRAM_LIMIT)); }
    catch (e) { return e.status === 413 ? tooLarge(res) : json(res, 400, { error: 'bad json' }); }
    json(res, 200, {});
    const msg = telegram.readUpdate(update);
    if (msg) router.inbound(msg).catch((e) => log('telegram inbound', e.message));
    return undefined;
  }
  if (route === '/hooks/twilio/sms') {
    if (!isHub() || !sms.configured() || sms.inboundMode({ publicBase: base }) !== 'webhook') return json(res, 404, { error: 'not found' });
    let raw;
    try { raw = await readRaw(req, SMS_LIMIT); } catch (e) { return e.status === 413 ? tooLarge(res) : json(res, 400, { error: 'bad body' }); }
    const fields = formFields(raw);
    // The URL Twilio signed is the public one it was given: this origin and the path with its query.
    if (!sms.authentic(`${base}${req.url}`, fields, req.headers['x-twilio-signature'])) { log('twilio hook: bad signature'); return json(res, 403, { error: 'bad signature' }); }
    const body = '<?xml version="1.0" encoding="UTF-8"?><Response/>';
    res.writeHead(200, { 'content-type': 'text/xml', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
    res.end(body);
    const flat = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, Array.isArray(v) ? v.at(-1) : v]));
    router.inbound(sms.readInbound(flat)).catch((e) => log('sms inbound', e.message));
    return undefined;
  }
  return json(res, 404, { error: 'not found' });
}
