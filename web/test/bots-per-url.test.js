// A server per bot (/bots/<bot>/...): Grok Bot keeps one sign-in per server, so connectors at one URL share one
// identity (one bot's connector signed in as another, 2026-10-20). Each bot's URL is its own resource and issuer, its
// requests can only be approved as that bot, and it refuses every other bot's connection.
import './isolate-cache.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const STATE = await mkdtemp(path.join(tmpdir(), 'drover-perbot-'));
await writeFile(path.join(STATE, 'events.jsonl'), '');
process.env.DROVER_STATE = STATE;
process.env.DROVER_EVENTS = path.join(STATE, 'events.jsonl');
process.env.DROVER_PAIR_NOTIFY = 'off';
const oauth = await import('../core/bots/oauth.js');
const { startBotGateway } = await import('../server/botgate.js');

const BASE = 'https://gw.test';
const REDIRECT = 'https://www.cursor.com/bot/mcp/oauth/callback';
const verifier = 'per-bot-verifier-0123456789-abcdefghijklmnopqrstuvwxyz';
const challenge = createHash('sha256').update(verifier).digest('base64url');
let gw, url;
const logs = [];
const req = (p, init = {}) => fetch(new URL(p, url), { redirect: 'manual', ...init });
const form = (o) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });

/** Sign in through a prefix ('' or /bots/<bot>) up to the pending approval; returns what approving needs. */
async function startSignIn(prefix) {
  const reg = await (await req(`${prefix}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Cursor', redirect_uris: [REDIRECT] }) })).json();
  const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 's', resource: `${BASE}${prefix}/mcp` });
  const page = await req(`${prefix}/oauth/authorize?${q}`);
  const html = await page.text();
  return { client_id: reg.client_id, html, rid: html.match(/wait\?rid=([0-9a-f]{32})/)[1], code: oauth.pendingList().at(-1).code, pending: oauth.pendingList().at(-1) };
}
/** After approval: collect the code from the page's redirect and exchange it at the same prefix. */
async function finishSignIn(prefix, s) {
  const back = await req(`${prefix}/oauth/authorize/wait?rid=${s.rid}`);
  const loc = new URL(back.headers.get('location'));
  const tok = await (await req(`${prefix}/oauth/token`, form({ grant_type: 'authorization_code', code: loc.searchParams.get('code'), client_id: s.client_id, redirect_uri: REDIRECT, code_verifier: verifier }))).json();
  return { ...tok, iss: loc.searchParams.get('iss') };
}
const mcp = (p, token, method, params = {}) => req(p, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });

describe('a server per bot', () => {
  before(async () => { gw = await startBotGateway({ base: BASE, port: 0, dispatch: async () => ({}), log: (...p) => logs.push(p.join(' ')) }); url = gw.url; });
  after(() => new Promise((r) => gw.server.close(r)));

  test('each bot is its own resource and issuer, found by path insertion or under its prefix', async () => {
    const pr = await (await req('/.well-known/oauth-protected-resource/bots/alpha/mcp')).json();
    assert.equal(pr.resource, `${BASE}/bots/alpha/mcp`);
    assert.deepEqual(pr.authorization_servers, [`${BASE}/bots/alpha`]);
    for (const p of ['/.well-known/oauth-authorization-server/bots/alpha', '/bots/alpha/.well-known/oauth-authorization-server', '/.well-known/openid-configuration/bots/alpha']) {
      const as = await (await req(p)).json();
      assert.equal(as.issuer, `${BASE}/bots/alpha`, p);
      assert.equal(as.token_endpoint, `${BASE}/bots/alpha/oauth/token`, p);
    }
    const root = await (await req('/.well-known/oauth-authorization-server')).json();
    assert.equal(root.issuer, BASE, 'the root server is unchanged');
    const r = await req('/bots/alpha/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 401);
    assert.match(r.headers.get('www-authenticate'), /resource_metadata="https:\/\/gw\.test\/\.well-known\/oauth-protected-resource\/bots\/alpha\/mcp"/);
    assert.equal((await req('/bots/Alpha%20B/mcp', { method: 'POST' })).status, 404, 'not a bot name');
    assert.equal((await req('/bots/alpha/api/ops')).status, 404);
  });

  test('a sign-in through /bots/alpha is approved as alpha without naming it, and its iss is alpha\'s issuer', async () => {
    const s = await startSignIn('/bots/alpha');
    assert.equal(s.pending.bot, 'alpha');
    assert.match(s.html, /connect <b>alpha<\/b>/);
    assert.match(s.html, /wait\?rid=/);
    assert.ok(s.html.includes(`${BASE}/bots/alpha/oauth/authorize/wait?rid=`), 'the page polls under the bot\'s prefix');
    const a = await oauth.approve(s.code, { issuer: BASE });
    assert.equal(a.bot, 'alpha');
    const t = await finishSignIn('/bots/alpha', s);
    assert.equal(t.iss, `${BASE}/bots/alpha`, 'RFC 9207: the issuer the client talked to');
    const init = await mcp('/bots/alpha/mcp', t.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    assert.equal(init.status, 200);
  });

  test('a sign-in that stalls says where: the handoff to the browser and a refused code exchange are logged, never the code', async () => {
    const s = await startSignIn('/bots/alpha');
    await oauth.approve(s.code, { issuer: BASE });
    const back = await req(`/bots/alpha/oauth/authorize/wait?rid=${s.rid}`);
    const code = new URL(back.headers.get('location')).searchParams.get('code');
    assert.ok(logs.includes('bot authorization handed to the browser Cursor alpha'), logs.join('\n'));
    const bad = await req('/bots/alpha/oauth/token', form({ grant_type: 'authorization_code', code, client_id: s.client_id, redirect_uri: REDIRECT, code_verifier: 'w'.repeat(43) }));
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, 'invalid_grant');
    assert.ok(logs.includes('bot code exchange refused code_verifier does not match the code_challenge'), logs.join('\n'));
    assert.ok(!logs.some((l) => l.includes(code)), 'the code itself is never logged');
  });

  test('a request through one bot\'s URL cannot be approved as another, or as shared', async () => {
    const s = await startSignIn('/bots/alpha');
    await assert.rejects(oauth.approve(s.code, { bot: 'bravo', issuer: BASE }), /came through alpha's own URL .* only be approved as alpha/);
    await assert.rejects(oauth.approve(s.code, { shared: true, issuer: BASE }), /only be approved as alpha/);
    assert.equal((await oauth.approve(s.code, { bot: 'Alpha', issuer: BASE })).bot, 'alpha', 'naming the same bot is fine');
  });

  test('a bot\'s server refuses every other connection with a challenge to sign in again; the root takes any', async () => {
    const s = await startSignIn('');
    assert.equal(s.pending.bot, null);
    await assert.rejects(oauth.approve(s.code, { issuer: BASE }), /name the bot/, 'the root still needs --as');
    await oauth.approve(s.code, { bot: 'charlie', issuer: BASE });
    const other = await finishSignIn('', s);
    assert.equal(other.iss, BASE);
    const onAlpha = await mcp('/bots/alpha/mcp', other.access_token, 'ping');
    assert.equal(onAlpha.status, 401);
    assert.match(onAlpha.headers.get('www-authenticate'), /error="invalid_token", error_description="this connection belongs to charlie, not alpha"/);
    assert.match(onAlpha.headers.get('www-authenticate'), /oauth-protected-resource\/bots\/alpha\/mcp/);
    assert.equal((await mcp('/mcp', other.access_token, 'ping')).status, 200, 'the root takes it, as before');
    assert.equal((await mcp('/bots/charlie/mcp', other.access_token, 'ping')).status, 200, 'and so does charlie\'s own server');
  });
});
