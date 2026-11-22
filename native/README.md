# Drover native

Native Apple clients and browser extensions for Drover (a control plane for Claude Code, Codex,
Grok bots and the OpenClaw fleet manager). Contract and rules: `CONTRACT.md`. Per-window build briefs: `briefs/`. Typecheck without Xcode's
license: `script/typecheck.sh <macos|ios|watchos> <paths>`.

Contains no company data: synthetic fixtures only.

## Workspaces (docs/specs/2026-11-21-cohesion-overhaul.md)

Every client groups its screens by the same seven workspaces as the web UI and the TUI (Manager, Agents, Prompts,
Work, Fleet, Find, Settings), and shows only the ones it has screens for:

| Client | Manager | Agents | Prompts | Fleet | Settings |
|---|---|---|---|---|---|
| macOS (`Apps/macOS`) | sidebar, first | sidebar: All agents (List), Waiting on you / Working / Idle (Lanes) | sidebar: Prompts (list + whole prompt) | sidebar: each host | the Settings window |
| iOS (`Apps/iOS`) | Manager tab | Agents tab, Lanes or List at its top | Prompts tab | hosts on Lanes | Settings tab |
| Chrome and Safari (`Extensions/`) | popup, side panel | popup, side panel Chat | side panel Prompts (popup: a Prompts link) | | options page |

Prompts are `prompts.list` (newest first, every machine, the daemon's default "Mine" set unless a client asks for
`via: "all"`), `prompts.status` and `prompts.sync`, in DroverKit's models (`Packages/DroverKit/API.md`). Links into the
web UI use its workspace routes (`#/agents/lanes`, `#/prompts/mine`, `#/manager`; `web/ui/routes.js`).

