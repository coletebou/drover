// The Wall's pure half (ui/wall-model.js): tile order, the scopes, state words, density, the capture plan (one call per host, panes on
// screen only), keyboard movement, and how a parsed pane run is styled (validated colors only). Synthetic strips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wallTiles, inScope, isHelper, stateWord, wantsReply, repliesDue, replyText, REPLY_MS, REPLY_MAX, SCOPES, RECENT_MS, densityGrid, capturePlan, moveIndex, runStyle, fitLines, tailText, CAPTURE_MAX } from '../ui/wall-model.js';
import { parseAnsi } from '../ui/ansi.js';

const S = (key, lane, name, host = 'local', extra = {}) => ({ key, lane, name, host, engine: 'claude', tmux: `work:${key}`, ...extra });

test('tiles: the board\'s order (waiting, working, idle; live before faded; the newest first); the manager is not a tile', () => {
  const at = (min) => new Date(Date.parse('2026-11-22T12:00:00Z') - min * 60_000).toISOString();
  const t = wallTiles([S('a', 'idle', 'alpha', 'local', { since: at(90) }), S('b', 'work', 'zeta', 'local', { since: at(5) }), S('c', 'wait', 'mid', 'local', { since: at(30) }), S('d', 'work', 'beta', 'local', { since: at(1) }),
    S('m', 'idle', 'manager', 'local', { engine: 'openclaw' }), S('e', 'wait', 'mid', 'devbox', { since: at(2) }), S('f', 'idle', 'omega', 'local', { since: at(3) }), S('g', 'idle', 'ghost', 'local', { since: at(1), faded: true })]);
  assert.deepEqual(t.map((x) => x.key), ['e', 'c', 'd', 'b', 'f', 'a', 'g'], 'by name, months-old sessions took the first rows');
  assert.deepEqual(wallTiles([S('b', 'idle', 'beta'), S('a', 'idle', 'alpha')]).map((x) => x.key), ['a', 'b'], 'no times: by name');
});

test('scopes: Active is waiting, working and idle for less than a day; Live is waiting and working; All is the board', () => {
  const now = Date.parse('2026-11-22T12:00:00Z');
  const h = (n) => new Date(now - n * 3600_000).toISOString();
  const strips = [S('w', 'wait', 'old ask', 'local', { since: h(900) }), S('k', 'work', 'busy', 'local', { since: h(3) }), S('p', 'work', 'program', 'local', { since: h(0), tmux: null, entrypoint: 'sdk-cli' }),
    S('i', 'idle', 'recent', 'local', { since: h(23) }), S('o', 'idle', 'old', 'local', { since: h(25) }), S('n', 'idle', 'no time', 'local', { since: null }), S('x', 'work', 'sdk in a pane', 'local', { since: h(1), entrypoint: 'sdk-cli' })];
  const keys = (scope) => wallTiles(strips, { scope, now }).map((x) => x.key);
  assert.deepEqual(keys('active'), ['w', 'x', 'k', 'i'], 'what waits is never hidden; a program run with no pane is; an old idle one is');
  assert.deepEqual(keys('live'), ['w', 'x', 'k']);
  assert.deepEqual(keys('all'), ['w', 'p', 'x', 'k', 'i', 'o', 'n']);
  assert.deepEqual(keys(undefined), keys('all'), 'no scope: all');
  assert.deepEqual(SCOPES.map(([id]) => id), ['active', 'live', 'all']);
  assert.equal(RECENT_MS, 24 * 3600_000);
  assert.equal(isHelper(strips[2]), true); assert.equal(isHelper(strips[6]), false, 'a program in a pane can be watched');
  assert.equal(inScope(strips[4], 'active', now), false); assert.equal(inScope(strips[0], 'live', now), true);
});

