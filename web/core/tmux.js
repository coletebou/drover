// Local tmux adapter: list, capture, send (with the dialog guard ported from
// pw), new window/session. Targets are validated before use.
import { createHash } from 'node:crypto';
import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';
import { run, tryRun } from './proc.js';

// Field separator for -F output, printable on purpose: tmux 3.4 escapes control characters in format output, so
// the old U+001F separator arrived as the four characters "\037", no line split, and every window lost its fields
// (seen 2026-10-18); tmux 3.8 prints them raw. No proper prefix of "<|>" is also a suffix, so a split can only
// shift on a value that holds the whole sequence, and names, commands and paths don't.
export const SEP = '<|>';
const TARGET_RE = /^=?[A-Za-z0-9_.@%:$+-]{1,120}$/;
const NAME_RE = /^[A-Za-z0-9_.-]{1,60}$/;

export function assertTarget(t) {
  if (typeof t !== 'string' || !TARGET_RE.test(t)) throw new Error(`bad tmux target ${JSON.stringify(t)}`);
  return t;
}
export function assertName(n) {
  if (typeof n !== 'string' || !NAME_RE.test(n)) throw new Error(`bad tmux name ${JSON.stringify(n)}`);
  return n;
}

/**
 * One argument for the tmux command line, passed through literally. tmux reads its own argv as a command
 * sequence: an argument that ends in ";" ends the command and the next argument starts a new tmux command
 * (tmux 3.7c, 2026-10-15: `new-window prog 'x;' rename-session hijacked` renamed the session, and 'abc;'
 * reached prog as "abc"). A trailing "\;" is tmux's literal ";", so only a final ";" is escaped: semicolons
 * inside an argument, braces, #{formats}, ~ and $VARS pass through unchanged (the program gets the exact
 * string, checked in test/launch-effort.test.js against a real tmux server).
 */
export function tmuxArg(s) {
  return typeof s === 'string' && s.endsWith(';') ? `${s.slice(0, -1)}\\;` : s;
}

export async function serverUp() {
  const r = await tryRun('tmux', ['list-sessions']);
  return r.code === 0;
}

/** All windows across all sessions, with the active pane's pid/cmd/path. */
export async function listWindows() {
  if (!(await serverUp())) return [];
  const fmt = ['#{session_name}', '#{window_index}', '#{window_id}', '#{window_name}', '#{window_active}', '#{window_panes}', '#{pane_id}', '#{pane_pid}', '#{pane_current_command}', '#{pane_current_path}', '#{window_activity}', '#{session_attached}'].join(SEP);
  const { stdout } = await run('tmux', ['list-windows', '-a', '-F', fmt]);
  return stdout.split('\n').filter(Boolean).map((line) => {
    const [session, index, windowId, name, active, panes, paneId, panePid, cmd, cwd, activity, attached] = line.split(SEP);
    return {
      target: `${session}:${index}`, session, index: Number(index), windowId, name,
      active: active === '1', panes: Number(panes), paneId, panePid: Number(panePid), cmd, cwd,
      activityTs: Number(activity) * 1000 || null, sessionAttached: attached !== '0',
    };
  });
}

/** "session:@id" for a window target: the window's own id, which stays put when tmux renumbers its windows. */
export async function windowKey(target) {
  assertTarget(target);
  const { stdout } = await run('tmux', ['display-message', '-p', '-t', target, '#{session_name}:#{window_id}']);
  return stdout.trim();
}

/** Every pane's tty and its window ("session:@id"), for an agent that records the terminal it runs in (a Hermes REPL). */
export async function paneTtys() {
  if (!(await serverUp())) return [];
  const { stdout } = await run('tmux', ['list-panes', '-a', '-F', ['#{pane_tty}', '#{session_name}:#{window_id}', '#{pane_id}'].join(SEP)]);
  return stdout.split('\n').filter(Boolean).map((l) => { const [tty, window, paneId] = l.split(SEP); return { tty, window, paneId }; });
}

