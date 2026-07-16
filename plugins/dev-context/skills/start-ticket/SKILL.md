---
name: start-ticket
description: Kick off a new piece of work from a Jira ticket — sets up a cmux workspace/worktree/cute env for it, then launches a Claude session there that creates a full-rigor dev-context sprint plan from the ticket and asks clarifying questions. Use when the user runs "/start-ticket jira=XXX-000" or otherwise says to start work on a specific Jira ticket.
---

# Start ticket

Turns a Jira ticket into a running, plan-tracked piece of work in its own
workspace. Run from the orchestrator session — this skill does the setup and
hands off; it does not itself write code or create the plan (that happens in
the spawned session, which follows dev-context's `sprint` working contract:
full engineering rigor, tests, review-quality code before any phase is called
done).

## 1. Parse the ticket key

Expect `jira=XXX-000` in the invocation args (or a bare key/URL if that's what
was typed). If no key is present, ask for one — don't guess.

## 2. Fetch the ticket

- `mcp__atlassian__getAccessibleAtlassianResources` to resolve `cloudId` (skip
  if you already have it cached this session).
- `mcp__atlassian__getJiraIssue(cloudId, issueIdOrKey=<key>)` for summary,
  description, project, and any component/label fields.

If the ticket can't be found, report the error and stop.

## 3. Determine the target repo

Look for an explicit signal in the ticket (project key, component, labels, or
repo name mentioned in the summary/description). If it's genuinely ambiguous,
run `cmux workspace-group list` (Bash) to show the known repo groups and ask
the user which one this ticket belongs to via AskUserQuestion — never guess a
repo for real work.

## 4. Derive names

- `work_name` — the ticket key, lowercased (e.g. `noc-2359`).
- `branch` — the ticket key, lowercased (e.g. `noc-2359`), unless the repo has
  an obviously different convention you can see from recent branches
  (`git -C <repo-path> branch -a --sort=-committerdate | head`) — match that
  instead if so.
- `title` — the ticket summary.

## 5. Build the seed prompt

This is the first message the spawned Claude session receives — write it so
that session has everything it needs without re-fetching the ticket itself:

```
Starting new work on <KEY>: <summary>.

<description, verbatim or lightly trimmed>

Create a dev-context plan for this with create_plan(kind="sprint",
jira_ticket="<KEY>", branch="<branch>", title="<summary>", focus="<one-line
focus>"). Then ask me any clarifying questions you have about scope or
approach before writing code, and confirm when we're ready to start.
```

Keep the description faithful to the ticket — don't invent scope or acceptance
criteria that aren't in it.

## 6. Invoke prepare-workspace

Call the Skill tool for `prepare-workspace` with `repo`, `work_name`, `branch`,
and `launch_command` set to `claude "<seed prompt from step 5>"` (shell-escape
the prompt appropriately).

## 7. Report

Relay prepare-workspace's result to the user: workspace/group, worktree path,
branch, cute env name, and that a session is now creating the plan and will ask
clarifying questions there.
