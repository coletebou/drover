// Alerts: the shared policy (ui/notify-policy.js), the transition detector and
// MR diff (core/notify.js), the Notifier's stamping/dedupe/ring, and the notify
// ops. No tmux, no daemon: every side effect goes through injected deps.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_SETTINGS, CATEGORY_IDS, SOUND_IDS, classifyAsk, excerpt, endsWithQuestion, validatePatch, mergeSettings, foldSettings, muteFor, inQuietHours, decide, coalesce, rateLimit, speechFor, tmuxSessionOf, validatePeer,
} from '../ui/notify-policy.js';
import { snapshotOf, diffSnapshots, diffMRs, alertFromEvent, Notifier, windowOf, _deps as notifyDeps, ops as notifyOps, notifier } from '../core/notify.js';
import { heldMessage, dialogSummary, screenHash, classifyScreen } from '../core/tmux.js';
import { askFromLines } from '../core/claude.js';

const s = (over = {}) => mergeSettings(DEFAULT_SETTINGS, over);

describe('policy: settings validation', () => {
  test('defaults cover every category with a known sound', () => {
    for (const c of CATEGORY_IDS) {
      const d = DEFAULT_SETTINGS.categories[c];
      assert.ok(d, `default for ${c}`);
      assert.ok(SOUND_IDS.includes(d.sound), `${c} sound ${d.sound}`);
      assert.ok(d.volume >= 0 && d.volume <= 1);
    }
  });
  test('a good patch is cleaned and clamped', () => {
    const p = validatePatch({ categories: { finished: { sound: 'ping', volume: 4 } }, coalesce: { windowMs: '900' }, quietHours: { enabled: true, start: '23:30', end: '06:00', allow: ['needs-you', 'needs-you'] } });
    assert.deepEqual(p, { categories: { finished: { sound: 'ping', volume: 1 } }, coalesce: { windowMs: 900 }, quietHours: { enabled: true, start: '23:30', end: '06:00', allow: ['needs-you'] } });
  });
  test('unknown keys, categories, sounds and bad types are actionable errors', () => {
    assert.throws(() => validatePatch({ nope: 1 }), /unknown setting nope/);
    assert.throws(() => validatePatch({ categories: { lunch: { sound: 'ping' } } }), /unknown category "lunch"/);
    assert.throws(() => validatePatch({ categories: { finished: { sound: 'kazoo' } } }), /unknown sound "kazoo"/);
    assert.throws(() => validatePatch({ master: 'yes' }), /master: expected true or false/);
    assert.throws(() => validatePatch({ quietHours: { start: '25:00' } }), /HH:MM/);
    assert.throws(() => validatePatch({ mutes: [{ scope: 'planet', target: 'x' }] }), /mute.scope/);
    assert.throws(() => validatePatch([]), /must be an object/);
  });
  test('peer entries never carry a token to the daemon', () => {
    assert.throws(() => validatePeer({ name: 'box-b', url: 'http://127.0.0.1:17337', token: 'x' }), /tokens stay in the browser/);
    assert.deepEqual(validatePeer({ name: 'box-b', url: 'http://127.0.0.1:17337/api' }), { name: 'box-b', url: 'http://127.0.0.1:17337/' });
    assert.throws(() => validatePeer({ name: 'box-b', url: 'file:///etc/passwd' }), /http or https/);
  });
  test('fold applies patches in order, skips invalid ones, arrays replace', () => {
    const f = foldSettings([{ master: false }, { bogus: true }, { master: true, mutes: [{ scope: 'host', target: 'devbox' }] }, { mutes: [] }]);
    assert.equal(f.master, true);
    assert.deepEqual(f.mutes, []);
    assert.equal(f.categories.finished.sound, DEFAULT_SETTINGS.categories.finished.sound);
  });
});

