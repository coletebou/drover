# Drover menu bar (macOS 14+)

A lightweight `LSUIElement` app (`dev.drover.menubar`) with a `MenuBarExtra` in window style.

- **Icon**: the waiting count, coloured amber when something waits on you and brick when offline or
  the token is rejected. Idle and working stay monochrome like other menu bar icons.
- **Popover**: the manager first, then "Waiting on you", the working count with a list, host health dots,
  quick actions (Mute 1h, Dashboard), Settings and Quit.
  - **Manager box** (above the list, always in view): "Ask the manager" (Enter sends `sessions.message
    {id: "manager", text, wait: false}`), the last exchange with the reply streaming in from SSE `manager`
    events and settled by `turn` events (a transcript read takes over when no stream delivers), a busy line,
    quick prompts (Who is waiting on me?, What finished?, Sweep now through `openclaw.sweep`) and Open
    manager (`drover://manager` in the Drover app, else the web UI's `#/manager`). Without a running
    manager it says so.
  - **Waiting rows**: the dialog's question and one button per key the daemon lists in `keys` (each option
    as "1 Yes", "2 Yes, don't ask again", "3 No", the full label in the tooltip, the highlighted option
    marked, then Enter and Esc), pressed with `sessions.answer {id, host, key, expect: hash}`. A refusal
    shows its reason and the board refreshes; after a press the row holds its buttons back until the screen
    moves on. A question asked in text (`answer: "reply"`) keeps Reply. A daemon without the fields gets Open
    and Reply only: no fixed 1/2/y/n chips (Claude Code dialogs ignore y and n since 2.1.280).
  - **Open** sends one deep link per click (a second identical open within a second is dropped).
- **Data**: polls `native.summary` with the widget token (15 to 900 s, default 60). With the main token it
  also holds SSE on `/api/stream?topics=summary,alerts,manager,turn`: a `summary` event is the board and is
  applied as is (no re-fetch), and a poll tick right after one is skipped, so the poll is the fallback while
  the stream is down or quiet. A daemon that ignores topics (no `topics` in `hello`) gets the old rule:
  refresh, debounced 2 s, on `mutation`, `notify`, `alerts`, `fleet` and `snapshot`. Alerts come from a
  `native.notifications` long poll (`wait: 25`).
- **Notifications**: needs-you, finished and error alerts as macOS notifications with Reply and Open
  actions. A dialog alert that carries `keys` and `hash` also gets one action per option (or Approve
  (Enter) and Deny (Esc), Deliver and Drop for a held peer message), answered with `sessions.answer` and
  the alert's hash; never for an alert from another server. Open does not bring the menu bar app forward.
  More than three at once collapse into a summary. Mute 1h mutes every daemon alert category
  (`notify.mute`) and silences local notifications too.
- **Settings**: server address, main and widget tokens (Keychain, shared access group), open at login
  (`SMAppService.mainApp`), poll interval, where sessions open (the Drover app, else the web UI), the global
  shortcut (default Control-Option-A, Carbon `RegisterEventHotKey`, no Accessibility permission).
- **Widgets**: every changed summary is written to `<group.dev.drover>/summary.json` and widgets are
  reloaded (at most once a minute), per CONTRACT.md "Widget data handoff". The base URL is mirrored to
  the App Group defaults key `drover.baseURL`.

## Layout

