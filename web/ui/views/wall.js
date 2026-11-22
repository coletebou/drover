// Agents › Wall: a grid of live tiles, one per agent on the board, in the board's order: waiting, working, idle,
// the newest first (docs/specs/2026-11-21-cohesion-overhaul.md, "Wall"). Each tile is a header (lane dot, name, host,
// where it works, state and age) over what its pane says, in color, its border in the lane's color (waiting pulses,
// not under reduced motion). Panes come from tmux.captureMany: one call per host per refresh, only for tiles on
// screen (IntersectionObserver), every 2 s (1 s zoomed), paused while the page is hidden; a daemon without it is read
// with tmux.capture, a few panes at a time, without color. Pane text is parsed (ansi.js) into spans: text only as
// textContent, colors only as validated #rrggbb inline styles. pane-content.js leaves out the agent's own furniture
// (input box, status line, mode line, notices) and prose wraps to the tile, so a tile reads as what the agent said
// last and not as its status line. An agent with no pane shows its last reply (sessions.lastReply), as Markdown.
// The scope (Active by default: waiting, working, idle for less than a day; Live; All) is kept in localStorage.
// Click selects (the selection Lanes, List, Windows and Space share), a second click or z zooms, Enter or a double
// click opens the drawer, Esc unzooms, arrows or h j k l move, + and - change the density, f steps the scope.
// Nothing here answers a dialog: that takes the drawer or a click on the strip in Lanes.
import { h, clear, append, ago, empty, loading, plural, seg, shortPath } from '../dom.js';
import { parseAnsi } from '../ansi.js';
import { paneContent, keepsShape, hangingIndent, lastText } from '../pane-content.js';
import { renderMarkdown } from '../markdown.js';
import { wallTiles, densityGrid, capturePlan, moveIndex, runStyle, fitLines, tailText, stateWord, repliesDue, replyText, SCOPES, DENSITY_MIN, DENSITY_MAX } from '../wall-model.js';

const DENSITY_KEY = 'drover.wall.density', SCOPE_KEY = 'drover.wall.scope';
const REFRESH_MS = 2000, ZOOM_MS = 1000, LINES = 60, ZOOM_LINES = 200, OLD_DAEMON_PANES = 8;
const LANE = { wait: ['amber', 'waiting'], work: ['steel', 'working'], idle: ['moss', 'idle'] };
const ms = (v) => (v == null ? 0 : typeof v === 'number' ? (v < 1e11 ? v * 1000 : v) : Date.parse(v) || 0);
const unknownOp = (e) => /unknown op/i.test(e?.message ?? '');

/**
 * Parsed lines (what pane-content.js kept) into a screen element: one div per line, one span per styled run. Prose
 * wraps with its own hanging indent; a rule, a box or a table row keeps its shape and is clipped. The element shows
 * the end of the lines when they do not all fit (CSS), so the newest is always in sight.
 */
function paintLines(el, lines, maxLines) {
  clear(el);
  const box = h('div', { class: 'wall-lines' });
  for (const line of lines.slice(-maxLines)) {
    const text = line.map((r) => r.text).join('');
    const row = h('div', { class: keepsShape(text) ? 'wl keep' : 'wl' });
    if (!text.trim()) row.textContent = ' ';
    else {
      const hang = hangingIndent(text);
      if (hang && !row.classList.contains('keep')) { row.style.paddingLeft = `${hang}ch`; row.style.textIndent = `-${hang}ch`; }
      for (const run of line) { const sp = document.createElement('span'); sp.textContent = run.text; Object.assign(sp.style, runStyle(run)); row.append(sp); }
    }
    box.append(row);
  }
  el.append(box);
}
/** What an agent with no pane said last, as Markdown, or the board's own lines as text. */
function paintSaid(el, text, markdown) {
  clear(el);
  el.append(h('div', { class: 'wall-lines' }, markdown ? renderMarkdown(text) : h('div', { class: 'wl' }, text || ' ')));
}
const lastOf = (text) => (String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? '');

