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

## Verify against your Gemini version

Gemini's hook event set has shifted across releases. If the watchdog or checkpoint
doesn't fire, confirm your version exposes `AfterTool` / `AfterAgent` (run
`gemini` hooks docs or `/hooks`) and adjust `hooks/hooks.json` — e.g. some builds
use `AfterModel` instead of `AfterAgent`. Header env interpolation (`$DEV_CONTEXT_MCP_KEY`)
also assumes your build expands env vars in MCP headers; if not, inline the key or
use a `.env` the extension loads.
