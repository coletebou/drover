// The side panel: one conversation at a time. The manager is pinned first in the picker and is the default when
// nothing waits. Transcripts render by the chat rule (lib/chat.js: tool calls grouped with their results,
// Markdown text, errors marked, no turn twice); a session waiting on a dialog gets an answer card with its own
// keys. Live over SSE (topics turn, manager, board); polling is the fallback.
import { h, render, clear } from './ui/dom.js';
import { SESSION, LOCAL } from './lib/settings.js';
import { targetSessions, normalizeBoard } from './lib/summary.js';
import { sessionUrl, managerUrl } from './lib/links.js';
import { replyState, panelPoll } from './lib/board.js';
import { mergeTranscript, canIncrement, normalizeTurns, dedupeTurns, MAX_TURNS } from './lib/transcript.js';
import { chatItems } from './lib/chat.js';
import { answerPlan, pressKey, isUnknownOp } from './lib/answer.js';
import { managerInit, managerReduce, managerBusy, MANAGER_ID } from './lib/manager.js';
import { PANEL_TOPICS, routeEvent, honoursTopics } from './lib/topics.js';
import { getClient, needsOptions } from './ext/client.js';
import { readSummary, onSummary, requestRefresh } from './ext/summary-store.js';
import { chatNodes } from './ui/chat.js';
import { answerButtons, answerStatus } from './ui/answer.js';

const LIMIT = 120;
const POLL_MS = 5000;
const LIVE_POLL_MS = 15000;
const ANSWER_SHOWN_MS = 8000;

let target = null;          // { host, id, name, engine }
let summaryEntry = null;
let board = null;           // normalizeBoard(native.board), null on a daemon without it
let tstate = null;          // transcript state (sessions)
let mgr = managerInit();    // the manager conversation (target manager)
let gen = 0;                // bumped on every target switch
let loading = false;
let pending = false;
let conn = 'polling';       // 'live' | 'polling'
let legacy = false;
let reply = replyState(null, { type: 'edit' });
let loadError = null;       // { message, options, gone }
let answer = null;          // { pressing?, message?, error?, hash?, at } for the target
let answersSupported = true;
let sse = null;
let debounce = null;
let origin = null;
let followed = null;        // id the daemon streams turns for
let lastPoll = 0;
let lastBoard = 0;          // when the board was last read or pushed
let boardFailedAt = 0;      // when reading it last failed
let myActor = 'chrome';
const chatState = { open: new Set(), full: new Set(), onToggle: () => renderLog(false) };

const same = (a, b) => a && b && a.host === b.host && a.id === b.id;
const isManager = (t) => t?.id === MANAGER_ID;
const keyOf = (s) => `${s.host}\u0000${s.id}`;

// Static layout: the compose box is never rebuilt, so typed text survives everything.
const select = h('select', { id: 'picker', onchange: onPick });
const connEl = h('span', { class: 'conn' });
const refreshBtn = h('button', { type: 'button', onclick: () => refresh(true) }, 'Refresh');
const openBtn = h('button', { type: 'button', onclick: openWeb }, 'Open in Drover');
const header = h('header', { class: 'sp-head' },
  h('div', { class: 'sp-pick' }, h('label', { for: 'picker' }, 'Session'), select),
  h('div', { class: 'sp-actions' }, refreshBtn, openBtn, h('span', { class: 'spacer' }), connEl));
const notice = h('div', { class: 'sp-notice', hidden: true });
const log = h('div', { class: 'log', role: 'log', 'aria-live': 'polite', 'aria-label': 'Transcript' });
const card = h('div', { class: 'answer-card', hidden: true, role: 'region', 'aria-label': 'Answer the dialog' });
const input = h('textarea', { id: 'msg', rows: '3', placeholder: 'Message', oninput: onEdit, onkeydown: onKey });
const sendBtn = h('button', { type: 'button', class: 'primary', onclick: send }, 'Send');
const status = h('span', { class: 'compose-status', role: 'status', 'aria-live': 'polite' });
const composeLabel = h('label', { for: 'msg' }, 'Message');
const compose = h('form', { class: 'compose', onsubmit: (e) => e.preventDefault() },
  composeLabel, input, h('div', { class: 'compose-row' }, status, sendBtn));
