# Drover: guide for coding agents

A control plane for every coding agent (Claude Code, Codex, Hermes Agent, Grok bots, the OpenClaw fleet
manager) across every machine someone runs them on: a per-machine daemon, a browser UI, a terminal UI, an MCP
server, and native Apple clients, all built on zero npm dependencies. Humans start at [README.md](README.md);
this file is what an agent needs on top of it. `CLAUDE.md` only imports this file — edit this one.

## Read before changing behaviour

- [web/README.md](web/README.md): the daemon, every op, plugins, settings files, the truth file, Grok bots.
- [native/CONTRACT.md](native/CONTRACT.md): the HTTP+SSE API every native client and extension relies on.
- [docs/wal-retention.md](docs/wal-retention.md): how the truth file is trimmed.

## Hard rules

- **Public repo (Apache-2.0).** Never commit secrets, real hostnames, tokens, or private fleet details.
  README and docs already generalize examples (`box-a`, `devbox`) — keep new examples that way too.
- **Never log, print, hardcode or commit a bearer token.** Tokens live in the Keychain (Apple apps),
  `chrome.storage.local` (never `sync`, Chrome extension), or `$DROVER_TOKEN_FILE` (daemon). Widgets get only
  the read-only widget token.
- **Zero npm dependencies in `web/`.** Don't add one without discussing it — it's a stated design constraint,
  not an oversight.
- **The truth file (`claude/drover-events.jsonl`) is append-only.** Never rewrite or reorder it; new event
  types need a validator (see `core/plugins.js` event-type shape) not a schema migration.
- **Core stays generic.** Anything only one fleet needs (a private forge, a personal memory service, non-ssh
  hosts) is a plugin (`core/plugins.js`), loaded from outside this repo. Don't bake fleet-specific logic into
  `core/` or `web/README.md`.
- Never skip, weaken or delete a test to get green; change one only when the intended behavior changed.
- No formatter (no Prettier). Match the surrounding style.
- Self-hosted runners (label `drover`, `drover-mac`) are private-repo-only and never run a fork's pull
  request — don't change `build.yml`'s runner selection without preserving that boundary.

## Where things are, and what a change can break

| Path | Holds | Its changes can break |
|---|---|---|
| `web/core/api.js`, `core/ops-meta.js` | the op table every client calls, and its MCP/schema metadata | web UI, TUI, MCP server, every native client (`native/CONTRACT.md`) |
| `web/core/` adapters (`tmux`, `claude`, `codex`, `hosts`, `events`, `memory`, `launch`, `effort`, `trust`, `remote`, `terminals`, `filewait`, `session-filter`, `lineage`, `owner`, `env`) | per-engine and per-feature logic | the op(s) each adapter backs |
| `web/core/search/` | the sqlite + llama-server embedding search index | `drover search`/`drover grep`, the Search view |
| `web/core/bots/` | the Grok bot gateway: OAuth, tools, tenant access, policy (what leaves for a bot, redacted) | `web/server/botgate.js`, bot-facing data exposure |
| `web/core/docker.js`, `docker-format.js` | docker stacks discovery/formatting | `drover stacks`, the Stacks view |
| `web/server/http.js` | HTTP + SSE front, bearer-token auth | every client's connection |
| `web/ui/` | the browser single-page app (vanilla ES modules) | the web UI only |
| `web/tui/` | the terminal UI | `drover tui` only |
| `web/mcp/server.js` | maps MCP tools onto `core/api.js` | Claude Code / Codex `drover_*` tools |
| `web/openclaw-manager/` | the fleet-manager agent's config, roles, profiles | `drover manager setup`, the manager popup |
| `native/` | macOS/iOS/watchOS apps, menu bar, widgets, Chrome/Safari extensions — all speak `native/CONTRACT.md`'s API | native clients only; server-side contract changes break all of them at once |
| `skills/`, `integrations/` | agent-facing skills (`drover`, `drover-manager`) and the Grok-bot skill | how agents are told to use Drover |

## Checks: run what your diff can break, and let CI run the rest

```sh
cd web && node --test test/*.test.js                      # full web/daemon suite
cd web && node --test test/docker.test.js                  # one file
cd native/Extensions/chrome && node --test test/*.test.js   # Chrome extension
cd native/Extensions/safari && node --test test/*.test.mjs  # Safari extension
cd native/Packages/DroverKit && swift test --skip ClientTests --skip GlueTests   # portable native logic (needs Swift 6.4)
native/script/typecheck.sh <macos|ios|watchos> <paths>      # native typecheck without an Xcode license
```

- **The full gate is `.github/workflows/build.yml`**, on every push and pull request: the web/daemon suite,
  both extension suites, `swift-linux` (DroverKit), and `apple` (unsigned Xcode builds, hosted on a public
  repo, gated behind `DROVER_MAC_RUNNER` on a private one). Trigger it on a branch with
  `gh workflow run build.yml --ref <branch>`, watch with `gh run watch <id> --exit-status`.
- `signed.yml` (manual only, needs signing secrets) and `screenshots.yml` (manual or on `screenshots/**`
  pushes) are separate — don't run them without being asked.

## Running it

```sh
drover serve      # foreground daemon, http://127.0.0.1:7337
drover open        # prints the URL with its token
drover status       # daemon up? which commit? needs a restart?
drover tui          # terminal UI: manager, board, sessions, every web view
drover mcp          # MCP server on stdio
```

For a UI change, `web/test/devworld.js --showcase` serves synthetic sessions/hosts so you don't need a real
fleet (see [docs/screenshots/README.md](docs/screenshots/README.md) for how the project's own screenshots
are made from it).

## Known traps

- The Claude Code message-injection path (`~/.claude/sessions/<pid>.json`, `/tmp/cc-socks/<pid>.sock`) is
  version-pinned behavior verified on Claude Code 2.1.296 (`web/README.md`, "How it talks to agents") — a
  Claude Code update can silently change the socket protocol.
- The repo was renamed from apx-web (CLI `apxw`) on 2026-10-15; the compatibility shim (`apxw` symlink,
  `APXW_*` env fallbacks, importing `claude/apx-events.jsonl`) is scheduled to be removed 2026-11-15. Check
  whether that date has passed before assuming the shim still needs maintaining in `core/envvars.js` /
  `core/paths.js` / `core/events.js`.
- The gitleaks RSA-public-key allowlist in `.gitleaks.toml` is scoped by line content (`regexTarget =
  "line"`), not by path, on purpose: gitleaks 8.30 exempts an entire file once any path allowlist matches it,
  even under `condition = "AND"`. Don't "simplify" it back to a path rule.
