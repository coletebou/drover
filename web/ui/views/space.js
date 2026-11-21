// Agents › Space in the browser: the fleet in 3D (ui/space-scene.js, shared with the TUI), drawn on a canvas 2D
// context (antialiased, devicePixelRatio-aware) with the same painter's order and the same picking. Drag orbits,
// the wheel zooms, Shift-drag or WASD pans, hover shows what an object is, a click selects (the shared agent
// selection, so Lanes, List, Windows and Wall show the same agent), a second click or Enter opens the session.
// Frames run while the camera moves or drifts, at 6 fps for a waiting agent's pulse, never while the tab is hidden.
// Nothing here answers a dialog: answering stays an explicit act on a strip in Lanes or the drawer.
import { h } from '../dom.js';
import { layout, buildScene, project, createCamera, resetCamera, orbit, zoom, pan, focusOn, stepCamera, pickAt, resolveId, agentOrder, pulsing, PALETTE } from '../space-scene.js';

const rgb = (c, a = 1) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a})`;
const ago = (iso) => { const s = Math.max(0, (Date.now() - Date.parse(iso ?? '')) / 1000); return !Number.isFinite(s) ? '' : s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 172800 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`; };
const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;

/** The board the view draws: the app's (ctx.board) when it has one, else today's strips and hosts. */
function boardOf(ctx) {
  const b = ctx.board?.();
  if (b && !Array.isArray(b)) return b;
  return { strips: Array.isArray(b) ? b : ctx.strips?.() ?? [], hosts: ctx.state?.board?.hosts ?? [],   // hosts carry ui: 'local' for the front daemon, as the strips do
    manager: ctx.state?.board?.manager ?? null, totals: ctx.state?.board?.totals ?? null };
}

