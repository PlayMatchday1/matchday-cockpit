-- ============================================================
-- schedule_master — add mdapi_field_id column
-- ============================================================
-- PR-D of the venue field_id migration. Adds a nullable
-- mdapi_field_id column on schedule_master so each recurring
-- template row can carry the same canonical field identity that
-- mdapi_matches.field_id and fin_venue_fields use.
--
-- Nullable during the transition: the backfill script
-- (scripts/backfill-schedule-master-field-id.mjs) populates it
-- for all rows where (city, venue) resolves unambiguously via
-- fin_venue_fields. Rows that can't be resolved stay NULL until
-- ops links them through the admin UI introduced in this PR.
--
-- No foreign key constraint: schedule_master is a forward-looking
-- planning template that may reference field_ids that haven't yet
-- appeared in mdapi_matches (new venues, future tournaments).
-- The integrity story rides on fin_venue_fields.mdapi_field_id
-- being UNIQUE — the only path a value lands in this column is
-- through that table.
--
-- PR-E (Finance read paths) is the first consumer of this
-- column. No reads happen in PR-D — schema add, backfill, and
-- write-side UI only.
-- ============================================================

ALTER TABLE schedule_master
  ADD COLUMN IF NOT EXISTS mdapi_field_id bigint;

CREATE INDEX IF NOT EXISTS schedule_master_mdapi_field_id_idx
  ON schedule_master(mdapi_field_id);
