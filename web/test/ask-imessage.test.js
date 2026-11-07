// The iMessage channel (core/ask/channels/imessage.js) against a fake imsg that speaks its JSON-RPC (test/fake-imsg.js):
// the watch, the AppleScript-pinned send, who counts as the owner (not this account, the owner's handle, the
// one-to-one chat), the cursor that survives a restart, and the health check that refuses a self-chat.
import './isolate-cache.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createNet } from 'node:net';
import { mkdtemp, mkdir, writeFile, readFile, chmod, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tmp = await mkdtemp(path.join(tmpdir(), 'drover-ask-imsg-'));
const OWNER = '+15005550123';
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-imsg.js');
await chmod(FAKE, 0o755);
Object.assign(process.env, {
  DROVER_STATE: path.join(tmp, 'state'), DROVER_DOTFILES: path.join(tmp, 'dotfiles'), DROVER_EVENTS: path.join(tmp, 'events.jsonl'),
  DROVER_PLUGINS: '', CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'), CODEX_HOME: path.join(tmp, 'codex'),
  DROVER_HOST: 'mini', DROVER_ASK_HUB: 'mini', DROVER_ASK_QUIET: 'off', DROVER_ASK_CHANNELS: 'imessage', DROVER_WORK_CONTEXT: 'none', DROVER_OWNER: 'owner', DROVER_OWNER_NAME: 'Owner',
  DROVER_ASK_IMSG: FAKE, DROVER_ASK_IMESSAGE_TO: '+1 (500) 555-0123', FAKE_IMSG_LOG: path.join(tmp, 'imsg.log'), FAKE_IMSG_INBOX: path.join(tmp, 'imsg.inbox'),
  DROVER_FLEET_CATALOG: path.join(tmp, 'no-catalog.json'),
});
for (const k of ['DROVER_ASK_TELEGRAM_TOKEN', 'DROVER_ASK_TWILIO_AUTH_TOKEN', 'DF_IDENTITY']) delete process.env[k];
await mkdir(path.join(tmp, 'claude', 'sessions'), { recursive: true });
await writeFile(process.env.DROVER_EVENTS, '');
const bin = path.join(tmp, 'bin');
await mkdir(bin, { recursive: true });
await writeFile(path.join(bin, 'claude'), '#!/bin/sh\necho "[]"\n');
await writeFile(path.join(bin, 'codex'), '#!/bin/sh\nexit 1\n');
for (const b of ['claude', 'codex']) await chmod(path.join(bin, b), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;

const SESSION = 'a5c0ffee-0000-4000-8000-0000000000aa';
const inbox = [];
const sock = path.join(tmp, 'asker.sock');
const inboxSrv = createNet((c) => { let buf = ''; c.setEncoding('utf8'); c.on('data', (d) => { buf += d; }); c.on('end', () => { for (const l of buf.split('\n').filter(Boolean)) { const f = JSON.parse(l); if (f.type === 'user') inbox.push(String(f.message.content)); } c.end(); }); });
await new Promise((r) => inboxSrv.listen(sock, r));
await writeFile(path.join(tmp, 'claude', 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: SESSION, cwd: tmp, name: 'asker', status: 'idle', kind: 'interactive', startedAt: Date.now() - 60_000, messagingSocketPath: sock }));

const imessage = await import('../core/ask/channels/imessage.js');
imessage._deps.platform = () => 'darwin';
const { dispatch } = await import('../core/api.js');
const { router } = await import('../core/ask/router.js');

const lines = async (f) => { try { return (await readFile(f, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const until = async (pred, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await pred()) return true; await new Promise((r) => setTimeout(r, 30)); } return false; };
const incoming = (m) => appendFile(process.env.FAKE_IMSG_INBOX, JSON.stringify(m) + '\n');
let stop, row = 50;
const msg = (over) => ({ id: ++row, guid: `IN-${row}`, chat_guid: `iMessage;-;${OWNER}`, sender: OWNER, is_from_me: false, text: '', service: 'iMessage', ...over });

before(async () => {
  stop = await imessage.start((m) => router.inbound(m), { log: () => {} });
  router.running = true;
  assert.ok(await until(async () => (await lines(process.env.FAKE_IMSG_LOG)).some((l) => l.method === 'watch.subscribe')), 'subscribed');
});
after(async () => { router.running = false; stop?.(); inboxSrv.close(); await rm(tmp, { recursive: true, force: true }); });

describe('iMessage', () => {
  test('the watch subscribes without attachments or reactions', async () => {
    const sub = (await lines(process.env.FAKE_IMSG_LOG)).find((l) => l.method === 'watch.subscribe');
    assert.deepEqual(sub.params, { attachments: false, include_reactions: false });
  });
  test('an ask goes out through imsg rpc send, pinned to AppleScript, to the owner\'s handle', async () => {
    const r = await dispatch('ask.create', { question: 'Order the samples?', options: ['yes', 'no'], sessionId: SESSION, actor: 'test' });
    assert.match(r.note, /texted as .* on imessage/);
    const send = (await lines(process.env.FAKE_IMSG_LOG)).filter((l) => l.method === 'send').at(-1);
    assert.equal(send.params.to, OWNER); assert.equal(send.params.transport, 'applescript'); assert.equal(send.params.service, 'imessage');
    assert.match(send.params.text, new RegExp(`^Drover ask ${r.code} · asker on mini\\nOrder the samples\\?\\na\\) yes {2}b\\) no`));
    // Not the owner's one-to-one chat: this account's own message, a group chat, another person. Then the owner.
    await incoming(msg({ is_from_me: true, sender: 'drover@example.com', text: `${r.code} a` }));
    await incoming(msg({ chat_guid: 'iMessage;+;chat99', text: `${r.code} a` }));
    await incoming(msg({ sender: '+15005550188', chat_guid: 'iMessage;-;+15005550188', text: `${r.code} a` }));
    await incoming(msg({ text: `${r.code} b` }));
    assert.ok(await until(async () => inbox.length >= 1), 'delivered');
    await router.exclusive(() => {});
    assert.equal(inbox.length, 1);
    assert.match(inbox[0], new RegExp(`\\[Owner via imessage, verified\\] ${r.code} → b \\(no\\)`));
    const got = await dispatch('ask.get', { askId: r.askId });
    assert.equal(got.answer.source, 'owner:imessage'); assert.equal(got.answer.sender, `imsg:${OWNER}`);
    // Other chats are the account's own business: not one of them reached the truth file, untrusted or not.
    const inbound = (await lines(process.env.DROVER_EVENTS)).filter((e) => e.type === 'ask' && e.phase === 'inbound');
    assert.deepEqual(inbound, []);
    // The acknowledgement goes back on iMessage.
    assert.ok(await until(async () => (await lines(process.env.FAKE_IMSG_LOG)).some((l) => l.method === 'send' && /→ b \(no\): sent to asker on mini/.test(l.params.text))));
  });
  test('the last rowid is kept, so a restart replays only what it missed', async () => {
    assert.ok(await until(async () => { try { return Number(await readFile(path.join(process.env.DROVER_STATE, 'ask', 'imsg-rowid'), 'utf8')) === row; } catch { return false; } }));
    stop(); stop = null;
    await writeFile(process.env.FAKE_IMSG_LOG, '');
    stop = await imessage.start((m) => router.inbound(m), { log: () => {} });
    assert.ok(await until(async () => (await lines(process.env.FAKE_IMSG_LOG)).some((l) => l.method === 'watch.subscribe')));
    assert.equal((await lines(process.env.FAKE_IMSG_LOG)).find((l) => l.method === 'watch.subscribe').params.since_rowid, row);
  });
  test('health: works for a separate account, refuses the owner\'s own Apple ID and a signed-out one', async () => {
    process.env.FAKE_IMSG_ACCOUNT = 'Account: drover@example.com\nAliases: drover@example.com\n';
    assert.equal((await imessage.health()).ok, true);
    process.env.FAKE_IMSG_ACCOUNT = 'Account: owner@example.com\nAliases: +1 (500) 555-0123, owner@example.com\n';
    const self = await imessage.health();
    assert.equal(self.ok, false); assert.match(self.error, /note to self/);
    assert.equal(self.error.includes('555'), false, 'the aliases are compared, never repeated');
    process.env.FAKE_IMSG_ACCOUNT = '';
    assert.match((await imessage.health()).error, /signed out of iMessage/);
    delete process.env.FAKE_IMSG_ACCOUNT;
  });
  test('the hub checks the account before it reads or sends: the owner\'s own Apple ID keeps the channel off', async () => {
    const { Router, _deps: rd } = await import('../core/ask/router.js');
    const real = rd.channels;
    let started = false;
    rd.channels = { ...real, imessage: { ...imessage, configured: () => true, health: async () => ({ ok: false, error: 'this Mac account\'s iMessage is the owner\'s own Apple ID: a text to the owner would be a note to self' }), start: async () => { started = true; return () => {}; } } };
    const r = new Router();
    try {
      r.start();
      assert.ok(await until(async () => r.disabled.get('imessage') !== 'checking'));
      assert.match(r.disabled.get('imessage'), /note to self/);
      assert.equal(started, false, 'never watched');
      assert.deepEqual(r.usable({ order: ['imessage'] }), []);
    } finally { r.stop(); rd.channels = real; }
  });
  test('no watch, no iMessage: a failed subscribe refuses sends until the restarted child subscribes', async () => {
    const flag = path.join(tmp, 'subscribe-fails');
    await writeFile(flag, '1');
    process.env.FAKE_IMSG_SUBSCRIBE_FAIL = flag;
    stop(); stop = await imessage.start((m) => router.inbound(m), { log: () => {} });
    await assert.rejects(imessage.send({ text: 'x' }), /not watching for replies/);
    await rm(flag);
    assert.ok(await until(async () => { try { await imessage.send({ text: 'back' }); return true; } catch { return false; } }, 6000), 'recovers after the restart');
    delete process.env.FAKE_IMSG_SUBSCRIBE_FAIL;
  });
  test('who counts as the owner, as read from a message', () => {
    assert.equal(imessage.readMessage(msg({ text: 'x' })).verified, true);
    assert.equal(imessage.readMessage(msg({ sender: 'OWNER@Example.com', chat_guid: 'iMessage;-;owner@example.com' }), { env: { DROVER_ASK_IMESSAGE_TO: 'owner@example.com' } }).verified, true);
    assert.equal(imessage.readMessage(msg({ is_from_me: 1 })).verified, false);
    assert.equal(imessage.dmHandle('any;-;+15005550123'), OWNER);
    assert.equal(imessage.dmHandle('iMessage;+;chat1'), null);
  });
});
