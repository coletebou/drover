import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSseParser, connectStream } from '../lib/sse.js';

function parse(chunks) {
  const out = [];
  const p = createSseParser((e) => out.push(e));
  for (const c of chunks) p.push(c);
  return { out, p };
}

test('parser: basic event', () => {
  const { out } = parse(['event: hello\ndata: {"a":1}\n\n']);
  assert.deepEqual(out, [{ event: 'hello', data: '{"a":1}', id: null, retry: null }]);
});

test('parser: default event name is message', () => {
  assert.equal(parse(['data: x\n\n']).out[0].event, 'message');
});

test('parser: multi-line data joined with newline', () => {
  assert.equal(parse(['data: a\ndata: b\ndata:\ndata: c\n\n']).out[0].data, 'a\nb\n\nc');
});

test('parser: CRLF, LF and lone CR line endings', () => {
  assert.equal(parse(['data: a\r\n\r\n']).out[0].data, 'a');
  assert.equal(parse(['data: b\r\r']).out[0].data, 'b');
  assert.equal(parse(['event: e\rdata: c\r\r']).out[0].event, 'e');
});

test('parser: chunk split mid-line', () => {
  const { out } = parse(['eve', 'nt: he', 'llo\nda', 'ta: x', 'yz\n', '\n']);
  assert.deepEqual(out.map((e) => [e.event, e.data]), [['hello', 'xyz']]);
});

test('parser: chunk split between CR and LF does not make an extra blank line', () => {
  const { out } = parse(['data: a\r', '\ndata: b\r\n\r', '\n']);
  assert.equal(out.length, 1);
  assert.equal(out[0].data, 'a\nb');
});

test('parser: comments and ping lines are ignored', () => {
  const { out } = parse([': ping\n\n', ': hi\ndata: x\n\n']);
  assert.equal(out.length, 1);
  assert.equal(out[0].data, 'x');
});

test('parser: no space after the colon, and only one space is stripped', () => {
  assert.equal(parse(['data:x\n\n']).out[0].data, 'x');
  assert.equal(parse(['data:  x\n\n']).out[0].data, ' x');
});

test('parser: a line without a colon is a field with empty value', () => {
  const { out } = parse(['data\n\n']);
  assert.equal(out.length, 1);
  assert.equal(out[0].data, '');
});

test('parser: event name resets after dispatch', () => {
  const { out } = parse(['event: a\ndata: 1\n\ndata: 2\n\n']);
  assert.deepEqual(out.map((e) => e.event), ['a', 'message']);
});

test('parser: no data field means no dispatch', () => {
  const { out } = parse(['event: a\n\n', 'id: 5\n\n', 'data: ok\n\n']);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, null);
});

test('parser: retry accepts digits only', () => {
  assert.equal(parse(['retry: 2500\ndata: x\n\n']).out[0].retry, 2500);
  assert.equal(parse(['retry: 25x\ndata: x\n\n']).out[0].retry, null);
  assert.equal(parse(['retry: -5\ndata: x\n\n']).out[0].retry, null);
});

test('parser: id field is reported', () => {
  assert.equal(parse(['id: 7\ndata: x\n\n']).out[0].id, '7');
});

test('parser: leading BOM stripped once', () => {
  const { out } = parse(['﻿data: a\n\n', '﻿data: b\n\n']);
  assert.equal(out[0].data, 'a');
  assert.equal(out[1], undefined); // second BOM makes the field name "﻿data", which is unknown
});

test('parser: end() drops an undispatched partial event', () => {
  const { out, p } = parse(['data: partial\n']);
  p.end();
  p.push('\n');
  assert.deepEqual(out, []);
});

// ---- connectStream ----

