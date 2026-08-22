-- PLAYED BECOMES A REAL WINDOW, AND THE ROWS AND THE TILES SHARE ONE PREDICATE.
--
-- WHAT WAS WRONG. "Played in" was a month select that drove only the occupancy tiles. The rows
-- ignored it, so the band could describe a different set of people than the table underneath it —
-- the same class of disagreement 0134 exists to prevent, one level up.
--
-- WHY THIS CANNOT STAY IN POSTGREST. "Played between 1 and 14 August" is an EXISTS over that
-- player's spots. It is NOT derivable from `last_played`: someone whose most recent match is in
-- September may still have played inside August, and a `last_played BETWEEN` test silently drops
-- them. The presets happen to be expressible (`last_played >= cutoff` is exactly "played within the
-- last N days") but an arbitrary range is not, and two code paths for one control is how the two
-- halves of a screen come to disagree.
--
-- SO THERE IS ONE PREDICATE — player_finder_ids — and both the page and the stats read it. Nothing
-- else may filter. If a filter is not in that function it does not exist.
--
-- IT ALSO COLLAPSES THE ROUTE'S QUERY COUNT from about twenty to two: the page and every tile,
-- including the ten per-city counts, now come back in a single round trip each.

-- ── 1. THE ONE PREDICATE ───────────────────────────────────────────────────────────────────────
create or replace function public.player_finder_ids(
  p_search    text default null,
  p_reg_from  timestamptz default null,
  p_reg_to    timestamptz default null,
  p_history   text default 'any',      -- any | never | once | multi
  p_play_mode text default 'any',      -- any | window | lapsed
  p_play_from date default null,       -- inclusive wall-clock day, null = open
  p_play_to   date default null,       -- inclusive wall-clock day, null = open
  p_city      text default null,
  p_member    text default 'any'       -- any | yes | no
)
returns table (id bigint)
language sql
stable
security invoker
as $$
  select r.id::bigint
  from public.player_finder_rows r
  where (p_search   is null or r.search_blob like '%' || lower(p_search) || '%')
    and (p_reg_from is null or r.created_at >= p_reg_from)
    and (p_reg_to   is null or r.created_at <= p_reg_to)
    and (p_city     is null or r.preferable_city_name = p_city)
    and (p_member = 'any'
         or (p_member = 'yes' and r.is_member is true)
         or (p_member = 'no'  and r.is_member is not true))
    and (p_history = 'any'
         or (p_history = 'never' and r.plays = 0)
         or (p_history = 'once'  and r.plays = 1)
         or (p_history = 'multi' and r.plays >= 2))
    /* HISTORY = never played AND a play window cannot both be true, so the window is IGNORED rather
     * than intersected to nothing. The UI disables the row and says why; this is the server saying
     * the same thing, because a disabled control is a courtesy and this is the rule. */
    and (p_history = 'never' or p_play_mode = 'any'
         or (p_play_mode = 'lapsed'
             and r.plays >= 1
             and r.last_played < now() - interval '60 days')
         or (p_play_mode = 'window' and exists (
               select 1 from public.player_spots s
               where s.user_id = r.id
                 and s.start_date_utc < now()          -- a booking is not a play
                 and (p_play_from is null or s.start_local >= p_play_from::timestamp)
                 and (p_play_to   is null or s.start_local <  (p_play_to + 1)::timestamp))));
$$;

-- ── 2. THE PAGE ────────────────────────────────────────────────────────────────────────────────
-- The total rides along as a window function, so the count and the rows can never be taken from
-- two different predicates or two different moments.
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
  p_sort      text default 'registered',
  p_dir       text default 'desc',
  p_limit     int  default 50,
  p_offset    int  default 0
)
returns table (
  id bigint, email text, first_name text, last_name text, phone_number text,
  created_at timestamptz, preferable_city_name text, is_member boolean,
  plays int, last_played timestamptz, total bigint
)
language sql
stable
security invoker
as $$
  with picked as (
    select r.*
    from public.player_finder_rows r
    join public.player_finder_ids(p_search, p_reg_from, p_reg_to, p_history,
                                  p_play_mode, p_play_from, p_play_to, p_city, p_member) m
      on m.id = r.id
  )
  select
    p.id::bigint, p.email::text, p.first_name::text, p.last_name::text, p.phone_number::text,
    p.created_at::timestamptz, p.preferable_city_name::text, p.is_member::boolean,
    p.plays::int, p.last_played::timestamptz,
    count(*) over ()::bigint as total
  from picked p
  order by
    -- A STABLE TIEBREAK ON EVERY BRANCH. Without one, two pages of an unordered tie repeat rows.
    case when p_dir = 'asc' then
      case p_sort when 'id' then p.id::text when 'name' then lower(coalesce(p.first_name,''))
                  when 'email' then lower(coalesce(p.email,'')) when 'city' then coalesce(p.preferable_city_name,'')
                  else null end
    end asc nulls last,
    case when p_dir <> 'asc' then
      case p_sort when 'id' then p.id::text when 'name' then lower(coalesce(p.first_name,''))
                  when 'email' then lower(coalesce(p.email,'')) when 'city' then coalesce(p.preferable_city_name,'')
                  else null end
    end desc nulls last,
    case when p_sort = 'last_match' and p_dir = 'asc' then p.last_played end asc nulls last,
    case when p_sort = 'last_match' and p_dir <> 'asc' then p.last_played end desc nulls last,
    case when p_sort not in ('id','name','email','city','last_match') and p_dir = 'asc' then p.created_at end asc,
    case when p_sort not in ('id','name','email','city','last_match') and p_dir <> 'asc' then p.created_at end desc,
    p.id
  limit greatest(1, least(p_limit, 50000))
  offset greatest(0, p_offset);
