// The bot gateway: a second listener (127.0.0.1:7338 by default) that a public HTTPS front (Tailscale Funnel or a
// Cloudflare Tunnel) exposes to the internet, so Grok Bot agents, which run in Cursor-hosted VMs off the tailnet,
// can reach Drover. It serves exactly three things: the OAuth 2.1 endpoints and metadata (core/bots/oauth.js), the
// authorize page (a 6-digit code the owner approves in Drover), and MCP over Streamable HTTP at /mcp with the scoped
// bot tools (core/bots/tools.js). Never /api/, never the UI, never an op by name: the main listener stays on loopback
// and the tailnet. Enabled by DROVER_BOTS_URL, the public origin (https://host[:port], no path).
import { createServer as createHttpServer } from 'node:http';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { envvar } from '../core/envvars.js';
import { OWNER_NAME } from '../core/owner.js';
import * as oauth from '../core/bots/oauth.js';
import { isTenantBot } from '../core/bots/access.js';
import { botTools, instructionsFor } from '../core/bots/tools.js';
import { TENANT_INSTRUCTIONS } from '../core/bots/tenant-tools.js';
import { createServer as createMcpServer, SUPPORTED_PROTOCOLS } from '../mcp/server.js';
import { appleString } from '../core/pair.js';

export const DEFAULT_PORT = oauth.DEFAULT_PORT;
const BODY_LIMIT = 1024 * 1024;
const FORM_LIMIT = 16 * 1024;
const SESSION_IDLE_MS = 24 * 3600_000;
const MAX_SESSIONS = 200;
export const SERVER_INFO = { name: 'drover-bots', version: '1.0.0' };

export const _deps = { now: () => Date.now(), execFile, platform: () => process.platform, announce: null };

