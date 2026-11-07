// Asks end to end on one machine that is its own hub: ask.create, the router's texts through fake Telegram and Twilio
// APIs, the owner's replies through the real bot gateway's webhooks (secret header, X-Twilio-Signature), and the
// answer arriving in a session's inbox through sessions.message, as it would in a Claude Code session. Every number,
// id and token here is made up.
import './isolate-cache.js';
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttp } from 'node:http';
import { createServer as createNet } from 'node:net';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmp = await mkdtemp(path.join(tmpdir(), 'drover-ask-'));
const OWNER_CHAT = '424242';
const SID = 'AC' + 'f'.repeat(32);
const FROM = '+15005550006', OWNER_PHONE = '+15005550123';
Object.assign(process.env, {
  DROVER_STATE: path.join(tmp, 'state'), DROVER_DOTFILES: path.join(tmp, 'dotfiles'), DROVER_EVENTS: path.join(tmp, 'events.jsonl'),
  DROVER_PLUGINS: '', CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'), CODEX_HOME: path.join(tmp, 'codex'), DROVER_PAIR_NOTIFY: 'off',
  DROVER_HOST: 'hub', DROVER_ASK_HUB: 'hub', DROVER_ASK_QUIET: 'off', DROVER_ASK_RATE: '120', DROVER_WORK_CONTEXT: 'none', DROVER_OWNER: 'owner', DROVER_OWNER_NAME: 'Owner',
  DROVER_ASK_TELEGRAM_TOKEN: '999:fake-token', DROVER_ASK_TELEGRAM_CHAT: OWNER_CHAT,
  DROVER_ASK_TWILIO_ACCOUNT_SID: SID, DROVER_ASK_TWILIO_AUTH_TOKEN: 'fake-auth-token', DROVER_ASK_SMS_FROM: FROM, DROVER_ASK_SMS_TO: OWNER_PHONE,
  DROVER_ASK_CHANNELS: 'telegram,sms', DROVER_FLEET_CATALOG: path.join(tmp, 'no-catalog.json'),
});
delete process.env.DF_IDENTITY;
await mkdir(path.join(tmp, 'claude', 'sessions'), { recursive: true });
await writeFile(process.env.DROVER_EVENTS, '');
const bin = path.join(tmp, 'bin');
await mkdir(bin, { recursive: true });
await writeFile(path.join(bin, 'claude'), '#!/bin/sh\necho "[]"\n');
await writeFile(path.join(bin, 'codex'), '#!/bin/sh\nexit 1\n');
for (const b of ['claude', 'codex']) await chmod(path.join(bin, b), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;

// ---------------------------------------------------------------- fake providers
const tg = { calls: [], next: 100 };
const tw = { sends: [], log: [], queries: [] };   // log: the account's message log, newest first
function fakeTelegram(req, res) {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url);
    const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (!m || m[1] !== '999:fake-token') return send({ ok: false, error_code: 401, description: 'Unauthorized' });
    const args = body ? JSON.parse(body) : {};
    tg.calls.push({ method: m[2], args });
    if (m[2] === 'sendMessage') return send({ ok: true, result: { message_id: tg.next++, chat: { id: Number(OWNER_CHAT) } } });
    if (m[2] === 'getMe') return send({ ok: true, result: { id: 999, is_bot: true, username: 'test_drover_bot' } });
    if (m[2] === 'getChat') return send(args.chat_id === OWNER_CHAT ? { ok: true, result: { id: Number(OWNER_CHAT), type: 'private' } } : { ok: false, description: 'Bad Request: chat not found' });
    if (m[2] === 'getWebhookInfo') return send({ ok: true, result: { url: '', pending_update_count: 0 } });
    return send({ ok: true, result: true });
  });
}
function fakeTwilio(req, res) {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const json = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.headers.authorization !== `Basic ${Buffer.from(`${SID}:fake-auth-token`).toString('base64')}`) return json(401, { code: 20003, message: 'Authenticate' });
    if (req.method === 'POST' && req.url === `/2010-04-01/Accounts/${SID}/Messages.json`) {
      if (tw.optedOut) return json(400, { code: 21610, message: 'Attempt to send to unsubscribed recipient' });
      const f = Object.fromEntries(new URLSearchParams(body)); tw.sends.push(f); return json(201, { sid: `SM${String(tw.sends.length).padStart(32, '0')}` });
    }
    if (req.method === 'GET' && req.url.startsWith(`/2010-04-01/Accounts/${SID}/Messages.json?`)) {
      const q = new URL(req.url, 'http://x').searchParams; tw.queries.push(q);
      return json(200, { messages: tw.log.filter((m) => m.from === q.get('From') && m.to === q.get('To')).slice(0, Number(q.get('PageSize') ?? 50)) });
    }
    if (req.method === 'GET' && req.url.startsWith(`/2010-04-01/Accounts/${SID}/IncomingPhoneNumbers.json`)) return json(200, { incoming_phone_numbers: [{ phone_number: FROM, capabilities: { sms: true }, sms_url: null }] });
    return json(404, { message: 'not found' });
  });
}
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const tgSrv = createHttp(fakeTelegram), twSrv = createHttp(fakeTwilio);
process.env.DROVER_ASK_TELEGRAM_API = `http://127.0.0.1:${await listen(tgSrv)}`;
process.env.DROVER_ASK_TWILIO_API = `http://127.0.0.1:${await listen(twSrv)}`;

