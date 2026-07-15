-- Durable active repo/plan context.
--
-- connect() previously set an in-memory `active` variable that requireActive()
-- read back. Supabase Edge Functions give no session affinity across HTTP
-- requests, so a cold/different isolate serving the next tool call would see
-- `active` reset to null even though connect() just reported success. This
-- table makes the "active repo/plan" state durable across isolates so
-- consumers can keep calling connect() then any tool with no extra params.

set search_path = public, extensions;

create table if not exists active_context (
    session_key text primary key,                 -- host||NUL||session_ref, or '__default__'
    repo_id     text not null references repos(repo_id) on delete cascade,
    plan_id     uuid references plans(id) on delete set null,
    updated_at  timestamptz not null default now()
);

create index if not exists active_context_updated_idx on active_context(updated_at desc);
