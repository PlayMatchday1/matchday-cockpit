-- 0188 — THE CONFINED BOUNDARY BECOMES A UNION: home city OR a played match in the city.
--
-- ══ WHAT IS WRONG TODAY ═══════════════════════════════════════════════════════════════════════
--
-- 0147 line 281 is the whole boundary:
--
--     and (p_city_unset or p_city is null or r.preferable_city_name = p_city)
--
-- and p_city is the HOME CITY filter. The finder route pushed a confined account's city into it,
-- so "what a Warsaw operator may see" and "filter the list to home-city Warsaw" were the same
-- parameter and could not be told apart.
--
-- MEASURED ON PRODUCTION 2026-09-19. Two real players have played in Warsaw and named another
-- city: Junior Mafunga (88519, home Austin, two matches at Hala Pilkarska Bemowo) and Sulav Lama
-- (88512, home New York City, two matches). Both carry +48 Polish mobiles, and neither has ever
-- played a match in the city they named. Both were invisible to the Warsaw account.
--
-- ══ THE RULE ══════════════════════════════════════════════════════════════════════════════════
--
--     a confined account may see a player whose home city is its city
--     OR who has played at least one non-cancelled match in its city.
--
-- IT IS A UNION AND NOT AN INTERSECTION, and that is the entire point. The finder once ANDed these
-- two and lost every Warsaw signup who had registered but not yet played; the route still carries
-- the note. OR keeps them AND adds the travellers.
--
-- ══ A THIRD CITY PARAMETER, AND WHY IT IS NOT EITHER OF THE OTHER TWO ═════════════════════════
--
--     p_city        the operator's HOME-CITY filter        they choose it
--     p_match_city  the operator's PLAYED-AT filter        they choose it
--     p_scope_city  the boundary                           their account decides, never the query
--
-- p_match_city IS NOT THE MECHANISM. Setting it from the session is exactly the bug that cost
-- Warsaw its never-played signups: it intersects rather than unions, and it silently commandeers a
-- control the operator is meant to drive. It keeps defaulting to null.
--
-- ══ NO TIME FILTER ON THE BOUNDARY, DELIBERATELY ══════════════════════════════════════════════
--
-- `win` and `matched` below both carry `m.start_utc < now()`, because a booking is not a play
-- (0134) and those two answer "has this person turned up". THE BOUNDARY ANSWERS A DIFFERENT
-- QUESTION: may this operator see this person at all. Someone booked into a Warsaw match next
-- Tuesday is precisely who a new market needs to reach, and hiding them until kickoff would be a
-- support gap. player_match_mv already holds only qualifying spots — not cancelled, not refunded,
-- not WAITING, not deleted, on a match that is itself neither cancelled nor deleted — so
-- membership of it IS "a non-cancelled match in this city".
--
-- ══ THE INDEX ═════════════════════════════════════════════════════════════════════════════════
--
-- player_match_mv is indexed (city_name, start_utc). The boundary goes from a city to the SET OF
-- USER IDS that played there and never touches start_utc, so that index makes it read every
-- matching row to project a column it does not carry. (city_name, user_id) is index-only for this
-- predicate. Added below; see the plan note at the end.
--
-- ══ WHAT THIS DOES TO THE TILE COUNTS ═════════════════════════════════════════════════════════
--
-- A wider boundary raises PLAYERS and every tile derived from the same set. Measured before, and
-- expected after, for the union's real membership:
--
--     Warsaw         124 ->   126      (+2)
--     Austin       13,132 -> 13,310  (+178)
--     Houston       6,301 ->  6,461  (+160)
--     San Antonio   3,572 ->  3,702  (+130)
--     Atlanta       1,534 ->  1,553   (+19)
--     Dallas/FW     1,944 ->  1,985   (+41)
--     St. Louis       892 ->    910   (+18)
--     Oklahoma City   527 ->    540   (+13)
--
-- NEVER PLAYED does NOT move: every player the union adds has match history by definition, so they
-- all land in the played buckets. Only Warsaw's two are reachable by a confined operator today —
-- the other five confined accounts are city managers with can_access_matchops = false and never
-- open this page.
--
-- UNCONFINED CALLERS ARE UNAFFECTED. p_scope_city defaults to null and the predicate short-circuits
-- on it, so every existing call site sees byte-identical results.
--
-- ══ THE EIGHT TEST ACCOUNTS ═══════════════════════════════════════════════════════════════════
--
-- ids 62408-62416, 201@matchday.com through 209@matchday.com, phone +15555555555, home Atlanta and
-- New York City, ALL WITH WARSAW MATCH HISTORY. They carry is_fake_player = FALSE, so
-- player_finder_mv does NOT exclude them and the union would hand all eight to the Warsaw operator.
--
-- SO THE BOUNDARY'S PLAYED-IN BRANCH EXCLUDES @matchday.com. Measured: 210 such accounts exist, 200
-- flagged and 10 not; of the 10, nine are home-Atlanta and one home-New York City, so NONE is home
-- to any city and this exclusion changes no existing count. The pattern is anchored `@matchday.com$`
-- exactly as isFakePlayerEmail is, because company staff are @playmatchday.com — one word longer —
-- and an unanchored LIKE would sweep all 2,081 of them up. Verified: the anchored form matches 0.
--
-- THE HOME-CITY BRANCH IS LEFT ALONE. A synthetic player whose stated city IS the confined city is
-- visible today and stays visible; narrowing that is a separate decision with its own blast radius.
--
-- Apply in the Supabase SQL editor.