render(document.getElementById('app'), header, notice, log, card, compose);

function openOptions() { chrome.runtime.openOptionsPage(); }

async function getOrigin() {
  if (origin) return origin;
  try { origin = (await getClient()).client.origin; } catch { /* null */ }
  return origin;
}
async function openWeb() {
  const o = await getOrigin();
  if (!o) return openOptions();
  if (isManager(target)) chrome.tabs.create({ url: managerUrl(o) });
  else if (target) chrome.tabs.create({ url: sessionUrl(o, target) });
}

// ---- what is on the board ----

/** The manager entry: known from the board, else from the summary; null when this daemon has no manager. */
function managerEntry() {
  const m = board?.manager ?? summaryEntry?.data?.manager ?? null;
  if (!m) return null;
  return { host: m.host || 'local', id: MANAGER_ID, name: 'Manager', engine: 'openclaw', up: Boolean(m.up), state: 'manager' };
}

/** Waiting, then working, then recent idle sessions: from the board when there is one, else the summary. */
function sessionList() {
  if (board) {
    const lanes = { wait: [], work: [], idle: [] };
    for (const s of board.strips) if (s.id !== MANAGER_ID && s.kind === 'session') lanes[s.lane].push({ ...s, state: s.lane === 'wait' ? 'waiting' : s.lane === 'work' ? 'working' : 'idle' });
    return [...lanes.wait, ...lanes.work, ...lanes.idle.slice(0, 20)];
  }
  return targetSessions(summaryEntry?.data);
}

/** The board's (or summary's) view of the target: lane, dialog fields. */
function targetStrip() {
  if (!target || isManager(target)) return null;
  const s = board?.strips.find((x) => x.id === target.id && x.host === target.host);
  if (s) return s;
  const w = summaryEntry?.data?.waiting?.find((x) => x.id === target.id && x.host === target.host);
  if (w) return { ...w, lane: 'wait' };
  const k = summaryEntry?.data?.working?.find((x) => x.id === target.id && x.host === target.host);
  return k ? { ...k, lane: 'work' } : null;
}

// ---- picker ----
function renderPicker() {
  const m = managerEntry();
  const list = sessionList();
  const label = (s) => `${s.state === 'waiting' ? 'Waiting: ' : s.state === 'idle' ? 'Idle: ' : ''}${s.name} · ${s.host}`;
  const opts = list.map((s) => ({ s, label: label(s) }));
  if (target && !isManager(target) && !list.some((s) => same(s, target))) opts.unshift({ s: target, label: `${target.name || target.id.slice(0, 8)} · ${target.host}` });
  if (m || isManager(target)) opts.unshift({ s: m ?? { ...target, name: 'Manager' }, label: `Manager${m && !m.up ? ' (not running)' : ''}${m?.host && m.host !== 'local' ? ` · ${m.host}` : ''}` });
  render(select, !opts.length ? h('option', { value: '' }, 'No sessions') : opts.map(({ s, label: l }) => h('option', { value: isManager(s) ? 'manager' : keyOf(s), selected: target && (isManager(s) ? isManager(target) : same(s, target)) }, l)));
  select.disabled = !opts.length;
  select._map = new Map(opts.map(({ s }) => [isManager(s) ? 'manager' : keyOf(s), s]));
}
function onPick() {
  const s = select._map?.get(select.value);
  if (!s) return;
  if (isManager(s) ? !isManager(target) : !same(s, target)) setTarget({ host: s.host, id: s.id, name: isManager(s) ? 'manager' : s.name ?? '', engine: s.engine ?? '' }, true);
}

