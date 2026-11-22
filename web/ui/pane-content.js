// What an agent's pane says, without the agent's own furniture. The bottom of a Claude Code or Codex pane is always
// the same few rows (the input box, the status line, the mode line, a notice): a Wall tile that draws the bottom of
// the pane draws only those. paneContent takes a parsed capture (ansi.js parseAnsi: lines of styled runs) and gives
// back the lines above that furniture, with what was typed and not sent kept, tips dropped and blank runs collapsed.
// A dialog is never cut: it is what the pane asks. A pane it does not recognise (a shell, an older agent) comes back
// whole. Pure; shared by web/tui/views/wall.js and web/ui/views/wall.js; tests in test/pane-content.test.js.

const textOf = (line) => (line ?? []).map((r) => r.text ?? '').join('');
const blank = (line) => !textOf(line).trim();

// The same shapes core/tmux.js inputBox reads (Claude Code 2.1.3xx: a bare ❯ between two rules; older: a ╭─╮ box).
const RULE = (t) => { const s = t.trim(); if (s.length < 8 || !s.startsWith('───')) return false; return (s.match(/─/g) ?? []).length >= s.length * 0.6; };
const BOX_TOP = (t) => /^\s*╭─{3,}.*╮\s*$/.test(t), BOX_BOTTOM = (t) => /^\s*╰─{3,}.*╯\s*$/.test(t);
const FOOTER_MAX = 6;       // rows under the box: the status line (one to four rows) and the mode line
const BOX_MAX = 31;         // rows a typed draft can take
const OPTION = /^\s*[❯›>]\s*\d+\.\s/;                       // "❯ 1. Yes": a dialog's selected option, never an input line
const DIALOG_FOOT = /Esc to cancel|Enter to (select|confirm)|Press enter to confirm/i;
// The row Claude Code keeps for its notices, directly above the input box: right-aligned in a wide pane.
const NOTICE = /\/clear to save|auto-update|update installed|restart to update|claude doctor|\/goal active/i;
const isNotice = (t) => /^\s{16,}\S/.test(t) || NOTICE.test(t);
const TIP = /^\s*[└⎿]\s+Tip: /;
const MODE = /\? for shortcuts|bypass permissions on|accept edits on|plan mode on/i;

