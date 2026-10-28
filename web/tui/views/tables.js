// The web UI's other views as tables (views/table.js): Sessions and Tmux per host, Events, Features, Fleet,
// Search, Memory (reflections), Stacks, Launch profiles (read-only), Settings (read-only); a plugin adds its own
// (core/plugins.js tui). Each reads the same op the web view reads; Enter on a session or window opens it.
import { kvRows, ago, tilde } from '../ui.js';
import { renderMarkdown } from '../markdown.js';
import { wrap, oneLine, truncate, sanitize } from '../width.js';
import { clock } from '../chat.js';

export const h = (host) => (host && host !== 'local' ? { host } : {});
export const ms = (v) => (v == null ? 0 : typeof v === 'number' ? (v < 1e11 ? v * 1000 : v) : Date.parse(v) || 0);
export const title = (t, extra) => [[` ${oneLine(t)}`, 'bold'], ...(extra ? [[`  ${extra}`, 'dim']] : [])];
export const para = (text, width, n = 40) => renderMarkdown(truncate(sanitize(text ?? ''), 6000), width - 2, { indent: ' ' }).slice(0, n);
export const json = (v, width, n = 60) => JSON.stringify(v, null, 2).split('\n').flatMap((l) => wrap(l, width - 2, { words: false })).slice(0, n).map((l) => [[' ', null], [l, 'dim']]);
export const kv = (pairs, width) => kvRows(pairs, width - 1).map((r) => [[' ', null], ...r]);
export const stateStyle = (s) => (s === 'busy' || s === 'working' ? 'work' : s === 'dialog' || s === 'waiting' ? 'wait' : s === 'dead' || s === 'error' ? 'err' : s === 'idle' || s === 'ready' ? 'idle' : 'dim');

/** One-line summary of a truth-file event (as the web UI's Events view words it). */
export function summarizeEvent(e) {
  let s;
  switch (e.type) {
    case 'feature': s = [e.fid, e.state, e.title].filter(Boolean).join(' / '); break;
    case 'note': s = `${e.about}: ${e.text ?? ''}`; break;
    case 'status': s = `${e.name ?? e.agent} ${e.state}${e.summary ? `: ${e.summary}` : ''}`; break;
    case 'pin': case 'unpin': s = String(e.target ?? ''); break;
    case 'message': { const to = e.to ?? {}; const d = e.delivery ? (e.delivery.ok ? '' : ` (failed: ${e.delivery.error ?? 'unknown'})`) : ''; s = `to ${to.name ?? to.id ?? to.kind ?? ''}${e.thread ? ` [${e.thread}]` : ''}${d}: ${e.text ?? ''}`; break; }
    case 'chat': s = `${e.from ?? e.actor ?? ''}${e.thread ? ` [${e.thread}]` : ''}${e.error ? ` did not answer: ${e.error}` : `: ${e.text ?? ''}`}`; break;
    case 'launch': s = `${e.engine} ${e.mode} ${e.profile ?? ''}${e.model ? ` ${e.model}` : ''} in ${tilde(e.cwd ?? '')} -> ${e.result?.tmux ?? e.result?.headlessId ?? ''}`; break;
    case 'op': s = `${e.op}${e.target && e.target !== 'local' ? ` on ${e.target}` : ''}${e.ok === false ? ` failed: ${e.error ?? ''}` : ''}`; break;
    case 'notify': s = `${e.category ?? ''} ${e.title ?? ''}${e.message ? `: ${e.message}` : ''}`; break;
    case 'survey': s = `${e.count} items from ${e.file}`; break;
    case 'handoff': s = `${tilde(e.path)} ${e.sha256?.slice(0, 12) ?? ''}`; break;
    default: s = JSON.stringify({ ...e, id: undefined, ts: undefined, host: undefined, actor: undefined, type: undefined });
  }
  return oneLine(s);
}

