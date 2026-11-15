// Pairing over real HTTP against tools/fake-daemon.mjs, which mirrors the daemon's
// /api/pair routes (core/pair.js): no token to ask or collect, the token once. Every other
// outcome (denied, expired, busy, refused, unreachable) is proven in pairing.test.js, and the
// daemon's own rules (once, the five-pending cap, origins) in web/test/pair.test.js.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeDaemon, FAKE_TOKEN, FAKE_WIDGET_TOKEN } from '../tools/fake-daemon.mjs';
import { startPairing } from '../lib/pairing.js';

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
  assert.ok(!JSON.stringify(r.updates).includes(FAKE_WIDGET_TOKEN), 'the widget token is not kept');
  const calls = daemon.pairCalls.slice(from);
  assert.equal(calls[0].path, '/api/pair/request');
  assert.ok(calls.length >= 2 && calls.slice(1).every((c) => c.path === '/api/pair/status'));
  assert.ok(calls.every((c) => c.authorization === null), 'no Authorization header');
});
