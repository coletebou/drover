// Notifications sent while no daemon was up (drover op notify.send from a shell, an MCP call with no daemon, a peer's
// rpc): emit() marks the truth-file event offline: true, and a daemon that starts later shows those that no ring held
// (core/notify.js replayOffline), once, without appending a second event. No daemon, no truth file: every side effect
// goes through injected deps.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_SETTINGS, mergeSettings } from '../ui/notify-policy.js';
import { alertFromOfflineEvent, REPLAY_MAX_AGE_MS, Notifier, _deps as notifyDeps } from '../core/notify.js';

const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const at = (minAgo) => new Date(NOW - minAgo * 60_000).toISOString();
const offline = (id, minAgo, over = {}) => ({ id, ts: at(minAgo), type: 'notify', source: 'agent', category: 'needs-you', kind: 'agent', hostname: 'box-a', sessionId: null, sessionName: 'builder', title: `title ${id}`, message: `body ${id}`, key: `agent|builder|${id}|1`, offline: true, ...over });

describe('offline notify replay', () => {
  let dir, events, appended;
  const ringFile = (items) => writeFile(path.join(dir, 'notify-ring.json'), JSON.stringify({ host: 'box-a', pid: 1, ts: at(50), items }));
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'drover-replay-'));
    events = []; appended = [];
    Object.assign(notifyDeps, {
      appendEvent: async (ev, opts) => { const stored = { id: `e-${appended.length + 1}`, ts: new Date(NOW).toISOString(), actor: opts?.actor, ...ev }; appended.push(stored); return stored; },
      readEvents: async () => events,
      settings: async () => mergeSettings(DEFAULT_SETTINGS, {}),
      host: () => 'box-a', now: () => NOW,
      ringFile: () => path.join(dir, 'notify-ring.json'), daemonFile: () => path.join(dir, 'daemon.json'),
    });
  });

  test('emit marks what a process that is not the daemon records, and only that', async () => {
    const nf = new Notifier();
    await nf.emit([{ category: 'needs-you', kind: 'agent', source: 'agent', host: 'box-a', title: 'a', body: 'b', key: 'k1' }]);
    nf.daemon = true;
    await nf.emit([{ category: 'needs-you', kind: 'agent', source: 'agent', host: 'box-a', title: 'c', body: 'd', key: 'k2' }]);
    assert.deepEqual(appended.map((e) => e.offline), [true, undefined]);
  });

  test('the alert an offline event stands for keeps its id, time, key and text', () => {
    const a = alertFromOfflineEvent(offline('o1', 5, { ask: { kind: 'question', label: 'asked', text: 'ok?' } }));
    assert.deepEqual([a.id, a.ts, a.key, a.title, a.body, a.host, a.name, a.category, a.replayed], ['o1', at(5), 'agent|builder|o1|1', 'title o1', 'body o1', 'box-a', 'builder', 'needs-you', true]);
    assert.equal(a.ask.kind, 'question');
  });

  test('replays offline events newer than the ring, at most a day old, once each, without a second truth-file event', async () => {
    events = [
      offline('too-old', 25 * 60),                          // over 24 h
      offline('before-ring', 100),                          // older than the previous daemon's newest item
      offline('a', 30), offline('b', 20),
      offline('dup', 10, { key: 'agent|builder|b|1' }),     // same key as b: one alert
      { ...offline('live', 12), offline: undefined },       // recorded by a daemon: it was shown then
      offline('test', 8, { test: true }),
    ];
    await ringFile([{ id: 'x', ts: at(90) }]);
    const nf = new Notifier();
    const got = [];
    nf.on((items) => got.push(...items));
    const out = await nf.replayOffline();
    assert.deepEqual(out.map((a) => a.id), ['a', 'b'], 'oldest first; dup shares b\'s key, live and test are not offline alerts');
    assert.deepEqual(got.map((a) => a.id), ['a', 'b'], 'listeners got the same alerts');
    assert.deepEqual(nf.recent().map((a) => a.id), ['a', 'b'], 'they are in the ring');
    assert.equal(appended.length, 0, 'nothing is appended to the truth file');
    assert.deepEqual(await nf.replayOffline(), [], 'a second replay in the same process shows nothing twice');
  });

  test('the previous daemon\'s ring file is the floor: a restart does not show them again', async () => {
    events = [offline('a', 30), offline('b', 20)];
    await ringFile([{ id: 'a', ts: at(30) }, { id: 'b', ts: at(20) }]);   // what the first replay left in the file
    assert.deepEqual(await new Notifier().replayOffline(), []);
  });

  test('with no ring file every offline event inside the last day is replayed; older ones are not', async () => {
    events = [offline('day-old', REPLAY_MAX_AGE_MS / 60_000 - 1), offline('too-old', REPLAY_MAX_AGE_MS / 60_000 + 1)];
    assert.deepEqual((await new Notifier().replayOffline()).map((a) => a.id), ['day-old']);
  });
});
