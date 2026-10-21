-- 0230 — INCREMENTAL MATCHDAY SYNCS, AND A REQUEST COUNT ON EVERY RUN (Ryan, 2026-10-21).
--
-- Apply via Supabase Dashboard → SQL Editor. One transaction. Additive only: two nullable columns on
-- fin_sync_log, two on player_area_sync_runs (one with a default). No existing row changes meaning.
--
-- WHY. Production went down on 2026-10-21 at 2:05 PM Central (Heroku R15). Clubhouse made ~2,650
-- player-list requests a day, ~2,400 of them the 3-a-day full location walk. The new setup:
--   - player locations: hourly, GET /admin/players?locationUpdatedSince=… (an INCREMENTAL run)
--   - one full walk a day at ~3 AM Central (a FULL run), which also refreshes mdapi_users
--   - matches: hourly for recent or changed matches only; the full refresh at 3 AM
--   - reviews: carried by the hourly matches run; the full walk at 3 AM
--
-- player_area_sync_runs.kind   'full' (every page; may clear) | 'incremental' (changed since `since`)
-- player_area_sync_runs.since  the locationUpdatedSince an incremental run asked for
-- fin_sync_log.api_calls       MatchDay requests the run made (the before/after figure)
-- fin_sync_log.run_mode        free text: 'incremental', 'full', 'full-1'..'full-4', 'from-rosters'.
--                              The match tombstone guards compare a run only with prior runs of the
--                              SAME mode, so an hourly run never trips the 3 AM run's row-count guard.
--
-- No fin_sync_log source changes: every new run logs under an existing source.

BEGIN;

ALTER TABLE public.player_area_sync_runs
  ADD COLUMN kind  text NOT NULL DEFAULT 'full' CHECK (kind IN ('full', 'incremental')),
  ADD COLUMN since timestamptz;

ALTER TABLE public.fin_sync_log
  ADD COLUMN api_calls integer,
  ADD COLUMN run_mode  text;     -- not "mode": mode() is a Postgres aggregate function

COMMIT;

-- Check (expect 4 rows):
-- SELECT table_name, column_name FROM information_schema.columns
--  WHERE table_schema = 'public'
--    AND ((table_name = 'player_area_sync_runs' AND column_name IN ('kind', 'since'))
--      OR (table_name = 'fin_sync_log' AND column_name IN ('api_calls', 'run_mode')));
--
-- Revert (only before the code that writes these columns is deployed):
-- ALTER TABLE public.player_area_sync_runs DROP COLUMN kind, DROP COLUMN since;
-- ALTER TABLE public.fin_sync_log DROP COLUMN api_calls, DROP COLUMN run_mode;