// ---- target ----
function setTarget(t, persist) {
  gen++;
  target = t;
  tstate = null;
  mgr = managerInit();
  loadError = null;
  loading = false;
  pending = false;
  answer = null;
  chatState.open.clear();
  chatState.full.clear();
  reply = replyState(null, { type: 'edit' });
  if (persist) chrome.storage.session.set({ [SESSION.PANEL_TARGET]: t });
  composeLabel.textContent = isManager(t) ? 'Ask the manager' : 'Message';
  input.placeholder = isManager(t) ? 'Ask the manager' : 'Message';
  renderPicker();
  renderNotice();
  renderLog(true);
  renderCard();
  renderStatus();
  followTarget();
  if (t) refresh(false);
}

function pickDefault() {
  // What waits comes first; with nothing waiting, the manager.
  const list = sessionList();
  const w = list.find((s) => s.state === 'waiting');
  if (w) return { host: w.host, id: w.id, name: w.name, engine: w.engine };
  const m = managerEntry();
  if (m) return { host: m.host, id: MANAGER_ID, name: 'manager', engine: 'openclaw' };
  const s = list[0];
  return s ? { host: s.host, id: s.id, name: s.name, engine: s.engine } : null;
}

/** Local Claude sessions: ask the daemon to stream new turns (SSE `turn`), and stop for the previous target. */
async function followTarget() {
  const want = target && !isManager(target) && target.host === 'local' && conn === 'live' ? target.id : null;
  if (want === followed) return;
  try {
    const { client } = await getClient();
    if (followed) client.follow(followed, false);
    followed = want;
    if (want) client.follow(want, true);
  } catch { followed = null; }
}

// ---- transcript ----
async function refresh(manual) {
  if (!target) return;
  if (loading) { pending = true; return; }
  loading = true;
  lastPoll = Date.now();
  const myGen = gen;
  const t = target;
  const since = !isManager(t) && canIncrement(tstate) ? tstate.offset : undefined;
  try {
    const { client } = await getClient();
    origin = client.origin;
    if (isManager(t)) {
      const res = await client.op('sessions.transcript', { id: MANAGER_ID, limit: LIMIT, ...(t.host && t.host !== 'local' ? { host: t.host } : {}) });
      if (myGen !== gen) return;
      mgr = managerReduce(mgr, { type: 'transcript', res });
      loadError = null;
      renderLog(false);
    } else {
      const args = { host: t.host, id: t.id, limit: LIMIT };
      if (since) args.since = since;
      const res = await client.op('sessions.transcript', args);
      if (myGen !== gen) return;
      const before = tstate;
      tstate = mergeTranscript(tstate, res, { since });
      loadError = null;
      if (!before || tstate.changed) renderLog(!before);
    }
    renderNotice();
  } catch (e) {
    if (myGen !== gen) return;
    const msg = String(e?.message ?? 'Could not load the transcript.');
    loadError = { message: msg, options: needsOptions(e), gone: /not found/i.test(msg) };
    renderNotice();
    renderLog(false);
  } finally {
    if (myGen === gen) {
      loading = false;
      if (pending) { pending = false; refresh(false); }
    }
  }
  if (manual) { requestRefresh(); loadBoard(); }
}

function scheduleRefresh() {
  clearTimeout(debounce);
  debounce = setTimeout(() => refresh(false), 400);
}

/** A live turn for the target: shown at once, deduped by its id against what the next read brings. */
function applyTurn(turn) {
  if (!tstate) { scheduleRefresh(); return; }
  const fresh = normalizeTurns([turn]);
  if (!fresh.length) return;
  tstate = { ...tstate, turns: dedupeTurns([...tstate.turns, ...fresh]).slice(-MAX_TURNS) };
  renderLog(false);
  // The read keeps the byte offset in step; it brings back what was just shown, deduped.
  scheduleRefresh();
}

function renderNotice() {
  if (!loadError) { notice.hidden = true; clear(notice); return; }
  notice.hidden = false;
  notice.className = 'notice error sp-notice';
  notice.setAttribute('role', 'alert');
  render(notice, loadError.gone ? 'This session is no longer live.' : loadError.message,
    loadError.options ? h('div', { class: 'notice-actions' }, h('button', { type: 'button', onclick: openOptions }, 'Open options')) : null);
}

