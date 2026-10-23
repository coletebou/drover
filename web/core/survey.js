// Re-survey the fleet: a fresh snapshot of every agent (live or recently
// finished) on every reachable host, written to the truth file as a `survey`
// plus one `survey-item` per agent, in the same row shape the first viewer used
// (id, title, state, summary, host, kind, activities, mrs, next_step, evidence).
// The mechanical pass needs no model. The optional AI pass asks one Haiku call
// per survey to write the summary and next step from the evidence.
import { run } from './proc.js';
import * as events from './events.js';
import { tmuxWindowTargetOf } from './util.js';

export const _deps = { dispatch: null };

const REF = /#(\d{2,6})\b/g;
const MR = /!(\d{2,6})\b/g;
const refs = (text) => [...new Set([...String(text ?? '').matchAll(REF)].map((m) => '#' + m[1]))];
const mrs = (text) => [...new Set([...String(text ?? '').matchAll(MR)].map((m) => '!' + m[1]))];

function stateOf(s, w) {
  const screen = w?.screen?.state;
  if (!s.live) return 'finished';
  if (screen === 'dialog') return 'waiting-on-user';
  if (s.status === 'busy' || screen === 'busy') return 'active';
  if (/dead|exited|crashed/.test(String(s.status))) return 'crashed';
  return 'idle';
}

/** Build the mechanical items for one host from its fleet summary + transcript tails. */
async function itemsForHost(dispatch, h, { recentDays = 2, tailTurns = 12 } = {}) {
  const hostArg = h.host === 'local' ? {} : { host: h.host };
  const byWin = new Map(h.windows.filter((w) => w.agent?.sessionId).map((w) => [w.agent.sessionId, w]));
  const items = [];
  // recent non-live sessions too (finished / cut off), from the host's full list
  let full = h.sessions;
  try { const r = await dispatch('sessions.list', { ...hostArg, includeRecent: true }); full = r.sessions ?? h.sessions; } catch { /* keep live list */ }
  const cutoff = Date.now() - recentDays * 86400_000;
  // Transcript tails are the slow part (one rpc each over ssh): run them 8 at a time.
  const queue = [...full]; const workers = [];
  const one = async (s) => {
    const when = s.statusUpdatedAt ?? s.updatedAt ?? (s.mtime ? Date.parse(s.mtime) : 0) ?? s.startedAt ?? 0;
    if (!s.live && Number(when) < cutoff) return;
    const w = byWin.get(s.sessionId ?? s.id) ?? (s.tmux ? h.windows.find((x) => x.target === tmuxWindowTargetOf(s.tmux)) : null);
    let tail = []; let lastAssistant = ''; let lastUser = ''; let title = s.name ?? s.preview ?? '';
    try {
      const t = await dispatch('sessions.transcript', { ...hostArg, id: s.id, limit: tailTurns });
      tail = (t.turns ?? []).filter((x) => ['user', 'assistant'].includes(x.role) && x.text).map((x) => `${x.role}: ${x.text.slice(0, 300)}`);
      lastAssistant = [...(t.turns ?? [])].reverse().find((x) => x.role === 'assistant' && x.text)?.text ?? '';
      lastUser = [...(t.turns ?? [])].reverse().find((x) => x.role === 'user' && x.text && !x.meta)?.text ?? '';
      if (!title && t.summary?.title) title = t.summary.title;
      if (!title && t.summary?.firstPrompt) title = t.summary.firstPrompt.slice(0, 80);
    } catch { /* no transcript */ }
    const state = stateOf(s, w);
    const endedWithQuestion = /\?\s*$/.test(lastAssistant.trim());
    const cutOff = !s.live && (endedWithQuestion || (lastUser && !lastAssistant));
    const evidenceBits = [w?.tail?.length ? `pane: ${w.tail.join(' | ')}` : null, lastAssistant ? `last reply: ${lastAssistant.slice(0, 240)}` : null].filter(Boolean);
    items.push({
      id: `${h.host}:${s.id}`, host: h.host, kind: s.kind === 'headless' ? 'headless' : `${s.engine ?? 'claude'}-session`,
      title: title || String(s.id).slice(0, 8), state: cutOff ? 'cut-off' : state, agent: s.engine, sessionId: s.id, tmux: w?.target ?? s.tmux ?? null, cwd: s.cwd ?? w?.cwd ?? null,
      last_activity: when ? new Date(Number(when) < 1e11 ? Number(when) * 1000 : Number(when)).toISOString() : null,
      activities: refs(`${title} ${lastAssistant} ${lastUser} ${w?.tail?.join(' ') ?? ''}`), mrs: mrs(`${title} ${lastAssistant} ${lastUser} ${w?.tail?.join(' ') ?? ''}`),
      summary: lastAssistant ? lastAssistant.slice(0, 400) : (w?.tail?.join(' ') ?? '').slice(0, 400),
      next_step: state === 'waiting-on-user' ? 'answer the prompt on screen' : cutOff ? `resume: claude --resume ${s.id}` : state === 'active' ? 'let it finish' : '',
      evidence: evidenceBits.join('\n'), tail, source: 'survey.run',
    });
  };
  for (let i = 0; i < 8; i++) workers.push((async () => { while (queue.length) { const s = queue.shift(); await one(s); } })());
  await Promise.all(workers);
  items.sort((a, b) => String(b.last_activity ?? '').localeCompare(String(a.last_activity ?? '')));
  // shells and unmatched windows with agents
  for (const w of h.windows) {
    if (!w.agent || byWin.has(w.agent.sessionId) || items.some((i) => i.tmux === w.target)) continue;
    items.push({ id: `${h.host}:${w.target}`, host: h.host, kind: 'tmux-window', title: w.agent.name ?? w.name, state: w.screen?.state === 'dialog' ? 'waiting-on-user' : w.screen?.state === 'busy' ? 'active' : 'idle', tmux: w.target, cwd: w.cwd, summary: (w.tail ?? []).join(' ').slice(0, 400), next_step: '', evidence: `pane: ${(w.tail ?? []).join(' | ')}`, activities: refs(w.tail?.join(' ')), mrs: mrs(w.tail?.join(' ')), source: 'survey.run' });
  }
  return items;
}