describe('policy: decisions', () => {
  const alert = { category: 'finished', host: 'devbox', sessionId: 'abc', name: 'webapp-f8', target: 'agents:@12' };
  test('mutes match host, session id or name, tmux session, category; expired mutes do not', () => {
    const now = Date.parse('2026-10-11T12:00:00Z');
    assert.equal(muteFor(alert, s({ mutes: [{ id: 'a', scope: 'host', target: 'devbox' }] }), now).id, 'a');
    assert.ok(muteFor(alert, s({ mutes: [{ id: 'b', scope: 'session', target: 'webapp-f8' }] }), now));
    assert.ok(muteFor(alert, s({ mutes: [{ id: 'c', scope: 'tmux', target: 'agents' }] }), now));
    assert.ok(muteFor(alert, s({ mutes: [{ id: 'd', scope: 'category', target: 'finished' }] }), now));
    assert.equal(muteFor(alert, s({ mutes: [{ id: 'e', scope: 'host', target: 'devbox', until: '2026-10-11T11:00:00Z' }] }), now), null);
    assert.equal(muteFor(alert, s({ mutes: [{ id: 'f', scope: 'tmux', target: 'agents', host: 'box-b' }] }), now), null, 'a host-scoped tmux mute does not leak to other hosts');
    assert.equal(tmuxSessionOf('agents:@12.%3'), 'agents');
  });
  test('quiet hours across midnight and inside a day', () => {
    const q = s({ quietHours: { enabled: true, start: '22:00', end: '07:00' } });
    assert.equal(inQuietHours(q, new Date(2026, 9, 11, 23, 15)), true);
    assert.equal(inQuietHours(q, new Date(2026, 9, 11, 6, 59)), true);
    assert.equal(inQuietHours(q, new Date(2026, 9, 11, 7, 0)), false);
    const day = s({ quietHours: { enabled: true, start: '12:00', end: '13:00' } });
    assert.equal(inQuietHours(day, new Date(2026, 9, 11, 12, 30)), true);
    assert.equal(inQuietHours(day, new Date(2026, 9, 11, 13, 30)), false);
    assert.equal(inQuietHours(s(), new Date(2026, 9, 11, 23, 0)), false, 'off by default');
  });
  test('decide: master, category off, mute, quiet hours, only-when-away, tests', () => {
    const at = { date: new Date(2026, 9, 11, 23, 0), now: Date.parse('2026-10-11T12:00:00Z') };
    assert.equal(decide(alert, s(), at).desktop, true);
    assert.equal(decide(alert, s({ master: false }), at).show, false);
    assert.equal(decide(alert, s({ categories: { finished: { enabled: false } } }), at).show, false);
    assert.match(decide(alert, s({ mutes: [{ id: 'm', scope: 'host', target: 'devbox' }] }), at).reason, /muted/);
    const quiet = decide(alert, s({ quietHours: { enabled: true, start: '22:00', end: '07:00' } }), at);
    assert.deepEqual([quiet.show, quiet.desktop, quiet.sound, quiet.reason], [true, false, 'none', 'quiet hours']);
    const allowed = decide({ ...alert, category: 'needs-you' }, s({ quietHours: { enabled: true, start: '22:00', end: '07:00', allow: ['needs-you'] } }), at);
    assert.equal(allowed.sound, DEFAULT_SETTINGS.categories['needs-you'].sound);
    const here = decide(alert, s({ away: { onlyWhenAway: true } }), { ...at, away: false });
    assert.equal(here.desktop, false);
    assert.equal(decide(alert, s({ away: { onlyWhenAway: true } }), { ...at, away: true }).desktop, true);
    const t = decide({ ...alert, test: true }, s({ master: false, categories: { finished: { sound: 'bell' } } }), at);
    assert.deepEqual([t.show, t.sound], [true, 'bell'], 'a test plays what the category is set to even with alerts off');
  });
  test('coalesce: 20 finishes are one notification; mixed bursts group by category in priority order', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ category: 'finished', name: `s${i}` }));
    const g = coalesce(many);
    assert.equal(g.length, 1);
    assert.equal(g[0].title, '20 sessions finished');
    assert.match(g[0].body, /^s0, s1, s2, s3 and 16 more$/);
    const mixed = coalesce([{ category: 'finished', name: 'a' }, { category: 'needs-you', name: 'b', title: 'b needs you' }, { category: 'finished', name: 'c' }]);
    assert.deepEqual(mixed.map((x) => x.category), ['needs-you', 'finished']);
    assert.equal(mixed[0].single, true);
    assert.equal(mixed[0].title, 'b needs you');
    const wide = coalesce(['needs-you', 'error', 'held', 'mr', 'finished'].map((c) => ({ category: c, name: c })));
    assert.equal(wide.length, 1);
    assert.equal(wide[0].title, '5 agent alerts');
    assert.match(speechFor(g[0]), /20 sessions finished/);
  });
  test('rate limit is a sliding minute', () => {
    let h = [];
    for (let i = 0; i < 3; i++) h = rateLimit(h, { now: 1000 + i, maxPerMinute: 3 }).history;
    assert.equal(rateLimit(h, { now: 2000, maxPerMinute: 3 }).allowed, false);
    assert.equal(rateLimit(h, { now: 62_000, maxPerMinute: 3 }).allowed, true);
  });
});

