// openclaw-manager/bin/manager-say against a fake gateway: it talks in the owner's conversation, drover:<DROVER_OWNER>,
// taking the owner from the environment, else from the settings files Drover reads (~/.config/drover/*.env), so it
// joins the conversation every Drover client shares.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const SAY = fileURLToPath(new URL('../openclaw-manager/bin/manager-say', import.meta.url));
const tools = await Promise.all(['jq', 'curl'].map((t) => run('sh', ['-c', `command -v ${t}`]).then(() => true, () => false)));

describe('manager-say', { skip: tools.every(Boolean) ? false : 'needs jq and curl' }, () => {
  let dir, server, port;
  const bodies = [];
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'drover-manager-say-'));
    server = createServer((req, res) => {
      let b = ''; req.on('data', (c) => { b += c; });
      req.on('end', () => { bodies.push({ auth: req.headers.authorization, body: JSON.parse(b) }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] })); });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });
  after(async () => { server.close(); await rm(dir, { recursive: true, force: true }); });

  const say = async (env, cfgFiles = null) => {
    const cfg = path.join(dir, `cfg-${bodies.length}`);
    await mkdir(cfg, { recursive: true });
    for (const [name, text] of Object.entries(cfgFiles ?? {})) await writeFile(path.join(cfg, name), text);
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(DROVER|APXW)_/.test(k)));
    const { stdout } = await run('bash', [SAY, 'hello'], { env: { ...base, HOME: dir, OPENCLAW_STATE_DIR: path.join(dir, 'state'), OPENCLAW_GATEWAY_PORT: String(port), OPENCLAW_GATEWAY_TOKEN: 'EXAMPLE_token', DROVER_CONFIG_DIR: cfg, ...env } });
    assert.equal(stdout.trim(), 'ok');
    return bodies.at(-1);
  };

  test('no owner anywhere: drover:owner', async () => {
    const b = await say({});
    assert.equal(b.body.user, 'drover:owner');
    assert.equal(b.auth, 'Bearer EXAMPLE_token');
    assert.deepEqual(b.body.messages, [{ role: 'user', content: 'hello' }]);
  });
  test('the first settings file that sets DROVER_OWNER, as Drover reads it (quotes, export, a comment, any case)', async () => {
    const b = await say({}, { '10-b.env': 'DROVER_OWNER=second\n', '00-a.env': '# DROVER_OWNER=commented\nexport DROVER_OWNER="Dana"   # the owner\n' });
    assert.equal(b.body.user, 'drover:dana');
  });
  test('the environment wins over the settings files; MANAGER_SAY_USER over both', async () => {
    assert.equal((await say({ DROVER_OWNER: 'Erin' }, { '00.env': 'DROVER_OWNER=dana\n' })).body.user, 'drover:erin');
    assert.equal((await say({ MANAGER_SAY_USER: 'drover:dana:other' }, { '00.env': 'DROVER_OWNER=dana\n' })).body.user, 'drover:dana:other');
  });
});
