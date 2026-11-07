// Read receipts in a Grok bot's conversations (core/bots/grok.js receipts): a message to a bot is queued, delivered,
// read and answered; a bot's reply is delivered, then read by whoever it is for. The bot sees both through its
// gateway tools (drover_inbox, drover_whoami, drover_sent, drover_search, drover_reply); the owner sees them in the
// bot's transcript; every receipt counts only from the reader it names.
import './isolate-cache.js';
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const STATE = await mkdtemp(path.join(tmpdir(), 'drover-receipts-'));
const EVENTS = path.join(STATE, 'events.jsonl');
process.env.DROVER_STATE = STATE;
process.env.DROVER_EVENTS = EVENTS;
process.env.CODEX_HOME = path.join(STATE, 'codex-home');
const grok = await import('../core/bots/grok.js');
const events = await import('../core/events.js');
const api = await import('../core/api.js');
const codex = await import('../core/codex.js');
const { botTools, _resetAlerts } = await import('../core/bots/tools.js');
const { OWNER } = await import('../core/owner.js');
const { cliOp, _deps: cliDeps } = await import('../core/cli-op.js');
const mcp = await import('../mcp/server.js');
const { withReceipts, receiptLine, chatItems, itemSig, lastUnreadReply } = await import('../ui/chat-model.js');
const { feedLine } = await import('../ui/views/board.js');

