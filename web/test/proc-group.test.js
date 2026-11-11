import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run } from '../core/proc.js';

// A command that starts a grandchild and then hangs on it, like `claude` waiting on a `security` child that a wedged
// securityd never answers (Mac mini, 2026-11-10). The grandchild's pid lands in a file so the test can check on it.
const hangOnGrandchild = (pidFile) => ['-c', `sleep 30 & echo $! > '${pidFile}'; wait`];
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const settle = () => new Promise((r) => setTimeout(r, 200));

async function grandchildAfterTimeout(opts) {
  const dir = await mkdtemp(path.join(tmpdir(), 'drover-proc-'));
  const pidFile = path.join(dir, 'pid');
  const err = await run('sh', hangOnGrandchild(pidFile), { timeoutMs: 300, ...opts }).then(() => null, (e) => e);
  await settle();
  const pid = Number((await readFile(pidFile, 'utf8')).trim());
  return { err, pid };
}

test('run() without group: a timeout kills only the child and leaves its grandchild running (the leak)', async () => {
  const { err, pid } = await grandchildAfterTimeout({});
  assert.equal(err?.timedOut, true);
  try { assert.equal(alive(pid), true, 'control: a pid-only kill should leave the grandchild behind'); }
  finally { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
});

test('run() with group: a timeout kills the whole process group, grandchild included', async () => {
  const { err, pid } = await grandchildAfterTimeout({ group: true });
  assert.equal(err?.timedOut, true);
  assert.match(err.message, /timed out after 300ms/);
  assert.equal(alive(pid), false, 'the grandchild must die with its group');
});

test('run() with group still returns output and exit codes normally', async () => {
  const r = await run('sh', ['-c', 'echo hi; echo err >&2'], { group: true });
  assert.deepEqual([r.code, r.stdout, r.stderr], [0, 'hi\n', 'err\n']);
  await assert.rejects(run('sh', ['-c', 'exit 3'], { group: true }), (e) => e.code === 3 && !e.timedOut);
});

test('listAgentsCli pauses the CLI after a timeout, doubling the pause, and resets on success', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'drover-cc-'));
  process.env.CLAUDE_CONFIG_DIR = home;
  await mkdir(path.join(home, 'sessions'), { recursive: true });
  const claude = await import('../core/claude.js');
  claude.resetAgentsCliPause();
  let t = 1_000_000, calls = 0, mode = 'hang';
  const now = () => t;
  const runner = async (file, argv, opts) => {
    calls++;
    assert.equal(file, 'claude'); assert.deepEqual(argv, ['agents', '--json', '--all']);
    assert.equal(opts.group, true, 'claude must run in its own process group');
    if (mode === 'hang') throw Object.assign(new Error('timed out'), { timedOut: true });
    if (mode === 'fail') throw Object.assign(new Error('exit 1'), { code: 1 });
    return { stdout: JSON.stringify([{ sessionId: 's1' }]) };
  };
  const list = () => claude.listAgentsCli({ runner, now });

  assert.deepEqual(await list(), []); assert.equal(calls, 1);
  t += 59_000; assert.deepEqual(await list(), []); assert.equal(calls, 1, 'paused for 1 min after the first timeout');
  t += 2_000; await list(); assert.equal(calls, 2, 'retries once the pause ends');
  t += 119_000; await list(); assert.equal(calls, 2, 'second timeout doubles the pause to 2 min');
  t += 2_000; mode = 'ok';
  assert.deepEqual(await list(), [{ sessionId: 's1' }]); assert.equal(calls, 3);
  mode = 'fail'; await list(); await list(); assert.equal(calls, 5, 'a non-timeout failure does not pause');
  mode = 'hang'; await list(); t += 61_000; await list(); assert.equal(calls, 7, 'success reset the pause back to 1 min');
  for (let i = 0; i < 10; i++) { t += 16 * 60_000; await list(); }
  const before = calls; t += 14 * 60_000; await list(); assert.equal(calls, before, 'pause caps at 15 min');
  t += 2 * 60_000; await list(); assert.equal(calls, before + 1);
  claude.resetAgentsCliPause();
});
