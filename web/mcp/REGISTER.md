# Registering the Drover MCP server

`drover mcp` speaks MCP over stdio (JSON-RPC 2.0, protocol 2025-06-18, zero npm
deps). Register it once per box; `install.sh` does this for you and templates
the home directory into the paths below (JSON and TOML have no `$HOME`
expansion, so the path must be literal).

## Claude Code

Add under `mcpServers` in the Claude Code MCP json (`base/claude/mcp.base.json`
in dotfiles, or `.mcp.json` / `claude mcp add-json drover '<block>'`):

```json
"drover": {
  "command": "node",
  "args": ["/Users/<you>/code/drover/web/bin/drover", "mcp"]
}
```

One-liner alternative: `claude mcp add --scope user drover -- node /Users/<you>/code/drover/web/bin/drover mcp`

## Codex

In `$HOME/.codex/config.toml` (`codex/apply-config-defaults.sh` adds this):

```toml
[mcp_servers.drover]
command = "node"
args = ["/Users/<you>/code/drover/web/bin/drover", "mcp"]
```

## Notes

- `node` must resolve on the PATH the client starts with (Node 24). Use the
  absolute node path in `command` if it does not.
- Smoke test: `printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node bin/drover mcp`
  prints one JSON line listing the tools (the curated ones, one `drover_<op>` per op, and
  `drover_op`) and exits 0 when stdin closes.
- A plugin's tools (`DROVER_PLUGINS`, or `~/.config/drover/plugins/`) are listed with the core ones; a token a plugin
  needs is read from the environment or `~/.env_secrets` on the host that runs it.
- Logs go to stderr only; stdout is reserved for JSON-RPC.
