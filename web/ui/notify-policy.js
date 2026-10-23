// Notification policy, shared by the daemon (core/settings.js, core/notify.js)
// and the browser (ui/notifier.js). Pure: no DOM, no fs, no clock reads except
// through the `now` arguments, so node --test covers it directly.
//
// Settings live server-side as `settings` events in the truth file (each event
// carries a validated patch; the fold is DEFAULT_SETTINGS deep-merged with every
// patch in order). The browser keeps a cached copy and asks the daemon to change
// it through settings.set.

/** Alert categories, in priority order (first wins when a group needs one sound). */
export const CATEGORIES = [
  { id: 'needs-you', label: 'Needs you', hint: 'a dialog is on screen, the Notification hook fired, or the agent is waiting for input' },
  { id: 'error', label: 'Error or crash', hint: 'a session died, a headless agent exited non-zero, or a host stopped answering' },
  { id: 'held', label: 'Held peer message', hint: 'a session is holding a message from another session and wants you to accept it' },
  { id: 'manager', label: 'OpenClaw manager', hint: 'the fleet manager replied or wrote to the truth file' },
  { id: 'mr', label: 'Merge requests', hint: 'a comment, review, push, mergeable change or merge on a watched MR' },
  { id: 'finished', label: 'Finished', hint: 'a session went from busy to idle; the alert carries its last line' },
  { id: 'launch', label: 'Launch done', hint: 'an agent or review was started (by you, an agent or the manager)' },
];
export const CATEGORY_IDS = CATEGORIES.map((c) => c.id);
export const PRIORITY = Object.fromEntries(CATEGORY_IDS.map((id, i) => [id, i]));

/** Synthesized sounds (ui/sounds.js renders them with WebAudio; no audio files). */
export const SOUNDS = [
  { id: 'none', label: 'No sound' },
  { id: 'chime', label: 'Chime' },
  { id: 'ping', label: 'Ping' },
  { id: 'pluck', label: 'Pluck' },
  { id: 'bell', label: 'Bell' },
  { id: 'knock', label: 'Knock' },
  { id: 'blip', label: 'Blip' },
  { id: 'rise', label: 'Rise' },
  { id: 'fall', label: 'Fall' },
  { id: 'alarm', label: 'Alarm' },
  { id: 'marimba', label: 'Marimba' },
];
export const SOUND_IDS = SOUNDS.map((s) => s.id);

export const MUTE_SCOPES = ['host', 'session', 'tmux', 'category'];

const cat = (desktop, sound, volume, { sticky = false, speak = false, enabled = true } = {}) => ({ enabled, desktop, sound, volume, speak, sticky });

export const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  master: true,                       // all alerts on/off
  toasts: true,                       // in-page toasts while the tab is in front
  categories: {
    'needs-you': cat(true, 'chime', 0.8, { sticky: true }),
    error: cat(true, 'alarm', 0.6, { sticky: true }),
    held: cat(true, 'knock', 0.7, { sticky: true }),
    manager: cat(true, 'rise', 0.6),
    mr: cat(true, 'bell', 0.5),
    finished: cat(true, 'pluck', 0.5),
    launch: cat(false, 'blip', 0.4),
  },
  mutes: [],                          // [{ id, scope, target, host?, until?, label?, by? }]
  quietHours: { enabled: false, start: '22:00', end: '07:00', allow: [] },   // allow: categories that still sound
  away: { onlyWhenAway: false, idleSeconds: 60, useIdleDetection: true },
  coalesce: { windowMs: 2500, maxPerMinute: 8 },
  speech: { voiceURI: '', rate: 1, pitch: 1, localOnly: true },
  badge: { title: true, favicon: true, app: true },
  mr: { scope: 'mine', authors: [] }, // scope mine|all; authors: Repos author ids that are "mine"
  dictation: { allowCloud: false, lang: 'en-US', autoSend: false },
  peers: { enabled: false, list: [] }, // [{ name, url }]; tokens never leave the browser
});

// ---------------------------------------------------------------- merge + validate
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

