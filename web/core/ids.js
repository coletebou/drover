// UUIDv7: time-ordered ids so the events file sorts by creation without a
// separate sequence.
import { randomBytes } from 'node:crypto';

let lastMs = 0;
let seq = 0;

export function uuidv7(now = Date.now()) {
  if (now === lastMs) seq = (seq + 1) & 0x0fff;
  else { lastMs = now; seq = randomBytes(2).readUInt16BE(0) & 0x0fff; }
  const b = Buffer.alloc(16);
  b.writeUIntBE(now, 0, 6);
  b.writeUInt16BE(0x7000 | seq, 6);
  randomBytes(8).copy(b, 8);
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function isUuid(s) {
  return typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
