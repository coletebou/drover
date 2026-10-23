// Native tenants end to end over real HTTP: the operator approves through the daemon's main-token route
// (server/http.js /api/bots/approve, what `drover bots approve` calls) and the tenant speaks MCP through its own
// /bots/<prefix>-<tenant>/mcp server (server/botgate.js; the prefix is DROVER_TENANT_PREFIX, so every bot name here
// comes from tenantBot and the tests hold for any configured prefix). Two tenants with disjoint delegations, malformed and missing
// policy, cross-project ids, refresh, daemon restart, MCP reconnect, revocation and the legacy bots unchanged.
import './isolate-cache.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const STATE = await mkdtemp(path.join(tmpdir(), 'drover-tenants-'));
const EVENTS = path.join(STATE, 'events.jsonl');
await writeFile(EVENTS, '');
process.env.DROVER_STATE = STATE;
process.env.DROVER_EVENTS = EVENTS;
process.env.DROVER_PAIR_NOTIFY = 'off';
process.env.DROVER_HOST = 'box-a';   // the gateway host's short name (events.shortHost): WAL events are stamped box-a
delete process.env.DROVER_ALLOW_ORIGINS;
const oauth = await import('../core/bots/oauth.js');
const events = await import('../core/events.js');
const native = await import('../core/native.js');
const http = await import('../server/http.js');
const { startBotGateway, _resetSessions } = await import('../server/botgate.js');
const { tenantBot: T } = await import('../core/bots/access.js');
const { NOTIFY_TOOL } = await import('../core/bots/tools.js');
const { OWNER } = await import('../core/owner.js');
const re = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'drover');

const BASE = 'https://gw.test';
const REDIRECT = 'https://www.cursor.com/bot/mcp/oauth/callback';
const verifier = 'tenant-verifier-0123456789-abcdefghijklmnopqrstuvwxyz';
const challenge = createHash('sha256').update(verifier).digest('base64url');

const ALICE = { version: 1, tenant: 'alice', bot: T('alice'), requester: 'imessage:+15550000001', projects: ['/home/c/code/Alpha'], hosts: ['box-a'] };
const BOB = { version: 1, tenant: 'bob', bot: T('bob'), requester: 'imessage:+15550000002', projects: ['/home/c/code/Beta', '/home/c/code/Gamma'], hosts: ['box-a', 'box-b'] };

