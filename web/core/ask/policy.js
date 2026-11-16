// When the hub may text the owner, and on which channels (pure; tests in test/ask-policy.test.js).
//
// - quiet hours (default 22:00-08:00 in DROVER_ASK_TZ, default America/New_York): normal asks wait for the morning
// - a rate limit (default 6 texts an hour, asks, batches, reminders and escalations alike; acks to the owner's own
//   replies do not count): past it, asks wait and go out together in one text
// - the owner's commands: pause (normal asks wait until then), stop (nothing goes out until resume)
// - urgent asks skip quiet hours, the rate limit and a pause; a stop holds them too
// - pages (heads-ups that a bot needs the owner or is blocked, or its urgent alert) follow the same rules, counted
//   in the same hourly limit; one per key per cooldown (DROVER_ASK_PAGE_COOLDOWN_MINUTES, default 60), at most one
//   text per source per DROVER_ASK_PAGE_GAP_MINUTES (default 10), on DROVER_ASK_PAGE_CHANNELS (default sms), dropped
//   when older than DROVER_ASK_PAGE_STALE_HOURS (default 12) unsent; DROVER_ASK_PAGES=off turns them off
import { envvar } from '../envvars.js';
import { CHANNELS } from './model.js';

export const DEFAULTS = Object.freeze({ order: ['telegram', 'imessage', 'sms'], quiet: '22:00-08:00', tz: 'America/New_York', ratePerHour: 6, ttlHours: 24, escalateMinutes: 5, remindFraction: 0.2, remindMinMinutes: 10, pageCooldownMinutes: 60, pageGapMinutes: 10, pageStaleHours: 12, pageChannels: ['sms'] });
export const COUNTED = new Set(['ask', 'batch', 'reminder', 'escalation', 'page']);
const HOUR = 3_600_000;

const num = (v, d, { min = 0, max = Infinity } = {}) => { const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? n : d; };

/** The ask settings (DROVER_ASK_*), with defaults. Never secrets: those are read by each channel. */
export function readConfig(env = process.env) {
  const order = String(envvar('ASK_CHANNELS', env) ?? '').split(',').map((s) => s.trim().toLowerCase()).filter((c) => CHANNELS.includes(c));
  const quiet = String(envvar('ASK_QUIET', env) ?? DEFAULTS.quiet).trim();
  return {
    hub: (envvar('ASK_HUB', env) ?? '').trim() || null,
    order: order.length ? [...new Set(order)] : [...DEFAULTS.order],
    quiet: /^(off|none|0|false|no)$/i.test(quiet) ? null : parseWindow(quiet) ?? parseWindow(DEFAULTS.quiet),
    tz: validTz(envvar('ASK_TZ', env)) ?? DEFAULTS.tz,
    ratePerHour: num(envvar('ASK_RATE', env), DEFAULTS.ratePerHour, { min: 1, max: 120 }),
    ttlMs: num(envvar('ASK_TTL_HOURS', env), DEFAULTS.ttlHours, { min: 0.05, max: 24 * 14 }) * HOUR,
    escalateMs: num(envvar('ASK_ESCALATE_MINUTES', env), DEFAULTS.escalateMinutes, { min: 1, max: 24 * 60 }) * 60_000,
    pages: !/^(off|none|0|false|no)$/i.test(String(envvar('ASK_PAGES', env) ?? '').trim()),
    pageChannels: pageChannels(envvar('ASK_PAGE_CHANNELS', env)),
    pageCooldownMs: num(envvar('ASK_PAGE_COOLDOWN_MINUTES', env), DEFAULTS.pageCooldownMinutes, { min: 1, max: 7 * 24 * 60 }) * 60_000,
    pageGapMs: num(envvar('ASK_PAGE_GAP_MINUTES', env), DEFAULTS.pageGapMinutes, { min: 0, max: 24 * 60 }) * 60_000,
    pageStaleMs: num(envvar('ASK_PAGE_STALE_HOURS', env), DEFAULTS.pageStaleHours, { min: 0.1, max: 7 * 24 }) * HOUR,
  };
}

function pageChannels(v) {
  const list = String(v ?? '').split(',').map((c) => c.trim().toLowerCase()).filter((c) => CHANNELS.includes(c));
  return list.length ? [...new Set(list)] : [...DEFAULTS.pageChannels];
}

