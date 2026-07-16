---
name: create-cute-env
description: Reusable building block that creates a cute test environment (`cute create`). Used by prepare-workspace when kicking off new work, but standalone-invocable any time a cute env is needed on its own — e.g. testing a fix without a new workspace/branch, or reproducing a bug in isolation. Use when the user asks to "spin up a cute env" or "create a test environment", or when another skill needs one as a building block.
---

# Create cute env

Mechanical creation of a single cute environment — no workspace, worktree, or
plan involved. `prepare-workspace` calls this as one of its steps; call it
directly whenever a cute env is the only thing needed.

## Inputs

- `name` — the environment name, e.g. `kenese-noc-2359`. Required. If invoked
  directly and no name is obvious from context, ask what to call it — don't
  invent one for real work.
- `branch` — optional git branch for the env to track, if it shouldn't be the
  repo default.
- `notify` — whether to Slack-DM when the env becomes ready. Defaults to on
  unless the caller says otherwise.
- `wait` — whether to block until the env is ready before returning. Defaults
  to off (fire-and-forget) unless the caller needs the env ready before its
  next step (e.g. about to `cute deploy` into it).

## 1. Create the environment

Run (Bash):

```
cute create -name "<name>" -notify
```

Add `-branch "<branch>"` if one was given. Omit `-notify` if the caller asked
for no notification.

This is fire-and-forget by default — don't block waiting for full
provisioning unless `wait` was requested.

If it errors immediately (bad name, quota, a duplicate name already in use,
etc.), surface the error and stop. Don't retry with `-force` silently — that
can clobber an existing environment someone else may be using — ask the user
first.

## 2. Wait, if requested

If the caller asked to wait for readiness before proceeding:

```
cute wait -name "<name>"
```

## 3. Report

Return the environment name (and that a Slack DM will land when it's ready, if
`-notify` was used). This is what `prepare-workspace` folds into its own final
report.
