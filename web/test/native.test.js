// Native client ops (core/native.js) and the widget-token / origin / bind guards in server/http.js.
// Synthetic data only; no tmux, ssh or live daemon. The HTTP part starts the real server on port 0
// against a temp DROVER_STATE, which must be set before server/http.js is imported.
import './isolate-cache.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const STATE = await mkdtemp(path.join(tmpdir(), 'drover-native-'));
process.env.DROVER_STATE = STATE;
delete process.env.DROVER_ALLOW_ORIGINS;
const native = await import('../core/native.js');
const http = await import('../server/http.js');
const { headline, toIso, buildSummary, buildNotifications, notificationKind, ops, _deps } = native;

const NOW = Date.parse('2026-10-11T22:00:00Z');

describe('headline', () => {
  test('clips to 140 including the ellipsis and collapses whitespace', () => {
    const h = headline('x'.repeat(300));
    assert.equal(h.length, 140);
    assert.ok(h.endsWith('…'));
    assert.equal(h.slice(0, 139), 'x'.repeat(139));
    assert.equal(headline('a  b\n\n c\t d'), 'a b c d');
    assert.equal(headline('y'.repeat(140)), 'y'.repeat(140));
    assert.equal(headline(null), '');
    assert.equal(headline(''), '');
  });
  test('strips ANSI escapes and control characters', () => {
    assert.equal(headline('\x1b[31mred\x1b[0m \x07bell\x00 ok'), 'red bell ok');
  });
  test('redacts secret-looking substrings', () => {
    const cases = {
      bearer: ['Authorization: Bearer abcDEF123.xyz-tok', 'abcDEF123'],
      sk: ['key sk-abcdefghij1234567890 here', 'sk-abcdefghij'],
      ghp: ['push with ghp_AbCdEf1234567890 now', 'ghp_AbCdEf'],
      gho: ['use gho_AbCdEf1234567890', 'gho_AbCdEf'],
      glpat: ['glpat-abc_DEF-123456 leaked', 'glpat-abc'],
      slack: ['xoxb-123-456-abcdef in log', 'xoxb-123'],
      aws: ['AKIA' + 'ABCDEFGHIJKLMNOP is the id', 'AKIAABCDEFGH'],
      kv: ['password = hunter2hunter2 ok', 'hunter2'],
      kv2: ['api_key: s3cr3tvalue', 's3cr3tvalue'],
      long: ['blob ' + 'aB3'.repeat(14) + ' end', 'aB3aB3aB3aB3'],
    };
    for (const [name, [input, secret]] of Object.entries(cases)) {
      const out = headline(input);
      assert.ok(out.includes('[redacted]'), `${name}: ${out}`);
      assert.ok(!out.includes(secret), `${name} leaked: ${out}`);
    }
    assert.equal(headline('password: abc'), 'password: [redacted]');
    const quoted = { '{"password":"hunter2"}': 'hunter2', "{'token': 'abc def'}": 'abc def', 'api_key = "x y" done': 'x y', 'passwd=zzz9': 'zzz9', 'authorization: foo': 'foo' };
    for (const [input, secret] of Object.entries(quoted)) {
      const out = headline(input);
      assert.ok(out.includes('[redacted]') && !out.includes(secret), out);
    }
    assert.equal(headline('{"password":"hunter2"} ok'), '{"password":[redacted]} ok');
    assert.equal(headline('died in /Users/x/code/demo'), 'died in ~/code/demo');
    assert.equal(headline('a'.repeat(40)), 'a'.repeat(40), 'letters only is not a secret');
  });
});

describe('toIso', () => {
  test('ms, seconds, ISO and junk', () => {
    assert.equal(toIso(NOW), '2026-10-11T22:00:00.000Z');
    assert.equal(toIso(NOW / 1000), '2026-10-11T22:00:00.000Z');
    assert.equal(toIso('2026-10-11T22:00:00Z'), '2026-10-11T22:00:00.000Z');
    assert.equal(toIso(null), null);
    assert.equal(toIso(undefined), null);
    assert.equal(toIso('nope'), null);
  });
});

