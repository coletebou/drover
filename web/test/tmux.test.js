import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { classifyScreen, dialogSummary, heldMessage, assertTarget, assertName, keyFitsDialog, tmuxArg, listWindows, listPanes, listSessions, SEP, answer, capture, screenHash } from '../core/tmux.js';

test('assertTarget accepts tmux target forms and rejects shell-ish input', () => {
  for (const ok of ['agents:30', 'agents:@68.%73', 'films:1', '=main:2', '%5', 'fleet-channel-merge:1']) assert.equal(assertTarget(ok), ok);
  for (const bad of ['', 'a b', 'x;rm', 'a`b`', 'a\nb', '$(x)', 'x'.repeat(200)]) assert.throws(() => assertTarget(bad));
});

test('assertName rejects separators', () => {
  assert.equal(assertName('agents'), 'agents');
  assert.throws(() => assertName('a:b'));
  assert.throws(() => assertName('a b'));
});

test('classifyScreen: permission dialog', () => {
  const screen = `\n Bash command\n\n   rm -rf build\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don't ask again\n   3. No\n\n Esc to cancel`;
  assert.equal(classifyScreen(screen).state, 'dialog');
});

test('AskUserQuestion: the review screen is a dialog, and a dialog drawn twice in the scrollback lists its options once', () => {
  const review = `\n ←  ☒ Fixtures  ☒ Scope  ✔ Submit  →\n\n Review your answers\n\n  ● Should the review cover the fixtures?\n    → Yes, all of them\n\n Ready to submit your answers?\n\n ❯ 1. Submit answers\n   2. Cancel`;
  assert.equal(classifyScreen(review).state, 'dialog');
  assert.deepEqual(dialogSummary(review).options.map((o) => o.label), ['Submit answers', 'Cancel']);
  const q = ' Which fixtures?\n ❯ 1. All\n   2. New ones\n\n Enter to select · Esc to cancel';
  assert.deepEqual(dialogSummary(`${q}\n\n${q.replace('❯ 1', '  1').replace('   2', ' ❯ 2')}`).options.map((o) => [o.n, o.selected]), [[1, false], [2, true]]);
});

test('classifyScreen: an answered dialog left in the scrollback above the live prompt is not a dialog', () => {
  const dialog = ' Bash command\n\n   npm test\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel';
  const idle = 'Done. The tests pass.\n\n╭──────────╮\n│ >        │\n╰──────────╯\n  ? for shortcuts                bypass permissions on';
  assert.equal(classifyScreen(`${dialog}\n${idle}`).state, 'idle');
  assert.equal(classifyScreen(`${dialog}\n⏺ Bash(npm test)\n✻ Running… (3s · esc to interrupt)`).state, 'busy');
  assert.equal(classifyScreen(`✻ Thinking… (esc to interrupt)\n${dialog}`).state, 'dialog', 'a spinner above a live dialog does not hide it');
  assert.equal(classifyScreen(`${idle}\n${dialog}`).state, 'dialog', 'a new dialog under an old prompt is live');
  const newPrompt = 'Done.\n────────────\n❯ \n────────────\n  model · 11% context';
  assert.equal(classifyScreen(`${dialog}\n${newPrompt}`).state, 'idle', 'the 2.1.3xx bare ❯ prompt counts as live');
  const held = ' Held message from another session\n Another Claude session sent a message: from demo-review\n ❯ 1. Deliver\n   2. Drop\n Esc to cancel';
  assert.ok(heldMessage(held));
  assert.equal(heldMessage(`${held}\n${newPrompt}`), null, 'a held message already handled is history');
});

test('classifyScreen: claude idle footer', () => {
  const screen = `Done. The viewer is rebuilt.\n\n╭───────────────╮\n│ >             │\n╰───────────────╯\n  ? for shortcuts                                    bypass permissions on`;
  assert.equal(classifyScreen(screen).state, 'idle');
});

