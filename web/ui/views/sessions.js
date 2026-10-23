// Sessions on the selected host: live Claude and Codex, headless agents, then
// recent transcripts. One table, filters, the drawer for details.
import { h, clear, engine, dot, ago, chip, seg, matchQ, empty, loading, shortPath, toMs, plural } from '../dom.js';

function nameOf(s) { if (s.name) return s.name; if (s.preview) return String(s.preview).slice(0, 80); if (s.slug) return s.slug.replace(/^-/, '').split('-').filter(Boolean).slice(-2).join('/'); return String(s.id).slice(0, 8); }
function updatedOf(s) { return s.statusUpdatedAt ?? s.updatedAt ?? s.mtime ?? s.startedAt ?? s.createdAt ?? null; }

export default {
  id: 'sessions', label: 'Sessions', key: 's', topics: ['snapshot'],
  mount(root, ctx, params) {
    let sessions = []; let q = ''; let alive = true; let selectedId = params[0] ?? null;
    const filt = { scope: 'live', engine: '' };
    const meta = h('span', { class: 'muted small' });
    const head = h('div', { class: 'view-head' }, h('h1', null, 'Sessions'), meta, h('span', { class: 'spacer' }), h('button', { class: 'btn sm', type: 'button', onclick: () => load() }, 'Refresh'));
    const bar = h('div', { class: 'toolbar' });
    const notice = h('div', { class: 'notice', hidden: true });
    const wrap = h('div');
    root.append(head, bar, notice, wrap);

    function drawBar() {
      clear(bar);
      bar.append(seg([['live', 'Live'], ['all', 'All, incl. recent transcripts']], filt.scope, (v) => { filt.scope = v; render(); }));
      bar.append(h('span', { class: 'chips' }, ...['claude', 'codex', 'headless', 'openclaw', 'grok'].map((e) => chip(e, filt.engine === e, () => { filt.engine = filt.engine === e ? '' : e; render(); }))));
    }
    function visible() {
      return sessions
        .filter((s) => (filt.scope === 'all' || s.live) && (!filt.engine || (s.kind === 'headless' ? 'headless' : s.engine) === filt.engine) && matchQ(s, q))
        .sort((a, b) => (Number(Boolean(b.live)) - Number(Boolean(a.live))) || (Number(b.status === 'busy') - Number(a.status === 'busy')) || (toMs(updatedOf(b)) - toMs(updatedOf(a))));
    }
    function render() {
      if (!alive) return;
      drawBar();
      const vis = visible();
      meta.textContent = `${vis.length} of ${plural(sessions.length, 'session')} on ${ctx.host() === 'local' ? 'this machine' : ctx.host()}`;
      ctx.setCount('sessions', sessions.filter((s) => s.live).length || null);
      clear(wrap);
      if (!vis.length) { wrap.append(empty(sessions.length ? 'Nothing matches' : 'No sessions on this host', sessions.length ? 'Loosen the filters or the search.' : 'Start one from Launch.')); return; }
      const tb = h('tbody');
      for (const s of vis) {
        const eng = s.kind === 'headless' ? 'headless' : s.engine;
        const open = () => { selectedId = s.id; render(); ctx.open({ kind: 'session', id: s.id, host: ctx.host(), engine: eng, name: s.name, tmux: s.tmux }); };
        tb.append(h('tr', { tabindex: 0, 'aria-selected': s.id === selectedId ? 'true' : 'false', onclick: open, onkeydown: (e) => { if (e.key === 'Enter') open(); } },
          h('td', null, engine(eng)),
          h('td', null, h('span', { title: s.id }, nameOf(s)), s.model ? h('span', { class: 'muted small' }, '  ', s.model) : null),
          h('td', null, h('span', { class: 'mark' }, dot(s.live ? s.status : ''), s.live ? s.status : h('span', { class: 'faint' }, s.status === 'transcript' || s.status === 'rollout' ? 'on disk' : s.status))),
          h('td', { class: 'opt path', title: s.cwd ?? '' }, shortPath(s.cwd)),
          h('td', { class: 'opt target' }, s.tmux ?? ''),
          h('td', { class: 'num opt' }, updatedOf(s) ? ago(updatedOf(s)) : '')));
      }
      wrap.append(h('table', { class: 'tbl' }, h('thead', null, h('tr', null, h('th', null, ''), h('th', null, 'Name'), h('th', null, 'State'), h('th', { class: 'opt' }, 'Directory'), h('th', { class: 'opt' }, 'tmux'), h('th', { class: 'num opt' }, 'Updated'))), tb));
    }
    async function load(quiet = false) {
      if (!quiet && !sessions.length) { clear(wrap); wrap.append(loading('Listing sessions')); }
      try {
        await ctx.swr('sessions.list', {}, (r) => {
          if (!alive) return;
          sessions = r?.sessions ?? [];
          notice.hidden = !r?.codexError; notice.textContent = r?.codexError ? `Codex threads unavailable: ${r.codexError}` : '';
          render();
        });
      } catch (e) { if (!quiet && !sessions.length) { clear(wrap); wrap.append(empty('Could not list sessions', e.message)); } }
    }
    load();
    if (selectedId) ctx.open({ kind: 'session', id: selectedId, host: ctx.host() });
    const timer = setInterval(() => load(true), 30_000);
    return {
      destroy() { alive = false; clearInterval(timer); },
      search(v) { q = v; render(); },
      params(p) { if (p[0] && p[0] !== selectedId) { selectedId = p[0]; render(); ctx.open({ kind: 'session', id: selectedId, host: ctx.host() }); } },
      sse(type, data) {
        if (type !== 'snapshot' || ctx.host() !== 'local' || !data?.sessions) return;
        const byId = new Map(data.sessions.map((s) => [s.id, s]));
        let changed = false;
        for (const s of sessions) { const n = byId.get(s.id); if (n && n.status !== s.status) { s.status = n.status; s.statusUpdatedAt = n.statusUpdatedAt ?? s.statusUpdatedAt; changed = true; } }
        if (changed) render();
      },
      key(e) {
        const rows = [...root.querySelectorAll('tr[tabindex]')]; if (!rows.length) return;
        const idx = rows.findIndex((r) => r.getAttribute('aria-selected') === 'true');
        if (e.key === 'j' || e.key === 'k') { e.preventDefault(); rows[Math.max(0, Math.min(rows.length - 1, idx + (e.key === 'j' ? 1 : -1)))]?.click(); }
      },
    };
  },
};
