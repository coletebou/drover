// The side panel's Prompts section: recent prompts from prompts.list (every machine, newest first, the daemon's
// "Mine" set), a search box (every word must match, asked of the daemon, debounced), Copy on each prompt, a click to
// read one whole, Open for a prompt whose session is on the board, and a link to Prompts › Mine in the web UI.
// Text goes in through textContent only (ui/dom.js). The pure half is lib/prompts.js.
import { h, render, clear } from './dom.js';
import { listArgs, mergePrompts, normalizePrompts, promptRow, statusLine, stripForPrompt, isUnknownPromptsOp, PANEL_PAGE } from '../lib/prompts.js';
import { promptsUrl } from '../lib/links.js';

const DEBOUNCE_MS = 300;
const COPIED_MS = 1500;

/**
 * @param {{ getClient: () => Promise<{client: object}>, openTab: (url: string) => void, board: () => object|null,
 *   openSession: (strip: object) => void, openOptions: () => void, needsOptions: (e: any) => boolean }} deps
 */
export function promptsSection(deps) {
  let list = [];
  let more = false;
  let loading = false;
  let loaded = false;
  let error = null;          // { message, options }
  let unsupported = false;
  let status = null;
  let open = null;           // the id shown whole
  let copied = null;         // { id, at }
  let seq = 0;
  let timer = null;
  let origin = null;

  const q = h('input', { type: 'search', id: 'prompts-q', class: 'pr-q', placeholder: 'Search every prompt', 'aria-label': 'Search prompts', autocomplete: 'off', spellcheck: 'false' });
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => reload(), DEBOUNCE_MS); });
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(timer); reload(); } });
  const webBtn = h('button', { type: 'button', class: 'ghost', onclick: openWeb, title: 'Prompts › Mine in Drover' }, 'Open in Drover');
  const statusEl = h('p', { class: 'pr-status', role: 'status', 'aria-live': 'polite' });
  const listEl = h('ul', { class: 'pr-list', 'aria-label': 'Prompts' });
  const moreBtn = h('button', { type: 'button', class: 'pr-more', onclick: () => loadMore(), hidden: true }, 'Older prompts');
  const root = h('section', { class: 'prompts', 'aria-label': 'Prompts', hidden: true },
    h('div', { class: 'pr-head' }, q, webBtn), statusEl, listEl, moreBtn);

  async function client() {
    const { client: c } = await deps.getClient();
    origin = c.origin;
    return c;
  }

  async function openWeb() {
    try { await client(); } catch { /* origin stays as it was */ }
    if (!origin) return deps.openOptions();
    deps.openTab(promptsUrl(origin, q.value));
  }

  async function fetchPage(before) {
    const c = await client();
    return c.op('prompts.list', listArgs({ q: q.value, before, limit: PANEL_PAGE }), { timeoutMs: 30_000 });
  }

  /** The first page for the search box as it is now; an answer to an older search is dropped. */
  async function reload() {
    const my = ++seq;
    loading = true;
    draw();
    try {
      const res = await fetchPage();
      if (my !== seq) return;
      list = normalizePrompts(res);
      more = Boolean(res?.more) && list.length > 0;
      error = null; unsupported = false;
      if (open && !list.some((p) => p.id === open)) open = null;
    } catch (e) {
      if (my !== seq) return;
      if (isUnknownPromptsOp(e)) { unsupported = true; list = []; more = false; error = null; }
      else error = { message: String(e?.message ?? 'Could not read prompts.'), options: deps.needsOptions(e) };
    } finally {
      if (my === seq) { loading = false; loaded = true; draw(); }
    }
  }

  async function loadMore() {
    if (!more || loading || !list.length) return;
    const my = seq;
    loading = true;
    moreBtn.disabled = true;
    try {
      const res = await fetchPage(list.at(-1).id);
      if (my !== seq) return;
      const before = list.length;
      list = mergePrompts(list, normalizePrompts(res));
      more = Boolean(res?.more) && list.length > before;
    } catch (e) {
      if (my !== seq) return;
      error = { message: `Could not read older prompts: ${e?.message ?? 'error'}`, options: false };
      more = false;
    } finally {
      if (my === seq) { loading = false; moreBtn.disabled = false; draw(); }
    }
  }

  async function readStatus() {
    try { status = await (await client()).op('prompts.status', {}); } catch { status = null; }
    drawStatus();
  }

  async function copy(p, btn) {
    const ok = await writeClipboard(p.text);
    copied = ok ? { id: p.id, at: Date.now() } : null;
    btn.textContent = ok ? 'Copied' : 'Copy failed';
    setTimeout(() => { if (btn.isConnected) btn.textContent = 'Copy'; }, COPIED_MS);
  }

  function drawStatus() {
    if (!loaded) statusEl.textContent = 'Reading prompts';
    else if (unsupported) statusEl.textContent = '';
    else statusEl.textContent = status ? statusLine(status) : `${list.length} prompt${list.length === 1 ? '' : 's'} shown`;
  }

  function row(p) {
    const r = promptRow(p);
    const strip = stripForPrompt(deps.board()?.strips ?? [], p);
    const whole = open === p.id;
    const copyBtn = h('button', { type: 'button', class: 'ghost pr-copy', title: 'Copy the prompt', 'aria-label': 'Copy the prompt' }, copied?.id === p.id && Date.now() - copied.at < COPIED_MS ? 'Copied' : 'Copy');
    copyBtn.addEventListener('click', (e) => { e.stopPropagation(); copy(p, copyBtn); });
    const openBtn = strip ? h('button', { type: 'button', class: 'ghost pr-open', title: `Open ${strip.name ?? 'the session'} here` }, 'Open') : null;
    openBtn?.addEventListener('click', (e) => { e.stopPropagation(); deps.openSession(strip); });
    const text = h(whole ? 'pre' : 'p', { class: whole ? 'pr-text whole' : 'pr-text' }, r.text);
    const li = h('li', { class: `pr-row${whole ? ' open' : ''}`, 'data-id': p.id, tabindex: '0', 'aria-expanded': whole ? 'true' : 'false', title: whole ? '' : 'Show the whole prompt' },
      h('div', { class: 'pr-meta' }, h('time', { datetime: r.when, title: new Date(r.when).toLocaleString() }, r.meta), r.fromSink ? h('span', { class: 'pr-sink', title: 'From a sink copy: this host did not answer' }, 'copy') : null, h('span', { class: 'spacer' }), openBtn, copyBtn),
      text);
    const toggle = () => { open = whole ? null : p.id; draw(); };
    li.addEventListener('click', toggle);
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    return li;
  }

  function draw() {
    drawStatus();
    clear(listEl);
    moreBtn.hidden = !more;
    if (unsupported) {
      render(listEl, h('li', { class: 'pr-empty' }, 'This daemon keeps no prompts yet. Update Drover: the prompt spool fills from every transcript on the machine.'));
      return;
    }
    if (error) {
      listEl.append(h('li', { class: 'notice error', role: 'alert' }, error.message,
        error.options ? h('div', { class: 'notice-actions' }, h('button', { type: 'button', onclick: deps.openOptions }, 'Open options')) : null));
    }
    if (!list.length) {
      if (loaded && !error) listEl.append(h('li', { class: 'pr-empty' }, q.value.trim() ? 'Nothing matches. Every word must appear in the prompt.' : 'No prompts yet. They appear as you type them into Claude Code or Codex.'));
      else if (!loaded) listEl.append(h('li', { class: 'pr-empty' }, 'Loading'));
      return;
    }
    for (const p of list) listEl.append(row(p));
  }

  return {
    el: root,
    /** Show the section; the first time, read the first page and the status. */
    show() {
      root.hidden = false;
      if (!loaded && !loading) { reload(); readStatus(); }
    },
    hide() { root.hidden = true; },
    /** Read the first page again (Refresh, new settings), keeping the search. */
    refresh() { reload(); readStatus(); },
    /** The board changed: Open buttons follow it. */
    boardChanged() { if (!root.hidden && list.length) draw(); },
    focus() { q.focus(); },
    get count() { return list.length; },
  };
}

/** navigator.clipboard, with the older copy command as the fallback (a page that lost focus). */
async function writeClipboard(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.className = 'offscreen';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}
