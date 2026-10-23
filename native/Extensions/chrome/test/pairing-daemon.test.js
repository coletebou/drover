// Pairing over real HTTP against tools/fake-daemon.mjs, which mirrors the daemon's
// /api/pair routes (core/pair.js): no token to ask or collect, the token once.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeDaemon, FAKE_TOKEN, FAKE_WIDGET_TOKEN } from '../tools/fake-daemon.mjs';
import { startPairing, requestPairing, checkPairing, PairErrorKind } from '../lib/pairing.js';
import { ErrorKind } from '../lib/api.js';

let daemon;
before(async () => { daemon = await startFakeDaemon(); });
after(async () => { await daemon.close(); });

/** POST /api/pair/approve or /deny with the main token, as drover pair approve|deny does. */
const decide = (d, code, verb) => fetch(`${d.url}/api/pair/${verb}`, { method: 'POST', headers: { authorization: `Bearer ${FAKE_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ code }) });

/** startPairing with real fetch and quick checks. answer: 'approve' or 'deny' as soon as the code shows. */
function pairWith(d, { answer, ...over } = {}) {
  const updates = [];
  const saved = [];
  const p = startPairing({
    baseUrl: d.url, device: 'macOS', setTimer: (cb) => setTimeout(cb, 5), clearTimer: clearTimeout,
    onUpdate: (u) => { updates.push(u); if (u.state === 'waiting' && answer) decide(d, u.code, answer); },
    saveToken: async (t) => { saved.push(t); },
    ...over,
  });
  return { p, updates, saved };
}

test('http: pair and approve; the token arrives and no request carried a token', async () => {
  const from = daemon.pairCalls.length;
  const r = pairWith(daemon, { answer: 'approve' });
  assert.deepEqual(await r.p.done, { state: 'paired', origin: daemon.url });
  assert.deepEqual(r.saved, [FAKE_TOKEN]);
  assert.ok(!JSON.stringify(r.updates).includes(FAKE_TOKEN));
  const calls = daemon.pairCalls.slice(from);
  assert.equal(calls[0].path, '/api/pair/request');
  assert.ok(calls.length >= 2 && calls.slice(1).every((c) => c.path === '/api/pair/status'));
  assert.ok(calls.every((c) => c.authorization === null), 'no Authorization header');
});

test('http: an approved request answers once, then 404', async () => {
  const req = await requestPairing({ baseUrl: daemon.url, device: 'macOS' });
  assert.match(req.requestId, /^[0-9a-f]{32}$/);
  assert.match(req.code, /^\d{6}$/);
  assert.equal(req.pollMs, 1500);
  assert.ok(req.expiresAt > Date.now());
  const st = () => checkPairing({ baseUrl: daemon.url, requestId: req.requestId });
  assert.deepEqual(await st(), { status: 'pending' });
  assert.equal((await decide(daemon, req.code, 'approve')).status, 200);
  const got = await st();
  assert.deepEqual(got, { status: 'approved', token: FAKE_TOKEN });
  assert.ok(!JSON.stringify(got).includes(FAKE_WIDGET_TOKEN));
  assert.deepEqual(await st(), { status: 'expired' });
});

test('http: denied saves nothing', async () => {
  const r = pairWith(daemon, { answer: 'deny' });
  assert.deepEqual(await r.p.done, { state: 'denied', origin: daemon.url });
  assert.deepEqual(r.saved, []);
});

test('http: a code nobody approves expires', async () => {
  const d = await startFakeDaemon({ pairTtlMs: 60 });
  try {
    const r = pairWith(d);
    assert.deepEqual(await r.p.done, { state: 'expired', origin: d.url });
    assert.deepEqual(r.saved, []);
  } finally { await d.close(); }
});

test('http: past five pending requests the daemon answers 429, shown as busy', async () => {
  const d = await startFakeDaemon();
  try {
    for (let i = 0; i < 5; i++) await requestPairing({ baseUrl: d.url });
    const end = await pairWith(d).p.done;
    assert.equal(end.state, 'error');
    assert.equal(end.error.kind, PairErrorKind.BUSY);
  } finally { await d.close(); }
});

test('http: a refused origin is forbidden and names DROVER_ALLOW_ORIGINS', async () => {
  const elsewhere = (url, init) => fetch(url, { ...init, headers: { ...(init.headers ?? {}), origin: 'https://evil.example' } });
  const end = await pairWith(daemon, { fetch: elsewhere }).p.done;
  assert.equal(end.error.kind, ErrorKind.FORBIDDEN);
  assert.match(end.error.message, /DROVER_ALLOW_ORIGINS/);
});

test('http: nothing listening is unreachable', async () => {
  const d = await startFakeDaemon();
  const url = d.url;
  await d.close();
  const end = await pairWith({ url }).p.done;
  assert.equal(end.state, 'error');
  assert.equal(end.error.kind, ErrorKind.UNREACHABLE);
});