// ---------------------------------------------------------------- the session that asks
const SESSION = 'a5c0ffee-0000-4000-8000-000000000001';
const inbox = [];
const froms = [];   // who each message says it is from (Claude Code's cross-session frame)
const sock = path.join(tmp, 'asker.sock');
const inboxSrv = createNet((c) => { let buf = ''; c.setEncoding('utf8'); c.on('data', (d) => { buf += d; }); c.on('end', () => { for (const l of buf.split('\n').filter(Boolean)) { const f = JSON.parse(l); if (f.type === 'user') { const t = typeof f.message.content === 'string' ? f.message.content : JSON.stringify(f.message.content); const m = /^<cross-session-message from-name="([^"]*)">\n([\s\S]*)\n<\/cross-session-message>$/.exec(t); inbox.push(m ? m[2] : t); froms.push(m ? m[1] : null); } } c.end(); }); });
await new Promise((r) => inboxSrv.listen(sock, r));
await writeFile(path.join(tmp, 'claude', 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: SESSION, cwd: tmp, name: 'asker', status: 'idle', kind: 'interactive', startedAt: Date.now() - 60_000, messagingSocketPath: sock }));

const { dispatch } = await import('../core/api.js');
const { router, _deps: routerDeps } = await import('../core/ask/router.js');
const sms = await import('../core/ask/channels/sms.js');
const { startBotGateway } = await import('../server/botgate.js');
const telegram = await import('../core/ask/channels/telegram.js');

let gw, base;
const allEvents = async () => (await readFile(process.env.DROVER_EVENTS, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const askEvents = async (phase) => (await allEvents()).filter((e) => e.type === 'ask' && (!phase || e.phase === phase));
const until = async (pred, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await pred()) return true; await new Promise((r) => setTimeout(r, 25)); } return false; };
const settle = async () => { await router.exclusive(() => {}); await new Promise((r) => setTimeout(r, 60)); };
const sentTexts = () => tg.calls.filter((c) => c.method === 'sendMessage');
const lastAskMessageId = () => tg.next - 1;
async function hook(route, body, headers = {}) {
  const res = await fetch(`${base}${route}`, { method: 'POST', headers, body });
  return { status: res.status, text: await res.text() };
}
const tgUpdate = (update, secret) => hook('/hooks/telegram', JSON.stringify(update), { 'content-type': 'application/json', ...(secret ? { 'x-telegram-bot-api-secret-token': secret } : {}) });
async function smsReply(fields, { sign = true, signer = 'fake-auth-token' } = {}) {
  const url = `${base}/hooks/twilio/sms`;
  const sig = sign ? sms.signature(signer, url, fields) : 'nope';
  return hook('/hooks/twilio/sms', new URLSearchParams(fields).toString(), { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sig });
}
const ask = (args) => dispatch('ask.create', { sessionId: SESSION, actor: 'test', ...args });
let secret;

before(async () => {
  gw = await startBotGateway({ base: 'http://127.0.0.1:1', port: 0, dispatch: (op, a) => dispatch(op, a) });
  const port = gw.server.address().port;
  base = `http://127.0.0.1:${port}`;
  gw.server.close(); await new Promise((r) => setTimeout(r, 20));
  // The gateway checks Twilio's signature against its public origin: start it again on the same port with that base.
  gw = await startBotGateway({ base, port, dispatch: (op, a) => dispatch(op, a) });
  process.env.DROVER_BOTS_URL = base;
  router.running = true;   // as in the daemon, minus the timer: the tests tick by hand
  secret = await telegram.webhookSecret();
});
after(async () => { router.running = false; for (const s of [gw.server, tgSrv, twSrv, inboxSrv]) s.close(); await rm(tmp, { recursive: true, force: true }); });
// Each test starts with no open asks: whatever an earlier test left open is withdrawn.
beforeEach(async () => { for (const a of (await dispatch('ask.list', {})).asks) await dispatch('ask.cancel', { askId: a.askId, actor: 'test' }); inbox.length = 0; froms.length = 0; });

describe('asking', () => {
  test('ask.create on the hub texts the question with buttons and returns its code', async () => {
    const r = await ask({ question: 'Ship the parser today?', options: ['yes', 'no'] });
    assert.equal(r.status, 'open'); assert.match(r.code, /^[A-HJ-NP-Z]\d$/); assert.equal(r.hub, 'hub');
    assert.match(r.note, /texted as .* on telegram/);
    const m = sentTexts().at(-1);
    assert.equal(m.args.chat_id, OWNER_CHAT);
    assert.match(m.args.text, new RegExp(`^Drover ask ${r.code} · asker on hub\\nShip the parser today\\?\\na\\) yes {2}b\\) no`));
    assert.deepEqual(m.args.reply_markup.inline_keyboard[0].map((b) => b.callback_data), [`ask:${r.code}:0:0`, `ask:${r.code}:0:1`]);
    const phases = (await askEvents()).filter((e) => e.askId === r.askId).map((e) => e.phase);
    assert.deepEqual(phases, ['created', 'routed', 'sent']);
  });
  test('the same question from the same session while it is open is the same ask', async () => {
    const a = await ask({ question: 'Same?', options: ['yes', 'no'] });
    const b = await ask({ question: 'Same?', options: ['yes', 'no'] });
    assert.equal(b.askId, a.askId); assert.equal(b.deduped, true);
  });
  test('the generic append refuses ask events: only a verified reply answers', async () => {
    await assert.rejects(dispatch('events.append', { event: { type: 'ask', phase: 'answered', askId: 'x', answers: [{ q: 0, option: 0, text: '' }], source: 'owner:telegram', untrusted: false } }), /refused: ask events/);
  });
  test('a question that looks like work is refused, as is a machine of the work identity', async () => {
    process.env.DROVER_WORK_CONTEXT = '\\bacme\\b';
    try { await assert.rejects(ask({ question: 'Deploy acme to prod?' }), /looks like work/); }
    finally { process.env.DROVER_WORK_CONTEXT = 'none'; }
  });
});

describe('answers by Telegram', () => {
  test('a tap on a button: verified, delivered to the session, the message rewritten, the tap acknowledged', async () => {
    const r = await ask({ question: 'Merge it?', options: ['merge', 'wait'] });
    const msgId = lastAskMessageId();
    const res = await tgUpdate({ update_id: 1, callback_query: { id: 'cb1', from: { id: Number(OWNER_CHAT), is_bot: false }, message: { message_id: msgId, chat: { id: Number(OWNER_CHAT), type: 'private' } }, data: `ask:${r.code}:0:1` } }, secret);
    assert.equal(res.status, 200);
    await settle();
    assert.equal(inbox.length, 1);
    assert.match(inbox[0], new RegExp(`^\\[Owner via telegram, verified\\] ${r.code} → b \\(wait\\)\\nQuestion: Merge it\\?`));
    assert.match(inbox[0], new RegExp(r.askId));
    assert.equal(froms.at(-1), 'drover (owner:telegram)');
    const got = await dispatch('ask.get', { askId: r.askId });
    assert.equal(got.status, 'answered'); assert.equal(got.answer.source, 'owner:telegram'); assert.equal(got.answer.verified, true); assert.equal(got.answer.providerMessageId, 'tgcb:cb1'); assert.equal(got.delivered, true);
    assert.ok(tg.calls.some((c) => c.method === 'answerCallbackQuery' && c.args.callback_query_id === 'cb1' && /→ b \(wait\): sent to asker on hub/.test(c.args.text)));
    assert.ok(tg.calls.some((c) => c.method === 'editMessageText' && c.args.message_id === msgId && /✓ Answered: b \(wait\)/.test(c.args.text)));
    // Telegram delivers a webhook again when it is slow to hear back: the same tap is one answer.
    await tgUpdate({ update_id: 1, callback_query: { id: 'cb1', from: { id: Number(OWNER_CHAT) }, message: { message_id: msgId, chat: { id: Number(OWNER_CHAT) } }, data: `ask:${r.code}:0:1` } }, secret);
    await settle();
    assert.equal(inbox.length, 1);
  });
  test('a typed reply with the code; a reply to the ask\'s message without one', async () => {
    const a = await ask({ question: 'Name for it?' });
    const b = await ask({ question: 'Which day?', options: ['monday', 'friday'] });
    const bMsg = lastAskMessageId();
    await tgUpdate({ update_id: 2, message: { message_id: 501, from: { id: Number(OWNER_CHAT) }, chat: { id: Number(OWNER_CHAT), type: 'private' }, text: `${a.code} call it Lantern` } }, secret);
    await tgUpdate({ update_id: 3, message: { message_id: 502, from: { id: Number(OWNER_CHAT) }, chat: { id: Number(OWNER_CHAT), type: 'private' }, text: 'friday', reply_to_message: { message_id: bMsg } } }, secret);
    await settle();
    assert.equal(inbox.length, 2);
    assert.match(inbox[0], new RegExp(`${a.code} → "call it Lantern"`));
    assert.match(inbox[1], new RegExp(`${b.code} → b \\(friday\\)`));
  });
  test('several questions in one ask, answered "1a 2b 3 yes"', async () => {
    const r = await ask({ questions: [{ question: 'Go?', options: ['go', 'stop'] }, { question: 'Where?', options: ['here', 'there'] }, { question: 'Notes?' }] });
    assert.match(sentTexts().at(-1).args.text, /1\) Go\? {2}a\) go {2}b\) stop\n2\) Where\? {2}a\) here {2}b\) there\n3\) Notes\?/);
    await tgUpdate({ update_id: 4, message: { message_id: 503, from: { id: Number(OWNER_CHAT) }, chat: { id: Number(OWNER_CHAT), type: 'private' }, text: '1a 2b 3 yes, ship' } }, secret);
    await settle();
    assert.match(inbox.at(-1), new RegExp(`${r.code} → 1: a \\(go\\) · 2: b \\(there\\) · 3: "yes, ship"`));
  });
  test('two asks open and a bare answer: asked which one, nothing delivered', async () => {
    const a = await ask({ question: 'One?', options: ['yes', 'no'] });
    const b = await ask({ question: 'Two?', options: ['yes', 'no'] });
    await tgUpdate({ update_id: 5, message: { message_id: 504, from: { id: Number(OWNER_CHAT) }, chat: { id: Number(OWNER_CHAT), type: 'private' }, text: 'yes' } }, secret);
    await settle();
    assert.equal(inbox.length, 0);
    assert.match(sentTexts().at(-1).args.text, new RegExp(`^Which ask\\? Open: ${a.code} \\(One\\?\\), ${b.code} \\(Two\\?\\)`));
  });
  test('another chat\'s message with the same number never shadows the owner\'s; a replayed command is not run twice', async () => {
    const r = await ask({ question: 'Shadowed?', options: ['yes', 'no'] });
    await tgUpdate({ update_id: 30, message: { message_id: 900, from: { id: 31337 }, chat: { id: 31337, type: 'private' }, text: 'hi' } }, secret);
    await tgUpdate({ update_id: 31, message: { message_id: 900, from: { id: Number(OWNER_CHAT) }, chat: { id: Number(OWNER_CHAT), type: 'private' }, text: `${r.code} a` } }, secret);
    await settle();
    assert.match(inbox.at(-1), new RegExp(`${r.code} → a \\(yes\\)`));
    await tgUpdate({ update_id: 32, message: { message_id: 901, from: { id: Number(OWNER_CHAT) }, chat: { id: Number(OWNER_CHAT), type: 'private' }, text: 'pause asks 1h' } }, secret);
    await settle();
    router.seen.clear();   // as after a restart
    await tgUpdate({ update_id: 32, message: { message_id: 901, from: { id: Number(OWNER_CHAT) }, chat: { id: Number(OWNER_CHAT), type: 'private' }, text: 'pause asks 1h' } }, secret);
    await settle();
    assert.equal((await askEvents('control')).filter((e) => e.providerMessageId === `tg:${OWNER_CHAT}:901`).length, 1);
    await tgUpdate({ update_id: 33, message: { message_id: 902, from: { id: Number(OWNER_CHAT) }, chat: { id: Number(OWNER_CHAT), type: 'private' }, text: 'resume' } }, secret);
    await settle();
  });
  test('anyone else is recorded as untrusted and never answers; a wrong secret is refused outright', async () => {
    const r = await ask({ question: 'Rotate the key?', options: ['yes', 'no'] });
    const before = sentTexts().length;
    await tgUpdate({ update_id: 6, message: { message_id: 505, from: { id: 31337 }, chat: { id: 31337, type: 'private' }, text: `${r.code} a` } }, secret);
    await tgUpdate({ update_id: 7, callback_query: { id: 'cb9', from: { id: 31337 }, message: { message_id: lastAskMessageId(), chat: { id: 31337 } }, data: `ask:${r.code}:0:0` } }, secret);
    await settle();
    assert.equal(inbox.length, 0);
    assert.equal(sentTexts().length, before, 'a stranger gets no reply');
    assert.equal((await dispatch('ask.get', { askId: r.askId })).status, 'open');
    const untrusted = (await askEvents('inbound')).filter((e) => e.untrusted);
    assert.deepEqual(untrusted.slice(-2).map((e) => e.sender), ['tg:31337', 'tg:31337']);
    const bad = await tgUpdate({ update_id: 8, message: { message_id: 506, from: { id: Number(OWNER_CHAT) }, chat: { id: Number(OWNER_CHAT), type: 'private' }, text: `${r.code} a` } }, 'wrong-secret-'.repeat(4));
    assert.equal(bad.status, 401);
    const none = await tgUpdate({ update_id: 9, message: { message_id: 507, from: { id: Number(OWNER_CHAT) }, chat: { id: Number(OWNER_CHAT), type: 'private' }, text: `${r.code} a` } });
    assert.equal(none.status, 401);
    await settle();
    assert.equal(inbox.length, 0);
  });
});

