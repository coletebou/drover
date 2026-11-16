// GitHub pull requests through the host's gh login (prs.list): the ones asking your review first, then yours,
// grouped by what they need. A row opens on GitHub; its chevron unfolds mergeable, the review decision and the
// checks (prs.get). APEX merge requests are the MRs view (a plugin).
import { h, clear, ago, empty, loading, matchQ, plural, btn } from '../dom.js';

const SCOPES = [['both', 'Yours + review'], ['authored', 'Yours'], ['review', 'Asking your review'], ['involves', 'Involving you']];
const STATES = ['open', 'merged', 'closed', 'all'];

export default {
  id: 'prs', label: 'PRs', key: 'u',
  mount(root, ctx) {
    let items = []; let q = ''; let alive = true; let scope = 'both'; let state = 'open'; let error = null; const open = new Map();
    const meta = h('span', { class: 'muted small' });
    const scopeSel = h('select', { onchange: (e) => { scope = e.target.value; load(); } }, ...SCOPES.map(([v, l]) => h('option', { value: v }, l)));
    const stateSel = h('select', { onchange: (e) => { state = e.target.value; load(); } }, ...STATES.map((v) => h('option', { value: v }, v)));
    root.append(h('div', { class: 'view-head' }, h('h1', null, 'Pull requests'), meta, h('span', { class: 'spacer' }), scopeSel, stateSel, btn('Refresh', () => load(), { cls: 'sm' })));
    const wrap = h('div');
    root.append(wrap);

    const role = (p) => (p.roles?.includes('reviewer') && !p.roles?.includes('author') ? 'review' : 'mine');
    function detailOf(p) {
      const box = h('div', { class: 'l2' }, 'reading…');
      ctx.callQuiet('prs.get', { repo: p.repo, number: p.number }).then((d) => {
        const c = d.checks ?? {};
        box.textContent = [
          `${d.head} → ${d.base}`, d.mergeable ? `mergeable: ${d.mergeable}${d.mergeState && d.mergeState !== 'unknown' ? ` (${d.mergeState})` : ''}` : null,
          `review: ${d.reviewDecision ? d.reviewDecision.replace(/_/g, ' ') : 'none yet'}`,
          c.total ? `checks: ${c.pass} passed${c.fail ? `, ${c.fail} failed (${c.failing.slice(0, 3).join(', ')})` : ''}${c.pending ? `, ${c.pending} running` : ''}` : 'no checks',
          d.size ? `+${d.size.additions} −${d.size.deletions} in ${plural(d.size.files, 'file')}` : null,
        ].filter(Boolean).join('   ');
      }, (e) => { box.textContent = e.message; });
      return box;
    }
    function render() {
      if (!alive) return;
      clear(wrap);
      const vis = items.filter((p) => matchQ(p, q));
      const asks = items.filter((p) => role(p) === 'review' && p.state === 'open').length;
      meta.textContent = error ? '' : `${plural(vis.length, 'pull request')}${asks ? `, ${asks} asking your review` : ''}`;
      ctx.setCount('prs', asks || null);
      if (error) { wrap.append(empty('Could not list pull requests', error)); return; }
      if (!vis.length) { wrap.append(empty(items.length ? 'Nothing matches' : `No ${state === 'all' ? '' : `${state} `}pull requests`, items.length ? '' : 'prs.list asks GitHub through this host\'s gh login.')); return; }
      for (const [label, list] of [['Asking your review', vis.filter((p) => role(p) === 'review')], ['Yours', vis.filter((p) => role(p) === 'mine')]]) {
        if (!list.length) continue;
        const g = h('section', { class: 'group' }, h('div', { class: 'group-head' }, h('h2', null, label), h('span', { class: 'meta' }, plural(list.length, 'pull request'))));
        for (const p of list) {
          const more = h('div');
          if (open.get(p.id)) more.append(open.get(p.id));
          const toggle = (e) => { e.stopPropagation(); if (open.has(p.id)) open.delete(p.id); else open.set(p.id, detailOf(p)); render(); };
          g.append(h('div', { class: 'row', tabindex: 0, onclick: () => window.open(p.url, '_blank', 'noopener'), onkeydown: (e) => { if (e.key === 'Enter') window.open(p.url, '_blank', 'noopener'); } },
            h('button', { class: 'btn quiet sm', title: 'details', onclick: toggle }, open.has(p.id) ? '▾' : '▸'),
            h('div', { class: 'main-col' },
              h('div', { class: 'l1' }, h('span', { class: 'target' }, `${p.repo}#${p.number}`), h('span', { class: 'trunc' }, p.title)),
              h('div', { class: 'l2' }, [p.author && role(p) === 'review' ? `by ${p.author}` : null, p.labels?.length ? p.labels.join(', ') : null, p.comments ? plural(p.comments, 'comment') : null].filter(Boolean).join('   ')),
              more),
            h('span', { class: 'mark' }, p.draft && p.state === 'open' ? 'draft' : p.state, p.updated ? h('span', { class: 'muted small' }, ' ', ago(p.updated)) : null)));
        }
        wrap.append(g);
      }
    }
    async function load() {
      if (!items.length) { clear(wrap); wrap.append(loading('Asking GitHub')); }
      try { await ctx.swr('prs.list', { scope, state, limit: 200 }, (r) => { if (!alive || !r) return; items = r.items ?? []; error = null; render(); }); }
      catch (e) { error = e.message; render(); }
    }
    load();
    const timer = setInterval(() => load(), 120_000);
    return { destroy() { alive = false; clearInterval(timer); }, search(v) { q = v; render(); } };
  },
};
