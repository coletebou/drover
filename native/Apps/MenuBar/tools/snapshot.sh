#!/usr/bin/env bash
# Render the popover offscreen on synthetic data to PNGs (light and dark), for review without a display grant.
# Compiles App (minus the @main entry) and Sources with tools/snapshot/main.swift; no network, no app bundle.
# usage: tools/snapshot.sh [out-dir]   (default .build/snapshots)
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
source "$here/tools/env.sh"
out="${1:-$here/.build/snapshots}"; mkdir -p "$out"
bin="$here/.build/snapshot"; mkdir -p "$(dirname "$bin")"
srcs=(); while IFS= read -r f; do srcs+=("$f"); done < <(find "$here/App" "$here/Sources" -name '*.swift' ! -name DroverMenuBarApp.swift; echo "$here/tools/snapshot/main.swift")
env -u DEVELOPER_DIR swiftc -parse-as-library -swift-version 6 -sdk "$SDK" -target "$TARGET" -plugin-path "$PLUGINS" \
  -D DROVER_SNAPSHOT -Onone -module-name DroverMenuBar -o "$bin" "${srcs[@]}"
"$bin" "$out"
