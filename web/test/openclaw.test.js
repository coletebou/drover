// OpenClaw manager adapter tests: a fake gateway on loopback stands in for the
// real OpenClaw gateway, a scratch HOME and state dir stand in for the host, and
// the service and CLI are injected, so nothing here reads this machine's own
// launchd job, systemd unit or OpenClaw install.
// Run: node --test test/openclaw.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const home = await mkdtemp(path.join(tmpdir(), 'drover-openclaw-home-'));
process.env.HOME = home;
// The truth file the conversation is recorded in (core/events.js: <HOME>/.dotfiles/claude/drover-events.jsonl).
delete process.env.DROVER_EVENTS; delete process.env.DROVER_DOTFILES;
await mkdir(path.join(home, '.dotfiles', 'claude'), { recursive: true });
process.env.DROVER_SHARE = path.join(home, 'share');
const state = path.join(home, '.openclaw-manager');
process.env.OPENCLAW_MANAGER_STATE_DIR = state;
delete process.env.OPENCLAW_GATEWAY_TOKEN;
delete process.env.OPENCLAW_MJS;
delete process.env.OPENCLAW_NODE;
delete process.env.OPENCLAW_GATEWAY_PORT; // the fake gateway's URL, never the host's port
// The repo's own data: no overlay from the shell running the suite (the owner is read from core/owner.js below).
delete process.env.DROVER_OPENCLAW_OVERLAY; delete process.env.APXW_OPENCLAW_OVERLAY;

const TOKEN = 'EXAMPLE_gateway_token';
const seen = [];
const gw = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    seen.push({ url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
    if (req.url === '/') { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"unauthorized"}'); return; }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'bad token' } })); return; }
    const req1 = JSON.parse(body);
    const text = req1.messages[0].content;
    if (/^fail /.test(text)) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'model overloaded' } })); return; }
    // A gateway that answers stream: true with SSE chunks (the real one does), unless the message asks for plain JSON.
    if (req1.stream && !/^plain /.test(text)) {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      const parts = ['manager ', 'here: ', text];
      const chunk = (delta) => `data: ${JSON.stringify({ model: 'openclaw/default', choices: [{ index: 0, delta }] })}\n\n`;
      res.write(chunk({ role: 'assistant' }));
      let i = 0;
      const tick = () => { if (i < parts.length) { res.write(chunk({ content: parts[i++] })); setTimeout(tick, 20); } else { res.write(chunk({})); res.end('data: [DONE]\n\n'); } };
      tick();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: 'openclaw/default', choices: [{ message: { role: 'assistant', content: `manager here: ${text}` } }] }));
  });
});
await new Promise((r) => gw.listen(0, '127.0.0.1', r));
process.env.OPENCLAW_GATEWAY_URL = `http://127.0.0.1:${gw.address().port}`;
const openclaw = await import('../core/openclaw.js');
const { OWNER } = await import('../core/owner.js');
// "live" means the fake gateway answered; give the probe room on a loaded box (one at load 44 on 6 cores,
// 2026-10-18: loopback fetches took up to 1.7 s, so the 800 ms product budget failed about 1 run in 4).
openclaw._deps.aliveTimeoutMs = 10_000;
openclaw._deps.host = () => 'boxa';

test('without a state dir config there is no manager session and no id resolves', async () => {
  assert.equal(openclaw.configured(), false);
  assert.deepEqual(await openclaw.listSessions(), []);
  assert.equal(await openclaw.findSession('manager'), null);
  assert.deepEqual(await openclaw.status(), { configured: false, host: 'boxa', reason: `no ${path.join(state, 'openclaw.json')} on this host` });
});

