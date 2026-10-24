// A stand-in OpenClaw gateway for tests and the dev world (test/devworld.js): loopback, bearer checked, the
// OpenAI-compatible /v1/chat/completions the manager adapter calls. stream: true answers with SSE chunks a few
// words at a time, the way the real gateway streams; a message starting "fail " gets a 500; "slow " streams over
// about 8 seconds. A conversation other than the owner's main one (user drover:<DROVER_OWNER>) is named in
// the reply. GET / answers 401 like the real gateway (core/openclaw.js alive() only needs an answer).
//   node test/fake-gateway.js [--port 18799] [--token dev]
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { OWNER } from '../core/owner.js';

const REPLIES = [
  'Two sessions are waiting on you: **demo-build** wants to run `npm test` (a permission prompt) and **demo-review** asked which fixtures to cover. demo-work is busy on the parser.',
  'Nothing finished since your last look. demo-idle stopped 20 minutes ago after pushing its branch.',
  'All machines answer. The local box is the only one with work in flight.',
];

/** Start it; resolves { port, close, requests } (requests: the bodies it got, newest last). replies: what it says, in turn. */
export async function startFakeGateway({ port = 0, token = 'dev', delayMs = 60, replies = REPLIES } = {}) {
  const requests = [];
  let n = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      if (req.url === '/' || req.url === '') { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"unauthorized"}'); return; }
      if (req.url !== '/v1/chat/completions' || req.method !== 'POST') { res.writeHead(404); res.end(); return; }
      if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'bad token' } })); return; }
      let j; try { j = JSON.parse(body); } catch { res.writeHead(400); res.end(); return; }
      requests.push(j);
      const text = String(j.messages?.at(-1)?.content ?? '');
      if (/^fail /i.test(text)) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'model overloaded' } })); return; }
      const reply = /^echo /i.test(text) ? text.slice(5) : `${replies[n++ % replies.length]}${j.user && j.user !== `drover:${OWNER}` ? `\n\n(conversation ${j.user})` : ''}`;
      if (!j.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ model: 'openclaw/default', choices: [{ message: { role: 'assistant', content: reply } }] })); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
      const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: 'chatcmpl_fake', object: 'chat.completion.chunk', model: 'openclaw/default', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      const words = reply.match(/\S+\s*/g) ?? [];
      const step = /^slow /i.test(text) ? Math.max(delayMs, Math.round(8000 / Math.max(1, words.length / 3))) : delayMs;
      res.write(chunk({ role: 'assistant' }));
      let i = 0;
      const tick = () => {
        if (res.destroyed) return;
        if (i < words.length) { res.write(chunk({ content: words.slice(i, i + 3).join('') })); i += 3; setTimeout(tick, step); return; }
        res.write(chunk({}, 'stop')); res.end('data: [DONE]\n\n');
      };
      setTimeout(tick, step * 3);   // the real gateway thinks for a moment before the first token
    });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { port: server.address().port, requests, close: () => new Promise((r) => server.close(r)) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
  const g = await startFakeGateway({ port: Number(arg('port', 18799)), token: arg('token', 'dev') });
  console.log(`fake OpenClaw gateway on http://127.0.0.1:${g.port} (token "${arg('token', 'dev')}")`);
}
