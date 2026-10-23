// OAuth 2.1 authorization server for the bot gateway (server/botgate.js): dynamic client registration (RFC 7591),
// the authorization code grant with PKCE S256 only (RFC 7636), rotating refresh tokens, revocation (RFC 7009) and
// the metadata documents (RFC 8414, RFC 9728). Grok Bot connects a remote MCP server only through OAuth with
// dynamic client registration, and it reaches Drover from the internet, so consent cannot be a login form: the
// authorize page shows a 6-digit code and the owner approves that code in Drover (`drover bots approve <code>` or the
// browser UI, both with the main token), exactly like device pairing (core/pair.js). Approving is deliberately
// not an op: ops are reachable through the generic MCP tool and over ssh rpc, and neither a prompt-injected agent
// nor a remote peer may grant a token.
//
// State: <state>/bots/oauth.json (0600): registered clients and grants, tokens stored only as SHA-256 hashes.
// Pending authorizations and authorization codes live in this process's memory and expire in minutes.
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stateDir } from '../paths.js';
import { envvar } from '../envvars.js';
import { OWNER_NAME } from '../owner.js';
import { accessForGrant, isTenantBot, resourceAccess as validateResourceAccess, TENANT_PREFIX } from './access.js';

export const DEFAULT_PORT = 7338;
const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];

/**
 * The gateway's public origin (the OAuth issuer) from DROVER_BOTS_URL, or null when the gateway is off. Throws on a
 * value it cannot serve: https only (plain http to loopback, for tests), and an origin with no path, because the
 * metadata documents live at fixed /.well-known paths of that origin.
 */
export function publicBase(env = process.env) {
  const raw = String(envvar('BOTS_URL', env) ?? '').trim();
  if (!raw) return null;
  let u; try { u = new URL(raw); } catch { throw new Error(`DROVER_BOTS_URL is not a URL: ${raw.slice(0, 200)}`); }
  const loopback = LOOPBACK.includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new Error('DROVER_BOTS_URL must be https (plain http only to loopback, for tests)');
  if (u.pathname !== '/' || u.search || u.hash) throw new Error('DROVER_BOTS_URL must be an origin with no path, e.g. https://box.tailnet.ts.net:10000');
  return u.origin;
}

/** The gateway's loopback port: DROVER_BOTS_PORT, else 7338. */
export const gatewayPort = (env = process.env) => Number(envvar('BOTS_PORT', env) ?? DEFAULT_PORT);

export const SCOPES = ['drover.read', 'drover.write', 'drover.notify'];
export const DEFAULT_SCOPES = [...SCOPES];
// The metadata advertises exactly what register() accepts.
const GRANT_TYPES = ['authorization_code', 'refresh_token'];
const AUTH_METHODS = ['none'];   // every client is public (see register)
export const PENDING_TTL_MS = 10 * 60_000;     // the person connecting has ten minutes to approve
export const COLLECT_MS = 60_000;              // after approval, the authorize page has a minute to hand over the code
export const CODE_TTL_MS = 60_000;             // authorization codes are single-use and short
export const ACCESS_TTL_S = 3600;
export const REFRESH_TTL_MS = 60 * 24 * 3600_000;
// The unauthenticated endpoints (registration, the authorize page) are limited per source address (botgate.js
// sourceKey) and in all, so a stranger can neither fill the shared slots and lock the real client out nor flood
// the owner's screens with approval alerts.
export const MAX_PENDING = 20;                 // approvals waiting, in all
export const MAX_PENDING_PER_SOURCE = 3;       // ... asked for from one address
export const MAX_PER_MINUTE = 60;              // registrations and authorizations a minute, in all
export const MAX_PER_MINUTE_PER_SOURCE = 10;   // ... from one address
export const ALERT_WINDOW_MS = 10 * 60_000;
export const ALERTS_PER_SOURCE = 2;            // approval alerts per address per window
export const ALERTS_MAX = 6;                   // approval alerts in all per window
export const MAX_CLIENTS = 200;
const LABEL_MAX = 80;
const PKCE_RE = /^[A-Za-z0-9._~-]{43,128}$/;   // RFC 7636 code_verifier syntax; an S256 code_challenge (43 base64url characters) fits it too
export const BOT_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

export class OAuthError extends Error {
  /** code is the RFC 6749 error code; status the HTTP status for the token endpoint. */
  constructor(code, description, status = 400) { super(description); this.name = 'OAuthError'; this.code = code; this.status = status; }
}

export const _deps = { now: () => Date.now(), file: () => path.join(stateDir(), 'bots', 'oauth.json') };

