import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PAIR_CLIENT, PairErrorKind, formatCode, approveCommand, formatTimeLeft, cleanLabel, deviceLabel,
  requestPairing, checkPairing, startPairing, pairingView,
} from '../lib/pairing.js';
import { ErrorKind } from '../lib/api.js';
import { LOCAL, saveSettings, loadSettings } from '../lib/settings.js';

// Shaped like real tokens (base64url, 32+ characters) so the redaction rules apply. Fakes, not secrets.
const TOKEN = 'pairtest_main_token_not_a_secret_01';
const WIDGET = 'pairtest_widget_token_not_a_secret_2';
const REQ = '0123456789abcdef0123456789abcdef';
const BASE = 'http://127.0.0.1:7337';
const T0 = Date.parse('2026-10-16T12:00:00.000Z');
const TTL = 120_000;

const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const created = (over = {}) => reply(201, { requestId: REQ, code: '042517', expiresAt: new Date(T0 + TTL).toISOString(), pollMs: 1500, ...over });
const pending = () => reply(200, { status: 'pending', expiresAt: new Date(T0 + TTL).toISOString() });
const approved = () => reply(200, { status: 'approved', token: TOKEN, widgetToken: WIDGET });
const denied = () => reply(200, { status: 'denied' });
const gone = () => reply(404, { status: 'expired' });
const down = async () => { throw new TypeError('Failed to fetch'); };
const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));

const header = (init, name) => Object.entries(init.headers ?? {}).find(([k]) => k.toLowerCase() === name)?.[1];
const text = (v) => v.message.map((p) => (typeof p === 'string' ? p : p.code)).join('');
const tick = (ms = 1) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 1000) {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting'); await tick(1); }
}
async function fails(fn) {
  try { await fn(); } catch (e) { return e; }
  assert.fail('expected a rejection');
}

/** A scripted daemon: `request` answers the pairing request, `statuses` answer the checks in order (functions get url, init). */
function daemon({ request = created(), statuses = [] } = {}) {
  const calls = [];
  const queue = [...statuses];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const next = url.endsWith('/api/pair/request') ? request : queue.shift();
    if (!next) throw new Error('unscripted call');
    return typeof next === 'function' ? next(url, init) : next;
  };
  return { fetch, calls };
}

function timers() {
  const t = { calls: [], cleared: [] };
  t.setTimer = (cb, delay) => { const h = { cb, delay }; t.calls.push(h); return h; };
  t.clearTimer = (h) => t.cleared.push(h);
  return t;
}

/** startPairing on a scripted daemon, fake timers and a fake clock. fire() moves the clock to the scheduled check and runs it. */
function run({ request, statuses, saveToken } = {}) {
  const d = daemon({ request, statuses });
  const tm = timers();
  const clock = { now: T0 };
  const updates = [];
  const saved = [];
  const p = startPairing({
    baseUrl: BASE, device: 'macOS', fetch: d.fetch, setTimer: tm.setTimer, clearTimer: tm.clearTimer, now: () => clock.now,
    onUpdate: (u) => updates.push(u), saveToken: saveToken ?? (async (t) => { saved.push(t); }),
  });
  const fire = () => { const t = tm.calls.at(-1); clock.now += t.delay; t.cb(); };
  return { p, d, tm, clock, updates, saved, fire, states: () => updates.map((u) => u.state) };
}

/** Fire each check as it is scheduled until pairing ends. */
async function drive(r, ms = 2000) {
  let over = false;
  r.p.done.then(() => { over = true; });
  let fired = 0;
  const t0 = Date.now();
  while (!over) {
    if (Date.now() - t0 > ms) throw new Error('timeout driving pairing');
    if (r.tm.calls.length > fired) { fired += 1; r.fire(); }
    await tick(1);
  }
  return r.p.done;
}

function fakeArea(initial = {}) {
  const data = structuredClone(initial);
  return { data, async get(key) { return key in data ? { [key]: structuredClone(data[key]) } : {}; }, async set(obj) { Object.assign(data, structuredClone(obj)); } };
}

