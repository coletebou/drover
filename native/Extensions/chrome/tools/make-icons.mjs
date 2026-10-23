// Generates icons/icon-{16,32,48,128}.png with node built-ins only.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const FILL = hex('#16191e');
const EDGE = hex('#3a414c');
const BARS = [hex('#e2a73e'), hex('#8db6df'), hex('#8ebd87')];
const LENGTHS = [1, 0.75, 0.55];

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = x < x0 + r ? x0 + r : x > x1 - r ? x1 - r : x;
  const cy = y < y0 + r ? y0 + r : y > y1 - r ? y1 - r : y;
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** Colour of the sample point (px, py in pixel units) or null when transparent. */
function sample(px, py, size) {
  const r = size * 0.22;
  const edge = Math.max(1, size / 32);
  if (!inRoundRect(px, py, 0, 0, size, size, r)) return null;
  for (let i = 0; i < 3; i++) {
    const barH = size * 0.12;
    const gap = size * 0.07;
    const top = size / 2 - (3 * barH + 2 * gap) / 2 + i * (barH + gap);
    const left = size * 0.19;
    const w = size * 0.62 * LENGTHS[i];
    if (inRoundRect(px, py, left, top, left + w, top + barH, barH / 2)) return BARS[i];
  }
  if (!inRoundRect(px, py, edge, edge, size - edge, size - edge, Math.max(0, r - edge))) return EDGE;
  return FILL;
}

function render(size) {
  const SS = 4;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const c = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS, size);
        if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      if (a) { raw[o] = Math.round(r / a); raw[o + 1] = Math.round(g / a); raw[o + 2] = Math.round(b / a); raw[o + 3] = Math.round((a / (SS * SS)) * 255); }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const outDir = new URL('../icons/', import.meta.url);
mkdirSync(fileURLToPath(outDir), { recursive: true });
for (const size of [16, 32, 48, 128]) writeFileSync(new URL(`icon-${size}.png`, outDir), render(size));
console.log('wrote icons/icon-{16,32,48,128}.png');
