// A Grok bot's needs-owner or blocked status, and its urgent alert, also text the owner through the ask hub
// (core/ask/router.js page), once per same status per cooldown; a status that needs nobody withdraws what has not gone
// out; news (a non-urgent alert) and a muted bot are not texted. Fake SMS channel; every id is made up.
import './isolate-cache.js';
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const STATE = await mkdtemp(path.join(tmpdir(), 'drover-bots-page-'));
const EVENTS = path.join(STATE, 'events.jsonl');
await writeFile(EVENTS, '');
Object.assign(process.env, { DROVER_STATE: STATE, DROVER_EVENTS: EVENTS, DROVER_PAIR_NOTIFY: 'off', DROVER_HOST: 'hub', DROVER_ASK_HUB: 'hub', DROVER_ASK_QUIET: 'off', DROVER_OWNER: 'owner', DROVER_OWNER_NAME: 'Owner', DROVER_WORK_CONTEXT: 'none' });
delete process.env.DROVER_ALLOW_ORIGINS;
delete process.env.DROVER_ASK_PAGES;
const tools = await import('../core/bots/tools.js');
const grok = await import('../core/bots/grok.js');
const { router, _deps: routerDeps } = await import('../core/ask/router.js');
const { foldAsks } = await import('../core/ask/model.js');
const events = await import('../core/events.js');
const { createServer: createMcpServer } = await import('../mcp/server.js');

const texts = [];
const saved = {};
before(() => {
  saved.channels = routerDeps.channels;
  routerDeps.channels = { sms: { configured: () => true, send: async ({ text }) => { texts.push(text); return { providerId: `SM${texts.length}` }; } }, telegram: { configured: () => false }, imessage: { configured: () => false } };
  router.running = true;   // the hub's router, without its tick or watchers
});
after(() => { routerDeps.channels = saved.channels; router.running = false; });
beforeEach(() => { tools._resetAlerts(); grok._resetCache(); });

async function dispatch(op, args) {
  if (op === 'notify.send') return { ok: true };
  if (op === 'events.append') return events.append(args.event, { actor: args.actor });
  throw new Error(`unexpected op ${op}`);
}
async function call(bot, name, args) {
  const grant = { grantId: `g-${bot}`, clientName: 'Grok Bot', bot, scopes: ['drover.read', 'drover.write', 'drover.notify'] };
  const server = createMcpServer({ dispatch, log: () => {}, tools: tools.botTools(grant, { dispatch, host: 'hub' }), resources: [] });
  const out = await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  assert.equal(out.result.isError, false, out.result.content[0].text);
  return JSON.parse(out.result.content[0].text);
}
const pages = async () => [...foldAsks(await events.readAll()).pages.values()];

describe('bot statuses and alerts page the owner by SMS on the ask hub', () => {
  test('needs-owner texts once; the same status again is not texted again', async () => {
    await call('alpha', 'drover_status', { state: 'needs-owner', summary: 'approve the deploy?' });
    assert.equal(texts.length, 1);
    assert.match(texts[0], /Alpha needs you: approve the deploy\?/);
    await call('alpha', 'drover_status', { state: 'needs-owner', summary: 'approve the deploy?' });
    assert.equal(texts.length, 1, 'deduplicated inside the cooldown');
  });

  test('blocked texts too (another bot: its own source)', async () => {
    await call('bravo', 'drover_status', { state: 'blocked', summary: 'ssh to the Mac fails' });
    assert.equal(texts.length, 2);
    assert.match(texts[1], /Bravo is blocked: ssh to the Mac fails/);
  });

  test('working and done are not texted; they withdraw a page that has not gone out', async () => {
    // A page of charlie's held by the gap (it texted a minute ago): then charlie moves on.
    await call('charlie', 'drover_status', { state: 'needs-owner', summary: 'first' });
    await call('charlie', 'drover_status', { state: 'needs-owner', summary: 'second' });
    const before = texts.length;
    const held = (await pages()).filter((p) => p.source === 'grok:charlie' && !p.sentAt);
    assert.equal(held.length, 1);
    await call('charlie', 'drover_status', { state: 'done', summary: 'sorted it myself' });
    assert.equal(texts.length, before);
    assert.ok((await pages()).find((p) => p.pageId === held[0].pageId).withdrawnAt);
  });

  test('an urgent drover_notify_owner is texted as URGENT; a non-urgent one (news) is not', async () => {
    const n = texts.length;
    await call('delta', 'drover_notify_owner', { title: 'PR merged', body: 'all green' });
    assert.equal(texts.length, n);
    await call('delta', 'drover_notify_owner', { title: 'Card declined', body: 'need a new card', urgent: true });
    assert.equal(texts.length, n + 1);
    assert.match(texts.at(-1), /URGENT Delta: Card declined: need a new card/);
  });

  test('DROVER_ASK_PAGES=off: the alert still goes, no text', async () => {
    process.env.DROVER_ASK_PAGES = 'off';
    try {
      const n = texts.length;
      const r = await call('echo', 'drover_status', { state: 'needs-owner', summary: 'x' });
      assert.equal(r.alerted, true);
      assert.equal(texts.length, n);
    } finally { delete process.env.DROVER_ASK_PAGES; }
  });
});
