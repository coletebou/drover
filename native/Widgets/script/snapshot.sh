#!/usr/bin/env bash
# Render the home-screen and desktop widgets offscreen on synthetic data to PNGs (light and dark), for review without
# Xcode's license or a display grant. Compiles Core and UI (the widget bundles' @main left out) with
# script/snapshot/main.swift for macOS; no network, no app bundle.
# usage: Widgets/script/snapshot.sh [out-dir]   (default Widgets/.build/widget-snapshots)
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
source "$here/../Apps/MenuBar/tools/env.sh"
out="${1:-$here/.build/widget-snapshots}"; mkdir -p "$out"
bin="$here/.build/widget-snapshot"; mkdir -p "$(dirname "$bin")"
srcs=(); while IFS= read -r f; do srcs+=("$f"); done < <(find "$here/Core" "$here/UI" -name '*.swift'; echo "$here/script/snapshot/main.swift")
env -u DEVELOPER_DIR swiftc -parse-as-library -swift-version 6 -sdk "$SDK" -target "$TARGET" -plugin-path "$PLUGINS" \
  -Onone -module-name DroverWidgets -o "$bin" "${srcs[@]}"
"$bin" "$out"
