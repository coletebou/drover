// The chat list the drawer and the manager share: display items from chat-model.js rendered by key, so an update
// touches only what changed (a new turn, a result arriving, a reply growing) and an expanded tool group or a
// "show all" stays open across updates. Assistant text is Markdown (markdown.js); everything else is text.
import { h, fmtTime } from './dom.js';
import { renderMarkdown } from './markdown.js';
import { copyButton } from './clip.js';
import { itemSig, headOf, toolName, receiptLine } from './chat-model.js';
import { isOwner } from './owner.js';

const USER_LINES = 24;      // a long paste shows its head; "show all" for the rest
const RESULT_LINES = 6;

export class ChatView {
  /** assistantLabel: what replies are called ("assistant", "manager"); onRetry(turn): resend a failed echo. */
  constructor({ assistantLabel = 'assistant', onRetry = null } = {}) {
    this.el = h('div', { class: 'turns', role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions' });
    this.nodes = new Map();   // item key -> { el, sig }
    this.open = new Set();    // expanded tool groups
    this.full = new Set();    // calls and long turns shown in full
    this.assistantLabel = assistantLabel; this.onRetry = onRetry;
    this.tail = h('div', { class: 'turns-tail' });
    this.el.append(this.tail);
    this.items = [];
  }
  /** Render items in order; only items whose signature changed are rebuilt. Returns how many were (re)built. */
  update(items, { working = false, workingText = 'working', empty = null } = {}) {
    this.items = items;
    const keep = new Set(); let built = 0;
    let prev = null;
    for (const it of items) {
      keep.add(it.key);
      const sig = `${itemSig(it)}|${this.#viewSig(it)}`;
      let n = this.nodes.get(it.key);
      if (!n || n.sig !== sig) {
        const el = this.#render(it); built++;
        if (n) n.el.replaceWith(el);
        n = { el, sig }; this.nodes.set(it.key, n);
      }
      const want = prev ? prev.nextSibling : this.el.firstChild;
      if (want !== n.el) this.el.insertBefore(n.el, want);
      prev = n.el;
    }
    for (const [k, n] of this.nodes) if (!keep.has(k)) { n.el.remove(); this.nodes.delete(k); }
    this.tail.replaceChildren(...(items.length || !empty ? [] : [empty]), ...(working ? [h('div', { class: 'working' }, h('span', { class: 'dot busy pulse', 'aria-hidden': 'true' }), workingText)] : []));
    this.el.append(this.tail);
    // A reply that streams is rebuilt per delta: a screen reader hears it once it is whole.
    this.el.setAttribute('aria-busy', items.some((i) => i.pending) ? 'true' : 'false');
    return built;
  }
  #viewSig(it) {
    if (it.kind === 'tools') return `${this.open.has(it.key) ? 1 : 0}${it.calls.map((c) => (this.full.has(c.key) ? 1 : 0)).join('')}`;
    return this.full.has(it.key) ? 'full' : '';
  }
  /** Rebuild one item after a click (expand, show all), from its latest version. */
  #rerender(stale) {
    const it = this.items.find((x) => x.key === stale.key) ?? stale;
    const n = this.nodes.get(it.key); if (!n) return;
    const el = this.#render(it); n.el.replaceWith(el); n.el = el; n.sig = `${itemSig(it)}|${this.#viewSig(it)}`;
  }

