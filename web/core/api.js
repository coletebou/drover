// The one operation table. HTTP routes, `drover rpc` (remote hosts) and the MCP
// server all call dispatch(op, args). Ops that take `host` are forwarded to
// that host's `drover rpc` by callOn(); everything here runs on the local box.
import { hostname } from 'node:os';
import * as tmux from './tmux.js';
import * as claude from './claude.js';
import * as codex from './codex.js';
import * as hosts from './hosts.js';
import * as events from './events.js';
import * as memory from './memory.js';
import * as lineage from './lineage.js';
import * as launchMod from './launch.js';
import { effortGiven, effortLevels } from './effort.js';
import * as terminals from './terminals.js';
import { callOn } from './remote.js';
import { daemonEndpoint, callDaemon } from './daemon-client.js';
import * as cache from './cache.js';
import { isMutating, addMeta } from './ops-meta.js';
import * as plugins from './plugins.js';
import * as survey from './survey.js';
import { ops as credentialOps } from './credpool.js';
import * as openclaw from './openclaw.js';
import * as grok from './bots/grok.js';
import * as hermes from './hermes.js';
import * as botAuth from './bots/oauth.js';
import * as native from './native.js';
import { ops as settingsOps } from './settings.js';
import { ops as notifyOps, notifier } from './notify.js';
import { ops as uploadOps } from './uploads.js';
import { ops as fileOps } from './files.js';
import { ops as fileWaitOps, waitLimits } from './filewait.js';
import { filterSessions, filtersGiven } from './session-filter.js';
import * as version from './version.js';
import { ops as searchOps } from './search/service.js';
import * as docker from './docker.js';
import * as vitals from './vitals.js';
import * as placement from './placement.js';
import { mergeHosts } from './search/query.js';
import * as remoteSearch from './search/remote.js';
import { OWNER } from './owner.js';
import { UPDATE_HINT } from './util.js';
import { classifyAsk, ASK_LABELS } from '../ui/notify-policy.js';

/**
 * What a stopped Claude session is waiting for: its pane (a dialog or held peer
 * message) and its transcript tail (an unanswered AskUserQuestion, or a last
 * reply that ends with a question). { kind, label, text, options, lastText }.
 */
export async function askContextFor({ transcript, tmux: pane } = {}) {
  const win = pane ? String(pane).replace(/^(.+?:@\d+)\.%\d+$/, '$1') : null;
  let screen = null, held = null, dialog = null, hash = null;
  // 60 lines, as tmux.answer reads: the hash of this screen is what an answer from the alert passes as expect.
  if (win) { try { const text = await tmux.capture(win, { lines: 60 }); screen = tmux.classifyScreen(text); held = tmux.heldMessage(text); if (screen.state === 'dialog' || held) { dialog = tmux.dialogSummary(text); hash = tmux.screenHash(text); } } catch { /* window gone */ } }
  const t = transcript ? await claude.askContext(transcript).catch(() => null) : null;
  const ask = classifyAsk({ screenState: screen?.state, dialog, held: Boolean(held), heldFrom: held?.from, text: t?.text, pendingAsk: t?.pendingAsk });
  return { ...ask, ...(hash ? { hash } : {}), lastText: t?.text ?? null, lastTs: t?.ts ?? null };
}

/** A Notification-hook event gets the real context before it is written: what is being asked, or that the session just finished. */
async function enrichHookNotify(ev) {
  if (ev?.type !== 'notify' || !ev.sessionId || ev.ask || (ev.source && ev.source !== 'hook')) return ev;
  try {
    const s = await claude.findSession(ev.sessionId);
    if (!s) return ev;
    const ask = await askContextFor({ transcript: s.transcript, tmux: s.tmux ?? ev.tmux });
    const { lastText, lastTs, hash, ...rest } = ask;
    // A dialog on screen: its hash goes with the alert, so a notification can answer that dialog and no other.
    return { ...ev, category: ask.kind === 'finished' ? 'finished' : 'needs-you', sessionName: ev.sessionName ?? s.name ?? null, tmuxTarget: ev.tmuxTarget ?? (s.tmux ? String(s.tmux).replace(/\.%\d+$/, '') : null), ask: { ...rest, options: rest.options.slice(0, 9) }, ...(hash ? { meta: { ...(ev.meta ?? {}), hash, options: rest.options.slice(0, 9) } } : {}) };
  } catch { return ev; }
}

const str = (v, name, { max = 200_000, allowEmpty = false } = {}) => {
  if (typeof v !== 'string' || (!allowEmpty && !v.trim())) throw new Error(`${name} must be a non-empty string`);
  if (v.length > max) throw new Error(`${name} too long`);
  return v;
};

/**
 * Codex reads go to this host's daemon when this process is not the daemon (a
 * peer's `drover rpc`, `drover op`), so a host runs one codex reader and every
 * caller shares its list cache: on 2026-10-17 the daemon's reader and one per
 * peer rpc passed 2 GB each. Only an unreachable daemon, or one too old to know
 * the op, sends the read to a local reader. A slow or failing daemon read would
 * be as slow here, and running it locally would add the second reader.
 */
async function preferDaemon(op, args, local) {
  const ep = await daemonEndpoint();
  if (!ep) return local();
  try { return await callDaemon(ep, op, args, { timeoutMs: 45_000 }); }
  catch (e) {
    if (e.unreachable || (e.fromDaemon && /unknown op/i.test(e.message))) return local();
    throw e;
  }
}
const readCodexThreads = (opts) => preferDaemon('codex.threads', opts, () => codex.listThreads(opts));
const readCodexThread = (threadId) => preferDaemon('codex.thread', { threadId }, () => codex.readThread(threadId));

/** Merge Claude registry, Codex threads, headless sessions, the OpenClaw manager, the Grok bots and Hermes sessions into one list. */
async function listSessionsLocal({ includeRecent = true } = {}) {
  const [cl, cx, recent, rollouts, manager, bots, hermesSessions] = await Promise.all([
    claude.listSessions(),
    readCodexThreads({ limit: 60 }).catch((e) => ({ error: e.message })),
    includeRecent ? claude.recentTranscripts({ days: 4, limit: 200 }) : [],
    includeRecent ? codex.recentRollouts({ days: 4, limit: 100 }) : [],
    openclaw.listSessions().catch(() => []),
    grok.configured() ? grok.listSessions({ host: hosts.localShortName() }).catch(() => []) : [],
    hermes.configured() ? hermes.listSessions({ includeRecent }).catch((e) => { process.stderr.write(`[hermes] listing failed: ${e.message}\n`); return []; }) : [],
  ]);
  const live = new Set(cl.map((s) => s.sessionId));
  const codexThreads = Array.isArray(cx) ? cx : [];
  const codexIds = new Set(codexThreads.map((t) => t.threadId));
  const headless = launchMod.headlessList();
  // A headless Hermes session is listed once, as its headless entry (core/launch.js), not again as the conversation it made.
  const headlessHermes = new Set(headless.filter((h) => h.engine === hermes.ENGINE && h.sessionId).map((h) => h.sessionId));
  const out = [
    ...cl.map((s) => ({ ...s, id: s.sessionId, engine: 'claude', live: s.alive })),
    ...codexThreads.map((t) => ({ ...t, id: t.threadId, engine: 'codex', live: t.loaded || /active|running|busy/i.test(t.status) })),
    ...headless.map((h) => ({ ...h, kind: 'headless', engine: h.engine, live: !['exited', 'stopped'].includes(h.status) })),
    ...manager,
    ...bots,
    ...hermesSessions.filter((s) => !headlessHermes.has(s.id)),
  ];
  for (const r of recent) if (!live.has(r.sessionId)) out.push({ ...r, id: r.sessionId, engine: 'claude', live: false, status: 'transcript', cwd: null });
  for (const r of rollouts) if (!codexIds.has(r.threadId)) out.push({ ...r, id: r.threadId, engine: 'codex', live: false, status: 'rollout', cwd: null });
  return { sessions: out, codexError: Array.isArray(cx) ? null : cx.error, host: hosts.localShortName() };
}

async function sessionById(id) {
  // Grok bots (grok:<name>, grok:*) on the host that keeps them; checked first, the name cannot be anything else's.
  if (grok.isGrokTarget(id) && grok.configured()) return grok.findSession(id);
  const s = await claude.findSession(id);
  if (s) return { engine: 'claude', ...s };
  const threads = await readCodexThreads({ limit: 200 }).catch(() => []);
  const t = threads.find((x) => x.threadId === id || x.threadId?.startsWith(id));
  if (t) return { engine: 'codex', ...t };
  const h = launchMod.headlessGet(id);
  if (h) return { engine: h.engine, headless: true, ...h };
  // The OpenClaw manager ("manager", "openclaw"), on a host that has its state dir.
  const manager = await openclaw.findSession(id);
  if (manager) return manager;
  // A Hermes conversation (by id, or its exact title), live or stored, on a host that keeps Hermes state.
  if (hermes.configured()) { const h = await hermes.findSession(id).catch(() => null); if (h) return h; }
  // Not live: maybe a transcript or rollout on disk.
  const recent = await claude.recentTranscripts({ days: 365, limit: 5000 });
  const r = recent.find((x) => x.sessionId === id);
  if (r) return { engine: 'claude', ...r, live: false };
  const roll = (await codex.recentRollouts({ days: 365, limit: 5000 })).find((x) => x.threadId === id);
  if (roll) return { engine: 'codex', ...roll, live: false };
  return null;
}

/**
 * Where a message to a Claude session that is not live goes instead: its handoff chain's live successor
 * (core/lineage.js), plus state, why the session itself cannot take it. null when that does not apply: the session
 * runs, or is not a Claude session. findSession returns a running session ahead of any other that matches, so a
 * target it returns that does not run means none that answers to id does. Only a full session id narrows the chains
 * to that session's own; a name or prefix is looked up across every chain, beside every session listed under it, so
 * one that names several sessions is not narrowed to whichever the lookup found first.
 */
async function handoffSuccessor(id, s) {
  if (s ? s.engine !== 'claude' || s.headless || claude.running(s) : grok.isGrokTarget(id) || openclaw.isManagerId(id)) return null;
  const state = !s ? 'session not found' : !s.socket ? 'no messaging socket' : 'process not alive';
  const exact = s?.sessionId === id;
  let r;
  try {
    const answering = s && !exact ? (await claude.listSessions()).filter((x) => x.sessionId === id || x.name === id || x.sessionId.startsWith(id)).map((x) => ({ id: x.sessionId, name: x.name ?? null })) : [];
    r = await lineage.successor(id, { sessionId: exact ? id : null, answering, registry: await claude.listRegistry() });
  } catch (e) { return { to: null, note: `the handoff chains could not be read, so nothing was redirected (${e.message})`, candidates: [], state }; }
  if (!r.to && !r.note) return null;
  return { ...r, state };
}
/** An error message with what the target's handoff chain holds, when it is in one. */
const withNote = (message, handoff) => (handoff?.note ? `${message}; ${handoff.note}` : message);

