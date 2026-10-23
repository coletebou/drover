import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBaseUrl, originPattern, createClient, ApiError, ErrorKind } from '../lib/api.js';

const TOKEN = 'test-token-not-secret';
const BASE = 'http://127.0.0.1:7337';

const reply = (status, body, { raw } = {}) => async () => ({
  status, ok: status >= 200 && status < 300,
  json: async () => { if (raw) throw new SyntaxError('bad json'); return body; },
});

async function fails(promiseFn) {
  try { await promiseFn(); } catch (e) { return e; }
  assert.fail('expected a rejection');
}
function noToken(e) {
  assert.ok(e instanceof ApiError);
  assert.ok(!e.message.includes(TOKEN), `message leaks token: ${e.message}`);
  assert.ok(!String(e.stack).includes(`Bearer ${TOKEN}`));
}

test('normalizeBaseUrl: bare host:port gets http, path and trailing slash dropped', () => {
  assert.equal(normalizeBaseUrl('127.0.0.1:7337'), 'http://127.0.0.1:7337');
  assert.equal(normalizeBaseUrl('http://demo-box:7337/'), 'http://demo-box:7337');
  assert.equal(normalizeBaseUrl('  http://demo-box:7337/some/path?x=1#y '), 'http://demo-box:7337');
});

test('normalizeBaseUrl: https kept, ftp rejected', () => {
  assert.equal(normalizeBaseUrl('https://demo-box.example:8443/x'), 'https://demo-box.example:8443');
  assert.throws(() => normalizeBaseUrl('ftp://demo-box'), (e) => e instanceof ApiError && e.kind === ErrorKind.NOT_CONFIGURED);
});

test('normalizeBaseUrl: credentials rejected without echoing them', () => {
  assert.throws(() => normalizeBaseUrl('http://user:hunter2-secret@demo-box:7337'), (e) => {
    assert.equal(e.kind, ErrorKind.NOT_CONFIGURED);
    assert.ok(!e.message.includes('hunter2-secret'));
    assert.ok(!e.message.includes('user'));
    return true;
  });
});

test('normalizeBaseUrl: empty is not-configured', () => {
  for (const v of ['', '   ', null, undefined]) {
    assert.throws(() => normalizeBaseUrl(v), (e) => e.kind === ErrorKind.NOT_CONFIGURED);
  }
});

test('originPattern keeps the port', () => {
  assert.equal(originPattern('127.0.0.1:7337'), 'http://127.0.0.1:7337/*');
  assert.equal(originPattern('https://demo-box:8443/x'), 'https://demo-box:8443/*');
});

test('createClient rejects an empty token', () => {
  for (const t of ['', '   ', undefined, 5]) {
    assert.throws(() => createClient({ baseUrl: BASE, token: t, fetch: async () => {} }), (e) => e.kind === ErrorKind.NOT_CONFIGURED);
  }
});

test('op: POSTs JSON with bearer auth and omitted credentials', async () => {
  let call;
  const c = createClient({ baseUrl: `${BASE}/`, token: ` ${TOKEN} `, fetch: async (url, init) => { call = { url, init }; return reply(200, { ok: true, result: { n: 1 } })(); } });
  const r = await c.op('native.summary', { a: 1 });
  assert.deepEqual(r, { n: 1 });
  assert.equal(c.origin, BASE);
  assert.equal(call.url, `${BASE}/api/op/native.summary`);
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(call.init.headers['content-type'], 'application/json');
  assert.equal(call.init.credentials, 'omit');
  assert.deepEqual(JSON.parse(call.init.body), { a: 1 });
  assert.ok(!call.url.includes(TOKEN));
});

test('op: 401 is unauthorized', async () => {
  const c = createClient({ baseUrl: BASE, token: TOKEN, fetch: reply(401, { error: 'unauthorized' }) });
  const e = await fails(() => c.op('native.summary'));
  assert.equal(e.kind, ErrorKind.UNAUTHORIZED); assert.equal(e.status, 401); noToken(e);
});

test('op: 403 bad origin mentions DROVER_ALLOW_ORIGINS', async () => {
  const c = createClient({ baseUrl: BASE, token: TOKEN, fetch: reply(403, { error: 'bad origin' }) });
  const e = await fails(() => c.op('native.summary'));
  assert.equal(e.kind, ErrorKind.FORBIDDEN); assert.match(e.message, /DROVER_ALLOW_ORIGINS/); noToken(e);
});

