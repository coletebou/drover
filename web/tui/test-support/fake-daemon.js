// A fake Drover daemon for the TUI's end-to-end tests: canned, synthetic op results, an SSE stream that honors
// ?topics=, a manager whose replies stream (start, deltas, done, turn events), and a record of every call. mode
// 'old' is a daemon from before the UX overhaul: no native.board, sessions.answer or threads, topics ignored, and
// manager replies returned by the call itself.
//   node web/tui/test-support/fake-daemon.js --state DIR [--port N] [--old]   (writes DIR/daemon.json and DIR/token)
import { createServer } from 'node:http';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const now = () => new Date().toISOString();
const ago = (s) => new Date(Date.now() - s * 1000).toISOString();

export const HASH = 'feedc0de12345678';
export const REPLY = 'Two sessions are waiting on you: demo-build wants to run the tests and demo-review asked about fixtures.';
export const CAPTURE = 'synthetic pane line one\nsynthetic pane line two\n$ npm test\n3 passing';
// The owner actor a current daemon names in GET /api/ops and records on the owner's own turns (core/owner.js OWNER).
export const OWNER_ACTOR = 'dana';

function board() {
  return {
    generatedAt: now(),
    hosts: [{ name: 'local', up: true, waiting: 1, working: 1, idle: 1 }, { name: 'box-a', up: false, waiting: 0, working: 0, idle: 0, error: 'ssh: connect timed out' }],
    strips: [
      { key: 'local|s-build', id: 's-build', name: 'demo-build', host: 'local', engine: 'claude', lane: 'wait', status: 'idle', kind: 'session', headline: 'Do you want to proceed?', screen: 'dialog', tmux: 'work:1', cwd: '~/code/demo', since: ago(90),
        ask: { kind: 'decision', label: 'needs a decision', text: 'Do you want to proceed?', options: [] }, answer: 'keys', hash: HASH, keys: ['1', '2', '3', 'Enter', 'Escape'],
        dialog: { question: 'Do you want to proceed?', options: [{ n: 1, label: 'Yes', selected: true }, { n: 2, label: "Yes, and don't ask again for npm test" }, { n: 3, label: 'No' }] }, tail: ['Bash(npm test)', 'Do you want to proceed?'] },
      { key: 'local|s-work', id: 's-work', name: 'demo-work', host: 'local', engine: 'claude', lane: 'work', status: 'busy', kind: 'session', headline: 'Compiling the parser', tmux: 'work:2', cwd: '~/code/demo', since: ago(40), tail: ['Compiling the parser'] },
      { key: 'local|s-idle', id: 's-idle', name: 'demo-idle', host: 'local', engine: 'codex', lane: 'idle', status: 'idle', kind: 'session', headline: 'Done.', since: ago(600) },
    ],
    totals: { waiting: 1, working: 1, idle: 1, hosts: 2 },
    manager: { up: true, host: 'local', lastNoteAt: ago(120) },
  };
}

/** The same world as fleet.summary, for the old mode (ui/lanes.js turns it into the same strips). */
function fleet() {
  return { ts: now(), hosts: [{ host: 'local', ok: true, sessions: [
    { id: 's-build', sessionId: 's-build', live: true, status: 'idle', engine: 'claude', name: 'demo-build', tmux: 'work:@1.%1', cwd: '/home/demo/code/demo', statusUpdatedAt: Date.now() - 90_000 },
    { id: 's-work', sessionId: 's-work', live: true, status: 'busy', engine: 'claude', name: 'demo-work', tmux: 'work:@2.%2', statusUpdatedAt: Date.now() - 40_000 },
  ], windows: [
    { target: 'work:1', session: 'work', windowId: '@1', name: 'demo-build', agent: { engine: 'claude', sessionId: 's-build', name: 'demo-build' }, screen: { state: 'dialog' }, dialog: { question: 'Do you want to proceed?', options: [{ n: 1, label: 'Yes', selected: true }, { n: 2, label: 'No' }] }, hash: HASH, tail: ['Do you want to proceed?'] },
    { target: 'work:2', session: 'work', windowId: '@2', name: 'demo-work', agent: { engine: 'claude', sessionId: 's-work', name: 'demo-work' }, screen: { state: 'busy' }, tail: ['Compiling'] },
  ] }] };
}

const SESSION_TURNS = [
  { role: 'user', ts: ago(300), uuid: 'u1', text: 'Make the demo parser keep line numbers in its errors.' },
  { role: 'assistant', ts: ago(290), uuid: 'a1', text: 'I will read the parser first.', tools: [] },
  { role: 'assistant', ts: ago(280), uuid: 'a2', text: '', tools: [{ id: 't1', name: 'Read', input: { file_path: '/home/demo/code/demo/src/parser.js' }, summary: '~/code/demo/src/parser.js' }] },
  { role: 'tool_result', ts: ago(279), uuid: 'r1', results: [{ toolUseId: 't1', isError: false, text: 'export function parse(text) {\n  return build(tokenize(text));\n}' }] },
  { role: 'assistant', ts: ago(270), uuid: 'a3', text: '', tools: [{ id: 't2', name: 'Bash', input: { command: 'npm test' }, summary: 'npm test' }] },
  { role: 'tool_result', ts: ago(269), uuid: 'r2', results: [{ toolUseId: 't2', isError: true, text: '1 failing: parser keeps line numbers' }] },
];