| path | what |
|---|---|
| `Sources/MenuBarCore/` | Pure logic, Foundation only: models, `DroverClient`, `SSEParser`, `EventStream`, `MenuBarStore`, `SummaryCache`, preferences, Keychain tokens, `KeyCombo` formatting, `NotificationPlanner`, `AnswerModel` (dialog keys as buttons), `ManagerChat` (the streamed manager exchange) |
| `App/` | SwiftUI and AppKit: app entry and wiring, popover (`ManagerBox`, `WaitingRow`), settings, login item, hotkey, notifications; `App/Dev/` is compiled only into dev builds |
| `tools/` | `build-app.sh` (dev build), `snapshot.sh` (offscreen popover PNGs on synthetic data) |
| `Tests/MenuBarCoreTests/` | Swift Testing suites; `SharedFixturesTests` decodes the repo-wide `Fixtures/` when present |
| `Package.swift` | SwiftPM package for the tests only |
| `project.part.yml` | XcodeGen target `DroverMenuBar` and scheme (tests run the package's test target) |

`Sources/MenuBarCore` is compiled straight into the app target, so app files never `import MenuBarCore`.

## Build and test

```sh
cd Apps/MenuBar && swift test                 # logic tests, works with CommandLineTools only
script/typecheck.sh macos Apps/MenuBar/Sources Apps/MenuBar/App   # from the repo root
xcodegen generate && xcodebuild -scheme DroverMenuBar -destination 'platform=macOS' build   # needs Xcode's license
```

With the Command Line Tools toolchain, `swift test` sometimes fails with `plugin for module
'TestingMacros' not found`, and that message can hide a real compile error. Use a fresh scratch path to
see the truth: `swift test -j 1 --scratch-path "$(mktemp -d)"`.

Opt-in wire check against a running daemon (read-only widget token; prints only counts):
`DROVER_LIVE_URL=http://127.0.0.1:7337 DROVER_LIVE_WIDGET_TOKEN_FILE=~/.local/state/drover/widget-token swift test --filter LiveDaemon`.

Full compile and link without Xcode's license (what CI's xcodebuild would do, minus the bundle):
`swiftc -parse-as-library -swift-version 6 -sdk /Library/Developer/CommandLineTools/SDKs/MacOSX.sdk
-target arm64-apple-macos14.0 -plugin-path /Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/usr/lib/swift/host/plugins
-module-name DroverMenuBar -o /tmp/DroverMenuBar $(find App Sources -name '*.swift')`.

Offscreen pictures of the popover on synthetic data (light and dark, every state: dialog, manager streaming,
sent, refused, older daemon, widget token only, offline): `tools/snapshot.sh /tmp/snaps`.

A runnable dev build without Xcode's license: `tools/build-app.sh` makes `.build/dev/DroverMenuBarDev.app`
(bundle id `dev.drover.menubar.dev`, no URL types, ad hoc signed, never copied into an Applications folder),
compiled with `-D DROVER_DEV` (`App/Dev/DevSupport.swift`): tokens from the daemon's state folder, the server
from `DROVER_URL`, its own defaults, no App Group writes, no shortcut, no notifications
(`DROVER_DEV_NOTIFICATIONS=1`), no menu bar item (`DROVER_DEV_MENUBAR=1`), and Open only logs
(`DROVER_DEV_OPEN=1`). `DROVER_DEV_SCRIPT` runs the popover's own store calls and renders the live popover
offscreen to `DROVER_DEV_SNAPSHOT`; it refuses keys, messages and sweeps against the live daemon on 7337:

```sh
app=$(tools/build-app.sh)
DROVER_URL=http://127.0.0.1:7338 DROVER_DEV_SNAPSHOT=/tmp/mb \
  DROVER_DEV_SCRIPT='waitdialog:20;snap:start;answer:1#demo-build;snap:after;ask:slow hello;wait:2;snap:streaming;waitreply:20;notify:1;open:manager;quit' \
  "$app/Contents/MacOS/DroverMenuBarDev"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u "$app"
```

Steps: `snap:<name>`, `answer:<key>[@<row>|#<name>]`, `ask:<text>`, `sweep`, `notify:<key>[+<s>]` (an alert raised at
least `<s>` seconds after the step starts, pressed through the notification action path, then the session's reply),
`open:manager|row` (two clicks, logs the deep links), `wait:<s>`, `waitreply:<s>`, `waitdialog:<s>`, `log`, `quit`. Run it against the dev world (`node web/test/devworld.js --port 7338 --gateway 18799`).

Signing: set `DEVELOPMENT_TEAM`. The App Group, Keychain access group and time-sensitive notification
entitlements need a provisioning profile; unsigned builds fall back to a keychain without the shared group
and skip the widget cache.

## DroverKit

This app does not depend on DroverKit yet: it was written while DroverKit was being built. `DroverClient`,
`EventStream` and the models here follow the same CONTRACT.md and decode the shared `Fixtures/`. Moving
to DroverKit later means replacing `Sources/MenuBarCore/Data/DroverClient.swift`, `EventStream.swift` and
`Models.swift` with thin adapters; `MenuBarStore`'s surface stays the same.