describe('answers by SMS', () => {
  test('an SMS ask goes out as ASCII from the 10DLC number; the owner\'s signed reply answers it', async () => {
    const r = await ask({ question: 'Spend $40 on the “launch” ad?', options: ['yes', 'no'], channels: ['sms'] });
    const s = tw.sends.at(-1);
    assert.equal(s.From, FROM); assert.equal(s.To, OWNER_PHONE);
    assert.equal(/[^\x09\x0a\x0d\x20-\x7e]/.test(s.Body), false, s.Body);
    assert.match(s.Body, new RegExp(`^Drover ask ${r.code} - asker on hub\\nSpend \\$40 on the "launch" ad\\?`));
    const res = await smsReply({ AccountSid: SID, From: OWNER_PHONE, To: FROM, Body: `${r.code.slice(1)}a`, MessageSid: 'SMreply1' });
    assert.equal(res.status, 200); assert.match(res.text, /<Response\/>/);
    await settle();
    assert.match(inbox.at(-1), new RegExp(`^\\[Owner via sms, verified\\] ${r.code} → a \\(yes\\)`));
    assert.equal((await dispatch('ask.get', { askId: r.askId })).answer.source, 'owner:sms');
    assert.match(tw.sends.at(-1).Body, new RegExp(`^${r.code} -> a \\(yes\\): sent to asker on hub`));
  });
  test('a reply with no words (an MMS photo, a reaction) is recorded and never answered or acknowledged', async () => {
    const r = await ask({ question: 'Words only?', options: ['yes', 'no'], channels: ['sms'] });
    const before = tw.sends.length;
    for (const [i, Body] of ['', 'Liked “Drover ask ' + r.code + '”', 'Reacted 👍 to “' + r.code + ' -> a (yes)”', 'Loved an image'].entries()) {
      await smsReply({ AccountSid: SID, From: OWNER_PHONE, To: FROM, Body, MessageSid: `MMnoise${i}`, NumMedia: Body ? '0' : '1' });
    }
    await settle();
    assert.equal(tw.sends.length, before, 'no acknowledgement');
    assert.equal((await dispatch('ask.get', { askId: r.askId })).status, 'open');
    assert.equal((await askEvents('inbound')).filter((e) => /no words/.test(e.reason ?? '')).length, 4);
    // A real answer after them still lands, and is recorded as delivered once.
    await smsReply({ AccountSid: SID, From: OWNER_PHONE, To: FROM, Body: 'yes', MessageSid: 'SMwords' });
    await settle();
    assert.match(inbox.at(-1), new RegExp(`${r.code} → a \\(yes\\)`));
    assert.equal((await askEvents('delivered')).filter((e) => e.providerMessageId === 'sms:SMwords').length, 1);
  });
  test('the signature is checked against the URL with and without its port, as Twilio signs either', async () => {
    const r = await ask({ question: 'Port?', options: ['yes', 'no'], channels: ['sms'] });
    const u = new URL(`${base}/hooks/twilio/sms`);
    const portless = `${u.protocol}//${u.hostname}${u.pathname}`;
    const fields = { AccountSid: SID, From: OWNER_PHONE, To: FROM, Body: `${r.code} b`, MessageSid: 'SMportless' };
    const res = await hook('/hooks/twilio/sms', new URLSearchParams(fields).toString(), { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sms.signature('fake-auth-token', portless, fields) });
    assert.equal(res.status, 200);
    await settle();
    assert.match(inbox.at(-1), new RegExp(`${r.code} → b \\(no\\)`));
    assert.deepEqual(sms.urlForms('https://h.example:10000/x?y=1'), ['https://h.example:10000/x?y=1', 'https://h.example/x?y=1']);
  });
  test('a bad signature is refused; another phone or another account is untrusted', async () => {
    const r = await ask({ question: 'Close the shop?', options: ['yes', 'no'], channels: ['sms'] });
    assert.equal((await smsReply({ AccountSid: SID, From: OWNER_PHONE, To: FROM, Body: `${r.code} a`, MessageSid: 'SMx' }, { signer: 'not-the-token' })).status, 403);
    assert.equal((await smsReply({ AccountSid: SID, From: OWNER_PHONE, To: FROM, Body: `${r.code} a`, MessageSid: 'SMy' }, { sign: false })).status, 403);
    await smsReply({ AccountSid: SID, From: '+15005550199', To: FROM, Body: `${r.code} a`, MessageSid: 'SMz' });
    await smsReply({ AccountSid: 'AC' + '0'.repeat(32), From: OWNER_PHONE, To: FROM, Body: `${r.code} a`, MessageSid: 'SMw' });
    await settle();
    assert.equal(inbox.length, 0);
    assert.equal((await dispatch('ask.get', { askId: r.askId })).status, 'open');
    const reasons = (await askEvents('inbound')).filter((e) => e.untrusted && e.channel === 'sms').map((e) => e.reason);
    assert.deepEqual(reasons.slice(-2), ['not the owner\'s phone', 'another Twilio account']);
  });
});

