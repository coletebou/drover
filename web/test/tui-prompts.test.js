// Prompts (workspace 3) against the fake daemon's prompt spool: the list is newest first with its columns; `/` words
// go to the daemon as q; `who` (never `via`) picks one of the six filters and `v` cycles through them; `m` marks the
// selected prompt mine or not mine (prompts.mark) and toasts exactly what happened; [ ] one host; j past the end
// reads the next page with before; Enter opens the session (its strip when the board has it); y copies with OSC 52
// (tmux-wrapped under tmux); l launches through launch.start; mutation and turn events refresh at most every 5 s
// while shown.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeDaemon } from '../tui/test-support/fake-daemon.js';
import { Client } from '../tui/client.js';
import { PromptsView, PROMPTS, FILTERS, PAGE, mergeById } from '../tui/views/prompts.js';
import { LaunchPrompt } from '../tui/views/overlays.js';
import { rowText } from '../tui/screen.js';

let daemon, client;
before(async () => { daemon = await startFakeDaemon(); client = new Client({ url: daemon.url, token: daemon.token }); });
after(async () => { client?.close(); await daemon?.close(); });

const key = (id) => ({ name: id, id, ch: id.length === 1 ? id : undefined, ctrl: false, alt: false, shift: false });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Wait until a view has no read out (a read starts synchronously when a key asks for one), however busy the box is.
let current = null;
const settle = async (ms = 0) => { if (ms) await sleep(ms); for (let i = 0; i < 500; i++) { await sleep(5); if (!current || !current.loading) return; } };
const lastArgs = () => daemon.callsOf('prompts.list').at(-1).args;

function app(extra = {}) {
  const a = {
    client, frontHost: 'fakehost', host: 'local', hosts: [{ name: 'local', display: 'fakehost' }, { name: 'box-a', display: 'box-a' }], env: {}, modal: null,
    board: { strips: [{ key: 'local|s-build', id: 's-build', sessionId: 's-build', name: 'demo-build', host: 'local', lane: 'wait', kind: 'session' }] },
    toasts: [], opened: [], sessions: [], copies: [], went: [], written: [],
    toast(t) { a.toasts.push(t); }, invalidate() {}, refreshBoardSoon() {}, hostLabel: (h) => (h === 'local' ? 'fakehost' : h),
    openStrip(s) { a.opened.push(s.key); }, openSession(t) { a.sessions.push(t); },
    copy(text) { a.copies.push(text); }, go(id) { a.went.push(id); },
    ...extra,
  };
  return a;
}

test('the list: prompts.list with who=mine, newest first, its columns, the verbatim text in the detail', async () => {
  const a = app(); const v = new PromptsView(a); current = v;
  v.show(); await settle();
  assert.deepEqual(lastArgs(), { who: 'mine', limit: PAGE });
  assert.ok(v.rowsAll.every((r) => r.mine === true), 'peer, agent and program turns are not Mine');
  assert.ok(v.rowsAll.every((r, i, l) => !i || Date.parse(l[i - 1].ts) >= Date.parse(r.ts)), 'newest first');
  const rows = v.render(170, 40).map(rowText);
  assert.match(rows[2], /when\s+host\s+engine\s+project\s+via\s+text/);
  assert.match(rows[3], /1m fakehost\s+claude\s+demo\s+typed\s+Make the demo parser keep line numbers/);
  const detail = rows.join('\n');
  assert.match(detail, /Keep the old API:/, 'the text with its line breaks');
  assert.match(detail, / {4}parse\(text\) still returns the tree\./, 'and its indentation');
  assert.match(detail, /session\s+s-build/); assert.match(detail, /cwd\s+~\/code\/demo/); assert.match(detail, /label\s+default/);
  assert.match(detail, /mine\s+yes/); assert.match(detail, /mark not mine/, 'the footer offers m');
  v.hide();
});

test('/ words go to the daemon (q), after a pause and on Enter; Esc clears them', async () => {
  const a = app(); const v = new PromptsView(a); current = v;
  v.show(); await settle();
  v.key(key('/'));
  for (const c of 'release') v.key(key(c));
  assert.ok(v.visible().every((r) => /release/.test(r.text)), 'what is loaded filters at once');
  await settle(500);
  assert.equal(lastArgs().q, 'release', 'then the daemon is asked, so older prompts match too');
  v.key(key(' ')); for (const c of 'notes') v.key(key(c));
  v.key({ id: 'enter', name: 'enter' }); await settle();
  assert.equal(lastArgs().q, 'release notes');
  assert.ok(v.rowsAll.length && v.rowsAll.every((r) => r.text.includes('release notes')));
  assert.match(v.meta(), /matching "release notes"/);
  v.key({ id: 'escape', name: 'escape' }); await settle();
  assert.equal(lastArgs().q, undefined, 'Esc: every prompt again');
  v.hide();
});