// A tmux target that names a window or pane itself: "work:3", "work:@12", "%7".
const WINDOW_TARGET = /^(?:[A-Za-z0-9_.-]+:@?\d+|%\d+)$/;
const windowOf = (t) => String(t).replace(/\.%\d+$/, '');

const NO_PANE = 'this session has no tmux pane; reply with a message instead';
/**
 * The window a session's dialog is on: a window target as given, else a Claude session's registry tmux field. Only
 * Claude sessions name their pane; any other session (Codex, headless, the manager, a bot) is answered with a message,
 * except a Hermes prompt, which its gateway answers (sessions.answer).
 */
async function answerTarget(id) {
  if (WINDOW_TARGET.test(id)) return id;
  const s = await claude.findSession(id);
  if (!s) { if (await sessionById(id)) throw new Error(NO_PANE); throw new Error('session not found'); }
  if (!s.tmux) throw new Error(NO_PANE);
  return windowOf(s.tmux);
}

/**
 * Board data keeps the sessions a board or the alert detector reads: live ones, and dead Claude and headless ones (a
 * session dying is an alert). A Codex thread that is not loaded is neither: 189 of them with their first prompts
 * were 782 KB of every 1.29 MB fleet summary (2026-10-20). A preview is cut to 200 chars either way.
 */
export function slimSessions(list = []) {
  return list.filter((s) => s.live !== false || s.engine === 'claude' || s.kind === 'headless' || s.status === 'dead')
    .map((s) => (typeof s.preview === 'string' && s.preview.length > 200 ? { ...s, preview: s.preview.slice(0, 199) + '…' } : s));
}

