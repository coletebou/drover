// The TUI's daemon client (tui/client.js) and SSE parser (tui/sse.js) against a tiny local server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSseParser } from '../tui/sse.js';
import { Client, daemonTarget } from '../tui/client.js';

test('SSE parser: events across chunk boundaries, multi-line data, comments, CRLF', () => {
  const got = [];
  const p = createSseParser((type, data) => got.push([type, data]));
  p.feed('event: hello\nda'); p.feed('ta: {"a":1}\n'); p.feed('\n: ping\n\n');
  p.feed('event: board\r\ndata: line1\r\ndata: line2\r\n\r\n');
  p.feed('data: no type\n\n');
  const big = 'x'.repeat(200_000);
  for (let i = 0; i < big.length; i += 7000) p.feed(i === 0 ? `event: fleet\ndata: ${big.slice(0, 7000)}` : big.slice(i, i + 7000));
  p.feed('\n\n');
  assert.deepEqual(got.slice(0, 3), [['hello', '{"a":1}'], ['board', 'line1\nline2'], ['message', 'no type']]);
  assert.equal(got[3][0], 'fleet'); assert.equal(got[3][1].length, big.length);
});

test('daemonTarget names what is missing and never puts the token in a message', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'drover-tui-client-'));
  try {
    assert.throws(() => daemonTarget({ stateDir: dir }), /Drover is not running .*drover serve/);
    writeFileSync(path.join(dir, 'daemon.json'), JSON.stringify({ url: 'http://127.0.0.1:1' }));
    assert.throws(() => daemonTarget({ stateDir: dir }), /no token at/);
    writeFileSync(path.join(dir, 'token'), 'sekrit-token-value\n');
    const t = daemonTarget({ stateDir: dir });
    assert.equal(t.url.href, 'http://127.0.0.1:1/');
    assert.equal(t.token, 'sekrit-token-value');
    assert.equal(daemonTarget({ stateDir: dir, url: 'http://127.0.0.1:7338' }).url.href, 'http://127.0.0.1:7338/', '--url wins, the token file stays');
    assert.throws(() => daemonTarget({ stateDir: dir, url: 'file:///x' }), /not an http/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ops: result, an "unknown op" a client can detect, 401, and a token sent only as a header', async () => {
  const seen = [];
  const srv = createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    if (req.headers.authorization !== 'Bearer tok') { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"unauthorized"}'); return; }
    if (req.url === '/api/op/native.board') { res.end(JSON.stringify({ ok: false, error: 'unknown op native.board' })); return; }
    if (req.url.startsWith('/api/stream')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`event: hello\ndata: ${JSON.stringify({ host: 'h', topics: new URL(req.url, 'http://x').searchParams.get('topics').split(',') })}\n\n`);
      setTimeout(() => res.end(), 50);   // the client reconnects
      return;
    }
    let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => res.end(JSON.stringify({ ok: true, result: { echo: JSON.parse(body || '{}') } })));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = new URL(`http://127.0.0.1:${srv.address().port}/`);
  const c = new Client({ url, token: 'tok' });
  try {
    assert.deepEqual(await c.call('sessions.list', { host: 'x' }), { echo: { host: 'x' } });
    const e = await c.call('native.board', {}).catch((err) => err);
    assert.equal(e.unknownOp, true);
    assert.equal(e.message, 'unknown op native.board');
    const bad = new Client({ url, token: 'wrong' });
    const e2 = await bad.call('sessions.list').catch((err) => err);
    assert.equal(e2.status, 401); assert.ok(!e2.message.includes('wrong'));
    bad.close();
    await assert.rejects(c.call('../pair/approve'), /not an op name/);
    const states = []; const events = [];
    const s = c.stream({ topics: ['board', 'manager'], onEvent: (t, d) => events.push([t, JSON.parse(d)]), onState: (st) => states.push(st) });
    await new Promise((r) => setTimeout(r, 1400));
    s.close();
    assert.deepEqual(events[0], ['hello', { host: 'h', topics: ['board', 'manager'] }]);
    assert.ok(states.filter((x) => x === 'open').length >= 2, `reconnected after the stream ended: ${states}`);
    assert.ok(seen.every((r) => !r.url.includes('tok')), 'the token never rides in a URL');
  } finally { c.close(); srv.close(); }
});
