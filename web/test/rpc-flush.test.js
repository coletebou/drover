// bin/drover rpc: a reply bigger than the pipe buffer reaches a slow reader whole even when stdin has
// already ended, which is what a retired peer (core/remote.js retire()) does while it still waits for
// replies. process.exit drops whatever stdout has not handed to the kernel yet (measured 2026-10-15:
// a 4 MB write then exit delivers 65,536 bytes on macOS and Linux, over ssh too).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/drover', import.meta.url));

test('drover rpc writes out its last reply before it exits on stdin end', async (t) => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'drover-rpc-'));
  // Each run writes a 1.5 MB events file here; left behind, a day of suite runs on the Mac piled up
  // 132 of these directories (2026-10-18).
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const events = path.join(tmp, 'dotfiles', 'claude', 'drover-events.jsonl');
  await mkdir(path.dirname(events), { recursive: true });
  const N = 4000;   // about 1.5 MB of reply: far past the 64 KB pipe buffer plus the reader's own buffer
  await writeFile(events, Array.from({ length: N }, (_, i) => JSON.stringify({ id: `ev-${i}`, ts: new Date(1_700_000_000_000 + i).toISOString(), type: 'note', about: 'flush', text: 'x'.repeat(300) })).join('\n') + '\n');
  const child = spawn(process.execPath, [BIN, 'rpc'], {
    env: { PATH: process.env.PATH, HOME: tmp, DROVER_EVENTS: events, DROVER_DOTFILES: path.join(tmp, 'dotfiles'), DROVER_CACHE: path.join(tmp, 'cache'), DROVER_SECRETS_FILE: path.join(tmp, 'no-secrets'), DROVER_SEARCH: 'off' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let err = ''; child.stderr.setEncoding('utf8').on('data', (d) => { err += d; });
  const closed = once(child, 'close');
  // Read nothing for a while, like a slow ssh link: the reply backs up behind a full pipe. A
  // 'readable' listener holds the data; with no listener at all Node discards unread stdio when
  // the child exits.
  let out = '', reading = false;
  const drain = () => { let c; while ((c = child.stdout.read()) !== null) out += c; };
  child.stdout.setEncoding('utf8').on('readable', () => { if (reading) drain(); });
  child.stdin.end(JSON.stringify({ id: 1, op: 'events.tail', args: { limit: N } }) + '\n');
  await new Promise((r) => setTimeout(r, 1500));
  reading = true; drain();
  const [code] = await closed;
  assert.equal(code, 0, err);
  const lines = out.split('\n').filter(Boolean);
  assert.equal(lines.length, 1, `one reply line (got ${out.length} bytes)`);
  const msg = JSON.parse(lines[0]);
  assert.equal(msg.ok, true, msg.error);
  assert.equal(msg.result.length, N, 'every event made it');
});

test('drover rpc answers lines that are not requests and still exits cleanly', async (t) => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'drover-rpc-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const child = spawn(process.execPath, [BIN, 'rpc'], {
    env: { PATH: process.env.PATH, HOME: tmp, DROVER_DOTFILES: path.join(tmp, 'dotfiles'), DROVER_CACHE: path.join(tmp, 'cache'), DROVER_SECRETS_FILE: path.join(tmp, 'no-secrets'), DROVER_SEARCH: 'off' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = ''; child.stdout.setEncoding('utf8').on('data', (d) => { out += d; });
  child.stdin.end('not json\nnull\n[1]\n');
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
  assert.deepEqual(out.split('\n').filter(Boolean).map((l) => JSON.parse(l)), [{ id: null, ok: false, error: 'bad json' }, { id: null, ok: false, error: 'bad request' }, { id: null, ok: false, error: 'bad request' }]);
});
