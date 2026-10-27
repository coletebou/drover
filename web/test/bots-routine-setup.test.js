// Routine setup with a pairing code (core/bots/routine-setup.js, its page on the bot gateway in server/botgate.js, the
// owner's routes in server/http.js, `drover bots routine`): the owner pastes a bot's routine webhook on the gateway's
// page and approves the code it shows in Drover. Nothing secret is kept on disk, shown, broadcast or recorded before
// that, and only the main token decides.
import './isolate-cache.js';
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = await mkdtemp(path.join(tmpdir(), 'drover-routine-setup-'));
const EVENTS = path.join(STATE, 'events.jsonl');
await writeFile(EVENTS, '');
const BASE = 'https://gw.test';
process.env.DROVER_STATE = STATE;
process.env.DROVER_EVENTS = EVENTS;
process.env.DROVER_PAIR_NOTIFY = 'off';
process.env.DROVER_BOTS_URL = BASE;
delete process.env.DROVER_ALLOW_ORIGINS;
const setup = await import('../core/bots/routine-setup.js');
const grok = await import('../core/bots/grok.js');
const api = await import('../core/api.js');
const codex = await import('../core/codex.js');
const native = await import('../core/native.js');
const http = await import('../server/http.js');
const { startBotGateway } = await import('../server/botgate.js');
const { botTools } = await import('../core/bots/tools.js');

