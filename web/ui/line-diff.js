// A line diff for comparing two texts in the browser (a saved skill version with the live one, a draft with the skill
// it replaces). Pure: no DOM, so node tests it (test/ui-line-diff.test.js). The common head and tail are matched first,
// then a longest-common-subsequence table over what is left; a middle too large for the table (maxCells) comes back as
// one block removed and one added, marked exact: false, rather than freezing the page.

/** Lines of a text; a final newline does not make an empty last line. */
export function lines(text) {
  const s = String(text ?? '');
  if (!s) return [];
  const out = s.split('\n');
  if (out.at(-1) === '') out.pop();
  return out;
}

/**
 * a -> b as ops [{ t: ' ' | '-' | '+', s, a?, b? }] in order (a and b are 1-based line numbers in each text), with
 * counts of added and removed lines and whether the middle was diffed line by line (exact).
 */
export function lineDiff(a, b, { maxCells = 4_000_000 } = {}) {
  const A = Array.isArray(a) ? a : lines(a), B = Array.isArray(b) ? b : lines(b);
  let head = 0;
  while (head < A.length && head < B.length && A[head] === B[head]) head++;
  let tail = 0;
  while (tail < A.length - head && tail < B.length - head && A[A.length - 1 - tail] === B[B.length - 1 - tail]) tail++;
  const ops = [];
  for (let i = 0; i < head; i++) ops.push({ t: ' ', s: A[i], a: i + 1, b: i + 1 });
  const a0 = head, a1 = A.length - tail, b0 = head, b1 = B.length - tail;
  const n = a1 - a0, m = b1 - b0;
  let exact = true;
  if (n && m && (n + 1) * (m + 1) <= maxCells) {
    // L[i][j]: the LCS length of A[a0+i..a1) and B[b0+j..b1), filled from the end so the walk below goes forward.
    const w = m + 1, L = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      L[i * w + j] = A[a0 + i] === B[b0 + j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[a0 + i] === B[b0 + j]) { ops.push({ t: ' ', s: A[a0 + i], a: a0 + i + 1, b: b0 + j + 1 }); i++; j++; }
      else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) { ops.push({ t: '-', s: A[a0 + i], a: a0 + i + 1 }); i++; }
      else { ops.push({ t: '+', s: B[b0 + j], b: b0 + j + 1 }); j++; }
    }
    for (; i < n; i++) ops.push({ t: '-', s: A[a0 + i], a: a0 + i + 1 });
    for (; j < m; j++) ops.push({ t: '+', s: B[b0 + j], b: b0 + j + 1 });
  } else {
    if (n && m) exact = false;
    for (let i = a0; i < a1; i++) ops.push({ t: '-', s: A[i], a: i + 1 });
    for (let j = b0; j < b1; j++) ops.push({ t: '+', s: B[j], b: j + 1 });
  }
  for (let k = 0; k < tail; k++) ops.push({ t: ' ', s: A[a1 + k], a: a1 + k + 1, b: b1 + k + 1 });
  return { ops, added: ops.filter((o) => o.t === '+').length, removed: ops.filter((o) => o.t === '-').length, exact };
}

/**
 * The ops grouped into hunks with `context` unchanged lines around each change, the way a unified diff shows them:
 * [{ aStart, aLines, bStart, bLines, ops }]. No changes, no hunks.
 */
export function hunks(ops, context = 3) {
  const changed = ops.map((o, i) => (o.t === ' ' ? -1 : i)).filter((i) => i >= 0);
  if (!changed.length) return [];
  const out = [];
  let start = Math.max(0, changed[0] - context), end = Math.min(ops.length, changed[0] + context + 1);
  const flush = () => {
    const slice = ops.slice(start, end);
    const firstA = slice.find((o) => o.a)?.a ?? (ops.slice(0, start).reverse().find((o) => o.a)?.a ?? 0);
    const firstB = slice.find((o) => o.b)?.b ?? (ops.slice(0, start).reverse().find((o) => o.b)?.b ?? 0);
    out.push({ aStart: firstA, aLines: slice.filter((o) => o.t !== '+').length, bStart: firstB, bLines: slice.filter((o) => o.t !== '-').length, ops: slice });
  };
  for (const i of changed.slice(1)) {
    if (i - context <= end) end = Math.min(ops.length, i + context + 1);
    else { flush(); start = Math.max(0, i - context); end = Math.min(ops.length, i + context + 1); }
  }
  flush();
  return out;
}
