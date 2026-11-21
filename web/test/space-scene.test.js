import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layout, buildScene, project, createCamera, orbit, zoom, pan, focusOn, stepCamera, pickAt, resolveId, agentOrder, pulsing, basis, laneColor, PALETTE, DISC_H } from '../ui/space-scene.js';
import { Raster, cellsToRows, SpaceView } from '../tui/views/space.js';
import { rowText } from '../tui/screen.js';

const NOW = Date.parse('2026-11-21T12:00:00Z');
function board() {
  const strips = [];
  const lanes = ['wait', 'work', 'idle', 'idle'];
  for (const [hi, host] of ['local', 'box-a', 'box-b'].entries()) for (let i = 0; i < 2 + hi * 2; i++) strips.push({ key: `${host}|s${i}`, id: `s${i}`, kind: 'session', name: `${host}-${i}`, host, engine: 'claude', lane: lanes[(i + hi) % 4], since: new Date(NOW - i * 60_000).toISOString(), headline: `line ${i}` });
  return { strips, hosts: [{ name: 'local', up: true }, { name: 'box-a', up: true }, { name: 'box-b', up: false }, { name: 'empty-box', up: true }], totals: { waiting: strips.filter((s) => s.lane === 'wait').length } };
}

test('layout: hosts on a ring that does not overlap, agents on their own disc, front host first', () => {
  const lay = layout(board(), { now: NOW });
  assert.equal(lay.hosts[0].name, 'local');
  assert.deepEqual(lay.hosts.map((h) => h.name).sort(), ['box-a', 'box-b', 'empty-box', 'local']);
  for (let i = 0; i < lay.hosts.length; i++) for (let j = i + 1; j < lay.hosts.length; j++) {
    const a = lay.hosts[i], b = lay.hosts[j];
    assert.ok(Math.hypot(a.x - b.x, a.z - b.z) > a.r + b.r, `${a.name} and ${b.name} overlap`);
  }
  for (const a of lay.agents) { const h = lay.hosts.find((x) => x.name === a.host); assert.ok(Math.hypot(a.x - h.x, a.z - h.z) < h.r, `${a.key} is off its disc`); assert.equal(a.y0, DISC_H); }
  assert.equal(lay.hosts.find((h) => h.name === 'box-b').up, false);
  assert.equal(lay.agents.length, 12);
  assert.equal(layout(board(), { showIdle: false }).agents.every((a) => a.strip.lane !== 'idle'), true);
});

test('layout is deterministic and orders waiting agents first', () => {
  assert.deepEqual(layout(board(), { now: NOW }), layout(board(), { now: NOW }));
  const order = agentOrder(layout(board(), { now: NOW })).map((a) => a.strip.lane);
  assert.deepEqual(order, [...order].sort((p, q) => ['wait', 'work', 'idle'].indexOf(p) - ['wait', 'work', 'idle'].indexOf(q)));
  assert.equal(pulsing(layout(board(), { now: NOW })), true);
  assert.equal(pulsing(layout({ strips: board().strips.filter((s) => s.lane !== 'wait') })), false);
});

test('camera: orbit clamps the pitch, zoom clamps the distance, easing settles', () => {
  const cam = createCamera({ span: 10 });
  orbit(cam, 0, 10); assert.ok(cam.pitch < Math.PI / 2);
  orbit(cam, 0, -10); assert.ok(cam.pitch > 0);
  zoom(cam, 1e6); assert.ok(cam.goal.dist <= 240);
  zoom(cam, 1e-6); assert.ok(cam.goal.dist >= 3);
  cam.drift = false; focusOn(cam, [5, 0, 5], 8);
  let n = 0; while (stepCamera(cam, 0.05) && n < 500) n++;
  assert.ok(n < 500, 'the camera never settled');
  assert.deepEqual(cam.target, [5, 0, 5]); assert.equal(cam.dist, 8);
  const before = [...cam.goal.target]; pan(cam, 1, 0); assert.notDeepEqual(cam.goal.target, before);
  const { r, u, f } = basis(cam);
  assert.ok(Math.abs(r[0] * f[0] + r[1] * f[1] + r[2] * f[2]) < 1e-9 && Math.abs(u[0] * f[0] + u[1] * f[1] + u[2] * f[2]) < 1e-9);
});

test('projection: faces sorted far to near after the grid; nothing behind the camera; picking finds what is drawn', () => {
  const lay = layout(board(), { now: NOW });
  const cam = createCamera(lay);
  const proj = project(buildScene(lay, { t: 0 }), cam, 400, 300);
  const firstFace = proj.items.findIndex((i) => i.kind === 'face');
  assert.ok(proj.items.slice(0, firstFace).every((i) => i.layer === 0), 'the grid is drawn first');
  const L1 = proj.items.filter((i) => i.layer === 1);
  for (let i = 1; i < L1.length; i++) assert.ok(L1[i - 1].z >= L1[i].z, 'painter order');
  // The center of the screen looks at the core.
  assert.equal(pickAt(proj, 200, 150 - 25), 'core');
  // Each agent's projected top face picks as that agent (when nothing nearer covers its center).
  let hits = 0;
  for (const it of proj.items) if (it.kind === 'face' && it.id?.startsWith('agent:')) { const c = it.pts.reduce((s, p) => [s[0] + p[0] / it.pts.length, s[1] + p[1] / it.pts.length], [0, 0]); if (pickAt(proj, c[0], c[1])?.startsWith('agent:')) hits++; }
  assert.ok(hits > 0);
  assert.equal(pickAt(proj, 2, 2), null);
  // Behind the camera: looking from inside a host's disc toward the core drops what is behind.
  const close = createCamera(lay); close.target = [0, 0, 0]; close.dist = 0.5; close.pitch = 0.1;
  for (const it of project(buildScene(lay), close, 400, 300).items) if (it.kind === 'face') assert.ok(it.pts.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)));
});