test('classifyScreen: busy', () => {
  const screen = `· Reading files… (esc to interrupt)\n`;
  assert.equal(classifyScreen(screen).state, 'busy');
});

test('classifyScreen: idle recap mentioning yes/no is not a dialog', () => {
  const screen = `Yes, the tests pass. No further changes are needed.\nShould I open the MR? Yes or no works.\n\n╭───────────────╮\n│ >             │\n╰───────────────╯\n  ? for shortcuts                                    bypass permissions on`;
  assert.equal(classifyScreen(screen).state, 'idle');
});

test('classifyScreen: y/n prompt and numbered selector with Esc hint are dialogs', () => {
  assert.equal(classifyScreen('Overwrite file? (y/n) ').state, 'dialog');
  assert.equal(classifyScreen('Choose a model\n❯ 1. Opus\n  2. Sonnet\n\nEsc to cancel').state, 'dialog');
  assert.equal(classifyScreen('Run a dynamic workflow?\n❯ 1. Yes\n  2. No').state, 'dialog');
});

test('pane text costs linear time: a long blank line (wrapped lines are joined), thousands of blank lines, other line breaks', () => {
  const dialog = 'Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel';
  for (const [name, s] of [
    ['a 100K blank line', `${' '.repeat(100_000)}x\n${dialog}`], ['tabs and blanks', `${' \t'.repeat(50_000)}x\n${dialog}`], ['5,000 blank lines', `out${'\n'.repeat(5000)}${dialog}`],
    // A line the capture's \n split leaves whole can still hold line breaks of its own, and each starts a line for /m.
    ['carriage returns', `${'\r'.repeat(100_000)}x\n${dialog}`], ['line separators', `${'\u2028'.repeat(100_000)}x\n${dialog}`], ['paragraph separators', `${'\u2029'.repeat(100_000)}x\n${dialog}`],
  ]) {
    const t0 = Date.now();
    assert.equal(classifyScreen(s).state, 'dialog', name);
    assert.deepEqual(dialogSummary(s).options.map((o) => o.n), [1, 2], name);
    assert.equal(screenHash(s), screenHash(`${s}\n \t\n\n`), name);
    assert.ok(Date.now() - t0 < 1500, `${name}: took ${Date.now() - t0} ms`);
  }
});

test('the screen-is-lowest checks cost linear time too: a long run under no dialog, and one between an answered dialog and the prompt', () => {
  const dialog = 'Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel';
  for (const [name, run] of [['blanks', ' '], ['tabs and blanks', ' \t'], ['carriage returns', '\r'], ['line separators', '\u2028'], ['paragraph separators', '\u2029']]) {
    const long = `${run.repeat(100_000 / run.length)}x`;
    const t0 = Date.now();
    // No dialog anywhere: every check runs, the empty prompt line last.
    assert.equal(classifyScreen(long).state, 'unknown', name);
    assert.equal(heldMessage(long), null, name);
    assert.equal(classifyScreen(`${long}\n❯ `).state, 'idle', `${name}: the empty prompt line under it`);
    // The prompt under the dialog makes the dialog scrollback.
    assert.equal(classifyScreen(`${dialog}\n${long}\n? for shortcuts`).state, 'idle', `${name}: answered`);
    assert.ok(Date.now() - t0 < 1500, `${name}: took ${Date.now() - t0} ms`);
  }
});

test('keyFitsDialog: y/n only where the prompt takes them', () => {
  const claude = ' Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel';
  for (const k of ['Enter', 'Escape', '1', 'Down']) assert.equal(keyFitsDialog(claude, k).ok, true);
  assert.equal(keyFitsDialog(claude, 'y').ok, false);
  assert.match(keyFitsDialog(claude, 'n').reason, /Enter.*Escape.*digit/);
  assert.equal(keyFitsDialog('Overwrite file? (y/n) ', 'y').ok, true);
  assert.equal(keyFitsDialog('Proceed? [Y/n]', 'n').ok, true);
  const shortcut = '› 1. Yes, proceed (y)\n  2. No, tell me what to do (esc)';
  assert.equal(keyFitsDialog(shortcut, 'y').ok, true);
  assert.equal(keyFitsDialog(shortcut, 'n').ok, false);
});

