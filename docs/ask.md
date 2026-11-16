# Asks: text the owner a question, route the answer back

An agent blocked on a human decision asks by text instead of waiting in chat or in a file nobody reads. One daemon,
the **hub** (`DROVER_ASK_HUB`, a host alias), sends every text and reads every reply; asks can be made on any host.

## API

| Op (MCP tool) | What |
|---|---|
| `ask.create` (`drover_ask`, `drover ask "…" --options a,b`) | `{question, options?}` or `questions: [{question, options?}]`, `sessionId` (MCP and the CLI default to the calling Claude Code session), `urgency: normal\|urgent`, `expiresAt` or `ttlMinutes` (default 24 h, at most 14 days), `channels?`. Returns at once: `askId`, `status`, and on the hub the `code` (`K7`). |
| `ask.get` / `ask.list` / `ask.cancel` / `ask.status` | One ask with its answer and provenance; asks on a host; withdraw one; settings, hub and each channel's state (missing setting names, never values). |
| `ask.deliver`, `ask.mark` | The hub's own calls to the asking host, over the ssh rpc peer it holds. Refused by MCP, `drover op` and the HTTP API; a `drover rpc` serves them only with the hub's signature, checked against `DROVER_ASK_HUB_KEY` (see trust, below). |

The answer arrives in the asking session as a message: `[Owner via telegram, verified] K7 → b (no)`, the question,
and the `askId` to check with `ask.get`. The owner replies `K7 b`, `7b`, `b` (one ask open), free text, `1a 2b 3 yes`
(several questions), taps a Telegram button, or sends `stop`, `resume`, `pause asks 2h`, `status`. Several asks in one
reply go by code or number with a letter (`K7 b M8 a`, `7b 8a`); after an option a bare number is that answer's words
(`K7 b 2 a week`) unless a comma ends the option (`7a, 8 Drover`). Over SMS, Twilio's opt-out words alone (STOP, END,
CANCEL, QUIT, STOPALL, UNSUBSCRIBE) are a stop, never an answer: the carrier blocks Drover's texts after them anyway.

## State: the truth file, no new store

One event type, `ask`, with a `phase`: `created` (on the asking host), `routed` (the hub's code, with a copy of the ask),
`sent`, `answered`, `delivered`, `cancelled`, `expired`, `inbound` (a reply that answered nothing), `control` (the
owner's pause, stop, resume, and an SMS opt-in), `page` (a heads-up, below). The fold is order-tolerant (dotsync merges the asking host's file with
the hub's): the first answer, cancel or expiry wins, later replies are follow-ups (so is the part of a reply that
answers a question already answered: the session gets it labelled, the first answer standing), one provider message
counts once. `events.append`
refuses `type: ask`.

## Routing

- The hub takes its own asks at once. Others it **pulls** each tick (15 s) with `ask.list` on the hosts it may read: the
  fleet catalog's hosts of its own identity, or `DROVER_ASK_HOSTS`. A host need not reach the hub; the hub reaches it.
- Codes are a letter and the smallest number no open ask holds and none closed in the last 30 minutes held, so a late
  `7b` never lands on a newer question.
- Channels in order (`DROVER_ASK_CHANNELS`, default telegram, imessage, sms); a failed send falls over to the next.
- Normal asks wait out quiet hours (`DROVER_ASK_QUIET` 22:00-08:00, `DROVER_ASK_TZ` America/New_York), a pause and the
  rate limit (`DROVER_ASK_RATE` 6 texts an hour), then held asks go out together in one text. Urgent asks skip those,
  escalate to the next channel after 5 minutes unanswered; nothing skips `stop`. One reminder before expiry; at expiry
  the session is told. A delivery or expiry notice the asking host could not take is retried (2 min backoff, doubling
  to 30) until it lands or the session is gone for good.

## Pages: heads-ups that are not questions

A Grok bot's `needs-owner` or `blocked` status (`drover_status`), and its urgent alert (`drover_notify_owner` with
`urgent: true`), also text the owner through the hub, besides the alert on their screens. A page is recorded as
`ask` phase `page` (`pageId`, `source` the bot, `key`, `title`, `body`, `urgent`) and texted as kind `page`; it carries
no code and nothing answers it. The ask rules apply: quiet hours and a pause hold a normal page (it goes out with the
next pages that may), the hourly limit (`DROVER_ASK_RATE`) counts pages and asks together, urgent skips all but a stop.
On top:

- the same key (bot, state, summary; or bot, alert title and body) inside `DROVER_ASK_PAGE_COOLDOWN_MINUTES` (60) is the
  same page, never texted twice;
- one text per bot per `DROVER_ASK_PAGE_GAP_MINUTES` (10): a newer status waits, and only a bot's newest page goes;
- a status that needs nobody (`working`, `idle`, `done`) withdraws that bot's pages not texted yet;
- a page not texted within `DROVER_ASK_PAGE_STALE_HOURS` (12) is dropped, not sent late;
- channels `DROVER_ASK_PAGE_CHANNELS` (default `sms`), failing over in that order; `DROVER_ASK_PAGES=off` turns pages
  off. A bot the owner muted in Drover's settings (needs-you alerts) is not texted either.

Pages are made only on the hub, where the bot gateway runs; elsewhere the screen alert alone goes out.

