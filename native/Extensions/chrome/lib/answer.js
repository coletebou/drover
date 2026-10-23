// Dialog answers (UX overhaul contract): one button per key the daemon listed for a waiting item, board strip
// or alert, pressed with sessions.answer and the screen hash the client showed. Pure: no chrome.*, no DOM.
// Never a fixed y/n chip: Claude Code dialogs ignore y and n since 2.1.280, so a key the daemon did not list
// presses nothing.

export const PRESSABLE = Object.freeze(['Enter', 'Escape', 'Up', 'Down', 'Tab', 'Space', 'y', 'n', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
const PRESS = new Set(PRESSABLE);

/** "Esc" for Escape, the key itself otherwise. */
export const keyName = (k) => (k === 'Escape' ? 'Esc' : String(k));

/**
 * A button-sized option label; the tooltip keeps the full one. Drops notes and keyboard hints in parentheses,
 * Claude Code's "and tell Claude what to do differently" tail and a trailing "for ..." scope, then cuts on a
 * word boundary: "Yes, and don't ask again for npm test commands in ~/x" is "Yes, don't ask again".
 */
export function shortLabel(raw, max = 26) {
  const original = String(raw ?? '').replace(/\s+/g, ' ').trim();
  let s = original.replace(/\s*\([^)]*\)/g, '');
  s = s.replace(/,?\s*(and )?tell Claude what to do differently/i, '');
  s = s.replace(/, and /g, ', ');
  const f = s.search(/ for /i);
  if (f > 0) s = s.slice(0, f);
  s = s.replace(/^[\s,.;:]+|[\s,.;:]+$/g, '');
  if (!s) s = original;
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max / 2 ? cut.slice(0, sp) : cut).replace(/[\s,.;:]+$/, '')}…`;
}

/** The dialog fields from a raw item (summary waiting item, board strip, alert), validated. */
export function dialogFields(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const d = r.dialog && typeof r.dialog === 'object' ? r.dialog : null;
  const options = Array.isArray(d?.options)
    ? d.options.map((o) => ({ n: Number(o?.n), label: typeof o?.label === 'string' ? o.label : '', selected: o?.selected === true }))
      .filter((o) => Number.isInteger(o.n) && o.n >= 1 && o.n <= 9).slice(0, 9)
    : [];
  const out = {};
  if (d) out.dialog = { question: typeof d.question === 'string' && d.question ? d.question : null, options };
  if (typeof r.hash === 'string' && r.hash) out.hash = r.hash;
  if (Array.isArray(r.keys)) out.keys = [...new Set(r.keys.filter((k) => typeof k === 'string' && PRESS.has(k)))];
  if (r.answer === 'keys' || r.answer === 'reply') out.answer = r.answer;
  return out;
}

/**
 * What an item offers: `keys` (buttons), `reply` (the agent asked in text) or `none` (a daemon from before
 * dialog keys, a dialog without usable keys, or keys without the screen hash they were listed for, which a press
 * could not be checked against: Open and Reply only).
 * @returns {{mode:'keys'|'reply'|'none', question:string|null, buttons:{key:string,title:string,help:string,label:string,selected:boolean,role:string}[]}}
 */
export function answerPlan(item, { supported = true, maxLabel = 26 } = {}) {
  const f = dialogFields(item);
  if (f.answer === 'reply') return { mode: 'reply', question: null, buttons: [] };
  if (!supported || !f.keys?.length || !f.hash) return { mode: 'none', question: null, buttons: [] };
  const options = f.dialog?.options ?? [];
  const selected = options.find((o) => o.selected);
  const buttons = f.keys.map((key) => {
    if (/^[1-9]$/.test(key)) {
      const o = options.find((x) => String(x.n) === key);
      if (o) {
        const full = o.label.trim();
        const short = shortLabel(full, maxLabel);
        return { key, title: short ? `${key} ${short}` : key, help: full ? `${key}. ${full}` : `Press ${key}`, label: full ? `Answer ${key}, ${full}` : `Answer ${key}`, selected: o.selected, role: 'option' };
      }
      return { key, title: key, help: `Press ${key}`, label: `Answer ${key}`, selected: false, role: 'option' };
    }
    if (key === 'Enter') return { key, title: 'Enter', help: selected ? `Press Enter: ${selected.n}. ${selected.label}` : 'Press Enter on this dialog', label: 'Press Enter', selected: false, role: 'enter' };
    if (key === 'Escape') return { key, title: 'Esc', help: 'Press Escape: cancel the dialog', label: 'Press Escape', selected: false, role: 'escape' };
    if (key === 'y' || key === 'n') return { key, title: key, help: `Press ${key}`, label: key === 'y' ? 'Answer yes' : 'Answer no', selected: false, role: 'letter' };
    // A multi-select question (its options are boxes): Space ticks the highlighted one, Enter submits.
    if (key === 'Space') return { key, title: 'Space (tick)', help: 'Press Space: tick the highlighted option', label: 'Press Space to tick the highlighted option', selected: false, role: 'other' };
    const glyph = { Up: '↑', Down: '↓' }[key] ?? key;
    return { key, title: glyph, help: `Press ${key}`, label: `Press ${key}`, selected: false, role: 'other' };
  });
  return { mode: 'keys', question: f.dialog?.question ?? null, buttons };
}

/** Did the daemon answer "unknown op <op>"? */
export function isUnknownOp(err, op) {
  return typeof err?.message === 'string' && err.message.startsWith(`unknown op ${op}`);
}

/** A press outcome as a row shows it: `{ ok, refused, unsupported, message }`. */
export function answerOutcome(res, key) {
  if (res?.ok === true) return { ok: true, refused: false, unsupported: false, message: `Sent ${keyName(res.key ?? key)}.` };
  const reason = String(res?.reason ?? '').trim().replace(/[\s.]+$/, '') || 'the dialog changed, look again';
  return { ok: false, refused: true, unsupported: false, message: `Not sent: ${reason}.` };
}

export const UNSUPPORTED = Object.freeze({ ok: false, refused: false, unsupported: true, message: 'This Drover cannot answer dialogs yet. Open the session to answer.' });

/**
 * Press `key` on `item`'s dialog: sessions.answer `{id, host, key, expect: hash, actor}`. On "unknown op" (a daemon
 * from before the op) a board strip, which carries its tmux window, falls back to tmux.answer on that window with
 * the same hash; a summary item has no window, so it is unsupported. Only a key the item lists is ever sent, and
 * only with the screen hash: without one the press could land on another dialog.
 * @param {{op: Function}} client lib/api.js client
 */
export async function pressKey(client, item, key, { actor = 'chrome' } = {}) {
  const f = dialogFields(item);
  if (!f.keys?.includes(key)) throw new Error(`${keyName(key)} is not a key this dialog takes.`);
  if (!f.hash) throw new Error('This dialog has no screen hash to check the press against. Open the session to answer.');
  const host = item.host || 'local';
  const args = { id: item.sessionId ?? item.id, host, key, actor, expect: f.hash };
  try {
    return answerOutcome(await client.op('sessions.answer', args), key);
  } catch (e) {
    if (!isUnknownOp(e, 'sessions.answer')) throw e;
    if (!item.tmux) return UNSUPPORTED;
    return answerOutcome(await client.op('tmux.answer', { target: item.tmux, key, host, actor, expect: f.hash }), key);
  }
}
