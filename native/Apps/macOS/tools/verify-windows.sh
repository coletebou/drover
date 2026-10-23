#!/usr/bin/env bash
# Proves the dev build keeps one main window: launch, repeated droverdev:// opens, notification-tap routing, the
# manager panel, close and reopen (by URL and by a Dock-style reopen). Counts on-screen layer-0 windows of the app's
# process (tools/window-count.swift; the floating panel is not layer 0). Needs a built .build/dev/Drover.app.
# usage: tools/verify-windows.sh [server-url]    (default the test daemon http://127.0.0.1:7338)
# DROVER_DEV_NO_ACTIVATE=1 (the default here) keeps it from taking focus; ACTIVATE=1 lets it, to check activation.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
dev="$here/tools/dev-app.sh"
app="$here/.build/dev/Drover.app"
LOG="${LOG:-/tmp/drover-dev.log}"; export LOG
[ "${ACTIVATE:-}" = 1 ] || export DROVER_DEV_NO_ACTIVATE=1
fails=0
check() { # label expected
  sleep "${WAIT:-1.2}"
  local n; n="$("$dev" windows)"
  if [ "$n" = "$2" ]; then echo "ok    $1: $n main window(s)"; else echo "FAIL  $1: $n main window(s), expected $2"; fails=$((fails + 1)); fi
}
"$dev" stop >/dev/null
"$dev" start "${1:-http://127.0.0.1:7338}" >/dev/null
sleep 4
check "launch" 1
for i in 1 2 3 4 5; do "$dev" open "droverdev://session/demo-session-$i?host=local"; check "session URL $i" 1; done
"$dev" open "droverdev://board"; check "board URL" 1
"$dev" open "droverdev://manager?in=window"; check "manager in the window" 1
for i in 1 2; do "$dev" open "droverdev://debug/notification-tap?session=demo-tap-$i&host=local"; check "notification tap $i" 1; done
"$dev" open "droverdev://manager"; check "manager panel (main windows unchanged)" 1
"$dev" open "droverdev://debug/state"; sleep 0.8
grep -q "FloatingPanel:visible" "$LOG" && echo "ok    the manager panel is up" || { echo "FAIL  no manager panel"; fails=$((fails + 1)); }
"$dev" open "droverdev://debug/panel"
"$dev" open "droverdev://debug/close-main"; check "closed" 0
p="$("$dev" pid)"; if kill -0 "$p" 2>/dev/null; then echo "ok    still running with no window (pid $p)"; else echo "FAIL  quit when the window closed"; fails=$((fails + 1)); fi
"$dev" open "droverdev://session/demo-session-1?host=local"; check "reopened by a URL" 1
for i in 1 2 3; do "$dev" open "droverdev://session/demo-session-$i?host=local"; check "session URL again $i" 1; done
"$dev" open "droverdev://debug/close-main"; check "closed again" 0
open -g "$app"; check "reopened like a Dock click" 1
"$dev" open "droverdev://debug/state"; sleep 0.8
grep "dev selected=" "$LOG" | tail -1
echo "$fails failure(s)"
exit "$fails"