describe('buildSummary', () => {
  const sess = (id, name, status, extra = {}) => ({ id, sessionId: id, name, live: true, status, engine: 'claude', cwd: '/Users/x/secret-project', tmux: `demo:@9${id.charCodeAt(1)}.%1`, ...extra });
  const fleet = {
    ts: NOW,
    hosts: [
      {
        host: 'local', ok: true,
        sessions: [
          sess('s1', 'demo-build', 'idle', { statusUpdatedAt: NOW - 600_000 }),
          sess('s2', 'demo-review', 'idle', { statusUpdatedAt: NOW - 700_000 }),
          sess('s3', 'demo-work', 'busy'),
          sess('s4', 'demo-idle', 'idle'),
        ],
        windows: [
          { target: 'demo:@2', name: 'w1', cwd: '/Users/x/p', screen: { state: 'dialog' }, dialog: { question: 'Run rm -rf build? token=abcd1234secretvalue', options: [{ n: 1, label: 'Yes' }] }, agent: { sessionId: 's1' }, tail: ['ignored'], activityTs: NOW - 120_000 },
          { target: 'demo:@3', name: 'w3', screen: { state: 'busy' }, agent: { sessionId: 's3' }, tail: ['compiling', '', 'linking objects', ''] },
        ],
      },
      { host: 'demo-box', ok: true, sessions: [sess('m1', 'manager', 'idle', { engine: 'openclaw' })], windows: [] },
      { host: 'demo-lab', ok: false, sessions: [], windows: [] },
    ],
  };
  // statusUpdatedAt of s2 precedes the alert, so the ask stands.
  const alerts = [
    { id: 'a1', ts: new Date(NOW - 300_000).toISOString(), category: 'needs-you', kind: 'hook', sessionId: 's2', title: 'demo-review', body: 'needs you', ask: { kind: 'question', label: 'asked you a question', text: 'Ship it now?', options: [] }, host: 'local' },
    { id: 'a2', ts: new Date(NOW - 100_000).toISOString(), category: 'manager', kind: 'note', title: 'manager', body: 'swept' },
    { id: 'a3', ts: new Date(NOW - 50_000).toISOString(), category: 'needs-you', kind: 'hook', sessionId: 's4', title: 'x', body: 'muted one', muted: true },
  ];
  const sum = buildSummary(fleet, alerts, { now: NOW });

  test('stopped: opt-in; idle sessions in a tmux window that stopped within the window, newest first; no helpers, no leaks', () => {
    const HOUR = 3600_000;
    const fl = { hosts: [{ host: 'local', ok: true, windows: [], sessions: [
      sess('t1', 'old-idle', 'idle', { statusUpdatedAt: NOW - 13 * HOUR, entrypoint: 'cli' }),
      sess('t2', 'recent-idle', 'idle', { statusUpdatedAt: NOW - 2 * HOUR, entrypoint: 'cli' }),
      sess('t3', 'newest-idle', 'idle', { statusUpdatedAt: NOW - 20 * 60_000, entrypoint: 'cli' }),
      sess('t4', 'reflector-x', 'idle', { statusUpdatedAt: NOW - HOUR, entrypoint: 'sdk-cli' }),
      sess('t5', 'no-window', 'idle', { statusUpdatedAt: NOW - HOUR, tmux: null }),
      sess('t6', 'busy-one', 'busy', { statusUpdatedAt: NOW - HOUR }),
      sess('t7', 'manager', 'idle', { engine: 'openclaw', statusUpdatedAt: NOW - HOUR }),
    ] }] };
    const got = buildSummary(fl, [], { now: NOW, stoppedWithinMs: 12 * HOUR });
    assert.deepEqual(got.stopped.map((x) => x.id), ['t3', 't2']);
    for (const x of got.stopped) assert.deepEqual(Object.keys(x).sort(), ['engine', 'host', 'id', 'name', 'stoppedAt']);
    assert.equal(got.stopped[0].stoppedAt, new Date(NOW - 20 * 60_000).toISOString());
    assert.ok(!/secret-project|\/Users\/|demo:@|%1/.test(JSON.stringify(got.stopped)), 'no paths or tmux targets');
    assert.equal(got.totals.idle, buildSummary(fl, [], { now: NOW }).totals.idle, 'the idle count is the same with or without stopped');
    assert.equal('stopped' in buildSummary(fl, [], { now: NOW }), false, 'the widgets see no new key');
  });

  test('exact key sets, nothing leaks', () => {
    assert.deepEqual(Object.keys(sum).sort(), ['generatedAt', 'hosts', 'manager', 'totals', 'waiting', 'working']);
    // A waiting item may also carry how to answer it (answerFields: answer, dialog, hash, keys), and nothing else.
    const base = ['engine', 'headline', 'host', 'id', 'kind', 'name', 'since'], answer = ['answer', 'dialog', 'hash', 'keys'];
    for (const w of sum.waiting) { const keys = Object.keys(w); assert.deepEqual(base.filter((k) => !keys.includes(k)), []); assert.deepEqual(keys.filter((k) => !base.includes(k) && !answer.includes(k)), []); }
    assert.deepEqual(Object.keys(sum.waiting[0]).filter((k) => answer.includes(k)).sort(), ['answer', 'dialog', 'keys'], 'a dialog on screen (this fixture has no screen hash)');
    for (const w of sum.working) assert.deepEqual(Object.keys(w).sort(), ['engine', 'headline', 'host', 'id', 'name']);
    for (const h of sum.hosts) assert.deepEqual(Object.keys(h).sort(), ['idle', 'name', 'up', 'waiting', 'working']);
    assert.deepEqual(Object.keys(sum.totals).sort(), ['hosts', 'idle', 'waiting', 'working']);
    assert.deepEqual(Object.keys(sum.manager).sort(), ['lastNoteAt', 'up']);
    const text = JSON.stringify(sum);
    const odd = buildSummary({ hosts: [{ host: 'local', ok: true, sessions: [sess('s3', 'build /Users/x/p token=abcd1234 \x1b[1mz', 'busy'), sess('s5abcdefgh', '', 'busy')], windows: [] }] }, [], { now: NOW });
    assert.deepEqual(odd.working.map((w) => w.name), ['build ~/p token=[redacted] z', 's5abcdef']);
    assert.ok(!/secret-project|\/Users\/|demo:@|%1|abcd1234secretvalue/.test(text), text);
    assert.equal(sum.generatedAt, '2026-10-11T22:00:00.000Z');
  });
  test('waiting: dialog is a decision, an ask question is a question, oldest first', () => {
    assert.deepEqual(sum.waiting.map((w) => [w.name, w.kind]), [['demo-build', 'decision'], ['demo-review', 'question']]);
    assert.equal(sum.waiting[1].headline, 'Ship it now?');
    assert.ok(sum.waiting[0].headline.includes('rm -rf build'));
    assert.ok(sum.waiting[0].headline.includes('[redacted]'));
    assert.equal(sum.waiting[0].host, 'local');
    assert.equal(sum.waiting[0].engine, 'claude');
    assert.match(sum.waiting[0].since, /^\d{4}-\d\d-\d\dT.*Z$/);
  });
  test('working, idle, hosts, totals', () => {
    assert.deepEqual(sum.working.map((w) => [w.name, w.headline]), [['demo-work', 'linking objects']]);
    assert.deepEqual(sum.hosts, [
      { name: 'local', up: true, waiting: 2, working: 1, idle: 1 },
      { name: 'demo-box', up: true, waiting: 0, working: 0, idle: 1 },
      { name: 'demo-lab', up: false, waiting: 0, working: 0, idle: 0 },
    ]);
    assert.deepEqual(sum.totals, { waiting: 2, working: 1, idle: 2, hosts: 3 });
  });
  test('manager state', () => {
    assert.deepEqual(sum.manager, { up: true, lastNoteAt: new Date(NOW - 100_000).toISOString() });
    const none = buildSummary({ hosts: [{ host: 'local', ok: true, sessions: [], windows: [] }] }, [], { now: NOW });
    assert.deepEqual(none.manager, { up: false, lastNoteAt: null });
    const fromFeed = buildSummary({ hosts: [] }, alerts, { now: NOW, managerLastNoteAt: new Date(NOW - 10_000).toISOString() });
    assert.equal(fromFeed.manager.lastNoteAt, new Date(NOW - 10_000).toISOString());
  });
  test('test and muted alerts do not make a session wait', () => {
    const s = buildSummary({ hosts: [{ host: 'local', ok: true, sessions: [sess('s4', 'demo-idle', 'idle')], windows: [] }] }, [alerts[2], { ...alerts[0], sessionId: 's4', test: true }], { now: NOW });
    assert.equal(s.totals.waiting, 0);
  });
});

