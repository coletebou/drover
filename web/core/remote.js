// Remote hosts: run `drover rpc` on the other machine over ssh and speak
// newline JSON {id, op, args} -> {id, ok, result|error}. No ports opened.
import { spawn } from 'node:child_process';
import { assertKnownHost, sshArgv, LOCAL } from './hosts.js';
import * as plugins from './plugins.js';
import { envvar } from './envvars.js';
import { UPDATE_HINT } from './util.js';
import { redactEnvText } from './redact.js';

// DROVER_REMOTE_BIN pins the remote binary. By default run ~/.local/bin/drover,
// falling back to ~/.local/bin/apxw on a box that has not picked up the rename
// yet (that name is removed on 2026-11-15). The body goes inside single quotes
// below, so it must not contain one.
const REMOTE_BIN = envvar('REMOTE_BIN');
export const REMOTE_RPC = REMOTE_BIN
  ? `exec ${REMOTE_BIN} rpc`
  : 'D="$HOME/.local/bin/drover"; [ -x "$D" ] || D="$HOME/.local/bin/apxw"; exec "$D" rpc';
export const _deps = { spawn, now: () => Date.now() };

const RETIRE_KILL_MS = 150_000;   // longer than the longest op timeout (launch and the docker verbs: 120 s, api.js hostTimeoutMs)
const IDLE_MS = 10 * 60_000;

/** A retired child gets its EOF once it owes nothing, so it exits after its last reply has arrived here. */
function endIfDrained(c) { if (c.droverRetired && c.droverPending.size === 0) { try { c.stdin.end(); } catch { /* closed */ } } }

/**
 * One `ssh <host> drover rpc` child at a time. Each child carries its own pending calls and line buffer,
 * so a retired child (see retire()) can finish what it was asked while a fresh one takes new calls.
 */
class RemotePeer {
  constructor(host, { argv = null } = {}) { this.host = host; this.argv = argv; this.child = null; this.retired = new Set(); this.nextId = 1; this.lastUsed = Date.now(); }
  /** Calls in flight on this peer, retired children included (the idle reaper checks this). */
  get inFlight() { let n = this.child?.droverPending.size ?? 0; for (const c of this.retired) n += c.droverPending.size; return n; }
  start() {
    if (this.child) return;
    // ssh concatenates its argv with spaces and the remote login shell re-parses
    // the result, so the -c body must carry its own single quotes or `exec` runs
    // with no command (exit 0, no output). REMOTE_RPC is fixed text, never user input.
    // A custom argv (a host provider's rpcArgv, core/plugins.js) is built with the same rule.
    const argv = this.argv ?? sshArgv(this.host, ['bash', '-lc', `'${REMOTE_RPC}'`]);
    const child = _deps.spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
    child.droverPending = new Map(); child.droverBuf = ''; child.droverStderr = '';
    this.child = child;
    child.stdout.setEncoding('utf8').on('data', (d) => {
      child.droverBuf += d; let i;
      while ((i = child.droverBuf.indexOf('\n')) >= 0) {
        const line = child.droverBuf.slice(0, i); child.droverBuf = child.droverBuf.slice(i + 1);
        if (!line.trim()) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        const p = child.droverPending.get(msg.id); if (!p) continue;
        // Redacted here too, not only where the error was made: a host on an older build sends its command errors
        // with the environment values in them (core/proc.js ProcError).
        msg.ok ? p.resolve(msg.result) : p.reject(Object.assign(new Error(redactEnvText(msg.error ?? 'remote error')), { remote: true, host: this.host }));
      }
    });
    // Its last 4000 characters; once cut, its first line is incomplete (see the relay below).
    const note = (t) => { const all = child.droverStderr + t; if (all.length > 4000) child.droverStderrCut = true; child.droverStderr = all.slice(-4000); };
    // A remote that dies between our write and its exit makes stdin emit EPIPE;
    // without a listener that is an uncaught 'error' and takes the daemon down.
    child.stdin.on?.('error', (e) => note(`\nstdin: ${e.code ?? e.message}`));
    child.on('error', (e) => note(`\nspawn: ${e.message}`));
    child.stderr.setEncoding('utf8').on('data', (d) => note(d));
    child.on('close', (code) => {
      clearTimeout(child.droverKillTimer);
      this.retired.delete(child);
      // Redacted whole, then cut to its last line: an assignment on an earlier line says what to scrub from that one.
      // Once the kept part was cut, its first line is incomplete and is not relayed at all: what began it (a name, the
      // scheme of a "Bearer <token>") can be gone, and nothing then says that what follows is a secret.
      const redacted = redactEnvText(child.droverStderr);
      const whole = child.droverStderrCut ? redacted.slice(redacted.indexOf('\n') + 1 || redacted.length) : redacted;
      const last = whole.trim().split('\n').filter(Boolean).at(-1);
      const why = last || (child.droverStderrCut ? 'its stderr ended in a line too long to relay' : code === 0 ? `remote drover produced no reply (is Drover installed and current on that host? to update it: ${UPDATE_HINT})` : code === 255 ? 'ssh could not connect' : 'no stderr');
      const err = new Error(`ssh ${this.host} drover rpc exited ${code}: ${why}`);
      for (const [, p] of child.droverPending) p.reject(err);
      child.droverPending.clear();
      if (this.child === child) this.child = null;
    });
  }
  call(op, args = {}, { timeoutMs = 60_000 } = {}) {
    this.start(); this.lastUsed = Date.now();
    const child = this.child;
    const pend = child.droverPending;
    const id = this.nextId++;
    const p = new Promise((resolve, reject) => {
      // Every way a call ends (reply, timeout, write failure, close) goes through settle, which is
      // what lets a retired child get its EOF right after the last thing it owed.
      let timer = null;
      const settle = (fn) => (v) => { clearTimeout(timer); pend.delete(id); fn(v); endIfDrained(child); };
      timer = setTimeout(() => settle(reject)(new Error(`${this.host}: ${op} timed out`)), timeoutMs);
      pend.set(id, { resolve: settle(resolve), reject: settle(reject) });
    });
    if (!child.stdin || child.stdin.writable === false) { pend.get(id)?.reject(new Error(`ssh ${this.host} drover rpc is not running`)); return p; }
    child.stdin.write(JSON.stringify({ id, op, args }) + '\n', (err) => { if (err) pend.get(id)?.reject(new Error(`ssh ${this.host}: write failed (${err.code ?? err.message})`)); });
    return p;
  }
  /**
   * Take the current child out of service without cancelling anything: new calls start a fresh child,
   * while this one answers the calls already sent to it (some may be mutating and already applied).
   * Its stdin is ended only once it owes nothing (endIfDrained): the child being retired is always an
   * older build (that is why it answered "unknown op"), and `drover rpc` before 2026-10-15 exits on EOF
   * without flushing stdout, cutting short any large reply still on its way. A child that hangs is
   * killed after RETIRE_KILL_MS, failing whatever it still owes.
   */
  retire() {
    const c = this.child;
    if (!c) return;
    this.child = null;
    this.retired.add(c);
    c.droverRetired = true;
    endIfDrained(c);
    c.droverKillTimer = setTimeout(() => { try { c.kill('SIGTERM'); } catch { /* gone */ } }, RETIRE_KILL_MS);
    c.droverKillTimer.unref?.();
  }
  /**
   * Stop for good (stopAll, idle reaping): the current child and any retired one still draining, so
   * none outlives the process. Each child's close fails what it still had in flight.
   */
  stop() {
    for (const c of [this.child, ...this.retired]) {
      if (!c) continue;
      clearTimeout(c.droverKillTimer);
      try { c.stdin.end(); } catch { /* closed */ }
      try { c.kill('SIGTERM'); } catch { /* gone */ }
    }
    this.child = null; this.retired.clear();
  }
}

