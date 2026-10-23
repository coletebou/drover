#!/usr/bin/env bash
# Compile the whole watch app to SIL against the real watchOS SDK (no link, no run, no Xcode
# license needed). Stronger than script/typecheck.sh: SIL passes catch definite-initialization
# and other mandatory-optimization errors that -typecheck never reaches.
# usage: Apps/watchOS/Tests/compile-watch.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; app="$(dirname "$here")"
X=/Applications/Xcode.app/Contents/Developer/Platforms/WatchOS.platform
out="$(mktemp -d)"
files=()
while IFS= read -r f; do files+=("$f"); done < <(find "$app/Sources" "$app/Shared" -name '*.swift' | sort)
env -u DEVELOPER_DIR swiftc -emit-sil -wmo -o "$out/DroverWatch.sil" -parse-as-library -swift-version 6 \
  -sdk "$X/Developer/SDKs/WatchOS.sdk" -target arm64_32-apple-watchos10.0 \
  -plugin-path "$X/Developer/usr/lib/swift/host/plugins" -module-name DroverWatch "${files[@]}"
echo "sil ok: watchos (${#files[@]} files, output in $out)"
