// Whose prompts are whose (core/prompts.js): the collector tells a person's Drover message from an agent's by the
// truth-file actor, collects the owner's messages to the fleet manager, and a read record carries mine and marked:
// prompt-mark events (prompts.mark) decide first, the via otherwise, an unknown via is mine. prompts.local's who
// filters, and prompts.list hands the front's marks to every host and classifies a host's records from older code.
// Synthetic transcripts and truth file in a temp dir; nothing reads the user's.
import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fakePeer } from './fake-peer.js';

const tmp = await mkdtemp(path.join(tmpdir(), 'drover-prompts-mine-'));
const HOME = '/home/example';
Object.assign(process.env, {
  DROVER_CACHE: path.join(tmp, 'cache'), DROVER_STATE: path.join(tmp, 'state'), DROVER_DOTFILES: path.join(tmp, 'dotfiles'),
  DROVER_EVENTS: path.join(tmp, 'dotfiles', 'claude', 'drover-events.jsonl'), DROVER_HOST: 'box-a',
  DROVER_PROMPTS_CONFIG: path.join(tmp, 'prompts.json'), CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'), CODEX_HOME: path.join(tmp, 'codex'),
});
await mkdir(path.join(tmp, 'dotfiles', 'claude'), { recursive: true });
await writeFile(path.join(tmp, 'dotfiles', 'claude', 'fleet-hosts.txt'), 'box-b\n');
await writeFile(process.env.DROVER_EVENTS, '');
await writeFile(process.env.DROVER_PROMPTS_CONFIG, '{}');
const P = await import('../core/prompts.js');
const api = await import('../core/api.js');
const events = await import('../core/events.js');
const remote = await import('../core/remote.js');
const { META, isMutating } = await import('../core/ops-meta.js');
const { generatedTools } = await import('../mcp/server.js');
after(async () => { remote.stopAll(); await rm(tmp, { recursive: true, force: true }); });

const J = (o) => JSON.stringify(o);
const cl = (o) => J({ parentUuid: null, isSidechain: false, userType: 'external', entrypoint: 'cli', cwd: `${HOME}/code/app`, sessionId: 'c1', ...o });
const typed = (uuid, timestamp, text, extra = {}) => cl({ type: 'user', message: { role: 'user', content: text }, uuid, timestamp, promptSource: 'typed', turnOrigin: 'human', ...extra });
const queued = (uuid, timestamp, text, origin) => cl({ type: 'attachment', attachment: { type: 'queued_command', prompt: text, origin, commandMode: 'prompt' }, uuid, timestamp });
const spool = async (dir) => (await Promise.all((await readdir(dir)).sort().map((n) => readFile(path.join(dir, n), 'utf8')))).join('').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const id = (n) => `p_${String(n).padStart(16, '0')}`;

describe('humanActor', () => {
  test('none, the owner, an owner client and cli are a person; mcp, the manager, a bot, an automation are not', () => {
    for (const a of [undefined, null, '', 'owner', 'web', 'tui', 'chrome', 'ios', 'cli', 'CLI']) assert.equal(P.humanActor(a), true, String(a));
    for (const a of ['mcp', 'manager', 'manager-mac', 'grok:helper', 'coordinator', 'worker-platform', 'drover']) assert.equal(P.humanActor(a), false, a);
  });
});

