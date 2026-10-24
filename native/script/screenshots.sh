#!/usr/bin/env bash
# Simulator screenshots of the iPhone and Apple Watch apps on their synthetic data (`--mock`, no network): Board, a
# session, Manager and Sessions on the iPhone in dark and light, the waiting list and a session on the watch (watchOS
# has no light appearance). Builds both apps unsigned for the simulator, creates a fresh iPhone (newest Pro) and Apple
# Watch (newest Series) on the newest runtimes, sets a clean status bar, and deletes both simulators when done.
# Needs Xcode and xcodegen. CI: .github/workflows/screenshots.yml.
# usage: script/screenshots.sh [output dir]   (default .build/screenshots; SCREENSHOT_WAIT=<seconds per screen>, default 6)
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:-$root/.build/screenshots}"
mkdir -p "$out" && out="$(cd "$out" && pwd)"
cd "$root"
wait_s="${SCREENSHOT_WAIT:-6}"
dd=.build/screenshots-derived
ios_id=dev.drover.app
watch_id=dev.drover.app.watchkitapp

phone="" watch=""
since=$(mktemp)   # crash reports newer than this file belong to this run
cleanup() {
  for d in $watch $phone; do
    xcrun simctl shutdown "$d" >/dev/null 2>&1 || true
    xcrun simctl delete "$d" >/dev/null 2>&1 || true
  done
  rm -f "$since"
}
trap cleanup EXIT

xcodebuild -version
# Newest iOS and watchOS runtimes, newest "iPhone N Pro" and largest "Apple Watch Series N (Nmm)" they support.
read -r ios_rt phone_type watch_rt watch_type < <(xcrun simctl list -j runtimes | python3 -c '
import json, re, sys
rts = [r for r in json.load(sys.stdin)["runtimes"] if r.get("isAvailable")]
def nums(s): return tuple(int(x) for x in re.findall(r"\d+", s))
def newest(platform):
    found = [r for r in rts if r.get("platform", r["name"].split()[0]) == platform]
    if not found: sys.exit(f"no available {platform} simulator runtime")
    return max(found, key=lambda r: nums(r["version"]))
def device(rt, pattern):
    types = [(nums(t["name"]), t) for t in rt.get("supportedDeviceTypes", []) if re.fullmatch(pattern, t["name"])]
    if not types: sys.exit("no device type like %r for %s" % (pattern, rt["name"]))
    return max(types, key=lambda p: p[0])[1]
ios, wos = newest("iOS"), newest("watchOS")
print(ios["identifier"], device(ios, r"iPhone \d+ Pro")["identifier"],
      wos["identifier"], device(wos, r"Apple Watch Series \d+ \(\d+mm\)")["identifier"])
')
echo "== simulators: $phone_type on $ios_rt, $watch_type on $watch_rt"
phone=$(xcrun simctl create "Drover screenshots iPhone" "$phone_type" "$ios_rt")
watch=$(xcrun simctl create "Drover screenshots Watch" "$watch_type" "$watch_rt")
xcrun simctl pair "$watch" "$phone" >/dev/null || echo "note: could not pair the simulators, continuing unpaired"
# Boot while building; bootstatus waits further down.
xcrun simctl boot "$phone"
xcrun simctl boot "$watch"

echo "== generate project"
script/generate.sh

build() { # scheme destination-id
  echo "== build $1"
  local log; log=$(mktemp)
  if ! xcodebuild build -project Drover.xcodeproj -scheme "$1" -configuration Debug -destination "id=$2" \
      -derivedDataPath "$dd" -skipPackagePluginValidation \
      CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" >"$log" 2>&1; then
    grep -E 'error:|xcodebuild: error' "$log" | sort -u | head -40 || true
    tail -n 40 "$log"
    exit 1
  fi
  rm -f "$log"
}
build DroveriOS "$phone"
build DroverWatch "$watch"

xcrun simctl bootstatus "$phone"
xcrun simctl bootstatus "$watch"
xcrun simctl install "$phone" "$dd/Build/Products/Debug-iphonesimulator/Drover.app"
xcrun simctl install "$watch" "$dd/Build/Products/Debug-watchsimulator/DroverWatch.app"
xcrun simctl status_bar "$phone" override --time 9:41 --batteryState charged --batteryLevel 100 --cellularBars 4 --wifiBars 3
xcrun simctl status_bar "$watch" override --time 9:41 >/dev/null 2>&1 || echo "note: no status bar override on the watch"

shot() { # device bundle-id file [app arguments after --mock]
  local dev=$1 app=$2 file=$3; shift 3
  xcrun simctl terminate "$dev" "$app" >/dev/null 2>&1 || true
  xcrun simctl launch "$dev" "$app" --mock "$@" >/dev/null
  sleep "$wait_s"
  xcrun simctl io "$dev" screenshot --type=png "$out/$file" >/dev/null
  echo "saved $file"
}

# A first launch is slow (caches, first render); never photograph it.
for d in "$phone:$ios_id" "$watch:$watch_id"; do
  xcrun simctl launch "${d%%:*}" "${d#*:}" --mock >/dev/null
done
sleep $((wait_s * 2))

echo "== iPhone"
for look in dark light; do
  xcrun simctl ui "$phone" appearance "$look"
  sleep 1
  shot "$phone" "$ios_id" "ios-board-$look.png"
  shot "$phone" "$ios_id" "ios-session-$look.png" --mock-session 11111111-aaaa-4bbb-8ccc-000000000001
  shot "$phone" "$ios_id" "ios-manager-$look.png" --mock-tab manager
  shot "$phone" "$ios_id" "ios-sessions-$look.png" --mock-tab sessions
done

echo "== Apple Watch"
shot "$watch" "$watch_id" watch-list-dark.png
shot "$watch" "$watch_id" watch-session-dark.png --mock-session s-demo-build

# A crash only shows as a home screen in the picture: keep its report next to the screenshots and fail.
crashes=$(find ~/Library/Logs/DiagnosticReports -name 'Drover*' -newer "$since" 2>/dev/null || true)
if [ -n "$crashes" ]; then
  mkdir -p "$out/crash-reports"
  while IFS= read -r c; do echo "crash report: $c"; cp "$c" "$out/crash-reports/"; done <<< "$crashes"
  exit 1
fi
echo "== $(find "$out" -name '*.png' | wc -l | tr -d ' ') screenshots in $out"
