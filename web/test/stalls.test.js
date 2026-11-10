// Stalled work (ui/stalls.js): typed input never submitted, a final reply that asks the owner and was never answered,
// and a launch that ended or idled without its completion text. The fixtures are synthetic screens and replies in the
// shapes Claude Code 2.1.3xx draws and writes; each signal has at least one negative. The last block runs the real
// flow: launches through core/launch.js into a private tmux server (its own socket directory, no user config) of
// fake Claude Code agents that draw the 2.1.3xx input box, text typed into one with tmux.send and no Enter, then
// fleet.summary and native.summary read it back. HOME, the Claude config dir, the state, cache and truth file are all
// temporary: no session, pane or file of the user is read or touched.
// Run: node --test test/stalls.test.js
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, chmod, rm, readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = realpathSync(await mkdtemp(path.join(tmpdir(), 'drover-stalls-')));
const saved = Object.fromEntries(['HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'PATH', 'TMUX', 'TMUX_PANE', 'TMUX_TMPDIR'].map((k) => [k, process.env[k]]));
process.env.HOME = path.join(dir, 'home');
process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'home', '.claude');
process.env.DROVER_PROFILES = path.join(dir, 'profiles.json');
process.env.DROVER_STATE = path.join(dir, 'state');
process.env.DROVER_DOTFILES = path.join(dir, 'dotfiles');
process.env.DROVER_EVENTS = path.join(dir, 'dotfiles', 'claude', 'drover-events.jsonl');
process.env.DROVER_CACHE = path.join(dir, 'cache');
process.env.DROVER_HOST = 'testbox';
await mkdir(path.join(dir, 'dotfiles', 'claude'), { recursive: true });
await mkdir(path.join(process.env.CLAUDE_CONFIG_DIR, 'sessions'), { recursive: true });
// No real agent binary runs: codex fails at once (the session list's Codex reader gives up), claude is the fake below.
process.env.CODEX_HOME = path.join(dir, 'codex');
const bin = path.join(dir, 'bin'); await mkdir(bin);
await writeFile(path.join(bin, 'codex'), '#!/bin/sh\nexit 1\n'); await chmod(path.join(bin, 'codex'), 0o755);
process.env.PATH = `${bin}:${saved.PATH}`;
await writeFile(process.env.DROVER_PROFILES, JSON.stringify({
  claude: { models: [], profiles: [{ id: 'claude-plain', label: 'plain', argv: [], env: {}, default: true }] },
  codex: { models: [], profiles: [{ id: 'codex-plain', label: 'plain', argv: [], env: {}, default: true }] },
}));

const tmux = await import('../core/tmux.js');
const { inputBox, typedInput } = tmux;
const { ownerAsk } = await import('../ui/notify-policy.js');
const { stallsFor, launchDeclarations } = await import('../ui/stalls.js');
const { buildSummary } = await import('../core/native.js');
const launchMod = await import('../core/launch.js');
const claude = await import('../core/claude.js');
const api = await import('../core/api.js');
const codex = await import('../core/codex.js');
after(async () => {
  codex.stopReadClient(); codex.sharedClient().stop();
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- screens
const RULE = '─'.repeat(60);
const FOOTER = ['  box-a:41a2c drover:master | opus·hi | 13% | $3.22', '  ⏵⏵ bypass permissions on (shift+tab to cycle)'];
const E = '\x1b';
/** A Claude Code 2.1.3xx screen: scrollback, then the input box between two rules, then its footer. box: raw line(s). */
const screen = ({ above = ['⏺ Pushed the branch.', ''], box = [`${E}[39m❯ ${E}[7m ${E}[0m`] } = {}) => [...above, RULE, ...box, RULE, ...FOOTER].join('\n');
const typed = (text) => [`${E}[38;5;246m❯ ${E}[39m${text}`];

describe('the input box', () => {
  test('typed text in the 2.1.3xx box, a continuation line included, is input', () => {
    const raw = screen({ box: [`${E}[38;5;246m❯ ${E}[39mrename the config loader,`, '  then rerun the tests'] });
    assert.deepEqual(typedInput(raw), { text: 'rename the config loader,\nthen rerun the tests' });
    assert.equal(inputBox(tmux.stripAnsi(raw)).text, 'rename the config loader,\nthen rerun the tests');
  });
  test('an empty box, only the cursor in it, holds nothing', () => {
    const raw = screen();
    assert.equal(inputBox(tmux.stripAnsi(raw)).text, '');
    assert.equal(typedInput(raw), null);
  });
  test('a faint suggestion or placeholder in the box is not input: dim, a grey of the 256-colour ramp, an RGB grey', () => {
    for (const faint of [`${E}[2mrun the tests${E}[22m`, `${E}[38;5;244mrun the tests`, `${E}[38;2;128;128;128mrun the tests`, `${E}[90mTry "fix lint errors"`, `${E}[7mr${E}[27m${E}[2mun the tests`]) {
      const raw = screen({ box: [`${E}[39m❯ ${faint}${E}[0m`] });
      assert.equal(inputBox(tmux.stripAnsi(raw)).text.length > 0, true, 'a plain capture cannot tell it from typed text');
      assert.equal(typedInput(raw), null, JSON.stringify(faint));
    }
    // One plain character after a faint run is typed text.
    assert.deepEqual(typedInput(screen({ box: [`${E}[39m❯ ${E}[2mrun ${E}[22mx`] })), { text: 'run x' });
  });
  test('a past prompt in the scrollback ("❯ text" above the box) is not input', () => {
    const raw = screen({ above: [`${E}[38;5;246m${E}[48;5;237m❯ ${E}[38;5;231mRead the brief${E}[39m`, '⏺ Read it.', ''] });
    assert.equal(typedInput(raw), null);
  });
  test('no box at the bottom (a shell, a dialog, a box far up the scrollback): null', () => {
    assert.equal(inputBox('$ ls\nREADME.md\n$ '), null);
    assert.equal(inputBox([RULE, '❯ old text', RULE, ...Array(10).fill('output line')].join('\n')), null, 'more than a footer under the box');
    assert.equal(typedInput(' Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel'), null);
  });
  test('the older ╭─╮ │ > │ ╰─╯ box', () => {
    const box = (inner) => ['Done.', '', '╭' + '─'.repeat(40) + '╮', `│ > ${inner}`.padEnd(41) + '│', '╰' + '─'.repeat(40) + '╯', '  ? for shortcuts'].join('\n');
    assert.deepEqual(typedInput(box('ship it')), { text: 'ship it' });
    assert.equal(typedInput(box('')), null);
    assert.equal(typedInput(box(`${E}[2mTry "refactor app.js"${E}[22m`)), null);
  });
});

// ---------------------------------------------------------------- replies
describe('ownerAsk: a final reply that hands the owner a decision', () => {
  const asks = [
    ['Tests pass on the branch.\n\nShould I merge it now?', 'Should I merge it now?', 'question'],
    ['Pushed.\n\n**Decision for you:** merge now, or wait for the second review.', 'Decision for you: merge now, or wait for the second review.', 'handoff'],
    ['All three drafts are in docs/.\n\n## Needs you\n- pick draft A or B for the launch post', 'pick draft A or B for the launch post', 'handoff'],
    ['Blocked.\n\nNeeds you\n1. log in to the forge there\n2. then say go', 'log in to the forge there', 'handoff'],
    ['Staged. If the diff looks right, reply yes and I deploy it.', 'Staged. If the diff looks right, reply yes and I deploy it.', 'go'],
    ['The build is ready.\nWant me to upload it?\nSay go.', 'Want me to upload it? Say go.', 'go'],
    ['Both options work. It\'s your call.', 'Both options work. It\'s your call.', 'go'],
    ['Staged the migration. I need your OK before running it on prod.', 'Staged the migration. I need your OK before running it on prod.', 'go'],
    ['Waiting on you: the sign-off for the import.', 'Waiting on you: the sign-off for the import.', 'handoff'],
    ['Parked the spike.\n\nDecisions for you (each is a line in NEEDS.md):\n1. keep the Rust prototype or drop it\n2. rotate the test key', 'Decisions for you (each is a line in NEEDS.md): keep the Rust prototype or drop it', 'handoff'],
  ];
  for (const [text, line, why] of asks) test(`asks: ${line}`, () => assert.deepEqual(ownerAsk(text), { line, why }));
  test('the owner\'s name stands in for "you"', () => {
    assert.deepEqual(ownerAsk('Built it.\nNeeds Robin: the store login.', { owner: 'Robin' }), { line: 'Needs Robin: the store login.', why: 'handoff' });
    assert.equal(ownerAsk('Built it.\nNeeds Robin: the store login.'), null, 'another name is not the owner');
  });
  const reports = [
    'Merged.\n\nDecision made: B, as you said go.',
    'You said go, so it is merged and deployed.',
    'Done. Needs you: none.',
    'Shipped.\n**Decisions for you:** nothing right now.',
    'Going with your call from this morning: B. Pushed.',
    'Why did the test fail? A stale fixture. Fixed and pushed.',
    'The parser is fine. The bug was in the caller, which could say yes to a prompt it never showed.',
    'Finished the export.\n```\nok? yes\n```',
    '',
  ];
  for (const text of reports) test(`reports, no ask: ${JSON.stringify(text.slice(0, 50))}`, () => assert.equal(ownerAsk(text), null));
  test('the asking line is cut to 300 characters', () => assert.equal(ownerAsk(`Decision for you: ${'x'.repeat(400)}`).line.length, 300));
});

// ---------------------------------------------------------------- the judge
const NOW = Date.parse('2026-11-10T02:00:00Z');
const ago = (min) => NOW - min * 60_000;
const isoAgo = (min) => new Date(ago(min)).toISOString();
const sess = (id, o = {}) => ({ id, sessionId: id, engine: 'claude', live: true, status: 'idle', name: `n-${id}`, tmux: `agents:@${id.length}.%1`, statusUpdatedAt: ago(60), ...o });
const win = (id, o = {}) => ({ target: `agents:${id.length}`, session: 'agents', windowId: `@${id.length}`, name: `w-${id}`, agent: { engine: 'claude', sessionId: id, status: 'idle' }, screen: { state: 'idle' }, activityTs: ago(20), ...o });

describe('stallsFor', () => {
  test('unsent input: typed, agent idle, window unchanged past the threshold', () => {
    const r = stallsFor({ host: 'box-a', sessions: [sess('a1')], windows: [win('a1', { input: { text: 'rename the loader' } })] }, { now: NOW });
    assert.deepEqual(r.map((x) => [x.kind, x.host, x.sessionId, x.tmux, x.text, x.minutes]), [['unsent-input', 'box-a', 'a1', 'agents:2', 'rename the loader', 20]]);
  });
  test('unsent input: not while the agent works (text queued behind its turn), nor while someone may still be typing, nor under a dialog', () => {
    const cases = [
      [sess('b1', { status: 'busy' }), win('b1', { input: { text: 'next' } })],
      [sess('b2'), win('b2', { input: { text: 'next' }, screen: { state: 'busy' } })],
      [sess('b3'), win('b3', { input: { text: 'half a sentence' }, activityTs: ago(2) })],
      [sess('b4'), win('b4', { input: { text: 'x' }, screen: { state: 'dialog' } })],
      [sess('b5'), win('b5', {})],
    ];
    for (const [s, w] of cases) assert.deepEqual(stallsFor({ sessions: [s], windows: [w] }, { now: NOW }), [], s.id);
  });
  test('owner ask: an idle session whose final reply asks, unanswered past the threshold', () => {
    const s = sess('c1', { statusUpdatedAt: ago(30), reply: { ts: isoAgo(31), end: '...', ask: { line: 'Decision for you: A or B', why: 'handoff' } } });
    const r = stallsFor({ sessions: [s], windows: [win('c1')] }, { now: NOW });
    assert.deepEqual(r.map((x) => [x.kind, x.text, x.why, x.minutes]), [['owner-ask', 'Decision for you: A or B', 'handoff', 30]]);
  });
  test('owner ask: not yet (the board shows it as waiting), not while working, not a dialog already waiting, not a helper run', () => {
    const ask = (min) => ({ ts: isoAgo(min), end: '', ask: { line: 'Say go.', why: 'go' } });
    const cases = [
      [sess('d1', { statusUpdatedAt: ago(3), reply: ask(3) }), win('d1')],
      [sess('d2', { status: 'busy', reply: ask(60) }), win('d2')],
      [sess('d3', { reply: ask(60) }), win('d3', { screen: { state: 'dialog' } })],
      [sess('d4', { reply: ask(60), entrypoint: 'sdk-cli' }), null],
      [sess('d5', { reply: { ts: isoAgo(60), end: 'Merged. Needs you: none.' } }), win('d5')],
    ];
    for (const [s, w] of cases) assert.deepEqual(stallsFor({ sessions: [s], windows: w ? [w] : [] }, { now: NOW }), [], s.id);
  });
  test('unfinished: a launched session that died, or idles past the threshold, without its completion text', () => {
    const declared = new Map([['e1', { done: 'STATE: DONE', ts: isoAgo(300) }], ['e2', { done: 'STATE: DONE', ts: isoAgo(300) }]]);
    const r = stallsFor({ sessions: [
      sess('e1', { live: false, status: 'dead', reply: { ts: isoAgo(200), end: 'Converting the second module now.' } }),
      sess('e2', { statusUpdatedAt: ago(45), reply: { ts: isoAgo(45), end: 'Half the modules are done.\nNext: the CLI.' } }),
    ], windows: [win('e2')] }, { now: NOW, declared });
    assert.deepEqual(r.map((x) => [x.kind, x.sessionId, x.ended, x.done, x.text]), [
      ['unfinished', 'e1', true, 'STATE: DONE', 'Converting the second module now.'],
      ['unfinished', 'e2', false, 'STATE: DONE', 'Next: the CLI.'],
    ]);
  });
  test('unfinished: not when the final reply holds the text, not while idle only briefly, not while working, not without a declaration, not without a reply the host could read', () => {
    const declared = new Map(['f1', 'f2', 'f3'].map((id) => [id, { done: 'STATE: DONE', ts: isoAgo(300) }]));
    const r = stallsFor({ sessions: [
      sess('f1', { live: false, status: 'dead', reply: { ts: isoAgo(100), end: 'All four pass.\nSTATE: DONE' } }),
      sess('f2', { statusUpdatedAt: ago(5), reply: { ts: isoAgo(5), end: 'Working through the list.' } }),
      sess('f3', { status: 'busy', reply: { ts: isoAgo(90), end: 'x' } }),
      sess('f4', { live: false, status: 'dead', reply: { ts: isoAgo(100), end: 'x' } }),
      sess('f5', { live: false, status: 'dead' }),
    ], windows: [] }, { now: NOW, declared: new Map([...declared, ['f5', { done: 'STATE: DONE', ts: isoAgo(300) }]]) });
    assert.deepEqual(r, []);
  });
  test('thresholds can be given; items come oldest first', () => {
    const s1 = sess('g1', { statusUpdatedAt: ago(3), reply: { ts: isoAgo(3), end: '', ask: { line: 'Ship?', why: 'question' } } });
    const s2 = sess('g22', { statusUpdatedAt: ago(1) });
    const r = stallsFor({ sessions: [s1, s2], windows: [win('g22', { input: { text: 'typed' }, activityTs: ago(1) })] }, { now: NOW, askMinutes: 2, inputMinutes: 0 });
    assert.deepEqual(r.map((x) => x.kind), ['owner-ask', 'unsent-input']);
  });
});

test('launchDeclarations: from launch events and from the op record of a forwarded launch the host took done for, recent ones only', () => {
  const evs = [
    { type: 'launch', ts: isoAgo(10), done: 'ALL DONE', result: { tmux: 'agents:@3', name: 'port', sessionId: 's-1' } },
    { type: 'op', op: 'launch.start', ok: true, ts: isoAgo(20), args: { host: 'box-a', engine: 'claude', done: 'STATE: DONE', name: 'far' }, result: { ok: true, sessionId: 's-2', done: 'STATE: DONE' } },
    { type: 'op', op: 'launch.start', ok: true, ts: isoAgo(20), args: { host: 'old-box', engine: 'claude', mode: 'headless', done: 'STATE: DONE' }, result: { ok: true, sessionId: 's-6' } },
    { type: 'op', op: 'launch.start', ok: false, ts: isoAgo(20), args: { done: 'X' }, result: { sessionId: 's-3' } },
    { type: 'launch', ts: isoAgo(5 * 1440), done: 'OLD', result: { sessionId: 's-4' } },
    { type: 'launch', ts: isoAgo(10), result: { sessionId: 's-5' } },
  ];
  const d = launchDeclarations(evs, { now: NOW });
  assert.deepEqual([...d.entries()].map(([k, v]) => [k, v.done, v.name]), [['s-1', 'ALL DONE', 'port'], ['s-2', 'STATE: DONE', 'far']]);
});

test('native.summary with stalled: true lists the fleet\'s stalls without windows or paths; without it the answer is as before', () => {
  const fleet = { hosts: [{ host: 'box-a', ok: true, sessions: [], windows: [], stalls: [
    { kind: 'unfinished', host: 'box-a', id: 'e1', sessionId: 'e1', name: 'port /home/robin/x', engine: 'claude', tmux: 'agents:@3', since: isoAgo(90), minutes: 90, text: null, done: 'ALL DONE', ended: true },
    { kind: 'owner-ask', host: 'box-a', id: 'c1', sessionId: 'c1', name: 'review', engine: 'claude', tmux: 'agents:@4', since: isoAgo(30), minutes: 30, text: 'Decision for you: token=abcd1234secretvalue A or B', why: 'handoff' },
  ] }] };
  assert.equal('stalled' in buildSummary(fleet, [], { now: NOW }), false);
  const s = buildSummary(fleet, [], { now: NOW, stalled: true });
  assert.deepEqual(s.stalled.map((x) => [x.kind, x.id, x.minutes, x.ended]), [['unfinished', 'e1', 90, true], ['owner-ask', 'c1', 30, undefined]]);
  assert.equal(s.stalled[0].headline, 'ended without "ALL DONE"');
  assert.equal(s.stalled[0].name, 'port ~/x');
  assert.match(s.stalled[1].headline, /^Decision for you: token=\[redacted\] A or B$/);
  assert.ok(!/agents:@|\/home\/|abcd1234secret/.test(JSON.stringify(s.stalled)));
});

// ---------------------------------------------------------------- launch: the completion text
test('launch.start done: checked before anything starts', () => {
  assert.equal(launchMod.checkDone('claude', {}), null);
  assert.equal(launchMod.checkDone('claude', { done: '  STATE: DONE ' }), 'STATE: DONE');
  assert.throws(() => launchMod.checkDone('codex', { done: 'x' }), /Claude launches only/);
  assert.throws(() => launchMod.checkDone('claude', { done: 'x', resume: 'abc' }), /cannot be used with resume/);
  assert.throws(() => launchMod.checkDone('claude', { done: 'x'.repeat(201) }), /at most 200/);
  assert.throws(() => launchMod.checkDone('claude', { done: 7 }), /non-empty string/);
});

// ---------------------------------------------------------------- the real flow
const hasTmux = spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status === 0;
describe('real tmux: launches, typed text and replies reach fleet.summary stalls and native.summary', { skip: hasTmux ? false : 'tmux is not installed here' }, () => {
  const SESSION = 'drover-stalls-test';
  let tdir, env, realTmux, socket;
  const tmuxCmd = (args) => spawnSync(realTmux, args, { env, encoding: 'utf8' });
  const launched = {};
  before(async () => {
    realTmux = spawnSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).stdout.trim();
    tdir = path.join(dir, 'tmux'); await mkdir(tdir);
    // A private tmux server first: after() names its socket, so a kill never reaches the user's server.
    delete process.env.TMUX; delete process.env.TMUX_PANE;
    process.env.TMUX_TMPDIR = tdir;
    socket = path.join(tdir, `tmux-${process.getuid()}`, 'default');
    env = { ...process.env };
    assert.equal(tmuxCmd(['-f', '/dev/null', 'new-session', '-d', '-s', SESSION, '-x', '120', '-y', '40', 'sleep', '3600']).status, 0);
    // A fake Claude Code: registers in the session registry as 2.1.3xx does (pid, session id, tmux pane, status),
    // writes a transcript whose final reply its name picks, and draws the input box, echoing what is typed into it.
    const fake = path.join(bin, 'claude');
    await writeFile(fake, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), { spawnSync } = require('node:child_process');
const argv = process.argv.slice(2);
if (argv[0] === 'agents') { process.stdout.write('[]'); process.exit(0); }
const sid = argv.includes('--session-id') ? argv[argv.indexOf('--session-id') + 1] : '00000000-0000-4000-8000-' + String(process.pid).padStart(12, '0');
const name = (argv.find((a) => a.startsWith('--name=')) ?? '--name=x').slice(7);
const REPLY = { typer: 'Rewrote the first two modules.', asker: 'Pushed the branch.\\n\\nDecision for you: merge it now, or wait for the second review. Say go to merge.', closer: 'All four checks pass.\\nALL DONE', worker: 'Starting the export.' }[name] ?? 'ok';
const status = name === 'worker' ? 'busy' : 'idle';
const old = Date.now() - 45 * 60_000;
const here = spawnSync('tmux', ['display', '-p', '-t', process.env.TMUX_PANE, '#{session_name}:#{window_id}.#{pane_id}'], { encoding: 'utf8' }).stdout.trim();
const home = process.env.CLAUDE_CONFIG_DIR;
fs.writeFileSync(path.join(home, 'sessions', process.pid + '.json'), JSON.stringify({ pid: process.pid, sessionId: sid, cwd: process.cwd(), name, status, tmux: here, startedAt: old, updatedAt: old, statusUpdatedAt: old, kind: 'interactive', entrypoint: 'cli', version: '2.1.321' }));
(async () => {
  const { transcriptPath } = await import(${JSON.stringify(path.resolve('core/claude.js'))});
  const file = transcriptPath(process.cwd(), sid);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const ts = new Date(old).toISOString();
  fs.writeFileSync(file, [{ type: 'user', timestamp: ts, message: { role: 'user', content: 'go' } }, { type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text: REPLY }] } }].map((l) => JSON.stringify(l)).join('\\n') + '\\n');
})();
const E = '\\x1b', RULE = '─'.repeat(60);
let buf = '';
const draw = () => {
  const box = buf ? E + '[38;5;246m❯ ' + E + '[39m' + buf : name === 'asker' ? E + '[39m❯ ' + E + '[7mm' + E + '[27m' + E + '[2merge it' + E + '[22m' : E + '[39m❯ ' + E + '[7m ' + E + '[0m';
  const spin = status === 'busy' ? ['· Exporting… (3m 2s · ↓ 1.2k tokens)'] : [];
  process.stdout.write(E + '[2J' + E + '[H' + ['⏺ ' + REPLY.split('\\n').join('\\n  '), '', ...spin, RULE, box, RULE, '  fake-host | 12%', '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\\r\\n'));
};
process.stdin.setRawMode?.(true);
process.stdin.on('data', (b) => { const s = b.toString('utf8'); if (s.includes('\\r')) buf = ''; else buf += s; draw(); });
draw();
setInterval(() => {}, 1 << 30);
`);
    await chmod(fake, 0o755);
    launchMod._deps.agentPath = async () => process.env.PATH;
    launchMod._deps.trustFolder = async () => null;
    launchMod._deps.onboardClaude = async () => null;
    const cwd = path.join(dir, 'work'); await mkdir(cwd);
    for (const [name, done] of [['typer', 'ALL DONE'], ['asker', null], ['closer', 'ALL DONE'], ['worker', 'ALL DONE']]) {
      launched[name] = await launchMod.launch({ engine: 'claude', mode: 'tmux', profile: 'claude-plain', cwd, tmuxSession: SESSION, name, ...(done ? { done } : {}) }, { actor: 't' });
    }
    // Every fake has registered and drawn its box.
    for (let i = 0; i < 100; i++) {
      const regs = (await claude.listRegistry()).filter((r) => r.alive && r.tmux);
      const drawn = await Promise.all(Object.values(launched).map((l) => tmux.capture(l.target, { lines: 40 }).then((t) => t.includes('bypass permissions on')).catch(() => false)));
      if (regs.length === 4 && drawn.every(Boolean)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  });
  after(() => { if (socket) tmuxCmd(['-S', socket, 'kill-server']); });

  test('a launch with done fixes the session id, and records the text with it', async () => {
    assert.match(launched.typer.sessionId, /^[0-9a-f-]{36}$/);
    assert.equal(launched.typer.done, 'ALL DONE');
    assert.deepEqual(launched.typer.argv.slice(-2), ['--session-id', launched.typer.sessionId]);
    assert.equal(launched.asker.sessionId, undefined, 'no done: the launch is as before');
    assert.ok(!launched.asker.argv.includes('--session-id'));
    const evs = (await readFile(process.env.DROVER_EVENTS, 'utf8')).trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.type === 'launch');
    assert.deepEqual(evs.map((e) => [e.result.name, e.done ?? null, e.result.sessionId ?? null]), [['typer', 'ALL DONE', launched.typer.sessionId], ['asker', null, null], ['closer', 'ALL DONE', launched.closer.sessionId], ['worker', 'ALL DONE', launched.worker.sessionId]]);
  });

  test('typed with no Enter (tmux.send enter: false): fleet.summary reports the unsent input, the asking line and the unfinished launch, and nothing else', async () => {
    const sent = await tmux.send(launched.typer.target, 'rename the config loader, then rerun the tests', { enter: false });
    assert.equal(sent.ok, true);
    await tmux.send(launched.worker.target, 'queued for after the export', { enter: false });
    for (let i = 0; i < 50 && !(await tmux.capture(launched.worker.target, { lines: 40 })).includes('queued for after'); i++) await new Promise((r) => setTimeout(r, 100));
    const r = await api.dispatch('fleet.summary', { fresh: true, stalls: { inputMinutes: 0, askMinutes: 0, unfinishedMinutes: 0 } });
    const host = r.hosts.find((h) => h.host === 'local');
    assert.ok(host?.ok, JSON.stringify(host?.error));
    const typerWin = host.windows.find((w) => w.agent?.sessionId === launched.typer.sessionId);
    assert.deepEqual(typerWin.input, { text: 'rename the config loader, then rerun the tests' }, 'tmux.windows reads the typed text');
    const askerWin = host.windows.find((w) => w.agent?.name === 'asker');
    assert.equal(askerWin.input, undefined, 'a faint suggestion in the box is not input');
    const got = host.stalls.map((x) => [x.kind, x.name, x.text]).sort((a, b) => `${a[0]}${a[1]}`.localeCompare(`${b[0]}${b[1]}`));
    assert.deepEqual(got, [
      ['owner-ask', 'asker', 'Decision for you: merge it now, or wait for the second review. Say go to merge.'],
      ['unfinished', 'typer', 'Rewrote the first two modules.'],
      ['unsent-input', 'typer', 'rename the config loader, then rerun the tests'],
    ]);
    const unfinished = host.stalls.find((x) => x.kind === 'unfinished');
    assert.equal(unfinished.done, 'ALL DONE'); assert.equal(unfinished.ended, false); assert.equal(unfinished.tmux, typerWin.target);
  });

  test('the default thresholds: native.summary stalled holds the old ask and the unfinished launch, not input typed a moment ago', async () => {
    const s = await api.dispatch('native.summary', { stalled: true });
    assert.deepEqual(s.stalled.map((x) => [x.kind, x.name]).sort(), [['owner-ask', 'asker'], ['unfinished', 'typer']]);
    assert.ok(s.stalled.every((x) => x.minutes >= 44 && x.host === 'local'));
    assert.ok(!JSON.stringify(s.stalled).includes(dir), 'no paths');
  });
});
