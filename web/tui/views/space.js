// Agents › Space in the terminal: the fleet in 3D (web/ui/space-scene.js), rasterized into half-block pixels (each
// cell is "▀" with the upper pixel as its foreground and the lower as its background, so square pixels at twice
// the rows), labels drawn over it, and a two-line panel about what is under the mouse or selected. Painter's order
// comes from the scene; an id buffer per pixel says what was drawn where, so hover and clicks pick exactly what is
// on screen. Frames: up to 20 a second while the camera moves or drifts, 4 for a waiting agent's pulse, none when
// still. Equal neighbouring cells merge into one segment so a frame stays small. With no color (NO_COLOR) the scene
// is shaded in ASCII. Selection is the app's shared agent selection (app.agentSel), so an agent picked here is the
// one Lanes, List, Windows and Wall show; no key here ever answers a dialog.
import { layout, buildScene, project, createCamera, resetCamera, orbit, zoom, pan, focusOn, stepCamera, resolveId, agentOrder, pulsing, PALETTE, hex } from '../../ui/space-scene.js';
import { clusters, clusterWidth, truncate, oneLine, strWidth } from '../width.js';
import { hints, ago, block } from '../ui.js';

const RAMP = ' .:-=+*#%@';
const q = (v) => Math.min(255, Math.round(v / 4) * 4);   // fewer distinct colors: longer runs, a smaller style cache

/** A W x H pixel buffer with an id per pixel. Pure apart from its own arrays; exported for tests. */
export class Raster {
  constructor(W, H) { this.W = W; this.H = H; this.rgb = new Uint8ClampedArray(W * H * 3); this.idx = new Int32Array(W * H).fill(-1); this.ids = []; }
  sky(top, bottom) {
    for (let y = 0; y < this.H; y++) {
      const k = this.H > 1 ? y / (this.H - 1) : 0;
      const c = [top[0] + (bottom[0] - top[0]) * k, top[1] + (bottom[1] - top[1]) * k, top[2] + (bottom[2] - top[2]) * k];
      for (let x = 0; x < this.W; x++) { const o = (y * this.W + x) * 3; this.rgb[o] = c[0]; this.rgb[o + 1] = c[1]; this.rgb[o + 2] = c[2]; }
    }
  }
  #id(id) { if (id == null) return -1; let i = this.ids.indexOf(id); if (i < 0) { i = this.ids.length; this.ids.push(id); } return i; }
  #put(x, y, c, n) {
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) return;
    const p = y * this.W + x, o = p * 3;
    this.rgb[o] = c[0]; this.rgb[o + 1] = c[1]; this.rgb[o + 2] = c[2]; this.idx[p] = n;
  }
  /** A convex polygon, sampled at pixel centers; one smaller than a pixel still lights the pixel it is in. */
  poly(pts, color, id) {
    const n = this.#id(id);
    let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
    for (const [x, y] of pts) { if (y < minY) minY = y; if (y > maxY) maxY = y; if (x < minX) minX = x; if (x > maxX) maxX = x; }
    if (maxX < 0 || maxY < 0 || minX >= this.W || minY >= this.H) return;
    if (maxX - minX < 1 && maxY - minY < 1) { this.#put(Math.floor((minX + maxX) / 2), Math.floor((minY + maxY) / 2), color, n); return; }
    const y0 = Math.max(0, Math.ceil(minY - 0.5)), y1 = Math.min(this.H - 1, Math.floor(maxY - 0.5));
    for (let y = y0; y <= y1; y++) {
      const yc = y + 0.5; let lo = Infinity, hi = -Infinity;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xa, ya] = pts[j], [xb, yb] = pts[i];
        if ((ya <= yc && yb > yc) || (yb <= yc && ya > yc)) { const x = xa + ((yc - ya) * (xb - xa)) / (yb - ya); if (x < lo) lo = x; if (x > hi) hi = x; }
      }
      if (lo > hi) continue;
      const x0 = Math.max(0, Math.ceil(lo - 0.5)), x1 = Math.min(this.W - 1, Math.floor(hi - 0.5));
      for (let x = x0; x <= x1; x++) this.#put(x, y, color, n);
      if (x0 > x1 && lo >= 0 && lo < this.W) this.#put(Math.floor(lo), y, color, n);   // a sliver narrower than a pixel
    }
  }
  line(a, b, color, id) {
    const n = this.#id(id);
    const steps = Math.min(4000, Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]))) + 1);
    for (let i = 0; i <= steps; i++) { const k = i / steps; this.#put(Math.floor(a[0] + (b[0] - a[0]) * k), Math.floor(a[1] + (b[1] - a[1]) * k), color, n); }
  }
  at(x, y) { const n = x >= 0 && y >= 0 && x < this.W && y < this.H ? this.idx[y * this.W + x] : -1; return n >= 0 ? this.ids[n] : null; }
  color(x, y) { const o = (y * this.W + x) * 3; return [this.rgb[o], this.rgb[o + 1], this.rgb[o + 2]]; }
}

