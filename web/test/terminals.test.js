// A browser terminal (core/terminals.js, ttyd on 127.0.0.1) takes a websocket only from its own page: a page from any
// other origin cannot connect to its port and type into the tmux session. Needs ttyd and tmux; skipped without them.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import * as terminals from '../core/terminals.js';

const run = promisify(execFile);
const have = async (cmd, args) => run(cmd, args).then(() => true, () => false);
const ready = (await have('ttyd', ['--version'])) && (await have('tmux', ['-V']));
const SESSION = `drover-ttyd-test-${process.pid}`;

/** Ask ttyd's /ws to upgrade with this Origin: 101 when it takes the socket, else the refusal. */
function upgrade(port, origin) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port, path: '/ws', headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Protocol': 'tty', Origin: origin } });
    r.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
    r.on('response', (res) => { res.resume(); resolve(res.statusCode); });
    r.on('error', () => resolve('refused'));
    r.end();
  });
}

describe('terminals', { skip: ready ? false : 'needs ttyd and tmux' }, () => {
  let t, tdir, saved;
  // A private tmux server (its own TMUX_TMPDIR, no TMUX variable): ttyd's tmux attach inherits this env, so neither the
  // session nor the terminal reaches the user's own server. The kill names that server's socket.
  const sock = () => path.join(tdir, `tmux-${process.getuid()}`, 'default');
  before(async () => {
    saved = Object.fromEntries(['TMUX', 'TMUX_PANE', 'TMUX_TMPDIR'].map((k) => [k, process.env[k]]));
    tdir = await mkdtemp(path.join(tmpdir(), 'droverttyd-'));
    delete process.env.TMUX; delete process.env.TMUX_PANE;
    process.env.TMUX_TMPDIR = tdir;
    await run('tmux', ['-f', '/dev/null', 'new-session', '-d', '-s', SESSION, 'sleep 120']);
    t = await terminals.open(SESSION);
  });
  after(async () => {
    if (t) terminals.close(t.id);
    if (tdir) await run('tmux', ['-S', sock(), 'kill-server']).catch(() => {});
    for (const [k, v] of Object.entries(saved ?? {})) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    if (tdir) await rm(tdir, { recursive: true, force: true });
  });

  test('a page from another origin is refused the websocket', async () => {
    assert.equal(t.alive, true);
    assert.notEqual(await upgrade(t.port, 'http://evil.example'), 101);
    assert.notEqual(await upgrade(t.port, 'http://127.0.0.1:1'), 101, 'not even another loopback port');
  });
  test('its own page gets it', async () => {
    assert.equal(await upgrade(t.port, `http://127.0.0.1:${t.port}`), 101);
  });
});
