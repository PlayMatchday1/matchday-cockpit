-- PLAYER FINDER — the SQL the finder cannot work without.
--
-- WHY THIS IS A MIGRATION AND NOT ROUTE CODE. Every filter and every count on the finder has to be
-- server-side: a browser filtering the page it happens to hold filters 50 rows and reports a
-- confident wrong number for the other 30,403. The activity filters (never played / played once /
-- played in 30d / lapsed 60d+) need a per-user aggregate over mdapi_match_players, and PostgREST
-- cannot GROUP BY. Doing it in the route instead was MEASURED: 163,981 qualifying roster rows,
-- 12.7 SECONDS to page even at 12 requests in parallel. In SQL it is one hash aggregate.
--
-- THE SPOT PREDICATE IS NOT INVENTED HERE. It is rosterRowCounts() from src/lib/gamedayModel.ts
-- plus `deleted_at IS NULL`, which the API model has no concept of and the mirror does. Proven over
-- 1,000 matches / 33,399 roster rows: summed spots 21,731 = summed mdapi_matches.player_count
-- 21,731, exact on every match. See docs/matchday-api-facts.md.
--
-- ── THE TWO TIME COLUMNS, AND WHICH QUESTION EACH ANSWERS ──────────────────────────────────────
-- The mirror carries BOTH models and they are not interchangeable. Verified on match 18105:
--
--   raw.startDate      2026-08-30T21:15:00.000Z   ← wall clock wearing a Z (9:15 PM local)
--   start_date         2026-08-30T21:15:00+00:00  ← that string stored verbatim, so the column is
--                                                    the WALL CLOCK read at UTC. Not an instant.
--   start_date_utc     2026-08-31T02:15:00+00:00  ← the TRUE instant. 9:15 PM CDT = 02:15 UTC.
--
-- So:
--   "HAS IT ALREADY STARTED"  is a question about an instant  → start_date_utc < now()
--   "WHICH MONTH WAS IT IN"   is a question about wall clock  → start_date at time zone 'UTC'
--
-- Using start_date for the first would call a 9 PM match started five hours early. Using
-- start_date_utc for the second moves every evening match into the following day, and the ones
-- after 7 PM into the following MONTH. Both columns are fully populated: 0 nulls in 9,741 rows.

-- ── 1. ONE QUALIFYING SPOT PER ROW ─────────────────────────────────────────────────────────────
-- Every object below reads this, so the predicate exists in exactly one place. A second copy that
-- drifts is how "filter only the cancelled rows" left 36 of 38 rows counted last time.
create or replace view public.player_spots
with (security_invoker = true) as
select
  mp.user_id,
  mp.match_api_id,
  m.start_date,                                        -- wall clock, read at UTC
  m.start_date_utc,                                    -- the true instant
  (m.start_date at time zone 'UTC') as start_local,    -- the wall clock, as a plain timestamp
  m.max_player_count,
  m.player_count,
  m.city_name
from public.mdapi_match_players mp
join public.mdapi_matches m on m.api_id = mp.match_api_id
where mp.is_cancelled = false
  and mp.refunded is not true
  and mp.paid_status <> 'WAITING'
  and mp.deleted_at is null
  and mp.user_id is not null
  and m.is_cancelled = false
  and m.deleted_at is null;

-- ── 2. PER-PLAYER PLAY HISTORY ─────────────────────────────────────────────────────────────────
-- PLAYED MEANS A MATCH THAT HAS ALREADY KICKED OFF. "Has this signup ever actually turned up" is
-- the question; counting a booking for next Tuesday as a play answers a different one. That is a
-- question about an instant, so it reads start_date_utc.
create or replace view public.player_play_stats
with (security_invoker = true) as
select
  s.user_id,
  count(*)::int             as plays,
  max(s.start_date_utc)     as last_played,
  min(s.start_date_utc)     as first_played
from public.player_spots s
where s.start_date_utc < now()
group by s.user_id;

-- ── 3. THE ROW THE FINDER PAGES ────────────────────────────────────────────────────────────────
-- Users LEFT JOINed to their play history, so "never played" is plays = 0 rather than a NOT IN over
-- 15,000 ids. Filtering, ordering, the OFFSET and the count all happen against this view, so a page
-- is a page and the count is a real count whatever the filters are.
--
-- security_invoker: the view resolves RLS as the CALLER, not as its owner. Without it a view is a
-- hole straight through row-level security.
create or replace view public.player_finder_rows
with (security_invoker = true) as
select
  u.id,
  u.email,
  u.first_name,
  u.last_name,
  u.phone_number,
  u.created_at,
  u.preferable_city_name,
  u.is_member,
  coalesce(ps.plays, 0)::int as plays,
  ps.last_played,
  -- Denormalised for the free-text search: PostgREST can .ilike() one column but cannot express
  -- "name OR email OR phone OR id" across four without an .or() that re-states the escaping rules
  -- at every call site — and one missed escape there is an injection surface.
  lower(coalesce(u.first_name, '') || ' ' || coalesce(u.last_name, '') || ' ' ||
        coalesce(u.email, '') || ' ' || coalesce(u.phone_number, '') || ' ' ||
        u.id::text) as search_blob