describe('notifications', () => {
  test('notificationKind mapping', () => {
    const k = notificationKind;
    assert.equal(k({ category: 'finished', ask: { kind: 'question' } }), 'question');
    assert.equal(k({ category: 'needs-you', ask: { kind: 'decision' } }), 'decision');
    assert.equal(k({ category: 'needs-you', ask: { kind: 'finished' } }), 'finished');
    assert.equal(k({ category: 'needs-you', kind: 'agent' }), 'question');
    assert.equal(k({ category: 'needs-you', kind: 'hook' }), 'decision');
    assert.equal(k({ category: 'held' }), 'decision');
    assert.equal(k({ category: 'finished' }), 'finished');
    for (const c of ['error', 'mr', 'launch', 'manager']) assert.equal(k({ category: c }), c);
    assert.equal(k({ category: 'other' }), 'other');
    assert.equal(k({}), 'decision');
  });
  const mk = (i, over = {}) => ({ id: `n${i}`, ts: new Date(NOW + i * 1000).toISOString(), category: 'finished', title: `t${i}`, body: `b${i}`, ...over });
  const five = [mk(3), mk(1), mk(5), mk(2), mk(4)];
  test('muted dropped, oldest first, item shape, test flag only when test', () => {
    const r = buildNotifications([mk(2), mk(1, { muted: true }), mk(3, { test: true, sessionId: 's', host: 'h' })], { now: NOW });
    assert.deepEqual(r.items.map((x) => x.id), ['n2', 'n3']);
    assert.deepEqual(Object.keys(r.items[0]).sort(), ['at', 'body', 'category', 'host', 'id', 'kind', 'sessionId', 'title']);
    assert.deepEqual(Object.keys(r.items[1]).sort(), ['at', 'body', 'category', 'host', 'id', 'kind', 'sessionId', 'test', 'title']);
    assert.equal(r.items[0].sessionId, null);
  });
  const dec = (c) => JSON.parse(Buffer.from(c.slice(3), 'base64url').toString('utf8'));
  const ids = (r) => r.items.map((x) => x.id);
  test('cursor is opaque c1.; a no-cursor poll takes the newest and marks older ones seen', () => {
    const p0 = buildNotifications(five, { limit: 2, now: NOW });
    assert.deepEqual(ids(p0), ['n4', 'n5']);
    assert.match(p0.cursor, /^c1\./);
    assert.equal(dec(p0.cursor).t, Date.parse(mk(5).ts));
    const p1 = buildNotifications(five, { since: p0.cursor, now: NOW });
    assert.deepEqual(ids(p1), []);
    assert.deepEqual(ids(buildNotifications([...five, mk(6)], { since: p1.cursor, now: NOW })), ['n6']);
  });
  test('equal timestamps with limit 1 are both delivered across two polls', () => {
    const ring = [mk(1), mk(1, { id: 'twin' })];
    const start = buildNotifications([], { now: NOW - 1000 }).cursor;
    const a = buildNotifications(ring, { since: start, limit: 1, now: NOW });
    const b = buildNotifications(ring, { since: a.cursor, limit: 1, now: NOW });
    const c = buildNotifications(ring, { since: b.cursor, limit: 1, now: NOW });
    assert.deepEqual([...ids(a), ...ids(b)].sort(), ['n1', 'twin']);
    assert.deepEqual(c.items, []);
  });
  test('a late item with an older ts is delivered once, on the next poll', () => {
    const ring = [mk(10), mk(20)];
    const a = buildNotifications(ring, { now: NOW });
    ring.push(mk(15, { id: 'late' }));
    const b = buildNotifications(ring, { since: a.cursor, now: NOW });
    assert.deepEqual(ids(b), ['late']);
    assert.deepEqual(ids(buildNotifications(ring, { since: b.cursor, now: NOW })), []);
    ring.push(mk(-4000, { id: 'ancient' }));   // far older than the 5 minute lookback: not resurrected
    assert.deepEqual(ids(buildNotifications(ring, { since: b.cursor, now: NOW })), []);
  });
  test('repeating a poll with the same cursor is idempotent', () => {
    const a = buildNotifications(five, { limit: 2, now: NOW });
    const x = buildNotifications([...five, mk(6)], { since: a.cursor, now: NOW });
    const y = buildNotifications([...five, mk(6)], { since: a.cursor, now: NOW });
    assert.deepEqual(x, y);
  });
  test('legacy ISO since still works (strictly newer only) and a bad cursor acts like none', () => {
    assert.deepEqual(ids(buildNotifications(five, { since: mk(3).ts, limit: 1, now: NOW })), ['n4']);
    assert.deepEqual(ids(buildNotifications(five, { since: mk(3).ts, now: NOW })), ['n4', 'n5']);
    assert.deepEqual(ids(buildNotifications(five, { since: 'c1.%%%', limit: 2, now: NOW })), ['n4', 'n5']);
    assert.deepEqual(ids(buildNotifications(five, { since: 'garbage', limit: 2, now: NOW })), ['n4', 'n5']);
    assert.deepEqual(ids(buildNotifications(five, { since: 'c1.' + Buffer.from('{"t":"x"}').toString('base64url'), limit: 1, now: NOW })), ['n5']);
  });
  test('cursor when nothing is returned', () => {
    assert.equal(dec(buildNotifications(five, { since: mk(5).ts, now: NOW }).cursor).t, Date.parse(mk(5).ts));
    assert.equal(dec(buildNotifications([], { now: NOW }).cursor).t, NOW);
    assert.deepEqual(buildNotifications([], { now: NOW }).items, []);
  });
  test('seen list is capped', () => {
    const many = Array.from({ length: 300 }, (_, i) => mk(i / 10, { id: `m${i}` }));
    assert.ok(dec(buildNotifications(many, { limit: 200, now: NOW }).cursor).s.length <= 200);
  });
  test('text is cleaned', () => {
    const r = buildNotifications([mk(1, { title: 'x'.repeat(300), body: 'token=' + 'abc123def456' + ' \x1b[1mbold\x1b[0m' })], { now: NOW });
    assert.equal(r.items[0].title.length, 200);
    assert.equal(r.items[0].body, 'token=[redacted] bold');
  });
  test('home paths shrink to ~', () => {
    const r = buildNotifications([mk(1, { body: 'session died in /Users/x/code/demo and /home/bob/w' })], { now: NOW });
    assert.equal(r.items[0].body, 'session died in ~/code/demo and ~/w');
  });
});