// ---------------------------------------------------------------- screens
const DIALOG = [
  '⏺ Bash(rm -rf build)',
  '────────────────────────────────',
  ' Bash command',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. Yes, and don\'t ask again',
  '   3. No, and tell Claude',
  'Esc to cancel',
].join('\n');
const HELD = ['Held message from another session', 'Another Claude session sent a message: from webapp-06 [verified pid 4242]', 'Message body (this is what will be delivered):', 'please rebase', '❯ 1. Deliver this message to Claude', '  2. Drop it', 'Esc to cancel'].join('\n');

describe('screens', () => {
  test('dialogSummary reads the question and the numbered options', () => {
    assert.equal(classifyScreen(DIALOG).state, 'dialog');
    const d = dialogSummary(DIALOG);
    assert.equal(d.question, 'Do you want to proceed?');
    assert.deepEqual(d.options.map((o) => o.n), [1, 2, 3]);
    assert.equal(d.options[0].selected, true);
  });
  test('heldMessage finds the peer dialog and its sender', () => {
    assert.deepEqual(heldMessage(HELD), { from: 'webapp-06' });
    assert.equal(heldMessage(DIALOG), null);
  });
  test('screenHash changes when the bottom of the screen changes and ignores trailing blanks', () => {
    assert.equal(screenHash(DIALOG), screenHash(DIALOG + '\n\n   \n'));
    assert.notEqual(screenHash(DIALOG), screenHash(DIALOG.replace('rm -rf build', 'ls')));
  });
});

// ---------------------------------------------------------------- detector
const sess = (id, status, extra = {}) => ({ id, sessionId: id, engine: 'claude', name: `n-${id}`, status, live: status !== 'dead', tmux: `agents:@${id.length}.%1`, cwd: '/tmp', ...extra });
const win = (target, state, extra = {}) => ({ target, name: 'w', screen: { state }, agent: { engine: 'claude', sessionId: extra.sid ?? null, name: extra.agentName ?? null }, tail: ['last line'], ...extra });
const snap = (sessions, windows = [], ok = true) => snapshotOf({ ok, sessions, windows });

