// A small popover menu anchored to a button: items [{ label, hint, run, danger, checked, disabled, sep }].
// Closes on choice, outside click, Escape or scroll. Arrow keys move, Enter picks.
import { h } from './dom.js';

let openMenuEl = null;
export function closeMenu() { if (openMenuEl) { openMenuEl.remove(); openMenuEl = null; document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', keys, true); } }
function outside(e) { if (openMenuEl && !openMenuEl.contains(e.target) && !openMenuEl.anchor?.contains(e.target)) closeMenu(); }
function keys(e) {
  if (!openMenuEl) return;
  const items = [...openMenuEl.querySelectorAll('button:not([disabled])')];
  const i = items.indexOf(document.activeElement);
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); const a = openMenuEl.anchor; closeMenu(); a?.focus(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
}

export function openMenu(anchor, items, { label = 'Menu', align = 'right' } = {}) {
  if (openMenuEl?.anchor === anchor) { closeMenu(); return; }
  closeMenu();
  const el = h('div', { class: 'menu', role: 'menu', 'aria-label': label });
  for (const it of items) {
    if (!it) continue;
    if (it.sep) { el.append(h('div', { class: 'menu-sep', role: 'separator' }, it.label ?? '')); continue; }
    el.append(h('button', {
      type: 'button', role: it.checked === undefined ? 'menuitem' : 'menuitemcheckbox', 'aria-checked': it.checked === undefined ? null : String(Boolean(it.checked)), class: it.danger ? 'danger' : null, disabled: it.disabled ? true : null,
      onclick: async () => { closeMenu(); try { await it.run?.(); } catch (e) { console.error(e); } },
    }, h('span', { class: 'mi-label' }, it.checked !== undefined ? h('span', { class: 'mi-check', 'aria-hidden': 'true' }, it.checked ? '●' : '○') : null, it.label), it.hint ? h('span', { class: 'mi-hint' }, it.hint) : null));
  }
  document.body.append(el);
  el.anchor = anchor; openMenuEl = el;
  const r = anchor.getBoundingClientRect();
  const w = Math.min(320, window.innerWidth - 16);
  el.style.minWidth = Math.min(w, Math.max(220, r.width)) + 'px';
  const left = align === 'right' ? Math.max(8, Math.min(window.innerWidth - el.offsetWidth - 8, r.right - el.offsetWidth)) : Math.max(8, Math.min(window.innerWidth - el.offsetWidth - 8, r.left));
  const below = r.bottom + 6 + el.offsetHeight < window.innerHeight;
  el.style.left = left + 'px';
  el.style.top = (below ? r.bottom + 6 : Math.max(8, r.top - el.offsetHeight - 6)) + 'px';
  setTimeout(() => { document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', keys, true); el.querySelector('button:not([disabled])')?.focus(); }, 0);
}
