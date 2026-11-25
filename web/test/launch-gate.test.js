// The launch gate (core/launch-gate.js): the answer parser, the environment, and admit(), the loop around an external
// admission command. The gates here are real executables written into a temp directory; only the clock, the sleeping and
// the placement are faked, so no test waits out a real budget.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseGate, gateArgv, maxWaitSeconds, launchClassName, askGate, admit, GATE_TIMEOUT_MS } from '../core/launch-gate.js';
import { runCapped } from '../core/proc.js';

let dir;
before(async () => { dir = await mkdtemp(path.join(tmpdir(), 'drover-gate-')); });
after(() => rm(dir, { recursive: true, force: true }));

let n = 0;
/** An executable script with this body; returns its path. */
async function script(body) {
  const f = path.join(dir, `gate-${++n}.sh`);
  await writeFile(f, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return f;
}
/** A gate that answers each ask with the next line of answers (the last one repeats), logging the arguments it got. */
async function sequence(answers) {
  const counter = path.join(dir, `count-${++n}`), log = path.join(dir, `log-${n}`);
  const cases = answers.map((a, i) => `${i}) echo ${JSON.stringify(a)};;`).join(' ');
  const f = await script(`echo "$@" >> ${log}\nc=$(cat ${counter} 2>/dev/null || echo 0)\necho $((c + 1)) > ${counter}\ncase $c in ${cases} *) echo ${JSON.stringify(answers.at(-1))};; esac`);
  return { file: f, asks: async () => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean) };
}
/** A clock that only moves when a test sleeps; sleeps are recorded. */
const fakeTime = () => { const t = { ms: 1_000_000, slept: [] }; return { t, now: () => t.ms, sleep: async (ms) => { t.slept.push(ms); t.ms += ms; } }; };
const quiet = () => { const w = []; return { warns: w, warn: (m) => w.push(m) }; };

describe('parseGate', () => {
  test('the four answers, from the first non-empty line only', () => {
    assert.deepEqual(parseGate('go\n'), { decision: 'go' });
    assert.deepEqual(parseGate('\n  go  \nhold ignored'), { decision: 'go' });
    assert.deepEqual(parseGate('wait 20 swap runway 90 s\n'), { decision: 'wait', seconds: 20, reason: 'swap runway 90 s' });
    assert.deepEqual(parseGate('wait 5'), { decision: 'wait', seconds: 5, reason: '' });
    assert.deepEqual(parseGate('elsewhere box-b guard storm'), { decision: 'elsewhere', host: 'box-b', reason: 'guard storm' });
    assert.deepEqual(parseGate('elsewhere - guard storm'), { decision: 'elsewhere', host: null, reason: 'guard storm' });
    assert.deepEqual(parseGate('hold disk nearly full'), { decision: 'hold', reason: 'disk nearly full' });
    assert.deepEqual(parseGate('hold'), { decision: 'hold', reason: '' });
  });
  test('anything else is null (the caller fails open): empty, other words, a wait with no number or a non-positive one', () => {
    for (const bad of ['', '\n', 'maybe', 'wait', 'wait soon', 'wait 0', 'wait -3', 'elsewhere', 'GO', '{"go":true}']) assert.equal(parseGate(bad), null, JSON.stringify(bad));
  });
  test('a wait is clamped to an hour', () => assert.equal(parseGate('wait 999999 x').seconds, 3600));
});

describe('the environment', () => {
  test('DROVER_LAUNCH_GATE: an absolute path with optional fixed arguments, split on whitespace; unset or relative is none', () => {
    assert.equal(gateArgv({}), null);
    assert.equal(gateArgv({ DROVER_LAUNCH_GATE: '  ' }), null);
    assert.equal(gateArgv({ DROVER_LAUNCH_GATE: 'guard-gate' }), null, 'a bare name would search PATH: refused');
    assert.equal(gateArgv({ DROVER_LAUNCH_GATE: './gate' }), null);
    assert.deepEqual(gateArgv({ DROVER_LAUNCH_GATE: '/opt/guard/gate admit  --quiet' }), ['/opt/guard/gate', 'admit', '--quiet']);
    assert.deepEqual(gateArgv({ APXW_LAUNCH_GATE: '/opt/g' }), ['/opt/g'], 'the legacy spelling still works');
  });
  test('DROVER_LAUNCH_GATE_MAX_WAIT: seconds, default 90, 0 allowed, junk is the default', () => {
    assert.equal(maxWaitSeconds({}), 90);
    assert.equal(maxWaitSeconds({ DROVER_LAUNCH_GATE_MAX_WAIT: '30' }), 30);
    assert.equal(maxWaitSeconds({ DROVER_LAUNCH_GATE_MAX_WAIT: '0' }), 0);
    assert.equal(maxWaitSeconds({ DROVER_LAUNCH_GATE_MAX_WAIT: '-1' }), 90);
    assert.equal(maxWaitSeconds({ DROVER_LAUNCH_GATE_MAX_WAIT: 'x' }), 90);
    assert.equal(maxWaitSeconds({ DROVER_LAUNCH_GATE_MAX_WAIT: '' }), 90);
  });
  test('the class is the placement, else the engine\'s session class', () => {
    assert.equal(launchClassName({ engine: 'codex' }), 'codex-session');
    assert.equal(launchClassName({ engine: 'hermes' }), 'hermes-session');
    assert.equal(launchClassName({}), 'claude-session');
    assert.equal(launchClassName({ engine: 'codex', placement: 'heavy-build' }), 'heavy-build');
  });
});

