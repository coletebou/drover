// The answer buttons of a waiting item (lib/answer.js answerPlan), shared by the popup rows and the side panel's
// answer card. Each button presses its own key with sessions.answer, on the screen the page showed.
import { h } from './dom.js';

/**
 * @param {{mode:string, buttons:any[]}} plan
 * @param {{ busy?: string|null, disabled?: boolean, onPress: (key: string) => void }} o
 */
export function answerButtons(plan, { busy = null, disabled = false, onPress }) {
  if (plan.mode !== 'keys' || !plan.buttons.length) return null;
  return h('div', { class: 'keys', role: 'group', 'aria-label': 'Answer the dialog' }, plan.buttons.map((b) =>
    h('button', {
      type: 'button',
      class: `key${b.selected ? ' sel' : ''}${b.role === 'escape' ? ' esc' : ''}`,
      title: b.help,
      'aria-label': b.label,
      'aria-describedby': null,
      disabled: disabled || Boolean(busy),
      'data-key': b.key,
      onclick: () => onPress(b.key),
    }, b.selected ? h('span', { class: 'mark', 'aria-hidden': 'true' }, '›') : null, b.title, busy === b.key ? h('span', { class: 'sr-only' }, ' sending') : null)));
}

/** The outcome line under the buttons: sending, sent, refused or an error. */
export function answerStatus(st) {
  if (!st) return null;
  if (st.pressing) return h('div', { class: 'answer-status', role: 'status', 'aria-live': 'polite' }, `Sending ${st.pressing === 'Escape' ? 'Esc' : st.pressing}`);
  if (!st.message) return null;
  return h('div', { class: `answer-status ${st.error ? 'err' : 'ok'}`, role: 'status', 'aria-live': 'polite' }, st.message);
}
