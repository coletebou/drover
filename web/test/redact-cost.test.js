// The shared redactor (core/native.js) runs over whole transcript turns, commands, logs, argv and op args, and the
// indexer cleans each text around it (search/extract.js), so their cost must grow with the length of the text, not its
// square: a long run of word characters, dots, dashes or blanks used to make rules rescan it from every position (50 KB
// took about 3 s, 200 KB a minute). What is redacted must not change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets, redactArgv } from '../core/native.js';
import { tidy, userText, claudeToolLine } from '../core/search/extract.js';

const timed = (s) => { const t0 = Date.now(); redactSecrets(s); return Date.now() - t0; };

test('long runs cost linear time: words and dashes, dots, bare dashes, double dashes, flag names, URL schemes, base64url', () => {
  let b64 = ''; for (let i = 0; b64.length < 2_000_000; i++) b64 += 'Kq3_Zx-9Lm2Pw8Rt'[i % 16] + (i % 7);
  for (const [name, s] of [
    ['a-a-a', 'a-'.repeat(100_000)], ['ab.ab.', 'ab.'.repeat(70_000)], ['dashes', '-'.repeat(200_000)], ['words', 'word '.repeat(40_000)],
    ['a--a--', 'a--'.repeat(70_000)], ['--token--token', `${'--token'.repeat(30_000)}!`], ['escaped flags', '\\n--x'.repeat(50_000)],
    ['scheme runs', `${'a.'.repeat(500)}://x:`.repeat(200)], ['base64url 2 MB', b64],
  ]) {
    const ms = timed(s);
    assert.ok(ms < 1500, `${name}: ${s.length} chars took ${ms} ms`);
  }
});

test('an argv item that names a secret many times costs linear time too (the flag check behind redactArgv)', () => {
  const t0 = Date.now();
  const [flag, next] = redactArgv([`--${'token'.repeat(40_000)}=1`, 'x']);
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
  assert.ok(flag.endsWith('token=[redacted]') && next === 'x', `${flag.slice(-20)} ${next}`);
  // What it treats as a secret flag does not change: a dashed item naming the word anywhere (--DB-Secret-x, --tokens)
  // takes the next item unless that is a flag too; a bare or split word (token, --to.ken) does not.
  assert.deepEqual(redactArgv(['login', '--password', 'hunter2', '-p', 'x']), ['login', '--password', '[redacted]', '-p', 'x']);
  assert.deepEqual(redactArgv(['--DB-Secret-x', 'hunter2', '--secret', '--', 'x']), ['--DB-Secret-x', '[redacted]', '--secret', '--', 'x']);
  assert.deepEqual(redactArgv(['token', 'x', '--tokens', 'y', '--to.ken', 'z']), ['token', 'x', '--tokens', '[redacted]', '--to.ken', 'z']);
});

test('what is redacted does not change: labelled values, URL userinfo, flags, long keys', () => {
  const cases = [
    // Assembled at runtime, so no literal here looks like a connection string with a password.
    [['postgres:', '', 'app:pw4db@db.internal', 'x'].join('/'), ['postgres:', '', 'app:[redacted]@db.internal', 'x'].join('/')],
    ['MY_SERVICE_DATABASE_PASSWORD=hunter22', 'MY_SERVICE_DATABASE_PASSWORD=[redacted]'],
    ['"client_secret": "abc"', '"client_secret": [redacted]'],
    ['gh auth --github-token=abc12 && login --password hunter2', 'gh auth --github-token=[redacted] && login --password [redacted]'],
    ['docker login --password-stdin x --token-file /run/t', 'docker login --password-stdin x --token-file /run/t'],
    ['curl -u alice:pw9 https://x', 'curl -u alice:[redacted] https://x'],
    ['Authorization: Basic Zm9vOmJhcg==', 'Authorization: [redacted]'],
  ];
  for (const [input, want] of cases) assert.equal(redactSecrets(input), want, input);
});