// ---------------------------------------------------------------- persistence
let db = null;          // { v, clients, grants }
let writing = Promise.resolve();
const pending = new Map();   // rid -> pending authorization
const codes = new Map();     // sha256(code) -> issued authorization code
let created = [];            // { at, source } of registrations and authorizations in the last minute
let alerted = [];            // { at, source } of approval alerts in the last ALERT_WINDOW_MS

const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const token = (prefix) => `${prefix}_${randomBytes(32).toString('base64url')}`;
const iso = (ms) => new Date(ms).toISOString();

let loading = null;      // the first read, shared: two parallel first calls must not each install their own copy
function load() {
  if (db) return Promise.resolve(db);
  loading ??= (async () => {
    let d = null;
    try { d = JSON.parse(await readFile(_deps.file(), 'utf8')); } catch { /* none yet, or unreadable: start empty */ }
    if (!d || typeof d !== 'object' || d.v !== 1) d = { v: 1, clients: {}, grants: {} };
    d.clients ??= {}; d.grants ??= {};
    db = d;
    return d;
  })().finally(() => { loading = null; });
  return loading;
}

/**
 * Atomic write, one at a time (the daemon is the only writer; the CLI goes through its HTTP API). The promise rejects
 * when this write failed, so no caller reports a change that never reached the disk (a revocation would come undone at
 * the next restart); the chain carries on either way, and the next save writes the whole state again.
 */
function save() {
  const snapshot = JSON.stringify(db, null, 1) + '\n';
  const run = writing.then(async () => {
    const file = _deps.file();
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, snapshot, { mode: 0o600 });
    await rename(tmp, file);
  });
  writing = run.catch(() => { /* the next save writes the whole state again */ });
  return run;
}

/** Tests only: forget memory state (the file stays unless the test removes it). */
export function _reset() { db = null; loading = null; pending.clear(); codes.clear(); created = []; alerted = []; writing = Promise.resolve(); }

function sweep(now = _deps.now()) {
  for (const [id, p] of pending) if (p.expiresAt <= now) pending.delete(id);
  for (const [h, c] of codes) if (c.expiresAt <= now) codes.delete(h);
  created = created.filter((c) => now - c.at < 60_000);
  alerted = alerted.filter((a) => now - a.at < ALERT_WINDOW_MS);
}

/** Count one registration or authorization, from source when the caller knows it (the gateway always does). */
function rateLimit(now, source) {
  sweep(now);
  if (source && created.filter((c) => c.source === source).length >= MAX_PER_MINUTE_PER_SOURCE) throw new OAuthError('temporarily_unavailable', 'too many requests from your address; wait a minute', 429);
  if (created.length >= MAX_PER_MINUTE) throw new OAuthError('temporarily_unavailable', 'too many requests; wait a minute', 429);
  created.push({ at: now, source: source || null });
}

/**
 * Whether an authorization request raises an alert on the owner's screens: at most ALERTS_PER_SOURCE per address and
 * ALERTS_MAX in all per ALERT_WINDOW_MS. Every request still shows in the pending list and the browser banner.
 */
function mayAlert(now, source) {
  if (alerted.length >= ALERTS_MAX) return false;
  if (source && alerted.filter((a) => a.source === source).length >= ALERTS_PER_SOURCE) return false;
  alerted.push({ at: now, source: source || null });
  return true;
}

function label(v, name, max = LABEL_MAX) {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v !== 'string') throw new OAuthError('invalid_client_metadata', `${name} must be a string`);
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) : s;
}

// ---------------------------------------------------------------- metadata (RFC 8414, RFC 9728)
/**
 * A bot's own server: /bots/<bot> is a resource and an issuer of its own. Grok Bot keeps one sign-in per server, so
 * connectors that share a URL share one sign-in, and with it one bot's identity (seen 2026-10-20: one bot's
 * connector signed in as another bot). A URL per bot keeps the sign-ins apart, whether a client keys them by resource
 * or by issuer.
 * '' is the root server, which any connection may use.
 */
export const botPrefix = (bot) => (bot ? `/bots/${bot}` : '');

export function authServerMetadata(base, bot = null) {
  const issuer = `${base}${botPrefix(bot)}`;
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: GRANT_TYPES,
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: AUTH_METHODS,
    revocation_endpoint_auth_methods_supported: AUTH_METHODS,
    scopes_supported: SCOPES,
    authorization_response_iss_parameter_supported: true,
    service_documentation: 'https://github.com/coletebou/drover/blob/master/web/README.md#grok-bots',
  };
}

export function protectedResourceMetadata(base, bot = null) {
  const issuer = `${base}${botPrefix(bot)}`;
  return { resource: `${issuer}/mcp`, authorization_servers: [issuer], scopes_supported: SCOPES, bearer_methods_supported: ['header'], resource_name: bot ? `Drover for ${bot}` : 'Drover' };
}