test('v cycles Mine → Manager → Agents → Programs → Not mine → All → Mine; setMode still enters Mine or All directly; [ ] one host, then every host', async () => {
  const a = app(); const v = new PromptsView(a); current = v;
  v.show(); await settle();
  assert.equal(v.title, 'Prompts · Mine');
  v.key(key('v')); await settle();
  assert.equal(v.who, 'manager'); assert.equal(lastArgs().who, 'manager');
  assert.ok(v.rowsAll.length && v.rowsAll.every((r) => r.via === 'manager'));
  v.key(key('v')); await settle();
  assert.equal(v.who, 'agents'); assert.ok(v.rowsAll.length && v.rowsAll.every((r) => r.via === 'peer' || r.via === 'agent'));
  v.key(key('v')); await settle();
  assert.equal(v.who, 'programs'); assert.ok(v.rowsAll.length && v.rowsAll.every((r) => r.via === 'headless' || r.via === 'sdk'));
  v.key(key('v')); await settle();
  assert.equal(v.who, 'not-mine'); assert.ok(v.rowsAll.length && v.rowsAll.every((r) => r.mine === false));
  v.key(key('v')); await settle();
  assert.equal(v.who, 'all'); assert.equal(v.title, 'Prompts · All');
  assert.ok(v.rowsAll.some((r) => r.via === 'peer'), 'All has what agents sent each other');
  v.key(key(']')); await settle();
  assert.deepEqual(lastArgs().hosts, ['fakehost']);
  v.key(key(']')); await settle();
  assert.deepEqual(lastArgs().hosts, ['box-a']);
  assert.ok(v.rowsAll.every((r) => r.host === 'box-a'));
  v.key(key(']')); await settle();
  assert.equal(lastArgs().hosts, undefined, 'every host again');
  v.key(key('v')); await settle();
  assert.equal(v.who, 'mine', 'the cycle wraps back to Mine');
  v.setMode('all'); await settle();
  assert.equal(v.who, 'all', 'the All sub-tab still enters All directly, bypassing the cycle');
  v.hide();
});

test('m marks the selected prompt mine or not mine (prompts.mark), toasts exactly what happened, then refreshes', async () => {
  const a = app(); const v = new PromptsView(a); current = v;
  v.show(); await settle();
  const r0 = v.visible()[0];
  assert.equal(r0.mine, true);
  v.sel = 0; v.key(key('m')); await settle();
  assert.deepEqual(daemon.callsOf('prompts.mark').at(-1).args, { ids: [r0.id], mine: false });
  assert.equal(a.toasts.at(-1), 'marked not mine');
  v.setMode('all'); await settle();
  const marked = v.rowsAll.find((r) => r.id === r0.id);
  assert.equal(marked.mine, false, 'the mark took: no longer mine'); assert.equal(marked.marked, true, 'a person decided it');
  v.sel = v.visible().findIndex((x) => x.id === r0.id); v.key(key('m')); await settle();
  assert.deepEqual(daemon.callsOf('prompts.mark').at(-1).args, { ids: [r0.id], mine: true }, 'm toggles off the current effective value');
  assert.equal(a.toasts.at(-1), 'marked mine');
  v.hide();
});

test('the mark column: a person\'s mark always shows; an automatic not-mine only shows in All', () => {
  const col = PROMPTS.columns[0];
  assert.deepEqual(col.get({ marked: true, mine: true }, { who: 'mine' }), ['●', 'accent']);
  assert.deepEqual(col.get({ marked: true, mine: false }, { who: 'not-mine' }), ['●', 'accent']);
  assert.deepEqual(col.get({ marked: false, mine: false }, { who: 'all' }), ['○', 'dim']);
  assert.deepEqual(col.get({ marked: false, mine: false }, { who: 'not-mine' }), [''], 'the dim marker is only for All');
  assert.deepEqual(col.get({ marked: false, mine: true }, { who: 'all' }), ['']);
});

test('FILTERS is the six names, in cycling order', () => {
  assert.deepEqual(FILTERS, ['mine', 'manager', 'agents', 'programs', 'not-mine', 'all']);
});

test('paging: j past the last row reads the next page (before the last id); nothing more when a page came back short', async () => {
  const a = app(); const v = new PromptsView(a); current = v;
  v.setMode('all'); v.show(); await settle();
  assert.equal(v.rowsAll.length, PAGE); assert.equal(v.more, true);
  v.render(160, 40);
  v.key(key('G')); v.render(160, 40);
  v.key(key('j')); await settle();
  assert.equal(lastArgs().before, v.rowsAll[PAGE - 1].id);
  assert.equal(v.rowsAll.length, 230, 'the rest appended');
  assert.equal(new Set(v.rowsAll.map((r) => r.id)).size, 230, 'no prompt twice');
  assert.equal(v.more, false);
  const n = daemon.callsOf('prompts.list').length;
  v.key(key('G')); v.key(key('j')); await settle();
  assert.equal(daemon.callsOf('prompts.list').length, n, 'the last page was short: no more reads');
  v.hide();
});

