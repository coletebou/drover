// Features: a four-column board over the truth file's feature events. Moves,
// edits, notes and pins are all appends (features.upsert / events.append); the
// state shown is the fold the daemon computes (events.state, front host).
import { h, clear, dot, ago, fmtTime, matchQ, empty, loading, debounce, btn, field, plural, kv } from '../dom.js';

const STATES = ['not-started', 'in-progress', 'shipped', 'abandoned'];
const DOT = { 'not-started': '', 'in-progress': 'busy', shipped: 'done', abandoned: 'dead' };
const LOCAL = { host: 'local' };

export default {
  id: 'features', label: 'Features', key: 'f',
  mount(root, ctx, params) {
    let state = null; let q = ''; let alive = true; let adding = false;
    let editing = params[0] ?? null;      // fid whose inline editor is open
    const notesOpen = new Set();          // fids whose notes panel is open
    const editors = new Map();            // fid -> form (kept across re-renders so typed text survives)
    const composers = new Map();          // fid -> note composer
    let addFormEl = null;

    const meta = h('span', { class: 'muted small' });
    const addBtn = btn('Add feature', () => { adding = !adding; render(); }, { cls: 'sm primary' });
    const head = h('div', { class: 'view-head' }, h('h1', null, 'Features'), meta, h('span', { class: 'spacer' }), addBtn, btn('Refresh', () => load(), { cls: 'sm' }));
    const addWrap = h('div');
    const wrap = h('div');
    root.append(head, addWrap, wrap);
    wrap.append(loading('Reading the truth file'));

    const features = () => state?.features ?? [];
    const byFid = (fid) => features().find((f) => f.fid === fid) ?? null;
    const excerpt = (s, n = 180) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 3) + '...' : t; };

    function render() {
      if (!alive) return;
      clear(addWrap);
      if (adding) { addFormEl ??= addForm(); addWrap.append(addFormEl); addBtn.textContent = 'Cancel'; } else { addFormEl = null; addBtn.textContent = 'Add feature'; }
      clear(wrap);
      if (!state) { wrap.append(loading('Reading the truth file')); return; }
      const all = features();
      const vis = all.filter((f) => matchQ({ ...f, notes: state.notes?.[f.fid] }, q));
      meta.textContent = `${q ? `${vis.length} of ` : ''}${plural(all.length, 'feature')}, ${all.filter((f) => f.state === 'in-progress').length} in progress, ${state.pins?.filter((p) => all.some((f) => f.fid === p)).length ?? 0} pinned`;
      ctx.setCount('features', all.filter((f) => f.state === 'in-progress').length || null);
      if (!all.length) { wrap.append(empty('No features yet', 'Add one above, or run "drover import-legacy" on the daemon host to import claude/feature-log.jsonl.')); return; }
      if (!vis.length) { wrap.append(empty('Nothing matches', 'Loosen the search.')); return; }
      const board = h('div', { class: 'kanban' });
      for (const s of STATES) {
        const items = vis.filter((f) => f.state === s).sort((a, b) => (Number(isPinned(b)) - Number(isPinned(a))) || (a.updated < b.updated ? 1 : -1));
        const list = h('div', { style: { display: 'grid', gap: '10px' } });
        for (const f of items) list.append(card(f));
        if (!items.length) list.append(h('div', { class: 'lane-empty' }, 'none'));
        board.append(h('section', { class: 'group', 'aria-label': s },
          h('div', { class: 'group-head' }, dot(DOT[s]), h('h2', null, s), h('span', { class: 'meta' }, String(items.length))), list));
      }
      wrap.append(board);
    }
    function isPinned(f) { return Boolean(state?.pins?.includes(f.fid)); }

    function card(f) {
      const notes = state.notes?.[f.fid] ?? []; const pinned = isPinned(f);
      const i = STATES.indexOf(f.state); const prev = STATES[i - 1]; const next = STATES[i + 1];
      const c = h('article', { class: 'card', 'data-fid': f.fid });
      c.append(h('h3', null, f.title || h('span', { class: 'faint' }, '(untitled)')));
      c.append(h('div', { class: 'small muted' },
        h('code', { title: f.fid }, f.fid), f.repo ? [' ', h('span', { class: 'em' }, f.repo)] : null, pinned ? [' ', h('span', { class: 'em' }, 'pinned')] : null,
        ' ', h('span', { class: 'faint', title: `created ${fmtTime(f.created)}, updated ${fmtTime(f.updated)}` }, 'updated ', ago(f.updated))));
      if (f.links?.length) c.append(h('div', { class: 'small mono trunc', title: f.links.join('\n') }, f.links.join('  ')));
      if (f.notes) c.append(h('p', { class: 'small', style: { margin: '6px 0 0' }, title: f.notes }, excerpt(f.notes)));
      c.append(h('div', { class: 'toolbar', style: { margin: '8px 0 0' } },
        prev ? btn(`< ${prev}`, () => move(f, prev), { cls: 'sm quiet', title: `Move to ${prev}` }) : null,
        next ? btn(`${next} >`, () => move(f, next), { cls: 'sm quiet', title: `Move to ${next}` }) : null,
        h('span', { style: { flex: 1 } }),
        btn(editing === f.fid ? 'Close' : 'Edit', () => { if (editing === f.fid) { editing = null; editors.delete(f.fid); } else editing = f.fid; render(); }, { cls: 'sm quiet' }),
        btn(notes.length ? `Notes ${notes.length}` : 'Note', () => { if (notesOpen.has(f.fid)) notesOpen.delete(f.fid); else notesOpen.add(f.fid); render(); }, { cls: 'sm quiet', title: notesOpen.has(f.fid) ? 'Hide notes' : 'Show notes and add one' }),
        btn(pinned ? 'Unpin' : 'Pin', () => togglePin(f), { cls: 'sm quiet' })));
      if (editing === f.fid) c.append(editor(f));
      if (notesOpen.has(f.fid)) c.append(notesPanel(f, notes));
      return c;
    }

    function addForm() {
      const title = h('input', { placeholder: 'title', 'aria-label': 'Title' });
      const repo = h('input', { placeholder: 'webapp, dotfiles, ...', 'aria-label': 'Repo', list: 'feat-repos' });
      const repos = h('datalist', { id: 'feat-repos' }, ...[...new Set(features().map((f) => f.repo).filter(Boolean))].sort().map((r) => h('option', { value: r })));
      const stateSel = h('select', { 'aria-label': 'State' }, STATES.map((s) => h('option', { value: s }, s)));
      const notes = h('textarea', { rows: 3, placeholder: 'notes', 'aria-label': 'Notes' });
      const links = h('textarea', { rows: 2, placeholder: '#1234, !567, branch names: one per line', 'aria-label': 'Links' });
      const create = h('button', { class: 'btn primary sm', type: 'submit' }, 'Create');
      const form = h('form', { class: 'card form', style: { marginBottom: '14px' }, onsubmit: async (e) => {
        e.preventDefault();
        if (!title.value.trim()) { title.focus(); return; }
        create.disabled = true;
        try {
          const ev = await ctx.call('features.upsert', { title: title.value.trim(), repo: repo.value.trim(), notes: notes.value, links: links.value.split('\n').map((s) => s.trim()).filter(Boolean), state: stateSel.value }, LOCAL);
          adding = false; ctx.toast(`Feature ${ev.fid} created`, 'ok');
          await load(true);
        } catch { /* toasted */ } finally { create.disabled = false; }
      } },
      field('Title', title), field('Repo', h('div', null, repo, repos)), field('State', stateSel), field('Notes', notes, { wide: true }), field('Links', links, { wide: true }),
      h('div', { class: 'toolbar wide', style: { margin: 0 } }, create, btn('Cancel', () => { adding = false; render(); }, { cls: 'sm quiet' })));
      setTimeout(() => title.focus(), 0);
      return form;
    }

    function editor(f) {
      let ed = editors.get(f.fid);
      if (ed) return ed;
      const title = h('input', { value: f.title ?? '', 'aria-label': 'Title' });
      const repo = h('input', { value: f.repo ?? '', 'aria-label': 'Repo' });
      const notes = h('textarea', { rows: 4, 'aria-label': 'Notes' }, f.notes ?? '');
      const links = h('textarea', { rows: 2, 'aria-label': 'Links', placeholder: 'one per line; links are only ever added' }, (f.links ?? []).join('\n'));
      const save = h('button', { class: 'btn primary sm', type: 'submit' }, 'Save');
      ed = h('form', { class: 'form', style: { marginTop: '10px' }, onsubmit: async (e) => {
        e.preventDefault(); save.disabled = true;
        try {
          await ctx.call('features.upsert', { fid: f.fid, title: title.value.trim(), repo: repo.value.trim(), notes: notes.value, links: links.value.split('\n').map((s) => s.trim()).filter(Boolean) }, LOCAL);
          editors.delete(f.fid); editing = null; ctx.toast('Feature saved', 'ok');
          await load(true);
        } catch { /* toasted */ } finally { save.disabled = false; }
      } },
      field('Title', title, { wide: true }), field('Repo', repo, { wide: true }), field('Notes', notes, { wide: true }), field('Links', links, { wide: true }),
      h('div', { class: 'toolbar wide', style: { margin: 0 } }, save, btn('Cancel', () => { editors.delete(f.fid); editing = null; render(); }, { cls: 'sm quiet' })));
      editors.set(f.fid, ed);
      return ed;
    }

    function notesPanel(f, notes) {
      let p = composers.get(f.fid);
      if (!p) {
        const ta = h('textarea', { rows: 2, placeholder: 'Add a note about this feature. Cmd+Enter or Ctrl+Enter sends.', 'aria-label': 'New note' });
        const add = async () => {
          const text = ta.value.trim(); if (!text) return;
          addB.disabled = true;
          try { await ctx.call('events.append', { event: { type: 'note', about: f.fid, text } }, LOCAL); ta.value = ''; ctx.toast('Note added', 'ok'); await load(true); }
          catch { /* toasted */ } finally { addB.disabled = false; }
        };
        const addB = btn('Add note', add, { cls: 'sm primary' });
        ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); add(); } });
        p = h('div', { class: 'composer', style: { marginTop: '8px' } }, ta, h('div', { class: 'bar' }, addB, h('span', { class: 'spacer' }), btn('Close', () => { notesOpen.delete(f.fid); composers.delete(f.fid); render(); }, { cls: 'sm quiet' })));
        composers.set(f.fid, p);
      }
      const list = h('div', { style: { marginTop: '10px' } });
      if (notes.length) list.append(kv(notes.slice().reverse().map((n) => [h('span', { title: n.ts }, fmtTime(n.ts), n.actor ? ` ${n.actor}` : ''), n.text ?? ''])));
      else list.append(h('div', { class: 'faint small' }, 'No notes yet.'));
      return h('div', null, list, p);
    }

    async function move(f, to) {
      try { await ctx.call('features.upsert', { fid: f.fid, state: to }, LOCAL); ctx.toast(`${f.title || f.fid}: ${to}`, 'ok'); await load(true); } catch { /* toasted */ }
    }
    async function togglePin(f) {
      const pinned = isPinned(f);
      try { await ctx.call('events.append', { event: { type: pinned ? 'unpin' : 'pin', target: f.fid } }, LOCAL); await load(true); } catch { /* toasted */ }
    }
    async function load(quiet = false) {
      try {
        const st = await (quiet ? ctx.callQuiet : ctx.call)('events.state', {}, LOCAL);
        if (!alive) return;
        state = st; render();
      } catch (e) { if (!quiet) { clear(wrap); wrap.append(empty('Could not load the truth file', e.message)); } }
    }
    const reload = debounce(() => load(true), 700);

    load();
    return {
      destroy() { alive = false; },
      search(qq) { q = qq; render(); },
      sse(type, d) { if (type === 'mutation' && /features\.upsert|events\.append/.test(d?.op ?? '')) reload(); },
      params(p) { const fid = p[0] ?? null; if (fid && fid !== editing && byFid(fid)) { editing = fid; render(); root.querySelector(`[data-fid="${CSS.escape(fid)}"]`)?.scrollIntoView({ block: 'nearest' }); } },
    };
  },
};
