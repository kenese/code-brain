# dev-context (pi extension)

Installs the `dev-context` MCP server + lifecycle hooks for the
[pi coding agent](https://github.com/earendil-works/pi-coding-agent).

Pi has two separate mechanisms this package relies on:

- **Extensions** (`pi install`) — pi auto-installs and loads TypeScript
  extensions declared under the `pi.extensions` key in `package.json`. This is
  how the hooks (`extensions/dev-context-hooks.ts`) get wired up.
- **MCP config** (`pi-mcp-adapter`) — pi has no native MCP client; MCP support
  comes from the `pi-mcp-adapter` package (a *separate* pi package most pi
  installs already have). It reads server definitions from a fixed set of
  config file locations, **not** from installed package directories. So the
  bundled `.mcp.json` here is a template to copy in — `pi install` does not
  wire it up automatically.

## Structure

- `package.json` — declares the extension entry point (`pi.extensions`)
- `extensions/dev-context-hooks.ts` — session/tool-call hooks (see below)
- `scripts/` — bundled hook scripts (auto-connect, watchdog, checkpoint)
- `.mcp.json` — template MCP server definition to copy into a config pi-mcp-adapter reads

## Install

### 1. Install `pi-mcp-adapter` if you haven't already

```bash
pi install npm:pi-mcp-adapter
```

(Skip if `pi list` already shows it — most pi installs bundle it.)

### 2. Install this extension (hooks)

```bash
pi install /path/to/code-brain/pi-extension        # global, all projects
pi install -l /path/to/code-brain/pi-extension      # project-local only
```

This registers `pi-extension-dev-context` in `~/.pi/agent/settings.json` (or
`.pi/settings.json` for `-l`) under `packages`, and pi loads
`extensions/dev-context-hooks.ts` on startup.

### 3. Wire the MCP server

Copy `.mcp.json` from this directory into one of the locations
`pi-mcp-adapter` reads (see `pi-mcp-adapter`'s own docs / `pi mcp` command for
the full list — the common ones are):

- `~/.pi/agent/mcp.json` — global, all projects (recommended for this repo's
  use case, matching the Claude Code / Codex / Gemini plugins which also
  install `dev-context` globally)
- `<project>/.mcp.json` — project-local only

```bash
mkdir -p ~/.pi/agent
cp pi-extension/.mcp.json ~/.pi/agent/mcp.json
```

If a global `mcp.json` already exists with other servers, merge the
`dev-context` entry into its `mcpServers` object instead of overwriting.

**Important — env var syntax differs from Claude Code.** `pi-mcp-adapter` only
supports simple `${VAR}` interpolation, not bash-style `${VAR:-default}`
fallbacks. The bundled `.mcp.json` uses the plain form; if you want a fallback
default URL, hardcode it instead of using `:-`.

## Required environment

```
DEV_CONTEXT_MCP_KEY=<the access key>   # same as open-brain's MCP_ACCESS_KEY
```

Optional:

```
DEV_CONTEXT_EXCLUDE_REPOS=owner/repo-to-hide,owner/other-repo
DEV_CONTEXT_HOOKS_DIR=/custom/path/to/scripts   # override if this repo moves
```

For the background safety-net checkpoint (`session_shutdown`):

```
DEV_CONTEXT_SUPABASE_URL=https://<project-ref>.supabase.co
DEV_CONTEXT_SERVICE_KEY=<supabase service-role key>
OPENROUTER_API_KEY=<openrouter key>
```

Without these, the shutdown hook no-ops quietly.

## Event mapping (pi extension events, not a native hooks system)

| Role | pi event | Script |
|---|---|---|
| auto-connect | `session_start` (reason: startup/new/resume) | `dev-context-connect.sh` |
| watchdog | `tool_call` (matcher: `edit`/`write`/`bash`) | `dev-context-watchdog.sh` |
| checkpoint nudge | `agent_settled` | `dev-context-checkpoint.sh` |
| background safety net | `session_shutdown` | `dev-context-checkpoint.sh --background` |

Pi has no `PostToolUse`/`Stop`/`SessionEnd` hook config format like Claude
Code, Codex, or Gemini — this extension file *is* the hook wiring, using pi's
[extension events](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/extensions.md#events).

## Tool naming difference

`pi-mcp-adapter` calls dev-context tools through a generic `mcp` tool and
prefixes tool names with the server name, e.g. `dev_context_connect` instead
of Claude Code's bare `connect`. The `session_start` hook message accounts
for this automatically.

## Verify

```bash
pi mcp                      # or the `mcp` tool inside a session — should show dev-context connected
```

Then start a session in any git repo and confirm the model calls
`dev_context_connect` (or the equivalent `mcp` tool call) near the start of
the turn.
