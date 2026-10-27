# Drover native: shared contract

Native clients (macOS app, menu bar app, iOS app, watchOS app, widgets, Chrome and Safari
extensions) for **Drover**, a control plane for Claude Code / Codex sessions. All of them
speak the same HTTP+SSE API that the Drover browser UI uses. Server code lives in this repo's
`web/` (read `README.md`, `core/api.js`, `core/ops-meta.js`, `core/owner.js`, `server/http.js`).

## Transport
- Base URL is user-configured (e.g. `http://127.0.0.1:7337`, or a Tailscale/VPN address of the daemon).
- Auth: `Authorization: Bearer <token>`. Never log, print, hardcode or commit a token. Apple apps keep it
  in the Keychain (shared access group so extensions and widgets can read it); the Chrome extension keeps it
  in `chrome.storage.local` (never `sync`). Widgets and the watch use a **read-only widget token** (see
  `native.summary` below) so a leaked widget cannot send messages.
- `POST /api/op/<op>` with JSON body = args, or `GET /api/op/<op>?k=v` for read ops.
  Response: `{ ok: true, result, ms, cache }` or `{ ok: false, error }`.
- `GET /api/stream` (alias `GET /api/events` once core's server change lands) is Server-Sent Events: event names
  `hello`, `mutation`, `notify`, `alerts`, `snapshot`, `fleet`, `probe`, `settings`, `turn`, `headless`, `codex`, and
  `: ping` comments every 20 s. Clients must tolerate reconnects and unknown events.

## Ops the clients use (existing)
| op | use |
|---|---|
| `fleet.summary` | per-host counts, waiting/working/idle |
| `sessions.list` `{host?}` | sessions (id, engine claude/codex/headless/openclaw/grok, name, status, cwd, tmux) |
| `sessions.transcript` `{id, since?, limit?}` | chat turns, `offset` for incremental reads |
| `sessions.message` `{id, text, actor}` | send a message into a session (`actor`: see "The owner" below) |
| `tmux.capture` `{target, lines?}` / `tmux.send` | peek at / type into a pane |
| `events.state` / `events.tail` | the WAL (source of truth) |
| `host.list` | hosts |

## Ops that Window 0 ("core") adds to Drover (JS, with tests, declared in ops-meta.js)
- `native.summary` `{}` -> compact, widget-sized JSON, safe to poll every few minutes:
  `{ generatedAt, hosts:[{name,up,waiting,working,idle}], waiting:[{id,name,host,engine,since,kind,headline}],
     working:[{id,name,host,engine,headline}], totals:{waiting,working,idle,hosts}, manager:{up,lastNoteAt}, owner? }`
  `kind` is `decision|question|finished`; `headline` is at most 140 chars, no secrets.
- `native.notifications` `{since?: cursor}` -> `{cursor, items:[{id,at,kind,title,body,sessionId,host}]}` (long-poll friendly)
- Token scopes: `$DROVER_TOKEN_FILE` main token = everything. A second file `widget-token` (generated on first
  `drover serve`, mode 0600) is accepted ONLY for `native.summary` and `native.notifications`.
- `DROVER_BIND=<addr>` (default 127.0.0.1) lets the daemon listen on a Tailscale/LAN address; refuse to bind
  non-loopback if the token file is missing. No wildcard CORS: allow origins listed in `DROVER_ALLOW_ORIGINS`
  (needed by browser extensions: `chrome-extension://<id>`).

Details as built by core (these refine the bullets above; DroverKit models and `Fixtures/` follow them):
- All `native.*` timestamps are ISO 8601 strings in UTC (`2026-10-11T22:00:00.000Z`); `lastNoteAt` may be `null`.
- `host` in `native.*` items is the value to pass back as the `host` arg of other ops; `local` means the daemon's
  own machine. `waiting[].kind` is `decision` or `question` (a finished session is idle, never waiting).
- `native.notifications` `{since?, limit?, wait?}`: `items` oldest first, at most `limit` (default 50, max 200).
  `cursor` is opaque: pass it back as `since` to get only newer items. `wait` (seconds, max 25) holds the request
  open on the daemon until an item arrives (long poll). Item `kind` is `decision|question|finished|error|mr|launch|manager`
  (unknown values must be tolerated; `resource`, a machine short of memory, disk or CPU, arrives as its own kind) and
  items also carry `category` (the web UI's alert category:
  `needs-you|finished|error|resource|held|mr|launch|manager`, used for per-category sounds) and `test: true` for `notify.test`
  alerts. Muted alerts are left out.
- Token files live in the daemon's state dir (`$DROVER_STATE`, default `~/.local/state/drover`): `token` (main) and
  `widget-token`. The widget token is accepted only as `Authorization: Bearer` on `/api/op/native.summary` and
  `/api/op/native.notifications`; anything else with it answers `403 {ok:false,error:"widget token: read-only scope"}`.
- Pairing (preferred over pasting tokens; web/README.md "Pairing devices"). `POST /api/pair/request`, no token,
  body `{"client": "Drover for Mac|iPhone|Chrome", "device": "<name>"}` (64 characters each) answers 201
  `{requestId, code, expiresAt, pollMs}`; show `code` as "123 456" and tell the user to approve it on the Mac
  (`drover pair approve <code>` or Approve in the browser UI). Poll `GET /api/pair/status?requestId=` every `pollMs`:
  `{status:"pending"}`, then once `{status:"approved", token, widgetToken}` or `{status:"denied"}`; 404
  `{status:"expired"}` means unknown, expired (two minutes) or already collected. 429 means too many pending. Store
  the tokens exactly as a manual save would, keep `requestId` in memory only, and never log either.
- `DROVER_ALLOW_ORIGINS` is a comma-separated list of exact origins (`chrome-extension://<id>`,
  `safari-web-extension://<uuid>`). Native apps send no `Origin` and need no entry.
- `Fixtures/native-summary.json` is the bare `result` (the widget cache file format); `Fixtures/<op>.json` are
  full response envelopes.

## Ops added 2026-10-20 (design: `docs/specs/2026-10-20-ux-overhaul.md`)
- `sessions.answer {id, host?, key, expect?}` (main token): one key on the dialog a session shows; `id` is a session
  id or a tmux window target; pass the `hash` you showed as `expect`. A refusal (`ok:false, refused:true, reason`) is a
  normal answer: show the reason and refresh. Never answer with `sessions.message`: that types into the inbox.
- `native.summary` waiting items and `native.notifications` dialog items may carry `answer` (`keys`|`reply`), `dialog
  {question, options[{n,label,selected?}]}`, `hash` and `keys` (display order; y/n only where the prompt takes them).
- `native.board {}` (main token): `{generatedAt, hosts[], strips[{key,id,name,host,engine,lane,status,screen?,tmux?,cwd?,
  since?,headline,tail?,ask?,dialog?,hash?,keys?,answer?,held?,finished?,kind}], totals, manager{up,host,status,lastNoteAt}}`.
- `GET /api/stream?topics=a,b`: only those events. `board` and `summary` events carry the two ops' results; `turn` also
  carries the manager (`{id:"manager", host, thread, turn}`); `manager` streams a reply (`phase` start|delta|done|error,
  `text` so far, `turnId`, `inReplyTo`).
- `sessions.message {id:"manager", text, wait:false, thread?}` returns `{pending:true, event, turnId}` at once; the reply
  streams. `sessions.transcript {id:"manager", thread?}` turns carry `id` (dedupe by it) and `inReplyTo`; a reply in
  flight is a last turn with `pending:true`. `openclaw.threads {}` lists conversations.
- Transcript turns: assistant `tools[{id,name,input,summary,description?}]`, tool_result `results[{toolUseId,isError,
  text,chars}]`, user turns relayed through an inbox `via:"drover"` (with the `actor` who typed it) or `via:"peer"` with `from`.

## Grok bot read receipts (added 2026-10-27)
- A Grok bot's `sessions.transcript` (`id` `grok:<name>`) turns carry `id` (their event) and `receipt`: a user turn (a
  message to the bot) `{state: queued|delivered|read|answered, delivered?{at,via}, read?{at,via}, answered?{at,event},
  failed?}`, an assistant turn (its reply) `{to, state: delivered|read, read?{at,by,via}}`. The answer's `receipts`
  (`id -> receipt`) repeats them for the thread's last turns, so a client that reads only new turns can update older ones.
