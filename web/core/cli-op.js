// `drover op` on the command line. A read runs in this process, live and uncached. A write goes to the daemon when one
// answers, so it is recorded once, there: search.reindex (and a plugin's daemon-side writes) hand themselves to the
// daemon anyway, and a CLI that recorded them too would log them twice. With no daemon, a write runs here and is recorded the same way. Actor
// cli unless the args name one. Tests: test/op-audit.test.js.
import { dispatchRecorded, isWrite } from './api.js';
import { daemonEndpoint, callDaemon } from './daemon-client.js';

export const _deps = { daemonEndpoint, callDaemon, dispatchRecorded };
// A search runs its remote sources (the brain) here, at the front (remote: true unless the args say otherwise), behind a
// work guard that also reads the checkout the command runs in (core/search/remote.js), whatever callerCwd the args name.
const CALLER_CWD = new Set(['search.semantic', 'search.fleet']);

// Reading a Grok bot's thread from the CLI reads the bot's replies to the CLI, never the owner's (read receipts,
// core/bots/grok.js): the reads and sessions.seen name the CLI whatever the args say (other sessions ignore it).
const SEEN_BY = new Set(['sessions.transcript', 'sessions.lastReply']);

/** Run one op for the CLI; its result, as dispatch returns it. */
export async function cliOp(op, args = {}) {
  if (CALLER_CWD.has(op)) args = { remote: true, ...args, callerCwd: process.cwd() };
  if (SEEN_BY.has(op)) args = { ...args, seenBy: 'cli' };
  if (op === 'sessions.seen') args = { ...args, actor: 'cli' };
  const ep = isWrite(op) ? await _deps.daemonEndpoint() : null;
  if (!ep) return _deps.dispatchRecorded(op, args, { actor: 'cli' });
  // A daemon call that fails is not retried here: the write may already have run there.
  return _deps.callDaemon(ep, op, args.actor ? args : { ...args, actor: 'cli' }, { timeoutMs: 300_000 });
}
