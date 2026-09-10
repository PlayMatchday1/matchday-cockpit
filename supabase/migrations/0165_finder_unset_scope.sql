-- 0165 — THE homeCity=unset CONFINEMENT LEAK.
--
-- The Warsaw operator reported missing players. That turned out to be sync latency (mdapi-users
-- refreshed once a day; the reported player registered 34 minutes after the run). While measuring
-- it, this came out of the same predicate and is a boundary failure, not a visibility one:
--
--   a Warsaw-confined call with homeCity=unset returned 4,144 rows,
--   identical to the estate-wide no_home_city figure.
--
-- FOURTH INSTANCE OF THIS SHAPE. After /api/veo/range, /api/firebase-token and /api/match-managers,
-- all this same week: the boundary is applied at one layer and a predicate downstream of it quietly
-- stops honouring it. The allowlist governs which ROUTES a confined account may call; it says
-- nothing about whether the SQL behind an allowed route still respects the scope it was handed.
--
-- ONE PREDICATE CHANGES. The function is reproduced verbatim from 0147 so the diff is exactly the
-- two lines it replaces — same 16-arg signature, so CREATE OR REPLACE with no drop and no overload
-- ambiguity (0146's "function is not unique"), and the DEFAULTS stay intact so 0136's omission
-- trick still constant-folds. No new argument is introduced.
--
-- READ-SIDE ONLY. Nothing here touches mdapi_users or any write path.

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
    /* ── THE HOME-CITY FILTER, COMPOSED — CORRECTED 2026-09-10 ────────────────────────────────
     * It used to be two independent lines:
     *     and (p_city_unset or p_city is null or r.preferable_city_name = p_city)
     *     and (not p_city_unset or r.preferable_city_name is null)
     * With p_city_unset true the first line short-circuits and p_city STOPS BEING APPLIED AT ALL,
     * so a confined caller asking for players with no home city received every such player in the
     * estate. MEASURED: a Warsaw-confined call with homeCity=unset returned 4,144 rows — identical
     * to the estate-wide no_home_city figure player_finder_stats computes. Austin's abandoned
     * signups, Houston's, all of them, to an account bounded to one city.
     *
     * assertScope did not catch it because "unset" is not a city name, and this is the one branch
     * where the scope argument stopped being read.
     *
     * THE CASE COMPOSES THEM INSTEAD. p_city_unset now NARROWS WITHIN scope rather than replacing
     * it. For a scoped caller the intersection is empty and that is the truthful answer: nothing on
     * a null-home-city account attributes it to a market. mdapi_users.raw carries no country,
     * locale, timezone or region — measured the same day — and 4,294 of those 4,344 players have no
     * phone number either, so there is no signal to scope them by. An empty result is honest; the
     * 4,144 was not.
     *
     * p_city_unset IS NOT REMOVED. It is the only way an unconfined operator reaches that cohort,
     * and an equality filter drops them silently, which is the same class of bug one line up. */
    and (case
           when p_city_unset and p_city is not null then false
           when p_city_unset                       then r.preferable_city_name is null
           when p_city is null                     then true
           else r.preferable_city_name = p_city
         end)
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
