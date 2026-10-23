# Sourced by tools/*.sh. The SDK, the SwiftUI macro plugins of the selected Xcode (xcode-select -p; falls back to
# /Applications/Xcode.app), and DroverKit compiled as a static module, so the swiftc-only builds can
# `import DroverKit` like the Xcode target does (project.part.yml depends on the package).
# usage: source "$here/tools/env.sh"; droverkit_build "$here/.build/droverkit"; swiftc ... "${DROVERKIT_FLAGS[@]}"
SDK=/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk
TARGET=arm64-apple-macos14.0
_dev="$(xcode-select -p 2>/dev/null || true)"
case "$_dev" in *.app/Contents/Developer) ;; *) _dev=/Applications/Xcode.app/Contents/Developer ;; esac
PLUGINS="$_dev/Platforms/MacOSX.platform/Developer/usr/lib/swift/host/plugins"
DROVERKIT_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../Packages/DroverKit/Sources/DroverKit" && pwd)"

droverkit_build() { # out-dir: writes libDroverKit.a and DroverKit.swiftmodule there, sets DROVERKIT_FLAGS
  local out="$1"; mkdir -p "$out"
  local srcs=(); while IFS= read -r f; do srcs+=("$f"); done < <(find "$DROVERKIT_SRC" -name '*.swift')
  env -u DEVELOPER_DIR swiftc -parse-as-library -swift-version 6 -module-name DroverKit -sdk "$SDK" -target "$TARGET" \
    -plugin-path "$PLUGINS" -Onone -g -emit-module -emit-module-path "$out/DroverKit.swiftmodule" \
    -emit-library -static -o "$out/libDroverKit.a" "${srcs[@]}"
  DROVERKIT_FLAGS=(-I "$out" -L "$out" -lDroverKit)
}
