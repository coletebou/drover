// Terminal input to key events: a streaming decoder for what a terminal sends in raw mode. UTF-8 text, C0
// controls (Ctrl-letters), ESC-prefixed Alt keys, CSI and SS3 sequences with xterm modifiers, CSI u (kitty and
// tmux extended keys), and bracketed paste. ssh and tmux split sequences across reads: an incomplete one waits for
// the next chunk, and a lone ESC is the Escape key only once flush() runs after a quiet moment (the caller's
// timer). Pure; tests in test/tui-keys.test.js.
//
// An event is { name, ch?, ctrl, alt, shift, id } or { name: 'paste', text, id: 'paste' }. name is the character
// for text keys ("a", "A", "?", "漢") and a word for the rest (enter, tab, backspace, escape, up, down, left,
// right, home, end, pgup, pgdn, insert, delete, f1..f12, space). id is what bindings match: "a", "C-c", "M-x",
// "M-enter", "S-tab", "C-up", "pgdn", "f1".

const CSI_TILDE = { 1: 'home', 2: 'insert', 3: 'delete', 4: 'end', 5: 'pgup', 6: 'pgdn', 7: 'home', 8: 'end', 11: 'f1', 12: 'f2', 13: 'f3', 14: 'f4', 15: 'f5', 17: 'f6', 18: 'f7', 19: 'f8', 20: 'f9', 21: 'f10', 23: 'f11', 24: 'f12' };
const CSI_LETTER = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end', E: 'begin', P: 'f1', Q: 'f2', R: 'f3', S: 'f4', Z: 'tab' };
const SS3 = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end', P: 'f1', Q: 'f2', R: 'f3', S: 'f4', M: 'enter' };
const CSI_U = { 9: 'tab', 13: 'enter', 27: 'escape', 32: 'space', 127: 'backspace' };
const PASTE_END = '\x1b[201~';

/** The binding id of an event: modifiers C-, M-, S- (S- only on keys that have no shifted character). */
export function keyId(name, { ctrl = false, alt = false, shift = false, text = false } = {}) {
  return `${ctrl ? 'C-' : ''}${alt ? 'M-' : ''}${shift && !text ? 'S-' : ''}${name}`;
}
function key(name, mods = {}) { return { name, ctrl: Boolean(mods.ctrl), alt: Boolean(mods.alt), shift: Boolean(mods.shift), id: keyId(name, mods) }; }
function char(ch, alt = false) { return { name: ch, ch, ctrl: false, alt, shift: ch !== ch.toLowerCase(), id: alt ? `M-${ch}` : ch }; }
function mods(param) { const m = Math.max(0, (Number(param) || 1) - 1); return { shift: Boolean(m & 1), alt: Boolean(m & 2), ctrl: Boolean(m & 4) }; }

/** One control byte (or DEL) as a key, Alt added when it came after ESC. */
function control(c, alt) {
  const code = c.charCodeAt(0);
  if (c === '\r') return key('enter', { alt });
  if (c === '\n') return key('j', { ctrl: true, alt });      // Ctrl-J: a newline in the composer
  if (c === '\t') return key('tab', { alt });
  if (c === '\x7f' || c === '\b') return key('backspace', { alt });
  if (code === 0) return key('space', { ctrl: true, alt });
  if (code < 27) return key(String.fromCharCode(code + 96), { ctrl: true, alt });
  return key({ 28: '\\', 29: ']', 30: '^', 31: '_' }[code] ?? 'unknown', { ctrl: true, alt });
}

function csiKey(params, final) {
  const p = params.split(';');
  if (final === '~') { const name = CSI_TILDE[Number(p[0])]; return name ? key(name, mods(p[1])) : key('unknown'); }
  if (final === 'u') {
    // CSI codepoint[:shifted] ; modifiers u
    const [cp] = p[0].split(':').map(Number); const m = mods(p[1]);
    if (CSI_U[cp]) return key(CSI_U[cp], m);
    if (!Number.isFinite(cp) || cp < 32) return key('unknown');
    const ch = String.fromCodePoint(cp);
    if (m.ctrl) return key(ch.toLowerCase(), m);
    const shifted = m.shift ? ch.toUpperCase() : ch;
    return m.alt ? char(shifted, true) : char(shifted);
  }
  if (final === 'Z') return key('tab', { ...mods(p[1]), shift: true });
  if (CSI_LETTER[final]) return key(CSI_LETTER[final], mods(p.length > 1 ? p[1] : 1));
  return key('unknown');
}

