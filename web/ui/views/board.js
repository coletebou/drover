// The board: every agent on every reachable host as a strip in one of three lanes (Waiting on you, Working,
// Idle), and the manager docked beside them (on top on narrow screens, a slim bar when hidden). Strips come from
// the daemon's compact board (native.board and `board` events) when it has one, else from the fleet summary;
// they are rendered by key, so an update rebuilds only the strips that changed. A waiting strip with a dialog
// answers it in place (its keys, sent only to the dialog it shows); a Grok bot's approval request is answered in
// place too (one button per option). Click a strip for the drawer; j/k move, Enter opens, m talks to the manager.
import { h, clear, engine, ago, dot, empty, loading, fmtTime, plural } from '../dom.js';
import { mountManagerChat } from '../manager-chat.js';
import { answerModel, pressKey, pressedLabel, pressApproval, oneTap, approvalToast } from '../answer-model.js';
import { mdText } from '../markdown.js';
import { receiptText, approvalText } from '../chat-model.js';

const LANES = [
  { id: 'wait', title: 'Waiting on you', hint: 'a dialog is open or the agent stopped and asked', none: 'Nothing needs you.' },
  { id: 'work', title: 'Working', hint: 'busy right now', none: 'No one is working.' },
  { id: 'idle', title: 'Idle', hint: 'finished, at the prompt', none: 'Nothing idle.' },
];
const DOCK_KEY = 'drover.dock';   // { wide: 'open'|'closed', narrow: ... }: the dock's state per layout, as the owner left it
const ms = (v) => (v == null ? 0 : typeof v === 'number' ? (v < 1e11 ? v * 1000 : v) : Date.parse(v) || 0);

/** What a strip shows, as one string: an unchanged signature keeps its element. */
function stripSig(s) {
  return JSON.stringify([s.lane, s.faded, s.name, s.engine, s.status, ms(s.since), s.host, s.tmux, s.windowName, s.ask?.label, s.ask?.text, s.finished?.ts, s.tail, s.hash, s.keys, s.dialog?.options?.map((o) => [o.n, o.label, o.selected]), s.unread, s.approval?.id, s.moreApprovals]);
}

/** One line of the board's recent-events feed. */
export function feedLine(e) {
  switch (e.type) {
    case 'message': return `${e.actor} → ${e.to?.name ?? e.to?.id}: ${e.text}`;
    case 'chat': return `${e.from}: ${e.error ? `did not answer: ${e.error}` : e.text}`;
    case 'notify': return [e.category, e.name ?? e.sessionName, e.title ?? e.message].filter(Boolean).join(': ');
    case 'op': return `${e.op}${e.target && e.target !== 'local' ? ` on ${e.target}` : ''}${e.ok === false ? ` failed${e.error ? `: ${e.error}` : ''}` : ''}`;
    case 'launch': return `${e.engine} ${e.mode} ${e.profile} ${e.result?.tmux ?? ''}`;
    case 'feature': return `${e.fid} ${e.state ?? ''} ${e.title ?? ''}`;
    case 'note': return `${e.about}: ${e.text}`;
    case 'status': return `${e.name ?? e.agent} ${e.state}${e.summary ? `: ${e.summary}` : ''}`;
    case 'receipt': return receiptText(e);
    case 'approval': return approvalText(e);
    case 'survey': return `${e.count} items from ${e.file?.split('/').pop()}`;
    case 'survey-item': return e.item?.title ?? e.item?.id ?? '';
    case 'pin': case 'unpin': return e.target;
    case 'handoff': return e.path;
    default: return JSON.stringify(e).slice(0, 120);
  }
}

