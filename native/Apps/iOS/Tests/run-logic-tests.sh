#!/usr/bin/env bash
# Builds and runs the iOS app's platform-neutral logic (Core models, API client, parsers, pure helpers)
# as a macOS executable. swiftc compiles and links without the Xcode license; xcodebuild does not.
# DroverKit (the prompt spool's models; DroverAPI refines PromptsAPI) is compiled first as a static module, the way
# Apps/macOS/tools/env.sh does it, so files that `import DroverKit` build here too.
# usage: Apps/iOS/Tests/run-logic-tests.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; src="$here/../Sources"
out="$(mktemp -d)"; trap 'rm -rf "$out"' EXIT
# Files that import UIKit/SwiftUI stay out; logic files list themselves in LOGIC_FILES below.
LOGIC_FILES=(
  Core/Identifiers.swift Core/JSONValue.swift Core/Models.swift Core/Approvals.swift Core/DroverAPI.swift Core/MockDroverAPI.swift
  Core/TokenVault.swift Core/SummaryCache.swift Core/AppModel.swift Core/UnconfiguredDroverAPI.swift Core/SingleFlight.swift
  Prompts/PromptsAPI.swift
)
# Each slice lists its own Foundation-only source files (relative to Sources/) in logic-files.d/<slice>.txt.
extra=(); for lst in "$here"/logic-files.d/*.txt; do [ -f "$lst" ] || continue
  while IFS= read -r l; do case "$l" in ''|'#'*) ;; *) extra+=("$l") ;; esac; done < "$lst"; done
files=(); for f in "${LOGIC_FILES[@]}" ${extra[@]+"${extra[@]}"}; do files+=("$src/$f"); done
SDK=/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk
kit=(); while IFS= read -r f; do kit+=("$f"); done < <(find "$here/../../../Packages/DroverKit/Sources/DroverKit" -name '*.swift')
env -u DEVELOPER_DIR swiftc -parse-as-library -swift-version 6 -module-name DroverKit -sdk "$SDK" -target arm64-apple-macos14.0 \
  -emit-module -emit-module-path "$out/DroverKit.swiftmodule" -emit-library -static -o "$out/libDroverKit.a" "${kit[@]}"
env -u DEVELOPER_DIR swiftc -swift-version 6 -parse-as-library -sdk "$SDK" \
  -target arm64-apple-macos14.0 -I "$out" -L "$out" -lDroverKit "${files[@]}" "$here"/Logic/*.swift -o "$out/logic-tests"
"$out/logic-tests"
