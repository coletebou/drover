// A stand-in Hermes Agent for tests and the dev world: a profile home with a state.db built from the parts of the
// real schema Drover reads (Hermes 2026.9.24, SCHEMA_VERSION 32), and a gateway that answers the way the real one
// does on the paths core/hermes.js uses. Its control socket (<home>/gateway.sock, mode 0600, one JSON line per
// request) answers identify, status and session-ticket; its WebSocket (/api/ws on loopback, subprotocols
// hermes-gateway-v1 and hermes-gateway-ticket.<ticket>, refused with an Origin header or a reused ticket) speaks
// JSON-RPC 2.0: session.active_list, session.resume, prompt.submit (subscribed viewers only, input_id required),
// approval.respond and clarify.respond (exact params, as session_controls.py checks them), session.interrupt.
// A submitted turn is written to state.db as the user's row and an "echo: <text>" reply, as the gateway would.
import net from 'node:net';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT UNIQUE, cwd TEXT, git_branch TEXT, model TEXT, system_prompt TEXT,
  started_at REAL NOT NULL, ended_at REAL, end_reason TEXT, last_activity_at REAL, source TEXT, created_source TEXT,
  parent_session_id TEXT, archived INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0, message_count INTEGER NOT NULL DEFAULT 0);
CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id), role TEXT NOT NULL,
  content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL NOT NULL, reasoning TEXT, reasoning_content TEXT,
  _compressed_summary INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, compacted INTEGER NOT NULL DEFAULT 0);
CREATE TABLE state_meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE session_admissions (seq INTEGER PRIMARY KEY AUTOINCREMENT, admission_id TEXT NOT NULL UNIQUE, request_id TEXT NOT NULL,
  principal_id TEXT NOT NULL, target_session_id TEXT NOT NULL, lineage_json TEXT NOT NULL, payload_json TEXT NOT NULL,
  payload_digest TEXT NOT NULL, intent TEXT NOT NULL, status TEXT NOT NULL, outcome TEXT, owner_epoch INTEGER, generation INTEGER);