export default {
  id: 'wall', label: 'Wall',
  mount(root, ctx) {
    let alive = true; let q = ''; let tiles = []; let zoomed = null; let clickTimer = null; let boardCount = 0;
    let scope = SCOPES.some(([id]) => id === localStorage.getItem(SCOPE_KEY)) ? localStorage.getItem(SCOPE_KEY) : 'active';
    let density = Math.max(DENSITY_MIN, Math.min(DENSITY_MAX, Number(localStorage.getItem(DENSITY_KEY)) || 3));
    const nodes = new Map();      // strip key -> { el, head, screen, sig, drawn }
    const caps = new Map();       // strip key -> { ok, text, lines (what pane-content.js kept), error, at, plain }
    const replies = new Map();    // strip key -> { text, at } for agents with no pane
    const asking = new Set();     // strip keys with a sessions.lastReply out
    let replyOp = true;           // false: this daemon has no sessions.lastReply
    const visible = new Set();
    const oldDaemon = new Set();  // hosts that have no tmux.captureMany: read pane by pane
    let fit = 12; let cols = 3;

    const meta = h('span', { class: 'muted small' });
    const slider = h('input', { type: 'range', min: DENSITY_MIN, max: DENSITY_MAX, step: 1, value: density, 'aria-label': 'Tiles per row', title: 'Tiles per row (+ / -)', oninput: () => setDensity(Number(slider.value)) });
    let scopeSeg = null;
    const scopeBox = h('span', { class: 'wall-scope' });
    function drawScope() { scopeSeg = seg(SCOPES.map(([id, label]) => [id, label]), scope, setScope); scopeSeg.title = SCOPES.map(([, label, what]) => `${label}: ${what}`).join('\n'); clear(scopeBox).append(scopeSeg); }
    function setScope(v) {
      scope = v; localStorage.setItem(SCOPE_KEY, v); drawScope();
      if (zoomed) unzoom();
      render(); refreshSoon(50);
    }
    drawScope();
    const head = h('div', { class: 'view-head' }, h('h1', null, 'Wall'), meta, h('span', { class: 'spacer' }), scopeBox,
      h('label', { class: 'check small wall-density' }, 'density', slider),
      h('span', { class: 'muted small board-keys' }, 'click select, again zoom, enter open, f scope'));
    const notice = h('div', { class: 'notice', hidden: true });
    const grid = h('div', { class: 'wall', role: 'listbox', 'aria-label': 'Agents', 'aria-multiselectable': 'false' });
    const zoomEl = h('section', { class: 'wall-zoom', hidden: true, 'aria-label': 'Zoomed pane' });
    root.append(head, notice, grid, zoomEl);
    grid.append(loading('Reading the fleet'));

    // ------------------------------------------------------------ layout: density -> columns and tile height
    function layout() {
      if (!alive) return;
      const g = densityGrid(density);
      cols = Math.max(1, Math.min(g.cols, Math.floor((grid.clientWidth || root.clientWidth || 900) / 170) || 1));
      const top = grid.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
      const avail = root.clientHeight - top - 24;
      // A screen too narrow for the density's columns (a phone) scrolls through tiles of a readable height instead.
      const narrowed = cols < g.cols;
      const rows = narrowed ? Math.max(2, Math.round(g.rows * cols / g.cols) + 1) : g.rows;
      const tileH = Math.max(130, Math.min(narrowed ? 260 : Infinity, Math.floor((avail - 8 * (rows - 1)) / rows)));
      grid.style.setProperty('--cols', String(cols));
      grid.style.gridAutoRows = `${tileH}px`;
      grid.dataset.density = String(density);
      const lh = parseFloat(getComputedStyle(grid).getPropertyValue('--wall-lh')) || 15;
      fit = fitLines(tileH - 34, lh);
      for (const n of nodes.values()) n.drawn = null;
      paintAll();
    }
    function setDensity(d) {
      density = Math.max(DENSITY_MIN, Math.min(DENSITY_MAX, d));
      slider.value = String(density); localStorage.setItem(DENSITY_KEY, String(density));
      layout(); refreshSoon(50);
    }

    // ------------------------------------------------------------ tiles
    function current() { const board = ctx.board(); boardCount = wallTiles(board).length; const all = wallTiles(board, { scope }); return q ? all.filter((s) => JSON.stringify([s.name, s.host, s.tmux, s.cwd, s.engine]).toLowerCase().includes(q.toLowerCase())) : all; }
    function render() {
      if (!alive) return;
      tiles = current();
      const have = ctx.state.board || ctx.state.fleet || ctx.state.snapshot;
      if (!tiles.length && !have) return;   // nothing read yet: keep "Reading the fleet"
      grid.querySelector('.pending')?.remove();
      const keep = new Set(); let prev = null;
      for (const s of tiles) {
        keep.add(s.key);
        let n = nodes.get(s.key);
        if (!n) { n = tile(s); nodes.set(s.key, n); io.observe(n.el); }
        const sig = JSON.stringify([s.lane, s.name, s.host, s.engine, ms(s.since), s.tmux, s.faded, s.status]);
        if (n.sig !== sig) { n.sig = sig; paintHead(n, s); n.drawn = null; }
        n.el.setAttribute('aria-selected', ctx.selected() === s.key ? 'true' : 'false');
        const want = prev ? prev.nextSibling : grid.firstChild;
        if (want !== n.el) grid.insertBefore(n.el, want);
        prev = n.el;
        paintScreen(s, n);
      }
      for (const [k, n] of nodes) if (!keep.has(k)) { io.unobserve(n.el); n.el.remove(); nodes.delete(k); caps.delete(k); replies.delete(k); visible.delete(k); }
      grid.querySelector(':scope > .empty')?.remove();
      const hidden = boardCount - tiles.length;
      if (!tiles.length) grid.append(q ? empty('Nothing matches', 'Loosen the search.') : boardCount ? empty(scope === 'live' ? 'Nothing is waiting or working' : 'Nothing is active right now', `${plural(boardCount, 'agent')} on the board: All shows them.`) : empty('No agents on the board', 'Launch one from Fleet › Launch.'));
      const n = (lane) => tiles.filter((s) => s.lane === lane).length;
      const hosts = new Set(tiles.map((s) => s.host)).size;
      meta.textContent = `${n('wait')} waiting · ${n('work')} working · ${n('idle')} idle on ${plural(hosts, 'host')}${hidden > 0 && !q ? ` · ${hidden} more in All` : ''}${document.hidden ? ', paused' : ''}`;
      notice.hidden = !oldDaemon.size;
      notice.textContent = oldDaemon.size ? `${[...oldDaemon].join(', ')} ${oldDaemon.size > 1 ? 'have' : 'has'} no tmux.captureMany yet: those tiles are read a few panes at a time, without color.` : '';
      if (zoomed && !tiles.some((s) => s.key === zoomed)) unzoom();
      if (zoomed) paintZoomHead();
    }
    function tile(s) {
      const headEl = h('div', { class: 'wall-head' });
      const screen = h('div', { class: 'wall-screen', 'aria-hidden': 'true' });
      const el = h('article', { class: 'wall-tile', role: 'option', tabindex: 0, 'data-key': s.key, onclick: () => clicked(s.key), ondblclick: () => { clearTimeout(clickTimer); openKey(s.key); } }, headEl, screen);
      return { el, head: headEl, screen, sig: null, drawn: null };
    }
    function paintHead(n, s) {
      const [color, label] = LANE[s.lane] ?? ['', s.lane ?? ''];
      n.el.className = `wall-tile lane-${s.lane ?? 'idle'}${s.faded ? ' faded' : ''}`;
      n.el.setAttribute('aria-label', `${s.name}, ${label}${s.host !== 'local' ? `, on ${s.host}` : ''}`);
      clear(n.head);
      append(n.head, [h('span', { class: `dot ${color === 'amber' ? 'wait' : color === 'steel' ? 'busy' : 'idle'}`, 'aria-hidden': 'true' }),
        h('span', { class: 'wall-name trunc', title: s.cwd ?? '' }, s.name),
        s.host !== 'local' ? h('span', { class: 'wall-host trunc' }, s.host) : null,
        s.cwd ? h('span', { class: 'wall-cwd trunc', title: s.cwd }, shortPath(s.cwd, 40)) : null,
        h('span', { class: 'spacer' }),
        h('span', { class: `wall-age${stateWord(s) === 'failed' || stateWord(s) === 'dead' ? ' bad' : ''}` }, stateWord(s), s.since ? ' ' : null, s.since ? ago(s.since) : null)]);
    }
    /** What a tile shows: the pane's kept lines, else the agent's last reply (Markdown), else the board's own lines. */
    function shown(s) {
      const c = caps.get(s.key);
      if (c?.ok && c.lines.length) return { kind: 'pane', lines: c.lines, plain: c.plain, peek: lastText(c.lines) };
      const said = replies.get(s.key)?.text?.trim();
      if (said) return { kind: 'said', text: said, peek: lastOf(said) };
      const own = tailText(s);
      const text = own && own !== s.status ? own : c?.ok ? 'nothing on screen yet' : c?.error ? `could not capture: ${c.error}` : s.tmux ? 'capturing the pane…' : 'no pane, and no reply on record';
      return { kind: 'board', text, peek: lastOf(text) };
    }
    function paintShown(el, v, maxLines) {
      el.classList.toggle('from-board', v.kind === 'board');
      el.classList.toggle('said', v.kind === 'said');
      el.classList.toggle('plain', Boolean(v.plain));
      if (v.kind === 'pane') paintLines(el, v.lines, maxLines); else paintSaid(el, v.text, v.kind === 'said');
    }
    function paintScreen(s, n) {
      const c = caps.get(s.key);
      const v = shown(s);
      const drawn = `${fit}|${v.kind}|${v.kind === 'pane' ? c.text : v.text}`;
      if (n.drawn === drawn) return;
      n.drawn = drawn;
      paintShown(n.screen, v, fit);
      // Hover shows the last line whole (a tile clips it); never selects.
      n.el.dataset.peek = `${s.name}${s.host !== 'local' ? ` on ${s.host}` : ''}: ${v.peek || (LANE[s.lane]?.[1] ?? '')}${c && !c.ok && c.error ? ` (pane: ${c.error})` : ''}`;
    }
    function paintAll() { for (const s of tiles) { const n = nodes.get(s.key); if (n) paintScreen(s, n); } if (zoomed) paintZoom(); }

    // ------------------------------------------------------------ selection, zoom, open
    function select(key) { ctx.select(key); for (const [k, n] of nodes) n.el.setAttribute('aria-selected', k === key ? 'true' : 'false'); }
    function clicked(key) {
      clearTimeout(clickTimer);
      if (ctx.selected() !== key) { select(key); return; }
      // The second click zooms, unless it is the second half of a double click (that opens the drawer).
      clickTimer = setTimeout(() => zoom(key), 260);
    }
    function openKey(key) {
      const s = tiles.find((x) => x.key === key); if (!s) return;
      select(key);
      ctx.open({ kind: s.kind, id: s.id, host: s.host, engine: s.engine, name: s.name, tmux: s.tmux, sessionId: s.sessionId });
    }
    const zScreen = h('div', { class: 'wall-screen zoom', 'aria-live': 'off' });
    const zHead = h('div', { class: 'wall-zoom-head' });
    zoomEl.append(zHead, zScreen);
    function zoom(key) { zoomed = key; select(key); zoomEl.hidden = false; grid.hidden = true; root.classList.add('wall-zoomed'); paintZoomHead(); paintZoom(); refreshSoon(0); }
    function unzoom() { const k = zoomed; zoomed = null; zoomEl.hidden = true; grid.hidden = false; root.classList.remove('wall-zoomed'); if (k) nodes.get(k)?.el.focus({ preventScroll: false }); refreshSoon(0); }
    function paintZoomHead() {
      const s = tiles.find((x) => x.key === zoomed); if (!s) return;
      const [color, label] = LANE[s.lane] ?? ['', ''];
      zoomEl.className = `wall-zoom lane-${s.lane ?? 'idle'}`;
      clear(zHead);
      append(zHead, [h('span', { class: `dot ${color === 'amber' ? 'wait' : color === 'steel' ? 'busy' : 'idle'}`, 'aria-hidden': 'true' }), h('strong', null, s.name), h('span', { class: 'muted small' }, [label, s.host !== 'local' ? s.host : null, s.tmux].filter(Boolean).join('  ')),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn sm', type: 'button', onclick: () => openKey(s.key) }, 'Open', h('kbd', null, 'enter')),
        h('button', { class: 'btn sm quiet', type: 'button', onclick: () => unzoom() }, 'Back to the wall', h('kbd', null, 'esc'))]);
    }
    function paintZoom() {
      const s = tiles.find((x) => x.key === zoomed); if (!s) return;
      const lh = parseFloat(getComputedStyle(zScreen).lineHeight) || 17;
      paintShown(zScreen, shown(s), fitLines(zScreen.clientHeight || 600, lh));
    }

    // ------------------------------------------------------------ captures
    const io = new IntersectionObserver((entries) => {
      let fresh = false;
      for (const e of entries) { const k = e.target.dataset.key; if (e.isIntersecting) { if (!visible.has(k)) fresh = true; visible.add(k); } else visible.delete(k); }
      if (fresh) refreshSoon(80);
    }, { root, rootMargin: '120px 0px' });
    function store(host, c) {
      const s = tiles.find((x) => (x.host ?? 'local') === host && x.tmux === c.target); if (!s) return;
      const ok = c.ok !== false && typeof c.text === 'string'; const was = caps.get(s.key);
      const state = c.screen?.state ?? s.screen ?? null;
      // The same text again (most refreshes): the lines parsed from it stand.
      const lines = !ok ? [] : was?.ok && was.text === c.text && was.state === state ? was.lines : paneContent(parseAnsi(c.text, { maxLines: ZOOM_LINES, maxCols: 400 }), { state }).lines;
      caps.set(s.key, { ok, text: c.text ?? '', lines, state, error: c.error ?? null, at: Date.now(), plain: Boolean(c.plain) });
    }
    async function captureHost(host, targets, lines) {
      if (!oldDaemon.has(host)) {
        try {
          const r = await ctx.callQuiet('tmux.captureMany', { targets, lines, escapes: true }, { host });
          for (const c of r?.captures ?? []) store(host, c);
          return;
        } catch (e) {
          if (!unknownOp(e)) { for (const t of targets) store(host, { target: t, ok: false, error: e.message }); return; }
          oldDaemon.add(host);
        }
      }
      // A daemon from before tmux.captureMany: one tmux.capture per pane (plain text), a few panes per refresh.
      await Promise.all(targets.slice(0, OLD_DAEMON_PANES).map((target) => ctx.callQuiet('tmux.capture', { target, lines }, { host })
        .then((r) => store(host, { target, ok: true, text: r?.text ?? '', plain: true }), (e) => store(host, { target, ok: false, error: e.message }))));
    }
    /** The last reply of the tiles on screen that have no pane: a few calls a refresh, each agent seldom. */
    async function askReplies() {
      if (!replyOp) return;
      const due = repliesDue(tiles.filter((s) => (zoomed ? s.key === zoomed : visible.has(s.key))), { replies, asking });
      await Promise.all(due.map(async (s) => {
        asking.add(s.key);
        const was = replies.get(s.key);
        try { replies.set(s.key, { text: replyText(await ctx.callQuiet('sessions.lastReply', { id: s.sessionId ?? s.id }, { host: s.host ?? 'local' }), was), at: Date.now() }); }
        catch (e) { if (unknownOp(e)) replyOp = false; replies.set(s.key, { text: was?.text ?? '', at: Date.now() }); }
        finally { asking.delete(s.key); }
      }));
    }
    let busy = false; let timer = null;
    async function refresh() {
      clearTimeout(timer); timer = null;
      if (!alive) return;
      if (document.hidden || busy) { schedule(); return; }
      busy = true;
      try {
        if (zoomed) {
          const s = tiles.find((x) => x.key === zoomed);
          await Promise.all([s?.tmux ? captureHost(s.host ?? 'local', [s.tmux], ZOOM_LINES) : null, askReplies()]);
          if (alive && zoomed) paintZoom();
        } else {
          const plan = capturePlan(tiles, visible);
          await Promise.all([...[...plan].map(([host, targets]) => captureHost(host, targets, LINES)), askReplies()]);
          if (alive) render();
        }
      } finally { busy = false; schedule(); }
    }
    function schedule() { if (!alive) return; clearTimeout(timer); timer = setTimeout(refresh, zoomed ? ZOOM_MS : REFRESH_MS); }
    function refreshSoon(delay) { if (!alive) return; clearTimeout(timer); timer = setTimeout(refresh, delay); }
    const onVis = () => { render(); if (!document.hidden) refreshSoon(0); };
    document.addEventListener('visibilitychange', onVis);

    // ------------------------------------------------------------ data: the board, read once if nothing has yet
    if (!ctx.state.board && !ctx.state.fleet) {
      const loadBoard = ctx.state.boardOp !== false ? ctx.swr('native.board', {}, (r) => { if (alive) ctx.setBoard?.(r); }, { host: 'local' })
        : ctx.swr('fleet.summary', {}, (r) => { if (alive && r?.hosts) ctx.setFleet?.(r); }, { host: 'local' });
      loadBoard.catch((e) => { if (alive && !tiles.length) { grid.querySelector('.pending')?.remove(); grid.append(empty('Could not read the fleet', e.message)); } });
    }
    const offBoard = ctx.onBoard(() => render());
    const offSel = ctx.onSelect((k) => { for (const [key, n] of nodes) n.el.setAttribute('aria-selected', key === k ? 'true' : 'false'); });
    const ro = new ResizeObserver(() => layout());
    ro.observe(root);
    render(); layout();
    // A selection carried in from another view: in sight, not acted on.
    requestAnimationFrame(() => { const k = ctx.selected(); if (k) nodes.get(k)?.el.scrollIntoView({ block: 'nearest' }); });
    refreshSoon(0);

    return {
      destroy() { alive = false; clearTimeout(timer); clearTimeout(clickTimer); io.disconnect(); ro.disconnect(); offBoard(); offSel(); document.removeEventListener('visibilitychange', onVis); },
      search(v) { q = v; render(); refreshSoon(80); },
      key(e) {
        const k = e.key;
        if (k === 'Escape' && zoomed) { e.preventDefault(); unzoom(); return; }
        if (k === '+' || k === '=') { e.preventDefault(); setDensity(density + 1); return; }
        if (k === '-' || k === '_') { e.preventDefault(); setDensity(density - 1); return; }
        if (k === 'f' || k === 'F') { e.preventDefault(); const ids = SCOPES.map(([id]) => id); setScope(ids[(ids.indexOf(scope) + (k === 'f' ? 1 : -1) + ids.length) % ids.length]); return; }
        const i = tiles.findIndex((s) => s.key === ctx.selected());
        if (k === 'Enter') { if (i >= 0) { e.preventDefault(); openKey(tiles[i].key); } return; }
        if (k === 'z') { e.preventDefault(); if (zoomed) unzoom(); else if (i >= 0) zoom(tiles[i].key); return; }
        if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'h', 'j', 'k', 'l'].includes(k)) {
          e.preventDefault();
          const next = moveIndex(i, k, zoomed ? 1 : cols, tiles.length);
          if (next < 0) return;
          const key = tiles[next].key;
          if (zoomed) { zoomed = key; select(key); paintZoomHead(); paintZoom(); refreshSoon(0); return; }
          select(key); const el = nodes.get(key)?.el; el?.focus({ preventScroll: true }); el?.scrollIntoView({ block: 'nearest' });
        }
      },
    };
  },
};