// The daemon's op dispatcher, hostile on purpose: it answers with every project and host whatever it is asked, plus
// coverage metadata, so only the tenant filter stands between the fleet and the tenant.
const calls = [];
let duringFleet = null;
// checkout is where an item was written (the CLI's per-item git top level); cwd is the CLI's main worktree root.
const REFLECTIONS = [
  { id: 'r-alpha', repo: '/home/c/code/Alpha', checkout: '/home/c/code/Alpha', cwd: '/home/c/code/Alpha', host: 'box-a', title: 'alpha lesson', body: 'alpha body' },
  { id: 'r-beta', repo: '/home/c/code/Beta', checkout: '/home/c/code/Beta', cwd: '/home/c/code/Beta', host: 'box-a', title: 'beta secret', body: 'beta body' },
  { id: 'r-alpha-box-b', repo: '/home/c/code/Alpha', checkout: '/home/c/code/Alpha', cwd: '/home/c/code/Alpha', host: 'box-b', title: 'alpha on box-b', body: 'not on an approved host for alice' },
  { id: 'r-alpha-wt', repo: 'alpha', checkout: '/home/c/code/Alpha-private-wt', cwd: '/home/c/code/Alpha', host: 'box-a', title: 'worktree secret', body: 'written in a private worktree of Alpha' },
  { id: 'r-alpha-cwd', repo: '/home/c/code/Alpha', cwd: '/home/c/code/Alpha', host: 'box-a', title: 'no checkout', body: 'an older CLI: only the main worktree cwd' },
  { id: 'r-alpha-gamma', repo: 'Gamma', checkout: '/home/c/code/Alpha', host: 'box-a', title: 'gamma label', body: 'repo label contradicts the checkout' },
];
async function dispatch(op, args) {
  calls.push({ op, args });
  switch (op) {
    case 'fleet.summary': {
      if (duringFleet) await duringFleet();
      const all = { local: [
        { id: 'a1', engine: 'claude', status: 'busy', live: true, name: 'alpha-work', cwd: '/home/c/code/Alpha' },
        { id: 'a-wt', engine: 'claude', status: 'idle', live: true, name: 'alpha-wt', cwd: '/home/c/code/Alpha/.claude/worktrees/fix' },
        { id: 'same-name', engine: 'claude', status: 'busy', live: true, cwd: '/secret/Alpha' },
        { id: 'look', engine: 'claude', status: 'idle', live: true, name: 'lookalike', cwd: '/home/c/code/Alpha-secret' },
        { id: 'b1', engine: 'claude', status: 'busy', live: true, name: 'beta-work', cwd: '/home/c/code/Beta' },
        { id: 'x1', engine: 'claude', status: 'busy', live: true, name: 'no-project' },
        { id: `grok:${T('bob')}`, engine: 'grok', status: 'busy', live: true, name: 'bob', cwd: '/home/c/code/Beta' },
      ], 'box-b': [
        { id: 'g1', engine: 'codex', status: 'waiting', live: true, name: 'gamma-box-b', cwd: '/home/c/code/Gamma' },
        { id: 'a-box-b', engine: 'claude', status: 'busy', live: true, name: 'alpha-box-b', cwd: '/home/c/code/Alpha' },
      ], secret: [{ id: 's1', engine: 'claude', live: true, cwd: '/home/c/code/Alpha' }] };
      return { ts: 'global', hosts: [...new Set([...(args.hosts ?? []), 'secret'])].map((h) => ({ host: h, ok: true, sessions: all[h] ?? [] })) };
    }
    case 'search.fleet': return { query: args.query, results: [
      { kind: 'claude', project: 'Alpha', cwd: '/home/c/code/Alpha', host: 'box-a', hosts: ['box-a'], origins: [{ cwd: '/home/c/code/Alpha', host: 'box-a' }], title: 'alpha hit', snippet: '/home/c/code/alpha', sessionId: 'sa', score: 3 },
      { kind: 'claude', project: '/home/c/code/Alpha', host: 'box-b', hosts: ['box-b'], origins: [{ cwd: '/home/c/code/Alpha', host: 'box-b' }], title: 'alpha on box-b', snippet: 'box-b', sessionId: 'sp', score: 2.5 },
      { kind: 'claude', project: '/home/c/code/Beta', host: 'box-a', hosts: ['box-a'], origins: [{ cwd: '/home/c/code/Beta', host: 'box-a' }], title: 'beta hit', snippet: 'beta', sessionId: 'sb', score: 2 },
      { kind: 'codex', project: '/home/c/code/Gamma', host: 'box-b', hosts: ['box-b'], origins: [{ cwd: '/home/c/code/Gamma', host: 'box-b' }], title: 'gamma hit', snippet: 'gamma', sessionId: 'sg', score: 1.5 },
      { kind: 'claude', project: '/home/c/code/Alpha', host: 'box-a', hosts: ['box-a', 'secret'], origins: [{ cwd: '/home/c/code/Alpha', host: 'box-a' }, { cwd: '/home/c/code/Alpha', host: 'secret' }], title: 'mixed hosts', snippet: 'x', score: 1.4 },
      { kind: 'claude', project: '/home/c/code/Alpha-secret', host: 'box-a', hosts: ['box-a'], origins: [{ cwd: '/home/c/code/Alpha-secret', host: 'box-a' }], title: 'lookalike', snippet: 'x', score: 1.3 },
      { kind: 'wal', project: '/home/c/code/Alpha', host: 'box-a', hosts: ['box-a'], origins: [{ cwd: '/home/c/code/Alpha', host: 'box-a' }], role: 'message', title: 'to bob', snippet: 'bob only', sessionId: `grok:${T('bob')}`, score: 1.2 },
      { kind: 'wal', project: '/home/c/code/Alpha', host: 'box-a', hosts: ['box-a'], origins: [{ cwd: '/home/c/code/Alpha', host: 'box-a' }], role: 'message', title: 'broadcast', snippet: 'everyone', sessionId: 'grok:*', score: 1.1 },
      { kind: 'claude', project: 'Alpha', cwd: '/secret/Alpha', host: 'box-a', hosts: ['box-a'], origins: [{ cwd: '/secret/Alpha', host: 'box-a' }], title: 'same basename', snippet: 'private', score: 5 },
      { kind: 'claude', project: 'Alpha', cwd: '/home/c/code/Alpha', host: 'box-a', hosts: ['box-a'], origins: [{ cwd: '/secret/Alpha', host: 'box-a' }], title: 'later turn in another checkout', snippet: 'private', score: 6 },
      { kind: 'claude', project: 'Alpha', host: 'box-a', hosts: ['box-a'], title: 'bare basename', snippet: 'ambiguous', score: 5 },
      { kind: 'claude', host: 'box-a', title: 'no project', snippet: 'x', score: 1 },
      { kind: 'brain', project: '/home/c/code/Alpha', host: 'box-a', hosts: ['box-a'], origins: [{ cwd: '/home/c/code/Alpha', host: 'box-a' }], title: 'brain', snippet: 'x', score: 0.9 },
    ], perHost: [{ host: 'secret', hits: 4 }], coverage: { searched: ['box-a', 'box-b', 'secret'], notCovered: [{ host: 'vault' }] } };
    case 'reflections.list': case 'reflections.search': return { items: REFLECTIONS.map((r) => ({ ...r })) };
    case 'reflections.show': return REFLECTIONS.find((r) => r.id === args.id) ?? null;
    case 'events.append': return events.append(args.event, { actor: args.actor });
    default: throw new Error(`tenant gateway dispatched unexpected op ${op}`);
  }
}

