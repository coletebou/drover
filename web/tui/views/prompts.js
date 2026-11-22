// Prompts (workspace 3): every prompt typed into an agent on any machine, verbatim, newest first, from prompts.list
// (docs/specs/2026-11-21-cohesion-overhaul.md, "Prompts: the spool"). `who` picks one of six filters (FILTERS, never
// `via`): Mine is what a person actually typed (into a session, tmux, Drover, or the fleet manager — record.mine,
// after any mark); Manager narrows to via manager; Agents is via peer|agent; Programs is via headless|sdk; Not mine is
// !record.mine; All drops the filter. `v` cycles through the six; `m` marks the selected prompt mine or not mine
// (prompts.mark — fixes a false positive or negative, stored fleet-wide) and refreshes. `/` filters by words on the
// daemon (its q, so older prompts match too) and on what is loaded while typing; `[` `]` one host or every host; j
// past the last row reads the next page (before: the last id). Enter opens the session the prompt was typed in, `y`
// copies the text (OSC 52), `l` launches a new agent with it. The list follows `mutation` and `turn` events, at most
// every 5 s while shown. The text is shown as it was typed: wrapped, never rendered as Markdown.
import { TableView } from './table.js';
import { LaunchPrompt } from './overlays.js';
import { title, kv } from './tables.js';
import { stripFor } from '../board.js';
import { ago, tilde } from '../ui.js';
import { wrap, oneLine, sanitize } from '../width.js';

/** The six filters, in cycling order; who prompts.list/prompts.local take (never via). */
export const FILTERS = ['mine', 'manager', 'agents', 'programs', 'not-mine', 'all'];
export const FILTER_LABEL = { mine: 'Mine', manager: 'Manager', agents: 'Agents', programs: 'Programs', 'not-mine': 'Not mine', all: 'All' };
const WHO_DESC = { mine: 'what you sent', manager: 'sent to the fleet manager', agents: 'agents to agents', programs: 'launched or run by a program', 'not-mine': 'not yours', all: 'every turn' };
export const PAGE = 200;
export const LIVE_MS = 5000;
const VIA_STYLE = { typed: null, queued: 'work', peer: 'mgr', agent: 'mgr', manager: 'accent', drover: 'accent', headless: 'dim', sdk: 'dim' };

/** The host a record names, as the TUI addresses it: this machine is 'local'. */
const hostOf = (r, app) => (!r?.host || r.host === 'local' || r.host === app.frontHost ? 'local' : r.host);

export const PROMPTS = {
  id: 'prompts', title: 'Prompts', ttl: 60_000,
  columns: [
    { title: ' ', w: 1, get: (r, v) => (r.marked ? ['●', 'accent'] : v.who === 'all' && r.mine === false ? ['○', 'dim'] : ['']) },
    { title: 'when', w: 5, align: 'right', get: (r) => [ago(r.ts), 'dim'] },
    { title: 'host', w: 12, get: (r) => [r.host ?? '', 'dim'] },
    { title: 'engine', w: 7, get: (r) => [r.engine ?? '', 'dim'] },
    { title: 'project', w: 14, get: (r) => [r.project ?? '', 'accent'] },
    { title: 'via', w: 8, get: (r) => [r.via ?? '', VIA_STYLE[r.via] ?? 'dim'] },
    { title: 'text', flex: 1, get: (r) => oneLine(r.text ?? '') },
  ],
  text: (r) => [r.text, r.project, r.host, r.engine, r.cwd, r.label, r.via, r.session].join(' '),
  preview: (r) => oneLine(r.text ?? ''),
  detail: (r, w) => {
    const out = [title(r.project || r.session?.slice(0, 8) || 'prompt', `${r.engine ?? ''} · ${r.via ?? ''} · ${r.host ?? ''}`), []];
    const mine = r.mine !== false;
    out.push(...kv([['when', r.ts ? new Date(r.ts).toLocaleString() : null], ['session', r.session], ['cwd', r.cwd ? tilde(r.cwd) : null], ['label', r.label], ['mine', `${mine ? 'yes' : 'no'}${r.marked ? ' (marked)' : ''}`], ['actor', r.actor], ['route', typeof r.route === 'object' ? JSON.stringify(r.route) : r.route], ['id', r.id]], w));
    out.push([]);
    // Verbatim: line breaks and indentation stay, long lines wrap; nothing is read as Markdown.
    const lines = wrap(sanitize(String(r.text ?? '')), Math.max(8, w - 2));
    for (const l of lines.slice(0, 400)) out.push([[' ', null], [l, null]]);
    if (lines.length > 400) out.push([[` … ${lines.length - 400} more lines (y copies all of it)`, 'dim']]);
    out.push([], [[' Enter', 'key'], [' open the session · ', 'dim'], ['y', 'key'], [' copy · ', 'dim'], ['l', 'key'], [' launch · ', 'dim'], ['m', 'key'], [mine ? ' mark not mine' : ' mark mine', 'dim']]);
    return out;
  },
  meta: (_d, v) => v.meta(),
  enterHint: 'open the session',
  hintKeys: [['y', 'copy'], ['l', 'launch'], ['m', 'mine/not mine'], ['v', 'filter'], ['[ ]', 'host']],
};

