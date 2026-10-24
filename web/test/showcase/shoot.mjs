// The README's pictures of the web UI, the TUI and the CLI, taken in the showcase world (test/devworld.js --showcase,
// already running) by a headless Chrome over the DevTools protocol (Node's own WebSocket, no dependencies). The TUI
// and the CLI run in a tmux server of their own, attached read-only through ttyd and drawn by its xterm.js, so a
// picture is a real terminal's. The extensions have their own harness: native/Extensions/chrome/tools/headless.mjs.
//   node test/showcase/shoot.mjs [--port 7339] [--dir <the world's folder>] [--out ../docs/screenshots] [--only web,tui,cli]
//     [--chrome <path>]
// It types into the world's manager and agents (never a real one: the world's daemon refuses to start unless it is
// isolated, and this refuses the live daemon's port).
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync, realpathSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPLIES } from './world.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const PORT = Number(arg('port', 7339));
if (PORT === 7337) { console.error('refusing the live daemon\'s port: this types into sessions'); process.exit(2); }
const DIR = arg('dir', path.join(realpathSync(tmpdir()), `drover-devworld-${PORT}`));
const OUT = path.resolve(arg('out', path.join(HERE, '..', '..', '..', 'docs', 'screenshots')));
const ONLY = new Set(arg('only', 'web,tui,cli').split(','));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('shoot:', ...a);

const world = JSON.parse(readFileSync(path.join(DIR, 'devworld.json'), 'utf8'));
if (!world.showcase || world.port !== PORT) { console.error(`${DIR} is not a showcase world on port ${PORT}: start node test/devworld.js --showcase --port ${PORT}`); process.exit(2); }
const TOKEN = readFileSync(path.join(DIR, 'state', 'token'), 'utf8').trim();
const BASE = `http://127.0.0.1:${PORT}/`;
mkdirSync(OUT, { recursive: true });

