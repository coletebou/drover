// Tmux windows on the selected host, grouped by session, with the agent and
// screen state of each. The drawer shows the pane and takes input.
import { h, clear, engine, dot, ago, empty, loading, matchQ, plural, btn, field, tildePath } from '../dom.js';
import { isWindow } from '../transcript.js';

export default {
  id: 'tmux', label: 'Tmux', key: 't', topics: ['snapshot'],   // the local windows, live (app.js asks the stream for them)
  mount(root, ctx, params) {
    let windows = []; let q = ''; let alive = true; let selected = params[0] ?? null; let onlyAgents = false;
    const meta = h('span', { class: 'muted small' });
    const head = h('div', { class: 'view-head' }, h('h1', null, 'Tmux'), meta, h('span', { class: 'spacer' }),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', onchange: (e) => { onlyAgents = e.target.checked; render(); } }), 'agents only'),
      btn('New window', () => newWindow(), { cls: 'sm' }), btn('Refresh', () => load(), { cls: 'sm' }));
    const wrap = h('div');
    root.append(head, wrap);

    function render() {
      if (!alive) return;
      const vis = windows.filter((w) => (!onlyAgents || w.agent) && matchQ(w, q));
      meta.textContent = `${vis.length} of ${plural(windows.length, 'window')}, ${windows.filter((w) => w.agent).length} with agents`;
      ctx.setCount('tmux', windows.filter((w) => w.screen?.state === 'dialog').length || null);
      clear(wrap);
      if (!vis.length) { wrap.append(empty(windows.length ? 'Nothing matches' : 'No tmux server on this host', windows.length ? '' : 'Launch an agent to create one.')); return; }
      const bySession = new Map();
      for (const w of vis) { if (!bySession.has(w.session)) bySession.set(w.session, []); bySession.get(w.session).push(w); }
      for (const [session, wins] of bySession) {
        const g = h('section', { class: 'group' }, h('div', { class: 'group-head' }, h('h2', null, session), h('span', { class: 'meta' }, `${plural(wins.length, 'window')}${wins[0].sessionAttached ? ', attached' : ''}`)));
        for (const w of wins) {
          const st = w.screen?.state ?? (w.agent?.status);
          const open = () => { selected = w.target; render(); ctx.open({ kind: 'window', id: w.target, host: ctx.host(), name: w.agent?.name ?? w.name, engine: w.agent?.engine, sessionId: w.agent?.sessionId, tmux: w.target }); };
          g.append(h('div', { class: 'row', tabindex: 0, 'aria-selected': isWindow(w, selected) ? 'true' : 'false', onclick: open, onkeydown: (e) => { if (e.key === 'Enter') open(); } },
            w.agent ? engine(w.agent.engine) : h('span', { class: 'engine shell' }, w.cmd.slice(0, 4)),
            h('div', { class: 'main-col' },
              h('div', { class: 'l1' }, h('span', { class: 'target' }, w.target), h('span', { class: 'trunc' }, w.name), w.agent?.name && w.agent.name !== w.name ? h('span', { class: 'muted small trunc' }, w.agent.name) : null),
              h('div', { class: 'l2' }, [w.panes > 1 ? plural(w.panes, 'pane') : null, w.cwd ? tildePath(w.cwd) : null, w.tail?.at(-1)].filter(Boolean).join('   '))),
            h('span', { class: 'mark' }, st ? dot(st, { pulse: st === 'busy' }) : null, st ?? '', w.activityTs ? h('span', { class: 'muted small' }, ' ', ago(w.activityTs)) : null)));
        }
        wrap.append(g);
      }
    }
    async function load(quiet = false) {
      if (!quiet && !windows.length) { clear(wrap); wrap.append(loading('Listing windows')); }
      try {
        await ctx.swr('tmux.windows', { classify: true }, (r) => { if (!alive || !Array.isArray(r)) return; windows = r; render(); });
      } catch (e) { if (!quiet && !windows.length) { clear(wrap); wrap.append(empty('Could not list windows', e.message)); } }
    }
    async function newWindow() {
      const sessionIn = h('input', { value: windows[0]?.session ?? 'main', list: 'nw-sessions' });
      const nameIn = h('input', { placeholder: 'name (optional)' });
      const cwdIn = h('input', { value: '~', placeholder: 'directory' });
      const cmdIn = h('input', { placeholder: 'command (blank for a shell), e.g. htop' });
      const dl = h('datalist', { id: 'nw-sessions' }, ...[...new Set(windows.map((w) => w.session))].map((s) => h('option', { value: s })));
      const form = h('form', { class: 'card form', onsubmit: async (e) => {
        e.preventDefault();
        try {
          const argv = cmdIn.value.trim() ? cmdIn.value.trim().split(/\s+/) : undefined;
          const r = await ctx.call('tmux.new', { session: sessionIn.value.trim(), name: nameIn.value.trim() || undefined, cwd: cwdIn.value.trim() || undefined, argv });
          form.remove(); await load(true); ctx.toast(`Opened ${r.target}`, 'ok'); ctx.open({ kind: 'window', id: r.target, host: ctx.host(), name: nameIn.value || r.target });
        } catch { /* toasted */ }
      } },
      field('tmux session', sessionIn), field('Window name', nameIn), field('Directory', cwdIn), field('Command', cmdIn, { wide: true }), dl,
      h('div', { class: 'toolbar wide' }, h('button', { class: 'btn primary sm', type: 'submit' }, 'Open window'), btn('Cancel', () => form.remove(), { cls: 'sm quiet' }), h('span', { class: 'muted small' }, 'Agents belong in Launch; this is for plain windows.')));
      wrap.prepend(form); sessionIn.focus();
    }
    load();
    if (selected) ctx.open({ kind: 'window', id: selected, host: ctx.host() });
    const timer = setInterval(() => load(true), 15_000);
    return {
      destroy() { alive = false; clearInterval(timer); },
      search(v) { q = v; render(); },
      params(p) { if (p[0] && p[0] !== selected) { selected = p[0]; render(); ctx.open({ kind: 'window', id: selected, host: ctx.host() }); } },
      sse(type, data) { if (type === 'snapshot' && ctx.host() === 'local' && Array.isArray(data?.windows)) { windows = data.windows; render(); } },
      key(e) {
        const rows = [...root.querySelectorAll('.row[tabindex]')]; if (!rows.length) return;
        const idx = rows.findIndex((r) => r.getAttribute('aria-selected') === 'true');
        if (e.key === 'j' || e.key === 'k') { e.preventDefault(); rows[Math.max(0, Math.min(rows.length - 1, idx + (e.key === 'j' ? 1 : -1)))]?.click(); }
      },
    };
  },
};
