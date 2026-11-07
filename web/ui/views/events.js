// Events: the tail of the truth file (front host), newest first, as a timeline
// grouped by day. Chips filter by type; a row expands to the raw JSON.
import { h, clear, chip, seg, toDate, matchQ, empty, loading, debounce, btn, plural, shortPath } from '../dom.js';
import { receiptText, approvalText } from '../chat-model.js';

const LOCAL = { host: 'local' };

/** One-line human summary of an event. */
export function summarizeEvent(e) {
  let s;
  switch (e.type) {
    case 'feature': s = [e.fid, e.state, e.title].filter(Boolean).join(' / '); break;
    case 'note': s = `${e.about}: ${e.text ?? ''}`; break;
    // An agent's own report (a Grok bot through the bot gateway): its name, state and what it says it is doing.
    case 'status': s = `${e.name ?? e.agent} ${e.state}${e.summary ? `: ${e.summary}` : ''}`; break;
    case 'receipt': s = receiptText(e); break;
    case 'approval': s = approvalText(e); break;
    case 'pin': case 'unpin': s = String(e.target ?? ''); break;
    case 'message': case 'chat': {
      const to = e.to ?? {};
      const d = e.delivery ? (e.delivery.ok ? ' (delivered)' : ` (failed: ${e.delivery.error ?? 'unknown'})`) : '';
      s = `to ${to.kind ?? '?'} ${to.name ?? to.id ?? ''}${d}: ${e.text ?? ''}`; break;
    }
    case 'launch': s = `${e.engine} ${e.mode} ${e.profile ?? ''}${e.model ? ' ' + e.model : ''} in ${e.cwd ?? ''} -> ${e.result?.tmux ?? e.result?.headlessId ?? ''}`; break;
    case 'survey': s = `${e.count} items from ${e.file}`; break;
    case 'survey-item': s = `${e.item?.host ?? ''} ${e.item?.title ?? e.item?.id ?? ''} (${e.item?.state ?? ''})`; break;
    case 'handoff': s = `${e.path} ${e.sha256?.slice(0, 12) ?? ''}`; break;
    default: s = JSON.stringify(e);
  }
  s = String(s).replace(/\s+/g, ' ');
  return s.length > 220 ? s.slice(0, 217) + '...' : s;
}

function dayLabel(d) {
  const now = new Date(); const y = new Date(); y.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}
const clock = (d) => (d ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');

/** A timeline row; click (or Enter) toggles the pretty JSON underneath. */
export function eventRow(e) {
  const d = toDate(e.ts);
  const pre = h('pre', { hidden: true, style: { gridColumn: '1 / -1' } }, JSON.stringify(e, null, 2));
  const toggle = () => { pre.hidden = !pre.hidden; row.setAttribute('aria-expanded', pre.hidden ? 'false' : 'true'); };
  const row = h('div', { class: 'tl', tabindex: 0, role: 'button', 'aria-expanded': 'false', style: { cursor: 'pointer' }, onclick: toggle, onkeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } } },
    h('time', { datetime: d?.toISOString() ?? '', title: d?.toLocaleString() ?? String(e.ts ?? '') }, clock(d)),
    h('span', { class: 'type' }, e.type ?? '?'),
    h('span', { class: 'what' }, summarizeEvent(e), h('span', { class: 'faint small' }, '  ', [e.actor, e.host].filter(Boolean).join(' on '))),
    pre);
  return row;
}

export default {
  id: 'events', label: 'Events', key: 'e',
  mount(root, ctx) {
    let events = []; let q = ''; let alive = true; let typeFilter = ''; let limit = 300; let info = null;
    const meta = h('span', { class: 'muted small' });
    const fileEl = h('span', { class: 'faint small mono' });
    const head = h('div', { class: 'view-head' }, h('h1', null, 'Events'), meta, fileEl, h('span', { class: 'spacer' }),
      seg([[300, 'last 300'], [1000, '1000'], [5000, '5000']], limit, (v) => { limit = v; load(); }), btn('Refresh', () => load(), { cls: 'sm' }));
    const chipsEl = h('div', { class: 'chips' });
    const list = h('div', { class: 'timeline' });
    root.append(head, h('div', { class: 'toolbar' }, chipsEl), list);

    function render() {
      if (!alive) return;
      const counts = {};
      for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1;
      clear(chipsEl);
      chipsEl.append(chip(`all ${events.length}`, !typeFilter, () => { typeFilter = ''; render(); }));
      for (const t of Object.keys(counts).sort()) chipsEl.append(chip(`${t} ${counts[t]}`, typeFilter === t, () => { typeFilter = typeFilter === t ? '' : t; render(); }));
      const vis = events.filter((e) => (!typeFilter || e.type === typeFilter) && matchQ(e, q)).slice().reverse();
      meta.textContent = `${vis.length} of ${plural(events.length, 'event')} loaded, newest first`;
      ctx.setCount('events', (info?.count ?? events.length) || null);
      clear(list);
      if (!vis.length) { list.append(empty(events.length ? 'Nothing matches' : 'The truth file has no events yet', events.length ? 'Loosen the type filter or the search.' : 'Launches, messages, features, notes and pins land here.')); return; }
      const frag = document.createDocumentFragment();
      let day = null;
      for (const e of vis) {
        const d = toDate(e.ts); const k = d ? d.toDateString() : '';
        if (k !== day) { day = k; frag.append(h('div', { class: 'tl-day' }, d ? dayLabel(d) : 'undated')); }
        frag.append(eventRow(e));
      }
      list.append(frag);
    }

    async function load(quiet = false) {
      if (!quiet && !events.length) { clear(list); list.append(loading('Reading the truth file')); }
      try {
        const [tail, st] = await Promise.all([
          (quiet ? ctx.callQuiet : ctx.call)('events.tail', { limit }, LOCAL),
          ctx.callQuiet('events.state', {}, LOCAL).catch(() => null),
        ]);
        if (!alive) return;
        events = Array.isArray(tail) ? tail : []; info = st;
        fileEl.textContent = st?.file ? `${shortPath(st.file.path, 44)}${st.file.exists ? `, ${plural(st.count, 'event')}, ${Math.round(st.file.bytes / 1024)} KB` : ', not created yet'}` : '';
        fileEl.title = st?.file?.path ?? '';
        render();
      } catch (e) { if (!quiet) { clear(list); list.append(empty('Could not load events', e.message)); } }
    }
    const reload = debounce(() => load(true), 800);
    load();

    return {
      destroy() { alive = false; },
      search(qq) { q = qq; render(); },
      sse(type) { if (type === 'mutation') reload(); },
    };
  },
};
