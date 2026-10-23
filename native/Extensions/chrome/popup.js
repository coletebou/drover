// The popup: the manager first (ask, the reply streaming in, quick prompts), then what waits on you with the
// dialog's own keys, then what works, then idle totals. Live over SSE (topics summary, alerts, manager, turn)
// while open; the service worker's poll is the fallback.
import { h, render } from './ui/dom.js';
import { boardModel, replyState } from './lib/board.js';
import { sessionUrl, boardUrl, managerUrl } from './lib/links.js';
import { plural } from './lib/text.js';
import { normalizeSummary, normalizeBoard, isOwner } from './lib/summary.js';
import { answerPlan, pressKey } from './lib/answer.js';
import { managerInit, managerReduce, managerBusy, lastExchange, MANAGER_ID } from './lib/manager.js';
import { POPUP_TOPICS, routeEvent, honoursTopics } from './lib/topics.js';
import { connectStream } from './lib/sse.js';
import { getClient } from './ext/client.js';
import { readSummary, onSummary, requestRefresh, pushSummary } from './ext/summary-store.js';
import { openSessionPanel } from './ext/panel.js';
import { answerButtons, answerStatus } from './ui/answer.js';
import { markdown } from './ui/markdown.js';

const app = document.getElementById('app');
const hasPanel = Boolean(chrome.sidePanel?.open);
const OPTION_KINDS = ['not-configured', 'no-permission', 'unauthorized', 'forbidden'];
const QUICK = ['Who is waiting on me?', 'What finished?'];
const ANSWER_SHOWN_MS = 8000;

let entry = null;
let windowId = null;
let refreshing = false;
let openKey = null;
const drafts = new Map(); // key -> text
const replies = new Map(); // key -> replyState
const answers = new Map(); // key -> { pressing?, message?, error?, hash?, at }
let answersSupported = true;
let origin = null;
let live = false;
let legacy = false;
let sse = null;
let mgr = managerInit();
let mgrNote = null;
let lastMgrEvent = 0;
let catchUp = null;
let historyLoaded = false;
let myActor = 'chrome';

chrome.windows?.getCurrent().then((w) => { windowId = w?.id ?? null; }).catch(() => {});

const headerEl = h('header', { class: 'pop-head' });
const managerEl = h('section', { class: 'mgr', 'aria-label': 'Manager' });
const bodyEl = h('div', { class: 'pop-body' });
render(app, headerEl, managerEl, bodyEl);

async function getOrigin() {
  if (origin) return origin;
  try { origin = (await getClient()).client.origin; } catch { /* leave null */ }
  return origin;
}

function openOptions() { chrome.runtime.openOptionsPage(); }

async function openWeb(s) {
  const o = await getOrigin();
  if (!o) return openOptions();
  chrome.tabs.create({ url: s ? sessionUrl(o, s) : boardUrl(o) });
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  renderHeader();
  const fresh = await requestRefresh();
  refreshing = false;
  if (fresh) entry = fresh;
  renderAll();
}

// ---------------------------------------------------------------- header

function totalsLine(m) {
  const t = m.totals;
  const part = (n, label, cls) => [h('span', { class: `n state-${cls}` }, String(n)), ` ${label}`];
  return h('p', { class: 'totals' }, part(t.waiting, 'waiting', 'waiting'), ' · ', part(t.working, 'working', 'working'), ' · ', part(t.idle, 'idle', 'idle'));
}

function renderHeader() {
  const m = boardModel(entry);
  const target = m.waiting[0] ?? m.working[0] ?? null;
  render(headerEl,
    h('div', { class: 'pop-head-row' },
      h('h1', {}, 'Drover'),
      h('span', { class: 'conn', title: live ? 'Updates stream in' : 'Checking every few seconds' }, h('span', { class: `dot ${live ? 'idle' : ''}`, 'aria-hidden': 'true' }), live ? 'Live' : 'Polling'),
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'ghost icon', onclick: refresh, disabled: refreshing, 'aria-label': 'Refresh', title: 'Refresh now' }, '↻'),
      hasPanel ? h('button', { type: 'button', class: 'ghost', onclick: () => panelFor(target) }, 'Side panel') : null,
      h('button', { type: 'button', class: 'ghost icon', 'aria-label': 'Options', title: 'Options', onclick: openOptions }, '⚙'),
      h('button', { type: 'button', onclick: () => openWeb(null) }, 'Open Drover')),
    m.status === 'ok' || m.status === 'stale' ? totalsLine(m) : null,
    h('div', { class: 'status-line', 'aria-live': 'polite', role: 'status' }, refreshing ? 'Refreshing' : live ? '' : (m.updated === 'now' ? 'Updated just now' : m.updated ? `Updated ${m.updated} ago` : '')));
}

