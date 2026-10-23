// DOM helpers for extension pages. Text goes in through textContent only:
// there is no innerHTML anywhere in this extension (test/security.test.js).

/**
 * h('button', { class: 'btn', onclick: fn, 'aria-label': 'Send' }, 'Send')
 * Attributes: `class`, `on<event>` handlers, booleans (true sets, false/null skips), everything else via setAttribute.
 * Children: strings become text nodes; null/false are skipped; arrays are flattened.
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value' && 'value' in el) el.value = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** Remove every child. */
export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

/** Replace an element's children. */
export function render(el, ...children) {
  clear(el);
  append(el, children);
  return el;
}