describe('ops with stubbed deps', () => {
  const saved = { ..._deps };
  after(() => Object.assign(_deps, saved));
  test('native.summary dispatches fleet, alerts and the feed', async () => {
    const calls = [];
    _deps.now = () => NOW;
    _deps.dispatch = async (op, args) => {
      calls.push(op);
      if (op === 'fleet.summary') return { ts: NOW, hosts: [{ host: 'local', ok: true, sessions: [], windows: [] }] };
      if (op === 'notify.recent') throw new Error('down');
      if (op === 'openclaw.feed') return [{ ts: new Date(NOW - 5000).toISOString() }];
      throw new Error(op);
    };
    const r = await ops['native.summary']();
    assert.deepEqual(calls.sort(), ['fleet.summary', 'notify.recent', 'openclaw.feed']);
    assert.equal(r.totals.hosts, 1);
    assert.equal(r.manager.lastNoteAt, new Date(NOW - 5000).toISOString());
    assert.equal('stopped' in r, false);
    assert.deepEqual((await ops['native.summary']({ stopped: true })).stopped, [], 'stopped: true adds the list');
    await assert.rejects(ops['native.summary']({ stopped: 'yes' }), /stopped must be a boolean/);
    await assert.rejects(ops['native.summary']({ stopped: true, stoppedHours: 100 }), /stoppedHours must be 1 to 48/);
  });
  test('native.notifications long poll returns the new item', async () => {
    const ring = [];
    let listener = null;
    _deps.dispatch = async () => ({ items: [...ring] });
    _deps.isDaemon = () => true;
    _deps.subscribe = (fn) => { listener = fn; return () => { listener = null; }; };
    setTimeout(() => { ring.push({ id: 'z', ts: new Date(NOW).toISOString(), category: 'error', title: 'boom', body: 'it broke' }); listener?.([]); }, 50);
    const r = await ops['native.notifications']({ wait: 5 });
    assert.deepEqual(r.items.map((x) => [x.id, x.kind]), [['z', 'error']]);
    assert.equal(listener, null, 'unsubscribed');
  });
  test('native.notifications waits then returns empty; no wait when not the daemon', async () => {
    let subs = 0;
    _deps.dispatch = async () => ({ items: [] });
    _deps.isDaemon = () => true;
    _deps.subscribe = () => { subs++; return () => { subs--; }; };
    const t0 = Date.now();
    const r = await ops['native.notifications']({ wait: 0.2 });
    assert.ok(Date.now() - t0 >= 150);
    assert.deepEqual(r.items, []);
    assert.equal(subs, 0);
    _deps.isDaemon = () => false;
    const t1 = Date.now();
    await ops['native.notifications']({ wait: 2 });
    assert.ok(Date.now() - t1 < 500);
    await assert.rejects(ops['native.notifications']({ since: 5 }), /since must be a string/);
    await assert.rejects(ops['native.notifications']({ wait: 'abc' }), /wait must be a number/);
  });
});

