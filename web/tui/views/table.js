// A navigable table over one op's answer, with a `/` filter, a detail pane for the selected row (beside the table
// when the terminal is wide, under it otherwise) and per-view keys. tables.js defines one per web UI view.
// A definition: { id, title, load(app, view) -> data, rows(data, view) -> rows, columns: [{ title, w | flex, get,
// align }], detail(row, width, view) -> rows, enter?(row, app, view), keys?: { id: fn }, perHost?, query?, meta? }.
import { rule, hints, block, keepVisible, sideBySide } from '../ui.js';
import { fit, padStart, truncate, oneLine } from '../width.js';

export class TableView {
  constructor(app, def) {
    this.app = app; this.def = def; this.id = def.id; this.title = def.title;
    this.data = null; this.rowsAll = []; this.sel = 0; this.top = 0; this.filter = ''; this.filtering = false;
    this.loading = false; this.error = null; this.at = 0; this.state = { ...(def.state ?? {}) }; this.cache = new Map(); this.query = '';
    this.host = 'local';
  }
  get inputActive() { return this.filtering; }

  show() {
    if (this.def.perHost && this.host !== this.app.host) { this.host = this.app.host; this.data = null; this.sel = 0; this.top = 0; }
    if (this.def.query && !this.query) { this.filtering = true; return; }
    if (!this.data || Date.now() - this.at > (this.def.ttl ?? 30_000)) this.load();
  }
  async load() {
    if (this.loading) return;
    this.loading = true; this.error = null; this.app.invalidate();
    try {
      this.data = await this.def.load(this.app, this);
      this.rowsAll = this.def.rows(this.data, this) ?? [];
      this.at = Date.now();
    } catch (e) { this.error = e.unknownOp ? `this daemon does not know ${e.op}` : e.message; }
    finally { this.loading = false; this.app.invalidate(); }
  }
  refresh() { this.cache.clear(); this.load(); }
  /** Re-derive rows (a toggle changed what is shown) without asking the daemon again. */
  rederive() { if (this.data) this.rowsAll = this.def.rows(this.data, this) ?? []; this.sel = 0; this.top = 0; }
  onEvent(type, d) { if (this.def.onEvent?.(type, d, this)) this.app.invalidate(); }

  visible() {
    if (this.def.query) return this.rowsAll;
    const q = this.filter.trim().toLowerCase();
    if (!q) return this.rowsAll;
    const words = q.split(/\s+/);
    return this.rowsAll.filter((r) => { const t = (r.__text ??= (this.def.text ? this.def.text(r) : JSON.stringify(r)).toLowerCase()); return words.every((w) => t.includes(w)); });
  }
  selected() { const v = this.visible(); return v[Math.min(this.sel, v.length - 1)] ?? null; }
  clearInput() { if (this.filtering && (this.filter || this.query)) { if (this.def.query) this.query = ''; else this.filter = ''; return true; } if (this.filter) { this.filter = ''; return true; } return false; }

  /** Lazy detail data for a row (host.facts, mrs.get): loaded once per key, the pane redraws when it lands. */
  lazy(key, fn) {
    if (this.cache.has(key)) return this.cache.get(key);
    this.cache.set(key, { loading: true });
    fn().then((v) => this.cache.set(key, { value: v }), (e) => this.cache.set(key, { error: e.message })).finally(() => this.app.invalidate());
    return this.cache.get(key);
  }

  key(ev) {
    if (this.filtering) {
      const field = this.def.query ? 'query' : 'filter';
      if (ev.id === 'enter') { this.filtering = false; if (this.def.query && this.query.trim()) this.load(); return true; }
      if (ev.id === 'escape') { this.filtering = false; if (!this.def.query) this.filter = ''; return true; }
      if (ev.id === 'backspace') { this[field] = this[field].slice(0, -1); this.sel = 0; return true; }
      if (ev.id === 'C-u') { this[field] = ''; return true; }
      if (ev.id === 'paste') { this[field] += oneLine(ev.text); return true; }
      if (ev.ch && !ev.ctrl && !ev.alt) { this[field] += ev.ch; this.sel = 0; this.top = 0; return true; }
      return false;
    }
    const n = this.visible().length;
    const page = Math.max(1, (this.listH ?? 10) - 1);
    const own = this.def.keys?.[ev.id];
    if (own) { own(this.selected(), this.app, this); return true; }
    switch (ev.id) {
      case 'j': case 'down': this.sel = Math.min(n - 1, this.sel + 1); return true;
      case 'k': case 'up': this.sel = Math.max(0, this.sel - 1); return true;
      case 'pgdn': this.sel = Math.min(n - 1, this.sel + page); return true;
      case 'pgup': this.sel = Math.max(0, this.sel - page); return true;
      case 'g': case 'home': this.sel = 0; return true;
      case 'G': case 'end': this.sel = Math.max(0, n - 1); return true;
      case '/': this.filtering = true; return true;
      case 'R': case 'C-r': this.refresh(); return true;
      case '[': case ']': if (!this.def.perHost) return false; this.app.cycleHost(ev.id === ']' ? 1 : -1); this.show(); return true;
      case 'enter': { const r = this.selected(); if (r && this.def.enter) { this.def.enter(r, this.app, this); return true; } this.detailOpen = !this.detailOpen; return true; }
      case 'escape': if (this.filter) { this.filter = ''; return true; } return false;
      default: return false;
    }
  }

