// "Waiting on you": a small always-on-top board of every session that needs
// the owner, with the question, one button per key the dialog takes (sent only to the
// dialog that was read: sessions.answer with its screen hash, tmux.answer on an
// older daemon), one button per option of a Grok bot's approval request, a reply box
// for agents that asked, and Open (back to the main window, drawer open).
//
// Opens in a Document Picture-in-Picture window when Chrome has the API (it
// floats above every app), else in a small popup on #/pip. Either way it is
// rendered by this module from the same strips the board uses.
import { h, clear, engine, ago, btn, empty } from './dom.js';
import { waitingStrips, finishedStrips } from './strips.js';
import { answerModel, pressKey, pressedLabel, announceAnswered, pressApproval, oneTap, approvalToast } from './answer-model.js';

/** Render the waiting list into `root`; returns { update(), destroy() }. */
export function mountWaiting(root, ctx, { compact = true, onOpen } = {}) {
  const head = h('div', { class: 'pip-head' }, h('h2', null, 'Waiting on you'), h('span', { class: 'count' }), h('span', { class: 'spacer' }), h('span', { class: 'muted small pip-ts' }));
  const list = h('div', { class: 'pip-list' });
  root.append(head, list);
  const drafts = new Map(); // key -> text typed in a reply box (kept across repaints)
  let busy = new Set();
  // A press that went through: no buttons for that dialog until the strip shows the screen moved on (as on the board).
  const sent = new Map();   // strip key -> { hash, at }
  const dialogWords = (s) => JSON.stringify([s.dialog?.question ?? s.ask?.text ?? null, (s.dialog?.options ?? []).map((o) => o.label)]);
  const sentFor = (s) => { const x = sent.get(s.key); return Boolean(x && Date.now() - x.at < 6000 && (x.approval ? x.approval === s.approval?.id : (x.hash && x.hash === s.hash) || x.words === dialogWords(s))); };

  async function answer(s, m, key) {
    busy.add(s.key); paint();
    try {
      const r = await pressKey((op, args, opts) => ctx.callQuiet(op, args, opts), m, key, { verify: true });
      if (r.refused) ctx.toast(`${s.name}: not sent, ${r.reason}`, 'error', 7000);
      else { ctx.toast(`${s.name}: ${pressedLabel(m, key)}`, 'ok'); sent.set(s.key, { hash: m.hash, words: dialogWords(s), at: Date.now() }); setTimeout(paint, 6100); announceAnswered(m, key); }
    } catch (e) { ctx.toast(`${s.name}: ${e.message}`, 'error'); }
    busy.delete(s.key); paint();
  }
  /** A bot's approval request: option n, answered by the request's id on the host that keeps the bot. */
  async function decide(s, m, n) {
    busy.add(s.key); paint();
    try {
      const r = await pressApproval(ctx.answerApproval, m, n);
      const [text, kind] = approvalToast(s.name, r);
      ctx.toast(text, kind, 6000);
      sent.set(s.key, { approval: m.id, at: Date.now() }); setTimeout(paint, 6100);
      globalThis.document?.dispatchEvent(new CustomEvent('drover:answered', { detail: { host: m.host, approval: m.id } }));
    } catch (e) { ctx.toast(`${s.name}: not answered, ${e.message}`, 'error', 7000); }
    busy.delete(s.key); paint();
  }
  async function reply(s, text) {
    if (!text.trim()) return;
    busy.add(s.key); paint();
    try { await ctx.callQuiet('sessions.message', { id: s.sessionId, text }, { host: s.host }); drafts.delete(s.key); ctx.toast(`Sent to ${s.name}`, 'ok'); }
    catch (e) { ctx.toast(`${s.name}: ${e.message}`, 'error'); }
    busy.delete(s.key); paint();
  }

  function item(s) {
    const m = answerModel(s);
    const isDialog = m?.mode === 'keys' && (s.tmux || s.id);
    const card = h('article', { class: `pip-item strip amber${busy.has(s.key) ? ' faded' : ''}` },
      h('div', { class: 'title' }, engine(s.engine), h('span', { class: 'name' }, s.name), h('span', { class: 'spacer' }), s.since ? h('span', { class: 'age' }, ago(s.since)) : null),
      h('div', { class: 'where' }, [s.host !== 'local' ? s.host : null, s.tmux].filter(Boolean).join('  ')),
      s.ask ? h('div', { class: 'ask-label' }, s.ask.label) : null,
      h('div', { class: s.answer === 'approval' ? 'tail whole' : 'tail' }, s.ask?.text || s.question || (s.tail ?? []).join('\n')));
    const acts = h('div', { class: 'pip-acts' });
    if (m?.mode === 'approval') {
      // Never the reply box: a message would reach the bot, but answer nothing.
      if (sentFor(s)) acts.append(h('span', { class: 'muted small' }, 'Answered; telling the bot'));
      else if (!oneTap(m)) acts.append(h('span', { class: 'muted small' }, 'Has details: Open to read them and answer'));
      else for (const b of m.buttons) acts.append(btn(b.label, () => decide(s, m, b.n), { cls: 'sm', disabled: busy.has(s.key), title: `Answer ${b.label}` }));
    } else if (isDialog && sentFor(s)) acts.append(h('span', { class: 'muted small' }, 'Sent; waiting for the screen to move on'));
    else if (isDialog) {
      // One button per key this dialog takes (its options, Enter, Esc), sent only to the dialog shown here.
      for (const b of m.buttons) acts.append(btn(b.label, () => answer(s, m, b.key), { cls: `sm${b.selected ? ' selected' : ''}${b.kind === 'confirm' ? ' primary' : ''}`, disabled: busy.has(s.key), title: b.kind === 'option' ? `Pick option ${b.n}` : `Press ${b.key === 'Escape' ? 'Esc' : b.key}${b.hint ? ` (${b.hint})` : ''}, only if it is still the dialog shown here` }));
    } else if (s.sessionId) {
      const ta = h('input', { type: 'text', placeholder: `Reply to ${s.name}`, value: drafts.get(s.key) ?? '', 'aria-label': `Reply to ${s.name}`, oninput: (e) => drafts.set(s.key, e.target.value), onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); reply(s, e.target.value); } } });
      acts.append(ta, btn('Send', () => reply(s, ta.value), { cls: 'sm primary', disabled: busy.has(s.key) }));
    }
    acts.append(btn('Open', () => { onOpen?.(s); }, { cls: 'sm quiet', title: 'Open this session in the main window' }));
    card.append(acts);
    return card;
  }

  function paint() {
    const ms = (v) => (typeof v === 'number' ? (v < 1e11 ? v * 1000 : v) : Date.parse(v ?? '') || 0);
    const items = waitingStrips(ctx.state).sort((a, b) => ms(b.since) - ms(a.since));
    const focused = root.ownerDocument.activeElement;
    const keepFocus = focused?.tagName === 'INPUT' ? focused.getAttribute('aria-label') : null;
    clear(list);
    head.querySelector('.count').textContent = items.length ? String(items.length) : '';
    head.querySelector('.pip-ts').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (!items.length) list.append(empty('Nothing needs you', compact ? 'This window stays on top and fills in when an agent asks.' : ''));
    for (const s of items) list.append(item(s));
    // Quieter: who finished in the last hour (nothing pending), with the end of the reply.
    const done = finishedStrips(ctx.state);
    if (done.length) {
      list.append(h('div', { class: 'pip-sub' }, h('h3', null, 'Finished'), h('span', { class: 'muted small' }, 'no question pending')));
      for (const s of done.slice(0, 12)) list.append(h('article', { class: 'pip-item strip moss quiet' },
        h('div', { class: 'title' }, engine(s.engine), h('span', { class: 'name' }, s.name), h('span', { class: 'spacer' }), h('span', { class: 'age' }, ago(s.finished.ts))),
        h('div', { class: 'tail' }, s.finished.text || 'finished'),
        h('div', { class: 'pip-acts' }, btn('Open', () => onOpen?.(s), { cls: 'sm quiet' }))));
    }
    if (keepFocus) { const el = [...list.querySelectorAll('input')].find((x) => x.getAttribute('aria-label') === keepFocus); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }
  }
  paint();
  return { update: paint, destroy() { clear(root); } };
}