test('no length makes a secret slip through: a long key name, flag, auth scheme, userinfo; an overlapping pair', () => {
  const long = 'A'.repeat(65);
  const url = ['https:', '', `app:${'%23'.repeat(171)}@db`].join('/');
  for (const [input, gone] of [
    [`{"${long}PASSWORD": "hunter2"}`, 'hunter2'],
    [`--${'a'.repeat(65)}-password hunter2`, 'hunter2'],
    [`Authorization: ${'A'.repeat(66)} hunter2`, 'hunter2'],
    [url, '%23%23'],
    [`https://${'u'.repeat(300)}:pw9x@db`, 'pw9x'],
    ['a=token=xyz9', 'xyz9'],
  ]) assert.ok(!redactSecrets(input).includes(gone), `${input.slice(0, 40)}…`);
});

test('a credential flag glued to what precedes it is still one: an escaped newline or tab, an escape code, a word', () => {
  for (const input of ['docker login \\n--password hunter2', '{"cmd":"login\\t--token hunter2"}', '\x1b[1m--secret hunter2', 'x--password hunter2', 'a-b--api-key hunter2']) {
    assert.ok(!redactSecrets(input).includes('hunter2'), JSON.stringify(input));
  }
  // Still not a credential flag: no --, or a flag that ends in another word.
  for (const input of ['the db_password hunter2', 'x--password-stdin hunter2', 'run --token-file hunter2']) assert.equal(redactSecrets(input), input);
});

test('URL userinfo needs a scheme: //x:y@ in other text is left alone, so it cannot swallow a key and leave its value', () => {
  assert.ok(!redactSecrets('//a:passwd=@hunter2').includes('hunter2'));
  assert.equal(redactSecrets('see //a:b@c'), 'see //a:b@c');
  assert.equal(redactSecrets(['HTTPS:', '', 'u:p9@h'].join('/')), ['HTTPS:', '', 'u:[redacted]@h'].join('/'));
});

