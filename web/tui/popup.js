// drover manager popup | keys: the manager TUI floating over the current tmux window.
//
// popup  Default: a persistent tmux session `drover-manager` runs `drover tui --manager`, and a display-popup on
//        the client attaches to it (`env -u TMUX tmux new-session -A -s drover-manager ...`), so the same manager,
//        its scrollback and its draft, shows over every window. --independent gives this window its own
//        conversation (thread win-<window id>, session drover-manager-win-<n>-<hash>); --thread T a named one; --fresh
//        runs the TUI straight in the popup (nothing persists). Run from inside a manager session (the binding
//        pressed in the popup) it detaches instead: the same key opens and hides it. The window it came from is
//        recorded on the session (@drover-from) on every open, so /look captures that window.
// keys   The tmux.conf snippet: prefix + g toggles the shared manager, prefix + G opens this window's own (M and N
//        are often taken already: prefix + M is a common mouse toggle).
//        --install writes it to ~/.config/drover/manager.tmux.conf and source-files it into the running server.
//        It never edits ~/.tmux.conf (dotfiles own it); it says how to make the binding permanent there.
//
// tmux 3.7c expands no formats in display-popup's command or -e values, so everything is resolved here and
// passed literally; run-shell (the binding) does expand them, which is how the binding passes #{client_name}.
// display-popup blocks until the popup closes, so it is started detached and only an early failure is reported:
// an agent's Bash tool must not hang until the owner closes the window. Pure planning (popupPlan, keysSnippet, ...)
// is tested in test/tui-popup.test.js; the runners below gather the facts and run the plan.
import { spawn, execFile } from 'node:child_process';
import { mkdirSync, writeFileSync, renameSync, lstatSync, readlinkSync, rmSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SHARED = 'drover-manager';
const THREAD = /^[A-Za-z0-9_.:@%-]{1,64}$/;
const SIZE = /^\d{1,3}%?$/;
const KEY = /^[A-Za-z0-9]$|^[CM]-[A-Za-z0-9]$/;
const PASS_ENV = ['DROVER_STATE', 'APXW_STATE', 'DROVER_CACHE', 'NO_COLOR', 'DROVER_TUI_COLOR'];

/**
 * The tmux session of a manager thread: main is the shared one, each other thread gets its own. A thread tmux takes
 * as it is keeps its name; one that had to change (no @ or % in a target, no : or . in a name) also carries a hash
 * of the exact thread, so two threads never land on one session (ops.a and ops_a would otherwise).
 */
export function sessionFor(thread = 'main') {
  if (thread === 'main') return SHARED;
  const base = thread.replace(/[@%]/g, '').replace(/[^A-Za-z0-9_-]/g, '_');
  return base === thread ? `${SHARED}-${base}` : `${SHARED}-${base}-${createHash('sha1').update(thread).digest('hex').slice(0, 6)}`;
}
export const isManagerSession = (name) => name === SHARED || String(name ?? '').startsWith(`${SHARED}-`);

/** The server's socket from $TMUX ("socket,pid,session"), so every tmux call goes to the server we were run in. */
export function socketOf(env = process.env) {
  const t = env.TMUX; if (!t) return null;
  const parts = t.split(','); return parts.length >= 3 ? parts.slice(0, -2).join(',') : parts[0];
}

export function parsePopupArgs(argv) {
  const o = { width: '85%', height: '80%' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v; };
    if (a === '--independent') o.independent = true;
    else if (a === '--thread') o.thread = val();
    else if (a === '--fresh') o.fresh = true;
    else if (a === '--width') o.width = val();
    else if (a === '--height') o.height = val();
    else if (a === '--client') o.client = val();
    else if (a === '--from') o.from = val();
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--quiet') o.quiet = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (o.independent && o.thread) throw new Error('--independent and --thread are two ways to pick a thread; give one');
  if (o.thread && !THREAD.test(o.thread)) throw new Error('a thread is 1 to 64 of A-Z a-z 0-9 _ . : @ % -');
  for (const k of ['width', 'height']) if (!SIZE.test(o[k])) throw new Error(`--${k} is a number of cells or a percentage, like 85%`);
  if (o.from && !/^[A-Za-z0-9_.@%:$+=-]{1,120}$/.test(o.from)) throw new Error(`not a tmux target: ${o.from}`);
  if (o.client && !/^[^\s'"`$;|&<>]{1,200}$/.test(o.client)) throw new Error(`not a tmux client name: ${o.client}`);
  return o;
}

/** The size of a new manager session: what the popup's inside will be, so the TUI starts at its size. */
function innerSize(spec, total) { const n = spec.endsWith('%') ? Math.floor((total * Number(spec.slice(0, -1))) / 100) : Number(spec); return Math.max(20, Math.min(total, n) - 2); }

/**
 * What popup does, from the facts gathered about tmux: { action: 'detach', argv } to hide a manager whose binding
 * was pressed inside it, or { action: 'popup', thread, session, before: [tmux argv...], popup: argv } to show one.
 * facts: { client, clientSession, origin: { paneId, windowId, label }, sessionExists, clientSize: { w, h },
 * command: [node, drover], socket, env }.
 */
export function popupPlan(o, f) {
  if (isManagerSession(f.clientSession)) {
    return { action: 'detach', argv: f.client ? ['detach-client', '-t', f.client] : ['detach-client', '-s', `=${f.clientSession}`] };
  }
  if (!f.origin?.paneId) throw new Error('no window to float the manager over: run this in a tmux pane, or pass --client');
  const thread = o.independent ? `win-${f.origin.windowId}` : o.thread ?? 'main';
  if (!THREAD.test(thread)) throw new Error(`cannot make a thread name from window ${f.origin.windowId}`);
  const mode = o.independent ? 'independent' : thread === 'main' ? 'shared' : 'thread';
  const tui = [...f.command, 'tui', '--manager', ...(thread !== 'main' ? ['--thread', thread] : []), '--from', f.origin.paneId];
  const sock = f.socket ? ['-S', f.socket] : [];
  const title = ` drover manager · ${thread === 'main' ? 'shared' : thread} `.replace(/#/g, '##');
  const where = f.client ? ['-c', f.client] : [];
  const box = ['-E', '-w', o.width, '-h', o.height, '-T', title];
  if (o.fresh) return { action: 'popup', thread, session: null, mode: 'fresh', before: [], popup: ['display-popup', ...where, ...box, ...tui] };
  const session = sessionFor(thread);
  // A session is reused only for its own thread (@drover-thread, set when it starts). One without the mark comes
  // from an older drover: the shared one ran main, another one cannot be trusted to.
  if (f.sessionExists) {
    const holds = f.sessionThread || (thread === 'main' ? 'main' : null);
    if (holds !== thread) throw new Error(`tmux session ${session} holds ${holds ? `thread ${holds}` : 'a manager from an older drover'}, not ${thread}; end it (tmux kill-session -t =${session}) and open it again`);
  }
  const env = [['DROVER_TUI_POPUP', mode], ['DROVER_TUI_SESSION', session], ...PASS_ENV.filter((k) => f.env?.[k] !== undefined && f.env[k] !== '').map((k) => [k, f.env[k]])];
  const envArgs = env.flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  const before = [];
  // Created here, detached and at the popup's size, so its options are set before anything attaches.
  if (!f.sessionExists) {
    before.push(['new-session', '-d', '-s', session, '-x', String(innerSize(o.width, f.clientSize?.w ?? 160)), '-y', String(innerSize(o.height, f.clientSize?.h ?? 45)), ...envArgs, ...tui]);
    before.push(['set-option', '-t', `=${session}:`, '@drover-thread', thread]);
  }
  before.push(['set-option', '-t', `=${session}:`, 'status', 'off']);
  before.push(['set-option', '-t', `=${session}:`, '@drover-from', f.origin.paneId]);
  // Inside the popup: a nested client of the same server (TMUX unset allows it), attaching, or creating the
  // session if it went away in between.
  const inner = ['env', '-u', 'TMUX', 'tmux', ...sock, 'new-session', '-A', '-s', session, ...envArgs, ...tui];
  return { action: 'popup', thread, session, mode, before, popup: ['display-popup', ...where, ...box, ...inner] };
}

/** The command that starts drover here: this node and this bin/drover, so a session never depends on PATH. */
export function droverCommand(argv1 = process.argv[1]) {
  const bin = argv1 ? path.resolve(argv1) : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'drover');
  return [process.execPath, bin];
}

/** One word for /bin/sh inside a double-quoted run-shell string in tmux.conf ('...' outside, "..." inside). */
function shWord(s) {
  if (/['\n]/.test(s)) throw new Error(`cannot put ${JSON.stringify(s)} in a tmux binding (it holds a quote or a newline); link drover from a plain path`);
  return `"${s.replace(/([\\"$`])/g, '\\$1').replace(/#/g, '##')}"`;
}

/** The tmux.conf snippet for the popup bindings. */
export function keysSnippet({ command = droverCommand(), key = 'g', independentKey = 'G' } = {}) {
  if (!KEY.test(key) || !KEY.test(independentKey)) throw new Error('a key is one letter or digit, or C-x / M-x');
  if (key === independentKey) throw new Error('the two bindings need two different keys');
  // --quiet: run-shell shows a command's stdout in view mode over the pane, so success says nothing and a failure
  // goes to the status line.
  const run = (extra) => `run-shell -b '${[...command.map(shWord), 'manager', 'popup', ...extra, '--quiet', '--client', '"#{client_name}"', '--from', '"#{pane_id}"'].join(' ')}'`;
  return [
    '# Drover manager popup (written by `drover manager keys`; do not edit, run it again instead).',
    `# prefix + ${key}: the shared manager over this window; the same key inside it hides it again.`,
    `# prefix + ${independentKey}: this window's own manager conversation (thread win-<window id>).`,
    `bind-key ${key} ${run([])}`,
    `bind-key ${independentKey} ${run(['--independent'])}`,
    '',
  ].join('\n');
}

export function parseKeysArgs(argv) {
  const o = { key: 'g', independentKey: 'G' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; const val = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v; };
    if (a === '--install') o.install = true;
    else if (a === '--key') o.key = val();
    else if (a === '--independent-key') o.independentKey = val();
    else if (a === '--force') o.force = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

// tmux's own default bindings for the keys a popup binding may take: replacing these loses nothing the owner chose.
export const STOCK = { M: 'select-pane -M', m: 'select-pane -m' };

/** Keys already bound in the prefix table to something that is neither this popup nor a tmux default. */
export function conflicts(listKeysOut, keys) {
  const out = [];
  for (const line of String(listKeysOut ?? '').split('\n')) {
    const m = line.match(/^bind-key\s+(?:-r\s+)?-T\s+prefix\s+(\S+)\s+(.*)$/);
    if (!m || !keys.includes(m[1]) || /manager popup/.test(m[2])) continue;
    const binding = m[2].trim();
    if (STOCK[m[1]] === binding) continue;
    out.push({ key: m[1], binding });
  }
  return out;
}

/** Uppercase keys nobody bound (nor tmux, nor TPM's I and U), to suggest when the asked ones are taken. */
export function freeKeys(listKeysOut, n = 3) {
  const used = new Set([...String(listKeysOut ?? '').matchAll(/^bind-key\s+(?:-r\s+)?-T\s+prefix\s+(\S+)/gm)].map((m) => m[1]));
  return [...'NOGJKYVHXZ'].filter((k) => !used.has(k)).slice(0, n);
}

/**
 * Why the snippet must not be written at file, or null: a symlink there (into the dotfiles, or at ~/.tmux.conf)
 * would be written through, so it is refused; so is anything that is not a regular file.
 */
export function configTargetProblem(file) {
  let st; try { st = lstatSync(file); } catch { return null; }
  if (st.isSymbolicLink()) { let to = '?'; try { to = readlinkSync(file); } catch { /* raced */ } return `${file} is a symbolic link (to ${to}); nothing is written through it. Remove the link, or set XDG_CONFIG_HOME to put the snippet elsewhere`; }
  if (!st.isFile()) return `${file} is not a regular file`;
  return null;
}

/** Write a file atomically next to itself: a temp file (O_EXCL), then a rename over the entry, never through it. */
export function writeAtomic(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try { writeFileSync(tmp, text, { flag: 'wx', mode: 0o644 }); renameSync(tmp, file); }
  catch (e) { rmSync(tmp, { force: true }); throw e; }
}

export const configFile = (env = process.env) => path.join(env.XDG_CONFIG_HOME || path.join(env.HOME ?? '', '.config'), 'drover', 'manager.tmux.conf');

// ------------------------------------------------------------ runners
function tmuxRun(args, env) {
  const sock = socketOf(env);
  return new Promise((resolve) => execFile('tmux', [...(sock ? ['-S', sock] : []), ...args], { env, timeout: 8000 }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout), err: String(stderr || err?.message || '') })));
}
const fmt = (...names) => names.map((n) => `#{${n}}`).join('\t');

async function gatherFacts(o, env) {
  const f = { client: o.client ?? null, socket: socketOf(env), command: droverCommand(), env };
  const where = f.client ? ['-c', f.client] : [];
  let pane = o.from ?? null;
  if (!pane && f.client) { const r = await tmuxRun(['display-message', '-p', ...where, '#{pane_id}'], env); if (r.code === 0) pane = r.out.trim(); }
  if (!pane) pane = env.TMUX_PANE ?? null;
  if (!pane) throw new Error('not inside tmux: run drover manager popup from a tmux pane (or a binding: drover manager keys)');
  const d = await tmuxRun(['display-message', '-p', '-t', pane, fmt('session_name', 'window_id', 'window_index', 'window_name', 'pane_id')], env);
  if (d.code !== 0) throw new Error(`tmux has no pane ${pane}: ${d.err.trim()}`);
  const [session, windowId, index, name, paneId] = d.out.replace(/\n$/, '').split('\t');
  f.origin = { session, windowId, paneId, label: `${session}:${index} ${name}` };
  f.clientSession = session;
  if (f.client) { const c = await tmuxRun(['display-message', '-p', '-c', f.client, '#{session_name}'], env); if (c.code === 0 && c.out.trim()) f.clientSession = c.out.trim(); }
  const sz = await tmuxRun(['display-message', '-p', ...where, '-t', pane, fmt('client_width', 'client_height')], env);
  const [w, h] = sz.out.trim().split('\t').map(Number);
  f.clientSize = { w: w || 160, h: h || 45 };
  return f;
}

export async function popupCli(argv, { env = process.env, log = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s) } = {}) {
  let o; try { o = parsePopupArgs(argv); } catch (e) { err(`drover manager popup: ${e.message}\n`); return 2; }
  const say = o.quiet ? () => {} : log;
  // From a binding nobody sees stderr: a failure also goes to the client's status line.
  const fail = async (msg, code = 1) => { err(`drover manager popup: ${msg}\n`); if (o.quiet && o.client) await tmuxRun(['display-message', '-c', o.client, `drover manager popup: ${msg}`.replace(/#/g, '##')], env); return code; };
  let f; try { f = await gatherFacts(o, env); } catch (e) { return fail(e.message); }
  if (!isManagerSession(f.clientSession) && !o.fresh) {
    const thread = o.independent ? `win-${f.origin.windowId}` : o.thread ?? 'main';
    f.sessionExists = (await tmuxRun(['has-session', '-t', `=${sessionFor(thread)}`], env)).code === 0;
    if (f.sessionExists) f.sessionThread = (await tmuxRun(['show-options', '-t', `=${sessionFor(thread)}:`, '-qv', '@drover-thread'], env)).out.trim() || null;
  }
  let plan; try { plan = popupPlan(o, f); } catch (e) { return fail(e.message); }
  if (o.dryRun) { log(`${JSON.stringify(plan, null, 2)}\n`); return 0; }
  if (plan.action === 'detach') {
    const r = await tmuxRun(plan.argv, env);
    if (r.code !== 0) return fail(`could not hide the manager: ${r.err.trim()}`);
    say('hid the manager (it keeps running; the same key brings it back)\n'); return 0;
  }
  for (const step of plan.before) {
    const r = await tmuxRun(step, env);
    if (r.code !== 0) return fail(`tmux ${step[0]} failed: ${r.err.trim()}`);
  }
  const code = await openPopup(plan.popup, env);
  if (code !== null && code !== 0) return fail(`tmux display-popup exited with ${code}`);
  say(`${plan.mode === 'fresh' ? 'a fresh manager' : `the ${plan.mode} manager (${plan.session})`} is open over ${f.origin.label}${plan.thread !== 'main' ? `, thread ${plan.thread}` : ''}\n`);
  return 0;
}

/** Start display-popup without waiting for it to close: null while it is up after a moment, else its exit code. */
function openPopup(args, env) {
  const sock = socketOf(env);
  return new Promise((resolve) => {
    const child = spawn('tmux', [...(sock ? ['-S', sock] : []), ...args], { env, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c; });
    const t = setTimeout(() => { child.stderr.destroy(); child.unref(); resolve(null); }, 400);
    child.on('error', (e) => { clearTimeout(t); process.stderr.write(`tmux: ${e.message}\n`); resolve(127); });
    child.on('exit', (code) => { clearTimeout(t); if (code && stderr.trim()) process.stderr.write(`tmux: ${stderr.trim()}\n`); resolve(code ?? 0); });
  });
}

export async function keysCli(argv, { env = process.env, log = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s) } = {}) {
  let o, snippet;
  try { o = parseKeysArgs(argv); snippet = keysSnippet({ key: o.key, independentKey: o.independentKey }); } catch (e) { err(`drover manager keys: ${e.message}\n`); return 2; }
  if (!o.install) {
    log(snippet);
    log(`\n# Load it now: drover manager keys --install (writes ${configFile(env)} and source-files it).\n# Keep it: add "source-file -q ${configFile(env)}" to your tmux.conf (~/.tmux.conf, or the copy your dotfiles keep).\n`);
    return 0;
  }
  const file = configFile(env);
  const problem = configTargetProblem(file);
  if (problem) { err(`drover manager keys: ${problem}. Nothing changed.\n`); return 1; }
  const lk = await tmuxRun(['list-keys', '-T', 'prefix'], env);
  if (lk.code !== 0) { err(`drover manager keys: tmux is not answering here: ${lk.err.trim()}\n`); return 1; }
  const clash = conflicts(lk.out, [o.key, o.independentKey]);
  if (clash.length && !o.force) {
    const free = freeKeys(lk.out).filter((k) => k !== o.key && k !== o.independentKey);
    err(`drover manager keys: ${clash.map((c) => `prefix + ${c.key} is already bound to: ${c.binding}`).join('\n  ')}\nNothing changed. Pick other keys (free here: ${free.join(', ') || 'none of the usual ones'}; --key ${free[0] ?? 'K'} --independent-key ${free[1] ?? 'K2'}), or replace those bindings in this server with --force.\n`);
    return 1;
  }
  try { writeAtomic(file, snippet); } catch (e) { err(`drover manager keys: could not write ${file}: ${e.message}\n`); return 1; }
  const src = await tmuxRun(['source-file', file], env);
  if (src.code !== 0) { err(`drover manager keys: wrote ${file}, but tmux could not load it: ${src.err.trim()}\n`); return 1; }
  log(`wrote ${file} and loaded it: prefix + ${o.key} toggles the shared manager, prefix + ${o.independentKey} opens this window's own.${clash.length ? ` (replaced ${clash.map((c) => `prefix + ${c.key}`).join(', ')} in this server only)` : ''}\n`);
  log(`To keep it after tmux restarts, add this line to your tmux.conf (~/.tmux.conf, or the copy your dotfiles keep):\n  source-file -q ${file}\nThis command never edits ~/.tmux.conf.\n`);
  return 0;
}

/** bin/drover dispatches `drover manager popup|keys` here. */
export async function managerCli(sub, argv) {
  return sub === 'keys' ? keysCli(argv) : popupCli(argv);
}