$$;

-- ── 3. EVERY TILE, IN ONE ROW ──────────────────────────────────────────────────────────────────
-- Occupancy reads THE SAME WINDOW the rows were filtered by. That is the whole point of the change:
-- one window, so the band and the table are describing the same people over the same days.
--
-- WITH p_play_mode = 'lapsed' THE OCCUPANCY COLUMNS COME BACK NULL, not zero. A negation has no
-- window to total, and a figure labelled "the last 60 days" for people defined by NOT playing in
-- them would be lying about its own scope. The route drops the tiles on null; it does not print 0.
create or replace function public.player_finder_stats(
  p_search    text default null,
  p_reg_from  timestamptz default null,
  p_reg_to    timestamptz default null,
  p_history   text default 'any',
  p_play_mode text default 'any',
  p_play_from date default null,
  p_play_to   date default null,
  p_city      text default null,
  p_member    text default 'any'
)
returns table (
  players bigint, never bigint, members bigint, week bigint, month30 bigint,
  heavy bigint, named bigint, cities bigint, top_city text, top_city_n bigint,
  median_age_days int, newest timestamptz,
  spots bigint, matches bigint, matches_full bigint, capacity bigint
)
language sql
stable
security invoker
as $$
  with ids as (
    select m.id from public.player_finder_ids(p_search, p_reg_from, p_reg_to, p_history,
                                              p_play_mode, p_play_from, p_play_to, p_city, p_member) m
  ),
  picked as (
    select r.* from public.player_finder_rows r join ids on ids.id = r.id
  ),
  by_city as (
    select coalesce(preferable_city_name, 'Not set') as city, count(*)::bigint as n
    from picked group by 1 order by n desc
  ),
  held as (
    -- ONLY WHEN THERE IS A WINDOW TO TOTAL. 'lapsed' selects nothing here, which is what makes the
    -- occupancy columns null rather than a confident zero.
    select s.match_api_id, s.max_player_count as cap, s.player_count as taken
    from public.player_spots s
    join ids on ids.id = s.user_id
    where p_play_mode <> 'lapsed'
      and s.start_date_utc < now()
      and (p_play_from is null or s.start_local >= p_play_from::timestamp)
      and (p_play_to   is null or s.start_local <  (p_play_to + 1)::timestamp)
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
    case when p_play_mode = 'lapsed' then null else (select coalesce(sum(cap), 0) from dm)::bigint end;
$$;

grant execute on function public.player_finder_ids(text, timestamptz, timestamptz, text, text, date, date, text, text) to authenticated, service_role;
grant execute on function public.player_finder_page(text, timestamptz, timestamptz, text, text, date, date, text, text, text, text, int, int) to authenticated, service_role;
grant execute on function public.player_finder_stats(text, timestamptz, timestamptz, text, text, date, date, text, text) to authenticated, service_role;