/** The manager conversation as transcript turns for the chat rule. */
function managerTurns() {
  return mgr.turns.map((t) => ({ role: t.role, text: t.text, ts: t.ts, uuid: t.key, actor: t.actor, local: t.local, pending: t.pending || t.streaming, error: t.error ?? null, calls: [], tools: [] }));
}

function renderLog(forceBottom) {
  const near = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  if (!target) { render(log, h('p', { class: 'log-empty' }, 'No session selected. Pick one from the list, or open it from the popup.')); return; }
  let items;
  if (isManager(target)) {
    const busy = managerBusy(mgr);
    const streamingText = mgr.turns.some((t) => t.role === 'assistant' && (t.pending || t.streaming) && t.text);
    items = chatItems(managerTurns(), { working: busy && !streamingText, me: myActor, owner: summaryEntry?.data?.owner });
    if (!mgr.turns.length) { render(log, h('p', { class: 'log-empty' }, loadError ? '' : 'Ask the manager anything about the fleet.')); return; }
  } else {
    const turns = tstate?.turns ?? [];
    if (!turns.length) { render(log, h('p', { class: 'log-empty' }, tstate ? 'No messages yet.' : (loadError ? '' : 'Loading'))); return; }
    const strip = targetStrip();
    items = chatItems(turns, { working: strip?.lane === 'work' || strip?.status === 'busy', me: myActor, owner: summaryEntry?.data?.owner });
  }
  render(log, chatNodes(items, chatState));
  if (forceBottom || near) log.scrollTop = log.scrollHeight;
}

// ---- answer card ----
function answerState() {
  if (!answer) return null;
  if (answer.pressing) return answer;
  return Date.now() - answer.at < ANSWER_SHOWN_MS ? answer : null;
}

function renderCard() {
  const strip = targetStrip();
  const plan = strip ? answerPlan(strip, { supported: answersSupported }) : { mode: 'none', buttons: [] };
  const st = answerState();
  const awaiting = st && !st.pressing && !st.error && st.hash && st.hash === strip?.hash;
  if (plan.mode !== 'keys' && !st) { card.hidden = true; clear(card); return; }
  card.hidden = false;
  render(card,
    h('div', { class: 'card-q' }, h('span', { class: 'dot waiting', 'aria-hidden': 'true' }), plan.question || strip?.headline || 'A dialog is open'),
    plan.mode === 'keys' && !awaiting ? answerButtons(plan, { busy: st?.pressing ?? null, onPress: (k) => press(strip, k) }) : null,
    answerStatus(st));
}

async function press(strip, key) {
  if (!strip || answer?.pressing) return;
  const myGen = gen;
  answer = { pressing: key, at: Date.now() };
  renderCard();
  try {
    const { client, settings } = await getClient();
    const out = await pressKey(client, strip, key, { actor: settings.actor });
    if (myGen !== gen) return;
    if (out.unsupported) answersSupported = false;
    answer = { message: out.message, error: !out.ok, hash: out.ok ? strip.hash ?? null : null, at: Date.now() };
    // A refusal: read the screen as it is now. Sent: without the stream nothing pushes the next screen, so read
    // it shortly instead of waiting for the poll.
    if (!out.ok) loadBoard();
    else if (conn !== 'live') setTimeout(() => { if (myGen === gen) loadBoard(); }, 1500);
  } catch (e) {
    if (myGen !== gen) return;
    answer = { message: e?.message || 'Could not send.', error: true, at: Date.now() };
  }
  renderCard();
  setTimeout(() => { if (myGen === gen) renderCard(); }, ANSWER_SHOWN_MS + 50);
  scheduleRefresh();
}