export class PromptsView extends TableView {
  constructor(app) {
    super(app, PROMPTS);
    this.who = 'mine'; this.hostFilter = null; this.more = false; this.shown = false; this.lastLoad = 0; this.liveTimer = null; this.typeTimer = null;
    this.asked = '';   // the q the rows on screen were read with
  }
  get title() { return `Prompts · ${FILTER_LABEL[this.who] ?? 'Mine'}`; }
  set title(_) { /* the sub-view names it */ }

  /** The sub-view's entry filter (Mine or All); `v` then cycles through all six from here. A change reads the list again. */
  setMode(m) { const next = FILTERS.includes(m) ? m : 'mine'; if (next === this.who) return; this.who = next; this.data = null; this.rowsAll = []; this.sel = 0; this.top = 0; if (this.shown) this.load(); }
  /** `v`: Mine → Manager → Agents → Programs → Not mine → All → Mine. */
  cycleWho(dir) {
    const i = FILTERS.indexOf(this.who);
    this.who = FILTERS[(i + dir + FILTERS.length) % FILTERS.length];
    this.data = null; this.rowsAll = []; this.sel = 0; this.top = 0;
    this.app.toast(`prompts: ${FILTER_LABEL[this.who]}`, 'dim', 1500);
    this.load();
  }
  show() { this.shown = true; if (!this.data || Date.now() - this.at > this.def.ttl) this.load(); }
  hide() { this.shown = false; clearTimeout(this.liveTimer); this.liveTimer = null; clearTimeout(this.typeTimer); }

  /** The prompts.list arguments for what is shown: words, who, one host, a page. */
  args({ before = null } = {}) {
    const q = this.filter.trim();
    return { ...(q ? { q } : {}), who: this.who, ...(this.hostFilter ? { hosts: [this.hostFilter] } : {}), limit: PAGE, ...(before ? { before } : {}) };
  }

  /**
   * Read the list. more: the next page after the last row (paging); live: the newest page merged into what is loaded
   * (a refresh after an event keeps the pages read and the selected prompt).
   */
  async load({ more = false, live = false } = {}) {
    if (this.loading) { this.again = this.again || (more ? 'more' : live ? 'live' : 'fresh'); return; }
    if (more && !this.more) return;
    this.loading = true; this.again = false; this.error = null; this.app.invalidate();
    const keep = this.selected()?.id ?? null;
    const args = this.args({ before: more ? this.rowsAll.at(-1)?.id : null });
    try {
      const r = await this.app.client.call('prompts.list', args, { timeoutMs: 60_000 });
      const got = Array.isArray(r?.prompts) ? r.prompts : [];
      let rows;
      if (more) rows = mergeById(this.rowsAll, got);
      else if (live && this.asked === (args.q ?? '')) rows = mergeById(got, this.rowsAll);
      else rows = got;
      if (!live) this.more = got.length >= PAGE;
      this.data = { ...r, prompts: rows }; this.rowsAll = rows; this.at = Date.now(); this.asked = args.q ?? '';
      if (keep) { const i = this.visible().findIndex((x) => x.id === keep); if (i >= 0) this.sel = i; }
    } catch (e) { this.error = e.unknownOp ? 'this daemon does not know prompts.list (it predates the prompt spool)' : e.message; }
    finally { this.loading = false; this.lastLoad = Date.now(); this.app.invalidate(); }
    if (this.again) { const a = this.again; this.again = false; return this.load({ more: a === 'more', live: a === 'live' }); }
  }
  refresh() { this.load(); }
  rederive() { this.sel = 0; this.top = 0; }

  /** A turn or a truth-file change may be a new prompt: read the newest page again, at most every 5 s, only while shown. */
  onEvent(type) {
    if ((type !== 'mutation' && type !== 'turn') || !this.shown || this.liveTimer) return;
    const wait = Math.max(0, LIVE_MS - (Date.now() - this.lastLoad));
    this.liveTimer = setTimeout(() => { this.liveTimer = null; if (this.shown) this.load({ live: true }); }, wait);
    this.liveTimer.unref?.();
  }

  meta() {
    const d = this.data ?? {};
    const down = (d.perHost ?? []).filter((x) => x.ok === false).map((x) => x.host);
    const n = this.visible().length;
    return `${n}${d.total != null ? ` of ${d.total}` : ''} prompts, ${WHO_DESC[this.who] ?? this.who}, newest first${this.hostFilter ? ` on ${this.hostFilter}` : ' on every host'}${this.asked ? ` matching "${this.asked}"` : ''}${down.length ? ` · not answering: ${down.join(', ')}` : ''}${this.more ? ' · j past the end reads more' : ''}${this.loading && this.data ? ' · reading…' : ''}`;
  }

