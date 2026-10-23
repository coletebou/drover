import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeDaemon, FAKE_TOKEN } from '../tools/fake-daemon.mjs';
import { createClient, ErrorKind } from '../lib/api.js';
import { normalizeSummary } from '../lib/summary.js';
import { connectStream } from '../lib/sse.js';

let daemon;
before(async () => { daemon = await startFakeDaemon({ token: FAKE_TOKEN }); });
after(async () => { await daemon.close(); });

const client = (token = FAKE_TOKEN) => createClient({ baseUrl: daemon.url, token });
async function fails(fn) { try { await fn(); } catch (e) { return e; } assert.fail('expected rejection'); }
async function until(fn, ms = 2000) {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting'); await new Promise((r) => setTimeout(r, 5)); }
}

test('summary round trip through normalizeSummary', async () => {
  const s = normalizeSummary(await client().op('native.summary'));
  assert.equal(s.waiting.length, 3);
  assert.equal(s.totals.hosts, 3);
});

test('notifications: since the cursor returns no items', async () => {
  const first = await client().op('native.notifications');
  assert.ok(first.items.length > 0);
  const again = await client().op('native.notifications', { since: first.cursor });
  assert.deepEqual(again, { cursor: first.cursor, items: [] });
});

test('transcript fixture is served', async () => {
  const r = await client().op('sessions.transcript', { id: 'x' });
  assert.ok(Array.isArray(r.turns));
});

test('wrong token is unauthorized', async () => {
  const e = await fails(() => client('wrong-token-not-secret').op('native.summary'));
  assert.equal(e.kind, ErrorKind.UNAUTHORIZED);
  assert.ok(!e.message.includes('wrong-token-not-secret'));
});

test('sessions.message is recorded', async () => {
  const r = await client().op('sessions.message', { id: 'abc', text: 'hello', actor: 'chrome' });
  assert.deepEqual(r, { ok: true, queuedBehindTurn: false, event: 'ev-demo' });
  assert.deepEqual(daemon.messages.at(-1), { id: 'abc', text: 'hello', actor: 'chrome' });
});

test('unknown op is a server error', async () => {
  const e = await fails(() => client().op('nope.nothing'));
  assert.equal(e.kind, ErrorKind.SERVER);
  assert.match(e.message, /unknown op nope\.nothing/);
});

test('stream: hello then a broadcast event, then close', async () => {
  const events = []; const states = [];
  const conn = connectStream({ request: client().streamRequest(), onEvent: (e, d) => events.push([e, d]), onState: (s) => states.push(s) });
  await until(() => events.some(([e]) => e === 'hello'));
  daemon.broadcast('mutation', { op: 'sessions.message' });
  await until(() => events.some(([e]) => e === 'mutation'));
  assert.deepEqual(events.find(([e]) => e === 'mutation')[1], { op: 'sessions.message' });
  assert.ok(states.includes('open'));
  conn.close();
  assert.equal(states.at(-1), 'closed');
});

test('stream: a wrong token stops with an error state', async () => {
  const states = [];
  connectStream({ request: client('wrong-token-not-secret').streamRequest(), onEvent() {}, onState: (s, i) => states.push([s, i]) });
  await until(() => states.some(([s]) => s === 'error'));
  assert.deepEqual(states.at(-1), ['error', { status: 401 }]);
});

test('cors: a disallowed origin is refused, an allowed one answered', async () => {
  const d = await startFakeDaemon({ allowOrigins: ['chrome-extension://abcdefghijklmnop'] });
  try {
    const bad = await fetch(`${d.url}/api/op/native.summary`, { method: 'POST', headers: { origin: 'https://evil.example', authorization: `Bearer ${FAKE_TOKEN}` }, body: '{}' });
    assert.equal(bad.status, 403);
    assert.deepEqual(await bad.json(), { error: 'bad origin' });
    const ok = await fetch(`${d.url}/api/op/native.summary`, { method: 'OPTIONS', headers: { origin: 'chrome-extension://abcdefghijklmnop' } });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get('access-control-allow-origin'), 'chrome-extension://abcdefghijklmnop');
  } finally { await d.close(); }
});
