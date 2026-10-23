#!/usr/bin/env bash
# Compile and RUN the watch app's platform-neutral logic on macOS (swiftc links and runs
# with the CommandLineTools SDK even without Xcode's license). Covers Sources/Core,
# Shared, and every Sources/*/Logic dir: Foundation-only code, no SwiftUI/WatchKit.
# usage: Apps/watchOS/Tests/run-logic-tests.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; app="$(dirname "$here")"; repo="$(cd "$app/../.." && pwd)"
out="$(mktemp -d)"; trap 'rm -rf "$out"' EXIT
files=()
while IFS= read -r f; do files+=("$f"); done < <(
  { find "$app/Sources/Core" "$app/Shared" -name '*.swift'
    find "$app/Sources" -path '*/Logic/*.swift'
    find "$here/Logic" -name '*.swift'; } | sort -u)
env -u DEVELOPER_DIR swiftc -swift-version 6 -sdk /Library/Developer/CommandLineTools/SDKs/MacOSX.sdk \
  -target arm64-apple-macos14.0 -o "$out/watch-logic-tests" "${files[@]}"
DROVER_FIXTURES="$here/Fixtures" DROVER_REPO_FIXTURES="$repo/Fixtures" "$out/watch-logic-tests"
