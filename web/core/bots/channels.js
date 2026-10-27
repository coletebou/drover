// Channels: the owner's human-facing places a Grok bot may post to (a group chat, a team channel), so a bot answering a
// request can tell the people there itself instead of asking an agent to relay it. Every post is an approval request
// (core/bots/approvals.js, kind post) whose card shows the exact text and where it goes; only the owner's yes sends it.
//  - The owner configures channels with the main token (server/http.js /api/bots/channels/*, `drover channels`), never
//    an op: an agent able to add one could have every post the owner approves sent wherever it likes. A webhook
//    channel's URL is its secret (stored 0600 in <state>/bots/channels.json, shown as host and id tail only); a command
//    channel runs an argv on this host, never through a shell, with the text as one argument ({text}) or on stdin.
//  - A bot sees channel names and titles only (drover_whoami), and only the channels that allow it (bots).
//  - What is sent is the request's details, exactly the text the owner saw and approved: the bot's words, cleaned
//    (secrets redacted), behind its name, so the people in the channel know a bot speaks.
//  - A request is bound to the channel as it stood when the card was made (its rev): a channel changed since (where it
//    leads, its title) or removed sends nothing.
//  - Why a post failed is told in Drover's own words (the HTTP status, the exit code). What the channel itself said (a
//    webhook's answer, a command's stderr) can echo the post, so it never goes into the owner's records or the bot's
//    message: only `drover channels test` shows it, to the owner. A failure after the post may have left (a timeout, a
//    broken connection, a command that ran and failed) is unknown, never "not sent": Drover never posts twice.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stateDir } from '../paths.js';
import { OWNER_NAME } from '../owner.js';
import * as eventsMod from '../events.js';
import * as grok from './grok.js';
import * as approvals from './approvals.js';

export const KINDS = ['webhook', 'command'];
export const FORMATS = ['slack', 'discord', 'text', 'json'];
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const TEXT_MAX = 1800;   // the bot's words; with its name in front a post stays under Discord's 2000
const ARGV_MAX = 16, ARG_MAX = 400;   // within the 8 KB the /api/bots routes read
const OPTIONS = ['Post it', 'Do not post'];   // option 1 posts (approvals.js actions)
/**
 * Where a command channel's argv takes the post: an argument that is exactly {text}, or a long option's value
 * (--text={text}). Inside any larger argument (osascript -e '... "{text}" ...', node -e) the bot's words could be read
 * as code, so that is refused.
 */
const TEXT_ARG = /^(?:--[A-Za-z0-9][A-Za-z0-9-]*=)?\{text\}$/;
const textHoleError = (argv) => {
  const holes = argv.slice(1).filter((a) => a.includes('{text}'));
  return holes.length > 1 || holes.some((a) => !TEXT_ARG.test(a)) ? '{text} must be a whole argument, or a long option\'s value like --text={text}, and appear once: inside a larger argument the post could be read as code' : null;
};

export const _deps = {
  file: () => path.join(stateDir(), 'bots', 'channels.json'),
  fetch: (url, init) => globalThis.fetch(url, init),
  execFile: (file, args, opts, cb) => execFile(file, args, opts, cb),
  now: () => Date.now(),
  timeoutMs: 15_000,
  commandTimeoutMs: 30_000,
};

/** Refusals the routes turn into an HTTP status (400 a bad channel, 404 no such channel). */
export class ChannelError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'ChannelError'; this.status = status; }
}

// ---------------------------------------------------------------- the store (secret: webhook URLs, command argv)
async function load() {
  try {
    const c = JSON.parse(await readFile(_deps.file(), 'utf8'));
    if (c && typeof c === 'object' && c.channels && typeof c.channels === 'object' && !Array.isArray(c.channels)) return c;
  } catch { /* missing or unreadable: no channels */ }
  return { v: 1, channels: {} };
}
async function save(c) {
  const file = _deps.file();
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(c, null, 1) + '\n', { mode: 0o600 });
  await rename(tmp, file);
}
let chain = Promise.resolve();
/** One change at a time, each reading what the one before it wrote (as grok.js updateConfig). */
function update(change) {
  const run = chain.then(async () => { const c = await load(); const r = await change(c); await save(c); return r; });
  chain = run.catch(() => { /* the next change starts from the file either way */ });
  return run;
}
const own = (c, name) => (Object.hasOwn(c.channels, name) ? c.channels[name] : null);