export async function startFakeDaemon({ token = 'test-token', mode = 'new', port = 0, replyDelayMs = 120 } = {}) {
  const calls = [], streams = [];
  const old = mode === 'old';
  const manager = { main: [] };
  let seq = 0;
  const emit = (type, data) => { for (const c of streams) if (!c.topics || c.topics.has(type)) c.res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); };
  const unknown = new Set(old ? ['native.board', 'sessions.answer', 'openclaw.threads'] : []);

  function managerMessage({ text, thread = 'main', wait }) {
    const th = old ? 'main' : thread;
    const id = `ev-${++seq}`;
    const user = { id, uuid: id, role: 'user', ts: now(), text, actor: old ? 'owner' : OWNER_ACTOR, thread: th };
    (manager[th] ??= []).push(user);
    const replyText = /^echo /.test(text) ? text.slice(5) : REPLY;
    const reply = { id: `chat-${seq}`, uuid: `chat-${seq}`, role: 'assistant', ts: now(), text: replyText, inReplyTo: id, thread: th, model: 'fake/manager' };
    if (old) return new Promise((resolve) => setTimeout(() => { manager[th].push(reply); resolve({ ok: true, reply: replyText, model: 'fake/manager', via: 'fake', event: id }); }, 400));
    emit('turn', { id: 'manager', host: 'fakehost', thread: th, turn: user });
    const note = { host: 'fakehost', thread: th, turnId: `pending:${id}`, inReplyTo: id };
    const words = replyText.split(/(?<= )/);
    let sofar = '';
    setTimeout(() => emit('manager', { ...note, phase: 'start', text: '' }), replyDelayMs);
    words.forEach((w, i) => setTimeout(() => { sofar += w; emit('manager', { ...note, phase: 'delta', delta: w, text: sofar }); }, replyDelayMs * (i + 2)));
    setTimeout(() => { manager[th].push(reply); emit('manager', { ...note, phase: 'done', text: replyText, id: reply.id }); emit('turn', { id: 'manager', host: 'fakehost', thread: th, turn: reply }); }, replyDelayMs * (words.length + 3));
    if (wait === false) return { ok: true, pending: true, event: id, turnId: `pending:${id}`, thread: th };
    return new Promise((resolve) => setTimeout(() => resolve({ ok: true, reply: replyText, event: id, thread: th }), replyDelayMs * (words.length + 4)));
  }

  const ops = {
    'native.board': () => board(),
    'fleet.summary': () => fleet(),
    'host.list': () => [{ name: 'local', display: 'fakehost', source: 'local' }, { name: 'box-a', display: 'box-a', source: 'fleet' }],
    'host.facts': () => ({ host: 'fakehost', ts: now(), uptime: 'up 3 days', node: 'v24', tmuxWindows: 3, identity: { DF_ROLE: 'test' } }),
    'sessions.list': () => ({ sessions: [
      { id: 's-build', sessionId: 's-build', kind: 'claude', engine: 'claude', name: 'demo-build', status: 'idle', live: true, tmux: 'work:@1.%1', cwd: '/home/demo/code/demo', statusUpdatedAt: Date.now() - 90_000 },
      { id: 's-work', sessionId: 's-work', kind: 'claude', engine: 'claude', name: 'demo-work', status: 'busy', live: true, tmux: 'work:@2.%2', cwd: '/home/demo/code/demo', statusUpdatedAt: Date.now() - 40_000 },
      { id: 'manager', kind: 'openclaw', engine: 'openclaw', name: 'manager', status: 'ready', live: true },
    ], codexError: null }),
    'sessions.get': ({ id }) => (id === 'manager' ? { id: 'manager', name: 'manager', engine: 'openclaw', live: true, status: 'ready' } : { id, sessionId: id, engine: 'claude', name: id === 's-work' ? 'demo-work' : 'demo-build', status: id === 's-work' ? 'busy' : 'idle', live: true, tmux: id === 's-work' ? 'work:@2.%2' : 'work:@1.%1', cwd: '/home/demo/code/demo' }),
    'sessions.transcript': ({ id, thread = 'main', since = 0 }) => {
      if (id === 'manager') { const turns = manager[old ? 'main' : thread] ?? []; return { engine: 'openclaw', thread, turns: since ? turns.slice(since) : turns, offset: turns.length }; }
      return { engine: 'claude', turns: since ? [] : SESSION_TURNS, offset: 4242, summary: { firstPrompt: SESSION_TURNS[0].text } };
    },
    'sessions.message': (a) => (a.id === 'manager' ? managerMessage(a) : { ok: true, via: 'inbox', queuedBehindTurn: false }),
    'sessions.answer': ({ id, key, expect }) => (expect && expect !== HASH ? { ok: false, refused: true, reason: 'the screen changed since you read it; read it again', hash: HASH } : { ok: true, key, target: 'work:@1', dialog: board().strips[0].dialog, hash: HASH, screen: { state: 'dialog' } }),
    'tmux.answer': ({ target, key, expect }) => (expect && expect !== HASH ? { ok: false, refused: true, reason: 'the screen changed since you read it; read it again', hash: HASH } : { ok: true, key, target, dialog: board().strips[0].dialog, hash: HASH }),
    'tmux.capture': ({ target }) => ({ target, text: CAPTURE, screen: { state: 'idle', reason: 'claude prompt footer visible' } }),
    'tmux.windows': () => fleet().hosts[0].windows.map((w) => ({ ...w, index: Number(w.target.split(':')[1]), cmd: 'claude', cwd: '/home/demo/code/demo', panes: 1, activityTs: Date.now() - 5000 })),
    'tmux.send': () => ({ ok: true }), 'tmux.keys': () => ({ ok: true }),
    'events.tail': () => [{ id: 'e1', ts: ago(60), host: 'fakehost', actor: 'owner', type: 'note', about: 'demo', text: 'a synthetic note' }],
    'openclaw.status': () => ({ configured: true, host: 'fakehost', actor: 'manager-test', unit: { active: 'active', uptimeSec: 7200 }, gateway: { up: true, url: 'http://127.0.0.1:1' }, health: { ok: true }, model: { primary: 'fake/manager' }, automations: {}, cost: { todayUsd: 0.12 }, wal24h: { notes: 3, pins: 1, chats: 2 } }),
    'openclaw.threads': () => Object.entries(manager).map(([thread, turns]) => ({ thread, turns: turns.length, lastTs: turns.at(-1)?.ts ?? null, lastText: turns.at(-1)?.text ?? '' })),
    'openclaw.sweep': () => ({ ok: true }),
  };

  const json = (res, code, body) => { const s = JSON.stringify(body); res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) }); res.end(s); };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const auth = req.headers.authorization === `Bearer ${token}` || url.searchParams.get('token') === token;
    if (!auth) return json(res, 401, { error: 'unauthorized' });
    // A daemon from before the owner was configuration names none.
    if (url.pathname === '/api/ops' && req.method === 'GET') return json(res, 200, { ops: Object.keys(ops), ...(old ? {} : { owner: OWNER_ACTOR }), plugins: [] });
    if (url.pathname === '/api/stream') {
      const raw = url.searchParams.get('topics');
      const topics = old || raw == null ? null : new Set(raw.split(','));
      calls.push({ op: 'stream', args: { topics: raw } });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      res.write(`event: hello\ndata: ${JSON.stringify({ host: 'fakehost', ts: Date.now(), ...(topics ? { topics: [...topics] } : {}) })}\n\n`);
      const c = { res, topics };
      streams.push(c);
      if (!topics || topics.has('board')) { if (!old) res.write(`event: board\ndata: ${JSON.stringify(board())}\n\n`); }
      if (old) res.write(`event: fleet\ndata: ${JSON.stringify(fleet())}\n\n`);
      req.on('close', () => { const i = streams.indexOf(c); if (i >= 0) streams.splice(i, 1); });
      return;
    }
    let body = '';
    req.on('data', (ch) => { body += ch; });
    req.on('end', async () => {
      let args = {}; try { args = body ? JSON.parse(body) : {}; } catch { return json(res, 400, { ok: false, error: 'invalid JSON body' }); }
      if (url.pathname === '/api/follow') { calls.push({ op: 'follow', args }); return json(res, 200, { ok: true }); }
      const m = url.pathname.match(/^\/api\/op\/([a-zA-Z.]+)$/);
      if (!m) return json(res, 404, { error: 'no such route' });
      const op = m[1];
      calls.push({ op, args, at: Date.now() });
      if (unknown.has(op) || !ops[op]) return json(res, 400, { ok: false, error: `unknown op ${op}` });
      try { return json(res, 200, { ok: true, result: await ops[op](args) }); }
      catch (e) { return json(res, 500, { ok: false, error: e.message }); }
    });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  return {
    url, token, calls, emit,
    callsOf: (op) => calls.filter((c) => c.op === op),
    /** Write daemon.json and the token into a state dir, as `drover serve` would. */
    writeState(dir) { mkdirSync(dir, { recursive: true, mode: 0o700 }); writeFileSync(path.join(dir, 'daemon.json'), JSON.stringify({ pid: process.pid, url })); writeFileSync(path.join(dir, 'token'), `${token}\n`, { mode: 0o600 }); },
    close: () => new Promise((resolve) => { for (const c of streams) c.res.end(); server.close(() => resolve()); }),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : undefined; };
  const dir = arg('state'); if (!dir) { process.stderr.write('usage: fake-daemon.js --state DIR [--port N] [--old]\n'); process.exit(2); }
  const d = await startFakeDaemon({ mode: process.argv.includes('--old') ? 'old' : 'new', port: Number(arg('port') ?? 0) });
  d.writeState(dir);
  process.stdout.write(`fake daemon on ${d.url} (state ${dir})\n`);
}