// ---------------------------------------------------------------- registration (RFC 7591)
/**
 * A redirect URI a client may register: https anywhere, plain http only to loopback (native apps, RFC 8252), or an
 * app's private-use scheme such as cursor:// or grokbot://. Never a scheme a browser would run or read locally.
 */
export function redirectUriAllowed(uri) {
  let u;
  try { u = new URL(uri); } catch { return false; }
  if (u.hash) return false;
  const scheme = u.protocol.slice(0, -1).toLowerCase();
  if (scheme === 'https') return Boolean(u.hostname);
  if (scheme === 'http') return LOOPBACK.includes(u.hostname);
  if (['javascript', 'data', 'file', 'vbscript', 'about', 'blob', 'ftp', 'ws', 'wss', 'filesystem'].includes(scheme)) return false;
  return /^[a-z][a-z0-9+.-]*$/.test(scheme);
}

/**
 * Only the name and the redirect URIs are kept. Every client is public: PKCE proves possession of the code, and the
 * auth method, grant types and response types a registration asks for are replaced by what this server does (RFC 7591
 * lets it), the way other OAuth issuers Grok Bot connects to answer. source is the requester's address
 * key (botgate.js sourceKey), for the per-address limit.
 */
export async function register(body = {}, { source } = {}) {
  const now = _deps.now();
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new OAuthError('invalid_client_metadata', 'the registration body must be a JSON object');
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || uris.length > 10 || uris.some((u) => typeof u !== 'string' || u.length > 500)) throw new OAuthError('invalid_redirect_uri', 'redirect_uris must list 1 to 10 URIs');
  const bad = uris.find((u) => !redirectUriAllowed(u));
  if (bad) throw new OAuthError('invalid_redirect_uri', `redirect URI not allowed: ${bad.slice(0, 200)} (https, http to loopback, or an app scheme)`);
  rateLimit(now, source);
  const d = await load();
  // Keep the client list bounded: drop the oldest registrations that never got a grant. One with an approval waiting
  // stays, or a flood of registrations could push out the real client while the owner reads its code.
  const ids = Object.keys(d.clients);
  if (ids.length >= MAX_CLIENTS) {
    const used = new Set([...Object.values(d.grants).map((g) => g.clientId), ...[...pending.values()].filter((p) => p.state === 'pending').map((p) => p.clientId)]);
    const unused = ids.filter((x) => !used.has(x)).sort((a, b) => d.clients[a].createdAt.localeCompare(d.clients[b].createdAt));
    for (const id of unused.slice(0, ids.length - MAX_CLIENTS + 1)) delete d.clients[id];
  }
  const clientId = `drv_client_${randomBytes(12).toString('base64url')}`;
  const client = { clientId, name: label(body.client_name, 'client_name') || 'unnamed client', redirectUris: [...new Set(uris)], createdAt: iso(now), lastUsedAt: null };
  d.clients[clientId] = client;
  await save();
  return { client_id: clientId, client_id_issued_at: Math.floor(now / 1000), client_name: client.name, redirect_uris: client.redirectUris, token_endpoint_auth_method: 'none', grant_types: GRANT_TYPES, response_types: ['code'] };
}

/** An own entry of a client or grant table, never an inherited name such as __proto__ (both ids come from requests). */
const entry = (table, id) => (typeof id === 'string' && Object.hasOwn(table, id) ? table[id] : null);

/** The registered client. Clients are public, so a secret a client sends anyway is ignored. */
async function clientFor(clientId) {
  const c = entry((await load()).clients, clientId);
  if (!c) throw new OAuthError('invalid_client', 'unknown client_id; register again', 401);
  return c;
}

/** Scopes a request may get: the ones asked for that exist; none asked means all of them. */
export function parseScopes(scope) {
  if (scope === undefined || scope === null || scope === '') return [...DEFAULT_SCOPES];
  const want = String(scope).split(/\s+/).filter(Boolean);
  const known = want.filter((s) => SCOPES.includes(s));
  return known.length ? [...new Set(known)] : [...DEFAULT_SCOPES];
}

// ---------------------------------------------------------------- authorization requests
/**
 * Start an authorization: validates the client and redirect URI first (errors there are shown on the page, never
 * redirected), then the rest (errors there go back to the client). source is the browser's address key
 * (botgate.js sourceKey) for the per-address limits; from is what the approver is shown. The same client asking again
 * from the same address (a reload, a retry) replaces its earlier request rather than taking a second slot. Returns
 * { rid, code, expiresAt, ..., alert }, alert saying whether to raise one (mayAlert; never for a replacement).
 */