function sessionTarget(s, host) { return { kind: 'session', id: s.id, host, engine: s.kind === 'headless' ? 'headless' : s.engine, name: s.name ?? s.preview ?? String(s.id).slice(0, 8), tmux: s.tmux, sessionId: s.sessionId }; }
const nameOf = (s) => s.name ?? (s.preview ? String(s.preview).slice(0, 80) : s.slug ? s.slug.replace(/^-/, '').split('-').filter(Boolean).slice(-2).join('/') : String(s.id).slice(0, 8));
const updatedOf = (s) => s.statusUpdatedAt ?? s.updatedAt ?? s.mtime ?? s.startedAt ?? s.createdAt ?? null;

// A plugin's tables (core/plugins.js tui.tables) join in tui/app.js, each after the table its `after` names.
export const TABLES = [
  {
    id: 'sessions', title: 'Sessions', perHost: true, state: { all: false },
    load: (app, v) => app.client.call('sessions.list', { ...h(v.host), ...(v.state.all ? {} : { includeRecent: false }) }),
    rows: (d, v) => (d?.sessions ?? []).filter((s) => v.state.all || s.live).sort((a, b) => Number(Boolean(b.live)) - Number(Boolean(a.live)) || Number(b.status === 'busy') - Number(a.status === 'busy') || ms(updatedOf(b)) - ms(updatedOf(a))),
    meta: (d, v) => `${v.visible().length} ${v.state.all ? 'sessions, live and recent' : 'live sessions'}${d?.codexError ? ` · codex: ${d.codexError}` : ''}`,
    columns: [
      { title: 'engine', w: 8, get: (s) => [s.kind === 'headless' ? 'headless' : s.engine, 'dim'] },
      { title: 'name', flex: 2, get: (s) => nameOf(s) },
      { title: 'state', w: 9, get: (s) => [s.live ? s.status : 'on disk', s.live ? stateStyle(s.status) : 'dim'] },
      { title: 'directory', flex: 1, get: (s) => [tilde(s.cwd), 'dim'] },
      { title: 'tmux', w: 14, get: (s) => [s.tmux ?? '', 'dim'] },
      { title: 'updated', w: 7, align: 'right', get: (s) => [ago(updatedOf(s)), 'dim'] },
    ],
    detail: (s, w) => [title(nameOf(s), `${s.engine ?? s.kind}${s.model ? ` · ${s.model}` : ''}`), [], ...kv([['status', s.status], ['live', s.live ? 'yes' : 'no'], ['session id', s.sessionId ?? s.threadId ?? s.id], ['tmux', s.tmux], ['cwd', tilde(s.cwd)], ['pid', s.pid], ['started', s.startedAt ? new Date(ms(s.startedAt)).toLocaleString() : null], ['version', s.version], ['entrypoint', s.entrypoint], ['kind', s.sessionKind ?? s.kind], ['transcript', tilde(s.transcript)]], w), ...(s.preview ? [[], ...para(s.preview, w, 8)] : [])],
    enter: (s, app, v) => app.openSession(sessionTarget(s, v.host)), enterHint: 'open',
    keys: { a: (_, app, v) => { v.state.all = !v.state.all; v.refresh(); } }, hintKeys: [['a', 'live/all']],
    text: (s) => [nameOf(s), s.engine, s.status, s.cwd, s.tmux, s.id, s.model].join(' '),
  },
  {
    id: 'tmux', title: 'Tmux', perHost: true, state: { agents: false },
    load: (app, v) => app.client.call('tmux.windows', { classify: true, ...h(v.host) }),
    rows: (d, v) => (Array.isArray(d) ? d : []).filter((w) => !v.state.agents || w.agent),
    meta: (d, v) => `${v.visible().length} windows, ${(Array.isArray(d) ? d : []).filter((w) => w.agent).length} with agents${v.state.agents ? ' (agents only)' : ''}`,
    columns: [
      { title: 'target', w: 16, get: (w) => [w.target, 'accent'] },
      { title: 'window', flex: 1, get: (w) => w.name },
      { title: 'agent', flex: 1, get: (w) => [w.agent ? `${w.agent.engine}${w.agent.name ? ` ${w.agent.name}` : ''}` : w.cmd, w.agent ? null : 'dim'] },
      { title: 'state', w: 8, get: (w) => [w.screen?.state ?? w.agent?.status ?? '', stateStyle(w.screen?.state ?? w.agent?.status)] },
      { title: 'cwd', flex: 1, get: (w) => [tilde(w.cwd), 'dim'] },
      { title: 'active', w: 6, align: 'right', get: (w) => [ago(w.activityTs), 'dim'] },
    ],
    detail: (w, width) => [title(w.target, w.name), [], ...kv([['agent', w.agent ? `${w.agent.engine} ${w.agent.name ?? ''} ${w.agent.status ?? ''}` : null], ['session id', w.agent?.sessionId], ['screen', w.screen ? `${w.screen.state}: ${w.screen.reason ?? ''}` : null], ['dialog', w.dialog?.question], ['command', w.cmd], ['panes', w.panes], ['pane', w.paneId], ['cwd', tilde(w.cwd)], ['attached', w.sessionAttached ? 'yes' : 'no']], width), ...((w.tail ?? []).length ? [[], [[' last lines', 'dim']], ...w.tail.map((l) => [['   ', null], [oneLine(l), 'dim']])] : [])],
    enter: (w, app, v) => app.openSession({ kind: 'window', id: w.target, host: v.host, name: w.agent?.name ?? w.name, engine: w.agent?.engine, sessionId: w.agent?.sessionId, tmux: w.target, tab: w.agent?.sessionId ? 'chat' : 'screen' }), enterHint: 'open',
    keys: { a: (_, app, v) => { v.state.agents = !v.state.agents; v.rederive(); } }, hintKeys: [['a', 'agents only']],
    text: (w) => [w.target, w.name, w.cmd, w.cwd, w.agent?.name, w.agent?.engine, w.screen?.state].join(' '),
  },
  {
    id: 'events', title: 'Events', ttl: 10_000,
    load: (app) => app.client.call('events.tail', { limit: 400 }),
    rows: (d) => (Array.isArray(d) ? d : []).slice().reverse(),
    meta: (d, v) => `${v.visible().length} events, newest first`,
    columns: [
      { title: 'when', w: 12, get: (e) => [clock(e.ts), 'dim'] },
      { title: 'type', w: 9, get: (e) => [e.type, 'accent'] },
      { title: 'actor', w: 12, get: (e) => [e.actor ?? '', 'dim'] },
      { title: 'what', flex: 1, get: (e) => summarizeEvent(e) },
    ],
    detail: (e, w) => [title(`${e.type} ${e.id ?? ''}`, `${e.actor ?? ''} on ${e.host ?? ''}`), [], ...json(e, w, 80)],
    onEvent: (type, _d, v) => { if (type === 'mutation' && v.data) { clearTimeout(v.reloadTimer); v.reloadTimer = setTimeout(() => v.load(), 1200); } return false; },
    text: (e) => `${e.type} ${e.actor} ${summarizeEvent(e)}`,
  },
  {
    id: 'features', title: 'Features', ttl: 60_000,
    load: (app) => app.client.call('events.state', {}, { timeoutMs: 60_000 }),
    rows: (d) => { const order = { 'in-progress': 0, 'not-started': 1, shipped: 2, abandoned: 3 }; const pins = new Set(d?.pins ?? []); return (d?.features ?? []).slice().sort((a, b) => (order[a.state] ?? 4) - (order[b.state] ?? 4) || Number(pins.has(b.fid)) - Number(pins.has(a.fid)) || ms(b.updated) - ms(a.updated)); },
    meta: (d, v) => `${v.visible().length} features, ${(d?.features ?? []).filter((f) => f.state === 'in-progress').length} in progress`,
    columns: [
      { title: 'state', w: 12, get: (f) => [f.state, f.state === 'in-progress' ? 'work' : f.state === 'shipped' ? 'idle' : 'dim'] },
      { title: 'title', flex: 3, get: (f) => f.title || '(untitled)' },
      { title: 'repo', w: 10, get: (f) => [f.repo ?? '', 'dim'] },
      { title: 'updated', w: 7, align: 'right', get: (f) => [ago(f.updated), 'dim'] },
    ],
    detail: (f, w, v) => {
      const notes = v.data?.notes?.[f.fid] ?? [];
      return [title(f.title || '(untitled)'), [[` ${f.fid}`, 'dim']], [], ...kv([['state', f.state], ['repo', f.repo], ['pinned', v.data?.pins?.includes(f.fid) ? 'yes' : null], ['created', f.created ? new Date(f.created).toLocaleString() : null], ['updated', f.updated ? new Date(f.updated).toLocaleString() : null]], w),
        ...(f.links?.length ? [[], [[' links', 'dim']], ...f.links.map((l) => [['   ', null], [l, 'link']])] : []),
        ...(f.notes ? [[], ...para(f.notes, w, 20)] : []),
        ...(notes.length ? [[], [[` notes (${notes.length})`, 'dim']], ...notes.slice(-12).reverse().flatMap((n) => [[[`   ${clock(n.ts)} ${n.actor ?? ''}`, 'dim']], ...wrap(oneLine(n.text), w - 6).slice(0, 3).map((l) => [['     ', null], [l, null]])])] : [])];
    },
    text: (f) => [f.fid, f.title, f.repo, f.state, f.notes, ...(f.links ?? [])].join(' '),
  },
  {
    id: 'fleet', title: 'Fleet', ttl: 60_000,
    load: (app) => app.client.call('host.list', {}),
    rows: (d) => (Array.isArray(d) ? d : []),
    meta: (d, v) => { const b = v.app.board.hosts ?? []; return `${(d ?? []).length} hosts known, ${b.filter((x) => x.up !== false).length} reachable on the board`; },
    columns: [
      { title: 'host', w: 18, get: (x, v) => [x.name === 'local' ? `${v.app.frontHost ?? x.display} (here)` : x.name, 'accent'] },
      { title: 'source', w: 10, get: (x) => [x.source, 'dim'] },
      { title: 'board', w: 6, get: (x, v) => { const b = boardHost(x, v); return b ? [b.up === false ? 'down' : 'up', b.up === false ? 'err' : 'idle'] : ['', 'dim']; } },
      { title: 'wait', w: 4, align: 'right', get: (x, v) => { const n = boardHost(x, v)?.waiting; return [n ?? '', n ? 'waitBold' : 'dim']; } },
      { title: 'work', w: 4, align: 'right', get: (x, v) => boardHost(x, v)?.working ?? '' },
      { title: 'idle', w: 4, align: 'right', get: (x, v) => boardHost(x, v)?.idle ?? '' },
      { title: 'note', flex: 1, get: (x, v) => { const b = boardHost(x, v); return [b?.error ?? (b?.stale ? 'last inventory' : ''), 'err']; } },
    ],
    detail: (x, w, v) => {
      const f = v.lazy(`facts|${x.name}`, () => v.app.client.call('host.facts', h(x.name), { timeoutMs: 30_000 }));
      const out = [title(x.name === 'local' ? `${v.app.frontHost ?? x.display} (this machine)` : x.name, x.source), []];
      if (f.loading) out.push([[' collecting facts…', 'dim']]);
      else if (f.error) out.push([[` ${f.error}`, 'err']]);
      else { const d = f.value ?? {}; const disk = (z) => (z ? `${z.pct} used, ${z.avail} free of ${z.size}` : null); out.push(...kv([['host', d.host], ['uptime', d.uptime], ['disk /', disk(d.disk?.root)], ['disk nvme', disk(d.disk?.nvme)], ['docker', d.docker ? `${d.docker.total} containers, ${d.docker.unhealthy} unhealthy` : d.dockerUnavailable ?? null], ['tmux windows', d.tmuxWindows], ['node', d.node], ['identity', d.identity ? Object.entries(d.identity).map(([k, val]) => `${k}=${val}`).join(' ') : null]], w)); }
      return out;
    },
    keys: { p: (x, app, v) => { if (!x || x.name === 'local') return; app.toast(`probing ${x.name}…`); app.client.call('host.probe', { hosts: [x.name] }, { timeoutMs: 60_000 }).then((r) => { const p = r?.[0]; app.toast(p?.up ? `${x.name}: up, ${p.ms} ms` : `${x.name}: ${p?.error ?? 'down'}`, p?.up ? 'ok' : 'err'); }, (e) => app.toast(`probe: ${e.message}`, 'err')); v.cache.delete(`facts|${x.name}`); } },
    hintKeys: [['p', 'probe']],
    text: (x) => [x.name, x.display, x.source].join(' '),
  },
  {
    id: 'search', title: 'Search', query: true, ttl: Infinity,
    load: (app, v) => app.client.call('search.fleet', { query: v.query.trim(), limit: 40 }, { timeoutMs: 90_000 }),
    rows: (d) => d?.results ?? [],
    meta: (d, v) => (v.query ? `${(d?.results ?? []).length} hits for "${v.query}"${d?.coverage?.notCovered?.length ? ` · not searched: ${d.coverage.notCovered.map((x) => x.host).join(', ')}` : ''}${d?.ms ? ` · ${(d.ms / 1000).toFixed(1)} s` : ''}` : 'every session on every machine, by meaning and exact words'),
    columns: [
      { title: 'kind', w: 9, get: (r) => [r.kind, 'dim'] },
      { title: 'host', w: 12, get: (r) => [r.host ?? '', 'dim'] },
      { title: 'project', w: 12, get: (r) => [r.project ?? '', 'dim'] },
      { title: 'when', w: 6, align: 'right', get: (r) => [ago(r.ts), 'dim'] },
      { title: 'what', flex: 1, get: (r) => `${r.title ? `${oneLine(r.title)}: ` : ''}${oneLine(r.snippet ?? '')}` },
    ],
    detail: (r, w) => [title(r.title ?? r.kind, `${r.kind} · ${r.role ?? ''} · ${r.host ?? ''}`), [], ...kv([['when', r.ts ? new Date(r.ts).toLocaleString() : null], ['session', r.sessionId], ['project', r.project], ['cwd', tilde(r.cwd)], ['score', r.score != null ? Number(r.score).toFixed(4) : null], ['path', tilde(r.path)]], w), [], ...wrap(oneLine(r.snippet ?? ''), w - 2).map((l) => [[' ', null], [l, null]])],
    enter: (r, app) => { if (!r.sessionId) { app.toast('this hit has no session to open'); return; } app.openSession({ kind: 'session', id: r.sessionId, host: r.host && r.host !== app.frontHost ? r.host : 'local', name: r.title ?? r.sessionId.slice(0, 8), engine: r.kind === 'codex' ? 'codex' : 'claude' }); }, enterHint: 'open the session',
  },
  {
    id: 'memory', title: 'Memory', state: { all: false, status: 'open' },
    load: async (app, v) => {
      const args = { limit: 120, status: v.state.status, ...(v.state.all ? { all: true } : {}) };
      try { return await app.client.call('reflections.list', args, { timeoutMs: 60_000 }); } catch (e) {
        // A daemon with no default repo (DROVER_DEFAULT_REPO unset) refuses a list that names none: show every repo.
        if (v.state.all || !/repo is required/.test(e?.message ?? '')) throw e;
        v.state.all = true;
        return app.client.call('reflections.list', { ...args, all: true }, { timeoutMs: 60_000 });
      }
    },
    rows: (d) => (d?.items ?? []).slice().sort((a, b) => (a.priority ?? 5) - (b.priority ?? 5) || ms(b.updated_at) - ms(a.updated_at)),
    meta: (d, v) => `${v.visible().length} ${v.state.status} reflections ${v.state.all ? 'in every repo' : `in ${d?.items?.find((r) => r.repo)?.repo ?? 'the default repo'}`}`,
    columns: [
      { title: 'kind', w: 9, get: (r) => [r.kind, 'accent'] },
      { title: 'status', w: 7, get: (r) => [r.status, r.status === 'open' ? 'wait' : 'dim'] },
      { title: 'repo', w: 10, get: (r) => [r.repo ?? '', 'dim'] },
      { title: 'title', flex: 1, get: (r) => r.title },
      { title: 'updated', w: 7, align: 'right', get: (r) => [ago(r.updated_at ?? r.created_at), 'dim'] },
    ],
    detail: (r, w) => [title(r.title, `${r.kind} · ${r.status} · ${r.repo ?? ''}`), [[` #${r.id}${r.priority ? `  priority ${r.priority}` : ''}`, 'dim']], [], ...para(r.body, w, 30), [], ...kv([['tags', (r.tags ?? []).join(', ')], ['session', r.session_id], ['host', r.host], ['branch', r.branch], ['origin', r.origin], ['notes', r.notes]], w)],
    keys: { a: (_, app, v) => { v.state.all = !v.state.all; v.refresh(); }, s: (_, app, v) => { const all = ['open', 'stale', 'done', 'all']; v.state.status = all[(all.indexOf(v.state.status) + 1) % all.length]; v.refresh(); } },
    hintKeys: [['a', 'all repos'], ['s', 'status']],
    text: (r) => [r.id, r.kind, r.status, r.repo, r.title, r.body, ...(r.tags ?? [])].join(' '),
  },
  {
    id: 'stacks', title: 'Stacks', ttl: 60_000,
    load: (app) => app.client.call('docker.fleet', {}, { timeoutMs: 90_000 }),
    rows: (d) => (d?.hosts ?? []).flatMap((hs) => (hs.stacks?.length ? hs.stacks.map((s) => ({ ...s, host: hs.host })) : [{ host: hs.host, project: hs.docker?.available === false ? `(no docker: ${hs.docker.reason ?? ''})` : '(no stacks)', verdict: 'empty', counts: {}, none: true }])),
    meta: (d) => (d ? `${d.totals?.stacks ?? 0} stacks, ${d.totals?.containers ?? 0} containers, ${d.totals?.failing ?? 0} failing${d.coverage?.notCovered?.length ? ` · not read: ${d.coverage.notCovered.map((x) => x.host).join(', ')}` : ''}` : ''),
    columns: [
      { title: 'host', w: 14, get: (s) => [s.host, 'dim'] },
      { title: 'project', flex: 1, get: (s) => [s.project, s.none ? 'dim' : 'accent'] },
      { title: 'verdict', w: 9, get: (s) => [s.verdict, { ok: 'idle', degraded: 'wait', down: 'err', starting: 'work' }[s.verdict] ?? 'dim'] },
      { title: 'healthy', w: 8, align: 'right', get: (s) => (s.none ? '' : `${(s.counts?.healthy ?? 0) + (s.counts?.up ?? 0)}/${s.counts?.total ?? 0}`) },
      { title: 'failing', w: 8, align: 'right', get: (s) => [s.failing?.length || '', s.failing?.length ? 'err' : 'dim'] },
      { title: 'code', flex: 1, get: (s) => [s.code?.git ? `${s.code.git.branch ?? s.code.git.short ?? ''}` : tilde(s.workingDir ?? ''), 'dim'] },
    ],
    detail: (s, w) => (s.none ? [title(s.host), [], [[` ${s.project}`, 'dim']]] : [title(s.project, `${s.host} · ${s.verdict}`), [], ...kv([['working dir', tilde(s.workingDir)], ['services', s.serviceCount], ['counts', Object.entries(s.counts ?? {}).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ')], ['compose', (s.configFiles ?? []).map((f) => tilde(f.path)).join(', ')], ['code', s.code?.git ? `${s.code.git.branch ?? 'detached'} @ ${s.code.git.short ?? ''} ${s.code.git.subject ?? ''}` : null]], w), ...(s.failing?.length ? [[], [[' failing', 'err']], ...s.failing.flatMap((f) => [[['   ', null], [f.service, 'errBold'], [`  ${f.state}`, 'err']], ...wrap(oneLine(f.detail ?? ''), w - 6).slice(0, 2).map((l) => [['     ', null], [l, 'dim']])])] : []), ...((s.notes ?? []).length ? [[], ...s.notes.map((n) => [[' ', null], [oneLine(typeof n === 'string' ? n : JSON.stringify(n)), 'dim']])] : [])]),
    text: (s) => [s.host, s.project, s.verdict, s.workingDir, ...(s.failing ?? []).map((f) => f.service)].join(' '),
  },
  {
    id: 'launch', title: 'Launch', ttl: 300_000,
    load: (app) => app.client.call('launch.profiles', {}),
    rows: (d) => [
      ...['claude', 'codex', 'hermes'].flatMap((engine) => (d?.[engine]?.profiles ?? []).map((p) => ({ kind: 'profile', engine, ...p }))),
      ...['claude', 'codex', 'hermes'].flatMap((engine) => (d?.[engine]?.models ?? []).map((m) => ({ kind: 'model', engine, ...m }))),
      ...(d?.credentials?.pool ?? []).map((c) => ({ kind: 'credential', engine: (d.credentials.appliesTo ?? []).join(','), ...c })),
    ],
    meta: () => 'launch profiles, models and the credential pool (read-only: launch from the web UI or drover_launch)',
    columns: [
      { title: 'kind', w: 10, get: (r) => [r.kind, 'dim'] },
      { title: 'engine', w: 7, get: (r) => [r.engine, 'dim'] },
      { title: 'id', w: 22, get: (r) => [`${r.id}${r.default ? ' *' : ''}`, 'accent'] },
      { title: 'label', flex: 1, get: (r) => r.label ?? '' },
      { title: 'argv', flex: 1, get: (r) => [(r.argv ?? []).join(' '), 'dim'] },
    ],
    detail: (r, w) => [title(r.id, `${r.kind} · ${r.engine}${r.default ? ' · default' : ''}`), [], ...kv([['label', r.label], ['argv', (r.argv ?? []).join(' ')], ['env', r.env && Object.keys(r.env).length ? Object.keys(r.env).join(', ') : null], ['requires', r.requires], ['weight', r.weight], ['max concurrent', r.maxConcurrent]], w)],
    text: (r) => [r.kind, r.engine, r.id, r.label, ...(r.argv ?? [])].join(' '),
  },
  {
    id: 'settings', title: 'Settings', ttl: 60_000,
    load: (app) => app.client.call('settings.get', {}),
    rows: (d) => [...flatten(d?.settings ?? {}).map(([k, val]) => ({ key: k, value: val })), ...(d?.activeMutes ?? []).map((m) => ({ key: `active mute ${m.scope} ${m.target}`, value: m.until ? `until ${new Date(m.until).toLocaleString()}` : 'until unmuted', mute: m }))],
    meta: (d) => (d ? `settings, read-only here (change them in the web UI or with settings.set) · updated ${d.updated ? new Date(d.updated).toLocaleString() : 'never'}${d.by ? ` by ${d.by}` : ''}` : ''),
    columns: [{ title: 'setting', flex: 1, get: (r) => [r.key, r.mute ? 'wait' : 'accent'] }, { title: 'value', flex: 1, get: (r) => (typeof r.value === 'object' ? JSON.stringify(r.value) : String(r.value)) }],
    detail: (r, w) => [title(r.key), [], ...json(r.mute ?? r.value, w)],
    text: (r) => `${r.key} ${JSON.stringify(r.value)}`,
  },
];

function boardHost(x, v) { const hosts = v.app.board.hosts ?? []; return hosts.find((b) => b.name === x.name) ?? null; }
function flatten(o, pre = '') {
  const out = [];
  for (const [k, val] of Object.entries(o)) {
    const key = pre ? `${pre}.${k}` : k;
    if (val && typeof val === 'object' && !Array.isArray(val) && Object.keys(val).length && Object.keys(val).length <= 12 && pre.split('.').length < 3) out.push(...flatten(val, key));
    else out.push([key, val]);
  }
  return out;
}

