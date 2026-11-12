// The ask ops (docs/ask.md). ask.create records a question where it is asked; the hub (DROVER_ASK_HUB) texts it and
// routes the answer back (core/ask/router.js). ask.deliver and ask.mark are the hub's calls to the asking host, over
// the ssh rpc peer it already holds; agents use ask.create, ask.get, ask.list, ask.cancel and ask.status.
import * as events from '../events.js';
import * as hosts from '../hosts.js';
import * as placement from '../placement.js';
import { envvar } from '../envvars.js';
import { uuidv7 } from '../ids.js';
import { publicBase } from '../bots/oauth.js';
import { workPattern, workIdentity } from '../search/remote.js';
import { foldAsks, normalizeQuestions, URGENCY, CHANNELS, deliveryText, closedText, clip } from './model.js';
import { readConfig, pauseState } from './policy.js';
import { router, _deps as routerDeps } from './router.js';
import { ADAPTERS } from './channels/index.js';
import * as hubkey from './hubkey.js';

const MAX_LIFE_MS = 14 * 86_400_000;
/**
 * The hub's own calls to the asking host. They reach a host only through its ssh rpc peer (`drover rpc`, which the
 * hub holds); the MCP tools, `drover op` and the daemon's HTTP API refuse them, so an agent cannot plant an answer
 * through them. (A process of the same user can still write the truth file itself: docs/ask.md, trust.)
 */
export const HUB_ONLY_OPS = new Set(['ask.deliver', 'ask.mark']);

// In a `drover rpc` process (bin/drover sets it) a hub-only op is served only when it carries the hub's signature over
// what it says (core/ask/hubkey.js): whatever a process on this host can set (SSH_CONNECTION, its own or its parent's
// name, even a real sshd above it) proves nothing about the caller. Null in the daemon and in-process callers, which
// reach the ops only through the router (every public surface refuses them first). A process of the same user that
// rewrites the truth file, Drover itself or this host's settings is past any op's reach: docs/ask.md, trust.
let rpcCaller = null;
/** bin/drover rpc: this process serves the ops an ssh peer sends; hub-only ones need the hub's signature. */
export async function serveRpc() { rpcCaller = { rpc: true }; }
export const _resetRpc = () => { rpcCaller = null; };
/** The hub's calls are taken over rpc only when signed by a key this host's settings name (DROVER_ASK_HUB_KEY). */
function assertFromHub(op, args) {
  if (!rpcCaller) return null;
  const keys = hubkey.trustedKeys(_deps.env);
  if (!keys.length) throw new Error(`refused: ${op} is the ask hub's call and this host has no DROVER_ASK_HUB_KEY to check it with (set it to the key \`drover ask status\` prints on the hub)`);
  const by = hubkey.verifyCall(op, args, args?.sig, keys);
  if (!by) throw new Error(`refused: ${op} carries no valid signature of the ask hub (DROVER_ASK_HUB_KEY)`);
  return by;
}
export const hubOnlyRefusal = (op) => new Error(`refused: ${op} is the ask hub's own call to the asking host; ask with ask.create (drover_ask)`);

export const _deps = {
  dispatch: null,        // (op, args) => this host's op (api.js dispatchLocal)
  call: null,            // (host, op, args, {timeoutMs}) => that host's op ('local' runs here)
  notify: null,          // (alert) => raise an alert (api.js: notifier.emit)
  readEvents: () => events.readAll(),
  append: (ev, actor = 'ask') => events.append(ev, { actor }),
  now: () => Date.now(),
  hostName: () => hosts.localShortName().toLowerCase(),
  env: process.env,
};

const sameHost = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
const config = () => readConfig(_deps.env);
export const isHub = () => { const h = config().hub; return Boolean(h) && (sameHost(h, _deps.hostName()) || sameHost(h, hosts.localShortName()) || h === 'local'); };
const state = async () => foldAsks(await _deps.readEvents());
const str = (v, name, max = 200) => { if (v === undefined || v === null || v === '') return null; if (typeof v !== 'string' || v.length > max) throw new Error(`${name} must be a string of at most ${max} characters`); return v; };

