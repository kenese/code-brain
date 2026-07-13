This is my personal fork of Nate Jones [Open brain project](https://github.com/NateBJones-Projects/OB1).
I have set it up pretty standard, but have also added "dev-context" mcp and a wrapping plugin (to set up harness hooks)

## How the `dev-context` plugin works

`dev-context` gives a coding agent (Claude Code, Codex CLI, or Gemini CLI) a
persistent, per-repo/per-branch memory of "what's the plan and where am I in
it" — without you narrating it by hand every session. It has three parts:
a remote MCP server, a Postgres schema behind it, and a set of lifecycle
hooks that call the MCP tools automatically at the right moments.

### 1. The MCP server (`supabase/functions/dev-context-mcp/index.ts`)

A Supabase Edge Function (Deno) that serves an MCP server over HTTP
(`StreamableHTTPTransport`), authenticated by an `x-access-key` header
checked against `MCP_ACCESS_KEY`. It's backed by Supabase Postgres tables:

- **`repos`** — one row per repo, holds a freeform `architecture_doc`.
- **`plans`** — a line of work in a repo, optionally bound to a `branch` /
  `worktree_path`. Tracks a cursor (`cursor_phase_id`, `cursor_step_id`), a
  `position_note` ("you are here"), and an optional free-form `jira_ticket`
  reference (a bare key like `NOC-2359` or a full URL).
- **`phases`** — ordered stages of a plan (`upcoming` → `active` → `done`).
  Completed phases get an LLM-written `rollup` (+ embedding) instead of
  keeping all their steps in view.
- **`steps`** — ordered todo items inside a phase (`todo` → `in_progress` →
  `done`), each with a `detail` and an optional `progress_note`.
- **`ideas`** — future-work notes for a repo that haven't become a plan yet.
- **`knowledge_items`** — cross-repo or repo-scoped reusable knowledge
  (scripts, decisions, skills), embedded for semantic recall via
  `match_knowledge` / `upsert_knowledge` RPCs.

Exposed MCP tools, roughly grouped:

| Group | Tools |
|---|---|
| Orient | `connect`, `get_plan`, `get_phase`, `get_step`, `get_idea` |
| Plan lifecycle | `create_plan`, `switch_plan`, `update_focus`, `update_jira_ticket` |
| Cursor (frequent) | `update_progress`, `complete_step`, `complete_phase` |
| Structure | `add_phase`, `add_step`, `update_architecture` |
| Ideas | `add_idea`, `list_ideas`, `promote_idea_to_plan` |
| Knowledge | `save_knowledge`, `search_knowledge` |

`connect(repo, branch, worktree)` is the one call that orients a session: it
upserts the repo row, resolves the active plan by matching `branch` (falling
back to `worktree_path`), and returns the architecture doc, the list of
plans/ideas, and the active plan's current phase/step/position — plus a
"working contract" telling the model to keep the plan updated as it works
(decompose new tasks into steps, `complete_step` as it finishes them, keep
`position_note` current, propose `complete_phase` to the user before
archiving). Most other tools accept an explicit `plan_id`/`repo_id` override
so a cold function instance (no in-memory `active` state) can still be
driven correctly.

### 2. How saving and retrieving actually works

Every tool call is one HTTP request straight to the Edge Function — there's
no queue or separate write path. What happens inside falls into three
shapes depending on the tool:

**Plans / phases / steps — plain CRUD, until a phase completes.**
`create_plan` / `add_phase` / `add_step` are straight inserts that also keep
the plan's cursor (`cursor_phase_id`, `cursor_step_id`) in sync in the same
request. `create_plan` accepts an optional `jira_ticket` at creation time;
`update_jira_ticket` sets/changes/clears it afterward (same shape as
`update_focus`) — pass an empty string to clear. Plans without a ticket just
omit it from `get_plan` / `connect` output. `complete_step` marks the current step `done`, finds the next
`todo` step in that phase, marks it `in_progress`, and moves the cursor to
it. `complete_phase` (with `confirm=true`) is the one exception: it sends
the phase's title + steps to OpenRouter (`gpt-4o-mini`) for a JSON summary,
embeds that summary via OpenRouter (`text-embedding-3-small`), and writes
both `rollup` and `rollup_embedding` to the `phases` row before advancing
the plan to its next phase (or marking the plan `done` if none remain). That
embedding isn't queried by any tool yet — the migration also defines a
`match_phase_history` RPC for semantically recalling old phase rollups, but
nothing calls it today. Retrieval (`get_plan` / `get_phase` / `get_step`,
and the plan render `connect` returns) is plain `select`s by id, joined in
application code — no RPC involved.

**Ideas — plain CRUD.** `add_idea` inserts a row. `list_ideas` selects only
`id, title` ordered by `created_at desc` (bodies are left out to keep the
list cheap) — use `get_idea` for the full body. `promote_idea_to_plan`
reads the idea, creates a plan from its title/body, then **deletes** the
idea row: the idea becomes the plan rather than being copied into one.

**Knowledge — the only capability that goes through embeddings + a
Postgres RPC.** `save_knowledge` fires two OpenRouter calls in parallel: an
embedding of `title\n\nbody` (`text-embedding-3-small`) and a metadata
extraction (`gpt-4o-mini` pulling `language`/`topics`/`tags` as JSON), then
inserts the row via the `upsert_knowledge` SQL RPC (returns the new id) and
follows up with an `update` to patch the `embedding` column in — insert then
patch, rather than one insert, because the embedding and metadata calls
finish independently. `search_knowledge` embeds the query text and calls
the `match_knowledge` RPC with `query_embedding`, `match_count` (the
requested limit), a hardcoded `match_threshold` of `0.4`, an optional
`kind_filter`, and a scope flag: `scope=repo` passes `repo_filter=<active
repo>` — but the RPC also ORs in rows with a null `repo_id`, so global
knowledge always surfaces alongside repo-scoped knowledge; `scope=global`
sets `only_global=true` and excludes repo-scoped rows entirely; `scope=all`
passes no filter, so everything is a candidate. Matches are ordered by
cosine distance (pgvector's `<=>` operator) ascending — closest first — and
anything below the similarity threshold is dropped before it reaches you.

**`connect()`'s plan resolution**, in full: it upserts the `repos` row,
then picks the active plan by trying a `branch` match first and falling
back to a `worktree_path` match, both restricted to `status != "done"`. The
winning id is cached in a module-level `active` variable — but that only
survives while the Deno function instance stays warm; a cold start resets
it silently. That's why almost every other tool accepts an explicit
`plan_id` / `repo_id` override — it's not redundant, it's what keeps things
working when `active` has been reset without you noticing.

### 3. The hooks (`plugins/dev-context/scripts/*.sh`)

Three harness-agnostic bash scripts don't call the MCP server directly —
they print an instruction that the agent then acts on via its own MCP
client, so the same scripts work across Claude Code, Codex CLI, and Gemini
CLI (only the event name and config format differ per harness):

- **`dev-context-connect.sh`** (`SessionStart`) — derives `repo` (from
  `git remote origin`), `branch`, and `worktree` from the current git repo,
  and emits an instruction telling the agent to call `connect` with those
  values before doing anything else. No-ops outside a git repo.
- **`dev-context-watchdog.sh`** (`PostToolUse`, matching `Edit|Write|Bash`) —
  a passive staleness watchdog. It keeps a per-repo+branch counter file
  under `$TMPDIR`, incrementing it on every matching tool call; once it hits
  a threshold (default 6, via `DEV_CONTEXT_WATCHDOG_THRESHOLD`) it resets
  the counter and emits a non-blocking reminder to checkpoint via
  `complete_step`/`update_progress`. The model decides whether to act on it.
- **`dev-context-checkpoint.sh`** (`Stop`, and `SessionEnd` with
  `--background`) — two modes:
  - default: emits an instruction telling the agent to checkpoint progress
    (`complete_step` + `update_progress`) before finishing the turn.
  - `--background`: a safety net for abrupt session endings, requiring no
    model turn. It reads the hook's transcript path off stdin, tails the
    last ~12KB, resolves the active plan for the repo+branch via the
    Supabase REST API, asks OpenRouter (`gpt-4o-mini`) for a one-sentence
    "what was being worked on and how far it got" summary, and `PATCH`es
    that straight into the plan's `position_note` (prefixed `[auto]`). It
    quietly no-ops if `DEV_CONTEXT_SUPABASE_URL` / `DEV_CONTEXT_SERVICE_KEY`
    / `OPENROUTER_API_KEY` aren't set.

### 4. Packaging per harness

The same three scripts are bundled three times, once per harness, each with
its own manifest/config wiring the harness's actual event names to the
scripts:

| | Claude Code | Codex CLI | Gemini CLI |
|---|---|---|---|
| Location | `plugins/dev-context/` | `codex-plugin/` | `gemini-extension/` |
| Manifest | `.claude-plugin/plugin.json` | `.codex-plugin/plugin.json` | `gemini-extension.json` |
| MCP config | `.mcp.json` (`$DEV_CONTEXT_MCP_URL` interpolated) | `.mcp.json` (static URL — Codex doesn't interpolate) | `.mcp.json` |
| Hook config | `hooks/hooks.json` | `hooks/hooks.json` | `hooks/hooks.json` |
| auto-connect | `SessionStart` | `SessionStart` | `SessionStart` |
| watchdog | `PostToolUse` | `PostToolUse` | `AfterTool` |
| checkpoint | `Stop` | `Stop` | `AfterAgent`/`Stop` |
| background safety net | `SessionEnd` | *(no SessionEnd — folded into `Stop`, background mode unused)* | `SessionEnd` |

A standalone copy of the scripts + a manual wiring guide for each harness
also lives in `hooks/` for reference/manual setup, but installing the
plugin (Claude Code) or extension (Codex/Gemini) is the intended path — it
sets `$CLAUDE_PLUGIN_ROOT` (or equivalent) so paths resolve wherever it's
installed, including cloud sessions. **Don't wire the same hooks both
manually and via the plugin** — that double-fires them.

### Required environment

The MCP server itself always needs:

```
DEV_CONTEXT_MCP_KEY=<access key, matches open-brain's MCP_ACCESS_KEY>
```

Optional, to point at a non-default `dev-context` backend deployment:

```
DEV_CONTEXT_MCP_URL=https://<your-project-ref>.supabase.co/functions/v1/dev-context-mcp
```

Optional, only for the `SessionEnd` background safety net:

```
DEV_CONTEXT_SUPABASE_URL=https://<project-ref>.supabase.co
DEV_CONTEXT_SERVICE_KEY=<supabase service-role key>
OPENROUTER_API_KEY=<openrouter key>
```

Everything else (auto-connect, watchdog, foreground checkpoint nudge) needs
no environment beyond the MCP server itself — those scripts only inspect
local git state and print instructions for the model to act on.
