---
name: summary-here
description: Show the full status of the work bound to the current folder/repo/branch/worktree — every phase and step broken into completed, current, and remaining. Use when the user asks "what's the status here", "where are we on this", "show current work", or wants a detailed progress readout for the repo they're sitting in (as opposed to a cross-repo rollup — see summary-all for that).
---

# Summary here

Produce a single, detailed report of the plan bound to *this* repo/branch/
worktree — every phase and step, grouped into completed / current / remaining.
This is a **read-only** report — never call a dev-context write tool
(`update_progress`, `complete_step`, `create_plan`, etc.) while building it.

## 1. Resolve context

- Determine the current repo, branch, and worktree path (git remote, current
  branch, cwd).
- If dev-context isn't already connected this session for this repo/branch,
  call `connect` (dev-context) with `repo`, `branch`, and `worktree` to resolve
  the active plan for this exact location. If already connected to the same
  repo/branch, reuse that active plan instead of reconnecting.
- If no plan is bound to this branch, say so plainly and stop — don't
  fabricate a report. Offer to `create_plan(title, focus, branch=<branch>)`.

## 2. Pull full plan detail

- Call `get_plan` (dev-context) with the active plan's id to get *every*
  phase and its steps — `connect` only returns the current slice, not the
  full history.

## 3. Render the report

Header:

```
📍 {repo} · branch `{branch}` · worktree `{worktree}`
## {plan title} ({kind}) — {status}
Focus: {focus, if set}
Jira: {ticket, if set}
```

Then walk phases in order:

- ✅ **Phase N — {title}** (done) — if the plan tracks a rollup/summary for
  archived phases, show it in one line; otherwise list its steps compactly as
  `✅ {step title}` with no extra detail.
- ▶️ **Phase N — {title}** (current) — expand fully: every step, in order,
  as one of:
  - `✅ {step title}` — plus its closing note if one was recorded
  - `▶️ {step title}` (current) — plus its detail, if any
  - `⬜ {step title}` (todo)
- ⬜ **Phase N — {title}** (todo) — list step titles only, no detail.

## 4. Progress rollup + position

End with:

- `Progress: phase {x}/{y} · {done}/{total} steps done ({pct}%)`
- The plan's stored "you are here" position note, verbatim, under a `Now:`
  line.
- Legend: `✅ done · ▶️ current · ⬜ todo`.

## Notes

- This is a snapshot — don't cache it or write it anywhere; regenerate fresh
  each time the skill runs.
- If a field (notes, detail, rollup) isn't present on a phase/step, omit it
  silently rather than erroring or inventing content.
- Scoped to the current repo/branch/worktree only — for a cross-repo rollup
  of everything in flight, use the `summary-all` skill instead.