/** Local implementations keyed by op name. */
export const local = {
  // ---- host facts
  async 'host.facts'() { return hosts.localFacts(); },
  async 'host.identity'() { const f = await hosts.localFacts(); return { host: f.host, identity: f.identity, node: f.node }; },
  async 'host.version'({ commit } = {}) { return version.hostVersion({ commit }); },
  async 'host.vitals'({ fresh = false } = {}) { return localVitals({ fresh: fresh === true || fresh === 'true' }); },

  // ---- tmux
  async 'tmux.windows'({ classify = true } = {}) {
    const [wins, reg] = await Promise.all([tmux.listWindows(), claude.listRegistry()]);
    // Agent match: registry tmux field is "session:@win.%pane"; match on window id.
    const byWin = new Map();
    for (const r of reg) { const m = r.tmux?.match(/^(.+?):(@\d+)\.(%\d+)$/); if (m) byWin.set(`${m[1]}|${m[2]}`, r); }
    const out = wins.map((w) => {
      const r = byWin.get(`${w.session}|${w.windowId}`);
      return { ...w, agent: r ? { engine: 'claude', sessionId: r.sessionId, name: r.name, status: r.status, pid: r.pid } : (/codex/i.test(w.cmd) ? { engine: 'codex', status: 'unknown' } : null) };
    });
    if (classify && classify !== 'false') {
      // Screen classification for agent windows (idle / busy / dialog) in one pass,
      // so the Home view does not have to capture every pane itself.
      await Promise.all(out.filter((w) => w.agent).map(async (w) => {
        try {
          const text = await tmux.capture(w.target, { lines: 40 });
          w.screen = tmux.classifyScreen(text);
          // Alert inputs: Claude's held-peer-message dialog, the dialog's question and
          // options, and a fingerprint so tmux.answer only answers the screen the owner saw.
          const held = tmux.heldMessage(text);
          if (held) { w.held = true; w.heldFrom = held.from; }
          if (w.screen.state === 'dialog' || held) { w.dialog = tmux.dialogSummary(text); w.hash = tmux.screenHash(text); }
          // Last meaningful lines of the pane (skip Claude's footer/prompt box), for the board strips.
          const lines = text.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim()
            && !/^[╭╰│╮╯─\s>›]+$/.test(l)
            && !/\? for shortcuts|bypass permissions on|accept edits on|plan mode on/i.test(l)
            && (l.match(/\|/g) ?? []).length < 3   /* tmux / claude status lines are pipe-separated */
            && !/^\s*[▶►⏵]{1,2}\s/.test(l));
          w.tail = lines.slice(-3);
        } catch (e) { w.screen = { state: 'unknown', reason: e.message }; w.tail = []; }
      }));
    }
    return out;
  },
  async 'tmux.sessions'() { return tmux.listSessions(); },
  async 'tmux.capture'({ target, lines }) {
    const text = await tmux.capture(target, { lines });
    const screen = tmux.classifyScreen(text), held = tmux.heldMessage(text);
    // A dialog on screen comes with what answering it needs, read from this same capture (native.answerFields).
    const answer = screen.state === 'dialog' || held ? native.answerFields({ screen: screen.state, held: Boolean(held), dialog: tmux.dialogSummary(text), hash: tmux.screenHash(text) }) : {};
    return { target, text, screen, ...answer };
  },
  async 'tmux.send'({ target, text, enter = true, force = false, actor = OWNER }) {
    const r = await tmux.send(target, str(text, 'text', { allowEmpty: true }), { enter, force });
    if (r.ok) await events.append({ type: 'message', to: { kind: 'tmux', host: hosts.localShortName(), id: target }, text, delivery: { ok: true, via: 'tmux paste' } }, { actor });
    return r;
  },
  async 'tmux.keys'({ target, keys }) { return tmux.sendKeys(target, keys); },
  async 'tmux.answer'({ target, key, expect, actor = OWNER }) {
    const r = await tmux.answer(target, str(key, 'key', { max: 20 }), { expect });
    if (r.ok) await events.append({ type: 'message', to: { kind: 'tmux', host: hosts.localShortName(), id: target }, text: `[key ${key}]`, delivery: { ok: true, via: 'tmux answer', question: r.dialog?.question ?? null } }, { actor });
    return r;
  },
  /**
   * Press one key on the dialog a session shows: id is a session (its tmux
   * window is looked up) or a window target. tmux.answer does the rest: it refuses a screen with no dialog, a screen
   * that changed since `expect` was read, and a key the dialog does not take.
   */
  async 'sessions.answer'({ id, key, expect, actor = OWNER }) {
    const sid = str(id, 'id', { max: 200 });
    // A Hermes session's approval or question is held by its gateway, not drawn in a pane: answered there (core/hermes.js answer).
    const h = WINDOW_TARGET.test(sid) || !hermes.configured() || (await claude.findSession(sid)) ? null : await hermes.findSession(sid).catch(() => null);
    if (h) return answerHermes(h, str(key, 'key', { max: 20 }), expect, actor);
    const target = await answerTarget(sid);
    return { ...(await local['tmux.answer']({ target, key, expect, actor })), target };
  },
  async 'tmux.new'({ session, name, cwd, argv }) {
    if (argv !== undefined && (!Array.isArray(argv) || argv.some((a) => typeof a !== 'string'))) throw new Error('argv must be string[]');
    return tmux.newWindow({ session, name, cwd, argv });
  },
  async 'tmux.rename'({ target, name }) { return tmux.renameWindow(target, name); },
  async 'tmux.kill'({ target }) { return tmux.killWindow(target); },

  // ---- sessions (claude + codex + headless)
  // The filters (core/session-filter.js) run here, on the host that holds the sessions, so only what passes travels.
  async 'sessions.list'(args = {}) {
    const r = await listSessionsLocal(args);
    const sessions = args.compact === true || args.compact === 'true' ? slimSessions(r.sessions) : r.sessions;
    if (!filtersGiven(args)) return sessions === r.sessions ? r : { ...r, sessions };
    return { ...r, ...filterSessions(sessions, args) };
  },
  async 'sessions.get'({ id }) { return sessionById(str(id, 'id')); },
  async 'sessions.transcript'({ id, since = 0, limit = 200, thread }) {
    const s = await sessionById(str(id, 'id'));
    if (!s) throw new Error('session not found');
    if (s.headless) return { engine: s.engine, headless: true, turns: headlessTurns(s.events), offset: s.events.length };
    if (s.engine === 'openclaw') return openclaw.transcript({ since, limit, thread });
    if (s.engine === grok.ENGINE) return grok.transcript(s.id, { since, limit });
    if (s.engine === hermes.ENGINE) return hermes.transcript(s, { since, limit });
    if (s.engine === 'claude') { const r = await claude.readTranscript(s.transcript, { since, limit }); return { engine: 'claude', ...r, summary: since ? undefined : await claude.transcriptSummary(s.transcript).catch(() => null) }; }
    // codex: read the rollout file first. thread/read materializes every turn inside the
    // app-server, and on a long session it reached 19 GB in 8 minutes (2026-10-15) and
    // panicked the Mac; the rollout holds the same turns. The app-server is a last resort.
    const file = s.file ?? (await codex.recentRollouts({ days: 365, limit: 5000 })).find((x) => x.threadId === s.threadId)?.file;
    if (file) return { engine: 'codex', ...(await codex.readRollout(file, { limit })), offset: 0 };
    if (s.threadId && s.live !== false) {
      try { const res = await readCodexThread(s.threadId); return { engine: 'codex', turns: codex.threadToTurns(res).slice(-limit), offset: 0 }; } catch { /* no transcript available */ }
    }
    return { engine: 'codex', turns: [], offset: 0 };
  },
  /** The last thing a session said (final assistant text and its last line), cheap: reads the transcript tail. */
  async 'sessions.lastReply'({ id }) {
    const s = await sessionById(str(id, 'id'));
    if (!s) throw new Error('session not found');
    let r = null;
    if (s.headless) {
      const evs = launchMod.headlessGet(s.id)?.events ?? [];
      const turns = headlessTurns(evs).filter((t) => (t.role === 'assistant' || t.role === 'result') && t.text?.trim() && !t.delta);
      const t = turns.at(-1); if (t) r = { text: t.text, ts: t.ts ?? null };
    } else if (s.engine === 'claude') r = await claude.lastAssistantText(s.transcript);
    else if (s.engine === 'openclaw') { const t = (await openclaw.transcript({ limit: 50 })).turns.filter((x) => x.role === 'assistant' && !x.pending).at(-1); if (t) r = { text: t.text, ts: t.ts }; }
    else if (s.engine === grok.ENGINE) r = await grok.lastReply(s.id);
    else if (s.engine === hermes.ENGINE) r = hermes.lastReply(s);
    else if (s.engine === 'codex') {
      const file = s.file ?? (await codex.recentRollouts({ days: 30, limit: 2000 })).find((x) => x.threadId === s.threadId)?.file;
      if (file) { const t = (await codex.readRollout(file, { limit: 40 })).turns?.filter((x) => x.role === 'assistant' && x.text?.trim()).at(-1); if (t) r = { text: t.text, ts: t.ts ?? null }; }
    }
    let ask = null;
    if (s.engine === 'claude' && !s.headless) { const a = await askContextFor({ transcript: s.transcript, tmux: s.tmux }); const { lastText, lastTs, ...rest } = a; ask = rest; }
    // A prompt the Hermes gateway holds is what it waits on, whatever its last reply said.
    else if (s.engine === hermes.ENGINE && s.dialog) ask = classifyAsk({ screenState: 'dialog', dialog: s.dialog });
    else if (r?.text) ask = classifyAsk({ text: r.text });
    // A Grok bot's reply comes marked (core/bots/grok.js provenance): the mark goes with it to whoever asked.
    return r ? { id: s.id ?? s.sessionId ?? s.threadId, name: s.name ?? null, engine: s.engine, text: r.text.slice(-4000), line: claude.lastLine(r.text), ts: r.ts ?? null, ask, ...(r.untrusted === true ? { source: r.source ?? null, untrusted: true } : {}) } : { id: s.id ?? s.sessionId ?? s.threadId, name: s.name ?? null, engine: s.engine, text: null, line: null, ask };
  },
  async 'sessions.message'({ id, text, actor = OWNER, wait, thread }) {
    let s = await sessionById(str(id, 'id'));
    // A Claude session that handed off is gone or dead; its handoff chain says which live session carries on.
    const handoff = await handoffSuccessor(id, s);
    if (!s && !handoff?.to) throw Object.assign(new Error(withNote('session not found', handoff)), handoff ? { candidates: handoff.candidates } : {});
    str(text, 'text');
    let resolved = null;
    if (handoff?.to) {
      const from = handoff.from;
      resolved = {
        resolvedFrom: { given: id, id: from.sessionId, name: from.name, gen: from.gen, state: handoff.state },
        resolvedTo: { id: handoff.to.id, name: handoff.to.name, gen: handoff.to.gen, chain: handoff.chain },
        resolvedWhy: `${from.name ?? id} is not live (${handoff.state}); it is ${handoff.why}`,
      };
      s = { engine: 'claude', ...handoff.to.session };
    }
    // The manager records its own message and reply (core/openclaw.js message): the message at once, the reply
    // as it lands, so wait: false can return before the manager answers and every transcript shows both.
    if (s.engine === 'openclaw') {
      const r = await openclaw.message(text, { actor, thread, wait: !(wait === false || wait === 'false') });
      return { ...r, session: { id: s.id, name: s.name, status: r.pending ? 'busy' : s.status } };
    }
    let delivery;
    try {
      if (s.headless) delivery = await launchMod.headlessSend(s.id, text);
      else if (s.engine === grok.ENGINE) delivery = await grok.send(s.id, text, { actor });
      else if (s.engine === 'claude') delivery = await claude.sendToSession(s, text, { fromName: `drover (${actor})` });
      else if (s.engine === hermes.ENGINE) delivery = await hermes.send(s, text);
      else delivery = await codex.sendTurn(s.threadId, text, { cwd: s.cwd });
    } catch (e) { delivery = { ok: false, error: resolved ? `${e.message} (sent on: ${resolved.resolvedWhy})` : withNote(e.message, handoff) }; }
    const to = { kind: s.engine, host: hosts.localShortName(), id: s.id ?? s.sessionId ?? s.threadId, name: s.name ?? null };
    // A Grok bot answers later, through the bot gateway, quoting ref (its inbox reads this event).
    const ev = await events.append({ type: 'message', to, text, ...(delivery.ref ? { ref: delivery.ref } : {}), delivery, ...resolved }, { actor });
    if (!delivery.ok) throw Object.assign(new Error(delivery.error ?? 'delivery failed'), { event: ev.id }, handoff && !handoff.to ? { candidates: handoff.candidates } : {});
    return { ...delivery, event: ev.id, session: { id: s.id ?? s.sessionId ?? s.threadId, name: s.name, status: s.status }, ...resolved };
  },

  // ---- launch
  async 'launch.profiles'() { return launchMod.loadProfiles(); },
  // The effort levels this host's code accepts. Also the version probe for effort: Drover code from before
  // efforts does not know this op, while it would silently ignore an effort field on launch.start.
  async 'launch.efforts'() { return effortLevels(); },
  async 'launch.start'(args) { return launchMod.launch(args, { actor: args.actor ?? OWNER }); },
  async 'headless.list'() { return launchMod.headlessList(); },
  // Served by the daemon's one reader. Reached in any other process (a peer's rpc,
  // `drover op`), they go to the daemon too: the daemon resolves them locally.
  async 'codex.threads'({ limit, cwd, includeArchived } = {}) {
    return readCodexThreads({ limit: limit === undefined ? undefined : Number(limit), cwd: cwd || undefined, includeArchived: includeArchived === true || includeArchived === 'true' });
  },
  async 'codex.thread'({ threadId }) { return readCodexThread(str(threadId, 'threadId', { max: 200 })); },
  async 'headless.get'({ id }) { return launchMod.headlessGet(str(id, 'id')); },
  async 'headless.send'({ id, text }) { return launchMod.headlessSend(str(id, 'id'), str(text, 'text')); },
  async 'headless.stop'({ id }) { return launchMod.headlessStop(str(id, 'id')); },

  // ---- truth file
  async 'events.state'() { const all = await events.readAll(); return { ...events.fold(all), file: await events.fileInfo() }; },
  async 'events.tail'({ since, limit = 200 }) { const r = await events.since(since); return r.slice(-limit); },
  async 'events.append'({ event, actor = OWNER }) { return events.append(await enrichHookNotify(event), { actor }); },
  async 'events.importLegacy'() { return events.importLegacyFeatureLog(); },
  async 'features.upsert'({ fid, state, title, repo, notes, links, source, untrusted, actor = OWNER }) {
    const ev = { type: 'feature', fid: fid || `feat-${Date.now()}` };
    if (state !== undefined) ev.state = state; if (title !== undefined) ev.title = title; if (repo !== undefined) ev.repo = repo; if (notes !== undefined) ev.notes = notes; if (links !== undefined) ev.links = links;
    // A write from a Grok bot (core/bots/tools.js): the fold keeps the mark on the feature.
    if (untrusted === true) Object.assign(ev, { untrusted: true, ...(typeof source === 'string' && source ? { source: source.slice(0, 80) } : {}) });
    return events.append(ev, { actor });
  },

  // ---- memory
  async 'memory.repos'() { const homes = await memory.memoryHomes(); return Object.entries(homes).map(([repo, home]) => ({ repo, home })); },
  async 'memory.overview'({ repo } = {}) { return memory.overview(repo || undefined); },
  async 'memory.handoff.write'({ repo, text, actor = OWNER }) { return memory.writeHandoff(repo || memory.defaultRepo(), str(text, 'text', { allowEmpty: true }), { actor }); },
  async 'reflections.list'({ repo, all = false, status, kind, session, limit, anyIdentity = false } = {}) { return memory.reflectionsList(repo || undefined, { all: all === true || all === 'true', status, kind, session, limit, anyIdentity: anyIdentity === true || anyIdentity === 'true' }); },
  async 'reflections.search'({ query, repo, status, kind, source, limit, anyIdentity = false }) { return memory.reflectionsSearch(query, { repo, status, kind, source, limit, anyIdentity: anyIdentity === true || anyIdentity === 'true' }); },
  async 'reflections.repos'() { return memory.reflectionsRepos(); },
  async 'reflections.show'({ id }) { return memory.reflectionShow(id); },
  async 'reflections.candidates'(args) { return memory.reflectionsCandidates(args ?? {}); },
  /**
   * Reflections by meaning: this host's search index restricted to reflection items (keyword only while vectors are
   * missing). Where the index cannot answer, the CLI's own keyword search does, with a note saying why: search off,
   * no index yet, or no reflections pass finished there yet (a daemon that just started on this code, or one from
   * before reflections were indexed, whose search ignores the kind and would answer with transcripts).
   */
  async 'reflections.semantic'({ query, repo, status, kind, limit = 20 } = {}) {
    str(query, 'query', { max: 2000 });
    if (kind !== undefined && !memory.REFLECTION_KINDS.includes(kind)) throw new Error(`kind must be one of ${memory.REFLECTION_KINDS.join(', ')}`);
    const st = status === undefined || status === '' ? undefined : memory.reflectionStatusFilter(status);
    let r = null, why = null;
    try { r = await local['search.semantic']({ query, kinds: ['reflection'], limit, ...(repo ? { project: repo } : {}), ...(st ? { status: st } : {}), ...(kind ? { role: kind } : {}) }); }
    catch (e) { why = `the search index could not answer (${e.message})`; }
    if (!why && r?.reflectionsIndexed !== true) why = `reflections are not indexed on ${r?.host ?? hosts.localShortName()} yet`;
    if (why) {
      const cli = await memory.reflectionsSearch(query, { repo, status: st, kind, source: 'reflection', limit: Math.max(1, Math.min(100, Number(limit) || 20)) });
      return { host: hosts.localShortName(), query, vector: 'off', notes: [`${why}; these are the reflections CLI's keyword matches`],
        items: cli.items.map((x) => ({ id: x.id, status: x.status ?? null, repo: x.repo ?? null, kind: x.kind ?? null, title: x.title ?? null, snippet: x.snippet ?? null, score: null, updatedAt: x.updated_at ?? null, origin: x.origin ?? null, sessionId: x.session_id ?? null })) };
    }
    return { host: r.host, query: r.query, vector: r.vector, notes: r.notes ?? [],
      items: (r.results ?? []).filter((x) => x.kind === 'reflection').map((x) => ({ id: x.id ?? x.ref, status: x.status ?? null, repo: x.repo ?? x.project ?? null, kind: x.role ?? null, title: x.title ?? null, snippet: x.snippet, score: x.score, updatedAt: x.ts ?? null, origin: x.origin ?? null, sessionId: x.sessionId ?? null })) };
  },
  async 'reflections.add'(args) { return memory.reflectionAdd(args); },
  async 'reflections.mark'({ op, ids, note, actor }) { return memory.reflectionMark(op, ids, { note, actor }); },
  async 'reflections.edit'(args) { return memory.reflectionEdit(args); },
  async 'reflections.apply'({ ops, repo, anyRepo, note, actor }) { return memory.reflectionsApply(ops, { repo, anyRepo, note, actor }); },

  // ---- Grok bots (core/bots): read-only. Approving a bot, revoking it and setting a Routine are main-token HTTP
  // routes (server/http.js /api/bots/*), never ops: an op is reachable through MCP and ssh rpc.
  async 'bots.status'() {
    let base = null, configError = null;
    try { base = botAuth.publicBase(); } catch (e) { configError = e.message; }
    const host = hosts.localShortName(), keepsBots = grok.configured();
    const [grants, routines, bots] = await Promise.all([botAuth.grantsList(), grok.routines(), keepsBots ? grok.listSessions({ host }) : []]);
    return {
      host, keepsBots, gateway: base ? { publicUrl: base, mcp: `${base}/mcp`, port: botAuth.gatewayPort() } : null, ...(configError ? { configError } : {}),
      pendingApprovals: botAuth.pendingList().length, grants, routines,
      bots: bots.map((b) => ({ id: b.id, name: b.name, state: b.state, summary: b.summary, task: b.task, status: b.status, lastSeenAt: b.lastSeenAt, routine: b.routine, live: b.live, ...(b.stale ? { stale: b.stale } : {}) })),
    };
  },

  // ---- Hermes Agent (core/hermes.js)
  async 'hermes.status'() { return hermes.status(); },

  // ---- terminals (ttyd)
  async 'terminals.list'() { return { available: await terminals.ttydAvailable(), terminals: terminals.list() }; },
  async 'terminals.open'({ target, readOnly = false }) { return terminals.open(target, { readOnly }); },
  async 'terminals.close'({ id }) { return terminals.close(str(id, 'id')); },
};