// ---- formatting ----

test('formatCode groups digits in threes and keeps leading zeros', () => {
  assert.equal(formatCode('123456'), '123 456');
  assert.equal(formatCode('042517'), '042 517');
  assert.equal(formatCode(' 12-34 56 '), '123 456');
  assert.equal(formatCode(''), '');
  assert.equal(approveCommand('042517'), 'drover pair approve 042517');
});

test('formatTimeLeft rounds up and stops at 0:00', () => {
  assert.equal(formatTimeLeft(120_000), '2:00');
  assert.equal(formatTimeLeft(119_001), '2:00');
  assert.equal(formatTimeLeft(59_000), '0:59');
  assert.equal(formatTimeLeft(500), '0:01');
  assert.equal(formatTimeLeft(0), '0:00');
  assert.equal(formatTimeLeft(-5000), '0:00');
  assert.equal(formatTimeLeft(NaN), '0:00');
});

test('deviceLabel: the platform, plus the browser unless it is Google Chrome', () => {
  const nav = (platform, ...names) => ({ userAgentData: { platform, brands: names.map((brand) => ({ brand, version: '130' })) } });
  assert.equal(deviceLabel(nav('macOS', 'Google Chrome', 'Chromium', 'Not=A?Brand')), 'macOS');
  assert.equal(deviceLabel(nav('Windows', 'Not A(Brand', 'Microsoft Edge', 'Chromium')), 'Windows, Microsoft Edge');
  assert.equal(deviceLabel(nav('Linux', ' Not A;Brand', 'Chromium')), 'Linux, Chromium');
  assert.equal(deviceLabel(nav('', 'Google Chrome')), '');
  for (const n of [{}, undefined, { userAgentData: { platform: 7, brands: 'x' } }]) assert.equal(deviceLabel(n), '');
});

test('cleanLabel drops control characters and keeps to 64 characters', () => {
  assert.equal(cleanLabel(' my\u0007 \nbox\u2028 '), 'my box');
  assert.equal(cleanLabel('x'.repeat(100)).length, 64);
  assert.equal(cleanLabel(null), '');
});

// ---- POST /api/pair/request ----

test('request: POSTs client and device as JSON, with no Authorization header and no cookies', async () => {
  let call;
  const r = await requestPairing({ baseUrl: `${BASE}/some/path`, device: 'macOS', fetch: async (url, init) => { call = { url, init }; return created(); } });
  assert.equal(call.url, `${BASE}/api/pair/request`);
  assert.equal(call.init.method, 'POST');
  assert.equal(header(call.init, 'authorization'), undefined);
  assert.equal(header(call.init, 'content-type'), 'application/json');
  assert.equal(call.init.credentials, 'omit');
  assert.equal(call.init.cache, 'no-store');
  assert.deepEqual(JSON.parse(call.init.body), { client: 'Drover for Chrome', device: 'macOS' });
  assert.equal(PAIR_CLIENT, 'Drover for Chrome');
  assert.deepEqual(r, { requestId: REQ, code: '042517', expiresAt: T0 + TTL, pollMs: 1500 });
});

test('request: the device label stays within the 64 characters the daemon accepts', async () => {
  let body;
  await requestPairing({ baseUrl: BASE, device: `x\n${'y'.repeat(90)}`, fetch: async (url, init) => { body = JSON.parse(init.body); return created(); } });
  assert.ok(body.device.length <= 64);
  assert.ok(!body.device.includes('\n'));
  await requestPairing({ baseUrl: BASE, fetch: async (url, init) => { body = JSON.parse(init.body); return created(); } });
  assert.equal(body.device, '');
});

test('request: 429 is busy, and says what to do', async () => {
  const e = await fails(() => requestPairing({ baseUrl: BASE, fetch: async () => reply(429, { error: 'too many pairing requests; approve or deny the pending ones, or wait for them to expire' }) }));
  assert.equal(e.kind, PairErrorKind.BUSY);
  assert.equal(e.status, 429);
  assert.match(e.message, /Approve or deny them on your Mac/);
});

