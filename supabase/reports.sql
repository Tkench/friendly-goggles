-- Last Brick: "Report a problem" / "Wrong match? Tell us".
-- Paste this whole file into Supabase → SQL Editor → New query, then press Run.
-- Reports appear in Table Editor → reports.

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