/** Deep merge: objects merge, arrays and scalars replace. Never mutates inputs. */
export function mergeSettings(base, patch) {
  if (!isObj(patch)) return clone(base);
  const out = clone(base) ?? {};
  for (const [k, v] of Object.entries(patch)) {
    if (isObj(v) && isObj(out[k])) out[k] = mergeSettings(out[k], v);
    else out[k] = clone(v);
  }
  return out;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const NAME = /^[A-Za-z0-9_.:@%/ -]{1,120}$/;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Validators for leaves that are not plain "same type as the default". */
const LEAF = {
  'categories.*.sound': (v) => { if (!SOUND_IDS.includes(v)) throw new Error(`unknown sound ${JSON.stringify(v)}`); return v; },
  'categories.*.volume': (v) => clamp(num(v), 0, 1),
  'quietHours.start': (v) => { if (!HHMM.test(v)) throw new Error('quietHours.start must be HH:MM'); return v; },
  'quietHours.end': (v) => { if (!HHMM.test(v)) throw new Error('quietHours.end must be HH:MM'); return v; },
  'quietHours.allow': (v) => { arrOf(v, 'quietHours.allow'); for (const c of v) if (!CATEGORY_IDS.includes(c)) throw new Error(`unknown category ${c}`); return [...new Set(v)]; },
  'away.idleSeconds': (v) => clamp(Math.round(num(v)), 60, 3600),
  'coalesce.windowMs': (v) => clamp(Math.round(num(v)), 0, 60_000),
  'coalesce.maxPerMinute': (v) => clamp(Math.round(num(v)), 1, 120),
  'speech.rate': (v) => clamp(num(v), 0.5, 2),
  'speech.pitch': (v) => clamp(num(v), 0, 2),
  'speech.voiceURI': (v) => short(v, 300),
  'mr.scope': (v) => { if (!['mine', 'all'].includes(v)) throw new Error('mr.scope must be mine or all'); return v; },
  'mr.authors': (v) => { arrOf(v, 'mr.authors'); return [...new Set(v.map((x) => short(x, 120)))].slice(0, 50); },
  'dictation.lang': (v) => { if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(v)) throw new Error('dictation.lang must be a BCP 47 tag like en-US'); return v; },
  mutes: (v) => { arrOf(v, 'mutes'); return v.slice(0, 500).map(validateMute); },
  'peers.list': (v) => { arrOf(v, 'peers.list'); return v.slice(0, 20).map(validatePeer); },
};
function num(v) { const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v; if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error('expected a number'); return n; }
function short(v, max) { if (typeof v !== 'string') throw new Error('expected a string'); if (v.length > max) throw new Error('string too long'); return v; }
function arrOf(v, name) { if (!Array.isArray(v)) throw new Error(`${name} must be an array`); }

