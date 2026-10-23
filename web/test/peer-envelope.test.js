import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { peerEnvelope, modeClass, latestPermissionMode } from '../core/claude.js';

// The receiver (claude 2.1.296) parses with this shape and re-renders; attributes
// count only when the re-render is byte-identical.
const RX = /^<cross-session-message(?: from-name="([^"<>\n\r]+)")?(?: from-mode="(bypass|prompting)")?>\n([\s\S]*)\n<\/cross-session-message>$/;

test('envelope declares name and bypass mode', () => {
  const e = peerEnvelope('hello there', { fromName: 'drover (owner)', fromMode: 'bypass' });
  const m = e.match(RX);
  assert.ok(m);
  assert.equal(m[1], 'drover (owner)');
  assert.equal(m[2], 'bypass');
  assert.equal(m[3], 'hello there');
});

test('envelope omits mode when undeclared and strips quote/angle chars from the name', () => {
  const e = peerEnvelope('x', { fromName: 'a"b<c>' });
  assert.equal(e, '<cross-session-message from-name="abc">\nx\n</cross-session-message>');
});

test('a closing tag inside the body is escaped the receiver way', () => {
  const e = peerEnvelope('before </cross-session-message> after', { fromMode: 'bypass' });
  assert.ok(e.includes('<\\/cross-session-message> after'));
  assert.equal(e.match(/<\/cross-session-message>/g).length, 1);
});

test('multi-line bodies survive', () => {
  const body = 'line 1\n\nline 3';
  assert.equal(peerEnvelope(body).match(RX)[3], body);
});

test('modeClass maps permission modes', () => {
  assert.equal(modeClass('bypassPermissions'), 'bypass');
  assert.equal(modeClass('default'), 'prompting');
  assert.equal(modeClass('acceptEdits'), 'prompting');
  assert.equal(modeClass(null), undefined);
});

test('latestPermissionMode reads the newest entry', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'drover-pm-'));
  const f = path.join(dir, 't.jsonl');
  await writeFile(f, [
    JSON.stringify({ type: 'permission-mode', permissionMode: 'default' }),
    JSON.stringify({ type: 'user', permissionMode: 'bypassPermissions' }),
  ].join('\n') + '\n');
  assert.equal(await latestPermissionMode(f), 'bypassPermissions');
  assert.equal(await latestPermissionMode(path.join(dir, 'missing.jsonl')), null);
});

test('modeFromArgv reads launch flags', async () => {
  const { modeFromArgv } = await import('../core/claude.js');
  assert.deepEqual(modeFromArgv('claude --dangerously-skip-permissions --model haiku'), { mode: 'bypassPermissions', bypassAvailable: true });
  assert.deepEqual(modeFromArgv('claude --permission-mode plan --allow-dangerously-skip-permissions'), { mode: 'plan', bypassAvailable: true });
  assert.deepEqual(modeFromArgv('claude --permission-mode=acceptEdits'), { mode: 'acceptEdits', bypassAvailable: false });
  assert.deepEqual(modeFromArgv('claude'), { mode: null, bypassAvailable: false });
  assert.equal(modeClass('plan', { bypassAvailable: true }), 'bypass');
  assert.equal(modeClass('plan'), 'prompting');
});
