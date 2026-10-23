// Who "you" is in this UI: the daemon's owner actor (core/owner.js), learned from GET /api/ops (api.loadServerInfo),
// or the generic "owner" every daemon also accepts. No browser APIs here, so the models and their tests can use it.
let current = 'owner';
export function setOwner(actor) { if (typeof actor === 'string' && actor.trim()) current = actor.trim().toLowerCase(); }
export const owner = () => current;
/** Whether an actor is the owner themself (their own clients write as the owner, or as the generic "owner"). */
export function isOwner(actor) { const a = String(actor ?? '').toLowerCase(); return a === current || a === 'owner'; }
