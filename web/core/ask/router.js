// The ask hub: the one daemon that texts the owner and reads the answers (DROVER_ASK_HUB names its host).
//
// Asks are recorded where they are asked (core/ask/ops.js ask.create). Every tick (15 s) the hub
//   1. pulls the open asks of the fleet hosts it may read (same identity, core/placement.js; or DROVER_ASK_HOSTS)
//      with ask.list over the ssh rpc peers it already holds, and takes the new ones; asks made on the hub itself
//      are taken at once
//   2. gives each a code and texts it, or holds it (quiet hours, a pause, the rate limit) and later sends the held
//      ones together in one text
//   3. reminds once before expiry, escalates an urgent ask to the next channel, expires what nobody answered
//   4. retries a delivery that did not reach the asking host
// A reply comes in through a channel (Telegram webhook or long poll, Twilio webhook, imsg watch). Only a verified one
// (the channel's own authentication, then the owner's sender id) is an answer; it is recorded, delivered to the asking
// session on its host (ask.deliver there, which uses sessions.message: handoff chains included), and acknowledged.
// Anything else is recorded as an untrusted inbound and never delivered as the owner's word.
//
// One in-process mutex orders every change (a tick, a reply, a create, a cancel), so an ask is never coded, sent or
// answered twice by this daemon. Network pulls run outside it.
import { foldAsks, nextCode, askText, batchText, answerWords, whoLabel, forChannel, clip, oneLine, TERMINAL } from './model.js';
import { parseReply } from './parse.js';
import { readConfig, mayText, channelOrder, reminderAt, pauseState } from './policy.js';
import { ADAPTERS, usableChannels } from './channels/index.js';
import { OWNER } from '../owner.js';

export const TICK_MS = 15_000;
const PULL_TIMEOUT_MS = 15_000;
const RETRY_MS = 2 * 60_000;
const UNTRUSTED_PER_HOUR = 30;
const RECENT_MS = 3_600_000;

export const _deps = {
  append: null,          // (event) => stored event       (core/ask/ops.js wires these)
  readEvents: null,      // () => events
  call: null,            // (host, op, args, {timeoutMs}) => result; host 'local' runs here
  askHosts: async () => [],
  hostName: () => 'local',
  now: () => Date.now(),
  env: process.env,
  channels: ADAPTERS,
  log: (...a) => console.error('[ask]', ...a),
  publicBase: () => null,
};

const sourceFor = (channel) => `${OWNER}:${channel}`;
const sameHost = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
/** Where an ask's answer goes: 'local' for the hub's own, else the alias the hub reached the asking host by. */
const targetOf = (a) => { const h = a.deliverTo ?? a.origin; return !h || sameHost(h, _deps.hostName()) ? 'local' : h; };
/** Exponential backoff from the WAL (so a restart keeps it): 2 min after the first failure, doubling, at most 30. */
export function retryDue(failures, lastTs, now) {
  if (!failures) return true;
  return now - Date.parse(lastTs) >= Math.min(30 * 60_000, RETRY_MS * 2 ** (failures - 1));
}

export class Router {
  constructor() {
    this.lock = Promise.resolve();
    this.timer = null;
    this.stops = [];
    this.seen = new Set();            // provider message ids handled in this process
    this.untrusted = new Map();       // channel -> [ts] of recorded untrusted inbounds (an hour)
    this.hostBackoff = new Map();     // host -> ms before which it is not pulled again
    this.running = false;
    this.disabled = new Map();        // channel -> why the hub will not use it (a failed safety check at start)
  }

