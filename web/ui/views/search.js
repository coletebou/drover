// Search: find what was said in any Claude Code or Codex session (and in truth-file
// notes, messages, survey items, memory notes and preserved refs) on every
// machine, by meaning and by exact words, through search.fleet / search.semantic
// (core/search). A hit opens its session in the drawer; the resume command (for a
// preserved ref, the restore command) is one click away.
import { h, clear, btn, empty, loading, fmtTime, debounce, plural, seg, chip, engine, kv } from '../dom.js';
import { hostTime, hostTimeTitle, slowHost } from '../fleet-time.js';

const KINDS = [['claude', 'Claude'], ['subagent', 'Subagents'], ['codex', 'Codex'], ['wal', 'Notes and messages'], ['memory', 'Memory'], ['doc', 'Docs'], ['reflection', 'Reflections'], ['preserved', 'Preserved refs']];
/** The badge on a hit that is not from an agent session; any other kind is a truth-file event (WAL). */
const BADGES = new Map([['memory', 'MEM'], ['doc', 'DOC'], ['reflection', 'REFL'], ['preserved', 'REF']]);
const PREF = 'drover.search.prefs';

export function resumeCommand(r) {
  // A preserved ref is restored, not resumed: the search hit carries the command (the plugin's restoreCommand, core/search/query.js).
  if (r.kind === 'preserved') return r.restore ?? null;
  if (!r.sessionId) return null;
  if (r.kind === 'claude' || r.kind === 'subagent') return `claude --resume ${r.sessionId}`;
  // A Codex rollout summary (kind doc) carries the thread it summarizes.
  if (r.kind === 'codex' || r.kind === 'doc') return `codex resume ${r.sessionId}`;
  return null;
}

