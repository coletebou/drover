# Asks: text the owner a question, route the answer back

An agent blocked on a human decision asks by text instead of waiting in chat or in a file nobody reads. One daemon,
the **hub** (`DROVER_ASK_HUB`, a host alias), sends every text and reads every reply; asks can be made on any host.

## API

| Op (MCP tool) | What |
|---|---|
| `ask.create` (`drover_ask`, `drover ask "…" --options a,b`) | `{question, options?}` or `questions: [{question, options?}]`, `sessionId` (MCP and the CLI default to the calling Claude Code session), `urgency: normal\|urgent`, `expiresAt` or `ttlMinutes` (default 24 h, at most 14 days), `channels?`. Returns at once: `askId`, `status`, and on the hub the `code` (`K7`). |
| `ask.get` / `ask.list` / `ask.cancel` / `ask.status` | One ask with its answer and provenance; asks on a host; withdraw one; settings, hub and each channel's state (missing setting names, never values). |
| `ask.deliver`, `ask.mark` | The hub's own calls to the asking host, over the ssh rpc peer it holds. Refused by MCP, `drover op` and the HTTP API; a `drover rpc` serves them only for an ssh session from the hub machine (its ssh alias's address, or `DROVER_ASK_HUB_ADDRS`). |

The answer arrives in the asking session as a message: `[Owner via telegram, verified] K7 → b (no)`, the question,
and the `askId` to check with `ask.get`. The owner replies `K7 b`, `7b`, `b` (one ask open), free text, `1a 2b 3 yes`
(several questions), taps a Telegram button, or sends `stop`, `resume`, `pause asks 2h`, `status`.

## State: the truth file, no new store

One event type, `ask`, with a `phase`: `created` (on the asking host), `routed` (the hub's code, with a copy of the ask),
`sent`, `answered`, `delivered`, `cancelled`, `expired`, `inbound` (a reply that answered nothing), `control` (the
owner's pause, stop, resume). The fold is order-tolerant (dotsync merges the asking host's file with the hub's): the
first answer, cancel or expiry wins, later replies are follow-ups, one provider message counts once. `events.append`
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
  the session is told. A delivery the asking host could not take is retried (2 min backoff, doubling to 30).

## Channels (each: send, verify inbound, health)

| Channel | Out | In, and what makes it the owner's |
|---|---|---|
| Telegram (`DROVER_ASK_TELEGRAM_TOKEN`, `_CHAT` = the owner's user id) | `sendMessage` with buttons | Long polling (`getUpdates`, no inbound port), or a webhook `/hooks/telegram` on the bot gateway's public origin when that origin's port is one Telegram calls (443, 80, 88, 8443), believed only with the secret header given at `setWebhook` (random, 0600 in the state dir). Sender and private chat must be the owner's id. |
| SMS via Twilio (`DROVER_ASK_TWILIO_ACCOUNT_SID`, `_AUTH_TOKEN`, `DROVER_ASK_SMS_FROM` a 10DLC number, `_SMS_TO`) | Messages API, ASCII only | Webhook `/hooks/twilio/sms`, believed only with a valid `X-Twilio-Signature` for the public URL; AccountSid, To and From must be ours and the owner's. `DROVER_ASK_SMS_INBOUND=poll` (also the default with no public endpoint) reads the account's message log every 15 s instead, filtered by Twilio to the owner's number: no webhook and no Messaging Service change needed. |
| iMessage (`DROVER_ASK_IMESSAGE_TO`, `DROVER_ASK_IMSG`; a Mac) | `imsg rpc` `send`, AppleScript transport | The same child's `watch.subscribe`, read only for the one-to-one chat with the owner's handle (every other chat is never passed on or recorded), not from this account. Checked at start: an account that is the owner's own Apple ID (a note to self) or signed out keeps the channel off. |

## Provenance rules

- Only a reply its channel authenticated **and** that came from the owner's own id is an answer
  (`source: <owner>:<channel>`, the provider message id, the sender, the raw text, `untrusted: false`).
- Anything else is `inbound` with `untrusted: true`: never delivered, never acknowledged (no reply to strangers),
  rate-limited in the log. A reply relayed by another agent (a chat bot forwarding "he said yes") is never an answer.
- Trust boundary: no op can plant an answer. `events.append` refuses ask events, and the hub's calls to the asking
  host are served only to the hub machine's ssh session, so a shell on that host cannot pipe a forged answer into a
  local `drover rpc`; the answer records the address it was relayed from. A process of the same user that rewrites the
  truth file or Drover's own code is beyond what any op can stop, as for every Drover record.
- No secrets in texts: a question is plain text; work-looking questions (`DROVER_WORK_CONTEXT`) and machines of the work
  identity are refused, and the hub never reads another identity's hosts.

## Failure modes

| Failure | What happens |
|---|---|
| Hub down | Asks stay open where they were made; the hub takes them when it is back. |
| Asking host unreachable | The answer is recorded on the hub, the owner is told, delivery retries. |
| Session gone | The asking host's `sessions.message` follows a handoff chain to its live successor; else final, recorded for `ask.get`, the owner is told. |
| Channel down | Falls over to the next channel; retries with backoff. |
| Webhook replayed | One answer per provider message id. |
| Stale button or late reply | Bound to the message it came from; a late answer is a follow-up, never a new question's. |
