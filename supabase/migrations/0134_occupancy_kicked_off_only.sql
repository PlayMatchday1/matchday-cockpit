-- OCCUPANCY COUNTS MATCHES THAT HAVE KICKED OFF, and only those.
--
-- THE BUG THIS FIXES. player_play_stats counts a play only once the match has started
-- (start_date_utc < now()), but player_spots holds every qualifying spot including FUTURE
-- bookings. So player_finder_occupancy and the `plays` column disagreed about the same person:
-- with ACTIVITY = "never played" — every one of whom has plays = 0 — the function returned
-- 35 spots across 16 matches. Those are next week's bookings, not spots anybody occupied.
--
-- Left alone it also makes the "all time" tiles wrong in a way nobody would question: "spots
-- occupied" would include matches that have not happened, and "matches full" would mix a played
-- match against a pending one that is merely sold out.
--
-- ONE DEFINITION, STATED: a spot is occupied when the match it sits in has started. That is the
-- same test `plays` uses, so the two can no longer disagree. A booking for next Tuesday is a
-- booking; it becomes occupancy on Tuesday.
--
-- STILL THE INSTANT COLUMN for "has it started" (start_date_utc) and STILL the wall-clock column
-- for "which month was it in" (start_local). Those are different questions and 0133 documents why.

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
    -- THE FIX: only matches that have actually kicked off.
    where s.start_date_utc < now()
      and (p_win_from is null or s.start_local >= p_win_from::timestamp)
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

grant execute on function public.player_finder_occupancy(text, timestamptz, timestamptz, text, text, text, date, date)
  to authenticated, service_role;
