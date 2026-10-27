// The bot gateway end to end over real HTTP (server/botgate.js): what a Grok Bot client does, in order: discover the
// metadata, get a 401 challenge, register, open the authorize page, wait for the owner's approval, collect the code,
// exchange it, then speak MCP over Streamable HTTP with only the scoped tools, every write recorded as the bot.
import './isolate-cache.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const STATE = await mkdtemp(path.join(tmpdir(), 'drover-botgate-'));
const EVENTS = path.join(STATE, 'events.jsonl');
await writeFile(EVENTS, '');
process.env.DROVER_STATE = STATE;
process.env.DROVER_EVENTS = EVENTS;
process.env.DROVER_PAIR_NOTIFY = 'off';
const oauth = await import('../core/bots/oauth.js');
const grok = await import('../core/bots/grok.js');
const events = await import('../core/events.js');
const { startBotGateway, _resetSessions, _deps: gateDeps, clientAddress, sourceKey } = await import('../server/botgate.js');
const { _resetAlerts, botTools, NOTIFY_TOOL } = await import('../core/bots/tools.js');
const { OWNER } = await import('../core/owner.js');

const BASE = 'https://gw.test';
const REDIRECT = 'https://www.cursor.com/bot/oauth/callback';
const verifier = 'test-verifier-0123456789-abcdefghijklmnopqrstuvwxyz';
const challenge = createHash('sha256').update(verifier).digest('base64url');

// A stand-in for the daemon's op dispatcher: real truth-file writes, canned fleet and search answers.
const SPLIT_KEY = 'Zq8RkW3mT9vXb2Lp7NcY4hJd6Gs1Fa5QwE0uIo8r';   // 40 mixed characters: a key to the redactor, its halves are not
const calls = [];
async function dispatch(op, args) {
  calls.push({ op, args });
  switch (op) {
    case 'fleet.summary': return { ts: 't', hosts: [{ host: 'box-a', ok: true, sessions: [
      { id: 's1', engine: 'claude', status: 'busy', live: true, name: 'line-fix', cwd: '/Users/c/code/webapp' },
      { id: 's2', engine: 'claude', status: 'idle', live: true, name: 'billing-f8', cwd: '/Users/c/code/billing' },
      { id: 'grok:alpha', engine: 'grok', status: 'busy', live: true, name: 'Alpha' },
    ] }] };
    case 'search.fleet': return { results: [
      { kind: 'claude', project: 'webapp', title: 'line', snippet: 'routine webhook 400 means paused', sessionId: 'a', score: 2 },
      { kind: 'claude', project: 'billing', title: 'broker', snippet: 'secret work', sessionId: 'b', score: 1 },
      { kind: 'wal', project: null, title: 'note', snippet: 'review !4469 on staging', score: 1 },
      // Truth-file messages carry the thread they belong to as sessionId (core/search/extract.js walEvent).
      { kind: 'wal', project: null, role: 'message', title: 'message to Bravo on box-a', snippet: 'for bravo only', sessionId: 'grok:bravo', score: 1 },
      { kind: 'wal', project: null, role: 'chat', title: 'chat from grok:alpha', snippet: 'alpha answered', sessionId: 'grok:alpha', score: 1 },
      { kind: 'wal', project: null, role: 'message', title: 'message to every Grok bot on box-a', snippet: 'standup at 9', sessionId: 'grok:*', score: 1 },
    ], coverage: { searched: ['box-a'] } };
    case 'events.append': return events.append(args.event, { actor: args.actor });
    case 'events.state': return { features: [{ fid: 'f-line', state: 'in-progress', title: 'line polish', repo: 'webapp', notes: '', links: [], untrusted: true, untrustedBy: ['grok:bravo'] }, { fid: 'f-broker', state: 'shipped', title: 'broker', repo: 'billing', notes: '', links: [] }] };
    case 'features.upsert': return events.append({ type: 'feature', fid: args.fid ?? 'feat-new', repo: args.repo, ...(args.title ? { title: args.title } : {}) }, { actor: args.actor });
    case 'notify.send': return { ok: true };
    case 'brain.search': return { hits: [{ slug: 'ok', title: 'webapp line', namespace: 'repo:webapp', snippet: 'fine' }, { slug: 'no', title: 'billing', namespace: 'repo:billing', snippet: 'work' }] };
    // The brain's answer (its store.note): the entry, and created false when an identical one was already saved.
    case 'brain.note': return String(args.body).endsWith('\n\nseen before') ? { entry: { slug: 'older' }, created: false } : { entry: { slug: 'saved' }, created: true };
    case 'brain.get': {
      // Served in 8000-character windows: mixed is 20 KB, split has a key across the first window's edge.
      const body = args.slug === 'mixed' ? `${'x'.repeat(100)} acme broker ${'y'.repeat(20_000)}` : args.slug === 'split' ? `${'w '.repeat(3990)}${SPLIT_KEY} tail` : `clean ${'z'.repeat(9000)}`;
      const from = args.offset ?? 0;
      return { slug: args.slug, title: 'Notes', namespace: 'shared', kind: 'memory', body: body.slice(from, from + 8000), offset: from, hasMore: from + 8000 < body.length };
    }
    default: throw new Error(`unexpected op ${op}`);
  }
}

