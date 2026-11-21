// Agents › Space: the fleet as a 3D scene, shared by the TUI (web/tui/views/space.js, half-block pixels) and the
// browser (web/ui/views/space.js, canvas 2D). The manager is a core at the origin, each host a disc on a ring
// around it, each agent a monolith on its host's disc (color by lane, height by recent activity, a beam over the
// ones that wait on you). This module holds everything both renderers must agree on: the layout from a board,
// the meshes, an orbit camera with easing, projection to a painter-sorted list of 2D faces and lines, labels, and
// picking (what is under a point). Pure: no DOM, no terminal, no clock (time is an argument). Tests in
// test/space-scene.test.js.

// ---------------------------------------------------------------- vectors (plain arrays [x, y, z])
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const lerp = (a, b, k) => a + (b - a) * k;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------------------------------------------------------------- colors ([r, g, b], 0..255)
export const PALETTE = {
  wait: [232, 166, 48], work: [84, 152, 230], idle: [112, 178, 104], err: [226, 92, 92], dead: [96, 100, 110],
  core: [190, 150, 230], host: [70, 82, 104], hostDown: [44, 46, 54], hostTop: [92, 106, 132], grid: [30, 40, 58],
  link: [70, 96, 140], beam: [255, 196, 90], label: [228, 232, 240], dim: [140, 148, 160], select: [255, 255, 255],
  skyTop: [6, 9, 18], skyBottom: [16, 24, 40],
};
export const mix = (a, b, k) => [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];
export const scale = (c, k) => [clamp(c[0] * k, 0, 255), clamp(c[1] * k, 0, 255), clamp(c[2] * k, 0, 255)];
export const hex = (c) => `#${c.map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('')}`;
/** The lane color of a strip: waiting, working, idle; an errored or dead session red or gray. */
export function laneColor(s) {
  if (s?.status === 'dead') return PALETTE.dead;
  if (s?.status === 'error' || s?.screen === 'error') return PALETTE.err;
  return PALETTE[s?.lane] ?? PALETTE.idle;
}

// ---------------------------------------------------------------- layout
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const ms = (v) => (v == null ? 0 : typeof v === 'number' ? (v < 1e11 ? v * 1000 : v) : Date.parse(v) || 0);
const LANE_RANK = { wait: 0, work: 1, idle: 2 };

/**
 * Where everything stands, from a board ({ strips, hosts, manager }): hosts on a ring around the origin (the front
 * host first, then by name), each sized to its agents, agents on a sunflower spiral on their host's disc, waiting
 * ones in the middle. showIdle false leaves idle agents out. now: ms, for heights (recent work stands taller).
 */
