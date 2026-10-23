# drover tui

The terminal client for Drover: talk to the fleet manager first, and see in the terminal what the web UI shows.
Zero dependencies, Node 24, ESM, like the rest of `web/`. Contract: `docs/specs/2026-10-20-ux-overhaul.md`.

```
drover tui [--manager] [--thread T] [--from TARGET] [--url URL] [--view NAME]
drover manager popup [--independent | --thread T] [--fresh] [--width 85%] [--height 80%] [--client C]
drover manager keys [--install] [--key M] [--independent-key N] [--force]
```

## Views

| Key | View | Reads |
|---|---|---|
| 1 | Manager (the default) | `sessions.transcript {id: "manager", thread}`, `manager` and `turn` events; sends `sessions.message {id: "manager", text, wait: false, thread}` |
| 2 | Board | `native.board` and `board` events (`fleet.summary` and `fleet` events on an older daemon); answers with `sessions.answer {id, key, expect}` (`tmux.answer` on an older daemon) |
| 3 | Sessions (per host) | `sessions.list` |
| 4 | Tmux (per host) | `tmux.windows {classify: true}` |
| 5 | Events | `events.tail`, refreshed after `mutation` events |
| 6 | Features | `events.state` |
| 7 | Fleet | `host.list`, the board's host counts, `host.facts` for the selected host, `host.probe` on `p` |
| 8 | Search | `search.fleet` (`/` types the query) |
| 9 | Memory | `reflections.list` (every repo when no `DROVER_DEFAULT_REPO` is set) |
| 0 | Stacks | `docker.fleet` |
| Tab | Launch, Settings, and plugin tables | `launch.profiles` (read-only), `settings.get` (read-only); a plugin's table sits after the view it names as `after` (a digit while it is among the first ten) |
| | Session (Enter on a strip, session or window) | `sessions.get`, `sessions.transcript` with `since` every 3 s plus `turn` events (after `/api/follow`), `tmux.capture` every 1.5 s on Screen |

Every table: `j`/`k`, PgUp/PgDn, `/` filter, Enter (open, or details), `R` refresh, and `[` `]` change the host
for Sessions and Tmux. The detail pane sits beside the table at 120 columns and more, under it otherwise.

## Keys

| Where | Keys |
|---|---|
| Everywhere | digits switch views when no text box is focused; Tab / Shift-Tab next and previous view (in a session: its tabs); `:` or Ctrl-P the command palette; `?` or F1 help; Esc back; `q` quit (hide, in a popup); Ctrl-C clears a text box, else quits; Ctrl-L redraws; Ctrl-Z suspends |
| Manager composer | Enter sends; Ctrl-J or Alt-Enter new line; Up/Down rows, then history; Ctrl-A/E/U/W/K, Alt-B/F; paste keeps newlines; PgUp/PgDn scroll; Tab completes a slash command; Esc leaves it |
| Manager, Esc pressed | `i` or Enter types again, `j`/`k` scroll, `w` selects what waits on you: left and right choose, digits, Enter, Esc and y/n press that dialog's keys, `o` opens it, `r` replies |
| Board | `j`/`k` select; on a selected waiting strip digits, Enter and Esc answer it; Enter or `o` opens; `r` replies with a message; `/` filters |
| Session | Tab cycles Chat, Screen, Info; `j`/`k` select, Enter expands a tool group (again: all output); `a` jumps to the answer card, whose keys answer; `r` or `i` types; `t` or Ctrl-T sends to the inbox or the pane; `K` then a key sends that key to the pane; `F` forces a paste a dialog refused |

Slash commands in the manager: `/thread <name>`, `/threads`, `/look [target]`, `/sweep`, `/status`, `/board`,
`/help`, `/quit`.

