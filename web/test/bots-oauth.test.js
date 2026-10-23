// The bot gateway's OAuth 2.1 server (core/bots/oauth.js): dynamic registration, authorization code with PKCE S256,
// approval by a 6-digit code (never an op), rotating refresh tokens with reuse detection, revocation.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const STATE = await mkdtemp(path.join(tmpdir(), 'drover-bots-oauth-'));
process.env.DROVER_STATE = STATE;
const oauth = await import('../core/bots/oauth.js');

const BASE = 'https://box.example.ts.net:10000';
let now = Date.parse('2026-10-20T08:00:00Z');
oauth._deps.now = () => now;

const verifier = 'v'.repeat(20) + 'erifier-0123456789-abcdefghijklmnop';
const challenge = createHash('sha256').update(verifier).digest('base64url');
const REDIRECT = 'https://www.cursor.com/bot/oauth/callback';

async function client(extra = {}) {
  return oauth.register({ client_name: 'Grok Bot', redirect_uris: [REDIRECT, 'grokbot://oauth', 'http://localhost:8787/cb'], token_endpoint_auth_method: 'none', ...extra });
}
async function authorize(c, extra = {}, opts = {}) {
  return oauth.createAuthorization({ response_type: 'code', client_id: c.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'st-1', scope: 'drover.read drover.write', resource: `${BASE}/mcp`, ...extra }, { from: '203.0.113.9, test', ...opts });
}
/** register -> authorize -> approve -> collect the code from the redirect. */
async function codeFor({ bot = 'alpha', scopes } = {}) {
  const c = await client();
  const a = await authorize(c);
  await oauth.approve(a.code, { bot, scopes, issuer: BASE });
  const s = oauth.authorizationStatus(a.rid);
  const u = new URL(s.redirect);
  return { c, a, code: u.searchParams.get('code'), redirect: u };
}

