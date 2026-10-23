// Pure transcript handling for the side panel. Text is always rendered as plain text (lib/chat.js turns it into
// display items; ui/chat.js draws them with textContent only).

const ROLE = { user: 'user', assistant: 'assistant', tool_result: 'tool', result: 'result', system: 'system' };
const CAP = { user: 20000, assistant: 20000, tool: 400 };
const RESULT_CAP = 2000;
export const MAX_TURNS = 300;

const cap = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const str = (v) => (typeof v === 'string' && v ? v : null);

/** A tool call: `{ id, name, summary, description }` (the input stays on the daemon side of the screen). */
function call(x) {
  if (typeof x === 'string') return x ? { id: null, name: x, summary: '', description: null } : null;
  if (!x || typeof x !== 'object' || typeof x.name !== 'string' || !x.name) return null;
  const summary = typeof x.summary === 'string' ? x.summary : typeof x.input === 'string' ? x.input : '';
  return { id: str(x.id), name: x.name, summary: cap(summary, 200), description: str(x.description) };
}

function result(x) {
  if (!x || typeof x !== 'object') return null;
  return { toolUseId: str(x.toolUseId), isError: x.isError === true, text: cap(String(x.text ?? ''), RESULT_CAP), chars: Number.isFinite(x.chars) ? x.chars : null };
}

/**
 * @param {any[]} rawTurns
 * @returns {{role:string, ts:string|null, text:string, tools:string[], calls:object[], results?:object[], uuid?:string, id?:string, meta?:boolean, via?:string, actor?:string, from?:string, pending?:boolean, inReplyTo?:string, thread?:string}[]}
 */
export function normalizeTurns(rawTurns) {
  if (!Array.isArray(rawTurns)) return [];
  const out = [];
  for (const t of rawTurns) {
    if (!t || typeof t !== 'object' || t.role === 'thinking' || t.role === 'title' || t.role === 'queue') continue;
    const role = ROLE[t.role] ?? 'system';
    const text = typeof t.text === 'string' ? t.text : t.text == null ? '' : String(t.text);
    const calls = (Array.isArray(t.tools) ? t.tools : []).map(call).filter(Boolean);
    const results = role === 'tool' && Array.isArray(t.results) ? t.results.map(result).filter(Boolean) : [];
    if (!text.trim() && !calls.length && !results.length && !(role === 'assistant' && t.pending === true)) continue;
    const turn = { role, ts: typeof t.ts === 'string' && t.ts ? t.ts : null, text: CAP[role] ? cap(text, CAP[role]) : text, tools: calls.map((c) => c.name), calls };
    if (results.length) turn.results = results;
    for (const k of ['uuid', 'id', 'via', 'actor', 'from', 'inReplyTo', 'thread', 'user']) if (str(t[k])) turn[k] = t[k];
    if (t.meta === true) turn.meta = true;
    if (t.pending === true) turn.pending = true;
    out.push(turn);
  }
  return out;
}

/** The identity of a turn across reads: its uuid or event id (null when it has neither). */
export const turnKey = (t) => t.uuid ?? t.id ?? null;

/**
 * Later copies of a turn win (a pending reply settles), order is kept, and a turn with an id never shows twice.
 * Turns without an id are all kept: two identical replies are two replies.
 */
export function dedupeTurns(turns) {
  const at = new Map();
  const out = [];
  for (const t of turns) {
    const k = turnKey(t);
    if (k !== null && at.has(k)) { out[at.get(k)] = t; continue; }
    if (k !== null) at.set(k, out.length);
    out.push(t);
  }
  return out;
}

/**
 * @param {{turns:any[], offset:number, engine:string|null}|null} state
 * @param {{engine?:string, offset?:number, turns?:any[]}} response
 * @param {{since?:number}} [opts]
 */
export function mergeTranscript(state, response, { since } = {}) {
  const fresh = normalizeTurns(response?.turns);
  const prev = state?.turns ?? [];
  // Only Claude transcript files honour `since`; headless agents (also engine claude) answer whole snapshots.
  const headless = response?.headless === true;
  const append = !headless && typeof since === 'number' && since > 0 && response?.engine === 'claude' && typeof response?.offset === 'number' && response.offset >= since;
  const turns = dedupeTurns(append ? [...prev, ...fresh] : fresh).slice(-MAX_TURNS);
  return {
    turns,
    offset: response?.offset ?? 0,
    engine: response?.engine ?? null,
    headless,
    changed: signature(turns) !== signature(prev),
  };
}

const signature = (turns) => JSON.stringify(turns.map((t) => [t.role, t.ts, t.text, t.tools, t.pending ?? false, t.results?.length ?? 0]));

export function canIncrement(state) {
  return state?.engine === 'claude' && !state.headless && state.offset > 0;
}
