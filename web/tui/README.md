# drover tui

The terminal client for Drover: talk to the fleet manager first, and see in the terminal what the web UI shows.
Zero dependencies, Node 24, ESM, like the rest of `web/`. Contracts: `docs/specs/2026-10-20-ux-overhaul.md`, and for
the workspaces, Prompts, the Wall, the Space and hover `docs/specs/2026-11-21-cohesion-overhaul.md`.

```
drover tui [--manager] [--thread T] [--from TARGET] [--url URL] [--view NAME|PATH] [--no-mouse]
drover manager popup [--independent | --thread T] [--fresh] [--width 85%] [--height 80%] [--client C]
drover manager keys [--install] [--key M] [--independent-key N] [--force]
```

## Workspaces

Seven workspaces, each answering one question (contract: `docs/specs/2026-11-21-cohesion-overhaul.md`). Digits pick
a workspace; the row under the tab bar shows its sub-views (a click switches, `<` `>` or Shift-Left/Right step
through them), and each workspace comes back on the sub-view it showed last (kept with the composer history in
`tui-history.json`).

| Key | Workspace › sub-view | Reads |
|---|---|---|
| 1 | Manager (the default) | `sessions.transcript {id: "manager", thread}`, `manager` and `turn` events; sends `sessions.message {id: "manager", text, wait: false, thread}` |
| 2 | Agents › Lanes | `native.board` and `board` events (`fleet.summary` and `fleet` events on an older daemon); answers with `sessions.answer {id, key, expect}` (`tmux.answer` on an older daemon) |
| | Agents › List | `sessions.list` per host |
| | Agents › Windows | `tmux.windows {classify: true}` per host |
| | Agents › Wall | the board's strips as live tiles: `tmux.captureMany {targets, lines, escapes: true}` per host (`tmux.capture` per tile on an older daemon) |
| | Agents › Space | the fleet in 3D (`views/space.js`; a placeholder until it lands) |
| 3 | Prompts › Mine, All | `prompts.list {q, via, hosts, limit, before}`; `launch.start` on `l` |
| 4 | Work › Pulls | `prs.list` (GitHub through the host's `gh`): `s` scope (yours and the ones asking your review, yours, asking your review, involving you), `t` state, `prs.get` for the selected one, Enter or `o` opens it in the browser |
| | Work › Features | `events.state` |
| 5 | Fleet › Hosts | `host.list`, the board's host counts, `host.facts` for the selected host, `host.probe` on `p` |
| | Fleet › Stacks | `docker.fleet` |
| | Fleet › Launch | `launch.profiles` (read-only) |
| 6 | Find › Search | `search.fleet` (`/` types the query) |
| | Find › Memory | `reflections.list` (every repo when no `DROVER_DEFAULT_REPO` is set) |
| | Find › Events | `events.tail`, refreshed after `mutation` events |
| 7 | Settings | `settings.get` (Enter edits a setting through `settings.set`, Space flips a yes/no, `u` removes a mute through `notify.unmute`; the toast says when the daemon kept another value, a volume brought into range) |
| | Session (Enter on a strip, a row, a tile or a prompt) | `sessions.get`, `sessions.transcript` with `since` every 3 s plus `turn` events (after `/api/follow`), `tmux.capture` every 1.5 s on Screen |

Every table: `j`/`k`, PgUp/PgDn, `/` filter, Enter (open, or details), `R` refresh, and `[` `]` change the host
for List and Windows. The detail pane sits beside the table at 120 columns and more, under it otherwise.

**A plugin's tables** (`core/plugins.js` `tui.tables`) join a workspace: the `workspace` a table names wins (with
`sub`, its sub-view id); else the alias of its own id (the APEX plugin's `mrs` is `work/mrs`, so MRs land in Work);
else the workspace of the view its `after` names (an older plugin naming only an old view id: `after: 'memory'` puts
it in Find); else Work. Inside the workspace it follows the sub-view `after` names when that one is there, else it
goes last (`workspaces.js` `placePlugin`).

### Old names (aliases)

`--view`, `go(id)` and the palette take a workspace (`agents`: the sub-view it showed last), a path (`agents/wall`)
or any old view id, which lands as the web UI's does:

| Old | New |
|---|---|
| board | agents/lanes |
| sessions, survey | agents/list |
| tmux, windows, terminals | agents/windows |
| wall | agents/wall |
| space, 3d | agents/space |
| prompts, spool, requests | prompts/mine |
| prs, pr, pulls | work/pulls |
| features | work/features |
| mrs, mr | work/mrs (the plugin's table; Work without it) |
| fleet, hosts | fleet/hosts |
| stacks, docker | fleet/stacks |
| launch, profiles | fleet/launch |
| search | find/search |
| memory, reflections | find/memory |
| events | find/events |
| files | find (the web's find/files) |

### Agents: one selection

Lanes, List, Windows, Wall and Space are five renderings of the same board strips. The agent selected in one is
selected in the others, held by its strip key (`board.js` `stripKey`: the daemon's `host|id`, never a position): a
List row is its strip by session id on its host, a Windows row by its agent's session or its tmux window. A row that
is no agent selects none. In Lanes a selection carried from another view is drawn hollow (`▹`) and arms nothing:
answer keys act only on a strip selected in Lanes itself (`j`/`k`, Enter or a click), so switching sub-views can
never put a digit on a dialog.

### Prompts

Every prompt typed into an agent on any machine, verbatim, newest first: when, host, engine, project, via and the
text on one line; the detail pane holds the whole text as typed (wrapped, never read as Markdown), the session, cwd,
label and time. Mine sends the "a person sent it" set (`via: typed, queued, drover, headless`), All adds `peer`
(agents to agents); `v` switches. `/` filters what is loaded at once and asks the daemon (`q`, every word must match)
a moment after the last key and on Enter, so older prompts match too. `[` `]` one host (`hosts: [name]`), then every
host. `j` past the last row reads the next page (`before`: the last id). Enter opens the session (its strip when the
board has it, else a session view by id on its host); `y` copies the text with OSC 52 (inside tmux wrapped in its DCS
passthrough, which needs `allow-passthrough on`, and sent bare too for `set-clipboard on`); `l` opens a launch
prompt with the text to confirm or edit, Tab picks the host, Ctrl-E the engine, Enter calls `launch.start {engine,
mode: "tmux", prompt, cwd, host}`. A `mutation` or `turn` event reads the newest page again, at most every 5 s, only
while the view is shown; the selected prompt stays selected.

### Wall

A grid of live mini terminals, one per strip, waiting first and then by name. A tile is a border in its lane's colour
(heavy when selected; a waiting tile's border alternates bright and dim at 2 Hz while the Wall is in front) around a
header (lane dot, name, host, age) and the bottom of its pane in colour: `tmux.captureMany` with escapes, parsed by
`ui/ansi.js` into styled segments (no escape from a pane reaches the terminal) and cut by display width. Only the
tiles on screen are captured, one call per host per refresh, every 2 s (every second zoomed), and nothing while
another view is in front. A failed capture keeps the last one, marked stale. A strip with no pane shows its own last
lines. The grid fits every tile when tiles stay at least 18x4, else the densest grid that does; `+`/`-` step from 1x1
to 6x5; the wheel scrolls rows of tiles.

## Keys

| Where | Keys |
|---|---|
| Everywhere | `1`-`7` a workspace when no text box is focused; `<` `>` (or Shift-Left/Right) the workspace's sub-views; Tab / Shift-Tab next and previous workspace (in a session: its tabs); `:` or Ctrl-P the command palette (every workspace and sub-view, "Agents › Wall", found by its old names too); `?` or F1 help, grouped by workspace; Esc back; `q` quit (hide, in a popup); Ctrl-C clears a text box, else quits; Ctrl-L redraws; Ctrl-Z suspends |
| Manager composer | Enter sends; Ctrl-J or Alt-Enter new line; Up/Down rows, then history; Ctrl-A/E/U/W/K, Alt-B/F; paste keeps newlines; PgUp/PgDn scroll; Tab completes a slash command; Esc leaves it |
| Manager, Esc pressed | `i` or Enter types again, `j`/`k` scroll, `w` selects what waits on you: left and right choose, digits, Enter, Esc and y/n press that dialog's keys, `o` opens it, `r` replies |
| Agents › Lanes | `j`/`k` select; on a waiting strip selected here, digits, Enter and Esc answer it (a strip carried from another view: Enter picks it here first); Enter or `o` opens; `r` replies with a message; `/` filters |
| Agents › Wall | arrows or `h` `j` `k` `l` move; `+` `-` density; `z` or a second click zooms the tile to the whole view, Esc unzooms; Enter or `o` opens; `r` replies; `R` refreshes |
| Prompts | `/` words (the daemon matches them); Enter or `o` opens the session; `y` copies; `l` launches a new agent with the prompt; `v` Mine / All; `[` `]` host; `j` past the end reads older ones |
| Session | Tab cycles Chat, Screen, Info; `j`/`k` select, Enter expands a tool group (again: all output); `a` jumps to the answer card, whose keys answer; `r` or `i` types; `t` or Ctrl-T sends to the inbox or the pane; `K` then a key sends that key to the pane; `F` forces a paste a dialog refused |
| Mouse | a click on a workspace tab goes there (" drover " opens the palette, the waiting count Agents › Lanes), on a sub-tab to that sub-view; on a key hint in the bottom bar presses that key (not a range like `j/k` or `1-7`); on a row, a strip, a tile, a chat item or Chat/Screen/Info selects it, a second click opens it (Enter; on a tile: zooms); on a composer types there, the cursor where you clicked; on a palette entry runs it, outside the palette or help closes it. The wheel scrolls. Shift-drag still selects text in most terminals; `--no-mouse`, `DROVER_TUI_MOUSE=0` or the palette's "Mouse: off" leave the mouse to the terminal |
| Hover | with the mouse on, the row, strip, tile, tab, sub-tab, key hint or palette entry under the pointer is drawn on a light tint (style `hover`, underlined with no colour or 16 colours), and the bottom bar previews it on the right while no toast is up (a prompt's text, a strip's or tile's last line, an event's summary). Hover is information, a click is action: it never selects, so it can never arm an answer key |

Slash commands in the manager: `/thread <name>`, `/threads`, `/look [target]`, `/sweep`, `/status`, `/board`,
`/help`, `/quit`.

Answer keys act only on what you selected: Lanes arms only a strip selected there, and that starts empty every time
it is shown (an agent selected in List, Windows, Wall or Space is shown but arms nothing), the manager needs `w`, a
session needs the card selected. A digit pressed to switch views can never approve or deny a prompt.
The mouse keeps both: the wheel scrolls without selecting anything, and a click on a dialog's option or key
answers only on a second click, once the first has picked the strip, through the same guard as the key.
A selection is held by the strip's key, never by its position (lanes re-sort on every board event), and goes away
with the strip: nothing is then pressed, for it or for any other. A press acts on the strip exactly as the last
frame drew it and carries that frame's screen hash, so a dialog that changed in between is refused by the daemon
(the refusal and its reason show in the footer and the board refreshes). A session view finds its strip on its own
host only, by the session first and by its window second.

## Layout

| File | What |
|---|---|
| `main.js` | flags, the daemon target, the terminal, the app |
| `app.js` | the connection (ops, SSE with topics `board,alerts,turn,manager,mutation`), capabilities learned from "unknown op", the shared board and agent selection, key routing, the tab bar, the sub-tab row and the footer, hover, overlays, popup-aware hide and quit |
| `workspaces.js` | the seven workspaces and their sub-views, the alias table, where a plugin's table goes |
| `term.js` | raw mode, the alternate screen, bracketed paste, no autowrap, the mouse (SGR, modes 1000, 1003 and 1006: clicks, the wheel and motion), OSC 52, resize, suspend, a restore on every exit path |
| `keys.js` | the streaming key decoder (CSI, SS3, xterm modifiers, CSI u, Alt, bracketed paste, SGR mouse reports including motion, sequences split across reads; a lone ESC is final after 40 ms) |
| `width.js` | display width per grapheme cluster (CJK, emoji, ZWJ, flags, VS16, combining marks), truncate, fit, wrap, sanitize |
| `style.js`, `screen.js` | named styles at the terminal's depth (truecolor, 256, 16, none with NO_COLOR); frames rendered to the exact width, written as one synchronized update of the rows that changed |
| `client.js`, `sse.js` | node:http client for ops and the stream; the token only in the Authorization header |
| `chat.js`, `markdown.js` | the shared chat rendering rule: tool groups by verb with summaries and results, Markdown text, senders, the answer card |
| `convo.js` | one manager thread merged from the echo, the async answer, the stream and the turn events, each turn once |
| `board.js` | strips, lanes, `stripKey` and `stripFor` (a session or window to its strip), the keys a dialog takes, the answer plan and its fallback |
| `composer.js` | the multi-line editor |
| `popup.js` | `drover manager popup` and `keys` |
| `views/` | manager, board (Lanes), session, the generic table and the table definitions, prompts, wall, space, overlays |
| `test-support/` | a fake daemon and private tmux servers for the end-to-end tests |

Startup: the first frame is drawn before anything is asked of the daemon, about 60 to 120 ms after launch; data
fills in as it arrives. History stays bounded however long a view runs: a session view keeps the newest turns (what it
asked for plus 500), the manager the newest 400 (never a reply in flight), and neither trims while you are scrolled
up reading. Redraws are coalesced to at most one per 16 ms, and only changed rows are written, so a
streaming reply costs a row or two per delta. Text from transcripts and panes is sanitized before it is drawn: no
escape sequence or control character from data reaches the terminal.

## Chat text

`chat.js` and `markdown.js` turn a transcript into rows no wider than the screen: paragraphs (a source line break stays a line break), headings, lists, quotes, fenced code, and inline code, bold, italic, strikethrough and links.

A pipe table is a header row directly over a delimiter row (`| --- | :---: | ---: |`), then the body lines that contain a pipe. It is drawn in a box: bold headers, the delimiter row's alignment, inline Markdown inside the cells. An escaped pipe (`\|`) and a pipe inside a code span stay in their cell. A short row is padded out to the header's column count. When the table is wider than the screen, the widest columns narrow to one shared cap and their cells wrap, with a rule between rows that took more than one line. When the screen is too narrow to box without breaking a word (a column narrower than its longest word, and that length is counted at most 12), each row is drawn as `header: value` lines instead. A pipe line that is not part of such a table is drawn as text. A delimiter-shaped line on its own becomes a line of `┼`, which is what a real table's delimiter row used to do before it was recognized.

## Older daemons

A daemon from before the UX overhaul still works: `native.board` "unknown op" switches the board to `fleet.summary`
(and the stream to the `fleet` event), `sessions.answer` falls back to `tmux.answer` on the strip's window, and a
manager message that comes back with `reply` (the old blocking call) lands in place of a "waiting for the reply"
line. Threads need a current daemon (an old one answers on main). Without `tmux.captureMany` the Wall asks
`tmux.capture` once per visible tile (plain text, and it says so); without `prompts.list` Prompts says the daemon
predates the prompt spool.

## The popup

`drover manager popup` runs `tmux display-popup -E` on the client (with `-s` and `-S` set to the colour `terminal`
on tmux 3.3 and later: tmux 3.8 greys a popup by default, and `default` in a style inherits that grey), with a
nested tmux client inside attached to a
persistent session (`env -u TMUX tmux -S <socket> new-session -A -s drover-manager ...`), so the same manager, with
its scrollback and draft, shows over every window. The session is created first, detached, at the popup's size,
with `status off`, `DROVER_TUI_POPUP` and `DROVER_TUI_SESSION` in its environment (so `q` hides instead of
quitting), and `@drover-from` set to the window it was opened from at every open (what `/look` captures).
`--independent` uses thread `win-<window id>` and session `drover-manager-win-<n>-<hash>`; `--fresh` runs the TUI
straight in the popup. Invoked from inside a manager session it detaches instead, so one binding toggles. A thread
name tmux takes as it is keeps its session name; one that had to change carries a hash of the exact name, so two
threads never share a session, and each session records its thread (`@drover-thread`): a popup refuses to attach to
a session that holds another thread (or, for a thread other than main, one from before the mark).

tmux 3.7c expands no formats in display-popup's command or its `-e` values, so the command resolves the client,
pane, window and socket itself and passes literals; the binding's `run-shell` expands `#{client_name}` and
`#{pane_id}`. display-popup blocks until the popup closes, so it is started detached and only an early failure is
reported. Exact targets: `=name` for session targets, `=name:` for set-option and show-options (a plain name is a
prefix match there and can land on another session).

`drover manager keys --install` writes `~/.config/drover/manager.tmux.conf` and source-files it into the running
server. It never edits `~/.tmux.conf`; to keep the binding, add `source-file -q ~/.config/drover/manager.tmux.conf`
to your `~/.tmux.conf`. The defaults are `prefix + g` (shared) and `prefix + G` (this window's
own); stock tmux leaves G free, and binds g only from 3.8 on (its floating-pane move menu, a default `--install` replaces). It replaces tmux's own default for a key but refuses a binding someone chose unless
`--force`, and names free keys.

## The view interface

What every view (and the coordinator's `views/space.js`) implements, and what the App gives it.

| A view has | |
|---|---|
| `constructor(app)` | `id`, `title` |
| `show({ back })`, `hide()` | shown in front (`back`: coming back from a session it opened), sent away; stop timers in `hide` |
| `render(width, height)` | exactly `height` rows (`ui.js` `block`); a row is a string, `[[text, style, bg?], ...]` or `{ segs, bg }`; a style is a name from `style.js` `THEME` or an object `{ fg, bg, bold, dim, italic, underline, reverse }` with colours as `#rrggbb` (any depth: the screen maps them to 256, 16 or none) |
| `key(ev)` | true when it took the key (else the App's keys run: digits, `<` `>`, Tab, Esc, `q`) |
| `mouse(ev)` | `ev` is `{ kind, button, x, y, shift, alt, ctrl, wheel? }` with `y` counted from the view's first row; `kind` is `down`, `up`, `drag` (a button held), `wheel` or `move` (no button: mode 1003). For `move` return true only when what is hovered changed (motion comes hundreds of times a second; true redraws, false draws nothing); a move never selects |
| `hints()` | the bottom bar's `[text, style]` segments (`ui.js` `hints`) |
| optional | `hoverPreview()` the one line the bottom bar shows for what is hovered; `cursor()`; `inputActive`; `clearInput()`; `onEvent(type, data)` stream events; `onBoard()` a new board; `onSelect(key)` the agent selection changed; `setMode(mode)` a sub-view with a mode (Prompts Mine/All); `onFrame(now)` before an animation frame |

| The App gives | |
|---|---|
| `app.board` | `{ strips, hosts, totals, manager, loading, error }`: strips in board order (`board.js` `boardOrder`), hosts as `{ name, up, waiting, working, idle, error? }` |
| `app.agentSel`, `app.selectAgent(key)`, `app.selectedStrip()` | the selected agent's strip key (`board.js` `stripKey(strip)`) or null; select one (or none) everywhere; its strip as the board has it now |
| `app.hostLabel(host)`, `app.frontHost` | a strip's host as a person reads it ('local' is this machine's name) |
| `app.invalidate()` | ask for a frame (coalesced: at most one per 16 ms, only changed rows are written) |
| `app.animate(view, fps)` | frames while the view is in front (`view.onFrame?.(now)` then a redraw), `0` stops; the timer skips frames while another view is in front |
| `app.hover` | `{ x, y }` screen position of the pointer (the bars use it as they draw) |
| `app.openStrip(strip)`, `app.openSession(target)`, `app.replyTo(strip)`, `app.answer(strip, key)` | the session view, a reply prompt, a guarded dialog key |
| `app.go(id)`, `app.where()`, `app.copy(text)`, `app.toast(text, style, ms)`, `app.client.call(op, args)` | show a workspace or sub-view by any name; `"agents/wall"`; OSC 52; the footer toast; an op |

## Tests

```
cd web && node --test test/tui-*.test.js
```

Pure: width, keys, rendering and the differ, the chat rule and Markdown, the board and answer keys, the manager
stream merge, the composer, the client and SSE parser, the popup plan and the bindings, the mouse in every view
(`tui-mouse.test.js`), hover (`tui-hover.test.js`), the workspaces, aliases and the shared selection
(`tui-workspaces.test.js`), Prompts and the Wall against the fake daemon (`tui-prompts.test.js`, `tui-wall.test.js`).
End to end
(`tui-e2e.test.js`, `tui-popup.test.js`): the real TUI at 160x45 in a private tmux server (its own socket
directory, `-f /dev/null`, a scratch HOME) against the fake daemon in `test-support/`; the popup with nested
private servers, an outer pane holding a client of the inner one. Mouse reports go in as the bytes a terminal sends
(`send-keys -H`; motion as the SGR any-motion report `\x1b[<35;x;yM`): into the TUI's pane directly, and for the popup into the outer pane, so the inner server takes them
as its client's mouse and passes them through the popup to the TUI. Nothing in them reaches the user's tmux server
or a real daemon. `node web/tui/test-support/fake-daemon.js --state DIR [--old]` serves the same synthetic world
for trying the TUI by hand (`DROVER_STATE=DIR drover tui`).
