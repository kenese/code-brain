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

**Hide specific repos on this machine (optional).** The backend is shared across
every machine using the same access key, so repos from other machines (e.g. a
personal project you only work on at home) otherwise show up in cross-repo tools
(`overview`, `list_sessions`, `search_knowledge` with `scope: "all"`) everywhere.
To hide one or more repos on *this* machine only, without touching the shared
data or affecting other machines, set:

```
DEV_CONTEXT_EXCLUDE_REPOS=owner/repo-to-hide,owner/other-repo
```

Comma-separated `repo_id`s. This is enforced server-side (the excluded repo's
rows are filtered out of the response), not just hidden by a skill, so it's
never actually returned to this machine's session. Set it in this repo's
gitignored `.claude/settings.local.json` (not the plugin's `.mcp.json`, which is
shared) to keep it machine-local.

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
