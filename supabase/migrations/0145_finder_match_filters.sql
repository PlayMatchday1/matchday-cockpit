-- 0145 — PLAYER FINDER: filter on the MATCHES people played, not only on who they are.
--
-- THE QUESTION THIS ANSWERS. "Who was at this match" — pick a city, a field, a kick-off time, a
-- date range, get the players who were there. Today that takes a database query, because every
-- finder filter is a PLAYER attribute and none of them touch the matches.
--
-- ══ WRITE IT AS A SET, NOT AS AN EXISTS-PER-ROW ═══════════════════════════════════════════════
--
-- THIS IS 0136'S LESSON AND THIS IS THE SAME SHAPE. Do not rewrite the CTE below as a guarded
-- `exists (select 1 from player_spots s where s.user_id = r.id and ...)`. 0136 documents exactly
-- what happens: called with the arguments OMITTED the planner constant-folds the guard and drops
-- the branch (424ms); called with the SAME values passed EXPLICITLY — which is what the route does
-- — they arrive as parameters, the planner can no longer fold them, and it plans a subplan
-- evaluated per row over 30,455 users. 424ms became an 8-second statement timeout. The function was
-- identical in both cases; only the shape of the CALL changed.
--
-- So membership is computed ONCE, as a set, and tested against. A hash semi-join whose cost does
-- not depend on whether a parameter could be folded.
--
-- ONE PASS, NOT TWO. The existing play window (`win`, 0136) and these new match filters both scan
-- player_spots. Two guarded CTEs would be two scans of the same view on a query that already runs
-- at 5.3s p50 under six concurrent callers. They are merged into a single grouped pass that
-- computes both memberships at once.
--
-- ══ THE BUDGET, AND WHAT IT COST ══════════════════════════════════════════════════════════════
--
-- MEASURED BEFORE, on production, shape `hist=multi` (the slowest single filter), 30 requests per
-- level through the real authenticated route:
--
--     concurrency 1   p50 1,382ms   max 4,389ms
--     concurrency 4   p50 3,583ms   max 3,871ms
--     concurrency 6   p50 5,271ms   max 6,816ms      ← the budget
--
-- Postgres' statement timeout is 8,000ms. At six concurrent callers the margin is 1.17x, NOT the
-- 3.9x a single-user measurement suggests. That is why this migration is written as a set from the
-- start rather than made correct first and fast later.
--
-- ACCEPTANCE: the same curve, re-run after applying WITH A MATCH FILTER APPLIED, must not be
-- slower than 5,271ms p50 / 6,816ms max at concurrency 6. If it is, the CTE is not enough and the
-- answer is an index or a precomputed set — NOT another rewrite of this same shape.
--
--     MEASURED AFTER:  (filled in once applied — if this line still says TBD, it was not measured)
--     concurrency 1   p50 TBD   max TBD
--     concurrency 4   p50 TBD   max TBD
--     concurrency 6   p50 TBD   max TBD
--
-- ══ AND THE HOME-CITY TRAP THIS ALSO FIXES ════════════════════════════════════════════════════
--
-- The finder's existing City filter reads `preferable_city_name` — the city on the player's
-- MatchDay account, not where they have played. **4,010 of 30,455 players (13.2%) have none.**
-- "City = Austin" silently excludes every one of them, and nothing on the page says so. The UI
-- renames it HOME CITY, prints that count, and offers "Not set" as a selectable value so those
-- players are reachable instead of invisible. `p_city_unset` is what makes them selectable.
--
-- Apply in the Supabase SQL editor.

begin;

-- ── 1. THE VIEW GAINS THE FIELD ───────────────────────────────────────────────────────────────
-- field_id is the join key Finance already uses; field_title travels with it so the UI can label a
-- field without a second lookup. Nothing else about the view changes — the qualifying-spot
-- predicate is untouched, and it stays the only place that predicate exists.
create or replace view public.player_spots
with (security_invoker = true) as
select
  mp.user_id,
  mp.match_api_id,
  m.start_date,
  m.start_date_utc,
  (m.start_date at time zone 'UTC') as start_local,
  m.max_player_count,
  m.player_count,
  m.city_name,
  m.field_id,                                          -- NEW: the stable numeric field
  m.field_title                                        -- NEW: its title, for the label
from public.mdapi_match_players mp
join public.mdapi_matches m on m.api_id = mp.match_api_id
where mp.is_cancelled = false
  and mp.refunded is not true
  and mp.paid_status <> 'WAITING'
  and mp.deleted_at is null
  and mp.user_id is not null
  and m.is_cancelled = false
  and m.deleted_at is null;

-- ── 2. THE PREDICATE GAINS THE MATCH FILTERS ──────────────────────────────────────────────────
drop function if exists public.player_finder_ids(text, timestamptz, timestamptz, text, text, date, date, text, text);