describe('the collector: who sent it', () => {
  const root = path.join(tmp, 'collect');
  const dir = path.join(root, 'spool'), offsets = path.join(root, 'offsets.json'), eventsFile = path.join(root, 'events.jsonl');
  const claude = path.join(root, 'claude', 'projects'), codex = path.join(root, 'codex', 'sessions');
  const make = () => new P.Collector({ env: { ...process.env, HOME }, roots: { claude, codex }, dir, offsets, host: 'box-a', eventsFile, identity: 'work', log: () => {} });
  before(async () => {
    const proj = path.join(claude, '-home-code-app');
    await mkdir(proj, { recursive: true }); await mkdir(codex, { recursive: true });
    await writeFile(path.join(proj, 'c1.jsonl'), [
      typed('u1', '2026-11-21T02:00:00.000Z', 'pasted by the owner'),
      typed('u2', '2026-11-21T02:10:00.000Z', 'pasted by an agent'),
      typed('u3', '2026-11-21T02:20:00.000Z', 'a tmux launch by an agent'),
      queued('u4', '2026-11-21T02:30:00.000Z', '', { kind: 'peer', name: 'drover (mcp)', body: 'an inbox message from an agent' }),
      queued('u5', '2026-11-21T02:40:00.000Z', '', { kind: 'peer', name: 'drover (web)', body: 'an inbox message from the web UI' }),
      typed('u6', '2026-11-21T02:50:00.000Z', 'typed with nothing in the truth file'),
    ].join('\n') + '\n');
    const ev = (n, ts, actor, body) => J({ id: `e${n}`, ts, host: 'box-a', actor, ...body });
    await writeFile(eventsFile, [
      ev(1, '2026-11-21T02:00:30.000Z', 'owner', { type: 'message', to: { kind: 'tmux', host: 'box-a', id: 'a:1' }, text: 'pasted by the owner', delivery: { ok: true } }),
      ev(2, '2026-11-21T02:10:30.000Z', 'mcp', { type: 'message', to: { kind: 'tmux', host: 'box-a', id: 'a:2' }, text: 'pasted by an agent', delivery: { ok: true } }),
      ev(3, '2026-11-21T02:19:00.000Z', 'mcp', { type: 'launch', engine: 'claude', mode: 'tmux', prompt: 'a tmux launch by an agent' }),
      ev(4, '2026-11-21T03:00:00.000Z', 'owner', { type: 'message', to: { kind: 'openclaw', host: 'box-a', id: 'manager', name: 'manager' }, text: 'manager, how is the fleet?', delivery: { ok: true, pending: true } }),
      ev(5, '2026-11-21T03:01:00.000Z', 'mcp', { type: 'message', to: { kind: 'openclaw', host: 'box-a', id: 'manager' }, text: 'an agent asks the manager', delivery: { ok: true } }),
      ev(6, '2026-11-21T03:02:00.000Z', 'owner', { type: 'message', to: { kind: 'openclaw', host: 'box-b', id: 'manager' }, text: 'the manager on another host', delivery: { ok: true } }),
      ev(7, '2026-11-21T03:03:00.000Z', 'owner', { type: 'message', to: { kind: 'openclaw', host: 'box-a', id: 'manager' }, text: 'not delivered', delivery: { ok: false } }),
      ev(8, '2026-11-21T03:04:00.000Z', 'owner', { type: 'message', to: { kind: 'openclaw', host: 'box-a', id: 'manager' }, thread: 'deploys', text: 'in a thread', delivery: { ok: true } }),
    ].join('\n') + '\n');
  });

  test('a message or tmux launch by an agent is agent, by a person drover; inbox relays by their actor; manager messages are collected', async () => {
    const c = make();
    const r = await c.scan();
    const by = Object.fromEntries((await spool(dir)).map((x) => [x.text, x]));
    assert.equal(r.added, Object.keys(by).length);
    assert.deepEqual([by['pasted by the owner'].via, by['pasted by the owner'].actor], ['drover', 'owner']);
    assert.deepEqual([by['pasted by an agent'].via, by['pasted by an agent'].actor], ['agent', 'mcp']);
    assert.deepEqual([by['a tmux launch by an agent'].via, by['a tmux launch by an agent'].actor], ['agent', 'mcp']);
    assert.deepEqual([by['an inbox message from an agent'].via, by['an inbox message from an agent'].actor], ['agent', 'mcp']);
    assert.deepEqual([by['an inbox message from the web UI'].via, by['an inbox message from the web UI'].actor], ['drover', 'web']);
    assert.equal(by['typed with nothing in the truth file'].via, 'typed'); assert.equal(by['typed with nothing in the truth file'].actor, undefined);
    const m = by['manager, how is the fleet?'];
    assert.deepEqual({ ...m, id: undefined }, { v: 1, id: undefined, ts: '2026-11-21T03:00:00.000Z', host: 'box-a', engine: 'openclaw', session: 'manager', cwd: null, project: null, label: 'work', via: 'manager', actor: 'owner', text: 'manager, how is the fleet?' });
    assert.equal(m.id, P.promptId({ host: 'box-a', engine: 'openclaw', session: 'manager', ref: 'e4', text: m.text }));
    assert.deepEqual([by['an agent asks the manager'].via, by['an agent asks the manager'].engine], ['agent', 'openclaw']);
    assert.equal(by['in a thread'].thread, 'deploys');
    assert.equal(by['the manager on another host'], undefined, 'that host collects its own');
    assert.equal(by['not delivered'], undefined);
    assert.equal((await make().scan()).added, 0, 'manager messages are written once');
  });
});

