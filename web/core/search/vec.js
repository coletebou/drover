// Vector math for the index. EmbeddingGemma 2 returns 768 numbers trained with
// Matryoshka learning, so the leading 256 keep nearly all of the quality (model
// card: MTEB multilingual 61.36 at 768, 60.41 at 256). A cut vector must be
// re-normalized or cosine ranking degrades silently. Stored as int8 with one
// float scale per vector: 256 bytes each, so 100k chunks fit in 26 MB of RAM.
// Pure; tests in test/search-extract.test.js.

export const DIMS = 256;

/** First `dims` components, L2-normalized, as a Float32Array (a zero vector stays zero). */
export function truncateNormalize(v, dims = DIMS) {
  const n = Math.min(dims, v.length);
  const out = new Float32Array(dims);
  let ss = 0;
  for (let i = 0; i < n; i++) { const x = Number(v[i]) || 0; out[i] = x; ss += x * x; }
  const norm = Math.sqrt(ss);
  if (norm > 0) for (let i = 0; i < n; i++) out[i] /= norm;
  return out;
}

/** Symmetric int8 quantization: q[i] = round(v[i] / scale), scale = max|v| / 127. */
export function quantize(f32) {
  let m = 0;
  for (let i = 0; i < f32.length; i++) { const a = Math.abs(f32[i]); if (a > m) m = a; }
  const scale = m > 0 ? m / 127 : 1;
  const q = new Int8Array(f32.length);
  for (let i = 0; i < f32.length; i++) q[i] = Math.max(-127, Math.min(127, Math.round(f32[i] / scale)));
  return { q, scale };
}

export function dequantize(q, scale) {
  const out = new Float32Array(q.length);
  for (let i = 0; i < q.length; i++) out[i] = q[i] * scale;
  return out;
}

/** Cosine of two normalized float vectors. */
export function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * An append-only matrix of quantized vectors with their keys (chunk text hashes).
 * score(query) returns the best k rows by cosine without allocating per row.
 */
export class VectorMatrix {
  constructor(dims = DIMS) { this.dims = dims; this.cap = 0; this.n = 0; this.q = new Int8Array(0); this.scale = new Float32Array(0); this.keys = []; this.row = new Map(); }
  #grow(min) {
    const cap = Math.max(min, this.cap * 2, 1024);
    const q = new Int8Array(cap * this.dims); q.set(this.q.subarray(0, this.n * this.dims));
    const sc = new Float32Array(cap); sc.set(this.scale.subarray(0, this.n));
    this.q = q; this.scale = sc; this.cap = cap;
  }
  has(key) { return this.row.has(key); }
  add(key, q, scale) {
    if (this.row.has(key)) return;
    if (q.length !== this.dims) throw new Error(`vector has ${q.length} dims, index uses ${this.dims}`);
    if (this.n >= this.cap) this.#grow(this.n + 1);
    this.q.set(q, this.n * this.dims); this.scale[this.n] = scale;
    this.row.set(key, this.n); this.keys.push(key); this.n++;
  }
  /** Top k [key, cosine] pairs for a normalized float query; `allow` (a Set of keys) restricts the rows ranked. */
  topK(query, k = 100, allow = null) {
    const d = this.dims, best = [];
    let floor = -Infinity;
    for (let r = 0; r < this.n; r++) {
      if (allow && !allow.has(this.keys[r])) continue;
      let s = 0; const off = r * d;
      for (let i = 0; i < d; i++) s += query[i] * this.q[off + i];
      s *= this.scale[r];
      if (best.length < k) { best.push([r, s]); if (best.length === k) { best.sort((a, b) => b[1] - a[1]); floor = best[k - 1][1]; } }
      else if (s > floor) {
        // Insert in order, drop the last.
        let i = k - 1; while (i > 0 && best[i - 1][1] < s) i--;
        best.splice(i, 0, [r, s]); best.pop(); floor = best[k - 1][1];
      }
    }
    if (best.length < k) best.sort((a, b) => b[1] - a[1]);
    return best.map(([r, s]) => [this.keys[r], s]);
  }
}