test('configured: one live session "manager"; aliases resolve; the token never appears in the listing', async () => {
  await mkdir(state, { recursive: true });
  await writeFile(path.join(state, 'openclaw.json'), '{}\n');
  await writeFile(path.join(state, '.env'), `AWS_BEARER_TOKEN_BEDROCK=EXAMPLE_bearer\nexport OPENCLAW_GATEWAY_TOKEN="${TOKEN}"\nOPENCLAW_HOOKS_TOKEN=EXAMPLE_hooks\n`, { mode: 0o600 });
  const list = await openclaw.listSessions();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'manager');
  assert.equal(list[0].engine, 'openclaw');
  assert.equal(list[0].kind, 'openclaw');
  assert.equal(list[0].live, true);
  assert.equal(list[0].status, 'ready');
  assert.equal(JSON.stringify(list).includes(TOKEN), false);
  for (const id of ['manager', 'openclaw', 'openclaw:manager', 'MANAGER', ' manager ']) assert.equal((await openclaw.findSession(id))?.id, 'manager', id);
  assert.equal(await openclaw.findSession('other'), null);
});

// The request streams (docs/specs/2026-10-20-ux-overhaul.md): stream: true, the reply assembled from SSE deltas.
test('send streams one chat completion with the bearer and a stable user and returns the whole reply', async () => {
  const deltas = [];
  const r = await openclaw.send('who is waiting on me?', { user: `drover:${OWNER}`, onDelta: (d, soFar) => deltas.push([d, soFar]) });
  assert.equal(r.ok, true);
  assert.equal(r.reply, 'manager here: who is waiting on me?');
  assert.equal(r.via, 'openclaw chat completions');
  assert.equal(r.model, 'openclaw/default');
  assert.deepEqual(deltas.map((d) => d[0]), ['manager ', 'here: ', 'who is waiting on me?']);
  assert.equal(deltas.at(-1)[1], r.reply);
  const call = seen.at(-1);
  assert.equal(call.url, '/v1/chat/completions');
  assert.equal(call.auth, `Bearer ${TOKEN}`);
  assert.deepEqual(call.body, { model: 'openclaw/default', user: `drover:${OWNER}`, stream: true, messages: [{ role: 'user', content: 'who is waiting on me?' }] });
  const plain = await openclaw.send('plain one');
  assert.equal(seen.at(-1).body.user, `drover:${OWNER}`, 'by default the owner\'s main conversation');
  assert.equal(plain.reply, 'manager here: plain one', 'a gateway that answers with one JSON body works too');
});

// Conversation tests run as the host the truth file names on each event (core/events.js shortHost), as in production;
// the console tests below inject 'boxa' for their canned events.
const events = await import('../core/events.js');

test('message records the message at once and the reply when it lands; the transcript reads both from the truth file', async () => {
  openclaw._deps.host = () => events.shortHost();
  const notices = [];
  const off = openclaw.onProgress((p) => notices.push(p));
  try {
    const r = await openclaw.message('who is waiting on me?', { actor: OWNER });
    assert.equal(r.reply, 'manager here: who is waiting on me?');
    assert.equal(r.thread, 'main');
    assert.ok(r.event);
    const t = await openclaw.transcript();
    assert.equal(t.engine, 'openclaw');
    assert.deepEqual(t.turns.map((x) => [x.role, x.text]), [['user', 'who is waiting on me?'], ['assistant', 'manager here: who is waiting on me?']]);
    assert.equal(t.turns[0].id, r.event, 'turns carry the event ids clients dedupe by');
    assert.equal(t.turns[1].inReplyTo, r.event);
    assert.equal(t.offset, 2);
    assert.deepEqual((await openclaw.transcript({ since: 1 })).turns.map((x) => x.role), ['assistant']);
    const phases = notices.filter((n) => n.event === 'manager').map((n) => n.data.phase);
    assert.equal(phases[0], 'start'); assert.equal(phases.at(-1), 'done');
    assert.equal(notices.filter((n) => n.event === 'manager').at(-1).data.text, r.reply);
    assert.deepEqual(notices.filter((n) => n.event === 'turn').map((n) => n.data.turn.role), ['user', 'assistant']);
  } finally { off(); }
});

