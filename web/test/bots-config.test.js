// The bot gateway on a configured fleet: an owner (DROVER_OWNER, DROVER_OWNER_NAME) and a native tenant prefix
// (DROVER_TENANT_PREFIX) other than the defaults. The canonical wire values are generic (needs-owner,
// drover_notify_owner, <prefix>-<tenant>); the spellings bots were taught before the owner was configuration
// (needs-<owner>, drover_notify_<owner>) keep working, and prose names the owner as configured.
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

const STATE = await mkdtemp(path.join(tmpdir(), 'drover-bots-config-'));
const EVENTS = path.join(STATE, 'events.jsonl');
await writeFile(EVENTS, '');
process.env.DROVER_STATE = STATE;
process.env.DROVER_EVENTS = EVENTS;
process.env.DROVER_PAIR_NOTIFY = 'off';
process.env.DROVER_HOST = 'box-a';
process.env.DROVER_OWNER = 'dana';
process.env.DROVER_OWNER_NAME = 'Dana';
process.env.DROVER_TENANT_PREFIX = 'claw';
delete process.env.DROVER_ALLOW_ORIGINS;
const access = await import('../core/bots/access.js');
const grok = await import('../core/bots/grok.js');
const tools = await import('../core/bots/tools.js');
const { TENANT_INSTRUCTIONS } = await import('../core/bots/tenant-tools.js');
const oauth = await import('../core/bots/oauth.js');
const events = await import('../core/events.js');
const native = await import('../core/native.js');
const http = await import('../server/http.js');
const { startBotGateway } = await import('../server/botgate.js');
const { createServer: createMcpServer } = await import('../mcp/server.js');
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'drover');

