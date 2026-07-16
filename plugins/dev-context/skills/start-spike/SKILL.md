---
name: start-spike
description: Kick off a new exploratory spike — asks what we're working on, then sets up a cmux workspace/worktree/cute env for it and launches a Claude session there that creates a dev-context spike plan and asks clarifying questions. Use when the user runs "/start-spike" or otherwise says they want to spike/explore/prototype something without full production rigor.
---

# Start spike

Turns a loose idea into a running, plan-tracked spike in its own workspace. Run
from the orchestrator session — this skill does the setup and hands off; it
does not itself write code or create the plan (that happens in the spawned
session, which follows dev-context's `spike` working contract: move fast, skip
heavy test coverage, but the approach itself must still be solid and
production-viable — no hacks, and surface the hard problems as early as
possible).

## 1. Ask what we're working on

Ask the user directly: "What are we working on today?" This is a spike, so a
short freeform answer is enough — don't demand ticket-level detail.

Also check for an optional `skipCute` flag anywhere in the invocation args
(e.g. `skipCute` or `skipCute=true`). When present, this run should skip
creating a cute test environment — carry that through to step 5.

## 2. Determine the target repo

Infer it from the answer (repo/project named, or obvious from context). If
it's genuinely ambiguous, run `cmux workspace-group list` (Bash) to show the
known repo groups and ask the user which one this spike belongs to via
AskUserQuestion — never guess for real work.

## 3. Derive names

- `slug` — a short kebab-case slug from the answer (e.g. `cache-warmup`).
- `work_name` — the slug.
- `branch` — `spike/<slug>`.
- `title` — a short title derived from the answer.

## 4. Build the seed prompt

This is the first message the spawned Claude session receives:

```
Spike: <the user's answer, verbatim or lightly trimmed>.

Create a dev-context plan for this with create_plan(kind="spike",
branch="<branch>", title="<title>", focus="<one-line focus>"). The goal is to
prove the idea as quickly as possible and surface the problems we'll hit as
early as possible — move fast, skip heavy test coverage and full review rigor,
but the approach itself must be solid and something that could be
productionised later; no hacks. Ask me any clarifying questions before you
start, then confirm when we're ready.
```

## 5. Invoke prepare-workspace

Call the Skill tool for `prepare-workspace` with `repo`, `work_name`, `branch`,
and `launch_command` set to `claude "<seed prompt from step 4>"` (shell-escape
the prompt appropriately). If `skipCute` was set in step 1, also pass
`skip_cute=true`.

## 6. Report

Relay prepare-workspace's result to the user: workspace/group, worktree path,
branch, cute env name (or that it was skipped, if `skipCute` was set), and
that a session is now creating the spike plan and will ask clarifying
questions there.
