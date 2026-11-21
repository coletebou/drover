// Agents › Space: the fleet in 3D (docs/specs/2026-11-21-cohesion-overhaul.md, "Space"). A placeholder until the
// canvas view (on web/ui/space-scene.js) replaces this file; it reads the board through ctx.board() / ctx.onBoard()
// and the shared selection through ctx.selected() / ctx.select() like the other Agents views.
import { h, plural } from '../dom.js';

export default {
  id: 'space', label: 'Space',
  mount(root, ctx) {
    const meta = h('span', { class: 'muted small' });
    const paint = () => { const n = ctx.board().filter((s) => s.engine !== 'openclaw').length; meta.textContent = plural(n, 'agent'); };
    root.append(h('div', { class: 'view-head' }, h('h1', null, 'Space'), meta), h('div', { class: 'empty' }, h('b', null, '3D view: coming in this branch'), 'The fleet as a scene: the manager at the core, hosts on a ring, every agent a monolith.'));
    paint();
    const off = ctx.onBoard(paint);
    return () => off();
  },
};
