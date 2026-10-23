#!/usr/bin/env bash
# Build Apps/macOS into a runnable, ad-hoc signed .app WITHOUT xcodebuild (the Xcode license is not accepted
# on this Mac; swiftc from the Command Line Tools links fine). Unsandboxed dev build, compiled with -D DROVER_DEV:
# - its own bundle id (dev.drover.macos.dev) and URL scheme (droverdev://), so it never takes drover:// from the
#   signed Drover.app and the menu bar app (the check below fails the build if the plist declares drover);
# - the token from the daemon's token file and the server from DROVER_URL (Sources/Core/DevConfig.swift), no App
#   Group, no widgets, no real notifications unless DROVER_DEV_NOTIFY=1, no writes unless the daemon is the test
#   one on port 7338 or DROVER_DEV_ALLOW_WRITES=1.
# The real build is the XcodeGen target in project.part.yml. usage: tools/build-app.sh [out-dir]   (prints the .app path)
# Run:  open --env DROVER_URL=http://127.0.0.1:7338 --stderr /tmp/drover-dev.log "$(tools/build-app.sh)"
# After: quit it, then lsregister -u the .app (README "Dev build").
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
source "$here/tools/env.sh"
droverkit_build "$here/.build/droverkit" >&2
out="${1:-$here/.build/dev}"
app="$out/Drover.app"
rm -rf "$app"; mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
find "$here/Sources" -name '*.swift' -print0 | xargs -0 env -u DEVELOPER_DIR swiftc -parse-as-library -swift-version 6 \
  -sdk "$SDK" -target "$TARGET" -plugin-path "$PLUGINS" "${DROVERKIT_FLAGS[@]}" -D DROVER_DEV -Onone -g -o "$app/Contents/MacOS/Drover"
sed -e 's/$(EXECUTABLE_NAME)/Drover/; s/$(PRODUCT_BUNDLE_IDENTIFIER)/dev.drover.macos.dev/; s/$(MARKETING_VERSION)/0.1.0/; s/$(CURRENT_PROJECT_VERSION)/1/' \
  -e 's/$(PRODUCT_NAME)/Drover Dev/; s/$(MACOSX_DEPLOYMENT_TARGET)/14.0/; s/$(DEVELOPMENT_LANGUAGE)/en/' \
  -e '/CFBundleDisplayName/{n;s#<string>.*</string>#<string>Drover Dev</string>#;}' \
  -e 's#<string>drover</string>#<string>droverdev</string>#; s#<string>dev.drover.macos</string>#<string>dev.drover.macos.dev</string>#' \
  -e '/DroverKeychainAccessGroup/{n;s#<string>.*</string>#<string></string>#;}' \
  "$here/Resources/Info.plist" > "$app/Contents/Info.plist"
schemes="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleURLTypes:0:CFBundleURLSchemes' "$app/Contents/Info.plist")"
if ! grep -qx '    droverdev' <<<"$schemes" || grep -qx '    drover' <<<"$schemes"; then
  echo "build-app.sh: the dev build must declare droverdev:// only, got: $schemes" >&2; rm -rf "$app"; exit 1
fi
codesign --force --sign - "$app" >/dev/null 2>&1
echo "$app"
