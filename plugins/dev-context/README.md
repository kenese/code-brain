# dev-context (Claude Code plugin)

Installs the `dev-context` MCP server **and** its lifecycle hooks in one step, so
per-repo context auto-connects at session start and progress auto-checkpoints —
in any repo, on any machine that installs the plugin (including cloud).

## What it bundles

- **MCP server** (`.mcp.json`) — the remote `dev-context` Supabase function.
- **Hooks** (`hooks/hooks.json`) — SessionStart→connect, PostToolUse→watchdog,
  Stop→checkpoint, SessionEnd→background checkpoint. Paths use `$CLAUDE_PLUGIN_ROOT`
  so the bundled `scripts/` resolve wherever the plugin is installed.

## Install

```
/plugin marketplace add /Users/keneselautusi/Documents/Code/PROJECTS/open-brain
/plugin install dev-context@open-brain-marketplace
```

(Or point `marketplace add` at the GitHub repo once pushed.)

## Required environment

The MCP server needs the access key (same value as open-brain's `MCP_ACCESS_KEY`):

```
DEV_CONTEXT_MCP_KEY=<the access key>
```

**Backend URL (optional here).** The plugin defaults to a built-in function URL via
`${DEV_CONTEXT_MCP_URL:-<default>}`. To point at a *different* dev-context backend
(your own Supabase deployment), set:

```
DEV_CONTEXT_MCP_URL=https://<your-project-ref>.supabase.co/functions/v1/dev-context-mcp
```

Leave it unset to use the default.

For the **SessionEnd background safety net** (optional — summarises an abrupt
session into the plan), also set:

```
DEV_CONTEXT_SUPABASE_URL=https://dpwdbusvukzbmcxvhkuh.supabase.co
DEV_CONTEXT_SERVICE_KEY=<supabase service-role key>
OPENROUTER_API_KEY=<openrouter key>
```

Without the background vars, that one hook no-ops quietly; everything else works.

## ⚠️ Avoid double-firing

If you previously wired these hooks manually in `~/.claude/settings.json`, **remove
that hooks block after installing the plugin** — otherwise each hook runs twice.
The plugin is now the single source.