let gw, gwUrl, srv, api, main;
const req = (p, init = {}) => fetch(new URL(p, gwUrl), { redirect: 'manual', ...init });
const form = (o) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });
const operator = async (route, body) => {
  const r = await fetch(`${api}/api/bots/${route}`, body === undefined ? { headers: { authorization: `Bearer ${main}` } } : { method: 'POST', headers: { authorization: `Bearer ${main}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

let addr = 0;
async function startSignIn(bot) {
  const prefix = bot ? `/bots/${bot}` : '';
  const from = { 'x-forwarded-for': `198.18.1.${++addr}` };
  const reg = await (await req(`${prefix}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json', ...from }, body: JSON.stringify({ client_name: 'OpenClaw', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }) })).json();
  const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'st', resource: `${BASE}${prefix}/mcp` });
  const page = await req(`${prefix}/oauth/authorize?${q}`, { headers: from });
  const html = await page.text();
  return { prefix, client_id: reg.client_id, html, rid: html.match(/wait\?rid=([0-9a-f]{32})/)[1], code: oauth.pendingList().at(-1).code };
}
async function finishSignIn(s) {
  const back = await req(`${s.prefix}/oauth/authorize/wait?rid=${s.rid}`);
  assert.equal(back.status, 302);
  const loc = new URL(back.headers.get('location'));
  const tok = await req(`${s.prefix}/oauth/token`, form({ grant_type: 'authorization_code', code: loc.searchParams.get('code'), client_id: s.client_id, redirect_uri: REDIRECT, code_verifier: verifier }));
  assert.equal(tok.status, 200);
  return { ...(await tok.json()), client_id: s.client_id, prefix: s.prefix };
}
async function connectTenant(policy, extra = {}) {
  const s = await startSignIn(policy.bot);
  const r = await operator('approve', { code: s.code, resourceAccess: policy, ...extra });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { ...(await finishSignIn(s)), grantId: r.body.result.grantId, approved: r.body.result };
}
const refresh = (t) => req(`${t.prefix}/oauth/token`, form({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.client_id }));

let rpcId = 0;
async function mcp(prefix, token, method, params = {}, { sid } = {}) {
  const res = await req(`${prefix}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  const text = await res.text();
  return { status: res.status, sid: res.headers.get('mcp-session-id'), body: text ? JSON.parse(text) : null };
}
const init = async (t, prefix = t.prefix) => {
  const r = await mcp(prefix, t.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'openclaw' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r;
};
async function tool(t, name, args = {}, { sid, prefix = t.prefix } = {}) {
  const r = await mcp(prefix, t.access_token, 'tools/call', { name, arguments: args }, { sid });
  if (r.status !== 200) return { status: r.status };
  if (r.body.error) return { error: r.body.error };
  const text = r.body.result.content[0].text;
  return { isError: r.body.result.isError, text, data: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}
const wal = async () => (await readFile(EVENTS, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const TENANT_TOOLS = ['drover_whoami', 'drover_fleet', 'drover_search', 'drover_inbox', 'drover_features', 'drover_reflections', 'drover_status', 'drover_reply', 'drover_note', 'drover_feature_upsert'];

describe('native tenants through the daemon and the gateway', () => {
  let alice, bob, aliceSid;
  before(async () => {
    native._deps.isDaemon = () => false;
    gw = await startBotGateway({ base: BASE, port: 0, dispatch });
    gwUrl = gw.url;
    srv = await http.startServer({ port: 0 });
    api = srv.url.replace(/\/$/, '');
    main = srv.token;
  });
  after(async () => {
    await new Promise((r) => gw.server.close(r));
    await new Promise((r) => { srv.server.close(r); srv.server.closeAllConnections?.(); });
  });

  test('no delegation, malformed or broadened delegation, a foreign principal, shared or notify: refused, nothing granted', async () => {
    const s = await startSignIn(T('alice'));
    assert.match(s.html, /a native tenant/);
    assert.match(s.html, /--projects/);
    const bad = [
      {},
      { resourceAccess: null },
      { resourceAccess: { ...ALICE, projects: ['*'] } },
      { resourceAccess: { ...ALICE, projects: ['Alpha*'] } },
      { resourceAccess: { ...ALICE, projects: ['/home/c/code/Alpha', ''] } },
      { resourceAccess: { ...ALICE, hosts: ['local'] } },
      { resourceAccess: { ...ALICE, hosts: [] } },
      { resourceAccess: { ...ALICE, projects: '/home/c/code/Alpha' } },
      { resourceAccess: { ...ALICE, tenant: 'bob', bot: T('bob') } },
      { resourceAccess: { ...ALICE, bot: T('bob') } },
      { resourceAccess: { ...ALICE, requester: '' } },
      { resourceAccess: { ...ALICE, version: 2 } },
      { resourceAccess: { ...ALICE, admin: true } },
      { resourceAccess: ALICE, bot: 'alpha' },
      { resourceAccess: ALICE, shared: true },
      { resourceAccess: ALICE, scopes: ['read', 'notify'] },
    ];
    for (const b of bad) {
      const r = await operator('approve', { code: s.code, ...b });
      assert.equal(r.status, 400, JSON.stringify(b));
      assert.equal(r.body.ok, false);
    }
    assert.ok(oauth.pendingList().some((p) => p.code === s.code), 'still pending: a refused approval grants nothing');
    assert.deepEqual((await operator('grants')).body.result, []);
    // Static tokens: the same rule. A legacy bot cannot carry a tenant policy either.
    assert.equal((await operator('token', { bot: T('alice') })).status, 400);
    assert.equal((await operator('token', { bot: T('alice'), resourceAccess: { ...ALICE, hosts: ['*'] } })).status, 400);
    assert.equal((await operator('token', { bot: 'alpha', resourceAccess: ALICE })).status, 400);
    assert.equal((await operator('token', { shared: true, resourceAccess: ALICE })).status, 400);
    assert.deepEqual((await operator('grants')).body.result, []);
    // The root /mcp request needs --as; as a tenant it still needs the delegation.
    const root = await startSignIn(null);
    assert.equal((await operator('approve', { code: root.code, bot: T('alice') })).status, 400);
    oauth.deny(root.code); oauth.deny(s.code);
  });

  test('two tenants approved with exact projects and hosts; the grant is pinned, attributed and has no notify scope', async () => {
    alice = await connectTenant(ALICE);
    bob = await connectTenant(BOB, { scopes: ['read', 'write'] });
    assert.deepEqual(alice.approved.resourceAccess, ALICE);
    assert.deepEqual(alice.approved.scopes, ['drover.read', 'drover.write'], 'the default scope set loses notify');
    assert.equal(alice.approved.resourceApproval.approvedBy, 'operator:main-token');
    assert.equal(alice.iss, undefined);
    const grants = (await operator('grants')).body.result;
    assert.deepEqual(grants.map((g) => [g.bot, g.resourceAccess.projects]).sort(), [[T('alice'), ['/home/c/code/Alpha']], [T('bob'), ['/home/c/code/Beta', '/home/c/code/Gamma']]]);
    const r = await init(alice);
    aliceSid = r.sid;
    assert.match(r.body.result.instructions, /resource-delegated/);
    assert.match(r.body.result.instructions, /no access to .*Brain/);
    const list = await mcp(alice.prefix, alice.access_token, 'tools/list', {}, { sid: aliceSid });
    assert.deepEqual(list.body.result.tools.map((t) => t.name).sort(), [...TENANT_TOOLS].sort());
    for (const t of list.body.result.tools) for (const k of ['host', 'hosts', 'bot', 'agent', 'actor', 'tenant', 'requester', 'resourceAccess']) assert.equal(t.inputSchema.properties[k], undefined, `${t.name} takes ${k}`);
    const me = await tool(alice, 'drover_whoami', {}, { sid: aliceSid });
    assert.equal(me.data.you, `grok:${T('alice')}`);
    assert.deepEqual(me.data.connection.resourceAccess, ALICE);
  });

  test('fleet and search: each tenant sees only its exact projects on its approved hosts, never coverage or other bots', async () => {
    calls.length = 0;
    const af = (await tool(alice, 'drover_fleet', {}, { sid: aliceSid })).data;
    assert.deepEqual(af.hosts.map((h) => h.host), ['box-a']);
    assert.deepEqual(af.hosts[0].sessions.map((s) => s.id).sort(), ['a1']);
    assert.equal(af.hosts[0].counts.total, 1);
    assert.equal(af.ts, undefined);
    assert.deepEqual(calls.find((c) => c.op === 'fleet.summary').args, { hosts: ['local'] });
    const bs = await init(bob);
    const bf = (await tool(bob, 'drover_fleet', {}, { sid: bs.sid })).data;
    assert.deepEqual(bf.hosts.map((h) => [h.host, h.sessions.map((s) => s.id)]), [['box-a', ['b1']], ['box-b', ['g1']]]);
    assert.ok(!JSON.stringify(bf).includes(`grok:${T('bob')}`), 'no bot sessions, even its own');

    calls.length = 0;
    const as = await tool(alice, 'drover_search', { query: 'work' }, { sid: aliceSid });
    assert.equal(as.isError, false);
    // Hits are named by session: a transcript's title is its whole session's, so it is withheld.
    assert.deepEqual(as.data.results.map((h) => [h.sessionId, h.title]), [['sa', null]]);
    for (const k of ['coverage', 'perHost', 'searched', 'ms']) assert.equal(as.data[k], undefined, k);
    assert.ok(!as.text.includes('secret') && !as.text.includes('vault'), 'no coverage or host inventory');
    assert.deepEqual(calls.map((c) => [c.op, c.args.repoIdentity, c.args.hosts]), [['search.fleet', '/home/c/code/Alpha', ['local']]]);
    const bsr = await tool(bob, 'drover_search', { query: 'work' }, { sid: bs.sid });
    assert.deepEqual(bsr.data.results.map((h) => h.sessionId).sort(), ['sb', 'sg']);

    calls.length = 0;
    for (const args of [{ query: 'x', project: '/home/c/code/Beta' }, { query: 'x', project: '/home/c/code/Alpha-secret' }, { query: 'x', project: '/home/c/code/alpha' }, { query: 'x', project: '*' }, { query: 'x', project: '/secret/Alpha' }]) {
      const r = await tool(alice, 'drover_search', args, { sid: aliceSid });
      assert.equal(r.isError, true, JSON.stringify(args));
      assert.equal(r.text, 'access denied or scoped operation unavailable');
    }
    assert.equal(calls.length, 0, 'refused before dispatch');
    // Tool arguments are never authority: no host selection, no smuggled policy.
    for (const args of [{ host: 'box-b' }, { hosts: ['box-b'] }, { resourceAccess: BOB }]) {
      const r = await tool(alice, 'drover_fleet', args, { sid: aliceSid });
      assert.equal(r.isError, true, JSON.stringify(args));
    }
    assert.equal(calls.length, 0);
  });

  test('cross-project ids: reflections, features and notes of another tenant are refused before any id-based read or write', async () => {
    // Features in the WAL: one per tenant, one from an unknown host, and one moved from Beta into Alpha.
    await events.append({ type: 'feature', fid: 'feat-alpha', repo: '/home/c/code/Alpha', title: 'alpha feature', state: 'in-progress' }, { actor: OWNER });
    await events.append({ type: 'feature', fid: 'feat-beta', repo: '/home/c/code/Beta', title: 'beta feature', state: 'in-progress' }, { actor: OWNER });
    await events.append({ type: 'feature', fid: 'feat-moved', repo: '/home/c/code/Beta', title: 'started in beta' }, { actor: OWNER });
    await events.append({ type: 'feature', fid: 'feat-moved', repo: '/home/c/code/Alpha' }, { actor: OWNER });
    calls.length = 0;
    const af = await tool(alice, 'drover_features', {}, { sid: aliceSid });
    assert.deepEqual(af.data.features.map((f) => f.fid), ['feat-alpha']);
    assert.equal((await tool(alice, 'drover_features', { repo: '/home/c/code/Beta' }, { sid: aliceSid })).isError, true);
    const bf = await init(bob);
    assert.deepEqual((await tool(bob, 'drover_features', {}, { sid: bf.sid })).data.features.map((f) => f.fid).sort(), ['feat-beta']);

    for (const id of ['r-beta', 'r-alpha-box-b', 'r-alpha-wt', 'r-alpha-cwd', 'r-alpha-gamma', 'r-alp', 'missing']) {
      const r = await tool(alice, 'drover_reflections', { action: 'show', repo: '/home/c/code/Alpha', id }, { sid: aliceSid });
      assert.equal(r.isError, true, id);
    }
    assert.equal((await tool(alice, 'drover_reflections', { action: 'show', repo: '/home/c/code/Beta', id: 'r-beta' }, { sid: aliceSid })).isError, true);
    assert.ok(!calls.some((c) => c.op === 'reflections.show'), 'no global id lookup for an id outside the tenant');
    const ok = await tool(alice, 'drover_reflections', { action: 'show', repo: '/home/c/code/Alpha', id: 'r-alpha' }, { sid: aliceSid });
    assert.equal(ok.data.title, 'alpha lesson');
    const listed = await tool(alice, 'drover_reflections', { action: 'list', repo: '/home/c/code/Alpha' }, { sid: aliceSid });
    assert.deepEqual(listed.data.items.map((x) => x.id), ['r-alpha']);

    const before = (await wal()).length;
    for (const args of [{ repo: '/home/c/code/Alpha', fid: 'feat-beta', notes: 'x' }, { repo: '/home/c/code/Beta', fid: 'feat-beta', notes: 'x' }, { repo: '/home/c/code/Alpha', fid: 'feat-moved', notes: 'x' }, { repo: '/home/c/code/Alpha', fid: 'feat-nope', notes: 'x' }]) {
      assert.equal((await tool(alice, 'drover_feature_upsert', args, { sid: aliceSid })).isError, true, JSON.stringify(args));
    }
    assert.equal((await tool(alice, 'drover_note', { repo: '/home/c/code/Alpha', about: 'feat-beta', text: 'x' }, { sid: aliceSid })).isError, true);
    assert.equal((await tool(alice, 'drover_note', { repo: '/home/c/code/Beta', text: 'x' }, { sid: aliceSid })).isError, true);
    assert.equal((await wal()).length, before, 'nothing written');
    const up = await tool(alice, 'drover_feature_upsert', { repo: '/home/c/code/Alpha', fid: 'feat-alpha', notes: 'progress' }, { sid: aliceSid });
    assert.equal(up.isError, false);
    const ev = (await wal()).at(-1);
    assert.equal(ev.actor, `grok:${T('alice')}`);
    assert.equal(ev.host, 'box-a');
    assert.deepEqual(ev.delegation, { tenant: 'alice', bot: T('alice'), requester: ALICE.requester, grantId: alice.grantId });
    assert.match(ev.notes, new RegExp(`^\\[untrusted: grok:${re(T('alice'))}\\]`));
  });

  test('inbox: only direct messages to this tenant, never broadcasts or another tenant; replies refuse foreign ids', async () => {
    const toAlice = await events.append({ type: 'message', to: { kind: 'grok', host: 'box-a', id: `grok:${T('alice')}` }, text: 'for alice', ref: 'm-alice' }, { actor: OWNER });
    await events.append({ type: 'message', to: { kind: 'grok', host: 'box-a', id: `grok:${T('bob')}` }, text: 'for bob', ref: 'm-bob' }, { actor: OWNER });
    await events.append({ type: 'message', to: { kind: 'grok', host: 'box-a', id: 'grok:*' }, text: 'for everyone', ref: 'm-all' }, { actor: OWNER });
    const box = (await tool(alice, 'drover_inbox', {}, { sid: aliceSid })).data;
    assert.deepEqual(box.messages.map((m) => m.text), ['for alice']);
    assert.equal(box.messages[0].broadcast, false);
    assert.equal((await tool(alice, 'drover_whoami', {}, { sid: aliceSid })).data.inbox.unanswered, 1);
    const before = (await wal()).length;
    for (const messageId of ['m-bob', 'm-all', 'nope']) assert.equal((await tool(alice, 'drover_reply', { messageId, text: 'hi' }, { sid: aliceSid })).isError, true, messageId);
    assert.equal((await wal()).length, before);
    const r = await tool(alice, 'drover_reply', { messageId: 'm-alice', text: 'on it' }, { sid: aliceSid });
    assert.equal(r.data.inReplyTo, 'm-alice');
    const ev = (await wal()).at(-1);
    assert.equal(ev.type, 'chat'); assert.equal(ev.actor, `grok:${T('alice')}`);
    assert.equal(ev.delegation.requester, ALICE.requester);
    assert.equal(toAlice.to.id, `grok:${T('alice')}`);
    const bs = await init(bob);
    const bbox = (await tool(bob, 'drover_inbox', {}, { sid: bs.sid })).data;
    assert.deepEqual(bbox.messages.map((m) => m.text), ['for bob'], 'bob does not see alice\'s message or her answer');
    // No tenant tool ever reached the Brain, notify, or an arbitrary op.
    assert.ok(!calls.some((c) => /^(brain|notify|sessions|launch|tmux|host|ops)\./.test(c.op)), JSON.stringify(calls.map((c) => c.op)));
  });

  test('one tenant\'s token is refused on the other\'s server; on the root /mcp it is still only that tenant', async () => {
    assert.equal((await mcp(`/bots/${T('bob')}`, alice.access_token, 'initialize', { protocolVersion: '2025-06-18' })).status, 401);
    assert.equal((await mcp('/bots/alpha', alice.access_token, 'initialize', { protocolVersion: '2025-06-18' })).status, 401);
    const r = await init(alice, '');
    const me = await tool(alice, 'drover_whoami', {}, { sid: r.sid, prefix: '' });
    assert.equal(me.data.connection.bot, T('alice'));
    assert.deepEqual(me.data.connection.resourceAccess, ALICE);
    const list = await mcp('', alice.access_token, 'tools/list', {}, { sid: r.sid });
    assert.ok(!list.body.result.tools.some((t) => /brain|notify/.test(t.name)));
    // Another grant's session id is not a way in.
    const bs = await init(bob);
    assert.equal((await mcp(alice.prefix, alice.access_token, 'tools/list', {}, { sid: bs.sid })).status, 404);
  });

  test('refresh, daemon restart and MCP reconnect keep exactly the approved delegation', async () => {
    const res = await refresh(alice);
    assert.equal(res.status, 200);
    alice = { ...alice, ...(await res.json()) };
    // A daemon restart: OAuth state reloads from disk, MCP sessions are gone.
    oauth._reset(); _resetSessions();
    assert.equal((await mcp(alice.prefix, alice.access_token, 'tools/list', {}, { sid: aliceSid })).status, 404, 'initialize again');
    const r = await init(alice);
    aliceSid = r.sid;
    const me = await tool(alice, 'drover_whoami', {}, { sid: aliceSid });
    assert.deepEqual(me.data.connection.resourceAccess, ALICE);
    assert.deepEqual(me.data.connection.scopes, ['drover.read', 'drover.write']);
    const again = await refresh(alice);
    assert.equal(again.status, 200);
    alice = { ...alice, ...(await again.json()) };
    assert.deepEqual((await tool(alice, 'drover_search', { query: 'x' })).data.results.map((h) => h.sessionId), ['sa'], 'stateless call after refresh');
  });

  test('a stored policy that went missing or malformed fails closed: no MCP, no refresh, never legacy', async () => {
    for (const [tenant, tamper] of [['carol', (g) => { delete g.resourceAccess; }], ['dave', (g) => { g.resourceAccess.projects = ['*']; }], ['erin', (g) => { g.resourceAccess = { ...g.resourceAccess, tenant: 'alice', bot: T('alice') }; }], ['frank', (g) => { g.resourceAccess.extra = 1; }]]) {
      const policy = { version: 1, tenant, bot: T(tenant), requester: `user:${tenant}`, projects: ['/home/c/code/Alpha'], hosts: ['box-a'] };
      const t = await connectTenant(policy);
      await init(t);
      const file = oauth._deps.file();
      const d = JSON.parse(await readFile(file, 'utf8'));
      tamper(d.grants[t.grantId]);
      await writeFile(file, JSON.stringify(d));
      oauth._reset(); _resetSessions();
      const r = await mcp(t.prefix, t.access_token, 'initialize', { protocolVersion: '2025-06-18' });
      assert.equal(r.status, 401, tenant);
      assert.equal((await refresh(t)).status, 400, tenant);
      assert.equal((await refresh(t)).status, 400, `${tenant}: still refused`);
    }
    // The others were not touched by the tamper-and-reload.
    assert.equal((await tool(alice, 'drover_whoami', {}, { sid: (await init(alice)).sid })).data.connection.bot, T('alice'));
  });

  test('revocation ends MCP at once, refresh too; revocation mid-request releases nothing', async () => {
    const r = await operator('revoke', { grantId: bob.grantId });
    assert.equal(r.status, 200);
    assert.equal((await mcp(bob.prefix, bob.access_token, 'initialize', { protocolVersion: '2025-06-18' })).status, 401);
    assert.equal((await refresh(bob)).status, 400);
    // A revocation that lands while the fleet read is in flight: the answer is withheld.
    const gina = await connectTenant({ version: 1, tenant: 'gina', bot: T('gina'), requester: 'user:gina', projects: ['/home/c/code/Alpha'], hosts: ['box-a'] });
    const s = await init(gina);
    duringFleet = async () => { duringFleet = null; await oauth.revokeGrant(gina.grantId); };
    const res = await req(`${gina.prefix}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${gina.access_token}`, 'content-type': 'application/json', 'mcp-session-id': s.sid }, body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'drover_fleet', arguments: {} } }) });
    assert.equal(res.status, 401);
    assert.ok(!(await res.text()).includes('alpha-work'));
  });

  test('the operator CLI: drover bots approve with exact --tenant/--requester/--projects/--hosts; partial or wildcard flags fail closed', async () => {
    await writeFile(path.join(STATE, 'daemon.json'), JSON.stringify({ url: `${api}/` }));
    const run = (args) => promisify(execFile)(process.execPath, [BIN, 'bots', ...args], { env: { ...process.env, DROVER_STATE: STATE } }).then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));
    const s = await startSignIn(T('hana'));
    const partial = await run(['approve', s.code, '--tenant', 'hana', '--projects', '/home/c/code/Alpha']);
    assert.notEqual(partial.code, 0);
    assert.match(partial.stderr, /native delegation requires --tenant, --requester, --projects and --hosts/);
    const missing = await run(['approve', s.code]);
    assert.notEqual(missing.code, 0, 'a tenant request with no delegation is refused by the daemon');
    for (const projects of ['Alpha', 'Alpha*', '/home/c/code/Alpha,', '*', '/home/c/code/Alpha, /home/c/code/Beta', '/home/c/code/../Alpha']) {
      const r = await run(['approve', s.code, '--tenant', 'hana', '--requester', 'user:hana', '--projects', projects, '--hosts', 'box-a']);
      assert.notEqual(r.code, 0, projects);
    }
    const wrongTenant = await run(['approve', s.code, '--tenant', 'alice', '--requester', 'user:hana', '--projects', '/home/c/code/Alpha', '--hosts', 'box-a']);
    assert.notEqual(wrongTenant.code, 0);
    assert.ok(oauth.pendingList().some((p) => p.code === s.code));
    const ok = await run(['approve', s.code, '--tenant', 'hana', '--requester', 'user:hana', '--projects', '/home/c/code/Alpha,/home/c/code/Gamma', '--hosts', 'box-a', '--scope', 'read']);
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, new RegExp(`approved: OpenClaw as ${re(T('hana'))} \\[drover\\.read\\]`));
    assert.match(ok.stdout, /tenant hana requester user:hana projects \[\/home\/c\/code\/Alpha,\/home\/c\/code\/Gamma\] hosts \[box-a\]/);
    const t = await finishSignIn(s);
    const sid = (await init(t)).sid;
    const list = await mcp(t.prefix, t.access_token, 'tools/list', {}, { sid });
    assert.deepEqual(list.body.result.tools.map((x) => x.name).sort(), ['drover_features', 'drover_fleet', 'drover_inbox', 'drover_reflections', 'drover_search', 'drover_whoami'], 'read scope: no write tools');
    const grants = await run(['grants']);
    assert.match(grants.stdout, new RegExp(`${re(T('hana'))} .*projects \\[/home/c/code/Alpha,/home/c/code/Gamma\\] hosts \\[box-a\\]`));
  });

  test('legacy bots are unchanged: alpha approved without delegation keeps the legacy tools; shared still works', async () => {
    const s = await startSignIn('alpha');
    const r = await operator('approve', { code: s.code });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.result.resourceAccess, undefined);
    assert.deepEqual(r.body.result.scopes, ['drover.read', 'drover.write', 'drover.notify']);
    const t = await finishSignIn(s);
    const i = await init(t);
    assert.doesNotMatch(i.body.result.instructions, /resource-delegated/);
    const names = (await mcp(t.prefix, t.access_token, 'tools/list', {}, { sid: i.sid })).body.result.tools.map((x) => x.name);
    for (const n of ['drover_brain_search', 'drover_brain_get', NOTIFY_TOOL, 'drover_fleet']) assert.ok(names.includes(n), n);
    assert.equal((await refresh(t)).status, 200);
    const sh = await startSignIn(null);
    const shared = await operator('approve', { code: sh.code, shared: true });
    assert.equal(shared.status, 200);
    assert.deepEqual(shared.body.result.scopes, ['drover.read']);
    const st = await finishSignIn(sh);
    const si = await init(st);
    const snames = (await mcp('', st.access_token, 'tools/list', {}, { sid: si.sid })).body.result.tools.map((x) => x.name);
    assert.ok(snames.includes('drover_brain_search') && !snames.includes('drover_status'));
    // A static token for a legacy bot needs no delegation; for a tenant it carries it.
    assert.equal((await operator('token', { bot: 'bravo' })).status, 200);
    const tok = await operator('token', { bot: T('ivy'), resourceAccess: { version: 1, tenant: 'ivy', bot: T('ivy'), requester: 'user:ivy', projects: ['/home/c/code/Alpha'], hosts: ['box-a'] } });
    assert.equal(tok.status, 200);
    assert.deepEqual(tok.body.result.scopes, ['drover.read', 'drover.write']);
    const ivy = { access_token: tok.body.result.token, prefix: `/bots/${T('ivy')}` };
    const ii = await init(ivy);
    assert.deepEqual((await tool(ivy, 'drover_whoami', {}, { sid: ii.sid })).data.connection.resourceAccess.projects, ['/home/c/code/Alpha']);
  });
});
