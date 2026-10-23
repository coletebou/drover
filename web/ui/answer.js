// The dialog answer card (drawer Chat and Screen tabs, the waiting window): the question, one button per option
// with the selected one marked, Enter and Esc, built from answer-model.js. A press goes to the dialog the card shows
// (sessions.answer with its hash, tmux.answer on an older daemon); a refusal shows why and the card refreshes.
import { h } from './dom.js';
import { pressKey, pressedLabel, afterRefusal, announceAnswered } from './answer-model.js';

/**
 * A card controller: el, set(model), and press(key). onDone(result, model) after a press that went through;
 * onRefresh() when the card needs a fresh read (a refusal that did not say what is on screen now).
 * call(op, args, { host }) is the quiet call; toast(msg, kind) reports.
 */
export function answerCard({ call, toast, onDone, onRefresh } = {}) {
  const el = h('section', { class: 'answer-card', role: 'group', 'aria-label': 'Answer the dialog', hidden: true });
  let model = null; let busy = null; let reason = null;
  function draw() {
    el.replaceChildren();
    el.hidden = !model;
    if (!model) return;
    el.classList.toggle('held', Boolean(model.held));
    el.classList.toggle('stale', Boolean(model.stale));
    if (model.mode === 'reply') {
      el.append(h('div', { class: 'ac-q' }, h('span', { class: 'dot wait', 'aria-hidden': 'true' }), h('b', null, 'Asked you'), h('span', { class: 'ac-text' }, model.question ?? '')), h('div', { class: 'ac-note' }, 'Answer in the message box below.'));
      return;
    }
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
  async function press(key) {
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
    set(m) { if (busy) return; if (!m || m.question !== model?.question) reason = null; model = m ?? null; draw(); },
    press,
  };
}