/** The hosts the hub reads asks from: DROVER_ASK_HOSTS, else the fleet hosts of this machine's identity. */
export async function askHosts() {
  const explicit = String(envvar('ASK_HOSTS', _deps.env) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (explicit.length) return explicit;
  const known = (await hosts.knownHosts()).map((h) => h.name).filter((n) => n && n !== hosts.LOCAL);
  let cat = null;
  try { cat = await placement.loadCatalog(); } catch { /* no catalog: the fleet as listed */ }
  if (!cat?.hosts?.length) return known;
  const me = await placement.whoAmI(cat, hosts.localShortName());
  // Never across identities: a work fleet's questions do not go out through the owner's personal channels.
  const mine = new Set(placement.scoped(cat, me.identity).flatMap(placement.hostNames));
  return known.filter((n) => mine.has(n.toLowerCase()));
}

// The router runs with this host's ops and the truth file (env follows _deps.env, so tests can swap it).
Object.defineProperty(routerDeps, 'env', { get: () => _deps.env, configurable: true, enumerable: true });
Object.assign(routerDeps, {
  append: (ev) => _deps.append(ev, 'ask'),
  readEvents: () => _deps.readEvents(),
  call: (host, op, args, opts) => _deps.call(host, op, args, opts),
  askHosts,
  hostName: () => _deps.hostName(),
  now: () => _deps.now(),
  publicBase: () => { try { return publicBase(_deps.env); } catch { return null; } },
});

/**
 * Page the owner (core/ask/router.js page): only the hub texts, with its router running; anywhere else it is skipped
 * (the alert on the owner's screens still went out). Never throws: a page is a courtesy next to that alert.
 */
export async function pageOwner(p) {
  try {
    if (!isHub()) return { skipped: 'not the ask hub' };
    if (!router.running) return { skipped: 'the ask router is not running here' };
    return await router.page(p);
  } catch (e) { return { error: clip(e.message, 200) }; }
}
/** The source needs nobody now: drop its pages not texted yet. Never throws. */
export async function withdrawPages(source) {
  try {
    if (!isHub() || !router.running) return { withdrawn: 0 };
    return await router.withdrawPages(source);
  } catch (e) { return { error: clip(e.message, 200) }; }
}

/** How the hub hears each channel's replies: a webhook URL on the bot gateway, polling, or the imsg watch. */
function inboundModes() {
  const base = routerDeps.publicBase();
  const tg = ADAPTERS.telegram.inboundMode({ publicBase: base, env: _deps.env });
  const sm = ADAPTERS.sms.inboundMode({ publicBase: base, env: _deps.env });
  return {
    telegram: tg === 'webhook' ? `webhook ${base}/hooks/telegram` : 'long poll',
    sms: sm === 'webhook' ? `webhook ${base}/hooks/twilio/sms` : 'reads the Twilio message log',
    imessage: 'imsg watch',
  };
}

/** An ask as the ops return it: what it asks, where it stands, the answer with its provenance. */
export function view(a, { full = false } = {}) {
  // The answer is every question's first answer (several replies may have answered a multi-question ask).
  const merged = (a.merged ?? []).filter(Boolean);
  const ans = a.answers[0] ? { ...a.answers[0], answers: merged.length ? merged : a.answers[0].answers } : null;
  return {
    askId: a.askId, code: a.code, status: a.status, origin: a.origin, sessionId: a.sessionId, sessionName: a.sessionName,
    questions: a.questions, urgency: a.urgency, channels: a.channels ?? null, createdAt: a.createdAt, createdBy: a.createdBy, expiresAt: a.expiresAt, routedAt: a.routedAt, closedAt: a.closedAt, ...(a.why ? { why: a.why } : {}),
    answer: ans ? { answers: ans.answers, source: ans.source, channel: ans.channel, sender: ans.sender, providerMessageId: ans.providerMessageId, verified: true, ts: ans.ts, ...(full ? { raw: ans.raw } : {}) } : null,
    ...(a.followUps.length ? { followUps: a.followUps.map((f) => ({ answers: f.answers, source: f.source, ts: f.ts, ...(full ? { raw: f.raw } : {}) })) } : {}),
    texted: a.sends.filter((s) => s.ok && s.kind !== 'ack').map((s) => ({ channel: s.channel, kind: s.kind, ts: s.ts })),
    ...(full ? { sends: a.sends.map(({ messageIds: _m, ...s }) => s), deliveries: a.deliveries, untrustedReplies: a.inbound.filter((x) => x.untrusted).length } : { delivered: a.deliveries.some((d) => d.ok) }),
    ...(full && a.cwd ? { cwd: a.cwd } : {}),
  };
}

function lookup(st, { askId, code }) {
  if (askId) return st.asks.get(askId) ?? null;
  if (code) {
    const c = String(code).toUpperCase();
    const list = [...st.asks.values()].filter((a) => a.code === c).sort((x, y) => ((x.routedAt ?? '') < (y.routedAt ?? '') ? 1 : -1));
    return list.find((a) => a.status === 'open') ?? list[0] ?? null;
  }
  throw new Error('give askId or code');
}

/** Why this ask must not be texted, or null: a machine of the work identity, or words that look like work. */
function fenced(fields) {
  if (workIdentity()) return 'this machine\'s identity is work; its questions are not texted';
  const { re } = workPattern();
  if (!re) return null;
  const hit = fields.filter((v) => typeof v === 'string').find((v) => re.test(v));
  return hit ? 'this ask looks like work (DROVER_WORK_CONTEXT), so it is not texted; raise it with notify.send instead' : null;
}

export const ops = {
  /** Put a question to the owner by text. Returns at once; the answer comes as a message to sessionId. */
  async 'ask.create'(args = {}) {
    const { question, options, questions, sessionId, sessionName, urgency = 'normal', expiresAt, ttlMinutes, channels, cwd, actor = 'mcp' } = args;
    const qs = normalizeQuestions({ question, options, questions });
    if (!URGENCY.includes(urgency)) throw new Error('urgency must be normal or urgent');
    let chans = channels;
    if (typeof chans === 'string') chans = chans.split(',').map((c) => c.trim()).filter(Boolean);
    if (chans !== undefined && chans !== null && (!Array.isArray(chans) || !chans.length || chans.some((c) => !CHANNELS.includes(c)))) throw new Error(`channels must be a list of ${CHANNELS.join(', ')}`);
    str(sessionId, 'sessionId'); str(sessionName, 'sessionName', 120); str(cwd, 'cwd', 1000);
    const now = _deps.now();
    let expires;
    if (expiresAt !== undefined && expiresAt !== null && expiresAt !== '') {
      expires = Date.parse(expiresAt);
      if (!Number.isFinite(expires)) throw new Error('expiresAt must be an ISO 8601 time');
    } else if (ttlMinutes !== undefined && ttlMinutes !== null && ttlMinutes !== '') {
      const m = Number(ttlMinutes);
      if (!Number.isFinite(m) || m <= 0) throw new Error('ttlMinutes must be a positive number');
      expires = now + m * 60_000;
    } else expires = now + config().ttlMs;
    if (expires <= now + 60_000) throw new Error('expiresAt must be at least a minute away');
    if (expires > now + MAX_LIFE_MS) throw new Error('an ask lives at most 14 days');
    const why = fenced([...qs.flatMap((q) => [q.question, ...q.options]), cwd, sessionName]);
    if (why) throw new Error(why);
    let name = sessionName ?? null;
    if (sessionId && !name) { try { name = (await _deps.dispatch('sessions.get', { id: sessionId }))?.name ?? null; } catch { /* the name is a nicety */ } }
    const st = await state();
    // The same question from the same session while the first is open is that ask, not a second text.
    const same = JSON.stringify(qs);
    const dup = [...st.asks.values()].find((a) => a.status === 'open' && a.sessionId === (sessionId ?? null) && sameHost(a.origin, _deps.hostName()) && JSON.stringify(a.questions) === same);
    if (dup) return { ...view(dup), deduped: true, hub: config().hub };
    const askId = uuidv7();
    await _deps.append({ type: 'ask', phase: 'created', askId, origin: _deps.hostName(), sessionId: sessionId ?? null, sessionName: name, ...(cwd ? { cwd } : {}), questions: qs, urgency, expiresAt: new Date(expires).toISOString(), ...(chans ? { channels: chans } : {}), createdAt: new Date(now).toISOString(), createdBy: actor }, actor);
    // Every Drover client shows it as waiting on the owner too (the board, the phone, the watch).
    try { await _deps.notify?.({ category: 'needs-you', kind: 'ask', source: 'agent', actor, host: _deps.hostName(), sessionId: sessionId ?? null, name: name ?? actor, title: `${name ?? 'An agent'} asks: ${clip(qs[0].question, 140)}`, body: qs.map((q, i) => `${qs.length > 1 ? `${i + 1}) ` : ''}${q.question}${q.options.length ? ` [${q.options.join(' / ')}]` : ''}`).join(' ').slice(0, 600), key: `ask|${askId}` }); } catch { /* the alert is extra */ }
    const hub = config().hub;
    let routed = null;
    if (isHub() && router.running) routed = await router.takeNow(askId);
    const out = view((await state()).asks.get(askId));
    return {
      ...out, hub,
      ...(routed ? { sent: routed.sent, held: routed.held } : {}),
      note: !hub ? 'no ask hub is configured (DROVER_ASK_HUB): recorded and raised as an alert, not texted'
        : routed ? (routed.sent.length ? `texted as ${out.code} on ${routed.sent.map((s) => s.channel).join(', ')}` : `held: ${routed.held.map((h) => h.why).join(', ')}`)
        : isHub() ? 'the hub\'s daemon texts it on its next tick (about 15 s)'
        : `${hub} texts it on its next sweep (about 15 s); the answer comes to ${sessionId ? `session ${name ?? sessionId}` : 'nobody: no sessionId, read it with ask.get'}`,
    };
  },

  async 'ask.get'({ askId, code, full = false } = {}) {
    const a = lookup(await state(), { askId, code });
    if (!a) throw new Error('no such ask here');
    return view(a, { full: full === true || full === 'true' });
  },

  /** Asks on this host. status: open (default), answered, closed (answered, cancelled, expired), all. */
  async 'ask.list'({ status = 'open', sessionId, mine = false, recentMs, limit = 50, full = false } = {}) {
    const st = await state();
    const now = _deps.now();
    const recent = Number(recentMs) > 0 ? Number(recentMs) : 0;
    const want = (a) => {
      if (sessionId && a.sessionId !== sessionId) return false;
      if ((mine === true || mine === 'true') && !sameHost(a.origin, _deps.hostName())) return false;
      if (status === 'all') return true;
      if (status === 'closed') return a.status !== 'open';
      if (status === 'answered') return a.status === 'answered';
      return a.status === 'open' || (recent && a.closedAt && now - Date.parse(a.closedAt) < recent);
    };
    const list = [...st.asks.values()].filter(want).sort((x, y) => ((x.createdAt ?? x.routedAt ?? '') < (y.createdAt ?? y.routedAt ?? '') ? 1 : -1));
    const n = Math.max(1, Math.min(500, Number(limit) || 50));
    return { host: _deps.hostName(), hub: config().hub, matched: list.length, asks: list.slice(0, n).map((a) => view(a, { full: full === true || full === 'true' })) };
  },

  async 'ask.cancel'({ askId, code, reason, actor = 'mcp' } = {}) {
    const st = await state();
    const a = lookup(st, { askId, code });
    if (!a) throw new Error('no such ask here');
    if (a.status !== 'open') return { ok: false, askId: a.askId, status: a.status };
    await _deps.append({ type: 'ask', phase: 'cancelled', askId: a.askId, reason: clip(String(reason ?? 'withdrawn'), 200) }, actor);
    if (isHub() && router.running) await router.cancelled(a.askId).catch(() => {});
    return { ok: true, askId: a.askId, status: 'cancelled' };
  },

  /** The ask settings, the hub, each channel (names of what is missing, never values) and the owner's pause/stop. */
  async 'ask.status'({ probe = false } = {}) {
    const cfg = config();
    const st = await state();
    const now = _deps.now();
    const p = pauseState(st.controls, now);
    const channels = {};
    for (const [name, ad] of Object.entries(ADAPTERS)) {
      const miss = ad.missing(_deps.env);
      channels[name] = { configured: !miss.length, ...(miss.length ? { missing: miss } : {}), inOrder: cfg.order.includes(name), ...(isHub() && router.disabled.has(name) ? { off: router.disabled.get(name) } : {}) };
      if ((probe === true || probe === 'true') && !miss.length && isHub()) channels[name].health = await ad.health({ env: _deps.env }).catch((e) => ({ ok: false, error: e.message }));
    }
    const open = [...st.asks.values()].filter((a) => a.status === 'open');
    return {
      host: _deps.hostName(), hub: cfg.hub, isHub: isHub(), routing: isHub() ? router.running : null,
      order: cfg.order, quietHours: cfg.quiet ? `${String(Math.floor(cfg.quiet.start / 60)).padStart(2, '0')}:${String(cfg.quiet.start % 60).padStart(2, '0')}-${String(Math.floor(cfg.quiet.end / 60)).padStart(2, '0')}:${String(cfg.quiet.end % 60).padStart(2, '0')}` : 'off', tz: cfg.tz, ratePerHour: cfg.ratePerHour,
      stopped: p.stopped, pausedUntil: p.pausedUntil ? new Date(p.pausedUntil).toISOString() : null,
      open: open.length, unrouted: open.filter((a) => !a.code).length, channels,
      ...(isHub() ? { inbound: inboundModes() } : {}),
      // The hub signs its calls to asking hosts; they take them only with that key in DROVER_ASK_HUB_KEY.
      relay: isHub() ? { hubKey: await hubkey.publicKeyString().catch((e) => `unavailable: ${e.message}`) }
        : { trusts: hubkey.trustedKeys(_deps.env).map((k) => hubkey.fingerprint(k)) },
    };
  },

  /**
   * The hub hands a verified answer to the host that asked: recorded here too, then delivered to the asking session
   * with sessions.message (a handoff chain's live successor included). Not for agents.
   */
  async 'ask.deliver'(args = {}) {
    const signedBy = assertFromHub('ask.deliver', args);
    const { askId, code, answers, source, channel, providerMessageId, sender, raw, followUp = false, hub } = args;
    if (typeof askId !== 'string' || !Array.isArray(answers) || !answers.length) throw new Error('askId and answers required');
    const st = await state();
    const a = st.asks.get(askId);
    if (!a) return { ok: false, final: true, error: 'this host has no such ask' };
    const again = [...a.answers, ...a.followUps].some((x) => x.providerMessageId && x.providerMessageId === providerMessageId && x.source === source);
    if (!again) await _deps.append({ type: 'ask', phase: 'answered', askId, answers, source, channel, providerMessageId, sender, raw: clip(String(raw ?? ''), 2000), untrusted: false, relayedBy: hub ?? null, ...(signedBy ? { signedBy } : {}) }, 'ask');
    if (a.deliveries.some((d) => d.ok && d.providerMessageId === providerMessageId)) return { ok: true, deduped: true };
    if (!a.sessionId) return { ok: true, delivered: false, note: 'the ask names no session; the answer is recorded for ask.get' };
    const after = (await state()).asks.get(askId) ?? a;
    // A part whose question another message answered first is a follow-up: that first answer stands (the fold keeps it),
    // so the session must not take this part for the decision. Read from the fold after this message is in it, the same
    // whether the hub recorded it already (its own asks: one truth file) or this call did.
    const standing = new Map(answers.flatMap((x) => { const m = after.merged?.[x.q]; return m && m.providerMessageId !== providerMessageId ? [[x.q, m]] : []; }));
    // Late: the hub says so, the ask closed before this message, or every part answers a question answered before.
    const late = followUp || (a.status !== 'open' && !a.answers.some((x) => x.providerMessageId === providerMessageId)) || standing.size === answers.length;
    const remaining = late ? [] : after.questions.map((_q, i) => i).filter((i) => !after.answeredQs.has(i));
    const text = deliveryText({ ...a, code: a.code ?? code ?? null }, { answers, source, channel }, { followUp: late, remaining, standing: late ? null : standing });
    try {
      const r = await _deps.dispatch('sessions.message', { id: a.sessionId, text, actor: source });
      await _deps.append({ type: 'ask', phase: 'delivered', askId, ok: true, providerMessageId, to: { sessionId: a.sessionId, resolvedTo: r?.resolvedTo?.id ?? null }, kind: late ? 'follow-up' : 'answer' }, 'ask');
      return { ok: true, resolvedTo: r?.resolvedTo ?? null, queuedBehindTurn: r?.queuedBehindTurn ?? undefined };
    } catch (e) {
      const final = /not found|not live|no messaging socket|process not alive/i.test(e.message);
      await _deps.append({ type: 'ask', phase: 'delivered', askId, ok: false, final, providerMessageId, to: { sessionId: a.sessionId }, error: clip(e.message, 300), kind: late ? 'follow-up' : 'answer' }, 'ask');
      return { ok: false, final, error: e.message };
    }
  },

  /** The hub tells the asking host the ask's code, or that it expired (then the session hears so). Not for agents. */
  async 'ask.mark'(args = {}) {
    assertFromHub('ask.mark', args);
    const { askId, phase, code, hub, why } = args;
    const st = await state();
    const a = st.asks.get(askId);
    if (!a) return { ok: false, final: true, error: 'this host has no such ask' };
    if (phase === 'routed') {
      if (!a.code) await _deps.append({ type: 'ask', phase: 'routed', askId, code, hub: hub ?? null }, 'ask');
      return { ok: true };
    }
    if (phase === 'expired') {
      if (a.status === 'open') await _deps.append({ type: 'ask', phase: 'expired', askId, reason: clip(String(why ?? 'expired'), 200) }, 'ask');
      // Told once, whether the hub's own expiry (on the hub, the same truth file) or this call wrote it. A notice the
      // session could not take is no notice: the failure goes back to the hub, which tries again, unless the session is
      // gone for good (final).
      if (a.sessionId && a.status !== 'answered' && !a.deliveries.some((d) => d.kind === 'expired' && (d.ok || d.final))) {
        try { await _deps.dispatch('sessions.message', { id: a.sessionId, text: closedText({ ...a, code: a.code ?? code }, `${why ?? 'expired without an answer'}; ask again if you still need it`), actor: 'ask' }); }
        catch (e) {
          const final = /not found|not live|no messaging socket|process not alive/i.test(e.message);
          await _deps.append({ type: 'ask', phase: 'delivered', askId, ok: false, final, kind: 'expired', to: { sessionId: a.sessionId }, error: clip(e.message, 300) }, 'ask');
          return { ok: false, final, error: e.message };
        }
        await _deps.append({ type: 'ask', phase: 'delivered', askId, ok: true, kind: 'expired', to: { sessionId: a.sessionId } }, 'ask');
      }
      return { ok: true };
    }
    throw new Error('phase must be routed or expired');
  },
};
