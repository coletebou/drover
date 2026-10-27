// A secret passed to a command never reaches the text of its error: a tmux -e NAME=value (how a tmux launch hands
// the agent its credential), an env-style NAME=value item, a --token style flag's value and the known key shapes stay
// out of the message, of the argv and stderr an error carries, and of a spawn failure's spawnargs, and so out of where
// errors go next: tryRun's stderr, a remote host's reply and its relayed stderr (a host on an older build included),
// the WAL's op record, the MCP tool error and the MCP server's log. The end-to-end cases launch with a fake credential
// into a real, private tmux server whose new-window fails, in this process and on a remote host over `drover rpc`
// (a real child process). Every secret here is a fake value made at runtime. No tmux server, agent or credential of
// the user is touched.
// Run: node --test test/error-redaction.test.js
import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';

// Lowercase letters only: no redaction rule knows such a value by its shape, so only the env rules can keep it out.
const fakeValue = () => Array.from(randomBytes(32), (b) => String.fromCharCode(97 + (b % 26))).join('');
// A key in a known shape (the Bedrock key prefix), assembled at runtime so no literal here looks like a key.
const fakeKey = () => ['AB', 'SK', randomBytes(30).toString('base64').replace(/[+/=]/g, 'x')].join('');
// A six-digit number, as a numeric password would be.
const pin6 = () => String(100_000 + (randomBytes(3).readUIntBE(0, 3) % 900_000));

const dir = await mkdtemp(path.join(tmpdir(), 'drover-redact-'));
const BIN = fileURLToPath(new URL('../bin/drover', import.meta.url));
process.env.DROVER_PROFILES = path.join(dir, 'profiles.json');
process.env.DROVER_STATE = path.join(dir, 'state');
process.env.DROVER_DOTFILES = path.join(dir, 'dotfiles');
process.env.DROVER_EVENTS = path.join(dir, 'dotfiles', 'claude', 'drover-events.jsonl');
process.env.DROVER_CACHE = path.join(dir, 'cache');
process.env.DROVER_HOST = 'testbox';
// Under a name that names no secret (only the env rules hide it) and under one that does, as a Bedrock key's does.
process.env.DROVER_TEST_CRED = fakeValue();
process.env.DROVER_TEST_TOKEN = fakeKey();
const SECRETS = [process.env.DROVER_TEST_CRED, process.env.DROVER_TEST_TOKEN];
await mkdir(path.join(dir, 'dotfiles', 'claude'), { recursive: true });
await writeFile(path.join(dir, 'dotfiles', 'claude', 'fleet-hosts.txt'), 'relay-reply\nrelay-stderr\nrelay-repeat\nrelay-cut\nrelay-cut2\nrelay-lines\nrelay-bearer\nrpc-box\n');
await writeFile(process.env.DROVER_PROFILES, JSON.stringify({
  claude: { models: [], profiles: [{ id: 'claude-plain', label: 'plain', argv: [], env: {}, default: true }] },
  codex: { models: [], profiles: [{ id: 'codex-plain', label: 'plain', argv: [], env: {}, default: true }] },
  credentials: { pool: [{ id: 'main', label: 'Main', env: { FAKE_CHILD_CRED: '$DROVER_TEST_CRED', FAKE_BEARER_TOKEN: '$DROVER_TEST_TOKEN' }, weight: 1, maxConcurrent: 50 }], default: 'auto', appliesTo: ['claude'] },
}));

const { run, tryRun, runCapped, ProcError } = await import('../core/proc.js');
const { redactCommand, redactEnvText, scrubValues } = await import('../core/redact.js');
const native = await import('../core/native.js');
const remote = await import('../core/remote.js');
const launchMod = await import('../core/launch.js');
const credentials = await import('../core/credpool.js');
const api = await import('../core/api.js');
const { createServer } = await import('../mcp/server.js');
// Here, not in a suite's after(): a suite skipped where tmux is missing runs no hooks.
after(() => rm(dir, { recursive: true, force: true }));

/** Every place a value could hide in an error: its message, its own fields, and how it prints or serializes. */
const views = (e) => [e.message, inspect(e), JSON.stringify(e)];
const leaks = (texts, values = SECRETS) => values.filter((v) => texts.some((t) => String(t).includes(v)));
// A command that prints its own arguments to stderr, as a usage message or a shell tracing itself would, then fails.
const FAIL = path.join(dir, 'fail.cjs');
await writeFile(FAIL, "process.stderr.write('failed: ' + process.argv.slice(2).join(' ') + '\\n'); process.exit(Number(process.env.FAIL_CODE ?? 3));\n");
// One that prints only what follows the last = or : of each argument, as a tool rejecting a password it was given would.
const FAIL_BARE = path.join(dir, 'fail-bare.cjs');
await writeFile(FAIL_BARE, "process.stderr.write('rejected: ' + process.argv.slice(2).map((a) => a.split(/[=:]/).pop()).join(' ') + '\\n'); process.exit(3);\n");

