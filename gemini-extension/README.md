# dev-context (Gemini CLI extension)

Installs the `dev-context` MCP server + lifecycle hooks for Gemini CLI in one step.

## Install

```
gemini extensions install --path /Users/keneselautusi/Documents/Code/PROJECTS/open-brain/gemini-extension
```

(Or install from the GitHub repo once pushed.)

## Required environment

```
DEV_CONTEXT_MCP_URL=https://<your-project-ref>.supabase.co/functions/v1/dev-context-mcp
DEV_CONTEXT_MCP_KEY=<the access key>          # same as open-brain's MCP_ACCESS_KEY
```

Unlike the Claude plugin, the Gemini manifest has no built-in default, so
`DEV_CONTEXT_MCP_URL` must be set. (If your Gemini build doesn't expand env vars in
`httpUrl`, hardcode the URL in `gemini-extension.json` instead.)

For the SessionEnd background safety net (optional):

```
DEV_CONTEXT_SUPABASE_URL=https://dpwdbusvukzbmcxvhkuh.supabase.co
DEV_CONTEXT_SERVICE_KEY=<supabase service-role key>
OPENROUTER_API_KEY=<openrouter key>
```

## Event mapping

| Role | Gemini event |
|---|---|
| auto-connect | `SessionStart` |
| watchdog | `AfterTool` (matcher `*`; the script self-throttles to every Nth call) |
| checkpoint | `AfterAgent` |
| session-end safety net | `SessionEnd` |

Bundled `scripts/` are referenced via `${extensionPath}`, so they resolve wherever
the extension is installed.

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

## Verify against your Gemini version

Gemini's hook event set has shifted across releases. If the watchdog or checkpoint
doesn't fire, confirm your version exposes `AfterTool` / `AfterAgent` (run
`gemini` hooks docs or `/hooks`) and adjust `hooks/hooks.json` — e.g. some builds
use `AfterModel` instead of `AfterAgent`. Header env interpolation (`$DEV_CONTEXT_MCP_KEY`)
also assumes your build expands env vars in MCP headers; if not, inline the key or
use a `.env` the extension loads.
