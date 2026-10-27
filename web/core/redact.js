// The secret redactor, for text (bearer tokens, API keys, key=value secrets, long letter+digit runs), for an argv (the
// value after a flag that names a credential too) and for a command line an error shows (every environment value).
// It imports nothing, so the lowest modules can use it: core/proc.js builds its error texts with it. core/native.js
// re-exports redactSecrets and redactArgv for their other callers.
const REDACTIONS = [
  [/Bearer\s+\S+/g, '[redacted]'],
  [/sk-[A-Za-z0-9_-]{10,}/g, '[redacted]'],
  [/ghp_\w+/g, '[redacted]'],
  [/gh[ousr]_\w+/g, '[redacted]'],
  [/glpat-[\w-]+/g, '[redacted]'],
  [/xox[abpr]-[\w-]+/g, '[redacted]'],
  [/AKIA[0-9A-Z]{16}/g, '[redacted]'],
  [/ABSK[A-Za-z0-9+/=]{20,}/g, '[redacted]'],
  // A password in a URL's userinfo (between :// and @): the scheme, user and host stay searchable. And curl-style
  // -u / --user user:password.
  // Anchored on the // of the URL, its scheme checked behind it, not tried from every word start: the scheme scan of
  // the old form restarted at each word of a long run of letters, dots or dashes (quadratic: 50 KB took 3 s). Without
  // the scheme, //x:y@ in other text would be taken for userinfo and could swallow a key whose value then stays visible.
  [/(?<=\b[a-z][a-z0-9+.-]*:)\/\/([^\s\/@:]*):[^\s\/@]+@/gi, '//$1:[redacted]@'],
  [/(^|\s)(-u|--user)(\s+|=)([^\s:@]*):(\S+)/g, '$1$2$3$4:[redacted]'],
  // A long flag that names a credential, then its value: docker login --password x, gh --github-token x. Only a flag
  // that ends in the word, so --password-stdin and --token-file keep their (non-secret) next argument.
  // Tried once per run of word characters and dashes, where the run starts; lookaheads find the -- in it and the word
  // at its end. So a flag glued to what precedes it (\n--password x in serialized text) is still caught, and a run
  // holding many -- is not rescanned from each of them.
  [/(?<![\w-])(?=[\w-]*?--)(?=[\w-]*?[-_](?:token|password|passwd|secret|api[-_]?key|access[-_]?key|private[-_]?key|authorization|credentials?)(?:\s|=))([\w-]+)(\s+|=)(?!-)(\S+)/gi, '$1$2[redacted]'],
  // Authorization: <scheme> <credential> for any scheme (Basic, Token, GenieKey, ...): the credential goes with it.
  [/\b((?:proxy-)?authorization)(["']?\s*[=:]\s*["']?)(?:[A-Za-z][\w.-]*\s+)?[^\s"',;)]+/gi, '$1$2[redacted]'],
  // key = value / key: value where the key names a secret, prefixed or not (aws_secret_access_key, DD_API_KEY,
  // client_secret, GITHUB_PERSONAL_ACCESS_TOKEN). Booleans, and numbers on counters (max_tokens: 2048), are not
  // secrets; a number on any other secret key (password=12345678) is.
  // Tried only where a key run starts (a lookbehind), and the keyword is looked for inside that run once (a lookahead):
  // a scan from every word start was quadratic on a long run, and a length bound would let a long key name through.
  [/(["']?)(?<![A-Za-z0-9_.-])(?=[A-Za-z0-9_.-]*?(?:token|password|passwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|authorization|credentials?))([A-Za-z0-9_.-]+)\1(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&)]+)/gi,
    (all, q, k, sep, v) => {
      const bare = v.replace(/^["']|["']$/g, '');
      const counter = /tokens|token_?count|_count$|_limit$|_size$/i.test(k) && /^\d+$/.test(bare);
      return counter || /^(true|false|null|none|\[redacted\])$/i.test(bare) ? all : `${q}${k}${q}${sep}[redacted]`;
    }],
];
const LONG_RUN = /[A-Za-z0-9+/=_-]{32,}/g;
// Session and event ids (UUIDs) stay searchable. Bare hex runs do not: a 32-hex Datadog API key or a 40-hex
// application key looks exactly like a digest or a commit SHA (short SHAs are under 32 chars and never redacted).
const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// A segment that reads as a word: lowercase or CamelCase letters, an ALLCAPS word, digits, or a word then digits.
// Random base64 and base64url segments flip case mid-word and fail this almost always.
const LEXICAL = /^(?:[a-z]+|[A-Z][a-z]+|[A-Z]+)(?:[A-Z][a-z]+)*\d*$|^\d+$/;
/** A long run of short word-like segments joined by - _ or / (memory note names, branches, paths), not a token. */
const WORDISH = (m) => {
  const parts = m.split(/[-_/]+/).filter(Boolean);
  return parts.length >= 3 && !/[+=]/.test(m) && parts.every((p) => p.length <= 20 && LEXICAL.test(p)) && parts.some((p) => /[a-z]{3,}/i.test(p) && !/^\d+$/.test(p));
};

/**
 * The secret redactions alone (bearer tokens, API keys, key=value secrets, long letter+digit runs); layout and
 * paths are kept. hexSafe (the search index) also keeps what a search must still find: lowercase hex runs
 * (session and event UUIDs) and identifiers or paths made of word-like segments (project_42_triage_20261013).
 * Known key shapes (sk-, ghp_, glpat-, xox, AKIA, ABSK, Bearer, key=value) and long single-segment tokens
 * (base64, JWT parts, fine-grained PAT bodies) are redacted either way.
 */
export function redactSecrets(text, { hexSafe = false } = {}) {
  if (text == null) return '';
  let s = String(text);
  for (const [re, to] of REDACTIONS) s = s.replace(re, to);
  return s.replace(LONG_RUN, (m) => (/[A-Za-z]/.test(m) && /\d/.test(m) && !(hexSafe && (UUIDISH.test(m) || WORDISH(m))) ? '[redacted]' : m));
}

// A command-line flag that names a secret; its value is the next argv item (--password hunter2). The --flag=value form
// is already a key=value secret to redactSecrets. The word is looked for once, by a lookahead: scanning on to the end
// after each place it occurs made a long item that names it many times quadratic (200 KB took 8 s).
const SECRET_FLAG = /^-{1,2}(?=[A-Za-z0-9_.-]*?(?:token|password|passwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|authorization|credentials?))[A-Za-z0-9_.-]*$/i;

// One item that is a secret flag or key with its value (--password=<value>, DB_PASSWORD=<value>, curl's
// --user=alice:<password>, glued -ualice:<password> or -U): the item is where the value ends, so all of it goes, blanks
// included, where in text redactSecrets can only take it to a blank. Only a key that ends in the word: one that goes
// on after it (max_tokens=2048, --token-file=<path>) is left to redactSecrets, and a docker uid:gid stays. Anchored,
// so the key is read once.
const SECRET_ITEM = /^(-{0,2}[A-Za-z0-9_.-]*?(?:token|password|passwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|authorization|credentials?)=|(?:-u|--(?:proxy-)?user=)(?!\d+:\d+$)[^\s:]*:)[\s\S]+$/i;

const USER_FLAGS = new Set(['-u', '--user', '-U', '--proxy-user']);

/**
 * An argv fit to record or show: every item through redactSecrets (KEY=value, known key shapes, long tokens), and the
 * item after a flag that names a secret replaced as well, since alone it reads like any other word. Items keep their
 * places, so the command stays readable. Not an array: returned as is.
 * The password of -u / --user and -U / --proxy-user user:password (curl) goes too: redactSecrets knows that pair only
 * within one text, and here the flag and its value are two items. A docker uid:gid (digits:digits) stays, as in the
 * op log.
 */
export function redactArgv(argv, opts) {
  if (!Array.isArray(argv)) return argv;
  return argv.map((a, i) => {
    if (typeof a !== 'string') return a;
    if (i > 0 && typeof argv[i - 1] === 'string' && SECRET_FLAG.test(argv[i - 1]) && !a.startsWith('-')) return '[redacted]';
    if (USER_FLAGS.has(argv[i - 1]) && !/^\d+:\d+$/.test(a)) a = a.replace(/^([^:]*:)[\s\S]+/, '$1[redacted]');
    return redactSecrets(a.replace(SECRET_ITEM, '$1[redacted]'), opts);
  });
}

// An argv item that sets an environment variable: after -e or --env (tmux, docker) any name; glued, --env=NAME=value
// any name and -eNAME=value a name in capitals (so -encoding=utf8 stays); on its own (env NAME=value), a name in
// capitals, as environment names are, so a config override such as codex -c model_reasoning_effort="high" stays.
const ENV_FLAG = /^(?:-e|--env)$/;
const ENV_ITEM = /^([A-Za-z_][A-Za-z0-9_]*=)([\s\S]*)$/;
const GLUED_ENV_ITEM = /^(--env=[A-Za-z_][A-Za-z0-9_]*=|-e[A-Z_][A-Z0-9_]*=)([\s\S]*)$/;
const BARE_ENV_ITEM = /^([A-Z_][A-Z0-9_]*=)([\s\S]*)$/;
// The same in text, which does not say where a value ends. After -e or --env (a command line, maybe relayed from a
// host on an older build) a quoted value runs to its closing quote, and any other to the next flag or NAME=, to
// " exited <code>: " (where a command error's stderr starts) or to the end of the line, since it can hold blanks
// (-e HEADERS=X-Api-Key: <key>). A bare name in capitals, as environment names are (AWS_REGION=x), has its value up to
// a blank; a lowercase key=value in prose stays unless its key names a secret (redactSecrets). Tried only where a word
// starts, and an end is looked for only where a blank is, so each character is read a bounded number of times. A
// value already [redacted] matches again and stays the same, so one only partly redacted still goes whole; a bare
// value that is exactly [redacted] (up to a blank or a closing quote) is passed over, and so is a quoted one by the
// unquoted rules (the quoted ones have it).
const QUOTED_ENV_IN_TEXT = /(?<![\w.-])((?:-e\s*|--env[=\s]\s*)(['"])[A-Za-z_][A-Za-z0-9_]*=)[^\n]*?(?=\2|\sexited -?\d+: |\n|$)/g;
// The quote after the = instead (-e NAME="value", or a bare NAME="value"): the value runs to it the same way.
const QUOTED_VALUE_IN_TEXT = /(?<![\w.-])((?:(?:-e\s+|--env[=\s]\s*)[A-Za-z_][A-Za-z0-9_]*|[A-Z_][A-Z0-9_]*)=(['"]))[^\n]*?(?=\2|\sexited -?\d+: |\n|$)/g;
const ENV_FLAG_IN_TEXT = /(?<![\w.-])((?:-e\s+|--env[=\s]\s*)[A-Za-z_][A-Za-z0-9_]*=|-e[A-Z_][A-Z0-9_]*=)(?!['"])[^\n]*?(?=\s-{1,2}[A-Za-z]|\s[A-Z_][A-Z0-9_]*=|\sexited -?\d+: |\n|$)/g;
const BARE_ENV_IN_TEXT = /(?<![\w.-])([A-Z_][A-Z0-9_]*=)(?!['"]|\[redacted\](?:['"\s]|$))\S+/g;

/** What redaction took out of item to make redacted: the text between the parts it kept; all of item when they do not line up. */
function removedParts(item, redacted) {
  const kept = redacted.split('[redacted]');
  const out = [];
  let at = 0;
  for (const [k, part] of kept.entries()) {
    const last = k === kept.length - 1;
    const i = k === 0 ? (item.startsWith(part) ? 0 : -1) : last ? (item.endsWith(part) ? item.length - part.length : -1) : item.indexOf(part, at);
    if (i < at) return [item];
    if (k > 0) out.push(item.slice(at, i));
    at = i + part.length;
  }
  return out;
}

/** REDACTIONS over text as redactSecrets applies them, with what each match took out added to taken. */
function shapes(text, taken) {
  let s = text;
  for (const [re, to] of REDACTIONS) {
    s = s.replace(re, (...args) => {
      const out = typeof to === 'function' ? to(...args) : to.replace(/\$(\d)/g, (_, n) => args[Number(n)] ?? '');
      if (out !== args[0]) taken.push(...removedParts(args[0], out));
      return out;
    });
  }
  return s;
}

// The words that make a key a secret's, for an environment name.
const SECRET_WORD = /token|password|passwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|authorization|credentials?/i;

/**
 * Keep value, and each of its words (a tool may print only the token of a "Bearer <token>"), to be scrubbed from the
 * rest of a text: a value known to be a credential from 4 characters (min 4), any other environment value from 8, so a
 * short common one (a flag of 1) takes no words out of that text.
 */
// What a value can carry from the text around it: quotes, brackets and separators of JSON, shell or prose, and the
// end of a sentence.
const TRIM_PUNCT = /^[\s"'`{}[\](),;:<>]+|[\s"'`{}[\](),;:<>.!?]+$/g;

function hide(set, value, min, { numbers = false } = {}) {
  // Unquoted too (a JSON value, a shell-quoted one): the tool may print it bare. A short number is left
  // alone unless the command named it a credential (--password 123456): it is in any text (an exit code, a port, a
  // uid), and its own place was redacted already.
  for (const w of [value, ...value.split(/\s+/)]) for (const x of [w, w.replace(TRIM_PUNCT, '')]) if (x.length >= min && x !== '[redacted]' && x !== 'redacted' && (numbers || !/^\d{1,7}$/.test(x))) set.add(x);
}

/**
 * A command fit for an error text or a log: every environment value in argv replaced, its name kept (a tmux launch
 * hands the agent its credential as -e NAME=value), and the rest through redactArgv. hidden: what was taken out, so
 * the command's own output can lose it as well (scrubValues): the environment values, the secrets found inside them
 * (a URL's password), and what redactArgv took from inside items (--password=<value>). Those are taken out of the
 * other items too, where the command repeats them (a prompt that quotes its own token).
 */
export function redactCommand(argv) {
  if (!Array.isArray(argv)) return { argv, hidden: [] };
  const hidden = new Set();
  const envFree = argv.map((a, i) => {
    if (typeof a !== 'string') return a;
    const m = ENV_FLAG.test(argv[i - 1]) ? ENV_ITEM.exec(a) : GLUED_ENV_ITEM.exec(a) ?? BARE_ENV_ITEM.exec(a);
    if (!m) return a;
    const taken = [];
    shapes(m[2], taken);
    const secret = SECRET_WORD.test(m[1]);
    hide(hidden, m[2], secret ? 4 : 8, { numbers: secret });
    for (const t of taken) hide(hidden, t, 4, { numbers: true });   // a credential the shapes found (a URL's password)
    return `${m[1]}[redacted]`;
  });
  const shown = redactArgv(envFree, { hexSafe: true });
  shown.forEach((a, i) => { if (a !== envFree[i]) for (const part of removedParts(envFree[i], a)) hide(hidden, part, 4, { numbers: true }); });
  const values = [...hidden], scrub = scrubber(values);
  return { argv: shown.map((a) => (typeof a === 'string' ? scrub(a) : a)), hidden: values };
}

// curl's user:password after -u, -U, --user or --proxy-user, glued or not, in text (redactSecrets knows -u and --user
// with a blank or = only). A docker uid:gid stays. Tried only after a blank (as redactSecrets' own rule is): the user
// part reads on to a blank, so two tries never read the same run (after any other non-word character they did, and a
// run of "-u/" took the square of its length).
const USER_IN_TEXT = /(?<!\S)(-[uU]\s*|--(?:proxy-)?user[=\s]\s*)(?!\d+:\d+(?:\s|$))([^\s:@]*:)(\S+)/g;
// Of a text redactEnvText reads the first 64 KB (a remote host's error can be any size, and each value scrubbed costs
// a pass over it); the cut drops the partial word it lands in, and how much was left out is said instead.
const TEXT_WINDOW = 64 << 10;

/**
 * Text that may quote a command line (a relayed error, a command's stderr). What is found is taken out, and then out
 * of the rest of the text too, since a command can print a value again (rejected <value>): the secret shapes first,
 * while "Bearer <token>" is still whole and before a value's end is guessed at a flag-like word; then curl's
 * user:password forms and the environment values (quoted ones to their quote); then the long-token rule, last, so that
 * it cannot take a name with its value.
 */
export function redactEnvText(text) {
  let input = String(text ?? ''), left = '';
  if (input.length > TEXT_WINDOW) {
    const kept = input.slice(0, TEXT_WINDOW).replace(/(?<!\S)\S*$/, '').trimEnd();
    left = ` … (${input.length - kept.length} more characters)`;
    input = kept;
  }
  const hidden = new Set(), taken = [];
  const take = (all, name) => {
    const value = all.slice(name.length);
    if (value.length >= 4) hide(hidden, value, SECRET_WORD.test(name) ? 4 : 8);
    return `${name}[redacted]`;
  };
  let s = shapes(input, taken);
  for (const t of taken) hide(hidden, t, 4);
  s = s.replace(USER_IN_TEXT, (all, flag, user, password) => { hide(hidden, password, 4); return `${flag}${user}[redacted]`; });
  s = s.replace(QUOTED_ENV_IN_TEXT, take).replace(QUOTED_VALUE_IN_TEXT, take).replace(ENV_FLAG_IN_TEXT, take).replace(BARE_ENV_IN_TEXT, take);
  return redactSecrets(scrubValues(s, [...hidden]), { hexSafe: true }) + left;
}

// Each value scrubbed costs a pass over the text: at most this many, the longest first.
const MAX_SCRUBBED = 256;

/** A function that replaces each of values by [redacted] in a text, the longest first, since one value can hold another. */
function scrubber(values) {
  const list = [...new Set(values)].filter(Boolean).sort((a, b) => b.length - a.length).slice(0, MAX_SCRUBBED);
  return (text) => { let s = text; for (const v of list) if (s.includes(v)) s = s.split(v).join('[redacted]'); return s; };
}

/** text with each of values replaced by [redacted], the longest first, since one value can hold another. */
export function scrubValues(text, values = []) {
  return scrubber(values)(String(text ?? ''));
}
