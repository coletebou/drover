// Options page: server, pairing or token, host permission, notifications, access.
import { h, render, clear } from './ui/dom.js';
import { createClient, originPattern, normalizeBaseUrl, ApiError, ErrorKind } from './lib/api.js';
import { loadSettings, saveSettings, POLL_MINUTES } from './lib/settings.js';
import { normalizeSummary } from './lib/summary.js';
import { plural } from './lib/text.js';
import { startPairing, pairingView, deviceLabel } from './lib/pairing.js';
import { notifySettingsChanged } from './ext/summary-store.js';

const $ = (id) => document.getElementById(id);
const extOrigin = chrome.runtime.getURL('').replace(/\/$/, '');
let settings = null;
let saving = false;   // Save and connect, or a permission prompt, is running
let pairing = null;   // the running pairing ({ cancel, done }), for Cancel
let pairBusy = false; // a pairing is running or checking its connection
let lastPair = null;  // the last pairing update: never the token, never the request id
let pairTick = null;  // the countdown while a code is showing

function setStatus(kind, ...children) {
  const el = $('status');
  el.className = `notice${kind === 'error' ? ' error' : kind === 'ok' ? ' ok' : ''}`;
  render(el, ...children);
}

function showHint(on) { $('origin-hint').hidden = !on; }

async function copy(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const old = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = old; }, 1500);
  } catch { /* clipboard blocked: the field is selectable */ }
}

function applyTokenUi() {
  const has = Boolean(settings.token);
  const t = $('token');
  t.value = '';
  t.placeholder = has ? 'Saved. Leave blank to keep it.' : '';
  $('forget').hidden = !has;
}

function explain(err) {
  showHint(false);
  switch (err?.kind) {
    case ErrorKind.FORBIDDEN:
      showHint(true);
      return err.message;
    case ErrorKind.UNAUTHORIZED: return 'The daemon rejected the token.';
    case ErrorKind.UNREACHABLE: return `${err.message} Is Drover running? Try drover status on that machine.`;
    default: return err?.message || 'Something went wrong.';
  }
}

async function testConnection(baseUrl, token) {
  setStatus('info', 'Connecting…');
  try {
    const client = createClient({ baseUrl, token });
    const s = normalizeSummary(await client.op('native.summary'));
    showHint(false);
    setStatus('ok', `Connected to ${client.origin}: ${plural(s.totals.hosts, 'host')}, ${s.totals.waiting} waiting.`);
    return true;
  } catch (e) {
    setStatus('error', explain(e));
    return false;
  }
}

/** The origin and host-permission pattern in the URL field, or { error } when it is not usable. */
function readServer() {
  try {
    return { pattern: originPattern($('url').value), origin: normalizeBaseUrl($('url').value) };
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : 'The server URL is not valid.' };
  }
}

/** Ask Chrome for access to one server. Call it before any await: it needs the click's user gesture. */
function requestAccess(pattern) {
  return chrome.permissions?.request ? chrome.permissions.request({ origins: [pattern] }) : Promise.resolve(true);
}

/** Save and connect, Pair and Forget wait for each other; the URL stays put while pairing runs. */
function lockForm() {
  for (const id of ['save', 'pair', 'pair-retry']) $(id).disabled = saving || pairBusy;
  $('forget').disabled = pairBusy;
  $('url').readOnly = pairBusy;
}

/** Store the server and token. Save and connect and pairing both store through here. */
async function store(origin, token) {
  const old = settings.baseUrl;
  if (old && chrome.permissions?.remove) {
    try {
      const oldOrigin = normalizeBaseUrl(old);
      if (oldOrigin !== origin) await chrome.permissions.remove({ origins: [originPattern(old)] });
    } catch { /* ignore */ }
  }
  settings = await saveSettings(chrome.storage.local, { baseUrl: origin, token, actor: $('actor').value });
  $('url').value = settings.baseUrl;
  $('actor').value = settings.actor;
  applyTokenUi();
  await notifySettingsChanged();
  await refreshAccess();
}

async function save() {
  const target = readServer();
  if (target.error) { showHint(false); setStatus('error', target.error); return; }
  // Must be the first async call: it needs the click's user gesture.
  const asked = requestAccess(target.pattern);
  saving = true;
  lockForm();
  try {
    const granted = await asked;
    if (!granted) { showHint(false); setStatus('error', `Access to ${target.origin} was not granted.`); return; }
    await store(target.origin, $('token').value.trim() || undefined);
    if (!settings.token) { setStatus('error', 'Enter the token to connect.'); return; }
    await testConnection(settings.baseUrl, settings.token);
  } catch {
    setStatus('error', 'Could not save the settings.');
  } finally {
    saving = false;
    lockForm();
  }
}

async function pair() {
  if (saving || pairBusy) return;
  const target = readServer();
  if (target.error) {
    showPairing({ state: 'error', origin: '', error: { kind: ErrorKind.NOT_CONFIGURED, message: $('url').value.trim() ? target.error : 'Enter the server URL first.' } });
    return;
  }
  // Must be the first async call: it needs the click's user gesture.
  const asked = requestAccess(target.pattern);
  saving = true;
  lockForm();
  let granted = false;
  try { granted = await asked; } catch { /* treated as refused */ }
  saving = false;
  if (!granted) {
    showPairing({ state: 'error', origin: target.origin, error: { kind: ErrorKind.NO_PERMISSION, message: `Access to ${target.origin} was not granted.` } });
    return;
  }
  // The token goes from the daemon to store() only; showPairing never sees it.
  pairing = startPairing({
    baseUrl: target.origin,
    device: deviceLabel(navigator),
    saveToken: (token) => store(target.origin, token),
    onUpdate: showPairing,
  });
}

