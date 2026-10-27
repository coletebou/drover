// Transcript helpers shared by the board, the drawer and the daemon (core/native.js reads lanes.js, which reads
// this). Turns are rendered by chat.js from chat-model.js items.

/** Registry tmux field is "session:@win.%pane"; tmux accepts "session:@win" as a window target. */
export function tmuxWindowTarget(t) { const m = String(t ?? '').match(/^(.+?):(@\d+)/); return m ? `${m[1]}:${m[2]}` : (t || null); }

/** Is this tmux.windows entry the window a target names, by index ("work:3") or by id ("work:@12", what a launch returns)? */
export function isWindow(w, target) { return Boolean(target) && (w?.target === target || (Boolean(w?.windowId) && `${w.session}:${w.windowId}` === target)); }