describe('detector: diffSnapshots', () => {
  test('first look is only a baseline', () => {
    assert.deepEqual(diffSnapshots(undefined, snap([sess('a', 'busy')]), { host: 'mac' }), []);
  });
  test('busy -> idle is finished; idle -> idle and idle -> busy are nothing', () => {
    const a = diffSnapshots(snap([sess('a', 'busy'), sess('b', 'idle'), sess('c', 'idle')]), snap([sess('a', 'idle', { statusUpdatedAt: 5 }), sess('b', 'idle'), sess('c', 'busy')]), { host: 'mac' });
    assert.equal(a.length, 1);
    assert.equal(a[0].category, 'finished');
    assert.equal(a[0].sessionId, 'a');
    assert.equal(a[0].name, 'n-a');
    assert.equal(a[0].target, 'agents:@1');
    assert.equal(a[0].key, 'mac|a|finished|5');
  });
  test('a turn shorter than the poll still counts: statusUpdatedAt moved while idle on both looks', () => {
    const a = diffSnapshots(snap([sess('a', 'idle', { statusUpdatedAt: 100 })]), snap([sess('a', 'idle', { statusUpdatedAt: 200 })]), { host: 'mac' });
    assert.deepEqual(a.map((x) => x.category), ['finished']);
    assert.deepEqual(diffSnapshots(snap([sess('a', 'idle', { statusUpdatedAt: 200 })]), snap([sess('a', 'idle', { statusUpdatedAt: 200 })]), { host: 'mac' }), []);
  });
  test('a dialog appearing is needs-you with the question; it suppresses the same session finishing', () => {
    const prev = snap([sess('a', 'busy')], [win('agents:@1', 'busy', { sid: 'a' })]);
    const next = snap([sess('a', 'idle')], [win('agents:@1', 'dialog', { sid: 'a', dialog: { question: 'Do you want to proceed?', options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }] }, hash: 'h1' })]);
    const a = diffSnapshots(prev, next, { host: 'mac' });
    assert.equal(a.length, 1);
    assert.equal(a[0].category, 'needs-you');
    assert.equal(a[0].kind, 'dialog');
    assert.equal(a[0].body, 'Do you want to proceed? 1. Yes / 2. No');
    assert.equal(a[0].meta.hash, 'h1');
    assert.deepEqual(diffSnapshots(next, next, { host: 'mac' }), [], 'a dialog that stays up is not news');
  });
  test('held peer message is its own category', () => {
    const a = diffSnapshots(snap([sess('a', 'idle')], [win('h:@1', 'idle', { sid: 'a' })]), snap([sess('a', 'idle')], [win('h:@1', 'dialog', { sid: 'a', held: true, heldFrom: 'webapp-06' })]), { host: 'mac' });
    assert.deepEqual(a.map((x) => [x.category, x.body]), [['held', 'from webapp-06; deliver or drop it']]);
  });
  test('a live session that dies is an error; headless exit codes matter', () => {
    const a = diffSnapshots(snap([sess('a', 'idle'), sess('h', 'busy', { kind: 'headless' })]), snap([sess('a', 'dead'), sess('h', 'exited', { kind: 'headless', exitCode: 3 })]), { host: 'mac' });
    assert.deepEqual(a.map((x) => [x.category, x.kind, x.sessionId]), [['error', 'died', 'a'], ['error', 'exit', 'h']]);
    const ok = diffSnapshots(snap([sess('h', 'busy')]), snap([sess('h', 'exited', { exitCode: 0 })]), { host: 'mac' });
    assert.deepEqual(ok, [], 'a clean exit is not an error');
  });
  test('a status that asks for input is needs-you', () => {
    const a = diffSnapshots(snap([sess('a', 'busy')]), snap([sess('a', 'waiting')]), { host: 'mac' });
    assert.deepEqual(a.map((x) => [x.category, x.kind]), [['needs-you', 'status']]);
  });
  test('windowOf keeps session:@id for registry pane targets', () => {
    assert.equal(windowOf('agents:@68.%120'), 'agents:@68');
    assert.equal(windowOf('yo:3'), 'yo:3');
  });
});

describe('detector: diffMRs', () => {
  const mr = (n, over = {}) => ({ number: n, author: 'me', title: `MR ${n}`, eventCount: 1, mergeStatus: 'mergeable', approvals: 0, state: 'open', lastEvent: { kind: 'created', actor: 'me' }, ...over });
  test('baseline, then comments, mergeable flips, approvals, opened, left open', () => {
    assert.deepEqual(diffMRs(null, [mr(1)]), []);
    const prev = new Map([[1, mr(1)], [2, mr(2)], [3, mr(3)], [9, mr(9)]]);
    const next = [mr(1, { eventCount: 2, lastEvent: { kind: 'commented', actor: 'bob' } }), mr(2, { mergeStatus: 'conflicts' }), mr(3, { approvals: 1 }), mr(4)];
    const a = diffMRs(prev, next, { mine: new Set(['me']) });
    const by = Object.fromEntries(a.map((x) => [x.number, x.title]));
    assert.equal(by[1], '!1 commented');
    assert.equal(by[2], '!2 now has conflicts');
    assert.equal(by[3], '!3 approved');
    assert.equal(by[4], '!4 opened');
    assert.equal(by[9], '!9 merged or closed');
  });
  test('my own pushes are not news; other authors are ignored when scope is mine', () => {
    const prev = new Map([[1, mr(1)], [5, mr(5, { author: 'tyler' })]]);
    const a = diffMRs(prev, [mr(1, { eventCount: 2, lastEvent: { kind: 'pushed', actor: 'me' } }), mr(5, { author: 'tyler', eventCount: 3, lastEvent: { kind: 'commented', actor: 'x' } })], { mine: new Set(['me']) });
    assert.deepEqual(a, []);
    const all = diffMRs(prev, [mr(5, { author: 'tyler', eventCount: 3, lastEvent: { kind: 'pipeline_failed', status: 'failed' } })], { mine: null });
    assert.ok(all.some((x) => x.number === 5 && x.kind === 'pipeline'));
  });
});

