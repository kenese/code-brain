# dev-context hooks

These three scripts drive the `dev-context` MCP implicitly, so you rarely call its
tools by hand. They are harness-agnostic — the same scripts wire under Claude
Code, Codex CLI, and Gemini CLI; only the event names and config files differ.

| Script | Role |
|---|---|
| `dev-context-connect.sh` | **auto-connect** — derive repo+branch+worktree, instruct the agent to call `connect` |
| `dev-context-watchdog.sh` | **staleness watchdog** — passive reminder to checkpoint after several edits |
| `dev-context-checkpoint.sh` | **checkpoint** — nudge the model to checkpoint; `--background` summarises the transcript and writes `position_note` directly |

Make them executable: `chmod +x hooks/*.sh`.

## Event mapping

| Role | Claude Code | Codex CLI | Gemini CLI |
|---|---|---|---|
| auto-connect | `SessionStart` | `SessionStart` | `SessionStart` |
| watchdog | `PostToolUse` | `PostToolUse` | `AfterTool` |
| checkpoint on stop | `Stop` | `Stop` | `AfterAgent` / `Stop` |
| session-end safety net | `SessionEnd` | *(none → fold into `Stop`)* | `SessionEnd` |

## Claude Code (`~/.claude/settings.json` or project `.claude/settings.json`)

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "$CLAUDE_PROJECT_DIR/hooks/dev-context-connect.sh --format=json" }] }
    ],
    "PostToolUse": [
      { "matcher": "Edit|Write|Bash", "hooks": [{ "type": "command", "command": "$CLAUDE_PROJECT_DIR/hooks/dev-context-watchdog.sh" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "$CLAUDE_PROJECT_DIR/hooks/dev-context-checkpoint.sh" }] }
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "$CLAUDE_PROJECT_DIR/hooks/dev-context-checkpoint.sh --background" }] }
    ]
  }
}
```

(Use the update-config skill to add these safely.)

## Codex CLI (`~/.codex/config.toml` or `hooks.json`)

```toml
[[hooks.SessionStart]]
command = ["bash", "hooks/dev-context-connect.sh"]

[[hooks.PostToolUse]]
command = ["bash", "hooks/dev-context-watchdog.sh"]

[[hooks.Stop]]
command = ["bash", "hooks/dev-context-checkpoint.sh"]
# Codex has no SessionEnd — run the background safety net on Stop too if desired:
# command = ["bash", "hooks/dev-context-checkpoint.sh", "--background"]
```

## Gemini CLI (`.gemini/settings.json`)

```json
{
  "hooks": {
    "SessionStart": [{ "command": "bash hooks/dev-context-connect.sh" }],
    "AfterTool":    [{ "command": "bash hooks/dev-context-watchdog.sh" }],
    "AfterAgent":   [{ "command": "bash hooks/dev-context-checkpoint.sh" }],
    "SessionEnd":   [{ "command": "bash hooks/dev-context-checkpoint.sh --background" }]
  }
}
```

## Environment (only needed for `--background`)

```
DEV_CONTEXT_SUPABASE_URL=https://<project-ref>.supabase.co
DEV_CONTEXT_SERVICE_KEY=<supabase service-role key>
OPENROUTER_API_KEY=<openrouter key>
```

The default (non-background) paths need no env — they only derive git context and
print instructions for the agent.
