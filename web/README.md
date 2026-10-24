# Drover

Browser control plane for the agent fleet: see every tmux window, Claude Code
session and Codex thread on every machine, chat with any of them, launch new
agents (in tmux or headless) under any profile, and keep one tracked file as
the record of features, notes, messages and launches. A built-in MCP server
gives Claude Code and Codex the same powers. Integrations that only one fleet needs live in plugins (see Plugins).

Zero npm dependencies. Node 24 (already on every box via node-tools).

## Run

```
drover serve                   # foreground daemon, http://127.0.0.1:7337
drover open                    # print the URL with the token (and open a browser)
drover status
drover clients                 # apps that authenticated to this daemon in the last day
drover op sessions.list        # any op from the CLI, JSON out
drover op sessions.list '{"host":"box-a","cwd":"~/code/webapp","engine":"claude","live":true,"compact":true,"limit":10}'
drover op files.wait '{"host":"box-a","path":"~/runs/status","glob":"WS-*.md"}'   # blocks until one changes (see Waiting on files)
drover op tmux.capture '{"target":"agents:3","lines":40}'
drover op sessions.message '{"id":"webapp-f8","text":"status?"}'
drover op sessions.message '{"host":"devbox","id":"manager","text":"who is waiting on me?"}'   # the OpenClaw fleet manager; reply in the result
drover op launch.start '{"engine":"claude","mode":"tmux","profile":"claude-default","cwd":"~/code/webapp","prompt":"hi","name":"demo"}'
drover op launch.start '{"engine":"codex","mode":"tmux","profile":"codex-workspace","effort":"xhigh","cwd":"~/code/webapp","prompt":"hi"}'   # one session at that reasoning effort
drover op launch.efforts       # effort levels launch.start accepts, per engine
drover import-survey ~/survey/state-survey
drover mcp                     # MCP server on stdio (Claude Code: mcp.base.json, Codex: config.toml, both wired by install.sh)
drover tui                     # the terminal UI: the manager first, the board, sessions, and the web UI's other views
drover manager popup           # float the manager over this tmux window (--independent: this window's own conversation)
drover manager keys --install  # prefix + g toggles the shared manager, prefix + G this window's own
```

The TUI, the popup and their keys: `tui/README.md`; the agent skill for the popup: `../skills/drover-manager/SKILL.md`.

`drover op` runs the op in its own process: reads are live (no cache), and a write is recorded in the truth file
the way the daemon records one, as actor `cli` unless the args name one. Every front logs a write's args with
secrets redacted at any depth (argv items, nested objects, text before it is trimmed).

install.sh links `drover` into `~/.local/bin`, installs the launchd agent
(`dev.drover.daemon`, always on) on Macs and `drover.service` on Linux boxes.
To reach it from a phone or watch, keep it on loopback and publish it on the tailnet over HTTPS:
`tailscale serve --bg --https=8446 http://127.0.0.1:7337` (any free port), then use
`https://<machine>.<tailnet>.ts.net:8446` in the clients. The watch app only allows plain http on the local
network, and the browser UI needs HTTPS for its service worker, so prefer this over binding the daemon to
the tailnet with `DROVER_BIND=100.x.y.z` in `~/.local/state/drover/env` (which also drops 127.0.0.1).

## Renamed from apx-web (shim until 2026-11-15)

Drover was called apx-web (CLI `apxw`) until 2026-10-15. Until 2026-11-15:

- `apxw` is a symlink to `drover` that prints one deprecation line on stderr and otherwise behaves the same.
- Every `DROVER_<NAME>` variable falls back to the old `APXW_<NAME>` (`core/envvars.js`).
- The first `drover` command on a box moves `~/.local/state/apx-web`, `~/.cache/apx-web` and `~/.local/share/apx-web` (the search embedder) to their `drover` names
  and leaves a symlink at the old path (`core/paths.js`), so the browser keeps its token and an old daemon keeps working.
- The truth file moves from `claude/apx-events.jsonl` to `claude/drover-events.jsonl`: the first read copies it, and
  lines that boxes still on the old code append to the legacy file are imported by id (`core/events.js`). The legacy
  file is never written by Drover; it is removed from dotfiles together with the shim.
- Remote rpc over ssh runs `~/.local/bin/drover`, else `~/.local/bin/apxw`, so a box that has not synced still answers.
- The browser copies its `apxw.*` localStorage keys to `drover.*` once (`ui/legacy-storage.js`).
- MCP: server `drover`, tools `drover_*`, resources `drover://` (were `apx`, `apx_*`, `apx://`).

## How it talks to agents

- Claude Code: `~/.claude/sessions/<pid>.json` is the live registry; messages go
  into `/tmp/cc-socks/<pid>.sock` as `{"type":"auth",...}` then
  `{"type":"user","message":{...}}` (verified on 2.1.296). Replies are read from
  the session transcript JSONL. Headless sessions run `claude -p` with
  stream-json in both directions and are held open by the daemon.
- Codex: the daemon owns the one read-only `codex app-server` for the host.
  `drover rpc`, `drover op` and the MCP server read threads through it
  (`codex.threads`, `codex.thread` in `core/api.js` `preferDaemon`) and share
  its list cache. A local reader starts only when the daemon is unreachable or
  too old to know the op. A slow or failing daemon read is reported; it does
  not start a second reader. Listings are stale-while-revalidate
  (`core/codex.js`): under 30 seconds old, the list is reused; up to 10 minutes
  old, it returns at once while one refresh per key runs behind it; older than
  that, the caller waits. A failed refresh keeps the last good list and waits
  one TTL before the next try. `DROVER_CODEX_LIST_TTL_MS` (default 30000) and
  `DROVER_CODEX_LIST_MAX_STALE_MS` (default 600000) change those windows.
  Messages to a TUI thread go through `codex queue --thread`. Headless threads
  still run on the shared server the daemon holds.
- OpenClaw manager (`core/openclaw.js`): on the host whose `~/.openclaw-manager/`
  holds an `openclaw.json`, one session `manager` (engine `openclaw`) is listed;
  `sessions.message` POSTs to the gateway's loopback `/v1/chat/completions` (streaming) with
  the token from `~/.openclaw-manager/.env` (never returned) and a stable
  `user: drover:<actor>` (`drover:<actor>:<thread>` for a `thread` other than main: its own
  conversation). The message is recorded in the WAL at once, the reply streams to SSE
  (`manager` events: start, delta, done, error) and is recorded as a `chat` event (with `error`
  when the delivery failed). `wait: false` returns before the reply. `sessions.transcript` for
  the manager is rebuilt from those events, so it survives restarts and is the same in every
  client; `openclaw.threads` lists the conversations.
  Installed and refreshed only by `drover manager setup --scope local|all` from `openclaw-manager/`
  (`core/openclaw-install.js`: pinned lockfile, one role with a scope per install, profiles as data, launchd
  or systemd, a manifest the console reads); see `openclaw-manager/README.md`.
- tmux: paste-buffer with a dialog guard (never Enter into a selector unless
  `force`). Launches hand tmux an argv, never a shell string; an argument that
  ends in ";" is escaped (`core/tmux.js` tmuxArg), because tmux would otherwise
  read it as the end of the command and run the next argument as a tmux command.
  Window, pane and session lists split `-F` output on `<|>` (`core/tmux.js`
  `SEP`). tmux 3.4 (Ubuntu 24.04) escapes control characters in format output,
  so the old U+001F separator came back as the four characters `\037`, no line
  split, and every window lost its pane, pid and cwd. tmux 3.8 prints control
  characters raw, which is why a Mac on 3.8 never showed the bug. A field that
  itself contains `<|>` would still shift the split; session names, commands
  and paths do not.
  No request value can become an agent option either: the prompt follows `--`
  (`claude ... -- <prompt>`, `codex ... -- <prompt>`), a Claude resume id is bound
  as `--resume=<id>` (that option's value is optional, so a separate "-..." id would
  be read as the next flag), a Codex one goes after `resume --`, and a message to a
  Codex thread is `--message=<text>`.
  Other hosts: `ssh <alias> drover rpc`, newline JSON, no open ports.
