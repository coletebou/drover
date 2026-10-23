// Small shared helpers.
import { envvar } from './envvars.js';

/**
 * What an error tells the user to do when another host runs Drover code too old for a request: DROVER_UPDATE_HINT
 * (a fleet that syncs Drover its own way names that way here), else the generic step.
 */
export const UPDATE_HINT = envvar('UPDATE_HINT')?.trim() || 'pull its Drover checkout and restart its daemon';

/** Registry tmux field is "session:@win.%pane"; tmux accepts "session:@win" as a window target. */
/** The WAL actor of a fleet manager: manager, or manager-<name>. */
export const MANAGER_ACTOR = /^manager(-[a-z0-9-]+)?$/;
/** For restrictions: any actor that starts with "manager", in any case, so a near miss of MANAGER_ACTOR fails closed. */
export const isManagerActor = (actor) => /^manager/i.test(String(actor ?? ''));
/** The owner's own clients (core/owner.js): what they say to the manager from any of them is one conversation. */
export { isOwnerClient } from './owner.js';

export function tmuxWindowTargetOf(t) { const m = String(t ?? '').match(/^(.+?):(@\d+)/); return m ? `${m[1]}:${m[2]}` : (t || null); }
