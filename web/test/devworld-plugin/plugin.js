// Stand-ins the dev world (test/devworld.js) loads as its one plugin, for ops the cohesion overhaul adds to the daemon
// (docs/specs/2026-11-21-cohesion-overhaul.md): tmux.captureMany reads the world's own private tmux server (real panes,
// colors kept), and prompts.list / prompts.local / prompts.status / prompts.sync answer from synthetic records
// (DEVWORLD_PROMPTS, written by devworld.js). A plugin can add ops but never replace one (core/api.js applyPlugin), so
// once the daemon serves an op itself, its stand-in here is refused and the real one answers. Synthetic data only.
import { capture } from 'drover/core/tmux.js';
import { localShortName } from 'drover/core/hosts.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const MINE = ['typed', 'queued', 'drover', 'headless'];
const MAX_TARGETS = 64;

function world() {
  try { return JSON.parse(readFileSync(process.env.DEVWORLD_PROMPTS ?? '', 'utf8')); } catch { return { prompts: [], hosts: [], sinks: [] }; }
}
const front = () => localShortName();
/** The records, the front host's own named as it names itself; newest first. */
function records() {
  const w = world(); const me = front();
  return (w.prompts ?? []).map((p) => ({ ...p, host: p.host === '@front' ? me : p.host })).sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts) || b.id.localeCompare(a.id));
}
const added = [];   // what prompts.sync "found" this run (so a sync visibly adds one)
let syncedAt = null;
const sinksNow = (w) => (w.sinks ?? []).map((s) => (s.lastError || !syncedAt ? s : { ...s, lastSync: syncedAt, pending: 0 }));

function filter(list, a = {}) {
  const words = String(a.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const hostsWanted = a.hosts?.length ? new Set(a.hosts) : a.host ? new Set([a.host]) : null;
  const via = Array.isArray(a.via) && a.via.length ? new Set(a.via) : new Set(MINE);
  const since = a.since ? Date.parse(a.since) : null; const until = a.until ? Date.parse(a.until) : null;
  let out = list.filter((p) => (!hostsWanted || hostsWanted.has(p.host)) && (!a.engine || p.engine === a.engine) && (!a.label || p.label === a.label) && via.has(p.via)
    && (!a.session || p.session === a.session) && (!a.cwd || p.cwd === a.cwd) && (!since || Date.parse(p.ts) >= since) && (!until || Date.parse(p.ts) <= until)
    && words.every((w) => String(p.text).toLowerCase().includes(w)));
  const total = out.length;
  if (a.before) { const i = out.findIndex((p) => p.id === a.before); out = i >= 0 ? out.slice(i + 1) : []; }
  const limit = Math.max(1, Math.min(2000, Number(a.limit) || 200));
  return { list: out.slice(0, limit), total };
}

export default {
  name: 'devworld',
  ops: {
    async 'tmux.captureMany'({ targets, lines = 60, escapes = true } = {}) {
      if (!Array.isArray(targets) || !targets.length || targets.length > MAX_TARGETS) throw new Error(`targets must be an array of 1 to ${MAX_TARGETS} tmux targets`);
      const captures = await Promise.all(targets.map(async (target) => {
        try {
          const text = await capture(String(target), { lines, escapes: escapes !== false });
          return { target, ok: true, text, hash: createHash('sha1').update(text).digest('hex').slice(0, 16) };
        } catch (e) { return { target, ok: false, error: String(e?.message ?? e).split('\n')[0] }; }
      }));
      return { captures };
    },
    async 'prompts.local'(args = {}) { const me = front(); const { list } = filter([...added, ...records()].filter((p) => p.host === me), args); return { prompts: list }; },
    async 'prompts.status'() {
      const w = world(); const all = [...added, ...records()];
      return { files: new Set(all.map((p) => `${p.host}/${p.ts.slice(0, 10)}`)).size, records: all.length, oldest: all.at(-1)?.ts ?? null, newest: all[0]?.ts ?? null, lastScan: new Date().toISOString(), scanning: false, sinks: sinksNow(w) };
    },
    async 'prompts.sync'() {
      const me = front(); const ts = new Date().toISOString();
      const text = `Summarise what changed in the parser since this morning (sync ${added.length + 1})`;
      added.unshift({ v: 1, id: `p_${createHash('sha1').update(`${me}|sync|${ts}|${text}`).digest('hex').slice(0, 16)}`, ts, host: me, engine: 'claude', session: null, cwd: '~/code/demo', project: 'demo', label: 'work', via: 'typed', text });
      syncedAt = ts;
      return { scanned: 3, added: 1, sinks: sinksNow(world()) };
    },
  },
  front: {
    async 'prompts.list'(args = {}) {
      const w = world();
      const all = [...added, ...records()];
      const { list, total } = filter(all, args);
      const down = new Set((w.hosts ?? []).filter((x) => x.down).map((x) => x.name));
      const perHost = (w.hosts ?? []).map((x) => (x.down ? { host: x.name, ok: false, count: 0, error: x.down } : { host: x.name === '@front' ? front() : x.name, ok: true, count: list.filter((p) => p.host === (x.name === '@front' ? front() : x.name)).length }));
      return { prompts: list.map((p) => ({ ...p, route: down.has(p.host) ? 'sink' : 'live' })), perHost, coverage: { hosts: perHost.length, answered: perHost.filter((x) => x.ok).length }, total };
    },
  },
};