let gw, url;
const req = (p, init = {}) => fetch(new URL(p, url), { redirect: 'manual', ...init });
const form = (o) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });

let connections = 0;
/** The browser-and-client half of OAuth: register, authorize page, the owner approves (CLI path), collect, exchange. */
async function connect({ bot = 'alpha', shared = false, scopes } = {}) {
  // Each connection from its own address, as the proxy reports it: the gateway limits what one address may ask for.
  const from = { 'x-forwarded-for': `198.18.0.${++connections}` };
  const reg = await req('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json', ...from }, body: JSON.stringify({ client_name: 'Grok Bot', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }) });
  assert.equal(reg.status, 201);
  const { client_id } = await reg.json();
  const q = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', resource: `${BASE}/mcp` });
  const pageRes = await req(`/oauth/authorize?${q}`, { headers: from });
  assert.equal(pageRes.status, 200);
  assert.match(pageRes.headers.get('content-security-policy'), /default-src 'none'/);
  const html = await pageRes.text();
  const rid = html.match(/wait\?rid=([0-9a-f]{32})/)[1];
  const { code: approvalCode } = oauth.pendingList().at(-1);
  assert.ok(html.includes(oauth.formatCode(approvalCode)), 'the page shows the code the owner approves');
  // Before approval the wait URL keeps showing the page.
  assert.equal((await req(`/oauth/authorize/wait?rid=${rid}`)).status, 200);
  await oauth.approve(approvalCode, { ...(shared ? { shared } : { bot }), scopes, issuer: BASE });   // what `drover bots approve` does through the daemon
  const back = await req(`/oauth/authorize/wait?rid=${rid}`);
  assert.equal(back.status, 302);
  const loc = new URL(back.headers.get('location'));
  assert.equal(loc.searchParams.get('state'), 'xyz');
  assert.equal(loc.searchParams.get('iss'), BASE);
  const tok = await req('/oauth/token', form({ grant_type: 'authorization_code', code: loc.searchParams.get('code'), client_id, redirect_uri: REDIRECT, code_verifier: verifier }));
  assert.equal(tok.status, 200);
  assert.equal(tok.headers.get('cache-control'), 'no-store');
  return { ...(await tok.json()), client_id };
}

