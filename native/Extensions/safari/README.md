# Drover Safari extension

A Safari Web Extension for Drover, embedded in the main Drover apps for macOS and iOS: there is no separate "Drover for Safari" app (Apple needs a containing app, and Drover is it). It is not a fork: the Chrome extension in `Extensions/chrome` is the single source of the UI and logic.

## How it is built

`build/build-resources.sh` (a zero-dependency node script) copies `Extensions/chrome` into `Extensions/safari/Resources/` (generated, gitignored), adds `shim/safari-shim.js` to every page and to the background worker, and rewrites `manifest.json` with a small transform. Xcode runs `build/xcode-copy-resources.sh` as a build phase on both extension targets; it runs the build script and rsyncs `Resources/` into the extension bundle. Set `DROVER_SAFARI_STRICT=1` to fail instead of falling back to the placeholder when `Extensions/chrome` has no manifest.

The full design is in [DESIGN.md](DESIGN.md).

## SafariServices callbacks on macOS

The Mac app's Settings, Safari tab (`Apps/macOS/Sources/Settings/SafariSettingsView.swift`) shows whether Safari has the extension on and opens Safari's settings. It is a main-actor SwiftUI view, and a completion handler it passes to SafariServices inherits that actor. SafariServices runs the handler on an XPC queue, and the Swift 6 runtime then traps (`EXC_BREAKPOINT` in `_swift_task_checkIsolatedSwift`). That trap crashed the old separate container app on every launch. Marking the closure `@Sendable` does not remove the check.

So extension state and Safari preferences go through the `nonisolated` async helpers on that view (`SFSafariExtensionManager.stateOfSafariExtension` and `SFSafariApplication.showPreferencesForExtension`). Only a `Bool`, or nothing, comes back to the view. Do not hand a closure from a main-actor view to an XPC callback.

## Differences from Chrome

- Namespace: `chrome` is aliased to `browser` when only `browser` exists.
- No side panel: the Chrome code detects the missing API and opens the chat in a popup window or tab instead.
- No omnibox and no offscreen document: both are stubbed so the Chrome code degrades gracefully.
- Notifications go through the native handler, which posts them with UserNotifications in the `drover.session` (with a session) and `drover.info` categories. The containing Drover app registers those categories and handles Reply and Open (`NotificationCoordinator` on macOS, `NotificationManager` on iOS), the same as for its own alerts.
- `/api/op/*` calls are proxied through the native handler, so ops need no host permission and no `DROVER_ALLOW_ORIGINS` entry.
- Proxied op calls that time out or fail on the network are reported as a network error and never retried, so a reply is never sent twice.
- Native networking allows plain HTTP only to local addresses (loopback, `.local`, bare IP addresses such as Tailscale's `100.x`) and `*.ts.net` (App Transport Security exceptions in every Info.plist). Any other host needs HTTPS.
- The `/api/stream` SSE connection is not proxied. If the Chrome code uses it from the extension, the daemon's `DROVER_ALLOW_ORIGINS` needs `safari-web-extension://<uuid>` (the uuid is shown in Safari's extension settings and changes per install). Without it the pages poll: a manager reply then appears from transcript reads (a reply in flight carries its text so far) instead of streaming.
- Dialog keys in the popup and the side panel's answer card go through the op proxy (`sessions.answer` is a mutation: an ambiguous failure is never replayed). Notifications keep Reply and Open: their actions belong to the containing app's `drover.session` category, so Approve and Deny are Chrome only.

## Configuration

Nothing to set in the extension: pair the Drover app, and the extension reads the same server and token through the native handler.

- Keychain: access group `$(AppIdentifierPrefix)dev.drover.shared`, service `dev.drover.token`, account `main`.
- App Group `group.dev.drover`, `UserDefaults` key `drover.baseURL`.

When the apps hold a server URL and token, they win: the extension copies them into its settings each time it starts, so edits made in the copied options page are replaced. Change the server in the app instead. A token typed into the options page is still tested for real (it is sent directly, not through the native proxy).