// ---------------------------------------------------------------- responses
const json = (res, code, body, headers = {}) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  res.end(s);
};
const redirect = (res, location) => { res.writeHead(302, { location, 'cache-control': 'no-store' }); res.end(); };
const PAGE_HEADERS = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(res, code, { title, body, refreshTo = null }) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refreshTo ? `<meta http-equiv="refresh" content="2;url=${esc(refreshTo)}">` : ''}<title>${esc(title)}</title>
<style>:root{color-scheme:light dark;--bg:#f6f5f2;--fg:#1d1d1b;--mute:#6b6a66;--card:#fff;--line:#e3e1db;--accent:#c2410c}@media(prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecebe7;--mute:#9c9a93;--card:#1d1d1b;--line:#33322f;--accent:#fb923c}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
main{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px;max-width:440px;width:100%}h1{font-size:20px;margin:0 0 12px}p{margin:10px 0;color:var(--mute)}b{color:var(--fg)}
.code{font:600 40px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:4px;text-align:center;margin:18px 0;color:var(--accent)}code{font:14px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--bg);padding:2px 6px;border-radius:5px}</style></head>
<body><main>${body}</main></body></html>`;
  res.writeHead(code, { ...PAGE_HEADERS, 'content-length': Buffer.byteLength(html) });
  res.end(html);
}

/**
 * The body as text, or a 413 rejection once it passes limit. Past the limit the rest is read and dropped, so a client
 * still uploading gets the answer (see tooLarge); past four times the limit the connection is cut.
 */
async function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0, over = false; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (over) { if (size > 4 * limit) req.destroy(); return; }
      if (size > limit) { over = true; chunks.length = 0; reject(Object.assign(new Error('body too large'), { status: 413 })); } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Answer 413 on a connection that stays open while readRaw drops the rest of the body. Closing it (Connection:
 * close, or destroying the request) resets a client that is still uploading, which then never reads the answer.
 */
function tooLarge(res, body = { error: 'body too large' }) {
  json(res, 413, body);
}

/** OAuth endpoints take form bodies (RFC 6749) and, from lenient clients, JSON. */
async function readForm(req) {
  const raw = await readRaw(req, FORM_LIMIT);
  if (/application\/json/i.test(req.headers['content-type'] ?? '')) { try { const j = JSON.parse(raw || '{}'); return j && typeof j === 'object' && !Array.isArray(j) ? j : {}; } catch { return {}; } }
  return Object.fromEntries(new URLSearchParams(raw));
}

/** client_secret_basic credentials, form-decoded per RFC 6749 2.3.1. */
function basicAuth(req) {
  const h = req.headers.authorization;
  if (!h || !/^Basic /i.test(h)) return null;
  try {
    const dec = Buffer.from(h.slice(6).trim(), 'base64').toString('utf8');
    const i = dec.indexOf(':');
    if (i < 0) return null;
    const un = (s) => decodeURIComponent(s.replace(/\+/g, ' '));
    return { clientId: un(dec.slice(0, i)), clientSecret: un(dec.slice(i + 1)) };
  } catch { return null; }
}

const oauthError = (res, e) => json(res, e.status ?? 400, { error: e.code ?? 'invalid_request', error_description: e.message }, { pragma: 'no-cache' });

/** An address without brackets, port or zone, and IPv4 as such when mapped into IPv6; '' when it is not one. */
function bareAddress(value) {
  let a = String(value ?? '').trim();
  const bracketed = a.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) a = bracketed[1];
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(a)) a = a.slice(0, a.lastIndexOf(':'));
  a = a.replace(/%.*$/, '').toLowerCase();
  if (a.startsWith('::ffff:') && isIP(a.slice(7)) === 4) a = a.slice(7);
  return isIP(a) ? a : '';
}
const isLoopback = (a) => a === '::1' || /^127\./.test(a);

/**
 * The address a request came from. The gateway listens on loopback behind a local proxy (Tailscale Funnel or serve,
 * cloudflared) that sets or appends the address it saw as the last X-Forwarded-For entry: that one no client can
 * forge, while the entries before it are whatever the client sent. A peer off loopback has no proxy in front of it,
 * so its own address counts.
 */
export function clientAddress(req) {
  const peer = bareAddress(req.socket?.remoteAddress);
  if (peer && !isLoopback(peer)) return peer;
  const last = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean).at(-1);
  return bareAddress(last) || peer || '?';
}

/** What one address counts as in the limits (core/bots/oauth.js): IPv4 itself, IPv6 its /64, which one host usually holds whole. */
export function sourceKey(address) {
  const a = bareAddress(address);
  if (isIP(a) !== 6) return a || '?';
  // Expand "::" to the zeros it stands for; an embedded IPv4 tail is two groups.
  const groups = (s) => (s ? s.split(':').flatMap((g) => (g.includes('.') ? ['0', '0'] : [g])) : []);
  const [head, tail] = a.includes('::') ? a.split('::') : [a, null];
  const h = groups(head), t = groups(tail);
  const all = tail === null ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return `${all.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(':')}::/64`;
}

/** Where a request came from, shown to the approver: the address the proxy saw, and the client's own User-Agent claim. */
function fromOf(req) {
  const ua = String(req.headers['user-agent'] ?? '').replace(/[\u0000-\u001f]/g, ' ').slice(0, 60);
  return `${clientAddress(req)}${ua ? `, ${ua}` : ''}`;
}

/** Tell whoever sits at this Mac that a bot wants in (a macOS banner, like pairing; DROVER_PAIR_NOTIFY=off silences both). */
function announce(a) {
  if (_deps.announce) return _deps.announce(a);
  if (_deps.platform() !== 'darwin' || /^(0|off|false|no)$/i.test(String(envvar('PAIR_NOTIFY') ?? 'on'))) return;
  const text = `${a.clientName} asks to connect a bot to Drover (${a.scopes.join(', ')}). Approve only if your screen shows ${oauth.formatCode(a.code)}: drover bots approve ${a.code} --as <bot>`;
  _deps.execFile('osascript', ['-e', `display notification ${appleString(text)} with title "Drover bots"`], { timeout: 5_000 }, () => {});
}

// ---------------------------------------------------------------- MCP sessions
const sessions = new Map();     // Mcp-Session-Id -> { grantId, server, lastSeen }
const stateless = new Map();    // grantId -> server, for clients that send no session id

function sweepSessions(now = _deps.now()) {
  for (const [id, s] of sessions) if (now - s.lastSeen > SESSION_IDLE_MS) sessions.delete(id);
  if (sessions.size > MAX_SESSIONS) for (const id of [...sessions.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen).slice(0, sessions.size - MAX_SESSIONS).map(([k]) => k)) sessions.delete(id);
}
export function _resetSessions() { sessions.clear(); stateless.clear(); }

/** This grant's session, or null: a token never reaches another grant's session, which looks like an unknown id. */
const sessionOf = (sid, grant) => { const s = typeof sid === 'string' ? sessions.get(sid) : null; return s?.grantId === grant.grantId ? s : null; };

function serverFor(grant, dispatch, log, hasOp) {
  return createMcpServer({ dispatch, log, tools: botTools(grant, { dispatch, hasOp }), resources: [], instructions: grant.resourceAccess ? TENANT_INSTRUCTIONS : instructionsFor({ brain: hasOp('brain.search') }), serverInfo: SERVER_INFO });
}

const isRequest = (m) => m && typeof m === 'object' && m.id !== undefined && m.id !== null && typeof m.method === 'string';

async function handleMcp(req, res, { base, dispatch, log, hasOp, bot = null }) {
  // MCP's rule against DNS rebinding: a browser page on another site gets nothing here. Grok Bot's backend sends no
  // Origin. The OAuth endpoints stay open to any origin, as OAuth clients (and the Line issuer Grok Bot uses) expect.
  const origin = req.headers.origin;
  if (origin && origin !== base) return json(res, 403, { error: 'origin not allowed' });
  const meta = `${base}/.well-known/oauth-protected-resource${oauth.botPrefix(bot)}/mcp`;
  const h = req.headers.authorization;
  const bearer = h && /^Bearer /i.test(h) ? h.slice(7).trim() : null;
  const grant = bearer ? await oauth.verifyAccess(bearer) : null;
  // A bot's own server takes only that bot's connection. Another one's token is answered like an invalid one, so the
  // client signs in again for this server, and its code is approved as this bot (oauth.approve).
  const foreign = grant && bot && grant.bot !== bot;
  if (!grant || foreign) {
    const why = foreign ? `this connection belongs to ${grant.bot === oauth.SHARED_BOT ? 'no bot (shared)' : grant.bot}, not ${bot}` : 'the access token is invalid or expired';
    const challenge = `Bearer realm="drover", resource_metadata="${meta}"${bearer ? `, error="invalid_token", error_description="${why}"` : ''}`;
    return json(res, 401, { error: bearer ? 'invalid_token' : 'unauthorized', error_description: `${bearer ? `${why}; ` : ''}connect through OAuth; metadata at ${meta}` }, { 'www-authenticate': challenge });
  }
  const pv = req.headers['mcp-protocol-version'];
  if (pv !== undefined && !SUPPORTED_PROTOCOLS.has(pv)) return json(res, 400, { error: `unsupported MCP-Protocol-Version ${String(pv).slice(0, 20)}` });
  const sid = req.headers['mcp-session-id'];
  if (req.method === 'GET') return json(res, 405, { error: 'this server does not open an SSE stream; POST JSON-RPC to /mcp' }, { allow: 'POST, DELETE' });
  if (req.method === 'DELETE') {
    if (!sessionOf(sid, grant)) return json(res, 404, { error: 'no such session' });
    sessions.delete(sid);
    res.writeHead(204); res.end(); return;
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' }, { allow: 'POST, DELETE' });
  let msg;
  try { msg = JSON.parse(await readRaw(req, BODY_LIMIT)); }
  catch (e) {
    if (e.status === 413) return tooLarge(res, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'body too large' } });
    return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
  }
  // A slow body upload must not carry revoked/changed authority into dispatch. verifyAccess returns a copy of
  // stored policy, not request claims. Tenant servers are rebuilt on every request rather than caching authority.
  if (grant.resourceAccess && JSON.stringify(await oauth.verifyAccess(bearer)) !== JSON.stringify(grant)) return json(res, 401, { error: 'invalid_token' });
  const list = Array.isArray(msg) ? msg : [msg];
  const initializing = list.some((m) => m?.method === 'initialize');
  sweepSessions();
  let server, newSid = null;
  if (initializing) {
    newSid = randomBytes(18).toString('base64url');
    server = serverFor(grant, dispatch, log, hasOp);
    sessions.set(newSid, { grantId: grant.grantId, server, lastSeen: _deps.now() });
  } else if (typeof sid === 'string') {
    const s = sessionOf(sid, grant);
    // Unknown (expired, daemon restarted) or another grant's session: the client must initialize again (spec: 404).
    if (!s) return json(res, 404, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'session not found; initialize again' } });
    s.lastSeen = _deps.now();
    server = grant.resourceAccess ? serverFor(grant, dispatch, log, hasOp) : s.server;
  } else {
    if (grant.resourceAccess) server = serverFor(grant, dispatch, log, hasOp);
    else {
      if (!stateless.has(grant.grantId)) stateless.set(grant.grantId, serverFor(grant, dispatch, log, hasOp));
      server = stateless.get(grant.grantId);
    }
  }
  const out = await server.handleMessage(msg);
  // Revocation or policy invalidation during an awaited read cannot release an old, broader answer.
  if (grant.resourceAccess && JSON.stringify(await oauth.verifyAccess(bearer)) !== JSON.stringify(grant)) {
    if (newSid) sessions.delete(newSid);
    return json(res, 401, { error: 'invalid_token' });
  }
  const headers = newSid ? { 'mcp-session-id': newSid } : {};
  if (!list.some(isRequest) || out === null) { res.writeHead(202, headers); res.end(); return; }
  return json(res, 200, out, headers);
}

// ---------------------------------------------------------------- the authorize page
function authorizePage(res, a, base) {
  const scopes = a.scopes.map((s) => s.replace('drover.', '')).join(', ');
  const native = isTenantBot(a.bot);
  const owners = `one of ${esc(OWNER_NAME)}'s bots`;
  const who = a.bot ? `<b>${esc(a.bot)}</b>, ${native ? 'a native tenant' : owners},` : owners;
  page(res, 200, {
    title: 'Approve in Drover', refreshTo: `${base}${oauth.botPrefix(a.bot)}/oauth/authorize/wait?rid=${a.rid}`,
    body: `<h1>Connect to Drover</h1><p><b>${esc(a.clientName)}</b> asks to connect ${who} to Drover (${esc(scopes)}).</p>
<p>Approve this code in Drover, on the machine it runs on or in the Drover app:</p><div class="code">${esc(oauth.formatCode(a.code))}</div>
<p><code>drover bots approve ${esc(a.code)}${a.bot ? '' : ' --as &lt;bot&gt;'}${native ? ' --tenant &lt;tenant&gt; --requester &lt;requester&gt; --projects &lt;canonical,checkout,paths&gt; --hosts &lt;exact,names&gt;' : ''}</code></p><p>This page moves on by itself once you approve. Codes expire in ten minutes. If you did not start this, ignore it.</p>`,
  });
}

