// Terminals: one ttyd per opened tmux target, each in its own iframe with a Close button, as a panel inside
// Agents › Windows (it was a view of its own; #/terminals/<id> lands there through routes.js). ttyd binds 127.0.0.1
// on the daemon host, so this only works when the working host is local; the panel says so otherwise.
import { h, clear, dot, fmtTime, empty, loading, btn, plural } from '../dom.js';

/** Mount the panel into root; sel: the terminal to reveal. Returns { destroy, open(target), reveal(id), count() }. */
export function mountTerminals(root, ctx, { sel: wanted = null, onCount } = {}) {
  let list = []; let available; let alive = true; let loaded = false; let sel = wanted;
  const frames = new Map();   // id -> { el, st, m, iframe }; never re-appended, an iframe reloads when it moves
  const meta = h('span', { class: 'muted small' });
  const notice = h('div', { class: 'notice', hidden: true });
  const targetIn = h('input', { list: 'term-targets', placeholder: 'tmux target, e.g. work:3 or work:@12', 'aria-label': 'tmux target', autocomplete: 'off', size: 32 });
  const dl = h('datalist', { id: 'term-targets' });
  const ro = h('input', { type: 'checkbox' });
  const openBtn = h('button', { class: 'btn primary sm', type: 'submit' }, 'Open terminal');
  const form = h('form', { class: 'toolbar', onsubmit: (e) => { e.preventDefault(); openNew(); } }, targetIn, dl, h('label', { class: 'check' }, ro, 'read only'), openBtn);
  const wrap = h('div');
  const placeholder = h('p', { class: 'muted small' }, 'No terminals open. Press Terminal on a window below (or in its drawer), or enter a tmux target.');
  root.append(h('div', { class: 'group-head' }, h('h2', null, 'Terminals'), meta, h('span', { class: 'spacer' }), btn('Refresh', () => load(), { cls: 'sm quiet' })), notice, form, wrap);
  wrap.append(loading('Listing terminals'));

  function render() {
    if (!alive) return;
    const remote = !ctx.isLocal();
    const msgs = [];
    if (remote) msgs.push(`Terminals are local only. The ones on ${ctx.host()} bind 127.0.0.1 on that machine, so this browser cannot reach them; switch the host to local in the top bar to use terminals here.`);
    if (loaded && available === null) msgs.push('ttyd is not installed on this host, so terminals cannot be opened here. The Screen tab in the drawer still works.');
    notice.hidden = !msgs.length; notice.textContent = msgs.join(' ');
    openBtn.disabled = remote || (loaded && available === null);
    meta.textContent = loaded ? `${plural(list.length, 'terminal')} open${available ? `, ttyd ${String(available).replace(/^ttyd\s+(version\s+)?/i, '')}` : ''}${remote ? `, on ${ctx.host()}` : ''}` : 'loading';
    onCount?.(list.length);
    wrap.querySelector('.pending')?.remove();
    for (const [id, g] of frames) if (!list.some((t) => t.id === id)) { g.el.remove(); frames.delete(id); }
    if (!list.length) { if (!placeholder.isConnected) wrap.append(placeholder); return; }
    placeholder.remove();
    if (!list.some((t) => t.id === sel)) sel = list[0].id;
    for (const t of list) {
      let g = frames.get(t.id);
      if (!g) { g = makeGroup(t); frames.set(t.id, g); wrap.append(g.el); }
      g.m.textContent = [t.readOnly ? 'read only' : null, `port ${t.port}`, `since ${fmtTime(t.startedAt)}`].filter(Boolean).join(', ');
      clear(g.st); g.st.append(dot(t.alive ? 'up' : 'exited'), t.alive ? 'attached' : 'exited');
      g.el.setAttribute('aria-selected', t.id === sel ? 'true' : 'false');
    }
  }
  function makeGroup(t) {
    const st = h('span', { class: 'mark' });
    const m = h('span', { class: 'meta' });
    const iframe = h('iframe', { class: 'term', src: t.url, title: `terminal ${t.target}`, allow: 'clipboard-read; clipboard-write' });
    const el = h('section', { class: 'group', 'data-id': t.id, 'aria-label': `terminal ${t.target}` },
      h('div', { class: 'group-head' }, h('h2', null, h('span', { class: 'target' }, t.target)), m, st, h('span', { style: { flex: 1 } }),
        btn('Pop out', () => window.open(t.url, '_blank', 'noopener'), { cls: 'sm quiet', title: 'Open this terminal in its own tab' }),
        btn('Close', () => close(t), { cls: 'sm quiet danger', title: `Stop the ttyd for ${t.target} (the tmux window stays)` })),
      iframe);
    return { el, st, m, iframe };
  }
  async function load(quiet = false) {
    try {
      const r = await (quiet ? ctx.callQuiet : ctx.call)('terminals.list', {});
      if (!alive) return;
      available = r?.available ?? null; list = r?.terminals ?? []; loaded = true;
      render();
    } catch (e) { if (!quiet) { loaded = true; clear(wrap); wrap.append(empty('Could not list terminals', e.message)); } }
    try {
      const wins = await ctx.callQuiet('tmux.windows', { classify: false });
      if (!alive) return;
      clear(dl); for (const w of wins ?? []) dl.append(h('option', { value: w.target }, `${w.name}${w.agent ? ` (${w.agent.engine})` : ''}`));
    } catch { /* optional */ }
  }
  async function open(target, readOnly = false) {
    const r = await ctx.call('terminals.open', { target, readOnly });
    ctx.toast(`Terminal on ${r.url}`, 'ok');
    sel = r.id; await load(true); reveal(r.id);
    return r;
  }
  async function openNew() {
    const target = targetIn.value.trim(); if (!target) { targetIn.focus(); return; }
    openBtn.disabled = true;
    try { await open(target, ro.checked); targetIn.value = ''; }
    catch { /* toasted */ } finally { openBtn.disabled = !ctx.isLocal() || available === null; }
  }
  async function close(t) {
    try { await ctx.call('terminals.close', { id: t.id }); frames.get(t.id)?.el.remove(); frames.delete(t.id); if (sel === t.id) sel = null; await load(true); }
    catch { /* toasted */ }
  }
  function reveal(id) { if (id) sel = id; render(); const g = sel ? frames.get(sel) : null; g?.el.scrollIntoView({ block: 'start' }); }

  load().then(() => { if (wanted) reveal(wanted); });
  const timer = setInterval(() => { if (!document.hidden) load(true); }, 10_000);
  return {
    destroy() { alive = false; clearInterval(timer); },
    open, reveal, count: () => list.length, available: () => available,
  };
}