// A stand-in for the routine's Grok Bot webhook: keeps what it was sent, and answers `answer` when a test sets one.
const hits = [];
let answer = null;
const hook = createServer((req, res) => {
  let raw = ''; req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    hits.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(raw || 'null') });
    const a = answer ?? { status: 200, body: '{"success":true,"runUuid":"run-7"}' };
    res.writeHead(a.status, { 'content-type': 'application/json' }); res.end(a.body);
  });
});
let HOOK, gw, gwUrl, srv, base, main, widget;
const URL_PATH = '/automations/webhook/wh-0123456789abcdef';
const KEY = 'crsr_0123456789abcdefSECRETKEY';
const seen = [];   // what the gateway hands the daemon for a sent setup (onRoutineSetup)
let address = 0;
const fresh = () => `198.51.100.${++address}`;
const page = (p, { from, ...init } = {}) => fetch(new URL(p, gwUrl), { redirect: 'manual', ...init, headers: { 'x-forwarded-for': from, ...(init.headers ?? {}) } });
const nonceOf = (html) => html.match(/name="nonce" value="([0-9a-f]{32})"/)?.[1];
async function send(bot, { from, url = `${HOOK}${URL_PATH}`, key = KEY, nonce, origin = BASE } = {}) {
  const n = nonce ?? nonceOf(await (await page(`/bots/${bot}/routine`, { from })).text());
  return page(`/bots/${bot}/routine`, { from, method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(origin ? { origin } : {}) }, body: new URLSearchParams({ url, key, nonce: n }).toString() });
}
const waitPath = (res) => { const l = new URL(res.headers.get('location')); assert.equal(l.origin, BASE, 'back to the public origin'); return `${l.pathname}${l.search}`; };
const owner = (route, body, { auth = main } = {}) => fetch(`${base}/api/bots/${route}`, body === undefined ? { headers: { authorization: `Bearer ${auth}` } } : { method: 'POST', headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const result = async (r) => { const j = await r.json(); assert.ok(j.ok, j.error); return j.result; };
const noSecret = (text, what) => { assert.ok(!text.includes(KEY), `${what}: no key`); assert.ok(!text.includes(URL_PATH) && !text.includes('wh-0123456789abcdef'), `${what}: no webhook URL`); };

describe('routine setup: the owner pastes a bot\'s webhook on the gateway page and approves its code in Drover', () => {
  before(async () => {
    await new Promise((r) => hook.listen(0, '127.0.0.1', r));
    HOOK = `http://127.0.0.1:${hook.address().port}`;
    gw = await startBotGateway({ base: BASE, port: 0, dispatch: async () => ({}), onRoutineSetup: (r) => seen.push(r) });
    gwUrl = gw.url;
    native._deps.isDaemon = () => false;
    srv = await http.startServer({ port: 0 });
    base = srv.url.replace(/\/$/, '');
    main = srv.token;
    widget = (await readFile(path.join(STATE, 'widget-token'), 'utf8')).trim();
  });
  after(async () => {
    codex.stopReadClient(); codex.sharedClient().stop();
    await new Promise((r) => { srv?.server.close(r); srv?.server.closeAllConnections?.(); });
    await new Promise((r) => { gw?.server.close(r); gw?.server.closeAllConnections?.(); });
    await new Promise((r) => hook.close(r));
  });
  beforeEach(async () => {
    setup._reset(); grok._resetCache();
    setup._deps.now = () => Date.now();
    await rm(path.join(STATE, 'bots'), { recursive: true, force: true });
    hits.length = 0; seen.length = 0; answer = null;
  });

  test('the page is a form that posts only to itself, with a nonce, and says nothing about the bot\'s routine', async () => {
    await grok.setRoutine('alpha', { url: 'https://hooks.example/automations/webhook/old-routine-id', key: 'crsr_old_key_123456' });
    const res = await page('/bots/alpha/routine', { from: fresh() });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy'), /form-action 'self'/);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const html = await res.text();
    assert.ok(nonceOf(html), 'a nonce');
    assert.match(html, /type="password"/);
    assert.ok(!html.includes('hooks.example') && !html.includes('old-routine'), 'nothing about the routine it has');
    // Every other page still posts nowhere.
    assert.match((await page('/bots/alpha/oauth/authorize/wait?rid=00', { from: fresh() })).headers.get('content-security-policy'), /form-action 'none'/);
    assert.equal((await page('/routine', { from: fresh() })).status, 404, 'a bot\'s page only');
    assert.equal((await page('/bots/Not_A_Bot/routine', { from: fresh() })).status, 404);
  });

  test('a setup waits for the owner\'s code; its URL and key are shown, broadcast and recorded nowhere', async () => {
    const from = fresh();
    const sent = await send('alpha', { from });
    assert.equal(sent.status, 303);
    noSecret(await sent.text(), 'the answer');
    const wait = waitPath(sent);
    assert.match(wait, /^\/bots\/alpha\/routine\/wait\?rid=[0-9a-f]{32}$/);
    assert.equal(seen.length, 1);
    assert.deepEqual(Object.keys(seen[0]).sort(), ['alert', 'bot', 'code', 'expiresAt']);
    assert.equal(seen[0].alert, true);
    const { code } = seen[0];
    const html = await (await page(wait, { from })).text();
    assert.ok(html.includes(`${code.slice(0, 3)} ${code.slice(3)}`) && html.includes(`drover bots routine approve ${code}`));
    noSecret(html, 'the waiting page');
    // The owner sees where it leads (host and id tail), from where, and that alpha has none to replace.
    const [p] = await result(await owner('routine/pending'));
    assert.deepEqual([p.code, p.bot, p.webhook, p.replaces], [code, 'alpha', { host: new URL(HOOK).host, webhook: '…abcdef' }, null]);
    assert.match(p.from, new RegExp(from.replaceAll('.', '\\.')));
    noSecret(JSON.stringify(p), 'the pending list');
    assert.equal((await owner('routine/pending', undefined, { auth: widget })).status, 403, 'the widget token decides nothing');
    assert.equal((await owner('routine/approve', { code }, { auth: widget })).status, 403);
    assert.deepEqual(api.OPS.filter((op) => /routine/i.test(op)), [], 'never an op');
    assert.deepEqual(await grok.routines(), [], 'nothing set before the owner says yes');
    noSecret(await readFile(EVENTS, 'utf8'), 'the truth file');
  });

  test('approving sets the routine, then sends its connection test; the page says so; a code decides once', async () => {
    await grok.setRoutine('alpha', { url: 'https://hooks.example/automations/webhook/old-routine-id', key: 'crsr_old_key_123456' });
    const from = fresh();
    const wait = waitPath(await send('alpha', { from }));
    const { code } = seen.at(-1);
    const [p] = await result(await owner('routine/pending'));
    assert.deepEqual(p.replaces, { host: 'hooks.example', webhook: '…ine-id' }, 'the owner sees it replaces one');
    const r = await result(await owner('routine/approve', { code: `${code.slice(0, 3)} ${code.slice(3)}` }));
    assert.deepEqual([r.bot, r.routine.host, r.routine.webhook, r.test.ok, r.test.runUuid], ['alpha', new URL(HOOK).host, '…abcdef', true, 'run-7']);
    assert.equal(hits.length, 1);
    assert.deepEqual([hits[0].path, hits[0].auth, hits[0].body.type], [URL_PATH, `Bearer ${KEY}`, 'drover.test'], 'the connection test, to the new webhook with its key');
    assert.deepEqual((await grok.routines()).map((x) => [x.bot, x.routine.host, x.routine.webhook]), [['alpha', new URL(HOOK).host, '…abcdef']]);
    const done = await (await page(wait, { from })).text();
    assert.match(done, /alpha's Drover routine is set/);
    assert.match(done, /sent it a connection test/);
    noSecret(done, 'the done page');
    assert.equal((await owner('routine/approve', { code })).status, 404, 'decided once');
    assert.deepEqual(await result(await owner('routine/pending')), []);
  });

  test('denying keeps nothing; a nonce is single use, bound to its address; another site cannot send the form', async () => {
    const from = fresh();
    const n = nonceOf(await (await page('/bots/alpha/routine', { from })).text());
    assert.equal((await send('alpha', { from, nonce: n })).status, 303);
    const again = await send('alpha', { from, nonce: n });
    assert.equal(again.status, 400);
    const html = await again.text();
    assert.match(html, /this form has expired: open the link again/);
    noSecret(html, 'a refused form');
    assert.ok(nonceOf(html), 'with a new form');
    const elsewhere = nonceOf(await (await page('/bots/alpha/routine', { from: fresh() })).text());
    assert.equal((await send('alpha', { from, nonce: elsewhere })).status, 400, 'a nonce from another address');
    const otherBot = nonceOf(await (await page('/bots/beta/routine', { from })).text());
    assert.equal((await send('alpha', { from, nonce: otherBot })).status, 400, 'a nonce for another bot');
    assert.equal((await send('alpha', { from: fresh(), origin: 'https://evil.example' })).status, 403, 'a form from another site');
    // Denied: the page says so, nothing changed, nothing kept.
    const wait = waitPath(await send('beta', { from: fresh() }));
    const { code } = seen.at(-1);
    assert.deepEqual(await result(await owner('routine/deny', { code })), { bot: 'beta', denied: true });
    assert.match(await (await page(wait, { from })).text(), /Not set/);
    assert.deepEqual(await grok.routines(), []);
  });

  test('values that are not a routine webhook are refused in Drover\'s words, and never repeated', async () => {
    for (const [values, why] of [[{ url: 'http://hooks.example/automations/webhook/x' }, /must be the https address/], [{ url: 'not a url' }, /must be the https address/], [{ key: 'short' }, /Webhook key must be/], [{ key: 'two words here' }, /Webhook key must be/]]) {
      const res = await send('alpha', { from: fresh(), ...values });
      assert.equal(res.status, 400);
      const html = await res.text();
      assert.match(html, why);
      for (const v of Object.values(values)) assert.ok(!html.includes(v.replaceAll('&', '&amp;')), 'never repeated');
    }
    assert.equal(seen.length, 0);
  });

  test('limits: the same address again replaces its setup, three wait from one address, a setup expires in ten minutes', async () => {
    const from = fresh();
    const first = waitPath(await send('alpha', { from }));
    const second = waitPath(await send('alpha', { from }));
    assert.equal((await page(first, { from })).status, 410, 'the earlier one reads as expired');
    assert.equal((await page(second, { from })).status, 200);
    assert.equal((await result(await owner('routine/pending'))).length, 1);
    assert.equal(seen.filter((x) => x.alert).length, 1, 'a replacement raises no second alert');
    assert.equal((await send('beta', { from })).status, 303);
    assert.equal((await send('gamma', { from })).status, 303);
    const fourth = await send('delta', { from });
    assert.equal(fourth.status, 429);
    assert.match(await fourth.text(), /too many setups are already waiting from your address/);
    setup._deps.now = () => Date.now() + 11 * 60_000;
    assert.deepEqual(await result(await owner('routine/pending')), []);
    assert.equal((await page(second, { from })).status, 410);
  });

  test('opening the page again and again drops only that address\'s own oldest forms, never another\'s', async () => {
    const mine = fresh();
    const kept = nonceOf(await (await page('/bots/alpha/routine', { from: mine })).text());
    // A stranger opens more pages than its limit: only its own oldest form goes.
    const stranger = fresh();
    const theirs = [];
    for (let i = 0; i <= setup.MAX_NONCES_PER_SOURCE; i++) theirs.push(nonceOf(await (await page('/bots/alpha/routine', { from: stranger })).text()));
    assert.equal((await send('alpha', { from: stranger, nonce: theirs[0] })).status, 400, 'its oldest went');
    assert.equal((await send('alpha', { from: stranger, nonce: theirs.at(-1) })).status, 303, 'its newest still works');
    for (let i = 0; i < 2 * setup.MAX_NONCES; i++) setup.formNonce('alpha', { source: stranger });
    // Many addresses fill the forms open in all: a new page waits, and no form already open goes for it.
    let refused = null;
    for (let i = 0; i < setup.MAX_NONCES && !refused; i++) { try { setup.formNonce('alpha', { source: `192.0.2.${i}` }); } catch (e) { refused = e; } }
    assert.equal(refused?.status, 429);
    const full = await page('/bots/alpha/routine', { from: fresh() });
    assert.equal(full.status, 429);
    assert.match(await full.text(), /too many setup pages are open right now/);
    // A refused form at the limit says so too, never a server error.
    assert.equal((await send('alpha', { from: fresh(), nonce: 'f'.repeat(32) })).status, 429);
    assert.equal((await send('alpha', { from: mine, nonce: kept })).status, 303, 'the form opened first still works');
  });

  test('what the webhook answers to the connection test is kept and shown without its key, URL or id, whatever it echoes', async () => {
    const from = fresh();
    // A refusal that echoes the key and the URL it was sent to, with a terminal escape (clear the screen) in it.
    answer = { status: 401, body: JSON.stringify({ error: `bad key ${KEY}\u001b[2J for ${HOOK}${URL_PATH} (webhook wh-0123456789abcdef)` }) };
    let wait = waitPath(await send('alpha', { from }));
    let r = await result(await owner('routine/approve', { code: seen.at(-1).code }));
    assert.equal(r.test.ok, false);
    assert.match(r.test.error, /^the Routine key was refused.*\(bad key \[redacted\] \[2J for \[redacted\] \(webhook \[redacted\]\)\)$/, 'what it said, less what it echoed');
    assert.ok(!/[\u0000-\u001f]/.test(r.test.error), 'no control character reaches a terminal');
    noSecret(JSON.stringify(r), 'the owner\'s answer');
    assert.match(await (await page(wait, { from })).text(), /could not send it a connection test \(the key was refused\)/);
    // A run started, with a run id that is the key.
    answer = { status: 200, body: JSON.stringify({ success: true, runUuid: KEY }) };
    wait = waitPath(await send('alpha', { from }));
    r = await result(await owner('routine/approve', { code: seen.at(-1).code }));
    assert.deepEqual([r.test.ok, r.test.runUuid], [true, undefined], 'no run id rather than the key');
    noSecret(await readFile(EVENTS, 'utf8'), 'the truth file, where each test is recorded');
  });

  test('a setup approved as it expires reads as being set, then set, never as expired, while its test is out', async () => {
    const from = fresh();
    const wait = waitPath(await send('alpha', { from }));
    const { code } = seen.at(-1);
    // The connection test takes a while, and the setup's ten minutes run out meanwhile.
    const realTest = setup._deps.sendTest;
    let reached, release;
    const at = new Promise((r) => { reached = r; }), slow = new Promise((r) => { release = r; });
    setup._deps.sendTest = async (bot) => { reached(); await slow; return realTest(bot); };
    try {
      const approving = owner('routine/approve', { code });
      await at;
      setup._deps.now = () => Date.now() + 11 * 60_000;
      const meanwhile = await page(wait, { from });
      assert.equal(meanwhile.status, 200, 'not expired while it is being saved');
      assert.match(await meanwhile.text(), /Approve in Drover/);
      release();
      assert.equal((await result(await approving)).test.ok, true);
      assert.match(await (await page(wait, { from })).text(), /alpha's Drover routine is set/);
    } finally { setup._deps.sendTest = realTest; release(); }
  });

  test('drover_whoami gives a bot without a routine its setup link, and never asks for the key in chat', async () => {
    const tools = botTools({ grantId: 'g', clientId: 'c', clientName: 'Grok Bot', bot: 'zeta', scopes: ['drover.read'] }, { dispatch: async () => ({}), host: 'box-a' });
    const who = await tools.find((t) => t.name === 'drover_whoami').run(null, {});
    assert.equal(who.routine.configured, false);
    assert.equal(who.routine.setupUrl, `${BASE}/bots/zeta/routine`);
    assert.ok(who.routine.setup.includes(`${BASE}/bots/zeta/routine`));
    assert.match(who.routine.setup, /never ask for the key in chat/);
  });

  test('the CLI lists a setup by its code and where it leads, and approves it', async () => {
    await writeFile(path.join(STATE, 'daemon.json'), JSON.stringify({ url: `${base}/`, pid: process.pid }));
    const cli = (...args) => new Promise((resolve) => execFile(process.execPath, [path.join(WEB, 'bin', 'drover'), ...args], { env: { ...process.env, DROVER_STATE: STATE } }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr })));
    await send('alpha', { from: fresh() });
    const { code } = seen.at(-1);
    const listed = await cli('bots', 'routine', 'pending');
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, new RegExp(`^${code.slice(0, 3)} ${code.slice(3)}  alpha  ${new URL(HOOK).host.replace('.', '\\.')} …abcdef  from `, 'm'));
    noSecret(listed.stdout, 'the CLI list');
    const done = await cli('bots', 'routine', 'approve', code);
    assert.equal(done.code, 0, done.stderr);
    assert.match(done.stdout, /^Routine set for alpha: .*\nsent a connection test \(run run-7\)/);
    noSecret(done.stdout, 'the CLI answer');
  });
});