## Channels (each: send, verify inbound, health)

| Channel | Out | In, and what makes it the owner's |
|---|---|---|
| Telegram (`DROVER_ASK_TELEGRAM_TOKEN`, `_CHAT` = the owner's user id) | `sendMessage` with buttons | Long polling (`getUpdates`, no inbound port), or a webhook `/hooks/telegram` on the bot gateway's public origin when that origin's port is one Telegram calls (443, 80, 88, 8443), believed only with the secret header given at `setWebhook` (random, one per bot, 0600 in the state dir: a replaced bot's webhook, still registered with Telegram, is refused); until Telegram has taken it, nothing goes out on Telegram (registration is retried). Sender and private chat must be the owner's id. Ids and the polling offset carry the bot's own id, so a replaced bot is never read as the old one. An edited message is read only as a follow-up of the ask its original message answered. |
| SMS via Twilio (`DROVER_ASK_TWILIO_ACCOUNT_SID`, `_AUTH_TOKEN`, `DROVER_ASK_SMS_FROM` a 10DLC number, `_SMS_TO`) | Messages API, in the GSM alphabet when the text fits it (an accent GSM lacks loses only its mark); text with no GSM form (Chinese, emoji) goes as written, in UCS-2 | Webhook `/hooks/twilio/sms`, believed only with a valid `X-Twilio-Signature` for the public URL; AccountSid, To and From must be ours and the owner's. By default the hub reads the account's message log every 15 s instead, filtered by Twilio to the owner's number: no webhook and no Messaging Service change needed; the webhook is served only with `DROVER_ASK_SMS_INBOUND=webhook`, since its signature proves only that the sender holds the auth token. Each webhook is served only in its channel's webhook mode. The log is read page by page back to the last message seen, so a backlog after downtime is read whole, oldest first. STOP (and END, CANCEL, QUIT, STOPALL, UNSUBSCRIBE, or a webhook's `OptOutType=STOP`) and START are the carrier's opt-out and opt-in: Twilio answers them, and START brings SMS back whatever Drover's own stop says. |
| iMessage (`DROVER_ASK_IMESSAGE_TO`, `DROVER_ASK_IMSG`; a Mac) | `imsg rpc` `send`, AppleScript transport | The same child's `watch.subscribe`, read only for the one-to-one chat with the owner's handle (every other chat is never passed on or recorded), not from this account. Checked at start: an account that is the owner's own Apple ID (a note to self) or signed out keeps the channel off. |

## Provenance rules

- Only a reply its channel authenticated **and** that came from the owner's own id is an answer
  (`source: <owner>:<channel>`, the provider message id, the sender, the raw text, `untrusted: false`).
- Anything else is `inbound` with `untrusted: true`: never delivered, never acknowledged (no reply to strangers),
  rate-limited in the log. A reply relayed by another agent (a chat bot forwarding "he said yes") is never an answer.
- Trust boundary: no op can plant an answer. `events.append` refuses ask events, and an asking host takes the hub's
  calls only with the hub's signature. Every agent on a host runs as the same user as Drover there, so nothing such a
  process can see or set proves a caller: not `SSH_CONNECTION`, not a process name (a copy of a shell named `sshd`),
  not a real sshd above the rpc (`ssh localhost` with a forged environment). The hub signs each call (the op and the
  fields it reads) with an Ed25519 key made on first use, `<state>/ask/hub-key.pem` (0600), that never leaves it; each
  other host checks the signature against `DROVER_ASK_HUB_KEY`, the public key `drover ask status` prints on the hub
  (several, comma-separated, while a key changes). Without that setting a host takes no relayed answer. A replay
  repeats its own answer, which is taken once. The answer records the key that signed it.
- What that does not cover: a process that rewrites the truth file, Drover's code or a host's settings (as for every
  Drover record); on the hub itself, one that reads the hub's state (its key, the webhook secret); and anyone holding a
  channel's secrets. Twilio signs webhooks with the account's auth token, so webhook mode trusts every holder of it:
  where agents' environments carry it, read SMS replies by `poll` (the hook is then not served). A Telegram bot token
  lets its holder read the bot's updates and write as the bot: keep it on the hub.
- No secrets in texts: a question is plain text; work-looking questions (`DROVER_WORK_CONTEXT`) and machines of the work
  identity are refused, and the hub never reads another identity's hosts.

## Failure modes

| Failure | What happens |
|---|---|
| Hub down | Asks stay open where they were made; the hub takes them when it is back. |
| Asking host unreachable | The answer is recorded on the hub, the owner is told, delivery retries. |
| Session gone | The asking host's `sessions.message` follows a handoff chain to its live successor; else final, recorded for `ask.get`, the owner is told. |
| Channel down | Falls over to the next channel (an urgent ask's escalation too); retries with backoff. |
| Telegram webhook not taken | Telegram stays out of rotation, registration retried with backoff. |
| `DROVER_ASK_HUB_KEY` unset or wrong on a host | That host refuses the hub's deliveries; the hub keeps the answer and retries; `drover ask status` there says so. |
| Webhook replayed | One answer per provider message id. |
| Stale button or late reply | Bound to the message it came from; a late answer is a follow-up, never a new question's. |
