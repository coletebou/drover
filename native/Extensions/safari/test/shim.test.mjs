import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { renderShim } from '../build/lib/files.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const cfg = JSON.parse(fs.readFileSync(here('../safari.config.json'), 'utf8'));
const template = fs.readFileSync(here('../shim/safari-shim.js'), 'utf8');
const RENDERED = renderShim(template, cfg);

const TOKEN = 'test-token-123';
const BASE = 'http://demo-mac:8080';
const NATIVE_CONFIG = { ok: true, result: { baseURL: BASE, token: TOKEN } };

/**
 * Fresh vm context with a fake browser. `reply(msg)` scripts the native answers.
 * Returns the context plus recorders. The real fetch records its calls too.
 */
function setup({ reply, stored, browser: extra = {}, noFetch = false } = {}) {
  const sent = [];
  const logged = [];
  const store = { ...(stored ?? {}) };
  const sets = [];
  const permCalls = [];
  const fetchCalls = [];
  const browser = {
    runtime: {
      sendNativeMessage: async (app, msg) => {
        sent.push({ app, msg });
        const r = reply ? await reply(msg) : { ok: false, error: 'unknownType' };
        return r;
      },
      getURL: (p) => `safari-web-extension://demo/${p}`,
    },
    storage: {
      local: {
        get: async (keys) => {
          const ks = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(ks.filter((k) => k in store).map((k) => [k, structuredClone(store[k])]));
        },
        set: async (obj) => { sets.push(structuredClone(obj)); Object.assign(store, structuredClone(obj)); },
      },
    },
    permissions: {
      contains: async (p) => { permCalls.push(['contains', p]); return false; },
      request: async (p) => { permCalls.push(['request', p]); return false; },
    },
    ...extra,
  };
  const sandbox = {
    browser,
    console: new Proxy({}, { get: (_t, level) => (...a) => { logged.push([level, a]); } }),
    setTimeout, clearTimeout, URL, URLSearchParams, Response, Promise, JSON, DOMException,
  };
  if (!noFetch) sandbox.fetch = async (input, init) => { fetchCalls.push({ input, init }); return new Response('real', { status: 200 }); };
  const ctx = vm.createContext(sandbox);
  const load = () => vm.runInContext(RENDERED, ctx);
  load();
  return { ctx, browser, sent, logged, store, sets, permCalls, fetchCalls, load, run: (code) => vm.runInContext(code, ctx) };
}

const configOnly = (msg) => (msg.type === 'config' ? NATIVE_CONFIG : { ok: false, error: 'unknownType' });

test('chrome is aliased to browser; the shim is a script without import/export', () => {
  const t = setup();
  assert.equal(t.ctx.chrome, t.ctx.browser);
  assert.ok(!/^\s*(import|export)\s/m.test(template));
});

test('notifications.create parses host and session and sends the notify shape', async () => {
  const t = setup({ reply: (m) => (m.type === 'notify' ? { ok: true, result: { posted: true } } : { ok: false, error: 'x' }) });
  await t.ctx.__droverSafari.ready;
  const cbIds = [];
  const id = await t.ctx.chrome.notifications.create('drover|demo-mac|demo-build|item-1', { title: 'Needs input', message: 'Pick one', contextMessage: 'question' }, (i) => cbIds.push(i));
  assert.equal(id, 'drover|demo-mac|demo-build|item-1');
  assert.deepEqual(cbIds, [id]);
  const n = t.sent.find((s) => s.msg.type === 'notify');
  assert.equal(n.app, 'application.id');
  assert.deepEqual(JSON.parse(JSON.stringify(n.msg)), {
    v: 1, type: 'notify', id, title: 'Needs input', body: 'Pick one', sessionId: 'demo-build', host: 'demo-mac', kind: null,
  });
});

test('notification ids follow Chrome encodeNotificationId: parts are URI-decoded, other shapes carry no session', async () => {
  const t = setup({ reply: () => ({ ok: true, result: { posted: true } }) });
  await t.ctx.__droverSafari.ready;
  const n = t.ctx.chrome.notifications;
  await n.create(`drover|${encodeURIComponent('demo mac')}|${encodeURIComponent('demo|build')}|${encodeURIComponent('item 1')}`, { title: 't', message: 'm' });
  await n.create('drover|omnibox|1791000000000', { title: 't', message: 'm' });
  await n.create('drover|overflow', { title: 't', message: 'm' });
  await n.create('drover|local||item-2', { title: 't', message: 'm' });
  await n.create('drover|local|%E0%A4%A|item-3', { title: 't', message: 'm' });
  const got = t.sent.filter((s) => s.msg.type === 'notify').map((s) => [s.msg.host, s.msg.sessionId]);
  assert.deepEqual(JSON.parse(JSON.stringify(got)), [['demo mac', 'demo|build'], [null, null], [null, null], ['local', null], ['local', null]]);
});