function panelFor(s) {
  // Must run synchronously in the click handler: windowId is cached at load.
  if (s) openSessionPanel({ windowId }, s);
  else if (hasPanel && windowId != null) chrome.sidePanel.open({ windowId });
  window.close();
}

// ---------------------------------------------------------------- manager

// native.summary names no manager host (it is widget-token readable); native.board does: asked once, when needed.
let boardHost;
const managerHost = () => entry?.data?.manager?.host ?? boardHost ?? null;
const managerTarget = () => ({ host: managerHost() || 'local', id: MANAGER_ID, name: 'manager', engine: 'openclaw' });

/** The `host` arg for manager ops ({} for the daemon's own machine). */
async function managerHostArg(client) {
  if (!entry?.data?.manager?.host && boardHost === undefined) {
    try { boardHost = normalizeBoard(await client.op('native.board')).manager?.host ?? null; } catch { boardHost = null; }
  }
  const host = managerHost();
  return host && host !== 'local' ? { host } : {};
}

const askInput = h('input', { type: 'text', class: 'mgr-input', placeholder: 'Ask the manager', 'aria-label': 'Ask the manager', autocomplete: 'off',
  onkeydown: (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); ask(askInput.value); } } });
const askBtn = h('button', { type: 'button', class: 'primary', onclick: () => ask(askInput.value) }, 'Ask');
const mgrStatusEl = h('span', { class: 'mgr-status', role: 'status', 'aria-live': 'polite' });
const mgrExchangeEl = h('div', { class: 'mgr-exchange' });
const mgrNoteEl = h('div', { class: 'mgr-note', role: 'status', 'aria-live': 'polite' });
const mgrAskRow = h('div', { class: 'mgr-ask' }, askInput, askBtn);
const mgrChips = h('div', { class: 'mgr-chips' },
  QUICK.map((q) => h('button', { type: 'button', class: 'chip', onclick: () => ask(q) }, q)),
  h('button', { type: 'button', class: 'chip', onclick: sweep, title: 'Ask the manager to sweep the fleet now' }, 'Sweep now'));
const mgrOpenBtn = h('button', { type: 'button', class: 'ghost', onclick: openManager, title: hasPanel ? 'The whole conversation in the side panel' : 'The Manager view in Drover' }, 'Open');
render(managerEl,
  h('div', { class: 'mgr-head' }, h('span', { class: 'dot manager', 'aria-hidden': 'true' }), h('h2', {}, 'Manager'), mgrStatusEl, h('span', { class: 'spacer' }), mgrOpenBtn),
  mgrExchangeEl, mgrAskRow, mgrChips, mgrNoteEl);

async function openManager() {
  if (hasPanel) { panelFor(managerTarget()); return; }
  const o = await getOrigin();
  if (!o) return openOptions();
  chrome.tabs.create({ url: managerUrl(o) });
}

function renderManager() {
  const m = entry?.data?.manager ?? null;
  const up = Boolean(m?.up);
  const busy = managerBusy(mgr);
  managerEl.hidden = !entry?.data;
  const { question, reply } = lastExchange(mgr);
  mgrStatusEl.textContent = !up ? 'not running' : busy ? (reply?.streaming ? 'writing' : mgr.sending ? 'sending' : 'thinking') : '';
  mgrStatusEl.className = `mgr-status${!up ? ' down' : busy ? ' busy' : ''}`;
  const parts = [];
  if (!up) parts.push(h('p', { class: 'muted' }, 'The manager is not running. Open it to see its status.'));
  if (question) parts.push(h('p', { class: 'mgr-q' }, h('span', { class: 'who' }, question.actor && !isOwner(question.actor, entry?.data?.owner) && question.actor !== myActor ? `${question.actor}:` : 'You:'), ' ', question.text));
  if (reply) {
    if (reply.role === 'system') parts.push(h('p', { class: 'mgr-err', role: 'alert' }, reply.text));
    else if (!reply.text && (reply.pending || reply.streaming)) parts.push(h('p', { class: 'muted' }, 'Thinking…'));
    else parts.push(h('div', { class: `mgr-reply${reply.streaming ? ' streaming' : ''}` }, markdown(reply.text)));
  }
  render(mgrExchangeEl, parts);
  mgrAskRow.hidden = !up;
  mgrChips.hidden = !up;
  askBtn.disabled = mgr.sending;
  for (const b of mgrChips.querySelectorAll('button')) b.disabled = mgr.sending && b.textContent !== 'Sweep now';
  mgrNoteEl.textContent = mgrNote?.text ?? '';
  mgrNoteEl.className = `mgr-note${mgrNote?.error ? ' err' : ''}`;
}

