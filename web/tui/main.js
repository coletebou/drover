// drover tui: the terminal client. Parses its flags, finds the daemon (daemon.json and the token in the state dir,
// or --url), takes the terminal and runs the app until it quits. The first frame is drawn before anything is
// asked of the daemon, so the screen is up in well under 300 ms; data fills in as it arrives.
import { stateDir as defaultStateDir } from '../core/paths.js';
import { daemonTarget, Client } from './client.js';
import { setOwner } from '../ui/owner.js';
import { OWNER } from '../core/owner.js';
import { Terminal, guard, mouseWanted } from './term.js';
import { App } from './app.js';
import { WORKSPACES, ALIASES, cloneWorkspaces, placePlugin, resolveView } from './workspaces.js';

export const USAGE = `drover tui [--manager] [--thread T] [--from TARGET] [--url URL] [--view NAME] [--no-mouse]

  The Drover terminal client in seven workspaces: Manager, Agents (Lanes, List, Windows, Wall, Space), Prompts (Mine,
  All), Work (Pulls, Features, a plugin's MRs), Fleet (Hosts, Stacks, Launch), Find (Search, Memory, Events) and
  Settings. Talk to the fleet manager, answer dialogs, read any session's chat and screen, watch every pane live.

  --manager        start in the manager view (the default)
  --thread T       manager thread (default main, the conversation every client shares)
  --from TARGET    the tmux pane or window /look captures (drover manager popup passes the one you came from)
  --url URL        the daemon (default: the url in ~/.local/state/drover/daemon.json)
  --view NAME      start in a workspace or sub-view: ${WORKSPACES.map((w) => w.id).join(', ')}, a path such as
                   agents/wall, or an old view name (board, sessions, tmux, prs, docker...: they still land)
  --no-mouse       leave the mouse to the terminal (as DROVER_TUI_MOUSE=0 does)

  Keys: ? in the TUI. The mouse clicks tabs, sub-tabs, rows, tiles and key hints, highlights what it is over, and the
  wheel scrolls; Shift-drag still selects text in most terminals. NO_COLOR turns colors off; DROVER_TUI_COLOR=none|16|256|truecolor forces a depth.
`;

const THREAD = /^[A-Za-z0-9_.:@%-]{1,64}$/;

/** argv to options; throws a usage error for anything unknown. */
export function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`); return v; };
    if (a === '--manager') opts.view = 'manager';
    else if (a === '--thread') opts.thread = val();
    else if (a === '--from') opts.from = val();
    else if (a === '--url') opts.url = val();
    else if (a === '--view') opts.view = val();
    else if (a === '--no-mouse') opts.noMouse = true;
    else if (a === '--help' || a === '-h' || a === 'help') opts.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (opts.thread && !THREAD.test(opts.thread)) throw new Error('a thread is 1 to 64 of A-Z a-z 0-9 _ . : @ % -');
  if (opts.view && !/^[a-z0-9][a-z0-9_.-]*(\/[a-z0-9][a-z0-9_.-]*)?$/i.test(opts.view)) throw new Error(`not a view name: ${opts.view}`);
  if (opts.from && !/^=?[A-Za-z0-9_.@%:$+-]{1,120}$/.test(opts.from)) throw new Error(`not a tmux target: ${opts.from}`);
  return opts;
}

export async function main(argv, { env = process.env } = {}) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { process.stderr.write(`drover tui: ${e.message}\n\n${USAGE}`); return 2; }
  if (opts.help) { process.stdout.write(USAGE); return 0; }
  const stateDir = defaultStateDir(env);
  let target;
  try { target = daemonTarget({ url: opts.url, stateDir }); } catch (e) { process.stderr.write(`drover tui: ${e.message}\n`); return 1; }
  const client = new Client(target);
  // Who "you" is in the chats: this machine's owner actor (core/owner.js) at once, then the daemon's (GET /api/ops)
  // when it answers, so the first frame does not wait for it.
  setOwner(OWNER);
  const term = new Terminal({ mouse: !opts.noMouse && mouseWanted(env) });
  // A plugin's tables (core/plugins.js tui.tables); a plugin that fails to load costs only its tables.
  const plugins = await import('../core/plugins.js');
  const tables = await plugins.load().then(() => plugins.tuiTables()).catch(() => []);
  // --view names a workspace, a sub-view, an old view id, or a plugin's table (known once the plugins are loaded).
  if (opts.view) {
    const ws = cloneWorkspaces(); for (const t of tables) placePlugin(ws, t);
    if (!resolveView(opts.view, ws)) { process.stderr.write(`drover tui: no view ${opts.view}; one of ${ws.map((w) => w.id).join(', ')}, a path such as agents/wall, or an old name (${Object.keys(ALIASES).join(', ')})\n`); return 2; }
  }
  const app = new App({ client, term, opts: { ...opts, tables }, env, stateDir });
  client.serverInfo().then((info) => { if (!info?.owner) return; setOwner(info.owner); if (app.screen) app.invalidate(); });   // before start(), its first frame has it
  const unguard = guard(term, {
    onFatal: (e) => process.stderr.write(`drover tui crashed: ${e?.stack ?? e}\n`),
    onRejection: (e) => app.toast(`error: ${e?.message ?? e}`, 'err', 8000),
  });
  try { term.start(); } catch (e) { unguard(); process.stderr.write(`drover tui: ${e.message}\n`); return 1; }
  return new Promise((resolve) => {
    app.onQuit = (code) => { unguard(); resolve(code); };
    app.start();
  });
}