test('notifications.create generates an id and tolerates non-Drover ids', async () => {
  const t = setup();
  const id1 = await t.ctx.chrome.notifications.create({ title: 'a', message: 'b' });
  const id2 = await t.ctx.chrome.notifications.create({ title: 'a', message: 'b' });
  assert.match(id1, /^drover-safari-\d+$/);
  assert.notEqual(id1, id2);
  const n = t.sent.filter((s) => s.msg.type === 'notify');
  assert.equal(n[0].msg.sessionId, null);
  assert.equal(n[0].msg.host, null);
  assert.equal(n[0].msg.kind, null);
});

test('notifications.clear, getAll, getPermissionLevel and inert events', async () => {
  const t = setup();
  assert.equal(await t.ctx.chrome.notifications.clear('drover|h|s'), true);
  assert.deepEqual(JSON.parse(JSON.stringify(t.sent.find((s) => s.msg.type === 'clearNotification').msg)), { v: 1, type: 'clearNotification', id: 'drover|h|s' });
  assert.deepEqual(JSON.parse(JSON.stringify(await t.ctx.chrome.notifications.getAll())), {});
  assert.equal(await t.ctx.chrome.notifications.getPermissionLevel(), 'granted');
  for (const ev of ['onClicked', 'onButtonClicked', 'onClosed', 'onPermissionLevelChanged', 'onShowSettings']) {
    const e = t.ctx.chrome.notifications[ev];
    const fn = () => {};
    e.addListener(fn);
    assert.equal(e.hasListener(fn), true);
    e.removeListener(fn);
    assert.equal(e.hasListener(fn), false);
  }
});

test('existing notifications API is not replaced', () => {
  const own = { create: () => 'mine' };
  const t = setup({ browser: { notifications: own } });
  assert.equal(t.ctx.chrome.notifications, own);
});

test('offscreen rejects, omnibox is inert, getContexts resolves empty, sidePanel is not stubbed', async () => {
  const t = setup();
  await assert.rejects(t.ctx.chrome.offscreen.createDocument({}), /offscreen is not available in Safari/);
  assert.equal(await t.ctx.chrome.offscreen.hasDocument(), false);
  await t.ctx.chrome.offscreen.closeDocument();
  assert.equal(typeof t.ctx.chrome.offscreen.Reason, 'object');
  t.ctx.chrome.omnibox.onInputEntered.addListener(() => {});
  t.ctx.chrome.omnibox.setDefaultSuggestion({ description: 'x' });
  assert.deepEqual(JSON.parse(JSON.stringify(await t.ctx.chrome.runtime.getContexts({}))), []);
  assert.equal(t.ctx.chrome.sidePanel, undefined);
});

test('config seed merges into settings, keeps other fields, sets actor safari', async () => {
  const t = setup({ reply: configOnly, stored: { settings: { baseUrl: 'http://old', token: 'old', actor: 'chrome', pollMinutes: 5, notify: { enabled: false } }, other: 1 } });
  await t.ctx.__droverSafari.ready;
  assert.deepEqual(t.sets.length, 1);
  assert.deepEqual(t.store.settings, { baseUrl: BASE, token: TOKEN, actor: 'safari', pollMinutes: 5, notify: { enabled: false } });
  assert.equal(t.store.other, 1);
});

test('config seed: keeps a custom actor, creates settings when absent', async () => {
  const a = setup({ reply: configOnly, stored: { settings: { actor: 'alice' } } });
  await a.ctx.__droverSafari.ready;
  assert.equal(a.store.settings.actor, 'alice');
  const b = setup({ reply: configOnly });
  await b.ctx.__droverSafari.ready;
  assert.deepEqual(b.store.settings, { baseUrl: BASE, token: TOKEN, actor: 'safari' });
});

test('config seed writes nothing when unchanged', async () => {
  const t = setup({ reply: configOnly, stored: { settings: { baseUrl: BASE, token: TOKEN, actor: 'safari' } } });
  await t.ctx.__droverSafari.ready;
  assert.equal(t.sets.length, 0);
});

test('config seed does nothing when native has no token', async () => {
  for (const r of [{ ok: true, result: { baseURL: BASE, token: null } }, { ok: true, result: { baseURL: null, token: TOKEN } }, { ok: false, error: 'x' }]) {
    const t = setup({ reply: () => r, stored: { settings: { token: 'mine' } } });
    await t.ctx.__droverSafari.ready;
    assert.equal(t.sets.length, 0);
    assert.equal(t.store.settings.token, 'mine');
  }
});

