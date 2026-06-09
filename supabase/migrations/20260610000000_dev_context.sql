-- dev-context MCP schema
-- Per-repo private coding context: stable architecture doc, many plans (each a
-- phase/step tree with a cursor, bound to a git branch), repo ideas, and a
-- cross-repo vector-searchable knowledge store.

create extension if not exists vector with schema extensions;

-- pgvector lives in the `extensions` schema; make its types/operators resolvable
-- for the rest of this migration (vector type, <=> operator, opclasses).
set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- repos: stable identity + architecture doc (Tier 0)
-- ---------------------------------------------------------------------------
create table if not exists repos (
    repo_id          text primary key,            -- e.g. "kenese/eat-thing"
    architecture_doc text default '',             -- stable markdown blob
    updated_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- plans: many per repo; the cursor lives here. Bound to a git branch.
-- ---------------------------------------------------------------------------
create table if not exists plans (
    id              uuid primary key default gen_random_uuid(),
    repo_id         text not null references repos(repo_id) on delete cascade,
    title           text not null,
    focus           text default '',              -- "what this line of work is"
    branch          text,                          -- bound git branch (primary resolver)
    worktree_path   text,                          -- secondary hint when present
    status          text not null default 'active', -- 'active' | 'paused' | 'done'
    cursor_phase_id uuid,
    cursor_step_id  uuid,
    position_note   text default '',              -- "you are here" within current step
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create index if not exists plans_repo_idx on plans(repo_id);
create index if not exists plans_branch_idx on plans(repo_id, branch);

-- ---------------------------------------------------------------------------
-- phases: belong to a plan; completed phases collapse to an LLM rollup (Tier 3)
-- ---------------------------------------------------------------------------
create table if not exists phases (
    id               uuid primary key default gen_random_uuid(),
    plan_id          uuid not null references plans(id) on delete cascade,
    title            text not null,
    status           text not null default 'upcoming', -- 'upcoming' | 'active' | 'done'
    order_index      int not null default 0,
    rollup           text,                          -- LLM-generated on completion
    rollup_embedding extensions.vector(1536),        -- for semantic history search
    created_at       timestamptz not null default now(),
    completed_at     timestamptz
);

create index if not exists phases_plan_idx on phases(plan_id, order_index);

-- ---------------------------------------------------------------------------
-- steps: belong to a phase
-- ---------------------------------------------------------------------------
create table if not exists steps (
    id            uuid primary key default gen_random_uuid(),
    phase_id      uuid not null references phases(id) on delete cascade,
    title         text not null,
    detail        text default '',                  -- full step detail
    progress_note text,
    status        text not null default 'todo',     -- 'todo' | 'in_progress' | 'done'
    order_index   int not null default 0
);

create index if not exists steps_phase_idx on steps(phase_id, order_index);

-- ---------------------------------------------------------------------------
-- ideas: repo-scoped future work / opportunities, promotable to a plan
-- ---------------------------------------------------------------------------
create table if not exists ideas (
    id         uuid primary key default gen_random_uuid(),
    repo_id    text not null references repos(repo_id) on delete cascade,
    title      text not null,
    body       text,
    created_at timestamptz not null default now()
);

create index if not exists ideas_repo_idx on ideas(repo_id);

-- ---------------------------------------------------------------------------
-- knowledge_items: cross-repo reusable knowledge (scripts / decisions / skills)
-- ---------------------------------------------------------------------------
create table if not exists knowledge_items (
    id         uuid primary key default gen_random_uuid(),
    repo_id    text,                                -- null = cross-repo / global
    kind       text not null,                       -- 'script' | 'decision' | 'skill'
    title      text not null,
    body       text not null,
    metadata   jsonb not null default '{}'::jsonb,  -- LLM-extracted: language, topics, tags
    embedding  extensions.vector(1536),
    created_at timestamptz not null default now()
);

create index if not exists knowledge_repo_idx on knowledge_items(repo_id);
create index if not exists knowledge_embedding_idx
    on knowledge_items using ivfflat (embedding extensions.vector_cosine_ops) with (lists = 100);
create index if not exists phases_rollup_embedding_idx
    on phases using ivfflat (rollup_embedding extensions.vector_cosine_ops) with (lists = 100);

-- ---------------------------------------------------------------------------
-- RPC: semantic search over knowledge_items, optionally scoped by repo + kind
-- ---------------------------------------------------------------------------
create or replace function match_knowledge(
    query_embedding extensions.vector(1536),
    match_count     int default 10,
    match_threshold float default 0.5,
    repo_filter     text default null,   -- null = no repo constraint (search all)
    only_global     boolean default false, -- true = only rows with repo_id is null
    kind_filter     text default null
)
returns table (
    id         uuid,
    repo_id    text,
    kind       text,
    title      text,
    body       text,
    metadata   jsonb,
    similarity float,
    created_at timestamptz
)
language sql stable
set search_path = public, extensions
as $$
    select
        k.id,
        k.repo_id,
        k.kind,
        k.title,
        k.body,
        k.metadata,
        1 - (k.embedding <=> query_embedding) as similarity,
        k.created_at
    from knowledge_items k
    where k.embedding is not null
      and (kind_filter is null or k.kind = kind_filter)
      and (
            only_global
                and k.repo_id is null
            or not only_global
                and (repo_filter is null or k.repo_id = repo_filter or k.repo_id is null)
          )
      and 1 - (k.embedding <=> query_embedding) > match_threshold
    order by k.embedding <=> query_embedding
    limit match_count;
$$;

-- ---------------------------------------------------------------------------
-- RPC: semantic search over archived phase rollups across a repo's plans
-- ---------------------------------------------------------------------------
create or replace function match_phase_history(
    query_embedding extensions.vector(1536),
    p_repo_id       text,
    match_count     int default 10,
    match_threshold float default 0.5
)
returns table (
    phase_id     uuid,
    plan_id      uuid,
    plan_title   text,
    phase_title  text,
    rollup       text,
    similarity   float,
    completed_at timestamptz
)
language sql stable
set search_path = public, extensions
as $$
    select
        ph.id   as phase_id,
        pl.id   as plan_id,
        pl.title as plan_title,
        ph.title as phase_title,
        ph.rollup,
        1 - (ph.rollup_embedding <=> query_embedding) as similarity,
        ph.completed_at
    from phases ph
    join plans pl on pl.id = ph.plan_id
    where pl.repo_id = p_repo_id
      and ph.rollup_embedding is not null
      and 1 - (ph.rollup_embedding <=> query_embedding) > match_threshold
    order by ph.rollup_embedding <=> query_embedding
    limit match_count;
$$;

-- ---------------------------------------------------------------------------
-- RPC: insert a knowledge item, returning its id (embedding patched separately,
-- mirroring open-brain's upsert_thought + update pattern)
-- ---------------------------------------------------------------------------
create or replace function upsert_knowledge(
    p_repo_id  text,
    p_kind     text,
    p_title    text,
    p_body     text,
    p_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
as $$
declare
    new_id uuid;
begin
    insert into knowledge_items (repo_id, kind, title, body, metadata)
    values (p_repo_id, p_kind, p_title, p_body, p_metadata)
    returning id into new_id;
    return new_id;
end;
$$;