describe('askGate: every failure is go, with one line on stderr', () => {
  test('a missing executable, a timeout, garbage and a crash', async () => {
    const q = quiet();
    const missing = await askGate('claude-session', { argv: [path.join(dir, 'nope')], warn: q.warn });
    assert.deepEqual([missing.decision, /could not run/.test(missing.failedOpen)], ['go', true]);
    const slow = await script('sleep 30');
    const run = (f, a, o) => runCapped(f, a, { ...o, timeoutMs: 300 });   // the real 5 s, shortened
    const timedOut = await askGate('claude-session', { argv: [slow], run, warn: q.warn });
    assert.deepEqual([timedOut.decision, timedOut.failedOpen], ['go', `timed out after ${GATE_TIMEOUT_MS / 1000} s`]);
    const garbage = await askGate('claude-session', { argv: [await script('echo banana split')], warn: q.warn });
    assert.deepEqual([garbage.decision, /nothing it understands/.test(garbage.failedOpen)], ['go', true]);
    const crash = await askGate('claude-session', { argv: [await script('echo oops >&2; exit 3')], warn: q.warn });
    assert.equal(crash.decision, 'go');
    assert.equal(q.warns.length, 4, 'one line each');
  });
  test('the answer wins over the exit code: hold with exit 75, go with a stray non-zero exit', async () => {
    assert.equal((await askGate('x', { argv: [await script('echo hold busy; exit 75')], warn: () => {} })).decision, 'hold');
    assert.equal((await askGate('x', { argv: [await script('echo go; exit 1')], warn: () => {} })).decision, 'go');
  });
});

