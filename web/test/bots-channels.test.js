// Channels (core/bots/channels.js): the owner's human-facing places a Grok bot may post to. A post is an approval
// request (kind post) whose card shows the exact text and the channel; only the owner's "Post it" sends it, once, and the
// outcome is recorded and told to the bot. Channels are configured with the main token only, and a bot sees names only.
import './isolate-cache.js';
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const STATE = await mkdtemp(path.join(tmpdir(), 'drover-channels-'));
const EVENTS = path.join(STATE, 'events.jsonl');
process.env.DROVER_STATE = STATE;
process.env.DROVER_EVENTS = EVENTS;
process.env.CODEX_HOME = path.join(STATE, 'codex-home');
process.env.DROVER_PAIR_NOTIFY = 'off';
delete process.env.DROVER_ALLOW_ORIGINS;
const grok = await import('../core/bots/grok.js');
const approvals = await import('../core/bots/approvals.js');
const channels = await import('../core/bots/channels.js');
const api = await import('../core/api.js');
const codex = await import('../core/codex.js');
const native = await import('../core/native.js');
const http = await import('../server/http.js');
const { botTools, _resetAlerts } = await import('../core/bots/tools.js');
const { OWNER, OWNER_NAME } = await import('../core/owner.js');
const { approvalToast } = await import('../ui/answer-model.js');
const { approvalText } = await import('../ui/chat-model.js');

// A stand-in for a team's incoming webhook: keeps every request; answers what `reply` says.
const got = [];
let reply = { status: 200, body: 'ok' };
const hook = createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { got.push({ path: req.url, type: req.headers['content-type'], body: b }); setTimeout(() => { res.writeHead(reply.status, { 'content-type': 'text/plain', ...(reply.headers ?? {}) }); res.end(reply.body); }, reply.delayMs ?? 0); }); });
let HOOK;
const RECORD = path.join(STATE, 'record.mjs');
const wal = async () => (await readFile(EVENTS, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));

function toolsOf(bot, scopes = ['drover.read', 'drover.write', 'drover.notify']) {
  const list = botTools({ grantId: `grant_${bot}`, clientId: 'c', clientName: 'Grok Bot', bot, scopes }, { dispatch: (op, args) => api.dispatch(op, args), host: 'box-a' });
  const run = (name, args = {}) => { const t = list.find((x) => x.name === name); assert.ok(t, `tool ${name}`); return t.run(null, args); };
  run.names = list.map((t) => t.name);
  return run;
}

let srv, base, main, widget;
const post = (p, body, { auth = main } = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body) });
const answer = async (id, choice) => { const r = await post('/api/approvals/answer', { id, choice, via: 'test' }); return { status: r.status, body: await r.json() }; };

