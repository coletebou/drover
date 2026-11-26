// The launch gate: an optional external admission command asked before this machine starts an agent. Off unless
// DROVER_LAUNCH_GATE names it, so nothing here runs on a machine without one. The contract (the other half of the host
// guard's, core/guard.js):
//
//   DROVER_LAUNCH_GATE      an absolute path to an executable, optionally followed by fixed arguments separated by
//                           spaces (split on whitespace, never run through a shell). Drover runs `<gate...> <class>`
//                           with the placement class (claude-session, codex-session, hermes-session, heavy-build, ...)
//                           as the last argument, and gives it 5 seconds.
//   its answer, first line  go                                  (exit 0)
//                           wait <seconds> <reason...>          ask again after that long
//                           elsewhere <host-or-dash> <reason..> start it on another machine (host is a hint, - for none)
//                           hold <reason...>                    not now (exit non-zero, typically 75)
//   fail open               an unset gate, a missing or unrunnable executable, a timeout, or an answer that is none of
//                           the four is `go`, with one line on stderr: a broken gate must never stop work.
//   DROVER_LAUNCH_GATE_MAX_WAIT  seconds one launch may spend waiting on wait and hold answers (default 90).
//
// admit() is the loop around the gate. It is pure over its seams (run, sleep, now, place) so test/launch-gate.test.js
// drives it with a real fake gate script and a fake placement; core/api.js wires the real ones around launch.start.
import { runCapped } from './proc.js';
import { envvar } from './envvars.js';

export const GATE_TIMEOUT_MS = 5000;
export const DEFAULT_MAX_WAIT_S = 90;
const HOLD_POLL_MS = 10_000;     // how often a hold looks for another machine again
const MAX_WAIT_ANSWER_S = 3600;  // a gate asking for more than this is clamped (the budget cuts it much sooner)

/** The gate argv from DROVER_LAUNCH_GATE: [absolute path, ...fixed args], or null when unset or not an absolute path. */
export function gateArgv(env = process.env) {
  const raw = String(envvar('LAUNCH_GATE', env) ?? '').trim();
  if (!raw) return null;
  const argv = raw.split(/\s+/);
  return argv[0].startsWith('/') ? argv : null;
}

/** Seconds one launch may wait on its gate: DROVER_LAUNCH_GATE_MAX_WAIT, else 90 (a number of 0 or more; anything else is the default). */
export function maxWaitSeconds(env = process.env) {
  const raw = envvar('LAUNCH_GATE_MAX_WAIT', env);
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_MAX_WAIT_S;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MAX_WAIT_S;
}

/** The placement class a launch is judged as: its own placement, else the engine's session class (what host "auto" uses). */
export function launchClassName(args = {}) {
  return args.placement || ({ codex: 'codex-session', hermes: 'hermes-session', cursor: 'cursor-session' })[args.engine] || 'claude-session';
}

/** The gate's stdout -> { decision: 'go' } | { decision: 'wait', seconds, reason } | { decision: 'elsewhere', host, reason } | { decision: 'hold', reason }, or null when it is none of them. */
export function parseGate(stdout) {
  const line = String(stdout ?? '').split('\n').find((l) => l.trim()) ?? '';
  const [word, ...rest] = line.trim().split(/\s+/);
  if (word === 'go') return { decision: 'go' };
  if (word === 'wait') {
    const seconds = Number(rest[0]);
    return Number.isFinite(seconds) && seconds > 0 ? { decision: 'wait', seconds: Math.min(seconds, MAX_WAIT_ANSWER_S), reason: rest.slice(1).join(' ') } : null;
  }
  if (word === 'elsewhere') return rest.length ? { decision: 'elsewhere', host: rest[0] === '-' ? null : rest[0], reason: rest.slice(1).join(' ') } : null;
  if (word === 'hold') return { decision: 'hold', reason: rest.join(' ') };
  return null;
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const warnLine = (msg) => process.stderr.write(`drover: launch gate ${msg}; going ahead\n`);

/** Ask the gate once. Never throws: every failure is { decision: 'go', failedOpen: <why> } after one stderr line. */
export async function askGate(className, { argv, run = runCapped, warn = warnLine } = {}) {
  const failOpen = (why) => { warn(why); return { decision: 'go', failedOpen: why }; };
  try {
    const r = await run(argv[0], [...argv.slice(1), className], { timeoutMs: GATE_TIMEOUT_MS, maxBytes: 16 << 10, maxStderr: 4 << 10 });
    if (r.timedOut) return failOpen(`timed out after ${GATE_TIMEOUT_MS / 1000} s`);
    return parseGate(r.stdout) ?? failOpen(`answered nothing it understands (${JSON.stringify(String(r.stdout ?? '').slice(0, 60))}, exit ${r.code})`);
  } catch (e) { return failOpen(`could not run (${String(e?.message ?? e).slice(0, 120)})`); }
}

/**
 * The loop around the gate for one local launch. Resolves { proceed: true, gate? } to start here (gate says what was
 * decided; absent when no gate is configured or force skipped it with nothing to report), or { proceed: false, place,
 * gate } when the launch should go to place.host (a fleet.place answer that excluded this machine). Throws, with nothing
 * started, when the gate says elsewhere and no other machine is eligible, or says hold for the whole budget.
 *   wait    sleeps min(seconds, what is left of the budget) and asks again; with the budget spent the launch goes ahead.
 *   elsewhere / hold   place({ exclude: ['local'], prefer }) names another machine, if one is eligible, and the launch
 *           moves there. With none, elsewhere is refused at once; hold keeps asking (and looking) until the budget is spent.
 */
export async function admit({ className, force = false, env = process.env, place, run = runCapped, sleep = sleepMs, now = Date.now, warn = warnLine }) {
  const argv = gateArgv(env);
  if (!argv) {
    if (String(envvar('LAUNCH_GATE', env) ?? '').trim()) warn('is not an absolute path');
    return { proceed: true };
  }
  if (force === true || force === 'true') return { proceed: true, gate: { decision: 'skipped', reason: 'force' } };
  const budgetMs = maxWaitSeconds(env) * 1000, t0 = now();
  const waitedS = () => Math.round((now() - t0) / 1000);
  const withWait = (g) => (waitedS() > 0 ? { ...g, waitedS: waitedS() } : g);
  for (;;) {
    const d = await askGate(className, { argv, run, warn });
    if (d.decision === 'go') return { proceed: true, gate: withWait({ decision: 'go', ...(d.failedOpen ? { failedOpen: d.failedOpen } : {}) }) };
    const left = budgetMs - (now() - t0);
    if (d.decision === 'wait') {
      if (left <= 0) return { proceed: true, gate: withWait({ decision: 'wait', reason: d.reason, expired: true }) };
      await sleep(Math.min(d.seconds * 1000, left));
      continue;
    }
    // elsewhere or hold: another machine, if one qualifies
    const p = await place({ exclude: ['local'], ...(d.decision === 'elsewhere' && d.host ? { prefer: d.host } : {}) }).catch((e) => ({ host: null, reason: `placement failed: ${e?.message ?? e}` }));
    if (p?.host && p.host !== 'local') return { proceed: false, place: p, gate: withWait({ decision: d.decision, reason: d.reason, movedTo: p.host }) };
    const refusal = () => new Error(`nothing was started: host guard says ${d.reason || d.decision}; no other eligible host (${p?.reason ?? 'none was judged'})`);
    if (d.decision === 'elsewhere' || left <= 0) throw refusal();
    await sleep(Math.min(HOLD_POLL_MS, left));
  }
}
