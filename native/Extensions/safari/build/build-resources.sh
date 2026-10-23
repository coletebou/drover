#!/usr/bin/env bash
# Finds node (Xcode run-script phases have a minimal PATH) and runs the build.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

find_node() {
  # Explicit override first (e.g. DROVER_NODE=/path/to/node in the Xcode scheme environment).
  if [ -n "${DROVER_NODE:-}" ] && [ -x "$DROVER_NODE" ]; then echo "$DROVER_NODE"; return 0; fi
  if command -v node >/dev/null 2>&1; then command -v node; return 0; fi
  local c d
  for c in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node"; do
    if [ -x "$c" ]; then echo "$c"; return 0; fi
  done
  # fnm: the default alias, else the newest installed version.
  for d in "${FNM_DIR:-}" "$HOME/.local/share/fnm" "$HOME/Library/Application Support/fnm" "$HOME/.fnm"; do
    [ -n "$d" ] || continue
    if [ -x "$d/aliases/default/bin/node" ]; then echo "$d/aliases/default/bin/node"; return 0; fi
    c="$(ls -d "$d"/node-versions/*/installation/bin/node 2>/dev/null | sort -V | tail -n 1 || true)"
    if [ -n "$c" ] && [ -x "$c" ]; then echo "$c"; return 0; fi
  done
  # Newest nvm or mise install (version sort).
  for c in "$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -n 1 || true)" \
           "$(ls -d "$HOME"/.local/share/mise/installs/node/*/bin/node 2>/dev/null | sort -V | tail -n 1 || true)"; do
    if [ -n "$c" ] && [ -x "$c" ]; then echo "$c"; return 0; fi
  done
  return 1
}

if ! NODE="$(find_node)"; then
  echo "build-resources: node (>= 18) not found. Install it (for example: brew install node) or set DROVER_NODE, and retry." >&2
  exit 127
fi

exec "$NODE" "$DIR/build-resources.mjs" "$@"
