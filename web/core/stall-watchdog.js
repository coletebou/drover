// Stall watchdog: end the daemon when its event loop has stopped. launchd and systemd restart a daemon that exits, but
// not one that hangs, and a daemon whose memory was swapped out in a paging storm hung for minutes and then died anyway
// (2026-11): the supervisor only helped after the death. So the main thread bumps a counter in shared memory every
// second, and a worker thread, which runs even while the main loop is stuck, watches it. When the counter has not moved
// for DROVER_STALL_EXIT_SECONDS (default 180; 0 turns the watchdog off) the worker writes one line to stderr and kills
// the process, so the supervisor starts a fresh one.
//
// It kills with SIGKILL, not process.exit(): in a worker thread process.exit() ends the worker only and leaves the hung
// main thread running (checked on Node 26). The main thread cannot run a SIGTERM handler while it is stuck, so SIGKILL
// loses nothing a gentler signal would have saved; the supervisor sees a signal exit and restarts it all the same.
//
// A machine that slept does not stall: the monotonic clock stops during sleep and the wall clock does not, so a wall
// clock that ran far ahead of the monotonic one means a sleep, and the count restarts from there. stallStep() is the
// whole decision, pure, tested in test/stall-watchdog.test.js without waiting 180 seconds.
import { Worker, isMainThread, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { writeSync } from 'node:fs';
import { envvar } from './envvars.js';

export const DEFAULT_STALL_SECONDS = 180;
export const BEAT_MS = 1000;
const SLEEP_SLACK_MS = 5000;   // wall clock ahead of the monotonic one by more than this: the machine slept

/** DROVER_STALL_EXIT_SECONDS: seconds of no heartbeat before the daemon is ended (default 180; 0 or less turns it off). */
export function stallSeconds(env = process.env) {
  const raw = envvar('STALL_EXIT_SECONDS', env);
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_STALL_SECONDS;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, n) : DEFAULT_STALL_SECONDS;
}

/** The state before the first look: { count, changedAt, mono, wall } with the count unknown. */
export const stallStart = (mono, wall) => ({ count: null, changedAt: mono, mono, wall });

/**
 * One look at the heartbeat. state is the last look's (stallStart for the first), count the shared counter now, mono and
 * wall the monotonic and wall clocks in ms. Returns { state, stalled, slept }: stalled when the counter has stayed the
 * same for limitMs of monotonic time; a moved counter, or a sleep (wall time past monotonic by sleepSlackMs), restarts
 * the count and is never a stall.
 */
export function stallStep(state, { count, mono, wall }, { limitMs, sleepSlackMs = SLEEP_SLACK_MS }) {
  const slept = (wall - state.wall) - (mono - state.mono) > sleepSlackMs;
  if (count !== state.count || slept) return { state: { count, changedAt: mono, mono, wall }, stalled: false, slept };
  return { state: { ...state, mono, wall }, stalled: mono - state.changedAt >= limitMs, slept: false };
}

/**
 * The worker's loop: look every second, and end the process when stallStep says stalled. The line goes out with a
 * synchronous write to fd 2: a worker's process.stderr is relayed through the main thread, which is the stuck one.
 */
function watch({ shared, limitMs, kill = () => process.kill(process.pid, 'SIGKILL'), write = (t) => { try { writeSync(2, t); } catch { /* no stderr */ } } }) {
  const beat = new Int32Array(shared);
  let state = stallStart(performance.now(), Date.now());
  const timer = setInterval(() => {
    const r = stallStep(state, { count: Atomics.load(beat, 0), mono: performance.now(), wall: Date.now() }, { limitMs });
    state = r.state;
    if (!r.stalled) return;
    write(`drover: the event loop has not run for ${Math.round((state.mono - state.changedAt) / 1000)} s (limit ${Math.round(limitMs / 1000)} s); ending the daemon so its supervisor restarts it\n`);
    kill();
  }, BEAT_MS);
  return () => clearInterval(timer);
}

/**
 * Start the watchdog in the daemon: a heartbeat on the main thread and the watching worker. Returns a stop function (a
 * no-op when DROVER_STALL_EXIT_SECONDS is 0). Both timers and the worker are unref'd: they never keep the process alive.
 */
export function startStallWatchdog({ env = process.env } = {}) {
  const seconds = stallSeconds(env);
  if (!(seconds > 0) || !isMainThread) return () => {};
  const shared = new SharedArrayBuffer(4);
  const beat = new Int32Array(shared);
  const heart = setInterval(() => Atomics.add(beat, 0, 1), BEAT_MS);
  heart.unref();
  let worker = null;
  try {
    // execArgv: [] because a worker refuses some of its parent's flags (--input-type, for one) and needs none of them.
    worker = new Worker(new URL(import.meta.url), { execArgv: [], workerData: { droverStallWatchdog: true, shared, limitMs: seconds * 1000 } });
    worker.unref();
    worker.on('error', (e) => process.stderr.write(`drover: stall watchdog stopped: ${e?.message ?? e}\n`));
  } catch (e) { process.stderr.write(`drover: stall watchdog did not start: ${e?.message ?? e}\n`); }
  return () => { clearInterval(heart); worker?.terminate().catch(() => {}); };
}

if (!isMainThread && workerData?.droverStallWatchdog) watch(workerData);
