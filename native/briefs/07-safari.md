# Window 7: Safari Web Extension (Extensions/safari)
Reuse the Chrome extension's `lib/` and UI by building from `Extensions/chrome` at build time (a script that copies
into `Extensions/safari/Resources/`; do NOT fork the code; wait for/pull the `feat/chrome` branch if present, else
write the build script and a placeholder). Swift wrapper: macOS app target + iOS app target hosting the extension
(`SafariWebExtensionHandler`), native messaging handler to read the server URL/token from the shared Keychain group
so the user configures it once in the apps. Differences to handle: `browser.*` vs `chrome.*` namespace shim,
no `sidePanel` (use popup), notifications through the native handler (UserNotifications), `project.part.yml` with both
platform targets and the `com.apple.Safari.web-extension` extension point. Slices: build/copy script + shim, native handler, project spec + docs.
