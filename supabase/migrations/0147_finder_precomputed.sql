-- 0147 — PLAYER FINDER: precompute the set. Stop recomputing 400,000 rows on every keystroke.
--
-- ══ WHAT EVERY REQUEST DOES TODAY ═════════════════════════════════════════════════════════════
--
-- `player_finder_rows` is a VIEW over a VIEW over a VIEW. One finder request currently:
--
--   1. scans mdapi_match_players (244,000 rows), joins mdapi_matches (9,743), applies six
--      predicates                                                        → player_spots, 151,890
--   2. GROUPs those by user_id                                           → player_play_stats, 30k
--   3. LEFT JOINs 30,663 mdapi_users to it
--   4. builds `search_blob` — five columns concatenated and lowercased — FOR EVERY ROW
--   5. and only then filters, orders, offsets and limits
--
-- All five steps run again for the next request, and again for the one after that. That is why a
-- single user waits 1.4s and why six concurrent users get HTTP 500:
--
--     conc 6, three runs of thirty, on the ROLLED-BACK (0136) function:
--       p50 5,778 / 5,013 / 5,761ms      max 7,092 / 7,835 / 8,325ms
--       run 3: SIX of thirty returned "canceling statement due to statement timeout"
--
-- The 8,000ms statement timeout is not a distant ceiling. The page is already through it.
--
-- ══ THE ACCEPTANCE CRITERION ══════════════════════════════════════════════════════════════════
--
-- "Not slower than baseline" is meaningless when the baseline returns 500s. So:
--
--     ZERO HTTP 500s across three runs of thirty at concurrency 6, and p50 UNDER 2,000ms.
--     Then push the concurrency until it does break, and record where.
--
--     MEASURED AFTER:  (filled in once applied — if this still says TBD, it was not measured)
--       conc 6 run 1  p50 TBD  max TBD  500s TBD
--       conc 6 run 2  p50 TBD  max TBD  500s TBD
--       conc 6 run 3  p50 TBD  max TBD  500s TBD
--       breaks at:    TBD
--
-- ══ WHY MATERIALIZED VIEWS, AND WHY THIS SHAPE ════════════════════════════════════════════════
--
-- This follows 0096's growth pattern exactly rather than inventing one: matviews, a service-role
-- refresh function, plain REFRESH (not CONCURRENTLY — that cannot run inside a transaction and
-- every PostgREST rpc call is one), called best-effort from the sync route.
--
-- AND IT DOES NOT REPEAT 0145'S MISTAKE. 0145 tried to make the match filters cheap by merging
-- them into one grouped pass behind a scalar subquery; the planner cannot fold a parameter, so the
-- guard did not short-circuit and it was 15-20% SLOWER. Here each filter set is 0136's proven
-- shape — a plain `select distinct ... where <guard> and <predicates>` — over an INDEXED TABLE
-- rather than a three-deep view. No scalar subquery. No GROUP BY at query time. The grouping
-- happens once, at refresh, for everyone.
--
-- ══ THE THING A TABLE CAN DO THAT A VIEW CANNOT: GO STALE ═════════════════════════════════════
--
-- A view is always right and slow. A table can be fast and CONFIDENTLY WRONG, which is worse. So
-- `player_finder_refresh` records when the set was last rebuilt, `player_finder_freshness()`
-- compares that to the newest mdapi_matches.synced_at, and the page SAYS SO when the set is older
-- than the data it came from — rather than showing a stale count with no marking.
--
-- `plays` and `last_played` are computed at REFRESH time against now(), so they lag by at most one
-- sync cycle. `player_match_mv` deliberately does NOT filter on now(): it holds every qualifying
-- spot and the kicked-off test is applied at QUERY time against an indexed column, so the passage
-- of time alone never makes the match filters stale. Only the play COUNTS lag, and the banner says
-- when.
--
-- Apply in the Supabase SQL editor. ~150k rows build in a second or two.

begin;

