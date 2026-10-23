// Command palette: jump to a session, window, host or view; or run a command
// like "msg webapp-f8 status?" / "ask who is waiting?" (the manager) / "capture work:30" / "launch".
import { h, clear, engine, dot } from './dom.js';

/**
 * What the palette searches. Agents come from the board's strips when the daemon has the compact board (they follow
 * its `board` events; the fleet summary no longer streams, so a copy of it goes stale), windows from the fleet
 * summary; with an older daemon both come from the fleet summary (it streams), else from the local snapshot.
 */
export function paletteIndex(state, strips = []) {
  const out = { sessions: [], windows: [] };
  const f = state?.fleet; const snap = state?.snapshot;
  if (state?.board) {
    for (const s of strips) out.sessions.push({ id: s.kind === 'window' ? s.sessionId ?? s.id : s.id, name: s.name, host: s.host, engine: s.engine, status: s.lane === 'wait' ? 'waiting' : s.status, tmux: s.tmux, cwd: s.cwd, live: true, open: { kind: s.kind, id: s.id, host: s.host, engine: s.engine, name: s.name, tmux: s.tmux, sessionId: s.sessionId } });
    for (const hst of f?.hosts ?? []) for (const w of hst.windows ?? []) out.windows.push({ ...w, host: hst.host });
  } else if (f?.hosts) {
    for (const hst of f.hosts) { for (const s of hst.sessions ?? []) out.sessions.push({ ...s, host: hst.host }); for (const w of hst.windows ?? []) out.windows.push({ ...w, host: hst.host }); }
  } else if (snap) {
    for (const s of snap.sessions ?? []) out.sessions.push({ ...s, host: 'local' });
    for (const w of snap.windows ?? []) out.windows.push({ ...w, host: 'local' });
  }
  return out;
}