const wal = async () => (await readFile(EVENTS, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const calls = [];
async function dispatch(op, args) {
  calls.push({ op, args });
  if (op === 'notify.send') return { ok: true };
  if (op === 'events.append') return events.append(args.event, { actor: args.actor });
  throw new Error(`unexpected op ${op}`);
}
/** One MCP tools/call through the server the gateway builds, so the schema (enum) is checked as a bot's call is. */
async function call(grant, name, args) {
  const server = createMcpServer({ dispatch, log: () => {}, tools: tools.botTools(grant, { dispatch, host: 'box-a' }), resources: [] });
  const out = await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const r = out.result;
  return { isError: r.isError, text: r.content[0].text, data: (() => { try { return JSON.parse(r.content[0].text); } catch { return null; } })() };
}
const ALPHA = { grantId: 'g-alpha', clientName: 'Grok Bot', bot: 'alpha', scopes: ['drover.read', 'drover.write', 'drover.notify'] };

describe('a configured owner: needs-owner and drover_notify_owner, with the owner\'s old spellings still served', () => {
  test('the states: needs-owner is canonical, needs-dana is accepted as it, nothing else is', () => {
    assert.deepEqual(grok.STATES, ['working', 'idle', 'blocked', 'needs-owner', 'done']);
    assert.deepEqual(grok.ACCEPTED_STATES, [...grok.STATES, 'needs-dana']);
    assert.equal(grok.canonicalState('needs-dana'), 'needs-owner');
    assert.equal(grok.canonicalState('needs-erin'), 'needs-erin', 'only the configured owner\'s spelling');
    assert.deepEqual(grok.legacyStates('owner'), [], 'the default owner has no legacy spelling');
  });

  test('a bot that reports needs-dana is recorded as needs-owner, waits on the board and alerts the owner', async () => {
    tools._resetAlerts(); grok._resetCache();
    const r = await call(ALPHA, 'drover_status', { state: 'needs-dana', summary: 'which region?' });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.alerted, true);
    assert.deepEqual(calls.at(-1).args, { title: 'Alpha needs you', body: 'which region?', category: 'needs-you', sessionId: 'grok:alpha', name: 'Alpha', actor: 'grok:alpha' });
    assert.equal((await wal()).at(-1).state, 'needs-owner');
    assert.match((await call(ALPHA, 'drover_status', { state: 'needs-erin', summary: 'x' })).text, /must be one of/);
  });

  test('a needs-dana status already in the truth file reads as needs-owner and waits', async () => {
    await events.append({ type: 'status', agent: 'grok:bravo', state: 'needs-dana', summary: 'old spelling', source: 'grok:bravo', untrusted: true }, { actor: 'grok:bravo' });
    grok._resetCache();
    const [s] = (await grok.listSessions()).filter((x) => x.id === 'grok:bravo');
    assert.deepEqual([s.state, s.status], ['needs-owner', 'waiting']);
    const t = await grok.transcript('grok:bravo');
    assert.equal(t.turns.at(-1).text, 'status needs-owner: old spelling');
  });

  test('the alert tool is drover_notify_owner, and drover_notify_dana is the same tool under its old name', async () => {
    tools._resetAlerts();
    const names = tools.botTools(ALPHA, { dispatch }).map((t) => t.name);
    assert.ok(names.includes('drover_notify_owner') && names.includes('drover_notify_dana'), names.join(', '));
    assert.equal(tools.LEGACY_NOTIFY_TOOL, 'drover_notify_dana');
    assert.equal(tools.legacyNotifyTool('owner'), null);
    for (const name of ['drover_notify_owner', 'drover_notify_dana']) {
      const r = await call(ALPHA, name, { title: 'build is red', urgent: true });
      assert.equal(r.isError, false, r.text);
      assert.deepEqual(calls.at(-1).args, { title: 'Alpha: build is red', body: '', category: 'needs-you', sessionId: 'grok:alpha', name: 'Alpha', actor: 'grok:alpha' });
    }
    const readOnly = tools.botTools({ ...ALPHA, scopes: ['drover.read', 'drover.write'] }, { dispatch }).map((t) => t.name);
    assert.ok(!readOnly.some((n) => n.startsWith('drover_notify')), 'neither name without the notify scope');
  });

  test('the brain tools, and the instructions that name them, only where a plugin provides the brain ops', () => {
    const all = tools.botTools(ALPHA, { dispatch }).map((t) => t.name);
    assert.deepEqual(all.filter((n) => n.startsWith('drover_brain_')).sort(), ['drover_brain_get', 'drover_brain_note', 'drover_brain_search']);
    const without = tools.botTools(ALPHA, { dispatch, hasOp: (op) => !op.startsWith('brain.') }).map((t) => t.name);
    assert.deepEqual(without, all.filter((n) => !n.startsWith('drover_brain_')));
    assert.equal(tools.instructionsFor(), tools.INSTRUCTIONS);
    const plain = tools.instructionsFor({ brain: false });
    assert.doesNotMatch(plain, /brain|save memories|and saved/);
    assert.match(plain, /Save durable learnings with drover_note\./);
  });

  test('prose names the owner as configured, never "the owner"', () => {
    for (const text of [grok.ROUTINE_PROMPT, tools.INSTRUCTIONS, TENANT_INSTRUCTIONS]) {
      assert.match(text, /Dana's/);
      assert.doesNotMatch(text, /the owner/);
    }
    assert.match(grok.ROUTINE_PROMPT, /"needs-owner" with what you need if you are blocked on Dana/);
    assert.match(tools.INSTRUCTIONS, /drover_notify_owner only when you need Dana in person/);
    assert.deepEqual(grok.webhookBody('drover.message', 'alpha', { ref: 'r', text: 'hi' }).from, { actor: 'dana', name: 'Dana' });
    assert.deepEqual(grok.webhookBody('drover.message', 'alpha', { ref: 'r', text: 'hi', actor: 'owner' }).from, { actor: 'owner', name: 'Dana' });
    assert.deepEqual(grok.webhookBody('drover.message', 'alpha', { ref: 'r', text: 'hi', actor: 'mcp' }).from, { actor: 'mcp', name: 'mcp' });
  });
});

describe('a configured tenant prefix: claw-<tenant> bots are native tenants, other names are not', () => {
  const policy = (patch = {}) => ({ version: 1, tenant: 'acme', bot: 'claw-acme', requester: 'user:acme', projects: ['/code/Alpha'], hosts: ['box-a'], ...patch });

  test('the prefix, its validation and what it makes a tenant', () => {
    assert.equal(access.TENANT_PREFIX, 'claw');
    assert.equal(access.tenantBot('acme'), 'claw-acme');
    assert.equal(access.isTenantBot('claw-acme'), true);
    assert.equal(access.isTenantBot('tenant-acme'), false, 'the default prefix is nothing special once another is set');
    assert.deepEqual(access.resourceAccess('claw-acme', policy()), policy());
    assert.throws(() => access.resourceAccess('tenant-acme', policy({ bot: 'tenant-acme' })), /exact claw-<tenant> principal/);
    assert.throws(() => access.accessForGrant({ bot: 'claw-acme' }), /invalid resource delegation/, 'a tenant without a delegation fails closed');
    assert.equal(access.accessForGrant({ bot: 'tenant-acme' }), null, 'a legacy bot');
    const warned = [];
    const warn = (m) => warned.push(m);
    assert.equal(access.tenantPrefix({}, warn), 'tenant');
    assert.equal(access.tenantPrefix({ DROVER_TENANT_PREFIX: ' Acme ' }, warn), 'acme');
    assert.equal(access.tenantPrefix({ APXW_TENANT_PREFIX: 'old' }, warn), 'old', 'the legacy APXW_ spelling, like every DROVER_ variable');
    assert.deepEqual(warned, []);
    for (const bad of ['a b', 'x-y', '9lives', 'a'.repeat(17), 'claw!']) assert.equal(access.tenantPrefix({ DROVER_TENANT_PREFIX: bad }, warn), 'tenant', bad);
    assert.equal(warned.length, 5);
    assert.match(warned[0], /DROVER_TENANT_PREFIX "a b" is not a lowercase word/);
  });

  test('approval: claw-acme needs its delegation and loses notify; tenant-acme is a legacy bot', async () => {
    oauth._reset();
    const request = async (bot) => {
      const c = await oauth.register({ client_name: 'OpenClaw', redirect_uris: ['https://app.example/cb'] });
      const challenge = createHash('sha256').update('v'.repeat(43)).digest('base64url');
      return oauth.createAuthorization({ response_type: 'code', client_id: c.client_id, redirect_uri: 'https://app.example/cb', code_challenge: challenge, code_challenge_method: 'S256' }, { bot });
    };
    await assert.rejects(oauth.approve((await request('claw-acme')).code, {}), /invalid resource delegation/);
    const ok = await oauth.approve((await request('claw-acme')).code, { resourceAccess: policy() });
    assert.deepEqual([ok.bot, ok.scopes, ok.resourceAccess.bot], ['claw-acme', ['drover.read', 'drover.write'], 'claw-acme']);
    const legacy = await oauth.approve((await request('tenant-acme')).code, {});
    assert.deepEqual([legacy.bot, legacy.resourceAccess, legacy.scopes.includes('drover.notify')], ['tenant-acme', undefined, true]);
    const denied = await request('alpha');
    oauth.deny(denied.code);
    assert.equal(new URL(oauth.authorizationStatus(denied.rid).redirect).searchParams.get('error_description'), 'Dana denied this request in Drover');
  });

  test('once a tenant, always a tenant: a bot that held a delegated grant is never approved without one again', async () => {
    oauth._reset();
    const request = async (bot) => {
      const c = await oauth.register({ client_name: 'OpenClaw', redirect_uris: ['https://app.example/cb'] });
      const challenge = createHash('sha256').update('v'.repeat(43)).digest('base64url');
      return oauth.createAuthorization({ response_type: 'code', client_id: c.client_id, redirect_uri: 'https://app.example/cb', code_challenge: challenge, code_challenge_method: 'S256' }, { bot });
    };
    // A tenant approved while this host's prefix was "old": its stored grant carries the delegation.
    await oauth.approve((await request('claw-acme')).code, { resourceAccess: policy() });
    const file = oauth._deps.file();
    const d = JSON.parse(await readFile(file, 'utf8'));
    for (const g of Object.values(d.grants)) if (g.bot === 'claw-acme') { g.bot = 'old-acme'; g.resourceAccess = { ...g.resourceAccess, bot: 'old-acme' }; }
    await writeFile(file, JSON.stringify(d));
    oauth._reset();
    // Now "old-acme" no longer carries the prefix, so it would read as one of the owner's own bots: refused instead.
    await assert.rejects(oauth.approve((await request('old-acme')).code, {}), /old-acme was approved as a native tenant before: approve it with its delegation .*DROVER_TENANT_PREFIX on this host \(now claw\)/);
    await assert.rejects(oauth.mintToken({ bot: 'old-acme' }), /old-acme was approved as a native tenant before/);
    const other = await oauth.approve((await request('beta')).code, {});
    assert.equal(other.bot, 'beta', 'a bot that never was a tenant is unaffected');
  });

  describe('through the gateway and the daemon', () => {
    let gw, srv, api;
    before(async () => {
      oauth._reset();
      native._deps.isDaemon = () => false;
      gw = await startBotGateway({ base: 'https://gw.test', port: 0, dispatch });
      srv = await http.startServer({ port: 0 });
      api = srv.url.replace(/\/$/, '');
      await writeFile(path.join(STATE, 'daemon.json'), JSON.stringify({ url: `${api}/` }));
    });
    after(async () => {
      await new Promise((r) => gw.server.close(r));
      await new Promise((r) => { srv.server.close(r); srv.server.closeAllConnections?.(); });
    });
    let addr = 0;
    const authorizePage = async (bot) => {
      // Each from its own address, as the proxy reports it: the gateway limits the approvals one address may hold.
      const from = { 'x-forwarded-for': `198.18.2.${++addr}` };
      const req = (p, init = {}) => fetch(new URL(p, gw.url), { redirect: 'manual', ...init, headers: { ...from, ...init.headers } });
      const reg = await (await req(`/bots/${bot}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'OpenClaw', redirect_uris: ['https://app.example/cb'] }) })).json();
      const challenge = createHash('sha256').update('v'.repeat(43)).digest('base64url');
      const res = await req(`/bots/${bot}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'https://app.example/cb', code_challenge: challenge, code_challenge_method: 'S256' })}`);
      assert.equal(res.status, 200);
      const pending = oauth.pendingList().at(-1);
      assert.equal(pending.bot, bot);
      return { html: await res.text(), code: pending.code };
    };

    test('the authorize page names the owner, and the tenant prefix decides what a bot is', async () => {
      assert.match((await authorizePage('alpha')).html, /<b>alpha<\/b>, one of Dana's bots,/);
      const tenant = await authorizePage('claw-acme');
      assert.match(tenant.html, /<b>claw-acme<\/b>, a native tenant,/);
      assert.match(tenant.html, /--tenant &lt;tenant&gt;/);
      assert.doesNotMatch((await authorizePage('tenant-acme')).html, /native tenant/);
    });

    test('drover bots approve from a shell without DROVER_TENANT_PREFIX takes the bot from the request, and the daemon checks it', async () => {
      const env = { ...process.env, DROVER_STATE: STATE };
      delete env.DROVER_TENANT_PREFIX;   // the daemon has it (its env file), the operator's shell does not
      const run = (args) => promisify(execFile)(process.execPath, [BIN, 'bots', ...args], { env }).then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));
      const flags = ['--requester', 'user:hana', '--projects', '/code/Alpha', '--hosts', 'box-a'];
      const s = await authorizePage('claw-hana');
      const wrong = await run(['approve', s.code, '--tenant', 'ivy', ...flags]);
      assert.notEqual(wrong.code, 0, 'another tenant than the request\'s is refused');
      const ok = await run(['approve', s.code, '--tenant', 'hana', ...flags]);
      assert.equal(ok.code, 0, ok.stderr);
      assert.match(ok.stdout, /approved: OpenClaw as claw-hana \[drover\.read drover\.write\]/);
      // A static token names its bot with --as; the default prefix of the shell is never used for it.
      const tok = await run(['token', '--as', 'claw-ivy', '--tenant', 'ivy', ...flags.map((f) => f.replace('hana', 'ivy'))]);
      assert.equal(tok.code, 0, tok.stderr);
      assert.match(tok.stdout, /grant grant_\S+: claw-ivy \[drover\.read drover\.write\]/);
      const help = await promisify(execFile)(process.execPath, [BIN, 'help'], { env });
      assert.match(help.stdout, /--as <prefix>-<tenant> .*\n.*DROVER_TENANT_PREFIX/);
    });
  });
});
