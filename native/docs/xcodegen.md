# XcodeGen part convention

The root `project.yml` holds shared settings, the `DroverKit` package and an `include:` list. Each window adds its own targets in a part file. Nobody edits another window's part, and only core edits `project.yml`.

## Part files

| window | part file |
|---|---|
| 01 macOS app | `Apps/macOS/project.part.yml` |
| 02 menu bar | `Apps/MenuBar/project.part.yml` |
| 03 iOS app | `Apps/iOS/project.part.yml` |
| 04 watchOS | `Apps/watchOS/project.part.yml` |
| 05 widgets | `Widgets/project.part.yml` |
| 07 Safari | `Extensions/safari/project.part.yml` |

A part contains top-level XcodeGen keys, usually just `targets:`. Do not repeat `name`, `options`, `packages` or root settings.

## Paths

Paths inside a part (`sources`, `path`, `INFOPLIST_FILE`, entitlements) are relative to the part file, because the root spec includes each part with `relativePaths: true`. Verified with two parts that both use `sources: [Sources]`. The package path `Packages/DroverKit` in the root is relative to the repo root.

## Targets and schemes

- Use the names pinned in CONTRACT.md where they exist (`DroverWidgets-iOS`, `DroverWidgets-macOS`, `DroverWidgets-watchOS`). Otherwise name targets `Drover<Thing>-<platform>`.
- Put `scheme: {}` on every app target so CI builds it. `script/ci-build.sh` builds every scheme except the DroverKit package ones, unsigned, once per platform. Extension targets are built as dependencies of their host app.
- Depend on the shared client with `- package: DroverKit`.
- Host apps list their widget or extension targets under `dependencies` to embed them.

## Identifiers and entitlements

- Bundle ids follow CONTRACT.md "Apple identifiers" (prefix `dev.drover`).
- App Group: `group.dev.drover`.
- Keychain access group: `$(AppIdentifierPrefix)dev.drover.shared`.

## Signing

Do not set a development team in a part. The root sets `DEVELOPMENT_TEAM` from the `DROVER_TEAM_ID` environment variable. Export it for signed local builds. When it is unset, XcodeGen leaves the literal `${DROVER_TEAM_ID}` in the project, which Xcode resolves to empty at build time (not run here, since xcodebuild is unavailable), as unsigned CI builds want.

### CI signing

`script/ci-sign.sh` signs manually (never `-allowProvisioningUpdates`, which minted a new Apple Development certificate on every clean runner until the account hit its cap). It imports a `.p12` secret into a throwaway keychain, creates profiles named `drover-ci-<bundle id>` through the ASC API (`script/asc-signing.py`), and archives with `CODE_SIGN_STYLE=Manual` and `PROVISIONING_PROFILE_SPECIFIER=drover-ci-$(PRODUCT_BUNDLE_IDENTIFIER)` as command-line overrides, so the `Automatic` style in the parts is untouched for local builds. New app or extension targets need their bundle ID added to the lists in `ci-sign.sh`, and the App Groups capability enabled for it in the developer portal. `dev.drover.menubar` also needs Time Sensitive Notifications enabled there (its entitlements ask for it; the App Store Connect API lists `USERNOTIFICATIONS_TIMESENSITIVE` but refuses to create it, so `asc-signing.py` cannot turn it on; enabled for `dev.drover.menubar` on 2026-10-16); without it the DroverMenuBar archive fails with "Provisioning profile … doesn't include the Time Sensitive Notifications capability".

One-time certificate creation: `ASC_KEY_ID=... ASC_ISSUER_ID=... ASC_KEY_PATH=AuthKey.p8 native/script/asc-signing.py new-cert --type DEVELOPER_ID_APPLICATION --out ~/drover-devid` (or `DISTRIBUTION`), then store `base64 -i cert.p12` and the printed password as the `*_P12` and `*_P12_PASSWORD` repo secrets. Apple may restrict Developer ID certificates to the Account Holder; if the API refuses, create it in Xcode or the portal and export a `.p12` from Keychain Access.

## Generating and building

```
script/generate.sh
```

This writes `Drover.xcodeproj` at the repo root (git-ignored). XcodeGen fails on an included file that does not exist, so the script skips parts that are not there yet and prints which ones. Do not run a bare `xcodegen generate`.

Building needs a working Xcode. On this machine the license has not been accepted, so `xcodebuild` refuses to run. The machine's owner runs `sudo xcodebuild -license accept` once; agents must not. After that:

```
xcodebuild -list -project Drover.xcodeproj
xcodebuild build -project Drover.xcodeproj -scheme <scheme> -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO
```

`script/ci-build.sh` does all of this, plus `swift test` for DroverKit, and is what the GitHub workflow runs.
