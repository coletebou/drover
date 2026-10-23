// The manager conversation as one component, mounted wherever the manager shows: the board's dock, the popup
// (m, or the header button), the Manager view, a floating window. Every mount reads the same store
// (manager-model.js), so the thread, the draft and a reply in flight are the same in all of them.
import { h, clear, fmtTime, plural } from './dom.js';
import { ChatView, atBottom } from './chat.js';
import { chatItems } from './chat-model.js';
import { MAIN, THREAD_RE } from './manager-model.js';

const LAST_SEEN_KEY = 'drover.lastSeen';
/** "since I last looked": when this browser last hid Drover (app.js records it), as words. */
function lastLookedAt() {
  const t = Number(localStorage.getItem(LAST_SEEN_KEY) || 0);
  if (!t || Date.now() - t < 60_000) return null;
  const d = new Date(t); const today = d.toDateString() === new Date().toDateString();
  return today ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}
export const QUICK = [
  { label: 'Who is waiting on me?', text: () => 'Who is waiting on me?' },
  { label: 'What finished since I last looked?', text: () => { const at = lastLookedAt(); return `What finished since I last looked${at ? ` (at ${at})` : ''}?`; } },
  { label: 'Sweep now', sweep: true, title: 'Ask the manager to sweep the fleet now (openclaw.sweep)' },
  { label: 'Status of every machine', text: () => 'Status of every machine?' },
];
const STATE_LABEL = { busy: 'answering', up: 'up', down: 'down', unknown: 'connecting' };
const STATE_DOT = { busy: 'busy pulse', up: 'idle', down: 'dead', unknown: '' };

/**
 * Mount the manager into root. variant: 'dock' | 'popup' | 'view' | 'pip' | 'solo'.
 * Options: onClose (popup), onPopOut, onCollapse (dock), autofocus.
 * Returns { el, focus(), destroy(), refresh() }.
 */
