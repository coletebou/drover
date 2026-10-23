// `drover op` on the command line. A read runs in this process, live and uncached. A write goes to the daemon when one
// answers, so it is recorded once, there: search.reindex (and a plugin's daemon-side writes) hand themselves to the
// daemon anyway, and a CLI that recorded them too would log them twice. With no daemon, a write runs here and is recorded the same way. Actor
// cli unless the args name one. Tests: test/op-audit.test.js.
import { dispatchRecorded, isWrite } from './api.js';
import { daemonEndpoint, callDaemon } from './daemon-client.js';

export const _deps = { daemonEndpoint, callDaemon, dispatchRecorded };

/** Run one op for the CLI; its result, as dispatch returns it. */
export async function cliOp(op, args = {}) {
  const ep = isWrite(op) ? await _deps.daemonEndpoint() : null;
  if (!ep) return _deps.dispatchRecorded(op, args, { actor: 'cli' });
  // A daemon call that fails is not retried here: the write may already have run there.
  return _deps.callDaemon(ep, op, args.actor ? args : { ...args, actor: 'cli' }, { timeoutMs: 300_000 });
}
