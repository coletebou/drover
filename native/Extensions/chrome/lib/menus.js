// Context menu model: ids, titles, click-info to draft text. Pure.
import { truncate } from './text.js';

export const MENU = Object.freeze({ SELECTION: 'drover-sel', PAGE: 'drover-page', LINK: 'drover-link' });

const PARENTS = [
  { id: MENU.SELECTION, title: 'Send selection to session', contexts: ['selection'] },
  { id: MENU.PAGE, title: 'Send page URL to session', contexts: ['page'] },
  { id: MENU.LINK, title: 'Send link to session', contexts: ['link'] },
];
const PARENT_IDS = new Set(PARENTS.map((p) => p.id));

/** Chrome treats "&" as an accelerator marker in titles. */
const esc = (s) => String(s).replace(/&/g, '&&');

export function childId(parent, s) {
  return `${parent}|${encodeURIComponent(s.host)}|${encodeURIComponent(s.id)}`;
}

export function childTitle(s) {
  return esc(`${s.state === 'waiting' ? 'Waiting: ' : ''}${truncate(s.name, 40)} (${s.host})`);
}

export function menuSpec(sessions, { max = 8 } = {}) {
  const list = (sessions ?? []).slice(0, max);
  const spec = PARENTS.map((p) => ({ id: p.id, title: p.title, contexts: p.contexts }));
  for (const p of PARENTS) {
    if (!list.length) {
      spec.push({ id: `${p.id}|none`, parentId: p.id, title: 'No active sessions', contexts: p.contexts, enabled: false });
      continue;
    }
    for (const s of list) spec.push({ id: childId(p.id, s), parentId: p.id, title: childTitle(s), contexts: p.contexts });
    spec.push({ id: `${p.id}|pick`, parentId: p.id, title: 'Choose in side panel', contexts: p.contexts });
  }
  return spec;
}

export function parseMenuId(id) {
  if (typeof id !== 'string') return null;
  const parts = id.split('|');
  const parent = parts[0];
  if (!PARENT_IDS.has(parent)) return null;
  if (parts.length === 2 && parts[1] === 'pick') return { parent, pick: true };
  if (parts.length !== 3) return null;
  try {
    const host = decodeURIComponent(parts[1]);
    const sessionId = decodeURIComponent(parts[2]);
    if (!host || !sessionId) return null;
    return { parent, host, sessionId };
  } catch { return null; }
}

export function menuSignature(spec) {
  return JSON.stringify((spec ?? []).map((p) => [p.id, p.title, p.enabled !== false]));
}

export const MAX_DRAFT = 8000;

export function composeText(parent, info) {
  const i = info ?? {};
  let text = '';
  if (parent === MENU.SELECTION) text = `${i.selectionText ?? ''}${i.pageUrl ? `\n\nSource: ${i.pageUrl}` : ''}`;
  else if (parent === MENU.PAGE) text = i.pageUrl ?? '';
  else if (parent === MENU.LINK) text = i.linkUrl ?? '';
  return String(text).trim().slice(0, MAX_DRAFT);
}