begin;

-- ── 1. THE INDEX THE BOUNDARY WANTS ───────────────────────────────────────────────────────────
-- Not CONCURRENTLY: it cannot run inside a transaction, and this matview is rebuilt by the sync
-- anyway. The build is a few hundred milliseconds on ~152k rows.
create index if not exists player_match_mv_city_user_idx
  on public.player_match_mv (city_name, user_id);

-- ── 2. THE PREDICATE ──────────────────────────────────────────────────────────────────────────
-- DROP THEN CREATE, not CREATE OR REPLACE: the signature changes, and a call with the old argument
-- count would otherwise match both through defaults ("function is not unique" — 0146 and 0147).
-- The OLD 16-argument signature is named here exactly; if this DROP silently matches nothing, the
-- CREATE below will succeed alongside a stale overload and every call becomes ambiguous.
drop function if exists public.player_finder_ids(
  text, timestamptz, timestamptz, text, text, date, date, text, text,
  boolean, text, bigint, time, time, date, date);

create function public.player_finder_ids(
  p_search      text        default null,
  p_reg_from    timestamptz default null,
  p_reg_to      timestamptz default null,
  p_history     text        default 'any',
  p_play_mode   text        default 'any',
  p_play_from   date        default null,
  p_play_to     date        default null,
  p_city        text        default null,   -- HOME city filter (preferable_city_name)
  p_member      text        default 'any',
  p_city_unset  boolean     default false,  -- home city IS NULL
  p_match_city  text        default null,   -- PLAYED-AT filter, the operator's own control
  p_field_id    bigint      default null,
  p_kick_from   time        default null,
  p_kick_to     time        default null,
  p_match_from  date        default null,
  p_match_to    date        default null,
  -- APPENDED, NOT INSERTED. PostgREST calls these by NAME, so position does not matter to the
  -- caller, and appending leaves all sixteen existing positions undisturbed.
  p_scope_city  text        default null    -- THE CONFINED BOUNDARY. Never from the query string.
)
returns table (id bigint)
language sql
stable
security invoker
as $$
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
  ),
  /* THE BOUNDARY'S SECOND BRANCH. Guarded on p_scope_city so an unconfined call never scans it —
   * the same guard shape `win` and `matched` use, and for the same measured reason (0147: an
   * unguarded CTE cost 424ms -> 8s). NO start_utc HERE, on purpose; see the header. */
  in_scope as (
    select distinct m.user_id
    from public.player_match_mv m
    join public.mdapi_users u on u.id = m.user_id
    where p_scope_city is not null
      and m.city_name = p_scope_city
      -- ANCHORED. Staff are @playmatchday.com and must not be swept up; '%@matchday.com' as a
      -- LIKE pattern is anchored at the end by the absence of a trailing wildcard.
      and (u.email is null or u.email not ilike '%@matchday.com')
  )
  select r.id::bigint
  from public.player_finder_mv r
  where (p_search   is null or r.search_blob like '%' || lower(p_search) || '%')
    and (p_reg_from is null or r.created_at >= p_reg_from)
    and (p_reg_to   is null or r.created_at <= p_reg_to)
    and (p_city_unset or p_city is null or r.preferable_city_name = p_city)
    and (not p_city_unset or r.preferable_city_name is null)
    /* ── THE BOUNDARY. A UNION, AND IT IS APPLIED ON TOP OF EVERY FILTER ABOVE ──────────────────
     * home city IS the scope city, OR this player has played in it. Null p_scope_city means an
     * unconfined caller and the whole term disappears. */
    and (p_scope_city is null
         or r.preferable_city_name = p_scope_city
         or r.id in (select user_id from in_scope))
    and (p_member = 'any'
         or (p_member = 'yes' and r.is_member is true)
         or (p_member = 'no'  and r.is_member is not true))
    and (p_history = 'any'
         or (p_history = 'never' and r.plays = 0)
         or (p_history = 'once'  and r.plays = 1)
         or (p_history = 'multi' and r.plays >= 2))
    and (p_history = 'never' or p_play_mode = 'any'
         or (p_play_mode = 'lapsed'
             and r.plays >= 1
             and r.last_played < now() - interval '60 days')
         or (p_play_mode = 'window' and r.id in (select user_id from win)))
    and (not (p_match_city is not null or p_field_id is not null or p_kick_from is not null
              or p_kick_to is not null or p_match_from is not null or p_match_to is not null)
         or r.id in (select user_id from matched));