/** Draw a projection into a raster: items in order, faces filled, lines stroked. */
export function rasterize(proj, W, H) {
  const r = new Raster(W, H);
  r.sky(PALETTE.skyTop, PALETTE.skyBottom);
  for (const it of proj.items) { if (it.kind === 'face') r.poly(it.pts, it.color, it.id); else r.line(it.a, it.b, it.color, it.id); }
  return r;
}

/**
 * Rows of segments from a raster (two pixel rows per text row) with labels over it. mono: ASCII shading by
 * luminance, no colors. Equal neighbouring cells become one segment.
 */
export function cellsToRows(r, labels, { mono = false, cols = r.W, rows = Math.ceil(r.H / 2) } = {}) {
  const ch = Array.from({ length: rows }, () => new Array(cols).fill(' '));
  const fg = Array.from({ length: rows }, () => new Array(cols).fill(null));
  const bg = Array.from({ length: rows }, () => new Array(cols).fill(null));
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const t = r.color(x, Math.min(r.H - 1, 2 * y)), b = r.color(x, Math.min(r.H - 1, 2 * y + 1));
    if (mono) { const lum = ((t[0] + b[0]) * 0.299 + (t[1] + b[1]) * 0.587 + (t[2] + b[2]) * 0.114) / 2 / 255; ch[y][x] = lum < 0.13 ? ' ' : RAMP[Math.min(RAMP.length - 1, Math.floor((lum - 0.1) * RAMP.length * 1.8))]; continue; }   // the sky stays blank
    const th = hex(t.map(q)), bh = hex(b.map(q));
    if (th === bh) { bg[y][x] = th; } else { ch[y][x] = '▀'; fg[y][x] = th; bg[y][x] = bh; }
  }
  // Labels: higher priority first, never over each other; wide characters take two cells.
  const used = Array.from({ length: rows }, () => new Uint8Array(cols));
  for (const l of labels) {
    const text = truncate(oneLine(l.text), 28);
    const w = strWidth(text);
    const row = Math.floor(l.y / 2) - 1, x0 = Math.round(l.x - w / 2);
    if (row < 0 || row >= rows || x0 < 0 || x0 + w > cols) continue;
    let free = true; for (let x = Math.max(0, x0 - 1); x < Math.min(cols, x0 + w + 1); x++) if (used[row][x]) free = false;
    if (!free) continue;
    let x = x0;
    for (const g of clusters(text)) {
      const gw = clusterWidth(g); if (gw <= 0) continue;
      ch[row][x] = g; fg[row][x] = mono ? null : hex(l.color.map(q)); bg[row][x] = mono ? null : bg[row][x] ?? fg[row][x];
      used[row][x] = 1;
      for (let k = 1; k < gw; k++) { ch[row][x + k] = ''; used[row][x + k] = 1; }
      x += gw;
    }
  }
  return ch.map((line, y) => {
    const segs = []; let cur = null;
    for (let x = 0; x < cols; x++) {
      const c = line[x]; if (c === '') continue;
      const f = c === ' ' ? null : fg[y][x], b = bg[y][x];
      if (cur && cur.f === f && cur.b === b) { cur.t += c; continue; }
      cur = { t: c, f, b }; segs.push(cur);
    }
    return segs.map((s) => [s.t, mono ? null : { ...(s.f ? { fg: s.f } : {}), ...(s.b ? { bg: s.b } : {}) }]);
  });
}

export class SpaceView {
  constructor(app) {
    this.app = app; this.id = 'space'; this.title = 'Space';
    this.cam = null; this.showIdle = true; this.labels = 'auto'; this.hovered = null; this.localSel = null;
    this.raster = null; this.sceneTop = 1; this.lastInput = Date.now(); this.lastTick = 0; this.lastPulse = 0; this.timer = null; this.drag = null;
  }
  get inputActive() { return false; }