// A stand-in for the bot's Routine webhook: always accepts.
const hook = createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"success":true,"runUuid":"run-1"}'); }); });
let HOOK;
const KEY = 'crsr_test_key_0123456789';
const wal = async () => (await readFile(EVENTS, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const receipts = async () => (await wal()).filter((e) => e.type === 'receipt');

/** The tools a bot's own connection gets, run as the gateway runs them (dispatch is the daemon's). */
function toolsOf(bot, scopes = ['drover.read', 'drover.write', 'drover.notify']) {
  const grant = { grantId: `grant_${bot}`, clientId: 'c', clientName: 'Grok Bot', bot, scopes };
  const list = botTools(grant, { dispatch: (op, args) => api.dispatch(op, args), host: 'box-a' });
  return (name, args = {}) => { const t = list.find((x) => x.name === name); assert.ok(t, `tool ${name}`); return t.run(null, args); };
}

describe('read receipts in Grok bot conversations', () => {
  before(async () => { await new Promise((r) => hook.listen(0, '127.0.0.1', r)); HOOK = `http://127.0.0.1:${hook.address().port}/automations/webhook/abc123def456`; });
  after(() => { codex.stopReadClient(); codex.sharedClient().stop(); return new Promise((r) => hook.close(r)); });
  beforeEach(async () => {
    await writeFile(EVENTS, '');
    await rm(path.join(STATE, 'bots'), { recursive: true, force: true });
    await rm(path.join(STATE, 'settings.json'), { force: true });
    await mkdir(path.join(STATE, 'bots'), { recursive: true });   // this host keeps the bots
    grok._resetCache();
    _resetAlerts();
  });

  test('a message is delivered by the Routine, read when the bot starts on it, answered by its reply', async () => {
    await grok.setRoutine('alpha', { url: HOOK, key: KEY });
    const sent = await api.dispatch('sessions.message', { id: 'grok:alpha', text: 'what runs on box-b?', actor: OWNER });
    const tool = toolsOf('alpha');
    let t = await api.dispatch('sessions.transcript', { id: 'grok:alpha' });
    const msg = t.turns.find((x) => x.role === 'user');
    assert.equal(msg.receipt.state, 'delivered');
    assert.equal(msg.receipt.delivered.via, 'routine');
    assert.equal(msg.receipt.read, null);

    // The routine run starts with drover_status on that task: the owner sees the message read.
    await tool('drover_status', { state: 'working', summary: 'looking at box-b', task: sent.ref });
    t = await api.dispatch('sessions.transcript', { id: 'grok:alpha' });
    assert.equal(t.turns.find((x) => x.role === 'user').receipt.state, 'read');
    assert.equal(t.turns.find((x) => x.role === 'user').receipt.read.via, 'status');
    const [r1] = await receipts();
    assert.deepEqual([r1.of, r1.by, r1.actor, r1.via, r1.thread, r1.source, r1.untrusted], [[sent.ref], 'grok:alpha', 'grok:alpha', 'status', 'grok:alpha', 'grok:alpha', true], 'recorded as the bot, marked like everything a bot causes');
    assert.ok(!t.turns.some((x) => /receipt/.test(x.text ?? '')), 'receipts are not turns of the transcript');

    // Starting again on the same message writes nothing new.
    await tool('drover_status', { state: 'working', summary: 'still on it', task: sent.ref });
    assert.equal((await receipts()).length, 1);

    const out = await tool('drover_reply', { messageId: sent.ref, text: 'webapp-api and the broker' });
    assert.equal(out.to, OWNER);
    assert.deepEqual(out.delivery, { delivered: true, via: 'alert' });
    assert.equal(out.read, null);
    t = await api.dispatch('sessions.transcript', { id: 'grok:alpha' });
    const m = t.turns.find((x) => x.role === 'user').receipt;
    assert.equal(m.state, 'answered');
    assert.equal(m.answered.event, out.event);
    assert.deepEqual(t.turns.find((x) => x.role === 'assistant').receipt, { to: OWNER, state: 'delivered', read: null });
    assert.equal(t.receipts[out.event].state, 'delivered', 'receipts repeat the last turns for incremental readers');
  });

  test('a queued message is delivered and read when drover_inbox hands it over, once', async () => {
    const sent = await api.dispatch('sessions.message', { id: 'grok:bravo', text: 'rotate the logs', actor: OWNER });
    assert.equal(sent.queued, true);
    let t = await api.dispatch('sessions.transcript', { id: 'grok:bravo' });
    assert.equal(t.turns[0].receipt.state, 'queued');
    const tool = toolsOf('bravo');
    assert.deepEqual((await tool('drover_whoami')).inbox, { unanswered: 1, unread: 1 });
    const first = await tool('drover_inbox');
    assert.equal(first.messages.length, 1);
    assert.ok(first.messages[0].readAt, 'the answer already says it is read');
    assert.equal(first.messages[0].reply, null);
    assert.deepEqual((await tool('drover_whoami')).inbox, { unanswered: 1, unread: 0 });
    t = await api.dispatch('sessions.transcript', { id: 'grok:bravo' });
    assert.equal(t.turns[0].receipt.state, 'read');
    assert.deepEqual([t.turns[0].receipt.delivered.via, t.turns[0].receipt.read.via], ['inbox', 'inbox']);
    await tool('drover_inbox');
    assert.equal((await receipts()).length, 1, 'a second look writes no second receipt');
  });

  test('a broadcast is read per bot: one bot reading it says nothing about another', async () => {
    await api.dispatch('sessions.message', { id: 'grok:*', text: 'standup at 9', actor: OWNER });
    await toolsOf('alpha')('drover_inbox');
    const a = await api.dispatch('sessions.transcript', { id: 'grok:alpha' });
    const b = await api.dispatch('sessions.transcript', { id: 'grok:bravo' });
    assert.equal(a.turns[0].receipt.state, 'read');
    assert.equal(b.turns[0].receipt.state, 'queued');
  });

  test('a reply is read only by who it is for: the owner through a client, an agent through MCP', async () => {
    const tool = toolsOf('alpha');
    const fromOwner = await api.dispatch('sessions.message', { id: 'grok:alpha', text: 'status of the deploy?', actor: OWNER });
    const fromAgent = await api.dispatch('sessions.message', { id: 'grok:alpha', text: 'which branch is on box-b?', actor: 'mcp' });
    const toOwner = await tool('drover_reply', { messageId: fromOwner.ref, text: 'green' });
    const toAgent = await tool('drover_reply', { messageId: fromAgent.ref, text: 'feat/x' });
    const own = await tool('drover_reply', { text: 'heads up: disk at 90% on box-c' });
    assert.equal(toAgent.to, 'mcp');
    assert.deepEqual(toAgent.delivery, { delivered: true, via: 'thread' });
    assert.equal(own.to, OWNER, 'a message on its own thread is for the owner');
    assert.deepEqual((await tool('drover_whoami')).replies, { unread: 3 });

    // The agent's message is the agent's in a chat view, not the owner's.
    const items = chatItems((await api.dispatch('sessions.transcript', { id: 'grok:alpha' })).turns);
    assert.deepEqual(items.filter((i) => i.kind === 'user').map((i) => i.label), ['you', 'mcp']);
    assert.equal((await tool('drover_whoami')).owner, OWNER, 'a bot learns which actor is the owner');

    // An agent reading the thread reads only what was for it, whatever reader it would claim.
    await api.dispatch('sessions.transcript', { id: 'grok:alpha', seenBy: 'mcp' });
    let sent = (await tool('drover_sent')).sent;
    assert.deepEqual(sent.map((s) => [s.event, s.to, s.state]), [[own.event, OWNER, 'delivered'], [toAgent.event, 'mcp', 'read'], [toOwner.event, OWNER, 'delivered']], 'newest first');
    assert.equal(sent[1].read.by, 'mcp');

    // The owner's client (any of them) reads the rest.
    await api.dispatch('sessions.transcript', { id: 'grok:alpha', seenBy: 'ios' });
    sent = (await tool('drover_sent')).sent;
    assert.deepEqual(sent.map((s) => s.state), ['read', 'read', 'read']);
    assert.deepEqual(sent[0].read.by, OWNER, 'every owner client reads as the owner');
    assert.deepEqual((await tool('drover_whoami')).replies, { unread: 0 });
    const inbox = (await tool('drover_inbox')).messages;
    assert.deepEqual(inbox.map((m) => [m.answered, m.reply?.event, m.reply?.read?.by]), [[true, toOwner.event, OWNER], [true, toAgent.event, 'mcp']]);
    const before = (await receipts()).length;
    await api.dispatch('sessions.transcript', { id: 'grok:alpha', seenBy: 'owner' });
    assert.equal((await receipts()).length, before, 'reading again writes nothing');
  });

  test('a receipt counts only from the reader it names; a bot never reads another bot\'s thread', async () => {
    const tool = toolsOf('alpha');
    const m = await api.dispatch('sessions.message', { id: 'grok:alpha', text: 'ping', actor: OWNER });
    const r = await tool('drover_reply', { messageId: m.ref, text: 'pong' });
    // No caller of the events.append op writes a receipt, whatever actor it names (the CLI keeps one a caller passes).
    for (const actor of ['mcp', 'cli', OWNER, 'owner'])
      await assert.rejects(api.dispatch('events.append', { event: { type: 'receipt', of: [r.event], thread: 'grok:alpha', state: 'read', by: OWNER }, actor }), /refused: receipt events are written by Drover/);
    // One that got into the file anyway (an older daemon, a synced line) counts only from the reader it names.
    await events.append({ type: 'receipt', of: [r.event], thread: 'grok:alpha', state: 'read', by: OWNER }, { actor: 'mcp' });
    assert.equal((await tool('drover_sent')).sent[0].state, 'delivered');
    assert.equal(await grok.markSeen('grok:alpha', { by: 'grok:bravo' }), 0);
    assert.equal(await grok.markSeen('grok:*', { by: OWNER }), 0);
    await assert.rejects(events.append({ type: 'receipt', of: [], state: 'read', by: 'x' }), /receipt.of/);
    await assert.rejects(events.append({ type: 'receipt', of: ['x'], state: 'unread', by: 'x' }), /receipt.state/);
  });

  test('a transcript read marks only the replies its page showed', async () => {
    const tool = toolsOf('alpha');
    const first = await tool('drover_reply', { text: 'one' });
    const second = await tool('drover_reply', { text: 'two' });
    const page = await api.dispatch('sessions.transcript', { id: 'grok:alpha', since: 0, limit: 1, seenBy: 'owner' });
    assert.deepEqual(page.turns.map((t) => [t.id, t.receipt.state]), [[first.event, 'read']], 'the page comes back read');
    assert.deepEqual((await tool('drover_sent')).sent.map((s) => [s.event, s.state]), [[second.event, 'delivered'], [first.event, 'read']]);
    await api.dispatch('sessions.transcript', { id: 'grok:alpha', since: 1, limit: 5, seenBy: 'owner' });
    assert.deepEqual((await tool('drover_sent')).sent.map((s) => s.state), ['read', 'read'], 'the next page reads the rest');
    const before = (await receipts()).length;
    await api.dispatch('sessions.transcript', { id: 'grok:alpha', since: 2, limit: 5, seenBy: 'owner' });
    assert.equal((await receipts()).length, before, 'a page with no reply in it marks nothing');
  });

  test('a later message reusing a ref cannot take over who a reply is for; the op stamps who and when', async () => {
    const tool = toolsOf('alpha');
    const m = await api.dispatch('sessions.message', { id: 'grok:alpha', text: 'buy the domain?', actor: OWNER });
    const r = await tool('drover_reply', { messageId: m.ref, text: 'bought it' });
    assert.equal((await wal()).find((e) => e.id === r.event).recipient, OWNER, 'the reply records who it is for');
    // An agent appends a message with the same ref, claiming an earlier time and the owner's actor in its body.
    const forged = await api.dispatch('events.append', { event: { type: 'message', to: { kind: 'grok', id: 'grok:alpha' }, text: 'x', ref: m.ref, ts: '2000-01-01T00:00:00.000Z', actor: OWNER, id: 'forged-id' }, actor: 'mcp' });
    assert.deepEqual([forged.actor, forged.id === 'forged-id', forged.ts.startsWith('2000')], ['mcp', false, false], 'the op stamps actor, id and time');
    await api.dispatch('sessions.transcript', { id: 'grok:alpha', seenBy: 'mcp' });
    assert.equal((await tool('drover_sent')).sent.find((s) => s.event === r.event).state, 'delivered', 'still for the owner, still unread');
    // An older reply without a recorded recipient falls back to its message: the first one with that ref.
    await events.append({ type: 'chat', to: { kind: 'grok', id: 'grok:alpha' }, from: 'grok:alpha', text: 'old reply', inReplyTo: m.ref, source: 'grok:alpha', untrusted: true }, { actor: 'grok:alpha' });
    const old = (await tool('drover_sent')).sent.find((s) => s.text === 'old reply');
    assert.equal(old.to, OWNER);
  });

  test('sessions.lastReply with seenBy reads that reply (and earlier ones for that reader), not later ones', async () => {
    const tool = toolsOf('alpha');
    const a = await tool('drover_reply', { text: 'one' });
    const last = await api.dispatch('sessions.lastReply', { id: 'grok:alpha', seenBy: 'owner' });
    assert.equal(last.text, 'one');
    assert.equal(last.event, a.event);
    assert.equal(last.receipt.state, 'read');
    const b = await tool('drover_reply', { text: 'two' });
    const sent = (await tool('drover_sent')).sent;
    assert.deepEqual(sent.map((s) => [s.event, s.state]), [[b.event, 'delivered'], [a.event, 'read']]);
  });

  test('sessions.seen marks a thread read for the caller; its receipt is the record, no op event', async () => {
    const tool = toolsOf('alpha');
    const r = await tool('drover_reply', { text: 'done with the migration' });
    const out = await api.dispatchRecorded('sessions.seen', { id: 'grok:alpha', actor: OWNER });
    assert.deepEqual(out, { id: 'grok:alpha', marked: 1 });
    assert.equal((await tool('drover_sent')).sent[0].state, 'read');
    const evs = await wal();
    assert.ok(!evs.some((e) => e.type === 'op' && e.op === 'sessions.seen'));
    assert.deepEqual((await receipts()).map((e) => [e.of[0], e.by, e.via]), [[r.event, OWNER, 'seen']]);
    await assert.rejects(api.dispatch('sessions.seen', { id: 'manager' }), /grok:<name>/);
  });

  test('a reply to a muted bot is delivered quietly: muted says so', async () => {
    await api.dispatch('notify.mute', { scope: 'session', target: 'grok:alpha' });
    const out = await toolsOf('alpha')('drover_reply', { text: 'quiet one' });
    assert.deepEqual(out.delivery, { delivered: true, via: 'alert', muted: true });
  });

  test('drover_search marks the bot\'s own thread with its receipts', async () => {
    const m = await api.dispatch('sessions.message', { id: 'grok:alpha', text: 'look into the flaky test', actor: OWNER });
    const tool = toolsOf('alpha');
    const r = await tool('drover_reply', { messageId: m.ref, text: 'it was a race' });
    const evs = await wal();
    const msgEv = evs.find((e) => e.type === 'message');
    const grant = { grantId: 'g', clientId: 'c', clientName: 'Grok Bot', bot: 'alpha', scopes: ['drover.read'] };
    const dispatch = async (op, args) => (op === 'search.fleet' ? { results: [
      { kind: 'wal', role: 'message', ref: msgEv.id, sessionId: 'grok:alpha', title: 'message to Alpha', snippet: 'look into the flaky test', score: 2 },
      { kind: 'wal', role: 'chat', ref: r.event, sessionId: 'grok:alpha', title: 'chat from grok:alpha', snippet: 'it was a race', score: 1 },
      { kind: 'claude', title: 'x', snippet: 'unrelated', sessionId: 's1', score: 0.5 },
    ], coverage: { searched: ['box-a'] } } : api.dispatch(op, args));
    const search = botTools(grant, { dispatch, host: 'box-a' }).find((t) => t.name === 'drover_search');
    const res = await search.run(null, { query: 'flaky' });
    assert.equal(res.results[0].event, msgEv.id);
    assert.equal(res.results[0].messageId, m.ref);
    assert.deepEqual(res.results[0].receipt, { state: 'answered', readAt: res.results[0].receipt.readAt, answered: true });
    assert.deepEqual(res.results[1].receipt, { to: OWNER, state: 'delivered', read: null });
    assert.equal(res.results[2].receipt, undefined, 'anything else gets nothing');
    // A bot named like another kind of session (the manager's thread is "manager") gets nothing for that thread's hits.
    const named = botTools({ ...grant, bot: 'manager' }, { dispatch: async (op, args) => (op === 'search.fleet' ? { results: [{ kind: 'wal', role: 'chat', ref: r.event, sessionId: 'manager', title: 'chat from manager', snippet: 'x', score: 1 }], coverage: { searched: [] } } : api.dispatch(op, args)), host: 'box-a' });
    const plain = await named.find((t) => t.name === 'drover_search').run(null, { query: 'x' });
    assert.equal(plain.results[0].receipt, undefined);
  });

  test('the board counts the replies the owner has not read', async () => {
    await toolsOf('alpha')('drover_reply', { text: 'news' });
    let s = (await grok.listSessions()).find((x) => x.id === 'grok:alpha');
    assert.equal(s.unread, 1);
    await api.dispatch('sessions.transcript', { id: 'grok:alpha', seenBy: 'owner' });
    s = (await grok.listSessions()).find((x) => x.id === 'grok:alpha');
    assert.equal(s.unread, undefined);
  });

  test('MCP and CLI reads name their own reader, never one a caller passes', async () => {
    const seen = [];
    const dispatch = async (op, args) => { seen.push({ op, args }); return { turns: [] }; };
    const transcriptTool = mcp.TOOLS.find((t) => t.name === 'drover_session_transcript');
    await transcriptTool.run(dispatch, { id: 'grok:alpha' });
    await transcriptTool.run(dispatch, { id: 'Alpha' });   // however the id is spelled, the reader is this server
    await mcp.GENERIC_TOOL.run(dispatch, { op: 'sessions.transcript', args: { id: 'grok:alpha', seenBy: 'owner' } });
    await mcp.GENERIC_TOOL.run(dispatch, { op: 'sessions.lastReply', args: { id: 'grok:alpha', seenBy: 'owner' } });
    assert.deepEqual(seen.map((s) => s.args.seenBy), ['mcp', 'mcp', 'mcp', 'mcp']);
    // Marking a thread read names this server too, never the owner or another reader an agent claims.
    const seenTool = mcp.allTools().find((t) => t.name === 'drover_sessions_seen');
    await seenTool.run(dispatch, { id: 'grok:alpha', actor: 'cli' });
    await mcp.GENERIC_TOOL.run(dispatch, { op: 'sessions.seen', args: { id: 'grok:alpha', actor: 'owner' } });
    assert.deepEqual(seen.slice(-2).map((s) => [s.op, s.args.actor]), [['sessions.seen', 'mcp'], ['sessions.seen', 'mcp']]);

    const calls = [];
    const saved = { ...cliDeps };
    cliDeps.dispatchRecorded = async (op, args) => { calls.push({ op, args }); return {}; };
    try {
      await cliOp('sessions.transcript', { id: 'grok:alpha', seenBy: 'owner' });
      await cliOp('sessions.lastReply', { id: 'Alpha' });
      cliDeps.daemonEndpoint = async () => null;   // no daemon: the write runs here
      await cliOp('sessions.seen', { id: 'grok:alpha', actor: 'owner' });
    } finally { Object.assign(cliDeps, saved); }
    assert.deepEqual(calls.map((c) => c.args.seenBy ?? c.args.actor), ['cli', 'cli', 'cli']);
  });
});

describe('receipts in the chat model (ui/chat-model.js)', () => {
  test('withReceipts lays receipts on shown turns by id, and keeps the array when nothing changed', () => {
    const turns = [{ role: 'user', id: 'e1', text: 'hi', receipt: { state: 'delivered', delivered: { at: 't1', via: 'routine' }, read: null, answered: null } }, { role: 'assistant', id: 'e2', text: 'hello', receipt: { to: 'cole', state: 'delivered', read: null } }];
    assert.equal(withReceipts(turns, {}), turns);
    assert.equal(withReceipts(turns, { e1: turns[0].receipt }), turns);
    const next = withReceipts(turns, { e2: { to: 'cole', state: 'read', read: { at: 't3', by: 'cole' } } });
    assert.notEqual(next, turns);
    assert.equal(next[1].receipt.state, 'read');
    assert.equal(next[0], turns[0], 'untouched turns stay the same objects');
    const [, before] = chatItems(turns), [, after] = chatItems(next);
    assert.notEqual(itemSig(before), itemSig(after), 'a receipt change rebuilds that turn');
  });

  test('lastUnreadReply finds the newest reply on screen the owner has not read', () => {
    const you = (a) => a === 'cole';
    const turns = [
      { role: 'assistant', id: 'c1', receipt: { to: 'cole', state: 'delivered', read: null } },
      { role: 'user', id: 'm2', receipt: { state: 'answered' } },
      { role: 'assistant', id: 'c2', receipt: { to: 'cole', state: 'delivered', read: null } },
      { role: 'assistant', id: 'c3', receipt: { to: 'mcp', state: 'delivered', read: null } },
    ];
    assert.equal(lastUnreadReply(turns, you), 'c2', 'a reply for an agent is not the owner\'s to read');
    assert.equal(lastUnreadReply(turns.map((t) => (t.id === 'c2' || t.id === 'c1' ? { ...t, receipt: { ...t.receipt, state: 'read' } } : t)), you), null);
    assert.equal(lastUnreadReply([], you), null);
  });

  test('the board feed names receipts in words', () => {
    assert.equal(feedLine({ type: 'receipt', of: ['a', 'b'], by: 'cole', thread: 'grok:alpha' }), 'cole read 2 replies from grok:alpha');
    assert.equal(feedLine({ type: 'receipt', of: ['m1'], by: 'grok:alpha', thread: 'grok:alpha' }), 'grok:alpha read a message');
  });

  test('receiptLine says how far a message got, and whether a reply was read', () => {
    const at = (ts) => ts;
    const you = (a) => a === 'cole';
    assert.equal(receiptLine({ state: 'queued', delivered: null, read: null, answered: null }, { name: 'Alpha', at, you }), "queued in Alpha's inbox");
    assert.equal(receiptLine({ state: 'answered', delivered: { at: '10:00', via: 'routine' }, read: { at: '10:01', via: 'status' }, answered: { at: '10:05', event: 'x' } }, { at, you }), 'delivered by its Routine 10:00 · read 10:01 · answered 10:05');
    assert.equal(receiptLine({ state: 'answered', delivered: { at: '10:05', via: 'inbox' }, read: { at: '10:05', via: 'reply' }, answered: { at: '10:05', event: 'x' } }, { at, you }), 'picked up from the inbox 10:05 · answered 10:05');
    assert.equal(receiptLine({ state: 'queued', delivered: null, read: null, answered: null, failed: 'the Routine key was refused' }, { at, you }), 'its Routine refused it (the Routine key was refused); it waits in the inbox');
    assert.equal(receiptLine({ to: 'cole', state: 'delivered', read: null }, { at, you }), 'not read yet');
    assert.equal(receiptLine({ to: 'cole', state: 'read', read: { at: '11:00', by: 'cole' } }, { at, you }), 'read by you 11:00');
    assert.equal(receiptLine({ to: 'mcp', state: 'delivered', read: null }, { at, you }), 'for mcp, not read yet');
    assert.equal(receiptLine(null), null);
  });
});