describe('SMS replies read from the account\'s log (poll, for a hub without a webhook)', () => {
  test('the first look is the baseline; the owner\'s new reply answers once; only the owner\'s messages are asked for', async () => {
    tw.log.unshift({ sid: 'SMold', direction: 'inbound', from: OWNER_PHONE, to: FROM, body: 'an old message', account_sid: SID });
    tw.log.unshift({ sid: 'SMstranger', direction: 'inbound', from: '+15005550177', to: FROM, body: 'hi', account_sid: SID });
    const stop = sms.startPolling((m) => router.inbound(m), { everyMs: 40 });
    try {
      assert.ok(await until(() => tw.queries.length >= 2), 'polling');
      const r = await ask({ question: 'Polled?', options: ['yes', 'no'], channels: ['sms'] });
      tw.log.unshift({ sid: 'SMnew1', direction: 'inbound', from: OWNER_PHONE, to: FROM, body: `${r.code} b`, account_sid: SID });
      tw.log.unshift({ sid: 'SMout1', direction: 'outbound-api', from: FROM, to: OWNER_PHONE, body: 'ours', account_sid: SID });
      assert.ok(await until(() => inbox.some((m) => m.includes(`${r.code} → b (no)`))), 'answered');
      await new Promise((res) => setTimeout(res, 200));
      assert.equal(inbox.filter((m) => m.includes(`${r.code} → b`)).length, 1, 'once');
      assert.equal(inbox.some((m) => m.includes('an old message')), false, 'the baseline is never replayed');
      assert.ok(tw.queries.every((q) => q.get('From') === OWNER_PHONE && q.get('To') === FROM));
    } finally { stop(); }
  });
});