/** A webhook URL a channel may have: https (it is the secret), plain http only to loopback (tests), no credentials in it. */
export function webhookUrlAllowed(url) {
  let u; try { u = new URL(url); } catch { return false; }
  if (u.username || u.password || !u.hostname) return false;
  return u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname));
}

const oneLine = (s, max) => String(s ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** A channel as given (the CLI or the route), checked; throws ChannelError. */
function channelOf({ kind, url, format, argv, title, bots } = {}) {
  if (!KINDS.includes(kind)) throw new ChannelError(`kind must be ${KINDS.join(' or ')}`);
  const out = { kind, title: title === undefined || title === null ? null : oneLine(title, 80) || null };
  if (kind === 'webhook') {
    if (typeof url !== 'string' || !webhookUrlAllowed(url.trim())) throw new ChannelError('a webhook channel needs an https URL with no user or password in it');
    out.url = url.trim();
    out.format = format === undefined || format === null ? 'json' : format;
    if (!FORMATS.includes(out.format)) throw new ChannelError(`format must be one of ${FORMATS.join(', ')}`);
  } else {
    if (!Array.isArray(argv) || !argv.length || argv.length > ARGV_MAX || argv.some((a) => typeof a !== 'string' || !a || a.length > ARG_MAX || a.includes('\0'))) throw new ChannelError(`a command channel needs argv: 1 to ${ARGV_MAX} non-empty strings, like ["imsg", "send", "--chat-identifier", "<chat>", "--text", "{text}"]`);
    if (argv[0].includes('{text}')) throw new ChannelError('the program (argv[0]) cannot be the text');
    const hole = textHoleError(argv);
    if (hole) throw new ChannelError(hole);
    out.argv = argv.slice();
  }
  if (bots !== undefined && bots !== null) {
    const list = (Array.isArray(bots) ? bots : String(bots).split(',')).map((b) => grok.botName(b));
    if (!list.length || list.some((b) => !b)) throw new ChannelError('bots must be Grok bot names, like alpha,beta');
    out.bots = [...new Set(list)];
  } else out.bots = null;
  return out;
}

/** Add or replace a channel. Main token only (the route, `drover channels add`). */
export async function setChannel(name, spec = {}) {
  const n = String(name ?? '').trim().toLowerCase();
  if (!NAME_RE.test(n)) throw new ChannelError('a channel name is lowercase letters, digits and dashes, like cole-brett');
  const ch = channelOf(spec);
  return update((c) => {
    const now = new Date(_deps.now()).toISOString();
    // rev: which version of the channel a request was made for (a change makes a new one; requests for the old one send nothing).
    c.channels[n] = { ...ch, createdAt: own(c, n)?.createdAt ?? now, updatedAt: now, rev: randomBytes(6).toString('hex') };
    return describe(n, c.channels[n]);
  });
}

export async function removeChannel(name) {
  const n = String(name ?? '').trim().toLowerCase();
  return update((c) => {
    if (!NAME_RE.test(n) || !own(c, n)) throw new ChannelError(`no channel ${String(name).slice(0, 40)}`, 404);
    delete c.channels[n];
    return { name: n, removed: true };
  });
}

/** What may be shown about a channel: never a webhook URL beyond its host and id tail, never a command's arguments. */
export function describe(name, ch) {
  let target = null;
  if (ch.kind === 'webhook') {
    try { const u = new URL(ch.url); const tail = u.pathname.split('/').filter(Boolean).at(-1)?.slice(-6) ?? ''; target = `${u.host}${tail ? ` …${tail}` : ''}`; } catch { target = '?'; }
  } else target = `${path.basename(ch.argv?.[0] ?? '?')} (${(ch.argv?.length ?? 1) - 1} arguments)`;
  return { name, kind: ch.kind, title: ch.title ?? null, ...(ch.kind === 'webhook' ? { format: ch.format } : {}), target, bots: ch.bots ?? null, updatedAt: ch.updatedAt ?? null };
}

export async function list() {
  const c = await load();
  return Object.entries(c.channels).sort(([a], [b]) => a.localeCompare(b)).map(([n, ch]) => describe(n, ch));
}

const allows = (ch, bot) => !ch.bots || ch.bots.includes(bot);
/** The channels the bot `name` may post to, as it sees them: name and title. */
export async function forBot(name) {
  const n = grok.botName(name);
  const c = await load();
  return Object.entries(c.channels).filter(([, ch]) => allows(ch, n)).sort(([a], [b]) => a.localeCompare(b)).map(([k, ch]) => ({ name: k, title: ch.title ?? k }));
}

// ---------------------------------------------------------------- sending
/** Slack reads <...> as mentions and links (<!channel> pings everyone): its three control characters are escaped. */
export const slackText = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The request body for a webhook channel's format. Discord gets no mentions at all (allowed_mentions). */
export function webhookBody(format, text, { bot, channel } = {}) {
  if (format === 'slack') return { type: 'application/json', body: JSON.stringify({ text: slackText(text) }) };
  if (format === 'discord') return { type: 'application/json', body: JSON.stringify({ content: text, allowed_mentions: { parse: [] } }) };
  if (format === 'text') return { type: 'text/plain; charset=utf-8', body: text };
  return { type: 'application/json', body: JSON.stringify({ source: 'drover', channel, bot: bot ? grok.idFor(bot) : null, text }) };
}

/** Network errors that stop a request before anything is sent: no such host, no route, the connection refused. */
const NEVER_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EHOSTDOWN', 'UND_ERR_CONNECT_TIMEOUT']);
const codeOf = (e) => { const c = String(e?.cause?.code ?? e?.code ?? ''); return /^[A-Z][A-Z0-9_]{2,40}$/.test(c) ? c : null; };

/** The URL Drover posts to: a Discord webhook waits for the message to be saved (wait=true), else its 2xx proves nothing. */
function postUrl(ch) {
  if (ch.format !== 'discord') return ch.url;
  const u = new URL(ch.url); u.searchParams.set('wait', 'true'); return u.toString();
}

/**
 * POST a webhook channel. A redirect is not followed: the post goes where the owner set it up, or nowhere. error is
 * Drover's words; detail is the webhook's own answer, for the owner's test only. A request that broke after it may
 * have reached the webhook (a timeout, a reset) is unknown, not failed.
 */
async function postWebhook(ch, text, meta) {
  const { type, body } = webhookBody(ch.format, text, meta);
  let res;
  try { res = await _deps.fetch(postUrl(ch), { method: 'POST', headers: { 'content-type': type, 'user-agent': 'drover-channels/1' }, body, redirect: 'manual', signal: AbortSignal.timeout(_deps.timeoutMs) }); }
  catch (e) {
    const code = codeOf(e);
    if (code && NEVER_SENT.has(code)) return { ok: false, error: `the channel's webhook is unreachable (${code})` };
    const late = e?.name === 'TimeoutError' || e?.cause?.name === 'TimeoutError';
    return { ok: null, unknown: true, error: late ? "the channel's webhook did not answer in time" : `the connection to the channel's webhook broke (${code ?? 'no answer'})` };
  }
  if (res.ok && res.status !== 202) { await res.arrayBuffer().catch(() => null); return { ok: true, status: res.status }; }
  const said = oneLine(await res.text().catch(() => ''), 200), detail = said ? { detail: said } : {};
  // 202 only accepted it for later; 408 and 5xx (often a proxy in front of the service) may come after it was posted.
  if (res.status === 202) return { ok: null, unknown: true, status: 202, error: "the channel's webhook only accepted it for later (HTTP 202)", ...detail };
  if (res.status >= 500 || res.status === 408) return { ok: null, unknown: true, status: res.status, error: `the channel's webhook answered HTTP ${res.status}`, ...detail };
  // 303 answers a request the server handled, by pointing elsewhere (302 too, as most frameworks send it after a POST):
  // not followed, so the post may be out. 301, 307 and 308 say the webhook is somewhere else: nothing was posted here.
  if (res.status === 302 || res.status === 303) return { ok: null, unknown: true, status: res.status, error: `the channel's webhook answered HTTP ${res.status}, a redirect Drover does not follow`, ...detail };
  return { ok: false, status: res.status, error: `the channel's webhook answered HTTP ${res.status}${res.status >= 300 && res.status < 400 ? ', a redirect Drover does not follow' : ''}`, ...detail };
}

/** Run a command channel: argv as configured, the {text} argument (or --name={text}'s value) the text, else the text on stdin. */
function runCommand(ch, text) {
  if (textHoleError(ch.argv)) return Promise.resolve({ ok: false, error: 'the channel puts the post inside a larger argument; set it up again with drover channels add' });
  const inArgs = ch.argv.slice(1).some((a) => TEXT_ARG.test(a));
  const args = ch.argv.slice(1).map((a) => (TEXT_ARG.test(a) ? a.slice(0, -'{text}'.length) + text : a));
  return new Promise((resolve) => {
    const child = _deps.execFile(ch.argv[0], args, { timeout: _deps.commandTimeoutMs, maxBuffer: 256 * 1024, windowsHide: true }, (err, _stdout, stderr) => {
      if (!err) return resolve({ ok: true });
      // Drover's words: an exit code, a signal or a Node error code, never what the program printed (detail).
      const prog = path.basename(ch.argv[0]), said = oneLine(stderr, 200), detail = said ? { detail: said } : {};
      // It never started (not installed, not runnable): nothing was sent.
      if (typeof err.code === 'string' && String(err.syscall ?? '').startsWith('spawn')) return resolve({ ok: false, error: `${prog} ${err.code === 'ENOENT' ? 'is not installed here' : `could not start (${err.code.replace(/[^A-Z0-9_]/g, '').slice(0, 40)})`}`, ...detail });
      // It ran: whatever it did before it failed or was stopped, the post may be out.
      const why = err.killed || err.signal === 'SIGTERM' ? 'timed out' : Number.isInteger(err.code) ? `exited ${err.code}` : `stopped (${String(err.signal ?? err.code ?? 'unknown').replace(/[^A-Za-z0-9_]/g, '').slice(0, 40)})`;
      resolve({ ok: null, unknown: true, error: `${prog} ${why}`, ...detail });
    });
    child.stdin?.on('error', () => { /* a program that does not read stdin */ });
    child.stdin?.end(inArgs ? '' : text);
  });
}

/**
 * Send text to a channel. { ok: true } sent; { ok: false, error } not sent; { ok: null, unknown: true, error } it may
 * have been. error is Drover's words, never the URL; detail is the channel's own. meta.rev: the version of the channel
 * the post was approved for (any other version sends nothing).
 */
export async function send(name, text, meta = {}) {
  const ch = own(await load(), name);
  if (!ch) return { ok: false, error: `the channel ${name} no longer exists` };
  if (meta.bot && !allows(ch, meta.bot)) return { ok: false, error: `the channel ${name} no longer takes posts from ${meta.bot}` };
  if (meta.rev !== undefined && (ch.rev ?? null) !== meta.rev) return { ok: false, error: `the channel ${name} was changed after the request (where it leads or its title), so nothing was sent there` };
  return ch.kind === 'webhook' ? postWebhook(ch, text, { ...meta, channel: name }) : runCommand(ch, text);
}

/** The owner's check that a channel works: a short test post. Its answer goes to the owner only, detail included. */
export async function test(name) {
  const n = String(name ?? '').trim().toLowerCase();
  if (!own(await load(), n)) throw new ChannelError(`no channel ${String(name).slice(0, 40)}`, 404);
  return send(n, `Drover: a test post from ${eventsMod.shortHost()}. This channel works.`);
}

// ---------------------------------------------------------------- a bot posts
/** Whose bot it is, as the people in a channel read it: "Cole's bot" (a name), "the owner's bot" (none configured). */
export const ownerWord = /^the /i.test(OWNER_NAME) ? OWNER_NAME : OWNER_NAME.charAt(0).toUpperCase() + OWNER_NAME.slice(1);
/**
 * Characters no one sees are not what the owner saw: every default-ignorable code point (bidi controls, zero-width
 * marks, fillers, the tag characters that spell out hidden text, variation selectors that hide bytes) goes, so a reader
 * that is a model (another bot in the channel) reads only what the owner did. Emoji keep their joiner (U+200D) between
 * two emoji and one presentation selector (U+FE0E, U+FE0F) right after an emoji; anywhere else those go too.
 */
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/u, PICTO = /\p{Extended_Pictographic}/u, JOINS_AFTER = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F]/u, KEYCAP = /^[0-9#*]$/;
export function seenOnly(s) {
  const cps = [...String(s)];
  let out = '', last = '';
  for (let i = 0; i < cps.length; i++) {
    const c = cps[i];
    const keep = !IGNORABLE.test(c)
      // A selector right after a pictographic emoji, or inside a keycap (1, #, * then U+20E3); after plain text it goes.
      || ((c === '\uFE0F' || c === '\uFE0E') && ((PICTO.test(last) && !IGNORABLE.test(last)) || (KEYCAP.test(last) && cps[i + 1] === '\u20E3')))
      || (c === '\u200D' && JOINS_AFTER.test(last) && PICTO.test(cps[i + 1] ?? ''));
    if (keep) { out += c; last = c; }
  }
  return out;
}
/** The text a post sends: the bot's words, cleaned, behind its name (the people reading know a bot speaks). */
export const postText = (bot, text) => approvals.paragraphs(`${grok.display(bot)} (${ownerWord}'s bot): ${seenOnly(text)}`, TEXT_MAX + 80);

/**
 * The bot `name` asks to post text to a channel: an approval request of kind post, its question naming the channel and
 * quoting the text, its details exactly the text that will be sent. Returns approvals.request's { item, created }.
 */
export async function requestPost(name, { channel, text, messageId, expiresInMinutes } = {}, { mayAlert } = {}) {
  const n = grok.botName(name);
  const ch = String(channel ?? '').trim().toLowerCase();
  const c = await load();
  const conf = NAME_RE.test(ch) ? own(c, ch) : null;
  if (!conf || !allows(conf, n)) throw new Error(`no channel ${String(channel).slice(0, 40)} for you (drover_whoami lists yours)`);
  if (typeof text !== 'string' || !text.trim()) throw new Error('text is required: exactly what to post');
  if (text.length > TEXT_MAX) throw new Error(`text must be at most ${TEXT_MAX} characters`);
  const exact = postText(n, text);
  // Where it goes as the owner set it up: the title, and the name, which is what tells two channels apart.
  const where = conf.title && conf.title.toLowerCase() !== ch ? `${conf.title} (${ch})` : ch;
  const quote = exact.replace(/\s+/g, ' ');
  const room = approvals.QUESTION_MAX - `Post to ${where}: ""`.length;
  return approvals.request(n, {
    question: `Post to ${where}: "${quote.length > room ? `${quote.slice(0, room - 1)}…` : quote}"`, options: OPTIONS, details: exact, kind: 'post', messageId, expiresInMinutes,
  }, { mayAlert, action: { type: 'post', channel: ch, rev: conf.rev ?? null } });
}

// The action an approved post runs (approvals.js answer, option 1): the request's details are what the owner saw.
// Only Drover's words come back (error, never detail): the outcome is recorded as the owner's and told to the bot.
approvals.actions.set('post', async (item) => {
  const r = await send(item.action.channel, item.details, { bot: item.bot, rev: item.action.rev ?? null });
  if (r.ok === true) return { ok: true, done: `posted to ${item.action.channel}` };
  return r.unknown ? { ok: null, unknown: true, error: r.error } : { ok: false, error: r.error };
});
