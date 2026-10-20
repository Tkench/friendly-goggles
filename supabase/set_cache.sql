-- Last Brick: shared cache of parts lists for the "rebrickable" helper.
-- Paste into Supabase → SQL Editor → New query, then press Run.

create table if not exists public.set_cache (
  key text primary key,          -- e.g. 'set:6080-1' or 'categories'
  data jsonb not null,
  fetched_at timestamptz not null default now()
);

-- Row-level security on with no policies: the app can't read or change this
-- table directly; only the helper (which runs with the service key) can.
alter table public.set_cache enable row level security;
