-- 0148 — the finder's refresh has NEVER run. One missing WHERE clause.
--
-- ══ WHAT IS ACTUALLY WRONG ════════════════════════════════════════════════════════════════════
--
--     select refresh_player_finder_views();
--     ERROR:  UPDATE requires a WHERE clause
--
-- This project runs **pg_safeupdate**, which rejects an unqualified UPDATE. 0147's function ends
-- with `update public.player_finder_refresh set refreshed_at = now();` — no WHERE — so it throws
-- EVERY TIME.
--
-- AND BECAUSE IT IS ONE PLPGSQL FUNCTION IN ONE TRANSACTION, THE THROW ROLLS BACK THE REFRESHES
-- THAT ALREADY SUCCEEDED. The two matviews rebuild, the UPDATE fails, and Postgres undoes the lot.
-- The set has not been rebuilt once since 0147 was applied at 17:29 — measured 2026-08-25, with
-- matches synced at 18:44 and player_finder_refresh still stamped 17:29.
--
-- IT FAILED SILENTLY BECAUSE THE CALLER SWALLOWS IT. refreshPlayerFinderViews() logs a warning and
-- returns, deliberately, so a refresh failure never fails the sync. That is the right posture and
-- it is exactly why this went unnoticed for an hour: the only visible symptom was the staleness
-- banner, which is the thing that DID work and the reason this was caught at all.
--
-- CLAUDE.md ALREADY CARRIES THIS RULE — "revoke SQL with a WHERE clause — pg_safeupdate rejects an
-- unqualified UPDATE" — and docs/matchday-api-facts.md carries it a second time. 0147 broke a rule
-- written down twice in this repo.
--
-- ══ THE FIX ═══════════════════════════════════════════════════════════════════════════════════
--
-- `where only_row` — the table's primary key is a one-row boolean check constraint, so this
-- qualifies the UPDATE without changing which rows it touches. Do NOT "simplify" it away.
--
-- Apply in the Supabase SQL editor. The function rebuilds 182,000 rows; expect ~4 seconds.

create or replace function public.refresh_player_finder_views() returns void language plpgsql as $$
begin
  refresh materialized view public.player_finder_mv;
  refresh materialized view public.player_match_mv;
  -- THE WHERE IS REQUIRED. pg_safeupdate rejects an unqualified UPDATE, and because this function
  -- is one transaction, the rejection rolls back BOTH refreshes above. `only_row` is the primary
  -- key and is always true, so this changes nothing about which row is written.
  update public.player_finder_refresh set refreshed_at = now() where only_row;
end $$;
revoke execute on function public.refresh_player_finder_views() from anon, authenticated, public;
grant  execute on function public.refresh_player_finder_views() to service_role;

-- Run it once now, so the set is current the moment this lands rather than at the next sync.
select public.refresh_player_finder_views();

-- VERDICT — ONE query, ONE row.
--   Expected:  stale FALSE | rebuilt_within_a_minute TRUE
--
-- `stale` is the whole point: it was TRUE before this migration and must be FALSE after. If it is
-- still true the UPDATE did not take and the refresh is still rolling itself back.
select
  (select stale from public.player_finder_freshness())                          as stale,
  (select refreshed_at > now() - interval '1 minute'
     from public.player_finder_refresh)                                         as rebuilt_within_a_minute,
  (select refreshed_at from public.player_finder_refresh)                       as refreshed_at,
  (select source_synced_at from public.player_finder_freshness())               as source_synced_at;

-- ROLLBACK: re-run 0147's version of this function. There is no reason to — that version cannot
-- complete — but it is one create-or-replace either way.
