// The TUI's key decoder (tui/keys.js): what raw-mode terminals send, including sequences split across reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecoder } from '../tui/keys.js';

const ids = (evs) => evs.map((e) => e.id);
const decode = (...chunks) => { const d = createDecoder(); const out = []; for (const c of chunks) out.push(...d.feed(c)); out.push(...d.flush()); return out; };

test('text, controls and the keys a composer needs', () => {
  assert.deepEqual(ids(decode('aB?')), ['a', 'B', '?']);
  assert.deepEqual(decode('漢👍🏽').map((e) => e.ch), ['漢', '👍', '🏽'], 'astral code points stay whole');
  assert.deepEqual(ids(decode('\r\n\t\x7f\x08')), ['enter', 'C-j', 'tab', 'backspace', 'backspace']);
  assert.deepEqual(ids(decode('\x01\x03\x05\x0b\x10\x15\x17\x1a\x00')), ['C-a', 'C-c', 'C-e', 'C-k', 'C-p', 'C-u', 'C-w', 'C-z', 'C-space']);
  assert.deepEqual(ids(decode('\x1d\x1f')), ['C-]', 'C-_']);
});

test('CSI and SS3 keys with xterm modifiers', () => {
  assert.deepEqual(ids(decode('\x1b[A\x1b[B\x1b[C\x1b[D')), ['up', 'down', 'right', 'left']);
  assert.deepEqual(ids(decode('\x1bOA\x1bOH\x1bOF\x1bOP')), ['up', 'home', 'end', 'f1'], 'application mode (SS3)');
  assert.deepEqual(ids(decode('\x1b[H\x1b[F\x1b[1~\x1b[4~\x1b[7~\x1b[8~')), ['home', 'end', 'home', 'end', 'home', 'end']);
  assert.deepEqual(ids(decode('\x1b[5~\x1b[6~\x1b[3~\x1b[2~')), ['pgup', 'pgdn', 'delete', 'insert']);
  assert.deepEqual(ids(decode('\x1b[1;5A\x1b[1;3D\x1b[1;2B\x1b[1;5C')), ['C-up', 'M-left', 'S-down', 'C-right']);
  assert.deepEqual(ids(decode('\x1b[15~\x1b[24~\x1b[Z')), ['f5', 'f12', 'S-tab']);
  assert.deepEqual(ids(decode('\x1b[5;5~')), ['C-pgup']);
});

test('CSI u (kitty, tmux extended keys) maps to the same ids', () => {
  assert.deepEqual(ids(decode('\x1b[13u\x1b[13;2u\x1b[13;3u\x1b[27u\x1b[9;2u')), ['enter', 'S-enter', 'M-enter', 'escape', 'S-tab']);
  assert.deepEqual(ids(decode('\x1b[99;5u\x1b[106;5u\x1b[97;3u')), ['C-c', 'C-j', 'M-a']);
});

test('Alt is ESC then the key', () => {
  assert.deepEqual(ids(decode('\x1bb\x1bf\x1b\r\x1b\x7f')), ['M-b', 'M-f', 'M-enter', 'M-backspace']);
  assert.equal(decode('\x1bx')[0].alt, true);
});

test('a lone ESC is Escape only after the quiet moment (flush)', () => {
  const d = createDecoder();
  assert.deepEqual(d.feed('\x1b'), []);
  assert.equal(d.pending, true);
  assert.deepEqual(ids(d.flush()), ['escape']);
  assert.equal(d.pending, false);
  assert.deepEqual(ids(decode('\x1b\x1b[A')), ['escape', 'up'], 'ESC ESC [A: Escape, then up');
});

test('sequences split across reads (ssh, tmux) wait for the rest', () => {
  const d = createDecoder();
  assert.deepEqual(d.feed('\x1b'), []);
  assert.deepEqual(d.feed('['), []);
  assert.deepEqual(ids(d.feed('A')), ['up']);
  assert.deepEqual(d.feed('\x1b[1;'), []);
  assert.deepEqual(ids(d.feed('5D')), ['C-left']);
  assert.deepEqual(d.feed('\x1bO'), []);
  assert.deepEqual(ids(d.feed('B')), ['down']);
  assert.deepEqual(ids(d.feed('x\x1b')), ['x'], 'text before a cut sequence comes out at once');
  assert.deepEqual(ids(d.feed('[6~')), ['pgdn']);
});

test('bracketed paste arrives whole, even across chunks and with a split end marker', () => {
  const d = createDecoder();
  assert.deepEqual(d.feed('\x1b[200~line one\nline'), []);
  assert.equal(d.inPaste, true);
  assert.deepEqual(d.feed(' two\r\n\x1b[20'), []);
  const out = d.feed('1~z');
  assert.deepEqual(out.map((e) => e.id), ['paste', 'z']);
  assert.equal(out[0].text, 'line one\nline two\r\n');
  assert.deepEqual(decode('\x1b[200~\x1b[A not a key\x1b[201~').map((e) => [e.id, e.text]), [['paste', '\x1b[A not a key']], 'escape bytes inside a paste are text');
  const stuck = createDecoder(); stuck.feed('\x1b[200~half a paste');
  assert.deepEqual(stuck.flush().map((e) => e.id), [], 'a paste is not ended by the escape timeout');
  assert.deepEqual(stuck.flush({ force: true }).map((e) => [e.id, e.text]), [['paste', 'half a paste']], 'only by the long timeout');
});

test('a burst with a line break inside is a paste on terminals without bracketed paste', () => {
  assert.deepEqual(decode('first\rsecond').map((e) => [e.id, e.text]), [['paste', 'first\nsecond']]);
  assert.deepEqual(ids(decode('ok\r')), ['o', 'k', 'enter'], 'Enter at the end of a burst is still Enter');
});

test('mouse and focus reports are ignored', () => {
  assert.deepEqual(ids(decode('\x1b[<0;10;5M\x1b[I\x1b[Oa')), ['a']);
});