describe('classifyAsk', () => {
  test('decision: a dialog or a held peer message on screen, with its options', () => {
    const d = classifyAsk({ screenState: 'dialog', dialog: { question: 'Do you want to proceed?', options: [{ n: 1, label: 'Yes' }] }, text: 'whatever?' });
    assert.deepEqual([d.kind, d.label, d.text, d.options.length], ['decision', 'needs a decision', 'Do you want to proceed?', 1]);
    assert.equal(classifyAsk({ held: true, heldFrom: 'webapp-06' }).kind, 'decision');
  });
  test('question: an unanswered AskUserQuestion, or a reply ending with a question mark', () => {
    const p = classifyAsk({ text: 'Done.', pendingAsk: { question: 'Which branch?', options: [{ n: 1, label: 'dev' }, { n: 2, label: 'main' }] } });
    assert.deepEqual([p.kind, p.text, p.options.map((o) => o.label)], ['question', 'Which branch?', ['dev', 'main']]);
    assert.equal(classifyAsk({ text: 'Plan below.\n\n**Should I go ahead?**' }).kind, 'question');
    assert.equal(classifyAsk({ text: 'Ready to merge (want me to?)' }).kind, 'question');
    assert.equal(endsWithQuestion('What does this do?\n```js\nx()\n```\nIt runs x.'), false, 'a question mid-reply that is then answered is not pending');
  });
  test('finished: anything else, with an excerpt from the end of the reply', () => {
    const long = 'Lots of setup text. '.repeat(30) + 'All 197 tests pass and the branch is pushed.';
    const f = classifyAsk({ text: long });
    assert.equal(f.kind, 'finished');
    assert.equal(f.label, 'finished, no question pending');
    assert.ok(f.text.length <= 201, f.text.length);
    assert.match(f.text, /^…/);
    assert.match(f.text, /branch is pushed\.$/);
    assert.equal(excerpt('use `x` in **bold**'), 'use x in bold');
    assert.deepEqual(classifyAsk({}), { kind: 'finished', label: 'finished, no question pending', text: '', options: [] });
  });
  test('askFromLines finds the last reply and a still-pending AskUserQuestion; an answer clears it', () => {
    const L = (o) => JSON.stringify(o);
    const ask = { type: 'assistant', timestamp: 't2', message: { content: [{ type: 'text', text: 'One question first.' }, { type: 'tool_use', id: 'tu1', name: 'AskUserQuestion', input: { questions: [{ question: 'Ship to dev?', options: [{ label: 'Yes' }, { label: 'No' }] }] } }] } };
    const lines = [L({ type: 'user', message: { content: 'go' } }), L({ type: 'assistant', timestamp: 't1', message: { content: [{ type: 'text', text: 'Working.' }] } }), L(ask)];
    const r = askFromLines(lines);
    assert.equal(r.text, 'One question first.');
    assert.deepEqual(r.pendingAsk, { question: 'Ship to dev?', options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }] });
    assert.equal(askFromLines([...lines, L({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'Yes' }] } })]).pendingAsk, null);
    assert.equal(askFromLines([...lines, L({ type: 'user', message: { content: 'yes ship it' } })]).pendingAsk, null);
  });
});