export function validateMute(m) {
  if (!isObj(m)) throw new Error('a mute must be an object');
  if (!MUTE_SCOPES.includes(m.scope)) throw new Error(`mute.scope must be one of ${MUTE_SCOPES.join(', ')}`);
  if (typeof m.target !== 'string' || !NAME.test(m.target)) throw new Error('mute.target must be a short name');
  if (m.scope === 'category' && !CATEGORY_IDS.includes(m.target)) throw new Error(`unknown category ${m.target}`);
  const out = { id: typeof m.id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(m.id) ? m.id : `${m.scope}:${m.host ?? ''}:${m.target}`, scope: m.scope, target: m.target };
  if (m.host !== undefined && m.host !== null && m.host !== '') { if (typeof m.host !== 'string' || !NAME.test(m.host)) throw new Error('mute.host must be a host name'); out.host = m.host; }
  if (m.until !== undefined && m.until !== null) { const t = Date.parse(m.until); if (!Number.isFinite(t)) throw new Error('mute.until must be an ISO time'); out.until = new Date(t).toISOString(); }
  if (m.label !== undefined) out.label = short(String(m.label), 200);
  if (m.by !== undefined) out.by = short(String(m.by), 60);
  return out;
}
export function validatePeer(p) {
  if (!isObj(p)) throw new Error('a peer must be an object');
  if (typeof p.name !== 'string' || !/^[A-Za-z0-9_.-]{1,60}$/.test(p.name)) throw new Error('peer.name must be a short host-like name');
  let u; try { u = new URL(p.url); } catch { throw new Error('peer.url must be a URL'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('peer.url must be http or https');
  if ('token' in p) throw new Error('peer tokens stay in the browser; do not send them to the daemon');
  return { name: p.name, url: u.origin + '/' };
}

/**
 * Validate a settings patch against the defaults' shape. Unknown keys and wrong
 * types are errors (an LLM gets an actionable message); numbers are clamped.
 * Returns the cleaned patch.
 */
export function validatePatch(patch, defaults = DEFAULT_SETTINGS, path = '') {
  if (!isObj(patch)) throw new Error(`${path || 'patch'} must be an object`);
  const out = {};
  for (const [k, v] of Object.entries(patch)) {
    const p = path ? `${path}.${k}` : k;
    if (p === 'version') continue;
    const generic = p.replace(/^categories\.[^.]+/, 'categories.*');
    if (path === 'categories' && !CATEGORY_IDS.includes(k)) throw new Error(`unknown category ${JSON.stringify(k)}`);
    const def = path === 'categories' ? defaults[k] : defaults?.[k];
    if (def === undefined && !LEAF[p] && !LEAF[generic]) throw new Error(`unknown setting ${p}`);
    const leaf = LEAF[p] ?? LEAF[generic];
    try {
      if (leaf) out[k] = leaf(v);
      else if (isObj(def)) out[k] = validatePatch(v, def, p);
      else if (typeof def === 'boolean') { if (typeof v !== 'boolean') throw new Error('expected true or false'); out[k] = v; }
      else if (typeof def === 'number') out[k] = num(v);
      else if (typeof def === 'string') out[k] = short(v, 300);
      else throw new Error('not settable');
    } catch (e) { throw new Error(e.message.startsWith(p) ? e.message : `${p}: ${e.message}`); }
  }
  return out;
}

/** The effective settings from a list of patches (oldest first). Invalid patches are skipped. */
export function foldSettings(patches = []) {
  let s = clone(DEFAULT_SETTINGS);
  for (const p of patches) { try { s = mergeSettings(s, validatePatch(p)); } catch { /* an old or hand-written bad patch; ignore it */ } }
  return s;
}

// ---------------------------------------------------------------- decisions
export function activeMutes(settings, now = Date.now()) {
  return (settings?.mutes ?? []).filter((m) => !m.until || Date.parse(m.until) > now);
}

/** Session part of a tmux target: "work:@12.%3" -> "work". */
export function tmuxSessionOf(target) { const m = String(target ?? '').match(/^([^:]+):/); return m ? m[1] : null; }

/** Which mute (if any) silences this alert. */
export function muteFor(alert, settings, now = Date.now()) {
  for (const m of activeMutes(settings, now)) {
    if (m.host && m.scope !== 'host' && alert.host && m.host !== alert.host) continue;
    if (m.scope === 'category' && alert.category === m.target) return m;
    if (m.scope === 'host' && alert.host === m.target) return m;
    if (m.scope === 'session' && (alert.sessionId === m.target || (alert.name && alert.name === m.target))) return m;
    if (m.scope === 'tmux' && tmuxSessionOf(alert.target) === m.target) return m;
  }
  return null;
}

const minutes = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
/** Is `date` (a Date in the viewer's local time) inside quiet hours? Handles ranges across midnight. */
export function inQuietHours(settings, date = new Date()) {
  const q = settings?.quietHours;
  if (!q?.enabled || !HHMM.test(q.start ?? '') || !HHMM.test(q.end ?? '')) return false;
  const t = date.getHours() * 60 + date.getMinutes();
  const s = minutes(q.start), e = minutes(q.end);
  if (s === e) return true;                    // "22:00 to 22:00" means all day
  return s < e ? t >= s && t < e : t >= s || t < e;
}

/**
 * What to do with one alert on this device right now.
 * ctx: { now, date, away (bool), visible (bool) }.
 * Returns { show, toast, desktop, sound, volume, speak, sticky, reason }.
 * show=false means drop it entirely (master off, category off, muted).
 */
export function decide(alert, settings, { now = Date.now(), date = new Date(now), away = false, visible = true } = {}) {
  const s = settings ?? DEFAULT_SETTINGS;
  const c = s.categories?.[alert.category] ?? DEFAULT_SETTINGS.categories[alert.category] ?? cat(true, 'none', 0.5);
  const none = (reason) => ({ show: false, toast: false, desktop: false, sound: 'none', volume: 0, speak: false, sticky: false, reason });
  if (alert.test) {
    // A test from the Settings view always plays exactly what the category is set to.
    return { show: true, toast: true, desktop: c.desktop, sound: c.sound, volume: c.volume, speak: c.speak, sticky: c.sticky, reason: 'test' };
  }
  if (!s.master) return none('all alerts are off');
  if (!c.enabled) return none(`${alert.category} alerts are off`);
  const m = muteFor(alert, s, now);
  if (m) return none(`muted (${m.scope} ${m.target}${m.until ? ' until ' + m.until : ''})`);
  let desktop = c.desktop, sound = c.sound, speak = c.speak, reason = null;
  const quiet = inQuietHours(s, date) && !(s.quietHours.allow ?? []).includes(alert.category);
  if (quiet) { desktop = false; sound = 'none'; speak = false; reason = 'quiet hours'; }
  if (s.away?.onlyWhenAway && !away) { desktop = false; sound = 'none'; speak = false; reason = reason ?? 'you are here'; }
  return { show: true, toast: Boolean(s.toasts) && visible, desktop, sound, volume: c.volume, speak, sticky: c.sticky, reason };
}

/**
 * Coalesce a burst of alerts into notifications. Groups by category when a
 * category has more than one alert; a burst across several categories with more
 * than `maxSingles` alerts collapses into one summary. Returns
 * [{ category, alerts: [...], title, body, single }] in priority order.
 */
export function coalesce(alerts, { maxSingles = 3 } = {}) {
  const live = alerts.filter(Boolean);
  if (!live.length) return [];
  const by = new Map();
  for (const a of live) { const arr = by.get(a.category) ?? []; arr.push(a); by.set(a.category, arr); }
  const groups = [...by.entries()].sort((x, y) => (PRIORITY[x[0]] ?? 99) - (PRIORITY[y[0]] ?? 99)).map(([category, list]) => groupOf(category, list));
  if (groups.length > maxSingles) {
    const all = groups.flatMap((g) => g.alerts);
    const parts = groups.map((g) => `${g.alerts.length} ${labelOf(g.category).toLowerCase()}`);
    return [{ category: groups[0].category, alerts: all, single: false, title: `${all.length} agent alerts`, body: parts.join(', ') }];
  }
  return groups;
}
function labelOf(category) { return CATEGORIES.find((c) => c.id === category)?.label ?? category; }
function groupOf(category, list) {
  if (list.length === 1) return { category, alerts: list, single: true, title: list[0].title ?? labelOf(category), body: list[0].body ?? '' };
  const names = list.map((a) => a.name ?? a.sessionId?.slice(0, 8) ?? a.target ?? '?');
  const shown = names.slice(0, 4).join(', ') + (names.length > 4 ? ` and ${names.length - 4} more` : '');
  const verb = { 'needs-you': 'need you', finished: 'finished', error: 'failed', held: 'hold a peer message', mr: 'merge request updates', launch: 'launched', manager: 'manager messages' }[category] ?? category;
  const title = category === 'mr' || category === 'manager' ? `${list.length} ${verb}` : `${list.length} sessions ${verb}`;
  return { category, alerts: list, single: false, title, body: shown };
}

/**
 * Sliding-window rate limit for desktop notifications. `history` is the list
 * of ms timestamps already shown; returns { allowed, history } (pure).
 */
export function rateLimit(history, { now = Date.now(), maxPerMinute = 8 } = {}) {
  const recent = (history ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= maxPerMinute) return { allowed: false, history: recent };
  return { allowed: true, history: [...recent, now] };
}

/** A one-line spoken summary for a group (short; voices read every character). */
export function speechFor(group) {
  if (group.single) {
    const a = group.alerts[0];
    const who = a.name ?? 'an agent';
    const what = { 'needs-you': 'needs you', finished: 'finished', error: 'failed', held: 'is holding a peer message', mr: 'has a merge request update', launch: 'launched', manager: 'the manager says' }[a.category] ?? a.category;
    if (a.category === 'manager') return `Manager: ${String(a.body ?? '').slice(0, 160)}`;
    // Same words as the notification: who, what kind of ask, and what it is.
    if (a.ask) return `${who} ${a.ask.kind === 'finished' ? 'finished' : a.ask.label}${a.ask.text ? `: ${String(a.ask.text).replace(/^…/, '').slice(0, 160)}` : ''}`;
    return `${who} ${what}${a.category === 'finished' && a.body ? `: ${String(a.body).slice(0, 120)}` : ''}`;
  }
  return `${group.title}`;
}

// ---------------------------------------------------------------- what a stopped session is asking
// Claude Code's idle Notification ("Claude is waiting for your input") only says
// the session stopped, not why. classifyAsk looks at what is really there:
//   decision   a dialog or held peer message is on screen (pick an option)
//   question   an unanswered AskUserQuestion, or the last reply ends with a question
//   finished   the agent finished its answer; nothing is pending
// Only decision and question belong in "Waiting on you".
export const ASK_LABELS = { decision: 'needs a decision', question: 'asked you a question', finished: 'finished, no question pending' };

/** About `max` chars from the end of a reply (where the question or the result is), cut on a word. */
export function excerpt(text, max = 200) {
  const t = String(text ?? '').replace(/```[\s\S]*?```/g, ' [code] ').replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const tail = t.slice(-max);
  const sp = tail.indexOf(' ');
  return '…' + (sp > 0 && sp < 40 ? tail.slice(sp + 1) : tail);
}

/** Does the reply end by asking something? (last meaningful line ends with "?") */
export function endsWithQuestion(text) {
  const lines = String(text ?? '').replace(/```[\s\S]*?```/g, '').split('\n').map((l) => l.replace(/[*_`>#\s]+$/g, '').replace(/^[#>*\-\s]+/, '').trim()).filter(Boolean);
  const last = lines.at(-1) ?? '';
  return /\?\s*\)?$/.test(last);
}

/**
 * ctx: { screenState, dialog: {question, options}, held, heldFrom, text, pendingAsk: {question, options} }.
 * Returns { kind, label, text, options }.
 */
export function classifyAsk(ctx = {}) {
  if (ctx.held) return { kind: 'decision', label: ASK_LABELS.decision, text: `Held message from another session${ctx.heldFrom ? ` (${ctx.heldFrom})` : ''}: deliver or drop it`, options: ctx.dialog?.options ?? [] };
  if (ctx.screenState === 'dialog') return { kind: 'decision', label: ASK_LABELS.decision, text: ctx.dialog?.question ?? 'a dialog is open', options: ctx.dialog?.options ?? [] };
  if (ctx.pendingAsk?.question || ctx.pendingAsk?.options?.length) return { kind: 'question', label: ASK_LABELS.question, text: ctx.pendingAsk.question ?? excerpt(ctx.text), options: ctx.pendingAsk.options ?? [] };
  if (ctx.text && endsWithQuestion(ctx.text)) return { kind: 'question', label: ASK_LABELS.question, text: excerpt(ctx.text), options: [] };
  return { kind: 'finished', label: ASK_LABELS.finished, text: ctx.text ? excerpt(ctx.text) : '', options: [] };
}
