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
