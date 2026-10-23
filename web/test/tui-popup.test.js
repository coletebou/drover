// drover manager popup and keys (tui/popup.js): the plan (pure), the bindings snippet, and the real thing in nested
// private tmux servers: an outer server whose pane holds a client of an inner one (the stand-in for the owner's), so a
// popup has a client to open on. Nothing here talks to the user's tmux server or a real daemon.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync, symlinkSync, mkdirSync, lstatSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parsePopupArgs, popupPlan, sessionFor, isManagerSession, socketOf, keysSnippet, conflicts, freeKeys, parseKeysArgs, configFile, configTargetProblem, writeAtomic, keysCli } from '../tui/popup.js';
import { startFakeDaemon, CAPTURE } from '../tui/test-support/fake-daemon.js';
import { hasTmux, scratch, testEnv, server, waitFor } from '../tui/test-support/tmux-harness.js';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'drover');
const facts = (extra = {}) => ({ client: '/dev/ttys001', clientSession: 'work', origin: { session: 'work', windowId: '@12', paneId: '%40', label: 'work:3 editor' }, sessionExists: false, clientSize: { w: 200, h: 50 }, command: ['/node', '/drover'], socket: '/tmp/tmux-1/default', env: { DROVER_STATE: '/s', HOME: '/h' }, ...extra });

test('popup args: sizes, thread names, one way to pick a thread', () => {
  assert.deepEqual(parsePopupArgs([]), { width: '85%', height: '80%' });
  assert.deepEqual(parsePopupArgs(['--independent', '--width', '90%', '--height', '30', '--client', '/dev/ttys004', '--fresh']), { width: '90%', height: '30', independent: true, client: '/dev/ttys004', fresh: true });
  assert.throws(() => parsePopupArgs(['--independent', '--thread', 'x']), /one/);
  assert.throws(() => parsePopupArgs(['--thread', 'no spaces']), /thread/);
  assert.throws(() => parsePopupArgs(['--width', 'wide']), /percentage/);
  assert.throws(() => parsePopupArgs(['--client', "x'; rm"]), /client/);
  assert.throws(() => parsePopupArgs(['--bogus']), /unknown/);
});

test('session names come from the thread, tmux-safe and one per thread; $TMUX names the socket', () => {
  assert.equal(sessionFor('main'), 'drover-manager');
  assert.equal(sessionFor('ops'), 'drover-manager-ops', 'a name tmux takes as it is stays as it is');
  assert.match(sessionFor('win-@12'), /^drover-manager-win-12-[0-9a-f]{6}$/, 'no @ in a session name: set-option -t cannot find one');
  assert.match(sessionFor('ops:night.1'), /^drover-manager-ops_night_1-[0-9a-f]{6}$/);
  const names = ['ops.a', 'ops_a', 'ops:a', 'ops@a', 'opsa', 'win-@12', 'win-12', 'win-%12'].map(sessionFor);
  assert.equal(new Set(names).size, names.length, `threads that encode alike still get their own session: ${names.join(' ')}`);
  assert.ok(isManagerSession('drover-manager') && isManagerSession('drover-manager-win-12') && !isManagerSession('drover') && !isManagerSession('work'));
  assert.equal(socketOf({ TMUX: '/private/tmp/tmux-501/default,1234,0' }), '/private/tmp/tmux-501/default');
  assert.equal(socketOf({ TMUX: '/tmp/a,b/sock,1,2' }), '/tmp/a,b/sock');
  assert.equal(socketOf({}), null);
});

test('the shared manager: created detached at the popup size, options set, then attached inside display-popup', () => {
  const p = popupPlan(parsePopupArgs([]), facts());
  assert.equal(p.action, 'popup'); assert.equal(p.mode, 'shared'); assert.equal(p.thread, 'main'); assert.equal(p.session, 'drover-manager');
  const env = ['-e', 'DROVER_TUI_POPUP=shared', '-e', 'DROVER_TUI_SESSION=drover-manager', '-e', 'DROVER_STATE=/s'];
  const tui = ['/node', '/drover', 'tui', '--manager', '--from', '%40'];
  assert.deepEqual(p.before, [
    ['new-session', '-d', '-s', 'drover-manager', '-x', '168', '-y', '38', ...env, ...tui],
    ['set-option', '-t', '=drover-manager:', '@drover-thread', 'main'],
    ['set-option', '-t', '=drover-manager:', 'status', 'off'],
    ['set-option', '-t', '=drover-manager:', '@drover-from', '%40'],
  ]);
  assert.deepEqual(p.popup, ['display-popup', '-c', '/dev/ttys001', '-E', '-w', '85%', '-h', '80%', '-T', ' drover manager · shared ', 'env', '-u', 'TMUX', 'tmux', '-S', '/tmp/tmux-1/default', 'new-session', '-A', '-s', 'drover-manager', ...env, ...tui]);
  const again = popupPlan(parsePopupArgs([]), facts({ sessionExists: true, sessionThread: 'main' }));
  assert.deepEqual(again.before.map((s) => s[0]), ['set-option', 'set-option'], 'an existing manager is only told where it was opened from');
  assert.equal(popupPlan(parsePopupArgs([]), facts({ sessionExists: true, sessionThread: null })).action, 'popup', 'a shared session from before the mark ran main');
});