describe('the owner\'s commands, quiet hours and the rate limit', () => {
  const say = (text, id) => tgUpdate({ update_id: id, message: { message_id: id, from: { id: Number(OWNER_CHAT) }, chat: { id: Number(OWNER_CHAT), type: 'private' }, text } }, secret);
  test('pause holds normal asks, urgent ones still go; resume sends the held ones in one text', async () => {
    await say('pause asks 2h', 601); await settle();
    assert.match(sentTexts().at(-1).args.text, /^Paused normal asks until/);
    const n1 = await ask({ question: 'Held one?' });
    const n2 = await ask({ question: 'Held two?' });
    assert.match(n1.note, /held: paused/);
    const before = sentTexts().length;
    const u = await ask({ question: 'The build is red, revert?', options: ['revert', 'leave'], urgency: 'urgent' });
    assert.equal(sentTexts().length, before + 1);
    assert.match(sentTexts().at(-1).args.text, new RegExp(`^Drover ask ${u.code} · asker on hub \\(urgent\\)`));
    await say('resume', 602); await settle();
    await router.tick();
    const batch = sentTexts().find((m) => m.args.text.startsWith('Drover: 2 asks'));
    assert.ok(batch, sentTexts().map((m) => m.args.text.split('\n')[0]).join(' | '));
    assert.match(batch.args.text, new RegExp(`${n1.code} · asker on hub: Held one\\?\\n${n2.code} · asker on hub: Held two\\?`));
  });
  test('stop holds everything, urgent too, and later replies get no texts until resume', async () => {
    await say('STOP', 603); await settle();
    assert.match(sentTexts().at(-1).args.text, /^Stopped: no texts until you reply resume/);
    const before = sentTexts().length;
    const u = await ask({ question: 'Urgent but stopped?', urgency: 'urgent' });
    assert.match(u.note, /held: stopped/);
    await router.tick();
    assert.equal(sentTexts().length, before);
    await say('resume', 604); await settle(); await router.tick();
    assert.ok(sentTexts().slice(before).some((m) => m.args.text.includes('Urgent but stopped?')));
  });
  test('quiet hours hold a normal ask until they end', async () => {
    const now = new Date();
    const hh = (d) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
    process.env.DROVER_ASK_TZ = 'UTC';
    process.env.DROVER_ASK_QUIET = `${hh(new Date(now - 3_600_000))}-${hh(new Date(+now + 3_600_000))}`;
    try {
      const r = await ask({ question: 'At night?' });
      assert.match(r.note, /held: quiet hours/);
      const u = await ask({ question: 'At night, urgent?', urgency: 'urgent' });
      assert.match(u.note, /texted as/);
    } finally { process.env.DROVER_ASK_QUIET = 'off'; delete process.env.DROVER_ASK_TZ; }
  });
  test('past the rate limit asks wait, then go out together', async () => {
    process.env.DROVER_ASK_RATE = '1';
    const realNow = routerDeps.now;
    try {
      const r = await ask({ question: 'Over the limit?' });
      assert.match(r.note, /held: rate limit/);
      routerDeps.now = () => Date.now() + 3_600_000;   // an hour on
      const t = await router.tick();
      assert.deepEqual(t.sent.map((s) => s.codes).flat(), [r.code]);
    } finally { process.env.DROVER_ASK_RATE = '120'; routerDeps.now = realNow; }
  });
  test('status lists the open asks', async () => {
    const r = await ask({ question: 'Listed?' });
    await say('status', 605); await settle();
    assert.match(sentTexts().at(-1).args.text, new RegExp(`1 open: ${r.code} asker on hub: Listed\\?`));
  });
});