$$;
grant execute on function public.player_finder_ids(
  text, timestamptz, timestamptz, text, text, date, date, text, text,
  boolean, text, bigint, time, time, date, date, text) to authenticated, service_role;

-- ── 3. THE PAGE ───────────────────────────────────────────────────────────────────────────────
drop function if exists public.player_finder_page(
  text, timestamptz, timestamptz, text, text, date, date, text, text, int, int,
  boolean, text, bigint, time, time, date, date);

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
  p_match_to    date        default null,
  p_scope_city  text        default null
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
                                p_match_from, p_match_to, p_scope_city) m
    on m.id = r.id
  order by r.created_at desc, r.id
  limit greatest(1, least(p_limit, 50000))
  offset greatest(0, p_offset);
$$;
grant execute on function public.player_finder_page(
  text, timestamptz, timestamptz, text, text, date, date, text, text, int, int,
  boolean, text, bigint, time, time, date, date, text) to authenticated, service_role;

-- ── 4. THE STATS ──────────────────────────────────────────────────────────────────────────────
drop function if exists public.player_finder_stats(
  text, timestamptz, timestamptz, text, text, date, date, text, text,
  boolean, text, bigint, time, time, date, date);

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
  p_match_to    date        default null,
  p_scope_city  text        default null
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
                                              p_kick_to, p_match_from, p_match_to, p_scope_city) m
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
    /* The count the page prints beside HOME CITY so "= Austin" cannot silently drop people.
     * Counted over the WHOLE estate, not the current selection: it answers "how many are
     * unreachable by this control", which does not change with the other filters.
     *
     * DELIBERATELY NOT NARROWED BY p_scope_city. It is a property of the control, not of the
     * result set, and scoping it would make the same label mean two different things depending on
     * who is logged in. The number is DERIVED here rather than written down anywhere: the three
     * figures previously hardcoded in comments across this codebase (4,187 / 4,010 / 4,219) were
     * three stale snapshots of it. */
    (select count(*) from public.player_finder_mv where preferable_city_name is null)::bigint;
$$;
grant execute on function public.player_finder_stats(
  text, timestamptz, timestamptz, text, text, date, date, text, text,
  boolean, text, bigint, time, time, date, date, text) to authenticated, service_role;

commit;

-- ══ THE PLAN, BEFORE AND AFTER ════════════════════════════════════════════════════════════════
-- Run this before and after applying, and paste both into the review:
--
--   explain (analyze, buffers)
--   select count(*) from public.player_finder_ids(p_scope_city => 'Warsaw');
--
-- BEFORE the index, the in_scope CTE reads player_match_mv through
-- player_match_mv_city_idx (city_name, start_utc) and must visit the heap for every matching row
-- to get user_id. AFTER, player_match_mv_city_user_idx (city_name, user_id) carries both columns
-- and the scan is index-only.