/**
 * The bot a path addresses and the route inside its server: /bots/alpha/oauth/token is ['alpha', '/oauth/token'].
 * A bot server's metadata comes both by RFC 8414 / 9728 path insertion (/.well-known/<doc>/bots/alpha[/mcp]) and
 * appended to its prefix, as some clients ask. Anything else is the root server (bot null).
 */
function routeOf(p) {
  let m = p.match(/^\/\.well-known\/(oauth-protected-resource|oauth-authorization-server|openid-configuration)\/bots\/([^/]+)(\/mcp)?$/);
  if (m) return { bot: m[2], route: `/.well-known/${m[1]}${m[3] ?? ''}` };
  m = p.match(/^\/bots\/([^/]+)(\/.*)$/);
  if (m) return { bot: m[1], route: m[2] };
  return { bot: null, route: p };
}

// ---------------------------------------------------------------- server
/**
 * Start the gateway. base is the public origin; dispatch(op, args) resolves to an op's result (the daemon's
 * dispatcher); hasOp(op) whether it has an op (default: every op), so tools built on a plugin's ops are listed only where
 * the plugin is loaded; onPending(authorization) runs when a bot asks to connect (the daemon tells the browser UI, and raises
 * an alert when authorization.alert says so). Returns { server, url, base }.
 */