// ---- compose ----
function renderStatus() {
  status.textContent = reply.message;
  status.className = `compose-status ${reply.phase === 'error' ? 'err' : reply.phase === 'sent' || reply.phase === 'queued' ? 'ok' : ''}`;
  sendBtn.disabled = reply.phase === 'sending' || !target;
}
function onEdit() { reply = replyState(reply, { type: 'edit' }); renderStatus(); }
function onKey(e) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
}
async function send() {
  const text = input.value.trim();
  if (!text || !target || reply.phase === 'sending') return;
  const myGen = gen;
  const t = target;
  reply = replyState(reply, { type: 'send' });
  renderStatus();
  if (isManager(t)) {
    input.value = '';
    mgr = managerReduce(mgr, { type: 'send', text });
    renderLog(true);
  }
  try {
    const { client, settings } = await getClient();
    const host = t.host && t.host !== 'local' ? { host: t.host } : {};
    const res = isManager(t)
      ? await client.op('sessions.message', { id: MANAGER_ID, text, wait: false, actor: settings.actor, ...host }, { timeoutMs: 600_000 })
      : await client.op('sessions.message', { host: t.host, id: t.id, text, actor: settings.actor });
    if (myGen !== gen) return;
    if (isManager(t)) {
      mgr = managerReduce(mgr, { type: 'sent', res });
      reply = replyState(reply, { type: 'ok', queued: false });
      renderLog(false);
      if (managerBusy(mgr)) startCatchUp(myGen);
    } else {
      if (input.value.trim() === text) input.value = '';
      reply = replyState(reply, { type: 'ok', queued: Boolean(res?.queuedBehindTurn) });
      refresh(false);
      setTimeout(() => { if (myGen === gen) refresh(false); }, 2000);
    }
    renderStatus();
  } catch (e) {
    if (myGen !== gen) return;
    if (isManager(t)) {
      mgr = managerReduce(mgr, { type: 'fail', message: e?.message });
      // The text comes back to the box, to send again.
      if (!input.value.trim()) input.value = text;
      renderLog(false);
    }
    reply = replyState(reply, { type: 'fail', message: e?.message || 'Could not send.' });
    renderStatus();
  }
}

/** A manager reply the stream is not delivering: read the conversation until it settles. */
let catchUp = null;
let lastMgrEvent = 0;
function startCatchUp(myGen) {
  if (catchUp) return;
  const started = Date.now();
  catchUp = setInterval(() => {
    if (myGen !== gen || !managerBusy(mgr) || Date.now() - started > 900_000) { clearInterval(catchUp); catchUp = null; return; }
    if (conn === 'live' && Date.now() - lastMgrEvent < 4000) return;
    refresh(false);
  }, 2000);
}

// ---- drafts ----
async function applyDraft(d) {
  if (!d || typeof d.text !== 'string') return;
  // A draft names the session the user picked in the context menu: switch to it.
  // An empty id ("Choose in side panel") keeps the current target for the user to change.
  if (d.id) {
    const t = { host: d.host || 'local', id: d.id, name: d.name ?? '', engine: d.engine ?? '' };
    if (!same(t, target)) setTarget(t, true);
  }
  input.value = d.text;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  onEdit();
  await chrome.storage.session.remove(SESSION.DRAFT);
}

// ---- live connection ----
function renderConn() {
  render(connEl, h('span', { class: `dot ${conn === 'live' ? 'idle' : ''}`, 'aria-hidden': 'true' }), conn === 'live' ? 'Live' : 'Polling');
}

async function loadBoard() {
  try {
    const { client } = await getClient();
    board = normalizeBoard(await client.op('native.board'));
    lastBoard = Date.now();
  } catch (e) {
    if (isUnknownOp(e, 'native.board')) board = null;
    else boardFailedAt = Date.now();
  }
  renderPicker();
  renderCard();
}

