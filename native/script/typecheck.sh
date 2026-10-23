#!/usr/bin/env bash
# Typecheck Swift sources against the real Apple SDKs WITHOUT Xcode's license being
# accepted (xcodebuild/swift build refuse without it; swiftc -typecheck does not).
# usage: script/typecheck.sh <macos|ios|watchos> <swift files or dirs...>
# It type-checks only: no link, no sign, no run. Say so in your report.
set -euo pipefail
plat="${1:?macos|ios|watchos}"; shift
X=/Applications/Xcode.app/Contents/Developer/Platforms
case "$plat" in
  macos)   SDK=/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk; TGT=arm64-apple-macos14.0 ;;
  ios)     SDK=$X/iPhoneOS.platform/Developer/SDKs/iPhoneOS.sdk;    TGT=arm64-apple-ios17.0 ;;
  watchos) SDK=$X/WatchOS.platform/Developer/SDKs/WatchOS.sdk;      TGT=arm64_32-apple-watchos10.0 ;;
  *) echo "unknown platform $plat" >&2; exit 2 ;;
esac
files=()
for p in "$@"; do if [ -d "$p" ]; then while IFS= read -r f; do files+=("$f"); done < <(find "$p" -name '*.swift' -not -path '*/.build/*' -not -path '*Tests/*'); else files+=("$p"); fi; done
[ "${#files[@]}" -gt 0 ] || { echo "no swift files" >&2; exit 2; }
# SwiftUI's @State/@Entry/@Previewable are macros whose plugin ships only inside Xcode.app (the Command Line
# Tools toolchain has Observation's but not SwiftUI's), so point swiftc at the platform's plugin dir.
plat_dir=$X/$(case "$plat" in macos) echo MacOSX;; ios) echo iPhoneOS;; watchos) echo WatchOS;; esac).platform
plugins=(); [ -d "$plat_dir/Developer/usr/lib/swift/host/plugins" ] && plugins=(-plugin-path "$plat_dir/Developer/usr/lib/swift/host/plugins")
env -u DEVELOPER_DIR swiftc -typecheck -parse-as-library -swift-version 6 -sdk "$SDK" -target "$TGT" ${plugins[@]+"${plugins[@]}"} "${files[@]}"
echo "typecheck ok: $plat (${#files[@]} files)"
