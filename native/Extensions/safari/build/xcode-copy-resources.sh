#!/usr/bin/env bash
# Xcode run-script phase: build the Safari web extension resources from Extensions/chrome and copy
# them into the extension bundle's Resources folder. Never prints environment values.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DROVER_SAFARI_DIR="${DROVER_SAFARI_DIR:-$(cd "$SELF_DIR/.." && pwd)}"

: "${TARGET_BUILD_DIR:?TARGET_BUILD_DIR is not set (run this from an Xcode build phase)}"
: "${UNLOCALIZED_RESOURCES_FOLDER_PATH:?UNLOCALIZED_RESOURCES_FOLDER_PATH is not set}"

build_args=()
if [ "${DROVER_SAFARI_STRICT:-0}" = "1" ]; then
  build_args+=(--strict)
fi

"$DROVER_SAFARI_DIR/build/build-resources.sh" ${build_args[@]+"${build_args[@]}"}

if [ ! -f "$DROVER_SAFARI_DIR/Resources/manifest.json" ]; then
  echo "error: Extensions/safari/Resources/manifest.json is missing after build-resources.sh" >&2
  exit 1
fi

dest="$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH"
mkdir -p "$dest"
rsync -a "$DROVER_SAFARI_DIR/Resources/" "$dest/"
echo "Copied web extension resources into the bundle"