- Op names are dot-separated words (`sessions.list`, `tmux.capture`):
  `core/daemon-client.js` `OP_NAME`, `/^[a-zA-Z]+(?:\.[a-zA-Z]+)*$/`.
  `callDaemon` and the browser client refuse anything else before a request is
  built. The error is flagged `badOp`, not unreachable, so the daemon is not
  forgotten and MCP does not re-run the call in-process. The resolved URL must
  also stay on the daemon origin with pathname `<base>api/op/<op>`. URL
  resolution treats `..`, `%2e%2e` and `\` as path segments, so an op such as
  `../pair/approve` would otherwise POST `/api/pair/approve` with the main
  token. That route is deliberately not an op: approving a pending pairing
  request hands the token to the client that asked. MCP `drover_op` passes
  model-chosen names through this check. Approving a device stays
  `drover pair approve <code>`.
- Rollouts (`core/remote.js`): a `drover rpc` started before its host pulled new code
  answers new ops with "unknown op". The daemon then retires it, so it finishes what it
  owes and gets EOF only after its last reply, and retries on a fresh one, at most once
  per 10 minutes per host. A retired child that hangs is killed after 150 s.
- While a call is in flight, `drover rpc` writes a blank line every 30 s (`DROVER_RPC_BEAT_MS`); callers skip blank
  lines. It keeps an hour-long `files.wait` from looking idle, and when the write fails (the caller's ssh session is
  gone) the waits it left end at once instead of polling for nobody. Everything else in flight still runs to its end.

## Launch effort

`launch.start` (and `drover_launch`, and the Effort field in the Launch view) takes an
optional `effort`: the reasoning effort of that one session, set at launch so nobody
has to type `/effort` or `/model` inside it (in Claude Code those overwrite the global
default in `~/.claude/settings.json`; a launch flag does not).

| engine | passed as | levels |
|---|---|---|
| claude | `--effort <level>` (tmux and headless) | low, medium, high, xhigh, max |
| codex | `-c model_reasoning_effort="<level>"`; a headless thread gets the same key in thread/start `config` | low, medium, high, xhigh, max, ultra |

- The lists live in `core/effort.js` and were checked against Claude Code 2.1.301
  (`claude --help`) and Codex 0.162.1 (`codex debug models`). Anything else is refused
  before anything starts, picks a credential or is recorded: Claude Code would only warn
  and fall back to its default, and Codex sends any string to the model.
- Codex per model: when the launch names a `model`, the level must be one that model
  lists in this host's `codex debug models` (Luna stops at max, gpt-5.5 at xhigh), or the
  launch is refused; Codex itself would send it anyway. Without a model (the profile or
  config picks it), for a model the catalog does not know, or when the catalog cannot be
  read, the engine list applies. The catalog is read only for such a launch, and cached
  for 10 minutes.
- Omitted, the launch is exactly what it was before (same argv, env, event, result).
  With a profile and a model the order is profile argv, model, effort, then resume and
  `--` with the prompt. Codex's `-c` wins over a `-p` profile's own effort. Resuming a Codex
  session with an effort takes the model from the profile or `model`, not from the thread.
- The launch event, the result and `headless.list` carry `effort` when one was set.
- Rollouts: a Drover from before efforts would ignore the field and start the agent at its
  default. `launch.efforts` is the probe: the daemon asks a remote host (retiring a peer
  that predates the host's update) and refuses with nothing started when the host is
  older; `drover_launch` asks its own daemon the same way; the Launch view disables the field
  for such a host. Restart a daemon onto the new code before launching with an effort there.

## Launch trust

Claude Code and Codex ask once per folder whether to trust it, before the session starts. Claude Code's dialog
("Accessing workspace: ... Is this a project you created or one you trust?") opens with "No, exit" focused, and
`--dangerously-skip-permissions` does not skip it, so on 2026-10-16 every worker `launch.start` opened in a fresh
worktree sat at it until someone sent Down and Enter. A tmux launch now records its `cwd` as trusted first, the way
accepting the dialog would (`core/trust.js`), and the agent starts at its prompt. `trust: false` (launch.start,
`drover_launch`) leaves the config alone. Headless launches skip it: `claude -p` never shows the dialog, and a
headless Codex thread runs on the app-server.

| engine | written | key |
|---|---|---|
| claude | `projects[<key>].hasTrustDialogAccepted = true` in `~/.claude.json` (`$CLAUDE_CONFIG_DIR/.claude.json`, or the legacy `.config.json` while in use) | the folder's real path (Claude Code keys its physical cwd: a symlinked cwd counts as its target), NFC; inside git the checkout root, and for a linked worktree its main checkout, plus the worktree's own root |
| codex | `[projects."<root>"]` with `trust_level = "trusted"` in `$CODEX_HOME/config.toml` (`~/.codex`) | the repository root, a worktree's main checkout, real path; outside git Codex does not ask, so nothing is written |

- Checked against Claude Code 2.1.308 (its bundle, then accepting the dialog in scratch folders: in a worktree it
  wrote the main checkout's key, and through a symlink the real path) and Codex 0.163.0 ("Trusting will apply to the
  repository root", the table it appended). Claude Code also trusts a folder when any folder from it up to its git
  root is trusted, and outside git any folder up to `/`. Drover writes the key the dialog writes; for a worktree
  also the worktree's own root, the key a release that keeps worktrees apart looks up. In 2.1.308 that is the last
  folder of the walk, so it trusts nothing more.
- Only `hasTrustDialogAccepted` changes: the rest of the file, the rest of each project's entry and the file's mode stay. The
  file is written to a temp file beside its real path and renamed over it (a symlinked config stays a link). A
  missing file is created 0600; an empty one starts from `{}`. A file that does not parse is never rewritten: the
  launch goes ahead, its `trust` says why nothing was written, and the daemon log says so too.
- Claude Code's writers hold `<the config path they use>.lock`, `~/.claude.json.lock` (proper-lockfile: a directory
  made with mkdir, abandoned after 10 s), and re-read under it. Claude Code hands proper-lockfile that `lockfilePath`,
  so a symlinked config is locked by its link's name, not its target's. Drover takes the same lock for the few
  milliseconds of its edit, so neither side drops the other's change, and the lock of the file behind it too
  (`<realpath>.lock`): two config paths that lead to one file (two `CLAUDE_CONFIG_DIR`s, say) queue on that one.
  The lock, the read and the replacement all follow that one file; a link to a missing file is left as it is. What
  is left: a writer that skips the lock (Claude Code when it cannot get it, older versions) can drop the key before
  the agent starts (the cost: the old dialog). Concurrent launches from Drover queue on those locks too, and on
  `<realpath of config.toml>.drover-lock` for Codex, so a fan-out keeps every entry. Codex itself keeps no lock, so a
  Codex write in the same few milliseconds drops one of the two changes (ours: the old prompt; theirs, say another
  folder's answer: it is asked again). Either way the file stays whole.
- The home folder is never written: Claude Code itself trusts it for one session only.
- A Codex table already there is only read, never edited: its decision is kept, `untrusted` included (any quoting
  of `trust_level`). A `config.toml` that names the root anywhere but the exact header Codex writes
  (`["projects"."<root>"]`, a `[projects]` entry, dotted keys, any other key), or holds `projects` as an inline
  table, is left alone, because a second definition of a table or key stops Codex.
- It runs where the launch runs: a launch on another host writes that host's files. A host on older Drover code
  ignores `trust`, starts the agent at the dialog as before, and its result has no `trust`.
- The launch result and its `launch` event carry `trust`: `{ engine, key, also, file, changed }`, or `{ engine, skipped }`.

## Session lists

`sessions.list` (and `drover_sessions`) takes optional filters, applied on the host that holds the sessions, so only
what passes travels: `cwd` (that folder or inside it, on path boundaries; `~` is that host's home, a trailing slash
is ignored), `name` (substring, any case), `engine` (`claude`, `codex`, `openclaw`, `grok`; comma-separated for
several), `live` (true or false), and `limit` (that many, the most recently active first). Add `compact` for what a
board reads (live sessions and dead Claude or headless ones, previews cut to 200 characters): a busy host's whole
list ran to about 300 KB, mostly Codex first prompts, and overflowed the context of the agent that asked. With any
filter the answer carries `matched`, the count before `limit`. A host on Drover code from before the filters
ignores them and answers without `matched`; `drover_sessions` then applies them itself and adds a `note` (except a
`~` cwd for another host, whose home it cannot know: pass it absolute).

## Waiting on files

`files.wait` (`core/filewait.js`) blocks until a file, or the direct entries of a directory, are added, removed or
modified, then answers `{ changed: true, changes: [{ path, kind }], waitedMs, ts, exists }` (kind added, removed or
modified); after `timeoutSec` with nothing changed, `{ changed: false, waitedMs, ts, exists }`. It replaces a coordinator's
`sleep N; ssh host cat ...` loop, whose every tick woke the model (tokens, context, a prompt-cache miss) and which saw
changes a tick late.

```
drover op files.wait '{"host":"box-a","path":"~/runs/status","glob":"WS-*.md"}'
drover op files.wait '{"host":"box-a","path":"~/runs/status","glob":"WS-*.md","since":"<ts>","existed":true}'   # ts and exists of the last answer
```

- `path`: a file or a directory, absolute or `~/` (that host's home). A missing path is waited for until it
  appears. `glob` (a directory only) watches the entries whose names match `*`, `?`, `[abc]`, `[!abc]`.
- `timeoutSec` default 1800, 1 to 3600; `intervalMs` default 2000, 100 to 60000. The answer shows both as used.
- `since` and `existed`: the `ts` and `exists` of the previous answer, so a change made while the coordinator handled
  the last one is not lost. Anything modified after `since` counts at once (its mtime or ctime, so a file renamed in
  counts), and so does a directory whose own mtime moved: an entry was added or removed. That holds with a glob too,
  because a matching file deleted between two waits leaves only the directory's mtime behind; churn among entries
  the glob does not match can therefore wake it. A false wake costs one look, a missed one the whole timeout. A
  watched path that was there (`existed: true`) and is gone counts as `removed`, one that was not and is there as
  `added`. Same host clock: mtimes on a network mount come from the server.
- A stat poll (mtime, size, inode), not fs.watch: fs.watch misses changes on WSL (9p mounts such as `/mnt/c`),
  network mounts and some container bind mounts, and on Linux follows an inode, so a file replaced by an atomic save
  leaves it watching the old one. Metadata only, never content. At most 10,000 matching entries, counted before any
  is statted on every scan: a directory over it is refused, and one that grows past it ends the wait with that
  error. At most 500 changes listed (`more` counts the rest).
- Design: one read-only op whose wait lives in the process that asked (`drover op`, the daemon, or the `drover rpc`
  serving a remote caller); no daemon state, lock or new channel. A forwarded call gets `timeoutSec` plus a minute
  (`api.js` `hostTimeoutMs`); the rpc's blank-line heartbeat keeps the ssh link active and ends the wait when the
  caller is gone. A host on older code answers "runs Drover code from before files.wait".
- Over MCP (`drover_files_wait`, or `drover_op`) a call waits at most 110 s, since a tool call holds its session
  and the daemon call behind it gives up at 130 s. A long wait is `drover op files.wait` under Claude Code's
  background Bash, which tells the session when the command exits (`../skills/drover/SKILL.md`).

## Alerts, sounds and the browser

- The daemon detects transitions from its snapshot warmers (`core/notify.js`):
  a dialog or held peer message appearing ("needs a decision"), a session that
  stops on a question or an unanswered AskUserQuestion ("asked you a question"),
  busy to idle ("finished", with an excerpt of the reply), a session dying, a
  host going dark, launches, manager messages, and what a plugin watches
  (a merge request watch, say, while a browser is open). Each lands in the WAL as a `notify` event and goes out as the
  `alerts` SSE event. Claude's Notification hook events are enriched with the
  same context before they are written. A front daemon pulls other hosts'
  alerts with `notify.recent` instead of detecting them twice.
- Settings are fleet-wide `settings` events (`settings.get/set/reset`,
  `notify.mute/unmute`, `notify.test`, `notify.send` for agents). The policy
  (categories, sounds, quiet hours, away rule, coalescing) is
  `ui/notify-policy.js`, shared by daemon and browser.
- Browser: one leader tab rings (Web Locks); sounds are synthesized with
  WebAudio; speech uses local voices only; the service worker (`ui/sw.js`)
  gives notifications Approve / Deny / Reply / Open and never touches `/api/`.
  Title, favicon and app badge show the waiting count.
- Composer: paste, drop or attach files (`uploads.put` writes them to
  `~/.cache/drover/uploads/<session>/` on the session's host, 20 MB cap, and the
  message names the paths); hold Option+Space to dictate (on-device recognition;
  the cloud recognizer only when allowed in Settings).
- Views: Settings, Files (editor over `files.*`, allowlisted to ~/.dotfiles,
  ~/.claude, ~/.codex, ~/code/*/CLAUDE.md and AGENTS.md, secrets refused),
  Manager (OpenClaw console: `openclaw.status/check/sweep/feed`). `w` opens the
  waiting board in Document Picture-in-Picture; `p` pops a drawer out; `?`
  lists every shortcut. Direct peers (Settings) let the browser call another
  daemon over a forwarded port or the tailnet instead of ssh rpc.

## Vitals, resource alerts and placement

```
drover op host.vitals                                    # this machine: the daemon's last sample, or one now
drover op fleet.vitals                                   # every machine of this identity, offline ones as last seen
drover op fleet.place '{"class":"claude-session"}'       # where the next session should go, and why
drover op launch.start '{"host":"auto","engine":"claude","prompt":"hi"}'   # launch where fleet.place says
```

- `host.vitals` (`core/vitals.js`, Linux and macOS, no dependencies): load per core, CPU busy, memory available (the
  kernel's MemAvailable; on macOS the free, inactive, speculative and purgeable pages, lowered to
  `kern.memorystatus_level` when that is smaller, plus the kernel pressure level), Linux PSI memory stalls,
  swap used and swap pages per second in and out, every real volume (one `df` for the local ones and one per
  network or FUSE mount, each with its own timeout, so a hung remote leaves the rest measured), and each Claude Code
  and Codex session with its whole process tree (MCP servers, language servers, the builds it runs; a Codex started
  from a Claude Bash call is its own entry), named from the Claude registry. No command line leaves the module: argv
  can hold a whole prompt.
- The daemon samples its own machine every minute (`DROVER_VITALS_SECONDS`) and grades it: `checks` per metric at
  `ok`, `warn` or `crit`. A level has to hold for three samples before it is raised or cleared, rising raises a
  `resource` alert, a critical level that clears says so, easing is quiet, and a critical level that lasts is said
  again every six hours. Its state lives in the state dir (`vitals-state.json`), so a restart does not repeat old news;
  `vitals.json` is the last sample (a peer's `drover rpc` serves it without sampling), `vitals-history.jsonl` one
  line a minute, `vitals-alerts.jsonl` what was raised. Resource alerts go to the alert ring, not the truth file, and
  front daemons pull them with `notify.recent` like any other alert. `DROVER_VITALS=off` stops the monitor; `on`
  forces it on a host the catalog leaves off.
- The fleet catalog (`core/placement.js`): `DROVER_FLEET_CATALOG` (default `~/.config/drover/fleet.json`) plus every
  `*.json` in `DROVER_FLEET_DIR` (default `~/.config/drover/fleet.d`, where a tool that starts machines drops one
  entry each). Every host has an `identity`; this machine's comes from its own entry (found by `DF_MACHINE` in
  `~/.df-profile`, its hostname or an alias), else `DF_IDENTITY`. `fleet.vitals` and `fleet.place` only ever read
  hosts of that identity, so a personal fleet and a work fleet sharing one catalog never poll or place on each
  other's machines; a host named explicitly is refused unless it is one of them. A machine whose identity cannot be
  told (no entry of its own, no `DF_IDENTITY`) sees no other host of a catalog that names identities: it fails closed.
  Two entries for one name with different identities are never merged (the later one is reported and ignored).
  Without a catalog the monitor runs everywhere and the fleet is this machine plus the fleet hosts that answered the
  last probe.

  ```json
  { "hosts": [
      { "name": "box-a", "identity": "personal", "aliases": ["a"], "ssh": "box-a",
        "placement": { "classes": ["claude-session", "codex-session"], "weight": 0.6, "reserveMemGB": 3 },
        "monitor": { "enabled": true, "thresholds": { "memAvailableGB": { "warn": 4, "crit": 3 } },
                     "volumes": { "/data": { "diskUsedPct": { "warn": 80, "crit": 90 } } }, "ignore": ["/mnt/peer"] } } ],
    "placement": { "classes": { "gpu-job": { "needMemGB": 12, "needCores": 2 } } },
    "monitor": { "thresholds": { "diskUsedPct": { "warn": 85 } } } }
  ```

  Thresholds are `DEFAULT_THRESHOLDS` in `core/vitals.js`, then the catalog's, then the host's; each is
  `{ warn, crit }`, null turns a level off. `ignore` mounts are never measured. Swapping is graded on pages swapped
  out (`swapOutPerSec`); pages in plus out (`swapIoPerSec`) count only while memory is short (the `mem` check at
  `warn` or worse), so a host paging back in after a squeeze is reported, never raised.
- `fleet.place` judges every host with a `placement` policy: the workload's memory (`claude-session` 3.5 GB,
  `codex-session` 2, `heavy-build` 6 and 20 GB free disk, `macos-only` only on macOS) must leave the host's
  `reserveMemGB`; load must stay under `maxLoadPerCore` and `maxLoad`; macOS memory pressure under `maxPressure`
  (`normal`; `macos-only` may go at `warn`, never at `critical`), Linux stalls under `maxPsiSome60`; swap under
  `maxSwapPct`/`maxSwapGB`, pages swapped out under `maxSwapIoPerSec` (pages in plus out count against that cap only
  while memory is short, the same rule as the monitor, so a host paging back in is not refused); free disk on
  `diskPath` over `minFreeDiskGB`. Among the eligible, the most memory and CPU headroom times `weight` wins
  (a production box gets a weight under 1), with the
  caller's own machine winning a near tie. The answer names the host (`local`, or the ssh alias), the reason, and
  every candidate with why it was passed over. Outside the daemon the daemon answers, through its warm ssh peers.
- `launch.start` with `host: "auto"` (`drover_launch` too) places, then launches there; nothing starts when no host is
  eligible. A chosen host that never accepts the ssh connection is excluded and the launch placed once more.
- `resource` is an alert category of its own in the browser's settings (sound `fall` by default).

## Search

Every host's daemon indexes what was said in its Claude Code sessions (with subagents),
Codex rollouts, truth-file notes, messages and survey items, memory notes, documents (Codex memories and their
dotfiles snapshots, dotfiles specs and docs), and reflection items, and searches it by meaning and by exact words
(`core/search/`). What agents ran (shell commands, files
written or edited, URLs fetched) is indexed for words only (role `command`, no vectors); tool output is not
indexed, and `drover grep` searches the raw transcripts for it. Memory homes and documents keep to the host's
identity. Vectors come from EmbeddingGemma 2 through a local `llama-server` the daemon starts on loopback;
nothing leaves the machine.

```
drover embed setup [--from HOST]      # once per host: build llama-server, install the model (no sudo)
drover search why does the breaker trip
drover search '!4469' --here
drover grep turbo.json --roles tool_result   # raw transcripts on every machine, tool output included
drover embed status
```

Ops: `search.semantic` (one host), `search.fleet` (every reachable host, merged, with `coverage.notCovered`
naming the hosts it could not see), `search.grep` / `search.grepFleet` (ripgrep over the raw transcripts),
`search.status`, `search.reindex`; MCP tools `drover_search_*`. UI: the Search view (`g`, or
`search <words>` in Cmd+K). In `~/.local/state/drover/env`: `DROVER_SEARCH=off` turns indexing off on a host;
`DROVER_SEARCH_DAYS=N` limits it; `DROVER_SEARCH_KINDS=claude,subagent` indexes only those kinds (an archive
host); `DROVER_SEARCH_DOCS` replaces the document patterns (`|`-separated, `off` for none).

Reflections come from the reflections CLI (`reflections export`), not a file: each pass reads what
changed in the last day, and once per UTC day everything, so derived `stale` statuses refresh. One
chunk per item (title, body, tags and its `#id`, so two items with the same words stay two hits);
status, kind and repo sit beside it, so closing an item never re-embeds it. The chunk also keeps the `host` that
added the item and its exported `checkout` (tenant search is authorized on them; the CLI's `cwd` is never used, see
Native tenants). Hits carry `id`, `status` and `repo`; filter with `kinds: ["reflection"]`, `status`,
and `role` (the item's kind). The export keeps to the host's identity (`DF_IDENTITY`, from the environment or `~/.df-profile`, when there is one). A missing
or failing CLI is logged and skipped.

## Plugins

What only one fleet needs (an integration with a private forge or deploy pipeline, a personal memory service, hosts
that are not ssh aliases) lives outside this repository as a plugin, so Drover itself stays generic and the private
part stays private. A plugin is a directory with a `plugin.js` whose default export describes it; every process that
runs ops (`serve`, `rpc`, `op`, `mcp`, `search`, `grep`, `stacks`, `tui`) loads the same plugins at start.

- Which: `DROVER_PLUGINS`, plugin directories separated by `:` (a leading `~/` is your home); unset, every directory
  in `~/.config/drover/plugins/`, in name order.
- What a plugin can add (every field optional; the full list and shapes are in `core/plugins.js`): ops and front-only
  ops with their MCP descriptions and schemas (so they become `drover_*` tools), cache and invalidation rules, truth-file
  event types with validators, lines for the MCP server's instructions, a host provider (hosts such as `space:<name>`
  that are reached some other way than ssh: listing, rpc argv, exec, docker stacks), the `preserved` search kind, daemon
  start and stop hooks, web UI views and `drover tui` tables.