describe('alertFromEvent', () => {
  test('hook notifications: permission prompts are needs-you; the bare idle reminder is finished, never a question', () => {
    const a = alertFromEvent({ id: 'e1', ts: 't', type: 'notify', sessionId: 'abc', hostname: 'mac', message: 'Claude needs your permission to use Bash', kind: 'permission_prompt' }, { names: new Map([['abc', 'webapp-f8']]) });
    assert.deepEqual([a.category, a.title, a.source], ['needs-you', 'webapp-f8 needs you', 'hook']);
    const idle = alertFromEvent({ id: 'e2', type: 'notify', sessionId: 'abc', message: 'Claude is waiting for your input', kind: 'idle_prompt' });
    assert.deepEqual([idle.category, idle.title, idle.body], ['finished', 'abc finished', 'finished, no question pending']);
    const q = alertFromEvent({ id: 'e4', type: 'notify', sessionId: 'abc', sessionName: 'webapp-f8', category: 'needs-you', message: 'Claude is waiting for your input', kind: 'idle_prompt', ask: { kind: 'question', label: 'asked you a question', text: 'Should I push to origin/dev or open an MR?' } });
    assert.deepEqual([q.category, q.title, q.body], ['needs-you', 'webapp-f8 asked you a question', 'Should I push to origin/dev or open an MR?']);
    assert.equal(alertFromEvent({ id: 'e3', type: 'notify', source: 'detector', message: 'x' }), null, 'detector events are emitted directly, not twice');
  });
  test('manager chat and manager writes are manager alerts; launches are launch alerts', () => {
    assert.equal(alertFromEvent({ id: 'c', type: 'chat', from: 'manager', text: 'two sessions wait' }).category, 'manager');
    assert.equal(alertFromEvent({ id: 'n', type: 'note', actor: 'manager', about: 'x', text: 'hi' }).category, 'manager');
    const mac = alertFromEvent({ id: 'm', type: 'note', actor: 'manager-mac', host: 'WORK-MAC', text: 'a session waits' });
    assert.deepEqual([mac.category, mac.name, mac.title], ['manager', 'manager-mac', 'manager-mac wrote a note'], 'every manager actor alerts the same way');
    assert.equal(alertFromEvent({ id: 'x', type: 'note', actor: 'managerial', text: 'not a manager' }), null);
    const l = alertFromEvent({ id: 'l', type: 'launch', engine: 'claude', mode: 'tmux', actor: 'mcp', result: { tmux: 'agents:12' }, prompt: 'go' });
    assert.equal(l.category, 'launch');
    assert.equal(l.title, 'Launched claude in agents:12 (by mcp)');
    assert.equal(alertFromEvent({ id: 'x', type: 'feature', fid: 'f' }), null);
  });
});

