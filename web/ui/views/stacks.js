// Stacks: every Docker compose stack on every machine Drover reaches (docker.fleet), what is up and healthy, what is
// failing and why, and what code each stack runs. Logs read one service; Restart, Start, Exec and Run act on one
// discovered project and take a second click within 5 s (the daemon records each in the truth file). #/stacks/<host>
// shows one machine.
import { h, clear, dot, fmtTime, matchQ, empty, loading, btn, chip, plural, shortPath } from '../dom.js';
import { countsLine, kindsLine, isWarning } from '../stacks-text.js';

const LOCAL = { host: 'local' };
const CONFIRM_MS = 5000;
const RUNNING = new Set(['healthy', 'up', 'unhealthy', 'starting']);
const STARTABLE = new Set(['failed', 'stopped', 'completed', 'created']);
// Container and stack states -> the dot colors the other views use (moss ok, steel busy, amber needs a look, brick bad).
const TONE = { healthy: 'ok', up: 'ok', completed: '', starting: 'busy', removing: 'busy', stopped: 'wait', created: 'wait', paused: 'wait', unknown: 'wait', unhealthy: 'error', restarting: 'error', failed: 'error', dead: 'error', ok: 'ok', degraded: 'wait', down: 'error', empty: '' };
/** A stack that needs attention: something is failing (degraded) or nothing runs (down). */
const needsAttention = (s) => s.verdict === 'degraded' || s.verdict === 'down';

/**
 * A command line as an argv, split the way a shell splits words (single and double quotes, backslashes) with nothing
 * expanded: variables, globs and operators reach the container as literal text. The daemon only ever gets the array.
 */