const enc = new TextEncoder();
function streamOf(...parts) {
  return new ReadableStream({ start(c) { for (const p of parts) c.enqueue(enc.encode(p)); c.close(); } });
}
const okRes = (...parts) => ({ ok: true, status: 200, body: streamOf(...parts) });
const request = { url: 'http://127.0.0.1:1/api/stream', init: { method: 'GET', headers: { authorization: 'Bearer test-token-not-secret' } } };
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 1000) {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting'); await tick(1); }
}
function timers() {
  const t = { calls: [], cleared: [] };
  t.setTimer = (cb, delay) => { const h = { cb, delay }; t.calls.push(h); return h; };
  t.clearTimer = (h) => t.cleared.push(h);
  return t;
}

test('connectStream: delivers parsed events and reports states', async () => {
  const events = []; const states = [];
  const tm = timers();
  const conn = connectStream({
    request, fetch: async () => okRes('event: hello\ndata: {"host":"demo"}\n\n', 'event: raw\ndata: not json\n\n'),
    onEvent: (e, d) => events.push([e, d]), onState: (s, i) => states.push([s, i]),
    setTimer: tm.setTimer, clearTimer: tm.clearTimer, random: () => 0.5,
  });
  await until(() => tm.calls.length === 1);
  assert.deepEqual(events, [['hello', { host: 'demo' }], ['raw', 'not json']]);
  assert.deepEqual(states.map((s) => s[0]), ['connecting', 'open', 'retrying']);
  conn.close();
  assert.equal(states.at(-1)[0], 'closed');
});

test('connectStream: passes the request init and an abort signal to fetch', async () => {
  let seen;
  const tm = timers();
  const conn = connectStream({ request, fetch: async (url, init) => { seen = { url, init }; return okRes(); }, onEvent() {}, setTimer: tm.setTimer, clearTimer: tm.clearTimer });
  await until(() => tm.calls.length === 1);
  assert.equal(seen.url, request.url);
  assert.equal(seen.init.headers.authorization, 'Bearer test-token-not-secret');
  assert.ok(seen.init.signal instanceof AbortSignal);
  conn.close();
});

test('connectStream: reconnects with exponential jittered delay, capped', async () => {
  const tm = timers();
  let n = 0;
  const conn = connectStream({
    request, fetch: async () => { n++; return { ok: false, status: 503, body: null }; }, onEvent() {},
    backoff: { min: 1000, max: 5000 }, random: () => 0.5, setTimer: tm.setTimer, clearTimer: tm.clearTimer,
  });
  for (let i = 0; i < 5; i++) {
    await until(() => tm.calls.length === i + 1);
    tm.calls[i].cb();
  }
  await until(() => tm.calls.length === 6);
  // base 1000*2^k capped at 5000, times 0.75
  assert.deepEqual(tm.calls.map((c) => c.delay), [750, 1500, 3000, 3750, 3750, 3750]);
  assert.ok(n >= 6);
  conn.close();
});

test('connectStream: backoff resets after a successful open', async () => {
  const tm = timers();
  let n = 0;
  const conn = connectStream({
    request, fetch: async () => { n++; return n === 2 ? okRes('data: x\n\n') : { ok: false, status: 500, body: null }; }, onEvent() {},
    backoff: { min: 1000, max: 30000 }, random: () => 0.5, setTimer: tm.setTimer, clearTimer: tm.clearTimer,
  });
  await until(() => tm.calls.length === 1); tm.calls[0].cb();   // fail 1 -> retry, attempt 1
  await until(() => tm.calls.length === 2); tm.calls[1].cb();   // open, then end
  await until(() => tm.calls.length === 3); tm.calls[2].cb();
  await until(() => tm.calls.length === 4);
  // fail (750), open then end (reset: 750), then failures grow again (1500, 3000)
  assert.deepEqual(tm.calls.map((c) => c.delay), [750, 750, 1500, 3000]);
  conn.close();
});

test('connectStream: a server retry field overrides the base delay', async () => {
  const tm = timers();
  const conn = connectStream({
    request, fetch: async () => okRes('retry: 4000\ndata: x\n\n'), onEvent() {},
    backoff: { min: 1000, max: 30000 }, random: () => 0.5, setTimer: tm.setTimer, clearTimer: tm.clearTimer,
  });
  await until(() => tm.calls.length === 1);
  assert.equal(tm.calls[0].delay, 3000);
  conn.close();
});