export default {
  id: 'search', label: 'Search', key: 'g',
  mount(root, ctx, params) {
    let alive = true, seq = 0;
    const prefs = { scope: 'fleet', mode: 'hybrid', days: 0, kinds: [], ...JSON.parse(localStorage.getItem(PREF) || '{}') };
    const save = () => localStorage.setItem(PREF, JSON.stringify(prefs));

    const meta = h('span', { class: 'muted small' });
    const input = h('input', { type: 'search', class: 'search-q', placeholder: 'What are you looking for? Plain words, or exact strings like !1234, a SHA or a file name', 'aria-label': 'Search sessions', autofocus: true,
      onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); run(input.value); } }, oninput: debounce(() => { if (input.value.trim().length >= 3) run(input.value); }, 450) });
    const kindsEl = h('div', { class: 'chips' });
    const drawKinds = () => { clear(kindsEl); for (const [k, label] of KINDS) kindsEl.append(chip(label, prefs.kinds.includes(k), () => { prefs.kinds = prefs.kinds.includes(k) ? prefs.kinds.filter((x) => x !== k) : [...prefs.kinds, k]; save(); drawKinds(); rerun(); })); };
    const daysSel = h('select', { 'aria-label': 'How far back', onchange: () => { prefs.days = Number(daysSel.value); save(); rerun(); } },
      ...[[0, 'any time'], [1, 'last day'], [7, 'last week'], [30, 'last month'], [90, 'last 3 months']].map(([v, l]) => h('option', { value: v, selected: prefs.days === v ? true : null }, l)));
    const controls = h('div', { class: 'search-controls' },
      seg([['fleet', 'Every machine'], ['host', 'Selected host']], prefs.scope, (v) => { prefs.scope = v; save(); rerun(); }),
      seg([['hybrid', 'Words + meaning'], ['keyword', 'Exact words'], ['semantic', 'Meaning']], prefs.mode, (v) => { prefs.mode = v; save(); rerun(); }),
      daysSel, kindsEl);
    const status = h('div', { class: 'muted small search-status' });
    const list = h('div', { class: 'search-results' });
    const head = h('div', { class: 'view-head' }, h('h1', null, 'Search'), meta, h('span', { class: 'spacer' }), btn('Index status', () => showStatus(), { cls: 'sm quiet', title: 'Chunks, vectors and the embedding runtime on the selected host' }));
    root.append(head, h('div', { class: 'search-bar' }, input, btn('Search', () => run(input.value), { cls: 'sm primary' })), controls, status, list);
    drawKinds();
    meta.textContent = 'sessions, notes, memory and preserved refs on every machine';

    const rerun = () => { if (input.value.trim()) run(input.value); };
    async function run(text) {
      const query = String(text ?? '').trim();
      if (!query) return;
      const mine = ++seq;
      clear(list); list.append(loading(prefs.scope === 'fleet' ? 'Searching every machine' : 'Searching'));
      clear(status);
      const args = { query, limit: 30, mode: prefs.mode, ...(prefs.days ? { days: prefs.days } : {}), ...(prefs.kinds.length ? { kinds: prefs.kinds } : {}) };
      try {
        const r = prefs.scope === 'fleet' ? await ctx.callQuiet('search.fleet', args, { host: 'local' }) : await ctx.callQuiet('search.semantic', args, { host: ctx.host() });
        if (!alive || mine !== seq) return;
        ctx.nav('search', query);
        paint(r, { route: prefs.scope === 'fleet' ? null : ctx.host() });
      } catch (e) { if (alive && mine === seq) { clear(list); list.append(empty('Search failed', e.message)); } }
    }
    /** opts.route: the host alias a single-host search ran on (its hits carry that machine's hostname, which may not be an alias). */
    function paint(r, opts = {}) {
      clear(list); clear(status);
      const per = r.perHost ?? [{ host: r.host, ok: true, hits: r.results?.length ?? 0, vector: r.vector, index: r.index, notes: r.notes }];
      // A host's time shows inline only when it was slow (a second or more), in the CLI's form so it reads as that
      // host's ("devbox: 2 in 6.6 s (search 212 ms)"); the tooltip always has it.
      const slow = (p) => (slowHost(p) ? ` in ${hostTime(p)}` : '');
      status.append(`${plural(r.results.length, 'result')} in ${r.ms} ms · `, ...per.flatMap((p, i) => [i ? ' · ' : '', h('span', { class: p.ok ? '' : 'em', title: [p.error ?? (p.notes ?? []).join('\n'), hostTimeTitle(p)].filter(Boolean).join('\n') }, `${p.host}: ${p.ok ? `${p.hits}${p.vector && p.vector !== 'ok' ? ` (vectors ${p.vector})` : ''}${slow(p)}` : 'error'}`)]));
      const miss = [...(r.coverage?.notCovered ?? []), ...(r.coverage?.partial ?? [])];
      if (miss.length) status.append(h('div', { class: 'small em', title: miss.map((x) => `${x.host}: ${x.reason}`).join('\n') }, `Not covered: ${miss.map((x) => x.host).join(', ')}`));
      if (!r.results.length) { list.append(empty('No matches', 'Try other words, or switch to Meaning to match ideas rather than words.')); return; }
      for (const it of r.results) {
        const cmd = resumeCommand(it);
        const host = it.host ?? r.host ?? 'local';
        const canOpen = it.sessionId && ['claude', 'subagent', 'codex', 'doc'].includes(it.kind);
        const route = it.route ?? opts.route ?? 'local';
        const open = () => ctx.open({ kind: 'session', id: it.sessionId, host: route, engine: it.kind === 'codex' || it.kind === 'doc' ? 'codex' : 'claude', name: it.title ?? undefined });
        list.append(h('article', { class: 'search-hit', role: canOpen ? 'button' : null, tabindex: canOpen ? 0 : null, onclick: canOpen ? open : null, onkeydown: canOpen ? (e) => { if (e.key === 'Enter') open(); } : null },
          h('div', { class: 'l1' },
            it.kind === 'codex' ? engine('codex') : it.kind === 'claude' || it.kind === 'subagent' ? engine('claude') : h('span', { class: 'engine' }, BADGES.get(it.kind) ?? 'WAL'),
            h('b', { class: 'trunc' }, it.title || '(untitled)'),
            h('span', { class: 'muted small' }, [it.project, it.kind === 'subagent' ? 'subagent' : null, it.role, it.kind === 'reflection' ? it.status : null].filter(Boolean).join(' · ')),
            h('span', { class: 'spacer' }),
            h('span', { class: 'muted small', title: (it.hosts ?? [host]).join(', ') }, (it.hosts?.length ?? 1) > 1 ? `${host} +${it.hosts.length - 1}` : host),
            h('span', { class: 'muted small' }, fmtTime(it.ts))),
          h('p', { class: 'search-snippet' }, it.snippet),
          h('div', { class: 'l2 small muted' },
            [it.legs?.exact ? 'exact match' : null, it.legs?.fts ? `words #${it.legs.fts}` : null, it.legs?.vec ? `meaning #${it.legs.vec.rank}` : null].filter(Boolean).join(' · '),
            cmd ? h('span', null, ' · ', h('code', null, cmd), ' ', btn('Copy', async (e) => { e.stopPropagation(); try { await navigator.clipboard.writeText(cmd); ctx.toast(it.kind === 'preserved' ? 'Restore command copied' : 'Resume command copied', 'ok'); } catch { window.prompt('Copy:', cmd); } }, { cls: 'sm quiet' })) : null)));
      }
    }
    async function showStatus() {
      clear(list); list.append(loading('Reading the index'));
      try {
        const s = await ctx.callQuiet('search.status', {}, { host: ctx.host() });
        if (!alive) return;
        clear(list);
        const ix = s.index ?? {}; const em = s.embedder ?? {}; const idx = s.indexer ?? {};
        list.append(h('section', { class: 'card' }, h('h2', null, `Index on ${s.host}`), kv([
          ['Chunks', ix.chunks != null ? `${ix.chunks} (${ix.distinct ?? '?'} distinct)` : 'none yet'],
          ['Vectors', ix.vectors != null ? `${ix.vectors}${idx.pending != null ? `, ${idx.pending} pending` : ''}` : ''],
          ['Keyword only', ix.keywordOnly != null ? `${ix.keywordOnly} command chunks (no vectors)` : ''],
          ['Covers', idx.scope ? `${idx.scope.kinds.join(', ')}${idx.scope.identity ? ` · identity ${idx.scope.identity}` : ''} · ${idx.scope.docs.length} doc patterns` : ''],
          ['By source', Object.entries(ix.kinds ?? {}).map(([k, v]) => `${k} ${v.chunks}`).join(' · ')],
          ['Newest turn', fmtTime(ix.newest)],
          ['Last pass', idx.lastTick ? `${fmtTime(idx.lastTick)} (${idx.lastMs} ms)${idx.busy ? ', running now' : ''}` : ''],
          ['Embedder', em.installed === false ? 'not installed: run drover embed setup on that host' : `${em.running ? 'running' : 'idle'}, ${em.threads ?? '?'} threads${em.tokensPerSec ? `, ${em.tokensPerSec} tokens/s` : ''}`],
          ['Last error', idx.lastError ?? em.lastError ?? ''],
          ['Database', s.db ? `${(s.db.bytes / 1e6).toFixed(1)} MB` : ''],
          ['Note', s.note ?? ''],
        ])));
      } catch (e) { clear(list); list.append(empty('Status failed', e.message)); }
    }

    const want = params?.[0];
    if (want) { input.value = want; run(want); } else input.focus();
    return {
      destroy() { alive = false; },
      params(p) { if (p?.[0] && p[0] !== input.value.trim()) { input.value = p[0]; run(p[0]); } },
      search(v) { input.value = v; if (v.trim().length >= 3) debounce(() => run(v), 450)(); },
    };
  },
};
