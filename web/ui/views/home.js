// Home: needs-you (dialog windows, non-idle statuses, pins), live counters,
// last launches, last events.
import { h, clear, badge, fmtAgo, fmtTime, matchQ, empty, loading, debounce } from '../dom.js';
import { summarizeEvent, eventRow } from './events.js';
import { agentBadge } from './tmux.js';
import { engineOf, nameOf, statusBadge } from './sessions.js';

const ROUTINE = new Set(['busy', 'idle', 'unknown', 'dead', 'transcript', 'rollout', 'notLoaded', 'exited', 'stopped', 'completed']);

export default {
  id: 'home', label: 'Home', key: 'h',
  mount(root, ctx) {
    const el = {
      status: h('span', { class: 'dim small' }),
      counters: h('div', { class: 'stats' }),
      needs: h('div', { class: 'list' }, loading()),
      pinned: h('div', { class: 'list' }, loading()),
      launches: h('div', { class: 'list' }, loading()),
      events: h('div', { class: 'ev-list' }, loading()),
    };
    root.append(
      h('div', { class: 'view-head' }, h('h1', null, 'Home'), el.status, h('button', { class: 'btn sm', type: 'button', onclick: () => { loadLive(); loadTruth(); } }, 'Refresh')),
      el.counters,
      h('div', { class: 'grid2' },
        h('section', { class: 'panel' }, h('h2', null, 'Needs you'), el.needs),
        h('section', { class: 'panel' }, h('h2', null, 'Pinned'), el.pinned),
        h('section', { class: 'panel' }, h('h2', null, 'Last 10 launches'), el.launches),
        h('section', { class: 'panel' }, h('h2', null, 'Last 20 events'), el.events)));

    const data = { sessions: [], windows: [], state: null, events: [], dialogs: [], ts: null, source: null, scanTs: 0 };
    let q = ''; let alive = true; let scanning = false; let liveLoaded = false;

    // ------------------------------------------------------------ render
    function tile(label, value, { cls = '', onclick } = {}) {
      return h('button', { class: `stat ${cls}`.trim(), type: 'button', onclick }, h('b', null, String(value)), label);
    }
    function renderCounters() {
      const live = data.sessions.filter((s) => s.live);
      const busy = live.filter((s) => s.status === 'busy').length;
      const idle = live.filter((s) => s.status === 'idle').length;
      const other = live.length - busy - idle;
      const agentWins = data.windows.filter((w) => w.agent).length;
      clear(el.counters);
      el.counters.append(
        tile('live sessions', live.length, { onclick: () => ctx.nav('sessions') }),
        tile('busy', busy, { cls: busy ? 'busy' : '', onclick: () => ctx.nav('sessions') }),
        tile('idle', idle, { onclick: () => ctx.nav('sessions') }),
        tile('other status', other, { cls: other ? 'warn' : '', onclick: () => ctx.nav('sessions') }),
        tile('tmux windows', data.windows.length, { onclick: () => ctx.nav('tmux') }),
        tile('agent windows', agentWins, { onclick: () => ctx.nav('tmux') }),
        tile('dialogs on screen', data.dialogs.length, { cls: data.dialogs.length ? 'warn' : '', onclick: () => ctx.nav('tmux') }),
        tile('events', data.state?.count ?? 0, { onclick: () => ctx.nav('events') }));
      el.status.textContent = data.ts ? `${data.source === 'snapshot' ? 'snapshot' : 'polled'} ${fmtAgo(data.ts)} on ${ctx.host() === 'local' ? (ctx.state.frontHost ?? 'local') : ctx.host()}${scanning ? ', scanning panes for dialogs' : ''}` : 'loading...';
    }
    function renderNeeds() {
      clear(el.needs);
      const items = [];
      for (const w of data.dialogs) {
        items.push({ kind: 'dialog', w, node: h('div', { class: 'card s-waiting-on-user', tabindex: 0, role: 'button', onclick: () => ctx.nav('tmux', w.target), onkeydown: (e) => { if (e.key === 'Enter') ctx.nav('tmux', w.target); } },
          h('div', { class: 'top' }, badge('dialog', 'b-dialog'), h('span', { class: 'id' }, w.target), h('span', { class: 'ttl' }, w.name), agentBadge(w.agent)),
          h('pre', { class: 'turn-pre small' }, w.preview ?? '')) });
      }
      for (const s of data.sessions.filter((s) => s.live && !ROUTINE.has(String(s.status)))) {
        items.push({ kind: 'status', s, node: h('div', { class: 'card s-cut-off', tabindex: 0, role: 'button', onclick: () => ctx.nav('sessions', s.id), onkeydown: (e) => { if (e.key === 'Enter') ctx.nav('sessions', s.id); } },
          h('div', { class: 'top' }, badge(engineOf(s), engineOf(s) === 'codex' ? 'b-codex' : engineOf(s) === 'headless' ? 'b-headless' : 'b-claude'), h('span', { class: 'ttl' }, nameOf(s)), statusBadge(s.status), s.tmux ? h('span', { class: 'tag' }, s.tmux) : null),
          s.cwd ? h('div', { class: 'sum small dim mono' }, s.cwd) : null) });
      }
      const vis = items.filter((it) => matchQ({ ...it.w, ...it.s }, q));
      if (!liveLoaded) { el.needs.append(loading()); return; }
      if (!vis.length) { el.needs.append(empty(items.length ? 'Nothing matches.' : 'Nothing needs you right now: no dialogs on agent panes, no unusual session states.')); return; }
      for (const it of vis) el.needs.append(it.node);
    }
    function resolvePin(target) {
      const t = String(target);
      let m;
      if ((m = t.match(/^session:(.+)$/))) { const s = data.sessions.find((x) => x.id === m[1]); return { label: s ? nameOf(s) : m[1], sub: 'session', go: () => ctx.nav('sessions', m[1]) }; }
      if ((m = t.match(/^tmux:([^:]*):(.+)$/))) return { label: m[2], sub: `tmux on ${m[1] || 'local'}`, go: () => ctx.nav('tmux', m[2]) };
      const f = data.state?.features?.find((x) => x.fid === t || `feature:${x.fid}` === t);
      if (f) return { label: f.title || f.fid, sub: `feature, ${f.state}`, go: () => ctx.nav('features', f.fid) };
      return { label: t, sub: 'pin', go: null };
    }
    function renderPinned() {
      clear(el.pinned);
      const pins = data.state?.pins ?? [];
      if (!data.state) { el.pinned.append(loading()); return; }
      const vis = pins.filter((p) => matchQ(p, q));
      if (!vis.length) { el.pinned.append(empty(pins.length ? 'Nothing matches.' : 'Nothing pinned. Use Pin on a session, a tmux window or a feature.')); return; }
      for (const p of vis) {
        const r = resolvePin(p);
        el.pinned.append(h('div', { class: 'card s-idle' },
          h('div', { class: 'top' },
            r.go ? h('button', { class: 'btn sm ghost ttl', type: 'button', onclick: r.go }, r.label) : h('span', { class: 'ttl' }, r.label),
            h('span', { class: 'tag' }, r.sub), h('span', { class: 'spacer' }),
            h('button', { class: 'btn sm', type: 'button', title: 'Unpin', onclick: () => unpin(p) }, 'Unpin'))));
      }
    }
    function renderLaunches() {
      clear(el.launches);
      if (!data.state) { el.launches.append(loading()); return; }
      const list = (data.state.launches ?? []).filter((e) => matchQ(e, q)).slice(0, 10);
      if (!list.length) { el.launches.append(empty('No launches recorded yet.')); return; }
      for (const e of list) {
        const target = e.result?.tmux ?? null; const hid = e.result?.headlessId ?? null;
        el.launches.append(h('div', { class: 'card s-active', tabindex: 0, role: 'button',
          onclick: () => (target ? ctx.nav('tmux', target) : hid ? ctx.nav('sessions', hid) : ctx.nav('events')),
          onkeydown: (ev) => { if (ev.key === 'Enter') ev.currentTarget.click(); } },
        h('div', { class: 'top' }, badge(e.engine, e.engine === 'codex' ? 'b-codex' : 'b-claude'), badge(e.mode, e.mode === 'headless' ? 'b-headless' : ''), h('span', { class: 'ttl' }, target ?? (hid ? `headless ${hid.slice(0, 8)}` : '')), h('span', { class: 'tag' }, e.profile ?? ''), e.model ? h('span', { class: 'tag' }, e.model) : null, h('span', { class: 'tag right', title: e.ts }, `${e.host ?? ''} ${fmtAgo(e.ts)}`)),
        h('div', { class: 'sum small dim mono' }, e.cwd ?? ''),
        e.prompt ? h('div', { class: 'sum small clamp' }, e.prompt) : null));
      }
    }
    function renderEvents() {
      clear(el.events);
      if (!data.state) { el.events.append(loading()); return; }
      const list = data.events.filter((e) => matchQ(e, q));
      if (!list.length) { el.events.append(empty('No events yet.')); return; }
      for (const e of list) el.events.append(eventRow(e));
      el.events.append(h('div', { class: 'row small' }, h('button', { class: 'btn sm ghost', type: 'button', onclick: () => ctx.nav('events') }, 'All events')));
    }
    function render() { if (!alive) return; renderCounters(); renderNeeds(); renderPinned(); renderLaunches(); renderEvents(); }

    // ------------------------------------------------------------ data
    async function loadLive(quiet = false) {
      try {
        const [sl, wins] = await Promise.all([
          (quiet ? ctx.callQuiet : ctx.call)('sessions.list', { includeRecent: false }),
          (quiet ? ctx.callQuiet : ctx.call)('tmux.windows', {}),
        ]);
        if (!alive) return;
        data.sessions = sl?.sessions ?? []; data.windows = Array.isArray(wins) ? wins : [];
        data.ts = Date.now(); data.source = 'poll'; liveLoaded = true;
        render();
        scanDialogs();
      } catch { liveLoaded = true; render(); }
    }
    async function loadTruth(quiet = false) {
      try {
        const [st, tail] = await Promise.all([
          (quiet ? ctx.callQuiet : ctx.call)('events.state', {}),
          (quiet ? ctx.callQuiet : ctx.call)('events.tail', { limit: 20 }),
        ]);
        if (!alive) return;
        data.state = st; data.events = (Array.isArray(tail) ? tail : []).slice().reverse();
        render();
      } catch { /* toasted unless quiet */ }
    }
    /** tmux.windows has no screen classification, so capture agent panes (read-only) and classify. */
    async function scanDialogs() {
      if (scanning || Date.now() - data.scanTs < 8000) return;
      scanning = true; renderCounters();
      const wins = data.windows.filter((w) => w.agent);
      const out = []; let i = 0;
      await Promise.all(Array.from({ length: Math.min(4, wins.length) }, async () => {
        while (i < wins.length && alive) {
          const w = wins[i++];
          try {
            const r = await ctx.callQuiet('tmux.capture', { target: w.target, lines: 40 });
            if (r?.screen?.state === 'dialog') out.push({ ...w, screen: r.screen, preview: String(r.text ?? '').split('\n').slice(-8).join('\n') });
          } catch { /* window may be gone */ }
        }
      }));
      scanning = false; data.scanTs = Date.now();
      if (!alive) return;
      data.dialogs = out.sort((a, b) => a.target.localeCompare(b.target));
      render();
    }
    async function unpin(target) {
      try { await ctx.call('events.append', { event: { type: 'unpin', target } }); loadTruth(true); } catch { /* toasted */ }
    }

    loadLive(); loadTruth();
    const timer = setInterval(() => { if (!document.hidden) { loadLive(true); } }, 30_000);
    const truthSoon = debounce(() => loadTruth(true), 700);

    return {
      destroy() { alive = false; clearInterval(timer); },
      search(qq) { q = qq; render(); },
      sse(type, d) {
        if (type === 'snapshot' && ctx.isLocal() && d) {
          data.sessions = d.sessions ?? data.sessions; data.windows = d.windows ?? data.windows; data.ts = d.ts ?? Date.now(); data.source = 'snapshot'; liveLoaded = true;
          render(); scanDialogs();
        } else if (type === 'mutation') truthSoon();
      },
    };
  },
};
