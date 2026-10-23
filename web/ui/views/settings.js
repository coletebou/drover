// Settings: alerts (per category desktop / sound / volume / speech / sticky,
// with a preview and a server-side test per category), mutes, quiet hours, the
// away rule, coalescing, speech voice, badges, the MR watch scope, dictation,
// direct peers, this device's permissions, and the recent alert history.
//
// The settings themselves live in the truth file (settings.get / settings.set),
// so they follow the owner across browsers and are visible to agents; each control
// writes one small patch. Device facts (permissions, wake lock, install, peer
// tokens) stay in this browser.
import { h, clear, btn, chip, field, fmtTime, ago, empty, loading, plural } from '../dom.js';
import { CATEGORIES, SOUNDS, MUTE_SCOPES, DEFAULT_SETTINGS } from '../notify-policy.js';
import * as sounds from '../sounds.js';
import * as speech from '../speech.js';
import * as dictation from '../dictation.js';
import * as api from '../api.js';

const LOCAL = { host: 'local' };

function toggle(label, checked, onChange, { hint, disabled } = {}) {
  const input = h('input', { type: 'checkbox', role: 'switch', checked: checked ? true : null, disabled: disabled ? true : null, onchange: (e) => onChange(e.target.checked) });
  return h('label', { class: 'switch', title: hint ?? null }, input, h('span', { class: 'track', 'aria-hidden': 'true' }), h('span', null, label));
}
function section(title, hint, ...body) {
  return h('section', { class: 'card set-card' }, h('div', { class: 'set-head' }, h('h2', null, title), hint ? h('p', { class: 'muted small' }, hint) : null), ...body);
}
function stateMark(state, label) {
  const cls = state === 'granted' || state === 'running' || state === 'available' || state === 'on' ? 'idle' : state === 'denied' || state === 'unavailable' || state === 'unsupported' ? 'dead' : state === 'prompt' || state === 'default' || state === 'downloadable' || state === 'suspended' ? 'wait' : '';
  return h('span', { class: 'mark' }, h('span', { class: `dot ${cls}`, 'aria-hidden': 'true' }), label ?? state);
}

