# Safari Web Extension: pinned design (window 07-safari)

> **2026-10-16:** the two host apps ("Drover for Safari", `DroverSafari-macOS` / `DroverSafari-iOS`) are gone. The
> extension is embedded in the main Drover apps as `dev.drover.macos.safari` and `dev.drover.app.safari`. The Mac app's
> Settings has a Safari tab (extension state, open Safari's settings), the iOS app's Settings says where the switch is,
> and both apps register the `drover.session` / `drover.info` categories the extension posts and answer Reply and Open.
> The `Native/App` slice below (`SetupView`, `NotificationResponder`, the two `@main` apps) describes the old layout.

This file fixes every interface between the three slices. Workers implement it as written and do not
redesign it. Contract-level identifiers come from `CONTRACT.md` ("Apple identifiers").

## Principle
The Safari extension is NOT a fork. `Extensions/chrome/` is copied verbatim at build time into
`Extensions/safari/Resources/` (generated, gitignored). Safari differences live in three places only:
1. `build/lib/manifest.mjs`: a pure manifest transform.
2. `shim/safari-shim.js`: loaded before any Chrome code in every context; stubs or reroutes missing APIs.
3. The Swift native messaging handler: config from the shared Keychain/App Group, native notifications,
   and an HTTP proxy for `/api/op/*` calls (no CORS allowlisting, no per-site permission prompt).

## Layout and ownership
```
Extensions/safari/
  DESIGN.md                      this file (orchestrator)
  README.md                      slice C
  project.part.yml               slice C (XcodeGen)
  safari.config.json             slice A
  .gitignore                     slice A (ignores Resources/)
  build/build-resources.mjs      slice A (CLI, node >= 18, zero deps)
  build/build-resources.sh       slice A (finds node, runs the .mjs; used by Xcode)
  build/xcode-copy-resources.sh  slice C (Xcode run-script phase)
  build/lib/manifest.mjs         slice A (pure: transformManifest)
  build/lib/files.mjs            slice A (copy filter, html shim injection, background wrapper)
  shim/safari-shim.js            slice A
  placeholder/                   slice A (minimal MV3 extension used when Extensions/chrome has no manifest.json)
  test/*.test.mjs                slice A (node --test, zero deps)
  Native/Shared/*.swift          slice B (compiled into both extensions and the native tests)
  Native/Extension/SafariWebExtensionHandler.swift   slice B
  Native/Tests/*.swift           slice B (XCTest; typecheck only, never run here)
  Native/Support/{macOS,iOS}/Extension/Info.plist + *.entitlements   slice C
```

## safari.config.json (slice A writes; shim and build read)
```json
{
  "chromeDir": "../chrome",
  "outDir": "Resources",
  "background": "service_worker",
  "proxyApi": true,
  "storage": { "key": "settings", "baseUrlField": "baseUrl", "tokenField": "token", "actorField": "actor", "actor": "safari", "chromeActor": "chrome" },
  "notificationIdPattern": "^drover\\|(?<host>[^|]*)\\|(?<session>[^|]*)\\|[^|]*$",
  "strictMinVersion": "17.0",
  "exclude": ["test/", "tests/", "tools/", "node_modules/", "*.test.js", "*.test.mjs", "*.md", "package.json", "package-lock.json", ".*"]
}
```
`storage` matches the Chrome code on `feat/06-chrome` (`lib/settings.js`: `chrome.storage.local` key `settings` holds
`{ baseUrl, token, actor, pollMinutes, notify }`). `notificationIdPattern` matches Chrome's `lib/notify.js` `encodeNotificationId`: `drover|<host>|<sessionId>|<id>`, each part
URI-encoded (the shim decodes them; an empty session means none). Other ids (`drover|overflow`, `drover|omnibox|<ts>`) do not match.

## Build (`node build/build-resources.mjs [--chrome DIR] [--out DIR] [--config FILE] [--strict]`)
Paths default relative to `Extensions/safari/`. Steps:
1. If `<chrome>/manifest.json` is missing: copy `placeholder/` instead, print a warning, exit 0
   (`--strict`: exit 1).
2. Refuse to clean an `--out` that is not named `Resources` or not inside a temp dir (guard against `rm -rf`
   of the wrong path). Then empty it.
3. Copy every file of the source except `exclude` patterns (dir prefix `x/`, suffix glob `*.ext`, dotfiles `.*`).
4. Write `safari-shim.js` = `shim/safari-shim.js` with the token `/*__DROVER_SAFARI_CONFIG__*/null` replaced by
   the JSON `{proxyApi, storage, notificationIdPattern}`.
5. Background wrapper `safari-background.js`: if the Chrome manifest has `background.type == "module"`:
   `import './safari-shim.js';\nimport './<sw>';\n`; otherwise `importScripts('safari-shim.js', '<sw>');\n`.
   (The shim has no import/export so it is valid both ways.)
6. Every copied `.html`: insert `<script src="/safari-shim.js"></script>` right after the `<meta charset...>`
   tag if present, else right after the opening `<head...>` tag. Idempotent (skip if already present).
7. `manifest.json` = `transformManifest(chromeManifest, config)`, 2-space JSON plus trailing newline.
8. `BUILD-INFO.json` = `{ "source": "Extensions/chrome" | "placeholder", "chromeCommit": <git short sha or null>, "notes": [...] }`
   (no timestamps: output is deterministic).

## transformManifest(m, cfg) -> { manifest, notes } (pure, no I/O, does not mutate input)
- Delete keys: `side_panel`, `omnibox`, `key`, `update_url`, `minimum_chrome_version`, `offline_enabled`,
  `externally_connectable`, `chrome_url_overrides`. Each deletion adds a note.
- `permissions`: drop `sidePanel`, `offscreen`, `notifications`; add `nativeMessaging` (once). Keep order otherwise.
- `background`: `{ service_worker: "safari-background.js", type?: same as chrome }` when cfg.background is
  `service_worker`; `{ scripts: ["safari-background.js"], type?, persistent: false }` when `scripts`.
- `action.default_popup`: if absent and `side_panel.default_path` existed, set it to that path.
- `browser_specific_settings.safari.strict_min_version = cfg.strictMinVersion`.
- Everything else passes through unchanged (icons, host_permissions, optional_host_permissions, commands,
  content_security_policy, options_ui/options_page, action).

## Shim (`shim/safari-shim.js`), a plain script, no import/export, idempotent via `globalThis.__droverSafari`
Runs in the background worker and every extension page. `const CFG = /*__DROVER_SAFARI_CONFIG__*/null;`
(null means the defaults shown in safari.config.json above).
- Namespace: if `globalThis.chrome` is missing and `globalThis.browser` exists, set `globalThis.chrome = browser`.
  Use `browser` (promise based) for native calls when present, else `chrome`.
- `native(msg, timeoutMs)`: `runtime.sendNativeMessage("application.id", { v: 1, ...msg })` with a 10 s timeout
  (25 s for `op`, longer than the native HTTP timeout of 20 s); always resolves to `{ ok, result?, error? }`.
  A missing API or a synchronous throw becomes `native-unavailable` (nothing was sent); a rejected call or a malformed
  answer becomes `native-no-answer` and a timeout `native-timeout` (in both the handler may have acted).
- Inert event object: `{ addListener, removeListener, hasListener }` that store listeners and never fire.
- `chrome.notifications` if missing: `create(id?, options, cb?)` (id generated as `drover-safari-<n>` when absent)
  parses `{host, session}` from the id with `notificationIdPattern` and sends
  `{type:"notify", id, title: options.title, body: options.message, sessionId, host, kind: null}` (Chrome options carry
  no kind; `contextMessage` holds the host);
  resolves the id (and calls cb). `clear(id, cb?)` sends `{type:"clearNotification", id}` and resolves true.
  `getAll` resolves `{}`; `getPermissionLevel` resolves `"granted"`; events `onClicked`, `onButtonClicked`,
  `onClosed`, `onPermissionLevelChanged`, `onShowSettings` are inert.
- `chrome.sidePanel`: NOT stubbed. The Chrome code feature-detects it (`ext/panel.js` falls back to
  `windows.create` / `tabs.create` with `sidepanel.html?host=..&id=..`), so a stub would break that fallback.
- `chrome.offscreen` if missing: `createDocument` REJECTS `Error("offscreen is not available in Safari")`,
  `hasDocument` resolves false, `closeDocument` resolves, `Reason` = `{}` proxy-free object with common keys.
- `chrome.omnibox` if missing: inert `onInputChanged/onInputEntered/onInputStarted/onInputCancelled`,
  `setDefaultSuggestion` no-op.
- `chrome.runtime.getContexts` if missing: resolves `[]`.
- Config seed: on load, `native({type:"config"})`; if it returns both `baseURL` and `token`, read
  `storage.local[storage.key]` (an object; `{}` when absent), set `baseUrlField`/`tokenField` to the native values,
  and set `actorField` to `storage.actor` when it is missing or equal to `storage.chromeActor`; write back with
  `storage.local.set({[key]: merged})` only when something changed, keeping every other field. If `storage.key` is
  null the fields are top-level keys instead. If native has nothing, leave storage alone (the copied options page
  still works as in Chrome) and turn the proxy off. `storage.local.get` is wrapped to wait for the seed, so a
  first-run settings read sees the Keychain values (listener registration stays synchronous).
- `chrome.permissions`: when `proxyApi` is on and the native config has a baseURL and token, `contains(p)` and
  `request(p)` resolve true if every entry of `p.origins` is `<baseURL origin>/*` and `p.permissions` is empty or
  absent; anything else goes to the original method (or resolves false when the API is missing). Reason: proxied
  calls never touch the network from the extension, so no host permission is needed. `contains` waits for the
  seed; `request` never awaits anything (it must run inside the click's user gesture).
- fetch proxy (when `proxyApi`): wrap `globalThis.fetch`. A request is proxied only if the native config has a
  token and baseURL, the URL origin equals the baseURL origin, the path starts with `/api/op/`, and the method is
  GET or POST. Then `native({type:"op", op, method, args})` where `op = decodeURIComponent(path after /api/op/)`,
  `args` = query params object for GET, `JSON.parse(body || "{}")` for POST (string body, or `await request.text()`).
  The op message also carries `origin` (the origin the page targets). A request whose `Authorization: Bearer` differs
  from the native token (e.g. the options page testing a newly typed token) is proxied with `token: <that token>`,
  which the native side uses for that request only; the stored token never travels in a message.
  Native success `{status, body}` becomes `new Response(body, {status, headers:{"content-type":"application/json"}})`.
  Failures where nothing was sent (`native-unavailable`, `notConfigured`, `badRequest`) fall back to the real fetch
  (`notConfigured` also re-reads the config). Ambiguous failures (`native-timeout`, `native-no-answer`, `network`)
  reject with `TypeError("Failed to fetch")` and are never replayed, so a mutation cannot run twice; only the
  read-only ops (`fleet.summary`, `native.summary`, `native.notifications`, `native.board`, `sessions.list`, `sessions.get`,
  `sessions.transcript`, `sessions.lastReply`, `openclaw.threads`, `openclaw.status`, `openclaw.feed`, `tmux.capture`,
  `host.list`, `events.state`, `events.tail`) may then fall back to the real fetch. `sessions.answer` is a mutation:
  never replayed. An aborted `signal`
  (before or during the native call) rejects with a `DOMException` `AbortError`.
  Everything else (including `/api/stream` SSE) goes straight to the real fetch.
- Exposes `globalThis.__droverSafari = { native, ready, config }` (`ready` is the config-seed promise).
- Never logs the token or full URLs with query strings.

## Native messaging protocol (JSON, extension -> Swift)
Request: `{ "v": 1, "type": <type>, ...fields }`. Response: `{ "ok": true, "result": {...} }` or
`{ "ok": false, "error": "<code>" }`. Error codes never contain secrets or URLs.
| type | fields | result |
|---|---|---|
| `ping` | | `{ protocol: 1, platform: "macOS"|"iOS", version: "<CFBundleShortVersionString>" }` |
| `config` | | `{ baseURL: string|null, token: string|null }` |
| `notify` | `id, title, body, sessionId?, host?, kind?` | `{ posted: true }`; error `notAuthorized` |
| `clearNotification` | `id` | `{ cleared: true }` |
| `op` | `op, method: "GET"|"POST", args: object, origin?: string, token?: string` (refused with `notConfigured` when `origin` differs from the shared server's origin; `token` replaces the stored token for this request only) | `{ status: Int, body: String }`; errors `notConfigured`, `badRequest`, `network` |
| other | | error `unknownType`; malformed JSON shape: `badRequest` |

## Swift (slice B), Swift 6 language mode, macOS 14 / iOS 17, no third-party deps, no DroverKit dependency
`Native/Shared/`:
- `JSONValue.swift`: `enum JSONValue: Codable, Sendable, Equatable { null, bool, number(Double), string, array, object }`
  plus `init(any: Any) throws` and `var anyValue: Any` (bridge to/from `SFExtensionMessageKey` dictionaries).
- `NativeProtocol.swift`: `enum NativeRequest: Sendable, Equatable { ping, config, notify(NotifyPayload),
  clearNotification(id: String), op(OpPayload) }` with `static func parse(_ message: Any?) -> Result<NativeRequest, NativeError>`;
  `struct NotifyPayload { id, title, body, sessionId?, host?, kind? }`; `struct OpPayload { op, method, args: [String: JSONValue] }`;
  `enum NativeError: String, Error { badRequest, unknownType, notConfigured, notAuthorized, network }`;
  `enum NativeResponse: Sendable { success(JSONValue), failure(NativeError) }` with `var jsonObject: [String: Any]`.
- `DroverSharedConfig.swift`: `struct DroverSharedConfig: Sendable { appGroup, keychainAccessGroup?, keychainService,
  keychainAccount, baseURLDefaultsKey }`, `static func fromBundle(_ bundle: Bundle = .main)` reading Info.plist keys
  `DroverAppGroup` (default `group.dev.drover`), `DroverKeychainAccessGroup` (no default: nil means the app's default
  group), `DroverKeychainService` (default `dev.drover.token`), `DroverKeychainAccount` (default `main`),
  `DroverBaseURLDefaultsKey` (default `drover.baseURL`).
- `CredentialStore.swift`: `protocol CredentialReading: Sendable { func baseURL() -> URL?; func token() -> String? }`;
  `struct SharedCredentialStore: CredentialReading` (generic password, `kSecUseDataProtectionKeychain: true` on macOS,
  access group when set; base URL from `UserDefaults(suiteName: appGroup)`), plus
  `func save(baseURL: URL, token: String?) throws` for the host app's fallback form. Base URL accepted only for
  http/https with a host. Never logs values.
- `HTTP.swift`: `protocol HTTPPerforming: Sendable { func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) }`,
  `struct URLSessionHTTP: HTTPPerforming` (ephemeral session, 20 s timeout), and
  `enum OpRequestBuilder { static func make(base: URL, token: String, op: String, method: String, args: [String: JSONValue]) throws(NativeError) -> URLRequest }`
  (op must match `^[A-Za-z][A-Za-z0-9._-]{0,63}$`; GET encodes args as query items, strings verbatim, other values as
  JSON text; POST sends JSON body with `content-type: application/json`; header `Authorization: Bearer <token>`).
- `NotificationPoster.swift`: `protocol NotificationPosting: Sendable { func post(_ p: NotifyPayload) async throws(NativeError); func clear(id: String) async }`;
  `struct UserNotificationPoster` (UNUserNotificationCenter; category `drover.session` with actions `drover.reply`
  (UNTextInputNotificationAction, "Reply") and `drover.open` ("Open", foreground), used when `sessionId` is set, else
  category `drover.info` (renamed from `drover.generic` so the containing app's own category matches; the app
  registers both categories and their actions, so the extension no longer has `registerCategories()`); userInfo keys
  `sessionId`, `host`, `kind`, and `server` (the base URL it used; the Mac app's wrong-server Reply guard reads it); thread id = sessionId; `notAuthorized` when authorization is not
  authorized/provisional/ephemeral).
- `NativeRouter.swift`: `struct NativeRouter: Sendable { init(credentials:, notifier:, http:, platform:, version:);
  func handle(_ message: Any?) async -> NativeResponse }`. Pure dispatch; all I/O via the injected protocols.
`Native/Extension/SafariWebExtensionHandler.swift`: `final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling`
  reads `SFExtensionMessageKey` from the first input item, runs `NativeRouter` with real dependencies, replies with
  `NSExtensionItem` whose `userInfo = [SFExtensionMessageKey: response.jsonObject]`. Swift 6 safe (context boxed in an
  `@unchecked Sendable` wrapper; no data races).
`Native/App/Shared/`:
- `NotificationResponder.swift`: `@MainActor final class NotificationResponder: NSObject, UNUserNotificationCenterDelegate`.
  Reply action: POST `sessions.message` `{ id: sessionId, text, actor: "safari", host? }` (host only when not "local")
  via `OpRequestBuilder` + `URLSessionHTTP` with the stored token. Open action or default tap: open
  `drover://session/<id>?host=<host>` if the system can open it, else `<baseURL>/#/pop/session/<host or local>/<id>`
  (never a token in a URL). Foreground presentation: banner + sound.
- `SetupView.swift`: SwiftUI, shared by both apps: status of shared config (server URL shown, token shown only as
  "saved"/"missing"), a fallback form (server URL, token SecureField, Save -> `SharedCredentialStore.save`),
  "Allow notifications" button (requestAuthorization .alert .sound .badge), and platform-specific extension help:
  macOS uses `SFSafariExtensionManager.getStateOfSafariExtension` + a button calling
  `SFSafariApplication.showPreferencesForExtension(withIdentifier:)`; iOS shows text steps (Settings, Apps, Safari,
  Extensions). Extension bundle id comes from Info.plist key `DroverSafariExtensionBundleID`.
  Design: graphite palette, serif title, monospace for ids, sentence case, no em dashes.
- `DroverSafariMacApp.swift` / `DroverSafariIOSApp.swift`: `@main` App, single window with `SetupView`, app delegate adaptor
  that sets `UNUserNotificationCenter.current().delegate = responder` and calls `registerCategories()` at launch.

## Xcode targets (slice C, `project.part.yml`)
| target | type | platform | bundle id |
|---|---|---|---|
| `DroverSafariExtension-macOS` | app-extension, embedded in `DroverMac` | macOS 14 | `dev.drover.macos.safari` |
| `DroverSafariExtension-iOS` | app-extension, embedded in `DroveriOS` | iOS 17 | `dev.drover.app.safari` |
| `DroverSafariNativeTests-macOS` | bundle.unit-test, in the `DroverMac` scheme's test action | macOS 14 | `dev.drover.safari.tests` |
- Extension Info.plist: `NSExtension = { NSExtensionPointIdentifier: com.apple.Safari.web-extension,
  NSExtensionPrincipalClass: $(PRODUCT_MODULE_NAME).SafariWebExtensionHandler }`.
- Resources: run-script phase `build/xcode-copy-resources.sh` (builds Resources then rsyncs it into
  `$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH`; Xcode groups would flatten subfolders and a folder
  reference would nest them one level too deep). `ENABLE_USER_SCRIPT_SANDBOXING: NO` on the extension targets.
- Entitlements: app group `group.dev.drover`, keychain access group `$(AppIdentifierPrefix)dev.drover.shared`
  for both extensions; macOS adds `com.apple.security.app-sandbox` and `com.apple.security.network.client`.
- Info.plist keys for every target: `DroverAppGroup`, `DroverKeychainAccessGroup = $(AppIdentifierPrefix)dev.drover.shared`,
  `DroverKeychainService`, `DroverKeychainAccount`, `DroverBaseURLDefaultsKey`; the Mac app adds
  `DroverSafariExtensionBundleID` (Apps/macOS/project.part.yml).
- Signing: no team in the part; the root `project.yml` sets `DEVELOPMENT_TEAM` from `DROVER_TEAM_ID` (docs/xcodegen.md). No signing secrets committed.