export async function listPanes(target) {
  assertTarget(target);
  const fmt = ['#{pane_id}', '#{pane_index}', '#{pane_pid}', '#{pane_current_command}', '#{pane_current_path}', '#{pane_active}', '#{pane_width}', '#{pane_height}'].join(SEP);
  const { stdout } = await run('tmux', ['list-panes', '-t', target, '-F', fmt]);
  return stdout.split('\n').filter(Boolean).map((l) => {
    const [paneId, index, pid, cmd, cwd, active, w, h] = l.split(SEP);
    return { paneId, index: Number(index), pid: Number(pid), cmd, cwd, active: active === '1', width: Number(w), height: Number(h) };
  });
}

export async function capture(target, { lines = 200, join = true } = {}) {
  assertTarget(target);
  const n = Math.max(1, Math.min(5000, Number(lines) || 200));
  const argv = ['capture-pane', '-p', '-t', target, '-S', `-${n}`];
  if (join) argv.splice(2, 0, '-J');
  const { stdout } = await run('tmux', argv);
  return stdout.trimEnd();
}

/**
 * Dialog/selector/permission-prompt detection (ported from pw status).
 * A dialog needs a structural marker (a numbered/arrowed option list or a y/n
 * prompt), not just the words "yes"/"no" in prose: an idle Claude recap that
 * says "yes, the tests pass" is not a dialog (false positives seen 2026-10-11).
 */
// Blanks after the marker are matched only when a marker is there: two blank runs around an optional one tried every
// way of splitting a blank run between them (1,000 blank lines took 0.6 s, 5,000 took 41 s). And the leading blanks stay
// on their line (no \n, \r, U+2028 or U+2029): each of those starts a line for /m, and a scan from each across the rest
// of a run of them was quadratic. An option after blank lines still matches from its own line.
const OPTION_LIST = /^[^\S\n\r\u2028\u2029]*(?:[❯>›]\s*)?\d\.\s+\S/m;             // "❯ 1. Yes" / "  2. No"
const DIALOG_PATTERNS = [
  /Do you want to (proceed|allow|run|make this edit|create|continue)/i,
  /Run a dynamic workflow\?/i,
  /Allow .{1,80} to (run|read|write|edit)/i,
  /\(y\/n\)/i, /\[Y\/n\]/, /\[y\/N\]/,
  /Enter to confirm/i,
  /Select an option/i,
  /Press Enter to continue/i,
  /Would you like to/i,
  // AskUserQuestion with several questions ends on a review screen: "Review your answers", then 1. Submit answers.
  /Ready to submit your answers\?/i,
  /Review your answers/i,
];
const CLAUDE_IDLE = /\? for shortcuts|bypass permissions on|accept edits on|plan mode on/i;

// What a working or waiting-for-input agent shows at the bottom: Claude's footer, its spinner, an empty prompt.
// Claude Code 2.1.3xx draws its input as a bare ❯ between two rules; older ones as a │ > │ box.
const LIVE_PROMPT = (l) => CLAUDE_IDLE.test(l) || /esc to interrupt/i.test(l) || /^[›>❯]\s*$/.test(l.trim()) || /^│\s*[>❯]\s/.test(l.trim());
// An option line as OPTION_LIST reads it, blanks after the marker only with a marker: a long blank line took 6.5 s.
const DIALOG_LINE = (l) => DIALOG_PATTERNS.some((re) => re.test(l)) || /^\s*(?:[❯>›]\s*)?\d\.\s+\S/.test(l) || /Esc to cancel|Enter to (select|confirm)/i.test(l);

export function classifyScreen(text) {
  const all = text.split('\n').slice(-40);
  // The screen is what is lowest: a prompt or spinner below the last dialog line means the dialog was answered and
  // is only scrollback above the live screen (an agent that clears and redraws leaves it there), so judge what is under it.
  let lastDialog = -1, lastLive = -1;
  all.forEach((l, i) => { if (DIALOG_LINE(l)) lastDialog = i; if (LIVE_PROMPT(l)) lastLive = i; });
  const tail = (lastDialog >= 0 && lastLive > lastDialog ? all.slice(lastDialog + 1) : all).join('\n');
  const yn = /\(y\/n\)|\[Y\/n\]|\[y\/N\]/i.test(tail);
  const question = DIALOG_PATTERNS.some((re) => re.test(tail));
  const options = OPTION_LIST.test(tail) && /❯|Esc to cancel|Enter to (select|confirm)/i.test(tail);
  if (yn || (question && options) || (options && /Esc to cancel/i.test(tail))) return { state: 'dialog', reason: 'a selector or permission prompt is on screen' };
  if (/esc to interrupt/i.test(tail)) return { state: 'busy', reason: 'agent is working (esc to interrupt visible)' };
  if (CLAUDE_IDLE.test(tail)) return { state: 'idle', reason: 'claude prompt footer visible' };
  // The empty input line: › or > (Codex, shells), or Claude Code 2.1.3xx's ❯ between rules with a status line under it.
  // Its leading blanks stay on their line, as OPTION_LIST's do: across a run of \r or U+2028 it was quadratic.
  if (/^[^\S\n\r\u2028\u2029]*[›>❯]\s*$/m.test(tail.split('\n').slice(-5).join('\n'))) return { state: 'idle', reason: 'empty prompt line' };
  return { state: 'unknown', reason: 'could not classify' };
}

