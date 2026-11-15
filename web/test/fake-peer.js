// A stand-in for `ssh <host> drover rpc` behind core/remote.js (its _deps.spawn): each spawned child reads the JSON
// lines written to its stdin and answers each request on its stdout, so the real peer code (framing, retirement,
// restarts, deadlines) runs against it. No process, no network; every value is made up.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

/**
 * Install the fake on `remote` (core/remote.js). `answer({ gen, host, op, args, req, child })` gives, per request:
 * - a result;
 * - 'ERR:<message>': the call fails with that message;
 * - { $stale: true, result }: a reply from an rpc whose host's checkout has moved past its code;
 * - { $reply }: that reply line as it is;
 * - { $exit, stderr }: the child writes stderr and exits with that code (ssh exits 255 when the host is down);
 * - a promise of any of these: the reply waits until it settles (one that never settles is never answered), and a
 *   rejection fails the call with its message.
 * `gen` counts the children spawned, from 0; `host` is the ssh target. `closeMs`: how long a child takes to close
 * once its stdin ends (false: it never closes by itself).
 * Returns the spawned children (each with .gen, .argv, .host, .requests, .stdinEnded, .killed); `.calls` lists every
 * request as { host, op, args }, in order.
 */
export function fakePeer(remote, answer, { closeMs = 10 } = {}) {
  const spawned = []; const calls = [];
  remote._deps.spawn = (file, argv = []) => {
    const c = new EventEmitter();
    c.stdout = new PassThrough(); c.stderr = new PassThrough();
    c.gen = spawned.length; c.argv = [file, ...argv]; c.host = argv[argv.indexOf('--') - 1]; c.requests = [];
    const send = (id, a) => {
      if (a?.$exit !== undefined) { c.stderr.write(a.stderr ?? ''); setImmediate(() => c.emit('close', a.$exit)); return; }
      c.stdout.write(JSON.stringify(replyLine(id, a)) + '\n');
    };
    c.stdin = {
      write(d, cb) {
        for (const line of String(d).split('\n').filter(Boolean)) {
          const req = JSON.parse(line); c.requests.push(req);
          calls.push({ host: c.host, op: req.op, args: req.args });
          setImmediate(() => Promise.resolve()
            .then(() => answer({ gen: c.gen, host: c.host, op: req.op, args: req.args, req, child: c }))
            .then((a) => send(req.id, a), (e) => send(req.id, `ERR:${e.message}`)));
        }
        cb?.();
      },
      end() { c.stdinEnded = true; if (closeMs !== false) setTimeout(() => c.emit('close', 0), closeMs); }, on() {},
    };
    c.kill = () => { c.killed = true; setImmediate(() => c.emit('close', null)); };
    spawned.push(c);
    return c;
  };
  spawned.calls = calls;
  return spawned;
}

function replyLine(id, a) {
  if (typeof a === 'string' && a.startsWith('ERR:')) return { id, ok: false, error: a.slice(4) };
  if (a?.$reply) return a.$reply;
  if (a?.$stale) return { id, ok: true, result: a.result, stale: true };
  return { id, ok: true, result: a };
}
