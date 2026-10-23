// What the command palette searches (ui/palette.js paletteIndex): the board's strips when the daemon has the compact
// board (the fleet summary no longer streams then, so its copy goes stale), else the fleet summary, else the local
// snapshot. Synthetic state only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paletteIndex } from '../ui/palette.js';

const fleet = { hosts: [{ host: 'local', sessions: [{ id: 'old', name: 'old-session', live: true, engine: 'claude' }], windows: [{ target: 'work:@1', name: 'shell', session: 'work' }] }] };
const strips = [
  { key: 'local|old', id: 'old', sessionId: 'old', kind: 'session', name: 'old-session', host: 'local', engine: 'claude', lane: 'idle', status: 'idle' },
  { key: 'local|new', id: 'new', sessionId: 'new', kind: 'session', name: 'new-session', host: 'local', engine: 'claude', lane: 'wait', status: 'idle', tmux: 'work:@2' },
  { key: 'local|work:@3', id: 'work:@3', sessionId: 'abc', kind: 'window', name: 'pane-agent', host: 'devbox', engine: 'codex', lane: 'work', status: 'busy', tmux: 'work:@3' },
];

test('with the compact board, agents come from its strips (a session started after the first fleet read is found)', () => {
  const ix = paletteIndex({ board: { strips }, fleet }, strips);
  assert.deepEqual(ix.sessions.map((s) => s.name), ['old-session', 'new-session', 'pane-agent']);
  const n = ix.sessions.find((s) => s.name === 'new-session');
  assert.deepEqual([n.status, n.open.kind, n.open.id], ['waiting', 'session', 'new']);
  const w = ix.sessions.find((s) => s.name === 'pane-agent');
  assert.deepEqual([w.id, w.open.kind, w.open.id, w.open.sessionId, w.host], ['abc', 'window', 'work:@3', 'abc', 'devbox'], 'a window strip opens as its window');
  assert.deepEqual(ix.windows.map((x) => x.target), ['work:@1'], 'plain windows still come from the fleet summary');
});

test('an older daemon: everything from the fleet summary; before any fleet read, the local snapshot', () => {
  assert.deepEqual(paletteIndex({ fleet }, []).sessions.map((s) => s.name), ['old-session']);
  const snap = paletteIndex({ snapshot: { sessions: [{ id: 's', name: 'snap' }], windows: [{ target: 'x:@1' }] } }, []);
  assert.deepEqual([snap.sessions[0].host, snap.windows[0].host], ['local', 'local']);
  assert.deepEqual(paletteIndex({}, []), { sessions: [], windows: [] });
});