test('request: refusals and failures map to kinds the page explains', async () => {
  const cases = [
    [reply(403, { error: 'bad origin' }), ErrorKind.FORBIDDEN, /DROVER_ALLOW_ORIGINS/],
    [reply(403, { error: 'pairing is off' }), ErrorKind.FORBIDDEN, /pairing is off/],
    [reply(401, { error: 'unauthorized' }), PairErrorKind.UNSUPPORTED, /cannot pair yet/],
    [reply(404, { error: 'no such route' }), PairErrorKind.UNSUPPORTED, /cannot pair yet/],
    [reply(400, { error: 'device too long (max 64 characters)' }), ErrorKind.SERVER, /device too long/],
    [reply(500, null), ErrorKind.SERVER, /HTTP 500/],
  ];
  for (const [res, kind, re] of cases) {
    const e = await fails(() => requestPairing({ baseUrl: BASE, fetch: async () => res }));
    assert.equal(e.kind, kind, `HTTP ${res.status}`);
    assert.match(e.message, re);
  }
});

test('request: an answer without a usable id, code or expiry is a bad response', async () => {
  for (const over of [{ requestId: undefined }, { requestId: 'a/b?c=1' }, { code: 123456 }, { code: '12ab56' }, { code: '' }, { expiresAt: 'soon' }, { expiresAt: T0 }]) {
    const e = await fails(() => requestPairing({ baseUrl: BASE, fetch: async () => created(over) }));
    assert.equal(e.kind, ErrorKind.BAD_RESPONSE, JSON.stringify(over));
  }
  const e = await fails(() => requestPairing({ baseUrl: BASE, fetch: async () => ({ status: 201, ok: true, json: async () => { throw new SyntaxError('bad json'); } }) }));
  assert.equal(e.kind, ErrorKind.BAD_RESPONSE);
});

test('request: pollMs falls back to 1500 and is kept between 500 ms and 10 s', async () => {
  const poll = async (pollMs) => (await requestPairing({ baseUrl: BASE, fetch: async () => created({ pollMs }) })).pollMs;
  assert.equal(await poll(undefined), 1500);
  assert.equal(await poll('fast'), 1500);
  assert.equal(await poll(0), 500);
  assert.equal(await poll(1e9), 10_000);
  assert.equal(await poll(2000), 2000);
});

test('request: a network failure or a timeout is unreachable', async () => {
  const e = await fails(() => requestPairing({ baseUrl: BASE, fetch: down }));
  assert.equal(e.kind, ErrorKind.UNREACHABLE);
  assert.equal(e.message, `Cannot reach ${BASE}.`);
  const t = await fails(() => requestPairing({ baseUrl: BASE, fetch: hang, timeoutMs: 20 }));
  assert.equal(t.kind, ErrorKind.UNREACHABLE);
  assert.match(t.message, /did not answer in time/);
});

// ---- GET /api/pair/status ----

test('status: GETs the request id, with no Authorization header, no body and no cookies', async () => {
  let call;
  const r = await checkPairing({ baseUrl: BASE, requestId: REQ, fetch: async (url, init) => { call = { url, init }; return pending(); } });
  assert.deepEqual(r, { status: 'pending' });
  assert.equal(call.url, `${BASE}/api/pair/status?requestId=${REQ}`);
  assert.equal(call.init.method, 'GET');
  assert.equal(header(call.init, 'authorization'), undefined);
  assert.equal(call.init.body, undefined);
  assert.equal(call.init.credentials, 'omit');
});

test('status: approved hands back the main token only; denied; 404 is expired', async () => {
  const st = (res) => checkPairing({ baseUrl: BASE, requestId: REQ, fetch: async () => res });
  const a = await st(approved());
  assert.deepEqual(a, { status: 'approved', token: TOKEN });
  assert.ok(!JSON.stringify(a).includes(WIDGET));
  assert.deepEqual(await st(denied()), { status: 'denied' });
  assert.deepEqual(await st(gone()), { status: 'expired' });
  assert.deepEqual(await st(reply(404, null)), { status: 'expired' });
});