create or replace function public.player_finder_ids(
  p_search      text        default null,
  p_reg_from    timestamptz default null,
  p_reg_to      timestamptz default null,
  p_history     text        default 'any',
  p_play_mode   text        default 'any',
  p_play_from   date        default null,
  p_play_to     date        default null,
  p_city        text        default null,   -- HOME city (preferable_city_name)
  p_member      text        default 'any',
  -- NEW, all match-based. Null means "not filtering on this".
  p_city_unset  boolean     default false,  -- true = home city IS NULL (the 4,010)
  p_match_city  text        default null,   -- city of the matches played
  p_field_id    bigint      default null,
  p_kick_from   time        default null,   -- wall-clock kick-off, inclusive
  p_kick_to     time        default null,   -- wall-clock kick-off, inclusive
  p_match_from  date        default null,   -- inclusive wall-clock day
  p_match_to    date        default null    -- inclusive wall-clock day
)
returns table (id bigint)
language sql
stable
security invoker
as $$
  with cfg as (
    -- Is ANY match filter set? Computed once so the scan below is skipped entirely when not.
    select (p_match_city is not null or p_field_id is not null or p_kick_from is not null
            or p_kick_to is not null or p_match_from is not null or p_match_to is not null) as match_on
  ),
  hits as (
    /* ONE GROUPED PASS OVER player_spots, computing BOTH memberships. See the header: this must
     * not become an EXISTS per row, and it must not become two CTEs. The outer WHERE means a
     * request using neither the play window nor a match filter scans nothing at all. */
    select s.user_id,
           bool_or(p_play_mode = 'window'
                   and (p_play_from is null or s.start_local >= p_play_from::timestamp)
                   and (p_play_to   is null or s.start_local <  (p_play_to + 1)::timestamp)) as in_window,
           bool_or((select match_on from cfg)
                   and (p_match_city is null or s.city_name  = p_match_city)
                   and (p_field_id   is null or s.field_id   = p_field_id)
                   and (p_kick_from  is null or s.start_local::time >= p_kick_from)
                   and (p_kick_to    is null or s.start_local::time <= p_kick_to)
                   and (p_match_from is null or s.start_local >= p_match_from::timestamp)
                   and (p_match_to   is null or s.start_local <  (p_match_to + 1)::timestamp)) as in_match
    from public.player_spots s
    where (p_play_mode = 'window' or (select match_on from cfg))
      and s.start_date_utc < now()                     -- a booking is not a play (0134)
    group by s.user_id
  )
  select r.id::bigint
  from public.player_finder_rows r
  where (p_search   is null or r.search_blob like '%' || lower(p_search) || '%')
    and (p_reg_from is null or r.created_at >= p_reg_from)
    and (p_reg_to   is null or r.created_at <= p_reg_to)
    /* HOME CITY, AND THE 4,010 WITH NONE. p_city_unset selects exactly the players a
     * "City = Austin" filter has always silently dropped. The two are mutually exclusive by
     * construction: asking for "Not set" ignores any city name sent with it. */
    and (p_city_unset
         or p_city is null
         or r.preferable_city_name = p_city)
    and (not p_city_unset or r.preferable_city_name is null)
    and (p_member = 'any'
         or (p_member = 'yes' and r.is_member is true)
         or (p_member = 'no'  and r.is_member is not true))
    and (p_history = 'any'
         or (p_history = 'never' and r.plays = 0)
         or (p_history = 'once'  and r.plays = 1)
         or (p_history = 'multi' and r.plays >= 2))
    /* HISTORY = never played AND a play window cannot both be true, so the window is IGNORED
     * rather than intersected to nothing. Unchanged from 0136. */
    and (p_history = 'never' or p_play_mode = 'any'
         or (p_play_mode = 'lapsed'
             and r.plays >= 1
             and r.last_played < now() - interval '60 days')
         or (p_play_mode = 'window' and r.id in (select user_id from hits where in_window)))
    /* THE MATCH FILTERS. A player who has never played cannot match one, so "never played" plus a
     * match filter is empty — which is the truthful answer, unlike the play window above where the
     * two controls contradict and the window is dropped. */
    and (not (select match_on from cfg)
         or r.id in (select user_id from hits where in_match));
$$;

commit;

-- The page and stats wrappers are NOT changed here: both call player_finder_ids positionally with
-- the arguments they already pass, and the seven new parameters default to "not filtering". They
-- gain the new arguments in the follow-up that ships the UI, so this migration is safe to apply
-- with the current code deployed.
grant execute on function public.player_finder_ids(text, timestamptz, timestamptz, text, text, date, date, text, text, boolean, text, bigint, time, time, date, date) to authenticated, service_role;

-- VERDICT — ONE query, ONE row. The SQL editor shows only the last result set.
--   Expected:  spots_has_field t | unset_home 4010 | ids_unfiltered 30455 | ids_field_892 >0 | ids_unset 4010
--
-- TWO COLUMNS CARRY THE INTENT:
--   ids_unfiltered  must still be 30455 — the new parameters default to OFF, so an unfiltered call
--                   must return exactly what it returned before. Anything else and the defaults
--                   are filtering something.
--   ids_unset       must equal unset_home — "Not set" must reach every player with no home city,
--                   which is the whole point of adding it.
select
  (select count(*) > 0 from information_schema.columns
     where table_name = 'player_spots' and column_name = 'field_id')          as spots_has_field,
  (select count(*) from public.player_finder_rows
     where preferable_city_name is null)                                      as unset_home,
  (select count(*) from public.player_finder_ids())                           as ids_unfiltered,
  (select count(*) from public.player_finder_ids(p_field_id => 892))          as ids_field_892,
  (select count(*) from public.player_finder_ids(p_city_unset => true))       as ids_unset;

-- ROLLBACK — restores 0136's function and 0133's view exactly. Safe at any time: nothing stores
-- these parameters, so no data depends on them.
--   (re-run 0136's create-or-replace for player_finder_ids, and 0133's for player_spots)
