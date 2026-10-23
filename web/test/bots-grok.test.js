// Grok bots as Drover sessions (core/bots/grok.js): Routines (webhook URL + key, never shown), delivery to a fake
// Grok Bot webhook, the inbox and reply round trip through the real sessions.message op, statuses on the board.
import './isolate-cache.js';
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, stat, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const STATE = await mkdtemp(path.join(tmpdir(), 'drover-grok-'));
const EVENTS = path.join(STATE, 'events.jsonl');
process.env.DROVER_STATE = STATE;
process.env.DROVER_EVENTS = EVENTS;
process.env.CODEX_HOME = path.join(STATE, 'codex-home');   // never this machine's Codex threads, should anything ask
const grok = await import('../core/bots/grok.js');
const events = await import('../core/events.js');
const api = await import('../core/api.js');
const codex = await import('../core/codex.js');
const { alertFromEvent } = await import('../core/notify.js');
const { OWNER, OWNER_NAME } = await import('../core/owner.js');
const OWNER_SHOWN = OWNER_NAME.charAt(0).toUpperCase() + OWNER_NAME.slice(1);   // how the webhook body names the owner

// A stand-in for api2.cursor.sh/automations/webhook/<id>: records what Drover sends, answers per test.
const hits = [];
let answer = { status: 200, body: { success: true, runUuid: 'run-123' } };
const hook = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    hits.push({ method: req.method, url: req.url, headers: req.headers, body: JSON.parse(body || 'null') });
    res.writeHead(answer.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(answer.body));
  });
});
let HOOK;
const KEY = 'crsr_test_key_0123456789';
const wal = async () => (await readFile(EVENTS, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));

