// startLines (core/proc.js): a long-lived child read line by line. A command that is not installed (codex on a box
// without it) must arrive as its exit, once, and never as an uncaught 'error' that ends the daemon. Real children.
// Run: node --test test/start-lines.test.js
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startLines } from '../core/proc.js';

const exited = (opts = {}) => {
  const seen = { exits: [], lines: [], stderr: '' };
  const done = new Promise((resolve) => {
    seen.child = startLines(opts.file, opts.argv ?? [], {
      onLine: (l) => seen.lines.push(l),
      onStderr: (d) => { seen.stderr += d; },
      onExit: (code, sig) => { seen.exits.push([code, sig]); setTimeout(resolve, 200); },
    });
  });
  return { seen, done };
};

describe('startLines', () => {
  test('a command that is not installed is an exit, once, with nothing thrown, even after a write to its stdin', async () => {
    const uncaught = [];
    const hear = (e) => uncaught.push(e);
    process.on('uncaughtException', hear);
    try {
      const { seen, done } = exited({ file: 'drover-test-no-such-command', argv: ['app-server'] });
      seen.child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"x"}\n');
      await done;
      assert.deepEqual(seen.exits, [[null, 'ENOENT']]);
      assert.match(seen.stderr, /drover-test-no-such-command: spawn drover-test-no-such-command ENOENT/);
      assert.deepEqual(uncaught, []);
    } finally { process.off('uncaughtException', hear); }
  });
  test('a child that runs: its lines, the last one without a newline too, and its exit code, once', async () => {
    const { seen, done } = exited({ file: '/bin/sh', argv: ['-c', 'printf "one\\n\\ntwo\\nlast"; exit 3'] });
    await done;
    assert.deepEqual(seen.lines, ['one', 'two', 'last']);
    assert.deepEqual(seen.exits, [[3, null]]);
  });
});
