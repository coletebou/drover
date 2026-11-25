// bin/drover rpc reads the settings files (DROVER_CONFIG_DIR/*.env) and the secrets file once, at start. A front
// keeps the process across many calls (core/remote.js), so a setting added for this host later, or a rotated key,
// would never reach it. Once either file changes, every reply says stale, and the front retires the process for a
// fresh one that has read them, as it already does when the checkout moves. core/env.js settingsStamp compares
// names, times and sizes, never contents.
// Run: node --test test/rpc-stale-settings.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/drover', import.meta.url));
const env = await import('../core/env.js');

async function scratch(t) {
  const tmp = await mkdtemp(path.join(tmpdir(), 'drover-rpcset-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const config = path.join(tmp, 'config');
  await mkdir(config, { recursive: true });
  await writeFile(path.join(config, '00-shared.env'), 'DROVER_OWNER=tester\n');
  const secrets = path.join(tmp, 'secrets');
  await writeFile(secrets, 'FAKE_TEST_ONLY=x\n');
  return { tmp, config, secrets };
}

/** One `drover rpc` child; ask() sends a request and resolves with its reply line, parsed. */
function rpc({ tmp, config, secrets }) {
  const child = spawn(process.execPath, [BIN, 'rpc'], {
    env: { PATH: process.env.PATH, HOME: tmp, DROVER_CONFIG_DIR: config, DROVER_SECRETS_FILE: secrets, DROVER_DOTFILES: path.join(tmp, 'dotfiles'), DROVER_CACHE: path.join(tmp, 'cache'), DROVER_SEARCH: 'off', DROVER_RPC_STALE_CHECK_MS: '50' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = ''; const waiting = new Map();
  child.stdout.setEncoding('utf8').on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue; const m = JSON.parse(line); waiting.get(m.id)?.(m); waiting.delete(m.id); }
  });
  let n = 0;
  const ask = (op, args = {}) => new Promise((resolve) => { const id = ++n; waiting.set(id, resolve); child.stdin.write(JSON.stringify({ id, op, args }) + '\n'); });
  const end = async () => { child.stdin.end(); const [code] = await once(child, 'close'); return code; };
  return { ask, end };
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

test('settingsStamp: names, times and sizes of the settings and secrets files; a missing file is named, not an error', async (t) => {
  const s = await scratch(t);
  const a = await env.settingsStamp({ configDir: s.config, secrets: s.secrets });
  assert.match(a, /^00-shared\.env:\d+(\.\d+)?:\d+\|secrets:\d+(\.\d+)?:\d+$/);
  assert.doesNotMatch(a, /tester|FAKE_TEST_ONLY/, 'no contents');
  assert.equal(await env.settingsStamp({ configDir: s.config, secrets: s.secrets }), a, 'stable while nothing changes');
  assert.match(await env.settingsStamp({ configDir: s.config, secrets: path.join(s.tmp, 'nope') }), /\|nope:none$/);
  assert.equal(await env.settingsStamp({ configDir: path.join(s.tmp, 'no-dir'), secrets: s.secrets }), a.split('|').at(-1), 'no settings dir: only the secrets file');
});

test('a settings file added after start makes every later reply stale; before it, none is', async (t) => {
  const s = await scratch(t);
  const p = rpc(s);
  const first = await p.ask('launch.efforts');
  assert.equal(first.ok, true, first.error);
  await pause(250);
  assert.equal((await p.ask('launch.efforts')).stale, undefined, 'nothing changed: not stale');
  await writeFile(path.join(s.config, '50-host.env'), 'DROVER_CLAUDE_PROFILE=claude-x\n');
  await pause(250);
  const after = await p.ask('launch.efforts');
  assert.equal(after.ok, true, 'the call itself is still answered');
  assert.equal(after.stale, true);
  assert.equal(await p.end(), 0);
});

test('a rewritten secrets file (a rotated key) makes it stale too; a file merely read does not', async (t) => {
  const s = await scratch(t);
  const p = rpc(s);
  await p.ask('launch.efforts');
  await pause(250);
  assert.equal((await p.ask('launch.efforts')).stale, undefined);
  await writeFile(s.secrets, 'FAKE_TEST_ONLY=rotated-value\n');
  const later = new Date(Date.now() + 5000);
  await utimes(s.secrets, later, later);
  await pause(250);
  assert.equal((await p.ask('launch.efforts')).stale, true);
  assert.equal(await p.end(), 0);
});