test('wait: false returns before the reply in the daemon; the pending turn streams, then the final one replaces it', async () => {
  openclaw.markDaemon();
  const r = await openclaw.message('a slow one', { actor: OWNER, wait: false });
  assert.equal(r.pending, true);
  assert.equal(r.turnId, `pending:${r.event}`);
  const mid = await openclaw.transcript();
  assert.equal(mid.busy, true);
  assert.equal(mid.turns.at(-1).pending, true);
  assert.equal(mid.turns.at(-1).inReplyTo, r.event);
  assert.equal((await openclaw.listSessions())[0].status, 'busy');
  for (let i = 0; i < 100 && openclaw.busy(); i++) await new Promise((res) => setTimeout(res, 20));
  const t = await openclaw.transcript();
  assert.equal(t.busy, false);
  assert.deepEqual(t.turns.slice(-2).map((x) => [x.role, x.text, Boolean(x.pending)]), [['user', 'a slow one', false], ['assistant', 'manager here: a slow one', false]]);
  assert.equal((await openclaw.listSessions())[0].status, 'ready');
});

// Deterministically hold the WAL append after the gateway finishes: this used to clear busy/pending
// early, so the CI test read only the previous reply and the new user turn (both failed runs).
for (const failed of [false, true]) test(`pending remains visible until the ${failed ? 'error' : 'reply'} is durable`, async () => {
  const original = openclaw._deps.appendEvent;
  let release, writing;
  const blocked = new Promise((r) => { release = r; });
  const entered = new Promise((r) => { writing = r; });
  openclaw._deps.appendEvent = async (ev, opts) => { writing(); await blocked; return original(ev, opts); };
  const notices = [];
  const off = openclaw.onProgress((p) => notices.push(p));
  try {
    const r = await openclaw.message(failed ? 'fail held WAL' : 'held WAL', { wait: false, thread: 'wal-test' });
    await entered;
    assert.equal(openclaw.busy(), true, 'WAL write in flight must still be busy');
    const mid = await openclaw.transcript({ thread: 'wal-test' });
    assert.equal(mid.busy, true);
    assert.equal(mid.turns.at(-1).pending, true);
    assert.equal(mid.turns.at(-1).inReplyTo, r.event);
    assert.ok(!notices.some((p) => ['done', 'error'].includes(p.data.phase)));
    release();
    for (let i = 0; i < 100 && openclaw.busy(); i++) await new Promise((res) => setTimeout(res, 20));
    assert.equal(openclaw.busy(), false);
    const done = await openclaw.transcript({ thread: 'wal-test' });
    assert.equal(done.turns.at(-1).inReplyTo, r.event);
    assert.equal(done.turns.at(-1).role, failed ? 'system' : 'assistant');
    assert.equal(done.turns.some((t) => t.pending), false);
  } finally { release(); openclaw._deps.appendEvent = original; off(); }
});

test('threads are separate conversations: their own gateway user, transcript and listing', async () => {
  const r = await openclaw.message('just this window', { actor: OWNER, thread: 'win-@12' });
  assert.equal(seen.at(-1).body.user, `drover:${OWNER}:win-@12`);
  assert.equal(r.thread, 'win-@12');
  const t = await openclaw.transcript({ thread: 'win-@12' });
  assert.deepEqual(t.turns.map((x) => x.text), ['just this window', 'manager here: just this window']);
  assert.ok(!(await openclaw.transcript()).turns.some((x) => x.text === 'just this window'), 'main does not see it');
  const list = await openclaw.threads();
  assert.deepEqual(list.map((x) => x.thread).sort(), ['main', 'wal-test', 'win-@12']);
  assert.equal(list[0].thread, 'win-@12', 'newest activity first');
  await assert.rejects(openclaw.message('x', { thread: 'no spaces allowed' }), /thread must be/);
  assert.equal(openclaw.gatewayUser('chrome', 'main'), `drover:${OWNER}`, "the owner's clients share one conversation");
  assert.equal(openclaw.gatewayUser('menubar', 'win-@3'), `drover:${OWNER}:win-@3`);
  assert.equal(openclaw.gatewayUser('owner', 'main'), `drover:${OWNER}`, 'the generic alias is the owner too');
  assert.equal(openclaw.gatewayUser('mcp', 'main'), 'drover:mcp', 'an agent keeps its own');
  assert.throws(() => openclaw.threadOf('a'.repeat(65)), /thread must be/);
  assert.equal(openclaw.threadOf(''), 'main');
});

