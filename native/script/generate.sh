#!/usr/bin/env bash
# Generate Drover.xcodeproj from project.yml. Parts that do not exist yet are skipped
# (xcodegen fails on a missing include), via a filtered copy of the spec in .build/.
set -euo pipefail
cd "$(dirname "$0")/.."

SPEC=project.yml
GEN=.build/project.generated.yml
mkdir -p .build

# Parse "  - path: X" lines (only inside the include: block).
parts=()
while IFS= read -r p; do parts+=("$p"); done < <(
  awk '/^include:/{f=1;next} /^[^ #-]/{f=0} f && $1=="-" && $2=="path:" {print $3}' "$SPEC")

missing=()
for p in "${parts[@]}"; do
  [ -f "$p" ] || missing+=("$p")
done

if [ "${#missing[@]}" -eq 0 ]; then
  echo "generate: all ${#parts[@]} parts present"
  xcodegen generate --spec "$SPEC" --project .
else
  for p in "${missing[@]}"; do echo "generate: skipping missing part $p"; done
  # Filtered copy lives in .build/, and --project-root keeps the repo root as the base for include and package paths.
  # Drop the whole include: block, then re-add the parts that exist (an empty include list is invalid).
  awk '/^include:/{skip=1;next} skip && /^[^ #-]/{skip=0} !skip{print}' "$SPEC" > "$GEN"
  present=()
  for p in "${parts[@]}"; do
    [ -f "$p" ] && present+=("$p")
  done
  if [ "${#present[@]}" -gt 0 ]; then
    echo "include:" >> "$GEN"
    for p in "${present[@]}"; do
      printf '  - path: %s\n    relativePaths: true\n' "$p" >> "$GEN"
    done
  fi
  xcodegen generate --spec "$GEN" --project . --project-root .
fi
echo "generate: wrote Drover.xcodeproj"
