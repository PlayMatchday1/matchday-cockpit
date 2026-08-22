-- PLAYER FINDER: the page stops counting and stops sorting by CASE.
--
-- WHY 0135's PAGE TIMED OUT AND 0135's STATS DID NOT, on the same predicate and the same data.
-- player_finder_stats runs in 1.6s. player_finder_page, called with the same arguments, hit the
-- 8-second statement timeout. The difference was two things stats never had:
--
--   1. `count(*) over ()` — a window function over the WHOLE result set, which forces all 30,245
--      matching rows to be materialised before LIMIT 50 can take any of them. The page carried its
--      own total so that the count and the rows could not come from two different predicates. That
--      was the right instinct and the wrong mechanism: the route reads `players` from the STATS row
--      already, and stats is built on the same player_finder_ids, so the guarantee is kept by the
--      shared predicate rather than by counting twice.
--
--   2. A six-branch CASE in the ORDER BY, so that one function could serve any sort column. No
--      index can serve a CASE expression, so every request sorted 30,245 rows by an expression
--      evaluated per row. NOTHING SENDS A SORT — the finder's table header is not clickable — so
--      this was a general-case cost paid on every request to support a feature that does not exist.
--
-- Now: ORDER BY created_at DESC, id — which mdapi_users_created_at_idx serves directly — and no
-- window function. If a sort control is ever added, it is added deliberately, with its own index
-- and its own measurement, rather than being pre-paid here.
--
-- THE PREDICATE IS UNCHANGED. player_finder_ids is still the only place a filter is expressed, and
-- the page and the stats still both join to it.

drop function if exists public.player_finder_page(text, timestamptz, timestamptz, text, text, date, date, text, text, text, text, int, int);

create or replace function public.player_finder_page(
  p_search    text default null,
  p_reg_from  timestamptz default null,
  p_reg_to    timestamptz default null,
  p_history   text default 'any',
  p_play_mode text default 'any',
  p_play_from date default null,
  p_play_to   date default null,
  p_city      text default null,
  p_member    text default 'any',
  p_limit     int  default 50,
  p_offset    int  default 0
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
  from public.player_finder_rows r
  join public.player_finder_ids(p_search, p_reg_from, p_reg_to, p_history,
                                p_play_mode, p_play_from, p_play_to, p_city, p_member) m
    on m.id = r.id
  -- NEWEST FIRST, with id as the tiebreak. Without a stable tiebreak two pages of a tie repeat
  -- rows, which is invisible until someone exports and finds a duplicate.
  order by r.created_at desc, r.id
  limit greatest(1, least(p_limit, 50000))
  offset greatest(0, p_offset);
$$;

grant execute on function public.player_finder_page(text, timestamptz, timestamptz, text, text, date, date, text, text, int, int)
  to authenticated, service_role;
