-- PLAYER FINDER: the play window becomes ONE PASS, not a correlated subquery per row.
--
-- THE BUG, AND IT IS A TRAP WORTH KNOWING. 0135 wrote the play window as a guarded EXISTS:
--
--     and (p_play_mode = 'window' and exists (
--            select 1 from player_spots s where s.user_id = r.id and ...))
--
-- Called with the arguments OMITTED, that runs in 424ms: PostgREST leaves the defaults in place,
-- the planner constant-folds `p_play_mode = 'any'`, sees the EXISTS branch is unreachable and
-- removes it. Called with the same values passed EXPLICITLY — which is what the route does, and
-- what any caller building an argument object does — they arrive as parameters, the planner can no
-- longer fold them, and it must plan the EXISTS for the general case: a subplan evaluated per row
-- over 30,245 users. 424ms becomes an 8-second statement timeout.
--
-- The function was identical in both cases. Only the shape of the CALL changed, which is why it
-- passed every direct test and failed on the page.
--
-- THE FIX is to compute the window membership ONCE, as a set, and test against it — a hash semi-
-- join whose cost does not depend on whether the planner could fold a parameter. When the mode is
-- not 'window' the CTE's own guard makes it return nothing, so the branch costs one scan and not
-- one scan per row.
--
-- RULE FOR THIS FILE: no correlated subquery may sit behind a parameter guard. If a branch is only
-- reachable for some parameter value, it still gets planned for all of them.

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
