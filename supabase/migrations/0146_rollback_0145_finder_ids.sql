-- 0146 — ROLL 0145 BACK. Restores 0136's player_finder_ids, byte for byte.
--
-- ══ WHY, IN NUMBERS ═══════════════════════════════════════════════════════════════════════════
--
-- 0145 was CORRECT and SLOWER. Its verdict query returned all six expected values; every node
-- guard was green; tsc was clean. Measured on production against the same shape (`hist=multi`),
-- same method and same request count as the pre-0145 baseline:
--
--                    BEFORE 0145            AFTER 0145 (three runs)
--     conc 1  p50    1,382ms                1,560 – 1,673ms
--     conc 4  p50    3,583ms                4,060 – 4,370ms
--     conc 6  p50    5,271ms                6,183 / 6,406 / 6,261ms
--     conc 6  max    6,816ms                6,549 / 8,768 / 8,131ms
--
-- **Two of three runs put max past the 8,000ms statement timeout.** Nothing had failed yet, but
-- the margin was gone, and the failure mode is a blank page rather than a slow one.
--
-- ══ WHAT 0145 GOT WRONG — AND IT IS THE BUG ITS OWN HEADER WARNED ABOUT ═══════════════════════
--
-- 0145 merged 0136's `win` CTE and the new match filters into one grouped pass, guarded by
-- `(select match_on from cfg)` — A SCALAR SUBQUERY, referenced three times: once in the WHERE and
-- twice inside `bool_or`. 0136's whole finding is that THE PLANNER CANNOT FOLD A PARAMETER, so
-- that guard does not short-circuit; it relocates the per-row cost from an EXISTS into a subquery.
-- 0145 also added `group by s.user_id` over player_spots where 0136 had a plain filtered scan.
--
-- "One pass instead of two" traded two cheap guarded scans for one expensive grouped scan with a
-- per-row subquery. The lesson survives 0145's deletion: the shape below is the one that measured
-- fast, and the next attempt adds a SECOND CTE OF THIS SHAPE rather than merging anything.
--
-- ══ WHY THE FILE IS THE RIGHT SOURCE HERE, AND WHY THAT IS NOT A SHORTCUT ═════════════════════
--
-- THE 0141 RULE IS ABOUT REPLACING A BODY YOU HAVE NOT READ. That was honoured: the live catalogue
-- was queried first (`pg_proc.prosrc`) and it confirmed exactly one player_finder_ids, 16 args,
-- carrying `bool_or`, `group by s.user_id` and `from cfg` — 0145's body, as written. So the live
-- state is known.
--
-- 0136's body then exists NOWHERE in the database: 0145 replaced it. The migration file is the
-- only surviving copy, which makes it the correct source — this is the opposite of the 0141 case,
-- not an exception to it. **Do not read this as licence to restore from a file without looking
-- first.** Look first; if what you are restoring is still live, diff it; if it is gone, the file
-- is all there is and you say so, as this does.
--
-- ══ DROP THEN CREATE. NOT CREATE OR REPLACE. ═════════════════════════════════════════════════
--
-- Restoring a 9-arg signature next to a live 16-arg one CREATES A SECOND FUNCTION rather than
-- replacing it, and a 9-argument call then matches both — the 16-arg one through its defaults.
-- Postgres raises `function player_finder_ids(...) is not unique` and every finder request 500s.
-- The DROP below is not tidiness; it is the difference between a rollback and an outage.
--
-- ══ WHAT THIS DOES NOT TOUCH ═════════════════════════════════════════════════════════════════
--
-- player_finder_stats and player_finder_page are UNCHANGED. 0145 never altered them (they still
-- carry 9 and 11 args and do not know the new parameters), and stats' own `group by` predates
-- 0145 and is not implicated in anything measured here.
--
-- player_spots KEEPS field_id and field_title. They are inert — Postgres does not materialise a
-- view column nobody selects, and nothing selects them yet — and the corrective migration needs
-- them. Rolling them out to roll them straight back in would be churn on a hot path.
--
-- Apply in the Supabase SQL editor.

begin;

-- THE 16-ARG VERSION GOES FIRST. See above: leaving it in place makes the 9-arg call ambiguous.
drop function if exists public.player_finder_ids(
  text, timestamptz, timestamptz, text, text, date, date, text, text,
  boolean, text, bigint, time, time, date, date);

-- 0136's body, verbatim.
create function public.player_finder_ids(
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
  with win as (
    -- ONE PASS, distinct users. The guard is inside the CTE so a non-window request scans and
    -- discards rather than paying a per-row subplan.
    select distinct s.user_id
    from public.player_spots s
    where p_play_mode = 'window'
      and s.start_date_utc < now()                     -- a booking is not a play (0134)
      and (p_play_from is null or s.start_local >= p_play_from::timestamp)
      and (p_play_to   is null or s.start_local <  (p_play_to + 1)::timestamp)
  )
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
     * than intersected to nothing. The UI disables the row and says why; the route drops the window
     * before it is sent; this is the third place, and it is the one that decides. */
    and (p_history = 'never' or p_play_mode = 'any'
         or (p_play_mode = 'lapsed'
             and r.plays >= 1
             and r.last_played < now() - interval '60 days')
         or (p_play_mode = 'window' and r.id in (select user_id from win)));
$$;

grant execute on function public.player_finder_ids(text, timestamptz, timestamptz, text, text, date, date, text, text)
  to authenticated, service_role;

commit;

-- VERDICT — ONE query, ONE row. The SQL editor shows only the last result set.
--   Expected:  overloads 1 | args "p_search text, ..., p_member text" (9) | bool_or f | cfg f | group_by f | ids 30455
--
-- THREE COLUMNS CARRY THE INTENT:
--   overloads  must be 1. Two means the DROP did not take and every 9-arg call is now ambiguous —
--              that is an outage, not a slow page. Stop and drop the 16-arg one by hand.
--   bool_or / cfg / group_by  must all be FALSE. Those three strings are 0145's body; any of them
--              still true means the old body is what is live.
--   ids        must be 30455 — the same unfiltered count 0145's own verdict returned, so the
--              rollback restored behaviour and not merely a signature.
select
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'player_finder_ids')                     as overloads,
  (select pg_get_function_identity_arguments(p.oid) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'player_finder_ids' limit 1)             as args,
  (select bool_or(p.prosrc like '%bool_or%') from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'player_finder_ids')                     as has_bool_or,
  (select bool_or(p.prosrc like '%from cfg%') from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'player_finder_ids')                     as has_scalar_subquery,
  (select bool_or(p.prosrc like '%group by s.user_id%') from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'player_finder_ids')                     as has_group_by,
  (select count(*) from public.player_finder_ids())                                      as ids;

-- ROLLBACK OF THIS ROLLBACK: re-apply 0145. Not recommended — it is the version this exists to
-- remove — and it would need the same drop-then-create treatment in reverse.
