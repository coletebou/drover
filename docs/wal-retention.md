# Truth file (WAL) size: design proposal

Status: step 1 implemented on branch `wal-retention-design` (not merged, daemon not
restarted); steps 2 and 3 are proposals for review. Measured 2026-11-03 on the macbook.

## The problem, measured

`~/.dotfiles/claude/drover-events.jsonl` is 54.7 MB: 62,005 events from 2026-10-11 to
2026-11-03, about 2.4 MB a day (peak 7.2 MB on 10-27). Nothing caps, rotates or
compacts it.

Bytes by type:

| type | MB | share | what fold() keeps |
|---|---|---|---|
| message | 19.1 | 35% | every message, per chat key |
| notify | 16.8 | 31% | the latest needs-you notify per session only |
| op | 10.6 | 19% | the last 200 only |
| note | 4.1 | 7.5% | every note |
| chat | 1.7 | 3% | every chat line |
| survey-item | 1.4 | 2.6% | all |
| everything else | ~1.0 | 2% | features, pins, launches, handoffs, settings |

About 50 of the 55 MB is from the last 14 days, so a pure age cutoff (drop events older
than N days) saves little now; the cost is the write rate, not old data.

Three costs follow from it:

1. **Every read parses the whole file.** `readAll()` (`web/core/events.js`) reads and
   JSON-parses all 62k lines, dedupes and sorts, for `events.state`, `events.tail` (even a
   12-event tail), `notifyList`, surveys, settings, openclaw and the grok bot. The
   cache is 5 s (`core/api.js`). The search indexer rescans the whole file each pass.
2. **Git carries every append from every host.** The file is tracked with
   `merge=union` and dotsync commits it every 30 min per host: 2,426 commits in 18
   days. Its blobs take about 179 of the 326 MiB pack; `.git` is 406 MB.
   Git already zlib-compresses objects, so compressing the working file buys nothing
   there; the growth is the volume of appended bytes.
3. **Union merges and loose objects on a 55 MB file**, every sync, on every host.

## What does not work on its own

- **Compress in place** (zstd -19 gives 7.1 MB, gzip -9 11.9 MB): drover reads it raw,
  and git stores compressed objects already. Only useful for frozen archive segments.
- **Start a new empty file**: `fold()` rebuilds features, notes, pins, chats and
  settings from the full history, so they would vanish from `drover_state`.
- **Drop events older than N days**: safe for notify and op (fold keeps only the latest
  notify per session and the last 200 ops), but those bytes are mostly recent, and
  messages and notes are durable state.

## Proposal, smallest first

### 1. Incremental read in `events.js` (no format change)

Keep the parsed events in memory with the file's `{dev, ino, size}` and the byte offset
read so far. On the next read, if the file only grew, parse the appended bytes only.
If it shrank, was replaced, or its leading bytes changed (a union merge inserts lines in
the middle), parse it in full once. Appends from this process already pass through
`append()` and its listeners, so they can join the cache directly.

Effect: a full parse only after each git merge (every 30 min), not every 5 s per
caller. No new state, no coordination, nothing synced. Fixes cost 1.

Measured on a copy of the real file (62k events): the old `readAll` took 165-185 ms on
every call; the new one takes 148 ms cold, then 0 ms unchanged or after 10 appends.
Peak RSS in that run fell from 691 to 368 MB, because a call no longer allocates a
fresh copy of every event. Not caught: a same-length edit confined to the middle of
the file, between the two 4 KB check windows. Nothing writes that (lines are only
appended; a merge adds lines, which shifts the end window).
`test/events-incremental-read.test.js` covers appends, torn lines, a union-merge insert
near the end, a same-length edit at the start, rename, shrink, delete, out-of-order
timestamps and duplicate ids; removing either check makes a test fail.

### 2. Keep notify and op host-local (needs a decision)

notify and op are 50% of the bytes and fold() keeps almost nothing of them. Write them
to a host-local log (`~/.local/state/drover/local-events.jsonl`), and read it alongside
the truth file. The synced file then grows about 1.2 MB a day instead of 2.4.

Open question for review: does any host need another host's notify or op events from
the synced file? The fleet summary asks each host live; if anything relies on the
synced copy (a "waiting on you" view that works with a host offline, the openclaw
feed), this option changes that behaviour.

### 3. Monthly segments (only if 1 and 2 are not enough)

On the first append of a new month (UTC), events whose `ts` is before the month start
stop going to the live file: the live file keeps the current month, and closed months
live in `claude/drover-events/<YYYY-MM>.jsonl.zst`, written once. Late events (a host
offline across the boundary) still land in the live file and are found by id dedupe.
Closed segments are immutable, so their folded state can be cached locally by content
hash; that cache is derived and never synced.

This needs one writer to cut a segment while other hosts keep appending, so it is
the step that needs a lock or a single designated host. That is the architecture
question, and why 1 and 2 come first.

## Existing git history

The ~179 MiB already in history only goes away with a history rewrite (`git
filter-repo`) and a force-push that every box must re-clone or reset onto. That is
destructive and fleet-wide; decide it separately, after the growth is fixed.

## Related

- `claude/apx-events.jsonl` (3.1 MB legacy twin) is already due for deletion around
  2026-11-15 (`syncLegacyEvents`).
- `docs/agent-memory.md` says "~21k events in two weeks"; it is now ~62k in 23 days.
