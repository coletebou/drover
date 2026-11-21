# Cohesion overhaul (2026-11-21)

Drover grew one tab per feature: the TUI has 13 top-level views plus plugin tables, the browser 17, and the
native clients each picked a subset under their own names. The same running agent shows up in Board, Sessions,
Tmux and Terminals; the truth file shows up in Events, Features and Memory; machines show up in Fleet and Stacks.
This spec regroups everything into **seven workspaces** that every client shares, adds a **Prompts** workspace
(every prompt you typed, verbatim, fleet-wide, kept in git), makes the TUI follow the mouse, and adds two
graphical views of the fleet: a **Wall** of live terminals and a 3D **Space**.

## The method: one model, seven questions

Every screen in every client answers one of seven questions. A feature that does not answer one of them is a
sub-view of the one it serves, never a new top-level tab.

| # | Workspace | The question | Sub-views (TUI keys `<` `>` or a click on the sub-tab row) | Replaces |
|---|---|---|---|---|
| 1 | **Manager** | "What should I do next?" | (threads) | Manager |
| 2 | **Agents** | "What is every agent doing, and who waits on me?" | Lanes · List · Windows · Wall · Space | Board, Sessions, Tmux, Terminals (web), Survey (web) |
| 3 | **Prompts** | "What did I ask, where, and when?" | Mine · All (peer and queued turns too) | new |
| 4 | **Work** | "What is shipping?" | Pulls · Features (+ plugin MRs) | PRs, Features, a plugin's MRs |
| 5 | **Fleet** | "Which machines are up and what runs on them?" | Hosts · Stacks · Launch | Fleet, Stacks, Launch |
| 6 | **Find** | "Where did that happen?" | Search · Memory · Events | Search, Memory, Events, Files (web) |
| 7 | **Settings** | "How does Drover behave?" | (sections) | Settings |

Rules that keep it cohesive:

- **One agent, one row model.** Lanes, List, Windows, Wall and Space are five renderings of the same board
  strips (`native.board`); selection is held by the strip key and survives switching sub-view, so `j`/`k` in
  Lanes then `>` to Wall keeps the same agent selected. Enter always opens the same session view.
- **Same verbs everywhere.** Enter opens, `r` replies, `/` filters, `R` refreshes, `[` `]` change host, `y`
  copies, `n` starts something new (a launch). Answer keys act only on an explicitly selected waiting strip.
- **Old names still work.** `--view tmux`, `#/tmux`, palette "Go to Tmux" land on Agents › Windows. The alias
  table (below) is the compatibility contract for scripts and bookmarks.
- **Plugins attach to a workspace.** A plugin table or view names `workspace` (and optionally `after`, a sub-view
  id). An older plugin that names only `after: '<old view id>'` is placed in that view's workspace.
- **Hover is information, click is action.** Under the mouse a row, strip, tile, tab or key hint gets a light
  highlight and (where useful) a one-line preview in the footer; a click selects, a second click opens. Hover
  never selects, so it can never arm an answer key.

### Aliases (old id -> workspace/sub-view)

| Old | New |
|---|---|
| board | agents/lanes |
| sessions | agents/list |
| tmux, windows | agents/windows |
| terminals | agents/windows (web: the terminal opens in the drawer) |
| survey | agents/list (web: the survey panel) |
| wall | agents/wall |
| space, 3d | agents/space |
| prompts, spool, requests | prompts/mine |
| prs, pr, pulls | work/pulls |
| features | work/features |
| mrs, mr | work/mrs (plugin) |
| fleet, hosts | fleet/hosts |
| stacks, docker | fleet/stacks |
| launch, profiles | fleet/launch |
| search | find/search |
| memory, reflections | find/memory |
| events | find/events |
| files | find/files (web) |

## Prompts: the spool

Every prompt typed into Claude Code, Codex or Hermes on any machine, verbatim (secrets redacted), newest
first, searchable, kept forever in git.

### Collection (`web/core/prompts.js`)

