# Window 6: Chrome extension (Extensions/chrome), Manifest V3, plain JS/TS-free, zero dependencies
Popup (board: waiting/working/idle, reply box, open session), toolbar badge with waiting count (colour by state) via
`chrome.alarms` polling `native.summary` (and SSE in an offscreen document if worthwhile), desktop notifications
(`chrome.notifications`) with Reply/Open buttons, options page (server URL, token in `chrome.storage.local`, host
permission requested at runtime via `chrome.permissions.request` for the configured origin only), side panel
(`chrome.sidePanel`) with chat to a chosen session, context menu "Send selection to session" and "Send page URL
to session" (never reads page content unless the user clicks it), omnibox keyword `drover <session> <text>`.
Minimal permissions; no remote code; CSP strict. Node-free tests with `node --test` for the logic modules
(`lib/*.js` as ES modules). Slices: background+badge+notifications, popup+side panel, options+permissions+omnibox+context menus, tests.
