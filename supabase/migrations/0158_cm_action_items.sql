-- ============================================================================
-- 0158: City Manager meeting action items — the month's city goals, the team's
-- things to try, and the month's takeaways.
--
-- CLUBHOUSE-ONLY DATA. Nothing here reads or writes mdapi_*, and nothing here
-- belongs in the Google Sheet the check-ins come from — that sheet is the
-- managers' own submission form and this is what the meeting agreed.
--
-- ONE TABLE, NOT THREE. A city goal and a "thing to try" are the same shape:
-- text, a status, an owner, and dated progress updates. Splitting them would
-- mean two status vocabularies to keep in step and two update tables. They are
-- discriminated by `scope`, and the CHECK constraints below make each row's
-- shape structural rather than a convention the UI is trusted to keep.
--
-- A TAKEAWAY IS NOT A TASK, AND THE DATABASE SAYS SO. A takeaway is what the
-- month taught us; giving one a status invites chasing something that has
-- already finished being true. So `kind = 'takeaway'` REJECTS a status and an
-- owner at the constraint level, not just in the component.
--
-- Apply in the Supabase SQL Editor. Additive: no drops, no deletes.
-- ============================================================================

begin;

-- ── the month key ───────────────────────────────────────────────────────────
-- 'YYYY-MM' TEXT, deliberately. A month is a CALENDAR BUCKET, not an instant:
-- stored as a timestamp it would acquire a timezone and the September board
-- could render as August for somebody. Text cannot shift. The CHECK is what
-- keeps it a month rather than free text.

create table if not exists cm_action_items (
  id          uuid        primary key default gen_random_uuid(),
  month       text        not null check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),

  -- 'city' = one city's goal for the month. 'team' = org-wide, and the city
  -- filter deliberately leaves these alone.
  scope       text        not null check (scope in ('city', 'team')),
  kind        text        not null check (kind in ('goal', 'try', 'takeaway')),

  -- THE CITY IDENTIFIER, not a display name. ATX/DFW/HOU/SATX/ATL/STL/OKC/WAW —
  -- the same key city_identifier carries everywhere else (src/lib/cityScope.ts).
  -- The three vocabularies already in the repo disagree ("DFW" / "Dallas" /
  -- "Dallas-Fort Worth"), so a join on a display name would silently match
  -- nothing for four of the seven cities. No FK: cityScope.ts is the allowlist
  -- and migration 0120 deliberately left city_identifier unconstrained.
  city        text,

  body        text        not null check (length(btrim(body)) > 0),

  -- The goals tool's four, stored as its own slugs so the two never disagree
  -- about what green means (matchday-goals.html:165).
  status      text        check (status in ('open', 'ontrack', 'atrisk', 'done')),
  owner       text,
  -- Where a takeaway came from: "Measured on staging, Sep 2", "Raised by João".
  source      text,

  sort_order  double precision not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- A city goal belongs to a city and carries a status.
  constraint cm_ai_city_shape check (
    scope <> 'city' or (city is not null and kind = 'goal' and status is not null)
  ),
  -- A team item is org-wide and is never a city goal.
  constraint cm_ai_team_shape check (
    scope <> 'team' or (city is null and kind in ('try', 'takeaway'))
  ),
  -- A TAKEAWAY IS NOT A TASK: no status, no owner, and it must say where it
  -- came from. Everything else must carry a status.
  constraint cm_ai_takeaway_shape check (
    (kind = 'takeaway' and status is null and owner is null and source is not null)
    or (kind <> 'takeaway' and status is not null)
  )
);

create index if not exists cm_action_items_month_idx on cm_action_items (month, scope, city, sort_order);

-- ── the progress line, and the history behind it ────────────────────────────
-- The page shows ONE update — the latest — with who wrote it and when. Older
-- ones stay here rather than being overwritten, because the point of keeping a
-- past month is that it is a record.
--
-- `on` is a DATE, not a timestamp: it is the day the operator is reporting
-- about, which is a calendar day and not an instant.

create table if not exists cm_action_updates (
  id          uuid        primary key default gen_random_uuid(),
  item_id     uuid        not null references cm_action_items(id) on delete cascade,
  reported_on date        not null default current_date,
  author      text,
  body        text        not null check (length(btrim(body)) > 0),
  created_at  timestamptz not null default now()
);

-- The read is always "the latest update for this item", so order by the thing
-- that decides latest, with created_at breaking a same-day tie.
create index if not exists cm_action_updates_item_idx
  on cm_action_updates (item_id, reported_on desc, created_at desc);

-- ── updated_at ──────────────────────────────────────────────────────────────
create or replace function cm_action_items_touch() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

drop trigger if exists cm_action_items_set_updated_at on cm_action_items;
create trigger cm_action_items_set_updated_at before update on cm_action_items
  for each row execute function cm_action_items_touch();

-- ── RLS: authenticated = full access, mirroring kanban_cards (0066) ─────────
-- Same reasoning: page access is enforced at the route guard, and these boards
-- are open to any signed-in Clubhouse user.
alter table cm_action_items   enable row level security;
alter table cm_action_updates enable row level security;

drop policy if exists cm_action_items_rw on cm_action_items;
create policy cm_action_items_rw on cm_action_items
  for all to authenticated using (true) with check (true);

drop policy if exists cm_action_updates_rw on cm_action_updates;
create policy cm_action_updates_rw on cm_action_updates
  for all to authenticated using (true) with check (true);

-- ── SEED: September 2026, from september-goals.json ─────────────────────────
-- The goals tool's own export, VERBATIM — 18 goals across 7 cities, every one
-- status 'open', which is what the export says. Not the mock's transcription:
-- that trimmed three goals ("Launch Crockett", "Add Friday to Rowlett",
-- "Add Monday and Wednesday - NB") and reworded two others.
--
-- Idempotent: skips entirely if any 2026-09 city goal already exists.
insert into cm_action_items (month, scope, kind, city, body, status, sort_order)
select '2026-09', 'city', 'goal', v.city, v.body, 'open', v.ord
from (values
  ('ATX',  'Parmer to 4 tournaments / week',                        1),
  ('ATX',  'LBJ to 6 matches / week',                               2),
  ('ATX',  'Ann Richards making both weekend matches consistently', 3),
  ('ATX',  'Launch Crockett',                                       4),
  ('DFW',  'Daily matches running',                                 1),
  ('DFW',  'Add Friday to Rowlett',                                 2),
  ('DFW',  'Tournament Product at Strike',                          3),
  ('SATX', 'STAR running daily',                                    1),
  ('SATX', 'Add 1 field',                                           2),
  ('SATX', 'Add Monday and Wednesday - NB',                         3),
  ('HOU',  'Katy to 3 tournaments / week',                          1),
  ('HOU',  'Tomball growth to 3 matches / week',                    2),
  ('ATL',  'Keswick to 3 matches / week',                           1),
  ('ATL',  'PRUMC running back to backs successfully',              2),
  ('STL',  'Add 1 field',                                           1),
  ('STL',  'Lou running 3 days a week regularly',                   2),
  ('OKC',  'Add 1 field',                                           1),
  ('OKC',  'Double match every Tuesday at SCI',                     2)
) as v(city, body, ord)
where not exists (
  select 1 from cm_action_items where month = '2026-09' and scope = 'city'
);

commit;
