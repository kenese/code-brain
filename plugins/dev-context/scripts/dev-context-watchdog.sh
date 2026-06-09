#!/usr/bin/env bash
# dev-context :: PostToolUse / AfterTool hook — passive staleness watchdog
#
# Fires after edits / test runs. Counts tool calls since the last plan write and,
# once a threshold is crossed, emits a NON-BLOCKING reminder to checkpoint. The
# model decides whether a step actually finished; if mid-step it ignores this.
#
# State is a per-repo+branch counter file under $TMPDIR. The connect/checkpoint
# scripts reset it (touch the marker) when the plan is written.
set -euo pipefail

THRESHOLD="${DEV_CONTEXT_WATCHDOG_THRESHOLD:-6}"

cd "${CLAUDE_PROJECT_DIR:-$PWD}" 2>/dev/null || true
key="$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")|$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
hash="$(printf '%s' "$key" | cksum | cut -d' ' -f1)"
state="${TMPDIR:-/tmp}/dev-context-watchdog-$hash"

count=0
[ -f "$state" ] && count="$(cat "$state" 2>/dev/null || echo 0)"
count=$((count + 1))

if [ "$count" -ge "$THRESHOLD" ]; then
    printf '0' > "$state"
    printf '%s\n' "dev-context: you've made several changes since your last checkpoint — if you completed a step, mark it with complete_step and update position_note via update_progress."
else
    printf '%s' "$count" > "$state"
fi
exit 0