export function splitArgv(line) {
  const out = []; let cur = '', word = false, q = null;
  const s = String(line ?? '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q === "'") { if (ch === "'") q = null; else cur += ch; continue; }
    if (q === '"') {
      if (ch === '"') q = null;
      else if (ch === '\\' && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) cur += s[++i];
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { q = ch; word = true; continue; }
    if (ch === '\\' && i + 1 < s.length) { cur += s[++i]; word = true; continue; }
    if (/\s/.test(ch)) { if (word) { out.push(cur); cur = ''; word = false; } continue; }
    cur += ch; word = true;
  }
  if (q) throw new Error(`unclosed ${q === '"' ? 'double' : 'single'} quote`);
  if (word) out.push(cur);
  return out;
}

/** The code line: where the stack's source is, its branch or detached HEAD, subject, dirty files, ahead/behind. */
function gitLine(g, { label } = {}) {
  if (!g) return null;
  const where = g.detached ? `detached @ ${g.short ?? '?'}` : `${g.branch ?? '?'} @ ${g.short ?? '?'}`;
  const dirty = g.dirty ? (g.dirty.changed || g.dirty.untracked ? `${g.dirty.changed} changed, ${g.dirty.untracked} untracked` : 'clean') : null;
  const ab = g.ahead !== null && g.ahead !== undefined ? `+${g.ahead}/-${g.behind} vs ${g.against}` : null;
  return h('div', { class: 'stk-git small' },
    label ? h('span', { class: 'muted' }, `${label} `) : null,
    h('span', { class: 'mono', title: g.toplevel }, shortPath(g.toplevel, 60)),
    g.worktree ? h('span', { class: 'em', title: g.mainRepo ?? '' }, ` worktree of ${shortPath(g.mainRepo ?? '?', 40)}`) : null,
    '  ', h('span', { class: 'mono' }, where),
    g.subject ? h('span', { class: 'muted', title: g.subject }, `  ${g.subject.length > 80 ? `${g.subject.slice(0, 79)}…` : g.subject}`) : null,
    dirty ? h('span', { class: dirty === 'clean' ? 'faint' : '' }, `  ${dirty}`) : null,
    ab ? h('span', { class: 'muted' }, `  ${ab}`) : null,
    g.error ? h('span', { class: 'faint', title: g.error }, '  (git status failed)') : null);
}

export default {
  id: 'stacks', label: 'Stacks', key: 'd',
  mount(root, ctx, params) {
    let data = null, err = null, q = '', alive = true, loadingFleet = false;
    let only = params?.[0] ?? null;              // one machine (#/stacks/<host>)
    let filter = 'all';                         // all | attention
    let showLoose = false;
    const openSvc = new Set();                  // stack keys whose services table is open
    const logs = new Map();                     // service key -> { loading, error, data, tail }
    const shells = new Map();                   // service key -> { mode: exec|run, line, result, running, error }
    const confirm = new Map();                  // action key -> { until, timer }
    const busy = new Set();                     // action keys in flight
    const refreshing = new Set();               // routes being re-read
    const readOnly = new Set();                 // routes read without Drover there (readOnly answers): no logs, no verbs

    const meta = h('span', { class: 'muted small' });
    const refreshBtn = btn('Refresh', () => load({ fresh: true }), { cls: 'sm', title: 'Read docker on every machine again (bypasses the 30 s cache)' });
    const head = h('div', { class: 'view-head' }, h('h1', null, 'Stacks'), meta, h('span', { class: 'spacer' }), refreshBtn);
    const note = h('p', { class: 'muted small', style: { margin: '0 0 12px' } },
      'Docker compose stacks on every machine Drover reaches: what is up and healthy, what is failing and why, and what code each stack runs. Logs reads one service; Restart, Start, Exec and Run act on one stack after a second click and are recorded in the truth file. Nothing here can take a stack down, build or pull.');
    const chips = h('div', { class: 'toolbar' });
    const wrap = h('div');
    root.append(head, note, chips, wrap);
    wrap.append(loading('Reading docker on every machine'));

    const hostsShown = () => (data?.hosts ?? []).filter((x) => !only || x.route === only || x.host === only);
    const stackKey = (route, s) => `${route}|${s.project ?? '(loose)'}`;
    const svcKey = (route, s, svc) => `${stackKey(route, s)}|${svc.service}`;

    function renderChips() {
      clear(chips);
      const stacks = hostsShown().flatMap((x) => x.stacks ?? []).filter((s) => !s.loose);
      const attention = stacks.filter(needsAttention).length;
      chips.append(chip('All', filter === 'all', () => { filter = 'all'; render(); }, 'every stack'),
        chip(`Needs attention ${attention}`, filter === 'attention', () => { filter = 'attention'; render(); }, 'degraded or down stacks'),
        chip('Containers outside compose', showLoose, () => { showLoose = !showLoose; render(); }, 'containers that belong to no compose project'));
      if (only) chips.append(h('span', { class: 'spacer' }), h('span', { class: 'muted small' }, `only ${only} `), btn('Every machine', () => ctx.nav('stacks'), { cls: 'sm quiet' }));
    }

    function render() {
      if (!alive) return;
      renderChips();
      clear(wrap);
      const shown = hostsShown();
      const all = shown.flatMap((x) => (x.stacks ?? []).filter((s) => !s.loose));
      const failing = all.reduce((n, s) => n + (s.failing?.length ?? 0), 0);
      ctx.setCount('stacks', failing || null);
      meta.textContent = data ? `${plural(shown.length, 'machine')}, ${plural(all.length, 'stack')}, ${plural(shown.reduce((n, x) => n + (x.totals?.containers ?? 0), 0), 'container')}${failing ? `, ${failing} failing` : ''}; read ${fmtTime(data.ts)}${loadingFleet ? ', refreshing' : ''}` : loadingFleet ? 'reading' : '';
      refreshBtn.disabled = loadingFleet;
      if (!data) { wrap.append(err ? empty('Could not read the fleet', err) : loading('Reading docker on every machine')); return; }
      if (err) wrap.append(h('div', { class: 'notice error' }, `Last refresh failed: ${err}. Showing the previous answer.`));
      // Machines that were not asked at all; one that was asked and failed says why in its own section below.
      const asked = new Set((data.hosts ?? []).map((x) => x.host));
      const miss = (data.coverage?.notCovered ?? []).filter((m) => !asked.has(m.host));
      if (miss.length && !only) wrap.append(h('div', { class: 'notice' }, h('b', null, 'Not reached: '), miss.map((m) => m.host).join(', '),
        h('details', null, h('summary', { class: 'small' }, 'why'), ...miss.map((m) => h('div', { class: 'small muted' }, `${m.host}: ${m.reason}`)))));
      if (!shown.length) { wrap.append(empty(only ? `No answer from ${only}` : 'No machines answered', 'Probe the fleet (Fleet view) and refresh.')); return; }
      for (const x of shown) wrap.append(hostSection(x));
    }

    function hostSection(x) {
      const route = x.route ?? x.host;
      if (x.readOnly) readOnly.add(route); else readOnly.delete(route);
      const sec = h('section', { class: 'stk-host' });
      const stacks = (x.stacks ?? []).filter((s) => (showLoose || !s.loose) && (filter === 'all' || needsAttention(s)) && matchQ({ host: x.host, project: s.project, services: s.services?.map((v) => v.service), failing: s.failing, code: s.code?.dir?.path, sources: s.code?.sources?.map((v) => v.toplevel), labels: s.labels }, q));
      const d = x.docker;
      const age = x.cache?.age;
      sec.append(h('div', { class: 'stk-host-head' },
        h('h2', null, h('span', { class: 'mono' }, x.host)),
        h('span', { class: 'muted small' }, !x.ok ? 'no answer' : d?.available === false ? 'docker unavailable' : `docker ${d?.version ?? '?'} · ${plural(x.totals?.stacks ?? 0, 'stack')} · ${plural(x.totals?.containers ?? 0, 'container')}${age > 5000 ? ` · read ${Math.round(age / 1000)} s ago` : ''}`),
        h('span', { class: 'spacer' }),
        refreshing.has(route) ? h('span', { class: 'pending' }, 'reading') : btn('Refresh', () => refreshHost(route), { cls: 'sm quiet', title: `Read docker on ${x.host} again` })));
      if (!x.ok) { sec.append(h('div', { class: 'notice error' }, x.error ?? 'no answer')); return sec; }
      if (d?.available === false) { sec.append(h('div', { class: 'notice' }, `docker: ${d.reason}`)); return sec; }
      if (x.cache?.error) sec.append(h('div', { class: 'notice' }, `Showing the answer from ${Math.round((x.cache.age ?? 0) / 60_000)} min ago; refreshing failed: ${x.cache.error}`));
      for (const n of x.notes ?? []) sec.append(h('div', { class: 'muted small' }, n));
      if (!stacks.length) sec.append(h('div', { class: 'faint small stk-none' }, (x.stacks ?? []).some((s) => !s.loose) ? 'No stack matches.' : 'No compose stacks.'));
      for (const s of stacks) sec.append(stackBlock(route, s));
      return sec;
    }

    function stackBlock(route, s) {
      const key = stackKey(route, s);
      const box = h('div', { class: `stk${needsAttention(s) ? ' attention' : ''}` });
      const kinds = kindsLine(s.kinds);
      box.append(h('div', { class: 'stk-row', tabindex: 0 },
        h('span', { class: 'mark', title: `verdict: ${s.verdict}` }, dot(TONE[s.verdict] ?? ''), h('b', { class: 'mono' }, s.loose ? 'outside compose' : s.project)),
        h('span', { class: 'small' }, countsLine(s.counts)),
        kinds ? h('span', { class: 'muted small' }, kinds) : null,
        s.oneoff?.length ? h('span', { class: 'faint small', title: s.oneoff.map((o) => `${o.name}: ${o.state}`).join('\n') }, plural(s.oneoff.length, 'one-off run')) : null));
      for (const f of s.failing ?? []) {
        const svc = s.services.find((v) => v.service === f.service) ?? { service: f.service, state: f.state, containers: [] };
        box.append(h('div', { class: 'stk-fail' }, h('span', { class: 'mark' }, dot(TONE[f.state] ?? 'error'), h('span', { class: 'mono' }, f.service), ` ${f.state}`), f.detail ? h('span', { class: 'muted small stk-detail', title: f.detail }, f.detail) : null, s.loose ? null : actions(route, s, svc)));
        box.append(...panels(route, s, svc));
      }
      if (!s.loose) box.append(codeBlock(s));
      for (const n of s.notes ?? []) box.append(h('div', { class: 'muted small stk-note' }, n));
      const det = h('details', { open: openSvc.has(key) ? true : null, ontoggle: () => { if (det.open) openSvc.add(key); else openSvc.delete(key); } },
        h('summary', null, plural(s.services?.length ?? 0, 'service')));
      if (openSvc.has(key)) det.append(servicesTable(route, s));
      else det.addEventListener('toggle', () => { if (det.open && !det.querySelector('table')) det.append(servicesTable(route, s)); }, { once: true });
      box.append(det);
      return box;
    }

    function codeBlock(s) {
      const c = s.code;
      const out = h('div', { class: 'stk-code' });
      if (!c) { out.append(h('div', { class: 'faint small' }, `working dir ${s.workingDir ?? 'unknown'} (code line not read)`)); return out; }
      if (c.dir?.git) out.append(gitLine(c.dir.git));
      else if (c.dir) out.append(h('div', { class: 'stk-git small' }, h('span', { class: 'mono', title: c.dir.path }, shortPath(c.dir.path, 60)), h('span', { class: 'faint' }, c.dir.exists ? '  not a git repo' : '  missing')));
      for (const src of c.sources ?? []) out.append(gitLine(src, { label: `bind mounts (${plural(src.services, 'service')}):` }));
      const facts = [];
      const key = c.commitLabel?.key ?? 'commit label';
      if (c.commitLabel) facts.push(c.commitLabel.matches ? `${key} = HEAD` : `${key} ${c.commitLabel.values.filter((v) => !v.matches).map((v) => v.value).join(', ')} ≠ HEAD ${c.commitLabel.head ?? '?'}`);
      if (c.images?.built) facts.push(`${plural(c.images.built, 'built image')}${c.images.stale ? `, ${c.images.stale} older than HEAD${c.images.staleNotMounted.length ? ` (${c.images.staleNotMounted.length} not mounting the source)` : ''}` : ''}`);
      if (c.fromTree) facts.push(`${c.fromTree} of ${c.services} services run the bind-mounted tree`);
      const missing = (s.configFiles ?? []).filter((f) => !f.exists);
      if (s.configFiles?.length) facts.push(missing.length ? `${missing.length} of ${s.configFiles.length} compose files missing` : plural(s.configFiles.length, 'compose file'));
      if (facts.length) out.append(h('div', { class: 'muted small', title: (s.configFiles ?? []).map((f) => `${f.exists ? '' : 'missing: '}${f.path}`).join('\n') }, facts.join(' · ')));
      for (const n of c.notes ?? []) out.append(h('div', { class: `small stk-note${isWarning(n) ? ' warn' : ' muted'}` }, n));
      return out;
    }

    function servicesTable(route, s) {
      const tb = h('tbody');
      for (const v of s.services ?? []) {
        tb.append(h('tr', null,
          h('td', null, h('span', { class: 'mono' }, v.service), v.count > 1 ? h('span', { class: 'faint small' }, ` ×${v.count}`) : null, v.job ? h('span', { class: 'faint small' }, ' job') : null),
          h('td', { class: 'opt' }, h('span', { class: 'muted small' }, s.kinds ? v.kind : '')),
          h('td', null, h('span', { class: 'mark' }, dot(TONE[v.state] ?? ''), v.state === 'up' ? 'up (no check)' : v.state)),
          h('td', { class: 'stk-detail' }, v.detail ? h('span', { class: 'muted small', title: v.detail }, v.detail) : null),
          h('td', { class: 'opt mono small' }, (v.ports ?? []).join(' ')),
          h('td', { class: 'num opt' }, v.containers?.reduce((n, c) => n + (c.restartCount ?? 0), 0) || ''),
          h('td', { class: 'nowrap' }, s.loose ? null : actions(route, s, v))));
        // A failing service's panels sit under its line above the table, so they are not drawn twice.
        if (!s.loose && !s.failing?.some((f) => f.service === v.service)) for (const p of panels(route, s, v)) tb.append(h('tr', null, h('td', { colspan: 7 }, p)));
      }
      return h('table', { class: 'tbl small stk-svcs' }, h('thead', null, h('tr', null, h('th', null, 'Service'), h('th', { class: 'opt' }, 'Kind'), h('th', null, 'State'), h('th', null, 'Why'), h('th', { class: 'opt' }, 'Ports'), h('th', { class: 'num opt', title: 'restarts' }, 'Restarts'), h('th', null, ''))), tb);
    }

    /** The buttons for one service: Logs, then the verbs its state allows, each confirmed by a second click. */
    function actions(route, s, v) {
      if (readOnly.has(route)) return null;
      const k = svcKey(route, s, v);
      const files = (s.configFiles ?? []).length && (s.configFiles ?? []).every((f) => f.exists);
      const stop = (fn) => (e) => { e.stopPropagation(); fn(); };
      return h('span', { class: 'stk-actions' },
        btn(logs.has(k) ? 'Hide logs' : 'Logs', stop(() => toggleLogs(route, s, v)), { cls: 'sm quiet' }),
        verb(route, s, v, 'restart', 'Restart', `docker restart ${v.service} on ${route}`),
        STARTABLE.has(v.state) ? verb(route, s, v, 'start', 'Start', `docker start ${v.service} (runs its command again)`) : null,
        RUNNING.has(v.state) ? btn(shells.get(k)?.mode === 'exec' ? 'Close' : 'Exec', stop(() => toggleShell(k, 'exec')), { cls: 'sm quiet', title: `run a command in ${v.service}` }) : null,
        (v.job || v.state === 'completed') && files ? btn(shells.get(k)?.mode === 'run' ? 'Close' : 'Run', stop(() => toggleShell(k, 'run')), { cls: 'sm quiet', title: `docker compose run --rm ${v.service} (a one-off job)` }) : null);
    }

    /** True while an action's first click waits for its second. */
    const isArmed = (k) => (confirm.get(k)?.until ?? 0) > Date.now();
    /** The first click: arm the action; it disarms itself (and redraws) after CONFIRM_MS. */
    function arm(k) {
      clearTimeout(confirm.get(k)?.timer);
      confirm.set(k, { until: Date.now() + CONFIRM_MS, timer: setTimeout(() => { confirm.delete(k); if (alive) render(); }, CONFIRM_MS) });
      render();
    }
    /** The second click: disarm, before the caller carries the action out. */
    function disarm(k) { clearTimeout(confirm.get(k)?.timer); confirm.delete(k); }

    /** A lifecycle verb button with the two-click confirm. */
    function verb(route, s, v, name, label, title) {
      const k = `${svcKey(route, s, v)}|${name}`;
      if (busy.has(k)) return h('span', { class: 'pending' }, name === 'start' ? 'starting' : 'restarting');
      const armed = isArmed(k);
      return btn(armed ? `Confirm ${name}` : label, (e) => {
        e.stopPropagation();
        if (!armed) { arm(k); return; }
        disarm(k);
        act(route, s.project, name, { services: [v.service] }, k);
      }, { cls: `sm${armed ? ' danger' : ' quiet'}`, title: armed ? 'Click again to confirm' : title });
    }

    function panels(route, s, v) {
      if (readOnly.has(route)) return [];
      const k = svcKey(route, s, v);
      const out = [];
      const lg = logs.get(k);
      if (lg) {
        const tailSel = h('select', { 'aria-label': 'Lines', onchange: () => { lg.tail = Number(tailSel.value); loadLogs(route, s, v); } }, ...[100, 200, 500, 2000].map((n) => h('option', { value: n, selected: n === lg.tail ? true : null }, `last ${n}`)));
        out.push(h('div', { class: 'stk-panel' },
          h('div', { class: 'toolbar' }, h('span', { class: 'small' }, `logs of ${lg.data?.container ?? v.service}`), tailSel, btn('Reload', () => loadLogs(route, s, v), { cls: 'sm quiet' }), lg.data ? h('span', { class: 'faint small' }, `${plural(lg.data.lines, 'line')}${lg.data.stderrLines ? `, ${lg.data.stderrLines} on stderr` : ''}${lg.data.truncated ? ', cut' : ''}`) : null),
          lg.loading ? loading('Reading logs') : lg.error ? h('div', { class: 'notice error' }, lg.error) : h('pre', { class: 'screen' }, lg.data?.text || '(no output)')));
      }
      const sh = shells.get(k);
      if (sh) out.push(shellPanel(route, s, v, k, sh));
      return out;
    }

    function shellPanel(route, s, v, k, sh) {
      let argv = null, parseErr = null;
      try { argv = splitArgv(sh.line); } catch (e) { parseErr = e.message; }
      const preview = h('span', { class: 'faint small mono' });
      const setPreview = () => { try { argv = splitArgv(sh.line); parseErr = null; preview.textContent = argv.length ? `argv ${JSON.stringify(argv)}` : sh.mode === 'run' ? 'empty: the service\'s own command' : ''; } catch (e) { argv = null; parseErr = e.message; preview.textContent = e.message; } };
      const input = h('input', { type: 'text', class: 'mono stk-cmd', value: sh.line, placeholder: sh.mode === 'exec' ? 'command, e.g. node -v   (split into words like a shell; nothing is expanded)' : 'optional: replace the service\'s command', 'aria-label': 'Command',
        disabled: sh.running ? true : null, oninput: () => { sh.line = input.value; setPreview(); }, onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } } });
      const ck = `${k}|${sh.mode}`;
      const armed = isArmed(ck);
      const go = () => {
        if (sh.running) return;   // one request at a time: Enter while it runs must not send another
        setPreview();
        if (parseErr || (sh.mode === 'exec' && !argv?.length)) { ctx.toast(parseErr ?? 'type a command first', 'info'); return; }
        if (!isArmed(ck)) { arm(ck); return; }
        disarm(ck);
        runShell(route, s, v, sh, argv);
      };
      setPreview();
      const res = sh.result;
      return h('div', { class: 'stk-panel' },
        h('div', { class: 'toolbar' }, h('span', { class: 'small' }, sh.mode === 'exec' ? `exec in ${v.service}` : `compose run --rm ${v.service}`), input,
          sh.running ? h('span', { class: 'pending' }, 'running') : btn(armed ? 'Confirm' : sh.mode === 'exec' ? 'Exec' : 'Run', go, { cls: `sm${armed ? ' danger' : ' primary'}`, title: armed ? 'Click again to run it' : 'runs after a second click' })),
        preview,
        sh.error ? h('div', { class: 'notice error' }, sh.error) : null,
        res ? h('div', null,
          h('div', { class: 'small' }, h('span', { class: 'mark' }, dot(res.ok ? 'ok' : 'error'), res.timedOut ? 'timed out' : `exit ${res.exitCode}`), h('span', { class: 'faint' }, `  ${res.ms} ms${res.truncated ? ', output cut' : ''}`), res.note ? h('span', { class: 'muted' }, `  ${res.note}`) : null),
          res.stdout ? h('pre', { class: 'screen' }, res.stdout) : null,
          res.stderr ? h('pre', { class: 'screen stk-stderr' }, res.stderr) : null) : null);
    }

    function toggleShell(k, mode) {
      const cur = shells.get(k);
      if (cur?.mode === mode) shells.delete(k); else shells.set(k, { mode, line: '', result: null, running: false, error: null });
      render();
    }
    async function runShell(route, s, v, sh, argv) {
      if (sh.running) return;
      sh.running = true; sh.error = null; render();
      try {
        sh.result = await ctx.callQuiet(`docker.${sh.mode}`, { project: s.project, service: v.service, ...(argv.length ? { argv } : {}) }, { host: route });
        if (sh.mode === 'run') refreshHost(route);
      } catch (e) { sh.error = e.message; }
      finally { sh.running = false; if (alive) render(); }
    }

    async function toggleLogs(route, s, v) {
      const k = svcKey(route, s, v);
      if (logs.has(k)) { logs.delete(k); render(); return; }
      logs.set(k, { loading: true, tail: 200 });
      await loadLogs(route, s, v);
    }
    async function loadLogs(route, s, v) {
      const k = svcKey(route, s, v); const lg = logs.get(k); if (!lg) return;
      lg.loading = true; lg.error = null; render();
      try { lg.data = await ctx.callQuiet('docker.logs', { project: s.project, service: v.service, tail: lg.tail }, { host: route }); }
      catch (e) { lg.error = e.message; }
      finally { lg.loading = false; if (alive) render(); }
    }

    async function act(route, project, name, args, k) {
      busy.add(k); render();
      try {
        const r = await ctx.call(`docker.${name}`, { project, ...args }, { host: route });
        const moved = (r.containers ?? []).map((c) => `${c.service ?? c.name} ${c.before} → ${c.after}`).join(', ');
        ctx.toast(`${project} on ${route}: ${name} ${r.ok ? 'done' : `exited ${r.exitCode}`}${moved ? ` (${moved})` : ''}`, r.ok ? 'ok' : 'error');
      } catch { /* toasted by ctx.call */ }
      finally { busy.delete(k); await refreshHost(route); }
    }

    /**
     * Re-read one machine (fresh) and put its answer in place, through the fleet op with that one host: it shares the
     * per-host cache entry, and reads a host a plugin provides that runs no Drover through that plugin.
     */
    async function refreshHost(route) {
      if (refreshing.has(route)) return;
      refreshing.add(route); render();
      try {
        const r = await ctx.callQuiet('docker.fleet', { hosts: [route], fresh: true, services: true }, LOCAL);
        const i = data?.hosts?.findIndex((x) => (x.route ?? x.host) === route) ?? -1;
        if (alive && i >= 0 && r?.hosts?.[0]) data.hosts[i] = r.hosts[0];
      } catch (e) { if (alive) ctx.toast(`docker.stacks on ${route}: ${e.message}`, 'error'); }
      finally { refreshing.delete(route); if (alive) render(); }
    }

    async function load({ fresh = false } = {}) {
      if (loadingFleet) return;
      loadingFleet = true; render();
      try {
        // One machine (#/stacks/<host>) is asked by name: the fleet asks a host a plugin provides only when it is named.
        const args = { services: true, ...(only ? { hosts: [only] } : {}) };
        if (fresh) data = await ctx.callQuiet('docker.fleet', { ...args, fresh: true }, LOCAL);
        else await ctx.swr('docker.fleet', args, (r) => { if (alive) { data = r; render(); } }, LOCAL);
        err = null;
      } catch (e) { err = e.message; }
      finally { loadingFleet = false; if (alive) render(); }
    }

    load();
    const timer = setInterval(() => { if (!document.hidden && !busy.size) load(); }, 60_000);
    return {
      destroy() { alive = false; clearInterval(timer); for (const p of confirm.values()) clearTimeout(p.timer); },
      search(qq) { q = qq; render(); },
      params(p) { const next = p?.[0] ?? null; if (next !== only) { only = next; load(); } },
      key(e) {
        const rows = [...root.querySelectorAll('.stk-row')]; if (!rows.length) return;
        const idx = rows.findIndex((r) => r === document.activeElement);
        if (e.key === 'j' || e.key === 'k') { e.preventDefault(); rows[Math.max(0, Math.min(rows.length - 1, idx + (e.key === 'j' ? 1 : -1)))]?.focus(); }
      },
    };
  },
};
