// Device pairing (core/pair.js and the /api/pair/* routes). The HTTP part starts the real server
// on port 0 against a temp DROVER_STATE, which must be set before server/http.js is imported.
import './isolate-cache.js';
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const STATE = await mkdtemp(path.join(tmpdir(), 'drover-pair-'));
process.env.DROVER_STATE = STATE;
process.env.DROVER_PAIR_NOTIFY = 'off';
delete process.env.DROVER_ALLOW_ORIGINS;
const pair = await import('../core/pair.js');
const http = await import('../server/http.js');
const native = await import('../core/native.js');

const TOKENS = { token: 'main-tok', widgetToken: 'widget-tok' };
let now = Date.parse('2026-10-16T05:00:00Z');
pair._deps.now = () => now;

describe('core/pair', () => {
  beforeEach(() => { pair._reset(); now = Date.parse('2026-10-16T05:00:00Z'); });

  test('a request gets a 32-hex id, a 6-digit code and a two-minute expiry', () => {
    const r = pair.createRequest({ client: 'Drover for iPhone', device: 'Alice’s iPhone' });
    assert.match(r.requestId, /^[0-9a-f]{32}$/);
    assert.match(r.code, /^\d{6}$/);
    assert.equal(Date.parse(r.expiresAt) - now, pair.TTL_MS);
    assert.deepEqual(pair.status(r.requestId, TOKENS), { status: 'pending', expiresAt: r.expiresAt });
  });

  test('approving by code hands the tokens over exactly once', () => {
    const r = pair.createRequest({ client: 'Drover for Mac' });
    assert.deepEqual(pair.approve(` ${r.code.slice(0, 3)} ${r.code.slice(3)} `), { approved: true, client: 'Drover for Mac', device: '' });
    assert.deepEqual(pair.status(r.requestId, TOKENS), { status: 'approved', token: 'main-tok', widgetToken: 'widget-tok' });
    assert.equal(pair.status(r.requestId, TOKENS), null, 'the second poll gets nothing');
    assert.throws(() => pair.approve(r.code), /no pending pairing request/);
  });

  test('a denied request says so once, then is gone', () => {
    const r = pair.createRequest({ client: 'Drover for Chrome' });
    pair.deny(r.code);
    assert.deepEqual(pair.status(r.requestId, TOKENS), { status: 'denied' });
    assert.equal(pair.status(r.requestId, TOKENS), null);
  });

  test('requests expire, and an approval near the end still leaves time to collect', () => {
    const a = pair.createRequest({ client: 'a' });
    now += pair.TTL_MS;
    assert.equal(pair.status(a.requestId, TOKENS), null, 'expired');
    assert.throws(() => pair.approve(a.code), /no pending pairing request/);
    const b = pair.createRequest({ client: 'b' });
    now += pair.TTL_MS - 1;
    pair.approve(b.code);
    now += pair.COLLECT_MS - 1;
    assert.equal(pair.status(b.requestId, TOKENS).status, 'approved');
  });

  test('the pending list never carries the request id', () => {
    const r = pair.createRequest({ client: 'Drover for iPhone', device: 'phone', from: '100.64.0.9' });
    const list = pair.pending();
    assert.equal(list.length, 1);
    assert.deepEqual(Object.keys(list[0]).sort(), ['client', 'code', 'createdAt', 'device', 'expiresAt', 'from']);
    assert.ok(!JSON.stringify(list).includes(r.requestId));
  });

  test('labels are cleaned and bounded; client is required', () => {
    const r = pair.createRequest({ client: 'Drover\u0007 for\nMac x', device: '  laptop  ' });
    assert.deepEqual(pair.pending().map((x) => [x.client, x.device]), [['Drover for Mac x', 'laptop']]);
    assert.ok(r);
    assert.throws(() => pair.createRequest({ client: '' }), (e) => e.status === 400);
    assert.throws(() => pair.createRequest({}), (e) => e.status === 400);
    assert.throws(() => pair.createRequest({ client: 7 }), (e) => e.status === 400);
    assert.throws(() => pair.createRequest({ client: 'x'.repeat(65) }), (e) => e.status === 400 && /too long/.test(e.message));
  });

  test('at most five pending, and at most twenty requests a minute', () => {
    for (let i = 0; i < pair.MAX_PENDING; i++) pair.createRequest({ client: `c${i}` });
    assert.throws(() => pair.createRequest({ client: 'one too many' }), (e) => e.status === 429);
    pair._reset();
    for (let i = 0; i < pair.MAX_PER_MINUTE; i++) { const r = pair.createRequest({ client: `c${i}` }); pair.deny(r.code); pair.status(r.requestId, TOKENS); }
    assert.throws(() => pair.createRequest({ client: 'fast' }), (e) => e.status === 429);
    now += 60_000;
    assert.ok(pair.createRequest({ client: 'later' }));
  });

  test('approve and deny want the 6 digits the device shows', () => {
    const r = pair.createRequest({ client: 'x' });
    for (const bad of [undefined, '', '12345', '1234567', 'abcdef', { code: 1 }]) assert.throws(() => pair.approve(bad), (e) => e.status === 400);
    const other = r.code === '000000' ? '111111' : '000000';
    assert.throws(() => pair.approve(other), (e) => e.status === 404);
  });

  test('unknown or malformed request ids get nothing', () => {
    for (const id of [undefined, '', 'nope', 'A'.repeat(32), '0'.repeat(31), { id: 1 }]) assert.equal(pair.status(id, TOKENS), null);
  });

  test('the macOS banner escapes what an unauthenticated client sent', () => {
    assert.equal(pair.appleString('a"b\\c'), '"a\\"b\\\\c"');
    const calls = [];
    const saved = { ...pair._deps };
    pair._deps.platform = () => 'darwin';
    pair._deps.execFile = (cmd, args) => calls.push([cmd, args]);
    process.env.DROVER_PAIR_NOTIFY = 'on';
    try {
      pair.announce({ code: '123456', client: 'evil" & do shell script "rm', device: '', from: '100.64.0.9' });
      assert.equal(calls.length, 1);
      assert.equal(calls[0][0], 'osascript');
      assert.match(calls[0][1][1], /^display notification "evil\\" & do shell script \\"rm asks to pair from 100\.64\.0\.9\. Approve only if that device shows 123 456: drover pair approve 123456, or Approve in Drover\." with title "Drover"$/);
    } finally { Object.assign(pair._deps, saved); process.env.DROVER_PAIR_NOTIFY = 'off'; }
  });
});

