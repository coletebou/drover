// The TUI tables that act: Settings edits through settings.set (Enter, Space for a yes/no, u unmutes), and the
// GitHub PRs table reads prs.list with its scope and state and opens a PR's detail with prs.get.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TABLES, patchFor, parseEdit, editText } from '../tui/views/tables.js';
import { TableView } from '../tui/views/table.js';
import { Prompt } from '../tui/views/overlays.js';
import { MAIN } from '../tui/app.js';

const settle = () => new Promise((r) => setTimeout(r, 5));
function app(answers = {}) {
  const a = { calls: [], toasts: [], modal: null, host: 'local', board: { hosts: [] }, toast(t, st) { a.toasts.push([t, st]); }, invalidate() {}, closeModal() { a.modal = null; }, hostLabel: (x) => x,
    client: { call: async (op, args) => { a.calls.push([op, args]); const r = answers[op]; if (r instanceof Error) throw r; return typeof r === 'function' ? r(args) : r; } } };
  return a;
}
const SETTINGS = { settings: { version: 3, categories: { finished: { sound: 'ping', volume: 0.4, speak: false } }, quietHours: { enabled: true, start: '22:00' } }, defaults: { categories: { finished: { sound: 'none', volume: 0.8, speak: false } } }, activeMutes: [{ id: 'm1', scope: 'host', target: 'devbox', until: null }], updated: null };

test('a dotted setting becomes the partial patch settings.set merges; edits parse by the type they replace', () => {
  assert.deepEqual(patchFor('categories.finished.sound', 'chime'), { categories: { finished: { sound: 'chime' } } });
  assert.deepEqual(patchFor('master', false), { master: false });
  assert.equal(editText('ping'), 'ping'); assert.equal(editText(0.4), '0.4'); assert.equal(editText(['a']), '["a"]');
  assert.equal(parseEdit(' chime ', 'ping'), 'chime', 'a string setting takes the text as it is');
  assert.equal(parseEdit('"with \\"quotes\\""', 'x'), 'with "quotes"', 'or a JSON string');
  assert.equal(parseEdit('0.25', 0.4), 0.25);
  assert.equal(parseEdit('false', true), false);
  assert.deepEqual(parseEdit('["a","b"]', []), ['a', 'b']);
  assert.throws(() => parseEdit('loud', 0.4), /not a number/);
  assert.throws(() => parseEdit('yes', true), /true or false/);
});

test('settings: Enter edits in a prompt and saves through settings.set; Space flips a yes/no; u unmutes; version stays', async () => {
  const def = TABLES.find((t) => t.id === 'settings');
  const a = app({ 'settings.get': SETTINGS, 'settings.set': { ok: true }, 'notify.unmute': { ok: true } });
  const v = new TableView(a, def);
  await v.load();
  const row = (k) => v.visible().findIndex((r) => r.key === k);
  v.sel = row('categories.finished.volume'); v.key({ id: 'enter', name: 'enter' });
  assert.ok(a.modal instanceof Prompt); assert.equal(a.modal.input.value, '0.4');
  a.modal.input.set('0.9'); a.modal.key({ id: 'enter', name: 'enter' });
  await settle();
  assert.deepEqual(a.calls.find(([op]) => op === 'settings.set')[1], { patch: { categories: { finished: { volume: 0.9 } } }, reason: 'drover tui' });
  v.sel = row('categories.finished.speak'); v.key({ id: ' ', ch: ' ', name: ' ' });
  await settle();
  assert.deepEqual(a.calls.filter(([op]) => op === 'settings.set').at(-1)[1].patch, { categories: { finished: { speak: true } } }, 'Space flips it');
  v.sel = row('categories.finished.volume'); v.key({ id: 'enter', name: 'enter' }); a.modal.input.set('loud'); a.modal.key({ id: 'enter', name: 'enter' });
  await settle();
  assert.equal(a.calls.filter(([op]) => op === 'settings.set').length, 2, 'a value that does not parse is not sent');
  assert.match(a.toasts.at(-1)[0], /not a number/);
  v.sel = row('version'); v.key({ id: 'enter', name: 'enter' });
  assert.equal(a.modal, null); assert.match(a.toasts.at(-1)[0], /read-only/);
  v.sel = v.visible().findIndex((r) => r.mute); v.key({ id: 'u', ch: 'u', name: 'u' });
  await settle();
  assert.deepEqual(a.calls.find(([op]) => op === 'notify.unmute')[1], { id: 'm1' });
  assert.ok(def.detail(v.visible()[row('categories.finished.volume')], 80, v).some((r) => r.map(([t]) => t).join('').includes('default 0.8')), 'the detail shows the default when it differs');
});