test('status: an approval without a token, or an unknown status, is a bad response', async () => {
  for (const body of [{ status: 'approved' }, { status: 'approved', token: '  ' }, { status: 'approved', token: 5 }, { status: 'maybe' }, null]) {
    const e = await fails(() => checkPairing({ baseUrl: BASE, requestId: REQ, fetch: async () => reply(200, body) }));
    assert.equal(e.kind, ErrorKind.BAD_RESPONSE, JSON.stringify(body));
  }
});

test('status: the request id is encoded into the query', async () => {
  let url;
  await checkPairing({ baseUrl: BASE, requestId: 'a&b=c', fetch: async (u) => { url = u; return gone(); } });
  assert.equal(url, `${BASE}/api/pair/status?requestId=a%26b%3Dc`);
});

// ---- startPairing ----

test('pairing: shows the code, checks every pollMs, and on approval hands the token to saveToken', async () => {
  const r = run({ statuses: [pending(), pending(), approved()] });
  assert.deepEqual(r.updates, [], 'no update before startPairing returns');
  await until(() => r.tm.calls.length === 1);
  assert.deepEqual(r.states(), ['requesting', 'waiting']);
  assert.deepEqual(r.updates[1], { state: 'waiting', origin: BASE, code: '042517', display: '042 517', command: 'drover pair approve 042517', expiresAt: T0 + TTL });
  r.fire(); await until(() => r.tm.calls.length === 2);
  r.fire(); await until(() => r.tm.calls.length === 3);
  r.fire();
  assert.deepEqual(await r.p.done, { state: 'paired', origin: BASE });
  assert.deepEqual(r.states(), ['requesting', 'waiting', 'approved', 'paired']);
  assert.deepEqual(r.saved, [TOKEN]);
  assert.deepEqual(r.tm.calls.map((c) => c.delay), [1500, 1500, 1500]);
  assert.equal(r.d.calls.length, 4); // one request, three checks
  for (const c of r.d.calls.slice(1)) assert.equal(c.url, `${BASE}/api/pair/status?requestId=${REQ}`);
  for (const c of r.d.calls) assert.equal(header(c.init, 'authorization'), undefined);
  assert.equal(r.p.cancel(), false);
});

test('pairing: the approved token lands where Save and connect puts it (settings.token in the local area)', async () => {
  const area = fakeArea({ [LOCAL.SETTINGS]: { baseUrl: 'http://127.0.0.1:7000', token: '', actor: 'demo', pollMinutes: 5 } });
  // options.js passes saveToken: (token) => store(origin, token), and store() is what Save and connect calls;
  // its storage step is this saveSettings patch (see test/options.test.js).
  const r = run({ statuses: [pending(), approved()], saveToken: (token) => saveSettings(area, { baseUrl: BASE, token, actor: 'demo' }) });
  assert.equal((await drive(r)).state, 'paired');
  const s = await loadSettings(area);
  assert.equal(s.token, TOKEN);
  assert.equal(s.baseUrl, BASE);
  assert.equal(s.actor, 'demo');
  assert.equal(s.pollMinutes, 5);
  assert.deepEqual(Object.keys(area.data), [LOCAL.SETTINGS]);
  const raw = JSON.stringify(area.data);
  assert.ok(!raw.includes(WIDGET), 'the widget token is not kept');
  assert.ok(!raw.includes(REQ), 'the request id is not stored');
});

test('pairing: denied ends without saving anything', async () => {
  const r = run({ statuses: [pending(), denied()] });
  assert.deepEqual(await drive(r), { state: 'denied', origin: BASE });
  assert.deepEqual(r.states(), ['requesting', 'waiting', 'denied']);
  assert.deepEqual(r.saved, []);
  assert.equal(r.tm.calls.length, 2);
});