function note(text, error = false) {
  mgrNote = { text, error };
  renderManager();
  const mine = mgrNote;
  setTimeout(() => { if (mgrNote === mine) { mgrNote = null; renderManager(); } }, 4000);
}

async function ask(raw) {
  const text = String(raw ?? '').trim();
  if (!text || mgr.sending) return;
  if (askInput.value.trim() === text) askInput.value = '';
  mgr = managerReduce(mgr, { type: 'send', text });
  renderManager();
  try {
    const { client, settings } = await getClient();
    // An older daemon holds this call until the reply: give it the time a reply can take.
    const res = await client.op('sessions.message', { id: MANAGER_ID, text, wait: false, actor: settings.actor, ...(await managerHostArg(client)) }, { timeoutMs: 600_000 });
    mgr = managerReduce(mgr, { type: 'sent', res });
  } catch (e) {
    mgr = managerReduce(mgr, { type: 'fail', message: e?.message || 'Could not send.' });
    if (!askInput.value.trim()) askInput.value = text;
  }
  renderManager();
  if (managerBusy(mgr)) startCatchUp();
}

async function sweep() {
  try {
    const { client, settings } = await getClient();
    await client.op('openclaw.sweep', { actor: settings.actor, ...(await managerHostArg(client)) });
    note('Sweep requested. The manager\'s notes land in its feed.');
  } catch (e) { note(e?.message || 'That did not work.', true); }
}

async function readManager() {
  try {
    const { client } = await getClient();
    const res = await client.op('sessions.transcript', { id: MANAGER_ID, limit: 8, ...(await managerHostArg(client)) });
    mgr = managerReduce(mgr, { type: 'transcript', res });
    renderManager();
  } catch { /* no manager on this daemon */ }
}

/** While a reply is due and no stream delivers it (Safari without the stream, a dropped connection), read the transcript. */
function startCatchUp() {
  if (catchUp) return;
  const started = Date.now();
  catchUp = setInterval(async () => {
    if (!managerBusy(mgr) || Date.now() - started > 900_000) { clearInterval(catchUp); catchUp = null; return; }
    if (live && Date.now() - lastMgrEvent < 4000) return;
    await readManager();
  }, 2000);
}

// ---------------------------------------------------------------- waiting, working, idle

function answerState(s) {
  const st = answers.get(s.key);
  if (!st) return null;
  if (st.pressing) return st;
  return Date.now() - st.at < ANSWER_SHOWN_MS ? st : null;
}

async function press(s, key) {
  if (answers.get(s.key)?.pressing) return;
  answers.set(s.key, { pressing: key, at: Date.now() });
  renderBody();
  try {
    const { client, settings } = await getClient();
    const out = await pressKey(client, s, key, { actor: settings.actor });
    if (out.unsupported) answersSupported = false;
    answers.set(s.key, { message: out.message, error: !out.ok, hash: out.ok ? s.hash ?? null : null, at: Date.now() });
    // A refusal means the screen moved on: show it as it is now. Sent, without the stream: read the next screen
    // shortly instead of waiting for the poll.
    if (!out.ok) refresh();
    else if (!live) setTimeout(refresh, 1500);
  } catch (e) {
    answers.set(s.key, { message: e?.message || 'Could not send.', error: true, at: Date.now() });
  }
  renderBody();
  setTimeout(renderBody, ANSWER_SHOWN_MS + 50);
}

function waitingRow(s) {
  const plan = answerPlan(s, { supported: answersSupported });
  const st = answerState(s);
  // A key went to this very screen: hold the buttons back until the board shows what came next.
  const awaiting = st && !st.pressing && !st.error && st.hash && st.hash === s.hash;
  const open = openKey === s.key;
  return h('li', { class: `row wait${open ? ' open' : ''}`, 'data-key': s.key },
    h('div', { class: 'row-main' },
      h('div', { class: 'row-top' },
        h('span', { class: 'dot waiting', 'aria-hidden': 'true' }),
        h('span', { class: 'title' }, s.name),
        h('span', { class: 'row-meta' }, `${s.host} · ${s.engine}${s.ago ? ` · ${s.ago}` : ''}`)),
      h('div', { class: 'row-q' }, plan.question || s.headline || s.kindLabel),
      plan.mode === 'keys' && !awaiting ? answerButtons(plan, { busy: st?.pressing ?? null, onPress: (k) => press(s, k) }) : null,
      answerStatus(st),
      h('div', { class: 'row-actions' },
        plan.mode !== 'keys' ? h('button', { type: 'button', 'aria-expanded': open ? 'true' : 'false', onclick: () => toggle(s.key) }, open ? 'Cancel' : 'Reply') : null,
        hasPanel ? h('button', { type: 'button', onclick: () => panelFor(s) }, 'Open') : null,
        h('button', { type: 'button', class: 'ghost', onclick: () => openWeb(s) }, 'Open in Drover'))),
    open ? replyBox(s) : null);
}

