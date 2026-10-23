// ui/fleet-time.js: a host's time in a fleet search, shared by the Search view and the CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtMs, slowHost, waitedElsewhere, hostTime, hostTimeTitle } from '../ui/fleet-time.js';

test('fmtMs: milliseconds under a second, seconds with one decimal above, rounded before choosing', () => {
  assert.equal(fmtMs(212), '212 ms');
  assert.equal(fmtMs(999.4), '999 ms');
  assert.equal(fmtMs(999.6), '1.0 s');
  assert.equal(fmtMs(6574), '6.6 s');
});

test('a host is called out by time from a second up, the same line the format switches to seconds', () => {
  assert.equal(slowHost({ ms: 999 }), false);
  assert.equal(slowHost({ ms: 1000 }), true);
  assert.equal(slowHost({}), false);
});

test('the host\'s own search time is named only when a second or more went elsewhere', () => {
  assert.equal(waitedElsewhere({ ms: 6574, searchMs: 212 }), true);
  assert.equal(waitedElsewhere({ ms: 1150, searchMs: 200 }), false);
  assert.equal(waitedElsewhere({ ms: 6574 }), false, 'an older host reports no searchMs');
  assert.equal(hostTime({ ms: 6574, searchMs: 212 }), '6.6 s (search 212 ms)');
  assert.equal(hostTime({ ms: 159, searchMs: 150 }), '159 ms');
  assert.equal(hostTime({ ms: 6574, searchMs: null }), '6.6 s');
  assert.equal(hostTime({}), '');
});

test('the tooltip line spells both times out', () => {
  assert.equal(hostTimeTitle({ ms: 6574.4, searchMs: 212 }), 'answered in 6574 ms; its own search took 212 ms');
  assert.equal(hostTimeTitle({ ms: 80 }), 'answered in 80 ms');
  assert.equal(hostTimeTitle({}), '');
});
