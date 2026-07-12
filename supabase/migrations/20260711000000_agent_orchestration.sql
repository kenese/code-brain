-- dev-context: agent orchestration
--
-- Adds a `kind` dimension to plans (sprint / spike / maintenance / ...) so the
-- agent's working contract can flex per style of work, lets plans nest
-- (a maintenance loop spawning short-lived fix plans), and introduces
-- agent_sessions: a generic record of a running agent keyed on whatever
-- ambient terminal ref it reports (e.g. a cmux workspace/surface ref), so a
-- top-level orchestrator's spawned children are trackable and summarizable.

set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- plans: kind + external ticket ref + parent/child nesting
-- ---------------------------------------------------------------------------
alter table plans add column if not exists kind text not null default 'sprint';
alter table plans add column if not exists ticket_ref text;
alter table plans add column if not exists parent_plan_id uuid references plans(id) on delete set null;

create index if not exists plans_parent_idx on plans(parent_plan_id);
create index if not exists plans_kind_idx on plans(repo_id, kind);

-- ---------------------------------------------------------------------------
-- agent_sessions: live/historical record of an agent, keyed on a
-- caller-reported session_ref (e.g. cmux 'workspace:12'). Not FK'd to any
-- particular terminal multiplexer — `source`/`host` disambiguate.
-- ---------------------------------------------------------------------------
create table if not exists agent_sessions (
    id                uuid primary key default gen_random_uuid(),
    repo_id           text not null references repos(repo_id) on delete cascade,
    plan_id           uuid references plans(id) on delete set null,
    parent_session_id uuid references agent_sessions(id) on delete set null,
    session_ref       text not null,                  -- e.g. cmux 'workspace:12' / 'surface:27'
    source            text not null default 'cmux',   -- 'cmux' | 'tmux' | 'other'
    host              text not null default '',        -- cmux socket_path / machine disambiguator
    role              text not null default 'worker',  -- 'orchestrator' | 'worker' | freeform
    title             text default '',
    status            text not null default 'running', -- running|idle|blocked|waiting_input|done|failed
    activity          text default '',                 -- current "you are here" one-liner
    started_at        timestamptz not null default now(),
    last_heartbeat_at timestamptz not null default now(),
    ended_at          timestamptz
);

-- One row per (host, session_ref): register_session upserts on this.
create unique index if not exists agent_sessions_ref_idx on agent_sessions(host, session_ref);
create index if not exists agent_sessions_repo_idx on agent_sessions(repo_id);
create index if not exists agent_sessions_plan_idx on agent_sessions(plan_id);
create index if not exists agent_sessions_parent_idx on agent_sessions(parent_session_id);
