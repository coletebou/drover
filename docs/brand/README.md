# Drover brand

The mark is a corral drawn in one amber stroke, a D whose gate opens at the bottom left, holding a small herd:
the agents, in the board's own cream, steel and moss, nearest the gate first. A drover moves a herd a long way
and keeps it together; that is what Drover does for the agent fleet.

| file | use |
|---|---|
| `mark.svg` | full-bleed square, the master for Apple app icons (the OS rounds it) |
| `mark-rounded.svg` | rounded square for 48 px and up: web app icon, Chrome and Safari extension icons |
| `mark-small.svg` | 32 px and below (favicon, toolbar): heavier stroke, wider gate, one dot |
| `glyph.svg` | the mark alone on a transparent background |
| `lockup-light.svg`, `lockup-dark.svg` | mark and wordmark for light and dark pages (the README header) |

Colours: ink `#20242e` to `#11141a`, amber `#f6c25a` to `#df8b25`, cream `#f3ead6`, steel `#8db6df`, moss `#8ebd87`.
The wordmark is set in Fraunces SemiBold, falling back to Georgia.

`render.sh` regenerates every derived icon from these sources: the six Apple icon sets (through
`native/script/app-icons.py`), the Chrome extension icons (Safari's web extension builds from the same folder)
and the browser UI's icon, favicon and home-screen PNG. Edit the SVGs, run it, commit the outputs.