test('pairing: a 404 from a check is expired', async () => {
  const r = run({ statuses: [pending(), gone()] });
  assert.deepEqual(await drive(r), { state: 'expired', origin: BASE });
  assert.deepEqual(r.saved, []);
  assert.equal(r.d.calls.length, 3);
});

test('pairing: stops at expiresAt, with the last check right at the deadline', async () => {
  const r = run({ request: created({ expiresAt: new Date(T0 + 2000).toISOString() }), statuses: [pending(), pending()] });
  await until(() => r.tm.calls.length === 1);
  r.fire(); // at 1.5 s: still pending
  await until(() => r.tm.calls.length === 2);
  assert.equal(r.tm.calls[1].delay, 500, 'the last check waits only for what is left');
  r.fire(); // at 2 s: pending at the deadline
  assert.deepEqual(await r.p.done, { state: 'expired', origin: BASE });
  assert.equal(r.d.calls.length, 3);
  assert.equal(r.tm.calls.length, 2);
  assert.deepEqual(r.saved, []);
});

test('pairing: an approval seen by the check at the deadline still counts', async () => {
  const r = run({ request: created({ expiresAt: new Date(T0 + 1500).toISOString() }), statuses: [approved()] });
  assert.equal((await drive(r)).state, 'paired');
  assert.deepEqual(r.saved, [TOKEN]);
});

test('pairing: 429 on the request is an error, and nothing polls', async () => {
  const r = run({ request: reply(429, { error: 'too many pairing requests' }) });
  const end = await r.p.done;
  assert.equal(end.state, 'error');
  assert.equal(end.error.kind, PairErrorKind.BUSY);
  assert.match(end.error.message, /^Too many pairing requests are waiting\./);
  assert.deepEqual(r.states(), ['requesting', 'error']);
  assert.equal(r.tm.calls.length, 0);
  assert.equal(r.d.calls.length, 1);
  assert.deepEqual(r.saved, []);
  assert.equal(pairingView(end).retry, true);
});

test('pairing: cancel while waiting clears the timer, and nothing else happens', async () => {
  const r = run({ statuses: [approved()] });
  await until(() => r.tm.calls.length === 1);
  assert.equal(r.p.cancel(), true);
  assert.deepEqual(r.tm.cleared, [r.tm.calls[0]]);
  r.tm.calls[0].cb(); // even if the timer fires anyway
  await tick(20);
  assert.deepEqual(await r.p.done, { state: 'cancelled', origin: BASE });
  assert.deepEqual(r.states(), ['requesting', 'waiting', 'cancelled']);
  assert.equal(r.d.calls.length, 1, 'no status check after cancel');
  assert.deepEqual(r.saved, []);
  assert.equal(r.p.cancel(), false);
});

test('pairing: cancel aborts a check in flight, and an approval that arrives anyway is dropped', async () => {
  let signal, answer;
  const late = (url, init) => { signal = init.signal; return new Promise((resolve) => { answer = resolve; }); }; // ignores the abort
  const r = run({ statuses: [late] });
  await until(() => r.tm.calls.length === 1);
  r.fire();
  await until(() => signal);
  r.p.cancel();
  assert.equal(signal.aborted, true);
  answer(approved());
  await tick(20);
  assert.deepEqual(r.states(), ['requesting', 'waiting', 'cancelled']);
  assert.deepEqual(r.saved, []);
  assert.equal(r.tm.calls.length, 1);
});

test('pairing: cancel during the request, or right away, ends before any code shows', async () => {
  const r = run({ request: hang });
  await until(() => r.d.calls.length === 1);
  r.p.cancel();
  assert.deepEqual(await r.p.done, { state: 'cancelled', origin: BASE });
  await tick(20);
  assert.deepEqual(r.states(), ['requesting', 'cancelled']);

  const now = run();
  now.p.cancel();
  assert.deepEqual(await now.p.done, { state: 'cancelled', origin: BASE });
  await tick(20);
  assert.deepEqual(now.states(), ['cancelled']);
  assert.equal(now.d.calls.length, 0, 'no request sent');
});

