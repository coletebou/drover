// HTTP + SSE front. Thin: parses the request, checks the bearer token, calls
// dispatch(op, args), serializes the result. The UI is served from ../ui.
import { createServer } from 'node:http';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import path, { dirname } from 'node:path';
import { envvar } from '../core/envvars.js';
import { stateDir } from '../core/paths.js';
import { fileURLToPath } from 'node:url';
import { dispatch, dispatchCached, OPS, cache, notifier, askContextFor } from '../core/api.js';
import { isMutating } from '../core/ops-meta.js';
import * as settingsMod from '../core/settings.js';
import { callOn } from '../core/remote.js';
import * as claude from '../core/claude.js';
import * as launchMod from '../core/launch.js';
import * as events from '../core/events.js';
import * as codex from '../core/codex.js';
import * as hosts from '../core/hosts.js';
import * as pair from '../core/pair.js';
import * as botAuth from '../core/bots/oauth.js';
import * as grok from '../core/bots/grok.js';
import * as approvals from '../core/bots/approvals.js';
import * as clients from '../core/clients.js';
import { markDaemon as markSearchDaemon, startService as startSearch } from '../core/search/service.js';
import * as plugins from '../core/plugins.js';
import { OWNER } from '../core/owner.js';
import * as openclaw from '../core/openclaw.js';
import * as vitals from '../core/vitals.js';
import * as placement from '../core/placement.js';

const UI_DIR = path.join(dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const STATE_DIR = stateDir();
const TOKEN_FILE = path.join(STATE_DIR, 'token');
const WIDGET_TOKEN_FILE = path.join(STATE_DIR, 'widget-token');
// The widget token may read only these two ops (native apps and home-screen widgets).
const WIDGET_PATHS = new Set(['/api/op/native.summary', '/api/op/native.notifications']);
// Bodies are small JSON except uploads (base64 of up to 20 MB, plus slack).
const BODY_LIMITS = { 'uploads.put': 28 * 1024 * 1024, 'files.write': 3 * 1024 * 1024 };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };

export async function loadOrCreateToken() {
  if (!existsSync(STATE_DIR)) await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  if (existsSync(TOKEN_FILE)) return (await readFile(TOKEN_FILE, 'utf8')).trim();
  const t = randomBytes(24).toString('base64url');
  await writeFile(TOKEN_FILE, t + '\n', { mode: 0o600 });
  return t;
}

/** The read-only token for widgets and native apps (scope: native.summary and native.notifications). */
export async function loadOrCreateWidgetToken() {
  if (!existsSync(STATE_DIR)) await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  if (existsSync(WIDGET_TOKEN_FILE)) return (await readFile(WIDGET_TOKEN_FILE, 'utf8')).trim();
  const t = randomBytes(24).toString('base64url');
  await writeFile(WIDGET_TOKEN_FILE, t + '\n', { mode: 0o600 });
  return t;
}

export function isLoopback(addr) {
  const a = String(addr ?? '').toLowerCase();
  return a === 'localhost' || a === '::1' || /^127\.\d+\.\d+\.\d+$/.test(a) || /^::ffff:127\.\d+\.\d+\.\d+$/.test(a);
}

/**
 * The Drover Chrome extension. Its manifest pins a public key, so the id is the same wherever it is
 * loaded unpacked and no machine needs DROVER_ALLOW_ORIGINS for it. Browsers set Origin themselves,
 * so a page cannot claim this origin; every API call still needs the token.
 */
export const CHROME_EXTENSION_ORIGIN = 'chrome-extension://pbcfbpefenbfkhkdfflnapdlfglfanoj';

/** The Chrome extension's origin plus exact origins from DROVER_ALLOW_ORIGINS (comma list); wildcards are dropped. */
export function allowedOrigins(env = process.env) {
  const extra = String(envvar('ALLOW_ORIGINS', env) ?? '').split(',').map((x) => x.trim()).filter((x) => x && !x.includes('*'));
  return new Set([CHROME_EXTENSION_ORIGIN, ...extra]);
}