export default {
  id: 'board', label: 'Board', key: 'b',
  mount(root, ctx) {
    let alive = true; let q = ''; let selected = null; let firstPaint = true; const known = new Set();
    const nodes = { wait: new Map(), work: new Map(), idle: new Map() };
    const busy = new Set();   // strips with a key press on its way
    // A press that went through: the strip's dialog is the one answered until the board shows its screen moved on
    // (another hash, or no dialog), so its buttons stay off rather than offer the answered dialog again.
    const sent = new Map();   // strip key -> { hash, at }
    const SENT_MS = 6000;
    // The answered dialog is known by its hash, or by its words: the daemon can read the copy tmux keeps in the
    // scrollback as a dialog still on screen (with another hash), and that copy is not one to answer.
    const dialogWords = (s) => JSON.stringify([s.dialog?.question ?? s.ask?.text ?? null, (s.dialog?.options ?? []).map((o) => o.label)]);
    // An approval request answered from here is Sent while the board still shows that request (it goes on the next read).
    const sentFor = (s) => { const x = sent.get(s.key); return Boolean(x && Date.now() - x.at < SENT_MS && (x.approval ? x.approval === s.approval?.id : (x.hash && x.hash === s.hash) || x.words === dialogWords(s))); };
    const meta = h('span', { class: 'muted small', id: 'board-meta' }, 'loading');
    const head = h('div', { class: 'view-head' }, h('h1', null, 'Board'), meta, h('span', { class: 'spacer' }), h('span', { class: 'muted small board-keys' }, 'j k move, enter open, m manager'));
    const lanesEl = h('div', { class: 'board' });
    const foot = h('div', { class: 'board-foot' });
    const dockEl = h('aside', { class: 'mgr-dock', 'aria-label': 'Manager' });
    const wrap = h('div', { class: 'board-wrap' }, h('div', { class: 'board-main' }, head, lanesEl, foot), dockEl);
    root.append(wrap);
    const laneEls = {};
    for (const l of LANES) {
      const list = h('div', { class: 'lane-list' });
      const count = h('span', { class: 'count' });
      const none = h('div', { class: 'lane-empty' }, l.none);
      laneEls[l.id] = { list, count, none };
      lanesEl.append(h('section', { class: `lane lane-${l.id}`, 'aria-label': l.title }, h('div', { class: 'lane-head' }, h('h2', null, l.title), count, h('span', { class: 'hint' }, l.hint)), list));
    }
    lanesEl.append(loading('Reading the fleet'));

    // ------------------------------------------------------------ strips
    // The manager has its own place here (the dock), not a strip in a lane.
    function visible() { const all = ctx.strips().filter((s) => s.engine !== 'openclaw'); return q ? all.filter((s) => JSON.stringify(s).toLowerCase().includes(q.toLowerCase())) : all; }
    let lastMeta = null;
    function render(m) {
      if (!alive) return;
      if (m) lastMeta = m;
      const t0 = performance.now();
      const vis = visible();
      if (!vis.length && !ctx.state.board && !ctx.state.fleet && !ctx.state.snapshot) return;   // nothing read yet: keep "Reading the fleet"
      lanesEl.querySelector('.pending')?.remove();
      let built = 0;
      for (const l of LANES) {
        const items = vis.filter((s) => s.lane === l.id).sort((a, b) => ((a.faded ? 1 : 0) - (b.faded ? 1 : 0)) || ms(b.since) - ms(a.since));
        built += reconcile(l.id, items);
      }
      paintMeta(vis);
      ctx.setCount('board', vis.filter((s) => s.lane === 'wait').length || null);
      firstPaint = false;
      ctx.perf?.('board.render', performance.now() - t0);
      ctx.perf?.('board.stripsBuilt', built);
    }
    function reconcile(lane, items) {
      const { list, count, none } = laneEls[lane]; const map = nodes[lane];
      count.textContent = items.length ? String(items.length) : '';
      const keep = new Set(); let prev = null; let built = 0;
      for (const s of items) {
        keep.add(s.key);
        const sig = stripSig(s) + (busy.has(s.key) ? '|busy' : '') + (sentFor(s) ? '|sent' : '');
        let n = map.get(s.key);
        if (!n || n.sig !== sig) { const el = strip(s, !n && !firstPaint && !known.has(s.key)); built++; if (n) n.el.replaceWith(el); n = { el, sig }; map.set(s.key, n); }
        known.add(s.key);
        n.el.setAttribute('aria-selected', selected === s.key ? 'true' : 'false');
        const want = prev ? prev.nextSibling : list.firstChild;
        if (want !== n.el) list.insertBefore(n.el, want);
        prev = n.el;
      }
      for (const [k, n] of map) if (!keep.has(k)) { n.el.remove(); map.delete(k); }
      if (items.length) none.remove(); else if (!none.isConnected) list.append(none);
      return built;
    }
    function paintMeta(vis) {
      const b = ctx.state.board;
      const hosts = b ? b.hosts.map((x) => ({ name: x.ui ?? x.name, ok: x.up !== false, stale: x.stale })) : (ctx.state.fleet?.hosts ?? []).map((x) => ({ name: x.host, ok: x.ok, stale: x.fallback }));
      const down = hosts.filter((x) => !x.ok);
      const when = lastMeta?.fromClient ? 'from this browser, refreshing' : lastMeta?.age > 2000 ? `read ${Math.round(lastMeta.age / 1000)}s ago${lastMeta.refreshing ? ', refreshing' : ''}` : 'live';
      meta.textContent = `${plural(vis.length, 'agent')} on ${plural(hosts.filter((x) => x.ok).length, 'host')}${down.length ? `, ${down.map((x) => x.name + (x.stale ? ' (last inventory)' : '')).join(', ')} unreachable` : ''}, ${when}`;
    }
    function strip(s, isNew) {
      const color = s.lane === 'wait' ? 'amber' : s.lane === 'work' ? 'steel' : s.status === 'dead' ? 'brick' : 'moss';
      // A dialog answered from here shows its question; the pane's footer ("Esc to cancel") is the buttons now.
      const keys = s.lane === 'wait' ? keysRow(s) : null;
      const tail = keys ? [s.ask?.text ?? s.dialog?.question].filter(Boolean) : s.tail;
      const el = h('article', {
        class: `strip ${color}${s.faded ? ' faded' : ''}${isNew && s.lane === 'wait' ? ' new' : ''}${busy.has(s.key) ? ' sending' : ''}`, tabindex: 0, 'data-key': s.key,
        onclick: () => open(s), onkeydown: (e) => { if (e.key === 'Enter' && e.target === el) open(s); },
      },
      h('div', { class: 'title' }, engine(s.engine), h('span', { class: 'name', title: s.cwd ?? '' }, s.name), s.status === 'busy' || s.lane === 'work' ? dot('busy', { pulse: true }) : null,
        // A Grok bot's replies the owner has not read yet (read receipts): opening its chat reads them.
        s.unread ? h('span', { class: 'unread', title: `${plural(s.unread, 'reply', 'replies')} you have not read; open the chat to read them` }, `${s.unread} unread`) : null),
      h('span', { class: 'age', title: s.since ? new Date(ms(s.since)).toLocaleString() : '' }, s.since ? ago(s.since) : ''),
      h('div', { class: 'where' }, [s.host !== 'local' ? s.host : null, s.tmux, s.windowName && s.windowName !== s.name ? s.windowName : null].filter(Boolean).join('  ')),
      s.ask ? h('div', { class: 'ask-label' }, s.ask.label) : s.finished ? h('div', { class: 'ask-label quiet' }, 'finished') : null,
      // An approval's question is read whole (its buttons answer all of it): never clipped like a pane's tail.
      tail?.length ? h('div', { class: s.answer === 'approval' ? 'tail whole' : 'tail' }, tail.join('\n')) : null,
      keys);
      return el;
    }
    /** A waiting strip's dialog, answered from the board: its own keys, only on the dialog the strip shows. */
    function keysRow(s) {
      const m = answerModel(s);
      if (m?.mode === 'approval') return approvalRow(s, m);
      if (!m || m.mode !== 'keys' || !m.hash) return null;
      if (sentFor(s)) return h('div', { class: 'strip-keys sent', role: 'status' }, h('span', { class: 'muted small' }, 'Sent; waiting for the screen to move on'));
      const row = h('div', { class: 'strip-keys', role: 'group', 'aria-label': `Answer ${s.name}` });
      for (const b of m.buttons) {
        if (b.kind === 'nav') continue;
        row.append(h('button', { class: `btn sm${b.selected ? ' selected' : ''}${b.kind === 'confirm' ? ' primary' : ''}`, type: 'button', disabled: busy.has(s.key) ? true : null, title: b.kind === 'option' ? `Press ${b.key}: ${b.label}` : `Press ${b.key === 'Escape' ? 'Esc' : b.key}${b.hint ? ` (${b.hint})` : ''}`,
          onclick: (e) => { e.stopPropagation(); press(s, m, b.key); } }, b.kind === 'option' ? h('span', { class: 'trunc' }, b.label) : b.label));
      }
      return row;
    }
    /** A bot's approval request, answered from the board: one button per option, sent with the request's id. */
    function approvalRow(s, m) {
      if (sentFor(s)) return h('div', { class: 'strip-keys sent', role: 'status' }, h('span', { class: 'muted small' }, 'Answered; telling the bot'));
      const row = h('div', { class: 'strip-keys approval', role: 'group', 'aria-label': `Answer ${s.name}'s approval request` });
      // Details the strip does not show: they are answered where they are read in full.
      if (!oneTap(m)) { row.append(h('button', { class: 'btn sm', type: 'button', title: 'The request has details: read them on its card, and answer there', onclick: (e) => { e.stopPropagation(); open(s); } }, 'Review and answer')); return row; }
      // Whole labels (they wrap): two options cut to the same words would be one button answering two ways.
      for (const b of m.buttons) row.append(h('button', { class: 'btn sm', type: 'button', disabled: busy.has(s.key) ? true : null, title: `Answer ${b.label}${m.more ? ` (${m.more} more wait after this one)` : ''}`, onclick: (e) => { e.stopPropagation(); answerApproval(s, m, b.n); } }, b.label));
      if (m.more) row.append(h('span', { class: 'muted small' }, `+${m.more} more`));
      return row;
    }
    async function answerApproval(s, m, n) {
      if (busy.has(s.key)) return;
      busy.add(s.key); render();
      try {
        const r = await pressApproval(ctx.answerApproval, m, n);
        const [text, kind] = approvalToast(s.name, r);
        ctx.toast(text, kind, 6000);
        sent.set(s.key, { approval: m.id, at: Date.now() }); setTimeout(() => render(), SENT_MS + 100);
      } catch (e) { ctx.toast(`${s.name}: not answered, ${e.message}`, 'error', 7000); }
      busy.delete(s.key); render();
      refreshSoon(600);
    }
    async function press(s, m, key) {
      if (busy.has(s.key)) return;
      busy.add(s.key); render();
      try {
        const r = await pressKey((op, args, opts) => ctx.callQuiet(op, args, opts), m, key, { verify: true });
        if (r?.refused) ctx.toast(`${s.name}: not sent, ${r.reason}`, 'error', 7000);
        else { ctx.toast(`${s.name}: ${pressedLabel(m, key)}`, 'ok'); sent.set(s.key, { hash: m.hash, words: dialogWords(s), at: Date.now() }); setTimeout(() => render(), SENT_MS + 100); }
      } catch (e) { ctx.toast(`${s.name}: ${e.message}`, 'error'); }
      busy.delete(s.key); render();
      refreshSoon(600);
    }
    function open(s) {
      selected = s.key;
      for (const map of Object.values(nodes)) for (const [k, n] of map) n.el.setAttribute('aria-selected', k === selected ? 'true' : 'false');
      ctx.open({ kind: s.kind, id: s.id, host: s.host, engine: s.engine, name: s.name, tmux: s.tmux, sessionId: s.sessionId });
    }

    // ------------------------------------------------------------ data
    async function load(quiet = false) {
      try {
        if (ctx.state.boardOp !== false) {
          await ctx.swr('native.board', {}, (r, m) => { if (!alive) return; ctx.setBoard?.(r); render(m); }, { host: 'local' });
          return;
        }
        // A daemon without the compact board: the fleet summary, and the Notification-hook asks from the truth file.
        ctx.callQuiet('events.state', {}, { host: 'local' }).then((st) => { ctx.state.notifies = { ...(st?.notifies ?? {}), ...(ctx.state.notifies ?? {}) }; render(); }).catch(() => {});
        await ctx.swr('fleet.summary', {}, (r, m) => { if (!alive || !r?.hosts) return; ctx.setFleet?.(r); render(m); }, { host: 'local' });
      } catch (e) { if (!quiet && !ctx.strips().length) { lanesEl.querySelector('.pending')?.remove(); lanesEl.append(empty('Could not read the fleet', e.message)); } }
    }
    let soon = null;
    function refreshSoon(delay) { clearTimeout(soon); soon = setTimeout(() => load(true), delay); }
    // The foot: recent launches come from the truth file's fold (events.state, megabytes on a busy fleet: read on
    // mount and after a launch only), recent events from its tail (small: read after any change).
    const launchesEl = h('section', { class: 'card' }, h('h3', null, 'Recent launches'));
    const eventsEl = h('section', { class: 'card' }, h('h3', null, 'Recent events'));
    foot.append(launchesEl, eventsEl);
    async function renderLaunches() {
      try {
        const st = await ctx.callQuiet('events.state', {}, { host: 'local' });
        if (!alive) return;
        const L = (st.launches ?? []).slice(0, 8);
        launchesEl.replaceChildren(h('h3', null, 'Recent launches'), ...(L.length ? L.map((l) => h('div', { class: 'row', onclick: () => l.result?.tmux ? ctx.open({ kind: 'window', id: l.result.tmux, host: l.host === ctx.state.frontHost ? 'local' : l.host }) : l.result?.headlessId ? ctx.open({ kind: 'session', id: l.result.headlessId, engine: l.engine }) : null },
          engine(l.engine), h('div', { class: 'main-col' }, h('div', { class: 'l1' }, h('span', { class: 'trunc' }, l.prompt ? l.prompt.slice(0, 90) : `${l.profile} in ${l.cwd}`)), h('div', { class: 'l2' }, [l.mode, l.result?.tmux ?? l.result?.sessionId?.slice(0, 8), l.host].filter(Boolean).join('  '))), ago(l.ts))) : [h('div', { class: 'muted small' }, 'No launches recorded yet.')]));
      } catch { /* quiet */ }
    }
    async function renderEvents() {
      try {
        const E = await ctx.callQuiet('events.tail', { limit: 12 }, { host: 'local' });
        if (!alive) return;
        eventsEl.replaceChildren(h('h3', null, 'Recent events'), ...(E.length ? E.slice().reverse().map((e) => h('div', { class: 'tl' }, h('time', null, fmtTime(e.ts)), h('span', { class: 'type' }, e.type), h('span', { class: 'what trunc' }, summarize(e)))) : [h('div', { class: 'muted small' }, 'The truth file is empty.')]));
      } catch { /* quiet */ }
    }
    function renderFoot() { renderLaunches(); renderEvents(); }
    const summarize = feedLine;

    // ------------------------------------------------------------ the manager dock
    // Wide: a column beside the lanes; narrow: a card above them. Hidden, it is a slim bar (a rail when wide) that
    // brings it back. Where the owner left it is kept per layout.
    let dock = null; let dockPrefs = {}; try { dockPrefs = JSON.parse(localStorage.getItem(DOCK_KEY) || '{}'); } catch { dockPrefs = {}; }
    const layout = () => (wrap.clientWidth >= 1180 ? 'wide' : 'narrow');   // the same width style.css's container query reads
    const dockOpen = () => (dockPrefs[layout()] ?? (layout() === 'wide' ? 'open' : 'closed')) === 'open';
    function setDock(open) { dockPrefs[layout()] = open ? 'open' : 'closed'; localStorage.setItem(DOCK_KEY, JSON.stringify(dockPrefs)); mountDock(); }
    function mountDock() {
      dock?.destroy(); dock = null; clear(dockEl);
      const open = dockOpen();
      wrap.classList.toggle('dock-closed', !open);
      if (open) { dock = mountManagerChat(dockEl, ctx, { store: ctx.manager.store, variant: 'dock', onPopOut: () => ctx.manager.popOut(), onCollapse: () => setDock(false) }); return; }
      const store = ctx.manager.store;
      const last = [...store.turns()].reverse().find((t) => t.role === 'assistant' && t.text?.trim());
      const s = store.state();
      dockEl.append(h('button', { class: 'mgr-bar', type: 'button', title: 'Show the manager here (m)', onclick: () => setDock(true) },
        h('span', { class: `dot ${s === 'busy' ? 'busy pulse' : s === 'up' ? 'lilac' : s === 'down' ? 'dead' : ''}`, 'aria-hidden': 'true' }),
        h('span', { class: 'mgr-bar-name' }, 'Manager'),
        h('span', { class: 'mgr-bar-last trunc' }, last ? mdText(last.text).slice(0, 200) : 'Ask the manager about the fleet'),
        h('span', { class: 'mgr-bar-open' }, 'Show')));
    }
    const offStore = ctx.manager.store.on((what) => { if (!dock && alive && (what === 'turns' || what === 'status' || what === 'host')) mountDock(); });
    const offDock = ctx.manager.registerDock({
      visible: () => alive && Boolean(dock) && dockEl.isConnected,
      focus: () => { dockEl.scrollIntoView({ block: 'nearest' }); dock?.focus(); },
    });
    // A dialog answered elsewhere on this page (the drawer's card, the waiting window, a notification) is Sent here
    // too, until it moves on. (A mutation event cannot say whether the press was refused, so only presses that went
    // through are announced: answer-model.js announceAnswered.)
    const onAnswered = (e) => {
      const a = e.detail ?? {}; const host = a.host ?? 'local';
      if (a.approval) {
        const st = ctx.strips().find((x) => x.host === host && x.approval?.id === a.approval);
        if (st && !sentFor(st)) { sent.set(st.key, { approval: a.approval, at: Date.now() }); render(); setTimeout(() => render(), SENT_MS + 100); }
        return;
      }
      const st = ctx.strips().find((x) => x.host === host && x.lane === 'wait' && [a.id, a.target].some((v) => v && (x.id === v || x.sessionId === v || x.tmux === v)) && (!a.hash || a.hash === x.hash));
      if (st && !sentFor(st)) { sent.set(st.key, { hash: st.hash, words: dialogWords(st), at: Date.now() }); render(); setTimeout(() => render(), SENT_MS + 100); }
    };
    document.addEventListener('drover:answered', onAnswered);
    let lastLayout = null;
    const ro = new ResizeObserver(() => { const l = layout(); if (l !== lastLayout) { lastLayout = l; mountDock(); } });
    ro.observe(root);

    load(); renderFoot();
    render();
    const timer = setInterval(() => load(true), 60_000);   // the stream carries the updates; this is the safety net
    let footTimer = null;
    return {
      destroy() { alive = false; clearInterval(timer); clearTimeout(soon); clearTimeout(footTimer); ro.disconnect(); offDock(); offStore(); dock?.destroy(); document.removeEventListener('drover:answered', onAnswered); },
      search(v) { q = v; render(); },
      sse(type, data) {
        if (type === 'board' || (type === 'fleet' && data?.hosts && !ctx.state.board)) render({ age: 0 });
        if ((type === 'alerts' || type === 'notify') && !ctx.state.board) setTimeout(() => render({ age: 0 }), 0);
        if (type === 'mutation') { clearTimeout(footTimer); footTimer = setTimeout(() => { renderEvents(); if (data?.op === 'launch.start') renderLaunches(); }, 800); }

      },
      probe() { load(true); },
      key(e) {
        const all = [...root.querySelectorAll('.strip')]; if (!all.length) return;
        const idx = all.findIndex((x) => x.getAttribute('aria-selected') === 'true');
        if (e.key === 'j' || e.key === 'k') { e.preventDefault(); const n = all[Math.max(0, Math.min(all.length - 1, idx + (e.key === 'j' ? 1 : -1)))]; const s = ctx.strips().find((x) => x.key === n.dataset.key); if (s) { open(s); n.scrollIntoView({ block: 'nearest' }); } }
      },
    };
  },
};