export async function createAuthorization(q = {}, { from = '', source, bot = null } = {}) {
  const now = _deps.now();
  const d = await load();
  const client = entry(d.clients, q.client_id);
  if (!client) throw Object.assign(new OAuthError('invalid_client', 'unknown client_id: the app must register first'), { page: true });
  const redirectUri = q.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
  if (typeof redirectUri !== 'string' || !client.redirectUris.includes(redirectUri)) throw Object.assign(new OAuthError('invalid_request', 'redirect_uri does not match a registered one'), { page: true });
  const back = (code, description) => Object.assign(new OAuthError(code, description), { redirect: errorRedirect(redirectUri, code, description, q.state) });
  if (q.response_type !== 'code') throw back('unsupported_response_type', 'response_type must be code');
  if (typeof q.code_challenge !== 'string' || !PKCE_RE.test(q.code_challenge)) throw back('invalid_request', 'code_challenge (PKCE) is required');
  if ((q.code_challenge_method ?? 'plain') !== 'S256') throw back('invalid_request', 'code_challenge_method must be S256');
  if (q.state !== undefined && (typeof q.state !== 'string' || q.state.length > 1000)) throw back('invalid_request', 'state is too long');
  try { rateLimit(now, source); } catch (e) { throw back('temporarily_unavailable', e.message); }
  const waiting = [...pending.values()].filter((p) => p.state === 'pending');
  const again = source ? waiting.filter((p) => p.clientId === client.clientId && p.source === source) : [];
  const others = waiting.filter((p) => !again.includes(p));
  if (source && others.filter((p) => p.source === source).length >= MAX_PENDING_PER_SOURCE) throw back('temporarily_unavailable', 'too many approvals are already waiting from your address; approve or deny them in Drover, or wait for them to expire');
  if (others.length >= MAX_PENDING) throw back('temporarily_unavailable', 'too many pending approvals in Drover; approve or deny them first');
  for (const p of again) pending.delete(p.rid);   // its page now reads as expired
  const live = new Set([...pending.values()].map((p) => p.code));
  let code;
  do code = String(randomInt(0, 1_000_000)).padStart(6, '0'); while (live.has(code));
  const p = {
    rid: randomBytes(16).toString('hex'), code, clientId: client.clientId, clientName: client.name, redirectUri,
    challenge: q.code_challenge, scopes: parseScopes(q.scope), stateParam: q.state ?? null, resource: typeof q.resource === 'string' ? q.resource.slice(0, 500) : null,
    from: label(from, 'from', 160), source: source || null, createdAt: now, expiresAt: now + PENDING_TTL_MS, state: 'pending', redirect: null,
    bot: bot || null,   // came through that bot's own server (/bots/<bot>): it can only be approved as that bot
  };
  pending.set(p.rid, p);
  return { rid: p.rid, code, expiresAt: iso(p.expiresAt), clientName: p.clientName, scopes: p.scopes, redirectHost: hostOf(redirectUri), from: p.from, bot: p.bot, alert: !again.length && mayAlert(now, source) };
}

const hostOf = (uri) => { try { const u = new URL(uri); return u.host || `${u.protocol}//`; } catch { return '?'; } };

function withParams(uri, params) {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, v);
  return u.href;
}
function errorRedirect(redirectUri, code, description, state) {
  return withParams(redirectUri, { error: code, error_description: description, state });
}

/** What the authorize page sees for its request: pending, or where to send the browser now. null = unknown/expired. */
export function authorizationStatus(rid) {
  sweep();
  if (typeof rid !== 'string' || !/^[0-9a-f]{32}$/.test(rid)) return null;
  const p = pending.get(rid);
  if (!p) return null;
  if (p.state === 'pending') return { status: 'pending', code: p.code, clientName: p.clientName, scopes: p.scopes, bot: p.bot, expiresAt: iso(p.expiresAt) };
  pending.delete(rid);
  if (p.state !== 'approved') return { status: p.state, redirect: p.redirect, clientName: p.clientName, bot: p.bot };
  // The code is minted as the browser collects it, so its minute starts now: a page that took a while to come back
  // for it (a tab in the background, a slow network) still hands over a live code.
  const authCode = token('drv_code');
  codes.set(sha(authCode), { grantId: p.grantId, clientId: p.clientId, redirectUri: p.redirectUri, challenge: p.challenge, expiresAt: _deps.now() + CODE_TTL_MS });
  return { status: 'approved', redirect: withParams(p.redirectUri, { code: authCode, state: p.stateParam, iss: p.issuer }), clientName: p.clientName, bot: p.grantBot };
}

