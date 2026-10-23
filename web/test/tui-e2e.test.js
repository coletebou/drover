// End to end: the real `drover tui` in a private tmux server (160x45) against a fake daemon (synthetic data). Keys go
// in with send-keys, assertions read capture-pane and the calls the daemon received.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeDaemon, HASH, REPLY, OWNER_ACTOR } from '../tui/test-support/fake-daemon.js';
import { hasTmux, scratch, testEnv, server, waitFor } from '../tui/test-support/tmux-harness.js';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'drover');
const count = (hay, needle) => hay.split(needle).length - 1;
// The pane runs the TUI under this wrapper, which writes its exit code (or signal) to a file: tmux only knows a dead
// pane's status once it has reaped the child, and on some hosts (GitHub-hosted Ubuntu) #{pane_dead_status} stays empty.
const RECORD_EXIT = "const r = require('node:child_process').spawnSync(process.execPath, process.argv.slice(1), { stdio: 'inherit' }); require('node:fs').writeFileSync(process.env.DROVER_TUI_EXIT_FILE, String(r.status ?? r.signal))";

function start(mode) {
  const ctx = {};
  before(async () => {
    ctx.s = scratch();
    ctx.daemon = await startFakeDaemon({ mode });
    ctx.daemon.writeState(ctx.s.p('state'));
    ctx.exitFile = ctx.s.p('tui-exit');
    ctx.tmux = server(`drover-tui-test-${process.pid}-${mode}`, testEnv(ctx.s, { DROVER_TUI_EXIT_FILE: ctx.exitFile }));
    const r = ctx.tmux.run(['-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '160', '-y', '45', process.execPath, '-e', RECORD_EXIT, BIN, 'tui']);
    assert.equal(r.status, 0, r.stderr);
    ctx.tmux.run(['set-option', '-t', 't', 'remain-on-exit', 'on']);
    ctx.screen = () => ctx.tmux.capture('t');
    ctx.until = (pred, what) => waitFor(() => { const s = ctx.screen(); return pred(s) ? s : null; }, { what: `${what}\n--- screen ---\n${ctx.screen()}` });
  });
  after(async () => { ctx.tmux?.kill(); await ctx.daemon?.close(); ctx.s?.rm(); });
  return ctx;
}

describe('drover tui against a current daemon', { skip: hasTmux ? false : 'tmux is not installed here' }, () => {
  const c = start('new');

  test('the first frame: the manager view, the waiting strip with its keys, the conversation', async () => {
    const s = await c.until((x) => x.includes('thread main') && x.includes('demo-build'), 'the manager view');
    assert.match(s, /1 Manager/);
    assert.match(s, /1 waiting/);
    assert.match(s, /Do you want to proceed\?/);
    assert.match(s, /Enter approve \(1\)/);
    assert.ok(c.daemon.callsOf('stream').some((x) => x.args.topics === 'board,alerts,turn,manager,mutation'), 'subscribed with the TUI topics');
  });

  test('a message to the manager goes out async on thread main, and the streamed reply lands once', async () => {
    c.tmux.type('t', 'who is waiting on me?');
    c.tmux.keys('t', 'Enter');
    const call = await waitFor(() => c.daemon.callsOf('sessions.message').at(-1), { what: 'sessions.message' });
    assert.deepEqual(call.args, { id: 'manager', text: 'who is waiting on me?', wait: false, thread: 'main' });
    const s = await c.until((x) => x.includes('demo-review asked about fixtures.') && !x.includes('▍'), 'the whole reply');
    assert.equal(count(s, 'Two sessions are waiting on you'), 1, 'the final reply replaced the streamed one');
    assert.equal(count(s, 'who is waiting on me?'), 1, 'the echo and the turn event are one turn');
    assert.ok(!s.includes(OWNER_ACTOR), `the turn the daemon records as its owner (${OWNER_ACTOR}) reads as you`);
    assert.ok(REPLY.startsWith('Two sessions'));
  });

  test('the board shows the waiting strip; a digit on the selected strip calls sessions.answer with the key and the hash', async () => {
    c.tmux.keys('t', 'Escape'); c.tmux.keys('t', '2');
    await c.until((x) => x.includes('Waiting on you') && x.includes('Working') && x.includes('Select an agent'), 'the board');
    c.tmux.keys('t', '1');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(c.daemon.callsOf('sessions.answer').length, 0, 'with nothing selected a digit answers nothing');
    assert.ok(!c.screen().includes('Select an agent'), 'it switched to the manager view instead');
    c.tmux.keys('t', '2');
    await c.until((x) => x.includes('Select an agent'), 'back on the board');
    c.tmux.keys('t', 'j');
    await c.until((x) => x.includes('1-3 pick') && x.includes("Yes, and don't ask again"), 'the selected strip with its dialog');
    c.tmux.keys('t', '1');
    const call = await waitFor(() => c.daemon.callsOf('sessions.answer').at(-1), { what: 'sessions.answer' });
    assert.deepEqual(call.args, { id: 's-build', key: '1', expect: HASH });
    await c.until((x) => x.includes('pressed 1 on demo-build'), 'the confirmation');
  });

  test('views switch with digits and Tab; a session opens with its chat and tool groups', async () => {
    c.tmux.keys('t', 'j');   // demo-work: not waiting, so digits switch views again
    await c.until((x) => x.includes('▌◐ demo-work') || x.includes('demo-work  claude on'), 'demo-work selected');
    c.tmux.keys('t', 'Enter');
    let s = await c.until((x) => x.includes('Chat') && x.includes('Screen') && x.includes('Read 1 file, ran 1 command'), 'the session chat');
    assert.match(s, /1 error/);
    assert.ok(c.daemon.callsOf('follow').some((x) => x.args.id === 's-work' && x.args.on === true), 'the transcript is followed for turn events');
    c.tmux.keys('t', 'k'); c.tmux.keys('t', 'Enter');
    s = await c.until((x) => x.includes('1 failing: parser keeps line numbers'), 'the expanded group with results');
    c.tmux.keys('t', 'Escape');
    c.tmux.keys('t', '3');
    s = await c.until((x) => / Sessions {2}on fakehost/.test(x) && x.includes('demo-work'), 'Sessions');
    c.tmux.keys('t', 'Tab');
    s = await c.until((x) => / Tmux {2}on fakehost/.test(x), 'Tmux');
    c.tmux.keys('t', '5');
    s = await c.until((x) => x.includes('a synthetic note'), 'Events');
    c.tmux.keys('t', '?');
    s = await c.until((x) => x.includes('Keys') && x.includes('command palette'), 'help');
    c.tmux.keys('t', 'Escape'); c.tmux.keys('t', '1');
    await c.until((x) => x.includes('thread main'), 'back to the manager');
  });

  test('slash commands: /status and /threads answer inline; q quits and gives the terminal back', async () => {
    c.tmux.keys('t', 'i');
    c.tmux.type('t', '/status'); c.tmux.keys('t', 'Enter');
    await c.until((x) => x.includes('manager on fakehost (writes as manager-test)') && x.includes('$0.12 today'), '/status');
    c.tmux.type('t', '/threads'); c.tmux.keys('t', 'Enter');
    await c.until((x) => x.includes('threads, newest first'), '/threads');
    c.tmux.keys('t', 'Escape'); c.tmux.keys('t', 'q');
    const exit = await waitFor(() => (existsSync(c.exitFile) ? readFileSync(c.exitFile, 'utf8') : null), { what: { toString: () => `the TUI to exit\n--- screen ---\n${c.screen()}` } });
    assert.equal(exit, '0', 'the TUI exits 0');
    assert.ok(!c.screen().includes('thread main'), 'the alternate screen is gone');
  });
});

describe('drover tui against a daemon from before the UX overhaul', { skip: hasTmux ? false : 'tmux is not installed here' }, () => {
  const c = start('old');

  test('the board comes from fleet.summary and a digit falls back to tmux.answer; the manager answers in the call', async () => {
    await c.until((x) => x.includes('thread main'), 'the manager view');
    c.tmux.type('t', 'echo still here'); c.tmux.keys('t', 'Enter');
    await c.until((x) => x.includes('still here') && count(x, 'still here') === 2, 'the blocking reply');
    c.tmux.keys('t', 'Escape'); c.tmux.keys('t', '2');
    await c.until((x) => x.includes('fleet.summary: this daemon has no native.board') && x.includes('demo-build'), 'the fallback board');
    c.tmux.keys('t', 'j');
    await c.until((x) => x.includes('1-2 pick'), 'keys derived from the dialog');
    c.tmux.keys('t', '2');
    const call = await waitFor(() => c.daemon.callsOf('tmux.answer').at(-1), { what: 'tmux.answer' });
    assert.deepEqual(call.args, { target: 'work:1', key: '2', expect: HASH });
    assert.equal(c.daemon.callsOf('sessions.answer').length, 1, 'sessions.answer was tried once');
    await c.until((x) => x.includes('pressed 2 on demo-build') && x.includes('(tmux.answer)'), 'the confirmation');
  });
});