test('redactCommand: environment values out, their names and every other item kept', () => {
  const [v1, v2, v3] = [fakeValue(), fakeValue(), fakeValue()];
  const argv = ['new-window', '-P', '-F', '#{session_name}:#{window_id}', '-t', '=work:', '-e', `FAKE_CHILD_CRED=${v1}`, '-e', 'PATH=/usr/bin:/bin', '-e', 'CLAUDE_CODE_RETRY_WATCHDOG=1', `-eGLUED=${v2}`, `--env=OTHER=${v3}`, '-n', 'agent', '-c', '/work/dir', 'claude', '--model', 'opus'];
  const { argv: shown, hidden } = redactCommand(argv);
  assert.deepEqual(shown, ['new-window', '-P', '-F', '#{session_name}:#{window_id}', '-t', '=work:', '-e', 'FAKE_CHILD_CRED=[redacted]', '-e', 'PATH=[redacted]', '-e', 'CLAUDE_CODE_RETRY_WATCHDOG=[redacted]', '-eGLUED=[redacted]', '--env=OTHER=[redacted]', '-n', 'agent', '-c', '/work/dir', 'claude', '--model', 'opus']);
  assert.deepEqual([...hidden].sort(), [v1, v2, v3, '/usr/bin:/bin'].sort(), 'the values of 8 characters or more, for the output scrub');
  // env(1) style, a credential flag's value, and a key in a known shape inside a prompt.
  const key = fakeKey();
  const env1 = redactCommand(['env', `DB_CRED=${v1}`, 'tool', '--api-key', v2, `--prompt=use ${key} here`]);
  assert.deepEqual(env1.argv, ['env', 'DB_CRED=[redacted]', 'tool', '--api-key', '[redacted]', '--prompt=use [redacted] here']);
  assert.deepEqual([...env1.hidden].sort(), [v1, v2, key].sort(), 'the key taken from inside the prompt too');
  assert.deepEqual(redactCommand(['-e', 'grep pattern', 'file']).argv, ['-e', 'grep pattern', 'file'], 'an -e that sets nothing is left alone');
  // After -e any name is an environment name; on its own only a name in capitals is, so a config override stays.
  assert.deepEqual(redactCommand(['-e', `lower_name=${v1}`, 'codex', '-c', 'model_reasoning_effort="high"', 'git', '-c', 'user.name=x']).argv, ['-e', 'lower_name=[redacted]', 'codex', '-c', 'model_reasoning_effort="high"', 'git', '-c', 'user.name=x']);
  // A -u / --user user:password pair (curl) given as two items; a docker uid:gid or a bare user stays. And the values
  // taken from inside items (--password=<value>, a key in a prompt) are hidden too, not only items replaced whole.
  const pairs = redactCommand(['curl', '--user', `alice:${v1}`, `--password=${v2}`, '-u', '1000:1000', '-u', 'root', `go ${key} now`]);
  assert.deepEqual(pairs.argv, ['curl', '--user', 'alice:[redacted]', '--password=[redacted]', '-u', '1000:1000', '-u', 'root', 'go [redacted] now']);
  assert.deepEqual([...pairs.hidden].sort(), [v1, v2, key].sort());
  // One item holding a secret key and its value loses all of it, blanks included (the item is where it ends); glued
  // -u too. Each word of what was removed is hidden as well.
  const [w1, w2, w3] = [fakeValue(), fakeValue(), fakeValue()];
  const items = redactCommand([`--password=correct horse ${w1} staple`, `password=two ${w2}`, `-ualice:${w3}`, '-u1000:1000', '-ur', 'max_tokens=2048']);
  assert.deepEqual(items.argv, ['--password=[redacted]', 'password=[redacted]', '-ualice:[redacted]', '-u1000:1000', '-ur', 'max_tokens=2048']);
  for (const w of [w1, w2, w3]) assert.ok(items.hidden.includes(w), 'the words of a removed value are hidden too');
  // A credential's value is hidden from 4 characters, any other environment value from 8 (a flag of 1 stays).
  const short = fakeValue().slice(0, 6);
  assert.deepEqual(redactCommand(['--password', short, '-e', 'WATCHDOG=1', '-e', `API_TOKEN=${short}x`]).hidden.sort(), [short, `${short}x`].sort());
  // curl's -U / --proxy-user given as two items, and --user= as one, its whole value; a password inside an
  // environment value (a URL's) is hidden on its own too.
  const curl = redactCommand(['-U', `alice:${w1}`, '--proxy-user', `bob:${w2}`, `--user=carol:correct horse ${w3}`, '-e', `DATABASE_URL=https://dave:${short}@db/x`]);
  assert.deepEqual(curl.argv, ['-U', 'alice:[redacted]', '--proxy-user', 'bob:[redacted]', '--user=carol:[redacted]', '-e', 'DATABASE_URL=[redacted]']);
  for (const w of [w1, w2, w3, short]) assert.ok(curl.hidden.includes(w), w);
  // A value found once is taken out of every other item that repeats it.
  assert.deepEqual(redactCommand(['-e', `AUTH=${w1}`, '--input', w1, `prompt with ${w1} inside`]).argv, ['-e', 'AUTH=[redacted]', '--input', '[redacted]', 'prompt with [redacted] inside']);
});

