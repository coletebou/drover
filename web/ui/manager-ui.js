// The manager, reachable from every view: the header button and `m` bring it up (the dock when the board shows
// it, else a popup that keeps its draft; Esc closes it), and Pop out floats it above every app (Document
// Picture-in-Picture, sharing this page's conversation) or, without that API, in a window of its own.
import { h, clear } from './dom.js';
import { mountManagerChat } from './manager-chat.js';
import { popHash } from './manager-model.js';

export class ManagerUI {
  constructor(ctx, store) {
    this.ctx = ctx; this.store = store; this.docks = new Set(); this.overlay = null; this.pip = null; this.unread = false;
    this.btn = document.getElementById('mgrBtn');
    this.btn?.addEventListener('click', () => this.summon());
    store.on((what, thread) => {
      if (what === 'turns' && thread === store.thread) this.#noteReply();
      this.#paintBtn();
    });
    this.#paintBtn();
  }
  get isOpen() { return Boolean(this.overlay); }
  /** Is the conversation in front of the owner now (the popup, a floating window, the dock or the Manager view)? */
  isShown() { return Boolean(this.pip && !this.pip.win.closed) || (document.visibilityState === 'visible' && Boolean(this.overlay || this.visibleDock())); }
  /** A dock that is on screen now (the board's), if any. */
  visibleDock() { for (const d of this.docks) if (d.visible()) return d; return null; }
  registerDock(d) { this.docks.add(d); this.#paintBtn(); return () => { this.docks.delete(d); this.#paintBtn(); }; }

  /** m and the header button: focus the dock the board shows, else open or close the popup. */
  summon() {
    const d = this.visibleDock();
    if (d && !this.overlay) { d.focus(); return; }
    this.toggle();
  }
  /** Bring the manager up without toggling: the dock when one is on screen, else the popup. */
  show({ host } = {}) {
    if (host) this.store.setHost(host);
    const d = this.visibleDock();
    if (d && !this.overlay) d.focus(); else this.open();
  }
  toggle() { if (this.overlay) this.close(); else this.open(); }
  open({ host } = {}) {
    if (host) this.store.setHost(host);
    this.unread = false; this.#paintBtn();
    if (this.overlay) { this.overlay.chat.focus(); return; }
    const box = h('div', { class: 'mgr-overlay', role: 'dialog', 'aria-label': 'Manager' });
    document.body.append(box);
    const chat = mountManagerChat(box, this.ctx, { store: this.store, variant: 'popup', onClose: () => this.close(), onPopOut: () => { this.close(); this.popOut(); }, autofocus: true });
    this.overlay = { box, chat };
    this.#paintBtn();
  }
  close() {
    if (!this.overlay) return;
    this.overlay.chat.destroy(); this.overlay.box.remove(); this.overlay = null;
    this.#paintBtn();
    this.btn?.focus({ preventScroll: true });
  }

  /** Float the manager: Document PiP (stays above every app) when Chrome has it, else a popup window. */
  async popOut() {
    if ('documentPictureInPicture' in window) {
      try {
        const cur = window.documentPictureInPicture.window;
        if (cur && cur.document.body.dataset.kind === 'manager') { cur.focus(); return cur; }
        cur?.close();
        const pip = await window.documentPictureInPicture.requestWindow({ width: 440, height: 660 });
        for (const link of document.querySelectorAll('link[rel="stylesheet"]')) { const l = pip.document.createElement('link'); l.rel = 'stylesheet'; l.href = link.href; pip.document.head.append(l); }
        if (document.documentElement.dataset.theme) pip.document.documentElement.dataset.theme = document.documentElement.dataset.theme;
        pip.document.title = 'Manager · Drover';
        pip.document.body.classList.add('pip-body', 'mgr-pip-body'); pip.document.body.dataset.kind = 'manager';
        const root = pip.document.createElement('div'); root.className = 'mgr-pip-root'; pip.document.body.append(root);
        const toast = (m, k) => pipToast(pip, m, k);
        const chat = mountManagerChat(root, { ...this.ctx, toast }, { store: this.store, variant: 'pip', autofocus: true });
        this.pip = { win: pip, chat };
        pip.addEventListener('pagehide', () => { chat.destroy(); if (this.pip?.win === pip) this.pip = null; this.#paintBtn(); });
        this.#paintBtn();
        return pip;
      } catch (e) { console.warn('manager pip', e.message); }
    }
    const w = window.open(`/${popHash(this.store.host, this.store.thread)}`, 'drover-manager', 'popup,width=460,height=720');
    if (!w) this.ctx.toast('The browser blocked the pop-out window', 'error');
    return w;
  }

  /** A reply landed while no manager surface is on screen: the header button says so. */
  #noteReply() {
    const last = this.store.turns().at(-1);
    if (!last || last.role !== 'assistant' || last.pending) return;
    if (this.overlay || this.pip || this.visibleDock()) { this.unread = false; return; }
    if (last.ts && Date.now() - Date.parse(last.ts) > 60_000) return;   // an old turn from a read, not a new reply
    this.unread = true;
  }
  #paintBtn() {
    const b = this.btn; if (!b) return;
    const s = this.store.state();
    clear(b);
    b.append(...[h('span', { class: `dot ${s === 'busy' ? 'busy pulse' : s === 'up' ? 'lilac' : s === 'down' ? 'dead' : ''}`, 'aria-hidden': 'true' }), h('span', { class: 'mgr-btn-label' }, 'Manager'), this.unread ? h('span', { class: 'mgr-unread', 'aria-label': 'new reply' }) : null, h('kbd', null, 'm')].filter(Boolean));
    b.setAttribute('aria-pressed', this.overlay ? 'true' : 'false');
    b.title = `The fleet manager (m): ${s === 'busy' ? 'answering' : s}${this.unread ? '; a new reply' : ''}`;
  }
}

function pipToast(pip, msg, kind = 'info') {
  const d = pip.document;
  let box = d.querySelector('.toasts'); if (!box) { box = d.createElement('div'); box.className = 'toasts'; d.body.append(box); }
  const t = d.createElement('div'); t.className = `toast ${kind}`; t.textContent = msg; box.append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 8000 : 3000);
}
