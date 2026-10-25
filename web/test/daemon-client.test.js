import './isolate-cache.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(tmpdir(), 'drover-dc-'));
const STATE = path.join(dir, 'state');
await mkdir(STATE, { recursive: true });
process.env.DROVER_STATE = STATE;
process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'claude'); // no Claude sessions
process.env.OPENCLAW_MANAGER_STATE_DIR = path.join(dir, 'openclaw');
process.env.CODEX_HOME = path.join(dir, 'codex-home');
process.env.HERMES_HOME = path.join(dir, 'hermes-home'); // no Hermes sessions
process.env.DROVER_EVENTS = path.join(dir, 'events.jsonl');
process.env.DROVER_DOTFILES = path.join(dir, 'dotfiles');
process.env.DROVER_HOST = 'testbox';

// A local `codex` that records each start, so a test can prove no local reader ran.
const MARK = path.join(dir, 'codex-started');
const bin = path.join(dir, 'bin');
await mkdir(bin);
await writeFile(path.join(bin, 'codex'), `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(MARK)}, 'start\\n');
process.stdin.setEncoding('utf8'); let buf='';
process.stdin.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i+1); if (!l.trim()) continue; const m = JSON.parse(l);
  if (m.method === 'thread/list') process.stdout.write(JSON.stringify({ id: m.id, result: { data: [{ id: 'local-1', cwd: '/l', status: 'idle' }] } }) + '\\n');
  else if (m.id !== undefined) process.stdout.write(JSON.stringify({ id: m.id, result: {} }) + '\\n');
} });
`);
await chmod(path.join(bin, 'codex'), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;

const client = await import('../core/daemon-client.js');
const api = await import('../core/api.js');
const codex = await import('../core/codex.js');

// A daemon on a loopback port: host.identity always answers; `answer` serves every other op.
let answer = async () => ({ status: 200, body: { ok: true, result: null } });
const seen = [];
const srv = createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  seen.push({ method: req.method, url: req.url, body: raw });
  if (req.headers.authorization !== 'Bearer tok-1') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":"unauthorized"}'); }
  const { status, body, raw: rawBody } = req.url === '/api/op/host.identity' ? { status: 200, body: { ok: true, result: { host: 'testbox' } } } : await answer(req, raw);
  res.writeHead(status, { 'content-type': 'application/json' }); res.end(rawBody ?? JSON.stringify(body));
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${srv.address().port}/`;
// pid: a live process that is not this one, as the real daemon is.
async function daemonUp() {
  await writeFile(path.join(STATE, 'daemon.json'), JSON.stringify({ url, pid: process.ppid }));
  await writeFile(path.join(STATE, 'token'), 'tok-1\n');
  client.forgetEndpoint();
}
async function daemonGone() { await rm(path.join(STATE, 'daemon.json'), { force: true }); client.forgetEndpoint(); }
const localStarts = async () => (existsSync(MARK) ? (await readFile(MARK, 'utf8')).split('\n').filter(Boolean).length : 0);
const probes = () => seen.filter((s) => s.url === '/api/op/host.identity').length;
const codexSessions = (r) => r.sessions.filter((s) => s.engine === 'codex').map((s) => s.id);

after(() => { srv.close(); codex.stopReadClient(); codex.sharedClient().stop(); });

test('a daemon URL that is not local is refused; a literal tailnet address is accepted', async () => {
  await writeFile(path.join(STATE, 'token'), 'tok-1\n');
  for (const bad of ['http://example.com:7337/', 'http://100.attacker.example:7337/', 'http://100.200.1.1:7337/', 'http://100.63.0.1:7337/']) {
    await writeFile(path.join(STATE, 'daemon.json'), JSON.stringify({ url: bad, pid: 1 }));
    await assert.rejects(client.readEndpoint(), /is not local/, bad);
  }
  for (const good of ['http://100.64.1.2:7337/', 'http://100.127.255.255:7337/', 'http://127.0.0.1:7337/', 'http://[::1]:7337/']) {
    await writeFile(path.join(STATE, 'daemon.json'), JSON.stringify({ url: good, pid: 1 }));
    assert.equal((await client.readEndpoint()).url, good);
  }
});

test('a daemon.json naming this process is not a daemon to call', async () => {
  await writeFile(path.join(STATE, 'daemon.json'), JSON.stringify({ url, pid: process.pid }));
  client.forgetEndpoint();
  assert.equal(await client.daemonEndpoint(), null);
});

test('a found daemon is remembered; a miss is retried once the retry window passes', async () => {
  await daemonUp();
  const before = probes();
  assert.equal((await client.daemonEndpoint()).url, url);
  assert.equal((await client.daemonEndpoint()).url, url);
  assert.equal(probes() - before, 1, 'one host.identity probe for both calls');
  await daemonGone();
  assert.equal(await client.daemonEndpoint(), null);
  await daemonUp(); // forgets; then poison the cache with a miss inside the window
  await rm(path.join(STATE, 'daemon.json'));
  assert.equal(await client.daemonEndpoint(), null);
  await writeFile(path.join(STATE, 'daemon.json'), JSON.stringify({ url, pid: process.ppid }));
  assert.equal(await client.daemonEndpoint(), null, 'a miss is kept for the retry window');
  client._deps.retryMs = 0;
  try { assert.equal((await client.daemonEndpoint()).url, url, 'and probed again after it'); }
  finally { client._deps.retryMs = 30_000; }
});

test('callDaemon says why a call failed', async () => {
  await daemonUp();
  const ep = await client.daemonEndpoint();
  answer = async () => ({ status: 200, body: { ok: true, result: 'fine' } });
  assert.equal(await client.callDaemon(ep, 'x.op', { a: 1 }), 'fine');
  assert.deepEqual(JSON.parse(seen.at(-1).body), { a: 1 });
  answer = async () => ({ status: 500, body: { ok: false, error: 'boom' } });
  await assert.rejects(client.callDaemon(ep, 'x.op', {}), (e) => e.fromDaemon && e.status === 500 && /boom/.test(e.message));
  answer = async () => ({ status: 403, body: { ok: false, error: 'refused: outside the editable roots' } });
  await assert.rejects(client.callDaemon(ep, 'files.write', {}), (e) => e.fromDaemon && !e.unreachable, 'a 403 is an op refusal, not a bad token');
  await assert.rejects(client.callDaemon({ url, token: 'wrong' }, 'x.op', {}), (e) => e.unreachable && /token/.test(e.message));
  answer = async () => { await new Promise((r) => setTimeout(r, 300)); return { status: 200, body: { ok: true, result: 'late' } }; };
  await assert.rejects(client.callDaemon(ep, 'x.op', {}, { timeoutMs: 50 }), (e) => e.timedOut && !e.unreachable);
  // A 2xx whose body is cut off is an error, never a silent success; an unreadable error page stays fromDaemon.
  answer = async () => ({ status: 200, raw: '{"ok":true,"res' });
  await assert.rejects(client.callDaemon(ep, 'tmux.send', {}), (e) => e.incomplete && !e.unreachable && /cut off/.test(e.message));
  answer = async () => ({ status: 502, raw: '<html>bad gateway</html>' });
  await assert.rejects(client.callDaemon(ep, 'x.op', {}), (e) => e.fromDaemon && e.status === 502 && /HTTP 502/.test(e.message));
  // A port nobody listens on: unreachable, and the remembered endpoint is dropped.
  const closed = createServer(); await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  const dead = `http://127.0.0.1:${closed.address().port}/`; await new Promise((r) => closed.close(r));
  const before = probes();
  await assert.rejects(client.callDaemon({ url: dead, token: 'tok-1' }, 'x.op', {}), (e) => e.unreachable);
  await client.daemonEndpoint();
  assert.equal(probes() - before, 1, 'the next daemonEndpoint probes again');
});

