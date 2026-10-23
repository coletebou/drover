// The daemon over HTTP: ops (POST /api/op/<op>), the SSE stream (GET /api/stream?topics=...) and transcript follows
// (POST /api/follow). The URL comes from <state>/daemon.json unless --url names one; the bearer token from
// <state>/token goes only into the Authorization header, never into a URL, an error message or the screen.
// node:http rather than fetch: a blocking manager reply on a daemon that predates async replies takes minutes,
// past fetch's five minute header timeout.
import http from 'node:http';
import https from 'node:https';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createSseParser } from './sse.js';

export class OpError extends Error {
  constructor(message, { status, op } = {}) { super(message); this.name = 'OpError'; this.status = status ?? null; this.op = op ?? null; this.unknownOp = /unknown op/i.test(message); }
}

// Op names are dot-separated words, as the daemon's routes take them (core/daemon-client.js OP_NAME).
const OP_NAME = /^[a-zA-Z]+(?:\.[a-zA-Z]+)*$/;

/** Where the daemon is and its token. Throws a sentence the user can act on when either is missing. */
export function daemonTarget({ url, stateDir }) {
  let base = url;
  if (!base) {
    const f = path.join(stateDir, 'daemon.json');
    if (!existsSync(f)) throw new Error(`Drover is not running (no ${f}). Start it with: drover serve`);
    try { base = JSON.parse(readFileSync(f, 'utf8')).url; } catch (e) { throw new Error(`cannot read ${f}: ${e.message}`); }
    if (!base) throw new Error(`${f} names no url`);
  }
  let u; try { u = new URL(base.endsWith('/') ? base : `${base}/`); } catch { throw new Error(`not a URL: ${base}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`not an http(s) URL: ${base}`);
  const tokenFile = path.join(stateDir, 'token');
  if (!existsSync(tokenFile)) throw new Error(`no token at ${tokenFile} (the daemon writes it on its first start)`);
  const token = readFileSync(tokenFile, 'utf8').trim();
  if (!token) throw new Error(`${tokenFile} is empty`);
  return { url: u, token };
}

export class Client {
  constructor({ url, token }) {
    this.base = url; this.token = token;
    this.mod = url.protocol === 'https:' ? https : http;
    this.agent = new this.mod.Agent({ keepAlive: true, maxSockets: 12 });
  }

  /** One HTTP request; resolves { status, body } (body as text). */
  request(rel, { method = 'GET', body, timeoutMs = 30_000 } = {}) {
    return new Promise((resolve, reject) => {
      const headers = { authorization: `Bearer ${this.token}`, accept: 'application/json', 'user-agent': 'drover-tui/1' };
      if (body !== undefined) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(body); }
      const req = this.mod.request(new URL(rel, this.base), { method, headers, agent: this.agent }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }); });
        res.on('error', (e) => { clearTimeout(timer); reject(e); });
      });
      const timer = timeoutMs ? setTimeout(() => req.destroy(new Error(`no answer in ${Math.round(timeoutMs / 1000)} s`)), timeoutMs) : null;
      req.on('error', (e) => { clearTimeout(timer); reject(new OpError(e.code === 'ECONNREFUSED' ? `the daemon at ${this.base.host} is not answering` : e.message)); });
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  /** Run one op; resolves its result, throws OpError (unknownOp: true on a daemon that predates the op). */
  async call(op, args = {}, { timeoutMs = 30_000 } = {}) {
    if (!OP_NAME.test(op)) throw new OpError(`not an op name: ${String(op).slice(0, 60)}`, { op });
    const r = await this.request(`api/op/${op}`, { method: 'POST', body: JSON.stringify(args ?? {}), timeoutMs });
    let j = null; try { j = JSON.parse(r.body); } catch { /* not JSON */ }
    if (r.status === 401) throw new OpError('the daemon rejected the token (401)', { status: 401, op });
    if (r.status >= 400 || !j || j.ok === false) throw new OpError(j?.error ?? `HTTP ${r.status}`, { status: r.status, op });
    return j.result;
  }

  /** What the daemon says about itself (GET /api/ops): { ops, owner, plugins }; null when it does not answer that. */
  async serverInfo({ timeoutMs = 5000 } = {}) {
    try {
      const r = await this.request('api/ops', { timeoutMs });
      if (r.status !== 200) return null;
      const j = JSON.parse(r.body);
      return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
    } catch { return null; }
  }

  /** Ask the daemon to stream a Claude transcript's new turns as `turn` events (refcounted there). */
  async follow(id, on = true) {
    try { const r = await this.request('api/follow', { method: 'POST', body: JSON.stringify({ id, on }), timeoutMs: 10_000 }); return r.status < 300; }
    catch { return false; }
  }

  /**
   * The SSE stream, reconnecting with backoff. onEvent(type, rawData) gets the data unparsed (an old daemon sends
   * megabyte fleet events this client may not want). onState('open' | 'reconnecting' | 'unauthorized', detail).
   * A stream silent for 75 s (the daemon pings every 20) is presumed dead and reopened.
   */
  stream({ topics = [], onEvent, onState = () => {} }) {
    let closed = false, req = null, retryTimer = null, idle = null, delay = 1000;
    const rel = `api/stream${topics.length ? `?topics=${topics.map(encodeURIComponent).join(',')}` : ''}`;
    const retry = (why) => {
      if (closed || retryTimer) return;
      clearTimeout(idle); req?.destroy(); req = null;
      onState('reconnecting', why);
      retryTimer = setTimeout(() => { retryTimer = null; connect(); }, delay);
      delay = Math.min(delay * 2, 15_000);
    };
    const connect = () => {
      if (closed) return;
      const parser = createSseParser((type, data) => onEvent(type, data));
      const headers = { authorization: `Bearer ${this.token}`, accept: 'text/event-stream', 'user-agent': 'drover-tui/1' };
      req = this.mod.request(new URL(rel, this.base), { headers, agent: false }, (res) => {
        if (res.statusCode === 401) { closed = true; res.resume(); onState('unauthorized', 'the daemon rejected the token'); return; }
        if (res.statusCode !== 200) { res.resume(); retry(`HTTP ${res.statusCode}`); return; }
        delay = 1000; onState('open');
        const alive = () => { clearTimeout(idle); idle = setTimeout(() => retry('the stream went quiet'), 75_000); idle.unref?.(); };
        alive();
        res.setEncoding('utf8');
        res.on('data', (c) => { alive(); parser.feed(c); });
        res.on('end', () => retry('the daemon closed the stream'));
        res.on('error', (e) => retry(e.message));
      });
      req.on('error', (e) => retry(e.code === 'ECONNREFUSED' ? 'the daemon is not answering' : e.message));
      req.end();
    };
    connect();
    return { close() { closed = true; clearTimeout(retryTimer); clearTimeout(idle); req?.destroy(); } };
  }

  close() { this.agent.destroy(); }
}