  #who(label, it, extra) {
    const ts = it.turn?.ts ? h('time', { datetime: String(it.turn.ts), title: new Date(it.turn.ts).toLocaleString() }, fmtTime(it.turn.ts)) : null;
    const copy = it.text?.trim() ? copyButton(it.text, 'Copy', { cls: 'sm quiet turn-copy', title: 'Copy this turn' }) : null;
    return h('div', { class: 'who' }, h('b', null, label), extra ?? null, copy, ts);
  }
  #render(it) {
    switch (it.kind) {
      case 'user': return this.#user(it);
      case 'assistant': return this.#assistant(it);
      case 'tools': return this.#tools(it);
      case 'result': return h('div', { class: 'turn result' }, this.#who('result', it, h('span', null, [it.turn.cost != null ? `$${Number(it.turn.cost).toFixed(3)}` : null, it.turn.turns != null ? `${it.turn.turns} turns` : null].filter(Boolean).join('  '))), h('div', { class: 'text' }, it.text));
      default: return this.#system(it);
    }
  }
  #user(it) {
    const long = !this.full.has(it.key) && it.text.split('\n').length > USER_LINES;
    const shown = long ? it.text.split('\n').slice(0, USER_LINES).join('\n') : it.text;
    const extra = it.failed ? h('span', { class: 'state-brick' }, 'not sent') : it.local ? h('span', null, 'sending') : it.via === 'peer' ? h('span', null, 'another session') : null;
    return h('div', { class: `turn user${it.local ? ' local' : ''}${it.failed ? ' failed' : ''}${!isOwner(it.actor) ? ' other' : ''}${it.meta ? ' meta' : ''}` },
      this.#who(it.label, it, extra),
      h('div', { class: 'text' }, shown),
      long ? h('button', { class: 'btn sm quiet more', type: 'button', onclick: () => { this.full.add(it.key); this.#rerender(it); } }, `show all ${it.text.split('\n').length} lines`) : null,
      it.failed ? h('div', { class: 'turn-err' }, `Not sent: ${it.failed}`, this.onRetry ? h('button', { class: 'btn sm', type: 'button', onclick: () => this.onRetry(it.turn) }, 'Send again') : null) : null,
      this.#receipt(it));
  }
  /** A Grok bot thread's read receipt under a turn (chat-model.js receiptLine), or nothing. */
  #receipt(it) {
    const line = it.receipt ? receiptLine(it.receipt, { name: this.assistantLabel, you: isOwner, at: (ts) => (ts ? fmtTime(ts) : '') }) : null;
    return line ? h('div', { class: `receipt${it.receipt.state === 'read' || it.receipt.state === 'answered' ? ' done' : ''}` }, line) : null;
  }
  #assistant(it) {
    const body = it.text.trim() ? renderMarkdown(it.text, { codeTools: (code) => copyButton(code, 'Copy', { cls: 'sm quiet md-copy', title: 'Copy this code' }) }) : null;
    if (body && it.pending) body.classList.add('streaming');
    return h('div', { class: `turn assistant${it.pending ? ' writing' : ''}${it.error ? ' failed' : ''}` },
      this.#who(this.assistantLabel, it, it.model ? h('span', null, it.model) : null),
      body ? h('div', { class: 'text' }, body) : it.pending ? h('div', { class: 'text typing', 'aria-label': 'writing' }, h('span'), h('span'), h('span')) : null,
      it.error ? h('div', { class: 'turn-err' }, it.error) : null,
      this.#receipt(it));
  }
  #tools(it) {
    const open = this.open.has(it.key);
    const running = it.calls.at(-1) && !it.calls.at(-1).result ? it.calls.at(-1) : null;
    const head = h('button', { class: 'tg-head', type: 'button', 'aria-expanded': open ? 'true' : 'false', onclick: () => { if (this.open.has(it.key)) this.open.delete(it.key); else this.open.add(it.key); this.#rerender(it); } },
      h('span', { class: 'tg-caret', 'aria-hidden': 'true' }, open ? '▾' : '▸'),
      h('span', { class: 'tg-line' }, it.line || 'Used tools'),
      it.errors ? h('span', { class: 'tg-err' }, `${it.errors} failed`) : null,
      !open && running ? h('span', { class: 'tg-now trunc' }, `${toolName(running.name)}${running.summary ? `: ${running.summary}` : ''}`) : null,
      it.ts ? h('time', { datetime: String(it.ts) }, fmtTime(it.ts)) : null);
    return h('div', { class: `turn tools${it.errors ? ' has-err' : ''}` }, head, open ? h('div', { class: 'tg-calls' }, it.calls.map((c) => this.#call(c, it))) : null);
  }
  #call(c, it) {
    const full = this.full.has(c.key);
    const out = c.result ? (full ? { head: c.result.text, more: false } : headOf(c.result.text, { lines: RESULT_LINES })) : null;
    const total = c.result?.chars && c.result.chars > c.result.text.length ? ` (${c.result.text.length.toLocaleString()} of ${c.result.chars.toLocaleString()} characters)` : '';
    return h('div', { class: `tc${c.result?.isError ? ' err' : ''}${c.result ? '' : ' waiting'}` },
      h('div', { class: 'tc-head' }, h('span', { class: 'tc-name' }, toolName(c.name)), c.summary ? h('span', { class: 'tc-sum', title: c.summary }, c.summary) : null, c.result?.isError ? h('span', { class: 'tc-flag' }, 'error') : !c.result ? h('span', { class: 'tc-flag quiet' }, 'no result yet') : null),
      c.description ? h('div', { class: 'tc-desc' }, c.description) : null,
      out && out.head ? h('pre', { class: 'tc-out' }, out.head) : c.result ? h('div', { class: 'tc-desc' }, 'no output') : null,
      out?.more ? h('button', { class: 'btn sm quiet more', type: 'button', onclick: () => { this.full.add(c.key); this.#rerender(it); } }, `show all${total}`) : full && total ? h('div', { class: 'tc-desc' }, `cut by the daemon${total}`) : null);
  }
  #system(it) {
    if (it.sub === 'stdout') return h('div', { class: 'turn system' }, h('pre', { class: 'tc-out' }, it.text));
    if (it.sub === 'command') return h('div', { class: 'turn system' }, h('span', { class: 'mono' }, it.text));
    return h('div', { class: `turn system${it.turn?.local ? ' local' : ''}${it.error ? ' error' : ''}` }, it.text);
  }
}

/** Is a scrolling element at (or near) its bottom? Measured before an update, so new turns keep it there. */
export function atBottom(el, slack = 80) { return !el || el.scrollHeight - el.scrollTop - el.clientHeight < slack; }