-- ── 0a. THE SPOT'S OWN KEY, SO THE MATVIEW CAN BE UNIQUE ON SOMETHING TRUE ────────────────────
--
-- 0147 FAILED THE FIRST TIME on `unique (user_id, match_api_id)`: (2183, 15323) is duplicated.
-- Blake paid $24 for himself and brought a guest, and THE GUEST IS RECORDED UNDER HIS user_id —
-- one row user_type PLAYER, one GUEST, both is_cancelled=false, refunded=false, paid_status=PAID,
-- deleted_at=null. Nothing should have excluded either; the predicate is right and the INDEX was
-- wrong.
--
-- MEASURED, because one is an anecdote: **6,059 duplicate (user_id, match_api_id) pairs, 8,991
-- extra rows, 2,084 distinct players**, one of whom holds 18 spots in a single match. Across all
-- 151,890 qualifying spots: PLAYER 143,010 · GUEST 7,593 · ADDITIONAL_SPOT 1,287 — and
-- 7,593 + 1,287 = 8,880 against 8,991 extra rows. That is the mechanism, at scale.
--
-- SO THE VIEW STAYS SPOT-GRAINED and the unique key becomes the SPOT's own api_id. Deduping the
-- view instead would have broken occupancy: player_finder_stats counts `spots` from it, and those
-- 8,991 guest and additional-spot rows are real bodies on a pitch. The match FILTERS never cared —
-- they say `select distinct user_id` and dedupe at query time.
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
  m.field_id,
  m.field_title,
  mp.api_id as spot_api_id                             -- NEW: the spot's own key, appended
from public.mdapi_match_players mp
join public.mdapi_matches m on m.api_id = mp.match_api_id
where mp.is_cancelled = false
  and mp.refunded is not true
  and mp.paid_status <> 'WAITING'
  and mp.deleted_at is null
  and mp.user_id is not null
  and m.is_cancelled = false
  and m.deleted_at is null;

-- ── 0b. "PLAYED" MEANS MATCHES, NOT SPOTS ────────────────────────────────────────────────────
--
-- THE SAME DUPLICATE EXPOSED A REAL BUG THAT HAS BEEN LIVE SINCE 0133. `plays` was count(*) over
-- spots, so a player who brought a guest to ONE match read as having played TWO. The History
-- filter and its tile have been wrong for every one of them.
--
-- MEASURED: **343 players move from "Played 2+" to "Played once"**. Played once 5,831 → 6,174;
-- Played 2+ 8,963 → 8,620 (those figures count fake players, which the finder excludes; the tile
-- on the page reads 8,731 and will drop by the same shape).
--
-- This is a VISIBLE change to a number people watch, so the verdict query below prints the old and
-- the new count side by side, and a change_log entry says why the tile moved.
create or replace view public.player_play_stats
with (security_invoker = true) as
select
  s.user_id,
  count(distinct s.match_api_id)::int as plays,       -- WAS count(*) — spots, not matches
  max(s.start_date_utc)               as last_played,
  min(s.start_date_utc)               as first_played
from public.player_spots s
where s.start_date_utc < now()
group by s.user_id;

-- ── 1. ONE ROW PER PLAYER ─────────────────────────────────────────────────────────────────────
-- Exactly what player_finder_rows computes, computed ONCE. The view stays (nothing else has to
-- change to read it) but the finder no longer touches it.
drop materialized view if exists public.player_finder_mv cascade;
create materialized view public.player_finder_mv as
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
  lower(coalesce(u.first_name, '') || ' ' || coalesce(u.last_name, '') || ' ' ||
        coalesce(u.email, '') || ' ' || coalesce(u.phone_number, '') || ' ' ||
        u.id::text) as search_blob
from public.mdapi_users u
left join public.player_play_stats ps on ps.user_id = u.id
where u.is_fake_player is not true;

-- The ORDER BY the page actually uses (created_at desc, id) — 0137 chose it precisely so an index
-- could serve it, and here one does.
create unique index player_finder_mv_id_idx        on public.player_finder_mv (id);
create index        player_finder_mv_created_idx   on public.player_finder_mv (created_at desc, id);
create index        player_finder_mv_city_idx      on public.player_finder_mv (preferable_city_name);
create index        player_finder_mv_plays_idx     on public.player_finder_mv (plays);
create index        player_finder_mv_lastplay_idx  on public.player_finder_mv (last_played);