describe('core/bots/grok', () => {
  before(async () => { await new Promise((r) => hook.listen(0, '127.0.0.1', r)); HOOK = `http://127.0.0.1:${hook.address().port}/automations/webhook/abc123def456`; });
  after(() => { codex.stopReadClient(); codex.sharedClient().stop(); return new Promise((r) => hook.close(r)); });
  beforeEach(async () => {
    await writeFile(EVENTS, '');
    await rm(path.join(STATE, 'bots'), { recursive: true, force: true });
    grok._resetCache();
    hits.length = 0;
    answer = { status: 200, body: { success: true, runUuid: 'run-123' } };
  });

  test('ids: grok:<name> and grok:* are bot targets; other things are not', () => {
    assert.equal(grok.botName('grok:Alpha'), 'alpha');
    assert.equal(grok.isGrokId('grok:alpha'), true);
    assert.equal(grok.isGrokTarget('grok:*'), true);
    for (const x of ['alpha', 'grok:', 'grok:Alpha Bravo', 'manager', '']) assert.equal(grok.isGrokId(x), false, x);
  });

  test('Routines: https (or loopback) URLs and a real key; stored 0600; the key is never shown', async () => {
    await assert.rejects(grok.setRoutine('alpha', { url: 'http://evil.example/hook', key: KEY }), /must be https/);
    await assert.rejects(grok.setRoutine('alpha', { url: 'https://user:pw@api2.cursor.sh/x', key: KEY }), /must be https/);
    await assert.rejects(grok.setRoutine('alpha', { url: HOOK, key: 'short' }), /bearer key/);
    await assert.rejects(grok.setRoutine('Not A Name', { url: HOOK, key: KEY }), /bot name/);
    const r = await grok.setRoutine('alpha', { url: HOOK, key: KEY, title: 'Dev Ops' });
    assert.deepEqual({ host: r.routine.host, webhook: r.routine.webhook, hasKey: r.routine.hasKey }, { host: new URL(HOOK).host, webhook: '…def456', hasKey: true });
    const file = path.join(STATE, 'bots', 'grok.json');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.ok(!JSON.stringify(await grok.routines()).includes(KEY), 'routines() never carries the key');
    assert.equal(grok.configured(), true, 'a Routine makes this host the one that keeps the bots');
    await grok.removeRoutine('alpha');
    assert.deepEqual(await grok.routines(), []);
  });

  test('overlapping Routine changes all land: each reads what the one before it wrote', async () => {
    await Promise.all(['alpha', 'bravo', 'charlie'].map((n) => grok.setRoutine(n, { url: HOOK, key: KEY })));
    assert.deepEqual((await grok.routines()).map((r) => r.bot).sort(), ['alpha', 'bravo', 'charlie']);
    const [gone, added, missing] = await Promise.allSettled([grok.removeRoutine('bravo'), grok.setRoutine('delta', { url: HOOK, key: KEY }), grok.removeRoutine('nobody')]);
    assert.deepEqual([gone.status, added.status, missing.status], ['fulfilled', 'fulfilled', 'rejected']);
    assert.deepEqual((await grok.routines()).map((r) => r.bot).sort(), ['alpha', 'charlie', 'delta'], 'a failed change saves nothing and blocks nothing');
  });

  test('without a Routine a message is queued for the inbox; grok:* reaches every inbox', async () => {
    const r = await grok.send('grok:bravo', 'check the disk');
    assert.equal(r.ok, true);
    assert.equal(r.queued, true);
    assert.match(r.ref, /^[0-9a-f-]{36}$/);
    assert.equal((await grok.send('grok:*', 'standup at 9')).queued, true);
    assert.equal(hits.length, 0);
  });

  test('with a Routine: one POST with the bearer key and a body carrying the exact reply arguments', async () => {
    await grok.setRoutine('alpha', { url: HOOK, key: KEY });
    const r = await grok.send('grok:alpha', 'deploy webapp-api', { actor: OWNER, ref: 'ref-1' });
    assert.deepEqual(r, { ok: true, ref: 'ref-1', via: 'grok routine webhook', status: 200, runUuid: 'run-123' });
    assert.equal(hits.length, 1);
    const h = hits[0];
    assert.equal(h.method, 'POST');
    assert.equal(h.headers.authorization, `Bearer ${KEY}`);
    assert.equal(h.headers['content-type'], 'application/json');
    assert.equal(h.body.type, 'drover.message');
    assert.equal(h.body.text, 'deploy webapp-api');
    assert.deepEqual(h.body.from, { actor: OWNER, name: OWNER_SHOWN });
    // No argument names the bot: its own connection says which bot it is, and a bound schema refuses `agent`.
    assert.deepEqual(h.body.reply, { tool: 'drover_reply', arguments: { messageId: 'ref-1' } });
    assert.deepEqual(h.body.status, { tool: 'drover_status', arguments: { task: 'ref-1' } });
    assert.deepEqual(h.body.bot, { name: 'Alpha', id: 'grok:alpha' });
    assert.ok(!JSON.stringify(r).includes(KEY), 'the result never carries the key');
  });

  test('a message leaves for the Routine with its secrets redacted; the truth file keeps it as sent', async () => {
    await mkdir(path.join(STATE, 'bots'), { recursive: true });
    await grok.setRoutine('alpha', { url: HOOK, key: KEY });
    const secret = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
    await api.dispatch('sessions.message', { id: 'grok:alpha', text: `deploy with ${secret} please` });
    assert.ok(!hits.at(-1).body.text.includes(secret), 'the webhook body never carries the token');
    assert.match(hits.at(-1).body.text, /^deploy with .*redacted.* please$/);
    assert.ok((await wal()).find((e) => e.type === 'message').text.includes(secret), 'the local record is unchanged');
  });

  test('a paused, unauthorized or unreachable Routine says why, without the key', async () => {
    await grok.setRoutine('alpha', { url: HOOK, key: KEY });
    answer = { status: 400, body: { success: false, error: 'Automation abc is disabled' } };
    const paused = await grok.send('grok:alpha', 'x');
    assert.equal(paused.ok, false);
    assert.match(paused.error, /paused.*Automation abc is disabled/);
    answer = { status: 401, body: { code: 'error', message: 'Invalid API key' } };
    assert.match((await grok.send('grok:alpha', 'x')).error, /key was refused/);
    await grok.setRoutine('bravo', { url: 'http://127.0.0.1:1/automations/webhook/zz', key: KEY });
    const down = await grok.send('grok:bravo', 'x');
    assert.equal(down.ok, false);
    assert.match(down.error, /unreachable/);
    assert.ok(!JSON.stringify([paused, down]).includes(KEY));
  });

  test('round trip through sessions.message: the event carries ref, the inbox shows it, the reply threads under it', async () => {
    await mkdir(path.join(STATE, 'bots'), { recursive: true });
    await grok.setRoutine('alpha', { url: HOOK, key: KEY });
    const r = await api.dispatch('sessions.message', { id: 'grok:alpha', text: 'what is deployed on box-b?', actor: OWNER });
    assert.equal(r.ok, true);
    assert.equal(r.runUuid, 'run-123');
    const msg = (await wal()).find((e) => e.type === 'message');
    assert.equal(msg.ref, r.ref);
    assert.equal(msg.to.kind, 'grok');
    assert.equal(msg.to.id, 'grok:alpha');
    assert.equal(hits.at(-1).body.reply.arguments.messageId, r.ref, 'the webhook and the truth file agree on the id');

    grok._resetCache();
    let inbox = grok.inboxFrom(await grok.botEvents(), 'alpha');
    assert.deepEqual(inbox.map((m) => [m.messageId, m.answered, m.from]), [[r.ref, false, OWNER]]);
    await assert.rejects(grok.reply('alpha', { messageId: 'nope', text: 'x' }), /no message nope in your inbox/);
    await assert.rejects(grok.reply('bravo', { messageId: r.ref, text: 'x' }), /no message/, 'one bot cannot answer another\'s message');
    const chat = await grok.reply('alpha', { messageId: r.ref, text: 'webapp-api 277e809a7' });
    assert.equal(chat.inReplyTo, r.ref);
    assert.deepEqual(chat.to, msg.to, 'threads with the message in the folded truth file');
    assert.equal(chat.actor, 'grok:alpha');
    grok._resetCache();
    inbox = grok.inboxFrom(await grok.botEvents(), 'alpha');
    assert.equal(inbox[0].answered, true);
    const st = events.fold(await events.readAll(EVENTS));
    assert.equal(st.chats[`grok:${msg.to.host}:grok:alpha`].length, 2, 'message and reply in one thread');

    const t = await api.dispatch('sessions.transcript', { id: 'grok:alpha' });
    assert.deepEqual(t.turns.map((x) => x.role), ['user', 'assistant']);
    assert.equal((await api.dispatch('sessions.lastReply', { id: 'grok:alpha' })).text, 'webapp-api 277e809a7');
  });

  test('statuses put the bots on the board; only the host that keeps them claims them', async () => {
    assert.equal(grok.configured(), false);
    await grok.postStatus('bravo', { state: 'working', summary: 'resizing the data volume', task: 'disk' });
    // Not configured here, so this host claims no bots (sessionById and sessions.list both check configured() first;
    // past that a lookup reaches Codex, which a CI runner may not have installed).
    assert.equal(grok.configured(), false, 'another host keeps the bots');
    await mkdir(path.join(STATE, 'bots'), { recursive: true });
    assert.equal(grok.configured(), true);
    grok._resetCache();
    const list = await grok.listSessions({ host: 'box-a' });
    assert.deepEqual(list.map((s) => [s.id, s.status, s.state, s.summary, s.live, s.host]), [['grok:bravo', 'busy', 'working', 'resizing the data volume', true, 'box-a']]);
    await grok.postStatus('bravo', { state: grok.NEEDS_OWNER, summary: 'which region?' });
    grok._resetCache();
    assert.equal((await grok.listSessions()).find((s) => s.id === 'grok:bravo').status, 'waiting');
    await assert.rejects(grok.postStatus('bravo', { state: 'sleeping', summary: '' }), /state must be one of/);
    await assert.rejects(grok.postStatus('bravo', { state: 'idle', summary: 'x'.repeat(501) }), /at most 500/);
  });

  test('a message is delivered as written, whatever it names: there is no content filter', async () => {
    await mkdir(path.join(STATE, 'bots'), { recursive: true });
    await grok.setRoutine('alpha', { url: HOOK, key: KEY });
    const r = await api.dispatch('sessions.message', { id: 'grok:alpha', text: 'please review !4469 on staging (the billing broker)' });
    assert.equal(r.ok, true);
    assert.equal(hits.at(-1).body.text, 'please review !4469 on staging (the billing broker)', 'the Routine got the text as sent');
    assert.equal((await api.dispatch('sessions.message', { id: 'grok:*', text: 'staging deploy notes' })).queued, true);
    grok._resetCache();
    assert.deepEqual(grok.inboxFrom(await grok.botEvents(), 'alpha').map((m) => m.text), ['please review !4469 on staging (the billing broker)', 'staging deploy notes']);
    assert.equal(grok.unansweredCount(await grok.botEvents(), 'alpha'), 2);
  });

  describe('going stale', () => {
    const later = (minutes) => { grok._deps.now = () => Date.now() + minutes * 60_000; };
    const alpha = async () => { grok._resetCache(); return (await grok.listSessions()).find((s) => s.id === 'grok:alpha'); };
    beforeEach(async () => { grok._deps.now = () => Date.now(); await mkdir(path.join(STATE, 'bots'), { recursive: true }); await grok.setRoutine('alpha', { url: HOOK, key: KEY }); });
    after(() => { grok._deps.now = () => Date.now(); delete process.env.DROVER_BOTS_STALE_MINUTES; });

    test('a Routine makes a bot reachable, not live', async () => {
      const s = await alpha();
      assert.deepEqual([s.live, s.status, s.routine, s.stale], [false, 'idle', true, undefined]);
    });

    test('working with no word since: busy until the timeout, then stale and saying why', async () => {
      await grok.postStatus('alpha', { state: 'working', summary: 'deploying webapp-api' });
      later(29);
      assert.equal((await alpha()).status, 'busy');
      later(31);
      const s = await alpha();
      assert.deepEqual([s.status, s.live, s.state], ['stale', true, 'working'], 'stale, still on the board, its last state kept');
      assert.match(s.stale.reason, /^reported working 31 min ago \(deploying webapp-api\) and nothing since$/);
      later(0);
      await grok.postStatus('alpha', { state: 'done', summary: 'deployed' });
      later(600);
      assert.equal((await alpha()).status, 'idle', 'done never goes stale');
    });

    test('a message the Routine accepted (200) with no word from the bot since goes stale; any word from it clears that', async () => {
      const r = await api.dispatch('sessions.message', { id: 'grok:alpha', text: 'check the disk' });
      later(10);
      assert.deepEqual([(await alpha()).live, (await alpha()).status], [true, 'idle'], 'live: it was just sent a task');
      later(31);
      assert.match((await alpha()).stale.reason, /^its Routine accepted a message 31 min ago and nothing has come from Alpha since$/);
      later(0);
      await grok.reply('alpha', { messageId: r.ref, text: 'disk at 40%' });
      later(120);
      assert.equal((await alpha()).stale, undefined);
      answer = { status: 400, body: { success: false, error: 'paused' } };
      await assert.rejects(api.dispatch('sessions.message', { id: 'grok:alpha', text: 'again' }), /paused/);
      later(240);
      assert.equal((await alpha()).stale, undefined, 'a refused delivery started no run to wait for');
    });

    test('waiting on the owner never goes stale', async () => {
      await grok.postStatus('alpha', { state: grok.NEEDS_OWNER, summary: 'which region?' });
      later(600);
      assert.equal((await alpha()).status, 'waiting');
    });

    test('DROVER_BOTS_STALE_MINUTES sets the timeout; nonsense falls back to 30 minutes', async () => {
      assert.equal(grok.staleMs({}), 30 * 60_000);
      assert.equal(grok.staleMs({ DROVER_BOTS_STALE_MINUTES: '5' }), 5 * 60_000);
      for (const v of ['0', '-3', 'soon', '']) assert.equal(grok.staleMs({ DROVER_BOTS_STALE_MINUTES: v }), 30 * 60_000, JSON.stringify(v));
      process.env.DROVER_BOTS_STALE_MINUTES = '5';
      await grok.postStatus('alpha', { state: 'working', summary: 'x' });
      later(6);
      assert.equal((await alpha()).status, 'stale');
    });
  });

  test('the inbox pages oldest first; transcripts continue after the turns returned', async () => {
    await mkdir(path.join(STATE, 'bots'), { recursive: true });
    for (let i = 1; i <= 25; i++) await api.dispatch('sessions.message', { id: 'grok:bravo', text: `task ${i}` });
    grok._resetCache();
    const evs = await grok.botEvents();
    const first = grok.inboxFrom(evs, 'bravo');
    assert.deepEqual([first.length, first[0].text, first.at(-1).text], [20, 'task 1', 'task 20']);
    const next = grok.inboxFrom(evs, 'bravo', { since: first.at(-1).messageId });
    assert.deepEqual(next.map((m) => m.text), ['task 21', 'task 22', 'task 23', 'task 24', 'task 25']);
    assert.equal(grok.unansweredCount(evs, 'bravo'), 25);
    const page = await grok.transcript('grok:bravo', { limit: 10 });
    assert.deepEqual([page.turns.length, page.offset], [10, 10]);
    const rest = await grok.transcript('grok:bravo', { since: page.offset, limit: 100 });
    assert.deepEqual([rest.turns.length, rest.offset, rest.turns[0].text], [15, 25, 'task 11']);
  });

  test('what a bot wrote stays marked where agents read it: its events, its transcript turns, its last reply', async () => {
    await mkdir(path.join(STATE, 'bots'), { recursive: true });
    const r = await api.dispatch('sessions.message', { id: 'grok:bravo', text: 'status?' });
    await grok.postStatus('bravo', { state: 'working', summary: 'checking' });
    await grok.reply('bravo', { messageId: r.ref, text: 'all fine' });
    grok._resetCache();
    const t = await api.dispatch('sessions.transcript', { id: 'grok:bravo' });
    assert.deepEqual(t.turns.map((x) => [x.role, x.untrusted ?? false, x.source ?? null]), [['user', false, null], ['system', true, 'grok:bravo'], ['assistant', true, 'grok:bravo']], 'the owner\'s message is not marked; the bot\'s turns are');
    const last = await api.dispatch('sessions.lastReply', { id: 'grok:bravo' });
    assert.deepEqual([last.text, last.source, last.untrusted], ['all fine', 'grok:bravo', true]);
    const mine = (await wal()).filter((e) => e.actor === 'grok:bravo');
    assert.equal(mine.length, 2);
    assert.ok(mine.every((e) => e.source === 'grok:bravo' && e.untrusted === true), 'every event the bot caused carries provenance');
  });

  test('a feature a bot wrote to stays marked in the fold, with every bot that did; trusted writes mark nothing', async () => {
    await api.dispatch('features.upsert', { fid: 'f1', repo: 'webapp', title: 'by the owner' });
    assert.equal(events.fold(await events.readAll(EVENTS)).features[0].untrusted, undefined);
    await api.dispatch('features.upsert', { fid: 'f1', state: 'shipped', source: 'grok:alpha', untrusted: true, actor: 'grok:alpha' });
    await api.dispatch('features.upsert', { fid: 'f1', notes: 'the owner again' });
    await api.dispatch('features.upsert', { fid: 'f1', notes: 'bravo too', source: 'grok:bravo', untrusted: true, actor: 'grok:bravo' });
    await api.dispatch('features.upsert', { fid: 'f2', repo: 'webapp', title: 'plain', source: 'grok:alpha', untrusted: 'yes' });
    const st = events.fold(await events.readAll(EVENTS));
    const f1 = st.features.find((f) => f.fid === 'f1'), f2 = st.features.find((f) => f.fid === 'f2');
    assert.deepEqual([f1.state, f1.untrusted, f1.untrustedBy], ['shipped', true, ['grok:alpha', 'grok:bravo']]);
    assert.deepEqual([f2.untrusted, (await wal()).at(-1).source], [undefined, undefined], 'only untrusted: true marks, and source rides with it');
  });

  test('a status event with an inherited name as its state reads as idle, never as an object', async () => {
    await mkdir(path.join(STATE, 'bots'), { recursive: true });
    for (const state of ['__proto__', 'toString', 'constructor']) {
      await events.append({ type: 'status', agent: 'grok:bravo', state, summary: 'x' }, { actor: 'grok:bravo' });
      grok._resetCache();
      assert.equal((await grok.listSessions()).find((s) => s.id === 'grok:bravo').status, 'idle', state);
    }
  });

  test('the connection test is recorded, so the bot\'s "connected" reply threads under it', async () => {
    await grok.setRoutine('alpha', { url: HOOK, key: KEY });
    const r = await grok.sendTest('alpha');
    assert.equal(r.ok, true);
    assert.equal(hits.at(-1).body.type, 'drover.test');
    grok._resetCache();
    const chat = await grok.reply('alpha', { messageId: r.ref, text: 'connected' });
    assert.equal(chat.inReplyTo, r.ref);
  });

  test('a bot reply raises a "finished" alert named for the bot', async () => {
    const a = alertFromEvent({ id: 'e1', ts: 't', type: 'chat', actor: 'grok:alpha', from: 'grok:alpha', to: { kind: 'grok', id: 'grok:alpha', name: 'Alpha' }, text: 'done: deployed', host: 'box-a' });
    assert.equal(a.category, 'finished');
    assert.equal(a.title, 'Alpha replied');
    assert.equal(a.sessionId, 'grok:alpha');
    assert.equal(a.engine, 'grok');
    assert.equal(alertFromEvent({ type: 'chat', actor: OWNER, text: 'x' }), null);
    assert.equal(alertFromEvent({ type: 'notify', source: 'bots', message: 'x' }), null, 'bot-auth alerts are emitted directly, never twice');
  });

  test('the routine instruction tells the bot what to do with the untrusted body', () => {
    assert.match(grok.ROUTINE_PROMPT, /drover\.message/);
    assert.match(grok.ROUTINE_PROMPT, /reply\.arguments/);
    assert.match(grok.ROUTINE_PROMPT, /Never create another routine/);
  });
});