test('op: 500 with ok:false is a server error carrying the message', async () => {
  const c = createClient({ baseUrl: BASE, token: TOKEN, fetch: reply(500, { ok: false, error: 'disk on fire' }) });
  const e = await fails(() => c.op('native.summary'));
  assert.equal(e.kind, ErrorKind.SERVER); assert.equal(e.message, 'disk on fire'); assert.equal(e.op, 'native.summary'); noToken(e);
});

test('op: non-JSON is bad-response', async () => {
  const c = createClient({ baseUrl: BASE, token: TOKEN, fetch: reply(200, null, { raw: true }) });
  const e = await fails(() => c.op('native.summary'));
  assert.equal(e.kind, ErrorKind.BAD_RESPONSE); noToken(e);
});

test('op: an envelope without result is bad-response', async () => {
  const c = createClient({ baseUrl: BASE, token: TOKEN, fetch: reply(200, { ok: true }) });
  assert.equal((await fails(() => c.op('x.y'))).kind, ErrorKind.BAD_RESPONSE);
});

test('op: fetch throwing is unreachable and does not leak the token', async () => {
  const c = createClient({ baseUrl: BASE, token: TOKEN, fetch: async () => { throw new TypeError(`Failed to fetch Bearer ${TOKEN}`); } });
  const e = await fails(() => c.op('native.summary'));
  assert.equal(e.kind, ErrorKind.UNREACHABLE); assert.match(e.message, /Cannot reach/); noToken(e);
});

const hangUntilAbort = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));

test('op: timeout is unreachable with "did not answer in time"', async () => {
  const c = createClient({ baseUrl: BASE, token: TOKEN, fetch: hangUntilAbort, timeoutMs: 20 });
  const e = await fails(() => c.op('native.summary'));
  assert.equal(e.kind, ErrorKind.UNREACHABLE); assert.match(e.message, /did not answer in time/); noToken(e);
});

test('op: an external AbortSignal cancels the call', async () => {
  const c = createClient({ baseUrl: BASE, token: TOKEN, fetch: hangUntilAbort, timeoutMs: 5000 });
  const ctl = new AbortController();
  const p = fails(() => c.op('native.summary', {}, { signal: ctl.signal }));
  setTimeout(() => ctl.abort(), 10);
  const e = await p;
  assert.equal(e.kind, ErrorKind.UNREACHABLE); assert.doesNotMatch(e.message, /in time/); noToken(e);
});

test('op: a token-like string in a server error is redacted', async () => {
  const leak = 'a'.repeat(20) + 'B'.repeat(20);
  assert.equal(leak.length, 40);
  const c = createClient({ baseUrl: BASE, token: TOKEN, fetch: reply(500, { ok: false, error: `bad token ${leak} given` }) });
  const e = await fails(() => c.op('native.summary'));
  assert.ok(!e.message.includes(leak));
  assert.match(e.message, /\[redacted\]/); noToken(e);
});

test('op: a 403 with a custom error is redacted too', async () => {
  const leak = 'x1'.repeat(20);
  const c = createClient({ baseUrl: BASE, token: TOKEN, fetch: reply(403, { error: `refused ${leak}` }) });
  const e = await fails(() => c.op('sessions.message'));
  assert.equal(e.kind, ErrorKind.FORBIDDEN); assert.ok(!e.message.includes(leak));
});

test('op: bad op names are rejected before fetching', async () => {
  let called = false;
  const c = createClient({ baseUrl: BASE, token: TOKEN, fetch: async () => { called = true; } });
  for (const name of ['../etc', 'a b', 'x?y=1', '', 'a/b']) {
    const e = await fails(() => c.op(name));
    assert.equal(e.kind, ErrorKind.BAD_RESPONSE); noToken(e);
  }
  assert.equal(called, false);
});

test('streamRequest: URL and auth header', () => {
  const c = createClient({ baseUrl: `${BASE}/x`, token: TOKEN, fetch: async () => {} });
  const r = c.streamRequest();
  assert.equal(r.url, `${BASE}/api/stream`);
  assert.equal(r.init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(r.init.headers.accept, 'text/event-stream');
  assert.equal(r.init.credentials, 'omit');
  assert.ok(!r.url.includes(TOKEN));
});