-- ── 2. ONE ROW PER QUALIFYING SPOT ────────────────────────────────────────────────────────────
-- NOT time-filtered, deliberately (see the header): the kicked-off test is a query-time predicate
-- on start_utc so that the passage of time cannot stale this view. match_date and kick_time are
-- WALL CLOCK, derived from start_local, which is the hour on the pitch.
drop materialized view if exists public.player_match_mv cascade;
create materialized view public.player_match_mv as
select
  s.spot_api_id,
  s.user_id,
  s.match_api_id,
  s.city_name,
  s.field_id,
  s.field_title,
  (s.start_local)::date      as match_date,
  (s.start_local)::time      as kick_time,
  s.start_date_utc           as start_utc
from public.player_spots s;

-- UNIQUE ON THE SPOT, not on (user, match) — see 0a. A plain column, so REFRESH CONCURRENTLY
-- stays available if the lock measurement calls for it.
create unique index player_match_mv_pk_idx     on public.player_match_mv (spot_api_id);
create index        player_match_mv_user_idx   on public.player_match_mv (user_id, match_api_id);
create index        player_match_mv_field_idx  on public.player_match_mv (field_id, start_utc);
create index        player_match_mv_city_idx   on public.player_match_mv (city_name, start_utc);
create index        player_match_mv_date_idx   on public.player_match_mv (match_date);
create index        player_match_mv_kick_idx   on public.player_match_mv (kick_time);
create index        player_match_mv_utc_idx    on public.player_match_mv (start_utc);

-- ── 3. WHEN WAS THIS BUILT ────────────────────────────────────────────────────────────────────
create table if not exists public.player_finder_refresh (
  only_row     boolean primary key default true check (only_row),
  refreshed_at timestamptz not null default now()
);
-- ON CONFLICT UPDATE, not DO NOTHING: re-applying this migration rebuilds the matviews, so the
-- stamp has to move with them or the page would report a fresh set as stale.
insert into public.player_finder_refresh (only_row) values (true)
  on conflict (only_row) do update set refreshed_at = now();

create or replace function public.refresh_player_finder_views() returns void language plpgsql as $$
begin
  refresh materialized view public.player_finder_mv;
  refresh materialized view public.player_match_mv;
  update public.player_finder_refresh set refreshed_at = now();
end $$;
revoke execute on function public.refresh_player_finder_views() from anon, authenticated, public;
grant  execute on function public.refresh_player_finder_views() to service_role;

/* THE STALENESS ANSWER, IN ONE CALL. `stale` is true when the set was built before the newest
 * match row arrived — i.e. a sync landed and the refresh did not follow it. The page prints this
 * instead of showing counts that look current. */
create or replace function public.player_finder_freshness()
returns table (refreshed_at timestamptz, source_synced_at timestamptz, stale boolean)
language sql stable security invoker as $$
  select r.refreshed_at,
         (select max(m.synced_at) from public.mdapi_matches m) as source_synced_at,
         r.refreshed_at < (select max(m.synced_at) from public.mdapi_matches m) as stale
  from public.player_finder_refresh r;
$$;
grant execute on function public.player_finder_freshness() to service_role;

revoke all on public.player_finder_mv, public.player_match_mv from anon, authenticated;
grant select on public.player_finder_mv, public.player_match_mv to service_role;

-- ── 4. THE PREDICATE, READING THE PRECOMPUTED SET ─────────────────────────────────────────────
-- DROP THEN CREATE, not CREATE OR REPLACE: the signature changes, and a 9-arg call would otherwise
-- match both the old and the new through defaults ("function is not unique" — see 0146).
drop function if exists public.player_finder_ids(
  text, timestamptz, timestamptz, text, text, date, date, text, text);

