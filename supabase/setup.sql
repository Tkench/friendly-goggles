-- Last Brick: login, backup and sync.
-- Paste this whole file into Supabase → SQL Editor → New query, then press Run.

-- One row per person holding their sets, ticks and Rebrickable key.
create table if not exists public.user_data (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null,
  -- Goes up by one on every save, so two devices can't overwrite each other.
  version integer not null default 1,
  updated_at timestamptz not null default now()
);

-- Row-level security: each person can only ever see and change their own row.
alter table public.user_data enable row level security;

drop policy if exists "Read own data" on public.user_data;
create policy "Read own data" on public.user_data
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "Add own data" on public.user_data;
create policy "Add own data" on public.user_data
  for insert to authenticated with check ((select auth.uid()) = user_id);

drop policy if exists "Change own data" on public.user_data;
create policy "Change own data" on public.user_data
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists "Remove own data" on public.user_data;
create policy "Remove own data" on public.user_data
  for delete to authenticated using ((select auth.uid()) = user_id);

-- "Delete my account" in the app: removes the login (and, via the cascade,
-- the backup) for whoever is calling. Nobody can delete anyone else.
create or replace function public.delete_account()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from auth.users where id = auth.uid();
$$;

revoke execute on function public.delete_account() from public, anon;
grant execute on function public.delete_account() to authenticated;

-- Shared parts-list cache (also in set_cache.sql).

create table if not exists public.set_cache (
  key text primary key,          -- e.g. 'set:6080-1' or 'categories'
  data jsonb not null,
  fetched_at timestamptz not null default now()
);

-- Row-level security on with no policies: the app can't read or change this
-- table directly; only the helper (which runs with the service key) can.
alter table public.set_cache enable row level security;

-- Problem reports (also in reports.sql).

create table if not exists public.reports (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  -- Who sent it, if they were logged in (empty otherwise).
  user_id uuid default auth.uid() references auth.users (id) on delete set null,
  kind text not null check (kind in ('scan', 'minifig', 'general')),
  message text check (length(message) <= 2000),
  -- An email address, only if they asked for a reply.
  contact text check (length(contact) <= 200),
  -- What the app knew at the time: the scanner's guesses, what was shown, the page.
  context jsonb check (pg_column_size(context) <= 20000),
  -- A small copy of the scan photo, only if they ticked "include my photo".
  photo text check (length(photo) <= 300000)
);

-- Anyone can send a report; nobody can read, change or delete reports through
-- the app. You read them in the Supabase dashboard.
alter table public.reports enable row level security;

drop policy if exists "Anyone can send a report" on public.reports;
create policy "Anyone can send a report" on public.reports
  for insert to anon, authenticated
  with check (user_id is null or user_id = (select auth.uid()));