test('classifyScreen: plain shell prompt is unknown (not idle agent)', () => {
  assert.equal(classifyScreen('alice@mac webapp % ls\nREADME.md\nalice@mac webapp % ').state, 'unknown');
});

test('tmuxArg: only a trailing ";" (tmux\'s command separator) is escaped, as "\\;"', () => {
  assert.equal(tmuxArg('x;'), 'x\\;');
  assert.equal(tmuxArg(';'), '\\;');
  assert.equal(tmuxArg(' ;'), ' \\;');
  assert.equal(tmuxArg('a\\;'), 'a\\\\;', 'a value already ending in backslash-semicolon keeps its backslash');
  assert.deepEqual([...tmuxArg('a\\;')], ['a', '\\', '\\', ';']);
  for (const same of ['', 'plain', 'mid;dle', 'a;b', '\\', '#{session_name}', '~', '$HOME', '%1', '{', '}', 'line\nbreak']) assert.equal(tmuxArg(same), same);
  for (const other of [5, undefined, null]) assert.equal(tmuxArg(other), other, 'non-strings pass through untouched');
});

// ---------------------------------------------------------------- dialog screens the answer tests use
const QUESTION = 'Which approach should I take for the rebase?\n\n❯ 1. Rebase onto dev (Recommended)\n  2. Merge dev in\n  3. Stop here\n\nEnter to select · ↑/↓ to navigate · Esc to cancel\n';
const PERMISSION = "Bash command\n\n  rm -rf build\n  Remove the build directory\n\nDo you want to proceed?\n❯ 1. Yes\n  2. Yes, and don't ask again for rm commands in this project\n  3. No, and tell Claude what to do differently (esc)\n\nEsc to cancel\n";

// ---------------------------------------------------------------- real tmux: the list parsers

