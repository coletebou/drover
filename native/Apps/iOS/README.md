# Drover for iOS (Apps/iOS)

SwiftUI app for Drover, iOS 17+, iPhone first, iPad adaptive. Four tabs:

- **Board**: what is waiting on you, what is working, host health, manager health (from `native.summary`).
- **Sessions**: every session on every reachable host, grouped by host, with search and a state filter.
- **Manager**: chat with the OpenClaw fleet manager (`sessions.message id:"manager"`), its status, feed and "Sweep now".
- **Settings**: server address with Pair with Mac, main and widget tokens (Keychain), notification kinds, haptics.

Session detail (from Board or Sessions): chat transcript with incremental reads, a screen peek of the tmux pane,
a key buttons row (Enter, Esc, y, n, 1, 2, 3, arrows, Tab), a composer that sends to the session or types into the
pane, on-device voice dictation and image attach (photo library, paste, Files) through `uploads.put`.

## Layout

| path | what |
|---|---|
| `Sources/App` | `@main` app, tab shell, scene phase, background task hook, deep links |
| `Sources/Core` | models, `DroverAPI` protocol + `HTTPDroverAPI` (ops over `POST /api/op/<op>`, SSE on `/api/stream`), `TokenVault` (Keychain), `SharedSettings` (App Group defaults), `SummaryCache` (widget handoff), `AppModel`, theme, haptics, `MockDroverAPI` (synthetic previews) |
| `Sources/Board`, `Sources/Sessions` | board and sessions tabs |
| `Sources/Detail` | session detail: chat, screen peek, keys, composer, dictation, attachments |
| `Sources/Manager`, `Sources/Settings` | manager and settings tabs |
| `Sources/Background` | `BGAppRefreshTask`, local notifications from `native.notifications`, token sync to the watch |
| `Tests` | `run-logic-tests.sh`: platform-neutral logic compiled with plain `swiftc` and run on macOS |
| `project.part.yml` | XcodeGen target `DroveriOS`, included by the root `project.yml` |

`Sources/Core` mirrors the API shapes in CONTRACT.md and the daemon's real responses. When DroverKit
(`Packages/DroverKit`, window 00) is merged, its `DroverClient`, models and `KeychainTokenStore` can replace
`HTTPDroverAPI`, `Models.swift` and `TokenVault` behind the same `DroverAPI` protocol; views only see `DroverAPI` and `AppModel`.

## Shared data with widgets and the watch

- App Group `group.dev.drover`: `summary.json` (bare `native.summary` result, written atomically after every
  fetch, then `WidgetCenter.reloadAllTimelines()` when it changed) and `UserDefaults` key `drover.baseURL`.
- Keychain access group `$(AppIdentifierPrefix)dev.drover.shared`, service `dev.drover.token`, accounts
  `main` and `widget`. The group comes from the Info.plist key `DroverKeychainAccessGroup`, expanded at build time, so
  the team prefix is never hardcoded. Items use `AfterFirstUnlockThisDeviceOnly` so background refresh works while
  locked and tokens never leave the device in backups.
- Watch: `WCSession.transferUserInfo` with `drover.baseURL`, `drover.token`, `drover.widgetToken` (empty string = revoke).
- Deep links: `drover://session/<id>?host=<host>`, `drover://board`, `drover://manager`, `drover://settings`,
  `drover://pair?url=<percent-encoded http(s) base URL>` (Settings with the address filled in; the link must carry
  nothing else, so never a token). Only pairing again with the daemon already set up starts by itself; any other
  address, and every address on a fresh install, waits for a tap on Pair with Mac under a note naming it.

## Pairing

Pair with Mac (next to the address) asks the daemon for a 6-digit code (`POST /api/pair/request`, no token), shows
it, and polls until it is approved on the Mac (`drover pair approve <code>` or Approve in the browser UI). The two
tokens then go through the same path as Save and connect (Keychain, App Group address, watch sync). DroverKit's
`PairingController` runs it; only `Settings/SettingsView.swift` and `Settings/PairingRows.swift` import DroverKit, so
`Tests/run-logic-tests.sh` (plain swiftc) is unaffected, while `script/typecheck.sh ios Apps/iOS/Sources` no longer
covers those two files.

## Notifications: no push server

There is **no APNs**: the daemon has no push server and no Apple push certificate, and nothing leaves the user's
own network. Alerts come from polling `native.notifications`:

- In the foreground: on every activation, plus live board updates over SSE (`/api/stream`).
- In the background: a `BGAppRefreshTask` (`dev.drover.app.refresh`), asked for every 15 minutes. iOS decides
  when it actually runs (often less often, never after the user force-quits the app, rarely in Low Power Mode), so
  background alerts can be late. Open the app for live state.
