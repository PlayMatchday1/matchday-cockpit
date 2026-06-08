-- Soft-delete tombstones for mdapi_match_players.
--
-- The mdapi player sync is upsert-only (onConflict: api_id): it never
-- removed rows for registrations dropped upstream, so they lived on as
-- "phantom" player rows. Measured: 2,642 phantoms across 304 matches,
-- all synthetic @matchday.com fills (real registrations get is_cancelled
-- upstream, not hard-deleted, so no financial number was inflated). This
-- adds a nullable deleted_at tombstone so the row-level player count is
-- honest and the ghosts stop accumulating.
--
-- Same shape as 0059 (mdapi_matches): the sync sets deleted_at when a row
-- inside a covered window goes unseen for >=2 consecutive runs (cooldown
-- via synced_at); readers filter deleted_at IS NULL. History preserved.
--
-- rows_soft_deleted already exists on fin_sync_log (added in 0059); the
-- player tombstone pass reuses it. ADD ... IF NOT EXISTS kept for safety.
--
-- Apply via Supabase Dashboard -> SQL Editor -> paste & run.

ALTER TABLE mdapi_match_players
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- Partial index keeps the common "alive players for a match" query fast
-- once readers add `WHERE deleted_at IS NULL`. match_api_id is the join
-- key fetchJoinedMatchPlayers filters on.
CREATE INDEX IF NOT EXISTS mdapi_match_players_alive_match_idx
  ON mdapi_match_players(match_api_id)
  WHERE deleted_at IS NULL;

ALTER TABLE fin_sync_log
  ADD COLUMN IF NOT EXISTS rows_soft_deleted integer;
