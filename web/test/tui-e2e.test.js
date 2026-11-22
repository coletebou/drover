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
/** Where needle is on a captured screen (column and row from 0), searching from row `from`; the first match. */
const at = (screen, needle, from = 0) => { const lines = screen.split('\n'); for (let y = from; y < lines.length; y++) { const x = lines[y].indexOf(needle); if (x >= 0) return { x, y }; } throw new Error(`${needle} is not on the screen:\n${screen}`); };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
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

  test('workspaces switch with digits and Tab, sub-views with < and >; a session opens with its chat and tool groups', async () => {
    c.tmux.keys('t', 'j');   // demo-work: not waiting, so digits switch workspaces again
    await c.until((x) => x.includes('▌◐ demo-work') || x.includes('demo-work  claude on'), 'demo-work selected');
    c.tmux.keys('t', 'Enter');
    let s = await c.until((x) => x.includes('Chat') && x.includes('Screen') && x.includes('Read 1 file, ran 1 command'), 'the session chat');
    assert.match(s, /1 error/);
    assert.ok(c.daemon.callsOf('follow').some((x) => x.args.id === 's-work' && x.args.on === true), 'the transcript is followed for turn events');
    c.tmux.keys('t', 'k'); c.tmux.keys('t', 'Enter');
    s = await c.until((x) => x.includes('1 failing: parser keeps line numbers'), 'the expanded group with results');
    c.tmux.keys('t', 'Escape');
    await c.until((x) => x.includes('Waiting on you') && x.includes(' Lanes '), 'back on Agents › Lanes');
    c.tmux.keys('t', '>');
    s = await c.until((x) => / Sessions {2}on fakehost/.test(x) && x.includes('demo-work'), 'Agents › List');
    assert.match(s.split('\n')[s.split('\n').findIndex((l) => / Sessions {2}on fakehost/.test(l)) + 3] ?? '', /demo-work/, 'the agent selected in Lanes is the row selected in List');
    c.tmux.keys('t', '>');
    s = await c.until((x) => / Tmux {2}on fakehost/.test(x), 'Agents › Windows');
    c.tmux.keys('t', 'Tab');
    s = await c.until((x) => x.includes('Prompts · Mine') && x.includes('Make the demo parser keep line numbers'), 'Prompts, by Tab');
    c.tmux.keys('t', '6'); c.tmux.keys('t', 'Escape');   // Find opens on Search, which types its query: stop typing
    c.tmux.keys('t', '>'); c.tmux.keys('t', '>');
    s = await c.until((x) => x.includes('a synthetic note'), 'Find › Events');
    c.tmux.keys('t', '?');
    s = await c.until((x) => x.includes('Keys') && x.includes('command palette'), 'help');
    c.tmux.keys('t', 'Escape'); c.tmux.keys('t', '1');
    await c.until((x) => x.includes('thread main'), 'back to the manager');
  });

  test('the mouse: tabs, a strip picked then opened, session tabs, the wheel, a footer hint, a dialog answered by a second click', async () => {
    let s = await c.until((x) => x.includes('thread main'), 'the manager');
    c.tmux.mouse('t', at(s, '2 Agents').x + 1, 0);
    s = await c.until((x) => / Tmux {2}on fakehost/.test(x), 'Agents, by a click on its tab: the sub-view it showed last');
    c.tmux.mouse('t', at(s, ' Lanes ').x + 1, 1);
    s = await c.until((x) => x.includes('Waiting on you') && x.includes('Esc clear'), 'Lanes, by a click on its sub-tab (the agent selected before is carried, not armed)');
    c.tmux.keys('t', 'Escape');
    s = await c.until((x) => x.includes('Select an agent'), 'nothing selected');
    c.tmux.mouse('t', 20, 6, 65); c.tmux.mouse('t', 20, 6, 64);
    await pause(250);
    assert.ok(c.screen().includes('Select an agent'), 'the wheel selects no strip');
    const work = at(s, 'demo-work', 2);
    c.tmux.mouse('t', work.x, work.y);
    s = await c.until((x) => x.includes('demo-work  claude on'), 'demo-work selected by a click');
    c.tmux.mouse('t', work.x, work.y);
    s = await c.until((x) => x.includes('Chat') && x.includes('Read 1 file, ran 1 command'), 'opened by a second click');
    c.tmux.mouse('t', at(s, 'Info', 2).x + 1, at(s, 'Info', 2).y);
    s = await c.until((x) => /session id\s+s-work/.test(x), 'Info, by a click on the session tab');
    c.tmux.mouse('t', at(s, '6 Find').x + 1, 0);
    s = await c.until((x) => x.includes('a synthetic note'), 'Find › Events (shown there last), from inside a session');
    c.tmux.mouse('t', at(s, '/ filter', 44).x, 44);
    s = await c.until((x) => x.includes('filter: ▍'), 'filtering, by a click on the / hint');
    c.tmux.mouse('t', at(s, 'Esc clear', 44).x + 4, 44);
    s = await c.until((x) => !x.includes('filter:'), 'Esc, clicked, ends it');
    c.tmux.mouse('t', 2, 0);
    s = await c.until((x) => x.includes('Commands') && x.includes('Go to Agents'), 'the palette, by a click on the name');
    c.tmux.mouse('t', 0, 43);
    s = await c.until((x) => !x.includes('Go to Agents'), 'a click outside closes it');
    c.tmux.mouse('t', at(s, '1 Manager').x + 1, 0);
    s = await c.until((x) => x.includes('thread main') && x.includes('3 No'), 'the manager with the waiting dialog');
    const before = c.daemon.callsOf('sessions.answer').length;
    const no = at(s, '3 No');
    c.tmux.mouse('t', no.x + 2, no.y);
    await c.until((x) => x.includes('click 3 again'), 'the first click picks the strip');
    await pause(250);
    assert.equal(c.daemon.callsOf('sessions.answer').length, before, 'and presses nothing');
    c.tmux.mouse('t', no.x + 2, no.y);
    const call = await waitFor(() => c.daemon.callsOf('sessions.answer').slice(before)[0], { what: 'sessions.answer from the second click' });
    assert.deepEqual(call.args, { id: 's-build', key: '3', expect: HASH });
    s = await c.until((x) => x.includes('pressed 3 on demo-build'), 'the confirmation');
    const lines = s.split('\n'); const box = { x: 0, y: lines.findLastIndex((l) => l.startsWith('›')) };   // the composer
    c.tmux.mouse('t', box.x + 4, box.y);   // back to typing: a click on the composer
    await pause(150);
    c.tmux.type('t', 'typed after a click');
    await c.until((x) => x.includes('› typed after a click'), 'the composer has the focus');
    c.tmux.keys('t', 'C-u'); c.tmux.keys('t', 'Escape');   // as the test before left it: not typing
  });

  test('seven workspaces and a sub-tab row; hover follows motion reports; Prompts list and detail; the Wall in colour', async () => {
    let s = await c.until((x) => x.includes('thread main'), 'the manager');
    const lines = s.split('\n');
    assert.match(lines[0], /1 Manager\s+2 Agents\s+3 Prompts\s+4 Work\s+5 Fleet\s+6 Find\s+7 Settings/);
    assert.match(lines[1], /Manager\s+What should I do next\?/, 'the sub-tab row');
    // Hover: the pointer over a tab tints it (its background changes), and moves elsewhere take the tint away.
    const tab = at(s, '4 Work');
    const bgAt = (screen, needle) => { const row = screen.split('\n').find((l) => l.replace(/\x1b\[[0-9;]*m/g, '').includes(needle)) ?? ''; const i = row.indexOf(needle); return (row.slice(0, i).match(/\x1b\[[0-9;]*m/g) ?? []).join(''); };
    const before = bgAt(c.tmux.captureEscapes('t'), ' 4 Work ');
    c.tmux.move('t', tab.x + 1, 0);
    await waitFor(() => bgAt(c.tmux.captureEscapes('t'), ' 4 Work ') !== before, { what: 'the hover tint on the tab' });
    c.tmux.move('t', 20, 20);
    await waitFor(() => bgAt(c.tmux.captureEscapes('t'), ' 4 Work ') === before, { what: 'the tint gone when the pointer leaves' });
    assert.ok(c.screen().includes('thread main'), 'hovering a tab goes nowhere');
    // Prompts: newest first, the detail with the verbatim text; hovering a row previews it in the bottom bar.
    c.tmux.keys('t', 'Escape'); c.tmux.keys('t', '3');
    s = await c.until((x) => x.includes('Prompts · Mine') && x.includes('Keep the old API:'), 'Prompts with the detail');
    assert.match(s, /when host\s+engine\s+project\s+via\s+text/);
    assert.ok(c.daemon.callsOf('prompts.list').some((x) => x.args.who === 'mine'), 'Mine asks for what a person sent');
    const row = at(s, 'write the release notes (#2)');
    c.tmux.move('t', row.x, row.y);
    await c.until((x) => x.split('\n')[44].trimEnd().endsWith('write the release notes (#2)'), 'the hovered prompt previewed in the bottom bar');
    // The Wall: tiles with the pane in colour (the fake pane's green tick).
    c.tmux.keys('t', '2'); c.tmux.mouse('t', 1, 1);   // Agents, then its first sub-tab (Lanes) by a click
    s = await c.until((x) => x.includes('Waiting on you'), 'Lanes');
    c.tmux.mouse('t', at(s, ' Wall ', 1).x + 1, 1);
    s = await c.until((x) => x.includes(' Wall  3 agents') && x.includes('✗ 1 failing'), 'the Wall with captured panes');
    assert.ok(c.daemon.callsOf('tmux.captureMany').some((x) => x.args.escapes === true && x.args.targets.includes('work:1') && x.args.targets.includes('work:2')), 'one captureMany for both panes');
    assert.match(c.tmux.captureEscapes('t'), /\x1b\[[0-9;]*(32|38;5;\d+|38;2;13;188;121)[0-9;]*m✓/, 'the tick in green');
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
