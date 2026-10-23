#!/usr/bin/env bash
# Logic tests WITHOUT XCTest (xcodebuild/swift test need the Xcode license): compiles Sources (minus the @main
# entry) plus Tests/Harness/*.swift into an executable and runs it. Exit code is the number of failures (0 = green).
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
source "$here/tools/env.sh"
droverkit_build "$here/.build/droverkit"
bin="$here/.build/harness"; mkdir -p "$(dirname "$bin")"
srcs=(); while IFS= read -r f; do srcs+=("$f"); done < <(find "$here/Sources" -name '*.swift' ! -path '*/App/DroverMacApp.swift'; find "$here/Tests/Harness" -name '*.swift')
env -u DEVELOPER_DIR swiftc -swift-version 6 -sdk "$SDK" -target "$TARGET" -plugin-path "$PLUGINS" -Onone \
  "${DROVERKIT_FLAGS[@]}" -o "$bin" "${srcs[@]}"
"$bin" "$@"
