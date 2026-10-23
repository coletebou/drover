#!/usr/bin/env bash
# Full compile (-c, not -typecheck) of each Safari target's Swift sources; catches definite-initialization errors.
set -uo pipefail
fail=0
R="$(cd "$(dirname "${BASH_SOURCE[0]}")/../Native" && pwd)"
X="$(xcode-select -p 2>/dev/null || echo /Applications/Xcode.app/Contents/Developer)/Platforms"
O=$(mktemp -d); trap 'rm -rf "$O"' EXIT
compile() {
  local plat=$1; shift
  local SDK TGT PD
  case $plat in
    macos) SDK=/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk; TGT=arm64-apple-macos14.0; PD=$X/MacOSX.platform ;;
    ios)   SDK=$X/iPhoneOS.platform/Developer/SDKs/iPhoneOS.sdk; TGT=arm64-apple-ios17.0; PD=$X/iPhoneOS.platform ;;
  esac
  local files=(); for d in "$@"; do while IFS= read -r f; do files+=("$f"); done < <(find "$R/$d" -name '*.swift'); done
  ( cd "$O" && env -u DEVELOPER_DIR swiftc -c -parse-as-library -swift-version 6 -sdk "$SDK" -target "$TGT" \
      -plugin-path "$PD/Developer/usr/lib/swift/host/plugins" -module-name DroverSafariCheck "${files[@]}" > "$O/log" 2>&1 )
  local rc=$?
  grep -E "error|warning" "$O/log" | head -5
  echo "compile $plat [$*] (${#files[@]} files) rc=$rc"; [ $rc -eq 0 ] || fail=1
}
compile macos Shared Extension
compile ios Shared Extension
exit $fail
