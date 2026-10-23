#!/usr/bin/env bash
# Regenerate every Drover icon from the SVG sources in docs/brand. The outputs are committed (CI has neither
# rsvg-convert nor Pillow). Needs rsvg-convert (brew install librsvg) and uv (it supplies Pillow).
set -euo pipefail
cd "$(dirname "$0")"
root="$(cd ../.. && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

# Apple app icons (iOS, watch, macOS, menu bar, Safari container apps) from the full-bleed master.
rsvg-convert -w 1024 -h 1024 mark.svg -o "$tmp/master.png"
uv run -q --with pillow python "$root/native/script/app-icons.py" "$tmp/master.png"

# Chrome extension (Safari's web extension builds its resources from the same folder).
icons="$root/native/Extensions/chrome/icons"
for s in 16 32; do rsvg-convert -w "$s" -h "$s" mark-small.svg -o "$icons/icon-$s.png"; done
for s in 48 128; do rsvg-convert -w "$s" -h "$s" mark-rounded.svg -o "$icons/icon-$s.png"; done

# Browser UI: app icon, favicon, and the PNG iOS wants for the home screen.
cp mark-rounded.svg "$root/web/ui/icon.svg"
cp mark-small.svg "$root/web/ui/favicon.svg"
rsvg-convert -w 180 -h 180 mark.svg -o "$root/web/ui/apple-touch-icon.png"
echo "brand: icons regenerated"
