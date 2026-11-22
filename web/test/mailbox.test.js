// core/mailbox.js: messages for a host that takes no inbound ssh wait on the sender; that host pulls, delivers once, acks.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fakePeer } from './fake-peer.js';

const tmp = await mkdtemp(path.join(tmpdir(), 'drover-mailbox-'));
process.env.DROVER_STATE = path.join(tmp, 'state');
process.env.DROVER_CACHE = path.join(tmp, 'cache');
process.env.DROVER_DOTFILES = path.join(tmp, 'dotfiles');
process.env.DROVER_EVENTS = path.join(tmp, 'dotfiles', 'claude', 'drover-events.jsonl');
await mkdir(path.join(tmp, 'dotfiles', 'claude'), { recursive: true });
await writeFile(path.join(tmp, 'dotfiles', 'claude', 'fleet-hosts.txt'), 'nolink\n');
const mailbox = await import('../core/mailbox.js');
const remote = await import('../core/remote.js');
afterEach(() => { remote.stopAll(); delete mailbox._deps.env.DROVER_MAILBOX_PULL; });

test('isUnreachable: only connection failures, never a refusal or a timeout', () => {
  assert.equal(mailbox.isUnreachable(new Error('ssh laptop2 drover rpc exited 255: kex_exchange_identification: read: Connection reset by peer')), true);
  assert.equal(mailbox.isUnreachable(new Error('ssh laptop2 drover rpc is not running')), true);
  assert.equal(mailbox.isUnreachable(new Error('ssh laptop2: write failed (EPIPE)')), true);
  assert.equal(mailbox.isUnreachable(new Error('session not found')), false);
  assert.equal(mailbox.isUnreachable(new Error('laptop2: sessions.message timed out')), false);
  assert.equal(mailbox.isUnreachable(new Error('ssh laptop2 drover rpc exited 1: boom')), false);
});

test('take returns only open mail for the names asked; ack closes it', async () => {
  const a = await mailbox.enqueue({ to: 'laptop2', id: 'integrator', text: 'fold abc123' });
  await mailbox.enqueue({ to: 'otherbox', id: 'x', text: 'not for you' });
  const { messages } = await mailbox.take({ for: ['laptop2'] });
  assert.deepEqual(messages.map((m) => m.mid), [a]);
  assert.equal(messages[0].text, 'fold abc123');
  await mailbox.ack({ acks: [{ mid: a, ok: true }] });
  assert.deepEqual((await mailbox.take({ for: 'laptop2' })).messages, []);
  await assert.rejects(mailbox.take({ for: [] }), /host names/);
});

test('pullOnce delivers each message once, skips a host that is down, and never redelivers after a lost ack', async () => {
  mailbox._deps.env.DROVER_MAILBOX_PULL = 'laptop';
  const m1 = await mailbox.enqueue({ to: 'laptop', id: 'probe', text: 'one', actor: 'peer' });
  const m2 = await mailbox.enqueue({ to: 'laptop', id: 'gone', text: 'two' });
  const delivered = [];
  let ackFails = 1;
  const call = async (host, op, args) => {
    if (host === 'down') throw new Error('ssh down drover rpc exited 255: no route');
    if (op === 'mailbox.take') return mailbox.take(args);
    if (op === 'mailbox.ack') { if (ackFails-- > 0) throw new Error('ack link dropped'); return mailbox.ack(args); }
    throw new Error(`unexpected ${op}`);
  };
  const deliver = async ({ id, text, actor }) => { if (id === 'gone') throw new Error('session not found'); delivered.push({ id, text, actor }); return { session: { name: id } }; };
  const logs = [];
  const r1 = await mailbox.pullOnce({ hosts: async () => ['down', 'sender'], call, deliver, log: (m) => logs.push(m) });
  assert.equal(r1.delivered, 1);
  assert.deepEqual(delivered, [{ id: 'probe', text: 'one', actor: 'peer' }]);
  // The ack was lost, so the sender still lists both; the second pass must not deliver again, only ack.
  assert.equal((await mailbox.take({ for: 'laptop' })).messages.length, 2);
  const r2 = await mailbox.pullOnce({ hosts: async () => ['sender'], call, deliver });
  assert.equal(r2.delivered, 0);
  assert.equal(delivered.length, 1);
  assert.deepEqual((await mailbox.take({ for: 'laptop' })).messages, []);
  const st = await mailbox.status();
  const byMid = new Map(st.delivered.map((d) => [d.mid, d]));
  assert.equal(byMid.get(m1).ok, true);
  assert.equal(byMid.get(m2).ok, false);
  assert.match(byMid.get(m2).error, /session not found/);
  assert.ok(logs.some((l) => /take from down/.test(l)));
});

test('pullOnce does nothing without DROVER_MAILBOX_PULL', async () => {
  let asked = false;
  const r = await mailbox.pullOnce({ hosts: async () => { asked = true; return ['x']; }, call: async () => ({}), deliver: async () => ({}) });
  assert.deepEqual(r, { hosts: 0, delivered: 0 });
  assert.equal(asked, false);
});

test('sessions.message to a host ssh cannot reach is queued in the mailbox, not failed', async () => {
  fakePeer(remote, () => ({ $exit: 255, stderr: 'kex_exchange_identification: read: Connection reset by peer\n' }), { closeMs: 10 });
  const { dispatch } = await import('../core/api.js');
  const r = await dispatch('sessions.message', { host: 'nolink', id: 'integrator', text: 'fold def456' });
  assert.equal(r.queued, true);
  assert.equal(r.ok, false);
  assert.match(r.why, /not reachable/);
  const { messages } = await mailbox.take({ for: 'nolink' });
  assert.equal(messages.at(-1).mid, r.mailbox);
  assert.equal(messages.at(-1).text, 'fold def456');
});

test('a host that answers with an error is not queued', async () => {
  fakePeer(remote, () => 'ERR:session not found', { closeMs: 10 });
  const { dispatch } = await import('../core/api.js');
  const before = (await mailbox.take({ for: 'nolink' })).messages.length;
  await assert.rejects(dispatch('sessions.message', { host: 'nolink', id: 'nobody', text: 'hi' }), /session not found/);
  assert.equal((await mailbox.take({ for: 'nolink' })).messages.length, before);
});