describe('HTTP /api/pair', () => {
  let srv, base, main, widget;
  before(async () => {
    native._deps.isDaemon = () => false;
    srv = await http.startServer({ port: 0 });
    base = srv.url.replace(/\/$/, '');
    main = srv.token;
    widget = (await readFile(path.join(STATE, 'widget-token'), 'utf8')).trim();
    pair._deps.now = () => Date.now();
  });
  after(async () => { await new Promise((r) => { srv?.server.close(r); srv?.server.closeAllConnections?.(); }); });
  beforeEach(() => pair._reset());

  const post = (p, body, { auth, headers = {} } = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...headers }, body: JSON.stringify(body) });
  const get = (p, { auth, headers = {} } = {}) => fetch(base + p, { headers: { ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...headers } });

  test('request and status need no token; the tokens arrive once, after approval', async () => {
    const r = await post('/api/pair/request', { client: 'Drover for iPhone', device: 'phone' });
    assert.equal(r.status, 201);
    const req = await r.json();
    assert.deepEqual(Object.keys(req).sort(), ['code', 'expiresAt', 'pollMs', 'requestId']);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const pending = await (await get(`/api/pair/status?requestId=${req.requestId}`)).json();
    assert.equal(pending.status, 'pending');
    assert.ok(!JSON.stringify(pending).includes(main) && !JSON.stringify(pending).includes(widget));

    const list = await (await get('/api/pair/pending', { auth: main })).json();
    assert.deepEqual(list.result.map((x) => [x.code, x.client, x.device]), [[req.code, 'Drover for iPhone', 'phone']]);
    assert.ok(!JSON.stringify(list).includes(req.requestId));

    const ok = await post('/api/pair/approve', { code: req.code }, { auth: main });
    assert.equal(ok.status, 200);
    assert.deepEqual((await ok.json()).result, { approved: true, client: 'Drover for iPhone', device: 'phone' });
    const done = await (await get(`/api/pair/status?requestId=${req.requestId}`)).json();
    assert.deepEqual(done, { status: 'approved', token: main, widgetToken: widget });
    const again = await get(`/api/pair/status?requestId=${req.requestId}`);
    assert.equal(again.status, 404);
    assert.deepEqual(await again.json(), { status: 'expired' });
  });

  test('listing, approving and denying need the main token; the widget token is refused', async () => {
    const req = await (await post('/api/pair/request', { client: 'x' })).json();
    assert.equal((await get('/api/pair/pending')).status, 401);
    assert.equal((await get('/api/pair/pending', { auth: widget })).status, 403);
    assert.equal((await post('/api/pair/approve', { code: req.code })).status, 401);
    assert.equal((await post('/api/pair/approve', { code: req.code }, { auth: widget })).status, 403);
    assert.equal((await post('/api/pair/approve', { code: req.code }, { auth: 'wrong' })).status, 401);
    assert.equal((await post('/api/pair/deny', { code: req.code }, { auth: widget })).status, 403);
    assert.equal((await get(`/api/pair/status?requestId=${req.requestId}`)).status, 200, 'still pending after the refusals');
    const denied = await post('/api/pair/deny', { code: req.code }, { auth: main });
    assert.equal(denied.status, 200);
    assert.deepEqual(await (await get(`/api/pair/status?requestId=${req.requestId}`)).json(), { status: 'denied' });
  });

  test('bad input: 400 for labels and codes, 404 for an unknown code, 429 past the cap', async () => {
    assert.equal((await post('/api/pair/request', {})).status, 400);
    assert.equal((await post('/api/pair/request', null)).status, 400);
    assert.equal((await fetch(base + '/api/pair/request', { method: 'POST', body: 'not json' })).status, 400);
    assert.equal((await post('/api/pair/approve', { code: 'abc' }, { auth: main })).status, 400);
    assert.equal((await post('/api/pair/approve', { code: '000000' }, { auth: main })).status, 404);
    for (let i = 0; i < pair.MAX_PENDING; i++) assert.equal((await post('/api/pair/request', { client: `c${i}` })).status, 201);
    assert.equal((await post('/api/pair/request', { client: 'more' })).status, 429);
    assert.equal((await get('/api/pair/status?requestId=nope')).status, 404);
  });

  test('a forwarded tailnet login is shown as a claim, never as a verified identity', async () => {
    assert.equal((await post('/api/pair/request', { client: 'x' }, { headers: { 'tailscale-user-login': 'alice@example.com' } })).status, 201);
    const [r] = (await (await get('/api/pair/pending', { auth: main })).json()).result;
    assert.match(r.from, /^(::ffff:)?127\.0\.0\.1, says tailnet user alice@example\.com$/);
    assert.ok(!/via tailnet/.test(r.from));
  });

  test('a foreign web origin cannot ask to pair; the Drover extension can', async () => {
    assert.equal((await post('/api/pair/request', { client: 'x' }, { headers: { origin: 'https://evil.example' } })).status, 403);
    const ext = await post('/api/pair/request', { client: 'Drover for Chrome' }, { headers: { origin: http.CHROME_EXTENSION_ORIGIN } });
    assert.equal(ext.status, 201);
    assert.equal(ext.headers.get('access-control-allow-origin'), http.CHROME_EXTENSION_ORIGIN);
  });

  test('pairing stays off the op table, so neither MCP nor ssh rpc can approve', async () => {
    const { OPS } = await import('../core/api.js');
    assert.ok(!OPS.some((op) => /^pair\b/.test(op)));
    const { ALL_TOOLS } = await import('../mcp/server.js');
    assert.ok(!ALL_TOOLS.some((t) => /pair/.test(t.name)));
    assert.equal((await post('/api/op/pair.approve', { code: '123456' }, { auth: main })).status, 400, 'unknown op');
  });

  test('bot approvals, revocation, tokens and Routines stay off the op table too; their routes need the main token', async () => {
    const { OPS } = await import('../core/api.js');
    assert.deepEqual(OPS.filter((op) => op.startsWith('bots.')), ['bots.status'], 'only the read-only status is an op');
    const { ALL_TOOLS } = await import('../mcp/server.js');
    assert.deepEqual(ALL_TOOLS.filter((t) => /bots/.test(t.name)).map((t) => t.name), ['drover_bots_status']);
    assert.equal((await post('/api/op/bots.approve', { code: '123456' }, { auth: main })).status, 400, 'unknown op');
    assert.equal((await post('/api/bots/approve', { code: '123456' })).status, 401);
    assert.equal((await post('/api/bots/routine', { bot: 'scout', url: 'https://x.example/h', key: 'crsr_0123456789' }, { auth: widget })).status, 403);
    assert.equal((await post('/api/bots/token', {}, { auth: widget })).status, 403);
  });

  test('a request target URL() cannot parse is a 400, not a dead daemon', async () => {
    const net = await import('node:net');
    const line = await new Promise((resolve, reject) => {
      const s = net.connect(Number(new URL(base).port), '127.0.0.1', () => s.write('GET //[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
      let data = ''; s.on('data', (d) => { data += d; }); s.on('end', () => resolve(data.split('\r\n')[0])); s.on('error', reject);
    });
    assert.match(line, /^HTTP\/1\.1 400/);
    assert.equal((await fetch(`${base}/api/pair/status?requestId=${'0'.repeat(32)}`)).status, 404, 'still serving');
  });
});
