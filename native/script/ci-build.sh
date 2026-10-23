#!/usr/bin/env bash
# CI entry point for the macOS runner: DroverKit tests, project generation, one unsigned build per scheme,
# chrome extension tests. Keeps going after a failure and exits non-zero at the end if anything failed.
set -euo pipefail
cd "$(dirname "$0")/.."

failed=()
summary=()
record() { # name status
  summary+=("$(printf '%-40s %s' "$1" "$2")")
  [ "$2" = "ok" ] || [ "$2" = "skipped" ] || failed+=("$1")
}

echo "== swift test (DroverKit)"
if swift test --package-path Packages/DroverKit; then record "DroverKit tests" ok; else record "DroverKit tests" FAIL; fi

echo "== swift test (menu bar logic)"
if [ -f Apps/MenuBar/Package.swift ]; then
  if swift test --package-path Apps/MenuBar; then record "MenuBar tests" ok; else record "MenuBar tests" FAIL; fi
else
  record "MenuBar tests" skipped
fi

echo "== generate project"
script/generate.sh

PROJECT=Drover.xcodeproj
schemes=$(xcodebuild -list -json -project "$PROJECT" | python3 -c '
import json, sys
d = json.load(sys.stdin)["project"]
for s in d.get("schemes", []):
    print(s)
')

while IFS= read -r scheme; do
  [ -n "$scheme" ] || continue
  # Swift package schemes (DroverKit, MenuBarCore) are covered by the swift test steps above and have no app platform.
  case "$scheme" in DroverKit*|MenuBarCore*|*-Package) echo "== skip package scheme $scheme"; continue ;; esac
  platform=$(xcodebuild -showBuildSettings -json -scheme "$scheme" -project "$PROJECT" 2>/dev/null | python3 -c '
import json, sys
for entry in json.load(sys.stdin):
    s = entry.get("buildSettings", {})
    print(s.get("PLATFORM_NAME") or s.get("SDKROOT") or "")
    break
' || true)
  case "$platform" in
    macosx*)   dest="generic/platform=macOS" ;;
    iphoneos*) dest="generic/platform=iOS" ;;
    watchos*)  dest="generic/platform=watchOS" ;;
    *) echo "== $scheme: unknown platform '$platform'"; record "$scheme" "FAIL (platform)"; continue ;;
  esac
  echo "== build $scheme ($dest)"
  log=$(mktemp)
  flags=(CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" -skipPackagePluginValidation)
  if xcodebuild build -project "$PROJECT" -scheme "$scheme" -destination "$dest" "${flags[@]}" >"$log" 2>&1; then
    record "$scheme ($dest)" ok
  else
    # The compiler errors sit far above the tail, so print them explicitly.
    grep -E 'error:|xcodebuild: error' "$log" | sort -u | head -40 || true
    head -n 30 <(grep -A12 'Unable to find a destination' "$log" || true)
    tail -n 40 "$log"
    record "$scheme ($dest)" FAIL
  fi
  rm -f "$log"
done <<< "$schemes"

echo "== chrome extension tests"
if [ -d Extensions/chrome/test ] && command -v node >/dev/null; then
  if node --test 'Extensions/chrome/test/**/*.test.js'; then record "chrome tests" ok; else record "chrome tests" FAIL; fi
else
  echo "no Extensions/chrome/test (or no node), skipping"
  record "chrome tests" skipped
fi

echo
echo "== summary"
printf '%s\n' "${summary[@]}"
if [ "${#failed[@]}" -gt 0 ]; then
  echo "FAILED: ${failed[*]}"
  exit 1
fi
echo "all ok"
