// Prompts › Mine and Prompts › All: every prompt typed into Claude Code, Codex or Hermes on any machine, verbatim
// (secrets redacted at collection), newest first (docs/specs/2026-11-21-cohesion-overhaul.md, "Prompts: the spool").
// prompts.list on the front daemon fans out to every host; the search box is its `q` (every word must match, asked of
// the daemons, debounced), the filters its host, engine and label; Mine is the daemon's default via set (typed,
// queued, sent through Drover, launch prompts), All adds peer messages between agents. Scrolling to the end pages with
// `before`. A click shows the whole prompt beside the list as plain text (never Markdown), with copy, open its session
// (when it is on the board) and launch with it (Fleet › Launch, prefilled). New turns and writes refresh the top, at
// most every few seconds. The status line is prompts.status (records, newest, each sink's last sync or error);
// Sync now is prompts.sync. Pure half: prompts-model.js.
import { h, clear, engine, fmtTime, fmtAgo, empty, loading, debounce, copyBtn, btn, kv, shortPath, plural } from '../dom.js';
import { listArgs, mergePrompts, stripForPrompt, statusLine, firstLine, PAGE } from '../prompts-model.js';

const LIVE_MS = 4000;
const unknownOp = (e) => /unknown op/i.test(e?.message ?? '');
const VIA_LABEL = { typed: 'typed', queued: 'queued', drover: 'via Drover', headless: 'launch', peer: 'from an agent' };