function workingRow(s) {
  return h('li', { class: 'row work', 'data-key': s.key },
    h('button', { type: 'button', class: 'row-btn', onclick: () => (hasPanel ? panelFor(s) : openWeb(s)), title: hasPanel ? 'Open in the side panel' : 'Open in Drover' },
      h('div', { class: 'row-top' },
        h('span', { class: 'dot working', 'aria-hidden': 'true' }),
        h('span', { class: 'title' }, s.name),
        h('span', { class: 'row-meta' }, `${s.host} · ${s.engine}`)),
      s.headline ? h('div', { class: 'row-head' }, s.headline) : null));
}

function replyBox(s) {
  const st = replies.get(s.key) ?? replyState(null, { type: 'edit' });
  const ta = h('textarea', { 'aria-label': `Reply to ${s.name}`, placeholder: `Reply to ${s.name}`, rows: '2',
    oninput: (e) => { drafts.set(s.key, e.target.value); if (replies.get(s.key)?.phase !== 'sending') { replies.set(s.key, replyState(replies.get(s.key), { type: 'edit' })); updateStatus(); } },
    onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(s, ta); } } });
  ta.value = drafts.get(s.key) ?? '';
  const status = h('span', { class: `reply-status ${st.phase === 'error' ? 'err' : st.phase === 'sent' || st.phase === 'queued' ? 'ok' : ''}`, 'aria-live': 'polite', role: 'status', 'data-reply-status': '' }, st.message);
  const sendBtn = h('button', { type: 'button', class: 'primary', disabled: st.phase === 'sending', onclick: () => send(s, ta) }, 'Send');
  return h('div', { class: 'reply' }, ta, h('div', { class: 'reply-actions' }, sendBtn, status));
}

function updateStatus() {
  const el = bodyEl.querySelector('[data-reply-status]');
  const st = replies.get(openKey);
  if (el && st) { el.textContent = st.message; el.className = `reply-status ${st.phase === 'error' ? 'err' : st.phase === 'sent' || st.phase === 'queued' ? 'ok' : ''}`; }
}

async function send(s, ta) {
  const text = ta.value.trim();
  const cur = replies.get(s.key);
  if (!text || cur?.phase === 'sending') return;
  replies.set(s.key, replyState(cur, { type: 'send' }));
  renderBody();
  try {
    const { client, settings } = await getClient();
    origin = client.origin;
    const res = await client.op('sessions.message', { host: s.host, id: s.id, text, actor: settings.actor });
    drafts.delete(s.key);
    if (ta.isConnected && ta.value.trim() === text) ta.value = '';
    else bodyEl.querySelectorAll('.row.open textarea').forEach((x) => { if (x.value.trim() === text) x.value = ''; });
    replies.set(s.key, replyState(replies.get(s.key), { type: 'ok', queued: Boolean(res?.queuedBehindTurn) }));
    renderBody();
    if (!live) refresh();
  } catch (e) {
    replies.set(s.key, replyState(replies.get(s.key), { type: 'fail', message: e?.message || 'Could not send.' }));
    renderBody();
  }
}

function toggle(key) {
  openKey = openKey === key ? null : key;
  renderAll();
  if (openKey) bodyEl.querySelector('.row.open textarea')?.focus();
}

function section(cls, title, count, ...kids) {
  return h('section', { class: 'sec' }, h('h2', {}, h('span', { class: `dot ${cls}`, 'aria-hidden': 'true' }), title, h('span', { class: 'count' }, String(count))), ...kids);
}