  hints() {
    if (this.filtering) return hints([['type', this.def.query ? 'the search' : 'to filter'], ['Enter', this.def.query ? 'search' : 'keep'], ['Esc', this.def.query ? 'stop typing' : 'clear']]);
    return hints([['j/k', 'move'], ['Enter', this.def.enterHint ?? 'details'], ['/', this.def.query ? 'search' : 'filter'], ...(this.def.perHost ? [['[ ]', 'host']] : []), ...(this.def.hintKeys ?? []), ['R', 'refresh'], ['1-9', 'views']]);
  }

  #columns(width) {
    const cols = this.def.columns;
    const fixed = cols.reduce((s, c) => s + (c.flex ? 0 : c.w) + 1, 1);
    const flexTotal = cols.reduce((s, c) => s + (c.flex ?? 0), 0) || 1;
    const room = Math.max(0, width - fixed);
    return cols.map((c) => ({ ...c, width: c.flex ? Math.max(4, Math.floor((room * c.flex) / flexTotal)) : c.w }));
  }
  #row(r, cols, on) {
    const segs = [[on ? '▌' : ' ', 'accent']];
    for (const c of cols) {
      let v = c.get(r, this);
      let st = null;
      if (Array.isArray(v)) [v, st] = v;
      const s = oneLine(v == null ? '' : String(v));
      segs.push([c.align === 'right' ? padStart(s, c.width) : fit(s, c.width), st ?? c.style ?? null], [' ', null]);
    }
    return on ? { segs, bg: 'sel' } : segs;
  }

  render(width, height) {
    const all = this.rowsAll, vis = this.visible();
    if (this.sel >= vis.length) this.sel = Math.max(0, vis.length - 1);
    const meta = this.loading && !this.data ? 'loading…' : this.error ? this.error : this.def.meta?.(this.data, this) ?? `${vis.length}${vis.length !== all.length ? ` of ${all.length}` : ''} rows`;
    const host = this.def.perHost ? [['  on ', 'dim'], [this.app.hostLabel(this.host), 'accent']] : [];
    const filt = this.def.query
      ? [['   search: ', 'dim'], [this.query || (this.filtering ? '' : 'press / to search'), this.query ? 'accent' : 'dim'], [this.filtering ? '▍' : '', 'accent']]
      : this.filtering || this.filter ? [['   filter: ', 'dim'], [this.filter, 'accent'], [this.filtering ? '▍' : '', 'accent']] : [];
    const head = [[` ${this.title}`, 'bold'], ...host, ['  ', null], [truncate(meta, Math.max(10, width - 50)), this.error ? 'err' : 'dim'], ...(this.loading && this.data ? [['  refreshing…', 'dim']] : []), ...filt];
    const wide = width >= 120 && this.def.detail;
    const listW = wide ? Math.floor(width * 0.58) : width;
    const cols = this.#columns(listW);
    const header = [[' ', null], ...cols.flatMap((c) => [[c.align === 'right' ? padStart(c.title, c.width) : fit(c.title, c.width), 'dim'], [' ', null]])];
    const r = this.selected();
    const detail = this.def.detail && r ? this.def.detail(r, wide ? width - listW - 3 : width, this) ?? [] : [];
    const showDetail = this.def.detail && r && (wide || this.detailOpen !== false);
    const bodyH = height - 2;
    let listH = bodyH - 1;
    let below = [];
    if (showDetail && !wide) { const dh = Math.min(detail.length + 1, Math.floor(bodyH * 0.45)); listH = bodyH - 1 - dh; below = [rule(width), ...detail.slice(0, dh - 1)]; }
    this.listH = listH;
    this.top = keepVisible(this.sel, this.top, listH, vis.length);
    const list = vis.slice(this.top, this.top + listH).map((row, i) => this.#row(row, cols, this.top + i === this.sel));
    if (!vis.length) list.push([[' ', null], [this.loading ? 'loading…' : this.error ? '' : this.def.query && !this.query ? 'Type a search: / then words, Enter.' : all.length ? 'Nothing matches the filter.' : this.def.empty ?? 'Nothing here.', 'dim']]);
    if (wide) return block([head, rule(width), ...sideBySide([header, ...block(list, listH)], showDetail ? detail : [], listW, width, bodyH)], height);
    return block([head, rule(width), header, ...block(list, listH), ...below], height);
  }
}