test('pairing: a network blip while waiting is retried; three failed checks in a row end it', async () => {
  const ok = run({ statuses: [down, pending(), down, down, approved()] });
  assert.equal((await drive(ok)).state, 'paired');
  assert.deepEqual(ok.saved, [TOKEN]);

  const bad = run({ statuses: [down, down, down] });
  const end = await drive(bad);
  assert.equal(end.state, 'error');
  assert.equal(end.error.kind, ErrorKind.UNREACHABLE);
  assert.equal(end.error.message, `Cannot reach ${BASE}.`);
  assert.equal(bad.tm.calls.length, 3);
  assert.match(text(pairingView(end)), /Is Drover running\?/);
});

test('pairing: a refused check ends at once and keeps its kind', async () => {
  const r = run({ statuses: [reply(403, { error: 'bad origin' })] });
  const end = await drive(r);
  assert.equal(end.error.kind, ErrorKind.FORBIDDEN);
  assert.equal(r.tm.calls.length, 1);
  assert.equal(pairingView(end).originHint, true);
});

test('pairing: if the token cannot be saved, it says so', async () => {
  const r = run({ statuses: [approved()], saveToken: async () => { throw new Error('quota exceeded'); } });
  const end = await drive(r);
  assert.equal(end.state, 'error');
  assert.equal(end.error.kind, PairErrorKind.STORAGE);
  assert.match(end.error.message, /could not be saved/);
});

test('pairing: cancel is refused once the token is being saved', async () => {
  let finishSave;
  const r = run({ statuses: [approved()], saveToken: () => new Promise((resolve) => { finishSave = resolve; }) });
  await until(() => r.tm.calls.length === 1);
  r.fire();
  await until(() => finishSave);
  assert.equal(r.states().at(-1), 'approved');
  assert.equal(r.p.cancel(), false);
  finishSave();
  assert.equal((await r.p.done).state, 'paired');
});

test('pairing: an onUpdate that throws does not stop pairing', async () => {
  const d = daemon({ statuses: [approved()] });
  const tm = timers();
  const saved = [];
  const p = startPairing({ baseUrl: BASE, fetch: d.fetch, setTimer: tm.setTimer, clearTimer: tm.clearTimer, now: () => T0, onUpdate: () => { throw new Error('boom'); }, saveToken: async (t) => { saved.push(t); } });
  await until(() => tm.calls.length === 1);
  tm.calls[0].cb();
  assert.equal((await p.done).state, 'paired');
  assert.deepEqual(saved, [TOKEN]);
});

test('pairing: a bad URL or a missing saveToken throws before anything is sent', () => {
  assert.throws(() => startPairing({ baseUrl: '', saveToken: async () => {} }), (e) => e.kind === ErrorKind.NOT_CONFIGURED);
  assert.throws(() => startPairing({ baseUrl: BASE }), TypeError);
});

// ---- what the page shows ----

test('pairingView: waiting shows the code, the approve instructions and the time left', () => {
  const u = { state: 'waiting', origin: BASE, code: '123456', display: '123 456', command: 'drover pair approve 123456', expiresAt: T0 + 119_400 };
  const v = pairingView(u, T0);
  assert.equal(v.code, '123 456');
  assert.equal(v.codeLabel, 'Pairing code 1 2 3 4 5 6');
  assert.equal(text(v), 'Approve this code on your Mac: run drover pair approve 123456 or use Approve in Drover\'s browser UI.');
  assert.deepEqual(v.message[1], { code: 'drover pair approve 123456' });
  assert.equal(v.command, 'drover pair approve 123456');
  assert.equal(v.timer, 'Expires in 2:00.');
  assert.equal(pairingView(u, T0 + 60_000).timer, 'Expires in 1:00.');
  assert.equal(pairingView(u, T0 + 200_000).timer, 'Expires in 0:00.');
  assert.deepEqual([v.tone, v.busy, v.cancel, v.retry], ['info', true, true, false]);
});