test('a failed reply is recorded as a chat event with the error and shows as a turn', async () => {
  await assert.rejects(openclaw.message('fail please', { actor: OWNER }), (e) => /gateway 500: model overloaded/.test(e.message) && Boolean(e.event));
  const t = await openclaw.transcript();
  assert.deepEqual(t.turns.slice(-2).map((x) => x.role), ['user', 'system']);
  assert.match(t.turns.at(-1).text, /did not answer: gateway 500/);
  const feed = await openclaw.feed({ limit: 1 });
  assert.match(feed[0].text, /^did not answer: gateway 500/);
});

test('the transcript is rebuilt from the truth file alone (a daemon restart keeps the conversation)', async () => {
  const fresh = await import(`../core/openclaw.js?restart=${Date.now()}`);
  fresh._deps.host = () => events.shortHost();
  const t = await fresh.transcript();
  assert.ok(t.turns.some((x) => x.text === 'manager here: who is waiting on me?'), 'a new process reads what an earlier one recorded');
  assert.ok(!(await fresh.transcript()).turns.some((x) => x.thread === 'win-@12'));
  assert.equal((await fresh.transcript({ thread: 'win-@12' })).turns.length, 2);
});

test('an empty message is refused before any request', async () => {
  const before = seen.length;
  await assert.rejects(openclaw.send('   '), /empty message/);
  await assert.rejects(openclaw.message('   '), /empty message/);
  assert.equal(seen.length, before);
});

test('a gateway rejection surfaces as a thrown delivery error that names the status, not the token', async () => {
  const before = (await openclaw.transcript({ limit: 5000 })).offset;
  process.env.OPENCLAW_GATEWAY_TOKEN = 'EXAMPLE_wrong_token';
  try {
    await assert.rejects(openclaw.send('hi'), (e) => /gateway 401/.test(e.message) && !e.message.includes('EXAMPLE_wrong_token'));
  } finally {
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
  }
  assert.equal((await openclaw.transcript({ limit: 5000 })).offset, before, 'send alone records nothing; message does');
  openclaw._deps.host = () => 'boxa';
});

test('a gateway that is down lists the manager as not live', async () => {
  await new Promise((r) => gw.close(r));
  const list = await openclaw.listSessions();
  assert.equal(list[0].live, false);
  assert.equal(list[0].status, 'down');
});

test('without an install manifest and no OpenClaw tree on disk, the CLI fields say so instead of guessing paths', async () => {
  Object.assign(openclaw._deps, { alive: async () => true, serviceState: async () => ({ kind: 'systemd', name: 'openclaw-manager', active: 'active', uptimeSec: 5, restarts: 0 }), readEvents: async () => [] });
  const st = await openclaw.status();
  assert.equal(st.install.managed, false);
  assert.equal(st.install.runtime, null);
  for (const k of ['health', 'automations', 'cost']) assert.match(st[k].error, /no OpenClaw install on this host/, k);
  assert.equal(openclaw.cliArgv(['health']), null);
});

const NOW = Date.parse('2026-10-11T22:00:00Z');
async function managedHost({ actor = 'manager-mac' } = {}) {
  await writeFile(path.join(state, 'openclaw.json'), JSON.stringify({
    agents: { defaults: { model: { primary: 'cliproxy/gpt-6.1-sol-ultrafast-br', fallbacks: ['a', 'b'] }, thinkingDefault: 'max', heartbeat: { every: '15m', model: 'amazon-bedrock-mantle/openai.gpt-6-luna' } } },
    mcp: { servers: { drover: { env: { DROVER_MCP_ACTOR: actor } } } },
    diagnostics: { otel: { enabled: true, endpoint: 'http://10.0.0.5:3150/api/public/otel' } },
    models: { providers: { x: { baseUrl: 'https://bedrock-mantle.us-east-1.api.aws/openai/v1' }, y: { baseUrl: 'https://evil.example.com/v1' } } },
    update: { checkOnStart: false }, telemetry: { enabled: false }, tools: { web: { fetch: { enabled: false } } },
  }));
  await writeFile(path.join(state, '.env'), `OPENCLAW_GATEWAY_TOKEN=${TOKEN}\nAWS_BEARER_TOKEN_BEDROCK=EXAMPLE_bearer\nEXA_API_KEY=EXAMPLE_exa\nOPENCLAW_HOOKS_TOKEN=EXAMPLE_hooks\nOPENAI_API_KEY=EXAMPLE_openai\n`);
  await writeFile(path.join(state, 'drover-install.json'), JSON.stringify({ schema: 1, role: 'mac', profile: 'default', actor, node: { path: '/opt/fake/node', version: 'v24.21.0' }, openclaw: { version: '2026.10.1', mjs: '/opt/fake/openclaw.mjs', dir: '/opt/fake' }, source: { commit: 'abc123', dirty: false }, refreshedAt: '2026-10-11T21:00:00Z' }));
}