export function mountManagerChat(root, ctx, { store, variant = 'dock', onClose, onPopOut, onCollapse, autofocus = false } = {}) {
  let alive = true; let histIdx = -1;
  const chat = new ChatView({ assistantLabel: 'manager', onRetry: (t) => send(t.text) });
  const stateEl = h('span', { class: 'mark mgr-state' });
  const hostEl = h('span', { class: 'muted small mgr-host' });
  const costEl = h('span', { class: 'muted small mgr-cost' });
  const threadBox = h('span', { class: 'mgr-thread' });
  const body = h('div', { class: 'mgr-body' }, chat.el);
  const ta = h('textarea', { rows: 1, 'aria-label': 'Message the manager', placeholder: 'Ask the manager', title: 'Enter sends, Shift+Enter adds a line, ↑ brings back an earlier question', spellcheck: 'true' });
  const sendBtn = h('button', { class: 'btn sm primary', type: 'submit' }, 'Send');
  const quick = h('div', { class: 'mgr-quick', role: 'group', 'aria-label': 'Quick questions' },
    QUICK.map((q) => h('button', { class: 'chip', type: 'button', title: q.title ?? `Ask: ${q.label}`, onclick: () => (q.sweep ? sweep() : send(q.text(), { quick: true })) }, q.label)));
  const form = h('form', { class: 'mgr-compose', onsubmit: (e) => { e.preventDefault(); send(ta.value); } }, ta, sendBtn);
  const actions = h('div', { class: 'mgr-actions' },
    threadBox, costEl,
    onPopOut ? h('button', { class: 'btn sm quiet mgr-pop', type: 'button', title: 'Float the manager above every app', onclick: () => onPopOut() }, 'Pop out') : null,
    variant !== 'view' && variant !== 'solo' && variant !== 'pip' ? h('button', { class: 'btn sm quiet', type: 'button', title: 'The manager console: status, automations, what it wrote', onclick: () => ctx.nav('manager') }, 'Console') : null,
    onCollapse ? h('button', { class: 'btn sm quiet mgr-collapse', type: 'button', 'aria-label': 'Collapse the manager', title: 'Collapse', onclick: () => onCollapse() }, 'Hide') : null,
    onClose ? h('button', { class: 'btn sm quiet', type: 'button', title: 'Close (Esc). The draft stays.', onclick: () => onClose() }, 'Close', h('kbd', null, 'esc')) : null);
  const head = h('header', { class: 'mgr-head' }, h('div', { class: 'mgr-title' }, h('span', { class: 'engine openclaw', title: 'OpenClaw fleet manager' }, 'OC'), h('h2', null, 'Manager'), stateEl, hostEl), actions);
  const el = h('section', { class: `mgr mgr-${variant}`, 'aria-label': 'Manager' }, head, body, quick, form);
  root.append(el);

  // ------------------------------------------------------------ render
  function paintState() {
    const s = store.state();
    clear(stateEl); stateEl.append(h('span', { class: `dot ${STATE_DOT[s]}`, 'aria-hidden': 'true' }), STATE_LABEL[s]);
    stateEl.title = s === 'down' ? (store.conv().error ?? 'The manager is not answering') : s === 'busy' ? 'A reply is on its way' : '';
    hostEl.textContent = store.host === 'local' ? '' : `on ${store.host}`;
    const c = store.status.cost;
    costEl.textContent = c ? `$${c.usd.toFixed(2)} today` : '';
    costEl.title = c ? `OpenClaw's recorded cost today${c.fresh ? '' : ' (its cost cache is still settling)'}; there is no spend cap` : '';
  }
  function paintThreads() {
    clear(threadBox);
    const list = store.threads;
    if (!list && store.thread === MAIN) return;   // an older daemon has one conversation
    const names = [...new Set([MAIN, ...(list ?? []).map((t) => t.thread), store.thread])];
    const busyIn = (n) => list?.find((t) => t.thread === n)?.busy;
    const sel = h('select', { class: 'mgr-thread-sel', 'aria-label': 'Conversation thread', title: 'Each thread is its own conversation with the manager', onchange: () => { if (sel.value === '\u0000new') { newThread(); return; } store.setThread(sel.value); } },
      names.map((n) => h('option', { value: n, selected: n === store.thread ? true : null }, `${n}${busyIn(n) && n !== store.thread ? ' (answering)' : ''}`)),
      h('option', { value: '\u0000new' }, 'New thread…'));
    threadBox.append(sel);
  }
  function newThread() {
    clear(threadBox);
    const input = h('input', { type: 'text', class: 'mgr-thread-new', placeholder: 'thread name', 'aria-label': 'New thread name', maxlength: 64, size: 14, spellcheck: 'false' });
    const done = (ok) => { if (ok) { const v = input.value.trim(); if (!THREAD_RE.test(v)) { ctx.toast('A thread name is 1 to 64 letters, digits, or . _ : @ % -', 'error'); input.focus(); return; } store.setThread(v); } paintThreads(); if (ok) ta.focus(); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); done(true); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); } });
    input.addEventListener('blur', () => setTimeout(() => { if (input.isConnected) done(false); }, 150));
    threadBox.append(input); input.focus();
  }
  function emptyNode() {
    const c = store.conv();
    if (c.loading && !c.turns.length) return h('div', { class: 'pending' }, 'Reading the conversation…');
    if (c.error) return h('div', { class: 'empty mgr-empty' }, h('b', null, c.error), store.host === 'local' ? 'Pick the manager\'s host in the Manager console.' : '');
    return h('div', { class: 'empty mgr-empty' }, h('b', null, store.thread === MAIN ? 'Ask the manager about the fleet' : `Thread ${store.thread}`), 'It sees every session on every machine and answers here. Try a question below; Enter sends, Shift+Enter adds a line.');
  }
  let lastRenderMs = 0;
  function paintTurns() {
    const t0 = performance.now();
    const stick = atBottom(body);
    chat.update(chatItems(store.turns()), { working: store.busy() && !store.turns().some((t) => t.pending), workingText: 'the manager is thinking', empty: emptyNode() });
    if (stick) body.scrollTop = body.scrollHeight;
    lastRenderMs = performance.now() - t0;
    ctx.perf?.('manager.render', lastRenderMs);
  }
  /** A thread or host switch shows that conversation's draft even in a focused composer (the old one is saved). */
  function paintAll({ switched = false } = {}) { paintState(); paintThreads(); paintTurns(); syncDraft({ force: switched }); }

  // ------------------------------------------------------------ composer
  // border-box: the height that fits the text is its scrollHeight plus the borders (else a scrollbar shows).
  function grow() { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight + ta.offsetHeight - ta.clientHeight, variant === 'dock' ? 160 : 240)}px`; }
  // Typing here: this composer has focus in a window that has focus (a floating window keeps its own activeElement).
  const typing = () => ta.ownerDocument.activeElement === ta && ta.ownerDocument.hasFocus();
  function syncDraft({ force = false } = {}) { if (force || !typing()) { if (ta.value !== store.draft()) { ta.value = store.draft(); grow(); } } }
  // The draft is the store's: the dock, the popup and a floating window show the same one (setDraft tells the others).
  ta.addEventListener('input', () => { store.setDraft(store.thread, ta.value); histIdx = -1; grow(); });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(ta.value); }
    else if (e.key === 'ArrowUp' && (!ta.value || histIdx >= 0) && ta.selectionStart === 0) { if (!store.history.length) return; e.preventDefault(); histIdx = Math.min(store.history.length - 1, histIdx + 1); ta.value = store.history[histIdx] ?? ''; grow(); }
    else if (e.key === 'ArrowDown' && histIdx >= 0) { e.preventDefault(); histIdx = Math.max(-1, histIdx - 1); ta.value = histIdx < 0 ? '' : store.history[histIdx] ?? ''; grow(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (onClose) onClose(); else ta.blur(); }
  });
  /** A quick prompt is sent as it is: what the owner was typing stays in the box. */
  async function send(text, { quick = false } = {}) {
    const v = String(text ?? '');
    if (!v.trim()) return;
    if (!quick) { ta.value = ''; grow(); histIdx = -1; }
    try { await store.send(v, { keepDraft: quick }); }
    catch (e) { ctx.toast(`Manager: ${e.message}`, 'error'); }
  }
  async function sweep() {
    try { await store.sweep(); ctx.toast('The manager is sweeping; its notes land in the feed', 'ok', 5000); }
    catch (e) { ctx.toast(`Sweep: ${e.message}`, 'error'); }
  }

  // ------------------------------------------------------------ store
  const off = store.on((what, thread) => {
    if (!alive) return;
    if (what === 'turns') { if (thread === store.thread) { paintTurns(); paintState(); } return; }
    if (what === 'status') { paintState(); return; }
    if (what === 'threads') { if (threadBox.querySelector('input') == null) paintThreads(); return; }
    if (what === 'draft') { if (thread === store.thread) syncDraft(); return; }
    paintAll({ switched: what === 'thread' || what === 'host' });
  });
  paintAll({ switched: true });
  store.ensure();
  if (!store.threads && store.threadsOp !== false) store.refreshThreads();
  store.refreshCost();
  if (autofocus) ta.focus();
  return {
    el,
    focus() { ta.focus(); const n = ta.value.length; ta.setSelectionRange(n, n); },
    refresh() { paintAll(); },
    destroy() { alive = false; off(); el.remove(); },
    get lastRenderMs() { return lastRenderMs; },
  };
}

/** "3 turns · last 14:05" for a thread row (the console's list). */
export function threadLine(t) { return [t.turns != null ? plural(t.turns, 'turn') : null, t.lastTs ? `last ${fmtTime(t.lastTs)}` : null].filter(Boolean).join(' · '); }