test('redactEnvText: a command line in text loses its environment values; prose keeps lowercase key=value words', () => {
  const v = fakeValue();
  const line = `/usr/bin/tmux new-window -t work -e CLAUDE_CODE_RETRY_WATCHDOG=1 -e PATH=/a:/b -e FAKE_CHILD_CRED=${v} -n agent exited 1: create window failed: index 1 in use`;
  assert.equal(redactEnvText(line), '/usr/bin/tmux new-window -t work -e CLAUDE_CODE_RETRY_WATCHDOG=[redacted] -e PATH=[redacted] -e FAKE_CHILD_CRED=[redacted] -n agent exited 1: create window failed: index 1 in use');
  assert.equal(redactEnvText(`-e lower_name=${v} --env FAKE=${v} --env=FAKE2=${v}`), '-e lower_name=[redacted] --env FAKE=[redacted] --env=FAKE2=[redacted]');
  // A value after -e can hold blanks: it runs on to the next flag, to " exited <code>: " or to the end of the line. The
  // secret shapes go first, while "Bearer <token>" or "X-Api-Key: <key>" is still whole.
  assert.equal(redactEnvText(`-e AUTH_HEADER=Bearer ${v} -n agent exited 1: boom`), '-e AUTH_HEADER=[redacted] -n agent exited 1: boom');
  assert.equal(redactEnvText(`-e CUSTOM_HEADERS=X-Api-Key: ${v} -c /w claude exited 1: boom`), '-e CUSTOM_HEADERS=[redacted] -c /w claude exited 1: boom');
  assert.equal(redactEnvText(`-e TWO_WORDS=two ${v}\nnext line`), '-e TWO_WORDS=[redacted]\nnext line');
  assert.equal(redactEnvText(`-e LAST=${v} claude -- go exited 1: boom`), '-e LAST=[redacted] exited 1: boom', 'with no flag after it, the rest of the command goes too');
  assert.equal(redactEnvText('-e A=[redacted] -n agent exited 1: boom'), '-e A=[redacted] -n agent exited 1: boom', 'a command already redacted at its source is left as it is');
  // Glued -eNAME= with a name in capitals (-encoding=utf8 is no environment variable) and a quoted name.
  assert.equal(redactEnvText(`tool -eCRED=${v} -n x -encoding=utf8`), 'tool -eCRED=[redacted] -n x -encoding=utf8');
  assert.equal(redactEnvText(`tool -e 'PHRASE=two word ${v}' -n x`), "tool -e 'PHRASE=[redacted]' -n x");
  // A quoted value runs to its quote, flag-like words in it too; a token that starts with a dash goes with its scheme.
  assert.equal(redactEnvText(`tool -e 'PHRASE=two -word ${v}' -n x`), "tool -e 'PHRASE=[redacted]' -n x");
  assert.equal(redactEnvText(`-e AUTH_HEADER=Bearer -${v} -n agent exited 1: boom`), '-e AUTH_HEADER=[redacted] -n agent exited 1: boom');
  assert.equal(redactEnvText(`-e 'AUTH_HEADER=Bearer -${v}' -n agent exited 1: boom`), "-e 'AUTH_HEADER=[redacted] exited 1: boom", 'its quote went with the token: the value ends where the stderr starts');
  // What is found in an assignment or a shape goes from the rest of the text too: a command prints it again.
  assert.equal(redactEnvText(`tmux new-window -e NEUTRAL=${v} -n agent exited 1: rejected ${v}`), 'tmux new-window -e NEUTRAL=[redacted] -n agent exited 1: rejected [redacted]');
  assert.equal(redactEnvText(`curl -H Authorization: Bearer ${v} exited 22: token ${v} refused`), 'curl -H Authorization: [redacted] exited 22: token [redacted] refused');
  // The quote after the = instead, after -e or bare: the value runs to it too.
  assert.equal(redactEnvText(`-e PHRASE="alpha -word ${v}" -n w exited 1: fail`), '-e PHRASE="[redacted]" -n w exited 1: fail');
  assert.equal(redactEnvText(`NAME="multi word ${v}" rest`), 'NAME="[redacted]" rest');
  // curl's user:password after -U, --proxy-user and a glued -u too; a docker uid:gid and other short numbers stay.
  assert.equal(redactEnvText(`curl --proxy-user alice:${v} -U bob:${v} -ucarol:${v} -u 1000:1000 exited 22: failed`), 'curl --proxy-user alice:[redacted] -U bob:[redacted] -ucarol:[redacted] -u 1000:[redacted] exited 22: failed');
  // The long-token rule goes last, so a name stays beside its value.
  assert.equal(redactEnvText(`--env=FAKE2=${v} -e A=abc123def456ghi789jkl012mno345pqr678`), '--env=FAKE2=[redacted] -e A=[redacted]');
  assert.equal(redactEnvText('retry=3 of mode=fast, then DEBUG=1 and x=y'), 'retry=3 of mode=fast, then DEBUG=[redacted] and x=y');
  assert.equal(redactEnvText(`AUTH=Bearer ${v} then`), 'AUTH=[redacted] then', 'a bare value the shapes know is taken whole');
  assert.equal(redactEnvText(`a key ${fakeKey()} in prose`), 'a key [redacted] in prose', 'and the shapes redactSecrets knows');
  assert.equal(redactEnvText(undefined), '');
  assert.equal(scrubValues(`one ${v} two ${v}x`, [v, v.slice(0, 10)]), 'one [redacted] two [redacted]x', 'the longest value first');
});

