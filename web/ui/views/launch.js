// Launch: a form over profiles.json -> launch.start. The result opens in the
// drawer (the new tmux window, or the headless session) and the form stays put
// for the next launch. Last choices are remembered in localStorage.
import { h, append, clear, seg, field, loading, engine } from '../dom.js';

const SAVE_KEY = 'drover.launch';

export default {
  id: 'launch', label: 'Launch', key: 'l',
  mount(root, ctx, params) {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(SAVE_KEY) || '{}'); } catch { saved = {}; }
    let profiles = null; let alive = true; let tmuxSessions = []; let credStatus = null;
    // Effort levels per engine from launch.efforts on the selected host; null while loading or when that
    // host's apx predates efforts (it would ignore the field, so the select stays disabled there).
    let efforts = null; let effortsError = null;
    const v = { engine: saved.engine === 'codex' ? 'codex' : 'claude', mode: saved.mode === 'headless' ? 'headless' : 'tmux', credential: typeof saved.credential === 'string' && saved.credential ? saved.credential : 'auto' };

    const f = {};
    f.engine = seg([['claude', 'Claude Code'], ['codex', 'Codex']], v.engine, (x) => { v.engine = x; fillProfiles(); toggleCredential(); preview(); });
    f.mode = seg([['tmux', 'tmux window'], ['headless', 'headless']], v.mode, (x) => { v.mode = x; toggleMode(); preview(); });
    const modeHint = h('span', { class: 'muted small' });
    f.credential = h('select', { 'aria-label': 'Credential', onchange: () => { v.credential = f.credential.value; preview(); } },
      h('option', { value: 'auto', selected: v.credential !== 'none' ? true : null }, 'auto (least loaded, skips throttled)'),
      h('option', { value: 'none', selected: v.credential === 'none' ? true : null }, 'none (inherit the daemon environment)'));   // refilled from credentials.status once the host answers
    const credHint = h('span', { class: 'muted small' }, 'credential pool: loading');
    f.profile = h('select', { 'aria-label': 'Profile', onchange: preview });
    f.model = h('select', { 'aria-label': 'Model', onchange: preview });
    f.effort = h('select', { 'aria-label': 'Effort', disabled: true, onchange: preview });
    const effortHint = h('span', { class: 'muted small' }, 'effort levels: loading');
    f.cwd = h('input', { list: 'l-cwd-list', value: saved.cwd ?? '', placeholder: 'on the target host; blank for home', autocomplete: 'off', oninput: preview });
    f.cwdList = h('datalist', { id: 'l-cwd-list' });
    // Blank until the profiles load: then the last session used here, else the profiles' default (defaultSession).
    f.tmuxSession = h('input', { list: 'l-tmux-list', value: saved.tmuxSession ?? '', autocomplete: 'off', oninput: preview });
    f.tmuxList = h('datalist', { id: 'l-tmux-list' });
    f.name = h('input', { placeholder: 'optional', value: saved.name ?? '', autocomplete: 'off', oninput: preview });
    f.prompt = h('textarea', { rows: 6, placeholder: 'first prompt (optional)', oninput: preview });
    f.host = h('select', { 'aria-label': 'Host', onchange: () => { load(); } });
    f.submit = h('button', { class: 'btn primary', type: 'submit' }, 'Launch');
    const identityEl = h('div', { class: 'muted small mono' }, 'identity: loading');
    const previewEl = h('pre', { class: 'screen', 'aria-label': 'Command preview' });
    const result = h('div', { class: 'notice', hidden: true, role: 'status' });

    for (const hst of ctx.hosts()) {
      const up = ctx.hostUp(hst.name);
      f.host.append(h('option', { value: hst.name, selected: hst.name === ctx.host() ? true : null }, hst.name === 'local' ? `${hst.display} (local)` : `${hst.display}${up === false ? ', unreachable' : ''}`));
    }
    if (!f.host.value) f.host.append(h('option', { value: 'local', selected: true }, 'local'));
    if (params[0]) f.prompt.value = params[0];

    // A button group inside a <label> would be activated by a click on the label text, so these two rows are divs shaped like label.field.
    const segField = (label, control) => h('div', { class: 'field', style: { display: 'grid', gap: '4px', fontSize: 'var(--fs-1)', color: 'var(--ink-2)' } }, h('span', { class: 'em' }, label), control);
    const tmuxOnly = [field('tmux session', f.tmuxSession), field('Window name', f.name)];
    const credField = field('Credential', h('div', null, f.credential, h('div', null, credHint)));
    f.host.style.width = '100%';
    f.credential.style.width = '100%';
    f.effort.style.width = '100%';
    const form = h('form', { class: 'form', onsubmit: submit },
      segField('Engine', f.engine),
      credField,
      segField('Mode', h('div', null, f.mode, h('div', null, modeHint))),
      field('Profile', f.profile),
      field('Model', f.model),
      field('Effort', h('div', null, f.effort, h('div', null, effortHint))),
      field('Working directory', f.cwd),
      ...tmuxOnly,
      field('Host', h('div', null, f.host, identityEl)),
      f.cwdList, f.tmuxList,
      field('Prompt', f.prompt, { wide: true }),
      h('div', { class: 'wide' }, h('div', { class: 'em small' }, 'Will run'), previewEl),
      h('div', { class: 'toolbar wide' }, f.submit, h('span', { class: 'muted small' }, 'The launch is recorded as a launch event in the truth file.')));
    root.append(h('div', { class: 'view-head' }, h('h1', null, 'Launch'), h('span', { class: 'muted small' }, 'start a Claude Code or Codex agent on any host')), form, result);

    function currentProfiles() { return profiles?.[v.engine]?.profiles ?? []; }
    // Where a launch that names no session opens its window: the same rule as core/launch.js defaultTmuxSession.
    function defaultSession() { return [profiles?.tmuxSession, ...(profiles?.tmuxSessions ?? [])].find((s) => typeof s === 'string' && s.trim())?.trim() ?? 'agents'; }
    function fillProfiles() {
      const eng = v.engine;
      clear(f.profile); clear(f.model);
      const want = saved.profile?.[eng] ?? null;
      for (const p of currentProfiles()) f.profile.append(h('option', { value: p.id, selected: (want ? p.id === want : p.default) ? true : null, title: p.requires ? `requires ${p.requires} in the host environment` : null }, `${p.label}${p.requires ? ` (needs ${p.requires})` : ''}`));
      f.model.append(h('option', { value: '' }, 'profile default'));
      for (const m of profiles?.[eng]?.models ?? []) f.model.append(h('option', { value: m.id, selected: saved.model?.[eng] === m.id ? true : null }, `${m.label} (${m.id})`));
      fillEfforts();
    }
    /** Levels for the current engine, or a disabled select that says why there are none. */
    function fillEfforts() {
      const eng = v.engine;
      const levels = Array.isArray(efforts?.[eng]) ? efforts[eng] : null;
      clear(f.effort);
      f.effort.append(h('option', { value: '' }, 'profile default'));
      for (const lv of levels ?? []) f.effort.append(h('option', { value: lv, selected: saved.effort?.[eng] === lv ? true : null }, lv));
      f.effort.disabled = !levels;
      effortHint.textContent = levels ? 'this session only; your default effort is not changed'
        : !effortsError ? 'effort levels: loading'
          : /unknown op launch\.efforts/.test(effortsError) ? `not available on ${f.host.value}: its Drover code predates launch efforts (update Drover there to choose one)`
            : `effort levels unavailable from ${f.host.value}: ${effortsError}`;
    }
    /** The effort the launch would carry: '' when the select is off or on the profile default. */
    function chosenEffort() { return f.effort.disabled ? '' : f.effort.value; }
    function toggleMode() {
      const tmux = v.mode === 'tmux';
      for (const n of tmuxOnly) n.hidden = !tmux;
      modeHint.textContent = tmux ? 'interactive, in a new tmux window on the host' : 'held by the daemon; chat with it from Sessions or the drawer';
    }
    // The credential pool applies to Claude launches (profiles.json credentials.appliesTo); the row is hidden for other engines.
    function toggleCredential() {
      const applies = (credStatus?.appliesTo ?? ['claude']).includes(v.engine);
      credField.hidden = !applies;
    }
    /** Options: auto, every pool entry (disabled when its variables are unset on the host), none. Names and ids only. */
    function fillCredentials(st, host) {
      clear(f.credential);
      f.credential.append(h('option', { value: 'auto' }, 'auto (least loaded, skips throttled)'));
      for (const p of st?.pool ?? []) {
        const title = p.available
          ? `${p.active} active${p.maxConcurrent != null ? ` of ${p.maxConcurrent}` : ''}, weight ${p.weight}, ${p.uses} launches so far${p.recentThrottles ? `, throttled ${p.recentThrottles}x in the last 2 min` : ''}`
          : `needs ${(p.missing ?? []).join(', ')} in the daemon environment on ${host}`;
        f.credential.append(h('option', { value: p.id, disabled: p.available ? null : true, title }, `${p.label} (${p.id})${p.available ? '' : ', unavailable'}`));
      }
      f.credential.append(h('option', { value: 'none' }, 'none (inherit the daemon environment)'));
      const usable = [...f.credential.options].some((o) => o.value === v.credential && !o.disabled);
      f.credential.value = usable ? v.credential : 'auto';
      v.credential = f.credential.value;
      if (!st) credHint.textContent = `credential pool not reported by ${host}; auto there follows that daemon's own default`;
      else if (st.recommendation) {
        const rec = st.pool.find((p) => p.id === st.recommendation);
        credHint.textContent = `auto picks ${st.recommendation} right now, ${rec?.active ?? 0} active${rec?.maxConcurrent != null ? ` of ${rec.maxConcurrent}` : ''}`;
        credHint.title = st.recommendationReason ?? '';
      } else {
        credHint.textContent = `auto has nothing to pick: ${st.recommendationReason ?? 'no credential available'}`;
        credHint.title = '';
      }
    }
    /** The $NAME references (never values) that the chosen credential would set, for the command preview. */
    function credentialEnvRefs() {
      if (!credStatus || credField.hidden || v.credential === 'none') return [];
      const id = v.credential === 'auto' ? credStatus.recommendation : v.credential;
      const p = credStatus.pool?.find((x) => x.id === id);
      return p ? Object.entries(p.env ?? {}).map(([k, ref]) => `${k}=${ref}`) : [];
    }
    function preview() {
      const eng = v.engine; const p = currentProfiles().find((x) => x.id === f.profile.value);
      const argv = [eng === 'codex' ? 'codex' : 'claude', ...(p?.argv ?? [])];
      const model = f.model.value;
      const effort = chosenEffort();
      const prompt = f.prompt.value.trim();
      if (v.mode === 'headless') {
        if (eng === 'claude') argv.push('-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--session-id', '<uuid7>');
        else { previewEl.textContent = `codex app-server thread/start {cwd: ${f.cwd.value || '$HOME'}${model ? `, model: ${model}` : ''}${effort ? `, config: {model_reasoning_effort: "${effort}"}` : ''}}${prompt ? ' + turn/start with the prompt' : ''}`; return; }
      }
      if (model) argv.push(eng === 'codex' ? '-m' : '--model', model);
      // Same flags core/claude.js and core/codex.js add (display only; the daemon builds the real argv).
      if (effort) argv.push(...(eng === 'codex' ? ['-c', `model_reasoning_effort="${effort}"`] : ['--effort', effort]));
      if (prompt && v.mode === 'tmux') argv.push('--', `"${prompt.slice(0, 60).replace(/\n/g, ' ')}${prompt.length > 60 ? '...' : ''}"`);
      const env = [...Object.entries(p?.env ?? {}).map(([k, val]) => `${k}=${val}`), ...credentialEnvRefs()].join(' ');
      previewEl.textContent = `${v.mode === 'tmux' ? `tmux new-window -t =${f.tmuxSession.value || defaultSession()}:${f.name.value ? ` -n ${f.name.value}` : ''} -c ${f.cwd.value || '$HOME'} ` : ''}${env ? env + ' ' : ''}${argv.join(' ')}`;
    }
    async function loadHostBits() {
      const host = f.host.value;
      identityEl.textContent = 'identity: loading';
      credHint.textContent = 'credential pool: loading';
      try {
        const [idn, sess, cred] = await Promise.all([
          ctx.callQuiet('host.identity', {}, { host }),
          ctx.callQuiet('tmux.sessions', {}, { host }).catch(() => []),
          ctx.callQuiet('credentials.status', {}, { host }).catch(() => null),
        ]);
        if (!alive || f.host.value !== host) return;
        const id = idn?.identity ?? {};
        identityEl.textContent = `on ${idn?.host ?? host}: DF_IDENTITY=${id.DF_IDENTITY ?? '?'} DF_ROLE=${id.DF_ROLE ?? '?'}${id.DF_MACHINE ? ` DF_MACHINE=${id.DF_MACHINE}` : ''} node ${idn?.node ?? '?'}`;
        tmuxSessions = (Array.isArray(sess) ? sess : []).map((s) => s.name);
        fillTmuxList();
        credStatus = cred;
        fillCredentials(cred, host); toggleCredential(); preview();
      } catch (e) { if (alive) identityEl.textContent = `identity unavailable: ${e.message}`; }
    }
    function fillTmuxList() {
      clear(f.tmuxList);
      for (const s of [...new Set([...tmuxSessions, ...(profiles?.tmuxSessions ?? [])])]) f.tmuxList.append(h('option', { value: s }));
    }
    async function load() {
      try {
        profiles = await ctx.call('launch.profiles', {}, { host: f.host.value });
        if (!alive) return;
        fillProfiles();
        if (!f.tmuxSession.value) f.tmuxSession.value = defaultSession();
        clear(f.cwdList); for (const c of profiles.cwdSuggestions ?? []) f.cwdList.append(h('option', { value: c }));
        fillTmuxList(); toggleMode(); toggleCredential(); preview();
      } catch { previewEl.textContent = 'profiles.json could not be loaded'; }
      loadEfforts();
      loadHostBits();
    }
    /** Ask the host which effort levels it takes. Older Drover code answers "unknown op launch.efforts". */
    async function loadEfforts() {
      const host = f.host.value;
      efforts = null; effortsError = null; fillEfforts();
      try {
        const r = await ctx.callQuiet('launch.efforts', {}, { host });
        if (!alive || f.host.value !== host) return;
        efforts = r && typeof r === 'object' ? r : null;
        if (!efforts) effortsError = 'no levels reported';
      } catch (e) {
        if (!alive || f.host.value !== host) return;
        effortsError = e.message;
      }
      fillEfforts(); preview();
    }
    async function submit(e) {
      e.preventDefault();
      const host = f.host.value;
      const eng = v.engine;
      const req = {
        engine: eng, mode: v.mode,
        profile: f.profile.value || undefined, model: f.model.value || undefined,
        cwd: f.cwd.value.trim() || undefined, prompt: f.prompt.value.trim() || undefined, name: f.name.value.trim() || undefined,
      };
      if (req.mode === 'tmux') req.tmuxSession = f.tmuxSession.value.trim() || undefined;
      if (!credField.hidden) req.credential = f.credential.value || undefined;
      const effort = chosenEffort();
      if (effort) req.effort = effort;
      saved = { engine: eng, mode: req.mode, cwd: f.cwd.value, tmuxSession: f.tmuxSession.value, name: f.name.value, credential: f.credential.value || 'auto', profile: { ...(saved.profile ?? {}), [eng]: req.profile }, model: { ...(saved.model ?? {}), [eng]: req.model ?? '' }, effort: { ...(saved.effort ?? {}), ...(f.effort.disabled ? {} : { [eng]: effort }) } };
      localStorage.setItem(SAVE_KEY, JSON.stringify(saved));
      f.submit.disabled = true; result.hidden = false; result.className = 'notice'; clear(result); result.append(loading(`Launching ${eng} (${req.mode}) on ${host}`));
      try {
        const r = await ctx.call('launch.start', req, { host });
        if (!alive) return;
        const where = r.mode === 'tmux' ? `tmux window ${r.target} (${r.name})` : `headless ${r.headlessId}${r.sessionId ? `, session ${r.sessionId}` : ''}${r.threadId ? `, thread ${r.threadId}` : ''}`;
        result.className = 'notice ok'; clear(result);
        append(result, [
          h('div', null, engine(eng), ' Launched ', where, h('span', { class: 'muted' }, ` on ${host}${r.effort ? `, effort ${r.effort}` : ''}${r.credential ? `, credential ${r.credential}` : ''}${r.event ? `, event ${r.event}` : ''}`)),
          r.credentialReason ? h('div', { class: 'muted small', title: r.credentialReason }, `credential: ${r.credential ?? 'none'} (${r.credentialReason})`) : null,
          r.argv ? h('pre', { class: 'screen', style: { marginTop: '6px' } }, r.argv.join(' ')) : null]);
        ctx.toast(`Launched ${where} on ${host}`, 'ok');
        if (host !== ctx.host()) ctx.setHost(host, { remount: false });
        if (r.mode === 'tmux') ctx.open({ kind: 'window', id: r.target, host, name: r.name, engine: eng, tmux: r.target });
        else ctx.open({ kind: 'session', id: r.headlessId, host, engine: eng, name: req.name ?? `${eng} headless` });
        loadHostBits();   // refresh the active counts and the recommendation
      } catch (err) {
        if (!alive) return;
        result.className = 'notice error'; clear(result); result.append(`Launch failed: ${err.message}`);
      } finally { f.submit.disabled = false; }
    }

    load();
    return {
      destroy() { alive = false; },
      params(p) { if (p[0]) { f.prompt.value = p[0]; preview(); f.prompt.focus(); } },
    };
  },
};