// ---------------------------------------------------------------- Notifier
describe('Notifier', () => {
  let appended; let settings;
  beforeEach(() => {
    appended = []; settings = mergeSettings(DEFAULT_SETTINGS, {});
    let n = 0;
    Object.assign(notifyDeps, {
      appendEvent: async (ev, opts) => { const stored = { id: `ev-${++n}`, ts: new Date(1_800_000_000_000 + n).toISOString(), actor: opts?.actor, ...ev }; appended.push(stored); return stored; },
      settings: async () => settings,
      host: () => 'mac',
      now: () => 1_800_000_000_000,
    });
  });
  test('a turn that ends on a dialog: the alert carries the screen hash so a notification answers that dialog only', async () => {
    const nf = new Notifier();
    await nf.observe('mac', { ok: true, sessions: [sess('a', 'busy')], windows: [] });
    const out = await nf.observe('mac', { ok: true, sessions: [sess('a', 'idle', { statusUpdatedAt: 9 })], windows: [] }, { lastReply: async () => ({ text: null, ask: { kind: 'decision', label: 'needs a decision', text: 'Do you want to proceed?', options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }], hash: 'feedbeef00112233' } }) });
    assert.equal(out.length, 1);
    assert.deepEqual([out[0].category, out[0].kind, out[0].meta.hash], ['needs-you', 'decision', 'feedbeef00112233']);
    assert.deepEqual(out[0].meta.options.map((o) => o.n), [1, 2]);
  });
  test('the manager going busy to ready raises no finished alert (its reply raises its own)', async () => {
    const nf = new Notifier();
    await nf.observe('mac', { ok: true, sessions: [{ id: 'manager', engine: 'openclaw', live: true, status: 'busy' }], windows: [] });
    const out = await nf.observe('mac', { ok: true, sessions: [{ id: 'manager', engine: 'openclaw', live: true, status: 'ready', statusUpdatedAt: 9 }], windows: [] });
    assert.deepEqual(out, []);
  });
  test('a hook alert keeps the screen hash its event was enriched with', () => {
    const a = alertFromEvent({ id: 'h1', ts: '2026-10-20T18:00:00Z', type: 'notify', source: 'hook', host: 'mac', sessionId: 's1', sessionName: 'demo-build', kind: 'permission_prompt', ask: { kind: 'decision', label: 'needs a decision', text: 'Do you want to proceed?', options: [{ n: 1, label: 'Yes' }] }, meta: { hash: 'abc', options: [{ n: 1, label: 'Yes' }] } });
    assert.equal(a.meta.hash, 'abc');
    assert.equal(alertFromEvent({ id: 'h2', ts: '2026-10-20T18:00:00Z', type: 'notify', source: 'hook', host: 'mac', sessionId: 's1', kind: 'idle_prompt' }).meta, undefined);
  });
  test('observe: transitions become stored alerts with WAL ids, the last line filled in, fanned out once', async () => {
    const nf = new Notifier();
    const fanned = [];
    nf.on((items) => fanned.push(...items));
    await nf.observe('mac', { ok: true, sessions: [sess('a', 'busy')], windows: [] });
    const out = await nf.observe('mac', { ok: true, sessions: [sess('a', 'idle', { statusUpdatedAt: 9 })], windows: [] }, { lastReply: async () => ({ text: 'All done.\nPushed 3 commits.', line: 'Pushed 3 commits.' }) });
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'ev-1');
    assert.equal(out[0].body, 'All done. Pushed 3 commits.');
    assert.equal(out[0].ask.kind, 'finished');
    assert.equal(appended[0].type, 'notify');
    assert.equal(appended[0].category, 'finished');
    assert.equal(appended[0].message, 'All done. Pushed 3 commits.');
    assert.equal(appended[0].ask.label, 'finished, no question pending');
    assert.equal(appended[0].source, 'detector');
    assert.equal(fanned.length, 1);
    // The same transition seen again (a second observer pass) is not a second alert.
    await nf.observe('mac', { ok: true, sessions: [sess('a', 'busy')], windows: [] });
    const again = await nf.observe('mac', { ok: true, sessions: [sess('a', 'idle', { statusUpdatedAt: 9 })], windows: [] });
    assert.equal(again.length, 0);
    assert.deepEqual(nf.recent().map((a) => a.id), ['ev-1']);
  });
  test('a session that stops on a question is needs-you "asked you a question", with that question as the body', async () => {
    const nf = new Notifier();
    await nf.observe('mac', { ok: true, sessions: [sess('q', 'busy')] });
    const [a] = await nf.observe('mac', { ok: true, sessions: [sess('q', 'idle')] }, { lastReply: async () => ({ text: 'I found two configs.\n\nWhich one should I keep, the Bedrock one or the Mantle one?' }) });
    assert.deepEqual([a.category, a.kind, a.title], ['needs-you', 'question', 'n-q asked you a question']);
    assert.match(a.body, /Which one should I keep/);
    assert.equal(appended.at(-1).ask.kind, 'question');
  });
  test('muted alerts are still recorded, marked muted', async () => {
    settings = mergeSettings(DEFAULT_SETTINGS, { mutes: [{ id: 'm', scope: 'session', target: 'n-a' }] });
    const nf = new Notifier();
    await nf.observe('mac', { ok: true, sessions: [sess('a', 'busy')] });
    const [a] = await nf.observe('mac', { ok: true, sessions: [sess('a', 'idle')] });
    assert.equal(a.muted, 'session n-a');
    assert.equal(appended[0].muted, 'session n-a');
  });
  test('a host that misses three times is one host-down error', async () => {
    const nf = new Notifier();
    await nf.observe('devbox', { ok: true, sessions: [] });
    assert.deepEqual(await nf.observe('devbox', { ok: false, error: 'ssh: timeout' }), []);
    assert.deepEqual(await nf.observe('devbox', { ok: false, error: 'ssh: timeout' }), []);
    const [a] = await nf.observe('devbox', { ok: false, error: 'ssh: timeout' });
    assert.deepEqual([a.category, a.kind, a.title], ['error', 'host-down', 'devbox stopped answering']);
    assert.deepEqual(await nf.observe('devbox', { ok: false }), []);
  });
  test('hook idle reminders right after a finish are dropped; remote pulls dedupe by id and can be silent', async () => {
    const nf = new Notifier();
    await nf.observe('mac', { ok: true, sessions: [sess('a', 'busy')] });
    const [fin] = await nf.observe('mac', { ok: true, sessions: [sess('a', 'idle')] });
    fin.ts = new Date(notifyDeps.now()).toISOString();
    assert.deepEqual(await nf.ingestEvent({ id: 'h1', ts: 't', type: 'notify', sessionId: 'a', message: 'waiting', kind: 'idle_prompt' }), []);
    assert.equal((await nf.ingestEvent({ id: 'h2', ts: 't', type: 'notify', sessionId: 'a', message: 'permission', kind: 'permission_prompt' })).length, 1);
    const fanned = [];
    nf.on((items) => fanned.push(...items));
    assert.deepEqual(nf.ingestRemote([{ id: 'r1', category: 'finished', ts: 't' }], { silent: true }), []);
    assert.equal(nf.ingestRemote([{ id: 'r1', category: 'finished' }, { id: 'r2', category: 'error' }]).length, 1);
    assert.deepEqual(fanned.map((x) => x.id), ['r2']);
  });
  test('one dialog arriving as hook, screen and status is at most two alerts (the dialog may upgrade the hook)', async () => {
    const nf = new Notifier();
    assert.equal((await nf.ingestEvent({ id: 'hk', ts: new Date(notifyDeps.now()).toISOString(), type: 'notify', sessionId: 'a', message: 'Claude needs your permission', kind: 'permission_prompt' })).length, 1);
    nf.ring.at(-1).ts = new Date(notifyDeps.now()).toISOString();
    await nf.observe('mac', { ok: true, sessions: [sess('a', 'busy')], windows: [win('h:@1', 'busy', { sid: 'a' })] });
    const d = await nf.observe('mac', { ok: true, sessions: [sess('a', 'busy')], windows: [win('h:@1', 'dialog', { sid: 'a', hash: 'x' })] });
    assert.deepEqual(d.map((x) => x.kind), ['dialog']);
    const st = await nf.observe('mac', { ok: true, sessions: [sess('a', 'waiting')], windows: [win('h:@1', 'dialog', { sid: 'a', hash: 'x' })] });
    assert.deepEqual(st, [], 'the status flip is the same ask');
  });
  test('MR alerts carry the url and number', async () => {
    const nf = new Notifier();
    await nf.observeMRs([{ number: 7, author: 'me', eventCount: 1, mergeStatus: 'conflicts', approvals: 0, state: 'open', title: 'T', url: 'u' }], { mine: new Set(['me']) });
    const [a] = await nf.observeMRs([{ number: 7, author: 'me', eventCount: 1, mergeStatus: 'mergeable', approvals: 0, state: 'open', title: 'T', url: 'u' }], { mine: new Set(['me']) });
    assert.deepEqual([a.category, a.title, a.meta.url], ['mr', '!7 now mergeable', 'u']);
    assert.equal(appended.at(-1).mr, 7);
  });
});