export function layout(board, { showIdle = true, now = 0, frontHost = 'local', localLabel = null } = {}) {
  // The manager is the core, never a monolith: its strip (engine openclaw, id manager) stays out of the hosts.
  const strips = (board?.strips ?? []).filter((s) => s && s.engine !== 'openclaw' && s.id !== 'manager' && (showIdle || s.lane !== 'idle'));
  const names = new Map();
  for (const h0 of board?.hosts ?? []) { const h = h0?.ui ? { ...h0, name: h0.ui } : h0; if (h?.name) names.set(h.name, { name: h.name, label: h0.name ?? h.name, up: h.up !== false, stale: Boolean(h.stale), error: h.error ?? null }); }
  for (const s of strips) if (!names.has(s.host ?? 'local')) names.set(s.host ?? 'local', { name: s.host ?? 'local', label: (s.host ?? 'local') === 'local' && localLabel ? localLabel : s.host ?? 'local', up: true });
  const hostList = [...names.values()].sort((a, b) => Number(b.name === frontHost) - Number(a.name === frontHost) || a.name.localeCompare(b.name));
  const byHost = new Map(hostList.map((h) => [h.name, []]));
  for (const s of strips) byHost.get(s.host ?? 'local').push(s);
  const C = 0.78;   // spiral spacing
  const hosts = hostList.map((h) => {
    const list = byHost.get(h.name).sort((a, b) => (LANE_RANK[a.lane] ?? 3) - (LANE_RANK[b.lane] ?? 3) || ms(b.since) - ms(a.since) || String(a.key).localeCompare(String(b.key)));
    return { ...h, agents: list, r: Math.max(1.7, C * Math.sqrt(list.length) + 0.9) };
  });
  // Ring radius: the discs' diameters plus a gap, around a circle, never closer than 7 to the core.
  const gap = 1.6;
  const around = hosts.reduce((s, h) => s + 2 * h.r + gap, 0);
  const R = Math.max(7, around / (2 * Math.PI), hosts.length === 1 ? 7 : 0);
  let acc = 0;
  const outHosts = []; const agents = [];
  for (const h of hosts) {
    const share = (2 * h.r + gap) / (around || 1);
    const ang = hosts.length === 1 ? Math.PI / 2 : (acc + share / 2) * 2 * Math.PI;
    acc += share;
    const x = Math.cos(ang) * R, z = Math.sin(ang) * R;
    outHosts.push({ name: h.name, label: h.label ?? h.name, x, z, r: h.r, up: h.up, stale: h.stale, error: h.error, count: h.agents.length, waiting: h.agents.filter((s) => s.lane === 'wait').length, angle: ang });
    h.agents.forEach((s, i) => {
      const rr = C * Math.sqrt(i + 0.5), a = i * GOLDEN;
      const ax = x + Math.cos(a) * rr, az = z + Math.sin(a) * rr;
      const age = now && s.since ? Math.max(0, now - ms(s.since)) : Infinity;
      const fresh = Number.isFinite(age) ? Math.exp(-age / (30 * 60_000)) : 0;   // 1 now, ~0.37 at 30 min
      const h3 = s.lane === 'work' ? 1.1 + 1.1 * fresh : s.lane === 'wait' ? 1.5 : s.faded ? 0.35 : 0.6;
      agents.push({ key: s.key ?? `${s.host}|${s.id}`, strip: s, host: h.name, x: ax, z: az, y0: DISC_H, h: h3, w: 0.52 });
    });
  }
  const span = R + Math.max(2, ...outHosts.map((h) => h.r));
  return { hosts: outHosts, agents, R, span, manager: board?.manager ?? null };
}
export const DISC_H = 0.28;

// ---------------------------------------------------------------- meshes (faces carry their outward normal)
function box(cx, y0, cz, w, h, d) {
  const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2, y1 = y0 + h;
  return [
    { pts: [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], n: [0, 1, 0] },
    { pts: [[x0, y0, z1], [x1, y0, z1], [x1, y0, z0], [x0, y0, z0]], n: [0, -1, 0] },
    { pts: [[x0, y0, z1], [x0, y1, z1], [x1, y1, z1], [x1, y0, z1]], n: [0, 0, 1] },
    { pts: [[x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z0]], n: [0, 0, -1] },
    { pts: [[x1, y0, z1], [x1, y1, z1], [x1, y1, z0], [x1, y0, z0]], n: [1, 0, 0] },
    { pts: [[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]], n: [-1, 0, 0] },
  ];
}
/** A flat n-gon prism (a host's disc): top, bottom and n sides. */
function prism(cx, y0, cz, r, h, n = 12) {
  const ring = (y) => Array.from({ length: n }, (_, i) => { const a = (i / n) * 2 * Math.PI; return [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r]; });
  const top = ring(y0 + h), bot = ring(y0);
  const faces = [{ pts: top, n: [0, 1, 0], top: true }, { pts: [...bot].reverse(), n: [0, -1, 0] }];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n; const a = ((i + 0.5) / n) * 2 * Math.PI;
    faces.push({ pts: [bot[i], top[i], top[j], bot[j]], n: [Math.cos(a), 0, Math.sin(a)] });
  }
  return faces;
}
/** An octahedron (the manager's core), turned by `spin` radians. */
function octa(c, r, spin = 0) {
  const ca = Math.cos(spin), sa = Math.sin(spin);
  const v = [[r, 0, 0], [0, 0, r], [-r, 0, 0], [0, 0, -r]].map(([x, y, z]) => [c[0] + x * ca - z * sa, c[1] + y, c[2] + x * sa + z * ca]);
  const top = [c[0], c[1] + r * 1.35, c[2]], bot = [c[0], c[1] - r * 1.35, c[2]];
  const faces = [];
  for (let i = 0; i < 4; i++) {
    const a = v[i], b = v[(i + 1) % 4];
    for (const [p, f] of [[[a, top, b], top], [[b, bot, a], bot]]) {
      const cen = mul(add(add(p[0], p[1]), p[2]), 1 / 3);
      faces.push({ pts: p, n: norm(sub(cen, c)), _f: f });
    }
  }
  return faces;
}

