// Device pairing. A client with no token asks to pair (POST /api/pair/request), shows the
// 6-digit code it gets back, and polls /api/pair/status. Someone at the Mac approves that
// code (`drover pair approve <code>` or Approve in the browser UI, both with the main
// token), and the next poll hands the client the main and widget tokens, once.
//
// Approving is deliberately not an op: ops are reachable through the generic MCP tool and
// over ssh rpc, and a prompt-injected agent or a remote peer must not be able to grant the
// token. Requests live in this daemon's memory only and expire after two minutes.
import { randomBytes, randomInt } from 'node:crypto';
import { execFile } from 'node:child_process';
import { envvar } from './envvars.js';

export const TTL_MS = 120_000;
export const COLLECT_MS = 30_000;   // an approval right before expiry still leaves time to collect
export const MAX_PENDING = 5;
export const MAX_PER_MINUTE = 20;
const LABEL_MAX = 64;

export const _deps = { now: () => Date.now(), execFile, platform: () => process.platform };

const requests = new Map(); // requestId -> { requestId, code, client, device, from, createdAt, expiresAt, state }
let created = [];           // creation times inside the last minute

export class PairError extends Error {
  constructor(message, status) { super(message); this.name = 'PairError'; this.status = status; }
}

function sweep(now = _deps.now()) {
  for (const [id, r] of requests) if (r.expiresAt <= now) requests.delete(id);
  created = created.filter((t) => now - t < 60_000);
}

function label(v, name, max = LABEL_MAX) {
  if (v == null) return '';
  if (typeof v !== 'string') throw new PairError(`${name} must be a string`, 400);
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length > max) throw new PairError(`${name} too long (max ${max} characters)`, 400);
  return s;
}

const pendingCount = () => [...requests.values()].filter((r) => r.state === 'pending').length;

/** A new pairing request. Throws PairError 400 (bad labels) or 429 (too many pending or too fast). */
export function createRequest({ client, device, from = '' } = {}) {
  const now = _deps.now();
  sweep(now);
  const c = label(client, 'client');
  if (!c) throw new PairError('client is required', 400);
  const d = label(device, 'device');
  if (pendingCount() >= MAX_PENDING || created.length >= MAX_PER_MINUTE) {
    throw new PairError('too many pairing requests; approve or deny the pending ones, or wait for them to expire', 429);
  }
  const live = new Set([...requests.values()].map((r) => r.code));
  let code;
  do code = String(randomInt(0, 1_000_000)).padStart(6, '0'); while (live.has(code));
  const r = { requestId: randomBytes(16).toString('hex'), code, client: c, device: d, from: label(from, 'from', 128), createdAt: now, expiresAt: now + TTL_MS, state: 'pending' };
  requests.set(r.requestId, r);
  created.push(now);
  return { requestId: r.requestId, code, expiresAt: new Date(r.expiresAt).toISOString(), client: c, device: d, from: r.from };
}

/** AppleScript string literal. client and device come from an unauthenticated request. */
export const appleString = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * Tell whoever sits at this Mac that a device wants to pair (a macOS banner; DROVER_PAIR_NOTIFY=off
 * silences it). The browser UI hears it separately, over the event stream.
 */
export function announce({ code, client, device, from }) {
  if (_deps.platform() !== 'darwin' || /^(0|off|false|no)$/i.test(String(envvar('PAIR_NOTIFY') ?? 'on'))) return;
  // Both labels are the requester's own words; the code on the device in your hand is the only real check.
  const text = `${client}${device ? ` on ${device}` : ''} asks to pair from ${from || 'an unknown address'}. Approve only if that device shows ${formatCode(code)}: drover pair approve ${code}, or Approve in Drover.`;
  _deps.execFile('osascript', ['-e', `display notification ${appleString(text)} with title "Drover"`], { timeout: 5_000 }, () => {});
}

/**
 * What the requesting client sees. null means unknown, expired or already answered (HTTP 404).
 * An approved or denied request is answered once and then forgotten.
 */
export function status(requestId, { token, widgetToken }) {
  sweep();
  if (typeof requestId !== 'string' || !/^[0-9a-f]{32}$/.test(requestId)) return null;
  const r = requests.get(requestId);
  if (!r) return null;
  if (r.state === 'pending') return { status: 'pending', expiresAt: new Date(r.expiresAt).toISOString() };
  requests.delete(requestId);
  if (r.state === 'denied') return { status: 'denied' };
  return { status: 'approved', token, widgetToken };
}

/** Pending requests for the approver. Never includes the request id, which is the client's secret. */
export function pending() {
  sweep();
  return [...requests.values()].filter((r) => r.state === 'pending').map((r) => ({
    code: r.code, client: r.client, device: r.device, from: r.from,
    createdAt: new Date(r.createdAt).toISOString(), expiresAt: new Date(r.expiresAt).toISOString(),
  }));
}

function findPending(code) {
  const c = String(code ?? '').replace(/[\s-]/g, '');
  if (!/^\d{6}$/.test(c)) throw new PairError('code must be the 6 digits the device shows', 400);
  sweep();
  const r = [...requests.values()].find((x) => x.state === 'pending' && x.code === c);
  if (!r) throw new PairError(`no pending pairing request with code ${c} (it may have expired)`, 404);
  return r;
}

export function approve(code) {
  const r = findPending(code);
  r.state = 'approved';
  r.expiresAt = Math.max(r.expiresAt, _deps.now() + COLLECT_MS);
  return { approved: true, client: r.client, device: r.device };
}

export function deny(code) {
  const r = findPending(code);
  r.state = 'denied';
  return { denied: true, client: r.client, device: r.device };
}

/** Tests only. */
export function _reset() { requests.clear(); created = []; }

/** "123456" -> "123 456", the way clients show it. */
export const formatCode = (code) => `${code.slice(0, 3)} ${code.slice(3)}`;