test('console: status reads the service, gateway, health, model, automations, cost, install and WAL activity of this host\'s manager; never a secret', async () => {
  await managedHost();
  const calls = [];
  Object.assign(openclaw._deps, {
    now: () => NOW, alive: async () => true,
    serviceState: async () => ({ kind: 'launchd', name: 'dev.drover.manager', active: 'active', state: 'running', since: '2026-10-11T21:00:00.000Z', uptimeSec: 3600, pid: 4242, restarts: 34, lastExitCode: 78, lastExitReason: 'EX_CONFIG' }),
    run: async (file, argv, opts) => {
      calls.push({ file, argv, env: opts.env });
      if (argv.includes('automations')) return { code: 0, stdout: JSON.stringify({ jobs: [{ id: 'h', displayName: 'Heartbeat (main)', enabled: true, status: 'idle', schedule: { kind: 'every', everyMs: 900000 }, state: { lastRunAtMs: NOW - 600000, nextRunAtMs: NOW + 300000, lastRunStatus: 'ok' } }] }) };
      if (argv.includes('usage-cost')) return { code: 0, stdout: JSON.stringify({ totals: { totalCost: 1.25, totalTokens: 900 }, cacheStatus: { status: 'refreshing' } }) };
      if (argv.includes('health')) return { code: 0, stdout: JSON.stringify({ ok: true, plugins: { loaded: ['amazon-bedrock', 'exa'], errors: [], unavailable: [] }, configReload: { hotReloadStatus: 'active' }, agents: [{ isDefault: true, heartbeat: { enabled: true, every: '15m', model: 'm' } }] }) };
      throw new Error('unexpected ' + argv.join(' '));
    },
    readEvents: async () => [
      { id: '4', ts: '2026-10-09T21:30:00Z', type: 'note', actor: 'manager-mac', host: 'boxa', text: 'old' },
      { id: '1', ts: '2026-10-11T20:00:00Z', type: 'note', actor: 'manager-mac', host: 'boxa', text: 'sweep: 2 waiting' },
      { id: '5', ts: '2026-10-11T20:30:00Z', type: 'pin', actor: 'manager-mac', host: 'boxa', target: 'laptop:1' },
      { id: '2', ts: '2026-10-11T21:00:00Z', type: 'chat', actor: 'manager', from: 'manager', host: 'boxa', text: 'hi' },
      { id: '6', ts: '2026-10-11T21:10:00Z', type: 'chat', actor: 'manager', from: 'manager', host: 'boxb', text: 'the other host replied' },
      { id: '7', ts: '2026-10-11T21:20:00Z', type: 'note', actor: 'manager', host: 'boxb', text: 'the fleet manager, not this host' },
      { id: '3', ts: '2026-10-11T21:30:00Z', type: 'note', actor: OWNER, about: 'x', text: 'not the manager' },
    ],
  });
  const install = await import('../core/openclaw-install.js');
  const lay = install.layout();
  await mkdir(lay.bin, { recursive: true });
  await writeFile(lay.launcher, install.renderLauncher(lay, { node: '/opt/fake/node', mjs: '/opt/fake/openclaw.mjs' }, install.loadProfile('default'), { heartbeatThinking: 'high' }));
  const st = await openclaw.status();
  await rm(lay.launcher);   // the check test starts from no launcher
  assert.equal(st.role, 'mac');
  assert.equal(st.actor, 'manager-mac');
  assert.deepEqual([st.unit.kind, st.unit.active, st.unit.uptimeSec, st.unit.lastExitCode], ['launchd', 'active', 3600, 78]);
  assert.equal(st.gateway.up, true);
  assert.deepEqual([st.health.ok, st.health.configReload, st.health.heartbeat.every], [true, 'active', '15m']);
  assert.deepEqual([st.model.primary, st.model.thinking, st.model.heartbeatEvery, st.model.heartbeatModel, st.model.heartbeatThinking], ['cliproxy/gpt-6.1-sol-ultrafast-br', 'max', '15m', 'amazon-bedrock-mantle/openai.gpt-6-luna', 'high'], 'the sweep\'s level comes from the launcher, not the chat default');
  assert.equal(st.automations.jobs[0].schedule, 'every 15 min');
  assert.equal(st.automations.jobs[0].lastStatus, 'ok');
  assert.equal(st.automations.lastRunAt, new Date(NOW - 600000).toISOString());
  assert.deepEqual([st.cost.todayUsd, st.cost.fresh, st.cost.cacheStatus], [1.25, false, 'refreshing']);
  assert.ok(!('budgetUsd' in st.cost) && !('paused' in st.cost), 'no spend cap (removed 2026-10-14)');
  assert.deepEqual([st.wal24h.actor, st.wal24h.notes, st.wal24h.pins, st.wal24h.chats], ['manager-mac', 1, 1, 1], 'this host\'s manager only: its actor, and chat replies on this host');
  assert.deepEqual([st.install.managed, st.install.role, st.install.profile, st.install.overlay, st.install.openclaw, st.install.source.commit], [true, 'mac', 'default', null, '2026.10.1', 'abc123']);
  assert.ok(Array.isArray(st.install.drift), 'drift is computed against what setup would render');
  assert.equal(st.checks.egress.ok, false);
  assert.ok(st.checks.egress.unexpected.some((u) => u.includes('evil.example.com')), 'a host outside the profile allowlist is flagged');
  assert.ok(st.checks.egress.unexpected.some((u) => u.includes('OPENAI_API_KEY')), 'an extra provider key in .env is flagged');
  assert.deepEqual(st.langfuse, { url: 'http://10.0.0.5:3150', note: 'private address: reachable only from inside its network (10.0.0.5)' });
  assert.equal(st.dashboard.forward, `ssh -L 18789:127.0.0.1:18789 boxa`);
  assert.match(st.dashboard.tokenCommand, /gateway auth-token --show$/);
  for (const secret of [TOKEN, 'EXAMPLE_bearer', 'EXAMPLE_exa', 'EXAMPLE_hooks', 'EXAMPLE_openai']) assert.ok(!JSON.stringify(st).includes(secret), `${secret} never appears in status`);
  assert.ok(calls.every((c) => !c.argv.some((a) => /auth-token/.test(a))), 'status never asks the CLI for the token');
  assert.ok(calls.every((c) => c.file === '/opt/fake/node' && c.argv[0] === '/opt/fake/openclaw.mjs'), 'the manifest names the runtime');
  for (const c of calls) {
    assert.equal(c.env.OPENCLAW_GATEWAY_TOKEN, TOKEN, 'gateway calls carry the gateway bearer');
    for (const k of ['AWS_BEARER_TOKEN_BEDROCK', 'EXA_API_KEY', 'OPENAI_API_KEY', 'OPENCLAW_HOOKS_TOKEN']) assert.equal(c.env[k], undefined, `${k} is not handed to read-only CLI calls`);
    assert.equal(c.env.OPENCLAW_OFFLINE, '1');
    assert.equal(c.env.OPENCLAW_STATE_DIR, state);
    assert.equal(c.env.AWS_REGION, 'us-east-1', 'the profile env reaches the CLI');
  }
  const f = await openclaw.feed({ limit: 10 });
  assert.deepEqual(f.map((e) => e.id), ['2', '5', '1', '4'], 'this host\'s manager only, newest first');
});

