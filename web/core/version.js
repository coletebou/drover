// Which Drover code a machine runs. A daemon loads its code once, at start, so after its checkout is pulled it keeps
// running the old commit until it restarts (drover-sync --restart restarts it after an update). So does a front's ssh
// peer (`drover rpc`, core/remote.js): the board's warmers keep it in use, so it can run a host's old code for as long as
// that front runs, and ops the front sends that host run in it. `drover serve` records the commit it loaded in
// daemon.json, and the long-lived processes note theirs as they start (noteLoaded); hostVersion() reads them and the
// checkout's HEAD each time it is asked, so the answer holds across pulls and restarts.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { tryRun, pidAlive } from './proc.js';
import { stateDir } from './paths.js';

/** The Drover checkout this code was loaded from: the repository holding web/. */
export const CHECKOUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const _deps = { run: tryRun, stateDir, checkoutDir: () => CHECKOUT, pidAlive };

const COMMIT = /^[0-9a-f]{4,64}$/i;
const git = (args) => _deps.run('git', ['-C', _deps.checkoutDir(), ...args], { timeoutMs: 10_000 });

/** A commit argument as a string, or undefined when absent. Hex only, so it can never reach git as an option. */
export function commitArg(commit) {
  if (commit == null || commit === '') return undefined;
  if (!COMMIT.test(String(commit))) throw new Error('commit must be 4 to 64 hex digits');
  return String(commit);
}

/** HEAD of the Drover checkout now: { commit, branch } (branch null when detached), or null when it is not a git checkout. */
export async function checkoutHead() {
  const [head, ref] = await Promise.all([git(['rev-parse', '--verify', '-q', 'HEAD']), git(['symbolic-ref', '-q', '--short', 'HEAD'])]);
  const commit = head.code === 0 ? head.stdout.trim() : '';
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commit)) return null;
  return { commit, branch: (ref.code === 0 && ref.stdout.trim()) || null };
}

/**
 * This machine's daemon from its daemon.json: { pid, running, startedAt, commit, branch }, or null when there is none.
 * commit is null for a daemon that started before Drover recorded it.
 */
export async function daemonInfo() {
  let d;
  try { d = JSON.parse(await readFile(path.join(_deps.stateDir(), 'daemon.json'), 'utf8')); } catch { return null; }
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  const pid = Number.isInteger(d.pid) && d.pid > 0 ? d.pid : null;
  return { pid, running: pid !== null && _deps.pidAlive(pid), startedAt: d.startedAt ?? null,
    commit: typeof d.commit === 'string' && COMMIT.test(d.commit) ? d.commit : null, branch: typeof d.branch === 'string' ? d.branch : null };
}

// This process, when bin/drover noted it (serve, rpc, mcp): { kind, pid, startedAt, head } with head a promise of
// checkoutHead() as the process started.
let self = null;

/** Note the commit this process's code comes from, as it starts; resolves to that checkoutHead() (null: not a checkout). */
export function noteLoaded(kind) {
  self = { kind, pid: process.pid, startedAt: new Date().toISOString(), head: checkoutHead().catch(() => null) };
  return self.head;
}
export function _reset() { self = null; }

/** Is commit an ancestor of (or equal to) loaded, in this checkout? null when git cannot tell (that commit is not here). */
async function contains(commit, loaded) {
  if (!loaded) return null;
  // Exit 0: an ancestor, 1: not one; anything else (an unknown commit) means git cannot tell.
  const { code } = await git(['merge-base', '--is-ancestor', commit, loaded]);
  if (code === 0) return true;
  return code === 1 ? false : null;
}

/** host.version's state (see hostVersion). */
function stateOf(daemon, checkout) {
  if (!daemon?.running) return 'stopped';
  if (!daemon.commit || !checkout) return 'unknown';
  return daemon.commit === checkout.commit ? 'live' : 'restart';
}

/**
 * Which Drover code this machine runs (op host.version). loaded is the commit the running daemon's code comes from
 * (null with no daemon, or one from before Drover recorded it). state:
 *   live     the daemon runs what the checkout holds;
 *   restart  the checkout has moved since the daemon started: restarting it loads that;
 *   stopped  no daemon is running;
 *   unknown  the daemon started before Drover recorded its commit, or this is not a git checkout.
 * answeredBy is the process that answered, when it noted its start: for a host asked from another machine, that
 * machine's ssh peer here, which runs the ops it sends here (current false: it predates the checkout's HEAD).
 * With commit (hex, 4 to 64 digits), contains says whether that commit is in both the daemon's code and the answering
 * process's: false when either lacks it (a fix not live here yet); otherwise null when either is unknown or no daemon
 * runs (the sessions here then run ops in their own processes, from whenever each started); true when both have it.
 */
export async function hostVersion({ commit: wanted } = {}) {
  const commit = commitArg(wanted);
  const [checkout, daemon, mine] = await Promise.all([checkoutHead(), daemonInfo(), self?.head ?? null]);
  const loaded = daemon?.running ? daemon.commit : null;
  const out = { state: stateOf(daemon, checkout), loaded, checkout: checkout ? { path: _deps.checkoutDir(), ...checkout } : null, daemon };
  const answeredBy = self && { kind: self.kind, pid: self.pid, startedAt: self.startedAt, commit: mine?.commit ?? null };
  if (answeredBy) out.answeredBy = { ...answeredBy, current: answeredBy.commit && checkout ? answeredBy.commit === checkout.commit : null };
  if (commit) {
    // The answering process is the daemon itself when the daemon answered: one check, not two.
    const codes = [loaded, ...(answeredBy && answeredBy.pid !== daemon?.pid ? [answeredBy.commit] : [])];
    const found = await Promise.all(codes.map((c) => contains(commit, c)));
    out.contains = found.includes(false) ? false : found.includes(null) ? null : true;
  }
  return out;
}

/** One line for `drover status`: the code the daemon runs and, when the checkout has moved since, what to do. */
export function statusLine(v) {
  const short = (c) => c.slice(0, 7);
  const d = v.daemon;
  if (!d?.running) return null;
  if (!d.commit) return 'code unknown: this daemon started before Drover recorded its commit (restart it to record one)';
  const here = `code ${short(d.commit)}${d.branch ? ` (${d.branch})` : ''}`;
  if (v.state === 'restart') return `${here}; the checkout is now at ${short(v.checkout.commit)}: restart the daemon to load it`;
  return here;
}