test('redactEnvText costs linear time on the text a relay can bring (long runs, many flags)', () => {
  for (const [name, s] of [['word run', 'A'.repeat(2_000_000)], ['-e runs', '-e '.repeat(400_000)], ['--env runs', '--env'.repeat(300_000)], ['NAME= runs', 'A=B '.repeat(100_000)],
    ['an -e value with no end', `-e A=${'x'.repeat(2_000_000)}`], ['an -e value of blanks', `-e A=${' '.repeat(2_000_000)}`], ['-e then blanks', `-e ${' '.repeat(2_000_000)}`], ['-e values', '-e A=x '.repeat(300_000)],
    ['capitals after a value', `-e A=${' ABCDEFGHIJ'.repeat(200_000)}`], ['a quoted value with no end', `-e 'A=${'x'.repeat(2_000_000)}`], ['shapes', `Bearer ${'x'.repeat(30)} `.repeat(50_000)],
    ['a value printed again', `-e NEUTRAL=${'q'.repeat(32)} rejected ${'q'.repeat(32)} `.repeat(20_000)],
    // Many distinct values, each a pass of the scrub: the text read is bounded (64 KB) and so is the number scrubbed.
    ['distinct values', Array.from({ length: 80_000 }, (_, i) => `A${i}=vvvv${i.toString(36).padStart(8, '0')}`).join(' ')],
    // A -u after any non-word character used to be tried, each try reading the rest of the run again.
    ['a run of -u/', `${'-u/'.repeat(20_000)}: `]]) {
    const t0 = Date.now(); redactEnvText(s);
    assert.ok(Date.now() - t0 < 1500, `${name}: ${s.length} chars took ${Date.now() - t0} ms`);
  }
});

test('redactEnvText reads the first 64 KB of a text and says how much it left out', () => {
  const v = fakeValue(), long = `-e NEUTRAL=${v} -n agent ${'word '.repeat(20_000)}`;
  const out = redactEnvText(long);
  assert.ok(out.startsWith('-e NEUTRAL=[redacted] -n agent word word'), out.slice(0, 60));
  // The cut drops the partial word it lands in (at most "word "), so a little more than what is past 64 KB is left out.
  const left = Number(out.match(/ … \((\d+) more characters\)$/)?.[1]);
  assert.ok(left >= long.length - 65_536 && left <= long.length - 65_536 + 5, `${left} of ${long.length}`);
  assert.deepEqual(leaks([out], [v]), []);
});

test('ProcError: a huge stderr and many environment values cost a bounded scrub', () => {
  const argv = Array.from({ length: 2000 }, (_, i) => ['-e', `V${i}=${i.toString(36).padStart(10, 'x')}`]).flat();
  const t0 = Date.now();
  const err = new ProcError('tool', argv, 1, 'z'.repeat(5_000_000));
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
  assert.ok(err.stderr.length <= 4096);
});