const hex = (c) => { const n = parseInt(String(c).slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
/** Faint text: SGR 2 or a grey foreground. That is how a placeholder or a predicted prompt is drawn in an input box. */
export function isFaint(run) {
  if (run?.dim) return true;
  if (!/^#[0-9a-f]{6}$/i.test(run?.fg ?? '')) return false;
  const [r, g, b] = hex(run.fg); const avg = (r + g + b) / 3;
  return Math.max(r, g, b) - Math.min(r, g, b) <= 16 && avg >= 70 && avg <= 190;
}
const styled = (run) => Boolean(run.fg || run.bg || run.bold || run.dim || run.italic || run.underline || run.reverse);

/** Whether the box rows hold something typed: a visible character after the prompt glyph that is not faint or the cursor. */
function typed(rows) {
  let seenGlyph = false;
  for (const row of rows) {
    for (const run of row) {
      for (const ch of run.text ?? '') {
        if (!seenGlyph) { if (ch === '❯' || ch === '›' || ch === '>') seenGlyph = true; continue; }
        if (/\s|│/.test(ch)) continue;
        if (!isFaint(run) && !run.reverse) return true;
      }
    }
  }
  return false;
}

/** The furniture at the bottom of a pane: { start (first row of it), box: [first, last] rows of the input, width? (the pane's, from a rule) } or null. */
function furniture(plain) {
  const n = plain.length;
  const from = Math.max(0, n - 40);
  const rules = [];
  for (let i = from; i < n; i++) if (RULE(plain[i])) rules.push(i);
  if (rules.length >= 2) {
    const r2 = rules.at(-1), r1 = rules.at(-2);
    if (n - 1 - r2 <= FOOTER_MAX && r2 - r1 >= 2 && r2 - r1 <= BOX_MAX && /^\s*❯(\s|$)/.test(plain[r1 + 1]) && !OPTION.test(plain[r1 + 1])) {
      return { start: r1 > 0 && (isNotice(plain[r1 - 1]) || !plain[r1 - 1].trim()) ? r1 - 1 : r1, box: [r1 + 1, r2 - 1], width: plain[r2].trimEnd().length };
    }
  }
  for (let b = n - 1; b >= Math.max(from, n - 1 - FOOTER_MAX); b--) {
    if (!BOX_BOTTOM(plain[b])) continue;
    for (let t = b - 1; t >= Math.max(from, b - BOX_MAX); t--) {
      if (!BOX_TOP(plain[t])) continue;
      if (b - t >= 2 && /^\s*│\s*>(\s|$)/.test(plain[t + 1])) return { start: t, box: [t + 1, b - 1], width: plain[b].trimEnd().length };
      break;
    }
    break;
  }
  // Codex: a › line with only its footer under it. Its scrollback draws a sent prompt the same way, so only the lowest counts.
  for (let i = n - 1; i >= Math.max(from, n - 8); i--) {
    if (!/^\s*›(\s|$)/.test(plain[i]) || OPTION.test(plain[i])) continue;
    let end = i; while (end + 1 < n && plain[end + 1].trim() && end - i < 6) end++;   // a draft's own rows end at the blank row over the footer
    return { start: i, box: [i, end] };
  }
  return null;
}

const lead = (t) => t.length - t.trimStart().length;
const MARK = /^(?:[⏺●•✻✶✳✢✽·※›❯*-]|\d{1,2}[.)])\s+/u;
/** Columns the later rows of a wrapped line start at: its own indent plus its bullet's width. */
const hangOf = (t) => { const l = lead(t); const m = t.slice(l).match(MARK); return l + (m ? m[0].length : 0); };

/** runs cut to their first n characters. */
function cutRuns(runs, n) {
  const out = []; let left = n;
  for (const r of runs) { if (left <= 0) break; const t = String(r.text ?? ''); out.push(t.length <= left ? r : { ...r, text: t.slice(0, left) }); left -= t.length; }
  return out;
}
/** runs without their first n characters. */
function dropRuns(runs, n) {
  const out = []; let left = n;
  for (const r of runs) { const t = String(r.text ?? ''); if (left >= t.length) { left -= t.length; continue; } out.push(left ? { ...r, text: t.slice(left) } : r); left = 0; }
  return out;
}

/**
 * An agent wraps its own prose at the pane's width and indents the rows after the first: those rows are one line
 * again here, so a narrower tile wraps it once, at its own width. A row continues the one above when that one
 * reached the pane's edge (within a word of it), the row sits at that paragraph's hanging indent, and it starts no
 * bullet of its own. Only indented or bulleted text is joined (what Claude Code and Codex draw): a shell's output,
 * a table and a rule stay as they are.
 */
export function reflow(lines, width) {
  if (!(width > 20)) return lines;
  const out = []; let hang = 0, lastLen = 0;
  for (const line of lines) {
    const t = textOf(line); const prev = out.at(-1);
    const joins = prev && hang > 0 && t.trim() && lastLen >= width * 0.8 && lead(t) === hang && hangOf(t) === hang && !keepsShape(t) && !keepsShape(textOf(prev));
    if (joins) {
      const head = textOf(prev);
      out[out.length - 1] = [...cutRuns(prev, head.trimEnd().length), { text: ' ' }, ...dropRuns(line, hang)];
    } else { out.push(line); hang = t.trim() ? hangOf(t) : 0; }
    lastLen = t.trimEnd().length;
  }
  return out;
}

// What Claude Code appends to a recap: a tip, not something the agent said.
const RECAP_TIP = /\s*\(turn off recaps in \/config\)\s*$/;

/**
 * The lines of a parsed capture worth reading: { lines, chrome }. lines are the capture's own runs (colours kept);
 * chrome is how many rows of furniture were left out (0: nothing recognised, or a dialog). state is the screen the
 * daemon read ('dialog' keeps everything).
 */
export function paneContent(lines, { state = null } = {}) {
  const all = [...(lines ?? [])];
  while (all.length && blank(all.at(-1))) all.pop();
  const plain = all.map(textOf);
  let body = all; let chrome = 0;
  const f = state === 'dialog' ? null : furniture(plain);
  if (f && !plain.slice(f.start).some((t) => DIALOG_FOOT.test(t) || OPTION.test(t))) {
    const box = all.slice(f.box[0], f.box[1] + 1);
    // Without colours (an older daemon's plain capture) a placeholder cannot be told from typed text: no draft.
    const draft = all.some((l) => l.some(styled)) && typed(box) ? box : [];
    body = [...all.slice(0, f.start), ...(draft.length ? [[], ...draft] : [])];
    chrome = all.length - f.start - draft.length;
  }
  // The pane's width: the input box's rule when there is one, else the longest row (some row reaches the edge).
  const width = f?.width ?? plain.reduce((n, t) => Math.max(n, t.trimEnd().length), 0);
  const out = [];
  for (let line of reflow(body.filter((l) => !TIP.test(textOf(l))), width)) {
    if (blank(line)) { if (out.length && !blank(out.at(-1))) out.push([]); continue; }
    const t = textOf(line); const tip = t.match(RECAP_TIP);
    if (tip) line = cutRuns(line, tip.index);
    out.push(line);
  }
  while (out.length && blank(out.at(-1))) out.pop();
  return { lines: out, chrome };
}

/**
 * Whether a line is drawn to be seen whole rather than read (a rule, a box, a table row, a tree): it is cut at the
 * tile's edge. Everything else wraps.
 */
export function keepsShape(text) {
  const t = String(text ?? '');
  return /^\s*[─━═│┃║╭╮╰╯┌┐└┘├┤┬┴┼]/.test(t) || (t.match(/[│┃║]/g) ?? []).length >= 2;
}

/** Columns a wrapped line's later rows are indented by: its own indent plus a bullet's width, at most cap. */
export function hangingIndent(text, cap = 6) { return Math.max(0, Math.min(cap, hangOf(String(text ?? '')))); }

/**
 * The board's own last lines for a strip (plain text: the last rows of its pane, as an older daemon sends them)
 * without the furniture: nothing from the input box down, no notice, tip or mode line. What is left is what the
 * agent said, or nothing.
 */
export function tailContent(tail) {
  const out = [];
  for (const raw of Array.isArray(tail) ? tail : []) {
    const t = String(raw ?? '');
    if (RULE(t) || BOX_TOP(t) || /^\s*[❯›]\s*$/.test(t)) break;
    if (!t.trim() || isNotice(t) || TIP.test(t) || MODE.test(t)) continue;
    out.push(t);
  }
  return out;
}

/** The last line with something on it, as plain text (a hover preview). */
export function lastText(lines) {
  for (let i = (lines ?? []).length - 1; i >= 0; i--) { const t = textOf(lines[i]).trim(); if (t) return t; }
  return '';
}
