#!/usr/bin/env bash
# Verify the widgets without Xcode's license: unit tests for the Foundation core (swift test), then
# swiftc -typecheck of every widget source against the real iOS, macOS and watchOS SDKs (no link, no run).
# usage: Widgets/script/check.sh [test|ios|macos|watchos|sil ...]   (default: all)
set -euo pipefail
cd "$(dirname "$0")/../.."
steps=("${@:-test ios macos watchos sil}")
for s in ${steps[@]}; do
  case "$s" in
    # With only the Command Line Tools, swiftc does not always find the Swift Testing macro plugin
    # ("plugin for module 'TestingMacros' not found"); point it there explicitly when it exists.
    test)    tp=/Library/Developer/CommandLineTools/usr/lib/swift/host/plugins/testing; extra=()
             [ -d "$tp" ] && extra=(-Xswiftc -plugin-path -Xswiftc "$tp")
             swift test --package-path Widgets "${extra[@]}" 2>&1 | tail -n 3
             [ "${PIPESTATUS[0]}" = 0 ] ;;
    ios)     script/typecheck.sh ios Widgets/Core Widgets/UI Widgets/Bundles/iOS ;;
    macos)   script/typecheck.sh macos Widgets/Core Widgets/UI Widgets/Bundles/macOS ;;
    watchos) script/typecheck.sh watchos Widgets/Core Widgets/UI Widgets/Bundles/watchOS ;;
    # Full SIL pass (definite initialization, exclusivity, etc.), which -typecheck skips. Reuses script/typecheck.sh
    # with -typecheck swapped for a whole-module -emit-sil, so both share the SDK and plugin setup.
    sil)     t=$(mktemp); sed 's/swiftc -typecheck/swiftc -emit-sil -wmo -module-name DroverWidgets -o \/dev\/null/; s/typecheck ok/sil ok/' \
               script/typecheck.sh > "$t"
             for p in iOS:ios macOS:macos watchOS:watchos; do
               bash "$t" "${p#*:}" Widgets/Core Widgets/UI "Widgets/Bundles/${p%%:*}" || { rm -f "$t"; exit 1; }
             done; rm -f "$t" ;;
    *) echo "unknown step $s" >&2; exit 2 ;;
  esac
done