test('native.js still offers the redactor its callers import from it', () => {
  assert.equal(native.redactSecrets(`x ${fakeKey()}`), 'x [redacted]');
  assert.deepEqual(native.redactArgv(['--password', 'hunter2']), ['--password', '[redacted]']);
});

test('run: a failed command\'s error names the command and its environment names, never a value, in any view of it', async () => {
  const [v1, v2, v3, key] = [fakeValue(), fakeValue(), fakeValue(), fakeKey()];
  const argv = [FAIL, '-e', `FAKE_CHILD_CRED=${v1}`, `NAME2=${v2}`, '--api-key', v3, `prompt with ${key}`];
  const err = await run(process.execPath, argv).then(() => null, (e) => e);
  assert.ok(err instanceof ProcError, String(err));
  assert.deepEqual(leaks([...views(err), err.argv.join(' '), err.stderr], [v1, v2, v3, key]), []);
  assert.ok(err.message.endsWith(' -e FAKE_CHILD_CRED=[redacted] NAME2=[redacted] --api-key [redacted] prompt with [redacted] exited 3: failed: -e FAKE_CHILD_CRED=[redacted] NAME2=[redacted] --api-key [redacted] prompt with [redacted]'), err.message);
  assert.equal(err.code, 3);
});

test('run: values a command prints on their own (a password it rejects) are taken out of its stderr too', async () => {
  const [v1, v2, v3] = [fakeValue(), fakeValue(), fakeValue()];
  const err = await run(process.execPath, [FAIL_BARE, '-e', `FAKE_CHILD_CRED=${v1}`, `--password=${v2}`, '--user', `alice:${v3}`, '-u', '1000:1000']).then(() => null, (e) => e);
  assert.ok(err instanceof ProcError, String(err));
  assert.deepEqual(leaks([...views(err), err.stderr], [v1, v2, v3]), []);
  assert.ok(err.message.endsWith(' -e FAKE_CHILD_CRED=[redacted] --password=[redacted] --user alice:[redacted] -u 1000:1000 exited 3: rejected: -e [redacted] [redacted] --user [redacted] -u 1000'), err.message);
});

test('ProcError: a credential the command prints back on its own goes, a short one and the token of a Bearer too', () => {
  const short = fakeValue().slice(0, 6), token = fakeValue();
  for (const argv of [['tool', '--password', short], ['curl', '-H', `Authorization: Bearer ${token}`], ['tmux', '-e', `AUTH_HEADER=Bearer ${token}`], ['psql', '-e', `DATABASE_URL=postgres://app:${short}@db/x`], ['tool', '--config', `{"password":"${token}"}`], ['curl', '--config', JSON.stringify({ authorization: `Bearer ${token}` })], ['tool', `Use Bearer "${token}".`], ['psql', '-e', `DATABASE_URL=https://app:${pin6()}@db/x`]]) {
    const value = argv.at(-1).includes(token) ? token : argv.at(-1).match(/:(\d{6})@/)?.[1] ?? short;   // what the tool prints back
    const err = new ProcError(argv[0], argv.slice(1), 1, `rejected: ${value}`);
    assert.deepEqual(leaks([...views(err), err.stderr], [short, token, value]), [], argv.join(' '));
    assert.ok(err.message.endsWith('exited 1: rejected: [redacted]'), err.message);
  }
});

test('ProcError: a numeric credential is scrubbed when the command names it one; other short numbers stay', () => {
  const pin = String(100_000 + (randomBytes(3).readUIntBE(0, 3) % 900_000));
  assert.ok(new ProcError('tool', ['--password', pin], 1, `rejected: ${pin} after 3 tries`).message.endsWith('exited 1: rejected: [redacted] after 3 tries'));
  assert.equal(new ProcError('docker', ['exec', '-u', '1000:1000', 'c', 'sh'], 1, 'exit 1000 at line 1000').message, 'docker exec -u 1000:1000 c sh exited 1: exit 1000 at line 1000');
});

test('ProcError: a hidden value cut where a long stderr is scrubbed leaves no head of it', () => {
  // Printed twice: the first copy shrinks the text under the window, the second is cut at twice the window.
  const value = Array.from({ length: 5000 }, (_, i) => fakeValue()[i % 32]).join('');
  const err = new ProcError('tool', ['-e', `NEUTRAL=${value}`], 1, `${value}\n${value}`);
  assert.deepEqual(leaks([...views(err), err.stderr], [value.slice(0, 32)]), []);
});

