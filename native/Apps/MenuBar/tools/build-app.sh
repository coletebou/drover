#!/usr/bin/env bash
# A runnable dev build of the menu bar app WITHOUT xcodebuild (the Xcode license is not accepted on this Mac;
# swiftc from the Command Line Tools links fine). It is not the real app and cannot pass for it:
#   - bundle id dev.drover.menubar.dev, no URL types (it never claims drover://), ad hoc signed, no entitlements;
#   - compiled with -D DROVER_DEV (App/Dev/DevSupport.swift): tokens from the daemon's state folder
#     (~/.local/state/drover/token, widget-token; DROVER_STATE overrides), server from DROVER_URL
#     (default http://127.0.0.1:7337), its own defaults, no App Group mirror or widget cache, no global
#     shortcut, no notifications (DROVER_DEV_NOTIFICATIONS=1), no menu bar item (DROVER_DEV_MENUBAR=1),
#     and Open only logs (DROVER_DEV_OPEN=1 opens for real);
#   - DROVER_DEV_SCRIPT runs the popover's own store calls and renders the real PopoverView offscreen to
#     DROVER_DEV_SNAPSHOT; keys, messages and sweeps are refused against the live daemon on port 7337.
# It is never copied into an Applications folder. Run it, then quit it and unregister it:
#   app=$(tools/build-app.sh)
#   DROVER_URL=http://127.0.0.1:7338 DROVER_DEV_SNAPSHOT=/tmp/snaps DROVER_DEV_SCRIPT='snap:start;quit' "$app/Contents/MacOS/DroverMenuBarDev"
#   /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u "$app"
# usage: tools/build-app.sh [out-dir]   (prints the .app path; default .build/dev)
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
source "$here/tools/env.sh"
out="${1:-$here/.build/dev}"
case "$out" in
  "$HOME/Applications"*|/Applications*) echo "build-app.sh: refusing to build into an Applications folder" >&2; exit 1 ;;
esac
app="$out/DroverMenuBarDev.app"
rm -rf "$app"; mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
find "$here/App" "$here/Sources" -name '*.swift' -print0 | xargs -0 env -u DEVELOPER_DIR swiftc -parse-as-library -swift-version 6 \
  -sdk "$SDK" -target "$TARGET" -plugin-path "$PLUGINS" -D DROVER_DEV -Onone -g \
  -module-name DroverMenuBar -o "$app/Contents/MacOS/DroverMenuBarDev"
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>dev.drover.menubar.dev</string>
  <key>CFBundleName</key><string>DroverMenuBarDev</string>
  <key>CFBundleDisplayName</key><string>Drover Menu Bar (dev)</string>
  <key>CFBundleExecutable</key><string>DroverMenuBarDev</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST
codesign --force --sign - "$app" >/dev/null 2>&1
echo "$app"