`;

export const POLICY_PREFIX = 'gateway.local_policy.v1:';
export const sid = (n) => `local-${String(n).padStart(64, '0')}`;

/**
 * A profile home at dir with a state.db holding these rows. sessions: { id, title, cwd, model, started_at, ... };
 * messages: { session_id, role, content, ... } (timestamp defaults to its session's start plus its index);
 * policies: { id, lineage, cwd, env } (a gateway policy row; env stands for the client environment Drover must never
 * read); admissions: { session_id, status }.
 */
export function makeHome(dir, { sessions = [], messages = [], policies = [], admissions = [] } = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(dir, 'state.db'));
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  const now = Date.now() / 1000;
  const ins = db.prepare('INSERT INTO sessions (id, title, cwd, git_branch, model, system_prompt, started_at, ended_at, end_reason, last_activity_at, source, created_source, parent_session_id, archived, hidden, message_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const s of sessions) {
    ins.run(s.id, s.title ?? null, s.cwd ?? null, s.git_branch ?? null, s.model ?? 'test-model', 'a long system prompt Drover must not select', s.started_at ?? now - 600, s.ended_at ?? null, s.end_reason ?? null, s.last_activity_at ?? null, s.source ?? 'local', s.created_source ?? 'cli', s.parent_session_id ?? null, s.archived ? 1 : 0, s.hidden ? 1 : 0, s.message_count ?? 0);
  }
  const msg = db.prepare('INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp, reasoning, _compressed_summary, active, compacted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  messages.forEach((m, i) => {
    const start = sessions.find((s) => s.id === m.session_id)?.started_at ?? now - 600;
    msg.run(m.session_id, m.role, m.content ?? null, m.tool_call_id ?? null, m.tool_calls ? JSON.stringify(m.tool_calls) : null, m.tool_name ?? null, m.timestamp ?? start + i, m.reasoning ?? null, m.summary ? 1 : 0, m.active === false ? 0 : 1, m.compacted ? 1 : 0);
  });
  const meta = db.prepare('INSERT INTO state_meta (key, value) VALUES (?, ?)');
  for (const p of policies) {
    meta.run(POLICY_PREFIX + p.id, JSON.stringify({ entry: { session_id: p.id }, policy: { cwd: p.cwd ?? null, client_env_json: JSON.stringify(p.env ?? { SECRET_TOKEN: 'never-read' }) }, ...(p.lineage ? { session_id: p.id, lineage: p.lineage } : {}) }));
  }
  const adm = db.prepare("INSERT INTO session_admissions (admission_id, request_id, principal_id, target_session_id, lineage_json, payload_json, payload_digest, intent, status) VALUES (?, ?, 'uid:1', ?, '[]', '{}', 'x', 'queue', ?)");
  for (const a of admissions) adm.run(randomUUID(), randomUUID(), a.session_id, a.status);
  db.close();
  return dir;
}

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** One WebSocket frame out of buf: { op, payload, rest } or null when buf holds less than a frame. Client frames are masked. */
function readFrame(buf) {
  if (buf.length < 2) return null;
  const op = buf[0] & 0x0f, masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f, off = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); off = 10; }
  const maskAt = off; if (masked) off += 4;
  if (buf.length < off + len) return null;
  const payload = Buffer.from(buf.subarray(off, off + len));
  if (masked) for (let i = 0; i < len; i++) payload[i] ^= buf[maskAt + (i % 4)];
  return { op, payload, rest: buf.subarray(off + len) };
}
function frame(op, payload) {
  const b = Buffer.from(payload);
  const head = b.length < 126 ? Buffer.from([0x80 | op, b.length]) : b.length < 65536 ? Buffer.from([0x80 | op, 126, b.length >> 8, b.length & 0xff]) : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(b.length), 2); return h; })();
  return Buffer.concat([head, b]);
}

/**
 * Start the gateway for home. live: id -> { status: working|waiting|starting|idle, title?, prompts?, profile? } (the
 * sessions it holds; profile, the home of a served profile, defaults to the root's); idleExit (default true): its argv
 * says --idle-exit. servedHomes: the homes it multiplexes (default the root alone). Resolves { home, port, socket, live, calls, submitted,
 * connections, writeTurn, close }: calls is every JSON-RPC request in order, connections the WebSockets opened.
 */
export async function startFakeHermes(home, { live = {}, idleExit = true, pid = 424242, instanceId = 'inst-fake-1', profileId = home, servedHomes = null, replyDelayMs = 20 } = {}) {
  const sessions = new Map(Object.entries(live).map(([id, s]) => [id, { status: 'idle', prompts: [], generation: 1, ...s }]));
  const tickets = new Map();   // ticket -> the profile it was minted for
  const calls = [], submitted = [];
  const state = { connections: 0 };
  const open = new Set();
  const writeTurn = (id, text) => {
    const db = new DatabaseSync(path.join(home, 'state.db'));
    const t = Date.now() / 1000;
    if (!db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(id)) db.prepare("INSERT INTO sessions (id, title, started_at, source, created_source) VALUES (?, NULL, ?, 'local', 'cli')").run(id, t);
    db.prepare("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, 'user', ?, ?)").run(id, text, t);
    db.prepare("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, 'assistant', ?, ?)").run(id, `echo: ${text}`, t + 0.001);
    db.prepare('UPDATE sessions SET last_activity_at = ?, message_count = message_count + 2 WHERE id = ?').run(t, id);
    db.close();
  };

  const http = createServer((_req, res) => { res.writeHead(404); res.end(); });
  http.on('upgrade', (req, socket) => {
    const protos = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((s) => s.trim());
    const ticket = protos.find((p) => p.startsWith('hermes-gateway-ticket.'))?.slice('hermes-gateway-ticket.'.length);
    // As run_api.py: an Origin header, a missing or used ticket, or the wrong path is refused.
    if (req.url !== '/api/ws' || req.headers.origin || !protos.includes('hermes-gateway-v1') || !ticket || !tickets.has(ticket)) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    // The connection binds to the profile its ticket names (run_api.py authority_for_profile_id): it sees that profile's sessions only.
    const profile = tickets.get(ticket); tickets.delete(ticket);
    const mine = ([, x]) => (x.profile ?? profileId) === profile;
    const accept = createHash('sha1').update(String(req.headers['sec-websocket-key']) + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: hermes-gateway-v1\r\n\r\n`);
    state.connections++;
    open.add(socket); socket.on('close', () => open.delete(socket));
    const subscribed = new Set();
    const send = (o) => { if (!socket.destroyed) socket.write(frame(1, JSON.stringify(o))); };
    send({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: {} } });
    const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
    const fail = (id, code) => send({ jsonrpc: '2.0', id, error: { code: -32000, message: code } });
    const handle = (m) => {
      calls.push({ method: m.method, params: m.params });
      const p = m.params ?? {};
      const s = sessions.get(p.session_id);
      switch (m.method) {
        case 'session.active_list': return reply(m.id, { sessions: [...sessions].filter(mine).map(([id, x]) => ({ id, session_key: id, title: x.title ?? null, model: x.model ?? 'test-model', started_at: 1792000000, last_active: 1792000100, message_count: 0, preview: '', source: 'local', status: x.status, current: false })) });
        case 'session.resume': {
          if (!s && !existsSync(path.join(home, 'state.db'))) return fail(m.id, 'not_found');
          if (!s) sessions.set(p.session_id, { status: 'idle', prompts: [], generation: 1 });
          subscribed.add(p.session_id);
          const x = sessions.get(p.session_id);
          return reply(m.id, { session_id: p.session_id, running: x.status === 'working' || x.status === 'waiting', prompts: x.prompts, execution_generation: x.generation, ...(p.omit_messages ? {} : { messages: [] }) });
        }
        case 'prompt.submit': {
          const allowed = ['session_id', 'text', 'input_id', 'submission_id'];
          if (Object.keys(p).some((k) => !allowed.includes(k)) || !p.input_id) return fail(m.id, 'invalid_params');
          if (!subscribed.has(p.session_id)) return fail(m.id, 'permission_denied');
          submitted.push({ session_id: p.session_id, text: p.text, input_id: p.input_id });
          const x = sessions.get(p.session_id);
          const was = x.status;
          x.status = 'working';
          setTimeout(() => { writeTurn(p.session_id, p.text); if (x.status === 'working') x.status = was === 'waiting' ? 'waiting' : 'idle'; }, replyDelayMs);
          return reply(m.id, { admission_id: randomUUID().replace(/-/g, ''), status: 'queued', sequence: submitted.length });
        }
        case 'approval.respond': case 'clarify.respond': {
          const field = m.method === 'approval.respond' ? 'choice' : 'answer';
          const want = ['session_id', 'execution_generation', 'prompt_id', field].sort().join();
          if (Object.keys(p).sort().join() !== want) return fail(m.id, 'invalid_params');
          if (!subscribed.has(p.session_id)) return fail(m.id, 'permission_denied');
          if (!s || p.execution_generation !== s.generation) return fail(m.id, 'stale_generation');
          const i = s.prompts.findIndex((q) => q.prompt_id === p.prompt_id);
          if (i < 0) return reply(m.id, { status: 'already_resolved', prompt_id: p.prompt_id });
          const q = s.prompts[i];
          if ((field === 'choice' && (q.kind !== 'approval' || !q.choices.includes(p.choice))) || (field === 'answer' && q.kind !== 'clarify')) return fail(m.id, 'invalid_params');
          s.prompts.splice(i, 1);
          s.answered = [...(s.answered ?? []), { prompt_id: p.prompt_id, [field]: p[field] }];
          if (!s.prompts.length) s.status = 'working';
          return reply(m.id, { status: 'resolved', prompt_id: p.prompt_id });
        }
        case 'session.interrupt': if (s) s.status = 'idle'; return reply(m.id, { interrupted: true });
        default: return fail(m.id, 'method_not_found');
      }
    };
    let buf = Buffer.alloc(0);
    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (let f; (f = readFrame(buf)); buf = f.rest) {
        if (f.op === 8) { socket.end(frame(8, Buffer.alloc(0))); return; }
        if (f.op === 9) { socket.write(frame(10, f.payload)); continue; }
        if (f.op !== 1) continue;
        let msg; try { msg = JSON.parse(f.payload.toString('utf8')); } catch { continue; }
        handle(msg);
      }
    });
    socket.on('error', () => {});
  });
  await new Promise((r) => http.listen(0, '127.0.0.1', r));
  const port = http.address().port;

  const socketPath = path.join(home, 'gateway.sock');
  rmSync(socketPath, { force: true });
  const ctl = net.createServer((c) => {
    let b = '';
    c.setEncoding('utf8');
    c.on('data', (d) => {
      b += d;
      const i = b.indexOf('\n'); if (i < 0) return;
      let r; try { r = JSON.parse(b.slice(0, i)); } catch { c.end('{"ok":false,"error":"bad_json"}\n'); return; }
      const ok = (result) => c.end(JSON.stringify({ ok: true, protocol: 1, result, id: r.id }) + '\n');
      if (r.verb === 'identify') return ok({ protocol: 1, kind: 'hermes-gateway', pid, hermes_home: home, profile: 'default', instance_id: instanceId, state: 'ready', api_origin: `http://127.0.0.1:${port}`, served_profiles: (servedHomes ?? [home]).map((h) => ({ profile_id: h === home ? profileId : h, home: h })), capabilities: ['session-authority-v1'] });
      if (r.verb === 'status') return ok({ pid, kind: 'hermes-gateway', argv: ['hermes_cli/main.py', 'gateway', 'run', '--quiet', ...(idleExit ? ['--idle-exit'] : [])], gateway_state: 'running', active_agents: 0 });
      if (r.verb === 'session-ticket') {
        const q = r.params ?? {};
        if (q.instance_id !== instanceId || q.purpose !== 'interactive') return c.end(JSON.stringify({ ok: false, error: 'ticket_refused', id: r.id }) + '\n');
        const t = randomUUID();
        tickets.set(t, q.profile_id);
        return ok({ ticket: t, instance_id: instanceId, profile_id: q.profile_id });
      }
      c.end(JSON.stringify({ ok: false, error: 'unknown_verb', id: r.id }) + '\n');
    });
    c.on('error', () => {});
  });
  await new Promise((r) => ctl.listen(socketPath, r));
  chmodSync(socketPath, 0o600);
  return {
    home, port, socket: socketPath, live: sessions, calls, submitted, writeTurn,
    get connections() { return state.connections; },
    close: () => { for (const s of open) s.destroy(); return Promise.all([new Promise((r) => http.close(() => r())), new Promise((r) => ctl.close(() => r()))]).then(() => { http.closeAllConnections?.(); rmSync(socketPath, { force: true }); }); },
  };
}
