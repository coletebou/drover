// Split a long turn into overlapping chunks that each fit one embedding call.
// ~1600 chars is about 400 tokens: well under the 8K context, small enough that
// a hit points at the part of a long reply that matched. Pure; tests in test/search-extract.test.js.

/**
 * @param {string} text
 * @param {{max?: number, overlap?: number}} opts
 * @returns {string[]} chunks in order; [] for blank text
 */
export function chunkText(text, { max = 1600, overlap = 200 } = {}) {
  const s = String(text ?? '').trim();
  if (!s) return [];
  if (s.length <= max) return [s];
  const out = [];
  let start = 0;
  while (start < s.length) {
    if (s.length - start <= max) { out.push(s.slice(start).trim()); break; }
    const end = start + max;
    const cut = bestCut(s, start + Math.floor(max * 0.5), end);
    out.push(s.slice(start, cut).trim());
    // Step back by the overlap, then forward to a word start, but always make progress.
    let next = Math.max(cut - overlap, start + Math.floor(max / 2));
    const ws = s.slice(next, cut).search(/\s\S/);
    if (ws >= 0) next += ws + 1;
    start = next;
  }
  return out.filter(Boolean);
}

/** The latest good break in [lo, hi]: a blank line, then a newline, then a sentence end, then a space; else hi. */
function bestCut(s, lo, hi) {
  const win = s.slice(lo, hi);
  for (const re of [/\n\s*\n/g, /\n/g, /[.!?](?=\s)/g, /\s/g]) {
    let last = -1, m;
    re.lastIndex = 0;
    while ((m = re.exec(win))) last = m.index + m[0].length;
    if (last > 0) return lo + last;
  }
  return hi;
}
