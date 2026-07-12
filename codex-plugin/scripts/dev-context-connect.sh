#!/usr/bin/env bash
# dev-context :: SessionStart hook — auto-connect
#
# Derives the repo + branch + worktree from git in the current directory and
# emits an instruction telling the agent to call the dev-context `connect` MCP
# tool. We instruct the model rather than speaking MCP from bash: the harness
# already has the MCP client wired, so this stays portable across Claude Code,
# Codex, and Gemini.
#
# Wire under each harness's SessionStart event. Output on stdout is injected as
# session context. Pass --format=json for Claude Code structured output.
set -euo pipefail

cd "${CLAUDE_PROJECT_DIR:-$PWD}" 2>/dev/null || true

# Not a git repo → nothing to connect.
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    exit 0
fi

remote_url="$(git config --get remote.origin.url 2>/dev/null || true)"
# Normalise git@host:owner/name.git and https://host/owner/name.git → owner/name
repo="$(printf '%s' "$remote_url" \
    | sed -E 's#\.git$##' \
    | sed -E 's#^.*[:/]([^/]+/[^/]+)$#\1#')"
branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
worktree="$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")"

if [ -z "$repo" ]; then
    # Fall back to the worktree dir name when there is no remote.
    repo="local/$(basename "$worktree")"
fi

msg="dev-context: session started in repo \"$repo\""
[ -n "$branch" ] && msg="$msg on branch \"$branch\""
msg="$msg (worktree: $worktree).
Call the dev-context \"connect\" tool now with repo=\"$repo\"${branch:+, branch=\"$branch\"}, worktree=\"$worktree\" to load your architecture, active plan, and current step before doing other work.
If you have a stable session identity available (e.g. a cmux/tmux pane, tab, or workspace ref from an \"identify\"-style tool), also pass session_ref on connect (plus host/source, and role=\"orchestrator\" if you plan to spawn sub-agents, or parent_session_ref if another agent spawned you) so this session shows up in list_sessions/overview."

if [ "${1:-}" = "--format=json" ]; then
    # Claude Code structured SessionStart output.
    printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":%s}}\n' \
        "$(printf '%s' "$msg" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
else
    printf '%s\n' "$msg"
fi
