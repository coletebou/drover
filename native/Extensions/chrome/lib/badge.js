// Toolbar badge state from the polled summary. Pure.
import { truncate } from './text.js';

export const BADGE_COLORS = Object.freeze({
  unconfigured: '#9c9c95',
  error: '#de8c82',
  waiting: '#e2a73e',
  quiet: '#8db6df',
});

const TEXT = '#16191e';

/** @param {{ configured: boolean, data: any, error: {kind:string,message:string}|null }} s */
export function badgeFor({ configured, data, error }) {
  if (!configured) {
    return { text: '?', color: BADGE_COLORS.unconfigured, textColor: TEXT, title: 'Drover: set the server and token in options' };
  }
  if (error) {
    return { text: '!', color: BADGE_COLORS.error, textColor: TEXT, title: `Drover: ${truncate(error.message, 120)}` };
  }
  const t = data?.totals ?? {};
  const waiting = Number.isFinite(t.waiting) ? t.waiting : 0;
  const working = Number.isFinite(t.working) ? t.working : 0;
  const idle = Number.isFinite(t.idle) ? t.idle : 0;
  const title = `Drover: ${waiting} waiting, ${working} working, ${idle} idle`;
  if (waiting > 0) {
    return { text: waiting > 99 ? '99+' : String(waiting), color: BADGE_COLORS.waiting, textColor: TEXT, title };
  }
  return { text: '', color: BADGE_COLORS.quiet, textColor: TEXT, title };
}