// ---------------------------------------------------------------- the scene
/**
 * Faces, lines and labels for a layout at time t (seconds): the ground grid, links from the core to each host,
 * host discs, agents, the core, beams over waiting agents. selected / hovered: ids ('agent:<key>', 'host:<name>',
 * 'core') drawn brighter, with their labels always shown.
 */
export function buildScene(lay, { t = 0, selected = null, hovered = null, labels = 'auto' } = {}) {
  const faces = [], lines = [], marks = [];
  const pulse = 0.5 + 0.5 * Math.sin(t * 4.2);
  // Ground grid (layer 0: always under everything).
  const G = Math.ceil(lay.span + 3), step = lay.span > 30 ? 4 : 3;
  for (let v = -G; v <= G; v += step) {
    const edge = Math.sqrt(Math.max(0, G * G - v * v));
    lines.push({ a: [v, 0, -edge], b: [v, 0, edge], color: PALETTE.grid, layer: 0 });
    lines.push({ a: [-edge, 0, v], b: [edge, 0, v], color: PALETTE.grid, layer: 0 });
  }
  const core = [0, 1.9, 0];
  for (const h of lay.hosts) {
    const id = `host:${h.name}`, on = id === selected || id === hovered;
    const base = h.up ? PALETTE.host : PALETTE.hostDown;
    for (const f of prism(h.x, 0, h.z, h.r, DISC_H)) faces.push({ ...f, color: f.top ? (h.up ? (on ? scale(PALETTE.hostTop, 1.35) : PALETTE.hostTop) : PALETTE.hostDown) : base, id, layer: 0.5 });   // discs under every agent (painter's order)
    lines.push({ a: [h.x, DISC_H, h.z], b: core, color: h.waiting ? mix(PALETTE.link, PALETTE.wait, 0.35 + 0.4 * pulse) : h.up ? PALETTE.link : PALETTE.hostDown, layer: 1, id });
    marks.push({ p: [h.x, DISC_H + 0.2, h.z + h.r + 0.55], text: h.up ? h.label : `${h.label} (down)`, color: h.up ? PALETTE.label : PALETTE.dim, id, priority: 2 });
  }
  for (const a of lay.agents) {
    const id = `agent:${a.key}`, sel = id === selected, hov = id === hovered;
    let c = laneColor(a.strip);
    if (a.strip.lane === 'wait') c = mix(c, PALETTE.beam, 0.25 + 0.5 * pulse);
    if (a.strip.faded) c = scale(c, 0.55);
    const glow = sel ? 0.55 : hov ? 0.35 : a.strip.lane === 'wait' ? 0.25 * pulse : 0;
    for (const f of box(a.x, a.y0, a.z, a.w, a.h, a.w)) faces.push({ ...f, color: c, id, glow });
    if (sel) {   // a halo ring on the disc around the selected agent
      const r = a.w * 1.1, n = 10, y = a.y0 + 0.01;
      for (let i = 0; i < n; i++) { const p = (k) => [a.x + Math.cos(k / n * 2 * Math.PI) * r, y, a.z + Math.sin(k / n * 2 * Math.PI) * r]; lines.push({ a: p(i), b: p(i + 1), color: PALETTE.select, layer: 1, id }); }
    }
    if (a.strip.lane === 'wait') lines.push({ a: [a.x, a.y0 + a.h, a.z], b: [a.x, a.y0 + a.h + 2.6 + pulse * 0.6, a.z], color: mix(PALETTE.wait, PALETTE.beam, pulse), layer: 1, id, beam: true });
    const show = labels === 'all' || sel || hov || (labels === 'auto' && a.strip.lane === 'wait');
    if (show) marks.push({ p: [a.x, a.y0 + a.h + (a.strip.lane === 'wait' ? 0.45 : 0.35), a.z], text: a.strip.name ?? a.key, color: sel || hov ? PALETTE.select : laneColor(a.strip), id, priority: sel ? 4 : hov ? 3 : 1 });
  }
  const coreOn = selected === 'core' || hovered === 'core';
  for (const f of octa(core, 0.85, t * 0.6)) faces.push({ pts: f.pts, n: f.n, color: coreOn ? scale(PALETTE.core, 1.2) : PALETTE.core, id: 'core', glow: 0.35 + 0.15 * Math.sin(t * 2) });
  marks.push({ p: [0, 3.5, 0], text: 'manager', color: PALETTE.core, id: 'core', priority: coreOn ? 3 : 1 });
  return { faces, lines, labels: marks };
}

