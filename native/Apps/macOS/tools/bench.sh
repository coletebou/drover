#!/usr/bin/env bash
# Before / after timings of the board and SSE paths on saved daemon payloads (never commit those: they are real data).
# usage: tools/bench.sh <fleet.summary.json> <native.board.json> <sse-stream-file> [native.summary.json]
# The stream file is served over local HTTP so the old reader really iterates URLSession.AsyncBytes byte by byte.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
source "$here/tools/env.sh"
droverkit_build "$here/.build/droverkit"
bin="$here/.build/bench"
srcs=(); while IFS= read -r f; do srcs+=("$f"); done < <(find "$here/Sources" -name '*.swift' ! -path '*/App/DroverMacApp.swift'; find "$here/Tests/Bench" -name '*.swift')
env -u DEVELOPER_DIR swiftc -swift-version 6 -sdk "$SDK" -target "$TARGET" -plugin-path "$PLUGINS" -O \
  "${DROVERKIT_FLAGS[@]}" -o "$bin" "${srcs[@]}"
dir="$(cd "$(dirname "$3")" && pwd)"; port=$((20000 + RANDOM % 20000))
python3 -m http.server "$port" --bind 127.0.0.1 --directory "$dir" >/dev/null 2>&1 & server=$!
trap 'kill $server 2>/dev/null' EXIT
sleep 0.5
"$bin" "$1" "$2" "http://127.0.0.1:$port/$(basename "$3")" "${4:-}"
