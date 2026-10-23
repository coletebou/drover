#!/usr/bin/env bash
# Run the native XCTest suite (Native/Shared + Native/Tests) WITHOUT xcodebuild, which refuses to run
# until the Xcode license is accepted. swiftc links a test bundle against Xcode.app's XCTest and
# Xcode's xctest runner executes it. macOS only; the iOS targets are typecheck-only here.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV="$(xcode-select -p 2>/dev/null || echo /Applications/Xcode.app/Contents/Developer)"
# A Mac without the license (or an admin to accept it) often selects the Command Line Tools, which have no XCTest.
[ -d "$DEV/Platforms/MacOSX.platform/Developer/Library/Frameworks/XCTest.framework" ] || DEV=/Applications/Xcode.app/Contents/Developer
P="$DEV/Platforms/MacOSX.platform/Developer"
SDK=/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk
[ -d "$P/Library/Frameworks/XCTest.framework" ] || { echo "XCTest.framework not found under $P" >&2; exit 2; }
OUT="$(mktemp -d)"; trap 'rm -rf "$OUT"' EXIT
B="$OUT/DroverSafariNativeTests.xctest/Contents"
mkdir -p "$B/MacOS"
env -u DEVELOPER_DIR swiftc -parse-as-library -swift-version 6 -sdk "$SDK" -target arm64-apple-macos14.0 \
  -F "$P/Library/Frameworks" -I "$P/usr/lib" -L "$P/usr/lib" -framework XCTest \
  -Xlinker -bundle -Xlinker -rpath -Xlinker "$P/Library/Frameworks" -Xlinker -rpath -Xlinker "$P/usr/lib" \
  -emit-executable -o "$B/MacOS/DroverSafariNativeTests" "$DIR"/Native/Shared/*.swift "$DIR"/Native/Tests/*.swift
cat > "$B/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>DroverSafariNativeTests</string>
<key>CFBundleIdentifier</key><string>dev.drover.safari.tests</string>
<key>CFBundlePackageType</key><string>BNDL</string>
</dict></plist>
PLIST
DYLD_FRAMEWORK_PATH="$P/Library/Frameworks" DYLD_LIBRARY_PATH="$P/usr/lib" "$DEV/usr/bin/xctest" "$OUT/DroverSafariNativeTests.xctest"