create function public.player_finder_ids(
  p_search      text        default null,
  p_reg_from    timestamptz default null,
  p_reg_to      timestamptz default null,
  p_history     text        default 'any',
  p_play_mode   text        default 'any',
  p_play_from   date        default null,
  p_play_to     date        default null,
  p_city        text        default null,   -- HOME city (preferable_city_name)
  p_member      text        default 'any',
  p_city_unset  boolean     default false,  -- home city IS NULL — the 4,010 a city filter drops
  p_match_city  text        default null,   -- city of the matches played
  p_field_id    bigint      default null,
  p_kick_from   time        default null,
  p_kick_to     time        default null,
  p_match_from  date        default null,
  p_match_to    date        default null
)
returns table (id bigint)
language sql
stable
security invoker
as $$
  /* TWO CTEs OF THE SAME PROVEN SHAPE (0136), each guarded, each over an INDEXED table. NOT one
   * merged grouped pass behind a scalar subquery — that was 0145 and it was slower. */
  with win as (
    select distinct m.user_id
    from public.player_match_mv m
    where p_play_mode = 'window'
      and m.start_utc < now()                          -- a booking is not a play (0134)
      and (p_play_from is null or m.match_date >= p_play_from)
      and (p_play_to   is null or m.match_date <= p_play_to)
  ),
  matched as (
    select distinct m.user_id
    from public.player_match_mv m
    where (p_match_city is not null or p_field_id is not null or p_kick_from is not null
           or p_kick_to is not null or p_match_from is not null or p_match_to is not null)
      and m.start_utc < now()
      and (p_match_city is null or m.city_name  = p_match_city)
      and (p_field_id   is null or m.field_id   = p_field_id)
      and (p_kick_from  is null or m.kick_time >= p_kick_from)
      and (p_kick_to    is null or m.kick_time <= p_kick_to)
      and (p_match_from is null or m.match_date >= p_match_from)
      and (p_match_to   is null or m.match_date <= p_match_to)
  )
  select r.id::bigint
  from public.player_finder_mv r
  where (p_search   is null or r.search_blob like '%' || lower(p_search) || '%')
    and (p_reg_from is null or r.created_at >= p_reg_from)
    and (p_reg_to   is null or r.created_at <= p_reg_to)
    and (p_city_unset or p_city is null or r.preferable_city_name = p_city)
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
         or (p_play_mode = 'window' and r.id in (select user_id from win)))
    /* A player who never played cannot match a match filter, so "never played" + a match filter is
     * genuinely empty — unlike the window above, where the two controls contradict. */
    and (not (p_match_city is not null or p_field_id is not null or p_kick_from is not null
              or p_kick_to is not null or p_match_from is not null or p_match_to is not null)
         or r.id in (select user_id from matched));
$$;
grant execute on function public.player_finder_ids(
  text, timestamptz, timestamptz, text, text, date, date, text, text,
  boolean, text, bigint, time, time, date, date) to authenticated, service_role;

-- ── 5. THE PAGE AND THE STATS, CARRYING THE NEW PARAMETERS ────────────────────────────────────
-- Both here, in THIS migration, so there is no third one. Both read player_finder_mv instead of
-- player_finder_rows — otherwise the predicate would be fast and the projection would still drag
-- the three-deep view behind it, which is most of the cost.
--
-- DROP THEN CREATE for the same reason as the predicate: the signatures change and a call with the
-- old argument count would match both through defaults.

drop function if exists public.player_finder_page(
  text, timestamptz, timestamptz, text, text, date, date, text, text, int, int);

create function public.player_finder_page(
  p_search      text        default null,
  p_reg_from    timestamptz default null,
  p_reg_to      timestamptz default null,
  p_history     text        default 'any',
  p_play_mode   text        default 'any',
  p_play_from   date        default null,
  p_play_to     date        default null,
  p_city        text        default null,
  p_member      text        default 'any',
  p_limit       int         default 50,
  p_offset      int         default 0,
  p_city_unset  boolean     default false,
  p_match_city  text        default null,
  p_field_id    bigint      default null,
  p_kick_from   time        default null,
  p_kick_to     time        default null,
  p_match_from  date        default null,
  p_match_to    date        default null
)
returns table (
  id bigint, email text, first_name text, last_name text, phone_number text,
  created_at timestamptz, preferable_city_name text, is_member boolean,
  plays int, last_played timestamptz
)
language sql
stable
security invoker
as $$
  select
    r.id::bigint, r.email::text, r.first_name::text, r.last_name::text, r.phone_number::text,
    r.created_at::timestamptz, r.preferable_city_name::text, r.is_member::boolean,
    r.plays::int, r.last_played::timestamptz
  from public.player_finder_mv r
  join public.player_finder_ids(p_search, p_reg_from, p_reg_to, p_history,
                                p_play_mode, p_play_from, p_play_to, p_city, p_member,
                                p_city_unset, p_match_city, p_field_id, p_kick_from, p_kick_to,
                                p_match_from, p_match_to) m
    on m.id = r.id
  -- NEWEST FIRST, with id as the tiebreak. Without a stable tiebreak two pages of a tie repeat
  -- rows, which is invisible until someone exports and finds a duplicate.
  order by r.created_at desc, r.id
  limit greatest(1, least(p_limit, 50000))
  offset greatest(0, p_offset);