/** sessions.answer for a Hermes session: the gateway answers the prompt it holds; an answer that went through is recorded as a message. */
async function answerHermes(s, key, expect, actor) {
  const r = await hermes.answer(s, key, { expect });
  if (r.ok) await events.append({ type: 'message', to: { kind: hermes.ENGINE, host: hosts.localShortName(), id: s.id, name: s.name ?? null }, text: `[${r.choice ? `approval: ${r.choice}` : `answer: ${r.answer}`}]`, delivery: { ok: true, via: r.via, question: r.dialog?.question ?? null } }, { actor });
  return { ...r, target: s.id };
}

function headlessTurns(evs = []) {
  const out = [];
  for (const e of evs) {
    if (e.type === 'user') out.push({ role: 'user', ts: e.ts, text: e.text });
    else if (e.type === 'assistant') { const c = e.message?.content ?? []; const t = c.filter((b) => b.type === 'text').map((b) => b.text).join('\n'); const tools = c.filter((b) => b.type === 'tool_use').map((b) => ({ name: b.name })); if (t || tools.length) out.push({ role: 'assistant', ts: e.ts, text: t, tools }); }
    else if (e.type === 'result') out.push({ role: 'result', ts: e.ts, text: e.result?.slice?.(0, 2000) ?? '', cost: e.total_cost_usd, turns: e.num_turns });
    else if (e.type === 'item/agentMessage/delta') out.push({ role: 'assistant', ts: e.ts, text: e.params?.delta ?? '' , delta: true });
    else if (e.type === 'item/completed' && e.params?.item?.type === 'agentMessage') out.push({ role: 'assistant', ts: e.ts, text: e.params.item.text ?? e.params.item.content ?? '' });
    else if (e.type === 'exit') out.push({ role: 'system', ts: e.ts, text: `exited ${e.code}` });
    // A headless Hermes turn (core/hermes.js HeadlessHermes): its stream-json, the text deltas of one reply joined.
    else if (e.type === 'hermes/user') out.push({ role: 'user', ts: e.ts, text: e.text });
    else if (e.type === 'hermes/text') { const last = out.at(-1); if (last?.role === 'assistant' && last.hermesText) last.text += e.text ?? ''; else out.push({ role: 'assistant', ts: e.ts, text: e.text ?? '', tools: [], hermesText: true }); }
    else if (e.type === 'hermes/tool_use') out.push({ role: 'assistant', ts: e.ts, text: '', tools: [hermes.streamToolCall(e)] });
    else if (e.type === 'hermes/tool_result') { const o = hermes.toolOutput(e.output); out.push({ role: 'tool_result', ts: e.ts, count: 1, text: (o.failed || e.is_error ? '[error] ' : '') + o.text.slice(0, 400) }); }
    else if (e.type === 'hermes/result') out.push({ role: 'result', ts: e.ts, text: String(e.text ?? '').slice(0, 2000), turns: null });
    else if (e.type === 'hermes/error') out.push({ role: 'system', ts: e.ts, text: `hermes exited ${e.code}${e.text ? `: ${e.text}` : ''}` });
  }
  return out.map(({ hermesText, ...t }) => t);
}

/** Ops that must never be forwarded (they are about the front itself). */
const FRONT_ONLY = new Set(['host.list', 'host.probe', 'fleet.summary', 'fleet.vitals', 'fleet.place', 'fleet.versions', 'native.summary', 'native.board', 'native.notifications', 'search.fleet', 'search.grepFleet', 'docker.fleet']);

// Per-host board data goes through the shared cache (stale-while-revalidate,
// persisted) so the board renders at once and a down host still shows its last
// known windows, falling back to the tmux inventory file synced with the dotfiles (cache.tmuxInventoryFallback).
async function hostSummary(host, { maxAgeMs, fresh = false }) {
  const name = host || hosts.LOCAL;
  const key = cache.keyFor('fleet.host', {}, { host: name });
  const loader = async () => {
    const t0 = Date.now();
    try {
      const [sess, wins, recent] = await Promise.all([
        callOn(host, 'sessions.list', { includeRecent: false, compact: true }, dispatchLocal, { timeoutMs: 25_000 }),
        callOn(host, 'tmux.windows', { classify: true }, dispatchLocal, { timeoutMs: 25_000 }),
        // That host's own alerts (its daemon's detector ring). An older host without the op answers an error: fine.
        host ? callOn(host, 'notify.recent', { limit: 60 }, dispatchLocal, { timeoutMs: 15_000 }).catch(() => null) : null,
      ]);
      // Slimmed here too: a host whose Drover predates compact sends every session.
      return { host: name, ok: true, ms: Date.now() - t0, sessions: slimSessions(sess.sessions ?? []), codexError: sess.codexError ?? null, windows: wins, notify: recent, ts: new Date().toISOString() };
    } catch (e) {
      const inv = name === hosts.LOCAL ? null : await cache.tmuxInventoryFallback(name).catch(() => null);
      return { host: name, ok: false, ms: Date.now() - t0, error: e.message, sessions: [], windows: inv?.windows ?? [], fallback: inv ? { source: inv.source, ts: inv.ts } : null, ts: new Date().toISOString() };
    }
  };
  const r = await cache.get(key, loader, { ttl: maxAgeMs, maxStale: 24 * 3600_000, fresh });
  return { ...r.value, cache: r.meta };
}

/**
 * fleet.versions in this process: the hosts are search.fleet's (the ones named, or local plus every fleet host that
 * answered the last probe), and each remote row is answered by this process's ssh peer there, so its contains covers
 * the ops this process sends that host too. With commit and no hosts named, everywhere is true only when every fleet
 * host answered and contains it; coverage names the hosts that could not be asked. A named subset gets no everywhere
 * (it would read as the fleet's): its rows say it.
 */
async function fleetVersionsHere({ hosts: names, commit: wanted } = {}) {
  const commit = version.commitArg(wanted);
  const { targets, known } = await fleetTargets(names);
  const t0 = Date.now();
  const perHost = (await askHosts(targets, 'host.version', commit ? { commit } : {}, (r) => r)).map(({ results: _r, ...p }) =>
    (!p.ok && /unknown op host\.version/.test(p.error ?? '') ? { ...p, error: `${p.host} runs Drover code from before host.version: update Drover there (${UPDATE_HINT})` } : p));
  const coverage = fleetCoverage({ known, targets, perHost, probes: lastProbe, chosen: Boolean(names?.length), vectors: false });
  const verdict = !commit ? {} : names?.length ? { commit }
    : { commit, everywhere: perHost.every((p) => p.ok && p.contains === true) && !coverage.notCovered.length };
  return { ts: new Date().toISOString(), ms: Date.now() - t0, ...verdict, hosts: perHost, coverage };
}