describe('guards (pure)', () => {
  test('isLoopback', () => {
    for (const a of ['127.0.0.1', '127.1.2.3', '::1', 'localhost', '::ffff:127.0.0.1']) assert.equal(http.isLoopback(a), true, a);
    for (const a of ['0.0.0.0', '100.64.0.1', '192.168.1.5', '::', '1127.0.0.1', '128.0.0.1', '', undefined]) assert.equal(http.isLoopback(a), false, String(a));
  });
  test('allowedOrigins drops wildcards and blanks', () => {
    const s = http.allowedOrigins({ DROVER_ALLOW_ORIGINS: ' chrome-extension://abc , ,*, https://*.x.com,https://ok.example ' });
    assert.deepEqual([...s].sort(), [http.CHROME_EXTENSION_ORIGIN, 'chrome-extension://abc', 'https://ok.example'].sort());
    assert.deepEqual([...http.allowedOrigins({})], [http.CHROME_EXTENSION_ORIGIN], 'the Drover extension needs no env');
  });
  test('the Chrome manifest key yields the extension id the daemon allows', async () => {
    const { createHash } = await import('node:crypto');
    const manifest = JSON.parse(await readFile(new URL('../../native/Extensions/chrome/manifest.json', import.meta.url), 'utf8'));
    const hex = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32);
    const id = [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
    assert.equal(`chrome-extension://${id}`, http.CHROME_EXTENSION_ORIGIN);
  });
});