const hasTmux = spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status === 0;
describe('real tmux: listWindows, listPanes and listSessions keep every field', { skip: hasTmux ? false : 'tmux is not installed here' }, () => {
  // tmux 3.4 escapes control characters in -F output, so a U+001F field separator arrived as the four characters
  // "\037" and no line split (seen 2026-10-18); tmux 3.8 prints them raw. The shim makes the installed tmux
  // escape them too, so a separator that needs raw control characters fails on every box. The names and the working
  // directory hold the separator's characters, and its proper prefixes and suffixes at their edges, where a
  // separator that overlaps itself would shift a split.
  const SESSION = 'drover-list-test', OTHER = 'second session';
  const NAMES = ['plain', 'two words', `a ${[...SEP].join(' ')} b`, `ends ${SEP.slice(0, -1)}`, `${SEP.slice(1)} starts`];
  let saved, tdir, env, workDir, shimDir, shimLog, realTmux;
  const tmuxCmd = (args) => spawnSync(realTmux, args, { env, encoding: 'utf8' });

  before(async () => {
    saved = Object.fromEntries(['PATH', 'TMUX', 'TMUX_PANE', 'TMUX_TMPDIR'].map((k) => [k, process.env[k]]));
    realTmux = spawnSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).stdout.trim();
    tdir = await mkdtemp(path.join(tmpdir(), 'drovertl-'));
    // A private tmux server: its own socket directory, no user config, and no TMUX variable that could point a
    // client at the user's server. Every tmux call in this process (core/tmux.js too) goes there. This comes before
    // anything else that can fail: after() runs even when before() throws, and its kill-server must use this env.
    delete process.env.TMUX; delete process.env.TMUX_PANE;
    process.env.TMUX_TMPDIR = tdir;
    env = { ...process.env };
    workDir = path.join(tdir, `dir with spaces ${SEP.slice(0, -1)}`); shimDir = path.join(tdir, 'shim'); shimLog = path.join(tdir, 'shim.log');
    await mkdir(workDir); await mkdir(shimDir);
    // The real tmux, with control characters other than tab and newline in its stdout escaped as octal, as tmux 3.4
    // prints U+001F (it uses \a, \r and the like where C has one). The backslash is String.fromCharCode(92), so
    // nothing here needs double escaping. It logs each subcommand, so the escaping case can prove it ran through here.
    const shim = path.join(shimDir, 'tmux');
    await writeFile(shim, [
      `#!${process.execPath}`,
      `require('node:fs').appendFileSync(${JSON.stringify(shimLog)}, process.argv[2] + ' ');`,
      "const { spawnSync } = require('node:child_process');",
      `const r = spawnSync(${JSON.stringify(realTmux)}, process.argv.slice(2), { stdio: ['inherit', 'pipe', 'inherit'] });`,
      'const out = [];',
      "for (const b of r.stdout) out.push(...((b < 0x20 && b !== 0x09 && b !== 0x0a) || b === 0x7f ? Buffer.from(String.fromCharCode(92) + b.toString(8).padStart(3, '0')) : [b]));",
      'process.stdout.write(Buffer.from(out));',
      'process.exitCode = r.status ?? 1;',
    ].join('\n'));
    await chmod(shim, 0o755);
    const ok = (r) => assert.equal(r.status, 0, r.stderr);
    ok(tmuxCmd(['-f', '/dev/null', 'new-session', '-d', '-s', SESSION, '-n', NAMES[0], '-c', workDir, 'sleep', '3600']));
    for (const name of NAMES.slice(1)) ok(tmuxCmd(['new-window', '-d', '-t', SESSION, '-n', name, '-c', workDir, 'sleep', '3600']));
    ok(tmuxCmd(['new-session', '-d', '-s', OTHER, '-c', workDir, 'sleep', '3600']));
    // pane_current_command and pane_current_path come from the live process: wait until every pane runs sleep.
    const allSleep = () => { const cmds = tmuxCmd(['list-panes', '-a', '-F', '#{pane_current_command}']).stdout.split('\n').filter(Boolean); return cmds.length === NAMES.length + 1 && cmds.every((c) => c === 'sleep'); };
    for (let i = 0; i < 100 && !allSleep(); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(allSleep(), 'every pane runs sleep within 5 s');
  });
  after(async () => {
    // The kill names the private server's socket: with TMUX_TMPDIR alone, a missing folder would send it to the
    // user's default server.
    if (env) tmuxCmd(['-S', path.join(tdir, `tmux-${process.getuid()}`, 'default'), 'kill-server']);   // env exists only once it points at the private server
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    if (tdir) await rm(tdir, { recursive: true, force: true });
  });

  for (const escaping of [false, true]) {
    test(escaping ? 'when tmux escapes control characters in its output (3.4)' : 'as the installed tmux prints them', async () => {
      process.env.PATH = escaping ? `${shimDir}${path.delimiter}${saved.PATH}` : saved.PATH;
      const cwd = realpathSync(workDir);
      const wins = await listWindows();
      assert.deepEqual(wins.map((w) => w.target).sort(), [...NAMES.map((_, i) => `${SESSION}:${i}`), `${OTHER}:0`]);
      for (const w of wins) {
        assert.match(w.windowId, /^@\d+$/);
        assert.match(w.paneId, /^%\d+$/);
        assert.ok(Number.isInteger(w.panePid) && w.panePid > 0, `pane pid ${w.panePid}`);
        assert.equal(w.panes, 1);
        assert.equal(w.cmd, 'sleep');
        assert.equal(w.cwd, cwd);
        assert.ok(w.activityTs > 0, `activity ${w.activityTs}`);
        assert.equal(w.sessionAttached, false);
      }
      const mine = wins.filter((w) => w.session === SESSION).sort((a, b) => a.index - b.index);
      assert.deepEqual(mine.map((w) => w.name), NAMES);
      assert.deepEqual(mine.map((w) => w.active), NAMES.map((_, i) => i === 0));

      const panes = await listPanes(`${SESSION}:1`);
      assert.equal(panes.length, 1);
      const { width, height, ...pane } = panes[0];
      assert.deepEqual(pane, { paneId: mine[1].paneId, index: 0, pid: mine[1].panePid, cmd: 'sleep', cwd, active: true });
      assert.ok(width > 0 && height > 0, `size ${width}x${height}`);

      const sessions = await listSessions();
      assert.deepEqual(sessions.map((s) => [s.name, s.windows, s.attached]).sort(), [[SESSION, NAMES.length, false], [OTHER, 1, false]]);
      for (const s of sessions) assert.ok(s.createdTs > 0, `created ${s.createdTs}`);
      if (escaping) assert.match(readFileSync(shimLog, 'utf8'), /list-windows.*list-panes.*list-sessions/, 'the parsers ran through the shim');
    });
  }
});

