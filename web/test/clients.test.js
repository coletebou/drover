// Recently seen clients (core/clients.js and GET /api/clients). The HTTP part starts the real server on
// port 0 against a temp DROVER_STATE, which must be set before server/http.js is imported.
import './isolate-cache.js';
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const STATE = await mkdtemp(path.join(tmpdir(), 'drover-clients-'));
process.env.DROVER_STATE = STATE;
process.env.DROVER_PAIR_NOTIFY = 'off';
delete process.env.DROVER_ALLOW_ORIGINS;
const clients = await import('../core/clients.js');
const http = await import('../server/http.js');
const native = await import('../core/native.js');

const WATCH = 'DroverWatch/1 CFNetwork/3826.400.120 Darwin/25.0.0';

describe('core/clients', () => {
  let now;
  beforeEach(() => { clients._reset(); now = Date.parse('2026-10-16T07:00:00Z'); clients._deps.now = () => now; });

  test('appOf names the native app or the browser', () => {
    assert.equal(clients.appOf(WATCH), 'DroverWatch');
    assert.equal(clients.appOf('Drover/1 CFNetwork/3826.400.120 Darwin/25.0.0'), 'Drover');
    assert.equal(clients.appOf('DroverMenuBar/1 CFNetwork/1568 Darwin/25.6.0'), 'DroverMenuBar');
    assert.equal(clients.appOf('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0 Safari/537.36'), 'Chrome');
    assert.equal(clients.appOf('Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15'), 'Safari');
    assert.equal(clients.appOf('node'), 'node');
    assert.equal(clients.appOf(undefined), '(none)');
  });

  test('a browser extension is told apart from a tab by its origin; a page origin is ignored', () => {
    const SAFARI = 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15';
    const CHROME = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0 Safari/537.36';
    assert.equal(clients.extensionOf('safari-web-extension://13707CEF-A1CC-4C81-9088-E12214C019A6'), 'safari-web-extension://13707CEF-A1CC-4C81-9088-E12214C019A6');
    assert.equal(clients.extensionOf('http://127.0.0.1:7337'), '');
    assert.equal(clients.extensionOf('chrome-extension://abc/../x'), '');
    assert.equal(clients.appOf(SAFARI, 'safari-web-extension://13707CEF'), 'Safari extension');
    assert.equal(clients.appOf(CHROME, 'chrome-extension://pbcfbpefenbfkhkdfflnapdlfglfanoj'), 'Chrome extension');
    clients.record({ userAgent: CHROME, origin: 'http://127.0.0.1:7337', scope: 'main', via: 'local' });
    clients.record({ userAgent: CHROME, scope: 'main', via: 'local' });
    clients.record({ userAgent: CHROME, origin: 'chrome-extension://pbcfbpefenbfkhkdfflnapdlfglfanoj', scope: 'main', via: 'local' });
    assert.deepEqual(clients.recent().map((c) => [c.app, c.requests]), [['Chrome extension', 1], ['Chrome', 2]]);
  });

  test('requests from one client add up; the newest client comes first', () => {
    clients.record({ userAgent: WATCH, scope: 'widget', via: 'tailnet' });
    now += 1000;
    clients.record({ userAgent: 'curl/8.7.1', scope: 'main', via: 'local' });
    now += 1000;
    clients.record({ userAgent: WATCH, scope: 'widget', via: 'tailnet' });
    const list = clients.recent();
    assert.deepEqual(list.map((c) => [c.app, c.via, c.scope, c.requests]), [['DroverWatch', 'tailnet', 'widget', 2], ['curl', 'local', 'main', 1]]);
    assert.equal(list[0].lastSeen, new Date(now).toISOString());
  });

  test('only the last day is listed, at most 64 clients are kept, and control characters are dropped', () => {
    clients.record({ userAgent: 'old/1', scope: 'main', via: 'local' });
    now += 24 * 60 * 60 * 1000 + 1;
    for (let i = 0; i < 70; i++) clients.record({ userAgent: `app${i}/1`, scope: 'main', via: 'local' });
    const list = clients.recent();
    assert.equal(list.length, 64);
    assert.ok(!list.some((c) => c.userAgent === 'old/1'));
    clients.record({ userAgent: 'evil\u0007\nname/1', scope: 'main', via: 'local' });
    assert.equal(clients.recent()[0].userAgent, 'evil  name/1');
  });
});

describe('HTTP /api/clients', () => {
  let srv, base, main, widget;
  before(async () => {
    native._deps.isDaemon = () => false;
    clients._deps.now = () => Date.now();
    srv = await http.startServer({ port: 0 });
    base = srv.url.replace(/\/$/, '');
    main = srv.token;
    widget = (await readFile(path.join(STATE, 'widget-token'), 'utf8')).trim();
  });
  after(async () => { await new Promise((r) => { srv?.server.close(r); srv?.server.closeAllConnections?.(); }); });
  beforeEach(() => clients._reset());

  test('authenticated requests are recorded with their scope, route and extension; the list needs the main token', async () => {
    // A widget request outside its scope is refused, but it still shows the app reached the daemon with a valid token.
    // (Not native.summary: that reads live sessions, and spawns codex.)
    const refused = await fetch(base + '/api/ops', { headers: { authorization: `Bearer ${widget}`, 'user-agent': WATCH, 'tailscale-user-login': 'alice@example.com' } });
    assert.equal(refused.status, 403);
    await fetch(base + '/api/ops', { headers: { authorization: `Bearer ${main}`, origin: http.CHROME_EXTENSION_ORIGIN, 'user-agent': 'Mozilla/5.0 Chrome/142.0 Safari/537.36' } });
    await fetch(base + '/api/ops', { headers: { 'user-agent': 'nobody/1' } });   // 401, not recorded
    assert.equal((await fetch(base + '/api/clients')).status, 401);
    assert.equal((await fetch(base + '/api/clients', { headers: { authorization: `Bearer ${widget}` } })).status, 403);
    const r = await fetch(base + '/api/clients', { headers: { authorization: `Bearer ${main}`, 'user-agent': 'drover-cli/1' } });
    assert.equal(r.status, 200);
    const list = (await r.json()).result;
    const watch = list.find((c) => c.app === 'DroverWatch');
    assert.ok(watch, 'the watch request is listed');
    assert.deepEqual([watch.via, watch.scope, watch.requests], ['tailnet', 'widget', 1]);
    assert.equal(list.find((c) => c.app === 'Chrome extension')?.extension, http.CHROME_EXTENSION_ORIGIN);
    assert.ok(!list.some((c) => c.app === 'nobody'), 'an unauthenticated request is not recorded');
    assert.ok(!JSON.stringify(list).includes(main) && !JSON.stringify(list).includes(widget), 'no token in the list');
  });
});