// ---------------------------------------------------------------- camera
const PITCH_MIN = 0.08, PITCH_MAX = 1.45;
/** An orbit camera framing a layout: { yaw, pitch, dist, target, fov } now and the goal it eases toward. */
export function createCamera(lay = { span: 10 }) {
  const home = { yaw: 0.55, pitch: 0.62, dist: clamp(lay.span * 2.1, 12, 160), target: [0, 0.6, 0] };
  return { ...home, target: [...home.target], fov: (50 * Math.PI) / 180, goal: { ...home, target: [...home.target] }, home, drift: true };
}
/** Back to the framing createCamera chose (the goal, so it eases there). */
export function resetCamera(cam, lay) { const c = createCamera(lay ?? { span: cam.home.dist / 2.1 }); cam.goal = { ...c.goal, target: [...c.goal.target] }; cam.home = c.home; }
/** Orbit: yaw around the vertical axis, pitch up and down (kept between nearly level and nearly straight down). */
export function orbit(cam, dyaw, dpitch, { now = true } = {}) {
  cam.goal.yaw += dyaw; cam.goal.pitch = clamp(cam.goal.pitch + dpitch, PITCH_MIN, PITCH_MAX);
  if (now) { cam.yaw = cam.goal.yaw; cam.pitch = cam.goal.pitch; }
}
/** Zoom by a factor (>1 out, <1 in), kept within sensible distances. */
export function zoom(cam, factor) { cam.goal.dist = clamp(cam.goal.dist * factor, 3, 240); }
/** Pan the target across the ground, in camera-relative directions (right, forward), scaled by the distance. */
export function pan(cam, dx, dz) {
  const fw = [-Math.sin(cam.yaw), 0, -Math.cos(cam.yaw)], rt = [Math.cos(cam.yaw), 0, -Math.sin(cam.yaw)];
  const k = cam.goal.dist * 0.06;
  cam.goal.target = add(cam.goal.target, add(mul(rt, dx * k), mul(fw, dz * k)));
}
/** Fly to a point: the target moves there and the camera closes in to `dist`. */
export function focusOn(cam, p, dist = 9) { cam.goal.target = [p[0], p[1], p[2]]; cam.goal.dist = dist; }
/**
 * Ease the camera toward its goal over dt seconds (and drift the yaw slowly when drift is on). Returns whether it
 * still moves, so a renderer animates only while something changes.
 */
export function stepCamera(cam, dt) {
  if (cam.drift) cam.goal.yaw += dt * 0.07;
  const k = 1 - Math.exp(-dt * 7);
  let moving = false;
  const ease = (a, b) => { const v = lerp(a, b, k); if (Math.abs(b - v) > 1e-4) moving = true; return Math.abs(b - v) <= 1e-4 ? b : v; };
  cam.yaw = ease(cam.yaw, cam.goal.yaw); cam.pitch = ease(cam.pitch, cam.goal.pitch); cam.dist = ease(cam.dist, cam.goal.dist);
  cam.target = [ease(cam.target[0], cam.goal.target[0]), ease(cam.target[1], cam.goal.target[1]), ease(cam.target[2], cam.goal.target[2])];
  return moving || cam.drift;
}
/** The eye and its basis: right, up, forward. */
export function basis(cam) {
  const cp = Math.cos(cam.pitch);
  const eye = add(cam.target, mul([cp * Math.sin(cam.yaw), Math.sin(cam.pitch), cp * Math.cos(cam.yaw)], cam.dist));
  const f = norm(sub(cam.target, eye));
  const r = norm(cross(f, [0, 1, 0]));
  const u = cross(r, f);
  return { eye, r, u, f };
}

// ---------------------------------------------------------------- projection
const NEAR = 0.15;
const LIGHT = norm([0.45, 1, 0.3]);

/**
 * The scene as seen by the camera on a W x H surface (square pixels): items sorted far to near (layer 0 first) as
 * { kind: 'face', pts: [[x, y]...], color, id, z } or { kind: 'line', a: [x, y], b: [x, y], color, id, z }, and
 * labels { x, y, text, color, id, z, priority } nearest first. Faces turned away or crossing the near plane are
 * dropped; lines are clipped to it. Colors are lit (Lambert plus ambient, plus a face's glow).
 */