export async function startBotGateway({ base, port = DEFAULT_PORT, bind = '127.0.0.1', dispatch, hasOp = () => true, log = () => {}, onPending = null } = {}) {
  if (!base) throw new Error('the bot gateway needs its public URL (DROVER_BOTS_URL)');
  if (typeof dispatch !== 'function') throw new Error('the bot gateway needs a dispatch function');
  const server = createHttpServer(async (req, res) => {
    // A target URL() rejects (`//[`) is a 400: thrown out here it would be an unhandled rejection that ends the daemon.
    let url;
    try { url = new URL(req.url, 'http://gateway.invalid'); } catch { return json(res, 400, { error: 'bad request target' }); }
    const p = url.pathname;
    const { bot, route } = routeOf(p);
    try {
      if (bot !== null && !oauth.BOT_NAME_RE.test(bot)) return json(res, 404, { error: 'not found' });
      if (req.method === 'GET' && (route === '/.well-known/oauth-protected-resource' || route === '/.well-known/oauth-protected-resource/mcp')) return json(res, 200, oauth.protectedResourceMetadata(base, bot), { 'cache-control': 'max-age=300' });
      if (req.method === 'GET' && (route === '/.well-known/oauth-authorization-server' || route === '/.well-known/oauth-authorization-server/mcp' || route === '/.well-known/openid-configuration')) return json(res, 200, oauth.authServerMetadata(base, bot), { 'cache-control': 'max-age=300' });
      if (route === '/mcp') return await handleMcp(req, res, { base, dispatch, log, hasOp, bot });
      if (route === '/oauth/register' && req.method === 'POST') {
        const raw = await readRaw(req, FORM_LIMIT);   // too large: the outer catch answers 413
        let body;
        try { body = JSON.parse(raw || '{}'); } catch { return oauthError(res, new oauth.OAuthError('invalid_client_metadata', 'the registration body must be JSON')); }
        return json(res, 201, await oauth.register(body, { source: sourceKey(clientAddress(req)) }));
      }
      if (route === '/oauth/authorize' && req.method === 'GET') {
        try {
          const a = await oauth.createAuthorization(Object.fromEntries(url.searchParams), { from: fromOf(req), source: sourceKey(clientAddress(req)), bot });
          log('bot authorization pending', a.clientName, a.scopes.join(' '));
          // Alerts are deduplicated and throttled (oauth.js mayAlert); a quiet request still shows in the browser banner and pending list.
          if (a.alert) announce(a);
          // Never the rid: it is the authorize page's secret, the one thing that collects the code once approved.
          const { rid: _rid, ...shown } = a;
          try { onPending?.(shown); } catch (e) { log('onPending failed', e?.message ?? String(e)); }
          return authorizePage(res, a, base);
        } catch (e) {
          if (!(e instanceof oauth.OAuthError)) throw e;
          if (e.redirect) return redirect(res, e.redirect);
          return page(res, 400, { title: 'Cannot connect', body: `<h1>Cannot connect</h1><p>${esc(e.message)}.</p>` });
        }
      }
      if (route === '/oauth/authorize/wait' && req.method === 'GET') {
        const s = oauth.authorizationStatus(url.searchParams.get('rid'));
        if (!s) return page(res, 410, { title: 'Expired', body: '<h1>This request expired</h1><p>Start connecting again from the bot.</p>' });
        if (s.status === 'pending') return authorizePage(res, { ...s, rid: url.searchParams.get('rid') }, base);
        // The browser now carries the code (or the denial) back to the client: a sign-in that never finishes stops
        // either before this line (the page was closed) or after it (the client's code exchange failed, logged below).
        log(`bot authorization ${s.status === 'approved' ? 'handed to the browser' : s.status}`, s.clientName, s.bot ?? '');
        return redirect(res, s.redirect);
      }
      if (route === '/oauth/token' && req.method === 'POST') {
        const form = await readForm(req);
        try {
          return json(res, 200, await oauth.tokenRequest(form, basicAuth(req)), { pragma: 'no-cache' });
        } catch (e) {
          // The one OAuth answer worth a line: a refused code exchange is why a sign-in the owner approved never finished.
          // Only the fixed description, never the code.
          if (e instanceof oauth.OAuthError && e.code === 'invalid_grant' && form.grant_type === 'authorization_code') log('bot code exchange refused', e.message);
          throw e;
        }
      }
      if (route === '/oauth/revoke' && req.method === 'POST') {
        const form = await readForm(req);
        await oauth.revokeToken(form.token, basicAuth(req), form);
        return json(res, 200, {});
      }
      if (route === '/' && req.method === 'GET' && bot === null) return json(res, 200, { name: 'Drover bot gateway', mcp: `${base}/mcp`, perBot: `${base}/bots/<bot>/mcp`, oauth: `${base}/.well-known/oauth-authorization-server` });
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      // An OAuthError is the endpoint's answer (RFC 6749 5.2), not a failure: sent as is, never logged.
      if (e instanceof oauth.OAuthError && !res.headersSent) return oauthError(res, e);
      log('bot gateway error', p, e?.message ?? String(e));
      if (res.headersSent) res.end();
      else if (e?.status === 413) tooLarge(res);
      else json(res, 500, { error: 'internal error' });
    }
  });
  await new Promise((resolve, reject) => { server.on('error', reject); server.listen(port, bind, resolve); });
  return { server, url: `http://${bind}:${server.address().port}/`, base };
}
