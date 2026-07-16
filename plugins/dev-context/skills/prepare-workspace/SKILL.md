---
name: prepare-workspace
description: Reusable building block that physically sets up a new piece of work — cmux workspace grouped with its repo, a cute test environment, and a git worktree — then launches a Claude session in it with a seed prompt. Not invoked directly by the user; start-ticket and start-spike both invoke it via the Skill tool once they've worked out repo/branch/name/seed-prompt. Do not use this for anything that isn't kicking off a brand-new line of work.
---

# Prepare workspace

Mechanical setup only — no plan creation, no clarifying questions. The caller
(`start-ticket` or `start-spike`) has already decided *what* the work is; this
skill just gets a workspace, environment, and worktree ready and hands off to a
fresh Claude session there.

## Inputs

The caller states these when invoking this skill (via the Skill tool's `args`,
or plainly in the invocation message — parse whichever form you receive):

- `repo` — the target repo name, e.g. `motors_carsell` or `code-brain`.
- `work_name` — short slug for the piece of work (ticket key like `noc-2359`, or
  a spike slug like `cache-warmup-spike`). Lowercase, hyphenated.
- `branch` — the git branch to create, e.g. `noc-2359` or `spike/cache-warmup`.
- `launch_command` — the exact shell command to run in the new workspace once
  it's ready, e.g. `claude "Starting new work on NOC-2359: ..."`. This is what
  actually starts the child Claude session and seeds its first turn.

If any of these is missing, stop and ask the caller/user rather than guessing.

## 1. Resolve the repo's cmux group + local path

Run `cmux workspace-group list --json` (Bash). Match `repo` against group
`name`s (case-insensitively, allow loose matches — "motors_carsell" ~
"Motors Carsell"). If a group matches:

- Read its `anchor_workspace_ref`, then get that workspace's `cwd` via
  `cmux sidebar-state --workspace <ref>` — this gives the repo's local checkout
  path (strip any worktree subpath back to the repo root, e.g. drop a trailing
  `/.claude/worktrees/<x>`).

If **no group matches**:
- List the existing group names to the user and ask which one this belongs to
  (or whether to create a new group), via AskUserQuestion. Never guess a repo
  path. If the user confirms a brand new group, create it with
  `cmux workspace-group create --name "<repo>" --cwd ~/Data/Solutions/<repo>`
  (only after confirming that path is correct — ask if unsure).

## 2. Create the cute test environment

Run (Bash, fire-and-forget — don't block waiting for it to finish provisioning):

```
cute create -name "kenese-<work_name>" -notify
```

Note the env name in your final report. If `cute create` errors immediately
(bad name, quota, etc.), surface the error and stop rather than continuing to a
half-set-up state.

## 3. Create the git worktree

From the repo root resolved in step 1:

```
git -C <repo-path> worktree add <repo-path>/.claude/worktrees/<work_name> -b <branch>
```

If the branch or worktree path already exists, **stop and report** — don't
force, delete, or reuse silently; ask the user how to proceed.

## 4. Create the cmux workspace inside the group, and launch

```
cmux new-workspace --group <group-ref> --group-placement end \
  --cwd "<repo-path>/.claude/worktrees/<work_name>" \
  --name "<work_name>" --focus true \
  --command "<launch_command>"
```

`--command` sends `launch_command` (Enter included) to the new workspace right
after creation — this is what starts the child Claude session with its seed
prompt already typed in.

## 5. Mark it for attention

`--focus true` above already navigates the user there. Also badge it so it's
visible even if they've since switched away, and fire a notification:

```
cmux set-status attention "ready for input" --workspace <new-workspace-ref> --icon bolt.fill --color "#4C8DFF"
cmux notify --title "<work_name> ready" --body "Workspace, worktree, and cute env are set up." --workspace <new-workspace-ref>
```

## 6. Report back

Tell the caller/user, concisely: the new workspace ref/name, the group it landed
in, the worktree path, the branch, and the cute env name. This is what
`start-ticket`/`start-spike` relay in their own final summary.