$$;
grant execute on function public.player_finder_page(
  text, timestamptz, timestamptz, text, text, date, date, text, text, int, int,
  boolean, text, bigint, time, time, date, date) to authenticated, service_role;

drop function if exists public.player_finder_stats(
  text, timestamptz, timestamptz, text, text, date, date, text, text);

create function public.player_finder_stats(
  p_search      text        default null,
  p_reg_from    timestamptz default null,
  p_reg_to      timestamptz default null,
  p_history     text        default 'any',
  p_play_mode   text        default 'any',
  p_play_from   date        default null,
  p_play_to     date        default null,
  p_city        text        default null,
  p_member      text        default 'any',
  p_city_unset  boolean     default false,
  p_match_city  text        default null,
  p_field_id    bigint      default null,
  p_kick_from   time        default null,
  p_kick_to     time        default null,
  p_match_from  date        default null,
  p_match_to    date        default null
)
returns table (
  players bigint, never bigint, members bigint, week bigint, month30 bigint,
  heavy bigint, named bigint, cities bigint, top_city text, top_city_n bigint,
  median_age_days int, newest timestamptz,
  spots bigint, matches bigint, matches_full bigint, capacity bigint,
  no_home_city bigint
)
language sql
stable
security invoker
as $$
  with ids as (
    select m.id from public.player_finder_ids(p_search, p_reg_from, p_reg_to, p_history,
                                              p_play_mode, p_play_from, p_play_to, p_city, p_member,
                                              p_city_unset, p_match_city, p_field_id, p_kick_from,
                                              p_kick_to, p_match_from, p_match_to) m
  ),
  picked as (
    select r.* from public.player_finder_mv r join ids on ids.id = r.id
  ),
  by_city as (
    select coalesce(preferable_city_name, 'Not set') as city, count(*)::bigint as n
    from picked group by 1 order by n desc
  ),
  held as (
    -- ONLY WHEN THERE IS A WINDOW TO TOTAL. 'lapsed' selects nothing here, which is what makes the
    -- occupancy columns null rather than a confident zero. Reads the matview, and the occupancy
    -- numbers come from mdapi_matches directly since the spot view no longer carries them.
    select s.match_api_id, mm.max_player_count as cap, mm.player_count as taken
    from public.player_match_mv s
    join ids on ids.id = s.user_id
    join public.mdapi_matches mm on mm.api_id = s.match_api_id
    where p_play_mode <> 'lapsed'
      and s.start_utc < now()
      and (p_play_from is null or s.match_date >= p_play_from)
      and (p_play_to   is null or s.match_date <= p_play_to)
  ),
  dm as (
    select match_api_id, max(cap) as cap, max(taken) as taken from held group by match_api_id
  )
  select
    (select count(*) from picked)::bigint,
    (select count(*) from picked where plays = 0)::bigint,
    (select count(*) from picked where is_member is true)::bigint,
    (select count(*) from picked where created_at >= now() - interval '7 days')::bigint,
    (select count(*) from picked where created_at >= now() - interval '30 days')::bigint,
    (select count(*) from picked where plays >= 2)::bigint,
    (select count(*) from picked where first_name is not null and first_name <> '')::bigint,
    (select count(*) from by_city)::bigint,
    (select city from by_city limit 1)::text,
    (select n from by_city limit 1)::bigint,
    (select extract(day from now() - percentile_disc(0.5) within group (order by created_at))::int from picked),
    (select max(created_at) from picked)::timestamptz,
    case when p_play_mode = 'lapsed' then null else (select count(*) from held)::bigint end,
    case when p_play_mode = 'lapsed' then null else (select count(*) from dm)::bigint end,
    case when p_play_mode = 'lapsed' then null else (select count(*) from dm where cap > 0 and taken >= cap)::bigint end,
    case when p_play_mode = 'lapsed' then null else (select coalesce(sum(cap), 0) from dm)::bigint end,
    /* NEW — the count the page prints beside HOME CITY so "= Austin" cannot silently drop people.
     * Counted over the WHOLE estate, not the current selection: it answers "how many are
     * unreachable by this control", which does not change with the other filters. */
    (select count(*) from public.player_finder_mv where preferable_city_name is null)::bigint;