test('settings: when the daemon keeps another value than the one typed (a clamp), the toast says so', async () => {
  const def = TABLES.find((t) => t.id === 'settings');
  const a = app({ 'settings.get': SETTINGS, 'settings.set': { settings: { ...SETTINGS.settings, categories: { finished: { ...SETTINGS.settings.categories.finished, volume: 1 } } } } });
  const v = new TableView(a, def);
  await v.load();
  v.sel = v.visible().findIndex((r) => r.key === 'categories.finished.volume'); v.key({ id: 'enter', name: 'enter' });
  a.modal.input.set('7'); a.modal.key({ id: 'enter', name: 'enter' });
  await settle();
  assert.deepEqual(a.toasts.at(-1), ['categories.finished.volume = 1 (the daemon kept that, not 7)', 'wait']);
});

test('settings: a value the daemon refuses says why and changes nothing here', async () => {
  const def = TABLES.find((t) => t.id === 'settings');
  const a = app({ 'settings.get': SETTINGS, 'settings.set': new Error('categories.finished.volume must be between 0 and 1') });
  const v = new TableView(a, def);
  await v.load();
  v.sel = v.visible().findIndex((r) => r.key === 'categories.finished.volume'); v.key({ id: 'enter', name: 'enter' });
  a.modal.input.set('7'); a.modal.key({ id: 'enter', name: 'enter' });
  await settle();
  assert.match(a.toasts.at(-1)[0], /not saved: .*between 0 and 1/);
});

test('PRs: a view after Tmux; it reads prs.list with its scope and state, which s and t cycle; the detail reads prs.get', async () => {
  assert.equal(MAIN[MAIN.indexOf('tmux') + 1], 'prs');
  const def = TABLES.find((t) => t.id === 'prs');
  const item = { id: 'o/a#3', repo: 'o/a', number: 3, title: 'Fix it', state: 'open', draft: false, roles: ['reviewer'], url: 'https://github.com/o/a/pull/3', updated: '2026-11-10T00:00:00Z', labels: [] };
  const a = app({ 'prs.list': { items: [item] }, 'prs.get': { head: 'fix', base: 'master', mergeable: 'mergeable', reviewDecision: 'review_required', checks: { total: 2, pass: 1, fail: 1, pending: 0, skipped: 0, failing: ['lint'] }, size: { additions: 3, deletions: 1, files: 1 }, reviews: [], recentComments: [] } });
  const v = new TableView(a, def);
  await v.load();
  assert.deepEqual(a.calls[0], ['prs.list', { scope: 'both', state: 'open', limit: 200 }]);
  assert.deepEqual(def.columns.map((c) => { const x = c.get(item, v); return Array.isArray(x) ? x[0] : x; }), ['o/a#3', 'Fix it', 'review', 'open', x(def.columns[4].get(item, v))]);
  v.key({ id: 's', ch: 's', name: 's' }); v.key({ id: 't', ch: 't', name: 't' });
  await settle();
  assert.deepEqual(a.calls.filter(([op]) => op === 'prs.list').map(([, args]) => [args.scope, args.state]).at(-1), ['authored', 'merged']);
  def.detail(item, 80, v); await settle();
  const text = def.detail(item, 80, v).map((r) => r.map(([t]) => t).join('')).join('\n');
  assert.match(text, /fix → master/); assert.match(text, /1 passed, 1 failed \(lint\)/); assert.match(text, /review required/);
  def.keys.o({ ...item, url: null }, a); assert.match(a.toasts.at(-1)[0], /no link/);
});
const x = (v) => (Array.isArray(v) ? v[0] : v);