describe('real tmux: an answer is refused before any key is sent when the screen changed, and sends its digit otherwise', { skip: hasTmux ? false : 'tmux is not installed here' }, () => {
  let saved, tdir, env, realTmux;
  const tmuxCmd = (args) => spawnSync(realTmux, args, { env, encoding: 'utf8' });
  const SESSION = 'drover-answer-test';
  before(async () => {
    saved = Object.fromEntries(['TMUX', 'TMUX_PANE', 'TMUX_TMPDIR'].map((k) => [k, process.env[k]]));
    realTmux = spawnSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).stdout.trim();
    tdir = await mkdtemp(path.join(tmpdir(), 'droverta-'));
    delete process.env.TMUX; delete process.env.TMUX_PANE;
    process.env.TMUX_TMPDIR = tdir;
    env = { ...process.env };
    assert.equal(tmuxCmd(['-f', '/dev/null', 'new-session', '-d', '-s', SESSION, '-x', '120', '-y', '40', 'sleep', '3600']).status, 0);
  });
  after(async () => {
    if (env) tmuxCmd(['kill-server']);
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    if (tdir) await rm(tdir, { recursive: true, force: true });
  });
  // A pane that draws a dialog and records every key it receives.
  const pane = async (name, screen) => {
    const log = path.join(tdir, `${name}.keys`), script = path.join(tdir, `${name}.cjs`);
    await writeFile(log, '');
    await writeFile(script, `const fs = require('node:fs'); process.stdout.write(${JSON.stringify(screen)}); process.stdin.setRawMode?.(true); process.stdin.on('data', (b) => fs.appendFileSync(${JSON.stringify(log)}, b)); setInterval(() => {}, 1000);`);
    assert.equal(tmuxCmd(['new-window', '-d', '-t', SESSION, '-n', name, process.execPath, script]).status, 0);
    const target = `${SESSION}:${name}`;
    for (let i = 0; i < 100 && !(await capture(target, { lines: 60 })).includes('Esc to cancel'); i++) await new Promise((r) => setTimeout(r, 50));
    return { target, keys: async () => { await new Promise((r) => setTimeout(r, 300)); return readFileSync(log, 'utf8'); } };
  };
  test('a stale expect: refused, nothing typed', async () => {
    const p = await pane('perm', PERMISSION);
    const r = await answer(p.target, '1', { expect: 'stale' });
    assert.equal(r.refused, true); assert.match(r.reason, /screen changed since you read it/);
    assert.equal(await p.keys(), '');
  });
  test('an option in a question, on the screen read: sent', async () => {
    const p = await pane('question', QUESTION);
    const r = await answer(p.target, '1', { expect: screenHash(await capture(p.target, { lines: 60 })) });
    assert.equal(r.ok, true, r.reason);
    assert.equal(await p.keys(), '1');
  });
});