describe('http', () => {
  let srv, base, main, widget;
  const get = (p, { auth, headers = {} } = {}) => fetch(base + p, { headers: { ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...headers } });
  before(async () => {
    // First: a non-loopback bind with no token file yet is refused, and creates nothing.
    await assert.rejects(http.startServer({ bind: '100.64.0.1', port: 0 }), /refusing to bind/);
    assert.ok(!existsSync(path.join(STATE, 'token')) && !existsSync(path.join(STATE, 'widget-token')));
    _deps.dispatch = async (op) => (op === 'fleet.summary' ? { ts: NOW, hosts: [] } : op === 'notify.recent' ? { items: [] } : []);
    _deps.isDaemon = () => false;
    srv = await http.startServer({ port: 0 });
    base = srv.url.replace(/\/$/, '');
    main = srv.token;
    widget = (await readFile(path.join(STATE, 'widget-token'), 'utf8')).trim();
  });
  after(async () => {
    await new Promise((r) => { srv?.server.close(r); srv?.server.closeAllConnections?.(); });
  });

  test('main token reads native.summary; widget token reads both native ops', async () => {
    let r = await get('/api/op/native.summary', { auth: main });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys((await r.json()).result).sort(), ['generatedAt', 'hosts', 'manager', 'owner', 'totals', 'waiting', 'working']);
    r = await get('/api/op/native.summary', { auth: widget });
    assert.equal(r.status, 200);
    r = await get('/api/op/native.notifications?limit=5', { auth: widget });
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).result.items, []);
  });
  test('widget token is read-only scope everywhere else', async () => {
    for (const p of ['/api/op/sessions.list', '/api/stream', '/api/events', '/api/ops']) {
      const r = await get(p, { auth: widget });
      assert.equal(r.status, 403, p);
      assert.equal((await r.json()).error, 'widget token: read-only scope');
    }
  });
  test('widget token in the query string and no token are rejected', async () => {
    assert.equal((await get(`/api/op/native.summary?token=${widget}`)).status, 401);
    assert.equal((await get('/api/op/native.summary')).status, 401);
    assert.equal((await get('/api/op/native.summary', { auth: 'wrong' })).status, 401);
    assert.equal((await get(`/api/op/native.summary?token=${main}`)).status, 200);
  });
  test('main token still reaches /api/ops and the /api/events alias', async () => {
    assert.equal((await get('/api/ops', { auth: main })).status, 200);
    const ac = new AbortController();
    const r = await fetch(base + '/api/events', { headers: { authorization: `Bearer ${main}` }, signal: ac.signal });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /event-stream/);
    ac.abort();
  });
  test('DROVER_ALLOW_ORIGINS: allowlisted origin gets an exact CORS echo, others get 403', async () => {
    const origin = 'chrome-extension://abc';
    let r = await get('/api/op/native.summary', { auth: widget, headers: { origin } });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).error, 'bad origin');
    process.env.DROVER_ALLOW_ORIGINS = `${origin},*`;
    try {
      r = await get('/api/op/native.summary', { auth: widget, headers: { origin } });
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('access-control-allow-origin'), origin);
      assert.equal(r.headers.get('vary'), 'Origin');
      r = await get('/api/op/native.summary', { auth: widget, headers: { origin: 'chrome-extension://other' } });
      assert.equal(r.status, 403);
      r = await fetch(base + '/api/op/native.summary', { method: 'OPTIONS', headers: { origin } });
      assert.equal(r.status, 204);
      assert.equal(r.headers.get('access-control-allow-origin'), origin);
    } finally { delete process.env.DROVER_ALLOW_ORIGINS; }
  });
});

after(async () => { await rm(STATE, { recursive: true, force: true }); setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref(); });

test('a first page with a small limit does not backfill older alerts on the next poll', async () => {
  const { buildNotifications } = await import('../core/native.js');
  const base = Date.parse('2026-10-11T22:00:00Z');
  const alerts = [0, 1, 2].map((i) => ({ id: `ev-demo-${i}`, ts: new Date(base + i * 1000).toISOString(), category: 'finished', title: `demo-${i} finished`, body: '' }));
  const first = buildNotifications(alerts, { limit: 1, now: base + 5000 });
  assert.deepEqual(first.items.map((x) => x.id), ['ev-demo-2']);
  const next = buildNotifications(alerts, { since: first.cursor, now: base + 6000 });
  assert.deepEqual(next.items, []);
});