test('run: stderr is redacted over its first 4096 chars, cut at a blank, so no head of a key is left; the message keeps 500', async () => {
  // The key starts 6 characters before the cut: its head alone is too short for the rule that knows its shape.
  const key = fakeKey(), pad = 'x '.repeat(2045);
  const script = 'process.stderr.write(process.env.PAD + process.env.KEY + " tail"); process.exit(5)';
  const err = await run(process.execPath, ['-e', script], { env: { ...process.env, PAD: pad, KEY: key } }).then(() => null, (e) => e);
  assert.ok(err instanceof ProcError, String(err));
  assert.deepEqual(leaks([...views(err), err.stderr], [key.slice(0, 6)]), []);
  assert.equal(err.stderr, pad.trimEnd());
  assert.ok(err.message.endsWith(`exited 5: ${pad.slice(0, 500)}`), err.message.slice(-60));
});

test('ProcError: the stderr cut costs linear time, so a long word before the one it drops is not rescanned', () => {
  // The cut lands in "b", after a word of 4094 characters: tried from each of them, that word took 45 ms an error.
  const stderr = `${'a'.repeat(4094)} b ${'c'.repeat(100)}`;
  const t0 = Date.now();
  for (let i = 0; i < 20; i++) assert.equal(new ProcError('tool', [], 1, stderr).stderr, 'a'.repeat(4094));
  assert.ok(Date.now() - t0 < 500, `20 errors took ${Date.now() - t0} ms`);
});

test('a command that cannot start: its spawnargs are redacted as well (run and runCapped)', async () => {
  const v = fakeValue();
  for (const fn of [run, runCapped]) {
    const err = await fn('/nonexistent/drover-test-tmux', ['-e', `FAKE_CHILD_CRED=${v}`]).then(() => null, (e) => e);
    assert.equal(err?.code, 'ENOENT', fn.name);
    assert.deepEqual(err.spawnargs, ['-e', 'FAKE_CHILD_CRED=[redacted]']);
    assert.deepEqual(leaks(views(err), [v]), [], fn.name);
  }
});

test('tryRun: an exit code it does not take comes back with the redacted message as its stderr', async () => {
  const v = fakeValue();
  const r = await tryRun(process.execPath, [FAIL, '-e', `FAKE_CHILD_CRED=${v}`], { env: { ...process.env, FAIL_CODE: '42' } });
  assert.equal(r.code, -1);
  assert.match(r.stderr, /exited 42: failed: -e FAKE_CHILD_CRED=\[redacted\]/);
  assert.deepEqual(leaks([r.stderr], [v]), []);
});

// ---------------------------------------------------------------- relays: a remote host's reply and its stderr

/** A fake `ssh <host> drover rpc` that answers every request with answer(req), or writes stderr and exits. */
function fakePeer({ answer, stderrThenExit }) {
  remote._deps.spawn = () => {
    const c = new EventEmitter();
    c.stdout = new PassThrough(); c.stderr = new PassThrough();
    c.stdin = {
      write(d) {
        for (const line of String(d).split('\n').filter(Boolean)) {
          const req = JSON.parse(line);
          if (answer) setImmediate(() => c.stdout.write(JSON.stringify(answer(req)) + '\n'));
          else setImmediate(() => { c.stderr.write(stderrThenExit); setImmediate(() => c.emit('close', 1)); });
        }
      },
      end() { setTimeout(() => c.emit('close', 0), 10); }, on() {},
    };
    c.kill = () => { setImmediate(() => c.emit('close', null)); };
    return c;
  };
}