- The first poll only stores the cursor (no flood of old alerts). Notifications carry Reply (text input, sends
  `sessions.message`) and Open actions; Open deep-links to the session.
- Live Activities for "waiting on you" are out of scope.

## Dictation

On-device only: `SFSpeechRecognizer` with `requiresOnDeviceRecognition = true`. When the current language has no
on-device model, the mic button is disabled. Audio never leaves the phone.

## Transport security

The daemon speaks plain http on loopback, LAN and the tailnet. ATS allows local networking and `*.ts.net`
(WireGuard already encrypts tailnet traffic). Prefer a Tailscale address; do not expose the daemon on the internet.

## Build

```sh
script/generate.sh           # at the repo root (core's wrapper around xcodegen; skips missing parts)
xcodebuild build -project Drover.xcodeproj -scheme DroveriOS -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO
```

Without an accepted Xcode license, the Swift sources can still be typechecked and the logic tests run (set
`DROVER_FIXTURES=<dir>` to point the fixture suite elsewhere; by default it reads the repo's `Fixtures/`):

```sh
script/typecheck.sh ios Apps/iOS/Sources
Apps/iOS/Tests/run-logic-tests.sh
```

`--mock` (`xcrun simctl launch <device> dev.drover.app --mock`) runs on synthetic data (`MockDroverAPI`) with no network,
no Keychain access, no background refresh and no notification polling; `--mock-tab <board|sessions|manager|settings>` and
`--mock-session <id>` pick the first screen. `script/screenshots.sh` photographs the iPhone and watch apps that way in the
simulator (CI: `.github/workflows/screenshots.yml`).

## What the owner must do

1. Accept the Xcode license (`sudo xcodebuild -license accept`) or build on a GitHub macOS runner.
2. Export `DROVER_TEAM_ID=<team id>` before `script/generate.sh`: the root `project.yml` sets `DEVELOPMENT_TEAM` from it for
   `DroveriOS` and everything it embeds (`DroverWidgets-iOS`, `DroverWatch`). Parts must not set a team (docs/xcodegen.md).
3. In the Apple Developer portal, register the App Group `group.dev.drover` and enable App Groups and
   Keychain Sharing for `dev.drover.app` (and the widget and watch bundle ids). Automatic signing does this
   when the team is set.
4. On the Mac that runs the daemon, publish it on the tailnet over HTTPS (the daemon stays on loopback):
   `tailscale serve --bg --https=8446 http://127.0.0.1:7337`. In the app's Settings tab, enter
   `https://<machine>.<tailnet>.ts.net:8446` and tap Pair with Mac, then approve the code on the Mac. (Or enter the
   main token from `~/.local/state/drover/token` and the widget token from `drover widget-token`, then Test
   connection and Save and connect.) Saving also pairs the watch.

## Accessibility

Supported:

- **Contrast.** `Core/Palette.swift` holds the light and dark hex values (Theme builds its colours from it) and
  the WCAG 2.x maths. `A11yTests` assert, in both schemes: primary text >= 7:1 and secondary text >= 4.5:1 on
  background, surface and raised surface; each state colour >= 4.5:1 as text on surface, background and on its
  own 12% badge tint. No palette value needed changing.
- **Dynamic Type.** Text styles only, `@ScaledMetric` for fixed sizes. At accessibility sizes, rows switch from
  horizontal to vertical (`BoardAdaptiveStack` or `AnyLayout`), the composer buttons stack when they no longer
  fit, and headlines and tool lines lose their line limits. Ids stay middle-truncated but speak in full.
- **VoiceOver.** Icon-only controls have labels, non-obvious ones have hints. Rows are single elements, chat
  bubbles read "You, <time>: <text>" (also Assistant, Tool, Manager). Swipe and context actions are mirrored as
  named accessibility actions. State always has a symbol and text, never colour alone.
- **Announcements** for message sent, queued and failed, key sent, sweep requested, settings saved, connection
  test result, copied ids, and "New reply" at most once per transcript poll while VoiceOver is running.
- **Motion and input.** Reduce Motion disables animated scrolling. Targets are at least 44 pt (scaled).
  Dictation reports "Listening" as its value. Cmd+Return sends from a hardware keyboard. The key buttons support
  the Large Content Viewer.

Checked by: the contrast tests in `run-logic-tests.sh`, `script/typecheck.sh ios`, and a code audit of every
view. Not run on a device or simulator with VoiceOver, Switch Control or AX5 in this environment; do that pass
before release.
