# dev-context (Codex CLI plugin)

Installs the `dev-context` MCP server + lifecycle hooks for Codex CLI in one step.

## Structure

- `.codex-plugin/plugin.json` — manifest
- `.mcp.json` — the remote `dev-context` MCP server (HTTP)
- `hooks/hooks.json` — auto-detected lifecycle hooks (paths use `$PLUGIN_ROOT`)
- `scripts/` — bundled hook scripts

## Install

```
codex plugin install /Users/keneselautusi/Documents/Code/PROJECTS/open-brain/codex-plugin
```

(Or from the GitHub repo once pushed.)

## Required environment

```
DEV_CONTEXT_MCP_KEY=<the access key>   # same as open-brain's MCP_ACCESS_KEY
```

The `.mcp.json` passes it as the `x-access-key` header via `env_http_headers`.

## Backend URL (different mechanism on Codex)

Codex treats `url` as a static string — it does **not** interpolate env vars there,
so the URL can't be set via `DEV_CONTEXT_MCP_URL` like the other harnesses. The
bundled `.mcp.json` ships the default URL. To point at your own backend, either edit
`url` in `.mcp.json`, or override it in `~/.codex/config.toml` (project config wins):

```toml
[mcp_servers.dev-context]
url = "https://<your-project-ref>.supabase.co/functions/v1/dev-context-mcp"
env_http_headers = { "x-access-key" = "DEV_CONTEXT_MCP_KEY" }
```

## Event mapping

| Role | Codex event |
|---|---|
| auto-connect | `SessionStart` |
| watchdog | `PostToolUse` (matcher `.*`; the script self-throttles) |
| checkpoint | `Stop` |

## No background safety net on Codex

Codex has **no `SessionEnd` event** — its `Stop` fires every turn, so wiring the
`--background` checkpoint there would run an OpenRouter transcript summary on every
turn. So the background safety net (transcript→position_note on abrupt exit) is
Claude Code / Gemini only. Codex still gets auto-connect, the watchdog, and the
model-driven per-turn checkpoint nudge.

## Verify against your Codex version

Confirm the bundled `.mcp.json` shape matches your Codex build — some versions read
`mcp_servers` inside `.mcp.json`, others a direct server map. If the server doesn't
load, move the block into `~/.codex/config.toml` as `[mcp_servers.dev-context]`
with `url` and `env_http_headers = { "x-access-key" = "DEV_CONTEXT_MCP_KEY" }`.