const peers = new Map();

export async function peer(host) {
  const h = await assertKnownHost(host);
  if (h === LOCAL) return null;
  if (!peers.has(h)) {
    // A provider's host has no ssh alias: its provider gives the argv of a child that runs `drover rpc` there (core/plugins.js
    // hostProvider rpcArgv). Same newline-JSON protocol.
    const provider = plugins.hostProvider(h);
    const custom = provider ? await provider.rpcArgv(h) : null;
    peers.set(h, new RemotePeer(h, custom ? { argv: custom.argv } : {}));
  }
  return peers.get(h);
}

/**
 * Call an op on a host; local when host is empty/'local'. `local` is the local dispatcher.
 *
 * A peer started before that host pulled new Drover code keeps running the old op table, and the board's
 * warmers use it every 20 s, so it never idles out: after a rollout, new ops answer "unknown op"
 * (seen 2026-10-15 with search.semantic). That answer means version skew, so the peer is restarted
 * (a fresh `drover rpc` with the host's current code) and the call retried, at most once per
 * RESTART_GAP_MS per host so a host that really runs old code is not respawned on every call.
 */
const RESTART_GAP_MS = 10 * 60_000;
const lastSkewRestart = new Map();
export async function callOn(host, op, args, local, opts) {
  const p = await peer(host);
  if (!p) return local(op, args);
  try { return await p.call(op, args, opts); }
  catch (e) {
    const now = _deps.now();
    if (!e?.remote || !/^unknown op /.test(e.message) || now - (lastSkewRestart.get(p.host) ?? -Infinity) < RESTART_GAP_MS) throw e;
    lastSkewRestart.set(p.host, now);
    // Retire, not stop: calls already in flight on the stale child (the board's own, possibly mutating
    // ones) finish there instead of being cancelled; only new calls go to the fresh child.
    p.retire();
    return p.call(op, args, opts);
  }
}

export function stopAll() { for (const p of peers.values()) p.stop(); peers.clear(); }

/** Drop idle ssh connections after a while so we are not holding 20 ssh sessions forever. */
export function reapIdle(now = Date.now()) {
  for (const [h, p] of peers) if (p.child && now - p.lastUsed > IDLE_MS && p.inFlight === 0) { p.stop(); peers.delete(h); }
}
setInterval(() => reapIdle(), 60_000).unref();
