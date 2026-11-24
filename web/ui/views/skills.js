// Learned skills (Find › Skills): the skills Claude Code and Codex agents wrote for themselves, kept by the dotfiles
// skill-workshop CLI on the selected host (ops skills.workshop.*, core/skills.js). Left: live skills most used first,
// drafts waiting for review, archived skills and the recent change feed. Right: what is open, a skill (its files, its
// history with Undo and "what changed", its saved versions with a diff against the live text and Restore), a draft
// (a diff against the skill it replaces, Apply, Discard) or an archived skill (its versions, Restore). The learning
// mode (auto, propose, off) sits in the head. Every write asks first, and goes in as the owner (actor user).
import { h, clear, ago, fmtTime, fmtAgo, matchQ, empty, loading, btn, kv, seg, plural } from '../dom.js';
import { lineDiff, hunks } from '../line-diff.js';

const MODES = [['auto', 'auto'], ['propose', 'propose'], ['off', 'off']];
const MODE_HINT = { auto: 'background reviews change skills at once; every change can be undone', propose: 'background reviews become drafts here for you to apply or discard', off: 'no background reviews, cleanup or diets; agents can still save skills when asked' };
const ACTOR = { agent: 'an agent', review: 'background review', curator: 'daily cleanup', user: 'you' };
const VERB = { create: 'created', patch: 'patched', write_file: 'wrote', remove_file: 'removed a file from', archive: 'archived', restore: 'restored', diet: 'slimmed', undo: 'undid' };
const kb = (n) => (n == null ? '' : n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
/** 20261124T013451Z-ab2c -> an ISO time, for fmtTime/fmtAgo. */
const versionTime = (v) => { const m = String(v ?? '').match(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z/); return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : null; };
const epochIso = (s) => (Number.isFinite(Number(s)) ? new Date(Number(s) * 1000).toISOString() : null);

export default {
  id: 'skills', label: 'Learned skills',
  mount(root, ctx) {
    let alive = true, q = '', filter = '';
    let data = null, feed = [], loadErr = null;   // skills.workshop.list and the change feed
    let sel = null;                                // { kind: 'skill' | 'draft' | 'archived', key }
    let detail = null;                             // what the right side loaded for sel
    let compare = null;                            // { title, before, after, note }
    let token = 0;                                 // the newest detail load; older answers are dropped

    // ---- head
    const modeBox = h('span');
    const modeHint = h('span', { class: 'muted small' });
    const hostEl = h('span', { class: 'muted small mono' });
    const filterIn = h('input', { type: 'search', placeholder: 'Filter skills, drafts, changes', 'aria-label': 'Learned skills filter', size: 28, oninput: () => { filter = filterIn.value; renderLeft(); } });
    const head = h('div', { class: 'view-head' }, h('h1', null, 'Learned skills'), h('label', { class: 'muted small' }, 'learning ', modeBox), modeHint, hostEl,
      h('span', { class: 'spacer' }), filterIn, btn('Refresh', () => load(), { cls: 'sm' }));
    const notice = h('div', { class: 'notice', hidden: true });

    // ---- left
    const skillsMeta = h('span', { class: 'meta' }), skillsList = h('div');
    const draftsMeta = h('span', { class: 'meta' }), draftsList = h('div');
    const archMeta = h('span', { class: 'meta' }), archList = h('div');
    const feedMeta = h('span', { class: 'meta' }), feedList = h('div');
    const group = (title, meta, body) => h('section', { class: 'group', style: { marginBottom: '14px' } }, h('div', { class: 'group-head' }, h('h2', null, title), meta), body);
    const left = h('div', null, group('Skills', skillsMeta, skillsList), group('Drafts', draftsMeta, draftsList), group('Archived', archMeta, archList), group('Recent changes', feedMeta, feedList));
    const right = h('div');
    root.append(head, notice, h('div', { class: 'split' }, left, right));

    const f = () => filter.trim().toLowerCase();
    const hit = (o) => (!f() || JSON.stringify(o).toLowerCase().includes(f())) && matchQ(o, q);
    const undone = () => new Set(feed.filter((r) => r.action === 'undo' && r.undoes).map((r) => r.undoes));
    const isSel = (kind, key) => sel?.kind === kind && sel?.key === key;
    const open = (kind, key) => { sel = { kind, key }; compare = null; renderLeft(); loadDetail(); };
    const rowKeys = (fn) => ({ tabindex: 0, onclick: fn, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } } });

    function renderMode() {
      clear(modeBox); modeHint.textContent = '';
      if (!data?.available) return;
      modeBox.append(seg(MODES, data.mode, (m) => setMode(m)));
      modeHint.textContent = MODE_HINT[data.mode] ?? '';
    }

    function renderLeft() {
      if (!alive) return;
      hostEl.textContent = ctx.host() === 'local' ? 'this machine' : ctx.host();
      for (const el of [skillsList, draftsList, archList, feedList]) clear(el);
      if (loadErr) { notice.hidden = false; notice.className = 'notice error'; notice.textContent = `skills.workshop.list failed: ${loadErr}`; }
      else if (data && !data.available) { notice.hidden = false; notice.className = 'notice'; notice.textContent = `No skill-workshop CLI on ${ctx.host() === 'local' ? 'this machine' : ctx.host()}: ${data.error}. Install the dotfiles scripts there, or set DROVER_SKILL_WORKSHOP_BIN for the daemon.`; }
      else notice.hidden = true;
      if (!data) { skillsList.append(loadErr ? empty('Could not read the store') : loading('Reading the learned skills')); return; }
      if (!data.available) { skillsList.append(empty('No learned skills here', 'This host has no skill-workshop CLI.')); return; }

      const live = (data.skills ?? []).filter(hit);
      skillsMeta.textContent = `${plural(data.skills?.length ?? 0, 'live skill')}, most used first`;
      if (!live.length) skillsList.append(empty(data.skills?.length ? 'Nothing matches' : 'No learned skills yet', data.skills?.length ? 'Loosen the filter.' : 'Agents save one after hard multi-step work or when you correct their method.'));
      for (const s of live) {
        skillsList.append(h('div', { class: 'row', 'aria-selected': isSel('skill', s.name) ? 'true' : 'false', ...rowKeys(() => open('skill', s.name)) },
          h('span', { class: 'mono small', style: { minWidth: '54px', textAlign: 'right' }, title: 'sessions that read it' }, plural(s.uses ?? 0, 'use')),
          h('div', { class: 'main-col' },
            h('div', { class: 'l1' }, h('span', { class: 'mono' }, s.name), s.files?.length > 1 ? h('span', { class: 'faint small' }, plural(s.files.length, 'file')) : null),
            h('div', { class: 'l2', title: s.description }, s.description || '(no description)')),
          h('span', { class: 'muted small mono', style: { textAlign: 'right' } }, s.lastUsed ? `read ${fmtAgo(s.lastUsed)}` : 'never read', h('br'), kb(s.bytes))));
      }

      const drafts = (data.drafts ?? []).filter(hit);
      draftsMeta.textContent = data.drafts?.length ? `${plural(data.drafts.length, 'draft')} waiting` : '';
      if (!drafts.length) draftsList.append(empty(data.drafts?.length ? 'Nothing matches' : 'No drafts waiting', data.mode === 'propose' && !data.drafts?.length ? 'Background reviews in propose mode land here.' : ''));
      for (const d of drafts) {
        draftsList.append(h('div', { class: 'row', 'aria-selected': isSel('draft', d.id) ? 'true' : 'false', ...rowKeys(() => open('draft', d.id)) },
          h('span', { class: 'em small', style: { minWidth: '54px' } }, d.replaces ? 'update' : 'new'),
          h('div', { class: 'main-col' },
            h('div', { class: 'l1' }, h('span', { class: 'mono' }, d.skill), d.absorbs ? h('span', { class: 'faint small' }, `absorbs ${d.absorbs}`) : null),
            h('div', { class: 'l2', title: d.reason }, [d.reason || '(no reason)', d.id].join('   '))),
          h('span', { class: 'muted small mono' }, [ACTOR[d.actor] ?? d.actor, d.host, d.createdAt ? fmtAgo(d.createdAt) : null].filter(Boolean).join(' · '))));
      }

      const arch = (data.archived ?? []).filter(hit);
      archMeta.textContent = data.archived?.length ? plural(data.archived.length, 'archived skill') : '';
      if (!arch.length) archList.append(empty(data.archived?.length ? 'Nothing matches' : 'None archived', ''));
      for (const a of arch) {
        archList.append(h('div', { class: 'row', 'aria-selected': isSel('archived', a.name) ? 'true' : 'false', ...rowKeys(() => open('archived', a.name)) },
          h('span', { class: 'faint small', style: { minWidth: '54px' } }, 'archived'),
          h('div', { class: 'main-col' }, h('div', { class: 'l1' }, h('span', { class: 'mono muted' }, a.name)),
            h('div', { class: 'l2' }, a.versions?.[0] ? `newest copy ${fmtTime(versionTime(a.versions[0]))}` : 'no saved copy')),
          a.versions?.[0] ? btn('Restore', (e) => { e.stopPropagation(); restore(a.name, a.versions[0]); }, { cls: 'sm quiet', title: 'Bring back the newest saved copy' }) : h('span')));
      }

      const rows = feed.filter(hit).slice(0, 40);
      feedMeta.textContent = feed.length ? 'newest first, every machine' : '';
      if (!rows.length) feedList.append(empty(feed.length ? 'Nothing matches' : 'No changes yet', ''));
      const gone = undone();
      for (const r of rows) feedList.append(changeRow(r, gone, { onOpen: () => { const name = String(r.skill ?? '').split(',')[0]; if (data.skills?.some((s) => s.name === name)) open('skill', name); else if (data.archived?.some((a) => a.name === name)) open('archived', name); } }));
    }

    /** One change: what, who, why, when; Undo (and Undo review run) unless it was undone or is an undo itself. */
    function changeRow(r, gone, { onOpen, onDiff } = {}) {
      const isUndone = gone.has(r.id) || (r.run && gone.has(r.run));
      const actions = h('span', { class: 'toolbar', style: { margin: 0 } },
        onDiff && r.action !== 'undo' ? btn('What changed', (e) => { e.stopPropagation(); onDiff(); }, { cls: 'sm quiet', title: 'Diff the copy saved before this change with the text after it' }) : null,
        r.action !== 'undo' && !isUndone ? btn('Undo', (e) => { e.stopPropagation(); undo(r.id, `${VERB[r.action] ?? r.action} ${r.skill}`); }, { cls: 'sm quiet', title: `skill-workshop undo ${r.id}` }) : null,
        r.run && r.action !== 'undo' && !isUndone ? btn('Undo review', (e) => { e.stopPropagation(); undo(r.run, `every change of background review ${r.run}`); }, { cls: 'sm quiet', title: `skill-workshop undo ${r.run}: every change that review made` }) : null);
      return h('div', { class: 'row', ...(onOpen ? rowKeys(onOpen) : { class: 'row static' }) },
        h('span', { class: 'em small', style: { minWidth: '54px' } }, r.action),
        h('div', { class: 'main-col' },
          h('div', { class: 'l1' }, h('span', { class: isUndone ? 'muted' : '' }, `${ACTOR[r.actor] ?? r.actor ?? '?'} ${VERB[r.action] ?? r.action} `, h('span', { class: 'mono' }, r.skill ?? '?'), r.file && r.file !== 'SKILL.md' ? h('span', { class: 'mono faint small' }, ` ${r.file}`) : null),
            isUndone ? h('span', { class: 'faint small' }, 'undone') : null),
          h('div', { class: 'l2', title: r.reason ?? '' }, [r.reason, r.id, r.run, r.host, r.ts ? fmtAgo(r.ts) : null].filter(Boolean).join('   '))),
        actions);
    }

    // ---- right
    function renderRight() {
      if (!alive) return;
      clear(right);
      if (!sel) { right.append(empty('Open a skill, a draft or an archived skill', 'Its text, history and saved versions show here.')); return; }
      if (!detail || detail.key !== `${sel.kind}:${sel.key}`) { right.append(loading('Reading')); return; }
      if (detail.error) { right.append(h('div', { class: 'notice error' }, detail.error)); return; }
      if (sel.kind === 'skill') renderSkill(); else if (sel.kind === 'draft') renderDraft(); else renderArchived();
      if (compare) right.prepend(diffBox(compare));
    }

    function renderSkill() {
      const s = data?.skills?.find((x) => x.name === sel.key);
      const d = detail;
      const fileSel = h('select', { 'aria-label': 'File', onchange: () => openFile(fileSel.value) }, (s?.files ?? ['SKILL.md']).map((n) => h('option', { value: n, selected: n === d.file ? true : null }, n)));
      right.append(
        h('section', { class: 'group' },
          h('div', { class: 'group-head' }, h('h2', { class: 'mono' }, sel.key), h('span', { class: 'spacer', style: { flex: 1 } }),
            btn('Archive', () => archive(sel.key), { cls: 'sm quiet danger', title: 'Hide this skill (a copy is saved; Restore brings it back)' })),
          s?.description ? h('p', { class: 'small', style: { margin: '4px 0 8px' } }, s.description) : null,
          kv([['used', s ? `${plural(s.uses ?? 0, 'session')}${s.lastUsed ? `, last ${fmtTime(s.lastUsed)}` : ''}` : null], ['size', s ? kb(s.bytes) : null], ['updated', s?.updated ? ago(epochIso(s.updated)) : null],
            ['files', s?.files?.length ? s.files.join(', ') : null]]),
          h('div', { class: 'toolbar', style: { margin: '10px 0 6px' } }, h('label', { class: 'muted small' }, 'file ', fileSel)),
          h('pre', { class: 'screen tall' }, d.text ?? '')),
        historySection(d.changes ?? [], d.text),
        versionsSection(sel.key, d.versions ?? [], { live: true }));
    }

    function historySection(rows, liveText) {
      const gone = undone();
      const body = h('div');
      if (!rows.length) body.append(empty('No changes recorded', ''));
      const real = rows.filter((r) => r.action !== 'undo');
      for (const r of rows) {
        const newer = real[real.indexOf(r) - 1];   // the next change after r (rows are newest first), if any
        body.append(changeRow(r, gone, { onDiff: () => diffChange(r, newer, liveText) }));
      }
      return h('section', { class: 'group', style: { marginTop: '14px' } }, h('div', { class: 'group-head' }, h('h2', null, 'History'), h('span', { class: 'meta' }, rows.length ? 'newest first' : '')), body);
    }

    function versionsSection(name, versions, { live }) {
      const body = h('div');
      if (!versions.length) body.append(empty('No saved versions', 'A copy is saved before every change.'));
      for (const v of versions) {
        body.append(h('div', { class: 'row static' },
          h('span', { class: 'mono small', style: { minWidth: '54px' } }, fmtAgo(versionTime(v))),
          h('div', { class: 'main-col' }, h('div', { class: 'l1 mono small' }, v), h('div', { class: 'l2' }, fmtTime(versionTime(v)))),
          h('span', { class: 'toolbar', style: { margin: 0 } },
            live ? btn('Diff vs live', () => diffVersion(name, v), { cls: 'sm quiet', title: 'This saved copy against the live text' }) : btn('View', () => viewVersion(name, v), { cls: 'sm quiet' }),
            btn('Restore', () => restore(name, v), { cls: 'sm quiet', title: live ? 'Put this copy back (the current text is saved first)' : 'Bring the skill back from this copy' }))));
      }
      return h('section', { class: 'group', style: { marginTop: '14px' } }, h('div', { class: 'group-head' }, h('h2', null, 'Saved versions'), h('span', { class: 'meta' }, versions.length ? 'newest first' : '')), body);
    }

    function renderDraft() {
      const dr = data?.drafts?.find((x) => x.id === sel.key);
      if (!dr) { right.append(empty('That draft is gone', 'It was applied or discarded.')); return; }
      const d = detail;
      right.append(h('section', { class: 'group' },
        h('div', { class: 'group-head' }, h('h2', null, 'Draft for ', h('span', { class: 'mono' }, dr.skill)), h('span', { class: 'meta' }, dr.id), h('span', { style: { flex: 1 } }),
          btn('Discard', () => discardDraft(dr), { cls: 'sm quiet danger', title: 'Delete the draft; no skill changes' }),
          btn('Apply', () => applyDraft(dr), { cls: 'sm primary', title: dr.replaces ? `Rewrite ${dr.skill} with this draft (the current text is saved first)` : `Create ${dr.skill}` })),
        kv([['reason', dr.reason || null], ['what', dr.replaces ? `rewrites the live ${dr.skill}` : 'a new skill'], ['absorbs', dr.absorbs ? `${dr.absorbs} (archived when applied)` : null],
          ['by', [ACTOR[dr.actor] ?? dr.actor, dr.host].filter(Boolean).join(' on ')], ['created', dr.createdAt ? fmtTime(dr.createdAt) : null], ['run', dr.run], ['session', dr.session ? h('code', null, dr.session) : null]]),
        dr.replaces && d.live != null
          ? diffBox({ title: `live ${dr.skill} → this draft`, before: d.live, after: d.text, inline: true })
          : h('pre', { class: 'screen tall', style: { marginTop: '10px' } }, d.text ?? '')));
    }

    function renderArchived() {
      const a = data?.archived?.find((x) => x.name === sel.key);
      const d = detail;
      right.append(h('section', { class: 'group' },
        h('div', { class: 'group-head' }, h('h2', { class: 'mono' }, sel.key), h('span', { class: 'meta' }, 'archived')),
        d.viewing ? h('div', null, h('div', { class: 'muted small', style: { margin: '4px 0' } }, `saved copy ${d.viewing}`), h('pre', { class: 'screen tall' }, d.text ?? '')) : empty('Archived', a ? 'View a saved copy, or Restore one to bring the skill back.' : '')),
      historySection(d.changes ?? [], ''),
      versionsSection(sel.key, d.versions ?? [], { live: false }));
    }

    /** A unified diff of before -> after: hunks with three lines of context, + and - lines tinted. */
    function diffBox({ title, before, after, note, inline }) {
      const d = lineDiff(before ?? '', after ?? '');
      const hs = hunks(d.ops);
      const pre = h('pre', { class: 'screen tall diff' });
      if (!hs.length) pre.append(h('span', { class: 'faint' }, 'No differences.'));
      for (const hk of hs) {
        pre.append(h('span', { class: 'diff-hunk' }, `@@ -${hk.aStart},${hk.aLines} +${hk.bStart},${hk.bLines} @@`), '\n');
        for (const o of hk.ops) pre.append(h('span', { class: o.t === '+' ? 'diff-add' : o.t === '-' ? 'diff-del' : 'diff-ctx' }, `${o.t} ${o.s}`), '\n');
      }
      return h('section', { class: 'group', style: { margin: inline ? '10px 0 0' : '0 0 14px' } },
        h('div', { class: 'group-head' }, h('h3', { style: { margin: 0 } }, title), h('span', { class: 'meta' }, `+${d.added} −${d.removed}${d.exact ? '' : ' (too large to align; shown as replaced)'}`),
          h('span', { style: { flex: 1 } }), inline ? null : btn('Close', () => { compare = null; renderRight(); }, { cls: 'sm quiet' })),
        note ? h('div', { class: 'muted small', style: { margin: '4px 0' } }, note) : null, pre);
    }

    // ---- loading
    const read = (args) => ctx.callQuiet('skills.workshop.read', args).then((r) => r.text);
    /** A file's text, or '' where it does not exist (a skill that was not live then, a file added later). */
    const readOr = (args) => read(args).catch(() => '');

    async function load(quiet = false) {
      const call = quiet ? ctx.callQuiet : ctx.call;
      const [l, c] = await Promise.allSettled([call('skills.workshop.list', {}), ctx.callQuiet('skills.workshop.changes', { limit: 200 })]);
      if (!alive) return;
      if (l.status === 'fulfilled') { data = l.value; loadErr = null; } else { loadErr = l.reason?.message ?? 'failed'; }
      feed = c.status === 'fulfilled' && Array.isArray(c.value) ? c.value : [];
      // What is open may be gone (a draft applied, a skill archived or undone here or on another machine): follow a
      // skill to where it is now, and close anything that is nowhere.
      if (sel && data?.available) {
        const live = data.skills?.some((s) => s.name === sel.key), arch = data.archived?.some((a) => a.name === sel.key);
        if (sel.kind === 'draft' && !data.drafts?.some((d) => d.id === sel.key)) { sel = null; detail = null; compare = null; }
        else if (sel.kind === 'skill' && !live) sel = arch ? { kind: 'archived', key: sel.key } : null;
        else if (sel.kind === 'archived' && live) sel = { kind: 'skill', key: sel.key };
      }
      renderMode(); renderLeft();
      if (sel && data?.available) loadDetail({ keepCompare: true }); else renderRight();
    }

    async function loadDetail({ keepCompare = false } = {}) {
      if (!sel) { renderRight(); return; }
      const mine = ++token, key = `${sel.kind}:${sel.key}`, cur = sel;
      if (!keepCompare) compare = null;
      if (detail?.key !== key) { detail = null; renderRight(); }
      try {
        let next;
        if (cur.kind === 'skill') {
          const file = detail?.key === key ? detail.file : 'SKILL.md';
          const [text, versions, changes] = await Promise.all([read({ name: cur.key, file }), ctx.callQuiet('skills.workshop.versions', { name: cur.key }), ctx.callQuiet('skills.workshop.changes', { skill: cur.key, limit: 100 })]);
          next = { key, file, text, versions, changes };
        } else if (cur.kind === 'draft') {
          const dr = data?.drafts?.find((x) => x.id === cur.key);
          const [text, live] = await Promise.all([read({ draft: cur.key }), dr?.replaces ? readOr({ name: dr.skill }) : null]);
          next = { key, text, live };
        } else {
          const [versions, changes] = await Promise.all([ctx.callQuiet('skills.workshop.versions', { name: cur.key }), ctx.callQuiet('skills.workshop.changes', { skill: cur.key, limit: 100 })]);
          const viewing = detail?.key === key ? detail.viewing : versions[0] ?? null;
          next = { key, versions, changes, viewing, text: viewing ? await readOr({ name: cur.key, version: viewing }) : null };
        }
        if (alive && mine === token) { detail = next; renderRight(); }
      } catch (e) { if (alive && mine === token) { detail = { key, error: e.message }; renderRight(); } }
    }

    async function openFile(file) {
      if (sel?.kind !== 'skill' || !detail) return;
      try { const text = await ctx.call('skills.workshop.read', { name: sel.key, file }).then((r) => r.text); detail = { ...detail, file, text }; renderRight(); } catch { /* toasted */ }
    }
    async function viewVersion(name, v) {
      try { const text = await ctx.call('skills.workshop.read', { name, version: v }).then((r) => r.text); detail = { ...detail, viewing: v, text }; renderRight(); } catch { /* toasted */ }
    }
    async function diffVersion(name, v) {
      const file = detail?.file ?? 'SKILL.md';
      try {
        const [before, after] = await Promise.all([readOr({ name, version: v, file }), read({ name, file })]);
        compare = { title: `${name}/${file}: saved ${v} → live`, before, after, note: `Saved ${fmtTime(versionTime(v))}. Restore puts that copy back.` };
        renderRight();
      } catch (e) { ctx.toast(`diff: ${e.message}`, 'error'); }
    }
    /** What one change did: the copy saved before it, against the copy saved before the next change (or the live text). */
    async function diffChange(r, newer, liveText) {
      const name = String(r.skill ?? '');
      const file = r.file ?? 'SKILL.md';
      try {
        const before = r.version ? await readOr({ name, version: r.version, file }) : '';
        const after = newer ? (newer.version ? await readOr({ name, version: newer.version, file }) : '') : file === (detail?.file ?? 'SKILL.md') && liveText != null ? liveText : await readOr({ name, file });
        compare = { title: `${name}/${file}: ${VERB[r.action] ?? r.action} ${r.ts ? fmtAgo(r.ts, { short: false }) : ''}`, before, after, note: [r.reason, `${ACTOR[r.actor] ?? r.actor}${r.host ? ` on ${r.host}` : ''}`, r.id].filter(Boolean).join(' · ') };
        renderRight();
      } catch (e) { ctx.toast(`diff: ${e.message}`, 'error'); }
    }

    // ---- writes (each one asks first)
    const where = () => (ctx.host() === 'local' ? 'this machine' : ctx.host());
    async function write(op, args, done) {
      try { const r = await ctx.call(op, args); ctx.toast(done(r), 'ok'); await load(true); return r; } catch { return null; /* toasted */ }
    }
    function undo(id, what) {
      if (!window.confirm(`Undo ${what} (${id}) in the learned skills on ${where()}? Each skill goes back to the copy saved before it; the undo can itself be undone.`)) return;
      write('skills.workshop.undo', { id }, (r) => (r.status === 'already-undone' ? `${id} was already undone` : `Undid ${id}`));
    }
    function restore(name, version) {
      if (!window.confirm(`Restore ${name} from the copy saved ${fmtTime(versionTime(version))} (${version})? The current text is saved first.`)) return;
      write('skills.workshop.restore', { name, version }, (r) => `Restored ${name} (${r.id ?? ''})`).then((r) => { if (r && sel?.kind === 'archived' && sel.key === name) open('skill', name); });
    }
    function archive(name) {
      const reason = window.prompt(`Archive ${name}? It stops loading for agents; a copy is kept and Restore brings it back.\n\nWhy (shown in the change feed):`, 'no longer needed');
      if (reason === null || !reason.trim()) return;
      write('skills.workshop.archive', { name, reason: reason.trim() }, (r) => `Archived ${name} (${r.id ?? ''})`).then((r) => { if (r) open('archived', name); });
    }
    function applyDraft(dr) {
      if (!window.confirm(`Apply draft ${dr.id} to ${dr.skill}${dr.absorbs ? ` (and archive ${dr.absorbs})` : ''}? ${dr.replaces ? 'The current text is saved first.' : 'This creates the skill.'}`)) return;
      write('skills.workshop.applyDraft', { id: dr.id }, (r) => `Applied ${dr.id} to ${dr.skill} (${r.id ?? ''})`).then((r) => { if (r) open('skill', dr.skill); });
    }
    function discardDraft(dr) {
      if (!window.confirm(`Discard draft ${dr.id} for ${dr.skill}? No skill changes; the draft is deleted.`)) return;
      write('skills.workshop.discardDraft', { id: dr.id }, () => `Discarded ${dr.id}`).then((r) => { if (r) { sel = null; detail = null; renderLeft(); renderRight(); } });
    }
    function setMode(m) {
      if (m === data?.mode) return;
      if (!window.confirm(`Set the learning mode to ${m}? It is synced: every machine that shares this dotfiles store follows it.\n\n${m}: ${MODE_HINT[m]}`)) { renderMode(); return; }
      write('skills.workshop.setMode', { mode: m }, (r) => `Learning mode: ${r.mode}`).then((r) => { if (!r) renderMode(); });
    }

    renderLeft(); renderRight();
    load();
    const timer = setInterval(() => { if (!document.hidden) load(true); }, 90_000);
    return {
      destroy() { alive = false; clearInterval(timer); },
      search(qq) { q = qq; renderLeft(); },
    };
  },
};
