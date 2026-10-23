// A tiny synthetic stand-in for the Drover daemon (node:http only), for
// development and tests. Mirrors server/http.js auth, origin, SSE and pairing
// rules (core/pair.js). The fake tokens below are not secrets.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const FIX = new URL('../test/fixtures/', import.meta.url);
const fixture = async (name) => JSON.parse(await readFile(new URL(name, FIX), 'utf8'));

export const FAKE_TOKEN = 'test-token-not-secret';
export const FAKE_WIDGET_TOKEN = 'test-widget-token-not-secret';

function isLoopback(origin) {
  try { const h = new URL(origin).hostname; return h === 'localhost' || h === '127.0.0.1'; } catch { return false; }
}

export async function startFakeDaemon({ token = FAKE_TOKEN, port = 0, host = '127.0.0.1', allowOrigins = [], pairTtlMs = 120_000, pairPollMs = 1500, onPair = () => {}, summaryFixture = 'native-summary.json', streamMs = 20 } = {}) {
  const messages = [];
  const answers = [];
  const clients = new Set();
  let seq = 0;
  const pairs = new Map();   // requestId -> { requestId, code, client, device, expiresAt, state }
  const pairCalls = [];      // { method, path, authorization } for every /api/pair/request and /api/pair/status
  const live = (p) => p.expiresAt > Date.now();
  /** Approve or deny the pending request with this code, as drover pair approve|deny does. */
  const decide = (code, approve) => {
    const p = [...pairs.values()].find((x) => x.state === 'pending' && live(x) && x.code === String(code ?? '').replace(/[\s-]/g, ''));
    if (!p) return false;
    p.state = approve ? 'approved' : 'denied';
    if (approve) p.expiresAt = Math.max(p.expiresAt, Date.now() + 30_000);   // time to collect
    return true;
  };
  const json = (res, code, body, extra = {}) => {
    const s = JSON.stringify(body);
    res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s), ...extra });
    res.end(s);
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('invalid JSON body')); } });
    req.on('error', reject);
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const origin = req.headers.origin;
    let cors = {};
    if (origin) {
      if (!allowOrigins.includes(origin) && !isLoopback(origin)) return json(res, 403, { error: 'bad origin' });
      cors = { 'access-control-allow-origin': origin, vary: 'Origin', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-max-age': '600' };
    }
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    // Pairing needs no token to ask or to collect; approving and denying need it.
    if ((url.pathname === '/api/pair/request' && req.method === 'POST') || (url.pathname === '/api/pair/status' && req.method === 'GET')) {
      pairCalls.push({ method: req.method, path: url.pathname, authorization: req.headers.authorization ?? null });
    }
    if (url.pathname === '/api/pair/request' && req.method === 'POST') {
      const raw = await readBody(req).catch(() => ({}));
      const b = raw && typeof raw === 'object' ? raw : {};
      const bad = ['client', 'device'].find((k) => b[k] != null && (typeof b[k] !== 'string' || b[k].length > 64));
      if (bad || typeof b.client !== 'string' || !b.client.trim()) return json(res, 400, { error: `${bad ?? 'client'} is missing or too long` }, cors);
      if ([...pairs.values()].filter((p) => p.state === 'pending' && live(p)).length >= 5) {
        return json(res, 429, { error: 'too many pairing requests; approve or deny the pending ones, or wait for them to expire' }, cors);
      }
      const p = { requestId: randomBytes(16).toString('hex'), code: String(randomInt(0, 1_000_000)).padStart(6, '0'), client: b.client, device: b.device ?? '', expiresAt: Date.now() + pairTtlMs, state: 'pending' };
      pairs.set(p.requestId, p);
      onPair({ code: p.code, client: p.client, device: p.device });
      return json(res, 201, { requestId: p.requestId, code: p.code, expiresAt: new Date(p.expiresAt).toISOString(), pollMs: pairPollMs }, cors);
    }
    if (url.pathname === '/api/pair/status' && req.method === 'GET') {
      const p = pairs.get(url.searchParams.get('requestId') ?? '');
      if (!p || !live(p)) return json(res, 404, { status: 'expired' }, cors);
      if (p.state === 'pending') return json(res, 200, { status: 'pending', expiresAt: new Date(p.expiresAt).toISOString() }, cors);
      pairs.delete(p.requestId);   // answered once
      return json(res, 200, p.state === 'denied' ? { status: 'denied' } : { status: 'approved', token, widgetToken: FAKE_WIDGET_TOKEN }, cors);
    }
    const h = req.headers.authorization;
    if (!(h && h.startsWith('Bearer ') && h.slice(7) === token)) return json(res, 401, { error: 'unauthorized' }, cors);
    if ((url.pathname === '/api/pair/approve' || url.pathname === '/api/pair/deny') && req.method === 'POST') {
      const { code } = (await readBody(req).catch(() => null)) ?? {};
      const approve = url.pathname.endsWith('/approve');
      if (!decide(code, approve)) return json(res, 404, { ok: false, error: 'no pending pairing request with that code' }, cors);
      return json(res, 200, { ok: true, result: approve ? { approved: true } : { denied: true } }, cors);
    }

    if (url.pathname === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', ...cors });
      // ?topics=a,b: only those events (plus hello), as server/http.js does; hello echoes the topics.
      const raw = url.searchParams.get('topics');
      res.topics = raw ? new Set(raw.split(',').map((t) => t.trim()).filter(Boolean)) : null;
      res.write(`event: hello\ndata: ${JSON.stringify({ host: 'fake', ts: Date.now(), ...(res.topics ? { topics: [...res.topics] } : {}) })}\n\n`);
      clients.add(res);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 15_000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }

    const m = url.pathname.match(/^\/api\/op\/([a-zA-Z.]+)$/);
    if (!m || req.method !== 'POST') return json(res, 404, { error: 'no such route' }, cors);
    const op = m[1];
    try {
      const args = await readBody(req);
      let result;
      if (op === 'native.summary') result = await fixture(summaryFixture);
      else if (op === 'native.board') result = await fixture('native-board.json');
      else if (op === 'sessions.answer') {
        // Refused when the screen hash the client showed is not the one on screen, as core/tmux.js answer does.
        answers.push(args);
        const onScreen = (await fixture(summaryFixture)).waiting?.find((w) => w.id === args.id)?.hash ?? null;
        result = args.expect && onScreen && args.expect !== onScreen
          ? { ok: false, refused: true, reason: 'the screen changed since you read it; read it again', hash: onScreen }
          : { ok: true, key: args.key, target: 'demo:1', hash: onScreen };
      } else if (op === 'sessions.message' && args.id === 'manager' && args.wait === false) {
        // The async manager: answer at once, then stream the reply and settle it as a turn.
        messages.push(args);
        const event = `ev-${++seq}`, turnId = `t-${seq}`, thread = 'main';
        result = { ok: true, pending: true, event, turnId, thread };
        const reply = `You asked: ${String(args.text).slice(0, 80)}`;
        setTimeout(() => {
          broadcastEvent('turn', { id: 'manager', host: 'fake', thread, turn: { id: event, role: 'user', text: args.text, actor: args.actor ?? 'owner', thread } });
          broadcastEvent('manager', { host: 'fake', thread, turnId, inReplyTo: event, phase: 'start', text: '' });
          let sofar = '';
          const words = reply.split(' ');
          words.forEach((w, i) => setTimeout(() => {
            const delta = (i ? ' ' : '') + w;
            sofar += delta;
            broadcastEvent('manager', { host: 'fake', thread, turnId, inReplyTo: event, phase: 'delta', delta, text: sofar });
            if (i === words.length - 1) {
              broadcastEvent('manager', { host: 'fake', thread, turnId, inReplyTo: event, phase: 'done', text: reply });
              broadcastEvent('turn', { id: 'manager', host: 'fake', thread, turn: { id: `ev-${++seq}`, role: 'assistant', text: reply, inReplyTo: event, thread } });
            }
          }, streamMs * (i + 1)));
        }, streamMs);
      }
      else if (op === 'native.notifications') {
        const n = await fixture('native-notifications.json');
        result = args.since === n.cursor ? { cursor: n.cursor, items: [] } : n;
      } else if (op === 'sessions.transcript') result = await fixture('sessions-transcript.json');
      else if (op === 'sessions.message') { messages.push(args); result = { ok: true, queuedBehindTurn: false, event: 'ev-demo' }; }
      else return json(res, 400, { ok: false, error: `unknown op ${op}` }, cors);
      return json(res, 200, { ok: true, result, ms: 0 }, cors);
    } catch (e) {
      return json(res, 400, { ok: false, error: e.message }, cors);
    }
  });

  function broadcastEvent(event, data) {
    const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) { if (c.topics && !c.topics.has(event)) continue; try { c.write(line); } catch { /* closed */ } }
  }

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const actual = server.address().port;
  return {
    url: `http://${host}:${actual}`,
    port: actual,
    messages,
    answers,
    pairs,
    pairCalls,
    decide,
    broadcast: broadcastEvent,
    close() {
      for (const c of clients) { try { c.end(); } catch { /* ignore */ } }
      clients.clear();
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--port');
  const port = i > 0 ? Number(process.argv[i + 1]) : 7399;
  const url = `http://127.0.0.1:${port}`;
  const d = await startFakeDaemon({
    port,
    onPair: ({ code, client }) => console.log(`${client} asks to pair, code ${code}. Approve: curl -s -X POST -H 'authorization: Bearer ${FAKE_TOKEN}' -d '{"code":"${code}"}' ${url}/api/pair/approve`),
  });
  console.log(`fake daemon: ${d.url}`);
  console.log(`token: ${FAKE_TOKEN}`);
}