describe('admit', () => {
  const ask = (env, extra = {}) => ({ className: 'claude-session', env, place: async () => { throw new Error('place was not expected'); }, ...extra });

  test('unset: proceed, no gate field, nothing run', async () => {
    assert.deepEqual(await admit(ask({})), { proceed: true });
  });

  test('go: proceeds, and the gate was run as <gate> <fixed args> <class>', async () => {
    const g = await sequence(['go']);
    const r = await admit(ask({ DROVER_LAUNCH_GATE: `${g.file} admit` }, { className: 'heavy-build' }));
    assert.deepEqual(r, { proceed: true, gate: { decision: 'go' } });
    assert.deepEqual(await g.asks(), ['admit heavy-build']);
  });

  test('wait, then go: sleeps what the gate asked and asks again; the result records the wait', async () => {
    const g = await sequence(['wait 30 swap runway short', 'go']);
    const time = fakeTime();
    const r = await admit({ ...ask({ DROVER_LAUNCH_GATE: g.file }), sleep: time.sleep, now: time.now });
    assert.deepEqual(r, { proceed: true, gate: { decision: 'go', waitedS: 30 } });
    assert.deepEqual(time.t.slept, [30_000]);
    assert.equal((await g.asks()).length, 2);
  });

  test('a wait is cut to what is left of the budget, and with the budget spent the launch goes ahead', async () => {
    const g = await sequence(['wait 60 busy']);
    const time = fakeTime();
    const r = await admit({ ...ask({ DROVER_LAUNCH_GATE: g.file, DROVER_LAUNCH_GATE_MAX_WAIT: '90' }), sleep: time.sleep, now: time.now });
    assert.deepEqual(time.t.slept, [60_000, 30_000]);
    assert.deepEqual(r, { proceed: true, gate: { decision: 'wait', reason: 'busy', expired: true, waitedS: 90 } });
  });

  test('elsewhere: another host is asked for with this one excluded (the gate\'s host as the preference), and the launch moves', async () => {
    const g = await sequence(['elsewhere box-b host guard storm']);
    const seen = [];
    const place = async (o) => { seen.push(o); return { host: 'box-b', reason: 'box-b: 9 GB' }; };
    const r = await admit({ ...ask({ DROVER_LAUNCH_GATE: g.file }), place });
    assert.deepEqual(seen, [{ exclude: ['local'], prefer: 'box-b' }]);
    assert.equal(r.proceed, false);
    assert.equal(r.place.host, 'box-b');
    assert.deepEqual(r.gate, { decision: 'elsewhere', reason: 'host guard storm', movedTo: 'box-b' });
    const dash = await sequence(['elsewhere - storm']);
    const seen2 = [];
    await admit({ ...ask({ DROVER_LAUNCH_GATE: dash.file }), place: async (o) => { seen2.push(o); return { host: 'box-c' }; } });
    assert.deepEqual(seen2, [{ exclude: ['local'] }], 'a dash is no preference');
  });

  test('elsewhere with no other eligible host is refused at once, naming the guard and the placement', async () => {
    const g = await sequence(['elsewhere - disk storm']);
    const time = fakeTime();
    await assert.rejects(admit({ ...ask({ DROVER_LAUNCH_GATE: g.file }), place: async () => ({ host: null, reason: 'no eligible host for claude-session: box-b: memory' }), sleep: time.sleep, now: time.now }),
      { message: 'nothing was started: host guard says disk storm; no other eligible host (no eligible host for claude-session: box-b: memory)' });
    assert.deepEqual(time.t.slept, [], 'no waiting');
    // a placement that answers local (it was told to exclude it, but must not be trusted to) is no other host either
    await assert.rejects(admit({ ...ask({ DROVER_LAUNCH_GATE: g.file }), place: async () => ({ host: 'local', reason: 'here' }) }), /nothing was started: host guard says disk storm; no other eligible host \(here\)/);
    await assert.rejects(admit({ ...ask({ DROVER_LAUNCH_GATE: g.file }), place: async () => { throw new Error('boom'); } }), /no other eligible host \(placement failed: boom\)/);
  });

  test('hold keeps asking and looking within the budget, then refuses; a host that turns up in time takes the launch', async () => {
    const g = await sequence(['hold storm: swap runway 20 s']);
    const time = fakeTime();
    let looks = 0;
    await assert.rejects(admit({ ...ask({ DROVER_LAUNCH_GATE: g.file, DROVER_LAUNCH_GATE_MAX_WAIT: '25' }), place: async () => { looks++; return { host: null, reason: 'nobody' }; }, sleep: time.sleep, now: time.now }),
      { message: 'nothing was started: host guard says storm: swap runway 20 s; no other eligible host (nobody)' });
    assert.deepEqual(time.t.slept, [10_000, 10_000, 5_000]);
    assert.equal(looks, 4, 'one look per ask, the last one at the end of the budget');
    const time2 = fakeTime();
    let k = 0;
    const r = await admit({ ...ask({ DROVER_LAUNCH_GATE: g.file }), place: async () => (++k < 3 ? { host: null, reason: 'nobody' } : { host: 'box-b' }), sleep: time2.sleep, now: time2.now });
    assert.deepEqual([r.proceed, r.place.host, r.gate], [false, 'box-b', { decision: 'hold', reason: 'storm: swap runway 20 s', movedTo: 'box-b', waitedS: 20 }]);
  });

  test('hold that clears (the gate says go on a later ask) goes ahead here', async () => {
    const g = await sequence(['hold busy', 'go']);
    const time = fakeTime();
    const r = await admit({ ...ask({ DROVER_LAUNCH_GATE: g.file }), place: async () => ({ host: null, reason: 'nobody' }), sleep: time.sleep, now: time.now });
    assert.deepEqual(r, { proceed: true, gate: { decision: 'go', waitedS: 10 } });
  });

  test('a gate that times out, is missing or answers nonsense is go, with the reason in the result', async () => {
    const q = quiet();
    const slow = await script('sleep 30');
    const r = await admit({ ...ask({ DROVER_LAUNCH_GATE: slow }), run: (f, a, o) => runCapped(f, a, { ...o, timeoutMs: 300 }), warn: q.warn });
    assert.deepEqual([r.proceed, r.gate.decision, r.gate.failedOpen], [true, 'go', 'timed out after 5 s']);
    const m = await admit({ ...ask({ DROVER_LAUNCH_GATE: path.join(dir, 'gone') }), warn: q.warn });
    assert.deepEqual([m.proceed, m.gate.decision], [true, 'go']);
    assert.equal(q.warns.length, 2);
  });

  test('an unset-looking value that is not an absolute path is ignored with one line', async () => {
    const q = quiet();
    assert.deepEqual(await admit({ ...ask({ DROVER_LAUNCH_GATE: 'relative/gate' }), warn: q.warn }), { proceed: true });
    assert.equal(q.warns.length, 1);
  });

  test('force skips the gate without running it', async () => {
    const g = await sequence(['hold nope']);
    for (const force of [true, 'true']) {
      const r = await admit(ask({ DROVER_LAUNCH_GATE: g.file }, { force }));
      assert.deepEqual(r, { proceed: true, gate: { decision: 'skipped', reason: 'force' } });
    }
    assert.deepEqual(await g.asks(), []);
    await assert.rejects(access(path.join(dir, `log-${n}`)), 'the gate never ran');
  });
});
