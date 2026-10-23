// The UX overhaul flows over real HTTP against the fake daemon: a dialog answered with sessions.answer (and
// refused on a stale hash), a stream that sends only the topics asked for, and the manager's reply assembled
// from the stream after a wait:false send.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeDaemon, FAKE_TOKEN } from '../tools/fake-daemon.mjs';
import { createClient } from '../lib/api.js';
import { connectStream } from '../lib/sse.js';
import { normalizeSummary } from '../lib/summary.js';
import { answerPlan, pressKey } from '../lib/answer.js';
import { POPUP_TOPICS, routeEvent, honoursTopics } from '../lib/topics.js';
import { managerInit, managerReduce, managerBusy, lastExchange } from '../lib/manager.js';

let daemon;
before(async () => { daemon = await startFakeDaemon({ token: FAKE_TOKEN, summaryFixture: 'native-summary-dialog.json', streamMs: 5 }); });
after(async () => { await daemon.close(); });

const client = () => createClient({ baseUrl: daemon.url, token: FAKE_TOKEN });
async function until(fn, ms = 3000) {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting'); await new Promise((r) => setTimeout(r, 5)); }
}

test('a waiting row answers its dialog with sessions.answer and the hash it showed', async () => {
  const s = normalizeSummary(await client().op('native.summary'));
  const build = s.waiting.find((w) => w.name === 'demo-build');
  const plan = answerPlan(build);
  assert.deepEqual(plan.buttons.map((b) => b.title), ['1 Yes', "2 Yes, don't ask again", '3 No', 'Enter', 'Esc']);
  const out = await pressKey(client(), build, '2', { actor: 'chrome' });
  assert.equal(out.message, 'Sent 2.');
  assert.deepEqual(daemon.answers.at(-1), { id: build.id, host: 'local', key: '2', actor: 'chrome', expect: '3f2a9c1e5b7d2a46' });
  // A stale screen is refused, and the refusal is an answer, not an error.
  const stale = await pressKey(client(), { ...build, hash: '0000000000000000' }, '1');
  assert.deepEqual(stale, { ok: false, refused: true, unsupported: false, message: 'Not sent: the screen changed since you read it; read it again.' });
});

test('the stream sends only the topics asked for, and hello says so', async () => {
  const got = [];
  const conn = connectStream({ request: client().streamRequest({ topics: POPUP_TOPICS }), onEvent: (e, d) => got.push([e, d]) });
  await until(() => got.some(([e]) => e === 'hello'));
  assert.equal(honoursTopics(got.find(([e]) => e === 'hello')[1]), true);
  daemon.broadcast('fleet', { hosts: ['a megabyte'] });
  daemon.broadcast('snapshot', { ts: 1 });
  daemon.broadcast('summary', { waiting: [], totals: { waiting: 0 } });
  await until(() => got.some(([e]) => e === 'summary'));
  assert.deepEqual(got.map(([e]) => e), ['hello', 'summary']);
  assert.equal(routeEvent('summary', got[1][1], POPUP_TOPICS).kind, 'summary');
  conn.close();
});

test('the manager: wait:false answers at once, the stream writes the reply, the turn settles it', async () => {
  let mgr = managerInit();
  const conn = connectStream({
    request: client().streamRequest({ topics: POPUP_TOPICS }),
    onEvent: (e, d) => {
      const r = routeEvent(e, d, POPUP_TOPICS);
      if (r.kind === 'manager') mgr = managerReduce(mgr, { type: 'stream', data: r.data });
      if (r.kind === 'turn') mgr = managerReduce(mgr, { type: 'turn', data: r.data });
    },
    onState: () => {},
  });
  await new Promise((r) => setTimeout(r, 50));
  mgr = managerReduce(mgr, { type: 'send', text: 'Who is waiting on me?' });
  const t0 = Date.now();
  const res = await client().op('sessions.message', { id: 'manager', text: 'Who is waiting on me?', wait: false, actor: 'chrome' });
  assert.ok(Date.now() - t0 < 1000, 'answers at once');
  assert.equal(res.pending, true);
  mgr = managerReduce(mgr, { type: 'sent', res });
  assert.equal(managerBusy(mgr), true);
  await until(() => !managerBusy(mgr) && lastExchange(mgr).reply?.id);
  const ex = lastExchange(mgr);
  assert.equal(ex.question.text, 'Who is waiting on me?');
  assert.equal(ex.question.id, res.event);
  assert.equal(ex.reply.text, 'You asked: Who is waiting on me?');
  assert.equal(mgr.turns.length, 2, 'the local echo and the streamed reply were replaced, not added to');
  conn.close();
});