describe('limits: one text per send counted, batches split to fit, one ask fits one text', () => {
  const say = (text, id) => tgUpdate({ update_id: id, message: { message_id: id, from: { id: Number(OWNER_CHAT) }, chat: { id: Number(OWNER_CHAT), type: 'private' }, text } }, secret);
  test('an ask too long for one SMS is refused at once', async () => {
    await assert.rejects(ask({ questions: [{ question: 'x'.repeat(600) }, { question: 'y'.repeat(600) }, { question: 'z'.repeat(100) }] }), /too long for one text message/);
  });
  test('held asks released together split into texts within the SMS limit, each counted against the rate', async () => {
    await say('pause asks 1h', 701); await settle();
    const made = [];
    for (let i = 0; i < 4; i++) made.push(await ask({ question: `${'Long question '.repeat(30)}${i}?`, channels: ['sms'] }));
    const before = tw.sends.length;
    await say('resume', 702); await settle(); await router.tick();
    const out = tw.sends.slice(before).filter((m) => m.Body.startsWith('Drover'));
    assert.ok(out.length >= 2, `split into ${out.length}`);
    assert.ok(out.every((m) => m.Body.length <= 1600), out.map((m) => m.Body.length).join(','));
    for (const a of made) { const code = (await dispatch('ask.get', { askId: a.askId })).code; assert.ok(out.some((m) => m.Body.includes(`${code} - `)), `${code} went out`); }
  });
  test('two texts due in one tick and one left under the limit: one goes, one waits', async () => {
    await say('pause asks 1h', 703); await settle();
    const a = await ask({ question: 'Rate one?', channels: ['telegram'] });
    const b = await ask({ question: 'Rate two?', channels: ['sms'] });
    const { rateState } = await import('../core/ask/policy.js');
    const st = await router.state();
    process.env.DROVER_ASK_RATE = String(rateState(st.sends, Date.now(), { ratePerHour: 1e9 }).used + 1);
    try {
      await say('resume', 704); await settle();
      await new Promise((r) => setTimeout(r, 60)); await router.exclusive(() => {});   // resume runs its own tick
      await router.tick();
      const texted = await Promise.all([a, b].map(async (x) => (await dispatch('ask.get', { askId: x.askId })).texted.length));
      assert.deepEqual(texted.sort(), [0, 1], 'one went, one waits for the rate limit');
    } finally { process.env.DROVER_ASK_RATE = '120'; }
  });
});

describe('the owner\'s carrier opt-out on SMS', () => {
  test('STOP by SMS: no reply of ours (Twilio confirms it); a 21610 takes SMS out of rotation; START brings it back', async () => {
    const before = tw.sends.length;
    await smsReply({ AccountSid: SID, From: OWNER_PHONE, To: FROM, Body: 'STOP', MessageSid: 'SMstop1' });
    await settle();
    assert.equal(tw.sends.length, before, 'Twilio answers a STOP itself');
    assert.match(router.disabled.get('sms'), /texted STOP/);
    await smsReply({ AccountSid: SID, From: OWNER_PHONE, To: FROM, Body: 'START', MessageSid: 'SMstart1' });
    await settle();
    assert.equal(router.disabled.has('sms'), false);
    assert.match(tw.sends.at(-1).Body, /^Resumed/);
    // Later Twilio refuses again (an opt-out we did not see): the send fails with 21610, SMS goes out of rotation, the
    // ask falls over to Telegram.
    tw.optedOut = true;
    const r = await ask({ question: 'Opted out?', channels: ['sms', 'telegram'] });
    assert.match(r.note, /texted as .* on telegram/);
    assert.match(router.disabled.get('sms'), /START/);
    tw.optedOut = false; router.disabled.delete('sms');
  });
});

describe('expiry and withdrawal', () => {
  test('an ask nobody answers expires: its message says so and the session hears it', async () => {
    const r = await ask({ question: 'Will anyone answer?', options: ['yes', 'no'], ttlMinutes: 2 });
    const realNow = routerDeps.now;
    routerDeps.now = () => Date.now() + 3 * 60_000;
    try { const t = await router.tick(); assert.deepEqual(t.expired, [r.code]); }
    finally { routerDeps.now = realNow; }
    await settle();
    assert.equal((await dispatch('ask.get', { askId: r.askId })).status, 'expired');
    assert.match(inbox.at(-1), new RegExp(`^\\[Drover ask ${r.code}\\] expired without an answer`));
    assert.ok(tg.calls.some((c) => c.method === 'editMessageText' && /Expired: no answer in time\./.test(c.args.text)));
  });
  test('withdrawn: the message says so; a late answer is passed on as a follow-up, never reopening it', async () => {
    const r = await ask({ question: 'Still needed?', options: ['yes', 'no'] });
    const msgId = lastAskMessageId();
    assert.deepEqual(await dispatch('ask.cancel', { askId: r.askId, actor: 'test' }), { ok: true, askId: r.askId, status: 'cancelled' });
    await settle();
    assert.ok(tg.calls.some((c) => c.method === 'editMessageText' && c.args.message_id === msgId && /Withdrawn by the asker\./.test(c.args.text)));
    await tgUpdate({ update_id: 10, message: { message_id: 508, from: { id: Number(OWNER_CHAT) }, chat: { id: Number(OWNER_CHAT), type: 'private' }, text: `${r.code} a` } }, secret);
    await settle();
    assert.match(inbox.at(-1), new RegExp(`^\\[Owner via telegram, verified, follow-up\\] ${r.code} → a \\(yes\\)`));
    assert.equal((await dispatch('ask.get', { askId: r.askId })).status, 'cancelled');
  });
});

