-- Relax fin_sync_log.source CHECK to allow membership-snapshots.
-- The cron orchestrator now runs a 4th step after the three syncs:
-- refreshMembershipSnapshots, which writes a fin_sync_log row with
-- source='membership-snapshots'. Same drop/recreate pattern as 0013.
--
-- Apply via Supabase Dashboard → SQL Editor → paste & run.

ALTER TABLE fin_sync_log
  DROP CONSTRAINT IF EXISTS fin_sync_log_source_check;

ALTER TABLE fin_sync_log
  ADD CONSTRAINT fin_sync_log_source_check
  CHECK (source IN (
    'stripe-api',
    'mdapi-reviews',
    'mdapi-subscriptions',
    'membership-snapshots'
  ));
