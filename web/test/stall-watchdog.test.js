// The stall watchdog (core/stall-watchdog.js): the decision is pure, so it is tested with made-up clocks; one test starts
// the real thing in a child process whose event loop then blocks, with a 2 second limit instead of the default 180.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { stallStep, stallStart, stallSeconds, DEFAULT_STALL_SECONDS } from '../core/stall-watchdog.js';

const LIMIT = { limitMs: 180_000 };

describe('stallSeconds', () => {
  test('defaults to 180; 0 turns it off; junk is the default; fractions are kept', () => {
    assert.equal(DEFAULT_STALL_SECONDS, 180);
    assert.equal(stallSeconds({}), 180);
    assert.equal(stallSeconds({ DROVER_STALL_EXIT_SECONDS: '0' }), 0);
    assert.equal(stallSeconds({ DROVER_STALL_EXIT_SECONDS: '-5' }), 0);
    assert.equal(stallSeconds({ DROVER_STALL_EXIT_SECONDS: '45' }), 45);
    assert.equal(stallSeconds({ DROVER_STALL_EXIT_SECONDS: '2.5' }), 2.5);
    assert.equal(stallSeconds({ DROVER_STALL_EXIT_SECONDS: 'soon' }), 180);
    assert.equal(stallSeconds({ DROVER_STALL_EXIT_SECONDS: '' }), 180);
    assert.equal(stallSeconds({ APXW_STALL_EXIT_SECONDS: '9' }), 9, 'the legacy spelling still works');
  });
});

describe('stallStep', () => {
  // A look every second of both clocks, the counter either moving or not.
  const run = (looks, state = stallStart(0, 1_000_000)) => {
    const out = [];
    for (const l of looks) { const r = stallStep(state, l, LIMIT); state = r.state; out.push(r); }
    return out;
  };

  test('a counter that keeps moving is never a stall', () => {
    const rs = run(Array.from({ length: 400 }, (_, i) => ({ count: i, mono: (i + 1) * 1000, wall: 1_000_000 + (i + 1) * 1000 })));
    assert.ok(rs.every((r) => !r.stalled && !r.slept));
  });

  test('a counter that stops is a stall once it has been still for the limit, not before', () => {
    const rs = run(Array.from({ length: 200 }, (_, i) => ({ count: 7, mono: (i + 1) * 1000, wall: 1_000_000 + (i + 1) * 1000 })));
    // the first look sets the count (changed at 1 s); 180 s of stillness after that is 181 s
    const first = rs.findIndex((r) => r.stalled);
    assert.equal(first, 180, 'look 181, 180 s after the count was last seen to change');
    assert.ok(rs.slice(0, 180).every((r) => !r.stalled));
  });

  test('a beat after a long stillness clears it', () => {
    const rs = run([
      { count: 1, mono: 1000, wall: 1_001_000 },
      { count: 1, mono: 170_000, wall: 1_170_000 },
      { count: 2, mono: 171_000, wall: 1_171_000 },
      { count: 2, mono: 300_000, wall: 1_300_000 },
    ]);
    assert.deepEqual(rs.map((r) => r.stalled), [false, false, false, false], '129 s since the beat at 171 s is under the limit');
  });

  test('a sleep is not a stall: the wall clock jumped, the monotonic one did not, and the count restarts', () => {
    const rs = run([
      { count: 3, mono: 1000, wall: 1_001_000 },
      { count: 3, mono: 2000, wall: 1_002_000 },
      // the lid closes for an hour: wall moves 3600 s, monotonic 1 s
      { count: 3, mono: 3000, wall: 1_002_000 + 3_600_000 },
      { count: 3, mono: 4000, wall: 1_003_000 + 3_600_000 },
    ]);
    assert.deepEqual(rs.map((r) => r.slept), [false, false, true, false]);
    assert.ok(rs.every((r) => !r.stalled));
    // and a real stall after the wake still counts from the wake
    const after = run(Array.from({ length: 181 }, (_, i) => ({ count: 3, mono: 4000 + (i + 1) * 1000, wall: 1_003_000 + 3_600_000 + (i + 1) * 1000 })), rs.at(-1).state);
    assert.equal(after.findIndex((r) => r.stalled), 178, '180 s after the look that saw the wake, at 3 s');
  });

  test('ordinary clock drift under the slack is not a sleep', () => {
    const r = stallStep(stallStart(0, 0), { count: null, mono: 1000, wall: 4000 }, LIMIT);
    assert.equal(r.slept, false);
  });
});

describe('the real watchdog', () => {
  const child = (env, body) => new Promise((resolve) => {
    const script = `import { startStallWatchdog } from ${JSON.stringify(new URL('../core/stall-watchdog.js', import.meta.url).href)};\n${body}`;
    const p = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('NODE_TEST'))), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    const t0 = Date.now();
    p.on('close', (code, signal) => resolve({ code, signal, out, err, ms: Date.now() - t0 }));
  });

  test('a blocked event loop is killed (SIGKILL) after the limit, with one line on stderr', async () => {
    const r = await child({ DROVER_STALL_EXIT_SECONDS: '2' }, 'startStallWatchdog(); console.log("up"); const t = Date.now(); while (Date.now() - t < 20000) {}');
    assert.equal(r.signal, 'SIGKILL');
    assert.match(r.err, /^drover: the event loop has not run for \d+ s \(limit 2 s\); ending the daemon/m);
    assert.equal(r.err.trim().split('\n').length, 1);
    assert.ok(r.ms < 12_000, `killed in ${r.ms} ms, not after the whole 20 s block`);
  });

  test('a healthy loop is left alone, and 0 turns the watchdog off even for a blocked one', async () => {
    const healthy = await child({ DROVER_STALL_EXIT_SECONDS: '2' }, 'startStallWatchdog(); setTimeout(() => console.log("done"), 4500);');
    assert.deepEqual([healthy.code, healthy.signal, healthy.out.trim()], [0, null, 'done']);
    const off = await child({ DROVER_STALL_EXIT_SECONDS: '0' }, 'startStallWatchdog(); const t = Date.now(); while (Date.now() - t < 4500) {} console.log("survived");');
    assert.deepEqual([off.code, off.signal, off.out.trim()], [0, null, 'survived']);
  });
});