test('native failure (throwing sendNativeMessage) resolves to native-unavailable', async () => {
  const t = setup({ browser: { runtime: { sendNativeMessage: () => { throw new Error('no host'); } } } });
  const r = await t.ctx.__droverSafari.native({ type: 'ping' });
  assert.deepEqual(JSON.parse(JSON.stringify(r)), { ok: false, error: 'native-unavailable' });
});

const opReply = (msg) => {
  if (msg.type === 'config') return NATIVE_CONFIG;
  if (msg.type === 'op') return { ok: true, result: { status: 201, body: '{"sessions":[]}' } };
  return { ok: false, error: 'unknownType' };
};

test('fetch proxy: POST /api/op/sessions.list goes native and returns a Response', async () => {
  const t = setup({ reply: opReply });
  const res = await t.ctx.fetch(`${BASE}/api/op/sessions.list`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ limit: 5 }) });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('content-type'), 'application/json');
  assert.deepEqual(await res.json(), { sessions: [] });
  const op = t.sent.find((s) => s.msg.type === 'op').msg;
  assert.deepEqual(JSON.parse(JSON.stringify(op)), { v: 1, type: 'op', op: 'sessions.list', method: 'POST', args: { limit: 5 }, origin: BASE });
  assert.equal(t.fetchCalls.length, 0);
});

test('fetch proxy: empty POST body becomes {}, GET sends query args, op is decoded', async () => {
  const t = setup({ reply: opReply });
  await t.ctx.fetch(`${BASE}/api/op/a.b`, { method: 'POST' });
  await t.ctx.fetch(`${BASE}/api/op/sessions%2Eget?id=demo-build&host=demo-mac`);
  const ops = t.sent.filter((s) => s.msg.type === 'op').map((s) => JSON.parse(JSON.stringify(s.msg)));
  assert.deepEqual(ops[0].args, {});
  assert.equal(ops[1].method, 'GET');
  assert.equal(ops[1].op, 'sessions.get');
  assert.deepEqual(ops[1].args, { id: 'demo-build', host: 'demo-mac' });
});

test('fetch proxy: other origins, other paths, other methods and /api/stream use the real fetch', async () => {
  const t = setup({ reply: opReply });
  await t.ctx.fetch('http://other-host:8080/api/op/sessions.list', { method: 'POST', body: '{}' });
  await t.ctx.fetch(`${BASE}/api/stream`);
  await t.ctx.fetch(`${BASE}/api/op/sessions.list`, { method: 'PUT', body: '{}' });
  await t.ctx.fetch('not a url');
  assert.equal(t.fetchCalls.length, 4);
  assert.equal(t.sent.filter((s) => s.msg.type === 'op').length, 0);
});

test('fetch proxy: failures where nothing was sent fall back to the real fetch', async () => {
  for (const error of ['native-unavailable', 'badRequest']) {
    const t = setup({ reply: (m) => (m.type === 'config' ? NATIVE_CONFIG : { ok: false, error }) });
    const res = await t.ctx.fetch(`${BASE}/api/op/sessions.list`, { method: 'POST', body: '{}' });
    assert.equal(await res.text(), 'real', error);
    assert.equal(t.fetchCalls.length, 1, error);
  }
});

test('fetch proxy: ambiguous failures (timeout, lost answer, network) reject mutations and never replay them', async () => {
  for (const error of ['native-timeout', 'native-no-answer', 'network']) {
    const t = setup({ reply: (m) => (m.type === 'config' ? NATIVE_CONFIG : { ok: false, error }) });
    await assert.rejects(
      t.ctx.fetch(`${BASE}/api/op/sessions.message`, { method: 'POST', body: '{"id":"demo-build","text":"hi"}' }),
      (e) => e.name === 'TypeError', error);
    assert.equal(t.fetchCalls.length, 0, error);
  }
});

test('fetch proxy: notConfigured (shared server changed) re-reads the config and sends the page request itself', async () => {
  let configs = 0;
  const t = setup({ reply: (m) => (m.type === 'config' ? (configs++, NATIVE_CONFIG) : { ok: false, error: 'notConfigured' }) });
  const res = await t.ctx.fetch(`${BASE}/api/op/sessions.list`, { method: 'POST', body: '{}' });
  assert.equal(await res.text(), 'real');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(configs, 2);
});