function onStreamEvent(name, data) {
  const r = routeEvent(name, data, PANEL_TOPICS);
  switch (r.kind) {
    case 'hello': legacy = !honoursTopics(r.data); break;
    case 'board':
      board = normalizeBoard(r.data);
      lastBoard = Date.now();
      renderPicker();
      renderCard();
      if (!target) { const t = pickDefault(); if (t) setTarget(t, false); }
      break;
    case 'manager':
      lastMgrEvent = Date.now();
      if (isManager(target)) { mgr = managerReduce(mgr, { type: 'stream', data: r.data }); renderLog(false); }
      break;
    case 'turn':
      if (r.data.id === MANAGER_ID) {
        lastMgrEvent = Date.now();
        if (isManager(target)) { mgr = managerReduce(mgr, { type: 'turn', data: r.data }); renderLog(false); }
      } else if (target && !isManager(target) && r.data.id === target.id) applyTurn(r.data.turn);
      break;
    case 'legacy':
      if (legacy && target && (name === 'snapshot' || (name === 'mutation' && data?.op === 'sessions.message'))) scheduleRefresh();
      break;
    default: break;
  }
}

async function startStream() {
  sse?.close();
  sse = null;
  try {
    const [{ connectStream }, { client }] = await Promise.all([import('./lib/sse.js'), getClient()]);
    sse = connectStream({
      request: client.streamRequest({ topics: PANEL_TOPICS }),
      fetch: globalThis.fetch.bind(globalThis),
      onEvent: onStreamEvent,
      onState: (state) => {
        const was = conn;
        conn = state === 'open' ? 'live' : 'polling';
        renderConn();
        if (was !== conn) { followTarget(); if (conn === 'live') loadBoard(); }
      },
    });
  } catch { conn = 'polling'; renderConn(); }
}

// ---- boot ----
function queryTarget() {
  const q = new URLSearchParams(location.search);
  const id = q.get('id');
  return id ? { host: q.get('host') || 'local', id, name: q.get('name') ?? '', engine: q.get('engine') ?? '' } : null;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[LOCAL.SETTINGS]) {
    // New server or token: drop the cached origin and reconnect the stream with the new client.
    origin = null;
    followed = null;
    conn = 'polling';
    renderConn();
    startStream();
    loadBoard();
    refresh(false);
    return;
  }
  if (area !== 'session') return;
  const pt = changes[SESSION.PANEL_TARGET]?.newValue;
  if (pt && pt.id && !same(pt, target)) setTarget({ host: pt.host || 'local', id: pt.id, name: pt.name ?? '', engine: pt.engine ?? '' }, false);
  const d = changes[SESSION.DRAFT]?.newValue;
  if (d) applyDraft(d);
});

onSummary((e) => {
  summaryEntry = e;
  renderPicker();
  renderCard();
  if (!target) { const t = pickDefault(); if (t) setTarget(t, false); }
});

document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(false); });
window.addEventListener('pagehide', () => { if (followed) getClient().then(({ client }) => client.follow(followed, false)).catch(() => {}); });
// Fewer reads while turns stream in. Without the stream (Safari without the origin allowed, a dropped connection)
// the board is read again too, or new waiting sessions and fresh keys and hashes would never show. The card's
// outcome line expires on the same tick.
setInterval(() => {
  if (document.hidden) return;
  const now = Date.now();
  const p = panelPoll({ now, live: conn === 'live', streaming: Boolean(followed || isManager(target)), lastTranscript: lastPoll, lastBoard, boardFailedAt, every: POLL_MS, liveEvery: LIVE_POLL_MS });
  if (p.transcript) refresh(false);
  if (p.dropBoard) { board = null; renderPicker(); renderCard(); }
  else if (p.board) loadBoard();
  if (answer && !answer.pressing && now - answer.at >= ANSWER_SHOWN_MS) { answer = null; renderCard(); }
}, POLL_MS);

renderConn();
renderStatus();
getClient().then(({ settings }) => { myActor = settings.actor; }).catch(() => {});
summaryEntry = await readSummary();
const stored = (await chrome.storage.session.get([SESSION.PANEL_TARGET, SESSION.DRAFT]));
await loadBoard();
const initial = queryTarget() ?? stored[SESSION.PANEL_TARGET] ?? pickDefault();
renderPicker();
if (initial?.id) setTarget({ host: initial.host || 'local', id: initial.id, name: initial.name ?? '', engine: initial.engine ?? '' }, false);
else renderLog(false);
await applyDraft(stored[SESSION.DRAFT]);
startStream();
requestRefresh();
