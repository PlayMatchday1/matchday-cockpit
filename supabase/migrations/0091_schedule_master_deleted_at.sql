-- 0091: schedule_master soft-delete column.
--
-- The Master Schedule reconciliation view lets an admin remove a Clubhouse-only
-- slot (a schedule_master row that never became a MatchDay match). We prefer a
-- soft delete so a mistaken removal is recoverable and the audit trail stays
-- intact. This adds the nullable column; the app then sets deleted_at instead of
-- hard-deleting, and every schedule_master read filters deleted_at IS NULL.
--
-- Forward-compatible: until this is applied, /api/schedule-master/remove falls
-- back to a hard delete and the read route skips the (nonexistent) filter. After
-- it's applied, removals become soft automatically — no code change needed.
--
-- Apply in the Supabase SQL Editor. Not applied by the app. No data is deleted.

alter table schedule_master add column if not exists deleted_at timestamptz;

-- Partial index: reads always ask for the live rows (deleted_at IS NULL).
create index if not exists schedule_master_live_idx
  on schedule_master (city, match_date)
  where deleted_at is null;
