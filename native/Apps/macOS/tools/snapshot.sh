#!/usr/bin/env bash
# Render the app offscreen on MockDroverService data to PNGs (light + dark) for visual review without a display
# grant. usage: tools/snapshot.sh [out-dir]   (default .build/snapshots)
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
source "$here/tools/env.sh"
droverkit_build "$here/.build/droverkit"
out="${1:-$here/.build/snapshots}"; mkdir -p "$out"
bin="$here/.build/snapshot"
srcs=(); while IFS= read -r f; do srcs+=("$f"); done < <(find "$here/Sources" -name '*.swift' ! -path '*/App/DroverMacApp.swift'; find "$here/Tests/Snapshot" -name '*.swift')
env -u DEVELOPER_DIR swiftc -swift-version 6 -sdk "$SDK" -target "$TARGET" -plugin-path "$PLUGINS" -Onone \
  "${DROVERKIT_FLAGS[@]}" -o "$bin" "${srcs[@]}"
"$bin" "$out"