export const front = {
  async 'host.list'({ includeSsh = false } = {}) {
    const base = await hosts.knownHosts({ includeSsh: includeSsh === true || includeSsh === 'true' });
    // Hosts that are not ssh aliases join from their provider's cached list (core/plugins.js hosts); never blocks.
    const extra = (await Promise.all(plugins.hostProviders().map((p) => Promise.resolve(p.entries?.()).catch(() => [])))).flat();
    return [...base, ...extra.filter(Boolean)];
  },
  async 'host.probe'({ hosts: names } = {}) {
    const known = await hosts.knownHosts();
    const targets = (names?.length ? names : known.map((h) => h.name)).filter((n) => n !== hosts.LOCAL);
    for (const t of targets) await hosts.assertKnownHost(t);
    const r = await hosts.probeAll(targets);
    rememberProbe(r);
    cache.get(cache.keyFor('host.probe.last'), async () => [...lastProbe.values()], { fresh: true }).catch(() => {});
    return r;
  },
  /**
   * Board data for several hosts at once: sessions + classified tmux windows per
   * host, in parallel, cached ~15 s. Hosts default to local plus whichever fleet
   * hosts answered the last probe (so a dead box does not stall the board).
   */
  async 'fleet.summary'({ hosts: names, maxAgeMs = 15_000, includeUnprobed = false, fresh = false } = {}) {
    const known = await hosts.knownHosts();
    let targets;
    if (names?.length) { for (const t of names) await hosts.assertKnownHost(t); targets = names; }
    else {
      targets = [hosts.LOCAL, ...known.filter((h) => h.name !== hosts.LOCAL && (includeUnprobed || lastProbe.get(h.name)?.up)).map((h) => h.name)];
    }
    const results = await Promise.all(targets.map((h) => hostSummary(h === hosts.LOCAL ? '' : h, { maxAgeMs, fresh: fresh === true || fresh === 'true' }).then((r) => ({ ...r, host: h }))));
    return { ts: new Date().toISOString(), hosts: results };
  },
  /**
   * search.semantic on several hosts in parallel, merged by score with identical
   * chunks folded together. Hosts default to local plus every fleet host that
   * answered the last probe (as fleet.summary does), so a dead box costs nothing.
   * A plugin's remote source (the brain) is asked here, once, beside the fan-out,
   * and fused in by rank (core/search/remote.js); the hosts are told not to.
   */
  async 'search.fleet'({ hosts: names, host: named, query, limit = 20, ...rest } = {}) {
    str(query, 'query', { max: 2000 });
    const lim = Math.max(1, Math.min(100, Number(limit) || 20));
    const t0 = Date.now();
    const leg = remoteSearch.begin({ ...rest, query, limit: lim }, { hosts: names, host: named });
    const [fleet, rem] = await Promise.all([leg.local ? searchHosts(names, leg.localArgs) : noHosts(names), leg.done]);
    const results = remoteSearch.withRemote(mergeHosts(fleet.perHost, { limit: lim }), rem.lists, lim);
    return { query, ms: Date.now() - t0, results, perHost: fleet.perHost.map(({ results: r, ...h }) => ({ ...h, hits: r.length })), coverage: fleet.coverage, ...(rem.remote ? { remote: rem.remote } : {}) };
  },
  /** search.grep on several hosts in parallel (same host choice as search.fleet), newest hit first. */
  async 'search.grepFleet'({ hosts: names, host: _host, pattern, limit = 50, ...rest } = {}) {
    str(pattern, 'pattern', { max: 300 });
    const { targets, known } = await fleetTargets(names);
    const lim = Math.max(1, Math.min(200, Number(limit) || 50));
    const t0 = Date.now();
    const perHost = await askHosts(targets, 'search.grep', { ...rest, pattern, limit: lim },
      (r, { host, route }) => ({ results: (r.results ?? []).map((x) => ({ ...x, host, route })), matched: r.matched ?? 0, skipped: r.skipped ?? null, truncated: Boolean(r.truncated), notes: r.notes ?? [], searchMs: r.ms ?? null }));
    const results = perHost.flatMap((p) => p.results).sort((a, b) => String(b.ts ?? '').localeCompare(String(a.ts ?? ''))).slice(0, lim);
    const coverage = fleetCoverage({ known, targets, perHost, probes: lastProbe, chosen: Boolean(names?.length), vectors: false });
    return { pattern, ms: Date.now() - t0, results, perHost: perHost.map(({ results: r, ...h }) => ({ ...h, hits: r.length })), coverage };
  },
  /**
   * docker.stacks on several hosts in parallel (the host choice of search.fleet). Each host's answer is cached under the
   * key a single-host docker.stacks uses, so the fleet, the Stacks view and an MCP call share one answer per host, a
   * host that cannot answer now shows its last answer with the error (coverage.partial), and fresh reaches every host.
   * The answer is a summary unless services is true: a fleet's per-container detail runs to half a megabyte (423
   * containers on 2026-10-20), more than an agent can read; docker.stacks on one host gives it.
   */
  async 'docker.fleet'({ hosts: names, project, git, fresh = false, services = false } = {}) {
    const { targets, known } = await fleetTargets(names);
    const t0 = Date.now();
    const args = { ...(project ? { project } : {}), ...(git === false || git === 'false' ? { git: false } : {}) };
    const full = services === true || services === 'true';
    const perHost = (await Promise.all(targets.map((h) => hostStacks(h, args, { fresh: fresh === true || fresh === 'true' }))))
      .map((p) => (full || !p.stacks ? p : { ...p, stacks: p.stacks.map(({ services: svcs, oneoff, ...st }) => ({ ...st, serviceCount: svcs?.length ?? 0, oneoffCount: oneoff?.length ?? 0 })) }));
    const coverage = fleetCoverage({ known, targets, perHost, probes: lastProbe, chosen: Boolean(names?.length), vectors: false });
    for (const p of perHost) if (p.ok && p.cache?.error) coverage.partial.push({ host: p.host, reason: `showing its answer from ${Math.round((p.cache.age ?? 0) / 60_000)} min ago; refreshing failed: ${String(p.cache.error).slice(0, 160)}` });
    const totals = {};
    for (const p of perHost) for (const [k, v] of Object.entries(p.totals ?? {})) totals[k] = (totals[k] ?? 0) + v;
    return { ts: new Date().toISOString(), ms: Date.now() - t0, hosts: perHost, totals, coverage };
  },
  /**
   * host.vitals on every machine of this machine's identity that the fleet catalog has monitoring on for (local plus
   * the fleet hosts that answered the last probe when there is no catalog), in parallel. Each host's answer is cached,
   * so one that cannot answer shows its last sample, marked stale, with its age.
   */
  async 'fleet.vitals'({ hosts: names, fresh = false } = {}) {
    const t0 = Date.now(), f = fresh === true || fresh === 'true';
    const { cat, me, targets } = await fleetHostsFor('monitor', names);
    const rows = await Promise.all(targets.map(async (t) => {
      const t1 = Date.now();
      try {
        if (t.local) return vitalsRow(t, await localVitals({ fresh: f }), { ok: true, ms: Date.now() - t1 });
        const r = await remoteVitals(t.route, { fresh: f });
        return vitalsRow(t, r.value, { ok: !r.meta.error, ms: Date.now() - t1, age: r.meta.age, ...(r.meta.error ? { error: String(r.meta.error).slice(0, 300), stale: true } : {}) });
      } catch (e) { return vitalsRow(t, null, { ok: false, ms: Date.now() - t1, error: String(e.message).slice(0, 300) }); }
    }));
    return { ts: new Date().toISOString(), ms: Date.now() - t0, identity: me.identity, catalog: cat.found ? cat.file : null, ...(cat.errors.length ? { catalogErrors: cat.errors } : {}), hosts: rows };
  },
  /**
   * host.version on the fleet's hosts in parallel (fleetVersionsHere), so "is this fix live everywhere?" is one call.
   * Outside the daemon the daemon answers: its ssh peers carry the board's and the sessions' ops and can predate a
   * pull, while a peer this process opened now would always be current. When this machine's daemon runs but does not
   * answer (busy, or from before this op), the answer made here says so in note and its everywhere is null: those
   * peers were not asked. Never cached: the answer changes when a host pulls or restarts.
   */
  async 'fleet.versions'(args = {}) {
    version.commitArg(args.commit);
    const ep = await daemonEndpoint();
    if (ep) {
      try { return await callDaemon(ep, 'fleet.versions', args, { timeoutMs: 60_000 }); }
      catch (e) { if (!(e.unreachable || (e.fromDaemon && /unknown op/i.test(e.message)))) throw e; }
    }
    const r = await fleetVersionsHere(args);
    const d = await version.daemonInfo();
    if (!d?.running || d.pid === process.pid) return r;
    return { ...r, ...('everywhere' in r ? { everywhere: null } : {}), note: `answered outside this machine's daemon (pid ${d.pid}), which did not answer: its ssh peers, which carry the board's and the sessions' ops, were not asked` };
  },
  /**
   * Where the next workload of a class should run: among this identity's catalog hosts with a placement policy, the
   * eligible one with the most headroom (core/placement.js judge). host is "local" for this machine, else the ssh
   * alias to reach it, or null when no host is eligible (reason says why for each). Outside the daemon the daemon
   * answers, through its warm ssh peers, so a call stays under ten seconds.
   */
  async 'fleet.place'(args = {}) {
    const ep = await daemonEndpoint();
    if (ep) {
      try { return await callDaemon(ep, 'fleet.place', args, { timeoutMs: 8_000 }); }
      catch (e) { if (!(e.unreachable || (e.fromDaemon && /unknown op/i.test(e.message)))) throw e; }
    }
    return placeHere(args);
  },
};

// ---------------------------------------------------------------- vitals and placement (core/vitals.js, core/placement.js)
/** This machine's vitals: the daemon's last sample when it is recent, else one taken now and graded against this host's thresholds. */
async function localVitals({ fresh = false } = {}) {
  const v = fresh ? null : await vitals.latest();
  if (v) return v;
  const pol = await placement.monitorPolicy({ shortName: hosts.localShortName() });
  const s = await vitals.sample({ ignore: pol.thresholds.ignore });
  return { ...s, checks: vitals.evaluate(s, pol.thresholds), monitor: { enabled: pol.enabled, raised: vitals.monitorInfo()?.raised ?? [] } };
}

/** Another host's vitals through the cache: { value, meta }. maxAgeMs set: never older than that (placement). */
function remoteVitals(route, { fresh = false, maxAgeMs = null, timeoutMs = 15_000 } = {}) {
  const key = cache.keyFor('fleet.vitals.host', {}, { host: route });
  const opts = maxAgeMs ? { ttl: maxAgeMs, maxStale: maxAgeMs, fresh } : { ttl: 30_000, maxStale: 7 * 86400_000, fresh };
  return cache.get(key, () => callOn(route, 'host.vitals', {}, dispatchLocal, { timeoutMs }), opts);
}

function vitalsRow(t, v, extra) {
  const checks = Array.isArray(v?.checks) ? v.checks : [];
  return { host: t.display, route: t.route, ...extra, level: v ? vitals.worstLevel(checks) : 'unknown', problems: checks.filter((c) => c.level !== 'ok').map(({ key, level, text }) => ({ key, level, text })), raised: v?.monitor?.raised ?? [], vitals: v };
}

/**
 * The machines a fleet vitals or placement call reads, as { route, display, local, entry }: the hosts named (vitals
 * only), else this identity's catalog hosts with monitoring on (and this machine) or with a placement policy, else,
 * with no catalog, this machine plus the fleet hosts that answered the last probe.
 */
async function fleetHostsFor(purpose, names) {
  const cat = await placement.loadCatalog();
  const me = await placement.whoAmI(cat, hosts.localShortName());
  const localT = { route: 'local', display: me.entry?.name ?? hosts.localShortName(), local: true, entry: me.entry };
  const isLocal = (n) => n === hosts.LOCAL || me.names.has(String(n).toLowerCase()) || (me.entry ? placement.hostNames(me.entry).includes(String(n).toLowerCase()) : false);
  const targets = [];
  if (names?.length) {
    for (const n of names) {
      if (isLocal(n)) { if (!targets.some((t) => t.local)) targets.push(localT); continue; }
      const entry = cat.hosts.find((h) => placement.hostNames(h).includes(String(n).toLowerCase())) ?? null;
      // A named host is read only when this identity may see it: with a catalog, one of this fleet's own machines.
      if (cat.invalid && !cat.found) throw new Error(`${n} cannot be read: this machine's fleet catalog is invalid (${cat.errors[0] ?? cat.file})`);
      if (cat.found && !(entry && placement.sameFleet(cat, me.identity, entry))) throw new Error(`${n} is not a host of this machine's fleet${me.identity ? ` (${me.identity})` : ' (this machine has no identity in the catalog)'}`);
      const route = entry?.ssh ?? n;
      await hosts.assertKnownHost(route);
      targets.push({ route, display: entry?.name ?? n, local: false, entry });
    }
  } else if (cat.found) {
    for (const h of placement.scoped(cat, me.identity)) {
      const isMe = h === me.entry;
      const wanted = purpose === 'monitor' ? isMe || h.monitor?.enabled === true : h.placement && typeof h.placement === 'object';
      if (wanted) targets.push(isMe ? localT : { route: h.ssh ?? h.name, display: h.name, local: false, entry: h });
    }
    if (purpose === 'monitor' && !targets.some((t) => t.local)) targets.unshift(localT);
  } else if (cat.invalid) {
    // The catalog exists but does not parse: no identity can be checked, so nothing beyond this machine is read.
    if (purpose === 'monitor') targets.push(localT);
  } else {
    await probeRestored;
    const known = await hosts.knownHosts();
    targets.push(localT, ...known.filter((h) => h.name !== hosts.LOCAL && lastProbe.get(h.name)?.up).map((h) => ({ route: h.name, display: h.name, local: false, entry: null })));
  }
  return { cat, me, targets };
}

/** One candidate's vitals for placement: this machine's, or another's no older than 45 s; null with why when it cannot answer. */
async function vitalsForPlacement(t) {
  try {
    if (t.local) return { vitals: await localVitals(), error: null };
    // The daemon probes every two minutes: a host it just found down is not waited for.
    const p = notifier.daemon ? lastProbe.get(t.route) : null;
    if (p && p.up === false && Date.now() - p.ts < 5 * 60_000) return { vitals: null, error: `down at the last probe${p.error ? `: ${p.error}` : ''}` };
    const r = await remoteVitals(t.route, { maxAgeMs: 45_000, timeoutMs: 6_000 });
    if (r.meta.error) return { vitals: null, error: r.meta.error };
    const age = Date.now() - Date.parse(r.value?.ts ?? '');
    if (!(age < 5 * 60_000)) return { vitals: null, error: `its last sample is ${Number.isFinite(age) ? `${Math.round(age / 60_000)} min` : 'of unknown'} age` };
    return { vitals: r.value, error: null };
  } catch (e) { return { vitals: null, error: e.message }; }
}