export class Palette {
  constructor(ctx, views) { this.ctx = ctx; this.views = views; this.el = null; this.items = []; this.sel = 0; }
  get isOpen() { return Boolean(this.el); }
  async open(initial = '') {
    if (this.el) { this.input.focus(); return; }
    this.input = h('input', { type: 'text', placeholder: 'Jump to a session, window or view. Commands: ask <question>, msg <name> <text>, capture <target>, keys <target> <key>, launch, host <name>', autocomplete: 'off', spellcheck: 'false', value: initial });
    this.results = h('div', { class: 'results' });
    this.el = h('div', { class: 'palette-bg', onclick: (e) => { if (e.target === this.el) this.close(); } },
      h('div', { class: 'palette', role: 'dialog', 'aria-label': 'Command palette' }, this.input, this.results,
        h('div', { class: 'foot' }, h('span', null, '↑↓ choose'), h('span', null, 'enter run'), h('span', null, 'esc close'))));
    document.body.append(this.el);
    this.input.addEventListener('input', () => this.#update());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); this.sel = Math.min(this.items.length - 1, this.sel + 1); this.#draw(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); this.sel = Math.max(0, this.sel - 1); this.#draw(); }
      else if (e.key === 'Enter') { e.preventDefault(); this.#run(this.items[this.sel]); }
      else if (e.key === 'Escape') { this.close(); }
    });
    this.input.focus(); this.input.select();
    await this.#loadIndex();
    this.#update();
  }
  close() { this.el?.remove(); this.el = null; }
  async #loadIndex() {
    this.index = paletteIndex(this.ctx.state, this.ctx.strips?.() ?? []);
    // With the compact board, plain windows (no agent) come from the fleet summary, which no longer streams: read it
    // again in the background (the daemon caches it) and index once more when it lands.
    if (this.ctx.state.board && Date.now() - (this.fleetAt ?? 0) > 30_000) {
      this.fleetAt = Date.now();
      this.ctx.callQuiet('fleet.summary', {}, { host: 'local' }).then((r) => { if (!r?.hosts) return; this.ctx.setFleet?.(r); if (this.el) { this.index = paletteIndex(this.ctx.state, this.ctx.strips?.() ?? []); this.#update(); } }).catch(() => {});
    }
    if (!this.index.sessions.length) {
      try { const r = await this.ctx.callQuiet('sessions.list', { includeRecent: false }); for (const s of r.sessions) this.index.sessions.push({ ...s, host: this.ctx.host() }); } catch { /* fine */ }
    }
  }
  #update() {
    const q = this.input.value.trim();
    const [cmd, ...rest] = q.split(/\s+/);
    const items = [];
    const low = q.toLowerCase();
    const words = low.split(/\s+/).filter(Boolean);
    const score = (hay) => { const s = hay.toLowerCase(); let sc = 0; for (const w of words) { const i = s.indexOf(w); if (i < 0) return -1; sc += i === 0 ? 3 : 1; } return sc; };
    // commands
    if (/^(ask|manager)$/i.test(cmd) && rest.length) {
      const text = rest.join(' ');
      items.push({ kind: 'command', label: 'Ask the manager', small: text, run: () => { this.ctx.manager.show(); this.ctx.manager.store.send(text).catch((e) => this.ctx.toast(`Manager: ${e.message}`, 'error')); } });
    }
    if (/^(msg|message|say)$/i.test(cmd) && rest.length >= 2) {
      const name = rest[0]; const text = rest.slice(1).join(' ');
      for (const s of this.#findSessions(name)) items.push({ kind: 'command', label: `Message ${s.name ?? s.id}`, small: text, run: () => this.ctx.callQuiet('sessions.message', { id: s.id, text }, { host: s.host }).then(() => this.ctx.toast(`Sent to ${s.name ?? s.id}`, 'ok')).catch((e) => this.ctx.toast(e.message, 'error')) });
    }
    if (/^(cap|capture)$/i.test(cmd) && rest[0]) items.push({ kind: 'command', label: `Open window ${rest[0]}`, run: () => this.ctx.open({ kind: 'window', id: rest[0] }) });
    if (/^keys?$/i.test(cmd) && rest.length >= 2) items.push({ kind: 'command', label: `Send ${rest.slice(1).join(' ')} to ${rest[0]}`, run: () => this.ctx.callQuiet('tmux.keys', { target: rest[0], keys: rest.slice(1) }).then(() => this.ctx.toast('Keys sent', 'ok')).catch((e) => this.ctx.toast(e.message, 'error')) });
    if (/^launch$/i.test(cmd)) items.push({ kind: 'command', label: 'Launch an agent' + (rest.length ? `: ${rest.join(' ')}` : ''), run: () => this.ctx.nav('launch', ...(rest.length ? [rest.join(' ')] : [])) });
    if (/^host$/i.test(cmd) && rest[0]) for (const hst of this.ctx.hosts().filter((x) => x.name.includes(rest[0]))) items.push({ kind: 'host', label: `Switch to ${hst.name}`, run: () => this.ctx.setHost(hst.name) });
    if (/^(search|find|grep)$/i.test(cmd) && rest.length) items.push({ kind: 'command', label: `Search every session for "${rest.join(' ')}"`, run: () => this.ctx.nav('search', rest.join(' ')) });
    // views
    for (const v of this.views) { const sc = q ? score(v.label) : 0; if (sc >= 0) items.push({ kind: 'view', label: v.label, sc: sc + 2, run: () => this.ctx.nav(v.id) }); }
    // sessions
    for (const s of this.index?.sessions ?? []) {
      if (!s.live && !q) continue;
      const hay = `${s.name ?? ''} ${s.id ?? ''} ${s.cwd ?? ''} ${s.tmux ?? ''} ${s.host}`;
      const sc = q ? score(hay) : 0; if (sc < 0) continue;
      items.push({ kind: s.engine, label: s.name ?? s.id, small: [s.host !== 'local' ? s.host : null, s.status, s.tmux].filter(Boolean).join('  '), sc: sc + (s.live ? 1 : 0) + (s.status === 'busy' ? 1 : 0), state: s.status, run: () => this.ctx.open(s.open ?? { kind: 'session', id: s.id, host: s.host, engine: s.engine, name: s.name }) });
    }
    // windows
    for (const w of this.index?.windows ?? []) {
      const hay = `${w.target} ${w.name} ${w.agent?.name ?? ''} ${w.host}`;
      const sc = q ? score(hay) : -1; if (sc < 0) continue;
      items.push({ kind: 'tmux', label: `${w.target}  ${w.name}`, small: [w.host !== 'local' ? w.host : null, w.agent?.name, w.screen?.state].filter(Boolean).join('  '), sc, state: w.screen?.state, run: () => this.ctx.open({ kind: 'window', id: w.target, host: w.host, name: w.name, engine: w.agent?.engine, sessionId: w.agent?.sessionId }) });
    }
    // hosts
    if (q) for (const hst of this.ctx.hosts()) { const sc = score(hst.name); if (sc >= 0) items.push({ kind: 'host', label: hst.name, small: 'switch host', sc, run: () => this.ctx.setHost(hst.name) }); }
    items.sort((a, b) => (b.kind === 'command') - (a.kind === 'command') || (b.sc ?? 0) - (a.sc ?? 0));
    this.items = items.slice(0, 40); this.sel = 0; this.#draw();
  }
  #findSessions(name) { const n = name.toLowerCase(); return (this.index?.sessions ?? []).filter((s) => s.live && ((s.name ?? '').toLowerCase().includes(n) || String(s.id).startsWith(n))).slice(0, 3); }
  #draw() {
    clear(this.results);
    if (!this.items.length) { this.results.append(h('div', { class: 'pr' }, h('span', { class: 'kind' }, ''), h('span', { class: 'lbl muted' }, 'Nothing matches'))); return; }
    this.items.forEach((it, i) => {
      const row = h('div', { class: 'pr', 'aria-selected': i === this.sel ? 'true' : 'false', onclick: () => this.#run(it), onmousemove: () => { if (this.sel !== i) { this.sel = i; this.#draw(); } } },
        h('span', { class: 'kind' }, ['claude', 'codex', 'headless'].includes(it.kind) ? engine(it.kind) : it.kind),
        h('span', { class: 'lbl' }, it.label, it.small ? h('small', null, it.small) : null),
        it.state ? h('span', { class: 'mark' }, dot(it.state), it.state) : h('span', { class: 'hint' }, it.kind === 'command' ? 'run' : 'open'));
      this.results.append(row);
      if (i === this.sel) row.scrollIntoView({ block: 'nearest' });
    });
  }
  #run(it) { if (!it) return; this.close(); try { it.run(); } catch (e) { this.ctx.toast(e.message, 'error'); } }
}