function promptsView({ id, label, scope }) {
  return {
    id, label, scope,
    mount(root, ctx, params) {
      let alive = true; let list = []; let done = false; let busy = false; let sel = null; let supported = true; let seq = 0;
      const F = { q: params[0] ?? '', host: '', engine: '', label: '' };
      const statusEl = h('span', { class: 'muted small prompts-status' });
      const syncBtn = btn('Sync now', () => sync(), { cls: 'sm', title: 'Scan transcripts now, then push every sink (prompts.sync)' });
      root.append(h('div', { class: 'view-head' }, h('h1', null, 'Prompts'), h('span', { class: 'muted small' }, scope === 'all' ? 'everything sent to an agent, peers too' : 'what you asked, everywhere'), h('span', { class: 'spacer' }), statusEl, syncBtn));

      const qIn = h('input', { type: 'search', class: 'search-q', placeholder: 'Search every prompt on every machine (all words must match)', 'aria-label': 'Search prompts', value: F.q, autocomplete: 'off', spellcheck: 'false' });
      const sel_ = (name, opts) => h('select', { 'aria-label': name, onchange: (e) => { F[name] = e.target.value; reload(); } }, ...opts.map(([v, l]) => h('option', { value: v }, l)));
      const hostSel = sel_('host', [['', 'every host']]);
      const engSel = sel_('engine', [['', 'every engine'], ['claude', 'Claude Code'], ['codex', 'Codex'], ['hermes', 'Hermes']]);
      const labelSel = sel_('label', [['', 'every label']]);
      qIn.addEventListener('input', debounce(() => { F.q = qIn.value; reload(); }, 300));
      qIn.addEventListener('keydown', (e) => { if (e.key === 'Escape') { qIn.blur(); } });
      root.append(h('div', { class: 'toolbar prompts-bar' }, qIn, hostSel, engSel, labelSel));
      const notice = h('div', { class: 'notice', hidden: true });
      const listEl = h('div', { class: 'prompt-list', role: 'listbox', 'aria-label': 'Prompts' });
      const sentinel = h('div', { class: 'prompt-more muted small' });
      const detail = h('aside', { class: 'prompt-detail', 'aria-label': 'Prompt' });
      const split = h('div', { class: 'prompts-split' }, h('div', { class: 'prompt-col' }, listEl, sentinel), detail);
      root.append(notice, split);
      listEl.append(loading('Reading prompts'));
      drawDetail();

      function fillHosts() {
        const want = ['', ...ctx.hosts().map((x) => (x.name === 'local' ? ctx.state.frontHost ?? null : x.name)).filter(Boolean)];
        if (hostSel.options.length === want.length) return;
        clear(hostSel); for (const v of want) hostSel.append(h('option', { value: v, selected: v === F.host ? true : null }, v || 'every host'));
      }
      function fillLabels() {
        const seen = [...new Set(list.map((p) => p.label).filter(Boolean))].sort();
        const have = [...labelSel.options].map((o) => o.value);
        for (const l of seen) if (!have.includes(l)) labelSel.append(h('option', { value: l }, l));
      }

      // ------------------------------------------------------------ the list
      function row(p) {
        const el = h('div', { class: 'prompt-row', role: 'option', tabindex: 0, 'data-id': p.id, 'aria-selected': p.id === sel ? 'true' : 'false', 'data-peek': String(p.text ?? '').slice(0, 900), onclick: () => choose(p.id), onkeydown: (e) => { if (e.key === 'Enter') choose(p.id); } },
          h('div', { class: 'prompt-meta' }, h('time', { datetime: p.ts, title: new Date(p.ts).toLocaleString() }, fmtTime(p.ts)), h('span', { class: 'prompt-host' }, p.host ?? ''), engine(p.engine), p.project ? h('span', { class: 'prompt-project trunc', title: p.cwd ?? '' }, p.project) : null, p.via && p.via !== 'typed' ? h('span', { class: `prompt-via via-${p.via}` }, VIA_LABEL[p.via] ?? p.via) : null),
          h('div', { class: 'prompt-text clamp2' }, p.text ?? ''));
        return el;
      }
      function paint() {
        if (!alive) return;
        clear(listEl);
        if (!supported) { listEl.append(empty('This daemon keeps no prompts yet', 'prompts.list comes with the prompts collector (drover prompts). Update the daemon, then the spool fills from every transcript on the machine.')); sentinel.textContent = ''; return; }
        if (!list.length) { listEl.append(empty(F.q || F.host || F.engine || F.label ? 'Nothing matches' : 'No prompts yet', F.q ? 'Every word must appear in the prompt.' : 'They appear here as you type them into Claude Code, Codex or Hermes.')); sentinel.textContent = ''; return; }
        for (const p of list) listEl.append(row(p));
        sentinel.textContent = done ? `${plural(list.length, 'prompt')}, the oldest is ${fmtAgo(list.at(-1).ts, { short: false }).replace(/ ago$/, '')} old` : 'loading older prompts as you scroll';
      }
      async function fetchPage(before) {
        const r = await ctx.callQuiet('prompts.list', listArgs({ scope, ...F, before }), { host: 'local' });
        const down = (r?.perHost ?? []).filter((x) => x && x.ok === false);
        notice.hidden = !down.length;
        notice.textContent = down.length ? `${down.map((x) => `${x.host}${x.error ? ` (${x.error})` : ''}`).join(', ')} did not answer: ${down.length > 1 ? 'their' : 'its'} prompts come from the last sync.` : '';
        return r?.prompts ?? [];
      }
      async function reload() {
        const my = ++seq; busy = true;
        try {
          const page = await fetchPage();
          if (!alive || my !== seq) return;
          supported = true; list = mergePrompts(page); done = page.length < PAGE;
          if (sel && !list.some((p) => p.id === sel)) sel = null;
          fillLabels(); paint(); drawDetail();
        } catch (e) {
          if (!alive || my !== seq) return;
          if (unknownOp(e)) { supported = false; paint(); syncBtn.disabled = true; return; }
          clear(listEl); listEl.append(empty('Could not read prompts', e.message));
        } finally { if (my === seq) busy = false; }
      }
      async function more() {
        if (busy || done || !list.length || !supported) return;
        busy = true; const my = seq;
        try {
          const page = await fetchPage(list.at(-1).id);
          if (!alive || my !== seq) return;
          const before = list.length;
          list = mergePrompts(list, page); done = page.length < PAGE || list.length === before;
          for (const p of list.slice(before)) listEl.append(row(p));
          fillLabels();
          sentinel.textContent = done ? `${plural(list.length, 'prompt')}` : 'loading older prompts as you scroll';
        } catch (e) { sentinel.textContent = `Could not read older prompts: ${e.message}`; }
        finally { busy = false; }
      }
      /** New prompts at the top, the pages already read kept (a live refresh). */
      async function refreshTop() {
        if (busy || !supported) return;
        try {
          const page = await fetchPage();
          if (!alive) return;
          const before = list[0]?.id;
          list = mergePrompts(page, list);
          if (list[0]?.id !== before) { const y = root.scrollTop; paint(); root.scrollTop = y; }
        } catch { /* the next event tries again */ }
      }
      const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) more(); }, { root, rootMargin: '300px 0px' });
      io.observe(sentinel);

      // ------------------------------------------------------------ the detail panel
      function choose(pid) {
        sel = pid;
        for (const el of listEl.querySelectorAll('.prompt-row')) el.setAttribute('aria-selected', el.dataset.id === pid ? 'true' : 'false');
        split.classList.toggle('show-detail', Boolean(pid));
        drawDetail();
      }
      function stripOf(p) { return stripForPrompt(ctx.board(), p, ctx.state.frontHost); }
      function launchWith(p) { ctx.nav('fleet/launch', p.text ?? '', p.cwd || '~', !p.host || p.host === ctx.state.frontHost ? 'local' : p.host); }
      function drawDetail() {
        clear(detail);
        const p = list.find((x) => x.id === sel);
        if (!p) { detail.append(h('div', { class: 'muted small prompt-hint' }, 'Pick a prompt to read it whole. Hover one for a preview; y copies the selected one, n launches an agent with it.')); return; }
        const s = stripOf(p);
        detail.append(
          h('div', { class: 'prompt-detail-head' },
            h('button', { class: 'btn sm quiet prompt-back', type: 'button', onclick: () => choose(null) }, '← List'),
            engine(p.engine), h('strong', null, p.project ?? p.host ?? ''), h('span', { class: 'spacer' }),
            copyBtn(p.text ?? '', 'Copy'),
            btn('Open session', () => { if (s) ctx.open({ kind: s.kind, id: s.id, host: s.host, engine: s.engine, name: s.name, tmux: s.tmux, sessionId: s.sessionId }); }, { cls: 'sm', disabled: !s, title: s ? `Open ${s.name} in the drawer` : 'That session is not on the board now' }),
            btn('Launch with this prompt', () => launchWith(p), { cls: 'sm', title: 'Fleet › Launch, with this prompt (and its folder) filled in' })),
          h('pre', { class: 'prompt-full', tabindex: 0, 'aria-label': 'The prompt, verbatim' }, p.text ?? ''),
          kv([['when', `${new Date(p.ts).toLocaleString()} (${fmtAgo(p.ts, { short: false })})`], ['host', p.host], ['engine', p.engine], ['folder', p.cwd ? h('code', null, shortPath(p.cwd, 80)) : null], ['label', p.label], ['came', VIA_LABEL[p.via] ?? p.via], ['session', p.session ? h('code', null, p.session) : null], ['route', p.route ? (typeof p.route === 'string' ? p.route : JSON.stringify(p.route)) : null], ['id', h('code', null, p.id)]]));
      }

      // ------------------------------------------------------------ status and sync
      async function status() {
        try { const st = await ctx.callQuiet('prompts.status', {}, { host: 'local' }); if (alive) { statusEl.textContent = statusLine(st); statusEl.title = (st?.sinks ?? []).map((x) => `${x.name} (${x.type ?? 'sink'}): ${x.lastError ? `error: ${x.lastError}` : x.lastSync ? `synced ${new Date(x.lastSync).toLocaleString()}` : 'not synced yet'}`).join('\n') || 'No sinks: the local spool only'; } }
        catch (e) { if (alive) statusEl.textContent = unknownOp(e) ? '' : `status: ${e.message}`; }
      }
      async function sync() {
        syncBtn.disabled = true; syncBtn.firstChild.textContent = 'Syncing…';
        try {
          const r = await ctx.call('prompts.sync', {}, { host: 'local' });
          const bad = (r?.sinks ?? []).filter((x) => x.lastError || x.error);
          ctx.toast(`Scanned ${r?.scanned ?? 0}, added ${plural(r?.added ?? 0, 'prompt')}${bad.length ? `; ${bad.map((x) => `${x.name}: ${x.lastError ?? x.error}`).join(', ')}` : ''}`, bad.length ? 'error' : 'ok');
          await Promise.all([reload(), status()]);
        } catch { /* toasted */ }
        finally { if (alive) { syncBtn.disabled = false; syncBtn.firstChild.textContent = 'Sync now'; } }
      }

      fillHosts(); reload(); status();
      let liveAt = 0; let liveTimer = null;
      const statusTimer = setInterval(() => { if (!document.hidden) status(); }, 60_000);
      return {
        destroy() { alive = false; io.disconnect(); clearTimeout(liveTimer); clearInterval(statusTimer); },
        search(v) { if (v === F.q) return; F.q = v; qIn.value = v; reload(); },
        params(p) { const q = p[0] ?? ''; if (q !== F.q) { F.q = q; qIn.value = q; reload(); } },
        probe() { fillHosts(); },
        sse(type, data) {
          if (type !== 'turn' && type !== 'mutation') return;
          if (type === 'turn' && data?.turn && data.turn.role !== 'user') return;   // only a new user turn adds a prompt
          // At most one refresh every few seconds, however many turns arrive.
          const wait = Math.max(0, liveAt + LIVE_MS - Date.now());
          if (liveTimer) return;
          liveTimer = setTimeout(() => { liveTimer = null; liveAt = Date.now(); refreshTop(); }, wait || 600);
        },
        key(e) {
          const rows = [...listEl.querySelectorAll('.prompt-row')]; if (!rows.length) return;
          const i = rows.findIndex((r) => r.dataset.id === sel);
          if (e.key === 'j' || e.key === 'k') { e.preventDefault(); const n = rows[Math.max(0, Math.min(rows.length - 1, i < 0 ? 0 : i + (e.key === 'j' ? 1 : -1)))]; choose(n.dataset.id); n.focus({ preventScroll: true }); n.scrollIntoView({ block: 'nearest' }); return; }
          const p = list.find((x) => x.id === sel); if (!p) return;
          if (e.key === 'y') { e.preventDefault(); navigator.clipboard?.writeText(p.text ?? '').then(() => ctx.toast(`Copied: ${firstLine(p.text, 60)}`, 'ok', 1800), () => ctx.toast('Could not copy', 'error')); }
          if (e.key === 'n') { e.preventDefault(); launchWith(p); }
        },
      };
    },
  };
}

export const promptsMine = promptsView({ id: 'prompts', label: 'Mine', scope: 'mine' });
export const promptsAll = promptsView({ id: 'prompts-all', label: 'All', scope: 'all' });
