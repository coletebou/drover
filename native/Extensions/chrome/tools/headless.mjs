// Run the extension in a headless Chrome against a daemon, drive its pages over CDP (Node's built-in WebSocket)
// and save screenshots. For the dev world (web/test/devworld.js), never for the live daemon: it presses keys and
// asks the manager. The token is read from the daemon's state folder and only travels to the browser.
//   node tools/headless.mjs --url http://127.0.0.1:7338 --out /tmp/drover-ext [--scene popup|panel|all] [--keep]
// The copy of the extension it loads differs from this folder in one line: host_permissions for that one server
// (an unpacked extension's optional permissions need a click to grant). The pinned key keeps the extension id.
import { mkdtempSync, cpSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ID = 'pbcfbpefenbfkhkdfflnapdlfglfanoj';
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg('url', 'http://127.0.0.1:7338');
const OUT = arg('out', join(tmpdir(), 'drover-ext-shots'));
const SCENE = arg('scene', 'all');
/** Chrome for Testing (it still loads unpacked extensions from the command line), else branded Chrome. */
function findChrome() {
  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  try {
    for (const d of readdirSync(cache).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()) {
      const p = join(cache, d, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
      if (existsSync(p)) return p;
    }
  } catch { /* no cache */ }
  return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}
const CHROME = arg('chrome', findChrome());
const PORT = Number(arg('port', 9333));
if (/^http:\/\/(127\.0\.0\.1|localhost):7337\/?$/.test(BASE)) { console.error('refusing the live daemon: this drives real keys and messages'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('headless:', ...a);
mkdirSync(OUT, { recursive: true });

// ---- an extension copy with host access to BASE, and a fresh profile
const work = mkdtempSync(join(tmpdir(), 'drover-ext-'));
const ext = join(work, 'ext');
cpSync(ROOT, ext, { recursive: true, filter: (p) => !/\/(test|tools|node_modules)(\/|$)/.test(p.slice(ROOT.length - 1)) });
const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
// The server, and the same daemon under its other loopback name (a second origin, for the "other server" check).
const ALT = BASE.replace('://127.0.0.1:', '://localhost:');
manifest.host_permissions = [...new Set([`${new URL(BASE).origin}/*`, `${new URL(ALT).origin}/*`])];
writeFileSync(join(ext, 'manifest.json'), JSON.stringify(manifest, null, 2));
const profile = join(work, 'profile');

const chrome = spawn(CHROME, [
  '--headless=new', `--user-data-dir=${profile}`, `--load-extension=${ext}`, `--disable-extensions-except=${ext}`,
  `--remote-debugging-port=${PORT}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1200,1000',
  // Branded Chrome dropped --load-extension (137); this brings it back where it still can. Chrome for Testing
  // (--chrome ".../Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing") always takes it.
  '--disable-features=DisableLoadExtensionCommandLineSwitch',
], { stdio: 'ignore' });
let cleaned = false;
const cleanup = () => {
  if (cleaned) return;
  cleaned = true;
  try { chrome.kill('SIGKILL'); } catch { /* gone */ }
  // Chrome may still be flushing its profile: retry, and never fail the run over a temp folder.
  if (!process.argv.includes('--keep')) { try { rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* left in tmp */ } }
};
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

// ---- CDP
async function browserWs() {
  for (let i = 0; i < 100; i++) {
    try { return (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; } catch { await sleep(100); }
  }
  throw new Error('chrome did not start');
}
const ws = new WebSocket(await browserWs());
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const waiting = new Map();
const events = [];
const listeners = new Set();
ws.addEventListener('message', (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && waiting.has(msg.id)) { const { resolve, reject } = waiting.get(msg.id); waiting.delete(msg.id); msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result); }
  else if (msg.method) { events.push(msg); for (const fn of listeners) { try { fn(msg); } catch { /* ignore */ } } }
});
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++seq;
  waiting.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});

async function evaluate(sessionId, expression, { gesture = false } = {}) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: gesture }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

/** The extension's service worker target, without attaching (an attached debugger keeps a worker alive). */
async function workerTarget() {
  const { targetInfos } = await send('Target.getTargets');
  return targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${ID}/`)) ?? null;
}

async function workerSession() {
  for (let i = 0; i < 100; i++) {
    if (await workerTarget()) return;
    await sleep(100);
  }
  throw new Error('the extension service worker did not start (is the manifest key intact?)');
}

/** With no page open: does the worker stay up, and do streamed summaries keep landing in storage? */
async function backgroundScene() {
  const probe = await openPage('options.html');
  const at = async () => evaluate(probe.sessionId, `chrome.storage.session.get('summary').then((g) => g.summary?.at ?? 0)`);
  const samples = [];
  for (let i = 0; i <= 9; i++) {
    samples.push({ s: i * 10, worker: Boolean(await workerTarget()), summaryAgeS: Math.round((Date.now() - await at()) / 1000) });
    if (i < 9) await sleep(10_000);
  }
  log('background samples:', JSON.stringify(samples));
  await send('Target.closeTarget', { targetId: probe.targetId });
}

async function openPage(path, { width = 400, height = 900, dark = false } = {}) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false }, sessionId);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] }, sessionId);
  await send('Page.navigate', { url: `chrome-extension://${ID}/${path}` }, sessionId);
  return { targetId, sessionId };
}

