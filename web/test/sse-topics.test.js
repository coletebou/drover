// The event stream's topics and light events (server/http.js): a client that names topics hears only those, one
// that names none hears everything as before, and board / summary are computed only while someone listens and sent
// only when they changed. The board is built from a canned fleet (native._deps.dispatch), so no tmux, sessions or
// hosts of this machine are read. Real server on port 0, temp state.
import './isolate-cache.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DROVER_STATE = await mkdtemp(path.join(tmpdir(), 'drover-sse-'));
const http = await import('../server/http.js');
const native = await import('../core/native.js');

let fleet = { ts: 1, hosts: [{ host: 'local', ok: true, sessions: [{ id: 's1', sessionId: 's1', name: 'demo-build', live: true, status: 'busy', engine: 'claude' }], windows: [] }] };
native._deps.dispatch = async (op) => (op === 'fleet.summary' ? fleet : op === 'notify.recent' ? { items: [] } : null);

let srv, base, token;
before(async () => { srv = await http.startServer({ port: 0 }); base = srv.url.replace(/\/$/, ''); token = srv.token; });
after(() => srv?.server.close());

/** An SSE client: collects { event, data } and resolves waits for an event name. */
async function client(query = '') {
  const ac = new AbortController();
  const res = await fetch(`${base}/api/stream${query}`, { headers: { authorization: `Bearer ${token}` }, signal: ac.signal });
  assert.equal(res.status, 200);
  const got = [];
  const waiters = [];
  (async () => {
    const dec = new TextDecoder(); let buf = '';
    try {
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = block.match(/^event: (.+)$/m)?.[1]; const data = block.match(/^data: (.+)$/m)?.[1];
          if (!ev) continue;
          got.push({ event: ev, data: JSON.parse(data) });
          for (const w of waiters.splice(0)) w();
        }
      }
    } catch { /* aborted */ }
  })();
  const waitFor = async (name, n = 1, ms = 3000) => {
    const end = Date.now() + ms;
    while (got.filter((g) => g.event === name).length < n) {
      if (Date.now() > end) throw new Error(`no ${name} event (got ${got.map((g) => g.event).join(', ')})`);
      await new Promise((r) => { waiters.push(r); setTimeout(r, 50); });
    }
    return got.filter((g) => g.event === name);
  };
  return { got, waitFor, close: () => ac.abort() };
}

test('topicsOf: a list of event names, or null for everything', () => {
  assert.equal(http.topicsOf(new URL('http://x/api/stream')), null);
  assert.deepEqual([...http.topicsOf(new URL('http://x/api/stream?topics=board,%20turn,,bad!name,alerts'))], ['board', 'turn', 'alerts']);
  assert.deepEqual([...http.topicsOf(new URL('http://x/api/stream?topics='))], []);
});

test('a client with topics hears only those; one without hears everything', async () => {
  const light = await client('?topics=board,turn');
  const all = await client('');
  const [hello] = await light.waitFor('hello');
  assert.deepEqual(hello.data.topics, ['board', 'turn']);
  await all.waitFor('hello');
  http.broadcast('fleet', { big: 'x'.repeat(1000) });
  http.broadcast('turn', { id: 's1', turn: { role: 'assistant', text: 'hi' } });
  await all.waitFor('turn');
  await light.waitFor('turn');
  assert.ok(all.got.some((g) => g.event === 'fleet'));
  assert.ok(!light.got.some((g) => g.event === 'fleet'), 'the megabyte fleet event skips a client that did not ask for it');
  light.close(); all.close();
});

test('board events: the current board on subscribe, a new one only when it changed', async () => {
  const c = await client('?topics=board');
  const [first] = await c.waitFor('board');
  assert.deepEqual(first.data.strips.map((s) => [s.name, s.lane]), [['demo-build', 'work']]);
  http.lightSoon(0);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(c.got.filter((g) => g.event === 'board').length, 1, 'unchanged (generatedAt aside): not sent again');
  fleet = { ...fleet, hosts: [{ ...fleet.hosts[0], sessions: [{ ...fleet.hosts[0].sessions[0], status: 'idle' }] }] };
  http.lightSoon(0);
  const boards = await c.waitFor('board', 2);
  assert.equal(boards[1].data.strips[0].lane, 'idle');
  c.close();
});

test('summary events go to the clients that ask for them', async () => {
  const c = await client('?topics=summary');
  try {
    const [s] = await c.waitFor('summary');
    // owner: the actor the owner's clients write as (core/owner.js), so an app shows their turns as "you".
    assert.deepEqual(Object.keys(s.data).sort(), ['generatedAt', 'hosts', 'manager', 'owner', 'totals', 'waiting', 'working']);
    assert.ok(!c.got.some((g) => g.event === 'board'));
  } finally { c.close(); }
});