  show() {
    this.lastInput = Date.now(); this.lastTick = Date.now();
    if (this.cam && this.autoPaused) { this.cam.drift = true; this.autoPaused = false; }
    clearInterval(this.timer);
    this.timer = setInterval(() => this.#tick(), 50); this.timer.unref?.();
    this.app.invalidate();
  }
  hide() { clearInterval(this.timer); this.timer = null; this.drag = null; }
  #tick() {
    const now = Date.now(), dt = Math.min(0.25, (now - this.lastTick) / 1000); this.lastTick = now;
    if (!this.cam) return;
    // The idle drift stops after a while with no input (it would repaint forever otherwise); any key brings it back.
    if (this.cam.drift && now - this.lastInput > 90_000) { this.cam.drift = false; this.autoPaused = true; }
    const moving = stepCamera(this.cam, dt);
    if (moving) { this.app.invalidate(); return; }
    if (this.lay && pulsing(this.lay) && now - this.lastPulse > 250) { this.lastPulse = now; this.app.invalidate(); }
  }
  #touch() { this.lastInput = Date.now(); if (this.cam && this.autoPaused) { this.cam.drift = true; this.autoPaused = false; } }

  /** The shared selection as a scene id, or a host / the core picked here. */
  selectedId() { const k = this.app.agentSel ?? null; return this.localSel ?? (k ? `agent:${k}` : null); }
  #select(id) {
    this.localSel = id && !id.startsWith('agent:') ? id : null;
    const key = id?.startsWith('agent:') ? id.slice(6) : null;
    if (key || !id) { if (this.app.selectAgent) this.app.selectAgent(key); else this.app.agentSel = key; }
  }
  #strip(id) { const r = resolveId(this.lay, id); return r?.kind === 'agent' ? r.agent.strip : null; }
  #activate(id) {
    const r = resolveId(this.lay, id); if (!r) return;
    if (r.kind === 'agent') this.app.openStrip(r.agent.strip);
    else if (r.kind === 'core') this.app.go?.('manager');
    else focusOn(this.cam, r.p, r.host.r * 3.2 + 6);
  }
  #focus() {
    const r = resolveId(this.lay, this.selectedId());
    if (!r) { resetCamera(this.cam, this.lay); return; }
    focusOn(this.cam, r.p, r.kind === 'agent' ? 7 : r.kind === 'host' ? r.host.r * 3.2 + 6 : 14);
  }
  #step(dir) {
    const list = agentOrder(this.lay); if (!list.length) return;
    const cur = list.findIndex((a) => `agent:${a.key}` === this.selectedId());
    const i = cur < 0 ? (dir > 0 ? 0 : list.length - 1) : (cur + dir + list.length) % list.length;
    this.#select(`agent:${list[i].key}`);
  }

  key(ev) {
    if (!this.cam) return false;
    this.#touch();
    const c = this.cam;
    switch (ev.id) {
      case 'left': orbit(c, -0.16, 0, { now: false }); return true;
      case 'right': orbit(c, 0.16, 0, { now: false }); return true;
      case 'up': orbit(c, 0, 0.1, { now: false }); return true;
      case 'down': orbit(c, 0, -0.1, { now: false }); return true;
      case '+': case '=': zoom(c, 0.84); return true;
      case '-': case '_': zoom(c, 1.19); return true;
      case 'w': pan(c, 0, 1); return true;
      case 's': pan(c, 0, -1); return true;
      case 'a': pan(c, -1, 0); return true;
      case 'd': pan(c, 1, 0); return true;
      case 'j': this.#step(1); return true;
      case 'k': this.#step(-1); return true;
      case 'f': this.#focus(); return true;
      case '0': resetCamera(c, this.lay); return true;
      case 'p': c.drift = !c.drift; this.autoPaused = false; this.app.toast?.(`drift ${c.drift ? 'on' : 'off'}`, 'dim', 1200); return true;
      case 'i': this.showIdle = !this.showIdle; this.app.toast?.(this.showIdle ? 'idle agents shown' : 'idle agents hidden', 'dim', 1500); return true;
      case 'l': this.labels = this.labels === 'all' ? 'auto' : 'all'; return true;
      case 'enter': { const id = this.selectedId(); if (id) this.#activate(id); return Boolean(id); }
      case 'r': { const s = this.#strip(this.selectedId()); if (s) this.app.replyTo(s); return Boolean(s); }
      case 'escape': if (this.selectedId()) { this.#select(null); return true; } return false;
      default: return false;
    }
  }

  mouse(ev) {
    if (!this.cam || !this.raster) return false;
    const px = ev.x, py = (ev.y - this.sceneTop) * 2 + 1;
    const inScene = ev.y >= this.sceneTop && py < this.raster.H;
    if (ev.kind === 'wheel') { this.#touch(); zoom(this.cam, ev.wheel < 0 ? 0.88 : 1.14); return true; }
    if (ev.kind === 'move') {
      const id = inScene ? this.raster.at(px, py) ?? this.raster.at(px, py - 1) : null;
      if (id === this.hovered) return false;
      this.hovered = id; return true;
    }
    if (ev.kind === 'drag' && this.drag) {
      this.#touch();
      const dx = ev.x - this.drag.x, dy = ev.y - this.drag.y;
      if (!dx && !dy) return false;
      this.drag.moved = true; this.drag.x = ev.x; this.drag.y = ev.y;
      orbit(this.cam, -dx * 0.05, dy * 0.09);
      return true;
    }
    if (ev.kind === 'up') { this.drag = null; return false; }
    if (ev.kind !== 'down' || ev.button !== 0) return false;
    this.#touch();
    this.drag = { x: ev.x, y: ev.y, moved: false };
    if (!inScene) return false;
    const id = this.raster.at(px, py) ?? this.raster.at(px, py - 1);
    if (!id) return false;
    if (id === this.selectedId()) this.#activate(id); else this.#select(id);
    return true;
  }

  hints() {
    return hints([['drag ←→↑↓', 'orbit'], ['wheel +/-', 'zoom'], ['wasd', 'pan'], ['j/k', 'agent'], ['f', 'focus'], ['Enter', 'open'], ['r', 'reply'],
      ['p', this.cam?.drift ? 'stop drift' : 'drift'], ['i', this.showIdle ? 'hide idle' : 'show idle'], ['0', 'reset']]);
  }

  #info(width) {
    const id = this.hovered ?? this.selectedId();
    const r = resolveId(this.lay, id);
    const dimRow = (t) => [[` ${truncate(t, width - 2)}`, 'dim']];
    if (!r) {
      const t = this.app.board?.totals ?? {};
      return [dimRow(`${this.lay.hosts.length} hosts · ${this.lay.agents.length} agents${t.waiting ? ` · ${t.waiting} waiting on you` : ''}${this.showIdle ? '' : ' (idle hidden)'}`), dimRow('Hover or click an agent; a second click opens it. The manager is the core in the middle.')];
    }
    if (r.kind === 'core') { const m = this.app.board?.manager; return [[[' ◆ manager', 'mgr'], [`  ${oneLine(m?.status ?? m?.state ?? '')}`, 'dim']], dimRow('Enter or a second click opens the manager.')]; }
    if (r.kind === 'host') { const h = r.host; return [[[` ⬢ ${h.name}`, 'bold'], [`  ${h.up ? 'up' : `down${h.error ? `: ${oneLine(h.error)}` : ''}`} · ${h.count} agents${h.waiting ? ` · ${h.waiting} waiting` : ''}`, h.up ? 'dim' : 'err']], dimRow('Enter or a second click flies to it; j/k walks its agents.')]; }
    const s = r.agent.strip;
    const lane = s.lane === 'wait' ? ['waiting on you', 'wait'] : s.lane === 'work' ? ['working', 'work'] : ['idle', 'idle'];
    const line1 = [[` ■ ${truncate(oneLine(s.name ?? s.key), Math.max(8, Math.floor(width / 2)))}`, 'bold'], [`  ${lane[0]}`, lane[1]], [`  ${this.app.hostLabel?.(s.host) ?? s.host} · ${s.engine ?? ''}${s.since ? ` · ${ago(s.since)}` : ''}`, 'dim']];
    return [line1, dimRow(oneLine(s.headline ?? s.tail?.at(-1) ?? '') || '(nothing on screen yet)')];
  }

  render(width, height) {
    const board = this.app.board ?? { strips: [] };
    const now = Date.now();
    this.lay = layout(board, { showIdle: this.showIdle, now, frontHost: 'local' });
    if (!this.cam) this.cam = createCamera(this.lay);
    const t = this.app.board?.totals ?? {};
    const head = [[' Space', 'bold'], [`  ${this.lay.hosts.length} hosts · ${board.strips?.length ?? 0} agents`, 'dim'], ...(t.waiting ? [[`  ${t.waiting} waiting`, 'waitBold']] : []), [this.cam.drift ? '  drifting' : '', 'dim']];
    if (board.loading && !board.strips?.length) return block([head, [[' loading the board…', 'dim']]], height);
    const sceneRows = Math.max(3, height - 3);
    this.sceneTop = 1;
    const W = width, H = sceneRows * 2;
    const scene = buildScene(this.lay, { t: now / 1000, selected: this.selectedId(), hovered: this.hovered, labels: this.labels });
    const proj = project(scene, this.cam, W, H);
    this.raster = rasterize(proj, W, H);
    const mono = (this.app.screen?.depth ?? 8) === 0;
    const rows = cellsToRows(this.raster, proj.labels, { mono, cols: W, rows: sceneRows });
    return block([head, ...rows, ...this.#info(width)], height);
  }
}