let opsSeq = 0; // ids stay unique across tests, like real WAL ids
describe('notify ops', () => {
  beforeEach(() => {
    Object.assign(notifyDeps, {
      appendEvent: async (ev, opts) => ({ id: `t-${++opsSeq}`, ts: new Date().toISOString(), actor: opts?.actor, ...ev }),
      settings: async () => mergeSettings(DEFAULT_SETTINGS, {}),
      host: () => 'mac', now: () => Date.now(),
    });
  });
  test('notify.test fires one alert per call and reports the category decision', async () => {
    const r = await notifyOps['notify.test']({ category: 'mr' });
    assert.equal(r.alert.category, 'mr');
    assert.equal(r.alert.test, true);
    assert.equal(r.decision.sound, DEFAULT_SETTINGS.categories.mr.sound);
    await assert.rejects(() => notifyOps['notify.test']({ category: 'lunch' }), /category must be one of/);
  });
  test('notify.send validates, and drops an identical repeat inside 30 s', async () => {
    const a = await notifyOps['notify.send']({ title: 'blocked on a decision', body: 'pick A or B', actor: 'mcp:webapp-f8' });
    assert.equal(a.ok, true);
    const b = await notifyOps['notify.send']({ title: 'blocked on a decision', actor: 'mcp:webapp-f8' });
    assert.equal(b.deduped, true);
    await assert.rejects(() => notifyOps['notify.send']({ title: '' }), /title must be/);
  });
  test('notify.recent in a daemon serves the ring', async () => {
    notifier.daemon = true;
    try { const r = await notifyOps['notify.recent']({ limit: 5 }); assert.equal(r.detector.running, true); assert.ok(r.items.length >= 1); }
    finally { notifier.daemon = false; }
  });
  test('notify.recent outside a daemon reads the ring file and reports no detector when absent', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'drover-ring-'));
    const old = { ringFile: notifyDeps.ringFile, daemonFile: notifyDeps.daemonFile };
    notifyDeps.ringFile = () => path.join(dir, 'ring.json'); notifyDeps.daemonFile = () => path.join(dir, 'daemon.json');
    try { const r = await notifyOps['notify.recent']({}); assert.deepEqual(r.items, []); assert.equal(r.detector.running, false); }
    finally { Object.assign(notifyDeps, old); }
  });
});