/** Open the waiting board in Document PiP (or a popup). Returns the window. */
export async function openWaitingWindow(ctx) {
  if ('documentPictureInPicture' in window) {
    // One floating window per page: the manager's (manager-ui.js) gives way to the waiting board, and back.
    const cur = window.documentPictureInPicture.window;
    if (cur && cur.document.body.dataset.kind !== 'manager') { cur.focus(); return cur; }
    cur?.close();
    const pip = await window.documentPictureInPicture.requestWindow({ width: 400, height: 560 });
    pip.document.body.dataset.kind = 'waiting';
    // Same stylesheet and theme as the main page.
    for (const link of document.querySelectorAll('link[rel="stylesheet"]')) { const l = pip.document.createElement('link'); l.rel = 'stylesheet'; l.href = link.href; pip.document.head.append(l); }
    if (document.documentElement.dataset.theme) pip.document.documentElement.dataset.theme = document.documentElement.dataset.theme;
    pip.document.title = 'Waiting on you';
    pip.document.body.classList.add('pip-body');
    const root = pip.document.createElement('div'); root.className = 'pip-root';
    pip.document.body.append(root);
    const view = mountWaiting(root, { ...ctx, toast: (m, k) => pipToast(pip, m, k) }, { onOpen: (s) => { try { window.focus(); } catch { /* the opener may refuse focus */ } ctx.open({ kind: s.kind, id: s.id, host: s.host, engine: s.engine, name: s.name, tmux: s.tmux, sessionId: s.sessionId }); } });
    const onFleet = () => view.update();
    window.addEventListener('drover:fleet', onFleet);
    const tick = setInterval(onFleet, 15_000);
    pip.addEventListener('pagehide', () => { window.removeEventListener('drover:fleet', onFleet); clearInterval(tick); });
    return pip;
  }
  const w = window.open('/#/pip', 'drover-waiting', 'popup,width=400,height=600');
  if (!w) throw new Error('The browser blocked the popup');
  return w;
}

function pipToast(pip, msg, kind = 'info') {
  const d = pip.document;
  let box = d.querySelector('.toasts'); if (!box) { box = d.createElement('div'); box.className = 'toasts'; d.body.append(box); }
  const t = d.createElement('div'); t.className = `toast ${kind}`; t.textContent = msg; box.append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 8000 : 3000);
}