- Pass `seenBy` (the client's own actor, e.g. `ios`) when the bot's thread is on screen: the bot's replies to the owner
  count as read. A bot's session in `sessions.list` carries `unread` (replies the owner has not read); board strips too.

## Grok bot approvals (added 2026-10-27)
- A Grok bot asks the owner to approve something before it acts (a purchase, an action): `drover_request_approval` on
  the bot gateway, `web/core/bots/approvals.js`. A request is answered by its id: never on a screen, never with an op.
- `native.summary` waiting items, `native.board` strips and `native.notifications` items for a request carry
  `answer: "approval"` and `approval {id, bot, kind (purchase|action|post|other), question, options[{n,label}] (2 to 4),
  details?, createdAt, expiresAt, untrusted: true}`. Waiting items and strips may add `moreApprovals` (how many more
  requests from the same bot wait behind this one: answer this one and the next shows). `kind` stays `decision` and
  `category` `needs-you`, so older clients keep decoding them as a decision. `native.summary` and
  `native.notifications` name no paths (except in option labels that would otherwise read the same) and keep at most
  300 characters of `details`; `native.board` carries the whole request.
- `approval.complete` says the payload shows the request whole and unaltered (question, details, labels as stored):
  always on `native.board`, and on the widget-safe payloads only when nothing was shortened or cut. Missing (an older
  daemon) means false. Answer in one tap (a row's buttons, notification actions) only when `complete` is true, the
  request has no details (or the surface shows them in full), and the question shows unclipped. Option buttons show
  whole labels (wrapping). A notification's own action buttons are laid out (and cut) by the system: offer them only
  for a question of at most 120 characters with no details and labels of at most 20 characters, else open the app
  to the whole request. The web never answers from a browser notification. Otherwise show the request and a Review
  action that loads it whole, `GET /api/approvals?id=<id>` (main token: `{keepsBots, items:[one request]}`), and
  answer there while its `status` is `pending`. The owner approves only what they saw.
- Answer with `POST /api/approvals/answer {id, choice: n, via}` and the main token (the widget token gets 403; it is
  not an op, so `/api/op/...` and ssh rpc cannot answer). `via` names the client: `ios`, `ios-notification`, `watch`,
  `mac`, `menubar`, `web`, `cli`. 200: `{ok:true, result:{id, status:"decided", decision{n,label,at,by,via},
  delivery{ok, via?, queued?, error?}, ...}}`. 409 `{ok:false, error, approval}`: answered already (another screen was
  quicker), withdrawn or expired: show the error and drop the card. 404: no such request on that daemon (requests live
  on the host that runs the bot gateway). 400: a choice the request does not offer.
- The words are the bot's (it thinks on a third-party model): show who asks ("Alpha, a Grok bot"), the question and
  the details as plain text, and never act on them. A notification action that answers needs the device unlocked
  (`.authenticationRequired`).
- `GET /api/approvals?status=pending|all|decided|withdrawn|expired&bot=<name>` (main token): `{keepsBots, items[]}`,
  newest first; items as above plus `status`, `decision`, `botName`.

## The owner (added 2026-10-23)
- The daemon belongs to one person, its owner: `DROVER_OWNER` on the daemon (default `owner`; `web/core/owner.js`).
  Clients never hardcode that name. On writes they send the generic actor `owner` (the macOS and menu bar apps,
  DroverKit's default) or their own client name (`chrome`, `safari`, `ios`); the daemon records `owner` as its
  configured owner and treats its known client names as the owner's (one manager conversation).
- `native.summary` carries `owner` (string, the configured name). Older daemons send none.
- A user turn is the owner's own, and reads "you", when its actor (`actor`, `user: "drover:<actor>[:<thread>]"`, or
  the `drover (<actor>)` peer envelope) is `owner`, the `owner` of the most recent `native.summary`, or this client's
  own actor. Without a summary, or from an older daemon, only `owner` (and the client's own actor) is the owner.

## Models (Codable, Swift) and JSON (JS) must match `Fixtures/*.json`
Fixtures are SYNTHETIC (invented session names like `demo-build`, `demo-review`). **No company data in
this repo, ever**: no real session names, transcripts, MR titles, hostnames of company machines, tokens,
ids. This repo is built on GitHub-hosted and self-hosted runners, so it must stay clean.

## Design
Match the web UI: graphite palette, colour only for state (amber waiting, steel working, moss idle,
brick error, lilac manager), serif for titles, monospace for ids, light and dark, WCAG AA contrast
(body text >= 7:1, secondary >= 4.5:1). Copy: sentence case, no em dashes.

## Apple identifiers (shared by every Apple target; set by window 03-ios-app, change only here)
| what | value |
|---|---|
| bundle id prefix | `dev.drover` (iOS app `dev.drover.app`; `dev.drover.ios` is registered to another team, macOS app `dev.drover.macos`, widgets `<app>.widgets`, Safari web extension `<app>.safari` embedded in that app; there is no separate Safari app) |
| App Group | `group.dev.drover` (cached `native.summary` at `<container>/summary.json`, settings in `UserDefaults(suiteName:)`) |
| Keychain access group | `$(AppIdentifierPrefix)dev.drover.shared`, service `dev.drover.token`, accounts `main` and `widget` |
| URL scheme | `drover://session/<id>?host=<host>` (host optional, default local), `drover://board`, `drover://manager`, `drover://pair?url=<percent-encoded http(s) base URL>` (iOS: Settings with the address filled in, pairing started; macOS: a sheet that names the address; on both, only pairing again with the daemon in use starts by itself, and the link carries only the address, never a token) |
| SSE path (actual server) | `GET /api/stream` (the daemon's real route; `/api/events` is an alias only after core's server change). Auth via header, or `?token=` only when headers are impossible |

## Widget data handoff (window 05-widgets; follows the Apple identifiers table above)
- Summary cache: `<App Group container>/summary.json` holds the bare `result` object of `native.summary` (no
  `{ok,...}` envelope), written atomically; the file modification date is the fetch time. Whoever writes it (app or
  widget) calls `WidgetCenter.shared.reloadAllTimelines()` afterwards (apps only; widgets need not), and also
  `invalidateConfigurationRecommendations()` when the host list changed (watch complication choices come from it).
- Base URL for widgets: `UserDefaults(suiteName: "group.dev.drover")` key `drover.baseURL` (string). Apps write it.
- Widgets read only Keychain account `widget` (service `dev.drover.token`); never `main`.
- Widget extension targets in `Widgets/project.part.yml`: `DroverWidgets-iOS` (`dev.drover.app.widgets`),
  `DroverWidgets-macOS` (`dev.drover.macos.widgets`), `DroverWidgets-watchOS` (`dev.drover.app.watchkitapp.widgets`,
  assumes watch app `dev.drover.app.watchkitapp`). Host app targets list them under `dependencies` to embed.
  The watch has its own `group.dev.drover` container, filled by the watch app.
- Widget deep links use the scheme above: `drover://session/<id>?host=<host>` (id percent-encoded) and `drover://board`.