describe('classify: mine and marked', () => {
  const index = new P.TruthIndex({ file: path.join(tmp, 'none.jsonl'), host: 'box-a' });
  test('by via; an unknown via is mine; a mark decides; the overlay wins and null in it clears', () => {
    const r = (via, n = 1) => ({ id: id(n), ts: '2026-11-21T00:00:00.000Z', via, text: 'x' });
    assert.deepEqual(['typed', 'queued', 'drover', 'manager', 'peer', 'agent', 'headless', 'sdk', 'from-the-future'].map((v) => P.classify(r(v)).mine),
      [true, true, true, true, false, false, false, false, true]);
    assert.equal(P.classify(r('typed')).marked, false);
    index.marks.set(id(1), { mine: false }); index.marks.set(id(2), { mine: true });
    assert.deepEqual([P.classify(r('typed', 1), index), P.classify(r('sdk', 2), index)].map((x) => [x.mine, x.marked]), [[false, true], [true, true]]);
    assert.deepEqual(P.classify(r('typed', 1), index, { [id(1)]: true }).mine, true, 'the front\'s mark wins');
    const cleared = P.classify(r('typed', 1), index, { [id(1)]: null });
    assert.deepEqual([cleared.mine, cleared.marked], [true, false], 'the front took its mark back');
    const rec = r('typed'); P.classify(rec, index); assert.equal('mine' in rec, false, 'the stored record is not changed');
  });
  test('a drover record collected before actors were kept is matched again against the truth file', async () => {
    const file = path.join(tmp, 'legacy.jsonl');
    await writeFile(file, J({ id: 'e1', ts: '2026-11-21T00:00:10.000Z', host: 'box-a', actor: 'mcp', type: 'message', to: { kind: 'claude', host: 'box-a', id: 's' }, text: 'from an agent', delivery: { ok: true } }) + '\n');
    const ix = new P.TruthIndex({ file, host: 'box-a' }); await ix.refresh();
    const old = { id: id(3), ts: '2026-11-21T00:00:00.000Z', via: 'drover', text: 'from an agent' };
    assert.deepEqual(['via', 'actor', 'mine'].map((k) => P.classify(old, ix)[k]), ['agent', 'mcp', false]);
    assert.deepEqual(['via', 'mine'].map((k) => P.classify({ ...old, text: 'no event for it' }, ix)[k]), ['drover', true], 'in doubt: mine');
  });
});