export function createDecoder() {
  let buf = '';
  let paste = null;   // the text of a bracketed paste in progress

  function drain(final, force) {
    const out = [];
    while (buf.length) {
      if (paste !== null) {
        const end = buf.indexOf(PASTE_END);
        if (end >= 0) { out.push({ name: 'paste', text: paste + buf.slice(0, end), id: 'paste' }); paste = null; buf = buf.slice(end + PASTE_END.length); continue; }
        // Keep a tail that could be the start of the end marker.
        let keep = 0; for (let n = Math.min(PASTE_END.length - 1, buf.length); n > 0; n--) if (PASTE_END.startsWith(buf.slice(-n))) { keep = n; break; }
        paste += buf.slice(0, buf.length - keep); buf = buf.slice(buf.length - keep);
        break;
      }
      const c = buf[0];
      if (c !== '\x1b') {
        const code = c.charCodeAt(0);
        if (code < 32 || code === 0x7f) { out.push(control(c, false)); buf = buf.slice(1); continue; }
        const cp = buf.codePointAt(0); const ch = String.fromCodePoint(cp);
        out.push(char(ch)); buf = buf.slice(ch.length); continue;
      }
      if (buf.length === 1) { if (final) { out.push(key('escape')); buf = ''; } break; }
      const n = buf[1];
      if (n === '[') {
        const m = buf.slice(2).match(/^[0-?]*[ -\/]*[@-~]/);
        if (!m) {
          // Unfinished: wait, unless the bytes so far cannot become a sequence or the caller gave up waiting.
          if (!final && /^[0-?]*[ -\/]*$/.test(buf.slice(2)) && buf.length < 32) break;
          out.push(key('[', { alt: true })); buf = buf.slice(2); continue;
        }
        const seq = m[0]; buf = buf.slice(2 + seq.length);
        const params = seq.slice(0, -1); const fin = seq.at(-1);
        if (fin === '~' && params === '200') { paste = ''; continue; }
        if (fin === '~' && params === '201') continue;          // a stray paste end
        if (params.startsWith('<') || fin === 'M' || fin === 'm' || fin === 'I' || fin === 'O') continue;   // mouse, focus
        out.push(csiKey(params.replace(/^[?>=]/, ''), fin));
        continue;
      }
      if (n === 'O') {
        if (buf.length < 3) { if (final) { out.push(char('O', true)); buf = buf.slice(2); } else break; continue; }
        out.push(SS3[buf[2]] ? key(SS3[buf[2]]) : key('unknown')); buf = buf.slice(3); continue;
      }
      if (n === '\x1b') { out.push(key('escape')); buf = buf.slice(1); continue; }
      // ESC then one key: Alt-<key>.
      const code = n.charCodeAt(0);
      if (code < 32 || code === 0x7f) { out.push(control(n, true)); buf = buf.slice(2); continue; }
      const ch = String.fromCodePoint(buf.codePointAt(1));
      out.push(char(ch, true)); buf = buf.slice(1 + ch.length);
    }
    if (force && paste !== null) { out.push({ name: 'paste', text: paste + buf, id: 'paste' }); paste = null; buf = ''; }
    return out;
  }

  return {
    /** Decode a chunk (a string; the caller decodes UTF-8 with a StringDecoder so a split character waits too). */
    feed(s) {
      // A terminal without bracketed paste delivers a paste as one burst: several characters with a newline inside.
      // Typed text never has a line break before its last character, so such a chunk is a paste, not Enter.
      if (paste === null && !buf && s.length > 2 && !s.startsWith('\x1b') && /[\r\n][^\r\n]/.test(s) && !/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/.test(s)) {
        return [{ name: 'paste', text: s.replace(/\r\n?/g, '\n'), id: 'paste' }];
      }
      buf += s; return drain(false, false);
    },
    /** After a quiet moment: a lone ESC is Escape, a cut sequence is what it was so far. force also ends a paste. */
    flush({ force = false } = {}) { return drain(true, force); },
    /** Bytes are waiting for more (the caller arms the flush timer). */
    get pending() { return buf.length > 0 || paste !== null; },
    get inPaste() { return paste !== null; },
  };
}