test('a manager session is reused only for the thread it holds', () => {
  const s = sessionFor('ops.a');
  assert.throws(() => popupPlan(parsePopupArgs(['--thread', 'ops.a']), facts({ sessionExists: true, sessionThread: 'ops_a' })), new RegExp(`${s} holds thread ops_a, not ops.a; end it \\(tmux kill-session -t =${s}\\)`));
  assert.throws(() => popupPlan(parsePopupArgs(['--thread', 'ops']), facts({ sessionExists: true, sessionThread: null })), /holds a manager from an older drover, not ops/);
  assert.throws(() => popupPlan(parsePopupArgs([]), facts({ sessionExists: true, sessionThread: 'win-@3' })), /holds thread win-@3, not main/);
  const ok = popupPlan(parsePopupArgs(['--thread', 'ops.a']), facts({ sessionExists: true, sessionThread: 'ops.a' }));
  assert.deepEqual([ok.session, ok.before.map((x) => x[0])], [s, ['set-option', 'set-option']]);
  const made = popupPlan(parsePopupArgs(['--thread', 'ops.a']), facts());
  assert.deepEqual(made.before[1], ['set-option', '-t', `=${s}:`, '@drover-thread', 'ops.a'], 'a new session is marked with its thread');
});

test('keys --install never writes through a symlink, and writes atomically', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'drover-tui-keys-'));
  try {
    const xdg = path.join(dir, 'xdg'); const file = path.join(xdg, 'drover', 'manager.tmux.conf'); const victim = path.join(dir, 'tmux.conf');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(victim, 'set -g mouse on\n');
    symlinkSync(victim, file);
    assert.match(configTargetProblem(file), /is a symbolic link \(to .*tmux\.conf\); nothing is written through it/);
    const out = []; const errs = [];
    // TMUX_TMPDIR in the scratch dir and no TMUX: if anything reached tmux it would find no server, never the user's.
    const code = await keysCli(['--install'], { env: { HOME: dir, XDG_CONFIG_HOME: xdg, TMUX_TMPDIR: dir, PATH: process.env.PATH }, log: (x) => out.push(x), err: (x) => errs.push(x) });
    assert.equal(code, 1);
    assert.match(errs.join(''), /symbolic link.*Nothing changed/s);
    assert.equal(readFileSync(victim, 'utf8'), 'set -g mouse on\n', 'the link target is untouched');
    assert.ok(lstatSync(file).isSymbolicLink(), 'and the link is left as it was');
    rmSync(file);
    mkdirSync(file);
    assert.match(configTargetProblem(file), /not a regular file/);
    rmSync(file, { recursive: true });
    writeAtomic(file, 'one\n'); writeAtomic(file, 'two\n');
    assert.equal(readFileSync(file, 'utf8'), 'two\n');
    assert.deepEqual(readdirSync(path.dirname(file)), ['manager.tmux.conf'], 'no temp file left behind');
    assert.equal(configTargetProblem(file), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('independent, a named thread, fresh, and the toggle', () => {
  const ind = popupPlan(parsePopupArgs(['--independent']), facts());
  assert.deepEqual([ind.thread, ind.session, ind.mode], ['win-@12', sessionFor('win-@12'), 'independent']);
  assert.ok(ind.before[0].includes('--thread') && ind.before[0].includes('win-@12'));
  const th = popupPlan(parsePopupArgs(['--thread', 'ops']), facts());
  assert.deepEqual([th.thread, th.session, th.mode], ['ops', 'drover-manager-ops', 'thread']);
  const fresh = popupPlan(parsePopupArgs(['--fresh']), facts());
  assert.deepEqual(fresh.before, []);
  assert.deepEqual(fresh.popup.slice(-6), ['/node', '/drover', 'tui', '--manager', '--from', '%40'], 'the TUI straight in the popup');
  assert.deepEqual(popupPlan(parsePopupArgs([]), facts({ clientSession: 'drover-manager' })), { action: 'detach', argv: ['detach-client', '-t', '/dev/ttys001'] }, 'pressed inside a manager: hide it');
  assert.deepEqual(popupPlan(parsePopupArgs(['--independent']), facts({ client: null, clientSession: sessionFor('win-@12') })), { action: 'detach', argv: ['detach-client', '-s', `=${sessionFor('win-@12')}`] });
  assert.throws(() => popupPlan(parsePopupArgs([]), facts({ origin: null })), /no window/);
  const nopass = popupPlan(parsePopupArgs([]), facts({ env: {} }));
  assert.ok(!nopass.popup.some((a) => String(a).startsWith('DROVER_STATE=')), 'only variables that are set are passed');
});

test('the bindings snippet: run-shell with the client and pane, quoted for tmux and sh', () => {
  const s = keysSnippet({ command: ['/opt/node', '/home/alice/dir with space/drover'] });
  assert.match(s, /^bind-key g run-shell -b '"\/opt\/node" "\/home\/alice\/dir with space\/drover" manager popup --quiet --client "#\{client_name\}" --from "#\{pane_id\}"'$/m);
  assert.match(s, /^bind-key G run-shell -b '.* manager popup --independent --quiet --client "#\{client_name\}" --from "#\{pane_id\}"'$/m);
  assert.match(keysSnippet({ command: ['/n', '/a#b$c'] }), /"\/a##b\\\$c"/, 'tmux formats and sh expansions escaped');
  assert.throws(() => keysSnippet({ command: ["/it's"] }), /quote/);
  assert.throws(() => keysSnippet({ key: 'M', independentKey: 'M' }), /different/);
  assert.throws(() => keysSnippet({ key: 'Escape' }), /letter/);
  assert.deepEqual(parseKeysArgs(['--install', '--key', 'O', '--force']), { key: 'O', independentKey: 'G', install: true, force: true });
  assert.equal(configFile({ HOME: '/h' }), '/h/.config/drover/manager.tmux.conf');
  assert.equal(configFile({ HOME: '/h', XDG_CONFIG_HOME: '/x' }), '/x/drover/manager.tmux.conf');
});

test('conflicts: tmux defaults and our own bindings may be replaced, a binding someone chose may not', () => {
  const list = [
    'bind-key    -T prefix M       select-pane -M',
    'bind-key    -T prefix m       select-pane -m',
    'bind-key    -T prefix N       run-shell -b "drover manager popup --independent"',
    'bind-key -r -T prefix O       resize-pane -U',
    'bind-key    -T copy-mode M    send-keys -X x',
  ].join('\n');
  assert.deepEqual(conflicts(list, ['M', 'N']), []);
  assert.deepEqual(conflicts(list, ['O']), [{ key: 'O', binding: 'resize-pane -U' }]);
  const mine = 'bind-key    -T prefix M       set-option -g mouse \\; display-message "mouse: #{?mouse,on,off}"';
  assert.equal(conflicts(mine, ['M', 'N'])[0].key, 'M', 'a mouse toggle someone bound to prefix + M is protected');
  assert.deepEqual(freeKeys(`${list}\n${mine}`, 2), ['G', 'J']);
});

describe('real tmux: the bindings open, hide and reopen the manager; /look captures the window it came from', { skip: hasTmux ? false : 'tmux is not installed here' }, () => {
  let s, daemon, inner, outer, env;
  before(async () => {
    s = scratch();
    daemon = await startFakeDaemon();
    daemon.writeState(s.p('state'));
    env = testEnv(s);
    inner = server(`drover-tui-test-${process.pid}-in`, env);
    outer = server(`drover-tui-test-${process.pid}-out`, env);
    assert.equal(inner.run(['-f', '/dev/null', 'new-session', '-d', '-s', 'work', '-x', '150', '-y', '42', '-n', 'editor', 'sh', '-c', 'printf "editor window text\\n"; exec sleep 600']).status, 0);
    inner.run(['new-window', '-d', '-t', 'work', '-n', 'logs', 'sleep', '600']);
    assert.equal(outer.run(['-f', '/dev/null', 'new-session', '-d', '-s', 'o', '-x', '160', '-y', '45', 'env', '-u', 'TMUX', 'tmux', '-L', inner.name, 'attach', '-t', 'work']).status, 0);
    await waitFor(() => inner.run(['list-clients', '-F', '#{client_name}']).stdout.trim(), { what: 'the inner client' });
  });
  after(async () => { outer?.kill(); inner?.kill(); await daemon?.close(); s?.rm(); });
  const screen = () => outer.capture('o');
  const until = (pred, what) => waitFor(() => { const x = screen(); return pred(x) ? x : null; }, { what: `${what}\n--- screen ---\n${screen()}` });
  const cli = (...args) => spawnSync(process.execPath, [BIN, 'manager', ...args], { env: inner.paneEnv('%0'), encoding: 'utf8' });

  test('keys --install writes the snippet and loads it into the server it runs in', () => {
    const r = cli('keys', '--install');
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(configFile(env)), 'the snippet file');
    assert.match(readFileSync(configFile(env), 'utf8'), /bind-key g run-shell/);
    assert.match(inner.run(['list-keys', '-T', 'prefix']).stdout, /^bind-key\s+-T prefix g\s+run-shell -b .*manager popup --quiet/m, 'tmux 3.7 lists nothing for list-keys -T prefix g: read the table');
    assert.match(r.stdout, /never edits ~\/\.tmux\.conf/);
    const busy = cli('keys', '--install', '--key', 'c');
    assert.equal(busy.status, 1, 'prefix + c (new-window) belongs to someone');
    assert.match(busy.stderr, /prefix \+ c is already bound to: new-window/);
  });

  test('prefix g opens the shared manager over the window; inside it, prefix g hides it; the draft is still there', async () => {
    outer.keys('o', 'C-b'); outer.keys('o', 'g');
    await until((x) => x.includes('drover manager · shared') && x.includes('thread main') && x.includes(daemon.url.replace(/^http:\/\/|\/$/g, '')), 'the popup on the fake daemon');
    assert.match(inner.run(['show-options', '-t', '=drover-manager:', '-qv', '@drover-from']).stdout, /^%0\s*$/, 'the window it came from');
    assert.match(inner.run(['show-options', '-t', '=drover-manager:', '-v', 'status']).stdout, /off/);
    outer.type('o', 'a draft that survives');
    await until((x) => x.includes('a draft that survives'), 'the draft');
    outer.keys('o', 'C-b'); outer.keys('o', 'g');
    await until((x) => !x.includes('drover manager · shared') && x.includes('editor window text'), 'the popup hidden');
    assert.match(inner.run(['list-sessions', '-F', '#{session_name} #{session_attached}']).stdout, /^drover-manager 0$/m, 'the manager keeps running, detached');
    outer.keys('o', 'C-b'); outer.keys('o', 'g');
    const x = await until((y) => y.includes('drover manager · shared') && y.includes('a draft that survives'), 'the same manager back');
    assert.ok(!x.includes('[0/0]'), 'nothing in view mode over it (the binding is quiet)');
  });

  test('/look captures the origin pane and goes with the next message; prefix G gives another window its own thread', async () => {
    outer.keys('o', 'C-u');   // drop the draft
    outer.type('o', '/look'); outer.keys('o', 'Enter');
    await until((x) => x.includes('attached 4 lines of tmux window work:0 "editor" (pane %0)'), '/look');
    assert.deepEqual(daemon.callsOf('tmux.capture').at(-1).args, { target: '%0', lines: 60 });
    outer.type('o', 'what is this?'); outer.keys('o', 'Enter');
    const call = await waitFor(() => daemon.callsOf('sessions.message').at(-1), { what: 'the message' });
    assert.equal(call.args.thread, 'main');
    assert.ok(call.args.text.startsWith('what is this?\n\n[tmux window work:0 "editor" (pane %0) on fakehost, last 4 lines]\n```\n'), call.args.text.slice(0, 120));
    assert.ok(call.args.text.includes(CAPTURE));
    await until((x) => x.includes('+ attached tmux window work:0 "editor" (pane %0) on fakehost, 4 lines'), 'the attachment shown as one line');
    outer.keys('o', 'C-b'); outer.keys('o', 'g');
    await until((x) => !x.includes('drover manager · shared'), 'hidden');
    outer.keys('o', 'C-b'); outer.keys('o', '1');
    await new Promise((r) => setTimeout(r, 300));
    outer.keys('o', 'C-b'); outer.keys('o', 'G');
    await until((x) => x.includes('drover manager · win-@1') && x.includes('thread win-@1'), 'the independent manager');
    const ind = sessionFor('win-@1');
    assert.ok(inner.run(['list-sessions', '-F', '#{session_name}']).stdout.split('\n').includes(ind), ind);
    assert.match(inner.run(['show-options', '-t', `=${ind}:`, '-qv', '@drover-from']).stdout, /^%1\s*$/);
    assert.match(inner.run(['show-options', '-t', `=${ind}:`, '-qv', '@drover-thread']).stdout, /^win-@1\s*$/, 'the session knows its thread');
    await waitFor(() => daemon.callsOf('sessions.transcript').some((c) => c.args.id === 'manager' && c.args.thread === 'win-@1'), { what: 'the independent thread read' });
    outer.keys('o', 'C-b'); outer.keys('o', 'G');
    await until((x) => !x.includes('drover manager · win-@1'), 'prefix G hides it too');
  });
});