/**
 * Claude Code's "Held message from another session" dialog (2.1.296): a peer
 * message the session will not deliver until a human approves it. Returns
 * { from } when the dialog is on screen, else null.
 */
export function heldMessage(text) {
  const all = String(text ?? '').split('\n').slice(-40);
  // As classifyScreen: a live prompt below the last held-message line means it was delivered or dropped already.
  let lastHeld = -1, lastLive = -1;
  all.forEach((l, i) => { if (/Held message from another session|Another Claude session sent a message/i.test(l)) lastHeld = i; if (LIVE_PROMPT(l)) lastLive = i; });
  if (lastHeld < 0 || lastLive > lastHeld) return null;
  const tail = all.join('\n');
  const m = tail.match(/sent a message: from ([^\n[(]{1,120})/i);
  return { from: m ? m[1].trim() : null };
}

/**
 * The question and options of an on-screen dialog, for an alert body and the
 * PiP board: the last line that reads like a question, then the numbered options.
 */
export function dialogSummary(text) {
  const lines = String(text ?? '').split('\n').map((l) => l.replace(/[│╭╮╰╯]/g, '').trimEnd()).filter((l) => l.trim());
  const tail = lines.slice(-30);
  let qi = -1;
  for (let i = tail.length - 1; i >= 0; i--) if (DIALOG_PATTERNS.some((re) => re.test(tail[i])) || /\?\s*$/.test(tail[i])) { qi = i; break; }
  const question = qi >= 0 ? tail[qi].trim().slice(0, 300) : null;
  const options = [];
  for (const l of tail.slice(qi + 1)) {
    const m = l.match(/^\s*(?:[❯>›]\s*)?(\d)\.\s+(.{1,120})$/);
    if (!m) continue;
    // A number that comes round again is the dialog drawn again (scrollback holds the earlier drawing): keep the latest.
    if (options.some((o) => o.n === Number(m[1]))) options.length = 0;
    options.push({ n: Number(m[1]), label: m[2].trim(), selected: /❯|›/.test(l.slice(0, l.indexOf(m[1]))) });
  }
  return { question, options };
}

/** A short fingerprint of the bottom of a screen, so an answer is only sent to the dialog the human saw. */
export function screenHash(text) {
  const lines = String(text ?? '').split('\n').map((l) => l.trimEnd()).filter((l) => l.trim()).slice(-20);
  return createHash('sha1').update(lines.join('\n')).digest('hex').slice(0, 16);
}

// Space ticks an option of a multi-select AskUserQuestion (Enter then submits).
const ANSWER_KEYS = new Set(['Enter', 'Escape', 'Up', 'Down', 'Tab', 'Space', 'y', 'n', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
const YN_PROMPT = /\(y\/n\)|\[Y\/n\]|\[y\/N\]/i;
const KEY_SHORTCUT = { y: /\(y\)/i, n: /\(n\)/i };   // "1. Yes, proceed (y)"

/**
 * y/n only reach prompts that take them: a "(y/n)"-style prompt, or a dialog
 * that shows the letter as a shortcut. Claude Code's own dialogs stopped taking
 * y/n in 2.1.280 (Enter, Escape or a digit only), so a y/n sent there is a
 * silent no-op; refuse it and name the keys that work.
 */
export function keyFitsDialog(text, key) {
  if (key !== 'y' && key !== 'n') return { ok: true };
  const tail = String(text ?? '').split('\n').slice(-40).join('\n');
  if (YN_PROMPT.test(tail) || KEY_SHORTCUT[key].test(tail)) return { ok: true };
  return { ok: false, reason: `this dialog does not take "${key}": Claude Code dialogs answer to Enter (highlighted option), Escape (deny) or a digit since 2.1.280` };
}

/**
 * Answer an on-screen dialog with one key, and only that dialog: refuses when no
 * dialog is showing, or when `expect` (a screenHash from the moment the human
 * read it) no longer matches. This is the safe path for notification actions
 * like Approve (Enter) and Deny (Esc).
 */
export async function answer(target, key, { expect } = {}) {
  assertTarget(target);
  if (!ANSWER_KEYS.has(key)) throw new Error(`key must be one of ${[...ANSWER_KEYS].join(', ')}`);
  const text = await capture(target, { lines: 60 });
  const cls = classifyScreen(text);
  const held = heldMessage(text);
  const hash = screenHash(text);
  if (cls.state !== 'dialog' && !held) return { ok: false, refused: true, reason: 'no dialog is on screen any more', screen: cls, hash };
  // The dialog now on screen goes with the refusal, so a client can show it at once instead of reading the pane again.
  if (expect && expect !== hash) return { ok: false, refused: true, reason: 'the screen changed since you read it; read it again', screen: cls, hash, dialog: dialogSummary(text), preview: text.split('\n').slice(-15).join('\n') };
  const fit = keyFitsDialog(text, key);
  if (!fit.ok) return { ok: false, refused: true, reason: fit.reason, screen: cls, hash, dialog: dialogSummary(text) };
  await run('tmux', ['send-keys', '-t', target, key]);
  return { ok: true, key, screen: cls, hash, dialog: dialogSummary(text) };
}

/**
 * Paste text into a pane via a tmux buffer (no key-by-key typing, no shell).
 * -p wraps it in bracketed-paste markers when the app asked for them (Claude
 * Code, Codex, zsh), so a multi-line prompt arrives as one paste instead of
 * keystrokes whose newlines can submit early.
 * Refuses when a dialog is on screen unless force=true.
 */
export async function send(target, text, { enter = true, force = false, bufferName = 'drover' } = {}) {
  assertTarget(target);
  if (typeof text !== 'string') throw new Error('text must be a string');
  const before = await capture(target, { lines: 60 });
  const cls = classifyScreen(before);
  if (cls.state === 'dialog' && !force) {
    return { ok: false, refused: true, screen: cls, preview: before.split('\n').slice(-15).join('\n') };
  }
  if (text.length > 0) {
    await run('tmux', ['load-buffer', '-b', bufferName, '-'], { input: text });
    await run('tmux', ['paste-buffer', '-p', '-d', '-b', bufferName, '-t', target]);
  }
  if (enter) {
    // Small delay lets TUIs settle the paste before Enter (paste-collapse guard from pw).
    await new Promise((r) => setTimeout(r, text.length > 2000 ? 400 : 150));
    await run('tmux', ['send-keys', '-t', target, 'Enter']);
  }
  return { ok: true, screen: cls };
}

export async function sendKeys(target, keys) {
  assertTarget(target);
  if (!Array.isArray(keys) || keys.some((k) => typeof k !== 'string' || k.length > 20)) throw new Error('keys must be short strings');
  // Escaped like every other argument, or keys ['a;', 'kill-server'] would run kill-server.
  await run('tmux', ['send-keys', '-t', target, ...keys.map(tmuxArg)]);
  return { ok: true };
}

/**
 * New window in an existing session (created if missing). argv runs in the
 * window (omit for a shell). env is passed with tmux's -e flags, so secrets
 * never appear in #{pane_start_command} the way an `env K=V` prefix would.
 * env.PATH also goes on the tmux client itself: tmux gives a new pane the PATH
 * of the client that runs new-window, over the server's and over -e PATH
 * (tmux 3.7c), so without it the window would get the daemon's PATH. That
 * client is still the tmux on this process's PATH: spawn looks a bare name up
 * in the child's PATH, which need not hold tmux at all.
 * Every argument goes through tmuxArg(), so the window runs exactly argv:
 * a prompt or model ending in ";" can neither lose it nor start a tmux command.
 * The target returned is "session:@id", the window's id: tmux renumbers windows under renumber-windows on (dropping
 * the placeholder of a new session does, and so does any window closing later), so a "session:index" can come to
 * name another window or none, while an id stays this window's until it closes.
 */
export async function newWindow({ session, name, cwd, argv, env }) {
  assertName(session);
  if (name) assertName(name);
  const envFlags = Object.entries(env ?? {}).flatMap(([k, v]) => { if (!/^[A-Z_][A-Z0-9_]*$/i.test(k)) throw new Error(`bad env name ${k}`); return ['-e', tmuxArg(`${k}=${v}`)]; });
  const dirFlags = cwd ? ['-c', tmuxArg(cwd)] : [];
  const [bin, clientOpts] = env?.PATH ? [ownTmux(), { env: { ...process.env, PATH: env.PATH } }] : ['tmux', {}];
  const created = !(await hasSession(session));
  // When this starts the tmux server, the server's global environment comes from this client too. It prints the id of
  // the session's placeholder window, which is dropped below.
  const placeholder = created ? (await run(bin, ['new-session', '-d', '-s', session, '-P', '-F', '#{window_id}', ...dirFlags], clientOpts)).stdout.trim() : null;
  // "=session:" is this session exactly and no window in it, so the window takes the next free index. A bare name is
  // a window first: tmux prefix-matches it against the window names of the current session, so session "work" hit its
  // window "work-notes" and the launch failed with "index 1 in use"; and without "=" another session can match it.
  const args = ['new-window', '-P', '-F', '#{session_name}:#{window_id}', '-t', `=${session}:`, ...envFlags, ...(name ? ['-n', name] : []), ...dirFlags, ...(argv?.length ? argv.map(tmuxArg) : [])];
  const { stdout } = await run(bin, args, clientOpts);
  const target = stdout.trim();
  // A fresh session comes with a placeholder shell window; drop it so the new window is the only one.
  if (placeholder) await run('tmux', ['kill-window', '-t', placeholder]).catch(() => {});
  return { target };
}

/** The tmux executable on this process's PATH, as an absolute path; bare 'tmux' when none is found. */
function ownTmux() {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const f = path.join(dir, 'tmux');
    try { if (statSync(f).isFile()) { accessSync(f, constants.X_OK); return f; } } catch { /* not here */ }
  }
  return 'tmux';
}

async function resolveLastWindow(session) {
  const { stdout } = await run('tmux', ['list-windows', '-t', session, '-F', '#{session_name}:#{window_index}']);
  return stdout.trim().split('\n').filter(Boolean).at(-1);
}

export async function hasSession(session) {
  const r = await tryRun('tmux', ['has-session', '-t', `=${session}`]);
  return r.code === 0;
}

export async function listSessions() {
  if (!(await serverUp())) return [];
  const { stdout } = await run('tmux', ['list-sessions', '-F', ['#{session_name}', '#{session_windows}', '#{session_attached}', '#{session_created}'].join(SEP)]);
  return stdout.split('\n').filter(Boolean).map((l) => { const [name, windows, attached, created] = l.split(SEP); return { name, windows: Number(windows), attached: attached !== '0', createdTs: Number(created) * 1000 }; });
}

export async function renameWindow(target, name) {
  assertTarget(target); assertName(name);
  await run('tmux', ['rename-window', '-t', target, name]);
  return { ok: true };
}

export async function killWindow(target) {
  assertTarget(target);
  await run('tmux', ['kill-window', '-t', target]);
  return { ok: true };
}

/** Process subtree pids under a pane pid (BFS with pgrep -P), used for agent matching. */
export async function subtreePids(rootPid, { maxDepth = 6 } = {}) {
  const seen = new Set([rootPid]);
  let frontier = [rootPid];
  for (let d = 0; d < maxDepth && frontier.length; d++) {
    const next = [];
    for (const p of frontier) {
      const r = await tryRun('pgrep', ['-P', String(p)]);
      for (const c of r.stdout.split('\n').map((x) => Number(x)).filter(Boolean)) {
        if (!seen.has(c)) { seen.add(c); next.push(c); }
      }
    }
    frontier = next;
  }
  return [...seen];
}
