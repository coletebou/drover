// Server-issued resource delegation for native tenant principals. OAuth scopes describe verbs, NOT resources.
// Only the main-token approval/token routes may install this policy; MCP arguments never supply authority.
//
// A native tenant is someone else's agent (another person's OpenClaw, say) that the operator lets see a few exact
// projects on a few exact hosts, never the owner's whole fleet. Its bot name is <prefix>-<tenant>: the prefix is
// DROVER_TENANT_PREFIX (a lowercase word, default "tenant"), so with the default a tenant acme connects as
// tenant-acme. Every bot whose name starts with "<prefix>-" is a tenant and connects only with a delegation.
import path from 'node:path';
import { envvar } from '../envvars.js';

export const DEFAULT_TENANT_PREFIX = 'tenant';
const PREFIX = /^[a-z][a-z0-9]{0,15}$/;
/**
 * The tenant bot prefix: DROVER_TENANT_PREFIX, lowercased, else "tenant". A value that is not a lowercase word (letters
 * and digits, at most 16) is refused with a warning and the default used: existing tenant grants under another prefix
 * then fail closed (their bot no longer matches <prefix>-<tenant>), they never fall back to a legacy bot's authority.
 */
export function tenantPrefix(env = process.env, warn = (m) => process.stderr.write(`${m}\n`)) {
  const raw = envvar('TENANT_PREFIX', env);
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_TENANT_PREFIX;
  const v = String(raw).trim().toLowerCase();
  if (PREFIX.test(v)) return v;
  warn(`drover: DROVER_TENANT_PREFIX ${JSON.stringify(String(raw).slice(0, 40))} is not a lowercase word (letters and digits, at most 16); using "${DEFAULT_TENANT_PREFIX}"`);
  return DEFAULT_TENANT_PREFIX;
}
export const TENANT_PREFIX = tenantPrefix();
/** The bot name of a native tenant: acme -> "<prefix>-acme". */
export const tenantBot = (tenant) => `${TENANT_PREFIX}-${tenant}`;
export const isTenantBot = (bot) => typeof bot === 'string' && bot.startsWith(`${TENANT_PREFIX}-`);
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TENANT = /^[a-z][a-z0-9-]{0,22}[a-z0-9]$|^[a-z]$/;
const REQUESTER = /^[A-Za-z0-9][A-Za-z0-9:@+._/-]{0,159}$/;
const KEYS = ['version', 'tenant', 'bot', 'requester', 'projects', 'hosts'];
const invalid = () => { throw new Error(`invalid resource delegation: specify version 1, the exact ${TENANT_PREFIX}-<tenant> principal, requester, and nonempty canonical absolute checkout paths and exact hosts (no wildcards or local alias)`); };
// The operator supplies physical checkout paths (realpath on each approved host). Never resolve
// remote paths on the gateway or infer repository authority from a basename/sibling/worktree label.
export const isRepoIdentity = (s) => typeof s === 'string' && s.length <= 200 && /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(s) && s.split('/').slice(1).every((p) => !['.', '..', '__proto__', 'constructor', 'prototype'].includes(p));
const names = (xs, { hosts = false } = {}) => {
  if (!Array.isArray(xs) || !xs.length || xs.length > 64 || new Set(xs).size !== xs.length || xs.some((x) => typeof x !== 'string' || !NAME.test(x) || ['.', '..', '__proto__', 'constructor', 'prototype'].includes(x) || (hosts && x === 'local'))) invalid();
  return [...xs];
};

/** Validate and copy, never repair malformed stored authority into a broader policy. Names are case-sensitive. */
export function resourceAccess(bot, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((k) => !KEYS.includes(k)) || KEYS.some((k) => !Object.hasOwn(value, k))) invalid();
  if (value.version !== 1 || typeof value.tenant !== 'string' || !TENANT.test(value.tenant) || bot !== tenantBot(value.tenant) || value.bot !== bot || !REQUESTER.test(value.requester ?? '') || typeof value.requester !== 'string') invalid();
  if (!Array.isArray(value.projects) || !value.projects.length || value.projects.length > 64 || new Set(value.projects).size !== value.projects.length || ![...value.projects].every(isRepoIdentity)) invalid();
  return { version: 1, tenant: value.tenant, bot, requester: value.requester, projects: [...value.projects], hosts: names(value.hosts, { hosts: true }) };
}

