---
name: summary-all
description: Summarize all in-flight work across every repo as a scannable, colour-coded table, with each line mapped to its cmux workspace. Use when the user asks to "summarize all work", "what am I working on", "show everything across repos", or wants a cross-repo status rollup.
---

# Work summary

Produce a single, scannable, cross-repo table of everything in flight, with each
line pointed at the cmux workspace it lives in. This is a **read-only** report —
never call a dev-context write tool (`update_progress`, `complete_step`,
`create_plan`, etc.) or a cmux control tool (`select_workspace`, `focus_surface`,
etc.) while building it.

## 1. Pull the work data

Call, in parallel:

- `overview` (dev-context) with no `repo_id`, `include_done: false` — cross-repo
  plan tree, an Attention section, and the active session tree.
- `list_sessions` (dev-context) with no `repo_id`, `include_ended: false` — live
  sessions grouped by repo, each with `title`, `session_ref`, `activity`, `status`.

If dev-context isn't connected yet, call `connect` first for the current repo,
but the summary itself is about *all* repos, not just the current one — do not
narrow to `repo_id`.

## 2. Pull the cmux workspace map (best effort)

Call cmux `list_workspaces` (and `list_surfaces` per workspace if needed) to get
the human-readable names the user actually sees in the sidebar.

Match each dev-context session to a workspace:
1. First by `session_ref` (a session's ref is a cmux `workspace:N` /
   `workspace:N/surface:N` ref) against the workspace/surface refs returned by
   cmux.
2. Falling back to matching `title` against the workspace's display name.

If any cmux tool errors (e.g. "only processes started inside cmux can connect")
or cmux tools aren't available at all, **don't fail** — skip the workspace column
mapping, note once at the top of the report that workspace mapping was
unavailable, and still render the full table using dev-context data alone.

## 3. Render the table

One table, grouped by repo with a `📦 repo/name` sub-heading and a blank line
between groups. Columns:

| Repo | Work (plan) | Status | Progress | Now | Workspace |
|------|-------------|--------|----------|-----|-----------|

- **Work (plan)**: plan title, with its `kind` in parentheses, e.g.
  `Fix login bug (sprint)`.
- **Status**: an emoji badge first, then the raw status word:
  - 🟢 `active` / a session `running`
  - 🟡 `blocked`, `paused`, or a session `waiting_input`
  - ⚪ `idle`
  - ✅ `done` (only shown if the user asked to include done work)
  - Append ⚠️ if the plan or session also appears in the overview's Attention
    section (stale, stuck, failed).
- **Progress**: `phase x/y · N% steps` from the plan's rolled-up counts.
- **Now**: the plan's current phase title, or `—` if none.
- **Workspace**: the matched cmux workspace name in **bold** (e.g. `**api-auth**`),
  or `—` if unmatched / mapping unavailable. Do not fabricate a link — cmux has no
  confirmed clickable deep-link scheme for jumping to a workspace by name, so a
  bold label is the pointer the user scans for and matches manually in the
  sidebar.

Sort rows within a repo by status priority (🟡 attention-needed first, then 🟢,
then ⚪, then ✅), so the things most likely to need the user's attention surface
at the top of each group.

## 4. Attention + legend

- If the overview's Attention section is non-empty, add a short "⚠️ Needs
  attention" list underneath the table (one line per flagged plan/session with
  its reason), pulled directly from that section — don't re-derive it.
- End with a one-line legend: `🟢 active/running · 🟡 blocked/waiting · ⚪ idle · ✅ done · ⚠️ needs attention`.

## Notes

- This is a snapshot — don't cache it or write it anywhere; regenerate fresh
  each time the skill runs.
- If there is genuinely no work anywhere (`overview` and `list_sessions` both
  empty), say so plainly instead of rendering an empty table.
