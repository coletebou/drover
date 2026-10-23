# Drover for macOS (Apps/macOS)

SwiftUI, macOS 14+. Three columns like the web board: sidebar (the manager, views, hosts), board (Waiting on you /
Working / Idle), detail (Chat, Screen, Info, or the manager). Talks to the Drover daemon over HTTP + SSE
(`CONTRACT.md`, `docs/specs/2026-10-20-ux-overhaul.md`).

Layout
- `Sources/App`: the scene (one `Window`), `AppDelegate` (URLs, reopen), `WindowRouter` (the main window and the
  manager panel), `AppRoute` (what a `drover://` URL asks for), `DevHooks` (dev build only).
- `Sources/Core`: models, the `DroverService` seam (`LiveDroverService` HTTP client and `SSEConnection`,
  `MockDroverService` synthetic data), `AppModel` (all UI state), decoders (`BoardDecoder` for `native.board`,
  `BoardBuilder` for older daemons, `TranscriptMapper`), `DialogKeys` and `ScreenDialog`, settings, Keychain, widgets.
- `Sources/Board`, `Sources/Chat`, `Sources/Manager`, `Sources/Settings` + `Sources/Notifications`, `Sources/Palette`.
- `Sources/Theme`: tokens copied from the web UI's `style.css` (WCAG AA).

One window. The main scene is a `Window`, and `drover://` URLs (menu bar Open, widgets, the Safari extension) arrive
through the app's own `kAEGetURL` handler, so SwiftUI never opens a window for one: `WindowRouter` brings the one
window forward, or reopens it when it was closed. Notification taps route the same way, without a URL. Closing the
window leaves the app running (alerts, the manager panel); a Dock click or any URL brings it back.