test('scene: waiting agents pulse and carry a beam and a label; the selected one is brighter and labeled', () => {
  const lay = layout(board(), { now: NOW });
  const w = lay.agents.find((a) => a.strip.lane === 'wait');
  const idle = lay.agents.find((a) => a.strip.lane === 'idle');
  const s0 = buildScene(lay, { t: 0 }), s1 = buildScene(lay, { t: 0.37 });
  const col = (sc, id) => sc.faces.find((f) => f.id === id).color;
  assert.notDeepEqual(col(s0, `agent:${w.key}`), col(s1, `agent:${w.key}`));
  assert.ok(s0.lines.some((l) => l.beam && l.id === `agent:${w.key}`));
  assert.ok(s0.labels.some((l) => l.id === `agent:${w.key}`));
  assert.ok(!s0.labels.some((l) => l.id === `agent:${idle.key}`));
  const sel = buildScene(lay, { selected: `agent:${idle.key}` });
  assert.ok(sel.labels.some((l) => l.id === `agent:${idle.key}`));
  assert.ok(sel.faces.find((f) => f.id === `agent:${idle.key}`).glow > 0);
  assert.deepEqual(laneColor({ lane: 'wait' }), PALETTE.wait); assert.deepEqual(laneColor({ lane: 'work', status: 'dead' }), PALETTE.dead);
  assert.equal(resolveId(lay, `agent:${w.key}`).agent, w);
  assert.equal(resolveId(lay, 'host:box-a').host.name, 'box-a');
  assert.equal(resolveId(lay, 'agent:nope'), null);
});

test('raster: polygons fill at pixel centers, a sub-pixel one still lights a pixel, ids come back', () => {
  const r = new Raster(10, 10); r.sky([0, 0, 0], [0, 0, 0]);
  r.poly([[2, 2], [6, 2], [6, 6], [2, 6]], [255, 0, 0], 'a');
  assert.equal(r.at(3, 3), 'a'); assert.equal(r.at(7, 7), null); assert.deepEqual(r.color(4, 4), [255, 0, 0]);
  r.poly([[8.2, 8.2], [8.4, 8.2], [8.3, 8.4]], [0, 255, 0], 'b');
  assert.equal(r.at(8, 8), 'b');
  r.line([0, 9], [9, 9], [0, 0, 255], 'c'); assert.equal(r.at(5, 9), 'c');
  r.poly([[-50, -50], [-40, -50], [-40, -40]], [1, 1, 1], 'off');   // off screen: nothing, no throw
});

test('cells: half blocks carry two pixels, equal cells merge, labels sit over the scene and never overlap', () => {
  const r = new Raster(20, 4); r.sky([10, 10, 10], [10, 10, 10]);
  r.poly([[0, 0], [20, 0], [20, 1], [0, 1]], [200, 0, 0], 'top');   // pixel row 0 only
  const rows = cellsToRows(r, [{ x: 10, y: 4, text: 'label', color: [255, 255, 255] }, { x: 11, y: 4, text: 'hidden', color: [255, 255, 255] }], { cols: 20, rows: 2 });
  assert.equal(rows[0].length, 1, 'one merged segment for an even row');
  assert.ok(rows[0][0][0].startsWith('▀')); assert.equal(rows[0][0][1].fg, '#c80000');
  assert.equal(rowText(rows[1]).trim(), 'label');
  assert.ok(!rowText(rows[1]).includes('hidden'));
  const mono = cellsToRows(r, [], { mono: true, cols: 20, rows: 2 });
  assert.ok(mono.every((row) => row.every(([, st]) => st === null)));
});

test('the TUI view: renders at any size, a click selects through the shared selection, a second click opens', () => {
  const opened = []; let sel = null;
  const app = { board: board(), screen: { depth: 24 }, invalidate() {}, hostLabel: (h) => h, toast() {}, get agentSel() { return sel; }, selectAgent(k) { sel = k; }, openStrip: (s) => opened.push(s.key), replyTo() {}, go() {} };
  const v = new SpaceView(app);
  for (const [w, h] of [[40, 10], [80, 24], [160, 45], [250, 70]]) { const rows = v.render(w, h); assert.equal(rows.length, h); }
  v.render(120, 40);
  // Find a pixel of an agent and click its cell twice.
  let cell = null;
  for (let y = 0; y < v.raster.H && !cell; y += 2) for (let x = 0; x < v.raster.W; x++) { const id = v.raster.at(x, y); if (id?.startsWith('agent:')) { cell = { x, y: y / 2 + v.sceneTop, id }; break; } }
  assert.ok(cell, 'an agent is on screen');
  assert.equal(v.mouse({ kind: 'move', x: cell.x, y: cell.y }), true);
  assert.equal(v.hovered, cell.id); assert.equal(sel, null, 'hover never selects');
  v.mouse({ kind: 'down', button: 0, x: cell.x, y: cell.y }); v.mouse({ kind: 'up', button: 0, x: cell.x, y: cell.y });
  assert.equal(`agent:${sel}`, cell.id);
  v.render(120, 40);
  v.mouse({ kind: 'down', button: 0, x: cell.x, y: cell.y });
  assert.deepEqual(opened, [cell.id.slice(6)]);
  // Keys: j walks agents waiting first; digits are never taken (they switch workspaces).
  sel = null; v.key({ id: 'j' }); assert.equal(app.board.strips.find((s) => s.key === sel).lane, 'wait');
  assert.equal(v.key({ id: '1' }), false);
  v.key({ id: 'p' }); assert.equal(v.cam.drift, false);
  v.hide();
});