// The rules as they were before they were made linear (master 5333cfa), kept as the reference: on short text, where
// their cost does not matter, nothing they removed may survive the linear rules. (The linear key=value rule also takes
// a quoted key that starts with - or ., so it may remove more.)
const WORDS = 'token|password|passwd|secret|api[-_]?key|access[-_]?key|private[-_]?key|authorization|credentials?';
const ORIGINAL = [
  [/Bearer\s+\S+/g, '[redacted]'], [/sk-[A-Za-z0-9_-]{10,}/g, '[redacted]'], [/ghp_\w+/g, '[redacted]'], [/gh[ousr]_\w+/g, '[redacted]'],
  [/glpat-[\w-]+/g, '[redacted]'], [/xox[abpr]-[\w-]+/g, '[redacted]'], [/AKIA[0-9A-Z]{16}/g, '[redacted]'], [/ABSK[A-Za-z0-9+/=]{20,}/g, '[redacted]'],
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s\/@:]*):[^\s\/@]+@/gi, '$1:[redacted]@'],
  [/(^|\s)(-u|--user)(\s+|=)([^\s:@]*):(\S+)/g, '$1$2$3$4:[redacted]'],
  [new RegExp(`(--(?:[\\w-]*[-_])?(?:${WORDS}))(\\s+|=)(?!-)(\\S+)`, 'gi'), '$1$2[redacted]'],
  [/\b((?:proxy-)?authorization)(["']?\s*[=:]\s*["']?)(?:[A-Za-z][\w.-]*\s+)?[^\s"',;)]+/gi, '$1$2[redacted]'],
  [new RegExp(`(["']?)\\b([A-Za-z0-9_.-]*?(?:${WORDS})[A-Za-z0-9_.-]*)\\1(\\s*[=:]\\s*)("[^"]*"|'[^']*'|[^\\s,;&)]+)`, 'gi'), (all, q, k, sep, v) => {
    const bare = v.replace(/^["']|["']$/g, '');
    const counter = /tokens|token_?count|_count$|_limit$|_size$/i.test(k) && /^\d+$/.test(bare);
    return counter || /^(true|false|null|none|\[redacted\])$/i.test(bare) ? all : `${q}${k}${q}${sep}[redacted]`;
  }],
];
const original = (text) => ORIGINAL.reduce((s, [re, to]) => s.replace(re, to), text)
  .replace(/[A-Za-z0-9+/=_-]{32,}/g, (m) => (/[A-Za-z]/.test(m) && /\d/.test(m) ? '[redacted]' : m));

test('nothing the original rules removed survives: 30,000 seeded strings of rule-shaped pieces', () => {
  const pieces = ['-', '--', 'a', 'x', 'n', '\\', '\\n', '_', '.', ' ', '\n', '\t', '=', ':', '"', "'", '@', '/', '//', ',', ';', '&', ')', '(',
    'password', 'token', 'secret', 'api-key', 'access_key', 'credentials', 'passwd', 'stdin', 'file', 'max_tokens', 'Authorization',
    'proxy-authorization', 'Basic ', 'Bearer ', 'https:', 'redis:', '-u', '--user', 'user', 'SEKRET1', 'SEKRET2', '%23', 'true', '1234', 'A', '\x1b[1m', '{', '['];
  const marks = (s) => ['SEKRET1', 'SEKRET2', '%23'].map((m) => s.split(m).length - 1);
  let seed = 20261020;
  // mulberry32, seeded so a failure replays.
  const rand = (n) => { seed = (seed + 0x6d2b79f5) >>> 0; let t = Math.imul(seed ^ (seed >>> 15), seed | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return Math.floor((((t ^ (t >>> 14)) >>> 0) / 2 ** 32) * n); };
  for (let i = 0; i < 30_000; i++) {
    let s = ''; for (let n = 1 + rand(28); n > 0; n--) s += pieces[rand(pieces.length)];
    const want = original(s), got = redactSecrets(s);
    const [g, w] = [marks(got), marks(want)];
    assert.ok(g.every((n, j) => n <= w[j]), `${JSON.stringify(s)}\n  original: ${JSON.stringify(want)}\n  now:      ${JSON.stringify(got)}`);
  }
});

test('a command for the index is tidied whole, and a long one still costs little', () => {
  const big = `cat > /tmp/x <<'EOF'\n${'a-'.repeat(300_000)}\nEOF`;
  const t0 = Date.now();
  const line = claudeToolLine('Bash', { command: big, description: 'write it' });
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
  assert.match(line, /^\$ cat > \/tmp\/x/); assert.ok(line.length <= 400, `kept ${line.length} chars`);
  assert.equal(tidy('token=abc12 rest'), 'token=[redacted] rest');
});

test('a quoted secret or URL userinfo far longer than the index line stays redacted in it', () => {
  // Each value runs past 4 KB: a cut made before redaction would split it from its closing quote or its @.
  const words = 'private words '.repeat(400);
  for (const [cmd, want] of [
    [`PASSWORD="first second ${words}" tool`, '$ PASSWORD=[redacted] tool'],
    [`PASSWORD='first second ${words}' tool`, '$ PASSWORD=[redacted] tool'],
    [`psql ${['postgres:', '', `app:${'%23'.repeat(1500)}@db`].join('/')}`, ['$ psql postgres:', '', 'app:[redacted]@db'].join('/')],
  ]) assert.equal(claudeToolLine('Bash', { command: cmd }), want, `${cmd.slice(0, 24)}…`);
});

test('the indexer cleanup around the redactor is linear too: blanks with no newline after, unclosed reminder or peer tags', () => {
  for (const [name, f, s] of [
    ['blanks', tidy, `${' '.repeat(200_000)}x`], ['tabs and blanks', tidy, `${'\t '.repeat(100_000)}x`],
    ['unclosed reminders', userText, '<system-reminder>'.repeat(20_000)], ['unclosed peer tags', userText, '<cross-session-message '.repeat(16_000)],
  ]) {
    const t0 = Date.now(); f(s);
    assert.ok(Date.now() - t0 < 1500, `${name}: ${s.length} chars took ${Date.now() - t0} ms`);
  }
  // What they take out does not change.
  assert.equal(tidy('a \t\nb   c\n\n\n\nd'), 'a\nb   c\n\nd');
  assert.equal(userText('<system-reminder>x</system-reminder>hi <system-reminder>y</system-reminder> there <system-reminder>'), 'hi  there <system-reminder>');
  assert.equal(userText('<cross-session-message from="a">hello</cross-session-message> <cross-session-message'), 'hello <cross-session-message');
});