test('fetch proxy: ambiguous failures of read-only ops may use the network', async () => {
  const t = setup({ reply: (m) => (m.type === 'config' ? NATIVE_CONFIG : { ok: false, error: 'native-timeout' }) });
  const res = await t.ctx.fetch(`${BASE}/api/op/native.summary`, { method: 'POST', body: '{}' });
  assert.equal(await res.text(), 'real');
  // The compact board and the manager's reads (UX overhaul) are reads too.
  for (const op of ['native.board', 'sessions.get', 'openclaw.threads']) {
    const r = await t.ctx.fetch(`${BASE}/api/op/${op}`, { method: 'POST', body: '{}' });
    assert.equal(await r.text(), 'real', op);
  }
});

test('fetch proxy: a dialog answer is a mutation: proxied with its expect hash, never replayed', async () => {
  const ok = setup({ reply: (m) => (m.type === 'config' ? NATIVE_CONFIG : { ok: true, result: { status: 200, body: '{"ok":true,"result":{"ok":true,"key":"1"}}' } }) });
  const res = await ok.ctx.fetch(`${BASE}/api/op/sessions.answer`, { method: 'POST', body: '{"id":"demo-build","key":"1","expect":"3f2a"}' });
  assert.deepEqual(await res.json(), { ok: true, result: { ok: true, key: '1' } });
  const op = ok.sent.find((s) => s.msg.type === 'op').msg;
  assert.equal(op.op, 'sessions.answer');
  assert.deepEqual(op.args, { id: 'demo-build', key: '1', expect: '3f2a' });
  for (const error of ['native-timeout', 'native-no-answer', 'network']) {
    const t = setup({ reply: (m) => (m.type === 'config' ? NATIVE_CONFIG : { ok: false, error }) });
    await assert.rejects(t.ctx.fetch(`${BASE}/api/op/sessions.answer`, { method: 'POST', body: '{"id":"demo-build","key":"1"}' }), (e) => e.name === 'TypeError', error);
    assert.equal(t.fetchCalls.length, 0, error);
  }
});

test('a rejected or malformed native answer is ambiguous, a missing API is not', async () => {
  const rejected = setup({ reply: (m) => (m.type === 'config' ? NATIVE_CONFIG : Promise.reject(new Error('lost'))) });
  await assert.rejects(rejected.ctx.fetch(`${BASE}/api/op/sessions.message`, { method: 'POST', body: '{}' }), (e) => e.name === 'TypeError');
  assert.equal(rejected.fetchCalls.length, 0);
  const garbage = setup({ reply: (m) => (m.type === 'config' ? NATIVE_CONFIG : 'nope') });
  await assert.rejects(garbage.ctx.fetch(`${BASE}/api/op/sessions.message`, { method: 'POST', body: '{}' }), (e) => e.name === 'TypeError');
  assert.equal((await garbage.ctx.__droverSafari.native({ type: 'ping' })).error, 'native-no-answer');
});

test('fetch proxy: a request carrying a different token is proxied with that token (options page test)', async () => {
  const t = setup({ reply: opReply });
  await t.ctx.fetch(`${BASE}/api/op/fleet.summary`, { method: 'POST', headers: { Authorization: 'Bearer typed-token-456' }, body: '{}' });
  await t.ctx.fetch(`${BASE}/api/op/fleet.summary`, { method: 'POST', headers: [['authorization', `Bearer ${TOKEN}`]], body: '{}' });
  assert.equal(t.fetchCalls.length, 0);
  const ops = t.sent.filter((s) => s.msg.type === 'op').map((s) => s.msg);
  assert.equal(ops[0].token, 'typed-token-456');
  assert.equal('token' in ops[1], false); // the stored token never travels in the message
});

test('fetch proxy: aborting while the native call is in flight rejects with AbortError', async () => {
  let release;
  const t = setup({ reply: (m) => (m.type === 'config' ? NATIVE_CONFIG : new Promise((r) => { release = r; })) });
  const ac = new AbortController();
  const p = t.ctx.fetch(`${BASE}/api/op/sessions.list`, { method: 'POST', body: '{}', signal: ac.signal });
  await new Promise((r) => setTimeout(r, 5));
  ac.abort();
  await assert.rejects(p, (e) => e.name === 'AbortError');
  release({ ok: true, result: { status: 200, body: '{}' } });
  assert.equal(t.fetchCalls.length, 0);
});