// ------------------------------------------------------------ Chrome over the DevTools protocol
/** Chrome for Testing from the Playwright cache when there is one, else Google Chrome. */
function findChrome() {
  const cache = path.join(homedir(), 'Library', 'Caches', 'ms-playwright');
  try {
    for (const d of readdirSync(cache).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()) {
      const p = path.join(cache, d, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
      if (existsSync(p)) return p;
    }
  } catch { /* no cache */ }
  return process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome';
}
const freePort = () => new Promise((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

const profile = mkdtempSync(path.join(tmpdir(), 'drover-shoot-'));
const cdpPort = await freePort();
const chrome = spawn(arg('chrome', findChrome()), ['--headless=new', `--user-data-dir=${profile}`, `--remote-debugging-port=${cdpPort}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--force-color-profile=srgb'], { stdio: 'ignore' });
const cleanups = [() => { try { chrome.kill('SIGKILL'); } catch { /* gone */ } }, () => rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })];
const cleanup = () => { for (const f of cleanups.splice(0).reverse()) { try { f(); } catch { /* best effort */ } } };
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

let ws;
for (let i = 0; i < 300 && !ws; i++) {
  try { ws = new WebSocket((await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json()).webSocketDebuggerUrl); } catch { await sleep(100); }
}
if (!ws) throw new Error('chrome did not start');
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const waiting = new Map();
ws.addEventListener('message', (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && waiting.has(msg.id)) { const { resolve, reject } = waiting.get(msg.id); waiting.delete(msg.id); msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result); }
});
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++seq;
  waiting.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});

/** A tab of the given CSS size and pixel ratio in one color scheme, with what a picture needs. */
async function openTab({ width, height, dpr = 2, dark = true }) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p) => send(m, p, sessionId);
  await s('Page.enable'); await s('Runtime.enable');
  await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: false });
  const scheme = (d) => s('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: d ? 'dark' : 'light' }] });
  await scheme(dark);
  const evaluate = async (expression) => {
    const r = await s('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  return {
    scheme, evaluate,
    go: async (url) => { await s('Page.navigate', { url }); },
    until: async (expression, ms = 20_000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { if (await evaluate(expression).catch(() => false)) return true; await sleep(150); }
      throw new Error(`timed out waiting for ${expression}`);
    },
    type: async (text) => { await s('Input.insertText', { text }); },
    enter: async () => { for (const type of ['keyDown', 'keyUp']) await s('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) }); },
    escape: async () => { for (const type of ['keyDown', 'keyUp']) await s('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); },
    shot: async (name) => {
      const { data } = await s('Page.captureScreenshot', { format: 'png' });
      writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
      log('wrote', path.join(OUT, `${name}.png`));
    },
    close: () => send('Target.closeTarget', { targetId }),
  };
}
const text = (s) => `document.body.innerText.includes(${JSON.stringify(s)})`;

// ------------------------------------------------------------ the web UI
async function web() {
  for (const dark of [true, false]) {
    const tag = dark ? 'dark' : 'light';
    const t = await openTab({ width: 1440, height: 960, dpr: 1.5, dark });
    await t.go(`${BASE}#token=${TOKEN}`);
    // The board: every host answered, every lane filled, the manager's dock up.
    await t.until(`document.querySelectorAll('.strip').length >= 9 && ${text('devbox')} && document.querySelector('.mgr-dock textarea') !== null`);
    // Ask the manager once (in the first pass); the second shows the same conversation.
    if (dark) {
      await t.evaluate(`document.querySelector('.mgr-dock textarea').focus()`);
      await t.type('Who is waiting on me?');
      await t.enter();
    }
    // The fake gateway answers with its replies in turn, so any of them is the answer.
    await t.until(REPLIES.map((r) => text(r.replace(/\*\*/g, '').slice(0, 40))).join(' || '), 30_000);
    await sleep(1500);
    await t.shot(`web-board-${tag}`);
    if (dark) {
      // A Claude Code session waiting on a dialog: its chat (tool calls, a code block) and the answer card.
      await t.evaluate(`[...document.querySelectorAll('.strip')].find((x) => x.querySelector('.name')?.textContent === 'demo-build').click()`);
      await t.until(text('Needs a decision') + ' && ' + text('claude-opus-5-5'));
      await sleep(1200);
      await t.shot('web-session-dark');
      // A Codex thread and a Grok bot: the same drawer, their own transcripts.
      for (const [name, file, wait] of [['demo-flaky', 'web-codex-dark', 'priceUpdated'], ['Scout', 'web-grok-dark', 'release notes are drafted']]) {
        await t.evaluate(`[...document.querySelectorAll('.strip')].find((x) => x.querySelector('.name')?.textContent === ${JSON.stringify(name)}).click()`);
        await t.until(text(wait));
        await sleep(1000);
        await t.shot(file);
      }
      // The docker stacks on every machine and the code each runs (the drawer closed first).
      await t.escape();
      await t.until(`!document.querySelector('.drawer-open')`, 5000);
      await t.go(`${BASE}#/stacks`);
      await t.until(text('webapp-review') + ' && ' + text('feat/reports'));
      await sleep(800);
      await t.shot('web-stacks-dark');
    }
    await t.close();
  }
}

// ------------------------------------------------------------ the TUI and the CLI, in real terminals
const TMUX_DIR = path.join('/tmp', `${path.basename(DIR)}-shots`);
// An explicit socket, never TMUX_TMPDIR alone: when TMUX_TMPDIR names a missing directory, tmux falls back to
// the user's default server, and this script's kill-server took down every real tmux session on the Mac.
const TMUX_SOCK = path.join(TMUX_DIR, 'sock');
const tmux = (...a) => { const e = { ...process.env }; delete e.TMUX; delete e.TMUX_PANE; delete e.TMUX_TMPDIR; const r = spawnSync('tmux', ['-S', TMUX_SOCK, ...a], { env: e, encoding: 'utf8' }); if (r.status !== 0) throw new Error(`tmux ${a.join(' ')}: ${r.stderr}`); return r.stdout; };
const ENV_SH = path.join(DIR, 'env.sh');
const PROMPT = "PS1='\\[\\e[38;5;245m\\]studio ~\\[\\e[0m\\] \\$ '";

/** A terminal as a picture: a read-only ttyd on the tmux session, drawn by xterm.js at that size. */
async function terminalShot(session, name, { width = 1240, height = 700, fontSize = 15, before } = {}) {
  // Keys go in before the viewer attaches: with a read-only client attached, tmux refuses send-keys.
  if (before) await before();
  const port = await freePort();
  const ttyd = spawn('ttyd', ['-i', '127.0.0.1', '-p', String(port), '-O', '-t', 'rendererType=dom', '-t', `fontSize=${fontSize}`, '-t', 'fontFamily=Menlo, monospace', '-t', 'disableLeaveAlert=true', '-t', 'disableResizeOverlay=true', '-t', 'theme={"background":"#16181d","foreground":"#d8dce3","cursor":"#d8dce3","cursorAccent":"#16181d"}', 'env', '-u', 'TMUX', '-u', 'TMUX_PANE', '-u', 'TMUX_TMPDIR', 'tmux', '-S', TMUX_SOCK, 'attach', '-r', '-t', session], { stdio: 'ignore' });
  try {
    await sleep(500);
    const t = await openTab({ width, height, dpr: 2 });
    await t.go(`http://127.0.0.1:${port}/`);
    await t.until(`Boolean(window.term) && window.term.cols > 40`);
    await sleep(1500);            // tmux resizes the window to this client and the program redraws
    await t.shot(name);
    await t.close();
  } finally { ttyd.kill('SIGTERM'); }
}
const keys = (session, ...k) => tmux('send-keys', '-t', session, ...k);

async function tui() {
  // The manager first (the TUI opens on it), then the board with a waiting agent selected, then that agent's session.
  tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'tui', '-x', '135', '-y', '37', `bash -c '. ${ENV_SH} && cd "$HOME" && export COLORTERM=truecolor && exec drover tui'`);
  tmux('set', '-g', 'status', 'off');
  await sleep(3000);
  await terminalShot('tui', 'tui-manager', { before: async () => { keys('tui', '-l', 'What finished since I last looked?'); keys('tui', 'Enter'); await sleep(4500); } });
  // Tab: the next view (the board); j: down the waiting lane to demo-build.
  await terminalShot('tui', 'tui-board', { before: async () => { keys('tui', 'Tab'); await sleep(1500); keys('tui', 'j'); await sleep(400); keys('tui', 'j'); await sleep(1200); } });
  await terminalShot('tui', 'tui-session', { before: async () => { keys('tui', 'o'); await sleep(2500); } });
}

async function cli() {
  tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'cli', '-x', '150', '-y', '40', `bash --norc --noprofile -c '. ${ENV_SH} && cd "$HOME" && export COLORTERM=truecolor && exec bash --norc --noprofile -i'`);
  tmux('set', '-g', 'status', 'off');
  await sleep(800);
  keys('cli', '-l', `${PROMPT}; clear`); keys('cli', 'Enter'); await sleep(500);
  for (const [cmd, wait] of [['drover stacks', 9000], ['drover grep "trailing commas" --limit 2', 6000]]) {
    keys('cli', '-l', cmd); keys('cli', 'Enter'); await sleep(wait);
  }
  await terminalShot('cli', 'cli', { width: 1340, height: 560, fontSize: 14 });
}

const killShots = () => { try { tmux('kill-server'); } catch { /* none running */ } };
if (ONLY.has('web')) await web();
if (ONLY.has('tui') || ONLY.has('cli')) {
  mkdirSync(TMUX_DIR, { recursive: true });
  killShots();
  try {
    if (ONLY.has('tui')) await tui();
    if (ONLY.has('cli')) await cli();
  } finally { killShots(); rmSync(TMUX_DIR, { recursive: true, force: true }); }
}
cleanup();
process.exit(0);
