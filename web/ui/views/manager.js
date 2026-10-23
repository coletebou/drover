// Manager: a native console for an OpenClaw manager (any host that runs one;
// this machine by default). The conversation (the same component as the board's
// dock and the popup, threads included), a status card (openclaw.status: service,
// gateway, health, model, automations, cost today (no spend cap), truth-file
// activity, install and egress checks), actions (Sweep now, traces, how to open
// the full dashboard) and the manager's recent truth-file feed. The gateway token
// is never fetched or shown here.
import { h, clear, btn, kv, ago, fmtTime, empty, loading, plural } from '../dom.js';
import { copyButton } from '../clip.js';
import { mountManagerChat, threadLine } from '../manager-chat.js';

const fmtUp = (s) => (s == null ? '' : s < 3600 ? `${Math.round(s / 60)} min` : s < 172800 ? `${(s / 3600).toFixed(1)} h` : `${Math.round(s / 86400)} days`);

export default {
  id: 'manager', label: 'Manager', key: 'o',
  mount(root, ctx) {
    const store = ctx.manager.store;
    let alive = true; let host = store.host; let st = null; let feedItems = null;
    const hostSel = h('select', { 'aria-label': 'Manager host', onchange: () => { host = hostSel.value; store.setHost(host); st = null; feedItems = null; paint(); load(); loadFeed(); } });
    const fill = () => { clear(hostSel); for (const x of ctx.hosts()) hostSel.append(h('option', { value: x.name, selected: x.name === host ? true : null }, x.name === 'local' ? x.display : x.name)); if (!ctx.hosts().some((x) => x.name === host)) hostSel.append(h('option', { value: host, selected: true }, host)); };
    fill();
    const sweepBtn = btn('Sweep now', async () => {
      sweepBtn.disabled = true; sweepBtn.firstChild.textContent = 'Asking…';
      try { await ctx.call('openclaw.sweep', {}, { host }); ctx.toast('The manager is sweeping; its notes land in the feed', 'ok', 5000); setTimeout(() => loadFeed(true), 15_000); }
      catch { /* toasted */ } finally { sweepBtn.disabled = false; sweepBtn.firstChild.textContent = 'Sweep now'; }
    }, { cls: 'sm primary', title: 'openclaw system event "sweep now" --mode now' });
    const head = h('div', { class: 'view-head' }, h('h1', null, 'Manager'), h('span', { class: 'muted small' }, 'OpenClaw manager on'), hostSel, h('span', { class: 'spacer' }),
      sweepBtn, btn('Pop out', () => ctx.manager.popOut(), { cls: 'sm', title: 'Float the conversation above every app' }), btn('Refresh', () => { load(true); loadFeed(true); store.refreshThreads(); }, { cls: 'sm quiet' }));
    const chatEl = h('section', { class: 'manager-chat' });
    const threadsEl = h('section', { class: 'card set-card' });
    const statusEl = h('section', { class: 'card set-card' });
    const actionsEl = h('section', { class: 'card set-card' });
    const feedEl = h('section', { class: 'card set-card' });
    root.append(head, h('div', { class: 'manager' }, chatEl, h('div', { class: 'manager-col' }, threadsEl, statusEl, actionsEl, feedEl)));
    const chat = mountManagerChat(chatEl, ctx, { store, variant: 'view', onPopOut: () => ctx.manager.popOut() });
    // On this view m goes to this conversation, and a reply here is not "unread".
    const offDock = ctx.manager.registerDock({ visible: () => alive, focus: () => chat.focus() });
    function paintThreads() {
      clear(threadsEl);
      threadsEl.append(h('div', { class: 'set-head' }, h('h2', null, 'Threads'), h('p', { class: 'muted small' }, 'Each thread is its own conversation with the manager; every client shares main.')));
      const list = store.threads;
      if (list === null) { threadsEl.append(h('p', { class: 'muted small' }, 'One conversation (this daemon has no threads).')); return; }
      // main is always there to go back to, said in or not.
      const rows = list.some((t) => t.thread === 'main') ? list : [...list, { thread: 'main', turns: 0, lastTs: null, lastText: '' }];
      for (const t of rows) threadsEl.append(h('div', { class: `row${t.thread === store.thread ? ' current' : ''}`, role: 'button', tabindex: 0, 'aria-current': t.thread === store.thread ? 'true' : null, onclick: () => store.setThread(t.thread), onkeydown: (e) => { if (e.key === 'Enter') store.setThread(t.thread); } },
        h('span', { class: 'mono small' }, t.thread), h('div', { class: 'main-col' }, h('div', { class: 'l1' }, h('span', { class: 'trunc' }, t.lastText || 'nothing said yet')), h('div', { class: 'l2' }, threadLine(t))), t.busy ? h('span', { class: 'mark' }, h('span', { class: 'dot busy pulse', 'aria-hidden': 'true' }), 'answering') : null));
    }
    const offStore = store.on((what) => { if (!alive) return; if (what === 'threads' || what === 'thread') paintThreads(); if (what === 'host' && store.host !== host) { host = store.host; fill(); st = null; feedItems = null; paint(); load(); loadFeed(); } });
    paintThreads();

    function paint() {
      clear(statusEl);
      statusEl.append(h('div', { class: 'set-head' }, h('h2', null, 'Status'), h('p', { class: 'muted small' }, `openclaw.status on ${host}`)));
      if (!st) { statusEl.append(loading('Asking the manager host')); }
      else if (st.error) statusEl.append(empty('Could not read the manager status', st.error));
      else if (!st.configured) statusEl.append(empty('No manager on this host', st.reason));
      else {
        const u = st.unit ?? {}; const c = st.cost ?? {}; const m = st.model ?? {}; const a = st.automations ?? {}; const hl = st.health ?? {}; const inst = st.install ?? {}; const eg = st.checks?.egress ?? {};
        const mark = (ok, label) => h('span', { class: 'mark' }, h('span', { class: `dot ${ok ? 'idle' : 'dead'}`, 'aria-hidden': 'true' }), label);
        // A mark does not wrap (.mark is nowrap app-wide): keep its label short and put the detail beside it.
        const state = (ok, label, detail) => h('span', null, mark(ok, label), detail ? h('span', { class: 'muted small' }, `  ${detail}`) : null);
        const muted = (t) => h('span', { class: 'muted' }, t);
        const exit = u.lastExitCode != null && u.lastExitCode !== 0 ? `, last exit ${u.lastExitCode}${u.lastExitReason ? ` ${u.lastExitReason}` : ''}` : '';
        statusEl.append(kv([
          ['covers', st.scope ? `${st.scope.hosts === 'local' ? 'this host only' : `every host it reaches${st.scope.exclude?.length ? `, except ${st.scope.exclude.join(', ')}` : ''}`}${st.scope.digest ? '; owns the digest and MR watch' : ''}` : null],
          ['writes as', st.actor ?? 'manager'],
          ['service', u.error ? muted(u.error) : state(u.active === 'active', `${u.active}${u.uptimeSec != null ? `, up ${fmtUp(u.uptimeSec)}` : ''}`, `${u.name}${u.kind ? ` (${u.kind})` : ''}${u.restarts ? `, ${plural(u.restarts, 'restart')}` : ''}${exit}`)],
          ['gateway', state(st.gateway?.up, st.gateway?.up ? 'answering' : 'not answering', st.gateway?.url ?? '')],
          ['health', hl.error ? muted(hl.error) : state(hl.ok, hl.ok ? 'ok' : 'not ok', [hl.plugins?.length ? `plugins ${hl.plugins.join(', ')}` : '', hl.pluginErrors ? plural(hl.pluginErrors, 'plugin error') : '', hl.configReload && hl.configReload !== 'active' ? `hot reload ${hl.configReload}` : ''].filter(Boolean).join('; '))],
          ['model', h('span', null, h('code', null, m.primary ?? '?'), m.thinking ? `, thinking ${m.thinking}` : '', m.fallbacks?.length ? h('span', { class: 'muted small' }, `  then ${m.fallbacks.join(', ')}`) : null)],
          ['heartbeat', m.heartbeatEvery ? `every ${m.heartbeatEvery}${m.heartbeatModel ? ` on ${m.heartbeatModel}` : ''}${m.heartbeatThinking ? `, thinking ${m.heartbeatThinking}` : ''}` : null],
          ['last run', a.error ? muted(a.error) : a.lastRunAt ? h('span', null, ago(a.lastRunAt, { short: false }), h('span', { class: 'muted small' }, `  (${fmtTime(a.lastRunAt)})`)) : 'none recorded'],
          ['next run', a.nextRunAt ? fmtTime(a.nextRunAt) : null],
          ['cost today', c.error ? muted(c.error) : h('span', null, c.todayUsd != null ? `$${Number(c.todayUsd).toFixed(2)}` : 'unknown', h('span', { class: 'muted small' }, `  (${c.fresh ? '' : `cost cache ${c.cacheStatus ?? 'unknown'}, `}no spend cap)`))],
          ['truth file, 24 h', `${plural(st.wal24h?.notes ?? 0, 'note')}, ${plural(st.wal24h?.pins ?? 0, 'pin')}, ${plural(st.wal24h?.chats ?? 0, 'chat reply', 'chat replies')}${st.wal24h?.last ? `, last ${fmtTime(st.wal24h.last)}` : ''}`],
          ['install', inst.managed ? state(!inst.drift?.length, inst.drift?.length ? 'config drifted' : `OpenClaw ${inst.openclaw}`, `node ${inst.node}, profile ${inst.profile}${inst.source?.commit ? `, from ${inst.source.commit}${inst.source.dirty ? ' (dirty)' : ''}` : ''}${inst.drift?.length ? `; differs at ${inst.drift.slice(0, 4).join(', ')}${inst.drift.length > 4 ? ', ...' : ''} (re-run drover manager setup)` : ''}`) : state(false, 'not managed', inst.hint)],
          ['egress check', eg.error ? muted(eg.error) : state(eg.ok, eg.ok ? 'nothing unexpected' : plural(eg.unexpected?.length ?? 0, 'problem'), eg.ok ? '' : (eg.unexpected ?? []).slice(0, 3).join('; '))],
        ]));
        if (a.jobs?.length) statusEl.append(h('details', null, h('summary', null, `automations (${a.jobs.length})`), h('table', { class: 'tbl' }, h('tbody', null, ...a.jobs.map((j) => h('tr', null, h('td', null, j.name), h('td', { class: 'muted small' }, j.schedule ?? ''), h('td', { class: 'small' }, j.enabled ? (j.status ?? j.lastStatus ?? 'enabled') : 'disabled'), h('td', { class: 'small mono' }, j.lastRunAt ? fmtTime(j.lastRunAt) : '')))))));
        if (inst.legacy?.length) statusEl.append(h('p', { class: 'muted small' }, `Unused since drover manager setup (remove by hand once verified): ${inst.legacy.join(', ')}`));
      }
      clear(actionsEl);
      // Drover reached that host over ssh, so the same alias forwards the port; this machine needs no forward.
      const dash = st?.dashboard ?? { port: 18789, url: 'http://127.0.0.1:18789/' };
      // Forward to the next port up: a Mac that runs its own manager already listens on 18789 locally.
      const gwPort = dash.port ?? 18789; const localPort = host !== 'local' ? gwPort + 1 : gwPort;
      const forward = host !== 'local' ? `ssh -L ${localPort}:127.0.0.1:${gwPort} ${host}` : null;
      const openUrl = `http://127.0.0.1:${localPort}/`;
      const lf = st?.langfuse ?? {};
      actionsEl.append(h('div', { class: 'set-head' }, h('h2', null, 'Traces and dashboard')),
        lf.url ? h('p', null, h('a', { href: lf.url, target: '_blank', rel: 'noopener' }, 'Open Langfuse traces'), h('span', { class: 'muted small' }, `  ${lf.url}, spans named openclaw.*.${lf.note ? ` ${lf.note}.` : ''}`)) : h('p', { class: 'muted small' }, lf.note ? `Traces: ${lf.note}.` : 'Traces: unknown until the status loads.'),
        h('details', null, h('summary', null, 'Open the full OpenClaw dashboard'),
          h('ol', { class: 'small steps' },
            forward ? h('li', null, 'Forward the gateway port: ', h('code', null, forward), ' ', copyButton(forward, 'Copy')) : null,
            h('li', null, 'Open ', h('a', { href: openUrl, target: '_blank', rel: 'noopener' }, openUrl), '.'),
            dash.tokenCommand
              ? h('li', null, `Paste the gateway secret. Get it on ${host === 'local' ? 'this machine' : host} (Drover never fetches or shows it): `, h('code', null, dash.tokenCommand), ' ', copyButton(dash.tokenCommand, 'Copy'))
              : h('li', null, 'Paste the gateway secret: run oc gateway auth-token --show in the manager\'s environment on that host (Drover never fetches or shows it).'))));
      clear(feedEl);
      feedEl.append(h('div', { class: 'set-head' }, h('h2', null, 'What it wrote'), h('p', { class: 'muted small' }, 'Its notes, chat replies and messages in the truth file on that host, newest first.')));
      if (feedItems === null) feedEl.append(loading('Reading the truth file'));
      else if (!feedItems.length) feedEl.append(empty('Nothing from the manager yet'));
      else {
        const tl = h('div', { class: 'timeline' });
        for (const e of feedItems) tl.append(h('div', { class: 'tl' }, h('time', { title: e.ts }, fmtTime(e.ts)), h('span', { class: 'type' }, e.type === 'message' && e.to === 'manager' ? 'to it' : e.type), h('span', { class: 'what' }, e.to && e.to !== 'manager' ? h('span', { class: 'muted' }, `to ${e.to}: `) : null, e.text)));
        feedEl.append(tl);
      }
    }
    async function load(fresh = false) {
      try { st = await ctx.callQuiet('openclaw.status', fresh ? { fresh: true } : {}, { host }); }
      catch (e) { st = { error: e.message }; }
      if (alive) paint();
    }
    async function loadFeed(fresh = false) {
      try { feedItems = await ctx.callQuiet('openclaw.feed', { limit: 80, ...(fresh ? { fresh: true } : {}) }, { host }); }
      catch (e) { feedItems = []; ctx.toast(`openclaw.feed: ${e.message}`, 'error'); }
      if (alive) paint();
    }
    paint(); load(); loadFeed(); store.refreshThreads();
    const timer = setInterval(() => { load(); loadFeed(); }, 60_000);
    return {
      destroy() { alive = false; clearInterval(timer); offStore(); offDock(); chat.destroy(); },
      sse(type, data) {
        if (type === 'mutation' && /^(sessions\.message|events\.append|openclaw\.sweep)$/.test(data?.op)) setTimeout(() => loadFeed(true), 1500);
        if (type === 'turn' && data?.id === 'manager') { clearTimeout(this.threadsTimer); this.threadsTimer = setTimeout(() => store.refreshThreads(), 1200); }
      },
    };
  },
};