function renderBody() {
  snapshotDraft();
  const keep = bodyEl.querySelector('.row.open textarea');
  const hadFocus = keep && document.activeElement === keep;
  const focusedKey = document.activeElement?.closest?.('.keys') ? document.activeElement.getAttribute('data-key') : null;
  const focusedRow = focusedKey ? document.activeElement.closest('li')?.getAttribute('data-key') : null;
  const m = boardModel(entry);
  const parts = [];
  if (m.status === 'error' || m.status === 'stale') {
    const opts = OPTION_KINDS.includes(m.error?.kind);
    const msg = m.status === 'stale' ? `Last update failed: ${m.error.message}` : m.error.message;
    parts.push(h('div', { class: 'notice error', role: 'alert' }, msg,
      m.status === 'error' ? h('div', { class: 'notice-actions' }, opts ? h('button', { type: 'button', onclick: openOptions }, 'Open options') : h('button', { type: 'button', onclick: refresh }, 'Retry')) : null));
  }
  if (m.status === 'empty') {
    parts.push(h('p', { class: 'empty' }, 'Loading'));
  } else if (m.status !== 'error') {
    if (m.waiting.length) parts.push(section('waiting', 'Waiting on you', m.waiting.length, h('ul', { class: 'rows' }, m.waiting.map(waitingRow))));
    else parts.push(h('p', { class: 'empty' }, 'Nothing is waiting on you.'));
    // The manager has its own box above.
    const working = m.working.filter((s) => s.id !== MANAGER_ID);
    if (working.length) parts.push(section('working', 'Working', working.length, h('ul', { class: 'rows' }, working.map(workingRow))));
    const offline = m.hosts.filter((x) => !x.up);
    parts.push(section('idle', 'Idle', m.idle.total, h('div', { class: 'idle-list' },
      m.idle.byHost.map((x) => h('span', {}, `${x.name} ${x.idle}`)),
      offline.map((x) => h('span', {}, `${x.name} `, h('span', { class: 'offline' }, x.label))),
      !m.idle.byHost.length && !offline.length ? h('span', {}, plural(m.idle.total, 'session')) : null)));
  }
  render(bodyEl, parts);
  if (hadFocus) bodyEl.querySelector('.row.open textarea')?.focus();
  else if (focusedRow && focusedKey) [...bodyEl.querySelectorAll('li')].find((li) => li.getAttribute('data-key') === focusedRow)?.querySelector(`.keys [data-key="${CSS.escape(focusedKey)}"]`)?.focus();
}

function renderAll() { renderHeader(); renderManager(); renderBody(); }

// Rerender on new summaries without wiping drafts (they live in `drafts`).
function snapshotDraft() {
  const ta = bodyEl.querySelector('.row.open textarea');
  const key = ta?.closest('li')?.getAttribute('data-key');
  if (ta && key) drafts.set(key, ta.value);
}

// ---------------------------------------------------------------- live updates

function onStreamEvent(name, data) {
  const r = routeEvent(name, data, POPUP_TOPICS);
  switch (r.kind) {
    case 'hello': legacy = !honoursTopics(r.data); break;
    case 'summary':
      entry = { at: Date.now(), data: normalizeSummary(r.data), error: null };
      pushSummary(r.data);
      renderAll();
      if (!historyLoaded && entry.data.manager.up) { historyLoaded = true; readManager(); }
      break;
    case 'manager':
      lastMgrEvent = Date.now();
      mgr = managerReduce(mgr, { type: 'stream', data: r.data });
      renderManager();
      break;
    case 'turn':
      if (r.data.id === MANAGER_ID) { lastMgrEvent = Date.now(); mgr = managerReduce(mgr, { type: 'turn', data: r.data }); renderManager(); }
      break;
    case 'legacy':
      // A daemon from before topics: its events only say something changed.
      if (legacy) scheduleRefresh();
      break;
    default: break;
  }
}

let refreshTimer = null;
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => { refreshTimer = null; refresh(); }, 2000);
}

async function startStream() {
  sse?.close();
  sse = null;
  try {
    const { client } = await getClient();
    sse = connectStream({
      request: client.streamRequest({ topics: POPUP_TOPICS }),
      fetch: globalThis.fetch.bind(globalThis),
      onEvent: onStreamEvent,
      onState: (state) => {
        const was = live;
        live = state === 'open';
        if (was !== live) { renderHeader(); if (!live && managerBusy(mgr)) startCatchUp(); }
      },
    });
  } catch { live = false; renderHeader(); }
}

onSummary((e) => {
  if (e?.data?.generatedAt && e.data.generatedAt === entry?.data?.generatedAt && !e.error) return;
  entry = e;
  renderAll();
});
entry = await readSummary();
getClient().then(({ settings }) => { myActor = settings.actor; renderManager(); }).catch(() => {});
renderAll();
refresh().then(() => { if (!historyLoaded && entry?.data?.manager?.up) { historyLoaded = true; readManager(); } });
startStream();
// The fallback while the stream is down (the service worker polls on its own alarm too).
setInterval(() => { if (!document.hidden && !live) refresh(); }, 20_000);
