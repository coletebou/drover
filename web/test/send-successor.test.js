// sessions.message to a Claude session that handed off (core/lineage.js, core/api.js): the message goes to the live
// newest generation its handoff chain records, and the result and the message event say so; a live target, a target
// in no chain, one in several chains, and a chain with no live successor fail or deliver exactly as before. A scratch
// Claude config dir (registry entries for this test's own pid, or a pid that cannot exist), inbox sockets this test
// listens on, chain records in a temp dir, an empty truth file; nothing here reaches the user's sessions or hosts.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmp = await mkdtemp(path.join(tmpdir(), 'drover-succ-'));
process.env.DROVER_CACHE = path.join(tmp, 'cache');
process.env.DROVER_STATE = path.join(tmp, 'state');
process.env.DROVER_DOTFILES = path.join(tmp, 'dotfiles');
process.env.DROVER_EVENTS = path.join(tmp, 'events.jsonl');
process.env.DROVER_PLUGINS = '';
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
process.env.CODEX_HOME = path.join(tmp, 'codex');
const CHAINS = path.join(tmp, 'chains'), BRIEFS = path.join(tmp, 'briefs'), REGISTRY = path.join(tmp, 'claude', 'sessions'), SOCKS = path.join(tmp, 's');
process.env.DROVER_HANDOFF_CHAINS = CHAINS;
// `claude agents --json` is part of the session list, and a miss asks Codex for its threads: stand-ins for both.
const bin = path.join(tmp, 'bin');
await mkdir(bin, { recursive: true });
await writeFile(path.join(bin, 'claude'), '#!/bin/sh\necho "[]"\n');
await writeFile(path.join(bin, 'codex'), '#!/bin/sh\nexit 1\n');
for (const b of ['claude', 'codex']) await chmod(path.join(bin, b), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;

const { dispatch } = await import('../core/api.js');
const lineage = await import('../core/lineage.js');
const codex = await import('../core/codex.js');

const DEAD_PID = 2 ** 31 - 2;   // above any pid_max: never a running process
// A session id whose first 8 digits differ per generation too, as real ones do: tag (4 hex digits) and n (1 to 9).
const sid = (tag, n) => `${tag}${n}000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const inboxes = [];
/** An inbox socket that keeps every user message it is sent. */
async function inbox(name) {
  const file = path.join(SOCKS, `${name}.sock`), got = [];
  const srv = createServer((c) => {
    let buf = '';
    c.setEncoding('utf8');
    c.on('data', (d) => { buf += d; });
    c.on('end', () => { for (const l of buf.split('\n').filter(Boolean)) { const f = JSON.parse(l); if (f.type === 'user') got.push(f.message.content); } c.end(); });
  });
  await new Promise((r) => srv.listen(file, r));
  inboxes.push(srv);
  return { file, got };
}
let regN = 1000;
/** A registry entry: live (this test's pid) with an inbox, or dead (with or without the socket path it had). */
async function register({ id, name, live = true, socket = null, startedAt = Date.now() - 60_000 }) {
  await writeFile(path.join(REGISTRY, `${regN++}.json`), JSON.stringify({ pid: live ? process.pid : DEAD_PID, sessionId: id, cwd: tmp, name, status: 'idle', kind: 'interactive', startedAt, ...(socket ? { messagingSocketPath: socket } : {}) }));
}
/**
 * A chain as a handoff tool records it: chain.json, gen-NN/session.json per generation (a successor that got going
 * has started_at), and a marker per session. gens: [{ id, name, started = true, alias }].
 */
async function chain(name, gens) {
  const dir = path.join(BRIEFS, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'chain.json'), JSON.stringify({ version: 1, name, root: gens[0].name, created: '2026-10-26T00:00:00Z' }));
  for (const [i, g] of gens.entries()) {
    const gen = i + 1, gd = path.join(dir, `gen-${String(gen).padStart(2, '0')}`);
    await mkdir(gd, { recursive: true });
    await writeFile(path.join(gd, 'session.json'), JSON.stringify({ gen, session_id: g.id, name: g.name, host: 'box-a', cwd: tmp, ...(gen > 1 && g.started !== false ? { started_at: 1_790_000_000 + gen } : {}), ssh_alias: g.alias ?? '' }));
    await writeFile(path.join(CHAINS, `${g.id}.json`), JSON.stringify({ gen, chain: name, dir }));
  }
  return dir;
}
const messages = async () => (await readFile(process.env.DROVER_EVENTS, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'message');
const send = (id, text = 'status?') => dispatch('sessions.message', { id, text, actor: 'peer-test' });
const settle = () => new Promise((r) => setTimeout(r, 50));   // an inbox reads its frames as the client's socket closes

describe('sessions.message reaches a handoff successor', () => {
  before(async () => { await mkdir(SOCKS, { recursive: true }); });
  beforeEach(async () => {
    for (const d of [REGISTRY, CHAINS, BRIEFS]) { await rm(d, { recursive: true, force: true }); await mkdir(d, { recursive: true }); }
    await writeFile(process.env.DROVER_EVENTS, '');
  });
  after(async () => {
    for (const s of inboxes) s.close();
    codex.stopReadClient(); codex.sharedClient().stop();
    await rm(tmp, { recursive: true, force: true });
  });

  test('a session no longer found, by name: delivered to its live successor, and the result and the message event say so', async () => {
    const [a1, a2, a3] = [1, 2, 3].map((n) => sid('a1a1', n));
    await chain('alpha-chain', [{ id: a1, name: 'alpha' }, { id: a2, name: 'alpha-2' }, { id: a3, name: 'alpha-3' }]);
    const in3 = await inbox('a3');
    await register({ id: a3, name: 'alpha-3', socket: in3.file });
    const r = await send('alpha-2');
    await settle();
    assert.equal(r.ok, true);
    assert.deepEqual(r.resolvedFrom, { given: 'alpha-2', id: a2, name: 'alpha-2', gen: 2, state: 'session not found' });
    assert.deepEqual(r.resolvedTo, { id: a3, name: 'alpha-3', gen: 3, chain: 'alpha-chain' });
    assert.equal(r.resolvedWhy, 'alpha-2 is not live (session not found); it is generation 2 of handoff chain alpha-chain, whose newest live generation is alpha-3 (generation 3)');
    assert.equal(r.session.id, a3);
    assert.equal(in3.got.length, 1);
    assert.match(in3.got[0], /status\?/);
    const [ev] = await messages();
    assert.equal(ev.to.id, a3, 'the event names where the message went');
    assert.equal(ev.to.name, 'alpha-3');
    assert.deepEqual(ev.resolvedFrom, r.resolvedFrom);
    assert.deepEqual(ev.resolvedTo, r.resolvedTo);
    assert.equal(ev.resolvedWhy, r.resolvedWhy);
    assert.equal(ev.delivery.ok, true);
  });

  test('a registered session with no messaging socket, or whose process ended: redirected the same way', async () => {
    const [b1, b2, b3] = [1, 2, 3].map((n) => sid('b2b2', n));
    await chain('bravo-chain', [{ id: b1, name: 'bravo' }, { id: b2, name: 'bravo-2' }, { id: b3, name: 'bravo-3' }]);
    const in3 = await inbox('b3');
    await register({ id: b3, name: 'bravo-3', socket: in3.file });
    await register({ id: b2, name: 'bravo-2', live: false });
    const bySocketless = await send(b2, 'first');
    assert.equal(bySocketless.resolvedFrom.state, 'no messaging socket');
    assert.equal(bySocketless.resolvedTo.id, b3);
    // The same session with the inbox path it had while it ran, addressed by name: its process is gone.
    await rm(REGISTRY, { recursive: true }); await mkdir(REGISTRY);
    await register({ id: b3, name: 'bravo-3', socket: in3.file });
    await register({ id: b2, name: 'bravo-2', live: false, socket: path.join(SOCKS, 'gone.sock') });
    const byDeadPid = await send('bravo-2', 'second');
    await settle();
    assert.equal(byDeadPid.resolvedFrom.state, 'process not alive');
    assert.equal(byDeadPid.resolvedTo.id, b3);
    assert.deepEqual(in3.got.map((t) => t.match(/first|second/)[0]), ['first', 'second']);
  });

  test('multi-hop: an 8-digit id prefix of generation 1 reaches generation 4, past ended ones and a live one that handed off', async () => {
    const ids = [1, 2, 3, 4].map((n) => sid('c3c3', n));
    await chain('charlie-chain', ids.map((id, i) => ({ id, name: i ? `charlie-${i + 1}` : 'charlie' })));
    const in3 = await inbox('c3'), in4 = await inbox('c4');
    // Generation 3 handed off but stays open (its jobs still run, say); generation 4 carries the work.
    await register({ id: ids[2], name: 'charlie-3', socket: in3.file });
    await register({ id: ids[3], name: 'charlie-4', socket: in4.file });
    const r = await send(ids[0].slice(0, 8));
    await settle();
    assert.deepEqual(r.resolvedFrom, { given: ids[0].slice(0, 8), id: ids[0], name: 'charlie', gen: 1, state: 'session not found' });
    assert.deepEqual(r.resolvedTo, { id: ids[3], name: 'charlie-4', gen: 4, chain: 'charlie-chain' });
    assert.match(r.resolvedWhy, /newest live generation is charlie-4 \(generation 4\); charlie-3 is live too but handed off$/);
    assert.equal(in4.got.length, 1);
    assert.equal(in3.got.length, 0, 'the generation that handed off gets nothing');
  });

  test('a newer generation that never started is passed over: the one it was to replace still carries the chain', async () => {
    const ids = [1, 2, 3].map((n) => sid('d4d4', n));
    await chain('delta-chain', [{ id: ids[0], name: 'delta' }, { id: ids[1], name: 'delta-2' }, { id: ids[2], name: 'delta-3', started: false }]);
    const in2 = await inbox('d2');
    await register({ id: ids[1], name: 'delta-2', socket: in2.file });
    const r = await send('delta');
    await settle();
    assert.equal(r.resolvedTo.id, ids[1]);
    assert.equal(in2.got.length, 1);
  });

  test('ambiguous: a name in two chains is not redirected, even when only one has a live successor; the error lists both', async () => {
    const a = [1, 2, 3].map((n) => sid('e5e5', n)), b = [1, 2, 3].map((n) => sid('f6f6', n));
    await chain('echo-chain-a', [{ id: a[0], name: 'echo' }, { id: a[1], name: 'echo-2' }, { id: a[2], name: 'echo-3' }]);
    await chain('echo-chain-b', [{ id: b[0], name: 'echo' }, { id: b[1], name: 'echo-2' }, { id: b[2], name: 'echo-3' }]);
    const inA = await inbox('ea3'), inB = await inbox('eb3');
    await register({ id: a[2], name: 'echo-3', socket: inA.file });
    await register({ id: b[2], name: 'echo-3', socket: inB.file });
    const both = await send('echo-2').then(() => null, (e) => e);
    assert.match(both.message, /^session not found; echo-2 is a generation of 2 handoff chains, so nothing was redirected: chain echo-chain-(a|b): /);
    for (const id of [a[2], b[2]]) assert.ok(both.message.includes(`echo-3 (generation 3, ${id}), live`), id);
    assert.deepEqual(both.candidates.map((c) => [c.chain, c.id, c.state]).sort(), [['echo-chain-a', a[2], 'live'], ['echo-chain-b', b[2], 'live']]);
    // One live successor among the two chains is still not the target's own chain for certain.
    await rm(REGISTRY, { recursive: true }); await mkdir(REGISTRY);
    await register({ id: a[2], name: 'echo-3', socket: inA.file });
    const one = await send('echo-2').then(() => null, (e) => e);
    assert.match(one.message, /2 handoff chains, so nothing was redirected/);
    assert.match(one.message, new RegExp(`echo-3 \\(generation 3, ${b[2]}\\), ended`));
    await settle();
    assert.equal(inA.got.length + inB.got.length, 0, 'neither chain got the message');
    assert.equal((await messages()).length, 0, 'a session not found appends no message event, as before');
  });

  test('ambiguous too when the lookup finds an ended session of that name: the name is not narrowed to that session', async () => {
    const a = [1, 2, 3].map((n) => sid('e5e5', n)), b = [1, 2, 3].map((n) => sid('f6f6', n));
    await chain('echo-chain-a', [{ id: a[0], name: 'echo' }, { id: a[1], name: 'echo-2' }, { id: a[2], name: 'echo-3' }]);
    await chain('echo-chain-b', [{ id: b[0], name: 'echo' }, { id: b[1], name: 'echo-2' }, { id: b[2], name: 'echo-3' }]);
    const inA = await inbox('ea3x'), inB = await inbox('eb3x');
    await register({ id: a[2], name: 'echo-3', socket: inA.file });
    await register({ id: b[2], name: 'echo-3', socket: inB.file });
    // Chain a's echo-2 left its registry file behind: the lookup finds it, and the name still means two sessions.
    await register({ id: a[1], name: 'echo-2', live: false, socket: path.join(SOCKS, 'gone.sock') });
    const two = await send('echo-2').then(() => null, (e) => e);
    assert.match(two.message, /^session process is not alive; echo-2 is a generation of 2 handoff chains, so nothing was redirected/);
    // One chain, but the name also belongs to an ended session that is in none.
    await rm(REGISTRY, { recursive: true }); await mkdir(REGISTRY);
    await rm(path.join(BRIEFS, 'echo-chain-b'), { recursive: true });
    for (const id of b) await rm(path.join(CHAINS, `${id}.json`));
    await register({ id: a[2], name: 'echo-3', socket: inA.file });
    const stray = sid('a0a0', 9);
    await register({ id: stray, name: 'echo-2', live: false, socket: path.join(SOCKS, 'gone.sock') });
    const other = await send('echo-2').then(() => null, (e) => e);
    assert.match(other.message, new RegExp(`^session process is not alive; echo-2 also names a session in no handoff chain \\(${stray}\\), so nothing was redirected: chain echo-chain-a: echo-2 \\(generation 2, ${a[1]}\\), then echo-3 \\(generation 3, ${a[2]}\\), live$`));
    // The same chain member by its full id is that session, so it is redirected.
    await register({ id: a[1], name: 'echo-2', live: false, socket: path.join(SOCKS, 'gone.sock') });
    assert.equal((await send(a[1])).resolvedTo.id, a[2]);
    // A short prefix of it is not: under 8 digits it could be anyone's.
    const short = await send(a[1].slice(0, 5)).then(() => null, (e) => e);
    assert.equal(short.message, 'session process is not alive');
    await settle();
    assert.equal(inA.got.length, 1);
    assert.equal(inB.got.length, 0);
  });

  test('no successor: the newest generation, a successor that ended, or one on another host fail as before, with what the chain holds', async () => {
    const ids = [1, 2, 3].map((n) => sid('a7a7', n));
    const dir = await chain('foxtrot-chain', [{ id: ids[0], name: 'foxtrot' }, { id: ids[1], name: 'foxtrot-2' }]);
    const newest = await send('foxtrot-2').then(() => null, (e) => e);
    assert.equal(newest.message, `session not found; foxtrot-2 (generation 2, ${ids[1]}) is the newest generation of handoff chain foxtrot-chain; nothing continues it`);
    assert.deepEqual(newest.candidates, []);
    // Generation 3 ran and ended.
    await mkdir(path.join(dir, 'gen-03'));
    await writeFile(path.join(dir, 'gen-03', 'session.json'), JSON.stringify({ gen: 3, session_id: ids[2], name: 'foxtrot-3', started_at: 1, ssh_alias: '' }));
    await writeFile(path.join(CHAINS, `${ids[2]}.json`), JSON.stringify({ gen: 3, chain: 'foxtrot-chain', dir }));
    const ended = await send('foxtrot-2').then(() => null, (e) => e);
    assert.equal(ended.message, `session not found; handoff chain foxtrot-chain has no live successor of foxtrot-2 (generation 2, ${ids[1]}): foxtrot-3 (generation 3, ${ids[2]}), ended`);
    assert.deepEqual(ended.candidates, [{ chain: 'foxtrot-chain', gen: 3, id: ids[2], name: 'foxtrot-3', state: 'ended' }]);
    // Generation 3 was started on another host: only that host knows whether it runs.
    await writeFile(path.join(dir, 'gen-03', 'session.json'), JSON.stringify({ gen: 3, session_id: ids[2], name: 'foxtrot-3', ssh_alias: 'box-b' }));
    const away = await send('foxtrot-2').then(() => null, (e) => e);
    assert.match(away.message, new RegExp(`foxtrot-3 \\(generation 3, ${ids[2]}\\) on box-b: resend with host box-b$`));
    assert.deepEqual(away.candidates, [{ chain: 'foxtrot-chain', gen: 3, id: ids[2], name: 'foxtrot-3', state: 'elsewhere', host: 'box-b' }]);
    // A registered dead target is still tried, as before: the failed delivery is recorded, and the error says why.
    await register({ id: ids[1], name: 'foxtrot-2', live: false, socket: path.join(SOCKS, 'gone.sock') });
    const dead = await send(ids[1]).then(() => null, (e) => e);
    assert.match(dead.message, /^session process is not alive; handoff chain foxtrot-chain has no live successor/);
    assert.ok(dead.event, 'the failed delivery has its event');
    const [ev] = await messages();
    assert.equal(ev.delivery.ok, false);
    assert.equal(ev.to.id, ids[1]);
    assert.equal(ev.resolvedFrom, undefined);
  });

  test('a live target is never redirected, even when its chain has a newer live generation', async () => {
    const ids = [1, 2, 3].map((n) => sid('b8b8', n));
    await chain('golf-chain', [{ id: ids[0], name: 'golf' }, { id: ids[1], name: 'golf-2' }, { id: ids[2], name: 'golf-3' }]);
    const in2 = await inbox('g2'), in3 = await inbox('g3');
    await register({ id: ids[1], name: 'golf-2', socket: in2.file });
    await register({ id: ids[2], name: 'golf-3', socket: in3.file });
    for (const id of ['golf-2', ids[1]]) {
      const r = await send(id);
      assert.equal(r.session.id, ids[1]);
      assert.equal(r.resolvedFrom, undefined);
    }
    await settle();
    assert.equal(in2.got.length, 2);
    assert.equal(in3.got.length, 0);
    for (const ev of await messages()) assert.equal(ev.resolvedFrom, undefined);
    // Entries the lookup could find instead: the registry file an earlier process of the same session left (it started
    // before the live one), and another session of that name that started after it and ended. The running one answers.
    await register({ id: ids[1], name: 'golf-2', live: false, socket: path.join(SOCKS, 'gone.sock'), startedAt: Date.now() - 3_600_000 });
    await register({ id: sid('b8b8', 9), name: 'golf-2', live: false, socket: path.join(SOCKS, 'gone.sock'), startedAt: Date.now() });
    for (const id of ['golf-2', ids[1]]) assert.equal((await send(id)).session.id, ids[1], id);
    await settle();
    assert.equal(in2.got.length, 4);
    assert.equal(in3.got.length, 0);
  });

  test('a generation that still runs under another name is not passed over for its successor', async () => {
    const [m1, m2] = [1, 2].map((n) => sid('b1b1', n));
    await chain('mike-chain', [{ id: m1, name: 'mike' }, { id: m2, name: 'mike-2' }]);
    const in1 = await inbox('m1'), in2 = await inbox('m2');
    // Generation 1 was renamed after its handoff and still runs; the chain record keeps the name it had.
    await register({ id: m1, name: 'mike-renamed', socket: in1.file });
    await register({ id: m2, name: 'mike-2', socket: in2.file });
    const e = await send('mike').then(() => null, (x) => x);
    assert.equal(e.message, `session not found; mike (generation 1, ${m1}) of handoff chain mike-chain still runs here under another name, so nothing was redirected: send to its session id`);
    assert.deepEqual(e.candidates.map((c) => [c.id, c.state]), [[m1, 'live'], [m2, 'live']]);
    await settle();
    assert.equal(in1.got.length + in2.got.length, 0);
  });

  test('a name recorded for two generations of one chain: each is checked, and one that still runs stops the redirect', async () => {
    const ids = [1, 2, 3].map((n) => sid('c2c2', n));
    await chain('november-chain', [{ id: ids[0], name: 'work' }, { id: ids[1], name: 'work' }, { id: ids[2], name: 'work-3' }]);
    const in1 = await inbox('n1'), in3 = await inbox('n3');
    await register({ id: ids[0], name: 'work-renamed', socket: in1.file });
    await register({ id: ids[2], name: 'work-3', socket: in3.file });
    const e = await send('work').then(() => null, (x) => x);
    assert.equal(e.message, `session not found; work (generation 1, ${ids[0]}) of handoff chain november-chain still runs here under another name, so nothing was redirected: send to its session id`);
    // Neither runs any more: the name is that chain's twice over, and its live newest generation takes the message.
    await rm(REGISTRY, { recursive: true }); await mkdir(REGISTRY);
    await register({ id: ids[2], name: 'work-3', socket: in3.file });
    const r = await send('work');
    assert.deepEqual([r.resolvedFrom.gen, r.resolvedTo.gen], [2, 3]);
    await settle();
    assert.equal(in1.got.length, 0);
    assert.equal(in3.got.length, 1);
  });

  test('a generation renamed to an earlier one\'s name, now ended, is still of its chain: the message goes on', async () => {
    const ids = [1, 2, 3].map((n) => sid('d3d3', n));
    await chain('oscar-chain', [{ id: ids[0], name: 'oscar' }, { id: ids[1], name: 'oscar-2' }, { id: ids[2], name: 'oscar-3' }]);
    const in3 = await inbox('o3');
    await register({ id: ids[1], name: 'oscar', live: false, socket: path.join(SOCKS, 'gone.sock') });
    await register({ id: ids[2], name: 'oscar-3', socket: in3.file });
    const r = await send('oscar');
    assert.deepEqual([r.resolvedFrom.id, r.resolvedFrom.gen, r.resolvedTo.id], [ids[1], 2, ids[2]]);
    await settle();
    assert.equal(in3.got.length, 1);
  });

  test('a marker that cannot be read stops the redirect: nothing is sent, and the error says why', async () => {
    const [k1, k2, k3] = [1, 2, 3].map((n) => sid('e1e1', n));
    await chain('kilo-chain', [{ id: k1, name: 'kilo' }, { id: k2, name: 'kilo-2' }, { id: k3, name: 'kilo-3' }]);
    const in3 = await inbox('k3');
    await register({ id: k3, name: 'kilo-3', socket: in3.file });
    // Another chain's marker that cannot be read (here a directory): it might name kilo-2 too, so this is not guessed.
    await mkdir(path.join(CHAINS, 'unreadable.json'));
    const e = await send('kilo-2').then(() => null, (x) => x);
    assert.match(e.message, /^session not found; the handoff chains could not be read, so nothing was redirected \(EISDIR/);
    await settle();
    assert.equal(in3.got.length, 0);
    await assert.rejects(lineage.chainsOf('kilo-2', { dir: CHAINS }), /EISDIR/);
    // A marker, or a chain.json, that is not JSON stops it the same way.
    await rm(path.join(CHAINS, 'unreadable.json'), { recursive: true });
    await writeFile(path.join(CHAINS, 'torn.json'), '{"gen": 2, "chain": "lima-chain", "dir": "/');
    assert.match((await send('kilo-2').then(() => null, (x) => x)).message, /could not be read, so nothing was redirected \(.*torn\.json is not JSON\)$/);
    await rm(path.join(CHAINS, 'torn.json'));
    const dir = path.join(BRIEFS, 'kilo-chain');
    await writeFile(path.join(dir, 'chain.json'), '{"name": ');
    assert.match((await send('kilo-2').then(() => null, (x) => x)).message, /could not be read, so nothing was redirected \(.*chain\.json is not JSON\)$/);
    // A generation directory whose record names no session: it might be the kilo-2 meant.
    await writeFile(path.join(dir, 'chain.json'), JSON.stringify({ name: 'kilo-chain' }));
    await mkdir(path.join(dir, 'gen-04'));
    assert.match((await send('kilo-2').then(() => null, (x) => x)).message, /could not be read, so nothing was redirected \(.*gen-04\/session\.json names no session\)$/);
    await settle();
    assert.equal(in3.got.length, 0);
  });

  test('no chain: a missing session fails exactly as before, and a name is never read for a generation number', async () => {
    const lone = await inbox('h3');
    // A live hotel-3 in no chain, and a chain whose newest generation is hotel-2: neither makes it hotel-2's successor.
    await register({ id: sid('c9c9', 3), name: 'hotel-3', socket: lone.file });
    assert.equal((await send('india-2').then(() => null, (e) => e)).message, 'session not found');
    await chain('hotel-chain', [{ id: sid('c9c9', 1), name: 'hotel' }, { id: sid('c9c9', 2), name: 'hotel-2' }]);
    const e = await send('hotel-2').then(() => null, (x) => x);
    assert.match(e.message, /^session not found; hotel-2 \(generation 2, .+\) is the newest generation of handoff chain hotel-chain; nothing continues it$/);
    await settle();
    assert.equal(lone.got.length, 0);
  });
});

describe('core/lineage', () => {
  test('markersDir: DROVER_HANDOFF_CHAINS, then the writer\'s HANDOFF_CHAIN_STATE_DIR, then ~/.claude/state/handoff-chain', () => {
    assert.equal(lineage.markersDir({ DROVER_HANDOFF_CHAINS: '/x', HANDOFF_CHAIN_STATE_DIR: '/y', HOME: '/h' }), '/x');
    assert.equal(lineage.markersDir({ HANDOFF_CHAIN_STATE_DIR: '/y', HOME: '/h' }), '/y');
    assert.equal(lineage.markersDir({ HOME: '/h' }), path.join('/h', '.claude', 'state', 'handoff-chain'));
  });

  test('a marker is followed only to a chain directory: a relative dir, or one without chain.json, is not a chain', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'drover-lineage-'));
    const marks = path.join(dir, 'marks'), notChain = path.join(dir, 'not-a-chain');
    await mkdir(path.join(notChain, 'gen-01'), { recursive: true });
    await mkdir(marks);
    const id = sid('d0d0', 1);
    await writeFile(path.join(notChain, 'gen-01', 'session.json'), JSON.stringify({ session_id: id, name: 'juliet' }));
    await writeFile(path.join(marks, `${id}.json`), JSON.stringify({ gen: 1, chain: 'x', dir: notChain }));
    await writeFile(path.join(marks, 'rel.json'), JSON.stringify({ gen: 1, chain: 'x', dir: 'not-a-chain' }));
    assert.deepEqual(await lineage.chainsOf(id, { dir: marks }), []);
    assert.deepEqual(await lineage.chainsOf('juliet', { dir: marks }), []);
    assert.deepEqual(await lineage.successor('juliet', { dir: marks }), { to: null, note: null, candidates: [] });
    await rm(dir, { recursive: true, force: true });
  });

  test('stateOf: live, no messaging socket, ended, elsewhere, not started', () => {
    const reg = lineage.registryIndex([
      { sessionId: 'a', alive: true, socket: '/s' }, { sessionId: 'b', alive: true, socket: null }, { sessionId: 'c', alive: false, socket: '/s' },
      // A dead entry left by a session that runs again under the same id does not hide the live one.
      { sessionId: 'd', alive: false, socket: '/old' }, { sessionId: 'd', alive: true, socket: '/new' },
    ]);
    assert.equal(lineage.stateOf({ sessionId: 'a' }, reg), 'live');
    assert.equal(lineage.stateOf({ sessionId: 'b' }, reg), 'no messaging socket');
    assert.equal(lineage.stateOf({ sessionId: 'c', alias: 'box-b' }, reg), 'ended', 'it ran here');
    assert.equal(lineage.stateOf({ sessionId: 'd' }, reg), 'live');
    assert.equal(lineage.stateOf({ sessionId: 'e', alias: 'box-b' }, reg), 'elsewhere');
    assert.equal(lineage.stateOf({ sessionId: 'e', started: true }, reg), 'ended');
    assert.equal(lineage.stateOf({ sessionId: 'e' }, reg), 'not started');
  });
});