describe('a remote host\'s error reaches the caller with no environment value in it, from a host on an older build too', () => {
  afterEach(() => remote.stopAll());
  // What a host whose errors were not redacted sent back: its whole tmux command line.
  // Values with blanks among them: nothing in the text says where those end.
  const oldError = (v) => `/usr/bin/tmux new-window -P -F #{session_name}:#{window_index} -t work -e CLAUDE_CODE_RETRY_WATCHDOG=1 -e PATH=/a:/b -e AUTH_HEADER=Bearer ${v} -e TWO_WORDS=two ${v} -e FAKE_CHILD_CRED=${v} -n agent exited 1: create window failed: index 1 in use`;

  test('in its reply', async () => {
    const v = fakeValue();
    fakePeer({ answer: (req) => ({ id: req.id, ok: false, error: oldError(v) }) });
    const err = await remote.callOn('relay-reply', 'launch.start', {}, null).then(() => null, (e) => e);
    assert.equal(err?.remote, true);
    assert.match(err.message, /-e FAKE_CHILD_CRED=\[redacted\] -n agent exited 1: create window failed: index 1 in use$/);
    assert.deepEqual(leaks(views(err), [v]), []);
  });

  test('in the stderr line relayed when its rpc exits', async () => {
    const v = fakeValue();
    fakePeer({ stderrThenExit: `drover: ${oldError(v)}\n` });
    const err = await remote.callOn('relay-stderr', 'launch.start', {}, null).then(() => null, (e) => e);
    assert.match(err?.message ?? '', /^ssh relay-stderr drover rpc exited 1: drover: .*-e FAKE_CHILD_CRED=\[redacted\]/);
    assert.deepEqual(leaks(views(err), [v]), []);
  });

  test('when it prints a value again after the command', async () => {
    const v = fakeValue();
    fakePeer({ answer: (req) => ({ id: req.id, ok: false, error: `/usr/bin/tmux new-window -t work -e NEUTRAL=${v} -n agent exited 1: rejected ${v}` }) });
    const err = await remote.callOn('relay-repeat', 'launch.start', {}, null).then(() => null, (e) => e);
    assert.match(err?.message ?? '', /-e NEUTRAL=\[redacted\] -n agent exited 1: rejected \[redacted\]$/);
    assert.deepEqual(leaks(views(err), [v]), []);
  });

  test('when the value is on one line of its stderr and printed again on the last', async () => {
    const v = fakeValue();
    fakePeer({ stderrThenExit: `drover: tool -e NEUTRAL=${v} -n w\nrejected ${v}\n` });
    const err = await remote.callOn('relay-lines', 'launch.start', {}, null).then(() => null, (e) => e);
    assert.equal(err?.message, 'ssh relay-lines drover rpc exited 1: rejected [redacted]');
  });

  test('when the cut lands in the name before a Bearer token, or in its scheme: the incomplete line is not relayed', async () => {
    const v = fakeValue();
    fakePeer({ stderrThenExit: `drover: -e HEADER=Bearer ${v}${' tail'.repeat(792)}` });
    const err = await remote.callOn('relay-bearer', 'launch.start', {}, null).then(() => null, (e) => e);
    assert.equal(err?.message, 'ssh relay-bearer drover rpc exited 1: its stderr ended in a line too long to relay');
    assert.deepEqual(leaks(views(err), [v]), []);
  });

  test('when only the last 4000 characters of its stderr are kept and the cut lands inside a value', async () => {
    // A complete line after the incomplete one is still relayed.
    const w = fakeValue();
    fakePeer({ stderrThenExit: `drover: -e HEADER=Bearer ${w}${' tail'.repeat(792)}\nlast line\n` });
    const err2 = await remote.callOn('relay-cut2', 'launch.start', {}, null).then(() => null, (e) => e);
    assert.equal(err2?.message, 'ssh relay-cut2 drover rpc exited 1: last line');
    assert.deepEqual(leaks(views(err2), [w]), []);
    // The kept part starts with the value's last 10 characters, with no name before them to say what they are.
    const v = fakeValue();
    fakePeer({ stderrThenExit: `drover: -e NEUTRAL=${v}${' tail'.repeat(798)}` });
    const err = await remote.callOn('relay-cut', 'launch.start', {}, null).then(() => null, (e) => e);
    assert.equal(err?.message, 'ssh relay-cut drover rpc exited 1: its stderr ended in a line too long to relay');
    assert.deepEqual(leaks(views(err), [v.slice(-10)]), []);
  });
});

// ---------------------------------------------------------------- end to end: a launch whose new-window fails

