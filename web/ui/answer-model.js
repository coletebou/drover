// Answering a dialog from the browser: what the card shows and which key each button presses (pure; tested in
// test/ui-answer-model.test.js), and the press itself. A strip from native.board carries dialog, hash, keys and
// answer; a strip built here from fleet.summary (an older daemon) has dialog and hash, and the keys are derived
// the way the daemon derives them. A press goes through sessions.answer with the screen hash the card showed;
// a daemon from before that op gets tmux.answer on the strip's window instead. A refusal is an answer, not an
// error: it says why, and carries the screen as it is now.

export const ANSWER_KEYS = ['Enter', 'Escape', 'Up', 'Down', 'Tab', 'Space', 'y', 'n', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
const KEY_SET = new Set(ANSWER_KEYS);
const KEY_LABEL = { Enter: 'Enter', Escape: 'Esc', Up: '↑', Down: '↓', Tab: 'Tab', Space: 'Space (tick)', y: 'y', n: 'n' };
const YN = /\(y\/n\)|\[Y\/n\]|\[y\/N\]/i;
// A multi-select question draws a box per option (core/native.js answerFields): Space ticks the highlighted one.
const MULTI_SELECT = /^\s*(?:\[[ xX✓✔]?\]|[☐☑☒◯◉●○])/;

/**
 * The keys a dialog takes, in display order: its option digits, y/n only when the screen offers them, Space when its
 * options are boxes to tick, Enter, Esc.
 */
export function deriveKeys({ options = [], held = false, screenText = '' } = {}) {
  if (held) return ['Enter', 'Escape'];
  const keys = options.map((o) => String(o.n)).filter((k) => /^[1-9]$/.test(k));
  const tail = String(screenText).split('\n').slice(-40).join('\n');
  if (YN.test(tail) || /\(y\)/i.test(tail)) keys.push('y');
  if (YN.test(tail) || /\(n\)/i.test(tail)) keys.push('n');
  if (options.some((o) => MULTI_SELECT.test(String(o?.label ?? '')))) keys.push('Space');
  return [...new Set([...keys, 'Enter', 'Escape'])];
}

/**
 * The answer card for a strip (or a screen read), or null when nothing on screen asks for a key.
 * { mode: 'keys', question, held, heldFrom, options, buttons: [{ key, label, kind, selected?, n? }], hash, id, target, host }
 * { mode: 'reply', question } when the agent asked in text (answer: "reply"): the composer answers it.
 */
export function answerModel(s) {
  if (!s) return null;
  // The strip's tail ends with the pane's last line: the idle prompt there means the dialog it names was answered.
  if (Array.isArray(s.tail) && s.tail.length && promptAtBottom(s.tail) && s.answer !== 'reply') return null;
  const dialog = s.dialog ?? null;
  const askText = s.ask?.text ?? s.question ?? null;
  if (s.answer === 'reply') return askText || dialog?.question ? { mode: 'reply', question: dialog?.question ?? askText } : null;
  const keysIn = Array.isArray(s.keys) ? s.keys.filter((k) => KEY_SET.has(k)) : null;
  const onScreen = s.screen === 'dialog' || s.held || (keysIn?.length ?? 0) > 0 || s.answer === 'keys';
  if (!onScreen) return null;
  const options = (dialog?.options ?? s.ask?.options ?? []).filter((o) => Number.isInteger(Number(o?.n)) && o.n >= 1 && o.n <= 9).map((o) => ({ n: Number(o.n), label: String(o.label ?? ''), selected: Boolean(o.selected) })).slice(0, 9);
  const held = Boolean(s.held);
  const keys = keysIn?.length ? keysIn : deriveKeys({ options, held });
  const selected = options.find((o) => o.selected) ?? null;
  const buttons = keys.map((k) => {
    const o = /^[1-9]$/.test(k) ? options.find((x) => String(x.n) === k) : null;
    if (o) return { key: k, label: `${o.n}. ${o.label}`, kind: 'option', n: o.n, selected: o.selected };
    if (/^[1-9]$/.test(k)) return { key: k, label: k, kind: 'option', n: Number(k), selected: false };
    if (k === 'Enter') return { key: k, label: held ? 'Deliver' : 'Enter', hint: held ? 'Enter' : selected ? `picks ${selected.n}` : null, kind: 'confirm' };
    if (k === 'Escape') return { key: k, label: held ? 'Drop' : 'Esc', hint: held ? 'Esc' : null, kind: 'cancel' };
    return { key: k, label: KEY_LABEL[k] ?? k, kind: /^[yn]$/.test(k) ? 'letter' : 'nav' };
  });
  const question = held ? `Held message from another session${s.heldFrom ? ` (${s.heldFrom})` : ''}: deliver or drop it` : dialog?.question ?? askText ?? 'A dialog is open';
  // A prompt the session reports itself (a Hermes approval) is not drawn in its pane: no pane to read before a press, and no tmux.answer fallback.
  return { mode: 'keys', question, held, heldFrom: s.heldFrom ?? null, options, buttons, hash: s.hash ?? null, id: s.kind === 'window' ? (s.tmux ?? s.id) : s.id, target: s.reported ? null : s.tmux ?? null, host: s.host ?? 'local' };
}

/** What a press did, in a few words, for a toast. */
export function pressedLabel(m, key) {
  const b = m?.buttons?.find((x) => x.key === key);
  if (key === 'Enter') return m?.held ? 'delivered' : 'pressed Enter';
  if (key === 'Escape') return m?.held ? 'dropped' : 'cancelled';
  return b?.kind === 'option' ? `picked ${b.label}` : `pressed ${b?.label ?? key}`;
}

export const isUnknownOp = (e) => /unknown op/i.test(String(e?.message ?? e ?? ''));

/**
 * Press one key on the dialog the model describes. call(op, args, { host }) -> result. Returns the daemon's answer:
 * { ok: true, ... } or { ok: false, refused: true, reason, hash, dialog? }. verify (a press from a board strip, whose
 * dialog this page has not read itself) reads the pane first and sends nothing when its bottom is the idle prompt:
 * the daemon reads a dialog left in the scrollback as one still on screen and would take the key for it.
 */
export async function pressKey(call, m, key, { verify = false } = {}) {
  if (!KEY_SET.has(key)) throw new Error(`not a key a dialog takes: ${key}`);
  if (verify && m.target) {
    const cap = await call('tmux.capture', { target: m.target, lines: 60 }, { host: m.host }).catch(() => null);
    if (cap?.text != null && !readScreen(cap.text)) return { ok: false, refused: true, local: true, reason: 'no dialog is on screen any more (the pane shows the prompt)' };
  }
  const expect = m.hash ? { expect: m.hash } : {};
  try { return await call('sessions.answer', { id: m.id, key, ...expect }, { host: m.host }); }
  catch (e) {
    if (!isUnknownOp(e) || !m.target) throw e;
    return call('tmux.answer', { target: m.target, key, ...expect }, { host: m.host });
  }
}

/** Tell the page a press went through (the board marks that dialog Sent until its screen moves on). */
export function announceAnswered(m, key) {
  globalThis.document?.dispatchEvent(new CustomEvent('drover:answered', { detail: { host: m.host ?? 'local', id: m.id ?? null, target: m.target ?? null, hash: m.hash ?? null, key } }));
}

/**
 * After a refusal: the card for the dialog the daemon read then (its hash and its options together), null when no
 * dialog is left, or the old card marked stale (no buttons) when the refusal did not say what is on screen now:
 * a new hash without the dialog it belongs to would let a press land on a dialog the card does not show. What the
 * new screen is comes from the refusal, never from the old card: a held message that gave way to a permission
 * prompt is a permission prompt (the screen the refusal quotes says which; without a quote the screen is the same).
 */
export function afterRefusal(m, r) {
  if (!r?.refused) return m;
  if (!r.dialog?.question && !r.dialog?.options?.length) return /no dialog/i.test(r.reason ?? '') ? null : { ...m, stale: true, reason: r.reason ?? 'refused' };
  const shot = typeof r.preview === 'string' ? readScreen(r.preview) : undefined;
  const held = shot === undefined ? m.held : Boolean(shot?.held);
  const heldFrom = held ? (shot?.heldFrom ?? m.heldFrom) : null;
  const options = r.dialog.options ?? [];
  const next = answerModel({ screen: 'dialog', held, heldFrom, dialog: r.dialog, hash: r.hash ?? null, keys: deriveKeys({ options, held, screenText: r.preview ?? '' }), kind: 'session', id: m.id, tmux: m.target, host: m.host });
  return next ? { ...next, id: m.id, target: m.target, reason: r.reason ?? 'refused' } : null;
}

// ---------------------------------------------------------------- reading a screen (the Screen tab)
// The same reading core/tmux.js does (classifyScreen, heldMessage, dialogSummary, screenHash), so the Screen tab can
// answer a dialog the moment it shows, before the board has seen it. The daemon checks the hash: a reading that
// drifts from the daemon's only makes a press refused, never sent to another dialog. Its patterns take the daemon's
// linear forms too: a long blank run or a run of line breaks in a capture froze the page for seconds.
const OPTION_LIST = /^[^\S\n\r\u2028\u2029]*(?:[❯>›]\s*)?\d\.\s+\S/m;
const DIALOG_PATTERNS = [/Do you want to (proceed|allow|run|make this edit|create|continue)/i, /Run a dynamic workflow\?/i, /Allow .{1,80} to (run|read|write|edit)/i, /\(y\/n\)/i, /\[Y\/n\]/, /\[y\/N\]/, /Enter to confirm/i, /Select an option/i, /Press Enter to continue/i, /Would you like to/i,
  // AskUserQuestion with several questions ends on a review screen: "Review your answers", then 1. Submit answers.
  /Ready to submit your answers\?/i, /Review your answers/i];

// Claude Code's idle prompt footer (core/tmux.js CLAUDE_IDLE). A dialog takes the bottom of its pane, its own footer
// last ("Esc to cancel", "Enter to select"); a pane whose last line is the prompt's footer shows no dialog, whatever
// the lines above hold: tmux keeps answered dialogs in the scrollback a capture reads.
const IDLE_FOOTER = /\? for shortcuts|bypass permissions on|accept edits on|plan mode on/i;
const DIALOG_FOOTER = /Esc to (cancel|drop)|Enter to (select|confirm|deliver)/i;
/** Is the bottom of these pane lines Claude Code's idle prompt (so any dialog above it is an answered one)? */
export function promptAtBottom(lines) {
  const ls = (Array.isArray(lines) ? lines : String(lines ?? '').split('\n')).map((l) => String(l ?? '').trim()).filter(Boolean);
  return IDLE_FOOTER.test(ls.at(-1) ?? '') && !ls.slice(-2).some((l) => DIALOG_FOOTER.test(l));
}

/**
 * { dialog: true, held, heldFrom, question, options, keys } when the screen shows a dialog or a held message, else
 * null. Stricter than core/tmux.js in one way: an idle prompt at the bottom means no dialog (see promptAtBottom).
 */
export function readScreen(text) {
  const s = String(text ?? '');
  if (promptAtBottom(s)) return null;
  const tail = s.split('\n').slice(-40).join('\n');
  const heldOn = /Held message from another session|Another Claude session sent a message/i.test(tail);
  const yn = YN.test(tail);
  const question = DIALOG_PATTERNS.some((re) => re.test(tail));
  const options = OPTION_LIST.test(tail) && /❯|Esc to cancel|Enter to (select|confirm)/i.test(tail);
  const dialogOn = yn || (question && options) || (options && /Esc to cancel/i.test(tail));
  if (!dialogOn && !heldOn) return null;
  const lines = s.split('\n').map((l) => l.replace(/[│╭╮╰╯]/g, '').trimEnd()).filter((l) => l.trim()).slice(-30);
  let qi = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (DIALOG_PATTERNS.some((re) => re.test(lines[i])) || /\?\s*$/.test(lines[i])) { qi = i; break; }
  const opts = [];
  for (const l of lines.slice(qi + 1)) {
    const m = l.match(/^\s*(?:[❯>›]\s*)?(\d)\.\s+(.{1,120})$/);
    if (!m) continue;
    if (opts.some((o) => o.n === Number(m[1]))) opts.length = 0;   // the dialog drawn again (scrollback holds the earlier drawing): keep the latest
    opts.push({ n: Number(m[1]), label: m[2].trim(), selected: /❯|›/.test(l.slice(0, l.indexOf(m[1]))) });
  }
  const heldFrom = heldOn ? tail.match(/sent a message: from ([^\n[(]{1,120})/i)?.[1]?.trim() ?? null : null;
  return { dialog: true, held: heldOn, heldFrom, question: qi >= 0 ? lines[qi].trim().slice(0, 300) : null, options: opts, keys: deriveKeys({ options: opts, held: heldOn, screenText: s }) };
}

/** core/tmux.js screenHash: sha1 of the last 20 non-empty lines, 16 hex chars. */
export async function screenHash(text) {
  const lines = String(text ?? '').trimEnd().split('\n').map((l) => l.trimEnd()).filter((l) => l.trim()).slice(-20);
  const buf = await globalThis.crypto.subtle.digest('SHA-1', new TextEncoder().encode(lines.join('\n')));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}