/** Pending approvals for the approver. Never includes rid, which is the authorize page's secret. */
export function pendingList() {
  sweep();
  return [...pending.values()].filter((p) => p.state === 'pending').map((p) => ({
    code: p.code, client: p.clientName, redirectHost: hostOf(p.redirectUri), scopes: p.scopes, from: p.from, bot: p.bot,
    createdAt: iso(p.createdAt), expiresAt: iso(p.expiresAt),
  }));
}

function findPending(code) {
  const c = String(code ?? '').replace(/[\s-]/g, '');
  if (!/^\d{6}$/.test(c)) throw new OAuthError('invalid_request', 'code must be the 6 digits the authorize page shows', 400);
  sweep();
  const p = [...pending.values()].find((x) => x.state === 'pending' && x.code === c);
  if (!p) throw new OAuthError('invalid_request', `no pending bot authorization with code ${c} (it may have expired)`, 404);
  return p;
}

/** The bot of a shared grant: an explicit, read-only connection any bot may use, acting as none of them. */
export const SHARED_BOT = '*';

/** Scopes as given: "read", "drover.read", a list or a comma string; each must exist. */
function scopeList(scopes) {
  const granted = [...new Set((Array.isArray(scopes) ? scopes : String(scopes).split(/[\s,]+/)).filter(Boolean).map((s) => (String(s).startsWith('drover.') ? String(s) : `drover.${s}`)))];
  if (!granted.length || granted.some((s) => !SCOPES.includes(s))) throw new OAuthError('invalid_scope', `scopes must be among ${SCOPES.join(', ')}`, 400);
  return granted;
}

/**
 * A grant's bot and scopes. A connection belongs to one bot (a short lowercase name), so the gateway knows from the
 * token alone who is calling and records every write under that name. shared is the explicit exception: a read-only
 * connection any bot may use (bot SHARED_BOT), which acts as no bot, so it cannot write, alert or read an inbox.
 */
function grantShape({ bot, shared = false, scopes }, fallbackScopes) {
  if (shared === true) {
    if (bot !== undefined && bot !== null && bot !== '' && bot !== SHARED_BOT) throw new OAuthError('invalid_request', 'a shared connection belongs to no bot: name a bot or share, not both', 400);
    const granted = scopes === undefined || scopes === null ? ['drover.read'] : scopeList(scopes);
    if (granted.some((s) => s !== 'drover.read')) throw new OAuthError('invalid_scope', 'a shared connection is read-only (drover.read): writing and alerts need the bot\'s own connection', 400);
    return { name: SHARED_BOT, granted };
  }
  const name = String(bot ?? '').trim().toLowerCase();
  if (!name || name === SHARED_BOT) throw new OAuthError('invalid_request', 'name the bot this connection belongs to (--as <bot>, e.g. alpha): each bot gets its own connection, and its writes are recorded under that name; --shared makes a read-only one any bot may use', 400);
  if (!BOT_NAME_RE.test(name)) throw new OAuthError('invalid_request', 'bot must be a short lowercase name like alpha (letters, digits, dashes)', 400);
  return { name, granted: scopes === undefined || scopes === null ? [...fallbackScopes] : scopeList(scopes) };
}

/**
 * Approve: creates the grant (bound to the one bot named, or with shared a read-only connection any bot may use) and
 * an authorization code, and readies the redirect the authorize page hands to the browser.
 */
export async function approve(code, { bot, shared = false, scopes, issuer, resourceAccess } = {}) {
  const p = findPending(code);
  // A request that came through a bot's own server is that bot's: no name is needed, and no other name is accepted.
  if (p.bot) {
    const asked = String(bot ?? '').trim().toLowerCase();
    if (shared === true || (asked && asked !== p.bot)) throw new OAuthError('invalid_request', `this request came through ${p.bot}'s own URL (/bots/${p.bot}/mcp), so it can only be approved as ${p.bot}`, 400);
    bot = p.bot;
    if (issuer) issuer = `${issuer}${botPrefix(p.bot)}`;   // the iss its client expects (RFC 9207): that server's issuer
  }
  const { name, granted } = tenantScopes(grantShape({ bot, shared, scopes }, p.scopes), scopes);
  const delegation = approvalDelegation(name, resourceAccess);
  const now = _deps.now();
  const d = await load();
  refuseUndelegatedTenant(d, name, delegation);
  const grantId = `grant_${randomBytes(9).toString('base64url')}`;
  d.grants[grantId] = { grantId, clientId: p.clientId, clientName: p.clientName, bot: name, scopes: granted, ...delegation, resource: p.resource, createdAt: iso(now), lastUsedAt: null, revokedAt: null, refresh: null, access: [] };
  await save();
  // The authorization code itself is minted when the authorize page collects the redirect (authorizationStatus).
  Object.assign(p, { state: 'approved', grantId, grantBot: name, issuer });
  p.expiresAt = Math.max(p.expiresAt, now + COLLECT_MS);
  return { approved: true, client: p.clientName, bot: name, scopes: granted, grantId, ...delegation };
}

