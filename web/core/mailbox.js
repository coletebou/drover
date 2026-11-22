// A mailbox for hosts nobody can reach. Some machines take no inbound ssh (a work laptop whose policy forbids Remote
// Login), so a sessions.message sent to them from elsewhere fails at the connection. Instead of failing, the sender
// keeps the message here, in its own state dir, addressed to that host alias. The unreachable host, which can still
// reach out, sets DROVER_MAILBOX_PULL to the names others use for it (macbook); its daemon then asks every fleet host
// for mail (mailbox.take), delivers each message to its own session with sessions.message, and acks it
// (mailbox.ack) on the host it came from. Delivery is at least once on the wire and once in effect: the puller keeps
// the ids it delivered and acks a repeat without delivering it again.
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { stateDir } from './paths.js';
import { envvar } from './envvars.js';
import { uuidv7 } from './ids.js';

export const _deps = { now: () => Date.now(), env: process.env };

const MAX_AGE_MS = 7 * 24 * 3600_000;
const TAKE_MAX = 50;

export const boxFile = () => path.join(stateDir(_deps.env), 'mailbox.jsonl');
export const seenFile = () => path.join(stateDir(_deps.env), 'mailbox-delivered.jsonl');

/**
 * The connection-level failures of a forwarded call: ssh could not connect or the link died before the request was
 * written. A remote that answered with an error (session not found) or a call that timed out (it may have run there)
 * is not one, so it is never queued: queueing those could deliver twice or hide a real refusal.
 */
export function isUnreachable(err) {
  const m = String(err?.message ?? err ?? '');
  return /drover rpc exited 255\b|drover rpc is not running|: write failed \(/.test(m);
}

async function readLines(file) {
  let text;
  try { text = await readFile(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch { /* torn line */ } }
  return out;
}
async function add(file, rec) { await mkdir(path.dirname(file), { recursive: true }); await appendFile(file, JSON.stringify(rec) + '\n', { mode: 0o600 }); }

/** Keep a message for `to` (the host alias the sender used). Returns its mailbox id. */
export async function enqueue({ to, id, text, actor, why }) {
  const mid = uuidv7(_deps.now());
  await add(boxFile(), { k: 'msg', mid, to, id, text, actor: actor ?? null, why: why ?? null, ts: new Date(_deps.now()).toISOString() });
  return mid;
}

/** Messages here for any of `names` that no ack has closed, oldest first, at most 50; older than 7 days are dropped. */
export async function take({ for: names } = {}) {
  const want = new Set((Array.isArray(names) ? names : String(names ?? '').split(',')).map((s) => String(s).trim()).filter(Boolean));
  if (!want.size) throw new Error('for: the host names to collect mail for');
  const recs = await readLines(boxFile());
  const acked = new Set(recs.filter((r) => r.k === 'ack').map((r) => r.mid));
  const cutoff = _deps.now() - MAX_AGE_MS;
  const messages = recs.filter((r) => r.k === 'msg' && want.has(r.to) && !acked.has(r.mid) && Date.parse(r.ts) >= cutoff)
    .slice(0, TAKE_MAX).map(({ mid, to, id, text, actor, ts }) => ({ mid, to, id, text, actor, ts }));
  return { messages };
}

/** Close messages: acks [{ mid, ok, error? }]. An unknown mid is recorded anyway (harmless). */
export async function ack({ acks } = {}) {
  if (!Array.isArray(acks)) throw new Error('acks: [{ mid, ok, error }]');
  const ts = new Date(_deps.now()).toISOString();
  for (const a of acks) if (a && typeof a.mid === 'string') await add(boxFile(), { k: 'ack', mid: a.mid, ok: a.ok === true, error: a.error ?? null, ts });
  return { acked: acks.length };
}

/** What waits here and what was closed, for a person looking (mailbox.status). */
export async function status() {
  const recs = await readLines(boxFile());
  const acks = new Map(recs.filter((r) => r.k === 'ack').map((r) => [r.mid, r]));
  const msgs = recs.filter((r) => r.k === 'msg');
  return {
    pull: pullNames(),
    waiting: msgs.filter((m) => !acks.has(m.mid)).map(({ mid, to, id, ts }) => ({ mid, to, id, ts })),
    delivered: msgs.filter((m) => acks.has(m.mid)).slice(-20).map(({ mid, to, id, ts }) => ({ mid, to, id, ts, ok: acks.get(mid).ok, error: acks.get(mid).error })),
  };
}

export function pullNames(env = _deps.env) {
  return String(envvar('MAILBOX_PULL', env) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * One pull: for each host, take its mail for our names, deliver what we have not delivered, ack all of it there.
 * deps: hosts() -> aliases to ask; call(host, op, args) -> the rpc; deliver({ id, text, actor }) -> sessions.message here.
 */
export async function pullOnce({ hosts, call, deliver, log = () => {} }) {
  const names = pullNames();
  if (!names.length) return { hosts: 0, delivered: 0 };
  const seen = new Map((await readLines(seenFile())).map((r) => [r.mid, r]));
  let delivered = 0;
  const list = await hosts();
  for (const h of list) {
    let mail;
    try { mail = await call(h, 'mailbox.take', { for: names }); } catch (e) { if (!/unknown op/.test(e?.message ?? '')) log(`take from ${h}: ${e.message}`); continue; }
    const acks = [];
    for (const m of mail?.messages ?? []) {
      const prior = seen.get(m.mid);
      if (prior) { acks.push({ mid: m.mid, ok: prior.ok, error: prior.error ?? null }); continue; }
      let rec;
      try { const r = await deliver({ id: m.id, text: m.text, actor: m.actor ?? undefined }); rec = { mid: m.mid, from: h, id: m.id, ok: true, session: r?.session?.name ?? r?.session?.id ?? null }; delivered++; }
      catch (e) { rec = { mid: m.mid, from: h, id: m.id, ok: false, error: String(e?.message ?? e).slice(0, 300) }; log(`deliver ${m.mid} to ${m.id}: ${rec.error}`); }
      rec.ts = new Date(_deps.now()).toISOString();
      await add(seenFile(), rec); seen.set(m.mid, rec);
      acks.push({ mid: m.mid, ok: rec.ok, error: rec.error ?? null });
    }
    if (acks.length) { try { await call(h, 'mailbox.ack', { acks }); } catch (e) { log(`ack to ${h}: ${e.message} (redelivery is skipped by the delivered list)`); } }
  }
  return { hosts: list.length, delivered };
}

let timer = null;
/** Daemon only, and only when DROVER_MAILBOX_PULL names this host: a pull 15 s after start, then every minute. */
export function startPuller(deps, { firstMs = 15_000, everyMs = Number(envvar('MAILBOX_EVERY_MS', _deps.env)) || 60_000 } = {}) {
  const log = deps.log ?? ((m) => console.error(`[mailbox] ${m}`));
  if (!pullNames().length || timer) return () => {};
  let busy = false;
  const pass = async () => {
    if (busy) return; busy = true;
    try { const r = await pullOnce({ ...deps, log }); if (r.delivered) log(`delivered ${r.delivered}`); }
    catch (e) { log(`pass failed: ${e.message}`); }
    finally { busy = false; }
  };
  const first = setTimeout(pass, firstMs); first.unref?.();
  timer = setInterval(pass, Math.max(10_000, everyMs)); timer.unref?.();
  log(`pulling mail for ${pullNames().join(', ')} every ${Math.round(Math.max(10_000, everyMs) / 1000)} s`);
  return () => { clearTimeout(first); clearInterval(timer); timer = null; };
}