describe('core/bots/oauth', () => {
  beforeEach(async () => { oauth._reset(); now = Date.parse('2026-10-20T08:00:00Z'); await rm(path.join(STATE, 'bots'), { recursive: true, force: true }); });

  test('metadata points at this origin and advertises only what is implemented', () => {
    const as = oauth.authServerMetadata(BASE);
    assert.equal(as.issuer, BASE);
    assert.equal(as.registration_endpoint, `${BASE}/oauth/register`);
    assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
    assert.deepEqual(as.grant_types_supported, ['authorization_code', 'refresh_token']);
    const pr = oauth.protectedResourceMetadata(BASE);
    assert.equal(pr.resource, `${BASE}/mcp`);
    assert.deepEqual(pr.authorization_servers, [BASE]);
  });

  test('publicBase: https origins only (http to loopback for tests), no path', () => {
    assert.equal(oauth.publicBase({ DROVER_BOTS_URL: 'https://box.ts.net:10000/' }), 'https://box.ts.net:10000');
    assert.equal(oauth.publicBase({ DROVER_BOTS_URL: 'http://127.0.0.1:9' }), 'http://127.0.0.1:9');
    assert.equal(oauth.publicBase({}), null);
    assert.throws(() => oauth.publicBase({ DROVER_BOTS_URL: 'http://box.ts.net' }), /must be https/);
    assert.throws(() => oauth.publicBase({ DROVER_BOTS_URL: 'https://box.ts.net/drover' }), /no path/);
  });

  test('registration: app schemes, https and loopback http redirects; never javascript, data, file or plain http', async () => {
    const c = await client();
    assert.match(c.client_id, /^drv_client_/);
    assert.equal(c.client_secret, undefined, 'public clients get no secret');
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'http://evil.example/cb', 'https://x.example/cb#frag', 'not a url'])
      await assert.rejects(oauth.register({ redirect_uris: [bad] }), (e) => e.code === 'invalid_redirect_uri', bad);
    await assert.rejects(oauth.register({ redirect_uris: [] }), /redirect_uris must list/);
    // Like other OAuth issuers Grok Bot connects to: what a client asks for beyond its name and redirects is replaced.
    const odd = await oauth.register({ redirect_uris: [REDIRECT, REDIRECT], grant_types: ['client_credentials'], response_types: ['token'], token_endpoint_auth_method: 'client_secret_post' });
    assert.deepEqual([odd.token_endpoint_auth_method, odd.grant_types, odd.response_types, odd.redirect_uris], ['none', ['authorization_code', 'refresh_token'], ['code'], [REDIRECT]]);
    assert.equal(odd.client_secret, undefined, 'every client is public; PKCE carries the proof');
  });

  test('the full flow: approve by code, the page collects the code once, PKCE checked, tokens work', async () => {
    const c = await client();
    const a = await authorize(c);
    assert.match(a.code, /^\d{6}$/);
    assert.deepEqual(a.scopes, ['drover.read', 'drover.write']);
    const pending = oauth.pendingList();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].client, 'Grok Bot');
    assert.equal(pending[0].redirectHost, 'www.cursor.com');
    assert.ok(!JSON.stringify(pending).includes(a.rid), 'the approver never sees the page secret');
    assert.equal(oauth.authorizationStatus(a.rid).status, 'pending');

    const r = await oauth.approve(` ${a.code.slice(0, 3)} ${a.code.slice(3)} `, { bot: 'Alpha', issuer: BASE });
    assert.equal(r.bot, 'alpha');
    const s = oauth.authorizationStatus(a.rid);
    assert.equal(s.status, 'approved');
    const u = new URL(s.redirect);
    assert.equal(u.origin + u.pathname, REDIRECT);
    assert.equal(u.searchParams.get('state'), 'st-1');
    assert.equal(u.searchParams.get('iss'), BASE);
    assert.equal(oauth.authorizationStatus(a.rid), null, 'collected once, then gone');

    const code = u.searchParams.get('code');
    await assert.rejects(oauth.tokenRequest({ grant_type: 'authorization_code', code, client_id: c.client_id, redirect_uri: REDIRECT, code_verifier: 'w'.repeat(43) }), /code_verifier does not match/);
    await assert.rejects(oauth.tokenRequest({ grant_type: 'authorization_code', code, client_id: c.client_id, redirect_uri: REDIRECT, code_verifier: verifier }), /invalid, expired or already used/, 'a failed attempt still burns the code');
  });

  test('token exchange: right verifier and redirect get tokens; the access token resolves to the grant', async () => {
    const { c, code } = await codeFor();
    await assert.rejects(oauth.tokenRequest({ grant_type: 'authorization_code', code: 'drv_code_nope', client_id: c.client_id, code_verifier: verifier }), (e) => e.code === 'invalid_grant');
    const t = await oauth.tokenRequest({ grant_type: 'authorization_code', code, client_id: c.client_id, redirect_uri: REDIRECT, code_verifier: verifier });
    assert.match(t.access_token, /^drv_at_/);
    assert.match(t.refresh_token, /^drv_rt_/);
    assert.equal(t.token_type, 'Bearer');
    assert.equal(t.expires_in, oauth.ACCESS_TTL_S);
    const g = await oauth.verifyAccess(t.access_token);
    assert.equal(g.bot, 'alpha');
    assert.deepEqual(g.scopes, ['drover.read', 'drover.write']);
    assert.equal(await oauth.verifyAccess('drv_at_wrong'), null);
    assert.equal(await oauth.verifyAccess(t.refresh_token), null, 'a refresh token is not an access token');
    now += oauth.ACCESS_TTL_S * 1000 + 1;
    assert.equal(await oauth.verifyAccess(t.access_token), null, 'access tokens expire');
  });

  test('a wrong redirect_uri, another client, or a late code is refused', async () => {
    let x = await codeFor();
    await assert.rejects(oauth.tokenRequest({ grant_type: 'authorization_code', code: x.code, client_id: x.c.client_id, redirect_uri: 'grokbot://oauth', code_verifier: verifier }), /redirect_uri does not match/);
    x = await codeFor();
    const other = await client();
    await assert.rejects(oauth.tokenRequest({ grant_type: 'authorization_code', code: x.code, client_id: other.client_id, redirect_uri: REDIRECT, code_verifier: verifier }), /another client/);
    x = await codeFor();
    now += oauth.CODE_TTL_MS + 1;
    await assert.rejects(oauth.tokenRequest({ grant_type: 'authorization_code', code: x.code, client_id: x.c.client_id, redirect_uri: REDIRECT, code_verifier: verifier }), /expired or already used/);
  });

  test('the code\'s minute starts when the page collects it, not at approval', async () => {
    const c = await client();
    const a = await authorize(c);
    await oauth.approve(a.code, { bot: 'alpha', issuer: BASE });
    now += oauth.COLLECT_MS - 1_000;   // the page comes back late (a tab in the background), still inside its window
    const code = new URL(oauth.authorizationStatus(a.rid).redirect).searchParams.get('code');
    now += oauth.CODE_TTL_MS - 1_000;  // and the client takes most of the code's minute
    const t = await oauth.tokenRequest({ grant_type: 'authorization_code', code, client_id: c.client_id, redirect_uri: REDIRECT, code_verifier: verifier });
    assert.match(t.access_token, /^drv_at_/);
  });

  test('a grant is stalled only once its sign-in can no longer finish', async () => {
    const stalledOf = async (id) => (await oauth.grantsList()).find((g) => g.grantId === id).stalled === true;
    // Approved, never collected: the page may still collect it until the request's ten minutes are up.
    let c = await client(), a = await authorize(c);
    const never = (await oauth.approve(a.code, { bot: 'alpha', issuer: BASE })).grantId;
    now += oauth.PENDING_TTL_MS - 1_000;
    assert.equal(await stalledOf(never), false);
    now += 2_000;
    assert.equal(await stalledOf(never), true);
    // Collected, never exchanged: stalled once the code's minute is up.
    c = await client(); a = await authorize(c);
    const unused = (await oauth.approve(a.code, { bot: 'bravo', issuer: BASE })).grantId;
    oauth.authorizationStatus(a.rid);
    assert.equal(await stalledOf(unused), false);
    now += oauth.CODE_TTL_MS + 1;
    assert.equal(await stalledOf(unused), true);
    // Exchanged: connected, never stalled.
    const x = await codeFor({ bot: 'charlie' });
    await oauth.tokenRequest({ grant_type: 'authorization_code', code: x.code, client_id: x.c.client_id, redirect_uri: REDIRECT, code_verifier: verifier });
    const done = (await oauth.grantsList()).find((g) => g.bot === 'charlie');
    assert.equal(done.connected, true);
    assert.equal(done.stalled, undefined);
  });

  test('refresh rotates; replaying a used refresh token revokes the whole grant', async () => {
    const { c, code } = await codeFor();
    const t1 = await oauth.tokenRequest({ grant_type: 'authorization_code', code, client_id: c.client_id, redirect_uri: REDIRECT, code_verifier: verifier });
    const t2 = await oauth.tokenRequest({ grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: c.client_id });
    assert.notEqual(t2.refresh_token, t1.refresh_token);
    assert.ok(await oauth.verifyAccess(t2.access_token));
    await assert.rejects(oauth.tokenRequest({ grant_type: 'refresh_token', refresh_token: t2.refresh_token, client_id: c.client_id, scope: 'drover.notify' }), /cannot widen/);
    await assert.rejects(oauth.tokenRequest({ grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: c.client_id }), /already used; the grant is revoked/);
    assert.equal(await oauth.verifyAccess(t2.access_token), null, 'reuse ends every token of the grant');
    await assert.rejects(oauth.tokenRequest({ grant_type: 'refresh_token', refresh_token: t2.refresh_token, client_id: c.client_id }), /invalid or revoked/);
  });

  test('a refresh token replayed after any number of rotations still ends the grant', async () => {
    const { c, code } = await codeFor();
    const first = await oauth.tokenRequest({ grant_type: 'authorization_code', code, client_id: c.client_id, redirect_uri: REDIRECT, code_verifier: verifier });
    let t = first;
    for (let i = 0; i < 25; i++) t = await oauth.tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: c.client_id });
    assert.ok(await oauth.verifyAccess(t.access_token));
    await assert.rejects(oauth.tokenRequest({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: c.client_id }), /already used; the grant is revoked/);
    assert.equal(await oauth.verifyAccess(t.access_token), null, 'the attacker\'s fresh tokens die with the grant');
    const other = await client();
    await assert.rejects(oauth.tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: other.client_id }), /invalid or revoked/, 'another client cannot use or burn it');
  });

  test('parallel first requests share one load of the state, so none of their changes is lost', async () => {
    oauth._reset();   // fresh process: nothing loaded yet
    const [a, b] = await Promise.all([client(), client()]);
    const ok = (id) => oauth.createAuthorization({ response_type: 'code', client_id: id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' });
    assert.match((await ok(a.client_id)).code, /^\d{6}$/);
    assert.match((await ok(b.client_id)).code, /^\d{6}$/);
    await new Promise((r) => setTimeout(r, 50));
    const saved = JSON.parse(await readFile(path.join(STATE, 'bots', 'oauth.json'), 'utf8'));
    assert.ok(saved.clients[a.client_id] && saved.clients[b.client_id], 'both registrations on disk');
  });

  test('two concurrent refreshes with one token: one wins, the other is a replay that ends the grant', async () => {
    const { c, code } = await codeFor();
    const t = await oauth.tokenRequest({ grant_type: 'authorization_code', code, client_id: c.client_id, redirect_uri: REDIRECT, code_verifier: verifier });
    const both = await Promise.allSettled([0, 1].map(() => oauth.tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: c.client_id })));
    assert.deepEqual(both.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
    assert.match(both.find((r) => r.status === 'rejected').reason.message, /already used; the grant is revoked/);
    assert.equal(await oauth.verifyAccess(both.find((r) => r.status === 'fulfilled').value.access_token), null, 'the winner dies with the grant too');
  });

  test('a made-up refresh token naming a real grant is refused and leaves the grant alone', async () => {
    const { c, code } = await codeFor();
    const t = await oauth.tokenRequest({ grant_type: 'authorization_code', code, client_id: c.client_id, redirect_uri: REDIRECT, code_verifier: verifier });
    assert.match(t.refresh_token, /^drv_rt_grant_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{22}$/);
    const grantId = t.refresh_token.slice('drv_rt_'.length).split('.')[0];
    for (const forged of [`drv_rt_${grantId}.x`, `drv_rt_${grantId}.${'A'.repeat(43)}.${'A'.repeat(22)}`, `drv_rt_${grantId}.${t.refresh_token.split('.')[1]}.${'B'.repeat(22)}`])
      await assert.rejects(oauth.tokenRequest({ grant_type: 'refresh_token', refresh_token: forged, client_id: c.client_id }), /invalid or revoked/);
    assert.ok(await oauth.verifyAccess(t.access_token), 'knowing the grant id and client id is not enough to end a grant');
    const next = await oauth.tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: c.client_id });
    assert.match(next.access_token, /^drv_at_/, 'the real token still refreshes');
  });

  test('client ids from Basic auth work, a stray secret is ignored, an unknown client is refused', async () => {
    const c = await client();
    const a = await oauth.createAuthorization({ response_type: 'code', client_id: c.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' });
    await oauth.approve(a.code, { bot: 'alpha', issuer: BASE });
    const code = new URL(oauth.authorizationStatus(a.rid).redirect).searchParams.get('code');
    await assert.rejects(oauth.tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier }, { clientId: 'drv_client_nope', clientSecret: 'x' }), (e) => e.code === 'invalid_client' && e.status === 401);
    const a2 = await oauth.createAuthorization({ response_type: 'code', client_id: c.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' });
    await oauth.approve(a2.code, { bot: 'alpha', issuer: BASE });
    const code2 = new URL(oauth.authorizationStatus(a2.rid).redirect).searchParams.get('code');
    const t = await oauth.tokenRequest({ grant_type: 'authorization_code', code: code2, redirect_uri: REDIRECT, code_verifier: verifier }, { clientId: c.client_id, clientSecret: 'anything' });
    assert.match(t.access_token, /^drv_at_/);
  });

  test('ids from requests never reach inherited names: __proto__ is just unknown', async () => {
    await assert.rejects(oauth.createAuthorization({ client_id: '__proto__' }), (e) => e.page === true && e.code === 'invalid_client');
    await assert.rejects(oauth.tokenRequest({ grant_type: 'refresh_token', refresh_token: 'x', client_id: '__proto__' }), (e) => e.code === 'invalid_client');
    await assert.rejects(oauth.revokeGrant('__proto__'), /no grant/);
    await assert.rejects(oauth.revokeGrant('constructor'), /no grant/);
    assert.equal(Object.prototype.revokedAt, undefined, 'Object.prototype untouched');
  });

  test('authorize errors: client and redirect problems stay on the page, the rest go back to the client', async () => {
    const c = await client();
    await assert.rejects(oauth.createAuthorization({ client_id: 'drv_client_nope' }), (e) => e.page === true);
    await assert.rejects(oauth.createAuthorization({ client_id: c.client_id, redirect_uri: 'https://evil.example/cb' }), (e) => e.page === true && !e.redirect);
    for (const [q, why] of [[{ response_type: 'token' }, 'unsupported_response_type'], [{ code_challenge: undefined }, 'invalid_request'], [{ code_challenge_method: 'plain' }, 'invalid_request']]) {
      const e = await authorize(c, q).catch((x) => x);
      assert.equal(e.code, why);
      const u = new URL(e.redirect);
      assert.equal(u.searchParams.get('error'), why);
      assert.equal(u.searchParams.get('state'), 'st-1');
    }
  });

  test('deny sends access_denied back; pending requests expire; at most MAX_PENDING wait', async () => {
    const c = await client();
    const a = await authorize(c);
    oauth.deny(a.code);
    const u = new URL(oauth.authorizationStatus(a.rid).redirect);
    assert.equal(u.searchParams.get('error'), 'access_denied');
    const b = await authorize(c);
    now += oauth.PENDING_TTL_MS + 1;
    assert.equal(oauth.authorizationStatus(b.rid), null);
    await assert.rejects(oauth.approve(b.code), /no pending bot authorization/);
    for (let i = 0; i < oauth.MAX_PENDING; i++) await authorize(c);
    const e = await authorize(c).catch((x) => x);
    assert.equal(e.code, 'temporarily_unavailable');
  });

  test('one address cannot take the pending approvals: the real client, from its own, still gets a code', async () => {
    const tries = [];
    for (let i = 0; i < 25; i++) tries.push(await authorize(await client(), {}, { source: '198.51.100.7' }).then(() => 'waiting', (e) => (new URL(e.redirect).searchParams.get('error'))));
    assert.deepEqual([tries.filter((x) => x === 'waiting').length, new Set(tries.filter((x) => x !== 'waiting'))], [oauth.MAX_PENDING_PER_SOURCE, new Set(['temporarily_unavailable'])], 'refusals go back to the client');
    assert.match((await authorize(await client(), {}, { source: '203.0.113.20' })).code, /^\d{6}$/, 'the real client is not locked out');
    assert.equal(oauth.pendingList().length, oauth.MAX_PENDING_PER_SOURCE + 1);
  });

  test('the same client asking again from the same address replaces its request and raises no second alert', async () => {
    const c = await client();
    const first = await authorize(c, {}, { source: '203.0.113.20' });
    const again = await authorize(c, {}, { source: '203.0.113.20' });
    assert.deepEqual([first.alert, again.alert], [true, false]);
    assert.deepEqual(oauth.pendingList().map((p) => p.code), [again.code], 'one slot, the newest code');
    assert.equal(oauth.authorizationStatus(first.rid), null, 'the earlier page reads as expired');
    assert.equal((await authorize(c, {}, { source: '192.0.2.1' })).alert, true, 'from another address it is another request');
  });

  test('approval alerts: a few per address and in all per window, then quiet until the window passes', async () => {
    const alerts = async (source, n) => { const out = []; for (let i = 0; i < n; i++) out.push((await authorize(await client(), {}, { source })).alert); return out; };
    assert.deepEqual(await alerts('198.51.100.1', 3), [true, true, false], 'per address');
    assert.deepEqual(await alerts('198.51.100.2', 2), [true, true]);
    assert.deepEqual(await alerts('198.51.100.3', 3), [true, true, false], `${oauth.ALERTS_MAX} in all`);
    assert.deepEqual(await alerts('198.51.100.4', 1), [false]);
    now += oauth.ALERT_WINDOW_MS;
    assert.deepEqual(await alerts('198.51.100.1', 1), [true]);
  });

  test('registrations and authorizations are limited per address as well as in all', async () => {
    const reg = (source) => oauth.register({ redirect_uris: [REDIRECT] }, { source });
    for (let i = 0; i < oauth.MAX_PER_MINUTE_PER_SOURCE; i++) await reg('198.51.100.9');
    await assert.rejects(reg('198.51.100.9'), (e) => e.status === 429 && /from your address/.test(e.message));
    assert.match((await reg('203.0.113.20')).client_id, /^drv_client_/, 'another address is not held back');
    const e = await authorize(await client(), {}, { source: '198.51.100.9' }).catch((x) => x);
    assert.equal(new URL(e.redirect).searchParams.get('error'), 'temporarily_unavailable', 'the authorize page counts against the same address');
    now += 60_001;
    assert.match((await reg('198.51.100.9')).client_id, /^drv_client_/, 'a minute later it may again');
  });

  test('registration churn cannot push out a client whose approval is waiting', async () => {
    const real = await client();
    const a = await authorize(real);
    for (let i = 0; i < oauth.MAX_CLIENTS + 5; i++) {
      if (i % 50 === 49) now += 60_001;   // under the per-minute limit
      await oauth.register({ redirect_uris: [REDIRECT] });
    }
    await oauth.approve(a.code, { bot: 'alpha', issuer: BASE });
    const code = new URL(oauth.authorizationStatus(a.rid).redirect).searchParams.get('code');
    const t = await oauth.tokenRequest({ grant_type: 'authorization_code', code, client_id: real.client_id, redirect_uri: REDIRECT, code_verifier: verifier });
    assert.match(t.access_token, /^drv_at_/, 'the real client is still registered');
  });

  test('approve validates the bot name and scopes', async () => {
    const c = await client();
    const a = await authorize(c);
    await assert.rejects(oauth.approve(a.code, { bot: 'Alpha Bravo' }), /short lowercase name/);
    await assert.rejects(oauth.approve(a.code, { bot: 'alpha', scopes: ['admin'] }), /scopes must be among/);
    const r = await oauth.approve(a.code, { bot: 'alpha', scopes: 'read,notify' });
    assert.deepEqual(r.scopes, ['drover.read', 'drover.notify']);
    assert.equal(r.bot, 'alpha');
  });

  test('every connection names one bot: no default, and "*" only as the explicit, read-only shared kind', async () => {
    const c = await client();
    const a = await authorize(c);   // asks for read and write
    for (const bot of [undefined, '', '  ', '*']) await assert.rejects(oauth.approve(a.code, { bot }), /name the bot this connection belongs to/, JSON.stringify(bot));
    await assert.rejects(oauth.approve(a.code, { shared: true, scopes: 'read,write' }), /read-only/);
    await assert.rejects(oauth.approve(a.code, { shared: true, bot: 'alpha' }), /name a bot or share, not both/);
    const r = await oauth.approve(a.code, { shared: true });
    assert.deepEqual([r.bot, r.scopes], ['*', ['drover.read']], 'shared gets read only, whatever the client asked for');
    assert.equal((await oauth.grantsList()).find((g) => g.grantId === r.grantId).shared, true);
    await assert.rejects(oauth.mintToken({}), /name the bot this connection belongs to/);
    await assert.rejects(oauth.mintToken({ shared: true, scopes: 'notify' }), /read-only/);
  });

  test('revoking a grant stops its tokens; the grant list never carries a token or hash', async () => {
    const { c, code } = await codeFor();
    const t = await oauth.tokenRequest({ grant_type: 'authorization_code', code, client_id: c.client_id, redirect_uri: REDIRECT, code_verifier: verifier });
    const [g] = await oauth.grantsList();
    assert.equal(g.bot, 'alpha');
    assert.equal(g.connected, true);
    const listed = JSON.stringify(await oauth.grantsList());
    assert.ok(!listed.includes(t.access_token) && !listed.includes('hash'), 'no tokens or hashes');
    await oauth.revokeGrant(g.grantId);
    assert.equal(await oauth.verifyAccess(t.access_token), null);
    assert.equal((await oauth.grantsList()).length, 0);
    assert.equal((await oauth.grantsList({ includeRevoked: true }))[0].revokedWhy, 'revoked in Drover');
  });

  test('RFC 7009: a client revoking its refresh token ends the grant; unknown tokens are fine', async () => {
    const { c, code } = await codeFor();
    const t = await oauth.tokenRequest({ grant_type: 'authorization_code', code, client_id: c.client_id, redirect_uri: REDIRECT, code_verifier: verifier });
    assert.deepEqual(await oauth.revokeToken('drv_rt_unknown', null, { client_id: c.client_id }), { revoked: false });
    assert.deepEqual(await oauth.revokeToken(t.refresh_token, null, { client_id: c.client_id }), { revoked: true });
    assert.equal(await oauth.verifyAccess(t.access_token), null);
  });

  test('static tokens: minted for a bot (or shared, read-only), verified like access tokens, expire, revocable', async () => {
    const t = await oauth.mintToken({ bot: 'alpha', scopes: 'read', note: 'chat-added server', days: 30 });
    assert.match(t.token, /^drv_pat_/);
    assert.deepEqual((await oauth.verifyAccess(t.token)).scopes, ['drover.read']);
    const shared = await oauth.mintToken({ shared: true });
    assert.equal(shared.bot, '*');
    assert.deepEqual(shared.scopes, ['drover.read'], 'a shared token is read-only');
    const listed = await oauth.grantsList();
    const mine = listed.find((g) => g.grantId === t.grantId);
    assert.equal(mine.static, true);
    assert.equal(mine.client, 'static token (chat-added server)');
    assert.equal(mine.connected, true);
    await assert.rejects(oauth.mintToken({ bot: 'alpha', days: 0 }), /days must be 1 to 365/);
    await assert.rejects(oauth.mintToken({ bot: 'Bad Name' }), /short lowercase name/);
    now += 31 * 86_400_000;
    assert.equal(await oauth.verifyAccess(t.token), null, 'expired after its days');
    assert.equal((await oauth.grantsList()).find((g) => g.grantId === t.grantId).connected, false);
    await oauth.revokeGrant(shared.grantId);
    assert.equal(await oauth.verifyAccess(shared.token), null);
  });

  test('a failed write is an error for its caller: a revocation is never reported done when it did not reach the disk', async () => {
    const { c, code } = await codeFor();
    const t = await oauth.tokenRequest({ grant_type: 'authorization_code', code, client_id: c.client_id, redirect_uri: REDIRECT, code_verifier: verifier });
    const bravo = await oauth.mintToken({ bot: 'bravo', days: 1 });
    const [alpha] = (await oauth.grantsList()).filter((g) => g.bot === 'alpha');
    const disk = oauth._deps.file;
    oauth._deps.file = () => '/dev/null/drover-test/oauth.json';   // mkdir fails: a full or read-only disk
    try {
      await assert.rejects(oauth.revokeGrant(alpha.grantId), /ENOTDIR|EEXIST|ENOENT|EACCES/);
      assert.equal(await oauth.verifyAccess(t.access_token), null, 'this process stops honoring it at once all the same');
      now += 61_000;
      assert.ok(await oauth.verifyAccess(bravo.token), 'the lastUsedAt write that fails is no unhandled rejection');
    } finally { oauth._deps.file = disk; }
    await oauth.mintToken({ bot: 'delta', days: 1 });   // the chain carries on: the next write lands, whole state included
    oauth._reset();
    assert.equal(await oauth.verifyAccess(t.access_token), null, 'the revocation reached the disk with the next write');
    assert.ok(await oauth.verifyAccess(bravo.token));
  });

  test('the state file is 0600 and holds hashes, never a token; a restart keeps grants', async () => {
    const { c, code } = await codeFor();
    const t = await oauth.tokenRequest({ grant_type: 'authorization_code', code, client_id: c.client_id, redirect_uri: REDIRECT, code_verifier: verifier });
    await oauth.verifyAccess(t.access_token);
    await new Promise((r) => setTimeout(r, 50));
    const file = path.join(STATE, 'bots', 'oauth.json');
    const text = await readFile(file, 'utf8');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.ok(!text.includes(t.access_token) && !text.includes(t.refresh_token), 'tokens are stored only as hashes');
    oauth._reset();   // a daemon restart: memory gone, file stays
    assert.equal((await oauth.verifyAccess(t.access_token))?.bot, 'alpha');
  });
});