const hasTmux = spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status === 0;
describe('real tmux: a launch whose new-window fails returns no credential in its error, the WAL, the MCP reply or log', { skip: hasTmux ? false : 'tmux is not installed here' }, () => {
  let tdir, env, shimDir, savedPath, rpcEnv;
  const tmuxCmd = (args) => spawnSync('tmux', args, { env, encoding: 'utf8' });
  // No credential named: the pool's default (auto) picks the only entry, as a drover_launch call that names none does.
  const req = { engine: 'claude', mode: 'tmux', tmuxSession: 'work', cwd: dir, prompt: 'go', trust: false };
  const walText = () => readFile(process.env.DROVER_EVENTS, 'utf8').catch(() => '');
  const mcpLaunch = async (args) => {
    const logs = [];
    const server = createServer({ dispatch: (op, a) => api.dispatchRecorded(op, a, { actor: 'mcp' }), log: (...p) => logs.push(p.join(' ')) });
    const r = await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'drover_launch', arguments: args } });
    return { result: r.result, logs };
  };

  before(async () => {
    // A private tmux server, as in test/launch-target.test.js; every tmux call in this process goes there.
    tdir = await mkdtemp(path.join(tmpdir(), 'droverte-'));
    delete process.env.TMUX; delete process.env.TMUX_PANE;
    process.env.TMUX_TMPDIR = tdir;
    env = { ...process.env };
    assert.equal(tmuxCmd(['-f', '/dev/null', 'new-session', '-d', '-s', 'work', '-n', 'work-notes', 'sleep', '3600']).status, 0);
    // The tmux a launch runs (the first on the daemon's PATH): the real one, except that new-window is refused, the
    // refusal quoting the command it was given, as a usage message or a tracing shell would.
    const realTmux = spawnSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).stdout.trim();
    shimDir = path.join(tdir, 'shim');
    await mkdir(shimDir);
    await writeFile(path.join(shimDir, 'tmux'), `#!/bin/sh\nfor a in "$@"; do if [ "$a" = new-window ]; then echo "create window failed: index 1 in use (tmux $*)" >&2; exit 1; fi; done\nexec ${realTmux} "$@"\n`);
    await chmod(path.join(shimDir, 'tmux'), 0o755);
    savedPath = process.env.PATH;
    process.env.PATH = `${shimDir}${path.delimiter}${process.env.PATH}`;
    launchMod._deps.agentPath = async () => process.env.PATH;
    await credentials._reset({ file: true });
    // The remote host: `drover rpc` in a child of its own, as ssh would start it, with a home, state and secrets file
    // of its own and the same private tmux server.
    const home = path.join(tdir, 'home'); await mkdir(home);
    rpcEnv = {
      PATH: process.env.PATH, HOME: home, SHELL: '/bin/sh', TMUX_TMPDIR: tdir,
      DROVER_PROFILES: process.env.DROVER_PROFILES, DROVER_STATE: path.join(tdir, 'rpc-state'), DROVER_EVENTS: path.join(tdir, 'rpc-events.jsonl'),
      DROVER_DOTFILES: path.join(tdir, 'rpc-dotfiles'), DROVER_CACHE: path.join(tdir, 'rpc-cache'), DROVER_SECRETS_FILE: path.join(tdir, 'no-secrets'),
      DROVER_SEARCH: 'off', DROVER_HOST: 'rpc-box', DROVER_TEST_CRED: process.env.DROVER_TEST_CRED, DROVER_TEST_TOKEN: process.env.DROVER_TEST_TOKEN,
    };
  });
  after(async () => {
    remote.stopAll();
    // The kill names the private server's socket: with TMUX_TMPDIR alone, a missing folder would send it to the
    // user's default server.
    if (env) tmuxCmd(['-S', path.join(tdir, `tmux-${process.getuid()}`, 'default'), 'kill-server']);
    if (savedPath) process.env.PATH = savedPath;
    if (tdir) await rm(tdir, { recursive: true, force: true });
  });

  test('launch() rejects naming the command and its environment names, with neither credential value in it', async () => {
    const err = await launchMod.launch({ ...req, name: 'agent' }, { actor: 't' }).then(() => null, (e) => e);
    assert.ok(err instanceof ProcError, String(err));
    assert.match(err.message, /new-window .*-e FAKE_CHILD_CRED=\[redacted\] -e FAKE_BEARER_TOKEN=\[redacted\] .*exited 1: create window failed: index 1 in use \(tmux .*-e FAKE_CHILD_CRED=\[redacted\]/);
    assert.deepEqual(leaks([...views(err), err.stderr]), []);
  });

  test('over MCP on this host: the tool error, the WAL op record and the server log carry neither value', async () => {
    const { result, logs } = await mcpLaunch({ ...req, name: 'agent-mcp' });
    assert.equal(result.isError, true);
    const text = result.content[0].text;
    assert.match(text, /-e FAKE_CHILD_CRED=\[redacted\]/);
    const wal = await walText();
    const op = wal.trim().split('\n').map((l) => JSON.parse(l)).findLast((e) => e.type === 'op' && e.op === 'launch.start');
    assert.equal(op.ok, false);
    assert.match(op.error, /FAKE_CHILD_CRED=\[redacted\]/);
    assert.deepEqual(leaks([text, wal, ...logs]), []);
  });

  test('over MCP to a remote host (drover rpc in a child process): the relayed error, the WAL and the log carry neither value', async () => {
    remote._deps.spawn = (_file, _argv, opts) => spawn(process.execPath, [BIN, 'rpc'], { ...opts, env: rpcEnv });
    const { result, logs } = await mcpLaunch({ ...req, host: 'rpc-box', name: 'agent-rpc' });
    assert.equal(result.isError, true, result.content[0].text);
    const text = result.content[0].text;
    assert.match(text, /new-window .*-e FAKE_CHILD_CRED=\[redacted\] -e FAKE_BEARER_TOKEN=\[redacted\] .*exited 1: create window failed/);
    const wal = await walText();
    const op = wal.trim().split('\n').map((l) => JSON.parse(l)).findLast((e) => e.type === 'op' && e.op === 'launch.start' && e.target === 'rpc-box');
    assert.equal(op.ok, false);
    assert.deepEqual(leaks([text, wal, ...logs]), []);
  });
});
