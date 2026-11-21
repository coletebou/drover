// The terminal: raw mode, the alternate screen, bracketed paste, no autowrap (a misjudged width then clips instead
// of scrolling the screen), the mouse (SGR reports, mode 1006: clicks and the wheel with 1000, and with 1003 every
// motion, so what is under the pointer can be highlighted), resize, Ctrl-Z suspend, and a restore that runs on every
// way out (quit, signal, crash), so a dead TUI never leaves a shell in raw mode on the alternate screen, or reporting
// the mouse.
import { StringDecoder } from 'node:string_decoder';
import { createDecoder } from './keys.js';

const ENTER = '\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[?2004h\x1b[H\x1b[2J';
const LEAVE = '\x1b[?2004l\x1b[?7h\x1b[0m\x1b[?25h\x1b[?1049l';
export const MOUSE_ON = '\x1b[?1000h\x1b[?1003h\x1b[?1006h';
export const MOUSE_OFF = '\x1b[?1006l\x1b[?1003l\x1b[?1000l';

/**
 * The OSC 52 sequence that puts text on the terminal's clipboard. Inside tmux it is wrapped in tmux's DCS passthrough
 * (the inner ESCs doubled), which tmux forwards when allow-passthrough is on; tmux with set-clipboard also takes the
 * bare form, so both are sent there. max caps the base64 (terminals drop longer ones): { seq, truncated }.
 */
export function osc52(text, { tmux = false, max = 100_000 } = {}) {
  let b64 = Buffer.from(String(text ?? ''), 'utf8').toString('base64');
  const truncated = b64.length > max;
  if (truncated) { const limit = Math.floor(max / 4) * 3; let cut = '', n = 0; for (const ch of String(text)) { const b = Buffer.byteLength(ch); if (n + b > limit) break; cut += ch; n += b; } b64 = Buffer.from(cut, 'utf8').toString('base64'); }
  const bare = `\x1b]52;c;${b64}\x07`;
  return { seq: tmux ? `\x1bPtmux;${bare.replace(/\x1b/g, '\x1b\x1b')}\x1b\\${bare}` : bare, truncated };
}

/** Whether the TUI asks for the mouse: on unless DROVER_TUI_MOUSE is 0, off, no or false (or --no-mouse). */
export function mouseWanted(env = process.env) { return !/^(0|off|no|false)$/i.test(String(env.DROVER_TUI_MOUSE ?? '')); }

export class Terminal {
  constructor({ input = process.stdin, output = process.stdout, escTimeoutMs = 40, mouse = true } = {}) {
    this.input = input; this.output = output; this.escTimeoutMs = escTimeoutMs; this.mouse = mouse;
    this.decoder = createDecoder(); this.utf8 = new StringDecoder('utf8');
    this.onKey = () => {}; this.onResize = () => {}; this.onResume = () => {};
    this.active = false; this.timer = null; this.pasteTimer = null;
    this.data = (buf) => this.#data(buf);
    this.resize = () => this.onResize(this.size());
  }
  size() { return { cols: this.output.columns || 80, rows: this.output.rows || 24 }; }
  write(s) { if (this.active) this.output.write(s); }
  /** Turn mouse reporting on or off while running (kept across a suspend). */
  setMouse(on) { this.mouse = Boolean(on); if (this.active) this.output.write(this.mouse ? MOUSE_ON : MOUSE_OFF); }

  #emit(events) { for (const e of events) { try { this.onKey(e); } catch (err) { this.onError?.(err); } } }
  #data(buf) {
    clearTimeout(this.timer); clearTimeout(this.pasteTimer);
    this.#emit(this.decoder.feed(this.utf8.write(buf)));
    // A lone ESC (or a sequence cut by the network) is final once nothing follows it for a moment.
    if (this.decoder.pending && !this.decoder.inPaste) this.timer = setTimeout(() => this.#emit(this.decoder.flush()), this.escTimeoutMs);
    // A paste whose end marker never comes would swallow every later key: end it after a second of silence.
    if (this.decoder.inPaste) this.pasteTimer = setTimeout(() => this.#emit(this.decoder.flush({ force: true })), 1000);
  }

  start() {
    if (this.active) return;
    if (!this.input.isTTY || !this.output.isTTY) throw new Error('drover tui needs a terminal (stdin and stdout must be a TTY)');
    this.input.setRawMode(true);
    this.input.on('data', this.data); this.input.resume();
    this.output.on('resize', this.resize);
    this.active = true;
    this.output.write(ENTER + (this.mouse ? MOUSE_ON : ''));
  }
  stop() {
    if (!this.active) return;
    this.active = false;
    clearTimeout(this.timer); clearTimeout(this.pasteTimer);
    this.output.write(MOUSE_OFF + LEAVE);
    this.input.off('data', this.data); this.output.off('resize', this.resize);
    try { this.input.setRawMode(false); } catch { /* the terminal is gone */ }
    this.input.pause();
  }
  /** Ctrl-Z: give the terminal back, stop, and take it again on SIGCONT. */
  suspend() {
    this.stop();
    process.once('SIGCONT', () => { this.start(); this.onResume(); });
    process.kill(process.pid, 'SIGTSTP');
  }
}

/**
 * Restore the terminal on every exit path. A crash restores and exits with the error printed; a stray rejected
 * promise is reported through onRejection and the TUI keeps running. Returns a function that removes the handlers.
 */
export function guard(term, { onFatal, onRejection } = {}) {
  const restore = () => { try { term.stop(); } catch { /* nothing more to do */ } };
  const fatal = (err) => { restore(); onFatal?.(err); process.exit(1); };
  const sig = (s) => () => { restore(); process.exit(s === 'SIGINT' ? 130 : 143); };
  const handlers = [['exit', restore], ['uncaughtException', fatal], ['unhandledRejection', (e) => (onRejection ? onRejection(e) : fatal(e))], ['SIGTERM', sig('SIGTERM')], ['SIGHUP', sig('SIGHUP')], ['SIGINT', sig('SIGINT')]];
  for (const [ev, fn] of handlers) process.on(ev, fn);
  return () => { for (const [ev, fn] of handlers) process.off(ev, fn); };
}