const given = (v) => v !== undefined && v !== null && v !== '';

// Memory placed on each host in the last few minutes (fleet.place reserve: true), which its vitals may not show yet: a
// sample can be up to 150 s old on the host and 45 s more in this cache, so back-to-back launches would all see the
// same free memory and pile onto one host. Kept in the process that answers fleet.place (the daemon, when one runs).
const RESERVE_MS = 4 * 60_000;
const reserved = new Map();   // route -> [{ ts, gb }]
/** Tests: forget every reservation. */
export const _resetReservations = () => reserved.clear();
function reservedGB(route, now = Date.now()) {
  const list = (reserved.get(route) ?? []).filter((r) => now - r.ts < RESERVE_MS);
  if (list.length) reserved.set(route, list); else reserved.delete(route);
  return list.reduce((n, r) => n + r.gb, 0);
}

/** Hold gb on route for the next few minutes (a launch placed there); returns what is held there now. */
function placeReserve(route, gb) {
  reserved.set(route, [...(reserved.get(route) ?? []), { ts: Date.now(), gb }]);
  return Math.round(reservedGB(route) * 10) / 10;
}

async function placeHere({ class: className = 'claude-session', exclude = [], prefer, needMemGB, reserve = false } = {}) {
  const t0 = Date.now();
  const { cat, me, targets } = await fleetHostsFor('placement');
  const classes = placement.classesOf(cat);
  const base = classes[className];
  if (!base) throw new Error(`unknown class ${JSON.stringify(className)}: one of ${Object.keys(classes).join(', ')}`);
  const cls = given(needMemGB) ? { ...base, needMemGB: Number(needMemGB) } : base;
  if (!Number.isFinite(Number(cls.needMemGB)) || Number(cls.needMemGB) < 0) throw new Error('needMemGB must be a number of GB');
  const ex = new Set((Array.isArray(exclude) ? exclude : [exclude]).filter((s) => typeof s === 'string' && s).map((s) => s.toLowerCase()));
  const namesOf = (t) => [t.route, t.display, ...(t.entry ? placement.hostNames(t.entry) : []), ...(t.local ? ['local', ...me.names] : [])].map((n) => String(n).toLowerCase());
  const excluded = targets.filter((t) => namesOf(t).some((n) => ex.has(n)));
  const judged = await Promise.all(targets.filter((t) => !excluded.includes(t)).map(async (t) => {
    const { vitals: v, error } = await vitalsForPlacement(t);
    const route = t.local ? 'local' : t.route;
    return { name: route, display: t.display, ...placement.judge({ vitals: v, policy: t.entry?.placement ?? {}, cls, className, error, pendingMemGB: reservedGB(route) }) };
  }));
  // The caller's own machine wins a near tie unless another is preferred: moving work costs something.
  const pref = !given(prefer) || targets.find((t) => namesOf(t).includes(String(prefer).toLowerCase()))?.local ? 'local' : String(prefer);
  const best = placement.choose(judged, { prefer: pref });
  return {
    ...(best && (reserve === true || reserve === 'true') ? { reserved: placeReserve(best.name, Number(cls.needMemGB) || 0) } : {}),
    host: best?.name ?? null, alias: best?.display ?? null, class: className, identity: me.identity, reason: placement.reasonFor(best, judged, className), score: best?.score ?? 0,
    candidates: judged.map(({ name, display, eligible, score, why, facts }) => ({ host: name, name: display, eligible, score, why, facts })),
    ...(excluded.length ? { excluded: excluded.map((t) => t.display) } : {}), ...(cat.found ? {} : { catalog: null }), ms: Date.now() - t0,
  };
}

// ssh's own words for a connection that never opened: the launch did not reach the host, so placing it again is safe.
const NEVER_CONNECTED = /connect to host .* (timed out|Connection refused|No route to host)|Could not resolve hostname|Network is unreachable/i;

/**
 * launch.start with host "auto": fleet.place for the launch's class (placement, else the engine's session class), then
 * the launch there. A chosen host that turns out to be unreachable (its vitals were recent, the host went down since)
 * is excluded and the launch placed once more; any other failure is the caller's, since the launch may have started.
 */
async function launchPlaced(args) {
  const { placement: placementClass, placementExclude, ...launchArgs } = args;
  const className = placementClass || ({ codex: 'codex-session', hermes: 'hermes-session' })[launchArgs.engine] || 'claude-session';
  const exclude = (Array.isArray(placementExclude) ? placementExclude : placementExclude ? [placementExclude] : []).map(String);
  let failed = null;
  for (let attempt = 0; ; attempt++) {
    const p = await front['fleet.place']({ class: className, reserve: true, ...(exclude.length ? { exclude } : {}) });
    if (!p.host) throw new Error(`nothing was started: ${p.reason}${failed ? `; before that ${failed}` : ''}`);
    try {
      const r = p.host === 'local' ? await dispatchLocal('launch.start', launchArgs) : await dispatch('launch.start', { ...launchArgs, host: p.host });
      return { ...r, placement: { host: p.host === 'local' ? hosts.localShortName() : p.host, class: className, reason: p.reason, ...(failed ? { retriedAfter: failed } : {}) } };
    } catch (e) {
      if (p.host === 'local' || attempt > 0 || !NEVER_CONNECTED.test(String(e?.message ?? ''))) throw e;
      failed = `${p.host} could not be reached (${String(e.message).slice(0, 160)})`;
      exclude.push(p.host);
    }
  }
}

/**
 * One host's docker.stacks through the read cache (see docker.fleet). A host that cannot answer and has nothing cached is
 * { ok: false, error }; one that runs Drover from before these ops is named as such.
 */
async function hostStacks(h, args, { fresh }) {
  const remote = h !== hosts.LOCAL;
  const host = remote ? h : hosts.localShortName(), route = remote ? h : 'local';
  const t1 = Date.now();
  const key = cache.keyFor('docker.stacks', remote ? { ...args, host: h } : args, { host: remote ? h : undefined });
  try {
    // A provider's host without Drover cannot answer the rpc (exit 97); its provider reads docker there instead.
    const provider = plugins.hostProvider(h);
    const load = () => callOn(remote ? h : '', 'docker.stacks', args, dispatchLocal, { timeoutMs: 45_000 })
      .catch((e) => (provider?.dockerStacks && /exited 97|Drover not installed/.test(e.message ?? '') ? provider.dockerStacks(h, args) : Promise.reject(e)));
    const r = await cache.get(key, load, { ttl: CACHE_POLICY['docker.stacks'], maxStale: 24 * 3600_000, fresh });
    return { ...r.value, host, route, ok: true, ms: Date.now() - t1, cache: r.meta };
  } catch (e) {
    const error = /unknown op docker\.stacks/.test(e.message ?? '') ? `${h} runs Drover code from before docker stacks: update Drover there (${UPDATE_HINT})` : e.message;
    return { host, route, ok: false, ms: Date.now() - t1, error, stacks: [] };
  }
}

/**
 * The hosts a fleet-wide search asks: the ones named, or local plus every fleet host that answered the last probe.
 * Never probed on this machine (and no persisted probe): probe once now rather than silently searching only here.
 */
async function fleetTargets(names) {
  const known = await hosts.knownHosts();
  if (names?.length) { for (const t of names) await hosts.assertKnownHost(t); return { targets: names, known }; }
  await probeRestored;
  const others = known.filter((h) => h.name !== hosts.LOCAL).map((h) => h.name);
  if (!lastProbe.size) rememberProbe(await hosts.probeAll(others).catch(() => []));
  return { targets: [hosts.LOCAL, ...others.filter((n) => lastProbe.get(n)?.up)], known };
}

/** search.fleet's index searches: search.semantic on the fleet's hosts (args say remote: false), { perHost, coverage }. */
async function searchHosts(names, args) {
  const { targets, known } = await fleetTargets(names);
  const perHost = await askHosts(targets, 'search.semantic', args,
    (r, { route }) => ({ results: (r.results ?? []).map((x) => ({ ...x, route })), vector: r.vector ?? null, index: r.index ?? null, notes: r.notes ?? [], searchMs: r.ms ?? null }));
  return { perHost, coverage: fleetCoverage({ known, targets, perHost, probes: lastProbe, chosen: Boolean(names?.length), vectors: args.mode !== 'keyword' }) };
}
/** A search for remote kinds only (kinds: ["brain"]) asks no host; hosts it names must still be known. */
async function noHosts(names) {
  for (const t of names ?? []) await hosts.assertKnownHost(t);
  return { perHost: [], coverage: { searched: [], notCovered: [], partial: [] } };
}

/**
 * One op on every target host in parallel, this one included. A host answers { host, ok, ms, ...shape(r, where) },
 * or { host, ok: false, ms, error, results: [] } when it failed; where.host is the name its hits are shown under (this
 * machine's short name for local), where.route the alias to open a hit's session with (a host's own hostname need not
 * be an ssh alias). ms is the round trip from here; the search shapes add searchMs, the host's own time, so a slow
 * link or a busy front daemon is told apart from a slow host (ui/fleet-time.js).
 */
async function askHosts(targets, op, args, shape) {
  return Promise.all(targets.map(async (h) => {
    const host = h === hosts.LOCAL ? hosts.localShortName() : h, route = h === hosts.LOCAL ? 'local' : h;
    const t1 = Date.now();
    try {
      const r = await callOn(h === hosts.LOCAL ? '' : h, op, args, dispatchLocal, { timeoutMs: 45_000 });
      return { host, ok: true, ms: Date.now() - t1, ...shape(r, { host, route }) };
    } catch (e) { return { host, ok: false, ms: Date.now() - t1, error: e.message, results: [] }; }
  }));
}

/**
 * What a fleet search could not see, so an empty answer is honest: every fleet host that was not asked (down at the
 * last probe, with its error) or that failed, and in partial the hosts that answered without vectors (keyword only).
 * Hosts from a host provider (core/plugins.js) are left out unless asked for by name: they come and go, and most run
 * no Drover. With hosts chosen by the caller, only those count.
 */
export function fleetCoverage({ known = [], targets = [], perHost = [], probes = new Map(), chosen = false, vectors = true } = {}) {
  const asked = new Set(targets);
  const notCovered = [], partial = [];
  if (!chosen) {
    for (const h of known) {
      if (h.name === hosts.LOCAL || h.ephemeral || plugins.hostProvider(h.name) || asked.has(h.name)) continue;
      const p = probes.get(h.name);
      notCovered.push({ host: h.name, reason: p ? `down at the last probe${p.error ? `: ${String(p.error).slice(0, 120)}` : ''}` : 'never probed' });
    }
  }
  for (const p of perHost) {
    if (!p.ok) notCovered.push({ host: p.host, reason: String(p.error ?? 'failed').slice(0, 200) });
    else if (vectors && p.vector && p.vector !== 'ok') partial.push({ host: p.host, reason: `keyword only (vectors ${p.vector})` });
  }
  return { searched: perHost.filter((p) => p.ok).map((p) => p.host), notCovered, partial };
}