test('state words and who is asked for a last reply', () => {
  assert.equal(stateWord({ lane: 'wait', status: 'idle' }), 'waiting');
  assert.equal(stateWord({ lane: 'work', status: 'busy' }), 'working');
  assert.equal(stateWord({ lane: 'idle', status: 'idle' }), 'idle');
  for (const st of ['done', 'failed', 'blocked', 'stopped', 'dead']) assert.equal(stateWord({ lane: 'idle', status: st }), st);
  assert.equal(stateWord({ lane: 'idle', status: 'shell' }), 'idle');
  assert.equal(wantsReply({ id: 's1', kind: 'session', tmux: null }), true);
  assert.equal(wantsReply({ id: 's1', kind: 'session', tmux: 'work:1' }), false, 'a pane says more');
  assert.equal(wantsReply({ id: 'work:1', kind: 'window', tmux: null }), false);
  assert.equal(wantsReply(null), false);
  // Asked seldom: a working one every REPLY_MS.work, the rest every REPLY_MS.other, never one with a call out, a few at a time.
  const now = 1_000_000;
  const tiles = [{ key: 'a', id: 'a', lane: 'work' }, { key: 'b', id: 'b', lane: 'idle' }, { key: 'c', id: 'c', lane: 'work', tmux: 'w:1' }, { key: 'd', id: 'd', lane: 'idle' }, { key: 'e', id: 'e', lane: 'work' }];
  const replies = new Map([['a', { at: now - REPLY_MS.work }], ['b', { at: now - REPLY_MS.work }], ['e', { at: now - 1000 }]]);
  assert.deepEqual(repliesDue(tiles, { replies, asking: new Set(['d']), now }).map((s) => s.key), ['a']);
  assert.deepEqual(repliesDue(tiles, { now }).map((s) => s.key), ['a', 'b', 'd', 'e'], 'never asked: all without a pane');
  assert.equal(repliesDue(Array.from({ length: 20 }, (_, i) => ({ key: `k${i}`, id: `k${i}`, lane: 'idle' })), { now }).length, REPLY_MAX);
  assert.equal(replyText({ text: 'done' }, { text: 'before' }), 'done');
  assert.equal(replyText({ text: null }, { text: 'before' }), 'before', 'nothing in the tail: what it said before stands');
  assert.equal(replyText({ text: '  ' }, null), '');
});

test('density: 1x1 up to 6x5, clamped', () => {
  assert.deepEqual(densityGrid(1), { cols: 1, rows: 1 });
  assert.deepEqual(densityGrid(6), { cols: 6, rows: 5 });
  assert.deepEqual(densityGrid(99), { cols: 6, rows: 5 });
  assert.deepEqual(densityGrid('x'), { cols: 3, rows: 2 });
});

test('capture plan: one list per host, only tiles on screen, no pane no capture, capped', () => {
  const tiles = [S('a', 'wait', 'a'), S('b', 'work', 'b', 'devbox'), S('c', 'idle', 'c'), S('g', 'idle', 'bot', 'local', { tmux: null, engine: 'grok' })];
  const plan = capturePlan(tiles, new Set(['a', 'b', 'g']));
  assert.deepEqual([...plan.entries()], [['local', ['work:a']], ['devbox', ['work:b']]]);
  const many = Array.from({ length: 80 }, (_, i) => S(`k${i}`, 'work', `n${i}`));
  assert.equal(capturePlan(many).get('local').length, CAPTURE_MAX);
});

test('arrows and h j k l move on the grid and stop at its edges', () => {
  assert.equal(moveIndex(-1, 'ArrowRight', 3, 7), 0, 'nothing selected: the first tile');
  assert.equal(moveIndex(0, 'ArrowRight', 3, 7), 1);
  assert.equal(moveIndex(0, 'ArrowLeft', 3, 7), 0);
  assert.equal(moveIndex(1, 'ArrowDown', 3, 7), 4);
  assert.equal(moveIndex(4, 'j', 3, 7), 4, 'no tile below');
  assert.equal(moveIndex(4, 'k', 3, 7), 1);
  assert.equal(moveIndex(2, 'x', 3, 7), 2);
  assert.equal(moveIndex(0, 'ArrowRight', 3, 0), -1);
});

test('runs are styled from validated colors only; reverse swaps; attributes map', () => {
  const [line] = parseAnsi('\x1b[1;38;5;208mhot\x1b[0m \x1b[7mrev\x1b[27m \x1b[2;3;4mdim\x1b[0m');
  const [hot, , rev, , dim] = line;
  assert.deepEqual(runStyle(hot), { color: '#ff8700', fontWeight: '600' });
  assert.deepEqual(runStyle(rev), { color: 'var(--term-bg)', backgroundColor: 'var(--term-fg)' });
  assert.deepEqual(runStyle(dim), { opacity: '0.6', fontStyle: 'italic', textDecoration: 'underline' });
  assert.deepEqual(runStyle({ fg: 'red;background:url(x)', bg: 'javascript:1' }), {}, 'anything but #rrggbb is dropped');
  assert.deepEqual(runStyle({ fg: '#00ff00', bg: '#000000', reverse: true }), { color: '#000000', backgroundColor: '#00ff00' });
});

test('fitLines and tailText', () => {
  assert.equal(fitLines(100, 16), 6);
  assert.equal(fitLines(0, 16), 1);
  assert.equal(tailText({ tail: ['Do you want to proceed?', ''] }), 'Do you want to proceed?');
  assert.equal(tailText({ tail: [], status: 'idle' }), 'idle');
  assert.equal(tailText({ tail: ['new task? /clear to save 12k tokens', '─'.repeat(30), '❯'], status: 'idle' }), 'idle', 'a tail that is the pane\'s furniture says nothing');
  assert.equal(tailText({ tail: ['Done.', '─'.repeat(30), '❯'] }), 'Done.');
});