/** Render a pairing update (lib/pairing.js pairingView). Between updates only the countdown changes. */
function showPairing(u) {
  lastPair = u;
  const v = pairingView(u);
  pairBusy = v.busy;
  if (!pairBusy) pairing = null;
  lockForm();
  const box = $('pairing');
  box.hidden = false;
  box.className = `pairing${v.tone === 'error' ? ' error' : v.tone === 'ok' ? ' ok' : ''}`;
  const code = $('pair-code');
  code.hidden = !v.code;
  render(code, v.code ? [h('span', { 'aria-hidden': 'true' }, v.code), h('span', { class: 'sr-only' }, v.codeLabel)] : []);
  render($('pair-msg'), v.message.map((part) => (typeof part === 'string' ? part : h('code', {}, part.code))));
  $('pair-copy').hidden = !v.command;
  $('pair-cancel').hidden = !v.cancel;
  $('pair-retry').hidden = !v.retry;
  $('pair-actions').hidden = !(v.command || v.cancel || v.retry);
  // The origin hint belongs to the Connection section: pairing shows it for a refused origin and clears it when it starts over.
  if (v.originHint || u.state === 'requesting') showHint(v.originHint);
  clearInterval(pairTick);
  pairTick = v.timer ? setInterval(showCountdown, 1000) : null;
  showCountdown();
  if (u.state === 'paired' && u.connected === undefined) checkPaired(u);
}

/** The countdown sits outside the status line, so screen readers do not hear it every second. */
function showCountdown() {
  const v = lastPair ? pairingView(lastPair) : null;
  const t = $('pair-timer');
  t.hidden = !v?.timer;
  t.textContent = v?.timer ?? '';
}

/** A paired token gets the same connection check Save and connect ends with. */
async function checkPaired(u) {
  const connected = await testConnection(settings.baseUrl, settings.token);
  if (lastPair === u) showPairing({ ...u, connected });
}

async function forget() {
  const old = settings.baseUrl;
  settings = await saveSettings(chrome.storage.local, { token: '' });
  if (old && chrome.permissions?.remove) {
    try { await chrome.permissions.remove({ origins: [originPattern(old)] }); } catch { /* ignore */ }
  }
  await notifySettingsChanged();
  applyTokenUi();
  showHint(false);
  setStatus('info', 'Token forgotten and access removed.');
  await refreshAccess();
}

async function saveNotify(patch) {
  settings = await saveSettings(chrome.storage.local, patch);
  await notifySettingsChanged();
  const el = $('saved');
  el.textContent = 'Saved';
  setTimeout(() => { if (el.textContent === 'Saved') el.textContent = ''; }, 2000);
}

async function refreshAccess() {
  const list = $('origins');
  if (!chrome.permissions?.getAll) { render(list, h('li', { class: 'muted' }, 'Not available in this browser.')); return; }
  const all = await chrome.permissions.getAll();
  const origins = (all.origins ?? []);
  if (!origins.length) { render(list, h('li', { class: 'muted' }, 'No server access granted.')); return; }
  render(list, origins.map((o) => h('li', {},
    h('code', {}, o),
    h('button', {
      type: 'button',
      'aria-label': `Remove access to ${o}`,
      onclick: async () => { try { await chrome.permissions.remove({ origins: [o] }); } catch { /* ignore */ } await refreshAccess(); },
    }, 'Remove access'))));
}

function init() {
  $('url').value = settings.baseUrl;
  $('actor').value = settings.actor;
  applyTokenUi();
  $('n-enabled').checked = settings.notify.enabled;
  $('n-decision').checked = settings.notify.decision;
  $('n-question').checked = settings.notify.question;
  $('n-finished').checked = settings.notify.finished;
  render($('poll'), POLL_MINUTES.map((m) => h('option', { value: m, selected: m === settings.pollMinutes }, m === 1 ? 'Every minute' : `Every ${m} minutes`)));

  for (const id of ['origin-hint-field', 'origin-field']) $(id).value = extOrigin;
  render($('example'), `DROVER_ALLOW_ORIGINS=${extOrigin} drover serve`);
  $('origin-hint-copy').addEventListener('click', (e) => copy(extOrigin, e.currentTarget));
  $('origin-copy').addEventListener('click', (e) => copy(extOrigin, e.currentTarget));

  $('show').addEventListener('click', (e) => {
    const t = $('token');
    const show = t.type === 'password';
    t.type = show ? 'text' : 'password';
    e.currentTarget.textContent = show ? 'Hide' : 'Show';
    e.currentTarget.setAttribute('aria-pressed', String(show));
  });
  $('save').addEventListener('click', save);
  $('forget').addEventListener('click', forget);
  $('pair').addEventListener('click', pair);
  $('pair-retry').addEventListener('click', pair);
  $('pair-cancel').addEventListener('click', () => pairing?.cancel());
  $('pair-copy').addEventListener('click', (e) => { const v = lastPair ? pairingView(lastPair) : null; if (v?.command) copy(v.command, e.currentTarget); });

  const nb = (id, key) => $(id).addEventListener('change', (e) => saveNotify({ notify: { [key]: e.currentTarget.checked } }));
  nb('n-enabled', 'enabled'); nb('n-decision', 'decision'); nb('n-question', 'question'); nb('n-finished', 'finished');
  $('poll').addEventListener('change', (e) => saveNotify({ pollMinutes: Number(e.currentTarget.value) }));
  $('actor').addEventListener('change', (e) => saveNotify({ actor: e.currentTarget.value }).then(() => { e.currentTarget.value = settings.actor; }));

  refreshAccess();
}

settings = await loadSettings(chrome.storage.local);
init();
