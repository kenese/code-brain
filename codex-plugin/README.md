# dev-context (Codex CLI plugin)

Installs the `dev-context` MCP server + lifecycle hooks for Codex CLI in one step.

## Structure

- `.codex-plugin/plugin.json` — manifest
- `.mcp.json` — the remote `dev-context` MCP server (HTTP)
- `hooks/hooks.json` — auto-detected lifecycle hooks (paths use `$PLUGIN_ROOT`)
- `scripts/` — bundled hook scripts

## Install

```
codex plugin add dev-context@personal
```

The personal marketplace must point `dev-context` at this plugin directory. For
this machine that marketplace entry is `dev-context@personal`.

## Required environment

```
DEV_CONTEXT_MCP_KEY=<the access key>   # same as open-brain's MCP_ACCESS_KEY
```

The `.mcp.json` passes it as the `x-access-key` header via `env_http_headers`.
The key value is not stored in the plugin; Codex resolves `DEV_CONTEXT_MCP_KEY`
from your environment when it starts the MCP server.

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

## Verify

Validate the packaged Codex metadata before publishing or reinstalling:

```
npm run validate:codex-plugin
```

Then reinstall and confirm Codex registers the bundled MCP server:

```
codex plugin add dev-context@personal
codex mcp list
```

Current Codex plugin MCP files use an `.mcp.json` wrapper named `mcpServers`.
The plugin manifest declares `"mcpServers": "./.mcp.json"` so Codex ingests that
file during plugin install. If you need to override the server manually, keep the
equivalent user config as `[mcp_servers.dev-context]` with `url` and
`env_http_headers = { "x-access-key" = "DEV_CONTEXT_MCP_KEY" }`.