/** Missing policy is legacy ONLY for a bot that is not a tenant; a present malformed policy never falls back. */
export function accessForGrant(grant) {
  if (!isTenantBot(grant?.bot) && grant?.resourceAccess === undefined) return null;
  return resourceAccess(grant?.bot, grant?.resourceAccess);
}

export function tenantAccess(grant, gatewayHost) {
  const policy = accessForGrant(grant);
  if (!policy) throw new Error('resource delegation required');
  const projects = new Set(policy.projects), hosts = new Set(policy.hosts);
  const deny = () => { throw new Error('access denied'); };
  const project = (value) => {
    if (!isRepoIdentity(value) || !projects.has(value)) deny();
    return value;
  };
  const hasHost = (value) => typeof value === 'string' && hosts.has(value);
  const repo = (row) => {
    if (row.cwd !== undefined && row.cwd !== null && !isRepoIdentity(row.cwd)) return null;
    const values = ['repo', 'project', 'cwd'].filter((k) => row[k] !== undefined && row[k] !== null).map((k) => row[k]);
    const identities = values.filter(isRepoIdentity);
    if (!identities.length || !identities.every((p) => p === identities[0] && projects.has(p))) return null;
    // Search keeps a display label alongside cwd. It may corroborate an exact identity, never establish
    // authority alone. A foreign cwd cannot be overridden by an approved repo/project label.
    return values.every((v) => isRepoIdentity(v) ? v === identities[0] : typeof v === 'string' && NAME.test(v) && v === path.posix.basename(identities[0])) ? identities[0] : null;
  };
  const record = (row, { sourceHost } = {}) => {
    if (!row || typeof row !== 'object' || (Object.hasOwn(row, 'host') && (typeof row.host !== 'string' || !row.host)) || (Object.hasOwn(row, 'hosts') && (!Array.isArray(row.hosts) || !row.hosts.length || row.hosts.some((h) => typeof h !== 'string' || !h)))) return false;
    const hs = [row.host, ...(Array.isArray(row.hosts) ? row.hosts : []), sourceHost].filter((h) => h !== undefined && h !== null);
    return repo(row) !== null && hs.length > 0 && hs.every(hasHost);
  };
  const local = () => { if (!hasHost(gatewayHost)) deny(); };
  const ownMessage = (e) => e?.type === 'message' && e.to?.kind === 'grok' && e.to.id === `grok:${policy.bot}` && hasHost(e.host) && hasHost(e.to.host);
  const attribution = { tenant: policy.tenant, bot: policy.bot, requester: policy.requester, grantId: grant.grantId };
  return { policy, project, repo, hasHost, record, local, ownMessage, attribution, deny,
    // "local" is resolved from trusted gateway identity, never accepted in persisted authority.
    queryHosts: policy.hosts.map((h) => h === gatewayHost ? 'local' : h),
  };
}

/** Keep only features whose COMPLETE WAL history has known, authorized project and host provenance.
 * The global fold drops host, so trusting events.state would silently release features from unknown hosts.
 * One unauthorized/malformed contribution taints the entire id (including a later move into an allowed repo).
 */
export function delegatedFeatures(events, access, fold) {
  const histories = new Map();
  for (const e of events) if (e?.type === 'feature' && typeof e.fid === 'string') {
    const h = histories.get(e.fid) ?? { events: [], repo: null, allowed: true };
    if (e.repo !== undefined) h.repo = e.repo;
    if (!access.record({ repo: h.repo, host: e.host })) h.allowed = false;
    h.events.push(e); histories.set(e.fid, h);
  }
  return fold([...histories.values()].filter((h) => h.allowed).flatMap((h) => h.events)).features;
}