describe('prompts.mark, who and the fan-out', () => {
  const dir = P.spoolDir();
  const VIAS = ['typed', 'queued', 'drover', 'manager', 'peer', 'agent', 'headless', 'sdk'];
  const rec = (i) => ({ v: 1, id: id(i), ts: new Date(Date.UTC(2026, 10, 21, i)).toISOString(), host: 'box-a', engine: 'claude', session: 's', cwd: '~/x', project: 'x', label: 'work', via: VIAS[i % 8], text: `prompt ${i}` });
  before(async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, '2026-11-21.jsonl'), Array.from({ length: 16 }, (_, i) => J(rec(i))).join('\n') + '\n');
  });
  const nums = (r) => r.prompts.map((p) => Number(p.id.slice(2))).sort((a, b) => a - b);
  const local = (a) => api.dispatch('prompts.local', a);
  const real = { ...api.local };
  afterEach(() => { Object.assign(api.local, real); remote.stopAll(); });

  test('who: mine (the default), manager, agents, programs, not-mine, all; via alone still works; a bad who is refused', async () => {
    assert.deepEqual(nums(await local({})), [0, 1, 2, 3, 8, 9, 10, 11]);
    assert.ok((await local({})).prompts.every((p) => p.mine === true && p.marked === false));
    assert.deepEqual(nums(await local({ who: 'manager' })), [3, 11]);
    assert.deepEqual(nums(await local({ who: 'agents' })), [4, 5, 12, 13]);
    assert.deepEqual(nums(await local({ who: 'programs' })), [6, 7, 14, 15]);
    assert.deepEqual(nums(await local({ who: 'not-mine' })), [4, 5, 6, 7, 12, 13, 14, 15]);
    assert.equal((await local({ who: 'all' })).prompts.length, 16);
    assert.deepEqual(nums(await local({ via: ['peer', 'sdk'] })), [4, 7, 12, 15], 'an old client\'s via');
    assert.equal((await local({ via: 'all' })).prompts.length, 16);
    await assert.rejects(local({ who: 'everyone' }), /who: one of mine, manager, agents, programs, not-mine, all/);
  });

  test('prompts.mark writes one prompt-mark event; the next read has it; null takes it back; bad input is refused', async () => {
    const r = await api.dispatchRecorded('prompts.mark', { ids: [id(6), id(1)], mine: false, actor: 'tui' });
    assert.deepEqual([r.ok, r.ids, r.mine, r.event.type, r.event.actor], [true, [id(6), id(1)], false, 'prompt-mark', 'tui']);
    assert.deepEqual(r.event.prompts, [id(6), id(1)]);
    await api.dispatch('prompts.mark', { id: id(6), mine: true });
    assert.deepEqual(nums(await local({})), [0, 2, 3, 6, 8, 9, 10, 11], 'the newest mark of an id wins: 6 mine, 1 not');
    const one = (await local({ who: 'all' })).prompts.find((p) => p.id === id(1));
    assert.deepEqual([one.mine, one.marked], [false, true]);
    await api.dispatch('prompts.mark', { ids: id(1), mine: null });
    assert.ok(nums(await local({})).includes(1), 'cleared: automatic again');
    await assert.rejects(api.dispatch('prompts.mark', { mine: true }), /id or ids required/);
    await assert.rejects(api.dispatch('prompts.mark', { id: 'p_nothex', mine: true }), /is no prompt id/);
    await assert.rejects(api.dispatch('prompts.mark', { id: id(1) }), /mine must be true, false or null/);
    assert.throws(() => events.validateEvent({ type: 'prompt-mark', prompts: ['x'], mine: true }), /1 to 500 prompt ids/);
    assert.throws(() => events.validateEvent({ type: 'prompt-mark', prompts: [id(1)], mine: 'yes' }), /true, false or null/);
  });

  test('prompts.list hands the front\'s marks to each host and classifies and filters a host\'s records from older code', async () => {
    await api.dispatch('prompts.mark', { id: 'p_b000000000000002', mine: false });
    const seen = [];
    // box-b runs code from before who: it ignores who and marks and answers without mine.
    fakePeer(remote, ({ args }) => { seen.push(args); return { host: 'box-b', prompts: [
      { v: 1, id: 'p_b000000000000001', ts: '2026-11-22T01:00:00.000Z', host: 'box-b', engine: 'claude', session: 's', via: 'typed', text: 'b one' },
      { v: 1, id: 'p_b000000000000002', ts: '2026-11-22T02:00:00.000Z', host: 'box-b', engine: 'claude', session: 's', via: 'typed', text: 'b two' },
      { v: 1, id: 'p_b000000000000003', ts: '2026-11-22T03:00:00.000Z', host: 'box-b', engine: 'claude', session: 's', via: 'headless', text: 'b three' }], more: false, ms: 1 }; });
    const r = await api.dispatch('prompts.list', { host: 'box-b' });
    assert.equal(seen[0].marks['p_b000000000000002'], false, 'the front\'s marks went along');
    assert.deepEqual(r.prompts.map((p) => [p.id, p.mine, p.marked, p.route]), [['p_b000000000000001', true, false, 'box-b']], 'marked not mine and the headless run are out of mine');
    const all = await api.dispatch('prompts.list', { host: 'box-b', who: 'all' });
    assert.deepEqual(all.prompts.map((p) => p.mine), [false, false, true]);
  });

  test('the op table and MCP: prompts.mark mutates, takes ids, mine and actor, and is a generated tool', () => {
    assert.ok(api.OPS.includes('prompts.mark'));
    assert.equal(isMutating('prompts.mark'), true);
    for (const k of ['id', 'ids', 'mine', 'actor']) assert.ok(META['prompts.mark'].s.properties[k], k);
    assert.ok(META['prompts.list'].s.properties.who); assert.ok(META['prompts.local'].s.properties.marks);
    assert.ok(generatedTools().some((t) => t.name === 'drover_prompts_mark'));
  });
});
