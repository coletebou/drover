<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/brand/lockup-dark.svg">
  <img alt="Drover" src="docs/brand/lockup-light.svg" height="96">
</picture>

# Drover

A control plane for a fleet of Claude Code and Codex agents across your machines: see every tmux window, agent session
and Codex thread on every host, talk to any of them, launch new ones, answer their dialogs from a phone or a watch,
and keep one append-only truth file of features, notes, messages and launches. One daemon per machine, zero npm
dependencies, Node 24; machines reach each other over ssh, with no open ports.

| path | what |
|---|---|
| `web/` | Drover: the per-machine daemon (`drover`), its op table, the browser UI, the terminal UI, the `drover_*` MCP server, the bot gateway, the OpenClaw fleet manager. Tests: `cd web && node --test test/*.test.js` |
| `native/` | Native clients over the daemon's HTTP API (`native/CONTRACT.md`): macOS app, menu bar app, iOS, watchOS, widgets, Chrome and Safari extensions |
| `skills/` | Agent skills: `drover` (the tools and how to use them) and `drover-manager` (the manager popup) |
| `integrations/` | The skill a Grok bot uses through the bot gateway |

## Install

On each machine (macOS or Linux, Node 24 on PATH, tmux):

```
git clone https://github.com/coletebou/drover ~/code/drover
ln -s ~/code/drover/web/bin/drover ~/.local/bin/drover
drover serve                       # foreground; then keep it running under launchd (Mac) or a systemd user unit (Linux)
drover open                        # the browser UI, with its token
claude mcp add --scope user drover -- node ~/code/drover/web/bin/drover mcp   # the drover_* tools (web/mcp/REGISTER.md)
```

Other machines are ssh-config aliases with Drover at `~/.local/bin/drover`: the ones listed in
`$DROVER_DOTFILES/claude/fleet-hosts.txt` (one name a line) are the fleet the UI shows, and any other alias in
`~/.ssh/config` is a target you can name (`drover op host.list`). `DROVER_DOTFILES` (default `~/.dotfiles`) is a git
repository you sync between machines: it also holds the truth file, `claude/drover-events.jsonl` (append-only, mark it
`merge=union` in `.gitattributes`). Everything else, from the HTTPS front for phones to the bot gateway, is in
`web/README.md`.

## Plugins and settings

Integrations only one fleet needs (a private forge, a deploy pipeline, a memory service, hosts reached some other way
than ssh) are plugins: directories with a `plugin.js` that add ops, MCP tools, UI views and TUI tables, loaded from
`DROVER_PLUGINS` or `~/.config/drover/plugins/`. A fleet's non-secret settings (the owner's name, a default repo,
launch profiles, docker labels) are `KEY=value` lines in `~/.config/drover/*.env`. Both usually live in that fleet's
own private repository, linked in. See `web/README.md`, "Plugins" and "Settings files".

Drover was named apx / apx-web (CLI `apxw`) until 2026-10-15. The `apxw` shim, the `APXW_*` variable fallbacks and the
import from `claude/apx-events.jsonl` stay until 2026-11-15; see `web/README.md` for what moved where.

## CI

`.github/workflows/build.yml`, on every push and pull request: the web and extension tests (Node 24, with tmux for the
real-tmux tests) and the portable DroverKit tests (Swift 6.4), plus unsigned Xcode builds of every scheme. On a public
repository the Linux jobs run on hosted Ubuntu (DroverKit in the `swift:6.4.1-noble` container); on a private one, on
the self-hosted ARM Linux runners labelled `drover` (Swift in `/opt/swift`, tmux installed), because hosted minutes are
billed there. `signed.yml` (manual): Developer ID + notarized Mac apps as an
artifact, and TestFlight uploads, in the environment `signing`; needs variable `DROVER_TEAM_ID`, secrets `ASC_KEY_ID`,
`ASC_ISSUER_ID`, `ASC_KEY_P8` and the `.p12` certificates listed in the workflow (environment values override
repository ones).

Hosted macOS is free on a public repository and billed at 10x on a private one. On a public repository both macOS jobs
run on `macos-15` (give `signing` a required reviewer and limit it to master). On a private one they run only on a
self-hosted Mac with the label `drover-mac` once the repository variable `DROVER_MAC_RUNNER` is `on`
(`gh variable set DROVER_MAC_RUNNER --body on`), unsigned builds on `master` and manual runs only;
until then they are skipped, not queued. A self-hosted runner is never used on a public repository, so a pull request
from a fork never runs on one of our machines. Actions are pinned by commit SHA and kept current by Dependabot.