let rpcId = 0;
async function mcp(token, method, params, { sid, notification = false } = {}) {
  const body = notification ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: ++rpcId, method, params };
  const res = await req('/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, sid: res.headers.get('mcp-session-id'), body: text ? JSON.parse(text) : null };
}
const callTool = async (token, sid, name, args = {}) => {
  const r = await mcp(token, 'tools/call', { name, arguments: args }, { sid });
  if (r.body.error) return { error: r.body.error };
  return { isError: r.body.result.isError, text: r.body.result.content[0].text, data: (() => { try { return JSON.parse(r.body.result.content[0].text); } catch { return null; } })() };
};
const walEvents = async () => (await readFile(EVENTS, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));

describe('bot gateway over HTTP', () => {
  before(async () => {
    grok._deps.file = () => path.join(STATE, 'bots', 'grok.json');
    gw = await startBotGateway({ base: BASE, port: 0, dispatch });
    url = gw.url;
  });
  after(() => new Promise((r) => gw.server.close(r)));

  test('discovery: both metadata documents, and a 401 that points at them', async () => {
    const pr = await (await req('/.well-known/oauth-protected-resource/mcp')).json();
    assert.equal(pr.resource, `${BASE}/mcp`);
    assert.deepEqual(pr.authorization_servers, [BASE]);
    const as = await (await req('/.well-known/oauth-authorization-server')).json();
    assert.equal(as.token_endpoint, `${BASE}/oauth/token`);
    const r = await req('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' });
    assert.equal(r.status, 401);
    assert.match(r.headers.get('www-authenticate'), /resource_metadata="https:\/\/gw\.test\/\.well-known\/oauth-protected-resource\/mcp"/);
    const bad = await req('/mcp', { method: 'POST', headers: { authorization: 'Bearer drv_at_forged', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(bad.status, 401);
    assert.match(bad.headers.get('www-authenticate'), /error="invalid_token"/);
  });

  test('nothing but the gateway is served: no ops, no UI, no foreign origins', async () => {
    assert.equal((await req('/api/op/sessions.list')).status, 404);
    assert.equal((await req('/index.html')).status, 404);
    assert.equal((await req('/api/stream')).status, 404);
    const evil = await req('/mcp', { method: 'POST', headers: { origin: 'https://evil.example', authorization: 'Bearer drv_at_x', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(evil.status, 403, 'MCP refuses a foreign origin (DNS rebinding)');
    const open = await req('/oauth/register', { method: 'POST', headers: { origin: 'https://app.example', 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [REDIRECT] }) });
    assert.equal(open.status, 201, 'OAuth endpoints serve any origin, as OAuth clients expect');
  });

  test('a request target URL() cannot parse is a 400, and the daemon lives on', async () => {
    const net = await import('node:net');
    const { port } = new URL(url);
    const first = await new Promise((resolve, reject) => {
      const s = net.connect(Number(port), '127.0.0.1', () => s.write('GET //[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
      let data = ''; s.on('data', (d) => { data += d; }); s.on('end', () => resolve(data.split('\r\n')[0])); s.on('error', reject);
    });
    assert.match(first, /^HTTP\/1\.1 400/);
    assert.equal((await req('/.well-known/oauth-authorization-server')).status, 200, 'still serving');
  });

  test('an oversized body gets a 413 answer, not a dropped connection', async () => {
    const big = await req('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: 'x'.repeat(20_000) }) });
    assert.equal(big.status, 413);
    assert.equal((await big.json()).error, 'body too large');
    const t = await connect({ bot: 'alpha' });
    const huge = await req('/mcp', { method: 'POST', headers: { authorization: `Bearer ${t.access_token}`, 'content-type': 'application/json' }, body: `{"jsonrpc":"2.0","id":1,"method":"ping","params":{"pad":"${'x'.repeat(1_100_000)}"}}` });
    assert.equal(huge.status, 413);
    assert.equal((await huge.json()).error.message, 'body too large');
  });

  test('addresses: the proxy\'s X-Forwarded-For entry counts, never the client\'s own; IPv6 by its /64', () => {
    const r = (remoteAddress, xff) => ({ socket: { remoteAddress }, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } });
    assert.equal(clientAddress(r('127.0.0.1', '6.6.6.6, 203.0.113.5')), '203.0.113.5', 'the last entry is the one the proxy added');
    assert.equal(clientAddress(r('127.0.0.1')), '127.0.0.1');
    assert.equal(clientAddress(r('::ffff:127.0.0.1', 'junk')), '127.0.0.1', 'a last entry that is no address: the peer');
    assert.equal(clientAddress(r('198.51.100.4', '6.6.6.6')), '198.51.100.4', 'off loopback there is no proxy to believe');
    assert.equal(sourceKey('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64');
    assert.equal(sourceKey('[2001:0db8:1:2:ffff:ffff:ffff:ffff]:443'), '2001:db8:1:2::/64');
    assert.equal(sourceKey('2001:db8::1'), '2001:db8:0:0::/64');
    assert.equal(sourceKey('1::2:3:4:5:192.0.2.1'), '1:0:2:3::/64', 'an IPv4 tail is two groups');
    assert.equal(sourceKey('::ffff:203.0.113.5'), '203.0.113.5');
    assert.equal(sourceKey('203.0.113.5:8443'), '203.0.113.5');
    assert.equal(sourceKey('not an address'), '?');
  });

  test('a stranger flooding authorize pages cannot lock the real client out or flood the owner with alerts', async () => {
    const announced = [];
    gateDeps.announce = (a) => announced.push(a.code);
    try {
      const register = async (fwd) => (await (await req('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': fwd }, body: JSON.stringify({ client_name: 'Grok Bot', redirect_uris: [REDIRECT] }) })).json()).client_id;
      const page = (clientId, fwd) => req(`/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' })}`, { headers: { 'x-forwarded-for': fwd } });
      const before = oauth.pendingList().length;
      // The stranger changes the X-Forwarded-For it sends each time; the proxy's own entry, last, stays its real address.
      const statuses = [];
      for (let i = 0; i < 6; i++) statuses.push((await page(await register(`198.51.100.${i}`), `10.0.0.${i}, 203.0.113.66`)).status);
      assert.deepEqual(statuses, [200, 200, 200, 302, 302, 302], 'three waiting, then refusals back to the client');
      assert.equal(announced.length, oauth.ALERTS_PER_SOURCE, 'and only a couple of alerts');
      const real = await page(await register('192.0.2.10'), '192.0.2.10');
      assert.equal(real.status, 200, 'the real client still gets its page');
      assert.equal(announced.length, oauth.ALERTS_PER_SOURCE + 1, 'and its alert');
      assert.match(oauth.pendingList().at(-1).from, /^192\.0\.2\.10/, 'the approver sees the address the proxy saw');
      assert.equal(oauth.pendingList().length, before + 4);
      for (const p of oauth.pendingList()) oauth.deny(p.code);   // leave no approvals waiting for the tests after this one
    } finally { gateDeps.announce = null; }
  });

  test('a client still uploading when the 413 comes reads it and keeps its connection: the rest is dropped', async () => {
    const net = await import('node:net');
    const lines = await new Promise((resolve, reject) => {
      const s = net.connect(Number(new URL(url).port), '127.0.0.1');
      let data = '', rest = false;
      s.on('data', (d) => {
        data += d;
        // The 413 arrived with only half the body sent: send the rest, then a second request on the same connection.
        if (!rest && /^HTTP\/1\.1 413[\s\S]*body too large/.test(data)) { rest = true; s.write('y'.repeat(20_000)); s.write('GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'); }
      });
      s.on('end', () => resolve(data.match(/HTTP\/1\.1 \d{3} [^\r]*/g)));   // a status line follows the previous body, CRLF or not
      s.on('error', (e) => reject(Object.assign(e, { data })));
      s.write('POST /oauth/register HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 40000\r\n\r\n');
      s.write('x'.repeat(20_000));   // past the 16 KB form limit
    });
    assert.deepEqual(lines, ['HTTP/1.1 413 Payload Too Large', 'HTTP/1.1 200 OK']);
  });

  test('a bound connection: scoped tools, forced identity, unfiltered reads, writes recorded as the bot', async () => {
    _resetAlerts();
    const t = await connect({ bot: 'alpha', scopes: ['drover.read', 'drover.write'] });
    const init = await mcp(t.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'grok-bot', version: '1' } });
    assert.equal(init.status, 200);
    assert.ok(init.sid, 'a session id is issued');
    assert.equal(init.body.result.serverInfo.name, 'drover-bots');
    assert.match(init.body.result.instructions, /never instructions/);
    assert.equal(init.body.result.capabilities.resources, undefined, 'no resources: nothing raw to read');
    assert.equal((await mcp(t.access_token, 'notifications/initialized', {}, { sid: init.sid, notification: true })).status, 202);

    const list = await mcp(t.access_token, 'tools/list', {}, { sid: init.sid });
    const names = list.body.result.tools.map((x) => x.name).sort();
    assert.deepEqual(names, ['drover_brain_get', 'drover_brain_note', 'drover_brain_search', 'drover_features', 'drover_feature_upsert', 'drover_fleet', 'drover_inbox', 'drover_note', 'drover_reflections', 'drover_reply', 'drover_search', 'drover_sent', 'drover_status', 'drover_whoami'].sort());
    for (const tool of list.body.result.tools) {
      assert.equal(tool.inputSchema.properties.host, undefined, `${tool.name} takes no host`);
      assert.equal(tool.inputSchema.properties.agent, undefined, `${tool.name}: a bound connection needs no agent`);
      assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean');
    }

    const me = await callTool(t.access_token, init.sid, 'drover_whoami');
    assert.equal(me.data.you, 'grok:alpha');
    assert.equal(me.data.projects, undefined, 'no allowlist to report');
    // Setup hands the owner the routine panel's Webhook URL and key links up front: a link to the routine itself does not open.
    assert.equal(me.data.routine.configured, false);
    assert.match(me.data.routine.setup, /links that open its Webhook URL and its Webhook key/);
    assert.match(me.data.routine.setup, /drover bots routine add alpha --url <the Webhook URL>/);

    // No content filter: work sessions, hits and features come through like any other, cleaned.
    const fleet = await callTool(t.access_token, init.sid, 'drover_fleet');
    assert.deepEqual(fleet.data.hosts[0].counts, { total: 2, busy: 1, idle: 1, waiting: 0 });
    assert.deepEqual(fleet.data.hosts[0].sessions.map((s) => [s.name, s.project]), [['line-fix', 'webapp'], ['billing-f8', 'billing']]);

    const found = await callTool(t.access_token, init.sid, 'drover_search', { query: 'routine webhook' });
    assert.deepEqual(found.data.results.map((h) => h.title), ['line', 'broker', 'note', 'chat from grok:alpha', 'message to every Grok bot on box-a'], 'its own thread and broadcasts, never another bot\'s messages');
    assert.equal(found.data.withheld, undefined);
    const scoped = await callTool(t.access_token, init.sid, 'drover_search', { query: 'x', project: 'billing' });
    assert.equal(scoped.isError, false);
    assert.equal(calls.findLast((c) => c.op === 'search.fleet').args.project, 'billing');

    const st = await callTool(t.access_token, init.sid, 'drover_status', { state: 'working', summary: 'deploying webapp-api', task: 'deploy' });
    assert.equal(st.data.ok, true);
    const spoof = await callTool(t.access_token, init.sid, 'drover_status', { state: 'idle', summary: 'x', agent: 'bravo' });
    assert.equal(spoof.isError, true);
    assert.match(spoof.text, /unknown argument "agent"/, 'agent is not even in a bound schema');
    // Another bot's inbox stays its own: alpha sees only what was sent to it (or to every bot), and cannot answer the rest.
    await events.append({ type: 'message', to: { kind: 'grok', host: 'box-a', id: 'grok:bravo', name: 'Bravo' }, text: 'for bravo only', ref: 'r-bravo' }, { actor: OWNER });
    await events.append({ type: 'message', to: { kind: 'grok', host: 'box-a', id: 'grok:alpha', name: 'Alpha' }, text: 'for alpha', ref: 'r-alpha' }, { actor: OWNER });
    grok._resetCache();
    const inbox = await callTool(t.access_token, init.sid, 'drover_inbox');
    assert.deepEqual(inbox.data.messages.map((m) => m.messageId), ['r-alpha']);
    const theirs = await callTool(t.access_token, init.sid, 'drover_reply', { messageId: 'r-bravo', text: 'hijack' });
    assert.equal(theirs.isError, true);
    assert.match(theirs.text, /no message r-bravo in your inbox/);
    const note = await callTool(t.access_token, init.sid, 'drover_note', { text: 'webapp-api restarted cleanly' });
    assert.equal(note.data.ok, true);
    const wal = await walEvents();
    const status = wal.find((e) => e.type === 'status');
    assert.equal(status.actor, 'grok:alpha');
    assert.equal(status.agent, 'grok:alpha');
    assert.equal(status.state, 'working');
    assert.deepEqual([status.source, status.untrusted], ['grok:alpha', true], 'every event a bot causes carries its source');
    assert.equal(wal.find((e) => e.type === 'note').actor, 'grok:alpha');
    assert.equal(wal.find((e) => e.type === 'note').about, 'grok:alpha');
    // What other agents read out of context starts with the mark, and the event says untrusted.
    const noteEv = wal.find((e) => e.type === 'note');
    assert.deepEqual([noteEv.text, noteEv.source, noteEv.untrusted], ['[untrusted: grok:alpha] webapp-api restarted cleanly', 'grok:alpha', true]);

    const feats = await callTool(t.access_token, init.sid, 'drover_features', { repo: ' webapp ' });
    assert.deepEqual([feats.data.features[0].untrusted, feats.data.features[0].untrustedBy], [true, ['grok:bravo']], 'a bot sees which features bots wrote');
    assert.deepEqual(feats.data.features.map((f) => f.fid), ['f-line'], 'a padded repo name still matches');
    assert.deepEqual((await callTool(t.access_token, init.sid, 'drover_features')).data.features.map((f) => f.fid), ['f-line', 'f-broker']);
    const moved = await callTool(t.access_token, init.sid, 'drover_feature_upsert', { repo: 'webapp', fid: 'f-broker', state: 'abandoned' });
    assert.equal(moved.isError, true, 'an update through another repo would move the feature');
    assert.match(moved.text, /belongs to billing/);
    const work = await callTool(t.access_token, init.sid, 'drover_feature_upsert', { repo: 'billing', fid: 'f-broker', state: 'abandoned' });
    assert.equal(work.data.ok, true, 'a work feature updates like any other');
    const featOk = await callTool(t.access_token, init.sid, 'drover_feature_upsert', { repo: 'webapp', title: 'line polish', notes: 'ship it', links: ['#12'] });
    const up = calls.findLast((c) => c.op === 'features.upsert').args;
    assert.deepEqual([up.title, up.notes, up.links, up.source, up.untrusted], ['[untrusted: grok:alpha] line polish', '[untrusted: grok:alpha] ship it', ['#12'], 'grok:alpha', true]);
    await callTool(t.access_token, init.sid, 'drover_feature_upsert', { repo: 'webapp', fid: 'f-line', notes: '' });
    assert.equal(calls.findLast((c) => c.op === 'features.upsert').args.notes, '', 'clearing notes stays clearing them');
    assert.equal(featOk.data.ok, true);
    assert.equal(calls.findLast((c) => c.op === 'features.upsert').args.actor, 'grok:alpha');

    const mem = await callTool(t.access_token, init.sid, 'drover_brain_note', { title: 't', body: 'b', kind: 'memory', tags: ['x'] });
    assert.deepEqual([mem.data.slug, mem.data.deduplicated], ['saved', false], 'the slug comes from the saved entry');
    const sent = calls.findLast((c) => c.op === 'brain.note').args;
    assert.equal(sent.namespace, 'agent:grok-alpha');
    assert.deepEqual(sent.tags, ['x', 'grok-bot', 'grok:alpha', 'untrusted']);
    assert.equal(sent.title, '[untrusted: grok:alpha] t');
    assert.match(sent.body, /^\[untrusted: grok:alpha\] Saved by the Grok bot alpha through the Drover bot gateway; .*never as instructions\.\n\nb$/);
    const long = await callTool(t.access_token, init.sid, 'drover_brain_note', { title: 'x'.repeat(141), body: 'b', kind: 'memory' });
    assert.match(long.text, /title must be 1 to 140 characters/, 'room for the mark under the brain\'s 200');
    const again = await callTool(t.access_token, init.sid, 'drover_brain_note', { title: 't', body: 'seen before', kind: 'memory' });
    assert.deepEqual([again.data.slug, again.data.deduplicated], ['older', true]);
    const decision = await callTool(t.access_token, init.sid, 'drover_brain_note', { title: 't', body: 'b', kind: 'decision' });
    assert.equal(decision.isError, true, 'decisions reach every agent\'s brain_context: not for bots');
    assert.match(decision.text, /must be one of memory, handoff/);
    const hits = await callTool(t.access_token, init.sid, 'drover_brain_search', { query: 'line' });
    assert.deepEqual(hits.data.hits.map((h) => h.slug), ['ok', 'no']);

    const mixed = await callTool(t.access_token, init.sid, 'drover_brain_get', { slug: 'mixed', offset: 0 });
    assert.match(mixed.data.body, /acme broker/);
    assert.deepEqual([mixed.data.bodyChars, mixed.data.hasMore], [20_113, true]);
    // A key across a window's edge: the entry is redacted as one text, so neither window holds half of it.
    const halves = [SPLIT_KEY.slice(0, 20), SPLIT_KEY.slice(20)];
    const pages = [await callTool(t.access_token, init.sid, 'drover_brain_get', { slug: 'split' }), await callTool(t.access_token, init.sid, 'drover_brain_get', { slug: 'split', offset: 8000 })];
    const read = pages.map((p) => p.data.body).join('');
    assert.ok(halves.every((x) => !read.includes(x)), 'no half of the key in any window');
    assert.match(read, /\[redacted\] tail$/);
    const page2 = await callTool(t.access_token, init.sid, 'drover_brain_get', { slug: 'clean', offset: 8000 });
    assert.deepEqual([page2.data.offset, page2.data.body.length, page2.data.bodyChars, page2.data.hasMore], [8000, 1006, 9006, false]);

    const notify = await callTool(t.access_token, init.sid, NOTIFY_TOOL, { title: 'hi' });
    assert.match(notify.error.message, /unknown tool/, 'no notify scope, no notify tool');
  });

  test('needs-owner raises one alert through notify.send, as the bot, into its waiting lane', async () => {
    _resetAlerts();
    const t = await connect({ bot: 'alpha' });
    const init = await mcp(t.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const before = calls.filter((c) => c.op === 'notify.send').length;
    const r = await callTool(t.access_token, init.sid, 'drover_status', { state: 'needs-owner', summary: 'which region for the new box?' });
    assert.equal(r.data.alerted, true);
    const n = calls.filter((c) => c.op === 'notify.send');
    assert.equal(n.length, before + 1);
    assert.deepEqual({ ...n.at(-1).args }, { title: 'Alpha needs you', body: 'which region for the new box?', category: 'needs-you', sessionId: 'grok:alpha', name: 'Alpha', actor: 'grok:alpha' });
  });

  test('a shared connection is read-only and acts as no bot: no writes, alerts or inbox, and no bot name to claim', async () => {
    const READS = ['drover_brain_get', 'drover_brain_search', 'drover_features', 'drover_fleet', 'drover_reflections', 'drover_search', 'drover_whoami'];
    const t = await connect({ shared: true });   // the client asked for every scope; shared gets read
    const init = await mcp(t.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const list = await mcp(t.access_token, 'tools/list', {}, { sid: init.sid });
    assert.deepEqual(list.body.result.tools.map((x) => x.name).sort(), READS);
    assert.ok(list.body.result.tools.every((x) => !x.inputSchema.properties.agent), 'no tool takes a bot name');
    const me = await callTool(t.access_token, init.sid, 'drover_whoami');
    assert.deepEqual([me.data.you, me.data.connection.bot, me.data.connection.shared, me.data.inbox], [null, 'shared', true, undefined]);
    assert.match((await callTool(t.access_token, init.sid, 'drover_note', { text: 'hello from bravo', agent: 'bravo' })).error.message, /unknown tool/, 'naming a bot does not make it one');
    assert.match((await callTool(t.access_token, init.sid, 'drover_inbox')).error.message, /unknown tool/);
    const found = await callTool(t.access_token, init.sid, 'drover_search', { query: 'x' });
    assert.deepEqual(found.data.results.filter((h) => h.sessionId?.startsWith('grok:')).map((h) => h.sessionId), ['grok:*'], 'no bot\'s own thread, only broadcasts');
    // A shared grant from before this rule, with write and notify, still gets only the reads.
    const old = botTools({ grantId: 'g', clientName: 'old', bot: '*', scopes: ['drover.read', 'drover.write', 'drover.notify'] }, { dispatch });
    assert.deepEqual(old.map((x) => x.name).sort(), READS);
  });

  test('sessions: unknown ids get 404, DELETE ends one, GET has no stream, stateless calls still work', async () => {
    const t = await connect({ bot: 'alpha' });
    const init = await mcp(t.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    assert.equal((await mcp(t.access_token, 'tools/list', {}, { sid: 'nope' })).status, 404);
    const get = await req('/mcp', { headers: { authorization: `Bearer ${t.access_token}` } });
    assert.equal(get.status, 405);
    const del = await req('/mcp', { method: 'DELETE', headers: { authorization: `Bearer ${t.access_token}`, 'mcp-session-id': init.sid } });
    assert.equal(del.status, 204);
    assert.equal((await mcp(t.access_token, 'tools/list', {}, { sid: init.sid })).status, 404, 'ended');
    const stateless = await mcp(t.access_token, 'tools/list', {});
    assert.equal(stateless.status, 200);
    const other = await connect({ bot: 'bravo' });
    const theirs = await mcp(other.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    assert.equal((await mcp(t.access_token, 'tools/list', {}, { sid: theirs.sid })).status, 404, 'a token cannot use another grant\'s session');
    const pv = await req('/mcp', { method: 'POST', headers: { authorization: `Bearer ${t.access_token}`, 'content-type': 'application/json', 'mcp-protocol-version': '1999-01-01' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
    assert.equal(pv.status, 400);
  });

  test('revoking in Drover cuts the bot off at once; refresh works until then', async () => {
    const t = await connect({ bot: 'alpha' });
    const r = await req('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.client_id }));
    const t2 = await r.json();
    assert.equal(r.status, 200);
    assert.equal((await mcp(t2.access_token, 'ping', {})).status, 200);
    const grant = (await oauth.grantsList()).find((g) => g.lastUsedAt && g.bot === 'alpha');
    await oauth.revokeGrant(grant.grantId);
    const after = await mcp(t2.access_token, 'ping', {});
    assert.equal(after.status, 401);
    const err = await req('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: t2.refresh_token, client_id: t.client_id }));
    assert.equal(err.status, 400);
    assert.equal((await err.json()).error, 'invalid_grant');
    _resetSessions();
  });
});
