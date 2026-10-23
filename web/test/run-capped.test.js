// runCapped (core/proc.js): a child's output is kept up to a cap per stream and the rest drained, so the child still
// ends with its real exit code; a timeout kills it; only a file that cannot start rejects. Real /bin/sh children.
// Run: node --test test/run-capped.test.js
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runCapped } from '../core/proc.js';

describe('runCapped', () => {
  test('under the cap: everything, the exit code, no truncation', async () => {
    const r = await runCapped('/bin/sh', ['-c', 'printf out; printf err >&2; exit 3']);
    assert.deepEqual({ ...r }, { code: 3, signal: null, stdout: 'out', stderr: 'err', truncated: false, timedOut: false });
  });
  test('past the cap: the first maxBytes kept, the rest drained, so the child finishes with its own exit code', async () => {
    // 4 MB through a pipe: a reader that stopped reading at the cap would stall the child until the timeout.
    const r = await runCapped('/bin/sh', ['-c', 'head -c 4194304 /dev/zero | tr "\\0" x; echo done >&2; exit 0'], { maxBytes: 1000, maxStderr: 2, timeoutMs: 20_000 });
    assert.equal(r.code, 0); assert.equal(r.timedOut, false); assert.equal(r.truncated, true);
    assert.equal(r.stdout, 'x'.repeat(1000));
    assert.equal(r.stderr, 'do');
  });
  test('tail: past the cap the last maxBytes are kept, so the newest output survives', async () => {
    const r = await runCapped('/bin/sh', ['-c', 'head -c 4194304 /dev/zero | tr "\\0" x; printf END'], { maxBytes: 1000, tail: true, timeoutMs: 20_000 });
    assert.equal(r.code, 0); assert.equal(r.truncated, true);
    assert.equal(r.stdout.length, 1000); assert.ok(r.stdout.endsWith('xxxEND'));
  });
  test('a timeout kills the child and says so; input reaches stdin', async () => {
    const t0 = Date.now();
    const r = await runCapped('/bin/sh', ['-c', 'sleep 30'], { timeoutMs: 300 });
    assert.equal(r.timedOut, true); assert.equal(r.signal, 'SIGKILL'); assert.ok(Date.now() - t0 < 5000);
    assert.equal((await runCapped('/bin/cat', [], { input: 'piped' })).stdout, 'piped');
  });
  test('a timeout kills what the child started too (a CLI plugin, a shell command), not only the child', async () => {
    const r = await runCapped('/bin/sh', ['-c', 'sleep 30 & echo $!; wait'], { timeoutMs: 300 });
    assert.equal(r.timedOut, true);
    const pid = Number(r.stdout.trim());
    assert.ok(pid > 0, r.stdout);
    await new Promise((res) => setTimeout(res, 100));
    assert.throws(() => process.kill(pid, 0), (e) => e.code === 'ESRCH', 'the grandchild is gone');
  });
  test('a file that cannot start rejects; nothing else does', async () => {
    await assert.rejects(runCapped('/nonexistent/drover-test-bin', []), (e) => e.code === 'ENOENT');
  });
});
