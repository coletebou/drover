// The dialog answer card (drawer Chat and Screen tabs, the waiting window): the question, one button per option
// with the selected one marked, Enter and Esc, built from answer-model.js. A press goes to the dialog the card shows
// (sessions.answer with its hash, tmux.answer on an older daemon); a refusal shows why and the card refreshes.
// A Grok bot's approval request gets the same card with one button per option, answered by the request's id.
import { h } from './dom.js';
import { pressKey, pressedLabel, afterRefusal, announceAnswered, pressApproval, standsFor } from './answer-model.js';

/**
 * A card controller: el, set(model), and press(key). onDone(result, model) after a press that went through;
 * onRefresh() when the card needs a fresh read (a refusal that did not say what is on screen now).
 * call(op, args, { host }) is the quiet call; toast(msg, kind) reports; approve(id, n, { host }) answers an approval
 * request (ui/api.js approvalsAnswer).
 */
export function answerCard({ call, toast, onDone, onRefresh, approve } = {}) {
  const el = h('section', { class: 'answer-card', role: 'group', 'aria-label': 'Answer the dialog', hidden: true });
  let model = null; let busy = null; let reason = null;
  function draw() {
    el.replaceChildren();
    el.hidden = !model;
    if (!model) return;
    el.classList.toggle('held', Boolean(model.held));
    el.classList.toggle('approval', model.mode === 'approval');
    el.classList.toggle('stale', Boolean(model.stale));
    if (model.mode === 'reply') {
      el.append(h('div', { class: 'ac-q' }, h('span', { class: 'dot wait', 'aria-hidden': 'true' }), h('b', null, 'Asked you'), h('span', { class: 'ac-text' }, model.question ?? '')), h('div', { class: 'ac-note' }, 'Answer in the message box below.'));
      return;
    }
    if (model.mode === 'approval') { drawApproval(); return; }
    el.append(h('div', { class: 'ac-q' }, h('span', { class: 'dot wait', 'aria-hidden': 'true' }), h('b', null, model.held ? 'Held message' : 'Needs a decision'), h('span', { class: 'ac-text' }, model.question ?? '')));
    const opts = model.buttons.filter((b) => b.kind === 'option');
    const rest = model.buttons.filter((b) => b.kind !== 'option');
    const button = (b, cls) => h('button', {
      class: `btn ${cls}${b.selected ? ' selected' : ''}`, type: 'button', disabled: busy || model.stale ? true : null, 'aria-pressed': b.kind === 'option' ? (b.selected ? 'true' : 'false') : null,
      title: b.kind === 'option' ? `Press ${b.key}${b.selected ? ' (highlighted now; Enter picks it too)' : ''}` : `Press ${b.key === 'Escape' ? 'Esc' : b.key}${b.hint && b.hint !== b.key ? ` (${b.hint})` : ''}`,
      onclick: (e) => { e.stopPropagation(); press(b.key); },
    }, b.selected ? h('span', { class: 'ac-sel', 'aria-hidden': 'true' }, '❯') : null, b.label, b.hint && b.kind !== 'option' ? h('span', { class: 'ac-hint' }, b.hint) : null, busy === b.key ? h('span', { class: 'ac-hint' }, 'sending') : null);
    if (opts.length) el.append(h('div', { class: 'ac-opts' }, opts.map((b) => button(b, 'ac-opt'))));
    el.append(h('div', { class: 'ac-keys' }, rest.map((b) => button(b, `sm${b.kind === 'confirm' ? ' primary' : ''}`))));
    if (reason || model.reason) el.append(h('div', { class: 'ac-reason', role: 'status' }, `Not sent: ${reason ?? model.reason}.`, model.stale ? h('span', { class: 'muted' }, ' Reading the screen again…') : h('span', { class: 'muted' }, ' This is the screen now.')));
  }
  /** A bot's approval request: its question and details (the bot's words), one button per option, when it expires. */
  function drawApproval() {
    const m = model;
    el.append(h('div', { class: 'ac-q' }, h('span', { class: 'dot wait', 'aria-hidden': 'true' }), h('b', null, m.kind === 'purchase' ? 'Asks to buy' : 'Asks for your approval'), h('span', { class: 'ac-text' }, m.question)));
    if (m.details) el.append(h('div', { class: 'ac-details' }, m.details));
    el.append(h('div', { class: 'ac-opts' }, m.buttons.map((b) => h('button', {
      class: 'btn ac-opt', type: 'button', disabled: busy || m.stale || !m.complete ? true : null, title: `Answer ${b.label}: ${m.bot ?? 'the bot'} is told at once`,
      onclick: (e) => { e.stopPropagation(); press(b.n); },
    }, b.label, busy === b.n ? h('span', { class: 'ac-hint' }, 'sending') : null))));
    const left = standsFor(m.expiresAt);
    el.append(h('div', { class: 'ac-note' }, `Asked by ${m.bot ?? 'a Grok bot'} (a Grok bot: these are its words, check them before you answer).${left ? ` Stands for ${left} more.` : ''}${m.more ? ` ${m.more} more after this one.` : ''}`));
    if (!m.complete) el.append(h('div', { class: 'ac-reason', role: 'status' }, 'This card does not show the whole request; answer it on the board of the machine that keeps the bot.'));
    if (reason) el.append(h('div', { class: 'ac-reason', role: 'status' }, `Not answered: ${reason}.`));
  }
  async function pressOption(n) {
    const m = model;
    busy = n; reason = null; draw();
    try {
      const r = await pressApproval(approve, m, n);
      busy = null;
      toast?.(`${r?.decision?.label ?? 'Answered'}: ${m.bot ?? 'the bot'} ${r?.delivery?.ok === false ? `was not reached (${r.delivery.error ?? 'delivery failed'}); it sees the answer in drover_approvals` : 'is told now'}`, r?.delivery?.ok === false ? 'error' : 'ok', 7000);
      globalThis.document?.dispatchEvent(new CustomEvent('drover:answered', { detail: { host: m.host, approval: m.id } }));
      if (model === m) model = null;
      draw();
      onDone?.(r, m);
      return r;
    } catch (e) {
      busy = null;
      // Already answered (another screen was quicker), withdrawn or expired: the card goes, the board catches up.
      reason = e.message;
      if (e.approval && model === m) model = { ...m, stale: true };
      draw();
      toast?.(`Not answered: ${e.message}`, 'error', 7000);
      if (e.approval) onRefresh?.();
      return null;
    }
  }
  async function press(key) {
    if (model?.mode === 'approval') { if (!busy && !model.stale && model.complete && approve) return pressOption(key); return; }
    if (!model || busy || model.mode !== 'keys' || model.stale) return;
    busy = key; reason = null; draw();
    const m = model;
    try {
      const r = await pressKey(call, m, key, { verify: m.source !== 'screen' });
      busy = null;
      if (r?.refused) {
        const next = afterRefusal(m, r);
        if (model === m) model = next;
        reason = r.reason ?? 'refused';
        toast?.(`Not sent: ${r.reason}`, 'error', 7000);
        draw();
        if (!next || next.stale) onRefresh?.();
        return r;
      }
      toast?.(`${pressedLabel(m, key)}${r?.dialog?.question ? `: ${r.dialog.question}` : ''}`, 'ok');
      announceAnswered(m, key);
      if (model === m) model = null;   // the dialog moved on; the next read shows whatever is next
      draw();
      onDone?.(r, m);
      return r;
    } catch (e) {
      busy = null; reason = e.message; draw();
      toast?.(`Answer: ${e.message}`, 'error');
      return null;
    }
  }
  return {
    el,
    get model() { return model; },
    /** A new reading. The same dialog read again keeps a refusal's reason on the card; another dialog clears it. */
    set(m) { if (busy) return; if (!m || m.question !== model?.question || m.id !== model?.id) reason = null; model = m ?? null; draw(); },
    press,
  };
}