/** One Haiku call per survey: fill summary / next_step / state from the evidence. Returns a map id -> patch. */
async function aiSummaries(items, { model = 'haiku' } = {}) {
  const compact = items.map((i) => ({ id: i.id, title: i.title, state: i.state, host: i.host, tmux: i.tmux, tail: (i.tail ?? []).slice(-8), evidence: i.evidence.slice(0, 600) }));
  const prompt = `You are summarizing the state of coding-agent sessions for their operator. For EACH item return a JSON object {id, summary, next_step, state} where summary is 1-2 plain sentences of what the agent was doing and where it stopped (no em-dashes, no markdown), next_step is one short sentence of what the operator should do (empty string if nothing), and state is one of waiting-on-user, active, idle, finished, cut-off, crashed (keep the given state unless the evidence clearly contradicts it). Return ONLY a JSON array, no prose.\n\nITEMS:\n${JSON.stringify(compact)}`;
  const { stdout } = await run('claude', ['-p', '--model', model, '--output-format', 'json', '--dangerously-skip-permissions', '--disallowedTools', 'Bash,Edit,Write,Read,Glob,Grep,WebFetch,Agent'], { input: prompt, timeoutMs: 180_000 });
  let out; try { out = JSON.parse(stdout); } catch { throw new Error('claude -p returned non-JSON'); }
  const text = typeof out.result === 'string' ? out.result : JSON.stringify(out.result ?? '');
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) throw new Error('no JSON array in the model reply');
  const arr = JSON.parse(m[0]);
  const map = new Map();
  for (const p of arr) if (p && typeof p.id === 'string') map.set(p.id, { summary: String(p.summary ?? '').slice(0, 600), next_step: String(p.next_step ?? '').slice(0, 300), state: p.state });
  return { map, cost: out.total_cost_usd ?? null, model: out.model ?? model };
}

/**
 * Run a survey. hosts defaults to the reachable fleet. ai=true adds the Haiku pass.
 * Appends `survey-item` events then a `survey` marker; returns counts and the marker.
 */
export async function runSurvey({ hosts, ai = false, model = 'haiku', actor = 'drover' } = {}, dispatch = _deps.dispatch) {
  if (!dispatch) throw new Error('survey needs a dispatcher');
  const fleet = await dispatch('fleet.summary', { ...(hosts?.length ? { hosts } : {}), fresh: true });
  const perHost = await Promise.all(fleet.hosts.filter((h) => h.ok || h.windows.length).map((h) => itemsForHost(dispatch, h).catch((e) => [{ id: `${h.host}:error`, host: h.host, kind: 'host', title: h.host, state: 'unknown', summary: `survey failed: ${e.message}`, next_step: '', evidence: '', activities: [], mrs: [], source: 'survey.run' }])));
  let items = perHost.flat();
  let aiInfo = null;
  if (ai && items.length) {
    try {
      const { map, cost, model: used } = await aiSummaries(items, { model });
      items = items.map((i) => { const p = map.get(i.id); return p ? { ...i, summary: p.summary || i.summary, next_step: p.next_step || i.next_step, state: ['waiting-on-user', 'active', 'idle', 'finished', 'cut-off', 'crashed'].includes(p.state) ? p.state : i.state, ai: true } : i; });
      aiInfo = { cost, model: used, covered: map.size };
    } catch (e) { aiInfo = { error: e.message }; }
  }
  const file = `survey.run@${new Date().toISOString()}`;
  for (const item of items) { const { tail, ...row } = item; await events.append({ type: 'survey-item', surveyFile: file, item: row }, { actor }); }
  const marker = await events.append({ type: 'survey', source: 'survey.run', file, count: items.length, hosts: fleet.hosts.map((h) => ({ host: h.host, ok: h.ok })), ai: aiInfo }, { actor });
  return { file, count: items.length, hosts: fleet.hosts.length, states: items.reduce((acc, i) => { acc[i.state] = (acc[i.state] ?? 0) + 1; return acc; }, {}), ai: aiInfo, event: marker.id };
}

export const ops = {
  'survey.run': (a) => runSurvey(a ?? {}),
  'survey.list': async () => { const all = await events.readAll(); const st = events.fold(all); return st.surveys.map((s) => ({ file: s.file, ts: s.ts, count: s.count, source: s.source, ai: s.ai ?? null, hosts: s.hosts ?? null })); },
};