const lastProbe = new Map(); // host -> { up, ms, ts }
export function rememberProbe(list) { for (const p of list) lastProbe.set(p.host, { ...p, ts: Date.now() }); }
// Restore the last probe from the persisted cache so a restarted daemon (or a fresh CLI / MCP
// process, which shares the cache directory) knows which hosts answered. Awaitable: search.fleet
// in a one-shot `drover search` must not pick its hosts before this lands.
const probeRestored = (async () => { const p = await cache.get(cache.keyFor('host.probe.last'), async () => [], { ttl: Infinity, maxStale: Infinity }).catch(() => null); if (p?.value?.length) rememberProbe(p.value); })();

/** Dispatch an op locally. */
export async function dispatchLocal(op, args = {}) {
  const fn = local[op] ?? front[op];
  if (!fn) throw new Error(`unknown op ${op}${typeof op === 'string' && op.startsWith('docker.') ? `: ${docker.NOT_OFFERED}` : ''}`);
  return fn(args ?? {});
}

/**
 * How long a forwarded op may take on the other host. Ops that move git objects over the network get as long as a
 * launch (a plugin names its own: core/plugins.js hostTimeoutMs), the docker verbs stop
 * their own docker within 110 s (core/docker.js), and remote.js keeps a retired peer alive longer than any of these
 * (150 s). files.wait gets its whole wait plus a minute for ssh, the remote rpc starting and the last stat pass. Run
 * from `drover op` it has a peer of its own, which nothing else can retire; through a daemon (where MCP caps it at
 * 110 s) a longer wait would still end at 150 s if a rollout retired that peer under it.
 */
const HOST_TIMEOUT_MS = { 'docker.restart': 120_000, 'docker.start': 120_000, 'docker.exec': 120_000, 'docker.run': 120_000 };
export function hostTimeoutMs(op, args = {}) {
  if (op === 'files.wait') return waitLimits(args).timeoutSec * 1000 + 60_000;
  return HOST_TIMEOUT_MS[op] ?? (op.startsWith('launch') ? 120_000 : 60_000);
}

/**
 * search.semantic as the front answers it: a plugin's remote source (the brain) is asked here, once, beside the index
 * search on the host named (this one by default), and its hits fused in by rank (core/search/remote.js). The index
 * search goes out with remote: false and without callerCwd, so the host, or this host's daemon behind the search
 * service, does not ask the source again; a call for remote kinds only searches no index.
 */
async function semanticFront(host, args) {
  const t0 = Date.now();
  str(args.query, 'query', { max: 2000 });
  const leg = remoteSearch.begin(args, { host });
  const indexSearch = (a) => (!host || host === hosts.LOCAL ? dispatchLocal('search.semantic', a) : callOn(host, 'search.semantic', a, dispatchLocal, { timeoutMs: hostTimeoutMs('search.semantic', a) }));
  const noIndex = async () => {
    if (host) await hosts.assertKnownHost(host);
    return { host: hosts.localShortName(), query: args.query, mode: ['keyword', 'semantic'].includes(args.mode) ? args.mode : 'hybrid', vector: null, results: [], sessions: [], notes: [] };
  };
  const [r, rem] = await Promise.all([leg.local ? indexSearch(leg.localArgs) : noIndex(), leg.done]);
  if (!rem.remote) return r;
  const limit = Math.max(1, Math.min(100, Number(args.limit) || 20));
  return { ...r, ...(leg.local ? {} : { ms: Date.now() - t0 }), results: remoteSearch.withRemote(r.results ?? [], rem.lists, limit), remote: rem.remote };
}

/** Dispatch with host routing: {host:'box-a'} forwards to that box's drover rpc. */
export async function dispatch(op, args = {}) {
  const { host, ...rest } = args ?? {};
  // host "auto": the fleet's placement picks the machine (core/placement.js), then the launch goes there.
  if (op === 'launch.start' && host === 'auto') return launchPlaced(rest);
  // A search's remote sources are asked here, at the front, only when the call says remote: true (core/search/remote.js);
  // any other search, a host's over rpc or an older client's, searches the index alone. callerCwd, which only the
  // front's work guard reads, never goes on to another host. search.fleet runs here whatever host it names, but its
  // guard still reads that host.
  if (op === 'search.semantic') {
    if (remoteSearch.frontCall(rest)) return semanticFront(host, rest);
    delete rest.callerCwd;
  }
  if (op === 'search.fleet' && host !== undefined) rest.host = host;
  // A docker op this table does not have (down, rm, kill, ...) is refused here, never forwarded for another host to refuse.
  if (typeof op === 'string' && op.startsWith('docker.') && !local[op] && !front[op]) return dispatchLocal(op, rest);
  if (FRONT_ONLY.has(op) || !host || host === hosts.LOCAL) return dispatchLocal(op, rest);
  if (op === 'sessions.answer') return answerOn(host, rest);
  // A manager on another host answers inside the call (its drover rpc is not the daemon, so wait: false waits there):
  // give it the manager's own 15-minute budget, not the minute every other forwarded op gets.
  if (op === 'sessions.message' && openclaw.isManagerId(rest.id)) return callOn(host, op, rest, dispatchLocal, { timeoutMs: 905_000 });
  if (op === 'launch.start' && rest.engine === hermes.ENGINE) await requireHermesLaunch(host);
  else if (op === 'launch.start' && effortGiven(rest.effort)) await requireLaunchEfforts(host);
  if (op === 'files.wait') return callOn(host, op, rest, dispatchLocal, { timeoutMs: hostTimeoutMs(op, rest) }).catch((e) => {
    throw /unknown op files\.wait/.test(e?.message ?? '') ? new Error(`${host} runs Drover code from before files.wait: update Drover there (${UPDATE_HINT})`) : e;
  });
  return callOn(host, op, rest, dispatchLocal, { timeoutMs: hostTimeoutMs(op, rest) });
}

/**
 * sessions.answer on another host. A host whose Drover predates the op answers "unknown op" (after callOn has
 * retired a stale peer once, core/remote.js): then the window is looked up there with sessions.get and the key
 * pressed with tmux.answer, which every host has, so a dialog anywhere can be answered before every box updates.
 */
async function answerOn(host, args) {
  try { return await callOn(host, 'sessions.answer', args, dispatchLocal, { timeoutMs: hostTimeoutMs('sessions.answer') }); }
  catch (e) {
    if (!/unknown op sessions\.answer/.test(e?.message ?? '')) throw e;
    const id = str(args.id, 'id', { max: 200 });
    let target = WINDOW_TARGET.test(id) ? id : null;
    if (!target) {
      const s = await callOn(host, 'sessions.get', { id }, dispatchLocal, { timeoutMs: 25_000 });
      if (!s) throw new Error('session not found');
      // As answerTarget: only a Claude session's registry names its pane, so the fallback presses nothing the op would not.
      if ((s.engine ?? 'claude') !== 'claude' || !s.tmux) throw new Error(NO_PANE);
      target = windowOf(s.tmux);
    }
    const r = await callOn(host, 'tmux.answer', { target, key: args.key, expect: args.expect, actor: args.actor }, dispatchLocal, { timeoutMs: hostTimeoutMs('tmux.answer') });
    return { ...r, target };
  }
}

/**
 * Before a Hermes launch goes to another host, make sure the code that will run it launches Hermes: older code reads
 * any engine but codex as claude and would start a Claude session. Code that launches Hermes knows hermes.status (an
 * effort on the launch is covered too: it came with efforts), and callOn first retires a peer that predates the
 * host's update, so only a host that really runs old code is refused, and nothing is started there.
 */
async function requireHermesLaunch(host) {
  try { await callOn(host, 'hermes.status', {}, dispatchLocal, { timeoutMs: 60_000 }); }
  catch (e) {
    if (/unknown op hermes\.status/.test(e?.message ?? '')) throw new Error(`${host} runs Drover code that cannot launch Hermes (it would start Claude instead), so nothing was started; update Drover there (${UPDATE_HINT})`);
    throw e;
  }
}

/**
 * Before a launch with an effort goes to another host, make sure the code that will run it knows efforts.
 * An older daemon (pre-rename apxw included) would drop the unknown field and start the agent at its default effort; it answers
 * "unknown op launch.efforts" instead, and callOn first retires a peer that predates the host's update
 * (core/remote.js), so only a host that really runs old code is refused, and nothing is started there.
 */
async function requireLaunchEfforts(host) {
  try { await callOn(host, 'launch.efforts', {}, dispatchLocal, { timeoutMs: 60_000 }); }
  catch (e) {
    if (/unknown op launch\.efforts/.test(e?.message ?? '')) {
      throw new Error(`${host} runs Drover code that cannot set a launch effort (it does not know launch.efforts), so nothing was started; update Drover there (${UPDATE_HINT}) or launch without effort`);
    }
    throw e;
  }
}

/**
 * Read ops served through the stale-while-revalidate cache (ttl in ms). A
 * cached answer comes back at once; if it is older than ttl the daemon refreshes
 * behind it. Pass `fresh: true` to force a load. Mutations invalidate below.
 */
export const CACHE_POLICY = {
  'tmux.windows': 5_000, 'tmux.sessions': 10_000, 'sessions.list': 10_000, 'sessions.get': 10_000,
  'host.facts': 60_000, 'host.identity': 600_000, 'host.list': 60_000, 'launch.profiles': 60_000,
  'events.state': 5_000, 'events.tail': 5_000, 'memory.overview': 30_000, 'memory.repos': 300_000,
  'reflections.list': 30_000, 'reflections.repos': 30_000, 'terminals.list': 5_000, 'headless.list': 3_000,
  'credentials.status': 3_000, 'survey.list': 10_000,
  'files.roots': 30_000, 'openclaw.status': 30_000, 'openclaw.check': 30_000, 'openclaw.feed': 10_000, 'native.summary': 5_000, 'native.board': 3_000, 'openclaw.threads': 3_000,
  'docker.stacks': 30_000, 'hermes.status': 10_000,
};
const INVALIDATES = {
  'tmux.send': ['tmux.'], 'tmux.keys': ['tmux.'], 'tmux.new': ['tmux.', 'fleet.'], 'tmux.kill': ['tmux.', 'fleet.'], 'tmux.rename': ['tmux.', 'fleet.'],
  'sessions.message': ['events.', 'openclaw.threads'], 'launch.start': ['sessions.', 'tmux.', 'fleet.', 'events.', 'headless.', 'credentials.'],
  'headless.send': ['headless.', 'events.'], 'headless.stop': ['headless.', 'sessions.', 'fleet.'],
  'events.append': ['events.'], 'events.importLegacy': ['events.'], 'features.upsert': ['events.'],
  'memory.handoff.write': ['memory.', 'events.'], 'reflections.add': ['reflections.', 'memory.'], 'reflections.mark': ['reflections.', 'memory.'],
  'reflections.edit': ['reflections.', 'memory.'], 'reflections.apply': ['reflections.', 'memory.'],
  'terminals.open': ['terminals.'], 'terminals.close': ['terminals.'],
  'credentials.throttle': ['credentials.'], 'survey.run': ['survey.', 'events.'],
  'tmux.answer': ['tmux.', 'fleet.', 'events.', 'native.'], 'sessions.answer': ['tmux.', 'fleet.', 'events.', 'native.'],
  'settings.set': ['settings.', 'events.'], 'settings.reset': ['settings.', 'events.'], 'notify.mute': ['settings.', 'events.'], 'notify.unmute': ['settings.', 'events.'],
  'notify.test': ['notify.', 'events.'], 'notify.send': ['notify.', 'events.'],
  'openclaw.sweep': ['openclaw.', 'events.'],
  'uploads.put': ['uploads.', 'events.'], 'uploads.remove': ['uploads.', 'events.'], 'files.write': ['files.', 'events.'],
  'docker.restart': ['docker.'], 'docker.start': ['docker.'], 'docker.exec': ['docker.'], 'docker.run': ['docker.'],
};

