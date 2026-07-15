-- Attach Confluence docs to a plan: array of { url, title? } objects.
alter table plans add column if not exists confluence_docs jsonb not null default '[]'::jsonb;