describe('asks from another host', () => {
  test('the hub pulls a host\'s open asks, texts them, and hands the answer back with ask.deliver there', async () => {
    const remote = { askId: '0199-remote-1', status: 'open', origin: 'box-b-self', sessionId: 'remote-session', sessionName: 'worker', questions: [{ question: 'Use the 806 number?', options: ['yes', 'no'] }], urgency: 'normal', expiresAt: new Date(Date.now() + 3_600_000).toISOString(), createdAt: new Date().toISOString() };
    const calls = [];
    const realHosts = routerDeps.askHosts, realCall = routerDeps.call;
    routerDeps.askHosts = async () => ['box-b'];
    routerDeps.call = async (host, op, args, opts) => {
      if (host !== 'box-b') return realCall(host, op, args, opts);
      calls.push({ op, args });
      if (op === 'ask.list') return { host: 'box-b-self', asks: calls.some((c) => c.op === 'ask.deliver') ? [] : [remote] };
      if (op === 'ask.deliver') return { ok: true };
      return { ok: true };
    };
    try {
      const t = await router.tick();
      assert.equal(t.taken.length, 1);
      const code = t.taken[0];
      assert.ok(calls.some((c) => c.op === 'ask.mark' && c.args.phase === 'routed' && c.args.code === code));
      // Named as the hub reaches it (its alias), which the owner knows, not the name the host gives itself.
      assert.match(sentTexts().at(-1).args.text, new RegExp(`^Drover ask ${code} · worker on box-b\\nUse the 806 number\\?`));
      await tgUpdate({ update_id: 11, message: { message_id: 509, from: { id: Number(OWNER_CHAT) }, chat: { id: Number(OWNER_CHAT), type: 'private' }, text: `${code} yes` } }, secret);
      await settle();
      const d = calls.find((c) => c.op === 'ask.deliver');
      assert.ok(d, 'delivered to the asking host');
      assert.deepEqual(d.args.answers, [{ q: 0, option: 0, text: '' }]);
      assert.equal(d.args.source, 'owner:telegram'); assert.equal(d.args.hub, 'hub');
      assert.equal(inbox.length, 0, 'not delivered here');
      // A second tick does not take it again.
      assert.deepEqual((await router.tick()).taken, []);
    } finally { routerDeps.askHosts = realHosts; routerDeps.call = realCall; }
  });
  test('an expiry notice the asking host could not take is retried until it lands', async () => {
    const remote = { askId: '0199-remote-exp', status: 'open', origin: 'box-d', sessionId: 'rs3', sessionName: 'w3', questions: [{ question: 'Expire me?', options: [] }], urgency: 'normal', expiresAt: new Date(Date.now() + 120_000).toISOString(), createdAt: new Date().toISOString() };
    let up = false; const marks = [];
    const realHosts = routerDeps.askHosts, realCall = routerDeps.call, realNow = routerDeps.now;
    routerDeps.askHosts = async () => ['box-d'];
    routerDeps.call = async (host, op, args, opts) => {
      if (host !== 'box-d') return realCall(host, op, args, opts);
      if (op === 'ask.list') return { asks: marks.length ? [] : [remote] };
      if (op === 'ask.mark' && args.phase === 'expired') { if (!up) throw new Error('ssh: connect to host box-d: Connection refused'); marks.push(args); return { ok: true }; }
      return { ok: true };
    };
    try {
      await router.tick();
      routerDeps.now = () => Date.now() + 3 * 60_000;
      assert.equal((await router.tick()).expired.length, 1);
      up = true;
      routerDeps.now = () => Date.now() + 6 * 60_000;
      await router.tick();
      assert.equal(marks.length, 1, 'retried once the host answered');
      routerDeps.now = () => Date.now() + 60 * 60_000;
      await router.tick();
      assert.equal(marks.length, 1, 'and only once');
    } finally { routerDeps.askHosts = realHosts; routerDeps.call = realCall; routerDeps.now = realNow; }
  });
  test('a host that cannot be reached keeps the answer; the next ticks retry the delivery', async () => {
    const remote = { askId: '0199-remote-2', status: 'open', origin: 'box-c', sessionId: 'rs2', sessionName: 'w2', questions: [{ question: 'Retry me?', options: ['yes', 'no'] }], urgency: 'normal', createdAt: new Date().toISOString() };
    let up = false;
    const delivered = [];
    const realHosts = routerDeps.askHosts, realCall = routerDeps.call, realNow = routerDeps.now;
    routerDeps.askHosts = async () => ['box-c'];
    routerDeps.call = async (host, op, args, opts) => {
      if (host !== 'box-c') return realCall(host, op, args, opts);
      if (op === 'ask.list') return { asks: [remote] };
      if (op === 'ask.deliver') { if (!up) throw new Error('ssh: connect to host box-c: Connection refused'); delivered.push(args); return { ok: true }; }
      return { ok: true };
    };
    try {
      const code = (await router.tick()).taken[0];
      await tgUpdate({ update_id: 12, message: { message_id: 510, from: { id: Number(OWNER_CHAT) }, chat: { id: Number(OWNER_CHAT), type: 'private' }, text: `${code} b` } }, secret);
      await settle();
      assert.match(sentTexts().at(-1).args.text, new RegExp(`${code} → b \\(no\\): recorded; w2 on box-c is out of reach, retrying`));
      up = true;
      assert.deepEqual((await router.tick()).delivered, [], 'not before the backoff');
      routerDeps.now = () => Date.now() + 3 * 60_000;
      assert.deepEqual((await router.tick()).delivered, [`${code}:ok`]);
      assert.equal(delivered.length, 1);
      routerDeps.now = () => Date.now() + 60 * 60_000;
      assert.deepEqual((await router.tick()).delivered, [], 'delivered once');
    } finally { routerDeps.askHosts = realHosts; routerDeps.call = realCall; routerDeps.now = realNow; }
  });
});

