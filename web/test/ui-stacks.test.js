// The Stacks view's pure helpers: how a typed command becomes an argv (ui/views/stacks.js: split like a shell, nothing
// expanded), and the one-line summaries of a stack's counts and kinds (ui/stacks-text.js, shared with drover stacks).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { splitArgv } from '../ui/views/stacks.js';
import { countsLine, kindsLine } from '../ui/stacks-text.js';

describe('splitArgv', () => {
  test('words, quotes and backslashes as a shell splits them; nothing is expanded', () => {
    assert.deepEqual(splitArgv('node -v'), ['node', '-v']);
    assert.deepEqual(splitArgv(`sh -c 'echo "$HOME" | wc -l'`), ['sh', '-c', 'echo "$HOME" | wc -l']);
    assert.deepEqual(splitArgv('a\\ b "c d" e"f"g \'\''), ['a b', 'c d', 'efg', '']);
    assert.deepEqual(splitArgv('echo "a \\"q\\" \\$x \\n"'), ['echo', 'a "q" $x \\n']);
    assert.deepEqual(splitArgv('ls *.js; rm -rf / && echo $(id)'), ['ls', '*.js;', 'rm', '-rf', '/', '&&', 'echo', '$(id)'], 'operators and expansions stay literal text');
    assert.deepEqual(splitArgv('   '), []);
    assert.throws(() => splitArgv(`echo 'open`), /unclosed single quote/);
    assert.throws(() => splitArgv('echo "open'), /unclosed double quote/);
  });
});

describe('summaries', () => {
  test('counts: running with its parts, then the rest', () => {
    assert.equal(countsLine({ total: 83, running: 80, healthy: 77, up: 2, unhealthy: 1, starting: 0, completed: 3, failed: 0 }), '80 running: 77 healthy, 2 up (no check), 1 unhealthy; 3 completed');
    assert.equal(countsLine({ total: 2, running: 0, stopped: 2 }), '2 stopped');
    assert.equal(countsLine({ total: 0 }), 'no containers');
  });
  test('kinds: ok of total per kind, by its label or else its name, empty kinds left out; none for a stack without kinds', () => {
    assert.equal(kindsLine({ app: { total: 59, failing: ['web-app-reports'], label: 'apps' }, ml: { total: 2, failing: [], label: 'ML' }, core: { total: 0, failing: [] }, infra: { total: 8, failing: [] } }), 'apps 58/59 · ML 2/2 · infra 8/8');
    assert.equal(kindsLine({ edge: { total: 3, failing: ['a', 'b'] }, 'data-stores': { total: 1, failing: [] } }), 'edge 1/3 · data-stores 1/1', 'any kind names');
    assert.equal(kindsLine(null), null);
  });
});
