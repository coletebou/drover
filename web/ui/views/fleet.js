// Fleet: every known host with its ssh reachability and, for hosts in the last
// fleet summary, what is running there. Probe now re-probes the fleet list;
// Facts expands a row with uptime, disk, docker and identity. Clicking a host
// makes it the working host and goes to the board.
import { h, clear, mark, dot, kv, fmtTime, matchQ, empty, loading, btn, plural } from '../dom.js';

const LOCAL = { host: 'local' };

export default {
  id: 'fleet', label: 'Fleet', key: 'h',
  mount(root, ctx) {
    let q = ''; let alive = true; let probing = false; let loadingFleet = false;
    const facts = new Map();   // host -> { loading, error, data }
    const open = new Set();    // hosts whose facts row is expanded
    const meta = h('span', { class: 'muted small' });
    const probeBtn = btn('Probe now', probeAll, { cls: 'sm', title: 'ssh <host> echo ok for every fleet host, in parallel' });
    const head = h('div', { class: 'view-head' }, h('h1', null, 'Fleet'), meta, h('span', { class: 'spacer' }), probeBtn, btn('Refresh', () => refreshFleet(), { cls: 'sm', title: 'Re-read sessions and windows on the reachable hosts' }));
    const note = h('p', { class: 'muted small', style: { margin: '0 0 12px' } }, 'Hosts come from claude/fleet-hosts.txt and ssh config names. Click a host to make it the working host and open the board there.');
    const wrap = h('div');
    root.append(head, note, wrap);

    const summaryOf = (name) => ctx.state.fleet?.hosts?.find((x) => x.host === name) ?? null;
    const reachable = (name) => name === 'local' || ctx.hostUp(name) === true;

    function reachCell(hst) {
      if (hst.name === 'local') return mark('up', 'this daemon');
      if (probing && hst.source === 'fleet') return h('span', { class: 'pending' }, 'probing');
      const p = ctx.state.probe.get(hst.name);
      if (!p) return h('span', { class: 'faint' }, 'not probed');
      return h('span', { class: 'mark' }, dot(p.up ? 'up' : 'down'), p.up ? 'up' : 'down', h('span', { class: 'muted small', title: p.error ?? '' }, p.up ? `${p.ms} ms` : (p.error ?? '').slice(0, 60)));
    }
    function num(n) { return h('td', { class: 'num' }, n == null ? '' : h('span', { class: n ? '' : 'faint' }, String(n))); }

    function render() {
      if (!alive) return;
      const hosts = ctx.hosts();
      const vis = hosts.filter((hst) => matchQ({ ...hst, probe: ctx.state.probe.get(hst.name), summary: summaryOf(hst.name) ? { live: true } : null }, q));
      const probes = hosts.filter((x) => x.name !== 'local').map((x) => ctx.state.probe.get(x.name));
      const up = probes.filter((p) => p?.up).length; const down = probes.filter((p) => p && !p.up).length; const unknown = probes.filter((p) => !p).length;
      const fl = ctx.state.fleet;
      meta.textContent = `${plural(hosts.length, 'host')}: ${up} reachable, ${down} down, ${unknown} not probed${fl ? `; summary read ${fmtTime(fl.ts)}` : loadingFleet ? '; reading the fleet' : ''}`;
      clear(wrap);
      if (!vis.length) { wrap.append(empty(hosts.length ? 'No host matches' : 'No hosts known', hosts.length ? 'Loosen the search.' : 'Add names to claude/fleet-hosts.txt or ~/.ssh/config.')); return; }
      const tb = h('tbody');
      for (const hst of vis) {
        const current = hst.name === ctx.host();
        const s = summaryOf(hst.name);
        const live = s ? s.sessions.filter((x) => x.live) : null;
        const busy = live ? live.filter((x) => x.status === 'busy').length : null;
        const dialogs = s ? s.windows.filter((w) => w.screen?.state === 'dialog').length : null;
        const go = () => { ctx.setHost(hst.name, { remount: false }); ctx.nav('board'); };
        const stop = (fn) => (e) => { e.stopPropagation(); fn(); };
        tb.append(h('tr', { tabindex: 0, 'aria-selected': current ? 'true' : 'false', onclick: go, onkeydown: (e) => { if (e.key === 'Enter') go(); } },
          h('td', null, h('span', { class: 'mono' }, hst.display), current ? h('span', { class: 'em small' }, '  current') : null),
          h('td', { class: 'opt' }, h('span', { class: 'muted small' }, hst.source), hst.inSshConfig && hst.source !== 'ssh-config' ? h('span', { class: 'faint small' }, ', in ssh config') : null),
          h('td', null, reachCell(hst)),
          num(live ? live.length : null), num(busy), num(s ? s.windows.length : null), num(dialogs),
          h('td', { class: 'opt' }, s?.error ? h('span', { class: 'small', title: s.error }, mark('error', s.error.length > 60 ? s.error.slice(0, 57) + '...' : s.error)) : s?.codexError ? h('span', { class: 'muted small' }, 'codex: ', s.codexError) : null),
          h('td', { class: 'nowrap' },
            reachable(hst.name) ? btn(open.has(hst.name) ? 'Hide facts' : 'Facts', stop(() => toggleFacts(hst.name)), { cls: 'sm quiet' }) : null,
            hst.name !== 'local' ? btn('Probe', stop(() => probeOne(hst.name)), { cls: 'sm quiet', title: `ssh ${hst.name} echo ok` }) : null)));
        if (open.has(hst.name)) tb.append(h('tr', null, h('td', { colspan: 9, style: { paddingLeft: '18px' } }, factsCell(hst.name))));
      }
      wrap.append(h('table', { class: 'tbl' },
        h('thead', null, h('tr', null, h('th', null, 'Host'), h('th', { class: 'opt' }, 'Source'), h('th', null, 'Reachability'), h('th', { class: 'num', title: 'live sessions' }, 'Live'), h('th', { class: 'num' }, 'Busy'), h('th', { class: 'num' }, 'Windows'), h('th', { class: 'num' }, 'Dialogs'), h('th', { class: 'opt' }, 'Error'), h('th', null, ''))), tb));
    }

    function factsCell(name) {
      const f = facts.get(name);
      if (!f || f.loading) return loading('Collecting facts');
      if (f.error) return h('div', { class: 'notice error', style: { marginBottom: 0 } }, f.error);
      const d = f.data;
      const disk = (x) => (x ? `${x.pct} used, ${x.avail} free of ${x.size}` : null);
      const out = h('div', null,
        kv([['host', d.host], ['as of', fmtTime(d.ts)], ['uptime', d.uptime], ['disk /', disk(d.disk?.root)], ['disk /mnt/nvme', disk(d.disk?.nvme)],
          ['docker', d.docker ? `${plural(d.docker.total, 'container')}, ${d.docker.unhealthy} unhealthy` : d.dockerUnavailable ? `unavailable: ${d.dockerUnavailable}` : 'not available'],
          ['tmux windows', d.tmuxWindows], ['node', d.node],
          ['identity', d.identity && Object.keys(d.identity).length ? Object.entries(d.identity).map(([k, v]) => `${k}=${v}`).join(' ') : null]]));
      if (d.docker?.containers?.length) {
        out.append(h('details', { style: { marginTop: '6px' } }, h('summary', { class: 'muted small', style: { cursor: 'pointer' } }, plural(d.docker.containers.length, 'container')),
          h('table', { class: 'tbl small', style: { marginTop: '4px' } }, h('tbody', null, d.docker.containers.map((c) => h('tr', null, h('td', { class: 'mono' }, c.name), h('td', null, /unhealthy/i.test(c.status) ? mark('error', c.status) : c.status)))))));
      }
      out.append(h('div', { class: 'toolbar', style: { margin: '8px 0 0' } }, btn('Reload', () => loadFacts(name), { cls: 'sm quiet' }),
        btn('Stacks', () => ctx.nav('stacks', name), { cls: 'sm quiet', title: 'Compose stacks on this machine: health, failing services, the code each runs' })));
      return out;
    }
    async function toggleFacts(name) {
      if (open.has(name)) { open.delete(name); render(); return; }
      open.add(name);
      if (!facts.get(name)?.data) await loadFacts(name); else render();
    }
    async function loadFacts(name) {
      facts.set(name, { loading: true }); render();
      try { const d = await ctx.callQuiet('host.facts', {}, { host: name }); facts.set(name, d ? { data: d } : { error: 'empty response' }); }
      catch (e) { facts.set(name, { error: `${name}: ${e.message}` }); }
      if (alive) render();
    }
    async function probeAll() {
      const names = ctx.hosts().filter((x) => x.source === 'fleet').map((x) => x.name);
      if (!names.length) { ctx.toast('No fleet hosts to probe (claude/fleet-hosts.txt is empty)', 'info'); return; }
      probing = true; probeBtn.disabled = true; render();
      try { const r = await ctx.call('host.probe', { hosts: names }, LOCAL); for (const p of r ?? []) ctx.state.probe.set(p.host, p); }
      catch { /* toasted */ }
      finally { probing = false; probeBtn.disabled = false; if (alive) render(); }
      refreshFleet();
    }
    async function probeOne(name) {
      try { const r = await ctx.call('host.probe', { hosts: [name] }, LOCAL); for (const p of r ?? []) ctx.state.probe.set(p.host, p); }
      catch { /* toasted */ }
      if (alive) render();
    }
    /** Re-read fleet.summary (sessions + windows on local and the probed-up hosts); setFleet also redraws the host strip. */
    async function refreshFleet() {
      if (loadingFleet) return;
      loadingFleet = true; render();
      try { const r = await ctx.callQuiet('fleet.summary', {}, LOCAL); if (!alive) return; ctx.setFleet?.(r); }
      catch (e) { if (alive) ctx.toast(`fleet.summary: ${e.message}`, 'error'); }
      finally { loadingFleet = false; if (alive) render(); }
    }

    render();
    if (!ctx.state.fleet) refreshFleet();
    const timer = setInterval(() => { if (!document.hidden) refreshFleet(); }, 30_000);
    return {
      destroy() { alive = false; clearInterval(timer); },
      search(qq) { q = qq; render(); },
      probe() { render(); },
      key(e) {
        const rows = [...root.querySelectorAll('tr[tabindex]')]; if (!rows.length) return;
        const idx = rows.findIndex((r) => r === document.activeElement);
        if (e.key === 'j' || e.key === 'k') { e.preventDefault(); rows[Math.max(0, Math.min(rows.length - 1, idx + (e.key === 'j' ? 1 : -1)))]?.focus(); }
      },
    };
  },
};
