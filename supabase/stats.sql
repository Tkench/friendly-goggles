-- Last Brick: visit counter and the private Stats page.
-- Paste this whole file into Supabase → SQL Editor → New query, then press Run.

-- 1. Visits: one row per device per day the app is opened. No IP address, no
--    account, nothing that identifies a person: just the day, three yes/no
--    answers (first time on this device? logged in? installed on the home screen?)
--    and where the visitor came from (a website name like "facebook.com", or a
--    tag from the link such as lastbrick.co.uk/?ref=reddit).
create table if not exists public.visits (
  id bigint generated always as identity primary key,
  day date not null default current_date,
  new_visitor boolean not null default false,
  has_account boolean not null default false,
  installed boolean not null default false
);
alter table public.visits add column if not exists source text check (length(source) <= 60);
alter table public.visits enable row level security;

drop policy if exists "Anyone can count a visit" on public.visits;
create policy "Anyone can count a visit" on public.visits
  for insert to anon, authenticated
  with check (day = current_date);

-- 2. Who can see the Stats page. Only accounts listed here.
create table if not exists public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade
);
alter table public.admins enable row level security; -- no policies: not readable from the app

-- Tracey's account (from the first problem report).
insert into public.admins (user_id) values ('914fdbbc-5368-4e91-9346-1b089e4ae2c5')
on conflict do nothing;

create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = ''
as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

-- 3. Everything the Stats page shows, in one go. Refuses anyone not in admins.
create or replace function public.admin_stats()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if not exists (select 1 from public.admins where user_id = auth.uid()) then
    raise exception 'Not allowed';
  end if;

  with items as (
    select d.user_id, s.key as num, s.value as item
    from public.user_data d
    cross join lateral jsonb_each(coalesce(d.data->'sets', '{}'::jsonb)) s
  ),
  per_item as (
    select i.user_id, i.num, i.item->>'name' as name, coalesce(i.item->>'img', '') as img,
           i.num like 'fig-%' as is_fig,
           coalesce(sum((p->>'qty')::int), 0) as need,
           coalesce(sum(least((p->>'have')::int, (p->>'qty')::int)), 0) as have,
           case when jsonb_typeof(i.item->'value') = 'number' then (i.item->>'value')::numeric end as value
    from items i
    left join lateral jsonb_array_elements(coalesce(i.item->'parts', '[]'::jsonb)) p on true
    group by i.user_id, i.num, i.item
  ),
  missing as (
    select p->>'key' as key, max(p->>'name') as name, max(p->>'colorName') as colour,
           max(p->>'img') as img, sum((p->>'qty')::int - least((p->>'have')::int, (p->>'qty')::int)) as missing,
           count(distinct i.user_id) as people
    from items i
    cross join lateral jsonb_array_elements(coalesce(i.item->'parts', '[]'::jsonb)) p
    where (p->>'have')::int < (p->>'qty')::int
    group by p->>'key'
  )
  select jsonb_build_object(
    'visits', jsonb_build_object(
      'today', (select count(*) from public.visits where day = current_date),
      'week', (select count(*) from public.visits where day > current_date - 7),
      'month', (select count(*) from public.visits where day > current_date - 30),
      'newMonth', (select count(*) from public.visits where day > current_date - 30 and new_visitor),
      'installedMonth', (select count(*) from public.visits where day > current_date - 30 and installed),
      'sources', (select coalesce(jsonb_agg(t), '[]') from (
        select coalesce(nullif(source, ''), 'direct') as source, count(*) as visits,
               count(*) filter (where new_visitor) as new_visitors
        from public.visits where day > current_date - 30
        group by 1 order by count(*) desc limit 12) t),
      'byDay', (select jsonb_agg(jsonb_build_array(g.d, coalesce(v.n, 0)) order by g.d)
                from generate_series(current_date - 29, current_date, interval '1 day') g(d)
                left join (select day, count(*) n from public.visits group by day) v on v.day = g.d::date)
    ),
    'accounts', jsonb_build_object(
      'total', (select count(*) from auth.users),
      'week', (select count(*) from auth.users where created_at > now() - interval '7 days'),
      'unconfirmed', (select count(*) from auth.users where email_confirmed_at is null),
      'activeWeek', (select count(*) from auth.users u where u.last_sign_in_at > now() - interval '7 days'
                       or exists (select 1 from public.user_data d where d.user_id = u.id and d.updated_at > now() - interval '7 days')),
      'byWeek', (select jsonb_agg(jsonb_build_array(g.w, coalesce(a.n, 0)) order by g.w)
                 from generate_series(date_trunc('week', now()) - interval '11 weeks', date_trunc('week', now()), interval '1 week') g(w)
                 left join (select date_trunc('week', created_at) w, count(*) n from auth.users group by 1) a on a.w = g.w)
    ),
    'collections', jsonb_build_object(
      'people', (select count(distinct user_id) from per_item),
      'sets', (select count(*) from per_item where not is_fig),
      'figs', (select count(*) from per_item where is_fig),
      'need', (select coalesce(sum(need), 0) from per_item),
      'have', (select coalesce(sum(have), 0) from per_item),
      'complete', (select count(*) from per_item where not is_fig and need > 0 and have >= need),
      'value', (select coalesce(sum(value), 0) from per_item),
      'lookedUp', (select count(*) from public.set_cache where key like 'set:%'),
      'figsLookedUp', (select count(*) from public.set_cache where key like 'fig2:%')
    ),
    'topSets', (select coalesce(jsonb_agg(t), '[]') from (
      select num, max(name) as name, max(img) as img, count(*) as people
      from per_item where not is_fig group by num order by count(*) desc, max(name) limit 10) t),
    'topFigs', (select coalesce(jsonb_agg(t), '[]') from (
      select num, max(name) as name, max(img) as img, count(*) as people
      from per_item where is_fig group by num order by count(*) desc, max(name) limit 10) t),
    'mostMissing', (select coalesce(jsonb_agg(t), '[]') from (
      select key, name, colour, img, missing, people from missing order by people desc, missing desc limit 10) t),
    'reports', jsonb_build_object(
      'total', (select count(*) from public.reports),
      'week', (select count(*) from public.reports where created_at > now() - interval '7 days'),
      'recent', (select coalesce(jsonb_agg(t), '[]') from (
        select created_at, kind, message, contact is not null as wants_reply
        from public.reports order by id desc limit 8) t)
    )
  ) into result;
  return result;
end;
$$;

revoke execute on function public.admin_stats() from public, anon;
grant execute on function public.admin_stats() to authenticated;
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;
