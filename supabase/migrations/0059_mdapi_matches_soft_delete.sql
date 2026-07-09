-- Soft-delete tombstones for mdapi_matches + a sync-log counter.
--
-- The mdapi-matches sync is upsert-only: it never removed rows for
-- matches deleted upstream in MatchDay, so deleted matches lived on as
-- "phantom" rows. Existence-based reads (field costs especially) billed
-- them. This adds a nullable deleted_at tombstone. The sync sets it when
-- a row inside the covered window goes unseen for >=2 consecutive runs
-- (cooldown via synced_at); existence-based readers filter
-- deleted_at IS NULL. History is preserved (no hard delete).
--
-- rows_soft_deleted records how many rows a sync run tombstoned, for
-- visibility in the Schedule Sync surface / fin_sync_log.
--
-- Apply via Supabase Dashboard -> SQL Editor -> paste & run.

ALTER TABLE mdapi_matches
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- Partial index keeps the common "alive rows in a date window" query
-- fast once readers add `WHERE deleted_at IS NULL`.
CREATE INDEX IF NOT EXISTS mdapi_matches_alive_start_date_idx
  ON mdapi_matches(start_date)
  WHERE deleted_at IS NULL;

ALTER TABLE fin_sync_log
  ADD COLUMN IF NOT EXISTS rows_soft_deleted integer;