export default {
  id: 'settings', label: 'Settings', key: ',',
  mount(root, ctx) {
    const N = ctx.notifier;
    let alive = true; let historyEl = null; let history = null; let historyCat = ''; let authors = null; let voices = []; let localVoicesOnly = true;
    const head = h('div', { class: 'view-head' }, h('h1', null, 'Settings'), h('span', { class: 'muted small', id: 'set-meta' }), h('span', { class: 'spacer' }),
      btn('Shortcuts', () => ctx.showShortcuts(), { cls: 'sm quiet', title: 'Keyboard shortcuts (?)' }),
      btn('Reset everything', async () => { if (!confirm('Reset every setting to the defaults? Mutes are cleared too.')) return; await ctx.call('settings.reset', {}, LOCAL).then((r) => N.onSettings(r)); ctx.toast('Settings reset', 'ok'); }, { cls: 'sm quiet danger' }));
    const grid = h('div', { class: 'settings' });
    root.append(head, grid);

    const set = async (patch, reason) => {
      N.preview(patch);
      try { await N.set(patch, { reason }); } catch { await N.refresh(); render(); }
    };

    function render() {
      if (!alive) return;
      const S = N.settings;
      const meta = root.querySelector('#set-meta');
      meta.textContent = N.meta.updated ? `saved in the truth file, last change ${fmtTime(N.meta.updated)} by ${N.meta.by ?? '?'}` : 'defaults (nothing changed yet)';
      clear(grid);
      historyEl = historyCard();
      grid.append(deviceCard(), alertsCard(S), scopesCard(S), mutesCard(S), speechCard(S), dictationCard(S), ...(api.hasOp('mrs.authors') ? [mrCard(S)] : []), peersCard(S), historyEl);
    }

    // ------------------------------------------------------------ device
    function deviceCard() {
      const rows = h('div', { class: 'perm-grid' });
      const add = (name, stateEl, ...actions) => rows.append(h('div', { class: 'perm' }, h('span', { class: 'perm-name' }, name), stateEl, h('span', { class: 'perm-act' }, ...actions)));
      const np = N.permission();
      add('Desktop notifications', stateMark(np, np === 'default' ? 'not asked yet' : np), np === 'default' ? btn('Allow', async () => { await N.requestPermission().catch((e) => ctx.toast(e.message, 'error')); render(); }, { cls: 'sm primary' }) : null, np === 'denied' ? h('span', { class: 'muted small' }, 'Re-enable in Chrome site settings') : null);
      add('Sound', stateMark(sounds.state() === 'running' ? 'running' : 'suspended', sounds.state() === 'running' ? 'ready' : 'waits for a click'), btn('Play a chime', async () => { sounds.unlock(); await sounds.play('chime', 0.6); render(); }, { cls: 'sm' }));
      const pres = N.presence();
      add('Away detection', stateMark(pres.idleDetection ? 'granted' : 'prompt', pres.idleDetection ? `idle detection: you are ${pres.idle?.user === 'idle' || pres.idle?.screen === 'locked' ? 'away' : 'active'}` : 'using tab visibility and focus'),
        !pres.idleDetection && 'IdleDetector' in window ? btn('Use idle detection', async () => { try { await N.requestIdle(); ctx.toast('Idle detection on', 'ok'); } catch (e) { ctx.toast(e.message, 'error'); } render(); }, { cls: 'sm', title: 'Lets alerts know when you stepped away (screen locked or no input for the idle time)' }) : null,
        h('span', { class: 'muted small' }, pres.away ? 'away now' : 'here now'));
      add('This tab', stateMark(N.leader ? 'on' : 'prompt', N.leader ? 'plays sounds and desktop alerts' : 'another Drover tab plays alerts'));
      const sw = ctx.swState();
      add('Service worker', stateMark(sw.active ? 'granted' : 'prompt', sw.active ? 'active: notification buttons work' : sw.error ? `not registered: ${sw.error}` : 'starting'));
      add('Install as an app', stateMark(ctx.installState() === 'installed' ? 'granted' : ctx.installState() === 'available' ? 'prompt' : '', ctx.installState()), ctx.installState() === 'available' ? btn('Install', () => ctx.install(), { cls: 'sm' }) : null);
      add('Keep screen awake', stateMark(ctx.wakeLock.on ? 'on' : '', ctx.wakeLock.on ? 'on while this tab is visible' : ctx.wakeLock.supported ? 'off' : 'unsupported'), ctx.wakeLock.supported ? toggle('', ctx.wakeLock.on, async (v) => { await ctx.wakeLock.set(v); render(); }) : null);
      add('Waiting board window', stateMark('documentPictureInPicture' in window ? 'granted' : 'prompt', 'documentPictureInPicture' in window ? 'always-on-top picture-in-picture' : 'a popup window'), btn('Open', () => ctx.openPip(), { cls: 'sm', title: 'A small always-on-top board of sessions waiting on you (w)' }));
      const clipState = h('span', { class: 'mark' }, 'checking');
      navigator.permissions?.query({ name: 'clipboard-read' }).then((p) => { clear(clipState); clipState.append(stateMark(p.state)); }).catch(() => { clear(clipState); clipState.append(stateMark('', 'write only')); });
      add('Clipboard', clipState, h('span', { class: 'muted small' }, 'copy buttons, and paste images or files into a composer'));
      return section('This device', 'What this browser is allowed to do. Settings below are shared by every browser and agent; these lines are this device only.', rows);
    }

    // ------------------------------------------------------------ alerts
    function alertsCard(S) {
      const tbl = h('table', { class: 'tbl cat-table' }, h('thead', null, h('tr', null, h('th', null, 'Category'), h('th', null, 'On'), h('th', null, 'Desktop'), h('th', null, 'Sound'), h('th', null, 'Volume'), h('th', { class: 'opt' }, 'Speak'), h('th', { class: 'opt', title: 'Keep the desktop notification until you act on it' }, 'Sticky'), h('th', null, ''))));
      const body = h('tbody');
      for (const c of CATEGORIES) {
        const v = S.categories?.[c.id] ?? DEFAULT_SETTINGS.categories[c.id];
        const patch = (k, val) => set({ categories: { [c.id]: { [k]: val } } }, `${c.id}.${k}`);
        const soundSel = h('select', { 'aria-label': `${c.label} sound`, onchange: (e) => { patch('sound', e.target.value); sounds.play(e.target.value, v.volume); } }, SOUNDS.map((s) => h('option', { value: s.id, selected: s.id === v.sound ? true : null }, s.label)));
        const vol = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: v.volume, 'aria-label': `${c.label} volume`, onchange: (e) => { patch('volume', Number(e.target.value)); sounds.play(v.sound, Number(e.target.value)); } });
        const box = (k, label) => h('input', { type: 'checkbox', checked: v[k] ? true : null, 'aria-label': `${c.label}: ${label}`, onchange: (e) => patch(k, e.target.checked) });
        body.append(h('tr', { class: v.enabled ? null : 'off' },
          h('td', null, h('div', null, c.label), h('div', { class: 'muted small' }, c.hint)),
          h('td', null, box('enabled', 'on')), h('td', null, box('desktop', 'desktop notification')), h('td', null, soundSel), h('td', null, vol),
          h('td', { class: 'opt' }, box('speak', 'speak a summary')), h('td', { class: 'opt' }, box('sticky', 'sticky')),
          h('td', { class: 'nowrap' },
            btn('Hear', () => N.audition(c.id), { cls: 'sm quiet', title: 'Play this sound (and voice) here' }),
            btn('Test', async () => { try { const r = await ctx.call('notify.test', { category: c.id }, LOCAL); if (r.decision && N.permission() !== 'granted' && v.desktop) ctx.toast('Desktop notifications are not allowed in this browser yet (This device, Allow)', 'info', 6000); } catch { /* toasted */ } }, { cls: 'sm', title: 'Fire a test alert through the daemon: desktop notification, sound, speech, toast, and a test event in the truth file' }))));
      }
      tbl.append(body);
      return section('Alerts', 'What happens when an agent needs you, finishes, fails, holds a peer message, or an MR moves. The daemon detects these; every browser decides how loud to be.',
        h('div', { class: 'toolbar' }, toggle('All alerts', S.master, (v) => set({ master: v }, 'master')), toggle('Toasts in the page', S.toasts, (v) => set({ toasts: v }, 'toasts')),
          toggle('Count on the tab title', S.badge?.title, (v) => set({ badge: { title: v } })), toggle('Count on the favicon', S.badge?.favicon, (v) => set({ badge: { favicon: v } })), toggle('App icon badge', S.badge?.app, (v) => set({ badge: { app: v } }), { hint: 'navigator.setAppBadge when Drover is installed as an app' })),
        h('div', { class: 'tbl-wrap' }, tbl));
    }

    function scopesCard(S) {
      const q = S.quietHours ?? DEFAULT_SETTINGS.quietHours;
      const start = h('input', { type: 'time', value: q.start, 'aria-label': 'Quiet hours start', onchange: (e) => e.target.value && set({ quietHours: { start: e.target.value } }) });
      const end = h('input', { type: 'time', value: q.end, 'aria-label': 'Quiet hours end', onchange: (e) => e.target.value && set({ quietHours: { end: e.target.value } }) });
      const allow = h('div', { class: 'chips' }, h('span', { class: 'muted small' }, 'still sound during quiet hours:'), ...CATEGORIES.map((c) => chip(c.label, (q.allow ?? []).includes(c.id), () => { const cur = new Set(q.allow ?? []); if (cur.has(c.id)) cur.delete(c.id); else cur.add(c.id); set({ quietHours: { allow: [...cur] } }); })));
      const idle = h('input', { type: 'number', min: 60, max: 3600, step: 30, value: S.away?.idleSeconds ?? 60, style: { width: '7em' }, 'aria-label': 'Idle seconds', onchange: (e) => set({ away: { idleSeconds: Number(e.target.value) } }) });
      const win = h('input', { type: 'number', min: 0, max: 60000, step: 500, value: S.coalesce?.windowMs ?? 2500, style: { width: '7em' }, 'aria-label': 'Coalescing window in ms', onchange: (e) => set({ coalesce: { windowMs: Number(e.target.value) } }) });
      const per = h('input', { type: 'number', min: 1, max: 120, value: S.coalesce?.maxPerMinute ?? 8, style: { width: '6em' }, 'aria-label': 'Desktop notifications per minute', onchange: (e) => set({ coalesce: { maxPerMinute: Number(e.target.value) } }) });
      return section('When to be loud', 'Quiet hours silence sounds, speech and desktop notifications (toasts still show). "Only when I am away" keeps quiet while you are looking at Drover.',
        h('div', { class: 'toolbar' }, toggle('Quiet hours', q.enabled, (v) => set({ quietHours: { enabled: v } })), field('from', start), field('to', end)),
        allow,
        h('div', { class: 'toolbar', style: { marginTop: '10px' } }, toggle('Only when I am away', S.away?.onlyWhenAway, (v) => set({ away: { onlyWhenAway: v } }), { hint: 'Away = screen locked or idle (Idle Detection), else the tab is hidden or not focused' }),
          toggle('Use idle detection', S.away?.useIdleDetection, (v) => set({ away: { useIdleDetection: v } })), field('idle after (s)', idle)),
        h('div', { class: 'toolbar' }, field('group alerts within (ms)', win), field('desktop notifications per minute', per),
          h('span', { class: 'muted small' }, 'A burst inside the window becomes one grouped notification and one sound.')));
    }

    function mutesCard(S) {
      const list = h('div');
      const live = (N.meta.activeMutes ?? S.mutes ?? []).filter((m) => !m.until || Date.parse(m.until) > Date.now());
      if (!live.length) list.append(h('p', { class: 'muted small' }, 'Nothing is muted. Mute a session, its tmux session or its host from the drawer (Mute), or add one here.'));
      for (const m of live) list.append(h('div', { class: 'row static' }, h('span', { class: 'mono small' }, m.scope), h('div', { class: 'main-col' }, h('div', { class: 'l1' }, h('span', null, m.target), m.host ? h('span', { class: 'muted small' }, `on ${m.host}`) : null), h('div', { class: 'l2' }, m.until ? `until ${fmtTime(m.until)}` : 'until unmuted', m.by ? `, by ${m.by}` : '')),
        btn('Unmute', async () => { const r = await ctx.call('notify.unmute', { id: m.id }, LOCAL); N.onSettings(r); render(); }, { cls: 'sm' })));
      const scope = h('select', { 'aria-label': 'Mute scope' }, MUTE_SCOPES.map((s) => h('option', { value: s }, s)));
      const target = h('input', { placeholder: 'host, session name, tmux session or category', 'aria-label': 'Mute target', size: 30 });
      const host = h('input', { placeholder: 'on host (optional)', 'aria-label': 'Only on host', size: 14 });
      const mins = h('select', { 'aria-label': 'For how long' }, [['60', '1 hour'], ['240', '4 hours'], ['720', '12 hours'], ['1440', '1 day'], ['', 'until unmuted']].map(([v, l]) => h('option', { value: v }, l)));
      const form = h('form', { class: 'toolbar', onsubmit: async (e) => { e.preventDefault(); if (!target.value.trim()) return; try { const r = await ctx.call('notify.mute', { scope: scope.value, target: target.value.trim(), ...(host.value.trim() ? { host: host.value.trim() } : {}), ...(mins.value ? { minutes: Number(mins.value) } : {}) }, LOCAL); N.onSettings(r); render(); } catch { /* toasted */ } } },
        scope, target, host, mins, h('button', { class: 'btn sm primary', type: 'submit' }, 'Mute'));
      return section('Mutes', 'Muted alerts are still recorded in the truth file (marked muted); they just do not ring.', list, form);
    }

    function speechCard(S) {
      const sp = S.speech ?? DEFAULT_SETTINGS.speech;
      const sel = h('select', { 'aria-label': 'Voice', onchange: (e) => set({ speech: { voiceURI: e.target.value } }) }, h('option', { value: '' }, 'default voice'));
      speech.voices({ localOnly: sp.localOnly }).then((vs) => { voices = vs; for (const v of vs) sel.append(h('option', { value: v.voiceURI, selected: v.voiceURI === sp.voiceURI ? true : null }, `${v.name} (${v.lang})${v.localService ? '' : ', network'}`)); if (!vs.length) sel.append(h('option', { disabled: true }, 'no local voices')); });
      const rate = h('input', { type: 'range', min: 0.5, max: 2, step: 0.1, value: sp.rate, 'aria-label': 'Speech rate', onchange: (e) => set({ speech: { rate: Number(e.target.value) } }) });
      return section('Spoken summaries', 'Categories with Speak on read a one-line summary aloud. Local voices only keeps the text on this machine.',
        speech.supported() ? h('div', { class: 'toolbar' }, field('voice', sel), field('rate', rate), toggle('Local voices only', sp.localOnly, (v) => set({ speech: { localOnly: v } })),
          btn('Say something', () => speech.speak('build agent finished: all tests pass.', N.settings.speech).then((ok) => { if (!ok) ctx.toast('No allowed voice on this machine', 'error'); }), { cls: 'sm' })) : h('p', { class: 'muted small' }, 'This browser has no speech synthesis.'));
    }

    function dictationCard(S) {
      const d = S.dictation ?? DEFAULT_SETTINGS.dictation;
      const status = h('div', { class: 'notice', hidden: true });
      const lang = h('input', { value: d.lang, size: 8, 'aria-label': 'Language', onchange: (e) => set({ dictation: { lang: e.target.value.trim() || 'en-US' } }) });
      const actions = h('span', { class: 'toolbar', style: { margin: 0 } });
      if (dictation.supported()) {
        dictation.plan({ lang: d.lang, allowCloud: d.allowCloud }).then((p) => {
          status.hidden = false; status.className = `notice ${p.engine === 'on-device' ? 'ok' : p.engine === 'cloud' ? '' : 'error'}`;
          clear(status); status.append(h('b', null, p.engine === 'on-device' ? 'On-device. ' : p.engine === 'cloud' ? 'Cloud. ' : 'Off. '), p.reason, ` (on-device status: ${p.status})`);
          if (p.status === 'downloadable') actions.append(btn(`Install the ${d.lang} on-device pack`, async () => { try { const ok = await dictation.installOnDevice(d.lang); ctx.toast(ok ? 'Language pack installed' : 'Chrome did not install the pack', ok ? 'ok' : 'error'); } catch (e) { ctx.toast(e.message, 'error'); } render(); }, { cls: 'sm primary' }));
        });
      } else { status.hidden = false; status.className = 'notice error'; status.textContent = 'This browser has no Web Speech recognition.'; }
      return section('Dictation', 'The composer\'s Dictate button, or hold Option+Space while a drawer is open. On-device recognition keeps audio on this Mac; the cloud recognizer sends it to Google and is off unless you allow it.',
        status,
        h('div', { class: 'toolbar' }, field('language', lang), toggle('Allow cloud recognition (sends audio to Google)', d.allowCloud, (v) => set({ dictation: { allowCloud: v } })),
          toggle('Send when I let go of Option+Space', d.autoSend, (v) => set({ dictation: { autoSend: v } })), actions));
    }

    function mrCard(S) {
      const m = S.mr ?? DEFAULT_SETTINGS.mr;
      const chips = h('div', { class: 'chips' });
      const paint = () => {
        clear(chips);
        if (!authors) { chips.append(btn('Load authors from the forge', async () => { chips.firstChild.disabled = true; authors = await ctx.callQuiet('mrs.authors', { state: 'open' }, LOCAL).catch(() => []); paint(); }, { cls: 'sm' })); }
        else for (const a of authors) chips.append(chip(`${a.name ?? a.id.slice(-6)} (${a.open})`, m.authors.includes(a.id), () => { const cur = new Set(m.authors); if (cur.has(a.id)) cur.delete(a.id); else cur.add(a.id); set({ mr: { authors: [...cur] } }); }, a.email ?? a.id));
        if (m.authors.length && !authors) chips.append(h('span', { class: 'muted small' }, plural(m.authors.length, 'author') + ' picked'));
      };
      paint();
      return section('Merge requests', 'While a browser is open, the daemon checks open MRs every 2 minutes and alerts on comments, reviews, pushes by others, mergeable changes and merges.',
        h('div', { class: 'toolbar' }, h('span', { class: 'muted small' }, 'watch'), h('div', { class: 'seg', role: 'group' }, ...[['mine', 'my MRs'], ['all', 'every open MR']].map(([v, l]) => h('button', { type: 'button', 'aria-pressed': m.scope === v ? 'true' : 'false', onclick: () => set({ mr: { scope: v } }) }, l)))),
        m.scope === 'mine' ? h('div', null, h('p', { class: 'muted small' }, m.authors.length ? 'These forge authors are you:' : 'The forge names authors by an opaque id. Pick yours (with no pick, the daemon guesses from git author names):'), chips) : null);
    }

    function peersCard(S) {
      const p = S.peers ?? DEFAULT_SETTINGS.peers;
      const tokens = api.peerTokens();
      const list = h('div');
      for (const peer of p.list) {
        const tok = h('input', { type: 'password', value: tokens[peer.name] ?? '', placeholder: 'that daemon\'s token', autocomplete: 'off', 'aria-label': `Token for ${peer.name}`, size: 18, onchange: (e) => { api.setPeerToken(peer.name, e.target.value.trim()); api.configurePeers(N.settings.peers); } });
        const res = h('span', { class: 'muted small' });
        list.append(h('div', { class: 'row static' }, h('span', { class: 'mono small' }, peer.name), h('div', { class: 'main-col' }, h('div', { class: 'l1' }, h('span', { class: 'mono' }, peer.url)), h('div', { class: 'l2' }, res)), h('span', { class: 'toolbar', style: { margin: 0 } }, tok,
          btn('Test', async () => { res.textContent = 'testing…'; try { const r = await api.testPeer(peer.name); res.textContent = `answers as ${r.host} (node ${r.node}) in ${r.ms} ms`; } catch (e) { res.textContent = e.message; } }, { cls: 'sm' }),
          btn('Remove', () => { api.setPeerToken(peer.name, ''); set({ peers: { list: p.list.filter((x) => x.name !== peer.name) } }); }, { cls: 'sm quiet danger' }))));
      }
      if (!p.list.length) list.append(h('p', { class: 'muted small' }, 'No peers. A peer is another Drover daemon this browser can reach directly: a forwarded port (ssh -L 17337:127.0.0.1:7337 devbox) or a tailnet address. Its name must match the host name in the host strip.'));
      const name = h('input', { placeholder: 'host name (as in the host strip)', size: 22, 'aria-label': 'Peer host name' });
      const url = h('input', { placeholder: 'http://127.0.0.1:17337/', size: 26, 'aria-label': 'Peer URL' });
      const tok = h('input', { type: 'password', placeholder: 'token', size: 18, autocomplete: 'off', 'aria-label': 'Peer token' });
      const form = h('form', { class: 'toolbar', onsubmit: async (e) => { e.preventDefault(); const n = name.value.trim(); if (!n || !url.value.trim()) return; if (tok.value.trim()) api.setPeerToken(n, tok.value.trim()); await set({ peers: { list: [...p.list.filter((x) => x.name !== n), { name: n, url: url.value.trim() }] } }); } }, name, url, tok, h('button', { class: 'btn sm primary', type: 'submit' }, 'Add peer'));
      return section('Direct peers (local network)', 'Optional: when on, calls for a peer host go straight from this browser to that daemon instead of through ssh rpc, falling back to ssh when it does not answer. Tokens stay in this browser; the shared settings only hold names and URLs.',
        toggle('Use direct peers', p.enabled, (v) => set({ peers: { enabled: v } })), list, form);
    }

    function historyCard() {
      const box = h('div', { class: 'timeline' });
      const cats = h('div', { class: 'chips' }, chip('all', !historyCat, () => { historyCat = ''; loadHistory(); }), ...CATEGORIES.map((c) => chip(c.label, historyCat === c.id, () => { historyCat = c.id; loadHistory(); })));
      const paint = () => {
        clear(box);
        if (history === null) { box.append(loading('Reading alert history')); return; }
        if (!history.length) { box.append(empty('No alerts yet', 'They appear here as the daemon records them.')); return; }
        for (const e of history) box.append(h('div', { class: 'tl', role: 'button', tabindex: 0, onclick: () => N.handleAction('open', { single: true, host: e.hostname, sessionId: e.sessionId, target: e.tmuxTarget, name: e.sessionName, category: e.category, number: e.mr }) },
          h('time', null, fmtTime(e.ts)), h('span', { class: 'type' }, e.category ?? 'needs-you'),
          h('span', { class: 'what' }, e.title ?? `${e.sessionName ?? e.sessionId?.slice(0, 8) ?? ''} ${e.kind ?? ''}`, e.message ? h('span', { class: 'muted' }, `  ${e.message}`) : null, e.muted ? h('span', { class: 'faint small' }, `  (muted: ${e.muted})`) : null, e.test ? h('span', { class: 'faint small' }, '  (test)') : null)));
      };
      const loadHistory = async () => { history = null; paint(); try { history = await ctx.callQuiet('notify.list', { limit: 80, includeTests: true, ...(historyCat ? { category: historyCat } : {}) }, LOCAL); } catch (e) { history = []; ctx.toast(e.message, 'error'); } if (alive) paint(); };
      paint(); if (history === null) loadHistory();
      return section('Recent alerts', 'From the truth file, newest first. Click one to open its session.', cats, box);
    }

    const off = N.on((kind) => { if (kind === 'settings' || kind === 'presence' || kind === 'leader' || kind === 'permission') render(); if (kind === 'history' && history && historyEl) { history = null; const n = historyCard(); historyEl.replaceWith(n); historyEl = n; } });
    render();
    N.refresh().then(render);
    return {
      destroy() { alive = false; off(); },
      sse(type) { if (type === 'alerts') { /* history refreshes through the notifier listener */ } },
    };
  },
};