Answer keys act only on what you selected: the board's selection starts empty every time it is shown, the manager
needs `w`, a session needs the card selected. A digit pressed to switch views can never approve or deny a prompt.
A selection is held by the strip's key, never by its position (lanes re-sort on every board event), and goes away
with the strip: nothing is then pressed, for it or for any other. A press acts on the strip exactly as the last
frame drew it and carries that frame's screen hash, so a dialog that changed in between is refused by the daemon
(the refusal and its reason show in the footer and the board refreshes). A session view finds its strip on its own
host only, by the session first and by its window second.

## Layout

| File | What |
|---|---|
| `main.js` | flags, the daemon target, the terminal, the app |
| `app.js` | the connection (ops, SSE with topics `board,alerts,turn,manager,mutation`), capabilities learned from "unknown op", the shared board, key routing, tab bar and footer, overlays, popup-aware hide and quit |
| `term.js` | raw mode, the alternate screen, bracketed paste, no autowrap, resize, suspend, a restore on every exit path |
| `keys.js` | the streaming key decoder (CSI, SS3, xterm modifiers, CSI u, Alt, bracketed paste, sequences split across reads; a lone ESC is final after 40 ms) |
| `width.js` | display width per grapheme cluster (CJK, emoji, ZWJ, flags, VS16, combining marks), truncate, fit, wrap, sanitize |
| `style.js`, `screen.js` | named styles at the terminal's depth (truecolor, 256, 16, none with NO_COLOR); frames rendered to the exact width, written as one synchronized update of the rows that changed |
| `client.js`, `sse.js` | node:http client for ops and the stream; the token only in the Authorization header |
| `chat.js`, `markdown.js` | the shared chat rendering rule: tool groups by verb with summaries and results, Markdown text, senders, the answer card |
| `convo.js` | one manager thread merged from the echo, the async answer, the stream and the turn events, each turn once |
| `board.js` | strips, lanes, the keys a dialog takes, the answer plan and its fallback |
| `composer.js` | the multi-line editor |
| `popup.js` | `drover manager popup` and `keys` |
| `views/` | manager, board, session, the generic table and the table definitions, overlays |
| `test-support/` | a fake daemon and private tmux servers for the end-to-end tests |

Startup: the first frame is drawn before anything is asked of the daemon, about 60 to 120 ms after launch; data
fills in as it arrives. History stays bounded however long a view runs: a session view keeps the newest turns (what it
asked for plus 500), the manager the newest 400 (never a reply in flight), and neither trims while you are scrolled
up reading. Redraws are coalesced to at most one per 16 ms, and only changed rows are written, so a
streaming reply costs a row or two per delta. Text from transcripts and panes is sanitized before it is drawn: no
escape sequence or control character from data reaches the terminal.

## Older daemons

A daemon from before the UX overhaul still works: `native.board` "unknown op" switches the board to `fleet.summary`
(and the stream to the `fleet` event), `sessions.answer` falls back to `tmux.answer` on the strip's window, and a
manager message that comes back with `reply` (the old blocking call) lands in place of a "waiting for the reply"
line. Threads need a current daemon (an old one answers on main).

## The popup

`drover manager popup` runs `tmux display-popup -E` on the client, with a nested tmux client inside attached to a
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
own), which stock tmux leaves free. It replaces tmux's own default for a key but refuses a binding someone chose unless
`--force`, and names free keys.

## Tests

```
cd web && node --test test/tui-*.test.js
```

Pure: width, keys, rendering and the differ, the chat rule and Markdown, the board and answer keys, the manager
stream merge, the composer, the client and SSE parser, the popup plan and the bindings. End to end
(`tui-e2e.test.js`, `tui-popup.test.js`): the real TUI at 160x45 in a private tmux server (its own socket
directory, `-f /dev/null`, a scratch HOME) against the fake daemon in `test-support/`; the popup with nested
private servers, an outer pane holding a client of the inner one. Nothing in them reaches the user's tmux server
or a real daemon. `node web/tui/test-support/fake-daemon.js --state DIR [--old]` serves the same synthetic world
for trying the TUI by hand (`DROVER_STATE=DIR drover tui`).