test('callDaemon refuses a name that is not an op, so it can never reach another route', async () => {
  await daemonUp();
  const ep = await client.daemonEndpoint();
  answer = async () => ({ status: 200, body: { ok: true, result: 'fine' } });
  const before = seen.length; const probesBefore = probes();
  // Unchecked, URL resolution sends most of these to POST /api/pair/approve (or /deny) with the main token.
  const bad = ['../pair/approve', '%2e%2e/pair/approve', '%2E%2E/pair/approve', '..\\pair\\approve', 'pair/../../api/pair/approve',
    'sessions.list/../../pair/deny', '..', '.', 'a..b', '.x', 'x.', '', 'a/b', 'a b', 'sessions.list?x=1', 'sessions.list#x', 'séssions.list'];
  for (const op of bad) {
    await assert.rejects(client.callDaemon(ep, op, { code: '123456' }), (e) => e.badOp && !e.unreachable && !e.fromDaemon && /not an op name/.test(e.message), JSON.stringify(op));
  }
  for (const op of [undefined, null, 42, { toString: () => '../pair/approve' }]) {
    await assert.rejects(client.callDaemon(ep, op, {}), (e) => e.badOp, String(op));
  }
  assert.deepEqual(seen.slice(before), [], 'nothing was sent for any of them');
  await client.daemonEndpoint();
  assert.equal(probes(), probesBefore, 'a refused name does not forget the daemon');
  for (const op of ['sessions.list', 'codex.threads', 'host.identity']) await client.callDaemon(ep, op, {});
  assert.deepEqual(seen.slice(before).map((s) => s.url), ['/api/op/sessions.list', '/api/op/codex.threads', '/api/op/host.identity']);
});

