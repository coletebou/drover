# Window 2: macOS menu bar app (Apps/MenuBar)
Separate lightweight target (`MenuBarExtra`, window style), LSUIElement, launch at login (SMAppService).
Icon shows waiting count with colour state; popover lists "Waiting on you" with inline reply field and
Open (opens the main app or the web UI via URL), "Working" count, host health dots, quick actions
(sweep manager, mute 1h, open dashboard). Uses DroverKit; polls `native.summary` with the widget token and
upgrades to SSE when the main token is present. Global hotkey to open the popover. Slices: popover UI,
data/polling/SSE, preferences+login item, hotkey+notifications.
