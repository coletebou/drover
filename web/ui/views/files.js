// Files: an editor for the files that steer the agents (memory, CLAUDE.md /
// AGENTS.md, skills, agent settings) on the selected host, through the
// files.* ops and their allowlist (~/.dotfiles, ~/.claude, ~/.codex,
// ~/code/*/CLAUDE.md and AGENTS.md). Saves are conflict-checked against the
// sha256 the file was loaded with. "Save a copy" and "Open from disk" use the
// File System Access API on this computer.
import { h, clear, btn, empty, loading, fmtTime, debounce, plural } from '../dom.js';
import { saveText, openTextFile, copyButton } from '../clip.js';
import { fmtBytes } from '../drawer.js';

const LAST_KEY = 'drover.files.last';

export default {
  id: 'files', label: 'Files', key: 'f',
  mount(root, ctx, params) {
    let alive = true; let roots = null; let current = null; let dir = null; let q = '';
    const host = () => ctx.host();
    const call = (op, args) => ctx.call(op, args, { host: host() });

    const meta = h('span', { class: 'muted small' });
    const head = h('div', { class: 'view-head' }, h('h1', null, 'Files'), meta, h('span', { class: 'spacer' }),
      btn('Open from disk', async () => { const f = await openTextFile(); if (!f || !current) { if (f && !current) ctx.toast('Open a file here first, then load disk content into it', 'info'); return; } ta.value = f.text; markDirty(); ctx.toast(`Loaded ${f.name} into the editor (not saved yet)`, 'ok'); }, { cls: 'sm quiet', title: 'Replace the editor text with a file from this computer' }),
      btn('Refresh', () => loadRoots(true), { cls: 'sm quiet' }));
    const search = h('input', { type: 'search', placeholder: 'Find a file by name (skill, memory, CLAUDE)', 'aria-label': 'Find a file', oninput: debounce(() => find(search.value), 300) });
    const side = h('aside', { class: 'files-side' }, search, h('div', { class: 'files-results' }));
    const pathEl = h('code', { class: 'files-path' });
    const fileMeta = h('span', { class: 'muted small' });
    const dirty = h('span', { class: 'em small' });
    const notice = h('div', { class: 'notice', hidden: true });
    const ta = h('textarea', { class: 'mono files-editor', spellcheck: 'false', 'aria-label': 'File contents', disabled: true });
    const saveBtn = btn('Save', () => save(), { cls: 'sm primary', disabled: true, key: '⌘S', title: 'Write the file on the selected host' });
    const revertBtn = btn('Revert', () => { if (current) { ta.value = current.text; markDirty(); } }, { cls: 'sm quiet', disabled: true });
    const copyBtn = btn('Save a copy', async () => { if (!current) return; const r = await saveText(current.path.split('/').pop(), ta.value, /\.md$/.test(current.path) ? 'text/markdown' : /\.json$/.test(current.path) ? 'application/json' : 'text/plain'); if (r !== 'cancelled') ctx.toast(r === 'saved' ? 'Copy saved' : 'Downloaded a copy', 'ok'); }, { cls: 'sm quiet', disabled: true, title: 'Save the editor text to a file on this computer' });
    const main = h('section', { class: 'files-main' },
      h('div', { class: 'group-head' }, pathEl, fileMeta, h('span', { style: { flex: 1 } }), dirty, revertBtn, copyBtn, saveBtn),
      notice, ta);
    root.append(head, h('div', { class: 'files' }, side, main));
    ta.addEventListener('input', markDirty);
    ta.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); } if (e.key === 'Tab' && !e.shiftKey && !e.metaKey) { e.preventDefault(); const s = ta.selectionStart; ta.setRangeText('  ', s, ta.selectionEnd, 'end'); markDirty(); } });

    function markDirty() {
      const d = current && ta.value !== current.text;
      dirty.textContent = d ? 'unsaved changes' : '';
      saveBtn.disabled = !d; revertBtn.disabled = !d; copyBtn.disabled = !current;
    }
    function paintSide() {
      const box = side.querySelector('.files-results'); clear(box);
      if (q && q.length >= 2) return;   // search results own the list
      if (!roots) { box.append(loading('Reading roots')); return; }
      if (dir) {
        box.append(h('div', { class: 'files-crumb' }, btn('Back', () => { dir = null; paintSide(); }, { cls: 'sm quiet' }), h('code', { class: 'small' }, dir.dir)));
        for (const e of dir.entries) box.append(h('div', { class: 'row', role: 'button', tabindex: 0, onclick: () => e.type === 'dir' ? browse(e.path) : openFile(e.path), onkeydown: (ev) => { if (ev.key === 'Enter') ev.currentTarget.click(); } },
          h('span', { class: 'mono small' }, e.type === 'dir' ? 'dir' : fmtBytes(e.bytes)), h('div', { class: 'main-col' }, h('div', { class: 'l1' }, h('span', { class: 'trunc' }, e.name + (e.type === 'dir' ? '/' : '')), e.link ? h('span', { class: 'faint small' }, 'link') : null)), h('span', { class: 'muted small' }, fmtTime(e.mtime))));
        if (!dir.entries.length) box.append(empty('Empty directory'));
        return;
      }
      const groups = new Map();
      for (const p of roots.picks) { const g = groups.get(p.group) ?? []; g.push(p); groups.set(p.group, g); }
      box.append(h('div', { class: 'chips', style: { margin: '8px 0' } }, ...roots.roots.filter((r) => r.kind === 'dir').map((r) => h('button', { class: 'chip', type: 'button', onclick: () => browse(r.path) }, `browse ${r.path}`))));
      for (const [g, list] of groups) {
        box.append(h('details', { open: g === 'Repos' || g === 'Global' || g === 'Memory' ? true : null }, h('summary', null, `${g} (${list.length})`),
          ...list.map((p) => h('div', { class: 'row', role: 'button', tabindex: 0, 'aria-selected': current?.path === p.path ? 'true' : 'false', onclick: () => openFile(p.path), onkeydown: (ev) => { if (ev.key === 'Enter') openFile(p.path); } },
            h('span', { class: 'mono small' }, fmtBytes(p.bytes)), h('div', { class: 'main-col' }, h('div', { class: 'l1' }, h('span', { class: 'trunc' }, p.label)), h('div', { class: 'l2' }, p.path)), h('span', { class: 'muted small' }, fmtTime(p.mtime))))));
      }
    }
    async function loadRoots(fresh = false) {
      try { roots = await ctx.call('files.roots', fresh ? { fresh: true } : {}, { host: host() }); meta.textContent = `${plural(roots.picks.length, 'quick pick')} on ${host() === 'local' ? (ctx.state.frontHost ?? 'this machine') : host()}`; }
      catch { roots = { roots: [], picks: [] }; }
      if (alive) paintSide();
    }
    async function browse(p) { try { dir = await call('files.list', { dir: p }); paintSide(); } catch { /* toasted */ } }
    async function find(text) {
      q = text.trim();
      const box = side.querySelector('.files-results');
      if (q.length < 2) { paintSide(); return; }
      clear(box); box.append(loading('Searching'));
      try {
        const r = await ctx.callQuiet('files.find', { query: q, limit: 80 }, { host: host() });
        if (q !== text.trim()) return;
        clear(box);
        for (const it of r.items) box.append(h('div', { class: 'row', role: 'button', tabindex: 0, onclick: () => openFile(it.path), onkeydown: (ev) => { if (ev.key === 'Enter') openFile(it.path); } }, h('span', { class: 'mono small' }, 'file'), h('div', { class: 'main-col' }, h('div', { class: 'l1' }, h('span', { class: 'trunc' }, it.name)), h('div', { class: 'l2' }, it.path)), null));
        if (!r.items.length) box.append(empty('No file matches', 'Words must all appear in the path.'));
        if (r.truncated) box.append(h('p', { class: 'muted small' }, 'More matches; add a word.'));
      } catch (e) { clear(box); box.append(empty('Search failed', e.message)); }
    }
    async function openFile(p) {
      if (current && ta.value !== current.text && !confirm('Discard the unsaved changes?')) return;
      ta.disabled = true; notice.hidden = true;
      try {
        const r = await call('files.read', { path: p });
        current = r; ta.value = r.text; ta.disabled = false;
        pathEl.textContent = r.path.replace(/^\/(Users|home)\/[^/]+/, '~');
        clear(fileMeta); fileMeta.append(`${fmtBytes(r.bytes)}, changed ${fmtTime(r.mtime)}${r.symlink ? `, link to ${r.real.replace(/^\/(Users|home)\/[^/]+/, '~')}` : ''}  `, copyButton(r.path, 'Copy path'));
        localStorage.setItem(LAST_KEY, JSON.stringify({ host: host(), path: pathEl.textContent }));
        markDirty(); paintSide();
        ctx.nav('files', pathEl.textContent);
      } catch { if (current) ta.disabled = false; }
    }
    async function save() {
      if (!current || ta.value === current.text) return;
      saveBtn.disabled = true;
      try {
        const r = await ctx.callQuiet('files.write', { path: current.path, content: ta.value, expectSha256: current.sha256 }, { host: host() });
        current = { ...current, text: ta.value, sha256: r.sha256, bytes: r.bytes, mtime: new Date().toISOString() };
        notice.hidden = true; markDirty();
        ctx.toast(`Saved ${pathEl.textContent} (${fmtBytes(r.bytes)})`, 'ok');
      } catch (e) {
        notice.hidden = false; notice.className = 'notice error'; clear(notice);
        if (e.status === 409) notice.append('The file changed on disk since you opened it. ', btn('Load the disk version', async () => { const keep = ta.value; await openFileForce(current.path); notice.hidden = false; notice.className = 'notice'; clear(notice); notice.append('Disk version loaded. Your text is on the clipboard: paste and merge it, then save. '); navigator.clipboard.writeText(keep).catch(() => {}); }, { cls: 'sm' }));
        else notice.append(e.message);
        markDirty();
      }
    }
    async function openFileForce(p) { const was = current; current = null; await openFile(p); if (!current) current = was; }

    loadRoots();
    const want = params?.[0] ?? JSON.parse(localStorage.getItem(LAST_KEY) || 'null')?.path;
    if (want) openFile(want);
    else { ta.placeholder = 'Pick a file on the left: a repo CLAUDE.md, a skill, a memory index, or browse a root.'; }
    const guard = (e) => { if (current && ta.value !== current.text) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', guard);
    return {
      destroy() { alive = false; window.removeEventListener('beforeunload', guard); },
      params(p) { if (p?.[0] && p[0] !== pathEl.textContent) openFile(p[0]); },
      search(v) { search.value = v; find(v); },
    };
  },
};
