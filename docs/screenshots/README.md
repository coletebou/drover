# Screenshots

The pictures in the top-level README. Every one is of synthetic data: invented hosts, sessions, repositories and
messages, on this machine alone. Make them again with the steps below; keep the file names, since the README links
them.

## Web UI, terminal UI and CLI

The showcase world is a dev world with three hosts (studio runs the daemon, devbox answers through a stand-in ssh,
spare is down), every engine Drover drives, docker stacks and a truth file with history (`web/test/devworld.js`,
`web/test/showcase/world.js`). The capture script needs ttyd for the terminal pictures and Chrome (Chrome for Testing
from the Playwright cache is used when it is there).

```
cd web
node test/devworld.js --showcase --port 7339 --gateway 18800    # leave it running
node test/showcase/shoot.mjs --out ../docs/screenshots          # web-*.png, tui-*.png, cli.png (--only web,tui,cli)
```

The TUI and the CLI run in a tmux server of the script's own, named by socket (`-S`), so they never touch yours.

## Chrome and Safari extensions

The Safari extension is built from the Chrome extension, so one set stands for both.

```
cd native/Extensions/chrome
DROVER_STATE=<the showcase world's folder>/state node tools/headless.mjs --url http://127.0.0.1:7339 --out <dir> --scene all
```

`chrome-popup-light.png` and `chrome-popup-dark.png` are `popup-*-1-open.png`; `chrome-panel-dark.png` is
`panel-dark-2-answer-card.png`. The world's folder is printed when it starts (`devworld.json` is in it).

## Mac app, menu bar and widgets

Offscreen renders with `swiftc` alone (no Xcode license, no screen recording grant), each on its app's mock data.

```
native/Apps/macOS/tools/snapshot.sh <dir>     # board-*.png, manager-dark.png -> mac-board-*.png, mac-manager-dark.png
native/Apps/MenuBar/tools/snapshot.sh <dir>   # dialog-*.png -> menubar-*.png
native/Widgets/script/snapshot.sh <dir>       # widgets-*.png
```

The Mac pictures are drawn as a window screenshot (`native/Apps/macOS/Tests/Snapshot/WindowShot.swift`): offscreen,
macOS 26's Liquid Glass and the traffic lights do not render, so the harness gives them plain stand-ins.

## iPhone and Apple Watch

From the simulators, on the apps' `--mock` data: `native/script/screenshots.sh <dir>` on a Mac with Xcode, or the
`screenshots` workflow (manual, or a push to a `screenshots/**` branch), whose artifact holds the PNGs. The iPhone
pictures here are those, scaled to 1400 pixels high.