## Building

```
script/generate.sh                         # at the repo root (core's wrapper around xcodegen)
xcodebuild -scheme DroverMac build         # embeds DroverSafariExtension-macOS
xcodebuild -scheme DroveriOS -destination 'generic/platform=iOS' build   # embeds DroverSafariExtension-iOS
```

The root `project.yml` includes `Extensions/safari/project.part.yml`. Targets: `DroverSafariExtension-macOS` (`dev.drover.macos.safari`, embedded in `DroverMac`), `DroverSafariExtension-iOS` (`dev.drover.app.safari`, embedded in `DroveriOS`), `DroverSafariNativeTests-macOS` (the `DroverMac` scheme's test action runs it).

## Enabling the extension

- macOS: Safari, Settings, Extensions, tick "Drover" (Drover's own Settings, Safari tab, shows the state and opens that pane). For unsigned local builds, enable the Develop menu (Settings, Advanced) and choose Develop, Allow Unsigned Extensions (resets when Safari quits).
- iOS: Settings, Safari (under Apps on iOS 18 and later), Extensions, Drover, turn it on and allow the site access you want.

## What you need to do

- Export `DROVER_TEAM_ID=<your team id>` before `script/generate.sh` for signed builds (the root `project.yml` maps it to `DEVELOPMENT_TEAM`; this part sets no team).
- Accept the Xcode license (`sudo xcodebuild -license`).
- Register the App Group `group.dev.drover` and the keychain group `dev.drover.shared` with your team, and give both extension bundle IDs (`dev.drover.macos.safari`, `dev.drover.app.safari`) the App Groups capability with `group.dev.drover` in the developer portal (`script/asc-signing.py` registers the IDs but cannot assign the group).
- Allow notifications in the Drover app.

## Verification status

2026-10-16, embedded in the main apps:
- Unsigned `xcodebuild` of `DroverMac` and `DroveriOS` (Xcode at `xcode-select -p`) put `DroverSafariExtension.appex` in `Drover.app/Contents/PlugIns` (`dev.drover.macos.safari`) and `Drover.app/PlugIns` (`dev.drover.app.safari`), extension point `com.apple.Safari.web-extension`, with the copied web resources inside.
- `build/compile-native.sh` (macOS 14 and iOS 17), `build/run-native-tests.sh` (42 XCTest cases) and `node --test 'test/*.test.mjs'` (50 tests) pass.
- Not yet run: a signed build, the extension inside Safari from the merged app, and its notifications answered by the Drover app.

### 2026-10-11, no Xcode license on the build Mac (separate host apps)

- Executed: `node --test 'test/*.test.mjs'` (50 tests: manifest transform, copy and html injection, the build end to end, the shim in `node:vm` with a fake `browser`). The native logic tests in `Native/Tests` (42 XCTest cases) ran through `build/run-native-tests.sh`, which links them with `swiftc` against Xcode's XCTest and runs Xcode's `xctest` (no `xcodebuild`). The resource build ran against the real Chrome extension (branch `feat/06-chrome`) through `build/xcode-copy-resources.sh` with an Xcode-like minimal `PATH`.
- Compiled, not linked (`build/compile-native.sh`: `swiftc -c`, Swift 6, against the real SDKs, which also catches definite-initialization errors that `-typecheck` misses): both extension targets and both host apps, for macOS 14 and iOS 17, with no errors or warnings.
- Generated only: `xcodegen generate` with a scratch root spec including `project.part.yml` (5 targets, extension embedding, run-script phase, SafariServices linkage; plists untouched).
- Never executed: any Xcode build, signing, the extension inside Safari, native messaging from a real Safari, Keychain and App Group access, notifications, the host app UI, and anything on iOS hardware or simulator. App Transport Security behaviour for plain HTTP to bare IP addresses (for example a Tailscale `100.x` address) is unverified; loopback and `*.ts.net` are covered by explicit keys.
