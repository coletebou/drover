// The person this fleet belongs to. Their own clients (the web UI, the TUI, the Chrome and Safari extensions, the
// native apps, the CLI) write to the truth file as one actor, OWNER: DROVER_OWNER, default "owner". A client that
// does not know the configured name sends "owner" or its own client name, and ownerActor() records it as OWNER, so
// the log names one person however they reached the daemon. OWNER_NAME is how prose and prompts name them
// (DROVER_OWNER_NAME, default "the owner").
import { envvar } from './envvars.js';

const clean = (v, def) => (typeof v === 'string' && v.trim() ? v.trim() : def);
export const OWNER = clean(envvar('OWNER'), 'owner').toLowerCase();
export const OWNER_NAME = clean(envvar('OWNER_NAME'), OWNER === 'owner' ? 'the owner' : OWNER);

/** The generic actor a client sends when it does not know OWNER. */
export const OWNER_ALIAS = 'owner';
/** The owner's clients: what they say from any of them is one person (openclaw.js gatewayUser, mcp/server.js). */
const CLIENTS = new Set([OWNER, OWNER_ALIAS, 'chrome', 'safari', 'menubar', 'mac', 'ios', 'watch', 'web', 'tui']);
export const isOwnerClient = (actor) => CLIENTS.has(String(actor ?? '').toLowerCase());
/** An actor as the truth file records it: none given, or the generic alias, is OWNER. */
export const ownerActor = (actor) => (actor === undefined || actor === null || actor === '' || String(actor).toLowerCase() === OWNER_ALIAS ? OWNER : actor);
/** Whether an actor is the owner themself (for showing "you"). */
export const isOwner = (actor) => { const a = String(actor ?? '').toLowerCase(); return a === OWNER || a === OWNER_ALIAS; };