  /** Run fn with the router's lock held; returns its result. */
  exclusive(fn) {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => {});
    return run;
  }

  config() { return readConfig(_deps.env); }
  usable(cfg = this.config()) { return usableChannels(cfg.order.concat(['telegram', 'imessage', 'sms'].filter((c) => !cfg.order.includes(c))), _deps.channels, _deps.env).filter((c) => !this.disabled.has(c)); }
  async state() { return foldAsks(await _deps.readEvents()); }

  // ------------------------------------------------------------ taking and texting
  /** Give an ask its code (it is the hub's now) and try to text it. origin: the host alias to deliver back to. */
  async take(ask, alias = null) {
    const origin = alias ?? _deps.hostName();
    const st = await this.state();
    const known = st.asks.get(ask.askId);
    if (known?.code) return known;
    const now = _deps.now();
    const code = nextCode([...st.asks.values()], now);
    if (!code) { _deps.log('no free code: 99 asks are open'); return null; }
    const copy = { origin, sessionId: ask.sessionId ?? null, sessionName: ask.sessionName ?? null, cwd: ask.cwd ?? null, questions: ask.questions, urgency: ask.urgency ?? 'normal', expiresAt: ask.expiresAt ?? null, channels: ask.channels ?? null, createdAt: ask.createdAt ?? null, createdBy: ask.createdBy ?? null };
    await _deps.append({ type: 'ask', phase: 'routed', askId: ask.askId, code, origin, hub: _deps.hostName(), ask: copy });
    if (alias && !sameHost(alias, _deps.hostName())) {
      _deps.call(alias, 'ask.mark', { askId: ask.askId, phase: 'routed', code, hub: _deps.hostName() }, { timeoutMs: PULL_TIMEOUT_MS }).catch((e) => _deps.log('ask.mark routed', origin, e.message));
    }
    return { ...copy, askId: ask.askId, code, deliverTo: origin, status: 'open', routedAt: new Date(now).toISOString(), sends: [], answers: [], followUps: [], deliveries: [] };
  }

  /** Text the asks that may go now, together per channel; failures fall over to the next channel. */
  async textOut(list, { kind = null } = {}) {
    const cfg = this.config();
    const st = await this.state();
    const now = _deps.now();
    const usable = this.usable(cfg);
    const groups = new Map();   // first channel -> asks
    const held = [];
    for (const a of list) {
      const may = mayText(a, { now, config: cfg, sends: st.sends, controls: st.controls });
      if (!may.send) { held.push({ askId: a.askId, code: a.code, why: may.why, until: may.until }); continue; }
      const chans = channelOrder(a, { order: cfg.order, usable });
      if (!chans.length) { held.push({ askId: a.askId, code: a.code, why: 'no channel is configured on the hub', until: null }); continue; }
      const k = chans.join(',');
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(a);
    }
    const sent = [];
    for (const [k, asks] of groups) {
      const chans = k.split(',');
      let done = false;
      for (const ch of chans) {
        const r = await this.sendOn(ch, asks, { kind: kind ?? (asks.length > 1 ? 'batch' : 'ask') });
        if (r.ok) { sent.push({ channel: ch, codes: asks.map((a) => a.code), providerId: r.providerId }); done = true; break; }
      }
      if (!done) for (const a of asks) held.push({ askId: a.askId, code: a.code, why: 'every channel failed', until: now + RETRY_MS });
    }
    return { sent, held };
  }

  /** One text on one channel for these asks; records it either way. */
  async sendOn(channel, asks, { kind = 'ask', text = null } = {}) {
    const adapter = _deps.channels[channel];
    // Every text goes through the channel's form (SMS: ASCII), acknowledgements and notices included.
    const body = text !== null ? forChannel(text, channel) : (kind === 'reminder' || kind === 'escalation' ? askText(asks[0], { channel, reminder: kind === 'reminder', escalation: kind === 'escalation' }) : asks.length > 1 ? batchText(asks, { channel }) : askText(asks[0], { channel }));
    try {
      const r = await adapter.send({ text: body, asks: kind === 'ack' || kind === 'notice' ? [] : asks }, { env: _deps.env });
      await _deps.append({ type: 'ask', phase: 'sent', askIds: asks.map((a) => a.askId), ...(asks.length === 1 ? { askId: asks[0].askId } : {}), channel, kind, ok: true, providerId: r.providerId ?? null, messageIds: r.messageIds ?? [], text: clip(body, 1500) });
      return { ok: true, providerId: r.providerId };
    } catch (e) {
      _deps.log(`send ${channel} failed`, e.message);
      await _deps.append({ type: 'ask', phase: 'sent', askIds: asks.map((a) => a.askId), ...(asks.length === 1 ? { askId: asks[0].askId } : {}), channel, kind, ok: false, error: clip(e.message, 300) });
      return { ok: false, error: e.message };
    }
  }

  /** A short text back to the owner on the channel a reply came in on (never counted against the rate limit). */
  async ack(channel, text, { button = null } = {}) {
    if (button && channel === 'telegram') { await _deps.channels.telegram.answerButton(button.id, text, { env: _deps.env }); return; }
    const st = await this.state();
    if (pauseState(st.controls, _deps.now()).stopped && !/^Stopped/.test(text) && !/^Resumed/.test(text)) return;   // after stop: silence
    await this.sendOn(channel, [], { kind: 'ack', text: channel === 'sms' ? clip(text, 300) : text }).catch(() => {});
  }

  /** Rewrite the Telegram messages that carried an ask (answered, expired, cancelled). Best effort. */
  async markMessages(ask, line) {
    if (!_deps.channels.telegram?.configured(_deps.env)) return;
    const st = await this.state();
    const mine = st.sends.filter((s) => s.channel === 'telegram' && s.ok !== false && s.providerId && (s.askIds ?? [s.askId]).includes(ask.askId) && s.kind !== 'ack');
    for (const s of mine) {
      const others = (s.askIds ?? []).filter((id) => id !== ask.askId);
      // A batch keeps its buttons for the asks still open in it: only a message about this ask alone is rewritten.
      if (others.some((id) => st.asks.get(id)?.status === 'open')) continue;
      await _deps.channels.telegram.edit(s.providerId, `${s.text ?? askText(ask)}\n\n${line}`, { env: _deps.env }).catch((e) => _deps.log('telegram edit', e.message));
    }
  }

  // ------------------------------------------------------------ the tick
  /** Pull open asks from the hosts the hub reads (outside the lock). Returns [{host, asks}] for the ones that answered. */
  async pull() {
    const hosts = (await _deps.askHosts().catch(() => [])).filter((h) => h && h !== 'local' && !sameHost(h, _deps.hostName()));
    const now = _deps.now();
    const out = [];
    await Promise.all(hosts.map(async (h) => {
      if ((this.hostBackoff.get(h) ?? 0) > now) return;
      try {
        const r = await _deps.call(h, 'ask.list', { mine: true, status: 'open', recentMs: RECENT_MS, limit: 200 }, { timeoutMs: PULL_TIMEOUT_MS });
        this.hostBackoff.delete(h);
        out.push({ host: h, asks: Array.isArray(r?.asks) ? r.asks : [] });
      } catch (e) {
        // An older Drover there (no ask.list) or a host that is down: try it again in a while.
        this.hostBackoff.set(h, now + (/unknown op ask\.list/.test(e?.message ?? '') ? 30 * 60_000 : 2 * 60_000));
      }
    }));
    return out;
  }

  async tick() {
    const pulled = await this.pull();
    const report = await this.exclusive(() => this.#tick(pulled));
    for (const { a, ans, followUp } of report.redeliver.splice(0)) {
      const r = await this.deliver(a, ans, { followUp });
      report.delivered.push(`${a.code}:${r.ok ? 'ok' : r.final ? 'final' : 'failed'}`);
    }
    delete report.redeliver;
    return report;
  }

  async #tick(pulled) {
    const now = _deps.now();
    const report = { taken: [], sent: [], held: [], reminded: [], escalated: [], expired: [], cancelled: [], delivered: [] };
    let st = await this.state();
    // 1. new asks: from the pulled hosts, and the hub's own not yet coded.
    for (const { host, asks } of pulled) {
      for (const a of asks) {
        const here = st.asks.get(a.askId);
        if (a.status === 'open' && !here?.code) { const t = await this.take(a, host); if (t) report.taken.push(t.code); }
        else if (here?.status === 'open' && (a.status === 'cancelled' || a.status === 'expired')) {
          await _deps.append({ type: 'ask', phase: a.status, askId: a.askId, reason: `${a.status} on ${host}${a.why ? `: ${a.why}` : ''}` });
          await this.markMessages(here, a.status === 'cancelled' ? 'Withdrawn by the asker.' : 'Expired.');
          report.cancelled.push(here.code);
        }
      }
    }
    for (const a of st.asks.values()) if (a.status === 'open' && !a.code && (!a.origin || sameHost(a.origin, _deps.hostName()))) { const t = await this.take(a); if (t) report.taken.push(t.code); }
    st = await this.state();
    // 2. expiry, then the asks never texted (held, or taken just now), then reminders and escalations.
    const open = [...st.asks.values()].filter((a) => a.status === 'open' && a.code);
    for (const a of open) {
      if (a.expiresAt && Date.parse(a.expiresAt) <= now) {
        await _deps.append({ type: 'ask', phase: 'expired', askId: a.askId, reason: 'nobody answered in time' });
        await this.markMessages(a, 'Expired: no answer in time.');
        await this.tellAsker(a, 'expired without an answer');
        report.expired.push(a.code);
      }
    }
    st = await this.state();
    const live = [...st.asks.values()].filter((a) => a.status === 'open' && a.code);
    const untexted = live.filter((a) => {
      if (a.sends.some((s) => s.ok && ['ask', 'batch', 'escalation'].includes(s.kind))) return false;
      const failed = a.sends.filter((s) => !s.ok && ['ask', 'batch'].includes(s.kind));
      return retryDue(failed.length, failed.at(-1)?.ts, now);
    });
    if (untexted.length) { const r = await this.textOut(untexted); report.sent.push(...r.sent); report.held.push(...r.held); }
    const cfg = this.config();
    const usable = this.usable(cfg);
    for (const a of live) {
      const ok = a.sends.filter((s) => s.ok && s.kind !== 'ack');
      if (!ok.length) continue;
      const remindAt = reminderAt(a);
      if (remindAt && remindAt <= now && !a.sends.some((s) => s.kind === 'reminder')) {
        const may = mayText(a, { now, config: cfg, sends: st.sends, controls: st.controls });
        if (may.send) { const ch = ok[0].channel; const r = await this.sendOn(ch, [a], { kind: 'reminder' }); if (r.ok) report.reminded.push(a.code); }
      }
      if (a.urgency === 'urgent') {
        const last = Math.max(...ok.map((s) => Date.parse(s.ts)));
        const used = new Set(ok.map((s) => s.channel));
        const nextCh = channelOrder(a, { order: cfg.order, usable }).find((c) => !used.has(c));
        if (nextCh && now - last >= cfg.escalateMs && !pauseState(st.controls, now).stopped) { const r = await this.sendOn(nextCh, [a], { kind: 'escalation' }); if (r.ok) report.escalated.push(`${a.code}:${nextCh}`); }
      }
    }
    // 3. answers recorded here that did not reach the asking host yet (delivered after the lock is let go).
    report.redeliver = [];
    for (const a of st.asks.values()) {
      for (const ans of [...a.answers, ...a.followUps]) {
        if (!ans.providerMessageId) continue;
        const ds = a.deliveries.filter((d) => d.providerMessageId === ans.providerMessageId);
        if (ds.some((d) => d.ok || d.final)) continue;
        if (!retryDue(ds.length, ds.at(-1)?.ts, now)) continue;
        report.redeliver.push({ a, ans, followUp: ans !== a.answers[0] });
      }
    }
    return report;
  }

  // ------------------------------------------------------------ answers
  /** Hand an answer to the host that asked (ask.deliver there sends it to the session). Records how it went. */
  async deliver(a, ans, { followUp = false } = {}) {
    const origin = targetOf(a);
    const args = { askId: a.askId, code: a.code, answers: ans.answers, source: ans.source, channel: ans.channel, providerMessageId: ans.providerMessageId, sender: ans.sender, raw: ans.raw, followUp, hub: _deps.hostName() };
    try {
      const r = await _deps.call(origin, 'ask.deliver', args, { timeoutMs: 60_000 });
      await _deps.append({ type: 'ask', phase: 'delivered', askId: a.askId, ok: r?.ok !== false, final: r?.final === true, providerMessageId: ans.providerMessageId, to: { host: origin, sessionId: a.sessionId ?? null, resolvedTo: r?.resolvedTo ?? null }, ...(r?.ok === false ? { error: clip(r.error ?? 'refused', 300) } : {}), kind: followUp ? 'follow-up' : 'answer' });
      return { ok: r?.ok !== false, final: r?.final === true, error: r?.error ?? null, result: r };
    } catch (e) {
      await _deps.append({ type: 'ask', phase: 'delivered', askId: a.askId, ok: false, final: false, providerMessageId: ans.providerMessageId, to: { host: origin, sessionId: a.sessionId ?? null }, error: clip(e.message, 300), kind: followUp ? 'follow-up' : 'answer' });
      return { ok: false, final: false, error: e.message };
    }
  }

  /** Tell the asking session its ask closed without an answer (expired). Best effort. */
  async tellAsker(a, why) {
    const origin = targetOf(a);
    try { await _deps.call(origin, 'ask.mark', { askId: a.askId, phase: 'expired', code: a.code, hub: _deps.hostName(), why }, { timeoutMs: PULL_TIMEOUT_MS }); }
    catch (e) { _deps.log('ask.mark expired', origin, e.message); }
  }

  /** Record a verified answer, deliver it, rewrite the message it answered, and return what to tell the owner. */
  async #answer(a, answers, msg, { followUp }) {
    const ev = await _deps.append({ type: 'ask', phase: 'answered', askId: a.askId, answers, source: sourceFor(msg.channel), channel: msg.channel, providerMessageId: msg.providerMessageId, sender: msg.sender, raw: clip(msg.text, 2000), untrusted: false });
    const ans = { answers, source: ev.source, channel: msg.channel, providerMessageId: msg.providerMessageId, sender: msg.sender, raw: ev.raw };
    const d = await this.deliver(a, ans, { followUp });
    const words = a.questions.length === 1 ? answerWords(a.questions[0], answers[0]) : answers.map((x) => `${x.q + 1}: ${answerWords(a.questions[x.q], x)}`).join(' · ');
    if (!followUp) await this.markMessages(a, `✓ Answered: ${words}`);
    const where = whoLabel(a);
    return d.ok ? `${a.code} → ${words}${followUp ? ' (follow-up)' : ''}: sent to ${where}` : d.final ? `${a.code} → ${words}: recorded, but ${where} is not running (${clip(d.error ?? '', 120)})` : `${a.code} → ${words}: recorded; ${where} is out of reach, retrying`;
  }

  /**
   * A reply from a channel (already read by its adapter: verified or not). Returns what was done, for tests and logs.
   * Never throws for a bad reply.
   */
  inbound(msg) {
    return this.exclusive(() => this.#inbound(msg)).catch((e) => { _deps.log('inbound failed', e.message); return { error: e.message }; });
  }

  async #inbound(msg) {
    if (!msg) return { ignored: 'nothing to read' };
    if (msg.providerMessageId && this.seen.has(msg.providerMessageId)) return { duplicate: true };
    if (msg.providerMessageId) { this.seen.add(msg.providerMessageId); if (this.seen.size > 2000) this.seen = new Set([...this.seen].slice(-1000)); }
    const st = await this.state();
    if (msg.providerMessageId && [...st.asks.values()].some((a) => [...a.answers, ...a.followUps].some((x) => x.providerMessageId === msg.providerMessageId))) return { duplicate: true };
    if (!msg.verified) {
      const now = _deps.now();
      const recent = (this.untrusted.get(msg.channel) ?? []).filter((t) => now - t < RECENT_MS);
      if (recent.length < UNTRUSTED_PER_HOUR) {
        recent.push(now); this.untrusted.set(msg.channel, recent);
        await _deps.append({ type: 'ask', phase: 'inbound', channel: msg.channel, untrusted: true, sender: msg.sender, reason: msg.reason ?? 'unverified', providerMessageId: msg.providerMessageId ?? null, text: clip(oneLine(msg.text), 200) });
      }
      return { untrusted: true, reason: msg.reason };   // never an answer, never acknowledged
    }
    const now = _deps.now();
    const candidates = [...st.asks.values()].filter((a) => a.code && (a.status === 'open' || (a.closedAt && now - Date.parse(a.closedAt) < RECENT_MS)));
    // The message a reply or a button belongs to pins the ask exactly.
    const sentWith = (id) => st.sends.find((s) => s.ok !== false && (s.messageIds ?? []).includes(id));
    if (msg.button) {
      const m = /^ask:([A-Z]\d{1,2}):(\d):(\d)$/.exec(msg.button.data);
      const s = msg.replyTo ? sentWith(msg.replyTo) : null;
      const a = m && s ? (s.askIds ?? [s.askId]).map((id) => st.asks.get(id)).find((x) => x?.code === m[1]) : null;
      if (!a) { await this.ack(msg.channel, 'That button is from an ask that is gone.', { button: msg.button }); return { stale: true }; }
      const q = Number(m[2]), o = Number(m[3]);
      if (!a.questions[q]?.options?.[o]) { await this.ack(msg.channel, 'That option does not exist.', { button: msg.button }); return { stale: true }; }
      if (a.status !== 'open' && a.answers.length) { await this.ack(msg.channel, `${a.code} is already answered.`, { button: msg.button }); return { already: true }; }
      if (a.status !== 'open') { await this.ack(msg.channel, `${a.code} is ${a.status}.`, { button: msg.button }); return { closed: a.status }; }
      const line = await this.#answer(a, [{ q, option: o, text: '' }], msg, { followUp: false });
      await this.ack(msg.channel, line, { button: msg.button });
      return { answered: [a.code] };
    }
    const tied = msg.replyTo ? sentWith(msg.replyTo) : null;
    const target = tied && (tied.askIds ?? [tied.askId]).length === 1 ? (tied.askIds ?? [tied.askId])[0] : null;
    const scope = tied && !target ? candidates.filter((a) => (tied.askIds ?? []).includes(a.askId)) : candidates;
    const r = parseReply(msg.text, { asks: scope, target });
    if (r.command) return this.#command(r.command, msg, st);
    if (r.ambiguous) {
      const list = scope.filter((a) => a.status === 'open').map((a) => `${a.code} (${clip(a.questions[0].question, 50)})`).join(', ');
      await this.ack(msg.channel, `Which ask? Open: ${list}. Reply like ${scope.find((a) => a.status === 'open')?.code ?? 'K7'} b`);
      await _deps.append({ type: 'ask', phase: 'inbound', channel: msg.channel, untrusted: false, sender: msg.sender, reason: 'ambiguous: several asks are open', providerMessageId: msg.providerMessageId ?? null, text: clip(oneLine(msg.text), 200) });
      return { ambiguous: r.ambiguous.codes };
    }
    if (r.unmatched || !r.answers.length) {
      await _deps.append({ type: 'ask', phase: 'inbound', channel: msg.channel, untrusted: false, sender: msg.sender, reason: 'no open ask', providerMessageId: msg.providerMessageId ?? null, text: clip(oneLine(msg.text), 200) });
      await this.ack(msg.channel, 'No open asks right now. (Reply status to list them.)');
      return { unmatched: true };
    }
    const lines = [];
    for (const x of r.answers) {
      const a = st.asks.get(x.askId);
      lines.push(await this.#answer(a, x.answers, msg, { followUp: a.status !== 'open' }));
    }
    await this.ack(msg.channel, lines.join('\n'));
    return { answered: r.answers.map((x) => x.code) };
  }

  async #command(c0, msg, st) {
    const now = _deps.now();
    const open = [...st.asks.values()].filter((a) => a.status === 'open' && a.code);
    // start resumes only after a stop (SMS START, the carrier's word for it); otherwise it is hello.
    const c = c0.command === 'start' ? (pauseState(st.controls, now).stopped ? { command: 'resume' } : { command: 'help' }) : c0;
    if (c.command === 'help') {
      await this.ack(msg.channel, `Drover texts you agents' questions here, each with a code like K7. Answer with the code and a letter (K7 b, or 7b), any words (K7 after lunch), several at once (1a 2b 3 yes), or a button. Also: status, pause asks 2h, stop, resume.${open.length ? ` ${open.length} open now: reply status.` : ''}`);
      return { command: 'help' };
    }
    if (c.command === 'status') {
      const p = pauseState(st.controls, now);
      const head = p.stopped ? 'Stopped (reply resume). ' : p.pausedUntil ? `Paused until ${new Date(p.pausedUntil).toISOString().slice(11, 16)}Z. ` : '';
      await this.ack(msg.channel, open.length ? `${head}${open.length} open: ${open.map((a) => `${a.code} ${whoLabel(a)}: ${clip(a.questions[0].question, 60)}`).join(' | ')}` : `${head}No open asks.`);
      return { command: 'status' };
    }
    const until = c.command === 'pause' ? new Date(now + c.ms).toISOString() : null;
    await _deps.append({ type: 'ask', phase: 'control', command: c.command, ...(c.ms ? { ms: c.ms, until } : {}), source: sourceFor(msg.channel), sender: msg.sender, providerMessageId: msg.providerMessageId ?? null });
    const text = c.command === 'stop' ? `Stopped: no texts until you reply resume. ${open.length} ask${open.length === 1 ? '' : 's'} stay open.`
      : c.command === 'resume' ? `Resumed. ${open.length} open ask${open.length === 1 ? '' : 's'}.`
      : `Paused normal asks until ${until.slice(11, 16)}Z (urgent ones still come).`;
    await this.ack(msg.channel, text);
    if (c.command === 'resume') setTimeout(() => this.tick().catch(() => {}), 10).unref?.();
    return { command: c.command };
  }

  /** Take one ask made on this host and text it now (ask.create in the hub's daemon). */
  takeNow(askId) {
    return this.exclusive(async () => {
      const a = (await this.state()).asks.get(askId);
      if (!a || a.status !== 'open') return null;
      if (a.code && a.sends.some((s) => s.ok && s.kind !== 'ack')) return { code: a.code, sent: [], held: [] };
      const t = a.code ? a : await this.take(a);
      if (!t) return null;
      return { code: t.code, ...(await this.textOut([t])) };
    });
  }

  // ------------------------------------------------------------ withdrawals
  /** The asker withdrew an ask on this host: rewrite its messages. */
  async cancelled(askId) {
    return this.exclusive(async () => { const a = (await this.state()).asks.get(askId); if (a?.code) await this.markMessages(a, 'Withdrawn by the asker.'); });
  }

  // ------------------------------------------------------------ lifecycle
  /** Start the tick and the inbound watchers that run inside the daemon (imsg; Telegram long poll). Returns stop(). */
  start() {
    if (this.running) return () => this.stop();
    this.running = true;
    const cfg = this.config();
    const env = _deps.env;
    if (_deps.channels.imessage?.configured(env) && cfg.order.includes('imessage')) {
      // Checked before anything is read or sent: an account that is the owner's own Apple ID, or one signed out, is
      // not used at all (a text to yourself raises no alert, and a reply could not be told from Drover's own).
      this.disabled.set('imessage', 'checking');
      _deps.channels.imessage.health({ env }).then(async (h) => {
        if (!h.ok) { this.disabled.set('imessage', h.error ?? 'unhealthy'); _deps.log('imessage off:', h.error); return; }
        this.disabled.delete('imessage');
        this.stops.push(await _deps.channels.imessage.start((m) => this.inbound(m), { log: _deps.log, env }));
      }).catch((e) => { this.disabled.set('imessage', e.message); _deps.log('imessage off:', e.message); });
    }
    if (_deps.channels.telegram?.configured(env)) {
      const base = _deps.publicBase();
      if (_deps.channels.telegram.inboundMode({ publicBase: base, env }) === 'poll') this.stops.push(_deps.channels.telegram.startPolling((u) => this.inbound(_deps.channels.telegram.readUpdate(u, { env })), { log: _deps.log, env }));
      else _deps.channels.telegram.ensureWebhook(`${base}/hooks/telegram`, { env }).then((r) => r.changed && _deps.log('telegram webhook set'), (e) => _deps.log('telegram webhook', e.message));
    }
    const loop = () => { this.tick().catch((e) => _deps.log('tick', e.message)).finally(() => { if (this.running) { this.timer = setTimeout(loop, TICK_MS); this.timer.unref?.(); } }); };
    this.timer = setTimeout(loop, 1000); this.timer.unref?.();
    return () => this.stop();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    for (const s of this.stops.splice(0)) { try { s(); } catch { /* stopping */ } }
  }
}

export const router = new Router();
export { TERMINAL };