const sseClients = new Set();
/** Is anyone listening for this event? A client that named topics hears only those (plus hello and pings). */
export const wants = (event) => [...sseClients].some((res) => !res.topics || res.topics.has(event));
export function broadcast(event, data) {
  let line = null;
  for (const res of sseClients) {
    if (res.topics && !res.topics.has(event)) continue;
    line ??= `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    try { res.write(line); } catch { sseClients.delete(res); }
  }
}

/** ?topics=a,b,c: the events a client wants, or null for all of them (what every client got before topics). */
export function topicsOf(url) {
  const raw = url.searchParams.get('topics');
  if (raw == null) return null;
  return new Set(String(raw).split(',').map((x) => x.trim()).filter((x) => /^[a-z][a-z-]{0,30}$/.test(x)));
}

// Transcript followers: one per session id the UI has open.
const followers = new Map(); // id -> { stop, refs }
async function follow(id) {
  if (followers.has(id)) { followers.get(id).refs++; return; }
  const s = await dispatch('sessions.get', { id });
  if (!s || s.engine !== 'claude' || !s.transcript) { followers.set(id, { stop: () => {}, refs: 1 }); return; }
  const stop = claude.followTranscript(s.transcript, (turn) => broadcast('turn', { id, turn }));
  followers.set(id, { stop, refs: 1 });
}
function unfollow(id) { const f = followers.get(id); if (!f) return; if (--f.refs <= 0) { f.stop(); followers.delete(id); } }

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s), 'cache-control': 'no-store' });
  res.end(s);
}

async function readBody(req, { limit = 2 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (!chunks.length) return resolve({}); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('invalid JSON body')); } });
    req.on('error', reject);
  });
}

function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !b) return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Where a pairing request came from, for the approver: the peer address, plus the tailnet login that
 * tailscale serve forwards. Any local process can send that header too, so it is shown as a claim.
 */
function pairFrom(req) {
  const peer = req.socket?.remoteAddress ?? '';
  const login = req.headers['tailscale-user-login'];
  return typeof login === 'string' && login ? `${peer}, says tailnet user ${login.slice(0, 64)}` : peer;
}

/** 'main' | 'widget' | null. The widget token is accepted from the Authorization header only. */
function authScope(req, token, widgetToken, url) {
  const h = req.headers.authorization;
  const bearer = h && h.startsWith('Bearer ') ? h.slice(7) : null;
  if (bearer !== null && sameSecret(bearer, token)) return 'main';
  const q = url.searchParams.get('token');   // SSE and iframes cannot set headers
  if (q !== null && sameSecret(q, token)) return 'main';
  if (bearer !== null && sameSecret(bearer, widgetToken)) return 'widget';
  return null;
}

function originOk(req, boundHost) {
  const origin = req.headers.origin;
  if (!origin) return true; // same-origin navigations and curl have no Origin
  if (allowedOrigins().has(origin)) return true;
  try { const o = new URL(origin); return o.hostname === boundHost || o.hostname === 'localhost' || o.hostname === '127.0.0.1' || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(o.hostname) || o.hostname.endsWith('.ts.net'); } catch { return false; }
}

/**
 * Cross-origin access for direct peers: another Drover page (loopback or
 * tailnet origin, the same allowlist as originOk) may call this daemon straight
 * from the browser instead of going through ssh rpc. The bearer token is still
 * required on every request; this only lets the browser deliver it. Chrome's
 * Private Network Access preflight is answered too.
 */
export function corsHeaders(req, boundHost) {
  const origin = req.headers.origin;
  if (!origin || !originOk(req, boundHost)) return null;
  let same = false; try { same = new URL(origin).host === req.headers.host; } catch { /* bad origin */ }
  if (same) return null;
  const h = { 'access-control-allow-origin': origin, vary: 'Origin', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-max-age': '600' };
  if (req.headers['access-control-request-private-network'] === 'true') h['access-control-allow-private-network'] = 'true';
  return h;
}

// Permissions the page may use (the owner grants them to this origin in the browser).
const PERMISSIONS_POLICY = 'microphone=(self), clipboard-read=(self), clipboard-write=(self), idle-detection=(self), screen-wake-lock=(self), display-capture=(), camera=(), geolocation=(), payment=(), usb=()';

async function serveStatic(res, rel) {
  const safe = path.normalize('/' + rel).replace(/^\/+/, '');
  // A plugin's view (core/plugins.js ui.views) is served beside the UI's own views, so its `../dom.js` imports resolve.
  const pluginFile = safe.startsWith('views/plugin-') ? plugins.uiFile('/' + safe) : null;
  const file = pluginFile ?? path.join(UI_DIR, safe || 'index.html');
  if (!pluginFile && !file.startsWith(UI_DIR)) return json(res, 403, { error: 'forbidden' });
  try {
    const s = await stat(file);
    const f = s.isDirectory() ? path.join(file, 'index.html') : file;
    const body = await readFile(f);
    const headers = { 'content-type': MIME[path.extname(f)] ?? 'application/octet-stream', 'content-length': body.length, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'permissions-policy': PERMISSIONS_POLICY, 'referrer-policy': 'no-referrer' };
    // The service worker controls the whole origin; it never caches /api/ (see ui/sw.js).
    if (path.basename(f) === 'sw.js') headers['service-worker-allowed'] = '/';
    res.writeHead(200, headers);
    res.end(body);
  } catch { json(res, 404, { error: 'not found' }); }
}

export async function startServer({ port = 7337, bind = '127.0.0.1' } = {}) {
  if (!isLoopback(bind) && !existsSync(TOKEN_FILE)) throw new Error(`refusing to bind ${bind}: no token file yet (run drover serve on 127.0.0.1 once to create it)`);
  // This process serves search ops itself (other processes on the host forward them here).
  markSearchDaemon();
  // Manager replies outlive their request here (sessions.message wait: false), and stream to SSE as they arrive.
  openclaw.markDaemon();
  openclaw.onProgress(({ event, data }) => broadcast(event, data));
  // It outlives its answers, so it serves a stale read at once and refreshes it behind (the CLI reads it again first).
  cache.markLongLived();
  const token = await loadOrCreateToken();
  const widgetToken = await loadOrCreateWidgetToken();
  const server = createServer(async (req, res) => {
    // A target or Host URL() rejects (`//[`) is a 400: thrown out here it would be an unhandled rejection that ends the daemon.
    let url;
    try { url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`); } catch { return json(res, 400, { error: 'bad request' }); }
    try {
      if (!url.pathname.startsWith('/api/')) return await serveStatic(res, url.pathname);
      if (!originOk(req, bind)) return json(res, 403, { error: 'bad origin' });
      const cors = corsHeaders(req, bind);
      if (cors) for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      // Pairing (core/pair.js): a client with no token may ask, and may collect once approved.
      if (url.pathname === '/api/pair/request' && req.method === 'POST') {
        const b = await readBody(req, { limit: 4096 });
        const body = b && typeof b === 'object' && !Array.isArray(b) ? b : {};
        let r;
        try { r = pair.createRequest({ client: body.client, device: body.device, from: pairFrom(req) }); }
        catch (e) { if (e instanceof pair.PairError) return json(res, e.status, { error: e.message }); throw e; }
        pair.announce(r);
        broadcast('pair', { code: r.code, client: r.client, device: r.device, expiresAt: r.expiresAt });
        return json(res, 201, { requestId: r.requestId, code: r.code, expiresAt: r.expiresAt, pollMs: 1500 });
      }
      if (url.pathname === '/api/pair/status' && req.method === 'GET') {
        const s = pair.status(url.searchParams.get('requestId'), { token, widgetToken });
        return s ? json(res, 200, s) : json(res, 404, { status: 'expired' });
      }
      const scope = authScope(req, token, widgetToken, url);
      if (!scope) return json(res, 401, { error: 'unauthorized' });
      // tailscale-user-login is set by tailscale serve (a local process could send it too; this view is informational).
      clients.record({ userAgent: req.headers['user-agent'], origin: req.headers.origin, scope, via: req.headers['tailscale-user-login'] ? 'tailnet' : 'local' });
      if (scope === 'widget' && !WIDGET_PATHS.has(url.pathname)) return json(res, 403, { ok: false, error: 'widget token: read-only scope' });

      if (url.pathname === '/api/stream' || url.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        res.topics = topicsOf(url);
        res.write(`event: hello\ndata: ${JSON.stringify({ host: hosts.localShortName(), ts: Date.now(), ...(res.topics ? { topics: [...res.topics] } : {}) })}\n\n`);
        sseClients.add(res);
        // A client that asked for the light board events gets the current ones at once instead of after the next warm.
        if (res.topics?.has('board') || res.topics?.has('summary')) lightNow(res);
        const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 20_000);
        req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
        return;
      }
      if (url.pathname === '/api/follow' && req.method === 'POST') { const { id, on } = await readBody(req); if (on === false) unfollow(id); else await follow(id); return json(res, 200, { ok: true }); }
      // The ops here, the owner's actor (clients show it as "you"), and the plugins with their UI views.
      if (url.pathname === '/api/ops') return json(res, 200, { ops: OPS, owner: OWNER, plugins: plugins.summary().plugins });
      if (url.pathname === '/api/clients' && req.method === 'GET') return json(res, 200, { ok: true, result: clients.recent() });
      // Approving needs the main token, and stays off the op table (no MCP tool, no ssh rpc).
      if (url.pathname === '/api/pair/pending' && req.method === 'GET') return json(res, 200, { ok: true, result: pair.pending() });
      if ((url.pathname === '/api/pair/approve' || url.pathname === '/api/pair/deny') && req.method === 'POST') {
        const b = await readBody(req, { limit: 4096 });
        const code = b && typeof b === 'object' ? b.code : undefined;
        try {
          const result = url.pathname.endsWith('/approve') ? pair.approve(code) : pair.deny(code);
          broadcast('pair', { code: String(code).replace(/[\s-]/g, ''), resolved: result.approved ? 'approved' : 'denied' });
          return json(res, 200, { ok: true, result });
        } catch (e) { if (e instanceof pair.PairError) return json(res, e.status, { ok: false, error: e.message }); throw e; }
      }
      // Grok bots (core/bots): approving a connection, revoking it and setting a bot's Routine need the main token
      // and stay off the op table, like pairing: a prompt-injected agent with MCP or ssh rpc must not be able to let
      // a bot in, or point a bot's Routine (and every message the owner sends it) somewhere else.
      if (url.pathname.startsWith('/api/bots/')) {
        const route = url.pathname.slice('/api/bots/'.length);
        if (req.method === 'GET') {
          if (route === 'pending') return json(res, 200, { ok: true, result: botAuth.pendingList() });
          if (route === 'grants') return json(res, 200, { ok: true, result: await botAuth.grantsList({ includeRevoked: url.searchParams.get('all') === 'true' }) });
          if (route === 'routines') return json(res, 200, { ok: true, result: await grok.routines() });
          return json(res, 404, { ok: false, error: 'no such route' });
        }
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'use POST' });
        const b = await readBody(req, { limit: 8192 });
        const body = b && typeof b === 'object' && !Array.isArray(b) ? b : {};
        let issuer; try { issuer = botAuth.publicBase(); } catch { /* a bad DROVER_BOTS_URL: approve leaves iss out, as when unset */ }
        try {
          let result;
          if (route === 'approve') result = await botAuth.approve(body.code, { bot: body.bot, shared: body.shared === true, scopes: body.scopes, issuer, resourceAccess: body.resourceAccess });
          else if (route === 'deny') result = botAuth.deny(body.code);
          else if (route === 'revoke') result = await botAuth.revokeGrant(body.grantId);
          else if (route === 'token') result = await botAuth.mintToken({ bot: body.bot, shared: body.shared === true, scopes: body.scopes, note: body.note, days: body.days ?? 90, resourceAccess: body.resourceAccess });
          else if (route === 'routine') result = await grok.setRoutine(body.bot, { url: body.url, key: body.key, title: body.title });
          else if (route === 'routine/remove') result = await grok.removeRoutine(body.bot);
          else if (route === 'routine/test') result = await grok.sendTest(body.bot);
          else return json(res, 404, { ok: false, error: 'no such route' });
          if (route === 'approve' || route === 'deny') broadcast('botauth', { code: String(body.code).replace(/[\s-]/g, ''), resolved: route === 'approve' ? 'approved' : 'denied' });
          return json(res, 200, { ok: true, result });
        } catch (e) { if (e instanceof botAuth.OAuthError) return json(res, e.status ?? 400, { ok: false, error: e.message }); throw e; }
      }
      // A Grok bot's approval request (core/bots/approvals.js) is answered here only: the main token, off the op table,
      // so no agent with MCP or ssh rpc can approve a purchase for the owner. The widget token stops above (WIDGET_PATHS).
      if (url.pathname === '/api/approvals' && req.method === 'GET') {
        const status = url.searchParams.get('status') ?? undefined, id = url.searchParams.get('id');
        // ?id= finds one request however much history came after it; otherwise the newest first.
        const items = !grok.configured() ? [] : id ? [await approvals.get(id)].filter(Boolean).map((x) => approvals.ownerView(x)) : await approvals.list({ status, bot: url.searchParams.get('bot') ?? undefined, limit: url.searchParams.get('limit') ?? undefined });
        return json(res, 200, { ok: true, result: { keepsBots: grok.configured(), items } });
      }
      if (url.pathname === '/api/approvals/answer') {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'use POST' });
        const b = await readBody(req, { limit: 4096 });
        const body = b && typeof b === 'object' && !Array.isArray(b) ? b : {};
        try {
          const result = await approvals.answer(body.id, { choice: body.choice, via: body.via });
          broadcast('mutation', { op: 'approvals.answer', args: { id: result.id, choice: result.decision?.n }, ms: 0 });
          lightSoon(200);
          return json(res, 200, { ok: true, result });
        } catch (e) { if (e instanceof approvals.ApprovalError) return json(res, e.status, { ok: false, error: e.message, ...(e.approval ? { approval: e.approval } : {}) }); throw e; }
      }

      // Generic: POST /api/op/<op> with JSON args; GET /api/op/<op>?k=v for read ops.
      const m = url.pathname.match(/^\/api\/op\/([a-zA-Z.]+)$/);
      if (!m) return json(res, 404, { error: 'no such route' });
      const op = m[1];
      let args = req.method === 'POST' ? await readBody(req, { limit: BODY_LIMITS[op] ?? 2 * 1024 * 1024 }) : Object.fromEntries(url.searchParams);
      if (args.token) delete args.token;
      if (req.method === 'GET' && (isMutating(op) || /\.(send|message|new|kill|rename|start|append|upsert|write|add|mark|open|close|stop|keys|importLegacy|comment|create|save|promote|discard|review|run|import|throttle|invalidate|exec|set|reset|mute|unmute|test|put|remove|answer)$/.test(op))) return json(res, 405, { error: 'use POST for mutating ops' });
      const t0 = Date.now();
      const { result, cache: meta } = await dispatchCached(op, args);
      if (/^(launch\.start|sessions\.(message|answer)|tmux\.(send|answer|keys)|events\.append|features\.upsert|mrs\.(comment|create|draft\.\w+|review)|channel\.audit\.import|memory\.handoff\.write|reflections\.(add|mark|edit|apply)|files\.write|uploads\.(put|remove))$/.test(op)) broadcast('mutation', { op, args: { ...args, text: undefined, body: undefined, data: undefined, content: undefined }, ms: Date.now() - t0 });
      // After something that changes what a board shows, the light events follow within a second, not the next warm.
      if (/^(sessions\.(message|answer)|tmux\.(send|answer|keys|new|kill)|launch\.start|headless\.stop)$/.test(op)) lightSoon(800);
      return json(res, 200, { ok: true, result, ms: Date.now() - t0, cache: meta });
    } catch (e) {
      const code = e.conflict ? 409 : /not found|no such/i.test(e.message) ? 404 : /^refused|outside the editable/i.test(e.message) ? 403 : /must|bad |required|unknown op|unknown setting|unknown category|unknown sound|too long|too large|invalid|expected|empty/i.test(e.message) ? 400 : 500;
      return json(res, code, { ok: false, error: e.message, ...(e.event ? { event: e.event } : {}), ...(e.conflict ? { conflict: true, sha256: e.sha256 } : {}) });
    }
  });

  // Headless-session events -> SSE
  const seen = new Set();
  setInterval(() => {
    for (const h of launchMod.headlessList()) {
      if (seen.has(h.id)) continue; seen.add(h.id);
      launchMod.headlessSubscribe(h.id, (ev) => broadcast('headless', { id: h.id, ev }));
    }
  }, 1000).unref();
  // Codex notifications -> SSE
  codex.onNotification((method, params) => broadcast('codex', { method, params }));

  await new Promise((resolve, reject) => { server.on('error', reject); server.listen(port, bind, resolve); });
  const addr = server.address();
  return { server, token, url: `http://${bind}:${addr.port}/`, openUrl: `http://${bind}:${addr.port}/#token=${token}` };
}

// ---------------------------------------------------------------- light board events
// `board` (native.board) and `summary` (native.summary) for clients that subscribe with ?topics= instead of taking the
// megabyte `fleet` event: computed only while someone listens, sent only when they changed (generatedAt aside), and
// soon after anything that changes a board (an answer, a message, a new alert), not only on the next warm.
const LIGHT = ['board', 'summary'];
const lightLast = { board: null, summary: null };
let lightTimer = null, lightRunning = false, lightAgain = false;
const sansTime = (v) => JSON.stringify({ ...v, generatedAt: undefined });
async function lightTick() {
  if (lightRunning) { lightAgain = true; return; }
  lightRunning = true;
  try {
    for (const ev of LIGHT) {
      if (!wants(ev)) { lightLast[ev] = null; continue; }
      const v = await dispatch(ev === 'board' ? 'native.board' : 'native.summary', {}).catch(() => null);
      if (!v) continue;
      const sig = sansTime(v);
      if (sig === lightLast[ev]?.sig) continue;
      lightLast[ev] = { sig, value: v };
      broadcast(ev, v);
    }
  } finally {
    lightRunning = false;
    if (lightAgain) { lightAgain = false; lightSoon(250); }
  }
}
/** Recompute the light events in ms (a burst of triggers runs once). */
export function lightSoon(ms = 0) {
  if (!LIGHT.some(wants)) return;
  if (lightTimer) return;
  lightTimer = setTimeout(() => { lightTimer = null; lightTick().catch(() => {}); }, ms);
  lightTimer.unref?.();
}
/** A new subscriber: the last values at once, then a fresh computation. */
function lightNow(res) {
  for (const ev of LIGHT) {
    const last = lightLast[ev];
    if (last && res.topics?.has(ev)) { try { res.write(`event: ${ev}\ndata: ${JSON.stringify(last.value)}\n\n`); } catch { /* closed */ } }
  }
  lightSoon(0);
}

// Hot keys stay warm in the background and fan out over SSE: local tmux +
// sessions every 15 s (`snapshot`), the whole fleet every 20 s (`fleet`), the
// reachability probe every 2 min (`probe`). The page never waits for these.
export function startSnapshots({ everyMs = 15_000 } = {}) {
  const stops = [];
  let lastWin = null, lastSess = null;
  stops.push(startAlerts());
  const localName = hosts.localShortName();
  const localReply = async (a) => {
    if (a.meta?.transcript) { const ask = await askContextFor({ transcript: a.meta.transcript, tmux: a.meta.tmux }); const { lastText, lastTs, ...rest } = ask; return lastText ? { text: lastText, ts: lastTs, line: claude.lastLine(lastText), ask: rest } : { text: null, ask: rest }; }
    return a.sessionId ? dispatch('sessions.lastReply', { id: a.sessionId }) : null;
  };
  const emitSnapshot = () => {
    if (!lastWin || !lastSess) return;
    broadcast('snapshot', { ts: Date.now(), windows: lastWin, sessions: lastSess.sessions });
    notifier.observe(localName, { ok: true, sessions: lastSess.sessions, windows: lastWin }, { lastReply: localReply }).catch(() => {});
  };
  stops.push(cache.warm(cache.keyFor('tmux.windows', { classify: true }), () => dispatch('tmux.windows', { classify: true }), { every: everyMs, onValue: (v) => { lastWin = v; emitSnapshot(); } }));
  stops.push(cache.warm(cache.keyFor('sessions.list', { includeRecent: false, compact: true }), () => dispatch('sessions.list', { includeRecent: false, compact: true }), { every: everyMs, onValue: (v) => { lastSess = v; emitSnapshot(); lightSoon(300); } }));
  stops.push(cache.warm(cache.keyFor('fleet.summary', {}), () => dispatch('fleet.summary', { maxAgeMs: 1 }), { every: 20_000, onValue: (v) => { broadcast('fleet', v); alertsFromFleet(v); lightSoon(0); } }));
  stops.push(cache.warm(cache.keyFor('host.probe', {}), async () => { const r = await dispatch('host.probe', {}); broadcast('probe', r); return r; }, { every: 120_000, persist: false }));
  stops.push(cache.warm(cache.keyFor('events.state', {}), () => dispatch('events.state', {}), { every: 30_000 }));
  // The search index (core/search): a pass every minute, embeddings backfilled newest first.
  stops.push(startSearch());
  // This machine's vitals every minute; a sustained shortage becomes a resource alert in the ring (never the truth
  // file), which front daemons pull with notify.recent. The fleet catalog says whether it runs here (core/vitals.js).
  stops.push(vitals.startMonitor({ emit: (list) => notifier.emit(list, { record: false }), policy: () => placement.monitorPolicy({ shortName: hosts.localShortName() }) }));
  // Each plugin's own daemon work (core/plugins.js start): its timers and watchers, stopped with the rest.
  stops.push(plugins.startAll({ dispatch, notifier, broadcast, watching: () => sseClients.size, settings: settingsMod }));
  return () => { for (const s of stops) s(); cache.stopWarmers(); };
}

// ---------------------------------------------------------------- alerts
// Remote hosts: when that host's daemon runs its own detector, its alerts are
// pulled (notify.recent rides along in the fleet summary) and re-broadcast here,
// renamed to the alias this front uses; otherwise this daemon diffs that host's
// board data itself. Either way each transition becomes one alert.
const pulledHosts = new Set();
function alertsFromFleet(v) {
  for (const hs of v?.hosts ?? []) {
    if (!hs?.host || hs.host === hosts.LOCAL) continue;
    const det = hs.notify?.detector;
    if (det?.running && Array.isArray(hs.notify.items)) {
      const items = hs.notify.items.map((it) => ({ ...it, host: hs.host, observedAs: it.host }));
      // The first pull from a host is the baseline: remember those alerts, do not replay them.
      if (!pulledHosts.has(hs.host)) { pulledHosts.add(hs.host); notifier.ingestRemote(items, { silent: true }); }
      else notifier.ingestRemote(items);
    } else {
      notifier.observe(hs.host, hs, { lastReply: (a) => (a.sessionId ? callOn(hs.host, 'sessions.lastReply', { id: a.sessionId }, dispatch, { timeoutMs: 8000 }) : null) }).catch(() => {});
    }
  }
}

/** Alerts: SSE fan-out, truth-file appends (hook, manager, launch), settings changes. A plugin may watch more (its start). */
function startAlerts() {
  notifier.daemon = true;
  const offFan = notifier.on((items) => { broadcast('alerts', { items, ts: Date.now() }); lightSoon(200); });
  const offAppend = events.onAppend((ev) => {
    notifier.ingestEvent(ev).catch(() => {});
    // The board's "asked" marker (Notification hook and agent asks).
    if (ev.type === 'notify' && (!ev.category || ev.category === 'needs-you') && (!ev.source || ev.source === 'hook' || ev.source === 'agent' || (ev.source === 'detector' && ev.ask?.kind === 'question')) && !ev.test && (ev.ask ? ev.ask.kind !== 'finished' : ev.kind !== 'idle_prompt')) broadcast('notify', ev);
  });
  const offSettings = settingsMod.onChange((s) => broadcast('settings', s));
  return () => { offFan(); offAppend(); offSettings(); notifier.daemon = false; };
}

export { events, sseClients };
