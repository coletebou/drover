// Memory: for one repo's memory home, the session handoff (editable, saved
// only when changed, warns when the file moved under you), the reflections
// list (open first, add, done, drop), then MEMORY.md, the analyzer's
// unfinished.md per host and the DREAMS.md tail as collapsible sections.
// "All repos" reads every home from memory.repos at once: handoffs become a
// read-only list (open one to edit), reflections merge with a repo tag, and
// the collapsible sections repeat per repo. Writes always name one repo.
// Until a repo is picked here, the view shows the daemon's default repo (DROVER_DEFAULT_REPO: memory.overview without
// a repo answers for it and names it), else the first memory home, else all repos.
import { h, clear, chip, ago, fmtTime, fmtAgo, matchQ, empty, loading, btn, field, kv, shortPath, plural } from '../dom.js';

const KINDS = ['action', 'question', 'handoff', 'learning', 'decision', 'gotcha', 'idea', 'note'];
const REPO_KEY = 'drover.memory.repo';
const ALL = '*';
const ANALYZER_HINT = 'Run /session-analyzer to produce .analysis/<host>/unfinished.md files.';
const DEFAULT_LABEL = 'default repo';

export default {
  id: 'memory', label: 'Memory', key: 'm',
  mount(root, ctx) {
    let repo = localStorage.getItem(REPO_KEY) || '';   // '' until load() has resolved the default
    let repos = [];                 // [{ repo, home }] from memory.repos
    let datas = [];                 // [{ repo, data?, error? }], one entry in single-repo mode
    let q = ''; let filter = ''; let kindFilter = ''; let alive = true;
    let baseText = null;            // the handoff text the textarea was loaded from
    const expanded = new Set();     // reflection ids with details shown
    const isAll = () => repo === ALL;
    const primary = () => (isAll() ? null : datas[0]?.data ?? null);

    // ---- head
    const repoSel = h('select', { 'aria-label': 'Repo', onchange: () => selectRepo(repoSel.value) }, h('option', { value: repo, selected: true }, repo === ALL ? 'All repos' : repo || DEFAULT_LABEL));
    const homeEl = h('span', { class: 'muted small mono' });
    const filterIn = h('input', { type: 'search', placeholder: 'Filter MEMORY.md lines, reflections, analysis', 'aria-label': 'Memory filter', size: 34, oninput: () => { filter = filterIn.value; renderRight(); } });
    const head = h('div', { class: 'view-head' }, h('h1', null, 'Memory'), h('label', { class: 'muted small' }, 'repo ', repoSel), homeEl, h('span', { class: 'spacer' }), filterIn, btn('Refresh', () => load(), { cls: 'sm' }));

    // ---- left: the handoff editor (one repo) or the handoff list (all repos)
    const ta = h('textarea', { rows: 26, class: 'mono', spellcheck: 'false', 'aria-label': 'session_handoff.md', style: { width: '100%' } });
    const hoMeta = h('span', { class: 'muted small' });
    const dirtyEl = h('span', { class: 'em small' });
    const saveBtn = btn('Save', saveHandoff, { cls: 'sm primary', disabled: true, title: 'Write session_handoff.md on the selected host' });
    const revertBtn = btn('Revert', () => { ta.value = baseText ?? ''; markDirty(); }, { cls: 'sm quiet', disabled: true });
    const diskNotice = h('div', { class: 'notice', hidden: true });
    ta.addEventListener('input', markDirty);
    const leftOne = h('section', { class: 'group' },
      h('div', { class: 'group-head' }, h('h2', null, 'Session handoff'), hoMeta, h('span', { style: { flex: 1 } }), dirtyEl, revertBtn, saveBtn),
      diskNotice, ta);
    const handoffList = h('div');
    const leftAll = h('section', { class: 'group', hidden: true },
      h('div', { class: 'group-head' }, h('h2', null, 'Session handoffs'), h('span', { class: 'meta' }, 'one per repo; open one to edit it')),
      handoffList);

    // ---- right: reflections, then the collapsible docs
    const reflMeta = h('span', { class: 'meta' });
    const reflChips = h('div', { class: 'chips', style: { marginBottom: '6px' } });
    const reflErr = h('div', { class: 'notice error', hidden: true });
    const reflList = h('div');
    const addRepo = h('select', { 'aria-label': 'Repo for the new reflection' });
    const addRepoField = field('Repo', addRepo);
    const addKind = h('select', { 'aria-label': 'Kind' }, KINDS.map((k) => h('option', { value: k, selected: k === 'note' ? true : null }, k)));
    const addTitle = h('input', { placeholder: 'title', 'aria-label': 'Title' });
    const addBody = h('textarea', { rows: 2, placeholder: 'body (optional)', 'aria-label': 'Body' });
    const addBtn = h('button', { class: 'btn primary sm', type: 'submit' }, 'Add reflection');
    const addHint = h('span', { class: 'muted small' });
    const addForm = h('form', { class: 'form', style: { marginTop: '10px' }, onsubmit: addReflection },
      addRepoField, field('Kind', addKind), field('Title', addTitle), field('Body', addBody, { wide: true }),
      h('div', { class: 'toolbar wide', style: { margin: 0 } }, addBtn, addHint));
    const reflSec = h('section', { class: 'group' },
      h('div', { class: 'group-head' }, h('h2', null, 'Reflections'), reflMeta),
      reflErr, reflChips, reflList, h('h3', { style: { marginTop: '12px' } }, 'Add'), addForm);
    const docs = h('div');
    const right = h('div', null, reflSec, docs);

    root.append(head, h('div', { class: 'split' }, h('div', null, leftOne, leftAll), right));

    const f = () => filter.trim().toLowerCase();
    const hit = (s) => !f() || String(s ?? '').toLowerCase().includes(f());
    const setFilter = (v) => { filterIn.value = v; filter = v; renderRight(); };
    const section = (title, metaText, body) => h('details', { class: 'group', style: { marginTop: '6px' } },
      h('summary', { style: { cursor: 'pointer', padding: '6px 0', borderBottom: '1px solid var(--line-2)' } }, h('span', { class: 'em' }, title), ' ', h('span', { class: 'muted small' }, metaText)),
      h('div', { style: { paddingTop: '8px' } }, body));

    function selectRepo(next) {
      if (next === repo) return;
      if (!isAll() && markDirty() && !window.confirm('Discard the unsaved handoff changes?')) { repoSel.value = repo; return; }
      repo = next; localStorage.setItem(REPO_KEY, repo);
      baseText = null; datas = []; diskNotice.hidden = true;
      render(); load();
    }

    // ---- handoff (single repo)
    function markDirty() {
      const dirty = baseText !== null && ta.value !== baseText;
      saveBtn.disabled = !dirty; revertBtn.disabled = !dirty;
      dirtyEl.textContent = dirty ? 'unsaved changes' : '';
      return dirty;
    }
    function renderHandoff() {
      leftOne.hidden = isAll(); leftAll.hidden = !isAll();
      if (isAll()) { renderHandoffList(); return; }
      const d = datas[0];
      const ho = d?.data?.handoff;
      clear(hoMeta);
      if (d?.error) hoMeta.textContent = `memory.overview failed: ${d.error}`;
      else if (ho) hoMeta.append(h('span', { class: 'mono', title: ho.path }, shortPath(ho.path, 46)), `, ${ho.bytes} bytes, modified `, ago(ho.mtime));
      else hoMeta.textContent = d?.data ? 'no session_handoff.md in this memory home yet; saving creates it' : '';
      if (!d?.data) return;
      const disk = ho?.text ?? '';
      const dirty = markDirty();
      if (!dirty) { ta.value = disk; baseText = disk; diskNotice.hidden = true; markDirty(); return; }
      // Typed text present: never replace it, but say when the file moved underneath.
      if (disk !== baseText) {
        diskNotice.hidden = false; clear(diskNotice);
        diskNotice.append(`session_handoff.md changed on disk (${ho ? fmtAgo(ho.mtime, { short: false }) : 'removed'}) while you were editing; saving would overwrite that. `,
          btn('Load the disk copy', () => { ta.value = disk; baseText = disk; diskNotice.hidden = true; markDirty(); }, { cls: 'sm' }));
      } else diskNotice.hidden = true;
    }
    function renderHandoffList() {
      clear(handoffList);
      if (!datas.length) { handoffList.append(loading('Reading the memory homes')); return; }
      for (const d of datas) {
        const ho = d.data?.handoff;
        const heading = ho?.text?.split('\n').find((l) => /^##\s/.test(l))?.replace(/^##\s*/, '') ?? '';
        const open = () => { repoSel.value = d.repo; selectRepo(d.repo); };
        handoffList.append(h('div', { class: 'row', tabindex: 0, onclick: open, onkeydown: (e) => { if (e.key === 'Enter') open(); } },
          h('span', { class: 'mono small', style: { minWidth: '72px' } }, d.repo || DEFAULT_LABEL),
          h('div', { class: 'main-col' },
            h('div', { class: 'l1' }, d.error ? h('span', { class: 'mark' }, h('span', { class: 'dot dead' }), d.error) : ho ? h('span', { class: 'trunc', title: heading }, heading || '(no section heading)') : h('span', { class: 'faint' }, 'no session_handoff.md yet')),
            h('div', { class: 'l2' }, ho ? [`${ho.bytes} bytes`, `modified ${fmtAgo(ho.mtime)}`, shortPath(ho.path, 60)].join('   ') : (d.data?.home ? shortPath(d.data.home, 70) : ''))),
          btn('Open', (e) => { e.stopPropagation(); open(); }, { cls: 'sm quiet', title: `Edit the ${d.repo || DEFAULT_LABEL} handoff` })));
      }
    }
    async function saveHandoff() {
      if (saveBtn.disabled || isAll()) return;
      if (!window.confirm(`Overwrite session_handoff.md for ${repo} on ${ctx.host() === 'local' ? 'this machine' : ctx.host()}?`)) return;
      saveBtn.disabled = true;
      const text = ta.value;
      try {
        const r = await ctx.call('memory.handoff.write', { repo, text });
        baseText = text; markDirty(); diskNotice.hidden = true;
        ctx.toast(`Handoff saved (${r.sha256?.slice(0, 12) ?? ''})`, 'ok');
        await load(true);
      } catch { markDirty(); }
    }

    // ---- reflections (merged across the loaded repos)
    function reflItems() { return datas.flatMap((d) => (d.data?.reflections?.items ?? []).map((it) => ({ ...it, _repo: d.repo }))); }
    function renderRefl() {
      clear(reflChips); clear(reflList);
      const items = reflItems();
      const errs = datas.filter((d) => d.data?.reflections?.error).map((d) => `${d.repo}: ${d.data.reflections.error}`);
      reflErr.hidden = !errs.length; reflErr.textContent = errs.join('; ');
      reflMeta.textContent = datas.length ? `${plural(items.filter((it) => (it.status ?? 'open') === 'open').length, 'open item')}${isAll() ? ` across ${plural(datas.length, 'repo')}` : ''}` : '';
      const counts = {}; for (const it of items) counts[it.kind ?? '?'] = (counts[it.kind ?? '?'] ?? 0) + 1;
      reflChips.append(chip(`all ${items.length}`, !kindFilter, () => { kindFilter = ''; renderRefl(); }));
      for (const k of Object.keys(counts).sort()) reflChips.append(chip(`${k} ${counts[k]}`, kindFilter === k, () => { kindFilter = kindFilter === k ? '' : k; renderRefl(); }));
      const rank = (it) => ((it.status ?? 'open') === 'open' ? 0 : 1);
      const vis = items.filter((it) => (!kindFilter || it.kind === kindFilter) && hit(JSON.stringify(it)) && matchQ(it, q))
        .sort((a, b) => rank(a) - rank(b) || (Number(a.priority ?? 9) - Number(b.priority ?? 9)) || String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
      if (!vis.length) {
        const plain = datas.find((d) => d.data?.reflections?.text && !d.data.reflections.items?.length);
        if (plain && !items.length) reflList.append(h('pre', { class: 'screen' }, plain.data.reflections.text));
        else reflList.append(empty(items.length ? 'Nothing matches' : datas.length ? 'No open reflections' : 'Loading', items.length ? 'Loosen the kind filter or the search.' : datas.length ? 'The reflections CLI has nothing open here.' : ''));
        return;
      }
      for (const it of vis) reflList.append(reflRow(it));
    }
    function reflRow(it) {
      const open = (it.status ?? 'open') === 'open';
      const isX = expanded.has(it.id);
      const detail = h('div', { hidden: !isX, style: { padding: '2px 8px 10px 8px', borderBottom: '1px solid var(--line)' } },
        it.body ? h('p', { class: 'small', style: { margin: '4px 0 8px', whiteSpace: 'pre-wrap' } }, it.body) : null,
        kv([['repo', it._repo], ['id', h('code', null, it.id ?? '')], ['status', it.status], ['priority', it.priority], ['tags', it.tags?.length ? it.tags.join(', ') : null], ['host', it.host], ['agent', it.agent], ['origin', it.origin], ['branch', it.branch], ['cwd', it.cwd ? h('code', null, it.cwd) : null],
          ['created', it.created_at ? fmtTime(it.created_at) : null], ['updated', it.updated_at && it.updated_at !== it.created_at ? fmtTime(it.updated_at) : null], ['done', it.done_at ? fmtTime(it.done_at) : null], ['notes', it.notes || null]]));
      const toggle = () => { if (expanded.has(it.id)) expanded.delete(it.id); else expanded.add(it.id); detail.hidden = !expanded.has(it.id); row.setAttribute('aria-expanded', detail.hidden ? 'false' : 'true'); };
      const act = (op) => async (e) => { e.stopPropagation(); try { await ctx.call('reflections.mark', { op, ids: [it.id] }); ctx.toast(`${it.id} ${op}`, 'ok'); await load(true); } catch { /* toasted */ } };
      const row = h('div', { class: 'row', tabindex: 0, 'aria-expanded': isX ? 'true' : 'false', onclick: toggle, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } } },
        h('span', { class: 'em small', style: { minWidth: '62px' } }, it.kind ?? '?'),
        h('div', { class: 'main-col' },
          h('div', { class: 'l1' }, h('span', { class: open ? '' : 'muted' }, it.title ?? '(untitled)'), open ? null : h('span', { class: 'faint small' }, it.status)),
          h('div', { class: 'l2' }, [isAll() ? it._repo : null, it.id, it.priority != null ? `p${it.priority}` : null, it.tags?.length ? it.tags.join(' ') : null, it.host, it.created_at ? fmtAgo(it.created_at) : null].filter(Boolean).join('   '))),
        h('span', { class: 'toolbar', style: { margin: 0 } },
          open ? btn('Done', act('done'), { cls: 'sm quiet', title: 'Mark done' }) : btn('Reopen', act('reopen'), { cls: 'sm quiet' }),
          open ? btn('Drop', act('drop'), { cls: 'sm quiet danger', title: 'Drop without doing' }) : null));
      return h('div', null, row, detail);
    }
    function renderAddForm() {
      addRepoField.hidden = !isAll();
      addHint.textContent = isAll() ? 'goes to the reflections CLI store of the repo picked here' : `goes to the reflections CLI store for ${repo || `the ${DEFAULT_LABEL}`}`;
    }
    async function addReflection(e) {
      e.preventDefault();
      const title = addTitle.value.trim(); if (!title) { addTitle.focus(); return; }
      const target = isAll() ? addRepo.value : repo;
      if (!target) { ctx.toast('Pick a repo for the reflection', 'error'); return; }
      addBtn.disabled = true;
      try {
        const r = await ctx.call('reflections.add', { repo: target, kind: addKind.value, title, body: addBody.value.trim() || undefined });
        ctx.toast(`Reflection ${r.id ?? ''} added to ${target}`, 'ok');
        addTitle.value = ''; addBody.value = '';
        await load(true);
      } catch { /* toasted */ } finally { addBtn.disabled = false; }
    }

    // ---- MEMORY.md, analysis, dreams (one set of sections per loaded repo)
    const tag = (d) => (isAll() ? ` (${d.repo})` : '');
    function indexSection(d) {
      const idx = d.data?.memoryIndex;
      if (!idx?.text) return section('MEMORY.md' + tag(d), 'none', empty('No MEMORY.md in this memory home'));
      const lines = idx.text.split('\n');
      const pre = h('pre', { class: 'screen tall' });
      let shown = 0;
      for (const line of lines) {
        if (f() && !hit(line)) continue;
        if (q && !matchQ(line, q)) continue;
        shown++;
        const m = line.match(/\[([^\]]+)\]\([^)]+\)/);
        if (m) {
          const label = m[1];
          pre.append(h('span', { role: 'button', tabindex: 0, title: `Filter by "${label}"`, style: { cursor: 'pointer', textDecoration: 'underline dotted', textUnderlineOffset: '2px' }, onclick: () => setFilter(label), onkeydown: (e) => { if (e.key === 'Enter') setFilter(label); } }, line), '\n');
        } else pre.append(/^#/.test(line) ? h('span', { class: 'em' }, line) : line, '\n');
      }
      return section('MEMORY.md' + tag(d), `${shown} of ${plural(lines.length, 'line')}, ${fmtAgo(idx.mtime, { short: false })}; click an index line to filter by its label`, h('div', { class: 'doc' }, pre));
    }
    function analysisSection(d) {
      const list = d.data?.analysis ?? [];
      const body = h('div');
      if (!list.length) body.append(empty('No analyzer output', ANALYZER_HINT));
      let shown = 0;
      for (const a of list) {
        const matches = hit(a.text) && (!q || matchQ(a.text, q));
        if ((f() || q) && !matches) continue;
        shown++;
        body.append(h('details', { open: f() && matches ? true : null, style: { marginBottom: '6px' } },
          h('summary', { style: { cursor: 'pointer' } }, h('span', { class: 'mono' }, a.host), ' ', h('span', { class: 'muted small' }, `${a.bytes} bytes, ${fmtAgo(a.mtime, { short: false })}`)),
          h('div', { class: 'doc' }, h('pre', { class: 'screen tall', style: { marginTop: '6px' } }, a.text))));
      }
      if (list.length && !shown) body.append(empty('No host matches the filter'));
      return section('Analyzer: unfinished.md per host' + tag(d), plural(list.length, 'host'), body);
    }
    function dreamsSection(d) {
      const dr = d.data?.dreams;
      if (!dr?.text) return section('DREAMS.md tail' + tag(d), 'none', empty('No DREAMS.md yet'));
      const lines = dr.text.split('\n'); const tail = lines.slice(-80).join('\n');
      const body = h('div', { class: 'doc' }, h('div', { class: 'muted small mono', title: dr.path }, `${shortPath(dr.path, 60)} (${dr.bytes} bytes)`), h('pre', { class: 'screen tall', style: { marginTop: '6px' } }, tail));
      if (d.data.dreamDirs?.length) body.append(h('div', { style: { marginTop: '8px' } }, kv(d.data.dreamDirs.map((dd) => [dd.phase, dd.latest.join(', ') || 'none']))));
      return section('DREAMS.md tail' + tag(d), `last ${Math.min(80, lines.length)} of ${plural(lines.length, 'line')}, ${fmtAgo(dr.mtime, { short: false })}`, body);
    }
    function renderDocs() {
      clear(docs);
      for (const d of datas) { if (!d.data) continue; docs.append(indexSection(d), analysisSection(d), dreamsSection(d)); }
    }
    function renderRight() { if (!alive) return; renderRefl(); renderAddForm(); renderDocs(); }
    function render() {
      if (!alive) return;
      const home = primary()?.home;
      const homes = datas.filter((d) => d.repo || d.data).length;   // not the default repo's error when none is set
      homeEl.textContent = isAll() ? (homes ? plural(homes, 'memory home') : '') : home ? shortPath(home, 48) : '';
      homeEl.title = home ?? '';
      renderHandoff(); renderRight();
    }

    async function loadRepos() {
      try {
        const list = await ctx.callQuiet('memory.repos', {});
        if (!alive) return;
        repos = Array.isArray(list) ? list : [];
      } catch { repos = []; }
      fillRepos();
    }
    /** The repo pickers: every memory home, the repo shown, and the repos a load named (the default repo). */
    function fillRepos() {
      const names = [...new Set([...repos.map((x) => x.repo), ...datas.filter((d) => d.data && d.repo).map((d) => d.repo), ...(repo && repo !== ALL ? [repo] : [])])];
      clear(repoSel); clear(addRepo);
      if (!repo) repoSel.append(h('option', { value: '', selected: true }, DEFAULT_LABEL));
      repoSel.append(h('option', { value: ALL, selected: repo === ALL ? true : null }, 'All repos'));
      for (const n of names) {
        const home = repos.find((x) => x.repo === n)?.home ?? '';
        repoSel.append(h('option', { value: n, selected: n === repo ? true : null, title: home }, n));
        addRepo.append(h('option', { value: n, title: home }, n));
      }
    }
    async function load(quiet = false) {
      // '' asks for the daemon's default repo (memory.overview without a repo): no repo resolved yet, or all repos
      // with no memory home listed. The answer names the repo; a daemon without a default answers with an error.
      const targets = isAll() ? [...new Set(repos.map((x) => x.repo))] : [repo];
      if (!targets.length) targets.push('');
      if (!quiet && !datas.length) { clear(reflList); reflList.append(loading(isAll() ? 'Reading every memory home' : 'Reading the memory home')); }
      const ask = (r) => (quiet || !r ? ctx.callQuiet : ctx.call)('memory.overview', r ? { repo: r } : {});
      const results = await Promise.allSettled(targets.map(ask));
      if (!alive) return;
      datas = results.map((res, i) => (res.status === 'fulfilled' ? { repo: res.value?.repo ?? targets[i], data: res.value } : { repo: targets[i], error: res.reason?.message ?? 'failed' }));
      if (!repo) {
        // Resolved, not picked (nothing is saved): the default repo, else the first memory home, else all repos.
        repo = datas[0]?.data ? datas[0].repo : repos[0]?.repo ?? ALL;
        fillRepos();
        if (!datas[0]?.data && repos.length) { datas = []; return load(quiet); }
      } else if (targets[0] === '') fillRepos();   // all repos: the default repo's name joins the pickers
      render();
    }

    (async () => { await loadRepos(); if (alive) load(); })();
    const timer = setInterval(() => { if (!document.hidden) load(true); }, 90_000);
    return {
      destroy() { alive = false; clearInterval(timer); },
      search(qq) { q = qq; renderRight(); },
    };
  },
};