Board. `native.board` (a few KB) and the SSE `board` event, subscribed with
`GET /api/stream?topics=board,alerts,turn,manager,mutation,settings`; a board event is applied as it is, and a board
with the same content (a new `generatedAt` only) changes nothing. A daemon that answers "unknown op native.board"
gets `fleet.summary` + `native.summary` (asked again every ten minutes). Requests and decoding are `@concurrent`, off
the main actor; the stream is read in chunks on its own queue, and the data of events the app never reads (an older
daemon's 1.3 MB `fleet`) is dropped undecoded. Lanes follow the web UI (`ui/lanes.js`): a `blocked` status alone is
not waiting.

Chat (the spec's "Chat rendering"): runs of tool-only turns are one row ("Ran 3 commands, read 2 files"), expandable
to each call's summary with its result (attached by call id) under it, errors marked; a run still going shows its
latest calls. Assistant text is Markdown (paragraphs, lists, headings, fenced code, inline code, bold, links); blank
text and thinking are hidden, a "Working" line shows while the session works. While a chat is open the daemon follows
its transcript (`POST /api/follow`) and `turn` events land at once; an incremental read closes the gap and runs on
reconnect. A session the daemon cannot follow is read every 4 s while it works, never while idle. The chat follows
new rows only while you are at the bottom. The last six chats stay in memory, at most 1000 turns each.

Dialogs. A session waiting on a dialog shows its question and one button per key it takes (options by number and
label, the highlighted one marked, Enter, Esc; y and n only when the prompt takes them): a card at the bottom of
Chat, a bar on Screen, buttons on its board row, the composer's key row, the Session menu and the palette. One click
presses that key: `sessions.answer {id, host, key, expect: hash}` (`tmux.answer` on daemons without it). The card
follows the screen, not the board (`Core/LiveDialogs.swift`): after a press the pane is read again at once until it
moved on (the next question, AskUserQuestion's review screen, nothing), it is read every 2 s while the session waits,
and Screen's captures feed the same reading; those readings win over the board until it agrees. A refusal shows the
dialog it carries. "Type something" opens a field for the text once its press took (`FreeTextField`); a reading that
shows another question, a held message or no dialog closes it. The text is pasted past the daemon's dialog guard
and ends with Enter, so it goes only after a fresh read shows that question with its field highlighted: never into
another dialog, a fresh drawing of the same question, a prompt or a shell. Readings follow the daemon's
classification and its rules (same hash, the screen is what is lowest, a dialog drawn twice lists its latest
drawing), in time linear in the capture's length (a capture joins wrapped lines, so one line can be 100K blanks).

Screen: an NSTextView (monospaced, no wrapping unless Wrap is on, horizontal scroll), captured every 1.5 s while the
window is on screen, keeping your scroll position unless you are at the bottom.

Manager: first in the sidebar, a full chat in the detail column, and a floating panel over every app and Space
(Shift Command M, View > Manager panel, `drover://manager`; `drover://manager?in=window` opens it in the main
window). Messages go with `wait: false` and the reply streams in; threads (`openclaw.threads`, `main` is shared by
every client), quick prompts, Sweep now. A daemon that answers inline (no `pending`) works too; manager requests
have no 40 s idle timeout, so another server (Settings' Apply, a pairing) starts the conversation over and drops
whatever the last one still answers (`ManagerModel.reset`, `AppModel.generation`). A conversation keeps its newest
500 turns, as many as a read brings, however long the app runs.

Notifications: dialog alerts carry one action per key (the options, or Approve and Deny, Deliver and Drop for a held
message) that call `sessions.answer` with the alert's hash, plus Reply and Open. A tap opens the session in the one
window. Replies and answers go to the alert's host as the board names it (`AppModel.opHost`): the daemon's own name
is local, and a machine name the board does not know goes by the session's board entry only when its id names one
session fleet-wide, never by the manager's id or a window's target, which every machine can have.

Pairing: with no main token and the default loopback URL, the app asks the daemon to pair at launch and the board's
empty state shows the 6-digit code; Settings > Connection has Pair with this daemon for any URL. Approve the code
on the Mac (`drover pair approve <code>` or Approve in the browser UI) and both tokens land in the Keychain items
Save token uses, the URL is mirrored to the App Group, and the connection is applied (`AppModel.startPairing`).
A `drover://pair?url=` link (only an http(s) address with a host, no credentials, query or fragment) opens a sheet in
the main window that names the address (`PairLinkSheet`). Pairing again with the daemon in use starts at once; any
other address waits for a click on Pair with this daemon, which is not the default button (`PairLinkPolicy`). Until
that daemon approves the code nothing changes: no request with the stored token goes to it, and the server, the
Keychain tokens and the App Group copy stay as they are.

DroverKit: the app links it (`project.part.yml`) for pairing (`PairingController`, `PairingClient`); this app's own
types (`TokenStore`, `KeychainTokenStore`, `JSONValue`, `DroverError`...) shadow DroverKit's same-named ones in files
that import it. tools/*.sh build DroverKit as a static module first (`tools/env.sh`), so `script/typecheck.sh`, which
builds one module, no longer covers this app's sources.

Known differences from the web UI: tmux targets are window targets (`work:3`), as in the web UI's `windowTarget()`,
so in a split window the keys go to the active pane.

Without Xcode's license (this Mac):
- `tools/test.sh` runs the logic harness (`Tests/Harness`, no XCTest).
- `tools/snapshot.sh` renders views offscreen to PNGs in light and dark (`chat-tools`, `manager`, `manager-panel`,
  `pairing-*`...). The sidebar's material renders white inside the full window offscreen; `sidebar-*` shows it alone.
- `tools/build-app.sh` builds an unsandboxed, ad-hoc signed dev `.app` with swiftc and `-D DROVER_DEV`: bundle
  `dev.drover.macos.dev`, URL scheme `droverdev://` only (the build fails if the plist declares `drover`), the token
  from `~/.local/state/drover/token`, the server from `DROVER_URL` (default `http://127.0.0.1:7337`), no App Group,
  no widgets, no real notifications unless `DROVER_DEV_NOTIFY=1`, and no writes (messages, keys, answers) except to
  the test daemon on port 7338 or with `DROVER_DEV_ALLOW_WRITES=1`. `open <app> --args --mock` runs on synthetic data.
- `tools/dev-app.sh start [url] | open <droverdev://...> | windows | stop` drives it (stop also unregisters it from
  LaunchServices); `droverdev://debug/state|snapshot|select|answer|send|manager-send|panel|close-main|notification-tap|notify-check`
  are its test hooks (`Sources/App/DevHooks.swift`): they run the calls its buttons make, since SwiftUI builds no
  accessibility tree to press them through. `DROVER_DEV_NO_ACTIVATE=1` keeps it from taking focus. Any app or page
  can open those URLs, so `snapshot?path=` writes only a `.png` in an existing directory under the temp directory
  (default `/tmp/drover-dev-window.png`, `DevSnapshotPath`), replacing a link there rather than writing through it.
- `tools/verify-windows.sh` proves the one window: launch, repeated URLs, notification taps, the panel, close and
  reopen by URL and by a Dock-style reopen, counting the process's on-screen windows (`tools/window-count.swift`).
- `tools/bench.sh` times the board and SSE paths before and after on saved payloads (never commit those). On the
  2026-10-20 fleet (118 sessions, optimized build): decoding fleet.summary (1.3 MB) 41 ms with the old decoder, 12 ms
  with `JSONValue.parse`; a board refresh 42 ms (fleet.summary) against 5 ms (`native.board`, 57 KB); 46 s of an
  older daemon's stream (3.5 MB) 127 ms with the old per-byte reader against 12 ms.
- All of them take the SwiftUI macro plugins from the Xcode that `xcode-select -p` names (`tools/env.sh`).

With Xcode: `xcodegen generate` at the repo root, then build scheme `DroverMac`.