export function deny(code) {
  const p = findPending(code);
  p.state = 'denied';
  p.redirect = errorRedirect(p.redirectUri, 'access_denied', `${OWNER_NAME.charAt(0).toUpperCase()}${OWNER_NAME.slice(1)} denied this request in Drover`, p.stateParam);
  p.expiresAt = Math.max(p.expiresAt, _deps.now() + COLLECT_MS);
  return { denied: true, client: p.clientName };
}

// ---------------------------------------------------------------- tokens
/** End a grant for good: verifyAccess and the refresh grant both refuse a revoked one, so all its tokens stop at once. */
async function endGrant(g, why, now = _deps.now()) { g.revokedAt = iso(now); g.revokedWhy = why; await save(); }

/** HMAC over a refresh token's grant id and nonce, with a key made once and kept in the state file. */
function refreshTag(d, id) {
  d.macKey ??= randomBytes(32).toString('base64url');   // saved with the first tokens issued under it
  return createHmac('sha256', Buffer.from(d.macKey, 'base64url')).update(id).digest('base64url').slice(0, 22);
}
const sameTag = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

async function issueTokens(d, g, now) {
  // Everything up to save() is synchronous: a second request with the same refresh token, arriving while this one awaits,
  // must already find it replaced (and so be the replay that ends the grant).
  const access = token('drv_at');
  // The refresh token names its grant and is signed, so an earlier one that comes back is recognised as a replay and a
  // made-up one naming the grant is not (see tokenRequest).
  const id = `${g.grantId}.${randomBytes(32).toString('base64url')}`;
  const refresh = `drv_rt_${id}.${refreshTag(d, id)}`;
  g.refresh = { hash: sha(refresh), expiresAt: iso(now + REFRESH_TTL_MS) };
  g.access = [...(g.access ?? []).filter((a) => Date.parse(a.expiresAt) > now), { hash: sha(access), expiresAt: iso(now + ACCESS_TTL_S * 1000) }].slice(-5);
  g.lastUsedAt = iso(now);
  await save();
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: g.scopes.join(' ') };
}

