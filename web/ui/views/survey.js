// Survey: the imported state-survey rows (survey-item events in the truth
// file), grouped by host, activity or state, with state and kind filters and
// expandable cards, like the original viewer.
import { h, clear, chip, seg, mark, dot, kv, fmtTime, matchQ, empty, loading, btn, plural } from '../dom.js';
import { standaloneHtml, saveText } from '../clip.js';

const LOCAL = { host: 'local' };
const QUIET = new Set(['stopped', 'unreachable']);
const ATTN = new Set(['waiting-on-user', 'cut-off', 'crashed']);
const ORDER = ['waiting-on-user', 'cut-off', 'crashed', 'active', 'idle', 'unknown', 'done', 'finished', 'stopped', 'unreachable'];
const GROUPINGS = [['host', 'By host'], ['item', 'By activity or MR'], ['attn', 'Needs you'], ['state', 'By state']];
const ord = (s) => { const i = ORDER.indexOf(s); return i < 0 ? ORDER.length : i; };
const dotState = (s) => (s === 'finished' ? 'done' : s === 'stopped' || s === 'unknown' ? '' : s);

export default {
  id: 'survey', label: 'Survey', key: 'v',
  mount(root, ctx) {
    const S = { q: '', states: new Set(), kinds: new Set(), view: 'host', showQuiet: false };
    let rows = []; let surveys = []; let alive = true; let loaded = false;
    let surveySel = 'latest'; // 'latest' | 'all' | <group key>
    const surveySelect = h('select', { 'aria-label': 'Which survey', onchange: () => { surveySel = surveySelect.value; render(); } });
    const expanded = new Set();
    const meta = h('span', { class: 'muted small' });
    // Re-survey takes a fresh snapshot of every agent on every reachable host and
    // appends it to the truth file; the optional AI pass writes summaries with Haiku.
    const aiBox = h('input', { type: 'checkbox' });
    const runBtn = btn('Re-survey', async () => {
      runBtn.disabled = true; runBtn.firstChild.textContent = aiBox.checked ? 'Surveying with AI…' : 'Surveying…';
      try {
        const r = await ctx.call('survey.run', { ai: aiBox.checked }, { host: 'local' });
        ctx.toast(`Survey done: ${r.count} items across ${r.hosts} hosts${r.ai?.cost != null ? `, AI $${Number(r.ai.cost).toFixed(3)}` : r.ai?.error ? `, AI pass failed: ${r.ai.error}` : ''}`, 'ok', 6000);
        await load(true);
      } catch { /* toasted */ } finally { runBtn.disabled = false; runBtn.firstChild.textContent = 'Re-survey'; }
    }, { cls: 'sm primary', title: 'Snapshot every agent on every reachable host into a new survey' });
    const head = h('div', { class: 'view-head' }, h('h1', null, 'Survey'), meta, h('span', { class: 'spacer' }), surveySelect,
      h('label', { class: 'check', title: 'One Haiku call writes the summary and next step per item' }, aiBox, 'AI summaries'), runBtn, btn('Reload', () => load(true), { cls: 'sm quiet', title: 'Re-read the truth file' }),
      btn('Save HTML', async () => {
        // Every group open, so the export reads without clicking.
        const copy = listEl.cloneNode(true); for (const d of copy.querySelectorAll('details')) d.setAttribute('open', '');
        const html = await standaloneHtml(`Fleet survey, ${meta.textContent}`, copy);
        const r = await saveText(`drover-survey-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.html`, html, 'text/html');
        if (r !== 'cancelled') ctx.toast(r === 'saved' ? 'Survey saved' : 'Survey downloaded', 'ok');
      }, { cls: 'sm quiet', title: 'Save what is shown as a standalone HTML file' }));
    const bar = h('div', { class: 'toolbar' });
    const stateChips = h('div', { class: 'chips' });
    const kindChips = h('div', { class: 'chips' });
    const filters = h('div', null, h('div', { class: 'toolbar' }, stateChips), h('div', { class: 'toolbar' }, kindChips));
    const listEl = h('div');
    root.append(head, bar, filters, listEl);
    listEl.append(loading('Reading the truth file'));

    const all = (k) => [...new Set(rows.map((r) => r[k]).filter(Boolean))].sort();
    // A run = one survey marker (survey.run) or one batch of imported files (same minute).
    function groupOf(r) { return r._group; }
    function drawSurveySelect() {
      const groups = [...new Map(rows.map((r) => [r._group, r])).values()].sort((a, b) => (a._ts < b._ts ? 1 : -1));
      clear(surveySelect);
      surveySelect.append(h('option', { value: 'latest' }, groups[0] ? `Latest: ${groups[0]._groupLabel}` : 'Latest'), h('option', { value: 'all' }, `All runs (${groups.length})`));
      for (const g of groups) surveySelect.append(h('option', { value: g._group }, g._groupLabel));
      surveySelect.value = surveySel;
      if (surveySelect.value !== surveySel) { surveySel = 'latest'; surveySelect.value = 'latest'; }
    }
    function inSelectedSurvey(r) {
      if (surveySel === 'all') return true;
      if (surveySel === 'latest') { const latest = rows.reduce((m, x) => (x._ts > m ? x._ts : m), ''); const g = rows.find((x) => x._ts === latest)?._group; return r._group === g; }
      return r._group === surveySel;
    }
    function match(r) {
      if (!inSelectedSurvey(r)) return false;
      if (!S.showQuiet && QUIET.has(r.state) && !S.states.has(r.state)) return false;
      if (S.states.size && !S.states.has(r.state)) return false;
      if (S.kinds.size && !S.kinds.has(r.kind)) return false;
      if (S.view === 'attn' && !ATTN.has(r.state)) return false;
      return matchQ(r, S.q);
    }
    function reset() { S.states.clear(); S.kinds.clear(); S.showQuiet = false; render(); }

    function card(r) {
      const isX = expanded.has(r._key);
      const detail = h('div', { hidden: !isX, style: { marginTop: '8px' } },
        kv([['Next step', r.next_step ? h('code', null, r.next_step) : null], ['Branch', r.branch ? h('code', null, r.branch) : null], ['Dir', r.cwd ? h('code', null, r.cwd) : null], ['Agent', r.agent], ['Last activity', r.last_activity], ['Window', r.window ? h('code', null, r.window) : null],
          ['Evidence', r.evidence], ['Source', r.source], ['Source file', r._file ? h('code', null, r._file) : null], ['Imported', r._ts ? fmtTime(r._ts) : null]]));
      const toggle = () => { if (expanded.has(r._key)) expanded.delete(r._key); else expanded.add(r._key); detail.hidden = !expanded.has(r._key); c.setAttribute('aria-expanded', detail.hidden ? 'false' : 'true'); };
      const c = h('article', { class: 'card', tabindex: 0, role: 'button', 'aria-expanded': isX ? 'true' : 'false', style: { cursor: 'pointer' }, onclick: toggle, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } } },
        h('h3', null, r.title || r.id || '(untitled)'),
        h('div', { class: 'toolbar', style: { margin: '0 0 6px', gap: '10px' } },
          mark(dotState(r.state), r.state || '?'),
          h('span', { class: 'muted small mono' }, [r.host, r.kind].filter(Boolean).join(' / ')),
          r.id && r.id !== r.title ? h('span', { class: 'faint small mono' }, r.id) : null,
          ...(r.activities || []).map((a) => h('code', { class: 'small' }, a)),
          ...(r.mrs || []).map((m) => h('code', { class: 'small' }, m))),
        r.summary ? h('p', { class: 'small', style: { margin: 0 } }, r.summary) : null,
        r.next_step && !isX ? h('div', { class: 'small muted', style: { marginTop: '6px' } }, h('span', { class: 'em' }, 'next: '), r.next_step) : null,
        detail);
      return c;
    }
    function group(list, keyf) {
      const m = new Map();
      for (const r of list) for (const k of (keyf(r)?.length ? keyf(r) : ['(none)'])) { if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
      return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
    }
    function render() {
      if (!alive) return;
      clear(bar); clear(stateChips); clear(kindChips); clear(listEl);
      if (!loaded) { listEl.append(loading('Reading the truth file')); return; }
      ctx.setCount('survey', rows.filter((r) => ATTN.has(r.state)).length || null);
      if (!rows.length) {
        meta.textContent = 'nothing imported';
        filters.hidden = true;
        listEl.append(h('div', { class: 'doc' },
          empty('No survey imported', 'Import a state-survey directory on the daemon host. Each *.json file there becomes survey-item events in the truth file; re-running skips files already imported.'),
          h('pre', { class: 'screen' }, 'drover import-survey <dir>\n\n# for example\ndrover import-survey $HOME/tmux-progress-20261011/state-survey'),
          h('p', { class: 'muted small' }, 'Then press Refresh here.')));
        return;
      }
      filters.hidden = false;
      const vis = rows.filter(match);
      const cnt = {}; for (const r of rows) cnt[r.state] = (cnt[r.state] || 0) + 1;
      const kcnt = {}; for (const r of rows) kcnt[r.kind] = (kcnt[r.kind] || 0) + 1;
      bar.append(seg(GROUPINGS, S.view, (v) => { S.view = v; render(); }), h('span', { class: 'muted small' }, `${vis.length} of ${plural(rows.length, 'row')} shown`));
      if (S.states.size || S.kinds.size || S.showQuiet) bar.append(btn('Reset filters', reset, { cls: 'sm quiet' }));
      for (const s of ORDER.filter((x) => cnt[x])) stateChips.append(chip(`${s} ${cnt[s]}`, S.states.has(s), () => { if (S.states.has(s)) S.states.delete(s); else S.states.add(s); render(); }, `${plural(cnt[s], 'item')} ${s}`));
      for (const s of all('state').filter((x) => !ORDER.includes(x))) stateChips.append(chip(`${s} ${cnt[s]}`, S.states.has(s), () => { if (S.states.has(s)) S.states.delete(s); else S.states.add(s); render(); }));
      stateChips.append(chip('show stopped and unreachable', S.showQuiet, () => { S.showQuiet = !S.showQuiet; render(); }, 'Quiet states are hidden unless picked'));
      for (const k of all('kind')) kindChips.append(chip(`${k} ${kcnt[k]}`, S.kinds.has(k), () => { if (S.kinds.has(k)) S.kinds.delete(k); else S.kinds.add(k); render(); }));
      if (!vis.length) { listEl.append(empty('Nothing matches', 'Loosen the filters or the search.')); return; }
      let groups;
      if (S.view === 'item') groups = group(vis, (r) => [...(r.activities || []), ...(r.mrs || [])].filter(Boolean));
      else if (S.view === 'state') groups = group(vis, (r) => [r.state]).sort((a, b) => ord(a[0]) - ord(b[0]));
      else groups = group(vis, (r) => [r.host]);
      const frag = document.createDocumentFragment();
      for (const [k, l] of groups) {
        const cards = h('div', { class: 'cards' });
        for (const r of l.slice().sort((a, b) => ord(a.state) - ord(b.state))) cards.append(card(r));
        frag.append(h('section', { class: 'group' }, h('div', { class: 'group-head' }, S.view === 'state' ? dot(dotState(k)) : null, h('h2', null, k), h('span', { class: 'meta' }, plural(l.length, 'item'))), cards));
      }
      listEl.append(frag);
    }
    async function load(quiet = false) {
      try {
        const st = await (quiet ? ctx.callQuiet : ctx.call)('events.state', {}, LOCAL);
        if (!alive) return;
        surveys = st.surveys ?? [];
        rows = (st.surveyItems ?? []).map((e) => {
          const isRun = String(e.surveyFile ?? '').startsWith('survey.run@');
          const group = isRun ? e.surveyFile : `import:${String(e.ts).slice(0, 16)}`; // imports: same minute = same run
          const label = isRun ? `re-survey ${fmtTime(e.surveyFile.slice('survey.run@'.length))}` : `imported ${fmtTime(e.ts)}`;
          return { ...(e.item ?? {}), _file: e.surveyFile, _ts: e.ts, _key: e.id, _group: group, _groupLabel: label };
        });
        drawSurveySelect();
        loaded = true;
        const last = surveys.at(-1);
        meta.textContent = rows.length ? `${plural(rows.length, 'row')} from ${plural(surveys.length, 'file')}${last ? `, last import ${fmtTime(last.ts)}` : ''}` : '';
        render();
      } catch (e) { if (!quiet) { loaded = true; clear(listEl); listEl.append(empty('Could not load the truth file', e.message)); } }
    }

    load();
    return {
      destroy() { alive = false; },
      search(q) { S.q = q; render(); },
      sse(type, d) { if (type === 'mutation' && d?.op === 'events.append') load(true); },
    };
  },
};
