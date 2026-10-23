---
name: drover-manager
description: Float Drover's fleet manager (the OpenClaw manager, session id "manager") over a tmux window as a popup TUI, shared by every window or independent for one, and talk to it from a terminal, a script or an agent. Use only when the user asks to see or talk to the manager in tmux: it opens on their screen. Triggers: "open the manager", "float the manager over this window", "manager popup", "talk to the manager in tmux", "independent manager for this window", "drover tui", "bind a key for the manager", "the manager popup does not open".
---

# Drover manager in tmux

`drover tui` is Drover's terminal client: the manager's conversation first (streamed replies, a composer,
what waits on the user at the top with the keys that answer it), then the board, any session's chat and screen, and
every table the web UI has. `drover manager popup` floats it over the current tmux window with
`tmux display-popup`. Code and keys: `web/tui/README.md` in the Drover checkout.

## When to use it

Only when the user asks. The popup opens on their screen, over the window they are looking at. Never open it to
talk to the manager yourself (use `drover_send`, below), never type into it or send it keys, and never answer a
dialog for the user through it.

## Commands

| Want | Run |
|---|---|
| The shared manager over this window (the same one on every window) | `drover manager popup` |
| This window's own manager conversation | `drover manager popup --independent` |
| A named conversation | `drover manager popup --thread <name>` |
| The TUI straight in the popup, nothing kept after it closes | `drover manager popup --fresh` |
| Size, or another client | `--width 85% --height 80%`, `--client /dev/ttys004` |
| What it would do, changing nothing | `drover manager popup --dry-run` |
| The full TUI in this terminal | `drover tui` (`--thread T`, `--view board`, `--url http://127.0.0.1:7338`) |

Run `drover manager popup` from a tmux pane (your Bash tool runs in the user's pane, so the popup opens on the client
showing it). It returns at once and the popup stays up; the user closes it with `q` (or `prefix + g`).

## Shared or independent

- Shared (default): a persistent tmux session `drover-manager` runs `drover tui --manager` on thread `main`, the
  conversation every client (web UI, Mac app, menu bar) shares. The popup attaches to it, so its scrollback and a
  half-typed draft are there on every window. `q` or Ctrl-C in it hides it (the session keeps running).
- Independent: thread `win-<window id>` (`win-@12`) in session `drover-manager-win-12-<hash>`: a separate gateway
  conversation for that window, as persistent as the shared one. `--thread <name>` does the same for any name
  (`[A-Za-z0-9_.:@%-]`, up to 64).
- Each open records the window it came from on the session (`@drover-from`). `/look` in the manager captures the
  last 60 lines of that window and sends them with the next message, naming the window.
- Pressed inside a manager session, the popup command detaches instead: one key opens and hides it.

## In the manager view

Enter sends, Ctrl-J or Alt-Enter adds a line, Up and Down recall history, PgUp and PgDn scroll. `/thread <name>`,
`/threads`, `/look [target]`, `/sweep`, `/status`, `/board`, `/help`. Esc leaves the composer; then `w` selects
what waits on the user (left and right choose, digits, Enter and Esc press that dialog's keys through
`sessions.answer`, guarded by the screen hash), digits switch views, `?` lists every key.

## Asking the manager from a script or an agent

Not through the popup. From an agent, the MCP tool:

    drover_send {"id": "manager", "text": "who is waiting on me?", "thread": "main"}

`thread` picks the conversation (omit for main). Read it back with `drover_session_transcript {"id":
"manager", "thread": "..."}`. From a script:

    drover op sessions.message '{"id":"manager","text":"what is devbox doing?","thread":"ops"}'

`drover op` waits for the reply and prints it. Through a daemon (`curl` to `/api/op/sessions.message`), `"wait":
false` answers at once with `{pending, event, turnId}` and the reply streams as `manager` SSE events. Say who you
are in the text; the truth file records the actor.

## Installing the binding

    drover manager keys              # print the tmux.conf snippet
    drover manager keys --install    # write ~/.config/drover/manager.tmux.conf and source-file it into this server

`prefix + g` toggles the shared manager, `prefix + G` opens this window's own (`--key K --independent-key K2`
picks others; `prefix + M`, the obvious key, is often taken, for example by a mouse toggle). `--install`
replaces a tmux default binding but refuses one somebody chose, unless `--force`, and names free keys.

It never edits `~/.tmux.conf` (it may be a link into a dotfiles repo). To keep the binding across tmux restarts,
the user adds `source-file -q ~/.config/drover/manager.tmux.conf` to their tmux.conf. Do not edit it unless they ask.

## Troubleshooting

- "not inside tmux": run it from a tmux pane, or pass `--client` (a name from `tmux list-clients`).
- The popup opens and closes at once: the TUI exited. `drover tui` in a terminal shows why (the daemon is down:
  `drover status`; the token: `~/.local/state/drover/token`).
- The tab bar names the daemon when it is not the local `127.0.0.1:7337`: check `--url` and `DROVER_STATE`.
- A stale manager session: `tmux kill-session -t =drover-manager` (`tmux ls` names the others); the next
  popup starts a fresh one. The conversation itself lives in the truth file, so nothing is lost.
- "tmux session drover-manager-... holds thread X, not Y": a manager session from another thread (or an older
  drover) has that name. End it as the message says; the next popup starts the right one.
- "is a symbolic link" from `keys --install`: the snippet is never written through a link; remove it or set
  XDG_CONFIG_HOME.
- The key does nothing: `tmux list-keys -T prefix | grep 'manager popup'`; reload with `drover manager keys --install`.
- `/look` finds no window: open the manager with the popup (it records the window), or `/look <session:window>`.
- A dialog answer says "refused": the screen changed since it was read; the board refreshes, read it again.
