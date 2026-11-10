// The hub's signature on its calls to an asking host (ask.deliver, ask.mark): docs/ask.md, trust.
//
// Every agent on a host runs as the same user as Drover there, so nothing a process on the asking host can see or set
// proves that a call came from the hub: not SSH_CONNECTION (any process sets it), not a process name (a copy of bash
// named sshd is "sshd"), not even a real sshd above the rpc (`ssh localhost "exec env SSH_CONNECTION=... drover rpc"`).
// What such a process cannot make is the hub's signature. The hub signs each call with an Ed25519 key that never leaves
// it (<state>/ask/hub-key.pem, 0600, made on first use), and the asking host checks the signature against the hub's
// public key in its own settings (DROVER_ASK_HUB_KEY, from `drover ask status` on the hub). A replayed call repeats its
// own answer, which delivery already takes once (by provider message id): it cannot carry another.
import { generateKeyPairSync, createPrivateKey, createPublicKey, createHash, sign as edSign, verify as edVerify } from 'node:crypto';
import { readFile, writeFile, mkdir, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import { stateDir } from '../paths.js';
import { envvar } from '../envvars.js';

export const _deps = { stateDir: () => stateDir(), env: process.env };

// What each signed call carries: only these fields are signed, so a transport that adds its own (an actor, say) does
// not break a signature, and a field the op reads cannot change after signing.
const FIELDS = {
  'ask.deliver': ['askId', 'code', 'answers', 'source', 'channel', 'providerMessageId', 'sender', 'raw', 'followUp', 'hub'],
  'ask.mark': ['askId', 'phase', 'code', 'hub', 'why'],
};

const keyFile = () => path.join(_deps.stateDir(), 'ask', 'hub-key.pem');
let cached = null;   // { file, key }

/** The hub's private key, made (and kept, 0600) the first time it is needed. */
export async function privateKey({ create = true } = {}) {
  const file = keyFile();
  if (cached?.file === file) return cached.key;
  let pem = null;
  try { pem = await readFile(file, 'utf8'); } catch { /* not made yet */ }
  if (!pem) {
    if (!create) return null;
    const { privateKey: k } = generateKeyPairSync('ed25519');
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, k.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    // Made once: link refuses a name that exists, so two processes making it at once both end up with the one on disk.
    try { await link(tmp, file); } catch (e) { if (e.code !== 'EEXIST') throw e; } finally { await unlink(tmp).catch(() => {}); }
    pem = await readFile(file, 'utf8');
  }
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`${file} is not an Ed25519 key`);
  cached = { file, key };
  return key;
}

const keyString = (pub) => `ed25519:${pub.export({ format: 'der', type: 'spki' }).toString('base64')}`;
/** A short, stable name for a key (the first 16 hex of its SHA-256), for status lines and records. */
export const fingerprint = (pub) => createHash('sha256').update(pub.export({ format: 'der', type: 'spki' })).digest('hex').slice(0, 16);

/** The hub's public key, as DROVER_ASK_HUB_KEY takes it: ed25519:<base64 SPKI>. Makes the key pair on first use. */
export async function publicKeyString() { return keyString(createPublicKey(await privateKey())); }

/** One ed25519:<base64> key, or null. */
export function parseKey(s) {
  const m = /^ed25519:([A-Za-z0-9+/]+={0,2})$/.exec(String(s ?? '').trim());
  if (!m) return null;
  try {
    const k = createPublicKey({ key: Buffer.from(m[1], 'base64'), format: 'der', type: 'spki' });
    return k.asymmetricKeyType === 'ed25519' ? k : null;
  } catch { return null; }
}

/** The keys this host takes the hub's calls from: DROVER_ASK_HUB_KEY (several, comma-separated, while a key changes). */
export function trustedKeys(env = _deps.env) {
  return String(envvar('ASK_HUB_KEY', env) ?? '').split(/[\s,]+/).filter(Boolean).map(parseKey).filter(Boolean);
}

/** JSON with every object's keys in order and undefined left out: the same text for the same value on both ends. */
function stable(v) {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : stable(x))).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

/** The text signed for a call: its op and the fields that op reads. */
export function canonical(op, args = {}) {
  const fields = FIELDS[op];
  if (!fields) throw new Error(`${op} is not a signed call`);
  const body = {};
  for (const f of fields) if (args[f] !== undefined && args[f] !== null) body[f] = args[f];
  return stable({ v: 1, op, args: body });
}

/** The hub's signature for a call (base64). */
export async function signCall(op, args) {
  return edSign(null, Buffer.from(canonical(op, args)), await privateKey()).toString('base64');
}

/** Which trusted key signed this call (its fingerprint), or null when none did. */
export function verifyCall(op, args, sig, keys = trustedKeys()) {
  if (typeof sig !== 'string' || !sig || !keys.length || !FIELDS[op]) return null;
  const data = Buffer.from(canonical(op, args));
  const s = Buffer.from(sig, 'base64');
  for (const k of keys) { try { if (edVerify(null, data, k, s)) return fingerprint(k); } catch { /* a malformed signature */ } }
  return null;
}

/** For tests: forget the key read from disk. */
export const _reset = () => { cached = null; };