test('console: a failing gateway call reports OpenClaw\'s own error, not the command line', async () => {
  openclaw._deps.run = async (file, argv) => (argv.includes('usage-cost')
    ? { code: 1, stdout: JSON.stringify({ ok: false, error: { type: 'gateway_transport_error', kind: 'timeout', message: 'gateway timeout after 10000ms' } }), stderr: '' }
    : { code: 1, stdout: '', stderr: 'node:internal/modules/cjs/loader:1228\n  throw err;\nError: Cannot find module \'/opt/fake/openclaw.mjs\'' });
  const st = await openclaw.status();
  assert.equal(st.cost.error, 'openclaw gateway usage-cost exited 1: gateway timeout after 10000ms');
  assert.match(st.automations.error, /^openclaw automations list exited 1: .*Cannot find module/);
  assert.ok(!st.automations.error.includes('--timeout'), 'the argv is not the message');
});

test('console: check flags launcher switches that are missing and passes a clean install', async () => {
  let r = await openclaw.check();
  assert.ok(r.items.filter((i) => i.area === 'launcher').every((i) => i.ok === false), 'no generated launcher yet');
  const install = await import('../core/openclaw-install.js');
  const lay = install.layout();
  await mkdir(lay.bin, { recursive: true });
  await writeFile(lay.launcher, install.renderLauncher(lay, { node: '/opt/fake/node', mjs: '/opt/fake/openclaw.mjs' }, install.loadProfile('default')));
  await writeFile(path.join(state, '.env'), `OPENCLAW_GATEWAY_TOKEN=${TOKEN}\nAWS_BEARER_TOKEN_BEDROCK=EXAMPLE_bearer\nEXA_API_KEY=EXAMPLE_exa\nOPENCLAW_HOOKS_TOKEN=EXAMPLE_hooks\n`);
  await writeFile(path.join(state, 'openclaw.json'), JSON.stringify({ models: { providers: { x: { baseUrl: 'https://bedrock-mantle.us-east-1.api.aws/openai/v1' } } }, update: { checkOnStart: false }, telemetry: { enabled: false }, tools: { web: { fetch: { enabled: false } } } }));
  r = await openclaw.check();
  assert.equal(r.ok, true, JSON.stringify(r.unexpected));
  assert.equal(r.profile, 'default');
});

