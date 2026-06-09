-- Partial index for the firstmatch-ledger player scan.
--
-- firstmatchLedgerSync.selectAllFirstMatchPlayers pages through
--   SELECT ... FROM mdapi_match_players
--   WHERE is_first_match = true AND deleted_at IS NULL
--   ORDER BY api_id ASC
--   LIMIT/OFFSET ...
-- With no supporting index this is a full scan of mdapi_match_players
-- (52k+ rows): measured ~3.2s for a single 1,000-row page, and it threw
-- "canceling statement due to statement timeout" during the cron run on
-- 2026-06-08. Under any concurrent load that scan pegs the single
-- free-tier core, which is one of the contributors to the app flapping
-- into "Loading...".
--
-- The partial predicate matches the WHERE clause exactly, so the index
-- only contains the qualifying first-match alive rows (a small slice of
-- the table), and the api_id key order serves the ORDER BY + pagination
-- directly. Read-only optimization — no data is changed.
--
-- The 0059/0060 partial indexes cover match_api_id lookups
-- (fetchJoinedMatchPlayers); this is a different access path and needs
-- its own index.
--
-- Apply via Supabase Dashboard -> SQL Editor -> paste & run.

CREATE INDEX IF NOT EXISTS mdapi_match_players_firstmatch_idx
  ON mdapi_match_players(api_id)
  WHERE is_first_match = true AND deleted_at IS NULL;
