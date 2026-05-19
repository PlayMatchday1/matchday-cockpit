-- ============================================================
-- fin_schedule — add fin_venue_id column
-- ============================================================
-- PR-F of the venue field_id migration. Adds a nullable
-- fin_venue_id column on fin_schedule with a foreign key to
-- fin_venues(id). After this lands and the backfill runs
-- (scripts/backfill-fin-schedule-fin-venue-id.sql), every
-- operator-curated billing-schedule row will carry the same
-- canonical fin_venues.id that the Finance read paths in
-- financeStats.ts already key on (post-PR-E).
--
-- Nullable during the transition: the backfill resolves
-- (city, venue) → fin_venues.id where unambiguous; rows that
-- can't resolve (drifted venue strings) stay NULL until ops
-- updates them via the billing-schedule UI introduced in this
-- PR. PR-G will drop the legacy raw-name string match in
-- financeCosts.ts:venueMatchCount / venueTotalHours once the
-- column is fully populated.
--
-- FK constraint is ON DELETE SET NULL — if a fin_venues row
-- gets deleted (rare, mostly archive operations), the
-- corresponding fin_schedule rows keep their venue string but
-- lose the id link. Soft failure mode is better than a hard
-- delete cascade on the planning table.
-- ============================================================

ALTER TABLE fin_schedule
  ADD COLUMN IF NOT EXISTS fin_venue_id integer
    REFERENCES fin_venues(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS fin_schedule_fin_venue_id_idx
  ON fin_schedule(fin_venue_id);