$$;
grant execute on function public.player_finder_stats(
  text, timestamptz, timestamptz, text, text, date, date, text, text,
  boolean, text, bigint, time, time, date, date) to authenticated, service_role;

commit;

-- VERDICT — ONE query, ONE row. The SQL editor shows only the last result set.
--   Expected:  mv_players 30455 | mv_spots 151890 | ids_unfiltered 30455 | ids_field_892 693
--              ids_unset 4010 | overloads 1 | stale f | no_home_city 4010
--              once_old 5831 | once_new 6174 | multi_old 8963 | multi_new 8620
--
-- THE BUCKET SHIFT IS ON THE RECORD HERE, not discovered later. once_old/multi_old are the
-- SPOTS-based counts this migration retires; once_new/multi_new are the MATCHES-based counts it
-- installs. **343 players move from Played 2+ to Played once** — they brought guests, and each
-- guest was being counted as another match they played. The page tile reads 8,731 rather than
-- 8,963 because the finder excludes fake players and these raw counts do not; it drops by the
-- same 343 shape.
--
-- THREE COLUMNS CARRY THE INTENT:
--   ids_unfiltered  must be 30455 — the precomputed set must return exactly what the views did.
--   ids_field_892   must be 693 — the same number 0145's verdict returned for ATH Katy, from a
--                   completely different mechanism. Two derivations agreeing is the check.
--   stale           must be FALSE right after applying. True means the refresh did not run.
select
  (select count(*) from public.player_finder_mv)                              as mv_players,
  (select count(*) from public.player_match_mv)                               as mv_spots,
  (select count(*) from public.player_finder_ids())                           as ids_unfiltered,
  (select count(*) from public.player_finder_ids(p_field_id => 892))          as ids_field_892,
  (select count(*) from public.player_finder_ids(p_city_unset => true))       as ids_unset,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'player_finder_ids')          as overloads,
  (select stale from public.player_finder_freshness())                        as stale,
  (select no_home_city from public.player_finder_stats())                     as no_home_city,
  /* THE OLD, SPOTS-BASED BUCKETS — computed here from the raw spots so the before and after sit in
   * one row. Excludes fake players, matching what the finder counts. */
  (select count(*) from (
     select s.user_id from public.player_spots s
     join public.mdapi_users u on u.id = s.user_id and u.is_fake_player is not true
     where s.start_date_utc < now()
     group by s.user_id having count(*) = 1) q)                               as once_old,
  (select count(*) from public.player_finder_mv where plays = 1)              as once_new,
  (select count(*) from (
     select s.user_id from public.player_spots s
     join public.mdapi_users u on u.id = s.user_id and u.is_fake_player is not true
     where s.start_date_utc < now()
     group by s.user_id having count(*) >= 2) q)                              as multi_old,
  (select count(*) from public.player_finder_mv where plays >= 2)             as multi_new;

-- ROLLBACK: also re-run 0133's player_spots and player_play_stats — this migration changed both
-- (spot_api_id, and plays counting matches). Then drop the two matviews and the refresh plumbing,
-- then re-run 0146's create for the
-- 9-arg player_finder_ids, 0137's for player_finder_page and 0135's for player_finder_stats. All
-- three signatures change here, so all three come back together — dropping only the matviews would
-- leave three functions selecting from objects that no longer exist.