// Keys whose value is a secret, the redactor's list ("credentials" plural only, so a launch's credential pool id stays).
const SECRET_KEY = /token|secret|passw(?:or)?d|api[-_]?key|access[-_]?key|private[-_]?key|authorization|credentials/i;
// A long flag whose value is a credential (--password x, --github-token x, --client-secret x). Short flags are left
// alone: -p is a port to docker and a password only to a few tools.
const SECRET_FLAG = /^--(?:[\w-]*[-_])?(?:token|password|passwd|secret|api[-_]?key|access[-_]?key|private[-_]?key|authorization|credentials?)$/i;

// Text is redacted over its first WAL_WINDOW characters only: the log keeps 240, and some redaction rules cost the
// square of a long run (a 2 MB tmux.send text took minutes and froze the daemon inside the log write).
const WAL_WINDOW = 2048;
const walText = (s) => native.redactSecrets(s.slice(0, WAL_WINDOW), { hexSafe: true });

/**
 * One value for the op log, which syncs to every host: secret-named keys dropped and secrets redacted at any depth
 * (an exec argv, a nested env, a text), text redacted before it is trimmed so a cut never leaves half a secret, lists
 * and nesting capped.
 */
function walValue(v, depth = 0) {
  if (typeof v === 'string') { const r = walText(v); return r.length > 240 || v.length > WAL_WINDOW ? `${r.slice(0, 240)}… (+${v.length - 240})` : r; }
  if (Array.isArray(v)) return depth >= 4 ? '<list>' : v.slice(0, 20).map((x, i) => walItem(v[i - 1], x, depth + 1));
  if (v && typeof v === 'object') return depth >= 4 ? '<object>' : Object.fromEntries(Object.entries(v).filter(([k]) => !SECRET_KEY.test(k)).map(([k, x]) => [k, walValue(x, depth + 1)]));
  return v;
}

/**
 * One list item, read with the one before it: an argv value is redacted on its own, so the value after a credential
 * flag is withheld outright, and -u user:pass (curl) keeps the user (a docker uid:gid, digits:digits, stays).
 */
function walItem(prev, x, depth) {
  if (typeof x === 'string' && typeof prev === 'string') {
    if (SECRET_FLAG.test(prev)) return '[redacted]';
    if (prev === '-u' || prev === '--user') return walValue(x.replace(/^(?!\d+:\d+$)([^:]*:)[\s\S]+/, '$1[redacted]'), depth);
  }
  return walValue(x, depth);
}

/** Compact copy of args for the op log: no secrets, long text trimmed, event bodies summarized. */
function walArgs(args) {
  const out = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    if (SECRET_KEY.test(k)) continue;
    // File bodies never reach the WAL: uploads keep path + bytes (in their own event), writes keep a hash.
    if (k === 'data' || k === 'content') out[k] = typeof v === 'string' ? `<${v.length} chars>` : '<omitted>';
    else if (k === 'event' && v && typeof v === 'object') out[k] = walValue({ type: v.type, ...(v.fid && { fid: v.fid }), ...(v.target && { target: v.target }), ...(v.about && { about: v.about }) });
    // A reflections.apply batch: which op on which id (edit bodies stay in the reflections log, not here).
    else if (k === 'ops' && Array.isArray(v) && v.some((o) => o && typeof o === 'object')) out[k] = v.slice(0, 50).map((o) => walValue(o && typeof o === 'object' ? { op: o.op, id: o.id } : o));
    else out[k] = walValue(v);
  }
  return out;
}
/** Every mutating op is written to the truth file as an `op` event (the WAL): who did what, where, with what result. */
async function wal(op, args, { ok, ms, error, result }) {
  if (op === 'events.append' || op === 'events.importLegacy') return; // those are WAL writes already
  try {
    const summary = result && typeof result === 'object' ? Object.fromEntries(Object.entries(result).filter(([k, v]) => ['ok', 'refused', 'target', 'headlessId', 'sessionId', 'threadId', 'id', 'event', 'via', 'queuedBehindTurn', 'turnId', 'number', 'url', 'credential', 'effort', 'ref', 'sha', 'branch', 'running', 'project', 'service', 'verb', 'count', 'exitCode', 'timedOut'].includes(k) && (typeof v !== 'object' || v === null)).map(([k, v]) => [k, k === 'url' ? walValue(v) : v])) : undefined;   // a URL can carry user:password@; the rest are ids
    await events.append({ type: 'op', op, target: args?.host ?? 'local', args: walArgs(args), ok, ms, ...(error && { error: walText(String(error)).slice(0, 300) }), ...(summary && { result: summary }) }, { actor: args?.actor ?? OWNER });
  } catch { /* the WAL must never break the op */ }
}

/** A write: recorded in the truth file wherever it runs. */
export const isWrite = (op) => isMutating(op) || Boolean(INVALIDATES[op]);

/**
 * Run an op the way every front must: a write (a mutating op, or one that drops cache entries) is recorded in the
 * truth file with its actor and outcome, and the cache entries it touches are dropped; a read passes straight through,
 * uncached. The daemon reaches this through dispatchCached; the CLI and the MCP server with no daemon to answer call
 * it directly, so their writes are recorded too. actor: who, when the args name nobody (the WAL's default is the owner).
 */
export async function dispatchRecorded(op, args = {}, { actor } = {}) {
  const inv = INVALIDATES[op];
  if (!isWrite(op)) return dispatch(op, args);
  const rec = actor && !args?.actor ? { ...args, actor } : args ?? {};
  const t0 = Date.now();
  let result;
  try { result = await dispatch(op, rec); }
  catch (e) { await wal(op, rec, { ok: false, ms: Date.now() - t0, error: e.message }); throw e; }
  if (inv) cache.invalidate(...inv);
  await wal(op, rec, { ok: true, ms: Date.now() - t0, result });
  cache.invalidate('events.');
  return result;
}

/** Dispatch with caching: returns { result, cache } where cache is the SWR metadata (null for uncached ops). */
export async function dispatchCached(op, args = {}) {
  const { fresh, ...rest } = args ?? {};
  const ttl = CACHE_POLICY[op], force = fresh === true || fresh === 'true';
  // An uncached op that keeps its own cache (fleet.summary, or a plugin's) still has to hear fresh.
  if (!ttl) return { result: await dispatchRecorded(op, force ? { ...rest, fresh: true } : rest), cache: null };
  const key = cache.keyFor(op, rest, { host: rest.host });
  const r = await cache.get(key, () => dispatch(op, rest), { ttl, fresh: force });
  return { result: r.value, cache: r.meta };
}

Object.assign(local, survey.ops, credentialOps, settingsOps, notifyOps, uploadOps, fileOps, fileWaitOps, openclaw.consoleOps, native.ops, searchOps, docker.ops);
survey._deps.dispatch = (op, args) => dispatch(op, args);
native._deps.dispatch = (op, args) => dispatch(op, args);
native._deps.localNames = () => new Set([hosts.localShortName(), hostname().split('.')[0]]);
local['cache.stats'] = async () => cache.stats();
local['cache.invalidate'] = async ({ ops: prefixes } = {}) => ({ dropped: cache.invalidate(...(Array.isArray(prefixes) && prefixes.length ? prefixes : ['']) ) });
export { cache, notifier };

export const OPS = [...Object.keys(local), ...Object.keys(front)];

/**
 * Load the plugins (core/plugins.js) once and add their ops, metadata, cache rules and host timeouts to this table.
 * Every entry point that dispatches (the daemon, drover op / rpc / mcp / search, the tests that need a plugin) awaits
 * this first; a plugin's op that collides with a core op is refused, so a plugin can add but never replace.
 */
export async function loadPlugins(opts) {
  const list = await plugins.load(opts);
  for (const p of list) applyPlugin(p);
  return list;
}

const applied = new WeakSet();
/** Add one loaded plugin's ops and rules (loadPlugins, and tests that plugins.register a definition). */
export function applyPlugin(p) {
  if (applied.has(p)) return;
  applied.add(p);
  const own = new Set();
  const add = (table, ops = {}, isFront = false) => {
    for (const [op, fn] of Object.entries(ops ?? {})) {
      if (typeof fn !== 'function') continue;
      if (local[op] || front[op]) { plugins.errors().push({ dir: p.dir, error: `plugin ${p.name}: op ${op} is already defined` }); continue; }
      table[op] = fn; OPS.push(op); own.add(op);
      if (isFront) FRONT_ONLY.add(op);
    }
  };
  add(local, p.ops); add(front, p.front, true);
  // How an op is cached, routed and timed belongs to the plugin that defines it: a rule for any other op (a core op, or
  // one of its own that was refused above) is refused, so a plugin cannot turn a core write into a cached read.
  const mine = (field, op) => { if (own.has(op)) return true; plugins.errors().push({ dir: p.dir, error: `plugin ${p.name}: ${field} for ${op}, which is not its op` }); return false; };
  for (const op of p.frontOnly ?? []) if (mine('frontOnly', op)) FRONT_ONLY.add(op);
  for (const [op, ttl] of Object.entries(p.cachePolicy ?? {})) if (Number.isFinite(ttl) && mine('cachePolicy', op)) CACHE_POLICY[op] = ttl;
  for (const [op, ms] of Object.entries(p.hostTimeoutMs ?? {})) if (Number.isFinite(ms) && mine('hostTimeoutMs', op)) HOST_TIMEOUT_MS[op] = ms;
  // A write may also drop a plugin's cached answers (a core write such as events.append making the plugin's reads
  // stale): that adds to what the op already drops, never replaces it. A core read stays a read: invalidations would
  // make it count as a write (isWrite), recorded and never cached.
  for (const [op, prefixes] of Object.entries(p.invalidates ?? {})) if (Array.isArray(prefixes) && (isWrite(op) || mine('invalidates', op))) INVALIDATES[op] = [...new Set([...(INVALIDATES[op] ?? []), ...prefixes])];
  addMeta(p.meta ?? {});
}
