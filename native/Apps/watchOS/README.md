# Drover for Apple Watch (Apps/watchOS)

Companion watch app (SwiftUI, watchOS 10+, Swift 6) for the Drover daemon. It shows the
sessions that are waiting on you, the last message of each, and lets you answer with a canned
reply (yes, no, continue, go ahead, status?) or by dictation. New waiting items buzz the watch.

## Layout
| path | what |
|---|---|
| `Sources/App` | `@main` app, scene wiring, `Palette`, `Haptics`, `Complications.reload()` |
| `Sources/Core` | models (`native.summary`, `sessions.lastReply`), `WatchClient`, `TokenVault` (Keychain), `WatchConfig`, `SummaryCache`, `SeenWaitingStore`, `SummaryFetcher`, `AppModel`, `DeepLink`, `PreviewData` |
| `Sources/List` | waiting list, row, session detail (last message), formatting and deep link routing |
| `Sources/Replies` | `ReplyBar`: canned replies, dictation via `TextFieldLink`, confirm before sending dictated text |
| `Sources/Sync` | `WatchSyncReceiver` (WatchConnectivity), `SyncApplier`, pairing status screen |
| `Sources/Background` | `BackgroundRefresh` (app refresh task), `BackgroundSummaryDownload` (background URLSession), local notification for new waiting items, notification tap routing |
| `Shared/WatchSyncPayload.swift` | the WatchConnectivity payload (keys shared with the iOS sender) |
| `Tests/` | logic tests that compile and run on macOS (`Tests/run-logic-tests.sh`), synthetic fixture |
| `project.part.yml` | XcodeGen target `DroverWatch`, included by the root `project.yml` |

Core is self-contained (it predates DroverKit, now in `Packages/DroverKit`) and matches CONTRACT.md one for one;
it can be swapped for DroverKit types later without touching the views.

## Data flow
- Foreground: on scene activation the app fetches `native.summary`, writes the bare `result` JSON to
  `<App Group container>/summary.json`, reloads complications and buzzes for waiting items it has not
  seen before.
- Background: a `WKApplicationRefreshBackgroundTask` (SwiftUI `.backgroundTask(.appRefresh("drover.refresh"))`)
  fires about every 15 minutes (backoff to 2 hours after errors; watchOS decides the real cadence and
  budget). It queues a `GET /api/op/native.summary` download on a **background `URLSession`**
  (`dev.drover.watch.summary`), because a suspended watch app can only network through one. It uses
  the **widget token only**. When the download finishes the system wakes the app with a URL session task
  (`.backgroundTask(.urlSession(...))`); the delegate checks that the request still matches the current
  server and widget token (else it is dropped, for example after an unpair), writes `summary.json`,
  reloads complications and posts a local notification for new waiting items. That notification is what
  gives the haptic while the app is not frontmost. Tapping it opens `drover://session/<id>?host=<host>` (one
  item) or `drover://board` (several); a link to an item the app has not seen yet is kept until the next
  refresh.
- WatchConnectivity deliveries that arrive in the background refresh with the widget token only; the
  main token is used for `native.summary` only while the app is frontmost and no widget token exists.
- Detail: `sessions.lastReply` and replies (`sessions.message`, actor `watch`) need the **main token**.
  Without it the app still lists waiting items and says "Pair with iPhone to reply".
- There is no push: the daemon has no APNs path, so the watch only learns about new items when it
  refreshes.

## Tokens and pairing
- The iPhone app (Apps/iOS, `WatchTokenSync.swift`) sends `{"drover.baseURL", "drover.token", "drover.widgetToken"}`
  with `WCSession.transferUserInfo`. On the watch a missing key leaves the value alone and an empty string
  clears it. The URL is normalized (http or https, no credentials, query or fragment); a different server
  wipes the cached summary and the seen set.
- Tokens go straight into the **watch's own Keychain** (service `dev.drover.token`, accounts `main` and
  `widget`, access group `$(AppIdentifierPrefix)dev.drover.shared`, accessible after first unlock,
  this device only). The iPhone Keychain is not shared with the watch.
- Tokens are never logged, printed, shown or put in a URL; `WatchSyncPayload` redacts them in every
  description and mirror. The pairing screen only shows whether each token is present, and "Unpair this
  watch" deletes both tokens, the server URL and the cache.
- WatchConnectivity transfers are encrypted between the paired devices; a queued `transferUserInfo` sits
  in the system's queue until delivered, so the iOS side should cancel outstanding transfers before queuing
  a new token.

## Containers (watch has its own)
The watch does not see the iPhone's App Group. The watch app and the watch complications
(`DroverWidgets-watchOS`, window 05-widgets) share the watch's own `group.dev.drover` container:
`summary.json` (bare `native.summary` result), plus `UserDefaults(suiteName: "group.dev.drover")` with
`drover.baseURL` (string), `drover.watch.seenWaiting` and `drover.watch.refreshFailures`. Complications read the
`widget` token from the shared Keychain access group, never `main`.

## Network
`NSAllowsLocalNetworking` is on so a plain `http://` daemon on loopback or the LAN works. For a
Tailscale or other routed address prefer HTTPS (for example `tailscale serve`); App Transport Security
blocks plain HTTP to non-local names.

## Build and verify
- Typecheck (no Xcode license needed): `script/typecheck.sh watchos Apps/watchOS/Sources Apps/watchOS/Shared`
- Full compile to SIL against the watchOS SDK (catches definite-initialization errors typecheck misses):
  `Apps/watchOS/Tests/compile-watch.sh`
- Logic tests, compiled and run on macOS: `Apps/watchOS/Tests/run-logic-tests.sh` (also decodes the repo
  `Fixtures/` written by core)
- Full build once the license is accepted: `xcodegen generate && xcodebuild -scheme DroverWatch -destination 'generic/platform=watchOS Simulator' build`
- Signing: set `DEVELOPMENT_TEAM`, and register the App Group `group.dev.drover` and the Keychain group
  for `dev.drover.app.watchkitapp`. The iOS target embeds the watch app with `- target: DroverWatch`.
- The app icon set is an empty 1024 slot: add `AppIcon.png` before shipping.