describe('the asking host\'s side', () => {
  test('ask.deliver records the relayed answer once and delivers it once', async () => {
    const r = await dispatch('ask.create', { question: 'Delivered once?', options: ['yes', 'no'], sessionId: SESSION, actor: 'test', channels: ['sms'] });
    const args = { askId: r.askId, code: r.code, answers: [{ q: 0, option: 0, text: '' }], source: 'owner:sms', channel: 'sms', providerMessageId: 'sms:SMdup', sender: `sms:${OWNER_PHONE}`, raw: 'a', hub: 'elsewhere' };
    const { local } = await import('../core/api.js');
    assert.equal((await local['ask.deliver'](args)).ok, true);
    assert.equal((await local['ask.deliver'](args)).deduped, true);
    await settle();
    assert.equal(inbox.filter((m) => m.includes('Delivered once?')).length, 1);
    assert.equal((await askEvents('answered')).filter((e) => e.providerMessageId === 'sms:SMdup').length, 1);
  });
  test('over rpc, the hub-only ops are served only for an ssh session from the hub machine', async () => {
    const askOps = await import('../core/ask/ops.js');
    const { local } = await import('../core/api.js');
    const r = await dispatch('ask.create', { question: 'Planted?', options: ['yes', 'no'], sessionId: SESSION, actor: 'test', channels: ['sms'] });
    const forged = { askId: r.askId, answers: [{ q: 0, option: 0, text: '' }], source: 'owner:telegram', channel: 'telegram', providerMessageId: 'tg:forged', sender: 'tg:1', raw: 'a', hub: 'hub' };
    process.env.DROVER_ASK_HUB_ADDRS = '10.9.8.7';
    try {
      const bySshd = [{ comm: 'node' }, { comm: 'sshd-session' }];
      for (const [ssh, chain] of [[undefined, bySshd], ['127.0.0.1 40000 127.0.0.1 22', bySshd], ['100.64.0.9 40000 100.64.0.2 22', bySshd], ['10.9.8.7 40000 100.64.0.2 22', [{ comm: 'node' }, { comm: 'zsh' }, { comm: 'tmux: server' }]], ['10.9.8.7 40000 100.64.0.2 22', [{ comm: 'node' }, { comm: 'zsh' }, { comm: 'claude' }, { comm: 'sshd' }]]]) {
        askOps._resetRpc(); await askOps.serveRpc({ sshConnection: ssh, ancestors: chain });
        await assert.rejects(local['ask.deliver'](forged), /refused: ask.deliver is served over ssh from the ask hub only/, String(ssh));
        await assert.rejects(local['ask.mark']({ askId: r.askId, phase: 'expired' }), /refused: ask.mark/);
      }
      assert.equal((await dispatch('ask.get', { askId: r.askId })).status, 'open', 'nothing planted');
      askOps._resetRpc(); await askOps.serveRpc({ sshConnection: '10.9.8.7 40000 100.64.0.2 22', ancestors: [{ comm: 'node' }, { comm: 'zsh' }, { comm: 'sshd' }] });
      assert.equal((await local['ask.deliver']({ ...forged, providerMessageId: 'tg:real', source: 'owner:sms', channel: 'sms' })).ok, true);
      assert.equal((await askEvents('answered')).find((e) => e.providerMessageId === 'tg:real').relayFrom, '10.9.8.7');
      // The real rpc process wires it from SSH_CONNECTION: a local pipe into `drover rpc` is refused.
      const { spawn } = await import('node:child_process');
      const rpcCall = (env) => new Promise((resolve) => {
        const c = spawn(process.execPath, [path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'drover'), 'rpc'], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'ignore'] });
        let out = '';
        c.stdout.on('data', (d) => { out += d; if (out.includes('\n')) { c.stdin.end(); resolve(JSON.parse(out.split('\n')[0])); } });
        c.stdin.write(JSON.stringify({ id: 1, op: 'ask.deliver', args: { ...forged, providerMessageId: 'tg:pipe' } }) + '\n');
      });
      const piped = await rpcCall({ SSH_CONNECTION: '' });
      assert.equal(piped.ok, false); assert.match(piped.error, /served over ssh from the ask hub only/);
      // The hub's address in SSH_CONNECTION is not enough: a local process can set it, but cannot be started by sshd.
      const spoofed = await rpcCall({ SSH_CONNECTION: '10.9.8.7 40000 100.64.0.2 22' });
      assert.equal(spoofed.ok, false); assert.match(spoofed.error, /was not started by sshd/);
    } finally { askOps._resetRpc(); delete process.env.DROVER_ASK_HUB_ADDRS; }
  });
  test('the hub-only ops are refused through the HTTP API and drover op, served over rpc', async () => {
    const { cliOp } = await import('../core/cli-op.js');
    await assert.rejects(cliOp('ask.deliver', {}), /refused: ask.deliver is the ask hub's own call/);
    await assert.rejects(cliOp('ask.mark', {}), /refused/);
  });
  test('ask.status names what each channel lacks, never a value', async () => {
    const c = await dispatch('ask.create', { question: 'Channels kept?', sessionId: SESSION, actor: 'test', channels: ['sms'] });
    assert.deepEqual((await dispatch('ask.list', {})).asks.find((a) => a.askId === c.askId).channels, ['sms'], 'the hub\'s pull keeps them');
    await telegram.ensureWebhook(`${base}/hooks/telegram`);
    assert.ok(tg.calls.some((x) => x.method === 'setWebhook' && x.args.secret_token === secret), 'the secret is set every start');
    const s = await dispatch('ask.status', { probe: true });
    assert.equal(s.isHub, true); assert.deepEqual(s.order, ['telegram', 'sms']);
    assert.equal(s.channels.telegram.configured, true); assert.equal(s.channels.telegram.health.ok, true); assert.equal(s.channels.telegram.health.bot, 'test_drover_bot');
    assert.equal(s.channels.sms.health.ok, true);
    assert.equal(JSON.stringify(s).includes('fake-auth-token') || JSON.stringify(s).includes('999:fake-token'), false);
    // The test gateway's origin is http on a random port, not one Telegram calls: Telegram long-polls; SMS takes the webhook.
    assert.equal(s.inbound.telegram, 'long poll'); assert.equal(s.inbound.sms, `webhook ${base}/hooks/twilio/sms`);
    assert.equal(telegram.inboundMode({ publicBase: 'https://box.example.ts.net:10000', env: {} }), 'poll');
    assert.equal(telegram.inboundMode({ publicBase: 'https://box.example.ts.net', env: {} }), 'webhook');
    assert.equal(telegram.inboundMode({ publicBase: 'https://box.example.ts.net:8443', env: {} }), 'webhook');
    assert.equal(telegram.inboundMode({ publicBase: 'https://box.example.ts.net:10000', env: { DROVER_ASK_TELEGRAM_INBOUND: 'webhook' } }), 'webhook');
  });
});
