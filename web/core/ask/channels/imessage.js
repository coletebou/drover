// iMessage through the imsg CLI (https://github.com/steipete/imsg) on a Mac, as the macOS user the daemon runs as.
//
//   DROVER_ASK_IMESSAGE_TO   the owner's handle (+17045550123 or an email): the only sender whose replies count
//   DROVER_ASK_IMSG          the imsg binary (default /opt/homebrew/bin/imsg)
//
// One `imsg rpc --json` child does both directions: watch.subscribe for new messages (JSON-RPC notifications
// {method: "message", params: {message}}), and send, pinned to the AppleScript transport (imsg's IMCore bridge, when
// it is not injected, holds a send for about 150 s before falling back). A message counts as the owner's only when it
// is not from this account (is_from_me false), its sender is the owner's handle, and its chat is the one-to-one chat
// with that handle (a group's guid has ;+;). The account must not be the owner's own Apple ID: a text to yourself
// raises no alert and its replies could not be told from Drover's own (health refuses it).
//
// Only the one-to-one chat with the owner is read at all: other chats are never passed on or recorded.
// Another program may drive imsg as another macOS user (each user has its own Messages database); this one reads only
// the daemon user's. Two watchers on the same database collide, so nothing else should run imsg rpc as this user.
import { spawn as nodeSpawn, execFile as nodeExecFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { envvar } from '../../envvars.js';
import { stateDir } from '../../paths.js';
import { e164 } from './sms.js';

export const NAME = 'imessage';
export const _deps = { spawn: nodeSpawn, execFile: nodeExecFile, env: process.env, platform: () => process.platform, exists: existsSync, stateDir: () => stateDir() };

/** A handle as compared: E.164 for a phone number, lower case for an email. */
export const handleOf = (s) => { const t = String(s ?? '').trim(); return t.includes('@') ? t.toLowerCase() : e164(t); };

const cfg = (env = _deps.env) => ({ to: handleOf(envvar('ASK_IMESSAGE_TO', env)), bin: envvar('ASK_IMSG', env) ?? '/opt/homebrew/bin/imsg' });

export function missing(env = _deps.env) {
  const c = cfg(env);
  return [_deps.platform() !== 'darwin' && 'macOS (imsg runs only on a Mac)', !(/^\+\d{8,15}$/.test(c.to) || /^[^@\s]+@[^@\s]+$/.test(c.to)) && 'DROVER_ASK_IMESSAGE_TO', !_deps.exists(c.bin) && `the imsg binary (${c.bin})`].filter(Boolean);
}
export const configured = (env) => missing(env).length === 0;

/** The one-to-one chat's counterpart in a chat guid ("iMessage;-;+17045550123"), or null for a group or no guid. */
export function dmHandle(chatGuid) {
  const m = /^[^;]+;-;(.+)$/.exec(String(chatGuid ?? ''));
  return m ? handleOf(m[1]) : null;
}

/** A watched message as the router reads it. */
export function readMessage(m, { env = _deps.env } = {}) {
  const owner = cfg(env).to;
  const sender = handleOf(m?.sender);
  const dm = dmHandle(m?.chat_guid);
  const fromMe = m?.is_from_me === true || m?.is_from_me === 1;
  const why = fromMe ? 'sent by this account' : !owner || sender !== owner ? 'not the owner\'s handle' : dm !== owner ? 'not the one-to-one chat with the owner' : null;
  return { channel: NAME, verified: !why, reason: why, sender: `imsg:${sender || '?'}`, text: typeof m?.text === 'string' ? m.text : '', providerMessageId: `imsg:${m?.guid ?? m?.id ?? ''}`, replyTo: m?.reply_to_guid ? `imsg:${m.reply_to_guid}` : null, button: null, rowid: Number(m?.id) || null, fromMe };
}

// ---------------------------------------------------------------- the rpc child
class Rpc {
  constructor({ bin, log, onMessage, sinceRowid }) {
    Object.assign(this, { bin, log, onMessage, sinceRowid });
    this.next = 1; this.waiting = new Map(); this.child = null; this.buf = ''; this.stopped = false; this.backoff = 1000; this.ready = null; this.subscribed = false;
  }
  start() {
    if (this.stopped) return;
    const child = _deps.spawn(this.bin, ['rpc', '--json'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { this.buf += d; let i; while ((i = this.buf.indexOf('\n')) >= 0) { const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1); if (line.trim()) this.#line(line); } });
    child.stderr.on('data', (d) => this.log('imsg', String(d).trim().slice(0, 300)));
    child.on('error', (e) => this.log('imsg spawn', e.message));
    child.on('exit', (code) => {
      for (const w of this.waiting.values()) w.reject(new Error(`imsg rpc exited (${code})`));
      this.waiting.clear(); this.child = null; this.ready = null; this.subscribed = false;
      if (this.stopped) return;
      this.log('imsg rpc exited', code, `restarting in ${this.backoff / 1000} s`);
      setTimeout(() => this.start(), this.backoff).unref?.();
      this.backoff = Math.min(60_000, this.backoff * 2);
    });
    const params = { attachments: false, include_reactions: false, ...(this.sinceRowid ? { since_rowid: this.sinceRowid } : {}) };
    // No watch, no channel: sending a question nobody can read the answer to helps no one. A failed subscribe restarts
    // the child (with its backoff), which subscribes again.
    this.ready = this.request('watch.subscribe', params, { timeoutMs: 30_000 }).then(() => { this.backoff = 1000; this.subscribed = true; }, (e) => { this.log('imsg watch.subscribe failed', e.message); try { child.kill('SIGTERM'); } catch { /* gone */ } });
  }
  #line(line) {
    let m; try { m = JSON.parse(line); } catch { return; }
    if (m.id !== undefined && m.id !== null && this.waiting.has(m.id)) {
      const w = this.waiting.get(m.id); this.waiting.delete(m.id);
      if (m.error) w.reject(new Error(`imsg ${w.method}: ${String(m.error.message ?? 'error').slice(0, 200)}`)); else w.resolve(m.result);
      return;
    }
    if (m.method === 'message' && m.params?.message) { try { this.onMessage(m.params.message); } catch (e) { this.log('imsg message', e.message); } }
    else if (m.method === 'error') this.log('imsg error', JSON.stringify(m.params ?? {}).slice(0, 300));
  }
  request(method, params = {}, { timeoutMs = 45_000 } = {}) {
    if (!this.child) return Promise.reject(new Error('imsg rpc is not running'));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waiting.delete(id); reject(new Error(`imsg ${method}: no answer in ${timeoutMs / 1000} s`)); }, timeoutMs);
      t.unref?.();
      this.waiting.set(id, { method, resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  stop() { this.stopped = true; try { this.child?.kill('SIGTERM'); } catch { /* gone */ } }
}

let rpc = null;
const cursorFile = () => path.join(_deps.stateDir(), 'ask', 'imsg-rowid');

/**
 * Watch for the owner's replies (the hub, on a Mac). onInbound gets readMessage() of every new message; the last
 * rowid seen is kept on disk so a restart replays what came in while it was down. Returns stop().
 */
export async function start(onInbound, { log = () => {}, env = _deps.env } = {}) {
  if (rpc) return () => {};
  let since = null;
  try { since = Number((await readFile(cursorFile(), 'utf8')).trim()) || null; } catch { /* first run */ }
  let saving = Promise.resolve();
  const onMessage = (m) => {
    const r = readMessage(m, { env });
    if (r.rowid && r.rowid > (rpc?.sinceRowid ?? 0)) {
      rpc.sinceRowid = r.rowid;
      saving = saving.then(async () => { await mkdir(path.dirname(cursorFile()), { recursive: true, mode: 0o700 }); const tmp = `${cursorFile()}.tmp`; await writeFile(tmp, `${r.rowid}\n`, { mode: 0o600 }); await rename(tmp, cursorFile()); }).catch(() => {});
    }
    // Only the one-to-one chat with the owner is read. Every other chat is this account's own business: never passed
    // on, never recorded (a Telegram bot's or an SMS number's strangers are recorded as untrusted; these are not).
    if (!r.fromMe && dmHandle(m?.chat_guid) === cfg(env).to) onInbound(r);
  };
  rpc = new Rpc({ bin: cfg(env).bin, log, onMessage, sinceRowid: since });
  rpc.start();
  return () => { rpc?.stop(); rpc = null; };
}

/** Send one iMessage to the owner. Returns { providerId }. */
export async function send({ text }, { env = _deps.env } = {}) {
  const c = cfg(env);
  if (!rpc) throw new Error('imsg is not running on this host (only the hub sends iMessages)');
  await rpc.ready;
  if (!rpc.subscribed) throw new Error('imsg is not watching for replies (watch.subscribe failed), so no question goes out on iMessage');
  const r = await rpc.request('send', { to: c.to, text, service: 'imessage', transport: 'applescript' }, { timeoutMs: 60_000 });
  const id = r?.guid ?? r?.rowid ?? r?.id ?? r?.message_id ?? '';
  return { providerId: `imsg:${id}`, messageIds: id ? [`imsg:${id}`] : [] };
}

const run = (bin, args, timeoutMs) => new Promise((resolve, reject) => {
  _deps.execFile(bin, args, { timeout: timeoutMs, maxBuffer: 1 << 20 }, (e, stdout) => (e ? reject(e) : resolve(String(stdout))));
});

/**
 * Health: imsg answers `account`, and that account is not the owner's own (a self-chat would raise no alert and
 * leave replies unverifiable). The aliases are compared, never returned.
 */
export async function health({ env = _deps.env } = {}) {
  const miss = missing(env);
  if (miss.length) return { ok: false, configured: false, missing: miss };
  const c = cfg(env);
  let out;
  try { out = await run(c.bin, ['account'], 15_000); } catch (e) { return { ok: false, configured: true, error: `imsg account failed: ${String(e.message).slice(0, 200)}` }; }
  if (!out.trim()) return { ok: false, configured: true, error: 'Messages is signed out of iMessage on this account (imsg account printed nothing)' };
  const digits = c.to.replace(/[^\d]/g, '');
  const mine = c.to.includes('@') ? out.toLowerCase().includes(c.to) : digits.length >= 10 && out.replace(/[^\d\n]/g, '').includes(digits.slice(-10));
  if (mine) return { ok: false, configured: true, error: 'this Mac account\'s iMessage is the owner\'s own Apple ID: a text to the owner would be a note to self. Sign it into another Apple ID, or run the daemon as another macOS user' };
  return { ok: true, configured: true, watching: Boolean(rpc?.child) };
}

/** For tests: forget the running child. */
export function _reset() { rpc?.stop(); rpc = null; }
