#!/usr/bin/env bash
# Drive the dev build (tools/build-app.sh) for checks without Screen Recording or Accessibility permissions.
#   tools/dev-app.sh start [server-url]   launch it (default the test daemon http://127.0.0.1:7338), log to $LOG
#   tools/dev-app.sh stop                 quit it and unregister it from LaunchServices
#   tools/dev-app.sh open <droverdev://…> send it a URL (debug hooks: Sources/App/DevHooks.swift)
#   tools/dev-app.sh windows              on-screen main windows of its process (tools/window-count.swift)
#   tools/dev-app.sh pid
# DROVER_DEV_NO_ACTIVATE=1 keeps it from taking focus. It never registers drover:// (build-app.sh checks).
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
app="$here/.build/dev/Drover.app"
LOG="${LOG:-/tmp/drover-dev.log}"
lsr=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
pid() { pgrep -f "$app/Contents/MacOS/Drover" | head -1 || true; }
counter() {
  [ -x "$here/.build/window-count" ] || env -u DEVELOPER_DIR swiftc -sdk /Library/Developer/CommandLineTools/SDKs/MacOSX.sdk -O \
    -o "$here/.build/window-count" "$here/tools/window-count.swift"
  "$here/.build/window-count" "$@"
}
case "${1:-}" in
  start)
    [ -z "$(pid)" ] || { echo "already running (pid $(pid))" >&2; exit 1; }
    "$lsr" -f "$app"
    rm -f "$LOG"
    envs=(--env "DROVER_URL=${2:-http://127.0.0.1:7338}")
    [ "${DROVER_DEV_NO_ACTIVATE:-}" = 1 ] && envs+=(--env DROVER_DEV_NO_ACTIVATE=1)
    [ "${DROVER_DEV_NOTIFY:-}" = 1 ] && envs+=(--env DROVER_DEV_NOTIFY=1)
    open -g "${envs[@]}" --stderr "$LOG" "$app"
    for _ in $(seq 1 50); do [ -n "$(pid)" ] && break; sleep 0.1; done
    echo "pid $(pid)"
    ;;
  stop)
    p="$(pid)"
    if [ -n "$p" ]; then kill "$p"; for _ in $(seq 1 50); do kill -0 "$p" 2>/dev/null || break; sleep 0.1; done; fi
    "$lsr" -u "$app" 2>/dev/null || true
    echo "stopped"
    ;;
  open) open -g "$2" ;;
  windows) p="$(pid)"; [ -n "$p" ] && counter "$p" "${@:2}" || echo "not running" ;;
  pid) pid ;;
  *) sed -n '2,8p' "$0"; exit 2 ;;
esac