export function project(scene, cam, W, H) {
  const { eye, r, u, f } = basis(cam);
  const F = (H / 2) / Math.tan(cam.fov / 2);
  const toCam = (p) => { const d = sub(p, eye); return [dot(d, r), dot(d, u), dot(d, f)]; };
  const to2 = (c) => [W / 2 + (c[0] / c[2]) * F, H / 2 - (c[1] / c[2]) * F];
  const items = [];
  for (const fc of scene.faces) {
    const cen = fc.pts.reduce((s, p) => add(s, p), [0, 0, 0]).map((v) => v / fc.pts.length);
    if (dot(fc.n, sub(eye, cen)) <= 0) continue;   // turned away
    const cs = fc.pts.map(toCam);
    if (cs.some((c) => c[2] < NEAR)) continue;
    const lit = 0.36 + 0.64 * Math.max(0, dot(fc.n, LIGHT));
    const color = mix(scale(fc.color, lit), [255, 255, 255], fc.glow ?? 0);
    items.push({ kind: 'face', pts: cs.map(to2), color, id: fc.id ?? null, z: dot(sub(cen, eye), f), layer: fc.layer ?? 1 });
  }
  for (const ln of scene.lines) {
    let a = toCam(ln.a), b = toCam(ln.b);
    if (a[2] < NEAR && b[2] < NEAR) continue;
    if (a[2] < NEAR || b[2] < NEAR) { const k = (NEAR - a[2]) / (b[2] - a[2]); const m = [lerp(a[0], b[0], k), lerp(a[1], b[1], k), NEAR]; if (a[2] < NEAR) a = m; else b = m; }
    const z = (a[2] + b[2]) / 2;
    // The ground grid fades with distance, so it reads as a floor and not as a net over the scene.
    const color = ln.layer === 0 ? scale(ln.color, clamp(1.35 - z / (cam.dist * 1.7), 0.18, 1)) : ln.color;
    items.push({ kind: 'line', a: to2(a), b: to2(b), color, id: ln.id ?? null, z, layer: ln.layer ?? 1, beam: Boolean(ln.beam) });
  }
  items.sort((p, q) => p.layer - q.layer || q.z - p.z);
  const labels = [];
  for (const m of scene.labels) {
    const c = toCam(m.p);
    if (c[2] < NEAR) continue;
    const [x, y] = to2(c);
    if (x < -50 || x > W + 50 || y < -20 || y > H + 20) continue;
    labels.push({ x, y, text: String(m.text ?? ''), color: m.color, id: m.id, z: c[2], priority: m.priority ?? 1 });
  }
  labels.sort((p, q) => q.priority - p.priority || p.z - q.z);
  return { items, labels, W, H };
}

function inPoly(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function segDist(a, b, x, y) {
  const dx = b[0] - a[0], dy = b[1] - a[1]; const l2 = dx * dx + dy * dy || 1;
  const k = clamp(((x - a[0]) * dx + (y - a[1]) * dy) / l2, 0, 1);
  return Math.hypot(a[0] + k * dx - x, a[1] + k * dy - y);
}
/** The id of what is drawn at (x, y): the nearest face holding the point, else a beam within `slop`; null for sky. */
export function pickAt(proj, x, y, { slop = 1.5 } = {}) {
  for (let i = proj.items.length - 1; i >= 0; i--) {
    const it = proj.items[i];
    if (!it.id) continue;
    if (it.kind === 'face' ? inPoly(it.pts, x, y) : it.beam && segDist(it.a, it.b, x, y) <= slop) return it.id;
  }
  return null;
}

/** The layout entry an id names: { kind: 'agent', agent } | { kind: 'host', host } | { kind: 'core' } | null. */
export function resolveId(lay, id) {
  if (!id) return null;
  if (id === 'core') return { kind: 'core', p: [0, 1.9, 0] };
  if (id.startsWith('agent:')) { const a = lay.agents.find((x) => `agent:${x.key}` === id); return a ? { kind: 'agent', agent: a, p: [a.x, a.y0 + a.h / 2, a.z] } : null; }
  if (id.startsWith('host:')) { const h = lay.hosts.find((x) => `host:${x.name}` === id); return h ? { kind: 'host', host: h, p: [h.x, DISC_H, h.z] } : null; }
  return null;
}
/** Agents in visiting order for next/previous: waiting first, then working, then idle (layout order inside each). */
export function agentOrder(lay) { return [...lay.agents].sort((a, b) => (LANE_RANK[a.strip.lane] ?? 3) - (LANE_RANK[b.strip.lane] ?? 3)); }
/** Whether anything in the layout animates on its own (a waiting agent's pulse): a renderer may then idle slowly. */
export const pulsing = (lay) => lay.agents.some((a) => a.strip.lane === 'wait');