/** POST /oauth/token. body is the form (or JSON) body; basic is {clientId} from an Authorization: Basic header, if the client sent one. */
export async function tokenRequest(body = {}, basic = null) {
  const now = _deps.now();
  const clientId = basic?.clientId ?? body.client_id;
  const client = await clientFor(clientId);
  const d = await load();
  if (body.grant_type === 'authorization_code') {
    sweep(now);
    const h = typeof body.code === 'string' ? sha(body.code) : null;
    const c = h ? codes.get(h) : null;
    if (!c) throw new OAuthError('invalid_grant', 'authorization code is invalid, expired or already used');
    codes.delete(h);   // single use, whatever happens next
    if (c.clientId !== client.clientId) throw new OAuthError('invalid_grant', 'authorization code was issued to another client');
    if ((body.redirect_uri ?? c.redirectUri) !== c.redirectUri) throw new OAuthError('invalid_grant', 'redirect_uri does not match the authorization request');
    const verifier = body.code_verifier;
    if (typeof verifier !== 'string' || !PKCE_RE.test(verifier)) throw new OAuthError('invalid_grant', 'code_verifier is required (PKCE)');
    if (createHash('sha256').update(verifier).digest('base64url') !== c.challenge) throw new OAuthError('invalid_grant', 'code_verifier does not match the code_challenge');
    const g = d.grants[c.grantId];
    if (!g || g.revokedAt) throw new OAuthError('invalid_grant', 'the grant was revoked');
    requireValidDelegation(g);
    client.lastUsedAt = iso(now);
    return issueTokens(d, g, now);
  }
  if (body.grant_type === 'refresh_token') {
    const m = typeof body.refresh_token === 'string' ? body.refresh_token.match(/^drv_rt_((grant_[A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{22})$/) : null;
    // A tag that does not verify was never issued here: refused, and the grant it names is left alone (RFC 9700 4.14.2).
    const g = m && sameTag(refreshTag(d, m[1]), m[3]) ? entry(d.grants, m[2]) : null;
    if (!g || g.clientId !== client.clientId || g.revokedAt) throw new OAuthError('invalid_grant', 'refresh token is invalid or revoked');
    requireValidDelegation(g);
    // A token of this grant that is not its current one is a replay, however many rotations ago it was issued: it leaked,
    // or two copies of the client raced. End the grant (OAuth 2.1 4.3.1, RFC 9700 4.14.2).
    if (g.refresh?.hash !== sha(body.refresh_token)) { await endGrant(g, 'refresh token reuse', now); throw new OAuthError('invalid_grant', 'refresh token was already used; the grant is revoked, connect again'); }
    if (Date.parse(g.refresh.expiresAt) <= now) throw new OAuthError('invalid_grant', 'refresh token expired; connect again');
    if (body.scope) { const want = parseScopes(body.scope); if (want.some((s) => !g.scopes.includes(s))) throw new OAuthError('invalid_scope', 'a refresh cannot widen the granted scopes'); }
    client.lastUsedAt = iso(now);
    return issueTokens(d, g, now);
  }
  throw new OAuthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
}

/** POST /oauth/revoke (RFC 7009): an access or refresh token. Unknown tokens are not an error. */
export async function revokeToken(tok, basic = null, body = {}) {
  await clientFor(basic?.clientId ?? body.client_id);
  if (typeof tok !== 'string' || !tok) return { revoked: false };
  const h = sha(tok);
  const d = await load();
  for (const g of Object.values(d.grants)) {
    if (g.refresh?.hash === h) { await endGrant(g, 'client revoked its refresh token'); return { revoked: true }; }
    const before = g.access.length;
    g.access = g.access.filter((a) => a.hash !== h);
    if (g.access.length !== before) { await save(); return { revoked: true }; }
  }
  return { revoked: false };
}

// These helpers are used only by the main-token operator approval routes, never by registration or tool args.
function approvalDelegation(bot, value) {
  if (!isTenantBot(bot) && value === undefined) return {};
  try {
    return { resourceAccess: validateResourceAccess(bot, value), resourceApproval: { approvedBy: 'operator:main-token', approvedAt: iso(_deps.now()) } };
  } catch (e) { throw new OAuthError('invalid_request', e.message, 400); }
}
// A native tenant has no tool that alerts the owner: drover.notify is dropped from a default/requested set and refused
// when the operator names it, so a tenant grant never carries a verb its tool surface cannot honour.
function tenantScopes(shape, asked) {
  if (!isTenantBot(shape.name)) return shape;
  if (asked !== undefined && asked !== null && shape.granted.includes('drover.notify')) throw new OAuthError('invalid_scope', 'a native tenant connection takes drover.read and drover.write only', 400);
  const granted = shape.granted.filter((s) => s !== 'drover.notify');
  if (!granted.length) throw new OAuthError('invalid_scope', 'a native tenant connection needs drover.read or drover.write', 400);
  return { ...shape, granted };
}
// Once a tenant, always a tenant: a bot that ever held a resource-delegated grant is never approved again without one,
// even when its name no longer carries the tenant prefix (DROVER_TENANT_PREFIX changed or went missing on this host), so
// a missing setting never hands a tenant the owner's tool surface.
function refuseUndelegatedTenant(d, name, delegation) {
  if (delegation.resourceAccess !== undefined) return;
  if (!Object.values(d.grants ?? {}).some((g) => g?.bot === name && g.resourceAccess !== undefined)) return;
  throw new OAuthError('invalid_request', `${name} was approved as a native tenant before: approve it with its delegation (--tenant, --requester, --projects, --hosts), and check DROVER_TENANT_PREFIX on this host (now ${TENANT_PREFIX})`, 400);
}
function requireValidDelegation(grant) {
  try { accessForGrant(grant); }
  catch { throw new OAuthError('invalid_grant', 'resource delegation is missing or invalid; ask the operator to approve a new connection'); }
}

export const STATIC_DAYS_MAX = 365;

/**
 * A long-lived token for a bot that connects with a static Authorization header instead of OAuth (Grok Bot's
 * chat-added custom server takes one). Main token only (`drover bots token`). The token passes through the bot's
 * chat once when it is handed over, so OAuth stays the better path; this is the fallback.
 */
export async function mintToken({ bot, shared = false, scopes, note = '', days = 90, resourceAccess } = {}) {
  const { name, granted } = tenantScopes(grantShape({ bot, shared, scopes }, DEFAULT_SCOPES), scopes);
  const delegation = approvalDelegation(name, resourceAccess);
  const n = Math.round(Number(days));
  if (!Number.isFinite(n) || n < 1 || n > STATIC_DAYS_MAX) throw new OAuthError('invalid_request', `days must be 1 to ${STATIC_DAYS_MAX}`, 400);
  const now = _deps.now();
  const d = await load();
  refuseUndelegatedTenant(d, name, delegation);
  const grantId = `grant_${randomBytes(9).toString('base64url')}`;
  const tok = token('drv_pat');
  const expiresAt = iso(now + n * 86_400_000);
  const shown = label(note, 'note', 60);
  d.grants[grantId] = { grantId, clientId: null, clientName: `static token${shown ? ` (${shown})` : ''}`, bot: name, scopes: granted, ...delegation, resource: null, createdAt: iso(now), lastUsedAt: null, revokedAt: null, refresh: null, access: [{ hash: sha(tok), expiresAt }], static: true };
  await save();
  return { token: tok, grantId, bot: name, scopes: granted, expiresAt, ...delegation };
}

/** The owner revoking a grant (CLI or UI, main token): its tokens stop working at once. */
export async function revokeGrant(grantId) {
  const d = await load();
  const g = entry(d.grants, grantId);
  if (!g) throw new OAuthError('invalid_request', `no grant ${String(grantId).slice(0, 60)}`, 404);
  if (!g.revokedAt) { g.access = []; await endGrant(g, 'revoked in Drover'); }
  return { revoked: true, grantId: g.grantId, client: g.clientName, bot: g.bot };
}

/**
 * The grant behind a bearer access token, or null. lastUsedAt is kept to the minute so a busy bot does not
 * rewrite the state file on every call.
 */
export async function verifyAccess(bearer) {
  if (typeof bearer !== 'string' || !(bearer.startsWith('drv_at_') || bearer.startsWith('drv_pat_'))) return null;
  const now = _deps.now();
  const h = sha(bearer);
  const d = await load();
  for (const g of Object.values(d.grants)) {
    if (g.revokedAt) continue;
    const a = (g.access ?? []).find((x) => x.hash === h);
    if (!a) continue;
    if (!Number.isFinite(Date.parse(a.expiresAt)) || Date.parse(a.expiresAt) <= now) return null;
    let policy;
    try { policy = accessForGrant(g); } catch { return null; }
    if (!Array.isArray(g.scopes) || g.scopes.some((s) => !SCOPES.includes(s))) return null;
    if (!g.lastUsedAt || now - Date.parse(g.lastUsedAt) > 60_000) { g.lastUsedAt = iso(now); save().catch(() => { /* a hint: the next save carries it */ }); }
    return { grantId: g.grantId, clientId: g.clientId, clientName: g.clientName, bot: g.bot, scopes: [...g.scopes], ...(policy ? { resourceAccess: policy, resourceApproval: g.resourceApproval } : {}) };
  }
  return null;
}

/** Grants for the approver: who can reach the gateway, as which bot, with what. Never a token or hash. */
export async function grantsList({ includeRevoked = false } = {}) {
  const d = await load();
  const now = _deps.now();
  sweep(now);
  const live = (g) => !g.revokedAt && (g.static ? (g.access ?? []).some((a) => Date.parse(a.expiresAt) > now) : Boolean(g.refresh && Date.parse(g.refresh.expiresAt) > now));
  // A sign-in can still finish while its approved request waits for the page to collect it, or its code waits to be
  // exchanged; once neither is left (or the daemon restarted), a grant that never got tokens never will.
  const finishing = new Set([...[...pending.values()].filter((p) => p.state === 'approved').map((p) => p.grantId), ...[...codes.values()].map((c) => c.grantId)]);
  return Object.values(d.grants).filter((g) => includeRevoked || !g.revokedAt).map((g) => ({
    grantId: g.grantId, client: g.clientName, bot: g.bot, ...(g.bot === SHARED_BOT ? { shared: true } : {}), ...(g.resourceAccess !== undefined ? { resourceAccess: g.resourceAccess, resourceApproval: g.resourceApproval } : {}), scopes: g.scopes, createdAt: g.createdAt, lastUsedAt: g.lastUsedAt,
    ...(g.static ? { static: true, expiresAt: g.access?.[0]?.expiresAt ?? null } : { refreshExpiresAt: g.refresh?.expiresAt ?? null }), connected: live(g),
    ...(!g.static && !g.revokedAt && !g.refresh && !g.lastUsedAt && !finishing.has(g.grantId) ? { stalled: true } : {}),
    ...(g.revokedAt ? { revokedAt: g.revokedAt, revokedWhy: g.revokedWhy ?? null } : {}),
  })).sort((a, b) => String(b.lastUsedAt ?? b.createdAt).localeCompare(String(a.lastUsedAt ?? a.createdAt)));
}

/** "123456" -> "123 456", the way the authorize page shows it. */
export const formatCode = (code) => `${code.slice(0, 3)} ${code.slice(3)}`;