describe('channels: a bot posts where the owner is, every post approved', () => {
  before(async () => {
    await new Promise((r) => hook.listen(0, '127.0.0.1', r));
    HOOK = `http://127.0.0.1:${hook.address().port}/services/T000/B000/secretsecret`;
    await writeFile(RECORD, "import { writeFileSync, readFileSync } from 'node:fs';\nlet stdin = ''; try { stdin = readFileSync(0, 'utf8'); } catch {}\nwriteFileSync(process.argv[2], JSON.stringify({ argv: process.argv.slice(3), stdin }));\n");
    native._deps.isDaemon = () => false;
    srv = await http.startServer({ port: 0 });
    base = srv.url.replace(/\/$/, '');
    main = srv.token;
    widget = (await readFile(path.join(STATE, 'widget-token'), 'utf8')).trim();
  });
  after(async () => {
    codex.stopReadClient(); codex.sharedClient().stop();
    await new Promise((r) => { srv?.server.close(r); srv?.server.closeAllConnections?.(); });
    await new Promise((r) => hook.close(r));
  });
  beforeEach(async () => {
    await writeFile(EVENTS, '');
    await rm(path.join(STATE, 'bots'), { recursive: true, force: true });
    await mkdir(path.join(STATE, 'bots'), { recursive: true });
    grok._resetCache(); approvals._reset(); _resetAlerts();
    got.length = 0; reply = { status: 200, body: 'ok' };
  });

  test('the owner configures channels through main-token routes; what is shown never leads anywhere', async () => {
    assert.equal((await post('/api/bots/channels/add', { name: 'team', kind: 'webhook', url: HOOK, format: 'slack' }, { auth: null })).status, 401);
    assert.equal((await post('/api/bots/channels/add', { name: 'team', kind: 'webhook', url: HOOK, format: 'slack' }, { auth: widget })).status, 403);
    const r = await (await post('/api/bots/channels/add', { name: 'team', kind: 'webhook', url: HOOK, format: 'slack', title: 'Team Slack' })).json();
    assert.equal(r.ok, true);
    assert.deepEqual([r.result.name, r.result.kind, r.result.format, r.result.title], ['team', 'webhook', 'slack', 'Team Slack']);
    assert.match(r.result.target, /^127\.0\.0\.1:\d+ …secret$/, 'host and the id tail only');
    await post('/api/bots/channels/add', { name: 'cole-brett', kind: 'command', argv: [process.execPath, RECORD, path.join(STATE, 'out.json'), '--text', '{text}'], title: 'Cole and Brett', bots: ['alpha'] });
    const list = await (await fetch(`${base}/api/bots/channels`, { headers: { authorization: `Bearer ${main}` } })).json();
    const shown = JSON.stringify(list.result);
    assert.ok(!shown.includes('secretsecret') && !shown.includes(RECORD) && !shown.includes('/services/'), 'no URL path, no argument');
    assert.deepEqual(list.result.map((c) => [c.name, c.kind, c.bots]), [['cole-brett', 'command', ['alpha']], ['team', 'webhook', null]]);
    assert.equal((await fetch(`${base}/api/bots/channels`, { headers: { authorization: `Bearer ${widget}` } })).status, 403);
    // Not ops: no MCP tool or ssh rpc can add, test or remove one.
    assert.deepEqual(api.OPS.filter((op) => /channel/.test(op) && !op.startsWith('channel.')), []);
    assert.equal((await post('/api/op/channels.add', { name: 'x' })).status, 400, 'unknown op');
    const mode = (await import('node:fs')).statSync(path.join(STATE, 'bots', 'channels.json')).mode & 0o777;
    assert.equal(mode, 0o600);
    assert.equal((await post('/api/bots/channels/remove', { name: 'team' })).status, 200);
    assert.equal((await post('/api/bots/channels/remove', { name: 'team' })).status, 404);
  });

  test('bad channels are refused with what to fix', async () => {
    const bad = async (spec, re) => assert.match((await (await post('/api/bots/channels/add', spec)).json()).error, re);
    await bad({ name: 'Team!', kind: 'webhook', url: HOOK }, /lowercase letters/);
    await bad({ name: 'team', kind: 'email' }, /kind must be/);
    await bad({ name: 'team', kind: 'webhook', url: 'http://example.com/hook' }, /https URL/);
    await bad({ name: 'team', kind: 'webhook', url: 'https://user:pw@example.com/hook' }, /no user or password/);
    await bad({ name: 'team', kind: 'webhook', url: HOOK, format: 'xml' }, /format must be one of/);
    await bad({ name: 'team', kind: 'command', argv: [] }, /argv/);
    await bad({ name: 'team', kind: 'command', argv: ['{text}'] }, /the program \(argv\[0\]\) cannot be the text/);
    // The post is one whole argument or a long option's value, once: never inside code.
    await bad({ name: 'team', kind: 'command', argv: ['osascript', '-e', 'tell application "Messages" to send "{text}" to chat id "x"'] }, /\{text\} must be a whole argument/);
    await bad({ name: 'team', kind: 'command', argv: ['node', '-e', "post('{text}')"] }, /\{text\} must be a whole argument/);
    await bad({ name: 'team', kind: 'command', argv: ['imsg', '{text}', '--also', '{text}'] }, /appear once/);
    await bad({ name: 'team', kind: 'command', argv: ['imsg', '-t={text}'] }, /\{text\} must be a whole argument/);
    await bad({ name: 'team', kind: 'command', argv: ['imsg', 'x'.repeat(401)] }, /argv/);
    await bad({ name: 'team', kind: 'command', argv: ['imsg'], bots: ['Not A Bot!'] }, /bots must be Grok bot names/);
    assert.deepEqual(await channels.list(), []);
  });

  test('a bot sees the channels it may use, by name and title only, and posts there only through an approval', async () => {
    await channels.setChannel('team', { kind: 'webhook', url: HOOK, format: 'slack', title: 'Team Slack' });
    await channels.setChannel('cole-brett', { kind: 'command', argv: [process.execPath, RECORD, path.join(STATE, 'out.json'), '--text', '{text}'], title: 'Cole and Brett', bots: ['beta'] });
    const alpha = toolsOf('alpha');
    assert.ok(alpha.names.includes('drover_post'));
    const who = await alpha('drover_whoami');
    assert.deepEqual(who.channels, [{ name: 'team', title: 'Team Slack' }], 'only the channels that allow alpha');
    assert.ok(!JSON.stringify(who).includes('secretsecret') && !JSON.stringify(who).includes(RECORD));
    await assert.rejects(alpha('drover_post', { channel: 'cole-brett', text: 'hi' }), /no channel cole-brett for you/);
    await assert.rejects(alpha('drover_post', { channel: 'nope', text: 'hi' }), /no channel nope for you/);
    await assert.rejects(alpha('drover_post', { channel: 'team', text: '' }), /text is required/);
    await assert.rejects(alpha('drover_post', { channel: 'team', text: 'x'.repeat(channels.TEXT_MAX + 1) }), /at most 1800/);
    assert.ok(!toolsOf('alpha', ['drover.read', 'drover.write']).names.includes('drover_post'), 'posting needs drover.notify');

    const r = await alpha('drover_post', { channel: 'team', text: 'The nightly build is green again.' });
    assert.equal(r.created, true);
    assert.equal(r.text, `Alpha (${channels.ownerWord}'s bot): The nightly build is green again.`, 'behind the bot\'s name');
    assert.equal(got.length, 0, 'nothing is sent before the owner answers');
    const x = await approvals.get(r.approvalId);
    const rev = JSON.parse(await readFile(path.join(STATE, 'bots', 'channels.json'), 'utf8')).channels.team.rev;
    assert.match(rev, /^[0-9a-f]{12}$/);
    assert.deepEqual([x.kind, x.options.map((o) => o.label), x.action, x.details], ['post', ['Post it', 'Do not post'], { type: 'post', channel: 'team', rev }, r.text], 'bound to the channel as the card showed it');
    assert.equal(x.question, `Post to Team Slack (team): "${r.text}"`, 'the title and the name that tells channels apart');
    const [ev] = (await wal()).filter((e) => e.type === 'approval');
    assert.deepEqual(ev.action, { type: 'post', channel: 'team' });
    // The same post again is the same request.
    assert.equal((await alpha('drover_post', { channel: 'team', text: 'The nightly build is green again.' })).approvalId, r.approvalId);
    // Only drover_post makes a post: a request of the bot's own that says post would read "Asks to post" and post nothing.
    await assert.rejects(alpha('drover_request_approval', { question: 'Post this to the team?', kind: 'post' }), /kind post is for drover_post/);
    const kinds = botTools({ grantId: 'g', clientId: 'c', clientName: 'Grok Bot', bot: 'alpha', scopes: ['drover.notify'] }, { dispatch: async () => ({}) }).find((t) => t.name === 'drover_request_approval').inputSchema.properties.kind.enum;
    assert.deepEqual(kinds, ['purchase', 'action', 'other']);
  });

  test('"Post it" sends exactly the approved text once, records the outcome and tells the bot', async () => {
    await channels.setChannel('team', { kind: 'webhook', url: HOOK, format: 'slack', title: 'Team Slack' });
    const alpha = toolsOf('alpha');
    const { approvalId: id } = await alpha('drover_post', { channel: 'team', text: 'Deploy <!channel> & ship it > now' });
    const [a, b] = await Promise.all([answer(id, 1), answer(id, 1)]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409], 'decided once');
    assert.equal(got.length, 1, 'posted once');
    assert.deepEqual(JSON.parse(got[0].body), { text: `Alpha (${channels.ownerWord}'s bot): Deploy &lt;!channel&gt; &amp; ship it &gt; now` }, 'Slack mentions escaped');
    const ok = a.status === 200 ? a : b;
    assert.deepEqual([ok.body.result.outcome.ok, ok.body.result.outcome.done], [true, 'posted to team']);
    const decided = (await wal()).find((e) => e.type === 'approval' && e.state === 'decided');
    assert.deepEqual(decided.outcome, { ok: true });
    const shown = await alpha('drover_approvals', { action: 'show', id });
    assert.deepEqual([shown.approval.outcome.ok, shown.approval.action], [true, { type: 'post', channel: 'team' }]);
    const told = (await alpha('drover_inbox')).messages.at(-1);
    assert.match(told.text, /Drover did what it asked: posted to team\./);
    assert.match(approvalText(decided), /; done$/);
  });

  test('"Do not post" sends nothing; a failing channel says why, never where it leads', async () => {
    await channels.setChannel('team', { kind: 'webhook', url: HOOK, format: 'discord' });
    const alpha = toolsOf('alpha');
    const { approvalId: no } = await alpha('drover_post', { channel: 'team', text: 'first' });
    const r = await answer(no, 2);
    assert.equal(r.body.result.outcome, undefined);
    assert.equal(got.length, 0);
    assert.match((await alpha('drover_inbox')).messages.at(-1).text, /Drover did nothing for it, as answered\./);
    // The webhook's answer echoes the post: the channel's words, and the bot's, never in an owner record.
    reply = { status: 400, body: 'upstream exploded on: Alpha says @everyone second' };
    const { approvalId: fail } = await alpha('drover_post', { channel: 'team', text: '@everyone second' });
    const f = await answer(fail, 1);
    assert.equal(f.status, 200);
    assert.equal(f.body.result.outcome.ok, false);
    assert.equal(f.body.result.outcome.error, "the channel's webhook answered HTTP 400", 'Drover\'s words only');
    const owners = JSON.stringify((await wal()).filter((e) => e.actor === OWNER));
    assert.ok(!owners.includes('upstream exploded') && !owners.includes('secretsecret'), 'nothing the channel said is recorded as the owner\'s');
    assert.ok(!JSON.stringify((await alpha('drover_approvals', { action: 'show', id: fail })).approval).includes('upstream exploded'));
    assert.deepEqual(JSON.parse(got[0].body).allowed_mentions, { parse: [] }, 'Discord pings no one');
    assert.match((await alpha('drover_inbox')).messages.at(-1).text, /Drover could not do what it asked: the channel's webhook answered HTTP 400/);
    const [text, kind] = approvalToast('Alpha', f.body.result);
    assert.equal(kind, 'error');
    assert.match(text, /Post it, but Drover could not do it/);
  });

  test('a command channel runs its argv with the text as one argument, or on stdin; failures say why', async () => {
    const out = path.join(STATE, 'out.json');
    await channels.setChannel('cole-brett', { kind: 'command', argv: [process.execPath, RECORD, out, '--text', '{text}'], title: 'Cole and Brett' });
    await channels.setChannel('stdin', { kind: 'command', argv: [process.execPath, RECORD, out] });
    await channels.setChannel('broken', { kind: 'command', argv: [process.execPath, '-e', 'process.stderr.write("chat not found"); process.exit(3)'] });
    await channels.setChannel('gone', { kind: 'command', argv: ['/nonexistent/imsg', 'send'] });
    const alpha = toolsOf('alpha');
    const tricky = 'a "quoted" $(touch /tmp/pwned) `x` ; rm -rf ~';
    const { approvalId: id } = await alpha('drover_post', { channel: 'cole-brett', text: tricky });
    assert.equal((await answer(id, 1)).body.result.outcome.ok, true);
    assert.deepEqual(JSON.parse(await readFile(out, 'utf8')), { argv: ['--text', `Alpha (${channels.ownerWord}'s bot): ${tricky}`], stdin: '' }, 'one argument, no shell');
    const { approvalId: id2 } = await alpha('drover_post', { channel: 'stdin', text: 'line one\nline two' });
    await answer(id2, 1);
    assert.deepEqual(JSON.parse(await readFile(out, 'utf8')), { argv: [], stdin: `Alpha (${channels.ownerWord}'s bot): line one\nline two` });
    // It ran and failed: it may have sent before it did, so the outcome is unknown, never "not sent".
    const { approvalId: id3 } = await alpha('drover_post', { channel: 'broken', text: 'hi' });
    const o3 = (await answer(id3, 1)).body.result.outcome;
    assert.deepEqual([o3.ok, o3.unknown, o3.error], [null, true, `${path.basename(process.execPath)} exited 3`], 'the exit code, not what it printed');
    assert.ok(!JSON.stringify((await wal()).filter((e) => e.actor === OWNER)).includes('chat not found'));
    assert.match((await alpha('drover_inbox')).messages.at(-1).text, /Drover cannot tell whether it was done \(node exited 3\): it may have gone out, so do not ask for it again unless/);
    // The owner's own test shows what the program said.
    assert.deepEqual(await channels.test('broken'), { ok: null, unknown: true, error: `${path.basename(process.execPath)} exited 3`, detail: 'chat not found' });
    // It never started: nothing was sent.
    const { approvalId: id4 } = await alpha('drover_post', { channel: 'gone', text: 'hi' });
    const o4 = (await answer(id4, 1)).body.result.outcome;
    assert.deepEqual([o4.ok, o4.unknown, o4.error], [false, undefined, 'imsg is not installed here']);
    assert.match((await alpha('drover_inbox')).messages.at(-1).text, /Drover could not do what it asked: imsg is not installed here\. Nothing was done; ask again if it still matters\./);
  });

  test('a redirect is not followed, and an unreachable webhook says so in Drover\'s words', async () => {
    await channels.setChannel('team', { kind: 'webhook', url: HOOK, format: 'text' });
    const alpha = toolsOf('alpha');
    reply = { status: 307, headers: { location: '/elsewhere' }, body: '' };
    const { approvalId: id } = await alpha('drover_post', { channel: 'team', text: 'hello' });
    const r = await answer(id, 1);
    assert.equal(r.body.result.outcome.error, "the channel's webhook answered HTTP 307, a redirect Drover does not follow");
    assert.deepEqual(got.map((g) => g.path), ['/services/T000/B000/secretsecret'], 'posted where the owner set it up, nowhere else');
    // A port nobody listens on.
    const probe = createServer(); await new Promise((ok) => probe.listen(0, '127.0.0.1', ok));
    const closed = `http://127.0.0.1:${probe.address().port}/hook`; await new Promise((ok) => probe.close(ok));
    await channels.setChannel('dead', { kind: 'webhook', url: closed, format: 'text' });
    const { approvalId: id2 } = await alpha('drover_post', { channel: 'dead', text: 'hello' });
    assert.equal((await answer(id2, 1)).body.result.outcome.error, "the channel's webhook is unreachable (ECONNREFUSED)");
  });

  test('while a post is being sent it says running; one Drover never finished says unknown, never done', async () => {
    await channels.setChannel('team', { kind: 'webhook', url: HOOK, format: 'text' });
    const alpha = toolsOf('alpha');
    reply = { status: 200, body: 'ok', delayMs: 400 };
    const { approvalId: id } = await alpha('drover_post', { channel: 'team', text: 'slow news' });
    const answering = answer(id, 1);
    while (!got.length) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual((await alpha('drover_approvals', { action: 'show', id })).approval.outcome, { ok: null, running: true }, 'the webhook has it, the answer is not back');
    assert.equal((await answering).body.result.outcome.ok, true);
    assert.equal((await alpha('drover_approvals', { action: 'show', id })).approval.outcome.ok, true);
    // Drover stopped partway (a restart): no outcome was stored, and past the action's time it is unknown, not done.
    const x = { ...(await approvals.get(id)), outcome: undefined };
    assert.deepEqual(approvals.botView(x, Date.parse(x.decision.at) + approvals.ACTION_MS + 1).outcome, { ok: null, unknown: true });
    // A request without an action, or answered no, has no outcome at all.
    assert.equal(approvals.botView({ ...x, decision: { ...x.decision, n: 2 } }).outcome, undefined);
    assert.equal(approvals.botView({ ...x, action: undefined }).outcome, undefined);
  });

  test('a channel changed after the request (where it leads, its title) sends nothing', async () => {
    await channels.setChannel('team', { kind: 'webhook', url: HOOK, format: 'text', title: 'Team' });
    const alpha = toolsOf('alpha');
    const { approvalId: id } = await alpha('drover_post', { channel: 'team', text: 'hello' });
    // The owner points team elsewhere before answering: the card showed the old one.
    await channels.setChannel('team', { kind: 'webhook', url: `${HOOK}-other`, format: 'text', title: 'Team' });
    const r = await answer(id, 1);
    assert.deepEqual([r.body.result.outcome.ok, r.body.result.outcome.error], [false, 'the channel team was changed after the request (where it leads or its title), so nothing was sent there']);
    assert.equal(got.length, 0, 'sent nowhere');
    // A new title is a change too; a post asked for after the change goes.
    const { approvalId: id2 } = await alpha('drover_post', { channel: 'team', text: 'hello again' });
    await channels.setChannel('team', { kind: 'webhook', url: `${HOOK}-other`, format: 'text', title: 'Team (old)' });
    assert.equal((await answer(id2, 1)).body.result.outcome.ok, false);
    const { approvalId: id3 } = await alpha('drover_post', { channel: 'team', text: 'third time' });
    assert.equal((await answer(id3, 1)).body.result.outcome.ok, true);
    assert.deepEqual(got.map((g) => g.path), ['/services/T000/B000/secretsecret-other']);
  });

  test('what a webhook answers decides: 2xx posted; 202, 302, 303, 408 and 5xx unknown; other 4xx and redirects not posted', async () => {
    await channels.setChannel('team', { kind: 'webhook', url: HOOK, format: 'text' });
    const alpha = toolsOf('alpha');
    // Each post counts against the bot's alert budget (12 an hour), which is not what this test is about.
    const outcomeFor = async (status, text) => { _resetAlerts(); reply = { status, body: '' }; const { approvalId } = await alpha('drover_post', { channel: 'team', text }); return (await answer(approvalId, 1)).body.result.outcome; };
    for (const [status, ok] of [[200, true], [201, true], [204, true], [202, null], [408, null], [500, null], [502, null], [503, null], [504, null], [400, false], [404, false], [410, false], [429, false], [301, false], [302, null], [303, null], [307, false], [308, false]]) {
      const o = await outcomeFor(status, `status ${status}`);
      assert.equal(o.ok, ok, `HTTP ${status}`);
      assert.equal(Boolean(o.unknown), ok === null, `HTTP ${status} unknown`);
    }
    const o = await outcomeFor(502, 'once more');
    assert.equal(o.error, "the channel's webhook answered HTTP 502");
    assert.match((await alpha('drover_inbox')).messages.at(-1).text, /Drover cannot tell whether it was done \(the channel's webhook answered HTTP 502\): it may have gone out/);
    // A 303 points at the result of a post the server took: never "nothing was done, ask again".
    const seeOther = await outcomeFor(303, 'and then a result page');
    assert.equal(seeOther.error, "the channel's webhook answered HTTP 303, a redirect Drover does not follow");
    assert.doesNotMatch((await alpha('drover_inbox')).messages.at(-1).text, /ask again/);
  });

  test('a long option takes the post as its value', async () => {
    const out = path.join(STATE, 'out.json');
    await channels.setChannel('opt', { kind: 'command', argv: [process.execPath, RECORD, out, '--text={text}'] });
    const alpha = toolsOf('alpha');
    const { approvalId: id } = await alpha('drover_post', { channel: 'opt', text: 'a $1 & $& "x"' });
    assert.equal((await answer(id, 1)).body.result.outcome.ok, true);
    assert.deepEqual(JSON.parse(await readFile(out, 'utf8')).argv, [`--text=Alpha (${channels.ownerWord}'s bot): a $1 & $& "x"`], 'the text as is: no replacement patterns, one argument');
  });

  test('a webhook that does not answer in time, or drops the connection, may have posted: unknown', async () => {
    await channels.setChannel('team', { kind: 'webhook', url: HOOK, format: 'text' });
    const alpha = toolsOf('alpha');
    const real = channels._deps.timeoutMs;
    channels._deps.timeoutMs = 150;
    reply = { status: 200, body: 'ok', delayMs: 600 };
    try {
      const { approvalId: id } = await alpha('drover_post', { channel: 'team', text: 'slow hook' });
      const r = await answer(id, 1);
      assert.deepEqual(r.body.result.outcome, { ok: null, at: r.body.result.outcome.at, unknown: true, error: "the channel's webhook did not answer in time" });
      assert.equal(got.length, 1, 'the webhook did get it: that is why it is not "not sent"');
      const decided = (await wal()).find((e) => e.type === 'approval' && e.state === 'decided' && e.aid === id);
      assert.deepEqual(decided.outcome, { ok: null, unknown: true, error: "the channel's webhook did not answer in time" });
      assert.match((await alpha('drover_inbox')).messages.at(-1).text, /Drover cannot tell whether it was done/);
      assert.equal((await alpha('drover_approvals', { action: 'show', id })).approval.outcome.unknown, true);
      const [text, kind] = approvalToast('Alpha', r.body.result);
      assert.deepEqual([kind, /cannot tell whether it went out/.test(text)], ['error', true]);
      assert.match(approvalText(decided), /; not known whether done: /);
    } finally { channels._deps.timeoutMs = real; }
    // A connection that breaks once the request is out (the server hangs up on it): unknown too.
    const rude = createServer((req) => req.socket.destroy()); await new Promise((ok) => rude.listen(0, '127.0.0.1', ok));
    await channels.setChannel('rude', { kind: 'webhook', url: `http://127.0.0.1:${rude.address().port}/hook`, format: 'text' });
    const { approvalId: id2 } = await alpha('drover_post', { channel: 'rude', text: 'hello' });
    const o = (await answer(id2, 1)).body.result.outcome;
    await new Promise((ok) => rude.close(ok));
    assert.deepEqual([o.ok, o.unknown], [null, true]);
    assert.match(o.error, /^the connection to the channel's webhook broke \([A-Z_]+\)$/);
  });

  test('a command that runs too long may have posted: unknown', async () => {
    await channels.setChannel('slow', { kind: 'command', argv: [process.execPath, '-e', 'setTimeout(() => {}, 5000)'] });
    const alpha = toolsOf('alpha');
    const real = channels._deps.commandTimeoutMs;
    channels._deps.commandTimeoutMs = 200;
    try {
      const { approvalId: id } = await alpha('drover_post', { channel: 'slow', text: 'hello' });
      const o = (await answer(id, 1)).body.result.outcome;
      assert.deepEqual([o.ok, o.unknown, o.error], [null, true, `${path.basename(process.execPath)} timed out`]);
    } finally { channels._deps.commandTimeoutMs = real; }
  });

  test('Discord is asked to confirm the post was saved (wait=true)', async () => {
    await channels.setChannel('chat', { kind: 'webhook', url: HOOK, format: 'discord' });
    await channels.test('chat');
    assert.equal(got.at(-1).path, '/services/T000/B000/secretsecret?wait=true');
  });

  test('a channel removed, or no longer open to the bot, before the answer sends nothing', async () => {
    await channels.setChannel('team', { kind: 'webhook', url: HOOK, format: 'text' });
    const alpha = toolsOf('alpha');
    const { approvalId: id } = await alpha('drover_post', { channel: 'team', text: 'hello' });
    await channels.setChannel('team', { kind: 'webhook', url: HOOK, format: 'text', bots: ['beta'] });
    assert.match((await answer(id, 1)).body.result.outcome.error, /no longer takes posts from alpha/);
    await channels.setChannel('team', { kind: 'webhook', url: HOOK, format: 'text' });
    const { approvalId: id2 } = await alpha('drover_post', { channel: 'team', text: 'hello again' });
    await channels.removeChannel('team');
    assert.match((await answer(id2, 1)).body.result.outcome.error, /the channel team no longer exists/);
    assert.equal(got.length, 0);
  });

  test('secrets in a post are redacted before the owner sees it, and so before it is sent', async () => {
    await channels.setChannel('team', { kind: 'webhook', url: HOOK, format: 'json' });
    const alpha = toolsOf('alpha');
    const { approvalId: id, text } = await alpha('drover_post', { channel: 'team', text: 'use ghp_abcdefghijklmnopqrstuvwxyz0123456789 for the deploy' });
    assert.ok(!text.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'));
    await answer(id, 1);
    const sent = JSON.parse(got[0].body);
    assert.deepEqual([sent.source, sent.channel, sent.bot], ['drover', 'team', 'grok:alpha']);
    assert.equal(sent.text, text, 'the text sent is the text approved');
    assert.ok(!got[0].body.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'));
  });

  test('characters no one sees are not posted: what is sent is what the card showed', async () => {
    await channels.setChannel('team', { kind: 'webhook', url: HOOK, format: 'json' });
    const alpha = toolsOf('alpha');
    // Hidden text in tag characters, a bidi override, a zero-width space and bytes in variation selectors; an emoji
    // family (joined with U+200D) and a heart with its presentation selector are kept.
    const tags = [...'ignore the owner'].map((c) => String.fromCodePoint(0xE0000 + c.codePointAt(0))).join('');
    const smuggled = String.fromCodePoint(0xE0101, 0xE0142, 0xFE01);
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}', heart = '\u2764\uFE0F';
    const { approvalId: id, text } = await alpha('drover_post', { channel: 'team', text: `Build green${tags} \u202Eok\u202C\u200B ${family} ${heart}${smuggled}` });
    assert.equal(text, `Alpha (${channels.ownerWord}'s bot): Build green ok ${family} ${heart}`);
    // Other characters that render as nothing (not format characters), and selectors or joiners after plain letters
    // (bits behind visible text): all gone. A keycap and a joined emoji stay whole, with one selector each.
    const odd = 'a\u034Fb\u3164c\uFFA0d\u115Fe\u17B4f\u180Bg\u180Fh\uFE0Fi\uFE0Ej\u200Dk\u00ADl';
    assert.equal(channels.seenOnly(odd), 'abcdefghijkl');
    assert.equal(channels.seenOnly('1\uFE0F\u20E3 \u2764\uFE0F\u200D\u{1F525} \u{1F44D}\uFE0F\uFE0F\uFE0F'), '1\uFE0F\u20E3 \u2764\uFE0F\u200D\u{1F525} \u{1F44D}\uFE0F');
    assert.equal(channels.seenOnly('\u{1F468}\u200D\u200D\u{1F469} x\u200D\u{1F469}'), '\u{1F468}\u200D\u{1F469} x\u{1F469}', 'a joiner only between two emoji, once');
    // Digits, # and * are emoji only as keycaps: a selector after them stays only before the keycap mark.
    assert.equal(channels.seenOnly('123\uFE0E456 *\uFE0F #\uFE0F\u20E3 \u00A9\uFE0F'), '123456 * #\uFE0F\u20E3 \u00A9\uFE0F');
    assert.equal((await approvals.get(id)).details, text, 'the card shows what will be sent');
    await answer(id, 1);
    assert.equal(JSON.parse(got[0].body).text, text);
  });

  test('a test post checks a channel; the text format posts plain text', async () => {
    await channels.setChannel('team', { kind: 'webhook', url: HOOK, format: 'text' });
    const r = await (await post('/api/bots/channels/test', { name: 'team' })).json();
    assert.equal(r.result.ok, true);
    assert.match(got[0].type, /^text\/plain/);
    assert.match(got[0].body, /^Drover: a test post from .+\. This channel works\.$/);
    assert.equal((await post('/api/bots/channels/test', { name: 'nope' })).status, 404);
  });
});