test('every op the daemon serves is a valid op name', () => {
  for (const op of api.OPS) assert.match(op, client.OP_NAME, op);
});

test('the browser client refuses a name that is not an op before fetching', async () => {
  const ui = await import('../ui/api.js');
  assert.equal(ui.OP_NAME.source, client.OP_NAME.source, 'the two copies of the rule agree');
  const realFetch = globalThis.fetch; const fetched = [];
  globalThis.fetch = async (...a) => { fetched.push(String(a[0])); throw new Error('not in this test'); };
  try {
    for (const op of ['../pair/approve', '%2e%2e/pair/approve', '..\\pair\\approve', 'a..b', '']) {
      await assert.rejects(ui.call(op, { code: '1' }, { host: 'local' }), (e) => e.badOp && /not an op name/.test(e.message), JSON.stringify(op));
    }
  } finally { globalThis.fetch = realFetch; }
  assert.deepEqual(fetched, []);
});

test('sessions.list asks the daemon for codex threads and starts no local reader', async () => {
  codex.clearListCache(); await daemonUp();
  answer = async (req) => (req.url === '/api/op/codex.threads'
    ? { status: 200, body: { ok: true, result: [{ threadId: 'from-daemon', status: 'idle', loaded: false }] } }
    : { status: 404, body: { ok: false, error: 'no such route' } });
  const starts = await localStarts();
  const r = await api.dispatchLocal('sessions.list', { includeRecent: false });
  assert.deepEqual(codexSessions(r), ['from-daemon']);
  assert.equal(r.codexError, null);
  assert.deepEqual(JSON.parse(seen.filter((s) => s.url === '/api/op/codex.threads').at(-1).body), { limit: 60 });
  assert.equal(await localStarts(), starts, 'no local codex app-server was started');
});

test('a daemon too old to know codex.threads falls back to a local reader', async () => {
  codex.clearListCache(); await daemonUp();
  answer = async () => ({ status: 400, body: { ok: false, error: 'unknown op codex.threads' } });
  const starts = await localStarts();
  const r = await api.dispatchLocal('sessions.list', { includeRecent: false });
  assert.deepEqual(codexSessions(r), ['local-1']);
  assert.ok(await localStarts() > starts, 'the local reader ran');
});

test('a daemon read that fails is reported, not repeated on a second local reader', async () => {
  codex.clearListCache(); codex.stopReadClient(); await daemonUp();
  answer = async () => ({ status: 500, body: { ok: false, error: 'thread/list timed out' } });
  const starts = await localStarts();
  const r = await api.dispatchLocal('sessions.list', { includeRecent: false });
  assert.equal(r.codexError, 'thread/list timed out');
  assert.equal(await localStarts(), starts);
});

test('with no daemon running the read happens locally', async () => {
  codex.clearListCache(); await daemonGone();
  const r = await api.dispatchLocal('sessions.list', { includeRecent: false });
  assert.deepEqual(codexSessions(r), ['local-1']);
});

test('the codex.threads and codex.thread ops ask the daemon too when run outside it', async () => {
  codex.clearListCache(); await daemonUp();
  answer = async (req) => (req.url === '/api/op/codex.threads'
    ? { status: 200, body: { ok: true, result: [{ threadId: 'from-daemon' }] } }
    : req.url === '/api/op/codex.thread' ? { status: 200, body: { ok: true, result: { thread: { id: 'from-daemon', turns: [] } } } }
      : { status: 404, body: { ok: false, error: 'no such route' } });
  const starts = await localStarts();
  assert.deepEqual((await api.dispatchLocal('codex.threads', { limit: 5 })).map((t) => t.threadId), ['from-daemon']);
  assert.deepEqual(JSON.parse(seen.filter((s) => s.url === '/api/op/codex.threads').at(-1).body), { limit: 5, includeArchived: false });
  assert.equal((await api.dispatchLocal('codex.thread', { threadId: 'from-daemon' })).thread.id, 'from-daemon');
  assert.equal(await localStarts(), starts, 'neither op started a local reader');
});

test('with no daemon the codex.threads op reads locally, and codex.thread checks its input', async () => {
  codex.clearListCache(); await daemonGone();
  const threads = await api.dispatchLocal('codex.threads', { limit: '5' });
  assert.deepEqual(threads.map((t) => t.threadId), ['local-1']);
  await assert.rejects(api.dispatchLocal('codex.thread', {}), /threadId/);
});

// Last: marking is one-way for the process.
test('the daemon process never forwards to itself', async () => {
  await daemonUp();
  client.markDaemon();
  assert.equal(await client.daemonEndpoint(), null);
});