- The daemon scans transcripts incrementally (byte offsets per file in `$STATE/prompts-offsets.json`, like the
  search indexer): Claude `~/.claude/projects/**/*.jsonl` (not `subagents/`), Codex `~/.codex/sessions/**`.
  It reuses `search/extract.js` (`claudeLine`, `codexLine`, `userText`, `tidy`) so "a user turn's own words"
  has one definition. First run backfills all history; later passes every 60 s and on `drover prompts sync`.
- Skipped: temp working directories and generated prompts (`indexer.js` `skipReason`), subagent transcripts,
  Claude Code bookkeeping (`<command-name>` etc., already dropped by `userText`).
- `via` says where a turn came from: `typed` (a person at the agent), `queued` (typed while a turn ran),
  `peer` (a `<cross-session-message>` from another agent), `drover` (sent through `sessions.message` /
  `tmux.send`; matched against `message` events in the truth file by text and time), `headless` (a launch
  prompt). The Prompts workspace shows `typed`, `queued`, `drover` and `headless` by default ("Mine").
- `label` classifies each prompt for routing (`work`, `personal`, or any string): the first matching rule in the
  prompts config (by cwd glob, then by the cwd's git remote pattern), else the host's `DF_IDENTITY`, else
  `default`.

### Record (one JSON line, append-only)

```json
{"v":1,"id":"p_3f9a1c0d2b7e4a61","ts":"2026-11-21T22:03:11.000Z","host":"box-a","engine":"claude",
 "session":"5c1e...","cwd":"~/code/app","project":"app","label":"work","via":"typed","text":"verbatim prompt"}
```

`id` is `p_` + the first 16 hex of sha1(host, engine, session, the transcript line's uuid or ts, text): the
same turn collected twice (a re-scan, two hosts sharing a synced transcript dir) is one record.

### Storage: local spool + git sinks

- Local spool, always: `$STATE/prompts/<YYYY-MM-DD>.jsonl` (mode 0600). Append-only, never rewritten.
- Sinks (per machine, `~/.config/drover/prompts.json`; absent = local spool only):

```json
{
  "rules": [{ "cwd": "~/code/work-*", "label": "work" }, { "remote": "github.com[:/]me/", "label": "personal" }],
  "sinks": [
    { "name": "personal", "labels": ["personal", "default"], "type": "git",
      "remote": "git@github.com:me/dotfiles.git", "branch": "drover-prompts", "dir": "prompts" },
    { "name": "work", "labels": ["work"], "type": "git",
      "remote": "https://forge.example/dotfiles-work/git", "branch": "drover-prompts", "dir": "prompts" },
    { "name": "sealed", "labels": ["*"], "type": "command", "argv": ["cpt-sync", "push", "--append", "prompts", "{file}"] }
  ],
  "syncEveryMinutes": 30
}
```

- A `git` sink keeps its own clone under `$STATE/prompt-sinks/<name>` on a dedicated branch (never a working
  checkout someone edits), writes `<dir>/<host>/<YYYY-MM-DD>.jsonl` (one file per host per day: two hosts never
  write the same file, so pulls never conflict), commits only those paths, `pull --rebase` then push, with
  backoff on failure. Secrets were redacted at collection; nothing else is filtered.
- A `command` sink runs its argv (no shell) with `{file}` replaced by each day file that changed (cpt-sync's
  encrypted append is the intended use).
- The sink clone is also a read source: hosts that are down still show their prompts from the last pull.

### Ops

| Op | m | Args | Returns |
|---|---|---|---|
| `prompts.list` | no | `q?` (words, all must match), `host?`, `hosts?`, `engine?`, `label?`, `via?` (array; default the "mine" set), `since?`, `until?`, `session?`, `cwd?`, `limit?` (default 200, max 2000), `before?` (an id, for paging) | `{ prompts: [record + {route}], perHost: [{host, ok, count, error?}], coverage, total? }` newest first. Front op: fans out like `search.grepFleet`, merges by id, adds sink-clone records for hosts that did not answer. |
| `prompts.local` | no | same filters | this host's records only (what the fan-out asks each host) |
| `prompts.status` | no | | `{ files, records, oldest, newest, lastScan, scanning, sinks: [{name, type, lastSync, lastError, pending}] }` |
| `prompts.sync` | yes | `sinks?` | scans now, then pushes every sink; `{ scanned, added, sinks: [...] }` |

CLI: `drover prompts [words] [--host H] [--all] [--json]`, `drover prompts status`, `drover prompts sync`.
MCP: `drover_prompts_list`, `drover_prompts_status`, `drover_prompts_sync` (generated from ops-meta).

## Live captures for the Wall

| Op | m | Args | Returns |
|---|---|---|---|
| `tmux.captureMany` | no | `targets` (array of tmux targets, max 64), `lines?` (default 60), `escapes?` (default true: keep SGR colors) | `{ captures: [{ target, ok, text?, error?, hash?, screen? }] }`, one tmux call per target run in parallel on that host. Forwarded by `host` like every per-host op. |

Clients group tiles by host and ask each host once per refresh. Text with escapes is parsed into styled segments
by a pure parser (`web/ui/ansi.js`); nothing from a pane reaches a terminal or the DOM unparsed.

## Wall (Agents › Wall)

A grid of live mini terminals, one per agent on the board, sorted by lane (waiting first) and then name. Each
tile: a header (lane dot, name, host, age), the bottom of its pane in color, a border in the lane's color
(waiting pulses). Density `+`/`-` (1x1 up to 6x5 tiles); arrows/hjkl move; click selects, second click or `z`
zooms the tile to the whole view (refreshed every second), Enter opens the session, Esc unzooms. Only visible
tiles are captured; refresh every 2 s (1 s zoomed), paused when the view is not in front.

## Space (Agents › Space)

The fleet in 3D. The manager is a glowing core at the origin; each host is a disc on a ring around it (size by
agent count, a host that did not answer is dark); each agent is a monolith standing on its host's disc: color by
lane (amber waiting, blue working, green idle, red error), height by recent activity, waiting ones pulse and
throw a beam up. Thin links run from the core to each host. Labels float over hosts and the selected agent.

Controls: drag (or arrows) orbits, wheel (or `+`/`-`) zooms, `w a s d` pan, `f` focuses the selected agent and
flies to it, Tab cycles agents (waiting first), hover shows the agent's name, lane and its last line in the HUD,
click selects, a second click or Enter opens the session, `0` resets the camera, `p` pauses the idle drift.

Rendering:

- `web/ui/space-scene.js` (pure, shared): layout from board strips, camera, math (vec3/mat4), meshes, the
  projected face list (painter-sorted) and picking. No DOM, no terminal.
- TUI: `web/tui/views/space.js` rasterizes the faces into a half-block pixel buffer (each cell `▀`, fg the upper
  pixel and bg the lower: two pixels per cell) with a z-buffer and an object-id buffer for picking; runs of equal
  cells merge into one segment so a frame stays small; 20 fps while moving, 4 fps for the pulse, 0 when still.
  Below truecolor it falls back to 256 colors; with no color it draws an ASCII-shaded version.
- Web: `web/ui/views/space.js` fills the same faces on a canvas 2D context (antialiased, devicePixelRatio-aware),
  and hit-tests with the same picking function.

## Per-client plan

| Client | Change |
|---|---|
| Daemon | `core/prompts.js` (collector, spool, sinks), ops above in `core/api.js` + `ops-meta.js`, `tmux.captureMany`, background scan in the daemon, CLI `drover prompts`, README section |
| TUI | workspaces + sub-tab row + aliases, hover highlight everywhere (motion mode 1003 when the mouse is on), Prompts, Wall, Space; the help and palette regrouped |
| Web | the same workspaces in the top bar with a sub-tab row, hash aliases, Prompts view, Wall view, Space view, hover previews |
| macOS / iOS | sidebar/tab names follow the workspaces; a Prompts screen (list + search + copy + open session) |
| Chrome / Safari extensions | a Prompts section in the side panel (recent prompts, search, copy) and workspace names in links to the web UI |
| MCP / skills | tools generated from ops-meta; the drover skill learns prompts.* |
