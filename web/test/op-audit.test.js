// Every front records a write the same way: the daemon (dispatchCached), the CLI's `drover op` and the MCP server
// when no daemon answers (dispatchRecorded). The op log keeps args with secrets redacted at every depth (an exec
// argv, a nested env, a long text cut at 240 characters), `fresh` reaches an uncached op that keeps its own cache,
// and generated MCP tools stamp actor mcp on every write.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmp = await mkdtemp(path.join(tmpdir(), 'drover-audit-'));
const ENV = {
  DROVER_CACHE: path.join(tmp, 'cache'), DROVER_DOTFILES: path.join(tmp, 'dotfiles'), DROVER_STATE: path.join(tmp, 'state'),
  DROVER_EVENTS: path.join(tmp, 'dotfiles', 'claude', 'drover-events.jsonl'),
};
Object.assign(process.env, ENV);
await mkdir(path.join(tmp, 'dotfiles', 'claude'), { recursive: true });
const api = await import('../core/api.js');
const { GENERATED_TOOLS } = await import('../mcp/server.js');

// Credential-shaped values assembled at runtime, so no literal in this file looks like one.
const GH = ['ghp', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('_');
const SK = ['sk', 'Zx9Qw8Er7Ty6Ui5Op4As3Df2'].join('-');
const PLAIN = 'Pq7Wm2Lk9Vb4';
const ops = async () => (await readFile(ENV.DROVER_EVENTS, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'op');

test('a write is logged with its secrets redacted at every depth: argv items, nested objects, top-level text', async () => {
  const real = api.local['docker.exec'];
  api.local['docker.exec'] = async () => ({ ok: true, code: 0 });
  try {
    await api.dispatchCached('docker.exec', {
      project: 'probe', service: 'web', argv: ['env', `TOKEN=${PLAIN}`, '-H', `Authorization: Bearer ${PLAIN}`, GH],
      opts: { env: { API_TOKEN: PLAIN, NOTE: `key ${SK}` } }, input: `export AWS_SECRET_ACCESS_KEY=${PLAIN}`,
      credential: 'main', sessionId: '11111111-2222-3333-4444-555555555555', actor: 'audit-test',
    });
  } finally { api.local['docker.exec'] = real; }
  const rec = (await ops()).filter((e) => e.op === 'docker.exec').at(-1);
  assert.ok(rec, 'the write is in the truth file');
  const text = JSON.stringify(rec);
  for (const s of [PLAIN, GH, SK]) assert.ok(!text.includes(s), `${s.slice(0, 4)}… must not reach the truth file`);
  assert.equal(rec.args.argv[0], 'env', 'what is not secret stays readable');
  assert.equal(rec.args.credential, 'main'); assert.equal(rec.args.sessionId, '11111111-2222-3333-4444-555555555555');
  assert.ok(!('API_TOKEN' in rec.args.opts.env), 'a secret-named key is dropped at any depth');
  assert.equal(rec.actor, 'audit-test');
});

test('a long value is redacted before it is trimmed, so the cut never leaves half a secret', async () => {
  const real = api.local['docker.exec'];
  api.local['docker.exec'] = async () => ({ ok: true });
  const value = 'q'.repeat(30) + '7';
  try { await api.dispatchCached('docker.exec', { project: 'probe', service: 'web', input: `${'x '.repeat(117)}password=${value}`, argv: [`${'y '.repeat(117)}password=${value}`] }); }
  finally { api.local['docker.exec'] = real; }
  const rec = (await ops()).filter((e) => e.op === 'docker.exec').at(-1);
  assert.ok(!JSON.stringify(rec).includes('qqqq'), 'the value straddled the 240-character cut');
  assert.match(rec.args.input, /…/);
});

test('a credential passed as a flag and a separate value is withheld (--password x, --github-token x, -u user:pass)', async () => {
  const real = api.local['docker.exec'];
  api.local['docker.exec'] = async () => ({ ok: true });
  const [pw, tok, upw] = ['hun7er2', 'Tk9short', 'pAss42'];
  try { await api.dispatchCached('docker.exec', { project: 'probe', service: 'web', argv: ['docker', 'login', '--password', pw, '--github-token', tok, 'curl', '-u', `alice:${upw}`, '--password-stdin', 'next-arg'] }); }
  finally { api.local['docker.exec'] = real; }
  const rec = (await ops()).filter((e) => e.op === 'docker.exec').at(-1);
  for (const s of [pw, tok, upw]) assert.ok(!JSON.stringify(rec).includes(s), `${s} is a flag's value`);
  assert.deepEqual(rec.args.argv.slice(0, 3), ['docker', 'login', '--password']);
  assert.equal(rec.args.argv[8], 'alice:[redacted]', 'the user stays, the password goes');
  assert.equal(rec.args.argv.at(-1), 'next-arg', 'a flag that takes no value (--password-stdin) withholds nothing');
});

test('deep nesting cannot overflow the log writer, and a result URL loses its password', async () => {
  const real = api.local['docker.exec'];
  let deep = ['leaf']; for (let i = 0; i < 20_000; i++) deep = [deep];
  api.local['docker.exec'] = async () => ({ ok: true, url: `https://alice:${PLAIN}@example.test/x` });
  try { await api.dispatchCached('docker.exec', { project: 'nested', service: 'web', argv: deep }); }
  finally { api.local['docker.exec'] = real; }
  const rec = (await ops()).filter((e) => e.op === 'docker.exec' && e.args?.project === 'nested').at(-1);
  assert.ok(rec, 'still recorded');
  assert.ok(!JSON.stringify(rec).includes(PLAIN), 'the result summary is redacted too');
});

test('the CLI sends a write to the daemon when one answers (recorded once, there) and runs a read in process', async () => {
  const { cliOp, _deps } = await import('../core/cli-op.js');
  const saved = { ..._deps }, calls = [];
  Object.assign(_deps, {
    daemonEndpoint: async () => ({ url: 'http://127.0.0.1:1/', token: 't' }),
    callDaemon: async (ep, op, args) => { calls.push(['daemon', op, args.actor]); return { ok: true }; },
    dispatchRecorded: async (op, args, o) => { calls.push(['here', op, o?.actor]); return { ok: true }; },
  });
  try { await cliOp('cache.invalidate', {}); await cliOp('host.identity', {}); await cliOp('features.upsert', { actor: 'alice' }); }
  finally { Object.assign(_deps, saved); }
  assert.deepEqual(calls, [['daemon', 'cache.invalidate', 'cli'], ['here', 'host.identity', 'cli'], ['daemon', 'features.upsert', 'alice']]);
});

test('the log stays cheap and clean: a 2 MB text, a failing write with a secret in its error, wider secret names', async () => {
  const real = api.local['docker.exec'];
  api.local['docker.exec'] = async () => ({ ok: true });
  const t0 = Date.now();
  try { await api.dispatchCached('docker.exec', { project: 'big', service: 'web', input: 'a-'.repeat(1_000_000), argv: ['x'] }); }
  finally { api.local['docker.exec'] = real; }
  assert.ok(Date.now() - t0 < 5000, `a 2 MB text is redacted over a bounded window (took ${Date.now() - t0} ms)`);
  api.local['docker.exec'] = async () => { throw new Error(`env TOKEN=${PLAIN} sh exited 1`); };
  await assert.rejects(api.dispatchCached('docker.exec', { project: 'fails', service: 'web', argv: ['sh'], opts: { env: { OPENAI_API_KEY: 'hun7er2', DB_PASSWD: 'hun7er3' } }, input: 'docker login -u alice --password hun7er4' }));
  api.local['docker.exec'] = real;
  const rec = (await ops()).filter((e) => e.op === 'docker.exec' && e.args?.project === 'fails').at(-1);
  for (const s of [PLAIN, 'hun7er2', 'hun7er3', 'hun7er4']) assert.ok(!JSON.stringify(rec).includes(s), `${s} stays out of the log`);
  assert.equal(rec.ok, false); assert.match(rec.error, /TOKEN=\[redacted\]/);
});

test('-u keeps a docker uid:gid and withholds any other password; a flag that takes no value withholds nothing', async () => {
  const real = api.local['docker.exec'];
  api.local['docker.exec'] = async () => ({ ok: true });
  try { await api.dispatchCached('docker.exec', { project: 'users', service: 'web', argv: ['-u', '1000:1000', '-u', 'alice:12345678'] }); }
  finally { api.local['docker.exec'] = real; }
  const rec = (await ops()).filter((e) => e.op === 'docker.exec' && e.args?.project === 'users').at(-1);
  assert.deepEqual(rec.args.argv, ['-u', '1000:1000', '-u', 'alice:[redacted]']);
  const { redactSecrets } = await import('../core/native.js');
  assert.equal(redactSecrets('docker login --password-stdin x --token-file /run/t'), 'docker login --password-stdin x --token-file /run/t');
  assert.equal(redactSecrets('gh auth --github-token=abc12 && login --password hunter2'), 'gh auth --github-token=[redacted] && login --password [redacted]');
});

test('fresh reaches an uncached op that keeps its own cache (fleet.summary)', async () => {
  const real = api.front['fleet.summary'];
  let seen = null;
  api.front['fleet.summary'] = async (args) => { seen = args; return { hosts: [] }; };
  try {
    await api.dispatchCached('fleet.summary', { fresh: true });
    assert.equal(seen?.fresh, true, 'fresh:true got through');
    await api.dispatchCached('fleet.summary', {});
    assert.equal(seen?.fresh, undefined, 'and nothing is added when not asked');
  } finally { api.front['fleet.summary'] = real; }
});

test('the CLI records its writes in the truth file, as the daemon does, and its reads stay out of it', async () => {
  const run = (op) => promisify(execFile)(process.execPath, [path.join(import.meta.dirname, '..', 'bin', 'drover'), 'op', op, '{}'], { env: { ...process.env, ...ENV }, timeout: 60_000 });
  await run('cache.invalidate');
  await run('host.identity');
  const recs = await ops();
  const w = recs.filter((e) => e.op === 'cache.invalidate').at(-1);
  assert.ok(w, 'drover op cache.invalidate is in the truth file');
  assert.equal(w.actor, 'cli'); assert.equal(w.ok, true);
  assert.ok(!recs.some((e) => e.op === 'host.identity'), 'a read is not logged');
});

test('every generated MCP tool for a write stamps actor mcp, schema or not; reads get none', async () => {
  const seen = [];
  const fake = async (op, args) => { seen.push({ op, args }); return {}; };
  const tool = (op) => GENERATED_TOOLS.find((t) => t.title === op);
  await tool('docker.exec').run(fake, { project: 'probe', service: 'web', argv: ['ls'] });
  await tool('docker.stacks').run(fake, {});
  assert.equal(seen[0].args.actor, 'mcp', 'docker.exec declares no actor and is still attributed');
  assert.equal(seen[1].args.actor, undefined);
});