/** "22:00-08:00" -> {start: 1320, end: 480} in minutes after midnight; null when it does not parse. */
export function parseWindow(s) {
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const [h1, m1, h2, m2] = m.slice(1).map(Number);
  if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) return null;
  const start = h1 * 60 + m1, end = h2 * 60 + m2;
  return start === end ? null : { start, end };
}

function validTz(tz) {
  if (!tz) return null;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return null; }
}

/** Minutes after local midnight at `now` in `tz`. */
export function localMinutes(now, tz) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now));
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24, m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return h * 60 + m;
}

/** {quiet, endsAt}: whether `now` is inside the window, and when it ends (to the minute; a DST change can move it an hour, the next tick corrects). */
export function quietState(now, { quiet, tz }) {
  if (!quiet) return { quiet: false, endsAt: null };
  const t = localMinutes(now, tz);
  const inside = quiet.start < quiet.end ? t >= quiet.start && t < quiet.end : t >= quiet.start || t < quiet.end;
  if (!inside) return { quiet: false, endsAt: null };
  const left = (quiet.end - t + 1440) % 1440 || 1440;
  return { quiet: true, endsAt: now - (now % 60_000) + left * 60_000 };
}

/** {allowed, used, nextAt}: texts counted in the last hour, and when the oldest leaves the window. */
export function rateState(sends, now, { ratePerHour }) {
  const recent = sends.filter((s) => COUNTED.has(s.kind) && s.ok !== false && now - Date.parse(s.ts) < HOUR).map((s) => Date.parse(s.ts)).sort((a, b) => a - b);
  if (recent.length < ratePerHour) return { allowed: true, used: recent.length, nextAt: null };
  return { allowed: false, used: recent.length, nextAt: recent[recent.length - ratePerHour] + HOUR };
}

/** {stopped, pausedUntil}: the owner's commands, in order. */
export function pauseState(controls, now) {
  let stopped = false, pausedUntil = null, since = null;
  for (const c of controls) {
    if (c.command === 'stop') { stopped = true; since = c.ts; }
    else if (c.command === 'resume') { stopped = false; pausedUntil = null; }
    else if (c.command === 'pause') { const until = Date.parse(c.until ?? '') || (Date.parse(c.ts) + Number(c.ms ?? 0)); pausedUntil = Math.max(pausedUntil ?? 0, until); }
  }
  if (pausedUntil !== null && pausedUntil <= now) pausedUntil = null;
  return { stopped, pausedUntil, stoppedSince: stopped ? since : null };
}

/**
 * Whether an ask may be texted now: {send: true} or {send: false, until (ms or null for until resume), why}.
 * urgent skips quiet hours, a pause and the rate limit; nothing skips a stop.
 */
export function mayText(ask, { now, config, sends = [], controls = [] }) {
  const p = pauseState(controls, now);
  if (p.stopped) return { send: false, until: null, why: 'stopped' };
  if (ask.urgency === 'urgent') return { send: true };
  if (p.pausedUntil) return { send: false, until: p.pausedUntil, why: 'paused' };
  const q = quietState(now, config);
  if (q.quiet) return { send: false, until: q.endsAt, why: 'quiet hours' };
  const r = rateState(sends, now, config);
  if (!r.allowed) return { send: false, until: r.nextAt, why: 'rate limit' };
  return { send: true };
}

/** The channels an ask goes out on, in order: its own list or the configured order, only those that work. */
export function channelOrder(ask, { order, usable }) {
  const want = Array.isArray(ask.channels) && ask.channels.length ? ask.channels : order;
  return want.filter((c) => usable.includes(c));
}

/** When an open ask gets its one reminder: before it expires, by remindFraction of its life (at least remindMinMinutes). */
export function reminderAt(ask) {
  if (!ask.expiresAt) return null;
  const end = Date.parse(ask.expiresAt), start = Date.parse(ask.routedAt ?? ask.createdAt ?? '') || end;
  const life = Math.max(0, end - start);
  const lead = Math.max(DEFAULTS.remindMinMinutes * 60_000, life * DEFAULTS.remindFraction);
  if (life <= lead) return null;   // too short a life for a reminder to help
  return end - lead;
}