from public.mdapi_users u
left join public.player_play_stats ps on ps.user_id = u.id
where u.is_fake_player is not true;

-- ── 4. OCCUPANCY, FOR A SET OF PLAYERS IN A WINDOW ─────────────────────────────────────────────
-- The field question: "how many spots did these players occupy in August, and how full were those
-- matches". It is a MATCH-grain answer about a PLAYER-grain selection, so it cannot come from the
-- rows on screen and it cannot come from the match table alone.
--
-- MATCHES ARE COUNTED DISTINCT. One player in two spots is one match, not two. Capacity is summed
-- over the DISTINCT matches for the same reason — summing per spot would count a 20-player pitch
-- twenty times and make the share meaningless.
--
-- THE WINDOW IS WALL CLOCK. "August" means matches whose local kickoff falls in August, so it reads
-- start_local. start_date_utc would push every match after 7 PM into the next day and the ones on
-- the 31st into September.
create or replace function public.player_finder_occupancy(
  p_search      text default null,
  p_reg_from    timestamptz default null,
  p_reg_to      timestamptz default null,
  p_activity    text default 'any',
  p_city        text default null,
  p_member      text default 'any',
  p_win_from    date default null,   -- inclusive, wall-clock calendar day
  p_win_to      date default null    -- inclusive, wall-clock calendar day
)
returns table (spots bigint, matches bigint, matches_full bigint, capacity bigint)
language sql
stable
security invoker
as $$
  with picked as (
    select r.id
    from public.player_finder_rows r
    where (p_search   is null or r.search_blob like '%' || lower(p_search) || '%')
      and (p_reg_from is null or r.created_at >= p_reg_from)
      and (p_reg_to   is null or r.created_at <= p_reg_to)
      and (p_city     is null or r.preferable_city_name = p_city)
      and (p_member = 'any'
           or (p_member = 'yes' and r.is_member is true)
           or (p_member = 'no'  and r.is_member is not true))
      and (p_activity = 'any'
           or (p_activity = 'never'  and r.plays = 0)
           or (p_activity = 'once'   and r.plays = 1)
           or (p_activity = 'active' and r.last_played >= now() - interval '30 days')
           or (p_activity = 'lapsed' and r.last_played is not null
               and r.last_played < now() - interval '60 days'))
  ),
  held as (
    select s.match_api_id, s.max_player_count, s.player_count
    from public.player_spots s
    join picked p on p.id = s.user_id
    where (p_win_from is null or s.start_local >= p_win_from::timestamp)
      and (p_win_to   is null or s.start_local <  (p_win_to + 1)::timestamp)
  ),
  distinct_matches as (
    select match_api_id, max(max_player_count) as cap, max(player_count) as taken
    from held group by match_api_id
  )
  select
    (select count(*) from held)::bigint                                            as spots,
    (select count(*) from distinct_matches)::bigint                                as matches,
    (select count(*) from distinct_matches where cap > 0 and taken >= cap)::bigint as matches_full,
    (select coalesce(sum(cap), 0) from distinct_matches)::bigint                   as capacity;
$$;

-- ── 5. GRANTS ──────────────────────────────────────────────────────────────────────────────────
-- These do not widen who can reach the data — the route authenticates first and scopes the city
-- server-side. They let the authenticated role read the views at all.
grant select on public.player_spots        to authenticated, service_role;
grant select on public.player_play_stats   to authenticated, service_role;
grant select on public.player_finder_rows  to authenticated, service_role;
grant execute on function public.player_finder_occupancy(text, timestamptz, timestamptz, text, text, text, date, date)
  to authenticated, service_role;

-- ── 6. THE INDEXES THE AGGREGATE NEEDS ─────────────────────────────────────────────────────────
-- Without these, player_play_stats is a sequential scan of 241,889 roster rows on every request.
create index if not exists mdapi_match_players_user_id_idx
  on public.mdapi_match_players (user_id) where deleted_at is null;
create index if not exists mdapi_match_players_match_api_id_idx
  on public.mdapi_match_players (match_api_id) where deleted_at is null;
create index if not exists mdapi_users_preferable_city_name_idx
  on public.mdapi_users (preferable_city_name);
create index if not exists mdapi_users_created_at_idx
  on public.mdapi_users (created_at desc);