async function shot(page, name, { full = true } = {}) {
  let clip;
  if (full) {
    const { cssContentSize } = await send('Page.getLayoutMetrics', {}, page.sessionId);
    clip = { x: 0, y: 0, width: Math.ceil(cssContentSize.width), height: Math.min(2400, Math.ceil(cssContentSize.height)), scale: 1 };
  }
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full, ...(clip ? { clip } : {}) }, page.sessionId);
  const file = join(OUT, `${name}.png`);
  writeFileSync(file, Buffer.from(data, 'base64'));
  log('wrote', file);
}

async function until(page, expr, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await evaluate(page.sessionId, expr).catch(() => false)) return true; await sleep(150); }
  log('timed out waiting for', expr);
  return false;
}

const exceptions = () => events.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => e.params.exceptionDetails?.exception?.description ?? e.params.exceptionDetails?.text);

// ---- settings: the server and token, as Save and connect would store them
const token = readFileSync(join(process.env.DROVER_STATE ?? join(homedir(), '.local/state/drover'), 'token'), 'utf8').trim();
await workerSession();
const setup = await openPage('options.html');
await until(setup, `typeof chrome !== 'undefined' && Boolean(chrome.storage?.local)`);
await evaluate(setup.sessionId, `chrome.storage.local.set({ settings: { baseUrl: ${JSON.stringify(BASE)}, token: ${JSON.stringify(token)}, actor: 'chrome', pollMinutes: 1, notify: { enabled: true, decision: true, question: true, finished: false } } }).then(() => chrome.runtime.sendMessage({ type: 'drover:settings-changed' })).then(() => 'ok')`);
log('settings stored; access granted:', await evaluate(setup.sessionId, `chrome.permissions.contains({ origins: [${JSON.stringify(`${new URL(BASE).origin}/*`)}] })`));
await send('Target.closeTarget', { targetId: setup.targetId });

const clickKey = (name, key) => `(() => { const li = [...document.querySelectorAll('li.row')].find((x) => x.querySelector('.title')?.textContent === ${JSON.stringify(name)}); const b = li?.querySelector('.keys [data-key=${JSON.stringify(key)}]'); if (!b || b.disabled) return false; b.click(); return true; })()`;
const rowText = (name) => `(() => { const li = [...document.querySelectorAll('li.row')].find((x) => x.querySelector('.title')?.textContent === ${JSON.stringify(name)}); return li ? li.innerText : null; })()`;

async function popupScene(dark) {
  const tag = dark ? 'dark' : 'light';
  const page = await openPage('popup.html', { dark });
  await until(page, `document.querySelector('.conn')?.textContent === 'Live'`);
  await until(page, `document.querySelectorAll('li.row.wait .keys').length > 0`);
  await shot(page, `popup-${tag}-1-open`);
  log('popup live:', await evaluate(page.sessionId, `document.querySelector('.conn')?.textContent`),
    '| waiting rows with keys:', await evaluate(page.sessionId, `[...document.querySelectorAll('li.row.wait')].map((li) => li.querySelector('.title').textContent + ' [' + [...li.querySelectorAll('.keys .key')].map((b) => b.textContent).join(' | ') + ']').join(' ; ')`));
  if (!dark) {
    log('press 1 on demo-build:', await evaluate(page.sessionId, clickKey('demo-build', '1'), { gesture: true }));
    await until(page, `(${rowText('demo-build')} ?? '').includes('Sent') || (${rowText('demo-build')} ?? '').includes('Not sent')`, 8000);
    log('demo-build row after:', JSON.stringify(await evaluate(page.sessionId, rowText('demo-build'))));
    await shot(page, `popup-${tag}-2-answered`);
    log('press 2 on demo-review:', await evaluate(page.sessionId, clickKey('demo-review', '2'), { gesture: true }));
    await until(page, `(${rowText('demo-review')} ?? '').includes('Sent') || (${rowText('demo-review')} ?? '').includes('Not sent')`, 8000);
    log('demo-review row after:', JSON.stringify(await evaluate(page.sessionId, rowText('demo-review'))));
    // The manager: a streamed reply.
    await evaluate(page.sessionId, `(() => { const i = document.querySelector('.mgr-input'); i.value = 'slow what is the fleet doing'; document.querySelector('.mgr-ask button').click(); return true; })()`, { gesture: true });
    await until(page, `document.querySelector('.mgr-reply.streaming') !== null`, 8000);
    await sleep(1500);
    log('manager streaming:', JSON.stringify(await evaluate(page.sessionId, `document.querySelector('.mgr-exchange')?.innerText`)), '| status:', await evaluate(page.sessionId, `document.querySelector('.mgr-status')?.textContent`));
    await shot(page, `popup-${tag}-3-manager-streaming`);
    await until(page, `document.querySelector('.mgr-reply') && !document.querySelector('.mgr-reply.streaming') && !document.querySelector('.mgr-status.busy')`, 20000);
    log('manager done:', JSON.stringify(await evaluate(page.sessionId, `document.querySelector('.mgr-exchange')?.innerText`)));
    await shot(page, `popup-${tag}-4-manager-done`);
    await evaluate(page.sessionId, `[...document.querySelectorAll('.mgr-chips .chip')].find((b) => b.textContent === 'What finished?').click()`, { gesture: true });
    await until(page, `!document.querySelector('.mgr-status.busy') && (document.querySelector('.mgr-q')?.innerText ?? '').includes('What finished?')`, 20000);
    log('quick prompt:', JSON.stringify(await evaluate(page.sessionId, `document.querySelector('.mgr-exchange')?.innerText`)));
  }
  await send('Target.closeTarget', { targetId: page.targetId });
}

async function panelScene(dark) {
  const tag = dark ? 'dark' : 'light';
  const page = await openPage('sidepanel.html', { width: 460, height: 1000, dark });
  await until(page, `document.querySelector('.conn')?.textContent.includes('Live')`);
  await until(page, `document.querySelector('#picker option') !== null`);
  log('panel picker:', JSON.stringify(await evaluate(page.sessionId, `[...document.querySelectorAll('#picker option')].map((o) => (o.selected ? '*' : '') + o.textContent)`)));
  // The busy session: tool groups with results.
  await evaluate(page.sessionId, `(() => { const s = document.querySelector('#picker'); const o = [...s.options].find((x) => x.textContent.startsWith('demo-work')); s.value = o.value; s.dispatchEvent(new Event('change')); return o.textContent; })()`);
  await until(page, `document.querySelectorAll('.tools-group').length > 0`);
  await evaluate(page.sessionId, `(() => { const g = [...document.querySelectorAll('.tools-group')].slice(-2); for (const d of g) d.open = true; return g.length; })()`);
  await sleep(300);
  log('demo-work groups:', JSON.stringify(await evaluate(page.sessionId, `[...document.querySelectorAll('.tools-group > summary')].slice(-4).map((s) => s.textContent)`)), '| working line:', await evaluate(page.sessionId, `Boolean(document.querySelector('.turn.working'))`));
  await shot(page, `panel-${tag}-1-tools`, { full: false });
  // A waiting session: the answer card.
  await evaluate(page.sessionId, `(() => { const s = document.querySelector('#picker'); const o = [...s.options].find((x) => x.textContent.includes('demo-build')); s.value = o.value; s.dispatchEvent(new Event('change')); return o.textContent; })()`);
  await until(page, `!document.querySelector('.answer-card').hidden`, 8000);
  log('answer card:', JSON.stringify(await evaluate(page.sessionId, `document.querySelector('.answer-card')?.innerText`)));
  await shot(page, `panel-${tag}-2-answer-card`, { full: false });
  if (!dark) {
    log('press Escape on the card:', await evaluate(page.sessionId, `(() => { const b = document.querySelector('.answer-card .keys [data-key="Escape"]'); if (!b) return false; b.click(); return true; })()`, { gesture: true }));
    await until(page, `(document.querySelector('.answer-card')?.innerText ?? '').match(/Sent|Not sent/) !== null`, 8000);
    log('card after:', JSON.stringify(await evaluate(page.sessionId, `document.querySelector('.answer-card')?.innerText`)));
    await sleep(1500);
    log('demo-build chat tail:', JSON.stringify(await evaluate(page.sessionId, `[...document.querySelectorAll('.log > *')].slice(-3).map((n) => n.innerText.slice(0, 120))`)));
  }
  // The manager.
  await evaluate(page.sessionId, `(() => { const s = document.querySelector('#picker'); s.value = 'manager'; s.dispatchEvent(new Event('change')); return true; })()`);
  await until(page, `document.querySelectorAll('.log .turn').length > 0`, 8000);
  if (!dark) {
    await evaluate(page.sessionId, `(() => { const i = document.querySelector('#msg'); i.value = 'slow summarize the board for me'; document.querySelector('.compose .primary').click(); return true; })()`, { gesture: true });
    await until(page, `document.querySelector('.turn.assistant.streaming') !== null`, 8000);
    await sleep(1200);
    await shot(page, `panel-${tag}-3-manager-streaming`, { full: false });
    await until(page, `!document.querySelector('.turn.assistant.streaming') && !document.querySelector('.turn.working')`, 20000);
    log('manager thread tail:', JSON.stringify(await evaluate(page.sessionId, `[...document.querySelectorAll('.log .turn')].slice(-2).map((n) => n.innerText.slice(0, 160))`)));
    // A turn shown twice sits right after itself (two equal replies to two questions are two turns).
    log('manager turns shown twice:', await evaluate(page.sessionId, `(() => { const t = [...document.querySelectorAll('.log .turn')].map((n) => n.innerText); return t.filter((x, i) => i > 0 && x === t[i - 1]).length; })()`));
  }
  await shot(page, `panel-${tag}-4-manager`, { full: false });
  await send('Target.closeTarget', { targetId: page.targetId });
}

const settingsExpr = (base) => `chrome.storage.local.get('settings').then((g) => chrome.storage.local.set({ settings: { ...g.settings, baseUrl: ${JSON.stringify(base)} } }))`;

/**
 * The review checks: (1) a dialog alert's buttons, through the real handler (bg/notifications.js handleButton, the
 * code a click runs), are bound to the server that raised the alert; (4) with the stream blocked, as in Safari
 * without the origin allowed, the side panel still sees the board change and its card presses the fresh screen.
 */
async function reviewScene() {
  // (1) Notifications, end to end on a fresh alert: answer demo-build's dialog so it comes back (the dev world re-shows
  // it about 12 s later and raises a new alert with that screen's hash), poll the feed as the worker does, then press
  // Deny on that alert through the handler a click runs, and read the session's transcript for its reaction.
  const page = await openPage('options.html');
  await until(page, `typeof chrome !== 'undefined' && Boolean(chrome.storage?.session)`);
  const flow = await evaluate(page.sessionId, `(async () => {
    const out = {};
    const { getClient } = await import('/ext/client.js');
    const { pollNotifications, handleButton } = await import('/bg/notifications.js');
    const { normalizeBoard } = await import('/lib/summary.js');
    const { pressKey } = await import('/lib/answer.js');
    const { client, settings } = await getClient();
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // The dev world is shared: another client may answer the re-shown dialog first. Two tries.
    let baseline = null, fresh = null;
    for (let attempt = 0; attempt < 2 && !fresh; attempt++) {
      baseline = (await client.op('native.notifications', { limit: 1 })).cursor;
      // Answer the dialog on screen (a refusal names the screen now on show; press that one).
      let strip = null;
      for (let i = 0; i < 40 && !strip?.keys?.length; i++) { strip = normalizeBoard(await client.op('native.board')).strips.find((x) => x.name === 'demo-build'); if (!strip?.keys?.length) await sleep(1000); }
      let first = await pressKey(client, strip, 'Escape', { actor: settings.actor });
      if (!first.ok) { const r = await client.op('sessions.answer', { id: strip.id, host: 'local', key: 'Escape', expect: 'x', actor: settings.actor }); first = await pressKey(client, { ...strip, hash: r.hash }, 'Escape', { actor: settings.actor }); }
      out.cleared = first.message;
      // The fresh alert for the re-shown dialog.
      for (let i = 0; i < 40 && !fresh; i++) {
        await sleep(1000);
        const page = await client.op('native.notifications', { since: baseline, limit: 50 });
        fresh = page.items.findLast((x) => x.title?.startsWith('demo-build') && x.hash && x.keys?.length) ?? null;
      }
      out.attempts = attempt + 1;
    }
    if (!fresh) return { ...out, error: 'no fresh alert' };
    out.alert = { host: fresh.host, keys: fresh.keys, hash: Boolean(fresh.hash) };
    await chrome.storage.session.set({ notifCursor: baseline, notifSeen: [], notifDialogs: {} });
    const plan = await pollNotifications(client, settings);
    const d = (await chrome.storage.session.get('notifDialogs')).notifDialogs ?? {};
    const nid = Object.keys(d).find((k) => k.endsWith(encodeURIComponent(fresh.id)));
    out.remembered = nid ? { server: d[nid].server, host: d[nid].host, keys: d[nid].keys } : null;
    out.shown = plan.show.length;
    if (!nid) return { ...out, error: 'not remembered' };
    // The same alert pressed after a server change is refused before anything is sent.
    await chrome.storage.local.get('settings').then((g) => chrome.storage.local.set({ settings: { ...g.settings, baseUrl: ${JSON.stringify(ALT)} } }));
    out.otherServer = (await handleButton(nid, 1))?.message;
    await chrome.storage.local.get('settings').then((g) => chrome.storage.local.set({ settings: { ...g.settings, baseUrl: ${JSON.stringify(BASE)} } }));
    out.deny = (await handleButton(nid, 1))?.message;
    await sleep(1500);
    const t = await client.op('sessions.transcript', { id: fresh.sessionId, host: 'local', limit: 6 });
    out.transcriptTail = t.turns.filter((x) => x.role === 'assistant' && x.text).slice(-1).map((x) => x.text);
    return out;
  })()`);
  log('notification flow:', JSON.stringify(flow));
  await send('Target.closeTarget', { targetId: page.targetId });

  // (4) The side panel with /api/stream failing.
  const panel = await openPage('about:blank', { width: 460, height: 1000 });
  await send('Fetch.enable', { patterns: [{ urlPattern: '*api/stream*' }] }, panel.sessionId);
  let blocked = 0;
  const fail = (msg) => {
    if (msg.method === 'Fetch.requestPaused' && msg.sessionId === panel.sessionId) { blocked++; send('Fetch.failRequest', { requestId: msg.params.requestId, errorReason: 'Failed' }, panel.sessionId).catch(() => {}); }
  };
  listeners.add(fail);
  // Which reads the page makes, and when: the board must come back on the poll while the stream is down.
  await send('Network.enable', {}, panel.sessionId);
  const reads = [];
  const t0 = Date.now();
  const watch = (msg) => {
    if (msg.method !== 'Network.requestWillBeSent' || msg.sessionId !== panel.sessionId) return;
    const m = msg.params.request.url.match(/\/api\/op\/([\w.]+)/);
    if (m) reads.push(`${Math.round((Date.now() - t0) / 1000)}s ${m[1]}`);
  };
  listeners.add(watch);
  await send('Page.navigate', { url: `chrome-extension://${ID}/sidepanel.html` }, panel.sessionId);
  await until(panel, `document.querySelector('#picker option') !== null`);
  await evaluate(panel.sessionId, `(() => { const s = document.querySelector('#picker'); const o = [...s.options].find((x) => x.textContent.includes('demo-build')); if (!o) return false; s.value = o.value; s.dispatchEvent(new Event('change')); return true; })()`);
  const cardKeys = `[...document.querySelectorAll('.answer-card:not([hidden]) .keys .key')].map((b) => b.dataset.key).join(',')`;
  await until(panel, `${cardKeys}.length > 0`, 30000);
  log('stream:', await evaluate(panel.sessionId, `document.querySelector('.conn').textContent`), '| blocked stream requests:', blocked, '| card keys:', await evaluate(panel.sessionId, cardKeys));
  log('press Esc on the card:', await evaluate(panel.sessionId, `(() => { const b = document.querySelector('.answer-card .keys [data-key="Escape"]'); if (!b) return false; b.click(); return true; })()`, { gesture: true }));
  await until(panel, `(document.querySelector('.answer-card')?.innerText ?? '').match(/Sent|Not sent/) !== null`, 8000);
  log('card after:', JSON.stringify(await evaluate(panel.sessionId, `document.querySelector('.answer-card')?.innerText`)));
  // The board, read on the poll, shows the dialog gone, then back about 12 s later with a new screen hash.
  const gone = await until(panel, `document.querySelector('.answer-card').hidden`, 30000);
  log('card hid once the board said the dialog was gone:', gone);
  const back = await until(panel, `${cardKeys}.length > 0`, 40000);
  log('card back with fresh keys:', back, await evaluate(panel.sessionId, cardKeys));
  await shot(panel, 'review-panel-polling', { full: false });
  log('press 1 on the fresh screen:', await evaluate(panel.sessionId, `(() => { const b = document.querySelector('.answer-card .keys [data-key="1"]'); if (!b) return 'no button'; if (b.disabled) return 'disabled'; b.click(); return true; })()`, { gesture: true }));
  const statuses = new Set();
  for (let i = 0; i < 40; i++) {
    const st = await evaluate(panel.sessionId, `document.querySelector('.answer-card .answer-status')?.textContent ?? ''`);
    if (st) statuses.add(st);
    if (/Sent|Not sent/.test(st)) break;
    await sleep(150);
  }
  log('card statuses after the press:', JSON.stringify([...statuses]), '| still polling:', await evaluate(panel.sessionId, `document.querySelector('.conn').textContent`));
  if ([...statuses].some((x) => x.startsWith('Not sent'))) {
    // The card showed a screen the board had not caught up with; the refusal re-read it. Press again on what is there now.
    await sleep(2500);
    log('press 1 again:', await evaluate(panel.sessionId, `(() => { const b = document.querySelector('.answer-card .keys [data-key="1"]'); if (!b) return 'no button'; if (b.disabled) return 'disabled'; b.click(); return true; })()`, { gesture: true }));
    await until(panel, `(document.querySelector('.answer-card .answer-status')?.textContent ?? '').match(/^(Sent|Not sent)/) !== null`, 8000);
    log('card status:', JSON.stringify(await evaluate(panel.sessionId, `document.querySelector('.answer-card .answer-status')?.textContent ?? ''`)));
  }
  // The session's own reaction, read from the panel's chat on its next poll (no stream).
  await until(panel, `[...document.querySelectorAll('.log .turn.assistant')].at(-1)?.innerText.includes('option 1') === true`, 15000);
  log('chat tail after the press:', JSON.stringify(await evaluate(panel.sessionId, `[...document.querySelectorAll('.log .turn.assistant')].at(-1)?.innerText.trim() ?? ''`)));
  log('visibility:', await evaluate(panel.sessionId, `document.visibilityState`), '| board reads:', JSON.stringify(reads.filter((r) => r.endsWith('native.board'))));
  listeners.delete(fail);
  listeners.delete(watch);
  await send('Target.closeTarget', { targetId: panel.targetId });
}

try {
  if (SCENE === 'review') await reviewScene();
  if (SCENE === 'popup' || SCENE === 'all') { await popupScene(false); await popupScene(true); }
  if (SCENE === 'panel' || SCENE === 'all') { await panelScene(false); await panelScene(true); }
  if (SCENE === 'bg') await backgroundScene();
  const ex = exceptions();
  log('page exceptions:', ex.length ? ex : 'none');
} catch (e) {
  log('failed:', e.message);
  process.exitCode = 1;
} finally {
  ws.close();
  cleanup();
  process.exit(process.exitCode ?? 0);
}