test('console: an install whose profile lives in an overlay is checked against that profile, from the manifest or DROVER_OPENCLAW_OVERLAY', async () => {
  const install = await import('../core/openclaw-install.js');
  const lay = install.layout();
  const overlay = await mkdtemp(path.join(tmpdir(), 'drover-openclaw-overlay-'));
  await mkdir(path.join(overlay, 'profiles'), { recursive: true });
  const p = JSON.parse(await readFile(path.join(install.SRC, 'profiles', 'default.json'), 'utf8'));
  await writeFile(path.join(overlay, 'profiles', 'box-b.json'), JSON.stringify({ ...p, egress: { ...p.egress, allow: [...p.egress.allow, 'traces.box-b.example'] } }));
  const before = await readFile(lay.manifest, 'utf8'); const cfgBefore = await readFile(lay.config, 'utf8');
  const m = JSON.parse(before);
  await writeFile(lay.config, JSON.stringify({ ...JSON.parse(cfgBefore), diagnostics: { otel: { enabled: true, endpoint: 'https://traces.box-b.example/api/public/otel' } } }));
  try {
    await writeFile(lay.manifest, JSON.stringify({ ...m, profile: 'box-b', overlay }));
    let r = await openclaw.check();
    assert.deepEqual([r.profile, r.ok], ['box-b', true], 'the overlay profile\'s allowlist admits its own trace host');
    await writeFile(lay.manifest, JSON.stringify({ ...m, profile: 'box-b' }));
    r = await openclaw.check();
    assert.equal(r.profile, null);
    assert.ok(r.unexpected.includes('profile: install profile (profile box-b not found in this checkout (no overlay: set DROVER_OPENCLAW_OVERLAY if it lives in one))'), JSON.stringify(r.unexpected));
    process.env.DROVER_OPENCLAW_OVERLAY = overlay;
    assert.equal((await openclaw.check()).profile, 'box-b', 'the variable names it when the manifest does not');
    process.env.DROVER_OPENCLAW_OVERLAY = 'none';
    await writeFile(lay.manifest, JSON.stringify({ ...m, profile: 'box-b', overlay }));
    assert.match((await openclaw.check()).unexpected.join('\n'), /profile box-b not found in this checkout \(no overlay/, 'none overrides the manifest');
  } finally {
    delete process.env.DROVER_OPENCLAW_OVERLAY;
    await writeFile(lay.manifest, before); await writeFile(lay.config, cfgBefore);
    await rm(overlay, { recursive: true, force: true });
  }
});
test('console: sweep enqueues "sweep now" with wake mode now, no shell, and says why it failed', async () => {
  let seenArgv = null;
  openclaw._deps.run = async (file, argv) => { seenArgv = argv; return { code: 0, stdout: '{"ok":true}' }; };
  const r = await openclaw.sweep();
  assert.equal(r.ok, true);
  assert.deepEqual(seenArgv.slice(1), ['system', 'event', '--text', 'sweep now', '--mode', 'now', '--json']);
  await assert.rejects(() => openclaw.sweep({ text: '' }), /short non-empty/);
  openclaw._deps.run = async () => ({ code: 1, stdout: '', stderr: 'gateway closed' });
  await assert.rejects(() => openclaw.sweep(), /openclaw system event exited 1: gateway closed/);
});

test('isManagerEvent: own writes by actor anywhere, chat and messages only on the manager\'s host', () => {
  const who = { actor: 'manager-mac', host: 'boxa' };
  assert.equal(openclaw.isManagerEvent({ type: 'note', actor: 'manager-mac', host: 'boxb' }, who), true, 'its notes, synced to any host');
  assert.equal(openclaw.isManagerEvent({ type: 'note', actor: 'manager', host: 'boxa' }, who), false, 'another manager');
  assert.equal(openclaw.isManagerEvent({ type: 'chat', from: 'manager', actor: 'manager', host: 'boxa' }, who), true);
  assert.equal(openclaw.isManagerEvent({ type: 'chat', from: 'manager', actor: 'manager', host: 'boxb' }, who), false);
  assert.equal(openclaw.isManagerEvent({ type: 'message', to: { id: 'manager' }, host: 'boxa' }, who), true);
  assert.equal(openclaw.isManagerEvent({ type: 'note', actor: 'manager' }), true, 'no host given: the default actor, as before');
  assert.equal(openclaw.peerHost('[::1]:7337'), '::1');
  assert.equal(openclaw.peerHost('::1:7337'), '::1');
  assert.equal(openclaw.peerHost('10.0.0.5:443'), '10.0.0.5');
});

test('the console reaches the gateway on the port the install recorded (a profile that moved it to 18831, beside another OpenClaw on 18789)', async () => {
  const saved = { url: process.env.OPENCLAW_GATEWAY_URL, port: process.env.OPENCLAW_GATEWAY_PORT };
  const manifest = path.join(state, 'drover-install.json');
  delete process.env.OPENCLAW_GATEWAY_URL; delete process.env.OPENCLAW_GATEWAY_PORT;
  try {
    await mkdir(state, { recursive: true });
    await writeFile(path.join(state, 'openclaw.json'), '{}\n');
    await writeFile(manifest, JSON.stringify({ gateway: { port: 18831 } }));
    assert.equal((await openclaw.listSessions())[0].gateway, 'http://127.0.0.1:18831');
    process.env.OPENCLAW_GATEWAY_PORT = '18999';
    assert.equal((await openclaw.listSessions())[0].gateway, 'http://127.0.0.1:18999', 'the environment still overrides');
    delete process.env.OPENCLAW_GATEWAY_PORT;
    await rm(manifest);
    assert.equal((await openclaw.listSessions())[0].gateway, 'http://127.0.0.1:18789', 'no manifest: the default');
  } finally {
    await rm(manifest, { force: true });
    if (saved.url === undefined) delete process.env.OPENCLAW_GATEWAY_URL; else process.env.OPENCLAW_GATEWAY_URL = saved.url;
    if (saved.port === undefined) delete process.env.OPENCLAW_GATEWAY_PORT; else process.env.OPENCLAW_GATEWAY_PORT = saved.port;
  }
});