- A plugin imports Drover's own modules as `drover/core/<module>.js`; that specifier resolves to the checkout that is
  running, so the plugin and the core share one copy of every module, wherever the plugin's repository lives.
- A plugin that fails to load is skipped, never fatal: the command names it on stderr (the daemon's log for `serve`)
  and goes on without it. An op name a core op or an earlier plugin already has is refused the same way. `GET /api/ops`
  answers `plugins`: each plugin's name, ops and views, no paths.

```js
// ~/.config/drover/plugins/hello/plugin.js
export default {
  name: 'hello',
  ops: { 'hello.say': async ({ to = 'world' }) => ({ text: `hello, ${to}` }) },
  meta: { 'hello.say': { m: false, d: 'Say hello.', s: { type: 'object', properties: { to: { type: 'string' } }, additionalProperties: false } } },
};
```

`drover op hello.say '{"to":"you"}'`, and MCP gets `drover_hello_say`.

## Settings files

Before `~/.env_secrets`, every command reads `~/.config/drover/*.env` (`DROVER_CONFIG_DIR` moves it), in name order:
`KEY=value` lines for the non-secret settings of one fleet, kept in that fleet's private repository and linked in. A
value already in the environment wins. The settings a fleet usually sets:

| Setting | Default | What it is |
|---|---|---|
| `DROVER_OWNER`, `DROVER_OWNER_NAME` | `owner`, "the owner" | the actor the owner's own clients write as, and how prompts and prose name them |
| `DROVER_DEFAULT_REPO` | none | the repo memory, handoff and reflection ops use when a call names none |
| `DROVER_PROFILES` | `web/profiles.json` | launch profiles, models, the tmux session a launch opens in (`tmuxSession`, else the first of `tmuxSessions`, else `agents`), cwd suggestions and the credential pool |
| `DROVER_OPENCLAW_OVERLAY` | none | a private overlay for the OpenClaw manager's profiles, roles and seeds (`openclaw-manager/README.md`) |
| `DROVER_TENANT_PREFIX` | `tenant` | native bot tenants connect as `<prefix>-<tenant>` (Native tenants) |
| `DROVER_SSH_EXCLUDE` | `-ssm$\|jump$\|^github\.com$` | ssh-config aliases the host list leaves out (a regular expression) |
| `DROVER_DOCKER_LABEL_PREFIX`, `DROVER_DOCKER_KINDS`, `DROVER_DOCKER_BASE` | see Docker stacks | how stacks are labelled, grouped and compared |
| `DROVER_DOTFILES` | `~/.dotfiles` | the repository that holds the truth file (`claude/drover-events.jsonl`) and the fleet host list |
| `DROVER_UPDATE_HINT` | "pull its Drover checkout and restart its daemon" | what an error tells you to do about a host on older code |

## Docker stacks

Every compose stack on every machine, on demand: each service healthy, up (running with no healthcheck), unhealthy,
starting, restarting, completed (a one-shot job that exited 0), failed, stopped, created, paused or dead, with why;
counts per stack and, when `DROVER_DOCKER_KINDS` defines them, per kind of service; and the code each stack runs: the
working dir's git state (branch or detached HEAD, subject, dirty files, ahead/behind, worktree of which repo), the repos
behind its bind mounts when the working dir is not one, the `<prefix>.commit` label against HEAD, compose files, ports,
and built images older than HEAD.

```
drover stacks                         # every reachable machine (--host H, --here, --project P, --fresh, --all, --json)
drover op docker.logs '{"project":"webapp","service":"web-app-reports","tail":50}'
drover op docker.restart '{"host":"box-a","project":"webapp","services":["web-app-reports"]}'   # recorded only through the daemon
```

Ops `docker.stacks` (one host, cached 30 s), `docker.fleet` (every reachable host, each through that cache, with
`coverage`; a summary per stack unless `services: true`), `docker.logs` (one service, merged and redacted, never cached), and the verbs `docker.restart`,
`docker.start` (exited or created containers only), `docker.exec` (an argv in a running service, never a shell string)
and `docker.run` (`compose run --rm -T --no-deps --pull never`, with the compose files on disk and the image on the
host); MCP `drover_docker_*`; the Stacks view. A verb acts only on a project and service discovery finds on that host
when it is called, refuses any argument it does not take (no user, privileged mode, env, entrypoint, working dir,
volume or host path), is bounded and capped, and is recorded in the truth file with its exit code. Down, rm, rmi,
prune, kill, stop, build, pull, scale and volume or network changes are never offered. Container environments never
leave docker (the inspect template leaves them out). A host without docker or a daemon says why
(`docker.available: false`); a host a plugin provides that runs no Drover is read through that plugin (`readOnly`:
health in full, a lighter code line, no logs or verbs). Neither the widget token nor the bot gateway reaches any of
these ops.

| Setting | Default | What it does |
|---|---|---|
| `DROVER_DOCKER` | `docker` on PATH | the docker CLI |
| `DROVER_DOCKER_LABEL_PREFIX` | `drover` | the label prefix of the commit a service was built from (`<prefix>.commit`) |
| `DROVER_DOCKER_KINDS` | none | JSON list of `{ kind, match, label? }`: a service whose name matches `match` (a regular expression) is that kind, first match wins, the rest are `infra`; unset, or when no rule matches, stacks have no kind breakdown |
| `DROVER_DOCKER_BASE` | none | the branch ahead/behind counts against when a checkout has no upstream (before `origin/HEAD`) |

A bad value is ignored with one line on stderr, and the default applies. For example
`DROVER_DOCKER_KINDS=[{"kind":"app","match":"^web-app-","label":"apps"},{"kind":"core","match":"^web-"}]`.

## Reflections

`drover_reflections` (ops `reflections.*`) fronts the dotfiles `reflections` CLI: `list`, `repos`,
`search` (the CLI's keyword index), `semantic` (this host's search index, by meaning; the CLI's
search when the index cannot answer or has not finished a reflections pass yet), `show`, `candidates`, `add`, `edit`, `done`/`reopen`/`drop`,
and `apply` (a batch of done/drop/reopen/edit ops by exact id; needs `repo` or `anyRepo`). Writes
carry the caller's actor, so the truth file records `mcp`, and the CLI gets it as `--agent`. Reads
keep to the host's identity unless `anyIdentity`. `DROVER_REFLECTIONS_BIN` points at another CLI
(default `~/.dotfiles/scripts/reflections`).

## Grok bots

Grok Bot agents run on xAI's models in hosted VMs that only make outbound connections, and Grok Bot connects a remote
MCP server only through OAuth with dynamic client registration. The bot gateway (`server/botgate.js`, `core/bots/`)
gives the owner's bots Drover anyway, in both directions.

- **Bots to Drover**: a second listener, `127.0.0.1:7338` (`DROVER_BOTS_PORT`), on when `DROVER_BOTS_URL` names its
  public origin. It serves only OAuth (`/.well-known/*`, `/oauth/*`), an authorize page, and MCP over Streamable HTTP
  at `/mcp`: purpose-built tools (below), never `/api/`, the UI or an op by name.
- **Drover to bots**: bots are sessions (engine `grok`, ids `grok:<name>`) on the host that runs the gateway.
  `sessions.message` (`drover_send`, the drawer, `drover bots send`) POSTs to the bot's Routine webhook, or queues the
  message for its inbox when it has none; the bot answers with `drover_reply`, which lands as a `chat` event threaded
  under the message, and reports `drover_status`, which shows on the board. A reply raises a "finished" alert;
  `needs-owner` and `blocked` raise "needs you" and put the bot in the waiting lane until its next status (a bot taught
  the earlier `needs-<DROVER_OWNER>` is read the same). A bot is
  live when it was heard from, or its Routine accepted a message, in the last day (a Routine alone makes it reachable,
  not live). One that should be acting and has gone silent, its last status `working` or a message its Routine
  accepted still unanswered, turns `stale` after `DROVER_BOTS_STALE_MINUTES` (default 30) and says why; waiting on
  the owner never goes stale.

### Setup

1. Publish the gateway over HTTPS. Simplest: Tailscale Funnel (public), `tailscale funnel --bg --https=10000
   http://127.0.0.1:7338`, then the origin is `https://<machine>.<tailnet>.ts.net:10000`. With Grok Bot's official
   Tailscale plugin the bots reach the tailnet themselves, so `tailscale serve --bg --https=8447
   http://127.0.0.1:7338` (tailnet only) is enough. A Cloudflare Tunnel works too.
2. `echo 'DROVER_BOTS_URL=https://<that origin>' >> ~/.local/state/drover/env`, then restart the daemon
   (`launchctl kickstart -k gui/$(id -u)/dev.drover.daemon`). `drover bots` shows the gateway's MCP URL.
3. Connect each bot on its own, at its own URL. Tell the bot (say it is called Ada): "Add a custom MCP server called
   Drover Ada at `<origin>/bots/ada/mcp`" (its own name, lowercase in the URL), and keep that connector on that bot only. Each
   bot's URL is a separate server with its own sign-in: Grok Bot keeps one sign-in per server, so connectors that
   share a URL share one bot's identity (seen with the root `<origin>/mcp`: "Drover Ada" connected as another bot).
   Its connect card opens the authorize page, which shows a 6-digit code and the bot; approve it in the Drover banner
   or with `drover bots approve <code>` (a request through `/bots/ada/mcp` can only be approved as ada; the root
   `/mcp` needs `--as <bot>`). The server takes no other bot's connection: a token of another bot is refused there,
   and the client signs in again. A connection belongs to one bot: everything written through it is recorded as that bot, and no tool takes a
   bot name. Grok Bot connectors are account-wide, so the gateway tells connections apart, not bots: a bot that can
   reach another bot's connector can act as that bot. A static token in the bot's own chat-added server (`drover bots
   token --as <bot>`) binds just as tightly. `drover bots approve <code> --shared` is the explicit exception: one
   read-only connection any bot may use (fleet, search, features, reflections, brain reads), with no writes, alerts or
   inbox.
4. Teach the bots the contract: `drover bots skill` prints the bot-side skill
   (`../integrations/grok-bot/skills/drover/SKILL.md`); give it to a bot to save as a skill named `drover` (skills
   are shared by all bots and enabled per bot). In Grok Bot, add an **Always allow** rule for the Drover tools, or
   routine runs, which do not count as user intent, are held for review.
5. Per bot, for Drover to send it tasks: the bot creates one routine named "Drover" (webhook trigger, the instruction
   `drover_whoami` gives it) and hands you two links that open the routine's Webhook URL and Webhook key in Grok
   Bot's routine panel (a link to the routine itself does not open); copy both from there and run
   `drover bots routine add <bot> --url <url>` (the key is read from a hidden prompt, never argv). A connection test
   follows; the bot should answer "connected".

`drover bots` lists the gateway, connections, Routines and each bot's last state; `drover bots revoke <grantId>` cuts
a connection off at once; `drover bots token --as <bot>` mints a static bearer token for a bot that cannot do OAuth (the token
then passes through that bot's chat once, so OAuth is the better path).

### Tools and what bots can see

| Scope | Tools |
|---|---|
| `drover.read` | `drover_whoami`, `drover_fleet`, `drover_search`, `drover_inbox`, `drover_features`, `drover_reflections` (list, search, show), and with a brain plugin `drover_brain_search`, `drover_brain_get` |
| `drover.write` | `drover_status`, `drover_reply`, `drover_note`, `drover_feature_upsert`, and with a brain plugin `drover_brain_note` (kinds memory and handoff, filed under `agent:grok-<bot>`) |
| `drover.notify` | `drover_notify_owner`, also served as `drover_notify_<DROVER_OWNER>` for bots taught that name (12 alerts an hour per bot, counting `needs-owner` statuses) |

The brain tools exist only where a plugin provides the `brain.*` ops (search, get, note); without one, the bots are
neither offered them nor told about them.

Everything a bot reads leaves your machines for xAI. There is no content filter for the owner's own (legacy) bots
(every bot name except the native tenants' `<prefix>-*`): they see every project, session and machine the owner's
agents see, and messages reach them as written. `core/bots/policy.js` cleans every string that goes
out: secrets redacted, home paths as `~`, long text cut. No tool takes `host`, messages or launches other agents, or
reads raw transcripts or the raw truth file. Reflections are read-only for bots and brain notes cannot be decisions,
because both reach every Claude session's context.

### Security

- Approving a connection, revoking it, minting a token and setting a Routine are main-token HTTP routes
  (`/api/bots/*`), never ops, like pairing: no MCP tool or ssh rpc can let a bot in or redirect its Routine.
- PKCE S256 is required; authorization codes are single use and live a minute; access tokens an hour; refresh tokens
  rotate (60 days), and replaying a used one revokes the whole grant. Tokens and keys are stored only as SHA-256
  hashes in `~/.local/state/drover/bots/oauth.json` (0600); Routine URLs and keys live in `bots/grok.json` (0600) and
  are never returned or recorded.
- One connection per bot: a grant names its bot, its writes are recorded as `grok:<bot>`, and no tool takes a bot name
  (an `agent` argument is refused), so a connection cannot write as another bot, read its inbox, answer its messages
  or find them in `drover_search`. A `--shared` grant is read-only and acts as no bot. The gateway refuses foreign
  `Origin` headers.
- What a bot writes is marked for every agent that reads it later: notes, feature titles and notes, and brain memory
  titles and bodies start with `[untrusted: grok:<bot>]`; its status, chat, note and feature events carry
  `source: grok:<bot>` and `untrusted: true`; a feature it wrote to keeps `untrusted` and `untrustedBy` in the fold
  (`drover_state`); its brain memories are tagged `untrusted`; its transcript turns and last reply are marked. The MCP
  server's instructions tell Claude and Codex sessions to read all of it as data, never as instructions.
- Registration and the authorize page need no token, so they are limited per address as well as in all: per address
  10 requests a minute, 3 approvals waiting and 2 approval alerts per 10 minutes; in all 60 a minute, 20 waiting and
  6 alerts per 10 minutes. The same client asking again from the same address replaces its waiting request and
  raises no second alert; a quiet request still shows in the banner and `drover bots pending`. The address is the last
  `X-Forwarded-For` entry, the one the local proxy (Tailscale Funnel or serve, cloudflared) adds, never what the
  client sends; IPv6 counts by its /64. A client whose approval is waiting is never pushed out of the bounded client
  list.
- `bots.status` (op, read-only) reports the gateway, connections, Routines (host and id tail only) and bot states.

### Native tenants (`<prefix>-<tenant>`)

A native tenant is someone else's agent (another person's OpenClaw, say) that the operator lets see a few exact
projects. It is not one of the owner's bots and never gets the owner's authority. The prefix is `DROVER_TENANT_PREFIX`
(a lowercase word, default `tenant`); the examples here use the default. A bot named `tenant-<tenant>` connects only with a **resource delegation** the operator issues at approval time
(`core/bots/access.js`): the exact projects and hosts it may see, pinned to that tenant and bot, with the requester the
connection acts for. No delegation means no connection: such a grant is refused at approval, at code exchange, at
refresh and on every MCP request, and it never falls back to the legacy global tools. Tool arguments are never
authority.

Onboarding, per tenant (here `acme`, gateway origin `https://<gateway origin>` from `drover bots`):

1. On the tenant's OpenClaw (its own state, so its own credentials):
   `openclaw mcp set drover '{"url":"https://<gateway origin>/bots/tenant-acme/mcp","transport":"streamable-http","auth":"oauth","oauth":{"scope":"drover.read drover.write"}}'`
   then `openclaw mcp login drover`. It registers, and the printed authorize URL opens the Drover page with a 6-digit
   code and "tenant-acme, a native tenant". Use the tenant's own URL, never the root `/mcp` and never a
   `--shared` connection: the root needs `--as`, and a shared grant is the legacy global read.
2. On the gateway host, the operator approves with the exact delegation (no `--as` needed through the tenant's URL):

   ```
   drover bots approve <code> --tenant acme --requester imessage:+15550001111 --projects /Users/me/code/webapp,/Users/me/code/api --hosts box-a [--scope read,write]
   ```

   All four of `--tenant`, `--requester`, `--projects`, `--hosts` are required. Projects are exact, case-sensitive
   **canonical absolute physical checkout paths**, not folder names or fuzzy repository aliases: obtain each with
   `realpath` on its approved host. `/public/webapp` never grants `/private/webapp`, even on the same host.
   Commas separate paths/hosts with no spaces. Relative paths, `~`, root `/`, dot segments, duplicate separators,
   trailing slashes, wildcards, blanks, duplicates and the host alias `local` are refused, as is a `--tenant` that
   is not the `<prefix>-<tenant>` the request came through. Each path is approved on each listed host; split grants
   when those host/path combinations should differ. Symlink aliases, sibling checkouts, subdirectories and
   worktrees (including `.claude/worktrees`) are **not inferred**; explicitly approve each physical checkout path.
   Old basename-only tenant grants fail closed and must be revoked/reissued; the owner's own bots are unchanged.
   `--hosts` are Drover host short names; include the gateway host itself (its `drover bots` host) for the
   inbox, reflections and every write, which happen there. `drover.notify` is never granted to a tenant (the default
   scope set loses it; `--scope notify` is refused). The browser banner and the Drover app cannot approve a tenant
   request: only the CLI carries a delegation.
3. The page redirects to OpenClaw's loopback callback and login finishes. When the browser is on another machine,
   copy `code` from the callback URL and run `openclaw mcp login drover --code <code>`. `openclaw mcp doctor drover
   --probe` should list the tenant tools.

A tenant that cannot do OAuth gets a static token with the same flags:
`drover bots token --as tenant-acme --tenant acme --requester <id> --projects <canonical,checkout,paths> --hosts <exact,names>`
(printed on a terminal only; put it in the tenant's MCP `headers` through a secret, never a literal in config).

`drover bots` and `drover bots grants` show each tenant connection's delegation; `drover bots revoke <grantId>` ends
it at once. A delegation cannot be edited: to change projects or hosts, revoke and approve a new connection. It
survives refresh, daemon restart and MCP reconnect unchanged (it is stored with the grant in `bots/oauth.json`, and
the stored copy is validated again on every use: a missing or malformed one fails closed).

What a tenant connection gets (`core/bots/tenant-tools.js`):

| Scope | Tools |
|---|---|
| `drover.read` | `drover_whoami`, `drover_fleet`, `drover_search`, `drover_inbox`, `drover_features`, `drover_reflections` (list, search, show; `repo` required) |
| `drover.write` | `drover_status`, `drover_reply`, `drover_note`, `drover_feature_upsert` |

- No brain (no `drover_brain_*`), no alerts, no host argument, no ops, launches, shell or raw transcripts.
- Every read asks only for the approved projects and hosts, then checks every record again before release: a session,
  hit, reflection or feature whose checkout identity or host is unknown, unapproved or contradictory is dropped.
  A bare project label cannot establish authority: transcripts need an exact approved `cwd`; features need an
  exact canonical path in `repo`; reflections need an exact approved `checkout` (below) and an approved `host`, with
  a `repo` label that, when present, is that path or its exact basename. Legacy basename-only WAL, memory and reflection rows are unavailable,
  not silently mapped to a checkout. Search applies an exact `repoIdentity` predicate before ranking/limit/dedup
  on every leg and checks each returned record again; an older peer lacking it cannot release ambiguous rows.
  Tenant results keep canonical checkout identities (the legacy bots retain display labels).
- Search is authorized on each chunk's **own** provenance, never its session's: the checkout that turn ran in and
  the host it was written on (a host's own transcripts; a reflection's exported `host`, which must be an approved
  host). A Claude line names its own `cwd`. A Codex item is in the cwd of the `turn_context` that covers it
  (`core/search/extract.js` `codexAttribute`): Codex up to ~0.46 records a turn's prompt *before* its
  `turn_context` (and one `turn_context` per model request), a cwd change first records an `<environment_context>`
  naming the new cwd (it counts as a cwd change; one naming several environments makes the cwd unknown), `codex
  resume` appends to the same rollout with no new `session_meta` (possibly from another checkout), and current
  Codex's error and abort paths record a prompt with no `turn_context` at all. So a prompt no `turn_context` covers
  waits (stored with no cwd, `pending`) for the next one, and only takes its cwd when that equals the cwd in effect
  when the prompt was written; a turn start, end, abort or error first, or a different cwd, settles it to unknown.
  The wait carries across read windows and passes (`sources.cwd_state`). A session that moved checkouts releases
  only the turns in the approved one; a line, reflection or peer copy with no such provenance is withheld, and so
  is a hit when any host's copy of the same text lacks it. Steered input typed while a Codex turn runs has no
  `turn_context` of its own and is withheld. Tenant keyword legs match a chunk's own words, not its session title,
  transcript hits carry no title (it is the whole session's: the first prompt or the ai-title), and tenant search
  has **no vector leg**: a chunk's vector embeds its session title with its words, so ranking by it would let a
  tenant probe a title from another checkout (the owner's search keeps it; nothing is re-embedded). WAL, memory
  and doc chunks carry no checkout, so tenants never see them in search.
- A reflection is released only on its exported **`checkout`**, never its `cwd`: the reflections CLI sets `cwd` to
  the *main* worktree's root (`repo_root`), so an item added in a private `git worktree` of an approved checkout
  would pass for the approved one. Operator contract for the CLI: on `add` (and anything else that creates an item)
  record `checkout`, the `realpath` of `git rev-parse --show-toplevel` run in the process's actual cwd (the
  worktree itself, not its main checkout; the realpath of the cwd outside git), leave the grouped `cwd` as it is,
  and carry `checkout` unchanged through the event fold, its SQLite index (and its migrations), `export`, `list
  --json`, `search --json` and `show --json`. An edit of an item's content keeps `checkout` only when made in that
  same checkout on the same host as its `add`; from any other or an unknown checkout or host it sets `checkout` to
  null for good, so foreign words are never released under the original add's authority. Until the CLI does this,
  and for every item written before it did, tenants get no reflections (search and `drover_reflections` alike); the
  owner sees them as before. The `repo` label must still agree with the checkout (be it or its exact basename,
  case-sensitive): it is kept because an item added with an explicit `--repo` belongs to that repo whatever
  checkout it was typed in, so a CLI key that lowercases a mixed-case basename withholds those items rather than
  guess.
- After upgrading, each host's search index re-reads every transcript once on its next pass (extraction version
  4; vectors are kept, nothing is re-embedded), forgets every reflection's checkout at once and runs a full
  reflections export; until a host's daemon has run that pass, and on any peer still on an older Drover, tenant
  search finds nothing there (fail closed; an older index file opened read-only answers tenants with no
  reflections). Reflections added before the CLI recorded `checkout` stay withheld from tenants for good: the CLI
  never backfills it (where an old item was written is not known), and Drover never derives it from `cwd`, `repo`
  or anything else; re-add an item from its checkout if a tenant needs it. Restart the daemon on each host
  (`drover serve`, or its launchd/systemd unit) and watch `drover op search.status` until
  `indexer.scope.extractVersion` is 4 and `indexer.lastTick` is after the restart with `indexer.busy` false (the
  first pass reads every transcript); `drover op search.reindex` starts a pass at once.
  No `rebuild` is needed. Reflection hosts are the reflections CLI's host key (the machine name it records): approve
  hosts under the names both Drover and the CLI use, or those reflections stay withheld.
  Fleet and search answers carry no global counts, coverage,
  per-host or timing metadata, and no bot sessions or bot threads.
- Residual risks the operator owns. A Claude Code (or Codex) session that starts in a private checkout and moves
  into an approved one releases its later turns, which can quote or summarize what it read earlier in the private
  one (attribution is per turn; nothing tracks what a turn knows). Approve a checkout only for tenants who may see what
  any session that ends up there may carry over, or keep such sessions out of approved checkouts. Paths are
  compared exactly as recorded, never resolved (Drover cannot resolve another host's paths): approve each
  checkout's physical `realpath` on its host, which is what git's top level (the CLI's `checkout`) reports, and keep
  agents started on that spelling. A turn recorded under a symlink alias or a differently cased path is withheld;
  an approved path that is itself a symlink releases whatever it points at, today or after it is repointed, so
  never approve one.
- Ids are checked before they are used: `drover_reflections show` needs an id listed in that approved repo on the
  gateway host; `drover_feature_upsert` and `drover_note` take a feature id only when its whole WAL history has
  approved project and host provenance (one foreign contribution, or a move from another project, taints it).
- The inbox holds only direct messages to `grok:<prefix>-<tenant>`, never `grok:*` broadcasts or another bot's;
  `drover_reply` refuses any other message id before writing.
- Writes are recorded as `grok:<prefix>-<tenant>`, marked untrusted like any bot's, and carry
  `delegation: { tenant, bot, requester, grantId }`.
- The gateway re-verifies the grant after reading the request body and again before sending an answer, so a
  revocation that lands mid-request releases nothing; a tenant's MCP server is rebuilt per request, never cached.

## Which apps reached this daemon

`drover clients` lists apps that made an authenticated request to this daemon in the last day. Use it when a watch, phone, menu bar, or extension looks paired but you need to see whether it is actually arriving. The phone and the watch both come through `tailscale serve`, so a socket does not say which one.

`GET /api/clients` returns `{ ok: true, result: [...] }`, most recent first. The CLI prints one row per client: how long ago it was last seen, the app name, `local` or `tailnet`, the token scope (`main` or `widget`), the request count, and the extension origin or User-Agent.

| Field | Meaning |
|---|---|
| `app` | Native executable from a `Name/version CFNetwork/` User-Agent (`Drover`, `DroverMenuBar`, `DroverWatch`). Otherwise the browser family, with `extension` appended when the origin is `chrome-extension://`, `safari-web-extension://`, or `moz-extension://`. |
| `via` | `tailnet` when the request carries `tailscale-user-login`, else `local`. `tailscale serve` sets that header. A process on the machine can send it too, so this is a claim about the hop, not a proof of who is logged into the tailnet. |
| `scope` | Which token the request presented. A widget-scoped call is recorded even when the route then answers 403: a valid widget token still means the app reached the daemon. |
| `requests` | Authenticated calls from this User-Agent, extension origin, scope, and hop since `firstSeen`. |
| `extension` | The extension origin, or empty. A page's own origin is dropped so one browser tab stays one row. |

The list lives in the daemon's memory (`core/clients.js`). It keeps at most 64 clients and only the last 24 hours, and it stores no tokens, paths, or bodies. Control characters in a User-Agent are replaced and the string is cut at 200 characters. Unauthenticated requests are not recorded. Reading the list requires the main token; no token is 401 and a widget token is 403. It is not an op, so no MCP tool and no ssh rpc can list it. Restarting the daemon clears it. If `~/.local/state/drover/daemon.json` is missing, the CLI says Drover is not running.

## Native clients

- `native.summary` returns `{ generatedAt, hosts[{name, up, waiting, working, idle}], waiting[{id, name, host, engine, since, kind, headline}], working[...], totals, manager{up, lastNoteAt} }`.
  Headlines are 140 characters, with secrets redacted and no paths. Cached 5 s. A waiting item with a dialog or held
  message on screen also carries `answer: "keys"`, `dialog {question, options}`, `hash` and `keys` (the keys that dialog
  takes; y and n only where the prompt takes them); one that asked in text carries `answer: "reply"`.
- `sessions.answer({ id, key, expect })` presses one key on the dialog a session shows, by session id or window target,
  with tmux.answer's guards (no dialog, a changed screen, a key the dialog does not take: refused, nothing typed). Pass
  the `hash` as `expect`. On a host that predates the op the front looks the window up there and uses tmux.answer.
- `native.board` (main token): every live agent as a strip with its window, short cwd, headline, tail and answer
  fields, plus per-host counts. A few KB per host; `fleet.summary` carries every session record.
- `GET /api/stream?topics=board,alerts,turn,manager` sends only those events (no `topics`: all of them). `board` and
  `summary` events carry `native.board` and `native.summary`, computed only while a client subscribes and sent only when
  they changed, within about a second of an answer or a message.
- `native.notifications({ since, limit, wait })` returns `{ cursor, items[{id, at, kind, category, title, body, sessionId, host}] }`, oldest first,
  muted alerts left out. Pass the opaque `cursor` back as `since` (an ISO time still works); `wait` (max 25 s) long-polls for the next alert.
- Widget token: `~/.local/state/drover/widget-token` (0600), created with the main token. It is accepted only in the
  `Authorization: Bearer` header and only for the two ops above; everything else answers 403. `drover widget-token [--rotate]`
  prints it on a terminal (otherwise just the path); restart the daemon after a rotate.
- `DROVER_BIND` (or `drover serve --bind`) can be a tailnet or LAN address. A non-loopback bind is refused until the main token
  file exists, so run `drover serve` on 127.0.0.1 once first.
- `DROVER_ALLOW_ORIGINS` is a comma list of exact origins (for example `chrome-extension://<id>`) allowed to call `/api/`
  cross-origin. Wildcards are ignored. The token is still required.
- `/api/events` is an alias of `/api/stream` (SSE).

## Trying clients against pretend sessions

`node test/devworld.js [--port 7338] [--gateway 18799]` starts a daemon from this checkout that sees only a private
tmux server of pretend Claude sessions (`test/fake-agent.js`: a permission dialog, a question, a busy session that
keeps calling tools, an idle one that answers inbox messages), synthetic transcripts, an empty truth file, no fleet
hosts and a fake manager gateway that streams (`test/fake-gateway.js`; a message starting "slow " streams for about
8 s, "fail " fails, "echo " echoes). Tokens are copied from the real state dir, so a paired client works against it.
A dialog comes back about 12 s after it is answered. Nothing in it can reach a real session, pane or host.

## Pairing devices

A client with no token pairs instead of asking you to paste one:

1. It calls `POST /api/pair/request` (no token; body `{"client", "device"}`, 64 characters each) and shows the
   6-digit code it gets back.
2. You approve that code on the Mac: the banner in the browser UI (Approve / Deny), or `drover pair` to list
   requests and `drover pair approve <code>` (or `deny`). The macOS banner also names the command
   (`DROVER_PAIR_NOTIFY=off` silences it).
3. The client polls `GET /api/pair/status?requestId=` and receives the main and widget tokens once; after that,
   or after two minutes without an answer, the request is gone (404).

Approve only when the device shows the same code. Requests live in the daemon's memory, at most five pending and
twenty a minute. Listing, approving and denying (`/api/pair/pending|approve|deny`) need the main token and are not
ops, so no MCP tool and no ssh rpc can approve a pairing.

## Layout

```
bin/drover      CLI: serve (alias up) | open | status | clients | widget-token | pair | bots | rpc | mcp | op | ops | search | stacks | embed | import-survey | import-legacy
bin/drover-embed-setup  builds llama-server (pinned) and installs EmbeddingGemma 2 for search
core/           api.js (op table) and adapters: tmux, claude, codex, hosts, events, memory (incl. the reflections CLI), launch, effort, trust (launch trust), remote, terminals, filewait (files.wait), session-filter (sessions.list filters); plugins (the plugin loader), owner (DROVER_OWNER), env (settings and secrets files)
core/search/    the search index: extract, chunk, store (node:sqlite), indexer, embed (llama-server), query
core/bots/      Grok bots: oauth (the gateway's OAuth server), tools (the bot tools), tenant-tools and access (native tenants), policy (what leaves for bots: cleaned, secrets redacted), grok (bots as sessions, Routines)
core/docker.js  docker stacks and the docker.* verbs (core/docker-format.js: drover stacks text; ui/stacks-text.js: summaries both use)
server/http.js  HTTP + SSE front, bearer token, static ui/
server/botgate.js  the bot gateway: OAuth endpoints, authorize page, MCP over Streamable HTTP for Grok bots
ui/             single-page app, vanilla ES modules
mcp/server.js   MCP over stdio, maps tools onto core/api.js
profiles.json   default launch profiles (claude: default, plan, yolo; codex: default, read-only, workspace, yolo), model aliases, tmux sessions; DROVER_PROFILES points at a fleet's own copy
test/           node --test test/*.test.js
```

The truth file is `claude/drover-events.jsonl` (append-only, `merge=union`).
