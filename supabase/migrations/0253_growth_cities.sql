-- 0253_growth_cities.sql — APPLIED 2026-11-04 by Ryan in the Supabase SQL Editor (Part A, Part B, checks).
-- 2026 Daily Matches: a stored city list with its own December goal; new fields belong to a city by id.

-- ═══ PART A — DDL ═══════════════════════════════════════════════════════════════════════════════
begin;

create table if not exists public.growth_cities (
  id              uuid primary key default gen_random_uuid(),
  name            text not null check (btrim(name) <> ''),
  short_code      text check (short_code is null or short_code ~ '^[A-Z]{2,5}$'),
  dec_goal_daily  numeric(6,2) not null default 0 check (dec_goal_daily >= 0),
  hidden          boolean not null default false,
  hidden_at       timestamptz,
  hidden_by       text,
  sort_order      double precision not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index if not exists growth_cities_name_uq on public.growth_cities (lower(btrim(name)));
create unique index if not exists growth_cities_code_uq on public.growth_cities (short_code) where short_code is not null;

alter table public.growth_cities enable row level security;
drop policy if exists growth_cities_rw on public.growth_cities;
create policy growth_cities_rw on public.growth_cities
  for all to authenticated
  using (public.growth_pages_readable()) with check (public.growth_pages_readable());

drop trigger if exists growth_cities_touch on public.growth_cities;
create trigger growth_cities_touch before update on public.growth_cities
  for each row execute function public.field_goals_touch();

alter table public.field_goal_rows
  add column if not exists growth_city_id uuid references public.growth_cities(id) on delete cascade;
alter table public.field_goal_rows
  add column if not exists kanban_card_id uuid references public.kanban_cards(id) on delete set null;
create index if not exists field_goal_rows_city_idx on public.field_goal_rows (growth_city_id);

commit;

-- ═══ PART B — DATA ══════════════════════════════════════════════════════════════════════════════
begin;

-- B1. Delete the five unnamed "New Field -" rows from 2026-11-01 (2 under No city set, 3 hidden).
delete from public.field_goal_rows
 where id in ('c7b65038-9156-4c2d-9420-65ad94337377', 'ec420428-3c36-4110-a1ef-6418d1e29957',
              'bc261c7d-e6e3-49ba-af4f-76088866e7b9', '192a4e21-ec8f-4600-bfae-01fa0b62ab0a',
              'e35d1fc3-ab30-4402-938c-e6905c1ca8e6')
   and slot_name like 'New Field -%' and city is null;

-- B2. Delete San Diego's "TBD" new field (Dec 1.0, Nov 0.6, 1 action — cascades).
delete from public.field_goal_rows
 where id = '80c178d0-e2da-4153-a9db-2b56f9724b59' and slot_name = 'TBD' and city = 'San Diego';

-- B3. Philadelphia: give the Friends Select School venue (fin_venues 92) a goal row if it has none,
--     move the duplicate new field's DECEMBER goal (0.5) onto it, then delete the duplicate.
--     The duplicate's Oct/Nov targets (0.3 / 0.3) and its 1 action go with it.
insert into public.field_goal_rows (venue_id, city)
select 92, 'Philadelphia'
 where not exists (select 1 from public.field_goal_rows where venue_id = 92);

insert into public.field_goal_targets (row_id, month, goal_daily)
select v.id, date '2026-12-01', t.goal_daily
  from public.field_goal_rows v
  join public.field_goal_targets t
    on t.row_id = '352aa3f2-9249-48ff-90ca-80ffcb756b46' and t.month = date '2026-12-01'
 where v.venue_id = 92
on conflict (row_id, month) do update set goal_daily = excluded.goal_daily, updated_at = now();

delete from public.field_goal_rows
 where id = '352aa3f2-9249-48ff-90ca-80ffcb756b46' and slot_name = 'Friends Select';

-- B4. Seed the cities. dec_goal_daily = the current sum of each city's counted December field
--     targets, read from /api/growth/field-goals on 2026-11-04 (page total 28.9 before B2).
--     No WAW, no San Diego, no El Paso. Total 27.9.
insert into public.growth_cities (name, short_code, dec_goal_daily, sort_order) values
  ('Austin',       'ATX',  9.9, 1),
  ('Houston',      'HOU',  5.5, 2),
  ('San Antonio',  'SATX', 5.6, 3),
  ('Atlanta',      'ATL',  1.9, 4),
  ('Dallas',       'DFW',  1.9, 5),
  ('St. Louis',    'STL',  1.6, 6),
  ('Philadelphia', 'PHL',  0.5, 7),
  ('OKC',          'OKC',  1.0, 8)
on conflict do nothing;

-- B5. Point each remaining 2026 new field at its city by the label it carries today.
--     2027-plan rows (plan_year = 2027) are left alone.
update public.field_goal_rows r
   set growth_city_id = c.id
  from public.growth_cities c
 where r.slot_name is not null and r.plan_year is null and r.growth_city_id is null
   and lower(btrim(r.city)) = lower(c.name);

commit;

-- ═══ CHECKS (read-only) ═════════════════════════════════════════════════════════════════════════
-- Expect 8 cities summing to 27.9:
--   select name, short_code, dec_goal_daily from public.growth_cities order by sort_order;
--   select sum(dec_goal_daily) from public.growth_cities;
-- Expect 6 linked new fields: ATL Field 4 (Atlanta); Richardson Field, Fort Worth 1, Fort Worth 2
-- (Dallas); TBD and Turf On (Houston):
--   select c.name, r.slot_name from public.field_goal_rows r join public.growth_cities c on c.id = r.growth_city_id order by 1, 2;
-- Expect no 2026 new field without a city (0 rows):
--   select id, slot_name, city from public.field_goal_rows where slot_name is not null and plan_year is null and growth_city_id is null;
-- Expect Friends Select School at 0.5 for December:
--   select t.goal_daily from public.field_goal_targets t join public.field_goal_rows r on r.id = t.row_id where r.venue_id = 92 and t.month = '2026-12-01';