export default {
  id: 'space', label: 'Space', key: '3',
  mount(root, ctx) {
    let alive = true, raf = 0, last = performance.now(), lastPulse = 0, lastInput = Date.now(), autoPaused = false;
    let lay = null, cam = null, proj = null, hovered = null, localSel = null, showIdle = true, labels = 'auto', drag = null, dirty = true;
    const canvas = h('canvas', { class: 'space-canvas', tabindex: 0, 'aria-label': 'The fleet in 3D: drag to orbit, scroll to zoom, click an agent to select it, click it again to open it', style: { width: '100%', height: '100%', display: 'block', cursor: 'grab', outline: 'none' } });
    const hud = h('div', { class: 'space-hud', style: { position: 'absolute', left: '12px', top: '10px', font: '12px/1.4 var(--mono, ui-monospace, Menlo, monospace)', color: '#c9d1dc', pointerEvents: 'none', textShadow: '0 1px 2px #000' } });
    const help = h('div', { class: 'space-help', style: { position: 'absolute', right: '12px', bottom: '10px', font: '11px/1.5 var(--mono, ui-monospace, Menlo, monospace)', color: '#8a93a3', pointerEvents: 'none', textAlign: 'right' } },
      'drag orbit · shift-drag or WASD pan · wheel zoom · J/K agent · F focus · Enter open · P drift · I idle · L labels · 0 reset');
    const tip = h('div', { class: 'space-tip', role: 'status', style: { position: 'absolute', display: 'none', maxWidth: '420px', padding: '6px 9px', borderRadius: '6px', background: 'rgba(12,16,26,.92)', border: '1px solid rgba(255,255,255,.12)', color: '#e4e8f0', font: '12px/1.4 var(--sans, system-ui, sans-serif)', pointerEvents: 'none', boxShadow: '0 4px 18px rgba(0,0,0,.45)', whiteSpace: 'normal' } });
    const info = h('div', { class: 'space-info', style: { position: 'absolute', left: '12px', bottom: '10px', maxWidth: '60%', font: '12px/1.45 var(--sans, system-ui, sans-serif)', color: '#dfe5ee', pointerEvents: 'none', textShadow: '0 1px 2px #000' } });
    const stageEl = h('div', { class: 'space-stage', style: { position: 'relative', height: 'calc(100vh - 150px)', minHeight: '360px', borderRadius: '10px', overflow: 'hidden', background: `linear-gradient(${rgb(PALETTE.skyTop)}, ${rgb(PALETTE.skyBottom)})` } }, canvas, hud, info, help, tip);
    root.append(stageEl);
    const g = canvas.getContext('2d');

    const selectedId = () => { const k = ctx.selected?.() ?? null; return localSel ?? (k ? `agent:${k}` : null); };
    function select(id) {
      localSel = id && !id.startsWith('agent:') ? id : null;
      const key = id?.startsWith('agent:') ? id.slice(6) : null;
      if (key || !id) ctx.select?.(key);
      dirty = true;
    }
    function openId(id) {
      const r = resolveId(lay, id); if (!r) return;
      if (r.kind === 'agent') { const s = r.agent.strip; ctx.open({ kind: s.kind, id: s.id, host: s.host, engine: s.engine, name: s.name, tmux: s.tmux, sessionId: s.sessionId }); }
      else if (r.kind === 'core') ctx.manager?.show?.({});
      else focusOn(cam, r.p, r.host.r * 3.2 + 6);
      dirty = true;
    }
    function touch() { lastInput = Date.now(); if (autoPaused && cam) { cam.drift = true; autoPaused = false; } wake(); }

    function size() {
      const dpr = Math.min(2, window.devicePixelRatio || 1), r = canvas.getBoundingClientRect();
      const W = Math.max(1, Math.round(r.width * dpr)), H = Math.max(1, Math.round(r.height * dpr));
      if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; dirty = true; }
      return { W, H, dpr };
    }
    function draw(now) {
      const { W, H, dpr } = size();
      const board = boardOf(ctx);
      lay = layout(board, { showIdle, now: Date.now(), frontHost: 'local', localLabel: ctx.state?.frontHost ?? null });
      if (!cam) { cam = createCamera(lay); if (reduced()) cam.drift = false; }
      const scene = buildScene(lay, { t: reduced() ? 0 : now / 1000, selected: selectedId(), hovered, labels });
      proj = project(scene, cam, W, H);
      g.clearRect(0, 0, W, H);
      g.lineJoin = 'round';
      for (const it of proj.items) {
        if (it.kind === 'face') {
          g.beginPath(); g.moveTo(it.pts[0][0], it.pts[0][1]);
          for (let i = 1; i < it.pts.length; i++) g.lineTo(it.pts[i][0], it.pts[i][1]);
          g.closePath(); g.fillStyle = rgb(it.color); g.fill();
          g.strokeStyle = rgb(it.color, 0.9); g.lineWidth = 0.6 * dpr; g.stroke();   // closes the hairline gaps between faces
        } else {
          g.beginPath(); g.moveTo(it.a[0], it.a[1]); g.lineTo(it.b[0], it.b[1]);
          g.strokeStyle = rgb(it.color, it.beam ? 0.95 : it.layer === 0 ? 0.8 : 0.75); g.lineWidth = (it.beam ? 2.4 : it.layer === 0 ? 0.8 : 1.3) * dpr; g.stroke();
        }
      }
      // Labels: highest priority first, never over each other.
      g.font = `${12 * dpr}px ui-sans-serif, system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'bottom';
      const boxes = [];
      for (const l of proj.labels) {
        const text = l.text.length > 34 ? `${l.text.slice(0, 33)}…` : l.text;
        const w = g.measureText(text).width + 8 * dpr, hh = 16 * dpr, x0 = l.x - w / 2, y0 = l.y - hh;
        if (boxes.some((b) => x0 < b[2] && x0 + w > b[0] && y0 < b[3] && y0 + hh > b[1])) continue;
        boxes.push([x0, y0, x0 + w, y0 + hh]);
        g.fillStyle = 'rgba(6,9,18,.55)'; g.fillRect(x0, y0, w, hh);
        g.fillStyle = rgb(l.color); g.fillText(text, l.x, l.y - 2 * dpr);
      }
      const t = board.totals ?? {};
      hud.replaceChildren(...[h('b', null, 'Space'), `  ${lay.hosts.length} hosts · ${lay.agents.length} agents`, t.waiting ? h('span', { style: { color: rgb(PALETTE.wait) } }, `  ${t.waiting} waiting on you`) : null, cam.drift ? h('span', { style: { color: '#8a93a3' } }, '  drifting') : null, showIdle ? null : '  (idle hidden)'].filter(Boolean));
      describe(info, selectedId(), false);
      dirty = false;
    }
    function describe(el, id, rich) {
      const r = resolveId(lay, id);
      if (!r) { el.replaceChildren(...(rich ? [] : [h('span', { style: { color: '#8a93a3' } }, 'Hover or click an agent; click it again to open it. The core in the middle is the manager.')])); return; }
      if (r.kind === 'core') { el.replaceChildren(h('b', { style: { color: rgb(PALETTE.core) } }, '◆ manager'), h('div', { style: { color: '#8a93a3' } }, 'Click again (or Enter) to open the manager.')); return; }
      if (r.kind === 'host') { const x = r.host; el.replaceChildren(h('b', null, `⬢ ${x.label ?? x.name}`), h('span', { style: { color: x.up ? '#8a93a3' : rgb(PALETTE.err) } }, `  ${x.up ? 'up' : 'down'} · ${x.count} agents${x.waiting ? ` · ${x.waiting} waiting` : ''}`)); return; }
      const s = r.agent.strip;
      const lane = s.lane === 'wait' ? 'waiting on you' : s.lane === 'work' ? 'working' : 'idle';
      el.replaceChildren(h('b', null, `■ ${s.name ?? s.key}`), h('span', { style: { color: rgb(PALETTE[s.lane] ?? PALETTE.idle) } }, `  ${lane}`), h('span', { style: { color: '#8a93a3' } }, `  ${s.host} · ${s.engine ?? ''}${s.since ? ` · ${ago(s.since)}` : ''}`),
        h('div', { style: { color: '#c3cad6', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: rich ? 'normal' : 'nowrap' } }, s.headline ?? s.tail?.at(-1) ?? ''));
    }

    function frame(now) {
      raf = 0;
      if (!alive) return;
      const dt = Math.min(0.25, (now - last) / 1000); last = now;
      if (cam && cam.drift && Date.now() - lastInput > 120_000) { cam.drift = false; autoPaused = true; }
      const moving = cam ? stepCamera(cam, dt) : true;
      const pulse = lay && pulsing(lay) && !reduced() && now - lastPulse > 160;
      if (pulse) lastPulse = now;
      if (moving || pulse || dirty) draw(now);
      if (document.hidden) return;   // visibilitychange wakes it again
      if (moving || drag || (lay && pulsing(lay) && !reduced())) raf = requestAnimationFrame(frame);
    }
    function wake() { if (!raf && alive) { last = performance.now(); raf = requestAnimationFrame(frame); } }

    // ------------------------------------------------------------ pointer
    const at = (e) => { const r = canvas.getBoundingClientRect(), dpr = canvas.width / Math.max(1, r.width); return [(e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr]; };
    canvas.addEventListener('pointerdown', (e) => { touch(); canvas.setPointerCapture(e.pointerId); drag = { x: e.clientX, y: e.clientY, moved: false, pan: e.shiftKey || e.button === 1 || e.button === 2 }; canvas.style.cursor = 'grabbing'; });
    canvas.addEventListener('pointermove', (e) => {
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
        drag.x = e.clientX; drag.y = e.clientY;
        if (drag.pan) pan(cam, -dx * 0.02, dy * 0.02); else orbit(cam, -dx * 0.008, dy * 0.006);
        tip.style.display = 'none'; touch(); return;
      }
      if (!proj) return;
      const [x, y] = at(e);
      const id = pickAt(proj, x, y, { slop: 4 });
      canvas.style.cursor = id ? 'pointer' : 'grab';
      if (id !== hovered) { hovered = id; dirty = true; wake(); }
      if (id) {
        describe(tip, id, true);
        const r = stageEl.getBoundingClientRect();
        tip.style.display = 'block';
        tip.style.left = `${Math.min(r.width - 300, e.clientX - r.left + 14)}px`; tip.style.top = `${Math.max(8, e.clientY - r.top - 10)}px`;
      } else tip.style.display = 'none';
    });
    canvas.addEventListener('pointerleave', () => { if (hovered) { hovered = null; dirty = true; wake(); } tip.style.display = 'none'; });
    canvas.addEventListener('pointerup', (e) => {
      const d = drag; drag = null; canvas.style.cursor = hovered ? 'pointer' : 'grab';
      if (!d || d.moved || !proj) return;
      const [x, y] = at(e);
      const id = pickAt(proj, x, y, { slop: 4 });
      if (!id) return;
      if (id === selectedId()) openId(id); else select(id);
      wake();
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('wheel', (e) => { e.preventDefault(); touch(); zoom(cam, Math.exp(e.deltaY * 0.0012)); }, { passive: false });
    canvas.addEventListener('dblclick', () => { const id = selectedId(); if (id) openId(id); });
    canvas.addEventListener('keydown', (e) => {
      if (!cam || e.metaKey || e.ctrlKey || e.altKey) return;
      touch();
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const step = (dir) => { const list = agentOrder(lay); if (!list.length) return; const cur = list.findIndex((a) => `agent:${a.key}` === selectedId()); select(`agent:${list[cur < 0 ? (dir > 0 ? 0 : list.length - 1) : (cur + dir + list.length) % list.length].key}`); };
      const act = {
        ArrowLeft: () => orbit(cam, -0.16, 0, { now: false }), ArrowRight: () => orbit(cam, 0.16, 0, { now: false }),
        ArrowUp: () => orbit(cam, 0, 0.1, { now: false }), ArrowDown: () => orbit(cam, 0, -0.1, { now: false }),
        '+': () => zoom(cam, 0.84), '=': () => zoom(cam, 0.84), '-': () => zoom(cam, 1.19),
        w: () => pan(cam, 0, 1), s: () => pan(cam, 0, -1), a: () => pan(cam, -1, 0), d: () => pan(cam, 1, 0),
        j: () => step(1), k: () => step(-1),
        f: () => { const r = resolveId(lay, selectedId()); if (r) focusOn(cam, r.p, r.kind === 'agent' ? 7 : r.kind === 'host' ? r.host.r * 3.2 + 6 : 14); else resetCamera(cam, lay); },
        0: () => resetCamera(cam, lay), p: () => { cam.drift = !cam.drift; autoPaused = false; },
        i: () => { showIdle = !showIdle; }, l: () => { labels = labels === 'all' ? 'auto' : 'all'; },
        Enter: () => { const id = selectedId(); if (id) openId(id); }, Escape: () => select(null),
      }[k];
      if (!act) return;
      e.preventDefault(); e.stopPropagation(); act(); dirty = true; wake();
    });

    const ro = new ResizeObserver(() => { dirty = true; wake(); });
    ro.observe(canvas);
    const onVis = () => { if (!document.hidden) { dirty = true; wake(); } };
    document.addEventListener('visibilitychange', onVis);
    const offBoard = ctx.onBoard?.(() => { dirty = true; wake(); });
    // Without a board subscription the strips are read on each frame; a slow tick catches changes while still.
    const poll = offBoard ? null : setInterval(() => { dirty = true; wake(); }, 3000);
    wake();
    canvas.focus({ preventScroll: true });
    return () => { alive = false; cancelAnimationFrame(raf); ro.disconnect(); document.removeEventListener('visibilitychange', onVis); offBoard?.(); clearInterval(poll); };
  },
};
