# Drover for Chrome

A Manifest V3 extension for Drover, the local daemon that controls Claude Code and Codex agent sessions. It has no dependencies and no build step.

## What it does

- Popup: the fleet manager first (ask it anything, the reply streams in, quick prompts Who is waiting on me?,
  What finished? and Sweep now, Open for the whole conversation), then the sessions waiting on you with the
  dialog's own keys as buttons ("1 Yes", "2 Yes, don't ask again", "3 No", Enter, Esc; the highlighted option
  marked), Reply for a question asked in text, then what works and idle totals. Keys go through
  `sessions.answer` with the screen hash the popup showed: a dialog that changed since refuses, and the popup
  says why.
- Toolbar badge: the number of sessions waiting for you.
- Notifications: a desktop notification when a session needs a decision or asks a question. A dialog alert
  has Approve (Enter) and Deny (Esc) (Deliver and Drop for a held peer message), answered on the screen the
  alert was raised for; other alerts have Reply and Open.
- Side panel chat: the manager is pinned first and is the default when nothing waits. A session's transcript
  shows its messages, its tool calls grouped with their results ("Ran 3 commands, read 2 files", expandable,
  errors marked) and Markdown text; a session on a dialog gets an answer card with its keys.
- Context menus: send the selected text or the current page URL to a session.
- Omnibox: type `drover <session> <text>` in the address bar to message a session.

Updates stream in: the popup subscribes to `summary`, `alerts`, `manager` and `turn` while it is open, the side
panel to `turn`, `manager` and `board`, and the service worker to `summary` and `alerts` while it is awake
(`GET /api/stream?topics=...`); the alarm poll is the fallback. A daemon from before these events still works:
the pages fall back to refreshing on its events, and without dialog keys a row offers Reply and Open.

## Install

1. Open `chrome://extensions`.
2. Turn on Developer mode.
3. Choose Load unpacked and pick this folder (`Extensions/chrome`).

## Connect

Pair with Drover, so there is no token to copy:

1. Open the extension options page.
2. Enter the server URL (for example `http://127.0.0.1:7337`).
3. Choose Pair with Drover, and allow access when Chrome asks, so the extension can reach that one server.
4. The page shows a 6-digit code, such as `123 456`. On the Mac that runs the daemon, approve it: run
   `drover pair approve 123456` (the page shows the exact command and can copy it), or choose Approve in Drover's
   browser UI. Approve only the code this page shows.
5. The daemon hands the token to the extension once. The extension stores it where a pasted token goes and connects.

A code is good for two minutes, and the page counts down. Choose Try again for a new code after it expires or is
denied; nothing is saved in either case. Cancel stops waiting. A Drover version without pairing says so; paste the
token instead.

Or paste the token:

1. Enter the server URL.
2. Paste the token from `~/.local/state/drover/token` on the machine that runs the daemon.
3. Choose Save and connect, and allow access when Chrome asks.

The daemon only answers browser requests from origins it knows. The manifest pins a public key, so this
extension's id is always `pbcfbpefenbfkhkdfflnapdlfglfanoj` wherever it is loaded unpacked, and the daemon allows
`chrome-extension://pbcfbpefenbfkhkdfflnapdlfglfanoj` without configuration. Other origins go in `DROVER_ALLOW_ORIGINS`
(comma list) in `~/.local/state/drover/env`. The private half of the key is not in the repo and is not
needed to load the extension unpacked.

## Permissions and why

| Permission | Why |
| --- | --- |
| `storage` | Keeps your settings and the cached board. |
| `alarms` | Wakes the service worker to poll the daemon. |
| `notifications` | Shows the needs-you notifications. |
| `contextMenus` | Adds the send-to-session menu items. |
| `sidePanel` | Hosts the chat panel. |

There is also one optional host permission pattern (`http://*/*` and `https://*/*` are declared as optional only). The extension requests access at runtime for the server origin you configured, and nothing else. There are no content scripts and no web accessible resources.

## Privacy

- The token is stored in `chrome.storage.local` only. It is never synced, never put in a URL and never logged.
- Pairing sends no token. The request carries the client name (`Drover for Chrome`) and a platform label such as
  `macOS`. The status checks carry only the request id, which is the claim on the token, so it stays in the options
  page's memory and is never stored. The token arrives once and goes straight to storage, never onto the page. The
  widget token that comes with it is not kept: the extension uses only the main token.
- Page content is read only when you click a context menu item, and only the selection or the URL that Chrome passes to the extension.
- No analytics. No remote code. The only network traffic goes to the server you configured.

## Development

```
node --test                      # all tests (or: node --test test/*.test.js)
node tools/fake-daemon.mjs       # synthetic daemon on a local port, prints its URL and a fake token
node tools/make-icons.mjs        # regenerate icons/*.png
```

The fake daemon (`--port 7399` by default) prints `token: test-token-not-secret`. That token is fake, not a secret. It serves the fixtures in `test/fixtures`, answers `sessions.answer` (refusing a stale hash) and `native.board`, filters the stream by `?topics=` and streams a `wait: false` manager reply as `manager` and `turn` events.
It also answers pairing: for each request it prints the `curl` command that approves the code (the stand-in for
`drover pair approve`).

The pure modules behind the views: `lib/answer.js` (dialog keys as buttons, the press with its fallback),
`lib/chat.js` (the chat rendering rule and a safe Markdown subset, as data), `lib/manager.js` (the manager
conversation from the send, the stream and transcript reads) and `lib/topics.js`. The `ui/` modules draw them
with textContent only.

`node tools/headless.mjs --url http://127.0.0.1:7338 --out /tmp/shots [--scene popup|panel|bg|review]` runs the real
popup and side panel in headless Chrome for Testing (branded Chrome no longer loads unpacked extensions from the
command line) against the dev world (`node web/test/devworld.js --port 7338 --gateway 18799`), presses dialog keys,
asks the manager and saves light and dark screenshots; `bg` checks the service worker's stream with no page
asking; `review` presses a fresh dialog alert through the real button handler (and refuses it after a server
change) and runs the side panel with the stream failing. It refuses the live daemon on 7337. The copy of the extension it loads adds a host permission for that
one server, since an unpacked extension's optional permission needs a click.

The pairing protocol lives in `lib/pairing.js` (no chrome.* and no DOM, so `test/pairing.test.js` drives it with fake
fetch and timers); `test/pairing-daemon.test.js` runs it over HTTP against the fake daemon.

## Safari reuse

The Safari window copies this folder verbatim. APIs are feature-detected, so missing ones degrade instead of throwing. Settings live under the storage key `settings` (see `lib/settings.js`). Notification ids are `drover|<host>|<sessionId>|<itemId>`.