test('Enter opens the session (its strip when the board has it, else by id on its host); y copies; l launches', async () => {
  const a = app(); const v = new PromptsView(a); current = v;
  v.show(); await settle();
  v.key({ id: 'enter', name: 'enter' });
  assert.deepEqual(a.opened, ['local|s-build'], 'the first prompt\'s session is on the board: its strip');
  const remote = v.visible().findIndex((r) => r.host === 'box-a');
  v.sel = remote; v.key({ id: 'enter', name: 'enter' });
  assert.deepEqual(a.sessions.at(-1), { kind: 'session', id: v.visible()[remote].session, host: 'box-a', engine: 'claude', name: 'demo' });
  v.sel = 0; v.key(key('y'));
  assert.deepEqual(a.copies, [v.visible()[0].text], 'the whole verbatim text');
  v.key(key('l'));
  assert.ok(a.modal instanceof LaunchPrompt);
  assert.equal(a.modal.input.value, v.visible()[0].text, 'the prompt to confirm or edit');
  assert.equal(a.modal.host, 'local'); assert.equal(a.modal.engine, 'claude');
  a.closeModal = () => { a.modal = null; };
  a.modal.key({ id: 'tab', name: 'tab' }); assert.equal(a.modal.host, 'box-a', 'Tab picks the host');
  a.modal.key({ id: 'C-e', name: 'e', ctrl: true }); assert.equal(a.modal.engine, 'codex', 'Ctrl-E the engine');
  a.modal.key({ id: 'enter', name: 'enter' });
  for (let i = 0; i < 400 && !/launched/.test(a.toasts.at(-1) ?? ''); i++) await sleep(10);
  assert.deepEqual(daemon.callsOf('launch.start').at(-1).args, { engine: 'codex', mode: 'tmux', prompt: v.visible()[0].text, cwd: '~/code/demo', host: 'box-a' });
  assert.match(a.toasts.at(-1), /launched codex on box-a in work:@7/);
  v.hide();
});

test('y copies through the terminal: OSC 52, wrapped for tmux when $TMUX is set', async () => {
  const { App } = await import('../tui/app.js');
  for (const [env, wrapped] of [[{ TERM: 'xterm' }, false], [{ TERM: 'xterm', TMUX: '/tmp/x,1,0' }, true]]) {
    const out = [];
    const term = { active: true, write: (s) => out.push(s), size: () => ({ cols: 100, rows: 30 }) };
    const a = new App({ client: { call: async () => ({}), stream: () => ({ close() {} }), close() {} }, term, env, stateDir: '/nonexistent-drover-test' });
    a.invalidate = () => {};
    a.copy('the prompt');
    clearTimeout(a.toastTimer);
    assert.equal(out[0].startsWith('\x1bPtmux;'), wrapped);
    assert.ok(out[0].includes(Buffer.from('the prompt').toString('base64')));
  }
});

test('live: a turn or mutation event reads the newest page again, at most every 5 s, only while shown, keeping the selection', async () => {
  const a = app(); const v = new PromptsView(a); current = v;
  v.show(); await settle();
  v.sel = 3; const picked = v.selected().id;
  const n = daemon.callsOf('prompts.list').length;
  v.lastLoad = Date.now() - 4990;    // the last read was almost 5 s ago
  v.onEvent('turn'); v.onEvent('mutation'); v.onEvent('turn');
  await settle(80);
  assert.equal(daemon.callsOf('prompts.list').length, n + 1, 'three events, one read');
  assert.equal(v.selected().id, picked, 'the same prompt stays selected');
  v.onEvent('turn'); await settle(80);
  assert.equal(daemon.callsOf('prompts.list').length, n + 1, 'not again within 5 s');
  v.hide(); clearTimeout(v.liveTimer); v.liveTimer = null;
  v.onEvent('turn'); await settle(20);
  assert.equal(v.liveTimer, null, 'hidden: no refresh scheduled');
  v.onEvent('board'); assert.equal(v.liveTimer, null, 'other events: none');
});

test('an older daemon without prompts.list says so', async () => {
  const a = app({ client: { call: async () => { const e = new Error('unknown op prompts.list'); e.unknownOp = true; throw e; } } });
  const v = new PromptsView(a); current = v;
  v.show(); await settle();
  assert.match(v.render(120, 30).map(rowText).join('\n'), /does not know prompts\.list/);
  v.hide();
});

test('mergeById: one record per id, newest first', () => {
  const r = (id, ts) => ({ id, ts });
  assert.deepEqual(mergeById([r('b', '2026-11-21T02:00:00Z'), r('a', '2026-11-21T01:00:00Z')], [r('a', '2026-11-21T01:00:00Z'), r('c', '2026-11-21T03:00:00Z')]).map((x) => x.id), ['c', 'b', 'a']);
});