test('connectStream: 401 and 403 stop with state error and never reconnect', async () => {
  for (const status of [401, 403]) {
    const tm = timers(); const states = []; let n = 0;
    connectStream({ request, fetch: async () => { n++; return { ok: false, status, body: null }; }, onEvent() {}, onState: (s, i) => states.push([s, i]), setTimer: tm.setTimer, clearTimer: tm.clearTimer });
    await until(() => states.some((s) => s[0] === 'error'));
    await tick(20);
    assert.deepEqual(states.at(-1), ['error', { status }]);
    assert.equal(tm.calls.length, 0);
    assert.equal(n, 1);
  }
});

test('connectStream: fetch rejection retries', async () => {
  const tm = timers(); const states = [];
  const conn = connectStream({ request, fetch: async () => { throw new Error('down'); }, onEvent() {}, onState: (s) => states.push(s), setTimer: tm.setTimer, clearTimer: tm.clearTimer });
  await until(() => tm.calls.length === 1);
  assert.deepEqual(states, ['connecting', 'retrying']);
  conn.close();
});

test('connectStream: close() aborts the fetch, clears the timer and silences callbacks', async () => {
  const tm = timers(); const states = []; let signal;
  const conn = connectStream({
    request, fetch: (url, init) => { signal = init.signal; return new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))); },
    onEvent() {}, onState: (s) => states.push(s), setTimer: tm.setTimer, clearTimer: tm.clearTimer,
  });
  await tick();
  conn.close();
  await tick(20);
  assert.equal(signal.aborted, true);
  assert.deepEqual(states, ['connecting', 'closed']);
  assert.equal(tm.calls.length, 0);
});

test('connectStream: close() while a retry is pending cancels the timer', async () => {
  const tm = timers(); const states = [];
  const conn = connectStream({ request, fetch: async () => okRes(), onEvent() {}, onState: (s) => states.push(s), setTimer: tm.setTimer, clearTimer: tm.clearTimer });
  await until(() => tm.calls.length === 1);
  conn.close();
  assert.deepEqual(tm.cleared, [tm.calls[0]]);
  assert.equal(states.at(-1), 'closed');
});

test('connectStream: close() during an open stream stops event delivery', async () => {
  const events = [];
  let ctl;
  const body = new ReadableStream({ start(c) { ctl = c; c.enqueue(enc.encode('data: 1\n\n')); } });
  const tm = timers();
  const conn = connectStream({ request, fetch: async () => ({ ok: true, status: 200, body }), onEvent: (e, d) => events.push(d), setTimer: tm.setTimer, clearTimer: tm.clearTimer });
  await until(() => events.length === 1);
  conn.close();
  ctl.enqueue(enc.encode('data: 2\n\n'));
  await tick(20);
  assert.deepEqual(events, [1]);
  assert.equal(tm.calls.length, 0);
});

test('connectStream: onEvent throwing does not stop delivery', async () => {
  const seen = []; const tm = timers();
  const conn = connectStream({
    request, fetch: async () => okRes('data: 1\n\ndata: 2\n\ndata: 3\n\n'),
    onEvent: (e, d) => { seen.push(d); if (d === 2) throw new Error('boom'); }, setTimer: tm.setTimer, clearTimer: tm.clearTimer,
  });
  await until(() => tm.calls.length === 1);
  assert.deepEqual(seen, [1, 2, 3]);
  conn.close();
});

test('connectStream: multibyte characters split across chunks decode correctly', async () => {
  const bytes = enc.encode('data: café\n\n');
  const body = new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, 10)); c.enqueue(bytes.slice(10)); c.close(); } });
  const seen = []; const tm = timers();
  const conn = connectStream({ request, fetch: async () => ({ ok: true, status: 200, body }), onEvent: (e, d) => seen.push(d), setTimer: tm.setTimer, clearTimer: tm.clearTimer });
  await until(() => tm.calls.length === 1);
  assert.deepEqual(seen, ['café']);
  conn.close();
});
