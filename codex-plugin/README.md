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

## Agent orchestration: kinds, sessions, and the dashboard

dev-context tracks more than one style of work per repo, and can track the agents
doing that work as a tree — without dev-context itself touching cmux/tmux (it's a
remote Supabase function; the *orchestrator agent* does the actual spawning via its
own terminal-multiplexer tools, and just reports state back).

- **Plan `kind`** — every plan has a freeform `kind` (`sprint` by default; `spike`
  and `maintenance` are the other built-ins). `connect` returns a kind-specific
  working contract: `sprint` holds to full engineering rigor and tests before
  `complete_phase`; `spike` says move fast, skip heavy test coverage, prove the
  point; `maintenance` says stay long-running and spawn a child plan
  (`parent_plan_id`) per concrete fix rather than fixing inline. `create_plan`
  takes `kind`, `ticket_ref` (e.g. a Jira key), and `parent_plan_id`.
- **Agent sessions** — `register_session` upserts a running agent keyed on
  whatever stable ref it reports (e.g. a cmux `workspace:`/`surface:` ref from an
  `identify`-style tool, or a tmux pane) plus `host`/`source` to disambiguate
  across machines. An orchestrator registers itself with `role="orchestrator"`,
  spawns children, and each child registers with `parent_session_ref` set to the
  orchestrator's ref — building a tree. Sessions call `heartbeat_session` as they
  work (`status`, `activity`) and `end_session` when done.
- **`list_sessions`** renders that tree, flagging sessions whose heartbeat has
  gone stale while still `running`.
- **`overview`** is the dashboard: across one repo or all of them, it lists plans
  (nested under their parent, with kind/status/ticket/progress %) and appends an
  Attention section — plans that are `blocked`/`paused` or stale, and sessions
  that are `waiting_input`, `failed`, or stuck — plus a compact session tree.

`connect` auto-registers a session when you pass it `session_ref` (see the
SessionStart hook message for the exact args).

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