test('pairingView: every other state', () => {
  const at = (u) => pairingView({ origin: BASE, ...u }, T0);
  assert.match(text(at({ state: 'requesting' })), /^Asking http:\/\/127\.0\.0\.1:7337 for a pairing code/);
  assert.deepEqual([at({ state: 'requesting' }).busy, at({ state: 'requesting' }).cancel], [true, true]);
  assert.deepEqual([at({ state: 'approved' }).busy, at({ state: 'approved' }).cancel, at({ state: 'approved' }).tone], [true, false, 'ok']);
  assert.equal(at({ state: 'paired' }).busy, true, 'checking the connection');
  assert.deepEqual([at({ state: 'paired', connected: true }).tone, at({ state: 'paired', connected: true }).busy], ['ok', false]);
  assert.match(text(at({ state: 'paired', connected: true })), /connected/);
  assert.match(text(at({ state: 'paired', connected: false })), /connection check failed/);
  for (const state of ['denied', 'expired']) {
    const v = at({ state });
    assert.deepEqual([v.tone, v.retry, v.busy], ['error', true, false], state);
    assert.match(text(v), /Nothing was saved/);
  }
  assert.deepEqual([at({ state: 'cancelled' }).busy, at({ state: 'cancelled' }).retry], [false, false]);
  assert.match(text(at({ state: 'error', error: { kind: ErrorKind.UNREACHABLE, message: 'Cannot reach x.' } })), /^Cannot reach x\. Is Drover running\?/);
  assert.equal(at({ state: 'error', error: { kind: ErrorKind.FORBIDDEN, message: 'no' } }).originHint, true);
  assert.equal(at({ state: 'error', error: { kind: PairErrorKind.BUSY, message: 'm' } }).retry, true);
  assert.equal(text(at({ state: 'error' })), 'Pairing failed.');
  assert.equal(pairingView(null), null);
  assert.equal(pairingView({ state: 'nope' }), null);
});

// ---- secrets ----

test('the token, the widget token and the request id never reach an update, the page view or the console', async () => {
  const methods = ['log', 'info', 'warn', 'error', 'debug'];
  const original = methods.map((m) => console[m]);
  const logged = [];
  methods.forEach((m) => { console[m] = (...a) => logged.push(a.map(String).join(' ')); });
  const flows = [];
  try {
    flows.push(
      run({ statuses: [pending(), approved()] }),
      run({ statuses: [denied()] }),
      run({ statuses: [gone()] }),
      run({ statuses: [reply(500, { error: `leaked ${TOKEN} for ${REQ}` })] }),
      run({ statuses: [reply(403, { error: `refused ${WIDGET}` })] }),
      run({ statuses: [approved()], saveToken: async (t) => { throw new Error(`could not write ${t}`); } }),
      run({ request: reply(429, { error: `busy ${TOKEN}` }) }),
      run({ request: reply(400, { error: `bad ${TOKEN}` }) }),
    );
    for (const r of flows) await drive(r);
  } finally {
    methods.forEach((m, i) => { console[m] = original[i]; });
  }
  const seen = [];
  for (const r of flows) {
    for (const u of [...r.updates, await r.p.done]) {
      seen.push(JSON.stringify(u), JSON.stringify(pairingView(u, T0)), JSON.stringify(pairingView({ ...u, connected: true }, T0)), JSON.stringify(pairingView({ ...u, connected: false }, T0)));
    }
  }
  assert.ok(seen.length > 40);
  for (const out of seen) for (const secret of [TOKEN, WIDGET, REQ]) assert.ok(!out.includes(secret), `${secret} leaked into ${out}`);
  assert.deepEqual(logged, []);
  assert.deepEqual(flows[0].saved, [TOKEN], 'the token went to saveToken, and only there');
});