  key(ev) {
    if (this.filtering) {
      const was = this.filter;
      const done = super.key(ev);
      // Words go to the daemon too (prompts.list q), a moment after the last key, and at once on Enter or Esc.
      if (ev.id === 'enter' || ev.id === 'escape') { clearTimeout(this.typeTimer); if (this.filter.trim() !== this.asked) this.load(); }
      else if (this.filter !== was) { clearTimeout(this.typeTimer); this.typeTimer = setTimeout(() => { if (this.filter.trim() !== this.asked) this.load(); }, 400); this.typeTimer.unref?.(); }
      return done;
    }
    const r = this.selected();
    switch (ev.id) {
      case 'enter': case 'o': this.open(r); return true;
      case 'y': if (r) this.app.copy(String(r.text ?? ''), 'the prompt'); return true;
      case 'l': this.launch(r); return true;
      case 'm': this.mark(r); return true;
      case 'v': this.cycleWho(1); return true;
      case '[': case ']': this.cycleHost(ev.id === ']' ? 1 : -1); return true;
      case 'escape': if (this.filter) { this.filter = ''; this.load(); return true; } return false;
      default: break;
    }
    const n = this.visible().length;
    const atEnd = this.sel >= n - 1;
    const done = super.key(ev);
    if (atEnd && ['j', 'down', 'pgdn', 'G', 'end'].includes(ev.id) && this.more) this.load({ more: true });
    return done;
  }
  mouse(ev) {
    const done = super.mouse(ev);
    if (ev.kind === 'wheel' && ev.wheel > 0 && this.more && this.mm && this.top + this.mm.h >= this.mm.total) this.load({ more: true });
    return done;
  }

  /** One host after another, then every host again. */
  cycleHost(dir) {
    const names = [null, ...new Set([this.app.frontHost ?? 'local', ...(this.app.hosts ?? []).map((x) => x.name).filter((x) => x !== 'local')])];
    const i = Math.max(0, names.indexOf(this.hostFilter));
    this.hostFilter = names[(i + dir + names.length) % names.length];
    this.app.toast(this.hostFilter ? `prompts on ${this.hostFilter}` : 'prompts on every host', 'dim', 1500);
    this.sel = 0; this.top = 0; this.load();
  }

  /** prompts.mark: toggle the selected prompt's mine flag, stored fleet-wide, then refresh. Fixes a false positive or negative. */
  async mark(r) {
    if (!r) return;
    const mine = !(r.mine !== false);
    try {
      await this.app.client.call('prompts.mark', { ids: [r.id], mine }, { timeoutMs: 30_000 });
      this.app.toast(mine ? 'marked mine' : 'marked not mine', 'ok', 2000);
      this.load();
    } catch (e) { this.app.toast(`mark: ${e.message}`, 'err', 6000); }
  }

  /** The session the prompt was typed in: its strip when the board has it (answer card, pane), else by its id. */
  open(r) {
    if (!r) return;
    if (!r.session) { this.app.toast('this prompt names no session'); return; }
    const host = hostOf(r, this.app);
    const s = stripFor(this.app.board?.strips, { host, sessionId: r.session }, this.app.frontHost);
    if (s) { this.app.openStrip(s); return; }
    this.app.openSession({ kind: 'session', id: r.session, host, engine: r.engine, name: r.project || r.session.slice(0, 8) });
  }

  /** A new agent with this prompt: confirm or edit the text, pick the host and engine, then launch.start. */
  launch(r) {
    if (!r) return;
    const hosts = ['local', ...(this.app.hosts ?? []).map((x) => x.name).filter((x) => x !== 'local')];
    this.app.modal = new LaunchPrompt(this.app, {
      initial: String(r.text ?? ''), hosts, host: hostOf(r, this.app), engine: r.engine, cwd: r.cwd ?? null,
      onLaunch: async ({ text, host, engine, cwd }) => {
        const args = { engine, mode: 'tmux', prompt: text, ...(cwd ? { cwd } : {}), ...(host && host !== 'local' ? { host } : {}) };
        this.app.toast(`launching ${engine} on ${this.app.hostLabel(host)}…`, 'dim', 4000);
        try {
          const out = await this.app.client.call('launch.start', args, { timeoutMs: 120_000 });
          if (out?.ok === false) { this.app.toast(`not launched: ${out.error ?? out.reason ?? 'unknown'}`, 'err', 8000); return; }
          this.app.toast(`launched ${engine} on ${this.app.hostLabel(host)}${out?.target ? ` in ${out.target}` : ''}`, 'ok', 5000);
          this.app.refreshBoardSoon(1500);
        } catch (e) { this.app.toast(`launch: ${e.message}`, 'err', 10_000); }
      },
    });
    this.app.invalidate();
  }
}

/** Records merged by id (the first list wins), newest first. */
export function mergeById(a, b) {
  const seen = new Set(); const out = [];
  for (const r of [...a, ...b]) { if (!r?.id || seen.has(r.id)) continue; seen.add(r.id); out.push(r); }
  return out.sort((x, y) => (Date.parse(y.ts ?? '') || 0) - (Date.parse(x.ts ?? '') || 0));
}
