#!/usr/bin/env bash
# dev-context :: Stop / SessionEnd hook — auto-checkpoint
#
# Default (model-driven): emits an instruction telling the agent to checkpoint
# its progress before finishing, if it hasn't. The model writes the accurate
# note because it has full context.
#
# --background (safety net, for SessionEnd / abrupt endings): reads the session
# transcript, summarises "what was being worked on + how far it got" via
# OpenRouter, resolves the active plan from repo+branch, and writes position_note
# directly through the Supabase REST API. No model turn required.
#
# Env for --background:
#   DEV_CONTEXT_SUPABASE_URL   e.g. https://<ref>.supabase.co
#   DEV_CONTEXT_SERVICE_KEY    Supabase service-role key
#   OPENROUTER_API_KEY         OpenRouter key
set -euo pipefail

cd "${CLAUDE_PROJECT_DIR:-$PWD}" 2>/dev/null || true

if [ "${1:-}" != "--background" ]; then
    printf '%s\n' "dev-context: before finishing, if you completed any steps call complete_step, and capture where things stand with update_progress so the next session can pick up cleanly."
    exit 0
fi

# --- background safety-net path ---
# No-op quietly until the background env is configured (keeps SessionEnd silent).
if [ -z "${DEV_CONTEXT_SUPABASE_URL:-}" ] || [ -z "${DEV_CONTEXT_SERVICE_KEY:-}" ] || [ -z "${OPENROUTER_API_KEY:-}" ]; then
    exit 0
fi

# Hook input (JSON on stdin) carries transcript_path on Claude Code.
hook_input="$(cat 2>/dev/null || echo '{}')"
transcript="$(printf '%s' "$hook_input" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("transcript_path",""))
except Exception: print("")' 2>/dev/null || echo '')"

[ -z "$transcript" ] || [ ! -f "$transcript" ] && exit 0

# Last slice of the transcript as plain text.
tail_text="$(tail -c 12000 "$transcript" 2>/dev/null || true)"
[ -z "$tail_text" ] && exit 0

repo="$(git config --get remote.origin.url 2>/dev/null \
    | sed -E 's#\.git$##' \
    | sed -E 's#^.*[:/]([^/]+/[^/]+)$#\1#' || true)"
branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
[ -z "$repo" ] && exit 0

# Resolve the active plan for this repo+branch.
plan_id="$(curl -fsS \
    "${DEV_CONTEXT_SUPABASE_URL}/rest/v1/plans?repo_id=eq.${repo}&branch=eq.${branch}&status=neq.done&select=id&limit=1" \
    -H "apikey: ${DEV_CONTEXT_SERVICE_KEY}" \
    -H "Authorization: Bearer ${DEV_CONTEXT_SERVICE_KEY}" \
    | python3 -c 'import json,sys
d=json.load(sys.stdin)
print(d[0]["id"] if d else "")' 2>/dev/null || echo '')"
[ -z "$plan_id" ] && exit 0

# Summarise the tail into a short "where we are" note.
note="$(python3 - "$tail_text" <<'PY'
import json, os, sys, urllib.request
tail = sys.argv[1]
body = json.dumps({
    "model": "openai/gpt-4o-mini",
    "messages": [
        {"role": "system", "content": "From this coding session transcript tail, write ONE short sentence: what was being worked on and how far it got. No preamble."},
        {"role": "user", "content": tail[-8000:]},
    ],
}).encode()
req = urllib.request.Request("https://openrouter.ai/api/v1/chat/completions", data=body,
    headers={"Authorization": "Bearer " + os.environ["OPENROUTER_API_KEY"], "Content-Type": "application/json"})
try:
    r = json.load(urllib.request.urlopen(req, timeout=30))
    print(r["choices"][0]["message"]["content"].strip())
except Exception:
    print("")
PY
)"
[ -z "$note" ] && exit 0

# Write position_note (prefixed so it's clear it was auto-captured).
curl -fsS -X PATCH \
    "${DEV_CONTEXT_SUPABASE_URL}/rest/v1/plans?id=eq.${plan_id}" \
    -H "apikey: ${DEV_CONTEXT_SERVICE_KEY}" \
    -H "Authorization: Bearer ${DEV_CONTEXT_SERVICE_KEY}" \
    -H "Content-Type: application/json" \
    -d "$(python3 -c 'import json,sys; print(json.dumps({"position_note": "[auto] " + sys.argv[1]}))' "$note")" \
    >/dev/null 2>&1 || true
exit 0