test('storage.local.get waits for the config seed (first-run settings read sees Keychain values)', async () => {
  let answer;
  const t = setup({ reply: (m) => (m.type === 'config' ? new Promise((r) => { answer = r; }) : { ok: false, error: 'x' }) });
  const read = t.ctx.chrome.storage.local.get('settings');
  await new Promise((r) => setTimeout(r, 5));
  answer(NATIVE_CONFIG);
  const got = await read;
  assert.equal(got.settings.baseUrl, BASE);
  assert.equal(got.settings.token, TOKEN);
  const cbGot = await new Promise((r) => t.ctx.chrome.storage.local.get(['settings'], r));
  assert.equal(cbGot.settings.actor, 'safari');
});

test('permissions.request does not wait for the seed (keeps the user gesture)', async () => {
  const t = setup({ reply: (m) => (m.type === 'config' ? new Promise(() => {}) : { ok: false, error: 'x' }) });
  t.ctx.chrome.permissions.request({ origins: [`${BASE}/*`] });
  assert.equal(t.permCalls.length, 1); // delegated synchronously to the real API
  assert.equal(t.permCalls[0][0], 'request');
});

test('fetch proxy: without a native token everything goes to the real fetch', async () => {
  const t = setup({ reply: () => ({ ok: false, error: 'notConfigured' }) });
  await t.ctx.fetch(`${BASE}/api/op/sessions.list`, { method: 'POST', body: '{}' });
  assert.equal(t.fetchCalls.length, 1);
});

test('fetch proxy: an aborted signal rejects with AbortError', async () => {
  const t = setup({ reply: opReply });
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(t.ctx.fetch(`${BASE}/api/op/sessions.list`, { method: 'POST', body: '{}', signal: ac.signal }), (e) => e.name === 'AbortError');
  assert.equal(t.sent.filter((s) => s.msg.type === 'op').length, 0);
});

test('permissions: server origin is granted only when the proxy is configured', async () => {
  const t = setup({ reply: configOnly });
  const p = { origins: [`${BASE}/*`] };
  assert.equal(await t.ctx.chrome.permissions.contains(p), true);
  assert.equal(await t.ctx.chrome.permissions.request(p), true);
  assert.equal(t.permCalls.length, 0);
  // Anything else is delegated.
  assert.equal(await t.ctx.chrome.permissions.contains({ origins: ['http://other/*'] }), false);
  assert.equal(await t.ctx.chrome.permissions.contains({ origins: [`${BASE}/*`], permissions: ['tabs'] }), false);
  assert.equal(await t.ctx.chrome.permissions.request({ permissions: ['alarms'] }), false);
  assert.equal(t.permCalls.length, 3);

  const off = setup({ reply: () => ({ ok: false, error: 'notConfigured' }) });
  assert.equal(await off.ctx.chrome.permissions.contains(p), false);
  assert.equal(off.permCalls.length, 1);
});

test('permissions: resolves false when the API is missing', async () => {
  const t = setup({ reply: configOnly, browser: { permissions: undefined } });
  assert.equal(await t.ctx.chrome.permissions.contains({ origins: ['http://other/*'] }), false);
  assert.equal(await t.ctx.chrome.permissions.contains({ origins: [`${BASE}/*`] }), true);
});

test('loading the shim twice wraps fetch once and keeps one state object', async () => {
  const t = setup({ reply: opReply });
  const first = t.ctx.fetch;
  const state = t.ctx.__droverSafari;
  t.load();
  assert.equal(t.ctx.fetch, first);
  assert.equal(t.ctx.__droverSafari, state);
  await t.ctx.fetch(`${BASE}/api/op/sessions.list`, { method: 'POST', body: '{}' });
  assert.equal(t.sent.filter((s) => s.msg.type === 'op').length, 1);
  assert.equal(t.sent.filter((s) => s.msg.type === 'config').length, 1);
});

test('works in a worker-like context: no window, no document', () => {
  const t = setup({ noFetch: true });
  assert.equal(t.run('typeof window + typeof document'), 'undefinedundefined');
  assert.equal(typeof t.ctx.__droverSafari.native, 'function');
});

test('the token never reaches console.*', async () => {
  const t = setup({ reply: (m) => (m.type === 'op' ? { ok: false, error: 'network' } : m.type === 'config' ? NATIVE_CONFIG : { ok: false, error: 'x' }), stored: { settings: { token: 'old' } } });
  await t.ctx.fetch(`${BASE}/api/op/sessions.list`, { method: 'POST', body: '{}' }).catch(() => {});
  await t.ctx.chrome.permissions.contains({ origins: [`${BASE}/*`] });
  await t.ctx.chrome.notifications.create('drover|demo-mac|demo-build|1', { title: 't', message: 'm' });
  assert.ok(!JSON.stringify(t.logged).includes(TOKEN));
  assert.ok(!/console\./.test(template.replace(/\/\/.*$/gm, '')), 'the shim should not use console at all');
});
