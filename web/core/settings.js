// Settings for alerts, sounds, dictation and peers. Stored in the truth file as
// `settings` events (each a validated patch), so they are fleet-wide, recorded
// in the WAL like every other change, and visible to agents through the
// generated MCP tools. The fold and the validation live in ui/notify-policy.js
// so the browser and the daemon agree on every rule.
import * as events from './events.js';
import { DEFAULT_SETTINGS, CATEGORIES, SOUNDS, MUTE_SCOPES, foldSettings, mergeSettings, validatePatch, validateMute, activeMutes, clone } from '../ui/notify-policy.js';
import { OWNER } from './owner.js';

export const _deps = {
  readEvents: () => events.readAll(_deps.eventsFile()),
  appendEvent: (ev, opts = {}) => events.append(ev, { ...opts, file: _deps.eventsFile() }),
  eventsFile: () => events.EVENTS_PATH,
  now: () => Date.now(),
};

let memo = null; // { count, last, settings, updated, by }
const listeners = new Set();
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(s) { for (const l of listeners) { try { l(s); } catch { /* listener error */ } } }

/** Current settings: DEFAULT_SETTINGS folded with every `settings` patch in the truth file. */
export async function current() {
  const all = await _deps.readEvents();
  const last = all.at(-1)?.id ?? null;
  if (memo && memo.count === all.length && memo.last === last) return memo;
  const patches = all.filter((e) => e.type === 'settings' && e.patch);
  const lastPatch = patches.at(-1) ?? null;
  memo = { count: all.length, last, settings: foldSettings(patches.map((e) => e.patch)), updated: lastPatch?.ts ?? null, by: lastPatch?.actor ?? null, patches: patches.length };
  return memo;
}
export function invalidate() { memo = null; }

export async function get() {
  const c = await current();
  return {
    settings: c.settings, updated: c.updated, by: c.by, patches: c.patches,
    activeMutes: activeMutes(c.settings, _deps.now()),
    catalog: { categories: CATEGORIES, sounds: SOUNDS, muteScopes: MUTE_SCOPES },
    defaults: clone(DEFAULT_SETTINGS),
  };
}

/** Validate and record a patch; returns the new effective settings. */
export async function set(patch, { actor = OWNER, reason } = {}) {
  const clean = validatePatch(patch);
  if (!Object.keys(clean).length) throw new Error('patch is empty: nothing to change');
  const ev = await _deps.appendEvent({ type: 'settings', patch: clean, ...(reason ? { reason: String(reason).slice(0, 200) } : {}) }, { actor });
  invalidate();
  const out = await get();
  emit(out);
  return { ...out, event: ev.id };
}

/** Reset one top-level section (or everything) to the defaults, recorded as a patch. */
export async function reset({ section, actor = OWNER } = {}) {
  if (section !== undefined && !(section in DEFAULT_SETTINGS)) throw new Error(`unknown section ${JSON.stringify(section)}; one of ${Object.keys(DEFAULT_SETTINGS).filter((k) => k !== 'version').join(', ')}`);
  const patch = section ? { [section]: clone(DEFAULT_SETTINGS[section]) } : Object.fromEntries(Object.entries(clone(DEFAULT_SETTINGS)).filter(([k]) => k !== 'version'));
  return set(patch, { actor, reason: `reset ${section ?? 'all'}` });
}

/** Add a mute (scope host|session|tmux|category). minutes omitted = until unmuted. Expired mutes are pruned. */
export async function mute({ scope, target, host, minutes, label, actor = OWNER } = {}) {
  const now = _deps.now();
  const until = minutes === undefined || minutes === null || minutes === '' ? null : new Date(now + Math.max(1, Number(minutes)) * 60_000).toISOString();
  if (until !== null && !Number.isFinite(Date.parse(until))) throw new Error('minutes must be a number');
  const m = validateMute({ scope, target, host, until, label, by: actor });
  const { settings } = await current();
  const kept = activeMutes(settings, now).filter((x) => x.id !== m.id);
  return set({ mutes: [...kept, m] }, { actor, reason: `mute ${m.scope} ${m.target}` });
}
export async function unmute({ id, scope, target, host, actor = OWNER } = {}) {
  const { settings } = await current();
  const now = _deps.now();
  const live = activeMutes(settings, now);
  const keep = live.filter((m) => !(id ? m.id === id : m.scope === scope && m.target === target && (host === undefined || (m.host ?? null) === (host || null))));
  if (keep.length === live.length && live.length === (settings.mutes ?? []).length) throw new Error('no such mute');
  return set({ mutes: keep }, { actor, reason: `unmute ${id ?? `${scope} ${target}`}` });
}

export { mergeSettings };

export const ops = {
  'settings.get': () => get(),
  'settings.set': ({ patch, actor, reason } = {}) => set(patch, { actor, reason }),
  'settings.reset': ({ section, actor } = {}) => reset({ section, actor }),
  'notify.mute': (a = {}) => mute(a),
  'notify.unmute': (a = {}) => unmute(a),
};
